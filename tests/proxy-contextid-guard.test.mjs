import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { BwClient } from '../dist/bw-client.js';

// The BAS destination proxy strips Set-Cookie, keeps the SAP sap-contextid itself and
// injects it into every request without a Cookie header; a stateless request ends that
// context and everything after fails with ICMENOSESSION. These tests pin the guard.

function withAdapter(handler, fn) {
  const calls = [];
  const prev = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    const headers = config.headers.toJSON ? config.headers.toJSON() : { ...config.headers };
    const url = String(config.url ?? '');
    calls.push({ method: String(config.method).toUpperCase(), url, headers });
    const r = handler(calls.length, { method: String(config.method).toUpperCase(), url, headers });
    return { status: r.status ?? 200, statusText: '', headers: r.headers ?? {}, data: r.data ?? '', config };
  };
  return fn(calls).finally(() => { axios.defaults.adapter = prev; });
}

const opts = { url: 'http://bw.test', client: '201', auth: { kind: 'basic', user: 'u', password: 'p' } };
const csrfResponse = { status: 200, headers: { 'x-csrf-token': 'tok' }, data: '' };
const okXml = { status: 200, headers: {}, data: '<x/>' };
const icm = { status: 400, headers: { 'sap-err-id': 'ICMENOSESSION' }, data: '<html>ICMENOSESSION</html>' };

test('guard off by default: no synthetic cookie', () =>
  withAdapter(() => csrfResponse, async (calls) => {
    delete process.env.BW_PROXY_CONTEXTID_GUARD;
    const c = new BwClient(opts);
    await c.get('/sap/bw/modeling/adso/x', 'application/xml');
    for (const call of calls) assert.equal(call.headers.Cookie ?? call.headers.cookie, undefined);
  }));

test('stateful default requests stay cookie-less (proxy must inject its live context)', () =>
  withAdapter(() => csrfResponse, async (calls) => {
    const c = new BwClient({ ...opts, proxyContextIdGuard: true });
    await c.get('/sap/bw/modeling/adso/x', 'application/xml');
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.headers['X-sap-adt-sessiontype'], 'stateful');
      assert.equal(call.headers.Cookie ?? call.headers.cookie, undefined);
    }
  }));

test('explicitly stateless requests carry an empty sap-contextid', () =>
  withAdapter(() => csrfResponse, async (calls) => {
    const c = new BwClient({ ...opts, proxyContextIdGuard: true });
    await c.rawGet('/sap/bw/modeling/x', { 'X-sap-adt-sessiontype': 'stateless' });
    const last = calls[calls.length - 1];
    assert.equal(last.headers['X-sap-adt-sessiontype'], 'stateless');
    assert.equal(last.headers.Cookie, 'sap-contextid=');
  }));

test('rawPost (fresh axios instance, no session-type header) carries an empty sap-contextid', () =>
  withAdapter(() => okXml, async (calls) => {
    const c = new BwClient({ ...opts, proxyContextIdGuard: true });
    await c.rawPost('/sap/bw/modeling/x?action=lock', '', { Accept: 'application/xml' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers['X-sap-adt-sessiontype'], undefined);
    assert.equal(calls[0].headers.Cookie, 'sap-contextid=');
  }));

test('BW_PROXY_CONTEXTID_GUARD=true enables the guard from the environment', () =>
  withAdapter(() => okXml, async (calls) => {
    process.env.BW_PROXY_CONTEXTID_GUARD = 'true';
    try {
      const c = new BwClient(opts);
      await c.rawPost('/sap/bw/modeling/x', '', {});
      assert.equal(calls[0].headers.Cookie, 'sap-contextid=');
    } finally {
      delete process.env.BW_PROXY_CONTEXTID_GUARD;
    }
  }));

test('no synthetic cookie once the jar holds a session cookie', () =>
  withAdapter((n) => n === 1
      ? { status: 200, headers: { 'x-csrf-token': 'tok', 'set-cookie': ['sap-contextid=LIVE; path=/sap/bw/'] }, data: '' }
      : okXml,
    async (calls) => {
      const c = new BwClient({ ...opts, proxyContextIdGuard: true });
      await c.rawGet('/sap/bw/modeling/x', { 'X-sap-adt-sessiontype': 'stateless' });
      assert.equal(calls[1].headers.Cookie, 'sap-contextid=LIVE');
    }));

test('ICMENOSESSION: heal via stateful HEAD with empty contextid on the same path, then retry once', () =>
  withAdapter((n, call) => {
      if (n === 1) return csrfResponse;                 // systeminfo (CSRF)
      if (n === 2) return icm;                          // GET adso → dead proxy context
      if (n === 3) return { status: 400, headers: {}, data: '' }; // HEAD heal (handler answers 400, context created)
      return okXml;                                     // retry
    },
    async (calls) => {
      const c = new BwClient({ ...opts, proxyContextIdGuard: true });
      const res = await c.get('/sap/bw/modeling/adso/db12_s001?foo=bar', 'application/xml');
      assert.equal(res.body, '<x/>');
      assert.equal(calls.length, 4);
      const heal = calls[2];
      assert.equal(heal.method, 'HEAD');
      assert.equal(heal.url, '/sap/bw/modeling/adso/db12_s001');
      assert.equal(heal.headers['X-sap-adt-sessiontype'], 'stateful');
      assert.equal(heal.headers.Cookie, 'sap-contextid=');
      assert.ok(heal.headers.Authorization);
      const retry = calls[3];
      assert.equal(retry.method, 'GET');
      assert.equal(retry.headers['X-sap-adt-sessiontype'], 'stateful');
      assert.equal(retry.headers.Cookie ?? retry.headers.cookie, undefined);
      assert.equal(retry.headers['X-CSRF-Token'], 'tok');
    }));

test('ICMENOSESSION twice: retried only once, error surfaces', () =>
  withAdapter((n) => (n === 1 ? csrfResponse : icm), async (calls) => {
    const c = new BwClient({ ...opts, proxyContextIdGuard: true });
    await assert.rejects(() => c.get('/sap/bw/modeling/adso/x', 'application/xml'), /HTTP 400/);
    // csrf, GET, HEAD heal, retry GET → no further heal/retry
    assert.equal(calls.length, 4);
  }));

test('retry of a request without session-type header does not turn stateful', () =>
  withAdapter((n) => (n === 1 ? icm : n === 2 ? { status: 400, headers: {}, data: '' } : okXml), async (calls) => {
    const c = new BwClient({ ...opts, proxyContextIdGuard: true });
    await c.rawPost('/sap/bw/modeling/x', '', { Accept: 'application/xml' });
    assert.equal(calls.length, 3);
    assert.equal(calls[2].headers['X-sap-adt-sessiontype'], 'stateless');
    assert.equal(calls[2].headers.Cookie, 'sap-contextid=');
  }));
