import {
  BwClient,
  decodeXmlEntities,
  freshRead,
  bwSeg,
  bwSegUpper,
  stripInfoAreaSentinel,
} from '../bw-client.js';

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
  const path = `/sap/bw/modeling/hcpr/${bwSeg(compositeProviderName)}/m`;
  // Fresh session, not this client: a session that has just written the object serves its
  // own pinned model buffer afterwards, which drops attributes the write did set.
  const result = await freshRead(path, HCPR_ACCEPT);

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

  const description = decodeXmlEntities(xml.match(/<endUserTexts\b[^>]*\blabel="([^"]*)"/)?.[1] ?? '');

  // tlogoProperties block (opening tag only — attributes span multiple lines)
  const tlogoAttrs = xml.match(/<tlogoProperties\b([\s\S]*?)>/)?.[1] ?? '';
  const responsible = attr(tlogoAttrs, 'adtcore:responsible');
  const changedAt = attr(tlogoAttrs, 'adtcore:changedAt');
  const changedBy = attr(tlogoAttrs, 'adtcore:changedBy');
  const infoArea = stripInfoAreaSentinel(xml.match(/<infoArea>([^<]+)<\/infoArea>/)?.[1] ?? '');
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
    const elemBody = em[2] ?? '';
    const dimension = attr(elemAttrs, 'dimension');
    const dimName = dimension.match(/#\/\/\/([^§]*)§/)?.[1] ?? dimension;
    // The __KEYFIGURES dimension only exists in models that are modelled with dimensions;
    // a plain Union node carries no dimension at all. The element body always says what
    // the field is, so read that first and keep the dimension as a fallback.
    const isKeyFigure =
      /consumptionViewProperties\b[^>]*objectType="KYF"/.test(elemBody) ||
      /<localProperties\b[^>]*LocalKeyfigureProperties/.test(elemBody) ||
      dimName.includes('__KEYFIGURES');
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

// ── bw_create_composite_provider ─────────────────────────────────────────────

const HCPR_XMLNS =
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
  'xmlns:Composite="http://www.sap.com/bw/modeling/CompositeModel.ecore" ' +
  'xmlns:View="http://www.sap.com/ndb/ViewModelView.ecore" ' +
  'xmlns:adtcore="http://www.sap.com/adt/core"';

/** A source InfoProvider attached to the view node at creation time. */
export interface InitialInputRef {
  providerName: string;
  /** TLOGO-style suffix of the source, e.g. "ADSO" or "CUBE". */
  providerType: string;
}

/**
 * Escape a free-text value for an XML attribute. Labels reach the server verbatim, so an
 * unescaped `&` makes the create fail with HTTP 500 and no usable message.
 */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Relative entity reference used inside `<input><entity>…</entity></input>`. */
function buildEntityRef(providerName: string): string {
  return `../../../infoprov_dt/a/${providerName.trim().toUpperCase()}.composite#//`;
}

export interface CompositeProviderCreateOptions {
  label: string;
  infoArea: string;
  viewType?: 'Join' | 'Union';
  package?: string;
  stackable?: boolean;
  /** Source InfoProviders to attach right away. A Union without inputs was never observed. */
  inputs?: InitialInputRef[];
  /**
   * Copy the structure of an existing CompositeProvider. The server does the copying, so
   * `viewType`, `inputs` and `stackable` are then irrelevant — they come from the template.
   */
  copyFrom?: string;
}

/**
 * bw_create_composite_provider — create a new CompositeProvider shell.
 *
 * Workflow: lock (CREA) → POST minimal XML → unlock. The result is inactive; activation
 * is a separate step through bw_activate.
 *
 * The XML shape is confirmed against a captured create request: element order is
 * endUserTexts → viewNode → tlogoProperties → runtimeProperties, the view node carries a
 * generic id (U1/J1) rather than the CompositeProvider's name, `defaultNode` on the root
 * is a path reference, and stackable is omitted unless set. Fields and mappings are not
 * part of the create call — they are added afterwards through a full-object PUT.
 *
 * Copying from a template goes through the URL (`copyFrom`), not the body: unlike aDSO,
 * HCPR has no `<template>` element, and sending one is rejected with HTTP 500 and an empty
 * message. The server then builds the whole structure — view node, inputs and mappings —
 * from the template, and the body stays the minimal shell.
 */
export async function bwCreateCompositeProvider(
  client: BwClient,
  compositeProviderName: string,
  options: CompositeProviderCreateOptions
): Promise<string> {
  const {
    label,
    infoArea,
    viewType = 'Join',
    package: pkg = '$TMP',
    stackable = false,
    inputs = [],
    copyFrom,
  } = options;

  const nameUpper = compositeProviderName.toUpperCase();
  const infoAreaUpper = infoArea.toUpperCase();
  // Captured creates carry the system's logon language. A language that is not installed
  // makes the create fail with an unconditional 500.
  const language = process.env.BW_LANGUAGE ?? 'EN';
  const nodeName = viewType === 'Union' ? 'U1' : 'J1';
  const xsiType = viewType === 'Union' ? 'View:Union' : 'View:JoinNode';
  const stackableAttr = stackable ? ' stackable="true"' : '';

  const lockHandle = await client.lock('hcpr', compositeProviderName, {
    'activity_context': 'CREA',
    'parent_name': infoAreaUpper,
    'parent_type': 'AREA',
  });

  const typeSeq = new Map<string, number>();
  const aliases: string[] = [];
  const inputsXml = inputs
    .map((inp) => {
      const type = inp.providerType.trim().toUpperCase();
      const seq = (typeSeq.get(type) ?? 0) + 1;
      typeSeq.set(type, seq);
      const alias = `${nodeName}.${type}.${seq}`;
      aliases.push(alias);
      return (
        `    <input xsi:type="Composite:CompositeInput" alias="${alias}" selectAll="false">\n` +
        `      <entity>${buildEntityRef(inp.providerName)}</entity>\n` +
        `    </input>`
      );
    })
    .join('\n');

  // A join node models an N-way join as N inputs plus one <join> element per pair, so this
  // stub covers the first pair only; further inputs are wired up afterwards per pair.
  const joinStubXml =
    viewType === 'Join' && aliases.length === 2
      ? `    <join leftInput="#///${nodeName}/${aliases[0]}" rightInput="#///${nodeName}/${aliases[1]}" joinType="inner"/>`
      : '';

  const viewNodeBody = [inputsXml, joinStubXml].filter(Boolean).join('\n');

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Composite:compositeView ${HCPR_XMLNS} schemaVersion="1.15" name="${nameUpper}" readOnly="false"` +
    ` defaultNode="#///${nodeName}" clientDependent="false"${stackableAttr}>\n` +
    `  <endUserTexts label="${escapeXmlAttr(label)}"/>\n` +
    `  <viewNode xsi:type="${xsiType}" name="${nodeName}">\n` +
    (viewNodeBody ? viewNodeBody + '\n' : '') +
    `  </viewNode>\n` +
    `  <tlogoProperties adtcore:language="${language}" adtcore:name="${nameUpper}"` +
    ` adtcore:type="HCPR" adtcore:masterLanguage="${language}">\n` +
    `    <infoArea>${infoAreaUpper}</infoArea>\n` +
    `  </tlogoProperties>\n` +
    `  <runtimeProperties/>\n` +
    `</Composite:compositeView>`;

  try {
    await client.create(
      'hcpr',
      compositeProviderName,
      lockHandle,
      body,
      { 'Development-Class': pkg },
      // The template is named in the URL, not in the body. A <template> element like the
      // one aDSO uses is rejected here with HTTP 500 and an empty message.
      copyFrom ? { copyFromObjectName: copyFrom.toUpperCase(), copyFromObjectType: 'HCPR' } : undefined
    );
  } catch (err) {
    await client.unlock('hcpr', compositeProviderName).catch(() => {/* ignore */});
    throw err;
  }
  await client.unlock('hcpr', compositeProviderName);

  return JSON.stringify({
    success: true,
    message: `CompositeProvider ${nameUpper} created in package ${pkg}. Call bw_activate to activate.`,
    composite_provider_name: nameUpper,
    object_type: 'hcpr',
    view_type: viewType,
  });
}

// ── bw_update_composite_provider: inputs and their field mappings ────────────

const IPROV_ACCEPT = [
  'application/vnd.sap.bw.modeling.iprov-v1_0_0+xml',
  'application/vnd.sap.bw.modeling.iprov-v1_4_0+xml',
  'application/vnd.sap.bw.modeling.iprov-v1_7_0+xml',
  'application/vnd.sap.bw.modeling.iprov-v1_8_0+xml',
  'application/vnd.sap.bw.modeling.iprov-v1_9_0+xml',
  'application/vnd.sap.bw.modeling.iprov-v1_10_0+xml',
  'application/vnd.sap.bw.modeling.iprov-v1_11_0+xml',
  'application/vnd.sap.bw.modeling.iprov-v1_12_0+xml',
  'application/vnd.sap.bw.modeling.iprov-v1_13_0+xml',
  'application/vnd.sap.bw.modeling.iprov-v1_14_0+xml',
  'application/vnd.sap.bw.modeling.iprov-v9_99_9+xml',
].join(',');

const HCPR_PATH = (name: string) => `/sap/bw/modeling/hcpr/${bwSeg(name)}/m`;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Adds an xmlns declaration to the root tag if it is not there yet. */
function ensureNamespace(xml: string, prefix: string, uri: string): string {
  if (new RegExp(`xmlns:${prefix}=`).test(xml)) return xml;
  return xml.replace(/(<Composite:compositeView\b)/, `$1 xmlns:${prefix}="${uri}"`);
}

/** Insert before the earliest of the given anchors, falling back to before the closing tag. */
function injectBeforeAnchor(xml: string, insertXml: string, anchors: string[], fallbackClose: string): string {
  const positions = anchors.map((a) => xml.indexOf(a)).filter((i) => i !== -1);
  if (positions.length > 0) {
    const idx = Math.min(...positions);
    return xml.substring(0, idx) + insertXml + '\n  ' + xml.substring(idx);
  }
  return xml.replace(fallbackClose, insertXml + '\n' + fallbackClose);
}

function getViewNodeName(xml: string): string {
  return xml.match(/<viewNode\b[^>]*\bname="([^"]*)"/)?.[1] ?? '';
}

/**
 * Expand a self-closing view node into an open/close pair.
 *
 * A node without inputs comes back as `<viewNode …/>`, and inserting into it silently does
 * nothing: there is no anchor and no closing tag to fall back to, so the PUT goes out
 * unchanged and still reports success.
 */
function openViewNode(xml: string): string {
  return xml.replace(/(<viewNode\b[^>]*?)\s*\/>/, '$1></viewNode>');
}

function getViewNodeType(xml: string): 'Join' | 'Union' | undefined {
  const local = xml.match(/<viewNode\b[^>]*\bxsi:type="([^"]*)"/)?.[1]?.split(':').pop();
  return local === 'JoinNode' ? 'Join' : local === 'Union' ? 'Union' : undefined;
}

export interface FieldMapping {
  /** Element name in the CompositeProvider, existing or to be created. */
  target: string;
  /** Bare field name on the source, before its generated prefix. Defaults to `target`. */
  source?: string;
  /** Mutually exclusive with `source`. */
  constantValue?: string;
  /** Binds a newly created target element to an InfoObject instead of leaving it field-based. */
  infoObjectName?: string;
}

export interface SourceFieldMeta {
  /** Name the mapping has to address, prefixed on a field-based source. */
  sourceName: string;
  defaultTargetName: string;
  label: string;
  inlineTypeXml: string;
  dataType: string;
  isKeyFigure: boolean;
  aggregationBehavior: string;
  conversionRoutine?: string;
  fixedUnit?: string;
  unitCurrencyRefBareName?: string;
  outputLength: number;
  /** Set when the source models this field through an InfoObject rather than a plain field. */
  infoObjectName?: string;
  conversionType?: string;
}

// Pure CUKY/UNIT fields are bound to the standard currency/unit characteristics at
// CompositeProvider level even when the source itself carries no InfoObject.
const AUTO_IOBJ_FOR_TYPE: Record<string, string> = { CUKY: '0CURRENCY', UNIT: '0UNIT' };

/**
 * Record-count fields are left out of auto-mapping. BW maintains the row count itself as an
 * internal attribute of the generated column view, and mapping it as an ordinary element
 * makes activation fail on that view with "__numoffacttablerows is missing". An explicit
 * mapping still passes through, so the caller can override this.
 */
const AUTO_MAP_EXCLUDED = new Set(['1ROWCOUNT']);

// <semantics> is derived from the field's data type and appears only on the CP-level element.
const SEMANTICS_TAG: Record<string, string> = {
  INT1: 'INT', INT2: 'INT', INT4: 'INT', INT8: 'INT',
  FLTP: 'NUM', DEC: 'NUM', CURR: 'AMO', QUAN: 'QUA',
};

/**
 * Read the InfoProvider-as-composite-input view of a source provider.
 *
 * This is the only way to learn the generated field-name prefix: it cannot be derived
 * client-side, and every mapping has to address source fields by their prefixed name.
 */
export async function fetchCompositeSourceFields(
  providerName: string
): Promise<{ fieldNamePrefix: string; lastModified?: string; fields: SourceFieldMeta[] }> {
  const path = `/sap/bw/modeling/infoprov/${bwSegUpper(providerName)}/a?view=dt`;
  const xml = (await freshRead(path, IPROV_ACCEPT)).body;

  const fieldNamePrefix = xml.match(/\bfieldNamePrefix="([^"]*)"/)?.[1] ?? '';
  const lastModified = xml.match(/<tlogoProperties\b[^>]*\badtcore:changedAt="([^"]*)"/)?.[1];

  const fields: SourceFieldMeta[] = [];
  if (fieldNamePrefix) {
    const elemRegex = /<element\b([\s\S]*?)(?:\/>|>([\s\S]*?)<\/element>)/g;
    let em: RegExpExecArray | null;
    while ((em = elemRegex.exec(xml)) !== null) {
      const elemAttrs = em[1];
      const body = em[2] ?? '';
      const name = attr(elemAttrs, 'name');
      const dimension = attr(elemAttrs, 'dimension');
      const sourceInfoObject = attr(elemAttrs, 'infoObjectName');
      // Two source shapes. A field-based provider names its fields "<prefix>-<FIELD>" and
      // marks them with a dimension; an InfoObject-based one names them after the
      // InfoObject and carries no dimension. Everything else — navigation attributes, and
      // fields whose name was too long and got hashed into "<prefix>-<hash>" — is not
      // addressable as an input field.
      const fieldBased = Boolean(dimension) && name.startsWith(`${fieldNamePrefix}-`);
      const infoObjectBased = !dimension && Boolean(sourceInfoObject) && name === sourceInfoObject;
      if (!name || (!fieldBased && !infoObjectBased)) continue;

      const inlineTypeXml = body.match(/<inlineType\b[^>]*\/>/)?.[0] ?? '';
      const unitCurrencyRaw = body.match(/<unitCurrencyElement>([^<]*)<\/unitCurrencyElement>/)?.[1];
      const refPrefix = `#///${fieldNamePrefix}-`;
      const outputLengthRaw = attr(elemAttrs, 'outputLength');

      fields.push({
        sourceName: name,
        defaultTargetName: fieldBased ? name.slice(fieldNamePrefix.length + 1) : name,
        infoObjectName: infoObjectBased ? sourceInfoObject : undefined,
        conversionType: attr(elemAttrs, 'conversionType') || undefined,
        label: decodeXmlEntities(body.match(/<endUserTexts label="([^"]*)"/)?.[1] ?? ''),
        inlineTypeXml,
        dataType: attr(inlineTypeXml, 'name'),
        isKeyFigure: /LocalKeyfigureProperties/.test(body),
        aggregationBehavior: attr(elemAttrs, 'aggregationBehavior') || 'NONE',
        conversionRoutine: attr(elemAttrs, 'conversionRoutine') || undefined,
        fixedUnit: body.match(/<fixedUnit>([^<]*)<\/fixedUnit>/)?.[1],
        unitCurrencyRefBareName: unitCurrencyRaw?.startsWith(refPrefix)
          ? unitCurrencyRaw.slice(refPrefix.length)
          : undefined,
        outputLength: outputLengthRaw ? parseInt(outputLengthRaw, 10) : 0,
      });
    }
  }

  return { fieldNamePrefix, lastModified, fields };
}

