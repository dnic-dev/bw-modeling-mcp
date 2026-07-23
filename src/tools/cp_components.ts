import { XMLParser } from 'fast-xml-parser';
import { BwClient } from '../bw-client.js';
import { ckfAccept, rkfAccept, structureAccept } from './query.js';
import { stripInfoAreaSentinel } from '../xml.js';

// ── XML Parser ───────────────────────────────────────────────────────────────

const ALWAYS_ARRAY = new Set([
  'Qry:subComponents',
  'Qry:groups',
  'Qry:tokens',
  'Qry:members',
  'Qry:childMembers',
  'Qry:childToken',
  'atom:link',
]);

function makeParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (tagName) => ALWAYS_ARRAY.has(tagName),
  });
}

// ── Utilities ────────────────────────────────────────────────────────────────

function ensureArray(val: unknown): unknown[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

function authoringLabel(code: string): string {
  if (code === 'T') return 'Eclipse';
  if (code === '3') return 'Query Designer';
  return code;
}

type ComponentEntry = { technicalName: string; description: string };

function buildSubComponentMaps(subComponents: Record<string, unknown>[]): {
  ckfMap: Map<string, ComponentEntry>;
  rkfMap: Map<string, ComponentEntry>;
} {
  const ckfMap = new Map<string, ComponentEntry>();
  const rkfMap = new Map<string, ComponentEntry>();
  for (const sc of subComponents) {
    const id = sc['@_id'] as string | undefined;
    if (!id) continue;
    const scType = sc['@_xsi:type'] as string;
    const technicalName = (sc['@_technicalName'] as string) ?? '';
    const description =
      ((sc['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '';
    if (scType === 'Qry:CalculatedMeasure') ckfMap.set(id, { technicalName, description });
    else if (scType === 'Qry:RestrictedMeasure') rkfMap.set(id, { technicalName, description });
  }
  return { ckfMap, rkfMap };
}

// ── Formula rendering (same approach as query.ts renderFormula) ──────────────
// No variableMap needed — CP components don't reference variables.

function renderFormula(
  token: Record<string, unknown>,
  ckfMap: Map<string, ComponentEntry>,
  rkfMap: Map<string, ComponentEntry>,
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
        const left = renderFormula(children[0], ckfMap, rkfMap, localMemberMap, depth + 1);
        const right = renderFormula(children[1], ckfMap, rkfMap, localMemberMap, depth + 1);
        return `(${left} ${token['@_code']} ${right})`;
      }
      return `(${token['@_code']})`;
    }
    case 'Qry:FormulaPrefixOperator': {
      const children = ensureArray(token['Qry:childToken']) as Record<string, unknown>[];
      const code = token['@_code'] as string;
      if (code === 'IF' && children.length === 3) {
        return (
          `IF(${renderFormula(children[0], ckfMap, rkfMap, localMemberMap, depth + 1)}, ` +
          `${renderFormula(children[1], ckfMap, rkfMap, localMemberMap, depth + 1)}, ` +
          `${renderFormula(children[2], ckfMap, rkfMap, localMemberMap, depth + 1)})`
        );
      }
      return `${code}(${children
        .map((c) => renderFormula(c, ckfMap, rkfMap, localMemberMap, depth + 1))
        .join(', ')})`;
    }
    case 'Qry:FormulaIObjectOperand':
      return (token['@_infoObject'] as string) ?? '?';
    case 'Qry:FormulaMemberOperand': {
      const memberId = token['@_member'] as string;
      const opType = token['@_operandType'] as string;
      if (opType === 'Member') {
        return (
          localMemberMap.get(memberId) ??
          ckfMap.get(memberId)?.technicalName ??
          rkfMap.get(memberId)?.technicalName ??
          memberId
        );
      }
      return ckfMap.get(memberId)?.technicalName ?? rkfMap.get(memberId)?.technicalName ?? memberId;
    }
    case 'Qry:FormulaConstant':
      return String(token['@_value'] ?? '');
    default:
      return '?';
  }
}

// ── Metadata extraction (common to CKF, RKF, Structure) ─────────────────────

function extractMetadata(
  mainComp: Record<string, unknown>
): {
  timestamp: string;
  authored_by: string;
  created_by: string;
  created_at: string;
  changed_by: string;
  changed_at: string;
  package: string;
  info_area: string;
} {
  const entityProps = (mainComp['Qry:entityProperties'] ?? {}) as Record<string, unknown>;
  const packageRef = entityProps['adtCore:packageRef'] as Record<string, unknown> | undefined;
  const rawInfoArea = entityProps['infoArea'];
  const infoArea = stripInfoAreaSentinel(typeof rawInfoArea === 'string' ? rawInfoArea : '');

  return {
    timestamp: (mainComp['@_timestamp'] as string) ?? '',
    authored_by: authoringLabel((mainComp['@_authoringTool'] as string) ?? ''),
    created_by: (entityProps['@_adtCore:createdBy'] as string) ?? '',
    created_at: (entityProps['@_adtCore:createdAt'] as string) ?? '',
    changed_by: (entityProps['@_adtCore:changedBy'] as string) ?? '',
    changed_at: (entityProps['@_adtCore:changedAt'] as string) ?? '',
    package: (packageRef?.['@_adtCore:name'] as string) ?? '',
    info_area: infoArea,
  };
}

function componentDescription(comp: Record<string, unknown>): string {
  const descNode = comp['Qry:description'] as Record<string, unknown> | undefined;
  if (descNode?.['@_value']) return descNode['@_value'] as string;
  const entityProps = comp['Qry:entityProperties'] as Record<string, unknown> | undefined;
  return (entityProps?.['@_adtCore:description'] as string) ?? '';
}

function buildDependencies(
  subComponents: Record<string, unknown>[]
): Array<{ technical_name: string; description: string; type: string }> {
  return subComponents.map((sc) => ({
    technical_name: (sc['@_technicalName'] as string) ?? '',
    description:
      ((sc['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
    type: (sc['@_xsi:type'] as string) === 'Qry:CalculatedMeasure' ? 'CKF' : 'RKF',
  }));
}

// ── bw_get_ckf ───────────────────────────────────────────────────────────────

export async function bwGetCkf(client: BwClient, componentName: string): Promise<string> {
  const path = `/sap/bw/modeling/ckf/${componentName.toLowerCase()}/a`;
  const { body } = await client.get(path, ckfAccept());

  const parser = makeParser();
  const parsed = parser.parse(body);
  const root = parsed['Qry:queryResource'] as Record<string, unknown>;

  const subComponents = ensureArray(root['Qry:subComponents']) as Record<string, unknown>[];
  const { ckfMap, rkfMap } = buildSubComponentMaps(subComponents);

  const mainComp = root['Qry:mainComponent'] as Record<string, unknown>;
  const technicalName = (mainComp['@_technicalName'] as string) ?? componentName.toUpperCase();
  const providerName = (mainComp['@_providerName'] as string) ?? '';
  const description = componentDescription(mainComp);

  // Formula: mainComponent → Qry:member → Qry:formulaDefinition → Qry:formulaToken
  const member = mainComp['Qry:member'] as Record<string, unknown> | undefined;
  const formulaDef = member?.['Qry:formulaDefinition'] as Record<string, unknown> | undefined;
  const formulaToken = formulaDef?.['Qry:formulaToken'] as Record<string, unknown> | undefined;
  const formula = formulaToken ? renderFormula(formulaToken, ckfMap, rkfMap, new Map()) : '';

  const dependencies = buildDependencies(subComponents);

  return JSON.stringify(
    {
      object_type: 'ckf',
      technical_name: technicalName,
      description,
      provider_name: providerName,
      component_type: 'CKF',
      ...extractMetadata(mainComp),
      formula,
      dependency_count: dependencies.length,
      dependencies,
    },
    null,
    2
  );
}

// ── bw_get_rkf ───────────────────────────────────────────────────────────────

export async function bwGetRkf(client: BwClient, componentName: string): Promise<string> {
  const path = `/sap/bw/modeling/rkf/${componentName.toLowerCase()}/a`;
  const { body } = await client.get(path, rkfAccept());

  const parser = makeParser();
  const parsed = parser.parse(body);
  const root = parsed['Qry:queryResource'] as Record<string, unknown>;

  const subComponents = ensureArray(root['Qry:subComponents']) as Record<string, unknown>[];
  const { ckfMap, rkfMap } = buildSubComponentMaps(subComponents);

  const mainComp = root['Qry:mainComponent'] as Record<string, unknown>;
  const technicalName = (mainComp['@_technicalName'] as string) ?? componentName.toUpperCase();
  const providerName = (mainComp['@_providerName'] as string) ?? '';
  const description = componentDescription(mainComp);

  const member = mainComp['Qry:member'] as Record<string, unknown> | undefined;
  const groups = ensureArray(member?.['Qry:groups']) as Record<string, unknown>[];

  let baseMeasure = '';
  const filters: Array<{
    infoObject: string;
    operator: string;
    exclude: boolean;
    values: string[];
  }> = [];

  for (const g of groups) {
    const infoObject = (g['@_infoObject'] as string) ?? '';
    const tokens = ensureArray(g['Qry:tokens']) as Record<string, unknown>[];

    if (infoObject === '1KYFNM') {
      const token = tokens[0];
      if (!token) continue;
      const tType = token['@_xsi:type'] as string;
      if (tType === 'Qry:SelectionTokenForComponent') {
        const compId = token['@_component'] as string;
        baseMeasure =
          ckfMap.get(compId)?.technicalName ??
          rkfMap.get(compId)?.technicalName ??
          compId;
      } else if (tType === 'Qry:SelectionRange') {
        // Direct base IOBJ key figure
        const fromValue = token['Qry:fromValue'] as Record<string, unknown> | undefined;
        baseMeasure = (fromValue?.['Qry:value'] as string) ?? '';
      }
    } else {
      // Characteristic filter — one entry per SelectionRange token
      for (const token of tokens) {
        const fromValue = token['Qry:fromValue'] as Record<string, unknown> | undefined;
        const internalValue =
          (fromValue?.['@_internalValue'] as string) ??
          (fromValue?.['Qry:value'] as string) ??
          '';
        filters.push({
          infoObject,
          operator: (token['@_operator'] as string) ?? '',
          exclude: token['@_exclude'] === 'true' || token['@_exclude'] === true,
          values: internalValue ? [internalValue] : [],
        });
      }
    }
  }

  const dependencies = buildDependencies(subComponents);

  return JSON.stringify(
    {
      object_type: 'rkf',
      technical_name: technicalName,
      description,
      provider_name: providerName,
      component_type: 'RKF',
      ...extractMetadata(mainComp),
      base_measure: baseMeasure,
      filters,
      dependency_count: dependencies.length,
      dependencies,
    },
    null,
    2
  );
}

// ── bw_get_structure ─────────────────────────────────────────────────────────

function buildLocalMemberMap(members: Record<string, unknown>[]): Map<string, string> {
  const map = new Map<string, string>();
  function collect(list: Record<string, unknown>[]) {
    for (const m of list) {
      const id = m['@_id'] as string | undefined;
      const desc =
        ((m['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ??
        id ??
        '';
      if (id) map.set(id, desc);
      const children = ensureArray(m['Qry:childMembers']) as Record<string, unknown>[];
      if (children.length > 0) collect(children);
    }
  }
  collect(members);
  return map;
}

function parseMember(
  member: Record<string, unknown>,
  position: number,
  ckfMap: Map<string, ComponentEntry>,
  rkfMap: Map<string, ComponentEntry>,
  localMemberMap: Map<string, string>
): Record<string, unknown> {
  const mType = member['@_xsi:type'] as string;
  const id = (member['@_id'] as string) ?? '';
  const descNode = member['Qry:description'] as Record<string, unknown> | undefined;
  const desc = (descNode?.['@_value'] as string) ?? '';
  const memberType = mType === 'Qry:MemberFormula' ? 'Formula' : 'Selection';

  const result: Record<string, unknown> = { id, description: desc, member_type: memberType, position };

  if (mType === 'Qry:MemberFormula') {
    const formulaDef = member['Qry:formulaDefinition'] as Record<string, unknown> | undefined;
    const formulaToken = formulaDef?.['Qry:formulaToken'] as Record<string, unknown> | undefined;
    result['formula'] = formulaToken
      ? renderFormula(formulaToken, ckfMap, rkfMap, localMemberMap)
      : '';
  } else {
    const groups = ensureArray(member['Qry:groups']) as Record<string, unknown>[];
    let referencedComponent: string | undefined;
    const characteristicFilters: Array<{ infoObject: string; values: string[] }> = [];

    for (const g of groups) {
      const infoObject = (g['@_infoObject'] as string) ?? '';
      const tokens = ensureArray(g['Qry:tokens']) as Record<string, unknown>[];

      if (infoObject === '1KYFNM') {
        const token = tokens[0];
        if (!token) continue;
        const tType = token['@_xsi:type'] as string;
        if (tType === 'Qry:SelectionTokenForComponent') {
          const compId = token['@_component'] as string;
          referencedComponent =
            ckfMap.get(compId)?.technicalName ??
            rkfMap.get(compId)?.technicalName ??
            compId;
        } else if (tType === 'Qry:SelectionRange') {
          const fromValue = token['Qry:fromValue'] as Record<string, unknown> | undefined;
          referencedComponent = (fromValue?.['Qry:value'] as string) ?? '';
        }
      } else {
        const values = tokens
          .map((t) => {
            const fv = t['Qry:fromValue'] as Record<string, unknown> | undefined;
            return (fv?.['@_internalValue'] as string) ?? (fv?.['Qry:value'] as string) ?? '';
          })
          .filter(Boolean);
        if (values.length > 0) characteristicFilters.push({ infoObject, values });
      }
    }

    if (referencedComponent !== undefined) result['referenced_component'] = referencedComponent;
    if (characteristicFilters.length > 0) result['characteristic_filters'] = characteristicFilters;
  }

  const childMembersRaw = ensureArray(member['Qry:childMembers']) as Record<string, unknown>[];
  if (childMembersRaw.length > 0) {
    result['child_members'] = childMembersRaw.map((cm, idx) =>
      parseMember(cm, idx + 1, ckfMap, rkfMap, localMemberMap)
    );
  }

  return result;
}

export async function bwGetStructure(client: BwClient, componentName: string): Promise<string> {
  const path = `/sap/bw/modeling/structure/${componentName.toLowerCase()}/a`;
  const { body } = await client.get(path, structureAccept());

  const parser = makeParser();
  const parsed = parser.parse(body);
  const root = parsed['Qry:queryResource'] as Record<string, unknown>;

  const subComponents = ensureArray(root['Qry:subComponents']) as Record<string, unknown>[];
  const { ckfMap, rkfMap } = buildSubComponentMaps(subComponents);

  const mainComp = root['Qry:mainComponent'] as Record<string, unknown>;
  const technicalName = (mainComp['@_technicalName'] as string) ?? componentName.toUpperCase();
  const providerName = (mainComp['@_providerName'] as string) ?? '';
  const description = componentDescription(mainComp);

  const membersRaw = ensureArray(mainComp['Qry:members']) as Record<string, unknown>[];
  const localMemberMap = buildLocalMemberMap(membersRaw);
  const members = membersRaw.map((m, idx) =>
    parseMember(m, idx + 1, ckfMap, rkfMap, localMemberMap)
  );

  const dependencies = buildDependencies(subComponents);

  return JSON.stringify(
    {
      object_type: 'structure',
      technical_name: technicalName,
      description,
      provider_name: providerName,
      ...extractMetadata(mainComp),
      members,
      dependency_count: dependencies.length,
      dependencies,
    },
    null,
    2
  );
}
