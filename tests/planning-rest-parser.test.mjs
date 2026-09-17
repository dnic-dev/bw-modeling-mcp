import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlseXmlForTest } from '../dist/tools/planning.js';

// The PLSE resource nests its parameters inside <condition>, mixes self-closing and paired
// <parameter> tags, and puts the restrictions of a data-selection parameter in a
// <fieldSelectionSet> rather than in a <selectionRange>. Each of those broke the reader in a
// way that produced a plausible-looking but wrong answer rather than an error, which is why
// they are pinned here against a cut-down copy of a real response.

const XML = `<?xml version="1.0" encoding="utf-8"?>
<bwPlanningService:planningService name="ZFUNC" planningServiceType="ZTYPE.plst#//" alvl="ZLEVEL.composite#//"
  xmlns:bwPlanningService="http://www.sap.com/bw/modeling/BwPlanningService.ecore"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:qry="http://www.sap.com/bw/Query.ecore">
<description label="Test function"/>
<condition>
<fieldSelection characteristic="ZLEVEL.composite#///ZFLAG"><constraint selectionType="areaSelection" operator="Equal" fromValueDesc="X"><qry:fromValue><qry:type>Value</qry:type><qry:value>X</qry:value></qry:fromValue></constraint></fieldSelection>
<fieldSelection characteristic="ZLEVEL.composite#///ZTYPE"><constraint selectionType="areaSelection" exclude="true" operator="Equal" fromValueDesc="Nicht zugeordnet"><qry:fromValue><qry:type>Value</qry:type><qry:value>#</qry:value></qry:fromValue></constraint></fieldSelection>
<parameter xsi:type="bwPlanningService:PlanningServiceParameter" name="KYFSEL" multiselection="false" parameterType="5" allKeyfigures="true"/>
<parameter xsi:type="bwPlanningService:PlanningServiceParameter" name="FROMTAB" multiselection="true" parameterType="4"><parameter xsi:type="bwPlanningService:PlanningServiceParameter" name="FROMSEQNR" multiselection="false" parameterType="1"><selectionRange selectionType="areaSelection" operator="Equal"><qry:fromValue><qry:type>Value</qry:type><qry:value>0</qry:value></qry:fromValue></selectionRange></parameter><parameter xsi:type="bwPlanningService:PlanningServiceParameter" name="FROMSEL" multiselection="false" parameterType="3"><fieldSelectionSet><FieldSelection characteristic="ZLEVEL.composite#///ZCHAR"><constraint selectionType="areaSelection" operator="Equal" fromValueDesc="#"><qry:fromValue><qry:type>Value</qry:type><qry:value>#</qry:value></qry:fromValue></constraint></FieldSelection></fieldSelectionSet></parameter></parameter>
<parameter xsi:type="bwPlanningService:PlanningServiceParameter" name="TOTAB" multiselection="true" parameterType="4"><parameter xsi:type="bwPlanningService:PlanningServiceParameter" name="TOSEL" multiselection="false" parameterType="3"><fieldSelectionSet><FieldSelection characteristic="ZLEVEL.composite#///ZCHAR"><constraint selectionType="areaSelection" exclude="true" operator="Equal" fromValueDesc="#"><qry:fromValue><qry:type>Value</qry:type><qry:value>#</qry:value></qry:fromValue></constraint></FieldSelection></fieldSelectionSet></parameter><parameter xsi:type="bwPlanningService:PlanningServiceParameter" name="TOFACTOR" multiselection="false" parameterType="1"><selectionRange selectionType="areaSelection" operator="Equal"><qry:fromValue><qry:type>Value</qry:type><qry:value>1.000</qry:value></qry:fromValue></selectionRange></parameter></parameter>
</condition>
</bwPlanningService:planningService>`;

const info = parsePlseXmlForTest(XML, 'active');
const rule = info.rules[0];
const byName = (name) => rule.parameters.find((p) => p.name === name);

test('a self-closing parameter does not swallow the parameters after it', () => {
  // KYFSEL is written as `<parameter …/>`. Taken for an opening tag, the search for its
  // closing tag ran into FROMTAB's, and both tables disappeared from the answer.
  assert.deepEqual(rule.parameters.map((p) => p.name), ['KYFSEL', 'FROMTAB', 'TOTAB']);
  assert.deepEqual(byName('KYFSEL').children, []);
});

test('a data-selection parameter reports its field selections', () => {
  // These live in a fieldSelectionSet, not in a selectionRange, and were not read at all —
  // which emptied the from/to selections that are the entire content of a copy function.
  const fromSel = byName('FROMTAB').children.find((c) => c.name === 'FROMSEL');
  assert.equal(fromSel.fieldSelections.length, 1);
  assert.equal(fromSel.fieldSelections[0].characteristic, 'ZCHAR');
  assert.equal(fromSel.fieldSelections[0].constraints[0].from.value, '#');
});

test('field selections are not repeated on the structure parameter above them', () => {
  // The body of a structure parameter contains its children, so an unguarded search finds
  // their selections again and prints every restriction twice.
  assert.deepEqual(byName('FROMTAB').fieldSelections, []);
  assert.deepEqual(byName('TOTAB').fieldSelections, []);
});

test('exclude is carried, in conditions and in field selections alike', () => {
  // Dropped, an "everything but the unassigned value" restriction reads as its exact
  // opposite — and nothing in the output hints that something was lost.
  const flag = rule.conditions.find((c) => c.characteristic === 'ZFLAG');
  const type = rule.conditions.find((c) => c.characteristic === 'ZTYPE');
  assert.equal(flag.constraints[0].exclude, false);
  assert.equal(type.constraints[0].exclude, true);

  const toSel = byName('TOTAB').children.find((c) => c.name === 'TOSEL');
  assert.equal(toSel.fieldSelections[0].constraints[0].exclude, true);
});

test('a nested elementary parameter keeps its value', () => {
  const factor = byName('TOTAB').children.find((c) => c.name === 'TOFACTOR');
  assert.equal(factor.selections[0].fromValue, '1.000');
  assert.equal(factor.selections[0].exclude, false);
});

test('every rule is read, not only the first', () => {
  // A function type that supports several rules writes one <condition> block per rule. A
  // non-global regex reads the first and drops the rest — conditions and parameters alike —
  // and the answer looks complete: half a function, presented as the whole one.
  const twoRules = XML.replace(
    '</bwPlanningService:planningService>',
    '<condition><fieldSelection characteristic="ZLEVEL.composite#///ZFLAG">' +
      '<constraint selectionType="areaSelection" operator="Equal"><qry:fromValue>' +
      '<qry:type>Value</qry:type><qry:value>Y</qry:value></qry:fromValue></constraint>' +
      '</fieldSelection><parameter name="SECOND" parameterType="1"><selectionRange ' +
      'selectionType="areaSelection" operator="Equal"><qry:fromValue><qry:type>Value</qry:type>' +
      '<qry:value>42</qry:value></qry:fromValue></selectionRange></parameter></condition>' +
      '</bwPlanningService:planningService>',
  );
  const info2 = parsePlseXmlForTest(twoRules, 'active');
  assert.equal(info2.rules.length, 2);
  assert.equal(info2.rules[1].conditions[0].constraints[0].from.value, 'Y');
  assert.equal(info2.rules[1].parameters[0].name, 'SECOND');
  assert.equal(info2.rules[1].parameters[0].selections[0].fromValue, '42');
});
