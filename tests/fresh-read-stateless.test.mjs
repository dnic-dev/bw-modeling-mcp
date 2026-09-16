import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { BwClient, freshRead } from '../dist/bw-client.js';

// freshRead() must not share the process's stateful context: the modeling handlers keep
// the object instance per session and serve some lists n-fold on repeated reads. These
// tests pin the session type on the wire; the default of get() stays as it is.

function withAdapter(handler, fn) {
  const calls = [];
  const prev = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    const headers = config.headers.toJSON ? config.headers.toJSON() : { ...config.headers };
    const url = String(config.url ?? '');
    calls.push({ method: String(config.method).toUpperCase(), url, headers });
    const r = handler(calls.length, { url, headers });
    return { status: r.status ?? 200, statusText: '', headers: r.headers ?? {}, data: r.data ?? '', config };
  };
  return fn(calls).finally(() => { axios.defaults.adapter = prev; });
}

const opts = { url: 'http://bw.test', client: '201', auth: { kind: 'basic', user: 'u', password: 'p' } };
const csrfResponse = { status: 200, headers: { 'x-csrf-token': 'tok' }, data: '' };
const okXml = { status: 200, headers: { timestamp: '20260916120000' }, data: '<x/>' };

function withEnv(fn) {
  const saved = {};
  const set = { BW_URL: 'http://bw.test', BW_USER: 'u', BW_PASSWORD: 'p', BW_CLIENT: '201' };
  for (const [k, v] of Object.entries(set)) { saved[k] = process.env[k]; process.env[k] = v; }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

test('get() without options keeps the instance default (stateful)', () =>
  withAdapter((n) => (n === 1 ? csrfResponse : okXml), async (calls) => {
    const c = new BwClient(opts);
    await c.get('/sap/bw/modeling/dtpa/dtp_x/m', 'application/xml');
    const last = calls[calls.length - 1];
    assert.equal(last.headers['X-sap-adt-sessiontype'], 'stateful');
  }));

test('get() declares the session type of the one request when asked', () =>
  withAdapter((n) => (n === 1 ? csrfResponse : okXml), async (calls) => {
    const c = new BwClient(opts);
    await c.get('/sap/bw/modeling/dtpa/dtp_x/m', 'application/xml', { sessionType: 'stateless' });
    const last = calls[calls.length - 1];
    assert.equal(last.headers['X-sap-adt-sessiontype'], 'stateless');
    assert.equal(calls[0].headers['X-sap-adt-sessiontype'], 'stateful'); // the CSRF fetch is untouched
  }));

test('freshRead() reads stateless with forceCacheUpdate and returns the headers', () =>
  withEnv(() => withAdapter((n) => (n === 1 ? csrfResponse : okXml), async (calls) => {
    const result = await freshRead('/sap/bw/modeling/dtpa/dtp_x/m', 'application/vnd.sap.bw.modeling.dtpa-v1_0_0+xml');
    const last = calls[calls.length - 1];
    assert.equal(last.method, 'GET');
    assert.match(last.url, /\/sap\/bw\/modeling\/dtpa\/dtp_x\/m\?forceCacheUpdate=true$/);
    assert.equal(last.headers['X-sap-adt-sessiontype'], 'stateless');
    assert.equal(result.body, '<x/>');
    assert.equal(result.headers.timestamp, '20260916120000');
  })));

test('freshRead() appends forceCacheUpdate to an existing query string', () =>
  withEnv(() => withAdapter((n) => (n === 1 ? csrfResponse : okXml), async (calls) => {
    await freshRead('/sap/bw/modeling/adso/x/m?foo=1', 'application/xml');
    assert.match(calls[calls.length - 1].url, /\?foo=1&forceCacheUpdate=true$/);
  })));
