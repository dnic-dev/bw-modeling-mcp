import { BwClient } from '../bw-client.js';
import { withQueryDocument, escapeXml, escapeRegex, locateMainComponentRegion } from './query_update.js';

/**
 * bw_update_query_characteristic — the display and access properties a BW Query
 * carries per characteristic in its rows, columns, and free-characteristics areas.
 *
 * These live as child elements of the rows/columns/free Dimension block and are
 * written by the same full-document PUT as every other query edit, so the shared
 * read-modify-write engine in query_update.ts does the save.
 *
 * Every property follows the same two-state pattern in the model: a default="true"
 * element means "leave it to the InfoObject / query default" and clears the stored
 * value, while default="false" plus the property's own attributes pins an explicit
 * value. The literals below are the ones the BW server itself maps — anything else
 * is silently coerced to a default rather than rejected, which is why the enums are
 * closed.
 */

// ── Model literals ─────────────────────────────────────────────────────────

/** Display of result rows for the characteristic. */
export type ResultRows = 'always' | 'suppressForOne' | 'never' | 'default';
/** How characteristic values are rendered. */
export type DisplayAs = 'Key' | 'Text' | 'KeyAndText' | 'TextAndKey' | 'noDisplay' | 'default';
/** Which text is used when values are rendered with a text. */
export type TextType = 'standard' | 'short' | 'medium' | 'long';
/** Access type for result values (read mode). */
export type AccessType = 'masterdata' | 'characteristicRelations' | 'factdata' | 'dimensiondata' | 'default';
/** Level at which the characteristic is shown. */
export type DisplayLevel = 'AlsoInSimple' | 'Normal' | 'DetailedOnly' | 'default';
/** Tri-state switch: explicit on, explicit off, or back to the default. */
export type Switch = 'on' | 'off' | 'default';

export interface SortingSpec {
  /** "default" restores the standard sorting (as selected / as in the hierarchy). */
  by: 'Key' | 'Text' | 'default';
  direction?: 'Ascending' | 'Descending';
  /**
   * Characteristic or display attribute the sort runs on. Only meaningful for the
   * characteristic's own sorting; defaults to the characteristic itself.
   */
  sort_by_characteristic?: string;
}

export interface HierarchySpec {
  active?: boolean;
  /** Hierarchy technical name; "" removes the assignment. */
  name?: string;
  version?: string;
  /** Key date of the hierarchy, YYYYMMDD. */
  valid_to?: string;
  /** Expand to level; 0 restores the default. */
  expand_to_level?: number;
  child_node_position?: 'above' | 'below' | 'default';
  postable_node_values?: 'show' | 'hide' | 'default';
  suppress_single_child_nodes?: Switch;
  sorting?: SortingSpec;
}

export interface CharacteristicSpec {
  /** Technical name of the characteristic, or "*" for every characteristic in the layout. */
  infoobject: string;
  /** Restrict to one area; without it every area is considered. */
  axis?: 'rows' | 'columns' | 'free';
  result_rows?: ResultRows;
  display_as?: DisplayAs;
  text_type?: TextType;
  access_type?: AccessType;
  cumulate?: Switch;
  display_level?: DisplayLevel;
  sorting?: SortingSpec;
  hierarchy?: HierarchySpec;
}

export interface UpdateQueryCharacteristicArgs {
  query_name: string;
  characteristics: CharacteristicSpec[];
  transport?: string;
}

// ── Element builders ───────────────────────────────────────────────────────

const bool = (b: boolean) => (b ? 'true' : 'false');

function valuePresentationEl(displayAs: DisplayAs, textType: TextType | undefined): string {
  if (displayAs === 'default') return '<Qry:valuePresentation default="true"/>';
  const style = textType ?? 'standard';
  return `<Qry:valuePresentation default="false" presentAs="${displayAs}" textPresentation="${style}"/>`;
}

function resultPresentationEl(cond: ResultRows): string {
  if (cond === 'default') return '<Qry:resultPresentation default="true"/>';
  return `<Qry:resultPresentation default="false"><Qry:condition>${cond}</Qry:condition></Qry:resultPresentation>`;
}

/**
 * The server writes type="masterdata" even on the default element, so the default
 * form is not merely the flag — reproduce it exactly.
 */
function readModeEl(type: AccessType): string {
  if (type === 'default') return '<Qry:readMode default="true" type="masterdata"/>';
  return `<Qry:readMode default="false" type="${type}"/>`;
}

function cumulationEl(v: Switch): string {
  if (v === 'default') return '<Qry:cumulation default="true"/>';
  return `<Qry:cumulation default="false" showCumulated="${bool(v === 'on')}"/>`;
}

