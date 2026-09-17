import type { BwClient } from '../bw-client.js';
import {
  queryTable,
  sqlLiteral,
  formatStamp,
  durationSeconds,
  inListBatches,
  type Row,
} from './metadata_sql.js';

/**
 * Read process chain *runs* from their log tables.
 *
 * The chain definition has its own route already (`object_type="RSPC"`); this is the
 * execution history. On BW/4HANA it comes from the RV_C_PCM* OData services, which a classic
 * release does not register at all, so the three monitoring tools are hidden there and this
 * is what answers the same question.
 *
 * Read-only: a run is a fact about the past, and the log tables are where BW records it.
 */

// ── Status decoding ─────────────────────────────────────────────────────────

/**
 * RSPC_STATE, the status of a chain run and of each of its steps.
 *
 * Text *and* raw code, as with the load history: the letter is what the caller recognises
 * from RSPC and from every other tool, and a status this map does not know must stay visible
 * rather than be swallowed. The colour is what the monitor shows and what a reader asks about
 * first ("why is the chain red?").
 */
const CHAIN_STATES: Record<string, string> = {
  R: 'red    ended with errors',
  J: 'red    ended with job error',
  X: 'red    cancelled',
  G: 'green  successful',
  F: 'green  completed',
  A: 'yellow active',
  Y: 'yellow ready',
  Q: 'grey   released',
  P: 'grey   planned',
  S: 'grey   skipped at restart',
};

/** The width the status column is padded to, so the columns after it line up. */
const STATE_WIDTH = 30;

function stateText(code: string | undefined): string {
  const raw = (code ?? '').trim();
  if (!raw) return '?  undefined';
  const known = CHAIN_STATES[raw];
  return known ? `${raw}  ${known}` : `${raw}  unknown status code`;
}

/** Is this run status one that needs attention? Drives the marker in the list. */
function isRed(code: string | undefined): boolean {
  return ['R', 'J', 'X'].includes((code ?? '').trim());
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

// ── Shared reads ────────────────────────────────────────────────────────────

interface ChainRun {
  logId: string;
  chain: string;
  status: string;
  start: string;
  /** Raw start stamp, for the duration against the last step's end. */
  startStamp: string;
  synchronous: boolean;
}

/**
 * The runs of one chain, newest first.
 *
 * Ordered in the statement rather than in the client: a chain can have thousands of runs and
 * the row limit cuts whatever the database hands over first, so sorting afterwards would
 * describe an arbitrary sample as "the most recent runs".
 */
async function runsOfChain(client: BwClient, chain: string, limit: number): Promise<ChainRun[]> {
  const rows = await queryTable(
    client,
    `SELECT chain_id, log_id, datum, zeit, analyzed_status, reported_status, synchronous ` +
      `FROM rspclogchain WHERE chain_id = '${sqlLiteral(chain)}' ` +
      `ORDER BY datum DESCENDING, zeit DESCENDING`,
    limit,
  );
  return rows.map((r) => ({
    logId: r.LOG_ID,
    chain: r.CHAIN_ID,
    // ANALYZED_STATUS is the evaluated result of the run; REPORTED_STATUS is what was pushed
    // to a monitor and is empty on most systems. Falling back keeps a run readable either way.
    status: (r.ANALYZED_STATUS || r.REPORTED_STATUS || '').trim(),
    start: formatStamp(`${r.DATUM}${r.ZEIT}`),
    startStamp: `${r.DATUM}${r.ZEIT}`,
    synchronous: r.SYNCHRONOUS === 'X',
  }));
}

/** The steps of one run, in start order. */
async function stepsOfRun(client: BwClient, logId: string): Promise<Row[]> {
  const rows = await queryTable(
    client,
    `SELECT type, variante, instance, state, actual_state, starttimestamp, endtimestamp, ` +
      `job_count, event_start FROM rspcprocesslog WHERE log_id = '${sqlLiteral(logId)}'`,
    500,
  );
  // Sorted here, not in the statement: the key of RSPCPROCESSLOG is the batch job, so the
  // rows arrive in no useful order, and the start stamp is what "in order" means for a run.
  return [...rows].sort((a, b) => (a.STARTTIMESTAMP || '').localeCompare(b.STARTTIMESTAMP || ''));
}

/** Variant descriptions for the steps of a run, in one statement per batch. */
async function variantTexts(client: BwClient, variants: string[]): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  const unique = [...new Set(variants.filter(Boolean))];
  if (unique.length === 0) return texts;
  for (const batch of inListBatches(unique, 120)) {
    try {
      const rows = await queryTable(
        client,
        `SELECT variante, langu, txtlg FROM rspcvariantt WHERE variante IN (${batch})`,
        200,
      );
      for (const r of rows.filter((r) => r.LANGU === 'E')) texts.set(r.VARIANTE, r.TXTLG);
      for (const r of rows) if (!texts.has(r.VARIANTE)) texts.set(r.VARIANTE, r.TXTLG);
    } catch {
      // A description is an enrichment; the technical name identifies the step.
    }
  }
  return texts;
}

