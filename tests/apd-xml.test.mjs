import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApdXml, orderApdNodes } from '../dist/tools/metadata_apd.js';

// The whole definition of an analysis process is one XML document in RSANT_PROCESS.XML. The
// nodes are its tags, the edges sit in a separate <MAPPINGS> block, and the order the nodes
// appear in says nothing about the order they run in — the same trap as with process chains.
// These pin the parsing and the ordering against a cut-down copy of a real document.

const XML = `<?xml version="1.0" encoding="utf-16"?>
<ANALYSIS_PROCESS xmlns="http://www.sap.com/gbu-fin/a-crm/analysis.30b.1" NAME="NEW_ANALYSIS" TEXT="Test">
 <MAPPINGS>
  <MAPPING NAME="MAPPING2" TEXT="Feldzuordnung 2" SOURCE="DST_JOIN1" TARGET="DT_ODS1"/>
  <MAPPING NAME="MAPPING1" TEXT="Feldzuordnung 1" SOURCE="DS_QUERY1" TARGET="DST_JOIN1"/>
  <MAPPING NAME="MAPPING3" TEXT="Feldzuordnung 3" SOURCE="DS_INFOPROV1" TARGET="DST_JOIN1"/>
 </MAPPINGS>
 <NODES>
  <DT_ODS NAME="DT_ODS1" TEXT="Ziel" ODS="ZTARGET"><KEYS/></DT_ODS>
  <DST_JOIN NAME="DST_JOIN1" TEXT="Join" TYPE="INNER JOIN"><FIELDS/></DST_JOIN>
  <DS_QUERY NAME="DS_QUERY1" TEXT="Query 1" REPORT_ID="IPROV/QUERY1"/>
  <DS_INFOPROV NAME="DS_INFOPROV1" TEXT="Provider" INFOPROV="ZPROV"/>
 </NODES>
</ANALYSIS_PROCESS>`;

test('nodes carry their type from the tag, not from their name', () => {
  const { nodes } = parseApdXml(XML);
  assert.deepEqual(
    nodes.map((n) => [n.type, n.name]).sort(),
    [
      ['DST_JOIN', 'DST_JOIN1'],
      ['DS_INFOPROV', 'DS_INFOPROV1'],
      ['DS_QUERY', 'DS_QUERY1'],
      ['DT_ODS', 'DT_ODS1'],
    ].sort(),
  );
  // The object a node touches sits in a type-specific attribute.
  assert.equal(nodes.find((n) => n.type === 'DT_ODS').attributes.ODS, 'ZTARGET');
  assert.equal(nodes.find((n) => n.type === 'DS_QUERY').attributes.REPORT_ID, 'IPROV/QUERY1');
});

test('self-closing and paired node elements are both read', () => {
  // DS_QUERY is self-closing, DT_ODS has a body. Reading only one shape drops half the graph.
  const { nodes } = parseApdXml(XML);
  assert.equal(nodes.length, 4);
  assert.equal(nodes.find((n) => n.name === 'DS_QUERY1').body, '');
  assert.match(nodes.find((n) => n.name === 'DT_ODS1').body, /<KEYS\/>/);
});

test('edges come from the mappings, in whatever order they are written', () => {
  const { edges } = parseApdXml(XML);
  assert.equal(edges.length, 3);
  assert.deepEqual(
    edges.map((e) => `${e.source}->${e.target}`).sort(),
    ['DST_JOIN1->DT_ODS1', 'DS_INFOPROV1->DST_JOIN1', 'DS_QUERY1->DST_JOIN1'].sort(),
  );
});

test('execution order follows the edges, not the document', () => {
  // The document lists the target first and the sources last; run in that order the process
  // would write before it reads.
  const { nodes, edges } = parseApdXml(XML);
  const { ordered, cyclic } = orderApdNodes(nodes, edges);
  assert.deepEqual(cyclic, []);
  const position = (name) => ordered.findIndex((n) => n.name === name);
  assert.ok(position('DS_QUERY1') < position('DST_JOIN1'));
  assert.ok(position('DS_INFOPROV1') < position('DST_JOIN1'));
  assert.ok(position('DST_JOIN1') < position('DT_ODS1'));
});

test('a node fed by two sources waits for both', () => {
  // Fan-in is the case the ordering has to get right: the join must not appear before either
  // of its two inputs, whichever order they happen to be parsed in.
  const { nodes, edges } = parseApdXml(XML);
  const { ordered } = orderApdNodes(nodes, edges);
  const join = ordered.findIndex((n) => n.name === 'DST_JOIN1');
  const inputs = ['DS_QUERY1', 'DS_INFOPROV1'].map((n) => ordered.findIndex((o) => o.name === n));
  assert.ok(inputs.every((i) => i >= 0 && i < join));
});

test('a cycle ends the ordering instead of looping, and is reported', () => {
  // A definition the editor should not produce, but a corrupted one can: dropping the nodes
  // would report the process as smaller than it is, and looping would hang the read.
  const cyclicXml = XML.replace(
    '<MAPPING NAME="MAPPING2" TEXT="Feldzuordnung 2" SOURCE="DST_JOIN1" TARGET="DT_ODS1"/>',
    '<MAPPING NAME="MAPPING2" SOURCE="DST_JOIN1" TARGET="DT_ODS1"/>' +
      '<MAPPING NAME="MAPPING4" SOURCE="DT_ODS1" TARGET="DST_JOIN1"/>',
  );
  const { nodes, edges } = parseApdXml(cyclicXml);
  const { ordered, cyclic } = orderApdNodes(nodes, edges);
  assert.equal(cyclic.length, 2, 'the two nodes in the cycle cannot be ordered');
  assert.equal(ordered.length + cyclic.length, nodes.length, 'no node is lost');
});

test('a document without mappings still yields its nodes', () => {
  const noEdges = XML.replace(/<MAPPINGS>[\s\S]*?<\/MAPPINGS>/, '');
  const { nodes, edges } = parseApdXml(noEdges);
  assert.equal(nodes.length, 4);
  assert.deepEqual(edges, []);
  assert.equal(orderApdNodes(nodes, edges).cyclic.length, 0);
});
