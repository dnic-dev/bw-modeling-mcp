# bw-modeling-mcp

A Model Context Protocol (MCP) server that enables AI assistants like Claude to work directly inside SAP BW/4HANA systems — reading, creating and modifying BW modeling objects via the same internal SAP APIs that Eclipse BWMT and the BW/4HANA Cockpit use: the **BW Modeling REST API** (`/sap/bw/modeling/`) for objects, queries and live data, the **ADT API** (`/sap/bc/adt/`) for ABAP/AMDP routine source, the **BW/4HANA manage API** for the request monitor and runtime, and the **Push API** (`/sap/bw4/`) for data loads.

**This is not a simulation.** Every tool call connects to a live BW system — write operations produce real changes.

---

## ☁️ Running on SAP BTP Cloud Foundry

![Central MCP server for AI-assisted SAP BW/4HANA modeling: MCP-capable AI clients connect via OAuth to bw-modeling-mcp with role-based access control, which reaches on-premise, private cloud and BW Bridge systems via principal propagation](docs/btp-hosting.png)

Besides stdio, the server can run as an HTTP service on SAP BTP Cloud Foundry with XSUAA
OAuth in front and a BTP destination behind — either a shared technical user
(`BasicAuthentication`) or **principal propagation**, where each caller reaches BW as
themselves and BW applies their own authorizations.

Two role collections decide what a user is offered: **BW MCP Reader** and **BW MCP Developer**.
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
| **Audit trail** | limited | XSUAA logs every login; with principal propagation the BW session log shows the real user |

A new tool stays unavailable to read-only callers until it is explicitly classified as a
read, so the surface never widens by accident; `write` implies `read`, never the reverse.
The two role collections are a starting point and can be split further in `xs-security.json`.
Principal propagation additionally needs a certificate rule and ICM trust on the BW side.

---

## 📖 Featured Blog Posts

A two-part blog series about this project (both available in German and English):

1. **Agentic AI meets SAP BW** — the full story behind this project: why I built it, what's inside, what happens when Claude walks through a complete BW data lineage on its own.
   https://www.nextlytics.com/blog/agentic-ai-meets-sap-bw

2. **Agentic AI in practice: MCP server for SAP BW/4HANA** — how the server is operated company-wide on SAP BTP Cloud Foundry with role-based access and per-user identity, plus two real customer projects.
   https://www.nextlytics.com/blog/agentic-ai-in-practice-mcp-server-for-sap-bw/4hana

---

## 🆕 What's New — v1.4.0

**🎯 SAP BW 7.5 on HANA**

Until now almost every call against a BW 7.5 system failed with HTTP 406, because the 7.5 REST framework looks the `Accept` header up case-sensitively. A small ABAP **post-exit** neutralises that — an enhancement, no modification. With it in place **every REST endpoint that exists on 7.5 is reachable**.

- **📘 [docs/BW75-SUPPORT.md](docs/BW75-SUPPORT.md)** — root cause, the ABAP code, the SE24 setup steps, and what BW 7.5 ships no REST resource for — split into what is reachable another way and what is not
- **`bw_system_profile`** — one call and the agent knows what it is working on: BW/4HANA or classic BW, which REST endpoint groups the system publishes, and whether the three preconditions hold (`Accept`-header handling, ADT DataPreview access, query reporting). It can then take the route that works on this release — reading a transformation from the metadata tables where there is no REST resource for one — instead of discovering the release through failed calls
- **`bw_read_metadata_tables`** — reads straight from the metadata tables what the system publishes no REST resource for:
  - **Transformations** — field mappings with their rule types, and the source of the start, end, expert and field routines
  - **DTPs** — path, resolved transformation, extraction mode and error handling
  - **Classic providers** — `ODSO`, `CUBE` and `MPRO`
  - **Process chains** — steps with their variant parameters and the dependencies between them, in the order the chain runs
  - **Load history** of an InfoCube or DataStore object — request, status, update mode, start, user, duration, records and source

**🔗 Process chains, edited in place**

- **`bw_add_process_chain_edge`**, **`bw_remove_process_chain_edge`**, **`bw_remove_process_chain_step`** — change one dependency or one step instead of rewriting the whole model. Removing a step takes its edges and its inline variant with it and bridges the gap, so the strand stays connected
- Steps are addressed by name — a DTP, an aDSO, the program of an ABAP step, a collector type, or `#<index>`. An ambiguous name is rejected with the candidates listed rather than resolved by guesswork
- `before` / `after` now inserts a DTP or ABAP block **in series**: the target's edges are rerouted through the block, so it really runs ahead of or behind that step

**🧱 Remodeling monitor**

- **`bw_list_remodeling_requests`**, **`bw_get_remodeling_request`**, **`bw_run_remodeling`** — monitor, diagnose and run remodeling requests: the five processing steps with their status and the application log per step, plus execute, restart, reset and reset-step. Running a rule restructures the InfoProvider and converts its data, so this is a write with data impact

**📐 Query characteristic properties**

- **`bw_update_query_characteristic`** — display of result rows, display as key/text, access type for result values, sorting, cumulation, display level, and the hierarchy assignment with its display options. `"*"` applies one set of properties to every characteristic in the layout

**🗂️ aDSO field groups**

- **`bw_update_adso`** takes a `dimension` on `add_field` and `add_pure_field`, so a new field is created in the right group — a key figure lands in the key figure group instead of the catch-all. That is where the value is: the second activation, and with it the reactivation of every aggregation level, transformation and DTP behind the aDSO, does not happen at all
- `update_field_properties` takes the same parameter to move an existing field between groups, and changes nothing else about it
- Group names are defined per aDSO rather than by a fixed vocabulary, so an unknown name is refused with the declared groups listed instead of quietly falling back to the catch-all

