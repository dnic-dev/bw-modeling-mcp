import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPostBody, filterMismatchNotes, axisDropNotes, notAppliedNotes } from '../dist/tools/reporting.js';

// Response fragments as BW/4HANA 2023 returns them (ids and keys from a live system, shortened).
const view = ({ state = '', effective = '', rows = '' } = {}) =>
  '<queryView name="QUERY_NAME"><selection>' +
  `<state>${state}</state><space/><effective>${effective}</effective></selection>` +
  `<resultSet fromRow="0" toRow="5"><columns drillLvl="0"><headers/></columns>` +
  `<rows drillLvl="0"><headers>${rows}</headers><tuples size="1"><tuple tid="1"/></tuples></rows></resultSet>` +
  '<messages/></queryView>';

const sv = (attrs) => `<selectValue ${attrs}/>`;
const header = (id, name) => `<entry name="${name}" id="${id}" pos="1"/>`;

test('an interval on an internal key sends its upper bound as highInt', () => {
  const xml = buildPostBody('QUERY_NAME', {
    infoObjects: [
      { name: 'CHAR_A', id: '1', axis: 'ROWS', filterValues: [{ lowInt: '01', high: '03', op: 'BT' }] },
      { name: 'CHAR_B', id: '2', axis: 'ROWS', filterValues: [{ low: '1000', high: '2000', op: 'BT' }] },
    ],
  });
  assert.match(xml, /lowInt="01" highInt="03"/);
  assert.doesNotMatch(xml, /lowInt="01" high="03"/);
  assert.match(xml, /low="1000" high="2000"/);
});

test('an excluded node that BW turned into an included one is reported', () => {
  const xml = view({
    state: `<infoObject id="1101" name="CHAR_A" axis="ROWS" pos="1">${sv('sign="E" op="EQ" lowInt="NODE_1" nodeName="CHAR_A"')}</infoObject>`,
    effective: `<infoObject id="1101" name="CHAR_A">${sv('presentationMode="INT" sign="I" op="EQ" lowInt="NODE_1" low="NODE_1" nodeName="CHAR_A" hryMinLvl="2"')}</infoObject>`,
    rows: header('1101', 'CHAR_A'),
  });
  const notes = filterMismatchNotes(
    { infoObjects: [{ name: 'CHAR_A', id: '1101', axis: 'ROWS', filterValues: [{ lowInt: 'NODE_1', nodeId: 1, sign: 'E' }] }] },
    xml,
  );
  assert.deepEqual(notes, ['  CHAR_A: exclude EQ NODE_1 was requested, BW applied EQ NODE_1.']);
});

test('an interval that lost its upper bound is reported', () => {
  const xml = view({
    effective: `<infoObject id="1023" name="CHAR_B">${sv('presentationMode="INT_NC" sign="I" op="BT" lowInt="01" low="01"')}</infoObject>`,
  });
  const notes = filterMismatchNotes(
    { infoObjects: [{ name: 'CHAR_B', id: '1023', axis: 'ROWS', filterValues: [{ lowInt: '01', high: '03', op: 'BT' }] }] },
    xml,
  );
  assert.deepEqual(notes, ['  CHAR_B: BT 01..03 was requested, BW applied BT 01.']);
});

test('a filter BW dropped while it reports others as effective is reported', () => {
  const xml = view({ effective: `<infoObject id="8" name="CHAR_G">${sv('sign="I" op="EQ" lowInt="Y"')}</infoObject>` });
  const notes = filterMismatchNotes({
    infoObjects: [
      { name: 'CHAR_C', id: '7', axis: 'FREE', filterValues: [{ lowInt: 'X' }] },
      { name: 'CHAR_G', id: '8', axis: 'FREE', filterValues: [{ lowInt: 'Y' }] },
    ],
  }, xml);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /CHAR_C: the filter was not applied/);
});

test('an empty effective selection is no finding', () => {
  // Live case: a state filter 02 next to a variable value 01 on the same characteristic — the
  // result is empty and BW leaves <effective/> empty, although it applied the filter.
  const xml =
    '<queryView><selection><state><infoObject id="1023" name="CHAR_B" axis="ROWS" pos="1">' +
    sv('presentationMode="INT" sign="I" op="EQ" lowInt="02" low="02"') + '</infoObject></state>' +
    `<space><infoObject id="1023" name="CHAR_B">${sv('sign="I" op="EQ" lowInt="01" low="01"')}</infoObject></space>` +
    '<effective/></selection><resultSet/><messages><entry type="E" txt="No data available"/></messages></queryView>';
  assert.deepEqual(
    filterMismatchNotes({ infoObjects: [{ name: 'CHAR_B', id: '1023', axis: 'ROWS', filterValues: [{ lowInt: '02' }] }] }, xml),
    [],
  );
});

