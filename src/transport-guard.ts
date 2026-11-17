/**
 * Who may address the MCP endpoint, and how often.
 *
 * A browser sends the user's requests to wherever a page tells it to, including a name an
 * attacker controls that resolves to this server (DNS rebinding). The `Host` a request names
 * and the `Origin` it comes from are what tell such a request from a legitimate one, and CORS
 * headers alone refuse nothing: they only tell the browser what it may read. Native clients
 * and gateways send no `Origin` and are unaffected.
 */

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The Cloud Foundry routes of this application, empty anywhere else. */
function routeHosts(env: NodeJS.ProcessEnv): string[] {
  try {
    const uris = (JSON.parse(env.VCAP_APPLICATION ?? '{}') as { application_uris?: unknown }).application_uris;
    return Array.isArray(uris) ? uris.filter((u): u is string => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The `Host` values the endpoint answers under: the advertised URL, the routes the platform
 * mapped to the application, and BW_ALLOWED_HOSTS. Outside Cloud Foundry the loopback names
 * are added, since a local run is reached under either of them.
 */
export function allowedHosts(env: NodeJS.ProcessEnv, appUrl: string, port: number): Set<string> {
  const hosts = [new URL(appUrl).host, ...routeHosts(env), ...list(env.BW_ALLOWED_HOSTS)];
  if (!env.VCAP_APPLICATION) hosts.push(`localhost:${port}`, `127.0.0.1:${port}`);
  return new Set(hosts.map((h) => h.toLowerCase()));
}

/** The origins a browser-based client may call from: the server's own and BW_ALLOWED_ORIGINS. */
export function allowedOrigins(env: NodeJS.ProcessEnv, appUrl: string): Set<string> {
  return new Set([new URL(appUrl).origin, ...list(env.BW_ALLOWED_ORIGINS)].map((o) => o.toLowerCase()));
}

export function hostAllowed(host: string | undefined, hosts: Set<string>): boolean {
  return host !== undefined && hosts.has(host.toLowerCase());
}

/** A request without an `Origin` is not from a browser page and passes. */
export function originAllowed(origin: string | undefined, origins: Set<string>): boolean {
  return origin === undefined || origins.has(origin.toLowerCase());
}

/**
 * MCP requests one user may send per minute; 0 switches the limit off.
 *
 * Counted per user rather than per address: behind a gateway or a company proxy many users
 * share one address, and one agent stuck in a loop must not use up everyone's share of the
 * work processes of the BW system.
 */
export function mcpRateLimit(env: NodeJS.ProcessEnv): number {
  const raw = env.BW_MCP_RATE_LIMIT;
  if (raw === undefined || raw.trim() === '') return 120;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`BW_MCP_RATE_LIMIT must be a whole number of requests per minute, not "${raw}".`);
  }
  return value;
}
