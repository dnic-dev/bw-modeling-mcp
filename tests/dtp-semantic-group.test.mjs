import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySemanticGroup, parseDtpXml } from '../dist/tools/dtp.js';

// A DTP document served from a reused stateful session lists the children of
// <semanticGroup> n-fold on the n-th read of the same DTP. These tests pin that the
// parser reports each field once and that the PUT document never carries the copies.

const fields = (extra = '') =>
  `<groupField name="MATNR" description="Material" field="true"${extra}/>` +
  `<groupField name="DATUMPROG" description="Date" field="true"/>` +
  `<groupField name="0PLANT" description="Plant" infoObjectType="DPA"/>`;

const doc = (sg) =>
  `<?xml version="1.0"?><dtpa:dataTransferProcess name="DTP_X" description="d" xmlns:dtpa="x">` +
  `<extractionSettings extractionMode="F" packageSize="50000"/>` +
  `<semanticGroup>${sg}</semanticGroup><filter></filter>` +
  `</dtpa:dataTransferProcess>`;

test('parseDtpXml: a clean document reports every group field once', () => {
  const info = parseDtpXml(doc(fields()), 'active');
  assert.deepEqual(info.semanticGroupFields.map((f) => f.name), ['MATNR', 'DATUMPROG', '0PLANT']);
  assert.equal(info.duplicateGroupFields, 0);
  assert.equal(info.semanticGroupFields[2].isField, false);
});

test('parseDtpXml: repeated group fields collapse to one entry, the key flag survives on any copy', () => {
  const info = parseDtpXml(doc(fields() + fields() + fields(' keyField="true"')), 'active');
  assert.deepEqual(info.semanticGroupFields.map((f) => f.name), ['MATNR', 'DATUMPROG', '0PLANT']);
  assert.equal(info.duplicateGroupFields, 6);
  assert.equal(info.semanticGroupFields.find((f) => f.name === 'MATNR').isKey, true);
  assert.equal(info.semanticGroupFields.find((f) => f.name === 'DATUMPROG').isKey, false);
});

test('applySemanticGroup: sets keyField on the requested fields of a clean document', () => {
  const out = applySemanticGroup(doc(fields()), 'MATNR', 'DTP_X');
  assert.equal(out.match(/<groupField\b/g).length, 3);
  assert.equal(out.match(/keyField="true"/g).length, 1);
  assert.match(out, /<groupField name="MATNR" description="Material" field="true" keyField="true"\/>/);
});

test('applySemanticGroup: a document with repeated group fields is sent back with each field once', () => {
  const out = applySemanticGroup(doc(fields(' keyField="true"') + fields() + fields()), 'DATUMPROG', 'DTP_X');
  assert.equal(out.match(/<groupField\b/g).length, 3);
  assert.equal(out.match(/keyField="true"/g).length, 1);
  assert.match(out, /<groupField name="DATUMPROG" description="Date" field="true" keyField="true"\/>/);
  assert.doesNotMatch(out, /name="MATNR"[^>]*keyField/);
});

test('applySemanticGroup: an empty list clears the selection, unknown names are rejected', () => {
  const cleared = applySemanticGroup(doc(fields(' keyField="true"') + fields()), '', 'DTP_X');
  assert.equal(cleared.match(/<groupField\b/g).length, 3);
  assert.doesNotMatch(cleared, /keyField=/);
  assert.throws(() => applySemanticGroup(doc(fields()), 'NOPE', 'DTP_X'), /not found in DTP 'DTP_X': NOPE/);
});
