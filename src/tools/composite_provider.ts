import {
  BwClient,
  MEDIA_TYPES,
  decodeXmlEntities,
  freshRead,
  bwSeg,
  bwSegUpper,
  stripInfoAreaSentinel,
} from '../bw-client.js';
import {
  NodeKind,
  addJoinPartner,
  describeNodes,
  enterScope,
  insertNodeAboveInput,
  insertNodeAboveRoot,
  leaveScope,
  maskNodeRefs,
  nodeOfInput,
  noteFieldRename,
  parkedNode,
  removeNode,
  viewNodes,
} from './composite_provider_nodes.js';
import {
  TemporalInput,
  inputDateElements,
  isTemporalJoin,
  readTemporalChoices,
  stripTemporalJoin,
  writeTemporalJoin,
} from './composite_provider_temporal.js';

/**
 * The schema version the modeling tools write on create is the major.minor of the content type
 * the system announces for CompositeProviders in its discovery document, which MEDIA_TYPES
 * carries once loaded. The highest version this module accepts is the fallback.
 */
function hcprSchemaVersion(): string {
  const m = (MEDIA_TYPES['hcpr'] ?? '').match(/-v(\d+)_(\d+)_\d+\+xml$/);
  return m ? `${m[1]}.${m[2]}` : '1.15';
}

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

// ── Field name usage and field groups (shared by every write path) ───────────

/**
 * How an InfoObject-bound element is exposed to queries.
 *
 * "direct" is BWMT's "use the associated object directly by name": queries see the
 * InfoObject name. "unique_name" exposes the system-wide unique name "<prefix>-<ELEMENT>"
 * instead, so a query looking for the InfoObject does not find it. The switch is the
 * `globalElementName` attribute on the element's `<inlineType>`, not a property of its own.
 */
export type NameUsage = 'direct' | 'unique_name';

export const DEFAULT_CHARACTERISTIC_GROUP = 'CHARACTERISTICS';
export const DEFAULT_KEY_FIGURE_GROUP = 'KEYFIGURES';

/**
 * The `<inlineType>` a CompositeProvider element carries, built from a source element body.
 *
 * Sources differ in shape: BW/4HANA serves the tag self-closing, a classic release wraps a
 * `<dataElementName>` child in it. The element accepts only the self-closing form, and a
 * pattern that expects it finds nothing on a classic release — the element is then written
 * without a type and loses its direct name usage.
 */
export function compositeInlineType(elementBody: string): string {
  const open = elementBody.match(/<inlineType\b([^>]*?)\s*\/?>/);
  return open ? `<inlineType${open[1]}/>` : '';
}

/** Set or clear `globalElementName` on an `<inlineType …/>` tag. */
export function withGlobalElementName(inlineType: string, globalName: string | undefined): string {
  const stripped = inlineType.replace(/\s+globalElementName="[^"]*"/, '');
  if (!globalName) return stripped;
  return /\bname="[^"]*"/.test(stripped)
    ? stripped.replace(/(<inlineType\b[^>]*?\bname="[^"]*")/, `$1 globalElementName="${globalName}"`)
    : stripped.replace(/^<inlineType\b/, `<inlineType globalElementName="${globalName}"`);
}

/**
 * Name usage for a new element. Without an explicit choice an element named after its
 * InfoObject uses it directly — the shape BWMT gives it, and the one a query needs.
 */
export function resolveNameUsage(
  requested: NameUsage | undefined,
  targetName: string,
  infoObjectName: string | undefined
): NameUsage | undefined {
  if (!infoObjectName) {
    if (requested === 'direct') {
      throw new Error(
        `name_usage "direct" needs an element bound to an InfoObject; ${targetName} is a plain field.`
      );
    }
    return undefined;
  }
  return requested ?? (targetName === infoObjectName ? 'direct' : 'unique_name');
}

/** InfoObjects already used directly by an element of the model, as globalElementName values. */
export function directlyUsedNames(xml: string): Set<string> {
  return new Set([...xml.matchAll(/<inlineType\b[^>]*\bglobalElementName="([^"]+)"/g)].map((m) => m[1]));
}

/** Field groups a CompositeProvider declares, as group name → label (empty when it has none). */
export function compositeGroups(xml: string): Map<string, string> {
  const groups = new Map<string, string>();
  const re = /<dimension\b[^>]*\bname="([^"]+)"[^>]*?(?:\/>|>([\s\S]*?)<\/dimension>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    groups.set(m[1], decodeXmlEntities(m[2]?.match(/<descriptions\b[^>]*\blabel="([^"]*)"/)?.[1] ?? ''));
  }
  return groups;
}

/** The value an element's `dimension` attribute carries to sit in a group. */
export function groupRef(group: string): string {
  return `#///${group}§`;
}

/** Declare a field group at the end of the model if it is not declared yet. */
export function ensureGroupDeclared(xml: string, group: string): string {
  if (compositeGroups(xml).has(group)) return xml;
  return xml.replace(/(\s*)<\/Composite:compositeView>\s*$/, `\n  <dimension name="${group}"/>$1</Composite:compositeView>`);
}

/**
 * The group a new or moved element goes to. A group the caller names must be declared,
 * except the two defaults, which are declared on demand the way BWMT does it.
 */
export function resolveGroup(
  xml: string,
  requested: string | undefined,
  isKeyFigure: boolean,
  cpUpper: string
): string {
  const defaultGroup = isKeyFigure ? DEFAULT_KEY_FIGURE_GROUP : DEFAULT_CHARACTERISTIC_GROUP;
  const name = requested?.trim().toUpperCase() || defaultGroup;
  const declared = compositeGroups(xml);
  if (declared.has(name) || name === DEFAULT_CHARACTERISTIC_GROUP || name === DEFAULT_KEY_FIGURE_GROUP) {
    return name;
  }
  const known = [...declared.keys()].sort();
  throw new Error(
    `CompositeProvider ${cpUpper} has no field group "${name}". ` +
    (known.length ? `Declared groups: ${known.join(', ')}. ` : 'It declares no field groups yet. ') +
    `Create it first with action "update_group", or use ${DEFAULT_CHARACTERISTIC_GROUP} / ${DEFAULT_KEY_FIGURE_GROUP}.`
  );
}

export async function bwGetCompositeProvider(
  client: BwClient,
  compositeProviderName: string
): Promise<string> {
  const path = `/sap/bw/modeling/hcpr/${bwSeg(compositeProviderName)}/m`;
  // Fresh session, not this client: a session that has just written the object serves its
  // own pinned model buffer afterwards, which drops attributes the write did set.
  const result = await freshRead(path, HCPR_ACCEPT);

  const viewNodeTree = describeNodes(result.body);
  const xml = enterScope(result.body);
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
    const globalName = attr(compositeInlineType(elemBody), 'globalElementName');
    const navigationAttributes = elementNavigationAttributes(elemBody);
    const label = decodeXmlEntities(
      elemBody.match(/<localProperties\b[^>]*>([\s\S]*?)<\/localProperties>/)?.[1]
        .match(/<descriptions\b[^>]*\blabel="([^"]*)"/)?.[1] ??
        elemBody.match(/<endUserTexts\b[^>]*\blabel="([^"]*)"/)?.[1] ??
        ''
    );
    fields.push({
      name,
      ...(label ? { description: label } : {}),
      ...(infoObjectName ? { info_object_name: infoObjectName } : {}),
      ...(infoObjectName ? { name_usage: globalName ? 'direct' : 'unique_name' } : {}),
      dimension: dimName,
      is_key_figure: isKeyFigure,
      ...(navigationAttributes.length ? { navigation_attributes: navigationAttributes } : {}),
    });
  }

  const totalFields = fields.length;
  const keyFigureCount = fields.filter(f => f['is_key_figure']).length;
  const characteristicCount = totalFields - keyFigureCount;

  const groups = [...compositeGroups(xml)].map(([groupName, label]) => ({
    name: groupName,
    ...(label ? { label } : {}),
    field_count: fields.filter((f) => f['dimension'] === groupName).length,
  }));
  const ungroupedCount = fields.filter((f) => !f['dimension']).length;
  const uniqueNameCount = fields.filter((f) => f['name_usage'] === 'unique_name').length;
  const navigationAttributeCount = fields.reduce(
    (n, f) => n + ((f['navigation_attributes'] as string[] | undefined)?.length ?? 0),
    0
  );

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
      ...(nodeOfInput(im[0]) ? { view_node: nodeOfInput(im[0]) } : {}),
      ...(hanaViewOfInput(im[0]) ? { hana_view: hanaViewOfInput(im[0]) } : {}),
      mapping_count: allMappings.length,
      regular_mapping_count: allMappings.length - constantMappings.length,
      constant_mappings: constantMappings,
    });
  }

  const filterExpression = viewNodeMatch ? setNodeFilter(viewNodeMatch[0], '').previous : '';

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
    ...(viewNodeTree.length > 1 ? { view_nodes: viewNodeTree } : {}),
    ...(filterExpression ? { filter_expression: filterExpression } : {}),
    inputs,
    fields: {
      total: totalFields,
      characteristic_count: characteristicCount,
      key_figure_count: keyFigureCount,
      ...(ungroupedCount ? { ungrouped_count: ungroupedCount } : {}),
      // A query addresses such a field by "<prefix>-<ELEMENT>", not by its InfoObject name.
      ...(uniqueNameCount ? { unique_name_count: uniqueNameCount } : {}),
      ...(navigationAttributeCount ? { navigation_attribute_count: navigationAttributeCount } : {}),
      list: fields,
    },
    groups,
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
      inputs: [...readTemporalChoices(xml, viewNodeName)].map(([alias, choice]) => ({
        alias,
        ...(choice.showTimeDependent !== undefined ? { time_dependent_fields: choice.showTimeDependent } : {}),
        ...(choice.validFrom ? { valid_from_field: choice.validFrom, valid_to_field: choice.validTo } : {}),
        ...(choice.keyDate ? { key_date_field: choice.keyDate } : {}),
      })),
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

const HANA_VIEW_TYPES = ['calculationview', 'analyticview', 'attributeview'];
const HANA_VIEW_ACCEPT = 'application/vnd.sap.bw.modeling.hanv-v1_0_0+xml';
/** View type per SAP HANA view read in this process, needed to reference the view. */
const hanaViewTypes = new Map<string, string>();

/** A SAP HANA view is named "<package>::<view>", the way SAP HANA itself writes it. */
export function parseHanaViewName(providerName: string): { packageName: string; viewName: string } | undefined {
  const m = providerName.trim().match(/^([^:\s]+)::([^:\s]+)$/);
  return m ? { packageName: m[1], viewName: m[2] } : undefined;
}

/** Relative entity reference used inside `<input><entity>…</entity></input>`. */
export function buildEntityRef(providerName: string): string {
  const view = parseHanaViewName(providerName);
  if (view) {
    const type = hanaViewTypes.get(providerName.trim()) ?? HANA_VIEW_TYPES[0];
    return `../../../hana/repository/${view.packageName.replace(/\./g, '/')}/${view.viewName}.${type}#/`;
  }
  return `../../../infoprov_dt/a/${providerName.trim().toUpperCase()}.composite#//`;
}

/** "<package>::<view>" when the input is a SAP HANA view. */
function hanaViewOfInput(inputBlock: string): string | undefined {
  const name = nodeOfInput(inputBlock) ? undefined : extractProviderNameFromInput(inputBlock);
  return name && parseHanaViewName(name) ? name : undefined;
}

/** The alias segment of an input: the view type for a SAP HANA view, the provider type otherwise. */
function inputAliasType(providerName: string, providerType: string): string {
  return parseHanaViewName(providerName) ? (hanaViewTypes.get(providerName.trim()) ?? HANA_VIEW_TYPES[0]) : providerType;
}

/** ABAP data type a field of a SAP HANA view is given in a CompositeProvider. */
export function hanaFieldType(primitiveType: string, length: number, precision: number, scale: number): string | undefined {
  switch (primitiveType.toUpperCase()) {
    case 'CHAR': case 'NCHAR': case 'VARCHAR': case 'NVARCHAR': case 'ALPHANUM':
      return length > 0 ? `<inlineType name="CHAR" length="${length}" semanticType="empty"/>` : undefined;
    case 'INTEGER': case 'SMALLINT': case 'TINYINT':
      return '<inlineType name="INT4" length="10" semanticType="empty"/>';
    case 'BIGINT':
      return '<inlineType name="DEC" precision="18" scale="0" semanticType="empty"/>';
    case 'DECIMAL': case 'SMALLDECIMAL': case 'NUMERIC': {
      const digits = Math.min(precision || length || 17, 31);
      return `<inlineType name="DEC" precision="${digits}" scale="${Math.min(scale, digits)}" semanticType="empty"/>`;
    }
    case 'DOUBLE': case 'FLOAT': case 'REAL':
      return '<inlineType name="FLTP" length="16" semanticType="empty"/>';
    case 'DATE': case 'SECONDDATE': case 'TIMESTAMP':
      return '<inlineType name="DATS" length="8" semanticType="date"/>';
    case 'TIME':
      return '<inlineType name="TIMS" length="6" semanticType="empty"/>';
    default:
      return undefined;
  }
}

