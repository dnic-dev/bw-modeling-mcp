import { BwClient } from '../bw-client.js';
import { ensurePlatform, hiddenTools, parseDiscoveryCollections, parseSysProps } from '../platform.js';
import { CLASSIC_WRITE_HEADINGS, CLASSIC_WRITE_STATUS, type ClassicWriteVerdict } from '../classic-writes.js';

/**
 * Object types this server addresses through the BW modeling REST API, grouped by
 * the tool area they back. Used to turn the discovery document into a statement
 * about which tool groups actually work on the connected system.
 *
 * An entry with alternatives is satisfied by any one of them: the InfoObject resource
 * answers on `iobj` on every release, but classic systems advertise that collection as
 * `infoobject`, so a single key would report a working group as unavailable on one
 * platform or the other.
 */
const ENDPOINT_GROUPS: { group: string; collections: string[][] }[] = [
  { group: 'Modeling — providers', collections: [['adso'], ['iobj', 'infoobject'], ['hcpr'], ['infoprov']] },
  { group: 'Modeling — sources', collections: [['rsds'], ['trcs'], ['lsys'], ['dest']] },
  { group: 'Data flow', collections: [['trfn'], ['dtpa']] },
  { group: 'Queries — modeling', collections: [['query'], ['rkf'], ['ckf'], ['structure'], ['filter'], ['variable']] },
  { group: 'Planning', collections: [['alvl'], ['plcr'], ['plsq'], ['plse']] },
  { group: 'Process chains', collections: [['rspc']] },
  { group: 'Repository & search', collections: [['area'], ['activation']] },
];

/** A single yes/no check with a human-readable reason. */
interface Check {
  ok: boolean;
  detail: string;
  /** Neither confirmed nor refuted — the probe itself did not get through. */
  unclear?: boolean;
}

/**
 * Does content negotiation survive the request?
 *
 * On BW 7.5 the REST framework looks the Accept header up case-sensitively while the
 * kernel delivers header names in lower case — negotiation then falls back to resource
 * version 1.0.0 and any resource above that answers 406. Negotiation happens before the
 * object is read, so probing a name that cannot exist separates the cases cleanly:
 *
 *   404 — header was read, object simply does not exist  → fine
 *   415 — header was read, this version is not served    → fine (the header arrived)
 *   406 — header was not read at all, fallback to 1.0.0  → the defect is present
 */
async function probeContentNegotiation(client: BwClient, accept: string): Promise<Check> {
  try {
    await client.rawGet('/sap/bw/modeling/adso/zz_probe_does_not_exist/m', { Accept: accept });
    return { ok: true, detail: 'negotiation succeeded' };
  } catch (e) {
    const msg = String((e as Error).message);
    if (/HTTP 404/.test(msg)) return { ok: true, detail: 'header was read (probe object does not exist, as expected)' };
    if (/HTTP 415/.test(msg)) return { ok: true, detail: 'header was read (probe used a version this system does not serve)' };
    if (/HTTP 406/.test(msg)) {
      return {
        ok: false,
        detail: 'HTTP 406 — the Accept header is not being read; see docs/BW75-SUPPORT.md',
      };
    }
    return { ok: false, detail: msg.split('\n')[0] };
  }
}

/** Is the ADT DataPreview service reachable for this user? Needed for table-based reads. */
async function probeDataPreview(client: BwClient): Promise<Check> {
  try {
    const token = await client.getCsrfToken();
    const { body } = await client.rawPost(
      '/sap/bc/adt/datapreview/freestyle?rowNumber=1',
      "SELECT tranid FROM rstran WHERE objvers = 'A'",
      {
        'Content-Type': 'text/plain',
        Accept: 'application/xml, application/vnd.sap.adt.datapreview.table.v1+xml',
        'X-CSRF-Token': token,
      },
    );
    const rows = body.match(/<dataPreview:totalRows>(\d+)</)?.[1];
    return { ok: true, detail: rows ? `reachable (${rows} rows visible in a probe query)` : 'reachable' };
  } catch (e) {
    const msg = String((e as Error).message).split('\n')[0];
    if (/HTTP 40[13]/.test(msg)) {
      return { ok: false, detail: `${msg} — the user is likely missing ADT authorization` };
    }
    return { ok: false, detail: msg };
  }
}

