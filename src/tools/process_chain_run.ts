import { BwClient, bwSeg } from '../bw-client.js';

const MONITORING = '/sap/bc/http/sap/bw4/v1/monitoring';
const POLL_INTERVAL_MS = 5000;
export const MAX_WAIT_SECONDS = 600;

export interface ChainRunStatus {
  processChain: string;
  logid: string;
  status: string;
  statusType: string;
  manuallyAborted: boolean;
  messages: { severity: string; text: string; id: string }[];
}

export function parseStartResponse(body: string): { processChain: string; logid: string } {
  let parsed: { processChain?: string; logid?: string };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`The start was accepted but the answer carries no run: ${body.slice(0, 300)}`);
  }
  if (!parsed.logid) throw new Error(`The start was accepted but the answer names no log ID: ${body.slice(0, 300)}`);
  return { processChain: parsed.processChain ?? '', logid: parsed.logid };
}

export function parseRunStatus(body: string): ChainRunStatus {
  const j = JSON.parse(body) as {
    processChain?: string; logid?: string; status?: string; statusType?: string;
    manuallyAborted?: boolean;
    aMsg?: { severity?: string; text?: string; class?: string; number?: string }[];
  };
  return {
    processChain: j.processChain ?? '',
    logid: j.logid ?? '',
    status: j.status ?? '',
    statusType: j.statusType ?? '',
    manuallyAborted: j.manuallyAborted === true,
    messages: (j.aMsg ?? []).map((m) => ({
      severity: m.severity ?? '',
      text: m.text ?? '',
      id: `${m.class ?? ''}${m.number ?? ''}`,
    })),
  };
}

export function isRunning(s: ChainRunStatus): boolean {
  return s.statusType.toUpperCase() === 'ACTIVE';
}

async function readStatus(client: BwClient, logid: string, query: string): Promise<ChainRunStatus> {
  const res = await client.rawGet(`${MONITORING}/processchainlogs/${bwSeg(logid)}/status${query}`, {
    Accept: '*/*',
    'X-Requested-With': 'XMLHttpRequest',
  });
  return parseRunStatus(res.body);
}

/**
 * Start a process chain once, now, as the BW/4HANA Cockpit does with "Execute" →
 * "Asynchronous": the run goes to the background under the chain's technical user, and its
 * scheduling is left as it is.
 *
 * The synchronous variant of the same resource is not offered. It runs the chain inside the
 * HTTP work process, where an abort message of a step cannot be shown: the request ends in
 * HTTP 500 and the run is left reading "active" in the monitor.
 *
 * The answer to the start is JSON labelled text/html, so it is parsed from the body rather
 * than trusted by its content type.
 */
export async function bwStartProcessChain(
  client: BwClient,
  name: string,
  waitSeconds = 0,
): Promise<string> {
  if (!name?.trim()) throw new Error('name is required');
  const chain = name.trim().toUpperCase();
  const wait = Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.floor(waitSeconds)));

  client.clearCsrfToken();
  const csrf = await client.getCsrfToken();
  const res = await client
    // An empty Buffer, not '': axios serialises an empty string under a JSON content type as
    // `""`, and the handler reads any body as a callback target ("no HTTP destination found").
    .rawPost(`${MONITORING}/processchains/${bwSeg(chain)}/start`, Buffer.alloc(0), {
      'Content-Type': 'application/json',
      Accept: '*/*',
      'x-csrf-token': csrf,
      'X-Requested-With': 'XMLHttpRequest',
    })
    .catch((err: Error) => {
      throw new Error(`Start process chain '${chain}': ${err.message}`);
    });
  client.clearCsrfToken();
  const { logid } = parseStartResponse(res.body);

  let status = await readStatus(client, logid, '?nopoll=true&noupdate=true');
  const started = Date.now();
  while (wait > 0 && isRunning(status) && Date.now() - started < wait * 1000) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    status = await readStatus(client, logid, '');
  }
  return formatStartResult(chain, logid, status, wait, Math.round((Date.now() - started) / 1000));
}

