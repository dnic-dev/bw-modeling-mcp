import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CLASSIC_WRITE_STATUS } from '../dist/classic-writes.js';
import { filterToolsByPlatform } from '../dist/platform.js';

/** Tool names the server offers when the platform verdict is classic. */
function classicTools() {
  return new Promise((resolve, reject) => {
    const srv = spawn('node', ['dist/stdio.js'], {
      env: { ...process.env, BW_URL: 'http://unused.invalid:8000', BW_USER: 'x', BW_PASSWORD: 'x', BW_PLATFORM: 'classic' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const send = (m) => srv.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    let buf = '';
    const timer = setTimeout(() => { srv.kill(); reject(new Error('timeout')); }, 30000);
    srv.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        const msg = JSON.parse(l);
        if (msg.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); }
        else if (msg.id === 2) { clearTimeout(timer); srv.kill(); resolve(msg.result.tools.map((t) => t.name)); }
      }
    });
  });
}

const WRITE = /^bw_(create|update|delete|set|add|remove|move|activate|run|push|swap|append|change|unlock)/;

// The point of the table is that no write is left without a verdict. A tool added later
// must be classified, not silently inherit "not hidden, so it must work".
test('every write tool offered on classic carries a verdict', async () => {
  const offered = (await classicTools()).filter((t) => WRITE.test(t));
  const missing = offered.filter((t) => !CLASSIC_WRITE_STATUS[t]);
  assert.deepEqual(missing, [], `write tools without a verdict: ${missing.join(', ')}`);
});

test('the table describes no tool that classic does not offer', async () => {
  const offered = new Set(await classicTools());
  const stale = Object.keys(CLASSIC_WRITE_STATUS).filter((t) => !offered.has(t));
  assert.deepEqual(stale, [], `verdicts for tools not offered here: ${stale.join(', ')}`);
  void filterToolsByPlatform;
});
