import { BwClient, createClientFromEnv } from '../bw-client.js';

// Every GET in the runtime manage family returns HTTP 415 unless it carries
// Content-Type: application/json, even though GET has no body.
const GET_HEADERS = { 'Content-Type': 'application/json', Accept: '*/*' };

interface User {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  username?: string;
}

interface RequestListItem {
  requestTsn?: string;
  requestTsnExternal?: string;
  storage?: string;
  lastTimeStamp?: string;
  records?: number;
  user?: User;
  requestStatus?: string;
  statusTooltip?: string;
  // The process-level completion signal. For some green inbound loads requestStatus
  // still reads "Y" (in process) while lastProcessStatus is already "G" (green) — so
  // these are surfaced alongside requestStatus rather than overriding it.
  lastProcessStatus?: string;
  lastAction?: string;
}

interface DtpInformation {
  dataTransferProcess?: string;
  dtpDescription?: string;
  processModeDescription?: string;
  requestStart?: string;
  requestFinish?: string;
  requestDuration?: string;
  packageSize?: number;
}

interface ProcessStep {
  processTsn?: string;
  processTsnExternal?: string;
  processType?: string;
  processTypeDescription?: string;
  processStatus?: string;
  timestamp?: string;
}

interface LogMessage {
  message?: string;
  severity?: string;
  longText?: string;
}

interface DomainText {
  key?: string;
  text?: string;
}

// Cap on the extra per-step log reads of one bw_get_request call.
const MAX_STEP_LOGS = 10;

// Module-scope caches for the system domain text maps. The status tables are
// stable for the process lifetime, so they are fetched once and reused.
let requestStatusMap: Map<string, string> | null = null;
let processStatusMap: Map<string, string> | null = null;

async function fetchDomainMap(client: BwClient, domain: string): Promise<Map<string, string>> {
  const url = `/sap/bc/http/sap/bw4/v1/system/domains/${domain}/texts`;
  const result = await client.rawGet(url, GET_HEADERS);
  const parsed = JSON.parse(result.body) as DomainText[];
  const map = new Map<string, string>();
  for (const entry of parsed) {
    if (entry.key !== undefined) {
      map.set(entry.key, entry.text ?? entry.key);
    }
  }
  return map;
}

async function getRequestStatusMap(client: BwClient): Promise<Map<string, string>> {
  if (!requestStatusMap) {
    requestStatusMap = await fetchDomainMap(client, 'rspm_request_status');
  }
  return requestStatusMap;
}

async function getProcessStatusMap(client: BwClient): Promise<Map<string, string>> {
  if (!processStatusMap) {
    processStatusMap = await fetchDomainMap(client, 'rspm_process_status');
  }
  return processStatusMap;
}

function decodeStatus(map: Map<string, string>, code: string | undefined): string {
  const raw = code ?? '';
  const text = map.get(raw);
  return text ? `${text} (${raw})` : raw;
}

