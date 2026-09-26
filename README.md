# bw-modeling-mcp

A Model Context Protocol (MCP) server that enables AI assistants like Claude to work directly inside SAP BW/4HANA or SAP BW 7.5 on HANA systems — reading, creating and modifying BW modeling objects via the same internal SAP APIs that Eclipse BWMT and the BW/4HANA Cockpit use: the **BW Modeling REST API** (`/sap/bw/modeling/`) for objects, queries and live data, the **ADT API** (`/sap/bc/adt/`) for the ABAP and AMDP routines BW generates, the **BW/4HANA manage API** for the request monitor and runtime, and the **Push API** (`/sap/bw4/`) for data loads.

**This is not a simulation.** Every tool call connects to a live BW system — write operations produce real changes.

---

## ☁️ Running on SAP BTP Cloud Foundry

![Central MCP server for AI-assisted SAP BW modeling: MCP-capable AI clients connect via OAuth to bw-modeling-mcp, whose analyst, reader and developer roles reach on-premise, private cloud and BW Bridge systems via principal propagation](docs/btp-hosting.png)

Besides stdio, the server can run as an HTTP service on SAP BTP Cloud Foundry with XSUAA
OAuth in front and a BTP destination behind — either a shared technical user
(`BasicAuthentication`) or **principal propagation**, where each caller reaches BW as
themselves and BW applies their own authorizations.

Three role collections decide what a user is offered: **BW MCP Reader** (everything that only reads), **BW MCP Analyst** (a small reporting client — run queries and understand what they return) and **BW MCP Developer** (everything, including changes).
stdio is unchanged — `npm start` behaves exactly as before. Setup:
[docs/CENTRAL-HOSTING-SETUP.md](docs/CENTRAL-HOSTING-SETUP.md) (step-by-step) and
[docs/CLOUD-FOUNDRY.md](docs/CLOUD-FOUNDRY.md) (reference).

### What central hosting changes

| Scenario | stdio only | Hosted on BTP |
|---|---|---|
| **One analyst, one BW system** | runs on the analyst's machine | server-side, the analyst logs in with their own identity |
| **Several analysts, one server** | not possible, no central auth | all log in via BTP, each caller's identity reaches BW |
| **Tool permissions** | none — whoever runs it can call every tool | granted per role, **independent of BW authorizations**: a BW developer can be read-only in the MCP, or the querying tools can be withheld from someone who may otherwise view data |
| **BW authorizations** | enforced through the user's own credentials | unchanged, still fully enforced — with principal propagation each caller acts as themselves, never as a shared identity |
| **Audit trail** | limited | XSUAA logs every login; with principal propagation the BW session log shows the real user; optionally every tool call is written to the **BTP Audit Log** (below) |

A new tool stays unavailable to read-only callers until it is explicitly classified as a
read, so the surface never widens by accident; `write` implies `read`, never the reverse.
The two role collections are a starting point and can be split further in `xs-security.json`.
Principal propagation additionally needs a certificate rule and ICM trust on the BW side.

### Optional: BTP Audit Log

Bind an `auditlog` service instance and the server records **every tool call** — caller,
tool, arguments, outcome and duration — in SAP's Audit Log, retained centrally and readable
without a BW logon. Denied calls are recorded as security events. BW's own session log still
shows what the ABAP user did; this adds who asked for it through the MCP, in one place.

Calls are categorised from the same classification that governs scopes, so a new tool is
filed correctly without touching the audit code: reads become `data-accesses`, writes
`data-modifications`, and activation/transport/package tools `configuration-changes`.

A record holds the **request**, never the response: the tool, the caller, the arguments, the
outcome and the duration — plus how much came back, as `resultChars`, `resultLines` and, for
`bw_query_data`, the `resultRows` it states above its table. Without those a call that read
one row and one that read two hundred thousand look identical. The returned data itself stays
out: it would put business data in a second store with a different set of readers, and a
result would blow the Write API's 10 KB message limit anyway.

Writes are fire-and-forget: a slow or broken audit backend never delays or fails a tool call;
failures are warned about at most once a minute.

**The premium plan is mTLS-only.** It issues no client secret, so both the instance and the
binding must be created with x509 parameters — a plain `cf create-service` plus
`cf bind-service` produces a `binding-secret` binding that can never authenticate:

