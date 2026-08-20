# Architecture — bw-modeling-mcp

Technical reference for the bw-modeling-mcp server: internal architecture, API discovery, and complete BW/4HANA Modeling REST API endpoint reference.

---

## Stack

| Component | Technology |
|---|---|
| Language | TypeScript |
| MCP SDK | `@modelcontextprotocol/sdk` |
| HTTP client | `axios` |
| XML parsing | `fast-xml-parser` |
| Runtime | Node.js 18+ |

---

## Authentication & Session Management

The BW Modeling REST API uses cookie-based sessions with CSRF token protection.

**CSRF Token Fetch:**
```
GET /sap/bw/modeling/discovery
Headers: X-CSRF-Token: Fetch
→ Response header: X-CSRF-Token: <token>
```

The token is fetched once at startup and reused for all subsequent write operations (PUT, POST). Session cookies are maintained across requests via `axios` cookie jar.

**Cookie mode (BW Bridge / SAML- or OAuth-fronted systems):** When `BW_COOKIE_FILE` is set, the client authenticates with cookies exported from an authenticated browser session instead of Basic Auth (`BW_USER` / `BW_PASSWORD` become optional). The cookie file is read in Netscape format (7 tab-separated fields) or as simple `name=value` lines. In this mode the stateful headers (`sap-client`, `X-sap-adt-sessiontype: stateful`) are not sent as defaults — BW Bridge rejects stateful requests with HTTP 401 when no backend session exists on the targeted app instance. Cookies loaded from the file are "frozen" and never overwritten by `Set-Cookie` responses. When the session expires, refresh the cookies in `BW_COOKIE_FILE` and restart the server.

**Important:** Lock and write operations on the same object must use separate `BwClient` instances (separate `sap-contextid` session cookies). SAP's internal buffer caches object state per session — reusing the same session for both Lock and PUT causes null pointer crashes in the ABAP backend (`CL_RSTRAN_TRFN=>GET_PROGID`). This is not documented in the API — discovered via ABAP debugging.

**Central hosting (SAP BTP Cloud Foundry):** The HTTP transport (`src/http.ts`) puts XSUAA OAuth in front and a BTP destination behind. XSUAA authenticates each caller and carries the `read` / `write` scopes (`src/scopes.ts`, which also filters `tools/list` per role). The destination (`src/destination.ts`) decides the BW identity: with `BasicAuthentication` all callers share one technical user; with `PrincipalPropagation` each caller reaches BW as themselves via a short-lived X.509 certificate issued by the Cloud Connector and mapped to an ABAP user by CERTRULE. The server is stateless — a fresh `BwClient` per request, held in an `AsyncLocalStorage` (`src/request-context.ts`) so concurrent users never share a session. stdio (`src/stdio.ts`) is unaffected: one process, one user, no auth. Setup: `docs/CENTRAL-HOSTING-SETUP.md` and `docs/CLOUD-FOUNDRY.md`.

---

## Lock → Read → Modify → PUT → Activate Pattern

All write operations on BW objects follow this protocol:

```
1. POST /sap/bw/modeling/{type}/{name}?action=lock
   → Response body: lockHandle (long hex string)

2. GET  /sap/bw/modeling/{type}/{name}/m
   → Full XML of the object (inactive version)

3. Modify XML in memory

4. PUT  /sap/bw/modeling/{type}/{name}/m?lockHandle={handle}
   → Send full modified XML (never partial updates)

5. POST /sap/bw/modeling/activation
   → Promotes inactive version (m) to active (a)

6. POST /sap/bw/modeling/{type}/{name}?action=unlock  (if not activating)
```

**Object versions:**
- `m` = inactive/modified version (what you edit)
- `a` = active version (what is in production)

Always read `m`, write to `m`. Activation promotes `m` → `a`.

---

## Transport Request Handling

Transport request numbers (`corrNr`) are passed as URL query parameters on PUT operations — not as HTTP headers:

