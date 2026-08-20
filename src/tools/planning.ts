import {
  BwClient,
  MEDIA_TYPES,
  freshRead,
  decodeXmlEntities,
  bwSeg,
  bwSegUpper,
  stripInfoAreaSentinel,
} from '../bw-client.js';

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
  const description = decodeXmlEntities(descMatch ? descMatch[1] : '');

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
  const infoArea = stripInfoAreaSentinel(xml.match(/<infoArea[^>]*>([^<]+)<\/infoArea>/)?.[1]?.trim() ?? '');

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
    const label = decodeXmlEntities(labelMatch ? labelMatch[1] : '');

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
    `InfoArea:          ${info.infoArea || '(none)'}`,
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

// ── bwCreateAggregationLevel ──────────────────────────────────────────────────

const ALVL_XMLNS =
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
  'xmlns:Alvl="http://www.sap.com/bw/modeling/AlvlModel.ecore" ' +
  'xmlns:Composite="http://www.sap.com/bw/modeling/CompositeModel.ecore" ' +
  'xmlns:View="http://www.sap.com/ndb/ViewModelView.ecore" ' +
  'xmlns:adtcore="http://www.sap.com/adt/core"';

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

/**
 * Administrative fields an aggregation level cannot expose: the record count is maintained
 * by BW itself as an internal attribute of the generated column view, and the request TSN
 * belongs to the provider's administration. The modelling UI leaves both out, and the server
 * drops them from a submitted field list without saying so — which would make the reported
 * field list of this tool a lie.
 */
const ALVL_EXCLUDED_FIELDS = new Set(['1ROWCOUNT', '0REQTSN']);

interface ProviderElement {
  name: string;
  /**
   * `name` without the provider's generated field prefix. On an aDSO both are the same; a
   * CompositeProvider names its fields "<prefix>-<FIELD>" while every other tool and the
   * modelling UI show the bare name, so a caller has to be able to use either.
   */
  bareName: string;
  infoObjectName: string;
  aggregationBehavior?: string;
  isKeyFigure: boolean;
}

/**
 * Read the fields an aggregation level can expose from its underlying InfoProvider.
 *
 * Same source the modelling UI uses before it writes the element list. Only the field's
 * identity and its characteristic/key-figure role are needed — every other property (data
 * type, label, conversion routine, semantics, dimension group) is derived by the server from
 * the InfoObject when the aggregation level is activated.
 */
async function fetchAlvlProviderElements(infoProvider: string): Promise<ProviderElement[]> {
  const xml = (await freshRead(`/sap/bw/modeling/infoprov/${bwSegUpper(infoProvider)}/A`, IPROV_ACCEPT)).body;
  const fieldNamePrefix = xml.match(/\bfieldNamePrefix="([^"]*)"/)?.[1] ?? '';
  const elements: ProviderElement[] = [];
  const elemRegex = /<element\b([\s\S]*?)(?:\/>|>([\s\S]*?)<\/element>)/g;
  let em: RegExpExecArray | null;
  while ((em = elemRegex.exec(xml)) !== null) {
    const elemAttrs = em[1];
    const elemBody = em[2] ?? '';
    const name = attr(elemAttrs, 'name');
    if (!name || ALVL_EXCLUDED_FIELDS.has(name)) continue;
    const prefix = `${fieldNamePrefix}-`;
    elements.push({
      name,
      bareName: fieldNamePrefix && name.startsWith(prefix) ? name.slice(prefix.length) : name,
      infoObjectName: attr(elemAttrs, 'infoObjectName') || name,
      aggregationBehavior: attr(elemAttrs, 'aggregationBehavior') || undefined,
      isKeyFigure: /LocalKeyfigureProperties/.test(elemBody),
    });
  }
  return elements;
}

/**
 * Resolve caller-supplied field names against the provider's fields.
 *
 * Both spellings are accepted: the field's own name, and — on a CompositeProvider — the bare
 * name that the other read tools and the modelling UI show for it. A caller copying names out
 * of bw_get_composite_provider would otherwise never hit a single field.
 */
