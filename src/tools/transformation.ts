import {
  BwClient,
  MEDIA_TYPES,
  createClientFromEnv,
  freshRead,
  resolveMasterSystem,
  bwSeg,
} from '../bw-client.js';
import { parseInfoObjectProps } from './infoobject.js';
import { parseActivationMessages, parseDtpsDeactivated, bwActivate } from './activation.js';

/** Resolved per call, not once at import — see the note on adsoAccept() in adso.ts. */
const trfnAccept = (): string => MEDIA_TYPES['trfn'];

/**
 * Read the inactive (/m) version of a Transformation through a FRESH session
 * with forceCacheUpdate=true.
 *
 * The shared long-lived client pins a per-session model buffer once it has read
 * an object; later PRE-LOCK reads return that stale state even with
 * forceCacheUpdate=true (verified live). A read-modify-write built on such a
 * read silently resurrects old attribute values on the PUT — this reverted an
 * already-persisted HANARuntime switch. A fresh session always returns the
 * database state, including an existing unactivated M draft. (Locking does
 * refresh the buffer, but the reads below happen before locking.)
 */
async function freshReadInactive(
  trfnLower: string
): Promise<{ body: string; headers: Record<string, string> }> {
  return freshRead(`/sap/bw/modeling/trfn/${bwSeg(trfnLower)}/m`, trfnAccept());
}

// ── bwCreateTransformation ────────────────────────────────────────────────────

export interface CreateTransformationArgs {
  source_object_type: string;
  source_object_name: string;
  target_object_type: string;
  target_object_name: string;
  package?: string;
  source_system?: string;
  copy_from_transformation?: string;
  // InfoObject sub-type (TEXT / ATTR / HIER) — only relevant when the corresponding
  // object type is IOBJ. Selects the InfoObject facet (text table, attributes, hierarchy).
  source_object_subtype?: string;
  target_object_subtype?: string;
}

/**
 * bw_create_transformation — create a new Transformation (inactive).
 *
 * Flow:
 * 1. GET 8TRANSIENT → server generates the Transformation name
 * 2. Lock (CREA)    → lockHandle
 * 3. POST minimal XML (manually constructed, per payloads/trfn_create.md)
 *
 * Returns the generated Transformation name for use with bw_activate.
 */
export async function bwCreateTransformation(
  client: BwClient,
  args: CreateTransformationArgs
): Promise<string> {
  const srcType = args.source_object_type.toUpperCase();
  const srcName = args.source_object_name.toUpperCase();
  const tgtType = args.target_object_type.toUpperCase();
  const tgtName = args.target_object_name.toUpperCase();
  const pkg     = args.package ?? '$TMP';

  // For RSDS sources: encode sourceobjectname as datasourceName.padEnd(30) + sourceSystem.padEnd(10)
  // with spaces URL-encoded as '+' for the 8TRANSIENT query parameter.
  const srcNameForUrl = srcType === 'RSDS'
    ? encodeURIComponent(srcName.padEnd(30) + (args.source_system ?? '').toUpperCase().padEnd(10)).replace(/%20/g, '+')
    : srcName;

  // Step 1: GET 8TRANSIENT → generated Transformation name
  const transientPath =
    `/sap/bw/modeling/trfn/8transient?GetIdOnly=true` +
    `&sourceobjecttype=${srcType}` +
    `&targetobjecttype=${tgtType}` +
    (args.source_object_subtype ? `&sourceobjectsubtype=${args.source_object_subtype.toUpperCase()}` : '') +
    (args.target_object_subtype ? `&targetobjectsubtype=${args.target_object_subtype.toUpperCase()}` : '') +
    `&sourceobjectname=${srcNameForUrl}` +
    `&targetobjectname=${tgtName}`;

  const { body: transientXml } = await client.get(transientPath, trfnAccept());

  const nameMatch = transientXml.match(/\bname="([^"]+)"/);
  if (!nameMatch) {
    throw new Error(`Could not extract Transformation name from 8TRANSIENT response:\n${transientXml}`);
  }
  const trfnName  = nameMatch[1].toUpperCase();
  const trfnLower = trfnName.toLowerCase();

  const language     = process.env.BW_LANGUAGE ?? 'DE';
  const masterSystem = await resolveMasterSystem(client);
  const responsible  = (process.env.BW_USER ?? '').toUpperCase();

  // Step 2: Lock with CREA — exact Eclipse header set, no SAP session headers
  const csrfToken = await client.getCsrfToken();
  const lockPath = `/sap/bw/modeling/trfn/${bwSeg(trfnLower)}?action=lock`;
  const lockResponse = await client.rawPost(lockPath, '', {
    'activity_context': 'CREA',
    'Accept': trfnAccept(),
    'x-csrf-token': csrfToken,
  });
  const lockHandleMatch = lockResponse.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/);
  if (!lockHandleMatch) {
    throw new Error(`No <LOCK_HANDLE> in lock response:\n${lockResponse.body}`);
  }
  const lockHandle = lockHandleMatch[1];

  // Step 3: POST minimal XML (manually constructed — see payloads/trfn_create.md)
  const postBody = `<?xml version="1.0" encoding="UTF-8"?>
<trfn:transformation
  xmlns:adtcore="http://www.sap.com/adt/core"
  xmlns:atom="http://www.w3.org/2005/Atom"
  xmlns:trfn="http://www.sap.com/bw/modeling/Trfn.ecore"
  description=""
  endRoutine=""
  expertRoutine=""
  name="${trfnName}"
  startRoutine="">
  <tlogoProperties
    adtcore:language="${language}"
    adtcore:name="${trfnName}"
    adtcore:type="TRFN"
    adtcore:version="inactive"
    adtcore:masterLanguage="${language}"
    adtcore:masterSystem="${masterSystem}"
    adtcore:responsible="${responsible}">
    <atom:link
      href="/sap/bw/modeling/trfn/${bwSeg(trfnLower)}/m"
      rel="self"
      type="application/vnd.sap-bw-modeling.trfn+xml"/>
    <objectVersion>M</objectVersion>
    <objectStatus>inactive</objectStatus>
    <contentState>NEW</contentState>
  </tlogoProperties>
  <source description="" id="0" name="${srcType === 'RSDS' ? srcName.padEnd(30) + (args.source_system ?? '').toUpperCase().padEnd(10) : srcName}"${args.source_object_subtype ? ` subType="${args.source_object_subtype.toUpperCase()}"` : ''} type="${srcType}"/>
  <target description="" id="0" name="${tgtName}"${args.target_object_subtype ? ` subType="${args.target_object_subtype.toUpperCase()}"` : ''} type="${tgtType}"/>
</trfn:transformation>`;

  const copyParams = args.copy_from_transformation
    ? `&copyFromObjectName=${args.copy_from_transformation.toUpperCase()}&copyFromObjectType=TRFN`
    : '';
  const createPath = `/sap/bw/modeling/trfn/${bwSeg(trfnLower)}?lockHandle=${lockHandle}${copyParams}`;

  // Session B: eigene Session + CSRF-Token, POST mit lockHandle aus Session A
  const client2 = createClientFromEnv();
  await client2.getCsrfToken();
  await client2.postWithCsrf(
    createPath,
    postBody,
    trfnAccept(),
    { 'Development-Class': pkg },
    true,
  );

  // Step 4: Verify persisted — through a fresh session so the check reflects the
  // database, not the creating session's model buffer.
  try {
    await freshReadInactive(trfnLower);
  } catch {
    throw new Error(
      `Transformation '${trfnName}' was not persisted after creation ` +
      `(GET /sap/bw/modeling/trfn/${trfnLower}/m returned 404).`
    );
  }

  // Step 5: Unlock (CREA lock is no longer needed after successful creation)
  try {
    await client.unlock('trfn', trfnLower);
  } catch (unlockErr) {
    process.stderr.write(`Warning: failed to unlock trfn/${trfnLower} after creation: ${unlockErr}\n`);
  }

  return JSON.stringify({
    success: true,
    transformation_name: trfnName,
    source: { type: srcType, name: srcName },
    target: { type: tgtType, name: tgtName },
    package: pkg,
    message: `Transformation '${trfnName}' created inactive. Call bw_activate with object_type "trfn" to activate.`,
  });
}

/**
 * Does this error carry the backend's "model serialization failed" message?
 *
 * `CL_RSO_RES_TRFN` wraps `get_xml_from_db()` and turns a `CX_RSO_RES_SERIALIZATION_ERR` into
 * `CX_RSO_RES_INTERNAL`, which reaches the caller as HTTP 500 with the exception text in the
 * body. That text is the T100 message `RS_RES_MODEL 001` and therefore language-dependent, so
 * matching one language's wording is not enough — the German text shares no words with the
 * English one. Both shipped texts are matched, plus the message class in case the body carries
 * the T100 key. A session in a third language still falls through to the raw 500, which is the
 * behaviour without this check, so a miss costs nothing.
 */
export function isModelSerializationFailure(msg: string): boolean {
  if (!/HTTP 500/.test(msg)) return false;
  return /serialization failed|Serialisierung ist fehlgeschlagen|RS_RES_MODEL/i.test(msg);
}

/**
 * bw_get_transformation — read a Transformation (inactive version).
 * Returns raw XML + status + timestamp.
 * Note: Transformation name is a UUID-like generated key, not human-readable.
 */
export async function bwGetTransformation(
  _client: BwClient,
  transformationName: string,
  format: 'text' | 'raw' = 'text',
): Promise<string> {
  let result: { body: string; headers: Record<string, string> };
  try {
    result = await freshReadInactive(transformationName.toLowerCase());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!isModelSerializationFailure(msg)) throw err;
    // The serializer cannot build a model for this transformation. Deterministic for a given
    // database state, so retrying is pointless — but the rules are still readable from the
    // metadata tables, which is the one route that does not go through the serializer.
    throw new Error(
      `Transformation ${transformationName.toUpperCase()} cannot be read through the modeling API: ` +
        'the backend failed to serialize its model (HTTP 500, RS_RES_MODEL 001). Retrying will not ' +
        'help. Read it with bw_read_metadata_tables (object_type "TRFN") instead, or open it in ' +
        'SAP GUI (RSTRAN).',
    );
  }
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';
  const ts = result.headers['timestamp'] ?? '';
  const xml = result.body;
  if (format === 'raw') return xml;
  return summarizeTransformation(transformationName.toUpperCase(), status, ts, xml);
}

/**
 * Parse the transformation XML and return a compact human-readable summary.
 * Extracts: source/target, routine info, and per-field mapping rules.
 */
