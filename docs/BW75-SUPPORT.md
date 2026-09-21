# SAP BW 7.5 on HANA — Support

Out of the box, almost every tool fails against a BW 7.5 system with **HTTP 406**. The cause is a
single case-sensitive line in the 7.5 REST framework, and it can be neutralised with one small ABAP
enhancement — no modification of SAP standard.

With that enhancement in place, **every REST endpoint that exists on 7.5 becomes reachable**. For the
objects SAP never shipped a REST resource for — transformations, DTPs, process chains and the
classic providers — `bw_read_metadata_tables` reads the metadata tables instead, so they are
readable but not writable (see [No REST resource — but reachable another way](#no-rest-resource--but-reachable-another-way)).
What stays out of reach altogether is listed under [What is still unavailable](#what-is-still-unavailable).

None of that is left to the client to know: the server detects the platform, adjusts its own tool
surface, names the substitute route for every tool it hides, and translates the ICF error page — see
[What the server does automatically on 7.5](#what-the-server-does-automatically-on-75).

Verified end-to-end on a BW 7.5 system (SAP_BASIS 750).

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
  `Accept` value the client sent never appears, because it was never read.
- The message number is `RSO_RES_FRMW 013`, not `014`. The difference depends on
  `l_with_cnt_type_header`, so `013` means the secondary lookup on `Content-Type` also came up
  empty. Both lookups failed.

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

That correction was never back-ported to 7.5. On 7.5 the class has only the two upper-case
constants, and `GET_ACCEPT_HEADER` does not exist at all.

### Why Eclipse BWMT is not affected

BWMT communicates over **RFC/JCo**, not HTTP. `CL_REST_RFC_UTILITIES=>CREATE_REST_REQUEST` builds a
pure ABAP request object (`CL_REST_REQUEST`) from the RFC payload, so the ICF HTTP parser is never
involved and the original casing survives. The same applies to any other JCo-based ADT client.

### A second symptom of the same defect

`IF_RSO_RES_CONSTANTS=>CN_IF_MODIFIED_SINCE` is spelled `'If-Modified-Since'` and is read the same
way in `GET_INSTANCE`. Over HTTP that lookup silently fails too, so the conditional-GET branch never
triggers. Harmless, but it shows the HTTP path was never exercised against a non-JCo client.

---

## The fix

A **post-exit** on `CL_RSO_RES_RESOURCE=>GET_REQUEST_PROPERTIES`.

That method is the single place where every BW modeling request obtains its header table — it is
called from the DELETE, GET, POST and PUT handlers of the resource base class. `E_T_HEADER_FIELDS`
is an exporting parameter of that method and is exposed as a **changing** parameter inside the
post-exit, so it can be modified.

```abap
  DATA lt_add TYPE tihttpnvp.

  LOOP AT e_t_header_fields REFERENCE INTO DATA(lr_f).
    CASE to_lower( lr_f->name ).
      WHEN 'accept'.
        IF lr_f->name <> 'Accept'.
          APPEND VALUE ihttpnvp( name = 'Accept' value = lr_f->value ) TO lt_add.
        ENDIF.
      WHEN 'content-type'.
        IF lr_f->name <> 'Content-Type'.
          APPEND VALUE ihttpnvp( name = 'Content-Type' value = lr_f->value ) TO lt_add.
        ENDIF.
      WHEN 'if-modified-since'.
        IF lr_f->name <> 'If-Modified-Since'.
          APPEND VALUE ihttpnvp( name = 'If-Modified-Since' value = lr_f->value ) TO lt_add.
        ENDIF.
    ENDCASE.
  ENDLOOP.

  APPEND LINES OF lt_add TO e_t_header_fields.
```

Two deliberate design decisions:

- **Additive, never replacing.** Existing entries are untouched; only canonically spelled duplicates
  are added. `TIHTTPNVP` is a standard table with a non-unique key, so this cannot collide, and code
  expecting lower-case names keeps working.
- **Collected in `lt_add`** rather than appended inside the loop, so the iteration does not walk over
  its own insertions.

### Why this is uncritical

- **No-op wherever the header already arrives correctly** — in particular on the RFC path used by
  Eclipse BWMT, where the condition is never true. The cost there is one loop over a handful of
  header lines.
- **Enhancement, not modification** — no SSCR object key, no modification adjustment on upgrade.
- **Cannot raise an exception**: `LOOP`, `to_lower`, `APPEND` on a string table. No cast, no
  division, no unbound reference, no database access. This matters because a dump here would break
  every BW modeling request.
- **Removable at any time** via SE24/SE19.

Note the reach, though: the exit sits in the central request path, so it affects every BW modeling
client of that system. Roll it out the usual way — development, then a test system with BWMT in
active use, then production.

### Fallback variant

If the enhancement cannot be created on the private method, use a **pre-exit** on the public
`CL_RSO_RES_CNT_TYPE_HANDLER->IS_REQUEST_COMPATIBLE` instead — importing parameters are modifiable
in a pre-exit:

```abap
  READ TABLE i_t_headerfields WITH TABLE KEY name = 'Accept' TRANSPORTING NO FIELDS.
  IF sy-subrc <> 0.
    LOOP AT i_t_headerfields REFERENCE INTO DATA(lr_f).
      IF to_lower( lr_f->name ) = 'accept'.
        APPEND VALUE ihttpnvp( name = 'Accept' value = lr_f->value ) TO i_t_headerfields.
        EXIT.
      ENDIF.
    ENDLOOP.
  ENDIF.
```

This covers content negotiation only, not the `If-Modified-Since` branch.

---

## How to apply

Class enhancements with pre/post exits cannot be created from Eclipse ADT — use the SAP GUI.

1. Transaction **SE24**, open `CL_RSO_RES_RESOURCE`, press **Display**.
2. Menu **Class → Enhance** (`Ctrl+F4`).
3. Create an enhancement implementation, e.g. `Z_RSO_RES_HDR_CASE`.
4. Tab **Methods**, select `GET_REQUEST_PROPERTIES` (it sits in the private section).
5. Menu **Edit → Enhancement Operations → Create Post-Method** (also available from the context menu
   of the method row; the exact wording varies by release). If the entry is greyed out, use the
   fallback variant above.

   The method list then shows the post-exit marker in the rightmost column:

   ![SE24 method list of CL_RSO_RES_RESOURCE with the post-exit marker on GET_REQUEST_PROPERTIES](bw75-se24-post-exit.png)

6. Double-click the generated `IPO_GET_REQUEST_PROPERTIES` and paste the body — SE24 generates
   `METHOD` / `ENDMETHOD` itself.
7. **Activate** (`Ctrl+F3`). The enhancement include then looks like this:

   ![Enhancement include with the activated post-method](bw75-enhancement-source.png)

   Note the generated signature: the exporting parameters of the original method — including
   `E_T_HEADER_FIELDS` — are passed to the post-exit as **changing** parameters.

To roll back, delete the post-method in the same menu, or remove the enhancement implementation in
SE19. SAP standard is never touched.

---

## Verifying

Read any aDSO whose backend resource version is above v1_0_0 — for example with `bw_get_adso`.
Before the enhancement this returns HTTP 406; afterwards the full structure is returned.

To confirm at the source, set a breakpoint in
`CL_RSO_RES_CNT_TYPE_HANDLER=>IS_REQUEST_COMPATIBLE`: `i_t_headerfields` must now contain both an
`accept` and an `Accept` entry, and the first `READ TABLE` must hit `sy-subrc = 0`.

If a 406 still appears afterwards, read it carefully — it will now carry **real** version numbers on
both sides instead of the 1.0.0 fallback. That is a genuine media type negotiation issue, which the
client resolves through the discovery document at runtime.

---

## What works after the fix — reads

Verified against a BW 7.5 system:

| Area | Status |
|---|---|
| aDSO — read | ✅ |
| InfoObject — read | ✅ |
| CompositeProvider incl. calculated/restricted key figures and structures | ✅ |
| Queries — read | ✅ |
| Repository navigation and object search | ✅ |
| Where-used / lineage (xref) | ✅ |
| InfoArea, InfoSource, DataSource, Open Hub | ✅ endpoints published by discovery |

The client reconciles resource versions automatically: the discovery document is read at startup and
overrides the hardcoded media type defaults, including downgrades (a 7.5 backend serving an older
resource version rejects a higher one with HTTP 415).

That reconciliation keys on the **collection name in the discovery document**, and the name is not
stable across releases: a classic system publishes InfoObjects as `infoobject` where BW/4HANA
publishes them as `iobj`. Until the two spellings were mapped onto each other, the discovered
`iobj-v1_8_0` was filed under a key nothing looked up, the hardcoded `v2_2_0` stayed in place, and
every InfoObject write was rejected at the lock with HTTP 415 — while the reads went through,
because the read path sent a list of versions rather than one.

---

## What works after the fix — writes

Every write tool has been run against a classic system (SAP_BASIS 750, `bw.b4hanamode =
STANDARD`) with its result read back afterwards: InfoAreas, InfoObjects (characteristic and key
figure), aDSOs with field, key and settings changes, InfoSources, CompositeProviders, queries with
all five update tools, variables (created and changed in place), restricted and calculated key
figures, reusable structures, aggregation levels, activation, move, unlock and delete. One write is
refused by the backend — `bw_create_datasource`, see below.

`bw_system_profile` names the status of each write tool on a classic system, generated from
`src/classic-writes.ts`, so the tool surface and the statement about it cannot drift apart. This
section adds what the tool does not print: **what a classic release needs that BW/4HANA does
not.** Anyone writing against both platforms runs into the same three things.

### What a classic release does differently

| Where it shows | What classic needs |
|---|---|
| Every lock — InfoAreas, queries, the reusable query components, `bw_delete` for those types | **The lock must run as plain `stateful`.** A classic backend validates the lock handle against the ADT session that took it, and keeps that session alive only when the lock asks for one. With `stateful_enqueue` — which BW/4HANA accepts — or with no session type at all, the lock returns a handle and the very next request is refused with `ExceptionResourceInvalidLockHandle`, "lock handle … could not be created". The message names the enqueue; the cause is the session. BW/4HANA keeps exactly what the caller asked for. |
| `bw_create_variable`, `bw_create_rkf`, `bw_create_ckf`, `bw_create_structure` | **Every request between lock and write must carry that session type too.** These flows call `/sap/bc/adt/cts/transportchecks` in between, and a request that declares no session type ends a stateful one — the same 423, one step later. |
| `bw_create_infoobject`, `bw_update_infoobject`, `bw_activate` for `iobj` | **The write has to leave the session that holds the lock, and the create has to carry the whole object.** This is the one that produces no error at all. See the section below. |

### The InfoObject, and the third cause

`bw_create_infoobject`, `bw_update_infoobject` and `bw_activate` for `iobj` were the last to fall,
and they needed a trace to settle. After the media type fix the lock succeeded, so the request
reached the resource — and the backend then accepted both the POST and the PUT, answered
*"Objekt … wurde erfolgreich geändert"*, and applied nothing. A key figure body produced a
characteristic, CHAR(5) with ALPHA; a PUT that changed only the description did not arrive either.
No error, nothing to work from.

An ADT communication trace of Eclipse BWMT creating the same InfoObject on 7.5 showed what the
messages could not: **BWMT uses its stateful enqueue session for the lock and the unlock and for
nothing else.** The create POST, every read, the PUT and the activation each go out on a session of
their own. Over JCo that separation is free, which is why it is invisible in the client and why
nothing documents it. Over HTTP it has to be asked for — and sending the identical write from a
second session, quoting the same lock handle, applies it in full.

Two things follow, and both are in the server now:

- The **InfoObject write runs in its own session** on a classic release. Deliberately not every
  type: an InfoSource PUT applies from the lock session, and once it is sent from elsewhere the
  activation — which must stay in the lock session, because any other is refused by the
  InfoProvider lock — checks the state from before the write and reports an empty field list. The
  types that need the separate session are listed, and a type earns its place by being observed.
- The **create carries the whole object** on classic. BW/4HANA ignores the create body and takes
  its values from the PUT that follows, so this server posted a stub; a classic release reads the
  body and rejects a stub outright ("the object name must not be empty"). The full document is
  posted there, and the GET and PUT that follow still apply everything it does not carry.

Verified afterwards: a characteristic CHAR(10) with texts and a DEC key figure, both created,
activated, read back with the values they were given — length 10 rather than the server's 5, the
text table active — the description changed through `bw_update_infoobject`, and both deleted again.

### The DataSource — one resource moved, one call still refused

**The remote entity value help is published here, at a different address.** It had been written
off as missing: `bw_list_remote_entities` went to `rsdsint/values/hanaentity` and collected an
HTTP 404. A BWMT trace shows the classic client asking `is/values/hanaentity` instead, with
`pattern` and `maxrows` where BW/4HANA takes `searchPattern` and `resultSize`, and answering in a
different shape — a `<valueHelpCatalog>` naming the columns and rows of bare `<value>` elements,
positional, rather than one `<technicalName>` plus attributes per row. The tool now speaks both.
`bw_preview_datasource` still answers 404; it uses `rsdsint/dataprev`, and the trace does not
cover a preview, so its classic address is unknown.

**`bw_create_datasource` is refused, and this one is not a protocol difference.** The lock returns
a handle, and the create POST that quotes it comes back `ExceptionResourceInvalidLockHandle`,
"lock handle for object RSDS … could not be created". The traced BWMT sequence was compared call
by call and every difference adopted: the package reference in the body, a real application
component instead of the tree placeholder, the transport check between lock and write, the name
validation before it, and each of the four lock/write session combinations. The request now
matches the traced one in URL, headers, content type and body, and the lock answers exactly as it
does there, `IS_LOCAL=X` included. What remains is outside the protocol: BWMT talks JCo, where the
lock and the write are two sessions of one connection, and over HTTP they are two logons.

`bw_set_datasource_fields` and `bw_change_datasource_delta` are a different story — they change an
existing DataSource, and one that nothing uses can be found by reading `RSDS` and checking each
candidate with `bw_xref`. Both were then exercised for real, and both were broken:

- The **PUT pinned the resource version** (`rsds-v1_1_0`) instead of taking the one discovery
  resolved, so the backend rejected it with HTTP 415 naming both versions. The same defect as the
  InfoObject media type, in a second hardcoded spot. Now taken from `MEDIA_TYPES`.
- `bw_change_datasource_delta` **could set a delta but never remove one**: the empty string the
  tool documents for "remove the delta process" was checked against the list of admissible values,
  which never contains it, so the documented way back was refused every time. This one is not
  release-specific — it was equally broken on BW/4HANA.

Verified on both platforms afterwards, each step read back and every change reversed: a field
switched off and on again, and a delta process set and removed.

### Modelling differences that are not defects

Three activation failures during this pass came from BW itself, not from the server, and the same
call behaves the same way on BW/4HANA where the platform allows it at all:

- An aDSO carrying a **pure (non-InfoObject) field**, or one with the **change log switched off**,
  cannot be used as a CompositeProvider part provider. The aDSO activation says so.
- A **planning-enabled** aDSO must be direct-update without a change log on a classic release; a
  standard aDSO with `planning_mode` on activates but is refused as a planning provider. On
  BW/4HANA the standard aDSO is accepted.
- An **aggregation level** must expose every key field of its provider, and the currency or unit
  characteristic has to be a key field there.

A fourth is worth knowing because it looks like a defect: a CompositeProvider over an amount key
figure reports *"Keine Währungsinformationen für Betragskennzahl"* on activation. That happens on
BW/4HANA in exactly the same shape, so it is how the tool behaves everywhere, not a 7.5 gap.

---

## What the server does automatically on 7.5

The tables in this document used to be something the *model* had to know. It did not: against
a 7.5 system it called `bw_list_requests`, `bw_get_transformation` and
`bw_list_process_chain_runs` first — their descriptions promise they work — collected an
HTTP 404 from each, and only then found the way round. A note in the prompt does not compete
with a tool list, so the server now acts on what it detects.

**It detects the platform itself.** `bw.b4hanamode` from `repo/is/systeminfo` states it
(`STRICT` is BW/4HANA, `STANDARD` a classic release), and the discovery document lists the
collections the system publishes. Both are read once per process, before the first tool call.

**`tools/list` only offers what this system can answer.** A tool that addresses a
`/sap/bw/modeling` collection is offered exactly where that collection is published, so the
system itself decides rather than a hardcoded release list. The `/sap/bw4/…` APIs and the
monitoring OData services are not in the discovery document; those follow the platform
verdict. On a 7.5 system 45 of the tools drop out — transformations, DTPs, process chains,
transport operations, planning functions and sequences, query data, the data flow graph, the
request monitor, push, process variants, and the two monitoring OData families. The planning
reads among those now have a route through the metadata tables; the writes do not.
`bw_system_profile` lists them with the reason. A tool that is called anyway — a client with
a tool list cached from before, or from another instance — is answered with that same reason
instead of a request to BW.

**One route per backend, and the hidden tools name theirs.** The tools that drop out are not
replaced by a hidden reroute: the REST API and the metadata tables are different backends —
the second one is direct table access through ADT DataPreview — and keeping them in separate
tools keeps that boundary where it can be governed. An installation that does not grant ADT
simply does not offer `bw_read_metadata_tables`, and no tool quietly becomes a table read
behind its own description. What the hidden tools do carry is the route: the server names the
substitute call both in the message a stale client gets and in the instructions it sends at
handshake time, generated from one table in `platform.ts`:

| Question | On a classic release |
|---|---|
| Transformations (rules, routines) | `bw_read_metadata_tables`, `object_type="TRFN"` |
| DTPs | `bw_read_metadata_tables`, `object_type="DTPA"` (filter selections and the semantic group stay unreadable) |
| Process chains | `bw_read_metadata_tables`, `object_type="RSPC"` |
| Load history of a provider | `bw_read_metadata_tables` on the provider — `ADSO`, `ODSO`, `CUBE` or `MPRO` |
| Planning functions (type, parameters, FOX formula) | `bw_read_metadata_tables`, `object_type="PLSE"` |
| Planning sequences (steps in execution order) | `bw_read_metadata_tables`, `object_type="PLSQ"` |
| Planning properties and characteristic relationships of a provider | `bw_read_metadata_tables`, `object_type="PLCR"` (data slices: `"PLDS"`) |
| Run history of a process chain | `bw_read_metadata_tables`, `object_type="RSPCLOG"` with the chain name |
| The steps of one chain run | `bw_read_metadata_tables`, `object_type="RSPCLOG"` with the log id |
| Last status of several chains | `bw_read_metadata_tables`, `object_type="RSPCLOG"` with a pattern such as `Z*` |
| Data flow around an object | `bw_xref`, one hop at a time |

`ADSO` was added to `bw_read_metadata_tables` for exactly that last-but-one row: aDSOs exist
on 7.5, and their load history had no route at all before — the tool refused the type, and
`bw_list_requests` needs the manage API. It returns the history only; structure and settings
come from `bw_get_adso`, whose resource every release publishes. The section is read from
`RSSTATMANPART`, which is the classic request store and says so in the output: on BW/4HANA
that table is empty by design, requests live in `RSPMREQUEST` there.

Extending this is one line per tool: teach `bw_read_metadata_tables` the object type, add the
substitute entry, remove the tool's entry from the catalog if it should become visible again.
Nothing else needs touching — the instructions text follows the table.

**An ICF error page never reaches the chat.** A 404 whose body is the HTML "Logon Error
Message" page is replaced by the sentence it means, naming the path and the route that works
instead. ADT exception documents are passed through unchanged, because callers parse them.

**`BW_PLATFORM` overrides the verdict** (`auto` by default):

| Value | Effect |
|---|---|
| `auto` | detect; if detection fails, offer the full surface and log a warning |
| `classic` | force the classic verdict, even when detection failed — the setting for a 7.5 system the server cannot reach for detection |
| `bw4` | switch the platform filter off entirely — the escape hatch if a tool is hidden that does work on your system |

Detection never fails closed: a system that cannot be identified gets the full tool surface,
because an empty server would be the worse failure.

## No REST resource — but reachable another way

For these the endpoint is missing, yet the object can still be read, because
`bw_read_metadata_tables` goes to the metadata tables through the ADT DataPreview service. Read-only,
and it needs ADT authorization for the calling user.

| Area | Missing endpoint | How to read it instead |
|---|---|---|
| Transformations | `trfn` | `bw_read_metadata_tables` `TRFN` — field mappings with their rule types, and the source code of the start, end, expert and field routines |
| DTPs | `dtpa` | `bw_read_metadata_tables` `DTPA` — path, resolved transformation, extraction mode and error handling. Filter selections and the semantic group are not readable: they live in a serialised ABAP object, not in relational columns |
| Process chains | `rspc` | `bw_read_metadata_tables` `RSPC` — steps with their variant parameters and dependencies, in execution order. Note that `bw_search` by this object type still dumps server-side |
| Classic DSO, InfoCube, MultiProvider | `odso` and friends | `bw_read_metadata_tables` `ODSO` / `CUBE` / `MPRO` — key and data fields, dimensions, part providers |
| Load status of an aDSO, cube or DSO | `/sap/bw4/*` | `bw_read_metadata_tables` on the provider — the Load History section reads `RSSTATMANPART`, enriched from `RSBKREQUEST`: request, status, update mode, start, user, duration, records and source |
| Data flow graph | `dmod` | `bw_xref` on the object — the same edges, one object at a time instead of a graph |
| Planning functions | `plse` | `bw_read_metadata_tables` `PLSE` — function type and its exit class, aggregation level, characteristic usage, conditions, and the parameter tree with its selections. Variable references are resolved to their names; a FOX formula comes back as source code rather than as one table row per line |
| Planning sequences | `plsq` | `bw_read_metadata_tables` `PLSQ` — steps in execution order with aggregation level, function and filter. A sequence has no parallel branches, so `STEPID` order *is* the execution order |
| Planning properties, characteristic relationships | `plcr` | `bw_read_metadata_tables` `PLCR` — key date, max combinations, save strategy, and one entry per relationship with its type, the characteristics involved and the validity range. Keyed by the **InfoProvider**, not by the aggregation level |
| Process chain runs | the `RV_C_PCM*` OData services | `bw_read_metadata_tables` `RSPCLOG` — run history from `RSPCLOGCHAIN`, steps from `RSPCPROCESSLOG` with status, start, duration and process variant. The message log of a step is an application log (BAL) and is not readable through table access |
| Analysis process (APD) | none on any release | `bw_read_metadata_tables` `ANPR` — the whole definition is one XML document in `RSANT_PROCESS.XML`: nodes with the object each reads or writes, the edges from its `<MAPPINGS>` block, filters, formulas and routine ABAP. BW/4HANA does not have the object type at all |
| Data slices | none on any release | `bw_read_metadata_tables` `PLDS` — type, exit class and selection per slice. No release publishes a REST resource for these, so this is the only route on any platform |

## What is still unavailable

| Area | Endpoint | Note |
|---|---|---|
| Transport operations | `cto/*` | not published by discovery |
| Query **data** | `comp/reporting` | the collection is published, but the handler answers "Reporting resource not implemented" — query *definitions* read fine |
| Request monitor, process variants, push | `/sap/bw4/*` | the BW/4HANA manage API does not exist on 7.5; only the load history and the chain runs above are available |

This is systematic rather than accidental: the BW Modeling Tools for 7.5 never supported editing
transformations, DTPs or process chains — those capabilities arrived with BW/4HANA. Opening such an
object in Eclipse does not issue a REST call at all; it fetches a reentrance ticket and launches the
**embedded SAP GUI**.

The repository tree does publish a `self_url` for classic DSOs, but it is a dead link: every path and
`Accept` combination answers `404 — resource does not exist`. For transformations the router does
respond, but the object name is truncated to 28 characters in the URI attribute, so a 32-character
transformation ID can never be addressed.