/** The end of a run is the end of its last step — RSPCLOGCHAIN records only the start. */
function runEnd(steps: Row[]): string {
  return steps.reduce((latest, s) => {
    const end = (s.ENDTIMESTAMP ?? '').trim();
    return end && end > latest ? end : latest;
  }, '');
}

function formatSteps(steps: Row[], texts: Map<string, string>, indent = '  '): string[] {
  const out: string[] = [];
  if (steps.length === 0) {
    out.push(`${indent}(no steps logged for this run)`);
    return out;
  }
  out.push(`${indent}STATUS                          START                 DURATION   STEP`);
  for (const s of steps) {
    const duration = durationSeconds(s.STARTTIMESTAMP, s.ENDTIMESTAMP);
    // ACTUAL_STATE is what the step ended as, STATE what the chain recorded for it; they
    // differ after a manual repair, and hiding that would misreport a repaired run.
    const state = (s.ACTUAL_STATE || s.STATE || '').trim();
    out.push(
      `${indent}${pad(stateText(state), STATE_WIDTH)}  ${pad(formatStamp(s.STARTTIMESTAMP), 19)}  ` +
        `${pad(duration, 9)}  ${s.TYPE}`,
    );
    const text = texts.get(s.VARIANTE);
    out.push(`${indent}  variant: ${s.VARIANTE}${text ? ` — ${text}` : ''}`);
    if (s.STATE && s.ACTUAL_STATE && s.STATE !== s.ACTUAL_STATE) {
      out.push(`${indent}  recorded as ${stateText(s.STATE)} — differs from the actual state`);
    }
  }
  return out;
}

// ── Run history of one chain ────────────────────────────────────────────────

const HISTORY_LIMIT = 15;

export async function readChainRuns(client: BwClient, chainName: string): Promise<string> {
  const chain = chainName.trim().toUpperCase();
  const runs = await runsOfChain(client, chain, HISTORY_LIMIT);

  const out: string[] = [];
  out.push(`Process Chain Runs: ${chain}`);
  out.push('Source: metadata tables (read-only — the route for a system that does not register');
  out.push('        the RV_C_PCM* monitoring services; the chain definition is object_type="RSPC")');

  const [text] = await queryTable(
    client,
    `SELECT txtlg, langu FROM rspcchaint WHERE chain_id = '${sqlLiteral(chain)}'`,
    20,
  ).catch(() => [] as Row[]);
  if (text?.TXTLG) out.push(`Description:        ${text.TXTLG.trim()}`);

  if (runs.length === 0) {
    out.push('');
    out.push(`No runs recorded for ${chain} (no entry in RSPCLOGCHAIN). Either the chain has`);
    out.push('never run, or its logs have been deleted by the housekeeping job.');
    return out.join('\n');
  }

  // The newest run is what a caller asks about, so its steps come with the history rather
  // than costing a second call for the case that is almost always the interesting one.
  const newest = runs[0];
  const steps = await stepsOfRun(client, newest.logId);
  const texts = await variantTexts(client, steps.map((s) => s.VARIANTE));

  out.push('');
  out.push(`── Runs (${runs.length}, newest first) ──`);
  out.push('  STATUS                          START                 DURATION   LOG ID');
  for (const run of runs) {
    const end = run.logId === newest.logId ? runEnd(steps) : '';
    const duration = end ? durationSeconds(`${run.startStamp}`, end) : '';
    out.push(
      `  ${isRed(run.status) ? '!' : ' '}${pad(stateText(run.status), STATE_WIDTH - 1)}  ` +
        `${pad(run.start, 19)}  ${pad(duration, 9)}  ${run.logId}`,
    );
  }
  if (runs.length === HISTORY_LIMIT) {
    out.push(`  (capped at ${HISTORY_LIMIT} — older runs exist)`);
  }
  out.push('');
  out.push('Duration is only computed for the run whose steps were read; the log header records');
  out.push('the start, and the end is the end of the last step.');

  out.push('');
  out.push(`── Steps of the newest run (${newest.logId}) ──`);
  out.push(...formatSteps(steps, texts));
  out.push('');
  out.push('For an older run, pass its log id as object_name instead of the chain name.');

  return out.join('\n');
}

// ── One run in detail ───────────────────────────────────────────────────────

