import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChainTopology, inListBatches } from '../dist/tools/metadata_tables.js';

/** One RSPCCHAIN row. Only the columns the topology reads are filled. */
const row = (type, variante, startP, greenP, extra = {}) => ({
  TYPE: type,
  VARIANTE: variante,
  EVENT_START: startP ? 'RSPROCESS' : '',
  EVENTP_START: startP ?? '',
  EVENT_GREEN: greenP ? 'RSPROCESS' : '',
  EVENTP_GREEN: greenP ?? '',
  EVENT_RED: '',
  EVENTP_RED: '',
  GREEN_EQ_RED: '',
  ...extra,
});

/** Trigger fans out to A and B, both join a collector, which feeds the last step. */
const FANOUT = [
  row('TRIGGER', 'START', null, 'E0'),
  row('ABAP', 'A', 'E0', 'EA'),
  row('ABAP', 'B', 'E0', 'EB'),
  row('AND', 'COLL', 'EA', 'EC'),
  row('AND', 'COLL', 'EB', 'EC'),
  row('ADSOACT', 'ACT', 'EC', null),
];

test('rows sharing type and variant are one step, not several', () => {
  const { steps } = buildChainTopology(FANOUT);
  assert.equal(steps.size, 5);
  assert.equal(steps.get('AND|COLL').rows.length, 2);
});

test('an edge runs from whoever raises an event to whoever waits for it', () => {
  const { predecessors } = buildChainTopology(FANOUT);
  assert.deepEqual(predecessors.get('ABAP|A').map((p) => p.key), ['TRIGGER|START']);
  assert.deepEqual(
    predecessors.get('AND|COLL').map((p) => p.key).sort(),
    ['ABAP|A', 'ABAP|B'],
  );
});

test('the collector is ordered after every branch it joins', () => {
  const { ordered } = buildChainTopology(FANOUT);
  assert.equal(ordered[0], 'TRIGGER|START');
  assert.ok(ordered.indexOf('AND|COLL') > ordered.indexOf('ABAP|A'));
  assert.ok(ordered.indexOf('AND|COLL') > ordered.indexOf('ABAP|B'));
  assert.equal(ordered.at(-1), 'ADSOACT|ACT');
  assert.equal(ordered.length, 5);
});

test('an on-error link is labelled as one', () => {
  const rows = [
    row('TRIGGER', 'START', null, 'E0'),
    { ...row('ABAP', 'A', 'E0', 'EA'), EVENT_RED: 'RSPROCESS', EVENTP_RED: 'ER' },
    row('ABAP', 'FAILPATH', 'ER', null),
  ];
  const { predecessors } = buildChainTopology(rows);
  assert.deepEqual(predecessors.get('ABAP|FAILPATH'), [{ key: 'ABAP|A', condition: 'on error' }]);
});

test('GREEN_EQ_RED makes the successor run either way', () => {
  const rows = [
    { ...row('TRIGGER', 'START', null, 'E0'), GREEN_EQ_RED: 'X' },
    row('ABAP', 'A', 'E0', null),
  ];
  const { predecessors } = buildChainTopology(rows);
  assert.equal(predecessors.get('ABAP|A')[0].condition, 'always');
});

test('a step whose start event nobody raises is a root, not a dangling edge', () => {
  const rows = [row('TRIGGER', 'START', null, 'E0'), row('ABAP', 'ORPHAN', 'EXTERNAL', null)];
  const { predecessors, ordered } = buildChainTopology(rows);
  assert.deepEqual(predecessors.get('ABAP|ORPHAN'), []);
  assert.equal(ordered.length, 2);
});

test('a cycle still yields every step instead of looping', () => {
  const rows = [row('ABAP', 'A', 'EB', 'EA'), row('ABAP', 'B', 'EA', 'EB')];
  const { ordered } = buildChainTopology(rows);
  assert.deepEqual(ordered.sort(), ['ABAP|A', 'ABAP|B']);
});

test('an IN list is split so the statement stays inside what DataPreview parses', () => {
  const names = Array.from({ length: 9 }, (_, i) => `VARIANT_NAME_NUMBER_${i}`);
  const batches = inListBatches(names, 150);
  assert.ok(batches.length > 1);
  for (const b of batches) assert.ok(b.length <= 150, `batch too long: ${b.length}`);
  // Nothing is dropped and nothing is duplicated.
  const rebuilt = batches.join(', ').split(', ').map((v) => v.replace(/'/g, ''));
  assert.deepEqual(rebuilt.sort(), [...names].sort());
});

test('a single name over budget still produces one batch rather than none', () => {
  assert.deepEqual(inListBatches(['A_VERY_LONG_VARIANT_NAME'], 5), ["'A_VERY_LONG_VARIANT_NAME'"]);
});

test('quotes in a value are escaped into the list', () => {
  assert.equal(inListBatches(["IT'S"], 150)[0], "'IT''S'");
});
