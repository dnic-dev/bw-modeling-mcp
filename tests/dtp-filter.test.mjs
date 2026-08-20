// Regression tests for the DTP filter selection transformation. Pure XML work — no BW system
// needed. Guards the failure mode from issue #5: a write that reports success while the
// document is unchanged, or while only the last of several values survived.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDtpFilterSelections, clearDtpFilterField, resolveFilterSelections } from '../dist/tools/dtp.js';

const OPERATORS =
  '<operators operator="Equal" including="true" excluding="true"/>' +
  '<operators operator="Between" including="true" excluding="true"/>' +
  '<operators operator="ContainsPattern" including="true" excluding="true"/>' +
  '<operators operator="NotEqual" including="true" excluding="true"/>' +
  '<operators operator="GreaterEqual" including="true"/>' +
  '<operators operator="LessThan" including="true"/>';

// FIELD_A: plain field, no selection yet, and no <routine/> element at all.
// FIELD_B: InfoObject-based field carrying a routine and one existing value.
const DTP_XML =
  '<dtpa:dataTransferProcess name="DTP_NAME"><filter>' +
  `<fields name="FIELD_A" dtaName="4PROVIDER-FIELD_A" description="Field A" filterSelection="X" field="true">${OPERATORS}</fields>` +
  '<fields name="FIELD_B" dtaName="0FIELD_B" description="Field B" filterSelection="X" selected="true" infoObjectType="CHA">' +
  '<routine><code>p_subrc = 0.</code></routine>' +
  '<selection excluding="false" operator="Equal"><low description="OLD" value="OLD"/></selection>' +
  `<infoObject name="0FIELD_B" description="InfoObject" tlogo="IOBJ"/>${OPERATORS}</fields>` +
  '</filter></dtpa:dataTransferProcess>';

const fieldBlock = (xml, field) =>
  xml.match(new RegExp(`<fields\\b[^>]*\\sname="${field}"[^>]*(?:/>|>[\\s\\S]*?</fields>)`))[0];

const selections = (xml, field) => [
  ...fieldBlock(xml, field).matchAll(/<selection\b([^>]*)(?:\/>|>([\s\S]*?)<\/selection>)/g),
].map((m) => ({
  operator: m[1].match(/\boperator="([^"]*)"/)?.[1],
  excluding: /excluding="true"/.test(m[1]),
  low: m[2]?.match(/<low[^>]*\svalue="([^"]*)"/)?.[1],
  high: m[2]?.match(/<high[^>]*\svalue="([^"]*)"/)?.[1],
}));

test('a value set is written in full, not reduced to one value', () => {
  const out = applyDtpFilterSelections(
    DTP_XML,
    'FIELD_A',
    [{ low: 'V1' }, { low: 'V2' }, { low: 'V3' }],
    'DTP_NAME'
  );
  assert.deepEqual(
    selections(out, 'FIELD_A').map((s) => s.low),
    ['V1', 'V2', 'V3']
  );
  assert.match(fieldBlock(out, 'FIELD_A'), /selected="true"/);
});

test('a field that never had a selection gets the routine element the server expects first', () => {
  const out = applyDtpFilterSelections(DTP_XML, 'FIELD_A', [{ low: 'V1' }], 'DTP_NAME');
  assert.match(fieldBlock(out, 'FIELD_A'), /^<fields[^>]*>\s*<routine\/>\s*<selection/);
});

test('operators, signs and ranges survive the round trip', () => {
  const out = applyDtpFilterSelections(
    DTP_XML,
    'FIELD_A',
    [
      { operator: 'Between', low: 'L', high: 'H' },
      { operator: 'ContainsPattern', low: 'P*' },
      { operator: 'NotEqual', sign: 'E', low: 'X' },
      { operator: 'GreaterEqual', low: 'G' },
    ],
    'DTP_NAME'
  );
  assert.deepEqual(selections(out, 'FIELD_A'), [
    { operator: 'Between', excluding: false, low: 'L', high: 'H' },
    { operator: 'ContainsPattern', excluding: false, low: 'P*', high: undefined },
    { operator: 'NotEqual', excluding: true, low: 'X', high: undefined },
    { operator: 'GreaterEqual', excluding: false, low: 'G', high: undefined },
  ]);
});

test('an existing routine is kept and stays the first child', () => {
  const out = applyDtpFilterSelections(DTP_XML, 'FIELD_B', [{ low: 'NEW' }], 'DTP_NAME');
  const block = fieldBlock(out, 'FIELD_B');
  assert.match(block, /^<fields[^>]*>\s*<routine><code>p_subrc = 0\.<\/code><\/routine>\s*<selection/);
  assert.deepEqual(selections(out, 'FIELD_B').map((s) => s.low), ['NEW']);
});

