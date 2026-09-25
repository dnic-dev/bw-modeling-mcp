# SAP BW 7.5 on HANA — Support

A classic BW 7.5 release answers almost every tool with **HTTP 406**. The cause is one
case-sensitive header lookup in the 7.5 REST framework; a small ABAP enhancement neutralises it
without modifying SAP standard. The enhancement, the SE24 steps, the rollback and the optional DTP
filter helper are in [README.md](README.md).

This page is the background: why the calls fail, what works on 7.5 once the enhancement is in
place, and what does not. Verified end-to-end on a BW 7.5 system (SAP_BASIS 750): every read in
the table below ran there, and every write tool ran there with its result read back afterwards.

---

## The symptom

Nearly every read returns:

```
HTTP 406 — ExceptionResourceNotAcceptable
Backend supports vnd.sap.bw.modeling.adso-v1_2_0,
but requested is vnd.sap.bw.modeling.adso-v1_0_0
```

Two details in that message identify the defect:

- The requested version is **v1_0_0** — this is not what the client sent. It is the hardcoded
  fallback `P_C_FALLBACK_VERSION` from `CL_RSO_RES_CNT_TYPE_HANDLER=>CLASS_CONSTRUCTOR`. The
  `Accept` value the client sent never appears, because it is never read.
- The message number is `RSO_RES_FRMW 013`, not `014`. The difference depends on
  `l_with_cnt_type_header`, so `013` means the secondary lookup on `Content-Type` also came up
  empty. Both lookups fail.

A few tools appear to work — those whose backend resource happens to sit at v1_0_0, where the
fallback accidentally matches. This is what creates the misleading impression that the server is
"partly compatible".

---

## Root cause

1. The ICF/kernel hands the HTTP header table to ABAP with **lower-case field names**. In
   `CL_HTTP_ENTITY` both `IF_HTTP_ENTITY~GET_HEADER_FIELDS` and `~GET_HEADER_FIELD` are pure kernel
   calls (`system-call ict`) — there is no ABAP statement that changes the casing, and none that
   could be patched.

2. The BW REST framework uses the **table variant** and looks the header up by exact key:

   ```abap
   READ TABLE i_t_headerfields WITH TABLE KEY name = c_accept_key   " 'Accept'
   IF sy-subrc <> 0.
     READ TABLE i_t_headerfields WITH TABLE KEY name = c_content_type_key  " 'Content-Type'
   ```

   `WITH TABLE KEY` compares the key fields exactly — `accept` never matches `'Accept'`.

   The single-value API `get_header_field( )` resolves case-insensitively inside the kernel. Had the
   framework used it, the defect would not exist.

3. With no header found, `IS_REQUEST_COMPATIBLE` synthesises a default content type **without a
   version part**. `PARSE_CONTENT_TYPE` then applies the fallback version 1.0.0.

4. `IS_COMPATIBLE` compares the backend resource version against that assumed 1.0.0. Anything above
   it yields `incomp_version_too_high`, which `CL_RSO_RES_CNT_HDL_FACTORY=>GET_INSTANCE` turns into
   `CX_ADT_RES_NOT_ACCEPTABLE` → **HTTP 406**.

### Why BW/4HANA is not affected

Newer releases carry two additional constants in `CL_RSO_RES_CNT_TYPE_HANDLER` —
`C_ACCEPT_KEY_HTTP` (`'accept'`) and `C_CONTENT_TYPE_KEY_HTTP` (`'content-type'`) — evaluated by
`CL_RSO_RES_CNT_HDL_FACTORY=>GET_ACCEPT_HEADER` as a four-step cascade:
`Accept` → `accept` → `Content-Type` → `content-type`.

That correction is not back-ported to 7.5. There the class has only the two upper-case constants,
and `GET_ACCEPT_HEADER` does not exist at all.

### Why Eclipse BWMT is not affected

BWMT communicates over **RFC/JCo**, not HTTP. `CL_REST_RFC_UTILITIES=>CREATE_REST_REQUEST` builds a
pure ABAP request object (`CL_REST_REQUEST`) from the RFC payload, so the ICF HTTP parser is never
involved and the original casing survives. The same applies to any other JCo-based ADT client.

