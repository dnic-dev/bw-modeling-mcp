/**
 * Temporal join of a CompositeProvider.
 *
 * A join becomes temporal when one of its inputs is time-dependent: a characteristic with
 * time-dependent attributes, or a provider whose records carry a validity interval in two
 * date fields. The document then lists, outside the view nodes, every input with its role,
 * every field of those inputs, the operands that say where the validity comes from, and
 * three date fields of the CompositeProvider itself. All of that is derived from a few
 * choices per input, so it is written anew from those choices on every change.
 */

export interface TemporalInput {
  alias: string;
  providerName: string;
  /** Provider type as in the alias: "IOBJ", "ADSO", ... */
  kind: string;
  /** Names of the provider fields, as an input mapping addresses them. */
  fields: string[];
  /** A characteristic that has time-dependent attributes. */
  timeDependent: boolean;
  /** The characteristic a characteristic input refers to. */
  baseName?: string;
}

export interface TemporalChoice {
  /** Characteristic: its validity takes part in the join (default) or its attributes are read as of a key date. */
  showTimeDependent?: boolean;
  /** Provider: the two date fields that hold the validity interval of a record. */
  validFrom?: string;
  validTo?: string;
  /** The date field the time-dependent inputs are read for. */
  keyDate?: string;
}

export interface TemporalProviderInfo {
  alias: string;
  provider: string;
  time_dependent: boolean;
  valid_from_field?: string;
  valid_to_field?: string;
  key_date_field?: string;
}

const FIELD_OBJECT = /<temporalFieldObject\b[^>]*\/>/g;
const JOIN_PROVIDER = /<temporalJoinProvider\b[^>]*\/>/g;
const OPERAND = /<temporalOperand\b(?:[^>/]|\/(?!>))*(?:\/>|>[\s\S]*?<\/temporalOperand>)/g;
const GLOBAL_ELEMENT = /<globalTemporalElement\b(?:[^>/]|\/(?!>))*(?:\/>|>[\s\S]*?<\/globalTemporalElement>)/g;
const INPUT_ELEMENT = /<(temporalElement|technicalElement)\b(?:[^>/]|\/(?!>))*(?:\/>|>[\s\S]*?<\/\1>)/g;
/** Operands and fields of derived validity, which this module carries over but does not write. */
const DERIVED_OPERANDS = ['TI', 'TX', 'SA'];
const DERIVED_FIELDS = ['TF', 'TT', 'TX'];

function attr(tag: string, name: string): string {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '';
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Alias of the input a reference like "#///NODE/ALIAS" or "#///NODE/ALIAS/FIELD" points into, if it is in that node. */
function aliasOfRef(ref: string, nodeName: string): string | undefined {
  const prefix = `#///${nodeName}/`;
  if (!ref.startsWith(prefix)) return undefined;
  return ref.slice(prefix.length).split('/')[0];
}

function fieldOfRef(ref: string): string {
  return ref.split('/').pop() ?? '';
}

export function isTemporalJoin(xml: string): boolean {
  return /<Composite:compositeView\b[^>]*\btemporalJoin="true"/.test(xml);
}

/** The choices a document holds for the inputs of one view node. */
export function readTemporalChoices(xml: string, nodeName: string): Map<string, TemporalChoice> {
  const choices = new Map<string, TemporalChoice>();
  const of = (alias: string): TemporalChoice => {
    if (!choices.has(alias)) choices.set(alias, {});
    return choices.get(alias)!;
  };
  for (const m of xml.matchAll(JOIN_PROVIDER)) {
    const alias = aliasOfRef(attr(m[0], 'input'), nodeName);
    if (!alias) continue;
    const choice = of(alias);
    if (attr(m[0], 'type') === 'CP') choice.showTimeDependent = false;
    if (attr(m[0], 'type') === 'CQ') choice.showTimeDependent = true;
  }
  for (const m of xml.matchAll(OPERAND)) {
    const tag = m[0].match(/^<temporalOperand\b[^>]*>/)?.[0] ?? '';
    const alias = aliasOfRef(attr(tag, 'input'), nodeName);
    if (!alias) continue;
    const type = attr(tag, 'type');
    if (type === 'TD') {
      of(alias).validFrom = fieldOfRef(attr(tag, 'temporalArgument'));
      of(alias).validTo = fieldOfRef(attr(tag, 'compoundedTemporalArgument'));
    }
    if (type === 'DT') of(alias).keyDate = fieldOfRef(attr(tag, 'temporalArgument'));
  }
  return choices;
}

function setRootTemporalJoin(xml: string, on: boolean): string {
  const root = xml.match(/<Composite:compositeView\b[^>]*>/)?.[0];
  if (!root) throw new Error('Not a CompositeProvider document.');
  const value = `temporalJoin="${on}"`;
  const next = /\btemporalJoin="[^"]*"/.test(root)
    ? root.replace(/\btemporalJoin="[^"]*"/, value)
    : root.replace(/>$/, ` ${value}>`);
  return xml.replace(root, () => next);
}

