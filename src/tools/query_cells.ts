import { BwClient } from '../bw-client.js';
import {
  withQueryDocument,
  escapeXml,
  unescapeXml,
  escapeRegex,
  allocateVirtualId,
  locateMainComponentRegion,
  walkMembers,
  renderFormulaNode,
  buildRestrictionGroups,
  FormulaNode,
  KeyFigureRestriction,
} from './query_update.js';

/**
 * bw_update_query_cells — cell definitions of a BW Query.
 *
 * A query with two structures (one on each axis) can define a cell per intersection
 * of a member of the first structure with a member of the second. Cells live in the
 * mainComponent as Qry:gridCells (addressed by the two members, coordinateMember1
 * from the structure named by firstCustomDimension and coordinateMember2 from the
 * other) and Qry:helpCells (not in the grid, only referenced by cell formulas).
 *
 *   ReferenceCell  a grid cell that makes the value of an intersection addressable
 *   FormulaCell    a grid or help cell that computes its value
 *   SelectionCell  a help cell with its own key figure and restrictions
 *
 * A cell formula references other cells only, always as FormulaMemberOperand with
 * operandType="Member" and the cell id. The value of an intersection enters a
 * formula through the ReferenceCell at that intersection, which is created on
 * demand when an operand names an intersection that has no cell yet.
 *
 * Written through the shared full-document save in query_update.ts. Wire form from
 * a modeling-tools trace: help cells precede grid cells, both follow the axes and
 * precede Qry:runtimeProperties; a cell given explicit decimals or scaling is also
 * listed in the matching Qry:priorities list, which decides that the cell's setting
 * wins over the settings of the two members it sits on.
 */

export interface CellOperation {
  action: 'add_reference_cell' | 'add_formula_cell' | 'add_help_cell' | 'update_cell' | 'remove_cell';
  /** Member of one structure, by id or description (grid cells). */
  row_member?: string;
  /** Member of the other structure, by id or description (grid cells). */
  column_member?: string;
  /** Existing cell, by id or description (update_cell, remove_cell). */
  cell?: string;
  description?: string;
  formula?: FormulaNode;
  /** Help cell as a selection: the key figure it reads. */
  key_figure?: string;
  restrictions?: KeyFigureRestriction[];
  decimals?: number | false;
  scaling?: number | false;
}

export interface UpdateQueryCellsArgs {
  query_name: string;
  operations: CellOperation[];
  transport?: string;
}

interface Structure {
  id: string;
  description: string;
  /** 1 for the structure coordinateMember1 refers to, 2 for the other. */
  ordinal: 1 | 2;
  members: { id: string; description: string }[];
}

export interface CellElement {
  kind: 'gridCells' | 'helpCells';
  type: string;
  id: string;
  description: string;
  coord1?: string;
  coord2?: string;
  start: number;
  end: number;
  full: string;
}

const CELL_RE = /<Qry:(gridCells|helpCells)\b[^>]*?(\/>|>[\s\S]*?<\/Qry:\1>)/g;

/** Every cell element of the mainComponent, in document order. */
export function findCells(doc: string): CellElement[] {
  const region = locateMainComponentRegion(doc, 'cell lookup');
  const sub = doc.slice(region.start, region.end);
  const out: CellElement[] = [];
  CELL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CELL_RE.exec(sub)) !== null) {
    const full = m[0];
    const openTag = full.match(/^<Qry:(?:gridCells|helpCells)\b[^>]*?\/?>/)?.[0] ?? full;
    out.push({
      kind: m[1] as CellElement['kind'],
      type: openTag.match(/xsi:type="Qry:([A-Za-z]+)"/)?.[1] ?? '',
      id: openTag.match(/\bid="([^"]+)"/)?.[1] ?? '',
      description: unescapeXml(full.match(/<Qry:description\b[^>]*\bvalue="([^"]*)"/)?.[1] ?? ''),
      coord1: full.match(/<Qry:coordinateMember1>([^<]*)<\/Qry:coordinateMember1>/)?.[1],
      coord2: full.match(/<Qry:coordinateMember2>([^<]*)<\/Qry:coordinateMember2>/)?.[1],
      start: region.start + m.index,
      end: region.start + m.index + full.length,
      full,
    });
  }
  return out;
}

