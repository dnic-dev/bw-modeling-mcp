# Running on SAP BTP Cloud Foundry

The stdio server is single-user: whoever runs it supplies `BW_USER` / `BW_PASSWORD`, and
that is the identity BW sees. This guide covers the HTTP transport, which serves several
users over the network with OAuth at the front and a BTP destination at the back.

Nothing here changes stdio. `npm start` behaves exactly as before.

> **Setting this up for the first time?** Follow the step-by-step
> [Central Hosting Setup Guide](./CENTRAL-HOSTING-SETUP.md) — Cloud Connector, destination,
> CLI, push, roles, restart — and come back here for the topology, principal-propagation,
> and troubleshooting reference.

## Two topologies

Pick by how you configure the BTP destination:

| | **Shared technical user** | **Principal propagation** |
|---|---|---|
| Destination | `Authentication=BasicAuthentication` | `Authentication=PrincipalPropagation` |
| Env | — | `BW_PP_ENABLED=true` |
| BW sees | the destination's user, for everyone | each caller as themselves |
| Per-user control | MCP scopes only | MCP scopes **and** the user's own BW authorizations |
| Setup effort | destination only | Cloud Connector certificates + ABAP CERTRULE + ICM trust |

Start with the shared user to get the deployment working, then switch on principal
propagation. Both use the same image and the same role collections.

## 1. Roles

Two role collections ship in `xs-security.json`:

| Collection | Scope | Gets |
|---|---|---|
| **BW MCP Reader** | `read` | the 41 read tools |
| **BW MCP Developer** | `read` + `write` | all 83 |

A reader does not merely get errors from the write tools — they are filtered out of
`tools/list`, so the model never proposes a call that will be denied.

The split follows the HTTP verb each tool actually uses, not its name: `bw_query_data`
and `bw_preview_datasource` issue POSTs but only read, while `bw_unlock` sounds harmless
and mutates lock state. Anything not on the read list requires `write`, so a tool added
later is unavailable to readers until it is classified.

Under principal propagation the scope is only the first gate — BW still applies the
caller's own authorizations. Under a shared technical user the scope is the *only*
per-user control, which is worth weighing when handing out **BW MCP Developer**.

## 2. Deploy

```bash
cf create-service xsuaa        application bwmcp-xsuaa -c xs-security.json
cf create-service destination  lite        bwmcp-destination
cf create-service connectivity lite        bwmcp-connectivity   # on-premise BW only

npm ci && npm run build      # dist/ is what ships; .cfignore excludes src/
cf push                      # set BW_BTP_DESTINATION and BW_CLIENT in manifest.yml first
```

```bash
btp assign security/role-collection "BW MCP Developer" --to-user <email> --of-idp <idp>
```

Use the identity provider the application actually logs in through — on a subaccount with
a custom IAS tenant that is `sap.custom`, not `sap.default`. The wrong one fails with
`invalid_scope` and no other clue.

Point an MCP client at `https://<app-route>/mcp`. OAuth is discoverable, so that URL is
all a client needs: it finds the authorization server, registers itself, and sends the
user through the normal browser login.

## 3. Principal propagation

Only needed for per-user identity. The chain:

```
MCP client --XSUAA JWT--> this app --X-User-Token--> Destination service
   --SAP-Connectivity-Authentication--> Cloud Connector
   --short-lived X.509 in SSL_CLIENT_CERT--> BW  --CERTRULE--> ABAP user
```

**Cloud Connector**

1. **System certificate** — the connector's own TLS identity. Self-signed ones must have
   no Subject Alternative Names.
2. **CA certificate** — signs the per-user certificates; needs the `keyCertSign` usage.
   *A different certificate from the system one.* Configuring only the latter gives
   `IllegalStateException: No CA certificate available`.
3. **Principal Propagation** → subject pattern, e.g. `CN=${login_name}`, then
   **Generate Sample Certificate** — CERTRULE needs that file.
4. **Backend Trust Store** → add the CA of BW's own server certificate.
5. **Cloud to On-Premises → Principal Propagation → Synchronize**, and mark the identity
   provider **Trusted**. That list is empty by default.
6. **Access control entry**: Protocol HTTPS, *Allow Principal Propagation* ✓, Principal
   Type **X.509 Certificate**.
