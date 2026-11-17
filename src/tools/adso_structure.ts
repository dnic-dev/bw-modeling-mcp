/**
 * Structural edits of an aDSO document beyond fields and keys: secondary indexes, the hash key,
 * field groups, changes to a field that is not based on an InfoObject, and the rules that carry
 * existing data through such a change. Each function takes the document and returns the changed
 * document with one line per change, or throws with the reason a request does not apply. No I/O.
 */

const MAX_INDEXES = 16;

function fieldNames(xml: string): string[] {
  return [...xml.matchAll(/<element\b[^>]*\bname="([^"]+)"[^>]*>[\s\S]*?<\/element>/g)].map((m) => m[1]);
}

function resolveFields(xml: string, requested: string[], what: string): string[] {
  const byUpper = new Map(fieldNames(xml).map((f) => [f.toUpperCase(), f]));
  const wanted = requested.map((f) => f.trim().toUpperCase()).filter(Boolean);
  const unknown = wanted.filter((f) => !byUpper.has(f));
  if (unknown.length > 0) throw new Error(`${what}: ${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not in the aDSO.`);
  const twice = wanted.find((f, i) => wanted.indexOf(f) !== i);
  if (twice) throw new Error(`${what}: ${twice} is listed twice.`);
  return wanted.map((f) => byUpper.get(f) as string);
}

