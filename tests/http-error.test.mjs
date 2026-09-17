import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bwHttpError } from '../dist/bw-client.js';

// The page the ICF answers with when a service does not exist, shortened but structurally
// identical to what a classic BW system returns for every /sap/bw4/ path.
const LOGON_ERROR_PAGE = `<!DOCTYPE html PUBLIC"-//W3C//DTD HTML 4.01Transitional//EN">
<html><head><title>Logon Error Message</title>
<style>body { font-family: Arial; }</style></head>
<body><h1>Service nicht erreichbar</h1>
<p>Was hat das zu bedeuten? Der aufgerufene URL-Pfad existiert nicht.</p>
<p>HTTP 404 - Not found</p></body></html>`;

test('an ICF HTML page never reaches the caller', () => {
  const err = bwHttpError('GET /sap/bc/http/sap/bw4/v1/manage/requests?tlogo=adso', 404, LOGON_ERROR_PAGE);
  assert.ok(!/<html|<!DOCTYPE|<body|<style/i.test(err.message), 'markup must be gone');
  assert.ok(err.message.length < 400, `message should be one sentence, got ${err.message.length} chars`);
});

test('a missing BW/4HANA API is named as such, with the route that works', () => {
  const err = bwHttpError('GET /sap/bc/http/sap/bw4/v1/manage/requests?tlogo=adso', 404, LOGON_ERROR_PAGE);
  assert.match(err.message, /HTTP 404/);
  // First line stays the request as it was sent; the explanation below names the bare path.
  const [request, explanation] = err.message.split('\n');
  assert.match(request, /\?tlogo=adso/);
  assert.match(explanation, /\/sap\/bc\/http\/sap\/bw4\/v1\/manage\/requests does not exist/);
  assert.match(err.message, /classic BW 7\.5/);
  assert.match(err.message, /bw_read_metadata_tables/);
  // "Logon Error" is how the ICF titles every such page; quoting it here would read as an
  // authentication problem, which this is not.
  assert.ok(!/Logon Error/i.test(err.message));
});

test('an HTML page on any other status is reported as unreachable, not as data', () => {
  const err = bwHttpError('POST /sap/bw/modeling/adso/x', 500, LOGON_ERROR_PAGE);
  assert.match(err.message, /HTTP 500/);
  assert.match(err.message, /HTML page/);
  assert.match(err.message, /titled "Logon Error Message"/);
});

test('an ADT exception document is passed through unchanged', () => {
  // Callers parse this XML, and several decisions in this server are made on its text.
  const xml =
    '<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml">' +
    '<type id="ExceptionResourceNotFound"/><message lang="EN">Resource does not exist</message></exc:exception>';
  const err = bwHttpError('GET /sap/bw/modeling/trfn/x/m', 404, xml);
  assert.equal(err.message, `GET /sap/bw/modeling/trfn/x/m → HTTP 404\n${xml}`);
});

test('a JSON error body survives too', () => {
  const err = bwHttpError('GET /sap/opu/odata/sap/SRV/Set', 403, { error: { code: '/IWFND/MED/170' } });
  assert.match(err.message, /IWFND\/MED\/170/);
});
