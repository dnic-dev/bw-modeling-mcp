import {
  BwClient,
  MEDIA_TYPES,
  createClientFromEnv,
  freshRead,
  bwSeg,
  stripInfoAreaSentinel,
} from '../bw-client.js';
import { parseInfoObjectProps, parseInfoObjectFacts, type InfoObjectFacts } from './infoobject.js';
import { readPlanningMode, type PlanningMode } from './adso_data.js';

// ── aDSO type presets ────────────────────────────────────────────────────────

/**
 * The eight root flags that together make the modeling type. A type is always written as the
 * complete set: a flag left over from the previous type changes what the server reads the
 * object as — a change log kept on a staging aDSO makes it a standard one again, and on a
 * direct-update aDSO it fails the consistency check.
 */
const TYPE_FLAGS = [
  'activateData', 'writeChangelog', 'snapShotScenario', 'uniqueDataRecords',
  'isReportingObject', 'noAqDeletion', 'cubeDeltaOnly', 'directUpdate',
] as const;

const NO_FLAGS: Record<string, boolean> = Object.fromEntries(TYPE_FLAGS.map((f) => [f, false]));

const typePresets: Record<string, Record<string, boolean>> = {
  standard: { ...NO_FLAGS, activateData: true, isReportingObject: true, writeChangelog: true },
  staging_inbound_only: { ...NO_FLAGS },
  staging_compress: { ...NO_FLAGS, activateData: true },
  staging_reporting: { ...NO_FLAGS, activateData: true, noAqDeletion: true, isReportingObject: true },
  datamart: { ...NO_FLAGS, activateData: true, cubeDeltaOnly: true, isReportingObject: true },
  direct_update: { ...NO_FLAGS, directUpdate: true, isReportingObject: true },
};

export type AdsoTypePreset = keyof typeof typePresets;

const ADSO_TYPE_LABELS: Record<string, string> = {
  standard: 'Standard-DataStore-Objekt',
  staging_inbound_only: 'Staging — Nur Eingangs-Queue',
  staging_compress: 'Staging — Daten komprimieren',
  staging_reporting: 'Staging — Reporting aktiviert',
  datamart: 'Data-Mart-DataStore-Objekt',
  direct_update: 'DataStore-Objekt mit direkter Fortschreibung',
};

/**
 * The type presets a set of root flags matches, most likely first.
 *
 * The inverse of typePresets, checked against what the server keeps after a create on both a
 * BW/4HANA and a classic release. A classic release does not carry isReportingObject, and
 * without it a standard aDSO without change log and a compressing staging aDSO leave the
 * same flags — both are returned then.
 */
export function adsoTypeCandidates(rootTag: string): string[] {
  const value = (name: string) => rootTag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
  const on = (name: string) => value(name) === 'true';
  if (on('directUpdate')) return ['direct_update'];
  if (value('activateData') === 'false') return ['staging_inbound_only'];
  if (on('cubeDeltaOnly')) return ['datamart'];
  if (on('noAqDeletion')) return ['staging_reporting'];
  if (on('writeChangelog')) return ['standard'];
  const reporting = value('isReportingObject');
  if (reporting === 'false') return ['staging_compress'];
  if (reporting === 'true') return ['standard'];
  return ['standard', 'staging_compress'];
}

function adsoTypeLabel(candidates: string[]): string {
  const [first, ...rest] = candidates;
  const label = `${ADSO_TYPE_LABELS[first] ?? first} (adso_type: ${first})`;
  return rest.length
    ? `${label} — on this release not distinguishable from ${rest.map((c) => `${ADSO_TYPE_LABELS[c]} (adso_type: ${c})`).join(', ')}`
    : label;
}

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

// ── Document helpers ─────────────────────────────────────────────────────────

const rootTagOf = (xml: string): string => xml.match(/<adso:dataStore\b[^>]*>/)?.[0] ?? '';
const rootAttrOf = (xml: string, name: string): string | undefined =>
  rootTagOf(xml).match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const rootFlagOf = (xml: string, name: string): boolean => rootAttrOf(xml, name) === 'true';

/** Replace a root attribute only where the document already carries it. */
function setRootAttrIfPresent(xml: string, attr: string, value: string): string {
  return rootAttrOf(xml, attr) === undefined ? xml : setRootAttr(xml, attr, value);
}

function removeRootAttr(xml: string, attr: string): string {
  const root = rootTagOf(xml);
  return root ? xml.replace(root, root.replace(new RegExp(`\\s+${attr}="[^"]*"`), '')) : xml;
}

const escapeXmlAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface AdsoElementInfo {
  name: string;
  infoObjectName?: string;
  /** InfoObject type as the server reports it: CHA, KYF, TIM, UNI, XXL. Absent on plain fields. */
  objectType?: string;
  sidMode?: string;
  aggregation?: string;
  conversionRoutine?: string;
  dataType: string;
  length?: number;
  compoundParents: string[];
  unitCurrencyElement?: string;
  highCardinality?: boolean;
}

