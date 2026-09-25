import { BwClient } from '../bw-client.js';
import type { Platform } from '../platform.js';
import { queryTable, sqlLiteral, inListBatches } from './metadata_sql.js';

interface SearchEntry {
  objectName: string;
  objectType: string;
  objectStatus: string;
  objectVersion: string;
  title: string;
  href: string;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/**
 * Parse <atom:entry> elements from a BW search or xref Atom feed.
 */
export function parseAtomEntries(xml: string): SearchEntry[] {
  const entries: SearchEntry[] = [];
  const entryRegex = /<atom:entry>([\s\S]*?)<\/atom:entry>/g;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(xml)) !== null) {
    const body = match[1];
    const nameMatch = body.match(/objectName="([^"]+)"/);
    const typeMatch = body.match(/objectType="([^"]+)"/);
    const statusMatch = body.match(/objectStatus="([^"]+)"/);
    const versionMatch = body.match(/objectVersion="([^"]+)"/);
    const titleMatch = body.match(/<atom:title>([^<]+)<\/atom:title>/);
    const hrefMatch = body.match(/href="([^"]+)"/);

    if (nameMatch && typeMatch) {
      entries.push({
        objectName: decodeEntities(nameMatch[1]),
        objectType: typeMatch[1],
        objectStatus: statusMatch?.[1] ?? 'unknown',
        objectVersion: versionMatch?.[1] ?? '',
        title: decodeEntities(titleMatch?.[1] ?? ''),
        href: hrefMatch?.[1] ?? '',
      });
    }
  }
  return entries;
}

function entryLine(e: SearchEntry, index: number): string {
  const version = e.objectVersion ? ` [v${e.objectVersion}]` : '';
  return (
    `${index}. ${e.objectName} (${e.objectType}) — ${e.objectStatus}${version}` +
    (e.title ? ` — "${e.title}"` : '')
  );
}

/**
 * Format search entries as a human-readable list.
 */
function formatEntries(entries: SearchEntry[], header: string, notes: string[] = []): string {
  const lines = [header];
  for (const n of notes) lines.push('', n);
  if (entries.length === 0) {
    lines.push('', 'No results found.');
    return lines.join('\n');
  }
  lines.push('', `Found ${entries.length} result(s):`, '');
  entries.forEach((e, i) => {
    lines.push(entryLine(e, i + 1) + (e.href ? `\n   Path: ${e.href}` : ''));
  });
  return lines.join('\n');
}

/**
 * The search service accepts a different set of type filters per release, and answers the
 * others with a short dump (HTTP 500) rather than with an empty feed. Verified, each type in
 * a fresh session: a classic 7.5 system rejects ANPR, ISIP and RSPC; a BW/4HANA system
 * rejects ANPR, ISIP and the classic providers ODSO, CUBE and MPRO. The service itself is
 * fine in that case, so the fallback asks it once without the filter and filters the entries
 * here.
 */
function isRejectedFilter(error: unknown): boolean {
  return /→ HTTP (400|500)\b/.test(error instanceof Error ? error.message : String(error));
}

/**
 * Types the search index leaves out even without a filter, and the call that lists them.
 * Without this an empty fallback result would read as "no such object exists".
 */
const UNINDEXED_ROUTE: Record<string, string> = {
  ISIP:
    'InfoPackages (classic SAP BW only) are not in the search index. List the InfoPackages of a ' +
    'DataSource with bw_read_metadata_tables object_type="ISIP" and the DataSource name, or with ' +
    'bw_xref on the DataSource (object_type="RSDS" with its source_system).',
  RSPC:
    'Process chains may be missing from the search index on this release. List them with ' +
    'bw_read_metadata_tables object_type="RSPCLOG" and a pattern such as "Z*" (last status of ' +
    'every matching chain).',
};

