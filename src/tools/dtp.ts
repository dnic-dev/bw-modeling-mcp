import { BwClient, MEDIA_TYPES, createClientFromEnv, freshRead, bwNsName, bwSeg } from '../bw-client.js';
import { bwActivate } from './activation.js';

interface XrefEntry {
  objectName: string;
  objectType: string;
  objectStatus: string;
  title: string;
  href: string;
}

/**
 * Parse <atom:entry> elements from a BW Atom feed (xref / search responses).
 * Each entry contains a <bwModel:object> with objectName, objectType, objectStatus.
 */
function parseAtomEntries(xml: string): XrefEntry[] {
  const entries: XrefEntry[] = [];
  const entryRegex = /<atom:entry>([\s\S]*?)<\/atom:entry>/g;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(xml)) !== null) {
    const body = match[1];
    const nameMatch = body.match(/objectName="([^"]+)"/);
    const typeMatch = body.match(/objectType="([^"]+)"/);
    const statusMatch = body.match(/objectStatus="([^"]+)"/);
    const titleMatch = body.match(/<atom:title>([^<]+)<\/atom:title>/);
    const hrefMatch = body.match(/href="([^"]+)"/);

    if (nameMatch && typeMatch) {
      entries.push({
        objectName: nameMatch[1],
        objectType: typeMatch[1],
        objectStatus: statusMatch?.[1] ?? 'unknown',
        title: titleMatch?.[1] ?? '',
        href: hrefMatch?.[1] ?? '',
      });
    }
  }
  return entries;
}

/**
 * bw_get_dtps — list DTPs that depend on an object (via xref).
 *
 * Uses the cross-reference endpoint to find all DTPA objects that use the given object.
 * Filters xref results to objectType=DTPA only.
 *
 * After activating a Transformation, the activation response lists deactivated DTPs.
 * This tool can be used independently to find dependent DTPs before activation.
 */
export async function bwGetDtps(
  client: BwClient,
  objectType: string,
  objectName: string
): Promise<string> {
  const path = `/sap/bw/modeling/repo/is/xref?objectType=${encodeURIComponent(objectType.toUpperCase())}&objectName=${encodeURIComponent(bwNsName(objectName).toUpperCase())}`;
  const result = await client.get(path, 'application/atom+xml;type=feed');

  const allEntries = parseAtomEntries(result.body);
  const dtps = allEntries.filter((e) => e.objectType === 'DTPA');

  if (dtps.length === 0) {
    return `No dependent DTPs found for ${objectType.toUpperCase()} ${objectName.toUpperCase()}.`;
  }

  const lines = [
    `Found ${dtps.length} DTP(s) dependent on ${objectType.toUpperCase()} ${objectName.toUpperCase()}:`,
    '',
    ...dtps.map(
      (d, i) =>
        `${i + 1}. ${d.objectName} — status: ${d.objectStatus}` +
        (d.title ? ` — "${d.title}"` : '')
    ),
    '',
    'To activate all inactive DTPs: call bw_activate for each with object_type="dtpa" and lock_handle="".',
  ];

  return lines.join('\n');
}

/**
 * bw_get_dtp_details — read a single DTP definition.
 * (Used internally; exposed via bw_get_dtps in index.ts if needed.)
 */
export async function bwGetDtpDetails(client: BwClient, dtpName: string): Promise<string> {
  const path = `/sap/bw/modeling/dtpa/${bwSeg(dtpName)}/m`;
  const result = await freshRead(path, MEDIA_TYPES['dtpa']);
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';
  return `DTP: ${dtpName.toUpperCase()}\nStatus: ${status}\n\n${result.body}`;
}

// ── bwGetDtp ──────────────────────────────────────────────────────────────────

interface DtpFilterSelection {
  operator: string;
  excluding: boolean;
  low: string;
}

interface DtpFilterField {
  name: string;
  dtaName: string;
  description: string;
  selected: boolean;
  selections: DtpFilterSelection[];
  hasRoutine: boolean;
  routineCode: string[];
}

interface DtpInfo {
  name: string;
  description: string;
  status: string;
  source: { type: string; name: string; description: string };
  target: { type: string; name: string; description: string };
  transformation: { name: string; description: string };
  extractionMode: string;
  packageSize: string;
  filterFields: DtpFilterField[];
  globalRoutineCode: string[];
}

