import { BwClient, createClientFromEnv } from '../bw-client.js';
import { QUERY_ACCEPT_LIST, queryAccept, queryWriteMediaType, variableAccept, ckfAccept, rkfAccept, structureAccept } from './query.js';

/**
 * Query update tools (bw_update_query_layout, bw_update_query_filter).
 *
 * The BW query API is a full-document API: there is no element-wise delta
 * endpoint. Every save GETs the complete query XML, mutates it, and PUTs the
 * whole document back with a lock handle and the timestamp of the version that
 * was read (optimistic locking). New elements are written with !VIRTUAL-nnn
 * placeholder IDs which the server replaces with real UIDs on save.
 * Wire protocol: see payloads/query_edit_save.md and
 * payloads/query_edit_delta_ckf_formula_virtualids.md.
 *
 * Mutation is done by string splicing on well-delimited blocks — the document is
 * never re-serialized, so the server's normalized formatting is preserved for the
 * parts we do not touch.
 */

/** Escape a string for use in an XML attribute value or text node. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A Qry:description element. Text explicitly provided by the caller (custom=true)
 * must carry default="false", otherwise the server discards it (it treats a
 * description without the flag as an auto-generated default and drops it). Text
 * that merely defaults to the technical name keeps the plain form.
 */
function descriptionEl(descEsc: string, custom: boolean): string {
  const def = custom ? 'default="false" ' : '';
  return `<Qry:description ${def}shortValue="${descEsc}" value="${descEsc}"/>`;
}

/**
 * Extract all check-result messages from the atom feed a PUT returns. Each entry
 * carries a messageType attribute and an atom:title. If any messageType is
 * "Error", throw listing the error titles; "Information" and "Warning" are
 * success and are returned as messages.
 */
function parseCheckResult(body: string): string[] {
  const messages: string[] = [];
  const errorTitles: string[] = [];
  const entryRegex = /<atom:entry>([\s\S]*?)<\/atom:entry>/g;
  let entryMatch: RegExpExecArray | null;
  while ((entryMatch = entryRegex.exec(body)) !== null) {
    const entry = entryMatch[1];
    const messageType = entry.match(/messageType="([^"]*)"/)?.[1] ?? '';
    const title = entry.match(/<atom:title>([\s\S]*?)<\/atom:title>/)?.[1]?.trim() ?? '';
    if (messageType === 'Error') {
      errorTitles.push(title || '(no title)');
    } else if (title) {
      messages.push(title);
    }
  }
  if (errorTitles.length > 0) {
    throw new Error(
      `Query save reported errors: ${errorTitles.join('; ')}. ` +
      `NOTE: the query has still been SAVED in an inconsistent state — the server persists the document ` +
      `with error markers rather than rolling back. Correct or remove the offending change with a follow-up operation.`
    );
  }
  return messages;
}

/**
 * Allocate the next free virtual id for the current working document. A fresh GET
 * never contains virtual IDs, so numbering normally starts at 1 and increments
 * per inserted element within one mutation (each insert is scanned by the next
 * allocation).
 */
function allocateVirtualId(doc: string): string {
  let max = 0;
  const re = /!VIRTUAL-(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc)) !== null) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return `!VIRTUAL-${max + 1}`;
}

/**
 * Locate the query's own Qry:filter element inside Qry:mainComponent and return
 * its document offsets ([start, end)). Every selection search and mutation must
 * be scoped to this region: embedded Variable subComponents (which precede
 * mainComponent) carry their own Qry:selections inside Qry:defaultValues, so a
 * document-wide match would corrupt the variable definition instead of the query
 * filter. Handles both the expanded and the self-closing filter form.
 */
function locateFilterRegion(doc: string, what: string): { start: number; end: number } {
  const mainIdx = doc.indexOf('<Qry:mainComponent');
  if (mainIdx < 0) {
    throw new Error(`Could not locate '<Qry:mainComponent' in the query document (${what}).`);
  }
  const filterStart = doc.indexOf('<Qry:filter', mainIdx);
  if (filterStart < 0) {
    throw new Error(`Could not locate '<Qry:filter' in the query document (${what}).`);
  }
  const openTagEnd = doc.indexOf('>', filterStart);
  if (openTagEnd < 0) {
    throw new Error(`Malformed '<Qry:filter' element in the query document (${what}).`);
  }
  // Self-closing form: <Qry:filter .../>
  if (doc[openTagEnd - 1] === '/') {
    return { start: filterStart, end: openTagEnd + 1 };
  }
  const closeTag = '</Qry:filter>';
  const closeIdx = doc.indexOf(closeTag, openTagEnd);
  if (closeIdx < 0) {
    throw new Error(`Could not locate '</Qry:filter>' in the query document (${what}).`);
  }
  return { start: filterStart, end: closeIdx + closeTag.length };
}

/**
 * Expand the query's self-closing filter element (e.g.
 * `<Qry:filter id="..." reusable="false"/>`, the normal state of a freshly
 * created query) to its open/close form so that insert-before-`</Qry:filter>`
 * logic applies. Scoped to the mainComponent's own Qry:filter; a filter that
 * already has a close tag is returned unchanged.
 */
function expandSelfClosingFilter(doc: string): string {
  const region = locateFilterRegion(doc, 'filter expansion');
  const element = doc.slice(region.start, region.end);
  if (element.endsWith('</Qry:filter>')) return doc;
  // element is self-closing (ends with "/>"): drop the "/>" and add open/close.
  const expanded = element.slice(0, -2) + '></Qry:filter>';
  return doc.slice(0, region.start) + expanded + doc.slice(region.end);
}

/** Splice a fragment into the document immediately before the given marker. */
function spliceBefore(doc: string, marker: string, fragment: string, what: string): string {
  const idx = doc.indexOf(marker);
  if (idx < 0) {
    throw new Error(`Could not locate '${marker}' in the query document (${what}).`);
  }
  return doc.slice(0, idx) + fragment + '\n' + doc.slice(idx);
}

/**
 * Insert a fragment immediately before the close tag of the query's own filter
 * element (expanding a self-closing filter first). Scoped to the mainComponent's
 * Qry:filter region so embedded variable subComponents are never touched.
 */
function insertIntoFilter(doc: string, fragment: string, what: string): string {
  const expanded = expandSelfClosingFilter(doc);
  const region = locateFilterRegion(expanded, what);
  const insertAt = region.end - '</Qry:filter>'.length;
  return expanded.slice(0, insertAt) + fragment + '\n' + expanded.slice(insertAt);
}

/**
 * Locate a rows/columns/free Dimension block for the given (uppercased)
 * InfoObject. These blocks never nest, so a lazy match up to the corresponding
 * closing tag captures exactly one element.
 */
function matchDimensionElement(
  doc: string,
  iobj: string
): { container: string; id: string | undefined; start: number; end: number } | null {
  const re = new RegExp(
    `<Qry:(rows|columns|free)\\b[^>]*xsi:type="Qry:Dimension"[^>]*infoObjectName="${escapeRegex(iobj)}"[^>]*>[\\s\\S]*?</Qry:\\1>`
  );
  const m = re.exec(doc);
  if (!m) return null;
  const element = m[0];
  const openTag = element.match(/^<Qry:(?:rows|columns|free)\b[^>]*>/)?.[0] ?? '';
  const id = openTag.match(/\bid="([^"]+)"/)?.[1];
  return { container: m[1], id, start: m.index, end: m.index + element.length };
}

/**
 * Find the first Qry:selections element whose opening tag satisfies the
 * predicate. Handles both the self-closing one-line form and the expanded
 * multi-line form. Selections never nest.
 */
function findSelectionElement(
  doc: string,
  predicate: (openTag: string) => boolean
): { full: string; start: number; end: number } | null {
  const re = /<Qry:selections\b[^>]*?(\/>|>[\s\S]*?<\/Qry:selections>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc)) !== null) {
    const full = m[0];
    const openTag = full.match(/^<Qry:selections\b[^>]*?(?:\/?>)/)?.[0] ?? full;
    if (predicate(openTag)) {
      return { full, start: m.index, end: m.index + full.length };
    }
  }
  return null;
}

/** Remove every Qry:selections element whose opening tag satisfies the predicate. */
function removeSelectionsMatching(doc: string, predicate: (openTag: string) => boolean): string {
  return doc.replace(/<Qry:selections\b[^>]*?(\/>|>[\s\S]*?<\/Qry:selections>)/g, (full) => {
    const openTag = full.match(/^<Qry:selections\b[^>]*?(?:\/?>)/)?.[0] ?? full;
    return predicate(openTag) ? '' : full;
  });
}

/**
 * Find a selection element within the query's own filter region only. Returns
 * document-absolute offsets (mapped back from the region).
 */
function findFilterSelection(
  doc: string,
  predicate: (openTag: string) => boolean
): { full: string; start: number; end: number } | null {
  const region = locateFilterRegion(doc, 'selection lookup');
  const found = findSelectionElement(doc.slice(region.start, region.end), predicate);
  if (!found) return null;
  return { full: found.full, start: region.start + found.start, end: region.start + found.end };
}

/**
 * Remove matching selection elements within the query's own filter region only,
 * leaving any selections inside embedded subComponents untouched.
 */
function removeFilterSelectionsMatching(doc: string, predicate: (openTag: string) => boolean): string {
  const region = locateFilterRegion(doc, 'selection removal');
  const mutated = removeSelectionsMatching(doc.slice(region.start, region.end), predicate);
  return doc.slice(0, region.start) + mutated + doc.slice(region.end);
}

/**
 * Locate the Qry:mainComponent element ([start, end)). Searches for the key
 * figure structure and its members must be scoped to this region: embedded
 * subComponents (reusable structures / CKFs / RKFs) carry member trees of their
 * own and would otherwise be matched by mistake.
 */
function locateMainComponentRegion(doc: string, what: string): { start: number; end: number } {
  const start = doc.indexOf('<Qry:mainComponent');
  if (start < 0) {
    throw new Error(`Could not locate '<Qry:mainComponent' in the query document (${what}).`);
  }
  const closeTag = '</Qry:mainComponent>';
  const closeIdx = doc.indexOf(closeTag, start);
  if (closeIdx < 0) {
    throw new Error(`Could not locate '</Qry:mainComponent>' in the query document (${what}).`);
  }
  return { start, end: closeIdx + closeTag.length };
}

/** Provider name (InfoProvider) from the mainComponent opening tag. */
function mainComponentProviderName(doc: string): string {
  const region = locateMainComponentRegion(doc, 'provider name lookup');
  const openTag = doc.slice(region.start, doc.indexOf('>', region.start) + 1);
  return openTag.match(/\bproviderName="([^"]+)"/)?.[1] ?? '';
}

/** Add firstCustomDimension to the mainComponent opening tag (no-op if present). */
function setFirstCustomDimension(doc: string, id: string): string {
  const start = doc.indexOf('<Qry:mainComponent');
  const openEnd = doc.indexOf('>', start);
  const openTag = doc.slice(start, openEnd + 1);
  if (openTag.includes('firstCustomDimension=')) return doc;
  const newOpenTag = openTag.replace(/^<Qry:mainComponent\b/, `<Qry:mainComponent firstCustomDimension="${id}"`);
  return doc.slice(0, start) + newOpenTag + doc.slice(openEnd + 1);
}

