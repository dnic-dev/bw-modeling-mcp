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
| SAP BW on HANA (7.5) | ✅ Modelling reads after a small ABAP enhancement; the tool surface adjusts to what the system publishes, and the objects without a REST resource — including planning, chain runs and the APD — are read from their metadata tables. See [BW 7.5 Support](docs/BW75-SUPPORT.md) |

<p><em><sub>On SAP BW 7.5 the REST framework looks up the <code>Accept</code> header case-sensitively while the kernel delivers header names in lower case, so almost every call fails with HTTP 406. A ~20-line post-exit enhancement (no modification) resolves this and makes all REST endpoints that exist on 7.5 reachable. Objects for which BW 7.5 ships no REST resource at all — transformations, DTPs, process chains and their runs, classic DSOs, InfoCubes, the planning objects and the Analysis Process Designer — are readable through <code>bw_read_metadata_tables</code>, which goes to their metadata tables instead, but they cannot be written; Eclipse opens the embedded SAP GUI for those as well. Details, ABAP code and setup steps: <a href="docs/BW75-SUPPORT.md">docs/BW75-SUPPORT.md</a>.</sub></em></p>

---

## 📖 Featured Blog Posts

A two-part blog series about this project (both available in German and English):

1. **Agentic AI meets SAP BW** — the full story behind this project: why I built it, what's inside, what happens when Claude walks through a complete BW data lineage on its own.
   https://www.nextlytics.com/blog/agentic-ai-meets-sap-bw

2. **Agentic AI in practice: MCP server for SAP BW/4HANA** — how the server is operated company-wide on SAP BTP Cloud Foundry with role-based access and per-user identity, plus two real customer projects.
   https://www.nextlytics.com/blog/agentic-ai-in-practice-mcp-server-for-sap-bw/4hana

---

## 🆕 What's New — v1.5.0

Classic SAP BW 7.5 becomes a first-class system, business users get a client of their own,
and the reusable query building blocks — calculated key figures, restricted key figures and
structures — can now be created and changed rather than only read.

**🏛️ Classic BW 7.5, properly supported**

- `tools/list` follows the platform: a tool whose resource a 7.5 does not publish is no longer offered there, and each one names the call that answers the same question instead. The platform is detected from the system's own `bw.b4hanamode` flag and its discovery document, so the system decides and not a hardcoded release list. On BW/4HANA nothing changes
- `bw_read_metadata_tables` gains the object types those hidden tools would have answered for: planning functions, sequences, characteristic relationships and data slices (`PLSE`, `PLSQ`, `PLCR`, `PLDS`), process chain runs with their steps and the process variant behind each (`RSPCLOG`), and the load history of an aDSO (`ADSO`)
- It also reads the **Analysis Process Designer** (APD, `object_type="ANPR"`) — nodes in execution order with the object each source reads and each target writes, the edges between them, filters, formulas and the ABAP of a routine node. No release ever published a REST resource for it, and BW/4HANA dropped the object type, so this is the only route to one

**👤 A client for business users**

- The new **BW MCP Analyst** role collection offers 14 tools instead of 105: run a query — or a provider directly — read the characteristic values to filter by, find what there is to ask, and understand what the numbers mean. The size is the point: a client carrying every tool reaches for the wrong one far more often
- Purely additive. `read` is unchanged and still admits everything it did, `analyst` is a strict subset of it, and a caller may hold both

**🧱 Reusable query building blocks**

- `bw_create_ckf` / `bw_update_ckf` — calculated key figures, with the formula as an operator/operand tree that `bw_get_ckf` hands back unchanged. `update` takes targeted operations, so another summand can be added to a sum without rebuilding the expression
- `bw_create_structure` / `bw_update_structure` — reusable key figure structures. A change reaches every query that embeds the structure, which is why it happens at the structure rather than through one query that uses it
- `bw_update_rkf` — a restricted key figure keeps its UID when changed, so references from CKFs, structures and queries survive. Until now the only correction was delete-and-recreate, which is impossible once the RKF is referenced anywhere

