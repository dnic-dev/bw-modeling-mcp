import type { BwClient } from '../bw-client.js';
import {
  queryTable,
  sqlLiteral,
  toDisplayName,
  formatStamp,
  inListBatches,
  type Row,
} from './metadata_sql.js';

/**
 * Read BW Integrated Planning objects from their metadata tables.
 *
 * A classic release publishes `alvl` but none of the three planning resources behind
 * bw_get_planning_function, bw_get_planning_sequence and bw_get_planning_properties, so on
 * such a system those tools are hidden and this is the route to the same content. Data
 * slices have no REST resource on any release and are only readable this way.
 *
 * The output deliberately follows the wording of the REST readers in planning.ts —
 * "Function Type", "Aggregation Level", "Characteristic Usage" — so that an answer does not
 * depend on which of the two routes produced it.
 *
 * Read-only by nature: planning objects are built by the BW framework, not by table writes.
 */

// ── Shared decoding ─────────────────────────────────────────────────────────

/**
 * RSZTYPEFLAG, from the domain of the same name. It says what the LOW/HIGH cell of a
 * selection holds — a plain value, or a reference that has to be resolved elsewhere. Getting
 * this wrong turns a variable name into a nonsensical characteristic value, so the raw code
 * travels with the text for anything this map does not know.
 */
const TYPE_FLAGS: Record<string, string> = {
  '0': 'blank',
  '1': 'value',
  '2': 'CIN link',
  '3': 'variable',
  '4': 'InfoObject',
  '5': 'constant',
  '6': 'exit variable',
};

/** RSPLF_PARAM_TYPE — what kind of parameter a planning function type declares. */
const PARAM_TYPES: Record<string, string> = {
  '1': 'elementary',
  '2': 'InfoObject of the InfoProvider',
  '3': 'data selection',
  '4': 'structure',
  '5': 'key figure selection',
};

/** RSPLS_STEPTYPE — the two kinds of step a planning sequence can hold. */
const STEP_TYPES: Record<string, string> = {
  '1': 'Manual input',
  '2': 'Planning service',
};

/** RSPLS_MTYPE — how a characteristic relationship derives its target values. */
const RELATION_TYPES: Record<string, string> = {
  A: 'Attribute',
  E: 'Exit (ABAP class)',
  R: 'Reference data (DataStore object)',
  H: 'Hierarchy',
  T: 'Time',
};

/** RSPLS_CHA_ROLE — which side of a characteristic relationship a characteristic is on. */
const CHAR_ROLES: Record<string, string> = {
  S: 'source',
  T: 'target',
};

/** RSPLS_DSTYPE — how a data slice decides which records it protects. */
const SLICE_TYPES: Record<string, string> = {
  S: 'Selection',
  E: 'Exit (ABAP class)',
  U: 'Merge',
};

/** RSPLS_CR_DATETOOPT / RSPLS_CR_HIEDATETOOPT — where the key date of a derivation comes from. */
const KEY_DATE_OPTIONS: Record<string, string> = {
  S: 'system date (today)',
  F: 'fixed date',
  V: 'variable',
  Q: 'from the query key date',
};

/**
 * A domain code as text. The raw code is kept only where the map does not know it — these
 * are modelling codes with no meaning of their own, unlike a request status, where the code
 * is what the caller recognises and both are therefore shown.
 */