/** True if the mainComponent open tag already carries a firstCustomDimension attribute. */
function mainComponentHasFirstCustomDimension(doc: string): boolean {
  const start = doc.indexOf('<Qry:mainComponent');
  if (start < 0) return false;
  const openTag = doc.slice(start, doc.indexOf('>', start) + 1);
  return openTag.includes('firstCustomDimension=');
}

/**
 * Locate the key figure structure (CustomDimension on 1KYFNM) in rows or columns,
 * scoped to the mainComponent region. These containers never nest, so a lazy
 * match to the matching close tag captures exactly one element.
 *
 * Confirmed against a real captured save/reread (BW/4HANA A4H, 2026-07-26): the
 * infoObjectName we submit at creation time ("1KYFNM") is rewritten by the backend
 * to "1STRUC" once the document is actually saved and reread — "1KYFNM" only ever
 * appears in a document that was never round-tripped through a save. Since every
 * lookup here starts from a fresh GET of an already-saved document, matching only
 * "1KYFNM" meant this could never find a structure created by a prior call — every
 * follow-up edit (add a second key figure, set_member_properties, remove_member)
 * failed with "query has no key figure structure" even though one clearly existed.
 */
function findKeyFigureStructure(
  doc: string
): { container: string; id: string | undefined; element: string; start: number; end: number } | null {
  const region = locateMainComponentRegion(doc, 'key figure structure lookup');
  const sub = doc.slice(region.start, region.end);
  const re = /<Qry:(rows|columns)\b[^>]*?(\/>|>[\s\S]*?<\/Qry:\1>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sub)) !== null) {
    const full = m[0];
    const openTag = full.match(/^<Qry:(?:rows|columns)\b[^>]*?(?:\/?>)/)?.[0] ?? full;
    if (
      openTag.includes('xsi:type="Qry:CustomDimension"') &&
      (openTag.includes('infoObjectName="1KYFNM"') || openTag.includes('infoObjectName="1STRUC"'))
    ) {
      const id = openTag.match(/\bid="([^"]+)"/)?.[1];
      return {
        container: m[1],
        id,
        element: full,
        start: region.start + m.index,
        end: region.start + m.index + full.length,
      };
    }
  }
  return null;
}

/**
 * Locate a rows/columns container element by its structure id (scoped to the
 * mainComponent region). Used to guard against inserting the same reusable
 * structure twice. Containers never nest.
 */
function findContainerByStructureId(doc: string, id: string): boolean {
  const region = locateMainComponentRegion(doc, 'structure id lookup');
  const sub = doc.slice(region.start, region.end);
  const re = /<Qry:(rows|columns)\b[^>]*?(\/>|>[\s\S]*?<\/Qry:\1>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sub)) !== null) {
    const openTag = m[0].match(/^<Qry:(?:rows|columns)\b[^>]*?(?:\/?>)/)?.[0] ?? m[0];
    if (openTag.includes(`id="${id}"`)) return true;
  }
  return false;
}

/**
 * Locate a reusable structure container (rows/columns whose open tag carries
 * reusable="true" and the given technical name), scoped to the mainComponent
 * region. Returns the container element and its structure id.
 */
function findReusableStructureContainer(
  doc: string,
  techNameUpper: string
): { container: string; id: string | undefined; element: string; start: number; end: number } | null {
  const region = locateMainComponentRegion(doc, 'reusable structure lookup');
  const sub = doc.slice(region.start, region.end);
  const re = /<Qry:(rows|columns)\b[^>]*?(\/>|>[\s\S]*?<\/Qry:\1>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sub)) !== null) {
    const full = m[0];
    const openTag = full.match(/^<Qry:(?:rows|columns)\b[^>]*?(?:\/?>)/)?.[0] ?? full;
    if (openTag.includes('reusable="true"') && openTag.includes(`technicalName="${techNameUpper}"`)) {
      return {
        container: m[1],
        id: openTag.match(/\bid="([^"]+)"/)?.[1],
        element: full,
        start: region.start + m.index,
        end: region.start + m.index + full.length,
      };
    }
  }
  return null;
}

/** Remove firstCustomDimension from the mainComponent open tag when it points at id. */
function clearFirstCustomDimension(doc: string, id: string): string {
  const start = doc.indexOf('<Qry:mainComponent');
  if (start < 0) return doc;
  const openEnd = doc.indexOf('>', start);
  const openTag = doc.slice(start, openEnd + 1);
  if (!openTag.match(new RegExp(`\\bfirstCustomDimension="${escapeRegex(id)}"`))) return doc;
  const newOpen = openTag.replace(/\s*firstCustomDimension="[^"]*"/, '');
  return doc.slice(0, start) + newOpen + doc.slice(openEnd + 1);
}

/** Find the id of a subComponent by its technical name (uppercased). */
function findSubComponentIdByTechnicalName(doc: string, techNameUpper: string): string | undefined {
  const re = /<Qry:subComponents\b[^>]*?(\/>|>[\s\S]*?<\/Qry:subComponents>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc)) !== null) {
    const openTag = m[0].match(/^<Qry:subComponents\b[^>]*?(?:\/?>)/)?.[0] ?? m[0];
    if (openTag.includes(`technicalName="${techNameUpper}"`)) {
      return openTag.match(/\bid="([^"]+)"/)?.[1];
    }
  }
  return undefined;
}

/** Extract the CINLink defaultHint value from a member element, if any. */
function cinLinkValue(member: string): string | undefined {
  const dh = member.match(/<Qry:defaultHint>[\s\S]*?<\/Qry:defaultHint>/)?.[0];
  if (!dh || !dh.includes('<Qry:type>CINLink</Qry:type>')) return undefined;
  return dh.match(/<Qry:value>([^<]+)<\/Qry:value>/)?.[1];
}

/**
 * Return the id of the mainComponent-region member that already references the
 * given component via a SelectionTokenForComponent, or undefined. Scoped to the
 * mainComponent so member trees inside embedded subComponents are ignored.
 */
function findMemberReferencingComponent(doc: string, componentId: string): string | undefined {
  const region = locateMainComponentRegion(doc, 'duplicate component check');
  const sub = doc.slice(region.start, region.end);
  const needle = `component="${componentId}"`;
  const memberRe = /<Qry:members\b[^>]*?(\/>|>[\s\S]*?<\/Qry:members>)/g;
  let m: RegExpExecArray | null;
  while ((m = memberRe.exec(sub)) !== null) {
    if (m[0].includes(needle)) {
      return m[0].match(/^<Qry:members\b[^>]*?\bid="([^"]+)"/)?.[1] ?? '(unknown)';
    }
  }
  return undefined;
}

/**
 * Shared read-modify-write engine for query edits.
 *
 * Save cycle (see payloads/query_edit_save.md):
 *   GET full document (+ timestamp header) → lock → PUT mutated document with
 *   lockHandle + timestamp → forceCacheUpdate GET → unlock.
 */
async function withQueryDocument(
  client: BwClient,
  queryName: string,
  mutate: (xml: string) => string,
  corrNr?: string,
): Promise<{ messages: string[] }> {
  const nameLower = queryName.toLowerCase();
  const path = `/sap/bw/modeling/query/${nameLower}/a`;

  const getResult = await client.get(path, queryAccept());
  const timestamp = getResult.headers['timestamp'];
  if (!timestamp) {
    throw new Error(`No timestamp header on GET ${path} — cannot do optimistic locking.`);
  }

  // A prior save that reported check messages (e.g. "Missing InfoObject" warnings) persists
  // those as <Qry:messages .../> elements inside the document itself, not just in the PUT
  // response. Left in place, the *next* save echoes them back verbatim and the backend's
  // PARSE_MODEL rejects the document outright ("cannot process XML element messages") —
  // confirmed against a real captured 500 (BW/4HANA A4H, 2026-07-26). These are response-only
  // annotations, never legitimate input, so strip them before mutating/re-submitting.
  const cleanedBody = getResult.body.replace(/<Qry:messages\b[^>]*\/>/g, '');

  const csrf = await client.getCsrfToken();
  const lockResponse = await client.rawPost(`${path}?action=lock`, '', {
    'Accept': QUERY_ACCEPT_LIST,
    'bwmt-level': '50',
    'x-csrf-token': csrf,
  });
  const lockMatch = lockResponse.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/);
  if (!lockMatch) {
    throw new Error(`No <LOCK_HANDLE> in lock response:\n${lockResponse.body}`);
  }
  const lockHandle = lockMatch[1];

  try {
    const mutated = mutate(cleanedBody);

    const client2 = createClientFromEnv();
    const csrf2 = await client2.getCsrfToken();
    const corrNrPrefix = corrNr ? `corrNr=${corrNr}&` : '';
    const putResponse = await client2.rawPut(
      `${path}?${corrNrPrefix}lockHandle=${lockHandle}`,
      mutated,
      {
        'timestamp': timestamp,
        'Content-Type': `application/xml, ${queryWriteMediaType()}`,
        'Accept': queryAccept(),
        'bwmt-level': '50',
        'x-csrf-token': csrf2,
      });

    const messages = parseCheckResult(putResponse.body);
    await client.get(`${path}?forceCacheUpdate=true`, queryAccept());
    return { messages };
  } finally {
    try {
      await client.rawPost(`${path}?action=unlock`, '', {
        'bwmt-level': '50',
        'x-csrf-token': await client.getCsrfToken(),
      });
    } catch (unlockErr) {
      process.stderr.write(`Warning: failed to unlock query ${nameLower}: ${unlockErr}\n`);
    }
  }
}

// ── Layout ─────────────────────────────────────────────────────────────────

/** Build the Dimension block for a rows/columns/free characteristic. */
function buildLayoutDimension(container: string, vid: string, iobj: string, descEsc: string, descCustom: boolean): string {
  return `<Qry:${container} xsi:type="Qry:Dimension" id="${vid}" infoObjectName="${iobj}">
  ${descriptionEl(descEsc, descCustom)}
  <Qry:defaultHint>
    <Qry:type>InfoObject</Qry:type>
    <Qry:value>${iobj}</Qry:value>
  </Qry:defaultHint>
  <Qry:sorting/>
  <Qry:valuePresentation/>
  <Qry:resultPresentation/>
  <Qry:cumulation/>
  <Qry:planning/>
  <Qry:f4accessVariables/>
  <Qry:f4accessNavigation/>
  <Qry:refreshVariables/>
  <Qry:hierarchy>
    <Qry:name/>
    <Qry:version/>
    <Qry:dateTo/>
    <Qry:expandToLevel/>
    <Qry:positionOfChildNodes/>
    <Qry:valuesOfPostableNodes/>
    <Qry:suppressNodes/>
    <Qry:sorting/>
  </Qry:hierarchy>
  <Qry:attributeSelection/>
  <Qry:displayLevel/>
</Qry:${container}>`;
}

export interface LayoutOperation {
  action: 'add' | 'remove' | 'add_structure' | 'remove_structure';
  /** Container for add / add_structure (free only for characteristics). */
  target?: 'rows' | 'columns' | 'free';
  /** Characteristic technical name (add / remove). */
  infoobject?: string;
  description?: string;
  /** Reusable structure technical name (add_structure / remove_structure). */
  structure_name?: string;
}

export interface UpdateQueryLayoutArgs {
  query_name: string;
  operations: LayoutOperation[];
  transport?: string;
}

/**
 * bw_update_query_layout — add or remove characteristics in the rows, columns, or
 * free-characteristics area of an existing BW Query, and add or remove references
 * to reusable structures (a structure is a layout container). All operations are
 * applied in one read-modify-write save cycle (one PUT).
 */