test('the empty string selects the BW initial value, without a bound', () => {
  const out = applyDtpFilterSelections(DTP_XML, 'FIELD_A', [{ low: '' }], 'DTP_NAME');
  assert.match(fieldBlock(out, 'FIELD_A'), /<selection excluding="false" operator="Equal"\/>/);
});

test('values are XML-escaped', () => {
  const out = applyDtpFilterSelections(DTP_XML, 'FIELD_A', [{ low: 'A&B' }], 'DTP_NAME');
  assert.match(fieldBlock(out, 'FIELD_A'), /value="A&amp;B"/);
  assert.doesNotMatch(fieldBlock(out, 'FIELD_A'), /value="A&B"/);
});

test('an unknown field is rejected instead of silently changing nothing', () => {
  assert.throws(
    () => applyDtpFilterSelections(DTP_XML, 'NO_SUCH_FIELD', [{ low: 'V' }], 'DTP_NAME'),
    /does not exist in DTP 'DTP_NAME'.*FIELD_A, FIELD_B/s
  );
});

test('an operator the field does not publish is rejected', () => {
  assert.throws(
    () => applyDtpFilterSelections(DTP_XML, 'FIELD_A', [{ operator: 'Contains', low: 'V' }], 'DTP_NAME'),
    /not supported for filter field 'FIELD_A'/
  );
});

test('excluding is rejected on an include-only operator', () => {
  assert.throws(
    () => applyDtpFilterSelections(DTP_XML, 'FIELD_A', [{ operator: 'LessThan', sign: 'E', low: 'V' }], 'DTP_NAME'),
    /cannot be used excluding/
  );
});

test('Between needs both bounds, and only Between takes a high value', () => {
  assert.throws(
    () => applyDtpFilterSelections(DTP_XML, 'FIELD_A', [{ operator: 'Between', low: 'L' }], 'DTP_NAME'),
    /requires both low and high/
  );
  assert.throws(
    () => applyDtpFilterSelections(DTP_XML, 'FIELD_A', [{ low: 'L', high: 'H' }], 'DTP_NAME'),
    /Only operator 'Between' takes a high value/
  );
});

test('clearing drops the values, keeps a routine, and deselects a field without one', () => {
  const withValues = applyDtpFilterSelections(DTP_XML, 'FIELD_A', [{ low: 'V1' }], 'DTP_NAME');
  const clearedA = clearDtpFilterField(withValues, 'FIELD_A', 'DTP_NAME');
  assert.deepEqual(selections(clearedA, 'FIELD_A'), []);
  assert.doesNotMatch(fieldBlock(clearedA, 'FIELD_A'), /selected="true"/);

  const clearedB = clearDtpFilterField(DTP_XML, 'FIELD_B', 'DTP_NAME');
  assert.deepEqual(selections(clearedB, 'FIELD_B'), []);
  assert.match(fieldBlock(clearedB, 'FIELD_B'), /selected="true"/);
  assert.match(fieldBlock(clearedB, 'FIELD_B'), /<routine>/);
});

test('filter_value carries a list, deduplicated, empty string preserved', () => {
  assert.deepEqual(
    resolveFilterSelections({ filter_field: 'FIELD_A', filter_value: 'V1, V2 ,V1' }),
    [
      { operator: 'Equal', sign: 'I', low: 'V1' },
      { operator: 'Equal', sign: 'I', low: 'V2' },
    ]
  );
  assert.deepEqual(
    resolveFilterSelections({ filter_field: 'FIELD_A', filter_value: '', filter_excluding: true }),
    [{ operator: 'Equal', sign: 'E', low: '' }]
  );
});

test('contradictory or incomplete filter arguments are rejected', () => {
  assert.throws(
    () => resolveFilterSelections({ filter_field: 'FIELD_A', filter_value: 'V', filter_selections: [{ low: 'W' }] }),
    /mutually exclusive/
  );
  assert.throws(
    () => resolveFilterSelections({ filter_value: 'V' }),
    /require filter_field/
  );
  assert.throws(
    () => resolveFilterSelections({ filter_field: 'FIELD_A' }),
    /without filter_value or filter_selections/
  );
  assert.throws(
    () => resolveFilterSelections({ filter_field: 'FIELD_A', filter_selections: [{ low: 'W' }], filter_excluding: true }),
    /filter_excluding applies to filter_value only/
  );
});

test('no filter arguments means no filter change', () => {
  assert.equal(resolveFilterSelections({ description: 'x' }), undefined);
});
