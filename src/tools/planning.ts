import { BwClient, MEDIA_TYPES, bwSeg } from '../bw-client.js';

function attr(tag: string, attrName: string): string {
  const m = tag.match(new RegExp(`\\b${attrName}="([^"]*)"`));
  return m ? m[1] : '';
}

interface AggLevelCharacteristic {
  name: string;
  infoObjectName: string;
  label: string;
  typeName: string;
  length?: string;
  precision?: string;
  scale?: string;
  conversionRoutine?: string;
  baseInfoObjectName?: string;
  compounding: string[];
  dimensionName: string;
  dimensionLabel: string;
  objectType: string;
}

interface AggLevelKeyfigure {
  name: string;
  infoObjectName: string;
  label: string;
  typeName: string;
  precision?: string;
  scale?: string;
  conversionRoutine?: string;
  baseInfoObjectName?: string;
  compounding: string[];
  dimensionName: string;
  dimensionLabel: string;
  aggregationBehavior: string;
  semantics: string;
  unitCurrencyElement?: string;
  fixedUnit?: string;
  fixedCurrency?: string;
}

interface AggLevelInfo {
  name: string;
  description: string;
  status: string;
  infoArea: string;
  package: string;
  infoProvider: string;
  characteristics: AggLevelCharacteristic[];
  keyfigures: AggLevelKeyfigure[];
}

