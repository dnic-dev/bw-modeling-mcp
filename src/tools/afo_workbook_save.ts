import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { BwClient } from '../bw-client.js';
import { callRfc, rfcField, rfcRows, rfcStruct, type RfcValue } from '../soap-rfc.js';
import { queryTable, sqlLiteral, inListBatches } from './metadata_sql.js';
import { isOfficePackage, usageLines, collectWorkbooks } from './afo_workbooks.js';

/**
 * Saving an Analysis for Office workbook to BW, and placing it in a role menu, the way
 * Analysis for Office does it: RSAO_BICS_SAVE stores the file, RSOBJS_ALTER_NODE_REFS adds the
 * launcher node to the role (verified against an RFC trace of Analysis for Office saving to a
 * role).
 *
 * RSAO_BICS_SAVE replaces an existing workbook of the same name without asking, so the
 * existence check and the explicit overwrite live here. It also stores whatever where-used
 * list the caller sends: Analysis for Office derives it from the workbook, and so does this
 * module, from the AfO definition inside the file. A data source or planning object of a kind
 * not mapped here stops the save, rather than leaving BW with a where-used list that misses it.
 */

// ── Reading the workbook ─────────────────────────────────────────────────────

interface ZipEntry {
  name: string;
  method: number;
  size: number;
  local: number;
}

/** The central directory of a ZIP package. Stored and deflated entries; no ZIP64. */
function zipEntries(zip: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('The file is not a valid ZIP package.');
  const entries: ZipEntry[] = [];
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = zip.readUInt16LE(eocd + 10); n > 0 && zip.readUInt32LE(p) === 0x02014b50; n--) {
    const nameLen = zip.readUInt16LE(p + 28);
    entries.push({
      name: zip.toString('utf8', p + 46, p + 46 + nameLen),
      method: zip.readUInt16LE(p + 10),
      size: zip.readUInt32LE(p + 20),
      local: zip.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return entries;
}

export function zipNames(zip: Buffer): string[] {
  return zipEntries(zip).map((e) => e.name);
}

export function zipPart(zip: Buffer, name: string): Buffer | undefined {
  const e = zipEntries(zip).find((x) => x.name === name);
  if (!e) return undefined;
  const start = e.local + 30 + zip.readUInt16LE(e.local + 26) + zip.readUInt16LE(e.local + 28);
  const data = zip.subarray(start, start + e.size);
  return e.method === 0 ? Buffer.from(data) : inflateRawSync(data);
}

/** Analysis for Office writes its custom properties as UTF-16LE, with or without a BOM. */
function decodeText(b: Buffer): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b.length >= 4 && b[1] === 0 && b[3] === 0 && b[0] !== 0) return b.toString('utf16le');
  return b.toString('utf8');
}

/** The AfO definition of the workbook, or undefined for a file Analysis for Office never saved. */
export function afoDefinition(file: Buffer): string | undefined {
  for (const name of zipNames(file).filter((n) => /^xl\/customProperty\d+\.bin$/.test(n))) {
    const part = zipPart(file, name);
    const text = part ? decodeText(part) : '';
    if (/xmlns="http:\/\/www\.sap\.com\/ip\/bi\/pioneer\/excel\/application"/.test(text)) return text;
  }
  return undefined;
}

function xmlText(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) return undefined;
  return m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export interface WorkbookUsage {
  dataSources: Array<{ alias: string; name: string; type: string }>;
  planning: Array<{ alias: string; name: string; kind: string }>;
  /** BPC planning models, each named as its environment padded to 20 characters plus the model. */
  models: string[];
}

export function workbookUsage(definition: string): WorkbookUsage {
  const dataSources = [...definition.matchAll(/<DataProvider>([\s\S]*?)<\/DataProvider>/g)].map((m) => {
    const info = xmlText(m[1], 'DataSourceInfo') ?? '';
    // Id holds the technical name; Name is the query text when AfO stored one.
    const name = xmlText(info, 'Id') || xmlText(info, 'Name') || '';
    return { alias: xmlText(m[1], 'Key') ?? '', name, type: xmlText(info, 'Type') ?? '' };
  });
  const objects = xmlText(definition, 'PlanningObjects') ?? '';
  const planning = [...objects.matchAll(/<Planning(\w+)Usage>([\s\S]*?)<\/Planning\1Usage>/g)].map((m) => ({
    alias: xmlText(m[2], 'Key') ?? '',
    name: xmlText(xmlText(m[2], 'PlanningObjectInfo') ?? '', 'Name') ?? '',
    kind: m[1],
  }));
  const design = xmlText(definition, 'PlanningSystemDesignTime') ?? '';
  const models = [...design.matchAll(/<PlanningModel>([\s\S]*?)<\/PlanningModel>/g)]
    .map((m) => xmlText(xmlText(m[1], 'PlanningObjectInfo') ?? '', 'Name') ?? '')
    .filter((n) => n.trim());
  return { dataSources, planning, models };
}