const PCM_ODATA = '/sap/opu/odata/sap/BW4_PCM_SRV';

/** Step states the monitor offers "Repeat" for: failed and canceled. */
const RESTARTABLE_STATES = new Set(['R', 'X']);

export interface ChainStep {
  processId: string;
  processType: string;
  processVariant: string;
  instance: string;
  jobCount: string;
  status: string;
  statusText: string;
  variantText: string;
}

export function parseChainSteps(body: string): ChainStep[] {
  const rows = (JSON.parse(body) as { d?: { results?: Record<string, unknown>[] } }).d?.results ?? [];
  return rows.map((r) => ({
    processId: String(r['processId'] ?? ''),
    processType: String(r['processType'] ?? ''),
    processVariant: String(r['processVariant'] ?? ''),
    instance: String(r['instance'] ?? ''),
    jobCount: String(r['jobCount'] ?? ''),
    status: String(r['status'] ?? ''),
    statusText: String(r['statusText'] ?? ''),
    variantText: String(r['variantText'] ?? ''),
  }));
}

function describeStep(s: ChainStep): string {
  return `${s.processId} ${s.processType} ${s.processVariant}${s.variantText ? ` (${s.variantText})` : ''}`;
}

/**
 * The step to repeat: the one named by its step number, or else the single failed or canceled
 * step of the run. Several failed steps without a step number is an error rather than a guess,
 * because a repeat starts real processing.
 */
export function selectStepToRestart(steps: ChainStep[], processId?: string): ChainStep {
  if (processId?.trim()) {
    const wanted = processId.trim();
    const step = steps.find((s) => s.processId === wanted);
    if (!step) {
      throw new Error(`Step ${wanted} is not part of this run. Steps: ${steps.map((s) => s.processId).join(', ')}`);
    }
    if (!RESTARTABLE_STATES.has(step.status)) {
      throw new Error(
        `Step ${describeStep(step)} has status '${step.statusText || step.status || 'not run'}'; ` +
        'only a failed or canceled step can be repeated.',
      );
    }
    return step;
  }
  const failed = steps.filter((s) => RESTARTABLE_STATES.has(s.status));
  if (failed.length === 0) throw new Error('The run has no failed or canceled step to repeat.');
  if (failed.length > 1) {
    throw new Error(
      `The run has ${failed.length} failed or canceled steps; name one with process_id: ` +
      failed.map(describeStep).join('; '),
    );
  }
  return failed[0];
}

function odataLiteral(v: string): string {
  return `'${encodeURIComponent(v.replace(/'/g, "''"))}'`;
}

export function buildRestartUrl(chainId: string, logId: string, step: ChainStep): string {
  const params = [
    `processType=${odataLiteral(step.processType)}`,
    `processVariant=${odataLiteral(step.processVariant)}`,
    `instance=${odataLiteral(step.instance)}`,
    `chainId=${odataLiteral(chainId)}`,
    `logId=${odataLiteral(logId)}`,
    `jobCount=${odataLiteral(step.jobCount)}`,
  ];
  return `${PCM_ODATA}/ChainProcessRestart?${params.join('&')}`;
}

async function readChainSteps(client: BwClient, chainId: string, logId: string): Promise<ChainStep[]> {
  const filter = encodeURIComponent(`chainId eq '${chainId}' and logId eq '${logId}'`);
  const res = await client.rawGet(`${PCM_ODATA}/ChainProcessSet?$format=json&$filter=${filter}`, {
    Accept: 'application/json',
  });
  return parseChainSteps(res.body);
}

/**
 * Repeat a failed or canceled step of a process chain run, as the monitor does with "Repeat":
 * the step runs again as a new instance of the same run (step number n-2, n-3, …) and the
 * chain continues from there along its success links.
 *
 * The function import answers HTTP 200 with an empty entity whether or not a new instance was
 * started, so the run is read again afterwards and the new instance is what proves it.
 */
