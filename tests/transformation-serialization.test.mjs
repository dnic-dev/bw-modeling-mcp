// The backend reports a failed model serialization as the T100 message RS_RES_MODEL 001, whose
// text differs per logon language — the German wording shares no words with the English one.
// Matching a single language's phrasing would leave the check dead on a German session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isModelSerializationFailure } from '../dist/tools/transformation.js';

const url = 'GET /sap/bw/modeling/trfn/abc/m → HTTP 500';

test('the English message is recognised', () => {
  assert.ok(isModelSerializationFailure(`${url}\nBW Model serialization failed`));
});

test('the German message is recognised', () => {
  assert.ok(isModelSerializationFailure(`${url}\nBW-Modell-Serialisierung ist fehlgeschlagen`));
});

// A body that carries the T100 key instead of, or next to, the rendered text.
test('the message class is recognised on its own', () => {
  assert.ok(isModelSerializationFailure(
    `${url}\n<properties><entry key="T100KEY-ID">RS_RES_MODEL</entry><entry key="T100KEY-NO">001</entry></properties>`,
  ));
});

test('another HTTP 500 is not claimed', () => {
  assert.equal(isModelSerializationFailure(`${url}\nObject is locked by another user`), false);
});

// Guards against a coincidental substring on a status that means something else entirely.
test('the phrase alone is not enough without a 500', () => {
  assert.equal(
    isModelSerializationFailure('GET /sap/bw/modeling/trfn/abc/m → HTTP 404\nserialization failed'),
    false,
  );
});
