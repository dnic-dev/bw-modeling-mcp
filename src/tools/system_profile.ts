import { BwClient } from '../bw-client.js';

/**
 * Object types this server addresses through the BW modeling REST API, grouped by
 * the tool area they back. Used to turn the discovery document into a statement
 * about which tool groups actually work on the connected system.
 */
const ENDPOINT_GROUPS: { group: string; collections: string[] }[] = [
  { group: 'Modeling — providers', collections: ['adso', 'infoobject', 'hcpr', 'infoprov'] },
  { group: 'Modeling — sources', collections: ['rsds', 'trcs', 'lsys', 'dest'] },
  { group: 'Data flow', collections: ['trfn', 'dtpa'] },
  { group: 'Queries — modeling', collections: ['query', 'rkf', 'ckf', 'structure', 'filter', 'variable'] },
  { group: 'Planning', collections: ['alvl', 'plcr', 'plsq', 'plse'] },
  { group: 'Process chains', collections: ['rspc'] },
  { group: 'Repository & search', collections: ['area', 'activation'] },
];

/** A single yes/no check with a human-readable reason. */
interface Check {
  ok: boolean;
  detail: string;
}

function parseSysProps(xml: string): Record<string, string> {
  const props: Record<string, string> = {};
  const re = /<sysInfo:property\s+name="([^"]+)"\s+value="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) props[m[1]] = m[2];
  return props;
}

/**
 * Collection keys published by the discovery document (last path segment of each href),
 * mapped to the versioned XML media type the system serves for them. The media type is
 * needed to probe with a version this system actually accepts — probing with a hardcoded
 * one draws an HTTP 415 on any system that has moved on.
 */
function parseDiscoveryCollections(xml: string): Map<string, string | undefined> {
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
 * Is the BICS reporting resource implemented, not merely published?
 *
 * Discovery lists the `query` collection on classic BW as well, so the endpoint list alone
 * suggests that reading data works — but on BW 7.5 the handler answers every call with
 * "Reporting resource not implemented". Reading query definitions is unaffected; only
 * bw_query_data and bw_get_filter_values depend on this. Probing a query name that cannot
 * exist separates the cases: a system that implements the resource complains about the
 * query, one that does not complains about the resource.
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
    // Anything else means the handler ran and objected to the probe name, not to itself.
    return { ok: true, detail: 'implemented (probe query does not exist, as expected)' };
  }
}

/**
 * bw_system_profile — report what the connected system is and which tool groups work on it.
 *
 * Answers three questions in one call:
 *   1. Which platform is this (BW/4HANA vs classic BW) and is it changeable?
 *   2. Which REST endpoints does it publish, and which tool groups does that enable?
 *   3. Do the two known preconditions hold — header handling and ADT DataPreview access?
 */
export async function bwSystemProfile(client: BwClient): Promise<string> {
  const out: string[] = [];

  const { body: sysXml } = await client.get('/sap/bw/modeling/repo/is/systeminfo', 'application/xml');
  const props = parseSysProps(sysXml);
  const mode = props['bw.b4hanamode'] ?? '';
  const isBw4 = mode.toUpperCase() === 'STRICT';
  const changeable = sysXml.match(/bwChangeable="([^"]*)"/)?.[1] ?? '?';
  const basisChangeable = sysXml.match(/basisChangeable="([^"]*)"/)?.[1] ?? '?';
  const db = sysXml.match(/<dbInfo:name>([^<]+)</)?.[1] ?? '?';

  out.push('── System ──');
  out.push(`Platform:        ${isBw4 ? 'SAP BW/4HANA' : 'classic SAP BW (7.5 or lower)'}  [bw.b4hanamode = ${mode || 'n/a'}]`);
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
    const missing = needed.filter((c) => !collections.has(c));
    const status = missing.length === 0 ? 'available' : `unavailable — missing: ${missing.join(', ')}`;
    out.push(`${group.padEnd(28)} ${status}`);
  }

  out.push('');
  out.push('── Preconditions ──');
  const probeAccept = collections.get('adso') ?? 'application/vnd.sap.bw.modeling.adso-v1_0_0+xml';
  const negotiation = await probeContentNegotiation(client, probeAccept);
  out.push(`Header handling:  ${negotiation.ok ? 'OK' : 'BROKEN'} — ${negotiation.detail}`);
  const dataPreview = await probeDataPreview(client);
  out.push(`ADT DataPreview:  ${dataPreview.ok ? 'OK' : 'UNAVAILABLE'} — ${dataPreview.detail}`);
  const reporting = collections.has('query')
    ? await probeReporting(client)
    : { ok: false, detail: 'no query endpoint on this system' };
  out.push(`Query reporting:  ${reporting.ok ? 'OK' : 'UNAVAILABLE'} — ${reporting.detail}`);

  out.push('');
  out.push('── What this means ──');
  if (!reporting.ok && collections.has('query')) {
    out.push('Query definitions can be read, but bw_query_data and bw_get_filter_values cannot');
    out.push('return anything on this system — the BICS reporting resource is not implemented here.');
  }
  if (isBw4) {
    out.push('Full tool coverage: reading, creating and modifying BW objects, plus runtime and monitoring.');
  } else {
    out.push('Classic BW: modeling reads work for the endpoints listed above.');
    out.push('Objects without a published endpoint (typically transformations, DTPs, process chains)');
    out.push('cannot be read or written through the REST API on this system — SAP never shipped those');
    out.push('resources here. The BW/4HANA manage API (requests, monitoring, push) does not exist either.');
    if (!negotiation.ok) {
      out.push('');
      out.push('ACTION: header handling is broken — nearly every call will fail with HTTP 406.');
      out.push('Apply the post-exit enhancement described in docs/BW75-SUPPORT.md first.');
    }
  }

  return out.join('\n');
}
