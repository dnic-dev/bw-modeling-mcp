import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  statStamp,
  stampToMs,
  parseMoment,
  statObjectName,
  eventCategory,
  categoryTotals,
  percentile,
  describeRuntimes,
  findStatSteps,
  correlateCall,
  bwQueryStatistics,
} from '../dist/tools/query_statistics.js';
import { renderQueryDataText, isSubtotalRow, renderTiming } from '../dist/tools/reporting.js';

// ── A DataPreview stand-in ───────────────────────────────────────────────────

/** The column-oriented XML the ADT DataPreview service answers with. */
function dataPreview(rows) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const blocks = cols.map((c) =>
    `<dataPreview:columns><dataPreview:metadata dataPreview:name="${c}"/><dataPreview:dataSet>` +
    rows.map((r) => (!r[c] ? '<dataPreview:data/>' : `<dataPreview:data>${r[c]}</dataPreview:data>`)).join('') +
    `</dataPreview:dataSet></dataPreview:columns>`,
  );
  return `<?xml version="1.0"?><dataPreview:tableData>${blocks.join('')}</dataPreview:tableData>`;
}

/** A client whose DataPreview answers are chosen by the table a statement reads. */
function fakeClient(tables) {
  const statements = [];
  return {
    statements,
    async getCsrfToken() { return 'token'; },
    clearCsrfToken() {},
    async rawPost(url, sql) {
      statements.push(sql);
      assert.ok(sql.length <= 255, `statement longer than DataPreview parses (${sql.length}): ${sql}`);
      // The DataPreview parser rejects `a=b` ("A Boolean expression was expected"), found live.
      assert.doesNotMatch(sql, /[^\s<>!]=|=[^\s]/, `comparison without blanks: ${sql}`);
      const table = Object.keys(tables).find((t) => new RegExp(`FROM ${t}\\b`, 'i').test(sql));
      return { body: dataPreview(table ? tables[table](sql) : []), headers: {} };
    },
  };
}

const STEP = '00O2TRT5FCT3S1MNLG1IRPJ40';

const EVENTS = [
  { HANDLETP: 'OLAP', EVENTID: '000009000', EVTIME: '0.220720', EVCOUNT: '0', TXTLG: 'Data Manager Event' },
  { HANDLETP: 'OLAP', EVENTID: '000003000', EVTIME: '0.142081', EVCOUNT: '0', TXTLG: 'OLAP: Settings' },
  { HANDLETP: 'DFLT', EVENTID: '000000000', EVTIME: '0.104101', EVCOUNT: '0', TXTLG: 'Global Event' },
  { HANDLETP: 'OLAP', EVENTID: '000003110', EVTIME: '0.083252', EVCOUNT: '0', TXTLG: 'OLAP: Data Selection' },
  { HANDLETP: 'DP', EVENTID: '000013052', EVTIME: '0.031877', EVCOUNT: '0', TXTLG: 'Set ABAP BICS Provider Status' },
  { HANDLETP: 'OLAP', EVENTID: '000002505', EVTIME: '0.007845', EVCOUNT: '0', TXTLG: 'Read Cache Entries' },
  { HANDLETP: 'OLAP', EVENTID: '000009010', EVTIME: '0.000000', EVCOUNT: '1', TXTLG: 'DBTRANS' },
  { HANDLETP: 'OLAP', EVENTID: '000009011', EVTIME: '0.000000', EVCOUNT: '42', TXTLG: 'DBSEL' },
  { HANDLETP: 'OLAP', EVENTID: '000003115', EVTIME: '0.000000', EVCOUNT: '0', EVPROP: '8', TXTLG: 'Operations in HANA' },
];

const DM = [{
  INFOPROV: 'YDSD020', PARTPROV: 'YDSD020', TIMEDMPREP: '0.01', TIMEREAD: '0.2', TIMESID: '0', TIMENAVATTR: '0',
  TIMEHIERARCHY: '0', TIMEDMPOST: '0.005', DBSEL: '42', DBTRANS: '1',
}];

// ── Timestamps ───────────────────────────────────────────────────────────────

test('a moment becomes the UTC stamp RSDDSTATINFO-STARTTIME is compared with', () => {
  assert.equal(statStamp(new Date('2026-09-29T14:14:55.002Z')), '20260929141455');
});

test('a statistics stamp keeps its fraction as milliseconds', () => {
  assert.equal(stampToMs('20260929141455.0022400'), Date.UTC(2026, 8, 29, 14, 14, 55, 2));
  assert.equal(stampToMs('garbage'), undefined);
});

