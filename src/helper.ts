/**
 * The optional ABAP helper endpoint, and what it adds on a classic release.
 *
 * Almost everything this server needs from a classic system is reachable without help: over
 * REST where the release publishes a resource, over the metadata tables where it does not.
 * One thing is not. A DTP keeps its filter, the filter routine, the semantic group and the
 * package sizes in `RSBKCMD-TPL_INSTANCE`, a serialised ABAP object stored as a compressed
 * data cluster. SQL can fetch that blob but not unpack it, and no relational table carries
 * the same information — `RSBKSELECT` and `RSBKDATAPAKSEL` are request scope, so they show
 * the values a past load ran with, never the definition and never the routine behind it.
 *
 * The gap is therefore closed by a small read-only ICF handler, installed next to the
 * Accept-header enhancement that a classic release needs anyway. It is optional on purpose:
 * the metadata-table route stays the baseline so the server works on an untouched system,
 * and this endpoint only adds what that route provably cannot deliver. Nothing that can be
 * read relationally is moved here — two sources for one answer would make the output depend
 * on what a given customer happens to have installed.
 *
 * The handler names its own capabilities rather than just answering "present", so a system
 * carrying an older build of it degrades one capability at a time instead of all at once.
 */
import type { BwClient } from './bw-client.js';
import { ensurePlatform } from './platform.js';

/** Where the handler is mounted. Overridable for a customer who mounts it elsewhere. */
export const HELPER_PATH = process.env.BW_HELPER_PATH?.trim() || '/sap/bc/zbwmcp';

/** Probing must not stall a read that works fine without the helper. */
const PROBE_TIMEOUT_MS = 5000;

export interface HelperProfile {
  installed: boolean;
  version?: string;
  capabilities: Set<string>;
  /** One line for `bw_system_profile` and for the log. */
  detail: string;
}

export interface DtpFilterSelection {
  field: string;
  sign: string;
  option: string;
  low: string;
  high: string;
  sel_type: string;
}

export interface DtpFilterDynamic {
  field: string;
  sel_routine: string;
  bex_variable: string;
  bex_periv: string;
  sel_type: string;
}

export interface DtpFilterRoutine {
  field: string;
  sel_routine: string;
  codeid: string;
  objvers: string;
  line_count: number;
  source: string;
}

export interface DtpFilterField {
  field: string;
  iobjnm: string;
  selection: string;
  fieldtxt: string;
}

export interface DtpFilter {
  dtp: string;
  objvers: string;
  found: boolean;
  message: string;
  selections: DtpFilterSelection[];
  dynamic: DtpFilterDynamic[];
  routines: DtpFilterRoutine[];
  fields: DtpFilterField[];
  semantic_groups: unknown[];
  max_size: number;
  min_size: number;
}

let probe: Promise<HelperProfile> | null = null;
let cached: HelperProfile | undefined;
let session: BwClient | undefined;

/**
 * The helper runs on its own session, and that is not a nicety.
 *
 * It is mounted outside `/sap/bw/modeling` and `/sap/bc/adt`, so its responses carry cookies
 * for a different ICF context. Absorbing those into the session that also drives ADT made two
 * DataPreview reads issued in parallel collide and answer HTTP 500 — a failure that looked
 * like a flaky server and was in fact this client's own doing.
 */
function helperSession(client: BwClient): BwClient {
  if (!session) session = client.freshSession();
  return session;
}

function notInstalled(detail: string): HelperProfile {
  return { installed: false, capabilities: new Set(), detail };
}

/**
 * Ask the endpoint what it is. A missing handler answers HTTP 404 from the ICF, an inactive
 * one 403, and neither is an error worth surfacing — the helper is optional, so every failure
 * means the same thing to the caller: carry on without it.
 */
