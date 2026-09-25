import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BwClient } from '../dist/bw-client.js';

/**
 * A backend whose stateful context has ended: a token fetch that still carries the old
 * sap-contextid is answered 400, one without it gets a token and a new context.
 */
function startFakeBw({ alwaysFail = false } = {}) {
  const seen = { fetches: [] };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/sap/bw/modeling/repo/is/systeminfo')) {
      const cookie = req.headers.cookie ?? '';
      seen.fetches.push(cookie);
      if (seen.fetches.length === 1) {
        res.setHeader('set-cookie', 'sap-contextid=CONTEXT_1; path=/sap/bw/modeling');
        res.setHeader('x-csrf-token', 'token-1');
        res.end('<systeminfo/>');
      } else if (alwaysFail || cookie.includes('sap-contextid')) {
        res.statusCode = 400;
        res.end('<html><body>Session Timed Out</body></html>');
      } else {
        res.setHeader('set-cookie', 'sap-contextid=CONTEXT_2; path=/sap/bw/modeling');
        res.setHeader('x-csrf-token', 'token-2');
        res.end('<systeminfo/>');
      }
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

const client = (port) =>
  new BwClient({ url: `http://127.0.0.1:${port}`, auth: { kind: 'basic', user: 'user', password: 'secret' } });

test('a token fetch answered 400 in an ended context is repeated without the context', async () => {
  const { server, seen, port } = await startFakeBw();
  try {
    const c = client(port);
    assert.equal(await c.getCsrfToken(), 'token-1');
    c.clearCsrfToken();
    assert.equal(await c.getCsrfToken(), 'token-2');
    assert.equal(seen.fetches.length, 3);
    assert.match(seen.fetches[1], /sap-contextid=CONTEXT_1/);
    assert.doesNotMatch(seen.fetches[2], /sap-contextid/);
  } finally {
    server.close();
  }
});

test('a 400 that persists is reported with the server text, after exactly one repeat', async () => {
  const { server, seen, port } = await startFakeBw({ alwaysFail: true });
  try {
    const c = client(port);
    await c.getCsrfToken();
    c.clearCsrfToken();
    await assert.rejects(c.getCsrfToken(), /HTTP 400\): Session Timed Out/);
    assert.equal(seen.fetches.length, 3);
  } finally {
    server.close();
  }
});
