import { BwClient, decodeXmlEntities } from '../bw-client.js';

const BASE = '/sap/bw/modeling/repo/infoproviderstructure';
const CHILDREN_PREFIX = `${BASE}/`;

interface RepoEntry {
  name: string;
  description: string;
  object_type: string;
  object_subtype: string | null;
  status: string | null;
  has_children: boolean;
  self_url: string | null;
  fiori_only: boolean;
  children_path: string | null;
  chain_id?: string;
}

function parseAtomFeed(xml: string): RepoEntry[] {
  const entries: RepoEntry[] = [];
  const entryRegex = /<atom:entry\b[^>]*>([\s\S]*?)<\/atom:entry>/g;
  let em: RegExpExecArray | null;

  while ((em = entryRegex.exec(xml)) !== null) {
    const body = em[1];

    // bwModel:object attributes (may be self-closing or open)
    const bwObjMatch = body.match(/<bwModel:object\b([\s\S]*?)(?:\/>|>)/);
    const bwAttrs = bwObjMatch?.[1] ?? '';
    const objectName = bwAttrs.match(/\bobjectName="([^"]*)"/)?.[1] ?? '';
    const objectType = bwAttrs.match(/\bobjectType="([^"]*)"/)?.[1] ?? '';
    const objectStatusRaw = bwAttrs.match(/\bobjectStatus="([^"]*)"/)?.[1];
    const objectSubtypeRaw = bwAttrs.match(/\bobjectSubtype="([^"]*)"/)?.[1];
    const objectStatus = objectStatusRaw !== undefined ? objectStatusRaw : null;
    const objectSubtype = objectSubtypeRaw !== undefined ? objectSubtypeRaw : null;

    // atom:title
    const title = decodeXmlEntities(body.match(/<atom:title[^>]*>([^<]*)<\/atom:title>/)?.[1] ?? '');

    // atom:link elements
    let selfHref: string | null = null;
    let selfLinkType: string | null = null;
    let childrenHref: string | null = null;

    const linkRegex = /<atom:link\b([\s\S]*?)(?:\/>|>)/g;
    let lm: RegExpExecArray | null;
    while ((lm = linkRegex.exec(body)) !== null) {
      const attrs = lm[1];
      const rel = attrs.match(/\brel="([^"]*)"/)?.[1] ?? '';
      const href = attrs.match(/\bhref="([^"]*)"/)?.[1] ?? '';
      const type = attrs.match(/\btype="([^"]*)"/)?.[1] ?? '';

      if (rel === 'self') {
        selfHref = href || null;
        selfLinkType = type || null;
      } else if (rel === 'http://www.sap.com/bw/modeling/relations:children') {
        childrenHref = href || null;
      }
    }

    // Fiori URL detection (RSPC and similar objects with no REST endpoint)
    const fioriOnly =
      selfLinkType === 'application/vnd.sap-bw-modeling.url' ||
      (selfHref !== null && selfHref.includes('#BWProcessChain'));

    // Chain ID (RSPC objects only)
    let chainId: string | undefined;
    if (fioriOnly && selfHref) {
      const match = selfHref.match(/[?&]chainId=([^&#]+)/);
      if (match) chainId = decodeURIComponent(match[1]);
    }

    // children_path: strip the base prefix to give a path usable with this tool
    let childrenPath: string | null = null;
    if (childrenHref) {
      childrenPath = childrenHref.startsWith(CHILDREN_PREFIX)
        ? childrenHref.slice(CHILDREN_PREFIX.length)
        : childrenHref;
    }

    const entry: RepoEntry = {
      name: objectName,
      description: title,
      object_type: objectType,
      object_subtype: objectSubtype,
      status: objectStatus,
      has_children: childrenHref !== null,
      self_url: selfHref,
      fiori_only: fioriOnly,
      children_path: childrenPath,
    };

    if (chainId !== undefined) entry.chain_id = chainId;

    entries.push(entry);
  }

  return entries;
}

/**
 * Refuse a path that would leave the repository tree.
 *
 * The path becomes part of the request URL, and the HTTP client resolves dot segments before
 * sending. Unchecked, "../" reaches any other service the backend exposes on the same host.
 * Segments are decoded before the comparison because an encoded dot is a dot to the server;
 * encoded slashes inside a segment stay valid, since namespaced names depend on them. The URL
 * parser has the last word, as it is what decides where the request goes.
 */
export function assertRepositoryPath(path: string): void {
  const invalid = () =>
    new Error(`Invalid repository path '${path}': pass "/" or a children_path from a previous result.`);
  if (/[?#\\]/.test(path)) throw invalid();
  for (const segment of path.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw invalid();
    }
    if (decoded === '.' || decoded === '..') throw invalid();
  }
  if (path && !new URL(`${BASE}/${path}`, 'http://bw').pathname.startsWith(CHILDREN_PREFIX)) throw invalid();
}

export async function bwListContents(client: BwClient, path: string): Promise<string> {
  // Normalise: strip leading/trailing slashes, lowercase
  const normalizedPath = (path ?? '').toLowerCase().replace(/^\/+/, '').replace(/\/+$/, '');
  assertRepositoryPath(normalizedPath);
  const url = normalizedPath ? `${BASE}/${normalizedPath}` : BASE;

  const { body } = await client.get(url, 'application/atom+xml');
  const entries = parseAtomFeed(body);

  return JSON.stringify(
    {
      path: path || '/',
      count: entries.length,
      entries,
    },
    null,
    2
  );
}
