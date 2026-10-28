import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

// Runs the shipped HTTP entry point with synthetic bindings; no BW or identity-provider requests.
test('HTTP XSUAA sign-in requires approval and preserves the browser-bound callback', async () => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const credentials = { url: 'https://identity.example', clientid: 'fixture-client', clientsecret: 'fixture-secret', xsappname: 'fixture', uaadomain: 'identity.example' };
  const child = spawn(process.execPath, ['dist/http.js'], {
    env: { PATH: process.env.PATH, PORT: String(port), BW_BTP_DESTINATION: 'FIXTURE', BW_PUBLIC_URL: origin,
      VCAP_SERVICES: JSON.stringify({ xsuaa: [{ credentials }], destination: [{ credentials: { uri: 'https://destination.example', clientid: 'fixture', clientsecret: 'fixture', url: 'https://identity.example' } }] }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  try {
    const deadline = Date.now() + 15000;
    for (;;) {
      assert.equal(child.exitCode, null, logs);
      try { if ((await fetch(`${origin}/health`)).ok) break; } catch { /* local server starting */ }
      assert.ok(Date.now() < deadline, logs);
      await delay(50);
    }
    const registration = await fetch(`${origin}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'BW upgrade test', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none' }) });
    assert.equal(registration.status, 201);
    const client = await registration.json();
    const params = new URLSearchParams({ client_id: client.client_id, response_type: 'code', redirect_uri: 'https://client.example/callback', code_challenge: 'A'.repeat(43), code_challenge_method: 'S256', state: 'client+state', scope: 'read' });
    const cookies = (response) => response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const fields = (html) => new URLSearchParams(Object.fromEntries([...html.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')])));
    for (const action of ['deny', 'approve']) {
      const page = await fetch(`${origin}/authorize?${params}`, { redirect: 'manual' });
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.ok(html.includes('Approve and continue'));
      const form = fields(html); form.set('consent_action', action);
      const response = await fetch(`${origin}/authorize`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, Cookie: cookies(page) }, body: form });
      if (action === 'deny') {
        assert.equal(response.status, 303);
        assert.equal(new URL(response.headers.get('location')).searchParams.get('error'), 'access_denied');
        continue;
      }
      assert.equal(response.status, 302);
      const target = new URL(response.headers.get('location'));
      assert.equal(target.origin, credentials.url);
      assert.equal(target.searchParams.get('scope'), 'fixture.read');
      const callbackUrl = `${origin}/oauth/callback?${new URLSearchParams({ state: target.searchParams.get('state'), code: 'fixture-code' })}`;
      assert.equal((await fetch(callbackUrl, { redirect: 'manual' })).status, 400);
      const callback = await fetch(callbackUrl, { redirect: 'manual', headers: { Cookie: cookies(response) } });
      assert.equal(callback.status, 302);
      const returned = new URL(callback.headers.get('location'));
      assert.equal(returned.searchParams.get('state'), 'client+state');
      assert.ok(returned.searchParams.get('code'));
      assert.notEqual(returned.searchParams.get('code'), 'fixture-code');
    }
    assert.equal((await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  }
});
