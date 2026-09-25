import test from 'node:test';
import assert from 'node:assert/strict';
import {
  targetHasUnitOrCurrency,
  setRuleConversionType,
  parseConversionCatalog,
  buildConversionRule,
} from '../dist/tools/transformation.js';

/**
 * A rule on a key figure bound to a currency or unit must carry conversiontype="NO_CONVERSION"
 * when no conversion is wanted. Without the attribute BW inserts a conversion step with an
 * empty source-unit input and the transformation no longer activates.
 */

test('fixed currency, fixed unit (with attribute) and a unit field reference are detected', () => {
  assert.equal(targetHasUnitOrCurrency('<element name="KF"><fixedCurrency>EUR</fixedCurrency></element>'), true);
  assert.equal(targetHasUnitOrCurrency('<element name="KF"><fixedUnit intValue="ST">ST</fixedUnit></element>'), true);
  assert.equal(
    targetHasUnitOrCurrency('<element name="KF"><unitCurrencyElement>#///target/segment1/UNIT</unitCurrencyElement></element>'),
    true,
  );
});

test('a plain number or a characteristic is not treated as a currency/unit key figure', () => {
  assert.equal(targetHasUnitOrCurrency('<element name="KF"><inlineType name="DEC" precision="17" scale="3"/></element>'), false);
  assert.equal(targetHasUnitOrCurrency(''), false);
});

test('conversiontype is added to a rule that has none', () => {
  const out = setRuleConversionType('<rule id="3" description=""><step id="1"/></rule>', 'NO_CONVERSION');
  assert.match(out, /^<rule conversiontype="NO_CONVERSION" id="3" description="">/);
  assert.equal((out.match(/conversiontype=/g) ?? []).length, 1);
});

test('an existing conversiontype is replaced, not duplicated', () => {
  const out = setRuleConversionType('<rule id="3" conversiontype="FROM_SOURCE" description=""></rule>', 'NO_CONVERSION');
  assert.equal(out, '<rule id="3" conversiontype="NO_CONVERSION" description=""></rule>');
});

test('only the opening rule tag is touched', () => {
  const rule = '<rule id="3"><step conversiontype="X" id="1"/></rule>';
  const out = setRuleConversionType(rule, 'NO_CONVERSION');
  assert.ok(out.includes('<step conversiontype="X" id="1"/>'));
});

const CATALOG = `<?xml version="1.0" encoding="utf-8"?><dataContainer version="1"><simpleParams iprov=""/>` +
  `<tableParam name="currencyTranslations">` +
  `<line transType="CT_FIXED" desc="" longDesc="Fixed source to fixed target" fixSource="CUR_A" externalSource="CUR_A" fixTarget="CUR_B" externalTarget="CUR_B" exRateType="M"/>` +
  `<line transType="CT_OPEN" desc="" longDesc="Target only &amp; rate" fixTarget="CUR_B" externalTarget="CUR_B" exRateType="M"/>` +
  `</tableParam><tableParam name="unitConversions">` +
  `<line convType="UC_ONE" desc="Short" longDesc="" unitDesc="" fixSource="UN_A" externalSource="UN_A" fixTarget="UN_B" externalTarget="UN_B"/>` +
  `</tableParam></dataContainer>`;

test('the conversion catalog lists both kinds with their fixed source and target', () => {
  const c = parseConversionCatalog(CATALOG);
  assert.deepEqual(c.currency.map((t) => [t.name, t.fixedSource, t.fixedTarget]), [
    ['CT_FIXED', 'CUR_A', 'CUR_B'],
    ['CT_OPEN', '', 'CUR_B'],
  ]);
  assert.equal(c.currency[1].description, 'Target only & rate');
  assert.deepEqual(c.unit.map((t) => [t.name, t.description, t.fixedSource]), [['UC_ONE', 'Short', 'UN_A']]);
});

test('an empty catalog parses to empty lists', () => {
  const c = parseConversionCatalog('<dataContainer version="1"><tableParam name="currencyTranslations"/><tableParam name="unitConversions"/></dataContainer>');
  assert.deepEqual(c, { currency: [], unit: [] });
});

const SRC = '<element posit="0002" key="false" name="AMOUNT_SRC" intType="P"><inlineType name="DEC" precision="17"/></element>';
const TGT = '<element posit="0003" key="false" name="AMOUNT_TGT" infoObjectName="AMOUNT_TGT"><inlineType name="CURR" precision="17" scale="2"/><fixedCurrency>CUR_B</fixedCurrency></element>';
const CUR = '<element posit="0004" key="false" name="CURRENCY_SRC"><inlineType name="CUKY" length="5"/></element>';

test('a conversion rule feeds a MINOR conversion step from a MAIN direct step', () => {
  const r = buildConversionRule({
    groupId: '1', ruleId: '7',
    sourceField: 'AMOUNT_SRC', sourceElementXml: SRC,
    targetField: 'AMOUNT_TGT', targetElementXml: TGT,
    conversionTlogo: 'CTRT', conversionType: 'CT_OPEN',
    unitSourceField: 'CURRENCY_SRC', unitSourceElementXml: CUR,
  });
  assert.match(r, /^<rule id="7" conversiontype="FROM_CONVERSION"/);
  assert.match(r, /<step xsi:type="trfn:StepConversion" conversionTlogo="CTRT" conversionType="CT_OPEN" id="1" type="CONVERSION" rank="MINOR">/);
  assert.match(r, /<step xsi:type="trfn:StepDirect" id="2" type="DIRECT" rank="MAIN">/);
  // amount: source1 → direct step → conversion input 1 → target
  assert.match(r, /<source id="1">\s*<input>#\/\/\/group1\/rule7\/step2\/input1<\/input>\s*<elementRef>#\/\/\/source\/segment1\/AMOUNT_SRC</);
  assert.match(r, /<output id="1">\s*<input>#\/\/\/group1\/rule7\/step1\/input1<\/input>/);
  assert.match(r, /<target id="1">\s*<output>#\/\/\/group1\/rule7\/step1\/output1<\/output>/);
  // source currency: source2 → conversion input 2
  assert.match(r, /<source id="2">\s*<input>#\/\/\/group1\/rule7\/step1\/input2<\/input>\s*<elementRef>#\/\/\/source\/segment1\/CURRENCY_SRC</);
  assert.match(r, /<input id="2">\s*<output>#\/\/\/group1\/rule7\/source2<\/output>/);
  // segment-only attributes are stripped from the step elements
  assert.doesNotMatch(r, /posit=|intType=|key="false"/);
});

test('without a source unit field the rule carries no second source and no input 2', () => {
  const r = buildConversionRule({
    groupId: '1', ruleId: '7',
    sourceField: 'AMOUNT_SRC', sourceElementXml: SRC,
    targetField: 'AMOUNT_TGT', targetElementXml: TGT,
    conversionTlogo: 'UOMT', conversionType: 'UC_ONE',
  });
  assert.doesNotMatch(r, /<source id="2">/);
  assert.doesNotMatch(r, /<input id="2">/);
  assert.match(r, /conversionTlogo="UOMT" conversionType="UC_ONE"/);
});
