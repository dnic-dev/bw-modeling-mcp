import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bwGetVariable } from '../dist/tools/cp_components.js';
import { applyVariableChanges } from '../dist/tools/elem_write.js';

// A variable document as the backend serves it, shortened to the parts both tools touch.
// Note the two <Qry:type> elements: the first belongs to the default hint, the second to
// the variable itself.
const XML = `<?xml version="1.0" encoding="utf-8"?>
<Qry:queryResource xmlns:Qry="http://www.sap.com/bw/Query.ecore" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:adtCore="http://www.sap.com/adt/core">
<Qry:schemaVersion>1.0</Qry:schemaVersion>
<Qry:mainComponent xsi:type="Qry:Variable" id="COMPONENT_UID" modified="false" technicalName="VAR_NAME" componentVersion="100" timestamp="20260101120000" authoringTool="3" reusable="true" infoObject="IOBJ_NAME" readyForInput="true" dynamic="false">
<Qry:description default="false" value="Variable text"/>
<Qry:defaultHint>
<Qry:value>IOBJ_NAME</Qry:value>
<Qry:type>InfoObject</Qry:type>
</Qry:defaultHint>
<Qry:entityProperties adtCore:name="VAR_NAME" adtCore:description="Variable text" adtCore:masterLanguage="EN" adtCore:responsible="USER" adtCore:language="EN" adtCore:masterSystem="SYS" adtCore:type="ELEM" adtCore:createdBy="USER" adtCore:createdAt="2026-01-01T12:00:00Z" adtCore:changedBy="USER" adtCore:changedAt="2026-01-01T12:00:00Z">
<adtCore:packageRef adtCore:name="$TMP" adtCore:type="DEVC/K"/>
<infoArea>NODESNOTCONNECTED</infoArea>
</Qry:entityProperties>
<Qry:currency/>
<Qry:unit/>
<Qry:replacementPath/>
<Qry:type>CharacteristicValue</Qry:type>
<Qry:procType>UserEntry</Qry:procType>
<Qry:represents>Interval</Qry:represents>
<Qry:inputType>Optional</Qry:inputType>
<Qry:defaultSelection/>
<Qry:hierarchyName/>
<Qry:version/>
<Qry:dateTo>00000000</Qry:dateTo>
</Qry:mainComponent>
</Qry:queryResource>`;

// bwGetVariable only ever calls get(), so a stand-in avoids needing a configured system.
const clientReturning = (body) => ({ get: async () => ({ body, headers: {} }) });

test('every enum the create tool writes comes back out of the reader', async () => {
  // The point of the reader: all five literals bw_create_variable passes are visible, so a
  // value the backend silently replaced with its default can be spotted.
  const out = JSON.parse(await bwGetVariable(clientReturning(XML), 'VAR_NAME'));
  assert.equal(out.variable_type, 'CharacteristicValue');
  assert.equal(out.processing_type, 'UserEntry');
  assert.equal(out.represents, 'Interval');
  assert.equal(out.input_type, 'Optional');
  assert.equal(out.ready_for_input, true);
  assert.equal(out.info_object, 'IOBJ_NAME');
  assert.equal(out.uid, 'COMPONENT_UID');
  assert.equal(out.package, '$TMP');
});

test('the tree placeholder is not reported as an InfoArea, and an empty hierarchy date is dropped', async () => {
  const out = JSON.parse(await bwGetVariable(clientReturning(XML), 'VAR_NAME'));
  assert.equal(out.info_area, '');
  assert.ok(!('hierarchy_date_to' in out));
  assert.ok(!('hierarchy_name' in out));
});

test('an update writes the variable type elements, never the ones in the default hint', () => {
  // The failure this guards against is silent: a replacement that lands on the hint's
  // <Qry:type> leaves the variable consistent and breaks its value help.
  const { document, applied } = applyVariableChanges(XML, {
    variable_name: 'VAR_NAME',
    description: 'Changed text',
    ready_for_input: false,
    input_type: 'MandatoryWithoutInitial',
    represents: 'SelectionOption',
  });
  assert.match(document, /<Qry:defaultHint>\s*<Qry:value>IOBJ_NAME<\/Qry:value>\s*<Qry:type>InfoObject<\/Qry:type>/);
  assert.match(document, /<Qry:type>CharacteristicValue<\/Qry:type>/);
  assert.match(document, /<Qry:inputType>MandatoryWithoutInitial<\/Qry:inputType>/);
  assert.match(document, /<Qry:represents>SelectionOption<\/Qry:represents>/);
  assert.match(document, /readyForInput="false"/);
  assert.match(document, /<Qry:description default="false" value="Changed text"\/>/);
  assert.match(document, /adtCore:description="Changed text"/);
  assert.equal(applied.length, 4);
});

test('the reference characteristic and the UID are never rewritten', () => {
  const { document } = applyVariableChanges(XML, { variable_name: 'VAR_NAME', description: 'Changed text' });
  assert.match(document, /infoObject="IOBJ_NAME"/);
  assert.match(document, /id="COMPONENT_UID"/);
});

test('switching to ReplacementPath adds the current-member block, switching away clears it', () => {
  const toReplacement = applyVariableChanges(XML, {
    variable_name: 'VAR_NAME',
    processing_type: 'ReplacementPath',
  }).document;
  assert.match(toReplacement, /<Qry:replacementPath type="CurrentMember"/);
  assert.match(toReplacement, /<Qry:procType>ReplacementPath<\/Qry:procType>/);

  const back = applyVariableChanges(toReplacement, {
    variable_name: 'VAR_NAME',
    processing_type: 'CustomerExit',
  }).document;
  assert.match(back, /<Qry:replacementPath\/>/);
  assert.match(back, /<Qry:procType>CustomerExit<\/Qry:procType>/);
});

test('a description with XML metacharacters is escaped', () => {
  const { document } = applyVariableChanges(XML, {
    variable_name: 'VAR_NAME',
    description: 'A & B <needs> "escaping"',
  });
  assert.match(document, /value="A &amp; B &lt;needs&gt; &quot;escaping&quot;"/);
  assert.ok(!document.includes('value="A & B'));
});