function parseDtpXml(xml: string, status: string): DtpInfo {
  const attr = (tag: string, name: string) => {
    const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
    return m ? m[1] : '';
  };

  // Root attributes
  const rootMatch = xml.match(/<dtpa:dataTransferProcess([^>]*)>/);
  const rootAttrs = rootMatch?.[1] ?? '';
  const name = attr(rootAttrs, 'name');
  const description = attr(rootAttrs, 'description');

  // Extraction settings
  const extrMatch = xml.match(/<extractionSettings([^>]*)\/?>/);
  const extractionMode = attr(extrMatch?.[1] ?? '', 'extractionMode');
  const packageSize = attr(extrMatch?.[1] ?? '', 'packageSize');

  // Source / target
  const srcMatch = xml.match(/<source([^>]*)\/?>/);
  const tgtMatch = xml.match(/<target([^>]*)\/?>/);
  const source = {
    type: attr(srcMatch?.[1] ?? '', 'type'),
    name: attr(srcMatch?.[1] ?? '', 'name'),
    description: attr(srcMatch?.[1] ?? '', 'description'),
  };
  const target = {
    type: attr(tgtMatch?.[1] ?? '', 'type'),
    name: attr(tgtMatch?.[1] ?? '', 'name'),
    description: attr(tgtMatch?.[1] ?? '', 'description'),
  };

  // Transformation (overview/object)
  const ovMatch = xml.match(/<overview>[\s\S]*?<object([^>]*)\/?>[\s\S]*?<\/overview>/);
  const transformation = {
    name: attr(ovMatch?.[1] ?? '', 'name'),
    description: attr(ovMatch?.[1] ?? '', 'description'),
  };

  // Filter fields
  const filterFields: DtpFilterField[] = [];
  const fieldsRegex = /<fields([^>]*)>([\s\S]*?)<\/fields>/g;
  let fm: RegExpExecArray | null;
  while ((fm = fieldsRegex.exec(xml)) !== null) {
    const fieldAttrs = fm[1];
    const fieldBody = fm[2];

    const selections: DtpFilterSelection[] = [];
    const selRegex = /<selection\b([^>]*)(?:\/>|>([\s\S]*?)<\/selection>)/g;
    let sm: RegExpExecArray | null;
    while ((sm = selRegex.exec(fieldBody)) !== null) {
      const selAttrs = sm[1];
      const selBody = sm[2] ?? '';
      const operator = selAttrs.match(/\boperator="([^"]*)"/)?.[1] ?? '';
      const excluding = selAttrs.includes('excluding="true"');
      const low = selBody.match(/<low[^>]*\bvalue="([^"]*)"/)?.[1] ?? '';
      selections.push({ operator, excluding, low });
    }

    const hasRoutine = /<routine[\s>]/.test(fieldBody) && !/<routine\s*\/>/.test(fieldBody);
    const routineCode: string[] = [];
    if (hasRoutine) {
      const codeRegex = /<code(?:\s[^>]*)?>([^<]*)<\/code>/g;
      let cm: RegExpExecArray | null;
      while ((cm = codeRegex.exec(fieldBody)) !== null) {
        routineCode.push(cm[1]);
      }
    }

    filterFields.push({
      name: attr(fieldAttrs, 'name'),
      dtaName: attr(fieldAttrs, 'dtaName'),
      description: attr(fieldAttrs, 'description'),
      selected: fieldAttrs.includes('selected="true"'),
      selections,
      hasRoutine,
      routineCode,
    });
  }

  // Global routine code
  const globalRoutineCode: string[] = [];
  const globalRegex = /<globalRoutineCode>([^<]*)<\/globalRoutineCode>/g;
  let gm: RegExpExecArray | null;
  while ((gm = globalRegex.exec(xml)) !== null) {
    globalRoutineCode.push(gm[1]);
  }

  return {
    name,
    description,
    status,
    source,
    target,
    transformation,
    extractionMode,
    packageSize,
    filterFields,
    globalRoutineCode,
  };
}

/**
 * bw_get_dtp — read a DTP definition and return a structured summary + raw XML.
 *
 * Flow:
 *   GET /sap/bw/modeling/dtpa/{dtpName}/m?forceCacheUpdate=true
 *   Parse key fields and return readable summary.
 */
export async function bwGetDtp(client: BwClient, dtpName: string): Promise<string> {
  // Fresh session: the shared client's buffer serves the stale inactive shadow
  // after this session touched the DTP (forceCacheUpdate alone does not help there).
  const path = `/sap/bw/modeling/dtpa/${bwSeg(dtpName)}/m`;
  const result = await freshRead(path, MEDIA_TYPES['dtpa']);
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';

  const info = parseDtpXml(result.body, status);

  const modeLabel = info.extractionMode === 'F' ? 'Full' : info.extractionMode === 'D' ? 'Delta' : info.extractionMode;

  const lines: string[] = [
    `DTP: ${info.name}`,
    `Status: ${info.status}`,
    `Description: ${info.description}`,
    '',
    `Source: ${info.source.type} ${info.source.name}` + (info.source.description ? ` — ${info.source.description}` : ''),
    `Target: ${info.target.type} ${info.target.name}` + (info.target.description ? ` — ${info.target.description}` : ''),
    `Transformation: ${info.transformation.name}` + (info.transformation.description ? ` — ${info.transformation.description}` : ''),
    '',
    `── Extraction Settings ──`,
    `  Mode:        ${modeLabel} (${info.extractionMode})`,
    `  Package Size: ${info.packageSize}`,
    '',
    `── Filter Fields (${info.filterFields.length}) ──`,
  ];

  if (info.filterFields.length === 0) {
    lines.push('  (no filter fields)');
  } else {
    for (const f of info.filterFields) {
      lines.push(`  [${f.selected ? 'selected' : 'inactive'}] ${f.name} (${f.dtaName})`);
      if (f.selections.length > 0) {
        for (const s of f.selections) {
          const sign = s.excluding ? '≠' : '=';
          const val = s.low === '' ? "''" : `"${s.low}"`;
          lines.push(`    → ${s.operator} ${sign} ${val}`);
        }
      }
      if (f.hasRoutine) {
        lines.push(`    → Routine (${f.routineCode.length} lines):`);
        for (const codeLine of f.routineCode) {
          lines.push(`       ${codeLine}`);
        }
      }
      if (!f.hasRoutine && f.selections.length === 0) {
        lines.push('    → (no selection / no routine)');
      }
    }
  }

  if (info.globalRoutineCode.length > 0) {
    lines.push('', '── Global Routine Code ──');
    for (const line of info.globalRoutineCode) {
      lines.push(`  ${line}`);
    }
  }

  lines.push('', `── Raw XML ──`, result.body);

  return lines.join('\n');
}