**🔑 Client compatibility (hosted instance)**

- The OAuth metadata advertises `scopes_supported`. Without it a client requests no scopes at all, and Copilot's older auth code then fails with `scope.split is not a function` (fixed upstream in vscode#325344, but the Eclipse Language Server lags behind)

**✨ Also new**

- `bw_delete_request` deletes load requests — with the data they brought in and their entry in request management
- Characteristics can be modelled for values with lower case letters or umlauts (`lower_case`), which previously failed at request activation rather than at load time
- `bw_get_request` reads the log of each process step, so a failed activation names the value and the characteristic that caused it

---

**Earlier releases** — the "What's New" notes for v1.4.1 and older are archived in [WHATS_NEW.md](WHATS_NEW.md); the full structured history is in [CHANGELOG.md](CHANGELOG.md).

---

## What it can do

An overview by area. Every tool in detail — parameters, behaviour, and the sequences it belongs in — is in the **[Tools Reference](TOOLS.md)** (105 tools).

### Search & Discovery
- Search BW objects by name or description (wildcards supported), filtered by type
- Where-used / dependency analysis (xref) for any BW object

### aDSO
- Read aDSO structure (fields, settings, version state)
- Create a new aDSO — from an aDSO template, from a DataSource (RSDS) template, or empty
- Add InfoObject-backed fields or pure (field-based) fields
- Remove fields
- Manage key fields
- Update field properties (aggregation, data type, length, etc.)
- Place fields in a field group — on creation, so a key figure lands in the key figure group without a second activation, or afterwards to move an existing field between groups
- Update aDSO settings (type preset, flags, description)
- Write-interface aDSO support (`pushMode`)

### InfoObject
- Read InfoObject definition
- Create Characteristic — all data types (CHAR, NUMC, DATS, TIMS, SNUMC), with or without master data and texts, with referenced InfoObject, with compounding parents
- Create Key Figure — all types (NUM, AMT, QTY, DAT, INT), all aggregations (SUM, MAX, MIN)
- Add and remove display and navigation attributes

### InfoArea
- Read InfoArea definition (name, label, parent area, status)
- Create a new InfoArea (immediately active, no activation step needed)
- Move any BW object to a different InfoArea

### InfoSource
- Read InfoSource structure (fields, key fields, label, InfoArea)
- Create InfoSource with full field definitions

### Transformation
- Read Transformation structure (all sources, all targets)
- Create a Transformation — including InfoObject (IOBJ) sources/targets with an explicit sub-type (text table, attributes/master data, hierarchy)
- Map source fields to target InfoObjects or plain fields (StepDirect)
- Set formula rules (StepFormula)
- Set field routines — ABAP and AMDP (StepRoutine)
- Set start routines — ABAP and AMDP
- Set end routines — ABAP and AMDP
- Set END routine target fields (explicit field list or exclusion list)
- Switch runtime between ABAP and AMDP

### DTP (Data Transfer Process)
- Read DTP structure and settings
- Create DTPs — including DataSource (RSDS) sources and InfoObject targets by sub-type (attributes, texts, hierarchies)
- Run (execute) a DTP load — returns the run request id for monitoring
- Update DTP settings and description
- Switch extraction mode between Full and Delta
- Set value filters on fields
- Set routine filters (ABAP code)

