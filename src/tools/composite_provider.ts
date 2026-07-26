import { BwClient, freshRead } from '../bw-client.js';

// ── Write path — CONFIRMED (with noted gaps) ────────────────────────────────
//
// Every write function below (create / add_input / remove_input / update_mapping /
// update_join / update_settings) has been built and corrected against two real
// captured traces (BW/4HANA A4H, 2026-07-26, via Eclipse/BWMT):
//   1. A Union CompositeProvider over a single aDSO input (ZBF_DM) — create, full
//      save with fields/mappings, activate.
//   2. A 2-input Join CompositeProvider (ZBF_DM ⋈ ZBF_EDW on MATNR+WERKS) — create
//      (which already includes a bare <join> stub), full save with fields/mappings/
//      join keys, activate.
// Both objects activated successfully. Key things the traces corrected from the
// original inference-only version (kept here so future changes don't regress them):
//   - xmlns:Composite is CompositeModel.ecore, not hcpr.ecore; view nodes need the
//     separate View namespace (xsi:type="View:Union"/"View:JoinNode"); elements need
//     BwCore.ecore; mappings need DataModelType.ecore (xsi:type="Type:ElementMapping")
//   - the view node's own `name` is a generic id (U1/J1), not the CP's name
//   - root `defaultNode` is a path reference ("#///U1"), not a plain string/bool
//   - stackable/aggregationBehaviour are omitted at create time (server defaults)
//   - element order is endUserTexts → viewNode → tlogoProperties → runtimeProperties
//   - inputs at create time are entity-only (<entity>../../../infoprov_dt/a/
//     NAME.composite#//</entity>), no mappings yet; alias format is "{node}.{TYPE}.{n}"
//   - a Union needs at least one input up front; a Join needs exactly 2 (its create
//     call also gets a bare <join leftInput=... rightInput=... joinType="inner"/> stub)
//   - mapping sourceName is a generated prefixed name (e.g. "4ZBF_DM-WAERS"), fetched
//     via fetchCompositeSourceFields() (GET /sap/bw/modeling/infoprov/{name}/a?view=dt)
//     rather than derivable client-side
//   - elements are full <element xsi:type="BwCore:BwElement"> blocks with
//     <inlineType>/<localProperties>/<descriptions>/<associationType or semantics>
//   - pure CUKY/UNIT source fields get auto-bound to 0CURRENCY/0UNIT at CP level
//   - auto-mapping a second input's field whose bare name collides with an already-
//     mapped target renames it ("MEINS_0") rather than merging — see dedupeTargetName
//   - update_join: joinType is lowercase ("inner"), default cardinality is "CN_N"
//     (not "M_N"), and <leftElementName>/<rightElementName> hold each side's own
//     source-prefixed field name, not the CP's target element name
//
// Remaining gaps (no evidence either way — treat as best-effort):
//   - ConstantElementMapping's real xsi:type prefix (guessed "Type:", by analogy with
//     the now-confirmed "Type:ElementMapping")
//   - a Join with other than exactly 2 inputs (chained/multi-way joins)
//   - the <temporalFieldObject>/<temporalJoinProvider> bookkeeping the real Join create
//     call included (a full candidate-field listing for every input, seemingly tied to
//     the separate time-dependent/temporal-join feature, which was NOT enabled here —
//     temporalJoin="false" throughout). Deliberately omitted: replicating it would mean
//     fetching every unmapped field from every input for what looks like inert UI
//     staging data. If activation ever fails specifically on a Join needing this, that's
//     the first thing to add back (re-capture a trace to confirm the exact shape first).

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

