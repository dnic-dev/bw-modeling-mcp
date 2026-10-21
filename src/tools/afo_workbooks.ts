import { BwClient } from '../bw-client.js';
import { queryTable, sqlLiteral, formatStamp, inListBatches, SAP_LANGUAGE, type Row } from './metadata_sql.js';

/**
 * Analysis for Office documents stored in BW (RSAOOBJ), with the where-used list BW keeps for
 * them (RSAOOBJXREF), read through ADT DataPreview.
 *
 * A data source that is a query is recorded under the query's element UID, not its name, so
 * those entries are joined to RSZELTDIR. Other data sources (an aggregation level or a
 * provider queried directly) and planning objects are recorded by name. The document itself
 * sits in RSAOOBJ-CONTENT as one raw string and is never selected here.
 *
 * The tables exist on classic releases and on BW/4HANA alike; RSAOOBJ also holds Design Studio
 * applications (OBJTYPE 10), which are not Analysis for Office documents and are left out.
 *
 * A workbook placed in a role menu is a node for the launcher transaction RAAOE, and the node
 * carries the workbook's technical name in AGR_HIER-SAP_GUID. Which workbooks a role may open
 * under S_RS_AO is a different question and not answered here: its values are mostly patterns,
 * and opening a workbook needs more authorizations than that one.
 */

export const MAX_STATEMENT = 255;

/** Enough for every workbook of a large system in one statement each. */
export const MAX_ROWS = 50000;

const DOC_TYPES: Record<string, string> = { '00': 'Excel', '01': 'PowerPoint' };

const OBJECT_KINDS: Record<string, string> = {
  ELEM: 'query',
  ALVL: 'aggregation level',
  PLSE: 'planning function',
  PLSQ: 'planning sequence',
  ADSO: 'DataStore object',
  HCPR: 'CompositeProvider',
  CUBE: 'InfoCube',
  MPRO: 'MultiProvider',
  ODSO: 'DataStore object (classic)',
  IOBJ: 'InfoObject',
  ENVM: 'BPC environment',
  MODL: 'BPC model',
};

const PLANNING = new Set(['PLSE', 'PLSQ', 'ENVM', 'MODL']);

/** A BPC model is recorded as its environment, padded to 20 characters, followed by its name. */
const ENVIRONMENT_LENGTH = 20;

function checked(sql: string): string {
  if (sql.length > MAX_STATEMENT) {
    throw new Error(`The statement is ${sql.length} characters long; DataPreview reads at most ${MAX_STATEMENT}. Use a shorter name pattern.`);
  }
  return sql;
}