function resolveAlvlFields(
  fields: string[],
  available: ProviderElement[],
  providerUpper: string
): ProviderElement[] {
  const byName = new Map<string, ProviderElement>();
  for (const e of available) {
    byName.set(e.name.toUpperCase(), e);
    if (!byName.has(e.bareName.toUpperCase())) byName.set(e.bareName.toUpperCase(), e);
  }
  const wanted = fields.map((f) => f.trim().toUpperCase());
  const missing = wanted.filter((w) => !byName.has(w));
  if (missing.length > 0) {
    throw new Error(
      `Field(s) ${missing.join(', ')} not found on InfoProvider ${providerUpper} ` +
      `(available: ${available.map((e) => e.bareName).join(', ')}).`
    );
  }
  // De-duplicate, so naming a field by both spellings does not emit it twice.
  return [...new Set(wanted.map((w) => byName.get(w)!))];
}

/**
 * `0INFOPROV` is added by the server on a CompositeProvider-based aggregation level to say
 * which part provider a planning write goes to. It is not a modelling choice, so it does not
 * count towards the "at least one characteristic" rule.
 */
const SERVER_SUPPLIED_FIELDS = new Set(['0INFOPROV']);

/**
 * Both are activation requirements, checked before anything is written rather than surfacing
 * afterwards as an inconsistent aggregation level.
 */
function assertAlvlFieldMix(elements: Array<{ name: string; isKeyFigure: boolean }>): void {
  const characteristics = elements.filter(
    (e) => !e.isKeyFigure && !SERVER_SUPPLIED_FIELDS.has(e.name.toUpperCase())
  );
  if (characteristics.length === 0) {
    throw new Error('An aggregation level needs at least one characteristic.');
  }
  if (!elements.some((e) => e.isKeyFigure)) {
    throw new Error('An aggregation level needs at least one key figure.');
  }
}

/** One `<element>` block in the aggregation level's view node. */
function buildAlvlElementXml(element: ProviderElement): string {
  const localType = element.isKeyFigure ? 'LocalKeyfigureProperties' : 'LocalCharacteristicProperties';
  return (
    `    <element xsi:type="BwCore:BwElement" name="${element.name}"` +
    (element.aggregationBehavior ? ` aggregationBehavior="${element.aggregationBehavior}"` : '') +
    ` infoObjectName="${element.infoObjectName}">\n` +
    `      <localProperties xsi:type="BwCore:${localType}"/>\n` +
    `      <associationType>1</associationType>\n` +
    `    </element>`
  );
}

export interface AggregationLevelCreateOptions {
  label: string;
  infoArea: string;
  /** Planning-enabled InfoProvider the aggregation level is built on (aDSO or CompositeProvider). */
  infoProvider: string;
  package?: string;
  /**
   * Characteristics and key figures to expose, by their name on the InfoProvider. Omit to
   * expose every field of the provider.
   */
  fields?: string[];
  transport?: string;
}

/**
 * bw_create_aggregation_level — create a new Aggregation Level (TLOGO ALVL).
 *
 * Two phases, mirroring the captured request sequence in `payloads/alvl_create.md`:
 * lock (CREA) → POST the shell → unlock, then lock → PUT the field list → unlock. Activation
 * stays a separate step through bw_activate with object_type "alvl" and an empty lock handle.
 *
 * Both phases are mandatory. The create POST accepts an `<element>` list, answers HTTP 200
 * and then silently drops it — the shell it persists carries `selectAll="true"` and no
 * fields, and an aggregation level without fields cannot be activated ("select at least one
 * characteristic" / "select at least one key figure"). The field list only sticks through the
 * PUT on the inactive version.
 *
 * Element blocks are deliberately minimal: name, `infoObjectName`, `aggregationBehavior` and
 * the local-properties marker that says characteristic or key figure. Everything else — data
 * type, label, conversion routine, semantics, dimension group, consumption view properties —
 * is derived by the server from the InfoObject during activation, so none of it is worth
 * copying out of the InfoProvider and risking a mismatch.
 *
 * Other details that are easy to get wrong: the single view node is always named `ALVL` (not
 * derived from the object name, unlike a CompositeProvider's J1/U1), the entity reference
 * goes through `infoprov` rather than the CompositeProvider's `infoprov_dt`, and the package
 * travels in the `Development-Class` header instead of the body.
 *
 * Works on an aDSO and on a CompositeProvider alike; both are verified. On a CompositeProvider
 * the fields carry its generated prefix, which is the only name the element list is allowed to
 * use and the one name no other read tool shows, hence the bare-name fallback in the field
 * resolution. The server then adds `0INFOPROV` to the element list on its own — it identifies
 * the part provider a planning write goes to — so the read-back has one characteristic more
 * than was requested.
 */