test('a window bound is accepted as ISO or as stamp, and a zone-less ISO is UTC', () => {
  assert.equal(parseMoment('2026-09-28T07:45:00')?.toISOString(), '2026-09-28T07:45:00.000Z');
  assert.equal(parseMoment('2026-09-28T09:45:00+02:00')?.toISOString(), '2026-09-28T07:45:00.000Z');
  assert.equal(parseMoment('20260928074500')?.toISOString(), '2026-09-28T07:45:00.000Z');
  assert.equal(parseMoment('20260928')?.toISOString(), '2026-09-28T00:00:00.000Z');
  assert.equal(parseMoment('yesterday'), undefined);
});

test('a provider call is recorded as $ + name, a query under its own name', () => {
  assert.equal(statObjectName('ydsd020', true), '$YDSD020');
  assert.equal(statObjectName('!YDSD020', true), '$YDSD020');
  assert.equal(statObjectName('ZCSD008_Q001', false), 'ZCSD008_Q001');
});

// ── Events ───────────────────────────────────────────────────────────────────

test('events fall into their layer by id range', () => {
  assert.equal(eventCategory(0), 'Not assigned');
  assert.equal(eventCategory(1), 'Waiting for front end/user');
  assert.equal(eventCategory(2505), 'OLAP cache');
  assert.equal(eventCategory(3110), 'OLAP processor');
  assert.equal(eventCategory(3200), 'Transfer to front end');
  assert.equal(eventCategory(4600), 'Authorizations');
  assert.equal(eventCategory(9000), 'Data manager (database)');
  assert.equal(eventCategory(13052), 'BICS provider');
  assert.equal(eventCategory(7000), 'Other');
});

test('counting events never add to a layer time', () => {
  const events = EVENTS.map((e) => ({ eventId: Number(e.EVENTID), time: Number(e.EVTIME), count: Number(e.EVCOUNT) }));
  const totals = Object.fromEntries(categoryTotals(events).map((c) => [c.category, c.time]));
  assert.equal(totals['Data manager (database)'], 0.22072);
  assert.ok(Math.abs(totals['OLAP processor'] - 0.225333) < 1e-9);
  assert.equal(categoryTotals(events)[0].category, 'OLAP processor');
});

test('the distribution uses nearest-rank percentiles', () => {
  const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(s, 50), 5);
  assert.equal(percentile(s, 90), 9);
  assert.equal(percentile([], 50), 0);
  assert.match(describeRuntimes([3, 1, 2]), /n=3, min 1\.000 s, median 2\.000 s, p90 3\.000 s, max 3\.000 s/);
});

// ── Correlation ──────────────────────────────────────────────────────────────

test('steps of one object in a window are found by one short statement and folded per step', async () => {
  const client = fakeClient({
    rsddstatinfo: () => [
      { STEPUID: STEP, UNAME: 'ANALYST', STARTTIME: '20260929141455.0022400', RUNTIME: '0.763664' },
      // The same step again: one header row per OLAP handle.
      { STEPUID: STEP, UNAME: 'ANALYST', STARTTIME: '20260929141455.0022400', RUNTIME: '0.763664' },
    ],
  });
  const steps = await findStatSteps(
    client, statObjectName('A_THIRTY_CHARACTER_PROVIDER_NM', true),
    new Date('2026-09-29T14:14:50Z'), new Date('2026-09-29T14:15:00Z'),
  );
  assert.equal(steps.length, 1);
  assert.equal(steps[0].user, 'ANALYST');
  assert.match(client.statements[0], /objname = '\$A_THIRTY_CHARACTER_PROVIDER_NM'/);
  assert.match(client.statements[0], /BETWEEN 20260929141450 AND 20260929141500/);
});

test('a single step splits the HTTP time into BW runtime and transfer', async () => {
  const client = fakeClient({
    rsddstatinfo: () => [{ STEPUID: STEP, UNAME: 'ANALYST', STARTTIME: '20260929141455.0022400', RUNTIME: '0.763664' }],
    rsddstatevdata: () => EVENTS,
    rsddstatdm: () => DM,
  });
  const out = (await correlateCall(
    client, '$YDSD020', new Date('2026-09-29T14:14:54Z'), new Date('2026-09-29T14:14:57Z'), 2.5,
  )).join('\n');
  assert.match(out, /BW runtime: {5}0\.764 s/);
  assert.match(out, /OLAP processor/);
  assert.match(out, /42 records read \(DBSEL\)/);
  assert.match(out, /HANA operations \(event 3115\): 8 — formulas calculated in SAP HANA, with complex currency\/unit/);
  assert.match(out, /YDSD020: read 0\.200 s/);
  assert.match(out, /Split: {10}BW 0\.764 s \| network, Cloud Connector and XML transfer 1\.736 s/);
});