function summarizeTransformation(
  name: string,
  status: string,
  timestamp: string,
  xml: string
): string {
  const lines: string[] = [];
  lines.push(`Transformation: ${name}`);
  lines.push(`Status: ${status}`);
  lines.push(`Timestamp: ${timestamp}`);

  // ── Header attributes ─────────────────────────────────────────────────────
  const attr = (key: string) =>
    xml.match(new RegExp(`\\b${key}="([^"]*)"`))?.[1] ?? '';

  const description      = attr('description');
  const startRoutine     = attr('startRoutine');
  const endRoutine       = attr('endRoutine');
  const expertRoutine    = attr('expertRoutine');
  const abapProgram      = attr('abapProgram');
  const hanaExec         = attr('sapHANAExecutionPossible');

  if (description)  lines.push(`Description: ${description}`);
  if (abapProgram)  lines.push(`ABAP Program: ${abapProgram}`);
  if (hanaExec)     lines.push(`HANA Execution: ${hanaExec}`);

  // ── Source / Target ───────────────────────────────────────────────────────
  const srcMatch = xml.match(/<source\b[^>]*id="0"[^>]*name="([^"]+)"[^>]*(?:description="([^"]*)")?[^>]*type="([^"]+)"/);
  const tgtMatch = xml.match(/<target\b[^>]*id="0"[^>]*name="([^"]+)"[^>]*(?:description="([^"]*)")?[^>]*type="([^"]+)"/);
  if (srcMatch) lines.push(`Source: ${srcMatch[3]} ${srcMatch[1]}${srcMatch[2] ? ' (' + srcMatch[2] + ')' : ''}`);
  if (tgtMatch) lines.push(`Target: ${tgtMatch[3]} ${tgtMatch[1]}${tgtMatch[2] ? ' (' + tgtMatch[2] + ')' : ''}`);

  // ── Routines ──────────────────────────────────────────────────────────────
  // Also scan rule groups for routinetype=START/END/EXPERT (modern BW/4 style)
  const ruleMatches = [...xml.matchAll(/<rule\b([^>]*)>([\s\S]*?)<\/rule>/g)];

  function findGroupRoutine(type: string): string {
    for (const rm of ruleMatches) {
      const rt = rm[1].match(/routinetype="([^"]*)"/)?.[1] ?? '';
      if (rt.toUpperCase() !== type) continue;
      const sAttrs = rm[2].match(/<step\b([^>]*)/)?.[1] ?? '';
      const cls    = sAttrs.match(/classNameM="([^"]*)"/)?.[1] ?? '';
      const mth    = sAttrs.match(/methodNameM="([^"]*)"/)?.[1] ?? '';
      if (cls) return `${cls}.${mth}`;
    }
    return '';
  }

  const startRef  = startRoutine  || findGroupRoutine('START');
  const endRef    = endRoutine    || findGroupRoutine('END');
  const expertRef = expertRoutine || findGroupRoutine('EXPERT');

  lines.push('');
  lines.push('── Routines ──');
  lines.push(`  startRoutine:  ${startRef  || '(none)'}`);
  lines.push(`  endRoutine:    ${endRef    || '(none)'}`);
  lines.push(`  expertRoutine: ${expertRef || '(none)'}`);

  if (startRef || endRef || expertRef) {
    lines.push(`  NOTE: to read routine code, parse "ClassName.MethodName" from the path above`);
    lines.push(`        and call GetSource(object_type="CLAS", name=ClassName, method=MethodName).`);
    lines.push(`        Never read the ABAP Program listed in the header — it contains the full`);
    lines.push(`        generated class (~5000 lines) and will exceed context limits.`);
  }

  if (ruleMatches.length > 0) {
    lines.push('');
    lines.push('── Field Mappings ──');
    for (const rm of ruleMatches) {
      const ruleAttrs   = rm[1];
      const ruleBody    = rm[2];
      const routinetype = ruleAttrs.match(/routinetype="([^"]*)"/)?.[1] ?? '';

      // Step attributes — use [^>]* so slashes in classNameM paths don't break capture
      const stepMatch   = ruleBody.match(/<step\b([^>]*)/);
      const stepAttrs   = stepMatch?.[1] ?? '';
      const xsiType     = stepAttrs.match(/xsi:type="trfn:Step([^"]+)"/)?.[1] ?? '';
      const stepType    = (stepAttrs.match(/\btype="([^"]*)"/)?.[1] ?? routinetype) || xsiType;
      const classNameM  = stepAttrs.match(/classNameM="([^"]*)"/)?.[1] ?? '';
      const methodNameM = stepAttrs.match(/methodNameM="([^"]*)"/)?.[1] ?? '';
      const constant    = stepAttrs.match(/\bconstant="([^"]*)"/)?.[1] ?? '';

      // Extract source fields from <elementRef>#///source/segment1/FIELD
      const srcFields = [...ruleBody.matchAll(/elementRef>#\/\/\/source\/[^/]+\/([^<]+)<\/elementRef>/g)]
        .map(m => m[1]);
      // Extract target fields from <elementRef>#///target/segment1/FIELD
      const tgtFields = [...ruleBody.matchAll(/elementRef>#\/\/\/target\/[^/]+\/([^<]+)<\/elementRef>/g)]
        .map(m => m[1]);

      const src = srcFields.length > 0 ? srcFields.join(', ') : '(none)';
      const tgt = tgtFields.length > 0 ? tgtFields.join(', ') : '(none)';

      let label = stepType || xsiType || '?';
      // Show routinetype when it adds info not already in the label
      if (routinetype && !label.toUpperCase().includes(routinetype.toUpperCase())) {
        label += ` [${routinetype}]`;
      }
      if (classNameM)  label += ` | ${classNameM}.${methodNameM}`;
      if (constant)    label += ` = "${constant}"`;

      // Extract filter conditions on this rule
      const filterParts: string[] = [];
      for (const fm of ruleBody.matchAll(/<filter\b([^>]*?)(?:\/>|>)/g)) {
        const fa   = fm[1];
        const sign = fa.match(/\bsign="([^"]+)"/)?.[1] ?? '';
        const opt  = fa.match(/\boption="([^"]+)"/)?.[1] ?? '';
        const low  = fa.match(/\blow="([^"]+)"/)?.[1] ?? '';
        const high = fa.match(/\bhigh="([^"]+)"/)?.[1] ?? '';
        const part = high ? `${sign}${opt}[${low},${high}]` : `${sign}${opt}${low}`;
        if (part.trim()) filterParts.push(part);
      }
      const filterSuffix = filterParts.length > 0 ? `  {FILTER: ${filterParts.join('; ')}}` : '';

      lines.push(`  [${label}]  ${src}  →  ${tgt}${filterSuffix}`);

      // Show formula code inline (StepFormula)
      // Formula can be an attribute on <step formula="..."> or a child <formula> element
      const formulaCode = stepAttrs.match(/\bformula="([^"]*)"/)?.[1]?.trim()
        ?? ruleBody.match(/<formula\b[^>]*>([\s\S]*?)<\/formula>/)?.[1]?.trim()
        ?? ruleBody.match(/<code\b[^>]*>([\s\S]*?)<\/code>/)?.[1]?.trim()
        ?? '';
      if (formulaCode) {
        for (const codeLine of formulaCode.split('\n')) {
          lines.push(`      ${codeLine}`);
        }
      }

      // For StepRoutine: show class/method prominently if not already in label
      if (!classNameM && (xsiType === 'Routine' || routinetype === 'ROUTINE')) {
        const routineRef = ruleBody.match(/routineName="([^"]+)"/)?.[1]
          ?? ruleBody.match(/className="([^"]+)"/)?.[1]
          ?? '';
        if (routineRef) lines.push(`      → Routine: ${routineRef}`);
      }
    }
  }

  // ── Source fields ─────────────────────────────────────────────────────────
  // Drill into the first <segment> inside <source> to get all available source fields
  const srcSegContent = xml.match(/<source\b[^>]*>[\s\S]*?<segment\b[^>]*>([\s\S]*?)<\/segment>/)?.[1] ?? '';
  if (srcSegContent) {
    const srcElems = [...srcSegContent.matchAll(/<element\b([^>]*?)(?:\/>|>([\s\S]*?)<\/element>)/g)];
    if (srcElems.length > 0) {
      lines.push('');
      lines.push(`── Source Fields (${srcElems.length}) ──`);
      const keys: string[] = [];
      const vals: string[] = [];
      for (const m of srcElems) {
        const attrs  = m[1];
        const body   = m[2] ?? '';
        const name   = attrs.match(/\bname="([^"]+)"/)?.[1] ?? '';
        const isKey  = attrs.match(/\bkey="([^"]+)"/)?.[1] === 'true';
        const dt     = body.match(/<inlineType\b[^>]*name="([^"]+)"/)?.[1] ?? '';
        const entry  = dt ? `${name}(${dt})` : name;
        if (isKey) keys.push(entry); else vals.push(entry);
      }
      if (keys.length) lines.push(`  Key fields (${keys.length}): ${keys.join(', ')}`);
      if (vals.length) lines.push(`  Value fields (${vals.length}): ${vals.join(', ')}`);
    }
  }

  // ── Target fields ─────────────────────────────────────────────────────────
  const tgtSegContent = xml.match(/<target\b[^>]*>[\s\S]*?<segment\b[^>]*>([\s\S]*?)<\/segment>/)?.[1] ?? '';
  if (tgtSegContent) {
    const tgtElems = [...tgtSegContent.matchAll(/<element\b([^>]*?)(?:\/>|>([\s\S]*?)<\/element>)/g)];
    if (tgtElems.length > 0) {
      lines.push('');
      lines.push(`── Target Fields (${tgtElems.length}) ──`);
      const keys: string[] = [];
      const vals: string[] = [];
      for (const m of tgtElems) {
        const attrs  = m[1];
        const body   = m[2] ?? '';
        const name   = attrs.match(/\bname="([^"]+)"/)?.[1] ?? '';
        const isKey  = attrs.match(/\bkey="([^"]+)"/)?.[1] === 'true';
        const dt     = body.match(/<inlineType\b[^>]*name="([^"]+)"/)?.[1] ?? '';
        const conv   = attrs.match(/\bconversionRoutine="([^"]+)"/)?.[1] ?? '';
        const entry  = [name, dt ? `(${dt})` : '', conv ? `[${conv}]` : ''].filter(Boolean).join('');
        if (isKey) keys.push(entry); else vals.push(entry);
      }
      if (keys.length) lines.push(`  Key fields (${keys.length}): ${keys.join(', ')}`);
      if (vals.length) lines.push(`  Value fields (${vals.length}): ${vals.join(', ')}`);
    }
  }

  return lines.join('\n');
}

// ── XML helpers ──────────────────────────────────────────────────────────────

/**
 * Extract source field properties from the transformation's <source><segment> section.
 * Returns the full element XML block (to be reused verbatim in formula input elements).
 */
function extractSourceFieldProps(
  xml: string,
  fieldName: string
): { dataType: string; length: string; elementXml: string } {
  const srcSegMatch = xml.match(/<source\b[^>]*>[\s\S]*?<segment[^>]*>([\s\S]*?)<\/segment>/);
  if (!srcSegMatch) return { dataType: 'CHAR', length: '20', elementXml: '' };

  const segContent = srcSegMatch[1];
  const elemRegex = new RegExp(
    `<element\\b[^>]*name="${fieldName.toUpperCase()}"[^>]*>([\\s\\S]*?)<\\/element>`
  );
  const elemMatch = segContent.match(elemRegex);
  if (!elemMatch) return { dataType: 'CHAR', length: '20', elementXml: '' };

  const body = elemMatch[1];
  // Try length first, fall back to precision (DEC fields use precision+scale, no length)
  const inlineMatch = body.match(/<inlineType[^>]*name="([^"]+)"[^>]*(?:length="([^"]+)"|precision="([^"]+)")/);
  return {
    dataType: inlineMatch?.[1] ?? 'CHAR',
    length: inlineMatch?.[2] ?? inlineMatch?.[3] ?? '20',
    elementXml: elemMatch[0],
  };
}

/**
 * Extract target InfoObject properties from the transformation's <target><segment> section.
 */
function extractTargetElemProps(
  xml: string,
  iObjName: string
): { convRoutine: string; dataType: string; length: string } {
  const tgtSegMatch = xml.match(/<target\b[^>]*>[\s\S]*?<segment[^>]*>([\s\S]*?)<\/segment>/);
  if (!tgtSegMatch) return { convRoutine: '', dataType: 'CHAR', length: '20' };

  const segContent = tgtSegMatch[1];
  const elemRegex = new RegExp(
    `<element\\b([^>]*infoObjectName="${iObjName.toUpperCase()}"[^>]*)>([\\s\\S]*?)<\\/element>`
  );
  const elemMatch = segContent.match(elemRegex);
  if (!elemMatch) return { convRoutine: '', dataType: 'CHAR', length: '20' };

  const attrStr = elemMatch[1];
  const bodyStr = elemMatch[2];
  const convMatch = attrStr.match(/conversionRoutine="([^"]+)"/);
  const inlineMatch = bodyStr.match(/<inlineType[^>]*name="([^"]+)"[^>]*length="([^"]+)"/);

  return {
    convRoutine: convMatch?.[1] ?? '',
    dataType: inlineMatch?.[1] ?? 'CHAR',
    length: inlineMatch?.[2] ?? '20',
  };
}

/**
 * Inspect the target-segment element for a field/InfoObject mapping target.
 * Distinguishes field-based targets (plain InfoSource/aDSO field, no underlying
 * InfoObject) from InfoObject-based targets: only the latter carry an
 * `infoObjectName` attribute. Returns the full `<element>...</element>` block
 * verbatim so callers can clone it into a new rule without an iobj read.
 */
function extractTargetFieldProps(
  xml: string,
  fieldName: string
): { isFieldBased: boolean; elementXml: string } {
  const tgtSegMatch = xml.match(/<target\b[^>]*>[\s\S]*?<segment[^>]*>([\s\S]*?)<\/segment>/);
  if (!tgtSegMatch) return { isFieldBased: true, elementXml: '' };

  const segContent = tgtSegMatch[1];
  const elemRegex = new RegExp(
    `<element\\b([^>]*name="${fieldName.toUpperCase()}"[^>]*)>([\\s\\S]*?)<\\/element>`
  );
  const elemMatch = segContent.match(elemRegex);
  if (!elemMatch) return { isFieldBased: true, elementXml: '' };

  return {
    isFieldBased: !/\binfoObjectName="/.test(elemMatch[1]),
    elementXml: elemMatch[0],
  };
}

/**
 * Find the rule that targets the given InfoObject with a StepNoUpdate step,
 * and return its id, its group id, and the full original rule XML to replace.
 */
function findNoUpdateRule(
  xml: string,
  targetInfoObject: string
): { ruleId: string; groupId: string; oldRuleXml: string } | null {
  // Extract group element and its id
  const groupMatch = xml.match(/<group\s+id="(\d+)"[^>]*>([\s\S]*?)<\/group>/);
  if (!groupMatch) return null;
  const groupId = groupMatch[1];
  const groupContent = groupMatch[0]; // full <group>...</group> including tags

  const target = targetInfoObject.toUpperCase();
  const ruleRegex = /<rule(\s[^>]*)>([\s\S]*?)<\/rule>/g;
  let match: RegExpExecArray | null;

  while ((match = ruleRegex.exec(groupContent)) !== null) {
    const attrStr = match[1];
    const body = match[2];
    const ruleIdMatch = attrStr.match(/id="(\d+)"/);

    const targetsIObj = body.includes(`/target/segment1/${target}</elementRef>`);
    const isNoUpdate =
      body.includes('StepNoUpdate') || body.includes('NO_UPDATE') ||
      body.includes('StepInitial')  || body.includes('type="INITIAL"');

    if (targetsIObj && isNoUpdate) {
      return {
        ruleId: ruleIdMatch?.[1] ?? '',
        groupId,
        oldRuleXml: match[0],
      };
    }
  }
  return null;
}

type StepType = 'DIRECT' | 'INITIAL' | 'NO_UPDATE' | 'ROUTINE' | 'FORMULA' | 'CONSTANT' | 'READ';

/**
 * Find any rule that targets the given InfoObject (any known step type).
 * Used by the routine/formula/direct conversion paths.
 */
