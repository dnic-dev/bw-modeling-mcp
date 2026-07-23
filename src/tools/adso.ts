import { BwClient, MEDIA_TYPES, createClientFromEnv, freshRead, bwSeg } from '../bw-client.js';
import { parseInfoObjectProps } from './infoobject.js';

// ── aDSO type presets ────────────────────────────────────────────────────────

const typePresets: Record<string, Record<string, boolean>> = {
  standard: {
    activateData: true,
    cubeDeltaOnly: false,
    directUpdate: false,
    isReportingObject: true,
    noAqDeletion: false,
    writeChangelog: true,
  },
  staging_inbound_only: {
    activateData: false,
    cubeDeltaOnly: false,
    directUpdate: false,
    isReportingObject: false,
    noAqDeletion: false,
    writeChangelog: false,
  },
  staging_compress: {
    activateData: true,
    cubeDeltaOnly: false,
    directUpdate: false,
    isReportingObject: false,
    noAqDeletion: false,
  },
  staging_reporting: {
    activateData: true,
    cubeDeltaOnly: false,
    directUpdate: false,
    isReportingObject: true,
    noAqDeletion: true,
  },
  datamart: {
    activateData: true,
    cubeDeltaOnly: true,
    directUpdate: false,
    isReportingObject: true,
    noAqDeletion: false,
  },
  direct_update: {
    activateData: false,
    cubeDeltaOnly: false,
    directUpdate: true,
    isReportingObject: false,
    noAqDeletion: false,
  },
};

/**
 * Set or replace a boolean attribute on the root <adso:dataStore> element.
 * If the attribute already exists, its value is replaced in-place.
 * If not, it is injected just before the first closing > of the root tag.
 */
function setRootAttr(xml: string, attr: string, value: string): string {
  const existing = new RegExp(`\\b${attr}="[^"]*"`, 'g');
  if (existing.test(xml)) {
    return xml.replace(new RegExp(`\\b${attr}="[^"]*"`, 'g'), `${attr}="${value}"`);
  }
  // Attribute absent — inject into the root element opening tag before its first >
  return xml.replace(/(<adso:dataStore\b(?:[^>]|\n)*?)(\s*>)/, `$1 ${attr}="${value}"$2`);
}

const ADSO_ACCEPT = MEDIA_TYPES['adso'];

export interface AdsoSettings {
  adsoType?: 'standard' | 'staging_inbound_only' | 'staging_compress' | 'staging_reporting' | 'datamart' | 'direct_update';
  writeChangelog?: boolean;
  snapShotScenario?: boolean;
  uniqueDataRecords?: boolean;
  planningMode?: boolean;
  writeInterface?: boolean;
  label?: string;
  transport?: string;
}

/**
 * bw_update_adso action "update_settings" — change aDSO type and/or boolean flags.
 *
 * Workflow: GET full XML → lock → apply changes → PUT → return result.
 * Lock handle is returned so the caller can invoke bw_activate next.
 * Never modifies <tables>, <hashElements>, <pushURI>, or <tlogoProperties>.
 */
export async function bwUpdateAdsoSettings(
  client: BwClient,
  adsoName: string,
  settings: AdsoSettings
): Promise<string> {
  const adsoUpper = adsoName.toUpperCase();
  const adsoPath = `/sap/bw/modeling/adso/${bwSeg(adsoName)}/m`;

  // 1. Read current XML
  const adsoResult = await freshRead(adsoPath, ADSO_ACCEPT);
  const timestamp = adsoResult.headers['timestamp'] ?? adsoResult.headers['TIMESTAMP'];
  let xml = adsoResult.body;

  // 2. Apply type preset wholesale (overwrites the 5 core attributes)
  if (settings.adsoType !== undefined) {
    const preset = typePresets[settings.adsoType];
    for (const [attr, val] of Object.entries(preset)) {
      xml = setRootAttr(xml, attr, String(val));
    }
  }

  // 3. Apply individual boolean flags on top
  const boolFlags: Array<keyof AdsoSettings> = [
    'writeChangelog', 'snapShotScenario', 'uniqueDataRecords', 'planningMode',
  ];
  for (const flag of boolFlags) {
    if (settings[flag] !== undefined) {
      xml = setRootAttr(xml, flag, String(settings[flag]));
    }
  }

  // writeInterface maps to the XML attribute "pushMode"
  if (settings.writeInterface !== undefined) {
    xml = setRootAttr(xml, 'pushMode', String(settings.writeInterface));
  }

  // 4. Update label in <endUserTexts label="..."/>
  if (settings.label !== undefined) {
    const endUserTextsTag = `<endUserTexts label="${settings.label}"/>`;
    if (/<endUserTexts[^>]*\/>/.test(xml)) {
      // Replace existing <endUserTexts .../> (with or without label attribute)
      xml = xml.replace(/<endUserTexts[^>]*\/>/, endUserTextsTag);
    } else {
      // No <endUserTexts> present yet — insert before <tlogoProperties>
      xml = xml.replace(/(<tlogoProperties)/, `${endUserTextsTag}\n  $1`);
    }
  }

  // 5. Lock → PUT
  const lockHandle = await client.lock('adso', adsoName);
  try {
    await client.put('adso', adsoName, lockHandle, xml, timestamp, settings.transport);
  } catch (err) {
    await client.unlock('adso', adsoName).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message: `aDSO ${adsoUpper} settings updated. Call bw_activate to activate.`,
    lock_handle: lockHandle,
    adso_name: adsoUpper,
    object_type: 'adso',
    applied: settings,
  });
}

/**
 * bw_get_adso — read aDSO structure (inactive version).
 * format="raw": raw XML + header. format="text": structured plain-text summary.
 */