```bash
cf create-service auditlog premium bwmcp-auditlog -c '{
  "xs-security": { "xsappname": "bwmcp-auditlog-<unique-per-subaccount>",
    "oauth2-configuration": { "credential-types": ["x509"], "grant-types": ["client_credentials"] } } }'

cf bind-service bw-mcp-server bwmcp-auditlog -c '{
  "xsuaa": { "credential-type": "x509",
    "x509": { "key-length": 2048, "validity": 2, "validity-type": "MONTHS" } } }'

cf restart bw-mcp-server
```

Note the nesting: the binding parameters go under `xsuaa`. The broker accepts a wrongly
shaped `-c` payload — `{"credential-type": "x509"}` at the top level, say — without
complaining, and hands out a `binding-secret` binding anyway.

The server refuses a non-x509 binding at startup, naming the missing fields, rather than
reporting auditing as enabled and then dropping every event. The broker cannot *update* an
existing instance's `xs-security`, so changing it means deleting and re-creating the instance.

**The binding certificate expires** after `validity`. When it does, writes fail and the only
signal is that warning — rotate with `cf unbind-service` + `cf bind-service` + `cf restart`
before the date, and confirm afterwards that records arrive (Audit Log Viewer, or the Audit
Log Retrieval API). Without a binding, nothing changes and auditing stays off.

---

## System Compatibility

| System | Support |
|---|---|
| SAP BW/4HANA (all versions) | ✅ Full support |
| SAP BW Bridge (SAP BTP ABAP stack) | ✅ Via cookie authentication (`BW_COOKIE_FILE`) |
| SAP BW on HANA (7.5) | ✅ Modelling reads after a small ABAP enhancement, and modelling **writes** for every object type except the InfoObject — aDSOs, InfoAreas, InfoSources, CompositeProviders, queries and their reusable components, aggregation levels. The tool surface adjusts to what the system publishes, and the objects without a REST resource — including planning, chain runs and the APD — are read from their metadata tables. `bw_system_profile` states per write tool what was verified there. See [BW 7.5 Support](bw75/BW75-SUPPORT.md) |

<p><em><sub>On SAP BW 7.5 the REST framework looks up the <code>Accept</code> header case-sensitively while the kernel delivers header names in lower case, so almost every call fails with HTTP 406. A ~20-line post-exit enhancement (no modification) resolves this and makes all REST endpoints that exist on 7.5 reachable. Objects for which BW 7.5 ships no REST resource at all — transformations, DTPs, process chains and their runs, classic DSOs, InfoCubes, the planning objects and the Analysis Process Designer — are readable through <code>bw_read_metadata_tables</code>, which goes to their metadata tables instead, but they cannot be written; Eclipse opens the embedded SAP GUI for those as well. Details, ABAP code and setup steps: <a href="bw75/BW75-SUPPORT.md">bw75/BW75-SUPPORT.md</a>.</sub></em></p>

---

## 📖 Featured Blog Posts

A two-part blog series about this project (both available in German and English):

1. **Agentic AI meets SAP BW** — the full story behind this project: why I built it, what's inside, what happens when Claude walks through a complete BW data lineage on its own.
   https://www.nextlytics.com/blog/agentic-ai-meets-sap-bw

2. **Agentic AI in practice: MCP server for SAP BW/4HANA** — how the server is operated company-wide on SAP BTP Cloud Foundry with role-based access and per-user identity, plus two real customer projects.
   https://www.nextlytics.com/blog/agentic-ai-in-practice-mcp-server-for-sap-bw/4hana

---

## 🆕 What's New — v1.6.0

Modelling on a classic **SAP BW 7.5 on HANA** system is verified in both directions — every
create and update tool was run against a 7.5 backend and read back — and the last of the
reusable query building blocks, the variable, can now be read back and corrected too.

**🏛️ Writing on BW 7.5 on HANA**

- InfoAreas, InfoObjects, aDSOs, InfoSources, CompositeProviders, queries with their
  reusable components, aggregation levels, activation, move, unlock and delete — each
  written and read back on a 7.5 system
- `bw_system_profile` names the status of every write tool on the connected system, so
  "can I model this here" is answered by the server

**🔤 Variables, read back and corrected**

- `bw_get_variable` returns what was actually stored. The modelling API accepts an enum
  literal it does not know, saves its default and still reports the object as consistent,
  so a create alone proves nothing
- `bw_update_variable` corrects one with its UID unchanged, so references from queries,
  CKFs and structures survive — the only path before was delete-and-recreate, which BW
  refuses once anything references the variable

**On BW/4HANA nothing changes** — what a classic release needs is added beside the existing
behaviour, never in place of it.

