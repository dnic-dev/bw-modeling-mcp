import { BwClient, bwSeg } from '../bw-client.js';

const BASE = '/sap/bc/http/sap/bw4/v1/modeling/processchains';
const DECISION_VARIANTS_BASE = '/sap/bc/http/sap/bw4/v1/modeling/processtypes/decision/variants';
const VALIDATEOBJECT_PATH = '/sap/bc/http/sap/bw4/v1/modeling/transports/validateobject';
const JSON_CT = 'application/json';

const COLLECTORS = new Set(['AND', 'OR', 'XOR']);

// Collector node types that RSPC may hold (AND / OR / EXOR); XOR kept as a synonym.
const COLLECTOR_TYPES = new Set(['AND', 'OR', 'EXOR', 'XOR']);

// Step types whose configuration is stored INLINE in the chain model (as an entry in
// aInlineVariant) rather than referenced as a separate variant object.
const INLINE_STEP_TYPES = new Set(['ADSOACT', 'ADSOREM', 'ABAP']);

const TRIGGER_SCHEDULE_DETAIL = {
  startdttyp: 'I',
  sdlstrttimestamp: '',
  maximumDelay: 0,
  tmzone: '',
  recurrencyPattern: '',
  prdmins: 0,
  prdhours: 0,
  prddays: 0,
  prdweeks: 0,
  prdmonths: 0,
  prdbehav: '',
  calendarid: '',
  eventtype: '',
  eventid: [],
  eventparm: '',
  operationMode: '',
  onlyOnce: false,
  wdCalendarid: '',
  wdayno: 0,
  wdaycdir: '',
  wdPrdmonths: 0,
  wdSystemtimezone: '',
  sdlstrttm: '',
  notbefore: '',
};

// ── Input types ────────────────────────────────────────────────────────────────

interface StepDtpLoad {
  id: string;
  type: 'DTP_LOAD';
  dtp: string;
  description?: string;
}

interface StepAdsoAct {
  id: string;
  type: 'ADSOACT';
  datastores: string[];
  requestsSequential?: boolean;
  errorOnNonActivation?: boolean;
}

// One aDSO cleanup entry inside an ADSOREM ("Delete Requests from DataStore Object") step.
interface AdsoRemDatastore {
  // aDSO technical name whose requests are cleaned up.
  datastore: string;
  // Cleanup action code from the cockpit "Bereinigungsaktion" dropdown (single char).
  // Observed: "A" = activate requests, "C" = remove old requests from the change log.
  // The valid action depends on the aDSO type; an unsuitable action is rejected at activation.
  action: string;
  // Clean up all requests (ALL_REQUESTS). When true, the count/age selectors are ignored.
  allRequests?: boolean;
  // Keep the last N requests (NUMBER_REQUESTS); older ones are removed.
  numberRequests?: number;
  // Remove requests older than N days (NUMBER_DAYS).
  numberDays?: number;
  // Processing package size (PACKAGE_SIZE); 0 = server default.
  packageSize?: number;
}

interface StepAdsoRem {
  id: string;
  type: 'ADSOREM';
  remDatastores: AdsoRemDatastore[];
}

interface StepCollector {
  id: string;
  type: 'AND' | 'OR' | 'XOR';
}

interface StepDecision {
  id: string;
  type: 'DECISION';
  // Name of a pre-existing (active) decision variant to reference, e.g. created via
  // bw_create_decision_variant. The step references it by name (bIsReference=true).
  variant: string;
  description?: string;
}

interface StepGeneric {
  id: string;
  type: string;
  object: string;
  description?: string;
}

// An "Execute ABAP Program" call. The program is stored as an inline process variant
// inside the chain model — there is no separate variant object to create first.
export interface AbapProgramSpec {
  // ABAP program / report to execute.
  program: string;
  // Optional ABAP report (SE38) selection variant name.
  variant?: string;
  // Step description (sVariantDescription). Cosmetic.
  description?: string;
  // Cosmetic value-help enrichment; the server re-derives these when omitted.
  programPackage?: string;
  programDescription?: string;
  variantDescription?: string;
  // Call mode. true (default) → X_SYNCHRON.
  synchronous?: boolean;
  // Call location. true (default) → X_LOCAL (run on this system).
  local?: boolean;
}

interface StepAbap extends AbapProgramSpec {
  id: string;
  type: 'ABAP';
}

export type Step =
  | StepDtpLoad
  | StepAdsoAct
  | StepAdsoRem
  | StepCollector
  | StepDecision
  | StepAbap
  | StepGeneric;

export type EdgeStatus = 'neutral' | 'positive' | 'negative';

export interface EdgeDef {
  from: string;
  to: string;
  status?: EdgeStatus;
  // Branch condition for edges leaving a DECISION node: the branch's EVENTNO
  // ("01" for the first/THEN branch, "02" for the second/ELSE branch). Normal
  // (non-branch) edges use "00" (the default when omitted).
  subStatus?: string;
}

// Event start-condition for the chain TRIGGER (start type "E"). When supplied, the
// trigger's oDetail is built with startdttyp:"E" and the event fields instead of the
// default immediate/periodic detail (startdttyp:"I").
export interface TriggerEventConfig {
  // Event id, e.g. "SAP_TEST".
  eventId: string;
  // Event parameter. Defaults to the chain name when omitted (matches the cockpit).
  eventParameter?: string;
  // Event type. Defaults to "OtherEvent".
  eventType?: string;
  // Start only once. Defaults to false.
  onlyOnce?: boolean;
}

export interface CreateProcessChainParams {
  name: string;
  infoarea: string;
  description: string;
  steps: Step[];
  edges: EdgeDef[];
  activate?: boolean;
  // Optional event start-condition for the trigger. Omit for the default immediate start.
  triggerEvent?: TriggerEventConfig;
}

export interface UpdateProcessChainParams {
  name: string;
  description?: string;
  infoarea?: string;
  steps: Step[];
  edges: EdgeDef[];
  activate?: boolean;
  // Transport request to record the change into. Only relevant when the chain is
  // in a transportable package (not $TMP); ignored otherwise.
  transportRequest?: string;
  // Optional event start-condition for the trigger. When omitted, an existing event
  // start-condition on the chain is preserved; a non-event trigger stays immediate.
  triggerEvent?: TriggerEventConfig;
}

export interface CreateDecisionVariantParams {
  // Decision variant technical name (its own TLOGO object), uppercase.
  name: string;
  // Variant description / label.
  description: string;
  // The branch condition formula, e.g. "GET_SEGMENT( ) = ' 3'". Evaluated for the
  // THEN branch; the ELSE branch is the complement.
  formula: string;
  // Target package. Pass a transportable package (NOT $TMP): $TMP variants are not
  // selectable in the chain variant picker and cannot be transported. Defaults to
  // $TMP with a warning.
  package?: string;
  // Transport request to record the new variant into (required for a transportable
  // package unless exactly one changeable request is available).
  transportRequest?: string;
  // Label of the THEN/first branch. Default "JA".
  thenLabel?: string;
  // Label of the ELSE/second branch. Default "NEIN".
  elseLabel?: string;
  // EVENTNO of the THEN branch (referenced by chain branch edges). Default "01".
  thenEventNo?: string;
  // EVENTNO of the ELSE branch. Default "02".
  elseEventNo?: string;
}

export interface AddProcessChainErrorLinksParams {
  name: string;
  // Restrict to these steps; each entry is matched against a node's sProcessVariant
  // (the DTP name) or as a substring of its sVariantDescription (which carries the
  // target DataStore). Omit to apply to all DTP_LOAD nodes.
  dtps?: string[];
  activate?: boolean;
  transportRequest?: string;
}

export interface SwapProcessChainDtpParams {
  name: string;
  oldDtp: string;
  newDtp: string;
  // Pull the new variant's description from its metadata (cosmetic). Default true.
  refreshDescription?: boolean;
  activate?: boolean;
  transportRequest?: string;
}

export interface AppendProcessChainDtpParams {
  name: string;
  dtp: string;
  // Optional aDSO to activate in an ADSOACT step appended right after the DTP.
  adsoact?: string;
  // Insert the whole block (DTP, plus the optional ADSOACT) IN SERIES ahead of this node:
  // the target's incoming edges are rerouted into the block, then the block links to the
  // target. This is what makes a DTP placeable in the middle of an existing chain.
  before?: string;
  // Insert the block IN SERIES behind this node: the target's outgoing edges are rerouted
  // to leave from the end of the block, so the block runs between the target and its
  // former successors.
  after?: string;
  // Used only when neither before nor after is given. Node to append behind: a DTP/variant
  // name, an aDSO held by an ADSOACT node, or the literal "strand_end_auto" (default).
  // NOTE this only APPENDS — the target keeps its existing successors, so the block ends
  // up parallel to them. Use before/after to place a block in series.
  predecessor?: string;
  // "both" (default): add a positive and a negative edge per link ("always continue");
  // "success_only": add only the positive edge.
  edgeMode?: 'both' | 'success_only';
  activate?: boolean;
  transportRequest?: string;
}

export interface AddProcessChainEdgeParams {
  name: string;
  // Source node reference (see resolveChainNodeRef for the accepted forms).
  from: string;
  // Target node reference.
  to: string;
  // Edge condition. Defaults to neutral out of the TRIGGER or a collector, positive otherwise.
  status?: EdgeStatus;
  // Branch condition for an edge leaving a DECISION node: the branch's EVENTNO
  // ("01" = THEN, "02" = ELSE). Defaults to "00" (a normal, non-branch edge).
  subStatus?: string;
  activate?: boolean;
  transportRequest?: string;
}

export interface RemoveProcessChainEdgeParams {
  name: string;
  from: string;
  to: string;
  // Restrict the removal to edges with this condition. Omit to remove every edge between
  // the two nodes (both the on-success and the on-error edge of an "always continue" link).
  status?: EdgeStatus;
  // Restrict the removal to this branch condition. Omit to ignore the branch condition.
  subStatus?: string;
  activate?: boolean;
  transportRequest?: string;
}

export interface RemoveProcessChainStepParams {
  name: string;
  // Node reference of the step to remove.
  step: string;
  // true (default): bridge the gap — every predecessor of the removed step takes over
  // every successor, so the strand stays connected. false: drop the step's edges without
  // bridging, which leaves its successors as a strand no longer reachable from the start.
  reconnect?: boolean;
  activate?: boolean;
  transportRequest?: string;
}

