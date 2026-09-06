import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Start the stdio server with extra env and return the initialize result. */
function initialize(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const srv = spawn('node', ['dist/stdio.js'], {
      env: { ...process.env, BW_URL: 'http://unused.invalid:8000', BW_USER: 'x', BW_PASSWORD: 'x', ...extraEnv },
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
          clearTimeout(timer);
          srv.kill();
          resolve(msg.result);
        }
      }
    });
  });
}

test('the default identity is unchanged, and the version is the package version', async () => {
  const result = await initialize();
  assert.equal(result.serverInfo.name, 'bw-modeling-mcp');
  // The advertised version was a hardcoded copy and had drifted to 0.1.0; it must
  // follow the package version from now on.
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(result.serverInfo.version, version);
});

test('instructions name the domain so deferring clients can decide to load the tools', async () => {
  const result = await initialize();
  assert.match(result.instructions, /SAP BW modeling/);
  assert.match(result.instructions, /One BW system per instance/);
});

test('BW_MCP_SERVER_NAME renames the instance in the handshake', async () => {
  const result = await initialize({ BW_MCP_SERVER_NAME: 'bw-mcp-prod' });
  assert.equal(result.serverInfo.name, 'bw-mcp-prod');
});

test('BW_MCP_SYSTEM_LABEL puts the connected system into the instructions', async () => {
  const label = 'AP4 (BW production, read-only)';
  const result = await initialize({ BW_MCP_SYSTEM_LABEL: label });
  // First line, so a model scanning several look-alike BW servers sees the difference
  // immediately instead of probing each with a tool call.
  assert.ok(result.instructions.startsWith(`Connected SAP BW system: ${label}.`));
  assert.match(result.instructions, /SAP BW modeling/);
});
