import test from 'node:test';
import assert from 'node:assert/strict';
import { XMLParser } from 'fast-xml-parser';
import { parseExceptionAggregation, formatExceptionAggregation } from '../dist/tools/query.js';

// Same parser options as the component readers (cp_components.ts): referenceCharacteristic
// is not forced to an array there, so the reader has to cope with one element and with many.
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

const memberOf = (inner) =>
  parser.parse(
    `<Qry:member xmlns:Qry="http://www.sap.com/bw/Query.ecore" id="M1">` +
      `<Qry:formulaDefinition/>${inner}</Qry:member>`
  )['Qry:member'];

test('a counter over one reference characteristic is read with type, label and characteristic', () => {
  // The case that prompted this: a document counter (formula "1") that is only meaningful
  // together with its exception aggregation "count values not equal to zero by 0DOC_NUMBER".
  const member = memberOf(
    '<Qry:exceptionAggregation exclude="false" type="CN0">' +
      '<Qry:referenceCharacteristic>0DOC_NUMBER</Qry:referenceCharacteristic>' +
      '</Qry:exceptionAggregation>'
  );
  assert.deepEqual(parseExceptionAggregation(member), {
    type: 'CN0',
    label: 'Counter (values not equal to zero)',
    referenceCharacteristics: ['0DOC_NUMBER'],
  });
});

test('several reference characteristics are all reported, in document order', () => {
  const member = memberOf(
    '<Qry:exceptionAggregation exclude="false" type="MAX">' +
      '<Qry:referenceCharacteristic>0PLANT</Qry:referenceCharacteristic>' +
      '<Qry:referenceCharacteristic>0SALESORG</Qry:referenceCharacteristic>' +
      '<Qry:referenceCharacteristic>0DISTR_CHAN</Qry:referenceCharacteristic>' +
      '</Qry:exceptionAggregation>'
  );
  assert.deepEqual(parseExceptionAggregation(member)?.referenceCharacteristics, ['0PLANT', '0SALESORG', '0DISTR_CHAN']);
});

test('an empty element means no exception aggregation', () => {
  assert.equal(parseExceptionAggregation(memberOf('<Qry:exceptionAggregation/>')), undefined);
  assert.equal(parseExceptionAggregation(memberOf('')), undefined);
  assert.equal(parseExceptionAggregation(undefined), undefined);
});

test('an unknown type code is kept, just without a label', () => {
  const ea = parseExceptionAggregation(
    memberOf('<Qry:exceptionAggregation type="XYZ"><Qry:referenceCharacteristic>0MATERIAL</Qry:referenceCharacteristic></Qry:exceptionAggregation>')
  );
  assert.deepEqual(ea, { type: 'XYZ', referenceCharacteristics: ['0MATERIAL'] });
});

test('the exclude flag is surfaced and rendered', () => {
  const ea = parseExceptionAggregation(
    memberOf('<Qry:exceptionAggregation exclude="true" type="SUM"><Qry:referenceCharacteristic>0CALDAY</Qry:referenceCharacteristic></Qry:exceptionAggregation>')
  );
  assert.equal(ea?.exclude, true);
  assert.equal(formatExceptionAggregation(ea), 'SUM (Summation) by 0CALDAY [exclude=true]');
});