/** Insert elements of the aDSO root behind the field groups, where the server keeps them. */
function insertBehindGroups(xml: string, block: string): string {
  for (const anchor of ['<partitioningCriteria', '<template', '<tables', '<chaConst', '<semanticGroup', '<elementInitialization', '<pushURI']) {
    const at = xml.indexOf(anchor);
    if (at >= 0) return xml.slice(0, at) + block + xml.slice(at);
  }
  return xml.replace('</adso:dataStore>', `${block}</adso:dataStore>`);
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

export interface IndexSpec {
  fields: string[];
  unique?: boolean;
}

const INDEX_ELEMENT = /<index\b(?:[^>\/]|\/(?!>))*(?:\/>|>[\s\S]*?<\/index>)/g;

/** The secondary indexes of an aDSO as the document holds them. */
export function readIndexes(xml: string): Array<{ name: string; unique: boolean; fields: string[] }> {
  return [...xml.matchAll(INDEX_ELEMENT)].map((m) => ({
    name: m[0].match(/\bname="([^"]*)"/)?.[1] ?? '',
    unique: /\bunique="true"/.test(m[0]),
    fields: [...m[0].matchAll(/<element>#\/\/\/([^<]+)<\/element>/g)].map((e) => e[1].trim()),
  }));
}

/**
 * Replace the secondary indexes. The modeling tools number them 010, 020, … and build each on
 * the table of active data in ascending order; there can be sixteen.
 */
export function setIndexes(xml: string, indexes: IndexSpec[]): { xml: string; changes: string[] } {
  if (indexes.length > MAX_INDEXES) throw new Error(`An aDSO can have ${MAX_INDEXES} secondary indexes, not ${indexes.length}.`);
  const resolved = indexes.map((index, i) => {
    if (!Array.isArray(index.fields) || index.fields.length === 0) throw new Error(`Index ${i + 1} needs at least one field.`);
    return { fields: resolveFields(xml, index.fields, `Index ${i + 1}`), unique: index.unique === true };
  });
  const now = readIndexes(xml);
  const same = now.length === resolved.length && now.every((n, i) =>
    n.unique === resolved[i].unique && n.fields.length === resolved[i].fields.length && n.fields.every((f, k) => f === resolved[i].fields[k]));
  if (same) return { xml, changes: [] };
  const block = resolved
    .map((index, i) => {
      const name = `${String(i + 1).padStart(2, '0')}0`;
      return `<index xsi:type="adso:DataStoreIndex" name="${name}" order="ASC" unique="${index.unique}" tableType="AT">` +
        `${index.fields.map((f) => `<element>#///${f}</element>`).join('')}</index>`;
    })
    .join('');
  // The indexes sit between the key and the field groups; anywhere else the save is refused.
  const cleared = xml.replace(INDEX_ELEMENT, '');
  const at = cleared.indexOf('<dimension');
  const out = at >= 0 ? cleared.slice(0, at) + block + cleared.slice(at) : insertBehindGroups(cleared, block);
  return {
    xml: out,
    changes: [resolved.length === 0
      ? `secondary indexes removed (${now.length})`
      : `secondary indexes: ${resolved.map((r) => `${r.fields.join('+')}${r.unique ? ' (unique)' : ''}`).join('; ')}`],
  };
}

const HASH_ELEMENT = /<hashElements>\s*#\/\/\/([^<\s]+)\s*<\/hashElements>/g;

/** Replace the fields of the hash key; an empty list removes it. */
export function setHashKey(xml: string, fields: string[]): { xml: string; changes: string[] } {
  const wanted = resolveFields(xml, fields, 'Hash key');
  const now = [...xml.matchAll(HASH_ELEMENT)].map((m) => m[1]);
  if (now.length === wanted.length && now.every((f, i) => f === wanted[i])) return { xml, changes: [] };
  const block = wanted.map((f) => `<hashElements>#///${f}</hashElements>`).join('');
  const out = insertBehindGroups(xml.replace(HASH_ELEMENT, ''), block);
  return { xml: out, changes: [wanted.length === 0 ? 'hash key removed' : `hash key: ${wanted.join(', ')}`] };
}

export interface FieldGroupChanges {
  add?: Array<{ name: string; description?: string }>;
  rename?: Array<{ name: string; new_name?: string; description?: string }>;
  remove?: string[];
}

// The attribute part may not swallow the slash of a self-closing tag, or the match runs on to
// the closing tag of a later group.
const GROUP_ELEMENT = /<dimension\b(?:[^>\/]|\/(?!>))*(?:\/>|>[\s\S]*?<\/dimension>)/g;

/** The field groups of an aDSO with the fields each holds. */
export function readFieldGroups(xml: string): Array<{ name: string; description: string; fields: string[] }> {
  return [...xml.matchAll(GROUP_ELEMENT)].map((m) => {
    const name = m[0].match(/\bname="([^"]*)"/)?.[1] ?? '';
    const fields = [...xml.matchAll(/<element\b([^>]*)>/g)]
      .filter((e) => new RegExp(`\\bdimension="#\\/\\/\\/${escapeRegExp(name)}§"`).test(e[1]))
      .map((e) => e[1].match(/\bname="([^"]+)"/)?.[1] ?? '');
    return { name, description: m[0].match(/<descriptions\b[^>]*\blabel="([^"]*)"/)?.[1] ?? '', fields };
  });
}

function groupName(raw: string): string {
  const name = raw.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,15}$/.test(name)) {
    throw new Error(`"${raw}" is not a field group name: up to 16 characters, letters, digits and underscores, starting with a letter.`);
  }
  return name;
}