test('without a step the answer names the likely reasons instead of a zero', async () => {
  const client = fakeClient({ rsddstatinfo: () => [] });
  const out = (await correlateCall(client, 'ZQ', new Date(), new Date(), 1)).join('\n');
  assert.match(out, /no statistics step found/);
  assert.match(out, /switched off/);
  // Narrow window first, then the widened one.
  assert.equal(client.statements.length, 2);
});

test('several steps in the window are all listed with their user', async () => {
  const client = fakeClient({
    rsddstatinfo: () => [
      { STEPUID: 'A'.repeat(25), UNAME: 'USER1', STARTTIME: '20260929141455', RUNTIME: '1.0' },
      { STEPUID: 'B'.repeat(25), UNAME: 'USER2', STARTTIME: '20260929141456', RUNTIME: '2.0' },
    ],
    rsddstatevdata: () => [],
    rsddstatdm: () => [],
  });
  const out = (await correlateCall(client, 'ZQ', new Date(), new Date(), 3)).join('\n');
  assert.match(out, /2 steps of this object in the window/);
  assert.match(out, /USER1/);
  assert.match(out, /USER2/);
  assert.doesNotMatch(out, /Split:/);
});

test('the window mode reports the distribution and breaks down the slowest', async () => {
  const client = fakeClient({
    rsddstatinfo: () => [
      { STEPUID: 'A'.repeat(25), UNAME: 'USER1', STARTTIME: '20260928074530', RUNTIME: '60.28' },
      { STEPUID: 'B'.repeat(25), UNAME: 'USER1', STARTTIME: '20260928074630', RUNTIME: '59.77' },
      { STEPUID: 'C'.repeat(25), UNAME: 'USER2', STARTTIME: '20260928081000', RUNTIME: '12.00' },
    ],
    rsddstatevdata: () => EVENTS,
    rsddstatdm: () => DM,
  });
  const out = await bwQueryStatistics(client, {
    comp_id: 'ZCSD008_Q999', from: '2026-09-28T07:00:00Z', to: '2026-09-28T09:00:00Z', top: 2,
  });
  assert.match(out, /Statistics for ZCSD008_Q999, 2026-09-28 07:00:00 – 2026-09-28 09:00:00 UTC/);
  assert.match(out, /n=3, min 12\.000 s, median 59\.770 s/);
  assert.match(out, /USER1 \(2\), USER2 \(1\)/);
  assert.match(out, /── Slowest 2 ──/);
  assert.match(out, /── Layers over the 2 slowest ──/);
});

test('the window mode filters by user after reading, keeping statements short', async () => {
  const client = fakeClient({
    rsddstatinfo: () => [
      { STEPUID: 'A'.repeat(25), UNAME: 'USER1', STARTTIME: '20260928074530', RUNTIME: '1' },
      { STEPUID: 'B'.repeat(25), UNAME: 'USER2', STARTTIME: '20260928074630', RUNTIME: '2' },
    ],
    rsddstatevdata: () => [],
    rsddstatdm: () => [],
  });
  const out = await bwQueryStatistics(client, { comp_id: 'ZQ', user: 'user2', from: '20260928', to: '20260929' });
  assert.match(out, /n=1/);
  assert.doesNotMatch(client.statements[0], /uname=/i);
});

test('an unknown step id says so', async () => {
  const client = fakeClient({ rsddstatinfo: () => [] });
  assert.match(await bwQueryStatistics(client, { step_uid: 'X'.repeat(25) }), /No statistics step/);
});

test('the window mode refuses a reversed window', async () => {
  await assert.rejects(
    bwQueryStatistics(fakeClient({}), { comp_id: 'ZQ', from: '20260929', to: '20260928' }),
    /to must lie after from/,
  );
});

// ── Paging and subtotals in the rendered result ──────────────────────────────

function resultXml(rows) {
  const tuples = rows.map((r, i) =>
    `<tuple tid="${i}"><value id="1" sid="3" extKey="${r[0]}" intKey="${r[0]}" txt="${r[0]}"/>` +
    (r[1] === 'TOTAL'
      ? `<value id="2" sid="9" selType="TOTAL" extKey="SUMME" intKey="SUMME" txt="Result"/>`
      : `<value id="2" sid="2" extKey="${r[1]}" intKey="${r[1]}" txt="${r[1]}"/>`) +
    `</tuple>`).join('');
  const cells = rows.map((r, i) => `<cell crv="${r[2]}" txt="${r[2]}" row="${i + 1}" col="1"/>`).join('');
  return `<queryView name="!P"><resultSet fromRow="0" toRow="${rows.length}">` +
    `<columns><headers><entry name="KF" txt="KF" id="9"/></headers><tuples size="1"><tuple tid="-1">` +
    `<value id="9" sid="1" selType="STRU1" extKey="KF" intKey="KF" txt="Records"/></tuple></tuples></columns>` +
    `<rows><headers><entry name="A" txt="A" id="1"/><entry name="B" txt="B" id="2"/></headers>` +
    `<tuples size="${rows.length}">${tuples}</tuples></rows><data>${cells}</data></resultSet><messages/></queryView>`;
}

