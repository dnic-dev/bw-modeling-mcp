import axios, { AxiosInstance, AxiosResponse } from 'axios';
import https from 'https';
import { randomUUID } from 'crypto';
import * as fs from 'fs';

const ECLIPSE_USER_AGENT =
  'Eclipse/4.38.0.v20251201-0920 (win32; x86_64; Java 21.0.9) ADT/3.56.0 (devedition)';

// Media types for each BW object type (from BW/4HANA discovery)
// These hardcoded values serve as fallback defaults; loadMediaTypes() overwrites them at runtime.
export const MEDIA_TYPES: Record<string, string> = {
  adso: 'application/vnd.sap.bw.modeling.adso-v1_7_0+xml',
  iobj: 'application/vnd.sap-bw-modeling.iobj-v2_2_0+xml',
  trfn: 'application/vnd.sap.bw.modeling.trfn-v1_0_0+xml',
  dtpa: 'application/vnd.sap.bw.modeling.dtpa-v1_0_0+xml',
  area: 'application/vnd.sap.bw.modeling.area-v1_1_0+xml',
  trcs: 'application/vnd.sap.bw.modeling.trcs-v1_0_0+xml',
  rsds: 'application/vnd.sap.bw.modeling.rsds-v1_1_0+xml',
  hcpr: 'application/vnd.sap.bw.modeling.hcpr-v1_15_0+xml',
  dest: 'application/vnd.sap.bw.modeling.dest-v1_0_0+xml',
  alvl: 'application/vnd.sap.bw.modeling.alvl-v1_0_0+xml',
  plcr: 'application/vnd.sap.bw.modeling.plcr-v1_0_0+xml',
  plsq: 'application/vnd.sap.bw.modeling.plsq-v1_0_0+xml',
  plse: 'application/vnd.sap.bw.modeling.plse-v2_0_0+xml',
  valuehelp: 'application/vnd.sap-bw-modeling.valuehelp2-v1_1_0+xml',
};

// DTPs do not need an unlock request after activation
const NO_UNLOCK_TYPES = new Set(['dtpa']);

function resolveMediaType(type: string): string {
  const mt = MEDIA_TYPES[type.toLowerCase()];
  if (!mt) {
    throw new Error(`Object type '${type}' is not supported on this system (not found in Discovery)`);
  }
  return mt;
}

/**
 * Apply SAP namespace encoding to a BW object name: a namespaced name `/NS/OBJ` is addressed
 * internally as `$NS$OBJ` (the two delimiting slashes become dollar signs; case is preserved).
 * Non-namespaced names (e.g. `ZOBJ01`) are returned unchanged. This is the raw (un-percent-encoded)
 * form used both in modeling URL path segments (via `bwSeg`) and in the object-name QUERY parameters
 * of the xref / dataflow services.
 */