function parseAggLevelXml(xml: string, status: string): AggLevelInfo {
  const rootMatch = xml.match(/<Alvl:aggregationLevel([^>]*)>/);
  if (!rootMatch) {
    throw new Error('Unexpected XML: <Alvl:aggregationLevel> root element not found.');
  }
  const name = attr(rootMatch[1], 'name');

  const descMatch = xml.match(/<endUserTexts\b[^>]*\blabel="([^"]*)"/);
  const description = descMatch ? descMatch[1] : '';

  const viewNodeCount = (xml.match(/<viewNode\b/g) ?? []).length;
  if (viewNodeCount === 0) {
    throw new Error('No <viewNode> element found. Cannot parse this ALVL structure.');
  }
  if (viewNodeCount > 1) {
    throw new Error(
      `Multiple viewNode elements found (${viewNodeCount}). Expected exactly one. ` +
      'Cannot parse this ALVL structure — revisit the parser.'
    );
  }

  const viewNodeBodyMatch = xml.match(/<viewNode\b[^>]*>([\s\S]*?)<\/viewNode>/);
  if (!viewNodeBodyMatch) {
    throw new Error('Could not extract <viewNode> body.');
  }
  const viewNodeBody = viewNodeBodyMatch[1];

  const compositeInputMatch = viewNodeBody.match(/<input\b[^>]*xsi:type="Composite:CompositeInput"[^>]*>/);
  if (!compositeInputMatch) {
    throw new Error(
      'No <input xsi:type="Composite:CompositeInput"> found in viewNode. ' +
      'Cannot determine underlying InfoProvider.'
    );
  }
  const infoProvider = attr(compositeInputMatch[0], 'name');

  const tlogoPkg = xml.match(/<adtcore:packageRef\b[^>]*\bname="([^"]*)"/)?.[1] ?? '';
  const infoArea = xml.match(/<infoArea[^>]*>([^<]+)<\/infoArea>/)?.[1]?.trim() ?? '';

  // Build dimension name → label map
  const dimensionMap = new Map<string, string>();
  const dimRegex = /<dimension\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/dimension>/g;
  let dm: RegExpExecArray | null;
  while ((dm = dimRegex.exec(xml)) !== null) {
    const dimName = dm[1];
    const dimLabel = dm[2].match(/<descriptions\b[^>]*\blabel="([^"]*)"/)?.[1] ?? dimName;
    dimensionMap.set(dimName, dimLabel);
  }

  const characteristics: AggLevelCharacteristic[] = [];
  const keyfigures: AggLevelKeyfigure[] = [];

  const elementRegex = /<element\b([^>]*)>([\s\S]*?)<\/element>/g;
  let em: RegExpExecArray | null;
  while ((em = elementRegex.exec(viewNodeBody)) !== null) {
    const elAttrs = em[1];
    const elBody = em[2];

    const elName = attr(elAttrs, 'name');
    const infoObjectName = attr(elAttrs, 'infoObjectName');
    const aggregationBehavior = attr(elAttrs, 'aggregationBehavior');
    const baseInfoObjectName = attr(elAttrs, 'baseInfoObjectName') || undefined;
    const conversionRoutine = attr(elAttrs, 'conversionRoutine') || undefined;

    // dimension="#///<DIM>§" → extract DIM
    const dimensionRaw = attr(elAttrs, 'dimension');
    const dimMatch = dimensionRaw.match(/#\/\/\/([^§]+)§/);
    const dimensionName = dimMatch ? dimMatch[1] : '';
    const dimensionLabel = dimensionMap.get(dimensionName) ?? dimensionName;

    const labelMatch = elBody.match(/<endUserTexts\b[^>]*\blabel="([^"]*)"/);
    const label = labelMatch ? labelMatch[1] : '';

    const inlineMatch = elBody.match(/<inlineType\b([^>]*)\/?>/);
    const inlineAttrs = inlineMatch?.[1] ?? '';
    const typeName = attr(inlineAttrs, 'name');
    const length = attr(inlineAttrs, 'length') || undefined;
    const precision = attr(inlineAttrs, 'precision') || undefined;
    const scale = attr(inlineAttrs, 'scale') || undefined;

    // Compounding: strip everything up to and including the last /
    const compounding: string[] = [];
    const compRegex = /<compoundInfoObject>([^<]+)<\/compoundInfoObject>/g;
    let cm: RegExpExecArray | null;
    while ((cm = compRegex.exec(elBody)) !== null) {
      const raw = cm[1].trim();
      const lastSlash = raw.lastIndexOf('/');
      compounding.push(lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw);
    }

    // Decision signal: localProperties xsi:type
    const localPropMatch = elBody.match(/<localProperties\b[^>]*xsi:type="([^"]*)"/);
    const isKeyFigure = localPropMatch
      ? localPropMatch[1].includes('LocalKeyfigureProperties')
      : aggregationBehavior !== '';

    if (isKeyFigure) {
      const semantics = elBody.match(/<semantics>([^<]+)<\/semantics>/)?.[1] ?? '';

      const unitCurrencyRaw = elBody.match(/<unitCurrencyElement>([^<]+)<\/unitCurrencyElement>/)?.[1] ?? '';
      let unitCurrencyElement: string | undefined;
      if (unitCurrencyRaw) {
        const lastSlash = unitCurrencyRaw.lastIndexOf('/');
        unitCurrencyElement = lastSlash >= 0 ? unitCurrencyRaw.slice(lastSlash + 1) : unitCurrencyRaw;
      }
      const fixedUnit = elBody.match(/<fixedUnit\b[^>]*\bintValue="([^"]*)"/)?.[1] ?? undefined;
      const fixedCurrency = elBody.match(/<fixedCurrency>([^<]+)<\/fixedCurrency>/)?.[1] ?? undefined;

      keyfigures.push({
        name: elName,
        infoObjectName,
        label,
        typeName,
        precision,
        scale,
        conversionRoutine,
        baseInfoObjectName,
        compounding,
        dimensionName,
        dimensionLabel,
        aggregationBehavior,
        semantics,
        unitCurrencyElement: unitCurrencyElement || undefined,
        fixedUnit,
        fixedCurrency,
      });
    } else {
      const cvpMatch = elBody.match(/<consumptionViewProperties\b([^>]*)/);
      const objectType = cvpMatch ? (attr(cvpMatch[1], 'objectType') || 'CHA') : 'CHA';

      characteristics.push({
        name: elName,
        infoObjectName,
        label,
        typeName,
        length,
        precision,
        scale,
        conversionRoutine,
        baseInfoObjectName,
        compounding,
        dimensionName,
        dimensionLabel,
        objectType,
      });
    }
  }

  return { name, description, status, infoArea, package: tlogoPkg, infoProvider, characteristics, keyfigures };
}

