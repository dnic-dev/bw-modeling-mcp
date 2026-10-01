/**
 * BTP Audit Log sink.
 *
 * Under principal propagation BW already records the real ABAP user, but that trail lives
 * in each BW system. This sink adds the view from the other side: who called which tool,
 * with which arguments, through this server — in one place, retained by SAP, and readable
 * by people who have no BW logon. Without it the only record of a tool call is `cf logs`,
 * which rolls over and belongs to whoever can reach the Cloud Foundry space.
 *
 * Off unless an `auditlog` service instance is bound. Writes are fire-and-forget: the audit
 * backend is never allowed to fail or slow down a tool call.
 *
 * ## The premium plan is mTLS-only
 *
 * `auditlog`/`premium` issues no client secret. The token endpoint (`uaa.certurl`, an
 * `*.authentication.cert.*` host) accepts nothing but a TLS client certificate, and the
 * broker only puts one in the binding when BOTH the instance and the binding were created
 * with x509 parameters:
 *
 *   cf create-service auditlog premium <name> -c '{"xs-security":{"xsappname":"<unique>",
 *     "oauth2-configuration":{"credential-types":["x509"],"grant-types":["client_credentials"]}}}'
 *   cf bind-service <app> <name> -c '{"xsuaa":{"credential-type":"x509",
 *     "x509":{"key-length":2048,"validity":2,"validity-type":"MONTHS"}}}'
 *
 * A plain `cf create-service` + `cf bind-service` yields a `binding-secret` binding that can
 * never authenticate. {@link parseAuditLogConfig} therefore refuses such a binding loudly
 * instead of starting a sink that would silently drop every event — the failure mode is
 * indistinguishable from "auditing is on and nothing happened".
 *
 * The binding certificate EXPIRES after `validity`. When it does, writes start failing and
 * the only signal is the warning this module emits. Rotate by re-binding before that date.
 */
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';

import { requiredScope } from './scopes.js';

/** The four collections the Write API exposes; each is a separate endpoint. */
export type AuditCategory =
  | 'security-events'
  | 'configuration-changes'
  | 'data-accesses'
  | 'data-modifications';

export interface AuditLogConfig {
  url: string;
  uaa: { certurl: string; clientid: string; certificate: string; key: string };
}

/** What every event carries, whatever its category. */
export interface AuditEvent {
  tool: string;
  user: string;
  /** Tool arguments; truncated and sent as a single attribute. */
  args?: Record<string, unknown>;
  outcome?: 'success' | 'error';
  durationMs?: number;
  errorMessage?: string;
  /** How much came back — see {@link resultMetrics}. */
  result?: ResultMetrics;
  /** Set on a denial instead of the fields above. */
  denialReason?: string;
}

/** The size of what a tool returned, and its row count where the tool states one. */
export interface ResultMetrics {
  resultChars: number;
  resultLines: number;
  resultRows?: number;
}

/**
 * The line `bw_query_data` renders above its table. It is the only place a tool states
 * how many rows it returned, so it is the only source of a true row count; the marker in
 * tools/reporting.ts carries a pointer back here. A wording change costs the row count,
 * never a wrong one — the size attributes below are always correct.
 */
const ROW_COUNT = /^── Result \((\d+) rows × \d+ columns\) ──$/m;

/**
 * How much a call actually read. Without this the trail answers "who asked for what" but
 * not "how much came back" — one row and two hundred thousand look identical. Sizes, not
 * content: the returned data itself must not end up in a second store.
 */
export function resultMetrics(text: string): ResultMetrics {
  const rows = ROW_COUNT.exec(text);
  return {
    resultChars: text.length,
    resultLines: text === '' ? 0 : text.split('\n').length,
    ...(rows ? { resultRows: Number(rows[1]) } : {}),
  };
}

/** Binding fields the mTLS flow cannot work without. */
const REQUIRED_X509_FIELDS = ['certurl', 'certificate', 'key'] as const;

/** Tool arguments can be large (whole routines, field lists); one attribute, bounded. */
const MAX_ARGS_CHARS = 500;

/** One warning per minute at most: a broken sink must not drown the log it shares with BW errors. */
const WARN_INTERVAL_MS = 60_000;

/**
 * Tools that change the system's shape rather than its data.
 *
 * Everything else follows {@link requiredScope}: `read` is a data access, `write` a data
 * modification. Deriving from that one set keeps a new tool correctly categorised without
 * touching this file — the same reason `scopes.ts` lists reads rather than writes.
 */
const CONFIGURATION_TOOLS = new Set([
  'bw_activate',
  'bw_change_package',
  'bw_create_infoarea',
  'bw_create_transport_task',
  'bw_move_object',
]);