/** Build the target element block for a field that the CompositeProvider does not have yet. */
function buildTargetElementXml(
  field: SourceFieldMeta,
  targetName: string,
  nodeName: string,
  resolveUnitCurrencyTarget: (bareSourceName: string) => string | undefined,
  infoObjectNameOverride?: string
): string {
  // A field the source models through an InfoObject is rebuilt in the shape an active
  // CompositeProvider uses for it: no dimension, the label in endUserTexts, and the
  // association back to the InfoObject. See payloads/hcpr_add_input_infoobject_based.md.
  if (field.infoObjectName) {
    const iobjAttrs = [
      `name="${targetName}"`,
      ...(field.isKeyFigure ? [`aggregationBehavior="${field.aggregationBehavior}"`] : []),
      `infoObjectName="${field.infoObjectName}"`,
      ...(field.conversionRoutine ? [`conversionRoutine="${field.conversionRoutine}"`] : []),
      ...(field.conversionType ? [`conversionType="${field.conversionType}"`] : []),
      ...(field.outputLength ? [`outputLength="${field.outputLength}"`] : []),
    ].join(' ');
    const iobjLines = [`  <element xsi:type="BwCore:BwElement" ${iobjAttrs}>`];
    iobjLines.push(`    <endUserTexts label="${escapeXmlAttr(field.label)}"/>`);
    if (field.inlineTypeXml) iobjLines.push(`    ${field.inlineTypeXml}`);
    if (field.isKeyFigure) {
      iobjLines.push(`    <localProperties xsi:type="BwCore:LocalKeyfigureProperties"/>`);
      const semantics = SEMANTICS_TAG[field.dataType];
      if (semantics) iobjLines.push(`    <semantics>${semantics}</semantics>`);
    } else {
      iobjLines.push(`    <localProperties xsi:type="BwCore:LocalCharacteristicProperties">`);
      iobjLines.push(`      <authorizationRelevant>N</authorizationRelevant>`);
      iobjLines.push(`    </localProperties>`);
    }
    iobjLines.push(`    <associationType>1</associationType>`);
    iobjLines.push(`  </element>`);
    return iobjLines.join('\n');
  }

  const infoObjectName = infoObjectNameOverride ?? AUTO_IOBJ_FOR_TYPE[field.dataType];
  const attrs = [
    `name="${targetName}"`,
    `aggregationBehavior="${field.aggregationBehavior}"`,
    ...(infoObjectName ? [`infoObjectName="${infoObjectName}"`] : []),
    ...(field.conversionRoutine ? [`conversionRoutine="${field.conversionRoutine}"`] : []),
    `dimension="#///GROUP1§"`,
    `outputLength="${field.outputLength}"`,
  ].join(' ');

  const label = escapeXmlAttr(field.label);
  const lines: string[] = [`  <element xsi:type="BwCore:BwElement" ${attrs}>`];
  if (field.inlineTypeXml) lines.push(`    ${field.inlineTypeXml}`);
  if (field.fixedUnit) lines.push(`    <fixedUnit>${field.fixedUnit}</fixedUnit>`);
  if (field.unitCurrencyRefBareName) {
    const refTarget = resolveUnitCurrencyTarget(field.unitCurrencyRefBareName) ?? field.unitCurrencyRefBareName;
    lines.push(`    <unitCurrencyElement>#///${nodeName}/${refTarget}</unitCurrencyElement>`);
  }
  if (field.isKeyFigure) {
    lines.push(`    <localProperties xsi:type="BwCore:LocalKeyfigureProperties">`);
    lines.push(`      <descriptions label="${label}"/>`);
    lines.push(`    </localProperties>`);
    const semantics = SEMANTICS_TAG[field.dataType];
    if (semantics) lines.push(`    <semantics>${semantics}</semantics>`);
  } else {
    lines.push(`    <localProperties xsi:type="BwCore:LocalCharacteristicProperties">`);
    lines.push(`      <descriptions label="${label}"/>`);
    lines.push(`      <referentialIntegrity>false</referentialIntegrity>`);
    lines.push(`      <authorizationRelevant>N</authorizationRelevant>`);
    lines.push(`    </localProperties>`);
    if (infoObjectName) lines.push(`    <associationType>1</associationType>`);
  }
  lines.push(`  </element>`);
  return lines.join('\n');
}