async function detect(client: BwClient): Promise<HelperProfile> {
  let body: string;
  try {
    body = (await helperSession(client).rawGet(HELPER_PATH, { Accept: 'application/json' })).body;
  } catch (e) {
    return notInstalled(`not installed (${String((e as Error).message).split('\n')[0]})`);
  }

  let parsed: { service?: string; version?: string; capabilities?: unknown; capability?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    // Something answered on that path, but it is not this handler. Say so rather than
    // letting a stray service look like a working helper.
    return notInstalled('a service answered on the helper path, but not with this handler\'s identity');
  }
  if (parsed.service !== 'bwmcp') {
    return notInstalled('a different service is mounted on the helper path');
  }

  // `capability` is what build 1.0.0 sent before the list existed.
  const raw = Array.isArray(parsed.capabilities)
    ? parsed.capabilities
    : parsed.capability !== undefined
      ? [parsed.capability]
      : [];
  const capabilities = new Set(raw.filter((c): c is string => typeof c === 'string'));

  return {
    installed: true,
    version: typeof parsed.version === 'string' ? parsed.version : undefined,
    capabilities,
    detail: `installed (v${parsed.version ?? '?'}, ${[...capabilities].join(', ') || 'no capabilities reported'})`,
  };
}

/** The probe result, detected once per process. One server instance fronts one BW system. */
export function ensureHelper(client: BwClient): Promise<HelperProfile> {
  if (!probe) {
    let timer: NodeJS.Timeout;
    const bounded = new Promise<HelperProfile>((resolve) => {
      timer = setTimeout(() => resolve(notInstalled(`no answer within ${PROBE_TIMEOUT_MS} ms`)), PROBE_TIMEOUT_MS);
      timer.unref?.();
    });
    probe = Promise.race([detect(client), bounded])
      .finally(() => clearTimeout(timer))
      .then((profile) => {
        cached = profile;
        return profile;
      });
  }
  return probe;
}

/** The cached probe result, or undefined before the first probe. Never triggers a call. */
export function cachedHelper(): HelperProfile | undefined {
  return cached;
}

/**
 * What came back for one DTP.
 *
 * `absent` and `failed` both end in the same fallback, but they must not read the same to
 * the user: on a system without the handler there is nothing to fix, while a handler that
 * is installed and did not answer is a fault worth naming. A single `undefined` made those
 * two indistinguishable, which is exactly how a broken endpoint stays unnoticed.
 */
export type DtpFilterResult =
  | { kind: 'ok'; filter: DtpFilter }
  | { kind: 'absent' }
  | { kind: 'failed'; reason: string };

export async function fetchDtpFilter(client: BwClient, dtpName: string): Promise<DtpFilterResult> {
  // Only a classic release can have anything to gain here: BW/4HANA publishes the DTP as a REST
  // resource, so the filter comes from `bw_get_dtp` and this endpoint is documented as not
  // needed there. Probing anyway would send every BW/4HANA process after one path that is
  // meant to be absent, and report its absence as if something were missing.
  if ((await ensurePlatform(client)).platform !== 'classic') return { kind: 'absent' };

  const profile = await ensureHelper(client);
  if (!profile.installed || !profile.capabilities.has('dtp_filter')) return { kind: 'absent' };

  const url = `${HELPER_PATH}?dtp=${encodeURIComponent(dtpName)}`;
  const run = async (): Promise<DtpFilter> =>
    JSON.parse((await helperSession(client).rawGet(url, { Accept: 'application/json' })).body) as DtpFilter;

  try {
    let parsed: DtpFilter;
    try {
      parsed = await run();
    } catch (first) {
      // The first call on this session lands right behind the table reads that got us here,
      // and on a classic release that timing is enough for it to be refused once — the same
      // cold-session effect the DataPreview reads retry for. The request is a plain read, so
      // a second attempt is safe; a genuine 404 is re-thrown to the handler below.
      if (/HTTP 404/.test(String((first as Error).message))) throw first;
      parsed = await run();
    }
    return parsed.found ? { kind: 'ok', filter: parsed } : { kind: 'absent' };
  } catch (e) {
    const message = String((e as Error).message).split('\n')[0];
    // An unknown DTP is not a fault of the endpoint, and the caller already knows the object
    // from the table read that got it here.
    if (/HTTP 404/.test(message)) return { kind: 'absent' };
    process.stderr.write(`[bw-modeling-mcp] helper endpoint did not answer for ${dtpName}: ${message}\n`);
    return { kind: 'failed', reason: message };
  }
}