export function categoryFor(toolName: string): AuditCategory {
  if (CONFIGURATION_TOOLS.has(toolName)) return 'configuration-changes';
  // Asked as "does it require write?" rather than "is it a read?": `analyst` is a third
  // scope and a strict subset of `read`, and a tool carrying only that one must still be
  // filed as an access, not as a modification. Unknown tools require `write` (scopes.ts),
  // so they land in data-modifications — the safe direction.
  return requiredScope(toolName) === 'write' ? 'data-modifications' : 'data-accesses';
}

/**
 * A bound auditlog instance whose credentials cannot authenticate.
 *
 * Thrown rather than returned so a misconfigured deployment is loud at startup. The message
 * carries the exact `cf` parameters, because the fix is a re-create and a re-bind — the
 * broker cannot update an existing instance's `xs-security`.
 */
export class AuditLogBindingError extends Error {
  constructor(
    readonly plan: string,
    readonly missing: readonly string[],
    credentialType: string | undefined,
  ) {
    super(
      `BTP Audit Log binding (plan "${plan}", credential-type "${credentialType ?? 'unknown'}") is missing ` +
        `${missing.map((f) => `uaa.${f}`).join(', ')}. The premium plan authenticates over mTLS: create the ` +
        `instance with -c '{"xs-security":{"xsappname":"<unique-per-subaccount>","oauth2-configuration":` +
        `{"credential-types":["x509"],"grant-types":["client_credentials"]}}}' and bind with ` +
        `-c '{"xsuaa":{"credential-type":"x509","x509":{"key-length":2048,"validity":2,"validity-type":"MONTHS"}}}'. ` +
        `An existing instance cannot be updated — delete and re-create it. Audit logging stays off until then.`,
    );
    this.name = 'AuditLogBindingError';
  }
}

interface Binding {
  plan?: unknown;
  credentials?: { url?: unknown; uaa?: Record<string, unknown> };
}

/**
 * Read the auditlog binding from `VCAP_SERVICES`.
 *
 * Returns undefined when nothing is bound (the normal case for stdio and for deployments
 * that do not want auditing). Throws {@link AuditLogBindingError} when a binding exists but
 * carries no client certificate.
 */
export function parseAuditLogConfig(env: NodeJS.ProcessEnv = process.env): AuditLogConfig | undefined {
  const vcap = env.VCAP_SERVICES;
  if (!vcap) return undefined;

  let binding: Binding | undefined;
  try {
    const services = JSON.parse(vcap) as Record<string, Binding[] | undefined>;
    const entries = services.auditlog ?? services['auditlog-api'] ?? [];
    binding = Array.isArray(entries)
      ? entries.find((s) => s.plan === 'premium' || s.plan === 'oauth2')
      : undefined;
  } catch {
    return undefined; // a malformed VCAP_SERVICES is the platform's problem, not ours to crash on
  }

  const creds = binding?.credentials;
  if (!creds) return undefined;

  const uaa = creds.uaa ?? {};
  const missing = REQUIRED_X509_FIELDS.filter((f) => typeof uaa[f] !== 'string' || uaa[f] === '');
  if (missing.length > 0) {
    const credentialType = uaa['credential-type'];
    throw new AuditLogBindingError(
      String(binding?.plan),
      missing,
      typeof credentialType === 'string' ? credentialType : undefined,
    );
  }

  return {
    url: String(creds.url),
    uaa: {
      certurl: String(uaa.certurl),
      clientid: String(uaa.clientid ?? ''),
      certificate: String(uaa.certificate),
      key: String(uaa.key),
    },
  };
}

type Logger = { info(m: string, x?: unknown): void; warn(m: string, x?: unknown): void };

export class AuditLogSink {
  private token: string | undefined;
  private tokenExpiresAt = 0;
  private pending: Promise<void>[] = [];
  private lastWarnAt = 0;
  private suppressedWarnings = 0;

  constructor(
    private readonly config: AuditLogConfig,
    private readonly log: Logger,
    /** Names the BW system in `data_subject`; the destination is the closest stable identifier. */
    private readonly system: string,
  ) {}

  /** Never awaited by a tool call. Failures warn and are dropped. */
  write(event: AuditEvent, category: AuditCategory): void {
    const p = this.send(event, category).catch((err: unknown) => this.warn(err));
    this.pending.push(p);
    if (this.pending.length > 50) this.pending = this.pending.slice(-50);
  }

  /** For tests and shutdown; production never blocks on this. */
  async flush(): Promise<void> {
    await Promise.allSettled(this.pending);
    this.pending = [];
  }

  private warn(err: unknown): void {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) {
      this.suppressedWarnings += 1;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const suppressed = this.suppressedWarnings;
    this.lastWarnAt = now;
    this.suppressedWarnings = 0;
    this.log.warn('audit log write failed', {
      message,
      ...(suppressed > 0 ? { suppressedSince: suppressed } : {}),
    });
  }

