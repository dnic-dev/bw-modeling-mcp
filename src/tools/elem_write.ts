import { XMLParser } from 'fast-xml-parser';
import { BwClient, createClientFromEnv, bwSeg, lockSessionHeader } from '../bw-client.js';
import {
  ckfAccept,
  rkfAccept,
  structureAccept,
  variableAccept,
  QUERY_ACCEPT_LIST,
  queryWriteMediaType,
} from './query.js';
import {
  escapeXml,
  FORMULA_OPERATOR_ARITY,
  applyMemberProperties,
  allocateVirtualId,
  buildRestrictionGroups,
  descriptionEl,
  walkMembers,
  type FormulaNode,
  type MemberProperties,
  type KeyFigureRestriction,
} from './query_update.js';
import type { RkfRestriction, RkfRestrictionValue, RkfOperator } from './rkf_create.js';

/**
 * Write paths for the reusable query components CKF, RKF and Structure (all TLOGO
 * ELEM, each on its own modeling resource). `bw_create_rkf` in rkf_create.ts covers
 * RKF creation; everything else lives here.
 *
 * Two wire shapes matter, and they differ from the query document:
 *
 *   - A formula inside a reusable component references another component **directly**
 *     by its ELEMUID with `operandType="Formula"`. Inside a query the same reference
 *     must go through a structure member (`operandType="Member"`) — see
 *     renderFormulaNode in query_update.ts. Using the query form here produces a
 *     formula the generator rejects, and vice versa.
 *   - Referenced components are additionally embedded as `Qry:subComponents` siblings
 *     ahead of `Qry:mainComponent`. The backend materialises those itself from the
 *     formula's member ids, so the write path only has to get the ids right.
 *
 * Updates are read-modify-write on the live document rather than a rebuild from
 * arguments: a CKF formula is business logic, and re-deriving attributes we do not
 * model (contentRelease, authoringTool, nodeExpanded, …) would silently rewrite them.
 */

// ── Shared helpers ───────────────────────────────────────────────────────────

/** Case-insensitive header lookup (axios lowercases response header names). */
function header(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

/**
 * Parse the atom feed a create POST / update PUT returns. A messageType of "Error"
 * is a failure (thrown); "Information" and "Warning" are returned as messages.
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
    if (messageType === 'Error') errorTitles.push(title || '(no title)');
    else if (title) messages.push(title);
  }
  if (errorTitles.length > 0) {
    throw new Error(`${what} reported errors: ${errorTitles.join('; ')}`);
  }
  return messages;
}

/**
 * Report where the object was actually recorded.
 *
 * The consistency feed frequently carries "no change recording required" even when
 * the object *was* recorded — the entry lands in the developer task belonging to the
 * request, not under the request number itself, and the message is emitted before
 * that is known. Reading E071 back turns that into a fact instead of leaving the
 * caller to conclude "not in the transport, do it again".
 */
export async function recordedIn(client: BwClient, elemUid: string): Promise<string | undefined> {
  try {
    const { queryTable } = await import('./metadata_tables.js');
    const rows = await queryTable(
      client,
      `select trkorr from e071 where pgmid = 'R3TR' and object = 'ELEM' and obj_name = '${elemUid}'`,
      5
    );
    const trkorr = rows.map((r) => String(r['TRKORR'] ?? '')).filter(Boolean);
    return trkorr.length > 0 ? trkorr.join(', ') : undefined;
  } catch {
    // A failed cross-check must never fail the write it is only describing.
    return undefined;
  }
}

type ElemResource = 'ckf' | 'rkf' | 'structure' | 'variable';

function acceptFor(resource: ElemResource): string {
  if (resource === 'ckf') return ckfAccept();
  if (resource === 'rkf') return rkfAccept();
  if (resource === 'variable') return variableAccept();
  return structureAccept();
}

/**
 * Read-modify-write on one reusable component document.
 *
 * Save cycle, identical in shape to withQueryDocument: GET (+ timestamp header) →
 * lock → PUT the mutated document with lockHandle and timestamp → forceCacheUpdate
 * GET → unlock. The PUT runs on a fresh session because the session that issued the
 * GET serves the document from a pinned model buffer.
 */
async function withElementDocument(
  client: BwClient,
  resource: ElemResource,
  componentName: string,
  mutate: (xml: string) => string,
  corrNr?: string
): Promise<{ messages: string[]; document: string }> {
  const nameLower = componentName.toLowerCase();
  const path = `/sap/bw/modeling/${resource}/${bwSeg(nameLower)}/a`;
  const accept = acceptFor(resource);

  const getResult = await client.get(path, accept);
  const timestamp = header(getResult.headers, 'timestamp');
  if (!timestamp) {
    throw new Error(`No timestamp header on GET ${path} — cannot do optimistic locking.`);
  }

  const lockResponse = await client.rawPost(`${path}?action=lock`, '', {
    Accept: accept,
    'bwmt-level': '50',
    'x-csrf-token': await client.getCsrfToken(),
    ...lockSessionHeader(),
  });
  const lockHandle = lockResponse.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1];
  if (!lockHandle) {
    throw new Error(`No <LOCK_HANDLE> in lock response for ${resource}/${nameLower}:\n${lockResponse.body}`);
  }

  try {
    const mutated = mutate(getResult.body);
    const client2 = createClientFromEnv();
    const corrNrPrefix = corrNr ? `corrNr=${corrNr}&` : '';
    const putResponse = await client2.rawPut(`${path}?${corrNrPrefix}lockHandle=${lockHandle}`, mutated, {
      timestamp,
      'Content-Type': `application/xml, ${accept.split(',')[0].trim()}`,
      Accept: accept,
      'bwmt-level': '50',
      'x-csrf-token': await client2.getCsrfToken(),
    });
    const messages = parseCheckResult(putResponse.body, `${resource.toUpperCase()} update`);
    await client.get(`${path}?forceCacheUpdate=true`, accept);
    return { messages, document: mutated };
  } finally {
    try {
      await client.rawPost(`${path}?action=unlock`, '', {
        'bwmt-level': '50',
        'x-csrf-token': await client.getCsrfToken(),
      });
    } catch (unlockErr) {
      process.stderr.write(`Warning: failed to unlock ${resource}/${nameLower}: ${unlockErr}\n`);
    }
  }
}

/**
 * Resolve a reusable component's ELEMUID by technical name. compexist answers for
 * existing components too — it reports existence in one header and the id in another.
 */
async function resolveComponentUid(client: BwClient, technicalName: string): Promise<string> {
  const result = await client.rawGet(
    `/sap/bw/modeling/queryint?action=compexist&compid=${encodeURIComponent(technicalName.toLowerCase())}&type=ELEM`,
    { 'bwmt-level': '50' }
  );
  if (header(result.headers, 'compexist') !== 'true') {
    throw new Error(`Component '${technicalName.toUpperCase()}' does not exist.`);
  }
  const uid = header(result.headers, 'elemuid');
  if (!uid) {
    throw new Error(`compexist returned no ELEMUID for '${technicalName.toUpperCase()}'.`);
  }
  return uid;
}

/**
 * Resolve the element type of a reusable component. RSZELTDIR's SUBDEFTP names it
 * directly ("RKF" / "CKF" / "STR"); DEFTP does not — an RKF is filed there as "SEL".
 */
async function resolveComponentKind(client: BwClient, technicalName: string): Promise<'ckf' | 'rkf'> {
  const { queryTable } = await import('./metadata_tables.js');
  const rows = await queryTable(
    client,
    `select subdeftp from rszeltdir where objvers = 'A' and mapname = '${technicalName.toUpperCase().replace(/'/g, "''")}'`,
    5
  );
  const kind = String(rows[0]?.['SUBDEFTP'] ?? '').toUpperCase();
  if (kind === 'CKF') return 'ckf';
  if (kind === 'RKF') return 'rkf';
  throw new Error(
    `Component '${technicalName.toUpperCase()}' is of type '${kind || 'unknown'}' — a structure member can ` +
      'only reference a reusable CKF or RKF.'
  );
}

/**
 * Fetch a component's definition re-tagged as a `Qry:subComponents` block.
 *
 * A structure member that references a CKF/RKF is only accepted when the referenced
 * component is embedded in the same document; without it the save fails with
 * "required model details are missing" and no hint as to which. (A CKF formula needs
 * no such block — there the backend materialises it from the operand's id itself.)
 * The component's own entityProperties are dropped: they describe it as a standalone
 * object, and the backend does not carry them on embedded copies either.
 */
async function fetchSubComponentBlock(client: BwClient, technicalName: string): Promise<{ uid: string; xml: string }> {
  const kind = await resolveComponentKind(client, technicalName);
  const { body } = await client.get(
    `/sap/bw/modeling/${kind}/${bwSeg(technicalName.toLowerCase())}/a`,
    kind === 'ckf' ? ckfAccept() : rkfAccept()
  );
  const main = body.match(/<Qry:mainComponent[\s\S]*<\/Qry:mainComponent>/)?.[0];
  if (!main) throw new Error(`Could not read the definition of component '${technicalName.toUpperCase()}'.`);
  const uid = main.match(/\bid="([^"]+)"/)?.[1];
  if (!uid) throw new Error(`Component '${technicalName.toUpperCase()}' has no id.`);
  const xml = main
    .replace(/^<Qry:mainComponent/, '<Qry:subComponents')
    .replace(/<\/Qry:mainComponent>$/, '</Qry:subComponents>')
    .replace(/<Qry:entityProperties[\s\S]*?<\/Qry:entityProperties>/, '');
  return { uid, xml };
}

