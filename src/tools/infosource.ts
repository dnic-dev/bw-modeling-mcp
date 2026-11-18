import { BwClient, MEDIA_TYPES, freshRead, bwSeg, stripInfoAreaSentinel } from '../bw-client.js';
import { InfoObjectFacts, parseInfoObjectFacts } from './infoobject.js';

const TRCS_MEDIA = 'application/vnd.sap.bw.modeling.trcs-v1_0_0+xml';

// ── Document model ────────────────────────────────────────────────────────────

const escapeXmlAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const decodeXml = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

interface TrcsDoc {
  head: string;
  elements: string[];
  keys: string[];
  rest: string;
  tail: string;
}

function splitDoc(xml: string): TrcsDoc {
  const tailAt = xml.indexOf('<tlogoProperties');
  if (tailAt < 0) throw new Error('The InfoSource document has no <tlogoProperties>; it cannot be changed.');
  const body = xml.slice(0, tailAt);
  const firstAt = body.search(/<element\b|<keyElement>/);
  const head = firstAt < 0 ? body : body.slice(0, firstAt);
  const fields = firstAt < 0 ? '' : body.slice(firstAt);
  const elementRe = /<element\b[\s\S]*?<\/element>/g;
  const keyRe = /<keyElement>#\/\/\/([^<]+)<\/keyElement>/g;
  return {
    head,
    elements: fields.match(elementRe) ?? [],
    keys: [...fields.matchAll(keyRe)].map((m) => m[1]),
    rest: fields.replace(elementRe, '').replace(keyRe, '').trim(),
    tail: xml.slice(tailAt),
  };
}

function joinDoc(doc: TrcsDoc): string {
  return doc.head + doc.elements.join('') + doc.keys.map((k) => `<keyElement>#///${k}</keyElement>`).join('') + doc.rest + doc.tail;
}