export async function bwGetAdso(
  client: BwClient,
  adsoName: string,
  format: 'text' | 'raw' = 'text',
): Promise<string> {
  const path = `/sap/bw/modeling/adso/${bwSeg(adsoName)}/m`;
  const result = await freshRead(path, ADSO_ACCEPT);
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';
  const ts = result.headers['timestamp'] ?? '';
  const rawOutput = `aDSO: ${adsoName.toUpperCase()}\nStatus: ${status}\nTimestamp: ${ts}\n\n${result.body}`;
  if (format === 'raw') return rawOutput;
  return summarizeAdso(adsoName.toUpperCase(), status, result.body);
}

function summarizeAdso(adsoName: string, status: string, xml: string): string {
  const lines: string[] = [];

  // ── Attribute helpers ─────────────────────────────────────────────────────
  const rootTagStr = xml.match(/<adso:dataStore\b[^>]*/)?.[0] ?? '';
  const strAttr = (name: string, src: string = rootTagStr): string =>
    src.match(new RegExp(`\\b${name}="([^"]*)"`)) ?.[1] ?? '';
  const boolAttr = (name: string, def = false): boolean => {
    const v = strAttr(name);
    return v === 'true' ? true : v === 'false' ? false : def;
  };
  const flag = (name: string): string => strAttr(name) || 'false';

  // ── Section 1: General ────────────────────────────────────────────────────
  const name = strAttr('name') || adsoName;
  const rawDesc = xml.match(/<endUserTexts label="([^"]*)"/)?.[1] ?? '';
  const desc = rawDesc
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'");
  const infoArea = xml.match(/<infoArea>([^<]*)<\/infoArea>/)?.[1] ?? '';
  const pkg = xml.match(/<adtcore:packageRef\b[^>]*\badtcore:name="([^"]*)"/)?.[1] ?? '';
  const objectVersion = xml.match(/<objectVersion>([^<]*)<\/objectVersion>/)?.[1] ?? '';
  const versionMap: Record<string, string> = { M: 'Inactive', A: 'Active' };
  const versionLabel = objectVersion
    ? `${objectVersion} (${versionMap[objectVersion] ?? objectVersion})`
    : '';

  const tlogoStr = xml.match(/<tlogoProperties\b[^>]*/)?.[0] ?? '';
  const createdAt = strAttr('adtcore:createdAt', tlogoStr);
  const createdBy = strAttr('adtcore:createdBy', tlogoStr);
  const changedAt = strAttr('adtcore:changedAt', tlogoStr);
  const changedBy = strAttr('adtcore:changedBy', tlogoStr);

  lines.push('── General ──');
  lines.push(`aDSO:        ${name}`);
  lines.push(`Description: ${desc}`);
  lines.push(`InfoArea:    ${infoArea}`);
  lines.push(`Package:     ${pkg}`);
  lines.push(`Status:      ${status}`);
  lines.push(`Version:     ${versionLabel}`);
  lines.push(`Created:     ${createdAt} (${createdBy})`);
  lines.push(`Changed:     ${changedAt} (${changedBy})`);

  // ── Section 2: Flags ──────────────────────────────────────────────────────
  lines.push('');
  lines.push('── Flags ──');
  lines.push(`Externe SAP HANA-View:              ${flag('withHanaModel')}`);
  lines.push(`Lesezugriffsausgabe protokollieren: ${flag('logRalOutput')}`);
  lines.push(`Schreib-Interface aktiviert:        ${flag('pushMode')}`);
  lines.push(`Planung aktiviert:                  ${flag('planningMode')}`);
  lines.push(`Bestand aktiviert:                  ${flag('isNcum')}`);

  // ── Section 3: Modelling Type ─────────────────────────────────────────────
  const directUpdate     = boolAttr('directUpdate');
  const cubeDeltaOnly    = boolAttr('cubeDeltaOnly');
  const noAqDeletion     = boolAttr('noAqDeletion');
  const isReportingObject = boolAttr('isReportingObject', true);
  const activateData     = boolAttr('activateData', true);
  const writeChangelog   = boolAttr('writeChangelog');
  const snapShotScenario = boolAttr('snapShotScenario');
  const uniqueDataRecords = boolAttr('uniqueDataRecords');

  let modellingType: string;
  if (directUpdate) {
    modellingType = 'DataStore-Objekt mit direkter Fortschreibung';
  } else if (cubeDeltaOnly && !noAqDeletion) {
    modellingType = 'Staging — Nur Eingangs-Queue';
  } else if (!cubeDeltaOnly && noAqDeletion) {
    modellingType = 'Staging — Daten komprimieren';
  } else if (cubeDeltaOnly && noAqDeletion) {
    modellingType = 'Staging — Reporting aktiviert';
  } else if (!isReportingObject && activateData && !cubeDeltaOnly) {
    modellingType = 'Data-Mart-DataStore-Objekt';
  } else {
    modellingType = 'Standard-DataStore-Objekt';
  }

  lines.push('');
  lines.push('── Modelling Type ──');
  lines.push(modellingType);
  if (writeChangelog)    lines.push('  Change Log schreiben: yes');
  if (snapShotScenario)  lines.push('  Snapshot-Unterstützung: yes');
  if (uniqueDataRecords) lines.push('  Eindeutige Datensätze: yes');

  // ── Section 4: Data Tiering ───────────────────────────────────────────────
  const tempMap: Record<string, string> = {
    HO:   'Hot',
    HWO:  'Hot, Warm',
    HWCP: 'Hot, Warm, Cold',
    WO:   'Warm only',
    WCP:  'Warm, Cold',
    CO:   'Cold only',
    HCO:  'Hot, Cold',
  };
  const tempRaw = strAttr('temperatureSchema');
  const exceptionalUpdate = flag('exceptionalUpdate');
  const dapOrigin = strAttr('dapOrigin');

  lines.push('');
  lines.push('── Data Tiering ──');
  lines.push(`Data Tiering:                      ${tempMap[tempRaw] ?? tempRaw}`);
  lines.push(`Außergewöhnliche Fortschreibungen: ${exceptionalUpdate}`);
  if (dapOrigin) lines.push(`Verbindung (DAP):                  ${dapOrigin}`);

  // ── Section 5: Key Fields ─────────────────────────────────────────────────
  const keyElements: string[] = [];
  const keySet = new Set<string>();
  const keyRe = /<keyElement>([^<]*)<\/keyElement>/g;
  let km: RegExpExecArray | null;
  while ((km = keyRe.exec(xml)) !== null) {
    const v = km[1].trim().replace(/^#\/\/\//, '');
    keyElements.push(v);
    keySet.add(v);
  }

  lines.push('');
  lines.push('── Key Fields ──');
  lines.push(keyElements.length > 0 ? keyElements.join(', ') : '(none)');

  // ── Section 6: Fields table ───────────────────────────────────────────────
  interface FieldRow {
    name: string; type: string; length: string; agg: string;
    dim: string; dimRaw: string; isKey: boolean; keyOrder: number; label: string;
  }

  const fields: FieldRow[] = [];
  const elemRe = /<element\b([^>]*)>([\s\S]*?)<\/element>/g;
  let em: RegExpExecArray | null;

  const getAttr = (s: string, key: string) =>
    s.match(new RegExp(`\\b${key}="([^"]*)"`)) ?.[1] ?? '';

  while ((em = elemRe.exec(xml)) !== null) {
    const openAttrs = em[1];
    const body      = em[2];
    const fieldName = getAttr(openAttrs, 'name');
    if (!fieldName) continue;

    const itStr      = body.match(/<inlineType\b[^>]*/)?.[0] ?? '';
    const fieldType  = getAttr(itStr, 'name');
    const lengthRaw  = getAttr(itStr, 'length');
    const precRaw    = getAttr(itStr, 'precision');
    const scaleRaw   = getAttr(itStr, 'scale');
    const agg        = getAttr(openAttrs, 'aggregationBehavior');
    const dimRaw     = getAttr(openAttrs, 'dimension');
    const dim        = dimRaw.replace(/^#\/\/\//, '').replace(/§$/, '');
    // QUAN/CURR: XML has precision=total_digits, scale=decimal_places (no length attr)
    // DEC: XML has length=total_digits, precision=decimal_places
    // Others: length only
    let lengthDisp: string;
    if (precRaw && scaleRaw) {
      lengthDisp = `${precRaw},${scaleRaw}`;
    } else if (lengthRaw && precRaw) {
      lengthDisp = `${lengthRaw},${precRaw}`;
    } else {
      lengthDisp = lengthRaw;
    }
    const isKey      = keySet.has(fieldName);
    const keyOrder   = isKey ? keyElements.indexOf(fieldName) : -1;
    const rawLabel   = body.match(/<endUserTexts label="([^"]*)"/)?.[1]
                    ?? body.match(/<descriptions label="([^"]*)"/)?.[1]
                    ?? '';
    const label = rawLabel
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'");

    fields.push({ name: fieldName, type: fieldType, length: lengthDisp, agg, dim, dimRaw, isKey, keyOrder, label });
  }

  fields.sort((a, b) => {
    if (a.isKey && b.isKey) return a.keyOrder - b.keyOrder;
    if (a.isKey) return -1;
    if (b.isKey) return 1;
    const aKyf = a.dimRaw.includes('KEYFIGURES');
    const bKyf = b.dimRaw.includes('KEYFIGURES');
    if (!aKyf && bKyf) return -1;
    if (aKyf && !bKyf) return 1;
    return 0;
  });

  lines.push('');
  lines.push(`── Fields (${fields.length}) ──`);

  const headers = ['NAME', 'TYPE', 'LENGTH', 'AGG', 'DIM', 'KEY', 'LABEL'];
  const cols = fields.map(f => [f.name, f.type, f.length, f.agg, f.dim, f.isKey ? 'yes' : 'no', f.label]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cols.map(r => r[i].length))
  );
  const row = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join('  ');

  lines.push(row(headers));
  lines.push(widths.map(w => '-'.repeat(w)).join('  '));
  for (const r of cols) lines.push(row(r));

  return lines.join('\n');
}