export async function bwGetAggregationLevel(client: BwClient, alvlName: string): Promise<string> {
  const path = `/sap/bw/modeling/alvl/${bwSeg(alvlName)}/m`;
  const result = await client.get(path, MEDIA_TYPES['alvl']);
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';

  const info = parseAggLevelXml(result.body, status);

  const lines: string[] = [
    `Aggregation Level: ${info.name}`,
    `Status:            ${info.status}`,
    `Description:       ${info.description}`,
    `InfoArea:          ${info.infoArea}`,
    `Package:           ${info.package}`,
    `InfoProvider:      ${info.infoProvider}`,
    '',
    `── Characteristics (${info.characteristics.length}) ──`,
  ];

  if (info.characteristics.length === 0) {
    lines.push('  (none)');
  } else {
    for (const c of info.characteristics) {
      let typeInfo = c.typeName;
      if (c.precision !== undefined && c.scale !== undefined) {
        typeInfo += `(${c.precision},${c.scale})`;
      } else if (c.length !== undefined) {
        typeInfo += `(${c.length})`;
      }
      let line = `  ${c.name}  ${typeInfo}`;
      if (c.label) line += `  "${c.label}"`;
      if (c.infoObjectName && c.infoObjectName !== c.name) line += `  [IOBJ: ${c.infoObjectName}]`;
      if (c.objectType && c.objectType !== 'CHA') line += `  [${c.objectType}]`;
      if (c.conversionRoutine) line += `  [conv: ${c.conversionRoutine}]`;
      if (c.baseInfoObjectName) line += `  [base: ${c.baseInfoObjectName}]`;
      if (c.dimensionLabel) line += `  [dim: ${c.dimensionLabel}]`;
      lines.push(line);
      if (c.compounding.length > 0) {
        lines.push(`    Compounding: ${c.compounding.join(', ')}`);
      }
    }
  }

  lines.push('', `── Key Figures (${info.keyfigures.length}) ──`);

  if (info.keyfigures.length === 0) {
    lines.push('  (none)');
  } else {
    for (const k of info.keyfigures) {
      let typeInfo = k.typeName;
      if (k.precision !== undefined && k.scale !== undefined) {
        typeInfo += `(${k.precision},${k.scale})`;
      } else if (k.precision !== undefined) {
        typeInfo += `(${k.precision})`;
      }
      let line = `  ${k.name}  ${typeInfo}`;
      if (k.label) line += `  "${k.label}"`;
      if (k.infoObjectName && k.infoObjectName !== k.name) line += `  [IOBJ: ${k.infoObjectName}]`;
      if (k.aggregationBehavior) line += `  [agg: ${k.aggregationBehavior}]`;
      if (k.semantics) line += `  [sem: ${k.semantics}]`;
      if (k.conversionRoutine) line += `  [conv: ${k.conversionRoutine}]`;
      if (k.baseInfoObjectName) line += `  [base: ${k.baseInfoObjectName}]`;
      if (k.dimensionLabel) line += `  [dim: ${k.dimensionLabel}]`;
      if (k.unitCurrencyElement) line += `  [unit/curr: ${k.unitCurrencyElement}]`;
      else if (k.fixedUnit) line += `  [unit: ${k.fixedUnit}]`;
      else if (k.fixedCurrency) line += `  [currency: ${k.fixedCurrency}]`;
      lines.push(line);
      if (k.compounding.length > 0) {
        lines.push(`    Compounding: ${k.compounding.join(', ')}`);
      }
    }
  }

  lines.push('', `── Raw XML ──`, result.body);

  return lines.join('\n');
}

// ── bwGetPlanningProperties ───────────────────────────────────────────────────