```
PUT /sap/bw/modeling/{type}/{name}/m?lockHandle={handle}&corrNr={transport}
```

---

## Media Type Discovery

Media types for each BW object type are loaded dynamically at server startup from the Discovery endpoint:

```
GET /sap/bw/modeling/discovery
```

This returns a self-describing service document with all available workspaces, object types, and their required media types. The server filters out `+json` variants where XML is required (e.g. for Lock endpoints).

---

## Push API

Write-interface aDSOs support direct data push via a separate API:

```
Base URL: /sap/bw4/v1/push/
CSRF:     GET /sap/bw4/v1/push/requests → X-CSRF-Token header
Body:     JSON array of records
Success:  HTTP 204 No Content
```

The Push API uses a separate `axios` client instance independent of the BW Modeling client.

---

## Source Structure

```
src/
├── index.ts              # createServer() — tool definitions and dispatch; a run-as-main guard also makes it a valid stdio entry
├── stdio.ts              # stdio transport entry point (default bin) — one process, one user, no auth
├── http.ts               # HTTP transport entry point (SAP BTP Cloud Foundry) — Express + XSUAA OAuth, a fresh per-request BW client
├── destination.ts        # builds a BwClient from a BTP destination (PrincipalPropagation or BasicAuthentication)
├── request-context.ts    # AsyncLocalStorage holding the per-request BW client under principal propagation
├── scopes.ts             # read/write scope classification and tools/list filtering for XSUAA role-based access
├── bw-client.ts          # HTTP client (CSRF, session, lock/unlock, GET/PUT/POST/rawGet/rawPost/rawPut)
└── tools/
    ├── activation.ts     # bw_activate, bw_unlock
    ├── adso.ts           # bw_get_adso, bw_create_adso, bw_update_adso
    ├── composite_provider.ts # bw_get_composite_provider, bw_create_composite_provider,
    │                     # bw_update_composite_provider — inputs, mappings, joins, settings
    ├── composite_provider_update.ts # bw_update_composite_provider — add_field, remove_field
    ├── cp_components.ts  # bw_get_ckf, bw_get_rkf, bw_get_structure
    ├── cto.ts            # bw_change_package — package reassignment via /sap/bw/modeling/cto/write;
    │                     # bw_list_changeable_transports — transport state via cto/check
    ├── dataflow.ts       # bw_get_dataflow — transient data flow graph via /sap/bw/modeling/dmod/8TRANSIENT
    ├── datasource.ts     # bw_list_source_systems, bw_list_datasources, bw_get_source_system,
    │                     # bw_get_datasource, bw_preview_datasource,
    │                     # bw_list_remote_entities, bw_create_datasource,
    │                     # bw_change_datasource_delta, bw_set_datasource_fields
    ├── delete.ts         # bw_delete
    ├── dtp.ts            # bw_get_dtp, bw_get_dtps, bw_create_dtp, bw_run_dtp, bw_update_dtp, bw_set_dtp_filter_routine
    ├── infoarea.ts       # bw_get_infoarea, bw_create_infoarea, bw_move_object
    ├── infoobject.ts     # bw_get_infoobject, bw_create_infoobject, bw_update_infoobject
    ├── infosource.ts     # bw_get_infosource, bw_create_infosource, bw_update_infosource
    ├── metadata_tables.ts # bw_read_metadata_tables — reads TRFN, DTPA and the classic providers
    │                     # (ODSO, CUBE, MPRO) from their metadata tables via ADT DataPreview,
    │                     # for systems that publish no REST resource for them
    ├── openhub.ts        # bw_get_open_hub
    ├── planning.ts       # bw_get_aggregation_level, bw_create_aggregation_level,
    │                     # bw_update_aggregation_level, bw_get_planning_properties,
    │                     # bw_get_planning_sequence, bw_get_planning_function
    ├── process_chain_monitor.ts # bw_list_process_chain_runs, bw_get_process_chain_run_detail,
    │                            # bw_list_process_chain_last_status — OData-based monitoring
    ├── processchain.ts   # bw_get_process_chain — reads RSPC via bw4 API; auto-fetches variant details per step
    ├── processchain_write.ts # bw_create_process_chain, bw_update_process_chain,
    │                         # bw_activate_process_chain, bw_append_process_chain_dtp,
    │                         # bw_swap_process_chain_dtp, bw_add_process_chain_error_links,
    │                         # bw_add_process_chain_program, bw_create_decision_variant,
    │                         # bw_add_process_chain_edge, bw_remove_process_chain_edge,
    │                         # bw_remove_process_chain_step — BW4 Cockpit REST API
    │                         # (create/update support ADSOACT and ADSOREM inline variants)
    ├── processvariant.ts # bw_get_process_variant — generic variant detail reader for all 93 process types
    ├── push.ts           # bw_push_data, bw_get_push_schema
    ├── query.ts          # bw_get_query — full query definition parser (variables, layout, CKFs, RKFs, exceptions);
    │                     # bw_create_query — create empty or as a full copy (copy_from)
    ├── query_update.ts   # bw_update_query_layout, bw_update_query_filter,
    │                     # bw_update_query_key_figures, bw_update_query_settings
    ├── query_characteristic.ts # bw_update_query_characteristic — per-characteristic display and
    │                     # access properties of the rows/columns/free areas
    ├── reporting.ts      # bw_query_data, bw_get_filter_values — BICS reporting endpoint (/sap/bw/modeling/comp/reporting)
    ├── remodeling.ts     # bw_list_remodeling_requests, bw_get_remodeling_request,
    │                     # bw_run_remodeling — remodeling monitor via the bw4 manage API
    ├── repository.ts     # bw_list_contents
    ├── request_monitor.ts # bw_list_requests, bw_get_request, bw_activate_request — RSPM request monitor / data activation via the bw4 manage API
    ├── rkf_create.ts     # bw_create_rkf — create a reusable Restricted Key Figure (ELEM) via comp/enq + /rkf/<name>/a
    ├── roles.ts          # bw_get_roles, bw_get_role_queries, bw_get_query_roles, bw_set_query_roles
    ├── search.ts         # bw_search, bw_xref
    ├── system_profile.ts # bw_system_profile — platform, published endpoint groups and the two
    │                     # preconditions (Accept-header handling, ADT DataPreview access)
    ├── transport.ts      # bw_create_transport_task — add a task to a workbench transport
    └── transformation.ts # bw_get_transformation, bw_create_transformation,
                          # bw_update_transformation, bw_set_transformation_routine,
                          # bw_set_transformation_expert_routine,
                          # bw_set_transformation_routine_fields, bw_delete_transformation_routine,
                          # bw_set_transformation_runtime
```