/**
 * Build the <element> XML snippet to inject into an aDSO.
 * Based on the recorded PUT payload pattern from adso_workflow.md Block 3b.
 */
function buildAdsoElement(iObjName: string, props: ReturnType<typeof parseInfoObjectProps>): string {
  const { conversionRoutine, label, dataType, length } = props;
  const name = iObjName.toUpperCase();
  const convAttr = conversionRoutine ? ` conversionRoutine="${conversionRoutine}"` : '';
  return `  <element xsi:type="adso:AdsoElement" name="${name}" keep="false"
    aggregationBehavior="NONE" infoObjectName="${name}"${convAttr}
    dimension="#///ALL§" sidDeterminationMode="S">
    <endUserTexts label="${label}"/>
    <inlineType name="${dataType}" length="${length}" globalElementName="${name}"/>
    <associationType>1</associationType>
  </element>`;
}

/**
 * Remove an <element> block (and any matching <keyElement>) from aDSO XML.
 * The server removes the field when the PUT body no longer contains it.
 */
function removeElement(adsoXml: string, iObjName: string): string {
  const name = iObjName.toUpperCase();

  // Remove the full <element ... name="NAME" ...>...</element> block
  const elementRegex = new RegExp(
    `[ \\t]*<element\\b[^>]*\\bname="${name}"[^>]*>[\\s\\S]*?<\\/element>\\n?`,
    'g'
  );
  let result = adsoXml.replace(elementRegex, '');

  // Remove <keyElement>#///NAME</keyElement> if the field was a key
  const keyElementRegex = new RegExp(
    `[ \\t]*<keyElement>[^<]*\\/${name}<\\/keyElement>\\n?`,
    'g'
  );
  result = result.replace(keyElementRegex, '');

  return result;
}