/** Insert a sub-component block ahead of the main component, unless it is already there. */
function ensureSubComponent(doc: string, uid: string, xml: string): string {
  if (new RegExp(`<Qry:subComponents\b[^>]*\bid="${uid}"`).test(doc)) return doc;
  return doc.replace('<Qry:mainComponent', `${xml}<Qry:mainComponent`);
}

// ── Formula rendering for reusable components ────────────────────────────────

/**
 * Resolve every `component` operand in a formula tree from technical name to ELEMUID,
 * so the tree can afterwards be rendered synchronously — inside the document mutation,
 * where no further round trips to the backend are possible.
 */
async function resolveFormulaTree(
  client: BwClient,
  node: FormulaNode,
  uidCache: Map<string, string>
): Promise<FormulaNode> {
  if (!node || typeof node !== 'object') throw new Error('Invalid formula node.');
  const type = node['type'];

  if (type === 'operator') {
    const operands = Array.isArray(node['operands']) ? (node['operands'] as FormulaNode[]) : [];
    const resolved: FormulaNode[] = [];
    for (const o of operands) resolved.push(await resolveFormulaTree(client, o, uidCache));
    return { ...node, operands: resolved };
  }

  if (type === 'component' && !node['component_id']) {
    const name = node['component_name'];
    if (!name) throw new Error('Formula component operand requires component_name.');
    const key = String(name).toUpperCase();
    const uid = uidCache.get(key) ?? (await resolveComponentUid(client, key));
    uidCache.set(key, uid);
    return { type: 'component', component_id: uid, component_name: key };
  }

  return node;
}

/**
 * Render a resolved formula node tree. Same node syntax as
 * `bw_update_query_key_figures` `add_formula`, but a `component` operand becomes a
 * direct reference to the component's ELEMUID with operandType="Formula" — reusable
 * components reference each other directly, with no structure member in between.
 */
export function renderFormulaTree(node: FormulaNode, tag: string): string {
  if (!node || typeof node !== 'object') throw new Error('Invalid formula node.');
  const type = node['type'];

  if (type === 'operator') {
    const rawCode = String(node['code'] ?? '');
    if (!rawCode) throw new Error('Formula operator node requires a code.');
    const code = rawCode.toUpperCase();
    const operands = Array.isArray(node['operands']) ? (node['operands'] as FormulaNode[]) : [];
    const arity = FORMULA_OPERATOR_ARITY[code];
    if (arity) {
      const [min, max] = arity;
      if (operands.length < min || operands.length > max) {
        const expected = min === max ? `${min}` : `${min}-${max}`;
        throw new Error(`Formula operator '${code}' expects ${expected} operand(s) but got ${operands.length}.`);
      }
    } else if (operands.length === 0) {
      throw new Error(`Formula operator '${code}' requires at least one operand.`);
    }
    const xsiType = ['+', '-', '*', '/'].includes(code)
      ? 'Qry:FormulaInfixOperator'
      : 'Qry:FormulaPrefixOperator';
    const children = operands.map((o) => renderFormulaTree(o, 'Qry:childToken')).join('');
    return `<${tag} xsi:type="${xsiType}" code="${escapeXml(code)}">${children}</${tag}>`;
  }

  if (type === 'component') {
    const uid = node['component_id'];
    if (!uid) throw new Error('Formula component operand was not resolved to an ELEMUID.');
    return `<${tag} xsi:type="Qry:FormulaMemberOperand" member="${escapeXml(String(uid))}" operandType="Formula"/>`;
  }

  if (type === 'key_figure') {
    const name = node['name'];
    if (!name) throw new Error('Formula key_figure operand requires name.');
    return `<${tag} xsi:type="Qry:FormulaIObjectOperand" infoObject="${escapeXml(String(name).toUpperCase())}"/>`;
  }

  if (type === 'constant') {
    if (node['value'] === undefined || node['value'] === null) {
      throw new Error('Formula constant operand requires value.');
    }
    return `<${tag} xsi:type="Qry:FormulaConstant" value="${escapeXml(String(node['value']))}"/>`;
  }

  throw new Error(
    `Unknown formula node type '${String(type)}' (expected operator, component, key_figure, or constant).`
  );
}

/** Resolve and render in one step, for callers that only need the XML. */
async function renderComponentFormula(
  client: BwClient,
  node: FormulaNode,
  tag: string,
  uidCache: Map<string, string>
): Promise<string> {
  return renderFormulaTree(await resolveFormulaTree(client, node, uidCache), tag);
}

// ── bw_create_ckf ────────────────────────────────────────────────────────────

export interface CreateCkfArgs {
  provider_name: string;
  technical_name: string;
  description: string;
  formula: FormulaNode;
  decimals?: number;
  info_area?: string;
  package?: string;
  transport_request?: string;
}

/**
 * Create a reusable Calculated Key Figure. Mirrors bw_create_rkf: a two-phase create
 * (POST an empty-formula skeleton under a CREA lock, then PUT the real formula under
 * an edit lock), because the create resource does not accept a formula on the POST.
 */
