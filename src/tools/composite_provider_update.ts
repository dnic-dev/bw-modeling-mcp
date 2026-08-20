import {
  BwClient,
  MEDIA_TYPES,
  createClientFromEnv,
  freshRead,
  bwSeg,
  bwEscapeName,
} from '../bw-client.js';

/** Resolved per call, not once at import — see the note on adsoAccept() in adso.ts. */
const hcprAccept = (): string => MEDIA_TYPES['hcpr'];
const IPROV_ACCEPT = 'application/vnd.sap.bw.modeling.iprov-v1_14_0+xml';

export type CompositeProviderFieldAction = 'add_field' | 'remove_field';

interface CompositeInput {
  /** Full `<input ...>...</input>` block as it appears in the model. */
  block: string;
  alias: string;
  providerName: string;
}

function attr(source: string, key: string): string {
  return source.match(new RegExp(`\\b${key.replace(':', '\\:')}="([^"]*)"`))?.[1] ?? '';
}

/** Literal replace of the first occurrence — String.replace would expand `$` patterns. */
function replaceOnce(haystack: string, needle: string, replacement: string): string {
  const idx = haystack.indexOf(needle);
  if (idx === -1) return haystack;
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * Split the model into the part before the first `<input` (holding all `<element>` blocks)
 * and the rest. Elements placed after an input are not part of the CP field list.
 */
function splitAtFirstInput(xml: string): { head: string; tail: string } {
  const idx = xml.indexOf('<input');
  if (idx === -1) return { head: xml, tail: '' };
  return { head: xml.slice(0, idx), tail: xml.slice(idx) };
}

function parseInputs(xml: string): CompositeInput[] {
  const inputs: CompositeInput[] = [];
  const re = /<input\b[\s\S]*?<\/input>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[0];
    const openTag = block.match(/<input\b[^>]*>/)?.[0] ?? '';
    const entity = block.match(/<entity>([^<]*)<\/entity>/)?.[1] ?? '';
    const providerName =
      attr(openTag, 'name') || entity.split('/').pop()?.replace(/\.composite#\/\/$/, '') || '';
    inputs.push({ block, alias: attr(openTag, 'alias'), providerName: providerName.toUpperCase() });
  }
  return inputs;
}

/** Extract the `<element>` block of one field from a part provider or CP model. */
function findElement(xml: string, fieldName: string): string | null {
  const re = new RegExp(`<element\\b[^>]*\\bname="${fieldName}"[^>]*>[\\s\\S]*?<\\/element>`, 'g');
  const match = re.exec(xml);
  if (match) return match[0];
  const selfClosing = new RegExp(`<element\\b[^>]*\\bname="${fieldName}"[^>]*\\/>`).exec(xml);
  return selfClosing ? selfClosing[0] : null;
}

/**
 * Build the CP `<element>` from the corresponding element of a part provider
 * (`/infoprov/{name}/a?view=dt`).
 *
 * The provider view carries more than the CP model accepts: `<dataElementName>` inside
 * `<inlineType>`, the display / selection entries of `<localProperties>`, `<atom:link>` and
 * `<consumptionViewProperties>` are all server-side annotations and are left out.
 * `<semantics>` is deliberately not generated — the server derives it.
 */
function buildCompositeElement(providerElement: string, fieldName: string): string {
  const openTag = providerElement.match(/<element\b[^>]*?>/)?.[0] ?? '';
  const isKeyFigure =
    /consumptionViewProperties\b[^>]*objectType="KYF"/.test(providerElement) ||
    /<localProperties\b[^>]*LocalKeyfigureProperties/.test(providerElement);

  const aggregationBehavior = attr(openTag, 'aggregationBehavior');
  const conversionRoutine = attr(openTag, 'conversionRoutine');
  const outputLengthRaw = attr(openTag, 'outputLength');
  const outputLength = outputLengthRaw.replace(/^0+(?=\d)/, '');
  const label = providerElement.match(/<endUserTexts\b[^>]*\blabel="([^"]*)"/)?.[1] ?? '';

  const inlineOpen = providerElement.match(/<inlineType\b[^>]*?\/?>/)?.[0] ?? '';
  const inlineAttrs = ['name', 'globalElementName', 'length', 'precision', 'scale', 'semanticType']
    .map((key) => {
      const value = attr(inlineOpen, key);
      return value ? ` ${key}="${value}"` : '';
    })
    .join('');

  const attrs = [
    ` xsi:type="BwCore:BwElement"`,
    ` name="${fieldName}"`,
    ` infoObjectName="${fieldName}"`,
    aggregationBehavior ? ` aggregationBehavior="${aggregationBehavior}"` : '',
    conversionRoutine ? ` conversionRoutine="${conversionRoutine}"` : '',
    outputLength ? ` outputLength="${outputLength}"` : '',
  ].join('');

  const localProperties = isKeyFigure
    ? '<localProperties xsi:type="BwCore:LocalKeyfigureProperties"/>'
    : '<localProperties xsi:type="BwCore:LocalCharacteristicProperties">' +
      '<authorizationRelevant>N</authorizationRelevant>' +
      '</localProperties>';

  return (
    `<element${attrs}>` +
    `<endUserTexts label="${label}"/>` +
    `<inlineType${inlineAttrs}/>` +
    localProperties +
    '<associationType>1</associationType>' +
    '</element>'
  );
}

