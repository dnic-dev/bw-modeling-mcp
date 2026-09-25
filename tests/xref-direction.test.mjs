import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAtomEntries, parseFlowTitle, annotateXref } from '../dist/tools/search.js';

// The where-used feed carries no direction of its own. Transformation and DTP titles do name
// source and target, in the same format on BW/4HANA and on classic releases, and that is the
// only place a traversal can learn which way a hit points. These pin the parsing against
// titles of the shape both platforms return.

const entry = (objectName, objectType, title) => ({
  objectName, objectType, objectStatus: 'active', objectVersion: '', title, href: '',
});

test('a transformation title yields typed source and target', () => {
  assert.deepEqual(parseFlowTitle('TRFN', 'ODSO SOURCE_DSO -> CUBE TARGET_CUBE'), {
    source: { type: 'ODSO', name: 'SOURCE_DSO', sourceSystem: undefined },
    target: { type: 'CUBE', name: 'TARGET_CUBE', sourceSystem: undefined },
  });
});

test('a DataSource end keeps its source system apart from its name', () => {
  const flow = parseFlowTitle('TRFN', 'RSDS DS_NAME LSYS_NAME -> ADSO TARGET_ADSO');
  assert.deepEqual(flow.source, { type: 'RSDS', name: 'DS_NAME', sourceSystem: 'LSYS_NAME' });
});

test('a DTP title has no types, and a slash separates the source system', () => {
  assert.deepEqual(parseFlowTitle('DTPA', 'DS_NAME / LSYS_NAME -> TARGET_DSO'), {
    source: { name: 'DS_NAME', sourceSystem: 'LSYS_NAME' },
    target: { name: 'TARGET_DSO', sourceSystem: undefined },
  });
});

test('a master data flow names the InfoObject part with the type, and still matches the InfoObject', () => {
  const flow = parseFlowTitle('TRFN', 'ADSO SOURCE_ADSO -> IOBJTEXT CHAR_NAME');
  assert.deepEqual(flow.target, { type: 'IOBJ', subtype: 'TEXT', name: 'CHAR_NAME', sourceSystem: undefined });
  const [hit] = annotateXref(
    [entry('TRFN_MD', 'TRFN', 'ADSO SOURCE_ADSO -> IOBJTEXT CHAR_NAME')],
    'IOBJ',
    'CHAR_NAME',
  );
  assert.equal(hit.direction, 'upstream');
});

test('an analysis process under a query reads from it', () => {
  // The title is the process description, not a flow — the direction comes from the fact that
  // an analysis process cannot write to a query.
  const [hit] = annotateXref([entry('APD_NAME', 'ANPR', 'Some description')], 'ELEM', 'QUERY_NAME');
  assert.equal(hit.direction, 'downstream');
  assert.deepEqual(hit.source, { type: 'ELEM', name: 'QUERY_NAME' });
  assert.deepEqual(hit.target, { type: 'ANPR', name: 'APD_NAME' });
});

test('a title of any other shape, or of another object type, yields nothing rather than a guess', () => {
  assert.equal(parseFlowTitle('TRFN', 'Some description'), undefined);
  assert.equal(parseFlowTitle('HCPR', 'ADSO A -> ADSO B'), undefined);
  assert.equal(parseFlowTitle('TRFN', 'lower case -> ADSO B'), undefined);
});

test('the escaped arrow of the feed is decoded before the title is read', () => {
  const xml =
    '<atom:feed><atom:entry><atom:content type="application/xml">' +
    '<bwModel:object objectName="TRFN_ID" objectType="TRFN" objectStatus="active"/></atom:content>' +
    '<atom:title>ODSO SOURCE_DSO -&gt; CUBE TARGET_CUBE</atom:title></atom:entry></atom:feed>';
  const [e] = parseAtomEntries(xml);
  assert.equal(e.title, 'ODSO SOURCE_DSO -> CUBE TARGET_CUBE');
});

test('direction is relative to the object asked about', () => {
  const hits = annotateXref(
    [
      entry('TRFN_IN', 'TRFN', 'RSDS DS_NAME LSYS_NAME -> ODSO MIDDLE_DSO'),
      entry('TRFN_OUT', 'TRFN', 'ODSO MIDDLE_DSO -> CUBE TARGET_CUBE'),
      entry('DTP_IN', 'DTPA', 'DS_NAME / LSYS_NAME -> MIDDLE_DSO'),
      entry('DTP_OUT', 'DTPA', 'MIDDLE_DSO -> TARGET_CUBE'),
      entry('MULTI', 'MPRO', 'A MultiProvider'),
    ],
    'ODSO',
    'MIDDLE_DSO',
  );
  const byName = Object.fromEntries(hits.map((h) => [h.objectName, h]));
  assert.equal(byName.TRFN_IN.direction, 'upstream');
  assert.equal(byName.TRFN_OUT.direction, 'downstream');
  assert.equal(byName.DTP_IN.direction, 'upstream');
  assert.equal(byName.DTP_OUT.direction, 'downstream');
  // A user of the object that is not a flow gets no direction at all.
  assert.equal(byName.MULTI.direction, undefined);
});

test('DTP ends borrow their type from a transformation end of the same name', () => {
  const hits = annotateXref(
    [
      entry('TRFN_OUT', 'TRFN', 'ODSO MIDDLE_DSO -> CUBE TARGET_CUBE'),
      entry('DTP_OUT', 'DTPA', 'MIDDLE_DSO -> TARGET_CUBE'),
    ],
    'ODSO',
    'MIDDLE_DSO',
  );
  const dtp = hits.find((h) => h.objectName === 'DTP_OUT');
  assert.equal(dtp.source.type, 'ODSO');
  assert.equal(dtp.target.type, 'CUBE');
});

test('an end of the same name but another type is not the queried object', () => {
  const [hit] = annotateXref([entry('TRFN_X', 'TRFN', 'IOBJ SAME_NAME -> ADSO OTHER')], 'ADSO', 'SAME_NAME');
  assert.equal(hit.direction, undefined);
});

test('a DataSource is matched by name and source system', () => {
  const hits = annotateXref(
    [
      entry('TRFN_A', 'TRFN', 'RSDS DS_NAME LSYS_A -> ADSO TARGET_A'),
      entry('TRFN_B', 'TRFN', 'RSDS DS_NAME LSYS_B -> ADSO TARGET_B'),
    ],
    'RSDS',
    'DS_NAME',
    'LSYS_A',
  );
  assert.equal(hits[0].direction, 'downstream');
  assert.equal(hits[1].direction, undefined);
});