// ── DTP lock release ──────────────────────────────────────────────────────────

/**
 * Release the enqueue lock held on a DTP (SM12: RSBKDTP, mode E).
 *
 * The DTP framework keeps an exclusive object lock for the lifetime of the
 * modeling session. bwActivate does not release it for dtpa and client.unlock
 * treats dtpa as no-op, so the lock must be freed with an explicit action=unlock —
 * otherwise the next run or edit on the same DTP hits a lock collision until the
 * entry is deleted manually in SM12. A fresh CSRF token is fetched because the
 * preceding activation nulls the cached one. Throws on an HTTP error so the manual
 * bw_unlock tool can surface it; callers using this in a finally block wrap it with
 * .catch() to keep it best-effort.
 */
export async function bwUnlockDtp(client: BwClient, dtpName: string): Promise<void> {
  const csrf = await client.getCsrfToken();
  await client.rawPost(
    `/sap/bw/modeling/dtpa/${bwSeg(dtpName)}?action=unlock`,
    '',
    {
      'Content-Type': MEDIA_TYPES['dtpa'],
      'Accept': MEDIA_TYPES['dtpa'],
      'x-csrf-token': csrf,
    }
  );
}

// ── bwCreateDtp ───────────────────────────────────────────────────────────────

export interface CreateDtpArgs {
  trfn_name: string;
  trfn_name_2?: string;
  source_name: string;
  source_type: string;
  source_system?: string;
  target_name: string;
  target_type: string;
  target_object_subtype?: string;
  description?: string;
  package?: string;
  filter_field?: string;
  filter_dta_name?: string;
  filter_value?: string;
}

/**
 * bw_create_dtp — create a new DTP for an existing Transformation, then activate it.
 *
 * Flow:
 *   1. POST generateDtpId → DTP name from Location header
 *   2. Lock with activity_context: CREA (rawPost on lockClient = passed-in client)
 *   3. POST minimal XML with fresh createClientFromEnv() (session isolation)
 *   4. Explicit unlock (rawPost on lockClient)
 *   5a. If filter_field: Lock (new client) → GET (fresh) → PUT (fresh) → bwActivate
 *   5b. If no filter: bwActivate with empty lockHandle
 */
