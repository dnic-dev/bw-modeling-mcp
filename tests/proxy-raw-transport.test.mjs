// The raw*() helpers build their own axios instance for exact wire-header control, which
// used to drop the Cloud Connector hop: the destination host exists only inside the proxy,
// so every one of them failed with ENOTFOUND on a BTP deployment (#24). push.ts went
// further and bypassed BwClient altogether (#25). Both are covered here with a stub proxy —
// no BW system needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BwClient } from '../dist/bw-client.js';
import { bwPushData, bwGetPushSchema } from '../dist/tools/push.js';

// RFC 6761 reserves .invalid, so this host never resolves. An answer at all therefore
// proves the request travelled through the proxy instead of going to DNS.
const UNRESOLVABLE = 'http://bw-host.invalid';

/** A stub Cloud Connector: records every hop and answers whatever the path needs. */
function startFakeProxy() {
  const hops = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hops.push({
        method: req.method,
        url: req.url,
        proxyAuth: req.headers['proxy-authorization'] ?? null,
        locationId: req.headers['sap-connectivity-scc-location_id'] ?? null,
        csrf: req.headers['x-csrf-token'] ?? null,
        body,
      });
      res.setHeader('x-csrf-token', 'token-via-proxy');
      if (req.url.endsWith('/dataSend')) {
        res.statusCode = 204;
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end('{"fields":[]}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, hops, port: server.address().port }));
  });
}

function clientVia(port) {
  return new BwClient({
    url: UNRESOLVABLE,
    auth: { kind: 'basic', user: 'user', password: 'secret' },
    proxy: { host: '127.0.0.1', port, token: 'connectivity-token', locationId: 'LOC' },
  });
}

/** Every hop must carry the connectivity credential and use absolute-form request URIs. */
function assertWentThroughProxy(hops) {
  assert.ok(hops.length > 0, 'nothing reached the proxy');
  for (const hop of hops) {
    assert.match(hop.url, /^http:\/\/bw-host\.invalid\//);
    assert.equal(hop.proxyAuth, 'Bearer connectivity-token');
    assert.equal(hop.locationId, 'LOC');
  }
}

test('rawPost travels through the Cloud Connector hop', async () => {
  const { server, hops, port } = await startFakeProxy();
  try {
    await clientVia(port).rawPost('/sap/bw/modeling/trfn/object_name', '<payload/>', {
      'Content-Type': 'application/xml',
    });
    assertWentThroughProxy(hops);
    assert.equal(hops.at(-1).method, 'POST');
  } finally {
    server.close();
  }
});

test('rawPut travels through the Cloud Connector hop', async () => {
  const { server, hops, port } = await startFakeProxy();
  try {
    await clientVia(port).rawPut('/sap/bw/modeling/trfn/object_name', '<payload/>', {
      'Content-Type': 'application/xml',
    });
    assertWentThroughProxy(hops);
    assert.equal(hops.at(-1).method, 'PUT');
  } finally {
    server.close();
  }
});

test('rawDelete travels through the Cloud Connector hop, token fetch included', async () => {
  const { server, hops, port } = await startFakeProxy();
  try {
    await clientVia(port).rawDelete('/sap/bw/modeling/trfn/object_name', {});
    // The CSRF fetch is a hop of its own and must be tunnelled just the same.
    assertWentThroughProxy(hops);
    assert.equal(hops.at(-1).method, 'DELETE');
    assert.equal(hops.at(-1).csrf, 'token-via-proxy');
  } finally {
    server.close();
  }
});

test('bw_get_push_schema goes through the client, so it reaches the proxy too', async () => {
  const { server, hops, port } = await startFakeProxy();
  try {
    const out = await bwGetPushSchema(clientVia(port), 'OBJECT_NAME');
    assertWentThroughProxy(hops);
    assert.match(out, /Push schema for aDSO OBJECT_NAME/);
    // The aDSO name is lower-cased for this endpoint.
    assert.match(hops.at(-1).url, /\/push\/dataStores\/object_name$/);
  } finally {
    server.close();
  }
});

test('bw_push_data fetches its own CSRF token and posts the records over the proxy', async () => {
  const { server, hops, port } = await startFakeProxy();
  try {
    const records = [{ FIELD_NAME: 'A' }, { FIELD_NAME: 'B' }];
    const out = JSON.parse(await bwPushData(clientVia(port), 'OBJECT_NAME', records));
    assertWentThroughProxy(hops);
    assert.equal(out.success, true);
    assert.equal(out.record_count, 2);

    const fetchHop = hops.find((h) => h.url.endsWith('/requests'));
    assert.ok(fetchHop, 'no CSRF fetch against /requests');
    assert.equal(fetchHop.csrf, 'Fetch');

    const sendHop = hops.at(-1);
    assert.equal(sendHop.method, 'POST');
    assert.match(sendHop.url, /\/dataSend$/);
    // The token from the push endpoint's own fetch, not the client's session-wide one.
    assert.equal(sendHop.csrf, 'token-via-proxy');
    assert.deepEqual(JSON.parse(sendHop.body), records);
  } finally {
    server.close();
  }
});

test('messaging mode reaches the messaging request URL', async () => {
  const { server, hops, port } = await startFakeProxy();
  try {
    await bwPushData(clientVia(port), 'OBJECT_NAME', [{ FIELD_NAME: 'A' }], 'messaging');
    assert.match(hops.at(-1).url, /\/dataSend\?request=MESSAGING$/);
  } finally {
    server.close();
  }
});
