import { BwClient, createClientFromEnv, MEDIA_TYPES, bwSeg } from '../bw-client.js';
import { QUERY_ACCEPT_LIST, queryWriteMediaType } from './query.js';

export interface CreateVariableArgs {
  variable_name: string;
  iobj_name: string;
  description: string;
  development_class?: string;
  ready_for_input?: boolean;
  reusable?: boolean;
  represents?: 'Interval' | 'SingleValue' | 'SeveralSingleValues' | 'SelectionOption';
  processing_type?: 'UserEntry' | 'CustomerExit' | 'Authorization' | 'ReplacementPath';
  variable_type?: 'CharacteristicValue' | 'Hierarchy' | 'HierarchyNodes';
  input_type?: 'Optional' | 'MandatoryWithInitial' | 'MandatoryWithoutInitial';
  master_language?: string;
  package?: string;
  transport?: string;
}

const VARIABLE_V10 = 'application/vnd.sap.bw.modeling.variable-v1_10_0+xml';

const VARIABLE_ACCEPT_LIST =
  'application/vnd.sap.bw.modeling.variable-v1_8_0+xml, ' +
  'application/vnd.sap.bw.modeling.variable-v1_9_0+xml, ' +
  VARIABLE_V10;

/** Accept header for the dedicated /variable/<name>/a resource. */
export function variableAccept(): string {
  const discovered = MEDIA_TYPES['variable'];
  return discovered ? `${discovered}, ${VARIABLE_ACCEPT_LIST}` : VARIABLE_ACCEPT_LIST;
}

/** Media type for the create POST body. */
function variableWriteMediaType(): string {
  return MEDIA_TYPES['variable'] ?? VARIABLE_V10;
}

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
 * Parse the atom feed the create POST returns. Every entry carries a messageType
 * and an atom:title. A messageType of "Error" is a failure (thrown); Information
 * and Warning entries are collected and returned.
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
      messages.push(`${messageType || 'Message'}: ${title}`);
    }
  }
  if (errorTitles.length > 0) {
    throw new Error(`${what} failed:\n${errorTitles.join('\n')}`);
  }
  return messages;
}

/**
 * bw_create_variable — create a reusable BW Variable (TLOGO ELEM, xsi:type
 * Qry:Variable) of processing type CustomerExit on a characteristic.
 *
 * Wire protocol per payloads/bw_create_variable_customer_exit.md:
 *   1. compexist       → name check + server-generated ELEMUID
 *   2. lock (CREA)     → lockHandle, on the generic component enqueue endpoint
 *   3. transportchecks → package/transport handshake
 *   4. POST create     → full variable definition
 *   5. unlock
 *
 * Two details make or break this flow:
 *   - The enqueue endpoint is /comp/enq/<name>, not the generic /<type>/<name>
 *     lock that client.lock() builds, and it negotiates on the QUERY media type
 *     for every ELEM component — the variable media type yields HTTP 415 there.
 *   - Session isolation: the lock runs on a stateful enqueue session, the create
 *     POST on a fresh stateless one. The lockHandle itself is session-independent.
 *
 * Enum literals are unforgiving: the server silently coerces anything it does not
 * know back to the default and still reports the object as consistent, so a wrong
 * literal looks like success. The accepted values were read off existing variables
 * rather than guessed — the mandatory ones in particular are NOT "Mandatory" but
 * MandatoryWithInitial / MandatoryWithoutInitial. Mapping to the RSZGLOBV columns:
 *   procType   (VPROCTP): 1 ReplacementPath, 3 CustomerExit, 4 SAPExit,
 *                         5 UserEntry, 6 Authorization
 *   represents (VPARSEL): P SingleValue, I Interval, M SeveralSingleValues,
 *                         S SelectionOption, Q Query, T Precalculated
 *   inputType  (ENTRYTP): 0 Optional, 1 MandatoryWithInitial,
 *                         2 MandatoryWithoutInitial
 *   type       (VARTYP):  1 CharacteristicValue, 2 HierarchyNodes, 3 Text,
 *                         4 Formula, 5 Hierarchy
 *
 * Hierarchy and HierarchyNodes carry no extra payload — they differ from
 * CharacteristicValue in the type element alone; hierarchyName, version and dateTo
 * stay empty even on the SAP-delivered ones.
 *
 * Deliberately not exposed: SAPExit (SAP-delivered, not something to create); the
 * Text and Formula variable types (they do not sit on a characteristic); and every
 * replacement-path variant except CurrentMember. QueryResult and HierarchyAttribute
 * need the internal UID of the donor query plus its InfoProvider, Key and Attribute
 * belong to text and formula variables. Always verify a new combination by reading
 * the object back before exposing it here.
 */
