import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bwGetInfoarea } from '../dist/tools/infoarea.js';

// A classic backend answers the InfoArea resource in XML; BW/4HANA answers in JSON.
// Both have to come out of the tool as the same four fields.
const XML = `<?xml version="1.0" encoding="utf-8"?><InfoArea:infoArea name="AREA_NAME" readOnly="false" parentInfoArea="PARENT_AREA" xmlns:InfoArea="http://www.sap.com/bw/modeling/BwInfoArea.ecore"><longDescription>Area &amp; label</longDescription><tlogoProperties adtcore:name="AREA_NAME" adtcore:type="AREA" xmlns:adtcore="http://www.sap.com/adt/core"><objectVersion>A</objectVersion><objectStatus>active</objectStatus></tlogoProperties></InfoArea:infoArea>`;

// bwGetInfoarea only ever calls get(), so a stand-in avoids needing a configured system.
const clientReturning = (body) => ({ get: async () => ({ body, headers: {} }) });

test('the XML form is read into the same fields as the JSON form', async () => {
  const out = JSON.parse(await bwGetInfoarea(clientReturning(XML), 'AREA_NAME'));
  assert.deepEqual(out, {
    name: 'AREA_NAME',
    label: 'Area & label',
    parent_area: 'PARENT_AREA',
    object_status: 'active',
  });
});

test('an area at root level reports no parent', async () => {
  const out = JSON.parse(await bwGetInfoarea(clientReturning(XML.replace('parentInfoArea="PARENT_AREA"', 'parentInfoArea=""')), 'AREA_NAME'));
  assert.equal(out.parent_area, null);
});

test('the tree placeholder is not reported as a parent', async () => {
  const out = JSON.parse(await bwGetInfoarea(clientReturning(XML.replace('PARENT_AREA', 'NODESNOTCONNECTED')), 'AREA_NAME'));
  assert.equal(out.parent_area, null);
});

test('the JSON form still wins where the backend sends JSON', async () => {
  const json = JSON.stringify({ name: 'AREA_NAME', label: 'from json', tlogoProperties: { infoArea: 'PARENT_AREA', objectStatus: 'active' } });
  const out = JSON.parse(await bwGetInfoarea(clientReturning(json), 'AREA_NAME'));
  assert.equal(out.label, 'from json');
  assert.equal(out.parent_area, 'PARENT_AREA');
});
