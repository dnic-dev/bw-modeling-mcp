import {
  BwClient,
  MEDIA_TYPES,
  createClientFromEnv,
  freshRead,
  resolveMasterSystem,
  bwSeg,
  bwSegUpper,
} from '../bw-client.js';
import { bwActivate } from './activation.js';

interface XrefEntry {
  objectName: string;
  objectType: string;
  objectStatus: string;
  title: string;
  href: string;
}

/**
 * Parse <atom:entry> elements from a BW Atom feed (xref / search responses).
 * Each entry contains a <bwModel:object> with objectName, objectType, objectStatus.
 */
function parseAtomEntries(xml: string): XrefEntry[] {
  const entries: XrefEntry[] = [];
  const entryRegex = /<atom:entry>([\s\S]*?)<\/atom:entry>/g;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(xml)) !== null) {
    const body = match[1];
    const nameMatch = body.match(/objectName="([^"]+)"/);
    const typeMatch = body.match(/objectType="([^"]+)"/);
    const statusMatch = body.match(/objectStatus="([^"]+)"/);
    const titleMatch = body.match(/<atom:title>([^<]+)<\/atom:title>/);
    const hrefMatch = body.match(/href="([^"]+)"/);

    if (nameMatch && typeMatch) {
      entries.push({
        objectName: nameMatch[1],
        objectType: typeMatch[1],
        objectStatus: statusMatch?.[1] ?? 'unknown',
        title: titleMatch?.[1] ?? '',
        href: hrefMatch?.[1] ?? '',
      });
    }
  }
  return entries;
}

/**
 * bw_get_dtps — list DTPs that depend on an object (via xref).
 *
 * Uses the cross-reference endpoint to find all DTPA objects that use the given object.
 * Filters xref results to objectType=DTPA only.
 *
 * After activating a Transformation, the activation response lists deactivated DTPs.
 * This tool can be used independently to find dependent DTPs before activation.
 */
export async function bwGetDtps(
  client: BwClient,
  objectType: string,
  objectName: string
): Promise<string> {
  const path = `/sap/bw/modeling/repo/is/xref?objectType=${encodeURIComponent(objectType.toUpperCase())}&objectName=${encodeURIComponent(objectName.toUpperCase())}`;
  const result = await client.get(path, 'application/atom+xml;type=feed');

  const allEntries = parseAtomEntries(result.body);
  const dtps = allEntries.filter((e) => e.objectType === 'DTPA');

  if (dtps.length === 0) {
    return `No dependent DTPs found for ${objectType.toUpperCase()} ${objectName.toUpperCase()}.`;
  }

  const lines = [
    `Found ${dtps.length} DTP(s) dependent on ${objectType.toUpperCase()} ${objectName.toUpperCase()}:`,
    '',
    ...dtps.map(
      (d, i) =>
        `${i + 1}. ${d.objectName} — status: ${d.objectStatus}` +
        (d.title ? ` — "${d.title}"` : '')
    ),
    '',
    'To activate all inactive DTPs: call bw_activate for each with object_type="dtpa" and lock_handle="".',
  ];

  return lines.join('\n');
}

/**
 * bw_get_dtp_details — read a single DTP definition.
 * (Used internally; exposed via bw_get_dtps in index.ts if needed.)
 */
export async function bwGetDtpDetails(client: BwClient, dtpName: string): Promise<string> {
  const path = `/sap/bw/modeling/dtpa/${bwSeg(dtpName)}/m`;
  const result = await freshRead(path, MEDIA_TYPES['dtpa']);
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';
  return `DTP: ${dtpName.toUpperCase()}\nStatus: ${status}\n\n${result.body}`;
}

// ── bwGetDtp ──────────────────────────────────────────────────────────────────

interface DtpFilterSelection {
  operator: string;
  excluding: boolean;
  low: string;
  high: string;
}

interface DtpFilterField {
  name: string;
  dtaName: string;
  description: string;
  selected: boolean;
  selections: DtpFilterSelection[];
  hasRoutine: boolean;
  routineCode: string[];
}

interface DtpInfo {
  name: string;
  description: string;
  status: string;
  source: { type: string; name: string; description: string };
  target: { type: string; name: string; description: string };
  transformation: { name: string; description: string };
  extractionMode: string;
  packageSize: string;
  filterFields: DtpFilterField[];
  globalRoutineCode: string[];
  semanticGroupFields: { name: string; description: string; isKey: boolean; isField: boolean }[];
}

function parseDtpXml(xml: string, status: string): DtpInfo {
  const attr = (tag: string, name: string) => {
    const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
    return m ? m[1] : '';
  };

  // Root attributes
  const rootMatch = xml.match(/<dtpa:dataTransferProcess([^>]*)>/);
  const rootAttrs = rootMatch?.[1] ?? '';
  const name = attr(rootAttrs, 'name');
  const description = attr(rootAttrs, 'description');

  // Extraction settings
  const extrMatch = xml.match(/<extractionSettings([^>]*)\/?>/);
  const extractionMode = attr(extrMatch?.[1] ?? '', 'extractionMode');
  const packageSize = attr(extrMatch?.[1] ?? '', 'packageSize');

  // Source / target
  const srcMatch = xml.match(/<source([^>]*)\/?>/);
  const tgtMatch = xml.match(/<target([^>]*)\/?>/);
  const source = {
    type: attr(srcMatch?.[1] ?? '', 'type'),
    name: attr(srcMatch?.[1] ?? '', 'name'),
    description: attr(srcMatch?.[1] ?? '', 'description'),
  };
  const target = {
    type: attr(tgtMatch?.[1] ?? '', 'type'),
    name: attr(tgtMatch?.[1] ?? '', 'name'),
    description: attr(tgtMatch?.[1] ?? '', 'description'),
  };

  // Transformation (overview/object)
  const ovMatch = xml.match(/<overview>[\s\S]*?<object([^>]*)\/?>[\s\S]*?<\/overview>/);
  const transformation = {
    name: attr(ovMatch?.[1] ?? '', 'name'),
    description: attr(ovMatch?.[1] ?? '', 'description'),
  };

  // Filter fields
  const filterFields: DtpFilterField[] = [];
  const fieldsRegex = /<fields([^>]*)>([\s\S]*?)<\/fields>/g;
  let fm: RegExpExecArray | null;
  while ((fm = fieldsRegex.exec(xml)) !== null) {
    const fieldAttrs = fm[1];
    const fieldBody = fm[2];

    const selections: DtpFilterSelection[] = [];
    const selRegex = /<selection\b([^>]*)(?:\/>|>([\s\S]*?)<\/selection>)/g;
    let sm: RegExpExecArray | null;
    while ((sm = selRegex.exec(fieldBody)) !== null) {
      const selAttrs = sm[1];
      const selBody = sm[2] ?? '';
      const operator = selAttrs.match(/\boperator="([^"]*)"/)?.[1] ?? '';
      const excluding = selAttrs.includes('excluding="true"');
      const low = selBody.match(/<low[^>]*\bvalue="([^"]*)"/)?.[1] ?? '';
      const high = selBody.match(/<high[^>]*\bvalue="([^"]*)"/)?.[1] ?? '';
      selections.push({ operator, excluding, low, high });
    }

    const hasRoutine = /<routine[\s>]/.test(fieldBody) && !/<routine\s*\/>/.test(fieldBody);
    const routineCode: string[] = [];
    if (hasRoutine) {
      const codeRegex = /<code(?:\s[^>]*)?>([^<]*)<\/code>/g;
      let cm: RegExpExecArray | null;
      while ((cm = codeRegex.exec(fieldBody)) !== null) {
        routineCode.push(cm[1]);
      }
    }

    filterFields.push({
      name: attr(fieldAttrs, 'name'),
      dtaName: attr(fieldAttrs, 'dtaName'),
      description: attr(fieldAttrs, 'description'),
      selected: fieldAttrs.includes('selected="true"'),
      selections,
      hasRoutine,
      routineCode,
    });
  }

  // Global routine code
  const globalRoutineCode: string[] = [];
  const globalRegex = /<globalRoutineCode>([^<]*)<\/globalRoutineCode>/g;
  let gm: RegExpExecArray | null;
  while ((gm = globalRegex.exec(xml)) !== null) {
    globalRoutineCode.push(gm[1]);
  }

  // Semantic group candidates. Entries with field="true" are plain fields or key figures,
  // the others are InfoObject-based and carry infoObjectType plus a reference.
  const semanticGroupFields: DtpInfo['semanticGroupFields'] = [];
  const sgBlock = xml.match(/<semanticGroup>[\s\S]*?<\/semanticGroup>/)?.[0] ?? '';
  const groupFieldRegex = /<groupField\b([^>]*)\/>/g;
  let sgm: RegExpExecArray | null;
  while ((sgm = groupFieldRegex.exec(sgBlock)) !== null) {
    const a = sgm[1];
    semanticGroupFields.push({
      name: attr(a, 'name'),
      description: attr(a, 'description'),
      isKey: /\bkeyField="true"/.test(a),
      isField: /\bfield="true"/.test(a),
    });
  }

  return {
    name,
    description,
    status,
    source,
    target,
    transformation,
    extractionMode,
    packageSize,
    filterFields,
    globalRoutineCode,
    semanticGroupFields,
  };
}