/**
 * The two structures of the query. coordinateMember1 refers to the structure named
 * by firstCustomDimension; without that attribute the first structure in document
 * order takes its place.
 */
export function findStructures(doc: string): Structure[] {
  const region = locateMainComponentRegion(doc, 'structure lookup');
  const sub = doc.slice(region.start, region.end);
  const mainOpen = sub.slice(0, sub.indexOf('>') + 1);
  const firstId = mainOpen.match(/\bfirstCustomDimension="([^"]+)"/)?.[1];
  const found: Omit<Structure, 'ordinal'>[] = [];
  const re = /<Qry:(rows|columns)\b[^>]*?(\/>|>[\s\S]*?<\/Qry:\1>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sub)) !== null) {
    const full = m[0];
    const openTag = full.match(/^<Qry:(?:rows|columns)\b[^>]*?\/?>/)?.[0] ?? full;
    if (!openTag.includes('xsi:type="Qry:CustomDimension"')) continue;
    const members = walkMembers(full)
      .filter((mm) => mm.tag !== 'childFormulas')
      .map((mm) => ({ id: mm.id, description: mm.description }));
    const beforeMembers = full.slice(0, full.search(/<Qry:members\b/) >= 0 ? full.search(/<Qry:members\b/) : full.length);
    found.push({
      id: openTag.match(/\bid="([^"]+)"/)?.[1] ?? '',
      description: unescapeXml(beforeMembers.match(/<Qry:description\b[^>]*\bvalue="([^"]*)"/)?.[1] ?? ''),
      members,
    });
  }
  if (found.length < 2) {
    throw new Error(
      `Cell definitions need two structures, one on each axis; the query has ${found.length}. ` +
      'Add the second structure first (bw_update_query_layout add_structure or bw_update_query_key_figures).'
    );
  }
  const firstIdx = Math.max(0, found.findIndex((s) => s.id === firstId));
  const first = found[firstIdx];
  const second = found.find((_, i) => i !== firstIdx)!;
  return [{ ...first, ordinal: 1 }, { ...second, ordinal: 2 }];
}

function resolveStructureMember(
  structures: Structure[],
  ref: string,
  context: string
): { id: string; description: string; ordinal: 1 | 2 } {
  const all = structures.flatMap((s) => s.members.map((mm) => ({ ...mm, ordinal: s.ordinal, structure: s.description })));
  const byId = all.filter((mm) => mm.id === ref);
  const hits = byId.length > 0 ? byId : all.filter((mm) => mm.description === ref);
  if (hits.length === 0) {
    throw new Error(`${context}: no structure member with id or description '${ref}'.`);
  }
  if (hits.length > 1) {
    const list = hits.map((h) => `${h.id} (${h.description}, structure '${h.structure}')`).join('; ');
    throw new Error(`${context}: '${ref}' matches ${hits.length} members: ${list}. Use the member id.`);
  }
  return hits[0];
}

/** Map the two member references of a grid cell onto its coordinates. */
function resolveCoordinates(
  structures: Structure[],
  row: string | undefined,
  column: string | undefined,
  context: string
): { coord1: string; coord2: string } {
  if (!row || !column) throw new Error(`${context}: row_member and column_member are both required.`);
  const a = resolveStructureMember(structures, row, `${context} row_member`);
  const b = resolveStructureMember(structures, column, `${context} column_member`);
  if (a.ordinal === b.ordinal) {
    throw new Error(
      `${context}: '${row}' and '${column}' belong to the same structure — a cell sits on one member of each structure.`
    );
  }
  return a.ordinal === 1 ? { coord1: a.id, coord2: b.id } : { coord1: b.id, coord2: a.id };
}