function buildMapping(fieldName: string): string {
  return `<mapping xsi:type="Type:ElementMapping" targetName="${fieldName}" sourceName="${fieldName}"/>`;
}

/** Append a mapping as the last child of one specific `<input>` block. */
function appendMapping(xml: string, input: CompositeInput, fieldName: string): string {
  const updatedBlock = input.block.replace(/<\/input>$/, `${buildMapping(fieldName)}</input>`);
  const result = replaceOnce(xml, input.block, updatedBlock);
  input.block = updatedBlock;
  return result;
}

function removeCompositeElement(xml: string, fieldName: string): string {
  const { head, tail } = splitAtFirstInput(xml);
  const element = findElement(head, fieldName);
  const strippedHead = element ? replaceOnce(head, element, '') : head;
  const mappingRe = new RegExp(`<mapping\\b[^>]*\\btargetName="${fieldName}"[^>]*\\/>`, 'g');
  return strippedHead + tail.replace(mappingRe, '');
}

/**
 * bw_update_composite_provider — add or remove one or more fields of a CompositeProvider.
 *
 * Read-modify-write on the complete `/m` model: the PUT body is the model as read, with the
 * `<element>` list and the `<mapping>` entries of the affected `<input>` blocks edited.
 * A field needs both parts — an element without a mapping stays empty at runtime, and
 * activation does not warn about it.
 *
 * Metadata for a new element comes from the part provider view (`/infoprov/{name}/a?view=dt`),
 * not from the InfoObject: that is where aggregation behaviour and output length are defined as
 * the provider sees them, and reading it proves the field exists in that provider.
 *
 * Returns the lockHandle so the caller can invoke bw_activate next.
 */
