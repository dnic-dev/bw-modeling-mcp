/**
 * Where an authorization code may be sent.
 *
 * Dynamic client registration is open to anyone who can reach the server, so the redirect URI
 * a client registers is the only thing that decides who receives the code of a user who
 * approves the sign-in. Without a list, any https address is accepted, and a registration
 * under a trustworthy client name turns the consent page into a way to collect other people's
 * tokens. The list is therefore explicit, and the same one applies to the pre-registered
 * client and to dynamically registered ones.
 */
import { validateRedirectUri } from '@arc-mcp/xsuaa-auth';

/**
 * Callbacks of the MCP clients this server is used with, allowed without configuration.
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