function resolveCell(doc: string, ref: string, context: string): CellElement {
  const cells = findCells(doc);
  const byId = cells.filter((c) => c.id === ref);
  const hits = byId.length > 0 ? byId : cells.filter((c) => c.description === ref);
  if (hits.length === 0) throw new Error(`${context}: no cell with id or description '${ref}'.`);
  if (hits.length > 1) {
    const list = hits.map((c) => `${c.id} (${c.type})`).join('; ');
    throw new Error(`${context}: '${ref}' matches ${hits.length} cells: ${list}. Use the cell id.`);
  }
  return hits[0];
}

function cellAt(doc: string, coord1: string, coord2: string): CellElement | undefined {
  return findCells(doc).find((c) => c.kind === 'gridCells' && c.coord1 === coord1 && c.coord2 === coord2);
}

/** Next value of the running number the modeling tools give each cell as its default hint. */
function nextCellNumber(doc: string): number {
  let max = 0;
  for (const c of findCells(doc)) {
    const n = c.full.match(/<Qry:defaultHint>\s*<Qry:type>Constant<\/Qry:type>\s*<Qry:value>(\d+)<\/Qry:value>/)?.[1];
    if (n && parseInt(n, 10) > max) max = parseInt(n, 10);
  }
  return max + 1;
}

function descEl(description: string | undefined): string {
  if (description === undefined || description === '') return '<Qry:description/>';
  return `<Qry:description default="false" value="${escapeXml(description)}"/>`;
}

const DISPLAY_DEFAULTS =
  '<Qry:hidden/>\n  <Qry:emphasize/>\n  <Qry:signInversion/>\n  <Qry:scaling/>\n  <Qry:decimals/>\n  <Qry:calculation/>\n' +
  '  <Qry:planning>\n    <Qry:inputMode/>\n    <Qry:disaggregation/>\n  </Qry:planning>';

function coordsEl(coord1: string, coord2: string): string {
  return `\n  <Qry:coordinateMember1>${coord1}</Qry:coordinateMember1>\n  <Qry:coordinateMember2>${coord2}</Qry:coordinateMember2>`;
}

function hintEl(n: number): string {
  return `<Qry:defaultHint>\n    <Qry:type>Constant</Qry:type>\n    <Qry:value>${n}</Qry:value>\n  </Qry:defaultHint>`;
}

function buildReferenceCell(vid: string, n: number, description: string | undefined, coord1: string, coord2: string): string {
  return `<Qry:gridCells xsi:type="Qry:ReferenceCell" id="${vid}">
  ${descEl(description)}
  ${hintEl(n)}
  ${DISPLAY_DEFAULTS}${coordsEl(coord1, coord2)}
</Qry:gridCells>`;
}

function buildFormulaCell(
  kind: 'gridCells' | 'helpCells',
  vid: string,
  n: number,
  description: string | undefined,
  formulaXml: string,
  coords?: { coord1: string; coord2: string }
): string {
  return `<Qry:${kind} xsi:type="Qry:FormulaCell" id="${vid}">
  ${descEl(description)}
  ${hintEl(n)}
  <Qry:formulaDefinition>${formulaXml}</Qry:formulaDefinition>
  <Qry:exceptionAggregation/>
  ${DISPLAY_DEFAULTS}${coords ? coordsEl(coords.coord1, coords.coord2) : ''}
</Qry:${kind}>`;
}

function buildSelectionHelpCell(vid: string, description: string, keyFigure: string, restrictionGroups: string): string {
  const kyf = escapeXml(keyFigure.toUpperCase());
  const descEsc = escapeXml(description);
  return `<Qry:helpCells xsi:type="Qry:SelectionCell" id="${vid}">
  ${descEl(description)}
  <Qry:defaultHint>
    <Qry:type>InfoObject</Qry:type>
    <Qry:value>${kyf}</Qry:value>
  </Qry:defaultHint>
  ${DISPLAY_DEFAULTS}
  <Qry:currencyConversion/>
  <Qry:unitConversion/>
  <Qry:groups description="Key Figures" infoObject="1KYFNM">
    <Qry:tokens xsi:type="Qry:SelectionRange" usageType="asFilter" selectionType="keyFigure" fromValueDesc="${descEsc}" operator="Equal">
      <Qry:fromValue>
        <Qry:type>Value</Qry:type>
        <Qry:value>${kyf}</Qry:value>
      </Qry:fromValue>
    </Qry:tokens>
  </Qry:groups>
${restrictionGroups}</Qry:helpCells>`;
}

