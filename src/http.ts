#!/usr/bin/env node
/**
 * HTTP entry point — SAP BTP Cloud Foundry.
 *
 * Adds an authenticated, multi-user front end to the same tools stdio exposes:
 *
 *   XSUAA decides who may call this server, and whether they may write
 *     (`read` / `analyst` / `write` scopes, mapped to three role collections).
 *   The BTP destination decides who they are to BW. With
 *     Authentication=PrincipalPropagation each caller reaches BW as themselves and
 *     BW applies their own authorizations; with BasicAuthentication everyone shares
 *     the destination's technical user and the MCP scopes are the only per-user control.
 *
 * stdio is untouched — no auth, no destination, one process one user.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { loadXsuaaCredentials, resolveAppUrl } from '@arc-mcp/xsuaa-auth';
import { createConnectivityProxy, parseVCAPServices } from '@arc-mcp/xsuaa-auth/btp';
import { oauthSettingsFromEnv, setupOAuth } from './auth.js';
import { withSessionScope } from './bw-client.js';
import { createServer } from './index.js';
import { ensurePlatform } from './platform.js';
import { trustedProxyHops } from './proxy-trust.js';
import { runWithClient } from './request-context.js';
import { allowedHosts, allowedOrigins, hostAllowed, mcpRateLimit, originAllowed } from './transport-guard.js';
import { SCOPES, hasScope } from './scopes.js';
import {
  createPrincipalPropagationClient,
  createSharedDestinationClient,
  userLabel,
  type DestinationDeps,
} from './destination.js';

const log = {
  debug: (m: string, x?: unknown) => process.stderr.write(`[debug] ${m} ${x ? JSON.stringify(x) : ''}\n`),
  info: (m: string, x?: unknown) => process.stderr.write(`[info] ${m} ${x ? JSON.stringify(x) : ''}\n`),
  warn: (m: string, x?: unknown) => process.stderr.write(`[warn] ${m} ${x ? JSON.stringify(x) : ''}\n`),
  error: (m: string, x?: unknown) => process.stderr.write(`[error] ${m} ${x ? JSON.stringify(x) : ''}\n`),
};

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8080);
  const destinationName = process.env.BW_BTP_DESTINATION;
  if (!destinationName) {
    throw new Error('BW_BTP_DESTINATION is required for the HTTP transport (the BTP destination pointing at BW).');
  }

  // Principal propagation is opt-in, because it needs Cloud Connector and ABAP-side
  // setup (CERTRULE, ICM trust) that a BasicAuthentication destination does not.
  const ppEnabled = process.env.BW_PP_ENABLED === 'true';

  if (ppEnabled && (process.env.BW_USER || process.env.BW_PASSWORD || process.env.BW_COOKIE_FILE)) {
    // A shared BW session would win: BW ties the session to whoever opened it, so one
    // leftover credential turns every per-user request into that user's session, and
    // nothing in the logs would show it.
    throw new Error(
      'BW_PP_ENABLED=true together with BW_USER / BW_PASSWORD / BW_COOKIE_FILE. A shared BW session ' +
        'silently overrides per-user identity — unset them; the HTTP transport takes credentials from the destination.',
    );
  }

  const btpConfig = parseVCAPServices(process.env, log);
  if (!btpConfig) {
    throw new Error(
      'No BTP service bindings found in VCAP_SERVICES. Bind a destination service instance ' +
        '(and a connectivity instance if BW is on-premise behind the Cloud Connector).',
    );
  }
  // Null when no connectivity binding exists, which is correct for an internet-reachable
  // BW. Whether the proxy is actually needed depends on the destination's ProxyType.
  const proxy = createConnectivityProxy(btpConfig, process.env.BW_CC_LOCATION_ID, log) ?? undefined;
  const deps: DestinationDeps = { btpConfig, proxy, destinationName };

  const app = express();
  const proxyHops = trustedProxyHops(process.env);
  if (proxyHops > 0) app.set('trust proxy', proxyHops);
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: true }));

  const appUrl = resolveAppUrl(process.env, { publicUrlEnvVar: 'BW_PUBLIC_URL', port });
  const refuse = (res: Response, status: number, message: string): void => {
    res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
  };

  // Before authentication, so a page that got a browser to call this server under a foreign
  // name learns nothing from it, not even whether a token would have been accepted.
  const hosts = allowedHosts(process.env, appUrl, port);
  const origins = allowedOrigins(process.env, appUrl);
  const hostAndOrigin = (req: Request, res: Response, next: NextFunction): void => {
    if (!hostAllowed(req.headers.host, hosts)) return refuse(res, 403, 'Host not allowed.');
    if (!originAllowed(req.headers.origin, origins)) return refuse(res, 403, 'Origin not allowed.');
    next();
  };

  // After authentication, since the limit is per user.
  const perMinute = mcpRateLimit(process.env);
  const perUser =
    perMinute > 0
      ? rateLimit({
          windowMs: 60_000,
          limit: perMinute,
          keyGenerator: (req) => userLabel((req as unknown as { auth?: AuthInfo }).auth),
          standardHeaders: true,
          legacyHeaders: false,
          handler: (_req, res) => refuse(res, 429, 'Too many requests: wait a minute before the next call.'),
        })
      : (_req: Request, _res: Response, next: NextFunction): void => next();

  // Never start open: an unauthenticated MCP server in front of a Cloud Connector is a
  // tunnel into the corporate network. Without the XSUAA binding this throws.
  const bearer = setupOAuth(
    app,
    {
      credentials: loadXsuaaCredentials(),
      appUrl,
      clientIdPrefix: 'bwmcp-',
      resourceName: 'SAP BW Modeling MCP',
      scopesSupported: [...SCOPES],
      settings: oauthSettingsFromEnv(process.env),
    },
    log,
  );

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', transport: 'http-streamable', principalPropagation: ppEnabled });
  });

  app.all('/mcp', hostAndOrigin, bearer, perUser, async (req, res) => {
    const authInfo = (req as unknown as { auth?: AuthInfo }).auth;
    if (!SCOPES.some((s) => hasScope(authInfo, s))) {
      res.status(403).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'The token holds none of the scopes of this server: assign one of its role collections.',
        },
        id: null,
      });
      return;
    }
    let client;
    try {
      client = ppEnabled
        ? await createPrincipalPropagationClient(deps, authInfo)
        : await createSharedDestinationClient(deps);
    } catch (err) {
      // Fail closed. A principal-propagation failure must never quietly fall back to a
      // shared identity — an error is the only safe outcome.
      // The cause names the destination and backend addresses, which a remote caller has no
      // use for. It goes to the log under a reference the caller can quote to the operator.
      const message = err instanceof Error ? err.message : String(err);
      const reference = randomUUID();
      log.error('could not build BW client', { reference, user: userLabel(authInfo), destination: destinationName, message });
      res.status(502).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: `Could not connect to BW (reference ${reference}). The operator finds the cause in the server log under this reference.` },
        id: null,
      });
      return;
    }

    // Detect the platform before the server is built: createServer() puts the platform
    // paragraph into the instructions from the cached verdict and cannot await anything
    // itself. Cached process-wide after the first request, and it never rejects.
    await withSessionScope(() => ensurePlatform(client));

    // Stateless: a fresh Server and transport per request. The SDK binds a Server to one
    // transport for its lifetime, so a shared instance fails after the first call. Per
    // request also means no protocol state survives between two callers.
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await runWithClient(client, async () => {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
  });

  app.listen(port, () => {
    process.stderr.write(
      `bw-modeling-mcp listening on :${port} — destination '${destinationName}'` +
        `${ppEnabled ? ' with principal propagation' : ' (shared technical user)'}\n`,
    );
  });
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
