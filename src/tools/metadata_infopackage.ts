import type { BwClient } from '../bw-client.js';
import { queryTable, sqlLiteral, formatStamp, inListBatches, type Row } from './metadata_sql.js';

/**
 * Read an InfoPackage (TLOGO ISIP) from its metadata tables.
 *
 * No release publishes a REST resource for the InfoPackage and BW/4HANA dropped the object
 * type, so — as with the analysis process — the tables are the only route on any platform.
 * RSTLOGOPROP names RSLDPIO as the leading table, keyed by LOGDPID, with RSLDPIOT for texts.
 *
 * Three traps shape this reader:
 *
 *   - The DataSource sits in RSLDPIO-OLTPSOURCE. RSLDPIO-SOURCE is the 3.x InfoSource and is
 *     empty for a 7.x DataSource, so a lookup by SOURCE silently finds nothing.
 *   - RSLDPSEL carries the definition *and* the file and external-system settings in one wide
 *     row per line number, and among them a PASSWORD column for third-party logons. Every
 *     statement here therefore names its columns; none of them may ever become a SELECT *.
 *   - The update mode of the definition (full, delta, init) is not held in any relational
 *     column: a delta, an init and a full InfoPackage of the same DataSource are identical in
 *     RSLDPIO and RSLDPSEL (verified on content packages of each kind). The mode each past run
 *     used is in RSSELDONE-UPDMODE, which is what the load history reports instead.
 */

// ── Domain values ───────────────────────────────────────────────────────────

/** RSLDPIO-OLTPTYP and RSLDPSEL-KIND, domain RSBWREQUTYPE. */
const DATA_TYPES: Record<string, string> = {
  D: 'transaction data',
  M: 'master data attributes',
  T: 'master data texts',
  H: 'hierarchies',
  S: 'segmented DataSource',
};

/** RSLDPSEL-LOCATION, domain RSLOCD. */
const LOCATIONS: Record<string, string> = {
  '0': 'application server',
  '1': 'local workstation (client)',
};

/** RSLDPSEL-FILETYP, domain RSFILETYPD. */
const FILE_TYPES: Record<string, string> = {
  '1': 'ASCII, fixed length (CR as record separator)',
  '2': 'CSV',
  '3': 'Excel native',
};

/** RSLDPSEL-QUELLE, domain RSQUELLE. */
const SOURCES: Record<string, string> = {
  Q: 'source system',
  O: 'DataStore object',
};

/** RSLDPSEL-ZIEL, domain RSZIELD — the 3.x processing option. */
const PROCESSING: Record<string, string> = {
  '0': 'ALE (data targets or check tables)',
  '1': 'PSA only',
  '2': 'PSA and data targets in parallel',
  '3': 'PSA, then data targets',
  '4': 'data targets only',
  '8': 'from PSA into data targets',
};

/** RSLDPSEL-VARTYP, domain RSVARTYPD: how a selection is filled at run time. */
const SELECTION_TYPES: Record<string, string> = {
  '0': 'dynamic: yesterday',
  '1': 'dynamic: last week',
  '2': 'dynamic: last month',
  '3': 'dynamic: last quarter',
  '4': 'dynamic: last year',
  '5': 'free temporal selection',
  '6': 'ABAP routine',
  '7': 'OLAP variable',
};

/** RSLDPSEL-WARNING, domain RSWARNING. Blank is the default, which is green. */
const WARNING_HANDLING: Record<string, string> = {
  G: 'warnings count as success (green)',
  Y: 'warnings count as undecided (yellow)',
  R: 'warnings count as errors (red)',
};

/** RSLDPSEL-UNICODE_ENDIAN, domain RSAC_FILE_ENDIAN. */
const ENDIANNESS: Record<string, string> = {
  B: 'big endian',
  L: 'little endian',
};

/** RSREQDONE-TSTATUS and -QMSTATUS, domain RSSTATUS — the same icon codes as RSSTATMANPART. */
const REQUEST_STATUS: Record<string, string> = {
  '@08@': 'green  (ended successfully)',
  '@09@': 'yellow (incomplete)',
  '@0A@': 'red    (incorrect processing)',
};