function buildTypeMappingXml(targetName: string, sourceName: string): string {
  return `    <mapping xsi:type="Type:ElementMapping" targetName="${targetName}" sourceName="${sourceName}"/>`;
}

// Not covered by a captured request; kept in the same shape as the confirmed element mapping.
function buildConstantMappingXml(targetName: string, value: string): string {
  return `    <mapping xsi:type="Type:ConstantElementMapping" targetName="${targetName}" value="${escapeXmlAttr(value)}"/>`;
}

/**
 * Resolve a mapping list against the source's field metadata: build the mapping elements
 * and, for every target the CompositeProvider does not have yet, its element block.
 */
function resolveMappings(
  mappings: FieldMapping[],
  fields: SourceFieldMeta[],
  providerName: string,
  nodeName: string,
  existingXml: string
): { mappingsXml: string[]; newElementsXml: string[] } {
  const byBareName = new Map(fields.map((f) => [f.defaultTargetName, f]));

  // Resolve target names up front so a unit or currency reference can point at a sibling
  // field of the same batch before that field's element block exists.
  const targetNameByBareSource = new Map<string, string>();
  for (const m of mappings) {
    if (m.constantValue === undefined) {
      targetNameByBareSource.set((m.source ?? m.target).trim().toUpperCase(), m.target.trim().toUpperCase());
    }
  }

  const mappingsXml: string[] = [];
  const newElementsXml: string[] = [];
  for (const m of mappings) {
    const target = m.target.trim().toUpperCase();
    if (m.constantValue !== undefined) {
      mappingsXml.push(buildConstantMappingXml(target, m.constantValue));
      continue;
    }
    const bareSource = (m.source ?? m.target).trim().toUpperCase();
    const field = byBareName.get(bareSource);
    if (!field) {
      throw new Error(
        `Source field ${bareSource} not found on InfoProvider ${providerName.toUpperCase()} ` +
        `(available: ${fields.map((f) => f.defaultTargetName).join(', ')}).`
      );
    }
    mappingsXml.push(buildTypeMappingXml(target, field.sourceName));
    if (!new RegExp(`<element\\b[^>]*\\bname="${escapeRegex(target)}"`).test(existingXml)) {
      newElementsXml.push(
        buildTargetElementXml(field, target, nodeName, (bare) => targetNameByBareSource.get(bare), m.infoObjectName)
      );
    }
  }
  return { mappingsXml, newElementsXml };
}

