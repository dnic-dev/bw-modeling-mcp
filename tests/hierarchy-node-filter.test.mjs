import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPostBody, hierarchyNodeType } from '../dist/tools/reporting.js';

const selectValues = (xml) => [...xml.matchAll(/<selectValue\b[^>]*\/>/g)].map((m) => m[0]);

test('a plain member filter carries no node type', () => {
  const [sv] = selectValues(buildPostBody('QUERY_NAME', {
    infoObjects: [{ name: 'CHAR_A', id: '1', axis: 'ROWS', filterValues: [{ lowInt: 'VALUE_1' }] }],
  }));
  assert.doesNotMatch(sv, /nodeName=/);
  assert.match(sv, /nodeId="0"/);
});

test('nodeId=1 without a type selects a characteristic-value node of the characteristic', () => {
  const [sv] = selectValues(buildPostBody('QUERY_NAME', {
    infoObjects: [{ name: 'CHAR_A', id: '1', axis: 'ROWS', filterValues: [{ lowInt: 'NODE_KEY', nodeId: 1 }] }],
  }));
  assert.match(sv, /lowInt="NODE_KEY" nodeId="1" nodeName="CHAR_A" hryMinLvl="0"/);
});

test('an explicit node type wins, e.g. a text node', () => {
  const [sv] = selectValues(buildPostBody('QUERY_NAME', {
    infoObjects: [{ name: 'CHAR_A', id: '1', axis: 'ROWS', filterValues: [{ low: '~ROOT', nodeId: 1, nodeType: '0HIER_NODE' }] }],
  }));
  assert.match(sv, /low="~ROOT" nodeId="1" nodeName="0HIER_NODE"/);
});

test('on a navigation attribute the default node type is the attribute', () => {
  assert.equal(hierarchyNodeType('CHAR_A__ATTR_B', { nodeId: 1 }), 'ATTR_B');
  assert.equal(hierarchyNodeType('CHAR_A', { nodeId: 0 }), undefined);
  assert.equal(hierarchyNodeType('CHAR_A', {}), undefined);
});

test('the node type is escaped like every other attribute', () => {
  const [sv] = selectValues(buildPostBody('QUERY_NAME', {
    infoObjects: [{ name: 'CHAR_A', id: '1', axis: 'ROWS', filterValues: [{ lowInt: 'K', nodeType: 'A"B' }] }],
  }));
  assert.match(sv, /nodeName="A&quot;B"/);
});