/**
 * Is the modeling API's reporting resource implemented, not merely published?
 *
 * This asks about the REST resource and nothing else. BICS itself is present on a classic
 * release — its packages are there and the InA node is registered, which is how Analysis
 * for Office and the other InA clients reach a query. What is missing there is the route
 * to it through `/sap/bw/modeling`, the one Eclipse BWMT uses for its data preview.
 *
 * Only asked of a system that publishes `reporting` at all — the caller settles the rest
 * from discovery. It is worth asking there because published is not implemented: a system
 * can answer every call with "Reporting resource not implemented". Probing a query name that
 * cannot exist separates the cases — a system that implements the resource complains about
 * the query, one that does not complains about itself.
 *
 * Only `bw_query_data` depends on this. `bw_get_filter_values` reads the value help under
 * `is/values` and works without the reporting resource, verified on a classic system.
 */
async function probeReporting(client: BwClient): Promise<Check> {
  try {
    await client.rawGet('/sap/bw/modeling/comp/reporting?compid=ZZ_PROBE_DOES_NOT_EXIST', {
      Accept: 'application/xml',
    });
    return { ok: true, detail: 'implemented' };
  } catch (e) {
    const msg = String((e as Error).message);
    if (/not implemented/i.test(msg)) {
      return {
        ok: false,
        detail: 'NOT implemented — query definitions are readable, query data is not',
      };
    }
    // An error that never reached the handler says nothing about the handler. This branch
    // used to answer "implemented" for every error but that one, and a CSRF token rotated by
    // the DataPreview probe just above was enough to have a classic system report OK — in the
    // same output that listed bw_query_data as unavailable.
    if (/HTTP 40[13]|CSRF/i.test(msg)) {
      return { ok: false, unclear: true, detail: `probe did not get through (${msg.split('\n')[0]})` };
    }
    // Anything else means the handler ran and objected to the probe name, not to itself.
    return { ok: true, detail: 'implemented (probe query does not exist, as expected)' };
  }
}

/**
 * bw_system_profile — report what the connected system is and which tool groups work on it.
 *
 * Answers four questions in one call:
 *   1. Which platform is this (BW/4HANA vs classic BW) and is it changeable?
 *   2. Which REST endpoints does it publish, and which tool groups does that enable?
 *   3. Do the two known preconditions hold — header handling and ADT DataPreview access?
 *   4. Which tools does the platform verdict hide, and why?
 *
 * The verdict comes from the same cached profile the tool filter uses, so this tool and
 * `tools/list` cannot contradict each other. The probes below are this tool's own work:
 * they cost a request each and are only wanted when someone asks for a diagnosis.
 */