/**
 * Insert a cell element where the modeling tools write it: help cells after the axes,
 * grid cells after the help cells. Anchored on the axes rather than on a following
 * element, because the server serializes the trailing mainComponent elements in a
 * different order than the modeling tools.
 */
function insertCell(doc: string, kind: 'gridCells' | 'helpCells', xml: string): string {
  const cells = findCells(doc);
  const after = (at: number) => doc.slice(0, at) + '\n' + xml + doc.slice(at);
  const sameKind = cells.filter((c) => c.kind === kind);
  if (sameKind.length > 0) return after(sameKind[sameKind.length - 1].end);
  const lastHelp = cells.filter((c) => c.kind === 'helpCells').pop();
  if (kind === 'gridCells' && lastHelp) return after(lastHelp.end);
  const firstGrid = cells.find((c) => c.kind === 'gridCells');
  if (kind === 'helpCells' && firstGrid) {
    return doc.slice(0, firstGrid.start) + xml + '\n' + doc.slice(firstGrid.start);
  }
  const region = locateMainComponentRegion(doc, 'cell insertion');
  const sub = doc.slice(region.start, region.end);
  const axisRe = /<Qry:(rows|columns|free)\b[^>]*?(\/>|>[\s\S]*?<\/Qry:\1>)/g;
  let axisEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = axisRe.exec(sub)) !== null) axisEnd = m.index + m[0].length;
  if (axisEnd < 0) throw new Error('The query has no axes to place cells on.');
  return after(region.start + axisEnd);
}

function replaceRange(doc: string, start: number, end: number, xml: string): string {
  return doc.slice(0, start) + xml + doc.slice(end);
}

function setCellChild(cellXml: string, tag: string, newXml: string): string {
  const re = new RegExp(`<Qry:${tag}\\b[^>]*?(\\/>|>[\\s\\S]*?<\\/Qry:${tag}>)`);
  if (re.test(cellXml)) return cellXml.replace(re, newXml);
  throw new Error(`Cell has no Qry:${tag} element to set.`);
}

const PRIORITIES_RE = /<Qry:priorities\s*\/>|<Qry:priorities>[\s\S]*?<\/Qry:priorities>/;

function listRe(list: string): RegExp {
  return new RegExp(`<Qry:${list}\\s*\\/>|<Qry:${list}>[\\s\\S]*?<\\/Qry:${list}>`);
}

/**
 * Add or drop the cell's entry in one priorities list (scaling / decimals). The block
 * and the list are created when missing: a query the server has saved without any
 * priority carries no block at all, and the entry is what lets the cell's own setting
 * win over the settings of the members it sits on.
 */
function setPriority(doc: string, list: 'scaling' | 'decimals', cellId: string, present: boolean): string {
  const region = locateMainComponentRegion(doc, 'priorities');
  let sub = doc.slice(region.start, region.end);
  let pm = sub.match(PRIORITIES_RE);
  if (!pm || pm.index === undefined) {
    if (!present) return doc;
    const filterIdx = sub.indexOf('<Qry:filter');
    if (filterIdx < 0) throw new Error('Could not locate the query filter to place the priorities before.');
    sub = sub.slice(0, filterIdx) + '<Qry:priorities/>\n    ' + sub.slice(filterIdx);
    pm = sub.match(PRIORITIES_RE)!;
  }
  const blockStart = pm.index!;
  let block = pm[0].endsWith('/>') ? '<Qry:priorities>\n    </Qry:priorities>' : pm[0];
  let lm = block.match(listRe(list));
  if (!lm || lm.index === undefined) {
    if (!present) return doc;
    const scaling = block.match(listRe('scaling'));
    const at = list === 'decimals' && scaling?.index !== undefined
      ? scaling.index + scaling[0].length
      : '<Qry:priorities>'.length;
    block = block.slice(0, at) + `\n      <Qry:${list}/>` + block.slice(at);
    lm = block.match(listRe(list))!;
  }
  const listXml = lm[0];
  const tokenRe = new RegExp(`\\s*<Qry:tokens id="${escapeRegex(cellId)}"[^>]*\\/>`, 'g');
  let updated = listXml.replace(tokenRe, '');
  if (present) {
    let max = 0;
    for (const t of updated.matchAll(/priority="\s*(\d+)\s*"/g)) max = Math.max(max, parseInt(t[1], 10));
    const token = `<Qry:tokens id="${cellId}" priority="${max + 1}"/>`;
    const close = `</Qry:${list}>`;
    updated = updated.endsWith(close)
      ? updated.slice(0, updated.length - close.length).replace(/\s*$/, '') + `\n        ${token}\n      ${close}`
      : `<Qry:${list}>\n        ${token}\n      ${close}`;
  } else if (!/<Qry:tokens\b/.test(updated)) {
    updated = `<Qry:${list}/>`;
  }
  const newBlock = block.slice(0, lm.index!) + updated + block.slice(lm.index! + listXml.length);
  const newSub = sub.slice(0, blockStart) + newBlock + sub.slice(blockStart + pm[0].length);
  return doc.slice(0, region.start) + newSub + doc.slice(region.end);
}