/** The fields of a SAP HANA view, in the shape the fields of a BW provider have. */
export function hanaViewFields(xml: string): SourceFieldMeta[] {
  const fields: SourceFieldMeta[] = [];
  for (const m of xml.matchAll(/<element\b((?:[^>/]|\/(?!>))*)(?:\/>|>([\s\S]*?)<\/element>)/g)) {
    const name = attr(m[1], 'name');
    if (!name) continue;
    const body = m[2] ?? '';
    const type = body.match(/<inlineType\b[^>]*/)?.[0] ?? '';
    const number = (key: string) => parseInt(attr(type, key) || '0', 10);
    // An input parameter of the view is listed as an element of its own type, with an ABAP type
    // already; BW takes its value from the field it is mapped to.
    const inlineTypeXml = /\bxsi:type="/.test(m[1])
      ? (attr(type, 'name') ? `${type.replace(/\/$/, '')}/>` : undefined)
      : hanaFieldType(attr(type, 'primitiveType'), number('length'), number('precision'), number('scale'));
    if (!inlineTypeXml) continue;
    const aggregation = attr(m[1], 'aggregationBehavior');
    fields.push({
      sourceName: name,
      defaultTargetName: name,
      label: decodeXmlEntities(body.match(/<endUserTexts label="([^"]*)"/)?.[1] ?? ''),
      inlineTypeXml,
      dataType: attr(inlineTypeXml, 'name'),
      isKeyFigure: Boolean(aggregation) && aggregation !== 'NONE',
      aggregationBehavior: aggregation || 'NONE',
      outputLength: 0,
      isMetaObject: false,
      compoundParents: [],
      parameterXml: body.match(/<Parameter\b(?:[^>/]|\/(?!>))*(?:\/>|>[\s\S]*?<\/Parameter>)/)?.[0],
    });
  }
  return fields;
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
    `<Composite:compositeView ${HCPR_XMLNS} schemaVersion="${hcprSchemaVersion()}" name="${nameUpper}" readOnly="false"` +
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

/** The document narrowed to the view node the call works on; `leaveScope` widens it before the PUT. */
async function readModel(name: string): Promise<Awaited<ReturnType<typeof freshRead>>> {
  const result = await freshRead(HCPR_PATH(name), HCPR_ACCEPT);
  return { ...result, body: enterScope(result.body) };
}

/** The fields of a view node, in the shape the fields of a source provider have. */
export function nodeSourceFields(nodeXml: string): SourceFieldMeta[] {
  const fields: SourceFieldMeta[] = [];
  for (const m of nodeXml.matchAll(/<element\b((?:[^>/]|\/(?!>))*)(?:\/>|>([\s\S]*?)<\/element>)/g)) {
    const body = m[2] ?? '';
    const name = attr(m[1], 'name');
    if (!name) continue;
    const inlineTypeXml = compositeInlineType(body);
    const outputLengthRaw = attr(m[1], 'outputLength');
    fields.push({
      sourceName: name,
      defaultTargetName: name,
      infoObjectName: attr(m[1], 'infoObjectName') || undefined,
      conversionType: attr(m[1], 'conversionType') || undefined,
      label: decodeXmlEntities(body.match(/<endUserTexts label="([^"]*)"/)?.[1] ?? ''),
      inlineTypeXml,
      dataType: attr(inlineTypeXml, 'name'),
      isKeyFigure: /LocalKeyfigureProperties/.test(body),
      aggregationBehavior: attr(m[1], 'aggregationBehavior') || 'NONE',
      conversionRoutine: attr(m[1], 'conversionRoutine') || undefined,
      fixedUnit: body.match(/<fixedUnit\b[^>]*>([^<]*)<\/fixedUnit>/)?.[1],
      fixedCurrency: body.match(/<fixedCurrency\b[^>]*>([^<]*)<\/fixedCurrency>/)?.[1],
      unitCurrencyRefBareName: body.match(/<unitCurrencyElement>#\/\/\/[^/<]*\/([^<]*)<\/unitCurrencyElement>/)?.[1],
      outputLength: outputLengthRaw ? parseInt(outputLengthRaw, 10) : 0,
      isMetaObject: false,
      compoundParents: [...body.matchAll(/<compoundInfoObjects?>#\/\/\/(?:[^/<]*\/)?([^<]+)<\/compoundInfoObjects?>/g)].map((c) => c[1]),
    });
  }
  return fields;
}

/** What an input reads from: a provider, or the view node below it. */
async function inputSource(inputBlock: string): Promise<{ providerName: string; fields: SourceFieldMeta[] } | undefined> {
  const node = nodeOfInput(inputBlock);
  if (node) {
    const parked = parkedNode(node);
    if (!parked) throw new Error(`View node ${node} below the input was not found.`);
    return { providerName: `view node ${node}`, fields: nodeSourceFields(parked.xml) };
  }
  const providerName = extractProviderNameFromInput(inputBlock);
  if (!providerName) return undefined;
  return { providerName, fields: (await fetchCompositeSourceFields(providerName)).fields };
}

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
  /** Name usage of a newly created, InfoObject-bound target element. */
  nameUsage?: NameUsage;
  /** Field group of a newly created target element. */
  dimension?: string;
}

const MAPPING_KEYS = ['target', 'source', 'constant_value', 'info_object_name', 'name_usage', 'dimension'];

/**
 * The `mappings` argument of the tool as field mappings. A key the tool does not know is
 * refused: dropping it would build the CompositeProvider without what the caller asked for.
 */
export function parseFieldMappings(raw: unknown): FieldMapping[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('mappings must be a list of objects.');
  return raw.map((m, i) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error(`mappings[${i}] must be an object.`);
    const entry = m as Record<string, unknown>;
    const unknown = Object.keys(entry).filter((k) => !MAPPING_KEYS.includes(k));
    if (unknown.length) {
      throw new Error(
        `mappings[${i}] has unknown key(s) ${unknown.join(', ')}; allowed: ${MAPPING_KEYS.join(', ')}. Nothing was changed.`
      );
    }
    if (typeof entry.target !== 'string' || !entry.target.trim()) throw new Error(`mappings[${i}] requires target.`);
    const text = (k: string) => (entry[k] === undefined || entry[k] === null ? undefined : String(entry[k]));
    const nameUsage = text('name_usage');
    if (nameUsage !== undefined && nameUsage !== 'direct' && nameUsage !== 'unique_name') {
      throw new Error(`mappings[${i}].name_usage must be "direct" or "unique_name".`);
    }
    return {
      target: entry.target,
      source: text('source'),
      constantValue: text('constant_value'),
      infoObjectName: text('info_object_name'),
      nameUsage: nameUsage as NameUsage | undefined,
      dimension: text('dimension'),
    };
  });
}

/** Defaults for every target element one call creates; a mapping's own setting wins. */
export interface NewElementDefaults {
  nameUsage?: NameUsage;
  dimension?: string;
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
  fixedCurrency?: string;
  unitCurrencyRefBareName?: string;
  outputLength: number;
  /** Set when the source models this field through an InfoObject rather than a plain field. */
  infoObjectName?: string;
  conversionType?: string;
  /** A technical element BW maintains itself (metaObject or a request field on the source). */
  isMetaObject: boolean;
  /** Bare names of the source fields this one is compounded to. */
  compoundParents: string[];
  /** A time-dependent attribute of a characteristic. */
  timeDependent?: boolean;
  /** Set for an input parameter of a SAP HANA view: its `<Parameter>` block. */
  parameterXml?: string;
  baseInfoObjectName?: string;
}

export interface CompoundingMapping {
  field: string;
  parent: string;
  target: string;
  /** Set when the field brought along is the unit or currency of a key figure, not a compounding parent. */
  unit?: boolean;
}

/** One sentence for the fields a mapping brought along. */
function broughtAlongNote(list: CompoundingMapping[]): string {
  const parents = list.filter((c) => !c.unit);
  const units = list.filter((c) => c.unit);
  return (
    (parents.length
      ? ' Also mapped, since a compounded field needs its compounding parent: ' +
        parents.map((c) => `${c.parent} -> ${c.target} (parent of ${c.field})`).join(', ') + '.'
      : '') +
    (units.length
      ? ' Also mapped, since an amount or quantity needs its currency or unit: ' +
        units.map((c) => `${c.parent} -> ${c.target} (of ${c.field})`).join(', ') + '.'
      : '')
  );
}

// Pure CUKY/UNIT fields are bound to the standard currency/unit characteristics at
// CompositeProvider level even when the source itself carries no InfoObject.
const AUTO_IOBJ_FOR_TYPE: Record<string, string> = { CUKY: '0CURRENCY', UNIT: '0UNIT' };

/**
 * Technical elements are left out of auto-mapping. BW maintains them itself as internal
 * attributes of the generated column view — the record count, the currency/unit dimension —
 * and mapping one as an ordinary element makes activation fail on that view ("… is missing
 * in node …"). BWMT does not offer them either. The source marks them metaObject; the row
 * count is listed by name as well for sources that do not. The request fields an aggregation
 * level exposes (object type DPA) count as technical too, and so does the InfoProvider
 * characteristic of a CompositeProvider below: activation refuses both as reserved names.
 * An explicit mapping still passes through, so the caller can override this.
 */
const AUTO_MAP_EXCLUDED = new Set(['1ROWCOUNT', '0INFOPROV']);

export function isTechnicalSourceElement(elementBody: string): boolean {
  const props = elementBody.match(/<consumptionViewProperties\b[^>]*/)?.[0] ?? '';
  return attr(props, 'metaObject') === 'true' || attr(props, 'objectType') === 'DPA';
}

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
  const hanaView = parseHanaViewName(providerName);
  if (hanaView) {
    const viewXml = (await freshRead(
      `/sap/bw/modeling/hana/repository/${encodeURIComponent(hanaView.packageName)}/${encodeURIComponent(hanaView.viewName)}`,
      HANA_VIEW_ACCEPT,
    )).body;
    const type = attr(viewXml.match(/<entity:Entity\b[^>]*/)?.[0] ?? '', 'objectType');
    if (HANA_VIEW_TYPES.includes(type)) hanaViewTypes.set(providerName.trim(), type);
    // A view has no generated field names; the prefix only says that the fields were read.
    return { fieldNamePrefix: hanaView.viewName, fields: hanaViewFields(viewXml) };
  }
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
      // InfoObject. Those carry no dimension unless the provider has field groups (an aDSO
      // with field groups, an aggregation level on it): then the group is the dimension.
      // Everything else — navigation attributes, and fields whose name was too long and got
      // hashed into "<prefix>-<hash>" — is not addressable as an input field.
      const fieldBased = Boolean(dimension) && name.startsWith(`${fieldNamePrefix}-`);
      // A navigation attribute is named "<BASE>__<ATTRIBUTE>" after its InfoObject as well.
      const infoObjectBased =
        !fieldBased && Boolean(sourceInfoObject) && name === sourceInfoObject && !name.includes('__');
      if (!name || (!fieldBased && !infoObjectBased)) continue;

      const inlineTypeXml = compositeInlineType(body);
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
        fixedUnit: body.match(/<fixedUnit\b[^>]*>([^<]*)<\/fixedUnit>/)?.[1],
        fixedCurrency: body.match(/<fixedCurrency\b[^>]*>([^<]*)<\/fixedCurrency>/)?.[1],
        // A field of the provider itself carries the provider prefix, an InfoObject its bare name.
        unitCurrencyRefBareName: unitCurrencyRaw?.startsWith(refPrefix)
          ? unitCurrencyRaw.slice(refPrefix.length)
          : unitCurrencyRaw?.startsWith('#///') && !unitCurrencyRaw.slice(4).includes('/')
            ? unitCurrencyRaw.slice(4)
            : undefined,
        outputLength: outputLengthRaw ? parseInt(outputLengthRaw, 10) : 0,
        isMetaObject: isTechnicalSourceElement(body),
        timeDependent: attr(elemAttrs, 'timeDependent') === 'true' || undefined,
        baseInfoObjectName: attr(elemAttrs, 'baseInfoObjectName') || undefined,
        compoundParents: [...body.matchAll(/<compoundInfoObject>#\/\/\/([^<]+)<\/compoundInfoObject>/g)]
          .map((c) => (c[1].startsWith(`${fieldNamePrefix}-`) ? c[1].slice(fieldNamePrefix.length + 1) : c[1])),
      });
    }
  }

  return { fieldNamePrefix, lastModified, fields };
}