export interface AddProcessChainProgramParams {
  name: string;
  // ABAP program / report to execute (e.g. "REPORT_NAME"). Resolved via the cockpit
  // value help; stored in the inline variant's oDetail.PROGRAM.
  program: string;
  // Optional ABAP report (SE38) variant name (e.g. "VARIANT_NAME"). When given, it is
  // stored in oDetail.VARIANT so the report runs with that selection variant.
  variant?: string;
  // Step/node description (sVariantDescription). Cosmetic.
  description?: string;
  // Cosmetic value-help enrichment carried in the oDetail rows. Optional — the server
  // re-derives them from the program/variant when omitted.
  programPackage?: string;
  programDescription?: string;
  variantDescription?: string;
  // Call mode. true (default) → X_SYNCHRON; async is not verified, keep the default.
  synchronous?: boolean;
  // Call location. true (default) → X_LOCAL (run on this system).
  local?: boolean;
  // Insert BEFORE this node (its DTP/variant name, or an aDSO held by an ADSOACT node):
  // the target's incoming edges are rerouted through the new program step, then the new
  // step links to the target. Use this to run the program ahead of an existing step.
  before?: string;
  // Insert AFTER this node: the target's outgoing edges are rerouted to leave from the
  // new step instead, so the program runs between the target and its successors.
  after?: string;
  // When neither before nor after is set, append behind the strand end closest to the
  // trigger (same rule as bw_append_process_chain_dtp).
  predecessor?: string;
  // "both" (default): add a positive and a negative edge per new link ("always continue");
  // "success_only": add only the positive edge.
  edgeMode?: 'both' | 'success_only';
  activate?: boolean;
  transportRequest?: string;
}

// ── Low-level helpers ──────────────────────────────────────────────────────────

function writeHeaders(csrf: string): Record<string, string> {
  return {
    'Content-Type': JSON_CT,
    Accept: '*/*',
    'x-csrf-token': csrf,
    'X-Requested-With': 'XMLHttpRequest',
  };
}

// Force the client to discard its cached CSRF token so the next getCsrfToken()
// fetches a fresh one from the server. Needed because rawPost/rawPut don't null
// the token on completion, so the same token would be reused across all write
// steps of the flow even if the server has rotated it.
function refreshCsrf(client: BwClient): void {
  client.clearCsrfToken();
}

interface TransportHeaderResult {
  header: Record<string, string>;
  warning?: string;
}

// Resolve the transport-request header for a process-chain write (PUT).
// Calls validateobject with package:null so the server reports the object's real
// package and any assignable transport request(s). Returns
// { 'sap-bw4-transportRequest': <req> } for a transportable object, or {} for a
// $TMP (local) object — in which case the PUT stays byte-for-byte identical to
// before. Throws when several requests are available and none was chosen. The same
// CSRF token is used for validateobject and the subsequent PUT.
//
// The endpoint intermittently returns HTTP 404 ("No Suitable Resource Found") on the
// stateful bw4 v1 service when the MCP session has gone stale. This is retried once
// after re-priming the CSRF/session. If it still returns 404, we never PUT a
// transportable chain without a transport request (that yields HTTP 403): the call
// succeeds only when the caller supplied transport_request, otherwise it aborts.
async function resolveTransportHeader(
  client: BwClient,
  uri: string,
  csrf: string,
  chosenRequest?: string,
  // Package sent to validateobject. null (default) reads the object's existing package
  // (used for writes to an existing chain). For a create, pass the target package so the
  // server validates it and returns the assignable transport request(s).
  pkg: string | null = null
): Promise<TransportHeaderResult> {
  const debug = process.env.BW_DEBUG_SESSION === '1' || process.env.BW_DEBUG_SESSION === 'true';

  // Issue the validateobject POST with the given CSRF token. Around the call we log the
  // session cookie jar sent and the Set-Cookie returned (to stderr, gated by
  // BW_DEBUG_SESSION) so a failing sequence can be compared to a working one.
  const callValidate = async (token: string) => {
    if (debug) {
      console.error(`[bw-session] validateobject uri=${uri} outgoing cookies: ${JSON.stringify(client.sessionInfo())}`);
    }
    const res = await client.rawPost(
      VALIDATEOBJECT_PATH,
      JSON.stringify({ uri, package: pkg }),
      writeHeaders(token)
    );
    if (debug) {
      console.error(`[bw-session] validateobject uri=${uri} incoming Set-Cookie: ${JSON.stringify((res.headers as Record<string, unknown>)['set-cookie'] ?? null)}`);
    }
    return res;
  };

  // Fallback used when validateobject stays at HTTP 404 after the retry.
  // validateobject 404 is always a stale MCP session, not a transport/object/CSRF
  // problem (verified: a valid session returns 200, a $TMP or unknown object returns
  // 200, a bad CSRF returns 403). A transportable chain must never be PUT without a
  // transport request — that yields HTTP 403 "system settings do not allow changes".
  // So only proceed when the caller supplied a request; otherwise abort.
  const fallbackOn404 = (): TransportHeaderResult => {
    if (chosenRequest) {
      // A caller-supplied request lets a transportable write still record correctly.
      return {
        header: { 'sap-bw4-transportRequest': chosenRequest.toUpperCase() },
        warning: `validateobject returned HTTP 404 twice; proceeding with the supplied transport_request '${chosenRequest.toUpperCase()}'.`,
      };
    }
    // A validateobject 404 is a stale stateful-session artifact, not a real transport/object
    // problem: in a healthy session the same call returns 200 (verified — e.g. a $TMP chain
    // reports package "$TMP", requests:[]). It typically appears only AFTER an earlier write
    // in the same session has rolled the ICF session (the first write of a session succeeds,
    // the next one 404s here). Aborting therefore wrongly blocked follow-up writes to local
    // ($TMP) chains, which need no transport at all. Instead proceed WITHOUT a transport
    // header (same soft handling as bw_create_process_chain's pre-check): a $TMP object then
    // saves fine, and a genuinely transportable object is still refused by the PUT with
    // HTTP 403 ("system settings do not allow changes"), which the caller surfaces — at which
    // point transport_request must be supplied.
    return {
      header: {},
      warning:
        `Transport check (validateobject) returned HTTP 404 (stale MCP session); proceeded ` +
        `without a transport header. If the write fails with HTTP 403 the object is ` +
        `transportable — retry with transport_request.`,
    };
  };

  let vo: { body: string; headers: Record<string, string> };
  try {
    vo = await callValidate(csrf);
  } catch (err: any) {
    // An HTTP 404 ("No Suitable Resource Found") from validateobject is a transient
    // stateful-session error (a stale/rolled-out ICF session cookie), not a problem with
    // the object URI, the transport state, or the CSRF token. Re-prime the session by
    // clearing and re-fetching the CSRF token (which re-establishes the ICF session
    // cookie), then retry the POST exactly once. Any other status is a genuine error and
    // is NOT retried.
    if (!/HTTP 404/.test(err.message)) {
      throw new Error(`Transport check (validateobject): ${err.message}`);
    }
    if (debug) {
      console.error(`[bw-session] validateobject uri=${uri} → HTTP 404; clearing CSRF and retrying once`);
    }
    refreshCsrf(client);
    const freshCsrf = await client.getCsrfToken();
    try {
      vo = await callValidate(freshCsrf);
    } catch (retryErr: any) {
      if (!/HTTP 404/.test(retryErr.message)) {
        throw new Error(`Transport check (validateobject): ${retryErr.message}`);
      }
      // Still 404 after the retry — fall through (non-fatal), do not block the PUT.
      if (debug) {
        console.error(`[bw-session] validateobject uri=${uri} → HTTP 404 again; proceeding with fallback`);
      }
      return fallbackOn404();
    }
  }

  const data = JSON.parse(vo.body);
  // For a create (pkg set), trust the requested package even if the server echoes a
  // different/empty value for a not-yet-existing object; for a read (pkg null) use the
  // object's real package as reported.
  const effectivePackage = pkg !== null ? pkg : data.package;
  const isTmp = !effectivePackage || effectivePackage === '$TMP';
  const requests: Array<{ request: string }> = Array.isArray(data.requests) ? data.requests : [];
  if (isTmp) return { header: {} };
  if (requests.length === 0 && !chosenRequest) {
    throw new Error(
      `Object targets transportable package '${effectivePackage}' but validateobject returned ` +
      `no assignable transport request. Pass transport_request (an open, changeable request).`
    );
  }
  let req = chosenRequest?.toUpperCase();
  if (!req) {
    if (requests.length === 1) {
      req = requests[0].request;
    } else {
      throw new Error(
        `Object is in package '${data.package}' and multiple transport requests are available ` +
        `(${requests.map((r) => r.request).join(', ')}). Pass transport_request to choose one.`
      );
    }
  }
  return { header: { 'sap-bw4-transportRequest': req } };
}

function buildNode(step: Step, inlineKeyMap: Map<string, string>): object {
  if (step.type === 'DTP_LOAD') {
    const s = step as StepDtpLoad;
    return {
      sProcessType: 'DTP_LOAD',
      bIsReference: true,
      sProcessVariant: s.dtp,
      sVariantDescription: s.description ?? '',
      iAutoRepeatWaitDuration: 0,
    };
  }
  if (step.type === 'ADSOACT') {
    return {
      sProcessType: 'ADSOACT',
      bIsReference: false,
      sProcessVariant: inlineKeyMap.get(step.id)!,
      iAutoRepeatWaitDuration: 0,
    };
  }
  if (step.type === 'ADSOREM') {
    return {
      sProcessType: 'ADSOREM',
      bIsReference: false,
      sProcessVariant: inlineKeyMap.get(step.id)!,
      iAutoRepeatWaitDuration: 0,
    };
  }
  if (step.type === 'ABAP') {
    // The program call lives in an inline variant, so the node only carries the key that
    // buildModelParts assigned; buildAbapProgramVariant builds both halves.
    return buildAbapProgramVariant(inlineKeyMap.get(step.id)!, step as StepAbap).node;
  }
  if (COLLECTORS.has(step.type)) {
    return { sProcessType: step.type };
  }
  if (step.type === 'DECISION') {
    const d = step as StepDecision;
    return {
      sProcessType: 'DECISION',
      bIsReference: true,
      sProcessVariant: d.variant,
      sVariantDescription: d.description ?? '',
      iAutoRepeatWaitDuration: 0,
    };
  }
  const g = step as StepGeneric;
  return {
    sProcessType: g.type,
    bIsReference: true,
    sProcessVariant: g.object,
    sVariantDescription: g.description ?? '',
    iAutoRepeatWaitDuration: 0,
  };
}

function buildAdsoActVariant(step: StepAdsoAct, inlineKeyMap: Map<string, string>): object {
  return {
    sProcessVariant: inlineKeyMap.get(step.id)!,
    sVariantDescription: '',
    oDetail: {
      sId: '',
      DATASTORES: step.datastores.map((ds) => ({ DATASTORE: ds, DESCRIPTION: '', HOTCOLDFLAG: '' })),
      NOCONDENSE: step.requestsSequential ?? false,
      NOREQACTWARN: step.errorOnNonActivation ?? false,
    },
    aSocket: [],
  };
}