function checkDigit(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 9) throw new Error(`${what} must be an integer between 0 and 9, or false.`);
}

/** Apply display properties to a cell element and keep the priorities lists in step. */
function applyCellProperties(doc: string, cellId: string, op: CellOperation): { doc: string; applied: string[] } {
  const applied: string[] = [];
  const edit = (fn: (xml: string) => string) => {
    const cell = findCells(doc).find((c) => c.id === cellId)!;
    doc = replaceRange(doc, cell.start, cell.end, fn(cell.full));
  };
  if (op.decimals !== undefined) {
    if (op.decimals !== false) checkDigit(op.decimals, 'decimals');
    const el = op.decimals === false ? '<Qry:decimals/>' : `<Qry:decimals default="false" number="${op.decimals}"/>`;
    edit((xml) => setCellChild(xml, 'decimals', el));
    doc = setPriority(doc, 'decimals', cellId, op.decimals !== false);
    applied.push('decimals');
  }
  if (op.scaling !== undefined) {
    if (op.scaling !== false) checkDigit(op.scaling, 'scaling');
    const el = op.scaling === false ? '<Qry:scaling/>' : `<Qry:scaling default="false" number="${op.scaling}"/>`;
    edit((xml) => setCellChild(xml, 'scaling', el));
    doc = setPriority(doc, 'scaling', cellId, op.scaling !== false);
    applied.push('scaling');
  }
  return { doc, applied };
}

interface CellReport {
  action: string;
  cell_id: string;
  type: string;
  description?: string;
  coordinates?: { member_1: string; member_2: string };
  applied?: string[];
  created_reference_cells?: string[];
}

/**
 * Render a cell formula. Cell formulas only reference cells: a { "type": "cell" }
 * operand names an existing cell, or an intersection whose ReferenceCell is created
 * when it does not exist yet. The ids of cells created that way are collected.
 */
function renderCellFormula(
  state: { doc: string },
  structures: Structure[],
  formula: FormulaNode,
  created: string[]
): string {
  return renderFormulaNode(formula, state.doc, 'Qry:formulaToken', (node, tag) => {
    const type = node['type'];
    if (type === 'member' || type === 'component' || type === 'key_figure') {
      throw new Error(
        `A cell formula references cells, not '${String(type)}' operands. Use { "type": "cell", "cell": "..." } for an ` +
        'existing cell, or { "type": "cell", "row_member": "...", "column_member": "..." } for the value at an intersection.'
      );
    }
    if (type !== 'cell') return undefined;
    let id: string;
    if (node['cell'] !== undefined) {
      id = resolveCell(state.doc, String(node['cell']), 'cell operand').id;
    } else {
      const { coord1, coord2 } = resolveCoordinates(
        structures,
        node['row_member'] as string | undefined,
        node['column_member'] as string | undefined,
        'cell operand'
      );
      const existing = cellAt(state.doc, coord1, coord2);
      if (existing) {
        id = existing.id;
      } else {
        id = allocateVirtualId(state.doc);
        state.doc = insertCell(state.doc, 'gridCells', buildReferenceCell(id, nextCellNumber(state.doc), undefined, coord1, coord2));
        created.push(id);
      }
    }
    return `<${tag} xsi:type="Qry:FormulaMemberOperand" member="${id}" operandType="Member"/>`;
  });
}