export async function bwCreateDtp(
  client: BwClient,
  args: CreateDtpArgs
): Promise<string> {
  const trfnName   = args.trfn_name.toUpperCase();
  const srcName    = args.source_name.toUpperCase();
  const srcType    = args.source_type.toUpperCase();
  const tgtName    = args.target_name.toUpperCase();
  const tgtType    = args.target_type.toUpperCase();
  const desc       = args.description ?? '';
  const pkg        = args.package ?? '$TMP';

  // Source element attributes. For ADSO/TRCS sources tlogo and type coincide and the name is
  // passed through. For a DataSource source (source_type "RSDS") tlogo and type differ
  // (tlogo "RSDS", type "DTASRC") and the name is the RSDS compound key.
  let sourceTlogo: string;
  let sourceTypeAttr: string;
  let sourceNameAttr: string;
  if (srcType === 'RSDS') {
    if (!args.source_system) {
      throw new Error(
        'source_type "RSDS" (DataSource source) requires source_system to build the ' +
        'RSDS compound source name.'
      );
    }
    sourceTlogo = 'RSDS';
    sourceTypeAttr = 'DTASRC';
    // RSDS compound key: DataSource name left-justified in a 30-char field, then the
    // source system name appended with no trailing padding (total length 40).
    sourceNameAttr = srcName.padEnd(30, ' ') + args.source_system.toUpperCase();
  } else {
    sourceTlogo = srcType;
    sourceTypeAttr = srcType;
    sourceNameAttr = srcName;
  }

  // Target element attributes. For ADSO/TRCS targets tlogo and type coincide. For an
  // InfoObject target (target_type "IOBJ") they differ: tlogo "IOBJ" (object kind) but the
  // type carries the loaded sub-object role — the same tlogo != type pattern as the RSDS
  // source. The role is selected by target_object_subtype: ATTR → IOBJA (attributes, default),
  // TEXT → IOBJT (texts), HIER → IOBJH (hierarchies). The type code must match the sub-object
  // fed by the transformation chain, otherwise the server rejects the create with
  // SADT_RESOURCE 006 (verified against the GUI reference trace: <target ... type="IOBJT"/>).
  let targetTlogo: string;
  let targetTypeAttr: string;
  if (tgtType === 'IOBJ') {
    const subtype = (args.target_object_subtype ?? 'ATTR').toUpperCase();
    const IOBJ_SUBTYPE_TO_TYPE: Record<string, string> = {
      ATTR: 'IOBJA',
      TEXT: 'IOBJT',
      HIER: 'IOBJH',
    };
    const typeCode = IOBJ_SUBTYPE_TO_TYPE[subtype];
    if (!typeCode) {
      throw new Error(
        `Invalid target_object_subtype "${args.target_object_subtype}" for an InfoObject target. ` +
        `Valid values: ATTR (attributes, default), TEXT (texts), HIER (hierarchies).`
      );
    }
    targetTlogo = 'IOBJ';
    targetTypeAttr = typeCode;
  } else {
    targetTlogo = tgtType;
    targetTypeAttr = tgtType;
  }

  const language     = process.env.BW_LANGUAGE ?? 'DE';
  const masterSystem = new URL(process.env.BW_URL ?? 'http://localhost').hostname.split('.')[0].toUpperCase();
  const responsible  = (process.env.BW_USER ?? '').toUpperCase();

  // Step 1: Generate DTP name via POST generateDtpId — DTP name is in Location header
  const csrfToken = await client.getCsrfToken();
  const genResponse = await client.rawPost(
    '/sap/bw/modeling/dtpa/generateDtpId',
    '',
    {
      'Accept': MEDIA_TYPES['dtpa'],
      'Content-Type': MEDIA_TYPES['dtpa'],
      'x-csrf-token': csrfToken,
    }
  );
  const location = genResponse.headers['location'] ?? genResponse.headers['Location'] ?? '';
  if (!location) {
    throw new Error(`generateDtpId returned no Location header. Response: ${JSON.stringify(genResponse.headers)}`);
  }
  const dtpName  = location.split('/').pop()!.toUpperCase();
  const dtpLower = bwSeg(dtpName);

  // Step 2: Lock with CREA
  const csrfToken2 = await client.getCsrfToken();
  const lockResponse = await client.rawPost(
    `/sap/bw/modeling/dtpa/${dtpLower}?action=lock`,
    '',
    {
      'activity_context': 'CREA',
      'Accept': MEDIA_TYPES['dtpa'],
      'x-csrf-token': csrfToken2,
    }
  );
  const lockHandle = lockResponse.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1] ?? '';
  if (!lockHandle) {
    throw new Error(`No <LOCK_HANDLE> in CREA lock response:\n${lockResponse.body}`);
  }

  // The CREA lock (and the description/filter lock below) hold an enqueue
  // (SM12: RSBKDTP) that must be released even if a later step throws; the finally
  // block frees it so a failed create does not leave the DTP locked.
  try {
    // Step 3: POST minimal XML — fresh session (same isolation as bwCreateTransformation)
    const postBody = `<?xml version="1.0" encoding="UTF-8"?>
<Dtpa:dataTransferProcess
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:Dtpa="http://www.sap.com/bw/modeling/DataTransferProcess.ecore"
  xmlns:adtcore="http://www.sap.com/adt/core"
  description="${desc}"
  name="${dtpName}">
  <generalInformation>
    <tlogoProperties
      adtcore:language="${language}"
      adtcore:name="${dtpName}"
      adtcore:type="DTPA"
      adtcore:masterLanguage="${language}"
      adtcore:masterSystem="${masterSystem}"
      adtcore:responsible="${responsible}"/>
  </generalInformation>
  <overview>
    <object xsi:type="Dtpa:DTPObject" name="${trfnName}" tlogo="TRFN"/>${args.trfn_name_2 ? `\n    <object xsi:type="Dtpa:DTPObject" name="${args.trfn_name_2.toUpperCase()}" tlogo="TRFN"/>` : ''}
  </overview>
  <source name="${sourceNameAttr}" tlogo="${sourceTlogo}" type="${sourceTypeAttr}"/>
  <target name="${tgtName}" tlogo="${targetTlogo}" type="${targetTypeAttr}"/>
</Dtpa:dataTransferProcess>`;

    const createClient = createClientFromEnv();
    const createCsrf = await createClient.getCsrfToken();
    await createClient.rawPost(
      `/sap/bw/modeling/dtpa/${dtpLower}?lockHandle=${lockHandle}`,
      postBody,
      {
        'Development-Class': pkg,
        'Content-Type': MEDIA_TYPES['dtpa'],
        'Accept': MEDIA_TYPES['dtpa'],
        'x-csrf-token': createCsrf,
      }
    );

    // Step 4: Explicit unlock
    const csrfToken3 = await client.getCsrfToken();
    await client.rawPost(
      `/sap/bw/modeling/dtpa/${dtpLower}?action=unlock`,
      '',
      {
        'Content-Type': MEDIA_TYPES['dtpa'],
        'Accept': MEDIA_TYPES['dtpa'],
        'x-csrf-token': csrfToken3,
      }
    );

    // Step 4b: If description or filter provided, update via Lock → GET → PUT → unlock
    if (desc || (args.filter_field && args.filter_value)) {
      const descLockCsrf = await client.getCsrfToken();
      const descLockResponse = await client.rawPost(
        `/sap/bw/modeling/dtpa/${dtpLower}?action=lock`,
        '',
        {
          'Accept': MEDIA_TYPES['dtpa'],
          'x-csrf-token': descLockCsrf,
        }
      );
      const descLockHandle = descLockResponse.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1] ?? '';
      if (!descLockHandle) {
        throw new Error(`No <LOCK_HANDLE> in description/filter lock response:\n${descLockResponse.body}`);
      }

      // GET DTP XML (fresh client) — read timestamp
      const descGetClient = createClientFromEnv();
      const descGetResponse = await descGetClient.get(`/sap/bw/modeling/dtpa/${dtpLower}/m`, MEDIA_TYPES['dtpa']);
      const descTimestamp = descGetResponse.headers['timestamp'] ?? '';

      let descXml = descGetResponse.body;

      // Update description attribute if provided
      if (desc) {
        descXml = descXml.replace(
          /(<dtpa:dataTransferProcess\b[^>]*\bdescription=)"[^"]*"/,
          `$1"${desc}"`
        );
      }

      // Inject filter if provided
      if (args.filter_field && args.filter_value) {
        const fieldBlockRegex = new RegExp(
          `(<fields[^>]*\\bname="${args.filter_field}"[^>]*>[\\s\\S]*?)<routine\\/>`
        );
        descXml = descXml.replace(fieldBlockRegex, `$1<routine/>\n      <selection excluding="false" operator="Equal">\n        <low description="${args.filter_value}" value="${args.filter_value}"/>\n      </selection>`);
      }

      // PUT with fresh client
      const descPutClient = createClientFromEnv();
      await descPutClient.put('dtpa', dtpName, descLockHandle, descXml, descTimestamp);

      // Unlock
      const descUnlockCsrf = await client.getCsrfToken();
      await client.rawPost(
        `/sap/bw/modeling/dtpa/${dtpLower}?action=unlock`,
        '',
        {
          'Content-Type': MEDIA_TYPES['dtpa'],
          'Accept': MEDIA_TYPES['dtpa'],
          'x-csrf-token': descUnlockCsrf,
        }
      );
    }

    // Step 5: Activate
    await bwActivate(client, 'dtpa', dtpName, '');

    return JSON.stringify({
      success: true,
      dtp_name: dtpName,
      transformation: trfnName,
      source: { type: srcType, name: srcName },
      target: { type: tgtType, name: tgtName },
      package: pkg,
      message: `DTP '${dtpName}' created and activated successfully.`,
    });
  } finally {
    // Best-effort release of the DTP enqueue lock — the happy path already unlocks,
    // so this typically no-ops; on an error path it frees a leaked lock.
    await bwUnlockDtp(client, dtpName).catch(() => {/* lock may already be released */});
  }
}

