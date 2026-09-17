import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFormulaRule,
  deriveFormulaSourceFields,
  listSourceSegmentFields,
  decodeXmlEntities,
} from '../dist/tools/transformation.js';

/**
 * A formula rule is only parseable when every operand of the expression is registered as a
 * source of the rule: one <source id="n"> plus the matching <input id="n"> inside the step.
 * A rule that carries the text but not the wiring is written without complaint and fails
 * activation with "syntax error in formula", pointing at the formula rather than the cause.
 */

const SEGMENT_XML = `<source>
  <segment name="segment1">
    <element name="0CALMONTH" posit="1" key="X" conversionRoutine="PERI6">
      <inlineType name="NUMC" length="6"/>
    </element>
    <element name="ZSEG" posit="2">
      <inlineType name="CHAR" length="4"/>
    </element>
    <element name="0VTYPE" posit="3">
      <inlineType name="CHAR" length="3"/>
    </element>
    <element name="ZNEW" posit="4" baseInfoObjectName="0DATE">
      <inlineType name="DATS" length="8"/>
    </element>
  </segment>
</source>`;

// An existing formula rule, as BW stores it: step id 1, the target block and the step's
// output element describing the target field.
const EXISTING_FORMULA_RULE = `<rule description="" id="158">
  <source id="1">
    <input>#///group1/rule158/step1/input1</input>
    <elementRef>#///source/segment1/ZNEW</elementRef>
  </source>
  <target id="1">
    <output>#///group1/rule158/step1/output1</output>
    <elementRef>#///target/segment1/ZFLAG</elementRef>
  </target>
  <step xsi:type="trfn:StepFormula" formula="IF ( 1 = 1 , 'X' , '' )" id="1" type="FORMULA" rank="MAIN">
    <input id="1">
      <output>#///group1/rule158/source1</output>
      <element xsi:type="trfn:TransformationElement" name="ZNEW"/>
    </input>
    <output id="1">
      <input>#///group1/rule158/target1</input>
      <element xsi:type="trfn:TransformationElement" name="ZFLAG" infoObjectName="ZFLAG"/>
    </output>
  </step>
</rule>`;

const FORMULA = "IF ( /BIC/ZSEG = '04' AND VTYPE = '020' AND CALMONTH > DATE_MONTH ( /BIC/ZNEW ) , 'X' , '' )";

function fieldDefs(names) {
  return names.map((name) => ({ name, dataType: 'CHAR', length: '4', elementXml: `<element name="${name}" posit="9"/>` }));
}

test('the source segment fields are read in segment order', () => {
  assert.deepEqual(listSourceSegmentFields(SEGMENT_XML), ['0CALMONTH', 'ZSEG', '0VTYPE', 'ZNEW']);
});

test('every operand of a formula is resolved against the source segment', () => {
  // A custom characteristic is written /BIC/NAME in the formula, a standard one loses its
  // leading zero, and DATE_MONTH is a function, not a field.
  assert.deepEqual(
    deriveFormulaSourceFields(FORMULA, listSourceSegmentFields(SEGMENT_XML)),
    ['ZSEG', '0VTYPE', '0CALMONTH', 'ZNEW'],
  );
});

test('a formula that is already escaped resolves the same way', () => {
  const escaped = FORMULA.replace('>', '&gt;');
  assert.deepEqual(
    deriveFormulaSourceFields(escaped, listSourceSegmentFields(SEGMENT_XML)),
    ['ZSEG', '0VTYPE', '0CALMONTH', 'ZNEW'],
  );
});

test('a rule is built with one source and one input per operand', () => {
  const rule = buildFormulaRule({
    oldRuleXml: EXISTING_FORMULA_RULE,
    groupId: '1',
    ruleId: '158',
    targetInfoObject: 'ZFLAG',
    sourceFields: fieldDefs(['ZSEG', '0VTYPE', '0CALMONTH', 'ZNEW']),
    formula: FORMULA,
  });

  for (const id of [1, 2, 3, 4]) {
    assert.match(rule, new RegExp(`<source id="${id}">`), `source ${id} is missing`);
    assert.match(rule, new RegExp(`<input id="${id}">`), `input ${id} is missing`);
  }
  assert.match(rule, /<elementRef>#\/\/\/source\/segment1\/0CALMONTH<\/elementRef>/);
  // Each source points at the input of the step, and each input back at its source.
  assert.match(rule, /<input>#\/\/\/group1\/rule158\/step2\/input4<\/input>/);
  assert.match(rule, /<output>#\/\/\/group1\/rule158\/source4<\/output>/);
});

test('changing the formula of an existing formula rule replaces the text', () => {
  // The defect this guards: the rule already being a StepFormula used to leave the text alone
  // and report success anyway.
  const rule = buildFormulaRule({
    oldRuleXml: EXISTING_FORMULA_RULE,
    groupId: '1',
    ruleId: '158',
    targetInfoObject: 'ZFLAG',
    sourceFields: fieldDefs(['ZSEG', '0VTYPE', '0CALMONTH', 'ZNEW']),
    formula: FORMULA,
  });

  assert.doesNotMatch(rule, /IF \( 1 = 1/);
  assert.match(rule, /formula="IF \( \/BIC\/ZSEG = '04'/);
});

test('the formula is escaped exactly once, whichever spelling comes in', () => {
  const plain = buildFormulaRule({
    oldRuleXml: EXISTING_FORMULA_RULE,
    groupId: '1',
    ruleId: '158',
    targetInfoObject: 'ZFLAG',
    sourceFields: fieldDefs(['0CALMONTH']),
    formula: "IF ( CALMONTH > 0 , 'X' , '' )",
  });
  const escaped = buildFormulaRule({
    oldRuleXml: EXISTING_FORMULA_RULE,
    groupId: '1',
    ruleId: '158',
    targetInfoObject: 'ZFLAG',
    sourceFields: fieldDefs(['0CALMONTH']),
    formula: "IF ( CALMONTH &gt; 0 , 'X' , '' )",
  });

  assert.match(plain, /formula="IF \( CALMONTH &gt; 0 , 'X' , '' \)"/);
  assert.equal(plain, escaped);
  assert.doesNotMatch(escaped, /&amp;gt;/);
});

test('the target side of the rule is carried over from the rule that was there', () => {
  const rule = buildFormulaRule({
    oldRuleXml: EXISTING_FORMULA_RULE,
    groupId: '1',
    ruleId: '158',
    targetInfoObject: 'ZFLAG',
    sourceFields: fieldDefs(['ZNEW']),
    formula: FORMULA,
  });

  assert.match(rule, /<elementRef>#\/\/\/target\/segment1\/ZFLAG<\/elementRef>/);
  assert.match(rule, /infoObjectName="ZFLAG"/);
  // References follow the step id the rebuilt rule uses.
  assert.doesNotMatch(rule, /\/step1\//);
  assert.match(rule, /<output>#\/\/\/group1\/rule158\/step2\/output1<\/output>/);
  assert.match(rule, /<step xsi:type="trfn:StepFormula" id="2"/);
});

test('entity decoding leaves an unescaped formula alone', () => {
  const formula = "IF ( A <> B , 'X' , '' )";
  assert.equal(decodeXmlEntities(formula), formula);
});