/**
 * Element names are limited to 12 characters. A longer one saves without complaint and then
 * fails activation, so auto-mapping shortens it here — keeping the tail, which carries the
 * distinguishing part of names like a long identifier suffix, and leaving room for the
 * collision counter that dedupeTargetName may append.
 */
const MAX_ELEMENT_NAME_LENGTH = 12;

function shortenTargetName(name: string): string {
  return name.length <= MAX_ELEMENT_NAME_LENGTH
    ? name
    : name.slice(name.length - MAX_ELEMENT_NAME_LENGTH).replace(/^_+/, '');
}

function dedupeTargetName(desired: string, existingXml: string, usedInBatch: Set<string>): string {
  const exists = (name: string) =>
    usedInBatch.has(name) || new RegExp(`<element\\b[^>]*\\bname="${escapeRegex(name)}"`).test(existingXml);
  if (!exists(desired)) return desired;
  const stem = desired.slice(0, MAX_ELEMENT_NAME_LENGTH - 2);
  let n = 0;
  while (exists(`${stem}_${n}`)) n++;
  return `${stem}_${n}`;
}

/**
 * Auto-map every field of one input.
 *
 * Union and Join differ on purpose: a union stacks rows, so a same-named field from
 * another input merges into the shared target column, while a join puts both side by side
 * and a colliding name is suffixed instead.
 */
