import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretRuntimeState, timestampl, jobEndTime } from '../dist/tools/remodeling.js';

/** A run the monitor still reports as R, with nothing known from the runtime tables. */
const unknown = {
  headStatus: 'R',
  runStatus: '',
  runEnd: '',
  jobName: '',
  jobStatus: '',
  jobEnd: '',
};

test('the header table outranks the buffered monitor status', () => {
  const v = interpretRuntimeState({ ...unknown, headStatus: 'C' });
  assert.equal(v.status, 'C');
  assert.equal(v.source, 'RSCNVCNVHD2');
  assert.equal(v.note, undefined);
});

test('an error status comes through the same path', () => {
  assert.equal(interpretRuntimeState({ ...unknown, headStatus: 'E' }).status, 'E');
});

test('a finished RUN step settles it when the header still lags', () => {
  const v = interpretRuntimeState({
    ...unknown,
    runStatus: 'C',
    runEnd: '2026-08-20T08:50:34Z',
  });
  assert.equal(v.status, 'C');
  assert.match(v.source, /RSCNVSTEP \(step RUN, ended 2026-08-20T08:50:34Z\)/);
});

test('a RUN step without an end time is not treated as finished', () => {
  // Guards against reporting Complete off a status field that was written before the
  // step actually ended.
  const v = interpretRuntimeState({ ...unknown, runStatus: 'C', runEnd: '' });
  assert.equal(v.status, undefined);
});

test('a finished batch job warns but does not invent a status', () => {
  const v = interpretRuntimeState({
    ...unknown,
    runStatus: 'R',
    jobName: 'OBJECT_NAME:20260820',
    jobStatus: 'F',
    jobEnd: '2026-08-20 10:50:34',
  });
  assert.equal(v.status, undefined);
  assert.match(v.note, /finished at 2026-08-20 10:50:34 server time/);
  assert.match(v.note, /has not caught up/);
});

test('an aborted job is reported as aborted', () => {
  const v = interpretRuntimeState({ ...unknown, jobName: 'OBJECT_NAME:1', jobStatus: 'A' });
  assert.match(v.note, /aborted/);
});

test('a genuinely running job yields no correction and no warning', () => {
  const v = interpretRuntimeState({
    ...unknown,
    runStatus: 'R',
    jobName: 'OBJECT_NAME:1',
    jobStatus: 'R',
  });
  assert.deepEqual(v, {});
});

test('nothing known at all stays silent', () => {
  assert.deepEqual(interpretRuntimeState(unknown), {});
});

test('TIMESTAMPL is read as UTC and an unset value yields nothing', () => {
  assert.equal(timestampl('20260820085034.7092500'), '2026-08-20T08:50:34Z');
  assert.equal(timestampl('0.0000000'), '');
  assert.equal(timestampl(''), '');
  assert.equal(timestampl(undefined), '');
});

test('TBTCO date and time are joined, short times left-padded', () => {
  assert.equal(jobEndTime('20260820', '105034'), '2026-08-20 10:50:34');
  assert.equal(jobEndTime('20260820', '5034'), '2026-08-20 00:50:34');
  assert.equal(jobEndTime('00000000', '000000'), '');
  assert.equal(jobEndTime('', ''), '');
});