/**
 * Insert the new element directly after the last existing <element>.
 *
 * Reporting aDSOs anchor this with <keyElement>; staging / inbound aDSOs have no
 * <keyElement> tags and instead start their <dimension> blocks right after the elements.
 * Anchor on whichever of <keyElement or <dimension appears first so the new <element>
 * always lands before the dimensions (and before the keyElements when present).
 * Falls back to insertion before </adso:dataStore> only when neither anchor exists.
 */
function injectElement(adsoXml: string, elementXml: string): string {
  const keyIdx = adsoXml.indexOf('<keyElement');
  const dimIdx = adsoXml.indexOf('<dimension');
  const candidates = [keyIdx, dimIdx].filter((i) => i !== -1);
  if (candidates.length > 0) {
    const idx = Math.min(...candidates);
    return adsoXml.substring(0, idx) + elementXml + '\n  ' + adsoXml.substring(idx);
  }
  // Fallback: before closing root tag
  return adsoXml.replace('</adso:dataStore>', elementXml + '\n</adso:dataStore>');
}

/**
 * bw_update_adso action "manage_keys" — replace the complete <keyElement> list.
 *
 * Removes all existing <keyElement> entries and inserts one per entry in keyFields,
 * positioned after the last <element> and before <tlogoProperties>.
 * All other XML (elements, tables, hashElements, pushURI, tlogoProperties) is unchanged.
 * Returns the lockHandle so the caller can invoke bw_activate next.
 */
export async function bwUpdateAdsoManageKeys(
  client: BwClient,
  adsoName: string,
  keyFields: string[],
  transport?: string
): Promise<string> {
  const adsoUpper = adsoName.toUpperCase();
  const adsoPath = `/sap/bw/modeling/adso/${bwSeg(adsoName)}/m`;

  // 1. Read current XML
  const adsoResult = await freshRead(adsoPath, ADSO_ACCEPT);
  const timestamp = adsoResult.headers['timestamp'] ?? adsoResult.headers['TIMESTAMP'];
  let xml = adsoResult.body;

  // 2. Strip all existing <keyElement> entries (with any leading whitespace + trailing newline)
  xml = xml.replace(/[ \t]*<keyElement>[^<]*<\/keyElement>\n?/g, '');

  // 3. Build new <keyElement> block
  const normalized = keyFields.map((f) => f.trim().toUpperCase()).filter(Boolean);
  if (normalized.length > 0) {
    const keyBlock = normalized.map((f) => `  <keyElement>#///${f}</keyElement>`).join('\n') + '\n';
    // Insert before <tlogoProperties>; fall back to before </adso:dataStore>
    if (xml.includes('<tlogoProperties')) {
      xml = xml.replace('<tlogoProperties', keyBlock + '  <tlogoProperties');
    } else {
      xml = xml.replace('</adso:dataStore>', keyBlock + '</adso:dataStore>');
    }
  }

  // 4. Lock → PUT
  const lockHandle = await client.lock('adso', adsoName);
  try {
    await client.put('adso', adsoName, lockHandle, xml, timestamp, transport);
  } catch (err) {
    await client.unlock('adso', adsoName).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message: `aDSO ${adsoUpper} key fields updated. Call bw_activate to activate.`,
    lock_handle: lockHandle,
    adso_name: adsoUpper,
    object_type: 'adso',
    key_fields: normalized,
  });
}

export interface FieldProperties {
  // InfoObject-backed fields:
  sidDeterminationMode?: 'N' | 'R' | 'S' | 'M';
  localDescription?: string | null;   // null = clear override → <descriptions/>
  // Pure fields (Kennzahlen):
  aggregationBehavior?: 'SUM' | 'MIN' | 'MAX' | 'AVG' | 'LAST' | 'NONE';
  fixedCurrency?: string | null;      // null = remove element (dynamic currency)
  fixedUnit?: string | null;          // null = remove element (dynamic unit)
  // Unit/currency FIELD reference for a QUAN/CURR field: sets <unitCurrencyElement>#///FIELD</unitCurrencyElement>
  // so the key figure's unit/currency is taken from another field in the same aDSO (instead of a fixed value).
  // null = remove the reference. Mutually exclusive with fixedUnit/fixedCurrency (those are removed when set).
  unitCurrencyField?: string | null;
  description?: string;               // <localProperties><descriptions label="..."/>
  transport?: string;
}

/**
 * bw_update_adso action "update_field_properties" — modify properties of a single field.
 *
 * Finds the <element name="FIELDNAME"> block, applies only the specified properties,
 * and PUTs the full XML back. Never touches inlineType, conversionRoutine, outputLength,
 * associationType, associationValid, or atom:link.
 */