export async function bwCreateCkf(client: BwClient, args: CreateCkfArgs): Promise<string> {
  if (!args.provider_name) throw new Error('provider_name is required.');
  if (!args.technical_name) throw new Error('technical_name is required.');
  if (!args.description) throw new Error('description is required.');
  if (!args.formula) throw new Error('formula is required.');
  if (args.decimals !== undefined && (args.decimals < 0 || args.decimals > 9)) {
    throw new Error('decimals must be between 0 and 9.');
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

  const basePath = `/sap/bw/modeling/ckf/${bwSeg(nameLower)}/a`;
  const enqPath = `/sap/bw/modeling/comp/enq/${bwSeg(nameLower)}`;

  // Render the formula up front: a failure here must happen before anything is locked.
  const uidCache = new Map<string, string>();
  const formulaXml = await renderComponentFormula(client, args.formula, 'Qry:formulaToken', uidCache);

  // Step 1: compexist — name check + server-generated ELEMUID.
  const existResult = await client.rawGet(
    `/sap/bw/modeling/queryint?action=compexist&compid=${encodeURIComponent(nameLower)}&type=ELEM`,
    { 'bwmt-level': '50' }
  );
  if (header(existResult.headers, 'compexist') === 'true') {
    throw new Error(`A component named '${nameUpper}' already exists.`);
  }
  const elemUid = header(existResult.headers, 'elemuid');
  if (!elemUid) {
    throw new Error(`compexist did not return an ELEMUID header for '${nameUpper}'.`);
  }
  const objUri = header(existResult.headers, 'objuri') ?? basePath.replace(/\/a$/, '/A');

  // Step 2: lock (CREA). The generic comp/enq endpoint negotiates on the query media
  // type for every ELEM component — the ckf type is only valid on /ckf/<name>/a.
  const lockA = await client.rawPost(`${enqPath}?action=lock&compuid=${elemUid}`, '', {
    activity_context: 'CREA',
    Accept: `${queryWriteMediaType()}, ${QUERY_ACCEPT_LIST}`,
    'bwmt-level': '50',
    'x-csrf-token': await client.getCsrfToken(),
    ...lockSessionHeader(),
  });
  const lockHandleA = lockA.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1];
  if (!lockHandleA) throw new Error(`No <LOCK_HANDLE> in CREA lock response:\n${lockA.body}`);

  const corrNrPrefix = transport ? `corrNr=${transport}&` : '';

  try {
    // Step 3: transportchecks.
    const transportBody = `<?xml version="1.0" encoding="UTF-8" ?>
<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>
  <PGMID></PGMID>
  <OBJECT>CKF</OBJECT>
  <OBJECTNAME>${elemUid}</OBJECTNAME>
  <DEVCLASS>${escapeXml(pkg)}</DEVCLASS>
  <SUPER_PACKAGE></SUPER_PACKAGE>
  <RECORD_CHANGES></RECORD_CHANGES>
  <OPERATION>I</OPERATION>
  <URI>${escapeXml(basePath)}?compuid=${elemUid}&amp;lockHandle=${lockHandleA}</URI>
</DATA></asx:values></asx:abap>`;
    const transportResult = await client.rawPost('/sap/bc/adt/cts/transportchecks', transportBody, {
      'Content-Type':
        'application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.transport.service.checkData',
      'x-csrf-token': await client.getCsrfToken(),
      ...lockSessionHeader(),
    });
    if (transportResult.body.match(/<RESULT>([^<]*)<\/RESULT>/)?.[1] === 'E') {
      throw new Error(`transportchecks failed for package '${pkg}':\n${transportResult.body}`);
    }

    // Step 4: POST the skeleton on a fresh session (the create session's model buffer
    // would otherwise serve a stale document to the PUT).
    const skeletonBody = `<?xml version="1.0" encoding="UTF-8"?>
<Qry:queryResource xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:Qry="http://www.sap.com/bw/Query.ecore" xmlns:adtcore="http://www.sap.com/adt/core">
  <Qry:schemaVersion>1.0</Qry:schemaVersion>
  <Qry:mainComponent xsi:type="Qry:CalculatedMeasure" id="${elemUid}" componentVersion="11" providerName="${provider}" reusable="true" technicalName="${nameUpper}">
    <Qry:description default="false" value="${descEsc}"/>
    <Qry:entityProperties adtcore:changedAt="${timestampIso}" adtcore:changedBy="${responsible}" adtcore:createdAt="${timestampIso}" adtcore:createdBy="${responsible}" adtcore:description="${descEsc}" adtcore:language="${language}" adtcore:name="${nameUpper}" adtcore:type="CKF" adtcore:masterLanguage="${language}" adtcore:masterSystem="${masterSystem}" adtcore:responsible="${responsible}"/>
    <Qry:member xsi:type="Qry:MemberFormula" id="${elemUid}">
      <Qry:defaultHint/><Qry:hidden/><Qry:emphasize/><Qry:signInversion/>
      <Qry:scaling/><Qry:decimals/><Qry:calculation/>
      <Qry:formulaDefinition/>
      <Qry:exceptionAggregation/>
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
        // Accept as a version range: the dedicated resource negotiates on a lower
        // version than discovery advertises, and a single value yields HTTP 415.
        'Content-Type': `application/xml, ${ckfAccept().split(',')[0].trim()}`,
        Accept: ckfAccept(),
        'bwmt-level': '50',
        'x-csrf-token': await clientCreate.getCsrfToken(),
      }
    );
    parseCheckResult(createResult.body, 'CKF skeleton creation');
  } finally {
    try {
      await client.rawPost(`${enqPath}?action=unlock&compuid=${elemUid}`, '', {
        'bwmt-level': '50',
        'x-csrf-token': await client.getCsrfToken(),
      });
    } catch (unlockErr) {
      process.stderr.write(`Warning: failed to release CREA lock for ckf/${nameLower}: ${unlockErr}\n`);
    }
  }

  // Phase B: PUT the real formula onto the freshly created skeleton.
  const clientB = createClientFromEnv();
  const decimalsEl =
    args.decimals === undefined
      ? '<Qry:decimals default="true"/>'
      : `<Qry:decimals default="false" number="${args.decimals}"/>`;
  const infoAreaEl = infoArea ? `\n      <infoArea>${escapeXml(infoArea)}</infoArea>` : '';

  const { messages } = await withElementDocument(
    clientB,
    'ckf',
    nameLower,
    (doc) => {
      // Replace the skeleton member wholesale: it carries no formula yet, and every
      // attribute the server filled in (id, drillStateExec, flatPosition) is preserved
      // by keeping its opening tag.
      const openMatch = doc.match(/<Qry:member\b[^>]*>/);
      if (!openMatch) throw new Error('Created CKF has no <Qry:member> element to fill.');
      const memberStart = doc.indexOf(openMatch[0]);
      const memberEnd = doc.indexOf('</Qry:member>', memberStart);
      if (memberEnd === -1) throw new Error('Created CKF has no </Qry:member> closing tag.');
      const newMember = `${openMatch[0]}
      <Qry:defaultHint/>
      <Qry:description default="false" value="${descEsc}"/>
      <Qry:calculation default="true"/>
      <Qry:emphasize default="true"/>
      <Qry:signInversion default="true"/>
      <Qry:hidden default="true"/>
      <Qry:scaling default="true"/>
      ${decimalsEl}
      <Qry:mapName>${nameUpper}</Qry:mapName>
      <Qry:formulaDefinition>${formulaXml}</Qry:formulaDefinition>
      <Qry:exceptionAggregation/>
    `;
      let next = doc.slice(0, memberStart) + newMember + doc.slice(memberEnd);
      if (infoAreaEl && !next.includes('<infoArea>')) {
        next = next.replace('</adtCore:packageRef>', `</adtCore:packageRef>${infoAreaEl}`);
        if (!next.includes('<infoArea>')) {
          next = next.replace(/(<adtCore:packageRef\b[^>]*\/>)/, `$1${infoAreaEl}`);
        }
      }
      return next;
    },
    transport
  );

  const recorded = transport ? await recordedIn(client, elemUid) : undefined;

  return JSON.stringify(
    {
      success: true,
      object_type: 'ckf',
      technical_name: nameUpper,
      provider_name: provider,
      obj_uri: objUri,
      package: pkg,
      ...(infoArea ? { info_area: infoArea } : {}),
      ...(transport ? { transport_request: transport } : {}),
      ...(recorded ? { recorded_in: recorded } : {}),
      consistency_messages: messages,
      message: `Calculated key figure '${nameUpper}' created on InfoProvider '${provider}'.`,
      debug: { elem_uid: elemUid },
    },
    null,
    2
  );
}

// ── bw_update_ckf ────────────────────────────────────────────────────────────

export interface CkfOperandOperation {
  action: 'append_operand' | 'remove_operand';
  /** Operand to add (append_operand). Same node syntax as `formula`. */
  operand?: FormulaNode;
  /**
   * Operator that joins the new operand to the existing formula (append_operand).
   * Defaults to "+", the "add another summand" case.
   */
  operator?: string;
  /** Put the new operand on the left of the operator instead of the right. */
  before?: boolean;
  /** Component whose operand is to be removed (remove_operand). */
  component_name?: string;
}

export interface UpdateCkfArgs {
  component_name: string;
  description?: string;
  /** Replace the whole formula. */
  formula?: FormulaNode;
  /** Targeted edits on the existing top-level operator. Mutually exclusive with `formula`. */
  operations?: CkfOperandOperation[];
  decimals?: number;
  transport_request?: string;
}

/**
 * Parse a formula XML fragment back into the node syntax, keeping component operands
 * as raw ELEMUIDs (`component_id`) so a read-modify-write round trip cannot lose a
 * reference to a component whose technical name is ambiguous or unresolvable.
 */
export function parseFormulaXml(fragment: string): FormulaNode | undefined {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (tag: string) => tag === 'Qry:childToken',
  });
  const parsed = parser.parse(`<root>${fragment}</root>`) as Record<string, unknown>;
  const root = (parsed['root'] as Record<string, unknown> | undefined)?.['Qry:formulaToken'] as
    | Record<string, unknown>
    | undefined;
  if (!root) return undefined;

  function toNode(token: Record<string, unknown>, depth: number): FormulaNode {
    if (depth > 50) throw new Error('Formula nesting exceeds 50 levels.');
    const type = token['@_xsi:type'] as string | undefined;
    if (type === 'Qry:FormulaInfixOperator' || type === 'Qry:FormulaPrefixOperator') {
      const children = (token['Qry:childToken'] ?? []) as Record<string, unknown>[];
      return {
        type: 'operator',
        code: (token['@_code'] as string) ?? '',
        operands: children.map((c) => toNode(c, depth + 1)),
      };
    }
    if (type === 'Qry:FormulaIObjectOperand') {
      return { type: 'key_figure', name: (token['@_infoObject'] as string) ?? '' };
    }
    if (type === 'Qry:FormulaMemberOperand') {
      return { type: 'component', component_id: (token['@_member'] as string) ?? '' };
    }
    if (type === 'Qry:FormulaConstant') {
      return { type: 'constant', value: token['@_value'] ?? '' };
    }
    throw new Error(`Cannot round-trip formula token of type '${String(type)}'.`);
  }

  return toNode(root, 0);
}

/**
 * Remove the operand referencing `componentId` from the tree.
 *
 * In BW a sum of many summands is a left-nested chain of binary '+' operators, so a
 * summand is removed by replacing the operator node that holds it with its sibling —
 * not by deleting an entry from an operand list. Returns undefined when nothing matched.
 */
export function removeOperandByComponent(node: FormulaNode, componentId: string): FormulaNode | undefined {
  if (node['type'] !== 'operator') return undefined;
  const operands = (node['operands'] as FormulaNode[]) ?? [];
  const idx = operands.findIndex((o) => o['type'] === 'component' && o['component_id'] === componentId);
  if (idx !== -1) {
    if (operands.length !== 2) {
      throw new Error(
        `Cannot remove the operand: it sits under operator '${String(node['code'])}', which has ` +
          `${operands.length} operand(s). Removing it would leave the operator incomplete — ` +
          'pass `formula` to rewrite the expression instead.'
      );
    }
    return operands[1 - idx];
  }
  for (let i = 0; i < operands.length; i++) {
    const replaced = removeOperandByComponent(operands[i], componentId);
    if (replaced !== undefined) {
      const next = [...operands];
      next[i] = replaced;
      return { ...node, operands: next };
    }
  }
  return undefined;
}

/** Count how often a component id is referenced anywhere in the tree. */
export function countComponentRefs(node: FormulaNode, componentId: string): number {
  if (node['type'] === 'component') return node['component_id'] === componentId ? 1 : 0;
  if (node['type'] !== 'operator') return 0;
  return ((node['operands'] as FormulaNode[]) ?? []).reduce(
    (sum, o) => sum + countComponentRefs(o, componentId),
    0
  );
}

/** Locate the formulaDefinition body of the main component's member. */
export function locateFormulaDefinition(doc: string): { start: number; end: number; body: string } {
  const mainStart = doc.indexOf('<Qry:mainComponent');
  if (mainStart === -1) throw new Error('Document has no <Qry:mainComponent>.');
  const openTag = /<Qry:formulaDefinition\s*\/>|<Qry:formulaDefinition\s*>/g;
  openTag.lastIndex = mainStart;
  const m = openTag.exec(doc);
  if (!m) throw new Error('Document has no <Qry:formulaDefinition> in the main component.');
  if (m[0].endsWith('/>')) {
    return { start: m.index, end: m.index + m[0].length, body: '' };
  }
  const bodyStart = m.index + m[0].length;
  const closeIdx = doc.indexOf('</Qry:formulaDefinition>', bodyStart);
  if (closeIdx === -1) throw new Error('Unterminated <Qry:formulaDefinition>.');
  return {
    start: m.index,
    end: closeIdx + '</Qry:formulaDefinition>'.length,
    body: doc.slice(bodyStart, closeIdx),
  };
}

/**
 * Update a reusable CKF: replace the formula outright, or edit the operands of its
 * top-level operator in place. The second form is the practically important one —
 * adding a summand to a sum without the caller having to know or rebuild the rest of
 * the formula, and without parsing the rendered string.
 *
 * Every operation is applied to one in-memory document and written in a single PUT,
 * so a rejected operation leaves the stored formula untouched rather than half edited.
 */
export async function bwUpdateCkf(client: BwClient, args: UpdateCkfArgs): Promise<string> {
  if (!args.component_name) throw new Error('component_name is required.');
  if (args.formula && args.operations && args.operations.length > 0) {
    throw new Error('Pass either `formula` (replace) or `operations` (targeted edits), not both.');
  }
  if (!args.formula && !args.operations?.length && args.description === undefined && args.decimals === undefined) {
    throw new Error('Nothing to do: pass formula, operations, description, and/or decimals.');
  }
  if (args.decimals !== undefined && (args.decimals < 0 || args.decimals > 9)) {
    throw new Error('decimals must be between 0 and 9.');
  }

  const nameUpper = args.component_name.toUpperCase();
  const uidCache = new Map<string, string>();

  // Resolve every component reference before touching the document: a name that does
  // not exist must fail before anything is locked, and the mutation itself has to run
  // synchronously.
  const replacement = args.formula
    ? renderFormulaTree(await resolveFormulaTree(client, args.formula, uidCache), 'Qry:formulaToken')
    : undefined;
  const resolvedOperands: Array<FormulaNode | undefined> = [];
  const removeTargets: Array<string | undefined> = [];
  for (const op of args.operations ?? []) {
    if (op.action === 'append_operand') {
      if (!op.operand) throw new Error('append_operand requires an operand.');
      resolvedOperands.push(await resolveFormulaTree(client, op.operand, uidCache));
      removeTargets.push(undefined);
    } else if (op.action === 'remove_operand') {
      if (!op.component_name) throw new Error('remove_operand requires component_name.');
      resolvedOperands.push(undefined);
      removeTargets.push(await resolveComponentUid(client, op.component_name));
    } else {
      throw new Error(`Unknown action '${String((op as CkfOperandOperation).action)}'.`);
    }
  }

  const applied: string[] = [];
  const { messages, document } = await withElementDocument(
    client,
    'ckf',
    nameUpper,
    (doc) => {
      let next = doc;

      if (args.description !== undefined) {
        const descEsc = escapeXml(args.description);
        // Only the description elements of the main component, not those of embedded
        // sub-components, which are other objects' texts.
        const mainStart = next.indexOf('<Qry:mainComponent');
        const head = next.slice(0, mainStart);
        const tail = next
          .slice(mainStart)
          .replace(/<Qry:description\b[^>]*?\/>/g, `<Qry:description default="false" value="${descEsc}"/>`)
          .replace(/(<Qry:entityProperties\b[^>]*?adtCore:description=")[^"]*"/, `$1${descEsc}"`);
        next = head + tail;
        applied.push(`description set to "${args.description}"`);
      }

      if (args.decimals !== undefined) {
        const mainStart = next.indexOf('<Qry:mainComponent');
        const head = next.slice(0, mainStart);
        const tail = next
          .slice(mainStart)
          .replace(/<Qry:decimals\b[^>]*?\/>/, `<Qry:decimals default="false" number="${args.decimals}"/>`);
        next = head + tail;
        applied.push(`decimals set to ${args.decimals}`);
      }

      if (replacement !== undefined) {
        const loc = locateFormulaDefinition(next);
        next =
          next.slice(0, loc.start) +
          `<Qry:formulaDefinition>${replacement}</Qry:formulaDefinition>` +
          next.slice(loc.end);
        applied.push('formula replaced');
        return next;
      }

      if (args.operations?.length) {
        const loc = locateFormulaDefinition(next);
        let tree = parseFormulaXml(loc.body);

        args.operations.forEach((op, idx) => {
          if (op.action === 'append_operand') {
            const operand = resolvedOperands[idx] as FormulaNode;
            const code = (op.operator ?? '+').toUpperCase();
            if (tree === undefined) {
              // An empty formula takes the new operand as the whole expression.
              tree = operand;
            } else {
              // A BW sum of N summands is a left-nested chain of binary operators, so
              // another summand joins by wrapping the existing formula rather than by
              // becoming a third operand of the outermost one.
              tree = {
                type: 'operator',
                code,
                operands: op.before ? [operand, tree] : [tree, operand],
              };
            }
            const label = (op.operand as FormulaNode)['component_name'] ?? (op.operand as FormulaNode)['name'];
            applied.push(`operand ${label ? `'${String(label)}' ` : ''}joined with '${code}'`);
          } else {
            if (tree === undefined) {
              throw new Error(`remove_operand: the formula of '${nameUpper}' is empty.`);
            }
            const uid = removeTargets[idx] as string;
            const refs = countComponentRefs(tree, uid);
            if (refs === 0) {
              throw new Error(
                `remove_operand: the formula of '${nameUpper}' does not reference component '${op.component_name}'.`
              );
            }
            if (refs > 1) {
              throw new Error(
                `remove_operand: component '${op.component_name}' is referenced ${refs} times in the formula — ` +
                  'which one to drop is ambiguous, so pass `formula` to rewrite the expression instead.'
              );
            }
            const reduced = removeOperandByComponent(tree, uid);
            if (reduced === undefined) {
              throw new Error(
                `remove_operand: component '${op.component_name}' is the entire formula — ` +
                  'removing it would leave the CKF without one.'
              );
            }
            tree = reduced;
            applied.push(`operand '${op.component_name!.toUpperCase()}' removed`);
          }
        });

        next =
          next.slice(0, loc.start) +
          `<Qry:formulaDefinition>${renderFormulaTree(tree as FormulaNode, 'Qry:formulaToken')}</Qry:formulaDefinition>` +
          next.slice(loc.end);
      }

      return next;
    },
    args.transport_request?.toUpperCase()
  );

  const elemUid = document.match(/<Qry:mainComponent\b[^>]*?\bid="([^"]+)"/)?.[1];
  const recorded = args.transport_request && elemUid ? await recordedIn(client, elemUid) : undefined;

  return JSON.stringify(
    {
      success: true,
      object_type: 'ckf',
      technical_name: nameUpper,
      applied_operations: applied,
      ...(args.transport_request ? { transport_request: args.transport_request.toUpperCase() } : {}),
      ...(recorded ? { recorded_in: recorded } : {}),
      consistency_messages: messages,
      message: `Calculated key figure '${nameUpper}' updated.`,
    },
    null,
    2
  );
}

