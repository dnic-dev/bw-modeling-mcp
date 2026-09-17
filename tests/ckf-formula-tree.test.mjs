import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFormulaXml,
  renderFormulaTree,
  removeOperandByComponent,
  countComponentRefs,
  locateFormulaDefinition,
  buildStructureMember,
} from '../dist/tools/elem_write.js';

// A CKF formula as the backend stores it: a sum of three summands is a left-nested
// chain of binary '+' operators, and each component operand points at an ELEMUID.
const operand = (uid) => `<Qry:childToken xsi:type="Qry:FormulaMemberOperand" member="${uid}" operandType="Formula"/>`;

const SUM_OF_THREE =
  '<Qry:formulaToken xsi:type="Qry:FormulaInfixOperator" code="+">' +
  '<Qry:childToken xsi:type="Qry:FormulaInfixOperator" code="+">' +
  operand('UID_A') +
  operand('UID_B') +
  '</Qry:childToken>' +
  operand('UID_C') +
  '</Qry:formulaToken>';

test('a stored formula round-trips through the tree unchanged', () => {
  // The premise of read-modify-write: if parse → render is not the identity, every
  // targeted edit silently rewrites the parts it was supposed to leave alone.
  const tree = parseFormulaXml(SUM_OF_THREE);
  assert.equal(renderFormulaTree(tree, 'Qry:formulaToken'), SUM_OF_THREE);
});

test('the parsed tree carries component ids, not resolved names', () => {
  const tree = parseFormulaXml(SUM_OF_THREE);
  assert.deepEqual(tree.operands[1], { type: 'component', component_id: 'UID_C' });
});

test('appending a summand wraps the formula and leaves the existing operands in order', () => {
  // The acceptance criterion from the issue: after adding one summand, every operand
  // that was there before is still there, unchanged and in the same order.
  const tree = parseFormulaXml(SUM_OF_THREE);
  const wrapped = { type: 'operator', code: '+', operands: [tree, { type: 'component', component_id: 'UID_D' }] };
  const xml = renderFormulaTree(wrapped, 'Qry:formulaToken');

  assert.ok(xml.includes(SUM_OF_THREE.replace('<Qry:formulaToken', '<Qry:childToken').replace('</Qry:formulaToken>', '</Qry:childToken>')));
  assert.deepEqual(
    [...xml.matchAll(/member="([^"]+)"/g)].map((m) => m[1]),
    ['UID_A', 'UID_B', 'UID_C', 'UID_D']
  );
});

test('removing a summand replaces its operator with the sibling', () => {
  // A summand does not sit in an operand list that can be spliced — it hangs off a
  // binary operator, and dropping it means promoting the other operand in its place.
  const reduced = removeOperandByComponent(parseFormulaXml(SUM_OF_THREE), 'UID_B');
  assert.deepEqual(
    [...renderFormulaTree(reduced, 'Qry:formulaToken').matchAll(/member="([^"]+)"/g)].map((m) => m[1]),
    ['UID_A', 'UID_C']
  );
});

test('removing the outermost summand keeps the nested remainder intact', () => {
  const reduced = removeOperandByComponent(parseFormulaXml(SUM_OF_THREE), 'UID_C');
  assert.equal(
    renderFormulaTree(reduced, 'Qry:formulaToken'),
    SUM_OF_THREE.match(/<Qry:childToken xsi:type="Qry:FormulaInfixOperator"[\s\S]*?<\/Qry:childToken>/)[0]
      .replace('<Qry:childToken', '<Qry:formulaToken')
      .replace(/<\/Qry:childToken>$/, '</Qry:formulaToken>')
  );
});

test('a component that is not in the formula is reported, not silently ignored', () => {
  assert.equal(countComponentRefs(parseFormulaXml(SUM_OF_THREE), 'UID_X'), 0);
  assert.equal(removeOperandByComponent(parseFormulaXml(SUM_OF_THREE), 'UID_X'), undefined);
});

test('an operand used twice is counted twice, so the caller can be told it is ambiguous', () => {
  const twice = parseFormulaXml(
    '<Qry:formulaToken xsi:type="Qry:FormulaInfixOperator" code="/">' + operand('UID_A') + operand('UID_A') + '</Qry:formulaToken>'
  );
  assert.equal(countComponentRefs(twice, 'UID_A'), 2);
});

test('an operator whose operands are not a pair refuses the removal', () => {
  // Promoting a sibling only makes sense for a binary operator. NDIV0 has one operand,
  // and silently turning NDIV0(X) into nothing would change the result, not the shape.
  const unary = parseFormulaXml(
    '<Qry:formulaToken xsi:type="Qry:FormulaPrefixOperator" code="NDIV0">' + operand('UID_A') + '</Qry:formulaToken>'
  );
  assert.throws(() => removeOperandByComponent(unary, 'UID_A'), /NDIV0/);
});

