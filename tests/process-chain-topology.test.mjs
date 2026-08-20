// Regression tests for the process-chain topology helpers. Pure model work — no BW system
// needed. Guards the failure mode from issue #6: a step inserted into an existing chain
// ended up on a PARALLEL strand instead of in series, so the following step could start
// before the new block had finished.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveChainNodeRef,
  chainNodeLabel,
  defaultStatusForNode,
  addChainEdge,
  removeChainEdges,
  removeChainStep,
  spliceBlockInSeries,
} from '../dist/tools/processchain_write.js';

// The chain pattern from the issue, reduced to what the topology cares about:
//   [0] TRIGGER → [1] ABAP(delete) → [2] DTP(load) → [3] ADSOACT
const chain = () => ({
  aNode: [
    { sProcessType: 'TRIGGER', bIsReference: false, sProcessVariant: 'ILV_TRIGGER' },
    { sProcessType: 'ABAP', bIsReference: false, sProcessVariant: 'ILV_PROG' },
    { sProcessType: 'DTP_LOAD', bIsReference: true, sProcessVariant: 'DTP_LOAD_X' },
    { sProcessType: 'ADSOACT', bIsReference: false, sProcessVariant: 'ILV_ACT' },
  ],
  aEdge: [
    { iNodeIndexFrom: 0, iNodeIndexTo: 1, sStatus: 'neutral', sSubStatus: '00' },
    { iNodeIndexFrom: 1, iNodeIndexTo: 2, sStatus: 'positive', sSubStatus: '00' },
    { iNodeIndexFrom: 2, iNodeIndexTo: 3, sStatus: 'positive', sSubStatus: '00' },
  ],
  aInlineVariant: [
    { sProcessVariant: 'ILV_TRIGGER', oDetail: { startdttyp: 'I' } },
    { sProcessVariant: 'ILV_PROG', oDetail: { PROGRAM: [{ key: 'REPORT_DELETE' }], VARIANT: [{ key: 'VARIANT_X' }] } },
    { sProcessVariant: 'ILV_ACT', oDetail: { DATASTORES: [{ DATASTORE: 'ADSO_X' }] } },
  ],
});

// Append a two-node block (DTP + ADSOACT) at the end of aNode with its internal link
// already drawn but nothing connecting it to the chain — the exact state the append tools
// are in right before they place the block.
function appendBlock(model, dtpName, adsoName) {
  const dtpIdx = model.aNode.length;
  model.aNode.push({ sProcessType: 'DTP_LOAD', bIsReference: true, sProcessVariant: dtpName });
  const actIdx = model.aNode.length;
  model.aNode.push({ sProcessType: 'ADSOACT', bIsReference: false, sProcessVariant: 'INLINE_NEW' });
  model.aInlineVariant.push({
    sProcessVariant: 'INLINE_NEW',
    oDetail: { DATASTORES: [{ DATASTORE: adsoName }] },
  });
  model.aEdge.push({ iNodeIndexFrom: dtpIdx, iNodeIndexTo: actIdx, sStatus: 'positive', sSubStatus: '00' });
  return [dtpIdx, actIdx];
}

const successOnly = (model) => (from, to) =>
  model.aEdge.push({ iNodeIndexFrom: from, iNodeIndexTo: to, sStatus: 'positive', sSubStatus: '00' });

const edgeSet = (model) =>
  model.aEdge.map((e) => `${e.iNodeIndexFrom}->${e.iNodeIndexTo}:${e.sStatus}/${e.sSubStatus ?? '00'}`).sort();

const succ = (model, i) =>
  model.aEdge.filter((e) => e.iNodeIndexFrom === i).map((e) => e.iNodeIndexTo).sort();

// ── Node references ──────────────────────────────────────────────────────────────

