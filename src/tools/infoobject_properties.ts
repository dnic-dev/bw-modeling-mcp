/**
 * Property changes on an InfoObject document that are plain edits of the document: the settings
 * of the General and BI Clients pages of the modeling tools. Each function takes the document and
 * the requested values and returns the changed document with one line per change, or throws with
 * the reason a value does not apply. No I/O, so the rules can be tested without a backend.
 */

export interface KeyFigureProperties {
  aggregation?: string;
  /** An aggregation type, or "none" to remove the exception aggregation. */
  exception_aggregation?: string;
  exception_aggregation_reference?: string;
  decimal_places?: number | 'default';
  display_scaling?: number | 'default';
  data_type?: string;
  high_precision?: boolean;
}

export const KEY_FIGURE_PROPERTY_KEYS: ReadonlyArray<keyof KeyFigureProperties> = [
  'aggregation', 'exception_aggregation', 'exception_aggregation_reference', 'decimal_places',
  'display_scaling', 'data_type', 'high_precision',
];

/** The standard aggregations of a key figure, by key figure type and data type. */
const STANDARD_AGGREGATIONS = ['SUM', 'MIN', 'MAX', 'NO2'];
const DATE_TIME_AGGREGATIONS = ['MIN', 'MAX'];

/** Every aggregation BW knows; an exception aggregation is one of these other than the standard one. */
const AGGREGATION_TYPES = [
  'MAX', 'MIN', 'SUM', 'NOP', 'NO1', 'NO2', 'AV0', 'AV1', 'AV2', 'AVG', 'CN0', 'CNT', 'FIR', 'LAS', 'STD', 'VAR',
  'NHA', 'NGA', 'MED', 'SLS', 'SLI', 'SLC',
];

/** The data types a key figure type can have, the first being the one BW falls back to. */
const KEY_FIGURE_DATA_TYPES: Record<string, string[]> = {
  AMO: ['CURR', 'FLTP'],
  NUM: ['FLTP', 'DEC'],
  DAT: ['DEC', 'DATS'],
  QUA: ['FLTP', 'QUAN'],
  INT: ['INT4', 'INT8'],
  TIM: ['DEC', 'TIMS'],
};

const HIGH_PRECISION_DATA_TYPES = ['CURR', 'QUAN', 'DEC'];

function elementText(xml: string, name: string): string | undefined {
  return xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];
}

/** Set the text of a simple element, inserting it in front of the first anchor that exists. */
function setElement(xml: string, name: string, value: string, anchors: string[]): string {
  const element = `<${name}>${value}</${name}>`;
  const existing = new RegExp(`<${name}>[^<]*</${name}>|<${name}/>`);
  if (existing.test(xml)) return xml.replace(existing, element);
  for (const anchor of anchors) {
    const at = xml.search(new RegExp(`<${anchor}[\\s/>]`));
    if (at >= 0) return xml.slice(0, at) + element + xml.slice(at);
  }
  throw new Error(`Cannot place <${name}>: the document has none of ${anchors.join(', ')}.`);
}

function removeElement(xml: string, name: string): string {
  return xml.replace(new RegExp(`<${name}\\b[^>]*/>|<${name}\\b[^>]*>[\\s\\S]*?</${name}>`), '');
}

function rootAttribute(xml: string, name: string): string | undefined {
  return xml.match(/<iobj:infoObject\b[^>]*>/)?.[0].match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

function setRootAttribute(xml: string, name: string, value: string): string {
  return xml.replace(/<iobj:infoObject\b[^>]*>/, (root) =>
    new RegExp(`\\s${name}="[^"]*"`).test(root)
      ? root.replace(new RegExp(`\\s${name}="[^"]*"`), ` ${name}="${value}"`)
      : root.replace(/^<iobj:infoObject\b/, `<iobj:infoObject ${name}="${value}"`),
  );
}

/** A value inside <displayProperties>, which every InfoObject document has. */
function setDisplayProperty(xml: string, name: string, value: string | undefined): string {
  const block = xml.match(/<displayProperties>([\s\S]*?)<\/displayProperties>|<displayProperties\/>/);
  if (!block) throw new Error('The document has no <displayProperties> element.');
  let inner = (block[1] ?? '').replace(new RegExp(`<${name}>[^<]*</${name}>`), '');
  if (value !== undefined) inner += `<${name}>${value}</${name}>`;
  return xml.replace(block[0], `<displayProperties>${inner}</displayProperties>`);
}

function digitSetting(value: number | 'default', what: string): string | undefined {
  if (value === 'default') return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 9) throw new Error(`${what} is a whole number from 0 to 9, or "default".`);
  return String(value);
}