/**
 * bw_get_dtp — read a DTP definition and return a structured summary + raw XML.
 *
 * Flow:
 *   GET /sap/bw/modeling/dtpa/{dtpName}/m?forceCacheUpdate=true
 *   Parse key fields and return readable summary.
 */
export async function bwGetDtp(client: BwClient, dtpName: string): Promise<string> {
  // Fresh session: the shared client's buffer serves the stale inactive shadow
  // after this session touched the DTP (forceCacheUpdate alone does not help there).
  const path = `/sap/bw/modeling/dtpa/${bwSeg(dtpName)}/m`;
  const result = await freshRead(path, MEDIA_TYPES['dtpa']);
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';

  const info = parseDtpXml(result.body, status);

  const modeLabel = info.extractionMode === 'F' ? 'Full' : info.extractionMode === 'D' ? 'Delta' : info.extractionMode;

  const lines: string[] = [
    `DTP: ${info.name}`,
    `Status: ${info.status}`,
    `Description: ${info.description}`,
    '',
    `Source: ${info.source.type} ${info.source.name}` + (info.source.description ? ` — ${info.source.description}` : ''),
    `Target: ${info.target.type} ${info.target.name}` + (info.target.description ? ` — ${info.target.description}` : ''),
    `Transformation: ${info.transformation.name}` + (info.transformation.description ? ` — ${info.transformation.description}` : ''),
    '',
    `── Extraction Settings ──`,
    `  Mode:        ${modeLabel} (${info.extractionMode})`,
    `  Package Size: ${info.packageSize}`,
    '',
    `── Filter Fields (${info.filterFields.length}) ──`,
  ];

  if (info.filterFields.length === 0) {
    lines.push('  (no filter fields)');
  } else {
    for (const f of info.filterFields) {
      lines.push(`  [${f.selected ? 'selected' : 'inactive'}] ${f.name} (${f.dtaName})`);
      if (f.selections.length > 0) {
        for (const s of f.selections) {
          const sign = s.excluding ? 'E' : 'I';
          const val = s.low === '' ? "'' (BW initial value)" : `"${s.low}"`;
          const range = s.high === '' ? '' : ` .. "${s.high}"`;
          lines.push(`    → [${sign}] ${s.operator} ${val}${range}`);
        }
      }
      if (f.hasRoutine) {
        lines.push(`    → Routine (${f.routineCode.length} lines):`);
        for (const codeLine of f.routineCode) {
          lines.push(`       ${codeLine}`);
        }
      }
      if (!f.hasRoutine && f.selections.length === 0) {
        lines.push('    → (no selection / no routine)');
      }
    }
  }

  const sgSelected = info.semanticGroupFields.filter((f) => f.isKey);
  const sgAvailable = info.semanticGroupFields.filter((f) => !f.isKey);
  lines.push('', `── Semantic Group (${sgSelected.length} of ${info.semanticGroupFields.length} selected) ──`);
  if (info.semanticGroupFields.length === 0) {
    lines.push('  (no semantic group available for this DTP)');
  } else {
    if (sgSelected.length === 0) {
      lines.push('  (no field selected)');
    }
    for (const f of sgSelected) {
      lines.push(`  [key] ${f.name}${f.description ? ` — ${f.description}` : ''}`);
    }
    if (sgAvailable.length > 0) {
      lines.push(`  Available: ${sgAvailable.map((f) => f.name).join(', ')}`);
    }
  }

  if (info.globalRoutineCode.length > 0) {
    lines.push('', '── Global Routine Code ──');
    for (const line of info.globalRoutineCode) {
      lines.push(`  ${line}`);
    }
  }

  lines.push('', `── Raw XML ──`, result.body);

  return lines.join('\n');
}

// ── DTP lock release ──────────────────────────────────────────────────────────

/**
 * Release the enqueue lock held on a DTP (SM12: RSBKDTP, mode E).
 *
 * The DTP framework keeps an exclusive object lock for the lifetime of the
 * modeling session. bwActivate does not release it for dtpa and client.unlock
 * treats dtpa as no-op, so the lock must be freed with an explicit action=unlock —
 * otherwise the next run or edit on the same DTP hits a lock collision until the
 * entry is deleted manually in SM12. A fresh CSRF token is fetched because the
 * preceding activation nulls the cached one. Throws on an HTTP error so the manual
 * bw_unlock tool can surface it; callers using this in a finally block wrap it with
 * .catch() to keep it best-effort.
 */
export async function bwUnlockDtp(client: BwClient, dtpName: string): Promise<void> {
  const dtpLower = dtpName.toLowerCase();
  const csrf = await client.getCsrfToken();
  await client.rawPost(
    `/sap/bw/modeling/dtpa/${bwSeg(dtpLower)}?action=unlock`,
    '',
    {
      'Content-Type': MEDIA_TYPES['dtpa'],
      'Accept': MEDIA_TYPES['dtpa'],
      'x-csrf-token': csrf,
    }
  );
}

// ── DTP filter selections ─────────────────────────────────────────────────────

/**
 * One selection line of a DTP filter field, modelled on the ABAP range vocabulary:
 * sign I/E plus an operator and one or two bounds.
 *
 * The operator names are the ones the server itself publishes per field in the
 * <operators> elements of the DTP document — EQ/BT/CP of a RANGE table map to
 * Equal/Between/ContainsPattern. See payloads/dtp_filter_selections.md.
 */
export interface DtpFilterSelectionInput {
  operator?: string;
  sign?: 'I' | 'E';
  low: string;
  high?: string;
}

interface FieldOperator {
  operator: string;
  including: boolean;
  excluding: boolean;
}

/**
 * Escape a value for an XML attribute. Filter values and their descriptions reach the
 * server verbatim, so an unescaped `&` fails the PUT with HTTP 500 and no usable message.
 */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Field names carry regex metacharacters, e.g. the /BIC/ prefix of custom fields. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function fieldBlockRegExp(fieldName: string): RegExp {
  const escaped = escapeRegExp(fieldName);
  return new RegExp(
    `<fields\\b[^>]*\\sname="${escaped}"[^>]*(?:/>|>[\\s\\S]*?</fields>)`
  );
}

/**
 * Locate the <fields> block of one filter field. A field name that matches nothing must be
 * an error, not a no-op: the whole write is a patch on the document, so an unmatched name
 * produces a PUT that succeeds and changes nothing — indistinguishable from success for the
 * caller.
 */
function extractFieldBlock(xml: string, fieldName: string, dtpName: string): { regex: RegExp; block: string } {
  const regex = fieldBlockRegExp(fieldName);
  const block = xml.match(regex)?.[0];
  if (!block) {
    const available = [...xml.matchAll(/<fields\b[^>]*\sname="([^"]*)"/g)].map((m) => m[1]);
    throw new Error(
      `Filter field '${fieldName}' does not exist in DTP '${dtpName}'. ` +
      (available.length > 0
        ? `Available filter fields: ${available.join(', ')}.`
        : `This DTP has no filter fields.`) +
      ` Use bw_get_dtp to see the exact field names.`
    );
  }
  return { regex, block };
}

