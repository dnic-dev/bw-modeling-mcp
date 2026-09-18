import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { SCOPES } from '../dist/scopes.js';

/**
 * Every role the server defines must get past the bearer gate.
 *
 * `requireBearerAuth` demands *every* scope in `requiredScopes` — the check is
 * `requiredScopes.every(s => authInfo.scopes.includes(s))` on the short scope names the
 * XSUAA verifier produces. A single fixed scope there is therefore not a floor but a
 * filter: `['read']` admitted the reader and the developer, whose tokens carry `read`,
 * and rejected an analyst-only token with 403 `insufficient_scope`. Nothing in the tool
 * layer could soften that, because the gate runs before `mayCall()` and before any tool
 * is dispatched; the role looked usable from the outside, since `scopes_supported`
 * advertises `analyst` and a client duly requests it.
 *
 * Expanding `analyst` into `read` would be the wrong repair: the analyst set is a
 * *subset* of read, so the expansion would hand a reporting user the whole modelling
 * surface. And the SDK cannot express "any one of these". So there is no blanket gate,
 * and the test reads the server's own configuration rather than restating it — a fixed
 * scope reinstated here fails on whichever role it excludes.
 */
const source = readFileSync(new URL('../src/http.ts', import.meta.url), 'utf8');
const configured = source.match(/requiredScopes:\s*\[([^\]]*)\]/);
const requiredScopes = configured
  ? configured[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  : [];

/** Does the gate, as the server configures it, let a caller with these scopes through? */
function admits(scopes) {
  const middleware = requireBearerAuth({
    verifier: {
      verifyAccessToken: async () => ({
        token: 't',
        clientId: 'c',
        scopes,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    },
    requiredScopes,
  });

  return new Promise((resolve) => {
    const res = {
      status(s) { this._status = s; return this; },
      json() { resolve({ ok: false, status: this._status }); return this; },
      send() { resolve({ ok: false, status: this._status }); return this; },
      end() { resolve({ ok: false, status: this._status }); return this; },
      set() { return this; },
      setHeader() { return this; },
    };
    middleware({ headers: { authorization: 'Bearer t' } }, res, () => resolve({ ok: true }));
  });
}

test('a caller holding any one of the defined scopes reaches the server', async () => {
  for (const scope of SCOPES) {
    const verdict = await admits([scope]);
    assert.ok(
      verdict.ok,
      `a caller holding only '${scope}' was rejected with HTTP ${verdict.status} — ` +
        `the bearer gate requires ${JSON.stringify(requiredScopes)}`,
    );
  }
});

test('a token carrying no scope at all is still authenticated, and denied per tool', async () => {
  // Someone who signed in but holds no role collection. The gate lets them in; the first
  // tool call tells them which scopes would admit it, which is a better answer than a
  // bare 403 that names nothing.
  assert.ok((await admits([])).ok);
});
