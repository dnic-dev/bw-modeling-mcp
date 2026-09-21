import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptRange, expandAccept } from '../dist/bw-client.js';

test('acceptRange lists every version up to the resolved one, lowest first', () => {
  assert.equal(
    acceptRange('application/vnd.sap.bw.modeling.area-v1_1_0+xml'),
    'application/vnd.sap.bw.modeling.area-v1_0_0+xml, application/vnd.sap.bw.modeling.area-v1_1_0+xml',
  );
});

test('acceptRange spans major versions', () => {
  const r = acceptRange('application/vnd.sap-bw-modeling.iobj-v2_2_0+xml').split(', ');
  assert.equal(r.length, 13);                                   // v1_0_0…v1_9_0 + v2_0_0…v2_2_0
  assert.equal(r[0], 'application/vnd.sap-bw-modeling.iobj-v1_0_0+xml');
  assert.equal(r.at(-1), 'application/vnd.sap-bw-modeling.iobj-v2_2_0+xml');
  assert.ok(r.includes('application/vnd.sap-bw-modeling.iobj-v1_8_0+xml'));  // what classic serves
});

test('a media type without a version is passed through untouched', () => {
  assert.equal(acceptRange('application/atomsvc+xml'), 'application/atomsvc+xml');
  assert.equal(expandAccept('application/xml'), 'application/xml');
});

test('expandAccept keeps every entry of a multi-type Accept and deduplicates', () => {
  const out = expandAccept(
    'application/vnd.sap.bw.modeling.area-v1_1_0+xml, application/vnd.sap.bw.modeling.area-v1_0_0+xml',
  ).split(', ');
  assert.deepEqual(out, [
    'application/vnd.sap.bw.modeling.area-v1_0_0+xml',
    'application/vnd.sap.bw.modeling.area-v1_1_0+xml',
  ]);
});
