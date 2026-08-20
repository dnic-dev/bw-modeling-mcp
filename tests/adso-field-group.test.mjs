import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adsoFieldGroups, resolveFieldGroup } from '../dist/tools/adso.js';

/** An aDSO that declares three groups and already has fields in two of them. */
const XML = `<adso:dataStore name="ADSO_NAME">
  <element xsi:type="adso:AdsoElement" name="FIELD_A" dimension="#///KEY§"/>
  <element xsi:type="adso:AdsoElement" name="FIELD_B" dimension="#///DATA§"/>
  <element xsi:type="adso:AdsoElement" name="FIELD_C"/>
  <dimension name="KEY"><descriptions label="KEY"/></dimension>
  <dimension name="DATA"><descriptions label="DATA"/></dimension>
  <dimension name="__KEYFIGURES"><descriptions label="Kennzahlen"/></dimension>
</adso:dataStore>`;

test('every declared group is found, whether or not a field sits in it', () => {
  assert.deepEqual([...adsoFieldGroups(XML).keys()].sort(), ['DATA', 'KEY', '__KEYFIGURES']);
});

test('the attribute value is taken verbatim from a field already in the group', () => {
  assert.equal(adsoFieldGroups(XML).get('KEY'), '#///KEY§');
});

test('an empty group still yields the canonical value, terminator included', () => {
  const v = adsoFieldGroups(XML).get('__KEYFIGURES');
  assert.equal(v, '#///__KEYFIGURES§');
  assert.equal(v.charCodeAt(v.length - 1), 0xa7);
});

test('a bare group name resolves', () => {
  assert.equal(resolveFieldGroup(XML, '__KEYFIGURES', 'ADSO_NAME'), '#///__KEYFIGURES§');
});

test('a decorated name pasted from the XML resolves to the same value', () => {
  assert.equal(resolveFieldGroup(XML, '#///__KEYFIGURES§', 'ADSO_NAME'), '#///__KEYFIGURES§');
});

test('the name is matched case-insensitively', () => {
  assert.equal(resolveFieldGroup(XML, '__keyfigures', 'ADSO_NAME'), '#///__KEYFIGURES§');
});

test('an undeclared group is rejected and the declared ones are listed', () => {
  assert.throws(
    () => resolveFieldGroup(XML, 'NOSUCHGROUP', 'ADSO_NAME'),
    /has no field group "NOSUCHGROUP".*Declared groups: DATA, KEY, __KEYFIGURES/s,
  );
});

test('an aDSO without groups says so instead of naming none', () => {
  assert.throws(
    () => resolveFieldGroup('<adso:dataStore name="X"/>', 'KEY', 'X'),
    /declares no field groups at all/,
  );
});

test('an empty group name is rejected', () => {
  assert.throws(() => resolveFieldGroup(XML, '   ', 'ADSO_NAME'), /must be a field group name/);
});