export async function bwCreateVariable(
  client: BwClient,
  args: CreateVariableArgs
): Promise<string> {
  const nameUpper = args.variable_name.toUpperCase();
  const nameLower = args.variable_name.toLowerCase();
  const iobjName = args.iobj_name.toUpperCase();
  const pkg = args.package ?? args.development_class ?? '$TMP';
  const transport = args.transport?.toUpperCase();
  const readyForInput = args.ready_for_input ?? true;
  const reusable = args.reusable ?? true;
  const represents = args.represents ?? 'Interval';
  const procType = args.processing_type ?? 'UserEntry';
  const variableType = args.variable_type ?? 'CharacteristicValue';
  const inputType = args.input_type ?? 'Optional';
  // Only the current-member variant is supported; it needs no donor object.
  const replacementPathXml =
    procType === 'ReplacementPath'
      ? '<Qry:replacementPath type="CurrentMember" asBoolean="false" offsetStart="0000"' +
        ' offsetLength="0000" calculateBeforeNonCum="false"/>'
      : '';
  const language = args.master_language?.toUpperCase() ?? process.env.BW_LANGUAGE?.toUpperCase() ?? 'EN';
  const masterSystem = new URL(process.env.BW_URL ?? 'http://localhost').hostname
    .split('.')[0]
    .toUpperCase();
  const responsible = (process.env.BW_USER ?? '').toUpperCase();
  const timestampIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const descEsc = escapeXml(args.description);

  const basePath = `/sap/bw/modeling/variable/${bwSeg(nameLower)}/a`;
  const enqPath = `/sap/bw/modeling/comp/enq/${bwSeg(nameLower)}`;

  // Step 1: compexist — name check + server-generated ELEMUID.
  const existResult = await client.rawGet(
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

  // Step 2: lock (CREA) on the enqueue endpoint.
  const lockResult = await client.rawPost(`${enqPath}?action=lock&compuid=${elemUid}`, '', {
    activity_context: 'CREA',
    Accept: `${queryWriteMediaType()}, ${QUERY_ACCEPT_LIST}`,
    'bwmt-level': '50',
    'x-csrf-token': await client.getCsrfToken(),
  });
  const lockHandle = lockResult.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1];
  if (!lockHandle) {
    throw new Error(`No <LOCK_HANDLE> in CREA lock response:\n${lockResult.body}`);
  }

  let messages: string[] = [];
  try {
    // Step 3: transportchecks.
    const transportBody = `<?xml version="1.0" encoding="UTF-8" ?>
<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>
  <PGMID></PGMID>
  <OBJECT>VAR</OBJECT>
  <OBJECTNAME>${elemUid}</OBJECTNAME>
  <DEVCLASS>${escapeXml(pkg)}</DEVCLASS>
  <SUPER_PACKAGE></SUPER_PACKAGE>
  <RECORD_CHANGES></RECORD_CHANGES>
  <OPERATION>I</OPERATION>
  <URI>${escapeXml(basePath)}?compuid=${elemUid}&amp;lockHandle=${lockHandle}</URI>
</DATA></asx:values></asx:abap>`;
    const transportResult = await client.rawPost(
      '/sap/bc/adt/cts/transportchecks',
      transportBody,
      {
        'Content-Type':
          'application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.transport.service.checkData',
        'x-csrf-token': await client.getCsrfToken(),
      }
    );
    const transportRc = transportResult.body.match(/<RESULT>([^<]*)<\/RESULT>/)?.[1];
    if (transportRc === 'E') {
      throw new Error(`transportchecks failed for package '${pkg}':\n${transportResult.body}`);
    }

    // Step 4: POST create on a fresh session (the lockHandle is session-independent).
    const variableBody = `<?xml version="1.0" encoding="UTF-8"?>
<Qry:queryResource xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:Qry="http://www.sap.com/bw/Query.ecore" xmlns:adtcore="http://www.sap.com/adt/core">
  <Qry:schemaVersion>1.0</Qry:schemaVersion>
  <Qry:mainComponent xsi:type="Qry:Variable" id="${elemUid}" componentVersion="100" reusable="${reusable}" technicalName="${nameUpper}" dimIndicator="Blank" infoObject="${iobjName}" readyForInput="${readyForInput}">
    <Qry:description default="false" value="${descEsc}"/>
    <Qry:defaultHint>
      <Qry:type>InfoObject</Qry:type>
      <Qry:value>${iobjName}</Qry:value>
    </Qry:defaultHint>
    <Qry:entityProperties adtcore:changedAt="${timestampIso}" adtcore:changedBy="${responsible}" adtcore:createdAt="${timestampIso}" adtcore:createdBy="${responsible}" adtcore:description="${descEsc}" adtcore:language="${language}" adtcore:name="${nameUpper}" adtcore:type="VAR" adtcore:masterLanguage="${language}" adtcore:masterSystem="${masterSystem}" adtcore:responsible="${responsible}">
      <adtcore:packageRef adtcore:packageName="${escapeXml(pkg)}" adtcore:type="VAR"/>
    </Qry:entityProperties>
    <Qry:defaultValues>
      <Qry:selections infoObject="${iobjName}" paramSelectionType="Default" usageType="asFilter"/>
    </Qry:defaultValues>
    ${replacementPathXml}
    <Qry:type>${variableType}</Qry:type>
    <Qry:procType>${procType}</Qry:procType>
    <Qry:represents>${represents}</Qry:represents>
    <Qry:inputType>${inputType}</Qry:inputType>
  </Qry:mainComponent>
</Qry:queryResource>`;

    const corrNrPrefix = transport ? `corrNr=${transport}&` : '';
    const createClient = createClientFromEnv();
    const createResult = await createClient.rawPost(
      `${basePath}?compuid=${elemUid}&${corrNrPrefix}lockHandle=${lockHandle}`,
      variableBody,
      {
        'Development-Class': pkg,
        ELEMUID: elemUid,
        'Content-Type': `application/xml, ${variableWriteMediaType()}`,
        Accept: variableAccept(),
        'bwmt-level': '50',
        'x-csrf-token': await createClient.getCsrfToken(),
      }
    );
    messages = parseCheckResult(createResult.body, `Variable ${nameUpper} creation`);
  } finally {
    // Step 5: release the CREA lock — always, the create phase is over either way.
    try {
      await client.rawPost(`${enqPath}?action=unlock&compuid=${elemUid}`, '', {
        'bwmt-level': '50',
        'x-csrf-token': await client.getCsrfToken(),
      });
    } catch (unlockErr) {
      process.stderr.write(
        `Warning: failed to release CREA lock for variable/${nameLower}: ${unlockErr}\n`
      );
    }
  }

  return JSON.stringify(
    {
      success: true,
      variable_name: nameUpper,
      elemuid: elemUid,
      iobj_name: iobjName,
      description: args.description,
      package: pkg,
      processing_type: procType,
      variable_type: variableType,
      represents,
      input_type: inputType,
      ready_for_input: readyForInput,
      reusable,
      master_language: language,
      messages,
    },
    null,
    2
  );
}