// GET /sap/bw/modeling/infoprov/{NAME}/a?view=dt (used by fetchCompositeSourceFields) rejects
// a bare "application/xml" Accept with HTTP 406, naming "vnd.sap.bw.modeling.iprov-v1_14_0" as
// the version it supports — confirmed against a real A4H 406 response, 2026-07-26. Mirrors the
// HCPR_ACCEPT fallback-list pattern so future backend versions keep negotiating cleanly.
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
    const elemBody = em[2] ?? '';
    const name = attr(elemAttrs, 'name');
    if (!name) continue;
    const infoObjectName = attr(elemAttrs, 'infoObjectName');
    const dimension = attr(elemAttrs, 'dimension');
    const dimName = dimension.match(/#\/\/\/([^§]*)§/)?.[1] ?? dimension;
    // Key figures are identified by the LocalKeyfigureProperties marker in the element body
    // (confirmed against a real captured write — buildTargetElementXml always emits GROUP1 as
    // the dimension for new elements regardless of key-figure status, so the dimension name
    // itself is not a reliable signal; matches the same heuristic fetchCompositeSourceFields
    // already uses for the source side).
    const isKeyFigure = /LocalKeyfigureProperties/.test(elemBody);
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

// Confirmed against a real captured create + save trace (BW/4HANA A4H, 2026-07-26):
// the "Composite" prefix binds to CompositeModel.ecore (not hcpr.ecore, as originally
// guessed), and view nodes/elements need the View/BwCore/Type namespaces below.
const HCPR_XMLNS =
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
  'xmlns:Composite="http://www.sap.com/bw/modeling/CompositeModel.ecore" ' +
  'xmlns:View="http://www.sap.com/ndb/ViewModelView.ecore" ' +
  'xmlns:adtcore="http://www.sap.com/adt/core"';

// Additional namespaces needed once elements/mappings are involved (add_input, update_mapping).
const HCPR_FULL_XMLNS =
  HCPR_XMLNS + ' ' +
  'xmlns:BwCore="http://www.sap.com/bw/modeling/BwCore.ecore" ' +
  'xmlns:Type="http://www.sap.com/ndb/DataModelType.ecore"';

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

function getViewNodeType(xml: string): 'Join' | 'Union' | undefined {
  const raw = xml.match(/<viewNode\b[^>]*\bxsi:type="([^"]*)"/)?.[1];
  const local = raw?.split(':').pop();
  return local === 'JoinNode' ? 'Join' : local === 'Union' ? 'Union' : undefined;
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

export interface InitialInputRef {
  providerName: string; // technical name of the source InfoProvider (e.g. "ZBF_DM")
  providerType: string; // TLOGO-style suffix, e.g. "ADSO", "CUBE", "HCPR"
}

/** Relative entity-reference path used inside <input><entity>...</entity></input>. */
function buildEntityRef(providerName: string): string {
  return `../../../infoprov_dt/a/${providerName.trim().toUpperCase()}.composite#//`;
}

/**
 * bw_create_composite_provider — create a new CompositeProvider shell.
 * action "empty" (default): view node with zero or more entity-only inputs (pass `inputs`
 *   to attach source InfoProviders immediately — confirmed necessary for Union, since a
 *   Union with no inputs was never observed in the wild; Join with 0/1 inputs is untested).
 * action "from_template": proposes structure from an existing HCPR (pass templateName).
 * Workflow: Lock (CREA) → POST minimal XML → Unlock.
 * After creation the CompositeProvider is inactive — call bw_activate to activate it.
 *
 * XML shape confirmed against a real captured create request (BW/4HANA A4H, 2026-07-26):
 * element order is endUserTexts → viewNode → tlogoProperties → runtimeProperties; the view
 * node's own `name` is a generic id (U1/J1), not the CompositeProvider's name; `defaultNode`
 * on root is a path reference (`#///U1`); stackable/aggregationBehaviour are omitted unless
 * non-default. Fields/mappings are NOT part of the create call — they're added afterwards
 * via a full-object PUT (see bw_update_composite_provider).
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
  stackable: boolean = false,
  inputs: InitialInputRef[] = []
): Promise<string> {
  const nameUpper = compositeProviderName.toUpperCase();
  const infoAreaUpper = infoArea.toUpperCase();
  // Every real captured create/save used "EN" (this system's actual logon/master language) —
  // "DE" was an unverified carry-over default from adso.ts and may not even be an installed
  // language on this system, which would explain the original unconditional 500s.
  const language = process.env.BW_LANGUAGE ?? 'EN';
  const nodeName = viewType === 'Union' ? 'U1' : 'J1';
  const xsiType = viewType === 'Union' ? 'View:Union' : 'View:JoinNode';
  const stackableAttr = stackable ? ' stackable="true"' : '';

  const lockHandle = await client.lock('hcpr', compositeProviderName, {
    'activity_context': 'CREA',
    'parent_name': infoAreaUpper,
    'parent_type': 'AREA',
  });

  const templateElement =
    action === 'from_template' && templateName
      ? `\n  <template objectName="${templateName.toUpperCase()}" tlogo="HCPR"/>`
      : '';

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

  // Confirmed for the 2-input case: a bare <join> stub (no keys/cardinality yet — those
  // are added later via update_join) referencing both inputs by full node-relative path.
  // Each <join> element is inherently pairwise (BW's join node models N-way/star joins as
  // N inputs + one <join> per pair — see the "Join key management" section below), so this
  // stub is only built for the first pair; additional inputs for a 3+-way join are added via
  // add_input afterwards, with their own relationships wired up via update_join per pair.
  const joinStubXml =
    viewType === 'Join' && aliases.length === 2
      ? `    <join leftInput="#///${nodeName}/${aliases[0]}" rightInput="#///${nodeName}/${aliases[1]}" joinType="inner"/>`
      : '';

  const viewNodeBody = [inputsXml, joinStubXml].filter(Boolean).join('\n');

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Composite:compositeView ${HCPR_XMLNS} schemaVersion="1.15" name="${nameUpper}" readOnly="false"` +
    ` defaultNode="#///${nodeName}" clientDependent="false"${stackableAttr}>\n` +
    `  <endUserTexts label="${label}"/>\n` +
    `  <viewNode xsi:type="${xsiType}" name="${nodeName}">\n` +
    (viewNodeBody ? viewNodeBody + '\n' : '') +
    `  </viewNode>${templateElement}\n` +
    `  <tlogoProperties adtcore:language="${language}" adtcore:name="${nameUpper}"` +
    ` adtcore:type="HCPR" adtcore:masterLanguage="${language}">\n` +
    `    <infoArea>${infoAreaUpper}</infoArea>\n` +
    `  </tlogoProperties>\n` +
    `  <runtimeProperties/>\n` +
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
//
// Confirmed against the same real capture as bwCreateCompositeProvider (see file
// header): field/mapping structure requires knowing the source InfoProvider's
// generated field-name prefix (e.g. "4ZBF_DM"), fetched via a dedicated read
// endpoint — there is no way to predict it client-side.

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Adds an xmlns:{prefix} declaration to the root tag if not already present (idempotent). */
function ensureNamespace(xml: string, prefix: string, uri: string): string {
  if (new RegExp(`xmlns:${prefix}=`).test(xml)) return xml;
  return xml.replace(/(<Composite:compositeView\b)/, `$1 xmlns:${prefix}="${uri}"`);
}

export interface FieldMapping {
  target: string;         // CP element name (existing, or newly created)
  source?: string;        // BARE field name in the source InfoProvider (before its generated
                           // prefix is applied), e.g. "WAERS" for source field "4ZBF_DM-WAERS".
                           // Defaults to target. Mutually exclusive with constantValue.
  constantValue?: string; // constant value — mutually exclusive with source
  infoObjectName?: string; // only used when the target element is newly created (does not
                            // already exist in the CP): binds it to a real InfoObject instead
                            // of leaving it a plain field-based element. Overrides the CUKY/UNIT
                            // auto-binding in AUTO_IOBJ_FOR_TYPE for this element.
}

export interface SourceFieldMeta {
  sourceName: string;              // fully prefixed name, e.g. "4ZBF_DM-WAERS"
  defaultTargetName: string;       // bare name, e.g. "WAERS"
  label: string;
  inlineTypeXml: string;           // verbatim <inlineType .../> copied from the source
  dataType: string;                // inlineType's own "name", e.g. "CUKY", "QUAN", "CHAR"
  isKeyFigure: boolean;
  aggregationBehavior: string;
  conversionRoutine?: string;
  fixedUnit?: string;
  unitCurrencyRefBareName?: string; // bare name of another source field this key figure's unit/currency comes from
  outputLength: number;
}

// Pure CUKY/UNIT fields get auto-bound to the standard 0CURRENCY/0UNIT characteristics at
// CompositeProvider level even when the source itself has no infoObjectName — confirmed by
// comparing the source aDSO's plain WAERS/MEINS fields against the resulting CP elements.
const AUTO_IOBJ_FOR_TYPE: Record<string, string> = { CUKY: '0CURRENCY', UNIT: '0UNIT' };

// <semantics> tag derived from the field's own data type (not present on the source element;
// only observed on the CP-level element, e.g. QUAN → "QUA" for MOVE_QTY).
const SEMANTICS_TAG: Record<string, string> = {
  INT1: 'INT', INT2: 'INT', INT4: 'INT', INT8: 'INT',
  FLTP: 'NUM', DEC: 'NUM', CURR: 'AMO', QUAN: 'QUA',
};

/**
 * GET /sap/bw/modeling/infoprov/{NAME}/a?view=dt — the InfoProvider-as-composite-input
 * view used by the modeling UI. Returns the generated field-name prefix and, per field,
 * enough type/label metadata to build a matching CompositeProvider element.
 */
export async function fetchCompositeSourceFields(
  providerName: string
): Promise<{ fieldNamePrefix: string; lastModified?: string; fields: SourceFieldMeta[] }> {
  const path = `/sap/bw/modeling/infoprov/${providerName.toUpperCase()}/a?view=dt`;
  const result = await freshRead(path, IPROV_ACCEPT);
  const xml = result.body;

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
      // Only physical fields carry `dimension`; navigation-attribute/association
      // elements (e.g. a bare "1CUDIM") don't and are not usable as CP inputs.
      if (!name || !dimension || !name.startsWith(`${fieldNamePrefix}-`)) continue;

      const inlineTypeXml = body.match(/<inlineType\b[^>]*\/>/)?.[0] ?? '';
      const dataType = attr(inlineTypeXml, 'name');
      const label = body.match(/<endUserTexts label="([^"]*)"/)?.[1] ?? '';
      const isKeyFigure = /LocalKeyfigureProperties/.test(body);
      const aggregationBehavior = attr(elemAttrs, 'aggregationBehavior') || 'NONE';
      const conversionRoutine = attr(elemAttrs, 'conversionRoutine') || undefined;
      const fixedUnit = body.match(/<fixedUnit>([^<]*)<\/fixedUnit>/)?.[1];
      const unitCurrencyRaw = body.match(/<unitCurrencyElement>([^<]*)<\/unitCurrencyElement>/)?.[1];
      const refPrefix = `#///${fieldNamePrefix}-`;
      const unitCurrencyRefBareName = unitCurrencyRaw?.startsWith(refPrefix)
        ? unitCurrencyRaw.slice(refPrefix.length)
        : undefined;
      const outputLengthRaw = attr(elemAttrs, 'outputLength');
      const outputLength = outputLengthRaw ? parseInt(outputLengthRaw, 10) : 0;

      fields.push({
        sourceName: name,
        defaultTargetName: name.slice(fieldNamePrefix.length + 1),
        label,
        inlineTypeXml,
        dataType,
        isKeyFigure,
        aggregationBehavior,
        conversionRoutine,
        fixedUnit,
        unitCurrencyRefBareName,
        outputLength,
      });
    }
  }

  return { fieldNamePrefix, lastModified, fields };
}