function findRuleForTarget(
  xml: string,
  targetInfoObject: string
): { ruleId: string; groupId: string; oldRuleXml: string; stepType: StepType } | null {
  const target = targetInfoObject.toUpperCase();

  // Search ALL groups, not just the first. A transformation with a start/end routine has the
  // global routine group (type="G") FIRST; its single rule (routinetype="START"/"END") references
  // every target field and would otherwise shadow the field's own rule, which lives in the
  // standard group (type="S"). Skip those global routine rules so the field's own rule is selected.
  const groupRegex = /<group\s+id="(\d+)"[^>]*>([\s\S]*?)<\/group>/g;
  let groupMatch: RegExpExecArray | null;

  while ((groupMatch = groupRegex.exec(xml)) !== null) {
    const groupId = groupMatch[1];
    const groupContent = groupMatch[0];

    const ruleRegex = /<rule(\s[^>]*)>([\s\S]*?)<\/rule>/g;
    let match: RegExpExecArray | null;

    while ((match = ruleRegex.exec(groupContent)) !== null) {
      const attrStr = match[1];
      const body = match[2];

      // Skip global start/end routine rules — they reference all target fields.
      if (/\broutinetype="(?:START|END)"/.test(attrStr)) continue;

      const targetsIObj = body.includes(`/target/segment1/${target}</elementRef>`);
      if (!targetsIObj) continue;

      const ruleIdMatch = attrStr.match(/id="(\d+)"/);

      let stepType: StepType | null = null;
      if (body.includes('StepNoUpdate') || body.includes('type="NO_UPDATE"')) stepType = 'NO_UPDATE';
      else if (body.includes('StepInitial') || body.includes('type="INITIAL"')) stepType = 'INITIAL';
      else if (body.includes('StepDirect') || body.includes('type="DIRECT"')) stepType = 'DIRECT';
      else if (body.includes('StepRoutine') || body.includes('type="ROUTINE"')) stepType = 'ROUTINE';
      else if (body.includes('StepFormula') || body.includes('type="FORMULA"')) stepType = 'FORMULA';
      else if (body.includes('StepConstant') || body.includes('type="CONSTANT"')) stepType = 'CONSTANT';
      else if (body.includes('StepRead') || body.includes('type="READ"')) stepType = 'READ';

      if (stepType) {
        return {
          ruleId: ruleIdMatch?.[1] ?? '',
          groupId,
          oldRuleXml: match[0],
          stepType,
        };
      }
    }
  }
  return null;
}

/** Escape a string for use in an XML attribute value. */
function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convert a StepDirect or StepInitial rule to StepRoutine via string replacements.
 * Input/output element content stays identical — only step type, id, and references change.
 */