export async function bwUpdateQueryLayout(
  client: BwClient,
  args: UpdateQueryLayoutArgs
): Promise<string> {
  const ops = args.operations;
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new Error('operations must be a non-empty array.');
  }
  for (const op of ops) {
    if (op.action === 'add') {
      if (!op.infoobject) throw new Error('add requires an infoobject.');
      if (!op.target || !['rows', 'columns', 'free'].includes(op.target)) {
        throw new Error(`add requires a target of rows, columns, or free.`);
      }
    } else if (op.action === 'remove') {
      if (!op.infoobject) throw new Error('remove requires an infoobject.');
    } else if (op.action === 'add_structure') {
      if (!op.structure_name) throw new Error('add_structure requires a structure_name.');
      if (!op.target || !['rows', 'columns'].includes(op.target)) {
        throw new Error('add_structure requires a target of rows or columns.');
      }
    } else if (op.action === 'remove_structure') {
      if (!op.structure_name) throw new Error('remove_structure requires a structure_name.');
    } else {
      throw new Error(`Invalid action '${op.action}' (expected add, remove, add_structure, or remove_structure).`);
    }
  }

  // Resolve every referenced structure up front: the mutate callback is synchronous
  // but structure resolution needs HTTP GETs. Each distinct structure is fetched once.
  const resolvedStructures = new Map<string, ResolvedStructure>();
  for (const op of ops) {
    if (op.action === 'add_structure') {
      const key = `${op.target}:${op.structure_name!.toLowerCase()}`;
      if (!resolvedStructures.has(key)) {
        resolvedStructures.set(key, await resolveStructure(client, op.structure_name!, op.target as 'rows' | 'columns'));
      }
    }
  }

  const summary: string[] = [];
  const mutate = (xml: string): string => {
    let doc = xml;
    for (const op of ops) {
      if (op.action === 'add') {
        const iobj = op.infoobject!.toUpperCase();
        if (matchDimensionElement(doc, iobj)) {
          throw new Error(
            `InfoObject '${iobj}' is already present in the query layout (rows/columns/free).`
          );
        }
        const descEsc = escapeXml(op.description ?? iobj);
        const vid = allocateVirtualId(doc);
        const dimFragment = buildLayoutDimension(op.target!, vid, iobj, descEsc, op.description !== undefined);
        doc = spliceBefore(doc, '<Qry:runtimeProperties', dimFragment, 'layout add: dimension insertion point');
        const selFragment =
          `<Qry:selections xsi:type="Qry:StandardFilterSelection" dimension="${vid}" infoObject="${iobj}" usageType="asStartValue"/>`;
        doc = insertIntoFilter(doc, selFragment, 'layout add: filter bookkeeping entry');
        summary.push(`add ${iobj} to ${op.target}`);
      } else if (op.action === 'remove') {
        const iobj = op.infoobject!.toUpperCase();
        const dim = matchDimensionElement(doc, iobj);
        if (!dim) {
          throw new Error(`InfoObject '${iobj}' is not present in the query layout (rows/columns/free).`);
        }
        doc = doc.slice(0, dim.start) + doc.slice(dim.end);
        if (dim.id) {
          doc = removeFilterSelectionsMatching(
            doc,
            (ot) => ot.includes(`dimension="${dim.id}"`) && ot.includes('usageType="asStartValue"')
          );
        }
        summary.push(`remove ${iobj} from ${dim.container}`);
      } else if (op.action === 'add_structure') {
        const resolved = resolvedStructures.get(`${op.target}:${op.structure_name!.toLowerCase()}`)!;
        if (findContainerByStructureId(doc, resolved.structureId)) {
          throw new Error(`Structure '${resolved.technicalName}' is already present in the query layout.`);
        }
        const isKeyFigureStructure = resolved.infoObjectName === '1KYFNM';
        if (isKeyFigureStructure && findKeyFigureStructure(doc)) {
          throw new Error(
            `The query already has a key figure structure (1KYFNM); it can carry at most one. ` +
            `Remove the existing one before adding '${resolved.technicalName}'.`
          );
        }
        // Carry the structure's referenced CKFs/RKFs into the document (dedup by id).
        for (const extra of resolved.extraSubComponents) {
          if (!hasSubComponentId(doc, extra.id)) {
            doc = insertSubComponent(doc, extra.xml);
          }
        }
        // Insert the container element (keeps the structure's own identity).
        doc = spliceBefore(doc, '<Qry:runtimeProperties', resolved.containerXml, 'add_structure: container insertion');
        if (isKeyFigureStructure && !mainComponentHasFirstCustomDimension(doc)) {
          doc = setFirstCustomDimension(doc, resolved.structureId);
          const selFragment =
            `<Qry:selections xsi:type="Qry:StandardFilterSelection" dimension="${resolved.structureId}" infoObject="1KYFNM" usageType="asStartValue"/>`;
          doc = insertIntoFilter(doc, selFragment, 'add_structure: key figure bookkeeping entry');
        }
        summary.push(`add structure ${resolved.technicalName} to ${op.target}`);
      } else if (op.action === 'remove_structure') {
        const nameUpper = op.structure_name!.toUpperCase();
        const struct = findReusableStructureContainer(doc, nameUpper);
        if (!struct) {
          throw new Error(`Reusable structure '${nameUpper}' is not present in the query layout.`);
        }
        // Refuse if any remaining formula operand references one of the structure's members.
        const memberIds = new Set<string>();
        const idRe = /<Qry:(?:members|childMembers)\b[^>]*?\bid="([^"]+)"/g;
        let im: RegExpExecArray | null;
        while ((im = idRe.exec(struct.element)) !== null) memberIds.add(im[1]);
        const rest = doc.slice(0, struct.start) + doc.slice(struct.end);
        const referencedBy = [...memberIds].filter((id) => new RegExp(`\\bmember="${escapeRegex(id)}"`).test(rest));
        if (referencedBy.length > 0) {
          throw new Error(
            `Cannot remove structure '${nameUpper}': its members are referenced by remaining formula ` +
            `operands (member ids: ${referencedBy.join(', ')}). Remove those formulas first.`
          );
        }
        // Collect the CKF/RKF component ids the structure referenced, for cleanup:
        // the SelectionTokenForComponent tokens (component="…") and every CINLink
        // defaultHint value (order-independent — the GET form lists value before type).
        const refIds = new Set<string>();
        for (const cm of struct.element.matchAll(/\bcomponent="([^"]+)"/g)) refIds.add(cm[1]);
        for (const dh of struct.element.matchAll(/<Qry:defaultHint>[\s\S]*?<\/Qry:defaultHint>/g)) {
          if (dh[0].includes('<Qry:type>CINLink</Qry:type>')) {
            const v = dh[0].match(/<Qry:value>([^<]+)<\/Qry:value>/)?.[1];
            if (v) refIds.add(v);
          }
        }
        // Remove the container, its bookkeeping selection, and firstCustomDimension.
        doc = doc.slice(0, struct.start) + doc.slice(struct.end);
        if (struct.id) {
          doc = removeFilterSelectionsMatching(
            doc,
            (ot) => ot.includes(`dimension="${struct.id}"`) && ot.includes('usageType="asStartValue"')
          );
          doc = clearFirstCustomDimension(doc, struct.id);
        }
        // Drop now-unreferenced subComponents.
        for (const id of refIds) {
          const stillUsed =
            new RegExp(`\\bcomponent="${escapeRegex(id)}"`).test(doc) ||
            doc.includes(`<Qry:value>${id}</Qry:value>`);
          if (!stillUsed) doc = removeSubComponentById(doc, id);
        }
        summary.push(`remove structure ${nameUpper} from ${struct.container}`);
      }
    }
    return doc;
  };

  const { messages } = await withQueryDocument(client, args.query_name, mutate, args.transport);
  return JSON.stringify({
    success: true,
    query_name: args.query_name.toUpperCase(),
    applied_operations: summary,
    check_messages: messages,
  });
}

// ── Filter ───────────────────────────────────────────────────────────────────

export interface FilterValue {
  value: string;
  internal_value?: string;
  description?: string;
  /** Upper bound of an interval; when set the token becomes operator="Between". */
  high?: string;
  high_internal_value?: string;
  high_description?: string;
  /** Emit exclude="true" on the token (exclusion / "not equal") restriction. */
  exclude?: boolean;
}

export interface FilterOperation {
  action: 'set_values' | 'set_variable' | 'remove';
  /**
   * Characteristic technical name. Required for set_values and remove; for
   * set_variable it is derived from the variable definition and may be omitted.
   */
  infoobject?: string;
  values?: FilterValue[];
  /** Technical name of the reusable variable (required for set_variable). */
  variable_name?: string;
}

export interface UpdateQueryFilterArgs {
  query_name: string;
  operations: FilterOperation[];
  transport?: string;
}

/**
 * Build one fixed-value filter token. A single value emits operator="Equal";
 * when a high bound is given it emits operator="Between" with a toValue. exclude
 * produces an exclusion restriction. Attribute order follows the traced wire
 * form (see payloads/query_edit_delta2_variables_structures_ranges.md §5).
 */
function buildFilterToken(v: FilterValue): string {
  const valueEsc = escapeXml(v.value);
  const internalEsc = escapeXml(v.internal_value ?? v.value);
  const excludeAttr = v.exclude ? ' exclude="true"' : '';
  const fromDescAttr = v.description !== undefined ? ` fromValueDesc="${escapeXml(v.description)}"` : '';
  const hasHigh = v.high !== undefined && v.high !== '';
  if (hasHigh) {
    const highEsc = escapeXml(v.high!);
    const highInternalEsc = escapeXml(v.high_internal_value ?? v.high!);
    const toDescAttr = v.high_description !== undefined ? ` toValueDesc="${escapeXml(v.high_description)}"` : '';
    return `<Qry:tokens xsi:type="Qry:SelectionRange" usageType="asFilter"${excludeAttr}${fromDescAttr}${toDescAttr} operator="Between">
  <Qry:fromValue internalValue="${internalEsc}">
    <Qry:type>Value</Qry:type>
    <Qry:value>${valueEsc}</Qry:value>
  </Qry:fromValue>
  <Qry:toValue internalValue="${highInternalEsc}">
    <Qry:type>Value</Qry:type>
    <Qry:value>${highEsc}</Qry:value>
  </Qry:toValue>
</Qry:tokens>`;
  }
  return `<Qry:tokens xsi:type="Qry:SelectionRange" usageType="asFilter"${excludeAttr}${fromDescAttr} operator="Equal">
  <Qry:fromValue internalValue="${internalEsc}">
    <Qry:type>Value</Qry:type>
    <Qry:value>${valueEsc}</Qry:value>
  </Qry:fromValue>
</Qry:tokens>`;
}

/** Build a SelectionVariable token referencing an embedded variable subComponent. */
function buildVariableToken(componentId: string): string {
  return `<Qry:tokens xsi:type="Qry:SelectionVariable" usageType="asFilter" selectionType="areaSelection" operator="Equal" variable="${componentId}"/>`;
}