export async function readChainRunDetail(client: BwClient, logId: string, header: Row): Promise<string> {
  const steps = await stepsOfRun(client, logId);
  const texts = await variantTexts(client, steps.map((s) => s.VARIANTE));
  const status = (header.ANALYZED_STATUS || header.REPORTED_STATUS || '').trim();
  const start = `${header.DATUM}${header.ZEIT}`;
  const end = runEnd(steps);

  const out: string[] = [];
  out.push(`Process Chain Run: ${header.CHAIN_ID}`);
  out.push('Source: metadata tables (read-only — the route for a system that does not register');
  out.push('        the RV_C_PCM* monitoring services)');
  out.push(`Log ID:      ${logId}`);
  out.push(`Status:      ${stateText(status)}`);
  out.push(`Started:     ${formatStamp(start)}`);
  if (end) {
    out.push(`Ended:       ${formatStamp(end)}`);
    out.push(`Duration:    ${durationSeconds(start, end) || '(not computable)'}`);
  }
  if (header.SYNCHRONOUS === 'X') out.push('Mode:        synchronous');
  if (header.MANUAL_ABORT === 'X') out.push('Note:        manually aborted');

  out.push('');
  out.push(`── Steps (${steps.length}, in start order) ──`);
  out.push(...formatSteps(steps, texts));

  const failed = steps.filter((s) => isRed(s.ACTUAL_STATE || s.STATE));
  if (failed.length > 0) {
    out.push('');
    out.push(`${failed.length} step(s) did not end green: ${failed.map((s) => s.TYPE).join(', ')}.`);
    out.push('The message log of a step is an application log (BAL) and is not readable through');
    out.push('table access — open it in RSPC, or read the load history of the target instead.');
  }

  return out.join('\n');
}

// ── Last status per chain ───────────────────────────────────────────────────

const PATTERN_CHAIN_LIMIT = 30;

/**
 * The most recent run of every chain matching a pattern.
 *
 * One statement per chain rather than one big read over RSPCLOGCHAIN: the row limit would cut
 * an unordered result, and "the last status of these chains" computed from an arbitrary slice
 * is exactly the kind of answer that looks complete and is not.
 */
export async function readChainLastStatus(client: BwClient, pattern: string): Promise<string> {
  const like = sqlLiteral(pattern.trim().toUpperCase().replace(/\*/g, '%'));
  const chains = await queryTable(
    client,
    `SELECT chain_id FROM rspcchainattr WHERE chain_id LIKE '${like}' AND objvers = 'A' ` +
      `ORDER BY chain_id ASCENDING`,
    PATTERN_CHAIN_LIMIT + 1,
  );

  const out: string[] = [];
  out.push(`Process Chain Last Status: ${pattern.trim().toUpperCase()}`);
  out.push('Source: metadata tables (read-only — the route for a system that does not register');
  out.push('        the RV_C_PCM* monitoring services)');

  if (chains.length === 0) {
    out.push('');
    out.push(`No active chain matches ${pattern} (RSPCCHAINATTR). Wildcards: * for any sequence.`);
    return out.join('\n');
  }

  const capped = chains.length > PATTERN_CHAIN_LIMIT;
  const names = chains.slice(0, PATTERN_CHAIN_LIMIT).map((c) => c.CHAIN_ID);

  out.push('');
  out.push(`── Last run per chain (${names.length}) ──`);
  out.push('  STATUS                          START                 CHAIN');
  for (const name of names) {
    // Sequential, one chain at a time: these are POSTs against DataPreview, and several in
    // flight cost a retried CSRF token or a dropped connection.
    const [run] = await runsOfChain(client, name, 1).catch(() => []);
    if (!run) {
      out.push(`  ${pad('-  never run', STATE_WIDTH - 1)}  ${pad('', 19)}  ${name}`);
      continue;
    }
    out.push(
      `  ${isRed(run.status) ? '!' : ' '}${pad(stateText(run.status), STATE_WIDTH - 1)}  ` +
        `${pad(run.start, 19)}  ${name}`,
    );
  }

  if (capped) {
    out.push('');
    out.push(`More than ${PATTERN_CHAIN_LIMIT} chains match — narrow the pattern to see the rest.`);
  }
  out.push('');
  out.push('A "!" marks a run that ended red. For its steps, pass the chain name as object_name.');

  return out.join('\n');
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * One object type for three questions, told apart by what the name turns out to be rather
 * than by its shape: a log id is looked up in RSPCLOGCHAIN, and only a name that is not one
 * is treated as a chain. Guessing from the form would be wrong for a 25-character chain name,
 * which RSPC_CHAIN allows.
 */
export async function readChainLog(client: BwClient, name: string): Promise<string> {
  const value = name.trim();
  if (value.includes('*')) return readChainLastStatus(client, value);

  const upper = value.toUpperCase();
  if (/^[A-Z0-9]{25}$/.test(upper)) {
    const [header] = await queryTable(
      client,
      `SELECT chain_id, log_id, datum, zeit, analyzed_status, reported_status, synchronous, ` +
        `manual_abort FROM rspclogchain WHERE log_id = '${sqlLiteral(upper)}'`,
      1,
    );
    if (header) return readChainRunDetail(client, upper, header);
  }

  return readChainRuns(client, upper);
}