/** RSSELDONE-UPDMODE, domain RSUPDMODE. */
const UPDATE_MODES: Record<string, string> = {
  F: 'Full',
  C: 'Delta init',
  D: 'Delta',
  R: 'Repeat',
  I: 'Opening balance',
};

// ── Hex-encoded single characters ───────────────────────────────────────────

const NAMED_CHARS: Record<number, string> = {
  0x09: 'tab',
  0x20: 'space',
};

/**
 * A separator or escape character from its RAW column.
 *
 * FILESEP and ESC are RAW(2): the character as a UTF-16 code unit, which the DataPreview
 * service renders as four hex digits (`003B` for a semicolon). Read as it arrives, `003B`
 * looks like a number. A non-Unicode system stores one byte, hence the two-digit case.
 */
export function decodeHexChar(raw: string | undefined): { char: string; raw: string } | undefined {
  const hex = (raw ?? '').trim();
  if (!hex || /^0+$/.test(hex) || !/^(?:[0-9A-Fa-f]{2}){1,2}$/.test(hex)) return undefined;
  const code = parseInt(hex, 16);
  return { char: NAMED_CHARS[code] ?? String.fromCharCode(code), raw: hex.toUpperCase() };
}

// ── Settings (RSLDPSEL header row) ──────────────────────────────────────────

/**
 * Columns of the settings part of RSLDPSEL, in display order.
 *
 * `core` columns exist on every classic release this server supports; the rest arrived in
 * later support packages. A release that lacks one rejects the whole statement ("Unknown
 * column name"), which is why the statement is retried with the core set alone.
 */
const SETTING_COLUMNS: { col: string; core?: boolean }[] = [
  { col: 'KIND', core: true },
  { col: 'QUELLE', core: true },
  { col: 'ZIEL', core: true },
  { col: 'SELUPDIC', core: true },
  { col: 'FREMDSYS', core: true },
  { col: 'LOCATION', core: true },
  { col: 'FILENAME', core: true },
  { col: 'FILETYP', core: true },
  { col: 'FILESEP', core: true },
  { col: 'ESC', core: true },
  { col: 'CHAR1000', core: true },
  { col: 'DEZICHAR', core: true },
  { col: 'CURRCONV', core: true },
  { col: 'IGNORELINES' },
  { col: 'CONVEXIT_OFF' },
  { col: 'NUMBER_AT_ERR' },
  { col: 'CONTINUE_AT_ERR' },
  { col: 'REPORT_AT_ERR' },
  { col: 'WARNING' },
  { col: 'UNICODE_CODEPAGE' },
  { col: 'UNICODE_ENDIAN' },
  { col: 'UNICODE_REPLACE' },
  { col: 'METADATA_SYNC' },
  { col: 'CHAVL_CHECK' },
  { col: 'UPDATE_CUBE' },
  { col: 'NOAGGR' },
  { col: 'DUPREC' },
  { col: 'INIT_SIMU' },
  { col: 'INITTODELTA' },
  { col: 'EARLY_DELTA' },
  { col: 'REPAIR_FULL' },
  { col: 'TIMEOUT' },
  { col: 'FUNCTION_NAME', core: true },
  { col: 'HIENM', core: true },
  { col: 'DTP' },
  { col: 'SEL_1000' },
  { col: 'INFOPAKID', core: true },
];

const SELECTION_COLUMNS = [
  'LNR', 'FIELDNAME', 'IOBJNM', 'SIGN', 'OPT', 'LOW', 'HIGH',
  'VARTYP', 'NEXT_PER', 'ANZ_PER', 'VON_BIS', 'KENNZ_PER', 'BEX_VARIABLE', 'PERIV', 'DESCRIPTION',
];

/** Blank, or a number that is all zeros — which a NUMC or INT4 column holds when unset. */
function isInitial(value: string | undefined): boolean {
  const v = (value ?? '').trim();
  return v === '' || /^0+$/.test(v);
}