interface PlanningPropertiesInfo {
  name: string;
  status: string;
  infoArea: string;
  package: string;
  providerName: string;
  providerHref: string;
  providerMediaType: string;
  keyDateType: string;
  maxCombinations: string;
  saveStrategySequence?: string;
  saveStrategyDeltaRead?: string;
}

function parsePlcrXml(xml: string, status: string): PlanningPropertiesInfo {
  const rootMatch = xml.match(/<plIprov:planningProperties([^>]*)>/);
  if (!rootMatch) {
    throw new Error('Unexpected XML: <plIprov:planningProperties> root element not found.');
  }

  // infoProvider="NAME.composite#//" → strip from the first dot onward
  const infoProviderRaw = attr(rootMatch[1], 'infoProvider');
  const dotIdx = infoProviderRaw.indexOf('.');
  const providerName = dotIdx >= 0 ? infoProviderRaw.slice(0, dotIdx) : infoProviderRaw;

  // tlogoProperties: adtcore:name, package, infoArea
  const tlMatch = xml.match(/<tlogoProperties([^>]*)>/);
  const name = tlMatch ? (attr(tlMatch[1], 'adtcore:name') || providerName) : providerName;
  const tlogoPkg = xml.match(/<adtcore:packageRef\b[^>]*\bname="([^"]*)"/)?.[1] ?? '';
  const infoArea = xml.match(/<infoArea[^>]*>([^<]+)<\/infoArea>/)?.[1]?.trim() ?? '';

  // atom:link rel="up" — underlying provider's resource URL and media type
  const upLinkMatch = xml.match(/<atom:link\b[^>]*\brel="up"[^>]*>/);
  const providerHref = upLinkMatch ? attr(upLinkMatch[0], 'href') : '';
  const providerMediaType = upLinkMatch ? attr(upLinkMatch[0], 'type') : '';

  // generalSettings — tolerate absence gracefully
  const gsBody = xml.match(/<generalSettings>([\s\S]*?)<\/generalSettings>/)?.[1] ?? '';

  const keyDateMatch = gsBody.match(/<keyDate\b([^>]*)\/?>/);
  const keyDateType = keyDateMatch ? attr(keyDateMatch[1], 'type') : '';

  const maxCombinations =
    gsBody.match(/<maxNumberOfCombinations>([^<]+)<\/maxNumberOfCombinations>/)?.[1]?.trim() ?? '';

  const ssMatch = gsBody.match(/<saveStrategy\b([^>]*)\/?>/);
  const saveStrategySequence = ssMatch ? (attr(ssMatch[1], 'planningSequence') || undefined) : undefined;
  const saveStrategyDeltaRead = ssMatch ? (attr(ssMatch[1], 'deltaRead') || undefined) : undefined;

  return {
    name,
    status,
    infoArea,
    package: tlogoPkg,
    providerName,
    providerHref,
    providerMediaType,
    keyDateType,
    maxCombinations,
    saveStrategySequence,
    saveStrategyDeltaRead,
  };
}

export async function bwGetPlanningProperties(client: BwClient, providerName: string): Promise<string> {
  const path = `/sap/bw/modeling/plcr/${bwSeg(providerName)}/a`;
  const result = await client.get(path, MEDIA_TYPES['plcr']);
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';

  const info = parsePlcrXml(result.body, status);

  const lines: string[] = [
    `Planning Properties: ${info.name}`,
    `Status:              ${info.status}`,
    `InfoArea:            ${info.infoArea}`,
    `Package:             ${info.package}`,
    '',
    `── Provider ──`,
    `  Name:     ${info.providerName}`,
    `  Resource: ${info.providerHref}`,
    `  Type:     ${info.providerMediaType}`,
    '',
    `── General Settings ──`,
    `  Key-date type:    ${info.keyDateType || '(not set)'}`,
    `  Max combinations: ${info.maxCombinations || '(not set)'}`,
  ];

  if (info.saveStrategySequence !== undefined || info.saveStrategyDeltaRead !== undefined) {
    lines.push(
      `  Save strategy:`,
      `    Planning sequence: ${info.saveStrategySequence ?? '(none)'}`,
      `    Delta read:        ${info.saveStrategyDeltaRead ?? '(not set)'}`,
    );
  } else {
    lines.push(`  Save strategy:    (not configured)`);
  }

  lines.push('', `── Raw XML ──`, result.body);

  return lines.join('\n');
}

