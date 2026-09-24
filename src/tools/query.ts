import { XMLParser } from 'fast-xml-parser';
import {
  BwClient,
  createClientFromEnv,
  lockSessionHeader,
  MEDIA_TYPES,
  resolveMasterSystem,
  bwSeg,
  stripInfoAreaSentinel,
} from '../bw-client.js';

// Fallback version range used when the discovery document does not advertise a
// query media type. The exact query version depends on the BW backend SP level,
// so the version actually accepted by the system is read from discovery at
// startup (MEDIA_TYPES['query']) and preferred over this static list.
const QUERY_ACCEPT =
  'application/vnd.sap.bw.modeling.query-v1_8_0+xml, ' +
  'application/vnd.sap.bw.modeling.query-v1_9_0+xml, ' +
  'application/vnd.sap.bw.modeling.query-v1_10_0+xml, ' +
  'application/vnd.sap.bw.modeling.query-v1_11_0+xml';

// Accept header for the query creation lock (matches the Eclipse wizard trace).
export const QUERY_ACCEPT_LIST =
  'application/vnd.sap.bw.modeling.query-v1_8_0+xml, ' +
  'application/vnd.sap.bw.modeling.query-v1_9_0+xml, ' +
  'application/vnd.sap.bw.modeling.query-v1_10_0+xml, ' +
  'application/vnd.sap.bw.modeling.query-v1_11_0+xml';
// Media type used for the create POST body and its Accept header.
export const QUERY_V11 = 'application/vnd.sap.bw.modeling.query-v1_11_0+xml';

/**
 * Accept header for query GETs: the discovery-advertised media type first (so
 * systems on a higher or lower SP level negotiate correctly), with the static
 * version range kept as a fallback.
 */
export function queryAccept(): string {
  const discovered = MEDIA_TYPES['query'];
  return discovered ? `${discovered}, ${QUERY_ACCEPT}` : QUERY_ACCEPT;
}

// Concrete variable media type observed in the wire trace, and the fallback version
// range built from it. The variable resource has its own media type — a query-media-type
// Accept is rejected with HTTP 406 — and the range matches the Accept list Eclipse sends
// (see payloads/trace_20260710.log).
const VARIABLE_V10 = 'application/vnd.sap.bw.modeling.variable-v1_10_0+xml';

const VARIABLE_ACCEPT =
  'application/vnd.sap.bw.modeling.variable-v1_8_0+xml, ' +
  'application/vnd.sap.bw.modeling.variable-v1_9_0+xml, ' +
  VARIABLE_V10;

/**
 * Accept header for variable GETs: the discovery-advertised variable media type
 * first (so systems on a higher or lower SP level negotiate correctly), with the
 * static version range kept as a fallback.
 *
 * This is the single definition for the variable resource — the read tools, the
 * create flow and the update flow all negotiate through it, so a system on a
 * different SP level cannot be right for one of them and wrong for the others.
 */
export function variableAccept(): string {
  const discovered = MEDIA_TYPES['variable'];
  return discovered ? `${discovered}, ${VARIABLE_ACCEPT}` : VARIABLE_ACCEPT;
}

/**
 * Media type for variable write requests (create POST body / update PUT). Same shape
 * as queryWriteMediaType and rkfWriteMediaType: a Content-Type may name exactly one
 * version, so it comes from discovery where the backend advertises it.
 */
export function variableWriteMediaType(): string {
  return MEDIA_TYPES['variable'] ?? VARIABLE_V10;
}

// Fallback version ranges for the CKF and RKF resources (each has its own media
// type). Kept here alongside the other Accept helpers so the query read and
// write tools negotiate these components consistently.
const CKF_ACCEPT =
  'application/vnd.sap.bw.modeling.ckf-v1_8_0+xml, ' +
  'application/vnd.sap.bw.modeling.ckf-v1_9_0+xml, ' +
  'application/vnd.sap.bw.modeling.ckf-v1_10_0+xml';

const RKF_ACCEPT =
  'application/vnd.sap.bw.modeling.rkf-v1_8_0+xml, ' +
  'application/vnd.sap.bw.modeling.rkf-v1_9_0+xml, ' +
  'application/vnd.sap.bw.modeling.rkf-v1_10_0+xml';

/** Accept header for CKF GETs: discovery-advertised media type first, static range as fallback. */
export function ckfAccept(): string {
  const discovered = MEDIA_TYPES['ckf'];
  return discovered ? `${discovered}, ${CKF_ACCEPT}` : CKF_ACCEPT;
}

/** Accept header for RKF GETs: discovery-advertised media type first, static range as fallback. */
export function rkfAccept(): string {
  const discovered = MEDIA_TYPES['rkf'];
  return discovered ? `${discovered}, ${RKF_ACCEPT}` : RKF_ACCEPT;
}

// Concrete RKF media type observed in the create/update wire trace. Kept as a
// static fallback for the RKF write flow when discovery advertises no rkf entry.
const RKF_V10 = 'application/vnd.sap.bw.modeling.rkf-v1_10_0+xml';

/**
 * Media type for RKF write requests (create POST body / update PUT). Prefers the
 * version the backend advertises via discovery so systems on a different SP level
 * do not reject the write with HTTP 415; falls back to the traced v1_10_0 type.
 */
export function rkfWriteMediaType(): string {
  return MEDIA_TYPES['rkf'] ?? RKF_V10;
}

// Fallback version range for the reusable structure resource (v1_9_0 is the
// traced backend type). Kept alongside the other Accept helpers.
const STRUCTURE_ACCEPT =
  'application/vnd.sap.bw.modeling.structure-v1_8_0+xml, ' +
  'application/vnd.sap.bw.modeling.structure-v1_9_0+xml';

/** Accept header for structure GETs: discovery-advertised media type first, static range as fallback. */
export function structureAccept(): string {
  const discovered = MEDIA_TYPES['structure'];
  return discovered ? `${discovered}, ${STRUCTURE_ACCEPT}` : STRUCTURE_ACCEPT;
}

/**
 * Media type for query write requests (create POST body / update PUT). Prefers
 * the version the backend advertises via discovery so systems that negotiate a
 * lower query version do not reject the write with HTTP 415; falls back to the
 * static v1_11_0 media type when discovery carries no query entry.
 */
export function queryWriteMediaType(): string {
  return MEDIA_TYPES['query'] ?? QUERY_V11;
}

