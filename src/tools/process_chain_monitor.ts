import { BwClient } from '../bw-client.js';

const ODATA_HEADERS = { Accept: 'application/json' };

/**
 * One OData read, retried once on a server error.
 *
 * The gateway in front of these services answers with HTTP 500 and "unknown internal server
 * error" every so often under load — observed on a customer system where the same URL then
 * succeeded three times in a row moments later, and where the failure moved between the run
 * list and the run detail rather than sticking to one of them. These are GETs on monitoring
 * data, so repeating one has no side effect, and without the retry a chain that ran fine
 * reads as unavailable.
 */
async function odataGet(client: BwClient, url: string): Promise<string> {
  try {
    return (await client.rawGet(url, ODATA_HEADERS)).body;
  } catch (err) {
    if (!/HTTP 5\d\d/.test(String((err as Error).message))) throw err;
    return (await client.rawGet(url, ODATA_HEADERS)).body;
  }
}

function buildODataUrl(service: string, entitySet: string, opts: {
  filter?: string; orderby?: string; top?: number; inlinecount?: boolean;
}): string {
  const params: string[] = ['$format=json'];
  if (opts.filter) params.push('$filter=' + encodeURIComponent(opts.filter));
  if (opts.orderby) params.push('$orderby=' + encodeURIComponent(opts.orderby));
  if (typeof opts.top === 'number') params.push('$top=' + opts.top);
  if (opts.inlinecount) params.push('$inlinecount=allpages');
  return `/sap/opu/odata/sap/${service}/${entitySet}?` + params.join('&');
}

/**
 * Convert an OData V2 verbose date to ISO 8601.
 *
 * The offset suffix is optional and must be tolerated: these services return the day fields
 * as `/Date(<ms>)/` but every timestamp field as `/Date(<ms>+0000)/`, and without the suffix
 * in the pattern each timestamp fell through unparsed and reached the output as the raw
 * `/Date(…)/` string. The leading number is always epoch milliseconds in UTC — the suffix
 * only states which local time the source meant, so it is ignored here and the result is UTC.
 * Its digit count is not fixed (the spec counts minutes), hence `\d+` rather than `\d{4}`.
 */
export function odataDateToIso(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = /\/Date\((-?\d+)(?:[+-]\d+)?\)\//.exec(v);
  return m ? new Date(Number(m[1])).toISOString() : v;
}

// SAP UI5 CriticalityType: 0=neutral, 1=error(red), 2=warning(yellow), 3=ok(green)
function criticalityLabel(v: unknown): string {
  switch (v) {
    case 0: return 'neutral';
    case 1: return 'error';
    case 2: return 'warning';
    case 3: return 'ok';
    default: return v !== null && v !== undefined ? String(v) : '';
  }
}

// Lazy-loaded cache for status code → text from the Rv_I_Rsvpcm_State value list.
// Stable for the process lifetime — loaded once on first use.
let stateTextCache: Map<string, string> | null = null;

async function getStateTextMap(client: BwClient): Promise<Map<string, string>> {
  if (stateTextCache) return stateTextCache;
  try {
    const url = buildODataUrl('RV_C_PCMLOG_CDS', 'Rv_I_Rsvpcm_State', {});
    const body = await odataGet(client, url);
    const parsed = JSON.parse(body) as { d?: { results?: unknown[] } };
    const rows = parsed.d?.results ?? [];
    stateTextCache = new Map<string, string>();
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const key = r['state'] as string | undefined;
      const text = r['state_Text'] as string | undefined;
      if (key !== undefined) stateTextCache.set(key, text ?? key);
    }
  } catch {
    // If the value-list fetch fails, decode falls back to raw code
    stateTextCache = new Map<string, string>();
  }
  return stateTextCache;
}

function decodeStatus(map: Map<string, string>, code: string | undefined): string {
  const raw = code ?? '';
  const text = map.get(raw);
  return text && text !== raw ? `${text} (${raw})` : raw;
}

// Normalise a caller-supplied ISO date string to the OData V2 datetime literal format.
// Accepts "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS[.sss][Z]" — trims to seconds precision.
function toOdataDatetime(iso: string): string {
  const base = iso.replace('Z', '').split('.')[0];
  return base.length === 10 ? `${base}T00:00:00` : base;
}

