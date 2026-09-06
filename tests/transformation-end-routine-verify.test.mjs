import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEndRoutineTargets } from '../dist/tools/transformation.js';

const endRule = (targets) =>
  `<rule id="7" routinetype="END">` +
  targets.map((f, i) => `<target id="${i + 1}"><elementRef>#///target/segment1/${f}</elementRef></target>`).join('') +
  `<step xsi:type="trfn:StepRoutine" id="1" type="ROUTINE" rank="MAIN"/></rule>`;

const doc = (inner) => `<trfn:transformation><group id="0" type="G">${inner}</group>` +
  `<group id="1" type="S"><rule id="8"><target id="1"/>` +
  `<step xsi:type="trfn:StepDirect" id="1"/></rule></group></trfn:transformation>`;

test('counts the target fields of the END rule only', () => {
  const r = readEndRoutineTargets(doc(endRule(['FIELD_A', 'FIELD_B', 'FIELD_C'])));
  assert.equal(r.endRoutinePresent, true);
  assert.equal(r.targetCount, 3);
});

test('a document whose END rule was dropped is reported as missing, not as zero fields', () => {
  const r = readEndRoutineTargets(doc(''));
  assert.equal(r.endRoutinePresent, false);
  assert.equal(r.targetCount, 0);
});

test('targets of following rules are not counted towards the END routine', () => {
  // The field-mapping rule in the second group carries a <target> of its own.
  const r = readEndRoutineTargets(doc(endRule(['FIELD_A'])));
  assert.equal(r.targetCount, 1);
});

test('a step carrying child elements does not hide the targets', () => {
  const withChildren =
    `<rule id="7" routinetype="END">` +
    `<target id="1"><elementRef>#///target/segment1/FIELD_A</elementRef></target>` +
    `<step xsi:type="trfn:StepRoutine" id="1" type="ROUTINE">` +
    `<output id="1"><element name="FIELD_A"><inlineType name="CHAR" length="10"/></element></output>` +
    `</step></rule>`;
  const r = readEndRoutineTargets(doc(withChildren));
  assert.equal(r.endRoutinePresent, true);
  assert.equal(r.targetCount, 1);
});

test('a wide field list is counted exactly, well past the INT1 step-id boundary', () => {
  const many = Array.from({ length: 301 }, (_, i) => `ZF${String(i + 1).padStart(3, '0')}`);
  assert.equal(readEndRoutineTargets(doc(endRule(many))).targetCount, 301);
});

import { buildHanaEndSelect } from '../dist/tools/transformation.js';

const seg = (elements) =>
  `<target><segment name="segment1">${elements}</segment></target>`;

test('a pure aDSO field keeps its own column name', () => {
  const sql = buildHanaEndSelect(seg('<element posit="0004" name="FIELD_NAME"/>'));
  assert.match(sql, /^ {2}FIELD_NAME,$/m);
  assert.doesNotMatch(sql, /BIC/);
});

test('a custom InfoObject is mapped to its quoted /BIC/ column', () => {
  const sql = buildHanaEndSelect(seg('<element posit="0004" name="FIELD_NAME" infoObjectName="FIELD_NAME"/>'));
  assert.match(sql, /"\/BIC\/FIELD_NAME"/);
});

test('a standard InfoObject loses its leading zero', () => {
  const sql = buildHanaEndSelect(seg('<element posit="0005" name="0RECORDMODE" infoObjectName="0RECORDMODE"/>'));
  assert.match(sql, /^ {2}RECORDMODE,$/m);
});

test('columns follow posit order, with the technical columns appended', () => {
  const sql = buildHanaEndSelect(seg(
    '<element posit="0009" name="FIELD_B"/><element posit="0002" name="FIELD_A"/>'));
  const cols = sql.split('\n').slice(1, -1).map((l) => l.replace(/[ ,]/g, '')).filter(Boolean);
  assert.deepEqual(cols.slice(0, 2), ['FIELD_A', 'FIELD_B']);
  assert.deepEqual(cols.slice(-2), ['RECORD', 'SQL__PROCEDURE__SOURCE__RECORD']);
});
