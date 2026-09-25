import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeHexChar,
  renderSettings,
  renderSelection,
  groupRoutines,
} from '../dist/tools/metadata_infopackage.js';

test('a hex-encoded separator becomes the character, with the raw value kept', () => {
  assert.deepEqual(decodeHexChar('003B'), { char: ';', raw: '003B' });
  assert.deepEqual(decodeHexChar('0022'), { char: '"', raw: '0022' });
});

test('a one-byte separator from a non-Unicode system decodes as well', () => {
  assert.deepEqual(decodeHexChar('2C'), { char: ',', raw: '2C' });
});

test('invisible separators are named rather than printed', () => {
  assert.equal(decodeHexChar('0009').char, 'tab');
  assert.equal(decodeHexChar('0020').char, 'space');
});

test('an unset or malformed RAW value decodes to nothing', () => {
  assert.equal(decodeHexChar('0000'), undefined);
  assert.equal(decodeHexChar(''), undefined);
  assert.equal(decodeHexChar('XYZ'), undefined);
});

const FILE_ROW = {
  LNR: '         1',
  KIND: 'D',
  QUELLE: 'Q',
  ZIEL: '1',
  SELUPDIC: '',
  FREMDSYS: 'X',
  LOCATION: '1',
  FILENAME: 'C:\\DATA\\FILE.csv',
  FILETYP: '2',
  FILESEP: '003B',
  ESC: '0022',
  CHAR1000: '',
  DEZICHAR: '',
  IGNORELINES: '01',
  CONVEXIT_OFF: 'X',
  NUMBER_AT_ERR: '1000 ',
  UNICODE_CODEPAGE: '0000',
  UNICODE_REPLACE: '#',
  METADATA_SYNC: 'X',
  SEL_1000: 'X',
  INFOPAKID: 'INFO_ID',
};

test('file settings are rendered with their meaning and only when set', () => {
  const text = renderSettings([FILE_ROW]).join('\n');
  assert.match(text, /File location:\s+local workstation \(client\) \(1\)/);
  assert.match(text, /File type:\s+CSV \(2\)/);
  assert.match(text, /Separator:\s+";"  \(raw 003B\)/);
  assert.match(text, /Escape sign:\s+"""  \(raw 0022\)/);
  assert.match(text, /Header rows:\s+1 skipped/);
  assert.match(text, /internal format/);
  assert.match(text, /cancel after 1000 erroneous records/);
  assert.match(text, /Processing:\s+PSA only \(1\)/);
  assert.doesNotMatch(text, /Code page/);
  assert.doesNotMatch(text, /Thousands/);
});

test('a setting this reader does not interpret is shown raw instead of dropped', () => {
  const text = renderSettings([FILE_ROW]).join('\n');
  assert.match(text, /Not interpreted:\s+SEL_1000=X/);
});

test('the file location is left out when the InfoPackage does not read a file', () => {
  const text = renderSettings([{ ...FILE_ROW, FREMDSYS: '', FILENAME: '', LOCATION: '0' }]).join('\n');
  assert.doesNotMatch(text, /File location/);
});

test('the data targets of a 3.x InfoPackage are collected across its header rows', () => {
  const rows = [
    { ...FILE_ROW, SELUPDIC: 'CUBE_A' },
    { ...FILE_ROW, LNR: '2', SELUPDIC: 'CUBE_B' },
  ];
  assert.match(renderSettings(rows).join('\n'), /Data targets:\s+CUBE_A, CUBE_B/);
});

test('a fixed selection shows its range', () => {
  const line = renderSelection({ FIELDNAME: 'FIELD_NAME', IOBJNM: 'IOBJ_NAME', SIGN: 'I', OPT: 'BT', LOW: '2019001', HIGH: '2019004', VARTYP: '' });
  assert.match(line, /^FIELD_NAME \(IOBJ_NAME\)\s+I BT "2019001" \.\. "2019004"$/);
});

test('a dynamic selection names its rule, not just the value it last produced', () => {
  const routine = renderSelection({ FIELDNAME: 'FIELD_A', IOBJNM: 'FIELD_A', SIGN: 'I', OPT: 'EQ', LOW: '', VARTYP: '6' });
  assert.match(routine, /ABAP routine/);
  const variable = renderSelection({ FIELDNAME: 'FIELD_B', VARTYP: '7', BEX_VARIABLE: 'VAR_NAME', LOW: 'X' });
  assert.match(variable, /OLAP variable — variable VAR_NAME/);
  assert.match(variable, /stored value: I EQ "X"/);
  const yesterday = renderSelection({ FIELDNAME: 'FIELD_C', VARTYP: '0' });
  assert.match(yesterday, /dynamic: yesterday/);
});

test('routine lines are grouped per field in numeric order, declarations first', () => {
  const groups = groupRoutines([
    { FIELDNAME: 'FIELD_A', LNR: '10 ', LINE: 'line ten' },
    { FIELDNAME: 'FIELD_A', LNR: '2 ', LINE: 'line two   ' },
    { FIELDNAME: '', LNR: '1 ', LINE: '* DATA: ...' },
  ]);
  assert.equal(groups[0].field, '');
  assert.deepEqual(groups[1], { field: 'FIELD_A', lines: ['line two', 'line ten'] });
});