// ── bwGetPlanningSequence ─────────────────────────────────────────────────────

interface PlsqStep {
  type: string;
  alvl: string;
  planningService: string;
  filterName: string;
}

interface PlsqInfo {
  name: string;
  description: string;
  status: string;
  infoArea: string;
  package: string;
  steps: PlsqStep[];
}

function parsePlsqXml(xml: string, status: string): PlsqInfo {
  const rootMatch = xml.match(/<PlanningSequence:planningSequence([^>]*)>/);
  if (!rootMatch) {
    throw new Error('Unexpected XML: <PlanningSequence:planningSequence> root element not found.');
  }
  const name = attr(rootMatch[1], 'name');

  const description = xml.match(/<description\b[^>]*\blabel="([^"]*)"/)?.[1] ?? '';
  const tlogoPkg = xml.match(/<adtcore:packageRef\b[^>]*\bname="([^"]*)"/)?.[1] ?? '';
  const infoArea = xml.match(/<infoArea[^>]*>([^<]+)<\/infoArea>/)?.[1]?.trim() ?? '';

  // Steps are self-closing <step .../> elements; preserve document order
  const steps: PlsqStep[] = [];
  const stepRegex = /<step\b([^>]*)(?:\/>|>[\s\S]*?<\/step>)/g;
  let sm: RegExpExecArray | null;
  while ((sm = stepRegex.exec(xml)) !== null) {
    const sa = sm[1];
    const alvlRaw = attr(sa, 'alvl');
    const plseRaw = attr(sa, 'planningService');
    // Strip "NAME.alvl#//" → "NAME", "NAME.plse#//" → "NAME"
    const dotAlvl = alvlRaw.indexOf('.');
    const dotPlse = plseRaw.indexOf('.');
    steps.push({
      type: attr(sa, 'type'),
      alvl: dotAlvl >= 0 ? alvlRaw.slice(0, dotAlvl) : alvlRaw,
      planningService: dotPlse >= 0 ? plseRaw.slice(0, dotPlse) : plseRaw,
      filterName: attr(sa, 'filterName'),
    });
  }

  return { name, description, status, infoArea, package: tlogoPkg, steps };
}

export async function bwGetPlanningSequence(client: BwClient, seqName: string): Promise<string> {
  const path = `/sap/bw/modeling/plsq/${bwSeg(seqName)}/a`;
  const result = await client.get(path, MEDIA_TYPES['plsq']);
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';

  const info = parsePlsqXml(result.body, status);

  const lines: string[] = [
    `Planning Sequence: ${info.name}`,
    `Status:            ${info.status}`,
    `Description:       ${info.description}`,
    `InfoArea:          ${info.infoArea}`,
    `Package:           ${info.package}`,
    '',
    `── Steps (${info.steps.length}) ──`,
  ];

  if (info.steps.length === 0) {
    lines.push('  (no steps)');
  } else {
    for (let i = 0; i < info.steps.length; i++) {
      const s = info.steps[i];
      lines.push(`  ${i + 1}. [type ${s.type}]`);
      if (s.alvl) lines.push(`       Aggregation Level: ${s.alvl}`);
      if (s.planningService) lines.push(`       Planning Function: ${s.planningService}`);
      if (s.filterName) lines.push(`       Filter:            ${s.filterName}`);
    }
  }

  lines.push('', `── Raw XML ──`, result.body);

  return lines.join('\n');
}

// ── bwGetPlanningFunction ─────────────────────────────────────────────────────

interface PlseSelectionRange {
  selectionType: string;
  operator: string;
  fromType: string;
  fromValue: string;
  toType?: string;
  toValue?: string;
}

