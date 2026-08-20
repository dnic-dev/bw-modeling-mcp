// NODESNOTCONNECTED is the backend's placeholder for "this object has no InfoArea" — it is not
// an addressable area, so no reader may pass it on as if it were one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripInfoAreaSentinel } from '../dist/bw-client.js';

test('the placeholder becomes an empty string', () => {
  assert.equal(stripInfoAreaSentinel('NODESNOTCONNECTED'), '');
});

// The value arrives from XML text nodes and from JSON attributes, so neither case nor
// surrounding whitespace is guaranteed.
test('case and surrounding whitespace do not hide it', () => {
  assert.equal(stripInfoAreaSentinel('nodesnotconnected'), '');
  assert.equal(stripInfoAreaSentinel('  NODESNOTCONNECTED  '), '');
  assert.equal(stripInfoAreaSentinel('NodesNotConnected'), '');
});

test('a real InfoArea is returned untouched, including a namespaced one', () => {
  assert.equal(stripInfoAreaSentinel('MY_AREA'), 'MY_AREA');
  assert.equal(stripInfoAreaSentinel('/NS/MY_AREA'), '/NS/MY_AREA');
  assert.equal(stripInfoAreaSentinel(''), '');
});

// Only the exact placeholder — an area that merely contains the word keeps its name.
test('a name that only contains the word is kept', () => {
  assert.equal(stripInfoAreaSentinel('NODESNOTCONNECTED_OLD'), 'NODESNOTCONNECTED_OLD');
  assert.equal(stripInfoAreaSentinel('Z_NODESNOTCONNECTED'), 'Z_NODESNOTCONNECTED');
});
