import { BwClient, MEDIA_TYPES, bwSeg } from '../bw-client.js';

/**
 * Read BW object definitions straight from their metadata tables, through the ADT
 * DataPreview service.
 *
 * This is the fallback for object types that the connected system does not publish as a
 * REST resource — on classic BW (7.5) that is transformations, DTPs, classic DSOs,
 * InfoCubes and MultiProviders. Read-only by nature: creating or changing these objects
 * needs the BW framework, not table access.
 *
 * Every statement in this module is fixed in code. Nothing is assembled from caller input
 * beyond the object name, which is escaped before use.
 */

// ── DataPreview access ──────────────────────────────────────────────────────

export type Row = Record<string, string>;

/** Single quotes are the only character that could break out of the literal. */
function sqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/**
 * The response is column-oriented: one <columns> block per column, each carrying the
 * column name and a <dataSet> holding one <data> element per row. Rows are rebuilt by
 * index; an empty cell arrives as a self-closing element.
 */
export function parseDataPreview(xml: string): Row[] {
  const columns: { name: string; values: string[] }[] = [];
  const blockRe = /<dataPreview:columns>([\s\S]*?)<\/dataPreview:columns>/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(xml)) !== null) {
    const name = block[1].match(/dataPreview:name="([^"]+)"/)?.[1];
    if (!name) continue;
    const values: string[] = [];
    const cellRe = /<dataPreview:data\s*\/>|<dataPreview:data>([\s\S]*?)<\/dataPreview:data>/g;
    let cell: RegExpExecArray | null;
    while ((cell = cellRe.exec(block[1])) !== null) {
      values.push(cell[1] === undefined ? '' : decodeEntities(cell[1]));
    }
    columns.push({ name, values });
  }
  const rowCount = columns.length ? Math.max(...columns.map((c) => c.values.length)) : 0;
  const rows: Row[] = [];
  for (let i = 0; i < rowCount; i++) {
    const row: Row = {};
    // Trailing only: SAP pads CHAR columns, but leading blanks carry meaning — they are
    // the indentation of ABAP source lines read from RSAABAP.
    for (const col of columns) row[col.name] = (col.values[i] ?? '').replace(/\s+$/, '');
    rows.push(row);
  }
  return rows;
}

