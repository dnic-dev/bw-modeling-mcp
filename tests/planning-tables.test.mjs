import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSelection,
  formatParameterTree,
  joinFormulaChunks,
} from '../dist/tools/metadata_planning.js';

// The parameter tree of a planning function is assembled from three tables that only make
// sense together: the function type declares the parameters and their nesting, the function
// carries the values, and nothing in the value rows says what nests inside what. These tests
// pin the assembly, because the mistakes it can make are silent ones — a value attributed to
// the wrong rule, a FOX program scattered over one heading per line, a parameter dropped
// because the declaration did not mention it.

const COPY_DEFS = [
  { name: 'KYFSEL', position: 10, type: '5', isTable: false, parent: '', infoObject: '' },
  { name: 'FROMTAB', position: 20, type: '4', isTable: true, parent: '', infoObject: '' },
  { name: 'FROMSEQNR', position: 23, type: '1', isTable: false, parent: 'FROMTAB', infoObject: '0RSPL_SEQNR' },
  { name: 'FROMSEL', position: 26, type: '3', isTable: false, parent: 'FROMTAB', infoObject: '' },
  { name: 'TOTAB', position: 30, type: '4', isTable: true, parent: '', infoObject: '' },
  { name: 'TOSEL', position: 36, type: '3', isTable: false, parent: 'TOTAB', infoObject: '' },
];

const FORMULA_DEFS = [
  { name: 'FORMULATAB', position: 1, type: '4', isTable: true, parent: '', infoObject: '' },
  { name: 'FSEQNR', position: 2, type: '1', isTable: false, parent: 'FORMULATAB', infoObject: '0RSPL_FSEQN' },
  { name: 'FLINE', position: 3, type: '1', isTable: false, parent: 'FORMULATAB', infoObject: '0RSPL_FLINE' },
];

const sel = (over) => ({
  RULEPOS: '1',
  INDX: '1',
  ENUM: '0001',
  SIGN: 'I',
  OPT: 'EQ',
  LOWFLAG: '1',
  HIGHFLAG: '0',
  LOW: '',
  HIGH: '',
  ...over,
});

test('a variable reference is resolved, a value is not', () => {
  const vars = new Map([['44SL6M9HXPT84PZ6GNN37RSYF', '0D_FC_P02']]);
  const variable = formatSelection(
    sel({ IOBJNM: '0CALYEAR', LOW: '44SL6M9HXPT84PZ6GNN37RSYF', LOWFLAG: '3' }),
    vars,
  );
  assert.match(variable, /variable 0D_FC_P02/);
  assert.doesNotMatch(variable, /44SL6M9/, 'the UID is replaced, not appended');

  // An unresolvable UID still has to be recognisable as a reference rather than a value.
  const unresolved = formatSelection(
    sel({ IOBJNM: '0CALYEAR', LOW: 'AAAAAAAAAAAAAAAAAAAAAAAAA', LOWFLAG: '3' }),
    new Map(),
  );
  assert.match(unresolved, /variable AAAAAAAAAAAAAAAAAAAAAAAAA/);

  assert.match(formatSelection(sel({ IOBJNM: 'ZGVVERS', LOW: 'ACTL' }), vars), /"ACTL"/);
});

test("BW's own initial value is spelled out rather than left as a bare #", () => {
  const line = formatSelection(sel({ IOBJNM: '0CALMONTH', LOW: '#', SIGN: 'E' }), new Map());
  assert.match(line, /\[E EQ\]/);
  assert.match(line, /initial \/ unassigned/);
});

test('an interval keeps both bounds', () => {
  const line = formatSelection(
    sel({ IOBJNM: '0CALYEAR', OPT: 'BT', LOW: '2020', HIGH: '2025', HIGHFLAG: '1' }),
    new Map(),
  );
  assert.match(line, /"2020".*to.*"2025"/);
});

