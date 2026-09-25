import axios, { AxiosInstance, AxiosResponse } from 'axios';
import https from 'https';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { currentClient } from './request-context.js';
// Value import, but no cycle at runtime: platform.ts takes BwClient as a type only.
import { cachedPlatform } from './platform.js';

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

/**
 * Discovery collection keys that name the same resource as a different `MEDIA_TYPES` key.
 *
 * The key comes from the last segment of the collection href, and that segment is not
 * stable across releases: a classic system publishes InfoObjects as `infoobject` while
 * BW/4HANA publishes them as `iobj`. Without the alias the discovered media type is filed
 * under a key nothing asks for, the hardcoded default stays in place, and every write is
 * rejected with HTTP 415 "requested content type does not match the backend content type".
 */
const COLLECTION_KEY_ALIASES: Record<string, string> = {
  infoobject: 'iobj',
};

// DTPs do not need an unlock request after activation
const NO_UNLOCK_TYPES = new Set(['dtpa']);

/**
 * The ADT session type a lock request runs under.
 *
 * A classic backend validates a lock handle against the ADT session that took it, and it
 * only keeps that session alive when the lock request asks for one. Without it the lock
 * itself succeeds and returns a handle, but the very next request — the create POST — is
 * refused: `ExceptionResourceInvalidLockHandle`, "lock handle for object … could not be
 * created", which reads like an enqueue problem and is not one. `stateful_enqueue` fails
 * the same way there, so on classic every lock runs as plain `stateful`.
 *
 * BW/4HANA takes the handle without any of this and is left exactly as it was: what the
 * caller asked for is what it gets.
 */
export function lockSessionType(requested?: string): string | undefined {
  if (cachedPlatform()?.platform !== 'classic') return requested;
  return 'stateful';
}

/** `lockSessionType` as a header object, for the lock endpoints that build headers by hand. */
export function lockSessionHeader(requested?: string): Record<string, string> {
  const type = lockSessionType(requested);
  return type ? { 'X-sap-adt-sessiontype': type } : {};
}

/**
 * Object types whose writes a classic backend drops when they arrive in the session that
 * holds the lock.
 *
 * The InfoObject resource answers such a POST or PUT with `200` and "object changed
 * successfully" and applies nothing: a key figure payload produced a characteristic, and a
 * PUT that changed only the description did not arrive. The identical request sent from a
 * second session, quoting the same lock handle, applies in full. Eclipse BWMT does exactly
 * that on 7.5 — it uses its stateful enqueue session for the lock and the unlock and
 * nothing else, and every read, write and activation goes out on a stateless one, which
 * JCo hands it for free and HTTP has to be asked for.
 *
 * Why a list rather than "every type on classic": the other resources do not behave this
 * way, and for some the separate session is actively wrong. An InfoSource PUT applies from
 * the lock session, and once it is sent from elsewhere the activation — which has to stay
 * in the lock session, because any other is refused by the InfoProvider lock — checks the
 * state from before the write and reports an empty field list. So the type goes in here
 * when it has been observed to need it, not by release.
 */
const CLASSIC_OWN_SESSION_WRITE = new Set(['iobj']);

/** Must a write to this object type run in a session of its own? */
export function writeNeedsOwnSession(type: string): boolean {
  return cachedPlatform()?.platform === 'classic' && CLASSIC_OWN_SESSION_WRITE.has(type.toLowerCase());
}

function resolveMediaType(type: string): string {
  const mt = MEDIA_TYPES[type.toLowerCase()];
  if (!mt) {
    throw new Error(`Object type '${type}' is not supported on this system (not found in Discovery)`);
  }
  return mt;
}

/** `application/vnd.sap.bw.modeling.adso-v1_2_0+xml` → `{ prefix, major, minor }`. */
function splitMediaType(mediaType: string): { prefix: string; major: number; minor: number } | null {
  const m = mediaType.trim().match(/^(.*-v)(\d+)_(\d+)_\d+\+xml$/);
  return m ? { prefix: m[1], major: parseInt(m[2]), minor: parseInt(m[3]) } : null;
}

/**
 * Every resource version up to and including `mediaType`, lowest first.
 *
 * An `Accept` header may name several versions and the backend picks the one it serves;
 * a `Content-Type` may not, so writes keep using the single resolved media type. The two
 * hand-written lists this replaces — the all-versions list for InfoObjects on the read
 * path and the two-version list for InfoAreas on the lock path — existed because one
 * hardcoded version is wrong on a release that serves an older one. Deriving the range
 * keeps the reads working even when discovery could not be reached and the fallback
 * default is ahead of the backend.
 */
