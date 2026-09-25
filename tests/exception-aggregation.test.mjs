import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XMLParser } from 'fast-xml-parser';
import { excAggEl, EXCEPTION_AGGREGATION_TYPES } from '../dist/tools/query_update.js';
import { parseExceptionAggregation, formatExceptionAggregation } from '../dist/tools/query.js';
import { setCkfExceptionAggregation } from '../dist/tools/elem_write.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (t) => t === 'Qry:referenceCharacteristic',
});
const readBack = (el) => parseExceptionAggregation(parser.parse(`<m>${el}</m>`).m);

test('the domain has sixteen literals and nothing outside it is written', () => {
  assert.equal(EXCEPTION_AGGREGATION_TYPES.length, 16);
  assert.throws(() => excAggEl({ type: 'MED', reference_characteristic: 'CHA' }), /Unknown exception aggregation type/);
  assert.throws(() => excAggEl({ type: 'SUM' }), /reference_characteristic/);
  assert.throws(
    () => excAggEl({ type: 'SUM', reference_characteristics: ['A', 'B', 'C', 'D', 'E', 'F'] }),
    /at most 5/
  );
});

test('what the writer emits reads back to the same object', () => {
  for (const ea of [
    { type: 'SUM', reference_characteristic: 'CHA_A' },
    { type: 'AV0', reference_characteristic: 'CHA_A', reference_characteristics: ['CHA_A', 'CHA_B'] },
    { type: 'CNT', reference_characteristic: 'CHA_A', exclude: true },
  ]) {
    assert.deepEqual(readBack(excAggEl(ea)), ea);
  }
});

test('literals and characteristics are normalised to upper case', () => {
  assert.deepEqual(readBack(excAggEl({ type: 'avg', reference_characteristic: 'cha_a' })), {
    type: 'AVG',
    reference_characteristic: 'CHA_A',
  });
});

test('false and an empty element mean standard aggregation', () => {
  assert.equal(excAggEl(false), '<Qry:exceptionAggregation/>');
  assert.equal(readBack('<Qry:exceptionAggregation/>'), undefined);
  assert.equal(readBack(''), undefined);
});

test('the text form names the type and the characteristics', () => {
  assert.equal(formatExceptionAggregation({ type: 'SUM', reference_characteristic: 'CHA_A' }), 'SUM(CHA_A)');
  assert.equal(
    formatExceptionAggregation({ type: 'SUM', reference_characteristic: 'CHA_A', exclude: true }),
    'SUM(all except CHA_A)'
  );
});

const ckfDoc = (memberBody) =>
  '<Qry:queryResource>' +
  '<Qry:subComponents id="SUB"><Qry:member id="SUBself"><Qry:exceptionAggregation type="MAX" exclude="false">' +
  '<Qry:referenceCharacteristic>OTHER</Qry:referenceCharacteristic></Qry:exceptionAggregation></Qry:member></Qry:subComponents>' +
  `<Qry:mainComponent id="MAIN"><Qry:member id="MAINself"><Qry:formulaDefinition/>${memberBody}</Qry:member></Qry:mainComponent>` +
  '</Qry:queryResource>';

test('a CKF without the element gets it appended to its own member only', () => {
  const out = setCkfExceptionAggregation(ckfDoc(''), excAggEl({ type: 'SUM', reference_characteristic: 'CHA_A' }));
  assert.match(out, /<Qry:formulaDefinition\/><Qry:exceptionAggregation exclude="false" type="SUM">/);
  assert.match(out, /<Qry:referenceCharacteristic>OTHER<\/Qry:referenceCharacteristic>/);
});

test('an existing setting is replaced, and reset leaves an empty element', () => {
  const set = ckfDoc(
    '<Qry:exceptionAggregation type="AVG" exclude="false"><Qry:referenceCharacteristic>CHA_A</Qry:referenceCharacteristic></Qry:exceptionAggregation>'
  );
  const reset = setCkfExceptionAggregation(set, excAggEl(false));
  assert.match(reset, /<Qry:formulaDefinition\/><Qry:exceptionAggregation\/><\/Qry:member><\/Qry:mainComponent>/);
  assert.match(reset, /type="MAX"/, 'the sub-component keeps its own setting');
  assert.doesNotMatch(reset, /type="AVG"/);
});

test('the JSON text an MCP client sends for an untyped parameter is accepted', () => {
  assert.equal(
    excAggEl('{"type":"SUM","reference_characteristic":"CHA_A"}'),
    excAggEl({ type: 'SUM', reference_characteristic: 'CHA_A' })
  );
  assert.equal(excAggEl('false'), '<Qry:exceptionAggregation/>');
  assert.equal(excAggEl('null'), '<Qry:exceptionAggregation/>');
  assert.throws(() => excAggEl('SUM'), /must be an object/);
});