test('a node is found by variant name, aDSO, ABAP program and index', () => {
  const model = chain();
  assert.equal(resolveChainNodeRef(model, 'DTP_LOAD_X'), 2);
  assert.equal(resolveChainNodeRef(model, 'ADSO_X'), 3);
  assert.equal(resolveChainNodeRef(model, 'REPORT_DELETE'), 1);
  assert.equal(resolveChainNodeRef(model, 'REPORT_DELETE/VARIANT_X'), 1);
  assert.equal(resolveChainNodeRef(model, 'TRIGGER'), 0);
  assert.equal(resolveChainNodeRef(model, '#3'), 3);
  assert.equal(resolveChainNodeRef(model, 'dtp_load_x'), 2);
});

test('an ambiguous reference is rejected instead of silently picking a node', () => {
  const model = chain();
  // A second ABAP step calling the same report with a different selection variant.
  model.aNode.push({ sProcessType: 'ABAP', bIsReference: false, sProcessVariant: 'ILV_PROG2' });
  model.aInlineVariant.push({
    sProcessVariant: 'ILV_PROG2',
    oDetail: { PROGRAM: [{ key: 'REPORT_DELETE' }], VARIANT: [{ key: 'VARIANT_Y' }] },
  });
  assert.throws(() => resolveChainNodeRef(model, 'REPORT_DELETE'), /ambiguous/);
  // The program/variant form and the index form stay unambiguous.
  assert.equal(resolveChainNodeRef(model, 'REPORT_DELETE/VARIANT_Y'), 4);
  assert.equal(resolveChainNodeRef(model, '#1'), 1);
});

test('an unknown reference lists the chain nodes', () => {
  const model = chain();
  assert.throws(() => resolveChainNodeRef(model, 'DTP_MISSING'), /matches no node/);
  assert.throws(() => resolveChainNodeRef(model, 'DTP_MISSING'), /DTP_LOAD_X/);
});

test('a node label names the program and the aDSO behind an inline variant', () => {
  const model = chain();
  assert.equal(chainNodeLabel(model, 1), '#1 ABAP REPORT_DELETE/VARIANT_X');
  assert.equal(chainNodeLabel(model, 3), '#3 ADSOACT ADSO_X');
});

// ── Edge defaults ────────────────────────────────────────────────────────────────

test('edges out of the trigger and out of a collector default to neutral', () => {
  const model = chain();
  model.aNode.push({ sProcessType: 'OR' });
  assert.equal(defaultStatusForNode(model, 0), 'neutral');
  assert.equal(defaultStatusForNode(model, 4), 'neutral');
  assert.equal(defaultStatusForNode(model, 2), 'positive');
});

test('a branch edge is forced positive and an identical edge is not duplicated', () => {
  const model = chain();
  const branch = addChainEdge(model, 2, 3, undefined, '01');
  assert.equal(branch.sStatus, 'positive');
  assert.equal(branch.sSubStatus, '01');
  assert.equal(addChainEdge(model, 2, 3, undefined, '01'), null);
  assert.throws(() => addChainEdge(model, 2, 2), /itself/);
});

// ── Gap 1: in-series insertion ───────────────────────────────────────────────────

test('before puts the whole block in series ahead of the target', () => {
  const model = chain();
  const block = appendBlock(model, 'DTP_LOAD_NEW', 'ADSO_NEW');
  spliceBlockInSeries(model, block, 'before', 2, successOnly(model));

  // Expected: TRIGGER → ABAP → DTP_NEW → ADSOACT_NEW → DTP_X → ADSOACT_X
  assert.deepEqual(succ(model, 1), [4], 'the ABAP step must now lead into the block only');
  assert.deepEqual(succ(model, 4), [5], 'the new DTP leads to the new activation');
  assert.deepEqual(succ(model, 5), [2], 'the block hands over to the former target');
  assert.deepEqual(succ(model, 2), [3], "the target's own successor is untouched");
  // Nothing runs alongside the block — that was the bug.
  assert.equal(model.aEdge.filter((e) => e.iNodeIndexFrom === 1).length, 1);
});

