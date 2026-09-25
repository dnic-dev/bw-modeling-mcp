import test from 'node:test';
import assert from 'node:assert/strict';
import { XMLParser } from 'fast-xml-parser';
import { excAggEl } from '../dist/tools/query_update.js';
import { setCkfExceptionAggregation } from '../dist/tools/elem_write.js';
import { parseExceptionAggregation } from '../dist/tools/query.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

/** Parse an element built by excAggEl the way the read tools do. */
const readBack = (xml) =>
  parseExceptionAggregation(parser.parse(`<Qry:member xmlns:Qry="q">${xml}</Qry:member>`)['Qry:member']);

test('a bw_get_ckf exception_aggregation can be written back unchanged', () => {
  // The point of the change: read → create must not lose the aggregation. The read
  // result carries a label the writer has to ignore.
  const fromRead = {
    type: 'MAX',
    label: 'Maximum',
    reference_characteristics: ['0PLANT', '0SALESORG', '0DISTR_CHAN', '0UNIT', '0VAL_TYPE'],
  };
  assert.deepEqual(readBack(excAggEl(fromRead)), {
    type: 'MAX',
    label: 'Maximum',
    referenceCharacteristics: ['0PLANT', '0SALESORG', '0DISTR_CHAN', '0UNIT', '0VAL_TYPE'],
  });
});

test('the single-characteristic form keeps producing the same element', () => {
  // bw_update_query_key_figures has always sent this shape; its output must not change.
  assert.equal(
    excAggEl({ type: 'AVG', reference_characteristic: '0material' }),
    '<Qry:exceptionAggregation exclude="false" type="AVG">\n' +
      '    <Qry:referenceCharacteristic>0MATERIAL</Qry:referenceCharacteristic>\n' +
      '  </Qry:exceptionAggregation>'
  );
});

test('false, null and undefined write the empty element', () => {
  for (const v of [false, null, undefined]) assert.equal(excAggEl(v ?? undefined), '<Qry:exceptionAggregation/>');
});

test('invalid aggregations are rejected rather than written', () => {
  assert.throws(() => excAggEl({ type: 'XYZ', reference_characteristics: ['0MATERIAL'] }), /unknown/);
  assert.throws(() => excAggEl({ type: 'SUM', reference_characteristics: [] }), /at least one reference/);
  assert.throws(() => excAggEl({ type: 'SUM', reference_characteristics: ['A', 'B', 'C', 'D', 'E', 'F'] }), /at most 5/);
  assert.throws(() => excAggEl({ type: 'SUM', reference_characteristics: ['0PLANT', '0plant'] }), /twice/);
  assert.throws(
    () => excAggEl({ type: 'SUM', reference_characteristic: '0PLANT', reference_characteristics: ['0PLANT'] }),
    /not both/
  );
  assert.throws(() => excAggEl({ type: 'SUM', reference_characteristics: ['0CALDAY'], exclude: true }), /exclude/);
});

// A CKF document with an embedded sub-component that has an aggregation of its own:
// the write must change the main component's member and leave the sub-component alone.
const DOC =
  '<Qry:queryResource>' +
  '<Qry:subComponents xsi:type="Qry:CalculatedMeasure" id="SUB" technicalName="OTHER_CKF">' +
  '<Qry:member xsi:type="Qry:MemberFormula" id="SUB"><Qry:formulaDefinition/>' +
  '<Qry:exceptionAggregation exclude="false" type="SUM"><Qry:referenceCharacteristic>0CUSTOMER</Qry:referenceCharacteristic></Qry:exceptionAggregation>' +
  '</Qry:member></Qry:subComponents>' +
  '<Qry:mainComponent xsi:type="Qry:CalculatedMeasure" id="MAIN" technicalName="MY_CKF">' +
  '<Qry:member xsi:type="Qry:MemberFormula" id="MAIN"><Qry:formulaDefinition/><Qry:exceptionAggregation/></Qry:member>' +
  '</Qry:mainComponent></Qry:queryResource>';

test('an update sets the main component and leaves embedded sub-components untouched', () => {
  const out = setCkfExceptionAggregation(DOC, excAggEl({ type: 'CN0', reference_characteristics: ['0DOC_NUMBER'] }));
  const sub = out.slice(0, out.indexOf('<Qry:mainComponent'));
  const main = out.slice(out.indexOf('<Qry:mainComponent'));
  assert.equal(sub, DOC.slice(0, DOC.indexOf('<Qry:mainComponent')));
  assert.match(main, /type="CN0"/);
  assert.match(main, /0DOC_NUMBER/);
  assert.equal((out.match(/<Qry:exceptionAggregation\b/g) ?? []).length, 2);
});

test('a reset empties the element again', () => {
  const set = setCkfExceptionAggregation(DOC, excAggEl({ type: 'CN0', reference_characteristics: ['0DOC_NUMBER'] }));
  assert.equal(setCkfExceptionAggregation(set, excAggEl(undefined)), DOC);
});