export async function bwListProcessChainRuns(
  client: BwClient,
  chainName?: string,
  dateFrom?: string,
  dateTo?: string,
  status?: string,
  limit: number = 20,
): Promise<string> {
  const filterParts: string[] = [];
  if (chainName) filterParts.push(`chainId eq '${chainName}'`);
  if (dateFrom) filterParts.push(`startDate ge datetime'${toOdataDatetime(dateFrom)}'`);
  if (dateTo) filterParts.push(`startDate le datetime'${toOdataDatetime(dateTo)}'`);
  if (status) filterParts.push(`status eq '${status}'`);

  const url = buildODataUrl('RV_C_PCMLOG_CDS', 'Rv_C_PcmLog', {
    filter: filterParts.length > 0 ? filterParts.join(' and ') : undefined,
    orderby: 'startTimestamp desc',
    top: limit,
    inlinecount: true,
  });

  const body = await odataGet(client, url);
  const parsed = JSON.parse(body) as { d?: { results?: unknown[]; __count?: string } };
  const rows = parsed.d?.results ?? [];
  const total = parsed.d?.__count;

  const stateMap = await getStateTextMap(client);

  const lines: string[] = [];
  const scope = chainName ? `chain ${chainName}` : 'all chains';
  lines.push(`Process Chain Runs — ${scope} — ${rows.length} shown${total ? ` of ${total}` : ''}`);
  lines.push('');

  if (rows.length === 0) {
    lines.push('(no runs found)');
    return lines.join('\n');
  }

  for (const row of rows) {
    const r = row as Record<string, unknown>;
    lines.push(`Run: ${r['logId'] ?? ''}`);
    lines.push(`  Chain:       ${r['chainId'] ?? ''} — ${r['chainId_Text'] ?? ''}`);
    lines.push(`  Status:      ${decodeStatus(stateMap, r['status'] as string | undefined)} [${criticalityLabel(r['statusCriticality'])}]`);
    lines.push(`  Runtime:     ${r['runtimeStatus'] ?? ''} [${criticalityLabel(r['runtimeStatusCriticality'])}]`);
    lines.push(`  Start:       ${odataDateToIso(r['startTimestamp'] as string | undefined) ?? ''}`);
    lines.push(`  End:         ${odataDateToIso(r['endTimestamp'] as string | undefined) ?? ''}`);
    lines.push(`  Duration:    ${r['duration'] != null ? `${r['duration']}s` : ''}`);
    lines.push(`  Processes:   ${r['NumberOfProcesses'] ?? ''}`);
    lines.push(`  Scheduling:  ${r['schedulingStatus'] ?? ''}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * How many messages of one run are printed. The log of a healthy chain is hundreds of
 * progress notes that a chat client cannot use; the errors and warnings are what is worth
 * the space, and the rest is reported as a count.
 */
const MESSAGE_LIMIT = 40;

export async function bwGetProcessChainRunDetail(
  client: BwClient,
  chainId: string,
  logId: string,
): Promise<string> {
  const baseFilter = `chainId eq '${chainId}' and logId eq '${logId}'`;

  // Sequential, and the message log is best effort. Both sets used to be fetched with
  // Promise.all, so a failure in either took the whole answer with it — and the gateway
  // answers one of them with HTTP 500 now and then under load (observed on a customer system,
  // where both read fine on their own moments later). The steps are the point of this call;
  // losing them because the log could not be read is the wrong trade.
  const stepsBody = await odataGet(
    client,
    buildODataUrl('BW4_PCM_SRV', 'ChainProcessSet', { filter: baseFilter }),
  );
  const stepsParsed = JSON.parse(stepsBody) as { d?: { results?: unknown[] } };
  const steps = stepsParsed.d?.results ?? [];

  let messages: unknown[] = [];
  let messageError = '';
  try {
    const messagesBody = await odataGet(
      client,
      buildODataUrl('BW4_PCM_SRV', 'ChainProcessLogSet', { filter: baseFilter }),
    );
    messages = (JSON.parse(messagesBody) as { d?: { results?: unknown[] } }).d?.results ?? [];
  } catch (err) {
    messageError = String((err as Error).message).split('\n')[0];
  }

  const lines: string[] = [];
  lines.push(`Process Chain Run Detail — ${chainId} / ${logId}`);
  lines.push('');

  lines.push(`── Steps (${steps.length}) ──`);
  for (const step of steps) {
    const s = step as Record<string, unknown>;
    lines.push(`  Step: ${s['processId'] ?? ''}`);
    lines.push(`    Type:    ${s['processTypeText'] ?? s['processType'] ?? ''}`);
    lines.push(`    Variant: ${s['variantText'] ?? s['processVariant'] ?? ''}`);
    lines.push(`    Status:  ${s['statusText'] ?? s['status'] ?? ''} [${criticalityLabel(s['statusCriticality'])}]`);
    lines.push(`    Start:   ${odataDateToIso(s['startTimestamp'] as string | undefined) ?? ''}`);
    lines.push(`    End:     ${odataDateToIso(s['endTimestamp'] as string | undefined) ?? ''}`);
    if (s['predecessorProcessId']) {
      lines.push(`    Parent:  ${s['predecessorProcessId']}`);
    }
    lines.push('');
  }

  if (messageError) {
    lines.push('── Messages ──');
    lines.push(`  (not readable: ${messageError})`);
    lines.push('  The steps above were read separately and are complete.');
    return lines.join('\n');
  }

  // One run of a real chain carries hundreds of messages — 824 on the run this limit was
  // written against — and nearly all of them are progress notes. Errors, warnings and aborts
  // are what the caller is after, so those are shown and the rest is reported as a count.
  const severityOf = (msg: unknown) =>
    String((msg as Record<string, unknown>)['messageType'] ?? '').toUpperCase();
  const notable = messages.filter((m) => ['E', 'W', 'A', 'X'].includes(severityOf(m)));
  const shown = notable.length > 0 ? notable : messages;

  // The same message repeats once per affected object or package — six identical warnings
  // about one DataStore is the normal shape of this log. Collapsed to one line with a count,
  // which is what a reader can act on; the first occurrence keeps its timestamp.
  const collapsed = new Map<string, { severity: string; ts: string; text: string; count: number }>();
  for (const msg of shown) {
    const m = msg as Record<string, unknown>;
    const severity = String(m['messageType'] ?? '');
    const text = String(m['message'] ?? '');
    const key = JSON.stringify([severity, text]);
    const seen = collapsed.get(key);
    if (seen) seen.count++;
    else {
      collapsed.set(key, {
        severity,
        ts: odataDateToIso(m['timestamp'] as string | undefined) ?? '',
        text,
        count: 1,
      });
    }
  }

  lines.push(`── Messages (${messages.length}) ──`);
  if (messages.length === 0) lines.push('  (none)');
  for (const m of [...collapsed.values()].slice(0, MESSAGE_LIMIT)) {
    // The long text of these messages is the SAPscript help document converted to HTML, which
    // restates the message and nothing else. Hundreds of lines of escaped markup for no
    // information, so it is left out.
    lines.push(`  [${m.severity}] ${m.ts} — ${m.text}${m.count > 1 ? `  (${m.count}×)` : ''}`);
  }
  if (collapsed.size > MESSAGE_LIMIT) {
    lines.push(`  … ${collapsed.size - MESSAGE_LIMIT} further distinct message(s) not shown`);
  }
  if (notable.length > 0 && messages.length > notable.length) {
    lines.push(`  (${messages.length - notable.length} informational message(s) not shown)`);
  } else if (notable.length === 0 && messages.length > 0) {
    lines.push('  (no error or warning among them)');
  }

  return lines.join('\n');
}

export async function bwListProcessChainLastStatus(
  client: BwClient,
  status?: string,
  lastStartFrom?: string,
  lastStartTo?: string,
  limit?: number,
): Promise<string> {
  const filterParts: string[] = [];
  if (status) filterParts.push(`lastStatus eq '${status}'`);
  if (lastStartFrom) filterParts.push(`lastStartDate ge datetime'${toOdataDatetime(lastStartFrom)}'`);
  if (lastStartTo) filterParts.push(`lastStartDate le datetime'${toOdataDatetime(lastStartTo)}'`);

  const url = buildODataUrl('RV_C_PCMPROCESSCHAIN_CDS', 'Rv_C_PcmProcessChain', {
    filter: filterParts.length > 0 ? filterParts.join(' and ') : undefined,
    inlinecount: true,
    ...(typeof limit === 'number' ? { top: limit } : {}),
  });

  const body = await odataGet(client, url);
  const parsed = JSON.parse(body) as { d?: { results?: unknown[]; __count?: string } };
  const rows = parsed.d?.results ?? [];
  const total = parsed.d?.__count;

  const stateMap = await getStateTextMap(client);

  const lines: string[] = [];
  lines.push(`Process Chain Last Status — ${rows.length} shown${total ? ` of ${total}` : ''}`);
  lines.push('');

  if (rows.length === 0) {
    lines.push('(no chains found)');
    return lines.join('\n');
  }

  for (const row of rows) {
    const r = row as Record<string, unknown>;
    lines.push(`Chain: ${r['chainId'] ?? ''} — ${r['chainId_Text'] ?? ''}`);
    lines.push(`  Last Status:   ${decodeStatus(stateMap, r['lastStatus'] as string | undefined)} [${criticalityLabel(r['lastStatusCriticality'])}]`);
    lines.push(`  Last Runtime:  ${r['lastRuntimeStatus'] ?? ''} [${criticalityLabel(r['lastRuntimeStatusCriticality'])}]`);
    lines.push(`  Last Start:    ${odataDateToIso(r['lastStartTimestamp'] as string | undefined) ?? ''}`);
    lines.push(`  Last End:      ${odataDateToIso(r['lastEndTimestamp'] as string | undefined) ?? ''}`);
    lines.push(`  Last Duration: ${r['lastDuration'] != null ? `${r['lastDuration']}s` : ''}`);
    lines.push(`  Scheduling:    ${r['schedulingStatus'] ?? ''} [${criticalityLabel(r['schedulingStatusCriticality'])}]`);
    lines.push(`  Next Start:    ${odataDateToIso(r['nextStartDate'] as string | undefined) ?? ''}`);
    lines.push(`  Log ID:        ${r['logId'] ?? ''}`);
    lines.push(`  Responsible:   ${r['personResponsible_Text'] ?? r['personResponsible'] ?? ''}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