test('before keeps the condition of each rerouted edge, including a decision branch', () => {
  const model = chain();
  // Turn the ABAP step into a DECISION whose THEN branch feeds the DTP.
  model.aNode[1] = { sProcessType: 'DECISION', bIsReference: true, sProcessVariant: 'DEC_VAR' };
  model.aEdge[1] = { iNodeIndexFrom: 1, iNodeIndexTo: 2, sStatus: 'positive', sSubStatus: '01' };
  const block = appendBlock(model, 'DTP_LOAD_NEW', 'ADSO_NEW');
  spliceBlockInSeries(model, block, 'before', 2, successOnly(model));

  const rerouted = model.aEdge.find((e) => e.iNodeIndexFrom === 1);
  assert.equal(rerouted.iNodeIndexTo, 4, 'the branch now leads into the block');
  assert.equal(rerouted.sSubStatus, '01', 'the branch condition must survive the move');
});

test('after puts the block between the target and its former successors', () => {
  const model = chain();
  const block = appendBlock(model, 'DTP_LOAD_NEW', 'ADSO_NEW');
  spliceBlockInSeries(model, block, 'after', 1, successOnly(model));

  // Expected: TRIGGER → ABAP → DTP_NEW → ADSOACT_NEW → DTP_X → ADSOACT_X
  assert.deepEqual(succ(model, 1), [4]);
  assert.deepEqual(succ(model, 5), [2]);
  assert.deepEqual(succ(model, 2), [3]);
});

test('after a terminal step is a plain append, since there is nothing to reroute', () => {
  const model = chain();
  const block = appendBlock(model, 'DTP_LOAD_NEW', 'ADSO_NEW');
  spliceBlockInSeries(model, block, 'after', 3, successOnly(model));
  assert.deepEqual(succ(model, 3), [4]);
  assert.deepEqual(succ(model, 5), []);
});

test('before a start node is refused rather than silently appended', () => {
  const model = chain();
  model.aEdge = [];
  const block = appendBlock(model, 'DTP_LOAD_NEW', 'ADSO_NEW');
  assert.throws(() => spliceBlockInSeries(model, block, 'before', 2, successOnly(model)), /no incoming edge/);
});

test('the insertion target cannot be part of the block', () => {
  const model = chain();
  const block = appendBlock(model, 'DTP_LOAD_NEW', 'ADSO_NEW');
  assert.throws(() => spliceBlockInSeries(model, block, 'before', block[1], successOnly(model)), /part of the inserted block/);
});

// ── Gap 2: edge and step maintenance ─────────────────────────────────────────────

test('removing an edge without a status removes both halves of an always-continue link', () => {
  const model = chain();
  model.aEdge.push({ iNodeIndexFrom: 2, iNodeIndexTo: 3, sStatus: 'negative', sSubStatus: '00' });
  assert.equal(removeChainEdges(model, 2, 3).length, 2);
  assert.deepEqual(succ(model, 2), []);
});

test('a status narrows the removal to one half of the link', () => {
  const model = chain();
  model.aEdge.push({ iNodeIndexFrom: 2, iNodeIndexTo: 3, sStatus: 'negative', sSubStatus: '00' });
  assert.equal(removeChainEdges(model, 2, 3, 'negative').length, 1);
  assert.deepEqual(edgeSet(model).filter((e) => e.startsWith('2->3')), ['2->3:positive/00']);
});

test('removing a step bridges the gap and remaps every later edge index', () => {
  const model = chain();
  const before = removeChainStep(model, 2, true);

  assert.equal(before.removedLabel, '#2 DTP_LOAD DTP_LOAD_X');
  assert.equal(before.edgesRemoved, 2);
  assert.equal(before.edgesReconnected, 1);
  assert.equal(model.aNode.length, 3);
  // ADSOACT moved from index 3 to 2 and the ABAP step now leads straight to it.
  assert.equal(model.aNode[2].sProcessType, 'ADSOACT');
  assert.deepEqual(edgeSet(model), ['0->1:neutral/00', '1->2:positive/00']);
});

