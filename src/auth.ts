/**
 * OAuth for the HTTP transport: an authorization server in front of /mcp, backed by XSUAA.
 *
 * Composed from the building blocks of `@arc-mcp/xsuaa-auth` in the order its own facade uses
 * (redirect shim, callback proxy, the SDK's auth router, bearer middleware). The facade is not
 * used because three things it has no option for are needed once clients reach the server
 * through a gateway or a company proxy:
 *
 *   Client credentials in the Authorization header. The SDK reads client_id from the form body
 *     only, while RFC 6749 section 2.3.1 lets a confidential client send it in the header alone;
 *     such a client was refused before its credentials were looked at.
 *   Refresh tokens bound to their client (refresh-binding.ts).
 *   Rate limits that fit shared addresses. The SDK counts per address, and a gateway or a
 *     company's outbound proxy puts every user behind one. The limits are configurable, and
 *     the addresses named as gateways get twenty times as much.
 */
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import {
  createChainedTokenVerifier,
  createOAuthCallbackHandler,
  createXsuaaOAuthProvider,
  createXsuaaTokenVerifier,
} from '@arc-mcp/xsuaa-auth';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { redirectAllowlistFromEnv, redirectStrictFromEnv } from './redirect-allowlist.js';
import { RefreshTokenBinding, SEALED_PREFIX } from './refresh-binding.js';

type XsuaaCredentials = Parameters<typeof createXsuaaOAuthProvider>[0];
type Provider = ReturnType<typeof createXsuaaOAuthProvider>['provider'];

interface Logger {
  debug: (m: string, x?: unknown) => void;
  info: (m: string, x?: unknown) => void;
  warn: (m: string, x?: unknown) => void;
  error: (m: string, x?: unknown) => void;
}

const GATEWAY_FACTOR = 20;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const CLIENT_AUTH_METHODS = ['client_secret_basic', 'client_secret_post', 'none'];