export function bwNsName(name: string): string {
  return name.startsWith('/') ? name.replace(/^\/([^/]+)\//, '$$$1$$') : name;
}

/**
 * Encode a BW object name as a `/sap/bw/modeling/...` URL path segment: namespace-escaped (`bwNsName`),
 * lowercased, then percent-encoded (e.g. `/ABC/OBJ01` -> `%24abc%24obj01`). For a non-namespaced ASCII
 * name this is byte-identical to the previous `name.toLowerCase()` (encodeURIComponent is a no-op).
 */
export function bwSeg(name: string): string {
  return encodeURIComponent(bwNsName(name).toLowerCase());
}

export interface GetResult {
  body: string;
  headers: Record<string, string>;
}

export class BwClient {
  private http: AxiosInstance;
  private csrfToken: string | null = null;
  private csrfTokenFetchedAt: number = 0;
  // SAP sessions time out after ~5 minutes of inactivity; refresh the token before that.
  private static readonly CSRF_TOKEN_TTL_MS = 4 * 60 * 1000;
  private cookies: Map<string, string> = new Map();
  // Basic Auth is only sent during the initial CSRF fetch to establish the session.
  // All subsequent requests use the session cookie only — sending Basic Auth on PUT
  // causes SAP to create a new stateless session, invalidating the lock handle.
  private readonly basicAuth: string | null;
  private readonly frozenCookies: Set<string> = new Set();
  // Temporary session diagnostics — enable with BW_DEBUG_SESSION=1 (or "true").
  // All debug output goes to stderr so it never corrupts the MCP stdio protocol.
  private readonly sessionDebug: boolean =
    process.env.BW_DEBUG_SESSION === '1' || process.env.BW_DEBUG_SESSION === 'true';

  constructor(
    url: string,
    user: string | null,
    password: string | null,
    client: string,
    language?: string,
    initialCookies?: Record<string, string>
  ) {
    this.basicAuth = (user && password)
      ? 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64')
      : null;

    // In cookie mode (e.g. BW Bridge): do not send sap-client and X-sap-adt-sessiontype
    // as global defaults. BW Bridge rejects stateful requests with 401 when no
    // pre-established backend session exists on the app instance pointed to by __VCAP_ID__.
    const isCookieMode = initialCookies !== undefined;
    this.http = axios.create({
      baseURL: url,
      headers: {
        ...(isCookieMode ? {} : {
          'sap-client': client,
          'X-sap-adt-sessiontype': 'stateful',
        }),
        ...(language ? { 'sap-language': language } : {}),
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
    });
    delete this.http.defaults.headers.post['Content-Type'];
    delete (this.http.defaults.headers as any).common['Content-Type'];

    // Cookie mode: pre-populate cookie store from caller. Used for SAML/OAuth-fronted
    // systems where Basic Auth is not available and cookies are exported from a browser.
    if (initialCookies) {
      for (const [name, value] of Object.entries(initialCookies)) {
        this.cookies.set(name, value);
        // Names from the cookie file are frozen — set-cookie responses must not overwrite them.
        this.frozenCookies.add(name);
      }
    }
  }

  // ── Session info (debug) ──────────────────────────────────────────────────

  /** Returns a snapshot of the current session cookies — for debug assertions only. */
  public sessionInfo(): Record<string, string> {
    return Object.fromEntries(this.cookies.entries());
  }

  // ── Cookie management ──────────────────────────────────────────────────────

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private updateCookies(response: AxiosResponse): void {
    const setCookies = response.headers['set-cookie'];
    if (!setCookies) return;
    if (this.sessionDebug) {
      console.error(`[bw-session] Set-Cookie received: ${JSON.stringify(setCookies)}`);
    }
    for (const c of setCookies) {
      const attrs = c.split(';');
      const part = attrs[0];
      const eqIdx = part.indexOf('=');
      if (eqIdx <= 0) continue;
      const name = part.substring(0, eqIdx).trim();
      if (this.frozenCookies.has(name)) continue;
      const value = part.substring(eqIdx + 1).trim();
      // Honour explicit cookie deletions (Max-Age<=0 or Expires in the past): drop the
      // cookie from the jar instead of re-sending a stale value. Re-sending a session
      // cookie (e.g. sap-contextid) that the server has already rolled out is a likely
      // cause of intermittent "No Suitable Resource Found" errors on stateful calls.
      if (this.isCookieDeletion(attrs)) {
        this.cookies.delete(name);
        continue;
      }
      this.cookies.set(name, value);
    }
    if (this.sessionDebug) {
      console.error(`[bw-session] cookie jar now: ${JSON.stringify(Object.fromEntries(this.cookies.entries()))}`);
    }
  }

  // A Set-Cookie is a deletion when Max-Age is <= 0 or Expires is in the past.
  private isCookieDeletion(attrs: string[]): boolean {
    for (const a of attrs.slice(1)) {
      const eq = a.indexOf('=');
      const key = (eq >= 0 ? a.slice(0, eq) : a).trim().toLowerCase();
      const val = eq >= 0 ? a.slice(eq + 1).trim() : '';
      if (key === 'max-age') {
        const n = parseInt(val, 10);
        if (Number.isFinite(n) && n <= 0) return true;
      } else if (key === 'expires') {
        const t = Date.parse(val);
        if (Number.isFinite(t) && t <= Date.now()) return true;
      }
    }
    return false;
  }

  // ── CSRF token ─────────────────────────────────────────────────────────────

  private async fetchCsrfToken(): Promise<void> {
    const response = await this.http.get('/sap/bw/modeling/repo/is/systeminfo', {
      headers: {
        'X-CSRF-Token': 'Fetch',
        Accept: 'application/xml',
        ...(this.basicAuth ? { Authorization: this.basicAuth } : {}),
        ...this.cookieHeaders(),
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    const token = response.headers['x-csrf-token'] as string | undefined;
    if (!token || token.toLowerCase() === 'fetch') {
      if (this.basicAuth) {
        throw new Error(
          `Failed to fetch CSRF token (HTTP ${response.status}). Check BW_URL, BW_USER, BW_PASSWORD, BW_CLIENT.`
        );
      } else {
        throw new Error(
          `Failed to fetch CSRF token (HTTP ${response.status}). ` +
          `Cookie mode in use — refresh cookies in BW_COOKIE_FILE and restart the MCP server.`
        );
      }
    }
    this.csrfToken = token;
    this.csrfTokenFetchedAt = Date.now();
  }

  private async ensureCsrf(): Promise<void> {
    const stale = !this.csrfToken ||
      (Date.now() - this.csrfTokenFetchedAt) > BwClient.CSRF_TOKEN_TTL_MS;
    if (stale) {
      await this.fetchCsrfToken();
    }
  }

  public clearCsrfToken(): void {
    this.csrfToken = null;
  }

  private cookieHeaders(): Record<string, string> {
    const hdr = this.cookieHeader();
    return hdr ? { Cookie: hdr } : {};
  }

  // ── Public HTTP helpers ────────────────────────────────────────────────────

  async get(path: string, accept: string): Promise<GetResult> {
    await this.ensureCsrf();
    const IOBJ_ACCEPT_ALL = 'application/vnd.sap-bw-modeling.iobj-v1_0_0+xml, application/vnd.sap-bw-modeling.iobj-v1_1_0+xml, application/vnd.sap-bw-modeling.iobj-v1_2_0+xml, application/vnd.sap-bw-modeling.iobj-v1_3_0+xml, application/vnd.sap-bw-modeling.iobj-v1_4_0+xml, application/vnd.sap-bw-modeling.iobj-v1_5_0+xml, application/vnd.sap-bw-modeling.iobj-v1_6_0+xml, application/vnd.sap-bw-modeling.iobj-v1_7_0+xml, application/vnd.sap-bw-modeling.iobj-v1_8_0+xml, application/vnd.sap-bw-modeling.iobj-v1_9_0+xml, application/vnd.sap-bw-modeling.iobj-v2_0_0+xml, application/vnd.sap-bw-modeling.iobj-v2_1_0+xml, application/vnd.sap-bw-modeling.iobj-v2_2_0+xml, application/vnd.sap-bw-modeling.iobj-v2_3_0+xml, application/vnd.sap-bw-modeling.iobj-v2_4_0+xml';
    const resolvedAccept = accept.includes('iobj') ? IOBJ_ACCEPT_ALL : `application/xml, ${accept}`;
    const response = await this.http.get(path, {
      headers: {
        Accept: resolvedAccept,
        'bwmt-level': '50',
        'X-CSRF-Token': this.csrfToken!,
        ...this.cookieHeaders(),
      },
      responseType: 'text',
      transformResponse: [(data) => data],
    });
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`GET ${path} → HTTP ${response.status}\n${response.data}`);
    }
    return {
      body: response.data as string,
      headers: response.headers as Record<string, string>,
    };
  }

  /**
   * Lock a BW object.
   * Returns the lockHandle string from the response body.
   * Pattern: POST /sap/bw/modeling/{type}/{name}?action=lock
   *
   * extraHeaders: optional additional headers, e.g. for creation mode:
   *   { 'activity_context': 'CREA', 'parent_name': 'MYAREA', 'parent_type': 'AREA' }
   */
  async lock(type: string, name: string, extraHeaders?: Record<string, string>, sessionType?: string, cleanHeaders?: boolean): Promise<string> {
    await this.ensureCsrf();
    const accept = type.toLowerCase() === 'area'
      ? 'application/vnd.sap.bw.modeling.area-v1_0_0+xml, application/vnd.sap.bw.modeling.area-v1_1_0+xml'
      : resolveMediaType(type);
    const headers: Record<string, any> = cleanHeaders
      ? {
          Accept: accept,
          'User-Agent': ECLIPSE_USER_AGENT,
          'X-sap-adt-profiling': 'server-time',
          'sap-adt-request-id': randomUUID(),
          'X-CSRF-Token': this.csrfToken!,
          ...this.cookieHeaders(),
          ...extraHeaders,
          'Content-Type': undefined,
          'bwmt-level': undefined,
          'X-sap-adt-sessiontype': undefined,
          'sap-client': undefined,
          'sap-language': undefined,
        }
      : {
          Accept: accept,
          'bwmt-level': '50',
          'X-CSRF-Token': this.csrfToken!,
          ...this.cookieHeaders(),
          ...(sessionType ? { 'X-sap-adt-sessiontype': sessionType } : {}),
          ...extraHeaders,
        };
    const response = await this.http.post(
      `/sap/bw/modeling/${type.toLowerCase()}/${bwSeg(name)}?action=lock`,
      '',
      {
        headers,
        responseType: 'text',
      }
    );
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`Lock ${type}/${name} → HTTP ${response.status}\n${response.data}`);
    }
    const body = response.data as string;
    // lockHandle is in <LOCK_HANDLE>...</LOCK_HANDLE> in the response body
    const match = body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/);
    if (!match) {
      throw new Error(`No <LOCK_HANDLE> in lock response body:\n${body}`);
    }
    return match[1];
  }

  /**
   * Create a new BW object (POST, no /m in the URL).
   * Pattern: POST /sap/bw/modeling/{type}/{name}?lockHandle={handle}
   * Used for object creation from template; the lock must have been obtained
   * with activity_context=CREA headers.
   *
   * extraHeaders: e.g. { 'Development-Class': '$TMP' }
   */
  async create(
    type: string,
    name: string,
    lockHandle: string,
    body: string,
    extraHeaders?: Record<string, string>
  ): Promise<string> {
    await this.ensureCsrf();
    const mediaType = resolveMediaType(type);
    const path = `/sap/bw/modeling/${type.toLowerCase()}/${bwSeg(name)}?lockHandle=${lockHandle}`;
    const response = await this.http.post(path, body, {
      headers: {
        'Content-Type': `application/xml, ${mediaType}`,
        Accept: mediaType,
        'X-CSRF-Token': this.csrfToken!,
        ...this.cookieHeaders(),
        ...extraHeaders,
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(`POST ${path} → HTTP ${response.status}\n${response.data}`);
    }
    return response.data as string;
  }

  /**
   * PUT (create/update) a BW object in its inactive version.
   * Pattern: PUT /sap/bw/modeling/{type}/{name}/m?lockHandle={handle}
   * Always sends the complete object XML.
   */
  async put(
    type: string,
    name: string,
    lockHandle: string,
    body: string,
    timestamp?: string,
    corrNr?: string,
    transportLockHolder?: string
  ): Promise<string> {
    await this.ensureCsrf();
    const mediaType = resolveMediaType(type);
    const corrNrPrefix = corrNr ? `corrNr=${corrNr}&` : '';
    const path = `/sap/bw/modeling/${type.toLowerCase()}/${bwSeg(name)}/m?${corrNrPrefix}lockHandle=${lockHandle}`;
    const response = await this.http.put(path, body, {
      headers: {
        'Content-Type': `application/xml, ${mediaType}`,
        Accept: mediaType,
        'X-CSRF-Token': this.csrfToken!,
        ...this.cookieHeaders(),
        ...(timestamp ? { timestamp } : {}),
        ...(transportLockHolder ? { 'Transport-Lock-Holder': transportLockHolder } : {}),
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(`PUT ${path} → HTTP ${response.status}\n${response.data}`);
    }
    return response.data as string;
  }

  /**
   * Lock a BW object for deletion.
   * Differs from normal lock: URL includes /m before ?action=lock.
   * Pattern: POST /sap/bw/modeling/{type}/{name}/m?action=lock
   */
  async lockForDelete(type: string, name: string, mediaType: string): Promise<string> {
    await this.ensureCsrf();
    const response = await this.http.post(
      `/sap/bw/modeling/${type.toLowerCase()}/${bwSeg(name)}/m?action=lock`,
      '',
      {
        headers: {
          Accept: mediaType,
          'bwmt-level': '50',
          'X-CSRF-Token': this.csrfToken!,
          ...this.cookieHeaders(),
        },
        responseType: 'text',
      }
    );
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`Delete-lock ${type}/${name} → HTTP ${response.status}\n${response.data}`);
    }
    const body = response.data as string;
    const match = body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/);
    if (!match) {
      throw new Error(`No <LOCK_HANDLE> in delete-lock response:\n${body}`);
    }
    return match[1];
  }

  /**
   * Delete a BW object.
   * Pattern: DELETE /sap/bw/modeling/{type}/{name}/m?lockHandle={handle}
   * Lock URL uses /m: POST /sap/bw/modeling/{type}/{name}/m?action=lock
   */
  async delete(
    type: string,
    name: string,
    lockHandle: string,
    mediaType: string
  ): Promise<string> {
    await this.ensureCsrf();
    const path = `/sap/bw/modeling/${type.toLowerCase()}/${bwSeg(name)}/m?lockHandle=${lockHandle}`;
    const response = await this.http.delete(path, {
      headers: {
        'Content-Type': mediaType,
        Accept: mediaType,
        'X-CSRF-Token': this.csrfToken!,
        ...this.cookieHeaders(),
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(`DELETE ${path} → HTTP ${response.status}\n${response.data}`);
    }
    return response.data as string;
  }

  /**
   * Activate one BW object.
   * Pattern: POST /sap/bw/modeling/activation
   * lockHandle is empty string for DTP activation.
   */
  async activate(type: string, name: string, lockHandle: string, corrNr?: string, sourceSystem?: string): Promise<string> {
    await this.ensureCsrf();
    const mediaType = resolveMediaType(type);
    const typeLower = type.toLowerCase();
    // RSDS (DataSource) has a compound key (DataSource + source system) and uses an
    // uppercase two-segment URI. All other types use the single-segment lowercase URI.
    const href = typeLower === 'rsds'
      ? `/sap/bw/modeling/rsds/${encodeURIComponent(bwNsName(name).toUpperCase())}/${(sourceSystem ?? '').toUpperCase()}/m`
      : `/sap/bw/modeling/${typeLower}/${bwSeg(name)}/m`;
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xmlns:bwModel="http://www.sap.com/bw/modeling">
  <atom:entry>
    <atom:content type="${mediaType}">
      <bwModel:checkProperties version="inactive" modelContent="" lockHandle="${lockHandle}"/>
    </atom:content>
    <atom:link href="${href}" type="application/*" rel="self"/>
  </atom:entry>
</atom:feed>`;
    const corrNrParam = corrNr ? `?corrNr=${corrNr}` : '';
    const response = await this.http.post(`/sap/bw/modeling/activation${corrNrParam}`, body, {
      headers: {
        'Content-Type': 'application/atom+xml;type=entry',
        Accept: 'application/atom+xml;type=feed',
        'X-CSRF-Token': this.csrfToken!,
        ...this.cookieHeaders(),
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(
        `Activation of ${type}/${name} → HTTP ${response.status}\n${response.data}`
      );
    }
    return response.data as string;
  }

  /**
   * Generic POST to an arbitrary BW modeling path.
   * Used for endpoints that don't follow the lock/create/unlock pattern
   * (e.g. move_requests).
   */
  /**
   * Like postRaw, but skips ensureCsrf() and uses the already-held CSRF token.
   * Throws if no token is available (caller must have triggered a CSRF fetch beforehand,
   * e.g. via lock()).
   */
  async postWithCsrf(path: string, body: string, contentType: string, extraHeaders?: Record<string, string | undefined>, stripInstanceHeaders?: boolean): Promise<string> {
    if (!this.csrfToken) {
      throw new Error('postWithCsrf: no CSRF token available. A prior lock() or get() must have established one.');
    }
    const response = await this.http.post(path, Buffer.from(body, 'utf-8'), {
      headers: {
        'Content-Type': contentType,
        Accept: contentType,
        'X-CSRF-Token': this.csrfToken,
        ...this.cookieHeaders(),
        ...extraHeaders,
        ...(stripInstanceHeaders ? {
          'User-Agent': ECLIPSE_USER_AGENT,
          'X-sap-adt-profiling': 'server-time',
          'sap-adt-request-id': randomUUID(),
          'bwmt-level': undefined,
          'X-sap-adt-sessiontype': undefined,
          'sap-client': undefined,
          'sap-language': undefined,
        } : {}),
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(`POST ${path} → HTTP ${response.status}\n${response.data}`);
    }
    return response.data as string;
  }

  async postRaw(path: string, body: string, contentType: string, extraHeaders?: Record<string, string>): Promise<string> {
    await this.ensureCsrf();
    const response = await this.http.post(path, body, {
      headers: {
        'Content-Type': contentType,
        'X-CSRF-Token': this.csrfToken!,
        ...this.cookieHeaders(),
        ...extraHeaders,
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(`POST ${path} → HTTP ${response.status}\n${response.data}`);
    }
    return response.data as string;
  }

  /**
   * Unlock a BW object after activation.
   * DTPs (dtpa) are skipped — they require no unlock.
   * Pattern: POST /sap/bw/modeling/{type}/{name}?action=unlock
   */
  /**
   * Returns the current CSRF token, fetching it first if needed.
   * Callers that need to pass the token explicitly (e.g. rawPost) use this.
   */
  async getCsrfToken(): Promise<string> {
    await this.ensureCsrf();
    return this.csrfToken!;
  }

  /**
   * POST with a completely clean axios instance — no default headers at all.
   * Only sends Authorization (Basic Auth) + Cookie (session continuity) + the
   * headers explicitly passed by the caller.  Nothing else.
   *
   * Use this when you need to control the exact wire headers (e.g. for
   * Transformation creation where Eclipse sends a very specific header set).
   */
  async rawPost(
    url: string,
    body: string,
    headers: Record<string, string>
  ): Promise<{ body: string; headers: Record<string, string> }> {
    const freshHttp = axios.create({
      baseURL: this.http.defaults.baseURL,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
      // Wipe every axios default-header bucket so nothing leaks through
      headers: { common: {}, get: {}, post: {}, put: {}, patch: {}, delete: {}, head: {} } as any,
    });

    const cookieHdr = this.cookieHeader();
    const response = await freshHttp.post(url, body, {
      headers: {
        ...(this.basicAuth ? { Authorization: this.basicAuth } : {}),
        ...(cookieHdr ? { Cookie: cookieHdr } : {}),
        ...headers,
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`POST ${url} → HTTP ${response.status}\n${response.data}`);
    }
    return {
      body: response.data as string,
      headers: response.headers as Record<string, string>,
    };
  }

  /**
   * GET to an arbitrary path using the shared session.
   * Passes the CSRF token and session cookies; the caller controls all other headers.
   * Use this for endpoints that need custom Accept or non-standard request headers.
   */
  async rawGet(
    url: string,
    headers: Record<string, string>
  ): Promise<{ body: string; headers: Record<string, string> }> {
    await this.ensureCsrf();
    const response = await this.http.get(url, {
      headers: {
        'X-CSRF-Token': this.csrfToken!,
        ...this.cookieHeaders(),
        ...headers,
      },
      responseType: 'text',
      transformResponse: [(data) => data],
    });
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`GET ${url} → HTTP ${response.status}\n${response.data}`);
    }
    return {
      body: response.data as string,
      headers: response.headers as Record<string, string>,
    };
  }

  /**
   * PUT to an arbitrary path with a clean axios instance.
   * Caller must supply the CSRF token (obtained via getCsrfToken() after any rawGet call).
   */
  async rawPut(
    url: string,
    body: string,
    headers: Record<string, string>
  ): Promise<{ body: string; headers: Record<string, string> }> {
    const freshHttp = axios.create({
      baseURL: this.http.defaults.baseURL,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
      headers: { common: {}, get: {}, post: {}, put: {}, patch: {}, delete: {}, head: {} } as any,
    });

    const cookieHdr = this.cookieHeader();
    const response = await freshHttp.put(url, body, {
      headers: {
        ...(this.basicAuth ? { Authorization: this.basicAuth } : {}),
        ...(cookieHdr ? { Cookie: cookieHdr } : {}),
        ...headers,
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`PUT ${url} → HTTP ${response.status}\n${response.data}`);
    }
    return {
      body: response.data as string,
      headers: response.headers as Record<string, string>,
    };
  }

  /**
   * DELETE to an arbitrary path with a clean axios instance.
   * Fetches CSRF token automatically.
   */
  async rawDelete(
    url: string,
    headers: Record<string, string>
  ): Promise<{ body: string; headers: Record<string, string> }> {
    const csrfToken = await this.getCsrfToken();
    const freshHttp = axios.create({
      baseURL: this.http.defaults.baseURL,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
      headers: { common: {}, get: {}, post: {}, put: {}, patch: {}, delete: {}, head: {} } as any,
    });
    const cookieHdr = this.cookieHeader();
    const response = await freshHttp.delete(url, {
      headers: {
        ...(this.basicAuth ? { Authorization: this.basicAuth } : {}),
        ...(cookieHdr ? { Cookie: cookieHdr } : {}),
        'x-csrf-token': csrfToken,
        ...headers,
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(`DELETE ${url} → HTTP ${response.status}\n${response.data}`);
    }
    return {
      body: response.data as string,
      headers: response.headers as Record<string, string>,
    };
  }

  /**
   * Fetch the BW modeling discovery document and populate MEDIA_TYPES at runtime.
   * Entries returned by the server overwrite the hardcoded fallback defaults.
   * Entries not returned by the server are left unchanged.
   */
  async loadMediaTypes(): Promise<void> {
    const response = await this.http.get('/sap/bw/modeling/discovery', {
      headers: {
        Accept: 'application/atomsvc+xml',
        ...(this.basicAuth ? { Authorization: this.basicAuth } : {}),
        ...this.cookieHeaders(),
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`Discovery GET → HTTP ${response.status}\n${response.data}`);
    }
    const xml: string = response.data as string;
    // A single <app:collection> publishes one OR MORE <app:accept> media types,
    // mixing +xml/+json and bw/bw4 namespaces. Split on collection start tags so
    // every accept is attributed to its own collection: the previous single-regex
    // approach captured only the first accept per collection, which silently
    // skipped the +xml variant whenever a +json entry was listed first (e.g. iobj).
    const extractVersion = (mt: string): number => {
      const m = mt.match(/-v(\d+)_(\d+)_(\d+)\+xml$/);
      return m ? parseInt(m[1]) * 10000 + parseInt(m[2]) * 100 + parseInt(m[3]) : 0;
    };
    const segments = xml.split(/(?=<app:collection\s)/);
    for (const segment of segments) {
      const hrefMatch = segment.match(/^<app:collection\b[^>]*?\shref="([^"]+)"/);
      if (!hrefMatch) continue;
      // Extract last URL segment as the key (e.g. ".../adso" → "adso")
      const key = hrefMatch[1].split('/').pop()?.toLowerCase();
      if (!key) continue;
      // Consider only versioned XML modeling media types ("...-vX_Y_Z+xml").
      // Sub-resource accepts (e.g. "jobs.job+xml") and +json variants score 0.
      const versioned = [...segment.matchAll(/<app:accept>([^<]+)<\/app:accept>/g)]
        .map((a) => a[1].trim())
        .filter((mt) => extractVersion(mt) > 0);
      if (versioned.length === 0) continue;
      const best = versioned.reduce((a, b) => (extractVersion(b) >= extractVersion(a) ? b : a));
      const existing = MEDIA_TYPES[key];
      // Only update if the discovered version is >= the existing one (never downgrade).
      if (!existing || extractVersion(best) >= extractVersion(existing)) {
        MEDIA_TYPES[key] = best;
      }
    }
    process.stderr.write(`[bw-modeling-mcp] Loaded media types from discovery: ${JSON.stringify(MEDIA_TYPES)}\n`);
  }

  // ── ADT class write flow (ABAP runtime only) ──────────────────────────────

  /** GET the ABAP class source (working area). Returns null if class does not exist yet (404). */
  async adtGetSource(classEncoded: string): Promise<string | null> {
    const token = await this.getCsrfToken();
    const response = await this.http.get(
      `/sap/bc/adt/oo/classes/${classEncoded}/source/main?version=workingArea`,
      {
        headers: {
          Accept: 'text/plain',
          'X-CSRF-Token': token,
          ...this.cookieHeaders(),
        },
        responseType: 'text',
        transformResponse: [(data) => data],
      }
    );
    this.updateCookies(response);
    if (response.status === 404) {
      return null;
    }
    if (response.status >= 400) {
      throw new Error(`ADT GET source ${classEncoded} → HTTP ${response.status}\n${response.data}`);
    }
    return response.data as string;
  }

  /** Lock the ABAP class for editing. Returns the ADT lock handle. */
  async adtLockClass(classEncoded: string): Promise<string> {
    const token = await this.getCsrfToken();
    const response = await this.http.post(
      `/sap/bc/adt/oo/classes/${classEncoded}?_action=LOCK&accessMode=MODIFY`,
      '',
      {
        headers: {
          Accept:
            'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result;q=0.8,' +
            'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result2;q=0.9',
          'X-CSRF-Token': token,
          ...this.cookieHeaders(),
        },
        responseType: 'text',
      }
    );
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`ADT LOCK ${classEncoded} → HTTP ${response.status}\n${response.data}`);
    }
    const body = response.data as string;
    const match = body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/);
    if (!match) {
      throw new Error(`No <LOCK_HANDLE> in ADT lock response:\n${body}`);
    }
    return match[1];
  }

  /** PUT updated ABAP class source. */
  async adtPutSource(classEncoded: string, lockHandle: string, source: string): Promise<void> {
    const token = await this.getCsrfToken();
    const response = await this.http.put(
      `/sap/bc/adt/oo/classes/${classEncoded}/source/main?lockHandle=${lockHandle}`,
      source,
      {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          Accept: 'text/plain',
          'X-CSRF-Token': token,
          ...this.cookieHeaders(),
        },
        responseType: 'text',
      }
    );
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(`ADT PUT source ${classEncoded} → HTTP ${response.status}\n${response.data}`);
    }
  }

  /** Activate the ABAP class via ADT. */
  async adtActivate(classEncoded: string, classNameUpper: string): Promise<void> {
    await this.ensureCsrf();
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">` +
      `<adtcore:objectReference` +
      ` adtcore:uri="/sap/bc/adt/oo/classes/${classEncoded}"` +
      ` adtcore:name="${classNameUpper}"/>` +
      `</adtcore:objectReferences>`;
    const response = await this.http.post(
      '/sap/bc/adt/activation?method=activate&preauditRequested=true',
      body,
      {
        headers: {
          'Content-Type': 'application/xml',
          Accept: 'application/xml',
          'X-CSRF-Token': this.csrfToken!,
          ...this.cookieHeaders(),
        },
        responseType: 'text',
      }
    );
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(`ADT activate ${classEncoded} → HTTP ${response.status}\n${response.data}`);
    }
  }

  /** Unlock the ABAP class after editing. */
  async adtUnlockClass(classEncoded: string, lockHandle: string): Promise<void> {
    await this.ensureCsrf();
    const response = await this.http.post(
      `/sap/bc/adt/oo/classes/${classEncoded}?_action=UNLOCK&lockHandle=${lockHandle}`,
      '',
      {
        headers: {
          'X-CSRF-Token': this.csrfToken!,
          ...this.cookieHeaders(),
        },
        responseType: 'text',
      }
    );
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(`ADT UNLOCK ${classEncoded} → HTTP ${response.status}\n${response.data}`);
    }
  }

  async unlock(type: string, name: string): Promise<void> {
    if (NO_UNLOCK_TYPES.has(type.toLowerCase())) return;
    await this.ensureCsrf();
    const mediaType = resolveMediaType(type);
    const response = await this.http.post(
      `/sap/bw/modeling/${type.toLowerCase()}/${bwSeg(name)}?action=unlock`,
      '',
      {
        headers: {
          'Content-Type': mediaType,
          'X-CSRF-Token': this.csrfToken!,
          ...this.cookieHeaders(),
        },
        responseType: 'text',
      }
    );
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(`UNLOCK ${type.toUpperCase()} ${name} → HTTP ${response.status}\n${response.data}`);
    }
  }
}