const flag = (text: string) => (v: string) => (v === 'X' ? text : `${text} (${v})`);

/**
 * What each non-initial setting means. A column without an entry here is still printed,
 * with its raw value, under "not interpreted" — a setting this reader does not know about
 * is exactly the one a caller would otherwise never learn exists.
 */
const SETTING_LABELS: Record<string, { label: string; render?: (v: string, row: Row) => string }> = {
  KIND: { label: 'Data type', render: (v) => `${DATA_TYPES[v] ?? 'unknown'} (${v})` },
  QUELLE: { label: 'Extract from', render: (v) => `${SOURCES[v] ?? 'unknown'} (${v})` },
  ZIEL: { label: 'Processing', render: (v) => `${PROCESSING[v] ?? 'unknown'} (${v})` },
  SELUPDIC: { label: 'Data target' },
  FREMDSYS: { label: 'External system', render: flag('yes — file or third-party source') },
  LOCATION: { label: 'File location', render: (v) => `${LOCATIONS[v] ?? 'unknown'} (${v})` },
  FILENAME: { label: 'File name' },
  FILETYP: { label: 'File type', render: (v) => `${FILE_TYPES[v] ?? 'unknown'} (${v})` },
  FILESEP: { label: 'Separator', render: renderHexChar },
  ESC: { label: 'Escape sign', render: renderHexChar },
  CHAR1000: { label: 'Thousands sep.', render: (v) => `"${v}"` },
  DEZICHAR: { label: 'Decimal point', render: (v) => `"${v}"` },
  CURRCONV: { label: 'Currency conv.', render: flag('yes') },
  IGNORELINES: { label: 'Header rows', render: (v) => `${Number(v)} skipped` },
  CONVEXIT_OFF: { label: 'Data format', render: flag('internal format — no conversion exits') },
  NUMBER_AT_ERR: { label: 'Error limit', render: (v) => `cancel after ${Number(v)} erroneous records` },
  WARNING: { label: 'Warnings', render: (v) => `${WARNING_HANDLING[v] ?? 'unknown'} (${v})` },
  UNICODE_CODEPAGE: { label: 'Code page', render: (v) => String(Number(v)) },
  UNICODE_ENDIAN: { label: 'Byte order', render: (v) => `${ENDIANNESS[v] ?? 'unknown'} (${v})` },
  UNICODE_REPLACE: { label: 'Replacement', render: (v) => `"${v}" for characters that cannot be converted` },
  METADATA_SYNC: { label: 'Metadata sync', render: flag('on') },
  FUNCTION_NAME: { label: 'Function module' },
  HIENM: { label: 'Hierarchy' },
  DTP: { label: 'DTP' },
  INFOPAKID: { label: 'Last run id', render: (v) => `${v} (the most recent request generated from it)` },
};

function renderHexChar(v: string): string {
  const decoded = decodeHexChar(v);
  return decoded ? `"${decoded.char}"  (raw ${decoded.raw})` : `raw ${v}`;
}

/**
 * The settings of an InfoPackage, from its RSLDPSEL rows.
 *
 * RSLDPSEL has no row of its own for the settings: every row repeats them, whether it carries
 * a selection or not, and a row without a field name exists only where there is no selection
 * to carry them (verified — an InfoPackage with selections has no such row). A 3.x InfoPackage
 * that updates several targets also repeats them once per target. The first row therefore
 * speaks for all of them, and only the targets are collected across the rows.
 */
