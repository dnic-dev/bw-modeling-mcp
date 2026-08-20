import { BwClient } from '../bw-client.js';

// The remodeling monitor is a Fiori app on top of an OData V2 service; there is no
// /sap/bw/modeling equivalent, so these tools talk to the OData service directly.
const ODATA = '/sap/opu/odata/sap/RV_C_RSCNVMONITOR_CDS';
// The Fiori app reads the log through APL_LOG_MANAGEMENT_SRV, but a second OData
// service in the same stateful ADT session answers HTTP 500, so the log is read
// through the BW modeling endpoint instead — same service family as every other call.
const LOG_BASE = '/sap/bw/modeling/repo/is/applicationlog';
const LOG_OBJECT = 'RSCNV';

/** Upper bound on per-step log reads, so a restarted request cannot fan out unboundedly. */
const MAX_LOG_HANDLES = 12;

const JSON_HEADERS = { Accept: 'application/json' };
const XML_HEADERS = { Accept: 'application/xml' };

const REQUEST_STATUS: Record<string, string> = {
  N: 'Not scheduled',
  S: 'Scheduled',
  R: 'Running',
  C: 'Completed',
  E: 'Error',
};

const ALL_STATUS = Object.keys(REQUEST_STATUS).join(',');

/** Empty-date sentinel the backend uses for unset job dates. */
const EMPTY_DATE = "datetime'9999-03-23T23:00:00'";

export type RemodelingAction = 'execute' | 'restart' | 'reset' | 'reset_step';

const ACTION_FUNCTION: Record<RemodelingAction, string> = {
  execute: 'Rv_C_RscnvMonitorExecute',
  restart: 'Rv_C_RscnvMonitorRestart',
  reset: 'Rv_C_RscnvMonitorReset',
  reset_step: 'Rv_C_RscnvMonitorResetstep',
};

interface MonitorEntry {
  requestNumber?: string;
  requestName?: string;
  remodelingRule?: string;
  infoProvider?: string;
  tlogo?: string;
  infoArea?: string;
  status?: string;
  statusText?: string;
  statusCriticality?: number;
  createdBy?: string;
  lastChangedBy?: string;
  last_run_timestamp?: string;
  endTimestamp?: string;
  to_status?: { status_Text?: string };
  to_createdBy?: { fullName?: string };
}

interface MonitorStep {
  stepNumber?: string;
  stepName?: string;
  status?: string;
  stepStatusText?: string;
  treeLevel?: string;
}