/** Build the target element block for a field that the CompositeProvider does not have yet. */
interface TargetElementOptions {
  infoObjectNameOverride?: string;
  nameUsage?: NameUsage;
  /** Field group, already resolved and declared. */
  group: string;
}

/**
 * The InfoObject a new target element is bound to, if any: the source's own, the one the
 * caller names, or the standard currency/unit characteristic for a pure CUKY/UNIT field.
 */
function targetInfoObject(field: SourceFieldMeta, override?: string): string | undefined {
  return field.infoObjectName ?? override ?? AUTO_IOBJ_FOR_TYPE[field.dataType];
}

function buildTargetElementXml(
  field: SourceFieldMeta,
  targetName: string,
  nodeName: string,
  resolveUnitCurrencyTarget: (bareSourceName: string) => string | undefined,
  opts: TargetElementOptions
): string {
  const infoObjectName = targetInfoObject(field, opts.infoObjectNameOverride);
  const direct = opts.nameUsage === 'direct';
  const inlineType = field.inlineTypeXml
    ? withGlobalElementName(field.inlineTypeXml, direct ? infoObjectName : undefined)
    : '';
  const dimensionAttr = `dimension="${groupRef(opts.group)}"`;
  // A directly used InfoObject brings its authorization relevance along; BWMT drops the
  // local override when switching an element to direct usage.
  const authorizationLine = direct ? [] : [`      <authorizationRelevant>N</authorizationRelevant>`];
  const fixedLines = [
    ...(field.fixedCurrency ? [`    <fixedCurrency>${field.fixedCurrency}</fixedCurrency>`] : []),
    ...(field.fixedUnit ? [`    <fixedUnit>${field.fixedUnit}</fixedUnit>`] : []),
  ];

  // A field the source models through an InfoObject is rebuilt in the shape an active
  // CompositeProvider uses for it: the label in endUserTexts and the association back to
  // the InfoObject. See payloads/hcpr_add_input_infoobject_based.md.
  if (field.infoObjectName) {
    const iobjAttrs = [
      `name="${targetName}"`,
      ...(field.isKeyFigure ? [`aggregationBehavior="${field.aggregationBehavior}"`] : []),
      `infoObjectName="${field.infoObjectName}"`,
      dimensionAttr,
      ...(field.conversionRoutine ? [`conversionRoutine="${field.conversionRoutine}"`] : []),
      ...(field.conversionType ? [`conversionType="${field.conversionType}"`] : []),
      ...(field.outputLength ? [`outputLength="${field.outputLength}"`] : []),
    ].join(' ');
    const iobjLines = [`  <element xsi:type="BwCore:BwElement" ${iobjAttrs}>`];
    iobjLines.push(`    <endUserTexts label="${escapeXmlAttr(field.label)}"/>`);
    if (inlineType) iobjLines.push(`    ${inlineType}`);
    iobjLines.push(...fixedLines);
    if (field.isKeyFigure) {
      iobjLines.push(`    <localProperties xsi:type="BwCore:LocalKeyfigureProperties"/>`);
      const semantics = SEMANTICS_TAG[field.dataType];
      if (semantics) iobjLines.push(`    <semantics>${semantics}</semantics>`);
    } else if (authorizationLine.length) {
      iobjLines.push(`    <localProperties xsi:type="BwCore:LocalCharacteristicProperties">`);
      iobjLines.push(...authorizationLine);
      iobjLines.push(`    </localProperties>`);
    } else {
      iobjLines.push(`    <localProperties xsi:type="BwCore:LocalCharacteristicProperties"/>`);
    }
    iobjLines.push(`    <associationType>1</associationType>`);
    iobjLines.push(`  </element>`);
    return iobjLines.join('\n');
  }

  const attrs = [
    `name="${targetName}"`,
    `aggregationBehavior="${field.aggregationBehavior}"`,
    ...(infoObjectName ? [`infoObjectName="${infoObjectName}"`] : []),
    ...(field.conversionRoutine ? [`conversionRoutine="${field.conversionRoutine}"`] : []),
    dimensionAttr,
    `outputLength="${field.outputLength}"`,
  ].join(' ');

  const label = escapeXmlAttr(field.label);
  // An input parameter of a SAP HANA view needs a parameter as its target, with the same definition.
  const elementType = field.parameterXml ? 'BwCore:RestrictedBwElement' : 'BwCore:BwElement';
  const lines: string[] = [`  <element xsi:type="${elementType}" ${attrs}>`];
  if (inlineType) lines.push(`    ${inlineType}`);
  lines.push(...fixedLines);
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
    lines.push(...authorizationLine);
    lines.push(`    </localProperties>`);
    if (infoObjectName) lines.push(`    <associationType>1</associationType>`);
  }
  if (field.parameterXml) lines.push(`    ${field.parameterXml}`);
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
  existingXml: string,
  defaults: NewElementDefaults = {},
  ownAlias?: string
): { mappingsXml: string[]; newElementsXml: string[]; groups: Set<string>; compounding: CompoundingMapping[] } {
  const fedByOthers = (target: string) =>
    [...existingXml.matchAll(/<input\b[^>]*>[\s\S]*?<\/input>/g)].some((block) =>
      attr(block[0].match(/<input\b[^>]*>/)?.[0] ?? '', 'alias') !== ownAlias &&
      [...block[0].matchAll(/<mapping\b[^>]*>/g)].some((mapping) => attr(mapping[0], 'targetName') === target));
  // A compounded field needs its compounding parent as a field of the CompositeProvider
  // ("compounding parent … is missing for field …"). The modeling tools map the parents of
  // a compounded source field along with it; a parent the caller maps itself is left alone.
  const compounding: CompoundingMapping[] = [];
  const byBare = new Map(fields.map((f) => [f.defaultTargetName, f]));
  const sourceOf = (m: FieldMapping) => (m.source ?? m.target).trim().toUpperCase();
  mappings = [...mappings];
  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i];
    if (m.constantValue !== undefined) continue;
    const field = byBare.get(sourceOf(m));
    for (const parent of field?.compoundParents ?? []) {
      const parentField = byBare.get(parent);
      if (!parentField || mappings.some((o) => o.constantValue === undefined && sourceOf(o) === parent)) continue;
      // A field bound to the parent's InfoObject, whichever input feeds it, satisfies the rule.
      const present = parentField.infoObjectName !== undefined &&
        [...existingXml.matchAll(/<element\b[^>]*>/g)].some((e) => attr(e[0], 'infoObjectName') === parentField.infoObjectName);
      if (present) continue;
      const target = shortenTargetName(parent);
      mappings.splice(i, 0, { target, source: parent });
      compounding.push({ field: m.target.trim().toUpperCase(), parent, target });
      i++;
    }
    // An amount or quantity needs its currency or unit as a field ("no currency information
    // for amount key figure …"); the modeling tools map it along with the key figure.
    const unit = field?.unitCurrencyRefBareName;
    const unitField = unit ? byBare.get(unit) : undefined;
    if (unit && unitField && !mappings.some((o) => o.constantValue === undefined && sourceOf(o) === unit)) {
      const target = shortenTargetName(unit);
      const present = [...existingXml.matchAll(/<element\b[^>]*>/g)].find((e) =>
        attr(e[0], 'name') === target ||
        (unitField.infoObjectName !== undefined && attr(e[0], 'infoObjectName') === unitField.infoObjectName));
      // In a union every input feeds the field; elsewhere only one input may.
      if (!present || getViewNodeType(existingXml) === 'Union' || !fedByOthers(attr(present[0], 'name'))) {
        const onto = present ? attr(present[0], 'name') : target;
        mappings.splice(i + 1, 0, { target: onto, source: unit });
        compounding.push({ field: m.target.trim().toUpperCase(), parent: unit, target: onto, unit: true });
      }
    }
  }

  const byBareName = new Map(fields.map((f) => [f.defaultTargetName, f]));
  const cpUpper = existingXml.match(/<Composite:compositeView\b[^>]*\bname="([^"]*)"/)?.[1] ?? '';
  // Two elements using the same InfoObject directly would both answer to its name.
  const directNames = directlyUsedNames(existingXml);
  const groups = new Set<string>();

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
    const elementRe = new RegExp(`<element\\b[^>]*\\bname="${escapeRegex(target)}"`);
    const exists = elementRe.test(existingXml) || newElementsXml.some((block) => elementRe.test(block));
    if (!exists) {
      const infoObjectName = targetInfoObject(field, m.infoObjectName);
      const nameUsage = resolveNameUsage(m.nameUsage ?? defaults.nameUsage, target, infoObjectName);
      if (nameUsage === 'direct' && infoObjectName) {
        if (directNames.has(infoObjectName)) {
          throw new Error(
            `InfoObject ${infoObjectName} is already used directly by another element of CompositeProvider ` +
            `${cpUpper}, so ${target} cannot use it directly as well. Map onto that element, or pass ` +
            `name_usage "unique_name" for ${target}.`
          );
        }
        directNames.add(infoObjectName);
      }
      const group = resolveGroup(existingXml, m.dimension ?? defaults.dimension, field.isKeyFigure, cpUpper);
      groups.add(group);
      newElementsXml.push(
        buildTargetElementXml(field, target, nodeName, (bare) => targetNameByBareSource.get(bare), {
          infoObjectNameOverride: m.infoObjectName,
          nameUsage,
          group,
        })
      );
    }
  }
  return { mappingsXml, newElementsXml, groups, compounding };
}

function declareGroups(xml: string, groups: Iterable<string>): string {
  for (const group of groups) xml = ensureGroupDeclared(xml, group);
  return xml;
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
  viewNodeType: 'Join' | 'Union' | undefined,
  ownAlias?: string
): FieldMapping[] {
  const usedInBatch = new Set<string>();
  // In a join a name counts as taken only while another input feeds it. A field no input
  // feeds — left behind by a removed input, or fed by the very input being remapped — is
  // reused; suffixing past it would leave an empty duplicate of the same InfoObject behind.
  const fedByOthers = new Set(
    [...existingXml.matchAll(/<input\b[^>]*>[\s\S]*?<\/input>/g)]
      .filter((m) => attr(m[0].match(/<input\b[^>]*>/)?.[0] ?? '', 'alias') !== ownAlias)
      .flatMap((m) => [...m[0].matchAll(/<mapping\b[^>]*>/g)].map((mapping) => attr(mapping[0], 'targetName'))),
  );
  const taken = [...fedByOthers].map((name) => `<element name="${name}"`).join('');
  return fields.filter((f) => !f.isMetaObject && !AUTO_MAP_EXCLUDED.has(f.defaultTargetName)).map((f) => {
    const desired = shortenTargetName(f.defaultTargetName);
    const target =
      viewNodeType === 'Union'
        ? dedupeTargetName(desired, '', usedInBatch)
        : dedupeTargetName(desired, taken, usedInBatch);
    usedInBatch.add(target);
    return { target, source: f.defaultTargetName };
  });
}

/** Next free alias for a view node and provider type, continuing BW's own numbering. */
function nextInputAlias(xml: string, nodeName: string, providerType: string): string {
  const type = HANA_VIEW_TYPES.includes(providerType.trim()) ? providerType.trim() : providerType.trim().toUpperCase();
  const re = new RegExp(`alias="${escapeRegex(nodeName)}\\.${escapeRegex(type)}\\.(\\d+)"`, 'g');
  let max = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) max = Math.max(max, parseInt(m[1], 10));
  return `${nodeName}.${type}.${max + 1}`;
}

