import test from 'node:test';
import assert from 'node:assert/strict';
import { findKeyFigureStructure, planningEl, unescapeXml } from '../dist/tools/query_update.js';

const KYF_MEMBER =
  '<Qry:members xsi:type="Qry:MemberSelection" id="M1">' +
  '<Qry:description value="Amount"/>' +
  '<Qry:groups infoObject="1KYFNM"><Qry:tokens/></Qry:groups>' +
  '</Qry:members>';

const CHA_MEMBER =
  '<Qry:members xsi:type="Qry:MemberSelection" id="C1">' +
  '<Qry:description value="Region"/>' +
  '<Qry:groups infoObject="IOBJ_NAME"><Qry:tokens/></Qry:groups>' +
  '</Qry:members>';

const doc = (...containers) =>
  `<Qry:queryResource><Qry:mainComponent>${containers.join('')}</Qry:mainComponent></Qry:queryResource>`;

const structure = (container, infoObject, members) =>
  `<Qry:${container} xsi:type="Qry:CustomDimension" id="S_${infoObject}" infoObjectName="${infoObject}">` +
  `${members}</Qry:${container}>`;

// A structure this tool creates is written with 1KYFNM but comes back normalized
// to 1STRUC. Matching on the attribute alone made every later member operation
// fail with "query has no key figure structure".
test('a key figure structure is recognised after the server normalised its info object', () => {
  const found = findKeyFigureStructure(doc(structure('columns', '1STRUC', KYF_MEMBER)));
  assert.equal(found?.id, 'S_1STRUC');
});

test('a structure holding only local formulas counts as the key figure structure', () => {
  const formula = '<Qry:members xsi:type="Qry:MemberFormula" id="F1"><Qry:formulaDefinition/></Qry:members>';
  const found = findKeyFigureStructure(doc(structure('rows', '1STRUC', formula)));
  assert.equal(found?.id, 'S_1STRUC');
});

test('a characteristic structure is not mistaken for the key figure structure', () => {
  assert.equal(findKeyFigureStructure(doc(structure('rows', '1STRUC', CHA_MEMBER))), null);
});

test('the explicitly marked structure wins over a normalised one', () => {
  const found = findKeyFigureStructure(
    doc(structure('rows', '1STRUC', KYF_MEMBER), structure('columns', '1KYFNM', KYF_MEMBER))
  );
  assert.equal(found?.id, 'S_1KYFNM');
});

test('a query without any structure reports none', () => {
  assert.equal(findKeyFigureStructure(doc('')), null);
});

test('attribute values are decoded before a description is matched against them', () => {
  assert.equal(unescapeXml('Size &amp; Quality &lt;x&gt; &quot;q&quot;'), 'Size & Quality <x> "q"');
});

// The two planning settings live in one block, so writing one must not silently
// reset the other.
test('setting the input mode carries the existing disaggregation over', () => {
  const member =
    '<Qry:members id="M1"><Qry:planning>' +
    '<Qry:inputMode default="true"/><Qry:disaggregation default="false" type="copy"/>' +
    '</Qry:planning></Qry:members>';
  const out = planningEl(member, { input_mode: 'inputReady' }, '');
  assert.match(out, /<Qry:inputMode default="false" type="inputReady"\/>/);
  assert.match(out, /<Qry:disaggregation default="false" type="copy"\/>/);
});

test('setting the disaggregation carries the existing input mode over', () => {
  const member =
    '<Qry:members id="M1"><Qry:planning>' +
    '<Qry:inputMode default="false" type="inputReady"/><Qry:disaggregation default="true"/>' +
    '</Qry:planning></Qry:members>';
  const out = planningEl(member, { disaggregation: 'no' }, '');
  assert.match(out, /<Qry:inputMode default="false" type="inputReady"\/>/);
  assert.match(out, /<Qry:disaggregation default="false" type="no"\/>/);
});

test('a member without a planning block gets both settings at their default', () => {
  const out = planningEl('<Qry:members id="M1"></Qry:members>', { input_mode: 'not' }, '');
  assert.equal(
    out,
    '<Qry:planning><Qry:inputMode default="false" type="not"/><Qry:disaggregation default="true"/></Qry:planning>'
  );
});

test('false restores the server default rather than writing a type', () => {
  const member =
    '<Qry:members id="M1"><Qry:planning><Qry:inputMode default="false" type="inputReady"/>' +
    '<Qry:disaggregation default="true"/></Qry:planning></Qry:members>';
  assert.match(planningEl(member, { input_mode: false }, ''), /<Qry:inputMode default="true"\/>/);
});

test('an unknown input mode is rejected instead of being sent to the server', () => {
  assert.throws(() => planningEl('<Qry:members id="M1"/>', { input_mode: 'yes' }, ''), /input_mode must be one of/);
});

test('a disaggregation reference without a disaggregation is rejected', () => {
  assert.throws(
    () => planningEl('<Qry:members id="M1"/>', { disaggregation_reference: 'Other' }, ''),
    /requires disaggregation/
  );
});

test('a disaggregation reference on a non-absolute disaggregation is rejected', () => {
  assert.throws(
    () => planningEl('<Qry:members id="M1"/>', { disaggregation: 'copy', disaggregation_reference: 'Other' }, ''),
    /only meaningful with disaggregation "absolute"/
  );
});

// A member's nested children carry settings elements of the same names; the block
// built for the parent must be read from the parent's own content.
test('a nested child member does not supply the parent its planning block', () => {
  const member =
    '<Qry:members id="M1">' +
    '<Qry:childMembers id="C1"><Qry:planning>' +
    '<Qry:inputMode default="false" type="inputReady"/><Qry:disaggregation default="false" type="copy"/>' +
    '</Qry:planning></Qry:childMembers></Qry:members>';
  const out = planningEl(member, { input_mode: 'not' }, '');
  assert.equal(
    out,
    '<Qry:planning><Qry:inputMode default="false" type="not"/><Qry:disaggregation default="true"/></Qry:planning>'
  );
});