### A second symptom of the same defect

`IF_RSO_RES_CONSTANTS=>CN_IF_MODIFIED_SINCE` is spelled `'If-Modified-Since'` and is read the same
way in `GET_INSTANCE`. Over HTTP that lookup silently fails too, so the conditional-GET branch never
triggers. Harmless, but it shows the HTTP path was never exercised against a non-JCo client.

---

## What works on 7.5

The server detects the release itself and offers only the tools that work on it. Where SAP ships
no REST resource for an object but its metadata tables hold the definition, the read goes to the
tables; you ask for the transformation, the load history or the process chain run, and the tools
on offer lead there. `bw_system_profile` shows the picture for the system you are connected to,
including the status of every write tool. The [capability map](../README.md#what-it-can-do) in
the repository README shows the same picture graphically, by object area, with the 7.5 column
next to BW/4HANA. How the detection and the tool filter work, and the `BW_PLATFORM` override, are
described in [ARCHITECTURE.md](../ARCHITECTURE.md#platform-detection--tool-surface).

| Object | Read | Write | Note |
|---|:---:|:---:|---|
| InfoArea | ✅ | ✅ | |
| InfoObject | ✅ | ✅ | characteristics and key figures |
| aDSO | ✅ | ✅ | definition and load history |
| Classic DSO, InfoCube, MultiProvider | ✅ | — | definition and load history; these object types exist on classic releases only |
| CompositeProvider | ✅ | ✅ | incl. calculated and restricted key figures and structures |
| InfoSource | ✅ | ✅ | |
| DataSource | ✅ | ✅ | except create: the backend refuses it, for the request BWMT sends as well. Create the DataSource in BWMT or the SAP GUI; fields and delta process are changeable from here afterwards |
| Source systems, Open Hub destinations | ✅ | — | read-only on every release |
| Queries, variables, restricted and calculated key figures, structures | ✅ | ✅ | all query update tools incl. cells and roles |
| Query **data** | ❌ | | see below |
| Aggregation levels | ✅ | ✅ | the provider must be a direct-update aDSO without change log |
| Planning functions, sequences, properties, data slices | ✅ | ❌ | |
| Transformations | ✅ | ❌ | rules and the source of start, end, expert and field routines |
| DTPs | ✅ | ❌ | the filter definition, filter routine, semantic group and package sizes need the [optional helper](README.md#step-2--the-dtp-filter-helper-optional) |
| Process chains | ✅ | ❌ | steps, variants and dependencies; `bw_search` by this object type dumps server-side |
| Process chain runs | ✅ | | history and steps with status and duration; the message log of a step is not readable |
| InfoPackages | ✅ | ❌ | exists on classic releases only |
| Analysis process (APD) | ✅ | ❌ | exists on classic releases only |
| Repository navigation, search, where-used | ✅ | | |
| Activation, move, unlock, delete | | ✅ | |
| Transport tasks | | ✅ | creating a task works; listing changeable transports and changing a package do not |

The metadata table route is read-only and needs ADT authorization for the calling user.

---

## What is unavailable

| Area | Endpoint | Note |
|---|---|---|
| Query **data** | `comp/reporting` | the collection is published, but the handler answers "Reporting resource not implemented" — query *definitions* read fine |
| Request monitor, process variants, push | `/sap/bw4/*` | the BW/4HANA manage API does not exist on 7.5; the load history and the chain runs above are what remains |
| Listing changeable transports, changing a package | `cto/*` | not published by discovery |
| Writes to transformations, DTPs, process chains, planning objects | — | no REST resource exists to write through, and the metadata table route is read-only |

This is systematic rather than accidental: the BW Modeling Tools for 7.5 do not edit
transformations, DTPs or process chains — those capabilities arrived with BW/4HANA. Opening such an
object in Eclipse does not issue a REST call at all; it fetches a reentrance ticket and launches the
**embedded SAP GUI**.

The repository tree does publish a `self_url` for classic DSOs, but it is a dead link: every path and
`Accept` combination answers `404 — resource does not exist`. For transformations the router does
respond, but the object name is truncated to 28 characters in the URI attribute, so a 32-character
transformation ID can never be addressed.