interface PlseParameter {
  name: string;
  parameterType: string;
  multiselection: string;
  children: PlseParameter[];
  selections: PlseSelectionRange[];
}

interface PlseCharUsage {
  infoObject: string;
  fieldUsage: string;
  isChangeable: string;
}

interface PlseQryValue {
  type: string;
  value: string;
  variable?: string;
}

interface PlseConditionConstraint {
  selectionType: string;
  operator: string;
  from: PlseQryValue;
  to?: PlseQryValue;
}

interface PlseCondition {
  characteristic: string;
  constraints: PlseConditionConstraint[];
}

interface PlseInfo {
  name: string;
  description: string;
  planningServiceType: string;
  alvl: string;
  documentation: string;
  status: string;
  infoArea: string;
  package: string;
  charUsages: PlseCharUsage[];
  conditions: PlseCondition[];
  parameters: PlseParameter[];
}

function parseQryValue(block: string): PlseQryValue {
  return {
    type: block.match(/<qry:type>([^<]*)<\/qry:type>/)?.[1] ?? '',
    value: block.match(/<qry:value>([\s\S]*?)<\/qry:value>/)?.[1] ?? '',
    variable: block.match(/<qry:variable>([^<]*)<\/qry:variable>/)?.[1] || undefined,
  };
}

// Find the index of the matching </tagName> for an open tag whose body starts at bodyStart.
// Tracks nesting depth so nested same-name elements are handled correctly.
function findMatchingClose(xml: string, tagName: string, bodyStart: number): number {
  const closeStr = `</${tagName}>`;
  const openRe = new RegExp(`<${tagName}\\b`, 'g');
  let depth = 1;
  let pos = bodyStart;

  while (pos < xml.length && depth > 0) {
    openRe.lastIndex = pos;
    const openMatch = openRe.exec(xml);
    const closeIdx = xml.indexOf(closeStr, pos);

    if (closeIdx === -1) return -1;

    if (openMatch && openMatch.index < closeIdx) {
      // Only count non-self-closing open tags
      const tagEnd = xml.indexOf('>', openMatch.index);
      const isSelfClosing = tagEnd > 0 && xml.slice(openMatch.index, tagEnd + 1).endsWith('/>');
      if (!isSelfClosing) depth++;
      pos = (tagEnd >= 0 ? tagEnd : openMatch.index) + 1;
    } else {
      depth--;
      if (depth === 0) return closeIdx;
      pos = closeIdx + closeStr.length;
    }
  }

  return -1;
}

// Parse <parameter> elements from xml, returning only top-level ones (nested handled by recursion).
function parsePlseParameters(xml: string): PlseParameter[] {
  const params: PlseParameter[] = [];
  const openRe = /<parameter\b([^>]*)>/g;
  let match: RegExpExecArray | null;

  while ((match = openRe.exec(xml)) !== null) {
    const attrs = match[1];
    const bodyStart = match.index + match[0].length;
    const closeIdx = findMatchingClose(xml, 'parameter', bodyStart);
    if (closeIdx === -1) break;

    const body = xml.slice(bodyStart, closeIdx);
    const children = parsePlseParameters(body);

    const selections: PlseSelectionRange[] = [];
    if (children.length === 0) {
      const selRe = /<selectionRange\b([^>]*)>([\s\S]*?)<\/selectionRange>/g;
      let sm: RegExpExecArray | null;
      while ((sm = selRe.exec(body)) !== null) {
        const fromBlock = sm[2].match(/<qry:fromValue>([\s\S]*?)<\/qry:fromValue>/)?.[1] ?? '';
        const toBlock = sm[2].match(/<qry:toValue>([\s\S]*?)<\/qry:toValue>/)?.[1];
        const fromQry = parseQryValue(fromBlock);
        const toQry = toBlock ? parseQryValue(toBlock) : undefined;
        selections.push({
          selectionType: attr(sm[1], 'selectionType'),
          operator: attr(sm[1], 'operator'),
          fromType: fromQry.type,
          fromValue: fromQry.value,
          toType: toQry?.type,
          toValue: toQry?.value,
        });
      }
    }

    params.push({
      name: attr(attrs, 'name'),
      parameterType: attr(attrs, 'parameterType'),
      multiselection: attr(attrs, 'multiselection'),
      children,
      selections,
    });

    // Advance past the closing tag so the outer loop skips nested parameters
    openRe.lastIndex = closeIdx + '</parameter>'.length;
  }

  return params;
}

