import test from 'node:test';
import assert from 'node:assert/strict';
import { formatStamp, durationSeconds } from '../dist/tools/metadata_sql.js';

// The run log carries its timestamps in two shapes: the header splits date and time into two
// columns, the step log uses one long stamp with a fractional part. Both feed the same
// formatter, and a run's duration is computed across the two — the header knows when the run
// started, only the last step knows when it ended.

test('a header stamp assembled from date and time reads as one moment', () => {
  assert.equal(formatStamp('20260531' + '192528'), '2026-05-31 19:25:28');
});

test('a step stamp with a fractional part reads the same way', () => {
  assert.equal(formatStamp('20260531192528.9721330'), '2026-05-31 19:25:28');
});

test('the duration of a run spans the header start and the last step end', () => {
  // Sub-minute durations are the common case for a chain that fails early, and rounding them
  // away to "0m" would hide the difference between a fast failure and a slow one.
  assert.equal(durationSeconds('20260531192528', '20260531192531.0684830'), '3.1 s');
  assert.equal(durationSeconds('20260531192528', '20260531193028'), '5m 0s');
});

test('an unfinished run yields no duration rather than a wrong one', () => {
  // A step that is still active has no end stamp; a negative or missing span must come back
  // empty so the column stays blank instead of claiming a length.
  assert.equal(durationSeconds('20260531192528', ''), '');
  assert.equal(durationSeconds('20260531192528', '20260531192500'), '');
  assert.equal(durationSeconds('', '20260531192528'), '');
});

test('an empty or zero date is not rendered as a moment in time', () => {
  assert.equal(formatStamp(''), '');
  assert.equal(formatStamp('00000000000000'), '');
});

test('a run that spans hours is not reported in minutes', () => {
  // A chain that waited overnight for a cancelled step to be repeated produced "1107m 29s".
  // Nobody converts that in their head, and the number is what a reader looks at first.
  assert.equal(durationSeconds('20260910130227', '20260911072956'), '18h 27m');
  // The minute form stays for anything under an hour, the second form under a minute.
  assert.equal(durationSeconds('20260910130227', '20260910135227'), '50m 0s');
  assert.equal(durationSeconds('20260910130227', '20260910130257'), '30.0 s');
});