export function acceptRange(mediaType: string): string {
  const parts = splitMediaType(mediaType);
  if (!parts) return mediaType;
  const versions: string[] = [];
  for (let major = 1; major <= parts.major; major++) {
    const lastMinor = major === parts.major ? parts.minor : 9;
    for (let minor = 0; minor <= lastMinor; minor++) {
      versions.push(`${parts.prefix}${major}_${minor}_0+xml`);
    }
  }
  return versions.join(', ');
}

/** Expand every versioned media type in an `Accept` header into its version range. */
export function expandAccept(accept: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of accept.split(',').map((e) => e.trim()).filter(Boolean)) {
    for (const mt of acceptRange(entry).split(', ')) {
      if (seen.has(mt)) continue;
      seen.add(mt);
      out.push(mt);
    }
  }
  return out.join(', ');
}

/**
 * Escape a BW object name the way the backend does before it puts a name into a URI:
 * every `/` becomes `$` and every `:` becomes `!` (see `CL_RSEM_MODEL_OBJECT=>ESCAPE_OBJECT_NAME`).
 * Names without those characters are returned unchanged.
 *
 * This matters for namespaced names such as `/NS/OBJECT_NAME`: left as-is they produce a
 * double slash in the URL path and the resource is never reached.
 */
export function bwEscapeName(name: string): string {
  return name.replace(/\//g, '$').replace(/:/g, '!');
}

/**
 * Encode an object name as a lowercase `/sap/bw/modeling/{type}/{name}` path segment.
 * For a plain ASCII name this is byte-identical to `name.toLowerCase()`.
 */
export function bwSeg(name: string): string {
  return encodeURIComponent(bwEscapeName(name).toLowerCase());
}

/** Same as `bwSeg`, for the endpoints that address the object in upper case. */
export function bwSegUpper(name: string): string {
  return encodeURIComponent(bwEscapeName(name).toUpperCase());
}

export interface GetResult {
  body: string;
  headers: Record<string, string>;
}

/**
 * Turn a failed response into an error message a model can act on.
 *
 * The body is passed through unchanged — every ADT error is an XML document that callers
 * further up parse, and several decisions in this server are made on its text. The one
 * exception is an HTML page: the ICF answers a request for a service that does not exist
 * with a full "Logon Error Message" page, and on a classic BW system every `/sap/bw4/…`
 * path does exactly that. Thousands of bytes of markup then reached the chat and told the
 * model nothing, so an HTML body is replaced by the sentence it actually means.
 *
 * Both are kept: `HTTP <status>` stays in the message, because that is what the callers
 * that branch on the status match on.
 */
export function bwHttpError(label: string, status: number, data: unknown): Error {
  const body = typeof data === 'string' ? data : data === undefined ? '' : JSON.stringify(data);
  const isHtml = /^\s*(?:<!DOCTYPE\s+html|<html\b)/i.test(body) || /<title>\s*Logon Error/i.test(body);
  if (!isHtml) return new Error(`${label} → HTTP ${status}\n${body}`);

  const path = label.match(/\/sap\/\S+/)?.[0]?.split('?')[0];
  const isBw4Path = path ? /\/sap\/(?:bc\/http\/sap\/)?bw4\//.test(path) : false;
  if (status === 404 && isBw4Path) {
    return new Error(
      `${label} → HTTP ${status}\nThe BW/4HANA API ${path} does not exist on this system ` +
        '(classic BW 7.5 or lower). Use bw_read_metadata_tables for transformations, DTPs, ' +
        'process chains and the load history.',
    );
  }
  if (status === 404) {
    return new Error(
      `${label} → HTTP ${status}\nThe service ${path ?? 'behind this path'} is not active or ` +
        'does not exist on this system.',
    );
  }
  // Anything else: the page title is the only part of it worth keeping. The ICF titles its
  // page "Logon Error Message" whatever went wrong, so it is quoted as the server's wording
  // rather than presented as the cause.
  const title = body.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
  return new Error(
    `${label} → HTTP ${status}\nThe server returned an HTML page instead of an API response — ` +
      'the service is not reachable for this user (ICF service inactive, or the logon was ' +
      `rejected).${title ? ` The page is titled "${title}".` : ''}`,
  );
}

/** Cloud Connector hop. The token expires, so it is resolved per request. */
export interface BwProxyConfig {
  host: string;
  port: number;
  /** Connectivity-service token, sent as `Proxy-Authorization: Bearer …`. */
  token: string;
  /** `SAP-Connectivity-SCC-Location_ID`, when several Cloud Connectors serve the subaccount. */
  locationId?: string;
}

/**
 * How a client authenticates to BW.
 *
 * `pp` is BTP principal propagation: the Destination service returns a value that the
 * Cloud Connector converts into a short-lived X.509 certificate for the calling user.
 * It is deliberately a separate variant rather than an extra optional field, so a
 * per-user client cannot also carry a shared credential.
 */
export type BwAuth =
  | { kind: 'basic'; user: string; password: string }
  | { kind: 'cookies'; cookies: Record<string, string> }
  | { kind: 'pp'; connectivityAuth: string };

export interface BwClientOptions {
  url: string;
  auth: BwAuth;
  client?: string;
  language?: string;
  proxy?: BwProxyConfig;
  /**
   * Stable identity of the caller, used to scope the lock registry below. Set it wherever
   * the credential itself is not stable per user — principal propagation hands out a fresh
   * connectivity token per request, so without this every request would look like a
   * different identity and no lock could ever be matched to its session.
   */
  identity?: string;
}

/**
 * Sessions that hold a BW enqueue, keyed by identity and object.
 *
 * A BW lock belongs to the ABAP session that took it: `?action=unlock` from any other
 * session answers HTTP 200 and releases nothing. Every MCP call builds its own client,
 * so the session that locked in `bw_update_*` is already gone when `bw_activate` tries to
 * unlock. The lock then survives until the ADT session times out, and the next write
 * fails with "object is locked by <user>" until someone clears it in SM12.
 *
 * Remembering which client took the lock closes that gap: `unlock()` routes through that
 * session, and `lock()` hands back the handle we already hold instead of failing. Entries
 * are dropped once the lock is released.
 */
const lockSessions = new Map<string, { client: BwClient; handle: string }>();

function lockKey(identity: string, type: string, name: string): string {
  return `${identity}|${type.toLowerCase()}/${name.toLowerCase()}`;
}

/**
 * Types whose lock this client does not release: DTPs go through the DTP framework's own
 * unlock endpoint, so `unlock()` returns early for them. Registering them would leave an
 * entry that nothing ever deletes, and a later 403 would then hand back a dead handle.
 *
 * The registry also cannot help when the registered session has died server-side: the
 * unlock then opens a new session and BW answers 200 without releasing anything, exactly
 * as before this registry existed. In practice a dying session releases its own enqueues,
 * which is why the case that used to block agents is the live-but-unreachable session.
 */
function tracksLock(type: string): boolean {
  return !NO_UNLOCK_TYPES.has(type.toLowerCase());
}

export class BwClient {
  private http: AxiosInstance;
  private csrfToken: string | null = null;
  private csrfTokenFetchedAt: number = 0;
  /** In-flight token fetch, shared by every caller that asks while it runs. */
  private csrfFetch: Promise<void> | null = null;
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

  private readonly opts: BwClientOptions;

  constructor(opts: BwClientOptions) {
    this.opts = opts;
    this.basicAuth = opts.auth.kind === 'basic'
      ? 'Basic ' + Buffer.from(`${opts.auth.user}:${opts.auth.password}`).toString('base64')
      : null;

    // In cookie mode (e.g. BW Bridge): do not send sap-client and X-sap-adt-sessiontype
    // as global defaults. BW Bridge rejects stateful requests with 401 when no
    // pre-established backend session exists on the app instance pointed to by __VCAP_ID__.
    const isCookieMode = opts.auth.kind === 'cookies';
    this.http = axios.create({
      baseURL: opts.url,
      // Cloud Connector: standard absolute-URI proxying. Note the destination URL must
      // be http:// — an https:// target makes axios tunnel with CONNECT, which drops the
      // Proxy-Authorization and SAP-Connectivity-Authentication headers, and the
      // connectivity proxy answers 405.
      // `undefined`, never `false`: false would also disable the HTTP_PROXY/http_proxy
      // environment variables, and some hosts are reachable only through that proxy —
      // it resolves the host and performs the destination lookup itself.
      proxy: opts.proxy
        ? { host: opts.proxy.host, port: opts.proxy.port, protocol: 'http' }
        : undefined,
      headers: {
        ...(isCookieMode ? {} : {
          ...(opts.client ? { 'sap-client': opts.client } : {}),
          'X-sap-adt-sessiontype': 'stateful',
        }),
        ...(opts.language ? { 'sap-language': opts.language } : {}),
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
    });
    delete this.http.defaults.headers.post['Content-Type'];
    delete (this.http.defaults.headers as any).common['Content-Type'];

    // Proxy credentials belong on every request, unlike the identity header — the
    // connectivity proxy authorizes each hop individually. An interceptor keeps that
    // out of the ~20 individual request methods.
    if (opts.proxy) {
      const proxy = opts.proxy;
      this.http.interceptors.request.use((config) => {
        config.headers.set('Proxy-Authorization', `Bearer ${proxy.token}`);
        if (proxy.locationId) config.headers.set('SAP-Connectivity-SCC-Location_ID', proxy.locationId);
        return config;
      });
    }

    // Cookie mode: pre-populate cookie store from caller. Used for SAML/OAuth-fronted
    // systems where Basic Auth is not available and cookies are exported from a browser.
    if (opts.auth.kind === 'cookies') {
      for (const [name, value] of Object.entries(opts.auth.cookies)) {
        this.cookies.set(name, value);
        // Names from the cookie file are frozen — set-cookie responses must not overwrite them.
        this.frozenCookies.add(name);
      }
    }
  }

  /**
   * A second client against the same system with the same identity, but its own
   * session — empty cookie jar, no CSRF token.
   *
   * This is what the existing "fresh session" call sites need: BW keeps a per-session
   * model buffer, so a session that has written an object serves stale reads afterwards.
   * Cloning rather than rebuilding from the environment is what lets those call sites
   * work unchanged under principal propagation, where there is no ambient credential
   * to rebuild from.
   */
  freshSession(): BwClient {
    return new BwClient(this.opts);
  }

  /**
   * Who this client acts as. Two clients sharing it reach BW as the same user, which is
   * what makes it safe to hand one client's lock to the other — and what keeps a
   * multi-user deployment from ever touching someone else's session.
   */
  private identityKey(): string {
    if (this.opts.identity) return `${this.opts.identity}@${this.opts.url}/${this.opts.client ?? ''}`;
    const auth = this.opts.auth;
    const who =
      auth.kind === 'basic' ? `basic:${auth.user}`
      : auth.kind === 'cookies' ? 'cookies'
      : `pp:${auth.connectivityAuth}`;
    return `${who}@${this.opts.url}/${this.opts.client ?? ''}`;
  }

  /** Same caller, so this client may act on the other one's lock. */
  private sameIdentityAs(other: BwClient): boolean {
    return other.identityKey() === this.identityKey();
  }

  /**
   * The identity credential, applied exactly where this client already sent Basic Auth
   * — i.e. only on the session-establishing CSRF fetch.
   *
   * That placement is deliberate and load-bearing: re-sending a credential on a PUT
   * makes SAP open a new stateless session and invalidates the lock handle (see the
   * note on `basicAuth`). Principal propagation follows the same rule, so
   * `SAP-Connectivity-Authentication` establishes the session and the session cookie
   * carries it from there.
   *
   * `Authorization` is never sent under principal propagation — SAP reserves it for
   * basic auth to the backend, and sending it breaks identity propagation.
   */
  private authHeaders(): Record<string, string> {
    if (this.basicAuth) return { Authorization: this.basicAuth };
    if (this.opts.auth.kind === 'pp') {
      return { 'SAP-Connectivity-Authentication': this.opts.auth.connectivityAuth };
    }
    return {};
  }

  /**
   * Same proxy transport config passed to the main `this.http` in the constructor —
   * needed by every "fresh axios instance" helper (rawPost/rawPut/rawDelete) too,
   * otherwise those bypass the Cloud Connector tunnel and axios tries to resolve the
   * virtual destination host itself (e.g. "ad4"), failing with ENOTFOUND.
   */
  private proxyConfig() {
    return this.opts.proxy
      ? { host: this.opts.proxy.host, port: this.opts.proxy.port, protocol: 'http' as const }
      : undefined;
  }

  /**
   * The Proxy-Authorization (+ optional SCC location) header the constructor's
   * interceptor adds to `this.http`. The raw*() helpers build their own axios
   * instance without that interceptor, so they merge this in explicitly.
   */
  private proxyHeaders(): Record<string, string> {
    if (!this.opts.proxy) return {};
    const headers: Record<string, string> = { 'Proxy-Authorization': `Bearer ${this.opts.proxy.token}` };
    if (this.opts.proxy.locationId) headers['SAP-Connectivity-SCC-Location_ID'] = this.opts.proxy.locationId;
    return headers;
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

  // Connection-level failures that mean "the socket died", not "the server said no".
  // A keep-alive socket that the server has already torn down surfaces as one of these on
  // the next request; the request never reached the backend, so retrying it is safe.
  private static isTransportError(err: any): boolean {
    const code = err?.code ?? err?.cause?.code;
    return (
      code === 'ECONNRESET' ||
      code === 'ECONNABORTED' ||
      code === 'EPIPE' ||
      code === 'ETIMEDOUT' ||
      /socket hang up/i.test(String(err?.message ?? ''))
    );
  }

  private async fetchCsrfToken(): Promise<void> {
    // Retry once on a dead socket. The CSRF fetch is a plain GET with no side effects, and
    // it is the first request after every write — so a connection the server closed while
    // the previous write was being committed would otherwise abort the whole flow (seen on
    // a sequence of process-chain writes: several succeed, then the next token fetch dies
    // with ECONNRESET). A real HTTP error is not retried.
    let response;
    try {
      response = await this.csrfRequest();
    } catch (err: any) {
      if (!BwClient.isTransportError(err)) throw err;
      response = await this.csrfRequest();
    }
    this.updateCookies(response);
    const token = response.headers['x-csrf-token'] as string | undefined;
    if (!token || token.toLowerCase() === 'fetch') {
      throw new Error(
        `Failed to fetch CSRF token (HTTP ${response.status}). ${this.csrfFailureHint()}`
      );
    }
    this.csrfToken = token;
    this.csrfTokenFetchedAt = Date.now();
  }

  // Each auth mode fails for its own reasons, and naming the wrong one sends the reader
  // after a credential that is not involved: under principal propagation an expired trust
  // chain on the ABAP side surfaces as a plain 401, which looks exactly like a stale cookie.
  private csrfFailureHint(): string {
    switch (this.opts.auth.kind) {
      case 'basic':
        return 'Check BW_URL, BW_USER, BW_PASSWORD, BW_CLIENT.';
      case 'cookies':
        return 'Cookie mode in use — refresh cookies in BW_COOKIE_FILE and restart the MCP server.';
      case 'pp':
        return 'Principal propagation in use — no cookie or password is involved. ' +
          'A 401 here is the trust chain: check that the destination still resolves, that ' +
          'login/certificate_mapping_rulebased is 1 on the backend, and that the Cloud Connector ' +
          'is listed in icm/trusted_reverse_proxy_<n>. Both parameters are lost on a backend restart ' +
          'unless they are in the instance profile.';
    }
  }

  private csrfRequest() {
    return this.http.get('/sap/bw/modeling/repo/is/systeminfo', {
      headers: {
        'X-CSRF-Token': 'Fetch',
        Accept: 'application/xml',
        ...this.authHeaders(),
        ...this.cookieHeaders(),
      },
      responseType: 'text',
    });
  }

  /**
   * One token fetch at a time, however many callers ask at once.
   *
   * Two requests issued in parallel on the same client both found no token and both went
   * and fetched one. The second fetch starts a new session, which invalidates the token
   * the first request is about to send — so the next write came back `HTTP 403 CSRF token
   * validation failed`, at a point that had nothing to do with the parallel reads. It
   * looked transient because it depended on which of the two answered first. Platform
   * detection does exactly this, two reads at once before the first tool call, which is
   * why the failure liked to appear on the first write of a session.
   */
  private async ensureCsrf(): Promise<void> {
    const stale = !this.csrfToken ||
      (Date.now() - this.csrfTokenFetchedAt) > BwClient.CSRF_TOKEN_TTL_MS;
    if (!stale) return;
    if (!this.csrfFetch) {
      this.csrfFetch = this.fetchCsrfToken().finally(() => {
        this.csrfFetch = null;
      });
    }
    await this.csrfFetch;
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
    const resolvedAccept = `application/xml, ${expandAccept(accept)}`;
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
      if (response.status === 500) this.discardSessionContext();
      throw bwHttpError(`GET ${path}`, response.status, response.data);
    }
    return {
      body: response.data as string,
      headers: response.headers as Record<string, string>,
    };
  }

  /**
   * Forget the server-side session context after a request that ended in a short dump.
   *
   * The dump ends the stateful context on the server, but the server does not say so: the
   * next request carrying the same `sap-contextid` hangs and fails as well (verified on a
   * classic 7.5 system), or is answered "400 Session Timed Out" (BW/4HANA) — so one rejected
   * search filter made the following, valid search fail too. Without the cookie the next
   * request opens a fresh context under the same logon. Nothing held in the old context
   * survives the dump anyway, a lock included, so dropping the cookie loses nothing.
   */
  private discardSessionContext(): void {
    if (this.frozenCookies.has('sap-contextid')) return;
    this.cookies.delete('sap-contextid');
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
    const accept = expandAccept(resolveMediaType(type));
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
          ...lockSessionHeader(sessionType),
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
    const key = lockKey(this.identityKey(), type, name);
    if (response.status >= 400) {
      // 403 also means "you already hold this lock, in another session" — BW refuses even
      // the same user from a new session. Reuse the handle we still know instead of making
      // the caller wait for the ADT session to time out.
      const held = tracksLock(type) ? lockSessions.get(key) : undefined;
      if (response.status === 403 && held) return held.handle;
      throw bwHttpError(`Lock ${type}/${name}`, response.status, response.data);
    }
    const body = response.data as string;
    // lockHandle is in <LOCK_HANDLE>...</LOCK_HANDLE> in the response body
    const match = body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/);
    if (!match) {
      throw new Error(`No <LOCK_HANDLE> in lock response body:\n${body}`);
    }
    if (tracksLock(type)) lockSessions.set(key, { client: this, handle: match[1] });
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
  /**
   * `extraQuery` carries create options that live in the URL rather than in the body — a
   * CompositeProvider copies its structure from a template that way, for instance.
   */
  async create(
    type: string,
    name: string,
    lockHandle: string,
    body: string,
    extraHeaders?: Record<string, string>,
    extraQuery?: Record<string, string>
  ): Promise<string> {
    // The lock handle is quoted in the URL and is session-independent, so the write can be
    // sent from anywhere — and on a classic release it has to be. See writeNeedsOwnSession.
    const session = writeNeedsOwnSession(type) ? createClientFromEnv() : this;
    await session.ensureCsrf();
    const mediaType = resolveMediaType(type);
    const query = Object.entries(extraQuery ?? {})
      .map(([k, v]) => `&${k}=${encodeURIComponent(v)}`)
      .join('');
    const path =
      `/sap/bw/modeling/${type.toLowerCase()}/${bwSeg(name)}?lockHandle=${lockHandle}${query}`;
    const response = await session.http.post(path, body, {
      headers: {
        'Content-Type': `application/xml, ${mediaType}`,
        Accept: mediaType,
        'X-CSRF-Token': session.csrfToken!,
        ...session.cookieHeaders(),
        ...extraHeaders,
      },
      responseType: 'text',
    });
    session.updateCookies(response);
    session.csrfToken = null;
    this.csrfToken = null;
    if (response.status >= 400) {
      throw bwHttpError(`POST ${path}`, response.status, response.data);
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
    // Own session on a classic release, for the same reason as in create().
    const session = writeNeedsOwnSession(type) ? createClientFromEnv() : this;
    await session.ensureCsrf();
    const mediaType = resolveMediaType(type);
    const corrNrPrefix = corrNr ? `corrNr=${corrNr}&` : '';
    const path = `/sap/bw/modeling/${type.toLowerCase()}/${bwSeg(name)}/m?${corrNrPrefix}lockHandle=${lockHandle}`;
    const response = await session.http.put(path, body, {
      headers: {
        'Content-Type': `application/xml, ${mediaType}`,
        Accept: mediaType,
        'X-CSRF-Token': session.csrfToken!,
        ...session.cookieHeaders(),
        ...(timestamp ? { timestamp } : {}),
        ...(transportLockHolder ? { 'Transport-Lock-Holder': transportLockHolder } : {}),
      },
      responseType: 'text',
    });
    session.updateCookies(response);
    session.csrfToken = null;
    this.csrfToken = null;
    if (response.status >= 400) {
      throw bwHttpError(`PUT ${path}`, response.status, response.data);
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
          Accept: expandAccept(mediaType),
          'bwmt-level': '50',
          'X-CSRF-Token': this.csrfToken!,
          ...this.cookieHeaders(),
        },
        responseType: 'text',
      }
    );
    this.updateCookies(response);
    const key = lockKey(this.identityKey(), type, name);
    if (response.status >= 400) {
      const held = tracksLock(type) ? lockSessions.get(key) : undefined;
      if (response.status === 403 && held) return held.handle;
      throw bwHttpError(`Delete-lock ${type}/${name}`, response.status, response.data);
    }
    const body = response.data as string;
    const match = body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/);
    if (!match) {
      throw new Error(`No <LOCK_HANDLE> in delete-lock response:\n${body}`);
    }
    if (tracksLock(type)) lockSessions.set(key, { client: this, handle: match[1] });
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
      throw bwHttpError(`DELETE ${path}`, response.status, response.data);
    }
    return response.data as string;
  }

  /**
   * Activate one BW object.
   * Pattern: POST /sap/bw/modeling/activation
   * lockHandle is empty string for DTP activation.
   */
  async activate(type: string, name: string, lockHandle: string, corrNr?: string, sourceSystem?: string): Promise<string> {
    const session = this;
    await session.ensureCsrf();
    const mediaType = resolveMediaType(type);
    const typeLower = type.toLowerCase();
    // RSDS (DataSource) has a compound key (DataSource + source system) and uses an
    // uppercase two-segment URI. All other types use the single-segment lowercase URI.
    const href = typeLower === 'rsds'
      ? `/sap/bw/modeling/rsds/${bwSegUpper(name)}/${(sourceSystem ?? '').toUpperCase()}/m`
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
    // Activation stays in the session that holds the lock — a second session is refused by
    // the InfoProvider lock, whatever handle it quotes. But on classic the write it is
    // about to check arrived from elsewhere, so this session's model buffer is one step
    // behind and the activation would check the state from before it: "the field list of
    // InfoSource … is empty" on an InfoSource whose fields a fresh read shows. Re-reading
    // the object here refreshes that buffer first. Best effort — a failed read must not
    // take the activation with it, and the object may legitimately have no /m version.
    if (writeNeedsOwnSession(type)) {
      try {
        await this.get(`${href}?forceCacheUpdate=true`, mediaType);
      } catch {
        /* the activation reports what it finds */
      }
    }

    const corrNrParam = corrNr ? `?corrNr=${corrNr}` : '';
    const response = await session.http.post(`/sap/bw/modeling/activation${corrNrParam}`, body, {
      headers: {
        'Content-Type': 'application/atom+xml;type=entry',
        Accept: 'application/atom+xml;type=feed',
        'X-CSRF-Token': session.csrfToken!,
        ...session.cookieHeaders(),
      },
      responseType: 'text',
    });
    session.updateCookies(response);
    session.csrfToken = null;
    this.csrfToken = null;
    if (response.status >= 400) {
      throw bwHttpError(`Activation of ${type}/${name}`, response.status, response.data);
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
      throw bwHttpError(`POST ${path}`, response.status, response.data);
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
      throw bwHttpError(`POST ${path}`, response.status, response.data);
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
      proxy: this.proxyConfig(),
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
      // Wipe every axios default-header bucket so nothing leaks through
      headers: { common: {}, get: {}, post: {}, put: {}, patch: {}, delete: {}, head: {} } as any,
    });

    const cookieHdr = this.cookieHeader();
    const response = await freshHttp.post(url, body, {
      headers: {
        ...this.authHeaders(),
        ...this.proxyHeaders(),
        ...(cookieHdr ? { Cookie: cookieHdr } : {}),
        ...headers,
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    if (response.status >= 400) {
      throw bwHttpError(`POST ${url}`, response.status, response.data);
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
      throw bwHttpError(`GET ${url}`, response.status, response.data);
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
      proxy: this.proxyConfig(),
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
      headers: { common: {}, get: {}, post: {}, put: {}, patch: {}, delete: {}, head: {} } as any,
    });

    const cookieHdr = this.cookieHeader();
    const response = await freshHttp.put(url, body, {
      headers: {
        ...this.authHeaders(),
        ...this.proxyHeaders(),
        ...(cookieHdr ? { Cookie: cookieHdr } : {}),
        ...headers,
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    if (response.status >= 400) {
      throw bwHttpError(`PUT ${url}`, response.status, response.data);
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
      proxy: this.proxyConfig(),
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
      headers: { common: {}, get: {}, post: {}, put: {}, patch: {}, delete: {}, head: {} } as any,
    });
    const cookieHdr = this.cookieHeader();
    const response = await freshHttp.delete(url, {
      headers: {
        ...this.authHeaders(),
        ...this.proxyHeaders(),
        ...(cookieHdr ? { Cookie: cookieHdr } : {}),
        'x-csrf-token': csrfToken,
        ...headers,
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw bwHttpError(`DELETE ${url}`, response.status, response.data);
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
        ...this.authHeaders(),
        ...this.cookieHeaders(),
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    if (response.status >= 400) {
      throw bwHttpError(`Discovery GET`, response.status, response.data);
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
    // Keys already written by THIS run. Discovery is authoritative for the backend that
    // answered, so its value must replace the hardcoded fallback even when it is lower —
    // a backend serving an older resource version rejects the higher one with HTTP 415.
    // Within one document, several collections can still map to the same key, so among
    // those the highest version wins rather than whichever comes last.
    const discovered = new Set<string>();
    for (const segment of segments) {
      const hrefMatch = segment.match(/^<app:collection\b[^>]*?\shref="([^"]+)"/);
      if (!hrefMatch) continue;
      // Extract last URL segment as the key (e.g. ".../adso" → "adso"), then map the
      // release-specific spelling of that segment onto the key the server addresses.
      const rawKey = hrefMatch[1].split('/').pop()?.toLowerCase();
      if (!rawKey) continue;
      const key = COLLECTION_KEY_ALIASES[rawKey] ?? rawKey;
      // Consider only versioned XML modeling media types ("...-vX_Y_Z+xml").
      // Sub-resource accepts (e.g. "jobs.job+xml") and +json variants score 0.
      const versioned = [...segment.matchAll(/<app:accept>([^<]+)<\/app:accept>/g)]
        .map((a) => a[1].trim())
        .filter((mt) => extractVersion(mt) > 0);
      if (versioned.length === 0) continue;
      const best = versioned.reduce((a, b) => (extractVersion(b) >= extractVersion(a) ? b : a));
      const existing = discovered.has(key) ? MEDIA_TYPES[key] : undefined;
      if (!existing || extractVersion(best) >= extractVersion(existing)) {
        MEDIA_TYPES[key] = best;
        discovered.add(key);
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
      throw bwHttpError(`ADT GET source ${classEncoded}`, response.status, response.data);
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
      throw bwHttpError(`ADT LOCK ${classEncoded}`, response.status, response.data);
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
      throw bwHttpError(`ADT PUT source ${classEncoded}`, response.status, response.data);
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
      throw bwHttpError(`ADT activate ${classEncoded}`, response.status, response.data);
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
      throw bwHttpError(`ADT UNLOCK ${classEncoded}`, response.status, response.data);
    }
  }

  async unlock(type: string, name: string): Promise<void> {
    if (NO_UNLOCK_TYPES.has(type.toLowerCase())) return;
    const key = lockKey(this.identityKey(), type, name);
    // Release through the session that took the lock. From any other session BW answers
    // 200 and keeps the enqueue, which is what used to leave objects locked until SM12.
    const held = lockSessions.get(key);
    if (held && held.client !== this) {
      await held.client.unlock(type, name);
      return;
    }
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
      throw bwHttpError(`UNLOCK ${type.toUpperCase()} ${name}`, response.status, response.data);
    }
    lockSessions.delete(key);
  }
}

/**
 * A client for the current caller.
 *
 * Under the HTTP transport a per-request client is already in scope (its identity came
 * from XSUAA and, for a principal-propagation destination, from the Destination
 * service). This returns a fresh *session* on that same identity, which is exactly what
 * the ~30 existing call sites want — they call this to escape BW's per-session model
 * buffer, not to pick up credentials.
 *
 * Under stdio there is no request context and this reads the environment, unchanged.
 *
 * Keeping the signature means no tool file had to be touched for principal propagation.
 */
export function createClientFromEnv(): BwClient {
  const active = currentClient();
  if (active) return active.freshSession();
  return clientFromEnvironment();
}

function clientFromEnvironment(): BwClient {
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
    return new BwClient({ url, client, language, auth: { kind: 'cookies', cookies } });
  }

  // Basic Auth mode: classic on-premise BW/4HANA — unchanged from previous behavior.
  const user = process.env.BW_USER;
  const password = process.env.BW_PASSWORD;
  if (!user || !password) {
    throw new Error(
      'Required environment variables missing: BW_URL, BW_USER, BW_PASSWORD'
    );
  }
  return new BwClient({ url, client, language, auth: { kind: 'basic', user, password } });
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
/**
 * Decode the XML entities the modeling API returns in labels and titles. `&amp;` goes
 * last, so a literally escaped entity in the text survives instead of being decoded twice.
 */
let masterSystemCache: string | null = null;

/**
 * The `adtcore:masterSystem` value to send when creating an object.
 *
 * Taken from the system's own logical system name rather than derived from the URL host:
 * behind a destination or a proxy the host says nothing about the system, and with
 * BW_URL unset the old derivation produced "LOCALHOST", which the backend rejects. Cached
 * for the process — it cannot change while the server points at one system. Falls back to
 * the host derivation if the read fails, so a broken systeminfo cannot block a create.
 */
export async function resolveMasterSystem(client: BwClient): Promise<string> {
  if (masterSystemCache) return masterSystemCache;
  try {
    const { body } = await client.get('/sap/bw/modeling/repo/is/systeminfo', 'application/xml');
    const logsys = body.match(/name="system\.logsys"\s+value="([^"]*)"/)?.[1];
    if (logsys && /^[A-Z0-9]{3}/.test(logsys)) {
      masterSystemCache = logsys.slice(0, 3);
      return masterSystemCache;
    }
  } catch {
    // Fall through to the host derivation below.
  }
  return new URL(process.env.BW_URL ?? 'http://localhost').hostname.split('.')[0].toUpperCase();
}

/**
 * The InfoArea an object reports, with the backend's placeholder for "no InfoArea" removed.
 *
 * `NODESNOTCONNECTED` (`RSA_C_DEFAPPL`) is not an InfoArea. `CL_RSO_REPO_OBJECT` substitutes it
 * whenever an object's InfoArea is empty or names an area that does not exist, so that the
 * modeling tree still has a node to hang the object under — and the object read then reports
 * that placeholder as if it were the real assignment. Surfacing it invites a caller to treat it
 * as an addressable area; an empty string says what the backend actually means.
 */
export function stripInfoAreaSentinel(infoArea: string): string {
  return infoArea.trim().toUpperCase() === 'NODESNOTCONNECTED' ? '' : infoArea;
}

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export async function freshRead(path: string, accept: string): Promise<GetResult> {
  const sep = path.includes('?') ? '&' : '?';
  return createClientFromEnv().get(`${path}${sep}forceCacheUpdate=true`, accept);
}