// ── The where-used list Analysis for Office sends ────────────────────────────

export interface XrefRow {
  TLOGO: string;
  OBJNM: string;
  ASC_TYPE: string;
  S_ALIAS: string;
  SUBTYPE: string;
  SYSCON_TYPE: string;
  SYSCON: string;
}

const PLANNING_TLOGO: Record<string, string> = { Function: 'PLSE', Sequence: 'PLSQ' };
const ENVIRONMENT_LENGTH = 20;

function xref(tlogo: string, objnm: string, alias: string): XrefRow {
  // Every entry Analysis for Office writes carries these values, whatever the object.
  return { TLOGO: tlogo, OBJNM: objnm, ASC_TYPE: '002', S_ALIAS: alias, SUBTYPE: '', SYSCON_TYPE: '1', SYSCON: '' };
}

/** Kinds this module cannot map yet; the save stops on them. */
export function unsupportedUsage(usage: WorkbookUsage): string[] {
  return [
    ...usage.dataSources.filter((d) => d.type !== 'Query').map((d) => `data source ${d.alias} (${d.name}) of type "${d.type || '?'}"`),
    ...usage.planning.filter((p) => !PLANNING_TLOGO[p.kind]).map((p) => `planning object ${p.alias} (${p.name}) of kind "${p.kind}"`),
  ];
}

/** Queries are recorded under their element UID; `uids` maps query names to it. */
export function buildXref(usage: WorkbookUsage, uids: Map<string, string>): XrefRow[] {
  const rows: XrefRow[] = [];
  for (const d of usage.dataSources) {
    const uid = uids.get(d.name.toUpperCase());
    if (!uid) throw new Error(`Query ${d.name} (data source ${d.alias}) does not exist on this system.`);
    rows.push(xref('ELEM', uid, d.alias));
  }
  for (const p of usage.planning) rows.push(xref(PLANNING_TLOGO[p.kind], p.name, p.alias));
  for (const model of usage.models) {
    rows.push(xref('MODL', model, 'MODL'));
    rows.push(xref('ENVM', model.slice(0, ENVIRONMENT_LENGTH).trim(), 'ENVM'));
  }
  return rows;
}

async function queryUids(client: BwClient, names: string[]): Promise<Map<string, string>> {
  const uids = new Map<string, string>();
  const prefix = "SELECT mapname, eltuid FROM rszeltdir WHERE objvers = 'A' AND deftp = 'REP' AND mapname IN ";
  for (const batch of inListBatches([...new Set(names.map((n) => n.toUpperCase()))], 255 - prefix.length - 2)) {
    for (const r of await queryTable(client, `${prefix}(${batch})`, 1000)) uids.set(r.MAPNAME, r.ELTUID);
  }
  return uids;
}

// ── Role menus ───────────────────────────────────────────────────────────────

export interface RoleNode {
  NODE_ID: string;
  PARENT_ID: string;
  ROLE_KEY: string;
  OBJ_KEY: string;
  OBJ_TEXT: string;
  OBJ_TECHNAME: string;
  ISFOLDER: string;
}

async function roleNodes(client: BwClient, expand?: RoleNode): Promise<RoleNode[]> {
  const xml = await callRfc(client, 'RSOBJS_GET_NODES', {
    I_S_PARAMS: {
      OBJ_TYPE: 'AAOE',
      OBJ_VIEW: 'RO',
      EXPAND_NODE_ID: expand?.NODE_ID ?? '',
      OBJ_KEY: expand?.ROLE_KEY ?? '',
      DISP_MODE: 'S',
    },
    E_T_MESSAGE: [],
  });
  const nodes = rfcRows(xml, 'E_T_NODES') as unknown as RoleNode[];
  return expand ? nodes.filter((n) => n.PARENT_ID === expand.NODE_ID) : nodes;
}

/** Folder names a path is split into: "A/B", "A > B" and "A › B" alike. */
export function folderPath(folder?: string): string[] {
  return (folder ?? '').split(/\s*(?:\/|›|>)\s*/).map((s) => s.trim()).filter(Boolean);
}

/**
 * The role, or the folder inside it, as the role menu service presents it to Analysis for
 * Office in its save dialog; the node's role key is what the entry is created under.
 */