/** Builds a full <element xsi:type="BwCore:BwElement"> block matching the confirmed CP shape. */
function buildTargetElementXml(
  field: SourceFieldMeta,
  targetName: string,
  nodeName: string,
  resolveUnitCurrencyTarget: (bareSourceName: string) => string | undefined,
  infoObjectNameOverride?: string
): string {
  const infoObjectName = infoObjectNameOverride ?? AUTO_IOBJ_FOR_TYPE[field.dataType];
  const attrs = [
    `name="${targetName}"`,
    `aggregationBehavior="${field.aggregationBehavior}"`,
    ...(infoObjectName ? [`infoObjectName="${infoObjectName}"`] : []),
    ...(field.conversionRoutine ? [`conversionRoutine="${field.conversionRoutine}"`] : []),
    `dimension="#///GROUP1§"`,
    `outputLength="${field.outputLength}"`,
  ].join(' ');

  const lines: string[] = [`  <element xsi:type="BwCore:BwElement" ${attrs}>`];
  if (field.inlineTypeXml) lines.push(`    ${field.inlineTypeXml}`);
  if (field.fixedUnit) lines.push(`    <fixedUnit>${field.fixedUnit}</fixedUnit>`);
  if (field.unitCurrencyRefBareName) {
    const refTarget = resolveUnitCurrencyTarget(field.unitCurrencyRefBareName) ?? field.unitCurrencyRefBareName;
    lines.push(`    <unitCurrencyElement>#///${nodeName}/${refTarget}</unitCurrencyElement>`);
  }
  if (field.isKeyFigure) {
    lines.push(`    <localProperties xsi:type="BwCore:LocalKeyfigureProperties">`);
    lines.push(`      <descriptions label="${field.label}"/>`);
    lines.push(`    </localProperties>`);
    const semantics = SEMANTICS_TAG[field.dataType];
    if (semantics) lines.push(`    <semantics>${semantics}</semantics>`);
  } else {
    lines.push(`    <localProperties xsi:type="BwCore:LocalCharacteristicProperties">`);
    lines.push(`      <descriptions label="${field.label}"/>`);
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

// Unconfirmed: constant mappings were not exercised in the captured trace. Kept consistent
// with the now-confirmed "Type:" prefix for regular mappings as a best-effort guess.
function buildConstantMappingXml(targetName: string, value: string): string {
  return `    <mapping xsi:type="Type:ConstantElementMapping" targetName="${targetName}" value="${value}"/>`;
}

/**
 * Resolves a mapping list against the source InfoProvider's field metadata: looks up each
 * bare source field name, builds the Type:ElementMapping XML, and builds a BwCore:BwElement
 * for any target that doesn't already exist in `existingXml`. Shared by add_input and
 * update_mapping so both build the identical, evidence-based shape.
 */
function resolveMappings(
  mappings: FieldMapping[],
  fields: SourceFieldMeta[],
  providerName: string,
  nodeName: string,
  existingXml: string
): { mappingsXml: string[]; newElementsXml: string[] } {
  const byBareName = new Map(fields.map((f) => [f.defaultTargetName, f]));

  // Resolve target names up front so unitCurrencyElement can reference sibling fields
  // in this same batch, even before their <element> blocks are built.
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
 * Confirmed on a real Join capture: auto-mapping a second input whose field name collides
 * with an already-mapped target (e.g. both ZBF_DM and ZBF_EDW have "MEINS") renames the new
 * one to "MEINS_0" rather than merging into the existing element. Only applies to the
 * auto-map-all path — explicit mappings may deliberately reuse an existing target (e.g.
 * mapping both sides' join-key fields, MATNR/WERKS here, onto the same shared target).
 */
function dedupeTargetName(desired: string, existingXml: string, usedInBatch: Set<string>): string {
  const exists = (name: string) =>
    usedInBatch.has(name) || new RegExp(`<element\\b[^>]*\\bname="${escapeRegex(name)}"`).test(existingXml);
  if (!exists(desired)) return desired;
  let n = 0;
  while (exists(`${desired}_${n}`)) n++;
  return `${desired}_${n}`;
}

/**
 * Builds the auto-map-all (mappings omitted) FieldMapping list for one input's fields.
 * Inferred, not separately captured — but follows directly from the two view types' own
 * purpose and from resolveMappings' existing "reuse an existing target if the name already
 * matches, else create it" behavior:
 *   - Union: a same-named field from a different input should MERGE into the one shared
 *     target column (that's the point of stacking rows via a union) — so collisions against
 *     already-mapped elements are left alone, reusing the existing target as-is. Only
 *     collisions within this same input's own field list get suffixed (should never happen
 *     in practice, but guards against a source with two same-bare-name fields).
 *   - Join (or unknown node type): confirmed real behavior — a colliding name gets suffixed
 *     ("MEINS_0") rather than merged, since two inputs' same-named fields sit side by side as
 *     distinct columns, not stacked rows.
 */
function buildAutoMappings(fields: SourceFieldMeta[], existingXml: string, viewNodeType: 'Join' | 'Union' | undefined): FieldMapping[] {
  const usedInBatch = new Set<string>();
  return fields.map((f) => {
    const target =
      viewNodeType === 'Union'
        ? dedupeTargetName(f.defaultTargetName, '', usedInBatch) // only guard against this input's own field-list collisions
        : dedupeTargetName(f.defaultTargetName, existingXml, usedInBatch);
    usedInBatch.add(target);
    return { target, source: f.defaultTargetName };
  });
}

/** Next available alias for a given view node + provider type, e.g. "U1.ADSO.2" after "U1.ADSO.1" exists. */
function nextInputAlias(xml: string, nodeName: string, providerType: string): string {
  const type = providerType.trim().toUpperCase();
  const re = new RegExp(`alias="${escapeRegex(nodeName)}\\.${escapeRegex(type)}\\.(\\d+)"`, 'g');
  let max = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    max = Math.max(max, parseInt(m[1], 10));
  }
  return `${nodeName}.${type}.${max + 1}`;
}

/** Extracts the source InfoProvider name from an <input>'s <entity> reference. Three observed
 * forms: Eclipse's "platform:/resource/.../infoprov_dt/a/NAME.composite#//", our own simpler
 * relative "../../../infoprov_dt/a/NAME.composite#//" form used at create time, and the bare
 * "NAME.composite#//" form the backend normalizes it to once the object has been saved/activated
 * (confirmed via a real captured read of an already-active CompositeProvider, 2026-07-26). */
function extractProviderNameFromInput(inputBlock: string): string | undefined {
  return inputBlock.match(/(?:infoprov_dt\/a\/)?([A-Za-z0-9_]+)\.composite#\/\//)?.[1];
}

export interface InputProviderDef {
  providerName: string;   // technical name of the source InfoProvider
  providerType: string;   // TLOGO-style suffix used in the generated alias, e.g. "ADSO", "CUBE", "HCPR"
  mappings?: FieldMapping[]; // omit (or pass []) to auto-map every field on the source 1:1
}

/**
 * bw_update_composite_provider action "add_input" / "remove_input" —
 * add or remove a source InfoProvider (input) on the view node.
 * "add_input": fetches the source's field metadata, builds an entity-referenced <input> with
 * Type:ElementMapping children, and creates any BwCore:BwElement targets that don't exist yet.
 * The alias is auto-generated ("{node}.{TYPE}.{n}", matching real BW numbering) — use the
 * returned alias for later remove_input/update_mapping/update_join calls.
 * "remove_input": strips the <input> block by its alias.
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
  let resultAlias: string | undefined;

  if (action === 'remove_input') {
    const alias = (inputAlias ?? '').trim();
    if (!alias) throw new Error('remove_input requires inputAlias.');
    const inputRegex = new RegExp(`[ \\t]*<input\\b[^>]*\\balias="${escapeRegex(alias)}"[^>]*>[\\s\\S]*?<\\/input>\\n?`);
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

    const nodeName = getViewNodeName(xml);
    if (!nodeName) throw new Error(`Could not determine view node name for CompositeProvider ${cpUpper}.`);

    const { fieldNamePrefix, lastModified, fields } = await fetchCompositeSourceFields(input.providerName);
    if (!fieldNamePrefix) {
      throw new Error(
        `Could not determine field name prefix for source InfoProvider ${input.providerName.toUpperCase()} ` +
        `(GET /sap/bw/modeling/infoprov/${input.providerName.toUpperCase()}/a?view=dt returned no fieldNamePrefix).`
      );
    }

    const requested: FieldMapping[] =
      input.mappings && input.mappings.length > 0
        ? input.mappings
        : buildAutoMappings(fields, xml, getViewNodeType(xml));

    const alias = nextInputAlias(xml, nodeName, input.providerType);
    const { mappingsXml, newElementsXml } = resolveMappings(requested, fields, input.providerName, nodeName, xml);

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
    message = `Input ${alias} (${input.providerName.toUpperCase()}) added to CompositeProvider ${cpUpper} with ${mappingsXml.length} mapping(s). Call bw_activate to activate.`;
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

/**
 * bw_update_composite_provider action "update_mapping" — replace the complete
 * mapping list of one existing input (identified by its alias, e.g. "U1.ADSO.1").
 * mappings may be omitted (or passed as []) to auto-map every field on that input's
 * source 1:1, same convenience as add_input — useful for populating an entity-only
 * input that was attached at creation time via bw_create_composite_provider's `inputs`.
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
  const alias = inputAlias.trim();
  const cpResult = await freshRead(HCPR_PATH(compositeProviderName), HCPR_ACCEPT);
  const timestamp = cpResult.headers['timestamp'] ?? cpResult.headers['TIMESTAMP'];
  let xml = cpResult.body;

  const inputRegex = new RegExp(`(<input\\b[^>]*\\balias="${escapeRegex(alias)}"[^>]*>)([\\s\\S]*?)(<\\/input>)`);
  const match = inputRegex.exec(xml);
  if (!match) {
    return JSON.stringify({
      success: false,
      message: `Input ${alias} not found in CompositeProvider ${cpUpper}. No changes made.`,
    });
  }

  const providerName = extractProviderNameFromInput(match[0]);
  if (!providerName) {
    throw new Error(`Could not determine source InfoProvider from input ${alias}'s <entity> reference.`);
  }
  const nodeName = getViewNodeName(xml);
  const { fieldNamePrefix, fields } = await fetchCompositeSourceFields(providerName);
  if (!fieldNamePrefix) {
    throw new Error(`Could not determine field name prefix for source InfoProvider ${providerName.toUpperCase()}.`);
  }

  const effectiveMappings = mappings.length > 0 ? mappings : buildAutoMappings(fields, xml, getViewNodeType(xml));
  const { mappingsXml, newElementsXml } = resolveMappings(effectiveMappings, fields, providerName, nodeName, xml);

  if (newElementsXml.length > 0) {
    xml = injectBeforeAnchor(xml, newElementsXml.join('\n'), ['<input', '<join'], '</viewNode>');
  }
  xml = ensureNamespace(xml, 'BwCore', 'http://www.sap.com/bw/modeling/BwCore.ecore');
  xml = ensureNamespace(xml, 'Type', 'http://www.sap.com/ndb/DataModelType.ecore');

  // Preserve the input's opening tag + <entity> reference; replace only the mapping list.
  const inputRegex2 = new RegExp(
    `(<input\\b[^>]*\\balias="${escapeRegex(alias)}"[^>]*>\\s*<entity>[^<]*<\\/entity>)[\\s\\S]*?(<\\/input>)`
  );
  xml = xml.replace(inputRegex2, `$1\n${mappingsXml.join('\n')}\n  $2`);

  const lockHandle = await client.lock('hcpr', compositeProviderName);
  try {
    await client.put('hcpr', compositeProviderName, lockHandle, xml, timestamp, transport);
  } catch (err) {
    await client.unlock('hcpr', compositeProviderName).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message: `Mappings for input ${alias} in CompositeProvider ${cpUpper} replaced (${effectiveMappings.length} mapping(s)). Call bw_activate to activate.`,
    lock_handle: lockHandle,
    composite_provider_name: cpUpper,
    object_type: 'hcpr',
    input_alias: alias,
  });
}

// ── Join key management ───────────────────────────────────────────────────────
//
// A Join view node isn't limited to a single pair: BW models N-way joins (star or
// chain topology) as N inputs plus one <join> element PER pairwise relationship
// (e.g. a fact + 2 dimensions needs 2 <join> elements: fact⋈dim1, fact⋈dim2). Each
// individual <join> element's own shape is confirmed (see bwCreateCompositeProvider's
// header note); the multi-join coexistence model itself is inferred, not captured —
// treat it as a reasonable, low-risk generalization rather than hard evidence.
// update_join therefore targets one specific (left_alias, right_alias) pair: it
// replaces that pair's existing <join> if one exists, or appends a new one alongside
// any others — so an N-way join is built by calling it once per pair.

export interface JoinKeyPair {
  left: string;  // BARE field name on the left input's own source InfoProvider (e.g. "MATNR")
  right: string; // BARE field name on the right input's own source InfoProvider
}

/** Finds the <join> element (self-closing or full form) between exactly this alias pair, if any. */
function findJoinBetween(xml: string, viewNodeName: string, left: string, right: string): RegExpMatchArray | null {
  const leftRef = escapeRegex(`#///${viewNodeName}/${left}`);
  const rightRef = escapeRegex(`#///${viewNodeName}/${right}`);
  const re = new RegExp(
    `[ \\t]*<join\\b(?=[^>]*\\bleftInput="${leftRef}")(?=[^>]*\\brightInput="${rightRef}")[^>]*(?:\\/>|>[\\s\\S]*?<\\/join>)\\n?`
  );
  return xml.match(re);
}

async function resolveInputProviderMeta(
  xml: string,
  alias: string,
  cpUpper: string
): Promise<{ providerName: string; fieldNamePrefix: string }> {
  const inputMatch = xml.match(new RegExp(`<input\\b[^>]*\\balias="${escapeRegex(alias)}"[^>]*>[\\s\\S]*?<\\/input>`));
  if (!inputMatch) throw new Error(`Could not find input ${alias} in CompositeProvider ${cpUpper}.`);
  const providerName = extractProviderNameFromInput(inputMatch[0]);
  if (!providerName) throw new Error(`Could not determine source InfoProvider for input ${alias}.`);
  const { fieldNamePrefix } = await fetchCompositeSourceFields(providerName);
  if (!fieldNamePrefix) throw new Error(`Could not determine field name prefix for source InfoProvider ${providerName.toUpperCase()}.`);
  return { providerName, fieldNamePrefix };
}

/**
 * bw_update_composite_provider action "update_join" — set or replace the join condition
 * (type, cardinality, key field pairs) between one specific pair of inputs on a Join view
 * node. Call once per pair to build an N-way (star/chain) join.
 *
 * Confirmed against a real captured trace (2-input Join, ZBF_DM ⋈ ZBF_EDW on MATNR+WERKS):
 * joinType is lowercase ("inner"), default cardinality is "CN_N" (not "M_N" as originally
 * guessed), and — importantly — <leftElementName>/<rightElementName> hold each side's own
 * source-prefixed field name (e.g. "4ZBF_DM-MATNR"), NOT the CompositeProvider's target
 * element name. keyPairs.left/right are therefore resolved against each input's own source
 * InfoProvider metadata, the same way add_input resolves mapping sources.
 * Returns the lock handle so the caller can invoke bw_activate next.
 */
export async function bwUpdateCompositeProviderJoin(
  client: BwClient,
  compositeProviderName: string,
  leftAlias: string,
  rightAlias: string,
  keyPairs: JoinKeyPair[],
  joinType: string = 'inner',
  cardinality: string = 'CN_N',
  transport?: string
): Promise<string> {
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

  const keyLines = keyPairs
    .map(
      (k) =>
        `    <leftElementName>${leftMeta.fieldNamePrefix}-${k.left.trim().toUpperCase()}</leftElementName>\n` +
        `    <rightElementName>${rightMeta.fieldNamePrefix}-${k.right.trim().toUpperCase()}</rightElementName>`
    )
    .join('\n');
  const joinXml =
    `  <join leftInput="#///${viewNodeName}/${left}" rightInput="#///${viewNodeName}/${right}"` +
    ` joinType="${joinType}" cardinality="${cardinality}">\n` +
    `${keyLines}\n` +
    `  </join>`;

  // Replace only the <join> for this exact (left, right) pair if one exists (whether the
  // bare create-time stub or a previously-saved full form) — other pairs' joins are untouched.
  const existing = findJoinBetween(xml, viewNodeName, left, right);
  if (existing) {
    xml = xml.replace(existing[0], joinXml + '\n');
  } else {
    xml = injectBeforeAnchor(xml, joinXml, ['</viewNode>'], '</viewNode>');
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
    message: `Join condition set in CompositeProvider ${cpUpper} (${left} ⋈ ${right}, ${keyPairs.length} key pair(s)). Call bw_activate to activate.`,
    lock_handle: lockHandle,
    composite_provider_name: cpUpper,
    object_type: 'hcpr',
    join_type: joinType,
    cardinality,
  });
}

/**
 * bw_update_composite_provider action "remove_join" — removes the <join> element between
 * one specific pair of inputs (leaves other pairs' joins, and the inputs themselves, intact).
 * Returns the lock handle so the caller can invoke bw_activate next.
 */
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
