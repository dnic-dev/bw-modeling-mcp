import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLowerCase } from '../dist/tools/infoobject.js';

/** A characteristic that already allows lower case — BW writes the attribute out. */
const WITH_FLAG =
  '<?xml version="1.0" encoding="utf-8"?><iobj:infoObject name="IOBJ_NAME" xsi:type="iobj:Characteristic"' +
  ' conversionRoutine="ALPHA" withLowerCaseLetters="true" outputLength="20">' +
  '<infoObjectType>CHA</infoObjectType></iobj:infoObject>';

/** A characteristic that does not — the attribute is absent, not "false". */
const WITHOUT_FLAG =
  '<?xml version="1.0" encoding="utf-8"?><iobj:infoObject name="IOBJ_NAME" xsi:type="iobj:Characteristic"' +
  ' conversionRoutine="ALPHA" outputLength="20">' +
  '<infoObjectType>CHA</infoObjectType></iobj:infoObject>';

const flag = (xml) => xml.match(/withLowerCaseLetters="([^"]*)"/)?.[1] ?? null;

test('the attribute is added when the characteristic does not carry it yet', () => {
  assert.equal(flag(setLowerCase(WITHOUT_FLAG, true)), 'true');
});

test('the added attribute stays inside the root element', () => {
  const root = setLowerCase(WITHOUT_FLAG, true).match(/<iobj:infoObject\b[^>]*>/)[0];
  assert.match(root, /withLowerCaseLetters="true"/);
});

test('an existing attribute is replaced rather than duplicated', () => {
  const xml = setLowerCase(WITH_FLAG, false);
  assert.equal(xml.match(/withLowerCaseLetters=/g).length, 1);
  assert.equal(flag(xml), 'false');
});

test('turning the flag off on a characteristic without it leaves the XML untouched', () => {
  assert.equal(setLowerCase(WITHOUT_FLAG, false), WITHOUT_FLAG);
});

test('no other attribute of the root element is disturbed', () => {
  const xml = setLowerCase(WITHOUT_FLAG, true);
  assert.match(xml, /name="IOBJ_NAME"/);
  assert.match(xml, /conversionRoutine="ALPHA"/);
  assert.match(xml, /outputLength="20"/);
  assert.match(xml, /xsi:type="iobj:Characteristic"/);
});

test('a namespace prefix other than iobj is handled', () => {
  const xml = WITHOUT_FLAG.replace(/iobj:infoObject/g, 'InfoObject:infoObject');
  assert.equal(flag(setLowerCase(xml, true)), 'true');
});
