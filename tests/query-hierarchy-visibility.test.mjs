import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQueryDocument, formatHierarchy } from '../dist/tools/query.js';
import { parseStateHierarchies, hierarchyMismatchNotes } from '../dist/tools/reporting.js';

const hierarchyBlock = ({ active = 'true', name = '', version = '<Qry:version/>', dateTo = '<Qry:dateTo/>', options = '' } = {}) =>
  `<Qry:hierarchy active="${active}">` +
  (name ? `<Qry:name>${name}</Qry:name>` : '<Qry:name/>') +
  version + dateTo + options +
  '</Qry:hierarchy>';

const dimension = (container, iobj, hierarchy) =>
  `<Qry:${container} xsi:type="Qry:Dimension" id="ID_${iobj}" infoObjectName="${iobj}">` +
  `<Qry:description value="${iobj} text"/><Qry:sorting default="true"/>` +
  (hierarchy ?? hierarchyBlock({ active: 'false' })) +
  `</Qry:${container}>`;

const doc = ({ main = '', subs = '' } = {}) =>
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<Qry:queryResource xmlns:Qry="http://www.sap.com/bw/qry" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:atom="http://www.w3.org/2005/Atom">' +
  '<Qry:mainComponent id="MAINID" technicalName="QUERY_NAME" providerName="PROVIDER">' +
  '<Qry:description value="QUERY_NAME text"/>' +
  '<Qry:entityProperties><atom:link rel="related" href="/sap/bw/modeling/adso/provider/a"/></Qry:entityProperties>' +
  main +
  '</Qry:mainComponent>' + subs +
  '</Qry:queryResource>';

const literal = (v) => `<Qry:value>${v}</Qry:value><Qry:type>Value</Qry:type>`;

test('an active hierarchy on a row characteristic is reported with its literal name, version and key date', () => {
  const q = parseQueryDocument(doc({
    main: dimension('rows', 'CHAR_A', hierarchyBlock({
      name: literal('0001'),
      version: `<Qry:version>${literal('A')}</Qry:version>`,
      dateTo: `<Qry:dateTo>${literal('99991231')}</Qry:dateTo>`,
    })),
  }), 'QUERY_NAME');
  // "0001" must not turn into 1, which the main parser would do.
  assert.deepEqual(q.rows[0].hierarchy, { name: '0001', active: true, version: 'A', keyDate: '99991231' });
});

test('no hierarchy is reported where none is assigned, and a zero key date is left out', () => {
  const q = parseQueryDocument(doc({
    main:
      dimension('rows', 'CHAR_A') +
      dimension('free', 'CHAR_B', hierarchyBlock({ name: literal('HIER_B'), dateTo: `<Qry:dateTo>${literal('00000000')}</Qry:dateTo>` })),
  }), 'QUERY_NAME');
  assert.equal(q.rows[0].hierarchy, undefined);
  assert.deepEqual(q.freeCharacteristics[0].hierarchy, { name: 'HIER_B', active: true });
});

test('an assigned but inactive hierarchy says so', () => {
  const q = parseQueryDocument(doc({
    main: dimension('columns', 'CHAR_C', hierarchyBlock({ active: 'false', name: literal('HIER_C') })),
  }), 'QUERY_NAME');
  assert.equal(q.columns[0].hierarchy.active, false);
  assert.match(formatHierarchy(q.columns[0].hierarchy), /^HIER_C \(assigned, not active\)$/);
});

test('a hierarchy chosen by a variable is named after the variable', () => {
  const q = parseQueryDocument(doc({
    main: dimension('rows', 'CHAR_A', hierarchyBlock({
      name: '<Qry:value>VAR_HIER</Qry:value><Qry:variable>VARID1</Qry:variable><Qry:type>Variable</Qry:type>',
    })),
    subs:
      '<Qry:subComponents xsi:type="Qry:Variable" id="VARID1" technicalName="VAR_HIER" infoObject="CHAR_A">' +
      '<Qry:description value="Hierarchy"/><Qry:type>Hierarchy</Qry:type></Qry:subComponents>',
  }), 'QUERY_NAME');
  assert.equal(q.rows[0].hierarchy.name, 'variable VAR_HIER');
});