// ── bw_update_rkf ────────────────────────────────────────────────────────────

export interface UpdateRkfArgs {
  component_name: string;
  description?: string;
  base_key_figure?: string;
  /** Replaces ALL characteristic restrictions when given. */
  restrictions?: RkfRestriction[];
  transport_request?: string;
}

/** Validate one restriction value and return its internal key plus display text. */
async function validateValue(
  client: BwClient,
  characteristic: string,
  provider: string,
  low: string,
  high: string | undefined
): Promise<{ lowIntKey: string; lowDesc: string; highIntKey?: string; highDesc?: string }> {
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
      `Validation failed for characteristic '${characteristic}' value '${low}': comp/validator returned ` +
        `no internal key. Check the value is valid on InfoProvider '${provider}'.`
    );
  }
  const out: { lowIntKey: string; lowDesc: string; highIntKey?: string; highDesc?: string } = {
    lowIntKey,
    lowDesc: header(result.headers, 'lowdesc') ?? '',
  };
  if (high !== undefined) {
    const highIntKey = header(result.headers, 'highintkey');
    if (!highIntKey) {
      throw new Error(
        `Validation failed for characteristic '${characteristic}' high value '${high}': no internal key.`
      );
    }
    out.highIntKey = highIntKey;
    out.highDesc = header(result.headers, 'highdesc') ?? '';
  }
  return out;
}

function buildRestrictionToken(
  operator: RkfOperator,
  exclude: boolean,
  v: { lowIntKey: string; lowDesc: string; highIntKey?: string; highDesc?: string }
): string {
  const excludeAttr = exclude ? ' exclude="true"' : '';
  const fromDescAttr = v.lowDesc ? ` fromValueDesc="${escapeXml(v.lowDesc)}"` : '';
  if (operator === 'Between') {
    const toDescAttr = v.highDesc ? ` toValueDesc="${escapeXml(v.highDesc)}"` : '';
    return `<Qry:tokens xsi:type="Qry:SelectionRange" usageType="asFilter"${excludeAttr}${fromDescAttr}${toDescAttr} operator="Between"><Qry:fromValue><Qry:type>Value</Qry:type><Qry:value>${escapeXml(v.lowIntKey)}</Qry:value></Qry:fromValue><Qry:toValue><Qry:type>Value</Qry:type><Qry:value>${escapeXml(v.highIntKey ?? '')}</Qry:value></Qry:toValue></Qry:tokens>`;
  }
  return `<Qry:tokens xsi:type="Qry:SelectionRange" usageType="asFilter"${excludeAttr}${fromDescAttr} operator="${operator}"><Qry:fromValue><Qry:type>Value</Qry:type><Qry:value>${escapeXml(v.lowIntKey)}</Qry:value></Qry:fromValue></Qry:tokens>`;
}

