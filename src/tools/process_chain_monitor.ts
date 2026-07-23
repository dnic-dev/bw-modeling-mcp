import { BwClient } from '../bw-client.js';

const ODATA_HEADERS = { Accept: 'application/json' };

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

function odataDateToIso(v: string | undefined): string | undefined {
  if (!v) return undefined;
  // SAP OData V2 emits epoch-ms dates, optionally with a display timezone offset:
  // `/Date(1784700050000)/` or `/Date(1784700050000+0000)/`. The ms are UTC, so the
  // offset is ignored for the ISO conversion.
  const m = /\/Date\((-?\d+)(?:[+-]\d{4})?\)\//.exec(v);
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
    const result = await client.rawGet(url, ODATA_HEADERS);
    const parsed = JSON.parse(result.body) as { d?: { results?: unknown[] } };
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

  const result = await client.rawGet(url, ODATA_HEADERS);
  const parsed = JSON.parse(result.body) as { d?: { results?: unknown[]; __count?: string } };
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

export async function bwGetProcessChainRunDetail(
  client: BwClient,
  chainId: string,
  logId: string,
): Promise<string> {
  const baseFilter = `chainId eq '${chainId}' and logId eq '${logId}'`;

  const [stepsResult, messagesResult] = await Promise.all([
    client.rawGet(
      buildODataUrl('BW4_PCM_SRV', 'ChainProcessSet', { filter: baseFilter }),
      ODATA_HEADERS,
    ),
    client.rawGet(
      buildODataUrl('BW4_PCM_SRV', 'ChainProcessLogSet', { filter: baseFilter }),
      ODATA_HEADERS,
    ),
  ]);

  const stepsParsed = JSON.parse(stepsResult.body) as { d?: { results?: unknown[] } };
  const steps = stepsParsed.d?.results ?? [];

  const msgParsed = JSON.parse(messagesResult.body) as { d?: { results?: unknown[] } };
  const messages = msgParsed.d?.results ?? [];

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

  lines.push(`── Messages (${messages.length}) ──`);
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const ts = odataDateToIso(m['timestamp'] as string | undefined) ?? '';
    const severity = m['messageType'] as string | undefined;
    const text = m['message'] as string | undefined;
    lines.push(`  [${severity ?? ''}] ${ts} — ${text ?? ''}`);
    const longtext = m['longtext'] as string | undefined;
    if (longtext && longtext.length > 0) {
      lines.push(`      ${longtext}`);
    }
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

  const result = await client.rawGet(url, ODATA_HEADERS);
  const parsed = JSON.parse(result.body) as { d?: { results?: unknown[]; __count?: string } };
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