export async function bwUpdateAdsoFieldProperties(
  client: BwClient,
  adsoName: string,
  fieldName: string,
  properties: FieldProperties
): Promise<string> {
  const adsoUpper = adsoName.toUpperCase();
  const nameUpper = fieldName.trim().toUpperCase();

  // 1. GET full XML
  const adsoPath = `/sap/bw/modeling/adso/${bwSeg(adsoName)}/m`;
  const adsoResult = await freshRead(adsoPath, ADSO_ACCEPT);
  const timestamp = adsoResult.headers['timestamp'] ?? adsoResult.headers['TIMESTAMP'];
  const fullXml = adsoResult.body;

  // 2. Find the element block — opening tag may span multiple lines, hence [^>]* matches \n
  const elementRegex = new RegExp(
    `[ \\t]*<element\\b[^>]*\\bname="${nameUpper}"[^>]*>[\\s\\S]*?<\\/element>\\n?`
  );
  const match = elementRegex.exec(fullXml);
  if (!match) {
    return JSON.stringify({
      success: false,
      message: `Field ${nameUpper} not found in aDSO ${adsoUpper}.`,
    });
  }

  // 3. Detect field type
  const isInfoObject = /\binfoObjectName="/.test(match[0]);
  let elem = match[0];

  // ── Attribute helpers ────────────────────────────────────────────────────
  function replaceAttr(attr: string, value: string): void {
    if (new RegExp(`\\b${attr}="[^"]*"`).test(elem)) {
      elem = elem.replace(new RegExp(`\\b${attr}="[^"]*"`), `${attr}="${value}"`);
    } else {
      // Inject before the first > of the opening tag (may span lines)
      elem = elem.replace(/(<element\b(?:[^>]|\n)*?)(\s*>)/, `$1 ${attr}="${value}"$2`);
    }
  }

  function replaceDescriptions(desc: string): void {
    if (/<descriptions[^>]*\/>/.test(elem)) {
      elem = elem.replace(/<descriptions[^>]*\/>/, desc);
    } else if (/<descriptions>/.test(elem)) {
      elem = elem.replace(/<descriptions>[\s\S]*?<\/descriptions>/, desc);
    } else {
      // <localProperties> exists but has no <descriptions> yet — inject inside
      elem = elem.replace(/(<localProperties[^>]*>)/, `$1\n    ${desc}`);
    }
  }

  // ── Apply properties ──────────────────────────────────────────────────────
  if (properties.sidDeterminationMode !== undefined) {
    replaceAttr('sidDeterminationMode', properties.sidDeterminationMode);
  }

  if (properties.aggregationBehavior !== undefined) {
    replaceAttr('aggregationBehavior', properties.aggregationBehavior);
  }

  if (properties.localDescription !== undefined) {
    const desc = properties.localDescription === null
      ? '<descriptions/>'
      : `<descriptions label="${properties.localDescription}"/>`;
    replaceDescriptions(desc);
  }

  if (properties.description !== undefined) {
    replaceDescriptions(`<descriptions label="${properties.description}"/>`);
  }

  if (properties.fixedCurrency !== undefined) {
    if (properties.fixedCurrency === null) {
      elem = elem.replace(/[ \t]*<fixedCurrency>[^<]*<\/fixedCurrency>\n?/, '');
    } else if (/<fixedCurrency>/.test(elem)) {
      elem = elem.replace(/<fixedCurrency>[^<]*<\/fixedCurrency>/, `<fixedCurrency>${properties.fixedCurrency}</fixedCurrency>`);
    } else {
      elem = elem.replace(/(<inlineType[^>]*\/>)/, `$1\n  <fixedCurrency>${properties.fixedCurrency}</fixedCurrency>`);
    }
  }

  if (properties.fixedUnit !== undefined) {
    if (properties.fixedUnit === null) {
      elem = elem.replace(/[ \t]*<fixedUnit>[^<]*<\/fixedUnit>\n?/, '');
    } else if (/<fixedUnit>/.test(elem)) {
      elem = elem.replace(/<fixedUnit>[^<]*<\/fixedUnit>/, `<fixedUnit>${properties.fixedUnit}</fixedUnit>`);
    } else {
      elem = elem.replace(/(<inlineType[^>]*\/>)/, `$1\n  <fixedUnit>${properties.fixedUnit}</fixedUnit>`);
    }
  }

  if (properties.unitCurrencyField !== undefined) {
    // Always drop any existing reference and fixed value first — they are mutually exclusive.
    elem = elem.replace(/[ \t]*<unitCurrencyElement>[^<]*<\/unitCurrencyElement>\n?/, '');
    if (properties.unitCurrencyField === null) {
      // Removal only — dynamic unit/currency without a field is invalid; the caller must
      // then set a fixed value or another reference before activation.
    } else {
      const refField = properties.unitCurrencyField.trim().toUpperCase();
      // Field reference excludes a fixed value — remove any fixedUnit/fixedCurrency.
      elem = elem.replace(/[ \t]*<fixedUnit>[^<]*<\/fixedUnit>\n?/, '');
      elem = elem.replace(/[ \t]*<fixedCurrency>[^<]*<\/fixedCurrency>\n?/, '');
      // aDSO-level reference path is #///FIELD (segment-qualified only inside transformations).
      elem = elem.replace(/(<inlineType[^>]*\/>)/, `$1\n  <unitCurrencyElement>#///${refField}</unitCurrencyElement>`);
    }
  }

  // 4. Splice modified element back into full XML
  const updatedXml =
    fullXml.substring(0, match.index) +
    elem +
    fullXml.substring(match.index + match[0].length);

  // 5. Lock → PUT
  const lockHandle = await client.lock('adso', adsoName);
  try {
    await client.put('adso', adsoName, lockHandle, updatedXml, timestamp, properties.transport);
  } catch (err) {
    await client.unlock('adso', adsoName).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message: `Field ${nameUpper} in aDSO ${adsoUpper} updated. Call bw_activate to activate.`,
    lock_handle: lockHandle,
    adso_name: adsoUpper,
    object_type: 'adso',
    field_name: nameUpper,
    field_type: isInfoObject ? 'infoobject' : 'pure',
    applied: properties,
  });
}

// ── Pure field support ───────────────────────────────────────────────────────

export interface FieldDef {
  name: string;
  label: string;
  dataType: string;
  precision?: number;
  scale?: number;
  length?: number;
  aggregationBehavior?: string;
  isKey?: boolean;
}

// Keyfigure types: LocalKeyfigureProperties, aggregationBehavior, <semantics> tag
const KEYFIGURE_TYPES = new Set([
  'CURR', 'QUAN', 'DEC', 'D16D', 'D34D', 'FLTP',
  'INT1', 'INT2', 'INT4', 'INT8',
]);