// Build the inline variant for an ADSOREM ("Delete Requests from DataStore Object") step.
// oDetail shape traced from a cockpit-saved variant: a DATASTORES array, one entry per aDSO,
// each carrying its cleanup ACTION plus the request-selection options. The read-back
// "DATASTORE.valueContext" enrichment is server-side only and is not sent on write.
function buildAdsoRemVariant(step: StepAdsoRem, inlineKeyMap: Map<string, string>): object {
  return {
    sProcessVariant: inlineKeyMap.get(step.id)!,
    sVariantDescription: '',
    oDetail: {
      DATASTORES: step.remDatastores.map((d) => ({
        DATASTORE: d.datastore,
        ACTION: d.action,
        ALL_REQUESTS: d.allRequests ?? false,
        NUMBER_REQUESTS: d.numberRequests ?? 0,
        NUMBER_DAYS: d.numberDays ?? 0,
        PACKAGE_SIZE: d.packageSize ?? 0,
      })),
    },
    aSocket: [],
  };
}

// Build the trigger variant oDetail. Without an event config this is the default
// immediate/periodic detail (startdttyp:"I"). With one, it is an event start-condition
// (startdttyp:"E") as persisted by the cockpit (see the reference chain trigger).
function buildTriggerDetail(event: TriggerEventConfig | undefined, chainName: string): object {
  if (!event) return TRIGGER_SCHEDULE_DETAIL;
  return {
    startdttyp: 'E',
    sdlstrttimestamp: '',
    maximumDelay: 0,
    tmzone: '',
    recurrencyPattern: '',
    prdmins: 0,
    prdhours: 0,
    prddays: 0,
    prdweeks: 0,
    prdmonths: 0,
    prdbehav: '',
    calendarid: '',
    eventtype: event.eventType ?? 'OtherEvent',
    eventid: [
      {
        key: event.eventId,
        text: event.eventId,
        row: { eventId: event.eventId, description: event.eventId },
      },
    ],
    eventparm: event.eventParameter ?? chainName,
    operationMode: '',
    onlyOnce: event.onlyOnce ?? false,
    wdCalendarid: '',
    wdayno: 0,
    wdaycdir: '',
    wdPrdmonths: 0,
    wdSystemtimezone: '',
    sdlstrttm: '',
    notbefore: '',
  };
}

// Rebuild an event start-condition from an existing trigger oDetail (read back from the
// server). Used on update to preserve an event trigger when the caller passes no new
// event config, without echoing the server's raw oDetail verbatim (which can cause an
// HTTP 500 on topology change).
function eventConfigFromDetail(detail: any): TriggerEventConfig | undefined {
  if (!detail || detail.startdttyp !== 'E') return undefined;
  const ev = Array.isArray(detail.eventid) ? detail.eventid[0] : undefined;
  const eventId = ev?.key ?? ev?.row?.eventId;
  if (!eventId) return undefined;
  return {
    eventId,
    eventParameter: detail.eventparm ?? '',
    eventType: detail.eventtype ?? 'OtherEvent',
    onlyOnce: detail.onlyOnce ?? false,
  };
}

function defaultEdgeStatus(fromId: string, nodeTypeMap: Map<string, string>): string {
  const fromType = nodeTypeMap.get(fromId);
  if (fromType === 'TRIGGER' || (fromType !== undefined && COLLECTORS.has(fromType))) {
    return 'neutral';
  }
  return 'positive';
}

function parseActivateResponse(body: string): {
  success: boolean;
  message: string;
  severity: string;
  log: Array<{ severity: string; message: string }>;
  errors: Array<{ severity: string; message: string }>;
} {
  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    return { success: false, message: body, severity: 'error', log: [], errors: [] };
  }
  const msg = data.message ?? {};
  const log: Array<{ severity: string; message: string }> = (data.log ?? []).map((e: any) => ({
    severity: String(e.severity ?? ''),
    message: String(e.message ?? ''),
  }));
  const errors = log.filter((e) => e.severity === 'error');
  const severity = String(msg.severity ?? '');
  // Success when nothing was logged as an error and the top-level severity is not an
  // error. Some activations report "success", others "information" (e.g. decision
  // variants report "... wurde aktiviert" / "... ist konsistent" as information) — both
  // are successful, so keying strictly on "success" produced false negatives.
  return {
    success: errors.length === 0 && severity !== 'error',
    message: String(msg.message ?? ''),
    severity,
    log,
    errors,
  };
}

// ── Chain topology helpers ─────────────────────────────────────────────────────
//
// Pure functions over the server's own chain model ({ aNode, aEdge, aInlineVariant }),
// shared by every in-place edit tool. Edges are INDEX-based (iNodeIndexFrom /
// iNodeIndexTo point into aNode), which is what makes node removal delicate: dropping a
// node shifts every later index, so all surviving edge endpoints have to follow.

// Human-readable label for a chain node, used in results and error messages so a caller
// can tell two same-typed nodes apart without re-reading the chain.
export function chainNodeLabel(model: any, index: number): string {
  const node = (model.aNode ?? [])[index];
  if (!node) return `#${index}`;
  const type = String(node.sProcessType ?? '?').toUpperCase();
  const detail = (model.aInlineVariant ?? []).find(
    (v: any) => v.sProcessVariant === node.sProcessVariant
  )?.oDetail;
  if (type === 'ABAP') {
    const prog = detail?.PROGRAM?.[0]?.key ?? '';
    const va = detail?.VARIANT?.[0]?.key ?? '';
    return `#${index} ABAP ${prog}${va ? `/${va}` : ''}`.trimEnd();
  }
  if (type === 'ADSOACT' || type === 'ADSOREM') {
    const ds = (detail?.DATASTORES ?? []).map((d: any) => d.DATASTORE).filter(Boolean).join(',');
    return `#${index} ${type}${ds ? ` ${ds}` : ''}`;
  }
  if (type === 'TRIGGER' || COLLECTOR_TYPES.has(type)) return `#${index} ${type}`;
  return `#${index} ${type} ${node.sProcessVariant ?? ''}`.trimEnd();
}

// The (uppercase) names a node answers to when referenced by a tool parameter.
function chainNodeAliases(model: any, index: number): string[] {
  const node = (model.aNode ?? [])[index];
  if (!node) return [];
  const type = String(node.sProcessType ?? '').toUpperCase();
  const detail = (model.aInlineVariant ?? []).find(
    (v: any) => v.sProcessVariant === node.sProcessVariant
  )?.oDetail;
  const aliases: string[] = [];
  if (node.sProcessVariant) aliases.push(String(node.sProcessVariant).toUpperCase());
  if (type === 'TRIGGER' || COLLECTOR_TYPES.has(type)) aliases.push(type);
  if (type === 'ADSOACT' || type === 'ADSOREM') {
    for (const d of detail?.DATASTORES ?? []) {
      if (d.DATASTORE) aliases.push(String(d.DATASTORE).toUpperCase());
    }
  }
  if (type === 'ABAP') {
    const prog = detail?.PROGRAM?.[0]?.key;
    const va = detail?.VARIANT?.[0]?.key;
    if (prog) {
      aliases.push(String(prog).toUpperCase());
      // A program used more than once in the chain is only unambiguous together with its
      // selection variant, so accept the "PROGRAM/VARIANT" form too.
      if (va) aliases.push(`${String(prog).toUpperCase()}/${String(va).toUpperCase()}`);
    }
  }
  return aliases;
}

// Resolve a caller-supplied node reference to a node index. Accepted forms:
//   "#3"                    → node index 3 (always unambiguous; indices match the
//                             "[n]" numbers printed by bw_get_process_chain)
//   "TRIGGER" / "OR" / ...  → the trigger, or a collector by its type
//   "DTP_NAME"              → a node's own process variant
//   "ADSO_NAME"             → an aDSO held by an ADSOACT / ADSOREM node
//   "REPORT_NAME"           → the program of an ABAP step
//   "REPORT_NAME/VARIANT"   → that program with a specific SE38 variant
// Throws with the full node list when nothing matches, and names the candidates when the
// reference is ambiguous — an ambiguous reference must never silently pick one node.
export function resolveChainNodeRef(model: any, ref: string, role = 'node'): number {
  const nodes: any[] = model.aNode ?? [];
  const raw = String(ref ?? '').trim();
  if (!raw) throw new Error(`Empty ${role} reference.`);

  const nodeList = () => nodes.map((_n, i) => chainNodeLabel(model, i)).join('; ');

  if (/^#\d+$/.test(raw)) {
    const i = Number(raw.slice(1));
    if (!nodes[i]) {
      throw new Error(`${role} reference '${raw}': no node at that index (chain has ${nodes.length} nodes: ${nodeList()}).`);
    }
    return i;
  }

  const u = raw.toUpperCase();
  const hits = nodes.map((_n, i) => i).filter((i) => chainNodeAliases(model, i).includes(u));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new Error(
      `${role} reference '${ref}' is ambiguous — it matches ${hits.map((i) => chainNodeLabel(model, i)).join(', ')}. ` +
      `Pass "#<index>" to pick one.`
    );
  }
  throw new Error(`${role} reference '${ref}' matches no node in the chain. Nodes: ${nodeList()}.`);
}

// Edge condition a new link out of `fromIdx` gets when the caller picks none: neutral out
// of the TRIGGER or a collector (neither can succeed or fail), positive everywhere else.
export function defaultStatusForNode(model: any, fromIdx: number): EdgeStatus {
  const type = String((model.aNode ?? [])[fromIdx]?.sProcessType ?? '').toUpperCase();
  return type === 'TRIGGER' || COLLECTOR_TYPES.has(type) ? 'neutral' : 'positive';
}

// Add one edge unless an identical one already exists. Returns the edge as stored, or
// null when it was already present (so the caller can report an idempotent no-op).
export function addChainEdge(
  model: any,
  fromIdx: number,
  toIdx: number,
  status?: EdgeStatus,
  subStatus = '00'
): { iNodeIndexFrom: number; iNodeIndexTo: number; sStatus: string; sSubStatus: string } | null {
  const edges: any[] = model.aEdge ?? (model.aEdge = []);
  if (fromIdx === toIdx) {
    throw new Error(`Cannot link ${chainNodeLabel(model, fromIdx)} to itself.`);
  }
  // A branch edge (a sub-status other than "00") is always positive — the branch condition
  // itself already decides, so an on-error branch edge has no meaning in RSPC.
  const effective = status ?? (subStatus !== '00' ? 'positive' : defaultStatusForNode(model, fromIdx));
  const exists = edges.some(
    (e) =>
      e.iNodeIndexFrom === fromIdx &&
      e.iNodeIndexTo === toIdx &&
      e.sStatus === effective &&
      (e.sSubStatus ?? '00') === subStatus
  );
  if (exists) return null;
  const edge = { iNodeIndexFrom: fromIdx, iNodeIndexTo: toIdx, sStatus: effective, sSubStatus: subStatus };
  edges.push(edge);
  return edge;
}