/** Build a new asFilter StandardFilterSelection block for the InfoObject. */
function buildFilterSelection(vid: string, iobj: string, tokens: string): string {
  return `<Qry:selections xsi:type="Qry:StandardFilterSelection" dimension="${vid}" infoObject="${iobj}" usageType="asFilter">
  <Qry:defaultHint>
    <Qry:type>InfoObject</Qry:type>
    <Qry:value>${iobj}</Qry:value>
  </Qry:defaultHint>
  ${tokens}
  <Qry:localDimension id="${vid}" infoObjectName="${iobj}">
    <Qry:description shortValue="${iobj}" value="${iobj}"/>
    <Qry:defaultHint>
      <Qry:type>InfoObject</Qry:type>
      <Qry:value>${iobj}</Qry:value>
    </Qry:defaultHint>
    <Qry:sorting/>
    <Qry:valuePresentation/>
    <Qry:resultPresentation/>
    <Qry:cumulation/>
    <Qry:planning/>
    <Qry:f4accessVariables/>
    <Qry:f4accessNavigation/>
    <Qry:refreshVariables/>
    <Qry:hierarchy>
      <Qry:name/>
      <Qry:version/>
      <Qry:dateTo/>
      <Qry:expandToLevel/>
      <Qry:positionOfChildNodes/>
      <Qry:valuesOfPostableNodes/>
      <Qry:suppressNodes/>
      <Qry:sorting/>
    </Qry:hierarchy>
    <Qry:attributeSelection/>
    <Qry:displayLevel/>
  </Qry:localDimension>
</Qry:selections>`;
}

/**
 * Replace all Qry:tokens elements of an existing selection with a new token list,
 * keeping the rest (defaultHint, localDimension) intact. Tokens sit between
 * defaultHint and localDimension, so the new list is inserted before
 * localDimension (or before the closing tag if none is present).
 */
function setTokensInSelection(selection: string, newTokens: string): string {
  const stripped = selection.replace(/<Qry:tokens\b[^>]*?(\/>|>[\s\S]*?<\/Qry:tokens>)/g, '');
  const locIdx = stripped.indexOf('<Qry:localDimension');
  if (locIdx >= 0) {
    return stripped.slice(0, locIdx) + newTokens + '\n  ' + stripped.slice(locIdx);
  }
  const closeIdx = stripped.lastIndexOf('</Qry:selections>');
  return stripped.slice(0, closeIdx) + newTokens + '\n' + stripped.slice(closeIdx);
}

/**
 * Set the asFilter selection for a characteristic to the given token list. If a
 * selection already exists it keeps its structure (localDimension) and only its
 * tokens are replaced; otherwise a fresh selection is inserted before
 * `</Qry:filter>`.
 */
function upsertFilterSelection(doc: string, iobj: string, tokens: string): string {
  const existing = findFilterSelection(
    doc,
    (ot) => ot.includes(`infoObject="${iobj}"`) && ot.includes('usageType="asFilter"')
  );
  if (existing) {
    const updated = setTokensInSelection(existing.full, tokens);
    return doc.slice(0, existing.start) + updated + doc.slice(existing.end);
  }
  const vid = allocateVirtualId(doc);
  const selFragment = buildFilterSelection(vid, iobj, tokens);
  return insertIntoFilter(doc, selFragment, 'filter selection insertion');
}

/** True if a Qry:subComponents element with the given id already exists. */
function hasSubComponentId(doc: string, id: string): boolean {
  return new RegExp(`<Qry:subComponents\\b[^>]*\\bid="${escapeRegex(id)}"`).test(doc);
}

/** Insert a subComponents element immediately before Qry:mainComponent. */
function insertSubComponent(doc: string, xml: string): string {
  return spliceBefore(doc, '<Qry:mainComponent', xml, 'subComponent insertion');
}

/** Remove the Qry:subComponents element with the given id (both forms). */
function removeSubComponentById(doc: string, id: string): string {
  return doc.replace(/<Qry:subComponents\b[^>]*?(\/>|>[\s\S]*?<\/Qry:subComponents>)/g, (full) => {
    const openTag = full.match(/^<Qry:subComponents\b[^>]*?(?:\/?>)/)?.[0] ?? full;
    return openTag.includes(`id="${id}"`) ? '' : full;
  });
}

interface ResolvedVariable {
  componentId: string;
  characteristic: string;
  subComponentXml: string;
  extraSubComponents: { id: string; xml: string }[];
}

/**
 * Resolve a reusable variable into an embeddable subComponent plus any transitive
 * subComponents of its own resource. See
 * payloads/query_edit_delta2_variables_structures_ranges.md §1: the variable GET
 * returns a Qry:queryResource whose mainComponent (xsi:type="Qry:Variable") maps
 * 1:1 into a Qry:subComponents element (rename the element, keep everything else).
 * This response shape is a documented working assumption verified on first live
 * call — if it does not hold we stop rather than guess.
 */
async function resolveVariable(client: BwClient, variableName: string): Promise<ResolvedVariable> {
  const nameLower = variableName.toLowerCase();
  const nameUpper = variableName.toUpperCase();

  const existResult = await client.rawGet(
    `/sap/bw/modeling/queryint?action=compexist&compid=${nameLower}&type=VAR`,
    { 'bwmt-level': '50' });
  if (existResult.headers['compexist'] !== 'true') {
    throw new Error(`Variable '${nameUpper}' does not exist (compexist != true).`);
  }
  const elemuid = existResult.headers['elemuid'];

  const varResult = await client.get(`/sap/bw/modeling/variable/${nameLower}/a`, variableAccept());
  const body = varResult.body;

  const mainMatch = body.match(/<Qry:mainComponent\b[^>]*?(\/>|>[\s\S]*?<\/Qry:mainComponent>)/);
  const rootTag = body.match(/<([\w:]+)[\s>]/)?.[1] ?? '(unknown root)';
  const mainElement = mainMatch?.[0] ?? '';
  const openTag = mainElement.match(/^<Qry:mainComponent\b[^>]*?(?:\/?>)/)?.[0] ?? '';
  if (!mainMatch || !openTag.includes('xsi:type="Qry:Variable"')) {
    throw new Error(
      `GET /sap/bw/modeling/variable/${nameLower}/a did not return a mainComponent with ` +
      `xsi:type="Qry:Variable" (response root element: <${rootTag}>). This response format is a ` +
      `documented working assumption to verify — stopping instead of guessing.`
    );
  }

  const mainId = openTag.match(/\bid="([^"]+)"/)?.[1];
  const characteristic = openTag.match(/\binfoObject="([^"]+)"/)?.[1];
  if (!characteristic) {
    throw new Error(`Variable '${nameUpper}' definition carries no infoObject attribute — cannot determine the filter characteristic.`);
  }
  if (mainId && elemuid && mainId !== elemuid) {
    throw new Error(
      `Variable '${nameUpper}' component id mismatch: compexist ELEMUID='${elemuid}', ` +
      `definition id='${mainId}'. Stopping.`
    );
  }
  const componentId = elemuid ?? mainId;
  if (!componentId) {
    throw new Error(`Could not determine the component id for variable '${nameUpper}'.`);
  }

  // Rename mainComponent -> subComponents, keeping all attributes and children.
  const subComponentXml = mainElement
    .replace(/^<Qry:mainComponent\b/, '<Qry:subComponents')
    .replace(/<\/Qry:mainComponent>$/, '</Qry:subComponents>');

  // Carry over the variable resource's own subComponents (transitive references).
  const extraSubComponents: { id: string; xml: string }[] = [];
  const scRe = /<Qry:subComponents\b[^>]*?(\/>|>[\s\S]*?<\/Qry:subComponents>)/g;
  let m: RegExpExecArray | null;
  while ((m = scRe.exec(body)) !== null) {
    const full = m[0];
    const scOpen = full.match(/^<Qry:subComponents\b[^>]*?(?:\/?>)/)?.[0] ?? full;
    const id = scOpen.match(/\bid="([^"]+)"/)?.[1];
    if (id) extraSubComponents.push({ id, xml: full });
  }

  return { componentId, characteristic, subComponentXml, extraSubComponents };
}

/**
 * bw_update_query_filter — set or remove fixed restrictions (single values,
 * intervals, exclusions) and variable references on characteristics of an
 * existing BW Query. All operations are applied in one read-modify-write save
 * cycle (one PUT).
 */
export async function bwUpdateQueryFilter(
  client: BwClient,
  args: UpdateQueryFilterArgs
): Promise<string> {
  const ops = args.operations;
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new Error('operations must be a non-empty array.');
  }
  for (const op of ops) {
    if (op.action === 'set_values') {
      if (!op.infoobject) throw new Error('set_values requires an infoobject.');
      if (!Array.isArray(op.values) || op.values.length === 0) {
        throw new Error(`set_values on '${op.infoobject}' requires a non-empty values array.`);
      }
    } else if (op.action === 'set_variable') {
      if (!op.variable_name) throw new Error('set_variable requires a variable_name.');
    } else if (op.action === 'remove') {
      if (!op.infoobject) throw new Error('remove requires an infoobject.');
    } else {
      throw new Error(`Invalid action '${op.action}' (expected set_values, set_variable, or remove).`);
    }
  }

  // Resolve every referenced variable up front: the mutate callback is synchronous
  // but variable resolution needs HTTP GETs. Each distinct variable is fetched once.
  const resolvedVars = new Map<string, ResolvedVariable>();
  for (const op of ops) {
    if (op.action === 'set_variable') {
      const key = op.variable_name!.toLowerCase();
      if (!resolvedVars.has(key)) {
        resolvedVars.set(key, await resolveVariable(client, op.variable_name!));
      }
    }
  }

  const summary: string[] = [];
  const mutate = (xml: string): string => {
    let doc = xml;
    for (const op of ops) {
      if (op.action === 'set_values') {
        const iobj = op.infoobject!.toUpperCase();
        const tokens = op.values!.map(buildFilterToken).join('\n  ');
        doc = upsertFilterSelection(doc, iobj, tokens);
        summary.push(`set ${op.values!.length} value(s) on ${iobj}`);
      } else if (op.action === 'set_variable') {
        const resolved = resolvedVars.get(op.variable_name!.toLowerCase())!;
        const iobj = resolved.characteristic.toUpperCase();
        // Embed the variable definition (and its transitive references) as
        // subComponents before mainComponent, skipping any already present.
        if (!hasSubComponentId(doc, resolved.componentId)) {
          doc = insertSubComponent(doc, resolved.subComponentXml);
        }
        for (const extra of resolved.extraSubComponents) {
          if (!hasSubComponentId(doc, extra.id)) {
            doc = insertSubComponent(doc, extra.xml);
          }
        }
        const tokens = buildVariableToken(resolved.componentId);
        doc = upsertFilterSelection(doc, iobj, tokens);
        summary.push(`set variable ${op.variable_name!.toUpperCase()} on ${iobj}`);
      } else if (op.action === 'remove') {
        const iobj = op.infoobject!.toUpperCase();
        const found = findFilterSelection(
          doc,
          (ot) => ot.includes(`infoObject="${iobj}"`) && ot.includes('usageType="asFilter"')
        );
        if (!found) {
          throw new Error(`No asFilter selection found for InfoObject '${iobj}'.`);
        }
        // Capture variable ids referenced by this selection before removing it.
        const varIds = [...found.full.matchAll(/\bvariable="([^"]+)"/g)].map((m) => m[1]);
        doc = doc.slice(0, found.start) + doc.slice(found.end);
        // Drop the variable subComponent when no remaining token references it.
        // This scan stays document-wide on purpose: member groups elsewhere can
        // also reference a variable by id.
        for (const varId of varIds) {
          if (!new RegExp(`\\bvariable="${escapeRegex(varId)}"`).test(doc)) {
            doc = removeSubComponentById(doc, varId);
          }
        }
        summary.push(`remove filter on ${iobj}`);
      }
    }
    return doc;
  };

  const { messages } = await withQueryDocument(client, args.query_name, mutate, args.transport);
  return JSON.stringify({
    success: true,
    query_name: args.query_name.toUpperCase(),
    applied_operations: summary,
    check_messages: messages,
  });
}

