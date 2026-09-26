import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuditLogBindingError,
  AuditLogSink,
  categoryFor,
  parseAuditLogConfig,
  resultMetrics,
} from '../dist/audit.js';

const X509_UAA = {
  certurl: 'https://sub.authentication.cert.example.com',
  clientid: 'sb-auditlog',
  certificate: '-----BEGIN CERTIFICATE-----',
  key: '-----BEGIN RSA PRIVATE KEY-----',
};

const binding = (uaa, plan = 'premium') =>
  JSON.stringify({
    auditlog: [{ plan, credentials: { url: 'https://api.auditlog.cf.example.com:6081', uaa } }],
  });

test('no binding means auditing stays off', () => {
  assert.equal(parseAuditLogConfig({}), undefined);
  assert.equal(parseAuditLogConfig({ VCAP_SERVICES: JSON.stringify({ xsuaa: [] }) }), undefined);
});

test('a malformed VCAP_SERVICES does not crash the server', () => {
  assert.equal(parseAuditLogConfig({ VCAP_SERVICES: 'not json' }), undefined);
});

test('an x509 binding is parsed', () => {
  const config = parseAuditLogConfig({ VCAP_SERVICES: binding(X509_UAA) });
  assert.equal(config.url, 'https://api.auditlog.cf.example.com:6081');
  assert.equal(config.uaa.certurl, X509_UAA.certurl);
  assert.equal(config.uaa.certificate, X509_UAA.certificate);
});

test('a binding-secret binding is refused, naming the missing fields and the fix', () => {
  // The broker's default. It can never authenticate against the mTLS token endpoint, so
  // starting a sink on it would drop every event with nothing to notice.
  const env = {
    VCAP_SERVICES: binding({
      clientid: 'sb-auditlog',
      clientsecret: 'unusable-for-this-plan',
      'credential-type': 'binding-secret',
    }),
  };
  assert.throws(() => parseAuditLogConfig(env), AuditLogBindingError);
  assert.throws(() => parseAuditLogConfig(env), /uaa\.certurl, uaa\.certificate, uaa\.key/);
  assert.throws(() => parseAuditLogConfig(env), /credential-type "binding-secret"/);
  assert.throws(() => parseAuditLogConfig(env), /"credential-types":\["x509"\]/);
  assert.throws(() => parseAuditLogConfig(env), /delete and re-create/);
});

test('a partially populated binding names only what is missing', () => {
  const env = { VCAP_SERVICES: binding({ certurl: X509_UAA.certurl, certificate: 'x', clientid: 'c' }) };
  try {
    parseAuditLogConfig(env);
    assert.fail('expected a refusal');
  } catch (err) {
    assert.ok(err instanceof AuditLogBindingError);
    assert.deepEqual(err.missing, ['key']);
    assert.equal(err.plan, 'premium');
  }
});

test('categories follow the scope classification, with configuration changes called out', () => {
  assert.equal(categoryFor('bw_get_adso'), 'data-accesses');
  assert.equal(categoryFor('bw_query_data'), 'data-accesses');
  assert.equal(categoryFor('bw_search'), 'data-accesses');
  assert.equal(categoryFor('bw_update_adso'), 'data-modifications');
  assert.equal(categoryFor('bw_push_data'), 'data-modifications');
  assert.equal(categoryFor('bw_activate'), 'configuration-changes');
  assert.equal(categoryFor('bw_change_package'), 'configuration-changes');
  assert.equal(categoryFor('bw_create_transport_task'), 'configuration-changes');
  // An unknown tool requires `write`, so it must not be filed as a mere read.
  assert.equal(categoryFor('bw_some_future_tool'), 'data-modifications');
});

test('the analyst scope is an access, not a modification', () => {
  // `analyst` is a third scope and a strict subset of `read`. The category is decided by
  // "does it require write?" precisely so a reporting tool cannot be filed as a change.
  for (const tool of ['bw_query_data', 'bw_get_filter_values', 'bw_get_roles', 'bw_get_rkf']) {
    assert.equal(categoryFor(tool), 'data-accesses', tool);
  }
});