// Remove the edges between two nodes. status / subStatus narrow the match; omitting both
// removes every edge of the pair (which is what an "always continue" link needs, since it
// is stored as two edges — one positive, one negative). Returns the removed edges.
export function removeChainEdges(
  model: any,
  fromIdx: number,
  toIdx: number,
  status?: EdgeStatus,
  subStatus?: string
): any[] {
  const edges: any[] = model.aEdge ?? (model.aEdge = []);
  const matches = (e: any) =>
    e.iNodeIndexFrom === fromIdx &&
    e.iNodeIndexTo === toIdx &&
    (status === undefined || e.sStatus === status) &&
    (subStatus === undefined || (e.sSubStatus ?? '00') === subStatus);
  const removed = edges.filter(matches);
  model.aEdge = edges.filter((e) => !matches(e));
  return removed;
}

export interface RemoveStepResult {
  removedLabel: string;
  edgesRemoved: number;
  edgesReconnected: number;
  inlineVariantRemoved: string | null;
}

// Remove one step from the chain. Every edge touching it goes; with `reconnect` each
// predecessor takes over each successor so the strand stays in one piece. The bridging
// edge keeps the condition of the edge that ran INTO the removed step, because that is the
// edge whose source still decides (a DECISION branch into the removed step therefore stays
// a branch edge to its successor).
export function removeChainStep(model: any, idx: number, reconnect = true): RemoveStepResult {
  const nodes: any[] = model.aNode ?? (model.aNode = []);
  const edges: any[] = model.aEdge ?? (model.aEdge = []);
  const node = nodes[idx];
  if (!node) throw new Error(`No node at index ${idx}.`);
  if (String(node.sProcessType ?? '').toUpperCase() === 'TRIGGER') {
    throw new Error('The TRIGGER (Start) node cannot be removed — a chain always needs exactly one.');
  }

  const removedLabel = chainNodeLabel(model, idx);
  const incoming = edges.filter((e) => e.iNodeIndexTo === idx && e.iNodeIndexFrom !== idx);
  const outgoing = edges.filter((e) => e.iNodeIndexFrom === idx && e.iNodeIndexTo !== idx);
  const kept = edges.filter((e) => e.iNodeIndexFrom !== idx && e.iNodeIndexTo !== idx);
  const edgesRemoved = edges.length - kept.length;

  let edgesReconnected = 0;
  if (reconnect) {
    for (const inE of incoming) {
      for (const outE of outgoing) {
        if (inE.iNodeIndexFrom === outE.iNodeIndexTo) continue;
        const bridge = {
          iNodeIndexFrom: inE.iNodeIndexFrom,
          iNodeIndexTo: outE.iNodeIndexTo,
          sStatus: inE.sStatus,
          sSubStatus: inE.sSubStatus ?? '00',
        };
        const dup = kept.some(
          (e) =>
            e.iNodeIndexFrom === bridge.iNodeIndexFrom &&
            e.iNodeIndexTo === bridge.iNodeIndexTo &&
            e.sStatus === bridge.sStatus &&
            (e.sSubStatus ?? '00') === bridge.sSubStatus
        );
        if (!dup) {
          kept.push(bridge);
          edgesReconnected++;
        }
      }
    }
  }

  const shift = (i: number) => (i > idx ? i - 1 : i);
  for (const e of kept) {
    e.iNodeIndexFrom = shift(e.iNodeIndexFrom);
    e.iNodeIndexTo = shift(e.iNodeIndexTo);
  }

  nodes.splice(idx, 1);
  model.aEdge = kept;

  // Drop the step's inline variant, unless it is an object reference (shared, not owned by
  // the node) or another surviving node still points at the same key.
  let inlineVariantRemoved: string | null = null;
  const key = node.sProcessVariant;
  if (node.bIsReference === false && key && !nodes.some((n) => n.sProcessVariant === key)) {
    const variants: any[] = model.aInlineVariant ?? [];
    const remaining = variants.filter((v) => v.sProcessVariant !== key);
    if (remaining.length < variants.length) {
      model.aInlineVariant = remaining;
      inlineVariantRemoved = key;
    }
  }

  return { removedLabel, edgesRemoved, edgesReconnected, inlineVariantRemoved };
}

// Wire a freshly appended block of nodes into the chain IN SERIES.
//   before: every edge that pointed at the target now points at the block entry, then the
//           block exit links to the target  → pred → BLOCK → target
//   after:  every edge leaving the target now leaves from the block exit, then the target
//           links to the block entry        → target → BLOCK → former successors
// Rerouted edges keep their own condition and branch condition, so a neutral edge out of
// the trigger and a DECISION branch edge both survive the move. `link` draws the new edges
// and owns the edge_mode decision (on-success only, or on-success plus on-error).
export function spliceBlockInSeries(
  model: any,
  blockIndices: number[],
  mode: 'before' | 'after',
  targetIdx: number,
  link: (from: number, to: number) => void
): void {
  const edges: any[] = model.aEdge ?? (model.aEdge = []);
  const entry = blockIndices[0];
  const exit = blockIndices[blockIndices.length - 1];
  const inBlock = new Set(blockIndices);
  if (inBlock.has(targetIdx)) {
    throw new Error('The insertion target cannot be part of the inserted block.');
  }

  if (mode === 'before') {
    let rerouted = 0;
    for (const e of edges) {
      if (e.iNodeIndexTo === targetIdx && !inBlock.has(e.iNodeIndexFrom)) {
        e.iNodeIndexTo = entry;
        rerouted++;
      }
    }
    if (rerouted === 0) {
      throw new Error(
        `'before' target ${chainNodeLabel(model, targetIdx)} has no incoming edge to reroute — ` +
        `nothing can be inserted ahead of a node that nothing leads to.`
      );
    }
    link(exit, targetIdx);
    return;
  }

  for (const e of edges) {
    if (e.iNodeIndexFrom === targetIdx && !inBlock.has(e.iNodeIndexTo)) {
      e.iNodeIndexFrom = exit;
    }
  }
  link(targetIdx, entry);
}

// ── buildModelParts ────────────────────────────────────────────────────────────
//
// Builds the non-trigger part of the model from the high-level step/edge input.
// Step nodes occupy indices 1..n; index 0 is always the trigger (added by caller).
// Returns nodes (without the trigger), edges (already index-based, TRIGGER = 0),
// and the inline variants belonging to the step nodes (without the trigger variant).

function buildModelParts(
  steps: Step[],
  edges: EdgeDef[]
): { stepNodes: object[]; aEdge: object[]; stepInlineVariants: object[] } {
  // node index map: TRIGGER=0, each step id → 1-based position
  const nodeIndexMap = new Map<string, number>([['TRIGGER', 0]]);
  steps.forEach((step, i) => nodeIndexMap.set(step.id, i + 1));

  // node type map for edge default-status calculation
  const nodeTypeMap = new Map<string, string>([['TRIGGER', 'TRIGGER']]);
  steps.forEach((step) => nodeTypeMap.set(step.id, step.type));

  // assign INLINE_n keys to inline-configured nodes (ADSOACT, ADSOREM, ABAP); trigger owns
  // INLINE_0. These are placeholders — the server rewrites them to generated ILV_ keys on save.
  let inlineCounter = 1;
  const inlineKeyMap = new Map<string, string>();
  for (const step of steps) {
    if (INLINE_STEP_TYPES.has(step.type)) {
      inlineKeyMap.set(step.id, `INLINE_${inlineCounter++}`);
    }
  }

  // validate edge endpoint ids
  for (const edge of edges) {
    if (!nodeIndexMap.has(edge.from)) {
      throw new Error(`Edge 'from' id '${edge.from}' is not a defined step id or "TRIGGER"`);
    }
    if (!nodeIndexMap.has(edge.to)) {
      throw new Error(`Edge 'to' id '${edge.to}' is not a defined step id or "TRIGGER"`);
    }
  }

  const stepNodes = steps.map((s) => buildNode(s, inlineKeyMap));

  const aEdge = edges.map((e) => ({
    iNodeIndexFrom: nodeIndexMap.get(e.from)!,
    iNodeIndexTo: nodeIndexMap.get(e.to)!,
    // A branch edge (subStatus other than "00") carries the DECISION branch's EVENTNO
    // and is always "positive"; other edges use the caller/default status.
    sStatus: e.status ?? (e.subStatus && e.subStatus !== '00' ? 'positive' : defaultEdgeStatus(e.from, nodeTypeMap)),
    sSubStatus: e.subStatus ?? '00',
  }));

  const stepInlineVariants = steps
    .filter((s) => INLINE_STEP_TYPES.has(s.type))
    .map((s) => {
      if (s.type === 'ADSOACT') return buildAdsoActVariant(s as StepAdsoAct, inlineKeyMap);
      if (s.type === 'ADSOREM') return buildAdsoRemVariant(s as StepAdsoRem, inlineKeyMap);
      return buildAbapProgramVariant(inlineKeyMap.get(s.id)!, s as StepAbap).inlineVariant;
    });

  return { stepNodes, aEdge, stepInlineVariants };
}

// helper: activate a chain and return the parsed result
async function activateChain(
  client: BwClient,
  nameLc: string
): Promise<ReturnType<typeof parseActivateResponse>> {
  refreshCsrf(client);
  const csrf = await client.getCsrfToken();
  const res = await client
    .rawPost(`${BASE}/${nameLc}/activate`, '', writeHeaders(csrf))
    .catch((err: Error) => {
      throw new Error(`Activate chain: ${err.message}`);
    });
  refreshCsrf(client);
  return parseActivateResponse(res.body);
}

// helper: attach activation fields to a result object
function attachActivation(
  result: Record<string, unknown>,
  activation: ReturnType<typeof parseActivateResponse>
): void {
  result.activation = {
    success: activation.success,
    message: activation.message,
    severity: activation.severity,
    log: activation.log,
  };
  if (activation.errors.length > 0) {
    result.activationErrors = activation.errors;
  }
}

// ── Shared in-place edit cycle ─────────────────────────────────────────────────
//
// GET the server's own model (for the ETag), let `mutate` edit it, PUT it back with the
// transport header, then optionally activate. Editing the server's model rather than
// rebuilding it from high-level input is what keeps step types the tool does not model
// (inline variants, notifications, repeat settings) intact.
//
// `mutate` reports the fields to include in the result. Returning a skipReason skips the
// PUT entirely, which is how the tools stay idempotent.

interface ChainEditOutcome {
  report: Record<string, unknown>;
  skipReason?: string;
}