/** Split a member's groups into the 1KYFNM (base measure) group and the rest. */
function splitMemberGroups(memberXml: string): { keyFigureGroup?: string; others: string[]; firstGroupIdx: number } {
  const groups: string[] = [];
  const re = /<Qry:groups\b[^>]*?(\/>|>[\s\S]*?<\/Qry:groups>)/g;
  let m: RegExpExecArray | null;
  let firstGroupIdx = -1;
  while ((m = re.exec(memberXml)) !== null) {
    if (firstGroupIdx === -1) firstGroupIdx = m.index;
    groups.push(m[0]);
  }
  const keyFigureGroup = groups.find((g) => /infoObject="1KYFNM"/.test(g));
  return { keyFigureGroup, others: groups.filter((g) => g !== keyFigureGroup), firstGroupIdx };
}

/**
 * Update a reusable RKF in place: description, base key figure and/or restrictions.
 * Without this the only correction path was delete-and-recreate, which is impossible
 * once the RKF is referenced by a CKF, a structure or a query — and impossible at all
 * on tiers where deletion is deliberately blocked.
 *
 * `restrictions` replaces the full set of characteristic restrictions; the base key
 * figure group is preserved (or replaced via `base_key_figure`) either way. The UID
 * never changes, so existing references stay intact.
 */
