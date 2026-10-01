import { BwClient } from '../bw-client.js';
import { queryTable, sqlLiteral, formatStamp, type Row } from './metadata_sql.js';

/**
 * Query runtime statistics from the BW statistics tables (RSDDSTAT*), read through ADT
 * DataPreview.
 *
 * The BW statistics record one row per navigation step in RSDDSTATINFO (user, UTC start
 * stamp, runtime) and hang everything else off its STEPUID: RSDDSTATHEADER names the query
 * or provider of each runtime object, RSDDSTATEVDATA carries the time per OLAP event, and
 * RSDDSTATDM the data manager's share with the records read and transferred. The rows are
 * written when the step ends, so a call is findable immediately afterwards (verified on a
 * BW/4HANA system: the row was there on the first read after the call returned).
 *
 * Under principal propagation every call of this server runs as the calling user, so its
 * steps appear under that user like the steps of any other frontend. That is what makes a
 * call attributable: the server does not know the ABAP user name (it is derived in the
 * backend from the certificate), but it knows the object and the moment, and a statistics
 * step for that object inside that window is the call.
 *
 * OBJNAME holds the technical query name for a query and `$` + the provider name for a
 * direct provider call (verified on BW/4HANA for both).
 *
 * The DataPreview service parses at most 255 characters of statement, which is why every
 * statement below selects only the columns it needs and filters on one object name.
 * Statistics are only there for objects whose statistics level is switched on; an empty
 * answer says so rather than suggesting the object was never executed.
 */

// ── Timestamps ──────────────────────────────────────────────────────────────

/** `YYYYMMDDhhmmss` in UTC — the integer part of an RSDDSTATINFO-STARTTIME stamp. */
export function statStamp(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
  );
}

/** A stamp such as `20260929141455.0022400` as epoch milliseconds, or undefined. */
export function stampToMs(stamp: string | undefined): number | undefined {
  const m = (stamp ?? '').trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$/);
  if (!m) return undefined;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return ms + (m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0);
}

/**
 * Accepts what a caller is likely to type for a moment in time: an ISO string
 * (`2026-09-28T07:45:00Z`, a missing zone read as UTC) or a stamp (`20260928074500`).
 */
