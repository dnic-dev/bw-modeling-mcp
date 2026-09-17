import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMemberPlanning } from '../dist/tools/query.js';

// The literal set below was harvested from live planning queries and cross-checked
// against the metadata tables. Getting it wrong produces a member that silently is
// not input-ready, so the mapping is pinned here rather than left to inspection.

test('a member without a planning element reports nothing', () => {
  assert.equal(parseMemberPlanning({}), undefined);
});

test('the server default marker is reported as "default", not as a type', () => {
  const planning = parseMemberPlanning({
    'Qry:planning': {
      'Qry:inputMode': { '@_default': 'true' },
      'Qry:disaggregation': { '@_default': 'true' },
    },
  });
  assert.deepEqual(planning, { inputMode: 'default', disaggregation: 'default' });
});

test('an input-ready member reports its input mode', () => {
  const planning = parseMemberPlanning({
    'Qry:planning': {
      'Qry:inputMode': { '@_default': 'false', '@_type': 'inputReady' },
      'Qry:disaggregation': { '@_default': 'false', '@_type': 'copy' },
    },
  });
  assert.deepEqual(planning, { inputMode: 'inputReady', disaggregation: 'copy' });
});

test('an explicitly not-input-ready member is distinguished from an untouched one', () => {
  const planning = parseMemberPlanning({
    'Qry:planning': {
      'Qry:inputMode': { '@_default': 'false', '@_type': 'not' },
      'Qry:disaggregation': { '@_default': 'false', '@_type': 'no' },
    },
  });
  assert.deepEqual(planning, { inputMode: 'not', disaggregation: 'no' });
});

test('a disaggregation reference is carried along', () => {
  const planning = parseMemberPlanning({
    'Qry:planning': {
      'Qry:inputMode': { '@_default': 'true' },
      'Qry:disaggregation': { '@_default': 'false', '@_type': 'absolute', '@_reference': 'MEMBER_UID' },
    },
  });
  assert.deepEqual(planning, {
    inputMode: 'default',
    disaggregation: 'absolute',
    disaggregationReference: 'MEMBER_UID',
  });
});

test('a planning element without the expected children does not invent a type', () => {
  const planning = parseMemberPlanning({ 'Qry:planning': {} });
  assert.deepEqual(planning, { inputMode: 'default', disaggregation: 'default' });
});
