import { BwClient, createClientFromEnv } from '../bw-client.js';
import { queryTable } from './metadata_tables.js';

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

// The monitor status is served from a gateway/CDS buffer that lags behind: a finished run
// keeps reporting Running for minutes. Suppressing the cache is one half of the fix, a
// fresh session (freshClient) the other.
const NO_CACHE = { 'Cache-Control': 'no-cache', Pragma: 'no-cache' };
const JSON_HEADERS = { Accept: 'application/json', ...NO_CACHE };
const XML_HEADERS = { Accept: 'application/xml', ...NO_CACHE };

/** Runtime tables that hold the truth while the OData header status still lags. */
const HEAD_TABLE = 'rscnvcnvhd2';
const STEP_TABLE = 'rscnvstep';
const JOB_TABLE = 'tbtco';

/** The step row that spans the whole run, as opposed to the numbered monitor steps. */
const RUN_STEP = 'RUN';

/** TBTCO job status codes that mean the job is no longer running. */
const JOB_FINISHED: Record<string, string> = { F: 'finished', A: 'aborted' };

const REQUEST_STATUS: Record<string, string> = {
  N: 'Not scheduled',
  S: 'Scheduled',
  R: 'Running',
  // Wording follows the service's own texts, so a corrected status and a service-reported
  // one read identically.
  C: 'Complete',
  E: 'Error',
};

/**
 * No status filter by default. Enumerating the known codes would silently drop a request
 * whose status is not among them — and because $inlinecount is filtered too, the result
 * would look complete. An unfiltered read cannot hide a request.
 */
const NO_STATUS_FILTER = '';

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

/** Label for a status code that did not come from the service (no translated text available). */
function labelForCode(code: string): string {
  const text = REQUEST_STATUS[code] ?? '';
  return text ? `${text} (${code})` : code;
}

/**
 * A separate session for the status read. The shared client carries a stale gateway/CDS
 * buffer that keeps reporting Running after the run has finished — the same reason
 * bw_activate reads trfn/dtpa in a fresh session. Falls back to the shared client when
 * no fresh session can be built, so a status read never fails over this.
 */
function freshClient(client: BwClient): BwClient {
  try {
    return createClientFromEnv();
  } catch {
    return client;
  }
}

