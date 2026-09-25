import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCellOperations, findCells } from '../dist/tools/query_cells.js';

// Document shape follows a modeling-tools trace of a query with a key figure structure on
// the rows and a characteristic structure on the columns: firstCustomDimension names the
// row structure, so its members are coordinateMember1.

const member = (id, desc, children = '') =>
  `<Qry:members xsi:type="Qry:MemberSelection" id="${id}"><Qry:description default="false" value="${desc}"/>${children}</Qry:members>`;
const child = (id, desc) =>
  `<Qry:childMembers xsi:type="Qry:MemberSelection" id="${id}"><Qry:description default="false" value="${desc}"/></Qry:childMembers>`;

const doc = (cells = '', decimals = '<Qry:decimals/>') => `<Qry:queryResource>
  <Qry:mainComponent xsi:type="Qry:Query" id="Q" firstCustomDimension="S_ROWS">
    <Qry:priorities>
      <Qry:scaling/>
      ${decimals}
      <Qry:convTarget/>
    </Qry:priorities>
    <Qry:columns xsi:type="Qry:CustomDimension" id="S_COLS" infoObjectName="1STRUC">
      <Qry:description value="Column Structure"/>
      ${member('C_BASE', 'Base', child('C_SPEC', 'Specific'))}
    </Qry:columns>
    <Qry:rows xsi:type="Qry:CustomDimension" id="S_ROWS" infoObjectName="1KYFNM">
      <Qry:description value="Row Structure"/>
      ${member('R_AMOUNT', 'Amount')}
      ${member('R_QTY', 'Quantity')}
    </Qry:rows>
    <Qry:free xsi:type="Qry:Dimension" id="F1" infoObjectName="CHAR_NAME"></Qry:free>
${cells}    <Qry:runtimeProperties forceDBPushDown="0"/>
  </Qry:mainComponent>
</Qry:queryResource>`;

test('a reference cell is written with the coordinates ordered by structure, not by argument', () => {
  const { doc: out, reports } = applyCellOperations(doc(), [
    { action: 'add_reference_cell', row_member: 'Base', column_member: 'Amount' },
  ]);
  const [cell] = findCells(out);
  assert.equal(cell.type, 'ReferenceCell');
  assert.equal(cell.coord1, 'R_AMOUNT');
  assert.equal(cell.coord2, 'C_BASE');
  assert.equal(reports[0].cell_id, '!VIRTUAL-1');
  assert.ok(out.indexOf('<Qry:gridCells') > out.indexOf('</Qry:free>'));
  assert.ok(out.indexOf('<Qry:gridCells') < out.indexOf('<Qry:runtimeProperties'));
});

test('a formula cell creates the reference cells of the intersections it reads', () => {
  const { doc: out, reports } = applyCellOperations(doc(), [
    { action: 'add_help_cell', description: 'Quantity / 100', formula: {
      type: 'operator', code: '/', operands: [
        { type: 'operator', code: 'NODIM', operands: [{ type: 'cell', row_member: 'Quantity', column_member: 'Base' }] },
        { type: 'constant', value: 100 },
      ] } },
    { action: 'add_formula_cell', row_member: 'Amount', column_member: 'Specific', decimals: 2, formula: {
      type: 'operator', code: 'NOERR', operands: [{ type: 'operator', code: '/', operands: [
        { type: 'cell', row_member: 'Amount', column_member: 'Base' },
        { type: 'cell', cell: 'Quantity / 100' },
      ] }] } },
  ]);
  const cells = findCells(out);
  assert.deepEqual(cells.map((c) => `${c.kind}:${c.type}`), [
    'helpCells:FormulaCell', 'gridCells:ReferenceCell', 'gridCells:ReferenceCell', 'gridCells:FormulaCell',
  ]);
  const help = cells[0];
  const formula = cells[3];
  assert.equal(reports[0].created_reference_cells.length, 1);
  assert.equal(reports[1].created_reference_cells.length, 1);
  assert.ok(help.full.includes(`member="${reports[0].created_reference_cells[0]}" operandType="Member"`));
  assert.ok(formula.full.includes(`member="${help.id}" operandType="Member"`));
  assert.ok(formula.full.includes('<Qry:decimals default="false" number="2"/>'));
  assert.equal(formula.coord1, 'R_AMOUNT');
  assert.equal(formula.coord2, 'C_SPEC');
  assert.match(out, new RegExp(`<Qry:decimals>\\s*<Qry:tokens id="${formula.id.replace('!', '\\!')}" priority="1"/>\\s*</Qry:decimals>`));
});

test('an intersection that already has a cell is reused as an operand and refused as a target', () => {
  const first = applyCellOperations(doc(), [{ action: 'add_reference_cell', row_member: 'Amount', column_member: 'Base', description: 'Base amount' }]);
  const second = applyCellOperations(first.doc, [
    { action: 'add_formula_cell', row_member: 'Quantity', column_member: 'Specific', formula: { type: 'cell', row_member: 'Amount', column_member: 'Base' } },
  ]);
  assert.equal(second.reports[0].created_reference_cells.length, 0);
  assert.throws(
    () => applyCellOperations(first.doc, [{ action: 'add_reference_cell', row_member: 'R_AMOUNT', column_member: 'C_BASE' }]),
    /already has a cell/
  );
});

