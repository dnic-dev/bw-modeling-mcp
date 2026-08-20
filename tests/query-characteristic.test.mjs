import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCharacteristicSpecs } from '../dist/tools/query_characteristic.js';

/**
 * A query document reduced to what the characteristic properties need: one
 * mainComponent with a rows and a free Dimension, each carrying the default forms
 * of the property elements, plus a filter selection whose localDimension must stay
 * untouched.
 */
function doc() {
  const dimension = (container, iobj) => `    <Qry:${container} xsi:type="Qry:Dimension" drillStateExec="Blank" id="ID_${iobj}" infoObjectName="${iobj}">
      <Qry:description shortValue="${iobj}" value="${iobj}"/>
      <Qry:sorting default="true"/>
      <Qry:valuePresentation default="true"/>
      <Qry:resultPresentation default="true"/>
      <Qry:cumulation default="true"/>
      <Qry:planning/>
      <Qry:readMode default="true" type="masterdata"/>
      <Qry:f4accessVariables/>
      <Qry:f4accessNavigation/>
      <Qry:refreshVariables/>
      <Qry:hierarchy active="false">
        <Qry:valuesOfPostableNodes default="true"/>
        <Qry:suppressNodes default="true"/>
        <Qry:name/>
        <Qry:expandToLevel default="true"/>
        <Qry:positionOfChildNodes default="true"/>
        <Qry:sorting default="true"/>
      </Qry:hierarchy>
      <Qry:attributeSelection id="ID_${iobj}"/>
      <Qry:displayLevel default="true"/>
    </Qry:${container}>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Qry:queryResource>
  <Qry:mainComponent xsi:type="Qry:Query" technicalName="QUERY_NAME">
    <Qry:filter id="FILTER_ID">
      <Qry:selections xsi:type="Qry:StandardFilterSelection" infoObject="CHAR_C">
        <Qry:localDimension drillStateExec="Blank" id="LOCAL_C" infoObjectName="CHAR_C">
          <Qry:sorting default="true"/>
          <Qry:resultPresentation default="true"/>
        </Qry:localDimension>
      </Qry:selections>
    </Qry:filter>
${dimension('rows', 'CHAR_A')}
${dimension('free', 'CHAR_B')}
  </Qry:mainComponent>
</Qry:queryResource>`;
}

/** The block of one characteristic, so assertions cannot leak into a neighbour. */
function block(xml, iobj) {
  const m = new RegExp(`<Qry:(rows|columns|free)\\b[^>]*infoObjectName="${iobj}"[^>]*>[\\s\\S]*?</Qry:\\1>`).exec(xml);
  assert.ok(m, `no block for ${iobj}`);
  return m[0];
}

test('the properties from the traced save are written in the server\'s own form', () => {
  const out = applyCharacteristicSpecs(doc(), [
    { infoobject: 'CHAR_A', result_rows: 'never', access_type: 'masterdata' },
  ]);
  const a = block(out, 'CHAR_A');
  assert.match(a, /<Qry:resultPresentation default="false"><Qry:condition>never<\/Qry:condition><\/Qry:resultPresentation>/);
  assert.match(a, /<Qry:readMode default="false" type="masterdata"\/>/);
  // Untouched neighbours keep their defaults.
  assert.match(block(out, 'CHAR_B'), /<Qry:resultPresentation default="true"\/>/);
});

test('"*" hits every characteristic in the layout', () => {
  const report = [];
  const out = applyCharacteristicSpecs(doc(), [{ infoobject: '*', result_rows: 'never' }], report);
  assert.equal(report.length, 2);
  assert.deepEqual(report.map((r) => r.characteristic).sort(), ['CHAR_A', 'CHAR_B']);
  for (const iobj of ['CHAR_A', 'CHAR_B']) {
    assert.match(block(out, iobj), /<Qry:condition>never<\/Qry:condition>/);
  }
});

test('the axis filter restricts the change to one area', () => {
  const out = applyCharacteristicSpecs(doc(), [{ infoobject: '*', axis: 'free', cumulate: 'on' }]);
  assert.match(block(out, 'CHAR_B'), /<Qry:cumulation default="false" showCumulated="true"\/>/);
  assert.match(block(out, 'CHAR_A'), /<Qry:cumulation default="true"\/>/);
});

test('a filter selection\'s localDimension is never touched', () => {
  const out = applyCharacteristicSpecs(doc(), [{ infoobject: '*', sorting: { by: 'Key' } }]);
  const local = /<Qry:localDimension[\s\S]*?<\/Qry:localDimension>/.exec(out)[0];
  assert.match(local, /<Qry:sorting default="true"\/>/);
});

test('the characteristic\'s own sorting is set, not the hierarchy\'s', () => {
  const out = applyCharacteristicSpecs(doc(), [
    { infoobject: 'CHAR_A', sorting: { by: 'Text', direction: 'Descending' } },
  ]);
  const a = block(out, 'CHAR_A');
  assert.match(a, /<Qry:sorting default="false" dimensionName="CHAR_A" sortBy="Text" sortDirection="Descending"\/>/);
  const hier = /<Qry:hierarchy[\s\S]*?<\/Qry:hierarchy>/.exec(a)[0];
  assert.match(hier, /<Qry:sorting default="true"\/>/);
});