test('a namespaced characteristic is shown the way the API spells it', () => {
  assert.match(formatSelection(sel({ IOBJNM: '/BIC/ZFIELD', LOW: 'X' }), new Map()), /\$BIC\$ZFIELD/);
});

test('table rows keep their parameters together', () => {
  const values = [
    { RULEPOS: '1', PARNM: 'FROMSEQNR', INDX: '1', VALUE: '000000' },
    { RULEPOS: '1', PARNM: 'FROMSEQNR', INDX: '2', VALUE: '000001' },
  ];
  const selections = [
    sel({ PARNM: 'FROMSEL', INDX: '1', IOBJNM: 'ZGVVERS', LOW: 'ACTL' }),
    sel({ PARNM: 'FROMSEL', INDX: '2', IOBJNM: 'ZGVVERS', LOW: 'FCST' }),
    sel({ PARNM: 'TOSEL', INDX: '1', IOBJNM: 'ZGVVERS', LOW: 'PLAN' }),
  ];
  const text = formatParameterTree(COPY_DEFS, values, selections, new Map(), new Map()).join('\n');

  assert.match(text, /FROMTAB/);
  assert.match(text, /Row 1/);
  assert.match(text, /Row 2/);
  // The second row's value must not be attributed to the first: ACTL belongs above FCST,
  // and each sits under its own row heading.
  const rows = text.split('Row 2');
  assert.match(rows[0], /ACTL/);
  assert.doesNotMatch(rows[0], /FCST/);
  assert.match(rows[1], /FCST/);
});

// BW does not store a formula one row per source line. It stores a character stream cut into
// fixed-width chunks whose line breaks sit inside the values, so a reader that prints one row
// per chunk cuts words in half. These pin the reassembly.

test('a FOX formula is reassembled from its chunks, not printed per chunk', () => {
  // 20-character chunks with the line breaks inside them, the way the table holds them.
  // Chunk 2 stored a trailing blank that DataPreview stripped, so it arrives one short.
  const chunks = [
    { RULEPOS: '1', PARNM: 'FLINE', INDX: '1', VALUE: 'DATA BETRAG TYPE F.\n' },
    { RULEPOS: '1', PARNM: 'FLINE', INDX: '2', VALUE: 'BETRAG = { 0AMOUNT,' },
    { RULEPOS: '1', PARNM: 'FLINE', INDX: '3', VALUE: '# } / 12.' },
  ];
  assert.deepEqual(joinFormulaChunks(chunks), [
    'DATA BETRAG TYPE F.',
    'BETRAG = { 0AMOUNT, # } / 12.',
  ]);
});

test('a chunk boundary inside a word does not gain a blank', () => {
  // The real case from a live system: the cut falls mid-identifier, and both chunks carry
  // the full storage width. Joining them must not insert anything.
  const chunks = [
    { PARNM: 'FLINE', INDX: '1', VALUE: '*  ASSUMP' },
    { PARNM: 'FLINE', INDX: '2', VALUE: 'TION FOR' },
  ];
  assert.deepEqual(joinFormulaChunks(chunks), ['*  ASSUMPTION FOR']);
});

test('blanks lost to trailing-space stripping are restored at the chunk boundary', () => {
  // DataPreview strips trailing blanks, so a chunk that ended in spaces arrives short. The
  // width of the widest chunk is the storage width, and padding back to it restores them.
  const chunks = [
    { PARNM: 'FLINE', INDX: '1', VALUE: '*  ASSUMPTION' },
    { PARNM: 'FLINE', INDX: '2', VALUE: 'FOR FIELDS TO BE' },
  ];
  assert.deepEqual(joinFormulaChunks(chunks), ['*  ASSUMPTION   FOR FIELDS TO BE']);
});

