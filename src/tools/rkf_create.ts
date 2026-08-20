import { BwClient, createClientFromEnv, bwSeg } from '../bw-client.js';
import { rkfAccept, rkfWriteMediaType, QUERY_ACCEPT_LIST, queryWriteMediaType } from './query.js';

/**
 * bw_create_rkf — create one reusable Restricted Key Figure (TLOGO ELEM, xsi:type
 * Qry:RestrictedMeasure) on an InfoProvider. Designed for mass creation: one RKF
 * per call, the agent loops.
 *
 * Wire protocol per payloads/rkf_create.md. The flow is a two-phase create:
 *   1. compexist         → name check + server-generated ELEMUID
 *   2. lock (CREA)       → lockHandle for the create phase
 *   3. transportchecks   → package/transport handshake
 *   4. POST create       → skeleton carrying only the base key figure
 *   5. unlock
 *   6. lock (edit)       → fresh lockHandle + timestamp header
 *   7. comp/validator    → validate each restriction value, map to internal key
 *   8. PUT               → full RKF with the restriction groups
 *   9. GET forceCacheUpdate → final version
 *   10. unlock
 *
 * Session isolation (see payloads/rkf_create.md and the transformation/InfoObject
 * create tools): the create phase (steps 1-5) and the edit phase (steps 6-10) run
 * on separate BwClient sessions, and the POST-create runs on yet another fresh
 * session using the (session-independent) lockHandle from the enqueue session —
 * the model buffer of the session that created the skeleton would otherwise serve
 * a stale document to the PUT.
 */

export type RkfOperator =
  | 'Equal'
  | 'Between'
  | 'LessThan'
  | 'GreaterThan'
  | 'LessEqual'
  | 'GreaterEqual'
  | 'Contains';

export interface RkfRestrictionValue {
  low: string;
  /** Upper bound; only used (and required) for operator Between. */
  high?: string;
}

export interface RkfRestriction {
  characteristic: string;
  operator?: RkfOperator;
  values: RkfRestrictionValue[];
  exclude?: boolean;
}

export interface CreateRkfArgs {
  provider_name: string;
  technical_name: string;
  description: string;
  base_key_figure: string;
  restrictions: RkfRestriction[];
  info_area?: string;
  package?: string;
  transport_request?: string;
}

/** Escape a string for use in an XML attribute value or text node. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Case-insensitive header lookup (axios lowercases response header names). */
function header(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

/**
 * Parse the atom feed a create POST / update PUT returns. Every entry carries a
 * messageType and an atom:title. A messageType of "Error" is a failure (thrown);
 * "Information" and "Warning" are success and returned as messages. This is a
 * structured check on messageType — no SAP message strings are matched.
 */
function parseCheckResult(body: string, what: string): string[] {
  const messages: string[] = [];
  const errorTitles: string[] = [];
  const entryRegex = /<atom:entry>([\s\S]*?)<\/atom:entry>/g;
  let entryMatch: RegExpExecArray | null;
  while ((entryMatch = entryRegex.exec(body)) !== null) {
    const entry = entryMatch[1];
    const messageType = entry.match(/messageType="([^"]*)"/)?.[1] ?? '';
    const title = entry.match(/<atom:title>([\s\S]*?)<\/atom:title>/)?.[1]?.trim() ?? '';
    if (messageType === 'Error') {
      errorTitles.push(title || '(no title)');
    } else if (title) {
      messages.push(title);
    }
  }
  if (errorTitles.length > 0) {
    throw new Error(`${what} reported errors: ${errorTitles.join('; ')}`);
  }
  return messages;
}

const RKF_ACCEPT_LIST =
  'application/vnd.sap.bw.modeling.rkf-v1_8_0+xml, ' +
  'application/vnd.sap.bw.modeling.rkf-v1_9_0+xml, ' +
  'application/vnd.sap.bw.modeling.rkf-v1_10_0+xml';

interface ValidatedValue {
  lowIntKey: string;
  lowDesc: string;
  highIntKey?: string;
  highDesc?: string;
}

