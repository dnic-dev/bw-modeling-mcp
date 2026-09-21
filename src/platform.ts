/**
 * Platform detection and platform-dependent tool filtering.
 *
 * One instance of this server fronts exactly one BW system, and that system is either
 * BW/4HANA or a classic release (7.5 and below). The two do not publish the same APIs:
 * transformations, DTPs and process chains have no REST resource on classic, and the whole
 * BW/4HANA family outside `/sap/bw/modeling` — the manage API behind the request monitor,
 * push, process variants, the monitoring OData services — does not exist there at all.
 *
 * Without this module the model saw the full BW/4HANA surface on a classic system, called
 * those tools first because their descriptions promise they work, and got an ICF HTTP 404
 * back. A hint in the prompt does not compete with a tool list, so the tool list is what
 * this module corrects: what a system cannot do is not offered.
 *
 * Availability is derived from the system itself wherever the system states it — the
 * discovery document lists the collections it publishes, so a tool that needs `trfn` is
 * offered exactly where `trfn` is published. Two things discovery cannot answer, and both
 * fall back to the platform verdict:
 *
 *   - APIs outside `/sap/bw/modeling` (the `/sap/bw4/…` paths, the OData services). They
 *     are not in the document, so their absence cannot be read from it.
 *   - Everything, when discovery itself could not be read.
 *
 * The scope filter in scopes.ts is independent of this and stays untouched: scopes decide
 * what a caller may invoke, this decides what the system can answer. A read-only caller on
 * a classic system sees the intersection.
 */
import type { BwClient } from './bw-client.js';

export type Platform = 'bw4' | 'classic';

export interface PlatformProfile {
  platform: Platform;
  /**
   * Collection keys published by the discovery document (last path segment of each href),
   * lower case. Empty when discovery could not be read — then the platform verdict alone
   * decides, and collection-based checks fall back to the static catalog.
   */
  collections: Set<string>;
  /** Did detection actually succeed, or is this the fail-open default? */
  detected: boolean;
  /**
   * Is the platform filter active at all? `BW_PLATFORM=bw4` turns it off outright — the
   * deliberate escape hatch for an operator who needs a tool this module misjudges, which
   * no amount of care in the catalog below makes unnecessary.
   */
  filterEnabled: boolean;
  /** Where the verdict came from, for `bw_system_profile` and the log. */
  source: 'systeminfo' | 'discovery' | 'env' | 'fallback';
  /** One line explaining the verdict, shown by `bw_system_profile`. */
  detail: string;
}

// ── Detection ────────────────────────────────────────────────────────────────

/** `bw.b4hanamode = STRICT` is BW/4HANA; `STANDARD` (or absent) is a classic release. */
export function platformFromSystemInfo(props: Record<string, string>): Platform {
  return (props['bw.b4hanamode'] ?? '').toUpperCase() === 'STRICT' ? 'bw4' : 'classic';
}

export function parseSysProps(xml: string): Record<string, string> {
  const props: Record<string, string> = {};
  const re = /<sysInfo:property\s+name="([^"]+)"\s+value="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) props[m[1]] = m[2];
  return props;
}

/**
 * Collection keys published by the discovery document, mapped to the versioned XML media
 * type the system serves for them. The media type is needed to probe with a version this
 * system actually accepts — probing with a hardcoded one draws an HTTP 415 on any system
 * that has moved on.
 */
export function parseDiscoveryCollections(xml: string): Map<string, string | undefined> {
  const collections = new Map<string, string | undefined>();
  for (const segment of xml.split(/(?=<app:collection\s)/)) {
    const href = segment.match(/^<app:collection\b[^>]*?\shref="([^"]+)"/)?.[1];
    if (!href) continue;
    const key = href.split('/').pop()?.toLowerCase();
    if (!key) continue;
    const versioned = [...segment.matchAll(/<app:accept>([^<]+)<\/app:accept>/g)]
      .map((a) => a[1].trim())
      .find((mt) => /-v\d+_\d+_\d+\+xml$/.test(mt));
    if (!collections.has(key) || versioned) collections.set(key, versioned);
  }
  return collections;
}

/** `BW_PLATFORM=auto|bw4|classic`, `auto` being the default. */
function configuredPlatform(): Platform | undefined {
  const raw = (process.env.BW_PLATFORM ?? 'auto').trim().toLowerCase();
  if (raw === 'bw4' || raw === 'classic') return raw;
  return undefined;
}