---

## Complete BW/4HANA Modeling REST API Reference

Full endpoint list from BW/4HANA discovery — **47 workspaces, 130+ endpoints**.

The media types below are the compiled-in fallbacks. At runtime the values advertised by
the connected system's `/sap/bw/modeling/discovery` replace them, including when that
system serves a lower resource version than the fallback.

### Core Modeling Objects

| BW Object | Endpoint | Media Type |
|---|---|---|
| aDSO | `/sap/bw/modeling/adso/{adsonm}` | `adso-v1_7_0+xml` |
| InfoObject | `/sap/bw/modeling/iobj/{infoobject}` | `infoobject-v2_2_0+json` |
| CompositeProvider | `/sap/bw/modeling/hcpr/{hcprnm}` | `hcpr-v1_15_0+xml` |
| CompositeProvider from template | `/sap/bw/modeling/hcpr/{hcprnm}?copyFromObjectName={template}&copyFromObjectType=HCPR` | `hcpr-v1_15_0+xml` |
| InfoProvider as composite input | `/sap/bw/modeling/infoprov/{name}/a?view=dt` | `iprov-v1_14_0+xml` |
| Open ODS View | `/sap/bw/modeling/fbp/{fbpnm}` | `fbp-v1_0_0+xml` |
| InfoSource | `/sap/bw/modeling/trcs/{trcsnm}` | `trcs-v1_0_0+xml` |
| Transformation | `/sap/bw/modeling/trfn/{trfnnm}` | `trfn-v1_0_0+xml` |
| Transformation Formula Tokens | `/sap/bw/modeling/trfn/formula/tokens` | `trfn.formulatokens-v1_0_0+xml` |
| DataSource | `/sap/bw/modeling/rsds/{datasource}/{logsys}` | `rsds-v1_1_0+xml` |
| Aggregation Level | `/sap/bw/modeling/alvl/{alvlnm}` | `alvl-v1_0_0+xml` |
| Semantic Group | `/sap/bw/modeling/segr/{segrnm}` | `segr-v1_0_0+xml` |
| InfoArea | `/sap/bw/modeling/area/{objectname}` | `area-v1_1_0+json` |
| Source System | `/sap/bw/modeling/lsys/{sourcesystem}` | `lsys-v1_1_0+xml` |
| Open Hub Destination | `/sap/bw/modeling/dest/{destnm}` | `dest-v1_0_0+xml` |
| Document Store App | `/sap/bw/modeling/doca/{docanm}` | `doca-v1_0_0+xml` |
| HANA View as InfoProvider | `/sap/bw/modeling/hana/repository/{package}/{name}` | `hanv-v1_0_0+xml` |
| BW Hierarchy | `/sap/bw/modeling/hier/{hiernm}` | `hier-v1_0_0+xml` |
| Application Component | `/sap/bw/modeling/apco/{name}/{logsys}` | `apco-v1_0_0+xml` |
| Characteristic Relationship | `/sap/bw/modeling/plcr/{name}` | `plcr-v1_0_0+xml` |