const refName = (ref: string): string => ref.trim().replace(/^#\/\/\//, '');

export function adsoElements(xml: string): AdsoElementInfo[] {
  const attr = (s: string, key: string) => s.match(new RegExp(`\\b${key}="([^"]*)"`))?.[1];
  const out: AdsoElementInfo[] = [];
  for (const m of xml.matchAll(/<element\b([^>]*)>([\s\S]*?)<\/element>/g)) {
    const name = attr(m[1], 'name');
    if (!name) continue;
    const inline = m[2].match(/<inlineType\b[^>]*/)?.[0] ?? '';
    const cv = m[2].match(/<consumptionViewProperties\b[^>]*/)?.[0] ?? '';
    const length = attr(inline, 'length');
    const highCard = attr(cv, 'highCardinality');
    out.push({
      name,
      infoObjectName: attr(m[1], 'infoObjectName') || undefined,
      objectType: attr(cv, 'objectType') || undefined,
      sidMode: attr(m[1], 'sidDeterminationMode'),
      aggregation: attr(m[1], 'aggregationBehavior'),
      conversionRoutine: attr(m[1], 'conversionRoutine') || undefined,
      dataType: attr(inline, 'name') ?? '',
      length: length !== undefined ? Number(length) : undefined,
      compoundParents: [...m[2].matchAll(/<compoundInfoObjects?>([^<]*)<\/compoundInfoObjects?>/g)].map((c) => refName(c[1])),
      unitCurrencyElement: m[2].match(/<unitCurrencyElement>([^<]*)<\/unitCurrencyElement>/)?.[1].trim().replace(/^#\/\/\//, ''),
      highCardinality: highCard === undefined ? undefined : highCard === 'true',
    });
  }
  return out;
}

const keyFieldsOf = (xml: string): string[] =>
  [...xml.matchAll(/<keyElement>([^<]*)<\/keyElement>/g)].map((m) => refName(m[1]));

/**
 * Whether the modeling type has a key at all: a data mart treats every characteristic as key
 * and an aDSO without active data has no active table to key.
 */
const canCarryKeys = (xml: string): boolean =>
  !rootFlagOf(xml, 'cubeDeltaOnly') && (rootFlagOf(xml, 'activateData') || rootFlagOf(xml, 'directUpdate'));

const isWriteOptimized = (xml: string): boolean => !TYPE_FLAGS.some((f) => rootFlagOf(xml, f));

/** A field counts as key figure when it is a key figure InfoObject or aggregates. */
const isKeyFigureField = (el: AdsoElementInfo): boolean =>
  el.objectType === 'KYF' || el.objectType === 'XXL' || (el.aggregation !== undefined && el.aggregation !== '' && el.aggregation !== 'NONE');

const TYPES_INVALID_IN_KEY = new Set(['STRG', 'RSTR', 'RAW', 'D16R', 'D34R']);
const MAX_KEY_FIELDS = 120;

/** Why a field cannot be part of the key or carry the partitioning, or undefined when it can. */
export function keyObstacle(el: AdsoElementInfo): string | undefined {
  if (isKeyFigureField(el)) {
    return el.objectType === 'KYF' || el.objectType === 'XXL'
      ? `it is a ${el.objectType === 'XXL' ? 'XXL' : 'key figure'} InfoObject`
      : `it aggregates (${el.aggregation}); only fields with aggregation NONE can be key`;
  }
  if (TYPES_INVALID_IN_KEY.has(el.dataType)) return `data type ${el.dataType} is not allowed in a key`;
  if (el.dataType === 'NUMC' && (el.length ?? 0) > 69) return 'NUMC fields longer than 69 are not allowed in a key';
  return undefined;
}

// ── Partitioning ─────────────────────────────────────────────────────────────

const PARTITION_RE = /[ \t]*<partitioningCriteria\b[^>]*?(?:\/>|>[\s\S]*?<\/partitioningCriteria>)\n?/gi;

/** The field all partitions are defined on, or undefined when the aDSO is not partitioned. */
const partitionFieldOf = (xml: string): string | undefined => {
  const first = xml.match(/<partitioningCriteria\b[^>]*\bfield="([^"]*)"/i)?.[1];
  return first === undefined ? undefined : refName(first);
};

/** Remove every partition together with the dynamic partitioning switches. */
export function clearPartitioning(xml: string): string {
  let out = xml.replace(PARTITION_RE, '');
  out = removeRootAttr(out, 'dynamicPartitions');
  out = removeRootAttr(out, 'dynamicPartitionGranularity');
  return out;
}

/**
 * Remove every reference to a field outside its own element: key, hash and validity lists,
 * index elements, criteria, the non-cumulative time reference and the partitioning. The
 * modeling tools do this on delete; the server does not — a partition left pointing at a
 * removed field ends in a runtime error on save.
 */
export function removeFieldReferences(xml: string, name: string): { xml: string; removed: string[] } {
  const removed: string[] = [];
  let out = xml;
  const listTags: Array<[string, string]> = [
    ['keyElement', 'key'], ['hashElements', 'hash key'], ['validityElements', 'validity fields'], ['elements', 'index'],
  ];
  for (const [tag, label] of listTags) {
    const re = new RegExp(`[ \\t]*<${tag}>\\s*#\\/\\/\\/${name}\\s*<\\/${tag}>\\n?`, 'g');
    if (re.test(out)) {
      out = out.replace(re, '');
      removed.push(label);
    }
  }
  if (partitionFieldOf(out) === name) {
    out = clearPartitioning(out);
    removed.push('partitioning');
  }
  const criteria = new RegExp(`[ \\t]*<chaConst\\b[^>]*\\bfield="#\\/\\/\\/${name}"[^>]*?(?:\\/>|>[\\s\\S]*?<\\/chaConst>)\\n?`, 'g');
  if (criteria.test(out)) {
    out = out.replace(criteria, '');
    removed.push('criteria');
  }
  if (refName(rootAttrOf(out, 'ncumtim') ?? '') === name) {
    out = setRootAttr(out, 'ncumtim', '');
    removed.push('non-cumulative time reference');
  }
  return { xml: out, removed };
}

// ── SID determination mode ───────────────────────────────────────────────────

type SidMode = 'N' | 'R' | 'S' | 'M';

interface SidContext {
  /** Data mart (cubeDeltaOnly). */
  cube: boolean;
  directUpdate: boolean;
  planning: boolean;
}

interface SidSubject {
  objectType?: string;
  compounded: boolean;
  attributeOnly: boolean;
  highCardinality: boolean;
}

/**
 * The SID determination modes the modeling tools offer for an InfoObject field. Key figures
 * and XXL InfoObjects never determine SIDs. A planning-enabled data mart or direct-update
 * aDSO, and a compounded characteristic in a data mart, need SIDs at load time. A
 * characteristic that is attribute-only or of high cardinality has no SID table to load into.
 */
export function allowedSidModes(subject: SidSubject, ctx: SidContext): SidMode[] {
  if (subject.objectType === 'KYF' || subject.objectType === 'XXL') return ['N'];
  let modes: SidMode[] = subject.objectType === 'TIM' || subject.objectType === 'UNI' ? ['N', 'R', 'S'] : ['N', 'R', 'S', 'M'];
  if (!['CHA', 'TIM', 'UNI'].includes(subject.objectType ?? '')) return modes;
  if ((ctx.planning && (ctx.cube || ctx.directUpdate)) || (ctx.cube && subject.compounded && !subject.highCardinality)) {
    modes = modes.filter((m) => m === 'S' || m === 'M');
  }
  if (subject.objectType === 'CHA' && (subject.attributeOnly || subject.highCardinality)) {
    modes = modes.filter((m) => m === 'N' || m === 'R');
  }
  return modes;
}

export function defaultSidMode(subject: SidSubject, ctx: SidContext): SidMode {
  const modes = allowedSidModes(subject, ctx);
  if (modes.length > 0 && !modes.includes('S')) {
    return modes.includes('R') && subject.highCardinality ? 'R' : modes[0];
  }
  return 'S';
}

const sidContextOf = (xml: string): SidContext => ({
  cube: rootFlagOf(xml, 'cubeDeltaOnly'),
  directUpdate: rootFlagOf(xml, 'directUpdate'),
  planning: rootFlagOf(xml, 'planningMode'),
});

// ── InfoObject facts ─────────────────────────────────────────────────────────

export { parseInfoObjectFacts };

async function readInfoObjectFacts(reader: BwClient, name: string): Promise<InfoObjectFacts> {
  const result = await reader.get(`/sap/bw/modeling/iobj/${bwSeg(name)}/m?forceCacheUpdate=true`, MEDIA_TYPES['iobj']);
  return parseInfoObjectFacts(name, result.body);
}

/**
 * The modeling tools re-default the SID mode of every characteristic, unit and time field whose
 * current mode the new type no longer allows. Only the two cases that restrict the list to
 * load-time SIDs can do that; a field already on S or M is never touched.
 */
async function adjustSidModes(
  xml: string,
  facts: (el: AdsoElementInfo) => Promise<SidSubject>,
): Promise<{ xml: string; adjusted: Array<{ field: string; from: string; to: string }> }> {
  const ctx = sidContextOf(xml);
  const adjusted: Array<{ field: string; from: string; to: string }> = [];
  if (!ctx.cube && !(ctx.planning && ctx.directUpdate)) return { xml, adjusted };
  let out = xml;
  for (const el of adsoElements(xml)) {
    if (!el.infoObjectName || !['CHA', 'TIM', 'UNI'].includes(el.objectType ?? '')) continue;
    if (el.sidMode === 'S' || el.sidMode === 'M') continue;
    const subject = await facts(el);
    // The server keeps an attribute-only or high-cardinality characteristic off load-time SIDs
    // whatever is sent, so those stay as they are.
    if (subject.attributeOnly || subject.highCardinality) continue;
    const restricted =
      (ctx.planning && (ctx.cube || ctx.directUpdate)) || (ctx.cube && el.compoundParents.length > 0);
    if (!restricted) continue;
    const open = new RegExp(`(<element\\b[^>]*\\bname="${el.name}"[^>]*?)\\bsidDeterminationMode="[^"]*"`);
    if (!open.test(out)) continue;
    out = out.replace(open, '$1sidDeterminationMode="S"');
    adjusted.push({ field: el.name, from: el.sidMode ?? '', to: 'S' });
  }
  return { xml: out, adjusted };
}

/**
 * Resolved per call, not once at import: discovery runs lazily on the first tool call and
 * rewrites MEDIA_TYPES, which a module-level constant would never see. Binding it early
 * pins the hardcoded fallback for the whole process, so a backend on a lower resource
 * version answers every aDSO request with HTTP 415.
 */
const adsoAccept = (): string => MEDIA_TYPES['adso'];

export interface AdsoSettings {
  adsoType?: 'standard' | 'staging_inbound_only' | 'staging_compress' | 'staging_reporting' | 'datamart' | 'direct_update';
  writeChangelog?: boolean;
  snapShotScenario?: boolean;
  uniqueDataRecords?: boolean;
  planningMode?: boolean;
  writeInterface?: boolean;
  temperatureSchema?: 'HO' | 'WO' | 'HWO' | 'HWP';
  label?: string;
  transport?: string;
}

/**
 * The feature switches the server publishes per aDSO (dynamic partitioning, automatic merge,
 * …). Best effort: a release without the resource simply has none of them.
 */
async function readAdsoConfiguration(adsoName: string): Promise<Record<string, boolean>> {
  try {
    const result = await freshRead(`/sap/bw/modeling/adso/${bwSeg(adsoName)}/configuration`, 'application/xml, */*');
    return Object.fromEntries(
      [...result.body.matchAll(/<simpleParams\s+(\w+)="(true|false)"/g)].map((m) => [m[1], m[2] === 'true']),
    );
  } catch {
    return {};
  }
}

/**
 * bw_update_adso action "update_settings" — change aDSO type and/or boolean flags.
 *
 * Workflow: GET full XML → lock → apply changes → PUT → return result.
 * Lock handle is returned so the caller can invoke bw_activate next.
 * Never modifies <tables>, <hashElements>, <pushURI>, or <tlogoProperties>.
 *
 * A type is written the way the modeling tools write it: all eight type flags are reset and
 * the ones of the new type set, then everything the new type cannot carry is dropped (key
 * definition, partitioning, per-partition tiering, dynamic partitioning) and the SID modes the
 * new type no longer allows are re-defaulted. Change log, snapshot and unique records belong
 * to the standard type only.
 */
export async function bwUpdateAdsoSettings(
  client: BwClient,
  adsoName: string,
  settings: AdsoSettings
): Promise<string> {
  const adsoUpper = adsoName.toUpperCase();
  const adsoPath = `/sap/bw/modeling/adso/${bwSeg(adsoName)}/m`;

  // 1. Read current XML
  const adsoResult = await freshRead(adsoPath, adsoAccept());
  const timestamp = adsoResult.headers['timestamp'] ?? adsoResult.headers['TIMESTAMP'];
  let xml = adsoResult.body;

  // 2. Modeling type and its sub-options
  const currentTypes = adsoTypeCandidates(rootTagOf(xml));
  const subOptions: Array<['writeChangelog' | 'snapShotScenario' | 'uniqueDataRecords', string]> = [
    ['writeChangelog', 'write_changelog'], ['snapShotScenario', 'snap_shot_scenario'], ['uniqueDataRecords', 'unique_data_records'],
  ];
  const givenSubOptions = subOptions.filter(([key]) => settings[key] !== undefined);
  const targetType = settings.adsoType ?? (givenSubOptions.length > 0 ? currentTypes[0] : undefined);
  const typeChanges = settings.adsoType !== undefined && !currentTypes.includes(settings.adsoType);

  if (targetType !== undefined && targetType !== 'standard') {
    const enabled = givenSubOptions.filter(([key]) => settings[key] === true).map(([, param]) => param);
    if (enabled.length > 0) {
      throw new Error(
        `${enabled.join(', ')} belong${enabled.length === 1 ? 's' : ''} to the standard type only; ` +
        (settings.adsoType !== undefined
          ? `adso_type "${targetType}" cannot carry ${enabled.length === 1 ? 'it' : 'them'}.`
          : `aDSO ${adsoUpper} is of type "${targetType}". Pass adso_type "standard" in the same call to change the type.`),
      );
    }
  }
  if (settings.adsoType !== undefined || (targetType === 'standard' && givenSubOptions.length > 0)) {
    const wasStandard = currentTypes.includes('standard');
    const flags: Record<string, boolean> = settings.adsoType !== undefined
      ? { ...typePresets[settings.adsoType] }
      : Object.fromEntries(TYPE_FLAGS.map((f) => [f, rootFlagOf(xml, f)]));
    if (targetType === 'standard') {
      flags.writeChangelog = settings.writeChangelog ?? (wasStandard ? rootFlagOf(xml, 'writeChangelog') : true);
      flags.snapShotScenario = settings.snapShotScenario ?? (wasStandard ? rootFlagOf(xml, 'snapShotScenario') : false);
      flags.uniqueDataRecords = settings.uniqueDataRecords ?? (wasStandard ? rootFlagOf(xml, 'uniqueDataRecords') : false);
      if (flags.snapShotScenario && !flags.writeChangelog) {
        throw new Error('snap_shot_scenario needs the change log: pass write_changelog true as well.');
      }
      if (flags.snapShotScenario && flags.uniqueDataRecords) {
        throw new Error('snap_shot_scenario and unique_data_records exclude each other.');
      }
    }
    for (const flag of TYPE_FLAGS) xml = setRootAttr(xml, flag, String(flags[flag]));
  }

  if (settings.planningMode !== undefined) {
    xml = setRootAttr(xml, 'planningMode', String(settings.planningMode));
  }

  // writeInterface maps to the XML attribute "pushMode"; the merge mode follows it where the
  // server offers the automatic merge.
  if (settings.writeInterface !== undefined && settings.writeInterface !== rootFlagOf(xml, 'pushMode')) {
    xml = setRootAttr(xml, 'pushMode', String(settings.writeInterface));
    if ((await readAdsoConfiguration(adsoName))['autoMergeSupported']) {
      xml = setRootAttr(xml, 'mergeMode', settings.writeInterface ? 'AUTO' : 'SMART');
    }
  }

  // 3. Data tiering. Anything but hot-only needs an active table to tier.
  if (settings.temperatureSchema !== undefined) {
    if (settings.temperatureSchema !== 'HO' && !rootFlagOf(xml, 'activateData') && !rootFlagOf(xml, 'directUpdate')) {
      throw new Error(
        `temperature_schema "${settings.temperatureSchema}" needs an aDSO with active data or direct update; ` +
        `aDSO ${adsoUpper} has neither and stays on "HO".`,
      );
    }
    if (settings.temperatureSchema === 'HWP' && (partitionFieldOf(xml) === undefined || isWriteOptimized(xml))) {
      throw new Error(
        `temperature_schema "HWP" tiers per partition, and aDSO ${adsoUpper} has no partitions. ` +
        'Define them with action "manage_partitions" first, or use "HWO" for the whole object.',
      );
    }
    const before = rootAttrOf(xml, 'temperatureSchema');
    xml = setRootAttr(xml, 'temperatureSchema', settings.temperatureSchema);
    // The expected row count describes the object-level layout and is reset with it.
    if (settings.temperatureSchema === 'HWP' && before !== 'HWP' && before !== 'HWCP' && (rootAttrOf(xml, 'expectedRowCount') ?? '0') !== '0') {
      xml = setRootAttr(xml, 'expectedRowCount', '0');
    }
  }

  // 4. Drop what the resulting type cannot carry.
  const removedKeyFields: string[] = [];
  let removedPartitions = false;
  let removedDynamicPartitioning = false;
  let temperatureReset: string | undefined;
  if (rootFlagOf(xml, 'directUpdate')) {
    if (rootFlagOf(xml, 'dynamicPartitions')) {
      xml = clearPartitioning(xml);
      removedDynamicPartitioning = true;
    }
    xml = setRootAttrIfPresent(xml, 'exceptionalUpdate', 'false');
  } else {
    if (rootFlagOf(xml, 'cubeDeltaOnly') || !rootFlagOf(xml, 'activateData')) {
      removedKeyFields.push(...keyFieldsOf(xml));
      xml = xml.replace(/[ \t]*<keyElement>[^<]*<\/keyElement>\n?/g, '');
    }
    if (isWriteOptimized(xml)) {
      if (partitionFieldOf(xml) !== undefined || rootFlagOf(xml, 'dynamicPartitions')) {
        xml = clearPartitioning(xml);
        removedPartitions = true;
      }
      const schema = rootAttrOf(xml, 'temperatureSchema');
      if (schema !== undefined && /[CP]/.test(schema)) {
        temperatureReset = schema.includes('H') && schema.includes('W') ? 'HWO' : schema.includes('W') ? 'WO' : 'HO';
        xml = setRootAttr(xml, 'temperatureSchema', temperatureReset);
      }
      xml = setRootAttrIfPresent(xml, 'exceptionalUpdate', 'false');
    }
  }

  // 5. SID modes the new type no longer allows
  let adjustedSid: Array<{ field: string; from: string; to: string }> = [];
  if (typeChanges || settings.planningMode !== undefined) {
    const reader = createClientFromEnv();
    const adjusted = await adjustSidModes(xml, (el) => readInfoObjectFacts(reader, el.infoObjectName!));
    xml = adjusted.xml;
    adjustedSid = adjusted.adjusted;
  }

  // 6. Update label in the aDSO's own <endUserTexts label="..."/>: the one before
  // <tlogoProperties>. The server serves the texts of the logon language; an aDSO without a text
  // in that language has no such element, and the first <endUserTexts> of the document is then
  // the one of the first field — replacing it, as this tool used to, never reached the aDSO.
  if (settings.label !== undefined) {
    const endUserTextsTag = `<endUserTexts label="${escapeXmlAttr(settings.label)}"/>`;
    const at = xml.indexOf('<tlogoProperties');
    const head = at >= 0 ? xml.slice(0, at) : '';
    if (at >= 0 && /<endUserTexts[^>]*\/>/.test(head)) {
      xml = head.replace(/<endUserTexts[^>]*\/>/, endUserTextsTag) + xml.slice(at);
    } else if (at >= 0) {
      xml = head + endUserTextsTag + xml.slice(at);
    }
  }

  // 7. Lock → PUT
  const lockHandle = await client.lock('adso', adsoName);
  try {
    await client.put('adso', adsoName, lockHandle, xml, timestamp, settings.transport);
  } catch (err) {
    await client.unlock('adso', adsoName).catch(() => {/* ignore */});
    throw err;
  }

  const dropped = [
    removedKeyFields.length ? `the key definition (${removedKeyFields.join(', ')})` : '',
    removedPartitions ? 'the partitioning' : '',
    removedDynamicPartitioning ? 'the dynamic partitioning' : '',
    temperatureReset ? `data tiering per partition (now "${temperatureReset}")` : '',
  ].filter(Boolean).join(', ');
  // A type with an active table and a key of its own does not activate without one.
  const needsKey =
    rootFlagOf(xml, 'activateData') && !rootFlagOf(xml, 'cubeDeltaOnly') && keyFieldsOf(xml).length === 0 &&
    adsoElements(xml).length > 0;
  return JSON.stringify({
    success: true,
    message:
      `aDSO ${adsoUpper} settings updated. Call bw_activate to activate.` +
      (dropped ? ` The new type cannot carry ${dropped}, which was removed as the modeling tools do.` : '') +
      (needsKey ? ' This type needs a key definition before it activates: set it with action "manage_keys".' : '') +
      (adjustedSid.length
        ? ` SID determination set to "S" for ${adjustedSid.map((a) => a.field).join(', ')}: the new type needs SIDs at load time.`
        : ''),
    lock_handle: lockHandle,
    adso_name: adsoUpper,
    object_type: 'adso',
    applied: settings,
    adso_type: adsoTypeCandidates(rootTagOf(xml))[0],
    type_flags: Object.fromEntries(TYPE_FLAGS.map((f) => [f, rootFlagOf(xml, f)])),
    ...(removedKeyFields.length ? { removed_key_fields: removedKeyFields } : {}),
    ...(removedPartitions || removedDynamicPartitioning ? { removed_partitioning: true } : {}),
    ...(temperatureReset ? { temperature_schema: temperatureReset } : {}),
    ...(adjustedSid.length ? { adjusted_sid_modes: adjustedSid } : {}),
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
  const result = await freshRead(path, adsoAccept());
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';
  const ts = result.headers['timestamp'] ?? '';
  const rawOutput = `aDSO: ${adsoName.toUpperCase()}\nStatus: ${status}\nTimestamp: ${ts}\n\n${result.body}`;
  if (format === 'raw') return rawOutput;
  const planningEnabled = /<adso:dataStore\b[^>]*\bplanningMode="true"/.test(result.body);
  const runtimeMode = planningEnabled ? await readPlanningMode(adsoName) : undefined;
  return summarizeAdso(adsoName.toUpperCase(), status, result.body, runtimeMode);
}

function summarizeAdso(
  adsoName: string,
  status: string,
  xml: string,
  runtimeMode?: PlanningMode,
): string {
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
  const infoArea = stripInfoAreaSentinel(xml.match(/<infoArea>([^<]*)<\/infoArea>/)?.[1] ?? '');
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
  lines.push(`InfoArea:    ${infoArea || '(none)'}`);
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
  if (runtimeMode) {
    const label = runtimeMode === 'planning' ? 'Planung' : 'Laden';
    lines.push(`Aktueller Modus:                    ${label} (${runtimeMode})`);
  }
  lines.push(`Bestand aktiviert:                  ${flag('isNcum')}`);

  // ── Section 3: Modelling Type ─────────────────────────────────────────────
  const writeChangelog   = boolAttr('writeChangelog');
  const snapShotScenario = boolAttr('snapShotScenario');
  const uniqueDataRecords = boolAttr('uniqueDataRecords');

  lines.push('');
  lines.push('── Modelling Type ──');
  lines.push(adsoTypeLabel(adsoTypeCandidates(rootTagStr)));
  if (writeChangelog)    lines.push('  Change Log schreiben: yes');
  if (snapShotScenario)  lines.push('  Snapshot-Unterstützung: yes');
  if (uniqueDataRecords) lines.push('  Eindeutige Datensätze: yes');

  // ── Section 4: Data Tiering ───────────────────────────────────────────────
  const tempMap: Record<string, string> = {
    HO:   'Hot',
    HWO:  'Hot, Warm',
    HWP:  'Hot, Warm (per partition)',
    HWCP: 'Hot, Warm, Cold',
    HCP:  'Hot, Cold',
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

  // ── Section 5b: Partitioning ──────────────────────────────────────────────
  const partitionField = partitionFieldOf(xml);
  if (partitionField !== undefined) {
    const attr = (s: string, key: string) => s.match(new RegExp(`\\b${key}="([^"]*)"`))?.[1] ?? '';
    lines.push('');
    lines.push('── Partitioning ──');
    if (boolAttr('dynamicPartitions')) {
      lines.push(`Dynamic on ${partitionField}, granularity ${strAttr('dynamicPartitionGranularity') || '(default)'}`);
    } else {
      lines.push(`Field: ${partitionField}`);
      for (const m of xml.matchAll(/<partitioningCriteria\b[^>]*>/gi)) {
        const temperature = attr(m[0], 'temperature');
        lines.push(
          `  P${attr(m[0], 'partitionNumber')}: ${attr(m[0], 'rangeLow').trim()} – ${attr(m[0], 'rangeHigh').trim()}` +
          (temperature ? ` (${temperature})` : ''),
        );
      }
    }
  }

  // ── Section 6: Fields table ───────────────────────────────────────────────
  interface FieldRow {
    name: string; type: string; length: string; agg: string;
    dim: string; dimRaw: string; isKey: boolean; keyOrder: number; label: string; sid: string;
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

    const sid = getAttr(openAttrs, 'infoObjectName') ? getAttr(openAttrs, 'sidDeterminationMode') : '';
    fields.push({ name: fieldName, type: fieldType, length: lengthDisp, agg, dim, dimRaw, isKey, keyOrder, label, sid });
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

  const headers = ['NAME', 'TYPE', 'LENGTH', 'AGG', 'DIM', 'KEY', 'SID', 'LABEL'];
  const cols = fields.map(f => [f.name, f.type, f.length, f.agg, f.dim, f.isKey ? 'yes' : 'no', f.sid, f.label]);
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
 * The field groups ("Feldgruppen") an aDSO declares, as group name → the exact value an
 * element's `dimension` attribute must carry to join that group.
 *
 * A group is declared by a `<dimension name="X"/>` block; a field joins it through
 * `dimension="#///X\u00a7"` on its `<element>`. That value ends in a SECTION SIGN, which is
 * why it is never built from caller input: where the aDSO already has a field in the group,
 * its attribute is copied verbatim, and only otherwise is the canonical form composed.
 * A field with no `dimension` attribute at all sits in the catch-all group.
 */
export function adsoFieldGroups(adsoXml: string): Map<string, string> {
  const groups = new Map<string, string>();
  for (const m of adsoXml.matchAll(/<dimension\b[^>]*\bname="([^"]+)"/g)) {
    groups.set(m[1], `#///${m[1]}\u00a7`);
  }
  // Prefer a value the document itself uses — it is authoritative about the terminator.
  for (const m of adsoXml.matchAll(/<element\b[^>]*\bdimension="([^"]+)"/g)) {
    const value = m[1];
    const name = value.replace(/^#\/\/\//, '').replace(/\u00a7$/, '');
    if (name) groups.set(name, value);
  }
  return groups;
}

/**
 * Translate a caller-supplied group name into the attribute value for this aDSO.
 *
 * Accepts the bare name ("__KEYFIGURES"), and tolerates the decorated form should a caller
 * paste one straight out of the XML. An undeclared group is an error rather than a silent
 * fall back to the catch-all: the field would land somewhere the caller did not ask for and
 * the save would still report success.
 */
export function resolveFieldGroup(adsoXml: string, requested: string, adsoUpper: string): string {
  const name = requested.trim().replace(/^#\/\/\//, '').replace(/\u00a7$/, '').toUpperCase();
  if (!name) throw new Error('dimension must be a field group name, e.g. "__KEYFIGURES".');
  const groups = adsoFieldGroups(adsoXml);
  const value = groups.get(name);
  if (value) return value;
  const known = [...groups.keys()].sort();
  throw new Error(
    `aDSO ${adsoUpper} has no field group "${name}". ` +
    (known.length
      ? `Declared groups: ${known.join(', ')}.`
      : 'It declares no field groups at all — every field sits in the catch-all group.'),
  );
}

/**
 * Build the <element> XML snippet to inject into an aDSO.
 * Based on the recorded PUT payload pattern from adso_workflow.md Block 3b.
 */
function buildAdsoElement(
  iObjName: string,
  props: ReturnType<typeof parseInfoObjectProps>,
  dimension = '#///ALL§',
  sidMode: SidMode = 'S',
  unitCurrencyField?: string,
): string {
  const { conversionRoutine, label, dataType, length } = props;
  const name = iObjName.toUpperCase();
  const convAttr = conversionRoutine ? ` conversionRoutine="${conversionRoutine}"` : '';
  const unitRef = unitCurrencyField ? `\n    <unitCurrencyElement>#///${unitCurrencyField}</unitCurrencyElement>` : '';
  return `  <element xsi:type="adso:AdsoElement" name="${name}" keep="false"
    aggregationBehavior="NONE" infoObjectName="${name}"${convAttr}
    dimension="${dimension}" sidDeterminationMode="${sidMode}">
    <endUserTexts label="${label.replace(/"/g, '&quot;')}"/>
    <inlineType name="${dataType}" length="${length}" globalElementName="${name}"/>${unitRef}
    <associationType>1</associationType>
  </element>`;
}

/**
 * Remove an <element> block from aDSO XML. The server removes the field when the PUT body no
 * longer contains it; what else points at the field is cleaned up by removeFieldReferences.
 */
function removeElement(adsoXml: string, iObjName: string): string {
  const name = iObjName.toUpperCase();

  // Remove the full <element ... name="NAME" ...>...</element> block
  const elementRegex = new RegExp(
    `[ \\t]*<element\\b[^>]*\\bname="${name}"[^>]*>[\\s\\S]*?<\\/element>\\n?`,
    'g'
  );
  return adsoXml.replace(elementRegex, '');
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
  const adsoResult = await freshRead(adsoPath, adsoAccept());
  const timestamp = adsoResult.headers['timestamp'] ?? adsoResult.headers['TIMESTAMP'];
  let xml = adsoResult.body;

  // 2. Validate against the rules of the key dialog before anything is written: the server
  // stores a key entry for a field that does not exist and reports the rest only at activation.
  const requested = [...new Set(keyFields.map((f) => f.trim().toUpperCase()).filter(Boolean))];
  const elements = new Map(adsoElements(xml).map((el) => [el.name, el]));
  if (requested.length > 0 && !canCarryKeys(xml)) {
    const type = adsoTypeCandidates(rootTagOf(xml))[0];
    throw new Error(
      `aDSO ${adsoUpper} is of type "${type}" and has no key definition: ` +
      (rootFlagOf(xml, 'cubeDeltaOnly')
        ? 'a data mart treats every characteristic as key.'
        : 'an aDSO without active data has no active table to key.') +
      ' Change the type with action "update_settings" first.',
    );
  }
  const missing = requested.filter((f) => !elements.has(f));
  if (missing.length > 0) {
    throw new Error(`aDSO ${adsoUpper} has no field ${missing.join(', ')}. Fields: ${[...elements.keys()].join(', ') || '(none)'}.`);
  }
  const refused = requested
    .map((f) => [f, keyObstacle(elements.get(f)!)] as const)
    .filter(([, why]) => why !== undefined);
  if (refused.length > 0) {
    throw new Error(`Not allowed as key field: ${refused.map(([f, why]) => `${f} (${why})`).join('; ')}.`);
  }
  // A compounded characteristic brings its compounding parents into the key, right behind it.
  const normalized: string[] = [];
  const addedParents: string[] = [];
  for (const field of requested) {
    if (!normalized.includes(field)) normalized.push(field);
    for (const parent of elements.get(field)!.compoundParents) {
      if (normalized.includes(parent) || !elements.has(parent)) continue;
      normalized.splice(normalized.indexOf(field) + 1, 0, parent);
      if (!requested.includes(parent)) addedParents.push(parent);
    }
  }
  if (normalized.length > MAX_KEY_FIELDS) {
    throw new Error(`A key holds at most ${MAX_KEY_FIELDS} fields; ${normalized.length} were requested.`);
  }

  // 3. Strip all existing <keyElement> entries (with any leading whitespace + trailing newline)
  xml = xml.replace(/[ \t]*<keyElement>[^<]*<\/keyElement>\n?/g, '');

  // The partitioning lives on a key field (on any field in a data mart) and goes with it.
  const partitionField = partitionFieldOf(xml);
  const removedPartitioning =
    partitionField !== undefined && !rootFlagOf(xml, 'cubeDeltaOnly') && !normalized.includes(partitionField);
  if (removedPartitioning) xml = clearPartitioning(xml);
  // Validity fields of a non-cumulative aDSO are key fields.
  const removedValidity: string[] = [];
  for (const m of [...xml.matchAll(/<validityElements>([^<]*)<\/validityElements>/g)]) {
    const field = refName(m[1]);
    if (normalized.includes(field)) continue;
    xml = xml.replace(new RegExp(`[ \\t]*<validityElements>\\s*#\\/\\/\\/${field}\\s*<\\/validityElements>\\n?`), '');
    removedValidity.push(field);
  }

  // 4. Build new <keyElement> block
  if (normalized.length > 0) {
    const keyBlock = normalized.map((f) => `  <keyElement>#///${f}</keyElement>`).join('\n') + '\n';
    // Insert before <tlogoProperties>; fall back to before </adso:dataStore>
    if (xml.includes('<tlogoProperties')) {
      xml = xml.replace('<tlogoProperties', keyBlock + '  <tlogoProperties');
    } else {
      xml = xml.replace('</adso:dataStore>', keyBlock + '</adso:dataStore>');
    }
  }

  // 5. Lock → PUT
  const lockHandle = await client.lock('adso', adsoName);
  try {
    await client.put('adso', adsoName, lockHandle, xml, timestamp, transport);
  } catch (err) {
    await client.unlock('adso', adsoName).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message:
      `aDSO ${adsoUpper} key fields updated. Call bw_activate to activate.` +
      (addedParents.length
        ? ` Added ${addedParents.join(', ')} to the key: a compounded characteristic in the key needs its compounding parents there too.`
        : '') +
      (removedPartitioning
        ? ` The partitioning on ${partitionField} was removed, because the field is no longer part of the key.`
        : '') +
      (removedValidity.length ? ` Removed ${removedValidity.join(', ')} from the validity fields.` : ''),
    lock_handle: lockHandle,
    adso_name: adsoUpper,
    object_type: 'adso',
    key_fields: normalized,
    ...(addedParents.length ? { added_compound_parents: addedParents } : {}),
    ...(removedPartitioning ? { removed_partitioning: true } : {}),
  });
}

export interface PartitionSpec {
  /** Field the partitions are defined on. Omit together with ranges to remove the partitioning. */
  field?: string;
  /** Static range partitions in order; each is a lower and an upper bound in internal format. */
  ranges?: Array<{ low: string; high: string }>;
  /** Let the server create partitions as data arrives (time characteristic or date field). */
  dynamic?: boolean;
  /** Granularity of dynamic partitions, as a time characteristic name. */
  granularity?: string;
  transport?: string;
}

/** Granularities the modeling tools offer per partitioning field; the first one's default is preselected. */
const DYNAMIC_GRANULARITIES: Record<string, string[]> = {
  '0CALDAY': ['0CALDAY', '0CALWEEK', '0CALMONTH', '0CALQUARTER', '0CALYEAR', '0FISCPER', '0FISCYEAR', '0FISCWEEK', '0FISCQRT'],
  '0CALWEEK': ['0CALWEEK'],
  '0CALMONTH': ['0CALMONTH', '0CALQUARTER', '0CALYEAR'],
  '0CALQUARTER': ['0CALQUARTER', '0CALYEAR'],
  '0CALYEAR': ['0CALYEAR'],
  '0FISCPER': ['0FISCPER', '0FISCYEAR'],
  '0FISCYEAR': ['0FISCYEAR'],
  '0FISCWEEK': ['0FISCWEEK'],
  '0FISCQRT': ['0FISCQRT', '0FISCYEAR'],
};
DYNAMIC_GRANULARITIES['0DATE'] = DYNAMIC_GRANULARITIES['0CALDAY'];

const DEFAULT_GRANULARITY: Record<string, string> = {
  '0CALDAY': '0CALYEAR', '0CALWEEK': '0CALWEEK', '0CALMONTH': '0CALYEAR', '0CALQUARTER': '0CALYEAR', '0CALYEAR': '0CALYEAR',
  '0FISCPER': '0FISCYEAR', '0FISCYEAR': '0FISCYEAR', '0FISCWEEK': '0FISCWEEK', '0FISCQRT': '0FISCYEAR',
};

function dynamicGranularities(el: AdsoElementInfo, elementXml: string): string[] {
  if (el.infoObjectName) {
    const base = elementXml.match(/\bbaseInfoObjectName="([^"]+)"/)?.[1];
    return DYNAMIC_GRANULARITIES[el.infoObjectName] ?? (base ? DYNAMIC_GRANULARITIES[base] : undefined) ?? [];
  }
  return el.dataType === 'DATS' || el.dataType === 'DATN' ? DYNAMIC_GRANULARITIES['0CALDAY'] : [];
}

const VALUE_CONVERSION_PATH = '/sap/bw/modeling/is/values/valueInputConversion';

/**
 * Turn partition bounds from the internal format into the external one and have the server
 * check them. The aDSO document carries the bounds as the logon user would type them (a date
 * in the user's date format, a value after its conversion exit) and the server derives the
 * internal values from that; a bound sent in internal format where the two differ is refused
 * on save without a reason. The modeling tools go through the same service, which also
 * rejects overlapping ranges — a partition is the right-open interval [low, high).
 *
 * Returns undefined on a release without the service; the bounds are then written as given.
 */
async function convertPartitionBounds(
  client: BwClient,
  el: AdsoElementInfo,
  inline: string,
  ranges: Array<{ low: string; high: string }>,
): Promise<Array<{ low: string; high: string }> | undefined> {
  // A classic release offers the service without publishing a media type for it.
  const mediaType = MEDIA_TYPES['valueinputconversion'] ?? 'application/vnd.sap.bw.modeling.val_inp_conv-v1_0_0+xml';
  const attr = (key: string) => inline.match(new RegExp(`\\b${key}="([^"]*)"`))?.[1];
  const element = el.infoObjectName
    ? `<element name="${el.name}" infoObjectName="${el.infoObjectName}"/>`
    : `<element name="${el.name}" type="${el.dataType}"` +
      (el.conversionRoutine ? ` conversionRoutine="${el.conversionRoutine}"` : '') +
      ['length', 'precision', 'scale'].map((k) => (attr(k) !== undefined ? ` ${k}="${attr(k)}"` : '')).join('') + '/>';
  const decode = (s: string) =>
    s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  let format = 'Bounds are values in internal format (a date as YYYYMMDD)';
  const refuse = (why: string): never => {
    throw new Error(
      `The partition bounds of ${el.name} were refused: ${why} ` +
      `${format}; a partition covers [low, high), so the next one starts at the previous upper bound.`,
    );
  };
  // direction 2 = internal → external, 1 = external → internal (with the range checks)
  const call = async (direction: 1 | 2, values: Array<{ low: string; high: string }>): Promise<string | undefined> => {
    const key = direction === 2 ? 'valueInt' : 'value';
    const body =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<vic:valueInputConversion xmlns:vic="http://www.sap.com/bw/modeling/ValueInputConversion.ecore"' +
      ` checkOverlap="2"${direction === 1 ? ' checkFromTo="true"' : ''} conversionDirection="${direction}">` + element +
      values.map((r) =>
        `<range operator="BT"><fromValue ${key}="${escapeXmlAttr(r.low)}"/>` +
        `<toValue ${key}="${escapeXmlAttr(r.high)}"/></range>`).join('') +
      '</vic:valueInputConversion>';
    try {
      const token = await client.getCsrfToken();
      const response = (await client.rawPost(VALUE_CONVERSION_PATH, body, {
        'Content-Type': mediaType, Accept: mediaType, 'x-csrf-token': token,
      })).body;
      return /<vic:valueInputConversion\b/.test(response) ? response : undefined;
    } catch {
      return undefined;
    }
  };
  const errorsOf = (response: string): string[] => [...new Set(
    [...response.matchAll(/<message\b[^>]*>/g)]
      .filter((m) => /\bmessageType="Error"/.test(m[0]))
      .map((m) => decode(m[0].match(/\btext="([^"]*)"/)?.[1] ?? '')),
  )];
  const rangesOf = (response: string, key: 'value' | 'valueInt') =>
    [...response.matchAll(/<range\b[^>]*>([\s\S]*?)<\/range>/g)].map((m) => ({
      low: decode(m[1].match(new RegExp(`<fromValue\\b[^>]*\\b${key}="([^"]*)"`))?.[1] ?? ''),
      high: decode(m[1].match(new RegExp(`<toValue\\b[^>]*\\b${key}="([^"]*)"`))?.[1] ?? ''),
    }));

  const given = ranges.map((r) => ({ low: String(r.low).trim(), high: String(r.high).trim() }));
  const toExternal = await call(2, given);
  if (toExternal === undefined) return undefined;
  const external = rangesOf(toExternal, 'value');
  if (external.length !== given.length) return undefined;
  // A classic release converts in one direction only, from the external format: there the
  // bounds are taken as typed in the modeling tools and only checked.
  // It answers the other direction with an empty or initial external value and does not echo
  // the internal one, which is what tells the two apart.
  const echoed = rangesOf(toExternal, 'valueInt');
  if (external.some((r) => r.low === '' || r.high === '') || echoed.some((r) => r.low === '' || r.high === '')) {
    format = 'This release takes the bounds in external format, as they are typed in the modeling tools (a date in the date format of the logon user)';
    const checked = await call(1, given);
    if (checked === undefined) return undefined;
    if (errorsOf(checked).length > 0) refuse(errorsOf(checked).join(' '));
    return given;
  }
  if (errorsOf(toExternal).length > 0) refuse(errorsOf(toExternal).join(' '));

  // The conversion to the external format takes whatever it is handed; what the server makes
  // of the result is the test, and it brings the range checks with it.
  const backToInternal = await call(1, external);
  if (backToInternal === undefined) return external;
  if (errorsOf(backToInternal).length > 0) refuse(errorsOf(backToInternal).join(' '));
  const internal = rangesOf(backToInternal, 'valueInt');
  const unreadable = given.flatMap((r, i) => [
    (internal[i]?.low ?? '').trim() !== '' ? undefined : r.low,
    (internal[i]?.high ?? '').trim() !== '' ? undefined : r.high,
  ]).filter((v): v is string => v !== undefined);
  if (unreadable.length > 0) {
    refuse(`the server does not read ${unreadable.join(', ')} as a value of data type ${el.dataType}.`);
  }
  return external;
}
/**
 * bw_update_adso action "manage_partitions" — replace the partitioning of the active table.
 *
 * All partitions sit on one field: a key field, or any characteristic field in a data mart.
 * Static partitioning is a list of ranges, numbered in the order given and passed in internal
 * format. Dynamic partitioning is one open partition plus a granularity.
 * An empty specification removes the partitioning.
 */
export async function bwUpdateAdsoPartitions(
  client: BwClient,
  adsoName: string,
  spec: PartitionSpec,
): Promise<string> {
  const adsoUpper = adsoName.toUpperCase();
  const adsoResult = await freshRead(`/sap/bw/modeling/adso/${bwSeg(adsoName)}/m`, adsoAccept());
  const timestamp = adsoResult.headers['timestamp'] ?? adsoResult.headers['TIMESTAMP'];
  let xml = adsoResult.body;

  let ranges = spec.ranges ?? [];
  const partitionCount = ranges.length;
  const field = spec.field?.trim().toUpperCase();
  const remove = !spec.dynamic && ranges.length === 0;
  let granularity: string | undefined;

  if (!remove) {
    if (!field) throw new Error('partitioning.field is required: the field the partitions are defined on.');
    if (spec.dynamic && ranges.length > 0) {
      throw new Error('Pass either ranges (static partitioning) or dynamic: true, not both.');
    }
    if (isWriteOptimized(xml)) {
      throw new Error(
        `aDSO ${adsoUpper} is of type "staging_inbound_only" and has no active table to partition. ` +
        'Change the type with action "update_settings" first.',
      );
    }
    const el = adsoElements(xml).find((e) => e.name === field);
    if (!el) throw new Error(`aDSO ${adsoUpper} has no field ${field}.`);
    const obstacle = keyObstacle(el);
    if (obstacle) throw new Error(`${field} cannot carry the partitioning: ${obstacle}.`);
    const cube = rootFlagOf(xml, 'cubeDeltaOnly');
    if (!cube && !keyFieldsOf(xml).includes(field)) {
      throw new Error(
        `${field} is not a key field of aDSO ${adsoUpper}; the partitioning field must be part of the key ` +
        `(key: ${keyFieldsOf(xml).join(', ') || 'none'}). Add it with action "manage_keys" first.`,
      );
    }
    if (spec.dynamic) {
      if (rootFlagOf(xml, 'directUpdate')) {
        throw new Error('Dynamic partitioning is not available for an aDSO with direct update; pass ranges instead.');
      }
      if (!(await readAdsoConfiguration(adsoName))['dynamicPartitioning']) {
        throw new Error('This system does not offer dynamic partitioning for the aDSO; pass ranges instead.');
      }
      const elementXml = xml.match(new RegExp(`<element\\b[^>]*\\bname="${field}"[^>]*>`))?.[0] ?? '';
      const offered = dynamicGranularities(el, elementXml);
      if (offered.length === 0) {
        throw new Error(
          `${field} cannot carry dynamic partitioning: it needs a time characteristic (calendar or fiscal) ` +
          'or a field of type DATS. Pass ranges for static partitioning instead.',
        );
      }
      granularity = spec.granularity?.trim().toUpperCase() ?? DEFAULT_GRANULARITY[offered[0]];
      if (!offered.includes(granularity)) {
        throw new Error(`Granularity "${granularity}" is not offered for ${field}. Offered: ${offered.join(', ')}.`);
      }
    } else {
      ranges.forEach((r, i) => {
        if (r.low === undefined || r.high === undefined || String(r.low) === '' || String(r.high) === '') {
          throw new Error(`Partition ${i + 1} needs both a lower and an upper bound.`);
        }
      });
      const inline = xml.match(new RegExp(`<element\\b[^>]*\\bname="${field}"[^>]*>[\\s\\S]*?<inlineType\\b[^>]*`))?.[0]
        .match(/<inlineType\b[^>]*$/)?.[0] ?? '';
      ranges = (await convertPartitionBounds(client, el, inline, ranges)) ?? ranges;
    }
  }

  const hadPartitioning = partitionFieldOf(xml) !== undefined || rootFlagOf(xml, 'dynamicPartitions');
  if (remove && !hadPartitioning) {
    return JSON.stringify({ success: false, message: `aDSO ${adsoUpper} is not partitioned. No changes made.` });
  }
  xml = clearPartitioning(xml);
  if (!remove) {
    const criteria = spec.dynamic
      ? [`  <partitioningCriteria field="#///${field}" partitionNumber="1" rangeLow="" rangeHigh=""/>`]
      : ranges.map((r, i) =>
          `  <partitioningCriteria field="#///${field}" partitionNumber="${i + 1}"` +
          ` rangeLow="${escapeXmlAttr(String(r.low))}" rangeHigh="${escapeXmlAttr(String(r.high))}"/>`);
    xml = xml.replace('</adso:dataStore>', `${criteria.join('\n')}\n</adso:dataStore>`);
    if (spec.dynamic) {
      xml = setRootAttr(xml, 'dynamicPartitions', 'true');
      xml = setRootAttr(xml, 'dynamicPartitionGranularity', granularity!);
    }
  }

  const lockHandle = await client.lock('adso', adsoName);
  try {
    await client.put('adso', adsoName, lockHandle, xml, timestamp, spec.transport);
  } catch (err) {
    await client.unlock('adso', adsoName).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message: remove
      ? `Partitioning removed from aDSO ${adsoUpper}. Call bw_activate to activate.`
      : spec.dynamic
        ? `aDSO ${adsoUpper} is partitioned dynamically on ${field} (granularity ${granularity}). Call bw_activate to activate.`
        : `aDSO ${adsoUpper} has ${partitionCount} partition(s) on ${field}. Call bw_activate to activate.`,
    lock_handle: lockHandle,
    adso_name: adsoUpper,
    object_type: 'adso',
    ...(remove ? {} : { partition_field: field, partitions: spec.dynamic ? 'dynamic' : partitionCount }),
    ...(granularity ? { granularity } : {}),
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
  /** Field group to move the field into; must be one the aDSO declares. */
  dimension?: string;
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
  const adsoResult = await freshRead(adsoPath, adsoAccept());
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
  const info = adsoElements(fullXml).find((el) => el.name === nameUpper);
  const notes: string[] = [];

  if (properties.dimension !== undefined) {
    replaceAttr('dimension', resolveFieldGroup(fullXml, properties.dimension, adsoUpper));
  }

  if (properties.sidDeterminationMode !== undefined) {
    if (!isInfoObject) {
      throw new Error(`${nameUpper} is a plain field; SID determination applies to InfoObject fields only.`);
    }
    // The modes offered depend on the InfoObject and on the aDSO type; a mode outside the
    // list is accepted on save and fails the activation.
    const facts = await readInfoObjectFacts(createClientFromEnv(), info?.infoObjectName ?? nameUpper);
    const allowed = allowedSidModes(
      { ...facts, objectType: info?.objectType ?? facts.objectType, compounded: (info?.compoundParents.length ?? 0) > 0 || facts.compounded },
      sidContextOf(fullXml),
    );
    if (allowed.length > 0 && !allowed.includes(properties.sidDeterminationMode)) {
      throw new Error(
        `sid_determination_mode "${properties.sidDeterminationMode}" is not offered for ${nameUpper} ` +
        `in aDSO ${adsoUpper}. Offered: ${allowed.join(', ')}.`,
      );
    }
    replaceAttr('sidDeterminationMode', properties.sidDeterminationMode);
    // Compounding: a child either materializes its SIDs or determines them no earlier than its parent.
    const rank: Record<string, number> = { N: 0, R: 1, S: 2, M: 3 };
    const others = adsoElements(fullXml);
    const mode = properties.sidDeterminationMode;
    const clashes = [
      ...others.filter((el) => info?.compoundParents.includes(el.name) && mode !== 'M' && rank[mode] > rank[el.sidMode ?? 'N']),
      ...others.filter((el) => el.compoundParents.includes(nameUpper) && el.sidMode !== 'M' && rank[el.sidMode ?? 'N'] > rank[mode]),
    ].map((el) => `${el.name} (${el.sidMode})`);
    if (clashes.length) {
      notes.push(`SID determination "${mode}" does not fit the compounded fields ${clashes.join(', ')}: a compounded field needs "M" or a mode no higher than its compounding parent.`);
    }
  }

  if (properties.aggregationBehavior !== undefined) {
    const aggregates = properties.aggregationBehavior !== 'NONE';
    if (aggregates && keyFieldsOf(fullXml).includes(nameUpper)) {
      throw new Error(
        `${nameUpper} is a key field of aDSO ${adsoUpper}; a key field cannot aggregate. ` +
        'Take it out of the key with action "manage_keys" first.',
      );
    }
    if (aggregates && partitionFieldOf(fullXml) === nameUpper) {
      throw new Error(
        `${nameUpper} carries the partitioning of aDSO ${adsoUpper}; the partitioning field cannot aggregate. ` +
        'Remove the partitioning with action "manage_partitions" first.',
      );
    }
    replaceAttr('aggregationBehavior', properties.aggregationBehavior);
    // An aggregating field has no conversion routine.
    if (aggregates && !isInfoObject && /\bconversionRoutine="[^"]+"/.test(elem.slice(0, elem.indexOf('>')))) {
      const routine = elem.match(/\bconversionRoutine="([^"]*)"/)?.[1];
      elem = elem.replace(/\s+conversionRoutine="[^"]*"/, '');
      notes.push(`Conversion routine ${routine} removed: an aggregating field has none.`);
    }
  }

  if (properties.localDescription !== undefined) {
    const desc = properties.localDescription === null
      ? '<descriptions/>'
      : `<descriptions label="${escapeXmlAttr(properties.localDescription)}"/>`;
    replaceDescriptions(desc);
  }

  if (properties.description !== undefined) {
    replaceDescriptions(`<descriptions label="${escapeXmlAttr(properties.description)}"/>`);
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
    message:
      `Field ${nameUpper} in aDSO ${adsoUpper} updated. Call bw_activate to activate.` +
      (notes.length ? ` ${notes.join(' ')}` : ''),
    ...(notes.length ? { warnings: notes } : {}),
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
  /** Field group to place the field in; must be one the aDSO declares. */
  dimension?: string;
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

function buildPureFieldElement(field: FieldDef, dimension = '#///GROUP1§'): string {
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
    `    dimension="${dimension}" sidDeterminationMode="N">\n` +
    `    <inlineType ${inlineAttrs.join(' ')}/>\n` +
    `    <localProperties xsi:type="${localPropsType}">\n` +
    `      <descriptions label="${escapeXmlAttr(field.label)}"/>\n` +
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
      `  <endUserTexts label="${escapeXmlAttr(label)}"/>\n` +
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
      `  <endUserTexts label="${escapeXmlAttr(label)}"/>\n` +
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

  // Read the type back: the server decides which of the sent flags it keeps.
  const createdRoot =
    (await freshRead(`/sap/bw/modeling/adso/${bwSeg(adsoName)}/m`, adsoAccept())).body
      .match(/<adso:dataStore\b[^>]*>/)?.[0] ?? '';
  const candidates = adsoTypeCandidates(createdRoot);
  const requestedType = action === 'empty' ? (typePresets[adsoType] ? adsoType : 'standard') : undefined;
  const typeMismatch = requestedType !== undefined && !candidates.includes(requestedType);

  const fromTemplate = templateName ? ` from template ${templateName.toUpperCase()}` : '';
  return JSON.stringify({
    success: true,
    message:
      `aDSO ${nameUpper} created${fromTemplate} in package ${pkg}. Call bw_activate to activate.` +
      (typeMismatch
        ? ` WARNING: requested adso_type "${requestedType}", but the server kept the flags of ` +
          `"${candidates[0]}". Set the type with bw_update_adso action "update_settings".`
        : ''),
    adso_name: nameUpper,
    object_type: 'adso',
    adso_type: candidates[0],
    ...(candidates.length > 1 ? { adso_type_alternatives: candidates.slice(1) } : {}),
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

  const adsoResult = await freshRead(adsoPath, adsoAccept());
  const timestamp = adsoResult.headers['timestamp'] ?? adsoResult.headers['TIMESTAMP'];
  let xml = adsoResult.body;

  const elementBlocks: string[] = [];
  const keyElements: string[] = [];
  const processed: string[] = [];
  const skipped: string[] = [];

  // Resolved up front so an unknown group name fails before anything is written.
  const groups = new Map<string, string>();
  for (const field of fields) {
    if (field.dimension === undefined) continue;
    groups.set(field.name, resolveFieldGroup(xml, field.dimension, adsoUpper));
  }

  if (fields.some((f) => f.isKey) && !canCarryKeys(xml)) {
    throw new Error(
      `aDSO ${adsoUpper} is of type "${adsoTypeCandidates(rootTagOf(xml))[0]}" and has no key definition; ` +
      'add the fields without is_key.',
    );
  }

  for (const original of fields) {
    const name = original.name.trim().toUpperCase();
    if (xml.includes(`name="${name}"`)) {
      skipped.push(name);
      continue;
    }
    const apiType = TYPE_NAME_MAP[original.dataType] ?? original.dataType;
    let field = original;
    if (field.isKey) {
      if (TYPES_INVALID_IN_KEY.has(apiType)) {
        throw new Error(`Field ${name}: data type ${field.dataType} is not allowed in a key.`);
      }
      if (apiType === 'NUMC' && (field.length ?? 0) > 69) {
        throw new Error(`Field ${name}: NUMC fields longer than 69 are not allowed in a key.`);
      }
      if (field.aggregationBehavior !== undefined && field.aggregationBehavior !== 'NONE') {
        throw new Error(`Field ${name}: a key field cannot aggregate (${field.aggregationBehavior}); pass aggregation_behavior "NONE" or leave is_key out.`);
      }
      // A numeric type aggregates by default; in the key it must not.
      if (KEYFIGURE_TYPES.has(apiType)) field = { ...field, aggregationBehavior: 'NONE' };
    }
    if (apiType === 'CURR' || apiType === 'QUAN') {
      const decimalPlaces = field.scale ?? field.precision;
      if (decimalPlaces === undefined || decimalPlaces <= 0) {
        throw new Error(
          `Field ${name}: data type ${field.dataType} requires scale > 0 (decimal places). ` +
          `Pass e.g. scale: 2 for currency or scale: 3 for quantity.`
        );
      }
    }
    elementBlocks.push(buildPureFieldElement(field, groups.get(field.name)));
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

  const insertBlock = elementBlocks.join('\n') + '\n';
  if (xml.includes('</tlogoProperties>')) {
    xml = xml.replace('</tlogoProperties>', '</tlogoProperties>\n' + insertBlock);
  } else {
    xml = xml.replace('</adso:dataStore>', insertBlock + '</adso:dataStore>');
  }
  // Key entries go behind the existing ones, never between the field elements: the server
  // refuses a document whose field elements are interrupted by another element.
  if (keyElements.length > 0) {
    const keyBlock = keyElements.join('\n') + '\n';
    const existing = [...xml.matchAll(/<keyElement>[^<]*<\/keyElement>\n?/g)].pop();
    if (existing) {
      const at = existing.index! + existing[0].length;
      xml = xml.slice(0, at) + keyBlock + xml.slice(at);
    } else if (xml.includes('<tlogoProperties')) {
      xml = xml.replace('<tlogoProperties', keyBlock + '  <tlogoProperties');
    } else {
      xml = xml.replace('</adso:dataStore>', keyBlock + '</adso:dataStore>');
    }
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
  transport?: string,
  dimension?: string
): Promise<string> {
  const names = infoObjectName
    .split(',')
    .map((n) => n.trim().toUpperCase())
    .filter(Boolean);
  const adsoUpper = adsoName.toUpperCase();

  // Read current aDSO once (full XML + timestamp)
  const adsoPath = `/sap/bw/modeling/adso/${bwSeg(adsoName)}/m`;
  const adsoResult = await freshRead(adsoPath, adsoAccept());
  const timestamp = adsoResult.headers['timestamp'] ?? adsoResult.headers['TIMESTAMP'];

  let updatedXml = adsoResult.body;
  const processed: string[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];
  const extra: Record<string, unknown> = {};

  if (action === 'remove_field') {
    const present = new Set(adsoElements(updatedXml).map((el) => el.name));
    const toRemove = names.filter((n) => present.has(n));
    skipped.push(...names.filter((n) => !present.has(n)));

    if (toRemove.length === 0) {
      return JSON.stringify({
        success: false,
        message: `None of the fields (${names.join(', ')}) found in aDSO ${adsoUpper}. No changes made.`,
      });
    }

    // A field other fields depend on stays until they are gone: the server answers such a save
    // with an error that names no reason.
    const remaining = adsoElements(updatedXml).filter((el) => !toRemove.includes(el.name));
    const blockers: string[] = [];
    for (const name of toRemove) {
      const children = remaining.filter((el) => el.compoundParents.includes(name)).map((el) => el.name);
      if (children.length) blockers.push(`${name} is the compounding parent of ${children.join(', ')}`);
      const keyFigures = remaining.filter((el) => el.unitCurrencyElement === name).map((el) => el.name);
      if (keyFigures.length) blockers.push(`${name} supplies the unit or currency of ${keyFigures.join(', ')}`);
    }
    if (blockers.length) {
      throw new Error(
        `Cannot remove from aDSO ${adsoUpper}: ${blockers.join('; ')}. ` +
        'Remove the dependent fields in the same call, or first.',
      );
    }

    const cleaned: Record<string, string[]> = {};
    for (const name of toRemove) {
      updatedXml = removeElement(updatedXml, name);
      const refs = removeFieldReferences(updatedXml, name);
      updatedXml = refs.xml;
      if (refs.removed.length) cleaned[name] = refs.removed;
      processed.push(name);
    }
    if (Object.keys(cleaned).length) {
      extra['removed_references'] = cleaned;
      notes.push(
        'Also removed: ' +
        Object.entries(cleaned).map(([field, where]) => `${field} from the ${where.join(', ')}`).join('; ') + '.',
      );
    }
  } else {
    // add_field — read each InfoObject and inject. One fresh reader session for the
    // whole call: an InfoObject created/edited earlier through the shared client
    // could otherwise be served from a stale session buffer.
    // Resolved once against the document as read: a group is a property of the aDSO, and
    // an unknown name must stop the call before any field is injected.
    const group =
      dimension !== undefined ? resolveFieldGroup(updatedXml, dimension, adsoUpper) : undefined;
    const iobjReader = createClientFromEnv();
    const ctx = sidContextOf(updatedXml);
    const inAdso = (name: string) => new RegExp(`<element\\b[^>]*\\bname="${name}"`).test(updatedXml);
    const dependencies: Array<{ field: string; needed_by: string; as: string }> = [];

    // The modeling tools bring along what an InfoObject cannot stand without: the compounding
    // parents of a characteristic and the unit InfoObject of a key figure. The server does
    // not — it refuses the save of a compounded characteristic without its parents.
    const addInfoObject = async (name: string, neededBy?: { field: string; as: string }): Promise<void> => {
      if (inAdso(name)) {
        if (!neededBy) skipped.push(name);
        return;
      }
      const facts = await readInfoObjectFacts(iobjReader, name);
      for (const parent of facts.compoundParents) {
        await addInfoObject(parent, { field: name, as: 'compounding parent' });
      }
      const unit = facts.objectType === 'KYF' ? facts.unitInfoObject : undefined;
      if (unit) await addInfoObject(unit, { field: name, as: 'unit or currency' });
      updatedXml = injectElement(
        updatedXml,
        buildAdsoElement(name, parseInfoObjectProps(facts.xml), group, defaultSidMode(facts, ctx), unit),
      );
      if (neededBy) dependencies.push({ field: name, needed_by: neededBy.field, as: neededBy.as });
      else processed.push(name);
    };
    for (const name of names) await addInfoObject(name);

    if (processed.length === 0) {
      return JSON.stringify({
        success: false,
        message: `All fields (${names.join(', ')}) are already present in aDSO ${adsoUpper}. No changes made.`,
      });
    }
    if (dependencies.length) {
      extra['added_dependencies'] = dependencies;
      notes.push(
        'Also added: ' +
        dependencies.map((d) => `${d.field} (${d.as} of ${d.needed_by})`).join(', ') + '.',
      );
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
    message:
      `${processed.join(', ')} ${verb} aDSO ${adsoUpper}. Call bw_activate to activate.` +
      (notes.length ? ` ${notes.join(' ')}` : ''),
    lock_handle: lockHandle,
    adso_name: adsoUpper,
    object_type: 'adso',
    processed,
    ...extra,
  };
  if (skipped.length > 0) result['skipped'] = skipped;
  return JSON.stringify(result);
}