export async function bwCreateAggregationLevel(
  client: BwClient,
  alvlName: string,
  options: AggregationLevelCreateOptions
): Promise<string> {
  const { label, infoArea, infoProvider, package: pkg = '$TMP', fields, transport } = options;

  const nameUpper = alvlName.toUpperCase();
  const infoAreaUpper = infoArea.toUpperCase();
  const providerUpper = infoProvider.trim().toUpperCase();
  // Captured creates carry the system's logon language. A language that is not installed
  // makes the create fail with an unconditional 500.
  const language = process.env.BW_LANGUAGE ?? 'EN';

  const available = await fetchAlvlProviderElements(providerUpper);
  if (available.length === 0) {
    throw new Error(
      `InfoProvider ${providerUpper} reports no fields that an aggregation level could expose.`
    );
  }

  const selected = fields && fields.length > 0
    ? resolveAlvlFields(fields, available, providerUpper)
    : available;

  assertAlvlFieldMix(selected);

  const shellBody =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Alvl:aggregationLevel ${ALVL_XMLNS} schemaVersion="1.14" name="${nameUpper}"` +
    ` defaultNode="#///ALVL">\n` +
    `  <endUserTexts label="${escapeXmlAttr(label)}"/>\n` +
    `  <viewNode xsi:type="View:Projection" name="ALVL">\n` +
    `    <input xsi:type="Composite:CompositeInput" selectAll="true">\n` +
    `      <entity>../../../infoprov/a/${providerUpper}.composite#//</entity>\n` +
    `    </input>\n` +
    `  </viewNode>\n` +
    `  <tlogoProperties adtcore:language="${language}" adtcore:name="${nameUpper}"` +
    ` adtcore:type="ALVL" adtcore:masterLanguage="${language}">\n` +
    `    <infoArea>${infoAreaUpper}</infoArea>\n` +
    `  </tlogoProperties>\n` +
    `</Alvl:aggregationLevel>`;

  const createLock = await client.lock('alvl', alvlName, { 'activity_context': 'CREA' });
  try {
    await client.create('alvl', alvlName, createLock, shellBody, {
      'Development-Class': pkg,
    });
  } catch (err) {
    await client.unlock('alvl', alvlName).catch(() => {/* ignore */});
    throw err;
  }
  await client.unlock('alvl', alvlName);

  // Phase two: add the field list to the inactive version the create just persisted.
  const alvlPath = `/sap/bw/modeling/alvl/${bwSeg(alvlName)}/m`;
  const shell = await freshRead(alvlPath, MEDIA_TYPES['alvl']);
  const timestamp = shell.headers['timestamp'] ?? shell.headers['TIMESTAMP'];
  const elementsXml = selected.map(buildAlvlElementXml).join('\n');
  const xml = shell.body.replace(/(<viewNode\b[^>]*>)/, `$1\n${elementsXml}\n`);
  if (xml === shell.body) {
    throw new Error(
      `Aggregation Level ${nameUpper} was created but its view node could not be located, ` +
      `so no fields were added. The object exists and is inactive.`
    );
  }

  const putLock = await client.lock('alvl', alvlName);
  try {
    await client.put('alvl', alvlName, putLock, xml, timestamp, transport);
  } finally {
    // Unlike the update tools, the lock is not handed on to the activation. An aggregation
    // level activates fine with an empty lock handle, and holding the lock would leave the
    // object stuck whenever the caller never gets round to activating: the enqueue belongs to
    // this ABAP session, so a later unlock from anywhere else reports success without
    // releasing anything.
    await client.unlock('alvl', alvlName).catch(() => {/* ignore */});
  }

  const characteristicCount = selected.filter((e) => !e.isKeyFigure).length;
  return JSON.stringify({
    success: true,
    message:
      `Aggregation Level ${nameUpper} created on InfoProvider ${providerUpper} in package ${pkg} ` +
      `with ${characteristicCount} characteristic(s) and ${selected.length - characteristicCount} ` +
      `key figure(s). Call bw_activate with object_type "alvl" and lock_handle "" to activate.`,
    aggregation_level_name: nameUpper,
    object_type: 'alvl',
    info_provider: providerUpper,
    fields: selected.map((e) => e.name),
  });
}