### Process Chain & DTP Objects

| BW Object | Endpoint | Media Type |
|---|---|---|
| DTP | `/sap/bw/modeling/dtpa` | `dtp_load-v1_0_0+json` |
| Process Chain | `/sap/bw/modeling/rspc` | `application/vnd.sap.bw4.modeling.processchain-v1_0_0+json` (bw4 namespace) |
| Process Variant Detail | `/sap/bw4/v1/modeling/processtypes/{type}/variants/{name}/m` | `application/vnd.sap.bw4.modeling.processtypes+json` (Accept: `*/*`) |
| Process Types Discovery | `/sap/bw4/v1/modeling/processtypes` | `application/vnd.sap.bw4.modeling.processtypes+json` |
| Process Variant | `/sap/bw/modeling/rspv` | `rspv-v1_0_0+json` |
| Process Type | `/sap/bw/modeling/rstp` | `type-v1_0_0+json` |
| Process Trigger | `/sap/bw/modeling/rspt` | `trigger-v1_0_0+json` |
| Process Interrupt | `/sap/bw/modeling/rspi` | `interrupt-v1_0_0+json` |
| Process Event | `/sap/bw/modeling/even` | `event-v1_0_0+json` |
| HANA Analysis Process | `/sap/bw/modeling/haap` | `hanaanalysisprocess-v1_0_0+json` |
| Dataflow | `/sap/bw/modeling/dmod` | `dmod-v1_0_0+xml` |
| Dataflow Copy | `/sap/bw/modeling/dmodcopy` | `dmodcopy-v1_0_0+xml` |

### Query Designer Objects