// Fixed-length types: [length, precision, scale] — user input ignored
// precision=0 is omitted from XML; scale=0 is always omitted
const FIXED_LENGTH_TYPES: Record<string, [number, number, number]> = {
  'INT1': [3,  0, 0],
  'INT2': [5,  0, 0],
  'INT4': [10, 0, 0],
  'INT8': [19, 0, 0],
  'FLTP': [16, 16, 0],
  'DATS': [8,  0, 0],
  'TIMS': [6,  0, 0],
  'LANG': [1,  0, 0],
  'CUKY': [5,  0, 0],
  'UNIT': [3,  0, 0],
  'D16R': [16, 0, 0],
  'D16N': [16, 0, 0],
  'D34N': [34, 0, 0],
};

// User-facing type names mapped to internal API names
const TYPE_NAME_MAP: Record<string, string> = {
  'STRING':    'STRG',
  'RAWSTRING': 'RSTR',
  'SSTRING':   'SSTR',
  'DF16_RAW':  'D16R',
  'DF34_RAW':  'D34R',
  'DF16_DEC':  'D16D',
  'DF34_DEC':  'D34D',
};

// <semantics> tag value per type (omitted if not in this map)
const SEMANTICS_TAG: Record<string, string> = {
  'INT1': 'INT', 'INT2': 'INT', 'INT4': 'INT', 'INT8': 'INT',
  'FLTP': 'NUM', 'DEC':  'NUM',
  'CURR': 'AMO', 'QUAN': 'QUA',
};

// semanticType attribute for <inlineType>
const SEMANTIC_TYPE: Record<string, string> = {
  'DATS': 'date',
  'CUKY': 'currencyCode',
  'UNIT': 'unitOfMeasure',
  'CURR': 'amount',
  'QUAN': 'quantity',
};

function buildPureFieldElement(field: FieldDef): string {
  const name = field.name.trim().toUpperCase();
  const apiType = TYPE_NAME_MAP[field.dataType] ?? field.dataType;
  const isKeyfigure = KEYFIGURE_TYPES.has(apiType);
  const fixedDims = FIXED_LENGTH_TYPES[apiType];

  // Build <inlineType> attributes
  const inlineAttrs: string[] = [`name="${apiType}"`];

  if (fixedDims) {
    // Fixed-length types: always use lookup values, ignore user input
    inlineAttrs.push(`length="${fixedDims[0]}"`);
    if (fixedDims[1] !== 0) inlineAttrs.push(`precision="${fixedDims[1]}"`);
    // scale omitted (always 0)
  } else if (apiType === 'CURR' || apiType === 'QUAN') {
    // CURR/QUAN: XML precision = total digits, XML scale = decimal places (length always 0).
    // Users pass `scale` = decimal places (required, > 0 — BW rejects a currency/quantity with
    // scale 0). `precision` (with scale) = total digits, default 17 (BW standard amount/quantity
    // length). For backward compatibility a lone `precision` is still read as the decimal count.
    const decimalPlaces = field.scale ?? field.precision ?? 0;
    const totalDigits = field.scale !== undefined ? (field.precision ?? 17) : 17;
    inlineAttrs.push('length="0"');
    inlineAttrs.push(`precision="${totalDigits}"`);
    inlineAttrs.push(`scale="${decimalPlaces}"`);
  } else if (apiType === 'DEC') {
    // DEC: XML length = total digits (precision param), XML precision = decimal places (scale param)
    const totalDigits = field.precision ?? field.length;
    if (totalDigits !== undefined) inlineAttrs.push(`length="${totalDigits}"`);
    if (field.scale !== undefined) inlineAttrs.push(`precision="${field.scale}"`);
  } else if (apiType === 'D16D' || apiType === 'D34D') {
    // Decimal float: length=0, user-defined precision
    inlineAttrs.push('length="0"');
    if (field.precision !== undefined) inlineAttrs.push(`precision="${field.precision}"`);
  } else if (apiType === 'RSTR' || apiType === 'STRG') {
    // No length attribute for RSTR/STRG
  } else {
    // User-defined: CHAR, NUMC, SSTR, RAW etc.
    if (field.length !== undefined) inlineAttrs.push(`length="${field.length}"`);
    if (field.precision !== undefined) inlineAttrs.push(`precision="${field.precision}"`);
  }

  const semanticType = SEMANTIC_TYPE[apiType] ?? 'empty';
  inlineAttrs.push(`semanticType="${semanticType}"`);

  // aggregationBehavior — LOB types (STRG, RSTR) never get this attribute
  const isLob = apiType === 'STRG' || apiType === 'RSTR';
  const aggr = isLob ? undefined : (field.aggregationBehavior ?? (isKeyfigure ? 'SUM' : undefined));
  const aggrAttr = aggr !== undefined ? ` aggregationBehavior="${aggr}"` : '';

  // conversionRoutine (LANG only)
  const convAttr = apiType === 'LANG' ? ' conversionRoutine="ISOLA"' : '';

  const localPropsType = isKeyfigure
    ? 'BwCore:LocalKeyfigureProperties'
    : 'BwCore:LocalCharacteristicProperties';

  const semanticsTag = SEMANTICS_TAG[apiType];
  const semanticsLine = semanticsTag ? `\n    <semantics>${semanticsTag}</semantics>` : '';

  return (
    `  <element xsi:type="adso:AdsoElement" name="${name}"${aggrAttr}${convAttr}\n` +
    `    dimension="#///GROUP1§" sidDeterminationMode="N">\n` +
    `    <inlineType ${inlineAttrs.join(' ')}/>\n` +
    `    <localProperties xsi:type="${localPropsType}">\n` +
    `      <descriptions label="${field.label}"/>\n` +
    `    </localProperties>${semanticsLine}\n` +
    `  </element>`
  );
}

/**
 * bw_create_adso — create a new aDSO shell.
 *
 * action "from_template": proposes fields/keys/settings from a template object (pass templateName).
 *   templateType "ADSO" (default): copies from an existing aDSO.
 *   templateType "RSDS": proposes fields from a DataSource — sourceSystem is then required.
 *     This is a pure template mechanism over the same create endpoint; the only difference is the
 *     <template> element, which carries tlogo="RSDS" and the RSDS compound objectName.
 * action "empty": creates a minimal empty aDSO with the given adsoType preset.
 *
 * Workflow: Lock (CREA) → POST minimal XML → Unlock
 * After creation the aDSO is inactive — call bw_activate to activate it.
 */