export async function bwUpdateRkf(client: BwClient, args: UpdateRkfArgs): Promise<string> {
  if (!args.component_name) throw new Error('component_name is required.');
  if (args.description === undefined && !args.base_key_figure && !args.restrictions) {
    throw new Error('Nothing to do: pass description, base_key_figure, and/or restrictions.');
  }
  for (const r of args.restrictions ?? []) {
    if (!r.characteristic) throw new Error('Each restriction requires a characteristic.');
    if (!Array.isArray(r.values) || r.values.length === 0) {
      throw new Error(`Restriction on '${r.characteristic}' requires a non-empty values array.`);
    }
    for (const v of r.values as RkfRestrictionValue[]) {
      if (!v.low) throw new Error(`Restriction on '${r.characteristic}' has a value without 'low'.`);
      if ((r.operator ?? 'Equal') === 'Between' && !v.high) {
        throw new Error(`Between restriction on '${r.characteristic}' requires 'high' for every value.`);
      }
    }
  }

  const nameUpper = args.component_name.toUpperCase();
  const path = `/sap/bw/modeling/rkf/${bwSeg(nameUpper.toLowerCase())}/a`;

  // The provider is needed to validate restriction values, and validation must happen
  // before the document is locked.
  let groupsXml: string | undefined;
  if (args.restrictions) {
    const { body } = await client.get(path, rkfAccept());
    const provider = body.match(/<Qry:mainComponent\b[^>]*?\bproviderName="([^"]*)"/)?.[1];
    if (!provider) throw new Error(`Could not determine the InfoProvider of RKF '${nameUpper}'.`);
    const parts: string[] = [];
    for (const r of args.restrictions) {
      const characteristic = r.characteristic.toUpperCase();
      const operator = r.operator ?? 'Equal';
      const tokens: string[] = [];
      for (const v of r.values as RkfRestrictionValue[]) {
        const validated = await validateValue(
          client,
          characteristic,
          provider,
          v.low,
          operator === 'Between' ? v.high : undefined
        );
        tokens.push(buildRestrictionToken(operator, r.exclude === true, validated));
      }
      parts.push(`<Qry:groups infoObject="${characteristic}">${tokens.join('')}</Qry:groups>`);
    }
    groupsXml = parts.join('');
  }

  const applied: string[] = [];
  const { messages, document } = await withElementDocument(
    client,
    'rkf',
    nameUpper,
    (doc) => {
      const mainStart = doc.indexOf('<Qry:mainComponent');
      if (mainStart === -1) throw new Error('Document has no <Qry:mainComponent>.');
      const head = doc.slice(0, mainStart);
      let main = doc.slice(mainStart);

      if (args.description !== undefined) {
        const descEsc = escapeXml(args.description);
        main = main
          .replace(/<Qry:description\b[^>]*?\/>/g, `<Qry:description default="false" value="${descEsc}"/>`)
          .replace(/(<Qry:entityProperties\b[^>]*?adtCore:description=")[^"]*"/, `$1${descEsc}"`);
        applied.push(`description set to "${args.description}"`);
      }

      if (args.base_key_figure || groupsXml !== undefined) {
        const memberMatch = main.match(/<Qry:member\b[^>]*?>[\s\S]*?<\/Qry:member>/);
        if (!memberMatch) throw new Error('Document has no <Qry:member> in the main component.');
        const memberXml = memberMatch[0];
        const { keyFigureGroup, others, firstGroupIdx } = splitMemberGroups(memberXml);

        let kyfGroup = keyFigureGroup;
        if (args.base_key_figure) {
          const kyf = args.base_key_figure.toUpperCase();
          kyfGroup = `<Qry:groups description="Key Figures" infoObject="1KYFNM"><Qry:tokens xsi:type="Qry:SelectionRange" usageType="asFilter" selectionType="keyFigure" fromValueDesc="${escapeXml(kyf)}" operator="Equal"><Qry:fromValue><Qry:type>Value</Qry:type><Qry:value>${escapeXml(kyf)}</Qry:value></Qry:fromValue></Qry:tokens></Qry:groups>`;
          applied.push(`base key figure set to ${kyf}`);
        }
        const keptOthers = groupsXml !== undefined ? '' : others.join('');
        if (groupsXml !== undefined) {
          applied.push(`${args.restrictions!.length} restriction(s) replaced the previous set`);
        }

        // Strip all existing groups and re-emit them where the first one stood, so the
        // surrounding member properties keep their order.
        let stripped = memberXml.replace(/<Qry:groups\b[^>]*?(\/>|>[\s\S]*?<\/Qry:groups>)/g, '');
        const newGroups = `${kyfGroup ?? ''}${keptOthers}${groupsXml ?? ''}`;
        if (firstGroupIdx === -1) {
          stripped = stripped.replace(/<\/Qry:member>$/, `${newGroups}</Qry:member>`);
        } else {
          stripped = stripped.replace(/<\/Qry:member>$/, `${newGroups}</Qry:member>`);
        }
        main = main.replace(memberXml, stripped);
      }

      return head + main;
    },
    args.transport_request?.toUpperCase()
  );

  const elemUid = document.match(/<Qry:mainComponent\b[^>]*?\bid="([^"]+)"/)?.[1];
  const recorded = args.transport_request && elemUid ? await recordedIn(client, elemUid) : undefined;

  return JSON.stringify(
    {
      success: true,
      object_type: 'rkf',
      technical_name: nameUpper,
      applied_operations: applied,
      ...(args.transport_request ? { transport_request: args.transport_request.toUpperCase() } : {}),
      ...(recorded ? { recorded_in: recorded } : {}),
      consistency_messages: messages,
      message: `Restricted key figure '${nameUpper}' updated.`,
    },
    null,
    2
  );
}

// ── Reusable structures ──────────────────────────────────────────────────────

export interface StructureMemberSpec {
  /** Reusable CKF/RKF the member shows. */
  component_name?: string;
  /** Basic key figure InfoObject the member shows. Alternative to component_name. */
  key_figure?: string;
  /** Member text; defaults to the referenced component / key figure name. */
  description?: string;
  /** Additional characteristic restrictions, applied as further selection groups. */
  restrictions?: KeyFigureRestriction[];
  /** Display and planning properties. */
  properties?: MemberProperties;
}

/**
 * Build one structure member, in the shape the BW Modeling Tools send (verified
 * against a communication log of a structure create and a member insert).
 *
 * Two things are not optional. The display child elements must all be present — a
 * member missing any of them is rejected on save with "required model details are
 * missing" and no indication of which — and they carry no values: the member is
 * written with empty elements and the backend fills in its defaults. The planning
 * block belongs to that set even for a structure that is never planned on.
 *
 * Deliberately absent are `drillStateExec`, `flatPosition` and `constSelection`: the
 * modeling tools leave them off a new member and let the backend assign them, and a
 * member read back later carries them. Setting them here would pin values the backend
 * is entitled to choose.
 *
 * A component reference and a basic key figure differ only in the default hint and
 * the selection token.
 */
export function buildStructureMember(
  vid: string,
  spec: StructureMemberSpec,
  componentId: string | undefined,
  doc: string,
  /**
   * Element name. A top-level member is `Qry:members`; one nested under another is
   * `Qry:childMembers`. Writing a nested member under the top-level name does not
   * fail — the backend drops it and still reports the save as consistent.
   */
  tag: 'members' | 'childMembers' = 'members'
): string {
  const label = spec.description ?? spec.component_name?.toUpperCase() ?? spec.key_figure?.toUpperCase() ?? '';
  const descEsc = escapeXml(label);
  const restrictionGroups = buildRestrictionGroups(spec.restrictions);

  // `default="false"` is what marks the text as the member's own. Without it the
  // backend treats whatever is sent as a default and overwrites it with the text of
  // the referenced component or key figure — the member is saved, just under a
  // different name than the caller asked for. The modeling tools omit the attribute
  // precisely because they send the inherited text there.
  const description = spec.description
    ? `<Qry:description default="false" value="${descEsc}"/>`
    : `<Qry:description value="${descEsc}"/>`;

  const kyf = spec.key_figure?.toUpperCase();
  const hint = componentId
    ? `<Qry:defaultHint><Qry:type>CINLink</Qry:type><Qry:value>${componentId}</Qry:value></Qry:defaultHint>`
    : `<Qry:defaultHint><Qry:type>InfoObject</Qry:type><Qry:value>${escapeXml(kyf!)}</Qry:value></Qry:defaultHint>`;
  const group = componentId
    ? `<Qry:groups infoObject="1KYFNM"><Qry:tokens xsi:type="Qry:SelectionTokenForComponent" component="${componentId}"/></Qry:groups>`
    : `<Qry:groups infoObject="1KYFNM"><Qry:tokens xsi:type="Qry:SelectionRange" usageType="asFilter" selectionType="keyFigure" fromValueDesc="${descEsc}" operator="Equal"><Qry:fromValue><Qry:type>Value</Qry:type><Qry:value>${escapeXml(kyf!)}</Qry:value></Qry:fromValue></Qry:tokens></Qry:groups>`;

  const member = `<Qry:${tag} xsi:type="Qry:MemberSelection" id="${vid}">
  ${description}
  ${hint}
  <Qry:hidden/>
  <Qry:emphasize/>
  <Qry:signInversion/>
  <Qry:scaling/>
  <Qry:decimals/>
  <Qry:calculation/>
  <Qry:planning>
    <Qry:inputMode/>
    <Qry:disaggregation/>
  </Qry:planning>
  <Qry:currencyConversion/>
  <Qry:unitConversion/>
  ${group}
${restrictionGroups}</Qry:${tag}>`;

  return spec.properties ? applyMemberProperties(member, spec.properties, doc) : member;
}

/**
 * Validate one member spec and, for a component reference, fetch both its id and the
 * sub-component block the structure has to carry for it.
 */
async function resolveMemberSpec(
  client: BwClient,
  spec: StructureMemberSpec,
  cache: Map<string, { uid: string; xml: string }>
): Promise<{ uid: string; xml: string } | undefined> {
  if (!spec.component_name && !spec.key_figure) {
    throw new Error('A structure member requires either component_name or key_figure.');
  }
  if (spec.component_name && spec.key_figure) {
    throw new Error('A structure member takes either component_name or key_figure, not both.');
  }
  if (!spec.component_name) return undefined;
  const key = spec.component_name.toUpperCase();
  const cached = cache.get(key);
  if (cached) return cached;
  const resolved = await fetchSubComponentBlock(client, key);
  cache.set(key, resolved);
  return resolved;
}

/** The members region of a structure document: everything inside the main component. */
function structureMembersRegion(doc: string): { start: number; end: number; xml: string } {
  const mainStart = doc.indexOf('<Qry:mainComponent');
  if (mainStart === -1) throw new Error('Document has no <Qry:mainComponent>.');
  const openEnd = doc.indexOf('>', mainStart) + 1;
  const closeIdx = doc.indexOf('</Qry:mainComponent>', openEnd);
  if (closeIdx === -1) throw new Error('Unterminated <Qry:mainComponent>.');
  return { start: openEnd, end: closeIdx, xml: doc.slice(openEnd, closeIdx) };
}

/**
 * Insert a member into the structure, optionally nested under a parent and at a given
 * position among its siblings. Appending to the end is the default.
 */
function insertStructureMember(
  doc: string,
  memberXml: string,
  parent: string | undefined,
  position: number | undefined
): string {
  const region = structureMembersRegion(doc);
  // walkMembers reports offsets inside the region; everything below is absolute.
  const all = walkMembers(region.xml).map((m) => ({
    ...m,
    start: region.start + m.start,
    end: region.start + m.end,
  }));

  if (parent) {
    const target = resolveStructureMember(doc, parent, 'add_member parent');
    if (target.full.endsWith('/>')) {
      throw new Error(
        `add_member: member '${parent}' is empty and cannot take a child member as it stands.`
      );
    }
    const children = all.filter((m) => m.parentId === target.id);
    const insertAt =
      position === undefined || position >= children.length
        ? target.end - `</Qry:${target.tag}>`.length
        : children[position].start;
    return doc.slice(0, insertAt) + memberXml + doc.slice(insertAt);
  }

  const top = all.filter((m) => m.parentId === undefined);
  const insertAt = position === undefined || position >= top.length ? region.end : top[position].start;
  return doc.slice(0, insertAt) + memberXml + doc.slice(insertAt);
}

/**
 * Count the members a saved structure actually holds, read from a fresh session.
 *
 * The backend drops a member it will not accept and still reports the save as
 * consistent, so "success" alone proves nothing about what was stored — exactly the
 * outcome this issue set out to remove. Counting the result turns a silent loss into
 * an error the caller can act on.
 */
async function countStoredMembers(componentName: string): Promise<number> {
  const { body } = await createClientFromEnv().get(
    `/sap/bw/modeling/structure/${bwSeg(componentName.toLowerCase())}/a?forceCacheUpdate=true`,
    structureAccept()
  );
  return walkMembers(structureMembersRegion(body).xml).length;
}

/** Resolve one member of a structure by id or description. */
function resolveStructureMember(
  doc: string,
  ref: string,
  context: string
): { id: string; start: number; end: number; full: string; tag: string } {
  const region = structureMembersRegion(doc);
  const all = walkMembers(region.xml);
  const matches = all.filter((m) => m.id === ref || m.description === ref);
  if (matches.length === 0) {
    const known = all.map((m) => `${m.id} (${m.description})`).join('; ');
    throw new Error(`${context}: no member matches '${ref}'. Members present: ${known || '(none)'}.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `${context}: '${ref}' matches ${matches.length} members — pass the member id to pick one.`
    );
  }
  const m = matches[0];
  return { id: m.id, start: region.start + m.start, end: region.start + m.end, full: m.full, tag: m.tag };
}

// ── bw_create_structure ──────────────────────────────────────────────────────

export interface CreateStructureArgs {
  provider_name: string;
  technical_name: string;
  description: string;
  members?: StructureMemberSpec[];
  info_area?: string;
  package?: string;
  transport_request?: string;
}

/**
 * Create a reusable key figure structure. Same two-phase create as the CKF: the POST
 * only establishes the (empty) component, the members go in with the following PUT.
 */
export async function bwCreateStructure(client: BwClient, args: CreateStructureArgs): Promise<string> {
  if (!args.provider_name) throw new Error('provider_name is required.');
  if (!args.technical_name) throw new Error('technical_name is required.');
  if (!args.description) throw new Error('description is required.');

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

  const basePath = `/sap/bw/modeling/structure/${bwSeg(nameLower)}/a`;
  const enqPath = `/sap/bw/modeling/comp/enq/${bwSeg(nameLower)}`;

  // Resolve all component references up front — before anything is locked.
  const componentCache = new Map<string, { uid: string; xml: string }>();
  const componentRefs: Array<{ uid: string; xml: string } | undefined> = [];
  for (const spec of args.members ?? []) {
    componentRefs.push(await resolveMemberSpec(client, spec, componentCache));
  }

  const existResult = await client.rawGet(
    `/sap/bw/modeling/queryint?action=compexist&compid=${encodeURIComponent(nameLower)}&type=ELEM`,
    { 'bwmt-level': '50' }
  );
  if (header(existResult.headers, 'compexist') === 'true') {
    throw new Error(`A component named '${nameUpper}' already exists.`);
  }
  const elemUid = header(existResult.headers, 'elemuid');
  if (!elemUid) throw new Error(`compexist did not return an ELEMUID header for '${nameUpper}'.`);
  const objUri = header(existResult.headers, 'objuri') ?? basePath.replace(/\/a$/, '/A');

  const lockA = await client.rawPost(`${enqPath}?action=lock&compuid=${elemUid}`, '', {
    activity_context: 'CREA',
    Accept: `${queryWriteMediaType()}, ${QUERY_ACCEPT_LIST}`,
    'bwmt-level': '50',
    'x-csrf-token': await client.getCsrfToken(),
    ...lockSessionHeader(),
  });
  const lockHandleA = lockA.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1];
  if (!lockHandleA) throw new Error(`No <LOCK_HANDLE> in CREA lock response:\n${lockA.body}`);

  const corrNrPrefix = transport ? `corrNr=${transport}&` : '';

  try {
    const transportBody = `<?xml version="1.0" encoding="UTF-8" ?>
<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>
  <PGMID></PGMID>
  <OBJECT>STR</OBJECT>
  <OBJECTNAME>${elemUid}</OBJECTNAME>
  <DEVCLASS>${escapeXml(pkg)}</DEVCLASS>
  <SUPER_PACKAGE></SUPER_PACKAGE>
  <RECORD_CHANGES></RECORD_CHANGES>
  <OPERATION>I</OPERATION>
  <URI>${escapeXml(basePath)}?compuid=${elemUid}&amp;lockHandle=${lockHandleA}</URI>
</DATA></asx:values></asx:abap>`;
    const transportResult = await client.rawPost('/sap/bc/adt/cts/transportchecks', transportBody, {
      'Content-Type':
        'application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.transport.service.checkData',
      'x-csrf-token': await client.getCsrfToken(),
      ...lockSessionHeader(),
    });
    if (transportResult.body.match(/<RESULT>([^<]*)<\/RESULT>/)?.[1] === 'E') {
      throw new Error(`transportchecks failed for package '${pkg}':\n${transportResult.body}`);
    }

    const skeletonBody = `<?xml version="1.0" encoding="UTF-8"?>
<Qry:queryResource xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:Qry="http://www.sap.com/bw/Query.ecore" xmlns:adtcore="http://www.sap.com/adt/core">
  <Qry:schemaVersion>1.0</Qry:schemaVersion>
  <Qry:mainComponent xsi:type="Qry:CustomDimension" id="${elemUid}" componentVersion="11" infoObjectName="1KYFNM" providerName="${provider}" reusable="true" technicalName="${nameUpper}">
    <Qry:description default="false" value="${descEsc}"/>
    <Qry:entityProperties adtcore:changedAt="${timestampIso}" adtcore:changedBy="${responsible}" adtcore:createdAt="${timestampIso}" adtcore:createdBy="${responsible}" adtcore:description="${descEsc}" adtcore:language="${language}" adtcore:name="${nameUpper}" adtcore:type="STR" adtcore:masterLanguage="${language}" adtcore:masterSystem="${masterSystem}" adtcore:responsible="${responsible}"/>
  </Qry:mainComponent>
</Qry:queryResource>`;

    const clientCreate = createClientFromEnv();
    const createResult = await clientCreate.rawPost(
      `${basePath}?compuid=${elemUid}&${corrNrPrefix}lockHandle=${lockHandleA}`,
      skeletonBody,
      {
        'Development-Class': pkg,
        ELEMUID: elemUid,
        'Content-Type': `application/xml, ${structureAccept().split(',')[0].trim()}`,
        Accept: structureAccept(),
        'bwmt-level': '50',
        'x-csrf-token': await clientCreate.getCsrfToken(),
      }
    );
    parseCheckResult(createResult.body, 'Structure skeleton creation');
  } finally {
    try {
      await client.rawPost(`${enqPath}?action=unlock&compuid=${elemUid}`, '', {
        'bwmt-level': '50',
        'x-csrf-token': await client.getCsrfToken(),
      });
    } catch (unlockErr) {
      process.stderr.write(`Warning: failed to release CREA lock for structure/${nameLower}: ${unlockErr}\n`);
    }
  }

  let messages: string[] = [];
  if (args.members?.length) {
    const infoAreaEl = infoArea ? `<infoArea>${escapeXml(infoArea)}</infoArea>` : '';
    ({ messages } = await withElementDocument(
      createClientFromEnv(),
      'structure',
      nameLower,
      (doc) => {
        let next = doc;
        args.members!.forEach((spec, idx) => {
          const ref = componentRefs[idx];
          if (ref) next = ensureSubComponent(next, ref.uid, ref.xml);
          const vid = allocateVirtualId(next);
          next = insertStructureMember(
            next,
            buildStructureMember(vid, spec, ref?.uid, next),
            undefined,
            undefined
          );
        });
        if (infoAreaEl && !next.includes('<infoArea>')) {
          next = next.replace(/(<adtCore:packageRef\b[^>]*?(?:\/>|<\/adtCore:packageRef>))/, `$1${infoAreaEl}`);
        }
        return next;
      },
      transport
    ));
  }

  const storedMembers = args.members?.length ? await countStoredMembers(nameLower) : 0;
  if (storedMembers !== (args.members?.length ?? 0)) {
    throw new Error(
      `Structure '${nameUpper}' was created but holds ${storedMembers} of ${args.members!.length} member(s) — ` +
        'the backend accepted the save and dropped the rest. The structure exists; add the missing ' +
        'members with bw_update_structure once the cause is clear.'
    );
  }

  const recorded = transport ? await recordedIn(client, elemUid) : undefined;

  return JSON.stringify(
    {
      success: true,
      object_type: 'structure',
      technical_name: nameUpper,
      provider_name: provider,
      member_count: storedMembers,
      obj_uri: objUri,
      package: pkg,
      ...(infoArea ? { info_area: infoArea } : {}),
      ...(transport ? { transport_request: transport } : {}),
      ...(recorded ? { recorded_in: recorded } : {}),
      consistency_messages: messages,
      message: `Structure '${nameUpper}' created on InfoProvider '${provider}' with ${args.members?.length ?? 0} member(s).`,
      debug: { elem_uid: elemUid },
    },
    null,
    2
  );
}

