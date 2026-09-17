# Central Hosting Setup Guide — SAP BTP Cloud Foundry

This is a **step-by-step walkthrough** for hosting the BW Modeling MCP server centrally on
SAP Business Technology Platform (BTP), so a whole team can share one deployment behind
OAuth instead of everyone running it locally. Follow it top to bottom the first time.

It is the practical companion to [`CLOUD-FOUNDRY.md`](./CLOUD-FOUNDRY.md), which is the
**reference** for the two authentication topologies, principal propagation internals,
environment variables, and troubleshooting. This guide points there whenever you need that
depth; it does not repeat it.

> Local use is unaffected. The stdio server (`npm start`, `node dist/stdio.js` /
> `node dist/index.js`) keeps working with no BTP, no OAuth, and no destination. Central
> hosting is additive.

---

## What you are building

```
  Claude / MCP client
        │  HTTPS + OAuth (XSUAA)
        ▼
  bw-modeling-mcp  (Cloud Foundry app, HTTP transport)
        │  BTP Destination service
        ▼
  Cloud Connector  (in the customer network)
        │  HTTPS
        ▼
  SAP BW/4HANA  (on-premise ABAP system)
```

- The **Cloud Connector** is the secure tunnel between BTP and the on-premise BW system.
- The **Destination** tells the app how to reach BW through that tunnel.
- **XSUAA** provides login and role-based access (Reader vs. Developer).
- The app itself is stateless; identity arrives with each request.

Two authentication topologies are possible — start with the simpler one:

| | **Shared technical user** (Stage 1) | **Principal propagation** (Stage 2) |
|---|---|---|
| Destination auth | `BasicAuthentication` | `PrincipalPropagation` |
| BW sees | one technical user for everyone | each caller as themselves |
| Extra setup | none beyond the destination | Cloud Connector certificates + ABAP CERTRULE/ICM trust |