test('hierarchy sorting stays inside the hierarchy block and carries no dimensionName', () => {
  const out = applyCharacteristicSpecs(doc(), [
    { infoobject: 'CHAR_A', hierarchy: { sorting: { by: 'Key' } } },
  ]);
  const a = block(out, 'CHAR_A');
  const hier = /<Qry:hierarchy[\s\S]*?<\/Qry:hierarchy>/.exec(a)[0];
  assert.match(hier, /<Qry:sorting default="false" sortBy="Key" sortDirection="Ascending"\/>/);
  assert.doesNotMatch(hier, /dimensionName=/);
  // The characteristic's own sorting is the one before the hierarchy block.
  assert.match(a.slice(0, a.indexOf('<Qry:hierarchy')), /<Qry:sorting default="true"\/>/);
});

test('assigning a hierarchy activates it, clearing the name switches it off', () => {
  const on = applyCharacteristicSpecs(doc(), [
    { infoobject: 'CHAR_A', hierarchy: { name: 'HIER_NAME', expand_to_level: 3 } },
  ]);
  const hier = /<Qry:hierarchy[\s\S]*?<\/Qry:hierarchy>/.exec(block(on, 'CHAR_A'))[0];
  assert.match(hier, /<Qry:hierarchy active="true"/);
  assert.match(hier, /<Qry:name><Qry:value>HIER_NAME<\/Qry:value><Qry:type>Value<\/Qry:type><\/Qry:name>/);
  assert.match(hier, /<Qry:expandToLevel default="false" level="03"\/>/);
  // Reading the name resets the level, so it has to come first in the document.
  assert.ok(hier.indexOf('<Qry:name>') < hier.indexOf('<Qry:expandToLevel'));

  const off = applyCharacteristicSpecs(doc(), [{ infoobject: 'CHAR_A', hierarchy: { name: '' } }]);
  assert.match(/<Qry:hierarchy[\s\S]*?<\/Qry:hierarchy>/.exec(block(off, 'CHAR_A'))[0], /<Qry:hierarchy active="false"/);
});

test('version and valid_to are inserted when the block does not carry them', () => {
  const out = applyCharacteristicSpecs(doc(), [
    { infoobject: 'CHAR_A', hierarchy: { name: 'HIER_NAME', version: 'V1', valid_to: '99991231' } },
  ]);
  const hier = /<Qry:hierarchy[\s\S]*?<\/Qry:hierarchy>/.exec(block(out, 'CHAR_A'))[0];
  assert.match(hier, /<Qry:version><Qry:value>V1<\/Qry:value>/);
  assert.match(hier, /<Qry:dateTo><Qry:value>99991231<\/Qry:value>/);
});

test('display_as writes presentAs together with a text type', () => {
  const out = applyCharacteristicSpecs(doc(), [
    { infoobject: 'CHAR_A', display_as: 'KeyAndText', text_type: 'medium' },
  ]);
  assert.match(block(out, 'CHAR_A'), /<Qry:valuePresentation default="false" presentAs="KeyAndText" textPresentation="medium"\/>/);
});

test('"default" restores every property to its default form', () => {
  const set = applyCharacteristicSpecs(doc(), [
    { infoobject: 'CHAR_A', result_rows: 'always', display_as: 'Key', access_type: 'factdata', cumulate: 'on', display_level: 'DetailedOnly', sorting: { by: 'Key' } },
  ]);
  const reset = applyCharacteristicSpecs(set, [
    { infoobject: 'CHAR_A', result_rows: 'default', display_as: 'default', access_type: 'default', cumulate: 'default', display_level: 'default', sorting: { by: 'default' } },
  ]);
  const a = block(reset, 'CHAR_A');
  assert.match(a, /<Qry:resultPresentation default="true"\/>/);
  assert.match(a, /<Qry:valuePresentation default="true"\/>/);
  assert.match(a, /<Qry:readMode default="true" type="masterdata"\/>/);
  assert.match(a, /<Qry:cumulation default="true"\/>/);
  assert.match(a, /<Qry:displayLevel default="true"\/>/);
});

test('an unknown characteristic is rejected instead of silently doing nothing', () => {
  assert.throws(
    () => applyCharacteristicSpecs(doc(), [{ infoobject: 'CHAR_MISSING', result_rows: 'never' }]),
    /not part of the query layout/
  );
});

test('text_type without display_as is rejected', () => {
  assert.throws(
    () => applyCharacteristicSpecs(doc(), [{ infoobject: 'CHAR_A', text_type: 'short' }]),
    /only applies together with display_as/
  );
});

test('a spec with no property at all is rejected', () => {
  assert.throws(() => applyCharacteristicSpecs(doc(), [{ infoobject: 'CHAR_A' }]), /no property to change/);
});
