import { BwClient, bwNsName } from '../bw-client.js';

interface SearchEntry {
  objectName: string;
  objectType: string;
  objectStatus: string;
  objectVersion: string;
  title: string;
  href: string;
}

/**
 * Parse <atom:entry> elements from a BW search or xref Atom feed.
 */
function parseAtomEntries(xml: string): SearchEntry[] {
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
        objectName: nameMatch[1],
        objectType: typeMatch[1],
        objectStatus: statusMatch?.[1] ?? 'unknown',
        objectVersion: versionMatch?.[1] ?? '',
        title: titleMatch?.[1] ?? '',
        href: hrefMatch?.[1] ?? '',
      });
    }
  }
  return entries;
}

/**
 * Format search/xref entries as a human-readable list.
 */
function formatEntries(entries: SearchEntry[], header: string): string {
  if (entries.length === 0) {
    return `${header}\n\nNo results found.`;
  }
  const lines = [header, '', `Found ${entries.length} result(s):`, ''];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const version = e.objectVersion ? ` [v${e.objectVersion}]` : '';
    lines.push(
      `${i + 1}. ${e.objectName} (${e.objectType}) — ${e.objectStatus}${version}` +
        (e.title ? ` — "${e.title}"` : '') +
        (e.href ? `\n   Path: ${e.href}` : '')
    );
  }
  return lines.join('\n');
}

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
  // Wide date range = no date filtering
  const from = '1970-01-01T00%3A00%3A00Z';
  const to = '2099-12-31T23%3A59%3A59Z';
  const type = objectType ? encodeURIComponent(objectType.toUpperCase()) : '';

  const path =
    `/sap/bw/modeling/repo/is/bwsearch` +
    `?searchTerm=${encodeURIComponent(searchTerm)}` +
    `&searchInName=true&searchInDescription=true` +
    `&objectType=${type}` +
    `&createdOnFrom=${from}&createdOnTo=${to}` +
    `&changedOnFrom=${from}&changedOnTo=${to}`;

  const result = await client.get(path, 'application/atom+xml;type=feed');
  const entries = parseAtomEntries(result.body);

  const header = `BW Search: "${searchTerm}"` + (objectType ? ` (type: ${objectType.toUpperCase()})` : '');
  return formatEntries(entries, header);
}

function padRsdsObjectName(objectName: string): string {
  const upper = objectName.trim().toUpperCase();
  if (upper.length >= 40) return upper;
  const match = upper.match(/^(.*\S)\s+(\S+)$/);
  if (!match) return upper;
  return match[1].padEnd(30) + match[2];
}

/**
 * bw_xref — find where-used / dependencies for any BW object.
 *
 * Uses: GET /sap/bw/modeling/repo/is/xref?objectType=...&objectName=...
 * Supported objectTypes: ADSO, TRFN, DTPA, IOBJ, etc.
 *
 * Returns all objects that use (reference) the given object.
 * Key use: find the Transformation and DTPs that reference an aDSO.
 */
export async function bwXref(
  client: BwClient,
  objectType: string,
  objectName: string,
  sourceSystem?: string,
): Promise<string> {
  let resolvedName: string;
  if (objectType.toUpperCase() === 'RSDS') {
    if (!sourceSystem) throw new Error('bw_xref with object_type RSDS requires source_system parameter.');
    resolvedName = objectName.toUpperCase().padEnd(30) + sourceSystem.toUpperCase();
  } else {
    resolvedName = bwNsName(objectName.toUpperCase());
  }

  const path =
    `/sap/bw/modeling/repo/is/xref` +
    `?objectType=${encodeURIComponent(objectType.toUpperCase())}` +
    `&objectName=${encodeURIComponent(resolvedName)}`;

  const result = await client.get(path, 'application/atom+xml;type=feed');
  const entries = parseAtomEntries(result.body);

  const header = `Where-used (xref): ${objectType.toUpperCase()} ${objectName.toUpperCase()}`;
  return formatEntries(entries, header);
}