export function createClientFromEnv(): BwClient {
  const url = process.env.BW_URL;
  const client = process.env.BW_CLIENT ?? '001';
  const language = process.env.BW_LANGUAGE;
  const cookieFile = process.env.BW_COOKIE_FILE;

  if (!url) {
    throw new Error('Required environment variable missing: BW_URL');
  }

  // Cookie mode: BW Bridge or other SAML/OAuth-fronted BW systems where Basic Auth
  // is not available. Cookies are exported from an authenticated browser session.
  // File format (vsp-compatible): Netscape (7 tab-separated fields) or simple
  // "name=value" lines. Lines starting with # are comments.
  if (cookieFile) {
    let raw: string;
    try {
      raw = fs.readFileSync(cookieFile, 'utf-8');
    } catch (err) {
      throw new Error(
        `Failed to read BW_COOKIE_FILE at ${cookieFile}: ${(err as Error).message}`
      );
    }
    const cookies: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split('\t');
      if (parts.length >= 7) {
        cookies[parts[5]] = parts[6];
      } else {
        const eq = trimmed.indexOf('=');
        if (eq > 0) {
          cookies[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
        }
      }
    }
    if (Object.keys(cookies).length === 0) {
      throw new Error(
        `BW_COOKIE_FILE at ${cookieFile} contains no parseable cookies (expected Netscape or name=value format).`
      );
    }
    const userOpt = process.env.BW_USER ?? null;
    const passwordOpt = process.env.BW_PASSWORD ?? null;
    return new BwClient(url, userOpt, passwordOpt, client, language, cookies);
  }

  // Basic Auth mode: classic on-premise BW/4HANA — unchanged from previous behavior.
  const user = process.env.BW_USER;
  const password = process.env.BW_PASSWORD;
  if (!user || !password) {
    throw new Error(
      'Required environment variables missing: BW_URL, BW_USER, BW_PASSWORD'
    );
  }
  return new BwClient(url, user, password, client, language);
}

/**
 * One-shot read through a BRAND-NEW session with forceCacheUpdate=true.
 *
 * The BW ADT backend keeps a per-session model buffer: a session that has
 * previously locked/written an object reliably serves STALE reads afterwards
 * (even with forceCacheUpdate=true), and pre-lock reads may project outdated
 * state. Building a read-modify-write on such a read silently resurrects old
 * attribute values on the PUT. A fresh session always returns the database
 * state, including an existing unactivated M draft. Use this for every
 * pre-lock model read and for verification reads; post-lock reads in the
 * locking session are refreshed by the lock itself and may stay as they are.
 */
export async function freshRead(path: string, accept: string): Promise<GetResult> {
  const sep = path.includes('?') ? '&' : '?';
  return createClientFromEnv().get(`${path}${sep}forceCacheUpdate=true`, accept);
}
