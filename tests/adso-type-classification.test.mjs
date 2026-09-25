import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adsoTypeCandidates } from '../dist/tools/adso.js';

// Root flags as the server keeps them after creating each preset, read back from a
// BW/4HANA system (with isReportingObject) and a classic release (without it).
const root = (flags) =>
  `<adso:dataStore name="ADSO_NAME" ${Object.entries(flags).map(([k, v]) => `${k}="${v}"`).join(' ')}>`;

const BW4 = {
  standard: { activateData: true, cubeDeltaOnly: false, directUpdate: false, isReportingObject: true, noAqDeletion: false, writeChangelog: true },
  staging_inbound_only: { activateData: false, cubeDeltaOnly: false, directUpdate: false, isReportingObject: false, noAqDeletion: false, writeChangelog: false },
  staging_compress: { activateData: true, cubeDeltaOnly: false, directUpdate: false, isReportingObject: false, noAqDeletion: false, writeChangelog: false },
  staging_reporting: { activateData: true, cubeDeltaOnly: false, directUpdate: false, isReportingObject: true, noAqDeletion: true, writeChangelog: false },
  datamart: { activateData: true, cubeDeltaOnly: true, directUpdate: false, isReportingObject: true, noAqDeletion: false, writeChangelog: false },
  direct_update: { activateData: false, cubeDeltaOnly: false, directUpdate: true, isReportingObject: false, noAqDeletion: false, writeChangelog: false },
};

for (const [preset, flags] of Object.entries(BW4)) {
  test(`BW/4HANA: the flags of preset ${preset} classify as ${preset}`, () => {
    assert.deepEqual(adsoTypeCandidates(root(flags)), [preset]);
  });
}

test('classic release: every preset except compress is identified without isReportingObject', () => {
  for (const [preset, flags] of Object.entries(BW4)) {
    const { isReportingObject, ...classic } = flags;
    const candidates = adsoTypeCandidates(root(classic));
    assert.ok(candidates.includes(preset), `${preset} → ${candidates}`);
    if (preset !== 'staging_compress') assert.equal(candidates[0], preset);
  }
});

test('classic release: compress and standard without change log are reported as ambiguous', () => {
  const { isReportingObject, ...classic } = BW4.staging_compress;
  assert.deepEqual(adsoTypeCandidates(root(classic)), ['standard', 'staging_compress']);
});