/** One restriction token (Qry:tokens / Qry:SelectionRange) built from validated values. */
function buildRestrictionToken(
  operator: RkfOperator,
  exclude: boolean,
  v: ValidatedValue
): string {
  const excludeAttr = exclude ? ' exclude="true"' : '';
  const fromDescAttr = v.lowDesc ? ` fromValueDesc="${escapeXml(v.lowDesc)}"` : '';
  if (operator === 'Between') {
    const toDescAttr = v.highDesc ? ` toValueDesc="${escapeXml(v.highDesc)}"` : '';
    return `        <Qry:tokens xsi:type="Qry:SelectionRange" usageType="asFilter"${excludeAttr}${fromDescAttr}${toDescAttr} operator="Between">
          <Qry:fromValue>
            <Qry:type>Value</Qry:type>
            <Qry:value>${escapeXml(v.lowIntKey)}</Qry:value>
          </Qry:fromValue>
          <Qry:toValue>
            <Qry:type>Value</Qry:type>
            <Qry:value>${escapeXml(v.highIntKey ?? '')}</Qry:value>
          </Qry:toValue>
        </Qry:tokens>`;
  }
  return `        <Qry:tokens xsi:type="Qry:SelectionRange" usageType="asFilter"${excludeAttr}${fromDescAttr} operator="${operator}">
          <Qry:fromValue>
            <Qry:type>Value</Qry:type>
            <Qry:value>${escapeXml(v.lowIntKey)}</Qry:value>
          </Qry:fromValue>
        </Qry:tokens>`;
}