export async function bwUpdateCompositeProvider(
  client: BwClient,
  compositeProviderName: string,
  infoObjectName: string,
  action: CompositeProviderFieldAction = 'add_field',
  sourceProviders?: string,
  transport?: string
): Promise<string> {
  const cpUpper = compositeProviderName.toUpperCase();
  const fieldNames = splitList(infoObjectName);
  const providerFilter = splitList(sourceProviders);

  if (fieldNames.length === 0) {
    return JSON.stringify({
      success: false,
      message: 'No field name given. Pass one or more InfoObject names in info_object_name.',
    });
  }

  const cpPath = `/sap/bw/modeling/hcpr/${bwSeg(compositeProviderName)}/m`;
  const cpResult = await freshRead(cpPath, hcprAccept());
  const timestamp = cpResult.headers['timestamp'] ?? cpResult.headers['TIMESTAMP'];
  let xml = cpResult.body;

  const inputs = parseInputs(xml);
  const processed: string[] = [];
  const skipped: Array<{ field: string; reason: string }> = [];
  const mapped: Array<{ field: string; part_providers: string[] }> = [];

  if (action === 'remove_field') {
    for (const field of fieldNames) {
      const { head } = splitAtFirstInput(xml);
      if (!findElement(head, field)) {
        skipped.push({ field, reason: `not present in CompositeProvider ${cpUpper}` });
        continue;
      }
      xml = removeCompositeElement(xml, field);
      processed.push(field);
    }
  } else {
    const candidates = providerFilter.length
      ? inputs.filter(
          (input) =>
            providerFilter.includes(input.providerName) ||
            providerFilter.includes(input.alias.toUpperCase())
        )
      : inputs;

    if (candidates.length === 0) {
      return JSON.stringify({
        success: false,
        message:
          `None of the given source providers is a part provider of ${cpUpper}. ` +
          `Available: ${inputs.map((i) => `${i.providerName} (${i.alias})`).join(', ')}`,
      });
    }

    // One fresh reader session for all part provider reads: a provider changed earlier through
    // the shared client could otherwise be served from a stale session buffer.
    const providerReader = createClientFromEnv();
    const providerViews = new Map<string, string>();
    const readProvider = async (name: string): Promise<string> => {
      const cached = providerViews.get(name);
      if (cached !== undefined) return cached;
      const result = await providerReader.get(
        `/sap/bw/modeling/infoprov/${encodeURIComponent(bwEscapeName(name))}/a?view=dt`,
        IPROV_ACCEPT
      );
      providerViews.set(name, result.body);
      return result.body;
    };

    for (const field of fieldNames) {
      const { head } = splitAtFirstInput(xml);
      if (findElement(head, field)) {
        skipped.push({ field, reason: `already present in CompositeProvider ${cpUpper}` });
        continue;
      }

      const hits: Array<{ input: CompositeInput; element: string }> = [];
      for (const input of candidates) {
        const providerElement = findElement(await readProvider(input.providerName), field);
        if (providerElement) hits.push({ input, element: providerElement });
      }

      if (hits.length === 0) {
        skipped.push({
          field,
          reason: `not found in part provider(s) ${candidates.map((i) => i.providerName).join(', ')}`,
        });
        continue;
      }

      const elementXml = buildCompositeElement(hits[0].element, field);
      const idx = xml.indexOf('<input');
      xml = idx === -1 ? xml.replace('</viewNode>', `${elementXml}</viewNode>`)
                       : xml.slice(0, idx) + elementXml + xml.slice(idx);

      for (const hit of hits) xml = appendMapping(xml, hit.input, field);

      processed.push(field);
      mapped.push({ field, part_providers: hits.map((h) => h.input.providerName) });
    }
  }

  if (processed.length === 0) {
    return JSON.stringify({
      success: false,
      message: `No field changed in CompositeProvider ${cpUpper}.`,
      skipped,
    });
  }

  const lockHandle = await client.lock('hcpr', compositeProviderName);
  try {
    await client.put('hcpr', compositeProviderName, lockHandle, xml, timestamp, transport);
  } catch (err) {
    await client.unlock('hcpr', compositeProviderName).catch(() => {/* ignore unlock error */});
    throw err;
  }

  const verb = action === 'remove_field' ? 'removed from' : 'added to';
  const result: Record<string, unknown> = {
    success: true,
    message: `${processed.join(', ')} ${verb} CompositeProvider ${cpUpper}. Call bw_activate to activate.`,
    lock_handle: lockHandle,
    composite_provider_name: cpUpper,
    object_type: 'hcpr',
    processed,
  };
  if (mapped.length > 0) result['mapped'] = mapped;
  if (skipped.length > 0) result['skipped'] = skipped;
  return JSON.stringify(result);
}