const openTagOf = (el: string): string => el.match(/^<element\b[^>]*>/)?.[0] ?? '';
const attrOf = (tag: string, name: string): string | undefined => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const inlineTagOf = (el: string): string => el.match(/<inlineType\b[^>]*>/)?.[0] ?? '';
const compoundParentsOf = (el: string): string[] =>
  [...el.matchAll(/<compoundInfoObject>#\/\/\/([^<]+)<\/compoundInfoObject>/g)].map((m) => m[1]);

function withAttr(tag: string, name: string, value: string): string {
  const stripped = tag.replace(new RegExp(`\\s${name}="[^"]*"`), '');
  return stripped.replace(/\s*(\/?>)$/, ` ${name}="${escapeXmlAttr(value)}"$1`);
}

interface ElementFacts {
  name: string;
  infoObject?: string;
  /** CHA, KYF, TIM, UNI, DPA or XXL for an InfoObject field, as far as the document says. */
  objectType?: string;
  dataType: string;
  length?: number;
  precision?: number;
  scale?: number;
  label: string;
  conversionRoutine?: string;
  unitField?: string;
  fixedUnit?: string;
  fixedCurrency?: string;
  aggregation?: string;
}

function factsOfElement(el: string): ElementFacts {
  const open = openTagOf(el);
  const inline = inlineTagOf(el);
  const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));
  return {
    name: attrOf(open, 'name') ?? '',
    infoObject: attrOf(open, 'infoObjectName') || undefined,
    objectType: attrOf(el.match(/<consumptionViewProperties\b[^>]*>/)?.[0] ?? '', 'objectType'),
    dataType: attrOf(inline, 'name') ?? '',
    length: num(attrOf(inline, 'length')),
    precision: num(attrOf(inline, 'precision')),
    scale: num(attrOf(inline, 'scale')),
    label: decodeXml(el.match(/<endUserTexts label="([^"]*)"/)?.[1] ?? el.match(/<descriptions label="([^"]*)"/)?.[1] ?? ''),
    conversionRoutine: attrOf(open, 'conversionRoutine') || undefined,
    unitField: el.match(/<unitCurrencyElement>#\/\/\/([^<]+)<\/unitCurrencyElement>/)?.[1],
    fixedUnit: el.match(/<fixedUnit>([^<]+)<\/fixedUnit>/)?.[1],
    fixedCurrency: el.match(/<fixedCurrency>([^<]+)<\/fixedCurrency>/)?.[1],
    aggregation: attrOf(open, 'aggregationBehavior') || undefined,
  };
}

// ── bwGetInfosource ───────────────────────────────────────────────────────────

/**
 * bw_get_infosource — read the structure of an InfoSource (TRCS).
 *
 * GET /sap/bw/modeling/trcs/{name}/m
 */
export async function bwGetInfosource(client: BwClient, name: string): Promise<string> {
  const nameLower = name.toLowerCase();
  const result = await freshRead(`/sap/bw/modeling/trcs/${bwSeg(nameLower)}/m`, TRCS_MEDIA);
  return formatInfosource(result.body, name);
}

export function formatInfosource(xml: string, name: string): string {
  const doc = splitDoc(xml);
  const root = doc.head.match(/<trcs:infoSource\b[^>]*>/)?.[0] ?? '';

  const tlogoPart = (xml.match(/<tlogoProperties([^>]*)>/) ?? [])[1] ?? '';
  const keys = new Set(doc.keys.map((k) => k.toUpperCase()));
  const ownerType = attrOf(root, 'tlogoOwnedBy');
  const ownerName = attrOf(root, 'objnmOwnedBy');

  const fields = doc.elements.map((el) => {
    const f = factsOfElement(el);
    const field: Record<string, unknown> = {
      name: f.name,
      label: f.label,
      data_type: f.dataType,
      is_key: keys.has(f.name.toUpperCase()),
    };
    if (f.infoObject) field['infoobject_name'] = f.infoObject;
    if (f.objectType) field['infoobject_type'] = f.objectType;
    if (f.length !== undefined) field['length'] = f.length;
    if (f.precision !== undefined) field['precision'] = f.precision;
    if (f.scale !== undefined) field['scale'] = f.scale;
    if (f.conversionRoutine) field['conversion_routine'] = f.conversionRoutine;
    if (f.unitField) field['unit_field'] = f.unitField;
    if (f.fixedUnit) field['fixed_unit'] = f.fixedUnit;
    if (f.fixedCurrency) field['fixed_currency'] = f.fixedCurrency;
    if (f.aggregation) field['aggregation_behavior'] = f.aggregation;
    return field;
  });

  return JSON.stringify({
    name: attrOf(root, 'name') ?? name.toUpperCase(),
    label: decodeXml(doc.head.match(/<endUserTexts label="([^"]*)"/)?.[1] ?? ''),
    description: decodeXml((tlogoPart.match(/adtcore:description="([^"]*)"/) ?? [])[1] ?? ''),
    info_area: stripInfoAreaSentinel((xml.match(/<infoArea>([^<]*)<\/infoArea>/) ?? [])[1] ?? ''),
    // adtcore:version names the version that was read, not the state of the object.
    object_status: xml.match(/<objectStatus>([^<]*)<\/objectStatus>/)?.[1] ?? (tlogoPart.match(/adtcore:version="([^"]*)"/) ?? [])[1] ?? '',
    aggregation: attrOf(root, 'aggregation') === 'true',
    datastore_like: attrOf(root, 'odsoLike') === 'true',
    ...(ownerType || ownerName ? { owned_by: { object_type: ownerType ?? '', object_name: ownerName ?? '' } } : {}),
    fields,
  }, null, 2);
}

// ── bw_create_infosource ──────────────────────────────────────────────────────

/**
 * bw_create_infosource — create a new InfoSource (TRCS) shell.
 *
 * Optionally copies fields from an existing object (aDSO, CompositeProvider,
 * DataSource, InfoObject or another InfoSource) via copyFrom* parameters.
 *
 * Workflow: Lock (CREA) → POST → Unlock
 * After creation the InfoSource is inactive — call bw_activate with object_type "trcs".
 */
export async function bwCreateInfosource(
  client: BwClient,
  name: string,
  description: string,
  infoArea: string,
  pkg: string = '$TMP',
  copyFromObjectName?: string,
  copyFromObjectType?: string,
  copyFromObjectSubType?: string,
  copyFromSourceSystem?: string
): Promise<string> {
  const nameUpper = name.toUpperCase();
  const infoAreaUpper = infoArea.toUpperCase();

  const lockHandle = await client.lock('trcs', name, { 'activity_context': 'CREA' });

  // Build URL — add copyFrom params before lockHandle when provided
  let url = `/sap/bw/modeling/trcs/${bwSeg(name)}`;
  const qs: string[] = [];
  if (copyFromObjectType && copyFromObjectName) {
    let encodedName = copyFromObjectName;
    if (copyFromObjectType === 'RSDS' && copyFromSourceSystem) {
      encodedName = copyFromObjectName.padEnd(30) + copyFromSourceSystem.padEnd(10);
    }
    qs.push(`copyFromObjectName=${encodeURIComponent(encodedName)}`);
    qs.push(`copyFromObjectType=${encodeURIComponent(copyFromObjectType)}`);
    if (copyFromObjectSubType) {
      qs.push(`copyFromObjectSubType=${encodeURIComponent(copyFromObjectSubType)}`);
    }
  }
  qs.push(`lockHandle=${lockHandle}`);
  url += '?' + qs.join('&');

  const language = process.env.BW_LANGUAGE ?? 'DE';
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<trcs:infoSource\n` +
    `  xmlns:adtcore="http://www.sap.com/adt/core"\n` +
    `  xmlns:trcs="http://www.sap.com/bw/modeling/trcs.ecore"\n` +
    `  name="${nameUpper}">\n` +
    `  <endUserTexts label="${escapeXmlAttr(description)}"/>\n` +
    `  <tlogoProperties\n` +
    `    adtcore:language="${language}"\n` +
    `    adtcore:name="${nameUpper}"\n` +
    `    adtcore:type="TRCS"\n` +
    `    adtcore:masterLanguage="${language}">\n` +
    `    <infoArea>${infoAreaUpper}</infoArea>\n` +
    `  </tlogoProperties>\n` +
    `</trcs:infoSource>`;

  try {
    await client.postWithCsrf(url, body, `application/xml, ${TRCS_MEDIA}`, {
      'Development-Class': pkg,
      Accept: TRCS_MEDIA,
    });
  } catch (err) {
    await client.unlock('trcs', name).catch(() => {/* ignore */});
    throw err;
  }
  await client.unlock('trcs', name);

  const fromParts: string[] = [];
  if (copyFromObjectType && copyFromObjectName) {
    fromParts.push(` from ${copyFromObjectType} ${copyFromObjectName.toUpperCase()}`);
    if (copyFromObjectSubType) fromParts.push(` (${copyFromObjectSubType})`);
  }
  return JSON.stringify({
    success: true,
    message: `InfoSource ${nameUpper} created${fromParts.join('')} in package ${pkg}. Call bw_activate to activate.`,
    infosource_name: nameUpper,
    object_type: 'trcs',
  });
}

// ── bw_update_infosource ──────────────────────────────────────────────────────

export interface InfosourceField {
  /** Field name; an InfoObject field is named after its InfoObject. */
  name?: string;
  infoObjectName?: string;
  type?: string;
  length?: number;
  precision?: number;
  scale?: number;
  label?: string;
  isKey?: boolean;
  conversionRoutine?: string;
  /** Field that holds the unit or currency of an amount or quantity field. */
  unitField?: string;
}

export interface InfosourceFieldChange {
  name: string;
  newName?: string;
  label?: string;
  type?: string;
  length?: number;
  precision?: number;
  scale?: number;
  conversionRoutine?: string;
  unitField?: string;
  /** An InfoObject name binds the field to it; an empty string turns it into a plain field. */
  infoObjectName?: string;
}

export interface InfosourceUpdateOptions {
  description?: string;
  aggregation?: boolean;
  datastoreLike?: boolean;
  fields?: InfosourceField[];
  changeFields?: InfosourceFieldChange[];
  removeFields?: string[];
  /** The complete key in key order. */
  keyFields?: string[];
  /** Fields that are to come first, in this order; the others follow in their present order. */
  fieldOrder?: string[];
  transport?: string;
}

const DECIMAL_TYPES = new Set(['DEC', 'CURR', 'QUAN']);
const LENGTH_TYPES = new Set(['CHAR', 'NUMC', 'SSTR', 'RAW']);
const NOT_KEYABLE_TYPES = new Set(['STRG', 'RSTR', 'RAW', 'SSTR', 'D16R', 'D34R', 'CURR', 'QUAN', 'FLTP']);
const RECORD_MODE = '0RECORDMODE';

/** The name rules the field editor applies to a field that is not an InfoObject. */
function assertPlainFieldName(name: string): void {
  if (!/^[A-Z]/.test(name)) throw new Error(`Field name ${name} must start with a letter.`);
  if (!/^[A-Z0-9_]+$/.test(name)) throw new Error(`Field name ${name} may consist of letters, digits and underscores only.`);
  if (name.includes('__')) throw new Error(`Field name ${name} must not contain two underscores in a row.`);
}

interface PlainFieldSpec {
  name: string;
  label: string;
  type: string;
  length?: number;
  precision?: number;
  scale?: number;
  conversionRoutine?: string;
  unitField?: string;
}

function buildPlainElement(f: PlainFieldSpec): string {
  const type = f.type.toUpperCase();
  let inline = `<inlineType name="${type}"`;
  if (DECIMAL_TYPES.has(type)) {
    const precision = f.precision ?? f.length;
    if (!precision) throw new Error(`Field ${f.name}: type ${type} needs a precision.`);
    inline += ` precision="${precision}"`;
    if (f.scale) inline += ` scale="${f.scale}"`;
  } else {
    if (LENGTH_TYPES.has(type) && !f.length) throw new Error(`Field ${f.name}: type ${type} needs a length.`);
    if (f.length) inline += ` length="${f.length}"`;
  }
  inline += '/>';
  const conv = f.conversionRoutine ? ` conversionRoutine="${escapeXmlAttr(f.conversionRoutine.toUpperCase())}"` : '';
  const unit = f.unitField ? `<unitCurrencyElement>#///${f.unitField}</unitCurrencyElement>` : '';
  return `<element xsi:type="BwCore:BwElement" name="${f.name}"${conv}><endUserTexts label="${escapeXmlAttr(f.label)}"/>${inline}${unit}</element>`;
}

/** The server fills in type, length, text and conversion routine of an InfoObject field. */
function buildInfoObjectElement(infoObject: string, unitField?: string): string {
  const unit = unitField ? `<unitCurrencyElement>#///${unitField}</unitCurrencyElement>` : '';
  return `<element xsi:type="BwCore:BwElement" name="${infoObject}" infoObjectName="${infoObject}">${unit}<associationType>1</associationType></element>`;
}

export type InfoObjectFactsReader = (name: string) => Promise<InfoObjectFacts>;

/**
 * Apply the requested changes to an InfoSource document the way the field editor of the
 * modeling tools does. Returns the changed document and what was done beyond the request.
 */
export async function applyInfosourceUpdate(
  xml: string,
  o: InfosourceUpdateOptions,
  readInfoObject: InfoObjectFactsReader
): Promise<{ xml: string; notes: string[] }> {
  const doc = splitDoc(xml);
  const notes: string[] = [];
  const up = (s: string): string => s.trim().toUpperCase();

  /** Object type of the InfoObject fields, from the document or from the InfoObject read here. */
  const objectTypes = new Map<string, string>();
  for (const el of doc.elements) {
    const f = factsOfElement(el);
    if (f.objectType) objectTypes.set(f.name, f.objectType);
    else if (f.aggregation && f.aggregation !== 'NONE') objectTypes.set(f.name, 'KYF');
  }
  // The read carries server-computed properties the write must not send back.
  doc.elements = doc.elements.map((el) => el.replace(/<consumptionViewProperties\b[^>]*\/>/g, ''));

  const indexOf = (name: string): number => doc.elements.findIndex((el) => factsOfElement(el).name === name);
  const mustIndex = (name: string): number => {
    const i = indexOf(name);
    if (i < 0) throw new Error(`${name} is not a field of the InfoSource.`);
    return i;
  };
  const fieldOfInfoObject = (iobj: string): string | undefined =>
    doc.elements.map(factsOfElement).find((f) => f.name === iobj || f.infoObject === iobj)?.name;
  const rootAttr = (name: string): string | undefined => attrOf(doc.head.match(/<trcs:infoSource\b[^>]*>/)?.[0] ?? '', name);
  const setRootAttr = (name: string, value: string): void => {
    doc.head = doc.head.replace(/<trcs:infoSource\b[^>]*>/, (tag) => withAttr(tag, name, value));
  };
  const renameRefs = (from: string, to: string): void => {
    doc.keys = doc.keys.map((k) => (k === from ? to : k));
    doc.elements = doc.elements.map((el) =>
      el.split(`<unitCurrencyElement>#///${from}</unitCurrencyElement>`).join(`<unitCurrencyElement>#///${to}</unitCurrencyElement>`)
        .split(`<compoundInfoObject>#///${from}</compoundInfoObject>`).join(''));
  };
  const assertUnitField = (field: string, type: string, unitField: string): void => {
    if (type !== 'CURR' && type !== 'QUAN') {
      throw new Error(`Field ${field}: only an amount (CURR) or quantity (QUAN) field has a unit or currency field.`);
    }
    const unit = factsOfElement(doc.elements[mustIndex(unitField)]);
    const wanted = type === 'CURR' ? 'CUKY' : 'UNIT';
    if (unit.dataType && unit.dataType !== wanted) {
      throw new Error(`Field ${field}: ${unitField} has type ${unit.dataType}; a ${type} field needs a field of type ${wanted}.`);
    }
  };

  /** Add an InfoObject field with what it cannot stand without; returns the field name. */
  const addInfoObject = async (iobj: string, asKey: boolean, requestedBy?: string): Promise<string> => {
    const present = fieldOfInfoObject(iobj);
    if (present) return present;
    const facts = await readInfoObject(iobj);
    if (/\binventoryType="(?!0")[^"]+"/.test(facts.xml.match(/<\w+:infoObject\b[^>]*>/)?.[0] ?? '')) {
      throw new Error(`InfoObject ${iobj} is a non-cumulative key figure; an InfoSource does not take it.`);
    }
    objectTypes.set(iobj, facts.objectType);
    let unitField: string | undefined;
    if (facts.objectType === 'KYF' && facts.unitInfoObject) {
      unitField = await addInfoObject(facts.unitInfoObject, false, iobj);
    }
    doc.elements.push(buildInfoObjectElement(iobj, unitField));
    if (asKey && !doc.keys.includes(iobj)) doc.keys.push(iobj);
    if (requestedBy) notes.push(`${iobj} added because ${requestedBy} needs it.`);
    if (facts.objectType === 'CHA' || facts.objectType === 'TIM') {
      for (const parent of facts.compoundParents) {
        const parentField = await addInfoObject(parent, asKey, iobj);
        if (asKey && !doc.keys.includes(parentField)) doc.keys.push(parentField);
      }
    }
    return iobj;
  };

  // 1. Switches of the InfoSource
  if (o.description !== undefined) {
    const tag = `<endUserTexts label="${escapeXmlAttr(o.description)}"/>`;
    doc.head = /<endUserTexts\b[^>]*\/>/.test(doc.head)
      ? doc.head.replace(/<endUserTexts\b[^>]*\/>/, () => tag)
      : doc.head + tag;
  }
  if (o.aggregation !== undefined) setRootAttr('aggregation', String(o.aggregation));
  if (o.datastoreLike !== undefined) setRootAttr('odsoLike', String(o.datastoreLike));

  // 2. Remove fields
  const removed = (o.removeFields ?? []).map(up);
  if (removed.length > 0) {
    for (const name of removed) mustIndex(name);
    if (rootAttr('odsoLike') === 'true' && removed.includes(RECORD_MODE)) {
      throw new Error(`${RECORD_MODE} cannot be removed while the InfoSource is DataStore-like; pass datastore_like: false in the same call.`);
    }
    const all = doc.elements.map(factsOfElement);
    const remaining = all.filter((f) => !removed.includes(f.name));
    for (const name of removed) {
      const users = remaining.filter((f) => f.unitField === name).map((f) => f.name);
      if (users.length > 0) {
        throw new Error(`${name} is the unit or currency field of ${users.join(', ')}; assign another unit field first or remove ${users.length > 1 ? 'them' : 'it'} too.`);
      }
    }
    // A compounding parent stays as long as a characteristic compounded to it does.
    for (const el of doc.elements) {
      const child = factsOfElement(el).name;
      if (removed.includes(child)) continue;
      const hit = compoundParentsOf(el).find((parent) => removed.includes(parent));
      if (hit) throw new Error(`${hit} is a compounding parent of ${child}; remove ${child} too.`);
    }
    doc.elements = doc.elements.filter((el) => !removed.includes(factsOfElement(el).name));
    doc.keys = doc.keys.filter((k) => !removed.includes(k));
  }

  // 3. Change existing fields
  for (const change of o.changeFields ?? []) {
    let name = up(change.name);
    const i = mustIndex(name);
    let facts = factsOfElement(doc.elements[i]);
    const wantsProperties = change.label !== undefined || change.type !== undefined || change.length !== undefined ||
      change.precision !== undefined || change.scale !== undefined || change.conversionRoutine !== undefined || change.unitField !== undefined;

    if (change.infoObjectName !== undefined && up(change.infoObjectName) !== '') {
      const iobj = up(change.infoObjectName);
      if (wantsProperties || change.newName !== undefined) {
        throw new Error(`Field ${name}: an InfoObject field takes its name and properties from the InfoObject; pass infoobject_name alone.`);
      }
      if (facts.infoObject === iobj) continue;
      if (fieldOfInfoObject(iobj)) throw new Error(`InfoObject ${iobj} is already a field of the InfoSource.`);
      await addInfoObject(iobj, doc.keys.includes(name));
      // The new field takes the place of the old one.
      const fresh = doc.elements.splice(indexOf(iobj), 1)[0];
      doc.keys = doc.keys.filter((k) => k !== iobj);
      doc.elements[i] = fresh;
      renameRefs(name, iobj);
      objectTypes.delete(name);
      continue;
    }

    if (change.infoObjectName !== undefined && facts.infoObject) {
      // An InfoObject field becomes a plain field: type and text stay.
      let plainName = change.newName !== undefined ? up(change.newName) : name.replace(/^\d/, '');
      if (change.newName === undefined) {
        const base = plainName;
        for (let n = 1; plainName !== name && indexOf(plainName) >= 0; n++) plainName = `${base}${n}`;
      } else if (plainName !== name && indexOf(plainName) >= 0) {
        throw new Error(`The InfoSource already has a field ${plainName}.`);
      }
      assertPlainFieldName(plainName);
      doc.elements[i] = buildPlainElement({
        name: plainName, label: facts.label, type: facts.dataType, length: facts.length, precision: facts.precision,
        scale: facts.scale, conversionRoutine: facts.conversionRoutine, unitField: facts.unitField,
      });
      renameRefs(name, plainName);
      objectTypes.delete(name);
      if (plainName !== name) notes.push(`${name} is now the plain field ${plainName}.`);
      name = plainName;
      facts = factsOfElement(doc.elements[i]);
    } else if (facts.infoObject) {
      throw new Error(`Field ${name} is an InfoObject field: its name, type and text come from InfoObject ${facts.infoObject}. Pass infoobject_name: "" to turn it into a plain field, or another InfoObject to rebind it.`);
    } else if (change.newName !== undefined && up(change.newName) !== name) {
      const newName = up(change.newName);
      assertPlainFieldName(newName);
      if (indexOf(newName) >= 0 || fieldOfInfoObject(newName)) throw new Error(`The InfoSource already has a field ${newName}.`);
      renameRefs(name, newName);
      name = newName;
    }

    if (!wantsProperties && name === facts.name) continue;
    const type = (change.type ?? facts.dataType).toUpperCase();
    const typeChanged = type !== facts.dataType;
    const hasUnit = type === 'CURR' || type === 'QUAN';
    const requestedUnit = change.unitField !== undefined ? up(change.unitField) || undefined : undefined;
    if (requestedUnit) assertUnitField(name, type, requestedUnit);
    doc.elements[i] = buildPlainElement({
      name,
      label: change.label ?? facts.label,
      type,
      length: change.length ?? (typeChanged ? undefined : facts.length),
      precision: change.precision ?? (typeChanged ? undefined : facts.precision),
      scale: change.scale ?? (typeChanged ? undefined : facts.scale),
      conversionRoutine: change.conversionRoutine ?? facts.conversionRoutine,
      unitField: !hasUnit ? undefined : change.unitField !== undefined ? requestedUnit : facts.unitField,
    });
    if (NOT_KEYABLE_TYPES.has(type) && doc.keys.includes(name) && !o.keyFields) {
      doc.keys = doc.keys.filter((k) => k !== name);
      notes.push(`${name} left the key: a field of type ${type} cannot be a key field.`);
    }
  }

  // 4. Add fields
  const pendingUnits: Array<{ name: string; type: string; unitField: string }> = [];
  for (const field of o.fields ?? []) {
    if (field.infoObjectName) {
      const iobj = up(field.infoObjectName);
      if (fieldOfInfoObject(iobj)) throw new Error(`InfoObject ${iobj} is already a field of the InfoSource.`);
      await addInfoObject(iobj, field.isKey === true);
      continue;
    }
    if (!field.name) throw new Error('A field needs a name or an infoobject_name.');
    const name = up(field.name);
    assertPlainFieldName(name);
    if (indexOf(name) >= 0 || fieldOfInfoObject(name)) {
      throw new Error(`The InfoSource already has a field ${name}; use change_fields to change it.`);
    }
    if (!field.type) throw new Error(`Field ${name} needs a type.`);
    const unitField = field.unitField ? up(field.unitField) : undefined;
    doc.elements.push(buildPlainElement({
      name, label: field.label ?? name, type: field.type, length: field.length, precision: field.precision,
      scale: field.scale, conversionRoutine: field.conversionRoutine, unitField,
    }));
    if (unitField) pendingUnits.push({ name, type: field.type.toUpperCase(), unitField });
    if (field.isKey && !doc.keys.includes(name)) doc.keys.push(name);
  }
  // The unit field of a new field may come later in the same call.
  for (const p of pendingUnits) assertUnitField(p.name, p.type, p.unitField);

  // 5. A DataStore-like InfoSource carries the record mode
  if (o.datastoreLike === true && !fieldOfInfoObject(RECORD_MODE)) {
    doc.elements.push(buildInfoObjectElement(RECORD_MODE));
    objectTypes.set(RECORD_MODE, 'DPA');
    notes.push(`${RECORD_MODE} added: a DataStore-like InfoSource carries the record mode.`);
  }

  // 6. Field order
  if (o.fieldOrder !== undefined) {
    const order = o.fieldOrder.map(up);
    if (new Set(order).size !== order.length) throw new Error('field_order names a field twice.');
    const first = order.map((name) => doc.elements[mustIndex(name)]);
    doc.elements = [...first, ...doc.elements.filter((el) => !order.includes(factsOfElement(el).name))];
  }

  // 7. Key
  if (o.keyFields !== undefined) {
    const keys = o.keyFields.map(up);
    if (new Set(keys).size !== keys.length) throw new Error('key_fields names a field twice.');
    // Key fields lead the field list, in key order.
    const keyElements = keys.map((k) => doc.elements[mustIndex(k)]);
    doc.keys = keys;
    doc.elements = [...keyElements, ...doc.elements.filter((el) => !keys.includes(factsOfElement(el).name))];
  }
  for (const k of doc.keys) {
    const f = factsOfElement(doc.elements[mustIndex(k)]);
    if (objectTypes.get(k) === 'KYF') throw new Error(`${k} is a key figure and cannot be a key field.`);
    if (NOT_KEYABLE_TYPES.has(f.dataType)) throw new Error(`${k} has type ${f.dataType} and cannot be a key field.`);
  }

  doc.tail = doc.tail.replace(/<contentState>[^<]*<\/contentState>/, '<contentState>REV</contentState>');
  return { xml: joinDoc(doc), notes };
}

/**
 * bw_update_infosource — change an InfoSource: description, switches, fields, key and field order.
 *
 * Workflow: Lock → GET full XML → change in place → PUT. The lock stays for bw_activate.
 */
export async function bwUpdateInfosource(
  client: BwClient,
  name: string,
  o: InfosourceUpdateOptions
): Promise<string> {
  const nameUpper = name.toUpperCase();
  const trcsPath = `/sap/bw/modeling/trcs/${bwSeg(name)}/m`;

  const lockHandle = await client.lock('trcs', name);
  let notes: string[];
  try {
    // Read after the lock, in the locking session: the lock refreshes its model buffer.
    const getResult = await client.get(`${trcsPath}?forceCacheUpdate=true`, TRCS_MEDIA);
    const timestamp = getResult.headers['timestamp'] ?? getResult.headers['TIMESTAMP'];

    const cache = new Map<string, InfoObjectFacts>();
    const readInfoObject: InfoObjectFactsReader = async (iobj) => {
      let facts = cache.get(iobj);
      if (!facts) {
        let body: string;
        try {
          body = (await client.get(`/sap/bw/modeling/iobj/${bwSeg(iobj.toLowerCase())}/a`, MEDIA_TYPES['iobj'])).body;
        } catch {
          throw new Error(`InfoObject ${iobj} has no active version; an InfoSource field needs an active InfoObject.`);
        }
        facts = parseInfoObjectFacts(iobj, body);
        cache.set(iobj, facts);
      }
      return facts;
    };

    // Sending ACT back would make the server drop the change; applyInfosourceUpdate sets REV.
    const changed = await applyInfosourceUpdate(getResult.body, o, readInfoObject);
    notes = changed.notes;
    await client.put('trcs', name, lockHandle, changed.xml, timestamp, undefined, o.transport);
  } catch (err) {
    await client.unlock('trcs', name).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message: `InfoSource ${nameUpper} updated. Call bw_activate to activate.`,
    ...(notes.length > 0 ? { notes } : {}),
    lock_handle: lockHandle,
    infosource_name: nameUpper,
    object_type: 'trcs',
  });
}