interface LogMessage {
  step: string;
  type: string;
  text: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** `/Date(1234567890000+0000)/` → ISO 8601. */
function edmDate(value?: string | null): string {
  if (!value) return '';
  const m = /\/Date\((-?\d+)([+-]\d+)?\)\//.exec(value);
  if (!m) return value;
  const d = new Date(Number(m[1]));
  return Number.isNaN(d.getTime()) ? value : d.toISOString().replace(/\.000Z$/, 'Z');
}

function statusLabel(entry: MonitorEntry): string {
  const code = entry.status ?? '';
  const text = entry.to_status?.status_Text ?? entry.statusText ?? REQUEST_STATUS[code] ?? '';
  return text ? `${text} (${code})` : code;
}

/**
 * The entity has a four-part key and `requestName` carries a colon, which has to
 * stay percent-encoded inside the OData key literal.
 */
function entityKey(entry: {
  requestNumber: string;
  requestName: string;
  remodelingRule: string;
  infoProvider: string;
}): string {
  const lit = (v: string) => `'${encodeURIComponent(v)}'`;
  return (
    `Rv_C_RscnvMonitor(requestNumber=${lit(entry.requestNumber)},` +
    `requestName=${lit(entry.requestName)},` +
    `remodelingRule=${lit(entry.remodelingRule)},` +
    `infoProvider=${lit(entry.infoProvider)})`
  );
}

function parseCollection<T>(body: string): T[] {
  const parsed = JSON.parse(body) as { d?: { results?: T[] } };
  return parsed.d?.results ?? [];
}

function parseEntity<T>(body: string): T {
  const parsed = JSON.parse(body) as { d?: T };
  if (!parsed.d) throw new Error('unexpected OData response: no "d" payload');
  return parsed.d;
}

async function fetchRequests(
  client: BwClient,
  infoProvider: string | undefined,
  status: string,
  top: number,
  remodelingRule?: string,
): Promise<MonitorEntry[]> {
  const conditions: string[] = [];
  if (infoProvider) conditions.push(`infoProvider eq '${infoProvider.toUpperCase()}'`);
  if (remodelingRule) conditions.push(`remodelingRule eq '${remodelingRule}'`);

  const codes = status
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (codes.length) {
    conditions.push(`(${codes.map((c) => `status eq '${c}'`).join(' or ')})`);
  }

  const query =
    `${ODATA}/Rv_C_RscnvMonitor` +
    `?$top=${top}` +
    `&$orderby=${encodeURIComponent('last_run_timestamp desc')}` +
    (conditions.length ? `&$filter=${encodeURIComponent(conditions.join(' and '))}` : '') +
    `&$expand=${encodeURIComponent('to_status,to_createdBy')}`;

  const { body } = await client.rawGet(query, JSON_HEADERS);
  return parseCollection<MonitorEntry>(body);
}

/**
 * The request number is a GUID the caller cannot know, so a request is addressed by
 * InfoProvider plus remodeling rule and resolved against the monitor list.
 */
async function resolveRequest(
  client: BwClient,
  infoProvider: string,
  remodelingRule: string,
  requestNumber?: string,
): Promise<MonitorEntry> {
  if (requestNumber) {
    const key = entityKey({
      requestNumber,
      requestName: `${infoProvider.toUpperCase()}:${remodelingRule}`,
      remodelingRule,
      infoProvider: infoProvider.toUpperCase(),
    });
    const { body } = await client.rawGet(`${ODATA}/${key}`, JSON_HEADERS);
    return parseEntity<MonitorEntry>(body);
  }

  const matches = await fetchRequests(client, infoProvider, ALL_STATUS, 20, remodelingRule);
  if (matches.length === 0) {
    throw new Error(
      `no remodeling request found for InfoProvider ${infoProvider.toUpperCase()} ` +
        `and rule ${remodelingRule} — check both names via bw_list_remodeling_requests`,
    );
  }
  return matches[0];
}

function requireKey(entry: MonitorEntry): {
  requestNumber: string;
  requestName: string;
  remodelingRule: string;
  infoProvider: string;
} {
  const { requestNumber, requestName, remodelingRule, infoProvider } = entry;
  if (!requestNumber || !requestName || !remodelingRule || !infoProvider) {
    throw new Error('remodeling request is missing key fields in the backend response');
  }
  return { requestNumber, requestName, remodelingRule, infoProvider };
}

// ── Read ────────────────────────────────────────────────────────────────────

export async function bwListRemodelingRequests(
  client: BwClient,
  infoProvider?: string,
  status: string = ALL_STATUS,
  top: number = 20,
): Promise<string> {
  const entries = await fetchRequests(client, infoProvider, status, top);

  const lines: string[] = [];
  const scope = infoProvider ? ` of ${infoProvider.toUpperCase()}` : '';
  lines.push(`Remodeling requests${scope} — ${entries.length} shown`);
  lines.push('');

  if (entries.length === 0) {
    lines.push('(no remodeling requests matched — widen status or drop the InfoProvider filter)');
    return lines.join('\n');
  }

  for (const entry of entries) {
    lines.push(`Rule: ${entry.remodelingRule ?? ''}`);
    lines.push(`  InfoProvider: ${entry.infoProvider ?? ''}`);
    lines.push(`  Status:       ${statusLabel(entry)}`);
    lines.push(`  Last Run:     ${edmDate(entry.last_run_timestamp)}`);
    lines.push(`  Created By:   ${entry.to_createdBy?.fullName ?? entry.createdBy ?? ''}`);
    lines.push(`  Request:      ${entry.requestNumber ?? ''}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function isoSecond(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Log headers carry `extNumber` as `<requestNumber>:<stepNumber>:<stepName>`, which is
 * the only link back to the request — the endpoint itself filters by time and log object
 * only, so the request is matched client-side.
 */
async function fetchLogMessages(
  client: BwClient,
  requestNumber: string,
  lastRun: string,
): Promise<{ messages: LogMessage[]; truncated: number }> {
  const runStart = new Date(edmDate(lastRun));
  if (Number.isNaN(runStart.getTime())) return { messages: [], truncated: 0 };

  const from = isoSecond(new Date(runStart.getTime() - 5 * 60 * 1000));
  const to = isoSecond(new Date(Date.now() + 60 * 60 * 1000));
  const headerUrl =
    `${LOG_BASE}?username=*&object=${LOG_OBJECT}` +
    `&starttimestamp=${encodeURIComponent(from)}` +
    `&endtimestamp=${encodeURIComponent(to)}`;

  const { body } = await client.rawGet(headerUrl, XML_HEADERS);

  const handles: { step: string; url: string }[] = [];
  const entryRe = /<atom:entry>([\s\S]*?)<\/atom:entry>/g;
  let entry: RegExpExecArray | null;
  while ((entry = entryRe.exec(body)) !== null) {
    const extNumber = decodeXml(/extNumber="([^"]*)"/.exec(entry[1])?.[1] ?? '');
    if (!extNumber.startsWith(`${requestNumber}:`)) continue;
    const id = decodeXml(/<atom:id>([^<]*)<\/atom:id>/.exec(entry[1])?.[1] ?? '').trim();
    if (!id) continue;
    handles.push({ step: extNumber.slice(requestNumber.length + 1).replace(':', ' '), url: id });
  }

  const truncated = Math.max(0, handles.length - MAX_LOG_HANDLES);
  const messages: LogMessage[] = [];
  for (const handle of handles.slice(0, MAX_LOG_HANDLES)) {
    const { body: detail } = await client.rawGet(handle.url, XML_HEADERS);
    const msgRe = /<atom:entry>([\s\S]*?)<\/atom:entry>/g;
    let msg: RegExpExecArray | null;
    while ((msg = msgRe.exec(detail)) !== null) {
      const text = decodeXml(/<atom:title>([^<]*)<\/atom:title>/.exec(msg[1])?.[1] ?? '').trim();
      if (!text) continue;
      messages.push({
        step: handle.step,
        type: decodeXml(/messagetype="([^"]*)"/.exec(msg[1])?.[1] ?? ''),
        text,
      });
    }
  }
  return { messages, truncated };
}

export async function bwGetRemodelingRequest(
  client: BwClient,
  infoProvider: string,
  remodelingRule: string,
  requestNumber?: string,
  includeLog: boolean = true,
  format: 'text' | 'raw' = 'text',
): Promise<string> {
  const entry = await resolveRequest(client, infoProvider, remodelingRule, requestNumber);
  const key = requireKey(entry);

  const { body: stepsBody } = await client.rawGet(
    `${ODATA}/${entityKey(key)}/to_steps`,
    JSON_HEADERS,
  );
  const steps = parseCollection<MonitorStep>(stepsBody);

  // A missing or unreadable log must not fail the status read — the header and the
  // step list are the parts the caller always needs.
  let messages: LogMessage[] = [];
  let truncated = 0;
  let logError = '';
  if (includeLog) {
    try {
      const log = await fetchLogMessages(client, key.requestNumber, entry.last_run_timestamp ?? '');
      messages = log.messages;
      truncated = log.truncated;
    } catch (e) {
      logError = e instanceof Error ? e.message : String(e);
    }
  }

  if (format === 'raw') {
    return JSON.stringify(
      { request: entry, steps, messages, truncatedLogHandles: truncated, logError: logError || undefined },
      null,
      2,
    );
  }

  const lines: string[] = [];
  lines.push(`Remodeling request ${key.remodelingRule} on ${key.infoProvider}`);
  lines.push(`  Status:       ${statusLabel(entry)}`);
  lines.push(`  Object Type:  ${entry.tlogo ?? ''}`);
  lines.push(`  InfoArea:     ${entry.infoArea ?? ''}`);
  lines.push(`  Last Run:     ${edmDate(entry.last_run_timestamp)}`);
  lines.push(`  Created By:   ${entry.to_createdBy?.fullName ?? entry.createdBy ?? ''}`);
  lines.push(`  Request:      ${key.requestNumber}`);
  lines.push('');

  lines.push(`Steps (${steps.length}):`);
  for (const step of steps) {
    const label = step.stepStatusText ?? REQUEST_STATUS[step.status ?? ''] ?? step.status ?? '';
    lines.push(`  ${step.stepNumber ?? ''} ${step.stepName ?? ''} — ${label} (${step.status ?? ''})`);
  }

  if (includeLog) {
    lines.push('');
    if (logError) {
      lines.push(`Log: (not available: ${logError})`);
    } else if (messages.length === 0) {
      lines.push('Log: (no messages — the request has not run yet)');
    } else {
      lines.push(`Log (${messages.length} messages):`);
      let currentStep = '';
      for (const msg of messages) {
        if (msg.step !== currentStep) {
          currentStep = msg.step;
          lines.push(`  ${currentStep}:`);
        }
        lines.push(`    [${msg.type}] ${msg.text}`);
      }
      if (truncated > 0) {
        lines.push(`  (${truncated} further log sections not read — capped at ${MAX_LOG_HANDLES})`);
      }
    }
  }

  return lines.join('\n').trimEnd();
}

// ── Write ───────────────────────────────────────────────────────────────────

/**
 * Job parameters for the execute/restart function imports. The backend rejects a
 * partial parameter list, so every declared parameter is sent — unused ones with
 * the empty sentinels the Fiori app uses.
 */
function jobParameters(start: string): string[] {
  const immediate = start === 'immediate';
  let startDate = EMPTY_DATE;
  let startTime = "time'PT00H00M00S'";

  if (!immediate) {
    const at = new Date(start);
    if (Number.isNaN(at.getTime())) {
      throw new Error(`start must be "immediate" or an ISO 8601 timestamp, got "${start}"`);
    }
    const iso = at.toISOString();
    startDate = `datetime'${iso.slice(0, 10)}T00:00:00'`;
    startTime = `time'PT${iso.slice(11, 13)}H${iso.slice(14, 16)}M${iso.slice(17, 19)}S'`;
  }

  return [
    `Sdlstrtdt=${startDate}`,
    `Sdlstrttm=${startTime}`,
    `Laststrtdt=${EMPTY_DATE}`,
    `Laststrttm=time'PT00H00M00S'`,
    `Predjob=''`,
    `Predjobcnt=''`,
    `Checkstat=''`,
    `Eventid=''`,
    `Eventparm=''`,
    // Domain BTCSTDTTYP: I = immediate, D = date/time.
    `Startdttyp='${immediate ? 'I' : 'D'}'`,
    `Prdmins=''`,
    `Prdhours=''`,
    `Prddays=''`,
    `Prdweeks=''`,
    `Prdmonths=''`,
    `Periodic=''`,
    `Instname=''`,
    `Calendarid=''`,
    `Eomcorrect=0`,
    `Calcorrect=0`,
    `Imstrtpos=''`,
    `Prdbehav=''`,
    `Wdayno=''`,
    `Wdaycdir=''`,
    `Notbefore=${EMPTY_DATE}`,
    `Tmzone='UTC'`,
  ];
}

export async function bwRunRemodeling(
  client: BwClient,
  action: RemodelingAction,
  infoProvider: string,
  remodelingRule: string,
  requestNumber?: string,
  start: string = 'immediate',
): Promise<string> {
  const entry = await resolveRequest(client, infoProvider, remodelingRule, requestNumber);
  const key = requireKey(entry);

  const params = [
    ...(action === 'execute' || action === 'restart' ? jobParameters(start) : []),
    `requestNumber='${encodeURIComponent(key.requestNumber)}'`,
    `requestName='${encodeURIComponent(key.requestName)}'`,
    `remodelingRule='${encodeURIComponent(key.remodelingRule)}'`,
    `infoProvider='${encodeURIComponent(key.infoProvider)}'`,
  ];

  const token = await client.getCsrfToken();
  const { body, headers } = await client.rawPost(
    `${ODATA}/${ACTION_FUNCTION[action]}?${params.join('&')}`,
    '',
    {
      'X-CSRF-Token': token,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      DataServiceVersion: '2.0',
      MaxDataServiceVersion: '2.0',
    },
  );

  const lines: string[] = [];
  lines.push(`Remodeling ${action}: rule ${key.remodelingRule} on ${key.infoProvider}`);

  const sapMessage = headers['sap-message'];
  if (sapMessage) {
    try {
      const parsed = JSON.parse(sapMessage) as { message?: string; severity?: string };
      if (parsed.message) lines.push(`  Message:  ${parsed.message} [${parsed.severity ?? ''}]`);
    } catch {
      lines.push(`  Message:  ${sapMessage}`);
    }
  }

  try {
    const updated = parseEntity<MonitorEntry>(body);
    lines.push(`  Status:   ${statusLabel(updated)}`);
    lines.push(`  Last Run: ${edmDate(updated.last_run_timestamp)}`);
  } catch {
    // Reset variants answer without an entity payload.
  }

  lines.push(`  Request:  ${key.requestNumber}`);
  lines.push('');
  lines.push(
    'Runs asynchronously; monitor progress with bw_get_remodeling_request ' +
      '(steps CHECK → SAVE → CONVERT → ACTIVATE → CLEANUP).',
  );

  return lines.join('\n');
}