// ── bwUpdateAggregationLevelFields ────────────────────────────────────────────

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The elements an aggregation level currently exposes, read from its own definition. */
function parseAlvlElements(xml: string): Array<{ name: string; isKeyFigure: boolean }> {
  const viewNodeBody = xml.match(/<viewNode\b[^>]*>([\s\S]*?)<\/viewNode>/)?.[1] ?? '';
  const elements: Array<{ name: string; isKeyFigure: boolean }> = [];
  const elemRegex = /<element\b([\s\S]*?)(?:\/>|>([\s\S]*?)<\/element>)/g;
  let em: RegExpExecArray | null;
  while ((em = elemRegex.exec(viewNodeBody)) !== null) {
    const name = attr(em[1], 'name');
    if (!name) continue;
    elements.push({ name, isKeyFigure: /LocalKeyfigureProperties/.test(em[2] ?? '') });
  }
  return elements;
}

export type AggregationLevelFieldAction = 'add_fields' | 'remove_fields';

/**
 * bw_update_aggregation_level — add fields to or remove fields from an existing Aggregation
 * Level.
 *
 * Same mechanism as phase two of the create: the exposed fields are the `<element>` list of
 * the view node, and changing it is a full-object PUT on the inactive version. Removing a
 * field deletes its element block, adding one rebuilds it in the minimal form and lets the
 * server derive the rest from the InfoObject on activation. `selectAll` on the input stays
 * `"true"` either way; it does not express the selection.
 *
 * Field names resolve the same way as on the create, so on a CompositeProvider both the
 * prefixed and the bare spelling work.
 *
 * The lock is released before returning, so activation runs through bw_activate with
 * object_type "alvl" and an empty lock handle.
 */
