import { BwClient, freshRead } from '../bw-client.js';

// ── Write path — UNVERIFIED ─────────────────────────────────────────────────
//
// Everything below bwGetCompositeProvider (create / update_settings / add_input /
// remove_input / update_mapping / update_join) is inferred from the element and
// attribute names that bwGetCompositeProvider's regexes already prove exist on
// the READ side (Composite:compositeView, viewNode, input/alias, mapping/
// targetName/value, join/leftElementName/rightElementName, endUserTexts, etc.).
// Unlike adso.ts — whose write logic was built from a recorded BWMT PUT payload —
// there is no captured trace for HCPR writes, so things a read-only parser can't
// reveal are best-effort guesses:
//   - the exact xmlns URI for the "Composite" namespace prefix
//   - the regular (non-constant) <mapping> xsi:type and its source-field attribute name
//   - whether name/alias default relationships hold as assumed
// Verify against a real BW/4HANA system (capture the Eclipse/BWMT traffic for a
// create + add-input + join edit) and adjust the fragment builders below before
// relying on this in production.

const HCPR_ACCEPT = [
  'application/vnd.sap.bw.modeling.hcpr-v1_0_0+xml',
  'application/vnd.sap.bw.modeling.hcpr-v1_4_0+xml',
  'application/vnd.sap.bw.modeling.hcpr-v1_7_0+xml',
  'application/vnd.sap.bw.modeling.hcpr-v1_8_0+xml',
  'application/vnd.sap.bw.modeling.hcpr-v1_9_0+xml',
  'application/vnd.sap.bw.modeling.hcpr-v1_10_0+xml',
  'application/vnd.sap.bw.modeling.hcpr-v1_11_0+xml',
  'application/vnd.sap.bw.modeling.hcpr-v1_12_0+xml',
  'application/vnd.sap.bw.modeling.hcpr-v1_13_0+xml',
  'application/vnd.sap.bw.modeling.hcpr-v1_14_0+xml',
  'application/vnd.sap.bw.modeling.hcpr-v1_15_0+xml',
  'application/vnd.sap.bw.modeling.hcpr-v9_99_9+xml',
].join(',');

function attr(str: string, key: string): string {
  return str.match(new RegExp(`\\b${key}="([^"]*)"`)) ?.[1] ?? '';
}