/** Operators the server accepts for this field, with the allowed signs. */
function parseFieldOperators(fieldBlock: string): FieldOperator[] {
  return [...fieldBlock.matchAll(/<operators\b([^>]*)\/>/g)].map((m) => ({
    operator: m[1].match(/\boperator="([^"]*)"/)?.[1] ?? '',
    including: /\bincluding="true"/.test(m[1]),
    excluding: /\bexcluding="true"/.test(m[1]),
  }));
}

/**
 * Validate one selection against the operators the field publishes. Validating against the
 * document instead of a compiled-in enum keeps the tool honest when a field offers fewer
 * operators (the comparison operators are including-only on every field seen so far).
 */
function validateSelection(
  sel: DtpFilterSelectionInput,
  operators: FieldOperator[],
  fieldName: string
): { operator: string; excluding: boolean; low: string; high?: string } {
  const operator = sel.operator ?? 'Equal';
  const sign = sel.sign ?? 'I';
  if (sign !== 'I' && sign !== 'E') {
    throw new Error(`Invalid sign '${sign}' on field '${fieldName}' — use 'I' (include) or 'E' (exclude).`);
  }
  const excluding = sign === 'E';

  // Fields without a published operator list are not validated — only the structural rules
  // below apply, which do not depend on the field.
  if (operators.length > 0) {
    const match = operators.find((o) => o.operator === operator);
    if (!match) {
      throw new Error(
        `Operator '${operator}' is not supported for filter field '${fieldName}'. ` +
        `Supported: ${operators.map((o) => o.operator).join(', ')}.`
      );
    }
    if (excluding && !match.excluding) {
      throw new Error(
        `Operator '${operator}' cannot be used excluding (sign 'E') on filter field '${fieldName}'. ` +
        `Excluding is available for: ${operators.filter((o) => o.excluding).map((o) => o.operator).join(', ') || 'none'}.`
      );
    }
    if (!excluding && !match.including) {
      throw new Error(
        `Operator '${operator}' cannot be used including (sign 'I') on filter field '${fieldName}'.`
      );
    }
  }

  const high = sel.high ?? '';
  if (operator === 'Between') {
    if (sel.low === '' || high === '') {
      throw new Error(`Operator 'Between' on filter field '${fieldName}' requires both low and high.`);
    }
  } else if (high !== '') {
    throw new Error(
      `Only operator 'Between' takes a high value — field '${fieldName}' uses '${operator}'.`
    );
  } else if (sel.low === '' && operator !== 'Equal' && operator !== 'NotEqual') {
    // The empty string is the selection on the BW initial value; only the equality
    // operators express it.
    throw new Error(
      `An empty low value (BW initial value) is only valid with 'Equal' or 'NotEqual' — ` +
      `field '${fieldName}' uses '${operator}'.`
    );
  }

  return { operator, excluding, low: sel.low, high: operator === 'Between' ? high : undefined };
}

/**
 * Serialize selections in the form a GET returns: explicit excluding attribute, one
 * <selection> per value, <low>/<high> carrying value and description. An empty low is a
 * self-closing <selection> with no bound — the selection on the BW initial value, which is
 * not the same thing as the literal value '#'.
 */
function buildSelectionsXml(
  selections: { operator: string; excluding: boolean; low: string; high?: string }[]
): string {
  return selections
    .map((s) => {
      const open = `<selection excluding="${s.excluding}" operator="${s.operator}"`;
      if (s.low === '' && s.high === undefined) {
        return `${open}/>`;
      }
      const bounds = [`        <low description="${escapeXmlAttr(s.low)}" value="${escapeXmlAttr(s.low)}"/>`];
      if (s.high !== undefined) {
        bounds.push(`        <high description="${escapeXmlAttr(s.high)}" value="${escapeXmlAttr(s.high)}"/>`);
      }
      return `${open}>\n${bounds.join('\n')}\n      </selection>`;
    })
    .join('\n      ');
}

/** Split a <fields> block into its open tag and its body (self-closing blocks have none). */
function splitFieldBlock(block: string): { openAttrs: string; body: string } {
  const selfClosing = block.match(/^<fields\b([^>]*?)\/>$/);
  if (selfClosing) {
    return { openAttrs: selfClosing[1].replace(/\s+$/, ''), body: '' };
  }
  const m = block.match(/^<fields\b([^>]*)>([\s\S]*)<\/fields>$/);
  if (!m) {
    throw new Error(`Unexpected <fields> serialization: ${block.slice(0, 120)}`);
  }
  return { openAttrs: m[1], body: m[2] };
}

/** Existing routine element of a field, or an empty <routine/> when it has none. */
function extractRoutineElement(body: string): { routine: string; rest: string } {
  const withCode = body.match(/<routine\b[^>]*>[\s\S]*?<\/routine>/);
  if (withCode) {
    return { routine: withCode[0], rest: body.replace(withCode[0], '') };
  }
  const empty = body.match(/<routine\s*\/>/);
  if (empty) {
    return { routine: '<routine/>', rest: body.replace(empty[0], '') };
  }
  return { routine: '<routine/>', rest: body };
}

function stripSelections(body: string): string {
  return body
    .replace(/<selection\b[^>]*\/>\s*/g, '')
    .replace(/<selection\b[^>]*>[\s\S]*?<\/selection>\s*/g, '');
}

function setSelectedAttr(openAttrs: string, selected: boolean): string {
  const withoutSelected = openAttrs.replace(/\s+selected="[^"]*"/, '');
  return selected ? `${withoutSelected} selected="true"` : withoutSelected;
}

/**
 * Replace the value selections of one filter field with the given set (replace semantics —
 * a single call carries the complete selection of that field).
 *
 * The /m deserializer is sequence-sensitive: <routine> first, then the selections, then
 * <infoObject> (InfoObject-based fields only) and <operators>. An existing routine is kept
 * untouched, so values and a filter routine can coexist on the same field, which is what the
 * server itself serializes.
 */
export function applyDtpFilterSelections(
  xml: string,
  fieldName: string,
  selections: DtpFilterSelectionInput[],
  dtpName: string
): string {
  const { regex, block } = extractFieldBlock(xml, fieldName, dtpName);
  const operators = parseFieldOperators(block);
  const validated = selections.map((s) => validateSelection(s, operators, fieldName));

  const { openAttrs, body } = splitFieldBlock(block);
  const { routine, rest } = extractRoutineElement(stripSelections(body));
  const selectionsXml = validated.length > 0 ? `\n      ${buildSelectionsXml(validated)}` : '';
  const newBlock =
    `<fields${setSelectedAttr(openAttrs, true)}>\n      ${routine}${selectionsXml}` +
    `${rest.replace(/^\s*/, '\n      ')}</fields>`;

  // Replacer function, not a plain string: field descriptions and values may contain '$'.
  return xml.replace(regex, () => newBlock);
}

/**
 * Drop the value selections of one filter field. The field is deselected as well unless it
 * carries a filter routine — the routine, not the value list, is then the active filter.
 */
export function clearDtpFilterField(xml: string, fieldName: string, dtpName: string): string {
  const { regex, block } = extractFieldBlock(xml, fieldName, dtpName);
  const { openAttrs, body } = splitFieldBlock(block);
  const hasRoutineCode = /<routine\b[^>]*>[\s\S]*?<\/routine>/.test(body);
  const cleanedBody = stripSelections(body);
  const newBlock = body === ''
    ? `<fields${setSelectedAttr(openAttrs, hasRoutineCode)}/>`
    : `<fields${setSelectedAttr(openAttrs, hasRoutineCode)}>${cleanedBody}</fields>`;
  return xml.replace(regex, () => newBlock);
}

/**
 * Resolve the two ways of expressing a filter into one selection list: filter_value for the
 * common case (one or more Equal values, one sign for all of them) and filter_selections for
 * the full range vocabulary. Passing both is an error rather than a silent precedence rule.
 */