/** Add, rename and remove field groups. A group that still holds fields is not removed. */
export function changeFieldGroups(xml: string, changes: FieldGroupChanges): { xml: string; changes: string[] } {
  let out = xml;
  const done: string[] = [];
  const exists = (name: string) => readFieldGroups(out).some((g) => g.name.toUpperCase() === name);

  for (const group of changes.add ?? []) {
    const name = groupName(group.name);
    if (exists(name)) throw new Error(`Field group ${name} already exists.`);
    const element = group.description?.trim()
      ? `<dimension name="${name}"><descriptions label="${escapeAttr(group.description.trim())}"/></dimension>`
      : `<dimension name="${name}"/>`;
    const groups = [...out.matchAll(GROUP_ELEMENT)];
    if (groups.length > 0) {
      const last = groups[groups.length - 1];
      const at = (last.index ?? 0) + last[0].length;
      out = out.slice(0, at) + element + out.slice(at);
    } else {
      out = insertBehindGroups(out, element);
    }
    done.push(`field group ${name} added`);
  }

  for (const group of changes.rename ?? []) {
    const name = groupName(group.name);
    const element = [...out.matchAll(GROUP_ELEMENT)].find((m) => (m[0].match(/\bname="([^"]*)"/)?.[1] ?? '').toUpperCase() === name);
    if (!element) throw new Error(`Field group ${name} does not exist.`);
    const oldName = element[0].match(/\bname="([^"]*)"/)?.[1] ?? name;
    const newName = group.new_name ? groupName(group.new_name) : oldName;
    if (newName !== oldName && exists(newName)) throw new Error(`Field group ${newName} already exists.`);
    const oldLabel = element[0].match(/<descriptions\b[^>]*\blabel="([^"]*)"/)?.[1];
    const label = group.description === undefined ? oldLabel : escapeAttr(group.description.trim());
    const replacement = label ? `<dimension name="${newName}"><descriptions label="${label}"/></dimension>` : `<dimension name="${newName}"/>`;
    if (replacement === element[0]) continue;
    out = out.replace(element[0], replacement);
    if (newName !== oldName) {
      out = out.replace(new RegExp(`\\bdimension="#\\/\\/\\/${escapeRegExp(oldName)}§"`, 'g'), `dimension="#///${newName}§"`);
      done.push(`field group ${oldName} renamed to ${newName}`);
    }
    if (group.description !== undefined && label !== oldLabel) done.push(`field group ${newName} described`);
  }

  for (const raw of changes.remove ?? []) {
    const name = groupName(raw);
    const group = readFieldGroups(out).find((g) => g.name.toUpperCase() === name);
    if (!group) throw new Error(`Field group ${name} does not exist.`);
    if (group.fields.length > 0) {
      throw new Error(`Field group ${name} still holds ${group.fields.join(', ')}; move these fields to another group first.`);
    }
    const element = [...out.matchAll(GROUP_ELEMENT)].find((m) => m[0].match(/\bname="([^"]*)"/)?.[1] === group.name);
    if (element) out = out.replace(element[0], '');
    done.push(`field group ${name} removed`);
  }
  return { xml: out, changes: done };
}

export interface FieldChange {
  field: string;
  new_name?: string;
  data_type?: string;
  length?: number;
  precision?: number;
  scale?: number;
  /** A conversion routine such as "ALPHA"; an empty text removes it. */
  conversion_routine?: string;
  /** Carry the data of the field over to its new name (default true). */
  keep_data?: boolean;
}

const FIELD_DATA_TYPES = [
  'CHAR', 'NUMC', 'DATS', 'TIMS', 'CUKY', 'UNIT', 'LANG', 'DEC', 'CURR', 'QUAN', 'FLTP', 'INT1', 'INT2', 'INT4', 'INT8',
  'SSTR', 'STRG', 'RSTR', 'RAW', 'D16D', 'D34D', 'D16R', 'D34R',
];
const DECIMAL_TYPES = ['DEC', 'CURR', 'QUAN'];

/**
 * Whether the system knows rules for existing data at all. A release that does counts the
 * remodeling versions on the aDSO; a classic release has no such attribute and refuses a
 * document that carries a rule.
 */
export function supportsDataRules(xml: string): boolean {
  return /<adso:dataStore\b[^>]*\snextRemodelingVersion="/.test(xml);
}

function nextRemodelingVersion(xml: string): string {
  return xml.match(/<adso:dataStore\b[^>]*\snextRemodelingVersion="(\d+)"/)?.[1] ?? '1';
}

/** Add a rule that tells BW how to fill a field from the data that exists when it activates. */
function addInitialization(xml: string, attributes: string): string {
  const element = `<elementInitialization ${attributes}/>`;
  const existing = [...xml.matchAll(/<elementInitialization\b[^>]*\/>/g)];
  if (existing.length > 0) {
    const last = existing[existing.length - 1];
    const at = (last.index ?? 0) + last[0].length;
    return xml.slice(0, at) + element + xml.slice(at);
  }
  const at = xml.indexOf('<pushURI');
  return at >= 0 ? xml.slice(0, at) + element + xml.slice(at) : xml.replace('</adso:dataStore>', `${element}</adso:dataStore>`);
}