**🔧 Minor changes and fixes**

- DTP filters take the full range vocabulary — sign `I`/`E` with `Equal`, `Between`, `ContainsPattern` and the comparison operators — validated against the operators the field itself publishes
- The CSRF token fetch is retried once on a dead keep-alive socket, which used to abort a run of process-chain writes mid-sequence
- Process-chain run timestamps are parsed again ([#15](https://github.com/dnic-dev/bw-modeling-mcp/issues/15))
- `bw_get_request` works for requests without a process log ([#16](https://github.com/dnic-dev/bw-modeling-mcp/issues/16))
- A failed transformation model serialization is reported as such instead of dumped ([#17](https://github.com/dnic-dev/bw-modeling-mcp/issues/17))
- `NODESNOTCONNECTED` is no longer reported as an InfoArea ([#18](https://github.com/dnic-dev/bw-modeling-mcp/issues/18))
- Namespaced object names such as `/NAMESPACE/OBJECT_NAME` are addressed correctly in every URL ([#19](https://github.com/dnic-dev/bw-modeling-mcp/issues/19))

---

**Earlier releases** — the "What's New" notes for v1.3.0 and older are archived in [WHATS_NEW.md](WHATS_NEW.md); the full structured history is in [CHANGELOG.md](CHANGELOG.md).

---

## What it can do

An overview by area. Every tool in detail — parameters, behaviour, and the sequences it belongs in — is in the **[Tools Reference](TOOLS.md)** (99 tools).

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

### System Diagnostics & Classic Objects
- Profile the connected system — BW/4HANA vs classic BW, the REST endpoint groups it publishes and therefore which tool groups work on it, plus three preconditions: `Accept`-header handling, ADT DataPreview access, and whether query reporting is implemented
- Read objects the connected system publishes no REST resource for, straight from the metadata tables: transformations (including start, end, expert and field routine source code), DTPs, the classic providers — DataStore objects, InfoCubes and MultiProviders — and process chains, whose steps, variant parameters and dependencies are resolved into execution order
- Read the load history of an InfoCube or DataStore object — request, status, update mode, start time, user, duration, records transferred and added, and the source — which on a classic BW system is the only route to load status at all
- SAP BW 7.5 on HANA is reachable for modeling reads after a small ABAP post-exit — see [docs/BW75-SUPPORT.md](docs/BW75-SUPPORT.md)

### Request Monitor & Runtime
- List load requests for a target InfoProvider — status, last process status/action, record count, timestamp, user, TSN
- Full status analysis of a single load request — header, DTP information (start/finish/duration), process step chain, and message log in one call
- Activate loaded data (DSO request activation) — move a finished load from the inbound table into the active data table + change log
- Monitor, diagnose and run remodeling requests — the five processing steps (`CHECK`, `SAVE`, `CONVERT`, `ACTIVATE`, `CLEANUP`) with their individual status and the application log per step, plus execute, restart, reset and reset-step. Running a rule restructures the InfoProvider and converts its data
- Uses the BW/4HANA `/sap/bc/.../bw4` manage API (the same operations as the BW/4HANA Cockpit)

### General
- Search & Where-Used (xref)
- Activate BW objects (aDSO, InfoObject, Transformation, DTP, DataSource, CompositeProvider)
- Release locks without activating (discard changes)
- Delete BW objects
- Transport request assignment — add a user task (sub-request) to a workbench transport, list changeable transport requests and their tasks
- Reassign an object to a different package (Development Class) on a transport request

---

## Combining with an ADT MCP Server

For tasks involving ABAP or SQLScript (AMDP) logic inside Transformations, **bw-modeling-mcp works best alongside an ADT MCP server** such as [vibing-steampunk](https://github.com/oisee/vibing-steampunk) or [ARC-1](https://github.com/arc-mcp/arc-1).

The BW MCP server handles the BW modeling structure — creating the Transformation, setting up routines, activating objects. The ADT MCP server handles reading and writing the actual ABAP class source code that backs the routine. Together, they cover the full development cycle from BW object creation to ABAP logic implementation.

---

## System Compatibility

| System | Support |
|---|---|
| SAP BW/4HANA (all versions) | ✅ Full support |
| SAP BW Bridge (SAP BTP ABAP stack) | ✅ Via cookie authentication (`BW_COOKIE_FILE`) |
| SAP BW on HANA (7.5) | ⚠️ Modeling reads after a small ABAP enhancement — see [BW 7.5 Support](docs/BW75-SUPPORT.md) |

<p><em><sub>On SAP BW 7.5 the REST framework looks up the <code>Accept</code> header case-sensitively while the kernel delivers header names in lower case, so almost every call fails with HTTP 406. A ~20-line post-exit enhancement (no modification) resolves this and makes all REST endpoints that exist on 7.5 reachable. Objects for which BW 7.5 ships no REST resource at all — transformations, DTPs, process chains, classic DSOs, InfoCubes — are readable through <code>bw_read_metadata_tables</code>, which goes to their metadata tables instead, but they cannot be written; Eclipse opens the embedded SAP GUI for those as well. Details, ABAP code and setup steps: <a href="docs/BW75-SUPPORT.md">docs/BW75-SUPPORT.md</a>.</sub></em></p>

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

The server connects to the SAP BW Modeling REST API (`/sap/bw/modeling/`) — the same internal API used by Eclipse BWMT. All write operations follow the BW locking protocol:

1. **Lock** — acquires an exclusive lock and returns a `lockHandle`
2. **Read** — fetches the current complete XML of the object
3. **Modify** — applies changes to the XML
4. **PUT** — sends the full modified XML back (never partial updates)
5. **Activate** — promotes the inactive version to active
6. **Unlock** — releases the lock

Session cookies and CSRF tokens are managed automatically.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full technical architecture and complete API reference.

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