// ── Key figures ──────────────────────────────────────────────────────────────

export interface KeyFigureRestriction {
  infoobject: string;
  values: FilterValue[];
}

export interface ExceptionAggregation {
  type: string;
  reference_characteristic: string;
}

export interface MemberProperties {
  /** Number of decimal places (0-9). */
  decimals?: number;
  /** Visibility; false restores the empty default element. */
  hidden?: 'hide' | 'showAlways' | 'showNever' | false;
  /** +/- sign inversion. */
  sign_inversion?: boolean;
  /** Exception aggregation, or false to reset it to the empty default. */
  exception_aggregation?: ExceptionAggregation | false;
  /** New description text (written with default="false"). */
  description?: string;
}

/** Recursive formula node; validated structurally at render time. */
export type FormulaNode = Record<string, unknown>;

export interface KeyFigureOperation {
  action: 'add_key_figure' | 'add_ckf' | 'add_rkf' | 'add_formula' | 'remove_member' | 'set_member_properties';
  /** Basic key figure InfoObject name (add_key_figure). */
  infoobject?: string;
  /** Reusable CKF/RKF technical name (add_ckf / add_rkf; also a matcher for remove_member / set_member_properties). */
  component_name?: string;
  /** Member description; defaults to the key figure / component name on add, matches on remove_member / set_member_properties; required for add_formula. */
  description?: string;
  /** Member id; matches directly (takes precedence over description/component_name) on remove_member / set_member_properties. */
  member_id?: string;
  /** Optional local restrictions applied to the member as additional groups. */
  restrictions?: KeyFigureRestriction[];
  /** Formula tree (required for add_formula). */
  formula?: FormulaNode;
  /** Exception aggregation for the member (add_* actions). */
  exception_aggregation?: ExceptionAggregation | false;
  /** Member display properties (add_formula and set_member_properties). */
  properties?: MemberProperties;
}

export interface UpdateQueryKeyFiguresArgs {
  query_name: string;
  structure_target?: 'rows' | 'columns';
  operations: KeyFigureOperation[];
  transport?: string;
}

/** Build the additional restriction groups (one per characteristic) for a member. */
function buildRestrictionGroups(restrictions: KeyFigureRestriction[] | undefined): string {
  if (!restrictions || restrictions.length === 0) return '';
  return restrictions
    .map((r) => {
      if (!r.infoobject) throw new Error('Each restriction requires an infoobject.');
      if (!Array.isArray(r.values) || r.values.length === 0) {
        throw new Error(`Restriction on '${r.infoobject}' requires a non-empty values array.`);
      }
      const iobj = r.infoobject.toUpperCase();
      const tokens = r.values.map(buildFilterToken).join('\n    ');
      return `  <Qry:groups infoObject="${iobj}">
    ${tokens}
  </Qry:groups>
`;
    })
    .join('');
}

/**
 * Build a basic key figure member (MemberSelection with a keyFigure SelectionRange).
 *
 * The decimals/hidden/signInversion/exceptionAggregation placeholders (bare, no
 * attributes — "use system default", same pattern as sorting/valuePresentation/etc.
 * on a regular Dimension row) are required here: omitting them let the backend's
 * own component-verification step dereference something it expects every member to
 * carry, crashing with "System error in program CL_RSR_RRI2_LRECH ...
 * SET_CELL_FLAGS_FROM_COB_PRO" on save — confirmed 100% reproducible on a minimal
 * add-key-figure-to-an-empty-query repro before this fix (BW/4HANA A4H, 2026-07-26).
 */
function buildKeyFigureMember(vid: string, kyf: string, descEsc: string, descCustom: boolean, restrictionGroups: string): string {
  return `<Qry:members xsi:type="Qry:MemberSelection" id="${vid}">
  ${descriptionEl(descEsc, descCustom)}
  <Qry:defaultHint>
    <Qry:type>InfoObject</Qry:type>
    <Qry:value>${kyf}</Qry:value>
  </Qry:defaultHint>
  <Qry:decimals/>
  <Qry:hidden/>
  <Qry:signInversion/>
  <Qry:exceptionAggregation/>
  <Qry:groups description="Key Figures" infoObject="1KYFNM">
    <Qry:tokens xsi:type="Qry:SelectionRange" usageType="asFilter" selectionType="keyFigure" fromValueDesc="${descEsc}" operator="Equal">
      <Qry:fromValue>
        <Qry:type>Value</Qry:type>
        <Qry:value>${kyf}</Qry:value>
      </Qry:fromValue>
    </Qry:tokens>
  </Qry:groups>
${restrictionGroups}</Qry:members>`;
}

/** Build a member referencing a reusable CKF/RKF (CINLink + SelectionTokenForComponent). */
function buildComponentMember(vid: string, componentId: string, descEsc: string, descCustom: boolean, restrictionGroups: string): string {
  return `<Qry:members xsi:type="Qry:MemberSelection" id="${vid}">
  ${descriptionEl(descEsc, descCustom)}
  <Qry:defaultHint>
    <Qry:type>CINLink</Qry:type>
    <Qry:value>${componentId}</Qry:value>
  </Qry:defaultHint>
  <Qry:groups description="Key Figures" infoObject="1KYFNM">
    <Qry:tokens xsi:type="Qry:SelectionTokenForComponent" component="${componentId}"/>
  </Qry:groups>
${restrictionGroups}</Qry:members>`;
}

/** Build an exceptionAggregation element (empty when ea is false/undefined). */
function excAggEl(ea: ExceptionAggregation | false | undefined): string {
  if (!ea) return '<Qry:exceptionAggregation/>';
  if (!ea.type || !ea.reference_characteristic) {
    throw new Error('exception_aggregation requires type and reference_characteristic.');
  }
  return `<Qry:exceptionAggregation exclude="false" type="${escapeXml(ea.type)}">
    <Qry:referenceCharacteristic>${escapeXml(ea.reference_characteristic.toUpperCase())}</Qry:referenceCharacteristic>
  </Qry:exceptionAggregation>`;
}

/**
 * Replace the child element <Qry:{tag}...> inside a member with newXml, or insert
 * newXml before the member's content section if the element is absent. Operates on
 * the first occurrence, which for a well-formed member is the top-level element
 * (display defaults precede any childMembers).
 */
function setMemberChildElement(memberXml: string, tag: string, newXml: string): string {
  const re = new RegExp(`<Qry:${tag}\\b[^>]*?(\\/>|>[\\s\\S]*?<\\/Qry:${tag}>)`);
  if (re.test(memberXml)) {
    return memberXml.replace(re, newXml);
  }
  for (const marker of ['<Qry:formulaDefinition', '<Qry:groups', '<Qry:childMembers', '</Qry:members>']) {
    const idx = memberXml.indexOf(marker);
    if (idx >= 0) return memberXml.slice(0, idx) + newXml + '\n  ' + memberXml.slice(idx);
  }
  return memberXml;
}

/** Apply a MemberProperties object to a member XML string (each field replaces its element). */
function applyMemberProperties(memberXml: string, props: MemberProperties): string {
  let out = memberXml;
  if (props.decimals !== undefined) {
    if (!Number.isInteger(props.decimals) || props.decimals < 0 || props.decimals > 9) {
      throw new Error('decimals must be an integer between 0 and 9.');
    }
    out = setMemberChildElement(out, 'decimals', `<Qry:decimals default="false" number="${props.decimals}"/>`);
  }
  if (props.hidden !== undefined) {
    if (props.hidden === false) {
      out = setMemberChildElement(out, 'hidden', '<Qry:hidden default="true"/>');
    } else if (['hide', 'showAlways', 'showNever'].includes(props.hidden)) {
      out = setMemberChildElement(out, 'hidden', `<Qry:hidden default="false" type="${props.hidden}"/>`);
    } else {
      throw new Error('hidden must be one of "hide", "showAlways", "showNever", or false.');
    }
  }
  if (props.sign_inversion !== undefined) {
    out = setMemberChildElement(out, 'signInversion', `<Qry:signInversion default="false" invert="${props.sign_inversion ? 'true' : 'false'}"/>`);
  }
  if (props.exception_aggregation !== undefined) {
    out = setMemberChildElement(out, 'exceptionAggregation', excAggEl(props.exception_aggregation));
  }
  if (props.description !== undefined) {
    out = setMemberChildElement(out, 'description', descriptionEl(escapeXml(props.description), true));
  }
  return out;
}

interface MatchedMember {
  id: string;
  description: string;
  start: number;
  end: number;
  full: string;
}

/**
 * Find top-level structure members (MemberSelection or MemberFormula) matching the
 * given criteria. member_id takes precedence; otherwise description and/or the
 * CINLink component id must match. Operates on the CustomDimension element string.
 */
function findStructureMembers(
  cdElement: string,
  matcher: { member_id?: string; description?: string; componentId?: string }
): MatchedMember[] {
  const memberRe = /<Qry:members\b[^>]*?(\/>|>[\s\S]*?<\/Qry:members>)/g;
  const matches: MatchedMember[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = memberRe.exec(cdElement)) !== null) {
    const full = mm[0];
    const id = full.match(/^<Qry:members\b[^>]*?\bid="([^"]+)"/)?.[1] ?? '';
    const dv = full.match(/<Qry:description\b[^>]*\bvalue="([^"]*)"/)?.[1] ?? '';
    let ok: boolean;
    if (matcher.member_id !== undefined) {
      ok = id === matcher.member_id;
    } else {
      ok = true;
      if (matcher.description !== undefined && dv !== matcher.description) ok = false;
      if (matcher.componentId !== undefined && cinLinkValue(full) !== matcher.componentId) ok = false;
    }
    if (ok) matches.push({ id, description: dv, start: mm.index, end: mm.index + full.length, full });
  }
  return matches;
}

/**
 * Resolve exactly one top-level structure member by member_id / description /
 * component_name (all scoped to the mainComponent region). Throws with a clear
 * message on no match or an ambiguous match, listing each candidate.
 */
function resolveOneMember(
  doc: string,
  matcher: { member_id?: string; description?: string; component_name?: string },
  context: string
): { member: MatchedMember; cdStart: number } {
  const cd = findKeyFigureStructure(doc);
  if (!cd) {
    throw new Error(`${context}: query has no key figure structure (CustomDimension on 1KYFNM).`);
  }
  let componentId: string | undefined;
  if (!matcher.member_id && matcher.component_name) {
    componentId = findSubComponentIdByTechnicalName(doc, matcher.component_name.toUpperCase());
    if (!componentId) {
      throw new Error(`${context}: no subComponent found for component '${matcher.component_name.toUpperCase()}'.`);
    }
  }
  const matches = findStructureMembers(cd.element, {
    member_id: matcher.member_id,
    description: matcher.description,
    componentId,
  });
  if (matches.length === 0) {
    throw new Error(
      `${context}: no matching member found ` +
      `(member_id='${matcher.member_id ?? ''}', description='${matcher.description ?? ''}', ` +
      `component='${matcher.component_name?.toUpperCase() ?? ''}').`
    );
  }
  if (matches.length > 1) {
    const list = matches.map((m) => `${m.id} (${m.description})`).join('; ');
    throw new Error(`${context}: matched ${matches.length} members: ${list}. Refine the operation with member_id.`);
  }
  return { member: matches[0], cdStart: cd.start };
}