export async function bwCreateRkf(client: BwClient, args: CreateRkfArgs): Promise<string> {
  // ── Validate inputs ─────────────────────────────────────────────────────────
  if (!args.provider_name) throw new Error('provider_name is required.');
  if (!args.technical_name) throw new Error('technical_name is required.');
  if (!args.description) throw new Error('description is required.');
  if (!args.base_key_figure) throw new Error('base_key_figure is required.');
  if (!Array.isArray(args.restrictions) || args.restrictions.length === 0) {
    throw new Error('restrictions must be a non-empty array.');
  }
  for (const r of args.restrictions) {
    if (!r.characteristic) throw new Error('Each restriction requires a characteristic.');
    if (!Array.isArray(r.values) || r.values.length === 0) {
      throw new Error(`Restriction on '${r.characteristic}' requires a non-empty values array.`);
    }
    const op = r.operator ?? 'Equal';
    for (const v of r.values) {
      if (!v.low) throw new Error(`Restriction on '${r.characteristic}' has a value without 'low'.`);
      if (op === 'Between' && (v.high === undefined || v.high === '')) {
        throw new Error(`Between restriction on '${r.characteristic}' requires 'high' for every value.`);
      }
    }
  }

  const provider = args.provider_name.toUpperCase();
  const nameUpper = args.technical_name.toUpperCase();
  const nameLower = args.technical_name.toLowerCase();
  const pkg = args.package ?? '$TMP';
  const transport = args.transport_request?.toUpperCase();
  const infoArea = args.info_area?.toUpperCase();

  const language = process.env.BW_LANGUAGE ?? 'DE';
  const masterSystem = new URL(process.env.BW_URL ?? 'http://localhost').hostname
    .split('.')[0]
    .toUpperCase();
  const responsible = (process.env.BW_USER ?? '').toUpperCase();
  const timestampIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const descEsc = escapeXml(args.description);

  const basePath = `/sap/bw/modeling/rkf/${bwSeg(nameLower)}/a`;
  const enqPath = `/sap/bw/modeling/comp/enq/${bwSeg(nameLower)}`;
  const rkfMedia = rkfWriteMediaType();

  // ── Phase A: create the skeleton (session A + a fresh POST session) ──────────
  const clientA = client;

  // Step 1: compexist — name check + server-generated ELEMUID.
  const existResult = await clientA.rawGet(
    `/sap/bw/modeling/queryint?action=compexist&compid=${nameLower}&type=ELEM`,
    { 'bwmt-level': '50' }
  );
  if (header(existResult.headers, 'compexist') === 'true') {
    throw new Error(`A component named '${nameUpper}' already exists.`);
  }
  const elemUid = header(existResult.headers, 'elemuid');
  if (!elemUid) {
    throw new Error(
      `compexist did not return an ELEMUID header. Headers: ${JSON.stringify(existResult.headers)}`
    );
  }
  const objUri = header(existResult.headers, 'objuri') ?? `${basePath.replace(/\/a$/, '')}/A`;

  // Step 2: lock (CREA) on the enqueue endpoint.
  const lockA = await clientA.rawPost(`${enqPath}?action=lock&compuid=${elemUid}`, '', {
    activity_context: 'CREA',
    // The generic comp/enq endpoint negotiates on the query media type for every ELEM
    // component (Query and RKF alike) — the rkf media type is only valid on the dedicated
    // /rkf/<name>/a resource and yields HTTP 415 here. Prefer the discovery-advertised
    // query type (queryWriteMediaType) with the static list as an SP-drift fallback.
    Accept: `${queryWriteMediaType()}, ${QUERY_ACCEPT_LIST}`,
    'bwmt-level': '50',
    'x-csrf-token': await clientA.getCsrfToken(),
  });
  const lockHandleA = lockA.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1];
  if (!lockHandleA) {
    throw new Error(`No <LOCK_HANDLE> in CREA lock response:\n${lockA.body}`);
  }

  const unlockCrea = async () => {
    await clientA.rawPost(`${enqPath}?action=unlock&compuid=${elemUid}`, '', {
      'bwmt-level': '50',
      'x-csrf-token': await clientA.getCsrfToken(),
    });
  };

  const corrNrPrefix = transport ? `corrNr=${transport}&` : '';

  try {
    // Step 3: transportchecks.
    const transportBody = `<?xml version="1.0" encoding="UTF-8" ?>
<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>
  <PGMID></PGMID>
  <OBJECT>RKF</OBJECT>
  <OBJECTNAME>${elemUid}</OBJECTNAME>
  <DEVCLASS>${escapeXml(pkg)}</DEVCLASS>
  <SUPER_PACKAGE></SUPER_PACKAGE>
  <RECORD_CHANGES></RECORD_CHANGES>
  <OPERATION>I</OPERATION>
  <URI>${escapeXml(basePath)}?compuid=${elemUid}&amp;lockHandle=${lockHandleA}</URI>
</DATA></asx:values></asx:abap>`;
    const transportResult = await clientA.rawPost(
      '/sap/bc/adt/cts/transportchecks',
      transportBody,
      {
        'Content-Type':
          'application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.transport.service.checkData',
        'x-csrf-token': await clientA.getCsrfToken(),
      }
    );
    const transportRc = transportResult.body.match(/<RESULT>([^<]*)<\/RESULT>/)?.[1];
    if (transportRc === 'E') {
      throw new Error(`transportchecks failed for package '${pkg}':\n${transportResult.body}`);
    }

    // Step 4: POST create skeleton (fresh session, session-independent lockHandle).
    const skeletonBody = `<?xml version="1.0" encoding="UTF-8"?>
<Qry:queryResource xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:Qry="http://www.sap.com/bw/Query.ecore" xmlns:adtcore="http://www.sap.com/adt/core">
  <Qry:schemaVersion>1.0</Qry:schemaVersion>
  <Qry:mainComponent xsi:type="Qry:RestrictedMeasure" id="${elemUid}" componentVersion="11" providerName="${provider}" reusable="true" technicalName="${nameUpper}">
    <Qry:description default="false" value="${descEsc}"/>
    <Qry:entityProperties adtcore:changedAt="${timestampIso}" adtcore:changedBy="${responsible}" adtcore:createdAt="${timestampIso}" adtcore:createdBy="${responsible}" adtcore:description="${descEsc}" adtcore:language="${language}" adtcore:name="${nameUpper}" adtcore:type="RKF" adtcore:masterLanguage="${language}" adtcore:masterSystem="${masterSystem}" adtcore:responsible="${responsible}"/>
    <Qry:member id="${elemUid}">
      <Qry:defaultHint/><Qry:hidden/><Qry:emphasize/><Qry:signInversion/>
      <Qry:scaling/><Qry:decimals/><Qry:calculation/>
      <Qry:planning><Qry:inputMode/><Qry:disaggregation/></Qry:planning>
      <Qry:currencyConversion/><Qry:unitConversion/>
      <Qry:groups infoObject="1KYFNM">
        <Qry:tokens xsi:type="Qry:SelectionRange" usageType="asFilter" selectionType="keyFigure" operator="Equal">
          <Qry:fromValue>
            <Qry:type>Value</Qry:type>
            <Qry:value>${escapeXml(args.base_key_figure.toUpperCase())}</Qry:value>
          </Qry:fromValue>
        </Qry:tokens>
      </Qry:groups>
    </Qry:member>
  </Qry:mainComponent>
</Qry:queryResource>`;

    const clientCreate = createClientFromEnv();
    const createResult = await clientCreate.rawPost(
      `${basePath}?compuid=${elemUid}&${corrNrPrefix}lockHandle=${lockHandleA}`,
      skeletonBody,
      {
        'Development-Class': pkg,
        ELEMUID: elemUid,
        // The dedicated /rkf/<name>/a resource negotiates on a lower version than the
        // discovery-advertised collection (observed: resource speaks rkf-v1_9_0 while
        // discovery advertises rkf-v1_10_0). Send Accept as a version range (like the
        // read path) so the server can pick the version it actually speaks; a single
        // discovery-derived value yields HTTP 415 (message 024, Accept mismatch).
        'Content-Type': `application/xml, ${rkfMedia}`,
        Accept: rkfAccept(),
        'bwmt-level': '50',
        'x-csrf-token': await clientCreate.getCsrfToken(),
      }
    );
    parseCheckResult(createResult.body, 'RKF skeleton creation');
  } finally {
    // Step 5: release the CREA lock (always — the create phase is over either way).
    try {
      await unlockCrea();
    } catch (unlockErr) {
      process.stderr.write(`Warning: failed to release CREA lock for rkf/${nameLower}: ${unlockErr}\n`);
    }
  }

  // ── Phase B: add restrictions on a separate session (steps 6-10) ─────────────
  const clientB = createClientFromEnv();

  // Step 6: lock for editing (no activity_context) — yields a fresh lockHandle and
  // the timestamp header used for optimistic locking on the PUT.
  const lockB = await clientB.rawPost(`${basePath}?action=lock`, '', {
    Accept: RKF_ACCEPT_LIST,
    'bwmt-level': '50',
    'x-csrf-token': await clientB.getCsrfToken(),
  });
  const lockHandleB = lockB.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1];
  if (!lockHandleB) {
    throw new Error(`No <LOCK_HANDLE> in edit lock response:\n${lockB.body}`);
  }
  const editTimestamp = header(lockB.headers, 'timestamp');
  if (!editTimestamp) {
    throw new Error(
      `No timestamp header on the edit lock for rkf/${nameLower} — cannot do optimistic locking.`
    );
  }

  let validatedValueCount = 0;
  try {
    // Step 7: validate every restriction value and build the restriction groups.
    const groupsXml: string[] = [];
    for (const r of args.restrictions) {
      const characteristic = r.characteristic.toUpperCase();
      const operator = r.operator ?? 'Equal';
      const exclude = r.exclude === true;
      const tokens: string[] = [];
      for (const v of r.values) {
        const validated = await validateValue(
          clientB,
          characteristic,
          provider,
          v.low,
          operator === 'Between' ? v.high : undefined
        );
        validatedValueCount++;
        tokens.push(buildRestrictionToken(operator, exclude, validated));
      }
      groupsXml.push(
        `      <Qry:groups infoObject="${characteristic}">
${tokens.join('\n')}
      </Qry:groups>`
      );
    }

    // Step 8: PUT the full RKF (member id = ELEMUID + "self").
    const infoAreaEl = infoArea ? `\n      <infoArea>${escapeXml(infoArea)}</infoArea>` : '';
    const putBody = `<?xml version="1.0" encoding="UTF-8"?>
<Qry:queryResource xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:Qry="http://www.sap.com/bw/Query.ecore" xmlns:adtCore="http://www.sap.com/adt/core" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:bwCore="http://www.sap.com/bw/modeling/BwCore.ecore">
  <Qry:schemaVersion>1.0</Qry:schemaVersion>
  <Qry:mainComponent xsi:type="Qry:RestrictedMeasure" id="${elemUid}" authoringTool="3" componentVersion="11" contentRelease="" contentTimestamp="0" providerName="${provider}" reusable="true" technicalName="${nameUpper}" timestamp="${editTimestamp}">
    <Qry:description default="false" value="${descEsc}"/>
    <Qry:defaultHint/>
    <Qry:entityProperties adtCore:changedAt="${timestampIso}" adtCore:changedBy="${responsible}" adtCore:createdAt="${timestampIso}" adtCore:createdBy="${responsible}" adtCore:description="${descEsc}" adtCore:language="${language}" adtCore:name="${nameUpper}" adtCore:type="ELEM" adtCore:masterLanguage="${language}" adtCore:masterSystem="${masterSystem}" adtCore:responsible="${responsible}">
      <adtCore:packageRef adtCore:name="${escapeXml(pkg)}" adtCore:type="DEVC/K" adtCore:uri="/sap/bc/adt/packages/${encodeURIComponent(pkg.toLowerCase())}"/>${infoAreaEl}
    </Qry:entityProperties>
    <Qry:member drillStateExec="Blank" flatPosition="0" id="${elemUid}self">
      <Qry:description default="false" value="${descEsc}"/>
      <Qry:mapName>${nameUpper}</Qry:mapName>
      <Qry:defaultHint/><Qry:hidden/><Qry:emphasize/><Qry:signInversion/>
      <Qry:scaling/><Qry:decimals/><Qry:calculation/>
      <Qry:planning><Qry:inputMode/><Qry:disaggregation/></Qry:planning>
      <Qry:currencyConversion/><Qry:unitConversion/>
      <Qry:groups description="Key Figures" infoObject="1KYFNM">
        <Qry:tokens xsi:type="Qry:SelectionRange" usageType="asFilter" selectionType="keyFigure" fromValueDesc="${escapeXml(args.base_key_figure.toUpperCase())}" operator="Equal">
          <Qry:fromValue>
            <Qry:type>Value</Qry:type>
            <Qry:value>${escapeXml(args.base_key_figure.toUpperCase())}</Qry:value>
          </Qry:fromValue>
        </Qry:tokens>
      </Qry:groups>
${groupsXml.join('\n')}
    </Qry:member>
  </Qry:mainComponent>
</Qry:queryResource>`;

    const putResult = await clientB.rawPut(
      `${basePath}?${corrNrPrefix}lockHandle=${lockHandleB}`,
      putBody,
      {
        timestamp: editTimestamp,
        // Accept as a version range — see the POST-create note; the resource speaks a
        // lower version than discovery advertises.
        'Content-Type': `application/xml, ${rkfMedia}`,
        Accept: rkfAccept(),
        'bwmt-level': '50',
        'x-csrf-token': await clientB.getCsrfToken(),
      }
    );
    const consistencyMessages = parseCheckResult(putResult.body, 'RKF update');

    // Step 9: read back the final version through the same (edit) session.
    await clientB.get(`${basePath}?forceCacheUpdate=true`, rkfAccept());

    return JSON.stringify(
      {
        success: true,
        object_type: 'rkf',
        technical_name: nameUpper,
        provider_name: provider,
        base_key_figure: args.base_key_figure.toUpperCase(),
        restriction_count: args.restrictions.length,
        obj_uri: objUri,
        package: pkg,
        ...(infoArea ? { info_area: infoArea } : {}),
        ...(transport ? { transport_request: transport } : {}),
        consistency_messages: consistencyMessages,
        message: `Restricted key figure '${nameUpper}' created on InfoProvider '${provider}' with ${args.restrictions.length} restriction(s).`,
        debug: {
          elem_uid: elemUid,
          crea_lock_handle_present: true,
          edit_lock_handle_present: true,
          edit_timestamp: editTimestamp,
          validated_value_count: validatedValueCount,
        },
      },
      null,
      2
    );
  } finally {
    // Step 10: release the edit lock.
    try {
      await clientB.rawPost(`${basePath}?action=unlock`, '', {
        'bwmt-level': '50',
        'x-csrf-token': await clientB.getCsrfToken(),
      });
    } catch (unlockErr) {
      process.stderr.write(`Warning: failed to release edit lock for rkf/${nameLower}: ${unlockErr}\n`);
    }
  }
}