export async function bwCreateAdso(
  client: BwClient,
  adsoName: string,
  label: string,
  infoArea: string,
  action: 'from_template' | 'empty' = 'from_template',
  templateName?: string,
  templateType: 'ADSO' | 'RSDS' = 'ADSO',
  sourceSystem?: string,
  adsoType: string = 'standard',
  pkg: string = '$TMP',
  writeInterface: boolean = false
): Promise<string> {
  const nameUpper = adsoName.toUpperCase();
  const infoAreaUpper = infoArea.toUpperCase();
  const language = process.env.BW_LANGUAGE ?? 'DE';

  // RSDS template requires the source system to build the compound objectName.
  // Validate before locking so we fail fast without leaving a dangling lock.
  if (action === 'from_template' && templateType === 'RSDS' && templateName && !sourceSystem) {
    throw new Error(
      'template_type "RSDS" requires source_system (the DataSource source system name) ' +
      'to build the RSDS compound objectName.'
    );
  }

  const lockHandle = await client.lock('adso', adsoName, {
    'activity_context': 'CREA',
    'parent_name': infoAreaUpper,
    'parent_type': 'AREA',
  });

  let body: string;
  const pushModeAttr = writeInterface ? ' pushMode="true"' : '';
  if (action === 'empty') {
    const preset = typePresets[adsoType] ?? typePresets['standard'];
    const typeAttrStr = Object.entries(preset).map(([k, v]) => `${k}="${v}"`).join(' ');
    body =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<adso:dataStore xmlns:adso="http://www.sap.com/bw/modeling/adso.ecore"` +
      ` xmlns:adtcore="http://www.sap.com/adt/core"` +
      ` schemaVersion="1.0" name="${nameUpper}" readOnly="false" ${typeAttrStr}${pushModeAttr}>\n` +
      `  <endUserTexts label="${label}"/>\n` +
      `  <tlogoProperties adtcore:language="${language}" adtcore:name="${nameUpper}"` +
      ` adtcore:type="ADSO" adtcore:masterLanguage="${language}">\n` +
      `    <infoArea>${infoAreaUpper}</infoArea>\n` +
      `  </tlogoProperties>\n` +
      `  <dimension name="GROUP1">\n` +
      `    <descriptions/>\n` +
      `  </dimension>\n` +
      `</adso:dataStore>`;
  } else {
    let templateElement = '';
    if (templateName) {
      if (templateType === 'RSDS') {
        // RSDS compound key: DataSource name + Source System name, each left-justified
        // in a fixed 30-char field (total length 60).
        const compoundKey =
          templateName.toUpperCase().padEnd(30, ' ') +
          (sourceSystem ?? '').toUpperCase().padEnd(30, ' ');
        templateElement = `\n  <template objectName="${compoundKey}" tlogo="RSDS"/>`;
      } else {
        templateElement = `\n  <template objectName="${templateName.toUpperCase()}" tlogo="ADSO"/>`;
      }
    }
    body =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<adso:dataStore xmlns:adso="http://www.sap.com/bw/modeling/adso.ecore"` +
      ` xmlns:adtcore="http://www.sap.com/adt/core"` +
      ` schemaVersion="1.0" name="${nameUpper}" readOnly="false"` +
      ` activateData="true" writeChangelog="true"${pushModeAttr}>\n` +
      `  <endUserTexts label="${label}"/>\n` +
      `  <tlogoProperties adtcore:language="${language}" adtcore:name="${nameUpper}"` +
      ` adtcore:type="ADSO" adtcore:masterLanguage="${language}">\n` +
      `    <infoArea>${infoAreaUpper}</infoArea>\n` +
      `  </tlogoProperties>\n` +
      `  <dimension name="GROUP1">\n` +
      `    <descriptions/>\n` +
      `  </dimension>${templateElement}\n` +
      `</adso:dataStore>`;
  }

  try {
    await client.create('adso', adsoName, lockHandle, body, {
      'Development-Class': pkg,
    });
  } catch (err) {
    await client.unlock('adso', adsoName).catch(() => {/* ignore */});
    throw err;
  }
  await client.unlock('adso', adsoName);

  const fromTemplate = templateName ? ` from template ${templateName.toUpperCase()}` : '';
  return JSON.stringify({
    success: true,
    message: `aDSO ${nameUpper} created${fromTemplate} in package ${pkg}. Call bw_activate to activate.`,
    adso_name: nameUpper,
    object_type: 'adso',
  });
}

/**
 * bw_update_adso action "add_pure_field" — add one or more pure (non-InfoObject) fields.
 *
 * Reuses buildPureFieldElement(). Supports isKey to also inject <keyElement> entries.
 * Workflow: GET full XML → inject elements + keyElements → Lock → PUT
 * Returns lockHandle so the caller can invoke bw_activate next.
 */
