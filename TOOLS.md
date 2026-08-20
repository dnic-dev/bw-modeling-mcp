# Tools Reference

Every tool the server exposes — 99 in total — with what it does and the parameters that matter.
Tools marked _(Read only)_ change nothing in BW; everything else writes, activates, runs, or unlocks.

For what the server can do as a whole, see [What it can do](README.md#what-it-can-do) in the README.
For the architecture and the full endpoint list, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Contents

- [Discovery & System](#discovery--system) — 6 tools
- [aDSO](#adso) — 3 tools
- [InfoObject](#infoobject) — 3 tools
- [InfoArea, Packages & Transports](#infoarea-packages--transports) — 6 tools
- [InfoSource](#infosource) — 3 tools
- [Transformation](#transformation) — 8 tools
- [DTP (Data Transfer Process)](#dtp-data-transfer-process) — 6 tools
- [DataSource & Source Systems](#datasource--source-systems) — 9 tools
- [CompositeProvider](#compositeprovider) — 3 tools
- [Open Hub Destination](#open-hub-destination) — 1 tool
- [BW Query — modeling](#bw-query--modeling) — 12 tools
- [BW Query — data & roles](#bw-query--data--roles) — 6 tools
- [Integrated Planning](#integrated-planning) — 6 tools
- [Process Chains — authoring](#process-chains--authoring) — 13 tools
- [Process Chains — monitoring](#process-chains--monitoring) — 3 tools
- [Requests, Runtime & Remodeling](#requests-runtime--remodeling) — 6 tools
- [Push API](#push-api) — 2 tools
- [General](#general) — 3 tools

---

## Discovery & System

### `bw_search`
Search BW objects by name or description. Supports wildcards (`*`). Optionally filter by object type (`ADSO`, `IOBJ`, `TRFN`, `DTPA`, etc.).

### `bw_xref`
Find all objects that reference a given BW object (where-used analysis). Use this to find Transformations and DTPs connected to an aDSO, or to find the process chain(s) a DTP belongs to (`object_type=DTPA`).

For DataSources (`object_type=RSDS`): pass `source_system` — the correctly space-padded objectName is built automatically.

### `bw_system_profile` _(Read only)_
Report what the connected BW system is and which tool groups work on it. Distinguishes SAP BW/4HANA from classic SAP BW via the system's own `b4hanamode` flag, lists which REST endpoint groups the system publishes, and verifies three preconditions: whether `Accept`-header handling works (a broken one makes almost every call fail with HTTP 406 on BW 7.5 — see [docs/BW75-SUPPORT.md](docs/BW75-SUPPORT.md)), whether the ADT DataPreview service is reachable for this user, and whether the BICS reporting resource is implemented (classic BW publishes the endpoint without implementing it). Call it before planning work on a system whose release is not already known: the answer says which tool groups are available and, where they are not, which route to take instead.

### `bw_read_metadata_tables` _(Read only)_
Read an object definition directly from its metadata tables, via the ADT DataPreview service. Read-only fallback for the object types a system publishes no REST resource for — on classic SAP BW typically transformations and DTPs, and on every release the classic providers. Supported `object_type`: `TRFN` (including start, end, expert and field routine source code), `DTPA`, `ODSO`, `CUBE`, `MPRO` and `RSPC` — a process chain comes back with its steps, their variant parameters and the dependencies between them, resolved into the order the chain actually runs (the tables return the rows in no particular order, and a collector has one row per incoming link). InfoCubes and DataStore objects additionally report their **load history**: request, status, update mode, start time, user, duration, records transferred and added, and the source. On classic BW that is the only way to see load status at all, since the manage API behind `bw_list_requests` does not exist there. Requires ADT authorization for the calling user; prefer `bw_get_transformation` where the REST endpoint exists.

### `bw_list_contents` _(Read only)_
Navigate the BW repository tree. Pass a path such as `""` (all InfoAreas), `"area/MYAREA"` (InfoArea contents), `"hcpr/CP_NAME"` (CP sub-folders), or `"adso/ADSO_NAME/trfn"` (Transformations on an aDSO). Each entry includes `children_path` to drill down further.

### `bw_get_dataflow` _(Read only)_
Read the complete structural data flow of a BW object — all connected sources and targets resolved recursively through Transformations, DTPs, InfoSources, aDSOs, DataSources, CompositeProviders, and InfoObjects. Mirrors the Eclipse BWMT Transient Data Flow view. Supports direction (`upwards` / `downwards` / `both`) and configurable depth. Note: routine-based lookups (ABAP/SQLScript) are not reflected — only structural BW dependencies.

---

## aDSO

### `bw_get_adso`
Read the full structure of an aDSO — fields, key fields, settings, version state.

### `bw_create_adso`
Create a new aDSO. Supports two modes: `from_template` (copies structure from an existing aDSO) or `empty`. Supports all aDSO type presets including write-interface (`pushMode`).

### `bw_update_adso`
Modify an existing aDSO. Actions:
- `add_field` — add an InfoObject-backed field
- `add_pure_field` — add a field-based (pure) field without an InfoObject
- `remove_field` — remove a field
- `manage_keys` — set or update key fields
- `update_field_properties` — change aggregation, data type, length, etc.
- `update_settings` — change aDSO type preset, flags, or description


Field groups: `dimension` takes the bare group name — `"__KEYFIGURES"`, `"DATA"`, whatever the aDSO declares — on `add_field` and `add_pure_field` to create the field in that group directly, and under `properties` on `update_field_properties` to move an existing one. Group names are defined per aDSO; an unknown name is rejected with the declared groups listed. The current assignment is the `DIM` column of `bw_get_adso`.

---

## InfoObject

### `bw_get_infoobject`
Read an InfoObject definition (Characteristic or Key Figure).

### `bw_create_infoobject`
Create a new InfoObject. Supports:
- **Characteristic (CHA):** all data types (CHAR, NUMC, DATS, TIMS, SNUMC), with or without master data and texts, with compound parent InfoObjects, with referenced InfoObject
- **Key Figure (KYF):** all types (NUM, AMT, QTY, DAT, INT), all aggregations (SUM, MAX, MIN)

Created as inactive — activate with `bw_activate`.

### `bw_update_infoobject`
Add or remove display (`DIS`) and navigation (`NAV`) attributes on an existing Characteristic.

---

## InfoArea, Packages & Transports

### `bw_get_infoarea`
Read an InfoArea definition — name, label, parent area, object status.

### `bw_create_infoarea`
Create a new InfoArea. Immediately active after creation, no activation step needed.

### `bw_move_object`
Move any BW object (aDSO, InfoObject, InfoArea, etc.) to a different InfoArea.

### `bw_change_package`
Reassign an existing BW object to a different package (Development Class) and record the change on a transport request via the CTO write endpoint. A single write, no activation — afterwards the object is inactive and must be re-activated with `bw_activate` (passing the same transport). For DataSources (`object_type="RSDS"`) `source_system` is mandatory (compound key) and the applied package is verified by re-reading the DataSource. Verified for `TRFN` and `RSDS`; other TLOGO types use the same mechanism but are not trace-verified.

### `bw_create_transport_task`
Add a task (sub-request) for a user to an existing workbench transport request.

### `bw_list_changeable_transports`
List transport requests and their tasks via the BW transport state (`cto/check`).

---

## InfoSource

### `bw_get_infosource`
Read an InfoSource (TRCS) structure — fields, key fields, label, InfoArea, version status.

### `bw_create_infosource`
Create a new InfoSource with full field definitions.

### `bw_update_infosource`
Update an existing InfoSource — fields and description.

---

## Transformation

### `bw_get_transformation`
Read a Transformation structure including all field mapping rules, routines, source, and target. Transformation names are UUID-like keys — use `bw_xref` on the target aDSO to find them.

### `bw_create_transformation`
Create a new Transformation. Supports all source types (aDSO, InfoSource, DataSource/RSDS) and all target types (aDSO). For InfoObject (`IOBJ`) sources or targets, set `source_object_subtype` / `target_object_subtype` to select the facet — `TEXT` (text table), `ATTR` (attributes / master data), or `HIER` (hierarchy). Can copy structure from an existing Transformation.

### `bw_update_transformation`
Modify field mappings in an existing Transformation:
- Map source field to target InfoObject (StepDirect)
- Set formula rule for a target field (StepFormula)

### `bw_set_transformation_routine`
Set a field routine, start routine, or end routine on a Transformation. Supports both ABAP and AMDP (SQLScript). The routine code is written in combination with an ADT MCP server.

### `bw_set_transformation_expert_routine`
Write the code of an existing Start/End/Expert routine into the Transformation master so it survives activation and transport. Unlike a raw `WriteSource` on the generated class, this re-saves the master and keeps the routine code transport-stable.

### `bw_set_transformation_routine_fields`
Edit the list of target fields the global END routine writes ("Felder setzen" in the SAP GUI). Requires an existing END routine. Pass exactly one of `fields` (the complete set the routine should write) or `exclude_fields` (all target fields except these); neither, both, an unknown field name, or an empty resolved set is rejected. Does not activate — returns a `lock_handle` for `bw_activate`.

### `bw_delete_transformation_routine`
Remove an existing routine from a Transformation field.

### `bw_set_transformation_runtime`
Switch the Transformation runtime between ABAP and HANA (AMDP). The current runtime is read from the active version, the change is activated automatically, and the result is verified against the active version — no separate `bw_activate` call is needed. If the switch does not persist (e.g. the server refuses HANA runtime for this transformation), the tool returns an error instead of a false-positive success.

---

## DTP (Data Transfer Process)

### `bw_get_dtp`
Read the full definition of a single DTP — source, target, transformation reference, extraction settings (mode, package size), and all filter fields including value selections and routine code. DTP names are UUID-like keys — use `bw_xref` or `bw_get_dtps` to find them.

### `bw_get_dtps`
List all DTPs that depend on a given BW object or Transformation.

### `bw_create_dtp`
Create a new DTP on a Transformation. Source and target are derived from the Transformation automatically. For a DataSource source, set `source_type="RSDS"` and pass `source_system`. For an InfoObject target (`target_type="IOBJ"`), select the loaded sub-object with `target_object_subtype` — `ATTR` (attributes / master data, default), `TEXT` (texts), or `HIER` (hierarchies).

### `bw_run_dtp`
Start (execute) a run of an existing, active DTP. Returns the new run request id (an RSPM TSN) that can be passed directly to `bw_get_request` for monitoring.

### `bw_update_dtp`
Update a DTP — description, value filters on fields, and extraction mode (`extraction_mode` = `full` / `delta`). Note: switching between Delta and Full has BW delta-init implications — a later delta load may require re-initialization.

### `bw_set_dtp_filter_routine`
Set an ABAP routine filter on a DTP field. The generated routine's inactive version is syntax-checked before activation — broken code is reported with the ABAP messages and the DTP is left unchanged, instead of being falsely reported as activated.

---

## DataSource & Source Systems

### `bw_list_source_systems` _(Read only)_
List all logical source systems (LSYS) registered in the BW DataSource structure. Optionally filter by type (`ODP_BW`, `ODP_SAP`, `ODP_CDS`, `ODP`, `FILE`). Each entry includes `children_path` — pass it directly to `bw_list_datasources` as `source_system`.

### `bw_get_source_system` _(Read only)_
Read the metadata of a single logical source system — type, description, and connection details. For ODP systems: context, destination, validity flags. For HANA systems: remote source, database, schema, SDI adapter.

### `bw_list_datasources` _(Read only)_
List all DataSources available under a logical source system. Recursively traverses the full APCO hierarchy. Each DataSource entry includes name, description, status, and the full `apco_path` (ordered list of application component titles from root to the DataSource). Output format: `text` (default table) or `raw` (XML feed bodies).

### `bw_get_datasource` _(Read only)_
Read the complete structure of a DataSource (RSDS): metadata (status, delta type, direct access, application component, package, timestamps), all fields with type, length, transfer flag, key flag, position, selection options, conversion exit, and unit/currency reference, plus active adapter configuration (ODP, HANA, File, CSV). Output format: `text` (default human-readable summary) or `raw` (XML from BW).

### `bw_list_remote_entities` _(Read only)_
List the remote entities (HANA views / virtual tables) a source system exposes as a DataSource basis — the value help Eclipse shows on the DataSource proposal page. Each entity's `technical_name` is exactly what binds into `bw_create_datasource`.

### `bw_create_datasource`
Create a DataSource (RSDS) on a remote entity from the server's field proposal, leaving it inactive. The server derives the complete field and segment structure from the entity — no field, key or partitioning editing. Local objects only (`$TMP`), no transport handling. The HANA entity binds through the adapter's `externalObject` attribute rather than by name equality, so take `hana_entity` from `bw_list_remote_entities`. Activate separately with `bw_activate` (`object_type` "rsds").

### `bw_change_datasource_delta`
Change the delta process of a DataSource (`deltaProperties`). Full read-modify-write; leaves the object inactive for a separate `bw_activate`.

### `bw_set_datasource_fields`
Set the transfer flag of one or more DataSource fields (`fieldProperties@transfer`) and/or the segment `language_field`. At least one of `fields` / `language_field` must be given.

### `bw_preview_datasource` _(Read only)_
Fetch a live data preview from a DataSource. Resolves field names automatically and renders a formatted table. Parameters: `datasource_name`, `source_system`, `records` (default 20).

---

## CompositeProvider

### `bw_get_composite_provider` _(Read only)_
Read a CompositeProvider (HCPR) — view node type (Union/Join), source providers with input mapping counts, all fields with dimension classification, join conditions, and temporal join details.

### `bw_create_composite_provider`
Create a CompositeProvider. Without `copy_from`, a view node of the given type with the listed source providers attached — entity only, so give them their mappings afterwards with `bw_update_composite_provider` action `update_mapping`. A Union node may be created empty; a Join node must be created with its sources, since a join node without inputs makes the server dump. With `copy_from`, the server copies view node, inputs and mappings from an existing CompositeProvider. The result is inactive.

### `bw_update_composite_provider`
Change a CompositeProvider. Eight actions: `add_field` / `remove_field` for fields, `add_input` / `remove_input` for source providers, `update_mapping` for one input's complete mapping list (omit the mappings to map every source field one to one), `update_join` / `remove_join` per input pair, and `update_settings` for description, stackable, default node and aggregation behaviour. Every action returns a `lock_handle` that `bw_activate` needs — an HCPR cannot be activated without it.

Two things to know: both sides of a join key must be mapped onto the **same** target field, otherwise activation fails with "join fields need at least one common target field" — auto-mapping deliberately does not do this, so map the second side's key fields explicitly. And `remove_input` leaves the removed input's elements and any join referencing it behind; those have to be cleaned up separately.

---

## Open Hub Destination

### `bw_get_open_hub` _(Read only)_
Read an Open Hub Destination (DEST) — destination type, source, DB table, InfoArea, package, status, and the complete output field list with type/length, InfoObject binding, conversion routine, compounding and key flag, plus the file properties when the destination type is FILE.

---

## BW Query — modeling

### `bw_get_query` _(Read only)_
Read a BW Query definition — variables, filter logic (fixed values and variable references resolved), layout with full member lists, calculated key figures with recursively resolved formulas, restricted key figures with selection conditions, exceptions, and query settings. Output format: `text` (default, compact human-readable summary) or `raw` (full parsed JSON).

### `bw_create_query`
Create a new, consistent Query (TLOGO ELEM) on an InfoProvider in package `$TMP`. Without `copy_from` the query is created empty and consistent (no rows, columns, or key figures yet). With `copy_from` it is created as a full copy of an existing query (layout, filter, variables, key figures); when no `infoprovider` is given it defaults to the source query's provider.

### `bw_update_query_layout`
Edit the query layout — add/remove rows, columns, structures, and free characteristics. Accepts an optional `transport` request number for queries on a transportable package.

### `bw_update_query_filter`
Edit the query filter — fixed value restrictions on characteristics. Accepts an optional `transport` request number.

### `bw_update_query_key_figures`
Edit the query key figures — add basic key figures, references to global RKFs/CKFs, and local formula members; set exception aggregation and display properties (decimals, hidden, sign inversion); remove members. Formula members accept a recursive operator/operand tree covering the full BW operator catalog (basic, percentage, data, mathematical, trigonometric, and boolean operators plus ternary `IF`); operator codes are case-insensitive and their operand counts are validated before saving. Accepts an optional `transport` request number.

### `bw_update_query_settings`
Edit query properties (settings). Accepts an optional `transport` request number.

### `bw_update_query_characteristic`
Set the per-characteristic display and access properties of the rows, columns, and free-characteristics areas — display of result rows, display as key/text (with short/medium/long text), access type for result values (read mode), sorting, cumulation, display level, and the hierarchy assignment with its display options (expand-to-level, child node position, postable node values, single-child suppression, hierarchy sorting). Pass `"*"` as `infoobject` to apply one set of properties to every characteristic in the layout; every property also accepts `"default"` to drop the explicit value. Accepts an optional `transport` request number.

### `bw_create_variable`
Create a characteristic variable. Processing type: `UserEntry`, `CustomerExit`, `Authorization` or `ReplacementPath`. Represents a characteristic value, a hierarchy or hierarchy nodes; selection as `Interval`, `SingleValue`, `SeveralSingleValues` or `SelectionOption`. Entry requirement, ready-for-input and reusability are parameters, so a variable filled only by the exit can be kept off the selection screen. Replacement path is limited to the current-member variant — replacement from a query result is not supported.

### `bw_get_ckf` _(Read only)_
Read a global Calculated Key Figure — formula recursively resolved to a human-readable string, metadata (package, InfoArea, author), and full dependency graph of all referenced sub-components.

### `bw_get_rkf` _(Read only)_
Read a global Restricted Key Figure — base measure, all characteristic restriction groups (field and value), and metadata.

### `bw_get_structure` _(Read only)_
Read a global Structure — all members with type (Formula/Selection), referenced components, characteristic filters, optional child members, and metadata.

### `bw_create_rkf`
Create one reusable Restricted Key Figure (TLOGO ELEM) on an InfoProvider from a base key figure plus one or more characteristic restrictions. Built for mass creation (one RKF per call); each restriction value is validated against the InfoProvider and mapped to its internal key before the write, and the RKF is written consistent (no separate activation step). Supports `Equal` / `Between` / `LessThan` / `GreaterThan` / `LessEqual` / `GreaterEqual` / `Contains` operators and exclusions, an optional InfoArea, and a transport request for transportable packages.

---

## BW Query — data & roles

### `bw_query_data` _(Read only)_
Execute a BEx Query or preview data from an InfoProvider (aDSO, CompositeProvider) via the BICS reporting endpoint. Returns a formatted result table with hierarchy indentation.

Parameters: `comp_id` (query or provider name), `is_provider` (set `true` for direct aDSO/HCPR access), `state` (axis placement — ROWS/COLUMNS/FREE — and per-characteristic filters supporting EQ/BT/GT/LT/GE/LE, include/exclude, external key, internal GUID key, and hierarchy-node filters), `variables` (fill query variables; name and id must be copied verbatim from the GET response), `from_row`/`to_row` (pagination), `drill_operations` (expand or collapse hierarchy and structure nodes by 1-based tuple index: `drill_state=3` expands, `drill_state=2` collapses), `format` (`text` default — formatted table; `raw` — XML).

Always call `bw_get_query` or `bw_get_adso` first to discover the axis layout and characteristic IDs, and call `bw_get_filter_values` before setting any filter or variable value.

### `bw_get_filter_values` _(Read only)_
Look up valid values for a characteristic — required before setting any filter or variable. Returns `CHAVL_EXT` (use for state filters) and `CHAVL_INT` (use for variable inputs); formats differ for date-type characteristics. Supports wildcard search (`*` for all values, prefix match e.g. `2022*`). Optionally scope results to a specific InfoProvider.

### `bw_get_roles` _(Read only)_
Read the complete BW role hierarchy as displayed in the Eclipse BWMT "Publish to Role" dialog. Returns all ROLE and FOLDER nodes with technical names, descriptions, and nodeids. Optional `role_filter` parameter limits output to roles whose name starts with the given prefix (e.g. `"BW:"`).

### `bw_get_role_queries` _(Read only)_
List all BW Queries published in the role hierarchy, grouped by role and folder. Only `SAP_BW_QUERY` objects are returned — PFCG menu entries of other types (e.g. AFO workbooks added as transactions) are not included. Optional `role_name` to scope to a specific role.

### `bw_get_query_roles` _(Read only)_
Return all roles and folders where a specific BW Query is currently published. Returns a clear "not published" message if the query has no role assignments.

### `bw_set_query_roles`
Publish or remove a BW Query from a role or folder. Parameters: `query_name`, `action` (`"add"` or `"remove"`), `target_type` (`"role"` or `"folder"`), `target_name` (role name attribute for role-level, folder txt for folder-level), `parent_role_name` (required when `target_type="folder"`). For add operations, the full role subtree is fetched automatically from `bw_get_roles` — no manual lookup needed.

---

## Integrated Planning

### `bw_get_aggregation_level` _(Read only)_
Read an Aggregation Level (ALVL) — the planning-enabled view on an aDSO or CompositeProvider used by Integrated Planning / embedded BPC. Returns the underlying InfoProvider and the element list split into characteristics (type, length, conversion routine, base InfoObject, compounding, dimension group) and key figures (aggregation behavior, semantics, and the unit/currency reference).

### `bw_create_aggregation_level`
Create an aggregation level (ALVL) on a planning-enabled aDSO or CompositeProvider, either over all its fields or a chosen subset. Needs at least one characteristic and one key figure. Activate with `bw_activate`, object type `alvl` and an empty `lock_handle`.

### `bw_update_aggregation_level`
Change the field selection of an existing aggregation level.

### `bw_get_planning_properties` _(Read only)_
Read the Planning Properties (PLCR) of a plan-enabled InfoProvider — key-date mode, the maximum number of characteristic combinations, and the save strategy (planning sequence plus delta-read flag). The PLCR shares its technical name with the provider it belongs to.

### `bw_get_planning_sequence` _(Read only)_
Read a Planning Sequence (PLSQ) — the ordered list of planning steps, each with its type code, aggregation level, planning function and filter name.

### `bw_get_planning_function` _(Read only)_
Read a Planning Function (PLSE) — a planning operation (formula/FOX, copy, delete, repost, distribution, currency translation, custom exit, …) tied to an aggregation level. Returns the function type, aggregation level, documentation, the characteristic usage list, and the full parameter tree; for FORMULA functions the FOX code is surfaced as source.

---

## Process Chains — authoring

### `bw_get_process_chain` _(Read only)_
Read a Process Chain (RSPC) definition — header metadata, scheduling and monitoring settings, all steps with type, variant, last execution status, conditional dependencies with DECISION branch labels, and automatically embedded variant configuration per step. Set `include_variant_details=false` for a fast structural overview. Output format: `text` (default) or `raw` (full JSON).

### `bw_get_process_variant` _(Read only)_
Read the detail configuration of a single Process Chain step variant. Generic across all process types — oDetail rendered as indented JSON. Use process_type and variant_name from `bw_get_process_chain` output.

### `bw_create_process_chain`
Create a Process Chain (RSPC) from a step and edge list — builds the model, creates a trigger-only skeleton, then updates it with the full model in one operation; optionally activates. Supported step types: `DTP_LOAD`, `ADSOACT`, `ADSOREM` (DSO request cleanup), `ABAP` (execute an ABAP program, optionally with an SE38 selection variant), `CHAIN` (local sub-chain start), `DECISION`, collectors `AND` / `OR` / `XOR`.

### `bw_update_process_chain`
Replace the step model (nodes and edges) of an existing Process Chain, preserving the existing trigger node and scheduling. Optionally overrides description and InfoArea. Replaces the whole step model, so every step that should survive must be listed — for a small change to a large chain prefer the in-place tools below.

### `bw_activate_process_chain`
Activate an existing Process Chain. Returns the top-level activation message, severity, and full log.

### `bw_append_process_chain_dtp`
Add one DTP load step (optionally followed by its own DSO activation step) to an existing Process Chain. `before` / `after` place the whole block **in series** relative to an existing step — the target's incoming (or outgoing) edges are rerouted through the block, so the new steps really run ahead of (or behind) it. Without them the block is only appended behind the strand end and runs in parallel to the target's existing successors.

### `bw_swap_process_chain_dtp`
Swap one DTP load variant for another in an existing Process Chain, keeping the surrounding edges intact.

### `bw_add_process_chain_error_links`
Add on-error (negative) links to an existing Process Chain by mirroring the existing success links.

### `bw_create_decision_variant`
Create a DECISION process variant (a standalone TLOGO object) for use as a branch/decision step in a Process Chain.

### `bw_add_process_chain_program`
Add an "Execute ABAP Program" step (RSPC process type ABAP) to an existing Process Chain, optionally with a named SE38 selection variant. In-place edit — the program call is stored as an inline process variant inside the chain model (no separate variant object). Positioning via `before` / `after` / `predecessor` (default: strand end closest to the trigger); idempotent (a matching ABAP step is skipped), with ETag concurrency and transport handling.

### `bw_add_process_chain_edge`
Add one dependency between two existing steps of a Process Chain. Edge condition defaults to neutral out of the trigger or a collector, positive elsewhere; `sub_status` addresses a DECISION branch. An "always continue" dependency is two edges (positive plus negative), so call it twice. Idempotent — an identical edge is skipped without writing.

### `bw_remove_process_chain_edge`
Remove the dependency between two existing steps. By default both halves of an "always continue" link go; `status` narrows the removal to one of them.

### `bw_remove_process_chain_step`
Remove one step from a Process Chain together with its edges and its inline process variant. By default the gap is bridged — every predecessor takes over every successor, keeping the condition of the edge that ran into the removed step — so the strand stays connected. The trigger cannot be removed.

Steps are addressed by name in all three tools: a DTP or process-variant name, an aDSO held by an `ADSOACT`/`ADSOREM` step, the program of an `ABAP` step (or `PROGRAM/VARIANT`), a collector type, or `#<index>` using the step numbers from `bw_get_process_chain`. An ambiguous name is rejected with the candidates listed rather than resolved by guesswork.

---

## Process Chains — monitoring

### `bw_list_process_chain_runs` _(Read only)_
List execution runs of one or all process chains from the monitoring log — one row per run with overall status, runtime deviation, start/end timestamps and duration. Filter by chain name, start date range and status code. Each row carries the `log_id` to pass into `bw_get_process_chain_run_detail`. Ordered by start time descending, default 20 runs.

### `bw_list_process_chain_last_status` _(Read only)_
The latest execution status and scheduling state of every process chain in the system, one row per chain — last run status, runtime deviation, scheduling status, next scheduled start, and the `log_id` of the most recent run. Chains that have never run appear too. Optionally filtered by the status of the last run or by its start date range.

### `bw_get_process_chain_run_detail` _(Read only)_
The execution detail of one run — every process step with type, variant, status, timestamps and parent/child relationships, plus the full message log. `chain_id` and `log_id` come from the two listing tools above. This is the tool to diagnose a failed run: the message log carries the actual error.

---

## Requests, Runtime & Remodeling

### `bw_list_requests` _(Read only)_
List load requests for a target InfoProvider via the BW/4HANA manage API — status, last process status and last action, record count, timestamp, user, and TSN. The TSN feeds `bw_get_request`.

### `bw_get_request` _(Read only)_
Full status analysis of one load request in a single call — request header, DTP information (start/finish/duration), process step chain, and message log. Output format: `text` (default) or `raw` (parsed JSON of all four payloads).

### `bw_activate_request`
Activate loaded data (DSO request activation) — move a finished load from the inbound table into the active data table and change log. This is the runtime request activation (BW/4HANA manage API), distinct from the modeling-object activation done by `bw_activate`; it applies only to aDSOs that have an activation step and runs asynchronously.

### `bw_list_remodeling_requests` _(Read only)_
List remodeling requests from the remodeling monitor — InfoProvider, rule, decoded status, last run, and creator. Remodeling restructures an existing InfoProvider (adding, deleting or reassigning a field) and converts the data it already holds. Filter by `info_provider` and by status (`N` not scheduled, `S` scheduled, `R` running, `C` completed, `E` error).

### `bw_get_remodeling_request` _(Read only)_
Full status of one remodeling request — header, the five processing steps (`CHECK`, `SAVE`, `CONVERT`, `ACTIVATE`, `CLEANUP`) with their individual status, and the application log messages grouped per step. The request is addressed by `info_provider` plus `remodeling_rule`; the internal request GUID is resolved automatically. This is the tool to diagnose a failed remodeling.

### `bw_run_remodeling`
Start, restart or reset a remodeling request — `action` = `execute` \ `restart` \ `reset` \ `reset_step`. `start` accepts `immediate` (default) or an ISO 8601 timestamp to schedule the background job. Runs asynchronously; monitor completion with `bw_get_remodeling_request`. Note: executing a rule restructures the InfoProvider and converts its existing data — this is not a plain reload and cannot simply be undone. Remodeling rules themselves are created in the BW Modeling Tools; this tool family monitors and runs the resulting requests.

---

## Push API

### `bw_get_push_schema`
Get the expected JSON schema for pushing data into a write-interface aDSO.

### `bw_push_data`
Push a JSON record array directly into a write-interface aDSO via the BW Push API (`/sap/bw4/v1/push/`).

---

## General

### `bw_activate`
Activate one or more BW objects. Handles impact analysis and automatically deactivated DTPs. Supports: `adso`, `iobj`, `trfn`, `dtp`, `rsds` (DataSource).

### `bw_unlock`
Release a lock on a BW object without activating (discard changes).

### `bw_delete`
Delete a BW object. Works for aDSO, InfoObject, InfoArea, and other types.

---