export async function bwGetCompositeProvider(
  client: BwClient,
  compositeProviderName: string
): Promise<string> {
  const path = `/sap/bw/modeling/hcpr/${compositeProviderName.toLowerCase()}/m`;
  const result = await client.get(path, HCPR_ACCEPT);

  const xml = result.body;
  const objectStatus = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';
  const timestamp = result.headers['timestamp'] ?? result.headers['TIMESTAMP'] ?? '';

  // Root element attributes
  const rootAttrs = xml.match(/<Composite:compositeView\b([\s\S]*?)>/)?.[1] ?? '';
  const cpName = attr(rootAttrs, 'name');
  const temporalJoinFlag = attr(rootAttrs, 'temporalJoin');
  const stackableFlag = attr(rootAttrs, 'stackable');
  const defaultNode = attr(rootAttrs, 'defaultNode');
  const aggregationBehaviour = attr(rootAttrs, 'aggregationBehaviour');

  // Description
  const description = xml.match(/<endUserTexts\b[^>]*\blabel="([^"]*)"/)?.[1] ?? '';

  // tlogoProperties block (opening tag only — attributes span multiple lines)
  const tlogoAttrs = xml.match(/<tlogoProperties\b([\s\S]*?)>/)?.[1] ?? '';
  const responsible = attr(tlogoAttrs, 'adtcore:responsible');
  const changedAt = attr(tlogoAttrs, 'adtcore:changedAt');
  const changedBy = attr(tlogoAttrs, 'adtcore:changedBy');
  const infoArea = xml.match(/<infoArea>([^<]+)<\/infoArea>/)?.[1] ?? '';
  const packageName = xml.match(/adtcore:packageRef[^>]*adtcore:name="([^"]+)"/)?.[1] ?? '';

  // viewNode
  const viewNodeMatch = xml.match(/<viewNode\b([\s\S]*?)>([\s\S]*?)<\/viewNode>/);
  const viewNodeAttrs = viewNodeMatch?.[1] ?? '';
  const viewNodeBody = viewNodeMatch?.[2] ?? '';
  const viewNodeName = attr(viewNodeAttrs, 'name');

  // Strip namespace prefix and normalise type name
  const rawViewType = attr(viewNodeAttrs, 'xsi:type');
  const localViewType = rawViewType.split(':').pop() ?? rawViewType;
  const viewType = localViewType === 'JoinNode' ? 'Join' : localViewType === 'Union' ? 'Union' : localViewType;

  // Fields
  const fields: Array<Record<string, unknown>> = [];
  const elemRegex = /<element\b([\s\S]*?)(?:\/>|>([\s\S]*?)<\/element>)/g;
  let em: RegExpExecArray | null;
  while ((em = elemRegex.exec(viewNodeBody)) !== null) {
    const elemAttrs = em[1];
    const name = attr(elemAttrs, 'name');
    if (!name) continue;
    const infoObjectName = attr(elemAttrs, 'infoObjectName');
    const dimension = attr(elemAttrs, 'dimension');
    const dimName = dimension.match(/#\/\/\/([^§]*)§/)?.[1] ?? dimension;
    const isKeyFigure = dimName.includes('__KEYFIGURES');
    fields.push({
      name,
      ...(infoObjectName ? { info_object_name: infoObjectName } : {}),
      dimension: dimName,
      is_key_figure: isKeyFigure,
    });
  }

  const totalFields = fields.length;
  const keyFigureCount = fields.filter(f => f['is_key_figure']).length;
  const characteristicCount = totalFields - keyFigureCount;

  // Inputs (source providers)
  const inputs: Array<Record<string, unknown>> = [];
  const inputRegex = /<input\b([\s\S]*?)>([\s\S]*?)<\/input>/g;
  let im: RegExpExecArray | null;
  while ((im = inputRegex.exec(viewNodeBody)) !== null) {
    const inputAttrs = im[1];
    const inputBody = im[2];
    const name = attr(inputAttrs, 'name');
    if (!name) continue;
    const alias = attr(inputAttrs, 'alias');
    const lastModified = attr(inputAttrs, 'lastModified');
    const providerType = alias.split('.')[1] ?? '';
    const allMappings = [...inputBody.matchAll(/<mapping\b[^>]*/g)];
    const constantMappings = allMappings
      .filter(m => m[0].includes('ConstantElementMapping'))
      .map(m => ({
        target: attr(m[0], 'targetName'),
        value: attr(m[0], 'value'),
      }));
    inputs.push({
      name,
      alias,
      ...(lastModified ? { last_modified: lastModified } : {}),
      provider_type: providerType,
      mapping_count: allMappings.length,
      regular_mapping_count: allMappings.length - constantMappings.length,
      constant_mappings: constantMappings,
    });
  }

  // Build result
  const output: Record<string, unknown> = {
    object_type: 'hcpr',
    name: cpName.toUpperCase(),
    description,
    object_status: objectStatus,
    timestamp,
    temporal_join: temporalJoinFlag === 'true',
    stackable: stackableFlag === 'true',
    aggregation_behaviour: aggregationBehaviour,
    default_node: defaultNode,
    info_area: infoArea,
    package: packageName,
    responsible_user: responsible,
    last_changed_at: changedAt,
    last_changed_by: changedBy,
    view_node: { name: viewNodeName, type: viewType },
    inputs,
    fields: {
      total: totalFields,
      characteristic_count: characteristicCount,
      key_figure_count: keyFigureCount,
      list: fields,
    },
  };

  // Join condition (Join CPs only)
  if (viewType === 'Join') {
    const joinMatch = viewNodeBody.match(/<join\b([\s\S]*?)>([\s\S]*?)<\/join>/);
    if (joinMatch) {
      const joinAttrs = joinMatch[1];
      const joinBody = joinMatch[2];
      // "#///J1/J1.IOBJ.2" → last non-empty path segment = alias
      const extractAlias = (ref: string) => ref.split('/').filter(Boolean).pop() ?? '';
      const leftKeys = [...joinBody.matchAll(/<leftElementName>([^<]+)<\/leftElementName>/g)].map(m => m[1]);
      const rightKeys = [...joinBody.matchAll(/<rightElementName>([^<]+)<\/rightElementName>/g)].map(m => m[1]);
      output['join_condition'] = {
        join_type: attr(joinAttrs, 'joinType'),
        cardinality: attr(joinAttrs, 'cardinality'),
        left_input_alias: extractAlias(attr(joinAttrs, 'leftInput')),
        right_input_alias: extractAlias(attr(joinAttrs, 'rightInput')),
        left_key_fields: leftKeys,
        right_key_fields: rightKeys,
      };
    }
  }

  // Temporal join details
  if (temporalJoinFlag === 'true') {
    const extractAlias = (ref: string) => ref.split('/').filter(Boolean).pop() ?? '';
    const aqRef = xml.match(/<temporalJoinProvider\b[^>]*type="AQ"[^>]*input="([^"]*)"/)?.[1] ?? '';
    const cqRef = xml.match(/<temporalJoinProvider\b[^>]*type="CQ"[^>]*input="([^"]*)"/)?.[1] ?? '';

    const operands = [...xml.matchAll(/<temporalOperand\b([\s\S]*?)(?:\/>|>)/g)].map(m => {
      const opAttrs = m[1];
      const temporalArg = attr(opAttrs, 'temporalArgument');
      const field = temporalArg.split('/').filter(Boolean).pop() ?? temporalArg;
      return {
        type: attr(opAttrs, 'type'),
        field,
        input_alias: extractAlias(attr(opAttrs, 'input')),
      };
    });

    output['temporal_join_details'] = {
      anchor_query_alias: extractAlias(aqRef),
      characteristic_query_alias: extractAlias(cqRef),
      operands,
    };
  }

  return JSON.stringify(output, null, 2);
}