function formatPlseParameters(params: PlseParameter[], indent: number): string[] {
  const lines: string[] = [];
  const pad = '  '.repeat(indent);

  for (const p of params) {
    let header = `${pad}${p.name}  [type ${p.parameterType}]`;
    if (p.multiselection === 'true') header += '  [multi]';
    lines.push(header);

    if (p.children.length > 0) {
      lines.push(...formatPlseParameters(p.children, indent + 1));
    }

    for (const s of p.selections) {
      if (s.fromValue.includes('\n')) {
        lines.push(`${pad}  = [${s.operator}] ${s.fromType}:`);
        for (const codeLine of s.fromValue.split('\n')) {
          lines.push(`${pad}    | ${codeLine}`);
        }
      } else {
        lines.push(`${pad}  = [${s.operator}] ${s.fromType}: "${s.fromValue}"`);
      }
      if (s.toValue !== undefined) {
        lines.push(`${pad}    to ${s.toType}: "${s.toValue}"`);
      }
    }
  }

  return lines;
}

function parsePlseXml(xml: string, status: string): PlseInfo {
  const rootMatch = xml.match(/<bwPlanningService:planningService([^>]*)>/);
  if (!rootMatch) {
    throw new Error('Unexpected XML: <bwPlanningService:planningService> root element not found.');
  }
  const rootAttrs = rootMatch[1];
  const name = attr(rootAttrs, 'name');

  const pstRaw = attr(rootAttrs, 'planningServiceType');
  const dotPst = pstRaw.indexOf('.');
  const planningServiceType = dotPst >= 0 ? pstRaw.slice(0, dotPst) : pstRaw;

  const alvlRaw = attr(rootAttrs, 'alvl');
  const dotAlvl = alvlRaw.indexOf('.');
  const alvl = dotAlvl >= 0 ? alvlRaw.slice(0, dotAlvl) : alvlRaw;

  const documentation = attr(rootAttrs, 'documentation');

  const description = xml.match(/<description\b[^>]*\blabel="([^"]*)"/)?.[1] ?? '';
  const tlogoPkg = xml.match(/<adtcore:packageRef\b[^>]*\bname="([^"]*)"/)?.[1] ?? '';
  const infoArea = xml.match(/<infoArea[^>]*>([^<]+)<\/infoArea>/)?.[1]?.trim() ?? '';

  const charUsages: PlseCharUsage[] = [];
  const cuRe = /<charUsage\b([^>]*)(?:\/>|>[\s\S]*?<\/charUsage>)/g;
  let cum: RegExpExecArray | null;
  while ((cum = cuRe.exec(xml)) !== null) {
    const ioRaw = attr(cum[1], 'infoObject');
    const lastSlash = ioRaw.lastIndexOf('/');
    charUsages.push({
      infoObject: lastSlash >= 0 ? ioRaw.slice(lastSlash + 1) : ioRaw,
      fieldUsage: attr(cum[1], 'fieldUsage'),
      isChangeable: attr(cum[1], 'isChangeable'),
    });
  }

  // PLSE has no OBJECT_STATUS header; derive from body when the caller found nothing
  let resolvedStatus = status;
  if (!resolvedStatus || resolvedStatus === 'unknown') {
    const contentState = xml.match(/<contentState>([^<]+)<\/contentState>/)?.[1]?.trim();
    resolvedStatus = contentState === 'ACT' ? 'active'
      : contentState ? contentState.toLowerCase()
      : (xml.match(/adtcore:version="([^"]*)"/)?.[1] ?? 'unknown');
  }

  const conditionBody = xml.match(/<condition>([\s\S]*?)<\/condition>/)?.[1] ?? '';

  // Parse <fieldSelection> siblings inside <condition> (function conditions)
  const conditions: PlseCondition[] = [];
  const fsRe = /<fieldSelection\b([^>]*)>([\s\S]*?)<\/fieldSelection>/g;
  let fsm: RegExpExecArray | null;
  while ((fsm = fsRe.exec(conditionBody)) !== null) {
    const charRaw = attr(fsm[1], 'characteristic');
    const lastSlash = charRaw.lastIndexOf('/');
    const characteristic = lastSlash >= 0 ? charRaw.slice(lastSlash + 1) : charRaw;

    const constraints: PlseConditionConstraint[] = [];
    const constrRe = /<constraint\b([^>]*)>([\s\S]*?)<\/constraint>/g;
    let cm: RegExpExecArray | null;
    while ((cm = constrRe.exec(fsm[2])) !== null) {
      const fromBlock = cm[2].match(/<qry:fromValue>([\s\S]*?)<\/qry:fromValue>/)?.[1] ?? '';
      const toBlock = cm[2].match(/<qry:toValue>([\s\S]*?)<\/qry:toValue>/)?.[1];
      constraints.push({
        selectionType: attr(cm[1], 'selectionType'),
        operator: attr(cm[1], 'operator'),
        from: parseQryValue(fromBlock),
        to: toBlock ? parseQryValue(toBlock) : undefined,
      });
    }

    conditions.push({ characteristic, constraints });
  }

  const parameters = parsePlseParameters(conditionBody);

  return { name, description, planningServiceType, alvl, documentation, status: resolvedStatus, infoArea, package: tlogoPkg, charUsages, conditions, parameters };
}