test('the bridging edge keeps the condition of the edge that ran into the removed step', () => {
  const model = chain();
  model.aNode[1] = { sProcessType: 'DECISION', bIsReference: true, sProcessVariant: 'DEC_VAR' };
  model.aEdge[1] = { iNodeIndexFrom: 1, iNodeIndexTo: 2, sStatus: 'positive', sSubStatus: '02' };
  removeChainStep(model, 2, true);
  const bridge = model.aEdge.find((e) => e.iNodeIndexFrom === 1);
  assert.equal(bridge.sSubStatus, '02', 'the decision branch must still lead somewhere');
});

test('removing a step drops its inline variant but keeps referenced objects', () => {
  const model = chain();
  const removal = removeChainStep(model, 3, true);
  assert.equal(removal.inlineVariantRemoved, 'ILV_ACT');
  assert.equal(model.aInlineVariant.some((v) => v.sProcessVariant === 'ILV_ACT'), false);

  const model2 = chain();
  // A DTP is a referenced object, not owned by the node — nothing to clean up.
  assert.equal(removeChainStep(model2, 2, true).inlineVariantRemoved, null);
  assert.equal(model2.aInlineVariant.length, 3);
});

test('reconnect=false leaves the successors disconnected', () => {
  const model = chain();
  const removal = removeChainStep(model, 2, false);
  assert.equal(removal.edgesReconnected, 0);
  assert.deepEqual(edgeSet(model), ['0->1:neutral/00']);
});

test('the trigger cannot be removed', () => {
  assert.throws(() => removeChainStep(chain(), 0, true), /TRIGGER/);
});

test('a step with several predecessors and successors bridges every pair once', () => {
  // [0] TRIGGER → [1] A ┐               ┌→ [4] D
  //               [2] B ┴→ [3] target ──┴→ [5] E
  const model = {
    aNode: [
      { sProcessType: 'TRIGGER', sProcessVariant: 'T' },
      { sProcessType: 'DTP_LOAD', bIsReference: true, sProcessVariant: 'A' },
      { sProcessType: 'DTP_LOAD', bIsReference: true, sProcessVariant: 'B' },
      { sProcessType: 'DTP_LOAD', bIsReference: true, sProcessVariant: 'TARGET' },
      { sProcessType: 'DTP_LOAD', bIsReference: true, sProcessVariant: 'D' },
      { sProcessType: 'DTP_LOAD', bIsReference: true, sProcessVariant: 'E' },
    ],
    aEdge: [
      { iNodeIndexFrom: 0, iNodeIndexTo: 1, sStatus: 'neutral', sSubStatus: '00' },
      { iNodeIndexFrom: 0, iNodeIndexTo: 2, sStatus: 'neutral', sSubStatus: '00' },
      { iNodeIndexFrom: 1, iNodeIndexTo: 3, sStatus: 'positive', sSubStatus: '00' },
      { iNodeIndexFrom: 2, iNodeIndexTo: 3, sStatus: 'positive', sSubStatus: '00' },
      { iNodeIndexFrom: 3, iNodeIndexTo: 4, sStatus: 'positive', sSubStatus: '00' },
      { iNodeIndexFrom: 3, iNodeIndexTo: 5, sStatus: 'positive', sSubStatus: '00' },
    ],
    aInlineVariant: [],
  };
  const removal = removeChainStep(model, 3, true);
  assert.equal(removal.edgesReconnected, 4, 'two predecessors × two successors');
  assert.deepEqual(edgeSet(model), [
    '0->1:neutral/00',
    '0->2:neutral/00',
    '1->3:positive/00',
    '1->4:positive/00',
    '2->3:positive/00',
    '2->4:positive/00',
  ]);
});
