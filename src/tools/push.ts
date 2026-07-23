import axios from 'axios';
import https from 'https';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function getEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Environment variable ${key} is not set`);
  return val;
}

function buildAuth(): string {
  const user = getEnv('BW_USER');
  const pass = getEnv('BW_PASSWORD');
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function pushBase(adsoName: string): string {
  const baseUrl = getEnv('BW_URL').replace(/\/$/, '');
  return `${baseUrl}/sap/bw4/v1/push/dataStores/${encodeURIComponent(adsoName.toLowerCase())}`;
}

/**
 * bw_push_data — push records into an aDSO write-interface inbound table.
 *
 * Flow (One Step):
 *   1. GET /requests with x-csrf-token: Fetch → extract token + session cookies
 *   2. POST /dataSend with JSON array body → expect HTTP 204
 */
export async function bwPushData(
  adsoName: string,
  records: object[],
  mode: string = 'one_step'
): Promise<string> {
  const base = pushBase(adsoName);
  const auth = buildAuth();

  // Step 1: fetch CSRF token and session cookies
  const csrfRes = await axios.get(`${base}/requests`, {
    httpsAgent,
    headers: {
      'Authorization': auth,
      'x-csrf-token': 'Fetch',
    },
    validateStatus: () => true,
  });

  const csrfToken = csrfRes.headers['x-csrf-token'];
  if (!csrfToken || csrfToken.toLowerCase() === 'required') {
    throw new Error(`Failed to fetch CSRF token. HTTP ${csrfRes.status}: ${csrfRes.data}`);
  }

  // Extract session cookies from set-cookie header
  const rawCookies: string[] = Array.isArray(csrfRes.headers['set-cookie'])
    ? csrfRes.headers['set-cookie']
    : csrfRes.headers['set-cookie'] ? [csrfRes.headers['set-cookie']] : [];

  const cookieParts = rawCookies
    .map((c) => c.split(';')[0].trim())
    .filter(Boolean);
  const cookieHeader = cookieParts.join('; ');

  // Step 2: POST dataSend
  const sendUrl = mode === 'messaging'
    ? `${base}/dataSend?request=MESSAGING`
    : `${base}/dataSend`;

  const sendRes = await axios.post(sendUrl, records, {
    httpsAgent,
    headers: {
      'Authorization': auth,
      'Content-Type': 'application/json',
      'x-csrf-token': csrfToken,
      ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
    },
    validateStatus: () => true,
  });

  if (sendRes.status === 204) {
    return JSON.stringify({
      success: true,
      message: `${records.length} record(s) pushed to aDSO ${adsoName.toUpperCase()} (mode: ${mode}).`,
      adso_name: adsoName.toUpperCase(),
      record_count: records.length,
      mode,
    });
  }

  // Error — include response body for diagnosis
  const errorBody = typeof sendRes.data === 'string'
    ? sendRes.data
    : JSON.stringify(sendRes.data);

  throw new Error(
    `Push to ${adsoName.toUpperCase()} failed (HTTP ${sendRes.status}): ${errorBody}`
  );
}

/**
 * bw_get_push_schema — fetch the JSON schema for an aDSO's write interface.
 *
 * Returns the field list, types, and required fields so the caller knows
 * what to include in bw_push_data records.
 */
export async function bwGetPushSchema(adsoName: string): Promise<string> {
  const base = pushBase(adsoName);
  const auth = buildAuth();

  const res = await axios.get(base, {
    httpsAgent,
    headers: {
      'Authorization': auth,
      'Accept': 'application/json',
    },
    validateStatus: () => true,
  });

  if (res.status !== 200) {
    throw new Error(
      `Failed to fetch push schema for ${adsoName.toUpperCase()} (HTTP ${res.status}): ${JSON.stringify(res.data)}`
    );
  }

  return `Push schema for aDSO ${adsoName.toUpperCase()}:\n\n${JSON.stringify(res.data, null, 2)}`;
}
