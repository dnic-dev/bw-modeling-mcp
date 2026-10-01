import { BwClient } from '../bw-client.js';

const BICS_ACCEPT = 'application/vnd.sap.bw.modeling.bicsresponse-v1_1_0+xml';
const BICS_CONTENT_TYPE = 'application/vnd.sap.bw.modeling.bicsrequest-v1_1_0+xml';
const VALUE_HELP_ACCEPT = 'application/vnd.sap-bw-modeling.isvaluehelp-v1_0_0+xml';

export interface InfoObjectState {
  name: string;
  id: string;
  axis: string;
  hierarchy?: {
    id: string;
    name: string;
    hryId: string;
    hryDateFrom?: string;
    hryDateTo?: string;
  };
  filterValues?: Array<{
    low?: string;
    lowInt?: string;
    lowText?: string;
    high?: string;
    op?: string;
    sign?: string;
    nodeId?: number;
    nodeType?: string;
  }>;
}

/**
 * The node type a hierarchy-node filter value is sent with, or undefined for a plain member.
 *
 * BW selects a hierarchy node only through the `nodeName` attribute of a selectValue: the
 * reporting endpoint looks that name up among the node types of the query's hierarchy and
 * sets it on the selection. `nodeId` is read and never used, so a value sent with nodeId=1
 * alone is filtered as an ordinary member — "No data available" for a node key, or "Filter
 * changed" when the key does not convert. A node type is the InfoObject of the node:
 * 0HIER_NODE for text nodes, the characteristic itself for nodes that are characteristic
 * values. Without an explicit type, nodeId=1 assumes the latter, the characteristic of the
 * state entry (its attribute for a navigation attribute).
 */
export function hierarchyNodeType(
  iobjName: string,
  fv: { nodeId?: number; nodeType?: string },
): string | undefined {
  if (fv.nodeType) return fv.nodeType;
  if (fv.nodeId !== 1) return undefined;
  return iobjName.includes('__') ? iobjName.slice(iobjName.lastIndexOf('__') + 2) : iobjName;
}

export interface DrillOperation {
  axis: 'ROWS' | 'COLUMNS';
  drill_state: 3 | 2;
  tuple_idx: number;
  element_idx: number;
}

export interface VariableInput {
  name: string;
  id: string;
  txt?: string;
  altName?: string;
  type?: string;
  inputEnabled?: boolean;
  mandatory?: boolean;
  iobj?: string;
  values: Array<{
    low: string;
    high?: string;
    op?: string;
    sign?: string;
  }>;
}

// ── XML helpers ────────────────────────────────────────────────────────────────

