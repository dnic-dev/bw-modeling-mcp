import test from 'node:test';
import assert from 'node:assert/strict';
import { walkMembers } from '../dist/tools/query_update.js';
import { moveStructureMember, structureMemberPlacement } from '../dist/tools/elem_write.js';

const member = (tag, id, inner = '') =>
  `<Qry:${tag} xsi:type="Qry:MemberSelection" flatPosition="0" id="${id}">` +
  `<Qry:description value="${id} text"/><Qry:groups infoObject="1KYFNM"><Qry:tokens/></Qry:groups>${inner}` +
  `</Qry:${tag}>`;

const doc = (members) =>
  '<Qry:queryResource><Qry:mainComponent xsi:type="Qry:CustomDimension" id="STR">' +
  '<Qry:description value="Structure"/>' +
  members +
  '</Qry:mainComponent></Qry:queryResource>';

// A: top level with children A1..A5; B: top level with one child B1; C: top level, no children.
const DOC = doc(
  member(
    'members',
    'A',
    ['A1', 'A2', 'A3', 'A4', 'A5'].map((id) => member('childMembers', id)).join('')
  ) +
    member('members', 'B', member('childMembers', 'B1')) +
    member('members', 'C')
);

const layout = (xml) => {
  const region = xml.slice(xml.indexOf('<Qry:mainComponent'));
  return walkMembers(region.slice(region.indexOf('>') + 1)).map((m) => [m.id, m.tag, m.parentId ?? null]);
};

test('position alone reorders a member among its siblings', () => {
  const out = moveStructureMember(DOC, 'A5', undefined, 1);
  assert.deepEqual(
    layout(out).filter(([, , p]) => p === 'A').map(([id]) => id),
    ['A1', 'A5', 'A2', 'A3', 'A4']
  );
  assert.deepEqual(structureMemberPlacement(out, 'A5'), { parentId: 'A', index: 1 });
});

test('moving a member down counts the position among the siblings once it is in place', () => {
  const out = moveStructureMember(DOC, 'A1', undefined, 3);
  assert.deepEqual(
    layout(out).filter(([, , p]) => p === 'A').map(([id]) => id),
    ['A2', 'A3', 'A4', 'A1', 'A5']
  );
});

test('the member keeps its own content and children when it moves', () => {
  const out = moveStructureMember(DOC, 'B', undefined, 0);
  assert.deepEqual(layout(out).slice(0, 2), [
    ['B', 'members', null],
    ['B1', 'childMembers', 'B'],
  ]);
  assert.equal(walkMembers(out).length, walkMembers(DOC).length);
});

test('parent moves a member under another one and renames it to a child element', () => {
  const out = moveStructureMember(DOC, 'C', 'B', 0);
  assert.deepEqual(structureMemberPlacement(out, 'C'), { parentId: 'B', index: 0 });
  assert.ok(out.includes('<Qry:childMembers xsi:type="Qry:MemberSelection" flatPosition="0" id="C">'));
  assert.ok(!out.includes('<Qry:members xsi:type="Qry:MemberSelection" flatPosition="0" id="C">'));
});

test('parent without position appends the member last', () => {
  const out = moveStructureMember(DOC, 'A2', 'B', undefined);
  assert.deepEqual(structureMemberPlacement(out, 'A2'), { parentId: 'B', index: 1 });
});

test('an empty parent moves a nested member to the top level, children staying nested', () => {
  const nested = moveStructureMember(DOC, 'B', 'A', 0);
  const out = moveStructureMember(nested, 'B', '', 2);
  assert.deepEqual(structureMemberPlacement(out, 'B'), { parentId: undefined, index: 2 });
  const b = layout(out).find(([id]) => id === 'B');
  assert.equal(b[1], 'members');
  assert.deepEqual(layout(out).find(([id]) => id === 'B1'), ['B1', 'childMembers', 'B']);
});

test('the parent may be given by description', () => {
  const out = moveStructureMember(DOC, 'C', 'A text', 5);
  assert.deepEqual(structureMemberPlacement(out, 'C'), { parentId: 'A', index: 5 });
});

test('a member cannot be moved under itself or its own child', () => {
  assert.throws(() => moveStructureMember(DOC, 'A', 'A', 0), /under itself or one of its own children/);
  assert.throws(() => moveStructureMember(DOC, 'A', 'A3', 0), /under itself or one of its own children/);
});

test('moving to the place the member already has leaves the document untouched', () => {
  assert.equal(moveStructureMember(DOC, 'A2', undefined, 1), DOC);
  assert.equal(moveStructureMember(DOC, 'A5', 'A', undefined), DOC);
});