function convertDirectOrInitialRuleToRoutine(ruleXml: string): string {
  let r = ruleXml;
  // 1. Update step1 → step2 in all #/// references within the rule
  r = r.replace(/\/step1\//g, '/step2/');
  // 2. Add performConversionExit to <target id="1">
  r = r.replace(/<target(\s+id="1")[^>]*>/, '<target$1 performConversionExit="NOT_SUPPORTED">');
  // 3. Change xsi:type on the step element
  r = r.replace('xsi:type="trfn:StepDirect"', 'xsi:type="trfn:StepRoutine"');
  r = r.replace('xsi:type="trfn:StepInitial"', 'xsi:type="trfn:StepRoutine"');
  // 4. Change id="1" → id="2" on the <step element only (requires leading space before id)
  r = r.replace(/(<step\b[^>]*\s)id="1"/, '$1id="2"');
  // 5. Change type="DIRECT"/"INITIAL" → type="ROUTINE" on the <step element
  //    Use \s before type= to avoid matching xsi:type=
  r = r.replace(/(<step\b[^>]*\s)type="(?:DIRECT|INITIAL)"/, '$1type="ROUTINE"');
  return r;
}

/**
 * Convert a StepDirect or StepInitial rule to StepFormula via string replacements.
 * Structurally identical to the routine conversion but sets StepFormula + formula attribute.
 */
function convertDirectOrInitialRuleToFormula(ruleXml: string, formula: string): string {
  let r = ruleXml;
  // 1. Update step1 → step2 in all #/// references within the rule
  r = r.replace(/\/step1\//g, '/step2/');
  // 2. Add performConversionExit to <target id="1">
  r = r.replace(/<target(\s+id="1")[^>]*>/, '<target$1 performConversionExit="NOT_SUPPORTED">');
  // 3. Change xsi:type on the step element
  r = r.replace('xsi:type="trfn:StepDirect"', 'xsi:type="trfn:StepFormula"');
  r = r.replace('xsi:type="trfn:StepInitial"', 'xsi:type="trfn:StepFormula"');
  // 4. Change id="1" → id="2" on the <step element only
  r = r.replace(/(<step\b[^>]*\s)id="1"/, '$1id="2"');
  // 5. Change type="DIRECT"/"INITIAL" → type="FORMULA" and append formula attribute
  r = r.replace(
    /(<step\b[^>]*\s)type="(?:DIRECT|INITIAL)"/,
    `$1type="FORMULA" formula="${escapeXmlAttr(formula)}"`,
  );
  return r;
}

/**
 * Build a StepFormula rule from a StepNoUpdate rule.
 * Supports multiple source fields for multi-field formula expressions.
 * Reuses the full element XML from the source segment verbatim (adds xsi:type only).
 */
function buildNoUpdateToFormulaRule(
  ruleXml: string,
  groupId: string,
  ruleId: string,
  targetInfoObject: string,
  sourceFields: Array<{ name: string; dataType: string; length: string; elementXml: string }>,
  formula: string,
): string {
  const stepMatch = ruleXml.match(/<step\b[^>]*>([\s\S]*?)<\/step>/);
  if (!stepMatch) throw new Error('Cannot parse step from StepNoUpdate rule');
  const stepOutputBlock = stepMatch[1].trim();

  const tgt = targetInfoObject.toUpperCase();
  const g = groupId;
  const rv = ruleId;

  const sourceTags = sourceFields
    .map(
      (sf, i) =>
        `<source id="${i + 1}">\n        <input>#///group${g}/rule${rv}/step2/input${i + 1}</input>\n        <elementRef>#///source/segment1/${sf.name}</elementRef>\n      </source>`,
    )
    .join('\n      ');

  const inputTags = sourceFields
    .map((sf, i) => {
      // Clone element XML from source segment, inject xsi:type="trfn:TransformationElement"
      const elemXml = sf.elementXml
        ? sf.elementXml.replace(/^<element\b/, '<element xsi:type="trfn:TransformationElement"')
        : `<element xsi:type="trfn:TransformationElement" name="${sf.name}">
            <endUserTexts label="${sf.name}"/>
            <inlineType name="${sf.dataType}" length="${sf.length}" semanticType="empty"/>
            <localProperties xsi:type="BwCore:LocalCharacteristicProperties"/>
            <associationType>1</associationType>
            <associationValid>false</associationValid>
          </element>`;
      return `<input id="${i + 1}">\n          <output>#///group${g}/rule${rv}/source${i + 1}</output>\n          ${elemXml}\n        </input>`;
    })
    .join('\n        ');

  return `<rule id="${rv}" description="">
      ${sourceTags}
      <target id="1" performConversionExit="NOT_SUPPORTED">
        <output>#///group${g}/rule${rv}/step2/output1</output>
        <elementRef>#///target/segment1/${tgt}</elementRef>
      </target>
      <step xsi:type="trfn:StepFormula" id="2" rank="MAIN" type="FORMULA" formula="${escapeXmlAttr(formula)}">
        ${inputTags}
        ${stepOutputBlock}
      </step>
    </rule>`;
}

/**
 * Convert any rule (StepDirect, StepInitial, StepNoUpdate) to StepConstant.
 * - Removes the <source> element from the rule (constants have no source)
 * - Removes the <input id="..."> element from within the step
 * - Keeps the step <output> element unchanged
 * - Sets xsi:type="trfn:StepConstant", id="2", type="CONSTANT", constant="<value>"
 * - Adds performConversionExit="NOT_SUPPORTED" to <target>
 * - Updates step1 → step2 references
 */
function convertRuleToConstant(ruleXml: string, constantValue: string): string {
  let r = ruleXml;

  // For a DATS (date) target field BW expects the constant in the EXTERNAL date display format,
  // not the internal YYYYMMDD. The target element's <inlineType> sits inside the step's <output>
  // block (the source element, if any, lives in an <input> block), so detect the type there.
  // The external date format is the user/system date display setting; DD.MM.YYYY is assumed for
  // this DE system (BW_LANGUAGE=DE). TIMS (time) is not handled here — only DATS is confirmed.
  const stepOutput = ruleXml.match(/<output\b[^>]*\bid="[^"]*"[\s\S]*?<\/output>/)?.[0] ?? '';
  const targetIsDats = /<inlineType\b[^>]*\bname="DATS"/.test(stepOutput);
  let value = constantValue;
  if (targetIsDats && /^\d{8}$/.test(value)) {
    // Internal YYYYMMDD → external DD.MM.YYYY. Values already containing separators pass through.
    value = `${value.slice(6, 8)}.${value.slice(4, 6)}.${value.slice(0, 4)}`;
  }

  // 1. Remove <source ...>...</source> element from the rule (not needed for constants)
  r = r.replace(/<source\b[^>]*>[\s\S]*?<\/source>/, '');
  // 2. Update step1 → step2 in all #/// references
  r = r.replace(/\/step1\//g, '/step2/');
  // 3. Add performConversionExit to <target id="1">
  r = r.replace(/<target(\s+id="1")[^>]*>/, '<target$1 performConversionExit="NOT_SUPPORTED">');
  // 4. Remove <input id="...">...</input> block from inside the step
  //    Only matches step-level inputs (id attribute present); the <input>ref</input> inside
  //    <output> elements has no attributes and is NOT affected.
  r = r.replace(
    /(<step\b[^>]*>)([\s\S]*?)(<\/step>)/,
    (_match, open, body, close) => {
      const cleanBody = body.replace(/<input\b[^>]*id="[^"]*"[^>]*>[\s\S]*?<\/input>/g, '');
      return open + cleanBody + close;
    },
  );
  // 5. Change xsi:type on the step element
  r = r.replace(
    /xsi:type="trfn:Step(?:Direct|Initial|NoUpdate)"/,
    'xsi:type="trfn:StepConstant"',
  );
  // 6. Change id="1" → id="2" on the <step element
  r = r.replace(/(<step\b[^>]*\s)id="1"/, '$1id="2"');
  // 7. Change type → CONSTANT and append constant attribute
  r = r.replace(
    /(<step\b[^>]*\s)type="(?:DIRECT|INITIAL|NO_UPDATE)"/,
    `$1type="CONSTANT" constant="${escapeXmlAttr(value)}"`,
  );
  return r;
}

/**
 * Build a StepRoutine rule from a StepNoUpdate rule.
 * Reuses the existing step output element and adds a new source input element.
 */
function buildNoUpdateToRoutineRule(
  ruleXml: string,
  groupId: string,
  ruleId: string,
  targetInfoObject: string,
  sourceField: string,
  srcType: string,
  srcLength: string,
): string {
  // Extract the step <output> block — its content (element + input ref to target1) stays unchanged
  const stepMatch = ruleXml.match(/<step\b[^>]*>([\s\S]*?)<\/step>/);
  if (!stepMatch) throw new Error('Cannot parse step from StepNoUpdate rule');
  const stepOutputBlock = stepMatch[1].trim();

  const src = sourceField.toUpperCase();
  const tgt = targetInfoObject.toUpperCase();
  const g = groupId;
  const rv = ruleId;

  return `<rule id="${rv}" description="">
      <source id="1">
        <input>#///group${g}/rule${rv}/step2/input1</input>
        <elementRef>#///source/segment1/${src}</elementRef>
      </source>
      <target id="1" performConversionExit="NOT_SUPPORTED">
        <output>#///group${g}/rule${rv}/step2/output1</output>
        <elementRef>#///target/segment1/${tgt}</elementRef>
      </target>
      <step xsi:type="trfn:StepRoutine" id="2" rank="MAIN" type="ROUTINE">
        <input id="1">
          <output>#///group${g}/rule${rv}/source1</output>
          <element name="${src}">
            <endUserTexts label="${src}"/>
            <inlineType name="${srcType}" length="${srcLength}" semanticType="empty"/>
            <localProperties xsi:type="BwCore:LocalCharacteristicProperties"/>
            <associationType>1</associationType>
            <associationValid>false</associationValid>
          </element>
        </input>
        ${stepOutputBlock}
      </step>
    </rule>`;
}

/**
 * Build a StepRead (Lookup) rule to replace any existing rule.
 */
function buildLookupRule(
  _ruleXml: string,
  groupId: string,
  ruleId: string,
  targetInfoObject: string,
  sourceField: string,
  lookupObject: string,
  lookupObjectType: string,
): string {
  const src = sourceField.toUpperCase();
  const tgt = targetInfoObject.toUpperCase();
  const g = groupId;
  const rv = ruleId;

  return `<rule id="${rv}" description="">
      <source id="1">
        <input>#///group${g}/rule${rv}/step2/input1</input>
        <elementRef>#///source/segment1/${src}</elementRef>
      </source>
      <target id="1" performConversionExit="NOT_SUPPORTED">
        <output>#///group${g}/rule${rv}/step2/output1</output>
        <elementRef>#///target/segment1/${tgt}</elementRef>
      </target>
      <step xsi:type="trfn:StepRead" id="2" rank="MAIN" type="READ" objectName="${lookupObject}" objectType="${lookupObjectType}">
        <input id="1">
          <output>#///group${g}/rule${rv}/source1</output>
          <element name="${src}" infoObjectName="${src}">
            <inlineType name="CHAR" length="22" semanticType="date" globalElementName="${src}"/>
          </element>
        </input>
        <output id="1">
          <input>#///group${g}/rule${rv}/target1</input>
          <element name="${tgt}" infoObjectName="${tgt}">
            <inlineType name="CHAR" length="1" semanticType="date" globalElementName="${tgt}"/>
          </element>
        </output>
      </step>
    </rule>`;
}

/**
 * Build a StepDirect rule XML to replace an existing StepNoUpdate rule.
 * Based on the exact structure from adso_workflow.md Block 6b.
 */
function buildStepDirectRule(params: {
  groupId: string;
  ruleId: string;
  sourceField: string;
  targetIObj: string;
  srcType: string;
  srcLength: string;
  tgtConvRoutine: string;
  tgtType: string;
  tgtLength: string;
  tgtLabel: string;
}): string {
  const {
    groupId, ruleId, sourceField, targetIObj,
    srcType, srcLength, tgtConvRoutine, tgtType, tgtLength, tgtLabel,
  } = params;

  const src = sourceField.toUpperCase();
  const tgt = targetIObj.toUpperCase();
  const tgtLower = targetIObj.toLowerCase();
  const convAttr = tgtConvRoutine ? ` conversionRoutine="${tgtConvRoutine}"` : '';

  return `<rule id="${ruleId}" description="">
      <source id="1">
        <input>#///group${groupId}/rule${ruleId}/step2/input1</input>
        <elementRef>#///source/segment1/${src}</elementRef>
      </source>
      <target performConversionExit="NO" id="1">
        <output>#///group${groupId}/rule${ruleId}/step2/output1</output>
        <elementRef>#///target/segment1/${tgt}</elementRef>
      </target>
      <step xsi:type="trfn:StepDirect" id="2" type="DIRECT" rank="MAIN">
        <input id="1">
          <output>#///group${groupId}/rule${ruleId}/source1</output>
          <element name="${src}">
            <endUserTexts label="${src}"/>
            <inlineType name="${srcType}" length="${srcLength}" semanticType="empty"/>
            <localProperties xsi:type="BwCore:LocalCharacteristicProperties"/>
            <associationType>1</associationType>
            <associationValid>false</associationValid>
          </element>
        </input>
        <output id="1">
          <input>#///group${groupId}/rule${ruleId}/target1</input>
          <element xsi:type="trfn:TransformationElement" name="${tgt}"
            infoObjectName="${tgt}"${convAttr}
            dimension="#///target/segment1/ALL§">
            <endUserTexts label="${tgtLabel}"/>
            <inlineType name="${tgtType}" length="${tgtLength}" semanticType="empty"/>
            <localProperties xsi:type="BwCore:LocalCharacteristicProperties"/>
            <atom:link href="/sap/bw/modeling/iobj/${bwSeg(tgtLower)}/a" rel="self" xmlns:atom="http://www.w3.org/2005/Atom"/>
            <associationType>1</associationType>
            <associationValid>true</associationValid>
          </element>
        </output>
      </step>
    </rule>`;
}

/**
 * Build a StepDirect rule XML for a field-based target element (no underlying
 * InfoObject — see payloads/trfn_direct_field_mapping.md). Clones the source
 * and target `<element>` blocks verbatim from their respective segments, so
 * no infoObjectName/dimension/atom:link is introduced and associationValid
 * stays false. Emits the server-normalized form (step id 1) used by
 * pre-existing direct rules, rather than the editor's id="2" draft form.
 */
function buildStepDirectFieldRule(params: {
  groupId: string;
  ruleId: string;
  sourceField: string;
  sourceElementXml: string;
  targetField: string;
  targetElementXml: string;
}): string {
  const { groupId, ruleId, sourceField, sourceElementXml, targetField, targetElementXml } = params;
  const src = sourceField.toUpperCase();
  const tgt = targetField.toUpperCase();
  const g = groupId;
  const rv = ruleId;

  const inputElem = sourceElementXml.replace(/^<element\b/, '<element xsi:type="trfn:TransformationElement"');
  const outputElem = targetElementXml.replace(/^<element\b/, '<element xsi:type="trfn:TransformationElement"');

  return `<rule id="${rv}" description="">
      <source id="1">
        <input>#///group${g}/rule${rv}/step1/input1</input>
        <elementRef>#///source/segment1/${src}</elementRef>
      </source>
      <target id="1">
        <output>#///group${g}/rule${rv}/step1/output1</output>
        <elementRef>#///target/segment1/${tgt}</elementRef>
      </target>
      <step xsi:type="trfn:StepDirect" id="1" rank="MAIN" type="DIRECT">
        <input id="1">
          <output>#///group${g}/rule${rv}/source1</output>
          ${inputElem}
        </input>
        <output id="1">
          <input>#///group${g}/rule${rv}/target1</input>
          ${outputElem}
        </output>
      </step>
    </rule>`;
}

/**
 * Convert a segment <element>…</element> block into the form used inside a rule step
 * (input/output). Strips the segment-only attributes (posit, key, intType, dimension)
 * and any existing xsi:type, then injects xsi:type="trfn:TransformationElement". The
 * child nodes (inlineType, unitCurrencyElement, semantics, localProperties, …) are kept
 * verbatim — BW normalizes any remaining differences on read-back.
 */
function segmentElementToStepElement(segmentElementXml: string): string {
  return segmentElementXml.replace(/^<element\b([^>]*)>/, (_m, attrs: string) => {
    const cleaned = attrs
      .replace(/\s+xsi:type="[^"]*"/g, '')
      .replace(/\s+posit="[^"]*"/g, '')
      .replace(/\s+key="[^"]*"/g, '')
      .replace(/\s+intType="[^"]*"/g, '')
      .replace(/\s+dimension="[^"]*"/g, '');
    return `<element xsi:type="trfn:TransformationElement"${cleaned}>`;
  });
}

/**
 * Read the unit/currency field a key figure element points to via its
 * <unitCurrencyElement>#///{source|target}/segment1/FIELD</unitCurrencyElement> child.
 * Returns the bare field name (e.g. "UNIT_FIELD") or '' when the element carries no unit.
 */
function extractUnitCurrencyField(elementXml: string): string {
  return elementXml
    .match(/<unitCurrencyElement>#\/\/\/[^/]+\/segment1\/([^<]+)<\/unitCurrencyElement>/)?.[1]
    ?.trim() ?? '';
}

/**
 * Build a combined key-figure + unit/currency direct rule (multi-source / multi-target),
 * matching the structure Eclipse produces when a quantity is mapped together with its unit
 * (or an amount with its currency). See payloads/trfn_unit_currency_mapping.md.
 *
 *   <rule conversiontype="FROM_SOURCE">
 *     <source id="1">→ key figure   <source id="2">→ unit/currency
 *     <target id="1">→ key figure   <target id="2">→ unit/currency
 *     <step id="1" rank="MAIN">  key figure (carries unitCurrencyElement)
 *     <step id="2" rank="MINOR"> unit/currency field
 *
 * Requires allowCurrencyAndUnitConversion="true" on the transformation root, and the
 * caller must remove the standalone unit/currency rule (its mapping becomes the MINOR step).
 */
function buildCombinedDirectRule(params: {
  groupId: string;
  ruleId: string;
  kfSourceField: string;
  kfTargetField: string;
  kfSourceElementXml: string;
  kfTargetElementXml: string;
  unitSourceField: string;
  unitTargetField: string;
  unitSourceElementXml: string;
  unitTargetElementXml: string;
}): string {
  const g = params.groupId;
  const rv = params.ruleId;
  const kfIn  = segmentElementToStepElement(params.kfSourceElementXml);
  const kfOut = segmentElementToStepElement(params.kfTargetElementXml);
  const unIn  = segmentElementToStepElement(params.unitSourceElementXml);
  const unOut = segmentElementToStepElement(params.unitTargetElementXml);

  return `<rule id="${rv}" conversiontype="FROM_SOURCE" description="">
      <source id="1"><input>#///group${g}/rule${rv}/step1/input1</input><elementRef>#///source/segment1/${params.kfSourceField}</elementRef></source>
      <source id="2"><input>#///group${g}/rule${rv}/step2/input1</input><elementRef>#///source/segment1/${params.unitSourceField}</elementRef></source>
      <target id="1"><output>#///group${g}/rule${rv}/step1/output1</output><elementRef>#///target/segment1/${params.kfTargetField}</elementRef></target>
      <target id="2"><output>#///group${g}/rule${rv}/step2/output1</output><elementRef>#///target/segment1/${params.unitTargetField}</elementRef></target>
      <step xsi:type="trfn:StepDirect" id="1" rank="MAIN" type="DIRECT">
        <input id="1"><output>#///group${g}/rule${rv}/source1</output>${kfIn}</input>
        <output id="1"><input>#///group${g}/rule${rv}/target1</input>${kfOut}</output>
      </step>
      <step xsi:type="trfn:StepDirect" id="2" rank="MINOR" type="DIRECT">
        <input id="1"><output>#///group${g}/rule${rv}/source2</output>${unIn}</input>
        <output id="1"><input>#///group${g}/rule${rv}/target2</input>${unOut}</output>
      </step>
    </rule>`;
}

/**
 * Convert any existing rule back to StepNoUpdate (no mapping).
 * Preserves the target reference and step output element from the existing rule.
 */
function buildNoUpdateRule(ruleXml: string, ruleId: string): string {
  // Extract <target ...>...</target> block
  const targetMatch = ruleXml.match(/<target\b[^>]*>[\s\S]*?<\/target>/);
  if (!targetMatch) throw new Error('Cannot parse target block from rule');
  const targetBlock = targetMatch[0];

  // Extract <output id="1">...</output> from within the step
  const stepMatch = ruleXml.match(/<step\b[^>]*>([\s\S]*?)<\/step>/);
  if (!stepMatch) throw new Error('Cannot parse step from rule');
  const outputMatch = stepMatch[1].match(/<output\b[^>]*id="1"[^>]*>[\s\S]*?<\/output>/);
  if (!outputMatch) throw new Error('Cannot parse output block from step');
  const outputBlock = outputMatch[0];

  return `<rule id="${ruleId}" description="">${targetBlock}` +
    `<step xsi:type="trfn:StepNoUpdate" id="1" type="NO_UPDATE" rank="MAIN">` +
    `${outputBlock}</step></rule>`;
}

/**
 * bw_update_transformation — map a source field to a target InfoObject,
 * or convert an existing rule to a field routine (StepRoutine).
 *
 * rule_type="direct" (default):
 *   Finds any existing rule for the target InfoObject (any step type) and
 *   replaces it with StepDirect. source_field is required unless it can be
 *   inferred from the existing rule.
 *   When unitSourceField is set, builds a COMBINED key-figure + unit/currency
 *   direct rule (multi-source/target) instead — target_infoobject is the key
 *   figure, unitSourceField the source unit/currency field. The target unit/
 *   currency field is read from the key figure's <unitCurrencyElement>, the
 *   standalone unit rule is folded into the combined rule, and the transformation
 *   flag allowCurrencyAndUnitConversion is switched on. See
 *   payloads/trfn_unit_currency_mapping.md.
 *
 * rule_type="routine":
 *   Finds the rule for the target InfoObject (StepDirect, StepInitial, or
 *   StepNoUpdate) and converts it to StepRoutine. The server generates the
 *   ABAP AMDP class automatically. For StepNoUpdate rules, source_field is
 *   required; for StepDirect/StepInitial it is ignored.
 *
 * rule_type="formula":
 *   Finds the rule for the target InfoObject (StepDirect, StepInitial, or
 *   StepNoUpdate) and converts it to StepFormula. The formula parameter is
 *   required. For StepNoUpdate rules, source_field is also required.
 *   No ABAP class is generated — the BW runtime evaluates the formula natively.
 *   Use /BIC/FIELDNAME for custom InfoObject fields in the formula expression.
 *
 * Workflow: read InfoObject → GET Transformation → Lock → replace rule → PUT
 * Returns lockHandle for bw_activate.
 */
export async function bwUpdateTransformation(
  client: BwClient,
  transformationName: string,
  sourceField: string | undefined,
  targetInfoObject: string,
  ruleType: 'direct' | 'routine' | 'formula' | 'constant' | 'lookup' | 'no_update' = 'direct',
  formula?: string,
  constantValue?: string,
  lookupObject?: string,
  lookupObjectType?: string,
  transport?: string,
  additionalSourceFields?: string[],
  unitSourceField?: string,
): Promise<string> {
  const tgtUpper = targetInfoObject.toUpperCase();
  let srcUpper = sourceField?.toUpperCase() ?? '';

  // Step 1: Read current Transformation (get full XML + timestamp)
  const trfnResult = await freshReadInactive(transformationName.toLowerCase());
  const timestamp = trfnResult.headers['timestamp'] ?? trfnResult.headers['TIMESTAMP'];
  const originalXml = trfnResult.body;

  let updatedXml: string;

  if (ruleType === 'routine') {
    // ── Routine path ────────────────────────────────────────────────────────
    const ruleInfo = findRuleForTarget(originalXml, tgtUpper);
    if (!ruleInfo) {
      return JSON.stringify({
        success: false,
        message:
          `No rule found for target InfoObject ${tgtUpper} in ` +
          `transformation ${transformationName.toUpperCase()}. ` +
          `The field may not exist in the target segment.`,
      });
    }

    let newRule: string;
    if (ruleInfo.stepType === 'NO_UPDATE') {
      if (!srcUpper) {
        return JSON.stringify({
          success: false,
          message:
            `source_field is required when converting a StepNoUpdate rule to StepRoutine ` +
            `(target InfoObject ${tgtUpper} has no source mapping yet).`,
        });
      }
      const srcProps = extractSourceFieldProps(originalXml, srcUpper);
      newRule = buildNoUpdateToRoutineRule(
        ruleInfo.oldRuleXml,
        ruleInfo.groupId,
        ruleInfo.ruleId,
        tgtUpper,
        srcUpper,
        srcProps.dataType,
        srcProps.length,
      );
    } else {
      // StepDirect or StepInitial — source is already mapped, just convert the step type
      newRule = convertDirectOrInitialRuleToRoutine(ruleInfo.oldRuleXml);
    }

    updatedXml = originalXml.replace(ruleInfo.oldRuleXml, newRule);
    if (updatedXml === originalXml) {
      throw new Error('Routine rule replacement failed — XML unchanged.');
    }

    const lockHandle = await client.lock('trfn', transformationName);
    try {
      await client.put('trfn', transformationName, lockHandle, updatedXml, timestamp, transport);
    } catch (err) {
      await client.unlock('trfn', transformationName).catch(() => {/* ignore */});
      throw err;
    }

    return JSON.stringify({
      success: true,
      message:
        `InfoObject ${tgtUpper} in transformation ${transformationName.toUpperCase()} ` +
        `converted to StepRoutine. The server has generated the ABAP AMDP class. ` +
        `Call bw_activate to activate.`,
      amdp_note:
        'AMDP SQLSCRIPT methods only allow ASCII 7-bit characters. ' +
        'Do NOT use non-ASCII characters (e.g. German umlauts like ä/ö/ü or symbols like <=) ' +
        'in SQLSCRIPT code or comments — they will cause a syntax error.',
      lock_handle: lockHandle,
      transformation_name: transformationName.toUpperCase(),
      object_type: 'trfn',
      converted_from: ruleInfo.stepType,
    });
  }

  if (ruleType === 'formula') {
    // ── Formula path ────────────────────────────────────────────────────────
    if (!formula) {
      return JSON.stringify({
        success: false,
        message: 'formula is required for rule_type="formula".',
      });
    }

    const ruleInfo = findRuleForTarget(originalXml, tgtUpper);
    if (!ruleInfo) {
      return JSON.stringify({
        success: false,
        message:
          `No rule found for target InfoObject ${tgtUpper} in ` +
          `transformation ${transformationName.toUpperCase()}. ` +
          `The field may not exist in the target segment.`,
      });
    }

    let newRule: string;
    if (ruleInfo.stepType === 'NO_UPDATE') {
      if (!srcUpper) {
        return JSON.stringify({
          success: false,
          message:
            `source_field is required when converting a StepNoUpdate rule to StepFormula ` +
            `(target InfoObject ${tgtUpper} has no source mapping yet).`,
        });
      }
      const allSourceFields = [srcUpper, ...(additionalSourceFields ?? []).map(f => f.toUpperCase())];
      const srcFieldDefs = allSourceFields.map(f => {
        const props = extractSourceFieldProps(originalXml, f);
        return { name: f, dataType: props.dataType, length: props.length, elementXml: props.elementXml };
      });
      newRule = buildNoUpdateToFormulaRule(
        ruleInfo.oldRuleXml,
        ruleInfo.groupId,
        ruleInfo.ruleId,
        tgtUpper,
        srcFieldDefs,
        formula,
      );
    } else {
      // StepDirect or StepInitial — source already mapped, just convert the step type
      newRule = convertDirectOrInitialRuleToFormula(ruleInfo.oldRuleXml, formula);
    }

    updatedXml = originalXml.replace(ruleInfo.oldRuleXml, newRule);
    if (updatedXml === originalXml) {
      throw new Error('Formula rule replacement failed — XML unchanged.');
    }

    const lockHandle = await client.lock('trfn', transformationName);
    try {
      await client.put('trfn', transformationName, lockHandle, updatedXml, timestamp, transport);
    } catch (err) {
      await client.unlock('trfn', transformationName).catch(() => {/* ignore */});
      throw err;
    }

    return JSON.stringify({
      success: true,
      message:
        `InfoObject ${tgtUpper} in transformation ${transformationName.toUpperCase()} ` +
        `converted to StepFormula. Call bw_activate to activate.`,
      formula,
      lock_handle: lockHandle,
      transformation_name: transformationName.toUpperCase(),
      object_type: 'trfn',
      converted_from: ruleInfo.stepType,
    });
  }

  if (ruleType === 'constant') {
    // ── Constant path ───────────────────────────────────────────────────────
    if (!constantValue) {
      return JSON.stringify({
        success: false,
        message: 'constant_value is required for rule_type="constant".',
      });
    }

    const ruleInfo = findRuleForTarget(originalXml, tgtUpper);
    if (!ruleInfo) {
      return JSON.stringify({
        success: false,
        message:
          `No rule found for target InfoObject ${tgtUpper} in ` +
          `transformation ${transformationName.toUpperCase()}. ` +
          `The field may not exist in the target segment.`,
      });
    }

    const newRule = convertRuleToConstant(ruleInfo.oldRuleXml, constantValue);
    updatedXml = originalXml.replace(ruleInfo.oldRuleXml, newRule);
    if (updatedXml === originalXml) {
      throw new Error('Constant rule replacement failed — XML unchanged.');
    }
    // Report the value actually written (after any DATS external-date conversion), not the raw input.
    const writtenValue = newRule.match(/<step\b[^>]*\bconstant="([^"]*)"/)?.[1] ?? constantValue;

    const lockHandle = await client.lock('trfn', transformationName);
    try {
      await client.put('trfn', transformationName, lockHandle, updatedXml, timestamp, transport);
    } catch (err) {
      await client.unlock('trfn', transformationName).catch(() => {/* ignore */});
      throw err;
    }

    return JSON.stringify({
      success: true,
      message:
        `InfoObject ${tgtUpper} in transformation ${transformationName.toUpperCase()} ` +
        `converted to StepConstant with value "${writtenValue}". Call bw_activate to activate.`,
      constant_value: writtenValue,
      lock_handle: lockHandle,
      transformation_name: transformationName.toUpperCase(),
      object_type: 'trfn',
      converted_from: ruleInfo.stepType,
    });
  }

  // ── Lookup path ──────────────────────────────────────────────────────────
  if (ruleType === 'lookup') {
    if (!lookupObject || !lookupObjectType) {
      return JSON.stringify({
        success: false,
        message: 'lookup_object and lookup_object_type are required for rule_type="lookup".',
      });
    }
    if (!srcUpper) {
      return JSON.stringify({
        success: false,
        message: 'source_field is required for rule_type="lookup".',
      });
    }

    const ruleInfo = findRuleForTarget(originalXml, tgtUpper);
    if (!ruleInfo) {
      return JSON.stringify({
        success: false,
        message:
          `No rule found for target InfoObject ${tgtUpper} in ` +
          `transformation ${transformationName.toUpperCase()}. ` +
          `The field may not exist in the target segment.`,
      });
    }

    const newRule = buildLookupRule(
      ruleInfo.oldRuleXml,
      ruleInfo.groupId,
      ruleInfo.ruleId,
      tgtUpper,
      srcUpper,
      lookupObject.toUpperCase(),
      lookupObjectType.toUpperCase(),
    );

    updatedXml = originalXml.replace(ruleInfo.oldRuleXml, newRule);
    if (updatedXml === originalXml) {
      throw new Error('Lookup rule replacement failed — XML unchanged.');
    }

    const lockHandle = await client.lock('trfn', transformationName);
    try {
      await client.put('trfn', transformationName, lockHandle, updatedXml, timestamp, transport);
    } catch (err) {
      await client.unlock('trfn', transformationName).catch(() => {/* ignore */});
      throw err;
    }

    return JSON.stringify({
      success: true,
      message:
        `InfoObject ${tgtUpper} in transformation ${transformationName.toUpperCase()} ` +
        `converted to StepRead (Lookup) from ${lookupObjectType.toUpperCase()} ${lookupObject.toUpperCase()}. Call bw_activate to activate.`,
      lookup_object: lookupObject.toUpperCase(),
      lookup_object_type: lookupObjectType.toUpperCase(),
      lock_handle: lockHandle,
      transformation_name: transformationName.toUpperCase(),
      object_type: 'trfn',
      converted_from: ruleInfo.stepType,
    });
  }

  if (ruleType === 'no_update') {
    // ── No-update path — remove any mapping, revert to StepNoUpdate ─────────
    const ruleInfo = findRuleForTarget(originalXml, tgtUpper);
    if (!ruleInfo) {
      return JSON.stringify({
        success: false,
        message:
          `No rule found for target InfoObject ${tgtUpper} in ` +
          `transformation ${transformationName.toUpperCase()}.`,
      });
    }
    if (ruleInfo.stepType === 'NO_UPDATE') {
      return JSON.stringify({
        success: true,
        message: `InfoObject ${tgtUpper} is already StepNoUpdate — nothing to do.`,
        lock_handle: '',
        transformation_name: transformationName.toUpperCase(),
        object_type: 'trfn',
      });
    }
    const newRule = buildNoUpdateRule(ruleInfo.oldRuleXml, ruleInfo.ruleId);
    updatedXml = originalXml.replace(ruleInfo.oldRuleXml, newRule);
    if (updatedXml === originalXml) {
      throw new Error('no_update replacement failed — XML unchanged.');
    }
    const lockHandle = await client.lock('trfn', transformationName);
    try {
      await client.put('trfn', transformationName, lockHandle, updatedXml, timestamp, transport);
    } catch (err) {
      await client.unlock('trfn', transformationName).catch(() => {/* ignore */});
      throw err;
    }
    return JSON.stringify({
      success: true,
      message:
        `InfoObject ${tgtUpper} in transformation ${transformationName.toUpperCase()} ` +
        `reverted to StepNoUpdate (no mapping). Call bw_activate to activate.`,
      lock_handle: lockHandle,
      transformation_name: transformationName.toUpperCase(),
      object_type: 'trfn',
      converted_from: ruleInfo.stepType,
    });
  }

  // ── Combined key-figure + unit/currency direct rule (multi-source/target) ──
  // See payloads/trfn_unit_currency_mapping.md. Maps the key figure together with
  // its unit/currency field in one rule (MAIN + MINOR steps), folds in the unit's
  // own rule, and enables allowCurrencyAndUnitConversion on the transformation root.
  if (unitSourceField) {
    const unitSrcUpper = unitSourceField.toUpperCase();

    const kfRule = findRuleForTarget(originalXml, tgtUpper);
    if (!kfRule) {
      return JSON.stringify({
        success: false,
        message:
          `No rule found for target key figure ${tgtUpper} in ` +
          `transformation ${transformationName.toUpperCase()}.`,
      });
    }

    // Key-figure source: explicit arg, else 1:1 by name.
    const kfSrcUpper = srcUpper || tgtUpper;

    const kfSrcProps = extractSourceFieldProps(originalXml, kfSrcUpper);
    const kfTgtProps = extractTargetFieldProps(originalXml, tgtUpper);

    // Target unit/currency field is dictated by the key figure's unitCurrencyElement.
    const unitTgtField = extractUnitCurrencyField(kfTgtProps.elementXml);
    if (!unitTgtField) {
      return JSON.stringify({
        success: false,
        message:
          `Target key figure ${tgtUpper} has no unit/currency reference (unitCurrencyElement). ` +
          `A combined unit/currency mapping requires the target key figure to reference a ` +
          `unit or currency field in the aDSO.`,
      });
    }

    const unitSrcProps = extractSourceFieldProps(originalXml, unitSrcUpper);
    const unitTgtProps = extractTargetFieldProps(originalXml, unitTgtField);

    const combinedRule = buildCombinedDirectRule({
      groupId: kfRule.groupId,
      ruleId: kfRule.ruleId,
      kfSourceField: kfSrcUpper,
      kfTargetField: tgtUpper,
      kfSourceElementXml: kfSrcProps.elementXml,
      kfTargetElementXml: kfTgtProps.elementXml,
      unitSourceField: unitSrcUpper,
      unitTargetField: unitTgtField,
      unitSourceElementXml: unitSrcProps.elementXml,
      unitTargetElementXml: unitTgtProps.elementXml,
    });

    updatedXml = originalXml.replace(kfRule.oldRuleXml, combinedRule);
    if (updatedXml === originalXml) {
      throw new Error('Combined rule replacement failed — key figure rule XML unchanged.');
    }

    // Remove the now-redundant standalone unit/currency rule (folded into the MINOR step).
    const unitRule = findRuleForTarget(originalXml, unitTgtField);
    if (unitRule && unitRule.oldRuleXml !== kfRule.oldRuleXml) {
      updatedXml = updatedXml.replace(unitRule.oldRuleXml, '');
    }

    // Enable currency/unit handling on the transformation root (the Eclipse checkbox).
    updatedXml = updatedXml.replace(
      /allowCurrencyAndUnitConversion="false"/,
      'allowCurrencyAndUnitConversion="true"',
    );

    const lockHandle = await client.lock('trfn', transformationName);
    try {
      await client.put('trfn', transformationName, lockHandle, updatedXml, timestamp, transport);
    } catch (err) {
      await client.unlock('trfn', transformationName).catch(() => {/* ignore */});
      throw err;
    }

    return JSON.stringify({
      success: true,
      message:
        `Key figure ${tgtUpper} mapped together with unit/currency field ${unitTgtField} ` +
        `(source ${unitSrcUpper}) as a combined direct rule in ` +
        `transformation ${transformationName.toUpperCase()}. Call bw_activate to activate.`,
      key_figure: tgtUpper,
      unit_currency_field: unitTgtField,
      lock_handle: lockHandle,
      transformation_name: transformationName.toUpperCase(),
      object_type: 'trfn',
    });
  }

  // ── Direct path (default) ────────────────────────────────────────────────

  // Determine the target kind first (field-based vs InfoObject-based) — see
  // payloads/trfn_direct_field_mapping.md. Only InfoObject-based targets need
  // the iobj read; a field-based target has no /iobj/ resource to read.
  const tgtFieldProps = extractTargetFieldProps(originalXml, tgtUpper);

  // Find any existing rule for the target
  const ruleInfo = findRuleForTarget(originalXml, tgtUpper);
  if (!ruleInfo) {
    return JSON.stringify({
      success: false,
      message:
        `No rule found for target ${tgtUpper} in ` +
        `transformation ${transformationName.toUpperCase()}.`,
    });
  }

  // Resolve the effective source field: explicit arg takes priority,
  // otherwise infer from the first <element name="..."> inside the <step> block.
  if (!srcUpper) {
    const inferredMatch = ruleInfo.oldRuleXml.match(/<step\b[^>]*>[\s\S]*?<element\s+[^>]*name="([^"]+)"/);
    if (inferredMatch) {
      srcUpper = inferredMatch[1].toUpperCase();
    } else {
      return JSON.stringify({
        success: false,
        message:
          `source_field is required — no source mapping could be inferred from the existing rule for ${tgtUpper}.`,
      });
    }
  }

  const srcProps = extractSourceFieldProps(originalXml, srcUpper);

  let newRule: string;
  if (tgtFieldProps.isFieldBased) {
    newRule = buildStepDirectFieldRule({
      groupId: ruleInfo.groupId,
      ruleId: ruleInfo.ruleId,
      sourceField: srcUpper,
      sourceElementXml: srcProps.elementXml,
      targetField: tgtUpper,
      targetElementXml: tgtFieldProps.elementXml,
    });
  } else {
    // Read InfoObject to get label and type info
    const iObjPath = `/sap/bw/modeling/iobj/${bwSeg(targetInfoObject)}/m`;
    const iObjResult = await client.get(iObjPath, MEDIA_TYPES['iobj']);
    const iObjProps = parseInfoObjectProps(iObjResult.body);
    const tgtProps = extractTargetElemProps(originalXml, tgtUpper);

    newRule = buildStepDirectRule({
      groupId: ruleInfo.groupId,
      ruleId: ruleInfo.ruleId,
      sourceField: srcUpper,
      targetIObj: tgtUpper,
      srcType: srcProps.dataType,
      srcLength: srcProps.length,
      tgtConvRoutine: tgtProps.convRoutine || iObjProps.conversionRoutine,
      tgtType: tgtProps.dataType,
      tgtLength: tgtProps.length,
      tgtLabel: iObjProps.label,
    });
  }

  updatedXml = originalXml.replace(ruleInfo.oldRuleXml, newRule);
  if (updatedXml === originalXml) {
    throw new Error('Rule replacement failed — XML unchanged. The rule text may have unexpected formatting.');
  }

  const lockHandle = await client.lock('trfn', transformationName);
  try {
    await client.put('trfn', transformationName, lockHandle, updatedXml, timestamp);
  } catch (err) {
    await client.unlock('trfn', transformationName).catch(() => {/* ignore unlock error */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message:
      `Source field ${srcUpper} mapped to target ${tgtUpper} in ` +
      `transformation ${transformationName.toUpperCase()}. Call bw_activate to activate.`,
    lock_handle: lockHandle,
    transformation_name: transformationName.toUpperCase(),
    object_type: 'trfn',
  });
}

// ── bwSetTransformationRoutine ───────────────────────────────────────────────

/**
 * bwSetTransformationRoutine — add a Start, End, or Expert routine to a Transformation.
 *
 * Flow:
 * 1. GET XML — derive classNameM from classNameA (_A → _M), error if missing
 * 2. Guard: group id="0" must not already exist
 * 3. Extract fields: source fields for START, target fields for END/EXPERT
 * 4. Build group id="0" block with full step (classNameM + methodNameM included)
 *    - START: <source id="N"> elements, no sourceSegment on group
 *    - END/EXPERT: <target id="N"> elements, sourceSegment="#///source/segment1" on group
 * 5. Lock → single PUT (session-isolated)
 * 6. Return lock_handle for bw_activate
 */

/**
 * Convert a BW InfoObject name to the corresponding HANA SQL column name.
 * Standard objects (starting with "0"): strip the leading "0", no quoting needed.
 * Custom BIC objects: prefix "/BIC/", wrap in double quotes for SQL.
 */
function ioBwNameToHanaSqlColumn(name: string): string {
  if (name.startsWith('0')) {
    return name.substring(1); // e.g. 0IOBJ_NAME → IOBJ_NAME
  }
  return `"/BIC/${name}"`; // e.g. FIELD_NAME → "/BIC/FIELD_NAME"
}

/**
 * Extract target fields from the transformation XML in posit order and build
 * a HANA SQLScript SELECT statement for a GLOBAL_END / GLOBAL_EXPERT skeleton.
 * Appends RECORD and SQL__PROCEDURE__SOURCE__RECORD at the end.
 */
function buildHanaEndSelect(xml: string): string {
  const tgtSegMatch = xml.match(/<target\b[^>]*>[\s\S]*?<segment[^>]*>([\s\S]*?)<\/segment>/);
  if (!tgtSegMatch) return 'outTab = SELECT * FROM :inTab;';

  // Collect fields with their posit for ordering
  const elemRegex = /<element\b[^>]*\bposit="(\d+)"[^>]*\bname="([^"]+)"[^>]*/g;
  const fields: { posit: number; col: string }[] = [];
  let em: RegExpExecArray | null;
  while ((em = elemRegex.exec(tgtSegMatch[1])) !== null) {
    fields.push({ posit: parseInt(em[1], 10), col: ioBwNameToHanaSqlColumn(em[2]) });
  }
  fields.sort((a, b) => a.posit - b.posit);

  const cols = [
    ...fields.map(f => `  ${f.col}`),
    '  RECORD',
    '  SQL__PROCEDURE__SOURCE__RECORD',
  ];
  return `outTab = SELECT\n${cols.join(',\n')}\nFROM :inTab;`;
}

export async function bwSetTransformationRoutine(
  client: BwClient,
  transformationName: string,
  routineType: 'start' | 'end' | 'expert',
  transport?: string
): Promise<string> {
  const trfnUpper = transformationName.toUpperCase();
  const trfnLower = transformationName.toLowerCase();
  const routineTypeUpper = routineType.toUpperCase() as 'START' | 'END' | 'EXPERT';
  const methodName = `GLOBAL_${routineTypeUpper}`;

  // Step 1: GET current XML
  const { body: xml1, headers: headers1 } = await freshReadInactive(trfnLower);
  const timestamp1 = headers1['timestamp'] ?? '';

  // Step 2: Derive classNameM — from classNameA on root, from any existing StepRoutine, or
  //         from the transformation name itself (ABAP mode, no routines yet: /BIC/{last20}_M)
  const classNameAMatch = xml1.match(/\bclassNameA="([^"]+)"/);
  let classNameM: string;
  if (classNameAMatch) {
    classNameM = classNameAMatch[1].replace(/_A$/, '_M');
  } else {
    const classNameMMatch = xml1.match(/\bclassNameM="([^"]+)"/);
    if (classNameMMatch) {
      classNameM = classNameMMatch[1];
    } else {
      // ABAP runtime, no routines yet — derive from transformation name
      classNameM = `/BIC/${trfnUpper.slice(-20)}_M`;
    }
  }

  // Step 3: Guard — reject if this specific routine type already exists anywhere in the
  //         document, regardless of group id. The server persists a sole expert routine group
  //         as id="1" (not id="0"), so a group-scoped check would miss it.
  const routineTypeExists = new RegExp(`<rule\\b[^>]*\\broutinetype="${routineTypeUpper}"`).test(xml1);
  if (routineTypeExists) {
    return JSON.stringify({
      success: false,
      message:
        `Transformation ${trfnUpper} already has a ${routineTypeUpper} routine. ` +
        `Cannot add another one.`,
    });
  }

  // Step 4: Detect runtime from HANARuntime attribute on root element
  const hanaRuntimeAttr = /\bHANARuntime="([^"]+)"/.exec(xml1);
  const hanaRuntime = hanaRuntimeAttr ? hanaRuntimeAttr[1] : 'true';

  // EXPERT on a HANA-runtime transformation must be sent as a bare step (no classNameM,
  // no methodNameM, no target elementRefs, no sourceSegment on the group) AND with all
  // pre-existing rule groups removed. The GUI deletes all existing rules before creating an
  // expert routine; a remaining field-mapping group makes the server generate a plain ABAP
  // class and force ABAP runtime (see payloads/trfn_routine_expert_hana_delta2.md).
  const isHanaExpert = routineType === 'expert' && hanaRuntime === 'true';
  const xmlBase = isHanaExpert ? xml1.replace(/<group\b[\s\S]*?<\/group>/g, '') : xml1;

  // Step 5: Locate the field-mapping group and determine next free rule ID (max existing + 1).
  //         Both are computed on xmlBase — for HANA expert the groups are already stripped, so
  //         there is no group id="0" and no existing rule, giving the expert rule id 1 (matching
  //         the native trace).
  const group0Exists = /<group\b[^>]*\bid="0"/.test(xmlBase);
  const ruleIds: number[] = [];
  const ruleIdRegex = /<rule\b[^>]*\bid="(\d+)"/g;
  let rm: RegExpExecArray | null;
  while ((rm = ruleIdRegex.exec(xmlBase)) !== null) {
    ruleIds.push(parseInt(rm[1], 10));
  }
  const nextRuleId = ruleIds.length > 0 ? Math.max(...ruleIds) + 1 : 1;

  // Step 6: Build rule content based on routine type.
  // For the bare HANA-expert step the server derives classNameM itself and generates a proper
  // AMDP class from the stub; a fully-populated step (as for END) yields a plain ABAP class.
  const stepAttrs = isHanaExpert
    ? `xsi:type="trfn:StepRoutine" id="1" rank="MAIN" type="ROUTINE" hanaRuntime="${hanaRuntime}"`
    : `xsi:type="trfn:StepRoutine" id="1" rank="MAIN" type="ROUTINE"` +
      ` classNameM="${classNameM}" hanaRuntime="${hanaRuntime}" methodNameM="${methodName}"`;

  let ruleContent: string;
  if (routineType === 'start') {
    // START: source fields from <source>/<segment>/<element>
    const srcSegMatch = xml1.match(/<source\b[^>]*>[\s\S]*?<segment[^>]*>([\s\S]*?)<\/segment>/);
    if (!srcSegMatch) {
      throw new Error(`Could not extract source segment from transformation ${trfnUpper}.`);
    }
    const sourceFields: string[] = [];
    const elemRegex = /<element\b[^>]*\bname="([^"]+)"[^>]*>/g;
    let em: RegExpExecArray | null;
    while ((em = elemRegex.exec(srcSegMatch[1])) !== null) {
      sourceFields.push(em[1]);
    }
    const sourceRefs = sourceFields
      .map((f, i) => `<source id="${i + 1}"><elementRef>#///source/segment1/${f}</elementRef></source>`)
      .join('');
    ruleContent =
      `<rule id="${nextRuleId}" routinetype="${routineTypeUpper}">` +
      sourceRefs +
      `<step ${stepAttrs}/>` +
      `</rule>`;
  } else if (isHanaExpert) {
    // EXPERT with HANA runtime has no per-field target elementRefs — the routine
    // replaces the entire field mapping rather than mapping individual fields.
    ruleContent =
      `<rule id="${nextRuleId}" routinetype="${routineTypeUpper}">` +
      `<step ${stepAttrs}/>` +
      `</rule>`;
  } else {
    // END / ABAP EXPERT: target fields from <target>/<segment>/<element>
    const tgtSegMatch = xml1.match(/<target\b[^>]*>[\s\S]*?<segment[^>]*>([\s\S]*?)<\/segment>/);
    if (!tgtSegMatch) {
      throw new Error(`Could not extract target segment from transformation ${trfnUpper}.`);
    }
    const targetFields: string[] = [];
    const elemRegex = /<element\b[^>]*\bname="([^"]+)"[^>]*>/g;
    let em: RegExpExecArray | null;
    while ((em = elemRegex.exec(tgtSegMatch[1])) !== null) {
      targetFields.push(em[1]);
    }
    const targetRefs = targetFields
      .map((f, i) => `<target id="${i + 1}"><elementRef>#///target/segment1/${f}</elementRef></target>`)
      .join('');
    ruleContent =
      `<rule id="${nextRuleId}" routinetype="${routineTypeUpper}">` +
      targetRefs +
      `<step ${stepAttrs}/>` +
      `</rule>`;
  }

  // Step 7: Insert rule — append inside existing group id="0", or create new group before group id="1".
  // For HANA expert all groups were stripped in xmlBase, so group0Exists is false and the
  // insert-before-group-id-1 replace cannot match — the append-before-</trfn:transformation>
  // fallback is the path that fires.
  let xmlWithGroup: string;
  if (group0Exists) {
    xmlWithGroup = xmlBase.replace(
      /(<group\b[^>]*\bid="0"[^>]*>)([\s\S]*?)(<\/group>)/,
      `$1$2${ruleContent}$3`
    );
    if (xmlWithGroup === xmlBase) {
      throw new Error('Could not append rule to existing group id="0".');
    }
  } else {
    const groupAttrs = (routineType === 'start' || isHanaExpert) ? '' : ` sourceSegment="#///source/segment1"`;
    const group0Block = `<group id="0"${groupAttrs} type="G">${ruleContent}</group>`;
    const beforeGroup1 = xmlBase.replace(/<group\s+id="1"/, `${group0Block}<group id="1"`);
    if (beforeGroup1 !== xmlBase) {
      xmlWithGroup = beforeGroup1;
    } else {
      // No group id="1" at all — transformation has no field-mapping rule group yet.
      // Append the new group as the last child instead of requiring group id="1" to exist.
      xmlWithGroup = xmlBase.replace(/<\/trfn:transformation>/, `${group0Block}</trfn:transformation>`);
      if (xmlWithGroup === xmlBase) {
        throw new Error('Could not insert group id="0" — no insertion point found in Transformation XML.');
      }
    }
  }

  // Lock → single PUT (session-isolated)
  const lockHandle = await client.lock('trfn', trfnLower);
  const putClient = createClientFromEnv();
  try {
    await putClient.put('trfn', trfnLower, lockHandle, xmlWithGroup, timestamp1, transport);
  } catch (err) {
    await client.unlock('trfn', trfnLower).catch(() => {/* ignore */});
    throw err;
  }

  // ADT class write flow — activate the generated _M class and inject a proper skeleton.
  // For ABAP: BW generates the class only after activation — skip if 404.
  // For HANA END: BW auto-generates the class; inject the correct SELECT column list
  //   so the user has the right structure when adding custom logic.
  // Skipped entirely for HANA expert: the server generates the AMDP class synchronously and
  //   completely from the bare stub (nothing to inject — IN follows source columns, OUT follows
  //   target columns), and locking/activating the class here can fail on a foreign editor lock
  //   after the BW PUT has already succeeded (see payloads/trfn_routine_expert_hana_delta2.md).
  if (!isHanaExpert) {
    const classEncoded = encodeURIComponent(classNameM).toLowerCase();
    const source = await client.adtGetSource(classEncoded);
    if (source !== null) {
      let updatedSource = source;

      if (hanaRuntime === 'true' && routineType === 'end') {
        // Replace the commented stub SELECT with a proper explicit column list.
        // END only: for EXPERT the IN type follows source columns while OUT follows target
        // columns, so this END-oriented (IN == OUT) column list does not apply.
        const selectStmt = buildHanaEndSelect(xmlWithGroup);
        updatedSource = source.replace(
          /-- outTab = SELECT \* FROM :inTab;/,
          selectStmt
        );
      }

      const adtLock = await client.adtLockClass(classEncoded);
      try {
        await client.adtPutSource(classEncoded, adtLock, updatedSource);
        await client.adtActivate(classEncoded, classNameM);
      } finally {
        await client.adtUnlockClass(classEncoded, adtLock).catch(() => {/* ignore */});
      }
    }
  }

  return JSON.stringify({
    success: true,
    message: isHanaExpert
      ? `${routineTypeUpper} routine added to transformation ${trfnUpper}. ` +
        `AMDP method ${classNameM}->${methodName} (SQLScript) generated. Call bw_activate to activate.`
      : `${routineTypeUpper} routine added to transformation ${trfnUpper}. ` +
        `ABAP method ${classNameM}->${methodName} generated. Call bw_activate to activate.`,
    routine_type: routineTypeUpper,
    class_name: classNameM,
    method_name: methodName,
    lock_handle: lockHandle,
    transformation_name: trfnUpper,
    object_type: 'trfn',
  });
}