/**
 * bw_search — search BW objects by name/description, optionally filtered by type.
 *
 * Uses: GET /sap/bw/modeling/repo/is/bwsearch
 * Parameters:
 *   searchTerm  — supports wildcards (e.g. "NJ_*")
 *   objectType  — optional: ADSO, TRFN, DTPA, IOBJ, etc. (empty = all types)
 *
 * Returns a formatted list of matching objects.
 */
export async function bwSearch(
  client: BwClient,
  searchTerm: string,
  objectType?: string
): Promise<string> {
  const type = objectType?.trim().toUpperCase() ?? '';
  const header = `BW Search: "${searchTerm}"` + (type ? ` (type: ${type})` : '');

  // Analysis processes are not in the search index of any release: an unfiltered search
  // never returns one, and the type filter fails with HTTP 500.
  if (type === 'ANPR') {
    return (
      `${header}\n\n` +
      'Analysis processes (ANPR) are not in the BW search index, so bw_search cannot find them. ' +
      'List them with bw_read_metadata_tables object_type="ANPR" and a name pattern such as "Z*", ' +
      'or find the ones that read from or write to a provider with bw_xref on that provider. ' +
      'Analysis processes exist on classic SAP BW only.'
    );
  }

  // Wide date range = no date filtering
  const from = '1970-01-01T00%3A00%3A00Z';
  const to = '2099-12-31T23%3A59%3A59Z';
  const pathFor = (t: string) =>
    `/sap/bw/modeling/repo/is/bwsearch` +
    `?searchTerm=${encodeURIComponent(searchTerm)}` +
    `&searchInName=true&searchInDescription=true` +
    `&objectType=${encodeURIComponent(t)}` +
    `&createdOnFrom=${from}&createdOnTo=${to}` +
    `&changedOnFrom=${from}&changedOnTo=${to}`;

  try {
    const result = await client.get(pathFor(type), 'application/atom+xml;type=feed');
    return formatEntries(parseAtomEntries(result.body), header);
  } catch (error) {
    if (!type || !isRejectedFilter(error)) throw error;
    let unfiltered: SearchEntry[];
    try {
      unfiltered = parseAtomEntries((await client.get(pathFor(''), 'application/atom+xml;type=feed')).body);
    } catch {
      // The service fails without the filter as well, so the original error is the real one.
      throw error;
    }
    const entries = unfiltered.filter((e) => e.objectType === type);
    const notes = [
      `The search service of this system does not accept the type filter ${type}, so these ` +
        `results come from an unfiltered search, narrowed to ${type} afterwards.`,
    ];
    if (entries.length === 0) {
      notes.push(
        UNINDEXED_ROUTE[type] ??
          `No ${type} object in the unfiltered search either. That can also mean the type does not ` +
            `exist on this release — bw_system_profile says which object types it has.`,
      );
    }
    return formatEntries(entries, header, notes);
  }
}

// ── Where-used ───────────────────────────────────────────────────────────────

type Direction = 'upstream' | 'downstream';

interface FlowEnd {
  /** TLOGO where the title names one; DTP titles do not, and it is filled in from context. */
  type?: string;
  /** The part of an InfoObject a master data flow loads: TEXT, ATTR or HIER. */
  subtype?: string;
  name: string;
  sourceSystem?: string;
}

export interface XrefHit extends SearchEntry {
  source?: FlowEnd;
  target?: FlowEnd;
  direction?: Direction;
  /** Where the hit comes from when it is not the where-used index. */
  origin?: string;
}

/**
 * One end of a data flow as a transformation or DTP title names it.
 *
 * Transformation titles carry the type: "ODSO NAME", or "RSDS NAME LSYS" for a DataSource.
 * A master data flow names the part of the InfoObject it loads with the type: "IOBJTEXT NAME".
 * DTP titles carry no type: "NAME", or "NAME / LSYS". Both formats are identical on BW/4HANA
 * and on classic releases.
 */
