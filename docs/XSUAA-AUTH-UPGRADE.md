## XSUAA OAuth upgrade to 1.2.0

This update addresses [GHSA-6935-r3wv-f646](https://github.com/arc-mcp/arc-1/security/advisories/GHSA-6935-r3wv-f646)
by using `@arc-mcp/xsuaa-auth` 1.2.0. A new authorization flow displays **Approve and continue**
or **Deny** before XSUAA sign-in, including when an SSO session already exists. Read the client
name and return address before approving. An ordinary MCP reconnect or token refresh does not
start a new authorization flow; a client that restarts authorization will show approval again.

Upgrade **all replicas**, restart any sign-in already in progress, and use Node.js 22 or later.
Keep the public OAuth URL on one canonical origin; approval cookies and the callback must reach
that origin. The update does not revoke previously issued access or refresh tokens. If exposure
is suspected, follow your identity provider's session/token revocation procedures separately.

XSUAA's `oauth2-configuration.redirect-uris` must contain only this server's exact
`https://<your-app-route>/oauth/callback` address (and explicitly needed development callbacks).
MCP client return addresses belong to the proxy's client-registration policy, not XSUAA's list.
Do not add wildcard CF domains or client URLs to XSUAA to resolve a sign-in error.

For `cf push` or an existing XSUAA service, copy `xs-security.json` to a deployment-specific
file, replace the localhost example with your exact public callback, then run
`cf update-service <your-xsuaa-instance> -c <deployment-security.json>` (or `cf create-service`
for a new instance). Preserve your existing scopes, role templates and `xsappname`. Wait for
the service update to finish before testing sign-in. The checked-in localhost URI is only
a local-development example; change its port explicitly if needed.

### Before completing a production rollout

In a non-production deployment, register a client, try Deny, then approve with an existing
SSO session. Complete token exchange and reconnect/refresh from the MCP client. Confirm the
expected tool list and role restrictions; do not perform writes just to test authentication.
Local regression tests cover synthetic HTTP sign-in without contacting SAP. Real XSUAA/IAS
tenants, custom routing and provider session behavior still need an operator smoke check.