function buildAutoMappings(
  fields: SourceFieldMeta[],
  existingXml: string,
  viewNodeType: 'Join' | 'Union' | undefined
): FieldMapping[] {
  const usedInBatch = new Set<string>();
  return fields.filter((f) => !AUTO_MAP_EXCLUDED.has(f.defaultTargetName)).map((f) => {
    const desired = shortenTargetName(f.defaultTargetName);
    const target =
      viewNodeType === 'Union'
        ? dedupeTargetName(desired, '', usedInBatch)
        : dedupeTargetName(desired, existingXml, usedInBatch);
    usedInBatch.add(target);
    return { target, source: f.defaultTargetName };
  });
}

/** Next free alias for a view node and provider type, continuing BW's own numbering. */
function nextInputAlias(xml: string, nodeName: string, providerType: string): string {
  const type = providerType.trim().toUpperCase();
  const re = new RegExp(`alias="${escapeRegex(nodeName)}\\.${escapeRegex(type)}\\.(\\d+)"`, 'g');
  let max = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) max = Math.max(max, parseInt(m[1], 10));
  return `${nodeName}.${type}.${max + 1}`;
}

/** Extracts the source provider name from an input's entity reference. */
function extractProviderNameFromInput(inputBlock: string): string | undefined {
  return inputBlock.match(/(?:infoprov_dt\/a\/)?([A-Za-z0-9_]+)\.composite#\/\//)?.[1];
}

export interface InputProviderDef {
  providerName: string;
  /** TLOGO-style suffix used in the generated alias, e.g. "ADSO". */
  providerType: string;
  /** Omit or pass an empty list to map every field of the source one to one. */
  mappings?: FieldMapping[];
}

/**
 * bw_update_composite_provider actions "add_input" and "remove_input".
 *
 * add_input reads the source's field metadata, attaches an entity-referenced input with
 * its mappings, and creates the target elements that do not exist yet. The alias is
 * generated to continue BW's own numbering; later calls address the input by that alias.
 * remove_input strips the input block; references to it in a join must be updated
 * separately. Returns the lock handle so the caller can activate afterwards.
 */
export async function bwUpdateCompositeProviderInput(
  client: BwClient,
  compositeProviderName: string,
  action: 'add_input' | 'remove_input',
  opts: { input?: InputProviderDef; inputAlias?: string; transport?: string } = {}
): Promise<string> {
  const { input, inputAlias, transport } = opts;
  const cpUpper = compositeProviderName.toUpperCase();
  const cpResult = await freshRead(HCPR_PATH(compositeProviderName), HCPR_ACCEPT);
  const timestamp = cpResult.headers['timestamp'] ?? cpResult.headers['TIMESTAMP'];
  let xml = cpResult.body;

  let message: string;
  let resultAlias: string | undefined;

  if (action === 'remove_input') {
    const alias = (inputAlias ?? '').trim();
    if (!alias) throw new Error('remove_input requires inputAlias.');
    const inputRegex = new RegExp(
      `[ \\t]*<input\\b[^>]*\\balias="${escapeRegex(alias)}"[^>]*>[\\s\\S]*?<\\/input>\\n?`
    );
    if (!inputRegex.test(xml)) {
      return JSON.stringify({
        success: false,
        message: `Input ${alias} not found in CompositeProvider ${cpUpper}. No changes made.`,
      });
    }
    xml = xml.replace(inputRegex, '');
    message =
      `Input ${alias} removed from CompositeProvider ${cpUpper}. Join references to it must be ` +
      `updated separately. Call bw_activate to activate.`;
  } else {
    if (!input) throw new Error('add_input requires an input definition.');

    const nodeName = getViewNodeName(xml);
    if (!nodeName) throw new Error(`Could not determine view node name for CompositeProvider ${cpUpper}.`);

    const { fieldNamePrefix, lastModified, fields } = await fetchCompositeSourceFields(input.providerName);
    if (!fieldNamePrefix) {
      throw new Error(
        `Could not determine the field name prefix for source InfoProvider ` +
        `${input.providerName.toUpperCase()}; it reports no fieldNamePrefix.`
      );
    }

    const requested: FieldMapping[] =
      input.mappings && input.mappings.length > 0
        ? input.mappings
        : buildAutoMappings(fields, xml, getViewNodeType(xml));

    const alias = nextInputAlias(xml, nodeName, input.providerType);
    const { mappingsXml, newElementsXml } = resolveMappings(requested, fields, input.providerName, nodeName, xml);
    xml = openViewNode(xml);

    if (newElementsXml.length > 0) {
      xml = injectBeforeAnchor(xml, newElementsXml.join('\n'), ['<input', '<join'], '</viewNode>');
    }
    xml = ensureNamespace(xml, 'BwCore', 'http://www.sap.com/bw/modeling/BwCore.ecore');
    xml = ensureNamespace(xml, 'Type', 'http://www.sap.com/ndb/DataModelType.ecore');

    const lastModifiedAttr = lastModified ? ` lastModified="${lastModified}"` : '';
    const inputXml =
      `  <input xsi:type="Composite:CompositeInput" alias="${alias}" selectAll="false"` +
      ` hiddenNavigationAttributes="true" hiddenTemporalFields="false"${lastModifiedAttr}>\n` +
      `    <entity>${buildEntityRef(input.providerName)}</entity>\n` +
      `${mappingsXml.join('\n')}\n` +
      `  </input>`;
    xml = injectBeforeAnchor(xml, inputXml, ['<join'], '</viewNode>');
    resultAlias = alias;
    message =
      `Input ${alias} (${input.providerName.toUpperCase()}) added to CompositeProvider ${cpUpper} ` +
      `with ${mappingsXml.length} mapping(s). Call bw_activate to activate.`;
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
    ...(resultAlias ? { input_alias: resultAlias } : {}),
  });
}