export function renderSettings(headerRows: Row[], indent = '  '): string[] {
  const out: string[] = [];
  const first = headerRows[0];
  if (!first) return out;

  const hasFile = !isInitial(first.FILENAME) || first.FREMDSYS === 'X';
  const targets = [...new Set(headerRows.map((r) => (r.SELUPDIC ?? '').trim()).filter(Boolean))];
  const uninterpreted: string[] = [];

  for (const { col } of SETTING_COLUMNS) {
    if (!(col in first)) continue;
    const value = (first[col] ?? '').trim();

    if (col === 'SELUPDIC') {
      if (targets.length > 0) out.push(`${indent}${'Data targets:'.padEnd(17)} ${targets.join(', ')}`);
      continue;
    }
    // A zero is a real value for these two, but LOCATION only means something for a file.
    if (col === 'LOCATION') {
      if (!hasFile || value === '') continue;
    } else if (col === 'ZIEL') {
      if (value === '') continue;
    } else if (isInitial(value)) {
      continue;
    }

    const label = SETTING_LABELS[col];
    if (!label) {
      uninterpreted.push(`${col}=${value}`);
      continue;
    }
    const shown = label.render ? label.render(value, first) : value;
    out.push(`${indent}${`${label.label}:`.padEnd(17)} ${shown}`);
  }

  if (uninterpreted.length > 0) {
    out.push(`${indent}${'Not interpreted:'.padEnd(17)} ${uninterpreted.join(', ')}  (raw RSLDPSEL values)`);
  }
  return out;
}

// ── Selections and routines ─────────────────────────────────────────────────

export interface RoutineSource {
  /** The selection field, or empty for the declaration part shared by all routines. */
  field: string;
  lines: string[];
}

/** RSLDPRULE rows grouped per field, lines in their numeric order. */
export function groupRoutines(rows: Row[]): RoutineSource[] {
  const byField = new Map<string, { lnr: number; line: string }[]>();
  for (const r of rows) {
    const field = (r.FIELDNAME ?? '').trim();
    if (!byField.has(field)) byField.set(field, []);
    byField.get(field)!.push({ lnr: Number((r.LNR ?? '').trim()) || 0, line: r.LINE ?? '' });
  }
  return [...byField.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([field, lines]) => ({
      field,
      lines: lines.sort((x, y) => x.lnr - y.lnr).map((l) => l.line.replace(/\s+$/, '')),
    }));
}

/** One selection line: a fixed range, or the rule that fills the field at run time. */
export function renderSelection(r: Row): string {
  const field = (r.FIELDNAME ?? '').trim();
  const iobj = (r.IOBJNM ?? '').trim();
  const name = `${field}${iobj && iobj !== field ? ` (${iobj})` : ''}`.padEnd(30);
  const vartyp = (r.VARTYP ?? '').trim();

  if (vartyp) {
    const kind = SELECTION_TYPES[vartyp] ?? `selection type ${vartyp}`;
    const details: string[] = [];
    if (vartyp === '7' && r.BEX_VARIABLE?.trim()) details.push(`variable ${r.BEX_VARIABLE.trim()}`);
    if (vartyp === '5') {
      if (r.NEXT_PER?.trim()) details.push(`next period from ${r.NEXT_PER.trim()}`);
      if (!isInitial(r.ANZ_PER)) details.push(`${Number(r.ANZ_PER)} period(s)`);
      if (r.PERIV?.trim()) details.push(`fiscal variant ${r.PERIV.trim()}`);
    }
    // A dynamic selection still stores the values it was last filled with.
    const current = r.LOW?.trim() ? `   (stored value: ${rangeOf(r)})` : '';
    return `${name} ${kind}${details.length ? ` — ${details.join(', ')}` : ''}${current}`;
  }
  return `${name} ${rangeOf(r)}`;
}

function rangeOf(r: Row): string {
  const sign = (r.SIGN ?? '').trim() || 'I';
  const opt = (r.OPT ?? '').trim() || 'EQ';
  const low = (r.LOW ?? '').trim();
  const high = (r.HIGH ?? '').trim();
  return `${sign} ${opt} "${low}"${high ? ` .. "${high}"` : ''}`;
}

// ── Queries ─────────────────────────────────────────────────────────────────

const VERSION_ORDER = ['A', 'D', 'M'] as const;
const VERSION_LABEL: Record<string, string> = {
  A: 'active',
  D: 'delivered content (not activated on this system)',
  M: 'modified (not activated)',
};

function notOnThisPlatform(detail: string): string {
  return (
    `${detail} Note that InfoPackages exist on classic SAP BW only — BW/4HANA does not have the ` +
    `object type, and loads there run through DTPs.`
  );
}

