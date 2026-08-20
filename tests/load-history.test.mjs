import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatStamp, durationSeconds } from '../dist/tools/metadata_tables.js';

test('a request date and time become one readable stamp', () => {
  assert.equal(formatStamp('20190111', '125226'), '2019-01-11 12:52:26');
});

test('a packed timestamp carries its own time', () => {
  assert.equal(formatStamp('20190111125226'), '2019-01-11 12:52:26');
});

test('the fractional part of an RSBKREQUEST timestamp is ignored for display', () => {
  assert.equal(formatStamp('20190111125226.6875150'), '2019-01-11 12:52:26');
});

test('an empty or zero date yields nothing rather than a fake stamp', () => {
  assert.equal(formatStamp(''), '');
  assert.equal(formatStamp('00000000'), '');
  assert.equal(formatStamp(undefined), '');
});

test('a short run is reported in seconds with one decimal', () => {
  assert.equal(durationSeconds('20190111125226.6875150', '20190111125248.5232890'), '21.8 s');
});

test('a long run switches to minutes', () => {
  assert.equal(durationSeconds('20190111120000', '20190111120930'), '9m 30s');
});

test('a missing or reversed pair yields no duration instead of a negative one', () => {
  assert.equal(durationSeconds('20190111125226', undefined), '');
  assert.equal(durationSeconds(undefined, '20190111125226'), '');
  assert.equal(durationSeconds('20190111125248', '20190111125226'), '');
});