function dateElement(tag: string, name: string, infoObject: string): string {
  return (
    `<${tag} xsi:type="BwCore:BwElement" name="${name}" infoObjectName="${infoObject}" baseInfoObjectName="0DATE" hidden="true">` +
    `<endUserTexts label="${name}"/>` +
    `<inlineType name="DATS" globalElementName="${infoObject}" length="8" semanticType="date"/>` +
    `<associationType>1</associationType><associationValid>true</associationValid>` +
    `<consumptionViewProperties objectType="CHA" fieldName="${infoObject.slice(1)}" sidConversionType="W"/>` +
    `</${tag}>`
  );
}

function fieldObject(type: string, name: string, field: string, opts: { input?: string; additional?: boolean; reference?: string } = {}): string {
  return (
    `<temporalFieldObject type="${type}" name="${name}" field="${field}"` +
    (opts.input ? ` input="${opts.input}"` : '') +
    (opts.reference ? ` referenceObject="${opts.reference}"` : '') +
    (opts.additional ? ' additionalField="true"' : '') +
    '/>'
  );
}

function inputBlock(xml: string, alias: string): string | undefined {
  return xml.match(new RegExp(`<input\\b[^>]*\\balias="${escapeRegex(alias)}"[^>]*>[\\s\\S]*?<\\/input>`))?.[0];
}

/** The date elements a time-dependent characteristic input carries, and the switch that shows them. */
function setInputDateElements(xml: string, alias: string, shown: boolean | undefined): string {
  const block = inputBlock(xml, alias);
  if (!block) return xml;
  let next = block.replace(INPUT_ELEMENT, '');
  if (shown !== undefined) {
    const open = next.match(/^<input\b[^>]*>/)![0];
    const flag = `hiddenTemporalFields="${!shown}"`;
    next = next.replace(open, () =>
      /\bhiddenTemporalFields="/.test(open) ? open.replace(/\bhiddenTemporalFields="[^"]*"/, flag) : open.replace(/>$/, ` ${flag}>`));
  }
  if (shown) {
    const elements =
      dateElement('temporalElement', '0DATEFROM', '0DATEFROM') + dateElement('temporalElement', '0DATETO', '0DATETO') +
      dateElement('technicalElement', 'DATEFROM', '0DATEFROM') + dateElement('technicalElement', 'DATETO', '0DATETO');
    next = next.replace(/<\/input>$/, () => `${elements}</input>`);
  }
  return xml.replace(block, () => next);
}

/** Take every part of a temporal join out of the document. */
export function stripTemporalJoin(xml: string, aliases: string[]): string {
  let out = xml.replace(FIELD_OBJECT, '').replace(JOIN_PROVIDER, '').replace(OPERAND, '').replace(GLOBAL_ELEMENT, '');
  for (const alias of aliases) out = setInputDateElements(out, alias, undefined);
  return setRootTemporalJoin(out, false);
}

/**
 * Write the temporal join of one join node from the choices per input. Returns the document
 * and whether it is a temporal join at all: without a time-dependent input there is nothing
 * to join over time, and the document comes back without any temporal part.
 */