test('tools added to the server are categorised without touching this module', () => {
  // These arrived with a later release and are classified only in scopes.ts — the point of
  // deriving the category from the scope instead of keeping a second list here.
  for (const tool of ['bw_create_ckf', 'bw_update_ckf', 'bw_update_rkf', 'bw_create_structure',
    'bw_update_structure', 'bw_delete_request']) {
    assert.equal(categoryFor(tool), 'data-modifications', tool);
  }
});

/** A sink whose token and HTTP calls are stubbed, so the payload is the only thing under test. */
function sinkWithCapture() {
  const calls = [];
  const warnings = [];
  const sink = new AuditLogSink(
    { url: 'https://api.auditlog.test', uaa: X509_UAA },
    { info: () => {}, warn: (m, x) => warnings.push({ m, x }) },
    'BW4',
  );
  sink.getToken = async () => 'test-token';
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return { ok: true, status: 201, text: async () => '' };
  };
  return { sink, calls, warnings };
}

test('a data access carries data_subject, without which the Write API rejects it', async () => {
  const { sink, calls } = sinkWithCapture();
  sink.write({ tool: 'bw_query_data', user: 'jane@example.com', args: { query: 'ZQ1' } }, 'data-accesses');
  await sink.flush();

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/audit-log\/oauth2\/v2\/data-accesses$/);
  assert.deepEqual(calls[0].body.data_subject, {
    type: 'bw-system',
    role: 'data-owner',
    id: { system: 'BW4' },
  });
  assert.equal(calls[0].body.user, 'jane@example.com');
  assert.equal(calls[0].body.tenant, '$PROVIDER');
  const attrs = Object.fromEntries(calls[0].body.attributes.map((a) => [a.name, a.new]));
  assert.equal(attrs.tool, 'bw_query_data');
  assert.equal(attrs.args, '{"query":"ZQ1"}');
});

test('data modifications carry data_subject too', async () => {
  const { sink, calls } = sinkWithCapture();
  sink.write({ tool: 'bw_update_adso', user: 'jane', outcome: 'success', durationMs: 12 }, 'data-modifications');
  await sink.flush();

  assert.match(calls[0].url, /\/data-modifications$/);
  assert.equal(calls[0].body.data_subject.id.system, 'BW4');
  const attrs = Object.fromEntries(calls[0].body.attributes.map((a) => [a.name, a.new]));
  assert.equal(attrs.status, 'success');
  assert.equal(attrs.durationMs, '12');
});

test('security events and configuration changes carry no data_subject', async () => {
  // SAP's schema has no such field for these categories.
  const { sink, calls } = sinkWithCapture();
  sink.write({ tool: 'bw_update_adso', user: 'jane', denialReason: "requires the 'write' scope" }, 'security-events');
  sink.write({ tool: 'bw_activate', user: 'jane', outcome: 'success' }, 'configuration-changes');
  await sink.flush();

  assert.equal(calls.length, 2);
  for (const call of calls) assert.ok(!('data_subject' in call.body));
  assert.match(calls[0].body.data, /denied for user "jane".*requires the 'write' scope/);
  assert.ok(!('attributes' in calls[0].body));
});

test('long arguments are truncated so one call cannot blow the 10 KB message limit', async () => {
  const { sink, calls } = sinkWithCapture();
  sink.write({ tool: 'bw_set_transformation_routine', user: 'jane', args: { routine: 'X'.repeat(4000) } }, 'data-modifications');
  await sink.flush();

  const attrs = Object.fromEntries(calls[0].body.attributes.map((a) => [a.name, a.new]));
  assert.ok(attrs.args.length <= 503, `args were ${attrs.args.length} characters`);
  assert.ok(attrs.args.endsWith('...'));
});