/** Extracts the source provider name from an input's entity reference. */
function extractProviderNameFromInput(inputBlock: string): string | undefined {
  const view = inputBlock.match(
    /<entity>(?:[^<]*hana\/repository\/)?([^<#]+)\/([^<#/]+)\.(calculationview|analyticview|attributeview)#\/<\/entity>/);
  if (view) {
    const name = `${view[1].replace(/\//g, '.')}::${view[2]}`;
    hanaViewTypes.set(name, view[3]);
    return name;
  }
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
  opts: { input?: InputProviderDef; inputAlias?: string; transport?: string; defaults?: NewElementDefaults } = {}
): Promise<string> {
  const { input, inputAlias, transport, defaults } = opts;
  const cpUpper = compositeProviderName.toUpperCase();
  const cpResult = await readModel(compositeProviderName);
  const timestamp = cpResult.headers['timestamp'] ?? cpResult.headers['TIMESTAMP'];
  let xml = cpResult.body;

  let message: string;
  let resultAlias: string | undefined;
  let compoundingAdded: CompoundingMapping[] = [];

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
    // The join that names the input stays: a join node saved without any join element ends in
    // a runtime error on the server. It is replaced when the condition is set again.
    const joins = joinsOfInput(xml, alias);
    message =
      `Input ${alias} removed from CompositeProvider ${cpUpper}.` +
      (joins > 0
        ? ` ${joins} join condition(s) still name it: a join node needs two inputs again and its condition set ` +
          'anew ("add_input", then "update_join") before it activates.'
        : '') +
      ' Call bw_activate to activate.';
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

    const alias = nextInputAlias(xml, nodeName, inputAliasType(input.providerName, input.providerType));
    const { mappingsXml, newElementsXml, groups, compounding } = resolveMappings(
      requested, fields, input.providerName, nodeName, xml, defaults
    );
    compoundingAdded = compounding;
    xml = openViewNode(xml);

    if (newElementsXml.length > 0) {
      xml = injectBeforeAnchor(xml, newElementsXml.join('\n'), ['<input', '<join'], '</viewNode>');
    }
    xml = declareGroups(xml, groups);
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
      `with ${mappingsXml.length} mapping(s). Call bw_activate to activate.` +
      broughtAlongNote(compounding);
  }

  xml = await keepTemporalJoin(xml);
  const lockHandle = await client.lock('hcpr', compositeProviderName);
  try {
    await client.put('hcpr', compositeProviderName, lockHandle, leaveScope(xml), timestamp, transport);
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
    ...(compoundingAdded.length ? { compounding_parents_mapped: compoundingAdded } : {}),
  });
}

/**
 * The name a mapped source field has on another provider. A field-based provider prefixes its
 * fields with its own name, so the field is looked up by its bare name; the attribute part of a
 * navigation attribute is carried over as it is.
 */
export function translateSourceName(
  sourceName: string,
  oldFields: SourceFieldMeta[],
  newFields: SourceFieldMeta[],
): string | undefined {
  const cut = sourceName.search(/=|__/);
  const base = cut > 0 ? sourceName.slice(0, cut) : sourceName;
  const suffix = cut > 0 ? sourceName.slice(cut) : '';
  const bare =
    oldFields.find((f) => f.sourceName === base)?.defaultTargetName ?? base.slice(base.lastIndexOf('-') + 1);
  const found = newFields.find((f) => f.defaultTargetName === bare && !f.isMetaObject);
  return found ? found.sourceName + suffix : undefined;
}

export interface ReplacedInput {
  xml: string;
  kept: number;
  /** Mappings whose source field the new provider does not have. */
  dropped: Array<{ target: string; source: string }>;
}

/**
 * Put another provider in the place of one input. The mappings stay where the new provider has
 * a field of the same name, constants stay as they are, and the joins that name the input name
 * the new one, with their keys translated. A join key the new provider lacks is an error:
 * the condition has to be changed first.
 */
export function replaceInput(
  xml: string,
  alias: string,
  by: { alias: string; providerName: string; lastModified?: string },
  translate: (sourceName: string) => string | undefined,
): ReplacedInput {
  const block = inputBlockOf(xml, alias);
  if (!block) throw new Error(`Input ${alias} not found.`);
  const dropped: Array<{ target: string; source: string }> = [];
  const mappings: string[] = [];
  for (const m of block.matchAll(/<mapping\b[^>]*\/>/g)) {
    if (m[0].includes('ConstantElementMapping')) {
      mappings.push(`    ${m[0]}`);
      continue;
    }
    const source = attr(m[0], 'sourceName');
    const target = attr(m[0], 'targetName');
    const translated = translate(source);
    if (translated === undefined) {
      dropped.push({ target, source });
      continue;
    }
    mappings.push(`    <mapping xsi:type="Type:ElementMapping" targetName="${target}" sourceName="${translated}"/>`);
  }
  const lastModifiedAttr = by.lastModified ? ` lastModified="${by.lastModified}"` : '';
  const newBlock =
    `<input xsi:type="Composite:CompositeInput" alias="${by.alias}" selectAll="false"` +
    ` hiddenNavigationAttributes="true" hiddenTemporalFields="false"${lastModifiedAttr}>\n` +
    `    <entity>${buildEntityRef(by.providerName)}</entity>\n` +
    (mappings.length ? `${mappings.join('\n')}\n` : '') +
    `  </input>`;
  let out = xml.replace(block, () => newBlock);

  out = out.replace(/<join\b([^>]*)>([\s\S]*?)<\/join>/g, (join, head: string, body: string) => {
    const isLeft = attr(head, 'leftInput').replace(/^.*\//, '') === alias;
    const isRight = attr(head, 'rightInput').replace(/^.*\//, '') === alias;
    if (!isLeft && !isRight) return join;
    const side = (tag: string, text: string) =>
      text.replace(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'), (_all, key: string) => {
        const translated = translate(key);
        if (translated === undefined) {
          throw new Error(
            `Join key ${key} of input ${alias} does not exist on ${by.providerName.toUpperCase()}. ` +
            'Change the join condition first ("update_join"), then replace the input.',
          );
        }
        return `<${tag}>${translated}</${tag}>`;
      });
    let newBody = body;
    let newHead = head;
    const swap = (name: string) =>
      newHead.replace(new RegExp(`(\\b${name}="[^"]*/)${escapeRegex(alias)}"`), (_all, lead: string) => `${lead}${by.alias}"`);
    if (isLeft) {
      newBody = side('leftElementName', newBody);
      newHead = swap('leftInput');
    }
    if (isRight) {
      newBody = side('rightElementName', newBody);
      newHead = swap('rightInput');
    }
    return `<join${newHead}>${newBody}</join>`;
  });
  return { xml: out, kept: mappings.length, dropped };
}

/**
 * bw_update_composite_provider action "replace_input" — put another provider in the place of
 * one input and keep the mappings and joins that still fit.
 */
export async function bwReplaceCompositeProviderInput(
  client: BwClient,
  compositeProviderName: string,
  inputAlias: string,
  input: { providerName: string; providerType: string },
  transport?: string,
): Promise<string> {
  const cpUpper = compositeProviderName.toUpperCase();
  const alias = (inputAlias ?? '').trim();
  if (!alias) throw new Error('replace_input requires input_alias.');
  if (!input.providerName) throw new Error('replace_input requires provider_name.');
  const cpResult = await readModel(compositeProviderName);
  const timestamp = cpResult.headers['timestamp'] ?? cpResult.headers['TIMESTAMP'];
  const xml = cpResult.body;
  const block = inputBlockOf(xml, alias);
  if (!block) {
    return JSON.stringify({
      success: false,
      message: `Input ${alias} not found in CompositeProvider ${cpUpper}. No changes made.`,
    });
  }
  if (nodeOfInput(block)) {
    throw new Error(`Input ${alias} is the view node ${nodeOfInput(block)}, not a provider. Remove the node ("remove_node") and add the provider ("add_input").`);
  }
  const nodeName = getViewNodeName(xml);
  const oldProvider = extractProviderNameFromInput(block);
  // The provider being replaced may be gone; its field names are then taken as they stand.
  const oldFields = oldProvider
    ? (await fetchCompositeSourceFields(oldProvider).catch(() => ({ fields: [] as SourceFieldMeta[] }))).fields
    : [];
  const { lastModified, fields: newFields } = await fetchCompositeSourceFields(input.providerName);
  const newAlias = nextInputAlias(xml, nodeName, inputAliasType(input.providerName, input.providerType));
  const result = replaceInput(
    xml, alias,
    { alias: newAlias, providerName: input.providerName, lastModified },
    (sourceName) => translateSourceName(sourceName, oldFields, newFields),
  );
  result.xml = await keepTemporalJoin(result.xml);
  const lockHandle = await putModel(client, compositeProviderName, result.xml, timestamp, transport);
  return JSON.stringify({
    success: true,
    message:
      `Input ${alias}${oldProvider ? ` (${oldProvider.toUpperCase()})` : ''} of CompositeProvider ${cpUpper} replaced by ` +
      `${input.providerName.toUpperCase()} as ${newAlias}; ${result.kept} mapping(s) kept.` +
      (result.dropped.length
        ? ` ${result.dropped.length} mapping(s) dropped, since the new provider has no field of that name: ` +
          result.dropped.map((d) => `${d.source} -> ${d.target}`).join(', ') +
          '. Their target fields stay and can be mapped anew ("update_mapping").'
        : '') +
      ' Call bw_activate to activate.',
    input_alias: newAlias,
    ...(result.dropped.length ? { dropped_mappings: result.dropped } : {}),
    lock_handle: lockHandle,
    composite_provider_name: cpUpper,
    object_type: 'hcpr',
  });
}

const NODE_KINDS: Record<string, NodeKind> = {
  join: 'Join', union: 'Union', projection: 'Projection', aggregation: 'Aggregation',
};

/**
 * bw_update_composite_provider action "insert_node" — put a join, union, projection or
 * aggregation node above one input, or above the default node when no input is named.
 * A join node needs its second input right away, so it takes a provider.
 */
export async function bwInsertCompositeProviderNode(
  client: BwClient,
  compositeProviderName: string,
  opts: { nodeType?: string; inputAlias?: string; providerName?: string; providerType?: string; transport?: string },
): Promise<string> {
  const cpUpper = compositeProviderName.toUpperCase();
  const kind = NODE_KINDS[(opts.nodeType ?? '').trim().toLowerCase()];
  if (!kind) throw new Error('insert_node requires node_type: join, union, projection or aggregation.');
  if (kind === 'Join' && !opts.providerName) {
    throw new Error('insert_node with node_type "join" requires provider_name: the provider the new node joins.');
  }
  const cpResult = await freshRead(HCPR_PATH(compositeProviderName), HCPR_ACCEPT);
  refuseOnTemporalJoin(cpResult.body, 'insert_node', cpUpper);
  const timestamp = cpResult.headers['timestamp'] ?? cpResult.headers['TIMESTAMP'];
  const alias = opts.inputAlias?.trim();
  const inserted = alias
    ? insertNodeAboveInput(cpResult.body, alias, kind)
    : insertNodeAboveRoot(cpResult.body, kind);
  let xml = inserted.xml;
  let partnerAlias: string | undefined;
  if (kind === 'Join' && opts.providerName) {
    const { lastModified } = await fetchCompositeSourceFields(opts.providerName);
    partnerAlias = nextInputAlias(xml, inserted.node, opts.providerType ?? 'ADSO');
    const lastModifiedAttr = lastModified ? ` lastModified="${lastModified}"` : '';
    xml = addJoinPartner(
      xml, inserted.node,
      `<input xsi:type="Composite:CompositeInput" alias="${partnerAlias}" selectAll="false"` +
      ` hiddenNavigationAttributes="true" hiddenTemporalFields="false"${lastModifiedAttr}>` +
      `<entity>${buildEntityRef(opts.providerName)}</entity></input>`,
      partnerAlias,
    );
  }
  const lockHandle = await putModel(client, compositeProviderName, xml, timestamp, opts.transport);
  return JSON.stringify({
    success: true,
    message:
      `View node ${inserted.node} (${kind}) inserted into CompositeProvider ${cpUpper} ` +
      (inserted.parent ? `above input ${alias}, as an input of node ${inserted.parent}` : 'on top; it is the default node now') +
      ` with ${inserted.fields.length} field(s).` +
      (partnerAlias
        ? ` ${opts.providerName!.toUpperCase()} is its second input ${partnerAlias}, without mappings and without a join condition: ` +
          `set them with "update_mapping" and "update_join" and node "${inserted.node}".`
        : ` Address the node in further calls with node "${inserted.node}".`) +
      ' Call bw_activate to activate.',
    node: inserted.node,
    ...(inserted.parent ? { input_of: inserted.parent } : {}),
    ...(partnerAlias ? { input_alias: partnerAlias } : {}),
    lock_handle: lockHandle,
    composite_provider_name: cpUpper,
    object_type: 'hcpr',
  });
}

/**
 * bw_update_composite_provider action "remove_node" — take a view node out together with
 * the nodes below it.
 */
export async function bwRemoveCompositeProviderNode(
  client: BwClient,
  compositeProviderName: string,
  nodeName: string | undefined,
  transport?: string,
): Promise<string> {
  const cpUpper = compositeProviderName.toUpperCase();
  if (!nodeName?.trim()) throw new Error('remove_node requires node.');
  const cpResult = await freshRead(HCPR_PATH(compositeProviderName), HCPR_ACCEPT);
  refuseOnTemporalJoin(cpResult.body, 'remove_node', cpUpper);
  const timestamp = cpResult.headers['timestamp'] ?? cpResult.headers['TIMESTAMP'];
  const result = removeNode(cpResult.body, nodeName.trim());
  const lockHandle = await putModel(client, compositeProviderName, result.xml, timestamp, transport);
  return JSON.stringify({
    success: true,
    message:
      `View node(s) ${result.removed.join(', ')} removed from CompositeProvider ${cpUpper}.` +
      (result.parent
        ? ` Node ${result.parent} lost the input; its fields stay and can be fed by another input ("add_input" with node "${result.parent}").`
        : '') +
      ' Call bw_activate to activate.',
    removed_nodes: result.removed,
    lock_handle: lockHandle,
    composite_provider_name: cpUpper,
    object_type: 'hcpr',
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
  transport?: string,
  defaults?: NewElementDefaults
): Promise<string> {
  const cpUpper = compositeProviderName.toUpperCase();
  const alias = inputAlias.trim();
  const cpResult = await readModel(compositeProviderName);
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

  const source = await inputSource(inputMatch[0]);
  if (!source) {
    throw new Error(`Could not determine the source InfoProvider for input ${alias}.`);
  }
  const { providerName, fields } = source;
  const nodeName = getViewNodeName(xml);

  const effective = mappings.length > 0 ? mappings : buildAutoMappings(fields, xml, getViewNodeType(xml), alias);
  const { mappingsXml, newElementsXml, groups, compounding } = resolveMappings(
    effective, fields, providerName, nodeName, xml, defaults, alias
  );

  if (newElementsXml.length > 0) {
    xml = injectBeforeAnchor(openViewNode(xml), newElementsXml.join('\n'), ['<input', '<join'], '</viewNode>');
  }
  xml = declareGroups(xml, groups);
  xml = ensureNamespace(xml, 'BwCore', 'http://www.sap.com/bw/modeling/BwCore.ecore');
  xml = ensureNamespace(xml, 'Type', 'http://www.sap.com/ndb/DataModelType.ecore');

  // Keep the input's opening tag and entity reference, replace only the mapping list.
  const dateElements = inputDateElements(
    xml.match(new RegExp(`<input\\b[^>]*\\balias="${escapeRegex(alias)}"[^>]*>[\\s\\S]*?<\\/input>`))?.[0] ?? '');
  xml = xml.replace(
    new RegExp(
      `(<input\\b[^>]*\\balias="${escapeRegex(alias)}"[^>]*>\\s*(?:<entity>[^<]*<\\/entity>|<nodeRef\\b[^>]*>[^<]*<\\/nodeRef>))[\\s\\S]*?(<\\/input>)`
    ),
    (_all, head: string, tail: string) => `${head}\n${mappingsXml.join('\n')}\n  ${dateElements}${tail}`
  );

  // Replacing a mapping list can leave fields behind that no input feeds any more.
  const mappedTargetNames = new Set([...xml.matchAll(/<mapping\b[^>]*>/g)].map((m) => attr(m[0], 'targetName')));
  const unmapped = [...xml.slice(0, xml.indexOf('<input')).matchAll(/<element\b[^>]*>/g)]
    .map((e) => attr(e[0], 'name'))
    .filter((name) => name && !mappedTargetNames.has(name));

  const lockHandle = await client.lock('hcpr', compositeProviderName);
  try {
    await client.put('hcpr', compositeProviderName, lockHandle, leaveScope(xml), timestamp, transport);
  } catch (err) {
    await client.unlock('hcpr', compositeProviderName).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message:
      `Mappings for input ${alias} in CompositeProvider ${cpUpper} replaced ` +
      `(${mappingsXml.length} mapping(s)). Call bw_activate to activate.` +
      broughtAlongNote(compounding) +
      (unmapped.length
        ? ` Fields without a mapping from any input now: ${unmapped.join(', ')}; remove them with "remove_field" or map them.`
        : ''),
    lock_handle: lockHandle,
    composite_provider_name: cpUpper,
    object_type: 'hcpr',
    input_alias: alias,
    ...(compounding.length ? { compounding_parents_mapped: compounding } : {}),
    ...(unmapped.length ? { unmapped_fields: unmapped } : {}),
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
  const cpResult = await readModel(compositeProviderName);
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
    await client.put('hcpr', compositeProviderName, lockHandle, leaveScope(xml), timestamp, settings.transport);
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

// ── bw_update_composite_provider: field groups and name usage ────────────────

async function putModel(
  client: BwClient,
  compositeProviderName: string,
  xml: string,
  timestamp: string | undefined,
  transport?: string
): Promise<string> {
  const lockHandle = await client.lock('hcpr', compositeProviderName);
  try {
    await client.put('hcpr', compositeProviderName, lockHandle, leaveScope(xml), timestamp, transport);
  } catch (err) {
    await client.unlock('hcpr', compositeProviderName).catch(() => {/* ignore */});
    throw err;
  }
  return lockHandle;
}

/** The `<element>` block of one CompositeProvider field, taken from the view node only. */
function findViewElement(xml: string, fieldName: string): string | undefined {
  const viewNode = xml.match(/<viewNode\b[\s\S]*?<\/viewNode>/)?.[0] ?? '';
  return viewNode.match(
    new RegExp(`<element\\b[^>]*\\bname="${escapeRegex(fieldName)}"[^>]*?(?:\\/>|>[\\s\\S]*?<\\/element>)`)
  )?.[0];
}

function setElementAttr(openTag: string, key: string, value: string): string {
  const existing = new RegExp(`\\s${key}="[^"]*"`);
  return existing.test(openTag)
    ? openTag.replace(existing, ` ${key}="${value}"`)
    : openTag.replace(/^(<element\b)/, `$1 ${key}="${value}"`);
}

/**
 * bw_update_composite_provider action "update_fields" — move existing fields into a field
 * group and/or switch how an InfoObject-bound field is exposed (see NameUsage).
 */
export async function bwUpdateCompositeProviderFields(
  client: BwClient,
  compositeProviderName: string,
  fieldNames: string[],
  opts: { dimension?: string; nameUsage?: NameUsage; description?: string; newName?: string; transport?: string }
): Promise<string> {
  const cpUpper = compositeProviderName.toUpperCase();
  const { dimension, nameUsage, description, transport } = opts;
  const newName = opts.newName?.trim().toUpperCase();
  if (fieldNames.length === 0) throw new Error('update_fields requires info_object_name (one or more field names).');
  if (dimension === undefined && nameUsage === undefined && description === undefined && newName === undefined) {
    throw new Error('update_fields requires dimension, name_usage, field_description and/or new_field_name.');
  }
  if (newName !== undefined) {
    if (fieldNames.length !== 1) throw new Error('new_field_name renames one field: pass exactly one field in info_object_name.');
    if (!/^[A-Z0-9_/][A-Z0-9_/]{0,29}$/.test(newName)) throw new Error(`"${opts.newName}" is not a field name: up to 30 characters, letters, digits and underscores.`);
  }

  const cpResult = await readModel(compositeProviderName);
  const timestamp = cpResult.headers['timestamp'] ?? cpResult.headers['TIMESTAMP'];
  let xml = cpResult.body;

  const changed: Array<Record<string, string>> = [];
  const skipped: Array<{ field: string; reason: string }> = [];
  const groups = new Set<string>();

  for (const raw of fieldNames) {
    const field = raw.trim().toUpperCase();
    const element = findViewElement(xml, field);
    if (!element) {
      skipped.push({ field, reason: `not a field of CompositeProvider ${cpUpper}` });
      continue;
    }
    const openTag = element.match(/^<element\b[^>]*?\/?>/)?.[0] ?? '';
    let newOpen = openTag;
    let newElement = element;
    const result: Record<string, string> = { field };

    if (dimension !== undefined) {
      const isKeyFigure = /<localProperties\b[^>]*LocalKeyfigureProperties/.test(element);
      const group = resolveGroup(xml, dimension, isKeyFigure, cpUpper);
      groups.add(group);
      newOpen = setElementAttr(newOpen, 'dimension', groupRef(group));
      result['dimension'] = group;
    }

    if (nameUsage !== undefined) {
      const infoObjectName = attr(openTag, 'infoObjectName');
      const inlineType = element.match(/<inlineType\b[^>]*\/>/)?.[0];
      if (!infoObjectName) {
        skipped.push({ field, reason: 'a plain field without an InfoObject has no name usage to switch' });
        continue;
      }
      if (!inlineType) {
        skipped.push({ field, reason: 'the element carries no inlineType; remove and re-add the field' });
        continue;
      }
      if (nameUsage === 'direct') {
        const alreadyDirect = attr(inlineType, 'globalElementName') === infoObjectName;
        if (!alreadyDirect && directlyUsedNames(xml).has(infoObjectName)) {
          skipped.push({ field, reason: `InfoObject ${infoObjectName} is already used directly by another element` });
          continue;
        }
        newElement = newElement
          .replace(inlineType, withGlobalElementName(inlineType, infoObjectName))
          .replace(/\s*<authorizationRelevant>[^<]*<\/authorizationRelevant>/, '');
      } else {
        newElement = withLocalNavigationAttributeNames(
          newElement.replace(inlineType, withGlobalElementName(inlineType, undefined)),
          usedFieldNames(xml)
        );
      }
      result['name_usage'] = nameUsage;
    }

    if (description !== undefined) {
      const label = description.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      // The text of a field is a local property: the server puts the InfoObject text back into
      // <endUserTexts> and drops a text there on a field without one.
      const local = newElement.match(/<localProperties\b([^>]*?)(?:\/>|>([\s\S]*?)<\/localProperties>)/);
      if (local) {
        const inner = (local[2] ?? '').replace(/<descriptions\b[^>]*\/>/, '');
        const own = label ? `<descriptions label="${label}"/>` : '';
        newElement = newElement.replace(local[0], () => `<localProperties${local[1]}>${own}${inner}</localProperties>`);
      } else if (attr(openTag, 'infoObjectName')) {
        skipped.push({ field, reason: 'the element carries no local properties to hold a description of its own' });
        continue;
      } else {
        const texts = newElement.match(/<endUserTexts\b[^>]*\/>/)?.[0];
        newElement = texts
          ? newElement.replace(texts, () => `<endUserTexts label="${label}"/>`)
          : newElement.replace(openTag, () => `${openTag}<endUserTexts label="${label}"/>`);
      }
      result['description'] = description.trim();
    }

    if (newName !== undefined && newName !== field) {
      // A field that is exposed under the name of its InfoObject is found by queries under that
      // name; it keeps it until the name usage is switched, which the same call may do.
      const inline = newElement.match(/<inlineType\b[^>]*\/>/)?.[0] ?? '';
      if (attr(inline, 'globalElementName')) {
        skipped.push({ field, reason: `it is exposed under the InfoObject name ${attr(inline, 'globalElementName')}; switch name_usage to "unique_name" first` });
        continue;
      }
      if (findViewElement(xml, newName)) {
        skipped.push({ field, reason: `CompositeProvider ${cpUpper} already has a field ${newName}` });
        continue;
      }
      newOpen = setElementAttr(newOpen, 'name', newName);
      noteFieldRename(field, newName);
      result['renamed_to'] = newName;
    }

    newElement = newElement.replace(openTag, () => newOpen);
    xml = xml.replace(element, () => newElement);
    if (result['renamed_to']) {
      // Everything that points at the field: the mappings of every input, and the references of
      // other fields to it (unit or currency, compounding).
      xml = xml
        .replace(new RegExp(`(<mapping\\b[^>]*\\btargetName=")${escapeRegex(field)}(")`, 'g'), `$1${newName}$2`)
        .replace(new RegExp(`(#\\/\\/\\/[^/<"]+\\/)${escapeRegex(field)}(?=[<"])`, 'g'), `$1${newName}`);
    }
    changed.push(result);
  }

  if (changed.length === 0) {
    return JSON.stringify({ success: false, message: `No field changed in CompositeProvider ${cpUpper}.`, skipped });
  }
  xml = declareGroups(ensureNamespace(xml, 'BwCore', 'http://www.sap.com/bw/modeling/BwCore.ecore'), groups);
  const lockHandle = await putModel(client, compositeProviderName, xml, timestamp, transport);

  return JSON.stringify({
    success: true,
    message: `${changed.length} field(s) of CompositeProvider ${cpUpper} changed. Call bw_activate to activate.`,
    lock_handle: lockHandle,
    composite_provider_name: cpUpper,
    object_type: 'hcpr',
    changed,
    ...(skipped.length ? { skipped } : {}),
  });
}

/** The inputs of the view node with what the temporal join needs to know about their providers. */
async function temporalInputsOf(xml: string): Promise<{ nodeName: string; nodeType: string; inputs: TemporalInput[] }> {
  const node = xml.match(/<viewNode\b([^>]*)>[\s\S]*?<\/viewNode>/);
  if (!node) throw new Error('The CompositeProvider has no view node.');
  const inputs: TemporalInput[] = [];
  for (const m of node[0].matchAll(/<input\b([^>]*)>[\s\S]*?<\/input>/g)) {
    const alias = attr(m[1], 'alias');
    const providerName = nodeOfInput(m[0]) ? undefined : extractProviderNameFromInput(m[0]);
    if (!alias || !providerName) continue;
    const kind = (alias.split('.')[1] ?? '').toUpperCase();
    const fields = kind === 'IOBJ' || kind === 'ADSO'
      ? (await fetchCompositeSourceFields(providerName)).fields.filter((f) => !f.isMetaObject)
      : [];
    inputs.push({
      alias,
      providerName: providerName.toUpperCase(),
      kind,
      fields: fields.map((f) => f.sourceName),
      timeDependent: kind === 'IOBJ' && fields.some((f) => f.timeDependent),
      baseName: fields.find((f) => f.sourceName === providerName.toUpperCase())?.baseInfoObjectName,
    });
  }
  return { nodeName: attr(node[1], 'name'), nodeType: attr(node[1], 'xsi:type'), inputs };
}

/** A change to the inputs of a temporal join: its parts are written anew for the inputs that are there now. */
async function keepTemporalJoin(xml: string): Promise<string> {
  if (!isTemporalJoin(xml)) return xml;
  const { nodeName, inputs } = await temporalInputsOf(xml);
  return writeTemporalJoin(xml, nodeName, inputs, readTemporalChoices(xml, nodeName)).xml;
}

function refuseOnTemporalJoin(xml: string, action: string, cpUpper: string): void {
  if (isTemporalJoin(xml)) {
    throw new Error(
      `CompositeProvider ${cpUpper} is a temporal join, which lives in one join node; ${action} is not available on it. ` +
      'Switch the temporal join off with action "update_temporal_join" (temporal_join: false) first.');
  }
}

export interface TemporalJoinOptions {
  enabled?: boolean;
  inputAlias?: string;
  timeDependentFields?: boolean;
  validFromField?: string;
  validToField?: string;
  keyDateField?: string;
  transport?: string;
}

/**
 * bw_update_composite_provider action "update_temporal_join" — make a join temporal, change
 * where the validity of an input comes from, or switch the temporal join off.
 */
export async function bwUpdateCompositeProviderTemporalJoin(
  client: BwClient,
  compositeProviderName: string,
  opts: TemporalJoinOptions,
): Promise<string> {
  const cpUpper = compositeProviderName.toUpperCase();
  const cpResult = await readModel(compositeProviderName);
  const timestamp = cpResult.headers['timestamp'] ?? cpResult.headers['TIMESTAMP'];
  const xml = cpResult.body;
  const { nodeName, nodeType, inputs } = await temporalInputsOf(xml);
  if (!nodeType.endsWith('JoinNode')) {
    throw new Error(`A temporal join needs a join node; view node ${nodeName} of CompositeProvider ${cpUpper} is not one.`);
  }
  if (viewNodes(maskNodeRefs(leaveScope(xml))).length > 1) {
    throw new Error(`A temporal join is written for a CompositeProvider with one join node; ${cpUpper} has several view nodes.`);
  }

  if (opts.enabled === false) {
    if (!isTemporalJoin(xml)) {
      return JSON.stringify({ success: true, changed: false, message: `CompositeProvider ${cpUpper} is not a temporal join. Nothing was saved.` });
    }
    const lock = await putModel(client, compositeProviderName, stripTemporalJoin(xml, inputs.map((i) => i.alias)), timestamp, opts.transport);
    return JSON.stringify({
      success: true,
      message: `Temporal join of CompositeProvider ${cpUpper} switched off. Call bw_activate to activate.`,
      temporal_join: false,
      lock_handle: lock,
      composite_provider_name: cpUpper,
      object_type: 'hcpr',
    });
  }

  if (setNodeFilter(xml, '').previous) {
    throw new Error(
      `View node ${nodeName} of CompositeProvider ${cpUpper} has an SQL filter, which BW does not allow on a temporal join. ` +
      'Remove it first with action "update_filter" and an empty filter_expression.');
  }
  const choices = readTemporalChoices(xml, nodeName);
  const perInput =[opts.timeDependentFields, opts.validFromField, opts.validToField, opts.keyDateField].some((v) => v !== undefined);
  if (perInput) {
    const alias = opts.inputAlias?.trim();
    const input = inputs.find((i) => i.alias === alias);
    if (!input) {
      throw new Error(
        `update_temporal_join needs input_alias for time_dependent_fields, valid_from_field, valid_to_field and key_date_field. ` +
        `Inputs of ${cpUpper}: ${inputs.map((i) => i.alias).join(', ') || '(none)'}.`);
    }
    const choice = { ...(choices.get(input.alias) ?? {}) };
    const dateField = (given: string, param: string): string | undefined => {
      const wanted = given.trim().toUpperCase();
      if (!wanted) return undefined;
      const field = input.fields.find((f) => f === wanted || f.endsWith(`-${wanted}`));
      if (!field) throw new Error(`${param}: ${wanted} is not a field of ${input.providerName}. Fields: ${input.fields.join(', ')}.`);
      return field;
    };
    if (opts.timeDependentFields !== undefined) {
      if (input.kind !== 'IOBJ' || !input.timeDependent) {
        throw new Error(`time_dependent_fields applies to a characteristic with time-dependent attributes; ${input.providerName} (${input.alias}) is not one.`);
      }
      choice.showTimeDependent = opts.timeDependentFields;
    }
    if (opts.validFromField !== undefined || opts.validToField !== undefined) {
      if (input.kind !== 'ADSO') {
        throw new Error(`valid_from_field and valid_to_field apply to an aDSO input; ${input.providerName} (${input.alias}) is of type ${input.kind}.`);
      }
      const from = dateField(opts.validFromField ?? choice.validFrom ?? '', 'valid_from_field');
      const to = dateField(opts.validToField ?? choice.validTo ?? '', 'valid_to_field');
      if (Boolean(from) !== Boolean(to)) throw new Error('A validity interval needs both valid_from_field and valid_to_field; pass both empty to remove it.');
      choice.validFrom = from;
      choice.validTo = to;
    }
    if (opts.keyDateField !== undefined) choice.keyDate = dateField(opts.keyDateField, 'key_date_field');
    choices.set(input.alias, choice);
  }

  const result = writeTemporalJoin(xml, nodeName, inputs, choices);
  if (!result.enabled && inputs.some((i) => i.timeDependent)) {
    const lock = await putModel(client, compositeProviderName, result.xml, timestamp, opts.transport);
    return JSON.stringify({
      success: true,
      message: `No input of CompositeProvider ${cpUpper} takes part with its validity any more, so the join is not temporal. Call bw_activate to activate.`,
      temporal_join: false,
      lock_handle: lock,
      composite_provider_name: cpUpper,
      object_type: 'hcpr',
    });
  }
  if (!result.enabled) {
    throw new Error(
      `CompositeProvider ${cpUpper} has no time-dependent input, so there is nothing to join over time. ` +
      'A temporal join needs a characteristic with time-dependent attributes as an input (the characteristic has to be usable as an InfoProvider), ' +
      'or an aDSO input with valid_from_field and valid_to_field.');
  }
  const lockHandle = await putModel(client, compositeProviderName, result.xml, timestamp, opts.transport);
  return JSON.stringify({
    success: true,
    message: `Temporal join of CompositeProvider ${cpUpper} written. Call bw_activate to activate.`,
    temporal_join: true,
    inputs: result.providers,
    lock_handle: lockHandle,
    composite_provider_name: cpUpper,
    object_type: 'hcpr',
  });
}

const FILTER_ELEMENT = /<filterExpression\b(?:[^>\/]|\/(?!>))*(?:\/>|>[\s\S]*?<\/filterExpression>)/;

/**
 * The SQL filter of the view node: the condition every record of the node has to meet. It sits
 * between the fields and the inputs of the node; an empty expression removes it.
 */
export function setNodeFilter(xml: string, expression: string): { xml: string; changed: boolean; previous: string } {
  const node = xml.match(/<viewNode\b[\s\S]*?<\/viewNode>/)?.[0];
  if (!node) throw new Error('The CompositeProvider has no view node.');
  const existing = node.match(FILTER_ELEMENT)?.[0];
  const decode = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const previous = decode(existing?.match(/<formula>([\s\S]*?)<\/formula>/)?.[1] ?? '');
  const wanted = expression.replace(/\r/g, '').trim();
  if (wanted === previous.trim()) return { xml, changed: false, previous };
  const escaped = wanted.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const element = wanted ? `<filterExpression language="SQL"><formula>${escaped}</formula></filterExpression>` : '';
  let newNode = existing ? node.replace(existing, () => '') : node;
  if (element) {
    const at = newNode.search(/<input\b/);
    newNode = at >= 0
      ? newNode.slice(0, at) + element + newNode.slice(at)
      : newNode.replace(/<\/viewNode>$/, () => `${element}</viewNode>`);
  }
  return { xml: xml.replace(node, () => newNode), changed: true, previous };
}

/**
 * bw_update_composite_provider action "update_filter" — set or remove the SQL filter of the
 * view node.
 */
export async function bwUpdateCompositeProviderFilter(
  client: BwClient,
  compositeProviderName: string,
  expression: string | undefined,
  transport?: string,
): Promise<string> {
  const cpUpper = compositeProviderName.toUpperCase();
  if (expression === undefined) throw new Error('update_filter requires filter_expression (an empty text removes the filter).');
  const cpResult = await readModel(compositeProviderName);
  const timestamp = cpResult.headers['timestamp'] ?? cpResult.headers['TIMESTAMP'];
  if (expression.trim() && isTemporalJoin(cpResult.body)) {
    throw new Error(`CompositeProvider ${cpUpper} is a temporal join, and BW does not allow an SQL filter on one.`);
  }
  const result = setNodeFilter(cpResult.body, expression);
  if (!result.changed) {
    return JSON.stringify({
      success: true,
      changed: false,
      message: `CompositeProvider ${cpUpper} already has this filter. Nothing was saved.`,
      filter_expression: result.previous,
    });
  }
  const lockHandle = await putModel(client, compositeProviderName, result.xml, timestamp, transport);
  // The server accepts a document and can leave the filter out; the stored one is reported.
  const saved = (await readModel(compositeProviderName)).body;
  const stored = setNodeFilter(saved, '').previous;
  const wanted = expression.replace(/\r/g, '').trim();
  if (stored.trim() !== wanted) {
    return JSON.stringify({
      success: false,
      message: `CompositeProvider ${cpUpper} was saved, but the server did not keep the filter as given.`,
      filter_expression: stored,
      lock_handle: lockHandle,
      composite_provider_name: cpUpper,
      object_type: 'hcpr',
    });
  }
  return JSON.stringify({
    success: true,
    message: wanted
      ? `SQL filter of CompositeProvider ${cpUpper} set. Call bw_activate to activate; the expression itself is checked by the activation.`
      : `SQL filter of CompositeProvider ${cpUpper} removed. Call bw_activate to activate.`,
    filter_expression: wanted,
    ...(result.previous ? { previous_filter_expression: result.previous } : {}),
    lock_handle: lockHandle,
    composite_provider_name: cpUpper,
    object_type: 'hcpr',
  });
}

/**
 * bw_update_composite_provider action "update_group" — declare a field group, change its
 * label, or rename it together with every field that sits in it.
 */
export async function bwUpdateCompositeProviderGroup(
  client: BwClient,
  compositeProviderName: string,
  groupName: string,
  opts: { label?: string; newName?: string; transport?: string }
): Promise<string> {
  const cpUpper = compositeProviderName.toUpperCase();
  const group = groupName?.trim().toUpperCase();
  if (!group) throw new Error('update_group requires dimension (the group name).');
  const newName = opts.newName?.trim().toUpperCase();

  const cpResult = await readModel(compositeProviderName);
  const timestamp = cpResult.headers['timestamp'] ?? cpResult.headers['TIMESTAMP'];
  let xml = cpResult.body;
  const declared = compositeGroups(xml);

  const finalName = newName ?? group;
  const label = opts.label ?? declared.get(group) ?? '';
  const declaration = label
    ? `<dimension name="${finalName}">\n    <descriptions label="${escapeXmlAttr(label)}"/>\n  </dimension>`
    : `<dimension name="${finalName}"/>`;

  let message: string;
  if (!declared.has(group)) {
    if (newName) throw new Error(`CompositeProvider ${cpUpper} has no field group "${group}" to rename.`);
    xml = ensureGroupDeclared(xml, group).replace(`<dimension name="${group}"/>`, declaration);
    message = `Field group ${group} created in CompositeProvider ${cpUpper}.`;
  } else {
    if (newName && newName !== group && declared.has(newName)) {
      throw new Error(`CompositeProvider ${cpUpper} already has a field group "${newName}".`);
    }
    xml = xml.replace(
      new RegExp(`<dimension\\b[^>]*\\bname="${escapeRegex(group)}"[^>]*?(?:\\/>|>[\\s\\S]*?<\\/dimension>)`),
      () => declaration
    );
    if (newName) xml = xml.split(`dimension="${groupRef(group)}"`).join(`dimension="${groupRef(newName)}"`);
    message = newName
      ? `Field group ${group} of CompositeProvider ${cpUpper} renamed to ${newName}.`
      : `Field group ${group} of CompositeProvider ${cpUpper} updated.`;
  }

  const lockHandle = await putModel(client, compositeProviderName, xml, timestamp, opts.transport);
  return JSON.stringify({
    success: true,
    message: `${message} Call bw_activate to activate.`,
    lock_handle: lockHandle,
    composite_provider_name: cpUpper,
    object_type: 'hcpr',
    group: finalName,
    ...(label ? { label } : {}),
  });
}

// ── bw_update_composite_provider: navigation attributes ──────────────────────

/** A navigation attribute the base characteristic offers, as the CompositeProvider names it. */
export interface NavigationAttributeDef {
  /** "<BASE>__<ATTRIBUTE>" */
  name: string;
  label: string;
}

/** Navigation attributes switched on for one CompositeProvider element, in model order. */
export function elementNavigationAttributes(elementXml: string): string[] {
  return [...elementXml.matchAll(/<navigationAttribute\b[^>]*\binfoObjectName="([^"]+)"/g)].map((m) => m[1]);
}

/**
 * The navigation attributes a characteristic offers, keyed by the bare attribute name.
 * Display attributes are left out: a CompositeProvider can only switch on NAV attributes.
 */
export function navigationAttributeCatalog(infoObjectXml: string, baseName: string): Map<string, NavigationAttributeDef> {
  const catalog = new Map<string, NavigationAttributeDef>();
  for (const m of infoObjectXml.matchAll(/<attributeN\b([^>]*?)\/?>/g)) {
    const attrs = m[1];
    if (attr(attrs, 'type') !== 'NAV') continue;
    const attribute = attr(attrs, 'name');
    if (!attribute) continue;
    catalog.set(attribute, {
      name: attr(attrs, 'navigationAttributeName') || `${baseName}__${attribute}`,
      label: decodeXmlEntities(attr(attrs, 'navigationAttributeDescription') || attr(attrs, 'description')),
    });
  }
  return catalog;
}

/**
 * Switch navigation attributes on or off in one element block. A navigation attribute is a
 * `<navigationAttribute>` child of the element, placed after its local properties; the part
 * providers are not touched.
 */
export function withNavigationAttributes(
  elementXml: string,
  enable: NavigationAttributeDef[],
  disable: string[]
): string {
  let xml = elementXml.replace(/^(<element\b[^>]*?)\s*\/>$/, '$1></element>');
  for (const name of disable) {
    xml = xml.replace(
      new RegExp(`\\s*<navigationAttribute\\b[^>]*\\binfoObjectName="${escapeRegex(name)}"[^>]*?(?:\\/>|>[\\s\\S]*?<\\/navigationAttribute>)`),
      ''
    );
  }
  const present = new Set(elementNavigationAttributes(xml));
  const blocks = enable
    .filter((a) => !present.has(a.name))
    .map(
      (a) =>
        `<navigationAttribute infoObjectName="${a.name}" infoObjectType="CHA">` +
        `<descriptions label="${escapeXmlAttr(a.label)}"/></navigationAttribute>`
    )
    .join('');
  if (!blocks) return xml;

  const anchors = [
    /^[\s\S]*<\/navigationAttribute>/,
    /^[\s\S]*?(?:<localProperties\b[^>]*\/>|<\/localProperties>)/,
    /^[\s\S]*?(?=<atom:link\b|<associationType>|<\/element>)/,
  ];
  for (const anchor of anchors) {
    const m = xml.match(anchor);
    if (m) return m[0] + blocks + xml.slice(m[0].length);
  }
  return xml;
}

/** Field names and local navigation attribute names a view node already uses. */
export function usedFieldNames(xml: string): Set<string> {
  const names = new Set<string>();
  for (const m of xml.matchAll(/<element\b[^>]*\bname="([^"]+)"/g)) names.add(m[1]);
  for (const m of xml.matchAll(/<navigationAttribute\b[^>]*>[\s\S]*?<alias>([^<]*)<\/alias>/g)) names.add(m[1]);
  return names;
}

/**
 * The local name the modeling tools propose for a navigation attribute: the attribute name
 * cut to the 12 characters of a field name, numbered when another field already has it.
 */
export function localNavigationAttributeName(navigationAttribute: string, used: Set<string>): string {
  let base = navigationAttribute.toUpperCase();
  while (/\W/.test(base) || /^[^0-9A-Z]/.test(base) || base.includes('__')) base = base.slice(1);
  if (base.length < 2) base = `F_${base}`;
  base = base.slice(0, 12).replace(/_+$/, '');
  let name = base;
  for (let i = 0; used.has(name); i++) {
    const keep = i >= 100 ? 8 : i >= 10 ? 9 : 10;
    name = `${base.slice(0, keep).replace(/_+$/, '')}${i}`;
  }
  return name;
}

/**
 * Give every navigation attribute of an element without a local name one. A field that is
 * not exposed under its InfoObject name needs them, otherwise activation asks for one.
 */
export function withLocalNavigationAttributeNames(elementXml: string, used: Set<string>): string {
  return elementXml.replace(
    /<navigationAttribute\b([^>]*?)(?:\/>|>([\s\S]*?)<\/navigationAttribute>)/g,
    (whole, attrs: string, body: string | undefined) => {
      if (body?.includes('<alias>')) return whole;
      const name = localNavigationAttributeName(attr(attrs, 'infoObjectName'), used);
      used.add(name);
      const inner = body ?? '';
      const at = inner.search(/<localProperties\b/);
      const withAlias = at < 0 ? `${inner}<alias>${name}</alias>` : `${inner.slice(0, at)}<alias>${name}</alias>${inner.slice(at)}`;
      return `<navigationAttribute${attrs}>${withAlias}</navigationAttribute>`;
    }
  );
}

/**
 * Whether a part provider can deliver a navigation attribute. An InfoObject-based provider
 * such as an aDSO derives every navigation attribute from its characteristics and says so
 * with virtualNavigationAttributes; any other source must list the attribute as a field.
 */
export function sourceSupportsNavigationAttribute(sourceViewXml: string, navigationAttribute: string): boolean {
  const root = sourceViewXml.match(/<Composite:infoprovider\b[^>]*/)?.[0] ?? '';
  if (attr(root, 'virtualNavigationAttributes') === 'true') return true;
  const escaped = escapeRegex(navigationAttribute);
  return new RegExp(`<element\\b[^>]*\\b(?:name|infoObjectName)="(?:[^"]*-)?${escaped}"`).test(sourceViewXml);
}

/**
 * bw_update_composite_provider action "update_navigation_attributes" — switch navigation
 * attributes of one InfoObject-bound field on or off.
 */
export async function bwUpdateCompositeProviderNavigationAttributes(
  client: BwClient,
  compositeProviderName: string,
  fieldName: string,
  attributes: string[],
  opts: { enabled?: boolean; transport?: string }
): Promise<string> {
  const cpUpper = compositeProviderName.toUpperCase();
  const field = fieldName?.trim().toUpperCase();
  const enabled = opts.enabled ?? true;
  if (!field || field.includes(',')) {
    throw new Error('update_navigation_attributes requires info_object_name: exactly one field of the CompositeProvider.');
  }
  if (attributes.length === 0) {
    throw new Error('update_navigation_attributes requires navigation_attributes (one or more attribute names).');
  }

  const cpResult = await readModel(compositeProviderName);
  const timestamp = cpResult.headers['timestamp'] ?? cpResult.headers['TIMESTAMP'];
  let xml = cpResult.body;

  const element = findViewElement(xml, field);
  if (!element) throw new Error(`${field} is not a field of CompositeProvider ${cpUpper}.`);
  const base = attr(element.match(/^<element\b[^>]*/)?.[0] ?? '', 'infoObjectName');
  if (!base) throw new Error(`${field} is a plain field without an InfoObject, so it has no navigation attributes.`);

  const iobjXml = (await freshRead(`/sap/bw/modeling/iobj/${bwSeg(base)}/a`, MEDIA_TYPES['iobj'])).body;
  const catalog = navigationAttributeCatalog(iobjXml, base);
  const byFullName = new Map([...catalog.values()].map((a) => [a.name, a]));

  const requested: NavigationAttributeDef[] = [];
  const unknown: string[] = [];
  for (const raw of attributes) {
    const name = raw.trim().toUpperCase();
    const def = byFullName.get(name) ?? catalog.get(name.startsWith(`${base}__`) ? name.slice(base.length + 2) : name);
    if (def) requested.push(def);
    else unknown.push(name);
  }
  if (unknown.length) {
    const offered = [...catalog.values()].map((a) => a.name);
    throw new Error(
      `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a navigation attribute' : 'are not navigation attributes'} of ${base}. ` +
      (offered.length ? `It offers: ${offered.join(', ')}.` : `${base} has no navigation attributes.`)
    );
  }

  const before = new Set(elementNavigationAttributes(element));
  const changed = requested.filter((a) => before.has(a.name) !== enabled).map((a) => a.name);
  const unchanged = requested.filter((a) => before.has(a.name) === enabled).map((a) => a.name);
  if (changed.length === 0) {
    return JSON.stringify({
      success: false,
      message: `Nothing to change: ${unchanged.join(', ')} already ${enabled ? 'on' : 'off'} for ${field} in CompositeProvider ${cpUpper}.`,
    });
  }

  // In a union every part that supplies the field must deliver the attribute as well,
  // otherwise activation refuses it; say so before the round trip to activation does.
  const unsupported: Array<{ input_alias: string; provider: string; navigation_attributes: string[] }> = [];
  if (enabled) {
    const viewNode = xml.match(/<viewNode\b[\s\S]*?<\/viewNode>/)?.[0] ?? '';
    for (const im of viewNode.matchAll(/<input\b([^>]*)>([\s\S]*?)<\/input>/g)) {
      const mapsField = new RegExp(`<mapping\\b[^>]*\\btargetName="${escapeRegex(field)}"`).test(im[2]);
      const provider = extractProviderNameFromInput(im[2]);
      // A SAP HANA view has no BW provider view; BW resolves the attribute through the InfoObject.
      if (!mapsField || !provider || parseHanaViewName(provider)) continue;
      const sourceXml = (await freshRead(`/sap/bw/modeling/infoprov/${bwSegUpper(provider)}/a?view=dt`, IPROV_ACCEPT)).body;
      const missing = changed.filter((n) => !sourceSupportsNavigationAttribute(sourceXml, n));
      if (missing.length) unsupported.push({ input_alias: attr(im[1], 'alias'), provider, navigation_attributes: missing });
    }
  }

  let newElement = enabled
    ? withNavigationAttributes(element, requested.filter((a) => changed.includes(a.name)), [])
    : withNavigationAttributes(element, [], changed);
  if (enabled && !attr(compositeInlineType(element), 'globalElementName')) {
    newElement = withLocalNavigationAttributeNames(newElement, usedFieldNames(xml));
  }
  xml = xml.replace(element, () => newElement);
  const lockHandle = await putModel(client, compositeProviderName, xml, timestamp, opts.transport);

  return JSON.stringify({
    success: true,
    message:
      `Navigation attribute(s) ${changed.join(', ')} switched ${enabled ? 'on' : 'off'} for ${field} in CompositeProvider ${cpUpper}. ` +
      'Call bw_activate to activate.',
    lock_handle: lockHandle,
    composite_provider_name: cpUpper,
    object_type: 'hcpr',
    field,
    navigation_attributes: elementNavigationAttributes(newElement),
    ...(unchanged.length ? { unchanged } : {}),
    ...(unsupported.length
      ? {
          warning:
            'These part providers supply the field but cannot deliver the navigation attribute; activation will fail ' +
            'until they can (for example through a CompositeProvider in between that has the attribute switched on) ' +
            'or the field is no longer mapped from them.',
          unsupported_parts: unsupported,
        }
      : {}),
  });
}

// ── bw_update_composite_provider: join conditions ────────────────────────────

export interface JoinKeyPair {
  /** Bare field name on the left input's own source provider. */
  left: string;
  /** Bare field name on the right input's own source provider. */
  right: string;
  /** How the two keys are compared: EQ (default), NE, LT, LE, GT or GE. */
  operator?: string;
}

const JOIN_OPERATORS = ['EQ', 'NE', 'LT', 'LE', 'GT', 'GE'];

/** The operator of a key pair in the form BW stores it, or an error text. */
export function joinOperatorOf(pair: JoinKeyPair): string {
  const operator = (pair.operator ?? 'EQ').trim().toUpperCase();
  if (!JOIN_OPERATORS.includes(operator)) {
    throw new Error(`Unknown join operator "${pair.operator}" for ${pair.left} / ${pair.right}. Valid operators: ${JOIN_OPERATORS.join(', ')}.`);
  }
  return operator;
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

/** The whole `<input>` block of one alias. */
function inputBlockOf(xml: string, alias: string): string | undefined {
  return xml.match(new RegExp(`<input\\b[^>]*\\balias="${escapeRegex(alias)}"[^>]*>[\\s\\S]*?<\\/input>`))?.[0];
}

/** Target elements one source field of an input is mapped onto. */
export function mappedTargets(xml: string, alias: string, sourceName: string): string[] {
  const block = inputBlockOf(xml, alias) ?? '';
  return [...block.matchAll(/<mapping\b[^>]*>/g)]
    .filter((m) => attr(m[0], 'sourceName') === sourceName)
    .map((m) => attr(m[0], 'targetName'))
    .filter(Boolean);
}

/** Add mappings to an input, behind the ones it has. */
export function appendMappings(xml: string, alias: string, mappingsXml: string[]): string {
  const block = inputBlockOf(xml, alias);
  if (!block || mappingsXml.length === 0) return xml;
  return xml.replace(block, block.replace(/\s*<\/input>$/, `\n${mappingsXml.join('\n')}\n  </input>`));
}

export interface JoinKeyTargets {
  leftAlias: string;
  rightAlias: string;
  leftKey: string;
  rightKey: string;
  /** Target fields both keys are mapped onto. The server needs at least one. */
  commonTargets: string[];
}

/** Every key pair of every join with the target fields its two sides share. */
export function joinKeyTargets(xml: string): JoinKeyTargets[] {
  const out: JoinKeyTargets[] = [];
  for (const m of xml.matchAll(/<join\b([^>]*)>([\s\S]*?)<\/join>/g)) {
    const leftAlias = attr(m[1], 'leftInput').replace(/^.*\//, '');
    const rightAlias = attr(m[1], 'rightInput').replace(/^.*\//, '');
    const lefts = [...m[2].matchAll(/<leftElementName>([^<]*)<\/leftElementName>/g)].map((k) => k[1]);
    const rights = [...m[2].matchAll(/<rightElementName>([^<]*)<\/rightElementName>/g)].map((k) => k[1]);
    lefts.forEach((leftKey, i) => {
      const rightKey = rights[i];
      if (rightKey === undefined) return;
      const rightTargets = mappedTargets(xml, rightAlias, rightKey);
      out.push({
        leftAlias, rightAlias, leftKey, rightKey,
        commonTargets: mappedTargets(xml, leftAlias, leftKey).filter((t) => rightTargets.includes(t)),
      });
    });
  }
  return out;
}

/** Number of joins that name the input. */
export function joinsOfInput(xml: string, alias: string): number {
  return [...xml.matchAll(/<join\b[^>]*>/g)].filter((m) =>
    [attr(m[0], 'leftInput'), attr(m[0], 'rightInput')].some((ref) => ref.replace(/^.*\//, '') === alias)).length;
}

/**
 * Take back the double mapping of key pairs that are no longer part of a join. In a join only
 * a key field may be fed by both inputs; any other target field with a mapping from each side
 * is refused ("invalid number of assignments"). The right input's mapping onto the common
 * target goes, the left one keeps feeding the field.
 */
export function releaseJoinKeys(
  xml: string,
  leftAlias: string,
  rightAlias: string,
  keep: Array<{ leftKey: string; rightKey: string }>,
): { xml: string; released: Array<{ key: string; target: string }> } {
  const released: Array<{ key: string; target: string }> = [];
  let out = xml;
  for (const pair of joinKeyTargets(xml)) {
    if (pair.leftAlias !== leftAlias || pair.rightAlias !== rightAlias) continue;
    if (keep.some((k) => k.leftKey === pair.leftKey && k.rightKey === pair.rightKey)) continue;
    for (const target of pair.commonTargets) {
      // A target another kept pair still shares stays double mapped.
      if (keep.some((k) => mappedTargets(xml, leftAlias, k.leftKey).includes(target) &&
        mappedTargets(xml, rightAlias, k.rightKey).includes(target))) continue;
      const block = inputBlockOf(out, rightAlias);
      if (!block) continue;
      const mapping = [...block.matchAll(/[ \t]*<mapping\b[^>]*\/>\n?/g)].find((m) =>
        attr(m[0], 'sourceName') === pair.rightKey && attr(m[0], 'targetName') === target);
      if (!mapping) continue;
      out = out.replace(block, block.replace(mapping[0], ''));
      released.push({ key: pair.rightKey, target });
    }
  }
  return { xml: out, released };
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
  const source = await inputSource(inputMatch[0]);
  if (!source) throw new Error(`Could not determine the source InfoProvider for input ${alias}.`);
  return source;
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
  const cpResult = await readModel(compositeProviderName);
  const timestamp = cpResult.headers['timestamp'] ?? cpResult.headers['TIMESTAMP'];
  let xml = cpResult.body;

  const viewNodeName = getViewNodeName(xml);
  const left = leftAlias.trim();
  const right = rightAlias.trim();
  const operators = keyPairs.map(joinOperatorOf);
  // BW keeps the operators only on its own join type; a join of equalities alone stays the
  // plain one, as the modeling tools write it.
  const withOperators = operators.some((op) => op !== 'EQ');

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
    ...(withOperators ? operators.map((op) => `    <joinOperator>${op}</joinOperator>`) : []),
  ].join('\n');

  // The server wants every key pair mapped onto a common target field ("join fields need at
  // least one common target field"). The modeling tools create that when a condition is
  // added: the target of the left key is reused or created, and the right key is mapped onto
  // it as well. A mapping the right key already has onto a field of its own stays.
  const released = releaseJoinKeys(xml, left, right, keyPairs.filter((k) => joinOperatorOf(k) === 'EQ').map((k) => ({
    leftKey: resolveSourceFieldName(leftMeta.fields, k.left, leftMeta.providerName),
    rightKey: resolveSourceFieldName(rightMeta.fields, k.right, rightMeta.providerName),
  })));
  xml = released.xml;

  const commonTargets: Array<{ left: string; right: string; target: string; created: boolean }> = [];
  const ownTargets: Array<{ input: string; key: string; target: string }> = [];
  for (const pair of keyPairs) {
    // Two keys that are compared for anything but equality hold different values, so each
    // gets a target field of its own; the server refuses a join key without one.
    if (joinOperatorOf(pair) !== 'EQ') {
      for (const [alias, meta, key] of [[left, leftMeta, pair.left], [right, rightMeta, pair.right]] as const) {
        const source = resolveSourceFieldName(meta.fields, key, meta.providerName);
        if (mappedTargets(xml, alias, source).length > 0) continue;
        const bare = key.trim().toUpperCase();
        const target = dedupeTargetName(shortenTargetName(bare), xml, new Set());
        const resolved = resolveMappings([{ target, source: bare }], meta.fields, meta.providerName, viewNodeName, xml);
        if (resolved.newElementsXml.length > 0) {
          xml = injectBeforeAnchor(openViewNode(xml), resolved.newElementsXml.join('\n'), ['<input', '<join'], '</viewNode>');
        }
        xml = declareGroups(xml, resolved.groups);
        xml = ensureNamespace(xml, 'BwCore', 'http://www.sap.com/bw/modeling/BwCore.ecore');
        xml = ensureNamespace(xml, 'Type', 'http://www.sap.com/ndb/DataModelType.ecore');
        xml = appendMappings(xml, alias, resolved.mappingsXml);
        ownTargets.push({ input: alias, key: bare, target });
      }
      continue;
    }
    const leftSource = resolveSourceFieldName(leftMeta.fields, pair.left, leftMeta.providerName);
    const rightSource = resolveSourceFieldName(rightMeta.fields, pair.right, rightMeta.providerName);
    const leftTargets = mappedTargets(xml, left, leftSource);
    const rightTargets = mappedTargets(xml, right, rightSource);
    if (leftTargets.some((t) => rightTargets.includes(t))) continue;

    let target = leftTargets[0];
    let created = false;
    if (!target) {
      const bare = pair.left.trim().toUpperCase();
      target = dedupeTargetName(shortenTargetName(bare), xml, new Set());
      const resolved = resolveMappings([{ target, source: bare }], leftMeta.fields, leftMeta.providerName, viewNodeName, xml);
      if (resolved.newElementsXml.length > 0) {
        xml = injectBeforeAnchor(openViewNode(xml), resolved.newElementsXml.join('\n'), ['<input', '<join'], '</viewNode>');
      }
      xml = declareGroups(xml, resolved.groups);
      xml = ensureNamespace(xml, 'BwCore', 'http://www.sap.com/bw/modeling/BwCore.ecore');
      xml = ensureNamespace(xml, 'Type', 'http://www.sap.com/ndb/DataModelType.ecore');
      xml = appendMappings(xml, left, resolved.mappingsXml);
      created = true;
    }
    xml = ensureNamespace(xml, 'Type', 'http://www.sap.com/ndb/DataModelType.ecore');
    xml = appendMappings(xml, right, [buildTypeMappingXml(target, rightSource)]);
    commonTargets.push({ left: pair.left.trim().toUpperCase(), right: pair.right.trim().toUpperCase(), target, created });
  }

  const joinXml =
    `  <join${withOperators ? ' xsi:type="Composite:BwJoin"' : ''} leftInput="#///${viewNodeName}/${left}" rightInput="#///${viewNodeName}/${right}"` +
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
    await client.put('hcpr', compositeProviderName, lockHandle, leaveScope(xml), timestamp, transport);
  } catch (err) {
    await client.unlock('hcpr', compositeProviderName).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message:
      `Join condition set in CompositeProvider ${cpUpper} (${left} / ${right}, ` +
      `${keyPairs.length} key pair(s)). Call bw_activate to activate.` +
      (commonTargets.length
        ? ' Both sides of a join key need a common target field: ' +
          commonTargets.map((c) =>
            `${c.right} of ${right} is now also mapped onto ${c.target}${c.created ? ' (created)' : ''}`).join('; ') + '.'
        : '') +
      (ownTargets.length
        ? ' A key that is not compared for equality needs a target field of its own: ' +
          ownTargets.map((o) => `${o.key} of ${o.input} is now mapped onto ${o.target}`).join('; ') + '.'
        : '') +
      (released.released.length
        ? ` No longer join keys, so ${right} no longer feeds ` +
          released.released.map((r) => `${r.target} (from ${r.key})`).join(', ') + '.'
        : ''),
    lock_handle: lockHandle,
    composite_provider_name: cpUpper,
    object_type: 'hcpr',
    join_type: joinType,
    cardinality,
    ...(withOperators ? { operators: keyPairs.map((k, i) => `${k.left.trim().toUpperCase()} ${operators[i]} ${k.right.trim().toUpperCase()}`) } : {}),
    ...(commonTargets.length ? { common_target_fields: commonTargets } : {}),
    ...(ownTargets.length ? { own_target_fields: ownTargets } : {}),
    ...(released.released.length ? { released_key_mappings: released.released } : {}),
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
  const cpResult = await readModel(compositeProviderName);
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
  // The fields the two sides shared as join keys go back to a single feeding input.
  const released = releaseJoinKeys(xml, left, right, []);
  xml = released.xml;
  // The last join of a node is emptied, not removed: a join node saved without any join
  // element ends in a runtime error on the server. The condition-less form is the one a new
  // CompositeProvider starts with.
  const current = findJoinBetween(xml, viewNodeName, left, right)?.[0] ?? existing[0];
  const lastJoin = (xml.match(/<join\b/g) ?? []).length <= 1;
  const joinType = current.match(/\bjoinType="([^"]*)"/)?.[1] ?? 'inner';
  xml = xml.replace(
    current,
    lastJoin
      ? `  <join joinType="${joinType}" leftInput="#///${viewNodeName}/${left}" rightInput="#///${viewNodeName}/${right}"/>\n`
      : '',
  );

  const lockHandle = await client.lock('hcpr', compositeProviderName);
  try {
    await client.put('hcpr', compositeProviderName, lockHandle, leaveScope(xml), timestamp, transport);
  } catch (err) {
    await client.unlock('hcpr', compositeProviderName).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message:
      `Join condition between ${left} and ${right} removed from CompositeProvider ${cpUpper}.` +
      (lastJoin ? ' The join node needs a new condition ("update_join") before it activates.' : '') +
      (released.released.length
        ? ` ${right} no longer feeds ${released.released.map((r) => `${r.target} (from ${r.key})`).join(', ')}, which were join keys.`
        : '') +
      ' Call bw_activate to activate.',
    lock_handle: lockHandle,
    composite_provider_name: cpUpper,
    object_type: 'hcpr',
    ...(released.released.length ? { released_key_mappings: released.released } : {}),
  });
}