/** Escape an ABAP SQL string literal. */
function sqlLit(value: string): string {
  return value.replace(/'/g, "''");
}

/** TIMESTAMPL (`YYYYMMDDHHMMSS.ffffff`, UTC) → ISO 8601, or '' when unset. */
export function timestampl(value?: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec((value ?? '').trim());
  if (!m || m[1] === '0000') return '';
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

/** TBTCO keeps date and time apart, in server local time — not UTC. */
export function jobEndTime(date?: string, time?: string): string {
  const d = (date ?? '').trim();
  const t = (time ?? '').trim().padStart(6, '0');
  if (!/^\d{8}$/.test(d) || d === '00000000') return '';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
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
): Promise<{ entries: MonitorEntry[]; total: number }> {
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
    `&$expand=${encodeURIComponent('to_status,to_createdBy')}` +
    // Needed to tell a complete list from one that top cut short.
    `&$inlinecount=allpages`;

  const { body } = await client.rawGet(query, JSON_HEADERS);
  const entries = parseCollection<MonitorEntry>(body);
  const count = Number((JSON.parse(body) as { d?: { __count?: string } }).d?.__count);
  return { entries, total: Number.isFinite(count) ? count : entries.length };
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

  const { entries: matches } = await fetchRequests(
    client,
    infoProvider,
    NO_STATUS_FILTER,
    20,
    remodelingRule,
  );
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

// ── Status verification ─────────────────────────────────────────────────────

export interface StatusVerification {
  /** Authoritative status code, when the database knows better than the service. */
  status?: string;
  /** Where the corrected status came from. */
  source?: string;
  /** Warning to surface when the run is demonstrably over but the header still says R. */
  note?: string;
  /**
   * Step list read from the runtime table. The service buffers the steps as well, so a
   * corrected header status must not be shown above steps that still claim to be running.
   */
  steps?: MonitorStep[];
}

/** What the runtime tables say about a run whose header status still reads R. */
export interface RuntimeState {
  headStatus: string;
  runStatus: string;
  /** ISO 8601 end of the RUN step, '' when unset. */
  runEnd: string;
  jobName: string;
  jobStatus: string;
  /** Server-local end of the batch job, '' when unset. */
  jobEnd: string;
}

/**
 * Decide what a Running header status really means, in order of authority: the header
 * table, then the overall RUN step, then the batch job. The job only ever produces a
 * warning — it proves the run is over but not how it ended.
 */
export function interpretRuntimeState(state: RuntimeState): StatusVerification {
  if (state.headStatus && state.headStatus !== 'R') {
    return { status: state.headStatus, source: HEAD_TABLE.toUpperCase() };
  }

  // The RUN step spans the whole run: a non-running status with a filled ENDTIME is final.
  if (state.runStatus && state.runStatus !== 'R' && state.runEnd) {
    return {
      status: state.runStatus,
      source: `${STEP_TABLE.toUpperCase()} (step ${RUN_STEP}, ended ${state.runEnd})`,
    };
  }

  const finished = JOB_FINISHED[state.jobStatus];
  if (state.jobName && finished) {
    return {
      note:
        `batch job ${state.jobName} ${finished}` +
        (state.jobEnd ? ` at ${state.jobEnd} server time` : '') +
        ` (${JOB_TABLE.toUpperCase()} status ${state.jobStatus}) — ` +
        `the monitor status has not caught up yet`,
    };
  }

  return {};
}

/**
 * Cross-check a Running header status against the runtime tables.
 *
 * The OData header is buffered and can report Running long after the run finished — a
 * caller polling it waits forever. Failures are not fatal: an unverifiable status simply
 * stays as the service reported it.
 */
async function verifyRunningStatus(
  client: BwClient,
  requestNumber: string,
): Promise<StatusVerification> {
  const id = sqlLit(requestNumber);

  const head = await queryTable(
    client,
    `SELECT status, jobname, jobcount FROM ${HEAD_TABLE} WHERE id = '${id}'`,
    1,
  );
  const headStatus = (head[0]?.STATUS ?? '').trim();
  const jobName = (head[0]?.JOBNAME ?? '').trim();
  const jobCount = (head[0]?.JOBCOUNT ?? '').trim();

  // One read covers both the overall RUN row and the numbered monitor steps.
  const stepRows = await queryTable(
    client,
    `SELECT stepnm, stepno, status, endtime FROM ${STEP_TABLE} WHERE id = '${id}'`,
    60,
  );
  const runRow = stepRows.find((r) => (r.STEPNM ?? '').trim() === RUN_STEP);
  const monitorSteps: MonitorStep[] = stepRows
    // Internal sub-steps all carry step number 000; only the numbered ones are shown.
    .filter((r) => (r.STEPNO ?? '').trim() !== '000')
    .map((r) => ({
      stepNumber: (r.STEPNO ?? '').trim(),
      stepName: (r.STEPNM ?? '').trim(),
      status: (r.STATUS ?? '').trim(),
    }))
    .sort((a, b) => (a.stepNumber ?? '').localeCompare(b.stepNumber ?? ''));

  const runStatus = (runRow?.STATUS ?? '').trim();
  const runEnd = timestampl(runRow?.ENDTIME);

  // The batch job is only needed when neither the header nor the RUN step settled it.
  let jobStatus = '';
  let jobEnd = '';
  const undecided = (!headStatus || headStatus === 'R') && !(runStatus && runStatus !== 'R' && runEnd);
  if (undecided && jobName) {
    const job = await queryTable(
      client,
      `SELECT status, enddate, endtime FROM ${JOB_TABLE} WHERE jobname = '${sqlLit(jobName)}'` +
        (jobCount ? ` AND jobcount = '${sqlLit(jobCount)}'` : ''),
      1,
    );
    jobStatus = (job[0]?.STATUS ?? '').trim();
    jobEnd = jobEndTime(job[0]?.ENDDATE, job[0]?.ENDTIME);
  }

  const verdict = interpretRuntimeState({
    headStatus,
    runStatus,
    runEnd,
    jobName,
    jobStatus,
    jobEnd,
  });

  // Only replace the step list when the header status was actually corrected — otherwise
  // the service's own steps (with their translated texts) stay in place.
  return verdict.status && monitorSteps.length ? { ...verdict, steps: monitorSteps } : verdict;
}

// ── Read ────────────────────────────────────────────────────────────────────

/**
 * Correct Running entries in one query. A per-entry job check would cost one round trip
 * per row, so the list settles for the header table — bw_get_remodeling_request does the
 * full cross-check for a single request.
 */
async function correctRunningEntries(
  client: BwClient,
  entries: MonitorEntry[],
): Promise<Map<string, string>> {
  const running = entries
    .filter((e) => e.status === 'R' && e.requestNumber)
    .map((e) => e.requestNumber as string);
  if (running.length === 0) return new Map();

  const ids = running.map((id) => `'${sqlLit(id)}'`).join(', ');
  const rows = await queryTable(
    client,
    `SELECT id, status FROM ${HEAD_TABLE} WHERE id IN ( ${ids} )`,
    running.length,
  );

  const corrections = new Map<string, string>();
  for (const row of rows) {
    const id = (row.ID ?? '').trim();
    const dbStatus = (row.STATUS ?? '').trim();
    if (id && dbStatus && dbStatus !== 'R') corrections.set(id, dbStatus);
  }
  return corrections;
}

export async function bwListRemodelingRequests(
  client: BwClient,
  infoProvider?: string,
  status: string = NO_STATUS_FILTER,
  top: number = 20,
): Promise<string> {
  const reader = freshClient(client);
  const { entries, total } = await fetchRequests(reader, infoProvider, status, top);

  let corrections = new Map<string, string>();
  let correctionError = '';
  try {
    corrections = await correctRunningEntries(reader, entries);
  } catch (e) {
    correctionError = e instanceof Error ? e.message : String(e);
  }

  const lines: string[] = [];
  const scope = infoProvider ? ` of ${infoProvider.toUpperCase()}` : '';
  const truncated = total > entries.length;
  lines.push(
    `Remodeling requests${scope} — ` +
      (truncated ? `${entries.length} of ${total} shown` : `${entries.length} shown`),
  );
  if (truncated) {
    lines.push(
      `(list truncated by top=${top} — raise top or filter by status; ` +
        `an open request may be among the ${total - entries.length} not shown)`,
    );
  }
  lines.push('');

  if (entries.length === 0) {
    lines.push('(no remodeling requests matched — widen status or drop the InfoProvider filter)');
    return lines.join('\n');
  }

  for (const entry of entries) {
    const corrected = corrections.get(entry.requestNumber ?? '');
    lines.push(`Rule: ${entry.remodelingRule ?? ''}`);
    lines.push(`  InfoProvider: ${entry.infoProvider ?? ''}`);
    lines.push(
      `  Status:       ${corrected ? labelForCode(corrected) : statusLabel(entry)}` +
        (corrected ? ` — corrected from ${labelForCode('R')}, monitor buffer lags` : ''),
    );
    lines.push(`  Last Run:     ${edmDate(entry.last_run_timestamp)}`);
    lines.push(`  Created By:   ${entry.to_createdBy?.fullName ?? entry.createdBy ?? ''}`);
    lines.push(`  Request:      ${entry.requestNumber ?? ''}`);
    lines.push('');
  }

  if (correctionError) {
    lines.push(`(running entries not cross-checked against ${HEAD_TABLE.toUpperCase()}: ${correctionError})`);
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
  const reader = freshClient(client);
  const entry = await resolveRequest(reader, infoProvider, remodelingRule, requestNumber);
  const key = requireKey(entry);

  const { body: stepsBody } = await reader.rawGet(
    `${ODATA}/${entityKey(key)}/to_steps`,
    JSON_HEADERS,
  );
  const steps = parseCollection<MonitorStep>(stepsBody);

  // Never report "running" on the service's word alone — that is the state that hangs.
  let verification: StatusVerification = {};
  if (entry.status === 'R') {
    try {
      verification = await verifyRunningStatus(reader, key.requestNumber);
    } catch (e) {
      verification = {
        note: `status could not be verified against the runtime tables: ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }
  }

  // A missing or unreadable log must not fail the status read — the header and the
  // step list are the parts the caller always needs.
  let messages: LogMessage[] = [];
  let truncated = 0;
  let logError = '';
  if (includeLog) {
    try {
      const log = await fetchLogMessages(reader, key.requestNumber, entry.last_run_timestamp ?? '');
      messages = log.messages;
      truncated = log.truncated;
    } catch (e) {
      logError = e instanceof Error ? e.message : String(e);
    }
  }

  if (format === 'raw') {
    return JSON.stringify(
      {
        request: entry,
        steps: verification.steps ?? steps,
        serviceSteps: verification.steps ? steps : undefined,
        messages,
        truncatedLogHandles: truncated,
        statusVerification: verification.status || verification.note ? verification : undefined,
        logError: logError || undefined,
      },
      null,
      2,
    );
  }

  const lines: string[] = [];
  lines.push(`Remodeling request ${key.remodelingRule} on ${key.infoProvider}`);
  lines.push(
    `  Status:       ${verification.status ? labelForCode(verification.status) : statusLabel(entry)}`,
  );
  if (verification.status) {
    lines.push(
      `                (corrected from ${labelForCode('R')} reported by the monitor; ` +
        `source: ${verification.source})`,
    );
  } else if (verification.note) {
    lines.push(`                (warning: ${verification.note})`);
  }
  lines.push(`  Object Type:  ${entry.tlogo ?? ''}`);
  lines.push(`  InfoArea:     ${entry.infoArea ?? ''}`);
  lines.push(`  Last Run:     ${edmDate(entry.last_run_timestamp)}`);
  lines.push(`  Created By:   ${entry.to_createdBy?.fullName ?? entry.createdBy ?? ''}`);
  lines.push(`  Request:      ${key.requestNumber}`);
  lines.push('');

  // The service returns the steps unordered, and its step list is buffered just like the
  // header — a corrected status brings its own step list along.
  const shownSteps = [...(verification.steps ?? steps)].sort((a, b) =>
    (a.stepNumber ?? '').localeCompare(b.stepNumber ?? ''),
  );
  lines.push(`Steps (${shownSteps.length}):`);
  for (const step of shownSteps) {
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