export function resolveFilterSelections(args: {
  filter_field?: string;
  filter_value?: string;
  filter_excluding?: boolean;
  filter_selections?: DtpFilterSelectionInput[];
}): DtpFilterSelectionInput[] | undefined {
  const hasValue = args.filter_value !== undefined;
  const hasSelections = args.filter_selections !== undefined && args.filter_selections.length > 0;

  if (hasValue && hasSelections) {
    throw new Error(
      'filter_value and filter_selections are mutually exclusive — use filter_selections for ' +
      'operators, ranges or mixed signs, filter_value for a plain list of Equal values.'
    );
  }
  if ((hasValue || hasSelections) && !args.filter_field) {
    throw new Error('filter_value / filter_selections require filter_field.');
  }
  if (args.filter_field && !hasValue && !hasSelections) {
    throw new Error(
      `filter_field '${args.filter_field}' was given without filter_value or filter_selections. ` +
      'To remove a filter, use filter_clear_fields.'
    );
  }
  if (hasSelections && args.filter_excluding !== undefined) {
    throw new Error(
      'filter_excluding applies to filter_value only — set the sign per entry in filter_selections.'
    );
  }

  if (hasSelections) {
    return args.filter_selections;
  }
  if (hasValue) {
    const sign = args.filter_excluding ? 'E' : 'I';
    // Preserve the empty string (selection on the BW initial value) — do not filter(Boolean).
    const values = [...new Set(args.filter_value!.split(',').map((v) => v.trim()))];
    return values.map((low) => ({ operator: 'Equal', sign, low } as DtpFilterSelectionInput));
  }
  return undefined;
}

// ── bwCreateDtp ───────────────────────────────────────────────────────────────

export interface CreateDtpArgs {
  trfn_name: string;
  trfn_name_2?: string;
  source_name: string;
  source_type: string;
  source_system?: string;
  target_name: string;
  target_type: string;
  target_object_subtype?: string;
  description?: string;
  package?: string;
  filter_field?: string;
  filter_value?: string;
  filter_excluding?: boolean;
  filter_selections?: DtpFilterSelectionInput[];
}

/**
 * bw_create_dtp — create a new DTP for an existing Transformation, then activate it.
 *
 * Flow:
 *   1. POST generateDtpId → DTP name from Location header
 *   2. Lock with activity_context: CREA (rawPost on lockClient = passed-in client)
 *   3. POST minimal XML with fresh createClientFromEnv() (session isolation)
 *   4. Explicit unlock (rawPost on lockClient)
 *   5a. If filter_field: Lock (new client) → GET (fresh) → PUT (fresh) → bwActivate
 *   5b. If no filter: bwActivate with empty lockHandle
 */
export async function bwCreateDtp(
  client: BwClient,
  args: CreateDtpArgs
): Promise<string> {
  const trfnName   = args.trfn_name.toUpperCase();
  const srcName    = args.source_name.toUpperCase();
  const srcType    = args.source_type.toUpperCase();
  const tgtName    = args.target_name.toUpperCase();
  const tgtType    = args.target_type.toUpperCase();
  const desc       = args.description ?? '';
  const pkg        = args.package ?? '$TMP';
  // Resolved before the create so an invalid filter fails before any object exists.
  const filterSelections = resolveFilterSelections(args);

  // Source element attributes. For ADSO/TRCS sources tlogo and type coincide and the name is
  // passed through. For a DataSource source (source_type "RSDS") tlogo and type differ
  // (tlogo "RSDS", type "DTASRC") and the name is the RSDS compound key.
  let sourceTlogo: string;
  let sourceTypeAttr: string;
  let sourceNameAttr: string;
  if (srcType === 'RSDS') {
    if (!args.source_system) {
      throw new Error(
        'source_type "RSDS" (DataSource source) requires source_system to build the ' +
        'RSDS compound source name.'
      );
    }
    sourceTlogo = 'RSDS';
    sourceTypeAttr = 'DTASRC';
    // RSDS compound key: DataSource name left-justified in a 30-char field, then the
    // source system name appended with no trailing padding (total length 40).
    sourceNameAttr = srcName.padEnd(30, ' ') + args.source_system.toUpperCase();
  } else {
    sourceTlogo = srcType;
    sourceTypeAttr = srcType;
    sourceNameAttr = srcName;
  }

  // Target element attributes. For ADSO/TRCS targets tlogo and type coincide. For an
  // InfoObject target (target_type "IOBJ") they differ: tlogo "IOBJ" (object kind) but the
  // type carries the loaded sub-object role — the same tlogo != type pattern as the RSDS
  // source. The role is selected by target_object_subtype: ATTR → IOBJA (attributes, default),
  // TEXT → IOBJT (texts), HIER → IOBJH (hierarchies). The type code must match the sub-object
  // fed by the transformation chain, otherwise the server rejects the create with
  // SADT_RESOURCE 006 (verified against the GUI reference trace: <target ... type="IOBJT"/>).
  let targetTlogo: string;
  let targetTypeAttr: string;
  if (tgtType === 'IOBJ') {
    const subtype = (args.target_object_subtype ?? 'ATTR').toUpperCase();
    const IOBJ_SUBTYPE_TO_TYPE: Record<string, string> = {
      ATTR: 'IOBJA',
      TEXT: 'IOBJT',
      HIER: 'IOBJH',
    };
    const typeCode = IOBJ_SUBTYPE_TO_TYPE[subtype];
    if (!typeCode) {
      throw new Error(
        `Invalid target_object_subtype "${args.target_object_subtype}" for an InfoObject target. ` +
        `Valid values: ATTR (attributes, default), TEXT (texts), HIER (hierarchies).`
      );
    }
    targetTlogo = 'IOBJ';
    targetTypeAttr = typeCode;
  } else {
    targetTlogo = tgtType;
    targetTypeAttr = tgtType;
  }

  const language     = process.env.BW_LANGUAGE ?? 'DE';
  const masterSystem = await resolveMasterSystem(client);
  const responsible  = (process.env.BW_USER ?? '').toUpperCase();

  // Step 1: Generate DTP name via POST generateDtpId — DTP name is in Location header
  const csrfToken = await client.getCsrfToken();
  const genResponse = await client.rawPost(
    '/sap/bw/modeling/dtpa/generateDtpId',
    '',
    {
      'Accept': MEDIA_TYPES['dtpa'],
      'Content-Type': MEDIA_TYPES['dtpa'],
      'x-csrf-token': csrfToken,
    }
  );
  const location = genResponse.headers['location'] ?? genResponse.headers['Location'] ?? '';
  if (!location) {
    throw new Error(`generateDtpId returned no Location header. Response: ${JSON.stringify(genResponse.headers)}`);
  }
  const dtpName  = location.split('/').pop()!.toUpperCase();
  const dtpLower = dtpName.toLowerCase();

  // Step 2: Lock with CREA
  const csrfToken2 = await client.getCsrfToken();
  const lockResponse = await client.rawPost(
    `/sap/bw/modeling/dtpa/${bwSeg(dtpLower)}?action=lock`,
    '',
    {
      'activity_context': 'CREA',
      'Accept': MEDIA_TYPES['dtpa'],
      'x-csrf-token': csrfToken2,
    }
  );
  const lockHandle = lockResponse.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1] ?? '';
  if (!lockHandle) {
    throw new Error(`No <LOCK_HANDLE> in CREA lock response:\n${lockResponse.body}`);
  }

  // The CREA lock (and the description/filter lock below) hold an enqueue
  // (SM12: RSBKDTP) that must be released even if a later step throws; the finally
  // block frees it so a failed create does not leave the DTP locked.
  try {
    // Step 3: POST minimal XML — fresh session (same isolation as bwCreateTransformation)
    const postBody = `<?xml version="1.0" encoding="UTF-8"?>
<Dtpa:dataTransferProcess
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:Dtpa="http://www.sap.com/bw/modeling/DataTransferProcess.ecore"
  xmlns:adtcore="http://www.sap.com/adt/core"
  description="${desc}"
  name="${dtpName}">
  <generalInformation>
    <tlogoProperties
      adtcore:language="${language}"
      adtcore:name="${dtpName}"
      adtcore:type="DTPA"
      adtcore:masterLanguage="${language}"
      adtcore:masterSystem="${masterSystem}"
      adtcore:responsible="${responsible}"/>
  </generalInformation>
  <overview>
    <object xsi:type="Dtpa:DTPObject" name="${trfnName}" tlogo="TRFN"/>${args.trfn_name_2 ? `\n    <object xsi:type="Dtpa:DTPObject" name="${args.trfn_name_2.toUpperCase()}" tlogo="TRFN"/>` : ''}
  </overview>
  <source name="${sourceNameAttr}" tlogo="${sourceTlogo}" type="${sourceTypeAttr}"/>
  <target name="${tgtName}" tlogo="${targetTlogo}" type="${targetTypeAttr}"/>
</Dtpa:dataTransferProcess>`;

    const createClient = createClientFromEnv();
    const createCsrf = await createClient.getCsrfToken();
    await createClient.rawPost(
      `/sap/bw/modeling/dtpa/${bwSeg(dtpLower)}?lockHandle=${lockHandle}`,
      postBody,
      {
        'Development-Class': pkg,
        'Content-Type': MEDIA_TYPES['dtpa'],
        'Accept': MEDIA_TYPES['dtpa'],
        'x-csrf-token': createCsrf,
      }
    );

    // Step 4: Explicit unlock
    const csrfToken3 = await client.getCsrfToken();
    await client.rawPost(
      `/sap/bw/modeling/dtpa/${bwSeg(dtpLower)}?action=unlock`,
      '',
      {
        'Content-Type': MEDIA_TYPES['dtpa'],
        'Accept': MEDIA_TYPES['dtpa'],
        'x-csrf-token': csrfToken3,
      }
    );

    // Step 4b: If description or filter provided, update via Lock → GET → PUT → unlock
    if (desc || filterSelections) {
      const descLockCsrf = await client.getCsrfToken();
      const descLockResponse = await client.rawPost(
        `/sap/bw/modeling/dtpa/${bwSeg(dtpLower)}?action=lock`,
        '',
        {
          'Accept': MEDIA_TYPES['dtpa'],
          'x-csrf-token': descLockCsrf,
        }
      );
      const descLockHandle = descLockResponse.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1] ?? '';
      if (!descLockHandle) {
        throw new Error(`No <LOCK_HANDLE> in description/filter lock response:\n${descLockResponse.body}`);
      }

      // GET DTP XML (fresh client) — read timestamp
      const descGetClient = createClientFromEnv();
      const descGetResponse = await descGetClient.get(`/sap/bw/modeling/dtpa/${bwSeg(dtpLower)}/m`, MEDIA_TYPES['dtpa']);
      const descTimestamp = descGetResponse.headers['timestamp'] ?? '';

      let descXml = descGetResponse.body;

      // Update description attribute if provided
      if (desc) {
        descXml = descXml.replace(
          /(<dtpa:dataTransferProcess\b[^>]*\bdescription=)"[^"]*"/,
          `$1"${desc}"`
        );
      }

      // Inject filter if provided
      if (filterSelections) {
        descXml = applyDtpFilterSelections(descXml, args.filter_field!, filterSelections, dtpName);
      }

      // PUT with fresh client
      const descPutClient = createClientFromEnv();
      await descPutClient.put('dtpa', dtpName, descLockHandle, descXml, descTimestamp);

      // Unlock
      const descUnlockCsrf = await client.getCsrfToken();
      await client.rawPost(
        `/sap/bw/modeling/dtpa/${bwSeg(dtpLower)}?action=unlock`,
        '',
        {
          'Content-Type': MEDIA_TYPES['dtpa'],
          'Accept': MEDIA_TYPES['dtpa'],
          'x-csrf-token': descUnlockCsrf,
        }
      );
    }

    // Step 5: Activate
    await bwActivate(client, 'dtpa', dtpName, '');

    return JSON.stringify({
      success: true,
      dtp_name: dtpName,
      transformation: trfnName,
      source: { type: srcType, name: srcName },
      target: { type: tgtType, name: tgtName },
      package: pkg,
      message: `DTP '${dtpName}' created and activated successfully.`,
    });
  } finally {
    // Best-effort release of the DTP enqueue lock — the happy path already unlocks,
    // so this typically no-ops; on an error path it frees a leaked lock.
    await bwUnlockDtp(client, dtpLower).catch(() => {/* lock may already be released */});
  }
}