test('a row beyond the page says the result continues, and is not shown', () => {
  const xml = resultXml([['1000', '01', '10'], ['1000', '03', '20'], ['1000', 'TOTAL', '30']]);
  const out = renderQueryDataText(xml, false, { fromRow: 0, toRow: 2, pageSize: 2 });
  assert.match(out, /Row range: 0–2/);
  assert.match(out, /More rows: yes — continue with from_row=2/);
  assert.match(out, /Result \(2 rows/);
  assert.doesNotMatch(out, /\| 30/);
});

test('a short page says the result ends there', () => {
  const xml = resultXml([['1000', '01', '10']]);
  assert.match(renderQueryDataText(xml, false, { fromRow: 0, toRow: 5, pageSize: 5 }), /More rows: no/);
});

test('subtotals are left out on request, cells stay on their own rows', () => {
  const xml = resultXml([['1000', '01', '10'], ['1000', 'TOTAL', '10'], ['2000', '01', '5'], ['2000', 'TOTAL', '5']]);
  const out = renderQueryDataText(xml, false, { fromRow: 0, toRow: 10, pageSize: 10, suppressSubtotals: true });
  assert.match(out, /Subtotals: 2 subtotal rows suppressed/);
  assert.match(out, /1000 \/ 01 \| 10/);
  assert.match(out, /2000 \/ 01 \| 5/);
  assert.doesNotMatch(out, /Result \| /);
});

test('the overall result row is not a subtotal', () => {
  const total = { selType: 'TOTAL', intKey: 'SUMME' };
  const member = { selType: '', intKey: '1000' };
  assert.equal(isSubtotalRow([member, total]), true);
  assert.equal(isSubtotalRow([total, total]), false);
  assert.equal(isSubtotalRow([member, member]), false);
});

test('an empty result reports the requested range, not a fixed 0–1000', () => {
  const out = renderQueryDataText('<queryView name="!P"><resultSet/><messages/></queryView>', false,
    { fromRow: 0, toRow: 5, pageSize: 5 });
  assert.match(out, /Row range: 0–5/);
});

test('the timing block separates server, HTTP and CSRF time', () => {
  const lines = renderTiming({
    requestStart: new Date('2026-09-29T14:14:54Z'), responseEnd: new Date('2026-09-29T14:14:57Z'),
    csrfMs: 250, httpMs: 2500, attempts: 1, requestBytes: 9216, responseBytes: 409600,
  }, 2800, 20).join('\n');
  assert.match(lines, /Total in server: {2}2\.800 s/);
  assert.match(lines, /BW HTTP: {10}2\.500 s {2}\(1 attempt;/);
  assert.match(lines, /CSRF token: {7}0\.250 s/);
  assert.match(lines, /Server's own: {5}0\.050 s/);
  assert.match(lines, /9\.0 KB \/ 400\.0 KB/);
});

test('a layer without measurable time is left out', () => {
  const totals = categoryTotals([
    { eventId: 9000, time: 1.2, count: 0 },
    { eventId: 4300, time: 0, count: 0 },
  ]);
  assert.deepEqual(totals.map((t) => t.category), ['Data manager (database)']);
});

test('a query with two OLAP handles is named once among the objects', async () => {
  const client = fakeClient({
    rsddstatinfo: () => [{ STEPUID: STEP, UNAME: 'ANALYST', STARTTIME: '20260923103617', RUNTIME: '142.2' }],
    rsddstatheader: () => [
      { HANDLETP: 'OLAP', INFOPROV: 'ZCSD008', OBJNAME: 'ZCSD008_SAC_Q999' },
      { HANDLETP: 'OLAP', INFOPROV: 'ZCSD008', OBJNAME: 'ZCSD008_SAC_Q999' },
      { HANDLETP: 'CLNT', INFOPROV: '', OBJNAME: 'ANALYTICSCLOUD' },
    ],
    rsddstatevdata: () => [],
    rsddstatdm: () => [],
  });
  const out = await bwQueryStatistics(client, { step_uid: STEP });
  assert.match(out, /Objects: {8}ZCSD008_SAC_Q999 \[OLAP\], ANALYTICSCLOUD \[CLNT\]\n/);
});