test('a failing backend warns once per minute and never throws at the caller', async () => {
  const { sink, warnings } = sinkWithCapture();
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });

  // The write() calls themselves must not reject — a broken audit backend cannot be
  // allowed to surface as a tool failure.
  for (let i = 0; i < 5; i++) sink.write({ tool: 'bw_get_adso', user: 'jane' }, 'data-accesses');
  await sink.flush();

  assert.equal(warnings.length, 1, 'expected the repeats within the interval to be suppressed');
  assert.match(String(warnings[0].x.message), /HTTP 500/);
  // Nothing was suppressed *before* the first warning, so no count is reported yet.
  assert.equal(warnings[0].x.suppressedSince, undefined);
});

test('the next warning after the interval reports how many were suppressed meanwhile', async () => {
  const { sink, warnings } = sinkWithCapture();
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });

  for (let i = 0; i < 5; i++) sink.write({ tool: 'bw_get_adso', user: 'jane' }, 'data-accesses');
  await sink.flush();
  assert.equal(warnings.length, 1);

  // Pretend a minute passed rather than waiting for one.
  sink.lastWarnAt = 0;
  sink.write({ tool: 'bw_get_adso', user: 'jane' }, 'data-accesses');
  await sink.flush();

  assert.equal(warnings.length, 2);
  assert.equal(warnings[1].x.suppressedSince, 4, 'the four suppressed failures should be reported');
});

// A shortened but otherwise faithful bw_query_data rendering — the only tool output that
// states its own row count. The marker in src/tools/reporting.ts carries a pointer to the
// extractor, so a wording change there is meant to be changed here too.
const QUERY_OUTPUT = [
  'Query/Provider: EXAMPLE_QUERY',
  'Row range: 1–4',
  '',
  '── Result (4 rows × 2 columns) ──',
  'Customer | Revenue | Quantity',
  '-------------------------------',
  'C-1000 | 12.500,00 | 42',
].join('\n');

test('a stated row count is picked up, so the trail shows how much was read', () => {
  const m = resultMetrics(QUERY_OUTPUT);
  assert.equal(m.resultRows, 4);
  assert.equal(m.resultLines, 7);
  assert.equal(m.resultChars, QUERY_OUTPUT.length);
});

test('output without a stated row count still reports its size', () => {
  // Most tools render prose or a tree, so there is no row count to have. Reporting a
  // guessed one would be worse than reporting none.
  const m = resultMetrics('Platform: SAP BW/4HANA\nChangeable: yes');
  assert.equal(m.resultRows, undefined);
  assert.equal(m.resultLines, 2);
  assert.equal(m.resultChars, 38);

  const empty = resultMetrics('');
  assert.equal(empty.resultLines, 0);
  assert.equal(empty.resultChars, 0);
});

test('the result metrics reach the audit record', async () => {
  const { sink, calls } = sinkWithCapture();
  sink.write(
    { tool: 'bw_query_data', user: 'jane', outcome: 'success', result: resultMetrics(QUERY_OUTPUT) },
    'data-accesses',
  );
  await sink.flush();

  const attrs = Object.fromEntries(calls[0].body.attributes.map((a) => [a.name, a.new]));
  assert.equal(attrs.resultRows, '4');
  assert.equal(attrs.resultLines, '7');
  assert.equal(attrs.resultChars, String(QUERY_OUTPUT.length));
  // The data itself must not travel: no customer, no figure.
  assert.ok(!JSON.stringify(calls[0].body).includes('C-1000'));
});

test('no row count means no attribute, rather than a zero that reads as "nothing read"', async () => {
  const { sink, calls } = sinkWithCapture();
  sink.write(
    { tool: 'bw_get_adso', user: 'jane', outcome: 'success', result: resultMetrics('a\nb') },
    'data-accesses',
  );
  await sink.flush();

  const names = calls[0].body.attributes.map((a) => a.name);
  assert.ok(!names.includes('resultRows'));
  assert.ok(names.includes('resultChars'));
});