// ── Shared helpers ───────────────────────────────────────────────────────────

const HCPR_XMLNS =
  'xmlns:Composite="http://www.sap.com/bw/modeling/hcpr.ecore" ' +
  'xmlns:adtcore="http://www.sap.com/adt/core" ' +
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';

/** Root-tag boolean/string attribute setter — same approach as adso.ts's setRootAttr. */
function setCompositeViewAttr(xml: string, attrName: string, value: string): string {
  const existing = new RegExp(`\\b${attrName}="[^"]*"`);
  if (existing.test(xml)) {
    return xml.replace(existing, `${attrName}="${value}"`);
  }
  return xml.replace(/(<Composite:compositeView\b(?:[^>]|\n)*?)(\s*>)/, `$1 ${attrName}="${value}"$2`);
}

function setLabel(xml: string, label: string): string {
  const endUserTextsTag = `<endUserTexts label="${label}"/>`;
  if (/<endUserTexts[^>]*\/>/.test(xml)) {
    return xml.replace(/<endUserTexts[^>]*\/>/, endUserTextsTag);
  }
  return xml.replace(/(<tlogoProperties)/, `${endUserTextsTag}\n  $1`);
}

function getViewNodeName(xml: string): string {
  return xml.match(/<viewNode\b[^>]*\bname="([^"]*)"/)?.[1] ?? '';
}

/** Insert `insertXml` right before the earliest of the given anchor strings; falls back to before fallbackClose. */
function injectBeforeAnchor(xml: string, insertXml: string, anchors: string[], fallbackClose: string): string {
  const idxs = anchors.map((a) => xml.indexOf(a)).filter((i) => i !== -1);
  if (idxs.length > 0) {
    const idx = Math.min(...idxs);
    return xml.substring(0, idx) + insertXml + '\n  ' + xml.substring(idx);
  }
  return xml.replace(fallbackClose, insertXml + '\n' + fallbackClose);
}

const HCPR_PATH = (name: string) => `/sap/bw/modeling/hcpr/${name.toLowerCase()}/m`;

// ── bw_update_composite_provider action "update_settings" ────────────────────

export interface CompositeProviderSettings {
  label?: string;
  stackable?: boolean;
  defaultNode?: string;
  aggregationBehaviour?: string;
  transport?: string;
}

/**
 * bw_update_composite_provider action "update_settings" — edit root-level attributes.
 * Workflow: GET full XML → lock → apply changes → PUT.
 * Returns the lock handle so the caller can invoke bw_activate next.
 */
export async function bwUpdateCompositeProviderSettings(
  client: BwClient,
  compositeProviderName: string,
  settings: CompositeProviderSettings
): Promise<string> {
  const cpUpper = compositeProviderName.toUpperCase();
  const cpResult = await freshRead(HCPR_PATH(compositeProviderName), HCPR_ACCEPT);
  const timestamp = cpResult.headers['timestamp'] ?? cpResult.headers['TIMESTAMP'];
  let xml = cpResult.body;

  if (settings.stackable !== undefined) xml = setCompositeViewAttr(xml, 'stackable', String(settings.stackable));
  if (settings.defaultNode !== undefined) xml = setCompositeViewAttr(xml, 'defaultNode', settings.defaultNode);
  if (settings.aggregationBehaviour !== undefined) {
    xml = setCompositeViewAttr(xml, 'aggregationBehaviour', settings.aggregationBehaviour);
  }
  if (settings.label !== undefined) xml = setLabel(xml, settings.label);

  const lockHandle = await client.lock('hcpr', compositeProviderName);
  try {
    await client.put('hcpr', compositeProviderName, lockHandle, xml, timestamp, settings.transport);
  } catch (err) {
    await client.unlock('hcpr', compositeProviderName).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message: `CompositeProvider ${cpUpper} settings updated. Call bw_activate to activate.`,
    lock_handle: lockHandle,
    composite_provider_name: cpUpper,
    object_type: 'hcpr',
    applied: settings,
  });
}