test('chunks are joined in numeric INDX order', () => {
  // Same width for every chunk, which is how fixed-width storage hands them over.
  const chunks = Array.from({ length: 11 }, (_, i) => ({
    PARNM: 'FLINE',
    INDX: String(i + 1),
    VALUE: String(i + 1).padStart(3, '0'),
  }));
  // Chunk 10 must not land between 1 and 2.
  assert.deepEqual(joinFormulaChunks(chunks), ['001002003004005006007008009010011']);
});

test('a formula short enough for one chunk is left alone', () => {
  assert.deepEqual(
    joinFormulaChunks([{ PARNM: 'FLINE', INDX: '1', VALUE: '0AMOUNT = 0QUANTITY * ZPRICE.' }]),
    ['0AMOUNT = 0QUANTITY * ZPRICE.'],
  );
  assert.deepEqual(joinFormulaChunks([]), []);
});

test('the formula appears as a code block, and its chunk numbers do not', () => {
  const values = [
    { RULEPOS: '1', PARNM: 'FSEQNR', INDX: '1', VALUE: '0000' },
    { RULEPOS: '1', PARNM: 'FSEQNR', INDX: '2', VALUE: '0001' },
    { RULEPOS: '1', PARNM: 'FLINE', INDX: '1', VALUE: 'DATA ZP TYPE F.\n' },
    { RULEPOS: '1', PARNM: 'FLINE', INDX: '2', VALUE: '0AMOUNT = ZP.' },
  ];
  const text = formatParameterTree(FORMULA_DEFS, values, [], new Map(), new Map());
  const joined = text.join('\n');

  assert.match(joined, /2 line\(s\)/);
  assert.doesNotMatch(joined, /Row 2/, 'a formula is one program, not a table of rows');
  // The chunk number repeats once per chunk and says nothing the order does not.
  assert.doesNotMatch(joined, /FSEQNR/, 'the chunk number is bookkeeping, not content');
  assert.deepEqual(
    text.filter((l) => l.includes('|')).map((l) => l.trim()),
    ['| DATA ZP TYPE F.', '| 0AMOUNT = ZP.'],
  );
});

test('several rules stay apart', () => {
  const values = [
    { RULEPOS: '1', PARNM: 'FROMSEQNR', INDX: '1', VALUE: '000000' },
    { RULEPOS: '2', PARNM: 'FROMSEQNR', INDX: '1', VALUE: '000001' },
  ];
  const text = formatParameterTree(COPY_DEFS, values, [], new Map(), new Map()).join('\n');
  assert.match(text, /Rule 1/);
  assert.match(text, /Rule 2/);
  const [, first, second] = text.split(/Rule \d/);
  assert.match(first, /000000/);
  assert.doesNotMatch(first, /000001/);
  assert.match(second, /000001/);
});

test('a parameter the function type does not declare is named, not dropped', () => {
  // A customer function type whose declaration could not be read would otherwise lose every
  // value it carries, and the output would look complete while saying nothing.
  const values = [{ RULEPOS: '1', PARNM: 'ZCUSTOM_PARAM', INDX: '1', VALUE: '42' }];
  const text = formatParameterTree(COPY_DEFS, values, [], new Map(), new Map()).join('\n');
  assert.match(text, /ZCUSTOM_PARAM/);
  assert.match(text, /not declared by the function type/);
  assert.match(text, /"42"/);
});

test('parameter labels are used where the function type supplies one', () => {
  const values = [{ RULEPOS: '1', PARNM: 'FROMSEQNR', INDX: '1', VALUE: '000000' }];
  const labels = new Map([['FROMTAB', 'From-To Table'], ['FROMSEQNR', 'Sequence Number']]);
  const text = formatParameterTree(COPY_DEFS, values, [], labels, new Map()).join('\n');
  assert.match(text, /FROMTAB — From-To Table/);
  assert.match(text, /FROMSEQNR — Sequence Number/);
});

test('a function with no values at all says so instead of printing an empty tree', () => {
  assert.deepEqual(formatParameterTree(COPY_DEFS, [], [], new Map(), new Map()), [
    '  (no parameter values)',
  ]);
});