// ── bwRunDtp ──────────────────────────────────────────────────────────────────

/**
 * bw_run_dtp — start (execute) a DTP run.
 *
 * Single POST to /sap/bw/modeling/dtpa/executerun with a minimal <executeRun> body naming the
 * DTP. The server responds 201 Created with a Location header whose last path segment is the new
 * request id.
 *
 * Runs in a fresh session (createClientFromEnv()) — like the DTP-activation path — because the
 * executerun touches the DTP and its transformation and the shared module-level client can hold a
 * stale session buffer; a fresh session also avoids concurrency collisions across runs.
 *
 * The returned request id is a timestamp-based executerun id. It is returned for information only:
 * it is not verified to match the request TSN used by bw_get_request, so load status is monitored
 * via bw_list_requests (by target InfoProvider) and bw_get_request.
 */
export async function bwRunDtp(dtpName: string): Promise<string> {
  const dtpUpper = dtpName.toUpperCase();

  const runClient = createClientFromEnv();
  const csrfToken = await runClient.getCsrfToken();

  const body = `<?xml version="1.0" encoding="UTF-8"?><executeRun dataTransferProcess="${dtpUpper}"></executeRun>`;
  const response = await runClient.rawPost(
    '/sap/bw/modeling/dtpa/executerun',
    body,
    {
      'Accept': MEDIA_TYPES['dtpa'],
      'Content-Type': MEDIA_TYPES['dtpa'],
      'x-csrf-token': csrfToken,
    }
  );

  const location = response.headers['location'] ?? response.headers['Location'] ?? '';
  if (!location) {
    throw new Error(
      `executerun returned no Location header. Response headers: ${JSON.stringify(response.headers)}`
    );
  }
  const requestId = location.split('/').filter(Boolean).pop() ?? '';

  return JSON.stringify({
    success: true,
    dtp_name: dtpUpper,
    request_id: requestId,
    message:
      `DTP run started for ${dtpUpper} (request id ${requestId}). ` +
      `Monitor load status via bw_list_requests (by target InfoProvider) and bw_get_request.`,
  });
}

// ── bwUpdateDtp ───────────────────────────────────────────────────────────────

export interface UpdateDtpArgs {
  dtp_name: string;
  description?: string;
  filter_field?: string;
  filter_dta_name?: string;
  filter_value?: string;
  filter_excluding?: boolean;
  filter_clear_fields?: string;
  extraction_mode?: 'full' | 'delta';
  transport?: string;
  transport_lock_holder?: string;
}

/**
 * bw_update_dtp — update a DTP (description).
 *
 * Flow: Lock → GET (fresh) → PUT (fresh) → bwActivate (handles unlock).
 */