**Get Stage 1 working end to end first** (Steps 1–9), then switch on principal propagation
with [Stage 2](#stage-2--principal-propagation-per-user-identity) below. This guide now
covers **both** stages in full; [`CLOUD-FOUNDRY.md`](./CLOUD-FOUNDRY.md) remains the
reference for the internals and environment variables.

---

## Prerequisites

- [ ] An SAP BTP **subaccount** with **Cloud Foundry** enabled (org + space created).
- [ ] BTP entitlements/quota for the services: **Authorization & Trust Management (XSUAA)**,
      **Destination**, and **Connectivity**.
- [ ] Admin rights in the subaccount to create destinations and assign role collections.
- [ ] A reachable **SAP BW/4HANA** system and a **Cloud Connector** you may configure.
- [ ] A **technical BW user** (for Stage 1) with the authorizations the team needs.
- [ ] Local tooling: **Node.js** (LTS), the **Cloud Foundry CLI** (`cf`), and the
      **BTP CLI** (`btp`). Install steps are in [Step 3](#step-3--install-and-log-in-with-the-cli).
- [ ] A clone of this repository.

---

## Step 1 — Connect the Cloud Connector to BW/4HANA

The Cloud Connector runs inside the customer network and exposes selected BW endpoints to
the BTP subaccount.

1. Install the **SAP Cloud Connector** on a host that can reach the BW system, and open its
   admin UI (`https://<host>:8443`).
2. **Connect it to the subaccount**: add your BTP subaccount (region host, subaccount ID,
   and a subaccount user/token). After this the subaccount shows the connector as
   *connected* under **Connectivity → Cloud Connectors** in the BTP Cockpit.
3. **Add a mapping** under **Cloud To On-Premise**:
   - Back-end type: **ABAP System**.
   - Protocol: **HTTPS** (the connector reaches BW over HTTPS).
   - Internal host/port: the BW system's host and HTTPS port (e.g. `44300`).
   - Virtual host/port: a name the destination will use (e.g. `bw4.virtual:44300`).
4. **Expose the resources** the MCP server needs — this is a separate action from the
   mapping and is easily missed. Add each of these with **Path and all sub-paths**:
   - `/sap/bw/modeling`
   - `/sap/bw4`
   - `/sap/bc/http/sap/bw4`
   - `/sap/opu/odata/sap`
5. Check the mapping status is green (**Reachable**).

> For principal propagation (Stage 2) the Cloud Connector needs additional certificate
> configuration — see [`CLOUD-FOUNDRY.md` §3](./CLOUD-FOUNDRY.md#3-principal-propagation).

---

## Step 2 — Create the HTTP destination in the BTP Cockpit

In the BTP Cockpit, open your **subaccount → Connectivity → Destinations → New Destination**
and create an `HTTP` destination pointing at BW through the Cloud Connector.

| Property | Value (Stage 1 — shared user) |
|---|---|
| `Name` | e.g. `BW4_PROD` — must match `BW_BTP_DESTINATION` in `manifest.yml` |
| `Type` | `HTTP` |
| `URL` | `http://<virtual-host>:<port>` — **`http://`, not `https://` (see the trap below)** |
| `Proxy Type` | `OnPremise` |
| `Authentication` | `BasicAuthentication` |
| `User` / `Password` | the technical BW user |
| `CloudConnectorLocationId` | only if several connectors serve this subaccount |

> **⚠️ The `https://` trap.** The destination URL must use **`http://`** even though the
> Cloud Connector reaches BW over HTTPS. An `https://` destination makes the cloud HTTP
> client tunnel with `CONNECT`, which drops the proxy and identity headers, and BW answers
> with a misleading `405`. This is explained in
> [`CLOUD-FOUNDRY.md` §4](./CLOUD-FOUNDRY.md#4-the-destination).

Save, then use **Check Connection** — expect a `200`/`302` reachability result (a `401` here
can be normal depending on the pinged path; the real test is Step 9).

For principal propagation, set `Authentication = PrincipalPropagation` instead and follow
[`CLOUD-FOUNDRY.md` §3–§4](./CLOUD-FOUNDRY.md#3-principal-propagation).

---

## Step 3 — Install and log in with the CLI

1. Install the **Cloud Foundry CLI** (`cf`) and the **BTP CLI** (`btp`) for your OS from SAP's
   download pages, and confirm they run:
   ```bash
   cf version
   btp --version
   ```
2. Log in to Cloud Foundry and target your org and space:
   ```bash
   cf login   # enter the CF API endpoint, credentials, then pick org + space
   cf target  # verify org and space are set
   ```

> On Windows, after installing the CF CLI you may need a new terminal so `C:\Program Files\Cloud Foundry`
> is on `PATH`.

---

## Step 4 — Create the backing services

From the repository root, create the three BTP service instances the app binds to. The
XSUAA instance is configured from the repo's `xs-security.json` (scopes and role
collections).

```bash
cf create-service xsuaa        application bwmcp-xsuaa       -c xs-security.json
cf create-service destination  lite        bwmcp-destination
cf create-service connectivity lite        bwmcp-connectivity   # on-premise BW only
```

These names match the `services:` list in `manifest.yml`. If you rename a service, update
the manifest to match.

---

## Step 5 — Configure `manifest.yml`

Edit `manifest.yml` so the app knows which destination and client to use:

```yaml
env:
  BW_BTP_DESTINATION: "BW4_PROD"   # must equal the destination name from Step 2
  BW_CLIENT: "100"                 # your BW client
  BW_LANGUAGE: "DE"
  # BW_PP_ENABLED: "true"          # uncomment for principal propagation (Stage 2)
```

Full variable reference: [`CLOUD-FOUNDRY.md` → Environment variables](./CLOUD-FOUNDRY.md#environment-variables).

---

## Step 6 — Build and push the application

Only the compiled `dist/` ships — `.cfignore` excludes `src/`, tests, and docs.

```bash
npm ci && npm run build
cf push          # reads manifest.yml
```

Watch the output until the app reaches **running**. `cf push` also binds the services
listed in the manifest.

Note the app **route** (e.g. `https://bw-modeling-mcp.cfapps.<region>.hana.ondemand.com`).
The MCP endpoint is that route plus `/mcp`.

---

## Step 7 — Assign roles to users

Two role collections ship in `xs-security.json`:

| Collection | Grants |
|---|---|
| **BW MCP Reader** | everything that only reads, query data included |
| **BW MCP Analyst** | reporting only — a 14-tool client for business users |
| **BW MCP Developer** | all tools, including create/change/delete/activate |

Assign a collection to each user — in the BTP Cockpit (**Security → Users → Role Collection
Assignment**) or via the CLI:

```bash
btp assign security/role-collection "BW MCP Developer" --to-user <email> --of-idp <idp>
```

> **Use the identity provider the app actually logs in through.** On a subaccount with a
> custom IAS tenant that is `sap.custom`, not `sap.default`. The wrong one fails at login
> with `invalid_scope` and no other clue.

Readers do not merely get errors from write tools — those tools are filtered out of the
tool list entirely. See [`CLOUD-FOUNDRY.md` §1](./CLOUD-FOUNDRY.md#1-roles).

---

## Step 8 — Restart the app on BTP

Configuration changes (manifest env, new service bindings, role changes that affect the
running instance) take effect after a restart:

```bash
cf restart bw-modeling-mcp
```

Use `cf restage bw-modeling-mcp` instead if you changed buildpack-level settings.

---

## Step 9 — Connect an MCP client and verify

1. **Health check** (no BW, no auth):
   ```bash
   curl https://<app-route>/health
   ```
   Expect a healthy response.
2. **Point an MCP client at `https://<app-route>/mcp`.** OAuth is discoverable, so that URL
   is all the client needs — it finds the authorization server, registers itself, and sends
   the user through the normal browser login.
3. On the **first** real call, expect a one-time delay (~70 s) while BW initializes its ICF
   handlers; it is sub-second afterwards. The `/health` endpoint never touches BW.

If something fails, the [`CLOUD-FOUNDRY.md` §5 troubleshooting table](./CLOUD-FOUNDRY.md#5-troubleshooting)
maps the common symptoms (`502`, `401` + basic-auth popup, `403 expose the resource`,
`invalid_scope`) to their causes.

---

## Stage 2 — Principal propagation (per-user identity)

With Stage 1 the whole team reaches BW as **one shared technical user**. With principal
propagation each caller reaches BW **as themselves**, and BW applies their own
authorizations. This is opt-in because it needs certificate setup on the Cloud Connector
**and** on the ABAP side.

### How the identity travels

```
  BTP login (XSUAA)               user_name claim  ── often the e-mail address
        │
        ▼
  App builds a per-user BW client (fails closed — never falls back to a shared user)
        │  Destination service + Connectivity service
        ▼
  Cloud Connector
        │  • authenticates itself to BW with its OWN system certificate (client TLS)
        │  • forwards a short-lived USER certificate  CN=<user_name>  in an SSL header
        ▼
  BW/4HANA ICM
        │  1. trusts the CC system cert   (STRUST, SSL Server Standard)
        │  2. trusts the CC as a reverse proxy   (icm/trusted_reverse_proxy)
        │  3. maps the forwarded user cert → an ABAP user   (CERTRULE)
        ▼
  BW request runs as the individual user
```

The single most important thing to understand: the Cloud Connector acts as a **trusted
reverse proxy**. It does **not** present the user certificate as the TLS client certificate;
it presents **its own** system certificate and *forwards* the user certificate in an HTTP
header. BW therefore has to trust **two** certificates — the CC's system certificate (so it
accepts the connection) and, through it, the forwarded user certificate.

> Values in angle brackets below are placeholders — read the real ones from your own Cloud
> Connector and certificates. Keep a note of the CC **system certificate's** Subject and
> Issuer DN; you need them verbatim in the last step.

### PP-1 — Cloud Connector: certificates and principal propagation

In the Cloud Connector admin UI, under **Configuration → On Premise**:

1. **CA certificate** — the CA that signs the short-lived per-user certificates. Create a
   self-signed one (*Create and import a self-signed certificate*) or import your own. Note
   its Subject DN (e.g. `CN=<your-ca>`).
2. **System certificate** — the certificate the connector uses to identify **itself** to
   the backend. It must exist for principal propagation to work. If self-signed, it must
   **not** contain Subject Alternative Names. Note its Subject and Issuer DN
   (`CN=<cc-system-cert>`) — you need them in PP-6.
3. Under **Principal Propagation → Subject Pattern Rules**, define how the user certificate's
   subject is built, e.g. `CN=${name}`. `${name}` resolves to the caller's `user_name` from
   the BTP token — on many identity providers this is the **e-mail address**. This decides
   what CERTRULE has to map in PP-5.

Then edit the **Cloud To On-Premise** system mapping for the BW host and set:

- **Principal Type: `X.509 Certificate`**
- **System Certificate for Logon: enabled**

### PP-2 — Switch the app and destination to principal propagation

1. In `manifest.yml`, enable the flag:
   ```yaml
   env:
     BW_PP_ENABLED: "true"
   ```
2. In the BTP Cockpit, change the destination's **`Authentication`** from
   `BasicAuthentication` to **`PrincipalPropagation`** (User/Password fall away; keep
   `Type=HTTP`, `ProxyType=OnPremise`, and the **`http://`** URL).
3. Redeploy and restart:
   ```bash
   cf push
   ```
4. Confirm the running app is in PP mode — the health endpoint reports it:
   ```bash
   curl https://<app-route>/health      # → {"principalPropagation":true, ...}
   ```

### PP-3 — STRUST: trust the certificates (SSL **Server** Standard)

Transaction **STRUST**, PSE **SSL Server Standard** (`SAPSSLS.pse`) — **not** SSL Client.
Import **both** certificates into the certificate list and save the PSE:

1. the **CA certificate** from PP-1 (`CN=<your-ca>`) — lets BW validate the forwarded
   per-user certificates, and
2. the Cloud Connector **system certificate** (`CN=<cc-system-cert>`) — lets BW accept the
   connector's own TLS client certificate.

> **⚠️ Trap — wrong PSE.** For *inbound* principal propagation BW acts as the TLS **server**,
> so the trust must live in **SSL Server Standard**. Importing into SSL Client has no effect
> and the connection stays anonymous.

An ICM restart (PP-7) reloads the PSE, so the imports take effect together with the
parameters.

### PP-4 — Enable rule-based certificate mapping

Transaction **RZ11**, parameter **`login/certificate_mapping_rulebased`**:

- It must be **`1`**. **Do not assume the default** — on some systems it is `0`, which
  silently disables all CERTRULE mapping.
- Set it live in RZ11 for testing, and persist it in **RZ10** (default profile, since it is
  a system-wide login parameter).

Also confirm **`icm/HTTPS/verify_client`** is **`1`** (the server must ask for a client
certificate; usually the kernel default). Equivalent: `VCLIENT=1` on the HTTPS
`icm/server_port_<n>`.

### PP-5 — CERTRULE: map the certificate to an ABAP user

Transaction **CERTRULE** (rule-based; nothing is stored in a file, despite the name). In
change mode, upload a **sample** user certificate (one issued by your CA, subject like the
Subject Pattern from PP-1) and create **one generic rule**:

| Field | Value |
|---|---|
| Certificate entry | `Subject` |
| Certificate attribute | `CN` |
| Issuer filter | `CN=<your-ca>` |
| Subject / owner filter | `CN=*` (one rule for everyone from this CA) |
| **Login as** | the attribute that matches what actually arrives in the CN |

**„Login as" is the crux.** It must match what the Subject Pattern (PP-1) puts into the
certificate CN:

- If the CN carries the **e-mail address** (common when `user_name` = e-mail), set
  **Login as = E-mail**, and make sure every relevant ABAP user has that **e-mail maintained
  in SU01** (Address tab). BW then finds the user by e-mail.
- If the CN already carries the **ABAP user name**, use **Login as = User name**.

Save the rule. The green/red assignment status is checked against the uploaded sample
certificate — if the sample's CN does not correspond to a real user it may stay red; that is
not necessarily an error. The real test is PP-8.

### PP-6 — Trust the Cloud Connector as a reverse proxy

This is the step that is easiest to get wrong. BW must be told that the intermediary (the
Cloud Connector) is allowed to forward certificates. On **kernel 753 and newer** use
`icm/trusted_reverse_proxy_<n>` (**not** the older `icm/HTTPS/trust_client_with_*`):

```
icm/trusted_reverse_proxy_0 = SUBJECT="CN=<cc-system-cert>", ISSUER="CN=<cc-system-cert>"
```

- Subject and Issuer must match the Cloud Connector **system certificate** (PP-1) **exactly**
  — a stray or missing space makes the match fail silently.
- For a self-signed CC system certificate, Subject and Issuer are identical.

> **⚠️ Trap — this parameter will not activate from RZ10 alone.** It is a special ICM
> parameter that must be set **dynamically in SMICM**: *Goto → Parameters → Change*, enter
> the value, then **Save changes locally**. A plain RZ10 entry plus an ICM soft-restart
> leaves it `<not set>`. Keep the RZ10 entry as well so it survives a full restart, but the
> dynamic SMICM change is what makes it take effect now.

### PP-7 — Restart the ICM

**SMICM → Administration → ICM → Soft exit → Local.** This reloads the SSL Server PSE (PP-3)
and the profile. The `icm/trusted_reverse_proxy` dynamic change from PP-6 is effective
immediately without any restart.

### PP-8 — Verify, and how to read the ICM trace

Call a read tool from the MCP client (e.g. list source systems). Success = data instead of
`401`. Because the server fails closed (PP client only, no shared fallback), a successful
call **proves** the request ran as the individual user.

If it still returns `401`, the ICM trace tells you exactly which link is missing. In
**SMICM** set **Trace level 3** + **HTTP Trace Info** + **Reset trace file**, reproduce the
call, then read **Goto → Trace file → Display end**. Map what you see:

| Trace line | Meaning | Fix |
|---|---|---|
| `TLSv1.2 connection with anonymous client` / `received via HTTPS without certificate` | CC did not present its system cert | CC system cert missing/ untrusted → PP-1, PP-3 |
| `Trusted certificate: CN=<cc-system-cert>` | BW trusts the CC on TLS level | PP-3 worked |
| `Forwarded Client certificate: subject="CN=<user>", issuer="CN=<your-ca>"` | user cert arrived | PP-1 Subject Pattern worked |
| `HttpCertIsReverseProxyTrustworthy: no trust relationship … / intermediary is NOT trusted` | reverse-proxy trust missing | PP-6 (set it in **SMICM**, check spacing) |
| `Reject untrusted forwarded certificate (received via HTTPS with untrusted certificate)` | CC cert present but not a trusted reverse proxy | PP-6 |
| CERTRULE finds no user | mapping/attribute mismatch | PP-5 (Login as / SU01 e-mail) |

Once done, **turn the trace back down** (SMICM → Trace level → `1`, HTTP Trace Info off) —
level 3 is heavy on a production system.

Reference for the internals: [`CLOUD-FOUNDRY.md` §3](./CLOUD-FOUNDRY.md#3-principal-propagation).
The canonical SAP note for the reverse-proxy trust errors is KBA **3017609** (with **3317663**
on the CC system certificate and **3452851** for the step-by-step).

---

## Going further

- **Principal propagation (per-user identity):** [`CLOUD-FOUNDRY.md` §3](./CLOUD-FOUNDRY.md#3-principal-propagation)
- **Destination details and the `https://` trap:** [`CLOUD-FOUNDRY.md` §4](./CLOUD-FOUNDRY.md#4-the-destination)
- **Troubleshooting:** [`CLOUD-FOUNDRY.md` §5](./CLOUD-FOUNDRY.md#5-troubleshooting)
- **Environment variables:** [`CLOUD-FOUNDRY.md` → Environment variables](./CLOUD-FOUNDRY.md#environment-variables)