async function editChainModel(
  client: BwClient,
  name: string,
  mutate: (model: any) => ChainEditOutcome,
  opts: { activate?: boolean; transportRequest?: string } = {}
): Promise<{ result: Record<string, unknown>; model: any; skipped: boolean }> {
  const { activate = false, transportRequest } = opts;
  const nameLc = name.toLowerCase();

  let etag: string;
  let model: any;
  try {
    const got = await client.rawGet(`${BASE}/${nameLc}`, { Accept: JSON_CT });
    etag = got.headers['etag'] as string;
    if (!etag) throw new Error('No ETag returned by GET');
    const root = JSON.parse(got.body);
    // The GET body may wrap the model as { model: ... } or be the bare model;
    // the PUT body must always be the bare model object.
    model = root.model ?? root;
  } catch (err: any) {
    throw new Error(`GET chain '${name}': ${err.message}`);
  }

  model.aNode = model.aNode ?? [];
  model.aEdge = model.aEdge ?? [];
  model.aInlineVariant = model.aInlineVariant ?? [];

  const { report, skipReason } = mutate(model);
  if (skipReason) {
    return { result: { chain: name, skipped: true, reason: skipReason, ...report }, model, skipped: true };
  }

  const csrf = await client.getCsrfToken();
  const { header: transportHeader, warning: transportWarning } =
    await resolveTransportHeader(client, `${BASE}/${nameLc}`, csrf, transportRequest);
  // resolveTransportHeader may have refreshed the CSRF token (on a 404 retry); use the
  // current token for the PUT so it never goes out with a stale token.
  const putCsrf = await client.getCsrfToken();
  await client
    .rawPut(`${BASE}/${nameLc}`, JSON.stringify(model), {
      'Content-Type': JSON_CT,
      Accept: '*/*',
      'x-csrf-token': putCsrf,
      'If-Match': etag,
      'X-Requested-With': 'XMLHttpRequest',
      ...transportHeader,
    })
    .catch((err: Error) => {
      const stale = err.message.includes('HTTP 412');
      throw new Error(
        stale
          ? `PUT model failed: ETag is stale (412 Precondition Failed) — the chain was modified between the GET and PUT. Re-read and retry. ${err.message}`
          : `PUT edited model: ${err.message}`
      );
    });
  refreshCsrf(client);

  const result: Record<string, unknown> = {
    chain: name,
    ...report,
    nodes: model.aNode.length,
    edges: model.aEdge.length,
    activated: activate,
  };
  if (transportWarning) result.transportWarning = transportWarning;
  if (activate) {
    attachActivation(result, await activateChain(client, nameLc));
  }
  return { result, model, skipped: false };
}

// ── bw_create_process_chain ────────────────────────────────────────────────────

export async function bwCreateProcessChain(
  client: BwClient,
  params: CreateProcessChainParams
): Promise<string> {
  const { name, infoarea, description, steps, edges, activate = false, triggerEvent } = params;
  const nameLc = name.toLowerCase();

  const { stepNodes, aEdge, stepInlineVariants } = buildModelParts(steps, edges);

  const oHeaderCreate = {
    sLocation: infoarea,
    sDescription: description,
    oSchedulingAttributes: { bTenantSpecific: false, sJobPriority: 'C', bStreaming: false },
    oMonitoringAttributes: {
      bAutoMonitored: false,
      bAutoResetFailures: false,
      bErrorNotification: false,
      bKeepAlive: false,
      bLocalFailuresAsSuccess: false,
    },
  };

  // ── Step 1: Transport check before create ──────────────────────────────────
  // 404 is treated as a soft failure: the endpoint exists but its content-negotiation
  // did not match (known intermittent SAP behaviour). Transport rules are still
  // enforced by the actual POST in Step 2, so we warn and continue rather than abort.
  let transportWarning: string | undefined;
  const csrf1 = await client.getCsrfToken();
  await client
    .rawPost(
      '/sap/bc/http/sap/bw4/v1/modeling/transports/validateobject',
      JSON.stringify({ uri: `${BASE}/${nameLc}`, package: '$TMP' }),
      writeHeaders(csrf1)
    )
    .catch((err: Error) => {
      if (/HTTP 404/.test(err.message)) {
        transportWarning = 'Transport pre-check returned 404 (validateobject); transport rules still apply on save.';
      } else {
        throw new Error(`Transport check (create): ${err.message}`);
      }
    });
  refreshCsrf(client);

  // ── Step 2: Create chain with trigger-only skeleton ────────────────────────
  const csrf2 = await client.getCsrfToken();
  await client
    .rawPost(
      BASE,
      JSON.stringify({
        name,
        model: {
          aNode: [{ sProcessType: 'TRIGGER', bIsReference: false, sProcessVariant: 'INLINE_0' }],
          aEdge: [],
          aInlineVariant: [{ sProcessVariant: 'INLINE_0', oDetail: {}, aSocket: [] }],
          oHeader: oHeaderCreate,
        },
      }),
      writeHeaders(csrf2)
    )
    .catch((err: Error) => {
      throw new Error(`Create chain: ${err.message}`);
    });
  refreshCsrf(client);

  // ── Step 3: GET chain for ETag and server-assigned trigger variant key ─────
  let etag: string;
  let triggerVariantKey: string;
  try {
    const got = await client.rawGet(`${BASE}/${nameLc}`, { Accept: JSON_CT });
    etag = got.headers['etag'] as string;
    if (!etag) throw new Error('No ETag returned by GET after create');
    const getBody = JSON.parse(got.body);
    triggerVariantKey = getBody?.model?.aNode?.[0]?.sProcessVariant ?? 'INLINE_0';
  } catch (err: any) {
    throw new Error(`GET chain for ETag: ${err.message}`);
  }
  refreshCsrf(client);

  // ── Step 4: PUT full model ────────────────────────────────────────────────
  const fullModel = {
    aNode: [
      { sProcessType: 'TRIGGER', bIsReference: false, sProcessVariant: triggerVariantKey },
      ...stepNodes,
    ],
    aEdge,
    aInlineVariant: [
      { sProcessVariant: triggerVariantKey, sVariantDescription: '', oDetail: buildTriggerDetail(triggerEvent, name), aSocket: [] },
      ...stepInlineVariants,
    ],
    oHeader: {
      sProcessChainId: name,
      sLocation: infoarea,
      sDescription: description,
      sObjectVersion: 'modified',
      sObjectStatus: 'active',
      bActive: true,
      oSchedulingAttributes: { sExecutionServer: '', sServerType: '', bTenantSpecific: false, sJobPriority: 'C', bStreaming: false },
      oMonitoringAttributes: { bKeepAlive: false, bAutoMonitored: false, bErrorNotification: false, bLocalFailuresAsSuccess: false, bAutoResetFailures: false },
    },
  };

  const csrf4 = await client.getCsrfToken();
  await client
    .rawPut(`${BASE}/${nameLc}`, JSON.stringify(fullModel), {
      'Content-Type': JSON_CT,
      Accept: '*/*',
      'x-csrf-token': csrf4,
      'If-Match': etag,
      'X-Requested-With': 'XMLHttpRequest',
    })
    .catch((err: Error) => {
      throw new Error(`PUT full model: ${err.message}`);
    });
  refreshCsrf(client);

  // ── Step 6: Optional activation ───────────────────────────────────────────
  const result: Record<string, unknown> = {
    chain: name,
    nodes: 1 + stepNodes.length,
    edges: aEdge.length,
    activated: activate,
  };
  if (transportWarning) result.transportWarning = transportWarning;
  if (activate) {
    attachActivation(result, await activateChain(client, nameLc));
  }
  return JSON.stringify(result, null, 2);
}

// ── bw_update_process_chain ────────────────────────────────────────────────────

export async function bwUpdateProcessChain(
  client: BwClient,
  params: UpdateProcessChainParams
): Promise<string> {
  const { name, description, infoarea, steps, edges, activate = false, transportRequest, triggerEvent } = params;
  const nameLc = name.toLowerCase();

  const { stepNodes, aEdge, stepInlineVariants } = buildModelParts(steps, edges);

  // ── Step 1: GET current chain for ETag and existing trigger/header ─────────
  let etag: string;
  let triggerNode: any;
  let triggerVariantKey: string;
  let triggerVariant: any;
  let currentHeader: any;
  try {
    const got = await client.rawGet(`${BASE}/${nameLc}`, { Accept: JSON_CT });
    etag = got.headers['etag'] as string;
    if (!etag) throw new Error('No ETag returned by GET');
    const current = JSON.parse(got.body);
    const model = current.model ?? current;
    const rawTrigger = (model.aNode ?? []).find((n: any) => n.sProcessType === 'TRIGGER');
    if (!rawTrigger) throw new Error('GET response contains no TRIGGER node (unexpected format)');
    triggerVariantKey = rawTrigger.sProcessVariant;
    // Reconstruct trigger node with minimal fields — using the raw server node
    // causes RSPC020 ("no starter") when changing from sequential to parallel topology.
    triggerNode = { sProcessType: 'TRIGGER', bIsReference: false, sProcessVariant: triggerVariantKey };
    // Always reconstruct the trigger variant fresh — using the server's oDetail verbatim
    // causes HTTP 500 (ABAP offset error) on PUT when the chain topology changes. When the
    // caller passes no new event config, preserve an existing event start-condition by
    // rebuilding it cleanly from the current oDetail; otherwise fall back to immediate.
    const existingTriggerVariant = (model.aInlineVariant ?? []).find(
      (v: any) => v.sProcessVariant === triggerVariantKey
    );
    const effectiveEvent = triggerEvent ?? eventConfigFromDetail(existingTriggerVariant?.oDetail);
    triggerVariant = {
      sProcessVariant: triggerVariantKey,
      sVariantDescription: '',
      oDetail: buildTriggerDetail(effectiveEvent, name),
      aSocket: [],
    };
    currentHeader = model.oHeader ?? {};
  } catch (err: any) {
    throw new Error(`GET chain '${name}': ${err.message}`);
  }

  // ── Step 2: Assemble the full replacement model ────────────────────────────
  const fullModel = {
    aNode: [triggerNode, ...stepNodes],
    aEdge,
    aInlineVariant: [triggerVariant, ...stepInlineVariants].filter(Boolean),
    oHeader: {
      ...currentHeader,
      sDescription: description ?? currentHeader.sDescription,
      sLocation: infoarea ?? currentHeader.sLocation,
    },
  };

  // ── Step 3: PUT the full model with If-Match and the transport header ──────
  // resolveTransportHeader runs validateobject (package:null); a transportable
  // chain requires the sap-bw4-transportRequest header on the PUT, otherwise the
  // write is refused with HTTP 403 ("system settings do not allow changes ...
  // object type RSPC"). For a $TMP chain it returns {} → PUT unchanged.
  const csrf = await client.getCsrfToken();
  const { header: transportHeader, warning: transportWarning } =
    await resolveTransportHeader(client, `${BASE}/${nameLc}`, csrf, transportRequest);
  // resolveTransportHeader may have refreshed the CSRF token (on a 404 retry); use the
  // current token for the PUT so it never goes out with a stale token.
  const putCsrf = await client.getCsrfToken();
  await client
    .rawPut(`${BASE}/${nameLc}`, JSON.stringify(fullModel), {
      'Content-Type': JSON_CT,
      Accept: '*/*',
      'x-csrf-token': putCsrf,
      'If-Match': etag,
      'X-Requested-With': 'XMLHttpRequest',
      ...transportHeader,
    })
    .catch((err: Error) => {
      const stale = err.message.includes('HTTP 412');
      throw new Error(
        stale
          ? `PUT model failed: ETag is stale (412 Precondition Failed) — the chain was modified between the GET and PUT. Re-read and retry. ${err.message}`
          : `PUT full model: ${err.message}`
      );
    });
  refreshCsrf(client);

  // ── Step 4: Optional activation ───────────────────────────────────────────
  const result: Record<string, unknown> = {
    chain: name,
    nodes: 1 + stepNodes.length,
    edges: aEdge.length,
    activated: activate,
  };
  if (transportWarning) result.transportWarning = transportWarning;
  if (activate) {
    attachActivation(result, await activateChain(client, nameLc));
  }
  return JSON.stringify(result, null, 2);
}