// ── bwSetTransformationExpertRoutine ─────────────────────────────────────────

/**
 * Replace one `METHOD <name> ... ENDMETHOD.` block inside the full class source.
 * A function replacement is used so `$` sequences in the new block are inserted
 * verbatim (never interpreted as regex back-references).
 */
function replaceMethodBlock(fullSource: string, methodName: string, newBlock: string): string {
  const re = new RegExp(`METHOD\\s+${methodName}\\b[\\s\\S]*?ENDMETHOD\\s*\\.`, 'i');
  if (!re.test(fullSource)) {
    throw new Error(
      `Method ${methodName} not found in the generated class source — cannot splice the routine body.`,
    );
  }
  return fullSource.replace(re, () => newBlock.trim());
}

/**
 * bwSetTransformationExpertRoutine — write the code of a Start / End / Expert routine
 * into the transformation's MASTER definition so it survives TLOGO regeneration
 * (full `bw_activate(trfn)` and transport import), not just into the generated
 * `/BIC/<uuid>_M` class.
 *
 * Why this exists (root cause):
 *   Writing only the generated `/BIC/<uuid>_M` class (abap-adt WriteSource) and
 *   activating the CLASS updates the generated class body only. On the next TLOGO
 *   activation of the transformation (`bw_activate` trfn) or a transport import, BW
 *   regenerates the class from the transformation's own routine metadata and the
 *   edit is lost ("return type mismatch … OUTTAB[…]"). The Eclipse transformation
 *   editor avoids this by, after writing the class, re-saving the transformation
 *   master and running a TLOGO activation via the BW modeling endpoints — which
 *   re-registers the current class routine as the authoritative source. This tool
 *   replicates that exact wire sequence.
 *
 * Sequence (mirrors the Eclipse ADT trace):
 *   1. GET trfn master → derive classNameM + method name, verify the routine exists.
 *   2. (if `source` given) splice the `METHOD … ENDMETHOD.` block into the current
 *      class source, then ADT lock → PUT source → activate class → unlock.
 *   3. GET trfn master again → fresh timestamp.
 *   4. Lock trfn → PUT the master back (round-trip, corrNr=transport, lockHandle).
 *   5. Priming GET, then TLOGO-activate the trfn (POST /sap/bw/modeling/activation).
 *   6. Unlock trfn.
 *
 * `source` is the complete `METHOD <NAME> BY DATABASE PROCEDURE … ENDMETHOD.` block
 * for AMDP (HANA) routines, or the complete `METHOD <NAME> … ENDMETHOD.` block for
 * ABAP routines — the same block shape abap-adt WriteSource(method=…) expects. When
 * `source` is omitted the class is left untouched and only the master re-save +
 * activation runs (use this to "commit" a routine that was already edited on the
 * generated class into the transportable master).
 */