/**
 * Change a field that is not based on an InfoObject: its name, data type, length, precision,
 * scale and conversion routine. A field based on an InfoObject takes all of this from the
 * InfoObject. A new name is written into everything that refers to the field — key, hash key,
 * indexes, partitioning, validity, criteria and the unit reference of other fields — and BW gets
 * a rule to carry the data over, since it treats a renamed field as a new one.
 */
export function changeField(xml: string, change: FieldChange): { xml: string; changes: string[] } {
  const wanted = change.field.trim().toUpperCase();
  const element = [...xml.matchAll(/<element\b([^>]*)>([\s\S]*?)<\/element>/g)]
    .find((m) => (m[1].match(/\bname="([^"]+)"/)?.[1] ?? '').toUpperCase() === wanted);
  if (!element) throw new Error(`Field ${wanted} is not in the aDSO.`);
  if (/\binfoObjectName="[^"]+"/.test(element[1])) {
    throw new Error(`${wanted} is based on an InfoObject and takes its name and type from there; change the InfoObject instead.`);
  }
  const oldName = element[1].match(/\bname="([^"]+)"/)?.[1] ?? wanted;
  let open = `<element${element[1]}>`;
  let body = element[2];
  const done: string[] = [];

  const inline = body.match(/<inlineType\b[^>]*\/>/)?.[0];
  if (!inline) throw new Error(`Field ${oldName} has no data type element to change.`);
  let newInline = inline;
  const inlineAttr = (name: string) => newInline.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
  const setInline = (name: string, value: string | undefined) => {
    const without = newInline.replace(new RegExp(`\\s${name}="[^"]*"`), '');
    newInline = value === undefined ? without : without.replace(/^<inlineType\b/, `<inlineType ${name}="${value}"`);
  };
  let dataType = inlineAttr('name') ?? '';
  if (change.data_type !== undefined) {
    const type = change.data_type.trim().toUpperCase();
    if (!FIELD_DATA_TYPES.includes(type)) throw new Error(`Unknown data type ${type}. Valid types: ${FIELD_DATA_TYPES.join(', ')}.`);
    if (type !== dataType) {
      done.push(`data type ${dataType} → ${type}`);
      setInline('name', type);
      dataType = type;
    }
  }
  const decimal = DECIMAL_TYPES.includes(dataType);
  const numbers: Array<['length' | 'precision' | 'scale', number | undefined]> = [
    ['length', change.length], ['precision', change.precision], ['scale', change.scale],
  ];
  for (const [name, value] of numbers) {
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} is a whole number, not ${value}.`);
    if (name === 'length' && decimal) throw new Error(`A ${dataType} field has precision and scale, not a length.`);
    if (name !== 'length' && !decimal) throw new Error(`A ${dataType} field has a length, not ${name}.`);
    if (inlineAttr(name) !== String(value)) {
      done.push(`${name} ${inlineAttr(name) ?? '(none)'} → ${value}`);
      setInline(name, String(value));
    }
  }
  if (newInline !== inline) body = body.replace(inline, newInline);

  if (change.conversion_routine !== undefined) {
    const routine = change.conversion_routine.trim().toUpperCase();
    if (!/^[A-Z0-9_/]{0,5}$/.test(routine)) throw new Error('conversion_routine is the name of a conversion exit of up to five characters, such as "ALPHA".');
    const now = open.match(/\sconversionRoutine="([^"]*)"/)?.[1] ?? '';
    if (routine !== now) {
      open = open.replace(/\sconversionRoutine="[^"]*"/, '');
      if (routine) open = open.replace(/^<element\b/, `<element conversionRoutine="${routine}"`);
      done.push(routine ? `conversion routine ${now || '(none)'} → ${routine}` : `conversion routine ${now} removed`);
    }
  }

  let newName = oldName;
  if (change.new_name !== undefined) {
    newName = change.new_name.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,29}$/.test(newName)) {
      throw new Error(`"${change.new_name}" is not a field name: up to 30 characters, letters, digits and underscores, starting with a letter.`);
    }
    if (newName !== oldName && fieldNames(xml).some((f) => f.toUpperCase() === newName)) throw new Error(`The aDSO already has a field ${newName}.`);
  }

  if (newName !== oldName && change.keep_data !== false && !supportsDataRules(xml)) {
    throw new Error(
      `This BW release has no rules that carry data into a renamed field: renaming ${oldName} gives up its data. ` +
      `Pass keep_data false to rename it anyway.`,
    );
  }
  // BW carries data only into a field of the same definition: its check refuses a replacement
  // whose type or length differs from the field it replaces.
  if (newName !== oldName && change.keep_data !== false && newInline !== inline) {
    throw new Error(
      `${oldName} cannot be renamed and retyped in one step while its data is kept: BW carries data only into a field of ` +
      `the same definition. Rename it first, run the remodeling, then change the type or length; or pass keep_data false.`,
    );
  }

  let out = xml.replace(element[0], `${open}${body}</element>`);
  if (newName !== oldName) {
    out = out.replace(`${open}${body}</element>`, `${open.replace(/\bname="[^"]+"/, `name="${newName}"`)}${body}</element>`);
    // Everything that points at the field by name.
    out = out.replace(new RegExp(`#\\/\\/\\/${escapeRegExp(oldName)}(?=[<"\\s])`, 'g'), `#///${newName}`);
    done.push(`renamed ${oldName} → ${newName}`);
    if (change.keep_data !== false) {
      out = addInitialization(
        out,
        `elementName="${newName}" remodelingVersion="${nextRemodelingVersion(out)}" mode="replace" sourceElement="${oldName}" ` +
        `srcElementIsInfoObject="false" elementIsInfoObject="false"`,
      );
      done.push(`the data of ${oldName} is carried over to ${newName}`);
    }
  }
  return { xml: out, changes: done };
}