/** Run one ABAP SQL statement through ADT DataPreview. */
export async function queryTable(client: BwClient, sql: string, maxRows = 500): Promise<Row[]> {
  const token = await client.getCsrfToken();
  const { body } = await client.rawPost(
    `/sap/bc/adt/datapreview/freestyle?rowNumber=${maxRows}`,
    sql,
    {
      'Content-Type': 'text/plain',
      Accept: 'application/xml, application/vnd.sap.adt.datapreview.table.v1+xml',
      'X-CSRF-Token': token,
    },
  );
  return parseDataPreview(body);
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Tables store `/NAMESPACE/FIELD`; the REST API and the frontend render `$NAMESPACE$FIELD`. */
function toDisplayName(field: string): string {
  const m = field.match(/^\/([^/]+)\/(.+)$/);
  return m ? `$${m[1]}$${m[2]}` : field;
}

// ── Load history (RSSTATMANPART / RSBKREQUEST) ──────────────────────────────

/**
 * RSSTATMANPART-STATUS, from domain RSSTATUS. The values are SAP icon codes, which say
 * nothing on their own — the raw code is kept alongside the text so a status this map
 * does not know is still visible rather than swallowed.
 */
const REQUEST_STATUS: Record<string, string> = {
  '@08@': 'green  (ended successfully)',
  '@09@': 'yellow (incomplete)',
  '@0A@': 'red    (incorrect processing)',
};

/**
 * RSSTATMANPART-UPDMODE, from domain RSUPDMODE. Deliberately separate from the DTP's own
 * UPDATE_MODES: RSBKDTP-UPDMODE is domain RSBKUPDMODE and has a different value set.
 */
const REQUEST_UPDATE_MODES: Record<string, string> = {
  C: 'Delta init',
  D: 'Delta',
  F: 'Full',
  I: 'Opening balance',
  R: 'Repeat',
};

/** `20190111125226` and `20190111125226.6875150` alike become `2019-01-11 12:52:26`. */
export function formatStamp(date: string | undefined, time?: string): string {
  const d = (date ?? '').trim();
  if (!d || /^0+$/.test(d)) return '';
  const digits = d.replace(/\..*$/, '');
  const day = digits.slice(0, 8);
  const clock = (time ?? digits.slice(8, 14)).padEnd(6, '0');
  if (day.length < 8) return d;
  return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)} ` +
    `${clock.slice(0, 2)}:${clock.slice(2, 4)}:${clock.slice(4, 6)}`;
}

/** Seconds between two RSBKREQUEST timestamps, which carry fractions after the dot. */
export function durationSeconds(start: string | undefined, finish: string | undefined): string {
  const toSec = (v: string | undefined): number | undefined => {
    const m = (v ?? '').trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$/);
    if (!m) return undefined;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return ms / 1000 + (m[7] ? Number(`0.${m[7]}`) : 0);
  };
  const a = toSec(start);
  const b = toSec(finish);
  if (a === undefined || b === undefined || b < a) return '';
  const secs = b - a;
  return secs < 60 ? `${secs.toFixed(1)} s` : `${Math.floor(secs / 60)}m ${(secs % 60).toFixed(0)}s`;
}

/**
 * The load history of one data target, as the request management ("Manage") view shows it.
 *
 * RSSTATMANPART is the per-target request status and covers every load path — DTP as well
 * as InfoPackage — for InfoCubes, DataStore objects and InfoObject master data and texts
 * alike. RSBKREQUEST adds what only a DTP run knows (who started it, and how long it took)
 * and is joined on RSBKREQUEST-REQUEST = RSSTATMANPART-RNR; a request loaded by an
 * InfoPackage simply has no counterpart there and is reported without that detail.
 *
 * Best effort: a target whose history cannot be read yields no section rather than failing
 * the whole object read.
 */
async function loadHistorySection(client: BwClient, dataTarget: string, limit = 10): Promise<string[]> {
  const name = sqlLiteral(dataTarget.trim().toUpperCase());
  let requests: Row[];
  let total: Row[];
  try {
    [requests, total] = await Promise.all([
      queryTable(
        client,
        `SELECT rnr, status, updmode, datum_anf, zeit_anf, anz_recs, insert_recs, ` +
          `source_dta, source_dta_type, stornoflag, archivflag FROM rsstatmanpart ` +
          `WHERE dta = '${name}' ORDER BY datum_anf DESCENDING, zeit_anf DESCENDING`,
        limit,
      ),
      queryTable(client, `SELECT count(*) AS cnt FROM rsstatmanpart WHERE dta = '${name}'`, 1),
    ]);
  } catch {
    return [];
  }

  const out: string[] = [''];
  if (requests.length === 0) {
    out.push('── Load History ──');
    out.push('  no requests (never loaded, or the history has been deleted)');
    return out;
  }

  const count = Number(total[0]?.CNT ?? requests.length);
  const shown =
    count > requests.length
      ? `${requests.length} most recent of ${count} requests`
      : `${count} request${count === 1 ? '' : 's'}`;
  out.push(`── Load History (${shown}, newest first) ──`);

  // Only DTP requests appear here; an InfoPackage load has no RSBKREQUEST row.
  let runs = new Map<string, Row>();
  try {
    const rows = await queryTable(
      client,
      `SELECT request, uname, tstmp_start, tstmp_finish, linesread, linestransferred ` +
        `FROM rsbkrequest WHERE tgt = '${name}' ORDER BY requid DESCENDING`,
      Math.max(limit * 2, 20),
    );
    runs = new Map(rows.filter((r) => r.REQUEST).map((r) => [r.REQUEST, r]));
  } catch {
    // Enrichment is optional — the status rows above already carry the essentials.
  }

  for (const r of requests) {
    const status = REQUEST_STATUS[r.STATUS] ?? `unknown (${r.STATUS})`;
    const mode = REQUEST_UPDATE_MODES[r.UPDMODE] ?? r.UPDMODE ?? '';
    const flags = [
      r.STORNOFLAG === 'X' ? 'CANCELLED' : '',
      r.ARCHIVFLAG === 'X' ? 'archived' : '',
    ].filter(Boolean);
    out.push('');
    out.push(`  ${r.RNR}${flags.length ? `   [${flags.join(', ')}]` : ''}`);
    out.push(`      Status:   ${status}  [${r.STATUS}]`);
    out.push(`      Mode:     ${mode}${r.UPDMODE ? ` (${r.UPDMODE})` : ''}`);
    const run = runs.get(r.RNR);
    const started = formatStamp(r.DATUM_ANF, r.ZEIT_ANF);
    const by = run?.UNAME ? `  by ${run.UNAME}` : '';
    const took = run ? durationSeconds(run.TSTMP_START, run.TSTMP_FINISH) : '';
    out.push(`      Started:  ${started}${by}${took ? `  (${took})` : ''}`);
    out.push(`      Records:  ${r.ANZ_RECS ?? '?'} transferred / ${r.INSERT_RECS ?? '?'} added`);
    if (r.SOURCE_DTA) {
      // A DataSource source is stored as name plus logical system, padded apart; and the
      // status table spells that type DTASRC where every other table says RSDS.
      const src = r.SOURCE_DTA.replace(/\s+/g, ' ').trim();
      const srcType = r.SOURCE_DTA_TYPE === 'DTASRC' ? 'RSDS' : r.SOURCE_DTA_TYPE || '';
      out.push(`      Source:   ${srcType} ${src}`.trimEnd());
    }
  }
  return out;
}

// ── Transformation (TRFN) ───────────────────────────────────────────────────

/**
 * All fields of the transformation target.
 *
 * Needed because target fields that receive nothing have no rule at all in the tables —
 * the REST API synthesises a "no update" entry for them from the target structure, and
 * without this the field list would silently omit them. Best effort: a target whose
 * structure cannot be read simply yields no extra entries rather than failing the read.
 */
async function targetFieldNames(client: BwClient, type: string, name: string): Promise<string[]> {
  const t = type.trim().toUpperCase();
  try {
    if (t === 'ADSO') {
      const { body } = await client.get(
        `/sap/bw/modeling/adso/${bwSeg(name.trim())}/m`,
        MEDIA_TYPES['adso'],
      );
      return [...body.matchAll(/<element\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]);
    }
    if (t === 'ODSO') {
      const rows = await queryTable(
        client,
        `SELECT iobjnm FROM rsdodsoiobj WHERE odsobject = '${sqlLiteral(name.trim().toUpperCase())}' ` +
          `AND objvers = 'A'`,
        2000,
      );
      return rows.map((r) => r.IOBJNM).filter(Boolean);
    }
    if (t === 'CUBE') {
      const rows = await queryTable(
        client,
        `SELECT iobjnm FROM rsdcubeiobj WHERE infocube = '${sqlLiteral(name.trim().toUpperCase())}' ` +
          `AND objvers = 'A'`,
        2000,
      );
      return rows.map((r) => r.IOBJNM).filter(Boolean);
    }
  } catch {
    // Target structure is an enrichment, never a reason to fail the transformation read.
  }
  return [];
}

async function readTransformation(client: BwClient, tranId: string): Promise<string> {
  const id = sqlLiteral(tranId.toUpperCase());
  const scope = `tranid = '${id}' AND objvers = 'A'`;

  const [header] = await queryTable(client, `SELECT * FROM rstran WHERE ${scope}`, 1);
  if (!header) {
    return `Transformation ${tranId} not found (no active version in RSTRAN).`;
  }

  const [texts, rules, steps, fields, constants, routines] = await Promise.all([
    queryTable(client, `SELECT langu, txtlg FROM rstrant WHERE ${scope}`, 20),
    queryTable(client, `SELECT ruleid, seqnr, groupid, ruletype, aggr FROM rstranrule WHERE ${scope}`, 500),
    queryTable(client, `SELECT ruleid, stepid, steptype FROM rstranrulestep WHERE ${scope}`, 500),
    queryTable(
      client,
      `SELECT segid, ruleid, stepid, paramtype, fieldnm, fieldtype, keyflag, ruleposit ` +
        `FROM rstranfield WHERE ${scope}`,
      2000,
    ),
    queryTable(client, `SELECT ruleid, stepid, value FROM rstranstepcnst WHERE ${scope}`, 200),
    // No CODE column here: BW/4HANA carries the source inline, BW 7.5 does not. Both keep
    // it in RSAABAP under CODEID, so that is the one path that works on either release.
    queryTable(client, `SELECT ruleid, stepid, kind, codeid FROM rstransteprout WHERE ${scope}`, 100),
  ]);

  // RSTRAN carries the code IDs of the start/end/expert routines directly. Relying on those
  // rather than on RSTRANSTEPROUT.KIND matters: the KIND values differ between releases.
  const codeIds = [
    ...new Set(
      [header.STARTROUTINE, header.ENDROUTINE, header.EXPERT, ...routines.map((r) => r.CODEID)].filter(
        Boolean,
      ),
    ),
  ];
  const sources = await Promise.all(
    codeIds.map((codeId) =>
      queryTable(
        client,
        `SELECT line_no, line FROM rsaabap WHERE codeid = '${sqlLiteral(codeId)}' ` +
          `AND objvers = 'A' ORDER BY line_no ASCENDING`,
        5000,
      ).then((lines) => [codeId, lines.map((l) => l.LINE).join('\n')] as const),
    ),
  );
  const codeOf = new Map(sources);

  /**
   * Fields belonging to one rule, by side: PARAMTYPE 0 is inbound, 1 is outbound.
   * RSTRANSTEPMAP would give the same answer via segment/position pairs, but only for
   * rules whose ports it records — a start routine, for instance, lists its 14 inbound
   * fields here and nothing there.
   */
  const fieldsOf = (ruleId: string, paramType: string): string[] =>
    fields
      .filter((f) => f.RULEID === ruleId && f.PARAMTYPE === paramType && f.FIELDNM)
      .sort((a, b) => Number(a.RULEPOSIT) - Number(b.RULEPOSIT))
      .map((f) => toDisplayName(f.FIELDNM));

  const out: string[] = [];
  out.push(`Transformation: ${header.TRANID}`);
  out.push(`Source: metadata tables (read-only — this system publishes no REST resource for TRFN)`);
  out.push(`Status: ${header.OBJSTAT === 'ACT' ? 'active' : header.OBJSTAT || '?'}`);
  const text = texts.find((t) => t.TXTLG)?.TXTLG;
  if (text) out.push(`Description: ${text}`);
  out.push(`ABAP Program: ${header.TRANPROG || '(none)'}`);
  out.push(`Source: ${header.SOURCETYPE} ${header.SOURCENAME}`);
  out.push(`Target: ${header.TARGETTYPE} ${header.TARGETNAME}`);
  if (header.IS_SHADOW === 'X') out.push('NOTE: this is a shadow transformation.');

  // ── Routines ──
  out.push('');
  out.push('── Routines ──');
  const named: [string, string][] = [
    ['startRoutine', header.STARTROUTINE],
    ['endRoutine', header.ENDROUTINE],
    ['expertRoutine', header.EXPERT],
  ];
  for (const [label, codeId] of named) {
    if (!codeId) {
      out.push(`  ${label}: (none)`);
      continue;
    }
    out.push(`  ${label}: (code id ${codeId})`);
    out.push(indent(codeOf.get(codeId) ?? '(no source lines found in RSAABAP)'));
  }
  // Anything else with source attached: field routines, formulas, and whatever a given
  // release calls them — the header only covers start/end/expert.
  const headerIds = new Set([header.STARTROUTINE, header.ENDROUTINE, header.EXPERT].filter(Boolean));
  for (const r of routines) {
    if (headerIds.has(r.CODEID)) continue;
    const code = codeOf.get(r.CODEID);
    if (!code?.trim()) continue;
    out.push(`  ${r.KIND || 'routine'} (rule ${r.RULEID}, step ${r.STEPID}, code id ${r.CODEID}):`);
    out.push(indent(code));
  }

  // ── Field mappings ──
  out.push('');
  out.push('── Field Mappings ──');
  const stepTypeOf = new Map(steps.map((s) => [s.RULEID, s.STEPTYPE]));
  const constantOf = new Map(constants.map((c) => [c.RULEID, c.VALUE]));
  const sorted = [...rules].sort((a, b) => Number(a.SEQNR) - Number(b.SEQNR));
  const mappedTargets = new Set<string>();
  for (const rule of sorted) {
    const sources = fieldsOf(rule.RULEID, '0');
    const targets = fieldsOf(rule.RULEID, '1');
    targets.forEach((t) => mappedTargets.add(t));
    const type = rule.RULETYPE || stepTypeOf.get(rule.RULEID) || '?';
    const constant = constantOf.get(rule.RULEID);
    const label = constant !== undefined ? `${type} = "${constant}"` : type;
    out.push(
      `  [${label}]  ${sources.length ? sources.join(', ') : '(none)'}  →  ` +
        `${targets.length ? targets.join(', ') : '(none)'}`,
    );
  }

  const allTargets = await targetFieldNames(client, header.TARGETTYPE, header.TARGETNAME);
  const notUpdated = allTargets.map(toDisplayName).filter((f) => !mappedTargets.has(f));
  for (const field of notUpdated) {
    out.push(`  [NOUPDATE]  (none)  →  ${field}`);
  }

  // ── Field lists ──
  for (const [label, paramType] of [['Source Fields', '0'], ['Target Fields', '1']] as const) {
    const seen = new Map<string, Row>();
    for (const f of fields) {
      if (f.PARAMTYPE !== paramType || !f.FIELDNM) continue;
      if (!seen.has(f.FIELDNM)) seen.set(f.FIELDNM, f);
    }
    const all = [...seen.values()];
    const keys = all.filter((f) => f.KEYFLAG === 'X').map((f) => toDisplayName(f.FIELDNM));
    const values = all.filter((f) => f.KEYFLAG !== 'X').map((f) => toDisplayName(f.FIELDNM));
    const extra = paramType === '1' ? notUpdated : [];
    out.push('');
    out.push(`── ${label} (${all.length + extra.length}) ──`);
    if (keys.length) out.push(`  Key fields (${keys.length}): ${keys.join(', ')}`);
    if (values.length) out.push(`  Value fields (${values.length}): ${values.join(', ')}`);
    if (extra.length) out.push(`  Not updated (${extra.length}): ${extra.join(', ')}`);
  }

  return out.join('\n');
}

function indent(code: string): string {
  return code
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');
}

// ── DTP (DTPA) ──────────────────────────────────────────────────────────────

const UPDATE_MODES: Record<string, string> = {
  D: 'Delta',
  F: 'Full',
  I: 'Init',
  N: 'Init without data transfer',
};

const ERROR_HANDLING: Record<string, string> = {
  '0': 'no update, no reporting',
  '1': 'update valid records, no reporting',
  '2': 'update valid records, reporting possible',
  _: 'deactivated',
};

/**
 * The TLOGO type of one end of a DTP path, as RSTRAN spells it. RSBKDTP carries both its own
 * token (SRCTP/TGTTP) and the TLOGO (SRCTLOGO/TGTTLOGO); only the latter is comparable to
 * RSTRAN. Falling back to the former is a last resort, so it is capped at the width of
 * RSTRAN's CHAR(4) type columns — an over-long literal terminates the DataPreview service.
 */
function tlogoOf(tlogo: string | undefined, fallback: string | undefined): string {
  return (tlogo || '').trim() || (fallback || '').trim().slice(0, 4);
}

async function readDtp(client: BwClient, dtpName: string): Promise<string> {
  const name = sqlLiteral(dtpName.trim().toUpperCase());
  const scope = `dtp = '${name}' AND objvers = 'A'`;

  // Two narrow reads rather than one wide one: SELECT * does not return every column, and
  // a long column list runs into the statement length limit of the DataPreview service.
  const [[path], [settings]] = await Promise.all([
    queryTable(
      client,
      `SELECT dtp, src, srctp, srctlogo, tgt, tgttp, tgttlogo, activfl FROM rsbkdtp WHERE ${scope}`,
      1,
    ),
    queryTable(
      client,
      `SELECT updmode, processmode, errorhandling, noaggr, number_at_err, autoqualok, ` +
        `tstpnm, timestmp FROM rsbkdtp WHERE ${scope}`,
      1,
    ),
  ]);
  if (!path) return `DTP ${dtpName} not found (no active version in RSBKDTP).`;
  const header: Row = { ...path, ...(settings ?? {}) };

  const texts = await queryTable(client, `SELECT langu, txtlg FROM rsbkdtpt WHERE ${scope}`, 20);

  /**
   * The DTP stores its path (source and target), not the transformation — BW resolves that
   * at runtime from the objects on both ends. Deriving it the same way keeps the output
   * comparable to the REST tool, which shows it under "overview".
   *
   * The comparison runs on RSBKDTP's TLOGO columns, not on SRCTP/TGTTP. Those two are the
   * DTP's own CHAR(6) vocabulary (a DataSource is `DTASRC` there) while RSTRAN types are
   * TLOGO in CHAR(4) (`RSDS`). Comparing the former against the latter both misses every
   * DataSource-fed DTP and, because the literal is longer than the column, terminates the
   * DataPreview service with a truncation dump rather than returning no rows.
   */
  const transformations = await queryTable(
    client,
    `SELECT tranid, sourcetype, sourcename, targettype, targetname FROM rstran ` +
      `WHERE objvers = 'A' AND sourcetype = '${sqlLiteral(tlogoOf(header.SRCTLOGO, header.SRCTP))}' ` +
      `AND sourcename = '${sqlLiteral(header.SRC)}' ` +
      `AND targettype = '${sqlLiteral(tlogoOf(header.TGTTLOGO, header.TGTTP))}' ` +
      `AND targetname = '${sqlLiteral(header.TGT)}'`,
    10,
  );

  const out: string[] = [];
  out.push(`DTP: ${header.DTP}`);
  out.push('Source: metadata tables (read-only — this system publishes no REST resource for DTPA)');
  out.push(`Status: ${header.ACTIVFL === 'X' ? 'active' : 'inactive'}`);
  // RSBKDTPT is frequently empty — the REST API then derives the description from the
  // path, and so does this.
  const text = texts.find((t) => t.TXTLG)?.TXTLG || `${header.SRC} -> ${header.TGT}`;
  out.push(`Description: ${text}`);
  out.push('');
  out.push(`Source: ${header.SRCTLOGO || header.SRCTP} ${header.SRC}`);
  out.push(`Target: ${header.TGTTLOGO || header.TGTTP} ${header.TGT}`);
  if (transformations.length === 1) {
    out.push(`Transformation: ${transformations[0].TRANID}`);
  } else if (transformations.length > 1) {
    out.push(`Transformations (${transformations.length}): ${transformations.map((t) => t.TRANID).join(', ')}`);
  } else {
    out.push('Transformation: (none found for this source/target pair)');
  }

  out.push('');
  out.push('── Extraction Settings ──');
  out.push(`  Mode:            ${UPDATE_MODES[header.UPDMODE] ?? header.UPDMODE} (${header.UPDMODE})`);
  if (header.DELTAONLYONCE === 'X') out.push('  Delta:           only once');
  if (header.INITSIMU === 'X') out.push('  Init:            simulation (without data transfer)');
  out.push(`  Processing:      mode ${header.PROCESSMODE}`);
  out.push(
    `  Error handling:  ${ERROR_HANDLING[header.ERRORHANDLING] ?? header.ERRORHANDLING}` +
      `  (max ${header.NUMBER_AT_ERR} errors per package)`,
  );
  out.push(`  Aggregation:     ${header.NOAGGR === 'X' ? 'no aggregation' : 'aggregated'}`);
  out.push(`  Auto quality OK: ${header.AUTOQUALOK === 'X' ? 'yes' : 'no'}`);
  if (header.AUTORESTART === 'X') out.push('  Auto restart:    yes');

  out.push('');
  out.push(`Last changed: ${header.TIMESTMP} by ${header.TSTPNM}`);

  out.push('');
  out.push('NOTE: filter selections, filter routines and the semantic group are NOT readable this');
  out.push('way. They are stored as a serialised ABAP object in RSBKCMD-TPL_INSTANCE, not in');
  out.push('relational columns — every RSBK selection table (RSBKSELECT, RSBKDATAPAKSEL, RSSELDTP)');
  out.push('is request scope, i.e. runtime. Reading them needs ABAP deserialisation; use the SAP GUI');
  out.push('or the REST endpoint on a system that publishes one. Package size likewise comes from');
  out.push('the runtime default rather than the definition.');

  return out.join('\n');
}

// ── Classic DSO (ODSO) ──────────────────────────────────────────────────────

/** RSDODSO-ODSOTYPE. Blank is the classic standard DSO with active table and change log. */
const ODSO_TYPES: Record<string, string> = {
  '': 'Standard DataStore Object',
  W: 'Write-optimised DataStore Object',
  T: 'DataStore Object for direct update',
};

async function readOdso(client: BwClient, odsoName: string): Promise<string> {
  const name = sqlLiteral(odsoName.trim().toUpperCase());
  const scope = `odsobject = '${name}' AND objvers = 'A'`;

  // Split into narrow reads: the DataPreview service caps statement length, and a wide
  // SELECT does not return every column.
  const [[head], [flags], texts, fields] = await Promise.all([
    queryTable(
      client,
      `SELECT odsobject, odsotype, infoarea, bexfl, insertonly, key_not_unique, ` +
        `tstpnm, timestmp FROM rsdodso WHERE ${scope}`,
      1,
    ),
    queryTable(
      client,
      `SELECT autoqualokfl, autoactivatefl, autoprocessfl, planning_mode, imofl, ` +
        `readmode, cachemode FROM rsdodso WHERE ${scope}`,
      1,
    ),
    queryTable(client, `SELECT langu, txtlg FROM rsdodsot WHERE ${scope}`, 20),
    queryTable(
      client,
      `SELECT posit, keyflag, iobjnm, odstable FROM rsdodsoiobj WHERE ${scope} ORDER BY posit ASCENDING`,
      2000,
    ),
  ]);

  if (!head) return `Classic DSO ${odsoName} not found (no active version in RSDODSO).`;

  const out: string[] = [];
  out.push(`Classic DSO: ${head.ODSOBJECT}`);
  out.push('Source: metadata tables (read-only — BW/4HANA has no such object type, so this');
  out.push('        server offers no REST tool for it on any release)');
  const text = texts.find((t) => t.TXTLG)?.TXTLG;
  if (text) out.push(`Description: ${text}`);
  out.push(`InfoArea:    ${head.INFOAREA || '(none)'}`);
  out.push(`Type:        ${ODSO_TYPES[head.ODSOTYPE] ?? `unknown (${head.ODSOTYPE})`}`);
  const activeTable = fields.find((f) => f.ODSTABLE)?.ODSTABLE;
  if (activeTable) out.push(`Active table: ${activeTable}`);

  out.push('');
  out.push('── Flags ──');
  const yn = (v: string) => (v === 'X' ? 'yes' : 'no');
  out.push(`  BEx reporting:        ${yn(head.BEXFL)}`);
  out.push(`  Insert only:          ${yn(head.INSERTONLY)}`);
  out.push(`  Unique data records:  ${head.KEY_NOT_UNIQUE === 'X' ? 'no (key not unique)' : 'yes'}`);
  if (flags) {
    out.push(`  Auto activate:        ${yn(flags.AUTOACTIVATEFL)}`);
    out.push(`  Auto quality OK:      ${yn(flags.AUTOQUALOKFL)}`);
    out.push(`  Auto further update:  ${yn(flags.AUTOPROCESSFL)}`);
    if (flags.PLANNING_MODE) out.push(`  Planning mode:        ${flags.PLANNING_MODE}`);
    out.push(`  Read / cache mode:    ${flags.READMODE || '-'} / ${flags.CACHEMODE || '-'}`);
  }

  const keys = fields.filter((f) => f.KEYFLAG === 'X');
  out.push('');
  out.push(`── Key Fields (${keys.length}) ──`);
  out.push(keys.length ? `  ${keys.map((f) => toDisplayName(f.IOBJNM)).join(', ')}` : '  (none)');
  out.push('');
  out.push(`── Fields (${fields.length}) ──`);
  out.push('  POS   KEY  INFOOBJECT');
  for (const f of fields) {
    out.push(
      `  ${String(Number(f.POSIT)).padStart(3)}   ${f.KEYFLAG === 'X' ? ' X ' : '   '}  ${toDisplayName(f.IOBJNM)}`,
    );
  }

  out.push('');
  out.push(`Last changed: ${head.TIMESTMP} by ${head.TSTPNM}`);
  out.push(...(await loadHistorySection(client, odsoName)));
  return out.join('\n');
}

// ── InfoCube / MultiProvider (CUBE) ─────────────────────────────────────────

/** RSDCUBE-CUBETYPE, taken from domain RSCUBETYPE. */
const CUBE_TYPES: Record<string, string> = {
  B: 'Standard InfoCube',
  M: 'MultiProvider',
  V: 'Virtual InfoProvider',
  H: 'HybridProvider',
  A: 'Aggregate',
  R: 'Remote InfoCube',
  P: 'Append',
  C: 'CompositeProvider',
};

async function readCube(client: BwClient, cubeName: string): Promise<string> {
  const name = sqlLiteral(cubeName.trim().toUpperCase());
  const scope = `infocube = '${name}' AND objvers = 'A'`;

  const [[head], texts, fields, dimensions, dimFields] = await Promise.all([
    queryTable(
      client,
      `SELECT infocube, cubetype, cubesubtype, infoarea, activfl, objstat, funcname ` +
        `FROM rsdcube WHERE ${scope}`,
      1,
    ),
    queryTable(client, `SELECT langu, txtlg FROM rsdcubet WHERE ${scope}`, 20),
    queryTable(client, `SELECT posit, iobjnm FROM rsdcubeiobj WHERE ${scope} ORDER BY posit ASCENDING`, 2000),
    queryTable(
      client,
      `SELECT dimension, posit, tablnm, highcard, linitfl FROM rsddime WHERE ${scope} ORDER BY posit ASCENDING`,
      200,
    ),
    queryTable(client, `SELECT dimension, posit, iobjnm FROM rsddimeiobj WHERE ${scope}`, 2000),
  ]);

  if (!head) return `InfoProvider ${cubeName} not found (no active version in RSDCUBE).`;

  const isMulti = head.CUBETYPE === 'M';
  const out: string[] = [];
  out.push(`${isMulti ? 'MultiProvider' : 'InfoCube'}: ${head.INFOCUBE}`);
  out.push('Source: metadata tables (read-only — BW/4HANA has no such object type, so this');
  out.push('        server offers no REST tool for it on any release)');
  const text = texts.find((t) => t.TXTLG)?.TXTLG;
  if (text) out.push(`Description: ${text}`);
  out.push(`InfoArea:    ${head.INFOAREA || '(none)'}`);
  out.push(`Type:        ${CUBE_TYPES[head.CUBETYPE] ?? `unknown (${head.CUBETYPE})`}` +
    `${head.CUBESUBTYPE ? ` / subtype ${head.CUBESUBTYPE}` : ''}`);
  out.push(`Status:      ${head.ACTIVFL === 'X' ? 'active' : 'inactive'}`);
  if (head.FUNCNAME) out.push(`Function module: ${head.FUNCNAME}`);

  if (isMulti) {
    const parts = await queryTable(
      client,
      `SELECT posit, partcube FROM rsdcubemulti WHERE ${scope} ORDER BY posit ASCENDING`,
      200,
    );
    out.push('');
    out.push(`── Part Providers (${parts.length}) ──`);
    for (const p of parts) out.push(`  ${String(Number(p.POSIT)).padStart(3)}  ${p.PARTCUBE}`);
  } else {
    // Dimensions only exist on cubes that physically store data.
    const byDimension = new Map<string, string[]>();
    for (const f of dimFields) {
      if (!byDimension.has(f.DIMENSION)) byDimension.set(f.DIMENSION, []);
      byDimension.get(f.DIMENSION)!.push(toDisplayName(f.IOBJNM));
    }
    out.push('');
    out.push(`── Dimensions (${dimensions.length}) ──`);
    for (const d of dimensions) {
      const flags = [d.HIGHCARD === 'X' ? 'high cardinality' : '', d.LINITFL === 'X' ? 'line item' : '']
        .filter(Boolean)
        .join(', ');
      out.push(`  ${d.DIMENSION}${d.TABLNM ? `  (${d.TABLNM})` : ''}${flags ? `  [${flags}]` : ''}`);
      const members = byDimension.get(d.DIMENSION) ?? [];
      if (members.length) out.push(`      ${members.join(', ')}`);
    }
  }

  out.push('');
  out.push(`── InfoObjects (${fields.length}) ──`);
  out.push(`  ${fields.map((f) => toDisplayName(f.IOBJNM)).join(', ') || '(none)'}`);

  // A MultiProvider holds no data of its own — its parts do, and each is readable here.
  if (head.CUBETYPE !== 'M') out.push(...(await loadHistorySection(client, cubeName)));
  return out.join('\n');
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

const SUPPORTED = ['TRFN', 'DTPA', 'ODSO', 'CUBE', 'MPRO'];

/**
 * Width of the key column each type is looked up by. A name wider than its column does not
 * come back empty: the DataPreview service terminates with a truncation dump ("a value was
 * lost while copying"), which reaches the caller as an opaque HTTP 500. Checking the length
 * first turns that into a statement about the name.
 */
const NAME_WIDTHS: Record<string, number> = {
  TRFN: 32,
  DTPA: 30,
  DTP: 30,
  ODSO: 30,
  CUBE: 30,
  MPRO: 30,
};

/**
 * bw_read_metadata_tables — read an object definition from the BW metadata tables.
 *
 * Use when the connected system does not publish a REST resource for the object type
 * (check with bw_system_profile). Requires ADT authorization for the DataPreview service.
 */
export async function bwReadMetadataTables(
  client: BwClient,
  objectType: string,
  objectName: string,
): Promise<string> {
  const type = objectType.trim().toUpperCase();
  const name = objectName?.trim() ?? '';
  if (!name) return 'object_name is required.';

  const width = NAME_WIDTHS[type];
  if (width && name.length > width) {
    return (
      `"${name}" is ${name.length} characters, but an object name of type ${type} is at most ${width}. ` +
      `No object can carry this name — check the value that was passed.`
    );
  }

  switch (type) {
    case 'TRFN':
      return readTransformation(client, objectName.trim());
    case 'DTPA':
    case 'DTP':
      return readDtp(client, objectName.trim());
    case 'ODSO':
      return readOdso(client, objectName.trim());
    case 'CUBE':
    case 'MPRO':
      return readCube(client, objectName.trim());
    default:
      return (
        `Object type "${objectType}" is not supported yet. Supported: ${SUPPORTED.join(', ')}.`
      );
  }
}