export async function bwSetTransformationExpertRoutine(
  client: BwClient,
  transformationName: string,
  source?: string,
  routineType: 'start' | 'end' | 'expert' = 'expert',
  transport?: string,
  className?: string,
  methodName?: string,
): Promise<string> {
  const trfnLower = transformationName.toLowerCase();
  const trfnUpper = transformationName.toUpperCase();
  const routineTypeUpper = routineType.toUpperCase();

  // Step 1: GET master — derive class/method and verify the routine rule exists.
  const { body: xml0 } = await freshReadInactive(trfnLower);

  // Derive the generated class name (_A → _M), unless the caller overrides it.
  let classNameM = className;
  if (!classNameM) {
    const mMatch = xml0.match(/\bclassNameM="([^"]+)"/);
    const aMatch = xml0.match(/\bclassNameA="([^"]+)"/);
    if (mMatch) {
      classNameM = mMatch[1];
    } else if (aMatch) {
      classNameM = aMatch[1].replace(/_A$/, '_M');
    } else {
      classNameM = `/BIC/${trfnUpper.slice(-20)}_M`;
    }
  }
  const method = (methodName ?? `GLOBAL_${routineTypeUpper}`).toUpperCase();

  // Guard: the routine must already exist in the transformation. This tool persists an
  // existing routine's code — it does not create the routine rule/stub. Skip the guard
  // when the caller passes an explicit method name (e.g. a field routine).
  if (!methodName) {
    const routineExists = new RegExp(`\\broutinetype="${routineTypeUpper}"`).test(xml0);
    if (!routineExists) {
      return JSON.stringify({
        success: false,
        message:
          `Transformation ${trfnUpper} has no ${routineTypeUpper} routine yet. ` +
          `Create it first with bw_set_transformation_routine (routine_type="${routineType}"), ` +
          `then call bw_set_transformation_expert_routine to set its code.`,
      });
    }
  }

  // Step 2: Write the routine body into the generated _M class (optional).
  if (source) {
    if (!/METHOD\b/i.test(source) || !/ENDMETHOD\s*\./i.test(source)) {
      return JSON.stringify({
        success: false,
        message:
          `source must be a complete "METHOD ${method} … ENDMETHOD." block ` +
          `(the same block shape abap-adt WriteSource(method=…) expects).`,
      });
    }
    const classEncoded = encodeURIComponent(classNameM).toLowerCase();
    const currentSource = await client.adtGetSource(classEncoded);
    if (currentSource === null) {
      return JSON.stringify({
        success: false,
        message:
          `Generated class ${classNameM} does not exist yet. Activate the transformation once ` +
          `(bw_activate trfn) so BW generates the class, then set the routine code.`,
      });
    }
    const splicedSource = replaceMethodBlock(currentSource, method, source);

    // Write the inactive version under an ADT lock, then UNLOCK before activating.
    // Eclipse does exactly this (lock → PUT source → unlock → activate); activating while
    // still holding the lock is rejected with HTTP 403 "Benutzer … bearbeitet bereits …".
    const adtLock = await client.adtLockClass(classEncoded);
    try {
      await client.adtPutSource(classEncoded, adtLock, splicedSource);
    } finally {
      await client.adtUnlockClass(classEncoded, adtLock).catch(() => {/* ignore */});
    }
    await client.adtActivate(classEncoded, classNameM);
  }

  // Step 3: Re-read the master to capture a fresh timestamp (the class edit does not bump
  //         the trfn timestamp, but re-reading avoids any optimistic-locking mismatch).
  const { body: xml1, headers: h1 } = await freshReadInactive(trfnLower);
  const timestamp = h1['timestamp'] ?? h1['TIMESTAMP'] ?? '';

  // Step 4: Lock → PUT the master back unchanged. This is the step the class-only path
  //         skips: it re-registers the current routine source into the transformation's
  //         transportable metadata so a later TLOGO regeneration keeps it.
  const lockHandle = await client.lock('trfn', trfnLower);
  let activationXml: string;
  try {
    await client.put('trfn', trfnLower, lockHandle, xml1, timestamp, transport);

    // Step 5: Priming GET (mirrors Eclipse), then TLOGO-activate with the same lockHandle.
    await client
      .get(`/sap/bw/modeling/trfn/${bwSeg(trfnLower)}/m?forceCacheUpdate=true`, trfnAccept())
      .catch(() => {/* priming only */});
    activationXml = await client.activate('trfn', trfnLower, lockHandle);
  } catch (err) {
    await client.unlock('trfn', trfnLower).catch(() => {/* ignore */});
    throw err;
  }

  // Step 6: Unlock.
  await client.unlock('trfn', trfnLower).catch(() => {/* ignore */});

  const messages = parseActivationMessages(activationXml);
  const deactivatedDtps = parseDtpsDeactivated(activationXml);
  const hasError =
    activationXml.includes('messageType="Error"') || activationXml.includes("messageType='Error'");

  const result: Record<string, unknown> = {
    success: !hasError,
    message: hasError
      ? `Routine ${classNameM}->${method} written, but TLOGO activation of ${trfnUpper} reported an error. ` +
        `Review the messages below.`
      : `${routineTypeUpper} routine ${classNameM}->${method} persisted into the master of ${trfnUpper} ` +
        `and the transformation was activated. The code now survives a full bw_activate(trfn) and transport import.`,
    transformation_name: trfnUpper,
    class_name: classNameM,
    method_name: method,
    object_type: 'trfn',
    class_source_written: Boolean(source),
    messages,
    amdp_note:
      'AMDP SQLSCRIPT allows 7-bit ASCII only — do not use umlauts (ä/ö/ü) or symbols like <= ' +
      'in SQLSCRIPT code or comments; they cause a syntax error.',
  };
  if (deactivatedDtps.length > 0) {
    result['dtps_deactivated_by_impact_analysis'] = deactivatedDtps;
    result['next_step'] =
      `Re-activate the deactivated DTPs using bw_activate with object_type="dtpa" and lock_handle="".`;
  }
  return JSON.stringify(result, null, 2);
}

