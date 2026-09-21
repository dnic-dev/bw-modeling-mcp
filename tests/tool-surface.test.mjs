import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { requiredScope, filterToolsByScope } from '../dist/scopes.js';
import { filterToolsByPlatform, hiddenTools, isToolAvailable, unavailableReason } from '../dist/platform.js';

/**
 * Start the stdio server and ask it for its tool list.
 *
 * The BW URL does not resolve, so platform detection fails and the server falls back to the
 * full surface — which is the point for the counts below. `BW_PLATFORM` steers what the
 * fallback verdict is, so the same harness covers the forced-classic case.
 */
function listTools(env = {}) {
  return new Promise((resolve, reject) => {
    const srv = spawn('node', ['dist/stdio.js'], {
      env: { ...process.env, BW_URL: 'http://unused.invalid:8000', BW_USER: 'x', BW_PASSWORD: 'x', BW_PLATFORM: 'auto', ...env },
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
  assert.equal(names.length, 107);
});

test('every tool is classified, and the split matches the verb audit', async () => {
  const names = await listTools();
  const write = names.filter((n) => requiredScope(n) === 'write');
  assert.equal(write.length, 61);
  assert.equal(names.length - write.length, 46);
});

test('a reader is offered every read tool, analyst role or not', async () => {
  const names = await listTools();
  const offered = filterToolsByScope(names.map((name) => ({ name })), { token: 't', clientId: 'c', scopes: ['read'] });
  // Unchanged by the analyst role, which is additive: a reader kept bw_query_data.
  assert.equal(offered.length, 46);
  assert.ok(!offered.some((t) => requiredScope(t.name) === 'write'));
  assert.ok(offered.some((t) => t.name === 'bw_query_data'));
});

test('an analyst is offered a reporting surface small enough to work with', async () => {
  const names = await listTools();
  const offered = filterToolsByScope(names.map((name) => ({ name })), { token: 't', clientId: 'c', scopes: ['analyst'] });
  // The count is the point: a business client carrying all 107 tools picks the wrong one far
  // more often than one carrying fourteen, so growth here is a decision, not an accident.
  assert.equal(offered.length, 14);
  assert.ok(offered.some((t) => t.name === 'bw_query_data'));
  assert.ok(!offered.some((t) => t.name === 'bw_get_transformation'));
});

test('the MCP server is a per-request factory', async () => {
  // The SDK binds a Server to one transport for its lifetime; a shared instance throws
  // "Already connected to a transport" on the second HTTP request.
  const { createServer } = await import('../dist/index.js');
  assert.notEqual(createServer(), createServer());
});

// ── Platform filtering ───────────────────────────────────────────────────────

/** A profile as detection would build it, without needing a BW system. */
function profileOf(platform, collections = []) {
  return {
    platform,
    collections: new Set(collections),
    detected: true,
    filterEnabled: true,
    source: 'systeminfo',
    detail: 'test',
  };
}

test('detection failure leaves the full surface in place', async () => {
  // Fail open: a transient error must never hand a caller an empty or half server.
  const names = await listTools();
  assert.equal(names.length, 107);
});

test('a classic verdict filters even when discovery could not be read', async () => {
  // The static fallback layer: no collections to go by, so the platform verdict decides.
  const names = await listTools({ BW_PLATFORM: 'classic' });
  assert.equal(names.length, 62);
  for (const gone of ['bw_get_transformation', 'bw_get_dtp', 'bw_get_process_chain', 'bw_query_data', 'bw_push_data', 'bw_list_process_chain_runs', 'bw_list_requests', 'bw_get_dataflow']) {
    assert.ok(!names.includes(gone), `${gone} should be hidden on classic BW`);
  }
  // The reads that do work on classic stay — including the one tool every hidden read points
  // at, which is what makes hiding them an answer rather than a dead end.
  for (const kept of ['bw_get_adso', 'bw_get_infoobject', 'bw_get_query', 'bw_get_dtps', 'bw_read_metadata_tables', 'bw_create_transport_task', 'bw_get_filter_values']) {
    assert.ok(names.includes(kept), `${kept} should stay on classic BW`);
  }
});

test('BW_PLATFORM=bw4 switches the platform filter off entirely', async () => {
  // The escape hatch for a tool this catalog misjudges.
  const names = await listTools({ BW_PLATFORM: 'bw4' });
  assert.equal(names.length, 107);
});

test('published collections decide, not the platform label', async () => {
  // A classic system that did publish trfn would be offered the transformation tools; the
  // discovery document is the authority wherever it has something to say.
  const withTrfn = profileOf('classic', ['trfn', 'dtpa', 'rspc']);
  assert.ok(isToolAvailable('bw_get_transformation', withTrfn));
  assert.ok(isToolAvailable('bw_get_process_chain', withTrfn));
  // And a BW/4HANA system that lost one is not.
  const bw4WithoutCto = profileOf('bw4', ['trfn', 'dtpa', 'rspc']);
  assert.ok(!isToolAvailable('bw_list_changeable_transports', bw4WithoutCto));
  // The BW/4HANA-only APIs are not in discovery and follow the platform alone.
  assert.ok(!isToolAvailable('bw_push_data', withTrfn));
  assert.ok(isToolAvailable('bw_push_data', bw4WithoutCto));
});

test('InfoObject tools survive both spellings of their collection', () => {
  // Classic advertises the collection as `infoobject`, BW/4HANA as `iobj`; the resource is
  // `iobj` on both. Requiring one key would hide working tools on one of the two.
  for (const key of ['iobj', 'infoobject']) {
    const profile = profileOf('classic', [key, 'adso']);
    assert.equal(hiddenTools(['bw_get_infoobject', 'bw_update_infoobject'], profile).length, 0);
  }
});

test('the scope filter and the platform filter are independent', async () => {
  // A read-only caller on a classic system sees the intersection, and neither filter
  // changes what the other does.
  const names = await listTools({ BW_PLATFORM: 'bw4' }); // the unfiltered surface
  const all = names.map((name) => ({ name }));
  const reader = { token: 't', clientId: 'c', scopes: ['read'] };
  const classic = profileOf('classic');

  const scopeThenPlatform = filterToolsByPlatform(filterToolsByScope(all, reader), classic).map((t) => t.name);
  const platformThenScope = filterToolsByScope(filterToolsByPlatform(all, classic), reader).map((t) => t.name);
  assert.deepEqual(scopeThenPlatform, platformThenScope);
  assert.ok(scopeThenPlatform.every((n) => requiredScope(n) === 'read'));
  assert.ok(!scopeThenPlatform.includes('bw_get_transformation'));
  assert.ok(scopeThenPlatform.includes('bw_read_metadata_tables'));
});

test('a hidden tool names the call that answers the same question', () => {
  // Hiding a tool leaves the model with the question. Every hidden read that has a working
  // substitute must say what it is, in the message and in the instructions alike.
  const classic = profileOf('classic');
  const cases = {
    bw_get_transformation: /object_type="TRFN"/,
    bw_get_dtp: /object_type="DTPA"/,
    bw_get_process_chain: /object_type="RSPC"/,
    bw_list_requests: /bw_read_metadata_tables on the provider/,
    bw_get_dataflow: /bw_xref/,
    bw_get_planning_function: /object_type="PLSE"/,
    bw_get_planning_sequence: /object_type="PLSQ"/,
    bw_get_planning_properties: /object_type="PLCR"/,
    bw_list_process_chain_runs: /object_type="RSPCLOG".*chain name/,
    bw_get_process_chain_run_detail: /object_type="RSPCLOG".*log id/,
    bw_list_process_chain_last_status: /object_type="RSPCLOG".*pattern/,
  };
  for (const [tool, expected] of Object.entries(cases)) {
    const hidden = hiddenTools([tool], classic)[0];
    assert.ok(hidden, `${tool} should be hidden on classic BW`);
    // Reason and route are separate: the reason is shared by every tool that needs the same
    // resource, the route belongs to the one tool. The message a caller gets carries both.
    assert.match(hidden.route ?? '', expected);
    assert.ok(!hidden.reason.includes('On this system'), 'the reason stays free of the route');
    assert.match(unavailableReason(tool, classic), expected);
  }
});

test('the classic instructions list only the routes this system actually needs', async () => {
  const { platformInstructions } = await import('../dist/platform.js');
  // Nothing on BW/4HANA: no tool is hidden, so there is nothing to redirect.
  assert.equal(platformInstructions(profileOf('bw4', ['trfn', 'dtpa', 'rspc', 'reporting', 'dmod'])).length, 0);

  const text = platformInstructions(profileOf('classic')).join('\n');
  assert.match(text, /classic SAP BW/);
  assert.match(text, /object_type="TRFN"/);
  assert.match(text, /ADT\s*\n?\s*DataPreview/);

  // A classic system that does publish trfn gets no line about transformations — the list
  // follows what is hidden, not a fixed text.
  const withTrfn = platformInstructions(profileOf('classic', ['trfn'])).join('\n');
  assert.ok(!withTrfn.includes('object_type="TRFN"'));
  assert.match(withTrfn, /object_type="RSPC"/);
});