### BW Query
- Read a BW Query — metadata, variables, filter, layout, measures, exceptions, and settings
- Variables: type, processing type (UserEntry, Authorization, CustomerExit), input behavior
- Filter: fixed values and variable references fully resolved, including mixed selections
- Layout: rows, columns, free characteristics with full member lists and nested members
- Calculated key figures: recursively resolved human-readable formulas
- Restricted key figures: selection conditions (key figure + characteristic restrictions)
- Inline local measures inside structures: both formulas and selections
- Exceptions with alert levels and thresholds, cell definitions for grid layout queries
- Active version with automatic fallback to inactive
- Create a new, consistent Query (ELEM) on an InfoProvider — empty, or as a full copy of an existing query (layout, filter, variables, key figures) via `copy_from`
- Update the layout — rows, columns, structures, and free characteristics
- Update the filter — fixed values and restrictions
- Update key figures — basic key figures, references to global RKFs/CKFs, and local formula members with exception aggregation and display properties
- Build local formula members from the full BW analytic-engine operator catalog — arithmetic, percentage, data, mathematical, trigonometric, and boolean operators plus ternary `IF`; operand counts are validated before saving
- Update query settings (properties)
- Update the display and access properties of each characteristic in the layout — display of result rows, display as key/text, access type for result values, sorting, cumulation, display level, and the hierarchy assignment with its display options; in bulk across every characteristic with `"*"`
- Record query edits on a transport request for queries on a transportable package
- Delete a query
- Create characteristic variables — user entry, customer exit, authorization or replacement path; as characteristic value, hierarchy or hierarchy nodes; interval, single value, several single values or comparison operators
- Create and change **reusable calculated key figures** — the formula as an operator/operand tree that reads back unchanged, and targeted operations for editing one that already exists
- Create and change **reusable key figure structures** — the object queries embed as an axis, so one definition drives all of them; a change reaches every query that uses it
- Change a **restricted key figure** in place — the UID survives, so references from CKFs, structures and queries stay intact

### Live Data Querying
- Execute a BEx Query or preview data from any InfoProvider (aDSO, CompositeProvider) — returns a formatted result table
- Fill query variables, control axis layout (rows / columns / free), apply characteristic filters with include/exclude and range operators
- Drill into hierarchy nodes and structure members (expand / collapse by tuple index)
- Look up valid characteristic values before setting filters or variables — returns both internal and external key formats

### CompositeProvider
- Read CompositeProvider structure — view node type (Union/Join), source providers (inputs) with mapping count, all fields with dimension classification, join conditions, and temporal join details
- Create a CompositeProvider — Union or Join node with its source providers attached, or as a copy of an existing one
- Attach and detach source providers, with their target elements created as needed
- Replace the field mappings of an input, either explicitly or mapped one to one from the source
- Set and remove join conditions per input pair, with join type and cardinality
- Add and remove fields, edit root settings (description, stackable, default node, aggregation behaviour)

### Global CP Components
- Read global Calculated Key Figure (CKF) — formula recursively resolved to a human-readable string, full dependency graph of all referenced sub-components
- Read global Restricted Key Figure (RKF) — base measure, all characteristic restriction groups with field and value details
- Read global Structure — all members with Formula/Selection breakdown, referenced components, characteristic filters, optional child members
- Create a reusable Restricted Key Figure (RKF) on an InfoProvider — from a base key figure plus characteristic restrictions (built for mass creation, one per call); each value is validated against the InfoProvider and written consistent, no separate activation

### Repository Navigation
- Navigate the full BW repository tree — drill from InfoArea to type folder to object to sub-folder, mirroring the Eclipse BWMT Project Explorer; each entry returns a `children_path` for seamless drill-down

### Data Flow Navigation
- Traverse the complete structural data flow graph of any BW object — all connected sources and targets resolved recursively through Transformations, DTPs, InfoSources, aDSOs, DataSources, CompositeProviders, and InfoObjects; mirrors the Eclipse BWMT Transient Data Flow view

### DataSource Navigation & Authoring
- List all source systems connected to the BW system (ODP_SAP, ODP_CDS, ODP_BW, ODP, FILE, HANA_SDA, HANA_LOCAL)
- Recursively list all DataSources in a source system with full APCO hierarchy path
- Read full source system metadata including connection details (ODP context/destination, HANA remote source and schema)
- Read complete DataSource structure: fields with types, lengths, transfer flags, adapter configuration
- Discover remote entities (HANA views / virtual tables) exposed by a source system
- Create a DataSource from a remote entity using the server's field proposal (inactive; activate separately)
- Change the delta process of a DataSource (`deltaProperties`)
- Set the transfer flag of DataSource fields and/or the segment language field