/**
 * Validate one restriction value via comp/validator and return the internal key
 * plus display text. For a range the upper bound is validated in the same call.
 * Stops (throws) when the validator returns no internal key for the low value.
 */
async function validateValue(
  client: BwClient,
  characteristic: string,
  provider: string,
  low: string,
  high: string | undefined
): Promise<ValidatedValue> {
  const highParam = high !== undefined ? `&highvalue=${encodeURIComponent(high)}` : '';
  const result = await client.rawGet(
    `/sap/bw/modeling/comp/validator?name=${encodeURIComponent(characteristic)}` +
      `&type=CHA&iprov=${encodeURIComponent(provider)}` +
      `&lowvalue=${encodeURIComponent(low)}${highParam}&texts=true`,
    { versionLevel: '1', extFormat: 'true' }
  );
  const lowIntKey = header(result.headers, 'lowintkey');
  if (!lowIntKey) {
    throw new Error(
      `Validation failed for characteristic '${characteristic}' value '${low}': ` +
        `comp/validator returned no internal key (lowIntKey). Check the value is valid on InfoProvider '${provider}'.`
    );
  }
  const validated: ValidatedValue = {
    lowIntKey,
    lowDesc: header(result.headers, 'lowdesc') ?? '',
  };
  if (high !== undefined) {
    const highIntKey = header(result.headers, 'highintkey');
    if (!highIntKey) {
      throw new Error(
        `Validation failed for characteristic '${characteristic}' high value '${high}': ` +
          `comp/validator returned no internal key (highIntKey).`
      );
    }
    validated.highIntKey = highIntKey;
    validated.highDesc = header(result.headers, 'highdesc') ?? '';
  }
  return validated;
}