/** `*` is the wildcard; `_` and `%` are taken literally, as they are in a technical name. */
export function likePattern(pattern: string): string {
  return sqlLiteral(pattern.trim().toUpperCase()).replace(/[#_%]/g, '#$&').replace(/\*/g, '%');
}

export function workbooksStatement(name?: string): string {
  const base = 'SELECT techname, objtype, filetype, tstpnm, timestmp FROM rsaoobj WHERE objvers = \'A\'';
  if (!name?.trim()) return base;
  if (!name.includes('*')) return checked(`${base} AND techname = '${sqlLiteral(name.trim().toUpperCase())}'`);
  return checked(`${base} AND techname LIKE '${likePattern(name)}' ESCAPE '#'`);
}

export const TEXTS_STATEMENT = "SELECT techname, langu, descr FROM rsaoobjt WHERE objvers = 'A'";

export const XREF_STATEMENT =
  'SELECT x~techname, x~tlogo, x~objnm, x~s_alias, e~mapname FROM rsaoobjxref AS x ' +
  "LEFT OUTER JOIN rszeltdir AS e ON e~eltuid = x~objnm AND e~objvers = 'A' AND e~deftp = 'REP' " +
  "WHERE x~objvers = 'A'";

export interface UsedObject {
  alias: string;
  kind: string;
  type: string;
  /** The query name for a query, otherwise the object name as recorded. */
  name: string;
  /** The element UID of a query, as recorded. */
  uid?: string;
  /** A query whose definition is not found, so `name` is its UID. */
  unresolved?: boolean;
  /** The environment of a BPC model. */
  environment?: string;
}

export interface MenuPlacement {
  role: string;
  roleText: string;
  /** Folder texts from the top of the menu down to the workbook's node. */
  path: string[];
}

export interface Workbook {
  name: string;
  text: string;
  docType: string;
  fileType: string;
  changedBy: string;
  changedAt: string;
  stamp: string;
  dataSources: UsedObject[];
  planning: UsedObject[];
  menus: MenuPlacement[];
}

function aliasOrder(a: UsedObject, b: UsedObject): number {
  return a.alias.localeCompare(b.alias, 'en', { numeric: true }) || a.name.localeCompare(b.name);
}

export function toUsedObject(r: Row): UsedObject {
  const type = r.TLOGO;
  const isQuery = type === 'ELEM';
  if (type === 'MODL' && r.OBJNM.length > ENVIRONMENT_LENGTH) {
    return {
      alias: r.S_ALIAS,
      kind: OBJECT_KINDS.MODL,
      type,
      name: r.OBJNM.slice(ENVIRONMENT_LENGTH).trim(),
      environment: r.OBJNM.slice(0, ENVIRONMENT_LENGTH).trim(),
    };
  }
  const name = isQuery ? r.MAPNAME || r.OBJNM : r.OBJNM;
  return {
    alias: r.S_ALIAS,
    kind: OBJECT_KINDS[type] ?? `${type} object`,
    type,
    name,
    ...(isQuery ? { uid: r.OBJNM } : {}),
    ...(isQuery && !r.MAPNAME ? { unresolved: true } : {}),
  };
}

/** Logon language first, then English, then whatever text exists. */
function bestTexts(
  rows: Row[],
  key: (r: Row) => string,
  langField: string,
  textField: string,
  language?: string,
): Map<string, string> {
  const logon = SAP_LANGUAGE[(language ?? '').toUpperCase()];
  const rank = (langu: string) => (langu === logon ? 0 : langu === 'E' ? 1 : 2);
  const best = new Map<string, { rank: number; text: string }>();
  for (const r of rows) {
    const text = (r[textField] ?? '').trim();
    if (!text) continue;
    const k = rank(r[langField]);
    if (k < (best.get(key(r))?.rank ?? 9)) best.set(key(r), { rank: k, text });
  }
  return new Map([...best].map(([name, v]) => [name, v.text]));
}

export function pickTexts(rows: Row[], language?: string): Map<string, string> {
  return bestTexts(rows, (r) => r.TECHNAME, 'LANGU', 'DESCR', language);
}

// ── Role menus ───────────────────────────────────────────────────────────────

export const MENU_STATEMENT =
  "SELECT agr_name, object_id, parent_id, sap_guid FROM agr_hier WHERE reporttype = 'TR' AND report = 'RAAOE'";

/** The statements that read the folders and texts of the given roles, in IN-list batches. */
export function roleDetailStatements(roles: string[]): { nodes: string[]; nodeTexts: string[]; roleTexts: string[] } {
  const build = (prefix: string, suffix = '') =>
    inListBatches(roles, MAX_STATEMENT - prefix.length - suffix.length - 2).map((b) => checked(`${prefix}(${b})${suffix}`));
  return {
    nodes: build('SELECT agr_name, object_id, parent_id FROM agr_hier WHERE agr_name IN '),
    nodeTexts: build('SELECT agr_name, object_id, spras, text FROM agr_hiert WHERE agr_name IN '),
    roleTexts: build("SELECT agr_name, spras, text FROM agr_texts WHERE line = '00000' AND agr_name IN "),
  };
}

export function menuPlacements(
  menuRows: Row[],
  nodeRows: Row[],
  nodeTextRows: Row[],
  roleTextRows: Row[],
  language?: string,
): Map<string, MenuPlacement[]> {
  const node = (r: Row) => `${r.AGR_NAME}|${r.OBJECT_ID}`;
  const parents = new Map(nodeRows.map((r) => [node(r), r.PARENT_ID]));
  const nodeTexts = bestTexts(nodeTextRows, node, 'SPRAS', 'TEXT', language);
  const roleTexts = bestTexts(roleTextRows, (r) => r.AGR_NAME, 'SPRAS', 'TEXT', language);
  const result = new Map<string, MenuPlacement[]>();
  for (const r of menuRows) {
    const workbook = (r.SAP_GUID ?? '').trim().toUpperCase();
    if (!workbook) continue;
    const path: string[] = [];
    let id = r.PARENT_ID;
    // The menu root is not a node of its own, so the walk ends at the first unknown parent.
    for (let depth = 0; depth < 32 && parents.has(`${r.AGR_NAME}|${id}`); depth++) {
      const text = nodeTexts.get(`${r.AGR_NAME}|${id}`);
      if (text) path.unshift(text);
      id = parents.get(`${r.AGR_NAME}|${id}`)!;
    }
    const list = result.get(workbook) ?? [];
    list.push({ role: r.AGR_NAME, roleText: roleTexts.get(r.AGR_NAME) ?? '', path });
    result.set(workbook, list);
  }
  return result;
}

/**
 * A role matches by its name, in full, or by its description, anywhere in it; `*` is the
 * wildcard and case does not matter. Menu roles are often named by a code while the
 * application they serve is only in the description.
 */
export function roleMatches(pattern: string, menu: MenuPlacement): boolean {
  const body = pattern.trim().split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`, 'i').test(menu.role) || new RegExp(body, 'i').test(menu.roleText);
}

async function readMenus(client: BwClient, language?: string): Promise<{ menus: Map<string, MenuPlacement[]>; rows: Row[][] }> {
  const menuRows = await queryTable(client, MENU_STATEMENT, MAX_ROWS);
  const roles = [...new Set(menuRows.map((r) => r.AGR_NAME))];
  if (roles.length === 0) return { menus: new Map(), rows: [menuRows] };
  const s = roleDetailStatements(roles);
  const readAll = async (statements: string[]) =>
    (await Promise.all(statements.map((sql) => queryTable(client, sql, MAX_ROWS)))).flat();
  const [nodeRows, nodeTextRows, roleTextRows] = await Promise.all([readAll(s.nodes), readAll(s.nodeTexts), readAll(s.roleTexts)]);
  return {
    menus: menuPlacements(menuRows, nodeRows, nodeTextRows, roleTextRows, language),
    rows: [menuRows, nodeRows, nodeTextRows, roleTextRows],
  };
}

export function assemble(
  workbookRows: Row[],
  textRows: Row[],
  xrefRows: Row[],
  language?: string,
  menus: Map<string, MenuPlacement[]> = new Map(),
): Workbook[] {
  const texts = pickTexts(textRows, language);
  const refs = new Map<string, UsedObject[]>();
  for (const r of xrefRows) {
    const list = refs.get(r.TECHNAME) ?? [];
    list.push(toUsedObject(r));
    refs.set(r.TECHNAME, list);
  }
  return workbookRows
    .filter((r) => r.OBJTYPE in DOC_TYPES)
    .map((r) => {
      const used = refs.get(r.TECHNAME) ?? [];
      return {
        name: r.TECHNAME,
        text: texts.get(r.TECHNAME) ?? '',
        docType: DOC_TYPES[r.OBJTYPE],
        fileType: r.FILETYPE,
        changedBy: r.TSTPNM,
        changedAt: formatStamp(r.TIMESTMP),
        stamp: (r.TIMESTMP ?? '').replace(/\..*$/, ''),
        dataSources: used.filter((u) => !PLANNING.has(u.type)).sort(aliasOrder),
        planning: used.filter((u) => PLANNING.has(u.type)).sort(aliasOrder),
        menus: (menus.get(r.TECHNAME) ?? []).sort((a, b) => a.role.localeCompare(b.role)),
      };
    });
}

export interface WorkbookFilter {
  role?: string;
  usedObject?: string;
  user?: string;
  from?: string;
  to?: string;
}

/** A query matches by its name or its element UID; any other object by its name. */
export function usesObject(wb: Workbook, object: string): boolean {
  const o = object.trim().toUpperCase();
  return [...wb.dataSources, ...wb.planning].some((u) => u.name === o || u.uid === o);
}

export function filterWorkbooks(list: Workbook[], f: WorkbookFilter): Workbook[] {
  return list.filter(
    (wb) =>
      (!f.role || wb.menus.some((m) => roleMatches(f.role!, m))) &&
      (!f.usedObject || usesObject(wb, f.usedObject)) &&
      (!f.user || wb.changedBy === f.user.trim().toUpperCase()) &&
      (!f.from || wb.stamp >= f.from) &&
      (!f.to || wb.stamp <= f.to)
  );
}

/** RSAOOBJ-TIMESTMP is a UTC stamp YYYYMMDDhhmmss; a bare date covers its whole day. */
export function boundStamp(value: string, field: string, end: boolean): string {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v.replace(/-/g, '') + (end ? '235959' : '000000');
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`${field} is not a valid date or timestamp: "${value}".`);
  return d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function describe(u: UsedObject): string {
  const what = u.unresolved
    ? `${u.kind} element ${u.uid} (definition not found)`
    : `${u.kind} ${u.name}${u.environment ? ` in environment ${u.environment}` : ''}`;
  // A BPC environment or model is recorded under its type as alias, which says nothing more.
  return u.alias && u.alias !== u.type ? `${u.alias} → ${what}` : what;
}

export function formatWorkbooks(list: Workbook[], header: string, limit: number): string {
  if (list.length === 0) return `${header}\n  None found.`;
  const shown = list.slice(0, limit);
  const lines = [`${header} ${list.length}${list.length > shown.length ? `, showing the latest ${shown.length}` : ''}`];
  for (const wb of shown) {
    lines.push('', `${wb.name}${wb.text ? ` — ${wb.text}` : ''}`);
    lines.push(`  ${wb.docType} (${wb.fileType}), last changed ${wb.changedAt || '?'} UTC by ${wb.changedBy || '?'}`);
    lines.push(`  Data sources: ${wb.dataSources.length ? wb.dataSources.map(describe).join(', ') : 'none recorded'}`);
    if (wb.planning.length) lines.push(`  Planning: ${wb.planning.map(describe).join(', ')}`);
    for (const m of wb.menus) {
      const where = m.path.length ? m.path.join(' › ') : 'top level';
      lines.push(`  In role menu ${m.role}${m.roleText ? ` (${m.roleText})` : ''}: ${where}`);
    }
  }
  return lines.join('\n');
}

// ── Tool: bw_list_afo_workbooks ──────────────────────────────────────────────

export interface ListAfoWorkbooksArgs {
  name?: string;
  role?: string;
  used_object?: string;
  user?: string;
  changed_from?: string;
  changed_to?: string;
  max_results?: number;
}

export async function bwListAfoWorkbooks(client: BwClient, args: ListAfoWorkbooksArgs): Promise<string> {
  const from = args.changed_from ? boundStamp(args.changed_from, 'changed_from', false) : undefined;
  const to = args.changed_to ? boundStamp(args.changed_to, 'changed_to', true) : undefined;
  if (from && to && from > to) throw new Error('changed_from must lie before changed_to.');

  const workbookRows = await queryTable(client, workbooksStatement(args.name), MAX_ROWS);
  const docs = workbookRows.filter((r) => r.OBJTYPE in DOC_TYPES);
  const [textRows, xrefRows] = docs.length
    ? await Promise.all([queryTable(client, TEXTS_STATEMENT, MAX_ROWS), queryTable(client, XREF_STATEMENT, MAX_ROWS)])
    : [[], []];

  // Role menus sit in other tables, which a user may not be allowed to read. Without a role
  // filter the list stands without them; with one, there is nothing to answer.
  let menus = new Map<string, MenuPlacement[]>();
  let menuRows: Row[][] = [];
  let menuNote = '';
  if (docs.length) {
    try {
      ({ menus, rows: menuRows } = await readMenus(client, client.language));
    } catch (err) {
      if (args.role) throw err;
      menuNote = `Role menus not read: ${(err as Error).message.split('\n')[0]}`;
    }
  }

  const list = filterWorkbooks(assemble(docs, textRows, xrefRows, client.language, menus), {
    role: args.role,
    usedObject: args.used_object,
    user: args.user,
    from,
    to,
  }).sort((a, b) => b.stamp.localeCompare(a.stamp) || a.name.localeCompare(b.name));

  const criteria = [
    args.name ? `name ${args.name.trim().toUpperCase()}` : '',
    args.role ? `in a role menu matching ${args.role.trim()}` : '',
    args.used_object ? `using ${args.used_object.trim().toUpperCase()}` : '',
    args.user ? `changed by ${args.user.trim().toUpperCase()}` : '',
    from || to ? `changed ${from ? `from ${formatStamp(from)}` : ''}${from && to ? ' ' : ''}${to ? `to ${formatStamp(to)}` : ''} UTC` : '',
  ].filter(Boolean);
  const header = `Analysis for Office workbooks stored in BW${criteria.length ? ` (${criteria.join(', ')})` : ''}:`;
  const limit = Math.max(1, Math.min(args.max_results ?? 100, 1000));
  const notes = [menuNote];
  if ([workbookRows, textRows, xrefRows, ...menuRows].some((rows) => rows.length >= MAX_ROWS)) {
    notes.push(`Note: a table returned ${MAX_ROWS} rows, the read limit; narrow the search with name.`);
  }
  return [formatWorkbooks(list, header, limit), ...notes.filter(Boolean)].join('\n\n');
}
