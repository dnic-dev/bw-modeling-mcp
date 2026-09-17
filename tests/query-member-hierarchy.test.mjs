import test from 'node:test';
import assert from 'node:assert/strict';
import { walkMembers, insertKeyFigureMember, planningEl } from '../dist/tools/query_update.js';

const kyfMember = (tag, id, desc, inner = '') =>
  `<Qry:${tag} xsi:type="Qry:MemberSelection" id="${id}">` +
  `<Qry:description value="${desc}"/>` +
  `<Qry:groups infoObject="1KYFNM"><Qry:tokens/></Qry:groups>${inner}` +
  `</Qry:${tag}>`;

const formulaMember = (id, desc, inner) =>
  `<Qry:members xsi:type="Qry:MemberFormula" id="${id}">` +
  `<Qry:description value="${desc}"/><Qry:formulaDefinition/>${inner}` +
  `</Qry:members>`;

const structure = (members) =>
  '<Qry:queryResource><Qry:mainComponent>' +
  `<Qry:columns xsi:type="Qry:CustomDimension" id="S1" infoObjectName="1STRUC">${members}</Qry:columns>` +
  '</Qry:mainComponent></Qry:queryResource>';

const NESTED = formulaMember(
  'F1',
  'Total',
  kyfMember('childFormulas', 'INV', 'Inverse') + kyfMember('childMembers', 'C1', 'Actual') + kyfMember('childMembers', 'C2', 'Plan')
);

test('members are found at every depth, each knowing its parent', () => {
  const found = walkMembers(NESTED);
  assert.deepEqual(
    found.map((m) => [m.id, m.tag, m.parentId ?? null]),
    [
      ['F1', 'members', null],
      ['INV', 'childFormulas', 'F1'],
      ['C1', 'childMembers', 'F1'],
      ['C2', 'childMembers', 'F1'],
    ]
  );
});

// A lazy regex would end the parent at the first close tag of its first child.
test('a parent spans its whole subtree', () => {
  const parent = walkMembers(NESTED).find((m) => m.id === 'F1');
  assert.equal(NESTED.slice(parent.start, parent.end), NESTED);
});

test('every reported offset addresses that member exactly', () => {
  for (const m of walkMembers(NESTED)) {
    assert.equal(NESTED.slice(m.start, m.end), m.full, `offsets wrong for ${m.id}`);
  }
});

test('a member is nested under the named parent and renamed to a child element', () => {
  const doc = insertKeyFigureMember(structure(NESTED), kyfMember('members', 'N1', 'New'), 'columns', { parent: 'Total' });
  const nested = walkMembers(doc).find((m) => m.id === 'N1');
  assert.equal(nested.parentId, 'F1');
  assert.match(nested.full, /^<Qry:childMembers\b/);
  assert.match(nested.full, /<\/Qry:childMembers>$/);
});

test('a position places the member before that sibling rather than at the end', () => {
  const doc = insertKeyFigureMember(structure(NESTED), kyfMember('members', 'N1', 'New'), 'columns', {
    parent: 'Total',
    position: 0,
  });
  const children = walkMembers(doc).filter((m) => m.tag === 'childMembers');
  assert.deepEqual(children.map((m) => m.id), ['N1', 'C1', 'C2']);
});

test('a position beyond the last sibling appends', () => {
  const doc = insertKeyFigureMember(structure(NESTED), kyfMember('members', 'N1', 'New'), 'columns', {
    parent: 'Total',
    position: 99,
  });
  const children = walkMembers(doc).filter((m) => m.tag === 'childMembers');
  assert.deepEqual(children.map((m) => m.id), ['C1', 'C2', 'N1']);
});

test('a top-level position inserts among the top-level members only', () => {
  const doc = insertKeyFigureMember(
    structure(NESTED + kyfMember('members', 'M2', 'Other')),
    kyfMember('members', 'N1', 'New'),
    'columns',
    { position: 1 }
  );
  const top = walkMembers(doc).filter((m) => m.tag === 'members');
  assert.deepEqual(top.map((m) => m.id), ['F1', 'N1', 'M2']);
});

test('a negative position is rejected', () => {
  assert.throws(
    () => insertKeyFigureMember(structure(NESTED), kyfMember('members', 'N1', 'New'), 'columns', { position: -1 }),
    /non-negative integer/
  );
});

// A child member's own element name is one of the markers that delimit a member's
// own content; reading it from offset zero reported the member as empty, so its
// existing settings were lost instead of carried over.
test('a child member reads its own settings, not an empty block', () => {
  const child =
    '<Qry:childMembers id="C1"><Qry:planning>' +
    '<Qry:inputMode default="false" type="inputReady"/><Qry:disaggregation default="false" type="copy"/>' +
    '</Qry:planning></Qry:childMembers>';
  const out = planningEl(child, { disaggregation: 'no' }, '');
  assert.match(out, /<Qry:inputMode default="false" type="inputReady"\/>/);
  assert.match(out, /<Qry:disaggregation default="false" type="no"\/>/);
});
