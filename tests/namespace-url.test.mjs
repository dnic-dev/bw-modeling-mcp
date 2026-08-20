// Regression tests for namespaced object names in modeling URLs. Pure string work — no BW
// system needed. Guards two failure modes: a namespaced name left with its slashes produces
// a double slash in the path and the resource 404s, and a plain name must keep travelling
// byte-identically so nothing that works today changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bwEscapeName, bwSeg, bwSegUpper } from '../dist/bw-client.js';

// The backend applies the same substitution in CL_RSEM_MODEL_OBJECT=>ESCAPE_OBJECT_NAME.
test('bwEscapeName replaces every slash and colon', () => {
  assert.equal(bwEscapeName('OBJECT_NAME'), 'OBJECT_NAME');
  assert.equal(bwEscapeName('/NS/OBJECT_NAME'), '$NS$OBJECT_NAME');
  assert.equal(bwEscapeName('/NS/PART/OBJECT_NAME'), '$NS$PART$OBJECT_NAME');
  assert.equal(bwEscapeName('OBJECT:NAME'), 'OBJECT!NAME');
  assert.equal(bwEscapeName('/NS/OBJECT:NAME'), '$NS$OBJECT!NAME');
  assert.equal(bwEscapeName(''), '');
});

test('bwSeg is byte-identical to toLowerCase for a plain name', () => {
  for (const name of ['OBJECT_NAME', 'DTP_0123456789ABCDEF', '0FIELD_NAME', 'ZTEST99']) {
    assert.equal(bwSeg(name), name.toLowerCase());
  }
});

test('bwSeg encodes a namespaced name as the backend addresses it', () => {
  assert.equal(bwSeg('/NS/OBJECT_NAME'), '%24ns%24object_name');
  assert.equal(bwSegUpper('/NS/OBJECT_NAME'), '%24NS%24OBJECT_NAME');
});

// The actual bug: a raw slash either doubles up after the type segment or splits the name
// into two path segments. Neither may survive encoding.
test('no segment ever carries a slash', () => {
  for (const name of ['/NS/OBJECT_NAME', '/NS/PART/OBJECT_NAME', 'OBJECT_NAME']) {
    for (const seg of [bwSeg(name), bwSegUpper(name)]) {
      assert.ok(!seg.includes('/'), `raw slash in ${seg}`);
      assert.ok(!seg.toLowerCase().includes('%2f'), `encoded slash in ${seg}`);
      assert.ok(!`/sap/bw/modeling/adso/${seg}/m`.includes('//'), `double slash for ${name}`);
    }
  }
});
