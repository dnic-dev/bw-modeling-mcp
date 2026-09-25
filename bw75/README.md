# SAP BW 7.5 (classic) — what to install

This server works against a classic SAP BW release once one small ABAP enhancement is in place.
A second, optional piece closes the single gap that remains after it. Both are copy templates:
nothing here ships with the npm package and no transport of ours ever reaches your system — you
create the objects in your own development system and move them through your own landscape.

Nothing here is needed on SAP BW/4HANA.

Background, the full capability table and what stays out of reach: [BW75-SUPPORT.md](BW75-SUPPORT.md).
The [capability map](../README.md#what-it-can-do) in the repository README shows the same at a glance.

---

## Step 1 — the `Accept` header enhancement (required)

Without it almost every call fails with **HTTP 406**. The 7.5 REST framework looks the `Accept`
header up case-sensitively while the kernel delivers header names in lower case, so content
negotiation never sees the header, falls back to resource version 1.0.0 and rejects everything
above it. The enhancement adds a canonically spelled duplicate of the header — it changes nothing
else. ([Root cause in detail](BW75-SUPPORT.md#root-cause).)

A **post-exit** on `CL_RSO_RES_RESOURCE=>GET_REQUEST_PROPERTIES`, the one place where every BW
modeling request obtains its header table:

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

Class enhancements with pre/post exits cannot be created from Eclipse ADT — use the SAP GUI.

1. Transaction **SE24**, open `CL_RSO_RES_RESOURCE`, press **Display**.
2. Menu **Class → Enhance** (`Ctrl+F4`).
3. Create an enhancement implementation, e.g. `Z_RSO_RES_HDR_CASE`.
4. Tab **Methods**, select `GET_REQUEST_PROPERTIES` (it sits in the private section).
5. Menu **Edit → Enhancement Operations → Create Post-Method**, also available from the context
   menu of the method row; the wording varies by release. If the entry is greyed out, use the
   fallback below.

   ![SE24 method list of CL_RSO_RES_RESOURCE with the post-exit marker on GET_REQUEST_PROPERTIES](se24-post-exit.png)

6. Double-click the generated `IPO_GET_REQUEST_PROPERTIES` and paste the body — SE24 generates
   `METHOD` / `ENDMETHOD` itself.
7. **Activate** (`Ctrl+F3`).

   ![Enhancement include with the activated post-method](enhancement-source.png)

   The exporting parameters of the original method — including `E_T_HEADER_FIELDS` — reach the
   post-exit as **changing** parameters, which is what makes them modifiable.

**Check it:** read any aDSO whose backend resource version is above v1_0_0, for example with
`bw_get_adso`. Before the enhancement that returns HTTP 406, afterwards the full structure. A 406
that still appears now carries real version numbers on both sides instead of the 1.0.0 fallback —
that is ordinary media type negotiation, which the client resolves through the discovery document.

**To roll back**, delete the post-method in the same menu or remove the enhancement implementation
in SE19. SAP standard is never touched.

### Why this is safe to approve

- **Additive, never replacing.** Existing entries stay untouched; only canonically spelled
  duplicates are added. `TIHTTPNVP` has a non-unique key, so code expecting lower-case names keeps
  working.
- **A no-op wherever the header already arrives correctly** — in particular on the RFC path Eclipse
  BWMT uses, where the condition is never true.
- **An enhancement, not a modification** — no SSCR object key, no modification adjustment on
  upgrade, removable at any time.
- **It cannot raise an exception**: a `LOOP`, `to_lower` and `APPEND` on a string table. No cast, no
  division, no unbound reference, no database access. That matters, because a dump here would break
  every BW modeling request.

Note the reach: the exit sits in the central request path and therefore affects every BW modeling
client of that system. Roll it out the usual way — development, then a test system with BWMT in
active use, then production.

### Fallback if the post-method cannot be created

Use a **pre-exit** on the public `CL_RSO_RES_CNT_TYPE_HANDLER->IS_REQUEST_COMPATIBLE` instead;
importing parameters are modifiable there. This covers content negotiation only, not the
`If-Modified-Since` branch.

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

---

## What you have after step 1

Modeling reads and writes over every REST endpoint that exists on 7.5. Transformations, DTPs,
process chains and their runs, InfoPackages, classic DataStore objects, InfoCubes, MultiProviders,
the planning objects and the Analysis Process Designer are readable as well, through their
metadata tables; writing them is not possible, on 7.5 those objects are edited in the SAP GUI only.

The server detects the release itself and offers only the tools that work on it.
`bw_system_profile` prints the picture for the system you are connected to. The full table is in
[BW75-SUPPORT.md](BW75-SUPPORT.md#what-works-on-75).

### Tracing a data flow on 7.5

7.5 has no data flow API, so a flow is traced one hop at a time, and no name search is needed
along the way:

- `bw_xref` on a provider lists the transformations and DTPs around it, each marked `upstream`
  (feeds it) or `downstream` (fed from it) with its source and target. The analysis processes
  that write to or read from the provider appear in the same list, with direction.
- A MultiProvider's parts come from `bw_read_metadata_tables` with `object_type="MPRO"`, each
  with its type, ready for the next `bw_xref` — and per InfoObject the parts it is identified
  in. The provider reads list every InfoObject with its kind, data type and text.
- A transformation read with `object_type="TRFN"` includes the global declarations of its
  routines, where lookup buffers are declared.
- An analysis process itself — its source query or provider, the routine, and the field rules
  into its target, constants included — is read with `object_type="ANPR"`.
- An upstream hit that starts at a DataSource ends the trace; `bw_xref` on the DataSource
  (`object_type="RSDS"` with its `source_system`) lists its InfoPackages.

The analysis processes in `bw_xref` are read through ADT DataPreview, like everything else
from the metadata tables. Without ADT access `bw_xref` still answers, without them, and says so.

### CompositeProviders for queries on 7.5

A CompositeProvider built with `bw_create_composite_provider` and `bw_update_composite_provider`
is usable in a query right away: its InfoObject-based fields use the InfoObject directly by name
and sit in the groups `CHARACTERISTICS` and `KEYFIGURES`, as the modeling tools create them.
A query does not find a field that uses the system-wide unique name (`<prefix>-<FIELD>`) under its
InfoObject name. `bw_get_composite_provider` shows the name usage per field, and a
CompositeProvider created earlier is switched with action `update_fields`,
`name_usage="direct"`, and activated.

A query saved with errors can be corrected with a follow-up call, for example
`bw_update_query_key_figures` `remove_member` with the `member_id` from `bw_get_query`.

---

## Step 2 — the DTP filter helper (optional)

One thing stays unreadable even after step 1. A DTP keeps its filter, the filter routine, the
semantic group and the package sizes in `RSBKCMD-TPL_INSTANCE` — a single serialised ABAP object,
stored as a compressed data cluster. SQL can fetch that blob but cannot unpack it, and no
relational table holds the same information: `RSBKSELECT` and `RSBKDATAPAKSEL` are request scope,
so they show the values a past load ran with, never the definition, and never the routine that
produced them. Unpacking needs ABAP.

This helper does exactly that and nothing else. Install it if you need DTP filters; skip it
otherwise. Without it, `bw_read_metadata_tables` with `object_type="DTPA"` reports everything else
about a DTP and states plainly that the filter is not readable. No tool depends on it, and the
tool surface is the same either way.

| Object | Type | Purpose |
|---|---|---|
| `ZCL_BWMCP_DTP_FILTER` | class | Reads the filter through the BW API and returns it as JSON |
| `ZCL_BWMCP_HTTP` | class | `IF_HTTP_EXTENSION`, answers `GET` with that JSON |
| `ZBWMCP` | SICF node | `default_host/sap/bc/zbwmcp`, handler `ZCL_BWMCP_HTTP` |

Read-only throughout. It accepts `GET` and nothing else, and it runs under the calling user, so
your BW authorisations apply unchanged. It uses `CL_RSBK_DTP` and `CL_RSBC_FILTER` — the same
public API the standard report `RSBK_DTP_SHOW_FILTER` uses.

### Installing it

The helper has to exist in whichever system this server connects to, so treat it like any other
custom development: create it in development, put it on a transport request, move it through your
landscape.

1. Create class `ZCL_BWMCP_DTP_FILTER` and paste
   [zcl_bwmcp_dtp_filter.abap](zcl_bwmcp_dtp_filter.abap). Assign it to your own customer package
   and record it on a transport request. Activate.
2. Create class `ZCL_BWMCP_HTTP` and paste [zcl_bwmcp_http.abap](zcl_bwmcp_http.abap). Same
   package, same request. Activate.
3. Transaction **SICF**, hierarchy type `SERVICE`, execute. Select `default_host/sap/bc`, context
   menu → create sub-element → service. The node is transportable as well (`R3TR SICF`); put it on
   the same request.
4. Name it `zbwmcp`. Leave the **logon data empty** — that is what makes the service run as the
   caller instead of a technical user.
5. Tab **Handler List**: `ZCL_BWMCP_HTTP` at position 1.
6. Save, then activate the service through its context menu.
7. Release the request and import it into the follow-on systems. Check the service in each of them
   and activate it there if it arrived inactive — the activation state of an ICF node is
   system-specific and does not reliably travel with the transport.

**Check it:**

```
curl -u <user>:<pass> "https://<host>:<port>/sap/bc/zbwmcp"
{"service":"bwmcp","version":"1.1.0","capabilities":["dtp_filter","dtp_routine","dtp_semantic_group","dtp_package_size"]}

curl -u <user>:<pass> "https://<host>:<port>/sap/bc/zbwmcp?dtp=<DTP name>"
```

`bw_system_profile` reports the helper as soon as the server finds it. Mounted the service
somewhere other than `/sap/bc/zbwmcp`? Set `BW_HELPER_PATH` for the server.

**To roll back**, deactivate and delete the SICF node, then delete the two classes — on a transport
request again, so the removal reaches the same systems the installation did.

**Requirement:** `/UI2/CL_JSON` must exist. It ships with SAP_UI and is present on any system with
the UI2 component. Verified on SAP_BASIS 750.

### What the endpoint answers

```
GET /sap/bc/zbwmcp                 200  identity and capabilities
GET /sap/bc/zbwmcp?dtp=<name>      200  the filter of that DTP
                                   404  no active version of that DTP
any other method                   405
```

```json
{ "dtp": "", "objvers": "A", "found": true, "message": "",
  "selections":      [{ "field": "", "sign": "I", "option": "EQ", "low": "", "high": "", "sel_type": "" }],
  "dynamic":         [{ "field": "", "sel_routine": "", "bex_variable": "", "bex_periv": "", "sel_type": "6" }],
  "routines":        [{ "field": "", "sel_routine": "", "codeid": "", "objvers": "", "line_count": 0, "source": "" }],
  "fields":          [{ "field": "", "iobjnm": "", "selection": "", "fieldtxt": "" }],
  "semantic_groups": [], "max_size": 0, "min_size": 0 }
```

`sel_type` `6` marks a selection a routine fills at run time, an empty one a fixed value. A routine
arrives as two entries: the one without a field name carries the declaration part, the one per
field the body.
