import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requiredScope, scopesFor, mayCall, hasScope, filterToolsByScope } from '../dist/scopes.js';

const caller = (...scopes) => ({ token: 't', clientId: 'c', scopes });

test('mutating tools require write — including ones whose names do not say so', () => {
  for (const n of ['bw_create_adso', 'bw_update_query_layout', 'bw_delete', 'bw_activate', 'bw_push_data', 'bw_run_dtp']) {
    assert.equal(requiredScope(n), 'write', n);
  }
  // bw_unlock reads as harmless but mutates server-side lock state.
  assert.equal(requiredScope('bw_unlock'), 'write');
  assert.equal(requiredScope('bw_delete_request'), 'write');
});

test('reading POSTs stay reads, and only one of them is reporting', () => {
  // Both POST and neither changes anything, but they serve different people:
  // bw_query_data answers a business question, bw_preview_datasource samples source-system
  // rows while modelling an extraction — an ETL task, so it is not in the analyst client.
  assert.deepEqual(scopesFor('bw_query_data'), ['read', 'analyst', 'write']);
  assert.deepEqual(scopesFor('bw_preview_datasource'), ['read', 'write']);
});

test('a tool both roles need is admitted by both', () => {
  // A query definition is read by a consultant to understand the model and by an analyst to
  // know what the numbers mean. Forcing it into one role would cripple the other.
  assert.deepEqual(scopesFor('bw_get_query'), ['read', 'analyst', 'write']);
  assert.ok(mayCall('bw_get_query', caller('read')));
  assert.ok(mayCall('bw_get_query', caller('analyst')));
});

test('the analyst role carries reporting and not the modelling surface', () => {
  const analyst = caller('analyst');
  for (const n of ['bw_query_data', 'bw_get_filter_values', 'bw_search', 'bw_get_roles', 'bw_list_requests']) {
    assert.ok(mayCall(n, analyst), `${n} should be available to an analyst`);
  }
  // The point of the role is what it leaves out: a business user has no use for these, and a
  // smaller tool list is what keeps a model from reaching for the wrong one.
  for (const n of ['bw_get_transformation', 'bw_get_dtp', 'bw_get_process_chain', 'bw_read_metadata_tables', 'bw_list_contents', 'bw_preview_datasource']) {
    assert.ok(!mayCall(n, analyst), `${n} should not be available to an analyst`);
  }
});

test('adding the analyst role took nothing away from a reader', () => {
  // The role is additive on purpose: it gives a business user a smaller client, it does not
  // narrow anyone's permissions. Every analyst tool is a read tool too.
  const reader = caller('read');
  assert.ok(mayCall('bw_query_data', reader));
  assert.ok(mayCall('bw_get_filter_values', reader));
  assert.ok(mayCall('bw_get_transformation', reader));
});

test('an unrecognised tool requires write, so a new tool fails closed', () => {
  // A tool added later without updating scopes.ts must not be offered to readers or analysts.
  assert.equal(requiredScope('bw_some_future_tool'), 'write');
  assert.ok(!mayCall('bw_delete_everything_new', caller('read')));
  assert.ok(!mayCall('bw_delete_everything_new', caller('analyst')));
});

test('write implies the other two; neither of those implies write', () => {
  const w = caller('write');
  assert.ok(hasScope(w, 'read'));
  assert.ok(hasScope(w, 'analyst'));
  assert.ok(hasScope(w, 'write'));
  assert.ok(!hasScope(caller('read'), 'write'));
  assert.ok(!hasScope(caller('analyst'), 'write'));
  // The scopes themselves stay separate — holding `read` does not grant the `analyst` scope
  // — even though every tool the analyst set contains is also in the read set.
  assert.ok(!hasScope(caller('read'), 'analyst'));
  assert.ok(!hasScope(caller('analyst'), 'read'));
});

test('every analyst tool is also a read tool', () => {
  // The invariant behind "additive": adding a tool to the reporting client must never be a
  // way to expose something a reader could not already call.
  const analyst = caller('analyst');
  const reader = caller('read');
  for (const n of ['bw_query_data', 'bw_get_filter_values', 'bw_search', 'bw_get_roles',
    'bw_get_role_queries', 'bw_get_query', 'bw_get_ckf', 'bw_get_rkf', 'bw_get_structure',
    'bw_get_infoobject', 'bw_get_composite_provider', 'bw_get_adso',
    'bw_get_aggregation_level', 'bw_list_requests']) {
    assert.ok(mayCall(n, analyst), `${n} missing from the analyst role`);
    assert.ok(mayCall(n, reader), `${n} must stay available to a reader`);
  }
});

test('a caller can hold both roles', () => {
  const both = caller('read', 'analyst');
  assert.ok(mayCall('bw_get_transformation', both));
  assert.ok(mayCall('bw_query_data', both));
  assert.ok(!mayCall('bw_create_adso', both));
});

test('XSUAA-qualified scopes are accepted', () => {
  assert.ok(hasScope(caller('bwmcp!t42.write'), 'write'));
  assert.ok(mayCall('bw_query_data', caller('bwmcp!t42.analyst')));
});

test('stdio has no authInfo and is unrestricted', () => {
  assert.ok(hasScope(undefined, 'write'));
  assert.ok(mayCall('bw_query_data', undefined));
  const tools = [{ name: 'bw_get_adso' }, { name: 'bw_delete' }];
  assert.equal(filterToolsByScope(tools, undefined).length, 2);
});

test('the tool list a caller sees matches the role', () => {
  const tools = [
    { name: 'bw_query_data' },
    { name: 'bw_get_query' },
    { name: 'bw_get_transformation' },
    { name: 'bw_create_adso' },
  ];
  assert.deepEqual(filterToolsByScope(tools, caller('analyst')).map((t) => t.name), ['bw_query_data', 'bw_get_query']);
  assert.deepEqual(filterToolsByScope(tools, caller('read')).map((t) => t.name), ['bw_query_data', 'bw_get_query', 'bw_get_transformation']);
  assert.equal(filterToolsByScope(tools, caller('write')).length, 4);
});