/**
 * A column list, one column per line.
 *
 * The DataPreview service cuts a statement into lines of roughly 255 characters, the width of
 * an ABAP source line, and a cut through a column name comes back as a syntax error about a
 * character that is not in the statement at all (verified: the same wide RSLDPSEL select
 * fails on one line and succeeds wrapped).
 */
function columnList(cols: string[]): string {
  return cols.map((c) => c.toLowerCase()).join(',\n  ');
}

/** The settings rows, with a fallback for a release that lacks the newer columns. */
async function readSettingRows(client: BwClient, scope: string): Promise<{ rows: Row[]; reduced: boolean }> {
  const statement = (cols: string[]) =>
    `SELECT ${columnList(['LNR', ...cols])}\nFROM rsldpsel WHERE ${scope}`;
  const byLine = (rows: Row[]) => rows.sort((a, b) => Number(a.LNR) - Number(b.LNR));
  try {
    return { rows: byLine(await queryTable(client, statement(SETTING_COLUMNS.map((c) => c.col)), 500)), reduced: false };
  } catch (err) {
    // The message naming the unknown column comes in the logon language, so the status is
    // what decides; a statement that is wrong for another reason fails again on the core set.
    if (!/HTTP 400/.test(err instanceof Error ? err.message : String(err))) throw err;
    const core = SETTING_COLUMNS.filter((c) => c.core).map((c) => c.col);
    return { rows: byLine(await queryTable(client, statement(core), 500)), reduced: true };
  }
}

/** Every InfoPackage of a DataSource, for a name that is not an InfoPackage id. */
async function listByDataSource(client: BwClient, dataSource: string): Promise<string | undefined> {
  const name = sqlLiteral(dataSource);
  const rows = await queryTable(
    client,
    `SELECT logdpid, objvers, logsys, oltptyp FROM rsldpio WHERE oltpsource = '${name}' ORDER BY logsys, logdpid`,
    200,
  );
  if (rows.length === 0) return undefined;

  const texts = new Map<string, string>();
  for (const batch of inListBatches([...new Set(rows.map((r) => r.LOGDPID))], 120)) {
    try {
      const t = await queryTable(
        client,
        `SELECT logdpid, langu, text FROM rsldpiot WHERE logdpid IN (${batch})`,
        400,
      );
      for (const r of t.filter((r) => r.LANGU === 'E')) texts.set(r.LOGDPID, r.TEXT);
      for (const r of t) if (!texts.has(r.LOGDPID) && r.TEXT) texts.set(r.LOGDPID, r.TEXT);
    } catch {
      // A description is an enrichment; the id alone identifies the InfoPackage.
    }
  }

  const versions = new Map<string, Row[]>();
  for (const r of rows) versions.set(r.LOGDPID, [...(versions.get(r.LOGDPID) ?? []), r]);

  const out: string[] = [];
  out.push(`"${dataSource}" is not an InfoPackage id, but a DataSource with ${versions.size} InfoPackage(s):`);
  out.push('');
  for (const [id, vs] of versions) {
    const head = VERSION_ORDER.map((v) => vs.find((r) => r.OBJVERS === v)).find(Boolean) ?? vs[0];
    const kinds = vs.map((v) => v.OBJVERS).join('/');
    const text = texts.get(id);
    out.push(`  ${id}  ${head.LOGSYS.padEnd(12)} [${kinds}]${text ? `  ${text.trim()}` : ''}`);
  }
  out.push('');
  out.push('Read one of them with object_type="ISIP" and its id. [A] is active, [D] delivered content.');
  return out.join('\n');
}