/** Cells whose formula references the given cell id. */
function dependents(doc: string, cellId: string): CellElement[] {
  const needle = new RegExp(`\\bmember="${escapeRegex(cellId)}"`);
  return findCells(doc).filter((c) => c.id !== cellId && needle.test(c.full));
}

function applyOperation(state: { doc: string }, op: CellOperation, reports: CellReport[]): void {
  const structures = findStructures(state.doc);
  const context = op.action;
  const created: string[] = [];

  switch (op.action) {
    case 'add_reference_cell': {
      const { coord1, coord2 } = resolveCoordinates(structures, op.row_member, op.column_member, context);
      const existing = cellAt(state.doc, coord1, coord2);
      if (existing) {
        throw new Error(`${context}: the intersection already has a cell, ${existing.id} (${existing.type}). Use update_cell or remove_cell.`);
      }
      const vid = allocateVirtualId(state.doc);
      state.doc = insertCell(state.doc, 'gridCells', buildReferenceCell(vid, nextCellNumber(state.doc), op.description, coord1, coord2));
      const props = applyCellProperties(state.doc, vid, op);
      state.doc = props.doc;
      reports.push({ action: op.action, cell_id: vid, type: 'ReferenceCell', description: op.description, coordinates: { member_1: coord1, member_2: coord2 }, applied: props.applied });
      return;
    }
    case 'add_formula_cell': {
      if (!op.formula) throw new Error(`${context}: formula is required.`);
      const { coord1, coord2 } = resolveCoordinates(structures, op.row_member, op.column_member, context);
      const existing = cellAt(state.doc, coord1, coord2);
      if (existing) {
        throw new Error(`${context}: the intersection already has a cell, ${existing.id} (${existing.type}). Use update_cell to change its formula.`);
      }
      const formulaXml = renderCellFormula(state, structures, op.formula, created);
      const vid = allocateVirtualId(state.doc);
      state.doc = insertCell(state.doc, 'gridCells', buildFormulaCell('gridCells', vid, nextCellNumber(state.doc), op.description, formulaXml, { coord1, coord2 }));
      const props = applyCellProperties(state.doc, vid, op);
      state.doc = props.doc;
      reports.push({ action: op.action, cell_id: vid, type: 'FormulaCell', description: op.description, coordinates: { member_1: coord1, member_2: coord2 }, applied: props.applied, created_reference_cells: created });
      return;
    }
    case 'add_help_cell': {
      if (!op.description) throw new Error(`${context}: description is required — a help cell is referenced by it.`);
      if (findCells(state.doc).some((c) => c.description === op.description)) {
        throw new Error(`${context}: a cell with description '${op.description}' already exists.`);
      }
      if (!!op.formula === !!op.key_figure) {
        throw new Error(`${context}: give either formula (a formula help cell) or key_figure (a selection help cell).`);
      }
      let xml: string;
      let type: string;
      let vid: string;
      if (op.formula) {
        const formulaXml = renderCellFormula(state, structures, op.formula, created);
        vid = allocateVirtualId(state.doc);
        xml = buildFormulaCell('helpCells', vid, nextCellNumber(state.doc), op.description, formulaXml);
        type = 'FormulaCell';
      } else {
        vid = allocateVirtualId(state.doc);
        xml = buildSelectionHelpCell(vid, op.description, op.key_figure!, buildRestrictionGroups(op.restrictions));
        type = 'SelectionCell';
      }
      state.doc = insertCell(state.doc, 'helpCells', xml);
      const props = applyCellProperties(state.doc, vid, op);
      state.doc = props.doc;
      reports.push({ action: op.action, cell_id: vid, type, description: op.description, applied: props.applied, created_reference_cells: created });
      return;
    }
    case 'update_cell': {
      const target = locateTarget(state.doc, structures, op, context);
      const applied: string[] = [];
      if (op.formula) {
        if (target.type !== 'FormulaCell') throw new Error(`${context}: ${target.id} is a ${target.type}; only a FormulaCell has a formula.`);
        const formulaXml = renderCellFormula(state, structures, op.formula, created);
        const cell = findCells(state.doc).find((c) => c.id === target.id)!;
        state.doc = replaceRange(state.doc, cell.start, cell.end,
          setCellChild(cell.full, 'formulaDefinition', `<Qry:formulaDefinition>${formulaXml}</Qry:formulaDefinition>`));
        applied.push('formula');
      }
      if (op.description !== undefined) {
        const cell = findCells(state.doc).find((c) => c.id === target.id)!;
        state.doc = replaceRange(state.doc, cell.start, cell.end, setCellChild(cell.full, 'description', descEl(op.description)));
        applied.push('description');
      }
      const props = applyCellProperties(state.doc, target.id, op);
      state.doc = props.doc;
      applied.push(...props.applied);
      if (applied.length === 0) throw new Error(`${context}: nothing to change — give formula, description, decimals or scaling.`);
      reports.push({ action: op.action, cell_id: target.id, type: target.type, applied, created_reference_cells: created });
      return;
    }
    case 'remove_cell': {
      const target = locateTarget(state.doc, structures, op, context);
      const users = dependents(state.doc, target.id);
      if (users.length > 0) {
        const list = users.map((c) => `${c.id} (${c.description || c.type})`).join('; ');
        throw new Error(`${context}: ${target.id} is referenced by the formula of ${list}. Change or remove those cells first.`);
      }
      const lineStart = state.doc.lastIndexOf('\n', target.start - 1);
      const from = lineStart >= 0 && state.doc.slice(lineStart, target.start).trim() === '' ? lineStart : target.start;
      state.doc = replaceRange(state.doc, from, target.end, '');
      state.doc = setPriority(state.doc, 'decimals', target.id, false);
      state.doc = setPriority(state.doc, 'scaling', target.id, false);
      reports.push({ action: op.action, cell_id: target.id, type: target.type, description: target.description });
      return;
    }
    default:
      throw new Error(`Unknown cell action '${String((op as { action?: string }).action)}'.`);
  }
}