test('filters BW applied as asked raise nothing, also when it converted an external key', () => {
  const xml = view({
    effective:
      `<infoObject id="1037" name="CHAR_D">${sv('sign="I" op="EQ" lowInt="2200" low="2200"')}${sv('presentationMode="INT_NC" sign="I" op="EQ" lowInt="1000" low="1000"')}</infoObject>` +
      `<infoObject id="9" name="CHAR_E">${sv('sign="I" op="BT" lowInt="202601" highInt="202603"')}</infoObject>` +
      `<infoObject id="10" name="CHAR_F">${sv('sign="I" op="EQ" lowInt="20260131" low="20260131"')}</infoObject>`,
  });
  const notes = filterMismatchNotes({
    infoObjects: [
      { name: 'CHAR_D', id: '1037', axis: 'ROWS', filterValues: [{ low: '1000' }, { lowInt: '2200' }] },
      { name: 'CHAR_E', id: '9', axis: 'FREE', filterValues: [{ lowInt: '202601', high: '202603', op: 'BT' }] },
      // An external date that BW converts to another internal form cannot be matched; not a finding.
      { name: 'CHAR_F', id: '10', axis: 'FREE', filterValues: [{ low: '31.01.2026' }] },
    ],
  }, xml);
  assert.deepEqual(notes, []);
});

const layoutState =
  '<infoObject id="1021" name="CHAR_B" axis="ROWS" pos="2"/><infoObject id="1023" name="CHAR_C" axis="ROWS" pos="1"/>' +
  '<infoObject id="1037" name="CHAR_D" axis="ROWS" pos="3"/><infoObject id="12207" name="CHAR_X" axis="FREE" pos="1"/>' +
  '<infoObject id="2000000908" name="STRUCT" axis="COLUMNS" pos="1"/>';

test('row characteristics and the structure a state leaves out are reported', () => {
  const xml = view({ state: layoutState, rows: header('1037', 'CHAR_D') });
  const notes = axisDropNotes({ infoObjects: [{ name: 'CHAR_D', id: '1037', axis: 'ROWS', filterValues: [{ lowInt: '1000' }] }] }, xml);
  assert.equal(notes.length, 2);
  // In the query's order (pos), which is the order to list them in.
  assert.match(notes[0], /^ {2}ROWS: CHAR_C, CHAR_B are not in the result\. With a state, rows and columns show only what it lists there/);
  assert.match(notes[1], /^ {2}COLUMNS: STRUCT is not in the result\./);
});

test('listing only a FREE characteristic still drops rows and columns (live case)', () => {
  // BW echoes the query layout unchanged, but returns empty row and column headers.
  const notes = axisDropNotes({ infoObjects: [{ name: 'CHAR_X', id: '12207', axis: 'FREE' }] }, view({ state: layoutState }));
  assert.equal(notes.length, 2);
  assert.match(notes[0], /^ {2}ROWS: CHAR_C, CHAR_B, CHAR_D are not in the result\./);
  assert.match(notes[1], /^ {2}COLUMNS: STRUCT is not in the result\./);
});

test('nothing is reported when everything is listed, without a state, or without a result', () => {
  const all = [
    { name: 'CHAR_C', id: '1023', axis: 'ROWS' }, { name: 'CHAR_B', id: '1021', axis: 'ROWS' },
    { name: 'CHAR_D', id: '1037', axis: 'ROWS' }, { name: 'STRUCT', id: '2000000908', axis: 'COLUMNS' },
  ];
  const shown = view({ state: layoutState, rows: header('1023', 'CHAR_C') + header('1021', 'CHAR_B') + header('1037', 'CHAR_D') })
    .replace('<columns drillLvl="0"><headers/>', `<columns drillLvl="0"><headers>${header('2000000908', 'STRUCT')}</headers>`);
  assert.deepEqual(axisDropNotes({ infoObjects: all }, shown), []);
  assert.deepEqual(axisDropNotes(undefined, view({ state: layoutState })), []);
  const empty = `<queryView><selection><state>${layoutState}</state></selection><resultSet/><messages/></queryView>`;
  assert.deepEqual(axisDropNotes({ infoObjects: [{ name: 'CHAR_X', id: '12207', axis: 'FREE' }] }, empty), []);
});

test('the combined list keeps hierarchy, filter and layout findings apart', () => {
  const xml = view({
    state:
      '<infoObject id="1" name="CHAR_A" axis="ROWS" pos="1"><hierarchy id="11" name="H1" hryId="H1 text"/></infoObject>' +
      '<infoObject id="2" name="CHAR_B" axis="ROWS" pos="2"/>',
    effective: `<infoObject id="1" name="CHAR_A">${sv('sign="I" op="EQ" lowInt="N1"')}</infoObject>`,
    rows: header('1', 'CHAR_A'),
  });
  const notes = notAppliedNotes({
    infoObjects: [{ name: 'CHAR_A', id: '1', axis: 'ROWS', hierarchy: { id: '', name: '', hryId: '' }, filterValues: [{ lowInt: 'N1', sign: 'E', nodeId: 1 }] }],
  }, xml);
  assert.equal(notes.length, 3);
  assert.match(notes[0], /no hierarchy was requested/);
  assert.match(notes[1], /exclude EQ N1 was requested/);
  assert.match(notes[2], /ROWS: CHAR_B is not in the result/);
});