// ── bw_create_composite_provider ──────────────────────────────────────────────

/**
 * bw_create_composite_provider — create a new CompositeProvider shell.
 * action "empty" (default): minimal shell with an empty Join or Union view node.
 * action "from_template": proposes structure from an existing HCPR (pass templateName).
 * Workflow: Lock (CREA) → POST minimal XML → Unlock.
 * After creation the CompositeProvider is inactive — call bw_activate to activate it.
 */
export async function bwCreateCompositeProvider(
  client: BwClient,
  compositeProviderName: string,
  label: string,
  infoArea: string,
  action: 'empty' | 'from_template' = 'empty',
  viewType: 'Join' | 'Union' = 'Join',
  templateName?: string,
  pkg: string = '$TMP',
  stackable: boolean = false
): Promise<string> {
  const nameUpper = compositeProviderName.toUpperCase();
  const infoAreaUpper = infoArea.toUpperCase();
  const language = process.env.BW_LANGUAGE ?? 'DE';
  const xsiType = viewType === 'Union' ? 'Composite:Union' : 'Composite:JoinNode';

  const lockHandle = await client.lock('hcpr', compositeProviderName, {
    'activity_context': 'CREA',
    'parent_name': infoAreaUpper,
    'parent_type': 'AREA',
  });

  const templateElement =
    action === 'from_template' && templateName
      ? `\n  <template objectName="${templateName.toUpperCase()}" tlogo="HCPR"/>`
      : '';

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Composite:compositeView ${HCPR_XMLNS} schemaVersion="1.0" name="${nameUpper}" stackable="${stackable}">\n` +
    `  <endUserTexts label="${label}"/>\n` +
    `  <tlogoProperties adtcore:language="${language}" adtcore:name="${nameUpper}"` +
    ` adtcore:type="HCPR" adtcore:masterLanguage="${language}">\n` +
    `    <infoArea>${infoAreaUpper}</infoArea>\n` +
    `  </tlogoProperties>\n` +
    `  <viewNode name="${nameUpper}" xsi:type="${xsiType}" defaultNode="true">\n` +
    `  </viewNode>${templateElement}\n` +
    `</Composite:compositeView>`;

  try {
    await client.create('hcpr', compositeProviderName, lockHandle, body, {
      'Development-Class': pkg,
    });
  } catch (err) {
    await client.unlock('hcpr', compositeProviderName).catch(() => {/* ignore */});
    throw err;
  }
  await client.unlock('hcpr', compositeProviderName);

  const fromTemplate = action === 'from_template' && templateName ? ` from template ${templateName.toUpperCase()}` : '';
  return JSON.stringify({
    success: true,
    message: `CompositeProvider ${nameUpper} created${fromTemplate} in package ${pkg}. Call bw_activate to activate.`,
    composite_provider_name: nameUpper,
    object_type: 'hcpr',
    view_type: viewType,
  });
}

// ── Input / mapping support ───────────────────────────────────────────────────

export interface FieldMapping {
  target: string;         // CP element name (existing, or newly created if infoObjectName is given)
  source?: string;        // source field name in the input provider — regular mapping
  constantValue?: string; // constant value — mutually exclusive with source
  infoObjectName?: string; // only used when the target element does not exist yet (defaults to target)
  dimension?: string;      // only used when creating a new element (default "GROUP1"; use a name containing "__KEYFIGURES" for measures)
}

function buildMappingXml(m: FieldMapping): string {
  const target = m.target.trim().toUpperCase();
  if (m.constantValue !== undefined) {
    return `    <mapping xsi:type="Composite:ConstantElementMapping" targetName="${target}" value="${m.constantValue}"/>`;
  }
  const source = (m.source ?? m.target).trim().toUpperCase();
  return `    <mapping xsi:type="Composite:ElementMapping" targetName="${target}" sourceName="${source}"/>`;
}

function buildCpElementXml(m: FieldMapping): string {
  const target = m.target.trim().toUpperCase();
  const infoObjectName = (m.infoObjectName ?? m.target).trim().toUpperCase();
  const dimension = m.dimension ?? 'GROUP1';
  return `  <element name="${target}" infoObjectName="${infoObjectName}" dimension="#///${dimension}§"/>`;
}

export interface InputProviderDef {
  providerName: string;   // technical name of the source InfoProvider
  providerType: string;   // TLOGO-style suffix appended to alias, e.g. "ADSO", "CUBE", "HCPR"
  alias?: string;          // local reference name used by mappings/join (defaults to providerName)
  mappings: FieldMapping[];
}

/**
 * bw_update_composite_provider action "add_input" / "remove_input" —
 * add or remove a source InfoProvider (input) on the view node.
 * "add_input": injects <input> with its <mapping> children; also creates any
 * <element> referenced by a mapping's target that doesn't exist yet (pass infoObjectName/dimension).
 * "remove_input": strips the <input> block by its name (alias) attribute.
 * Returns the lock handle so the caller can invoke bw_activate next.
 */
export async function bwUpdateCompositeProviderInput(
  client: BwClient,
  compositeProviderName: string,
  action: 'add_input' | 'remove_input',
  input?: InputProviderDef,
  inputAlias?: string,
  transport?: string
): Promise<string> {
  const cpUpper = compositeProviderName.toUpperCase();
  const cpResult = await freshRead(HCPR_PATH(compositeProviderName), HCPR_ACCEPT);
  const timestamp = cpResult.headers['timestamp'] ?? cpResult.headers['TIMESTAMP'];
  let xml = cpResult.body;

  let message: string;

  if (action === 'remove_input') {
    const alias = (inputAlias ?? '').trim().toUpperCase();
    if (!alias) throw new Error('remove_input requires inputAlias.');
    const inputRegex = new RegExp(`[ \\t]*<input\\b[^>]*\\bname="${alias}"[^>]*>[\\s\\S]*?<\\/input>\\n?`);
    if (!inputRegex.test(xml)) {
      return JSON.stringify({
        success: false,
        message: `Input ${alias} not found in CompositeProvider ${cpUpper}. No changes made.`,
      });
    }
    xml = xml.replace(inputRegex, '');
    message = `Input ${alias} removed from CompositeProvider ${cpUpper}. Any join/union references to it must be updated separately (action "update_join"). Call bw_activate to activate.`;
  } else {
    if (!input) throw new Error('add_input requires an input definition.');
    const alias = (input.alias ?? input.providerName).trim().toUpperCase();
    if (new RegExp(`\\bname="${alias}"`).test(xml)) {
      return JSON.stringify({
        success: false,
        message: `Input ${alias} already present in CompositeProvider ${cpUpper}. No changes made.`,
      });
    }

    // Create any elements referenced by mapping targets that don't exist yet.
    const newElements = input.mappings.filter(
      (m) => !new RegExp(`<element\\b[^>]*\\bname="${m.target.trim().toUpperCase()}"`).test(xml)
    );
    if (newElements.length > 0) {
      const elementsXml = newElements.map(buildCpElementXml).join('\n');
      xml = injectBeforeAnchor(xml, elementsXml, ['<input', '<join'], '</viewNode>');
    }

    const aliasAttr = `${alias}.${input.providerType.trim().toUpperCase()}`;
    const mappingsXml = input.mappings.map(buildMappingXml).join('\n');
    const inputXml = `  <input name="${alias}" alias="${aliasAttr}">\n${mappingsXml}\n  </input>`;
    xml = injectBeforeAnchor(xml, inputXml, ['<join'], '</viewNode>');
    message = `Input ${alias} (${input.providerName.toUpperCase()}) added to CompositeProvider ${cpUpper}. Call bw_activate to activate.`;
  }

  const lockHandle = await client.lock('hcpr', compositeProviderName);
  try {
    await client.put('hcpr', compositeProviderName, lockHandle, xml, timestamp, transport);
  } catch (err) {
    await client.unlock('hcpr', compositeProviderName).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message,
    lock_handle: lockHandle,
    composite_provider_name: cpUpper,
    object_type: 'hcpr',
  });
}

/**
 * bw_update_composite_provider action "update_mapping" — replace the complete
 * mapping list of one existing input.
 * Returns the lock handle so the caller can invoke bw_activate next.
 */
export async function bwUpdateCompositeProviderMapping(
  client: BwClient,
  compositeProviderName: string,
  inputAlias: string,
  mappings: FieldMapping[],
  transport?: string
): Promise<string> {
  const cpUpper = compositeProviderName.toUpperCase();
  const alias = inputAlias.trim().toUpperCase();
  const cpResult = await freshRead(HCPR_PATH(compositeProviderName), HCPR_ACCEPT);
  const timestamp = cpResult.headers['timestamp'] ?? cpResult.headers['TIMESTAMP'];
  let xml = cpResult.body;

  const inputRegex = new RegExp(`(<input\\b[^>]*\\bname="${alias}"[^>]*>)([\\s\\S]*?)(<\\/input>)`);
  const match = inputRegex.exec(xml);
  if (!match) {
    return JSON.stringify({
      success: false,
      message: `Input ${alias} not found in CompositeProvider ${cpUpper}. No changes made.`,
    });
  }

  const newElements = mappings.filter(
    (m) => !new RegExp(`<element\\b[^>]*\\bname="${m.target.trim().toUpperCase()}"`).test(xml)
  );
  if (newElements.length > 0) {
    const elementsXml = newElements.map(buildCpElementXml).join('\n');
    xml = injectBeforeAnchor(xml, elementsXml, ['<input', '<join'], '</viewNode>');
  }

  const mappingsXml = mappings.map(buildMappingXml).join('\n');
  xml = xml.replace(inputRegex, `$1\n${mappingsXml}\n  $3`);

  const lockHandle = await client.lock('hcpr', compositeProviderName);
  try {
    await client.put('hcpr', compositeProviderName, lockHandle, xml, timestamp, transport);
  } catch (err) {
    await client.unlock('hcpr', compositeProviderName).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message: `Mappings for input ${alias} in CompositeProvider ${cpUpper} replaced (${mappings.length} mapping(s)). Call bw_activate to activate.`,
    lock_handle: lockHandle,
    composite_provider_name: cpUpper,
    object_type: 'hcpr',
    input_alias: alias,
  });
}

// ── Join key management ───────────────────────────────────────────────────────

export interface JoinKeyPair {
  left: string;
  right: string;
}

/**
 * bw_update_composite_provider action "update_join" — replace the join condition
 * (type, cardinality, and key field pairs) on a Join-type view node wholesale.
 * Returns the lock handle so the caller can invoke bw_activate next.
 */
export async function bwUpdateCompositeProviderJoin(
  client: BwClient,
  compositeProviderName: string,
  leftAlias: string,
  rightAlias: string,
  keyPairs: JoinKeyPair[],
  joinType: string = 'INNER',
  cardinality: string = 'M_N',
  transport?: string
): Promise<string> {
  const cpUpper = compositeProviderName.toUpperCase();
  const cpResult = await freshRead(HCPR_PATH(compositeProviderName), HCPR_ACCEPT);
  const timestamp = cpResult.headers['timestamp'] ?? cpResult.headers['TIMESTAMP'];
  let xml = cpResult.body;

  const viewNodeName = getViewNodeName(xml);
  const left = leftAlias.trim().toUpperCase();
  const right = rightAlias.trim().toUpperCase();

  const keyLines = keyPairs
    .map(
      (k) =>
        `    <leftElementName>${k.left.trim().toUpperCase()}</leftElementName>\n` +
        `    <rightElementName>${k.right.trim().toUpperCase()}</rightElementName>`
    )
    .join('\n');
  const joinXml =
    `  <join joinType="${joinType}" cardinality="${cardinality}"` +
    ` leftInput="#///${viewNodeName}/${left}" rightInput="#///${viewNodeName}/${right}">\n` +
    `${keyLines}\n` +
    `  </join>`;

  if (/<join\b[\s\S]*?<\/join>/.test(xml)) {
    xml = xml.replace(/<join\b[\s\S]*?<\/join>/, joinXml);
  } else {
    xml = xml.replace('</viewNode>', joinXml + '\n</viewNode>');
  }

  const lockHandle = await client.lock('hcpr', compositeProviderName);
  try {
    await client.put('hcpr', compositeProviderName, lockHandle, xml, timestamp, transport);
  } catch (err) {
    await client.unlock('hcpr', compositeProviderName).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message: `Join condition updated in CompositeProvider ${cpUpper} (${left} ⋈ ${right}, ${keyPairs.length} key pair(s)). Call bw_activate to activate.`,
    lock_handle: lockHandle,
    composite_provider_name: cpUpper,
    object_type: 'hcpr',
    join_type: joinType,
    cardinality,
  });
}