function locateTarget(doc: string, structures: Structure[], op: CellOperation, context: string): CellElement {
  if (op.cell !== undefined) return resolveCell(doc, op.cell, context);
  const { coord1, coord2 } = resolveCoordinates(structures, op.row_member, op.column_member, context);
  const cell = cellAt(doc, coord1, coord2);
  if (!cell) throw new Error(`${context}: the intersection of '${op.row_member}' and '${op.column_member}' has no cell.`);
  return cell;
}

/** Apply all operations to a query document; exported for offline tests. */
export function applyCellOperations(doc: string, operations: CellOperation[]): { doc: string; reports: CellReport[] } {
  const state = { doc };
  const reports: CellReport[] = [];
  operations.forEach((op, i) => {
    try {
      applyOperation(state, op, reports);
    } catch (err) {
      throw new Error(`Operation ${i + 1} (${op.action}): ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return { doc: state.doc, reports };
}

export async function bwUpdateQueryCells(client: BwClient, args: UpdateQueryCellsArgs): Promise<string> {
  if (!args.query_name) throw new Error('query_name is required.');
  if (!Array.isArray(args.operations) || args.operations.length === 0) throw new Error('operations must be a non-empty array.');
  let reports: CellReport[] = [];
  const { messages } = await withQueryDocument(client, args.query_name, (xml) => {
    const result = applyCellOperations(xml, args.operations);
    reports = result.reports;
    return result.doc;
  }, args.transport);
  return JSON.stringify({
    success: true,
    query_name: args.query_name.toUpperCase(),
    operations: reports,
    note: 'Ids starting with !VIRTUAL- are placeholders the server replaced on save; bw_get_query shows the final ids.',
    check_messages: messages,
  });
}