// ── bw_update_structure ──────────────────────────────────────────────────────

export interface StructureOperation {
  action: 'add_member' | 'remove_member' | 'set_member_properties';
  /** Reusable CKF/RKF the member shows (add_member; also matches on the other actions). */
  component_name?: string;
  /** Basic key figure the member shows (add_member). */
  key_figure?: string;
  /** Member id, the unambiguous matcher for remove_member / set_member_properties. */
  member_id?: string;
  /** Member text — set on add_member, a matcher on the other actions. */
  description?: string;
  /** Additional characteristic restrictions on the member (add_member). */
  restrictions?: KeyFigureRestriction[];
  /** Display and planning properties (add_member and set_member_properties). */
  properties?: MemberProperties;
  /** Nest the new member under this one, by member id or description (add_member). */
  parent?: string;
  /** Position among the siblings (0-based). Appends when omitted. */
  position?: number;
}

export interface UpdateStructureArgs {
  component_name: string;
  description?: string;
  operations: StructureOperation[];
  transport_request?: string;
}

/**
 * Change a reusable structure in place — the object every reporting query embeds, so
 * a member added here appears in all of them. That is the point, and the reason this
 * is not routed through a carrier query: editing the structure through one query that
 * happens to embed it risks producing a query-local copy instead, which would show
 * the new member in that one query only.
 *
 * All operations are applied to one in-memory document and written in a single PUT.
 */