// ── bw_activate_process_chain ─────────────────────────────────────────────────

export async function bwActivateProcessChain(client: BwClient, name: string): Promise<string> {
  refreshCsrf(client);
  const csrf = await client.getCsrfToken();
  const res = await client
    .rawPost(`${BASE}/${name.toLowerCase()}/activate`, '', writeHeaders(csrf))
    .catch((err: Error) => {
      throw new Error(`Activate process chain '${name}': ${err.message}`);
    });
  refreshCsrf(client);

  const parsed = parseActivateResponse(res.body);
  const result: Record<string, unknown> = {
    chain: name.toUpperCase(),
    success: parsed.success,
    message: parsed.message,
    severity: parsed.severity,
    log: parsed.log,
  };
  if (parsed.errors.length > 0) {
    result.errors = parsed.errors;
  }
  return JSON.stringify(result, null, 2);
}

// ── bw_create_decision_variant ─────────────────────────────────────────────────
//
// Create a DECISION process variant (its own TLOGO object) that a chain DECISION step
// references by name. The variant holds two branches (THEN/ELSE) indexed by `high`
// (1/2); each branch carries a DESCRIPTION (label), an EVENTNO (the branch condition the
// chain edges reference via sSubStatus), an EVENTCOLOR, and the branch FORMULA (set on
// the THEN branch only). FORMEX (the formula-expression key) is left empty — the server
// generates it. Body schema: see payloads/create_decision_variant.md.
//
// Activation is MANDATORY: an inactive decision variant is NOT selectable in the chain
// variant picker (this — not the package — is what makes a fresh variant unusable). The
// create POST is therefore always followed by an activate POST.
//
// Transport vs. visibility: $TMP is fine for visibility/selection; a transportable
// package is only needed to transport the variant. When a non-$TMP package is passed,
// validateobject declares it and the transport request is supplied as the
// sap-bw4-transportRequest header on the create POST (same mechanism as a chain write).

export async function bwCreateDecisionVariant(
  client: BwClient,
  params: CreateDecisionVariantParams
): Promise<string> {
  const {
    name,
    description,
    formula,
    package: pkgArg,
    transportRequest,
    thenLabel = 'JA',
    elseLabel = 'NEIN',
    thenEventNo = '01',
    elseEventNo = '02',
  } = params;

  const nameUpper = name.toUpperCase();
  const nameLc = name.toLowerCase();
  const pkg = (pkgArg ?? '$TMP').toUpperCase();
  const uri = `${DECISION_VARIANTS_BASE}/${nameLc}`;

  const model = {
    sProcessVariant: null,
    sVariantDescription: description,
    oDetail: [
      {
        field: 'DESCRIPTION',
        values: [
          { sign: 'I', option: 'EQ', low: thenLabel, high: 1 },
          { sign: 'I', option: 'EQ', low: elseLabel, high: 2 },
        ],
      },
      {
        field: 'EVENTCOLOR',
        values: [
          { sign: 'I', option: 'EQ', low: 'G', high: 1 },
          { sign: 'I', option: 'EQ', low: 'G', high: 2 },
        ],
      },
      {
        field: 'EVENTNO',
        values: [
          { sign: 'I', option: 'EQ', low: thenEventNo, high: 1 },
          { sign: 'I', option: 'EQ', low: elseEventNo, high: 2 },
        ],
      },
      {
        field: 'FORMULA',
        values: [
          { sign: 'I', option: 'EQ', low: formula, high: 1 },
          { sign: 'I', option: 'EQ', high: 2 },
        ],
      },
      {
        field: 'FORMEX',
        values: [
          { sign: 'I', option: 'EQ', high: 1 },
          { sign: 'I', option: 'EQ', high: 2 },
        ],
      },
    ],
    aSocket: [],
  };

  // ── Step 1: Transport check (declares the target package) ──────────────────
  const csrf = await client.getCsrfToken();
  const { header: transportHeader, warning: transportWarning } =
    await resolveTransportHeader(client, uri, csrf, transportRequest, pkg).catch((err: Error) => {
      throw new Error(`Transport check (create decision variant): ${err.message}`);
    });

  // ── Step 2: Create the variant ─────────────────────────────────────────────
  // resolveTransportHeader may have refreshed the CSRF token (on a 404 retry); fetch the
  // current token so the POST never goes out with a stale one.
  const postCsrf = await client.getCsrfToken();
  await client
    .rawPost(DECISION_VARIANTS_BASE, JSON.stringify({ name: nameUpper, model }), {
      ...writeHeaders(postCsrf),
      ...transportHeader,
    })
    .catch((err: Error) => {
      throw new Error(`Create decision variant '${nameUpper}': ${err.message}`);
    });
  refreshCsrf(client);

  // ── Step 3: Activate (MANDATORY) ───────────────────────────────────────────
  // Without activation the variant stays inactive and is not selectable in the chain
  // variant picker. No request body.
  const actCsrf = await client.getCsrfToken();
  const actRes = await client
    .rawPost(`${DECISION_VARIANTS_BASE}/${nameLc}/activate`, '', writeHeaders(actCsrf))
    .catch((err: Error) => {
      throw new Error(
        `Decision variant '${nameUpper}' was created but activation failed: ${err.message} ` +
        `(an inactive variant is not selectable in the chain variant picker).`
      );
    });
  refreshCsrf(client);
  const activation = parseActivateResponse(actRes.body);

  const result: Record<string, unknown> = {
    variant: nameUpper,
    description,
    package: pkg,
    branches: [
      { eventNo: thenEventNo, label: thenLabel, formula },
      { eventNo: elseEventNo, label: elseLabel },
    ],
    message:
      `Decision variant '${nameUpper}' created and activated in package '${pkg}'. ` +
      `Reference it from a chain DECISION step (variant='${nameUpper}') and branch its ` +
      `edges with sub_status '${thenEventNo}' (${thenLabel}) / '${elseEventNo}' (${elseLabel}).`,
  };
  attachActivation(result, activation);
  if (transportWarning) result.transportWarning = transportWarning;
  if (pkg === '$TMP') {
    result.transportNote =
      `Variant created in $TMP. $TMP is fine for visibility/selection in the picker; ` +
      `pass a transportable package (and transport_request) only if you need to transport it.`;
  }
  return JSON.stringify(result, null, 2);
}

// ── bw_add_process_chain_error_links ───────────────────────────────────────────
//
// Adds on-error (negative) links to an existing chain by mirroring the existing
// on-success (positive) out-edges of matching DTP_LOAD nodes. In-place edit:
// GET the current model, append the negative edges, PUT. No model reconstruction
// by the caller and no enqueue lock step.

export async function bwAddProcessChainErrorLinks(
  client: BwClient,
  params: AddProcessChainErrorLinksParams
): Promise<string> {
  const { name, dtps, activate = false, transportRequest } = params;
  const nameLc = name.toLowerCase();

  // ── Step 1: GET current chain (ETag + model) ───────────────────────────────
  let etag: string;
  let model: any;
  try {
    const got = await client.rawGet(`${BASE}/${nameLc}`, { Accept: JSON_CT });
    etag = got.headers['etag'] as string;
    if (!etag) throw new Error('No ETag returned by GET');
    const root = JSON.parse(got.body);
    // The GET body may wrap the model as { model: ... } or be the bare model;
    // the PUT body must always be the bare model object.
    model = root.model ?? root;
  } catch (err: any) {
    throw new Error(`GET chain '${name}': ${err.message}`);
  }

  const nodes: any[] = model.aNode ?? [];
  const edges: any[] = model.aEdge ?? [];

  // A node matches when it is a DTP_LOAD step and either no filter was given, or
  // one of the filter entries equals its DTP name (sProcessVariant) or is a
  // substring of its description (sVariantDescription, which holds the target).
  const nodeMatches = (i: number): boolean => {
    const n = nodes[i];
    if (n.sProcessType !== 'DTP_LOAD') return false;
    if (!dtps || dtps.length === 0) return true;
    return dtps.some((d) => {
      const u = d.toUpperCase();
      return (n.sProcessVariant ?? '').toUpperCase() === u
          || (n.sVariantDescription ?? '').toUpperCase().includes(u);
    });
  };

  // ── Step 2: Mirror positive out-edges as negative ones (skip existing) ─────
  let added = 0;
  nodes.forEach((_node: unknown, i: number) => {
    if (!nodeMatches(i)) return;
    edges
      .filter((e: any) => e.iNodeIndexFrom === i && e.sStatus === 'positive')
      .forEach((e: any) => {
        const exists = edges.some(
          (x: any) => x.iNodeIndexFrom === i && x.iNodeIndexTo === e.iNodeIndexTo && x.sStatus === 'negative'
        );
        if (!exists) {
          edges.push({ iNodeIndexFrom: i, iNodeIndexTo: e.iNodeIndexTo, sStatus: 'negative', sSubStatus: '00' });
          added++;
        }
      });
  });

  model.aEdge = edges;

  // ── Step 3: PUT the edited model with If-Match and the transport header ────
  const csrf = await client.getCsrfToken();
  const { header: transportHeader, warning: transportWarning } =
    await resolveTransportHeader(client, `${BASE}/${nameLc}`, csrf, transportRequest);
  // resolveTransportHeader may have refreshed the CSRF token (on a 404 retry); use the
  // current token for the PUT so it never goes out with a stale token.
  const putCsrf = await client.getCsrfToken();
  await client
    .rawPut(`${BASE}/${nameLc}`, JSON.stringify(model), {
      'Content-Type': JSON_CT,
      Accept: '*/*',
      'x-csrf-token': putCsrf,
      'If-Match': etag,
      'X-Requested-With': 'XMLHttpRequest',
      ...transportHeader,
    })
    .catch((err: Error) => {
      const stale = err.message.includes('HTTP 412');
      throw new Error(
        stale
          ? `PUT model failed: ETag is stale (412 Precondition Failed) — the chain was modified between the GET and PUT. Re-read and retry. ${err.message}`
          : `PUT edited model: ${err.message}`
      );
    });
  refreshCsrf(client);

  // ── Step 4: Optional activation ───────────────────────────────────────────
  const result: Record<string, unknown> = {
    chain: name,
    negative_links_added: added,
    activated: activate,
  };
  if (transportWarning) result.transportWarning = transportWarning;
  if (activate) {
    attachActivation(result, await activateChain(client, nameLc));
  }
  return JSON.stringify(result, null, 2);
}