export async function bwGetPlanningFunction(client: BwClient, funcName: string): Promise<string> {
  const path = `/sap/bw/modeling/plse/${funcName.toLowerCase()}/a`;
  const result = await client.get(path, MEDIA_TYPES['plse']);
  const headerStatus = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? '';

  const info = parsePlseXml(result.body, headerStatus);

  const lines: string[] = [
    `Planning Function: ${info.name}`,
    `Status:            ${info.status}`,
    `Description:       ${info.description}`,
    `Function Type:     ${info.planningServiceType}`,
    `Aggregation Level: ${info.alvl}`,
    `InfoArea:          ${info.infoArea}`,
    `Package:           ${info.package}`,
  ];

  if (info.documentation) {
    lines.push('', `── Documentation ──`, info.documentation);
  }

  lines.push('', `── Characteristic Usage (${info.charUsages.length}) ──`);
  if (info.charUsages.length === 0) {
    lines.push('  (none)');
  } else {
    for (const c of info.charUsages) {
      let line = `  ${c.infoObject}  [${c.fieldUsage}]`;
      if (c.isChangeable === 'true') line += '  changeable';
      lines.push(line);
    }
  }

  if (info.conditions.length > 0) {
    lines.push('', `── Conditions (${info.conditions.length}) ──`);
    for (const cond of info.conditions) {
      lines.push(`  ${cond.characteristic}`);
      for (const c of cond.constraints) {
        const fromDesc = c.from.type === 'VariableCIN'
          ? `variable: ${c.from.value}`
          : `${c.from.type}: "${c.from.value}"`;
        let constrLine = `    [${c.operator} | ${c.selectionType}]  ${fromDesc}`;
        if (c.to) {
          const toDesc = c.to.type === 'VariableCIN'
            ? `variable: ${c.to.value}`
            : `${c.to.type}: "${c.to.value}"`;
          constrLine += `  to  ${toDesc}`;
        }
        lines.push(constrLine);
      }
    }
  }

  lines.push('', `── Parameter Tree ──`);
  if (info.parameters.length === 0) {
    lines.push('  (no parameters)');
  } else {
    lines.push(...formatPlseParameters(info.parameters, 1));
  }

  lines.push('', `── Raw XML ──`, result.body);

  return lines.join('\n');
}
