import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockSessionType, lockSessionHeader } from '../dist/bw-client.js';
import { ensurePlatform, resetPlatformCache, cachedPlatform } from '../dist/platform.js';

/**
 * A stand-in for BwClient that answers the two reads platform detection makes.
 * `mode` is what the system reports as bw.b4hanamode: STRICT is BW/4HANA, anything
 * else is a classic release.
 */
function fakeClient(mode) {
  const sysinfo = `<?xml version="1.0"?><systeminfo><sysInfo:property name="bw.b4hanamode" value="${mode}"/></systeminfo>`;
  const collection = (name) =>
    `<app:collection href="/sap/bw/modeling/${name}"><app:accept>application/vnd.sap.bw.modeling.${name}-v1_0_0+xml</app:accept></app:collection>`;
  // trfn is the discovery-side discriminator: only BW/4HANA publishes it.
  const discovery = `<?xml version="1.0"?><app:service>${collection('adso')}${mode === 'STRICT' ? collection('trfn') : ''}</app:service>`;
  return {
    get: async (path) => ({
      body: path.includes('systeminfo') ? sysinfo : discovery,
      headers: {},
    }),
  };
}

test('without a platform verdict nothing is changed', () => {
  resetPlatformCache();
  assert.equal(cachedPlatform(), undefined);
  assert.equal(lockSessionType(undefined), undefined);
  assert.equal(lockSessionType('stateful_enqueue'), 'stateful_enqueue');
  assert.deepEqual(lockSessionHeader(), {});
  assert.deepEqual(lockSessionHeader('stateful_enqueue'), { 'X-sap-adt-sessiontype': 'stateful_enqueue' });
});

test('on BW/4HANA the caller decides and the headers stay as they were', async () => {
  resetPlatformCache();
  const profile = await ensurePlatform(fakeClient('STRICT'));
  assert.equal(profile.platform, 'bw4');
  assert.equal(lockSessionType(undefined), undefined);
  assert.equal(lockSessionType('stateful_enqueue'), 'stateful_enqueue');
  assert.deepEqual(lockSessionHeader(), {});
  assert.deepEqual(lockSessionHeader('stateful'), { 'X-sap-adt-sessiontype': 'stateful' });
});

test('on a classic release every lock runs as stateful', async () => {
  resetPlatformCache();
  const profile = await ensurePlatform(fakeClient('STANDARD'));
  assert.equal(profile.platform, 'classic');
  assert.equal(lockSessionType(undefined), 'stateful');
  // stateful_enqueue is what the classic backend refuses, so it is substituted too.
  assert.equal(lockSessionType('stateful_enqueue'), 'stateful');
  assert.deepEqual(lockSessionHeader(), { 'X-sap-adt-sessiontype': 'stateful' });
});

test.after(() => resetPlatformCache());