test('constants and basic key figures survive the round trip', () => {
  const mixed =
    '<Qry:formulaToken xsi:type="Qry:FormulaInfixOperator" code="-">' +
    '<Qry:childToken xsi:type="Qry:FormulaConstant" value="100"/>' +
    '<Qry:childToken xsi:type="Qry:FormulaIObjectOperand" infoObject="KYF_NAME"/>' +
    '</Qry:formulaToken>';
  assert.equal(renderFormulaTree(parseFormulaXml(mixed), 'Qry:formulaToken'), mixed);
});

test('operand counts are checked before anything is written', () => {
  assert.throws(
    () => renderFormulaTree({ type: 'operator', code: '*', operands: [{ type: 'constant', value: 1 }] }, 'Qry:formulaToken'),
    /expects 2 operand/
  );
});

test('an unresolved component operand is rejected rather than written as a dangling reference', () => {
  assert.throws(
    () => renderFormulaTree({ type: 'component', component_name: 'SOME_CKF' }, 'Qry:formulaToken'),
    /not resolved/
  );
});

test('an empty formulaDefinition is located as an empty body, not as a parse failure', () => {
  // A freshly created CKF carries a self-closing element; the create path fills it.
  const doc = '<Qry:queryResource><Qry:mainComponent><Qry:formulaDefinition/></Qry:mainComponent></Qry:queryResource>';
  const loc = locateFormulaDefinition(doc);
  assert.equal(loc.body, '');
  assert.equal(doc.slice(loc.start, loc.end), '<Qry:formulaDefinition/>');
});

test('the formulaDefinition of the main component is found, not one of a sub-component', () => {
  // A CKF document embeds every component it references; picking the first match in the
  // document would edit somebody else's formula.
  const doc =
    '<Qry:queryResource>' +
    '<Qry:subComponents><Qry:formulaDefinition>SUB</Qry:formulaDefinition></Qry:subComponents>' +
    '<Qry:mainComponent><Qry:formulaDefinition>MAIN</Qry:formulaDefinition></Qry:mainComponent>' +
    '</Qry:queryResource>';
  assert.equal(locateFormulaDefinition(doc).body, 'MAIN');
});

// ── Structure members ────────────────────────────────────────────────────────

test('a member with its own text marks it as not-default, so the backend keeps it', () => {
  // Without default="false" the backend treats the text as a default and replaces it
  // with the referenced object's own description: the member is saved, under a
  // different name than the caller asked for, and no error says so.
  const own = buildStructureMember('!VIRTUAL-1', { component_name: 'SOME_RKF', description: 'Revenue' }, 'UID_1', '');
  assert.match(own, /<Qry:description default="false" value="Revenue"\/>/);
});

test('a member without its own text inherits the referenced object description', () => {
  const inherited = buildStructureMember('!VIRTUAL-1', { component_name: 'SOME_RKF' }, 'UID_1', '');
  assert.match(inherited, /<Qry:description value="SOME_RKF"\/>/);
  assert.ok(!inherited.includes('default="false"'));
});

test('a component member points at the component, a key figure member at the InfoObject', () => {
  const comp = buildStructureMember('!VIRTUAL-1', { component_name: 'SOME_RKF' }, 'UID_1', '');
  assert.match(comp, /<Qry:tokens xsi:type="Qry:SelectionTokenForComponent" component="UID_1"\/>/);
  assert.match(comp, /<Qry:type>CINLink<\/Qry:type>/);

  const kyf = buildStructureMember('!VIRTUAL-2', { key_figure: 'kyf_name' }, undefined, '');
  assert.match(kyf, /selectionType="keyFigure"/);
  assert.match(kyf, /<Qry:value>KYF_NAME<\/Qry:value>/);
  assert.match(kyf, /<Qry:type>InfoObject<\/Qry:type>/);
});

test('every display element the backend demands is present, including planning', () => {
  // A member missing any of these is rejected with "required model details are
  // missing" and no indication of which one. The planning block is part of the set
  // even on a structure that is never planned on, and carries input readiness.
  const member = buildStructureMember('!VIRTUAL-1', { key_figure: 'KYF_NAME' }, undefined, '');
  for (const el of ['hidden', 'emphasize', 'signInversion', 'scaling', 'decimals', 'calculation',
                    'currencyConversion', 'unitConversion']) {
    assert.ok(member.includes(`<Qry:${el}/>`), `missing <Qry:${el}/>`);
  }
  assert.match(member, /<Qry:planning>\s*<Qry:inputMode\/>\s*<Qry:disaggregation\/>\s*<\/Qry:planning>/);
});

test('a nested member is written under the child element name', () => {
  // Under the top-level name the backend drops the member and still reports the save
  // as consistent — nothing written, nothing reported.
  const child = buildStructureMember('!VIRTUAL-1', { key_figure: 'KYF_NAME' }, undefined, '', 'childMembers');
  assert.match(child, /^<Qry:childMembers /);
  assert.match(child, /<\/Qry:childMembers>$/);
});

test('member position and the attributes the backend assigns are left to it', () => {
  // The modeling tools send neither drillStateExec nor flatPosition on a new member.
  const member = buildStructureMember('!VIRTUAL-1', { key_figure: 'KYF_NAME' }, undefined, '');
  assert.ok(!member.includes('drillStateExec'));
  assert.ok(!member.includes('flatPosition'));
});
