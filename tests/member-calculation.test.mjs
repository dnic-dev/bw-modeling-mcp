import test from 'node:test';
import assert from 'node:assert/strict';
import { XMLParser } from 'fast-xml-parser';
import { applyMemberProperties, RESULT_AS_VALUES, SINGLE_VALUES_AS_VALUES } from '../dist/tools/query_update.js';
import { parseMemberCalculation } from '../dist/tools/query.js';

// Element shape taken from a member the modeling tools saved with "calculate results as:
// hide" and a scaling of thousands; the literal sets were each written and read back on a
// classic release and on BW/4HANA.

const member = (inner = '') =>
  '<Qry:members xsi:type="Qry:MemberSelection" id="M1">' +
  '<Qry:description value="Member"/><Qry:calculation default="true"/><Qry:emphasize default="true"/>' +
  '<Qry:signInversion default="true"/><Qry:hidden default="true"/><Qry:scaling default="true"/>' +
  `<Qry:decimals default="true"/>${inner}` +
  '<Qry:groups infoObject="1KYFNM"><Qry:tokens/></Qry:groups></Qry:members>';

const calcOf = (xml) => xml.match(/<Qry:calculation\b[\s\S]*?(\/>|<\/Qry:calculation>)/)[0];

test('scaling is written as a power of ten and reset to the default element', () => {
  const scaled = applyMemberProperties(member(), { scaling: 3 }, '');
  assert.ok(scaled.includes('<Qry:scaling default="false" number="3"/>'));
  const reset = applyMemberProperties(scaled, { scaling: false }, '');
  assert.ok(reset.includes('<Qry:scaling default="true"/>'));
});

test('scaling outside 0-9 is refused', () => {
  assert.throws(() => applyMemberProperties(member(), { scaling: 10 }, ''), /between 0 and 9/);
  assert.throws(() => applyMemberProperties(member(), { scaling: 1.5 }, ''), /between 0 and 9/);
});

test('a calculation is written complete, the fields not given at their defaults', () => {
  const out = applyMemberProperties(member(), { calculation: { result_as: 'hide' } }, '');
  assert.equal(
    calcOf(out),
    '<Qry:calculation default="false" singleValuesAs="blank" resultAs="hide">' +
      '<Qry:cumulation>false</Qry:cumulation><Qry:applyToResult>false</Qry:applyToResult></Qry:calculation>'
  );
});

test('a partial calculation keeps the fields already set on the member', () => {
  const first = applyMemberProperties(member(), { calculation: { single_values_as: 'rankNumber', cumulation: true } }, '');
  const second = applyMemberProperties(first, { calculation: { result_as: 'average' } }, '');
  assert.deepEqual(
    parseMemberCalculation(new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(calcOf(second))['Qry:calculation']),
    { result_as: 'average', single_values_as: 'rankNumber', apply_to_result: false, cumulation: true }
  );
});

test('false restores the default calculation', () => {
  const set = applyMemberProperties(member(), { calculation: { result_as: 'hide' } }, '');
  assert.equal(calcOf(applyMemberProperties(set, { calculation: false }, '')), '<Qry:calculation default="true"/>');
});

test('literals outside the model are refused, including the correct spelling the model does not use', () => {
  assert.throws(() => applyMemberProperties(member(), { calculation: { result_as: 'minimum' } }, ''), /result_as must be one of/);
  assert.throws(() => applyMemberProperties(member(), { calculation: { single_values_as: 'mininum' } }, ''), /single_values_as must be one of/);
  assert.throws(() => applyMemberProperties(member(), { calculation: { result: 'hide' } }, ''), /Unknown calculation field/);
});

test('an unknown member property is refused instead of dropped', () => {
  assert.throws(() => applyMemberProperties(member(), { scale: 3 }, ''), /Unknown member property: scale/);
});

test('the literal sets match the domains they map to', () => {
  assert.equal(RESULT_AS_VALUES.length, 14);
  assert.equal(SINGLE_VALUES_AS_VALUES.length, 13);
});

test('the reader reports a calculation in the field names the writer takes', () => {
  assert.equal(parseMemberCalculation({ '@_default': 'true' }), undefined);
  assert.deepEqual(
    parseMemberCalculation({
      '@_default': 'false', '@_singleValuesAs': 'blank', '@_resultAs': 'hide',
      'Qry:applyToResult': false, 'Qry:cumulation': false,
    }),
    { result_as: 'hide', single_values_as: 'blank', apply_to_result: false, cumulation: false }
  );
});
