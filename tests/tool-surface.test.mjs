import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { requiredScope, filterToolsByScope } from '../dist/scopes.js';

/** Start the stdio server and ask it for its tool list. */
function listTools() {
  return new Promise((resolve, reject) => {
    const srv = spawn('node', ['dist/stdio.js'], {
      env: { ...process.env, BW_URL: 'http://unused.invalid:8000', BW_USER: 'x', BW_PASSWORD: 'x' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const send = (m) => srv.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    let buf = '';
    const timer = setTimeout(() => { srv.kill(); reject(new Error('timeout')); }, 20000);
    srv.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        const msg = JSON.parse(l);
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        } else if (msg.id === 2) {
          clearTimeout(timer);
          srv.kill();
          resolve(msg.result.tools.map((t) => t.name));
        }
      }
    });
  });
}

test('the full tool surface is still registered', async () => {
  // This change is additive — a transport and an auth layer. It must not alter the
  // tools stdio users already depend on.
  const names = await listTools();
  assert.equal(names.length, 99);
});

test('every tool is classified, and the split matches the verb audit', async () => {
  const names = await listTools();
  const write = names.filter((n) => requiredScope(n) === 'write');
  assert.equal(write.length, 54);
  assert.equal(names.length - write.length, 45);
});

test('a reader is offered only the read tools', async () => {
  const names = await listTools();
  const offered = filterToolsByScope(names.map((name) => ({ name })), { token: 't', clientId: 'c', scopes: ['read'] });
  assert.equal(offered.length, 45);
  assert.ok(!offered.some((t) => requiredScope(t.name) === 'write'));
});

test('the MCP server is a per-request factory', async () => {
  // The SDK binds a Server to one transport for its lifetime; a shared instance throws
  // "Already connected to a transport" on the second HTTP request.
  const { createServer } = await import('../dist/index.js');
  assert.notEqual(createServer(), createServer());
});