export function parseMoment(value: string): Date | undefined {
  const v = value.trim();
  if (/^\d{8}(\d{6})?$/.test(v)) {
    const ms = stampToMs(v.length === 8 ? `${v}000000` : v);
    return ms === undefined ? undefined : new Date(ms);
  }
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// ── Steps ───────────────────────────────────────────────────────────────────

export interface StatStep {
  stepUid: string;
  user: string;
  start: string;
  startMs: number | undefined;
  runtime: number;
}

/** The OBJNAME a statistics step carries for a query or a direct provider call. */
export function statObjectName(name: string, isProvider: boolean): string {
  const n = name.trim().toUpperCase().replace(/^!/, '');
  return isProvider ? `$${n}` : n;
}

/**
 * The statistics steps of one object inside a UTC window, newest first.
 *
 * One step has a header row per runtime object, so the join repeats a step once per OLAP
 * handle of the same object; rows are folded back to one per step.
 */
export async function findStatSteps(
  client: BwClient,
  objName: string,
  from: Date,
  to: Date,
  maxRows = 500,
): Promise<StatStep[]> {
  const sql =
    `SELECT i~stepuid,i~uname,i~starttime,i~runtime FROM rsddstatinfo AS i ` +
    `INNER JOIN rsddstatheader AS h ON h~stepuid = i~stepuid WHERE h~objname = '${sqlLiteral(objName)}' ` +
    `AND i~starttime BETWEEN ${statStamp(from)} AND ${statStamp(to)}`;
  const rows = await queryTable(client, sql, maxRows);
  const seen = new Map<string, StatStep>();
  for (const r of rows) {
    if (!r.STEPUID || seen.has(r.STEPUID)) continue;
    seen.set(r.STEPUID, {
      stepUid: r.STEPUID,
      user: r.UNAME ?? '',
      start: r.STARTTIME ?? '',
      startMs: stampToMs(r.STARTTIME),
      runtime: Number(r.RUNTIME ?? 0),
    });
  }
  return [...seen.values()].sort((a, b) => (b.startMs ?? 0) - (a.startMs ?? 0));
}

/** One step by its id, with the objects it ran on. */
export async function readStep(client: BwClient, stepUid: string): Promise<{ step?: StatStep; objects: Row[] }> {
  const uid = sqlLiteral(stepUid.trim());
  const info = await queryTable(
    client,
    `SELECT stepuid,uname,starttime,runtime FROM rsddstatinfo WHERE stepuid = '${uid}'`,
    1,
  );
  if (info.length === 0) return { objects: [] };
  const r = info[0];
  const objects = await queryTable(
    client,
    `SELECT handletp,infoprov,objname FROM rsddstatheader WHERE stepuid = '${uid}'`,
    50,
  );
  return {
    step: {
      stepUid: r.STEPUID,
      user: r.UNAME ?? '',
      start: r.STARTTIME ?? '',
      startMs: stampToMs(r.STARTTIME),
      runtime: Number(r.RUNTIME ?? 0),
    },
    objects,
  };
}

// ── Events ──────────────────────────────────────────────────────────────────

export interface StatEvent {
  handleType: string;
  eventId: number;
  text: string;
  time: number;
  count: number;
  /** Event property — for 3115 the effective "Operations in SAP HANA" mode. */
  prop: string;
}

export async function readStepEvents(client: BwClient, stepUid: string): Promise<StatEvent[]> {
  const rows = await queryTable(
    client,
    `SELECT e~handletp,e~eventid,e~evtime,e~evcount,e~evprop,t~txtlg FROM rsddstatevdata AS e ` +
      `LEFT OUTER JOIN rsddstateventst AS t ON t~eventid = e~eventid AND t~langu = 'E' ` +
      `WHERE e~stepuid = '${sqlLiteral(stepUid.trim())}'`,
    500,
  );
  return rows.map((r) => ({
    handleType: r.HANDLETP ?? '',
    eventId: Number(r.EVENTID ?? 0),
    text: r.TXTLG ?? '',
    time: Number(r.EVTIME ?? 0),
    count: Number(r.EVCOUNT ?? 0),
    prop: (r.EVPROP ?? '').trim(),
  }));
}

/**
 * Fixed values of domain RSRTREXOPS, the query property "Operations in SAP HANA" as RSRT
 * shows it. Event 3115 carries the mode a step actually ran with in EVPROP, not in EVCOUNT.
 */
export const HANA_OPERATIONS: Record<string, string> = {
  '0': 'no optimized operations in SAP HANA',
  '2': 'individual access per InfoProvider',
  '3': 'optimized access',
  '6': 'exception aggregation in SAP HANA',
  '7': 'formulas calculated in SAP HANA',
  '8': 'formulas calculated in SAP HANA, with complex currency/unit',
  '9': 'conditions calculated in SAP HANA',
  J: 'defensive',
  M: 'standard',
  P: 'offensive',
};

/**
 * The layer an OLAP event belongs to, by its id range (domain RSSTA_EVENTN; texts in
 * RSDDSTATEVENTST). The ranges follow SAP's numbering: 25xx cache, 3xxx OLAP processor,
 * 4xxx analysis authorizations, 9xxx data manager, 13xxx the BICS provider layer.
 */
export function eventCategory(eventId: number): string {
  if (eventId === 0) return 'Not assigned';
  // Event 1 is time the step spent waiting on the front end or the user, not BW work.
  if (eventId === 1) return 'Waiting for front end/user';
  if (eventId === 3200) return 'Transfer to front end';
  if (eventId >= 2500 && eventId < 2600) return 'OLAP cache';
  if (eventId >= 3000 && eventId < 4000) return 'OLAP processor';
  if (eventId >= 4000 && eventId < 5000) return 'Authorizations';
  if (eventId >= 9000 && eventId < 10000) return 'Data manager (database)';
  if (eventId >= 13000 && eventId < 14000) return 'BICS provider';
  return 'Other';
}

/** Events that count something rather than time it — reported as counts, never as time. */
const COUNT_EVENTS: Record<number, string> = {
  9010: 'records transferred (DBTRANS)',
  9011: 'records read (DBSEL)',
  2525: 'cache read accesses',
};

export interface CategoryTotal {
  category: string;
  time: number;
}

export function categoryTotals(events: StatEvent[]): CategoryTotal[] {
  const totals = new Map<string, number>();
  for (const e of events) {
    if (COUNT_EVENTS[e.eventId] !== undefined) continue;
    const c = eventCategory(e.eventId);
    totals.set(c, (totals.get(c) ?? 0) + e.time);
  }
  // A layer that took no measurable time says nothing and only lengthens the answer.
  return [...totals.entries()]
    .map(([category, time]) => ({ category, time }))
    .filter((c) => c.time >= 0.0005)
    .sort((a, b) => b.time - a.time);
}

// ── Data manager ────────────────────────────────────────────────────────────

export async function readStepDataManager(client: BwClient, stepUid: string): Promise<Row[]> {
  return queryTable(
    client,
    `SELECT infoprov,partprov,timedmprep,timeread,timesid,timenavattr,timehierarchy,` +
      `timedmpost,dbsel,dbtrans FROM rsddstatdm WHERE stepuid = '${sqlLiteral(stepUid.trim())}'`,
    200,
  );
}

// ── Rendering ───────────────────────────────────────────────────────────────

export function secs(value: number): string {
  return `${value.toFixed(3)} s`;
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(0).padStart(3)} %` : '';
}

function num(value: string | number | undefined): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('en-US') : String(value ?? '');
}

/**
 * The event and data manager breakdown of one step, as lines.
 *
 * Event times can overlap — a BICS event encloses the OLAP work it triggers — so the sum
 * of all events may exceed the step runtime. Shares are therefore given against the step
 * runtime, and the sum is stated separately rather than presented as a total.
 */
export function renderStepDetail(
  step: StatStep,
  events: StatEvent[],
  dm: Row[],
  topEvents = 8,
): string[] {
  const out: string[] = [];
  const timed = events.filter((e) => COUNT_EVENTS[e.eventId] === undefined);
  const sum = timed.reduce((s, e) => s + e.time, 0);

  out.push(`  BW runtime:     ${secs(step.runtime)}   (step ${step.stepUid}, user ${step.user || '?'}, ` +
    `start ${formatStamp(step.start)} UTC)`);

  const cats = categoryTotals(events);
  if (cats.length > 0) {
    out.push('  By layer:');
    for (const c of cats) {
      out.push(`    ${c.category.padEnd(26)} ${secs(c.time).padStart(11)}  ${pct(c.time, step.runtime)}`);
    }
    out.push(`    (event times overlap; their sum is ${secs(sum)} against a step runtime of ${secs(step.runtime)})`);
  }

  const top = [...timed].sort((a, b) => b.time - a.time).slice(0, topEvents).filter((e) => e.time > 0);
  if (top.length > 0) {
    out.push('  Top events:');
    for (const e of top) {
      out.push(`    ${String(e.eventId).padStart(5)}  ${secs(e.time).padStart(11)}  ${e.text || eventCategory(e.eventId)}`);
    }
  }

  const counts = events.filter((e) => COUNT_EVENTS[e.eventId] !== undefined);
  if (counts.length > 0) {
    out.push(`  Counts:         ${counts.map((e) => `${num(e.count)} ${COUNT_EVENTS[e.eventId]}`).join(', ')}`);
  }

  // 3115 records how "operations in HANA" were effectively executed — the first thing to
  // check when a query is slow, and otherwise only visible in RSRT.
  const hana = events.find((e) => e.eventId === 3115);
  if (hana) {
    const mode = hana.prop
      ? `${hana.prop} — ${HANA_OPERATIONS[hana.prop] ?? 'not a value of RSRTREXOPS'}`
      : 'not recorded';
    out.push(`  HANA operations (event 3115): ${mode}`);
  }

  if (dm.length > 0) {
    out.push('  Data manager:');
    for (const d of dm) {
      const part = d.PARTPROV && d.PARTPROV !== d.INFOPROV ? ` / ${d.PARTPROV}` : '';
      const read = Number(d.TIMEREAD ?? 0);
      const other =
        Number(d.TIMEDMPREP ?? 0) + Number(d.TIMESID ?? 0) + Number(d.TIMENAVATTR ?? 0) +
        Number(d.TIMEHIERARCHY ?? 0) + Number(d.TIMEDMPOST ?? 0);
      out.push(
        `    ${(d.INFOPROV || '?') + part}: read ${secs(read)}, prep/SID/nav/hier/post ${secs(other)}, ` +
          `${num(d.DBSEL)} records selected, ${num(d.DBTRANS)} transferred`,
      );
    }
  }
  return out;
}

// ── Distribution ────────────────────────────────────────────────────────────

/** Nearest-rank percentile over an ascending list. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function describeRuntimes(values: number[]): string {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return 'no steps';
  return `n=${s.length}, min ${secs(s[0])}, median ${secs(percentile(s, 50))}, ` +
    `p90 ${secs(percentile(s, 90))}, max ${secs(s[s.length - 1])}`;
}

// ── Correlation of one call ─────────────────────────────────────────────────

/**
 * The statistics of a call this server just made, found by object and window.
 *
 * The window runs from a few seconds before the request left to a few seconds after the
 * answer arrived, to absorb clock skew between this host and the application server. Where
 * that finds nothing the window is widened once; a step found only then is marked as such.
 * Several steps of the same object in the window (another user running the same query at the
 * same moment) are all listed, with their user, rather than one being picked silently.
 */
export async function correlateCall(
  client: BwClient,
  objName: string,
  requestStart: Date,
  responseEnd: Date,
  httpSeconds: number,
): Promise<string[]> {
  const out: string[] = ['', `── BW statistics (${objName}) ──`];
  let steps: StatStep[];
  let widened = false;
  try {
    const pad = 5_000;
    steps = await findStatSteps(
      client,
      objName,
      new Date(requestStart.getTime() - pad),
      new Date(responseEnd.getTime() + pad),
      20,
    );
    if (steps.length === 0) {
      widened = true;
      steps = await findStatSteps(
        client,
        objName,
        new Date(requestStart.getTime() - 60_000),
        new Date(responseEnd.getTime() + 60_000),
        20,
      );
    }
  } catch (err) {
    out.push(`  not readable: ${(err as Error).message}`);
    out.push('  (the statistics are read through ADT DataPreview; the user needs read access to the RSDDSTAT* tables)');
    return out;
  }

  if (steps.length === 0) {
    out.push('  no statistics step found for this call.');
    out.push('  Either the statistics are switched off for this object (statistics level, RSDDSTAT_DATA_PROP / ');
    out.push('  transaction RSDDSTAT), or the clocks of this host and the BW server differ by more than a minute.');
    return out;
  }

  if (widened) out.push('  (found only in a widened ±60 s window — check the clock of this host against the BW server)');
  if (steps.length > 1) {
    out.push(`  ${steps.length} steps of this object in the window — listed all, the call is one of them:`);
    for (const s of steps) out.push(`    ${s.stepUid}  ${s.user.padEnd(12)}  ${formatStamp(s.start)}  ${secs(s.runtime)}`);
  }

  // Detail for the steps of the window, at most three: a single call normally is one step,
  // a call that needed a retry leaves two.
  for (const step of steps.slice(0, 3)) {
    try {
      const [events, dm] = [await readStepEvents(client, step.stepUid), await readStepDataManager(client, step.stepUid)];
      out.push(...renderStepDetail(step, events, dm));
    } catch (err) {
      out.push(`  ${step.stepUid}: runtime ${secs(step.runtime)}; breakdown not readable (${(err as Error).message})`);
    }
  }

  if (steps.length === 1) {
    const bw = steps[0].runtime;
    out.push(
      `  Split:          BW ${secs(bw)} | network, Cloud Connector and XML transfer ${secs(Math.max(0, httpSeconds - bw))}` +
        ` (HTTP ${secs(httpSeconds)} minus BW runtime)`,
    );
  }
  return out;
}

// ── bw_query_statistics ─────────────────────────────────────────────────────

export interface QueryStatisticsArgs {
  step_uid?: string;
  comp_id?: string;
  is_provider?: boolean;
  from?: string;
  to?: string;
  user?: string;
  top?: number;
}

/**
 * Statistics for one step, or the distribution over the steps of one query or provider in a
 * time window, with the breakdown of the slowest ones.
 */
export async function bwQueryStatistics(client: BwClient, args: QueryStatisticsArgs): Promise<string> {
  if (args.step_uid) {
    const { step, objects } = await readStep(client, args.step_uid);
    if (!step) return `No statistics step ${args.step_uid} (deleted by the statistics housekeeping, or a mistyped id).`;
    const lines = [`Statistics step ${step.stepUid}`];
    // A query with two OLAP handles (e.g. two structures) has a header row per handle; name it once.
    const objs = [...new Set(
      objects.filter((o) => o.OBJNAME || o.INFOPROV).map((o) => `${o.OBJNAME || o.INFOPROV} [${o.HANDLETP}]`),
    )];
    if (objs.length > 0) lines.push(`  Objects:        ${objs.join(', ')}`);
    const [events, dm] = [await readStepEvents(client, step.stepUid), await readStepDataManager(client, step.stepUid)];
    lines.push(...renderStepDetail(step, events, dm, 15));
    return lines.join('\n');
  }

  if (!args.comp_id) throw new Error('Pass step_uid, or comp_id with a time window (from, to).');
  const to = args.to ? parseMoment(args.to) : new Date();
  const from = args.from ? parseMoment(args.from) : new Date((to ?? new Date()).getTime() - 24 * 3600_000);
  if (!from || !to) throw new Error('from/to must be ISO timestamps (UTC unless a zone is given) or YYYYMMDDhhmmss.');
  if (to.getTime() <= from.getTime()) throw new Error('to must lie after from.');

  const objName = statObjectName(args.comp_id, args.is_provider ?? false);
  let steps = await findStatSteps(client, objName, from, to, 2000);
  const user = args.user?.trim().toUpperCase();
  if (user) steps = steps.filter((s) => s.user === user);

  const lines = [
    `Statistics for ${objName}${user ? `, user ${user}` : ''}, ${formatStamp(statStamp(from))} – ` +
      `${formatStamp(statStamp(to))} UTC`,
  ];
  if (steps.length === 0) {
    lines.push('  no steps. Either the object did not run in this window, or its statistics are switched off');
    lines.push(`  (statistics level per object: RSDDSTAT_DATA_PROP / transaction RSDDSTAT). ` +
      `${args.is_provider ? '' : 'For a direct provider call pass is_provider=true.'}`);
    return lines.join('\n');
  }
  if (steps.length >= 2000) lines.push('  (capped at 2000 steps — narrow the window for a complete distribution)');

  lines.push(`  Runtime:        ${describeRuntimes(steps.map((s) => s.runtime))}`);
  const byUser = new Map<string, number>();
  for (const s of steps) byUser.set(s.user, (byUser.get(s.user) ?? 0) + 1);
  if (!user && byUser.size > 1) {
    lines.push(`  Users:          ${[...byUser.entries()].sort((a, b) => b[1] - a[1]).map(([u, n]) => `${u} (${n})`).join(', ')}`);
  }

  const top = Math.min(Math.max(args.top ?? 3, 1), 10);
  const slowest = [...steps].sort((a, b) => b.runtime - a.runtime).slice(0, top);
  lines.push('', `── Slowest ${slowest.length} ──`);
  const layerSums = new Map<string, number>();
  for (const s of slowest) {
    lines.push('');
    const [events, dm] = [await readStepEvents(client, s.stepUid), await readStepDataManager(client, s.stepUid)];
    lines.push(...renderStepDetail(s, events, dm));
    for (const c of categoryTotals(events)) layerSums.set(c.category, (layerSums.get(c.category) ?? 0) + c.time);
  }
  if (slowest.length > 1) {
    const rt = slowest.reduce((a, s) => a + s.runtime, 0);
    lines.push('', `── Layers over the ${slowest.length} slowest ──`);
    for (const [c, t] of [...layerSums.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${c.padEnd(26)} ${secs(t / slowest.length).padStart(11)} avg  ${pct(t, rt)}`);
    }
  }
  lines.push('', 'Step ids feed bw_query_statistics(step_uid=…) for the full event list.');
  return lines.join('\n');
}