function attr(s: string, name: string): string | null {
  const m = s.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Parsing ────────────────────────────────────────────────────────────────────

interface TupleValue {
  id: string;
  sid: string;
  selType: string;
  extKey: string;
  intKey: string;
  txt: string;
  drillSt?: string;
  dispLvl?: string;
}

interface Tuple {
  tid: string;
  values: TupleValue[];
}

interface TupleSection {
  headers: Array<{ name: string; txt: string; id: string }>;
  tuples: Tuple[];
}

function parseQueryViewAttrs(xml: string): Record<string, string | null> {
  const m = xml.match(/<queryView\b([\s\S]*?)>/);
  const a = m?.[1] ?? '';
  return {
    name: attr(a, 'name'),
    txt: attr(a, 'txt'),
    dataRollup: attr(a, 'dataRollup'),
  };
}

interface MetaData {
  infoProvider: string | null;
  infoProviderText: string | null;
  keyFigures: Array<{ name: string; txt: string; id: string; dataType: string }>;
  characteristics: Array<{ name: string; txt: string; id: string; axis: string; isStructure: string }>;
}

function parseMetaData(xml: string): MetaData | null {
  const mdMatch = xml.match(/<metaData\b([\s\S]*?)>([\s\S]*?)<\/metaData>/);
  if (!mdMatch) return null;
  const mdAttrs = mdMatch[1];
  const mdBody = mdMatch[2];

  const keyFigures: MetaData['keyFigures'] = [];
  const kfBlock = mdBody.match(/<keyFigures>([\s\S]*?)<\/keyFigures>/)?.[1] ?? '';
  const entryRe = /<entry\b([\s\S]*?)(?:\/>|>)/g;
  let em: RegExpExecArray | null;
  while ((em = entryRe.exec(kfBlock)) !== null) {
    const a = em[1];
    keyFigures.push({
      name: attr(a, 'name') ?? '',
      txt: attr(a, 'txt') ?? '',
      id: attr(a, 'id') ?? '',
      dataType: attr(a, 'dataType') ?? '',
    });
  }

  const characteristics: MetaData['characteristics'] = [];
  const chaBlock = mdBody.match(/<characteristics>([\s\S]*?)<\/characteristics>/)?.[1] ?? '';
  entryRe.lastIndex = 0;
  while ((em = entryRe.exec(chaBlock)) !== null) {
    const a = em[1];
    characteristics.push({
      name: attr(a, 'name') ?? '',
      txt: attr(a, 'txt') ?? '',
      id: attr(a, 'id') ?? '',
      axis: attr(a, 'axis') ?? '',
      isStructure: attr(a, 'isStructure') ?? 'false',
    });
  }

  return {
    infoProvider: attr(mdAttrs, 'infoProvider'),
    infoProviderText: attr(mdAttrs, 'infoProviderText'),
    keyFigures,
    characteristics,
  };
}

interface SelectValue {
  low: string;
  high?: string;
  op: string;
  sign: string;
  presentationMode: string;
}

interface Variable {
  id: string;
  name: string;
  altName: string;
  txt: string;
  iobj: string;
  mandatory: string;
  inputEnabled: string;
  selectValues: SelectValue[];
}

interface VariablesContainer {
  size: string | null;
  inputRequired: string | null;
  variables: Variable[];
}

function parseVariablesContainer(xml: string): VariablesContainer | null {
  const vcMatch = xml.match(/<variablesContainer\b([\s\S]*?)>([\s\S]*?)<\/variablesContainer>/);
  if (!vcMatch) return null;
  const vcAttrs = vcMatch[1];
  const vcBody = vcMatch[2];

  const variables: Variable[] = [];
  const varRe = /<variable\b([\s\S]*?)>([\s\S]*?)<\/variable>/g;
  let vm: RegExpExecArray | null;
  while ((vm = varRe.exec(vcBody)) !== null) {
    const vAttrs = vm[1];
    const vBody = vm[2];
    const selectValues: SelectValue[] = [];
    const svRe = /<selectValue\b([\s\S]*?)(?:\/>|>)/g;
    let sv: RegExpExecArray | null;
    while ((sv = svRe.exec(vBody)) !== null) {
      const svA = sv[1];
      const high = attr(svA, 'high');
      const svObj: SelectValue = {
        low: attr(svA, 'low') ?? '',
        op: attr(svA, 'op') ?? '',
        sign: attr(svA, 'sign') ?? '',
        presentationMode: attr(svA, 'presentationMode') ?? '',
      };
      if (high !== null) svObj.high = high;
      selectValues.push(svObj);
    }
    variables.push({
      id: attr(vAttrs, 'id') ?? '',
      name: attr(vAttrs, 'name') ?? '',
      altName: attr(vAttrs, 'altName') ?? '',
      txt: attr(vAttrs, 'txt') ?? '',
      iobj: attr(vAttrs, 'iobj') ?? '',
      mandatory: attr(vAttrs, 'mandatory') ?? '',
      inputEnabled: attr(vAttrs, 'inputEnabled') ?? '',
      selectValues,
    });
  }

  return {
    size: attr(vcAttrs, 'size'),
    inputRequired: attr(vcAttrs, 'inputRequired'),
    variables,
  };
}

interface SpaceFilter {
  id: string;
  name: string;
  selectValues: Array<{ lowInt: string; op: string; sign: string }>;
}

function parseSpace(xml: string): SpaceFilter[] {
  const spaceMatch = xml.match(/<space>([\s\S]*?)<\/space>/);
  if (!spaceMatch) return [];
  const result: SpaceFilter[] = [];
  const ioRe = /<infoObject\b([\s\S]*?)>([\s\S]*?)<\/infoObject>/g;
  let io: RegExpExecArray | null;
  while ((io = ioRe.exec(spaceMatch[1])) !== null) {
    const ioAttrs = io[1];
    const ioBody = io[2];
    const selectValues: SpaceFilter['selectValues'] = [];
    const svRe = /<selectValue\b([\s\S]*?)(?:\/>|>)/g;
    let sv: RegExpExecArray | null;
    while ((sv = svRe.exec(ioBody)) !== null) {
      const svA = sv[1];
      selectValues.push({
        lowInt: attr(svA, 'lowInt') ?? attr(svA, 'low') ?? '',
        op: attr(svA, 'op') ?? '',
        sign: attr(svA, 'sign') ?? '',
      });
    }
    result.push({
      id: attr(ioAttrs, 'id') ?? '',
      name: attr(ioAttrs, 'name') ?? '',
      selectValues,
    });
  }
  return result;
}

interface ResultSet {
  fromRow: string;
  toRow: string;
  columnHeaders: Array<{ name: string; txt: string; id: string }>;
  columnTuples: Tuple[];
  rowHeaders: Array<{ name: string; txt: string; id: string }>;
  rowTuples: Tuple[];
  cells: Array<{ crv: string; txt: string; row: string; col: string; mcu?: boolean }>;
}

function parseTupleSection(sectionXml: string): TupleSection {
  const headersBlock = sectionXml.match(/<headers>([\s\S]*?)<\/headers>/)?.[1] ?? '';
  const headers: TupleSection['headers'] = [];
  const hRe = /<entry\b([\s\S]*?)(?:\/>|>)/g;
  let hm: RegExpExecArray | null;
  while ((hm = hRe.exec(headersBlock)) !== null) {
    const ha = hm[1];
    headers.push({ name: attr(ha, 'name') ?? '', txt: attr(ha, 'txt') ?? '', id: attr(ha, 'id') ?? '' });
  }

  const tuplesBlock = sectionXml.match(/<tuples\b[^>]*>([\s\S]*?)<\/tuples>/)?.[1] ?? '';
  const tuples: Tuple[] = [];
  const tRe = /<tuple\b([\s\S]*?)>([\s\S]*?)<\/tuple>/g;
  let tm: RegExpExecArray | null;
  while ((tm = tRe.exec(tuplesBlock)) !== null) {
    const tAttrs = tm[1];
    const tBody = tm[2];
    const values: TupleValue[] = [];
    const vRe = /<value\b([\s\S]*?)(?:\/>|>)/g;
    let vm: RegExpExecArray | null;
    while ((vm = vRe.exec(tBody)) !== null) {
      const va = vm[1];
      const v: TupleValue = {
        id: attr(va, 'id') ?? '',
        sid: attr(va, 'sid') ?? '',
        selType: attr(va, 'selType') ?? '',
        extKey: attr(va, 'extKey') ?? '',
        intKey: attr(va, 'intKey') ?? '',
        txt: attr(va, 'txt') ?? '',
      };
      const drillSt = attr(va, 'drillSt');
      const dispLvl = attr(va, 'dispLvl');
      if (drillSt !== null) v.drillSt = drillSt;
      if (dispLvl !== null) v.dispLvl = dispLvl;
      values.push(v);
    }
    tuples.push({ tid: attr(tAttrs, 'tid') ?? '', values });
  }

  return { headers, tuples };
}

function parseResultSet(xml: string): ResultSet {
  if (/<resultSet\s*\/>/.test(xml)) {
    return {
      fromRow: '0',
      toRow: '1000',
      columnHeaders: [],
      columnTuples: [],
      rowHeaders: [],
      rowTuples: [],
      cells: [],
    };
  }

  const rsMatch = xml.match(/<resultSet\b([\s\S]*?)>([\s\S]*?)<\/resultSet>/);
  const rsAttrs = rsMatch?.[1] ?? '';
  const rsBody = rsMatch?.[2] ?? '';

  const columnsMatch = rsBody.match(/<columns\b[^>]*>([\s\S]*?)<\/columns>/);
  const rowsMatch = rsBody.match(/<rows\b[^>]*>([\s\S]*?)<\/rows>/);
  const colParsed = columnsMatch ? parseTupleSection(columnsMatch[1]) : { headers: [], tuples: [] };
  const rowParsed = rowsMatch ? parseTupleSection(rowsMatch[1]) : { headers: [], tuples: [] };

  const cells: ResultSet['cells'] = [];
  const dataBlock = rsBody.match(/<data\b[^>]*>([\s\S]*?)<\/data>/)?.[1] ?? '';
  const cellRe = /<cell\b([\s\S]*?)(?:\/>|>)/g;
  let cm: RegExpExecArray | null;
  while ((cm = cellRe.exec(dataBlock)) !== null) {
    const ca = cm[1];
    cells.push({
      crv: attr(ca, 'crv') ?? '',
      txt: attr(ca, 'txt') ?? '',
      row: attr(ca, 'row') ?? '',
      col: attr(ca, 'col') ?? '',
      mcu: attr(ca, 'mcu') === 'true',
    });
  }

  return {
    fromRow: attr(rsAttrs, 'fromRow') ?? '0',
    toRow: attr(rsAttrs, 'toRow') ?? '1000',
    columnHeaders: colParsed.headers,
    columnTuples: colParsed.tuples,
    rowHeaders: rowParsed.headers,
    rowTuples: rowParsed.tuples,
    cells,
  };
}

function parseMessages(xml: string): Array<{ type: string; txt: string }> {
  const msgMatch = xml.match(/<messages>([\s\S]*?)<\/messages>/);
  if (!msgMatch) return [];
  const msgs: Array<{ type: string; txt: string }> = [];
  const eRe = /<entry\b([\s\S]*?)(?:\/>|>)/g;
  let em: RegExpExecArray | null;
  while ((em = eRe.exec(msgMatch[1])) !== null) {
    const ea = em[1];
    msgs.push({ type: attr(ea, 'type') ?? '', txt: attr(ea, 'txt') ?? '' });
  }
  return msgs;
}

/**
 * The hierarchy BW reports per InfoObject in the `<state>` of a response, keyed by
 * InfoObject id; an InfoObject without a hierarchy maps to null.
 */
export function parseStateHierarchies(xml: string): Map<string, { name: string; hryId: string } | null> {
  const result = new Map<string, { name: string; hryId: string } | null>();
  const stateMatch = xml.match(/<state>([\s\S]*?)<\/state>/);
  if (!stateMatch) return result;
  const ioRe = /<infoObject\b([^>]*?)(?:\/>|>([\s\S]*?)<\/infoObject>)/g;
  let io: RegExpExecArray | null;
  while ((io = ioRe.exec(stateMatch[1])) !== null) {
    const id = attr(io[1], 'id');
    if (id === null) continue;
    const hry = io[2]?.match(/<hierarchy\b([^>]*?)\/?>/);
    result.set(id, hry ? { name: attr(hry[1], 'name') ?? '', hryId: attr(hry[1], 'hryId') ?? '' } : null);
  }
  return result;
}

/**
 * One line per requested hierarchy that BW did not apply. The reporting endpoint reads the
 * `<hierarchy>` element of a request and discards it — the hierarchy always comes from the
 * query definition — and it says nothing about that. A caller that tried to switch a
 * hierarchy off or to another one would otherwise read the unchanged result as an answer.
 */
export function hierarchyMismatchNotes(state: { infoObjects: InfoObjectState[] } | undefined, xml: string): string[] {
  const requested = (state?.infoObjects ?? []).filter((io) => io.hierarchy);
  if (requested.length === 0) return [];
  const reported = parseStateHierarchies(xml);
  const notes: string[] = [];
  for (const io of requested) {
    if (!reported.has(io.id)) continue;
    const want = io.hierarchy!.name ?? '';
    const got = reported.get(io.id);
    if ((got?.name ?? '') === want) continue;
    const wantText = want ? `hierarchy ${want}` : 'no hierarchy';
    const gotText = got ? `hierarchy ${got.name}${got.hryId ? ` (${got.hryId})` : ''}` : 'no hierarchy';
    notes.push(
      `  ${io.name}: ${wantText} was requested, BW applied ${gotText}. The hierarchy comes from the query ` +
      'definition and cannot be changed through the request; change the query (bw_update_query_characteristic) ' +
      'or use a copy of it.',
    );
  }
  return notes;
}

interface SelectValueAttrs {
  sign: string;
  op: string;
  low: string;
  lowInt: string;
  high: string;
  highInt: string;
}

function parseSelectValueAttrs(body: string): SelectValueAttrs[] {
  const values: SelectValueAttrs[] = [];
  const svRe = /<selectValue\b([^>]*?)\/?>/g;
  let sv: RegExpExecArray | null;
  while ((sv = svRe.exec(body)) !== null) {
    const a = sv[1];
    values.push({
      sign: attr(a, 'sign') ?? 'I',
      op: attr(a, 'op') ?? 'EQ',
      low: attr(a, 'low') ?? '',
      lowInt: attr(a, 'lowInt') ?? '',
      high: attr(a, 'high') ?? '',
      highInt: attr(a, 'highInt') ?? '',
    });
  }
  return values;
}

/**
 * The selection BW actually applied, per InfoObject id, from the `<effective>` element of a
 * response. A value BW rejected is missing there or changed: an excluded hierarchy node, for
 * instance, comes back as included, and an interval without its upper bound as "BT low".
 */
export function parseEffectiveSelections(xml: string): Map<string, SelectValueAttrs[]> {
  const result = new Map<string, SelectValueAttrs[]>();
  const effMatch = xml.match(/<effective>([\s\S]*?)<\/effective>/);
  if (!effMatch) return result;
  const ioRe = /<infoObject\b([^>]*?)(?:\/>|>([\s\S]*?)<\/infoObject>)/g;
  let io: RegExpExecArray | null;
  while ((io = ioRe.exec(effMatch[1])) !== null) {
    const id = attr(io[1], 'id');
    if (id !== null) result.set(id, parseSelectValueAttrs(io[2] ?? ''));
  }
  return result;
}

const sameKey = (a: string, b: string) => a !== '' && a.toUpperCase() === b.toUpperCase();

function describeValue(sign: string, op: string, low: string, high: string): string {
  return `${sign === 'E' ? 'exclude ' : ''}${op} ${low}${high ? `..${high}` : ''}`;
}

/**
 * One line per requested filter value that BW applied differently, or not at all, judged
 * against the effective selection of the response. BW raises a message for some of these
 * ("Filter changed") and for others none: an excluded hierarchy node is silently turned into
 * an included one. A value given as low is compared only where it can be matched, since BW
 * may convert an external key to another internal form; a missing internal key is reported.
 */
export function filterMismatchNotes(state: { infoObjects: InfoObjectState[] } | undefined, xml: string): string[] {
  const requested = (state?.infoObjects ?? []).filter((io) => (io.filterValues ?? []).length > 0);
  if (requested.length === 0 || !/<effective\b/.test(xml)) return [];
  const effective = parseEffectiveSelections(xml);
  // An empty effective element says nothing: BW leaves it empty, for one, when a filter meets a
  // query-defined restriction on the same characteristic and the result is empty.
  if (effective.size === 0) return [];
  const notes: string[] = [];
  for (const io of requested) {
    const applied = effective.get(io.id) ?? [];
    if (applied.length === 0) {
      notes.push(`  ${io.name}: the filter was not applied — BW reports no effective selection for it.`);
      continue;
    }
    for (const fv of io.filterValues ?? []) {
      const key = fv.lowInt || fv.low || '';
      const match = applied.find((e) => sameKey(e.lowInt, key) || sameKey(e.low, key));
      const wantSign = fv.sign ?? 'I';
      const wantOp = fv.op ?? 'EQ';
      const wantHigh = fv.high ?? '';
      if (!match) {
        if (fv.lowInt) {
          notes.push(`  ${io.name}: ${describeValue(wantSign, wantOp, key, wantHigh)} is not in the effective selection.`);
        }
        continue;
      }
      const gotHigh = match.highInt || match.high;
      const highDiffers = wantHigh !== '' ? !sameKey(gotHigh, wantHigh) : false;
      if (match.sign !== wantSign || match.op !== wantOp || highDiffers) {
        notes.push(
          `  ${io.name}: ${describeValue(wantSign, wantOp, key, wantHigh)} was requested, ` +
          `BW applied ${describeValue(match.sign, match.op, match.lowInt || match.low, gotHigh)}.`,
        );
      }
    }
  }
  return notes;
}

/**
 * Characteristics and structures that dropped out of rows and columns. In a request with a
 * state, the result shows on ROWS and COLUMNS exactly what the state lists there, in that
 * order: every other one drops out — even when only a FREE characteristic is listed — while
 * the state BW echoes still shows it on its old axis. A request without a state keeps the
 * query's layout. Judged against the result headers; an empty result is not judged.
 */
export function axisDropNotes(state: { infoObjects: InfoObjectState[] } | undefined, xml: string): string[] {
  const listed = state?.infoObjects ?? [];
  if (listed.length === 0) return [];
  const stateMatch = xml.match(/<state>([\s\S]*?)<\/state>/);
  const rsBody = xml.match(/<resultSet\b[^>]*>([\s\S]*?)<\/resultSet>/)?.[1];
  if (!stateMatch || !rsBody) return [];
  const shown = new Set<string>();
  for (const section of ['rows', 'columns']) {
    const headers = rsBody.match(new RegExp(`<${section}\\b[^>]*>[\\s\\S]*?<headers>([\\s\\S]*?)</headers>`))?.[1] ?? '';
    for (const h of headers.matchAll(/<entry\b([^>]*?)\/?>/g)) {
      const id = attr(h[1], 'id');
      if (id) shown.add(id);
    }
  }
  const listedIds = new Set(listed.map((io) => io.id));
  const notes: string[] = [];
  for (const axis of ['ROWS', 'COLUMNS']) {
    const dropped: Array<{ name: string; pos: number }> = [];
    for (const io of stateMatch[1].matchAll(/<infoObject\b([^>]*?)(?:\/>|>)/g)) {
      const id = attr(io[1], 'id');
      if (!id || listedIds.has(id) || attr(io[1], 'axis') !== axis || shown.has(id)) continue;
      dropped.push({ name: attr(io[1], 'name') ?? id, pos: Number(attr(io[1], 'pos') ?? 0) });
    }
    if (dropped.length > 0) {
      // In the query's order, which is the order to list them in.
      const names = dropped.sort((a, b) => a.pos - b.pos).map((d) => d.name);
      const one = names.length === 1;
      notes.push(
        `  ${axis}: ${names.join(', ')} ${one ? 'is' : 'are'} not in the result. With a state, rows and columns ` +
        `show only what it lists there; list ${one ? 'it' : 'them'} on ${axis} too (in the order wanted, ` +
        'structures included) to keep the query\'s layout.',
      );
    }
  }
  return notes;
}

/** Everything the request asked for that BW did not apply as asked, for the text answer. */
export function notAppliedNotes(state: { infoObjects: InfoObjectState[] } | undefined, xml: string): string[] {
  return [...hierarchyMismatchNotes(state, xml), ...filterMismatchNotes(state, xml), ...axisDropNotes(state, xml)];
}

// ── Text rendering ──────────────────────────────────────────────────────────────

// Renders a human-readable label for a tuple's values.
// Handles: normal members, hierarchy nodes (negative sid), TOTAL rows,
// structure members (selType STRU1/STRU2 — identical rendering for both),
// and REST_H (not assigned) nodes.
// When a tuple has multiple values (multi-dimension drilldown), labels are
// joined with ' / '.
function tupleLabel(values: TupleValue[]): string {
  return values.map(v => {
    if (v.selType === 'TOTAL' || v.intKey === 'SUMME') return 'Total';
    if (v.intKey === 'REST_H') return '(not assigned)';
    const sid = parseInt(v.sid, 10);
    const label = v.txt || v.extKey || v.intKey;
    if (sid < 0) {
      const lvl = parseInt(v.dispLvl ?? '0', 10);
      const indent = '  '.repeat(lvl);
      const prefix = v.drillSt === '3' ? '+' : '+--';
      return `${indent}${prefix} ${label}`;
    }
    if ((v.selType === 'STRU1' || v.selType === 'STRU2') && v.dispLvl !== undefined) {
      const lvl = parseInt(v.dispLvl, 10);
      const indent = '  '.repeat(lvl);
      const prefix = v.drillSt === '3' ? 'v ' : v.drillSt === '2' ? '> ' : '';
      return `${indent}${prefix}${label}`;
    }
    return label;
  }).filter(s => s).join(' / ');
}

function renderQueryDataText(xml: string, isGet: boolean): string {
  const lines: string[] = [];

  // 1. Header
  const viewAttrs = parseQueryViewAttrs(xml);
  lines.push(`Query/Provider: ${viewAttrs.name ?? ''}`);
  if (viewAttrs.txt) lines.push(`Description: ${viewAttrs.txt}`);

  const metaData = isGet ? parseMetaData(xml) : null;
  if (metaData) {
    lines.push(`InfoProvider: ${metaData.infoProvider ?? ''}${metaData.infoProviderText ? ` (${metaData.infoProviderText})` : ''}`);
  }
  if (viewAttrs.dataRollup) lines.push(`Data as of: ${viewAttrs.dataRollup}`);

  const rs = parseResultSet(xml);
  lines.push(`Row range: ${rs.fromRow}–${rs.toRow}`);

  // 2. Variables
  const vc = parseVariablesContainer(xml);
  if (vc && vc.variables.length > 0) {
    lines.push('');
    lines.push(`── Variables (inputRequired=${vc.inputRequired}) ──`);
    const allEmpty = vc.variables.every(v => v.selectValues.length === 0);
    if (vc.inputRequired === 'true' && allEmpty) {
      lines.push('  NOTE: Input required — fill variables via POST before data is available.');
      lines.push('        Use bw_get_filter_values to look up valid characteristic values.');
    }
    for (const v of vc.variables) {
      const req = v.mandatory === 'true' ? ' [REQUIRED]' : '';
      const vals = v.selectValues.length > 0
        ? v.selectValues
            .map(sv => `${sv.sign}${sv.op} ${sv.low}${sv.high ? `..${sv.high}` : ''}`)
            .join(', ')
        : '(not set)';
      lines.push(`  ${v.name.trimEnd()} (${v.txt})${req}: ${vals}`);
    }
  }

  // 3. Background filters from <space>
  const spaceFilters = parseSpace(xml);
  if (spaceFilters.length > 0) {
    lines.push('');
    lines.push('── Background Filters (query-defined, read-only) ──');
    for (const f of spaceFilters) {
      const vals = f.selectValues.map(sv => `${sv.sign}${sv.op} ${sv.lowInt}`).join(', ');
      lines.push(`  ${f.name}: ${vals}`);
    }
  }

  // 4. Result table
  lines.push('');
  lines.push(`── Result (${rs.rowTuples.length} rows × ${rs.columnTuples.length} columns) ──`);

  if (rs.columnTuples.length === 0 && rs.rowTuples.length === 0) {
    lines.push('  (no data)');
  } else {
    const cellMap = new Map<string, { txt: string; mcu?: boolean }>();
    for (const c of rs.cells) {
      cellMap.set(`${c.row}:${c.col}`, { txt: c.txt, mcu: c.mcu });
    }

    const colLabels = rs.columnTuples.map(ct => tupleLabel(ct.values));
    const rowAxisLabels = rs.rowHeaders.map(h => h.txt || h.name);

    lines.push([...rowAxisLabels, ...colLabels].join(' | '));
    lines.push('-'.repeat(Math.min(200, [...rowAxisLabels, ...colLabels].join(' | ').length)));

    for (let ri = 0; ri < rs.rowTuples.length; ri++) {
      const rt = rs.rowTuples[ri];
      const rowIdx = ri + 1;
      const isTotal = rt.values.some(v => v.selType === 'TOTAL' || v.intKey === 'SUMME');
      if (isTotal) lines.push('');

      const rowLabel = tupleLabel(rt.values);
      const cellValues = rs.columnTuples.map((_, ci) => {
        const cell = cellMap.get(`${rowIdx}:${ci + 1}`);
        if (!cell) return '-';
        return cell.mcu ? '* (multi-currency)' : cell.txt;
      });
      lines.push([rowLabel, ...cellValues].join(' | '));
    }
  }

  // 5. Messages
  const msgs = parseMessages(xml);
  if (msgs.length > 0) {
    lines.push('');
    lines.push('── Messages ──');
    for (const m of msgs) {
      lines.push(`  [${m.type}] ${m.txt}`);
    }
  }

  // 6. Metadata (GET only)
  if (isGet && metaData) {
    if (metaData.keyFigures.length > 0) {
      lines.push('');
      lines.push('── Available Key Figures ──');
      for (const kf of metaData.keyFigures) {
        lines.push(`  ${kf.name} (${kf.txt}) [${kf.dataType}] id=${kf.id}`);
      }
    }
    if (metaData.characteristics.length > 0) {
      lines.push('');
      lines.push('── Available Characteristics ──');
      for (const cha of metaData.characteristics) {
        const struct = cha.isStructure === 'true' ? ' [structure]' : '';
        lines.push(`  ${cha.name} (${cha.txt}) axis=${cha.axis}${struct} id=${cha.id}`);
      }
    }
  }

  return lines.join('\n');
}

// ── POST body builder ──────────────────────────────────────────────────────────

export function buildPostBody(
  compId: string,
  state?: { infoObjects: InfoObjectState[] },
  variables?: VariableInput[],
  drillOperations?: DrillOperation[]
): string {
  const parts: string[] = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<querySelector name="${xmlEscape(compId)}">`);
  parts.push(`  <selection>`);

  if (variables && variables.length > 0) {
    parts.push(`    <variablesContainer>`);
    for (const v of variables) {
      const txt = v.txt ? ` txt="${xmlEscape(v.txt)}"` : '';
      const altName = v.altName ? ` altName="${xmlEscape(v.altName)}"` : '';
      const type = ` type="${xmlEscape(v.type ?? 'charMember')}"`;
      const inputEnabled = ` inputEnabled="${v.inputEnabled !== undefined ? v.inputEnabled : true}"`;
      const mandatory = v.mandatory !== undefined ? ` mandatory="${v.mandatory}"` : '';
      const iobj = v.iobj ? ` iobj="${xmlEscape(v.iobj)}"` : '';
      parts.push(`      <variable name="${xmlEscape(v.name)}" id="${xmlEscape(v.id)}"${txt}${altName}${type}${inputEnabled}${mandatory}${iobj}>`);
      let svId = 0;
      for (const sv of v.values) {
        const op = sv.op ?? 'EQ';
        const sign = sv.sign ?? 'I';
        const high = sv.high ? ` high="${xmlEscape(sv.high)}"` : '';
        parts.push(`        <selectValue id="${svId++}" low="${xmlEscape(sv.low)}"${high} nodeId="0" hryMinLvl="0" op="${op}" sign="${sign}" presentationMode="EXT"/>`);
      }
      parts.push(`      </variable>`);
    }
    parts.push(`    </variablesContainer>`);
  }

  if (state && state.infoObjects.length > 0) {
    parts.push(`    <state>`);
    for (const io of state.infoObjects) {
      const hasFilter = io.filterValues && io.filterValues.length > 0;
      if (hasFilter || io.hierarchy) {
        parts.push(`      <infoObject name="${xmlEscape(io.name)}" id="${xmlEscape(io.id)}" axis="${xmlEscape(io.axis)}" pos="0">`);
        if (io.hierarchy) {
          const hFrom = io.hierarchy.hryDateFrom ?? '00000000';
          const hTo = io.hierarchy.hryDateTo ?? '99991231';
          parts.push(`        <hierarchy id="${xmlEscape(io.hierarchy.id)}" name="${xmlEscape(io.hierarchy.name)}" hryId="${xmlEscape(io.hierarchy.hryId)}" hryDateFrom="${hFrom}" hryDateTo="${hTo}"/>`);
        }
        let svId = 0;
        for (const fv of (io.filterValues ?? [])) {
          const op = fv.op ?? 'EQ';
          const sign = fv.sign ?? 'I';
          const lowText = fv.lowText ? ` lowText="${xmlEscape(fv.lowText)}"` : '';
          const nodeId = fv.nodeId ?? 0;
          const nodeType = hierarchyNodeType(io.name, fv);
          const nodeName = nodeType ? ` nodeName="${xmlEscape(nodeType)}"` : '';
          // The upper bound goes in the same format as the lower one: with an internal low the
          // endpoint reads highInt and ignores high, so "BT 01..03" arrived as "BT 01".
          if (fv.lowInt) {
            const high = fv.high ? ` highInt="${xmlEscape(fv.high)}"` : '';
            parts.push(`        <selectValue id="${svId++}" lowInt="${xmlEscape(fv.lowInt)}"${high} nodeId="${nodeId}"${nodeName} hryMinLvl="0" op="${op}" sign="${sign}" presentationMode="INT"/>`);
          } else {
            const high = fv.high ? ` high="${xmlEscape(fv.high)}"` : '';
            parts.push(`        <selectValue id="${svId++}" low="${xmlEscape(fv.low ?? '')}"${lowText}${high} nodeId="${nodeId}"${nodeName} hryMinLvl="0" op="${op}" sign="${sign}" presentationMode="EXT_NC"/>`);
          }
        }
        parts.push(`      </infoObject>`);
      } else {
        parts.push(`      <infoObject name="${xmlEscape(io.name)}" id="${xmlEscape(io.id)}" axis="${xmlEscape(io.axis)}" pos="0"/>`);
      }
    }
    parts.push(`    </state>`);
  }

  if (drillOperations && drillOperations.length > 0) {
    parts.push(`    <drillOps>`);
    drillOperations.forEach((op, i) => {
      parts.push(
        `      <operation step="${i + 1}" axis="${op.axis}" drillSt="${op.drill_state}" ` +
        `drillLvl="1" tupleIdx="${op.tuple_idx}" elementIdx="${op.element_idx}"/>`
      );
    });
    parts.push(`    </drillOps>`);
  }

  parts.push(`  </selection>`);
  parts.push(`</querySelector>`);
  return parts.join('\n');
}

// ── Exported functions ─────────────────────────────────────────────────────────

export async function bwQueryData(
  client: BwClient,
  compId: string,
  isProvider: boolean = false,
  format: 'text' | 'raw' = 'text',
  state?: { infoObjects: InfoObjectState[] },
  variables?: VariableInput[],
  fromRow: number = 0,
  toRow: number = 1000,
  drillOperations?: DrillOperation[]
): Promise<string> {
  const effectiveCompId = isProvider ? `!${compId}` : compId;
  const url = `/sap/bw/modeling/comp/reporting?compid=${encodeURIComponent(effectiveCompId)}`;
  const isPost = !!(state || variables || (drillOperations && drillOperations.length > 0));

  let responseXml: string;

  if (isPost) {
    const postBody = buildPostBody(compId, state, variables, drillOperations);
    const doPost = async (): Promise<string> => {
      const csrfToken = await client.getCsrfToken();
      const postResult = await client.rawPost(url, postBody, {
        'Content-Type': BICS_CONTENT_TYPE,
        'X-CSRF-Token': csrfToken,
        Accept: BICS_ACCEPT,
        InclMetadata: 'false',
        InclExceptDef: 'true',
        InclObjectValues: 'true',
        HryLvlAbsRs: 'false',
        FromRow: String(fromRow),
        ToRow: String(toRow),
        'X-sap-adt-sessiontype': 'stateless',
      });
      return postResult.body;
    };
    try {
      responseXml = await doPost();
    } catch (err) {
      // SAP returns HTTP 403 when the CSRF token has expired (session idle timeout).
      // Retry once with a fresh token.
      if (/csrf|403/i.test(String(err))) {
        client.clearCsrfToken();
        responseXml = await doPost();
      } else {
        throw err;
      }
    }
  } else {
    const { body } = await client.rawGet(url, {
      Accept: BICS_ACCEPT,
      InclMetadata: 'true',
      InclExceptDef: 'true',
      InclObjectValues: 'true',
      CompactMode: 'false',
      HryLvlAbsRs: 'false',
      FromRow: String(fromRow),
      ToRow: String(toRow),
      'X-sap-adt-sessiontype': 'stateless',
    });
    responseXml = body;
  }

  if (format === 'raw') return responseXml;
  const text = renderQueryDataText(responseXml, !isPost);
  const notes = notAppliedNotes(state, responseXml);
  return notes.length > 0 ? `${text}\n\n── Not applied ──\n${notes.join('\n')}` : text;
}

export async function bwGetFilterValues(
  client: BwClient,
  characteristicName: string,
  searchString: string,
  infoProvider?: string,
  maxRows: number = 201
): Promise<string> {
  let url =
    `/sap/bw/modeling/is/values/characteristicvalues` +
    `?characteristicname=${encodeURIComponent(characteristicName)}` +
    `&maxrows=${maxRows}` +
    `&readtexts=x` +
    `&searchstring=${encodeURIComponent(searchString)}`;
  if (infoProvider) {
    url += `&infoprovider=${encodeURIComponent(infoProvider)}&readmode=d`;
  }

  const { body } = await client.rawGet(url, { Accept: VALUE_HELP_ACCEPT, 'X-sap-adt-sessiontype': 'stateless' });

  // Parse metadata
  const metaAttrs = body.match(/<valueHelpMetaInformation\b([^>]*?)(?:\/>|>)/)?.[1] ?? '';
  const totalCount = attr(metaAttrs, 'valueHelpLines') ?? '';
  const refChar = attr(metaAttrs, 'referenceCharacteristic') ?? characteristicName;

  // Parse column names
  const colNames: string[] = [];
  const colRe = /<columnname>([^<]*)<\/columnname>/g;
  let cm: RegExpExecArray | null;
  while ((cm = colRe.exec(body)) !== null) {
    colNames.push(cm[1].trim());
  }

  // Parse rows
  const rows: string[][] = [];
  const rowRe = /<row>([\s\S]*?)<\/row>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(body)) !== null) {
    const vals: string[] = [];
    const valRe = /<value>([^<]*)<\/value>/g;
    let vm: RegExpExecArray | null;
    while ((vm = valRe.exec(rm[1])) !== null) {
      vals.push(vm[1]);
    }
    rows.push(vals);
  }

  const lines: string[] = [];
  lines.push(`Characteristic: ${refChar}`);
  lines.push(`Search: "${searchString}"${infoProvider ? ` | Provider: ${infoProvider}` : ''}`);
  lines.push(`Results: ${rows.length}${totalCount ? ` of ${totalCount}` : ''}`);
  lines.push('');
  lines.push('NOTE: Use CHAVL_EXT for state filters (presentationMode="EXT"). Use CHAVL_INT for variable inputs. When CHAVL_EXT and CHAVL_INT are identical, either works.');
  lines.push('');

  if (rows.length === 0) {
    lines.push('(no values returned)');
    return lines.join('\n');
  }

  // Column widths
  const widths: number[] = colNames.map(n => n.length);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      widths[i] = Math.max(widths[i] ?? 0, (row[i] ?? '').length);
    }
  }

  const pad = (s: string, w: number) => s.padEnd(w);
  lines.push(colNames.map((n, i) => pad(n, widths[i])).join('  '));
  lines.push(widths.map(w => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    lines.push(row.map((v, i) => pad(v, widths[i] ?? 0)).join('  '));
  }

  return lines.join('\n');
}