function describe(map: Record<string, string>, code: string | undefined): string {
  const raw = (code ?? '').trim();
  if (!raw) return '(none)';
  return map[raw] ?? `unknown (${raw})`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/**
 * The development package of one object.
 *
 * None of the RSPL* tables carry it — it lives in TADIR, keyed by the TLOGO type. The REST
 * readers report it, so reading it here keeps the two routes comparable. Best effort: a
 * package that cannot be read is simply not shown.
 */
async function packageOf(client: BwClient, tlogo: string, name: string): Promise<string> {
  try {
    const [row] = await queryTable(
      client,
      `SELECT devclass FROM tadir WHERE pgmid = 'R3TR' AND object = '${tlogo}' ` +
        `AND obj_name = '${sqlLiteral(name)}'`,
      1,
    );
    return (row?.DEVCLASS ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * The InfoArea a planning-enabled provider sits in.
 *
 * RSPLS_CR_HEAD does not carry it; the provider does, and which table that is depends on what
 * the provider is. aDSO first because a real-time provider usually is one, InfoCube/
 * CompositeProvider as the fallback. Best effort, like the package.
 */
async function providerInfoArea(client: BwClient, provider: string): Promise<string> {
  const name = sqlLiteral(provider);
  for (const sql of [
    `SELECT infoarea FROM rsoadso WHERE adsonm = '${name}' AND objvers = 'A'`,
    `SELECT infoarea FROM rsdcube WHERE infocube = '${name}' AND objvers = 'A'`,
  ]) {
    try {
      const [row] = await queryTable(client, sql, 1);
      const area = (row?.INFOAREA ?? '').trim();
      if (area) return area;
    } catch {
      // next candidate
    }
  }
  return '';
}

/** The long text of an object, preferring English and falling back to whatever exists. */
function pickText(rows: Row[], column = 'TXTLG'): string {
  const texts = rows.filter((r) => (r[column] ?? '').trim());
  const english = texts.find((r) => r.LANGU === 'E');
  return ((english ?? texts[0])?.[column] ?? '').trim();
}

// ── Variable resolution ─────────────────────────────────────────────────────

/**
 * Resolve the 25-character variable UIDs a selection may hold to their technical names.
 *
 * Without this a selection reads `0CALYEAR = 44SL6M9HXPT84PZ6GNN37RSYF`, which tells the
 * caller nothing and looks like a characteristic value rather than a reference. Best effort:
 * a UID that cannot be resolved is still printed, marked as a variable.
 */
async function resolveVariables(client: BwClient, uids: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const unique = [...new Set(uids.filter((u) => /^[A-Z0-9]{25}$/.test(u)))];
  if (unique.length === 0) return resolved;

  // The DataPreview service parses a limited statement length, so the IN-list is split into
  // batches that keep each statement inside it.
  for (const batch of inListBatches(unique, 120)) {
    try {
      const rows = await queryTable(
        client,
        `SELECT varuniid, vnam, iobjnm FROM rszglobv WHERE varuniid IN (${batch}) AND objvers = 'A'`,
        60,
      );
      for (const r of rows) if (r.VARUNIID && r.VNAM) resolved.set(r.VARUNIID, r.VNAM);
    } catch {
      // A name is an enrichment; the UID alone still identifies the variable.
    }
  }
  return resolved;
}

/** Every LOW/HIGH cell of a selection row set that holds a reference rather than a value. */
function variableUids(rows: Row[], lowCol: string, highCol: string): string[] {
  const uids: string[] = [];
  for (const r of rows) {
    if (r.LOWFLAG === '3' && r[lowCol]) uids.push(r[lowCol]);
    if (r.HIGHFLAG === '3' && r[highCol]) uids.push(r[highCol]);
  }
  return uids;
}

/**
 * One selection row — the shape shared by RSPLF_SRV_PS, RSPLF_SRV_COND, RSPLS_CR_RANGE and
 * RSPLS_DS_RANGE. Only the value columns differ between them, hence lowCol/highCol.
 */
export function formatSelection(
  row: Row,
  vars: Map<string, string>,
  lowCol = 'LOW',
  highCol = 'HIGH',
): string {
  const value = (raw: string | undefined, flag: string | undefined): string => {
    const v = (raw ?? '').trim();
    if (!v) return '"#" (initial / unassigned)';
    if (flag === '3') return `variable ${vars.get(v) ?? v}`;
    if (flag === '6') return `exit variable ${v}`;
    if (flag === '4') return `InfoObject ${toDisplayName(v)}`;
    // '#' is how BW writes its own initial value; as a bare character it reads like a comment.
    // An empty cell means the same thing — the REST route renders both as '#' — and showing
    // one as '""' and the other as '#' makes two routes to the same object look contradictory.
    if (v === '#') return '"#" (initial / unassigned)';
    // 0 and 1 are a plain value. Anything else is a reference this reader does not resolve,
    // and saying so beats printing a CIN link as if it were a characteristic value.
    const kind = flag && flag !== '0' && flag !== '1' ? TYPE_FLAGS[flag] ?? `flag ${flag}` : '';
    return kind ? `"${v}" (${kind})` : `"${v}"`;
  };

  const sign = (row.SIGN ?? '').trim() || 'I';
  const opt = (row.OPT ?? '').trim() || 'EQ';
  let line = `${pad(toDisplayName(row.IOBJNM ?? ''), 22)} [${sign} ${pad(opt, 2)}]  ${value(row[lowCol], row.LOWFLAG)}`;
  const high = (row[highCol] ?? '').trim();
  if (high) line += `  to  ${value(row[highCol], row.HIGHFLAG)}`;
  if (row.HIENM) line += `  hierarchy ${row.HIENM}`;
  return line;
}

/**
 * The value of an elementary parameter. An empty cell is BW's initial value, spelled the way
 * a selection spells it and the way the REST route renders it.
 */
function elementaryValue(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  return v ? `"${v}"` : '"#" (initial / unassigned)';
}

/**
 * Run the statements of one read one after the other.
 *
 * Not `Promise.all`: the DataPreview service is a POST that spends a CSRF token, and the
 * backend rotates that token out from under the client. Two statements in flight already
 * cost a retry; nine of them — what a planning function needs — made a reference system drop
 * the connection outright, repeatably at the same object. Serialising removed that, and the
 * connection retry in queryTable covers the drops that remain. A planning object is read in
 * well under a second either way.
 */
async function sequential<T>(steps: Array<() => Promise<T>>): Promise<T[]> {
  const results: T[] = [];
  for (const step of steps) results.push(await step());
  return results;
}

// ── Planning function (PLSE) ────────────────────────────────────────────────

export interface ParamDef {
  name: string;
  position: number;
  type: string;
  isTable: boolean;
  parent: string;
  infoObject: string;
}

/**
 * A formula line. Its InfoObject is what marks a parameter as holding source code rather
 * than a value, which is why the check is on the InfoObject and not on the parameter name:
 * the name differs per function type, the InfoObject does not.
 */
const FORMULA_LINE_IOBJ = '0RSPL_FLINE';

/** The line number of a formula chunk — bookkeeping, not content. */
const FORMULA_SEQNO_IOBJ = '0RSPL_FSEQN';

/**
 * Reassemble FOX source from the chunks BW stores it in.
 *
 * A formula is *not* stored one table row per source line. It is a character stream cut into
 * fixed-width chunks, and the line breaks sit inside the values as newlines. Printing one row
 * per chunk therefore cuts words in half — verified against a 22-chunk formula whose output
 * read `*  ASSUMP` / `TION FOR FIELDS…`. The chunks are concatenated in INDX order, and the
 * result is split on its own newlines afterwards.
 *
 * DataPreview strips trailing blanks from every cell, which would swallow a space that sits
 * at a chunk boundary. Every chunk but the last is therefore padded back to the widest one
 * seen, which is the storage width. A formula short enough to fit one chunk is unaffected.
 */
export function joinFormulaChunks(rows: Row[]): string[] {
  const ordered = [...rows].sort((a, b) => Number(a.INDX) - Number(b.INDX));
  if (ordered.length === 0) return [];
  const width = Math.max(...ordered.map((r) => (r.VALUE ?? '').length));
  const stream = ordered
    .map((r, i) => (i === ordered.length - 1 ? (r.VALUE ?? '') : (r.VALUE ?? '').padEnd(width)))
    .join('');
  return stream.split('\n').map((line) => line.replace(/\s+$/, ''));
}

/**
 * The parameter tree of a planning function, rendered from three tables at once.
 *
 * RSPLF_SRVTYPE_P holds the *declaration* — which parameters the function type has, their
 * order, their type, and which structure parameter each belongs to. RSPLF_SRV_P and
 * RSPLF_SRV_PS hold the *values* of one concrete function, keyed by (RULEPOS, PARNM, INDX).
 * Reading the values alone would give a flat list of names with no indication of what they
 * mean or how they nest, which is why the declaration is read as well.
 *
 * RULEPOS is the rule number — a function type that supports several rules (a copy function
 * with several from/to pairs) repeats the whole parameter set per rule. INDX is the row
 * number inside a table parameter.
 */
export function formatParameterTree(
  defs: ParamDef[],
  values: Row[],
  selections: Row[],
  texts: Map<string, string>,
  vars: Map<string, string>,
): string[] {
  const out: string[] = [];
  const label = (name: string): string => {
    const text = texts.get(name);
    return text ? `${name} — ${text}` : name;
  };

  const rules = [...new Set([...values, ...selections].map((r) => r.RULEPOS || '1'))].sort(
    (a, b) => Number(a) - Number(b),
  );

  for (const rule of rules) {
    if (rules.length > 1) out.push(`  Rule ${rule}`);
    const inRule = (rows: Row[]) => rows.filter((r) => (r.RULEPOS || '1') === rule);
    const ruleValues = inRule(values);
    const ruleSelections = inRule(selections);
    const base = rules.length > 1 ? '    ' : '  ';

    const roots = defs.filter((d) => !d.parent);
    // A parameter the declaration does not mention is still reported: a function type whose
    // declaration could not be read must not silently drop the values that were read.
    const declared = new Set(defs.map((d) => d.name));
    const orphans = [...new Set([...ruleValues, ...ruleSelections].map((r) => r.PARNM))].filter(
      (p) => p && !declared.has(p),
    );

    for (const root of roots) {
      const children = defs.filter((d) => d.parent === root.name);
      const ownValues = ruleValues.filter((v) => v.PARNM === root.name);
      const ownSelections = ruleSelections.filter((s) => s.PARNM === root.name);
      const childRows = [...ruleValues, ...ruleSelections].filter((r) =>
        children.some((c) => c.name === r.PARNM),
      );
      if (ownValues.length === 0 && ownSelections.length === 0 && childRows.length === 0) continue;

      out.push(`${base}${label(root.name)}  [${describe(PARAM_TYPES, root.type)}${root.isTable ? ', table' : ''}]`);

      // A formula table is the source code of the function; printing it row by row would
      // scatter one FOX program over dozens of "Row n" headings.
      const formulaChild = children.find((c) => c.infoObject === FORMULA_LINE_IOBJ);
      if (formulaChild) {
        const code = joinFormulaChunks(ruleValues.filter((v) => v.PARNM === formulaChild.name));
        out.push(`${base}  ${label(formulaChild.name)}  [${code.length} line(s)]`);
        for (const l of code) out.push(`${base}    | ${l}`);
        for (const other of children.filter((c) => c !== formulaChild)) {
          // One row per chunk, and the chunk number carries nothing the order does not
          // already say — printing it buries the formula under its own bookkeeping.
          if (other.infoObject === FORMULA_SEQNO_IOBJ) continue;
          const vals = ruleValues.filter((v) => v.PARNM === other.name);
          for (const v of vals) out.push(`${base}  ${label(other.name)} = ${elementaryValue(v.VALUE)}`);
        }
        continue;
      }

      out.push(...renderValues(ownValues, ownSelections, `${base}  `));

      const indices = [...new Set(childRows.map((r) => r.INDX || '1'))].sort(
        (a, b) => Number(a) - Number(b),
      );
      for (const indx of indices) {
        if (root.isTable) out.push(`${base}  Row ${indx}`);
        const rowPad = root.isTable ? `${base}    ` : `${base}  `;
        for (const child of children) {
          const vals = ruleValues.filter((v) => v.PARNM === child.name && (v.INDX || '1') === indx);
          const sels = ruleSelections.filter(
            (s) => s.PARNM === child.name && (s.INDX || '1') === indx,
          );
          if (vals.length === 0 && sels.length === 0) continue;
          if (sels.length > 0) {
            out.push(`${rowPad}${label(child.name)}  [${describe(PARAM_TYPES, child.type)}]`);
            for (const s of sels) out.push(`${rowPad}  ${formatSelection(s, vars)}`);
          }
          for (const v of vals) out.push(`${rowPad}${label(child.name)} = ${elementaryValue(v.VALUE)}`);
        }
      }
    }

    for (const name of orphans) {
      out.push(`${base}${label(name)}  [not declared by the function type]`);
      out.push(
        ...renderValues(
          ruleValues.filter((v) => v.PARNM === name),
          ruleSelections.filter((s) => s.PARNM === name),
          `${base}  `,
        ),
      );
    }
  }

  function renderValues(vals: Row[], sels: Row[], padStr: string): string[] {
    const lines: string[] = [];
    for (const s of sels) lines.push(`${padStr}${formatSelection(s, vars)}`);
    for (const v of vals) lines.push(`${padStr}= ${elementaryValue(v.VALUE)}`);
    return lines;
  }

  return out.length > 0 ? out : ['  (no parameter values)'];
}

export async function readPlanningFunction(client: BwClient, funcName: string): Promise<string> {
  const name = sqlLiteral(funcName.trim().toUpperCase());
  const scope = `srvnm = '${name}' AND objvers = 'A'`;

  const [head] = await queryTable(
    client,
    `SELECT srvnm, srvtypenm, infoprov, objstat, activfl, owner, tstpnm, timestmp ` +
      `FROM rsplf_srv WHERE ${scope}`,
    1,
  );
  if (!head) {
    return `Planning function ${funcName} not found (no active version in RSPLF_SRV).`;
  }

  const type = sqlLiteral(head.SRVTYPENM ?? '');
  const typeScope = `srvtypenm = '${type}' AND objvers = 'A'`;

  const [texts, typeRows, typeTexts, charUsage, conditions, paramDefs, paramTexts, values, selections] =
    await sequential([
      () => queryTable(client, `SELECT langu, txtlg FROM rsplf_srvt WHERE ${scope}`, 20),
      () => queryTable(client, `SELECT classnm, hasrefdata, zero FROM rsplf_srvtype WHERE ${typeScope}`, 1),
      () => queryTable(client, `SELECT langu, txtlg FROM rsplf_srvtypet WHERE ${typeScope}`, 20),
      () => queryTable(client, `SELECT charnm, is_cond_char, is_chng_char FROM rsplf_srv_cu WHERE ${scope}`, 200),
      () =>
        queryTable(
          client,
          `SELECT rulepos, enum, iobjnm, sign, opt, low, lowflag, high, highflag, hienm ` +
            `FROM rsplf_srv_cond WHERE ${scope}`,
          500,
        ),
      () =>
        queryTable(
          client,
          `SELECT parnm, param_pos, param_type, is_table, struc_parnm, iobjnm ` +
            `FROM rsplf_srvtype_p WHERE ${typeScope}`,
          200,
        ),
      () => queryTable(client, `SELECT parnm, txtlg, langu FROM rsplf_srvtype_pt WHERE ${typeScope}`, 500),
      () => queryTable(client, `SELECT rulepos, parnm, indx, val_type, value FROM rsplf_srv_p WHERE ${scope}`, 2000),
      () =>
        queryTable(
          client,
          `SELECT rulepos, parnm, indx, enum, iobjnm, sign, opt, low, lowflag, high, highflag, hienm ` +
            `FROM rsplf_srv_ps WHERE ${scope}`,
          2000,
        ),
    ]);

  // BW writes one empty condition row per rule when the function has no condition at all
  // (verified: 16 of the 25 functions on the reference system carry exactly such a row).
  // Reported as-is it would claim a condition that restricts nothing.
  const realConditions = conditions.filter((c) => (c.IOBJNM ?? '').trim());

  const vars = await resolveVariables(client, [
    ...variableUids(selections, 'LOW', 'HIGH'),
    ...variableUids(realConditions, 'LOW', 'HIGH'),
    ]);

  const defs: ParamDef[] = paramDefs
    .map((d) => ({
      name: d.PARNM,
      position: Number(d.PARAM_POS || 0),
      type: d.PARAM_TYPE,
      isTable: d.IS_TABLE === 'X',
      parent: (d.STRUC_PARNM ?? '').trim(),
      infoObject: (d.IOBJNM ?? '').trim(),
    }))
    .sort((a, b) => a.position - b.position);

  // English first, so a parameter labelled in several languages reads the same everywhere.
  const paramLabels = new Map<string, string>();
  for (const t of paramTexts.filter((t) => t.LANGU === 'E')) paramLabels.set(t.PARNM, t.TXTLG);
  for (const t of paramTexts) if (!paramLabels.has(t.PARNM)) paramLabels.set(t.PARNM, t.TXTLG);

  const out: string[] = [];
  out.push(`Planning Function: ${head.SRVNM}`);
  out.push('Source: metadata tables (read-only — the route for a system that does not publish');
  out.push('        the plse resource; on one that does, bw_get_planning_function reads the same object)');
  const description = pickText(texts);
  if (description) out.push(`Description:       ${description}`);
  const typeText = pickText(typeTexts);
  out.push(`Function Type:     ${head.SRVTYPENM}${typeText ? ` — ${typeText}` : ''}`);
  out.push(`Aggregation Level: ${head.INFOPROV || '(none)'}`);

  // The aggregation level carries the InfoArea; RSPLF_SRV itself has none.
  if (head.INFOPROV) {
    const [alvl] = await queryTable(
      client,
      `SELECT infoprov, infoarea, alvltype FROM rspls_alvl ` +
        `WHERE aggrlevel = '${sqlLiteral(head.INFOPROV)}' AND objvers = 'A'`,
      1,
    );
    if (alvl) {
      out.push(`  on InfoProvider: ${alvl.INFOPROV || '(unknown)'}`);
      out.push(`  InfoArea:        ${alvl.INFOAREA || '(none)'}`);
    }
  }

  const pkg = await packageOf(client, 'PLSE', head.SRVNM);
  if (pkg) out.push(`Package:           ${pkg}`);

  const exitClass = (typeRows[0]?.CLASSNM ?? '').trim();
  if (exitClass) {
    out.push(`Exit class:        ${exitClass}`);
    // A customer function type is where the actual logic lives; without this pointer the
    // parameter list below is the whole answer, and it explains nothing.
    if (!(head.SRVTYPENM ?? '').startsWith('0')) {
      out.push('                   (customer function type — read the class for the logic)');
    }
  }
  out.push(`Last changed:      ${formatStamp(head.TIMESTMP)} by ${head.TSTPNM || '(unknown)'}`);

  out.push('');
  out.push(`── Characteristic Usage (${charUsage.length}) ──`);
  if (charUsage.length === 0) {
    out.push('  (none — the function works on every characteristic of the aggregation level)');
  } else {
    for (const c of [...charUsage].sort((a, b) => a.CHARNM.localeCompare(b.CHARNM))) {
      const roles: string[] = [];
      if (c.IS_CHNG_CHAR === 'X') roles.push('to be changed');
      if (c.IS_COND_CHAR === 'X') roles.push('condition');
      out.push(`  ${pad(toDisplayName(c.CHARNM), 22)} ${roles.length ? roles.join(', ') : '(no role)'}`.trimEnd());
    }
  }

  if (realConditions.length > 0) {
    out.push('');
    out.push(`── Conditions (${realConditions.length}) ──`);
    // Conditions are per rule, and a rule is what selects the data block it works on. Listed
    // flat, two rules restricted to different value types read as one function with four
    // conditions — which no data block can satisfy at once.
    const rules = [...new Set(realConditions.map((c) => c.RULEPOS || '1'))].sort(
      (a, b) => Number(a) - Number(b),
    );
    for (const rule of rules) {
      if (rules.length > 1) out.push(`  Rule ${rule}`);
      const indent = rules.length > 1 ? '    ' : '  ';
      for (const c of realConditions
        .filter((c) => (c.RULEPOS || '1') === rule)
        .sort((a, b) => Number(a.ENUM) - Number(b.ENUM))) {
        out.push(`${indent}${formatSelection(c, vars)}`);
      }
    }
  }

  out.push('');
  out.push('── Parameters ──');
  out.push(...formatParameterTree(defs, values, selections, paramLabels, vars));

  return out.join('\n');
}

// ── Planning sequence (PLSQ) ────────────────────────────────────────────────

export async function readPlanningSequence(client: BwClient, seqName: string): Promise<string> {
  const name = sqlLiteral(seqName.trim().toUpperCase());
  const scope = `seqnm = '${name}' AND objvers = 'A'`;

  const [[head], texts, steps] =
    await sequential([
      () =>
        queryTable(
          client,
          `SELECT seqnm, infoarea, objstat, no_ds_check, var_reproc, tstpnm, timestmp ` +
            `FROM rspls_sequence WHERE ${scope}`,
          1,
        ),
      () => queryTable(client, `SELECT langu, txtlg FROM rspls_sequencet WHERE ${scope}`, 20),
      () =>
        queryTable(
          client,
          `SELECT stepid, steptype, aggrlevel, selobj, srvnm, querynm FROM rspls_sequence_s WHERE ${scope}`,
          500,
        ),
    ]);

  if (!head) {
    return `Planning sequence ${seqName} not found (no active version in RSPLS_SEQUENCE).`;
  }

  // Numeric, not alphabetic: STEPID is an INT4 and would otherwise order 10 before 2.
  const ordered = [...steps].sort((a, b) => Number(a.STEPID) - Number(b.STEPID));

  // One statement for all step functions rather than one per step.
  const functionTexts = new Map<string, string>();
  const funcNames = [...new Set(ordered.map((s) => (s.SRVNM ?? '').trim()).filter(Boolean))];
  for (const batch of inListBatches(funcNames, 120)) {
    try {
      const rows = await queryTable(
        client,
        `SELECT srvnm, txtlg, langu FROM rsplf_srvt WHERE srvnm IN (${batch}) AND objvers = 'A'`,
        200,
      );
      for (const r of rows.filter((r) => r.LANGU === 'E')) functionTexts.set(r.SRVNM, r.TXTLG);
      for (const r of rows) if (!functionTexts.has(r.SRVNM)) functionTexts.set(r.SRVNM, r.TXTLG);
    } catch {
      // Descriptions are an enrichment; the technical names carry the sequence.
    }
  }

  const out: string[] = [];
  out.push(`Planning Sequence: ${head.SEQNM}`);
  out.push('Source: metadata tables (read-only — the route for a system that does not publish');
  out.push('        the plsq resource; on one that does, bw_get_planning_sequence reads the same object)');
  const description = pickText(texts);
  if (description) out.push(`Description:       ${description}`);
  out.push(`InfoArea:          ${head.INFOAREA || '(none)'}`);
  const seqPkg = await packageOf(client, 'PLSQ', head.SEQNM);
  if (seqPkg) out.push(`Package:           ${seqPkg}`);
  out.push(`Data slice check:  ${head.NO_DS_CHECK === 'X' ? 'off (slices are ignored)' : 'on'}`);
  out.push(`Variable re-prompt: ${head.VAR_REPROC === 'X' ? 'yes' : 'no'}`);
  out.push(`Last changed:      ${formatStamp(head.TIMESTMP)} by ${head.TSTPNM || '(unknown)'}`);

  out.push('');
  out.push(`── Steps (${ordered.length}, in execution order) ──`);
  if (ordered.length === 0) {
    out.push('  (no steps)');
  } else {
    for (const s of ordered) {
      out.push(`  ${s.STEPID}. ${describe(STEP_TYPES, s.STEPTYPE)}`);
      if (s.AGGRLEVEL) out.push(`       Aggregation Level: ${s.AGGRLEVEL}`);
      if (s.SRVNM) {
        const text = functionTexts.get(s.SRVNM);
        out.push(`       Planning Function: ${s.SRVNM}${text ? ` — ${text}` : ''}`);
      }
      if (s.SELOBJ) out.push(`       Filter:            ${s.SELOBJ}`);
      if (s.QUERYNM) out.push(`       Query:             ${s.QUERYNM}`);
    }
    out.push('');
    out.push('Steps run strictly in STEPID order — a planning sequence has no parallel branches.');
  }

  return out.join('\n');
}

// ── Planning properties and characteristic relationships (PLCR) ─────────────

export async function readPlanningProperties(client: BwClient, providerName: string): Promise<string> {
  const name = sqlLiteral(providerName.trim().toUpperCase());
  const scope = `infoprov = '${name}' AND objvers = 'A'`;

  const [[head], [props], steps, roles, ranges, slices] =
    await sequential([
      () => queryTable(client, `SELECT infoprov, objstat, tstpnm, timestmp FROM rspls_cr_head WHERE ${scope}`, 1),
      () =>
        queryTable(
          client,
          `SELECT dateto, dateto_opt, max_rows_create, exitclass_ev, sequence, delta, delta_alvl ` +
            `FROM rspls_cr_prop WHERE ${scope}`,
          1,
        ),
      () =>
        queryTable(
          client,
          `SELECT step, mtype, derive, chanm, exitclass, combitab, used, hienm, hiever, dateto ` +
            `FROM rspls_cr_steps WHERE ${scope}`,
          200,
        ),
      () => queryTable(client, `SELECT step, role, chanm FROM rspls_cr_role WHERE ${scope}`, 500),
      () =>
        queryTable(
          client,
          `SELECT step, iobjnm, enum, sign, opt, lowint, lowflag, highint, highflag ` +
            `FROM rspls_cr_range WHERE ${scope}`,
          500,
        ),
      () => queryTable(client, `SELECT dsnr, dstype, used FROM rspls_ds WHERE ${scope}`, 200),
    ]);

  if (!head && !props && steps.length === 0) {
    return (
      `No planning properties found for ${providerName} (no active entry in RSPLS_CR_HEAD, ` +
      `RSPLS_CR_PROP or RSPLS_CR_STEPS). Either the provider is not planning-enabled, or it ` +
      `carries neither characteristic relationships nor a save strategy.`
    );
  }

  const vars = await resolveVariables(client, variableUids(ranges, 'LOWINT', 'HIGHINT'));

  const out: string[] = [];
  const provider = providerName.trim().toUpperCase();
  out.push(`Planning Properties: ${provider}`);
  out.push('Source: metadata tables (read-only — the route for a system that does not publish');
  out.push('        the plcr resource; on one that does, bw_get_planning_properties reads the same object)');
  const area = await providerInfoArea(client, provider);
  if (area) out.push(`InfoArea:            ${area}`);
  const crPkg = await packageOf(client, 'PLCR', provider);
  if (crPkg) out.push(`Package:             ${crPkg}`);
  if (head) {
    out.push(`Last changed:        ${formatStamp(head.TIMESTMP)} by ${head.TSTPNM || '(unknown)'}`);
  }

  out.push('');
  out.push('── General Settings ──');
  if (props) {
    out.push(`  Key date:          ${describe(KEY_DATE_OPTIONS, props.DATETO_OPT)}`);
    const fixed = (props.DATETO ?? '').trim();
    if (fixed && !/^0+$/.test(fixed)) out.push(`    fixed value:     ${fixed}`);
    out.push(`  Max combinations:  ${props.MAX_ROWS_CREATE || '(not set)'}`);
    if (props.EXITCLASS_EV) out.push(`  Event exit class:  ${props.EXITCLASS_EV}`);
    out.push('  Save strategy:');
    out.push(`    Planning sequence: ${props.SEQUENCE || '(none)'}`);
    out.push(`    Delta read:        ${props.DELTA === 'X' ? 'yes' : 'no'}`);
    if (props.DELTA_ALVL) out.push(`    Delta agg. level:  ${props.DELTA_ALVL}`);
  } else {
    out.push('  (no entry in RSPLS_CR_PROP — settings are at their defaults)');
  }

  out.push('');
  out.push(`── Characteristic Relationships (${steps.length}) ──`);
  if (steps.length === 0) {
    out.push('  (none)');
  } else {
    for (const s of [...steps].sort((a, b) => Number(a.STEP) - Number(b.STEP))) {
      out.push(`  Step ${s.STEP}: ${describe(RELATION_TYPES, s.MTYPE)}${s.USED === 'X' ? '' : '  [not active]'}`);
      out.push(`    Derivation:      ${s.DERIVE === 'X' ? 'yes' : 'no (check only)'}`);
      if (s.CHANM) {
        // Verified against the master data: for an attribute relationship CHANM is the
        // characteristic that *carries* the attributes the relationship is built from, and
        // the role rows list it together with those attributes.
        const role = s.MTYPE === 'A' ? 'Attributes of:  ' : 'Characteristic: ';
        out.push(`    ${role} ${toDisplayName(s.CHANM)}`);
      }
      if (s.EXITCLASS) out.push(`    Exit class:      ${s.EXITCLASS}`);
      if (s.COMBITAB) out.push(`    Reference data:  ${s.COMBITAB}`);
      if (s.HIENM) out.push(`    Hierarchy:       ${s.HIENM}${s.HIEVER ? ` version ${s.HIEVER}` : ''}`);

      const stepRoles = roles.filter((r) => r.STEP === s.STEP);
      for (const role of ['S', 'T']) {
        const chars = stepRoles.filter((r) => r.ROLE === role).map((r) => toDisplayName(r.CHANM));
        if (chars.length > 0) {
          out.push(`    ${pad(`${CHAR_ROLES[role]}:`, 16)} ${chars.join(', ')}`);
        }
      }
      // Named rather than omitted: a role BW writes but this reader does not know would
      // otherwise silently drop characteristics from a relationship.
      const other = stepRoles.filter((r) => !CHAR_ROLES[r.ROLE]);
      if (other.length > 0) {
        for (const r of other) out.push(`    role "${r.ROLE}":     ${toDisplayName(r.CHANM)}`);
      }

      const stepRanges = ranges.filter((r) => r.STEP === s.STEP);
      if (stepRanges.length > 0) {
        out.push(`    Validity range (${stepRanges.length}):`);
        for (const r of [...stepRanges].sort((a, b) => Number(a.ENUM) - Number(b.ENUM))) {
          out.push(`      ${formatSelection(r, vars, 'LOWINT', 'HIGHINT')}`);
        }
      }
    }
  }

  out.push('');
  if (slices.length > 0) {
    const active = slices.filter((s) => s.USED === 'X').length;
    out.push(
      `Data slices: ${slices.length} (${active} active) — read them with object_type="PLDS" ` +
        `on this provider.`,
    );
  } else {
    out.push('Data slices: none.');
  }
  out.push('Aggregation levels on this provider are published as a REST resource — use');
  out.push('bw_get_aggregation_level, which every release serves.');

  return out.join('\n');
}

// ── Data slices (PLDS) ──────────────────────────────────────────────────────

export async function readDataSlices(client: BwClient, providerName: string): Promise<string> {
  const name = sqlLiteral(providerName.trim().toUpperCase());
  const scope = `infoprov = '${name}' AND objvers = 'A'`;

  const [slices, header, texts, fields, ranges] =
    await sequential([
      () =>
        queryTable(
          client,
          `SELECT dsnr, dstype, exitclass, used, tstpnm, timestmp FROM rspls_ds WHERE ${scope}`,
          200,
        ),
      // The TLOGO header of the data-slice object. It exists for every planning-enabled
      // provider, with or without slices, and is what separates "no slices defined" from
      // "wrong object" - verified on a provider that has the header and no slice at all.
      () => queryTable(client, `SELECT infoprov FROM rspls_ds_head WHERE ${scope}`, 1),
      () => queryTable(client, `SELECT dsnr, langu, txtlg, txtsh FROM rspls_dst WHERE ${scope}`, 500),
      () => queryTable(client, `SELECT dsnr, iobjnm, iobjtp, contains_init, fieldnm FROM rspls_ds_field WHERE ${scope}`, 1000),
      () =>
        queryTable(
          client,
          `SELECT dsnr, iobjnm, enum, sign, opt, lowint, lowflag, highint, highflag ` +
            `FROM rspls_ds_range WHERE ${scope}`,
          1000,
        ),
    ]);

  if (slices.length === 0) {
    const provider = providerName.trim().toUpperCase();
    return header.length > 0
      ? `${provider} is planning-enabled but has no data slice defined (RSPLS_DS_HEAD exists, ` +
          `RSPLS_DS is empty).`
      : `No data slices found for ${provider} (no active entry in RSPLS_DS_HEAD or RSPLS_DS). ` +
          `Data slices are defined per planning-enabled InfoProvider — pass the provider, not an ` +
          `aggregation level.`;
  }

  const vars = await resolveVariables(client, variableUids(ranges, 'LOWINT', 'HIGHINT'));

  const out: string[] = [];
  out.push(`Data Slices: ${providerName.trim().toUpperCase()}`);
  out.push('Source: metadata tables (read-only — no release publishes a REST resource for data');
  out.push('        slices, so this is the only route on any platform)');
  out.push('');
  out.push('A data slice protects the records it selects: they cannot be changed by manual input');
  out.push('or by a planning function, whatever the lock and authorization situation allows.');

  for (const s of [...slices].sort((a, b) => Number(a.DSNR) - Number(b.DSNR))) {
    out.push('');
    const description = pickText(texts.filter((t) => t.DSNR === s.DSNR));
    out.push(`── Slice ${s.DSNR}${description ? `: ${description}` : ''} ──`);
    out.push(`  Type:    ${describe(SLICE_TYPES, s.DSTYPE)}`);
    out.push(`  Active:  ${s.USED === 'X' ? 'yes' : 'no'}`);
    if (s.EXITCLASS) {
      out.push(`  Exit class: ${s.EXITCLASS}`);
      out.push('  (the class decides which records are protected — the selection below, if any,');
      out.push('   only narrows what it is asked about)');
    }
    out.push(`  Changed: ${formatStamp(s.TIMESTMP)} by ${s.TSTPNM || '(unknown)'}`);

    const sliceFields = fields.filter((f) => f.DSNR === s.DSNR);
    if (sliceFields.length > 0) {
      out.push(`  Characteristics (${sliceFields.length}):`);
      for (const f of sliceFields) {
        const init = f.CONTAINS_INIT === 'X' ? '  includes the initial value' : '';
        out.push(`    ${pad(toDisplayName(f.IOBJNM), 22)}${init}`.trimEnd());
      }
    }

    const sliceRanges = ranges.filter((r) => r.DSNR === s.DSNR);
    if (sliceRanges.length > 0) {
      out.push(`  Selection (${sliceRanges.length}):`);
      for (const r of [...sliceRanges].sort((a, b) => Number(a.ENUM) - Number(b.ENUM))) {
        out.push(`    ${formatSelection(r, vars, 'LOWINT', 'HIGHINT')}`);
      }
    } else if (s.DSTYPE === 'S') {
      out.push('  Selection: (none — this slice selects everything)');
    }
  }

  return out.join('\n');
}
