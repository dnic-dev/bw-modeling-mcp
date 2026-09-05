import type { BwClient } from '../bw-client.js';

/**
 * The push interface is an ordinary BW REST endpoint and must travel the same
 * transport as every other call. Building a private axios instance here bypassed
 * the BTP destination, the Cloud Connector proxy and principal propagation, so
 * both tools were dead on any centrally hosted deployment.
 */
function pushBase(adsoName: string): string {
  return `/sap/bw4/v1/push/dataStores/${encodeURIComponent(adsoName.toLowerCase())}`;
}

/**
 * bw_push_data — push records into an aDSO write-interface inbound table.
 *
 * Flow (One Step):
 *   1. GET /requests with x-csrf-token: Fetch → token; the client keeps the session cookies
 *   2. POST /dataSend with JSON array body
 */
export async function bwPushData(
  client: BwClient,
  adsoName: string,
  records: object[],
  mode: string = 'one_step'
): Promise<string> {
  const base = pushBase(adsoName);

  // This endpoint issues its own CSRF token, so the token is taken from the fetch
  // response rather than from the client's session-wide one.
  const { headers: csrfHeaders } = await client.rawGet(`${base}/requests`, {
    'x-csrf-token': 'Fetch',
  });

  const csrfToken = csrfHeaders['x-csrf-token'];
  if (!csrfToken || csrfToken.toLowerCase() === 'required') {
    throw new Error(
      `Failed to fetch a CSRF token for the push interface of ${adsoName.toUpperCase()}.`
    );
  }

  const sendUrl = mode === 'messaging' ? `${base}/dataSend?request=MESSAGING` : `${base}/dataSend`;

  // Success is HTTP 204; rawPost throws on anything from 400 up, so reaching the
  // next line means the records were accepted.
  try {
    await client.rawPost(sendUrl, JSON.stringify(records), {
      'Content-Type': 'application/json',
      'x-csrf-token': csrfToken,
    });
  } catch (err) {
    throw new Error(
      `Push to ${adsoName.toUpperCase()} failed: ${(err as Error).message}`
    );
  }

  return JSON.stringify({
    success: true,
    message: `${records.length} record(s) pushed to aDSO ${adsoName.toUpperCase()} (mode: ${mode}).`,
    adso_name: adsoName.toUpperCase(),
    record_count: records.length,
    mode,
  });
}

/**
 * bw_get_push_schema — fetch the JSON schema for an aDSO's write interface.
 *
 * Returns the field list, types, and required fields so the caller knows
 * what to include in bw_push_data records.
 */
export async function bwGetPushSchema(client: BwClient, adsoName: string): Promise<string> {
  let body: string;
  try {
    ({ body } = await client.rawGet(pushBase(adsoName), { Accept: 'application/json' }));
  } catch (err) {
    throw new Error(
      `Failed to fetch push schema for ${adsoName.toUpperCase()}: ${(err as Error).message}`
    );
  }

  let rendered = body;
  try {
    rendered = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // Not JSON — hand back whatever the server sent so the caller can see it.
  }

  return `Push schema for aDSO ${adsoName.toUpperCase()}:\n\n${rendered}`;
}