// ── bwSetTransformationRoutineFields ─────────────────────────────────────────

/**
 * bwSetTransformationRoutineFields — edit the target fields the global END
 * routine writes ("Felder setzen" in SAP GUI).
 *
 * Precondition: the transformation must already have an END routine
 * (group id="0" with routinetype="END"). If not, return an error pointing to
 * bwSetTransformationRoutine.
 *
 * Flow:
 * 1. GET XML + timestamp header.
 * 2. Locate the END rule by regex (captures opening tag / target block / step / closing tag).
 * 3. Read all target fields from <target><segment> in document order.
 * 4. Resolve selected set from fields or exclude_fields; validate names and non-empty result.
 * 5. Rebuild <target> block (sequential id from 1, original segment casing).
 * 6. Replace only the target block; keep opening tag, <step/>, and </rule>.
 * 7. Lock with caller's client, PUT with a separate createClientFromEnv() client.
 *    Do NOT activate. Return lock_handle.
 */
export async function bwSetTransformationRoutineFields(
  client: BwClient,
  transformationName: string,
  fields?: string[],
  excludeFields?: string[],
  transport?: string
): Promise<string> {
  if (!fields && !excludeFields) {
    return JSON.stringify({
      success: false,
      message: 'Provide exactly one of "fields" or "exclude_fields".',
    });
  }
  if (fields && excludeFields) {
    return JSON.stringify({
      success: false,
      message: 'Provide exactly one of "fields" or "exclude_fields", not both.',
    });
  }

  const trfnLower = transformationName.toLowerCase();
  const trfnUpper = transformationName.toUpperCase();

  const { body: xml, headers } = await freshReadInactive(trfnLower);
  const timestamp = headers['timestamp'] ?? '';

  // Capture: (1) opening rule tag, (2) old target block, (3) self-closing step, (4) whitespace + </rule>
  const endRuleRegex = /(<rule\b[^>]*\broutinetype="END"[^>]*>)([\s\S]*?)(<step\b[\s\S]*?\/>)(\s*<\/rule>)/;
  const endRuleMatch = xml.match(endRuleRegex);
  if (!endRuleMatch) {
    return JSON.stringify({
      success: false,
      message:
        `Transformation ${trfnUpper} has no END routine. ` +
        `Use bw_set_transformation_routine to create one first.`,
    });
  }

  // Read all target fields from the segment in document order
  const tgtSegMatch = xml.match(/<target\b[^>]*>[\s\S]*?<segment[^>]*>([\s\S]*?)<\/segment>/);
  if (!tgtSegMatch) {
    throw new Error(`Could not extract target segment from transformation ${trfnUpper}.`);
  }
  const allTargetFields: string[] = [];
  const elemRegex = /<element\b[^>]*\bname="([^"]+)"[^>]*/g;
  let em: RegExpExecArray | null;
  while ((em = elemRegex.exec(tgtSegMatch[1])) !== null) {
    allTargetFields.push(em[1]);
  }

  // Case-insensitive lookup map to original casing
  const fieldByLower = new Map<string, string>();
  for (const f of allTargetFields) {
    fieldByLower.set(f.toLowerCase(), f);
  }

  let selectedFields: string[];
  if (fields) {
    const unknown = fields.filter(f => !fieldByLower.has(f.toLowerCase()));
    if (unknown.length > 0) {
      return JSON.stringify({
        success: false,
        message: `Unknown target fields: ${unknown.join(', ')}. Must be fields in the target segment.`,
      });
    }
    selectedFields = fields.map(f => fieldByLower.get(f.toLowerCase())!);
  } else {
    const excludeSet = new Set((excludeFields ?? []).map(f => f.toLowerCase()));
    const unknown = (excludeFields ?? []).filter(f => !fieldByLower.has(f.toLowerCase()));
    if (unknown.length > 0) {
      return JSON.stringify({
        success: false,
        message: `Unknown exclude_fields: ${unknown.join(', ')}. Must be fields in the target segment.`,
      });
    }
    selectedFields = allTargetFields.filter(f => !excludeSet.has(f.toLowerCase()));
  }

  if (selectedFields.length === 0) {
    return JSON.stringify({
      success: false,
      message: 'The resolved field set is empty. The END routine must write at least one field.',
    });
  }

  // Rebuild <target> block with sequential id from 1, using original segment casing in elementRef
  const newTargetBlock = selectedFields
    .map((f, i) => `<target id="${i + 1}"><elementRef>#///target/segment1/${f}</elementRef></target>`)
    .join('');

  const newEndRule = endRuleMatch[1] + newTargetBlock + endRuleMatch[3] + endRuleMatch[4];
  const updatedXml = xml.replace(endRuleMatch[0], newEndRule);
  if (updatedXml === xml) {
    throw new Error('XML unchanged after target-field replacement — replacement failed.');
  }

  // Lock with caller's client, PUT with a separate client (session isolation)
  const lockHandle = await client.lock('trfn', trfnLower);
  const putClient = createClientFromEnv();
  try {
    await putClient.put('trfn', trfnLower, lockHandle, updatedXml, timestamp, transport);
  } catch (err) {
    await client.unlock('trfn', trfnLower).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message:
      `END routine field list updated for transformation ${trfnUpper}. ` +
      `${selectedFields.length} of ${allTargetFields.length} target fields selected. ` +
      `Call bw_activate to activate.`,
    selected_fields: selectedFields,
    selected_count: selectedFields.length,
    total_target_fields: allTargetFields.length,
    lock_handle: lockHandle,
    transformation_name: trfnUpper,
    object_type: 'trfn',
  });
}

