import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compositeInlineType,
  withGlobalElementName,
  resolveNameUsage,
  directlyUsedNames,
  compositeGroups,
  ensureGroupDeclared,
  resolveGroup,
  groupRef,
} from '../dist/tools/composite_provider.js';

test('a classic source inlineType with a child element becomes the self-closing form', () => {
  const body =
    '<endUserTexts label="LABEL"/><inlineType name="CHAR" globalElementName="IOBJ_NAME" length="5" semanticType="empty">' +
    '<dataElementName>DATA_ELEMENT</dataElementName></inlineType><localProperties/>';
  assert.equal(
    compositeInlineType(body),
    '<inlineType name="CHAR" globalElementName="IOBJ_NAME" length="5" semanticType="empty"/>'
  );
});

test('a BW/4HANA source inlineType passes through unchanged', () => {
  const tag = '<inlineType name="INT4" globalElementName="IOBJ_NAME" length="10"/>';
  assert.equal(compositeInlineType(`<x/>${tag}<y/>`), tag);
});

test('no inlineType yields an empty string', () => {
  assert.equal(compositeInlineType('<endUserTexts label="LABEL"/>'), '');
});

test('globalElementName is set after the type name, replaced, or removed', () => {
  const plain = '<inlineType name="CHAR" length="5"/>';
  assert.equal(withGlobalElementName(plain, 'IOBJ_NAME'), '<inlineType name="CHAR" globalElementName="IOBJ_NAME" length="5"/>');
  assert.equal(
    withGlobalElementName('<inlineType name="CHAR" globalElementName="OTHER" length="5"/>', 'IOBJ_NAME'),
    '<inlineType name="CHAR" globalElementName="IOBJ_NAME" length="5"/>'
  );
  assert.equal(withGlobalElementName('<inlineType name="CHAR" globalElementName="OTHER" length="5"/>', undefined), plain);
});

test('an element named after its InfoObject uses it directly unless told otherwise', () => {
  assert.equal(resolveNameUsage(undefined, 'IOBJ_NAME', 'IOBJ_NAME'), 'direct');
  assert.equal(resolveNameUsage(undefined, 'FIELD_NAME', 'IOBJ_NAME'), 'unique_name');
  assert.equal(resolveNameUsage('unique_name', 'IOBJ_NAME', 'IOBJ_NAME'), 'unique_name');
  assert.equal(resolveNameUsage('direct', 'FIELD_NAME', 'IOBJ_NAME'), 'direct');
});

test('a plain field has no name usage, and asking for direct usage is an error', () => {
  assert.equal(resolveNameUsage(undefined, 'FIELD_NAME', undefined), undefined);
  assert.throws(() => resolveNameUsage('direct', 'FIELD_NAME', undefined), /plain field/);
});

const CP = `<?xml version="1.0" encoding="utf-8"?><Composite:compositeView name="HCPR_NAME"><viewNode name="U1">
<element name="IOBJ_A" infoObjectName="IOBJ_A" dimension="#///GROUP_A§"><inlineType name="CHAR" globalElementName="IOBJ_A" length="5"/></element>
<element name="IOBJ_B" infoObjectName="IOBJ_B"><inlineType name="CHAR" length="5"/></element>
</viewNode><tlogoProperties/><runtimeProperties/>
<dimension name="GROUP_A"><descriptions label="Group &amp; label"/></dimension>
<dimension name="GROUP_B"/></Composite:compositeView>`;

test('directly used InfoObjects are read from globalElementName', () => {
  assert.deepEqual([...directlyUsedNames(CP)], ['IOBJ_A']);
});

test('declared groups come with their decoded label', () => {
  assert.deepEqual([...compositeGroups(CP)], [['GROUP_A', 'Group & label'], ['GROUP_B', '']]);
});

test('a group reference ends in the section sign', () => {
  const ref = groupRef('GROUP_A');
  assert.equal(ref, '#///GROUP_A§');
  assert.equal(ref.charCodeAt(ref.length - 1), 0xa7);
});

test('a missing group is declared once, at the end of the model', () => {
  const once = ensureGroupDeclared(CP, 'CHARACTERISTICS');
  assert.match(once, /<dimension name="CHARACTERISTICS"\/>\s*<\/Composite:compositeView>$/);
  assert.equal(ensureGroupDeclared(once, 'CHARACTERISTICS'), once);
  assert.equal(ensureGroupDeclared(CP, 'GROUP_A'), CP);
});

test('the default groups need no declaration, any other group does', () => {
  assert.equal(resolveGroup(CP, undefined, false, 'HCPR_NAME'), 'CHARACTERISTICS');
  assert.equal(resolveGroup(CP, undefined, true, 'HCPR_NAME'), 'KEYFIGURES');
  assert.equal(resolveGroup(CP, 'group_b', false, 'HCPR_NAME'), 'GROUP_B');
  assert.throws(() => resolveGroup(CP, 'GROUP_X', false, 'HCPR_NAME'), /Declared groups: GROUP_A, GROUP_B/);
});

import { stripCheckMarkers } from '../dist/tools/query_update.js';

test('check markers of a query saved with errors are dropped, the rest stays', () => {
  const doc =
    '<Qry:queryResource><Qry:mainComponent id="C1"/>' +
    '<Qry:messages title="T" messageType="Error" errorPosition="#//"/>' +
    '<Qry:messages title="U" messageType="Warning"></Qry:messages></Qry:queryResource>';
  assert.equal(stripCheckMarkers(doc), '<Qry:queryResource><Qry:mainComponent id="C1"/></Qry:queryResource>');
  assert.equal(stripCheckMarkers('<Qry:messagesX a="1"/>'), '<Qry:messagesX a="1"/>');
});