export async function bwUpdateStructure(client: BwClient, args: UpdateStructureArgs): Promise<string> {
  if (!args.component_name) throw new Error('component_name is required.');
  if (!Array.isArray(args.operations) || args.operations.length === 0) {
    throw new Error('operations must be a non-empty array.');
  }

  const nameUpper = args.component_name.toUpperCase();
  const componentCache = new Map<string, { uid: string; xml: string }>();

  // Resolve component references before locking the document.
  const componentRefs: Array<{ uid: string; xml: string } | undefined> = [];
  for (const op of args.operations) {
    if (op.action === 'add_member') {
      componentRefs.push(await resolveMemberSpec(client, op, componentCache));
    } else if (op.action === 'remove_member' || op.action === 'set_member_properties') {
      if (!op.member_id && !op.description && !op.component_name) {
        throw new Error(`${op.action} requires member_id, description, or component_name.`);
      }
      componentRefs.push(
        op.component_name
          ? { uid: await resolveComponentUid(client, op.component_name), xml: '' }
          : undefined
      );
    } else {
      throw new Error(`Unknown action '${String((op as StructureOperation).action)}'.`);
    }
  }

  const applied: string[] = [];
  // Member count the document should end up with, checked against the saved result.
  // A member the backend does not accept is dropped silently and the save still
  // reports "consistent", so counting is the only thing that makes that visible.
  let expectedMembers = 0;
  const { messages, document } = await withElementDocument(
    client,
    'structure',
    nameUpper,
    (doc) => {
      let next = doc;
      expectedMembers = walkMembers(structureMembersRegion(doc).xml).length;

      if (args.description !== undefined) {
        const descEsc = escapeXml(args.description);
        const mainStart = next.indexOf('<Qry:mainComponent');
        const openEnd = next.indexOf('>', mainStart) + 1;
        next =
          next.slice(0, openEnd) +
          next
            .slice(openEnd)
            .replace(/<Qry:description\b[^>]*?\/>/, `<Qry:description default="false" value="${descEsc}"/>`)
            .replace(/(<Qry:entityProperties\b[^>]*?adtCore:description=")[^"]*"/, `$1${descEsc}"`);
        applied.push(`structure description set to "${args.description}"`);
      }

      args.operations.forEach((op, idx) => {
        if (op.action === 'add_member') {
          const ref = componentRefs[idx];
          if (ref) next = ensureSubComponent(next, ref.uid, ref.xml);
          const vid = allocateVirtualId(next);
          const memberXml = buildStructureMember(vid, op, ref?.uid, next, op.parent ? 'childMembers' : 'members');
          next = insertStructureMember(next, memberXml, op.parent, op.position);
          expectedMembers++;
          const label = op.component_name?.toUpperCase() ?? op.key_figure?.toUpperCase() ?? '';
          applied.push(
            `member '${label}' added` +
              (op.parent ? ` under '${op.parent}'` : '') +
              (op.position === undefined ? '' : ` at position ${op.position}`)
          );
          return;
        }

        // Matching by component goes through the selection token, which is the only
        // place a member records which component it shows.
        const ref = op.member_id ?? op.description;
        let target: { id: string; start: number; end: number; full: string };
        if (ref) {
          target = resolveStructureMember(next, ref, op.action);
        } else {
          const region = structureMembersRegion(next);
          const uid = componentRefs[idx]!.uid;
          const matches = walkMembers(region.xml).filter((m) => m.full.includes(`component="${uid}"`));
          if (matches.length === 0) {
            throw new Error(`${op.action}: no member references component '${op.component_name}'.`);
          }
          if (matches.length > 1) {
            throw new Error(
              `${op.action}: ${matches.length} members reference component '${op.component_name}' — pass member_id.`
            );
          }
          target = {
            id: matches[0].id,
            start: region.start + matches[0].start,
            end: region.start + matches[0].end,
            full: matches[0].full,
          };
        }

        if (op.action === 'remove_member') {
          next = next.slice(0, target.start) + next.slice(target.end);
          expectedMembers -= walkMembers(target.full).length;
          applied.push(`member '${target.id}' removed`);
        } else {
          if (!op.properties) throw new Error('set_member_properties requires properties.');
          const updated = applyMemberProperties(target.full, op.properties, next);
          next = next.slice(0, target.start) + updated + next.slice(target.end);
          applied.push(`properties of member '${target.id}' changed`);
        }
      });

      return next;
    },
    args.transport_request?.toUpperCase()
  );

  const storedMembers = await countStoredMembers(nameUpper);
  if (storedMembers !== expectedMembers) {
    throw new Error(
      `Structure '${nameUpper}' was saved with ${storedMembers} member(s) but ${expectedMembers} were ` +
        `expected — the backend accepted the save and dropped part of it. The operations applied were: ` +
        `${applied.join('; ')}. Read the structure back before retrying.`
    );
  }

  const elemUid = document.match(/<Qry:mainComponent\b[^>]*?\bid="([^"]+)"/)?.[1];
  const recorded = args.transport_request && elemUid ? await recordedIn(client, elemUid) : undefined;

  return JSON.stringify(
    {
      success: true,
      object_type: 'structure',
      technical_name: nameUpper,
      member_count: storedMembers,
      applied_operations: applied,
      ...(args.transport_request ? { transport_request: args.transport_request.toUpperCase() } : {}),
      ...(recorded ? { recorded_in: recorded } : {}),
      consistency_messages: messages,
      message: `Structure '${nameUpper}' updated.`,
    },
    null,
    2
  );
}

// ── bw_update_variable ───────────────────────────────────────────────────────

export interface UpdateVariableArgs {
  variable_name: string;
  description?: string;
  ready_for_input?: boolean;
  input_type?: 'Optional' | 'MandatoryWithInitial' | 'MandatoryWithoutInitial';
  represents?: 'Interval' | 'SingleValue' | 'SeveralSingleValues' | 'SelectionOption';
  processing_type?: 'UserEntry' | 'CustomerExit' | 'Authorization' | 'ReplacementPath';
  transport_request?: string;
}

/** The replacement path block a ReplacementPath variable needs; empty for every other type. */
const REPLACEMENT_PATH_CURRENT_MEMBER =
  '<Qry:replacementPath type="CurrentMember" asBoolean="false" offsetStart="0000"' +
  ' offsetLength="0000" calculateBeforeNonCum="false"/>';

/**
 * Apply the requested changes to a variable document.
 *
 * Separate from the save cycle so the shape of the edit can be checked without a system,
 * and because one detail is easy to get wrong in a way nothing reports: `<Qry:type>` exists
 * twice in the document. The second one belongs to `<Qry:defaultHint>`, and a replacement
 * that lands on it turns the hint into a constant — the variable still reads back as
 * consistent, and the damage only surfaces in the value help the variable screen offers.
 * The enum elements are therefore edited only after `</Qry:entityProperties>`, which is
 * where all four of them live and where the hint does not reach.
 */
export function applyVariableChanges(
  doc: string,
  args: UpdateVariableArgs
): { document: string; applied: string[] } {
  const applied: string[] = [];
  const mainStart = doc.indexOf('<Qry:mainComponent');
  if (mainStart === -1) throw new Error('Document has no <Qry:mainComponent>.');
  const head = doc.slice(0, mainStart);
  let main = doc.slice(mainStart);

  if (args.description !== undefined) {
    const descEsc = escapeXml(args.description);
    main = main
      .replace(/<Qry:description\b[^>]*?\/>/, `<Qry:description default="false" value="${descEsc}"/>`)
      .replace(/(<Qry:entityProperties\b[^>]*?adtCore:description=")[^"]*"/, `$1${descEsc}"`);
    applied.push(`description set to "${args.description}"`);
  }

  if (args.ready_for_input !== undefined) {
    const value = String(args.ready_for_input);
    main = main.replace(
      /(<Qry:mainComponent\b[^>]*?\breadyForInput=")[^"]*"/,
      `$1${value}"`
    );
    applied.push(`ready_for_input set to ${value}`);
  }

  // The enum elements all sit after </Qry:entityProperties>. Splitting there keeps the
  // replacements off the identically named elements inside <Qry:defaultHint>, where a
  // <Qry:type> also lives and a stray write turns the hint into a constant.
  const propsEnd = main.indexOf('</Qry:entityProperties>');
  if (propsEnd === -1) throw new Error('Document has no </Qry:entityProperties>.');
  const splitAt = propsEnd + '</Qry:entityProperties>'.length;
  const beforeEnums = main.slice(0, splitAt);
  let enums = main.slice(splitAt);

  const setElement = (tag: string, value: string): void => {
    const re = new RegExp(`<Qry:${tag}>[^<]*</Qry:${tag}>|<Qry:${tag}/>`);
    if (!re.test(enums)) throw new Error(`Document has no <Qry:${tag}> element.`);
    enums = enums.replace(re, `<Qry:${tag}>${value}</Qry:${tag}>`);
  };

  if (args.input_type !== undefined) {
    setElement('inputType', args.input_type);
    applied.push(`input_type set to ${args.input_type}`);
  }
  if (args.represents !== undefined) {
    setElement('represents', args.represents);
    applied.push(`represents set to ${args.represents}`);
  }
  if (args.processing_type !== undefined) {
    setElement('procType', args.processing_type);
    // The replacement path block belongs to the processing type: a ReplacementPath
    // variable without it has nothing to replace from, and leaving it behind on a
    // variable that is no longer one would describe a rule that no longer applies.
    const replacement =
      args.processing_type === 'ReplacementPath'
        ? REPLACEMENT_PATH_CURRENT_MEMBER
        : '<Qry:replacementPath/>';
    enums = enums.replace(
      /<Qry:replacementPath\b[^>]*?(\/>|>[\s\S]*?<\/Qry:replacementPath>)/,
      replacement
    );
    applied.push(`processing_type set to ${args.processing_type}`);
  }

  return { document: head + beforeEnums + enums, applied };
}

/**
 * Change a reusable variable in place.
 *
 * Why in place and not delete-and-recreate: BW refuses to delete a variable that a query,
 * a CKF or a structure references, and deleting the query does not take its reusable
 * sub-components with it — so a variable created with a wrong literal used to be stuck in
 * the system with no way to reach it from here. The UID is preserved by editing the live
 * document rather than rebuilding it, so every reference survives the change.
 *
 * Two fields are deliberately not offered, both because the backend does not honour them:
 *
 *   - The reference characteristic. A PUT that changes `infoObject` comes back "consistent"
 *     and the old characteristic is still in place afterwards — the silent coercion this
 *     tool exists to expose, so it is rejected instead of sent.
 *   - The variable type (characteristic value / hierarchy / hierarchy nodes). Same picture,
 *     and the type decides what the rest of the document has to look like.
 *
 * Both need a delete and a fresh create, which is possible exactly as long as nothing
 * references the variable yet.
 */
export async function bwUpdateVariable(client: BwClient, args: UpdateVariableArgs): Promise<string> {
  if (!args.variable_name) throw new Error('variable_name is required.');
  const extra = args as unknown as Record<string, unknown>;
  for (const [field, hint] of [
    ['iobj_name', 'the reference characteristic'],
    ['variable_type', 'the variable type'],
  ] as const) {
    if (extra[field] !== undefined) {
      throw new Error(
        `'${field}' cannot be changed on an existing variable: BW accepts the write, reports the ` +
          `object as consistent and keeps the old value. Delete the variable and create it again to ` +
          `change ${hint} — which only works while nothing references it yet.`
      );
    }
  }
  if (
    args.description === undefined &&
    args.ready_for_input === undefined &&
    args.input_type === undefined &&
    args.represents === undefined &&
    args.processing_type === undefined
  ) {
    throw new Error(
      'Nothing to do: pass description, ready_for_input, input_type, represents and/or processing_type.'
    );
  }

  const nameUpper = args.variable_name.toUpperCase();
  const applied: string[] = [];

  const { messages, document } = await withElementDocument(
    client,
    'variable',
    nameUpper,
    (doc) => {
      const result = applyVariableChanges(doc, args);
      applied.push(...result.applied);
      return result.document;
    },
    args.transport_request?.toUpperCase()
  );

  const elemUid = document.match(/<Qry:mainComponent\b[^>]*?\bid="([^"]+)"/)?.[1];
  const recorded = args.transport_request && elemUid ? await recordedIn(client, elemUid) : undefined;

  return JSON.stringify(
    {
      success: true,
      object_type: 'variable',
      technical_name: nameUpper,
      ...(elemUid ? { uid: elemUid } : {}),
      applied_operations: applied,
      ...(args.transport_request ? { transport_request: args.transport_request.toUpperCase() } : {}),
      ...(recorded ? { recorded_in: recorded } : {}),
      consistency_messages: messages,
      message:
        `Variable '${nameUpper}' updated. Read it back with bw_get_variable: the modeling API ` +
        'stores its default for a literal it does not know and still reports the object as consistent.',
    },
    null,
    2
  );
}