/**
 * Operand count per formula operator code, as [min, max], from the BW analytic engine
 * operator catalog (SAP BW/4HANA "Priority of Formula Operators"). Codes not listed
 * here fall back to the lenient "at least one operand" check so unusual/system-specific
 * operators are not rejected. Codes are matched upper-cased.
 */
const FORMULA_OPERATOR_ARITY: Record<string, [number, number]> = {
  // basic
  '+': [1, 2], '-': [1, 2], '*': [2, 2], '/': [2, 2], '**': [2, 2], DIV: [2, 2], MOD: [2, 2],
  // math (unary)
  ABS: [1, 1], CEIL: [1, 1], FLOOR: [1, 1], FRAC: [1, 1], TRUNC: [1, 1], SIGN: [1, 1],
  SQRT: [1, 1], EXP: [1, 1], LOG: [1, 1], LOG10: [1, 1], MAX0: [1, 1], MIN0: [1, 1],
  // math (binary)
  MAX: [2, 2], MIN: [2, 2],
  // percentage
  '%': [2, 2], '%A': [2, 2], '%_A': [2, 2],
  '%CT': [1, 1], '%GT': [1, 1], '%RT': [1, 1], '%XT': [1, 1], '%YT': [1, 1],
  // data functions
  COUNT: [1, 1], DELTA: [1, 1], NDIV0: [1, 1], NODIM: [1, 1], NOERR: [1, 1], FIX: [1, 1],
  DATE: [1, 1], TIME: [1, 1], CMR: [1, 1],
  SUMCT: [1, 1], SUMGT: [1, 1], SUMRT: [1, 1], SUMXT: [1, 1], SUMYT: [1, 1],
  // trigonometric (unary)
  SIN: [1, 1], COS: [1, 1], TAN: [1, 1], SINH: [1, 1], COSH: [1, 1], TANH: [1, 1],
  ASIN: [1, 1], ACOS: [1, 1], ATAN: [1, 1],
  // boolean
  NOT: [1, 1], AND: [2, 2], OR: [2, 2], XOR: [2, 2],
  '<': [2, 2], '<=': [2, 2], '<>': [2, 2], '==': [2, 2], '>': [2, 2], '>=': [2, 2], '=': [2, 2],
  IF: [3, 3],
};

/**
 * Render a formula node tree. The root element is Qry:formulaToken; nested operands
 * are Qry:childToken. Operator codes +,-,*,/ map to FormulaInfixOperator, any other
 * code to FormulaPrefixOperator. Member / component operands resolve against the
 * current document (mainComponent region).
 */
function renderFormulaNode(node: FormulaNode, doc: string, tag: string): string {
  if (!node || typeof node !== 'object') throw new Error('Invalid formula node.');
  const type = node['type'];
  if (type === 'operator') {
    const rawCode = String(node['code'] ?? '');
    if (!rawCode) throw new Error('Formula operator node requires a code.');
    const code = rawCode.toUpperCase();
    if (code === 'LEAF') {
      // BW encodes LEAF as a dedicated nullary token, not a prefix operator. Emitting it
      // as a zero-child prefix operator makes the generator report the calculation function
      // as blank ("Berechnungsfunktion nicht unterstützt", HTTP 500) and saves the query
      // inconsistent. Reject client-side until a dedicated LEAF token is implemented.
      throw new Error(
        "Formula operator 'LEAF' is not supported by add_formula: BW requires a dedicated " +
        'nullary token encoding, and a zero-operand prefix operator is rejected by the query generator.'
      );
    }
    const operands = Array.isArray(node['operands']) ? (node['operands'] as FormulaNode[]) : [];
    const arity = FORMULA_OPERATOR_ARITY[code];
    if (arity) {
      const [min, max] = arity;
      if (operands.length < min || operands.length > max) {
        const expected = min === max ? `${min}` : `${min}-${max}`;
        throw new Error(
          `Formula operator '${code}' expects ${expected} operand(s) but got ${operands.length}.`
        );
      }
    } else if (operands.length === 0) {
      throw new Error(`Formula operator '${code}' requires at least one operand.`);
    }
    const xsiType = ['+', '-', '*', '/'].includes(code) ? 'Qry:FormulaInfixOperator' : 'Qry:FormulaPrefixOperator';
    const children = operands.map((o) => renderFormulaNode(o, doc, 'Qry:childToken')).join('');
    return `<${tag} xsi:type="${xsiType}" code="${escapeXml(code)}">${children}</${tag}>`;
  }
  if (type === 'member') {
    const { member } = resolveOneMember(
      doc,
      { member_id: node['member_id'] as string | undefined, description: node['description'] as string | undefined },
      'formula member operand'
    );
    return `<${tag} xsi:type="Qry:FormulaMemberOperand" member="${member.id}" operandType="Member"/>`;
  }
  if (type === 'component') {
    const name = node['component_name'];
    if (!name) throw new Error('Formula component operand requires component_name.');
    const nameUpper = String(name).toUpperCase();
    // A query formula must reference a STRUCTURE MEMBER, never a component id
    // directly (operandType="Formula" is rejected by the query generator, see the
    // 2026-07-10 addendum). Resolve the component to the member that wraps it.
    const componentId = findSubComponentIdByTechnicalName(doc, nameUpper);
    if (!componentId) {
      throw new Error(
        `Formula component operand: '${nameUpper}' is not embedded in the query — ` +
        `add the component as a structure member first.`
      );
    }
    const cd = findKeyFigureStructure(doc);
    const needle = `component="${componentId}"`;
    const refs: { id: string; description: string }[] = [];
    if (cd) {
      const memberRe = /<Qry:members\b[^>]*?(\/>|>[\s\S]*?<\/Qry:members>)/g;
      let mm: RegExpExecArray | null;
      while ((mm = memberRe.exec(cd.element)) !== null) {
        const full = mm[0];
        if (full.includes(needle)) {
          refs.push({
            id: full.match(/^<Qry:members\b[^>]*?\bid="([^"]+)"/)?.[1] ?? '',
            description: full.match(/<Qry:description\b[^>]*\bvalue="([^"]*)"/)?.[1] ?? '',
          });
        }
      }
    }
    if (refs.length === 0) {
      throw new Error(
        `Formula component operand: no structure member references component '${nameUpper}' — ` +
        `add the component as a structure member first.`
      );
    }
    if (refs.length > 1) {
      const list = refs.map((r) => `${r.id} (${r.description})`).join('; ');
      throw new Error(
        `Formula component operand: component '${nameUpper}' is referenced by ${refs.length} members: ${list}. ` +
        `Use a { "type": "member", member_id: "..." } operand to pick exactly one.`
      );
    }
    return `<${tag} xsi:type="Qry:FormulaMemberOperand" member="${refs[0].id}" operandType="Member"/>`;
  }
  if (type === 'key_figure') {
    const name = node['name'];
    if (!name) throw new Error('Formula key_figure operand requires name.');
    return `<${tag} xsi:type="Qry:FormulaIObjectOperand" infoObject="${escapeXml(String(name).toUpperCase())}"/>`;
  }
  if (type === 'constant') {
    if (node['value'] === undefined || node['value'] === null) throw new Error('Formula constant operand requires value.');
    return `<${tag} xsi:type="Qry:FormulaConstant" value="${escapeXml(String(node['value']))}"/>`;
  }
  throw new Error(`Unknown formula node type '${String(type)}' (expected operator, member, component, key_figure, or constant).`);
}

/**
 * Build a formula member (MemberFormula) with an empty display-default block in the
 * traced order (see payloads/trace_20260710.log). exceptionAggregation starts empty
 * and is filled in later if requested.
 */
function buildFormulaMember(vid: string, descEsc: string, formulaXml: string): string {
  return `<Qry:members xsi:type="Qry:MemberFormula" id="${vid}">
  ${descriptionEl(descEsc, true)}
  <Qry:defaultHint>
    <Qry:type>Constant</Qry:type>
    <Qry:value>1</Qry:value>
  </Qry:defaultHint>
  <Qry:calculation default="true"/>
  <Qry:emphasize default="true"/>
  <Qry:signInversion default="true"/>
  <Qry:hidden default="true"/>
  <Qry:scaling default="true"/>
  <Qry:decimals default="true"/>
  <Qry:formulaDefinition>${formulaXml}</Qry:formulaDefinition>
  <Qry:exceptionAggregation/>
</Qry:members>`;
}

/** Build a new key figure structure (CustomDimension on 1KYFNM) around a first member. */
function buildKeyFigureStructure(container: string, vid: string, providerName: string, membersXml: string): string {
  return `<Qry:${container} xsi:type="Qry:CustomDimension" id="${vid}" infoObjectName="1KYFNM" providerName="${providerName}" reusable="false">
  <Qry:description shortValue="Key Figures" value="Key Figures"/>
${membersXml}
</Qry:${container}>`;
}

/**
 * Append a member to the query's key figure structure, creating the structure in
 * structureTarget on first use (with firstCustomDimension on the mainComponent and
 * the asStartValue bookkeeping selection for 1KYFNM). If a structure already
 * exists the member is appended to it regardless of structureTarget.
 */
function appendKeyFigureMember(doc: string, memberXml: string, structureTarget: string): string {
  const cd = findKeyFigureStructure(doc);
  if (cd) {
    const closeTag = `</Qry:${cd.container}>`;
    const insertAt = cd.end - closeTag.length;
    return doc.slice(0, insertAt) + memberXml + '\n' + doc.slice(insertAt);
  }
  // Create the structure. Allocate its id against doc + the pending member so it
  // never collides with the member's own virtual id.
  const structVid = allocateVirtualId(doc + memberXml);
  const providerName = mainComponentProviderName(doc);
  const structure = buildKeyFigureStructure(structureTarget, structVid, providerName, memberXml);
  let out = spliceBefore(doc, '<Qry:runtimeProperties', structure, 'key figures: structure insertion');
  out = setFirstCustomDimension(out, structVid);
  const selFragment =
    `<Qry:selections xsi:type="Qry:StandardFilterSelection" dimension="${structVid}" infoObject="1KYFNM" usageType="asStartValue"/>`;
  out = insertIntoFilter(out, selFragment, 'key figures: structure bookkeeping entry');
  return out;
}

interface ResolvedComponent {
  componentId: string;
  description: string;
  subComponentXml: string;
  extraSubComponents: { id: string; xml: string }[];
}

/**
 * Resolve a reusable CKF or RKF into an embeddable subComponent plus its own
 * transitive subComponents (CKFs reference other CKFs). See
 * payloads/query_edit_delta_ckf_formula_virtualids.md and
 * payloads/query_edit_delta2_variables_structures_ranges.md §3: the component GET
 * returns a Qry:queryResource whose mainComponent (xsi:type Qry:CalculatedMeasure
 * resp. Qry:RestrictedMeasure) maps 1:1 into a Qry:subComponents element. If that
 * shape does not hold we stop rather than guess.
 */