// ── bwRunDtp ──────────────────────────────────────────────────────────────────

/**
 * bw_run_dtp — start (execute) a DTP run.
 *
 * Single POST to /sap/bw/modeling/dtpa/executerun with a minimal <executeRun> body naming the
 * DTP. The server responds 201 Created with a Location header whose last path segment is the new
 * request id.
 *
 * Runs in a fresh session (createClientFromEnv()) — like the DTP-activation path — because the
 * executerun touches the DTP and its transformation and the shared module-level client can hold a
 * stale session buffer; a fresh session also avoids concurrency collisions across runs.
 *
 * The returned request id is a timestamp-based executerun id. It is returned for information only:
 * it is not verified to match the request TSN used by bw_get_request, so load status is monitored
 * via bw_list_requests (by target InfoProvider) and bw_get_request.
 */
export async function bwRunDtp(dtpName: string): Promise<string> {
  const dtpUpper = dtpName.toUpperCase();

  const runClient = createClientFromEnv();
  const csrfToken = await runClient.getCsrfToken();

  const body = `<?xml version="1.0" encoding="UTF-8"?><executeRun dataTransferProcess="${dtpUpper}"></executeRun>`;
  const response = await runClient.rawPost(
    '/sap/bw/modeling/dtpa/executerun',
    body,
    {
      'Accept': MEDIA_TYPES['dtpa'],
      'Content-Type': MEDIA_TYPES['dtpa'],
      'x-csrf-token': csrfToken,
    }
  );

  const location = response.headers['location'] ?? response.headers['Location'] ?? '';
  if (!location) {
    throw new Error(
      `executerun returned no Location header. Response headers: ${JSON.stringify(response.headers)}`
    );
  }
  const requestId = location.split('/').filter(Boolean).pop() ?? '';

  return JSON.stringify({
    success: true,
    dtp_name: dtpUpper,
    request_id: requestId,
    message:
      `DTP run started for ${dtpUpper} (request id ${requestId}). ` +
      `Monitor load status via bw_list_requests (by target InfoProvider) and bw_get_request.`,
  });
}

// ── bwUpdateDtp ───────────────────────────────────────────────────────────────

export interface UpdateDtpArgs {
  dtp_name: string;
  description?: string;
  filter_field?: string;
  filter_value?: string;
  filter_excluding?: boolean;
  filter_selections?: DtpFilterSelectionInput[];
  filter_clear_fields?: string;
  extraction_mode?: 'full' | 'delta';
  semantic_group_fields?: string;
  transport?: string;
  transport_lock_holder?: string;
}

/**
 * Rewrite the <semanticGroup> element of a DTP document so that exactly the requested
 * fields are the semantic group (replace semantics; an empty list clears the selection).
 *
 * The selection lives solely in the keyField attribute of the <groupField> elements,
 * which the server already lists for every groupable field of the source — no element is
 * ever added or removed. The serialization is asymmetric: a GET carries keyField only on
 * the selected fields, while the Eclipse client sends an explicit keyField="false" on
 * every entry. Replacing keyField="false" would therefore silently hit nothing on a GET
 * document, so all keyField attributes are stripped and re-added instead.
 *
 * Throws when the document has no semantic group, or when a requested field name is not
 * among the groupable fields — the server would answer HTTP 200 and keep the old
 * selection, which is indistinguishable from success for the caller.
 */