/** Fail open: an undetectable system gets the full surface, never an empty one. */
function fallbackProfile(detail: string): PlatformProfile {
  return {
    platform: configuredPlatform() ?? 'bw4',
    collections: new Set(),
    detected: false,
    filterEnabled: configuredPlatform() !== 'bw4',
    source: configuredPlatform() ? 'env' : 'fallback',
    detail,
  };
}

/**
 * Upper bound on detection. Two GETs sit in front of the first tool call and of the stdio
 * handshake, and axios has no timeout of its own: an unreachable host would otherwise hold
 * both for as long as the OS takes to give up on the connection.
 */
const DETECT_TIMEOUT_MS = 15_000;

let detection: Promise<PlatformProfile> | null = null;
let cached: PlatformProfile | null = null;

/**
 * Detect the platform once per process and cache it.
 *
 * Module level rather than per server: the HTTP transport builds a fresh `Server` for every
 * request (http.ts), so anything held by `createServer()` would be re-detected on each call.
 * The platform of an instance cannot change while the process runs, and both reads are
 * read-only system metadata, identical for every caller — under principal propagation the
 * first caller's client happens to run them, which is unproblematic for that reason.
 *
 * Cleared on failure, like the media type discovery: one transient error during the first
 * request must not fix a wrong verdict for the life of the process.
 */