7. **Expose the resources** — a step separate from the system mapping, and easily missed:
   `/sap/bw/modeling`, `/sap/bw4`, `/sap/bc/http/sap/bw4`, `/sap/opu/odata/sap`, each with
   *Path and all sub-paths*. A mapping created earlier for ADT exposes only `/sap/bc/adt`.

**ABAP**

8. **STRUST** → SSL server Standard → import the **issuer** of the system certificate.
9. `icm/trusted_reverse_proxy_<x> = SUBJECT="<subj>", ISSUER="<iss>"` — uppercase
   keywords; below kernel 7.53 the DN needs a blank after each comma even though the
   connector UI shows none. The older `icm/HTTPS/trust_client_with_issuer` /
   `..._with_subject` pair is for kernel ≤ 7.42, and **setting both variants means both
   are ignored** (SAP Note 2052899) — a silent, total loss of trust.
10. `icm/HTTPS/verify_client = 1`; the per-port `VCLIENT=` overrides it, and `VCLIENT=0`
    breaks propagation.
11. `login/certificate_mapping_rulebased = 1`, after migrating any USREXTID entries with
    `CERTRULE_MIG`.
12. **CERTRULE** → import the sample certificate, create the rule. It is
    **client-dependent**. Map to **Alias** or **E-Mail**, never **User Name** — ABAP user
    names are 12 characters and BTP identities are email addresses.
13. **SICF** → the BW paths must allow *Logon Through SSL Certificate*.
14. **SMICM** → Administration → ICM → Exit Hard → Global.

SNC is not involved — that is the RFC propagation path, not HTTPS.

## 4. The destination

| Property | Value |
|---|---|
| `Type` | `HTTP` |
| `URL` | `http://<cc-virtual-host>:<port>` for on-premise — **`http://`, see below** |
| `ProxyType` | `OnPremise` (via Cloud Connector) or `Internet` |
| `Authentication` | `PrincipalPropagation` or `BasicAuthentication` |
| `CloudConnectorLocationId` | only if several connectors serve the subaccount |

> **The `https://` trap.** SAP: *"the call from the cloud application must always use
> HTTP. If HTTPS is used, a 405 response will be returned."* An `https://` destination
> also makes the HTTP client tunnel with `CONNECT`, which drops the proxy and identity
> headers before the proxy sees them — so the 405 says nothing about the real cause. The
> Cloud Connector still reaches BW over HTTPS. The server rejects this configuration up
> front rather than letting you debug the 405.

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `502 Could not connect to BW` | destination lookup or propagation failed | the message says which; check the destination name and binding |
| 401 + basic-auth popup; ICM trace `intermediary is NOT trusted` | ICM stripped `SSL_CLIENT_CERT` | step 9 — missing, mistyped, lowercase keyword, wrong spacing, or both variants set |
| `403 Access denied to resource … expose the resource correctly in your cloud connector` | path not exposed | step 7 — a Cloud Connector message, not an authorization failure |
| `invalid_scope` at login | role collection assigned under the wrong identity provider | re-assign with the right `--of-idp` |
| First call takes ~70 s | BW initializes each ICF handler on first use | expected; sub-second afterwards. `/health` does not touch BW |

Traces: SMICM → Goto → Trace → Level 2; Cloud Connector loggers to All/Debug. SAP guides:
KBA **3361376259** (propagation over HTTPS), **3367280** (401 / credential popup),
**3371621** (common ICM parameter mistakes).

## Environment variables

| Variable | Meaning |
|---|---|
| `BW_BTP_DESTINATION` | destination name (required for HTTP) |
| `BW_PP_ENABLED` | `true` to use principal propagation |
| `BW_CLIENT`, `BW_LANGUAGE` | as for stdio |
| `BW_CC_LOCATION_ID` | Cloud Connector location id, when several are connected |
| `BW_PUBLIC_URL` | advertised URL behind a reverse proxy |
| `BW_ALLOWED_ORIGINS` | CORS allowlist for browser-based MCP clients |
| `BW_MCP_SERVER_NAME` | server name in the MCP handshake (default `bw-modeling-mcp`); make it unique per instance |
| `BW_MCP_SYSTEM_LABEL` | free-text system label (e.g. `AP4 (BW production, read-only)`) shown at the top of the server instructions |

With `BW_PP_ENABLED=true` the server refuses to start if `BW_USER`, `BW_PASSWORD` or
`BW_COOKIE_FILE` is also set: BW ties a session to whoever opened it, so one leftover
shared credential would silently override every per-user identity.
