# What's New — Release Archive

The **latest** release highlights live in the [README](README.md#-whats-new).
This file archives the "What's New" notes of all **earlier** releases, newest first,
so the README stays focused on the current version.

For the complete, structured change history see [CHANGELOG.md](CHANGELOG.md).

---

## What's New — v1.3.0

**🚀 CompositeProvider authoring**

- **`bw_create_composite_provider`** — a Union or Join node with its source providers attached, or a copy of an existing CompositeProvider
- **`bw_update_composite_provider`** grew from two actions to eight: `add_input`, `remove_input`, `update_mapping`, `update_join`, `remove_join` and `update_settings` alongside the existing `add_field` / `remove_field`
- Field mappings are resolved from each source's own metadata, so field-based and InfoObject-based providers both work as sources
- Join conditions are set per input pair — which is how BW models an N-way join: one condition per pair

Verified against a BW/4HANA system all the way to an **activated** CompositeProvider. That distinction matters here: the backend accepts a model it will later refuse to activate, so a successful save proves nothing.

This began as a contribution — the traced payloads come from [#20](https://github.com/dnic-dev/bw-modeling-mcp/pull/20) by [@JosephManu12](https://github.com/JosephManu12), ported onto the current code base and extended.

**📊 Aggregation levels**

- **`bw_create_aggregation_level`** and **`bw_update_aggregation_level`** — built on an aDSO or on a CompositeProvider, over all fields of the provider or a chosen subset
- Reading planning objects was already possible; the aggregation level is the first one the server can create

**🎛️ Query variables**

- **`bw_create_variable`** covers all four processing types — user entry, **customer exit**, authorization and replacement path — for characteristic values, hierarchies and hierarchy nodes, with the usual selection and entry-requirement options

**🔧 Minor changes and fixes**

- Locks are released by the session that holds them — previously `?action=unlock` from another session answered HTTP 200 without releasing anything, leaving objects locked until the session timed out or SM12 was used ([#13](https://github.com/dnic-dev/bw-modeling-mcp/issues/13))
- `bw_unlock` accepts `hcpr` and `alvl`
- `adtcore:masterSystem` comes from the system's logical system name instead of the URL host, which produced `LOCALHOST` behind a destination ([#13](https://github.com/dnic-dev/bw-modeling-mcp/issues/13))
- The CompositeProvider read uses a fresh session, so it no longer serves a stale model buffer right after a write
- Labels are XML-escaped on write and decoded on read — an `&` used to fail the request with HTTP 500
- Key figures are detected in Union nodes, which carry no dimension to read them from

---

## What's New — v1.2.0

**Central hosting on SAP BTP Cloud Foundry with XSUAA OAuth and role-based access control. Game-changer for enterprise deployments.**

> **Backwards compatible — local use is unchanged.** Existing stdio setups (`npm start`, Claude Desktop, etc.) keep working exactly as before: no auth, no BTP, no config changes. Upgrading to v1.2.0 is non-breaking — central hosting is purely additive.

**🚀 The Big Picture**

- **BTP Cloud Foundry HTTP Server** — the MCP can now run as a central service on enterprise infrastructure (not just locally). `npm run start:http` launches an Express server bound to XSUAA, destination, and connectivity services
- **XSUAA OAuth Authentication** — **same [@arc-mcp/xsuaa-auth](https://github.com/arc-mcp/xsuaa-auth) module as [ARC-1](https://github.com/arc-mcp/arc-1)** for ecosystem consistency. Stateless Dynamic Client Registration (DCR) + callback proxy. Users log in via BTP identity, the server respects their identity for analytics and auditing (principal propagation ready)
- **Role-Based Access Control (RBAC)** — `xs-security.json` defines two scopes and **suggested default role collections** that can be customized to your needs:
  - **`BW MCP Reader`** — read-only metadata and query tools (`read` scope). Ideal for analysts and report consumers
  - **`BW MCP Developer`** — full access: create/update/delete/activate/push (`write` scope, implies `read`). For modelers and data engineers
  - Scope enforcement in `src/scopes.ts` is explicit on reads (safe by default), automatic on writes (new write tools require admin to whitelist for read-only)
  - **Customize for your org:** Extend with `query`, `monitor`, `metadata`, `data_push`, `admin` scopes for finer granularity
- **Cloud Connector Integration** — on-premise BW systems route through BTP destinations + Cloud Connector

**📋 What This Enables**

| Scenario | Before | Now |
|----------|--------|-----|
| **One analyst, one BW system** | stdio on analyst's machine | BTP server, analyst logs in with their own identity |
| **Many analysts, shared server** | impossible (no central auth) | all log in via BTP, each user's identity flows to BW |
| **MCP tool permissions** | none — whoever runs it can call every tool | grant tools per role, **independent of BW authorizations**: e.g. a BW developer restricted to read-only in the MCP, or the querying tools withheld from someone who may otherwise view data |
| **BW authorizations** | always enforced via the user's own credentials | unchanged — still fully enforced; principal propagation means each caller acts as themselves, never a shared identity |
| **Enterprise audit trail** | limited | XSUAA logs all logins; with principal propagation BW session logs show the true user |

**⚙️ Configuration**

- `manifest.yml` — Cloud Foundry app manifest (512 MB, 1 GB disk, BW destination + client + language)
- `xs-security.json` — XSUAA config; extend with `query`, `monitor`, `metadata`, `data_push`, `admin` scopes if finer granularity is needed
- Transport: stdio via `node dist/stdio.js` (default), HTTP+OAuth via `npm run start:http` (= `node dist/http.js`, as used by `manifest.yml`)

**📖 Documentation**

See [docs/CLOUD-FOUNDRY.md](docs/CLOUD-FOUNDRY.md) for the full setup: services, destinations, XSUAA, Cloud Connector, and principal propagation (Stage 2).

**🔐 Security Notes**

- Write scope implicitly grants read (one-way: read tools do not grant write)
- New write tools default to requiring `write`; old read tools explicitly whitelist for `read`
- Principal propagation requires CERTRULE + ICM trust on BW side (see docs/CLOUD-FOUNDRY.md §3)
- stdio mode is unchanged and auth-free

---

## What's New — v1.1.0

**Two new authoring tools and a safer DTP filter-routine path.**

**🏆 New tools**

- `bw_create_rkf` — create a reusable Restricted Key Figure (ELEM) on an InfoProvider from a base key figure plus characteristic restrictions. Built for mass creation (one RKF per call); each value is validated against the InfoProvider and written consistent, no separate activation
- `bw_add_process_chain_program` — add an "Execute ABAP Program" step (RSPC type ABAP) to an existing chain, optionally with an SE38 variant; in-place edit with `before` / `after` / `predecessor` positioning, idempotent

**➕ Improved**

- `ADSOREM` step type (DSO request cleanup) in `bw_create_process_chain` and `bw_update_process_chain` — per-aDSO cleanup action and request selection

**🐛 Fixes**

- `bw_set_dtp_filter_routine` — the routine is syntax-checked before activation; broken code is reported instead of falsely marked "activated", the ADT lock is released on error, and real activation failures are surfaced
- Process chain transport check — a stale-session `validateobject` 404 is handled softly instead of aborting, so it no longer blocks follow-up writes to local (`$TMP`) chains

---

## What's New — v1.0.0

**The biggest feature drop yet — and the jump to 1.0.** A broad wave of write tools rounds out full **read/write BW/4HANA modeling coverage**.

**🏆 Query authoring — from read-only to fully writable**

- `bw_create_query` — create a new query (ELEM) on an InfoProvider; with `copy_from`, clone an existing query in full (layout, filter, variables, key figures)
- `bw_update_query_layout` / `bw_update_query_filter` / `bw_update_query_key_figures` / `bw_update_query_settings` — edit rows/columns/structures/free characteristics, restrictions, key figures (RKF/CKF references plus local formula members over the full BW operator catalog with operand-count validation), and query properties; all accept an optional `transport` request
- query deletion via `bw_delete`

**🏆 Process chain authoring, extended**

- `bw_append_process_chain_dtp` — append a DTP load step (optionally with its own DSO activation) to an existing chain
- `bw_swap_process_chain_dtp` — swap one DTP load variant for another
- `bw_add_process_chain_error_links` — add on-error (negative) links, mirroring the existing success links
- `bw_create_decision_variant` — create a DECISION process variant for branch/decision steps

**➕ More new tools & improvements**

- Transport lifecycle: `bw_create_transport_task` (add a user task to a workbench transport), `bw_list_changeable_transports` (list requests and their tasks)
- DataSource authoring: `bw_change_datasource_delta` (delta process), `bw_set_datasource_fields` (transfer flags + segment language field)
- `bw_set_transformation_expert_routine` — write Start/End/Expert routine code transport-stably into the transformation master
- `bw_create_dtp` — `target_object_subtype` (ATTR / TEXT / HIER) reaches InfoObject text and hierarchy targets, not just attributes

**🐛 Stability fixes**

- Fresh-session hardening across all object types: transformation runtime switches are no longer falsely reported as unpersisted or silently reverted, and stale inactive-shadow reads (notably on `bw_get_dtp`) are gone

---

## What's New — v0.9.0

**Integrated Planning — complete read-only coverage**

All four core object types of BW Integrated Planning (IP / embedded BPC) are now readable:

- `bw_get_aggregation_level` — reads an Aggregation Level (ALVL): the planning-enabled view on top of an InfoProvider, with the complete element list — characteristics including compounding, key figures including aggregation behavior, semantics, and unit/currency reference
- `bw_get_planning_function` — reads a Planning Function (PLSE): function type, aggregation level, characteristic usage roles, and the full parameter tree; for FORMULA functions the FOX code is surfaced directly as a parameter value
- `bw_get_planning_sequence` — reads a Planning Sequence (PLSQ): ordered step list with aggregation level, planning function, and filter name per step
- `bw_get_planning_properties` — reads the Planning Properties (PLCR) of a plan-enabled InfoProvider: key-date mode, maximum characteristic combinations, and save strategy

**Process chain authoring and monitoring**

Building on the existing `bw_get_process_chain` (structural read), three authoring and three monitoring tools are now available:

- `bw_create_process_chain` / `bw_update_process_chain` / `bw_activate_process_chain` — create, replace the step model of, and activate a Process Chain (RSPC); supported step types: `DTP_LOAD`, `ADSOACT`, `CHAIN` (local sub-chain start, verified), and collectors `AND` / `OR` / `XOR`; inline-configured process types (ABAP programs, OS commands, attribute change runs, etc.) are not yet supported
- `bw_list_process_chain_runs` — execution history of one or all chains: status, timestamps, duration, and log ID
- `bw_get_process_chain_run_detail` — step-level and message-level detail of a single run, including error messages
- `bw_list_process_chain_last_status` — last execution status and scheduling state for every chain in the system

**Further new tools**

- `bw_get_open_hub` — reads an Open Hub Destination (DEST): destination type, source object, DB table, InfoArea, and the complete output field list with types, InfoObject binding, conversion routine, and key flag
- `bw_list_remote_entities` / `bw_create_datasource` — discover HANA views and virtual tables exposed by a source system, then create a DataSource from the server's field proposal; activation is a separate step via `bw_activate`
- `bw_set_transformation_routine_fields` — sets the target fields an END routine writes; accepts an explicit field list or an exclusion list

**Improvements**

`bw_activate` now supports `hcpr` (CompositeProvider); `bw_create_dtp` accepts InfoObject attribute targets (`IOBJ`, mapped to `IOBJA`); `bw_update_transformation` supports field-based direct mappings for targets without an underlying InfoObject.

---

## What's New — v0.8.0

**Runtime tools & request monitoring** — the first tools driven by the BW/4HANA `/sap/bc/.../bw4` manage API (the same operations you'd otherwise perform in the BW/4HANA Cockpit), not the `/sap/bw/modeling` tool API:

- `bw_run_dtp` — start (execute) a DTP load; returns the run request id (RSPM TSN) usable directly with `bw_get_request`
- `bw_list_requests` / `bw_get_request` — monitor load requests: status, records, DTP info, process steps, message log
- `bw_activate_request` — activate loaded data (move a finished load from the inbound table into the active data table + change log)

**BW Bridge connectivity** — authenticate against BW systems running on the SAP BTP ABAP stack (BW Bridge) via a browser-exported cookie file (`BW_COOKIE_FILE`), in addition to Basic Auth; login/session approach analogous to [vibing-steampunk](https://github.com/oisee/vibing-steampunk).

**DataSource (RSDS) across the modeling lifecycle** — create an aDSO from a DataSource template (`bw_create_adso`), use a DataSource as DTP source (`bw_create_dtp`), and activate a DataSource (`bw_activate`).

**Fixes** — query reads negotiate the backend content-type version via discovery (fixes HTTP 415 on higher SP levels, #11); DTP activation no longer reports a false "transformation inactive"; field-add works on staging/inbound aDSOs without key elements; DATS date constants survive activation; transformation rule editing picks the correct rule when a start/end routine exists.

---

## What's New — v0.7.0

Process Chain support and DataSource data preview:

- `bw_get_process_chain` — reads a complete Process Chain definition including all steps, conditional dependencies, DECISION branch labels, and inline variant configuration; automatically fetches and embeds variant detail (ABAP program + selection variant, TRIGGER scheduling, ADSOACT target aDSO, ADSOREM cleanup settings, PLSWITCHL/P target, DECISION branching formulas) for each step in a single call — deterministic, no additional prompting needed; supports recursive sub-chain expansion by calling the tool again on any referenced chain name
- `bw_get_process_variant` — reads the configuration detail of any individual process step variant; generic across all 93 BW/4HANA process types; oDetail returned as structured JSON
- `bw_preview_datasource` — fetches a live data preview from any DataSource; resolves field names automatically from the DataSource structure and renders a formatted table; record count configurable (default 20)

---

## What's New — v0.6.0

BW Role Management — four new tools for reading and managing query-to-role assignments: `bw_get_roles` (full role hierarchy), `bw_get_role_queries` (all published queries per role), `bw_get_query_roles` (which roles a query is published in), `bw_set_query_roles` (publish or remove a query from a role or folder, including support for nested menu folders).

---

## What's New — v0.5.0

Live data querying:

- `bw_query_data` — executes a BEx Query or previews data from any InfoProvider (aDSO, CompositeProvider) via the BICS reporting endpoint; supports variable input, axis layout control (ROWS/COLUMNS/FREE), characteristic filters with include/exclude and range operators, hierarchy drill-down (expand/collapse nodes), pagination, and structure member selection; renders a formatted table with hierarchy indentation
- `bw_get_filter_values` — looks up valid characteristic values before setting filters or variables; supports wildcard search and optional InfoProvider scoping
- `bw_get_query` — now returns a compact human-readable summary by default; use `format="raw"` to get the previous full JSON output

---

## What's New — v0.4.0

DataSource and source system navigation:

- `bw_get_dataflow` — traces the complete structural data flow graph of any BW object in any direction (upwards / downwards / both); mirrors the Eclipse BWMT Transient Data Flow view
- `bw_list_source_systems` — lists all logical source systems (LSYS) registered in BW, filterable by type (ODP_SAP, ODP_CDS, ODP_BW, ODP, FILE, HANA_SDA, HANA_LOCAL)
- `bw_list_datasources` — recursively lists all DataSources under a source system with full APCO hierarchy path
- `bw_get_source_system` — reads full source system metadata: type, description, connection details (ODP context/destination, HANA remote source, schema)
- `bw_get_datasource` — reads complete DataSource structure: all fields with types, lengths, transfer flags, key flags, conversion exits, unit/currency references, and adapter configuration
- `bw_xref` — new `source_system` parameter for `object_type=RSDS`; the correct space-padded objectName is built automatically

---

## What's New — v0.3.0

CompositeProvider read support and BW repository navigation:

- `bw_get_composite_provider` — reads a CompositeProvider structure: view node type (Union/Join), source providers with mapping counts, all fields with dimension classification, join conditions, and temporal join details
- `bw_get_ckf` — reads a global Calculated Key Figure with recursively resolved human-readable formula and full dependency graph of referenced sub-components
- `bw_get_rkf` — reads a global Restricted Key Figure: base measure and all characteristic restriction groups
- `bw_get_structure` — reads a global Structure: all members with Formula/Selection breakdown, characteristic filters, and optional child members
- `bw_list_contents` — navigates the full BW repository tree (InfoAreas → type folders → objects → sub-folders), mirroring the Eclipse BWMT Project Explorer