export function ensurePlatform(client: BwClient): Promise<PlatformProfile> {
  if (!detection) {
    let timer: NodeJS.Timeout;
    const bounded = new Promise<PlatformProfile>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${DETECT_TIMEOUT_MS} ms`)), DETECT_TIMEOUT_MS);
      timer.unref?.();
    });
    detection = Promise.race([detect(client), bounded])
      .finally(() => clearTimeout(timer))
      .then((profile) => {
        cached = profile;
        return profile;
      })
      .catch((err) => {
        detection = null;
        const profile = fallbackProfile(`detection failed (${err}) — full tool surface offered`);
        cached = profile;
        process.stderr.write(
          `[bw-modeling-mcp] Warning: platform detection failed (${err}); offering the full ` +
            `tool surface. Set BW_PLATFORM=classic if this system is a classic BW release.\n`,
        );
        return profile;
      });
  }
  return detection;
}

/** The cached verdict, or undefined before the first detection. Never triggers a call. */
export function cachedPlatform(): PlatformProfile | undefined {
  return cached ?? undefined;
}

/** Test seam: drop the cache so a test can detect against another system in-process. */
export function resetPlatformCache(): void {
  detection = null;
  cached = null;
}

async function detect(client: BwClient): Promise<PlatformProfile> {
  const forced = configuredPlatform();

  const [sysinfo, discovery] = await Promise.allSettled([
    client.get('/sap/bw/modeling/repo/is/systeminfo', 'application/xml'),
    client.get('/sap/bw/modeling/discovery', 'application/atomsvc+xml'),
  ]);

  const collections =
    discovery.status === 'fulfilled'
      ? new Set(parseDiscoveryCollections(discovery.value.body).keys())
      : new Set<string>();

  if (sysinfo.status === 'rejected' && collections.size === 0) {
    throw sysinfo.reason;
  }

  // systeminfo states the platform outright; discovery only corroborates it. `trfn` is the
  // discriminator there: no classic release publishes it, and no BW/4HANA system omits it.
  const fromSysInfo =
    sysinfo.status === 'fulfilled'
      ? platformFromSystemInfo(parseSysProps(sysinfo.value.body))
      : undefined;
  const fromDiscovery: Platform | undefined =
    collections.size > 0 ? (collections.has('trfn') ? 'bw4' : 'classic') : undefined;

  const detectedPlatform = fromSysInfo ?? fromDiscovery!;
  const agreement =
    fromSysInfo && fromDiscovery && fromSysInfo !== fromDiscovery
      ? ` (discovery suggests ${fromDiscovery}; going with b4hanamode)`
      : '';

  const platform = forced ?? detectedPlatform;
  const overridden = forced && forced !== detectedPlatform ? ` — BW_PLATFORM=${forced} overrides` : '';

  return {
    platform,
    collections,
    detected: true,
    filterEnabled: forced !== 'bw4',
    source: forced ? 'env' : fromSysInfo ? 'systeminfo' : 'discovery',
    detail:
      `${platform === 'bw4' ? 'SAP BW/4HANA' : 'classic SAP BW (7.5 or lower)'}, from ` +
      `${fromSysInfo ? 'bw.b4hanamode' : 'the published collections'}${agreement}${overridden}` +
      ` — ${collections.size} collections published` +
      `${forced === 'bw4' ? '; platform filtering off (BW_PLATFORM=bw4)' : ''}`,
  };
}

// ── What each tool needs from the system ─────────────────────────────────────

/**
 * Tools that address a `/sap/bw/modeling` collection which a system may not publish.
 * A tool is offered exactly where one of the listed collections is published — the system
 * decides, not a hardcoded release list.
 *
 * Several entries list alternatives because the same resource is published under different
 * keys across releases: InfoObjects answer on `iobj` everywhere, but a classic system
 * advertises that collection as `infoobject`, so requiring one key alone would hide working
 * tools on one platform or the other.
 */
const COLLECTION_NEEDS: Record<string, string[]> = {
  // Transformations — no REST resource on classic; BWMT opens the embedded SAP GUI there.
  bw_get_transformation: ['trfn'],
  bw_create_transformation: ['trfn'],
  bw_update_transformation: ['trfn'],
  bw_set_transformation_runtime: ['trfn'],
  bw_set_transformation_routine: ['trfn'],
  bw_set_transformation_routine_fields: ['trfn'],
  bw_set_transformation_expert_routine: ['trfn'],
  bw_delete_transformation_routine: ['trfn'],

  // DTPs — same. bw_get_dtps is not here: it lists them from the xref service, which every
  // release publishes, and never reads the DTP itself.
  bw_get_dtp: ['dtpa'],
  bw_create_dtp: ['dtpa'],
  bw_update_dtp: ['dtpa'],
  bw_run_dtp: ['dtpa'],
  bw_set_dtp_filter_routine: ['dtpa'],

  // Process chains — reading and writing both go through the `rspc` resource.
  bw_get_process_chain: ['rspc'],
  bw_create_process_chain: ['rspc'],
  bw_update_process_chain: ['rspc'],
  bw_activate_process_chain: ['rspc'],
  bw_add_process_chain_edge: ['rspc'],
  bw_remove_process_chain_edge: ['rspc'],
  bw_remove_process_chain_step: ['rspc'],
  bw_add_process_chain_error_links: ['rspc'],
  bw_append_process_chain_dtp: ['rspc'],
  bw_swap_process_chain_dtp: ['rspc'],
  bw_add_process_chain_program: ['rspc'],
  bw_create_decision_variant: ['rspc'],

  // Transport operations through the BW CTO resource. bw_create_transport_task is not here:
  // it goes through ADT (`/sap/bc/adt/cts`), which classic releases serve as well.
  bw_list_changeable_transports: ['cto'],
  bw_change_package: ['cto'],

  // Planning: classic publishes `alvl` but none of the three below. One resource each, and
  // they are easy to mix up — `plse` holds the planning functions, `plsq` the sequences, and
  // `plcr` is the characteristic relationships, which is what the planning properties of a
  // provider are read from (TLOGO PLSE / PLSQ / PLCR, per RSTLOGOPROP).
  bw_get_planning_function: ['plse'],
  bw_get_planning_properties: ['plcr'],
  bw_get_planning_sequence: ['plsq'],

  // Query *data*. Classic publishes the `query` collection — query definitions read fine —
  // but not `reporting`, and its `comp/reporting` handler answers every call with "Reporting
  // resource not implemented". That is the REST resource, not BICS, which classic does have. bw_get_filter_values is not here: it reads
  // the value help under `is/values`, which works on classic.
  bw_query_data: ['reporting'],

  // The data flow graph. `bw_xref` walks the same edges one object at a time.
  bw_get_dataflow: ['dmod'],
};

/**
 * Tools backed by an API family that only BW/4HANA ships, outside `/sap/bw/modeling` and
 * therefore absent from the discovery document. The value is what is missing, quoted back
 * to the caller when a client with a stale tool list calls one anyway.
 *
 * Verified against a classic 7.5 system: the `/sap/bw4/…` paths answer HTTP 404 with the
 * ICF logon error page, and the monitoring OData services are not registered at all
 * ("no service found for name …").
 */
const BW4_ONLY: Record<string, string> = {
  // Request monitor — /sap/bc/http/sap/bw4/v1/manage.
  bw_list_requests: 'the BW/4HANA manage API (/sap/bw4/v1/manage)',
  bw_get_request: 'the BW/4HANA manage API (/sap/bw4/v1/manage)',
  bw_activate_request: 'the BW/4HANA manage API (/sap/bw4/v1/manage)',
  bw_delete_request: 'the BW/4HANA manage API (/sap/bw4/v1/manage)',

  // Push API — /sap/bw4/v1/push.
  bw_push_data: 'the BW/4HANA push API (/sap/bw4/v1/push)',
  bw_get_push_schema: 'the BW/4HANA push API (/sap/bw4/v1/push)',

  // Process variants — /sap/bw4/v1/modeling/processtypes.
  bw_get_process_variant: 'the BW/4HANA process type API (/sap/bw4/v1/modeling/processtypes)',

  // Process chain monitoring — the RV_C_PCM* / BW4_PCM_SRV OData services.
  bw_list_process_chain_runs: 'the process chain monitoring OData services (RV_C_PCM*)',
  bw_get_process_chain_run_detail: 'the process chain monitoring OData services (RV_C_PCM*)',
  bw_list_process_chain_last_status: 'the process chain monitoring OData services (RV_C_PCM*)',

  // Remodeling monitor — the RV_C_RSCNVMONITOR_CDS OData service.
  bw_list_remodeling_requests: 'the remodeling monitor OData service (RV_C_RSCNVMONITOR_CDS)',
  bw_get_remodeling_request: 'the remodeling monitor OData service (RV_C_RSCNVMONITOR_CDS)',
  bw_run_remodeling: 'the remodeling monitor OData service (RV_C_RSCNVMONITOR_CDS)',
};

/**
 * What answers the same question on a classic release, per hidden tool.
 *
 * A hidden tool is only half an answer: the model still has the question. This names the
 * call that does work, and it is the single source for both places that need to say it —
 * the message a caller gets when it invokes a hidden tool, and the instructions paragraph
 * the server sends at handshake time. Extending the coverage of `bw_read_metadata_tables`
 * therefore means adding a line here, and both texts follow.
 *
 * Deliberately not a redirect inside the tool itself. The two routes run against different
 * backends — the BW modeling REST API on one side, ADT DataPreview with direct table access
 * on the other — and keeping them in separate tools keeps that boundary where it can be
 * governed: an installation that does not grant ADT simply withholds
 * `bw_read_metadata_tables`. A tool that quietly switched backends would dissolve that
 * boundary, and it would fail silently where hiding fails visibly.
 *
 * `topic` is what the caller was after, and is what the instructions list; several tools can
 * share one. Tools whose question has no answer on this platform at all (query data above
 * all) are absent here — there is nothing to point at yet.
 */
const CLASSIC_SUBSTITUTE: Record<string, { topic: string; call: string }> = {
  bw_get_transformation: {
    topic: 'Transformations (rules, routines)',
    call: 'bw_read_metadata_tables with object_type="TRFN"',
  },
  bw_get_dtp: {
    topic: 'DTPs',
    call: 'bw_read_metadata_tables with object_type="DTPA" (filter selections and the semantic group are not readable that way)',
  },
  bw_get_process_chain: {
    topic: 'Process chains (steps, variants, dependencies)',
    call: 'bw_read_metadata_tables with object_type="RSPC"',
  },
  bw_list_requests: {
    topic: 'Load history of a provider',
    call: 'bw_read_metadata_tables on the provider (object_type ADSO, ODSO, CUBE or MPRO)',
  },
  bw_get_request: {
    topic: 'Load history of a provider',
    call: 'bw_read_metadata_tables on the provider (object_type ADSO, ODSO, CUBE or MPRO)',
  },
  bw_get_dataflow: {
    topic: 'Data flow around an object',
    call: 'bw_xref on the object, one hop at a time',
  },
  bw_get_planning_function: {
    topic: 'Planning functions (type, parameters, FOX formula)',
    call: 'bw_read_metadata_tables with object_type="PLSE"',
  },
  bw_get_planning_sequence: {
    topic: 'Planning sequences (steps in execution order)',
    call: 'bw_read_metadata_tables with object_type="PLSQ"',
  },
  bw_get_planning_properties: {
    topic: 'Planning properties and characteristic relationships of a provider',
    call: 'bw_read_metadata_tables with object_type="PLCR" (data slices: "PLDS")',
  },
  bw_list_process_chain_runs: {
    topic: 'Run history of a process chain',
    call: 'bw_read_metadata_tables with object_type="RSPCLOG" and the chain name',
  },
  bw_get_process_chain_run_detail: {
    topic: 'The steps of one chain run',
    call: 'bw_read_metadata_tables with object_type="RSPCLOG" and the log id of the run',
  },
  bw_list_process_chain_last_status: {
    topic: 'Last status of several chains',
    call: 'bw_read_metadata_tables with object_type="RSPCLOG" and a name pattern such as "Z*"',
  },
};

/** Why a tool is not available: the missing resource, and the route that answers instead. */
export interface Unavailability {
  /** The reason on its own — identical for every tool that needs the same resource. */
  reason: string;
  /** The substitute call, where one exists. */
  route?: string;
}

/**
 * What stands in the way of a tool, or undefined when nothing does.
 *
 * Collection-backed tools are decided by the discovery document; when that could not be
 * read, the platform verdict decides instead — which is the static fallback layer, and the
 * reason a forced `BW_PLATFORM=classic` filters even on a system whose discovery never
 * arrived.
 */
export function unavailabilityOf(
  toolName: string,
  profile: PlatformProfile | undefined,
): Unavailability | undefined {
  if (!profile || !profile.filterEnabled) return undefined;

  const route = CLASSIC_SUBSTITUTE[toolName]?.call;

  const bw4Only = BW4_ONLY[toolName];
  if (bw4Only && profile.platform === 'classic') {
    return { reason: `needs ${bw4Only}, which classic SAP BW does not have.`, route };
  }

  const needs = COLLECTION_NEEDS[toolName];
  if (!needs) return undefined;

  if (profile.collections.size > 0) {
    if (needs.some((c) => profile.collections.has(c))) return undefined;
    return {
      reason:
        `needs the '${needs[0]}' resource, which this system does not publish ` +
        `(checked against its own discovery document).`,
      route,
    };
  }

  // Discovery unreadable: fall back to the platform verdict.
  if (profile.platform === 'classic') {
    return { reason: `needs the '${needs[0]}' resource, which classic SAP BW does not ship.`, route };
  }
  return undefined;
}

/** The same verdict as one sentence, for the caller that invoked a tool anyway. */
export function unavailableReason(
  toolName: string,
  profile: PlatformProfile | undefined,
): string | undefined {
  const verdict = unavailabilityOf(toolName, profile);
  if (!verdict) return undefined;
  return `${toolName} ${verdict.reason}` + (verdict.route ? ` On this system, use ${verdict.route}.` : '');
}

export function isToolAvailable(toolName: string, profile: PlatformProfile | undefined): boolean {
  return unavailableReason(toolName, profile) === undefined;
}

/** Hide what this system cannot answer, so a model never proposes a call that must fail. */
export function filterToolsByPlatform<T extends { name: string }>(
  tools: T[],
  profile: PlatformProfile | undefined,
): T[] {
  if (!profile) return tools;
  return tools.filter((t) => isToolAvailable(t.name, profile));
}

/**
 * Every tool this platform hides, for the diagnostic output of `bw_system_profile`.
 *
 * Reason and route come back separately: tools that need the same resource share a reason
 * and belong under one heading, while the route differs per tool — and a write, which has
 * no route at all, would otherwise split its resource into two headings.
 */
export function hiddenTools(
  allToolNames: readonly string[],
  profile: PlatformProfile | undefined,
): { name: string; reason: string; route?: string }[] {
  if (!profile) return [];
  return allToolNames
    .map((name) => ({ name, verdict: unavailabilityOf(name, profile) }))
    .filter((e) => e.verdict !== undefined)
    .map(({ name, verdict }) => ({ name, reason: verdict!.reason, route: verdict!.route }));
}

/**
 * The paragraph appended to the server instructions on a classic system.
 *
 * The filtered tool list alone leaves the model with the question but without the route:
 * `bw_get_transformation` is simply gone, and nothing says that the same content is in the
 * metadata tables. So the substitutes are spelled out here, generated from
 * CLASSIC_SUBSTITUTE and narrowed to the tools this particular system actually hides —
 * a system that does publish `trfn` gets no line about transformations.
 */
export function platformInstructions(profile: PlatformProfile | undefined): string[] {
  if (!profile || profile.platform !== 'classic' || !profile.filterEnabled) return [];

  const routes = new Map<string, string>();
  for (const [tool, { topic, call }] of Object.entries(CLASSIC_SUBSTITUTE)) {
    if (!isToolAvailable(tool, profile)) routes.set(topic, call);
  }

  return [
    '',
    'This system is a classic SAP BW release (7.5 or lower), not BW/4HANA. Several objects and',
    'APIs that BW/4HANA serves over REST do not exist here, so the tools that need them are',
    'not offered at all — nothing is missing from the system, the route is different. Where',
    'there is another route, take it directly instead of looking for a tool:',
    ...[...routes].map(([topic, call]) => `  ${topic}: ${call}`),
    '  Classic DSOs, InfoCubes, MultiProviders: bw_read_metadata_tables with object_type="ODSO", "CUBE" or "MPRO"',
    '',
    'bw_read_metadata_tables reads those objects from the BW metadata tables through the ADT',
    'DataPreview service, which is read-only and needs ADT authorization for the caller. Query',
    'definitions are readable here, query data is not. Everything still offered works as usual.',
  ];
}