| BW Object | Endpoint | Media Type |
|---|---|---|
| BW Query | `/sap/bw/modeling/query/{compid}/{objvers}` | `query-v1_11_0+xml` |
| BW Variable | `/sap/bw/modeling/variable/{compid}/{objvers}` | `variable-v1_10_0+xml` |
| Restricted Key Figure | `/sap/bw/modeling/rkf/{compid}/{objvers}` | `rkf-v1_10_0+xml` |
| Calculated Key Figure | `/sap/bw/modeling/ckf/{compid}/{objvers}` | `ckf-v1_10_0+xml` |
| Filter Component | `/sap/bw/modeling/filter/{compid}/{objvers}` | `filter-v1_9_0+xml` |
| Structure Component | `/sap/bw/modeling/structure/{compid}/{objvers}` | `structure-v1_9_0+xml` |
| Reporting | `/sap/bw/modeling/reporting` | `bicsrequest-v1_1_0+xml` |

### Conversion & Planning Objects

| BW Object | Endpoint | Media Type |
|---|---|---|
| Currency Translation Type | `/sap/bw/modeling/ctrt/{objname}` | `ctrt-v1_0_0+xml` |
| Unit Conversion Type | `/sap/bw/modeling/uomt/{objname}` | `uomt-v1_0_0+xml` |
| Key Date Derivation Type | `/sap/bw/modeling/thjt/{objname}` | `thjt-v1_0_0+xml` |
| Data Slices | `/sap/bw/modeling/plds/{pldsnm}` | `plds-v1_0_0+xml` |
| Planning Functions | `/sap/bw/modeling/plse/{plsenm}` | `plse-v2_0_0+xml` |
| Planning Sequence | `/sap/bw/modeling/plsq/{plsqnm}` | `plsq-v1_0_0+xml` |
| Planning Function Type | `/sap/bw/modeling/plst/{plstnm}` | `plst-v1_0_0+xml` |

### Infrastructure Endpoints

| Purpose | Endpoint |
|---|---|
| **Activation** | `POST /sap/bw/modeling/activation` |
| **Check (pre-activation)** | `POST /sap/bw/modeling/checkruns` |
| ABAP syntax check (ADT) | `POST /sap/bc/adt/checkruns?reporters=abapCheckRun` (DTP filter routine gate) |
| ELEM component enqueue (lock/unlock) | `POST /sap/bw/modeling/comp/enq/{compid}?action=lock\|unlock` (RKF/Query create) |
| Validation | `GET /sap/bw/modeling/validation?objectType=...&objectName=...` |
| Move objects | `POST /sap/bw/modeling/move_requests` |
| BW Transport | `/sap/bw/modeling/cto` |
| Change package (CTO write) | `POST /sap/bw/modeling/cto/write?package=...&corrnum=...&simulate=false` |
| Jobs | `/sap/bw/modeling/jobs` |
| BW Content (install) | `/sap/bw/modeling/bwcontent/installation` |
| Component Refactor | `/sap/bw/modeling/comprefactor` |
| Data Privacy | `/sap/bw/modeling/dpp/fields` |
| BW Utils | `/sap/bw/modeling/utils` |
| Bucket services | `/sap/bw/modeling/bucket` |
| Query replication | `/sap/bw/modeling/compreplication` |

### Process Chain Authoring Endpoints (BW4 Cockpit API)

| Purpose | Endpoint |
|---|---|
| Create / list process chains | `POST / GET /sap/bc/http/sap/bw4/v1/modeling/processchains` |
| Read / update a chain | `GET / PUT /sap/bc/http/sap/bw4/v1/modeling/processchains/{name}` |
| Activate a chain | `POST /sap/bc/http/sap/bw4/v1/modeling/processchains/{name}/activate` |
| Transport pre-check | `POST /sap/bc/http/sap/bw4/v1/modeling/transports/validateobject` |

### Process Chain Monitoring Endpoints (OData)

| Purpose | Endpoint |
|---|---|
| Execution runs | `GET /sap/opu/odata/sap/RV_C_PCMLOG_CDS/Rv_C_PcmLog` |
| Last status per chain | `GET /sap/opu/odata/sap/RV_C_PCMPROCESSCHAIN_CDS/Rv_C_PcmProcessChain` |
| Run steps | `GET /sap/opu/odata/sap/BW4_PCM_SRV/ChainProcessSet` |
| Run messages | `GET /sap/opu/odata/sap/BW4_PCM_SRV/ChainProcessLogSet` |
| Status code texts | `GET /sap/opu/odata/sap/RV_C_PCMLOG_CDS/Rv_I_Rsvpcm_State` |