export async function bwSystemProfile(client: BwClient, toolNames: readonly string[] = []): Promise<string> {
  const out: string[] = [];
  const profile = await ensurePlatform(client);

  const { body: sysXml } = await client.get('/sap/bw/modeling/repo/is/systeminfo', 'application/xml');
  const props = parseSysProps(sysXml);
  const mode = props['bw.b4hanamode'] ?? '';
  const isBw4 = profile.platform === 'bw4';
  const changeable = sysXml.match(/bwChangeable="([^"]*)"/)?.[1] ?? '?';
  const basisChangeable = sysXml.match(/basisChangeable="([^"]*)"/)?.[1] ?? '?';
  const db = sysXml.match(/<dbInfo:name>([^<]+)</)?.[1] ?? '?';

  out.push('── System ──');
  out.push(`Platform:        ${isBw4 ? 'SAP BW/4HANA' : 'classic SAP BW (7.5 or lower)'}  [bw.b4hanamode = ${mode || 'n/a'}]`);
  out.push(`Verdict from:    ${profile.source}${profile.detected ? '' : ' (detection failed — full tool surface offered)'}`);
  out.push(`Logical system:  ${props['system.logsys'] ?? '?'}`);
  out.push(`Server version:  ${props['system.server_version'] ?? '?'}`);
  out.push(`Database:        ${db}`);
  out.push(`Language:        ${props['system.language'] ?? '?'}`);
  out.push(`Changeable:      BW=${changeable}  Basis=${basisChangeable}`);
  out.push(`Planning:        ${props['bw.planning_supported'] === 'X' ? 'supported' : 'not supported'}`);

  const { body: discXml } = await client.get('/sap/bw/modeling/discovery', 'application/atomsvc+xml');
  const collections = parseDiscoveryCollections(discXml);

  out.push('');
  out.push(`── Published endpoints (${collections.size} collections) ──`);
  for (const { group, collections: needed } of ENDPOINT_GROUPS) {
    const missing = needed.filter((alternatives) => !alternatives.some((c) => collections.has(c)));
    const status =
      missing.length === 0
        ? 'available'
        : `unavailable — missing: ${missing.map((a) => a.join('/')).join(', ')}`;
    out.push(`${group.padEnd(28)} ${status}`);
  }

  out.push('');
  out.push('── Preconditions ──');
  const probeAccept = collections.get('adso') ?? 'application/vnd.sap.bw.modeling.adso-v1_0_0+xml';
  const negotiation = await probeContentNegotiation(client, probeAccept);
  out.push(`Header handling:  ${negotiation.ok ? 'OK' : 'BROKEN'} — ${negotiation.detail}`);
  const dataPreview = await probeDataPreview(client);
  out.push(`ADT DataPreview:  ${dataPreview.ok ? 'OK' : 'UNAVAILABLE'} — ${dataPreview.detail}`);
  // Discovery decides first, and it is the same signal the tool filter uses, so the two
  // cannot disagree: `reporting` is the resource that returns query data, while `query` — the
  // query definition resource — is published on classic BW as well and says nothing about it.
  const reporting = collections.has('reporting')
    ? await probeReporting(client)
    : { ok: false, detail: 'the reporting resource is not published by this system' };
  const reportingLabel = reporting.ok ? 'OK' : reporting.unclear ? 'UNCLEAR' : 'UNAVAILABLE';
  out.push(`Query reporting:  ${reportingLabel} — ${reporting.detail}`);

  const hidden = hiddenTools(toolNames, profile);
  if (hidden.length > 0) {
    out.push('');
    out.push(`── Tools not offered on this platform (${hidden.length} of ${toolNames.length}) ──`);
    // Grouped by reason, because the reason is what the reader needs and it is shared by
    // every tool that wants the same resource. The route is per tool and printed with it —
    // grouping on reason-plus-route would split one missing resource across two headings.
    const byReason = new Map<string, { name: string; route?: string }[]>();
    for (const { name, reason, route } of hidden) {
      byReason.set(reason, [...(byReason.get(reason) ?? []), { name, route }]);
    }
    for (const [reason, tools] of byReason) {
      out.push(`  ${reason}`);
      const plain = tools.filter((t) => !t.route).map((t) => t.name);
      if (plain.length > 0) out.push(`    ${plain.join(', ')}`);
      for (const { name, route } of tools.filter((t) => t.route)) {
        out.push(`    ${name} → use ${route}`);
      }
    }
  }

  if (!isBw4) {
    const offered = new Set(toolNames);
    const shown = Object.entries(CLASSIC_WRITE_STATUS).filter(([name]) => offered.size === 0 || offered.has(name));
    if (shown.length > 0) {
      out.push('');
      out.push(`── Write tools on this platform (${shown.length}) ──`);
      // Silence would read as "everything not hidden works", so each write names its verdict.
      for (const verdict of ['verified', 'blocked', 'untested'] as ClassicWriteVerdict[]) {
        const group = shown.filter(([, s]) => s.verdict === verdict);
        if (group.length === 0) continue;
        out.push(`  ${CLASSIC_WRITE_HEADINGS[verdict]}`);
        for (const [name, status] of group) {
          out.push(status.note ? `    ${name} — ${status.note}` : `    ${name}`);
        }
      }
    }
  }

  out.push('');
  out.push('── What this means ──');
  if (!reporting.ok && !reporting.unclear) {
    out.push('Query definitions can be read, but bw_query_data cannot return anything on this');
    out.push('system: the modeling API publishes its reporting resource here without implementing');
    out.push('it. That is a statement about the REST resource, not about BICS — a classic release');
    out.push('has the framework, and InA clients such as Analysis for Office reach it by their own');
    out.push('route. Characteristic values (bw_get_filter_values) come from the value help and are');
    out.push('unaffected.');
  }
  if (isBw4) {
    out.push('Full tool coverage: reading, creating and modifying BW objects, plus runtime and monitoring.');
  } else {
    out.push('Classic BW: modeling reads work for the endpoints listed above.');
    out.push('Objects without a published endpoint (typically transformations, DTPs, process chains)');
    out.push('cannot be read or written through the REST API on this system — SAP never shipped those');
    out.push('resources here. The BW/4HANA manage API (requests, monitoring, push) does not exist either.');
    out.push('Read those objects with bw_read_metadata_tables (TRFN, DTPA, ADSO, RSPC, ODSO, CUBE, MPRO,');
    out.push('plus PLSE, PLSQ, PLCR and PLDS for the planning objects and RSPCLOG for chain runs) —');
    out.push('which is also where the load');
    out.push('history of a provider comes from on this platform. Every tool listed above as hidden');
    out.push('names its substitute in the same place.');
    if (!negotiation.ok) {
      out.push('');
      out.push('ACTION: header handling is broken — nearly every call will fail with HTTP 406.');
      out.push('Apply the post-exit enhancement described in docs/BW75-SUPPORT.md first.');
    }
  }

  return out.join('\n');
}