async function loadHistory(client: BwClient, id: string, limit = 10): Promise<string[]> {
  const name = sqlLiteral(id);
  let requests: Row[];
  let total: Row[];
  try {
    requests = await queryTable(
      client,
      `SELECT rnr, datum, uzeit, tstatus, qmstatus, tdatum, tuzeit, records, chain_log_id, stornoflag\n` +
        `FROM rsreqdone WHERE logdpid = '${name}' ORDER BY datum DESCENDING, uzeit DESCENDING`,
      limit,
    );
    total = await queryTable(client, `SELECT count(*) AS cnt FROM rsreqdone WHERE logdpid = '${name}'`, 1);
  } catch {
    return [];
  }

  const out: string[] = [''];
  if (requests.length === 0) {
    out.push('── Load History ──');
    out.push('  no requests (never run, or the history has been deleted)');
    return out;
  }

  const count = Number(total[0]?.CNT ?? requests.length);
  const shown =
    count > requests.length
      ? `${requests.length} most recent of ${count} requests`
      : `${count} request${count === 1 ? '' : 's'}`;
  out.push(`── Load History (${shown}, newest first) ──`);

  // RSSELDONE has one row per selection line of the request; mode and user are the same on each.
  const details = new Map<string, Row>();
  for (const batch of inListBatches(requests.map((r) => r.RNR), 120)) {
    try {
      const rows = await queryTable(
        client,
        `SELECT rnr, updmode, uname FROM rsseldone WHERE rnr IN (${batch})`,
        500,
      );
      for (const r of rows) if (!details.has(r.RNR)) details.set(r.RNR, r);
    } catch {
      // Mode and user are enrichments; the status row carries the essentials.
    }
  }

  for (const r of requests) {
    const tech = REQUEST_STATUS[r.TSTATUS] ?? `unknown (${r.TSTATUS || 'none'})`;
    const d = details.get(r.RNR);
    const mode = d?.UPDMODE ? `${UPDATE_MODES[d.UPDMODE] ?? 'unknown'} (${d.UPDMODE})` : '';
    out.push('');
    out.push(`  ${r.RNR}${r.STORNOFLAG === 'X' ? '   [CANCELLED]' : ''}`);
    out.push(`      Status:   ${tech}  [${r.TSTATUS}]`);
    if (r.QMSTATUS?.trim() && r.QMSTATUS !== r.TSTATUS) {
      out.push(`      Overall:  ${REQUEST_STATUS[r.QMSTATUS] ?? 'unknown'}  [${r.QMSTATUS}]`);
    }
    if (mode) out.push(`      Mode:     ${mode}`);
    const finished = formatStamp(r.TDATUM, r.TUZEIT);
    out.push(
      `      Started:  ${formatStamp(r.DATUM, r.UZEIT)}${d?.UNAME ? `  by ${d.UNAME}` : ''}` +
        `${finished ? `   (last status change ${finished})` : ''}`,
    );
    out.push(`      Records:  ${(r.RECORDS ?? '').trim() || '?'}`);
    if (r.CHAIN_LOG_ID?.trim()) out.push(`      Chain run: ${r.CHAIN_LOG_ID.trim()}`);
  }
  return out;
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function readInfoPackage(client: BwClient, objectName: string): Promise<string> {
  const id = objectName.trim().toUpperCase();
  const name = sqlLiteral(id);

  let versions: Row[];
  try {
    versions = await queryTable(
      client,
      `SELECT logdpid, objvers, logsys, oltpsource, oltptyp, uname, timestamp, masteripak,\n` +
        `ismasteripak, lpi, lpi_chain\nFROM rsldpio WHERE logdpid = '${name}'`,
      10,
    );
  } catch (err) {
    return notOnThisPlatform(
      `The InfoPackage table RSLDPIO could not be read on this system (${err instanceof Error ? err.message : String(err)}).`,
    );
  }

  if (versions.length === 0) {
    const listing = await listByDataSource(client, id).catch(() => undefined);
    if (listing) return listing;
    // Delivered chains name InfoPackages whose own content was never installed, so a chain
    // step can point at an id this table does not know.
    const referencing = await queryTable(
      client,
      `SELECT chain_id, objvers FROM rspcchain WHERE type = 'LOADING' AND variante = '${name}'`,
      20,
    ).catch(() => [] as Row[]);
    if (referencing.length > 0) {
      const chains = [...new Set(referencing.map((r) => `${r.CHAIN_ID} (version ${r.OBJVERS})`))];
      return (
        `InfoPackage ${objectName} is not on this system (no entry in RSLDPIO), but process chain ` +
        `${chains.join(', ')} names it as a load step — typically a delivered chain whose ` +
        `InfoPackage content was never installed.`
      );
    }
    return notOnThisPlatform(
      `InfoPackage ${objectName} not found (no entry in RSLDPIO, and no DataSource of that name ` +
        `has an InfoPackage).`,
    );
  }

  const head = VERSION_ORDER.map((v) => versions.find((r) => r.OBJVERS === v)).find(Boolean) ?? versions[0];
  const version = head.OBJVERS;
  const scope = `logdpid = '${name}' AND objvers = '${version}'`;

  // Sequential on purpose: each statement may rotate the CSRF token the next one spends.
  const texts = await queryTable(client, `SELECT langu, text FROM rsldpiot WHERE ${scope}`, 20);
  const settings = await readSettingRows(client, scope);
  const selections = await queryTable(
    client,
    `SELECT ${columnList(SELECTION_COLUMNS)}\nFROM rsldpsel WHERE ${scope} AND fieldname <> ''`,
    500,
  );
  const rules = await queryTable(client, `SELECT fieldname, lnr, line FROM rsldprule WHERE ${scope}`, 2000);
  const access = await queryTable(client, `SELECT accessmethod, currently_used FROM rsldpaccess WHERE ${scope}`, 50)
    .catch(() => [] as Row[]);
  const deletion = await queryTable(
    client,
    `SELECT delicube, lnr, always, sele, del_routine, del_is, del_oltpsource, del_qs, del_date, del_last,\n` +
      `total, partdel, description\nFROM rsldpdel WHERE ${scope}`,
    100,
  ).catch(() => [] as Row[]);
  const chains = await queryTable(
    client,
    `SELECT chain_id, objvers FROM rspcchain WHERE type = 'LOADING' AND variante = '${name}'`,
    50,
  ).catch(() => [] as Row[]);

  const description =
    texts.find((t) => t.LANGU === 'E' && t.TEXT)?.TEXT ?? texts.find((t) => t.TEXT)?.TEXT ?? '';
  const header = settings.rows[0];

  const out: string[] = [];
  out.push(`InfoPackage: ${head.LOGDPID}`);
  out.push('Source: metadata tables (read-only — no release publishes a REST resource for the');
  out.push('        InfoPackage, and BW/4HANA does not have the object type at all)');
  if (description) out.push(`Description:   ${description.trim()}`);
  out.push(`DataSource:    ${head.OLTPSOURCE || '(none)'}`);
  out.push(`Source system: ${head.LOGSYS || '(none)'}`);
  if (head.OLTPTYP) out.push(`Data type:     ${DATA_TYPES[head.OLTPTYP] ?? 'unknown'} (${head.OLTPTYP})`);
  out.push(`Version:       ${version} — ${VERSION_LABEL[version] ?? 'unknown version'}`);
  if (versions.length > 1) {
    out.push(`               (also present as ${versions.filter((v) => v.OBJVERS !== version).map((v) => v.OBJVERS).join(', ')})`);
  }
  out.push(`Last changed:  ${formatStamp(head.TIMESTAMP) || '(unknown)'} by ${head.UNAME || '(unknown)'}`);
  if (head.ISMASTERIPAK === 'X') out.push('Role:          master InfoPackage (other InfoPackages run under it)');
  if (head.MASTERIPAK?.trim()) out.push(`Master:        ${head.MASTERIPAK.trim()}`);
  out.push('Update mode:   not readable here — the definition holds it outside the relational tables;');
  out.push('               the mode each run used is in the load history below');

  out.push('');
  out.push('── Settings ──');
  const settingLines = renderSettings(settings.rows);
  if (settingLines.length === 0) out.push('  (none set)');
  out.push(...settingLines);
  if (settings.reduced) {
    out.push('  (this release lacks some of the newer RSLDPSEL columns, so only the basic settings are shown)');
  }

  const routines = groupRoutines(rules);
  const routineFields = new Set(routines.map((r) => r.field));

  out.push('');
  out.push(`── Selections (${selections.length}) ──`);
  if (selections.length === 0) out.push('  none — the InfoPackage requests everything the DataSource delivers');
  const sorted = [...selections].sort((a, b) => Number(a.LNR) - Number(b.LNR));
  for (const s of sorted) out.push(`  ${renderSelection(s)}`);

  if (routines.length > 0) {
    out.push('');
    out.push(`── Routines (${routines.filter((r) => r.field).length}, from RSLDPRULE) ──`);
    for (const r of routines) {
      const scopeLabel = r.field ? `selection routine for ${r.field}` : 'global declarations';
      out.push(`  ${scopeLabel} (${r.lines.length} lines):`);
      for (const line of r.lines) out.push(`    | ${line}`);
    }
    const orphans = sorted.filter((s) => s.VARTYP === '6' && !routineFields.has((s.FIELDNAME ?? '').trim()));
    if (orphans.length > 0) {
      out.push(`  NOTE: ${orphans.map((s) => s.FIELDNAME.trim()).join(', ')} is marked as routine but has no code in RSLDPRULE.`);
    }
  }

  if (deletion.length > 0) {
    out.push('');
    out.push('── Delete previous requests in the data target ──');
    const flags = ['ALWAYS', 'SELE', 'DEL_ROUTINE', 'DEL_IS', 'DEL_OLTPSOURCE', 'DEL_QS', 'DEL_DATE', 'DEL_LAST', 'TOTAL', 'PARTDEL'];
    for (const d of deletion) {
      const set = flags.filter((f) => !isInitial(d[f])).map((f) => `${f}=${d[f].trim()}`);
      out.push(`  ${d.DELICUBE.trim()}${d.DESCRIPTION?.trim() ? ` — ${d.DESCRIPTION.trim()}` : ''}`);
      out.push(`      ${set.length ? set.join(', ') : '(no condition set)'}  (raw RSLDPDEL flags)`);
    }
  }

  if (access.length > 0) {
    out.push('');
    out.push('── Access methods (RSLDPACCESS) ──');
    const used = access.filter((a) => a.CURRENTLY_USED === 'X').map((a) => a.ACCESSMETHOD);
    const other = access.filter((a) => a.CURRENTLY_USED !== 'X').map((a) => a.ACCESSMETHOD);
    out.push(`  in use:    ${used.length ? used.join(', ') : '(none marked)'}`);
    if (other.length) out.push(`  available: ${other.join(', ')}`);
    out.push('  The adapter parameters (RSLDPACCESS-XML) are NOT readable this way: the DataPreview');
    out.push('  service returns only the first 255 characters of that string column. The settings that');
    out.push('  matter are repeated in RSLDPSEL and shown above.');
  }

  out.push('');
  out.push('── Scheduling ──');
  const inChains = [...new Map(chains.map((c) => [c.CHAIN_ID, c])).values()];
  if (inChains.length > 0) {
    for (const c of inChains) {
      out.push(`  step of process chain ${c.CHAIN_ID}${c.OBJVERS !== 'A' ? ` (version ${c.OBJVERS})` : ''}`);
    }
  } else {
    out.push('  not used in any process chain');
  }
  if (head.LPI?.trim()) {
    out.push(`  last started by chain variant ${head.LPI.trim()}${head.LPI_CHAIN?.trim() ? ` in ${head.LPI_CHAIN.trim()}` : ''}`);
  }
  if (header && header.LOCATION === '1' && (!isInitial(header.FILENAME) || header.FREMDSYS === 'X')) {
    out.push('  NOTE: the file is read from the local workstation, so this InfoPackage can only run in');
    out.push('  the dialog — not in the background and not as a process chain step. For scheduled loads');
    out.push('  the file has to be on the application server (file location 0).');
  }

  out.push(...(await loadHistory(client, id)));

  return out.join('\n');
}
