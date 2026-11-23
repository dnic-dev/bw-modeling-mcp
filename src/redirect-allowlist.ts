/**
 * Where an authorization code may be sent.
 *
 * Dynamic client registration is open to anyone who can reach the server, so the redirect URI
 * a client registers decides who receives the code of a user who approves the sign-in. Two
 * things stand between a registration under a trustworthy name and other people's tokens:
 * the approval page, which shows the user the address the code goes to, and this list.
 *
 * The list always applies to the pre-registered client. For dynamically registered clients
 * it applies in strict mode only: by default any https callback is accepted, so that an MCP
 * client of any vendor can sign in without the operator knowing its callback in advance.
 */
import { validateRedirectUri } from '@arc-mcp/xsuaa-auth';

/**
 * Callbacks of the MCP clients this server is used with, known without configuration.
 *
 * Loopback is allowed by pattern (RFC 8252 section 7.3): a code sent there never leaves the
 * user's machine, and native clients pick a free port at runtime. Every other entry is one
 * exact callback or a prefix owned by a single vendor. No entry carries a wildcard in the host:
 * a pattern over a shared platform domain would admit every application hosted there.
 */
export const DEFAULT_REDIRECT_URIS: readonly string[] = [
  'http://localhost:*/**',
  'http://localhost/**',
  'http://127.0.0.1:*/**',
  'http://127.0.0.1/**',
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://vscode.dev/redirect',
  'vscode://vscode.microsoft-authentication/**',
  'cursor://anysphere.cursor-retrieval/**',
  'cursor://anysphere.cursor-mcp/**',
  'https://global.consent.azure-apim.net/redirect/**',
  'https://callback.mistral.ai/v1/integrations_auth/oauth2_callback',
];

/**
 * Whether dynamic registration is limited to the list (BW_OAUTH_REDIRECT_STRICT=on).
 * Anything but on or off stops the start, since a typo must not leave the mode undecided.
 */
export function redirectStrictFromEnv(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.BW_OAUTH_REDIRECT_STRICT ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'off') return false;
  if (raw === 'on') return true;
  throw new Error(`BW_OAUTH_REDIRECT_STRICT must be "on" or "off", not "${env.BW_OAUTH_REDIRECT_STRICT}".`);
}

const HOST_WILDCARD = /^[a-z][a-z0-9+.-]*:\/\/[^/]*\*/i;

/**
 * The built-in callbacks plus the ones named in BW_OAUTH_REDIRECT_URIS (comma-separated).
 *
 * An entry that could never be a safe target throws, so a mistake stops the start instead of
 * failing every sign-in later, or worse, quietly widening the list.
 */
export function redirectAllowlistFromEnv(env: NodeJS.ProcessEnv): string[] {
  const extra = (env.BW_OAUTH_REDIRECT_URIS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const uri of extra) {
    if (HOST_WILDCARD.test(uri)) {
      throw new Error(
        `BW_OAUTH_REDIRECT_URIS: '${uri}' has a wildcard in the host. Name the host exactly; ` +
          '"*" and "**" are allowed in the path only.',
      );
    }
    try {
      validateRedirectUri(uri.replace(/\*+/g, 'x'), [uri]);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`BW_OAUTH_REDIRECT_URIS: '${uri}' is not usable as a redirect URI. ${reason}`);
    }
  }

  return [...DEFAULT_REDIRECT_URIS, ...extra];
}