export async function bwUpdateAdsoAddPureField(
  client: BwClient,
  adsoName: string,
  fields: FieldDef[],
  transport?: string
): Promise<string> {
  const adsoUpper = adsoName.toUpperCase();
  const adsoPath = `/sap/bw/modeling/adso/${bwSeg(adsoName)}/m`;

  const adsoResult = await freshRead(adsoPath, ADSO_ACCEPT);
  const timestamp = adsoResult.headers['timestamp'] ?? adsoResult.headers['TIMESTAMP'];
  let xml = adsoResult.body;

  const elementBlocks: string[] = [];
  const keyElements: string[] = [];
  const processed: string[] = [];
  const skipped: string[] = [];

  for (const field of fields) {
    const name = field.name.trim().toUpperCase();
    if (xml.includes(`name="${name}"`)) {
      skipped.push(name);
      continue;
    }
    const apiType = TYPE_NAME_MAP[field.dataType] ?? field.dataType;
    if (apiType === 'CURR' || apiType === 'QUAN') {
      const decimalPlaces = field.scale ?? field.precision;
      if (decimalPlaces === undefined || decimalPlaces <= 0) {
        throw new Error(
          `Field ${name}: data type ${field.dataType} requires scale > 0 (decimal places). ` +
          `Pass e.g. scale: 2 for currency or scale: 3 for quantity.`
        );
      }
    }
    elementBlocks.push(buildPureFieldElement(field));
    if (field.isKey) {
      keyElements.push(`  <keyElement>#///${name}</keyElement>`);
    }
    processed.push(name);
  }

  if (processed.length === 0) {
    return JSON.stringify({
      success: false,
      message: `All fields already present in aDSO ${adsoUpper}. No changes made.`,
      skipped,
    });
  }

  const insertBlock = [...elementBlocks, ...keyElements].join('\n') + '\n';
  if (xml.includes('</tlogoProperties>')) {
    xml = xml.replace('</tlogoProperties>', '</tlogoProperties>\n' + insertBlock);
  } else {
    xml = xml.replace('</adso:dataStore>', insertBlock + '</adso:dataStore>');
  }

  const lockHandle = await client.lock('adso', adsoName);
  try {
    await client.put('adso', adsoName, lockHandle, xml, timestamp, transport);
  } catch (err) {
    await client.unlock('adso', adsoName).catch(() => {/* ignore */});
    throw err;
  }

  const result: Record<string, unknown> = {
    success: true,
    message: `${processed.length} pure field(s) added to aDSO ${adsoUpper}. Call bw_activate to activate.`,
    lock_handle: lockHandle,
    adso_name: adsoUpper,
    object_type: 'adso',
    processed,
  };
  if (skipped.length > 0) result['skipped'] = skipped;
  return JSON.stringify(result);
}

/**
 * bw_update_adso — add or remove one or more InfoObject fields in an aDSO.
 *
 * infoObjectName may be a single name or a comma-separated list (e.g. "IOBJ_A,IOBJ_B").
 * All fields are applied in one GET → mutate → PUT cycle; Lock/Unlock happen once.
 *
 * action "add_field" (default): reads each InfoObject, injects all elements, then PUT.
 * action "remove_field": removes all matching elements (+ keyElements), then PUT.
 *
 * Returns the lockHandle so the caller can invoke bw_activate next.
 * NOTE: activation (and unlock) is done separately via bw_activate.
 */
export async function bwUpdateAdso(
  client: BwClient,
  adsoName: string,
  infoObjectName: string,
  action: 'add_field' | 'remove_field' = 'add_field',
  transport?: string
): Promise<string> {
  const names = infoObjectName
    .split(',')
    .map((n) => n.trim().toUpperCase())
    .filter(Boolean);
  const adsoUpper = adsoName.toUpperCase();

  // Read current aDSO once (full XML + timestamp)
  const adsoPath = `/sap/bw/modeling/adso/${bwSeg(adsoName)}/m`;
  const adsoResult = await freshRead(adsoPath, ADSO_ACCEPT);
  const timestamp = adsoResult.headers['timestamp'] ?? adsoResult.headers['TIMESTAMP'];

  let updatedXml = adsoResult.body;
  const processed: string[] = [];
  const skipped: string[] = [];

  if (action === 'remove_field') {
    for (const name of names) {
      if (!updatedXml.includes(`name="${name}"`)) {
        skipped.push(name);
        continue;
      }
      updatedXml = removeElement(updatedXml, name);
      processed.push(name);
    }

    if (processed.length === 0) {
      return JSON.stringify({
        success: false,
        message: `None of the fields (${names.join(', ')}) found in aDSO ${adsoUpper}. No changes made.`,
      });
    }
  } else {
    // add_field — read each InfoObject and inject. One fresh reader session for the
    // whole call: an InfoObject created/edited earlier through the shared client
    // could otherwise be served from a stale session buffer.
    const iobjReader = createClientFromEnv();
    for (const name of names) {
      if (updatedXml.includes(`infoObjectName="${name}"`)) {
        skipped.push(name);
        continue;
      }
      const iObjResult = await iobjReader.get(
        `/sap/bw/modeling/iobj/${bwSeg(name)}/m?forceCacheUpdate=true`,
        MEDIA_TYPES['iobj']
      );
      const iObjProps = parseInfoObjectProps(iObjResult.body);
      updatedXml = injectElement(updatedXml, buildAdsoElement(name, iObjProps));
      processed.push(name);
    }

    if (processed.length === 0) {
      return JSON.stringify({
        success: false,
        message: `All fields (${names.join(', ')}) are already present in aDSO ${adsoUpper}. No changes made.`,
      });
    }
  }

  // Add snapShotScenario attribute if missing (BWMT includes it in PUT requests)
  if (!updatedXml.includes('snapShotScenario')) {
    updatedXml = updatedXml.replace(
      'nextRemodelingVersion="1"',
      'nextRemodelingVersion="1" snapShotScenario="false"'
    );
  }

  // Lock once → PUT → unlock on failure
  const lockHandle = await client.lock('adso', adsoName);
  try {
    await client.put('adso', adsoName, lockHandle, updatedXml, timestamp, transport);
  } catch (err) {
    await client.unlock('adso', adsoName).catch(() => {/* ignore unlock error */});
    throw err;
  }

  const verb = action === 'remove_field' ? 'removed from' : 'added to';
  const result: Record<string, unknown> = {
    success: true,
    message: `${processed.join(', ')} ${verb} aDSO ${adsoUpper}. Call bw_activate to activate.`,
    lock_handle: lockHandle,
    adso_name: adsoUpper,
    object_type: 'adso',
    processed,
  };
  if (skipped.length > 0) result['skipped'] = skipped;
  return JSON.stringify(result);
}