test('a selection help cell carries its key figure and restrictions', () => {
  const { doc: out } = applyCellOperations(doc(), [
    { action: 'add_help_cell', description: 'Restricted quantity', key_figure: 'kyf_name',
      restrictions: [{ infoobject: 'char_name', values: [{ value: '15' }] }] },
  ]);
  const [cell] = findCells(out);
  assert.equal(cell.type, 'SelectionCell');
  assert.ok(cell.full.includes('<Qry:value>KYF_NAME</Qry:value>'));
  assert.ok(cell.full.includes('<Qry:groups infoObject="CHAR_NAME">'));
});

test('members of the same structure do not make a cell', () => {
  assert.throws(
    () => applyCellOperations(doc(), [{ action: 'add_reference_cell', row_member: 'Amount', column_member: 'Quantity' }]),
    /same structure/
  );
});

test('cell formulas reject structure member operands', () => {
  assert.throws(
    () => applyCellOperations(doc(), [{ action: 'add_help_cell', description: 'X', formula: { type: 'member', description: 'Amount' } }]),
    /references cells/
  );
});

test('update changes the formula and decimals; remove is refused while referenced and cleans up priorities', () => {
  const built = applyCellOperations(doc(), [
    { action: 'add_help_cell', description: 'Divisor', formula: { type: 'constant', value: 365 } },
    { action: 'add_formula_cell', row_member: 'Amount', column_member: 'Specific', decimals: 1,
      formula: { type: 'operator', code: '/', operands: [{ type: 'cell', row_member: 'Amount', column_member: 'Base' }, { type: 'cell', cell: 'Divisor' }] } },
  ]).doc;
  const updated = applyCellOperations(built, [
    { action: 'update_cell', cell: 'Divisor', formula: { type: 'constant', value: 12 }, description: 'Months' },
  ]).doc;
  const help = findCells(updated).find((c) => c.kind === 'helpCells');
  assert.equal(help.description, 'Months');
  assert.ok(help.full.includes('value="12"'));
  assert.throws(() => applyCellOperations(updated, [{ action: 'remove_cell', cell: 'Months' }]), /referenced by the formula/);

  const removed = applyCellOperations(updated, [
    { action: 'remove_cell', row_member: 'Amount', column_member: 'Specific' },
    { action: 'remove_cell', cell: 'Months' },
  ]).doc;
  const left = findCells(removed);
  assert.deepEqual(left.map((c) => c.type), ['ReferenceCell']);
  assert.ok(removed.includes('<Qry:decimals/>'));
});

test('the running cell number continues from the existing cells', () => {
  const existing =
    '    <Qry:gridCells xsi:type="Qry:ReferenceCell" id="CELL1"><Qry:description value="Cell 41"/>' +
    '<Qry:defaultHint><Qry:type>Constant</Qry:type><Qry:value>41</Qry:value></Qry:defaultHint>' +
    '<Qry:coordinateMember1>R_QTY</Qry:coordinateMember1><Qry:coordinateMember2>C_BASE</Qry:coordinateMember2></Qry:gridCells>\n';
  const { doc: out } = applyCellOperations(doc(existing), [{ action: 'add_reference_cell', row_member: 'Amount', column_member: 'Base' }]);
  const added = findCells(out).find((c) => c.id !== 'CELL1');
  assert.ok(added.full.includes('<Qry:value>42</Qry:value>'));
});

// The order the server returns a saved query in: runtime properties first, no priorities
// block while nothing is prioritized, the filter before the axes.
const serverDoc = `<Qry:queryResource>
  <Qry:mainComponent xsi:type="Qry:Query" id="Q" firstCustomDimension="S_ROWS">
    <Qry:entityProperties/>
    <Qry:runtimeProperties forceDBPushDown="0"/>
    <Qry:documentLinks/>
    <Qry:filter id="F"/>
    <Qry:rows xsi:type="Qry:CustomDimension" id="S_ROWS">${member('R_AMOUNT', 'Amount')}</Qry:rows>
    <Qry:columns xsi:type="Qry:CustomDimension" id="S_COLS">${member('C_BASE', 'Base')}${member('C_SPEC', 'Specific')}</Qry:columns>
  </Qry:mainComponent>
</Qry:queryResource>`;

test('without a priorities block one is created before the filter, and cells follow the axes', () => {
  const { doc: out } = applyCellOperations(serverDoc, [
    { action: 'add_formula_cell', row_member: 'Amount', column_member: 'Specific', decimals: 2, scaling: 3,
      formula: { type: 'cell', row_member: 'Amount', column_member: 'Base' } },
  ]);
  const prio = out.match(/<Qry:priorities>[\s\S]*?<\/Qry:priorities>/)[0];
  assert.ok(out.indexOf('<Qry:priorities>') < out.indexOf('<Qry:filter'));
  assert.ok(prio.indexOf('<Qry:scaling>') < prio.indexOf('<Qry:decimals>'));
  assert.equal((prio.match(/<Qry:tokens id="!VIRTUAL-2" priority="1"\/>/g) ?? []).length, 2);
  assert.ok(out.indexOf('<Qry:gridCells') > out.indexOf('</Qry:columns>'));
  assert.ok(out.indexOf('<Qry:gridCells') > out.indexOf('<Qry:runtimeProperties'));
});

test('priorities the server wrote with padding are counted', () => {
  const padded = serverDoc.replace('<Qry:filter',
    '<Qry:priorities><Qry:decimals><Qry:tokens id="OTHER" priority="7 "/></Qry:decimals></Qry:priorities><Qry:filter');
  const { doc: out } = applyCellOperations(padded, [
    { action: 'add_reference_cell', row_member: 'Amount', column_member: 'Base', decimals: 1 },
  ]);
  assert.match(out, /<Qry:tokens id="!VIRTUAL-1" priority="8"\/>/);
});