### BW Role Management
- Read the full role hierarchy (ROLE + FOLDER structure)
- List all queries published per role
- Check which roles a specific query is assigned to
- Publish a query into a role or a specific sub-folder
- Remove a query from a role or folder
- Move a query between roles (remove from old, add to new)

### Push API
- Get JSON push schema for a write-interface aDSO
- Push JSON record arrays directly into an aDSO

### Process Chain Navigation, Authoring & Monitoring
- Read complete Process Chain definitions — all steps with type, variant, description, and last execution status
- Conditional flow semantics fully resolved: DECISION branch labels (including ABAP formula expressions), OR/AND join nodes, positive/negative/neutral edge conditions
- Automatic variant detail per step: ABAP program and selection variant, TRIGGER scheduling parameters, ADSOACT/ADSOREM aDSO targets and cleanup settings, PLSWITCHL/P target aDSO, DECISION branching formulas — all embedded inline in a single tool call
- Recursive sub-chain expansion: CHAIN-type steps reference other Process Chains — call `bw_get_process_chain` again on any referenced chain name to expand the full hierarchy
- Generic process variant reader: covers all 93 BW/4HANA process types including custom Z-types; unknown types return oDetail as raw JSON
- Create a Process Chain from a step and edge list — supported types: `DTP_LOAD`, `ADSOACT`, `ADSOREM` (DSO request cleanup), `ABAP` (execute an ABAP program, optionally with an SE38 selection variant), `CHAIN`, `DECISION`, collectors `AND` / `OR` / `XOR`
- Replace the step model of an existing chain; activate a chain
- Incrementally edit an existing chain — insert a DTP load step (optionally with its own DSO activation) or an "Execute ABAP Program" step **in series** before or after any existing step, swap one DTP load variant for another, add on-error (negative) links mirroring the existing success links
- Repair the wiring of an existing chain — add or remove a single dependency between two steps, or remove a step altogether with the gap bridged automatically
- Create a DECISION process variant for use as a branch/decision step
- Monitor execution runs: history with status and timestamps, step-level and message-level run detail, last status per chain across the entire system

### DataSource Data Preview
- Fetch a live data preview from any DataSource (RSDS) directly from the source system
- Field names resolved automatically from the DataSource structure; configurable record count (default 20)
- Rendered as a padded plain-text table with column alignment

### Open Hub Destination
- Read an Open Hub Destination (DEST): destination type, source object, DB table, InfoArea, package, and status
- Complete output field list with types, InfoObject binding, conversion routine, compounding, and key flag
- File properties for FILE-type destinations

### Integrated Planning
- Create and change Aggregation Levels on an aDSO or a CompositeProvider — over all fields of the provider or a chosen subset
- Read Aggregation Levels (ALVL) — the planning-enabled view on top of an InfoProvider; characteristics and key figures with full type and semantic detail
- Read Planning Functions (PLSE) — function type, characteristic usage roles, and parameter tree; FOX code surfaced for FORMULA functions
- Read Planning Sequences (PLSQ) — ordered step list with aggregation level, planning function, and filter references
- Read Planning Properties (PLCR) — key-date mode, maximum characteristic combinations, and save strategy for plan-enabled InfoProviders
- On a system that publishes no planning resources — every classic BW release — the same objects are read from the metadata tables with `bw_read_metadata_tables`, including the **data slices** (`PLDS`) that no release exposes over REST at all