export function writeTemporalJoin(
  xml: string,
  nodeName: string,
  inputs: TemporalInput[],
  choices: Map<string, TemporalChoice>,
): { xml: string; enabled: boolean; providers: TemporalProviderInfo[] } {
  const present = new Set(inputs.map((i) => i.alias));
  // Derived validity (a period field turned into an interval, a shifted key date) is carried over as it stands.
  const keptOperands = [...xml.matchAll(OPERAND)].map((m) => m[0]).filter((op) => {
    const alias = aliasOfRef(attr(op, 'input'), nodeName);
    return alias !== undefined && present.has(alias) && DERIVED_OPERANDS.includes(attr(op, 'type'));
  });
  const keptFields = [...xml.matchAll(FIELD_OBJECT)].map((m) => m[0]).filter((fo) => {
    const alias = aliasOfRef(attr(fo, 'input'), nodeName);
    return alias !== undefined && present.has(alias) && DERIVED_FIELDS.includes(attr(fo, 'type'));
  });

  let out = stripTemporalJoin(xml, inputs.map((i) => i.alias));
  const fieldObjects: string[] = [];
  const joinProviders: string[] = [];
  const operands: string[] = [];
  const providers: TemporalProviderInfo[] = [];
  let timeDependentInputs = keptOperands.filter((op) => attr(op, 'type') === 'TI').length;

  for (const input of inputs) {
    if (input.kind !== 'IOBJ' && input.kind !== 'ADSO') continue;
    const choice = choices.get(input.alias) ?? {};
    const ref = `#///${nodeName}/${input.alias}`;
    const has = (field: string | undefined) => Boolean(field) && input.fields.includes(field!);
    const interval = input.kind === 'ADSO' && has(choice.validFrom) && has(choice.validTo);
    const shown = input.kind === 'IOBJ' && input.timeDependent && choice.showTimeDependent !== false;
    const derivedInterval = keptOperands.some((op) => attr(op, 'type') === 'TI' && aliasOfRef(attr(op, 'input'), nodeName) === input.alias);

    const type = input.kind === 'IOBJ' ? (shown ? 'CQ' : 'CP') : interval || derivedInterval ? 'AQ' : 'AA';
    joinProviders.push(
      `<temporalJoinProvider type="${type}" input="${ref}"` +
      (input.kind === 'IOBJ' ? ` baseName="${input.baseName || input.providerName}"` : '') + '/>');
    for (const field of input.fields) fieldObjects.push(fieldObject('IO', field, `${ref}/${field}`, { input: ref }));

    if (input.kind === 'IOBJ' && input.timeDependent) out = setInputDateElements(out, input.alias, shown);
    if (shown) {
      fieldObjects.push(
        fieldObject('FR', '0DATEFROM', `${ref}/0DATEFROM`, { reference: ref, additional: true }),
        fieldObject('TO', '0DATETO', `${ref}/0DATETO`, { reference: ref, additional: true }),
        fieldObject('TE', 'DATEFROM', `${ref}/DATEFROM`, { input: ref }),
        fieldObject('TE', 'DATETO', `${ref}/DATETO`, { input: ref }),
      );
      operands.push(`<temporalOperand type="CH" temporalArgument="${ref}" input="${ref}"/>`);
      timeDependentInputs++;
    }
    if (interval) {
      operands.push(
        `<temporalOperand type="TD" temporalArgument="${ref}/${choice.validFrom}" input="${ref}" ` +
        `compoundedTemporalArgument="${ref}/${choice.validTo}"/>`);
      timeDependentInputs++;
    }
    const keyDate = has(choice.keyDate) ? choice.keyDate : undefined;
    if (keyDate) operands.push(`<temporalOperand type="DT" temporalArgument="${ref}/${keyDate}" input="${ref}"/>`);
    providers.push({
      alias: input.alias,
      provider: input.providerName,
      time_dependent: shown || interval || derivedInterval,
      ...(interval ? { valid_from_field: choice.validFrom, valid_to_field: choice.validTo } : {}),
      ...(keyDate ? { key_date_field: keyDate } : {}),
    });
  }

  if (timeDependentInputs === 0) {
    for (const input of inputs) out = setInputDateElements(out, input.alias, undefined);
    out = out.replace(/hiddenTemporalFields="true"/g, 'hiddenTemporalFields="false"');
    return { xml: out, enabled: false, providers: [] };
  }

  const parts =
    fieldObjects.join('') + keptFields.join('') +
    fieldObject('FR', '0DATEFROM', '#///0DATEFROM', { additional: true }) +
    fieldObject('TO', '0DATETO', '#///0DATETO', { additional: true }) +
    fieldObject('SE', 'DATESEL', '#///DATESEL', { additional: true }) +
    joinProviders.join('') + operands.join('') + keptOperands.join('') +
    dateElement('globalTemporalElement', '0DATEFROM', '0DATEFROM') +
    dateElement('globalTemporalElement', '0DATETO', '0DATETO') +
    dateElement('globalTemporalElement', 'DATESEL', '0DATEFROM');
  out = setRootTemporalJoin(out, true).replace(/<\/Composite:compositeView>\s*$/, () => `${parts}</Composite:compositeView>`);
  return { xml: out, enabled: true, providers };
}

/** The date elements of one input, as they stand. */
export function inputDateElements(block: string): string {
  return [...block.matchAll(INPUT_ELEMENT)].map((m) => m[0]).join('');
}

/**
 * The date elements of an input come after its mappings; the server refuses the document
 * otherwise. Whatever was appended to an input since ends up in front of them again.
 */
export function settleInputDateElements(xml: string): string {
  if (!/<(?:temporalElement|technicalElement)\b/.test(xml)) return xml;
  return xml.replace(/<input\b[^>]*>[\s\S]*?<\/input>/g, (block) => {
    const elements = inputDateElements(block);
    if (!elements) return block;
    return block.replace(INPUT_ELEMENT, '').replace(/\s*<\/input>$/, () => `${elements}</input>`);
  });
}