export function applySemanticGroup(xml: string, fields: string, dtpName: string): string {
  const sgMatch = xml.match(/<semanticGroup>[\s\S]*?<\/semanticGroup>/);
  if (!sgMatch) {
    throw new Error(
      `DTP '${dtpName}' has no <semanticGroup> element — semantic groups are not available ` +
      `for this source/target combination.`
    );
  }

  const requested = [...new Set(
    fields.split(',').map((f) => f.trim()).filter(Boolean)
  )];

  let sgXml = sgMatch[0].replace(
    /(<groupField\b[^>]*?)\s+keyField="(?:true|false)"/g,
    '$1'
  );

  const missing: string[] = [];
  for (const field of requested) {
    const re = new RegExp(`(<groupField\\b[^>]*\\bname="${escapeRegExp(field)}"[^>]*?)(\\s*/>)`);
    if (!re.test(sgXml)) {
      missing.push(field);
      continue;
    }
    sgXml = sgXml.replace(re, '$1 keyField="true"$2');
  }

  if (missing.length > 0) {
    throw new Error(
      `Semantic group field(s) not found in DTP '${dtpName}': ${missing.join(', ')}. ` +
      `Use bw_get_dtp to list the available group fields with their exact names.`
    );
  }

  // Replacer function, not a plain string: field descriptions may contain '$'.
  return xml.replace(sgMatch[0], () => sgXml);
}

/**
 * bw_update_dtp — update a DTP (description, filter, extraction mode, semantic group).
 *
 * Flow: Lock → GET (fresh) → PUT (fresh) → bwActivate (handles unlock).
 */
export async function bwUpdateDtp(
  client: BwClient,
  args: UpdateDtpArgs
): Promise<string> {
  const dtpName  = args.dtp_name.toUpperCase();
  const dtpLower = args.dtp_name.toLowerCase();

  // Resolved before the lock so an invalid filter never takes a lock or writes a document.
  const filterSelections = resolveFilterSelections(args);

  // Lock (stateful_enqueue — same pattern as bwUpdateInfoObject)
  const lockHandle = await client.lock('dtpa', dtpLower, {}, 'stateful_enqueue');

  // The enqueue lock (SM12: RSBKDTP) must be released on success AND error;
  // bwActivate does not release it for dtpa, so it is freed in the finally block.
  try {
    // GET current DTP XML (fresh client) — read timestamp
    const getClient = createClientFromEnv();
    const getResponse = await getClient.get(`/sap/bw/modeling/dtpa/${bwSeg(dtpLower)}/m`, MEDIA_TYPES['dtpa']);
    const timestamp = getResponse.headers['timestamp'] ?? '';

    // Apply modifications
    let putXml = getResponse.body;
    if (args.description !== undefined) {
      putXml = putXml.replace(
        /(<dtpa:dataTransferProcess\b[^>]*\bdescription=)"[^"]*"/,
        `$1"${args.description}"`
      );
    }
    if (filterSelections) {
      putXml = applyDtpFilterSelections(putXml, args.filter_field!, filterSelections, dtpName);
    }

    if (args.filter_clear_fields) {
      const fieldsToClear = args.filter_clear_fields.split(',').map((f) => f.trim()).filter(Boolean);
      for (const fieldName of fieldsToClear) {
        putXml = clearDtpFilterField(putXml, fieldName, dtpName);
      }
    }

    // Extraction mode: rewrite only extractionMode + deltaSettingStatus on the <extractionSettings>
    // element (Full = F/0, Delta = D/2). allowedExtractionModes, packageSize and parallelExtraction
    // are left unchanged; attributes may appear in any order.
    if (args.extraction_mode !== undefined) {
      const extractionMode = args.extraction_mode === 'full' ? 'F' : 'D';
      const deltaSettingStatus = args.extraction_mode === 'full' ? '0' : '2';
      putXml = putXml.replace(
        /<extractionSettings\b[^>]*\/>/,
        (tag) => tag
          .replace(/\bextractionMode="[^"]*"/, `extractionMode="${extractionMode}"`)
          .replace(/\bdeltaSettingStatus="[^"]*"/, `deltaSettingStatus="${deltaSettingStatus}"`)
      );
    }

    if (args.semantic_group_fields !== undefined) {
      putXml = applySemanticGroup(putXml, args.semantic_group_fields, dtpName);
    }

    // PUT on a fresh stateless client — Eclipse uses a separate stateless session for PUT
    const putClient = createClientFromEnv();
    await putClient.put('dtpa', dtpName, lockHandle, putXml, timestamp, args.transport, args.transport_lock_holder);

    // Activate
    await bwActivate(client, 'dtpa', dtpName, lockHandle, args.transport);

    return JSON.stringify({
      success: true,
      dtp_name: dtpName,
      // Reported per field so a truncated value set is visible in the result itself:
      // the selection is replaced as a whole, it is not appended to.
      filter: filterSelections
        ? {
            field: args.filter_field,
            selections: filterSelections.map((s) => ({
              sign: s.sign ?? 'I',
              operator: s.operator ?? 'Equal',
              low: s.low,
              ...(s.high !== undefined ? { high: s.high } : {}),
            })),
          }
        : undefined,
      message: `DTP '${dtpName}' updated and activated successfully.`,
    });
  } finally {
    // Best-effort release of the DTP enqueue lock — never mask the operation result/error.
    await bwUnlockDtp(client, dtpLower).catch(() => {/* lock may already be released */});
  }
}

// ── bwSetDtpFilterRoutine ─────────────────────────────────────────────────────

/**
 * Splice user routine code (and optional global code) into the live
 * RSBC_SEL_ROUTINE_TPL skeleton fetched from the ADT program source, keeping the
 * marker lines and everything outside the markers verbatim.
 */
function spliceRoutineSource(skeleton: string, routineCode: string, globalCode?: string): string {
  const splice = (src: string, beginMarker: string, endMarker: string, code: string): string => {
    const lines = src.split('\n');
    const begin = lines.findIndex((l) => l.includes(beginMarker));
    const end = lines.findIndex((l) => l.includes(endMarker));
    if (begin === -1 || end === -1 || end <= begin) {
      throw new Error(`Routine template marker not found: ${beginMarker}`);
    }
    return [...lines.slice(0, begin + 1), ...code.split('\n'), ...lines.slice(end)].join('\n');
  };
  let out = splice(skeleton, 'begin of routine - insert your code', 'end of routine - insert your code', routineCode);
  if (globalCode) {
    out = splice(out, 'begin of global - insert your declaration', 'end of global - insert your declaration', globalCode);
  }
  return out;
}