function parseFlowEnd(raw: string, typed: boolean): FlowEnd | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  if (typed) {
    const m = text.match(/^([A-Z]{4})(TEXT|ATTR|HIER)?\s+(\S+)(?:\s+(\S+))?$/);
    if (!m) return undefined;
    return { type: m[1], ...(m[2] ? { subtype: m[2] } : {}), name: m[3], sourceSystem: m[4] };
  }
  const m = text.match(/^(\S+)(?:\s*\/\s*(\S+))?$/);
  if (!m) return undefined;
  return { name: m[1], sourceSystem: m[2] };
}

/**
 * Source and target of a transformation or DTP, read from its title.
 *
 * The where-used feed carries no direction of its own — the title is the only place it
 * appears. A title that does not have the expected shape yields nothing rather than a guess.
 */
export function parseFlowTitle(
  objectType: string,
  title: string,
): { source: FlowEnd; target: FlowEnd } | undefined {
  if (objectType !== 'TRFN' && objectType !== 'DTPA') return undefined;
  const parts = title.split(' -> ');
  if (parts.length !== 2) return undefined;
  const typed = objectType === 'TRFN';
  const source = parseFlowEnd(parts[0], typed);
  const target = parseFlowEnd(parts[1], typed);
  return source && target ? { source, target } : undefined;
}

function sameEnd(end: FlowEnd, type: string, name: string, sourceSystem?: string): boolean {
  if (end.type && end.type !== type) return false;
  if (end.name !== name) return false;
  return !sourceSystem || !end.sourceSystem || end.sourceSystem === sourceSystem;
}

/**
 * Attach source, target and direction to the hits of one where-used result.
 *
 * Direction is relative to the object the where-used list was asked for: a flow that ends in
 * it feeds it (upstream), a flow that starts in it is fed from it (downstream). DTP ends have
 * no type in their title and borrow it from a transformation end of the same name, or from
 * the queried object itself.
 */
export function annotateXref(
  entries: SearchEntry[],
  queriedType: string,
  queriedName: string,
  sourceSystem?: string,
): XrefHit[] {
  const hits: XrefHit[] = entries.map((e) => ({ ...e, ...parseFlowTitle(e.objectType, e.title) }));

  const typeByName = new Map<string, string>([[queriedName, queriedType]]);
  for (const h of hits) {
    for (const end of [h.source, h.target]) if (end?.type) typeByName.set(end.name, end.type);
  }

  for (const h of hits) {
    for (const end of [h.source, h.target]) {
      if (end && !end.type) end.type = typeByName.get(end.name);
    }
    if (h.target && sameEnd(h.target, queriedType, queriedName, sourceSystem)) h.direction = 'upstream';
    else if (h.source && sameEnd(h.source, queriedType, queriedName, sourceSystem)) h.direction = 'downstream';
    // An analysis process can only read a query, never write to one, so the where-used index
    // listing it under a query already says which way it points.
    else if (queriedType === 'ELEM' && h.objectType === 'ANPR') {
      h.direction = 'downstream';
      h.source = { type: 'ELEM', name: queriedName };
      h.target = { type: 'ANPR', name: h.objectName };
    }
  }
  return hits;
}

function endLabel(end: FlowEnd): string {
  return (
    `${end.type ? `${end.type} ` : ''}${end.name}` +
    `${end.subtype ? ` [${end.subtype}]` : ''}${end.sourceSystem ? ` (${end.sourceSystem})` : ''}`
  );
}