export async function bwUpdateDtp(
  client: BwClient,
  args: UpdateDtpArgs
): Promise<string> {
  const dtpName  = args.dtp_name.toUpperCase();
  const dtpLower = args.dtp_name.toLowerCase();

  // Lock (stateful_enqueue — same pattern as bwUpdateInfoObject)
  const lockHandle = await client.lock('dtpa', dtpLower, {}, 'stateful_enqueue');

  // The enqueue lock (SM12: RSBKDTP) must be released on success AND error;
  // bwActivate does not release it for dtpa, so it is freed in the finally block.
  try {
    // GET current DTP XML (fresh client) — read timestamp
    const getClient = createClientFromEnv();
    const getResponse = await getClient.get(`/sap/bw/modeling/dtpa/${bwSeg(args.dtp_name)}/m`, MEDIA_TYPES['dtpa']);
    const timestamp = getResponse.headers['timestamp'] ?? '';

    // Apply modifications
    let putXml = getResponse.body;
    if (args.description !== undefined) {
      putXml = putXml.replace(
        /(<dtpa:dataTransferProcess\b[^>]*\bdescription=)"[^"]*"/,
        `$1"${args.description}"`
      );
    }
    if (args.filter_field && args.filter_value !== undefined) {
      const excluding = args.filter_excluding ? 'true' : 'false';
      // Preserve empty string (= '' filter) — do not filter(Boolean); deduplicate via Set
      const values = [...new Set(args.filter_value.split(',').map((v) => v.trim()))];
      // Empty string → self-closing <selection> (no <low>); non-empty → <low value="..."/>
      const selectionsXml = values
        .map((v) => v === ''
          ? `<selection excluding="${excluding}" operator="Equal"/>`
          : `<selection excluding="${excluding}" operator="Equal">\n        <low description="${v}" value="${v}"/>\n      </selection>`)
        .join('\n      ') + '\n      ';
      // 1. Mark field as selected
      putXml = putXml.replace(
        new RegExp(`(<fields[^>]*\\bname="${args.filter_field}"(?![^>]*\\bselected="true")[^>]*)(>)`),
        `$1 selected="true"$2`
      );
      // 2. Remove any existing <selection> elements
      putXml = putXml.replace(
        new RegExp(`(<fields[^>]*\\bname="${args.filter_field}"[^>]*>)(<selection[^\\s/>][^>]*>[\\s\\S]*?<\\/selection>|<selection[^>]*\\/?>)\\s*(?=<(?:infoObject|operators))`,'g'),
        '$1'
      );
      // 3. Remove <routine/> if already present (to avoid duplicates)
      putXml = putXml.replace(
        new RegExp(`(<fields[^>]*\\bname="${args.filter_field}"[^>]*>)<routine\\/>`),
        '$1'
      );
      // 4. Insert <routine/> + selections before <infoObject> (InfoObject fields) or <operators> (plain fields)
      putXml = putXml.replace(
        new RegExp(`(<fields[^>]*\\bname="${args.filter_field}"[^>]*>)(<(?:infoObject|operators))`),
        `$1<routine/>\n      ${selectionsXml}$2`
      );
    }

    if (args.filter_clear_fields) {
      const fieldsToClear = args.filter_clear_fields.split(',').map((f) => f.trim()).filter(Boolean);
      for (const fieldName of fieldsToClear) {
        // Remove selected="true"
        putXml = putXml.replace(
          new RegExp(`(<fields[^>]*\\bname="${fieldName}"[^>]*)\\s+selected="true"`),
          '$1'
        );
        // Remove all <selection> elements (self-closing and with body)
        putXml = putXml.replace(
          new RegExp(`(<fields[^>]*\\bname="${fieldName}"[^>]*>)([\\s\\S]*?)(<\\/fields>)`, 'g'),
          (_match, open, body, close) => {
            const cleaned = body
              .replace(/<selection\b[^>]*\/>/g, '')
              .replace(/<selection\b[^>]*>[\s\S]*?<\/selection>/g, '');
            return open + cleaned + close;
          }
        );
      }
    }

    // Extraction mode: rewrite only extractionMode + deltaSettingStatus on the <extractionSettings>
    // element (Full = F/0, Delta = D/2). allowedExtractionModes, packageSize and parallelExtraction
    // are left unchanged; attributes may appear in any order.
    if (args.extraction_mode !== undefined) {
      const extractionMode = args.extraction_mode === 'full' ? 'F' : 'D';
      const deltaSettingStatus = args.extraction_mode === 'full' ? '0' : '2';
      putXml = putXml.replace(
        /<extractionSettings\b[^>]*\/>/,
        (tag) => tag
          .replace(/\bextractionMode="[^"]*"/, `extractionMode="${extractionMode}"`)
          .replace(/\bdeltaSettingStatus="[^"]*"/, `deltaSettingStatus="${deltaSettingStatus}"`)
      );
    }

    // PUT on a fresh stateless client — Eclipse uses a separate stateless session for PUT
    const putClient = createClientFromEnv();
    await putClient.put('dtpa', dtpName, lockHandle, putXml, timestamp, args.transport, args.transport_lock_holder);

    // Activate
    await bwActivate(client, 'dtpa', dtpName, lockHandle, args.transport);

    return JSON.stringify({
      success: true,
      dtp_name: dtpName,
      message: `DTP '${dtpName}' updated and activated successfully.`,
    });
  } finally {
    // Best-effort release of the DTP enqueue lock — never mask the operation result/error.
    await bwUnlockDtp(client, dtpLower).catch(() => {/* lock may already be released */});
  }
}

// ── bwSetDtpFilterRoutine ─────────────────────────────────────────────────────

/**
 * Splice user routine code (and optional global code) into the live
 * RSBC_SEL_ROUTINE_TPL skeleton fetched from the ADT program source, keeping the
 * marker lines and everything outside the markers verbatim.
 */
function spliceRoutineSource(skeleton: string, routineCode: string, globalCode?: string): string {
  const splice = (src: string, beginMarker: string, endMarker: string, code: string): string => {
    const lines = src.split('\n');
    const begin = lines.findIndex((l) => l.includes(beginMarker));
    const end = lines.findIndex((l) => l.includes(endMarker));
    if (begin === -1 || end === -1 || end <= begin) {
      throw new Error(`Routine template marker not found: ${beginMarker}`);
    }
    return [...lines.slice(0, begin + 1), ...code.split('\n'), ...lines.slice(end)].join('\n');
  };
  let out = splice(skeleton, 'begin of routine - insert your code', 'end of routine - insert your code', routineCode);
  if (globalCode) {
    out = splice(out, 'begin of global - insert your declaration', 'end of global - insert your declaration', globalCode);
  }
  return out;
}

