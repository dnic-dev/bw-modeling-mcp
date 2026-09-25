import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMemberSelection } from '../dist/tools/query.js';

// A structure member described as "Quantity" says nothing about the key figure behind it.
// The query model stores that key figure as a restriction on the 1KYFNM pseudo-characteristic,
// or as a reference to a reusable component. These pin the one-line summary the text output
// prints for each selection member.

test('the key figure of a member comes from its 1KYFNM restriction', () => {
  const line = formatMemberSelection([
    { infoObject: '1KYFNM', tokens: [{ tokenType: 'SelectionRange', selectionType: 'keyFigure', operator: 'Equal', exclude: false, value: 'KYF_NAME' }] },
  ]);
  assert.equal(line, 'KYF_NAME');
});

test('a reusable component is named with its type', () => {
  const line = formatMemberSelection([
    { infoObject: '1KYFNM', tokens: [{ tokenType: 'SelectionTokenForComponent', componentTechnicalName: 'CKF_NAME', componentType: 'CKF' }] },
  ]);
  assert.equal(line, 'CKF CKF_NAME');
});

test('characteristic restrictions follow the key figure', () => {
  const line = formatMemberSelection([
    { infoObject: '1KYFNM', tokens: [{ tokenType: 'SelectionRange', selectionType: 'keyFigure', operator: 'Equal', value: 'KYF_NAME' }] },
    { infoObject: 'CHAR_NAME', tokens: [
      { tokenType: 'SelectionRange', selectionType: 'value', operator: 'Equal', exclude: false, value: 'A' },
      { tokenType: 'SelectionRange', selectionType: 'value', operator: 'Equal', exclude: true, value: 'B' },
    ] },
  ]);
  assert.equal(line, 'KYF_NAME, CHAR_NAME=A, NOT CHAR_NAME=B');
});

test('a member without selections yields nothing', () => {
  assert.equal(formatMemberSelection([]), '');
});