### System Diagnostics & Classic Objects
- Profile the connected system — BW/4HANA vs classic BW, the REST endpoint groups it publishes and therefore which tool groups work on it, plus three preconditions: `Accept`-header handling, ADT DataPreview access, and whether query reporting is implemented
- Read objects the connected system publishes no REST resource for, straight from the metadata tables: transformations (including start, end, expert and field routine source code), DTPs, the classic providers — DataStore objects, InfoCubes and MultiProviders — and process chains, whose steps, variant parameters and dependencies are resolved into execution order
- Read the planning objects the same way — functions, sequences, characteristic relationships and data slices — and the **runs** of a process chain: the history of one chain, the steps of a single run with status, duration and process variant, or the last status of every chain matching a pattern
- Read an **Analysis Process Designer** process (APD) — nodes in execution order with the object each source reads and each target writes, the edges between them, filters, formulas and routine ABAP. No release publishes a REST resource for it and BW/4HANA dropped the object type, so the metadata tables are the only route on any platform
- Read the load history of an InfoCube or DataStore object — request, status, update mode, start time, user, duration, records transferred and added, and the source — which on a classic BW system is the only route to load status at all
- SAP BW 7.5 on HANA is reachable for modeling reads after a small ABAP post-exit — see [docs/BW75-SUPPORT.md](docs/BW75-SUPPORT.md)
- Adapts its own tool surface to the platform — the server detects BW/4HANA vs classic BW and offers only the tools that release can answer, so a model is never handed a call that must fail; `bw_system_profile` lists what is hidden and why

### Request Monitor & Runtime
- List load requests for a target InfoProvider — status, last process status/action, record count, timestamp, user, TSN
- Full status analysis of a single load request — header, DTP information (start/finish/duration), process step chain, and message log in one call
- Activate loaded data (DSO request activation) — move a finished load from the inbound table into the active data table + change log
- Delete load requests — with the data they brought in and their entry in request management. An activation request is rolled back instead, together with every later activation on top of it
- Monitor, diagnose and run remodeling requests — the five processing steps (`CHECK`, `SAVE`, `CONVERT`, `ACTIVATE`, `CLEANUP`) with their individual status and the application log per step, plus execute, restart, reset and reset-step. Running a rule restructures the InfoProvider and converts its data
- Uses the BW/4HANA `/sap/bc/.../bw4` manage API (the same operations as the BW/4HANA Cockpit)
- On classic BW, where that API does not exist, these tools are not offered; the load history of a provider is read with `bw_read_metadata_tables` instead, which the server names in place of every tool it hides

### General
- Search & Where-Used (xref)
- Activate BW objects (aDSO, InfoObject, Transformation, DTP, DataSource, CompositeProvider)
- Release locks without activating (discard changes)
- Delete BW objects
- Transport request assignment — add a user task (sub-request) to a workbench transport, list changeable transport requests and their tasks
- Reassign an object to a different package (Development Class) on a transport request

---

## Combining with an ADT MCP Server

**bw-modeling-mcp works best alongside an ADT MCP server** such as [vibing-steampunk](https://github.com/oisee/vibing-steampunk) or [ARC-1](https://github.com/arc-mcp/arc-1). The two do not overlap as much as it may look.

This server owns the BW object and, with it, the body of the ABAP that BW generated for that object: the class behind a transformation routine, the program behind a DTP filter routine. Write those through `bw_set_transformation_routine`, `bw_set_transformation_expert_routine` and `bw_set_dtp_filter_routine` rather than through ADT — they do not only replace the source, they save the transformation master back afterwards, which is what re-registers the code in the transportable metadata. A class-only edit survives until the next regeneration or transport and is then gone.

The ADT MCP server covers ABAP as a subject in its own right: your own reports, classes, function modules and DDIC tables, repository search and navigation, arbitrary table reads, debugging, ATC, unit tests, dumps and transports. Together they cover the full cycle from BW object to ABAP logic.

---

## Requirements

- SAP BW/4HANA system with the internal SAP APIs enabled (SAP BW 7.5 works for modeling reads once the enhancement in [docs/BW75-SUPPORT.md](docs/BW75-SUPPORT.md) is in place)
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
| `BW_PLATFORM` | `auto` (default), `classic` or `bw4`. The server detects whether it is talking to BW/4HANA or a classic release and offers only the tools that release can answer. `classic` forces that verdict when detection cannot run, `bw4` switches the filter off. See [docs/BW75-SUPPORT.md](docs/BW75-SUPPORT.md). | no |

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