### Runtime / Request Monitor Endpoints

| Purpose | Endpoint |
|---|---|
| Run (execute) a DTP | `POST /sap/bw/modeling/dtpa/executerun` |
| List load requests | `GET /sap/bc/http/sap/bw4/v1/manage/requests` |
| Request header | `GET /sap/bc/http/sap/bw4/v1/manage/requests/{tsn}/{storage}` |
| Request DTP information | `GET /sap/bc/http/sap/bw4/v1/manage/requests/{tsn}/{storage}/datatransferprocessinformation` |
| Request process steps | `GET /sap/bc/http/sap/bw4/v1/manage/processes?request={tsn}&storage={storage}` |
| Request message log | `GET /sap/bc/http/sap/bw4/v1/manage/processes/{tsn}/logs` |
| Activate loaded data (DSO request activation) | `POST /sap/bc/http/sap/bw4/v1/manage/requests/{tsn}/{storage}/activate` |
| Status domain texts | `GET /sap/bc/http/sap/bw4/v1/system/domains/{domain}/texts` |

### Repository & Search Endpoints

| Purpose | Endpoint |
|---|---|
| **BW Search** | `GET /sap/bw/modeling/repo/is/bwsearch` |
| **Cross-reference / Where-used** | `GET /sap/bw/modeling/repo/is/xref` |
| InfoProvider tree | `GET /sap/bw/modeling/repo/infoproviderstructure/{type}/{name}` |
| DataSource tree | `GET /sap/bw/modeling/repo/datasourcestructure/{type}/{name}` |
| Node path resolver | `GET /sap/bw/modeling/repo/nodepath` |
| Application log | `GET /sap/bw/modeling/repo/is/applicationlog` |
| System capabilities | `GET /sap/bw/modeling/repo/is/systeminfo` |
| BW Content structure | `GET /sap/bw/modeling/repo/bwcontentstructure` |
| Virtual folders | `GET /sap/bw/modeling/repo/virtualfolders/contents` |
| Planning view | `GET /sap/bw/modeling/repo/is/planning_view` |

### Value Help Endpoints

| Purpose | Endpoint |
|---|---|
| Component value validator | `/sap/bw/modeling/comp/validator` (RKF restriction value → internal key) |
| InfoObjects | `/sap/bw/modeling/is/values/infoobject` |
| InfoProviders | `/sap/bw/modeling/is/values/infoprovider` |
| DataSources | `/sap/bw/modeling/is/values/datasources` |
| Source Systems | `/sap/bw/modeling/is/values/sourcesystem` |
| InfoAreas | `/sap/bw/modeling/is/values/infoareas` |
| Queries | `/sap/bw/modeling/is/values/queries` |
| DSO Names | `/sap/bw/modeling/is/values/dsonames` |
| Characteristics | `/sap/bw/modeling/is/values/characteristics` |
| Characteristic Hierarchies | `/sap/bw/modeling/is/values/characteristichiers` |
| InfoObject Hierarchies | `/sap/bw/modeling/is/values/infoObjectHierarchies` |
| Aggregation Levels | `/sap/bw/modeling/is/values/aggregationlevel` |
| Conversion Routines | `/sap/bw/modeling/is/values/conversionroutine` |
| HANA Remote Sources | `/sap/bw/modeling/is/values/hana_remotesources` |
| HANA Entities | `/sap/bw/modeling/is/values/hanaentity` |
| ODP | `/sap/bw/modeling/is/values/odp` |
| ODP Context | `/sap/bw/modeling/is/values/odpcontext` |
| Open ODS Views | `/sap/bw/modeling/is/values/fbp` |
| Planable InfoProviders | `/sap/bw/modeling/is/values/planableinfoprovider` |