/**
 * The settings of a key figure the modeling tools offer on its General page, with their rules: a
 * date or time key figure only takes the minimum or the maximum, an exception aggregation differs
 * from the standard aggregation and needs a reference characteristic, a key figure that is not
 * aggregated has none, decimal places and scaling do not apply to dates and times, and each key
 * figure type has its data types.
 */
export function applyKeyFigureProperties(xml: string, args: KeyFigureProperties): { xml: string; changes: string[] } {
  let out = xml;
  const changes: string[] = [];
  const type = rootAttribute(out, 'keyfigureType') ?? '';
  let dataType = elementText(out, 'dataType') ?? '';

  if (args.data_type !== undefined) {
    const wanted = args.data_type.trim().toUpperCase();
    const allowed = KEY_FIGURE_DATA_TYPES[type] ?? [];
    if (!allowed.includes(wanted)) {
      throw new Error(`A key figure of type ${type} has the data type ${allowed.join(' or ')}, not ${wanted}.`);
    }
    if (wanted !== dataType) {
      out = setRootAttribute(setElement(out, 'dataType', wanted, ['longDescription']), 'objectSpecificDataType', wanted);
      changes.push(`data type ${dataType} → ${wanted}`);
      dataType = wanted;
      if (!HIGH_PRECISION_DATA_TYPES.includes(wanted) && elementText(out, 'highPrecision') === 'true' && args.high_precision === undefined) {
        out = setElement(out, 'highPrecision', 'false', ['aggregationType']);
        changes.push('high precision off (not available for this data type)');
      }
    }
  }

  const dateOrTime = (type === 'DAT' && dataType === 'DATS') || (type === 'TIM' && dataType === 'TIMS');
  let aggregation = elementText(out, 'aggregationType') ?? 'SUM';
  if (args.aggregation !== undefined) {
    const wanted = args.aggregation.trim().toUpperCase();
    const allowed = dateOrTime ? DATE_TIME_AGGREGATIONS : STANDARD_AGGREGATIONS;
    if (!allowed.includes(wanted)) {
      throw new Error(
        `Aggregation ${wanted} is not available for this key figure: ${allowed.join(', ')}` +
        `${dateOrTime ? ' (a date or time key figure has only the minimum and the maximum)' : ''}.`,
      );
    }
    if (wanted !== aggregation) {
      out = setElement(out, 'aggregationType', wanted, ['exceptionAggregation', 'fixedCurrency', 'fixedUnit', 'unitCurrencyInfoObjectRef']);
      changes.push(`aggregation ${aggregation} → ${wanted}`);
      aggregation = wanted;
    }
  }

  const exception = out.match(/<exceptionAggregation\b[^>]*>([\s\S]*?)<\/exceptionAggregation>/);
  const exceptionNow = exception?.[1].match(/<aggregationType>([^<]*)<\/aggregationType>/)?.[1];
  const referenceNow = exception?.[1].match(/<referencedCharacteristic\b[^>]*\bname="([^"]*)"/)?.[1];
  const wantsException = args.exception_aggregation !== undefined || args.exception_aggregation_reference !== undefined;
  if (aggregation === 'NO2' && (wantsException ? args.exception_aggregation?.trim().toLowerCase() !== 'none' : false)) {
    throw new Error('A key figure with the aggregation NO2 (no aggregation) has no exception aggregation.');
  }
  if (aggregation === 'NO2' && exceptionNow) {
    out = removeElement(out, 'exceptionAggregation');
    changes.push(`exception aggregation ${exceptionNow} removed (the key figure is not aggregated)`);
  } else if (wantsException) {
    const wanted = (args.exception_aggregation ?? exceptionNow ?? '').trim().toUpperCase();
    if (wanted === 'NONE') {
      if (args.exception_aggregation_reference) throw new Error('exception_aggregation "none" takes no exception_aggregation_reference.');
      if (exceptionNow) {
        out = removeElement(out, 'exceptionAggregation');
        changes.push(`exception aggregation ${exceptionNow} removed`);
      }
    } else {
      if (!wanted) throw new Error('exception_aggregation_reference needs exception_aggregation, the aggregation along that characteristic.');
      if (!AGGREGATION_TYPES.includes(wanted)) {
        throw new Error(`Unknown exception aggregation ${wanted}. Valid values: ${AGGREGATION_TYPES.join(', ')}, or "none".`);
      }
      if (wanted === aggregation) {
        throw new Error(`The exception aggregation has to differ from the standard aggregation ${aggregation}.`);
      }
      const reference = (args.exception_aggregation_reference ?? referenceNow ?? '').trim().toUpperCase();
      if (!reference) {
        throw new Error('An exception aggregation needs exception_aggregation_reference, the characteristic it aggregates along.');
      }
      if (wanted !== exceptionNow || reference !== referenceNow) {
        const element =
          `<exceptionAggregation><aggregationType>${wanted}</aggregationType>` +
          `<referencedCharacteristic name="${reference}"/></exceptionAggregation>`;
        out = removeElement(out, 'exceptionAggregation');
        const at = out.indexOf('</aggregationType>') + '</aggregationType>'.length;
        out = out.slice(0, at) + element + out.slice(at);
        changes.push(`exception aggregation ${wanted} along ${reference}`);
      }
    }
  }

  if (args.high_precision !== undefined) {
    if (args.high_precision && !HIGH_PRECISION_DATA_TYPES.includes(dataType)) {
      throw new Error(`High precision is available for the data types ${HIGH_PRECISION_DATA_TYPES.join(', ')}, not for ${dataType}.`);
    }
    const value = String(args.high_precision);
    if ((elementText(out, 'highPrecision') ?? 'false') !== value) {
      out = setElement(out, 'highPrecision', value, ['aggregationType']);
      changes.push(`high precision ${args.high_precision ? 'on' : 'off'}`);
    }
  }

  for (const [arg, element, what] of [
    ['decimal_places', 'decimalPlaces', 'decimal places'],
    ['display_scaling', 'digitsToDisplay', 'display scaling'],
  ] as const) {
    const value = args[arg];
    if (value === undefined) continue;
    if (type === 'DAT' || type === 'TIM') throw new Error(`${arg} does not apply to a date or time key figure.`);
    const wanted = digitSetting(value, arg);
    const block = out.match(/<displayProperties>([\s\S]*?)<\/displayProperties>/)?.[1] ?? '';
    const now = block.match(new RegExp(`<${element}>([^<]*)</${element}>`))?.[1];
    if (now !== wanted) {
      out = setDisplayProperty(out, element, wanted);
      changes.push(`${what} ${wanted ?? 'default'}`);
    }
  }

  return { xml: out, changes };
}

