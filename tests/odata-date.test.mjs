// Regression tests for OData V2 verbose date parsing in the process-chain monitor.
// Pure string work — no BW system needed. The offset form is what these services actually
// return for every timestamp field; without it in the pattern the raw `/Date(…)/` string
// reached the tool output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { odataDateToIso } from '../dist/tools/process_chain_monitor.js';

test('a date without an offset parses as before', () => {
  assert.equal(odataDateToIso('/Date(1734393600000)/'), '2024-12-17T00:00:00.000Z');
});

test('the offset suffix is tolerated and does not shift the result', () => {
  assert.equal(odataDateToIso('/Date(1734439809000+0000)/'), '2024-12-17T12:50:09.000Z');
  // Same instant, different declared local time — the epoch ms are UTC either way.
  assert.equal(
    odataDateToIso('/Date(1734439809000+0120)/'),
    odataDateToIso('/Date(1734439809000)/'),
  );
  assert.equal(
    odataDateToIso('/Date(1734439809000-0500)/'),
    odataDateToIso('/Date(1734439809000)/'),
  );
});

// The spec counts the offset in minutes, so its digit count is not fixed at four.
test('an offset of any digit count is tolerated', () => {
  for (const suffix of ['+0', '+60', '+120', '+0000', '-0000']) {
    assert.equal(odataDateToIso(`/Date(1734439809000${suffix})/`), '2024-12-17T12:50:09.000Z');
  }
});

test('dates before the epoch keep their sign', () => {
  assert.equal(odataDateToIso('/Date(-86400000+0000)/'), '1969-12-31T00:00:00.000Z');
});

test('an empty or unparseable value is passed through untouched', () => {
  assert.equal(odataDateToIso(undefined), undefined);
  assert.equal(odataDateToIso(''), undefined);
  assert.equal(odataDateToIso('2024-12-17T13:30:09Z'), '2024-12-17T13:30:09Z');
  assert.equal(odataDateToIso('/Date(not-a-number)/'), '/Date(not-a-number)/');
});