export interface SetDtpFilterRoutineArgs {
  dtp_name: string;
  field_name: string;
  routine_code: string;
  global_code?: string;
}

/**
 * bw_set_dtp_filter_routine — set an ABAP filter routine on a DTP filter field.
 *
 * Flow (mirrors the working Eclipse trace, see payloads/set_dtp_filter_routine.md):
 *   1.  Lock the DTP (no CREA)
 *   2a. POST generateRoutineProgram with an EMPTY body (ID allocation only) →
 *       ABAP program name from Location header
 *   2b. GET the generated program skeleton, splice the user code into it, then
 *       lock/PUT-source/unlock on ONE dedicated ADT client (shared enqueue session)
 *   3.  ADT activate the ABAP program (reusing that client)
 *   4.  GET routineReports → read back routine XML (now populated)
 *   5.  DELETE routineReports (mandatory cleanup)
 *   6.  GET DTP XML (fresh client, read timestamp)
 *   7.  Convert routineReports XML → DTP PUT format, inject as the FIRST child of
 *       the target <fields> block
 *   8.  PUT DTP XML (fresh client)
 *   9.  bwActivate with lockHandle
 */
export async function bwSetDtpFilterRoutine(
  client: BwClient,
  args: SetDtpFilterRoutineArgs
): Promise<string> {
  const dtpUpper = args.dtp_name.toUpperCase();
  const dtpLower = args.dtp_name.toLowerCase();
  const dtpSeg = bwSeg(args.dtp_name);
  const dtpSegUpper = encodeURIComponent(bwNsName(args.dtp_name).toUpperCase());
  const fieldName = args.field_name;
  const fieldNameEncoded = encodeURIComponent(fieldName);

  // Step 1: Lock (no CREA)
  const lockCsrf = await client.getCsrfToken();
  const lockResponse = await client.rawPost(
    `/sap/bw/modeling/dtpa/${dtpSeg}?action=lock`,
    '',
    {
      'Accept': MEDIA_TYPES['dtpa'],
      'x-csrf-token': lockCsrf,
    }
  );
  const lockHandle = lockResponse.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1] ?? '';
  if (!lockHandle) {
    throw new Error(`No <LOCK_HANDLE> in lock response:\n${lockResponse.body}`);
  }

  // The enqueue lock (SM12: RSBKDTP) must be released on success AND error;
  // bwActivate does not release it for dtpa, so it is freed in the finally block.
  try {
    // Step 2a: POST generateRoutineProgram with an EMPTY body — the server only
    // allocates the program ID here and ignores any routine content.
    const routineBody = '<?xml version="1.0" encoding="UTF-8"?><routine></routine>';

    const genCsrf = await client.getCsrfToken();
    const genResponse = await client.rawPost(
      `/sap/bw/modeling/dtpa/${dtpSegUpper}/${fieldNameEncoded}/generateRoutineProgram`,
      routineBody,
      {
        'Content-Type': 'application/vnd.sap.bw.modeling.dtpa.routine.code-v1_0_0+xml',
        'Accept': MEDIA_TYPES['dtpa'],
        'x-csrf-token': genCsrf,
      }
    );

    const genLocation = genResponse.headers['location'] ?? genResponse.headers['Location'] ?? '';
    if (!genLocation) {
      throw new Error(`generateRoutineProgram returned no Location header. Headers: ${JSON.stringify(genResponse.headers)}`);
    }
    const encodedProgram = genLocation.split('/routineReports/').pop() ?? '';
    const programName = decodeURIComponent(encodedProgram);
    const adtEncoded = encodeURIComponent(programName).toLowerCase();

    // Step 2b: write the ABAP source into the generated program. The lock, source
    // PUT and unlock must share one client so the stateful enqueue session cookies
    // (sap-contextid) are reused; the same client then activates the program.
    const programClient = createClientFromEnv();

    const skeletonResp = await programClient.rawGet(
      `/sap/bc/adt/programs/programs/${adtEncoded}/source/main`,
      { 'Accept': 'text/plain' }
    );
    const splicedSource = spliceRoutineSource(skeletonResp.body, args.routine_code, args.global_code);

    const progLockCsrf = await programClient.getCsrfToken();
    const progLockResp = await programClient.rawPost(
      `/sap/bc/adt/programs/programs/${adtEncoded}?_action=LOCK&accessMode=MODIFY`,
      '',
      {
        'Accept': 'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result;q=0.8, application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result2;q=0.9',
        'X-sap-adt-sessiontype': 'stateful',
        'x-csrf-token': progLockCsrf,
      }
    );
    const progLockHandle = progLockResp.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1] ?? '';
    if (!progLockHandle) {
      throw new Error(`No <LOCK_HANDLE> in program lock response:\n${progLockResp.body}`);
    }

    const putSrcCsrf = await programClient.getCsrfToken();
    await programClient.rawPut(
      `/sap/bc/adt/programs/programs/${adtEncoded}/source/main?lockHandle=${progLockHandle}`,
      splicedSource,
      { 'Content-Type': 'text/plain; charset=utf-8', 'x-csrf-token': putSrcCsrf }
    );

    const unlockCsrf = await programClient.getCsrfToken();
    await programClient.rawPost(
      `/sap/bc/adt/programs/programs/${adtEncoded}?_action=UNLOCK&lockHandle=${progLockHandle}`,
      '',
      { 'x-csrf-token': unlockCsrf }
    );

    // Step 3: ADT activate the ABAP program (reuse programClient after the unlock)
    const adtCsrf = await programClient.getCsrfToken();
    const adtBody =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">\n` +
      `  <adtcore:objectReference adtcore:uri="/sap/bc/adt/programs/programs/${adtEncoded}"\n` +
      `                           adtcore:name="${programName.toUpperCase()}"/>\n` +
      `</adtcore:objectReferences>`;
    await programClient.rawPost(
      '/sap/bc/adt/activation?method=activate&preauditRequested=true',
      adtBody,
      {
        'Content-Type': 'application/xml',
        'Accept': 'application/xml',
        'x-csrf-token': adtCsrf,
      }
    );

    // Step 4: GET routineReports (read back routine code as XML)
    const routineGetClient = createClientFromEnv();
    const routineGetResponse = await routineGetClient.get(
      `/sap/bw/modeling/dtpa/${dtpSegUpper}/${fieldNameEncoded}/routineReports/${encodedProgram}`,
      MEDIA_TYPES['dtpa']
    );
    const routineXml = routineGetResponse.body;

    // Step 5: DELETE routineReports (mandatory cleanup)
    await client.rawDelete(
      `/sap/bw/modeling/dtpa/${dtpSegUpper}/${fieldNameEncoded}/routineReports/${encodedProgram}`,
      {
        'Content-Type': MEDIA_TYPES['dtpa'],
        'Accept': MEDIA_TYPES['dtpa'],
      }
    );

    // Step 6: GET current DTP XML (fresh client, read timestamp)
    const dtpGetClient = createClientFromEnv();
    const dtpGetResponse = await dtpGetClient.get(
      `/sap/bw/modeling/dtpa/${dtpSeg}/m`,
      MEDIA_TYPES['dtpa']
    );
    const timestamp = dtpGetResponse.headers['timestamp'] ?? '';

    // Step 7: Convert routineReports XML → DTP PUT format
    // Extract code lines from <code>...</code>
    const codeSection = routineXml.match(/<code>([\s\S]*?)<\/code>/)?.[1] ?? '';
    const extractedCodeLines = [...codeSection.matchAll(/<line>([\s\S]*?)<\/line>/g)].map(m => m[1]);

    // Extract global lines from <globalCode>...</globalCode>
    const globalSection = routineXml.match(/<globalCode>([\s\S]*?)<\/globalCode>/)?.[1] ?? '';
    const extractedGlobalLines = [...globalSection.matchAll(/<line>([\s\S]*?)<\/line>/g)].map(m => m[1]);

    // <line> → <code>, empty lines → <code xsi:nil="true"/>
    const codeElements = extractedCodeLines
      .map(line => (line ? `<code>${line}</code>` : `<code xsi:nil="true"/>`))
      .join('\n        ');

    const routineInjection = `<routine>\n        ${codeElements}\n      </routine>`;

    // <globalCode><line> → <globalRoutineCode>
    const globalElements = extractedGlobalLines
      .map(line => `    <globalRoutineCode>${line}</globalRoutineCode>`)
      .join('\n');

    // Step 8: Inject into DTP XML
    let putXml = dtpGetResponse.body;

    // The /m deserializer is sequence-sensitive: <routine> must be the FIRST child
    // of the target <fields> element. Operate on the whole field block so the
    // routine lands before <selection>/<infoObject>/<operators>.
    const fieldsBlockRegex = new RegExp(`<fields\\b[^>]*\\bname="${fieldName}"[^>]*>[\\s\\S]*?<\\/fields>`);
    const fieldsBlock = putXml.match(fieldsBlockRegex)?.[0];
    if (!fieldsBlock) {
      throw new Error(`Filter field '${fieldName}' not found in DTP body`);
    }
    let newBlock = fieldsBlock
      .replace(/<routine\s*\/>/, '')
      .replace(/<routine>[\s\S]*?<\/routine>/, '');
    newBlock = newBlock.replace(/<fields\b([^>]*)>/, (_m, attrs) => {
      const a = /\bselected="/.test(attrs) ? attrs.replace(/\bselected="[^"]*"/, 'selected="true"') : `${attrs} selected="true"`;
      return `<fields${a}>`;
    });
    newBlock = newBlock.replace(/(<fields\b[^>]*>)/, `$1\n      ${routineInjection}`);
    putXml = putXml.replace(fieldsBlockRegex, newBlock);

    // Fix 2: Remove all existing <globalRoutineCode> elements before inserting new ones
    putXml = putXml.replace(/<globalRoutineCode>[^<]*<\/globalRoutineCode>\s*/g, '');

    // Append globalRoutineCode elements before </filter>
    if (globalElements) {
      putXml = putXml.replace('</filter>', `${globalElements}\n  </filter>`);
    }

    // PUT with fresh client
    const putClient = createClientFromEnv();
    await putClient.put('dtpa', dtpUpper, lockHandle, putXml, timestamp);

    // Step 9: Activate
    await bwActivate(client, 'dtpa', dtpUpper, lockHandle);

    return JSON.stringify({
      success: true,
      dtp_name: dtpUpper,
      field_name: fieldName,
      message: `Filter routine for field '${fieldName}' on DTP '${dtpUpper}' set and activated successfully.`,
    });
  } finally {
    // Best-effort release of the DTP enqueue lock — never mask the operation result/error.
    await bwUnlockDtp(client, dtpLower).catch(() => {/* lock may already be released */});
  }
}