export interface CharacteristicProperties {
  data_type?: string;
  length?: number;
  output_length?: number;
  /** A conversion routine such as "ALPHA"; an empty text removes it. */
  conversion_routine?: string;
  high_cardinality?: boolean;
  authorization_relevant?: boolean;
  display?: string;
  filter_values_query_definition?: string;
  filter_values_query_execution?: string;
  filter_value_display?: string;
}

export const CHARACTERISTIC_PROPERTY_KEYS: ReadonlyArray<keyof CharacteristicProperties> = [
  'length', 'output_length', 'conversion_routine', 'high_cardinality', 'authorization_relevant', 'display',
  'filter_values_query_definition', 'filter_values_query_execution', 'filter_value_display',
];

const CHARACTERISTIC_DATA_TYPES = ['CHAR', 'NUMC', 'DATS', 'TIMS', 'CUKY', 'LANG', 'UNIT', 'RAW', 'INT1', 'INT2', 'INT4', 'INT8'];

/** How a characteristic is shown in a query, as the BI Clients page names it. */
const DISPLAY_CODES: Record<string, string> = {
  key_and_text: '0', text: '1', key: '2', text_and_key: '3', long_text: '4', medium_text: '5', no_display: '6', short_text: '7',
};
const FILTER_DEFINITION_CODES: Record<string, string> = { master_data: 'M', infoprovider: 'D' };
const FILTER_EXECUTION_CODES: Record<string, string> = { navigation: 'Q', infoprovider: 'D', master_data: 'M' };
const FILTER_DISPLAY_CODES: Record<string, string> = {
  without_values: '_', with_values: '0', field_only: '1', with_input_help: '2', radio_button: '3', dropdown_box: '4',
  combo_box: '5', input_help_only: '6', checkboxes: '7',
};