export async function resolveRoleTarget(client: BwClient, role: string, folder?: string): Promise<{ target: RoleNode; path: string[]; children: RoleNode[] }> {
  const roles = await roleNodes(client);
  let target = roles.find((n) => n.ISFOLDER === 'X' && n.OBJ_TECHNAME.trim().toUpperCase() === role.trim().toUpperCase());
  if (!target) {
    throw new Error(`Role ${role.trim().toUpperCase()} is not among the roles this user may save to.`);
  }
  const path: string[] = [];
  let children = await roleNodes(client, target);
  for (const segment of folderPath(folder)) {
    const next = children.find((n) => n.ISFOLDER === 'X' && n.OBJ_TEXT.trim().toLowerCase() === segment.toLowerCase());
    if (!next) {
      const folders = children.filter((n) => n.ISFOLDER === 'X').map((n) => `"${n.OBJ_TEXT.trim()}"`);
      throw new Error(
        `Folder "${segment}" not found in ${[role.trim().toUpperCase(), ...path].join(' › ')}. ` +
          (folders.length ? `Folders there: ${folders.join(', ')}.` : 'It has no folders.'),
      );
    }
    path.push(next.OBJ_TEXT.trim());
    target = next;
    children = await roleNodes(client, target);
  }
  return { target, path, children };
}

// ── The edit lock ────────────────────────────────────────────────────────────

/**
 * RSAO_BICS_SAVE takes the workbook's edit lock and hands it to the update task, so it outlives
 * the session and the logoff. Analysis for Office releases it with RSAO_BICS_CLOSE when the
 * workbook is closed; a save from here has nothing open, so it releases it right away.
 * RSAO_BICS_CLOSE only ever removes the calling user's own lock.
 */
async function releaseLock(client: BwClient, name: string): Promise<void> {
  await callRfc(client, 'RSAO_BICS_CLOSE', { IV_TECHNAME: name, IV_OBJTYPE: '00', E_T_MESSAGES: [] }).catch(() => undefined);
}

/** The calling user's edit locks on exactly this workbook. */
async function heldLocks(client: BwClient, name: string): Promise<number> {
  const xml = await callRfc(client, 'ENQUEUE_READ', { GNAME: 'RSAOOBJ', ENQ: [] });
  return rfcRows(xml, 'ENQ').filter((e) => (e.GARG ?? '').startsWith(name.padEnd(30))).length;
}

// ── Tool: bw_save_afo_workbook ───────────────────────────────────────────────

export interface SaveAfoWorkbookArgs {
  name: string;
  file_path?: string;
  content_base64?: string;
  description?: string;
  overwrite?: boolean;
  role?: string;
  folder?: string;
}

interface SaveMessage {
  MSGTY: string;
  TEXT: string;
}

function messageTexts(rows: SaveMessage[]): string[] {
  return rows.filter((m) => (m.TEXT ?? '').trim()).map((m) => `${m.MSGTY || 'I'}: ${m.TEXT.trim()}`);
}