// ── bw_swap_process_chain_dtp ──────────────────────────────────────────────────
//
// Replace one DTP_LOAD variant with another in place, editing the server's own model
// (same reliable pattern as bwAddProcessChainErrorLinks). Only the matching node's
// sProcessVariant (and, optionally, its description) changes; edges and all other
// nodes are preserved unchanged. Avoids rebuilding the full model from high-level
// steps/edges just to swap a single variant.

export async function bwSwapProcessChainDtp(
  client: BwClient,
  params: SwapProcessChainDtpParams
): Promise<string> {
  const { name, oldDtp, newDtp, refreshDescription = true, activate = false, transportRequest } = params;
  const nameLc = name.toLowerCase();

  // ── Step 1: GET current chain (ETag + model) ───────────────────────────────
  let etag: string;
  let model: any;
  try {
    const got = await client.rawGet(`${BASE}/${nameLc}`, { Accept: JSON_CT });
    etag = got.headers['etag'] as string;
    if (!etag) throw new Error('No ETag returned by GET');
    const root = JSON.parse(got.body);
    // The GET body may wrap the model as { model: ... } or be the bare model;
    // the PUT body must always be the bare model object.
    model = root.model ?? root;
  } catch (err: any) {
    throw new Error(`GET chain '${name}': ${err.message}`);
  }

  // ── Step 2: Locate the DTP_LOAD node and swap its variant in place ─────────
  const oldU = oldDtp.toUpperCase();
  const idx = (model.aNode ?? []).findIndex(
    (n: any) => n.sProcessType === 'DTP_LOAD' && (n.sProcessVariant ?? '').toUpperCase() === oldU
  );
  if (idx < 0) {
    throw new Error(`No DTP_LOAD node with variant '${oldDtp}' found in chain '${name}'.`);
  }

  model.aNode[idx].sProcessVariant = newDtp;
  if (refreshDescription) {
    try {
      const meta = await client.rawGet(
        `/sap/bc/http/sap/bw4/v1/modeling/processtypes/dtp_load/variants/${bwSeg(newDtp)}/a`,
        { Accept: JSON_CT }
      );
      const md = JSON.parse(meta.body);
      model.aNode[idx].sVariantDescription =
        md.sVariantDescription ?? md.description ?? model.aNode[idx].sVariantDescription;
    } catch {
      // Description is cosmetic; keep the existing one if the metadata is unavailable.
    }
  }
  // Edges and all other nodes are preserved unchanged.

  // ── Step 3: PUT the edited model with If-Match and the transport header ────
  const csrf = await client.getCsrfToken();
  const { header: transportHeader, warning: transportWarning } =
    await resolveTransportHeader(client, `${BASE}/${nameLc}`, csrf, transportRequest);
  // resolveTransportHeader may have refreshed the CSRF token (on a 404 retry); use the
  // current token for the PUT so it never goes out with a stale token.
  const putCsrf = await client.getCsrfToken();
  await client
    .rawPut(`${BASE}/${nameLc}`, JSON.stringify(model), {
      'Content-Type': JSON_CT,
      Accept: '*/*',
      'x-csrf-token': putCsrf,
      'If-Match': etag,
      'X-Requested-With': 'XMLHttpRequest',
      ...transportHeader,
    })
    .catch((err: Error) => {
      const stale = err.message.includes('HTTP 412');
      throw new Error(
        stale
          ? `PUT model failed: ETag is stale (412 Precondition Failed) — the chain was modified between the GET and PUT. Re-read and retry. ${err.message}`
          : `PUT edited model: ${err.message}`
      );
    });
  refreshCsrf(client);

  // ── Step 4: Optional activation ───────────────────────────────────────────
  const result: Record<string, unknown> = {
    chain: name,
    swapped_from: oldDtp.toUpperCase(),
    swapped_to: newDtp.toUpperCase(),
    activated: activate,
  };
  if (transportWarning) result.transportWarning = transportWarning;
  if (activate) {
    attachActivation(result, await activateChain(client, nameLc));
  }
  return JSON.stringify(result, null, 2);
}

// ── bw_append_process_chain_dtp ────────────────────────────────────────────────
//
// Append one DTP load step (optionally followed by its own ADSOACT step) in place to
// an existing chain, editing the server's own model (same read-modify-write pattern
// as bwAddProcessChainErrorLinks). The caller does not supply the full model.
// Shapes, placeholder inline-variant-key behavior, edge rules and invariants:
// see payloads/process_chain_create_update_activate.md,
// "Appending a DTP step (+ per-DTP activation) in place".

function countCollectors(ns: any[]): number {
  return ns.filter((n) => COLLECTOR_TYPES.has(String(n.sProcessType ?? '').toUpperCase())).length;
}

// The default append point: the terminal node (no outgoing edge, not the TRIGGER) closest
// to the trigger, chosen to keep parallel strands balanced; ties → first. `exclude` skips
// the not-yet-wired nodes of the block being inserted, which have no outgoing edge either.
function resolveStrandEnd(model: any, exclude: Set<number> = new Set()): number {
  const nodes: any[] = model.aNode ?? [];
  const edges: any[] = model.aEdge ?? [];
  const hasOut = new Set(edges.map((e: any) => e.iNodeIndexFrom));
  const predOf = (i: number) =>
    edges.filter((e: any) => e.iNodeIndexTo === i).map((e: any) => e.iNodeIndexFrom);
  const distFromTrigger = (i: number) => {
    let d = 0, cur = i, guard = 0;
    while (guard++ < 200) {
      const ps = predOf(cur).filter(
        (p: number) => String(nodes[p]?.sProcessType ?? '').toUpperCase() !== 'TRIGGER'
      );
      if (!ps.length) break;
      cur = ps[0];
      d++;
    }
    return d;
  };
  const terminals = nodes
    .map((_n: unknown, i: number) => i)
    .filter(
      (i) =>
        !exclude.has(i) &&
        !hasOut.has(i) &&
        String(nodes[i].sProcessType ?? '').toUpperCase() !== 'TRIGGER'
    );
  if (!terminals.length) throw new Error('No terminal strand end found to append to.');
  return terminals.sort((a, b) => distFromTrigger(a) - distFromTrigger(b))[0];
}

// Place an already-appended block of nodes into the chain according to the caller's
// before / after / predecessor choice, and describe where it landed. Shared by the DTP and
// the ABAP program tool so both position steps by the same rules.
function placeBlock(
  model: any,
  blockIndices: number[],
  opts: { before?: string; after?: string; predecessor?: string },
  link: (from: number, to: number) => void
): string {
  const { before, after, predecessor } = opts;
  if (before && after) {
    throw new Error("Pass only one of 'before' or 'after' (they are mutually exclusive).");
  }
  if (before) {
    const targetIdx = resolveChainNodeRef(model, before, "'before' target");
    spliceBlockInSeries(model, blockIndices, 'before', targetIdx, link);
    return `in series before ${chainNodeLabel(model, targetIdx)}`;
  }
  if (after) {
    const targetIdx = resolveChainNodeRef(model, after, "'after' target");
    spliceBlockInSeries(model, blockIndices, 'after', targetIdx, link);
    return `in series after ${chainNodeLabel(model, targetIdx)}`;
  }
  const exclude = new Set(blockIndices);
  const predIdx =
    !predecessor || predecessor === 'strand_end_auto'
      ? resolveStrandEnd(model, exclude)
      : resolveChainNodeRef(model, predecessor, 'predecessor');
  if (exclude.has(predIdx)) {
    throw new Error('The predecessor cannot be part of the inserted block.');
  }
  link(predIdx, blockIndices[0]);
  // An append does NOT reroute the target's existing successors, so the block runs
  // alongside them rather than ahead of them; before/after is what puts it in series.
  return `appended behind ${chainNodeLabel(model, predIdx)}`;
}

// Terminal strand ends: nodes with no outgoing edge, excluding the TRIGGER.
function countTerminalStrands(ns: any[], es: any[]): number {
  const out = new Set(es.map((e: any) => e.iNodeIndexFrom));
  return ns.filter((n, i) => !out.has(i) && String(n.sProcessType ?? '').toUpperCase() !== 'TRIGGER').length;
}

export async function bwAppendProcessChainDtp(
  client: BwClient,
  params: AppendProcessChainDtpParams
): Promise<string> {
  const { name, dtp, adsoact, before, after, predecessor, edgeMode = 'both', activate = false, transportRequest } = params;
  const nameLc = name.toLowerCase();

  // Baseline for the post-activation invariant check: the counts of the model we send.
  // Neither an append nor an in-series splice adds a collector or draws a new edge from
  // the TRIGGER, so RSPC must not raise either of these on save.
  let collectorsSent = 0;
  let strandsSent = 0;

  const { result, skipped } = await editChainModel(
    client,
    name,
    (model) => {
      const nodes: any[] = model.aNode;
      const edges: any[] = model.aEdge;

      // Idempotency: DTP already present → skip, no PUT.
      if (nodes.some((n) => (n.sProcessVariant ?? '').toUpperCase() === dtp.toUpperCase())) {
        return { report: {}, skipReason: 'DTP already present' };
      }

      // ── Build the block: the DTP, optionally followed by its own ADSOACT ────
      const dtpIdx = nodes.length;
      nodes.push({
        sProcessType: 'DTP_LOAD', bIsReference: true, bSkipped: false, iAutoRepeatCount: 0,
        iAutoRepeatWaitDuration: 0, iDebugWaitDuration: 0, sNotificationFailure: '', sNotificationSuccess: '',
        sProcessVariant: dtp, sVariantDescription: '',
      });
      const link = (from: number, to: number) => {
        edges.push({ iNodeIndexFrom: from, iNodeIndexTo: to, sStatus: 'positive', sSubStatus: '00' });
        if (edgeMode !== 'success_only') {
          edges.push({ iNodeIndexFrom: from, iNodeIndexTo: to, sStatus: 'negative', sSubStatus: '00' });
        }
      };

      const blockIndices = [dtpIdx];
      const added: string[] = [dtp];
      if (adsoact) {
        // Placeholder inline key; the server reassigns it to a generated ILV_ key on save.
        const key = `INLINE_APPEND_${dtpIdx}`;
        const actIdx = nodes.length;
        nodes.push({
          sProcessType: 'ADSOACT', bIsReference: false, bSkipped: false, iAutoRepeatCount: 0,
          iAutoRepeatWaitDuration: 0, iDebugWaitDuration: 0, sNotificationFailure: '', sNotificationSuccess: '',
          sProcessVariant: key,
        });
        model.aInlineVariant.push({
          sProcessVariant: key,
          sVariantDescription: '',
          oDetail: {
            sId: '',
            DATASTORES: [{ DATASTORE: adsoact, DESCRIPTION: '', HOTCOLDFLAG: '' }],
            NOCONDENSE: false,
            NOREQACTWARN: false,
          },
          aSocket: [],
        });
        blockIndices.push(actIdx);
        added.push(`ADSOACT(${adsoact})`);
      }

      // ── Wire the block in: in series (before/after) or appended ─────────────
      // The internal DTP → ADSOACT link is drawn first so the block is one strand before
      // placeBlock connects its entry and exit to the surrounding chain.
      for (let i = 1; i < blockIndices.length; i++) {
        link(blockIndices[i - 1], blockIndices[i]);
      }
      const placement = placeBlock(model, blockIndices, { before, after, predecessor }, link);

      collectorsSent = countCollectors(nodes);
      strandsSent = countTerminalStrands(nodes, edges);

      return { report: { appended: added, placement } };
    },
    { activate, transportRequest }
  );

  // ── Post-activation invariant verification ────────────────────────────────
  // Confirm RSPC did not insert a collector and did not add a terminal strand beyond what
  // we sent. Re-read the chain and compare.
  if (!skipped && activate) {
    try {
      const check = await client.rawGet(`${BASE}/${nameLc}`, { Accept: JSON_CT });
      const checkRoot = JSON.parse(check.body);
      const cm = checkRoot.model ?? checkRoot;
      const cn: any[] = cm.aNode ?? [];
      const ce: any[] = cm.aEdge ?? [];
      const collectorsAfter = countCollectors(cn);
      const strandsAfter = countTerminalStrands(cn, ce);
      const violations: string[] = [];
      if (collectorsAfter > collectorsSent) {
        violations.push(`a collector node was inserted (collectors ${collectorsSent} → ${collectorsAfter})`);
      }
      if (strandsAfter > strandsSent) {
        violations.push(`the terminal-strand count increased (${strandsSent} → ${strandsAfter})`);
      }
      if (violations.length > 0) {
        result.error = `Post-activation invariant violated: ${violations.join('; ')}.`;
      }
    } catch (err: any) {
      result.invariantCheckError = `Could not verify post-activation invariants: ${err.message}`;
    }
  }

  return JSON.stringify(result, null, 2);
}