function displayLevelEl(v: DisplayLevel): string {
  if (v === 'default') return '<Qry:displayLevel default="true"/>';
  return `<Qry:displayLevel default="false" type="${v}"/>`;
}

function sortingEl(spec: SortingSpec, dimensionName: string | undefined): string {
  if (spec.by === 'default') return '<Qry:sorting default="true"/>';
  const dir = spec.direction ?? 'Ascending';
  const dimAttr = dimensionName ? ` dimensionName="${escapeXml(dimensionName)}"` : '';
  return `<Qry:sorting default="false"${dimAttr} sortBy="${spec.by}" sortDirection="${dir}"/>`;
}

function expandToLevelEl(level: number): string {
  if (level <= 0) return '<Qry:expandToLevel default="true"/>';
  return `<Qry:expandToLevel default="false" level="${String(level).padStart(2, '0')}"/>`;
}

function childNodePositionEl(v: 'above' | 'below' | 'default'): string {
  if (v === 'default') return '<Qry:positionOfChildNodes default="true"/>';
  return `<Qry:positionOfChildNodes default="false" up="${bool(v === 'above')}"/>`;
}

function postableNodeValuesEl(v: 'show' | 'hide' | 'default'): string {
  if (v === 'default') return '<Qry:valuesOfPostableNodes default="true"/>';
  return `<Qry:valuesOfPostableNodes default="false" show="${bool(v === 'show')}"/>`;
}

function suppressNodesEl(v: Switch): string {
  if (v === 'default') return '<Qry:suppressNodes default="true"/>';
  return `<Qry:suppressNodes default="false" suppress="${bool(v === 'on')}"/>`;
}

/** A hierarchy parameter (name / version / dateTo) carried as a literal value. */
function paramValueEl(tag: string, value: string): string {
  if (value === '') return `<Qry:${tag}/>`;
  return `<Qry:${tag}><Qry:value>${escapeXml(value)}</Qry:value><Qry:type>Value</Qry:type></Qry:${tag}>`;
}

// ── Document surgery ───────────────────────────────────────────────────────

interface DimensionBlock {
  container: 'rows' | 'columns' | 'free';
  infoobject: string;
  start: number;
  end: number;
  element: string;
}

/**
 * Collect the rows/columns/free Dimension blocks of the query itself. Scoped to
 * mainComponent, because embedded subComponents (reusable structures) carry blocks
 * of their own that are not part of this query's layout.
 */
