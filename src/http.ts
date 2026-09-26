#!/usr/bin/env node
/**
 * HTTP entry point — SAP BTP Cloud Foundry.
 *
 * Adds an authenticated, multi-user front end to the same tools stdio exposes:
 *
 *   XSUAA decides who may call this server, and whether they may write
 *     (`read` / `write` scopes, mapped to two role collections).
 *   The BTP destination decides who they are to BW. With
 *     Authentication=PrincipalPropagation each caller reaches BW as themselves and
 *     BW applies their own authorizations; with BasicAuthentication everyone shares
 *     the destination's technical user and the MCP scopes are the only per-user control.
 *
 * stdio is untouched — no auth, no destination, one process one user.
 */
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { setupHttpAuth, loadXsuaaCredentials, resolveAppUrl } from '@arc-mcp/xsuaa-auth';
import { createConnectivityProxy, parseVCAPServices } from '@arc-mcp/xsuaa-auth/btp';
import { createServer } from './index.js';
import { ensurePlatform } from './platform.js';
import { initAuditLog } from './audit.js';
import { runWithClient } from './request-context.js';
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

  // Before the BW plumbing: an unusable audit binding should stop the deploy, not be
  // discovered later by the absence of records. No binding at all leaves auditing off.
  initAuditLog(log, destinationName);

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
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: true }));

  const bearer = setupHttpAuth(
    app,
    {
      xsuaa: {
        credentials: loadXsuaaCredentials(),
        appUrl: resolveAppUrl(process.env, { publicUrlEnvVar: 'BW_PUBLIC_URL', port }),
        clientIdPrefix: 'bwmcp-',
        resourceName: 'SAP BW Modeling MCP',
        // Advertised as `scopes_supported` in the OAuth metadata. Without it a client
        // requests no scopes; XSUAA still grants them, and Copilot's older auth code
        // then falls back to the JWT `scope` claim — an array on XSUAA — and crashes
        // with `scope.split is not a function` (fixed upstream in vscode#325344, but
        // the Eclipse Language Server lags behind). Also narrows the verifier's
        // accepted scopes from the arc-1 default set to the two this server defines.
        scopesSupported: ['read', 'analyst', 'write'],
        requiredScopes: ['read'],
      },
      allowedOrigins: process.env.BW_ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean),
      // Never start open: an unauthenticated MCP server in front of a Cloud Connector
      // is a tunnel into the corporate network.
      required: true,
    },
    log,
  );

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', transport: 'http-streamable', principalPropagation: ppEnabled });
  });

  app.all('/mcp', bearer!, async (req, res) => {
    const authInfo = (req as unknown as { auth?: AuthInfo }).auth;
    let client;
    try {
      client = ppEnabled
        ? await createPrincipalPropagationClient(deps, authInfo)
        : await createSharedDestinationClient(deps);
    } catch (err) {
      // Fail closed. A principal-propagation failure must never quietly fall back to a
      // shared identity — an error is the only safe outcome.
      const message = err instanceof Error ? err.message : String(err);
      log.error('could not build BW client', { user: userLabel(authInfo), destination: destinationName, message });
      res.status(502).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: `Could not connect to BW: ${message}` },
        id: null,
      });
      return;
    }

    // Detect the platform before the server is built: createServer() puts the platform
    // paragraph into the instructions from the cached verdict and cannot await anything
    // itself. Cached process-wide after the first request, and it never rejects.
    await ensurePlatform(client);

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