function formatXref(hits: XrefHit[], header: string, notes: string[]): string {
  const lines = [header];
  if (hits.length === 0) {
    lines.push('', 'No results found.');
  } else {
    const up = hits.filter((h) => h.direction === 'upstream').length;
    const down = hits.filter((h) => h.direction === 'downstream').length;
    lines.push(
      '',
      `Found ${hits.length} result(s)` +
        (up || down ? ` — ${up} upstream (feeding this object), ${down} downstream (fed from it)` : '') +
        ':',
      '',
    );
    hits.forEach((h, i) => {
      lines.push(entryLine(h, i + 1));
      if (h.source && h.target) {
        const arrow = h.direction === 'upstream' ? '← upstream' : h.direction === 'downstream' ? '→ downstream' : 'flow';
        lines.push(`   ${arrow}: ${endLabel(h.source)} → ${endLabel(h.target)}`);
      }
      if (h.origin) lines.push(`   Found in: ${h.origin}`);
      if (h.href) lines.push(`   Path: ${h.href}`);
    });
  }
  for (const n of notes) lines.push('', n);
  return lines.join('\n');
}

/**
 * Object types an analysis process can read from or write to, as RSANT_PROCESSI records them.
 * Queries are absent: they are recorded by UID, and the where-used index lists the analysis
 * processes that read a query already.
 */
const APD_PROVIDER_TYPES = new Set(['ADSO', 'ODSO', 'CUBE', 'MPRO', 'IOBJ']);

/**
 * RSO_ASC_TYPE, from the analysis process's point of view: 004 "Sends data to" marks the
 * object it writes, 005 "Receives data from" the one it reads. 002 "Requires" is every
 * InfoObject its fields use and says nothing about data flow.
 */
const APD_ROLE: Record<string, Direction> = { '004': 'upstream', '005': 'downstream' };

/**
 * The analysis processes that write to or read from a provider, on a classic release.
 *
 * The where-used index does not know them: asked for the target of an analysis process, it
 * lists every other user of that provider but not the process that fills it. The
 * relationship is kept in RSANT_PROCESSI, readable through ADT DataPreview — the same route
 * bw_read_metadata_tables takes, under the same `read` scope.
 *
 * Returns undefined when the table cannot be read (ADT not granted, service inactive): the
 * where-used answer is still complete for everything else, and the caller says what was not
 * checked rather than failing.
 */
async function analysisProcessesOf(
  client: BwClient,
  type: string,
  name: string,
): Promise<XrefHit[] | undefined> {
  let rows: Record<string, string>[];
  try {
    rows = await queryTable(
      client,
      `SELECT process, objvers, asc_type FROM rsant_processi ` +
        `WHERE tlogo = '${sqlLiteral(type)}' AND objnm = '${sqlLiteral(name)}' ` +
        `AND asc_type IN ('004', '005')`,
      500,
    );
  } catch {
    return undefined;
  }

  // One process can hold the relationship in several versions; the active one wins.
  const byKey = new Map<string, Record<string, string>>();
  for (const r of rows) {
    const key = `${r.PROCESS}/${r.ASC_TYPE}`;
    const held = byKey.get(key);
    if (!held || r.OBJVERS === 'A') byKey.set(key, r);
  }
  if (byKey.size === 0) return [];

  const texts = new Map<string, string>();
  const processes = [...new Set([...byKey.values()].map((r) => r.PROCESS))];
  for (const batch of inListBatches(processes, 150)) {
    try {
      const t = await queryTable(
        client,
        `SELECT process, spras, txtlg FROM rsant_processt WHERE process IN (${batch}) AND objvers = 'A'`,
        500,
      );
      for (const r of t) {
        if (r.TXTLG && (r.SPRAS === 'E' || !texts.has(r.PROCESS))) texts.set(r.PROCESS, r.TXTLG.trim());
      }
    } catch {
      // A description is an enrichment; the name identifies the process.
    }
  }

  const self: FlowEnd = { type, name };
  return [...byKey.values()]
    .sort((a, b) => a.PROCESS.localeCompare(b.PROCESS))
    .map((r) => {
      const direction = APD_ROLE[r.ASC_TYPE];
      const apd: FlowEnd = { type: 'ANPR', name: r.PROCESS };
      return {
        objectName: r.PROCESS,
        objectType: 'ANPR',
        objectStatus: r.OBJVERS === 'A' ? 'active' : 'inactive',
        objectVersion: '',
        title: texts.get(r.PROCESS) ?? '',
        href: '',
        direction,
        source: direction === 'upstream' ? apd : self,
        target: direction === 'upstream' ? self : apd,
        origin: 'analysis process definition (RSANT_PROCESSI) — read it with bw_read_metadata_tables object_type="ANPR"',
      };
    });
}

