import { BwClient } from '../bw-client.js';
import { correlateCall, statObjectName } from './query_statistics.js';

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
  }>;
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

export interface TupleValue {
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
    // An empty result carries no range of its own; the caller reports the requested one.
    return {
      fromRow: '',
      toRow: '',
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

export interface RenderPaging {
  /** The range the caller asked for. */
  fromRow: number;
  toRow: number;
  /**
   * Rows the caller asked for. The request fetched one more; a row beyond this count means
   * the result continues, and that row is not shown.
   */
  pageSize?: number;
  suppressSubtotals?: boolean;
}

/** A subtotal carries a TOTAL member on some but not all of its dimensions. */
function isTotalValue(v: TupleValue): boolean {
  return v.selType === 'TOTAL' || v.intKey === 'SUMME';
}

export function isSubtotalRow(values: TupleValue[]): boolean {
  const totals = values.filter(isTotalValue).length;
  return totals > 0 && totals < values.length;
}

export function renderQueryDataText(xml: string, isGet: boolean, paging?: RenderPaging): string {
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
  const from = paging ? String(paging.fromRow) : rs.fromRow || '0';
  const to = paging ? String(paging.toRow) : rs.toRow || '1000';
  lines.push(`Row range: ${from}–${to}`);

  // Rows keep their position in the response: cells address rows by that index.
  let rowIndexes = rs.rowTuples.map((_, i) => i);
  let hasMore: boolean | undefined;
  if (paging?.pageSize !== undefined) {
    hasMore = rowIndexes.length > paging.pageSize;
    rowIndexes = rowIndexes.slice(0, paging.pageSize);
  }
  let suppressed = 0;
  if (paging?.suppressSubtotals) {
    const kept = rowIndexes.filter((i) => !isSubtotalRow(rs.rowTuples[i].values));
    suppressed = rowIndexes.length - kept.length;
    rowIndexes = kept;
  }
  if (hasMore !== undefined) {
    lines.push(hasMore
      ? `More rows: yes — continue with from_row=${to} (BICS reports no total row count)`
      : 'More rows: no — this page ends the result');
  }
  if (suppressed > 0) {
    lines.push(`Subtotals: ${suppressed} subtotal row${suppressed === 1 ? '' : 's'} suppressed on this page ` +
      '(they still count towards the row range)');
  }

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
  lines.push(`── Result (${rowIndexes.length} rows × ${rs.columnTuples.length} columns) ──`);

  if (rs.columnTuples.length === 0 && rowIndexes.length === 0) {
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

    for (const ri of rowIndexes) {
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

function buildPostBody(
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
          const high = fv.high ? ` high="${xmlEscape(fv.high)}"` : '';
          const nodeId = fv.nodeId ?? 0;
          if (fv.lowInt) {
            parts.push(`        <selectValue id="${svId++}" lowInt="${xmlEscape(fv.lowInt)}"${high} nodeId="${nodeId}" hryMinLvl="0" op="${op}" sign="${sign}" presentationMode="INT"/>`);
          } else {
            parts.push(`        <selectValue id="${svId++}" low="${xmlEscape(fv.low ?? '')}"${lowText}${high} nodeId="${nodeId}" hryMinLvl="0" op="${op}" sign="${sign}" presentationMode="EXT_NC"/>`);
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

export interface QueryDataOptions {
  /** Look up the call's BW statistics step and split the time into BW and transfer. */
  withStatistics?: boolean;
  /** Drop subtotal rows from the rendered table; the overall result row stays. */
  suppressSubtotals?: boolean;
}

/**
 * Where the time of one call went, measured on this host.
 *
 * `http` covers the reporting request(s) alone — request out, last byte of the answer in —
 * so it holds the BW runtime plus everything between this host and BW: the Cloud Connector,
 * the network and the XML transfer. CSRF token fetches are timed separately because on a cold
 * client they are a round trip of their own.
 */
export interface QueryTiming {
  requestStart: Date;
  responseEnd: Date;
  csrfMs: number;
  httpMs: number;
  attempts: number;
  requestBytes: number;
  responseBytes: number;
}

export function renderTiming(t: QueryTiming, totalMs: number, renderMs: number): string[] {
  const s = (ms: number) => `${(ms / 1000).toFixed(3)} s`;
  const kb = (b: number) => `${(b / 1024).toFixed(1)} KB`;
  const own = Math.max(0, totalMs - t.httpMs - t.csrfMs);
  return [
    '',
    '── Timing (measured by this server) ──',
    `  Total in server:  ${s(totalMs)}`,
    `  BW HTTP:          ${s(t.httpMs)}  (${t.attempts} attempt${t.attempts === 1 ? '' : 's'}; BW runtime + Cloud Connector + network + XML)`,
    ...(t.csrfMs >= 1 ? [`  CSRF token:       ${s(t.csrfMs)}`] : []),
    `  Server's own:     ${s(own)}  (parsing and rendering ${s(renderMs)})`,
    `  Request/response: ${kb(t.requestBytes)} / ${kb(t.responseBytes)}`,
    `  Window (UTC):     ${t.requestStart.toISOString()} – ${t.responseEnd.toISOString()}`,
    '  Time outside this server (client, LLM, MCP transport) is not part of these figures.',
  ];
}

export async function bwQueryData(
  client: BwClient,
  compId: string,
  isProvider: boolean = false,
  format: 'text' | 'raw' = 'text',
  state?: { infoObjects: InfoObjectState[] },
  variables?: VariableInput[],
  fromRow: number = 0,
  toRow: number = 1000,
  drillOperations?: DrillOperation[],
  options: QueryDataOptions = {}
): Promise<string> {
  const startedAt = performance.now();
  const effectiveCompId = isProvider ? `!${compId}` : compId;
  const url = `/sap/bw/modeling/comp/reporting?compid=${encodeURIComponent(effectiveCompId)}`;
  const isPost = !!(state || variables || (drillOperations && drillOperations.length > 0));

  // The text rendering asks for one row beyond the page: BICS reports no total row count,
  // so the only honest statement about the rest of the result is whether that row exists.
  // The raw format returns exactly what was asked for.
  const pageSize = Math.max(0, toRow - fromRow);
  const requestedTo = format === 'text' ? toRow + 1 : toRow;

  const timing: QueryTiming = {
    requestStart: new Date(),
    responseEnd: new Date(),
    csrfMs: 0,
    httpMs: 0,
    attempts: 0,
    requestBytes: 0,
    responseBytes: 0,
  };
  const timed = async <T>(fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    timing.attempts++;
    try {
      return await fn();
    } finally {
      timing.httpMs += performance.now() - t0;
    }
  };
  const csrf = async (): Promise<string> => {
    const t0 = performance.now();
    try {
      return await client.getCsrfToken();
    } finally {
      timing.csrfMs += performance.now() - t0;
    }
  };

  let responseXml: string;

  if (isPost) {
    const postBody = buildPostBody(compId, state, variables, drillOperations);
    timing.requestBytes = Buffer.byteLength(postBody, 'utf8');
    const doPost = async (): Promise<string> => {
      const csrfToken = await csrf();
      const postResult = await timed(() => client.rawPost(url, postBody, {
        'Content-Type': BICS_CONTENT_TYPE,
        'X-CSRF-Token': csrfToken,
        Accept: BICS_ACCEPT,
        InclMetadata: 'false',
        InclExceptDef: 'true',
        InclObjectValues: 'true',
        HryLvlAbsRs: 'false',
        FromRow: String(fromRow),
        ToRow: String(requestedTo),
        'X-sap-adt-sessiontype': 'stateless',
      }));
      return postResult.body;
    };
    timing.requestStart = new Date();
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
    await csrf();
    timing.requestStart = new Date();
    const { body } = await timed(() => client.rawGet(url, {
      Accept: BICS_ACCEPT,
      InclMetadata: 'true',
      InclExceptDef: 'true',
      InclObjectValues: 'true',
      CompactMode: 'false',
      HryLvlAbsRs: 'false',
      FromRow: String(fromRow),
      ToRow: String(requestedTo),
      'X-sap-adt-sessiontype': 'stateless',
    }));
    responseXml = body;
  }
  timing.responseEnd = new Date();
  timing.responseBytes = Buffer.byteLength(responseXml, 'utf8');

  const renderStart = performance.now();
  const rendered = format === 'raw'
    ? responseXml
    : renderQueryDataText(responseXml, !isPost, {
        fromRow,
        toRow,
        pageSize,
        suppressSubtotals: options.suppressSubtotals ?? false,
      });
  const renderMs = performance.now() - renderStart;
  const totalMs = performance.now() - startedAt;

  // Without with_statistics the answer stays exactly as before: raw output in particular is
  // often written to a file and compared, and a trailing block would change it.
  if (!options.withStatistics) return rendered;

  const extra = renderTiming(timing, totalMs, renderMs);
  const statsStart = performance.now();
  extra.push(...await correlateCall(
    client,
    statObjectName(compId, isProvider),
    timing.requestStart,
    timing.responseEnd,
    timing.httpMs / 1000,
  ));
  extra.push(`  (statistics lookup took ${((performance.now() - statsStart) / 1000).toFixed(3)} s, not included above)`);

  if (format === 'raw') {
    // A comment after the root element keeps the document well-formed.
    return `${rendered}\n<!--\n${extra.join('\n').replace(/--/g, '- -')}\n-->`;
  }
  return `${rendered}\n${extra.join('\n')}`;
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