export async function bwListRequests(
  client: BwClient,
  target: string,
  targetType: string = 'ADSO',
  storage: string = 'AQ,AX,AT',
  status: string = 'N,GG,GR,YG,RR,YR,RG,U,Y,X',
  top: number = 3,
  createdFrom?: string,
): Promise<string> {
  // top bounds the result set; each returned row triggers an expensive per-row
  // backend enrichment, so createdfrom only helps by shrinking the result set.
  let url =
    `/sap/bc/http/sap/bw4/v1/manage/requests` +
    `?tlogo=${encodeURIComponent(targetType.toLowerCase())}` +
    `&datatarget=${encodeURIComponent(target.toLowerCase())}` +
    `&storage=${encodeURIComponent(storage)}`;

  if (createdFrom) {
    // Server-side lower time bound; the Cockpit drops latestrequests in this case.
    url += `&createdfrom=${encodeURIComponent(createdFrom)}`;
  } else {
    url += `&latestrequests=${top}`;
  }

  url += `&top=${top}` + `&status=${encodeURIComponent(status)}`;

  const result = await client.rawGet(url, GET_HEADERS);
  const requests = JSON.parse(result.body) as RequestListItem[];
  const statusMap = await getRequestStatusMap(client);
  const processStatusMapList = await getProcessStatusMap(client);

  const lines: string[] = [];
  lines.push(`Requests of ${target.toUpperCase()} (${targetType.toUpperCase()}) — ${requests.length} shown`);
  lines.push('');

  if (requests.length === 0) {
    lines.push('(no requests found — requests appear asynchronously after a DTP start;');
    lines.push(' retry after a few seconds and verify the target is the final target of the DTP)');
    return lines.join('\n');
  }

  for (const req of requests) {
    lines.push(`Request: ${req.requestTsnExternal ?? ''}`);
    lines.push(`  Status:       ${decodeStatus(statusMap, req.requestStatus)}`);
    lines.push(`  Last Process: ${decodeStatus(processStatusMapList, req.lastProcessStatus)}`);
    if (req.lastAction) lines.push(`  Last Action:  ${req.lastAction}`);
    lines.push(`  Records:      ${req.records ?? ''}`);
    lines.push(`  Timestamp:    ${req.lastTimeStamp ?? ''}`);
    lines.push(`  User:         ${req.user?.fullName ?? ''}`);
    lines.push(`  TSN:          ${req.requestTsn ?? ''}`);
    lines.push(`  Storage:      ${req.storage ?? ''}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export async function bwGetRequest(
  client: BwClient,
  requestTsn: string,
  storage: string = 'AQ',
  format: 'text' | 'raw' = 'text',
): Promise<string> {
  const s = storage.toLowerCase();
  const headerUrl = `/sap/bc/http/sap/bw4/v1/manage/requests/${encodeURIComponent(requestTsn)}/${s}`;
  const dtpInfoUrl = `/sap/bc/http/sap/bw4/v1/manage/requests/${encodeURIComponent(requestTsn)}/${s}/datatransferprocessinformation`;
  const processesUrl = `/sap/bc/http/sap/bw4/v1/manage/processes?request=${encodeURIComponent(requestTsn)}&storage=${s}`;
  const logUrlFor = (tsn: string) =>
    `/sap/bc/http/sap/bw4/v1/manage/processes/${encodeURIComponent(tsn)}/logs?top=100&readMaximumNumberOfResults=true`;
  const logsUrl = logUrlFor(requestTsn);

  // The message log is the primary diagnostic source and needs no storage code, so it must
  // never die on a 404 of the storage-dependent header/DTP-info/process endpoints (a wrong
  // storage code 404s those but the log is still reachable). allSettled isolates each.
  const [headerRes, dtpInfoRes, processesRes, logsRes] = await Promise.allSettled([
    client.rawGet(headerUrl, GET_HEADERS),
    client.rawGet(dtpInfoUrl, GET_HEADERS),
    client.rawGet(processesUrl, GET_HEADERS),
    client.rawGet(logsUrl, GET_HEADERS),
  ]);

  const errMsg = (r: PromiseRejectedResult): string =>
    r.reason instanceof Error ? r.reason.message : String(r.reason);

  const processes: ProcessStep[] = processesRes.status === 'fulfilled'
    ? JSON.parse(processesRes.value.body) as ProcessStep[]
    : [];

  // A process step that runs under its own TSN — a request activation, for one — keeps its
  // messages in its own process log. The request-level log only carries the messages of the
  // load itself, so a step that failed would otherwise show up as a red line with the reason
  // nowhere in the output. Read those logs as well; on a request with many steps, restrict
  // them to the steps that did not finish green.
  const ownTsnSteps = processes.filter((p) => p.processTsn && p.processTsn !== requestTsn);
  const stepLogSteps = (ownTsnSteps.length > MAX_STEP_LOGS
    ? ownTsnSteps.filter((p) => p.processStatus !== 'G')
    : ownTsnSteps
  ).slice(0, MAX_STEP_LOGS);

  const stepLogsRes = await Promise.allSettled(
    stepLogSteps.map((p) => client.rawGet(logUrlFor(p.processTsn as string), GET_HEADERS)),
  );

  const stepLogs = stepLogSteps.map((step, i) => {
    const res = stepLogsRes[i] as PromiseSettledResult<{ body: string }>;
    return {
      step,
      logs: res.status === 'fulfilled' ? JSON.parse(res.value.body) as LogMessage[] : undefined,
      error: res.status === 'rejected' ? errMsg(res) : undefined,
    };
  });

  if (format === 'raw') {
    return JSON.stringify({
      header: headerRes.status === 'fulfilled'
        ? JSON.parse(headerRes.value.body) as RequestListItem
        : { error: errMsg(headerRes) },
      dtpInformation: dtpInfoRes.status === 'fulfilled'
        ? JSON.parse(dtpInfoRes.value.body) as DtpInformation
        : { error: errMsg(dtpInfoRes) },
      processes: processesRes.status === 'fulfilled'
        ? processes
        : { error: errMsg(processesRes) },
      logs: logsRes.status === 'fulfilled'
        ? JSON.parse(logsRes.value.body) as LogMessage[]
        : { error: errMsg(logsRes) },
      processStepLogs: stepLogs.map((s) => ({
        processTsn: s.step.processTsn,
        processTypeDescription: s.step.processTypeDescription,
        processStatus: s.step.processStatus,
        ...(s.logs ? { logs: s.logs } : { error: s.error }),
      })),
    }, null, 2);
  }

  // No section is mandatory — only a request where every one of the four failed has nothing
  // to report. A request can legitimately have no process log at all: an activation request
  // (storage AT) answers the log endpoint with 404 "process does not exist", and treating
  // that as fatal threw away the header, DTP information and process steps that were there.
  if (
    headerRes.status === 'rejected' &&
    dtpInfoRes.status === 'rejected' &&
    processesRes.status === 'rejected' &&
    logsRes.status === 'rejected'
  ) {
    throw new Error(errMsg(headerRes));
  }

  const requestStatus = await getRequestStatusMap(client);
  const processStatus = await getProcessStatusMap(client);

  const lines: string[] = [];
  const unavailable = (r: PromiseRejectedResult): string =>
    `(section not available: ${errMsg(r)} — check the storage code, take it from bw_list_requests)`;

  // Section 1 — header
  // Both the header request status and the last process status are shown: for some green
  // inbound loads requestStatus lags at "Y" (in process) while lastProcessStatus already
  // reads "G" (green). Surfacing both keeps a genuinely running request distinguishable
  // from a finished one without remapping requestStatus.
  if (headerRes.status === 'fulfilled') {
    const header = JSON.parse(headerRes.value.body) as RequestListItem;
    lines.push(`Request: ${header.requestTsnExternal ?? requestTsn}`);
    lines.push(`  Status:       ${decodeStatus(requestStatus, header.requestStatus)}`);
    lines.push(`  Last Process: ${decodeStatus(processStatus, header.lastProcessStatus)}`);
    lines.push(`  Last Action:  ${header.lastAction ?? ''}`);
    lines.push(`  Tooltip:      ${header.statusTooltip ?? ''}`);
    lines.push(`  Records:      ${header.records ?? ''}`);
    lines.push(`  User:         ${header.user?.fullName ?? ''}`);
    lines.push(`  Timestamp:    ${header.lastTimeStamp ?? ''}`);
  } else {
    lines.push(`Request: ${requestTsn}`);
    lines.push(`  ${unavailable(headerRes)}`);
  }

  // Section 2 — DTP information
  lines.push('');
  lines.push('── DTP Information ──');
  if (dtpInfoRes.status === 'fulfilled') {
    const dtpInfo = JSON.parse(dtpInfoRes.value.body) as DtpInformation;
    lines.push(`  DTP:          ${dtpInfo.dataTransferProcess ?? ''}`);
    lines.push(`  Description:  ${dtpInfo.dtpDescription ?? ''}`);
    lines.push(`  Process Mode: ${dtpInfo.processModeDescription ?? ''}`);
    lines.push(`  Start:        ${dtpInfo.requestStart ?? ''}`);
    lines.push(`  Finish:       ${dtpInfo.requestFinish ?? ''}`);
    lines.push(`  Duration:     ${dtpInfo.requestDuration ?? ''}`);
    lines.push(`  Package Size: ${dtpInfo.packageSize ?? ''}`);
  } else {
    lines.push(`  ${unavailable(dtpInfoRes)}`);
  }

  // Section 3 — process steps
  lines.push('');
  if (processesRes.status === 'fulfilled') {
    lines.push(`── Process Steps (${processes.length}) ──`);
    for (const step of processes) {
      lines.push(`  ${step.processTsnExternal ?? ''} — ${step.processTypeDescription ?? ''}`);
      lines.push(`      Status:    ${decodeStatus(processStatus, step.processStatus)}`);
      lines.push(`      Timestamp: ${step.timestamp ?? ''}`);
    }
  } else {
    lines.push('── Process Steps ──');
    lines.push(`  ${unavailable(processesRes)}`);
  }

  // Section 4 — message log. longText is SAPscript-to-HTML; its only added value over
  // message is the "Meldungsnr. {MSGID}" — extract that and append it, drop the raw HTML.
  const formatLog = (log: LogMessage): string => {
    const msgNo = log.longText?.match(/Meldungsnr\.\s*([A-Z0-9_\/]+)/)?.[1];
    return `  [${log.severity ?? ''}] ${log.message ?? ''}${msgNo ? ` (${msgNo})` : ''}`;
  };

  lines.push('');
  if (logsRes.status === 'fulfilled') {
    const logs = JSON.parse(logsRes.value.body) as LogMessage[];
    lines.push(`── Message Log (${logs.length}) ──`);
    for (const log of logs) {
      lines.push(formatLog(log));
    }
  } else {
    // Not the storage-code hint used for the other sections: this endpoint takes no storage
    // code, so a failure here means the request genuinely carries no process log.
    lines.push('── Message Log ──');
    const reason = errMsg(logsRes).split('\n').map((l) => l.trim()).filter(Boolean).join(' — ');
    lines.push(`  (no message log for this request: ${reason})`);
  }

  // Section 5 — message log of each process step that runs under its own TSN
  for (const { step, logs, error } of stepLogs) {
    const title =
      `${step.processTypeDescription ?? step.processType ?? 'Process'} ` +
      `${step.processTsnExternal ?? step.processTsn ?? ''} ` +
      `— ${decodeStatus(processStatus, step.processStatus)}`;
    lines.push('');
    if (logs) {
      lines.push(`── Message Log: ${title} (${logs.length}) ──`);
      for (const log of logs) {
        lines.push(formatLog(log));
      }
    } else {
      lines.push(`── Message Log: ${title} ──`);
      const reason = (error ?? '').split('\n').map((l) => l.trim()).filter(Boolean).join(' — ');
      lines.push(`  (not available: ${reason})`);
    }
  }

  if (ownTsnSteps.length > stepLogs.length) {
    lines.push('');
    lines.push(
      `(${ownTsnSteps.length - stepLogs.length} further process step(s) have their own log; ` +
      `only the first ${MAX_STEP_LOGS} are read per call)`
    );
  }

  return lines.join('\n');
}

/**
 * bw_activate_request — activate loaded data (DSO request activation).
 *
 * Moves a finished load from the Inbound Table into the active data table + change log. This is the
 * runtime RSPM request activation under the BW4 manage API ("Aktivieren" in the load-request
 * details) — NOT the modeling-object activation that bw_activate performs (different endpoint).
 *
 * Single POST to .../manage/requests/{tsn}/{storage}/activate with an empty body; the URL is
 * self-contained and the default activates all previous loads up to this request.
 *
 * Runs in a fresh session (createClientFromEnv()) — like the DTP-activation and DTP-run tools —
 * to avoid a stale shared-session buffer and cross-call session/CSRF collisions.
 *
 * Activation is asynchronous: a 200 means it was kicked off, not that it finished. Completion is
 * monitored via bw_list_requests / bw_get_request.
 */
export async function bwActivateRequest(
  requestTsn: string,
  storage: string = 'AQ',
): Promise<string> {
  const s = storage.toLowerCase();
  const url = `/sap/bc/http/sap/bw4/v1/manage/requests/${encodeURIComponent(requestTsn)}/${s}/activate`;

  const runClient = createClientFromEnv();
  const csrfToken = await runClient.getCsrfToken();

  await runClient.rawPost(url, '', {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'x-csrf-token': csrfToken,
  });

  return JSON.stringify({
    success: true,
    request_tsn: requestTsn,
    message:
      `Data activation started for request ${requestTsn} (storage ${storage.toUpperCase()}). ` +
      `Activation runs asynchronously; monitor completion via bw_list_requests / bw_get_request.`,
  });
}

// Storage codes that hold activated data. A request in one of these is an activation
// request, which the delete endpoint rejects ("Request ist kein löschbarer Request") —
// it has to be rolled back instead, which also removes the load request underneath it.
// aDSOs use AT/AX; InfoObjects load straight into their active tables, one storage per
// subtype (ATAT attributes, ATTE texts, ATHI hierarchies), so every IOBJ request is one.
function isActivationStorage(storage: string): boolean {
  return storage === 'AX' || storage.startsWith('AT');
}

export function defaultRequestStorages(targetType: string): string {
  return targetType.toUpperCase() === 'IOBJ' ? 'ATAT,ATTE,ATHI' : 'AQ,AX,AT';
}

interface DeleteResultEntry {
  storage?: string;
  request?: string;
  requestExternal?: string;
}

interface DeleteResponse {
  status?: string;
  successfulRequests?: DeleteResultEntry[];
  failedRequests?: DeleteResultEntry[];
  messages?: LogMessage[];
}

interface RequestRef {
  tsn: string;
  storage: string;
  external?: string;
}

async function listRequestRefs(
  client: BwClient,
  target: string,
  targetType: string,
  top: number,
): Promise<RequestRef[]> {
  const url =
    `/sap/bc/http/sap/bw4/v1/manage/requests` +
    `?tlogo=${encodeURIComponent(targetType.toLowerCase())}` +
    `&datatarget=${encodeURIComponent(target.toLowerCase())}` +
    `&storage=${defaultRequestStorages(targetType)}` +
    `&latestrequests=${top}&top=${top}` +
    `&status=N,GG,GR,YG,RR,YR,RG,U,Y,X`;

  const result = await client.rawGet(url, GET_HEADERS);
  const rows = JSON.parse(result.body) as RequestListItem[];
  return rows
    .filter((r) => r.requestTsn && r.storage)
    .map((r) => ({
      tsn: r.requestTsn!,
      storage: r.storage!.toUpperCase(),
      external: r.requestTsnExternal,
    }));
}

/** POST .../manage/requests/{tsn}/{storage}/rollback — undo an activation. */
async function rollbackRequest(
  client: BwClient,
  ref: RequestRef,
  csrfToken: string,
): Promise<void> {
  const url =
    `/sap/bc/http/sap/bw4/v1/manage/requests/${encodeURIComponent(ref.tsn)}` +
    `/${ref.storage.toLowerCase()}/rollback`;
  try {
    await client.rawPost(url, '', {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'x-csrf-token': csrfToken,
    });
  } catch (err) {
    const message = (err as Error).message;
    if (isMasterDataStorage(ref.storage) && /HTTP 400/.test(message)) {
      throw new Error(masterDataRefusal(ref, message));
    }
    throw err;
  }
}

/** The request storages of an InfoObject: attributes, texts, hierarchies. */
function isMasterDataStorage(storage: string): boolean {
  return storage === 'ATAT' || storage === 'ATTE' || storage === 'ATHI';
}

/**
 * BW refuses a master data request that loaded successfully on both routes — the rollback
 * ("cannot be rolled back") and the delete endpoint ("not a deletable request"); only a failed
 * one can be removed (verified on BW/4HANA). Passing the bare HTTP 400 on reads like a defect
 * of the tool.
 */
function masterDataRefusal(ref: RequestRef, backendMessage: string): string {
  const detail = backendMessage.split('\n').slice(1).join(' ').trim();
  return (
    `BW does not remove master data request ${ref.tsn} (${ref.storage})` +
    (detail ? ` — "${detail}"` : '') +
    `. A master data load that finished successfully can be neither rolled back nor deleted; ` +
    `only a failed request can. The master data it wrote stays in the InfoObject. Removing it ` +
    `takes the master data deletion of the modeling tools, which this server does not offer.`
  );
}

/** POST .../manage/requests/delete — batch-delete load requests. */
async function deleteRequests(
  client: BwClient,
  refs: RequestRef[],
  csrfToken: string,
): Promise<DeleteResponse> {
  const body = JSON.stringify({
    asynchronous: true,
    requests: refs.map((r) => ({ request: r.tsn, storage: r.storage })),
  });
  const res = await client.rawPost('/sap/bc/http/sap/bw4/v1/manage/requests/delete', body, {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'x-csrf-token': csrfToken,
  });
  return JSON.parse(res.body) as DeleteResponse;
}

/**
 * bw_delete_request — remove load requests from an InfoProvider.
 *
 * BW splits this into two endpoints that the caller should not have to know about, so this
 * tool picks the right one per request:
 *
 *   load request (inbound, AQ)      POST .../manage/requests/delete
 *                                   body {asynchronous, requests:[{request, storage}]}
 *   activation request (AT/AX,      POST .../manage/requests/{tsn}/{storage}/rollback
 *   every InfoObject storage AT*)
 *
 * Calling the delete endpoint with an activation request answers HTTP 400 "not a deletable
 * request". A rollback undoes the activation of that request AND every later one, and takes
 * the load request underneath it with it — so clearing a provider means rolling back the
 * OLDEST activation request once, then deleting whatever is left in the inbound queue.
 *
 * That sequence is what all_requests does, which is the regular case before switching a DTP
 * from delta to full: BW refuses the extraction-mode change while delta requests remain.
 *
 * Runs in a fresh session (createClientFromEnv()) like the other runtime write tools, to
 * avoid a stale shared-session buffer and cross-call CSRF collisions.
 */
export async function bwDeleteRequest(
  client: BwClient,
  requestTsn?: string,
  storage: string = 'AQ',
  target?: string,
  targetType: string = 'ADSO',
  allRequests: boolean = false,
): Promise<string> {
  if (!allRequests && !requestTsn) {
    throw new Error('bw_delete_request needs either request_tsn or all_requests=true with target.');
  }
  if (allRequests && !target) {
    throw new Error('bw_delete_request with all_requests=true needs target (and target_type).');
  }

  const runClient = createClientFromEnv();
  const csrfToken = await runClient.getCsrfToken();

  const rolledBack: RequestRef[] = [];
  const deleted: DeleteResultEntry[] = [];
  const failed: DeleteResultEntry[] = [];
  const notes: string[] = [];

  if (!allRequests) {
    const ref: RequestRef = { tsn: requestTsn!, storage: storage.toUpperCase() };
    if (isActivationStorage(ref.storage)) {
      // Snapshot first so the caller learns which requests the cascade took with it.
      const before = target ? await listRequestRefs(client, target, targetType, 50) : [];
      await rollbackRequest(runClient, ref, csrfToken);
      rolledBack.push(ref);
      if (target) {
        const after = await listRequestRefs(client, target, targetType, 50);
        const left = new Set(after.map((r) => `${r.tsn}/${r.storage}`));
        for (const b of before) {
          if (!left.has(`${b.tsn}/${b.storage}`) && b.tsn !== ref.tsn) {
            deleted.push({ request: b.tsn, storage: b.storage, requestExternal: b.external });
          }
        }
      } else {
        notes.push(
          'Rollback also removes later activation requests and the load request underneath; ' +
          'pass target to have the tool report exactly which ones went.',
        );
      }
    } else {
      const res = await deleteRequests(runClient, [ref], csrfToken);
      deleted.push(...(res.successfulRequests ?? []));
      failed.push(...(res.failedRequests ?? []));
    }
  } else {
    const refs = await listRequestRefs(client, target!, targetType, 200);
    if (refs.length === 0) {
      return JSON.stringify({
        success: true,
        target: target!.toUpperCase(),
        deleted_requests: [],
        message: `${target!.toUpperCase()} holds no requests — nothing to delete.`,
      });
    }

    // Oldest first: rolling back the oldest activation cascades through every later one of
    // the same storage. An InfoObject keeps one storage per subtype, each with its own chain.
    const activated = refs
      .filter((r) => isActivationStorage(r.storage))
      .sort((a, b) => a.tsn.localeCompare(b.tsn));

    const oldestPerStorage = new Map<string, RequestRef>();
    for (const r of activated) {
      if (!oldestPerStorage.has(r.storage)) oldestPerStorage.set(r.storage, r);
    }
    for (const oldest of oldestPerStorage.values()) {
      try {
        await rollbackRequest(runClient, oldest, csrfToken);
        rolledBack.push(...activated.filter((r) => r.storage === oldest.storage));
      } catch (err) {
        // One refused storage of an InfoObject must not stop the others from being cleared.
        if (!isMasterDataStorage(oldest.storage)) throw err;
        failed.push({ request: oldest.tsn, storage: oldest.storage, requestExternal: oldest.external });
        notes.push((err as Error).message);
      }
    }

    // The rollback returns its load requests to the inbound queue, so re-read instead of
    // deleting the pre-rollback list.
    const remaining = await listRequestRefs(client, target!, targetType, 200);
    const deletable = remaining.filter((r) => !isActivationStorage(r.storage));
    if (deletable.length > 0) {
      const res = await deleteRequests(runClient, deletable, csrfToken);
      deleted.push(...(res.successfulRequests ?? []));
      failed.push(...(res.failedRequests ?? []));
    }

    const refused = new Set(failed.map((f) => `${f.request}/${f.storage}`));
    const stillThere = (await listRequestRefs(client, target!, targetType, 200)).filter(
      (r) => !refused.has(`${r.tsn}/${r.storage}`),
    );
    if (stillThere.length > 0) {
      notes.push(
        `${stillThere.length} request(s) still present after the run: ` +
        stillThere.map((r) => `${r.tsn} (${r.storage})`).join(', ') +
        '. Deletion is asynchronous — re-check with bw_list_requests before concluding it failed.',
      );
    }
  }

  return JSON.stringify({
    success: failed.length === 0,
    target: target ? target.toUpperCase() : undefined,
    rolled_back_requests: rolledBack.map((r) => ({ request: r.tsn, storage: r.storage })),
    deleted_requests: deleted,
    failed_requests: failed,
    notes: notes.length > 0 ? notes : undefined,
    message:
      `Deletion started: ${rolledBack.length} activation request(s) rolled back, ` +
      `${deleted.length} request(s) deleted` +
      (failed.length > 0 ? `, ${failed.length} failed` : '') +
      '. BW runs the deletion asynchronously; confirm with bw_list_requests.',
  });
}