/**
 * Status of the analysis process hits the where-used index reports without one, from
 * RSANT_PROCESS. Best effort: without ADT the status simply stays unknown.
 */
async function fillAnalysisProcessStatus(client: BwClient, hits: XrefHit[]): Promise<void> {
  const open = hits.filter((h) => h.objectType === 'ANPR' && h.objectStatus === 'unknown');
  if (open.length === 0) return;
  const versions = new Map<string, Set<string>>();
  try {
    for (const batch of inListBatches(open.map((h) => h.objectName), 150)) {
      const rows = await queryTable(client, `SELECT process, objvers FROM rsant_process WHERE process IN (${batch})`, 500);
      for (const r of rows) versions.set(r.PROCESS, (versions.get(r.PROCESS) ?? new Set()).add(r.OBJVERS));
    }
  } catch {
    return;
  }
  for (const h of open) {
    const v = versions.get(h.objectName);
    if (v) h.objectStatus = v.has('A') ? 'active' : 'inactive';
  }
}

/**
 * bw_xref — find where-used / dependencies for any BW object.
 *
 * Uses: GET /sap/bw/modeling/repo/is/xref?objectType=...&objectName=...
 * Supported objectTypes: ADSO, TRFN, DTPA, IOBJ, etc.
 *
 * Returns all objects that use (reference) the given object, with the direction of every
 * transformation and DTP relative to it. On a classic release the analysis processes that
 * read from or write to a provider are added, since the where-used index leaves them out.
 */
export async function bwXref(
  client: BwClient,
  objectType: string,
  objectName: string,
  sourceSystem?: string,
  platform?: Platform,
): Promise<string> {
  const type = objectType.toUpperCase();
  const name = objectName.toUpperCase();
  const lsys = sourceSystem?.toUpperCase();

  let resolvedName: string;
  if (type === 'RSDS') {
    if (!lsys) throw new Error('bw_xref with object_type RSDS requires source_system parameter.');
    resolvedName = name.padEnd(30) + lsys;
  } else {
    resolvedName = name;
  }

  const path =
    `/sap/bw/modeling/repo/is/xref` +
    `?objectType=${encodeURIComponent(type)}` +
    `&objectName=${encodeURIComponent(resolvedName)}`;

  const result = await client.get(path, 'application/atom+xml;type=feed');
  const hits = annotateXref(parseAtomEntries(result.body), type, name, lsys);
  const notes: string[] = [];

  if (platform === 'classic' && APD_PROVIDER_TYPES.has(type)) {
    const apds = await analysisProcessesOf(client, type, name);
    if (apds === undefined) {
      notes.push(
        'Analysis processes not checked — the ADT DataPreview service is not available for this ' +
          'user. On classic SAP BW they are not part of the where-used index, so an analysis ' +
          'process reading from or writing to this object would not appear above.',
      );
    } else {
      const listed = new Set(hits.filter((h) => h.objectType === 'ANPR').map((h) => h.objectName));
      hits.push(...apds.filter((a) => !listed.has(a.objectName)));
    }
  }

  // The where-used index lists analysis processes without a status (seen under queries).
  if (platform === 'classic') await fillAnalysisProcessStatus(client, hits);

  if (type === 'MPRO') {
    notes.push(
      'The part providers of a MultiProvider are not where-used hits — they come with their type ' +
        'from bw_read_metadata_tables object_type="MPRO".',
    );
  }

  const header = `Where-used (xref): ${type} ${name}${lsys ? ` (${lsys})` : ''}`;
  return formatXref(hits, header, notes);
}