export async function bwRestartProcessChainStep(
  client: BwClient,
  chainId: string,
  logId: string,
  processId?: string,
): Promise<string> {
  if (!chainId?.trim()) throw new Error('chain_id is required');
  if (!logId?.trim()) throw new Error('log_id is required');
  const chain = chainId.trim().toUpperCase();
  const log = logId.trim().toUpperCase();

  const before = await readChainSteps(client, chain, log);
  if (before.length === 0) throw new Error(`No run ${log} of process chain ${chain} found.`);
  const step = selectStepToRestart(before, processId);

  const token = await client.getCsrfToken();
  const { headers } = await client
    .rawPost(buildRestartUrl(chain, log, step), Buffer.alloc(0), {
      'X-CSRF-Token': token,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      DataServiceVersion: '2.0',
      MaxDataServiceVersion: '2.0',
    })
    .catch((err: Error) => {
      throw new Error(`Repeat step ${step.processId} of ${chain}/${log}: ${err.message}`);
    });
  client.clearCsrfToken();

  const after = await readChainSteps(client, chain, log);
  return formatRestartResult(chain, log, step, before, after, headers['sap-message']);
}

export function formatRestartResult(
  chain: string,
  logId: string,
  step: ChainStep,
  before: ChainStep[],
  after: ChainStep[],
  sapMessage?: string,
): string {
  const known = new Set(before.map((s) => `${s.processId}|${s.instance}`));
  const stepNo = step.processId.split('-')[0];
  const repeats = after.filter(
    (s) => s.processId.split('-')[0] === stepNo && s.processId !== step.processId && !known.has(`${s.processId}|${s.instance}`),
  );

  const lines = [`Repeat of step ${describeStep(step)} in ${chain} / ${logId}`];
  if (sapMessage) {
    try {
      const m = JSON.parse(sapMessage) as { message?: string; severity?: string };
      lines.push(`Message: ${m.message ?? sapMessage}${m.severity ? ` [${m.severity}]` : ''}`);
    } catch {
      lines.push(`Message: ${sapMessage}`);
    }
  }
  if (repeats.length > 0) {
    for (const r of repeats) {
      lines.push(`New instance: step ${r.processId}, status ${r.statusText || r.status || 'not yet reported'}`);
    }
    lines.push('The chain continues from this step in the background.');
  } else {
    lines.push(
      'No new instance of the step is visible yet. The backend accepted the call; read the run again ' +
      'in a few seconds — if the step still shows its old status, the repeat was not started.',
    );
  }
  lines.push('', `Step details: bw_get_process_chain_run_detail with chain_id="${chain}" and log_id="${logId}".`);
  return lines.join('\n');
}

export function formatStartResult(
  chain: string,
  logid: string,
  status: ChainRunStatus,
  waitSeconds: number,
  waitedSeconds: number,
): string {
  const lines = [
    `Process chain ${chain} started (asynchronous, in the background).`,
    `Log ID: ${logid}`,
    `Status: ${status.status} (${status.statusType})${status.manuallyAborted ? ', aborted manually' : ''}`,
  ];
  if (waitSeconds > 0) {
    lines.push(
      isRunning(status)
        ? `Still running after ${waitedSeconds} s of the ${waitSeconds} s waited.`
        : `Finished within ${waitedSeconds} s.`,
    );
  }
  // RSPC 009 as a warning is a step the run has not reached yet ("status undefined"); listing
  // every one of them buries the step that matters.
  const relevant = status.messages.filter((m) => !(m.id === 'RSPC009' && m.severity === 'W'));
  if (relevant.length > 0) {
    lines.push('', 'Messages:');
    for (const m of relevant) lines.push(`  ${m.severity} ${m.text}`);
  }
  lines.push(
    '',
    `Step details: bw_get_process_chain_run_detail with chain_id="${chain}" and log_id="${logid}".`,
  );
  if (isRunning(status)) {
    lines.push('The run continues in the background; call that tool again, or bw_list_process_chain_last_status, to follow it.');
  }
  return lines.join('\n');
}