// ── bw_update_composite_provider: mappings and root settings ─────────────────

/**
 * bw_update_composite_provider action "update_mapping" — replace the complete mapping list
 * of one input, addressed by its alias.
 *
 * Pass an empty list to map every field of that input's source one to one. That is the way
 * to populate an input which was attached at creation time through `inputs`, since those
 * arrive entity-only, without mappings.
 */
export async function bwUpdateCompositeProviderMapping(
  client: BwClient,
  compositeProviderName: string,
  inputAlias: string,
  mappings: FieldMapping[],
  transport?: string
): Promise<string> {
  const cpUpper = compositeProviderName.toUpperCase();
  const alias = inputAlias.trim();
  const cpResult = await freshRead(HCPR_PATH(compositeProviderName), HCPR_ACCEPT);
  const timestamp = cpResult.headers['timestamp'] ?? cpResult.headers['TIMESTAMP'];
  let xml = cpResult.body;

  const inputMatch = new RegExp(
    `<input\\b[^>]*\\balias="${escapeRegex(alias)}"[^>]*>[\\s\\S]*?<\\/input>`
  ).exec(xml);
  if (!inputMatch) {
    return JSON.stringify({
      success: false,
      message: `Input ${alias} not found in CompositeProvider ${cpUpper}. No changes made.`,
    });
  }

  const providerName = extractProviderNameFromInput(inputMatch[0]);
  if (!providerName) {
    throw new Error(`Could not determine the source InfoProvider for input ${alias}.`);
  }
  const nodeName = getViewNodeName(xml);
  const { fields } = await fetchCompositeSourceFields(providerName);

  const effective = mappings.length > 0 ? mappings : buildAutoMappings(fields, xml, getViewNodeType(xml));
  const { mappingsXml, newElementsXml } = resolveMappings(effective, fields, providerName, nodeName, xml);

  if (newElementsXml.length > 0) {
    xml = injectBeforeAnchor(openViewNode(xml), newElementsXml.join('\n'), ['<input', '<join'], '</viewNode>');
  }
  xml = ensureNamespace(xml, 'BwCore', 'http://www.sap.com/bw/modeling/BwCore.ecore');
  xml = ensureNamespace(xml, 'Type', 'http://www.sap.com/ndb/DataModelType.ecore');

  // Keep the input's opening tag and entity reference, replace only the mapping list.
  xml = xml.replace(
    new RegExp(
      `(<input\\b[^>]*\\balias="${escapeRegex(alias)}"[^>]*>\\s*<entity>[^<]*<\\/entity>)[\\s\\S]*?(<\\/input>)`
    ),
    `$1\n${mappingsXml.join('\n')}\n  $2`
  );

  const lockHandle = await client.lock('hcpr', compositeProviderName);
  try {
    await client.put('hcpr', compositeProviderName, lockHandle, xml, timestamp, transport);
  } catch (err) {
    await client.unlock('hcpr', compositeProviderName).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message:
      `Mappings for input ${alias} in CompositeProvider ${cpUpper} replaced ` +
      `(${mappingsXml.length} mapping(s)). Call bw_activate to activate.`,
    lock_handle: lockHandle,
    composite_provider_name: cpUpper,
    object_type: 'hcpr',
    input_alias: alias,
  });
}