async function resolveComponent(
  client: BwClient,
  componentName: string,
  kind: 'ckf' | 'rkf'
): Promise<ResolvedComponent> {
  const nameLower = componentName.toLowerCase();
  const nameUpper = componentName.toUpperCase();
  const accept = kind === 'ckf' ? ckfAccept() : rkfAccept();
  const expectedType = kind === 'ckf' ? 'Qry:CalculatedMeasure' : 'Qry:RestrictedMeasure';

  const { body } = await client.get(`/sap/bw/modeling/${kind}/${nameLower}/a`, accept);

  const mainMatch = body.match(/<Qry:mainComponent\b[^>]*?(\/>|>[\s\S]*?<\/Qry:mainComponent>)/);
  const rootTag = body.match(/<([\w:]+)[\s>]/)?.[1] ?? '(unknown root)';
  const mainElement = mainMatch?.[0] ?? '';
  const openTag = mainElement.match(/^<Qry:mainComponent\b[^>]*?(?:\/?>)/)?.[0] ?? '';
  if (!mainMatch || !openTag.includes(`xsi:type="${expectedType}"`)) {
    throw new Error(
      `GET /sap/bw/modeling/${kind}/${nameLower}/a did not return a mainComponent with ` +
      `xsi:type="${expectedType}" (response root element: <${rootTag}>). Stopping instead of guessing.`
    );
  }

  const componentId = openTag.match(/\bid="([^"]+)"/)?.[1];
  if (!componentId) {
    throw new Error(`Could not determine the component id for ${kind.toUpperCase()} '${nameUpper}'.`);
  }
  const description = mainElement.match(/<Qry:description\b[^>]*\bvalue="([^"]*)"/)?.[1] ?? nameUpper;

  const subComponentXml = mainElement
    .replace(/^<Qry:mainComponent\b/, '<Qry:subComponents')
    .replace(/<\/Qry:mainComponent>$/, '</Qry:subComponents>');

  const extraSubComponents: { id: string; xml: string }[] = [];
  const scRe = /<Qry:subComponents\b[^>]*?(\/>|>[\s\S]*?<\/Qry:subComponents>)/g;
  let m: RegExpExecArray | null;
  while ((m = scRe.exec(body)) !== null) {
    const full = m[0];
    const scOpen = full.match(/^<Qry:subComponents\b[^>]*?(?:\/?>)/)?.[0] ?? full;
    const id = scOpen.match(/\bid="([^"]+)"/)?.[1];
    if (id) extraSubComponents.push({ id, xml: full });
  }

  return { componentId, description, subComponentXml, extraSubComponents };
}

interface ResolvedStructure {
  structureId: string;
  infoObjectName: string;
  technicalName: string;
  /** The structure's mainComponent renamed to the target container element. */
  containerXml: string;
  extraSubComponents: { id: string; xml: string }[];
}

/**
 * Resolve a reusable structure into a container element (rows/columns) that keeps
 * the structure's own identity, plus its referenced CKFs/RKFs as subComponents.
 * See payloads/query_edit_delta2_variables_structures_ranges.md §2: the structure
 * GET returns a Qry:queryResource whose mainComponent (xsi:type Qry:CustomDimension)
 * maps 1:1 into the container — nothing is renumbered, no !VIRTUAL ids. If that
 * shape does not hold we stop rather than guess.
 */
async function resolveStructure(
  client: BwClient,
  structureName: string,
  target: 'rows' | 'columns'
): Promise<ResolvedStructure> {
  const nameLower = structureName.toLowerCase();
  const nameUpper = structureName.toUpperCase();

  const { body } = await client.get(`/sap/bw/modeling/structure/${nameLower}/a`, structureAccept());

  const mainMatch = body.match(/<Qry:mainComponent\b[^>]*?(\/>|>[\s\S]*?<\/Qry:mainComponent>)/);
  const rootTag = body.match(/<([\w:]+)[\s>]/)?.[1] ?? '(unknown root)';
  const mainElement = mainMatch?.[0] ?? '';
  const openTag = mainElement.match(/^<Qry:mainComponent\b[^>]*?(?:\/?>)/)?.[0] ?? '';
  if (!mainMatch || !openTag.includes('xsi:type="Qry:CustomDimension"')) {
    throw new Error(
      `GET /sap/bw/modeling/structure/${nameLower}/a did not return a mainComponent with ` +
      `xsi:type="Qry:CustomDimension" (response root element: <${rootTag}>). Stopping instead of guessing.`
    );
  }

  const structureId = openTag.match(/\bid="([^"]+)"/)?.[1];
  if (!structureId) {
    throw new Error(`Could not determine the structure id for '${nameUpper}'.`);
  }
  const infoObjectName = openTag.match(/\binfoObjectName="([^"]+)"/)?.[1] ?? '';

  // Rename mainComponent -> the target container element, keeping every attribute
  // and child (the structure's full identity and member tree) verbatim.
  const containerXml = mainElement
    .replace(/^<Qry:mainComponent\b/, `<Qry:${target}`)
    .replace(/<\/Qry:mainComponent>$/, `</Qry:${target}>`);

  const extraSubComponents: { id: string; xml: string }[] = [];
  const scRe = /<Qry:subComponents\b[^>]*?(\/>|>[\s\S]*?<\/Qry:subComponents>)/g;
  let m: RegExpExecArray | null;
  while ((m = scRe.exec(body)) !== null) {
    const full = m[0];
    const scOpen = full.match(/^<Qry:subComponents\b[^>]*?(?:\/?>)/)?.[0] ?? full;
    const id = scOpen.match(/\bid="([^"]+)"/)?.[1];
    if (id) extraSubComponents.push({ id, xml: full });
  }

  return { structureId, infoObjectName, technicalName: nameUpper, containerXml, extraSubComponents };
}

/**
 * bw_update_query_key_figures — manage the key figure structure (CustomDimension
 * on 1KYFNM) of an existing BW Query: add basic key figures, add references to
 * reusable CKFs/RKFs (with optional local restrictions), add local formula
 * members, set member display properties (decimals, hidden, sign inversion) and
 * exception aggregation, and remove members. All operations are applied in one
 * read-modify-write save cycle (one PUT).
 *
 * Member operations target the query's 1KYFNM CustomDimension whether it is a
 * local structure (built here) or a reusable structure referenced via
 * bw_update_query_layout add_structure — findKeyFigureStructure matches both
 * forms (the reusable form only carries extra open-tag attributes).
 */
export async function bwUpdateQueryKeyFigures(
  client: BwClient,
  args: UpdateQueryKeyFiguresArgs
): Promise<string> {
  const ops = args.operations;
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new Error('operations must be a non-empty array.');
  }
  const structureTarget = args.structure_target ?? 'columns';
  if (!['rows', 'columns'].includes(structureTarget)) {
    throw new Error(`Invalid structure_target '${structureTarget}' (expected rows or columns).`);
  }
  for (const op of ops) {
    if (op.action === 'add_key_figure') {
      if (!op.infoobject) throw new Error('add_key_figure requires an infoobject.');
    } else if (op.action === 'add_ckf' || op.action === 'add_rkf') {
      if (!op.component_name) throw new Error(`${op.action} requires a component_name.`);
    } else if (op.action === 'add_formula') {
      if (!op.description) throw new Error('add_formula requires a description.');
      if (op.formula === undefined || op.formula === null) throw new Error('add_formula requires a formula.');
    } else if (op.action === 'remove_member') {
      if (!op.description && !op.component_name && !op.member_id) {
        throw new Error('remove_member requires description, component_name, or member_id.');
      }
    } else if (op.action === 'set_member_properties') {
      if (!op.member_id && !op.description && !op.component_name) {
        throw new Error('set_member_properties requires member_id, description, or component_name.');
      }
      if (!op.properties || typeof op.properties !== 'object') {
        throw new Error('set_member_properties requires a properties object.');
      }
    } else {
      throw new Error(
        `Invalid action '${op.action}' (expected add_key_figure, add_ckf, add_rkf, add_formula, ` +
        `remove_member, or set_member_properties).`
      );
    }
  }

  // Resolve every referenced CKF/RKF up front: the mutate callback is synchronous
  // but component resolution needs HTTP GETs. Each distinct component is fetched once.
  const resolvedComponents = new Map<string, ResolvedComponent>();
  for (const op of ops) {
    if (op.action === 'add_ckf' || op.action === 'add_rkf') {
      const kind = op.action === 'add_ckf' ? 'ckf' : 'rkf';
      const key = `${kind}:${op.component_name!.toLowerCase()}`;
      if (!resolvedComponents.has(key)) {
        resolvedComponents.set(key, await resolveComponent(client, op.component_name!, kind));
      }
    }
  }

  const summary: string[] = [];
  const mutate = (xml: string): string => {
    let doc = xml;
    for (const op of ops) {
      if (op.action === 'add_key_figure') {
        const kyf = op.infoobject!.toUpperCase();
        const descEsc = escapeXml(op.description ?? kyf);
        const restrictionGroups = buildRestrictionGroups(op.restrictions);
        const vid = allocateVirtualId(doc);
        let memberXml = buildKeyFigureMember(vid, kyf, descEsc, op.description !== undefined, restrictionGroups);
        if (op.exception_aggregation !== undefined) {
          memberXml = setMemberChildElement(memberXml, 'exceptionAggregation', excAggEl(op.exception_aggregation));
        }
        doc = appendKeyFigureMember(doc, memberXml, structureTarget);
        summary.push(`add key figure ${kyf}`);
      } else if (op.action === 'add_ckf' || op.action === 'add_rkf') {
        const kind = op.action === 'add_ckf' ? 'ckf' : 'rkf';
        const resolved = resolvedComponents.get(`${kind}:${op.component_name!.toLowerCase()}`)!;
        // Embed the component definition (and its transitive references) as
        // subComponents before mainComponent, skipping any already present.
        if (!hasSubComponentId(doc, resolved.componentId)) {
          doc = insertSubComponent(doc, resolved.subComponentXml);
        }
        for (const extra of resolved.extraSubComponents) {
          if (!hasSubComponentId(doc, extra.id)) {
            doc = insertSubComponent(doc, extra.xml);
          }
        }
        const descEsc = escapeXml(op.description ?? resolved.description);
        const restrictionGroups = buildRestrictionGroups(op.restrictions);
        // Warn (but still append — the server allows it) if the component is
        // already referenced by an existing member.
        const dupMemberId = findMemberReferencingComponent(doc, resolved.componentId);
        const vid = allocateVirtualId(doc);
        let memberXml = buildComponentMember(vid, resolved.componentId, descEsc, op.description !== undefined, restrictionGroups);
        if (op.exception_aggregation !== undefined) {
          memberXml = setMemberChildElement(memberXml, 'exceptionAggregation', excAggEl(op.exception_aggregation));
        }
        doc = appendKeyFigureMember(doc, memberXml, structureTarget);
        let entry = `add ${kind.toUpperCase()} ${op.component_name!.toUpperCase()}`;
        if (dupMemberId) {
          entry = `WARNING: component already referenced by member ${dupMemberId} — duplicate mapname — ${entry}`;
        }
        summary.push(entry);
      } else if (op.action === 'add_formula') {
        // Operands resolve against the current document, so members referenced by
        // the formula must already exist (added earlier in this batch or before).
        const formulaXml = renderFormulaNode(op.formula!, doc, 'Qry:formulaToken');
        const descEsc = escapeXml(op.description!);
        const vid = allocateVirtualId(doc);
        let memberXml = buildFormulaMember(vid, descEsc, formulaXml);
        if (op.exception_aggregation !== undefined) {
          memberXml = setMemberChildElement(memberXml, 'exceptionAggregation', excAggEl(op.exception_aggregation));
        }
        if (op.properties) memberXml = applyMemberProperties(memberXml, op.properties);
        doc = appendKeyFigureMember(doc, memberXml, structureTarget);
        summary.push(`add formula member '${op.description}'`);
      } else if (op.action === 'remove_member') {
        // resolveOneMember matches both MemberSelection and MemberFormula members.
        const { member, cdStart } = resolveOneMember(
          doc,
          { member_id: op.member_id, description: op.description, component_name: op.component_name },
          'remove_member'
        );
        const removedMember = member.full;
        doc = doc.slice(0, cdStart + member.start) + doc.slice(cdStart + member.end);
        // Drop subComponents the removed member referenced when nothing else in the
        // document still uses them (scanning component="..." and CINLink values).
        const refIds = new Set<string>();
        for (const cm of removedMember.matchAll(/\bcomponent="([^"]+)"/g)) refIds.add(cm[1]);
        const cin = cinLinkValue(removedMember);
        if (cin) refIds.add(cin);
        for (const id of refIds) {
          const stillUsed =
            new RegExp(`\\bcomponent="${escapeRegex(id)}"`).test(doc) ||
            doc.includes(`<Qry:value>${id}</Qry:value>`);
          if (!stillUsed) doc = removeSubComponentById(doc, id);
        }
        summary.push(`remove member ${member.id}${member.description ? ` (${member.description})` : ''}`);
      } else if (op.action === 'set_member_properties') {
        const { member, cdStart } = resolveOneMember(
          doc,
          { member_id: op.member_id, description: op.description, component_name: op.component_name },
          'set_member_properties'
        );
        const updated = applyMemberProperties(member.full, op.properties!);
        doc = doc.slice(0, cdStart + member.start) + updated + doc.slice(cdStart + member.end);
        summary.push(`set properties on member ${member.id}${member.description ? ` (${member.description})` : ''}`);
      }
    }
    return doc;
  };

  const { messages } = await withQueryDocument(client, args.query_name, mutate, args.transport);
  return JSON.stringify({
    success: true,
    query_name: args.query_name.toUpperCase(),
    applied_operations: summary,
    check_messages: messages,
  });
}

