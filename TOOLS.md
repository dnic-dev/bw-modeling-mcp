# Tools Reference

Every tool the server exposes — 123 in total — with what it does and the parameters that matter.
Tools marked _(Read only)_ change nothing in BW; everything else writes, activates, runs, or unlocks.
A writing tool refuses a parameter it does not declare and names the ones it takes, so a misspelt
parameter cannot be reported as applied.

For what the server can do as a whole, see [What it can do](README.md#what-it-can-do) in the README.
For the architecture and the full endpoint list, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Contents

- [Discovery & System](#discovery--system) — 6 tools
- [aDSO](#adso) — 3 tools
- [InfoObject & Hierarchies](#infoobject--hierarchies) — 7 tools
- [InfoArea, Packages & Transports](#infoarea-packages--transports) — 6 tools
- [InfoSource](#infosource) — 3 tools
- [Transformation](#transformation) — 8 tools
- [DTP (Data Transfer Process)](#dtp-data-transfer-process) — 6 tools
- [DataSource & Source Systems](#datasource--source-systems) — 9 tools
- [CompositeProvider](#compositeprovider) — 3 tools
- [Open Hub Destination](#open-hub-destination) — 1 tool
- [BW Query — modeling](#bw-query--modeling) — 20 tools
- [BW Query — data & roles](#bw-query--data--roles) — 7 tools
- [Integrated Planning](#integrated-planning) — 13 tools
- [Conversion Types](#conversion-types) — 2 tools
- [Process Chains — authoring](#process-chains--authoring) — 13 tools
- [Process Chains — monitoring](#process-chains--monitoring) — 3 tools
- [Requests, Runtime & Remodeling](#requests-runtime--remodeling) — 7 tools
- [Push API](#push-api) — 2 tools
- [General](#general) — 3 tools

---

## Discovery & System

### `bw_search`
Search BW objects by name or description. Supports wildcards (`*`). Optionally filter by object type (`ADSO`, `IOBJ`, `TRFN`, `DTPA`, etc.).

Which type filters the search service accepts depends on the release. Where it rejects one, the search runs unfiltered and is narrowed to the requested type afterwards, and the answer says so. Analysis processes (`ANPR`) and InfoPackages (`ISIP`) are not in the search index on any release; the answer names the call that lists them instead (`bw_read_metadata_tables` with a pattern, or `bw_xref` on the provider or DataSource).

### `bw_xref`
Find all objects that reference a given BW object (where-used analysis). Use this to find Transformations and DTPs connected to an aDSO, or to find the process chain(s) a DTP belongs to (`object_type=DTPA`).

Every transformation and DTP hit carries its source and target (type and name) and its **direction** relative to the object asked about: `upstream` (feeds it) or `downstream` (fed from it). Following the upstream hits one hop at a time traces a data flow back to its DataSource.

On classic SAP BW, `bw_xref` on an aDSO, classic DSO, InfoCube, MultiProvider or InfoObject also lists the **analysis processes** that write to it (upstream) or read from it (downstream) — the backend's where-used index leaves them out. They are read through ADT DataPreview; without ADT access the list comes back without them, with a line saying they were not checked. On a MultiProvider the part providers are not where-used hits: `bw_read_metadata_tables` with `object_type="MPRO"` lists them with their type.

On every release, `bw_xref` on a provider (aDSO, classic DSO, InfoCube, MultiProvider, CompositeProvider or InfoObject) lists the **aggregation levels** built on it as `upstream`: planned values reach the provider through them. `bw_xref` with `object_type=ALVL` lists, next to the queries on the level, the InfoProvider underneath (`downstream`) and the **planning functions** on the level (`upstream`, with their function type). A lineage followed hop by hop therefore reaches the planning input of a provider. Both come from the aggregation level and planning function definitions through ADT DataPreview; without ADT access the answer says they were not checked.

For DataSources (`object_type=RSDS`): pass `source_system` — the correctly space-padded objectName is built automatically.

### `bw_system_profile` _(Read only)_
Report what the connected BW system is and which tool groups work on it. Distinguishes SAP BW/4HANA from classic SAP BW via the system's own `b4hanamode` flag, lists which REST endpoint groups the system publishes, and verifies three preconditions: whether `Accept`-header handling works (a broken one makes almost every call fail with HTTP 406 on BW 7.5 — see [bw75/BW75-SUPPORT.md](bw75/BW75-SUPPORT.md)), whether the ADT DataPreview service is reachable for this user, and whether the BICS reporting resource is implemented (classic BW publishes the endpoint without implementing it). Call it before planning work on a system whose release is not already known: the answer says which tool groups are available and, where they are not, which route to take instead. It also lists every tool the platform verdict hides, with the reason — the same verdict `tools/list` is filtered by, so the two cannot disagree.

### `bw_read_metadata_tables` _(Read only)_
Read an object definition directly from its metadata tables, via the ADT DataPreview service. Read-only fallback for the object types a system publishes no REST resource for — on classic SAP BW typically transformations and DTPs, and on every release the classic providers. Supported `object_type`: `TRFN` (including start, end, expert and field routine source code), `DTPA`, `ADSO` (load history only — structure and settings come from `bw_get_adso`), `ODSO`, `CUBE`, `MPRO`, `RSPC`, `RSPCLOG` (chain runs), `ANPR` (analysis process), and the planning objects `PLSE`, `PLSQ`, `PLCR` and `PLDS` — a process chain comes back with its steps, their variant parameters and the dependencies between them, resolved into the order the chain actually runs (the tables return the rows in no particular order, and a collector has one row per incoming link). The planning objects come through the same tool: `PLSE` (planning function — function type and its exit class, aggregation level, characteristic usage, conditions, and the parameter tree with its selections, with variable references resolved and a FOX formula returned as source code), `PLSQ` (planning sequence — steps in execution order with aggregation level, function and filter), `PLCR` (planning properties of an InfoProvider — key date, save strategy and the characteristic relationships) and `PLDS` (data slices of an InfoProvider; no release publishes a REST resource for those, so this is the only route to them on any platform). `PLCR` and `PLDS` are keyed by the InfoProvider, not by the aggregation level. `ANPR` reads an **analysis process** (APD): nodes in execution order with the object each source reads and each target writes, the edges between them with their field rules (which source field goes to which target field, and which target fields are set to a constant), filters, formulas and the ABAP of a routine node — no release publishes a REST resource for it and BW/4HANA dropped the object type, so this is the only route on any platform. A pattern such as `Z*` lists the matching analysis processes, which the BW search index does not contain. `ISIP` reads an **InfoPackage** (classic SAP BW only): DataSource and source system, the file settings — location, name, type, and the separator and escape characters decoded from their hex form with the raw value alongside — the selections with any dynamic time selection, OLAP variable or ABAP routine (the routine code included), deletion settings, the process chains that run it, and the load history from `RSREQDONE` with the update mode of each run. The update mode of the definition itself is not held in any relational column and is reported as not readable; a local-workstation file is flagged as unschedulable. Passing a DataSource name instead of an InfoPackage id lists that DataSource's InfoPackages. `RSPCLOG` reads process chain **runs** (the definition stays `RSPC`): a chain name gives the run history newest first plus the steps of the newest run, a 25-character log id gives that run's steps with status, start, duration and process variant, and a pattern such as `Z*` gives the last status of every matching chain. Status codes come back as the raw letter plus its colour and meaning. Classic DSOs, InfoCubes and MultiProviders list each InfoObject with its kind, data type with length and a text in the logon language, characteristics and key figures apart; a MultiProvider also names the part providers each InfoObject is identified in. `TRFN` shows the global declarations of the routines (`globalPart`, `globalPart2`) ahead of the routines. For an `ANPR` reading a query, the query source lists its output fields with the structure element and key figure behind each generic `KYF_000n`. A MultiProvider lists its part providers with their type (`CUBE`, `ODSO`, `ADSO`, …), so each can be passed on directly, and a provider read under the wrong type names the type it exists as. InfoCubes and DataStore objects additionally report their **load history**: request, status, update mode, start time, user, duration, records transferred and added, and the source. On classic BW that is the only way to see load status at all, since the manage API behind `bw_list_requests` does not exist there. Requires ADT authorization for the calling user; prefer `bw_get_transformation` where the REST endpoint exists.

### `bw_list_contents` _(Read only)_
Navigate the BW repository tree. Pass a path such as `""` (all InfoAreas), `"area/MYAREA"` (InfoArea contents), `"hcpr/CP_NAME"` (CP sub-folders), or `"adso/ADSO_NAME/trfn"` (Transformations on an aDSO). Each entry includes `children_path` to drill down further.

### `bw_get_dataflow` _(Read only)_
Read the complete structural data flow of a BW object — all connected sources and targets resolved recursively through Transformations, DTPs, InfoSources, aDSOs, DataSources, CompositeProviders, and InfoObjects. Mirrors the Eclipse BWMT Transient Data Flow view. Supports direction (`upwards` / `downwards` / `both`) and configurable depth. Note: routine-based lookups (ABAP/SQLScript) are not reflected — only structural BW dependencies.

---

## aDSO

### `bw_get_adso`
Read the full structure of an aDSO — fields, key fields, settings, version state. The modelling type is shown with the `adso_type` preset that creates it. On a classic release a compressing staging aDSO and a standard aDSO without change log carry the same settings; both are named then.

### `bw_create_adso`
Create a new aDSO. Supports two modes: `from_template` (copies structure from an existing aDSO) or `empty`. Supports all aDSO type presets including write-interface (`pushMode`). The result names the type the server kept (`adso_type`) and warns if it differs from the requested preset.

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

## InfoObject & Hierarchies

### `bw_get_infoobject`
Read an InfoObject definition (Characteristic or Key Figure).

### `bw_create_infoobject`
Create a new InfoObject. Supports:
- **Characteristic (CHA):** all data types (CHAR, NUMC, DATS, TIMS, SNUMC), with or without master data and texts, with compound parent InfoObjects, with referenced InfoObject, and the lower case flag (`lower_case`)
- **Key Figure (KYF):** all types (NUM, AMT, QTY, DAT, INT), all aggregations (SUM, MAX, MIN)

Created as inactive — activate with `bw_activate`.

`lower_case` switches off the permitted-character check (RSKC) for the characteristic, which is
what makes values holding lower case letters or umlauts loadable at all. Without it such a value
passes the load itself — a push even answers HTTP 204 — and is only rejected later, when the
request is activated.

### `bw_update_infoobject`
Change the description, the lower case flag (`lower_case`), or the attribute list of an existing
Characteristic; set `fixed_unit` / `fixed_currency` on a Key Figure. Supplying `attributes`
replaces the whole list (`[]` removes all of them); omitting it leaves the attributes untouched.
The lower case flag can be changed on a characteristic that is already used by a provider holding
data — a request that failed activation on such a value can then be activated again.

### `bw_get_hierarchy` _(Read only)_
Without `hierarchy_name`, the hierarchies of a characteristic with version, validity, levels and node
count. With it, the tree: every node with its type (text node or characteristic value), name, text and
node id, indented by level. The tool to find the node to filter on in `bw_query_data`, and to read a
tree before changing it. BW/4HANA only.

### `bw_create_hierarchy`
Create a hierarchy for a characteristic with hierarchies switched on and activate it. The tree is passed
nested: a text node `{ "text_node": "NAME", "text": "...", "children": [...] }` groups other nodes, a
value node `{ "value": "..." }` is a value of the characteristic and may have children of its own. Each
node appears once in a hierarchy. `activate: false` keeps it as revised version. Hierarchies that are
neither time- nor version-dependent. BW/4HANA only.

### `bw_update_hierarchy`
Change the description and/or the tree of a hierarchy, then activate it. The tree is replaced as a
whole: read it with `bw_get_hierarchy`, change it, and pass the complete new tree in the form
`bw_create_hierarchy` takes. The hierarchy keeps its id, so the queries that use it keep working.
BW/4HANA only.

### `bw_delete_hierarchy`
Delete a hierarchy, or with `version: "M"` only a pending revised version of it. BW/4HANA only.

---

## InfoArea, Packages & Transports

### `bw_get_infoarea`
Read an InfoArea definition — name, label, parent area, object status.

### `bw_create_infoarea`
Create a new InfoArea. Immediately active after creation, no activation step needed.

### `bw_move_object`
Move any BW object (aDSO, InfoObject, InfoArea, etc.) to a different InfoArea. With `position: "before"` an InfoArea is placed before the target on its level instead of inside it; next to a top-level InfoArea this moves it to the top level of the tree, which has no InfoArea of its own to move into.

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
Read a Transformation structure including all field mapping rules, routines, source, and target. A rule into a target key figure shows its aggregation type (`{AGGREGATION: SUM}`, `MOV`, …); on a classic release `bw_read_metadata_tables` with `object_type="TRFN"` shows it the same way. Transformation names are UUID-like keys — use `bw_xref` on the target aDSO to find them.

### `bw_create_transformation`
Create a new Transformation. Supports all source types (aDSO, InfoSource, DataSource/RSDS) and all target types (aDSO). For InfoObject (`IOBJ`) sources or targets, set `source_object_subtype` / `target_object_subtype` to select the facet — `TEXT` (text table), `ATTR` (attributes / master data), or `HIER` (hierarchy). Can copy structure from an existing Transformation. In a transportable package, `transport` records it on the given request; `activate: true` activates it in the same call, and the answer then carries the activation messages.

### `bw_update_transformation`
Modify field mappings in an existing Transformation:
- Map source field to target InfoObject (StepDirect)
- Set or change the formula rule of a target field (StepFormula) — every operand of the expression is registered as a source of the rule, so a formula over several source fields works, and the formula text of an existing formula rule can be replaced
- On a key figure with a currency or unit, a direct, formula or constant rule takes the value over unconverted. With `conversion` a direct rule converts it instead — `type` `"currency"` with a currency translation type or `"unit"` with a unit conversion type, given as `name`. The name is checked against the conversion types defined on the system; the source currency or unit comes from `source_unit_field`, else from the source key figure's own unit reference, and a conversion type with a fixed source needs neither
- Set the aggregation type of a rule into a target key figure with `aggregation`: `SUM` (summation), `MOV` (overwrite), `MIN`, `MAX` or `NOP` (no aggregation). It decides what happens when several source records end up in one target record — in an aggregating transformation a key figure on `MOV` keeps one record per group without any error. Given with only `transformation_name` and `target_infoobject`, it changes the aggregation and leaves the rule as it is; given with a rule change, both are saved together. A characteristic, an unknown field and a target field whose aggregation the target fixes are refused

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
Read the full definition of a single DTP — source, target, transformation reference, extraction settings (mode, package size), and all filter fields including value selections and routine code. DTP names are UUID-like keys — use `bw_xref` or `bw_get_dtps` to find them. `format: "raw"` returns the unmodified XML.

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
Read the complete structure of a DataSource (RSDS): metadata (status, delta type, direct access, application component, package, timestamps), all fields with type, length, transfer flag, key flag, position, selection options, conversion exit, and unit/currency reference, plus active adapter configuration (ODP, HANA, File, CSV). Output format: `text` (default human-readable summary) or `raw` (XML from BW). A DataSource without a delta process shows `none (full loads only)`; one without an active adapter says so, and a classic file DataSource points to its InfoPackages, where the file settings are kept.

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
Read a CompositeProvider (HCPR) — view node type (Union/Join), source providers with input mapping counts, all fields with their field group (`dimension`) and, for InfoObject-bound fields, their `name_usage`, the declared field groups with label and field count, join conditions, and temporal join details. A field with `name_usage` `"unique_name"` is found by a query only under `<prefix>-<FIELD>`, not under its InfoObject name; `fields.unique_name_count` says whether there are any.

### `bw_create_composite_provider`
Create a CompositeProvider. Without `copy_from`, a view node of the given type with the listed source providers attached — entity only, so give them their mappings afterwards with `bw_update_composite_provider` action `update_mapping`. A Union node may be created empty; a Join node must be created with its sources, since a join node without inputs makes the server dump. With `copy_from`, the server copies view node, inputs and mappings from an existing CompositeProvider. The result is inactive.

### `bw_update_composite_provider`
Change a CompositeProvider. Ten actions: `add_field` / `remove_field` for fields, `add_input` / `remove_input` for source providers, `update_mapping` for one input's complete mapping list (omit the mappings to map every source field one to one), `update_join` / `remove_join` per input pair, `update_fields` / `update_group` for field groups and name usage, and `update_settings` for description, stackable, default node and aggregation behaviour. Every action returns a `lock_handle` that `bw_activate` needs — an HCPR cannot be activated without it.

Fields the tool creates are ready for a query: a field named after its InfoObject uses that InfoObject directly by name (`name_usage` `"direct"`), and every new field goes into the field group `CHARACTERISTICS` or `KEYFIGURES`. `name_usage` (`"direct"` / `"unique_name"`) and `dimension` (a field group) change that for all fields one call creates, or per entry in `mappings`. Two fields cannot use the same InfoObject directly; the second is refused. Technical fields of the source (record count, currency/unit dimension) are left out of auto-mapping.

`update_fields` takes the fields in `info_object_name` and moves them into `dimension` and/or switches them to `name_usage`. `update_group` creates the group named in `dimension` (with `label`), relabels it, or renames it to `new_dimension_name` together with its fields. A group other than `CHARACTERISTICS` / `KEYFIGURES` must be created before fields are put into it; an unknown group is refused with the declared groups listed.

Two things to know: both sides of a join key must be mapped onto the **same** target field, otherwise activation fails with "join fields need at least one common target field" — auto-mapping deliberately does not do this, so map the second side's key fields explicitly. And `remove_input` leaves the removed input's elements and any join referencing it behind; those have to be cleaned up separately.

---

## Open Hub Destination

### `bw_get_open_hub` _(Read only)_
Read an Open Hub Destination (DEST) — destination type, source, DB table, InfoArea, package, status, and the complete output field list with type/length, InfoObject binding, conversion routine, compounding and key flag, plus the file properties when the destination type is FILE.

---

## BW Query — modeling

### `bw_get_query` _(Read only)_
Read a BW Query definition — variables with where each one is used, filter logic (fixed values and variable references resolved), layout with full member lists, calculated key figures with recursively resolved formulas, restricted key figures with selection conditions, exceptions, cell definitions, and query settings. Grid cells are listed with the descriptions of the two members they sit on, help cells with their formula or selection, and cell formulas with their operands resolved to those labels rather than to cell ids. Each member carries its exception aggregation where one is set (`exc.agg=SUM(CHARACTERISTIC)` in the text form, `exceptionAggregation` in `raw`); a member that shows a reusable CKF reports the CKF's own setting next to it, since that is the one a formula referencing the CKF computes with. The status reflects the version that was read — a query has no activation step, and the server's own status field has been seen calling a query with a full A version inactive. Output format: `text` (default, compact human-readable summary) or `raw` (full parsed JSON). Each selection member names the key figure or calculated/restricted key figure behind it and its restrictions (`Selection:`); the header carries the query's component UID and the provider with its type and TLOGO, classic providers included. Each variable lists where the query uses it — filter, default value, the key date, a structure member, a formula, a CKF or RKF, an exception, condition or cell, or a text — and a variable referenced nowhere says so (`no use found in the query definition`) rather than leaving the reader to infer it. The settings carry the key date: the system date, a fixed date, or a variable with its name. Each characteristic in the layout that has a display hierarchy shows it on a line of its own: name or variable, active or only assigned, version, key date and the display options that differ from the default.

### `bw_create_query`
Create a new, consistent Query (TLOGO ELEM) on an InfoProvider in package `$TMP`. Without `copy_from` the query is created empty and consistent (no rows, columns, or key figures yet). With `copy_from` it is created as a full copy of an existing query (layout, filter, variables, key figures); when no `infoprovider` is given it defaults to the source query's provider.

### `bw_update_query_layout`
Edit the query layout — add/remove rows, columns, structures, and free characteristics. Accepts an optional `transport` request number for queries on a transportable package.

### `bw_update_query_filter`
Edit the query filter — fixed value restrictions on characteristics. Accepts an optional `transport` request number.

### `bw_update_query_key_figures`
Edit the query key figures — add basic key figures, references to global RKFs/CKFs, and local formula members; set exception aggregation on formula members, display properties (decimals, scaling, hidden, sign inversion), planning properties (input readiness, disaggregation, constant selection) and the local calculation (calculate results as, calculate single values as, use single values for the result, cumulation); nest members under others and insert them at a position; remove members. An unknown property or calculation literal is refused rather than dropped. Formula members accept a recursive operator/operand tree covering the full BW operator catalog (basic, percentage, data, mathematical, trigonometric, and boolean operators plus ternary `IF`); operator codes are case-insensitive and their operand counts are validated before saving. An operand can be a formula variable (`{ "type": "variable", "variable_name": "..." }`); it is embedded in the query on save, and a characteristic variable is refused. Exception aggregation is refused on a selection member — a basic key figure or a CKF/RKF reference — because the backend drops it there without an error on a classic release and on BW/4HANA alike; set it on the CKF itself instead. An aggregation type outside the sixteen literals of the aggregation domain is refused too, rather than being stored as standard aggregation. Accepts an optional `transport` request number.

### `bw_update_query_settings`
Edit query properties (settings). Accepts an optional `transport` request number.

### `bw_update_query_characteristic`
Set the per-characteristic display and access properties of the rows, columns, and free-characteristics areas — display of result rows, display as key/text (with short/medium/long text), access type for result values (read mode), sorting, cumulation, display level, and the hierarchy assignment with its display options (expand-to-level, child node position, postable node values, single-child suppression, hierarchy sorting). Pass `"*"` as `infoobject` to apply one set of properties to every characteristic in the layout; every property also accepts `"default"` to drop the explicit value. Accepts an optional `transport` request number.

### `bw_update_query_cells`
Manage the cell definitions of a query with two structures, one on each axis — the level below the member tree, where a column that never carries data of its own gets its value per row from a formula. Add a reference cell at the intersection of a member of each structure (it makes the value there addressable), a formula cell at an intersection, or a help cell outside the grid: a formula cell such as a unit-free denominator, or a selection cell with its own key figure and restrictions. `update_cell` changes a cell's formula, description, decimals or scaling; `remove_cell` removes it and is refused while another cell's formula still references it. Members and cells are addressed by description or id, the two members of an intersection in either order — the tool works out which structure each belongs to. A cell formula references cells only and uses the operator catalog of `bw_update_query_key_figures`; an operand naming an intersection (`row_member` / `column_member`) that has no cell yet gets its reference cell created in the same save. Decimals and scaling set on a cell are also entered in the query's priority lists, which is what lets them win over the settings of the two members the cell sits on. All operations are applied in one save; accepts an optional `transport` request number.

### `bw_create_variable`
Create a characteristic variable. Processing type: `UserEntry`, `CustomerExit`, `Authorization` or `ReplacementPath`. Represents a characteristic value, a hierarchy or hierarchy nodes; selection as `Interval`, `SingleValue`, `SeveralSingleValues` or `SelectionOption`. Entry requirement, ready-for-input and reusability are parameters, so a variable filled only by the exit can be kept off the selection screen. Replacement path is limited to the current-member variant — replacement from a query result is not supported.

With `variable_type: "Formula"` it creates a formula variable instead: a number filled by `UserEntry` or `CustomerExit`, used as an operand in query formulas and CKFs. It takes no characteristic but a `dimension` (`Number`, `Amount`, `Quantity`, `Price`, `Quota`, `Date`, `Time`), an optional `default_value`, a `unit` (required for `Quantity`), a `currency` (required for `Amount`) or either for `Price` — without the unit or currency BW saves the variable as consistent, but no query computing with it can be generated. BW reads a default value in the logon user's decimal notation, where "2.5" can become 25; the tool reads that notation and converts, so a fractional default needs read access to it (ADT DataPreview), while a whole number always works.

With `variable_type: "Text"` it creates a text variable: a single value of up to 60 characters, written as `&NAME&` into the description of a query or a structure member and replaced at runtime. By replacement path — the default when `iobj_name` is given — it shows the value of that characteristic: `replacement_type` picks the key (default), the external key or the text (`Name`), `replacement_interval` the lower bound (default), the upper bound or the difference of a range, and `offset_start` / `offset_length` cut out part of it; `replacement_variable` reads the value from a characteristic value variable on the same characteristic instead of from the characteristic itself. Such a variable is never ready for input: BW saves it as consistent, but no query using it can be generated. Filled by `CustomerExit` or `UserEntry`, it takes no characteristic. Every tool that saves a query, a reusable CKF, RKF or structure binds the text variables its descriptions name: BW replaces one only when the description also lists the variable and the query carries a copy of it, and otherwise shows `&NAME&` literally. A pair of ampersands that names no text variable is left as it is.

### `bw_get_variable` _(Read only)_
Read a variable — reference characteristic, description, variable type, processing type, selection type, entry requirement, ready-for-input, reusability, UID, package and InfoArea; for a formula variable also its dimension, default value, unit and currency; for a text variable by replacement path what it shows, which bound, the offsets and the variable it reads from. The tool to reach for after `bw_create_variable`: the modelling API accepts an enum literal it does not know, stores its default and still reports the object as consistent, so the create alone says nothing about what is in the system. Reading the variable through its query does not answer this either — a query resolves the technical name of a variable reference, never its definition. `format: "raw"` returns the unmodified XML.

### `bw_update_variable`
Change a variable in place — description, ready-for-input, entry requirement, selection type and processing type; on a formula variable also the default value (`null` removes it), unit and currency, checked against its dimension. A text variable by replacement path stays one and is never made ready for input, and it always represents a single value. The UID stays the same, so references from queries, CKFs and structures survive; the alternative before was delete and recreate, which BW refuses once the variable is referenced, and deleting a query leaves its reusable components behind. The reference characteristic and the variable type are rejected rather than sent: BW accepts such a write, reports it as consistent and keeps the old value. Switching the processing type to `ReplacementPath` writes the current-member block with it, and switching away clears it.

### `bw_get_ckf` _(Read only)_
Read a global Calculated Key Figure — formula recursively resolved to a human-readable string and as a tree, the CKF's exception aggregation (`null` for standard aggregation) in the shape `bw_create_ckf` and `bw_update_ckf` take back, metadata (package, InfoArea, author), and full dependency graph of all referenced sub-components.

### `bw_get_rkf` _(Read only)_
Read a global Restricted Key Figure — base measure, all characteristic restriction groups (field and value), and metadata.

### `bw_get_structure` _(Read only)_
Read a global Structure — all members with type (Formula/Selection), referenced components, characteristic filters, optional child members, and metadata.

### `bw_create_rkf`
Create one reusable Restricted Key Figure (TLOGO ELEM) on an InfoProvider from a base key figure plus one or more characteristic restrictions. Built for mass creation (one RKF per call); each restriction value is validated against the InfoProvider and mapped to its internal key before the write, and the RKF is written consistent (no separate activation step). Supports `Equal` / `Between` / `LessThan` / `GreaterThan` / `LessEqual` / `GreaterEqual` / `Contains` operators and exclusions, an optional InfoArea, and a transport request for transportable packages.

### `bw_update_rkf`
Change a reusable Restricted Key Figure in place — description, base key figure and/or restrictions. The UID stays the same, so references from CKFs, structures and queries survive; the alternative before was delete and recreate, which BW refuses once the RKF is referenced anywhere. Restriction values are validated against the InfoProvider and mapped to their internal key before the write, as with `bw_create_rkf`.

### `bw_create_ckf`
Create a reusable Calculated Key Figure (TLOGO ELEM) on an InfoProvider. The formula is passed as an operator/operand tree in the same node syntax `bw_update_query_key_figures` uses for `add_formula`, so a tree read back from `bw_get_ckf` (field `formula_tree`) can be written again unchanged — which is what makes copying a definition between systems possible. `exception_aggregation` sets the CKF's own exception aggregation — type, one to five reference characteristics, optionally `exclude`. That is what a weighted average needs: a helper CKF "unit value × quantity" summed over the finest characteristic, divided by the quantity. A formula variable is an operand like any other (`{ "type": "variable", "variable_name": "..." }`), also in `bw_update_ckf`, and `bw_get_ckf` names it in the formula, the tree and the dependencies. Records to a transport when package and transport request are given.

### `bw_update_ckf`
Change a reusable Calculated Key Figure. Two call forms: pass `formula` to replace the whole expression, or `operations` for targeted edits that leave the rest untouched — the usual case being "add another summand to a sum" without having to know or rebuild what is already there. All operations are applied to one document and written in a single save. `exception_aggregation` sets or, with `false`, resets the CKF's exception aggregation independently of the formula.

### `bw_create_structure`
Create a reusable key figure structure on an InfoProvider — the object reporting queries embed as an axis, so that one definition drives all of them. Members reference a reusable CKF or RKF or a basic key figure, and can carry their own text.

### `bw_update_structure`
Change a reusable structure: add, remove, re-configure or move members. The change reaches every query that embeds the structure, which is the point of the object and the reason this goes at the structure rather than through one query that happens to use it. All operations are applied to one document and written in a single save. `set_member_properties` moves a member with `position` (among its siblings) and `parent` (another member, or `""` for the top level), with or without `properties`; every move is read back after the save. A call that leaves the structure as it was is not saved, so it adds nothing to the transport request.

---

## BW Query — data & roles

### `bw_query_data` _(Read only)_
Execute a BEx Query or preview data from an InfoProvider (aDSO, CompositeProvider) via the BICS reporting endpoint. Returns a formatted result table with hierarchy indentation.

Parameters: `comp_id` (query or provider name), `is_provider` (set `true` for direct aDSO/HCPR access), `state` (axis placement — ROWS/COLUMNS/FREE — and per-characteristic filters supporting EQ/BT/GT/LT/GE/LE, include/exclude, external key, internal GUID key, and hierarchy-node filters), `variables` (fill query variables; name and id must be copied verbatim from the GET response), `from_row`/`to_row` (pagination), `drill_operations` (expand or collapse hierarchy and structure nodes by 1-based tuple index: `drill_state=3` expands, `drill_state=2` collapses), `with_statistics` (see below), `format` (`text` default — formatted table; `raw` — XML).

A hierarchy node is filtered with `nodeId: 1` and the node name as `lowInt`; a text node also needs `nodeType: "0HIER_NODE"`. The node must belong to the display hierarchy of the query (`bw_get_query` shows it, `bw_get_hierarchy` its nodes); a hierarchy in the state is not applied. The text answer lists under `Not applied` what BW answered differently from the request without an error — an excluded node it applied as included, a different hierarchy, a filter value missing from the effective selection, a characteristic on another axis.

Rows and columns show exactly what the state lists there, in the order given; everything else drops out, the key figure structure too, which leaves no data. List the complete layout wanted on ROWS and COLUMNS, structures included; characteristics staying on FREE need not be listed.

BICS reports no total row count, so the text answer reads one row beyond the page and says whether the result continues (`More rows: yes — continue with from_row=…`) or ends.

With `with_statistics: true` the answer ends with the timing of the call (server total, BW HTTP request, rendering, request and response size) and the BW statistics of its navigation step: BW runtime by layer (OLAP processor, cache, authorizations, data manager and database, input help, planning, transfer to the front end, BICS provider, MDX and OLAP BAPI, remote function calls, front end and application), the top events, records read and transferred, the effective "Operations in SAP HANA" setting, and with one step in the window the split of the HTTP time into BW runtime and transfer. It needs statistics switched on for the query or provider (transaction RSDDSTAT) and ADT DataPreview access.

Always call `bw_get_query` or `bw_get_adso` first to discover the axis layout and characteristic IDs, and call `bw_get_filter_values` before setting any filter or variable value.

### `bw_query_statistics` _(Read only)_
Read the BW query statistics (RSDDSTAT) of any frontend — what RSRT statistics and ST03 show, without SAP GUI. With `query_name` or `provider` (a direct provider call is recorded under "$" or, from other front ends, "$!1" plus its name; both are read): the executions in a time window (`from` / `to`, or the last `hours`, default 24) with their count, the last one and its user, the executions per user, and min, median, p90 and max runtime — over the latest 5,000 when there are more, which the answer says — plus the breakdown of the `slowest` ones across the whole window (default 3). With `step_uid`: one navigation step in full, by layer and event, with records read and transferred, the "Operations in SAP HANA" setting and, at a statistics level that records it, the data manager time per provider. The tables are read through ADT DataPreview, so statistics must be switched on for the object and the user needs DataPreview access; it works on classic releases too.

### `bw_list_afo_workbooks` _(Read only)_
List the Analysis for Office workbooks stored in BW together with the where-used list BW keeps for them, without downloading a workbook. Per workbook: name, text (logon language, then English), document and file type, last change (user and UTC time), the data sources by alias — a query by its name, or an aggregation level or provider used directly — the planning functions and planning sequences, and every role menu the workbook is placed in, with the folder path. `used_object` answers "which workbooks use this query / planning function / planning sequence / aggregation level?"; `role` answers "which workbooks are in the menu of this role?" — it matches the role name in full (with `*` as wildcard) or a term in the role description, since menu roles are often named by a code. It covers the role menu only, not which workbooks a role is authorized to open. `name` (exact or a pattern with `*`), `user` and `changed_from` / `changed_to` narrow the list further. Reading the role menus needs DataPreview access to the role tables; without it the list comes without them and says so, and a `role` filter fails. Newest first; `max_results` (default 100) limits what is shown, the total is always reported. Workbooks kept only on a file share are not stored in BW and do not appear. Read through ADT DataPreview, so the user needs DataPreview access; works on classic releases and BW/4HANA alike.

### `bw_get_afo_workbook` _(Read only)_
Fetch one Analysis for Office workbook stored in BW, the way Analysis for Office opens it, without setting or checking the edit lock. The answer gives the workbook's text, document and file type, size, owner, last change, what the calling user may do with it (display, change, create, delete, execute — as BW reports it), its where-used list and its role menus (the same as `bw_list_afo_workbooks`; when the metadata tables cannot be read, the file still comes back and the answer says the list is missing). `save_path` writes the file: an existing directory, or a path ending in a slash, gets the workbook name and file type; a file name without an extension gets the file type; an existing file is replaced only with `overwrite: true`. It works only when the server runs locally — a hosted server would write to its own disk, so it refuses. `include_content` returns the file as base64 instead. BW checks the caller's authorization for the workbook; an unknown workbook and one the user may not open are answered alike. The file is fetched over the SOAP RFC service, so `/sap/bc/soap/rfc` must be active (transaction SICF) and the user needs `S_RFC` for `RSAO_BICS_OPEN`; behind the SAP Cloud Connector the path must also be exposed. When it is not reachable, the answer says exactly that. To see crosstabs, formulas and macros, read the saved file with an Analysis for Office workbook reader.

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
Read an Aggregation Level (ALVL) — the planning-enabled view on an aDSO or CompositeProvider used by Integrated Planning / embedded BPC. Returns the underlying InfoProvider and the element list split into characteristics (type, length, conversion routine, base InfoObject, compounding, dimension group) and key figures (aggregation behavior, semantics, and the unit/currency reference). `format: "raw"` returns the unmodified XML.

### `bw_create_aggregation_level`
Create an aggregation level (ALVL) on a planning-enabled aDSO or CompositeProvider, either over all its fields or a chosen subset. Needs at least one characteristic and one key figure. Activate with `bw_activate`, object type `alvl` and an empty `lock_handle`.

### `bw_update_aggregation_level`
Change the field selection of an existing aggregation level.

### `bw_get_planning_properties` _(Read only)_
Read the Planning Properties (PLCR) of a plan-enabled InfoProvider — key-date mode, the maximum number of characteristic combinations, the save strategy (planning sequence plus delta-read flag), the characteristic relationships (type, exit class, whether they derive or only check, source and target characteristics) and the data slices (type, active or not, exit class, selection). The data slices come from the metadata tables through ADT DataPreview, because their REST resource reports neither the selection nor whether a slice is active. The PLCR shares its technical name with the provider it belongs to. If the backend fails to build the resource (seen for providers with an exit data slice), the tool reads the same settings from the metadata tables and says so. `format: "raw"` returns the unmodified XML.

### `bw_get_planning_sequence` _(Read only)_
Read a Planning Sequence (PLSQ) — the ordered list of planning steps, each with its kind (a planning function, or manual input: an input template that only opens its filter), aggregation level, planning function and filter name. `format: "raw"` returns the unmodified XML.

### `bw_create_planning_sequence`
Create a planning sequence with its steps in execution order: a planning function with the filter that selects its data, or an input template that only opens a filter for manual input. The InfoArea defaults to that of the aggregation level of the first step, the package to `$TMP`. Saved active. A sequence cannot be executed through the REST API — the modeling tools open the embedded SAP GUI for that.

### `bw_update_planning_sequence`
Replace the steps of a planning sequence with the list given, in that order, and/or change its description. To add, remove or move one step, read the sequence with `bw_get_planning_sequence` and pass the whole new list.

### `bw_get_planning_filter` _(Read only)_
Read a planning filter — the selection a planning sequence step or an input template works on: its aggregation level, the restriction per characteristic (fixed values, ranges, exclusions, variables) and the variables it uses with their type, processing and input settings. A sequence step names its filter. `format: "raw"` returns the unmodified XML.

### `bw_get_planning_function` _(Read only)_
Read a Planning Function (PLSE) — a planning operation (formula/FOX, copy, delete, repost, distribution, currency translation, custom exit, …) tied to an aggregation level. Returns the function type, aggregation level, documentation, the characteristic usage list, and the full parameter tree; for FORMULA functions the FOX code is surfaced as source. The **block characteristics** are listed separately: every characteristic that is not to be changed. The function runs once per combination of their values, so records that differ in one of them never reach it in the same call — a custom exit that is meant to combine such records sees each of them alone. Table parameters show the key figure of each row next to the values. The answer ends with the **function type**: the class that runs it, whether it uses reference data and processes empty records, and every parameter the type takes with its InfoObject, default and whether variables are allowed — what a new function of that type can be given. `format: "raw"` returns the unmodified XML.

### `bw_update_planning_function`
Change a Planning Function: the characteristic usage (`FIELDS_TO_BE_CHANGED`, `FIELD_FOR_CONDITIONS`, `NONE`), the conditions, the parameters and the description. Only what is passed changes. A condition is given per characteristic and its constraints replace the existing ones (operators `Equal`, `NotEqual`, `Between`, `NotBetween`, `Less`, `LessEqual`, `Greater`, `GreaterEqual`, optionally `exclude`); without constraints it is removed. A parameter is named as in the parameter tree — by its path (`STRUCTURE/FIELD`) or, where unambiguous, its own name — and takes what its kind needs: a value parameter a constant or a variable; a key figure selection (`KYFSEL`) `key_figures`, named or `["*"]` for all; a key figure parameter (a reference key figure, the key figure of a value row) `key_figures` with exactly one; a data selection (the from and to selections of a copy, repost or distribution, a reference selection) `selection`, a restriction per characteristic in the same form as a condition. In a table parameter row n of every field belongs together: pass the row to set, and the row after the last one to add a row. The FOX code of a FORMULA function is the value of its `FLINE` parameter. Values are given in external format, as typed in the modeling tools (a month as `MM.YYYY`); characteristic values are checked against master data, and an unknown one is reported as an invalid format. Characteristics of a level on a CompositeProvider are accepted with or without the provider prefix. The function is saved straight to the active version; there is no activation step. The answer says whether anything was saved: an invalid value rejects the whole save, while a FOX syntax error is reported as an error and the function is stored with it. Verified on BW/4HANA with copy (also without zeros), delete, repost, distribution by key and by reference data, set values, revaluation, formula, currency and unit translation, forecasting and the characteristic-relationship and DataStore variants. Which characteristics a function may change depends on its type and the level — a forecast only its time characteristic; asking for another is refused with the ones that are allowed.

### `bw_create_planning_function`
Create a Planning Function of a given type (`0RSPL_FORMULA`, `0RSPL_COPY`, a custom type, …) on an aggregation level. The server sets up the parameters of the type and gives every characteristic the usage `NONE`; characteristic usage, conditions and parameter values can be passed in the same call and are applied right after. The InfoArea defaults to that of the aggregation level, the package to `$TMP`. Saved active.

### `bw_create_planning_filter`
Create a planning filter on an aggregation level with its restrictions in the same call: fixed values, ranges and exclusions per characteristic, and characteristic variables, which are embedded in the filter as the modeling tools do. On a level over a CompositeProvider the bare characteristic name is accepted for the prefixed field, also for the characteristic of a variable.

### `bw_update_planning_filter`
Change a planning filter: set the values or the variable of a characteristic, replacing its current restriction, remove a restriction, or change the description. Restrictions not named stay as they are; a variable no longer used is dropped from the filter.

---

## Conversion Types

### `bw_get_conversion_type` _(Read only)_
Read a currency translation type (CTRT) or a unit conversion type (UOMT): how the source and the target currency or unit are determined — fixed, from the record or chosen when converting, from an InfoObject or a variable — and for a currency the exchange rate type (fixed or from a variable), the exchange rate (from the rate tables or an InfoObject), the rate type specifics, inverse, the FI route and the time reference; for a unit the factor determination and its InfoObject. Without `kind` both types are tried. `format: "raw"` returns the unmodified XML.

### `bw_create_conversion_type`
Create a currency translation type (`kind: "currency"`) or a unit conversion type (`kind: "unit"`), saved straight to the active version, with every option the modeling tools offer. `source` and `target` each take a `kind` — `data_dependent` (the default: for a source the currency or unit of the record, for a target the one chosen when converting), `fixed`, `infoobject` or `variable` — and a `name`. A currency type needs exactly one of `rate_type` and `rate_type_variable`, and takes an exchange rate from an InfoObject, `rate_specific` (buying, middle or selling rate — BW then switches the FI route off), `inverse`, `in_transformation_only`, `via_fi_modules`, and `time`: the current date (the default), a fixed date, a date variable, the key date of the query, or a time characteristic with its reference point (end of month, start of fiscal year, …), a shift and the period handling. A unit type takes `factors` — T006, an InfoObject, SI units, or two of them in order — with `factors_infoobject` for the InfoObject-based modes, and the two flags for an initial source unit and for leaving a value unconverted without a factor. The description is limited to 40 characters for a currency type and 60 for a unit type, which the tool checks before anything is written. The answer shows the object as stored. Delete with `bw_delete`, object type `ctrt` or `uomt` — BW deletes a conversion type even when a planning function still refers to it.

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

### `bw_start_process_chain`
Start a process chain once, now, as the BW/4HANA Cockpit does with "Execute": asynchronously, in the background under the technical user of the chain, independent of its start condition and without changing its scheduling. Returns the log ID of the run, its status and the messages of the steps reached so far. `wait_seconds` (up to 600) waits for the run to end, checking every five seconds. Follow the run with `bw_get_process_chain_run_detail`. The synchronous start is not offered: it runs inside the HTTP request, where an abort message of a step cannot be shown. BW/4HANA only.

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
List load requests for a target InfoProvider via the BW/4HANA manage API — status, last process status and last action, record count, timestamp, user, and TSN. The TSN feeds `bw_get_request`. On classic SAP BW (7.5 and lower) the manage API does not exist, so this tool is not offered there — use `bw_read_metadata_tables` on the provider (`ADSO`, `ODSO`, `CUBE`, `MPRO`) for the load history instead.

### `bw_get_request` _(Read only)_
Full status analysis of one load request in a single call — request header, DTP information (start/finish/duration), process step chain, the request message log, and the message log of each process step that runs under its own TSN. That last part is where a failed request activation keeps its reason: the request-level log carries only the messages of the load itself, so the activation step would otherwise appear as a red line with no error text anywhere. Output format: `text` (default) or `raw` (parsed JSON of all payloads).

### `bw_delete_request`
Delete load requests from an InfoProvider, removing the data they brought in along with their entry in request management. This is the precondition BW demands before several follow-up steps — above all switching a DTP from delta to full extraction, which BW refuses while delta requests remain in the target. Not the same as selective deletion of records by condition, which removes rows but leaves the request. Both kinds of request are handled as BW handles them: a load request in the inbound queue is deleted, an activation request is rolled back — and a rollback also undoes every later activation and removes the load request underneath it. `all_requests=true` with `target` clears a provider completely, the regular case before an extraction-mode change. Asynchronous: a successful call starts the deletion, confirm with `bw_list_requests`.

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
Delete a BW object. Works for aDSO, InfoObject, InfoArea, and other types, including planning sequences (`plsq`), planning filters (`filter`) and conversion types (`ctrt`, `uomt`); a filter still used by a planning sequence is refused with the sequence named. The lock is released also when the delete is refused.

---