export interface CompositeProviderSettings {
  label?: string;
  stackable?: boolean;
  defaultNode?: string;
  aggregationBehaviour?: string;
  transport?: string;
}

/** bw_update_composite_provider action "update_settings" — edit root-level attributes. */
export async function bwUpdateCompositeProviderSettings(
  client: BwClient,
  compositeProviderName: string,
  settings: CompositeProviderSettings
): Promise<string> {
  const cpUpper = compositeProviderName.toUpperCase();
  const cpResult = await freshRead(HCPR_PATH(compositeProviderName), HCPR_ACCEPT);
  const timestamp = cpResult.headers['timestamp'] ?? cpResult.headers['TIMESTAMP'];
  let xml = cpResult.body;

  const setRootAttr = (source: string, name: string, value: string): string => {
    const existing = new RegExp(`\\b${name}="[^"]*"`);
    return existing.test(source)
      ? source.replace(existing, `${name}="${value}"`)
      : source.replace(/(<Composite:compositeView\b(?:[^>]|\n)*?)(\s*>)/, `$1 ${name}="${value}"$2`);
  };

  if (settings.stackable !== undefined) xml = setRootAttr(xml, 'stackable', String(settings.stackable));
  if (settings.defaultNode !== undefined) xml = setRootAttr(xml, 'defaultNode', settings.defaultNode);
  if (settings.aggregationBehaviour !== undefined) {
    xml = setRootAttr(xml, 'aggregationBehaviour', settings.aggregationBehaviour);
  }
  if (settings.label !== undefined) {
    const tag = `<endUserTexts label="${escapeXmlAttr(settings.label)}"/>`;
    xml = /<endUserTexts[^>]*\/>/.test(xml)
      ? xml.replace(/<endUserTexts[^>]*\/>/, tag)
      : xml.replace(/(<tlogoProperties)/, `${tag}\n  $1`);
  }

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

// ── bw_update_composite_provider: join conditions ────────────────────────────

export interface JoinKeyPair {
  /** Bare field name on the left input's own source provider. */
  left: string;
  /** Bare field name on the right input's own source provider. */
  right: string;
}

/** The join element between exactly this alias pair, self-closing or with a body. */
function findJoinBetween(xml: string, viewNodeName: string, left: string, right: string): RegExpMatchArray | null {
  const leftRef = escapeRegex(`#///${viewNodeName}/${left}`);
  const rightRef = escapeRegex(`#///${viewNodeName}/${right}`);
  return xml.match(new RegExp(
    `[ \\t]*<join\\b(?=[^>]*\\bleftInput="${leftRef}")(?=[^>]*\\brightInput="${rightRef}")` +
    `[^>]*(?:\\/>|>[\\s\\S]*?<\\/join>)\\n?`
  ));
}

async function resolveInputProviderMeta(
  xml: string,
  alias: string,
  cpUpper: string
): Promise<{ providerName: string; fields: SourceFieldMeta[] }> {
  const inputMatch = xml.match(
    new RegExp(`<input\\b[^>]*\\balias="${escapeRegex(alias)}"[^>]*>[\\s\\S]*?<\\/input>`)
  );
  if (!inputMatch) throw new Error(`Could not find input ${alias} in CompositeProvider ${cpUpper}.`);
  const providerName = extractProviderNameFromInput(inputMatch[0]);
  if (!providerName) throw new Error(`Could not determine the source InfoProvider for input ${alias}.`);
  const { fields } = await fetchCompositeSourceFields(providerName);
  return { providerName, fields };
}

/**
 * The name a join key has to be addressed by on its own source.
 *
 * Resolved from the source's field metadata rather than assembled from the prefix: only a
 * field-based provider names its fields "<prefix>-<FIELD>", an InfoObject-based one uses the
 * InfoObject name, and a concatenated guess silently produces a key that does not exist.
 */
function resolveSourceFieldName(
  fields: SourceFieldMeta[],
  bareName: string,
  providerName: string
): string {
  const wanted = bareName.trim().toUpperCase();
  const field = fields.find((f) => f.defaultTargetName.toUpperCase() === wanted);
  if (!field) {
    throw new Error(
      `Join key ${wanted} not found on InfoProvider ${providerName.toUpperCase()} ` +
      `(available: ${fields.map((f) => f.defaultTargetName).join(', ')}).`
    );
  }
  return field.sourceName;
}

/**
 * bw_update_composite_provider action "update_join" — set or replace the join condition
 * between one pair of inputs on a join node. Call once per pair to build an N-way join.
 *
 * From a captured trace: joinType is lowercase, the default cardinality is "CN_N", and each
 * side's element name is the field name on its own source, not the CompositeProvider's
 * target element name.
 */
export async function bwUpdateCompositeProviderJoin(
  client: BwClient,
  compositeProviderName: string,
  leftAlias: string,
  rightAlias: string,
  keyPairs: JoinKeyPair[],
  opts: { joinType?: string; cardinality?: string; transport?: string } = {}
): Promise<string> {
  const { joinType = 'inner', cardinality = 'CN_N', transport } = opts;
  const cpUpper = compositeProviderName.toUpperCase();
  const cpResult = await freshRead(HCPR_PATH(compositeProviderName), HCPR_ACCEPT);
  const timestamp = cpResult.headers['timestamp'] ?? cpResult.headers['TIMESTAMP'];
  let xml = cpResult.body;

  const viewNodeName = getViewNodeName(xml);
  const left = leftAlias.trim();
  const right = rightAlias.trim();

  const [leftMeta, rightMeta] = await Promise.all([
    resolveInputProviderMeta(xml, left, cpUpper),
    resolveInputProviderMeta(xml, right, cpUpper),
  ]);

  // Grouped, not interleaved: SAP writes every leftElementName first and then every
  // rightElementName, pairing them by position. Interleaving them per pair is accepted for
  // a single key and rejected with HTTP 500 and an empty message for two or more.
  const keyLines = [
    ...keyPairs.map(
      (k) => `    <leftElementName>` +
        `${resolveSourceFieldName(leftMeta.fields, k.left, leftMeta.providerName)}` +
        `</leftElementName>`
    ),
    ...keyPairs.map(
      (k) => `    <rightElementName>` +
        `${resolveSourceFieldName(rightMeta.fields, k.right, rightMeta.providerName)}` +
        `</rightElementName>`
    ),
  ].join('\n');

  const joinXml =
    `  <join leftInput="#///${viewNodeName}/${left}" rightInput="#///${viewNodeName}/${right}"` +
    ` joinType="${joinType}" cardinality="${cardinality}">\n` +
    `${keyLines}\n` +
    `  </join>`;

  // Replace only this pair's join — whether the create-time stub or a saved full form.
  const existing = findJoinBetween(xml, viewNodeName, left, right);
  xml = existing
    ? xml.replace(existing[0], joinXml + '\n')
    : injectBeforeAnchor(openViewNode(xml), joinXml, ['</viewNode>'], '</viewNode>');

  const lockHandle = await client.lock('hcpr', compositeProviderName);
  try {
    await client.put('hcpr', compositeProviderName, lockHandle, xml, timestamp, transport);
  } catch (err) {
    await client.unlock('hcpr', compositeProviderName).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message:
      `Join condition set in CompositeProvider ${cpUpper} (${left} / ${right}, ` +
      `${keyPairs.length} key pair(s)). Call bw_activate to activate.`,
    lock_handle: lockHandle,
    composite_provider_name: cpUpper,
    object_type: 'hcpr',
    join_type: joinType,
    cardinality,
  });
}