// ── bw_add_process_chain_program ───────────────────────────────────────────────
//
// Add an "Execute ABAP Program" step (RSPC process type ABAP, "Programm ausführen") to
// an existing chain in place. The program call is stored as an INLINE process variant
// (bIsReference:false) inside the chain model — there is NO separate variant TLOGO
// object and no extra POST. We send a placeholder inline key ("INLINE_PROG_n"); the
// server rewrites it to a generated ILV_ key on save (same mechanism as the ADSOACT
// inline variant in bw_append_process_chain_dtp).
//
// The oDetail schema was traced from the BW/4HANA Cockpit; see
// payloads/process_chain_abap_program.md:
//   { X_SYNCHRON:"X", X_LOCAL:"X", X_PROGRAM:"X",
//     PROGRAM:[{ key, text, row:{ uri, name, description, package } }],
//     VARIANT:[{ key, text, row:{ uri, name, description } }] }
//
// Positioning: `before` reroutes the target's incoming edges through the new step
// (Start → PROGRAM → target), `after` reroutes the target's outgoing edges to leave from
// the new step, and with neither the step is appended behind the strand end closest to
// the trigger.

const ABAP_PROGRAM_URI_BASE = '/sap/bc/http/sap/bw4/v1/system/abapreports';

function buildAbapProgramVariant(
  key: string,
  params: AbapProgramSpec
): { node: object; inlineVariant: object } {
  const prog = params.program.toUpperCase();
  const variant = params.variant ? params.variant.toUpperCase() : undefined;
  const synchronous = params.synchronous ?? true;
  const local = params.local ?? true;

  const oDetail: Record<string, unknown> = {
    X_SYNCHRON: synchronous ? 'X' : '',
    X_LOCAL: local ? 'X' : '',
    X_PROGRAM: 'X',
    PROGRAM: [
      {
        key: prog,
        text: prog,
        row: {
          uri: `${ABAP_PROGRAM_URI_BASE}/${prog}`,
          name: prog,
          description: params.programDescription ?? '',
          package: params.programPackage ?? '',
        },
      },
    ],
    VARIANT: variant
      ? [
          {
            key: variant,
            text: params.variantDescription ?? variant,
            row: {
              uri: `/sap/bw4/system/abapreports/${prog}/variants/${variant}`,
              name: variant,
              description: params.variantDescription ?? '',
            },
          },
        ]
      : [],
  };

  const node = {
    sProcessType: 'ABAP',
    bIsReference: false,
    bProcess: true,
    bData: false,
    bSkipped: false,
    iAutoRepeatCount: 0,
    iAutoRepeatWaitDuration: 0,
    iDebugWaitDuration: 0,
    sNotificationFailure: '',
    sNotificationSuccess: '',
    sProcessVariant: key,
    sVariantDescription: params.description ?? '',
  };

  const inlineVariant = {
    sProcessVariant: key,
    sVariantDescription: params.description ?? '',
    oDetail,
    aSocket: [],
  };

  return { node, inlineVariant };
}

export async function bwAddProcessChainProgram(
  client: BwClient,
  params: AddProcessChainProgramParams
): Promise<string> {
  const { name, program, variant, before, after, predecessor, edgeMode = 'both', activate = false, transportRequest } = params;

  const progU = program.toUpperCase();
  const varU = variant ? variant.toUpperCase() : undefined;

  const { result } = await editChainModel(
    client,
    name,
    (model) => {
      const nodes: any[] = model.aNode;
      const edges: any[] = model.aEdge;

      // Idempotency: an ABAP step already calling the same program (+ variant) → skip.
      const duplicate = nodes.some((n) => {
        if (n.sProcessType !== 'ABAP') return false;
        const iv = model.aInlineVariant.find((v: any) => v.sProcessVariant === n.sProcessVariant);
        const p = (iv?.oDetail?.PROGRAM?.[0]?.key ?? '').toUpperCase();
        const v = (iv?.oDetail?.VARIANT?.[0]?.key ?? '').toUpperCase();
        return p === progU && (varU ? v === varU : true);
      });
      if (duplicate) {
        return {
          report: {},
          skipReason: `ABAP step for program '${progU}'${varU ? ` (variant '${varU}')` : ''} already present`,
        };
      }

      // Placeholder inline key; the server reassigns it to a generated ILV_ key on save.
      const newIdx = nodes.length;
      const { node, inlineVariant } = buildAbapProgramVariant(`INLINE_PROG_${newIdx}`, params);
      nodes.push(node);
      model.aInlineVariant.push(inlineVariant);

      const link = (from: number, to: number) => {
        edges.push({ iNodeIndexFrom: from, iNodeIndexTo: to, sStatus: 'positive', sSubStatus: '00' });
        if (edgeMode !== 'success_only') {
          edges.push({ iNodeIndexFrom: from, iNodeIndexTo: to, sStatus: 'negative', sSubStatus: '00' });
        }
      };

      const placement = placeBlock(model, [newIdx], { before, after, predecessor }, link);

      return {
        report: {
          added: `ABAP program ${progU}${varU ? ` (variant ${varU})` : ''}`,
          placement,
        },
      };
    },
    { activate, transportRequest }
  );

  return JSON.stringify(result, null, 2);
}

// ── bw_add_process_chain_edge / bw_remove_process_chain_edge ────────────────────
//
// Single-edge maintenance on an existing chain. Together with bw_remove_process_chain_step
// this is what makes a mis-wired chain repairable through the tools instead of only in RSPC:
// an "always continue" link is two edges (positive + negative), so removing one without a
// status removes the pair.

export async function bwAddProcessChainEdge(
  client: BwClient,
  params: AddProcessChainEdgeParams
): Promise<string> {
  const { name, from, to, status, subStatus = '00', activate = false, transportRequest } = params;

  const { result } = await editChainModel(
    client,
    name,
    (model) => {
      const fromIdx = resolveChainNodeRef(model, from, "'from' node");
      const toIdx = resolveChainNodeRef(model, to, "'to' node");
      const fromLabel = chainNodeLabel(model, fromIdx);
      const toLabel = chainNodeLabel(model, toIdx);
      const edge = addChainEdge(model, fromIdx, toIdx, status, subStatus);
      if (!edge) {
        return { report: { edge: `${fromLabel} → ${toLabel}` }, skipReason: 'an identical edge already exists' };
      }
      return {
        report: {
          added_edge: `${fromLabel} → ${toLabel}`,
          condition: edge.sStatus,
          branch: edge.sSubStatus,
        },
      };
    },
    { activate, transportRequest }
  );

  return JSON.stringify(result, null, 2);
}

export async function bwRemoveProcessChainEdge(
  client: BwClient,
  params: RemoveProcessChainEdgeParams
): Promise<string> {
  const { name, from, to, status, subStatus, activate = false, transportRequest } = params;

  const { result } = await editChainModel(
    client,
    name,
    (model) => {
      const fromIdx = resolveChainNodeRef(model, from, "'from' node");
      const toIdx = resolveChainNodeRef(model, to, "'to' node");
      const label = `${chainNodeLabel(model, fromIdx)} → ${chainNodeLabel(model, toIdx)}`;
      const removed = removeChainEdges(model, fromIdx, toIdx, status, subStatus);
      if (removed.length === 0) {
        // Report rather than throw: the caller asked for an end state that already holds.
        return { report: { edge: label }, skipReason: 'no matching edge exists' };
      }
      return {
        report: {
          removed_edge: label,
          removed_conditions: removed.map((e) => `${e.sStatus}${e.sSubStatus !== '00' ? `/${e.sSubStatus}` : ''}`),
        },
      };
    },
    { activate, transportRequest }
  );

  return JSON.stringify(result, null, 2);
}

// ── bw_remove_process_chain_step ────────────────────────────────────────────────

export async function bwRemoveProcessChainStep(
  client: BwClient,
  params: RemoveProcessChainStepParams
): Promise<string> {
  const { name, step, reconnect = true, activate = false, transportRequest } = params;

  const { result } = await editChainModel(
    client,
    name,
    (model) => {
      const idx = resolveChainNodeRef(model, step, 'step');
      const removal = removeChainStep(model, idx, reconnect);
      const report: Record<string, unknown> = {
        removed_step: removal.removedLabel,
        edges_removed: removal.edgesRemoved,
        edges_reconnected: removal.edgesReconnected,
        reconnected: reconnect,
      };
      if (removal.inlineVariantRemoved) report.inline_variant_removed = removal.inlineVariantRemoved;
      // A step with successors but no predecessors leaves them unreachable; say so rather
      // than letting activation fail with a bare RSPC message.
      if (!reconnect) {
        report.note =
          'reconnect was false — any successors of the removed step are now a strand that ' +
          'nothing leads to. Wire them up with bw_add_process_chain_edge before activating.';
      }
      return { report };
    },
    { activate, transportRequest }
  );

  return JSON.stringify(result, null, 2);
}