interface AbapCheckMessage {
  type: string; // 'E' | 'W' | 'I'
  line?: string;
  column?: string;
  text: string;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Run an ADT ABAP syntax check on the generated routine program's INACTIVE version
 * and return the reported messages. This mirrors exactly what the BW Modeling Tools
 * do when a filter routine is opened (POST /sap/bc/adt/checkruns?reporters=abapCheckRun
 * with a checkObjectList referencing the program at version="inactive").
 *
 * The generated FORM signature exposes the DTP request as
 * IF_RSBK_REQUEST_ADMINTAB_VIEW, which has no get_dtp( ) method — patterns copied from
 * existing DTP routines that call cl_rsbk_dtp=>factory( i_r_request->get_dtp( ) ) fail
 * the syntax check here rather than silently activating a broken program.
 */
async function checkRoutineProgramSyntax(
  client: BwClient,
  adtEncoded: string
): Promise<AbapCheckMessage[]> {
  const csrf = await client.getCsrfToken();
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<chkrun:checkObjectList xmlns:adtcore="http://www.sap.com/adt/core" xmlns:chkrun="http://www.sap.com/adt/checkrun">\n` +
    `  <chkrun:checkObject adtcore:uri="/sap/bc/adt/programs/programs/${adtEncoded}" chkrun:version="inactive"/>\n` +
    `</chkrun:checkObjectList>`;

  const resp = await client.rawPost(
    '/sap/bc/adt/checkruns?reporters=abapCheckRun',
    body,
    {
      'Content-Type': 'application/vnd.sap.adt.checkobjects+xml',
      'Accept': 'application/vnd.sap.adt.checkmessages+xml',
      'x-csrf-token': csrf,
    }
  );

  const messages: AbapCheckMessage[] = [];
  for (const m of resp.body.matchAll(/<chkrun:checkMessage\b([^>]*)\/>/g)) {
    const attrs = m[1];
    const type = attrs.match(/chkrun:type="([^"]*)"/)?.[1] ?? '';
    const shortText = attrs.match(/chkrun:shortText="([^"]*)"/)?.[1] ?? '';
    const start = attrs.match(/#start=(\d+),(\d+)/);
    messages.push({
      type,
      line: start?.[1],
      column: start?.[2],
      text: decodeXmlEntities(shortText),
    });
  }
  return messages;
}

/**
 * Error/abort messages of an ADT activation response. A generated routine program that fails
 * to activate is exactly the state in which the following routineReports read cannot succeed,
 * so the response is inspected instead of discarded. Warnings (type W/I) are not failures.
 */
function parseAdtActivationErrors(body: string): string[] {
  const errors: string[] = [];
  for (const m of body.matchAll(/<msg\b([^>]*)>([\s\S]*?)<\/msg>/g)) {
    const type = m[1].match(/\btype="([^"]*)"/)?.[1] ?? '';
    if (!/^[EAX]$/i.test(type)) continue;
    const text = m[2].match(/<txt>([\s\S]*?)<\/txt>/)?.[1] ?? m[1];
    errors.push(decodeXmlEntities(text.trim()));
  }
  return errors;
}

/**
 * Build the <routine> element of the DTP document from the routine code as supplied by the
 * caller. The DTP holds exactly the lines between the routine markers, one <code> element per
 * line, which is what the caller passed in — so this is the fallback when reading the code
 * back from the generated report fails (see payloads/dtp_filter_selections.md).
 */
function buildRoutineElementFromCode(routineCode: string): string {
  const codeElements = routineCode
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .map((line) => (line ? `<code>${escapeXmlAttr(line)}</code>` : `<code xsi:nil="true"/>`))
    .join('\n        ');
  return `<routine>\n        ${codeElements}\n      </routine>`;
}

function buildGlobalRoutineElementsFromCode(globalCode: string): string {
  return globalCode
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .map((line) => `    <globalRoutineCode>${escapeXmlAttr(line)}</globalRoutineCode>`)
    .join('\n');
}

export interface SetDtpFilterRoutineArgs {
  dtp_name: string;
  field_name: string;
  routine_code: string;
  global_code?: string;
}

/**
 * bw_set_dtp_filter_routine — set an ABAP filter routine on a DTP filter field.
 *
 * Flow (mirrors the working Eclipse trace, see payloads/set_dtp_filter_routine.md):
 *   1.  Lock the DTP (no CREA)
 *   2a. POST generateRoutineProgram with an EMPTY body (ID allocation only) →
 *       ABAP program name from Location header
 *   2b. GET the generated program skeleton, splice the user code into it, then
 *       lock/PUT-source/unlock on ONE dedicated ADT client (shared enqueue session)
 *   3.  ADT activate the ABAP program (reusing that client)
 *   4.  GET routineReports → read back routine XML (now populated)
 *   5.  DELETE routineReports (mandatory cleanup)
 *   6.  GET DTP XML (fresh client, read timestamp)
 *   7.  Convert routineReports XML → DTP PUT format, inject as the FIRST child of
 *       the target <fields> block
 *   8.  PUT DTP XML (fresh client)
 *   9.  bwActivate with lockHandle
 */
export async function bwSetDtpFilterRoutine(
  client: BwClient,
  args: SetDtpFilterRoutineArgs
): Promise<string> {
  const dtpUpper = args.dtp_name.toUpperCase();
  const dtpLower = args.dtp_name.toLowerCase();
  const fieldName = args.field_name;
  const fieldNameEncoded = encodeURIComponent(fieldName);

  // Step 1: Lock (no CREA)
  const lockCsrf = await client.getCsrfToken();
  const lockResponse = await client.rawPost(
    `/sap/bw/modeling/dtpa/${bwSeg(dtpLower)}?action=lock`,
    '',
    {
      'Accept': MEDIA_TYPES['dtpa'],
      'x-csrf-token': lockCsrf,
    }
  );
  const lockHandle = lockResponse.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1] ?? '';
  if (!lockHandle) {
    throw new Error(`No <LOCK_HANDLE> in lock response:\n${lockResponse.body}`);
  }

  // The enqueue lock (SM12: RSBKDTP) must be released on success AND error;
  // bwActivate does not release it for dtpa, so it is freed in the finally block.
  try {
    // Step 2a: POST generateRoutineProgram with an EMPTY body — the server only
    // allocates the program ID here and ignores any routine content.
    const routineBody = '<?xml version="1.0" encoding="UTF-8"?><routine></routine>';

    const genCsrf = await client.getCsrfToken();
    const genResponse = await client.rawPost(
      `/sap/bw/modeling/dtpa/${bwSegUpper(dtpUpper)}/${fieldNameEncoded}/generateRoutineProgram`,
      routineBody,
      {
        'Content-Type': 'application/vnd.sap.bw.modeling.dtpa.routine.code-v1_0_0+xml',
        'Accept': MEDIA_TYPES['dtpa'],
        'x-csrf-token': genCsrf,
      }
    );

    const genLocation = genResponse.headers['location'] ?? genResponse.headers['Location'] ?? '';
    if (!genLocation) {
      throw new Error(`generateRoutineProgram returned no Location header. Headers: ${JSON.stringify(genResponse.headers)}`);
    }
    const encodedProgram = genLocation.split('/routineReports/').pop() ?? '';
    const programName = decodeURIComponent(encodedProgram);
    const adtEncoded = encodeURIComponent(programName).toLowerCase();

    // A generated report is now registered on the field. Its name is derived from the DTP and
    // the field and therefore stable, so a registration left behind by a failed attempt is the
    // one every later attempt reads again — which is how a single failure can block a field
    // permanently. The registration is removed in the finally block, on every path.
    let reportDeleted = false;
    const deleteRoutineReport = async () => {
      if (reportDeleted) return;
      reportDeleted = true;
      await client.rawDelete(
        `/sap/bw/modeling/dtpa/${bwSegUpper(dtpUpper)}/${fieldNameEncoded}/routineReports/${encodedProgram}`,
        {
          'Content-Type': MEDIA_TYPES['dtpa'],
          'Accept': MEDIA_TYPES['dtpa'],
        }
      );
    };

    try {
      // Step 2b: write the ABAP source into the generated program. The lock, source
      // PUT and unlock must share one client so the stateful enqueue session cookies
      // (sap-contextid) are reused; the same client then activates the program.
      const programClient = createClientFromEnv();

      const skeletonResp = await programClient.rawGet(
        `/sap/bc/adt/programs/programs/${adtEncoded}/source/main`,
        { 'Accept': 'text/plain' }
      );
      const splicedSource = spliceRoutineSource(skeletonResp.body, args.routine_code, args.global_code);

      const progLockCsrf = await programClient.getCsrfToken();
      const progLockResp = await programClient.rawPost(
        `/sap/bc/adt/programs/programs/${adtEncoded}?_action=LOCK&accessMode=MODIFY`,
        '',
        {
          'Accept': 'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result;q=0.8, application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result2;q=0.9',
          'X-sap-adt-sessiontype': 'stateful',
          'x-csrf-token': progLockCsrf,
        }
      );
      const progLockHandle = progLockResp.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1] ?? '';
      if (!progLockHandle) {
        throw new Error(`No <LOCK_HANDLE> in program lock response:\n${progLockResp.body}`);
      }

      // The generated program's EU (ADT) enqueue lock must be released on success AND on
      // any error before activation, otherwise it leaks and can only be cleared via SM12.
      let syntaxErrors: AbapCheckMessage[] = [];
      try {
        const putSrcCsrf = await programClient.getCsrfToken();
        await programClient.rawPut(
          `/sap/bc/adt/programs/programs/${adtEncoded}/source/main?lockHandle=${progLockHandle}`,
          splicedSource,
          { 'Content-Type': 'text/plain; charset=utf-8', 'x-csrf-token': putSrcCsrf }
        );

        // Gate: syntax-check the just-written inactive version before activating. A broken
        // routine (e.g. i_r_request->get_dtp( ), which does not exist on the request
        // interface) is caught here instead of being silently reported as "activated".
        const checkMessages = await checkRoutineProgramSyntax(programClient, adtEncoded);
        syntaxErrors = checkMessages.filter((m) => m.type === 'E');
      } finally {
        const unlockCsrf = await programClient.getCsrfToken();
        await programClient.rawPost(
          `/sap/bc/adt/programs/programs/${adtEncoded}?_action=UNLOCK&lockHandle=${progLockHandle}`,
          '',
          { 'x-csrf-token': unlockCsrf }
        ).catch(() => {/* lock may already be gone; never mask the real error/result */});
      }

      if (syntaxErrors.length > 0) {
        // Abort before touching the DTP, and keep the report registration: the program now
        // holds an inactive version, and deleting the registration in that state leaves an
        // ADT object the next source write is rejected for with HTTP 404 "does not exist"
        // (verified against a BW/4HANA system). Keeping it is the resumable state — the next
        // call writes over the same program and activates it.
        reportDeleted = true;
        return JSON.stringify({
          success: false,
          dtp_name: dtpUpper,
          field_name: fieldName,
          program_name: programName,
          message:
            `Filter routine for field '${fieldName}' has ${syntaxErrors.length} ABAP syntax error(s) and was NOT activated. ` +
            `The DTP was left unchanged. Fix the routine code and call the tool again.`,
          syntax_errors: syntaxErrors.map((m) => ({
            line: m.line,
            column: m.column,
            text: m.text,
          })),
        }, null, 2);
      }

      // Step 3: ADT activate the ABAP program (reuse programClient after the unlock)
      const adtCsrf = await programClient.getCsrfToken();
      const adtBody =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">\n` +
        `  <adtcore:objectReference adtcore:uri="/sap/bc/adt/programs/programs/${adtEncoded}"\n` +
        `                           adtcore:name="${programName.toUpperCase()}"/>\n` +
        `</adtcore:objectReferences>`;
      const adtActivationResp = await programClient.rawPost(
        '/sap/bc/adt/activation?method=activate&preauditRequested=true',
        adtBody,
        {
          'Content-Type': 'application/xml',
          'Accept': 'application/xml',
          'x-csrf-token': adtCsrf,
        }
      );
      const adtActivationErrors = parseAdtActivationErrors(adtActivationResp.body);
      if (adtActivationErrors.length > 0) {
        return JSON.stringify({
          success: false,
          dtp_name: dtpUpper,
          field_name: fieldName,
          program_name: programName,
          message:
            `The generated routine program failed to activate, so the filter routine was NOT set. ` +
            `The DTP was left unchanged.`,
          activation_messages: adtActivationErrors,
        }, null, 2);
      }

      // Step 4: GET routineReports (read back routine code as XML). The read only returns the
      // lines that were just written, so a failure here is not a reason to abort after the ABAP
      // program has already been written and activated — the routine element is then built from
      // the supplied code instead (see payloads/dtp_filter_selections.md).
      let routineXml = '';
      let readBackError = '';
      try {
        const routineGetClient = createClientFromEnv();
        const routineGetResponse = await routineGetClient.get(
          `/sap/bw/modeling/dtpa/${bwSegUpper(dtpUpper)}/${fieldNameEncoded}/routineReports/${encodedProgram}`,
          MEDIA_TYPES['dtpa']
        );
        routineXml = routineGetResponse.body;
      } catch (error) {
        readBackError = error instanceof Error ? error.message : String(error);
      }

      // Step 5: DELETE routineReports (mandatory cleanup)
      await deleteRoutineReport();

      // Step 6: GET current DTP XML (fresh client, read timestamp)
      const dtpGetClient = createClientFromEnv();
      const dtpGetResponse = await dtpGetClient.get(
        `/sap/bw/modeling/dtpa/${bwSeg(dtpLower)}/m`,
        MEDIA_TYPES['dtpa']
      );
      const timestamp = dtpGetResponse.headers['timestamp'] ?? '';

      // Step 7: Convert routineReports XML → DTP PUT format
      // Extract code lines from <code>...</code>
      const codeSection = routineXml.match(/<code>([\s\S]*?)<\/code>/)?.[1] ?? '';
      const extractedCodeLines = [...codeSection.matchAll(/<line>([\s\S]*?)<\/line>/g)].map(m => m[1]);

      // Extract global lines from <globalCode>...</globalCode>
      const globalSection = routineXml.match(/<globalCode>([\s\S]*?)<\/globalCode>/)?.[1] ?? '';
      const extractedGlobalLines = [...globalSection.matchAll(/<line>([\s\S]*?)<\/line>/g)].map(m => m[1]);

      const usedReadBack = extractedCodeLines.length > 0;

      // <line> → <code>, empty lines → <code xsi:nil="true"/>
      const codeElements = extractedCodeLines
        .map(line => (line ? `<code>${line}</code>` : `<code xsi:nil="true"/>`))
        .join('\n        ');

      const routineInjection = usedReadBack
        ? `<routine>\n        ${codeElements}\n      </routine>`
        : buildRoutineElementFromCode(args.routine_code);

      // <globalCode><line> → <globalRoutineCode>
      const globalElements = usedReadBack
        ? extractedGlobalLines
            .map(line => `    <globalRoutineCode>${line}</globalRoutineCode>`)
            .join('\n')
        : (args.global_code ? buildGlobalRoutineElementsFromCode(args.global_code) : '');

      // Step 8: Inject into DTP XML
      let putXml = dtpGetResponse.body;

      // The /m deserializer is sequence-sensitive: <routine> must be the FIRST child
      // of the target <fields> element. Operate on the whole field block so the
      // routine lands before <selection>/<infoObject>/<operators>. Existing value
      // selections are kept — routine and values coexist on a field.
      const { regex: fieldsBlockRegex, block: fieldsBlock } = extractFieldBlock(putXml, fieldName, dtpUpper);
      const { openAttrs, body } = splitFieldBlock(fieldsBlock);
      const { rest } = extractRoutineElement(body);
      const newBlock =
        `<fields${setSelectedAttr(openAttrs, true)}>\n      ${routineInjection}` +
        `${rest.replace(/^\s*/, '\n      ')}</fields>`;
      putXml = putXml.replace(fieldsBlockRegex, () => newBlock);

      // Fix 2: Remove all existing <globalRoutineCode> elements before inserting new ones
      putXml = putXml.replace(/<globalRoutineCode>[^<]*<\/globalRoutineCode>\s*/g, '');

      // Append globalRoutineCode elements before </filter>
      if (globalElements) {
        putXml = putXml.replace('</filter>', `${globalElements}\n  </filter>`);
      }

      // PUT with fresh client
      const putClient = createClientFromEnv();
      await putClient.put('dtpa', dtpUpper, lockHandle, putXml, timestamp);

      // Step 9: Activate — surface any activation error instead of claiming success.
      const activationResult = await bwActivate(client, 'dtpa', dtpUpper, lockHandle);
      const activation = JSON.parse(activationResult) as { success?: boolean; messages?: unknown };
      if (activation.success === false) {
        return JSON.stringify({
          success: false,
          dtp_name: dtpUpper,
          field_name: fieldName,
          program_name: programName,
          message: `Filter routine source was syntactically valid, but DTP activation failed.`,
          activation_messages: activation.messages ?? [],
        }, null, 2);
      }

      return JSON.stringify({
        success: true,
        dtp_name: dtpUpper,
        field_name: fieldName,
        routine_source: usedReadBack ? 'server_readback' : 'supplied_code',
        ...(readBackError ? { read_back_warning: readBackError } : {}),
        message:
          `Filter routine for field '${fieldName}' on DTP '${dtpUpper}' set and activated successfully.` +
          (usedReadBack
            ? ''
            : ` Reading the code back from the generated report failed, so the routine was written ` +
              `from the supplied code — verify it with bw_get_dtp.`),
      });
    } finally {
      // The generated report registration is removed on every path: it is named after the DTP
      // and the field, so one left behind blocks every later attempt on that field.
      await deleteRoutineReport().catch(() => {/* cleanup is best-effort */});
    }
  } finally {
    // Best-effort release of the DTP enqueue lock — never mask the operation result/error.
    await bwUnlockDtp(client, dtpLower).catch(() => {/* lock may already be released */});
  }
}