/** bw_update_composite_provider action "remove_join" — drop one pair's join condition. */
export async function bwRemoveCompositeProviderJoin(
  client: BwClient,
  compositeProviderName: string,
  leftAlias: string,
  rightAlias: string,
  transport?: string
): Promise<string> {
  const cpUpper = compositeProviderName.toUpperCase();
  const cpResult = await freshRead(HCPR_PATH(compositeProviderName), HCPR_ACCEPT);
  const timestamp = cpResult.headers['timestamp'] ?? cpResult.headers['TIMESTAMP'];
  let xml = cpResult.body;

  const viewNodeName = getViewNodeName(xml);
  const left = leftAlias.trim();
  const right = rightAlias.trim();

  const existing = findJoinBetween(xml, viewNodeName, left, right);
  if (!existing) {
    return JSON.stringify({
      success: false,
      message: `No join found between ${left} and ${right} in CompositeProvider ${cpUpper}. No changes made.`,
    });
  }
  xml = xml.replace(existing[0], '');

  const lockHandle = await client.lock('hcpr', compositeProviderName);
  try {
    await client.put('hcpr', compositeProviderName, lockHandle, xml, timestamp, transport);
  } catch (err) {
    await client.unlock('hcpr', compositeProviderName).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message: `Join between ${left} and ${right} removed from CompositeProvider ${cpUpper}. Call bw_activate to activate.`,
    lock_handle: lockHandle,
    composite_provider_name: cpUpper,
    object_type: 'hcpr',
  });
}