---

**Earlier releases** — the "What's New" notes for v1.5.0 and older are archived in [WHATS_NEW.md](WHATS_NEW.md); the full structured history is in [CHANGELOG.md](CHANGELOG.md).

---

## What it can do

An overview by area. Every tool in detail — parameters, behaviour, and the sequences it belongs in — is in the **[Tools Reference](TOOLS.md)** (108 tools).

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/dnic-dev/bw-modeling-mcp/main/docs/landkarte-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/dnic-dev/bw-modeling-mcp/main/docs/landkarte-light.svg">
    <img src="https://raw.githubusercontent.com/dnic-dev/bw-modeling-mcp/main/docs/landkarte-light.svg" alt="What the server can read, create and run in SAP BW, by object area, and how much of it works on classic SAP BW 7.5 on HANA" width="100%">
  </picture>
</p>

---

## Combining with an ADT MCP Server

**bw-modeling-mcp works best alongside an ADT MCP server** such as [vibing-steampunk](https://github.com/oisee/vibing-steampunk) or [ARC-1](https://github.com/arc-mcp/arc-1). The two do not overlap as much as it may look.

This server owns the BW object and, with it, the body of the ABAP that BW generated for that object: the class behind a transformation routine, the program behind a DTP filter routine. Write those through `bw_set_transformation_routine`, `bw_set_transformation_expert_routine` and `bw_set_dtp_filter_routine` rather than through ADT — they do not only replace the source, they save the transformation master back afterwards, which is what re-registers the code in the transportable metadata. A class-only edit survives until the next regeneration or transport and is then gone.

The ADT MCP server covers ABAP as a subject in its own right: your own reports, classes, function modules and DDIC tables, repository search and navigation, arbitrary table reads, debugging, ATC, unit tests, dumps and transports. Together they cover the full cycle from BW object to ABAP logic.

---

## Requirements

- SAP BW/4HANA system with the internal SAP APIs enabled (SAP BW 7.5 works for modeling reads and most modelling writes once the enhancement in [bw75/BW75-SUPPORT.md](bw75/BW75-SUPPORT.md) is in place)
- Node.js 18 or later
- An MCP-compatible AI client (Claude Desktop, Claude Code, etc.)

---

## Installation

> **Two ways to run.** Locally as a **stdio** server (one user, one machine — the steps below), or **centrally hosted** on SAP BTP Cloud Foundry behind XSUAA OAuth for a whole team → see [docs/CENTRAL-HOSTING-SETUP.md](docs/CENTRAL-HOSTING-SETUP.md). The installation and configuration below cover local stdio use; upgrading an existing local setup is non-breaking.

```bash
# Option 1: Install via npm (recommended)
npm install -g bw-modeling-mcp

# Option 2: Clone and build
git clone https://github.com/dnic-dev/bw-modeling-mcp.git
cd bw-modeling-mcp
npm install
npm run build
```

---

## Configuration

For **local (stdio)** use, the server is configured via environment variables. For **central BTP hosting**, connection and credentials come from the BTP destination and service bindings instead — see [docs/CENTRAL-HOSTING-SETUP.md](docs/CENTRAL-HOSTING-SETUP.md).

| Variable | Description | Required |
|---|---|---|
| `BW_URL` | BW system URL (e.g. `https://myhost:50001`) | yes |
| `BW_USER` | SAP user name | yes (or `BW_COOKIE_FILE`) |
| `BW_PASSWORD` | SAP password | yes (or `BW_COOKIE_FILE`) |
| `BW_CLIENT` | SAP client (e.g. `001`) | yes |
| `BW_LANGUAGE` | Language for object texts (e.g. `EN`, `DE`). Default: `DE` | no |
| `BW_COOKIE_FILE` | Path to a browser-exported cookie file for SAML-/OAuth-fronted systems (e.g. BW Bridge). Netscape or `name=value` format. When set, `BW_USER` / `BW_PASSWORD` are optional. | no |
| `BW_MCP_SERVER_NAME` | Server name advertised in the MCP `initialize` handshake. Default: `bw-modeling-mcp`. Give each instance a unique name when running several against different BW systems. | no |
| `BW_MCP_SYSTEM_LABEL` | Free-text label of the connected BW system (e.g. `AP4 (BW production, read-only)`), put at the top of the MCP server instructions. Lets a model tell look-alike instances apart even in clients that show an opaque connector id instead of the server name. | no |
| `BW_PLATFORM` | `auto` (default), `classic` or `bw4`. The server detects whether it is talking to BW/4HANA or a classic release and offers only the tools that release can answer. `classic` forces that verdict when detection cannot run, `bw4` switches the filter off. See [bw75/BW75-SUPPORT.md](bw75/BW75-SUPPORT.md). | no |

**Cookie authentication (BW Bridge / SAP BTP):** For BW systems that sit behind a SAML or OAuth login (such as BW Bridge on the SAP BTP ABAP stack), Basic Auth is not available. Export the authenticated session cookies from your browser into a file and point `BW_COOKIE_FILE` at it. The login/session approach is analogous to [vibing-steampunk](https://github.com/oisee/vibing-steampunk) and [ARC-1](https://github.com/arc-mcp/arc-1). When the session expires, refresh the cookie file and restart the server.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bw-modeling-mcp": {
      "command": "node",
      "args": ["/path/to/bw-modeling-mcp/dist/stdio.js"],
      "env": {
        "BW_URL": "https://your-bw-host:50001",
        "BW_USER": "YOUR_USER",
        "BW_PASSWORD": "YOUR_PASSWORD",
        "BW_CLIENT": "001",
        "BW_LANGUAGE": "EN"
      }
    }
  }
}
```

### Claude Code (VS Code extension)

Add `.mcp.json` to your project root:

```json
{
  "mcpServers": {
    "bw-modeling-mcp": {
      "command": "node",
      "args": ["/path/to/bw-modeling-mcp/dist/stdio.js"],
      "env": {
        "BW_URL": "https://your-bw-host:50001",
        "BW_USER": "YOUR_USER",
        "BW_PASSWORD": "YOUR_PASSWORD",
        "BW_CLIENT": "001",
        "BW_LANGUAGE": "EN"
      }
    }
  }
}
```

---

## How it works

The server talks to four SAP APIs, and only one of them needs a protocol worth describing.

**The BW Modeling REST API** (`/sap/bw/modeling/`) is a full-document API: there is no way to
change one attribute of an object. Every write therefore runs the same six steps.

1. **Lock** — acquires an exclusive lock and returns a `lockHandle`
2. **Read** — fetches the current complete XML of the object
3. **Modify** — applies the change to that XML
4. **PUT** — sends the whole document back, never a fragment
5. **Activate** — promotes the inactive version to the active one
6. **Unlock** — releases the lock

Two consequences are worth knowing. Saving and activating are separate: a document the server
accepts can still fail to activate, so a successful write proves less than it appears to. And
because the whole document travels, a read that came from a stale session buffer will silently
write old values back — the tools read fresh for exactly this reason.

The other three need none of it. The **ADT API** (`/sap/bc/adt/`) is used narrowly and always for
an object BW generated itself: the body of a transformation routine (its generated class), the
body of a DTP filter routine (its generated program), the DataPreview service behind
`bw_read_metadata_tables`, plus transport checks and activation runs. Everything else ABAP —
writing your own reports, classes or DDIC tables, searching the repository, reading arbitrary
tables, debugging — is the job of an ABAP ADT MCP server alongside this one, see
[Combining with an ADT MCP Server](#combining-with-an-adt-mcp-server). The **BW/4HANA manage API** (`/sap/bc/http/sap/bw4/`) answers the request
monitor, the remodeling monitor and runtime operations. The **Push API** (`/sap/bw4/v1/push/`)
takes a JSON record array straight into a write-interface aDSO.

Session cookies and CSRF tokens are handled for all four.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full technical architecture and the complete
endpoint reference.

---

## Roadmap

- **Tool consolidation** — collapse today's one-tool-per-operation surface into a small set of verb-based tools (`bw_read`, `bw_find`, `bw_write_*`, …) that cover the same operations. Same functionality, a single consistent `name` parameter across all reads, and each new operation then costs one enum value instead of a whole new tool — so coverage keeps growing while the surface stays within MCP clients' tool limits.
- **More modeling & Cockpit coverage** — integrate and complete further BW modeling and BW/4HANA Cockpit operations, e.g. Open ODS Views, further planning objects, additional runtime and monitoring operations, and further modeling objects.

---

## Contributing

Issues and feature requests are welcome — please use the [Issue templates](https://github.com/dnic-dev/bw-modeling-mcp/issues/new/choose).

If you have access to a BW/4HANA system and want to help expand coverage, I am happy to hear from you. The best way to contribute is to try it out and report what works, what doesn't, and what's missing.

---

## License

MIT