// ── bwDeleteTransformationRoutine ────────────────────────────────────────────

/**
 * bw_delete_transformation_routine — remove a Start, End, or Expert routine.
 *
 * Locates the global routine group that contains the <rule routinetype="START|END|EXPERT">
 * (its id is not fixed — a sole expert routine group is persisted as id="1", not id="0") and
 * removes that rule. If no rules remain in the group afterwards, removes the entire group.
 * Single PUT (session-isolated). Returns lock_handle for bw_activate.
 */
export async function bwDeleteTransformationRoutine(
  client: BwClient,
  transformationName: string,
  routineType: 'start' | 'end' | 'expert'
): Promise<string> {
  const trfnUpper = transformationName.toUpperCase();
  const trfnLower = transformationName.toLowerCase();
  const routineTypeUpper = routineType.toUpperCase();

  // Step 1: GET current XML
  const { body: xml, headers } = await freshReadInactive(trfnLower);
  const timestamp = headers['timestamp'] ?? '';

  // Step 2: Locate the group that contains the rule with the matching routinetype.
  // The routine group id is not fixed — a sole expert routine group is persisted as id="1",
  // not id="0" — so scan all groups rather than assuming id="0".
  const ruleRegex = new RegExp(
    `<rule\\b[^>]*\\broutinetype="${routineTypeUpper}"[^>]*>[\\s\\S]*?<\\/rule>`,
    'i'
  );
  const groupRegex = /<group\b[^>]*>[\s\S]*?<\/group>/g;
  let targetGroup: string | null = null;
  let gm: RegExpExecArray | null;
  while ((gm = groupRegex.exec(xml)) !== null) {
    if (ruleRegex.test(gm[0])) {
      targetGroup = gm[0];
      break;
    }
  }
  if (!targetGroup) {
    return JSON.stringify({
      success: false,
      message: `No ${routineTypeUpper} routine found in transformation ${trfnUpper}.`,
    });
  }

  // Step 3: Remove the rule; if the group has no remaining rules, remove the whole group.
  const newGroup = targetGroup.replace(ruleRegex, '');
  const hasRemainingRules = /<rule\b/.test(newGroup.replace(/^<group\b[^>]*>/, ''));
  const updatedXml = hasRemainingRules
    ? xml.replace(targetGroup, newGroup)
    : xml.replace(targetGroup, '');

  if (updatedXml === xml) {
    throw new Error('XML unchanged after routine removal — replacement failed.');
  }

  // Step 6: Lock → PUT (session-isolated)
  const lockHandle = await client.lock('trfn', trfnLower);
  const putClient = createClientFromEnv();
  try {
    await putClient.put('trfn', trfnLower, lockHandle, updatedXml, timestamp);
  } catch (err) {
    await client.unlock('trfn', trfnLower).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message:
      `${routineTypeUpper} routine removed from transformation ${trfnUpper}.` +
      (!hasRemainingRules ? ' Routine group removed (no remaining rules).' : '') +
      ' Call bw_activate to activate.',
    routine_type: routineTypeUpper,
    group_removed: !hasRemainingRules,
    lock_handle: lockHandle,
    transformation_name: trfnUpper,
    object_type: 'trfn',
  });
}

// ── bwSetTransformationRuntime ────────────────────────────────────────────────

/**
 * Read the HANARuntime attribute from the ACTIVE version of a Transformation.
 * Returns 'true' | 'false', or null when there is no active version yet
 * (never activated) or the attribute is absent. The active version is the
 * authoritative state — the inactive (/m) version can carry an unactivated edit.
 *
 * MUST read through a fresh session with forceCacheUpdate=true. A session that
 * has previously read (or locked) the object keeps serving its stale model
 * buffer even with forceCacheUpdate — verified live: after a persisted switch,
 * the switching session still reported the OLD value while a fresh session saw
 * the new one. Reading through the shared client produced false-negative
 * "runtime_not_persisted" errors AND wrong "already_set" decisions.
 */
async function readActiveHanaRuntime(trfnLower: string): Promise<'true' | 'false' | null> {
  try {
    const freshReader = createClientFromEnv();
    const { body } = await freshReader.get(
      `/sap/bw/modeling/trfn/${bwSeg(trfnLower)}/a?forceCacheUpdate=true`,
      trfnAccept()
    );
    const m = body.match(/\bHANARuntime="(true|false)"/);
    return (m?.[1] as 'true' | 'false' | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Lock → GET /m → flip HANARuntime → PUT → activate, as one attempt.
 * Returns the parsed activation result. Releases the lock on any failure
 * before activation, and delegates the unlock-after-activate to bwActivate.
 *
 * The whole attempt runs in a FRESH session: the shared long-lived client can
 * hold a stale server-side model buffer for this object (from an earlier read
 * in another tool call), and a stale GET /m here would silently resurrect old
 * attribute values (including HANARuntime itself) on the PUT — this is how
 * previously-persisted runtime switches got reverted. forceCacheUpdate on the
 * GET additionally syncs the server model cache from the DB, as Eclipse does.
 */
async function attemptRuntimeSwitch(
  trfnUpper: string,
  trfnLower: string,
  targetValue: 'true' | 'false',
  transport?: string
): Promise<Record<string, unknown>> {
  const client = createClientFromEnv();
  const lockHandle = await client.lock('trfn', trfnLower);

  try {
    const { body: xml, headers } = await client.get(
      `/sap/bw/modeling/trfn/${bwSeg(trfnLower)}/m?forceCacheUpdate=true`,
      trfnAccept()
    );
    const timestamp = headers['timestamp'] ?? '';

    if (!/\bHANARuntime="(true|false)"/.test(xml)) {
      throw new Error('HANARuntime attribute not found in transformation XML — cannot switch runtime.');
    }
    // Force the target value onto the inactive version. The string may already equal
    // the target when the inactive (/m) version has drifted from the active (/a) one;
    // that is exactly the case we must still PUT + activate to bring the active version
    // in line, so an unchanged string is not an error here.
    const updatedXml = xml.replace(
      /\bHANARuntime="(true|false)"/,
      `HANARuntime="${targetValue}"`
    );

    await client.put('trfn', trfnLower, lockHandle, updatedXml, timestamp, transport);
  } catch (err) {
    await client.unlock('trfn', trfnLower).catch(() => {/* ignore */});
    throw err;
  }

  // bwActivate uses a fresh session, primes the HANA cache, retries on the known
  // "rule deleted" pattern, and unlocks afterwards. If it throws (network/transport),
  // release the lock so it does not linger.
  let activationRaw: string;
  try {
    activationRaw = await bwActivate(client, 'trfn', trfnUpper, lockHandle, transport);
  } catch (err) {
    await client.unlock('trfn', trfnLower).catch(() => {/* ignore */});
    throw err;
  }

  try {
    return JSON.parse(activationRaw) as Record<string, unknown>;
  } catch {
    return { raw: activationRaw };
  }
}

/**
 * bw_set_transformation_runtime — switch a Transformation between HANA and ABAP
 * runtime, activate it, and verify the change landed in the ACTIVE version.
 *
 * Only the HANARuntime attribute on the root <trfn:transformation> element is
 * changed; all rules and segments are passed through unchanged.
 *
 * The current runtime is read from the active version (/a), so "already set" is
 * decided against the authoritative state — not against an unactivated /m edit.
 *
 * The switch is not complete until activation, so the tool activates internally
 * and then re-reads the active version. Success is returned ONLY when the active
 * version actually reports the target HANARuntime. If the server silently keeps
 * the old runtime (e.g. it refuses HANA for this transformation), an error is
 * returned instead of a false-positive success. One retry covers a transient
 * non-persist. No separate bw_activate call is required.
 */
export async function bwSetTransformationRuntime(
  _client: BwClient,
  transformationName: string,
  runtime: 'hana' | 'abap',
  transport?: string
): Promise<string> {
  const trfnUpper = transformationName.toUpperCase();
  const trfnLower = transformationName.toLowerCase();
  const targetValue: 'true' | 'false' = runtime.toLowerCase() === 'hana' ? 'true' : 'false';

  // Step 1: Decide against the ACTIVE version — the authoritative runtime state.
  const activeValue = await readActiveHanaRuntime(trfnLower);
  if (activeValue === targetValue) {
    return JSON.stringify({
      success: true,
      already_set: true,
      message:
        `Transformation ${trfnUpper} already runs on ${runtime.toUpperCase()} ` +
        `(active version HANARuntime="${targetValue}"). No change needed.`,
      runtime,
      transformation_name: trfnUpper,
      object_type: 'trfn',
    });
  }

  // Step 2: Switch + activate, then verify against the active version. Retry once
  // to cover a transient non-persist; give up with an error if it still won't stick.
  const MAX_ATTEMPTS = 2;
  let lastActivation: Record<string, unknown> = {};
  let verified: 'true' | 'false' | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    lastActivation = await attemptRuntimeSwitch(trfnUpper, trfnLower, targetValue, transport);
    verified = await readActiveHanaRuntime(trfnLower);
    if (verified === targetValue) break;
  }

  // Step 3: No false-positive — report failure if the active version did not change.
  if (verified !== targetValue) {
    return JSON.stringify({
      success: false,
      error: 'runtime_not_persisted',
      message:
        `Runtime switch to "${runtime}" did NOT persist. After activation the active version reports ` +
        `HANARuntime="${verified ?? 'unknown'}" (expected "${targetValue}"). The BW server may refuse ` +
        `${runtime.toUpperCase()} runtime for this transformation.`,
      runtime,
      expected_hana_runtime: targetValue,
      active_hana_runtime: verified,
      activation_messages: lastActivation['messages'],
      transformation_name: trfnUpper,
      object_type: 'trfn',
    });
  }

  // A runtime switch can deactivate dependent DTPs (impact analysis) — surface them so the
  // caller re-activates them; bwActivate already parses this from the activation response.
  const deactivatedDtps = lastActivation['dtps_deactivated_by_impact_analysis'];

  return JSON.stringify({
    success: true,
    activated: true,
    verified: true,
    message:
      `Transformation ${trfnUpper} switched to "${runtime}" runtime and activated ` +
      `(active version HANARuntime="${targetValue}", verified). No separate bw_activate needed.`,
    runtime,
    transformation_name: trfnUpper,
    object_type: 'trfn',
    activation_messages: lastActivation['messages'],
    ...(deactivatedDtps ? {
      dtps_deactivated_by_impact_analysis: deactivatedDtps,
      next_step: 'Re-activate the deactivated DTP(s) with bw_activate (object_type="dtpa", lock_handle="").',
    } : {}),
  });
}