function codeOf(table: Record<string, string>, value: string, argument: string): string {
  const code = table[value.trim().toLowerCase()];
  if (code === undefined) throw new Error(`Unknown ${argument} "${value}". Valid values: ${Object.keys(table).join(', ')}.`);
  return code;
}

function setBooleanElement(xml: string, name: string, value: boolean, anchors: string[]): { xml: string; changed: boolean } {
  const now = elementText(xml, name) ?? 'false';
  if (now === String(value)) return { xml, changed: false };
  return { xml: setElement(xml, name, String(value), anchors), changed: true };
}

/**
 * The settings of a characteristic on the General and BI Clients pages: data type, length, output
 * length and conversion routine, high cardinality, authorization relevance, the display in a
 * query and where the filter values of a query come from. The output length follows a longer
 * length, as in the editor; whether a data type or length change is possible with the data that
 * exists is decided by the activation.
 */
export function applyCharacteristicProperties(xml: string, args: CharacteristicProperties): { xml: string; changes: string[] } {
  let out = xml;
  const changes: string[] = [];

  if (args.data_type !== undefined) {
    const wanted = args.data_type.trim().toUpperCase();
    if (!CHARACTERISTIC_DATA_TYPES.includes(wanted)) {
      throw new Error(`A characteristic has one of the data types ${CHARACTERISTIC_DATA_TYPES.join(', ')}, not ${wanted}.`);
    }
    const now = elementText(out, 'dataType') ?? '';
    if (wanted !== now) {
      out = setRootAttribute(setElement(out, 'dataType', wanted, ['longDescription']), 'objectSpecificDataType', wanted);
      changes.push(`data type ${now} → ${wanted}`);
    }
  }

  if (args.length !== undefined) {
    if (!Number.isInteger(args.length) || args.length < 1 || args.length > 250) throw new Error('length is a whole number from 1 to 250.');
    const now = Number(elementText(out, 'length') ?? 0);
    if (args.length !== now) {
      out = setElement(out, 'length', String(args.length), ['displayProperties']);
      changes.push(`length ${now} → ${args.length}`);
      const output = Number(rootAttribute(out, 'outputLength') ?? 0);
      if (args.output_length === undefined && args.length > output) {
        out = setRootAttribute(out, 'outputLength', String(args.length));
        changes.push(`output length ${output} → ${args.length}`);
      }
    }
  }

  if (args.output_length !== undefined) {
    if (!Number.isInteger(args.output_length) || args.output_length < 0 || args.output_length > 250) {
      throw new Error('output_length is a whole number from 0 to 250.');
    }
    const now = rootAttribute(out, 'outputLength') ?? '0';
    if (String(args.output_length) !== now) {
      out = setRootAttribute(out, 'outputLength', String(args.output_length));
      changes.push(`output length ${now} → ${args.output_length}`);
    }
  }

  if (args.conversion_routine !== undefined) {
    const wanted = args.conversion_routine.trim().toUpperCase();
    if (!/^[A-Z0-9_/]{0,5}$/.test(wanted)) throw new Error('conversion_routine is the name of a conversion exit of up to five characters, such as "ALPHA".');
    const now = rootAttribute(out, 'conversionRoutine') ?? '';
    if (wanted !== now) {
      out = wanted
        ? setRootAttribute(out, 'conversionRoutine', wanted)
        : out.replace(/<iobj:infoObject\b[^>]*>/, (root) => root.replace(/\sconversionRoutine="[^"]*"/, ''));
      changes.push(wanted ? `conversion routine ${now || '(none)'} → ${wanted}` : `conversion routine ${now} removed`);
    }
  }

  if (args.authorization_relevant !== undefined) {
    const set = setBooleanElement(out, 'authorizationRelevant', args.authorization_relevant, ['documentProperty', 'displayProperties']);
    out = set.xml;
    if (set.changed) changes.push(`authorization relevant ${args.authorization_relevant ? 'on' : 'off'}`);
  }

  if (args.high_cardinality !== undefined) {
    const set = setBooleanElement(out, 'highCardinality', args.high_cardinality, ['bexMap', 'compoundParent', 'attributeN', 'runtimeProperties']);
    out = set.xml;
    if (set.changed) changes.push(`high cardinality ${args.high_cardinality ? 'on' : 'off'}`);
  }

  if (args.display !== undefined) {
    const code = codeOf(DISPLAY_CODES, args.display, 'display');
    const block = out.match(/<displayProperties>([\s\S]*?)<\/displayProperties>/)?.[1] ?? '';
    if (block.match(/<display>([^<]*)<\/display>/)?.[1] !== code) {
      const inner = /<display>[^<]*<\/display>/.test(block)
        ? block.replace(/<display>[^<]*<\/display>/, `<display>${code}</display>`)
        : block.replace(/(<selection>|$)/, `<display>${code}</display>$1`);
      out = out.replace(/<displayProperties>[\s\S]*?<\/displayProperties>/, `<displayProperties>${inner}</displayProperties>`);
      changes.push(`display ${args.display.trim().toLowerCase()}`);
    }
  }

  const filter = out.match(/<queryFilterValue\b[^>]*\/>/)?.[0];
  let newFilter = filter;
  for (const [arg, attribute, table] of [
    ['filter_values_query_definition', 'forQueryDefinition', FILTER_DEFINITION_CODES],
    ['filter_values_query_execution', 'forQueryExecution', FILTER_EXECUTION_CODES],
    ['filter_value_display', 'duringQueryExecution', FILTER_DISPLAY_CODES],
  ] as const) {
    const value = args[arg];
    if (value === undefined) continue;
    if (!newFilter) throw new Error('The document has no <queryFilterValue> element.');
    const code = codeOf(table, value, arg);
    if (newFilter.match(new RegExp(`\\s${attribute}="([^"]*)"`))?.[1] === code) continue;
    newFilter = new RegExp(`\\s${attribute}="[^"]*"`).test(newFilter)
      ? newFilter.replace(new RegExp(`\\s${attribute}="[^"]*"`), ` ${attribute}="${code}"`)
      : newFilter.replace(/\/>$/, ` ${attribute}="${code}"/>`);
    changes.push(`${arg.replace(/_/g, ' ')} ${value.trim().toLowerCase()}`);
  }
  if (filter && newFilter && newFilter !== filter) out = out.replace(filter, newFilter);

  return { xml: out, changes };
}

/**
 * The XXL attributes of a characteristic: the complete list of XXL InfoObjects that hold long
 * texts or binary content per value. They sit behind the master data elements of the document.
 */
export function applyXxlAttributes(xml: string, names: string[] | undefined): { xml: string; changes: string[] } {
  if (names === undefined) return { xml, changes: [] };
  const wanted = names.map((n) => n.trim().toUpperCase()).filter(Boolean);
  const duplicate = wanted.find((n, i) => wanted.indexOf(n) !== i);
  if (duplicate) throw new Error(`XXL attribute ${duplicate} is listed twice.`);
  const element = /<xxlAttribute\b[^>]*(?:\/>|>[\s\S]*?<\/xxlAttribute>)/g;
  const now = [...xml.matchAll(element)].map((m) => m[0].match(/\bname="([^"]+)"/)?.[1] ?? '');
  if (now.length === wanted.length && now.every((n, i) => n === wanted[i])) return { xml, changes: [] };
  if (wanted.length > 0 && !/<masterDataProperties\b[^>]*\bwithMasterData="true"/.test(xml)) {
    throw new Error('XXL attributes need master data: pass with_master_data true in the same call.');
  }
  const kept = new Map([...xml.matchAll(element)].map((m) => [m[0].match(/\bname="([^"]+)"/)?.[1] ?? '', m[0]]));
  const list = wanted.map((n) => kept.get(n) ?? `<xxlAttribute name="${n}"/>`).join('');
  let out = xml.replace(element, '');
  const at = out.search(/<semantics[\s/>]/);
  out = at >= 0 ? out.slice(0, at) + list + out.slice(at) : out.replace('</iobj:infoObject>', `${list}</iobj:infoObject>`);
  return { xml: out, changes: [`XXL attributes ${wanted.join(', ') || '(none)'}`] };
}

/** Whether an InfoObject can only be an attribute, a switch every InfoObject type has. */
export function applyAttributeOnly(xml: string, attributeOnly: boolean | undefined): { xml: string; changes: string[] } {
  if (attributeOnly === undefined) return { xml, changes: [] };
  if ((rootAttribute(xml, 'attributeOnly') ?? 'false') === String(attributeOnly)) return { xml, changes: [] };
  return { xml: setRootAttribute(xml, 'attributeOnly', String(attributeOnly)), changes: [`attribute only ${attributeOnly ? 'on' : 'off'}`] };
}