// ── Query-level settings ─────────────────────────────────────────────────────

export interface HierarchyDisplay {
  active?: boolean;
  /** Display level; written two-digit (e.g. 5 → "05"). */
  level?: number;
}

export interface DocumentLinks {
  info_provider?: boolean;
  master_data?: boolean;
  meta_data?: boolean;
}

export interface UpdateQuerySettingsArgs {
  query_name: string;
  description?: string;
  zero_suppression_rows?: boolean;
  zero_suppression_columns?: boolean;
  result_position_top?: boolean;
  result_position_left?: boolean;
  sign_presentation?: string;
  suppress_repeated_key_values?: boolean;
  show_scaling_factor?: boolean;
  adjust_formatting?: boolean;
  zero_presentation_kind?: string;
  zero_presentation_custom_value?: string;
  hierarchy_display_rows?: HierarchyDisplay;
  hierarchy_display_columns?: HierarchyDisplay;
  document_links?: DocumentLinks;
  transport?: string;
}

/**
 * Set attributes on an existing self-closing settings element inside the
 * mainComponent region (the GET always returns the expanded element forms). Each
 * attribute is replaced in place, or appended if absent. Errors when the element
 * itself is missing rather than inventing one.
 */
function setSettingElementAttrs(
  doc: string,
  tag: string,
  attrs: Record<string, string>,
  context: string
): string {
  const region = locateMainComponentRegion(doc, context);
  const sub = doc.slice(region.start, region.end);
  const m = new RegExp(`<Qry:${tag}\\b[^>]*?/>`).exec(sub);
  if (!m) {
    throw new Error(`Setting element <Qry:${tag}/> is missing from the query document (${context}).`);
  }
  let element = m[0];
  for (const [name, value] of Object.entries(attrs)) {
    const attrRe = new RegExp(`\\s${escapeRegex(name)}="[^"]*"`);
    const replacement = ` ${name}="${value}"`;
    element = attrRe.test(element) ? element.replace(attrRe, replacement) : element.replace(/\/>$/, `${replacement}/>`);
  }
  const absStart = region.start + m.index;
  return doc.slice(0, absStart) + element + doc.slice(absStart + m[0].length);
}

/** Set an attribute on the mainComponent open tag (replace in place, or add if absent). */
function setMainComponentAttr(doc: string, name: string, value: string): string {
  const start = doc.indexOf('<Qry:mainComponent');
  if (start < 0) throw new Error(`Could not locate '<Qry:mainComponent' in the query document (settings).`);
  const openEnd = doc.indexOf('>', start);
  let openTag = doc.slice(start, openEnd + 1);
  const attrRe = new RegExp(`\\s${escapeRegex(name)}="[^"]*"`);
  const replacement = ` ${name}="${value}"`;
  openTag = attrRe.test(openTag)
    ? openTag.replace(attrRe, replacement)
    : openTag.replace(/^<Qry:mainComponent\b/, `<Qry:mainComponent${replacement}`);
  return doc.slice(0, start) + openTag + doc.slice(openEnd + 1);
}

/** Set the entityProperties adtCore:description attribute (replace in place, or add if absent). */
function setEntityPropertiesDescription(doc: string, descEsc: string): string {
  const region = locateMainComponentRegion(doc, 'entityProperties description');
  const sub = doc.slice(region.start, region.end);
  const m = /<Qry:entityProperties\b[^>]*>/.exec(sub);
  if (!m) throw new Error('entityProperties element is missing from the query document (settings).');
  let openTag = m[0];
  const attrRe = /\sadtCore:description="[^"]*"/;
  const replacement = ` adtCore:description="${descEsc}"`;
  openTag = attrRe.test(openTag)
    ? openTag.replace(attrRe, replacement)
    : openTag.replace(/^<Qry:entityProperties\b/, `<Qry:entityProperties${replacement}`);
  const absStart = region.start + m.index;
  return doc.slice(0, absStart) + openTag + doc.slice(absStart + m[0].length);
}

/** Replace the query-level Qry:description element and the adtCore:description attribute. */
function setQueryDescription(doc: string, descEsc: string): string {
  const region = locateMainComponentRegion(doc, 'query description');
  const sub = doc.slice(region.start, region.end);
  const m = /<Qry:description\b[^>]*?(\/>|>[\s\S]*?<\/Qry:description>)/.exec(sub);
  if (!m) throw new Error('Query description element is missing from the query document (settings).');
  const newEl = `<Qry:description default="false" value="${descEsc}"/>`;
  const absStart = region.start + m.index;
  const out = doc.slice(0, absStart) + newEl + doc.slice(absStart + m[0].length);
  return setEntityPropertiesDescription(out, descEsc);
}

/**
 * bw_update_query_settings — change query-level display and behaviour settings of
 * an existing BW Query via the shared read-modify-write engine (one PUT). Only the
 * provided settings are applied; the provider, technical name, and package cannot
 * be changed.
 */
export async function bwUpdateQuerySettings(
  client: BwClient,
  args: UpdateQuerySettingsArgs
): Promise<string> {
  const settingKeys = Object.keys(args).filter(
    (k) => k !== 'query_name' && (args as unknown as Record<string, unknown>)[k] !== undefined
  );
  if (settingKeys.length === 0) {
    throw new Error('bw_update_query_settings requires at least one setting to change.');
  }

  const bool = (b: boolean) => (b ? 'true' : 'false');
  const applied: string[] = [];

  const applyHierarchy = (doc: string, tag: string, h: HierarchyDisplay, context: string): string => {
    const attrs: Record<string, string> = {};
    if (h.active !== undefined) attrs['active'] = bool(h.active);
    if (h.level !== undefined) {
      if (!Number.isInteger(h.level) || h.level < 0) throw new Error(`${context}: level must be a non-negative integer.`);
      attrs['level'] = String(h.level).padStart(2, '0');
    }
    if (Object.keys(attrs).length === 0) throw new Error(`${context}: provide active and/or level.`);
    return setSettingElementAttrs(doc, tag, attrs, context);
  };

  const mutate = (xml: string): string => {
    let doc = xml;

    if (args.description !== undefined) {
      doc = setQueryDescription(doc, escapeXml(args.description));
      applied.push('description');
    }

    const zs: Record<string, string> = {};
    if (args.zero_suppression_rows !== undefined) zs['rows'] = bool(args.zero_suppression_rows);
    if (args.zero_suppression_columns !== undefined) zs['columns'] = bool(args.zero_suppression_columns);
    if (Object.keys(zs).length > 0) {
      doc = setSettingElementAttrs(doc, 'zeroSuppression', zs, 'zero suppression');
      applied.push('zero_suppression');
    }

    const rp: Record<string, string> = {};
    if (args.result_position_top !== undefined) rp['onTop'] = bool(args.result_position_top);
    if (args.result_position_left !== undefined) rp['onLeft'] = bool(args.result_position_left);
    if (Object.keys(rp).length > 0) {
      doc = setSettingElementAttrs(doc, 'resultPosition', rp, 'result position');
      applied.push('result_position');
    }

    const zp: Record<string, string> = {};
    if (args.zero_presentation_kind !== undefined) zp['kind'] = escapeXml(args.zero_presentation_kind);
    if (args.zero_presentation_custom_value !== undefined) zp['customValue'] = escapeXml(args.zero_presentation_custom_value);
    if (Object.keys(zp).length > 0) {
      doc = setSettingElementAttrs(doc, 'zeroPresentation', zp, 'zero presentation');
      applied.push('zero_presentation');
    }

    if (args.hierarchy_display_rows) {
      doc = applyHierarchy(doc, 'uniDispHierRows', args.hierarchy_display_rows, 'hierarchy display rows');
      applied.push('hierarchy_display_rows');
    }
    if (args.hierarchy_display_columns) {
      doc = applyHierarchy(doc, 'uniDispHierCols', args.hierarchy_display_columns, 'hierarchy display columns');
      applied.push('hierarchy_display_columns');
    }

    if (args.document_links) {
      const dl: Record<string, string> = {};
      if (args.document_links.info_provider !== undefined) dl['infoProvider'] = bool(args.document_links.info_provider);
      if (args.document_links.master_data !== undefined) dl['masterData'] = bool(args.document_links.master_data);
      if (args.document_links.meta_data !== undefined) dl['metaData'] = bool(args.document_links.meta_data);
      if (Object.keys(dl).length > 0) {
        doc = setSettingElementAttrs(doc, 'documentLinks', dl, 'document links');
        applied.push('document_links');
      }
    }

    if (args.sign_presentation !== undefined) {
      doc = setMainComponentAttr(doc, 'signPresentation', escapeXml(args.sign_presentation));
      applied.push('sign_presentation');
    }
    if (args.suppress_repeated_key_values !== undefined) {
      doc = setMainComponentAttr(doc, 'suppressRepeatedKeyValues', bool(args.suppress_repeated_key_values));
      applied.push('suppress_repeated_key_values');
    }
    if (args.show_scaling_factor !== undefined) {
      doc = setMainComponentAttr(doc, 'showScalingFactor', bool(args.show_scaling_factor));
      applied.push('show_scaling_factor');
    }
    if (args.adjust_formatting !== undefined) {
      doc = setMainComponentAttr(doc, 'adjustFormatting', bool(args.adjust_formatting));
      applied.push('adjust_formatting');
    }

    return doc;
  };

  const { messages } = await withQueryDocument(client, args.query_name, mutate, args.transport);
  return JSON.stringify({
    success: true,
    query_name: args.query_name.toUpperCase(),
    applied_settings: applied,
    check_messages: messages,
  });
}