export async function bwSaveAfoWorkbook(client: BwClient, args: SaveAfoWorkbookArgs, local: boolean): Promise<string> {
  const name = (args.name ?? '').trim().toUpperCase();
  if (!name) throw new Error('name is required.');
  if (!!args.file_path === !!args.content_base64) throw new Error('Pass exactly one of file_path or content_base64.');
  if (args.file_path && !local) {
    throw new Error('file_path reads from the disk of the machine the server runs on, which on a hosted server is not yours. Pass content_base64.');
  }
  if (args.folder && !args.role) throw new Error('folder needs role.');

  const file = args.file_path ? readFileSync(args.file_path) : Buffer.from(args.content_base64!.replace(/\s+/g, ''), 'base64');
  if (!isOfficePackage(file)) throw new Error('The content is not an Office document (no ZIP signature).');
  const names = zipNames(file);
  const isPowerPoint = names.some((n) => n.startsWith('ppt/'));
  if (isPowerPoint) throw new Error('Only Excel workbooks can be saved; this is a PowerPoint presentation.');
  const fileType = names.includes('xl/vbaProject.bin') ? 'xlsm' : 'xlsx';

  const definition = afoDefinition(file);
  if (!definition) throw new Error('The file holds no Analysis for Office definition; save it from Analysis for Office once first.');
  const usage = workbookUsage(definition);
  const unsupported = unsupportedUsage(usage);
  if (unsupported.length) {
    throw new Error(
      `Not saved: the where-used list for ${unsupported.join('; ')} cannot be built yet, and BW would record the workbook without it.`,
    );
  }

  const existing = (
    await queryTable(client, `SELECT techname, docversion FROM rsaoobj WHERE objvers = 'A' AND objtype = '00' AND techname = '${sqlLiteral(name)}'`, 1)
  )[0];
  if (existing && !args.overwrite) {
    return `Not saved: workbook ${name} already exists in BW. Pass overwrite: true to replace it, or choose another name.`;
  }
  let description = (args.description ?? '').trim();
  if (!description && existing) {
    const { list } = await collectWorkbooks(client, { name });
    description = list[0]?.text ?? '';
  }
  if (!description) throw new Error('description is required for a new workbook.');
  if (description.length > 60) throw new Error(`description is ${description.length} characters long; BW keeps at most 60.`);

  // Resolved before the save, so a wrong role or folder leaves BW untouched.
  const roleTarget = args.role ? await resolveRoleTarget(client, args.role, args.folder) : undefined;

  const rows = buildXref(usage, await queryUids(client, usage.dataSources.map((d) => d.name)));
  let saveXml: string;
  try {
    saveXml = await callRfc(client, 'RSAO_BICS_SAVE', {
      IV_TECHNAME: name,
      IV_DESCRIPTION: description,
      IV_CONTENT: file.toString('base64'),
      IV_OBJTYPE: '00',
      IV_FILETYPE: fileType,
      // The version Analysis for Office 2.x writes; an existing workbook keeps its own, since
      // BW refuses to overwrite a document with a lower one.
      IV_DOCVERSION: existing?.DOCVERSION || '02',
      I_T_AO_XREF_OBJ: rows as unknown as RfcValue[],
      E_T_MESSAGES: [],
    });
  } finally {
    await releaseLock(client, name);
  }
  const saveMessages = rfcRows(saveXml, 'E_T_MESSAGES') as unknown as SaveMessage[];
  const errors = saveMessages.filter((m) => /^[EAX]$/.test(m.MSGTY));
  if (errors.length) throw new Error(`BW did not save ${name}: ${messageTexts(errors).join(' ')}`);

  const lines = [
    `Saved workbook ${name} — ${description}${existing ? ' (replaced the existing one)' : ' (new)'}`,
    `  Excel (${fileType}), ${file.length.toLocaleString('en-US')} bytes; where-used list sent with ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`,
    ...messageTexts(saveMessages).map((m) => `  ${m}`),
  ];
  const held = await heldLocks(client, name).catch(() => undefined);
  if (held === undefined) lines.push('  Edit lock not checked: the lock table could not be read.');
  else if (held > 0) lines.push(`  Warning: the edit lock on ${name} is still held; release it in transaction SM12.`);

  if (roleTarget) {
    const where = [args.role!.trim().toUpperCase(), ...roleTarget.path].join(' › ');
    if (roleTarget.children.some((n) => n.ISFOLDER !== 'X' && n.OBJ_KEY.trim().toUpperCase() === name)) {
      lines.push(`  Already in role menu ${where}; no second entry added.`);
    } else {
      const roleXml = await callRfc(client, 'RSOBJS_ALTER_NODE_REFS', {
        I_S_PARAMS: {
          OBJ_TYPE: 'AAOE',
          ACTION: 'C',
          OBJ_VIEW: 'RO',
          IS_FOLDER: '',
          ROLE_KEY: roleTarget.target.ROLE_KEY,
          OBJ_KEY: name,
          OBJ_TECHNAME: name,
          OBJ_TEXT: description,
          OBJ_URL: '',
          WITH_ALL_REFS: '',
        },
        E_T_MESSAGE: [],
      });
      const check = rfcStruct(rfcField(roleXml, 'E_S_CHECK_RESULT'));
      const roleMessages = messageTexts(rfcRows(roleXml, 'E_T_MESSAGE') as unknown as SaveMessage[]);
      if (check.OVERALL_OK !== 'X') {
        const reason = check.LOCKED === 'X' ? `the role is locked${check.LOCKUSER ? ` by ${check.LOCKUSER}` : ''}` : check.AUTHORIZED !== 'X' ? 'no authorization to change the role menu' : 'the role menu service refused it';
        lines.push(`  Workbook saved, but not added to role menu ${where}: ${reason}.${roleMessages.length ? ` ${roleMessages.join(' ')}` : ''}`);
      } else {
        lines.push(`  Added to role menu ${where}`);
      }
    }
  }

  // Read back what BW now records, so the answer shows the result rather than the request.
  try {
    const { list } = await collectWorkbooks(client, { name });
    const saved = list.find((w) => w.name === name);
    if (saved) lines.push('', `As recorded in BW (last changed ${saved.changedAt} UTC by ${saved.changedBy}):`, ...usageLines(saved));
  } catch (err) {
    lines.push(`  Not read back: ${(err as Error).message.split('\n')[0]}`);
  }
  return lines.join('\n');
}