function findDimensions(doc: string, axis?: string, iobj?: string): DimensionBlock[] {
  const region = locateMainComponentRegion(doc, 'characteristic lookup');
  const body = doc.slice(region.start, region.end);
  const containers = axis ? [axis] : ['rows', 'columns', 'free'];
  const found: DimensionBlock[] = [];
  for (const container of containers) {
    const re = new RegExp(`<Qry:${container}\\b[^>]*xsi:type="Qry:Dimension"[^>]*>[\\s\\S]*?</Qry:${container}>`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const openTag = m[0].slice(0, m[0].indexOf('>') + 1);
      const name = openTag.match(/\binfoObjectName="([^"]*)"/)?.[1];
      if (!name) continue;
      if (iobj && name.toUpperCase() !== iobj) continue;
      found.push({
        container: container as DimensionBlock['container'],
        infoobject: name,
        start: region.start + m.index,
        end: region.start + m.index + m[0].length,
        element: m[0],
      });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Offsets of the nested hierarchy block, which shadows same-named direct children. */
function hierarchyRange(element: string): { start: number; end: number } | null {
  const m = /<Qry:hierarchy\b[^>]*?(\/>|>[\s\S]*?<\/Qry:hierarchy>)/.exec(element);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

/**
 * Replace a direct child of the Dimension block. Matches inside the hierarchy block
 * are skipped: Qry:sorting exists both as the characteristic's own sorting and as
 * the hierarchy's, and only the outer one belongs to this replacement.
 */
function replaceDirectChild(element: string, tag: string, replacement: string, what: string): string {
  const hier = hierarchyRange(element);
  const re = new RegExp(`<Qry:${escapeRegex(tag)}\\b[^>]*?(\\/>|>[\\s\\S]*?<\\/Qry:${escapeRegex(tag)}>)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(element)) !== null) {
    if (hier && m.index >= hier.start && m.index < hier.end) continue;
    return element.slice(0, m.index) + replacement + element.slice(m.index + m[0].length);
  }
  throw new Error(`${what}: no <Qry:${tag}> element in the characteristic block.`);
}

/** Replace a child of the hierarchy block, appending it when the block does not carry one yet. */
function setHierarchyChild(hier: string, tag: string, replacement: string): string {
  const re = new RegExp(`<Qry:${escapeRegex(tag)}\\b[^>]*?(\\/>|>[\\s\\S]*?<\\/Qry:${escapeRegex(tag)}>)`);
  const m = re.exec(hier);
  if (m) return hier.slice(0, m.index) + replacement + hier.slice(m.index + m[0].length);
  const closeIdx = hier.lastIndexOf('</Qry:hierarchy>');
  if (closeIdx < 0) throw new Error('Malformed hierarchy block in the characteristic.');
  return hier.slice(0, closeIdx) + replacement + hier.slice(closeIdx);
}

function setOpenTagAttr(element: string, attr: string, value: string): string {
  const openEnd = element.indexOf('>');
  if (openEnd < 0) throw new Error('Malformed element — no opening tag.');
  const openTag = element.slice(0, openEnd + 1);
  const selfClosing = openTag.endsWith('/>');
  const re = new RegExp(`\\s${escapeRegex(attr)}="[^"]*"`);
  let newTag: string;
  if (re.test(openTag)) {
    newTag = openTag.replace(re, ` ${attr}="${value}"`);
  } else {
    const cut = selfClosing ? openTag.length - 2 : openTag.length - 1;
    newTag = `${openTag.slice(0, cut)} ${attr}="${value}"${openTag.slice(cut)}`;
  }
  return newTag + element.slice(openEnd + 1);
}

/**
 * Reading Qry:name resets the stored expand level, so an expandToLevel that sits in
 * front of the name in the document is thrown away on import. Move it behind.
 */
function ensureExpandLevelAfterName(hier: string): string {
  const nameMatch = /<Qry:name\b[^>]*?(\/>|>[\s\S]*?<\/Qry:name>)/.exec(hier);
  const expandMatch = /<Qry:expandToLevel\b[^>]*?(\/>|>[\s\S]*?<\/Qry:expandToLevel>)/.exec(hier);
  if (!nameMatch || !expandMatch) return hier;
  if (expandMatch.index > nameMatch.index) return hier;
  const without = hier.slice(0, expandMatch.index) + hier.slice(expandMatch.index + expandMatch[0].length);
  const shift = expandMatch[0].length;
  const insertAt = nameMatch.index - shift + nameMatch[0].length;
  return without.slice(0, insertAt) + expandMatch[0] + without.slice(insertAt);
}

function applyHierarchy(element: string, spec: HierarchySpec, applied: string[]): string {
  const range = hierarchyRange(element);
  if (!range) throw new Error('No <Qry:hierarchy> element in the characteristic block.');
  let hier = element.slice(range.start, range.end);

  if (hier.endsWith('/>')) {
    // Expand the self-closing form so children can be inserted.
    hier = hier.slice(0, hier.length - 2) + '></Qry:hierarchy>';
  }

  if (spec.name !== undefined) {
    hier = setHierarchyChild(hier, 'name', paramValueEl('name', spec.name));
    // A hierarchy that is assigned but not active has no effect, and clearing the
    // name while the flag stays on leaves the characteristic in a broken state.
    if (spec.active === undefined) hier = setOpenTagAttr(hier, 'active', bool(spec.name !== ''));
    applied.push('hierarchy.name');
  }
  if (spec.active !== undefined) {
    hier = setOpenTagAttr(hier, 'active', bool(spec.active));
    applied.push('hierarchy.active');
  }
  if (spec.version !== undefined) {
    hier = setHierarchyChild(hier, 'version', paramValueEl('version', spec.version));
    applied.push('hierarchy.version');
  }
  if (spec.valid_to !== undefined) {
    hier = setHierarchyChild(hier, 'dateTo', paramValueEl('dateTo', spec.valid_to));
    applied.push('hierarchy.valid_to');
  }
  if (spec.expand_to_level !== undefined) {
    if (!Number.isInteger(spec.expand_to_level) || spec.expand_to_level < 0) {
      throw new Error('hierarchy.expand_to_level must be a non-negative integer (0 = default).');
    }
    hier = setHierarchyChild(hier, 'expandToLevel', expandToLevelEl(spec.expand_to_level));
    applied.push('hierarchy.expand_to_level');
  }
  if (spec.child_node_position !== undefined) {
    hier = setHierarchyChild(hier, 'positionOfChildNodes', childNodePositionEl(spec.child_node_position));
    applied.push('hierarchy.child_node_position');
  }
  if (spec.postable_node_values !== undefined) {
    hier = setHierarchyChild(hier, 'valuesOfPostableNodes', postableNodeValuesEl(spec.postable_node_values));
    applied.push('hierarchy.postable_node_values');
  }
  if (spec.suppress_single_child_nodes !== undefined) {
    hier = setHierarchyChild(hier, 'suppressNodes', suppressNodesEl(spec.suppress_single_child_nodes));
    applied.push('hierarchy.suppress_single_child_nodes');
  }
  if (spec.sorting !== undefined) {
    hier = setHierarchyChild(hier, 'sorting', sortingEl(spec.sorting, undefined));
    applied.push('hierarchy.sorting');
  }

  hier = ensureExpandLevelAfterName(hier);
  return element.slice(0, range.start) + hier + element.slice(range.end);
}

function applyToDimension(block: DimensionBlock, spec: CharacteristicSpec, applied: string[]): string {
  let element = block.element;
  const what = `characteristic ${block.infoobject}`;

  if (spec.display_as !== undefined) {
    element = replaceDirectChild(element, 'valuePresentation', valuePresentationEl(spec.display_as, spec.text_type), what);
    applied.push('display_as');
  } else if (spec.text_type !== undefined) {
    throw new Error(`${what}: text_type only applies together with display_as.`);
  }
  if (spec.result_rows !== undefined) {
    element = replaceDirectChild(element, 'resultPresentation', resultPresentationEl(spec.result_rows), what);
    applied.push('result_rows');
  }
  if (spec.access_type !== undefined) {
    element = replaceDirectChild(element, 'readMode', readModeEl(spec.access_type), what);
    applied.push('access_type');
  }
  if (spec.cumulate !== undefined) {
    element = replaceDirectChild(element, 'cumulation', cumulationEl(spec.cumulate), what);
    applied.push('cumulate');
  }
  if (spec.display_level !== undefined) {
    element = replaceDirectChild(element, 'displayLevel', displayLevelEl(spec.display_level), what);
    applied.push('display_level');
  }
  if (spec.sorting !== undefined) {
    const dim = spec.sorting.by === 'default'
      ? undefined
      : (spec.sorting.sort_by_characteristic ?? block.infoobject).toUpperCase();
    element = replaceDirectChild(element, 'sorting', sortingEl(spec.sorting, dim), what);
    applied.push('sorting');
  }
  if (spec.hierarchy !== undefined) {
    element = applyHierarchy(element, spec.hierarchy, applied);
  }

  return element;
}

export interface AppliedReport {
  characteristic: string;
  axis: string;
  applied: string[];
}

/**
 * Apply every characteristic spec to the query document. Exported so the XML surgery
 * can be exercised without a BW system.
 */
export function applyCharacteristicSpecs(
  xml: string,
  specs: CharacteristicSpec[],
  report: AppliedReport[] = []
): string {
  let doc = xml;
  for (const spec of specs) {
    const settingKeys = Object.keys(spec).filter(
      (k) => k !== 'infoobject' && k !== 'axis' && (spec as unknown as Record<string, unknown>)[k] !== undefined
    );
    if (settingKeys.length === 0) {
      throw new Error(`characteristic ${spec.infoobject}: no property to change.`);
    }

    const wanted = spec.infoobject === '*' ? undefined : spec.infoobject.toUpperCase();
    const blocks = findDimensions(doc, spec.axis, wanted);
    if (blocks.length === 0) {
      const where = spec.axis ? ` in ${spec.axis}` : '';
      throw new Error(
        `Characteristic ${spec.infoobject} is not part of the query layout${where}. ` +
        `Add it with bw_update_query_layout first, or check the technical name.`
      );
    }

    // Apply back to front so earlier offsets stay valid while the document grows.
    for (const block of [...blocks].reverse()) {
      const applied: string[] = [];
      const mutated = applyToDimension(block, spec, applied);
      doc = doc.slice(0, block.start) + mutated + doc.slice(block.end);
      report.push({ characteristic: block.infoobject, axis: block.container, applied });
    }
  }
  return doc;
}

// ── Tool ───────────────────────────────────────────────────────────────────

/**
 * bw_update_query_characteristic — set the display and access properties of the
 * characteristics in an existing query's rows, columns, and free-characteristics
 * areas. All specs are applied in one read-modify-write save cycle (one PUT).
 */
export async function bwUpdateQueryCharacteristic(
  client: BwClient,
  args: UpdateQueryCharacteristicArgs
): Promise<string> {
  if (!args.characteristics || args.characteristics.length === 0) {
    throw new Error('bw_update_query_characteristic requires at least one entry in characteristics.');
  }

  const report: AppliedReport[] = [];
  const mutate = (xml: string): string => applyCharacteristicSpecs(xml, args.characteristics, report);

  const { messages } = await withQueryDocument(client, args.query_name, mutate, args.transport);
  return JSON.stringify({
    success: true,
    query_name: args.query_name.toUpperCase(),
    characteristics: report.sort((a, b) => a.characteristic.localeCompare(b.characteristic)),
    check_messages: messages,
  });
}