  private async send(event: AuditEvent, category: AuditCategory): Promise<void> {
    const token = await this.getToken();
    const response = await fetch(`${this.config.url}/audit-log/oauth2/v2/${category}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: `Bearer ${token}` },
      body: JSON.stringify(this.payload(event, category)),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
  }

  /**
   * One audit record.
   *
   * `data_subject` is mandatory on data-accesses and data-modifications — without it the
   * Write API answers `400 'data_subject' and 'data_subjects' properties cannot be both null
   * or empty`. The subject is the BW system whose data the caller touched; the persons behind
   * that data are not knowable here. Security events and configuration changes have no such
   * field in SAP's schema and must not carry one.
   */
  private payload(event: AuditEvent, category: AuditCategory): Record<string, unknown> {
    const base: Record<string, unknown> = {
      uuid: randomUUID(),
      user: event.user,
      time: new Date().toISOString(),
      tenant: '$PROVIDER',
    };

    if (category === 'security-events') {
      return {
        ...base,
        data: `Tool "${event.tool}" denied for user "${event.user}": ${event.denialReason ?? 'not permitted'}.`,
      };
    }

    const attributes: Array<{ name: string; new: string }> = [
      { name: 'tool', new: event.tool },
      { name: 'user', new: event.user },
    ];
    if (event.args !== undefined) {
      const serialised = JSON.stringify(event.args);
      attributes.push({
        name: 'args',
        new: serialised.length > MAX_ARGS_CHARS ? `${serialised.slice(0, MAX_ARGS_CHARS)}...` : serialised,
      });
    }
    if (event.outcome) attributes.push({ name: 'status', new: event.outcome });
    if (event.durationMs !== undefined) attributes.push({ name: 'durationMs', new: String(event.durationMs) });
    if (event.errorMessage) attributes.push({ name: 'error', new: event.errorMessage.slice(0, 500) });
    if (event.result) {
      attributes.push({ name: 'resultChars', new: String(event.result.resultChars) });
      attributes.push({ name: 'resultLines', new: String(event.result.resultLines) });
      if (event.result.resultRows !== undefined) {
        attributes.push({ name: 'resultRows', new: String(event.result.resultRows) });
      }
    }

    const payload: Record<string, unknown> = {
      ...base,
      object: { type: 'BW MCP Tool Call', id: { tool: event.tool } },
      attributes,
    };
    if (category === 'data-accesses' || category === 'data-modifications') {
      payload.data_subject = { type: 'bw-system', role: 'data-owner', id: { system: this.system } };
    }
    return payload;
  }

  /**
   * Client-credentials token over mTLS.
   *
   * The binding's certificate is the credential; there is no secret to send. Node's global
   * fetch cannot present a client certificate, so this goes through `node:https`, which takes
   * `cert`/`key` directly and keeps the module dependency-free.
   */
  private getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return Promise.resolve(this.token);

    const url = new URL(`${this.config.uaa.certurl.replace(/\/$/, '')}/oauth/token`);
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.uaa.clientid,
    }).toString();

    return new Promise<string>((resolve, reject) => {
      const req = httpsRequest(
        {
          method: 'POST',
          hostname: url.hostname,
          path: url.pathname,
          cert: this.config.uaa.certificate,
          key: this.config.uaa.key,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`token request failed: HTTP ${res.statusCode} from ${url.host}`));
              return;
            }
            try {
              const parsed = JSON.parse(data) as { access_token: string; expires_in: number };
              this.token = parsed.access_token;
              this.tokenExpiresAt = Date.now() + parsed.expires_in * 1000;
              resolve(parsed.access_token);
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
        },
      );
      req.on('error', (err) =>
        reject(
          new Error(
            `token request failed: ${err.message} — the mTLS handshake with ${url.host} was refused; ` +
              `check that the binding is x509 and its certificate has not expired`,
          ),
        ),
      );
      req.end(body);
    });
  }
}

/** Process-wide sink, or undefined when nothing is bound. */
let sink: AuditLogSink | undefined;

/**
 * Create the sink if an auditlog instance is bound.
 *
 * A bound-but-unusable binding is a deployment error worth failing over: the operator asked
 * for an audit trail and would otherwise get none, with nothing to notice. Anything else
 * (no binding at all) leaves auditing off, which is the documented default.
 */
export function initAuditLog(log: Logger, system: string): void {
  const config = parseAuditLogConfig();
  if (!config) return;
  sink = new AuditLogSink(config, log, system);
  log.info('BTP audit log enabled', { url: config.url });
}

export function auditLog(): AuditLogSink | undefined {
  return sink;
}

/** Tests only. */
export function setAuditLogForTesting(next: AuditLogSink | undefined): void {
  sink = next;
}