test('only display options that differ from the default are reported', () => {
  const q = parseQueryDocument(doc({
    main: dimension('rows', 'CHAR_A', hierarchyBlock({
      name: literal('HIER_A'),
      options:
        '<Qry:expandToLevel default="false" level="03"/>' +
        '<Qry:positionOfChildNodes default="false" up="true"/>' +
        '<Qry:valuesOfPostableNodes default="true"/>' +
        '<Qry:suppressNodes default="false" suppress="true"/>' +
        '<Qry:sorting default="false" sortBy="Text" sortDirection="Descending"/>',
    })),
  }), 'QUERY_NAME');
  const h = q.rows[0].hierarchy;
  assert.deepEqual(h, {
    name: 'HIER_A', active: true, expandToLevel: 3, childNodePosition: 'above',
    suppressSingleChildNodes: true, sorting: 'Text Descending',
  });
  assert.equal(
    formatHierarchy(h),
    'HIER_A (active), expand to level 3, child nodes above, suppress nodes with one child, sorted by Text Descending',
  );
});

test('a structure in the layout carries no hierarchy', () => {
  const q = parseQueryDocument(doc({
    main:
      '<Qry:columns xsi:type="Qry:CustomDimension" id="STRUCT" technicalName="STRUCT_A"><Qry:description value="KF"/></Qry:columns>' +
      dimension('columns', 'CHAR_C', hierarchyBlock({ name: literal('HIER_C') })),
  }), 'QUERY_NAME');
  assert.equal(q.columns[0].hierarchy, undefined);
  assert.equal(q.columns[1].hierarchy.name, 'HIER_C');
});

// ── bw_query_data: requested vs. reported hierarchy ─────────────────────────────

const response = (state) =>
  `<queryView name="QUERY_NAME"><selection><state>${state}</state><space/><effective/></selection><resultSet/><messages/></queryView>`;

const io = (id, name, hierarchy) => ({ name, id, axis: 'ROWS', hierarchy });

test('the state of a response yields the hierarchy per InfoObject, or none', () => {
  const m = parseStateHierarchies(response(
    '<infoObject id="1021" name="CHAR_B" axis="ROWS" pos="2"/>' +
    '<infoObject id="1101" name="CHAR_A" axis="ROWS" pos="4"><hierarchy id="11" name="A" hryId="Standard Hierarchy" hryDateFrom="00000000" hryDateTo="99991231"/></infoObject>',
  ));
  assert.equal(m.get('1021'), null);
  assert.deepEqual(m.get('1101'), { name: 'A', hryId: 'Standard Hierarchy' });
});

test('a request to switch a hierarchy off that BW ignored is reported', () => {
  const xml = response('<infoObject id="1101" name="CHAR_A" axis="ROWS" pos="4"><hierarchy id="11" name="A" hryId="Standard Hierarchy"/></infoObject>');
  const notes = hierarchyMismatchNotes({ infoObjects: [io('1101', 'CHAR_A', { id: '', name: '', hryId: '' })] }, xml);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /CHAR_A: no hierarchy was requested, BW applied hierarchy A \(Standard Hierarchy\)/);
});

test('a request for another hierarchy is reported, a matching one is not', () => {
  const xml = response('<infoObject id="1101" name="CHAR_A" axis="ROWS" pos="4"><hierarchy id="11" name="A" hryId="Standard Hierarchy"/></infoObject>');
  assert.match(
    hierarchyMismatchNotes({ infoObjects: [io('1101', 'CHAR_A', { id: '12', name: 'B', hryId: 'Other' })] }, xml)[0],
    /hierarchy B was requested, BW applied hierarchy A/,
  );
  assert.deepEqual(hierarchyMismatchNotes({ infoObjects: [io('1101', 'CHAR_A', { id: '11', name: 'A', hryId: 'Standard Hierarchy' })] }, xml), []);
});

test('nothing is reported without a requested hierarchy, or when the response has no state for it', () => {
  const xml = response('<infoObject id="1101" name="CHAR_A" axis="ROWS" pos="4"><hierarchy id="11" name="A" hryId="X"/></infoObject>');
  assert.deepEqual(hierarchyMismatchNotes({ infoObjects: [io('1101', 'CHAR_A', undefined)] }, xml), []);
  assert.deepEqual(hierarchyMismatchNotes(undefined, xml), []);
  assert.deepEqual(hierarchyMismatchNotes({ infoObjects: [io('9999', 'CHAR_X', { id: '', name: 'B', hryId: '' })] }, xml), []);
});