export interface OAuthSettings {
  /** Redirect URIs and patterns of the known clients. */
  redirectUris: string[];
  /** Whether dynamic registration is limited to redirectUris. */
  redirectStrict: boolean;
  /** Requests per address per 15 minutes on /authorize, /token and /revoke. */
  rateLimit: number;
  /** Registrations per address per hour on /register. */
  registerRateLimit: number;
  /** Addresses of gateways that stand in front of many users. */
  gatewayIps: string[];
  /** Origins of browser-based clients, for CORS. */
  allowedOrigins: string[];
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function whole(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a whole number above zero, not "${raw}".`);
  return value;
}

export function oauthSettingsFromEnv(env: NodeJS.ProcessEnv): OAuthSettings {
  return {
    redirectUris: redirectAllowlistFromEnv(env),
    redirectStrict: redirectStrictFromEnv(env),
    rateLimit: whole(env, 'BW_OAUTH_RATE_LIMIT', 300),
    registerRateLimit: whole(env, 'BW_OAUTH_REGISTER_RATE_LIMIT', 60),
    gatewayIps: list(env.BW_OAUTH_GATEWAY_IPS),
    allowedOrigins: list(env.BW_ALLOWED_ORIGINS),
  };
}

export interface OAuthOptions {
  credentials: XsuaaCredentials;
  appUrl: string;
  clientIdPrefix: string;
  resourceName: string;
  scopesSupported: string[];
  settings: OAuthSettings;
}

/** What one address may send within a window; a gateway address gets the larger share. */
export function limitFor(ip: string | undefined, limit: number, gatewayIps: ReadonlySet<string>): number {
  return ip !== undefined && gatewayIps.has(ip) ? limit * GATEWAY_FACTOR : limit;
}

/**
 * Take client credentials from an `Authorization: Basic` header into the form body, where the
 * SDK's client authentication reads them. One way of authenticating per request: credentials
 * in the header and a secret in the body, or two different client ids, are refused.
 */
export function clientSecretBasic(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !/^basic\s/i.test(header)) {
    next();
    return;
  }
  const refuse = (status: number, error: string, description: string): void => {
    res.status(status).json({ error, error_description: description });
  };

  let clientId: string;
  let clientSecret: string;
  try {
    const decoded = Buffer.from(header.replace(/^basic\s+/i, ''), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 1) throw new Error('no client id');
    // Both parts travel form-urlencoded inside the header.
    const formDecode = (s: string): string => decodeURIComponent(s.replace(/\+/g, ' '));
    clientId = formDecode(decoded.slice(0, colon));
    clientSecret = formDecode(decoded.slice(colon + 1));
  } catch {
    refuse(401, 'invalid_client', 'Malformed Basic client credentials');
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.client_secret !== undefined) {
    refuse(400, 'invalid_request', 'Client credentials sent in more than one way');
    return;
  }
  if (body.client_id !== undefined && body.client_id !== clientId) {
    refuse(400, 'invalid_request', 'client_id in the body does not match the Authorization header');
    return;
  }
  req.body = { ...body, client_id: clientId, client_secret: clientSecret };
  next();
}

/** Name the client authentication methods the endpoints accept in the server metadata. */
function advertiseClientAuth(_req: Request, res: Response, next: NextFunction): void {
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(body);
    return json({
      ...body,
      token_endpoint_auth_methods_supported: CLIENT_AUTH_METHODS,
      revocation_endpoint_auth_methods_supported: CLIENT_AUTH_METHODS,
    });
  };
  next();
}

/** Seal every refresh token handed out to its client, and accept it from that client only. */
export function bindRefreshTokens(provider: Provider, binding: RefreshTokenBinding): void {
  const seal = (tokens: OAuthTokens, client: OAuthClientInformationFull): OAuthTokens =>
    tokens.refresh_token ? { ...tokens, refresh_token: binding.seal(tokens.refresh_token, client.client_id) } : tokens;

  const exchangeCode = provider.exchangeAuthorizationCode.bind(provider);
  provider.exchangeAuthorizationCode = async (client, ...rest) => seal(await exchangeCode(client, ...rest), client);

  const exchangeRefresh = provider.exchangeRefreshToken.bind(provider);
  provider.exchangeRefreshToken = async (client, refreshToken, scopes) => {
    const upstream = binding.unseal(refreshToken, client.client_id);
    if (!upstream) throw new InvalidGrantError('Refresh token is invalid, expired or belongs to another client');
    return seal(await exchangeRefresh(client, upstream, scopes), client);
  };

  const revoke = provider.revokeToken;
  if (revoke) {
    provider.revokeToken = async (client, request) => {
      if (!request.token.startsWith(SEALED_PREFIX)) return revoke(client, request);
      const upstream = binding.unseal(request.token, client.client_id);
      // RFC 7009 section 2.2: a token the server does not recognise is answered like a revoked one.
      if (upstream) await revoke(client, { ...request, token: upstream });
    };
  }
}

/** CORS for browser-based clients: the exact origin is reflected, and only when it is listed. */
function cors(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version');
      res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
    next();
  };
}

/** Mount the OAuth endpoints on `app` and return the bearer middleware for /mcp. */
export function setupOAuth(app: Express, options: OAuthOptions, log: Logger): RequestHandler {
  const { credentials, appUrl, settings } = options;
  const base = appUrl.replace(/\/$/, '');

  if (settings.allowedOrigins.length > 0) app.use(cors(settings.allowedOrigins));

  const { provider, clientStore, stateCodec } = createXsuaaOAuthProvider(credentials, appUrl, {
    clientIdPrefix: options.clientIdPrefix,
    // A dynamically registered client_id never expires by age. Copilot Studio caches its
    // client_id and does not register again when it is refused, so the default 30-day lifetime
    // locked it out until the connection was recreated by hand. Narrowing the redirect list or
    // rotating the signing secret still withdraws registrations.
    dcrTtlSeconds: 0,
    // The list always gates the pre-registered client. A dynamically registered client may
    // name any https callback unless the operator switched the strict mode on: the approval
    // page shows the user where the code goes, and a list of known vendors would lock out
    // every MCP client that is not on it. In strict mode the list is re-applied to every
    // signed client_id when it is loaded, so switching it on withdraws earlier registrations.
    redirectUriPatterns: settings.redirectUris,
    dcrRedirectUriPatterns: settings.redirectStrict ? settings.redirectUris : undefined,
    logger: log,
  });

  bindRefreshTokens(provider, new RefreshTokenBinding(credentials.clientsecret));

  // Parameters of a POST /authorize may arrive in the query, and the redirect URI of a client
  // that uses the pre-registered client id is added to it when the list allows it. The form
  // fields have to be parsed before the SDK compares redirect URIs.
  app.use('/authorize', express.urlencoded({ extended: false }));
  app.use('/authorize', (req, _res, next) => {
    if (req.method === 'POST' && req.query.client_id && !req.body?.client_id) {
      req.body = { ...req.query, ...(req.body || {}) };
    }
    const params = (req.method === 'POST' ? req.body : req.query) as Record<string, unknown> | undefined;
    if (typeof params?.client_id === 'string' && typeof params?.redirect_uri === 'string') {
      clientStore.ensureRedirectUri(params.client_id, params.redirect_uri);
    }
    next();
  });
  app.get('/oauth/callback', createOAuthCallbackHandler(stateCodec, clientStore, { logger: log }));

  app.use(['/token', '/revoke'], express.urlencoded({ extended: false }), clientSecretBasic);
  app.use('/.well-known/oauth-authorization-server', advertiseClientAuth);

  const gateways = new Set(settings.gatewayIps);
  const window = (windowMs: number, limit: number) => ({
    rateLimit: { windowMs, limit: (req: Request) => limitFor(req.ip, limit, gateways) },
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(appUrl),
      baseUrl: new URL(appUrl),
      resourceServerUrl: new URL(`${base}/mcp`),
      // Advertised as `scopes_supported`. Without it a client requests no scopes; XSUAA still
      // grants them, and an older Copilot auth implementation then falls back to the JWT
      // `scope` claim, an array on XSUAA, and fails on it.
      scopesSupported: options.scopesSupported,
      resourceName: options.resourceName,
      authorizationOptions: window(FIFTEEN_MINUTES, settings.rateLimit),
      tokenOptions: window(FIFTEEN_MINUTES, settings.rateLimit),
      revocationOptions: window(FIFTEEN_MINUTES, settings.rateLimit),
      clientRegistrationOptions: window(ONE_HOUR, settings.registerRateLimit),
    }),
  );

  log.info('XSUAA OAuth proxy enabled', {
    xsappname: credentials.xsappname,
    appUrl,
    gatewayAddresses: settings.gatewayIps.length,
  });

  const verifier = createChainedTokenVerifier(
    {},
    // Narrows the verifier's accepted scopes to the ones this server defines.
    createXsuaaTokenVerifier(credentials, { acceptedScopes: options.scopesSupported, logger: log }),
    undefined,
    { logger: log },
  );
  // No required scopes: the middleware would name them in the `scope` of its 401 challenge, and
  // an MCP client requests the challenge's scope in preference to `scopes_supported`. With
  // `read` there every token held `read` alone, so no write tool was ever offered and an
  // analyst-only caller was refused outright. Holding one of the scopes is checked on /mcp.
  return requireBearerAuth({
    verifier: { verifyAccessToken: verifier },
    resourceMetadataUrl: `${base}/.well-known/oauth-protected-resource/mcp`,
  });
}