function ensureArray(val: unknown): unknown[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

function renderFormula(
  token: Record<string, unknown>,
  variableMap: Map<string, { technicalName: string }>,
  ckfMap: Map<string, { technicalName: string }>,
  rkfMap: Map<string, { technicalName: string }>,
  localMemberMap: Map<string, string>,
  depth = 0
): string {
  if (depth > 50) return '...';
  if (!token) return '?';
  const type = token['@_xsi:type'] as string | undefined;
  switch (type) {
    case 'Qry:FormulaInfixOperator': {
      const children = ensureArray(token['Qry:childToken']) as Record<string, unknown>[];
      if (children.length >= 2) {
        const left = renderFormula(children[0], variableMap, ckfMap, rkfMap, localMemberMap, depth + 1);
        const right = renderFormula(children[1], variableMap, ckfMap, rkfMap, localMemberMap, depth + 1);
        return `(${left} ${token['@_code']} ${right})`;
      }
      return `(${token['@_code']})`;
    }
    case 'Qry:FormulaPrefixOperator': {
      const children = ensureArray(token['Qry:childToken']) as Record<string, unknown>[];
      const code = token['@_code'] as string;
      if (code === 'IF' && children.length === 3) {
        return (
          `IF(${renderFormula(children[0], variableMap, ckfMap, rkfMap, localMemberMap, depth + 1)}, ` +
          `${renderFormula(children[1], variableMap, ckfMap, rkfMap, localMemberMap, depth + 1)}, ` +
          `${renderFormula(children[2], variableMap, ckfMap, rkfMap, localMemberMap, depth + 1)})`
        );
      }
      return `${code}(${children.map((c) => renderFormula(c, variableMap, ckfMap, rkfMap, localMemberMap, depth + 1)).join(', ')})`;
    }
    case 'Qry:FormulaIObjectOperand':
      return (token['@_infoObject'] as string) ?? '?';
    case 'Qry:FormulaMemberOperand': {
      const memberId = token['@_member'] as string;
      const opType = token['@_operandType'] as string;
      if (opType === 'Variable') {
        return variableMap.get(memberId)?.technicalName ?? memberId;
      }
      if (opType === 'Member') {
        return localMemberMap.get(memberId) ?? ckfMap.get(memberId)?.technicalName ?? rkfMap.get(memberId)?.technicalName ?? memberId;
      }
      return ckfMap.get(memberId)?.technicalName ?? rkfMap.get(memberId)?.technicalName ?? memberId;
    }
    case 'Qry:FormulaConstant':
      return String(token['@_value'] ?? '');
    default:
      return '?';
  }
}

function countMembersRecursive(node: Record<string, unknown>): number {
  const children = ensureArray(node['Qry:childMembers']) as Record<string, unknown>[];
  let count = children.length;
  for (const c of children) {
    count += countMembersRecursive(c);
  }
  return count;
}

function buildLocalMemberMap(members: unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  function collect(memberList: unknown[]) {
    for (const m of memberList as Record<string, unknown>[]) {
      const id = m['@_id'] as string | undefined;
      const desc = ((m['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? id ?? '';
      if (id) map.set(id, desc);
      const children = [...ensureArray(m['Qry:childMembers']), ...ensureArray(m['Qry:childFormulas'])];
      if (children.length > 0) collect(children);
    }
  }
  collect(members);
  return map;
}

function parseSelectionGroups(
  groups: unknown[],
  ckfMap: Map<string, { technicalName: string; description: string }>,
  rkfMap: Map<string, { technicalName: string; description: string }>
): Record<string, unknown>[] {
  return (groups as Record<string, unknown>[]).map((g) => {
    const tokens = ensureArray(g['Qry:tokens']) as Record<string, unknown>[];
    const parsedTokens = tokens.map((t) => {
      const tType = t['@_xsi:type'] as string;
      if (tType === 'Qry:SelectionTokenForComponent') {
        const compId = t['@_component'] as string;
        const ckfEntry = ckfMap.get(compId);
        const rkfEntry = rkfMap.get(compId);
        const entry = ckfEntry ?? rkfEntry;
        return {
          tokenType: 'SelectionTokenForComponent',
          componentId: compId,
          componentTechnicalName: entry?.technicalName ?? compId,
          componentType: ckfEntry ? 'CKF' : 'RKF',
        };
      }
      const fromValue = t['Qry:fromValue'] as Record<string, unknown> | undefined;
      const tok: Record<string, unknown> = {
        tokenType: 'SelectionRange',
        selectionType: (t['@_selectionType'] as string) ?? '',
        operator: (t['@_operator'] as string) ?? '',
        exclude: t['@_exclude'] === 'true' || t['@_exclude'] === true,
        value: (fromValue?.['Qry:value'] as string) ?? '',
      };
      const internalValue = fromValue?.['@_internalValue'] as string | undefined;
      if (internalValue) tok['internalValue'] = internalValue;
      const fromValueDesc = t['@_fromValueDesc'] as string | undefined;
      if (fromValueDesc) tok['valueDesc'] = fromValueDesc;
      return tok;
    });
    return {
      infoObject: (g['@_infoObject'] as string) ?? '',
      description: (g['@_description'] as string) ?? '',
      constantSelection: g['@_constantSelection'] === 'true' || g['@_constantSelection'] === true,
      tokens: parsedTokens,
    };
  });
}

/** True when a settings element is absent or carries the server's default marker. */
function isDefaultSetting(node: Record<string, unknown> | undefined): boolean {
  if (!node) return true;
  return node['@_default'] === 'true' || node['@_default'] === true;
}

/**
 * Collect the explicitly set attributes of a settings element (all attributes
 * except the `default` marker), or undefined when the element is at its default.
 * Used for settings whose attribute set is not fully known from observed
 * documents, so that whatever the server writes is reported rather than dropped.
 */
function explicitSettingAttrs(node: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (isDefaultSetting(node)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node!)) {
    if (k === '@_default' || !k.startsWith('@_')) continue;
    out[k.slice(2)] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Planning properties of a structure member: input readiness and disaggregation.
 * Input readiness is what makes a member usable in a planning query; it is carried
 * by a nested Qry:planning element, not by an attribute on the member itself.
 * Both settings report "default" when the server marks them as such.
 *
 * The lock flag is deliberately not reported as a separate property: it is not in
 * the document at all, and a metadata-table cross-check over input-ready and
 * locked members of a live planning query showed it following input readiness
 * without exception. The same check showed the "no subtotals" flag set on every
 * member including generated ones, so it is server-derived rather than modelled.
 */
export function parseMemberPlanning(
  member: Record<string, unknown>,
  localMemberMap?: Map<string, string>
): Record<string, unknown> | undefined {
  const planningNode = member['Qry:planning'] as Record<string, unknown> | undefined;
  if (!planningNode) return undefined;
  const inputModeNode = planningNode['Qry:inputMode'] as Record<string, unknown> | undefined;
  const disaggNode = planningNode['Qry:disaggregation'] as Record<string, unknown> | undefined;
  const planning: Record<string, unknown> = {
    inputMode: isDefaultSetting(inputModeNode) ? 'default' : ((inputModeNode!['@_type'] as string) ?? 'default'),
    disaggregation: isDefaultSetting(disaggNode) ? 'default' : ((disaggNode!['@_type'] as string) ?? 'default'),
  };
  const disaggRef = disaggNode?.['@_reference'] as string | undefined;
  if (disaggRef) planning['disaggregationReference'] = localMemberMap?.get(disaggRef) ?? disaggRef;
  return planning;
}

/**
 * Labels of the exception aggregation types, taken from the fixed values of the
 * domain RSAGGREXC (the codes the server writes into the type attribute). A code
 * outside this list is still reported, just without a label.
 */
export const EXCEPTION_AGGREGATION_LABELS: Record<string, string> = {
  AV0: 'Average (values not equal to zero)',
  AV1: 'Average (weighted with the number of days)',
  AV2: 'Average (weighted with the number of working days; factory calendar)',
  AVG: 'Average (all values)',
  CN0: 'Counter (values not equal to zero)',
  CNT: 'Counter (all values)',
  FIR: 'First value',
  LAS: 'Last value',
  MAX: 'Maximum',
  MIN: 'Minimum',
  NO1: 'No aggregation (X if more than one record occurs)',
  NO2: 'No aggregation (X if more than one value occurs)',
  NOP: 'No aggregation (X if more than one value not equal to zero occurs)',
  STD: 'Standard deviation',
  SUM: 'Summation',
  VAR: 'Variance',
};

export interface ParsedExceptionAggregation {
  type: string;
  label?: string;
  referenceCharacteristics: string[];
  exclude?: true;
}

/**
 * Exception aggregation of a member (a CKF, an RKF or a structure member), or
 * undefined when none is set. The server writes it as
 *   <Qry:exceptionAggregation exclude="false" type="CN0">
 *     <Qry:referenceCharacteristic>0DOC_NUMBER</Qry:referenceCharacteristic>
 *   </Qry:exceptionAggregation>
 * and as an empty <Qry:exceptionAggregation/> when unset. A formula can aggregate
 * over several reference characteristics at once, so every one is reported.
 * A type without any reference characteristic also occurs (structure formulas
 * with type="SUM", including in SAP-delivered content); it is reported as such,
 * with an empty list, rather than being dropped or completed.
 */
export function parseExceptionAggregation(
  member: Record<string, unknown> | undefined
): ParsedExceptionAggregation | undefined {
  const node = member?.['Qry:exceptionAggregation'];
  if (!node || typeof node !== 'object') return undefined;
  const ea = node as Record<string, unknown>;
  const type = ea['@_type'] as string | undefined;
  if (!type) return undefined;
  const referenceCharacteristics = ensureArray(ea['Qry:referenceCharacteristic'])
    .map((rc) => {
      if (rc !== null && typeof rc === 'object') {
        const o = rc as Record<string, unknown>;
        return String(o['#text'] ?? o['@_name'] ?? o['@_infoObject'] ?? '');
      }
      return String(rc ?? '');
    })
    .filter(Boolean);
  const result: ParsedExceptionAggregation = { type, referenceCharacteristics };
  const label = EXCEPTION_AGGREGATION_LABELS[type];
  if (label) result.label = label;
  if (ea['@_exclude'] === 'true' || ea['@_exclude'] === true) result.exclude = true;
  return result;
}

/** One-line rendering, e.g. "CN0 (Counter (values not equal to zero)) by 0DOC_NUMBER". */
export function formatExceptionAggregation(ea: ParsedExceptionAggregation): string {
  const refs =
    ea.referenceCharacteristics.length > 0
      ? `by ${ea.referenceCharacteristics.join(', ')}`
      : 'without reference characteristic';
  return `${ea.type}${ea.label ? ` (${ea.label})` : ''} ${refs}${ea.exclude ? ' [exclude=true]' : ''}`;
}

function parseMemberRecursive(
  member: Record<string, unknown>,
  variableMap: Map<string, { technicalName: string }>,
  ckfMap: Map<string, { technicalName: string; description: string }>,
  rkfMap: Map<string, { technicalName: string; description: string }>,
  localMemberMap: Map<string, string>
): Record<string, unknown> {
  const mType = member['@_xsi:type'] as string;
  const id = (member['@_id'] as string) ?? '';
  const descNode = member['Qry:description'] as Record<string, unknown> | undefined;
  const desc = (descNode?.['@_value'] as string) ?? '';
  const shortDesc = descNode?.['@_shortValue'] as string | undefined;
  const visibility = ((member['Qry:hidden'] as Record<string, unknown> | undefined)?.['@_type'] as string) ?? 'showAlways';
  const isFormula = mType === 'Qry:MemberFormula' || mType === 'Qry:MemberFormulaInverse';

  const result: Record<string, unknown> = {
    id,
    type: isFormula ? mType.replace('Qry:', '') : 'MemberSelection',
    description: desc,
    visibility,
  };
  if (shortDesc) result['shortDescription'] = shortDesc;

  // An inverse formula names the member the entered value is written back to.
  if (mType === 'Qry:MemberFormulaInverse') {
    const inverseFor = member['@_member'] as string | undefined;
    if (inverseFor) result['inverseFor'] = localMemberMap.get(inverseFor) ?? inverseFor;
  }

  const flatPosition = member['@_flatPosition'];
  if (flatPosition !== undefined) result['flatPosition'] = Number(flatPosition);
  if (member['@_constSelection'] !== undefined) {
    result['constantSelection'] = member['@_constSelection'] === 'true' || member['@_constSelection'] === true;
  }

  const decimalsNode = member['Qry:decimals'] as Record<string, unknown> | undefined;
  if (!isDefaultSetting(decimalsNode)) result['decimals'] = Number(decimalsNode!['@_number']);
  const signInversionNode = member['Qry:signInversion'] as Record<string, unknown> | undefined;
  if (!isDefaultSetting(signInversionNode)) {
    result['signInversion'] = signInversionNode!['@_invert'] === 'true' || signInversionNode!['@_invert'] === true;
  }
  const scaling = explicitSettingAttrs(member['Qry:scaling'] as Record<string, unknown> | undefined);
  if (scaling) result['scaling'] = scaling;
  const planning = parseMemberPlanning(member, localMemberMap);
  if (planning) result['planning'] = planning;
  const exceptionAggregation = parseExceptionAggregation(member);
  if (exceptionAggregation) result['exceptionAggregation'] = exceptionAggregation;

  if (isFormula) {
    const formulaDef = member['Qry:formulaDefinition'] as Record<string, unknown> | undefined;
    const formulaToken = formulaDef?.['Qry:formulaToken'] as Record<string, unknown> | undefined;
    result['formula'] = formulaToken ? renderFormula(formulaToken, variableMap, ckfMap, rkfMap, localMemberMap) : '';
  } else {
    result['selections'] = parseSelectionGroups(ensureArray(member['Qry:groups']), ckfMap, rkfMap);
    const defaultHint = member['Qry:defaultHint'] as Record<string, unknown> | undefined;
    if ((defaultHint?.['Qry:type'] as string) === 'CINLink') {
      const hintValue = defaultHint?.['Qry:value'] as string | undefined;
      if (hintValue) {
        const ckfEntry = ckfMap.get(hintValue);
        const rkfEntry = rkfMap.get(hintValue);
        const entry = ckfEntry ?? rkfEntry;
        if (entry) {
          result['referencedComponent'] = {
            technicalName: entry.technicalName,
            description: entry.description,
            componentType: ckfEntry ? 'CKF' : 'RKF',
          };
        }
      }
    }
  }

  const childMembersRaw = ensureArray(member['Qry:childMembers']) as Record<string, unknown>[];
  if (childMembersRaw.length > 0) {
    result['childMembers'] = childMembersRaw.map((cm) =>
      parseMemberRecursive(cm, variableMap, ckfMap, rkfMap, localMemberMap)
    );
  }

  // Inverse formulas sit beside the child members and carry the write-back rule an
  // input-ready formula needs; without them an input-ready formula cannot be posted to.
  const childFormulasRaw = ensureArray(member['Qry:childFormulas']) as Record<string, unknown>[];
  if (childFormulasRaw.length > 0) {
    result['childFormulas'] = childFormulasRaw.map((cf) =>
      parseMemberRecursive(cf, variableMap, ckfMap, rkfMap, localMemberMap)
    );
  }

  return result;
}

function parseDimElement(
  elem: Record<string, unknown>,
  variableMap: Map<string, { technicalName: string }>,
  ckfMap: Map<string, { technicalName: string; description: string }>,
  rkfMap: Map<string, { technicalName: string; description: string }>
): Record<string, unknown> {
  const type = elem['@_xsi:type'] as string;
  if (type === 'Qry:CustomDimension') {
    const membersRaw = ensureArray(elem['Qry:members']) as Record<string, unknown>[];
    const localMemberMap = buildLocalMemberMap(membersRaw);
    let memberCount = membersRaw.length;
    for (const m of membersRaw) {
      memberCount += countMembersRecursive(m);
    }
    const members = membersRaw.map((m) => parseMemberRecursive(m, variableMap, ckfMap, rkfMap, localMemberMap));
    return {
      type: 'CustomDimension',
      technicalName: (elem['@_technicalName'] as string) ?? '',
      description: ((elem['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
      reusable: elem['@_reusable'] === 'true' || elem['@_reusable'] === true,
      suppressZeros: elem['@_suppressZeros'] === 'true' || elem['@_suppressZeros'] === true,
      memberCount,
      members,
    };
  }
  const additionalInfo = elem['Qry:additionalInfo'] as Record<string, unknown> | undefined;
  const kvPairs = ensureArray(additionalInfo?.['Qry:keyValuePairs']) as Record<string, unknown>[];
  const infoObjectTypeKv = kvPairs.find((kv) => kv['@_key'] === 'infoObjectType');
  const result: Record<string, unknown> = {
    type: 'Dimension',
    infoObjectName: (elem['@_infoObjectName'] as string) ?? '',
    description: ((elem['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
  };
  if (infoObjectTypeKv) result.infoObjectType = infoObjectTypeKv['@_value'];
  return result;
}

/**
 * Render the members of a structure as indented lines, one per member, with the
 * child members and inverse formulas nested underneath. Only explicitly set
 * properties are appended, so a line stays short unless the member actually
 * deviates from the server defaults.
 */
function renderMemberLines(members: unknown[], indent: string, lines: string[]): void {
  for (const m of members as Record<string, unknown>[]) {
    const flags: string[] = [];
    if (m['visibility'] && m['visibility'] !== 'showAlways') flags.push(`visibility=${m['visibility']}`);
    const planning = m['planning'] as Record<string, unknown> | undefined;
    if (planning && planning['inputMode'] !== 'default') flags.push(`inputMode=${planning['inputMode']}`);
    if (planning && planning['disaggregation'] !== 'default') {
      const ref = planning['disaggregationReference'];
      flags.push(`disaggregation=${planning['disaggregation']}${ref ? ` → ${ref}` : ''}`);
    }
    if (m['decimals'] !== undefined) flags.push(`decimals=${m['decimals']}`);
    // The server writes an explicit "not inverted" on every member; only the
    // inverting case carries information for a reader.
    if (m['signInversion'] === true) flags.push('signInversion=true');
    if (m['constantSelection'] === true) flags.push('constantSelection=true');
    if (m['inverseFor']) flags.push(`inverseFor=${m['inverseFor']}`);
    const memberEa = m['exceptionAggregation'] as ParsedExceptionAggregation | undefined;
    if (memberEa) {
      const refs = memberEa.referenceCharacteristics;
      flags.push(`exceptionAggregation=${memberEa.type}${refs.length > 0 ? `(${refs.join(',')})` : '(no reference characteristic)'}`);
    }
    const label = m['description'] ? String(m['description']) : String(m['id'] ?? '');
    lines.push(`${indent}${label}  [${m['type']}]${flags.length > 0 ? '  ' + flags.join('  ') : ''}`);
    if (m['formula']) lines.push(`${indent}  Formula: ${m['formula']}`);
    const children = [
      ...((m['childMembers'] as unknown[]) ?? []),
      ...((m['childFormulas'] as unknown[]) ?? []),
    ];
    if (children.length > 0) renderMemberLines(children, indent + '  ', lines);
  }
}

function renderQueryText(q: Record<string, unknown>): string {
  const lines: string[] = [];
  const s = (v: unknown) => (v != null && v !== '' ? String(v) : '—');
  const bool = (v: unknown) => (v === true || v === 'true') ? 'yes' : 'no';

  lines.push(`Query: ${s(q['name'])} — ${s(q['description'])}`);
  lines.push(`InfoProvider: ${s(q['infoProvider'])} (${s(q['providerType'])})`);
  lines.push(`InfoArea: ${s(q['infoArea'])}  Package: ${s(q['package'])}`);
  lines.push(`Status: ${s(q['status'])}  Changed: ${s(q['changedAt'])}  By: ${s(q['responsible'])}`);
  if (q['versionNote']) lines.push(`Note: ${q['versionNote']}`);

  const settings = q['settings'] as Record<string, unknown> ?? {};
  const zs = settings['zeroSuppression'] as Record<string, unknown> ?? {};
  const rp = settings['resultPosition'] as Record<string, unknown> ?? {};
  lines.push('');
  lines.push('── Settings ──');
  lines.push(`  Zero suppression: rows=${bool(zs['rows'])}  columns=${bool(zs['columns'])}  mode=${s(zs['mode'])}`);
  lines.push(`  Result position: top=${bool(rp['onTop'])}  left=${bool(rp['onLeft'])}`);
  lines.push(`  RFC=${bool(settings['rfcEnabled'])}  OData=${bool(settings['odataSupport'])}  EasyQuery=${bool(settings['easyQuery'])}`);
  lines.push(`  Sign presentation: ${s(settings['signPresentation'])}`);

  const variables = q['variables'] as unknown[] ?? [];
  if (variables.length > 0) {
    lines.push('');
    lines.push('── Variables ──');
    for (const v of variables as Record<string, unknown>[]) {
      lines.push(`  ${s(v['technicalName'])}  ${s(v['description'])}`);
      lines.push(`    InfoObject: ${s(v['infoObject'])}  Type: ${s(v['type'])}  ProcType: ${s(v['procType'])}`);
      lines.push(`    InputType: ${s(v['inputType'])}  Represents: ${s(v['represents'])}`);
    }
  }

  const filter = q['filter'] as unknown[] ?? [];
  if (filter.length > 0) {
    lines.push('');
    lines.push('── Filter ──');
    for (const f of filter as Record<string, unknown>[]) {
      const parts: string[] = [];
      const fixedValues = (f['fixedValues'] as Record<string, unknown>[] | undefined) ?? [];
      for (const fv of fixedValues) {
        const prefix = fv['exclude'] === true ? 'exclude ' : '';
        const lowDesc = fv['valueDesc'] ? ` (${s(fv['valueDesc'])})` : '';
        let valueText: string;
        if (fv['highValue'] !== undefined) {
          const highDesc = fv['highValueDesc'] ? ` (${s(fv['highValueDesc'])})` : '';
          valueText = `${s(fv['value'])}${lowDesc} .. ${s(fv['highValue'])}${highDesc}`;
        } else {
          valueText = `${s(fv['value'])}${lowDesc}`;
        }
        parts.push(`${prefix}${s(fv['operator'])} ${valueText}`);
      }
      const variable = f['variable'] as Record<string, unknown> | undefined;
      if (variable) {
        const varDesc = variable['description'] ? ` (${s(variable['description'])})` : '';
        parts.push(`variable ${s(variable['technicalName'])}${varDesc}`);
      }
      lines.push(`  ${s(f['infoObject'])}: ${parts.length > 0 ? parts.join(', ') : '(no restriction)'}`);
    }
  }

  const rows = q['rows'] as unknown[] ?? [];
  const columns = q['columns'] as unknown[] ?? [];
  const free = q['freeCharacteristics'] as unknown[] ?? [];

  // Label for a layout element: technical name → InfoObject name → description →
  // "1KYFNM structure" (a key figure CustomDimension often carries none of the first three).
  const dimLabel = (d: Record<string, unknown>) => {
    if (d['technicalName']) return String(d['technicalName']);
    if (d['infoObjectName']) return String(d['infoObjectName']);
    if (d['description']) return String(d['description']);
    return '1KYFNM structure';
  };

  const dimLine = (d: Record<string, unknown>) => {
    lines.push(`    ${dimLabel(d)}  ${s(d['description'])}  [${s(d['type'])}]`);
    const members = (d['members'] as unknown[]) ?? [];
    if (members.length > 0) renderMemberLines(members, '      ', lines);
  };

  lines.push('');
  lines.push('── Layout ──');
  lines.push(`  ROWS (${rows.length}):`);
  for (const r of rows as Record<string, unknown>[]) dimLine(r);
  lines.push(`  COLUMNS (${columns.length}):`);
  for (const c of columns as Record<string, unknown>[]) dimLine(c);
  lines.push(`  FREE (${free.length}):`);
  for (const f of free as Record<string, unknown>[]) dimLine(f);

  const ckfs = q['calculatedMeasures'] as unknown[] ?? [];
  if (ckfs.length > 0) {
    lines.push('');
    lines.push(`── Calculated Key Figures (${ckfs.length}) ──`);
    for (const c of ckfs as Record<string, unknown>[]) {
      lines.push(`  ${s(c['technicalName'])}  ${s(c['description'])}`);
      if (c['formula']) lines.push(`    Formula: ${s(c['formula'])}`);
      const ea = c['exceptionAggregation'] as ParsedExceptionAggregation | undefined;
      if (ea) lines.push(`    Exception aggregation: ${formatExceptionAggregation(ea)}`);
    }
  }

  const rkfs = q['restrictedMeasures'] as unknown[] ?? [];
  if (rkfs.length > 0) {
    lines.push('');
    lines.push(`── Restricted Key Figures (${rkfs.length}) ──`);
    for (const r of rkfs as Record<string, unknown>[]) {
      lines.push(`  ${s(r['technicalName'])}  ${s(r['description'])}`);
      const member = r['member'] as Record<string, unknown> | undefined;
      if (member?.['keyFigure']) lines.push(`    KeyFigure: ${s(member['keyFigure'])}`);
      const ea = r['exceptionAggregation'] as ParsedExceptionAggregation | undefined;
      if (ea) lines.push(`    Exception aggregation: ${formatExceptionAggregation(ea)}`);
    }
  }

  const exceptions = q['exceptions'] as unknown[] ?? [];
  if (exceptions.length > 0) {
    lines.push('');
    lines.push(`── Exceptions (${exceptions.length}) ──`);
    for (const e of exceptions as Record<string, unknown>[]) {
      lines.push(`  ${s(e['description'])}  evaluated=${bool(e['evaluated'])}`);
      const thresholds = e['thresholds'] as unknown[] ?? [];
      for (const t of thresholds as Record<string, unknown>[]) {
        lines.push(`    Level ${s(t['alertLevel'])}: ${s(t['operator'])} ${s(t['value'])}`);
      }
    }
  }

  const hasCells = q['hasCellDefinitions'] as boolean;
  if (hasCells) {
    const gridCells = q['gridCells'] as unknown[] ?? [];
    const helpCells = q['helpCells'] as unknown[] ?? [];
    lines.push('');
    lines.push(`── Cell Definitions ──`);
    lines.push(`  Grid cells: ${gridCells.length}  Help cells: ${helpCells.length}`);
    for (const gc of gridCells as Record<string, unknown>[]) {
      lines.push(`  [${s(gc['type'])}] ${s(gc['description'])}  coord1=${s(gc['coordinateMember1'])}  coord2=${s(gc['coordinateMember2'])}`);
      if (gc['formula']) lines.push(`    Formula: ${s(gc['formula'])}`);
    }
  }

  return lines.join('\n');
}

export async function bwGetQuery(queryName: string, format: 'text' | 'raw' = 'text'): Promise<string> {
  const client = createClientFromEnv();

  const basePath = `/sap/bw/modeling/query/${bwSeg(queryName)}`;
  let xmlBody: string;
  let versionNote: string | undefined;

  const accept = queryAccept();
  try {
    const result = await client.get(`${basePath}/a`, accept);
    xmlBody = result.body;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('HTTP 404')) {
      const result = await client.get(`${basePath}/m`, accept);
      xmlBody = result.body;
      versionNote = 'inactive version returned';
    } else {
      throw err;
    }
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (tagName) =>
      [
        'Qry:subComponents',
        'Qry:selections',
        'Qry:tokens',
        'Qry:members',
        'Qry:childMembers',
        'Qry:childFormulas',
        'Qry:free',
        'Qry:rows',
        'Qry:columns',
        'Qry:exceptions',
        'Qry:conditions',
        'Qry:gridCells',
        'Qry:helpCells',
        'Qry:groups',
        'Qry:childToken',
        'Qry:referenceCharacteristic',
        'atom:link',
      ].includes(tagName),
  });

  const parsed = parser.parse(xmlBody);
  const root = parsed['Qry:queryResource'] as Record<string, unknown>;

  // Step 1: Build subComponent maps
  const variableMap = new Map<string, { technicalName: string; description: string; infoObject: string; type: string; procType: string; inputType: string; represents: string; defaultSelection: unknown }>();
  const ckfMap = new Map<string, { technicalName: string; description: string; formulaDefinition: unknown; exceptionAggregation?: ParsedExceptionAggregation }>();
  const rkfMap = new Map<string, { technicalName: string; description: string; member: Record<string, unknown> | undefined }>();

  const subComponents = ensureArray(root['Qry:subComponents']) as Record<string, unknown>[];
  for (const sc of subComponents) {
    const scType = sc['@_xsi:type'] as string;
    const id = sc['@_id'] as string;
    if (scType === 'Qry:Variable') {
      variableMap.set(id, {
        technicalName: (sc['@_technicalName'] as string) ?? '',
        description: ((sc['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
        infoObject: (sc['@_infoObject'] as string) ?? '',
        type: (sc['Qry:type'] as string) ?? '',
        procType: (sc['Qry:procType'] as string) ?? '',
        inputType: (sc['Qry:inputType'] as string) ?? '',
        represents: (sc['Qry:represents'] as string) ?? '',
        defaultSelection: sc['Qry:defaultSelection'],
      });
    } else if (scType === 'Qry:CalculatedMeasure') {
      const member = sc['Qry:member'] as Record<string, unknown> | undefined;
      ckfMap.set(id, {
        technicalName: (sc['@_technicalName'] as string) ?? '',
        description: ((sc['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
        formulaDefinition: member?.['Qry:formulaDefinition'],
        exceptionAggregation: parseExceptionAggregation(member),
      });
    } else if (scType === 'Qry:RestrictedMeasure') {
      rkfMap.set(id, {
        technicalName: (sc['@_technicalName'] as string) ?? '',
        description: ((sc['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
        member: sc['Qry:member'] as Record<string, unknown> | undefined,
      });
    }
  }

  // Step 3: Parse mainComponent metadata
  const mainComp = root['Qry:mainComponent'] as Record<string, unknown>;
  const entityProps = mainComp['Qry:entityProperties'] as Record<string, unknown>;
  const links = ensureArray(entityProps['atom:link']) as Record<string, unknown>[];
  const relatedLink = links.find((l) => l['@_rel'] === 'related');
  const href = (relatedLink?.['@_href'] as string) ?? '';

  let providerType: string;
  if (href.includes('/hcpr/')) providerType = 'CompositeProvider';
  else if (href.includes('/alvl/')) providerType = 'AggregationLevel';
  else if (href.includes('/adso/')) providerType = 'aDSO';
  else providerType = 'Unknown';

  const packageRef = entityProps['adtCore:packageRef'] as Record<string, unknown> | undefined;

  // Step 4: Variables in order of subComponents appearance
  const variables: Record<string, unknown>[] = [];
  for (const sc of subComponents) {
    if (sc['@_xsi:type'] !== 'Qry:Variable') continue;
    const v: Record<string, unknown> = {
      technicalName: (sc['@_technicalName'] as string) ?? '',
      description: ((sc['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
      infoObject: (sc['@_infoObject'] as string) ?? '',
      type: (sc['Qry:type'] as string) ?? '',
      procType: (sc['Qry:procType'] as string) ?? '',
      inputType: (sc['Qry:inputType'] as string) ?? '',
      represents: (sc['Qry:represents'] as string) ?? '',
    };
    const defaultSel = sc['Qry:defaultSelection'] as Record<string, unknown> | undefined;
    if (defaultSel && defaultSel['@_fromValue'] !== undefined) {
      v['defaultValue'] = String(defaultSel['@_fromValue']);
    }
    variables.push(v);
  }

  // Step 5: Parse filter
  const filterSection = mainComp['Qry:filter'] as Record<string, unknown> | undefined;
  const selections = ensureArray(filterSection?.['Qry:selections']) as Record<string, unknown>[];
  const filter: Record<string, unknown>[] = [];
  for (const sel of selections) {
    const usageType = (sel['@_usageType'] as string) ?? '';
    const tokens = ensureArray(sel['Qry:tokens']) as Record<string, unknown>[];
    if (usageType === 'asStartValue' && tokens.length === 0) continue;

    const infoObject = (sel['@_infoObject'] as string) ?? '';
    const localDim = sel['Qry:localDimension'] as Record<string, unknown> | undefined;
    const description = localDim
      ? ((localDim['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? infoObject
      : infoObject;

    const item: Record<string, unknown> = { infoObject, description, usageType };

    const fixedValues = tokens
      .filter((t) => t['@_xsi:type'] === 'Qry:SelectionRange')
      .map((t) => {
        const fromValue = t['Qry:fromValue'] as Record<string, unknown> | undefined;
        const fv: Record<string, unknown> = {
          operator: (t['@_operator'] as string) ?? '',
          exclude: t['@_exclude'] === 'true' || t['@_exclude'] === true,
          value: (fromValue?.['Qry:value'] as string) ?? '',
        };
        const fromValueDesc = t['@_fromValueDesc'] as string | undefined;
        if (fromValueDesc) fv['valueDesc'] = fromValueDesc;
        const toValue = t['Qry:toValue'] as Record<string, unknown> | undefined;
        if (toValue) {
          fv['highValue'] = (toValue['Qry:value'] as string) ?? '';
          const toValueDesc = t['@_toValueDesc'] as string | undefined;
          if (toValueDesc) fv['highValueDesc'] = toValueDesc;
        }
        return fv;
      });

    if (fixedValues.length > 0) item['fixedValues'] = fixedValues;

    const varToken = tokens.find((t) => t['@_xsi:type'] === 'Qry:SelectionVariable');
    if (varToken) {
      const varId = varToken['@_variable'] as string;
      const varInfo = variableMap.get(varId);
      item['variable'] = {
        technicalName: varInfo?.technicalName ?? varId,
        description: varInfo?.description ?? '',
      };
    }

    filter.push(item);
  }

  // Step 6: Parse layout
  const columnsRaw = ensureArray(mainComp['Qry:columns']) as Record<string, unknown>[];
  const rowsRaw = ensureArray(mainComp['Qry:rows']) as Record<string, unknown>[];
  const freeRaw = ensureArray(mainComp['Qry:free']) as Record<string, unknown>[];

  const columns = columnsRaw.map((elem) => parseDimElement(elem, variableMap, ckfMap, rkfMap));
  const rows = rowsRaw.map((elem) => parseDimElement(elem, variableMap, ckfMap, rkfMap));
  const freeCharacteristics = freeRaw.map((elem) => {
    const additionalInfo = elem['Qry:additionalInfo'] as Record<string, unknown> | undefined;
    const kvPairs = ensureArray(additionalInfo?.['Qry:keyValuePairs']) as Record<string, unknown>[];
    const infoObjectTypeKv = kvPairs.find((kv) => kv['@_key'] === 'infoObjectType');
    const result: Record<string, unknown> = {
      infoObjectName: (elem['@_infoObjectName'] as string) ?? '',
      description: ((elem['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
    };
    if (infoObjectTypeKv) result['infoObjectType'] = infoObjectTypeKv['@_value'];
    return result;
  });

  // Step 7: Calculated Measures (CKFs only)
  const calculatedMeasures: Record<string, unknown>[] = [];
  for (const [, ckf] of ckfMap) {
    const formulaDef = ckf.formulaDefinition as Record<string, unknown> | undefined;
    const formulaToken = formulaDef?.['Qry:formulaToken'] as Record<string, unknown> | undefined;
    const measure: Record<string, unknown> = {
      technicalName: ckf.technicalName,
      description: ckf.description,
      formula: formulaToken ? renderFormula(formulaToken, variableMap, ckfMap, rkfMap, new Map()) : '',
    };
    if (ckf.exceptionAggregation) measure['exceptionAggregation'] = ckf.exceptionAggregation;
    calculatedMeasures.push(measure);
  }

  // Step 8: Restricted Measures
  const restrictedMeasures: Record<string, unknown>[] = [];
  for (const [, rkf] of rkfMap) {
    const measure: Record<string, unknown> = {
      technicalName: rkf.technicalName,
      description: rkf.description,
      selections: parseSelectionGroups(ensureArray(rkf.member?.['Qry:groups']), ckfMap, rkfMap),
    };
    const rkfEa = parseExceptionAggregation(rkf.member);
    if (rkfEa) measure['exceptionAggregation'] = rkfEa;
    restrictedMeasures.push(measure);
  }

  // Step 9: Exceptions
  const exceptionsRaw = ensureArray(mainComp['Qry:exceptions']) as Record<string, unknown>[];
  const exceptions = exceptionsRaw.map((ex) => {
    const exTokens = ensureArray(ex['Qry:tokens']) as Record<string, unknown>[];
    const thresholds = exTokens.map((t) => {
      const fromValue = t['Qry:fromValue'] as Record<string, unknown> | undefined;
      const toValueNode = t['Qry:toValue'] as Record<string, unknown> | undefined;
      const threshold: Record<string, unknown> = {
        alertLevel: (t['@_alertLevel'] as string) ?? '',
        operator: (t['@_operator'] as string) ?? '',
        value: (fromValue?.['Qry:value'] as string) ?? '',
      };
      const toVal = toValueNode?.['Qry:value'] as string | undefined;
      if (toVal !== undefined) threshold['toValue'] = toVal;
      return threshold;
    });
    const exception: Record<string, unknown> = {
      id: (ex['@_id'] as string) ?? '',
      active: ex['@_active'] === 'true' || ex['@_active'] === true,
      evaluateBeforeListCalc: ex['@_evaluateBeforeListCalc'] === 'true' || ex['@_evaluateBeforeListCalc'] === true,
      affectsChasNotListed: (ex['@_affectsChasNotListed'] as string) ?? '',
      affectsDataCells: ex['@_affectsDataCells'] === 'true' || ex['@_affectsDataCells'] === true,
      description: ((ex['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
      thresholds,
    };
    const firstStruc = ex['Qry:definedCellFirstStruc'] as Record<string, unknown> | undefined;
    const firstMember = firstStruc?.['Qry:member'] as string | undefined;
    if (firstMember) exception['firstStructureMember'] = firstMember;
    const secondStruc = ex['Qry:definedCellSecondStruc'] as Record<string, unknown> | undefined;
    const secondMember = secondStruc?.['Qry:member'] as string | undefined;
    if (secondMember) exception['secondStructureMember'] = secondMember;
    return exception;
  });

  // Step 10: Cell definitions
  const gridCellsRaw = ensureArray(mainComp['Qry:gridCells']) as Record<string, unknown>[];
  const helpCellsRaw = ensureArray(mainComp['Qry:helpCells']) as Record<string, unknown>[];
  const hasCellDefinitions = gridCellsRaw.length > 0 || helpCellsRaw.length > 0;

  const gridCells = gridCellsRaw.map((gc) => {
    const gcType = gc['@_xsi:type'] as string;
    const cell: Record<string, unknown> = {
      id: (gc['@_id'] as string) ?? '',
      type: gcType === 'Qry:FormulaCell' ? 'FormulaCell' : 'ReferenceCell',
      description: ((gc['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
      coordinateMember1: (gc['Qry:coordinateMember1'] as string) ?? '',
      coordinateMember2: (gc['Qry:coordinateMember2'] as string) ?? '',
    };
    if (gcType === 'Qry:FormulaCell') {
      const formulaDef = gc['Qry:formulaDefinition'] as Record<string, unknown> | undefined;
      const formulaToken = formulaDef?.['Qry:formulaToken'] as Record<string, unknown> | undefined;
      cell['formula'] = formulaToken ? renderFormula(formulaToken, variableMap, ckfMap, rkfMap, new Map()) : '';
    }
    return cell;
  });

  const helpCells = helpCellsRaw.map((hc) => ({
    id: (hc['@_id'] as string) ?? '',
    description: ((hc['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
    selections: parseSelectionGroups(ensureArray(hc['Qry:groups']), ckfMap, rkfMap),
  }));

  // Step 11: Query-level settings
  const zeroSuppr = mainComp['Qry:zeroSuppression'] as Record<string, unknown> | undefined;
  const planningNode = mainComp['Qry:planning'] as Record<string, unknown> | undefined;
  const resultPosNode = mainComp['Qry:resultPosition'] as Record<string, unknown> | undefined;
  const zeroSuppression: Record<string, unknown> = {
    rows: zeroSuppr?.['@_rows'] === 'true' || zeroSuppr?.['@_rows'] === true,
    columns: zeroSuppr?.['@_columns'] === 'true' || zeroSuppr?.['@_columns'] === true,
  };
  if (zeroSuppr?.['@_mode']) zeroSuppression['mode'] = zeroSuppr['@_mode'] as string;
  const settings: Record<string, unknown> = {
    rfcEnabled: mainComp['@_rfcEnabled'] === 'true' || mainComp['@_rfcEnabled'] === true,
    easyQuery: mainComp['@_easyQuery'] === 'true' || mainComp['@_easyQuery'] === true,
    odataSupport: mainComp['@_odataSupport'] === 'true' || mainComp['@_odataSupport'] === true,
    suppressRepeatedKeyValues: mainComp['@_suppressRepeatedKeyValues'] === 'true' || mainComp['@_suppressRepeatedKeyValues'] === true,
    showScalingFactor: mainComp['@_showScalingFactor'] === 'true' || mainComp['@_showScalingFactor'] === true,
    signPresentation: (mainComp['@_signPresentation'] as string) ?? '',
    zeroSuppression,
    planning: {
      inputMode: planningNode?.['@_inputMode'] === 'true' || planningNode?.['@_inputMode'] === true,
      symmetrical: planningNode?.['@_symmetrical'] === 'true' || planningNode?.['@_symmetrical'] === true,
    },
    resultPosition: {
      onTop: resultPosNode?.['@_onTop'] === 'true' || resultPosNode?.['@_onTop'] === true,
      onLeft: resultPosNode?.['@_onLeft'] === 'true' || resultPosNode?.['@_onLeft'] === true,
    },
  };

  const output: Record<string, unknown> = {
    name: (mainComp['@_technicalName'] as string) ?? queryName.toUpperCase(),
    description: ((mainComp['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
    infoProvider: (mainComp['@_providerName'] as string) ?? '',
    providerType,
    package: (packageRef?.['@_adtCore:name'] as string) ?? '',
    infoArea: stripInfoAreaSentinel((entityProps['infoArea'] as string) ?? ''),
    status: (entityProps['objectStatus'] as string) ?? '',
    responsible: (entityProps['@_adtCore:responsible'] as string) ?? '',
    changedAt: (entityProps['@_adtCore:changedAt'] as string) ?? '',
    createdAt: (entityProps['@_adtCore:createdAt'] as string) ?? '',
    timestamp: (mainComp['@_timestamp'] as string) ?? '',
    settings,
    variables,
    filter,
    columns,
    rows,
    freeCharacteristics,
    calculatedMeasures,
    restrictedMeasures,
    exceptions,
    hasCellDefinitions,
    gridCells,
    helpCells,
  };

  if (versionNote) output['versionNote'] = versionNote;

  if (format === 'raw') return JSON.stringify(output, null, 2);
  return renderQueryText(output);
}

/** Escape a string for use in an XML attribute value or text node. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface CreateQueryArgs {
  query_name: string;
  infoprovider?: string;
  description?: string;
  copy_from?: string;
}

/**
 * bw_create_query — create a new, consistent BW Query (TLOGO ELEM) on an
 * InfoProvider in package $TMP. With copy_from, the new query is created as a full
 * copy of an existing query (the server copies the entire source content).
 *
 * Wire protocol per payloads/query_create.md (and payloads/query_copy.md for the
 * copy variant):
 * 1. GET iprovexists           → validate the InfoProvider
 * 2. GET queryint compexist    → name check + server-generated ELEMUID
 * 3. POST comp/enq action=lock → lockHandle (activity_context CREA)
 * 4. POST query/{name}/a       → create (fresh client, session isolation);
 *                                copy adds copyFromObjectName={SOURCE_UPPER}
 * 5. GET query/{name}/a        → verify persistence
 * 6. POST comp/enq action=unlock
 *
 * Only package $TMP is supported; transportable packages are a documented open
 * point (see payloads/query_create.md) and are not implemented.
 */
export async function bwCreateQuery(
  client: BwClient,
  args: CreateQueryArgs
): Promise<string> {
  const nameUpper = args.query_name.toUpperCase();
  const nameLower = args.query_name.toLowerCase();
  const description = args.description ?? args.query_name;
  const copyFromUpper = args.copy_from?.toUpperCase();
  const copyFromLower = args.copy_from?.toLowerCase();

  // Resolve the InfoProvider. When copying, validate the source and — if no
  // infoprovider was given — derive it from the source query's providerName.
  let iprovUpper: string;
  if (copyFromLower) {
    const srcExist = await client.rawGet(
      `/sap/bw/modeling/queryint?action=compexist&compid=${copyFromLower}&type=ELEM`,
      { 'bwmt-level': '50' });
    if (srcExist.headers['compexist'] !== 'true') {
      throw new Error(`Source query '${copyFromUpper}' does not exist (compexist != true).`);
    }
    if (args.infoprovider) {
      iprovUpper = args.infoprovider.toUpperCase();
    } else {
      const srcGet = await client.get(`/sap/bw/modeling/query/${bwSeg(copyFromLower)}/a`, queryAccept());
      const mainOpen = srcGet.body.match(/<Qry:mainComponent\b[^>]*>/)?.[0] ?? '';
      const prov = mainOpen.match(/\bproviderName="([^"]+)"/)?.[1];
      if (!prov) {
        throw new Error(
          `Could not derive the InfoProvider from source query '${copyFromUpper}' ` +
          `(no providerName on its mainComponent).`
        );
      }
      iprovUpper = prov.toUpperCase();
    }
  } else {
    if (!args.infoprovider) {
      throw new Error('infoprovider is required when copy_from is not set.');
    }
    iprovUpper = args.infoprovider.toUpperCase();
  }

  // Step 1: Validate the InfoProvider.
  const iprovResult = await client.rawGet(
    `/sap/bw/modeling/comp/iprovexists?iprov=${encodeURIComponent(iprovUpper)}`,
    { 'bwmt-level': '50' });
  if (iprovResult.headers['exists'] !== 'true') {
    throw new Error(`InfoProvider '${iprovUpper}' does not exist.`);
  }
  const infoproviderTlogo = iprovResult.headers['tlogo'] ?? '';
  const infoarea = iprovResult.headers['infoarea'] ?? '';

  // Step 2: Name check + server-side UID generation.
  const existResult = await client.rawGet(
    `/sap/bw/modeling/queryint?action=compexist&compid=${nameLower}&type=ELEM`,
    { 'bwmt-level': '50' });
  if (existResult.headers['compexist'] === 'true') {
    throw new Error(`A component named '${nameUpper}' already exists.`);
  }
  const elemuid = existResult.headers['elemuid'];
  if (!elemuid) {
    throw new Error(`compexist did not return an ELEMUID header. Headers: ${JSON.stringify(existResult.headers)}`);
  }

  // Step 3: Lock (CREA) on the primary client — the enqueue endpoint differs
  // from the generic /{type}/{name} lock, so client.lock() cannot be reused.
  const csrfToken = await client.getCsrfToken();
  const lockResponse = await client.rawPost(
    `/sap/bw/modeling/comp/enq/${bwSeg(nameLower)}?action=lock&compuid=${elemuid}`,
    '',
    {
      'activity_context': 'CREA',
      'Accept': QUERY_ACCEPT_LIST,
      'bwmt-level': '50',
      'x-csrf-token': csrfToken,
      ...lockSessionHeader(),
    });
  const lockHandleMatch = lockResponse.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/);
  if (!lockHandleMatch) {
    throw new Error(`No <LOCK_HANDLE> in lock response:\n${lockResponse.body}`);
  }
  const lockHandle = lockHandleMatch[1];

  // Helper: unlock on the primary client's enqueue session, tolerating failures.
  const unlock = async () => {
    await client.rawPost(
      `/sap/bw/modeling/comp/enq/${bwSeg(nameLower)}?action=unlock&compuid=${elemuid}`,
      '',
      { 'bwmt-level': '50', 'x-csrf-token': await client.getCsrfToken() });
  };

  try {
    // Step 4: Build the create XML (see payloads/query_create.md).
    const language     = process.env.BW_LANGUAGE ?? 'DE';
    const masterSystem = await resolveMasterSystem(client);
    const responsible  = (process.env.BW_USER ?? '').toUpperCase();
    const timestamp    = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const descEsc      = escapeXml(description);

    const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<Qry:queryResource xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:Qry="http://www.sap.com/bw/Query.ecore" xmlns:adtcore="http://www.sap.com/adt/core">
  <Qry:schemaVersion>1.0</Qry:schemaVersion>
  <Qry:mainComponent xsi:type="Qry:Query" id="${elemuid}" componentVersion="110" providerName="${iprovUpper}" reusable="true" technicalName="${nameUpper}" sheetId="!VIRTUAL-003">
    <Qry:description default="false" value="${descEsc}"/>
    <Qry:entityProperties adtcore:changedAt="${timestamp}" adtcore:changedBy="${responsible}" adtcore:createdAt="${timestamp}" adtcore:createdBy="${responsible}" adtcore:description="${descEsc}" adtcore:language="${language}" adtcore:name="${nameUpper}" adtcore:type="ELEM" adtcore:masterLanguage="${language}" adtcore:masterSystem="${masterSystem}" adtcore:responsible="${responsible}">
      <adtcore:packageRef adtcore:packageName="$TMP" adtcore:type="ELEM"/>
    </Qry:entityProperties>
    <Qry:priorities>
      <Qry:scaling/>
      <Qry:decimals/>
      <Qry:convTarget/>
      <Qry:currencyType/>
      <Qry:signInversion/>
      <Qry:emphasize/>
      <Qry:formulaCollision/>
      <Qry:singleValuesAs/>
      <Qry:showCumulated/>
      <Qry:localAggregation/>
      <Qry:inputMode/>
      <Qry:unitType/>
      <Qry:disaggregation/>
    </Qry:priorities>
    <Qry:resultPosition/>
    <Qry:uniDispHierRows/>
    <Qry:uniDispHierCols/>
    <Qry:filter id="!VIRTUAL-001"/>
  </Qry:mainComponent>
</Qry:queryResource>`;

    // Step 5: Create POST on a fresh client (session isolation from the lock).
    const client2 = createClientFromEnv();
    const csrf2 = await client2.getCsrfToken();
    // Copy adds copyFromObjectName={SOURCE_UPPER} before compuid (payloads/query_copy.md).
    const copyParam = copyFromUpper ? `copyFromObjectName=${copyFromUpper}&` : '';
    const createResponse = await client2.rawPost(
      `/sap/bw/modeling/query/${bwSeg(nameLower)}/a?${copyParam}compuid=${elemuid}&lockHandle=${lockHandle}`,
      xmlBody,
      {
        'Development-Class': '$TMP',
        'ELEMUID': elemuid,
        'Content-Type': `application/xml, ${queryWriteMediaType()}`,
        'Accept': queryAccept(),
        'bwmt-level': '50',
        'x-csrf-token': csrf2,
      });

    // Step 6: Parse the atom feed check result. Only messageType "Error" is a
    // failure; "Information" and "Warning" mean success.
    const checkMessages: string[] = [];
    const errorTitles: string[] = [];
    const entryRegex = /<atom:entry>([\s\S]*?)<\/atom:entry>/g;
    let entryMatch: RegExpExecArray | null;
    while ((entryMatch = entryRegex.exec(createResponse.body)) !== null) {
      const entry = entryMatch[1];
      const messageType = entry.match(/messageType="([^"]*)"/)?.[1] ?? '';
      const title = entry.match(/<atom:title>([\s\S]*?)<\/atom:title>/)?.[1]?.trim() ?? '';
      if (title) checkMessages.push(title);
      if (messageType === 'Error') errorTitles.push(title || '(no title)');
    }
    if (errorTitles.length > 0) {
      throw new Error(`Query creation reported errors: ${errorTitles.join('; ')}`);
    }

    // Step 7: Verify persistence with a GET (same Accept header as bwGetQuery).
    try {
      await client.get(`/sap/bw/modeling/query/${bwSeg(nameLower)}/a`, queryAccept());
    } catch (verifyErr) {
      throw new Error(
        `Query '${nameUpper}' was not persisted after creation ` +
        `(GET /sap/bw/modeling/query/${nameLower}/a failed): ${verifyErr}`
      );
    }

    // Step 8: Unlock.
    try {
      await unlock();
    } catch (unlockErr) {
      process.stderr.write(`Warning: failed to unlock query/${nameLower} after creation: ${unlockErr}\n`);
    }

    return JSON.stringify({
      success: true,
      query_name: nameUpper,
      infoprovider: iprovUpper,
      infoprovider_tlogo: infoproviderTlogo,
      infoarea,
      elemuid,
      ...(copyFromUpper ? { copied_from: copyFromUpper } : {}),
      check_messages: checkMessages,
      message: copyFromUpper
        ? `Query '${nameUpper}' created as a copy of '${copyFromUpper}' on InfoProvider '${iprovUpper}' ` +
          `in package $TMP, including the full source content (layout, filter, variables, key figures).`
        : `Query '${nameUpper}' created empty and consistent on InfoProvider '${iprovUpper}' ` +
          `in package $TMP. It has no rows, columns, or key figures yet.`,
    });
  } catch (err) {
    // The lock was acquired; attempt to release it before rethrowing.
    try {
      await unlock();
    } catch (unlockErr) {
      process.stderr.write(`Warning: failed to unlock query/${nameLower} after error: ${unlockErr}\n`);
    }
    throw err;
  }
}
