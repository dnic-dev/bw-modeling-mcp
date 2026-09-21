import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bwListRemoteEntities } from '../dist/tools/datasource.js';
import { ensurePlatform, resetPlatformCache } from '../dist/platform.js';

/**
 * The remote entity value help is a different resource on each platform — different path,
 * different parameter names and a differently shaped answer. Both forms have to come out
 * of the tool as the same entity list.
 */

// BW/4HANA: one <row> per entity, name in its own element, the rest as attributes.
const BW4 = `<?xml version="1.0" encoding="utf-8"?>
<vh:valueHelp xmlns:vh="http://www.sap.com/bw/modeling" size="2" resultComplete="true">
  <row><technicalName>SCHEMA/VIEW_ONE</technicalName><attribute name="ENTITY_TYPE" value="V"/><attribute name="PATH_SUFFIX" value=""/></row>
  <row><technicalName>SCHEMA/TABLE_ONE</technicalName><attribute name="ENTITY_TYPE" value="T"/><attribute name="PATH_SUFFIX" value=""/></row>
</vh:valueHelp>`;

// Classic: positional. The catalog names the columns, each row carries bare <value>s.
const CLASSIC = `<?xml version="1.0" encoding="utf-8"?>
<valueHelp xmlns="http://www.sap.com/bw/modeling">
  <valueHelpMetaInformation valueHelpLines="2 " entityname="hanaentity"/>
  <valueHelpCatalog><column><columnname>ENTITY</columnname><title/></column><column><columnname>ENTITY_TYPE</columnname><title/></column><column><columnname>EXISTS</columnname><title/></column><column><columnname>DESCRIPTION</columnname><title/></column><column><columnname>PATH_SUFFIX</columnname><title/></column></valueHelpCatalog>
  <valueHelpValues>
    <row><value>VIEW_NAME</value><value>V</value><value/><value/><value/></row>
    <row><value>CLASS_NAME=&gt;METHOD_NAME=&gt;P00000#ttyp</value><value>T</value><value/><value/><value/></row>
  </valueHelpValues>
</valueHelp>`;

const clientReturning = (body) => ({ rawGet: async () => ({ body, headers: {} }) });

function fakeClient(mode) {
  const sysinfo = `<?xml version="1.0"?><systeminfo><sysInfo:property name="bw.b4hanamode" value="${mode}"/></systeminfo>`;
  const collection = (n) => `<app:collection href="/sap/bw/modeling/${n}"><app:accept>application/vnd.sap.bw.modeling.${n}-v1_0_0+xml</app:accept></app:collection>`;
  const discovery = `<?xml version="1.0"?><app:service>${collection('adso')}${mode === 'STRICT' ? collection('trfn') : ''}</app:service>`;
  return { get: async (p) => ({ body: p.includes('systeminfo') ? sysinfo : discovery, headers: {} }) };
}

test('BW/4HANA: the attribute form is read', async () => {
  resetPlatformCache();
  await ensurePlatform(fakeClient('STRICT'));
  const out = JSON.parse(await bwListRemoteEntities(clientReturning(BW4), 'LSYS_NAME', '*', 10));
  assert.equal(out.count, 2);
  assert.deepEqual(out.entities[0], { technical_name: 'SCHEMA/VIEW_ONE', entity_type: 'V', path_suffix: '' });
  assert.equal(out.result_size, 2);
});

test('classic: the positional form is read, columns decide which cell is which', async () => {
  resetPlatformCache();
  await ensurePlatform(fakeClient('STANDARD'));
  const out = JSON.parse(await bwListRemoteEntities(clientReturning(CLASSIC), 'LSYS_NAME', '*', 10));
  assert.equal(out.count, 2);
  assert.deepEqual(out.entities[0], { technical_name: 'VIEW_NAME', entity_type: 'V', path_suffix: null });
  // Entity names carry XML entities — a table function reads as CLASS=>METHOD=>…
  assert.equal(out.entities[1].technical_name, 'CLASS_NAME=>METHOD_NAME=>P00000#ttyp');
  assert.equal(out.entities[1].entity_type, 'T');
  assert.equal(out.result_size, 2);
});

test('classic: a column added in front does not shift the result', async () => {
  resetPlatformCache();
  await ensurePlatform(fakeClient('STANDARD'));
  const shifted = CLASSIC
    .replace('<column><columnname>ENTITY</columnname><title/></column>',
             '<column><columnname>SOMETHING_NEW</columnname><title/></column><column><columnname>ENTITY</columnname><title/></column>')
    .replace(/<row><value>VIEW_NAME<\/value>/, '<row><value>ignored</value><value>VIEW_NAME</value>');
  const out = JSON.parse(await bwListRemoteEntities(clientReturning(shifted), 'LSYS_NAME', '*', 10));
  assert.equal(out.entities[0].technical_name, 'VIEW_NAME');
});

test.after(() => resetPlatformCache());