export interface FieldInitialization {
  field: string;
  /** Fill the field with this value in every record that exists. */
  constant?: string;
  /** Fill the field from this other field of the aDSO. */
  from_field?: string;
  /** Take a rule back that has not been activated yet. */
  remove?: boolean;
}

/**
 * Tell BW how to fill fields from the data that exists when the aDSO activates: with a constant,
 * or with the value of another field. Without such a rule a new field stays initial.
 */
export function initializeFields(xml: string, rules: FieldInitialization[]): { xml: string; changes: string[] } {
  if (rules.length > 0 && !supportsDataRules(xml)) {
    throw new Error('This BW release has no rules that fill a field from existing data; a new field stays initial in the records that exist.');
  }
  let out = xml;
  const done: string[] = [];
  const elements = new Map([...xml.matchAll(/<element\b([^>]*)>/g)].map((m) => [m[1].match(/\bname="([^"]+)"/)?.[1] ?? '', m[1]]));
  const isInfoObject = (name: string) => /\binfoObjectName="[^"]+"/.test(elements.get(name) ?? '');
  for (const rule of rules) {
    const [field] = resolveFields(xml, [rule.field], 'Initialization');
    const pending = [...out.matchAll(/<elementInitialization\b[^>]*\/>/g)].find((m) => new RegExp(`\\belementName="${escapeRegExp(field)}"`).test(m[0]));
    if (rule.remove) {
      if (rule.constant !== undefined || rule.from_field !== undefined) throw new Error(`The initialization of ${field}: remove goes without constant and from_field.`);
      if (pending) {
        out = out.replace(pending[0], '');
        done.push(`the rule that fills ${field} is taken back`);
      }
      continue;
    }
    if ((rule.constant === undefined) === (rule.from_field === undefined)) {
      throw new Error(`The initialization of ${field} needs exactly one of constant or from_field.`);
    }
    if (pending) out = out.replace(pending[0], '');
    const head = `elementName="${field}" remodelingVersion="${nextRemodelingVersion(out)}" elementIsInfoObject="${isInfoObject(field)}"`;
    if (rule.constant !== undefined) {
      out = addInitialization(out, `${head} mode="fillWithConstant" value="${escapeAttr(rule.constant)}" intValue="${escapeAttr(rule.constant)}" srcElementIsInfoObject="false"`);
      done.push(`${field} is filled with "${rule.constant}"`);
    } else {
      const [source] = resolveFields(xml, [rule.from_field as string], `Initialization of ${field}`);
      if (source === field) throw new Error(`${field} cannot be filled from itself.`);
      out = addInitialization(out, `${head} mode="fillFromElement" sourceElement="${source}" srcElementIsInfoObject="${isInfoObject(source)}"`);
      done.push(`${field} is filled from ${source}`);
    }
  }
  return { xml: out, changes: done };
}

export interface Criterion {
  field: string;
  /** A single value, as a user enters it. */
  value?: string;
  /** A range of values, both ends included. */
  from?: string;
  to?: string;
}

const CRITERION_ELEMENT = /<chaConst\b(?:[^>\/]|\/(?!>))*\/>/g;

/** The criteria of an aDSO: the values each field is restricted to. */
export function readCriteria(xml: string): Array<{ field: string; operator: string; low: string; high: string }> {
  const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? '';
  return [...xml.matchAll(CRITERION_ELEMENT)].map((m) => ({
    field: attr(m[0], 'field').replace(/^#\/\/\//, ''),
    operator: attr(m[0], 'options'),
    low: attr(m[0], 'rangeLow'),
    high: attr(m[0], 'rangeHigh'),
  }));
}

/**
 * Replace the criteria: per field the value or the range of values the aDSO holds. BW uses them
 * to leave the aDSO out of a query that asks for other values. Values are written as a user
 * enters them; the server checks them against the field.
 */
export function setCriteria(xml: string, criteria: Criterion[]): { xml: string; changes: string[] } {
  const elements = criteria.map((c, i) => {
    const [field] = resolveFields(xml, [c.field], `Criterion ${i + 1}`);
    const single = c.value !== undefined;
    const range = c.from !== undefined || c.to !== undefined;
    if (single === range) throw new Error(`Criterion ${i + 1} on ${field} needs either value, or from and to.`);
    if (range && (!c.from?.trim() || !c.to?.trim())) throw new Error(`Criterion ${i + 1} on ${field}: a range needs both from and to.`);
    const low = escapeAttr((single ? c.value as string : c.from as string).trim());
    if (!low) throw new Error(`Criterion ${i + 1} on ${field} has an empty value.`);
    return single
      ? `<chaConst field="#///${field}" options="EQ" rangeLow="${low}" rangeHigh=""/>`
      : `<chaConst field="#///${field}" options="BT" rangeLow="${low}" rangeHigh="${escapeAttr((c.to as string).trim())}"/>`;
  });
  const now = [...xml.matchAll(CRITERION_ELEMENT)].map((m) => m[0]);
  // The server pads the stored values with blanks.
  const key = (tag: string) => ['field', 'options', 'rangeLow', 'rangeHigh'].map((a) => (tag.match(new RegExp(`\\s${a}="([^"]*)"`))?.[1] ?? '').trim()).join('|');
  if (now.length === elements.length && now.every((tag, i) => key(tag) === key(elements[i]))) return { xml, changes: [] };
  let out = xml.replace(CRITERION_ELEMENT, '');
  const block = elements.join('');
  // The criteria follow the tables and precede the rules for existing data and the push URIs.
  const anchor = ['<semanticGroup', '<referencedSemanticGroup', '<elementInitialization', '<pushURI'].map((a) => out.indexOf(a)).filter((at) => at >= 0).sort((a, b) => a - b)[0];
  out = anchor === undefined ? out.replace('</adso:dataStore>', `${block}</adso:dataStore>`) : out.slice(0, anchor) + block + out.slice(anchor);
  return {
    xml: out,
    changes: [criteria.length === 0
      ? `criteria removed (${now.length})`
      : `criteria: ${criteria.map((c) => `${c.field.toUpperCase()} ${c.value !== undefined ? `= ${c.value}` : `${c.from} to ${c.to}`}`).join('; ')}`],
  };
}