export async function bwUpdateAggregationLevelFields(
  client: BwClient,
  alvlName: string,
  action: AggregationLevelFieldAction,
  fields: string[],
  opts: { transport?: string } = {}
): Promise<string> {
  const { transport } = opts;
  const nameUpper = alvlName.toUpperCase();
  if (!fields || fields.length === 0) {
    throw new Error(`${action} requires at least one field.`);
  }

  const alvlPath = `/sap/bw/modeling/alvl/${bwSeg(alvlName)}/m`;
  const current = await freshRead(alvlPath, MEDIA_TYPES['alvl']);
  const timestamp = current.headers['timestamp'] ?? current.headers['TIMESTAMP'];
  let xml = current.body;

  const providerName =
    xml.match(/<input\b[^>]*\bname="([^"]*)"/)?.[1] ??
    xml.match(/<entity>(?:.*\/)?([A-Za-z0-9_]+)\.composite#\/\//)?.[1];
  if (!providerName) {
    throw new Error(`Could not determine the underlying InfoProvider of Aggregation Level ${nameUpper}.`);
  }
  const providerUpper = providerName.toUpperCase();

  // Resolved against the provider rather than the aggregation level, so that both spellings
  // work for either action and a name that the provider does not have at all is rejected
  // with the list of what it does have.
  const available = await fetchAlvlProviderElements(providerUpper);
  const requested = resolveAlvlFields(fields, available, providerUpper);

  const existing = parseAlvlElements(xml);
  const existingNames = new Set(existing.map((e) => e.name.toUpperCase()));

  const applied: string[] = [];
  const skipped: string[] = [];

  if (action === 'remove_fields') {
    const remaining = existing.filter(
      (e) => !requested.some((r) => r.name.toUpperCase() === e.name.toUpperCase())
    );
    assertAlvlFieldMix(remaining);

    for (const field of requested) {
      if (!existingNames.has(field.name.toUpperCase())) {
        skipped.push(field.name);
        continue;
      }
      const blockRegex = new RegExp(
        `[ \\t]*<element\\b(?=[^>]*\\bname="${escapeRegex(field.name)}")` +
        `[^>]*(?:\\/>|>[\\s\\S]*?<\\/element>)\\n?`
      );
      const stripped = xml.replace(blockRegex, '');
      if (stripped === xml) {
        skipped.push(field.name);
        continue;
      }
      xml = stripped;
      applied.push(field.name);
    }
  } else {
    const toAdd = requested.filter((f) => {
      if (existingNames.has(f.name.toUpperCase())) {
        skipped.push(f.name);
        return false;
      }
      return true;
    });
    if (toAdd.length > 0) {
      const elementsXml = toAdd.map(buildAlvlElementXml).join('\n');
      const injected = xml.replace(/(<viewNode\b[^>]*>)/, `$1\n${elementsXml}\n`);
      if (injected === xml) {
        throw new Error(
          `Could not locate the view node of Aggregation Level ${nameUpper}. No fields were added.`
        );
      }
      xml = injected;
      applied.push(...toAdd.map((f) => f.name));
    }
  }

  if (applied.length === 0) {
    return JSON.stringify({
      success: false,
      message:
        `No change to Aggregation Level ${nameUpper}: ` +
        (action === 'remove_fields'
          ? `none of the requested field(s) are exposed by it (${skipped.join(', ')}).`
          : `it already exposes the requested field(s) (${skipped.join(', ')}).`),
      aggregation_level_name: nameUpper,
      object_type: 'alvl',
    });
  }

  const lockHandle = await client.lock('alvl', alvlName);
  try {
    await client.put('alvl', alvlName, lockHandle, xml, timestamp, transport);
  } finally {
    await client.unlock('alvl', alvlName).catch(() => {/* ignore */});
  }

  const verb = action === 'remove_fields' ? 'removed from' : 'added to';
  return JSON.stringify({
    success: true,
    message:
      `${applied.length} field(s) ${verb} Aggregation Level ${nameUpper}. ` +
      `Call bw_activate with object_type "alvl" and lock_handle "" to activate.`,
    aggregation_level_name: nameUpper,
    object_type: 'alvl',
    info_provider: providerUpper,
    fields_applied: applied,
    ...(skipped.length > 0 ? { fields_skipped: skipped } : {}),
  });
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
  const infoArea = stripInfoAreaSentinel(xml.match(/<infoArea[^>]*>([^<]+)<\/infoArea>/)?.[1]?.trim() ?? '');

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
    `InfoArea:            ${info.infoArea || '(none)'}`,
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
  const infoArea = stripInfoAreaSentinel(xml.match(/<infoArea[^>]*>([^<]+)<\/infoArea>/)?.[1]?.trim() ?? '');

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
    `InfoArea:          ${info.infoArea || '(none)'}`,
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
  const infoArea = stripInfoAreaSentinel(xml.match(/<infoArea[^>]*>([^<]+)<\/infoArea>/)?.[1]?.trim() ?? '');

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
  const path = `/sap/bw/modeling/plse/${bwSeg(funcName)}/a`;
  const result = await client.get(path, MEDIA_TYPES['plse']);
  const headerStatus = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? '';

  const info = parsePlseXml(result.body, headerStatus);

  const lines: string[] = [
    `Planning Function: ${info.name}`,
    `Status:            ${info.status}`,
    `Description:       ${info.description}`,
    `Function Type:     ${info.planningServiceType}`,
    `Aggregation Level: ${info.alvl}`,
    `InfoArea:          ${info.infoArea || '(none)'}`,
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
