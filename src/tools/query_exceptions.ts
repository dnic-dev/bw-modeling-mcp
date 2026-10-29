import { BwClient } from '../bw-client.js';
import {
  withQueryDocument,
  escapeXml,
  unescapeXml,
  allocateVirtualId,
  locateMainComponentRegion,
  resolveVariable,
  hasSubComponentId,
  insertSubComponent,
  removeSubComponentById,
  escapeRegex,
  ResolvedVariable,
} from './query_update.js';
import { listStructures, resolveStructureMember, Structure } from './query_cells.js';

/**
 * bw_update_query_exceptions — exceptions (alert levels) of a BW Query.
 *
 * An exception is a Qry:exceptions element of the mainComponent, after the axes.
 * Wire form from a modeling-tools trace:
 *
 *   Qry:tokens            one SelectionTokenForException per threshold: alertLevel,
 *                         operator and a fromValue (Value, or VariableCIN with the
 *                         variable embedded as a subComponent); Between adds a toValue
 *   definedCell…Struc     the cells the exception is evaluated on: AllElements or
 *                         GivenElement with the member id
 *   dataCell…Struc        the cells it is shown on: EvaluatedElement, AllElements or
 *                         GivenElement
 *   evaluateBeforeListCalc / active / affectsDataCells
 *                         attributes, omitted while they hold their default (true)
 *
 * "First" and "second" structure follow firstCustomDimension, as for cells. Removing
 * an exception also drops a threshold variable nothing else references.
 */

export const ALERT_LEVELS = [
  'Good1', 'Good2', 'Good3',
  'Critical1', 'Critical2', 'Critical3',
  'Bad1', 'Bad2', 'Bad3',
] as const;
export type AlertLevel = typeof ALERT_LEVELS[number];

export const EXCEPTION_OPERATORS = [
  'Equal', 'NotEqualTo', 'LessThan', 'LessEqual', 'GreaterThan', 'GreaterEqual', 'Between', 'NotBetween',
] as const;
export type ExceptionOperator = typeof EXCEPTION_OPERATORS[number];

export interface ExceptionThreshold {
  alert_level: AlertLevel;
  operator: ExceptionOperator;
  /** Threshold value, or with Between/NotBetween the low bound. */
  value?: string | number;
  /** High bound for Between/NotBetween. */
  to_value?: string | number;
  /** A formula variable instead of a fixed value (the low bound with Between). */
  variable?: string;
  to_variable?: string;
}

export interface ExceptionOperation {
  action: 'add_exception' | 'update_exception' | 'remove_exception';
  /** Existing exception, by description or id (update_exception, remove_exception). */
  exception?: string;
  description?: string;
  thresholds?: ExceptionThreshold[];
  /** Members (one per structure at most) the exception is evaluated on; other structures: all elements. */
  defined_on?: string[];
  /** Members (one per structure at most) the alert colours; other structures: see display_all_elements. */
  display_on?: string[];
  /** Structures without a display_on member show the alert on all their elements instead of the evaluated one. */
  display_all_elements?: boolean;
  active?: boolean;
  evaluate_before_calculations?: boolean;
  affects_data_cells?: boolean;
  /** add_exception: one exception per listed member, each evaluated on that member. */
  for_each_member?: string[];
}

export interface UpdateQueryExceptionsArgs {
  query_name: string;
  operations: ExceptionOperation[];
  transport?: string;
}

export interface ExceptionElement {
  id: string;
  description: string;
  start: number;
  end: number;
  full: string;
}

interface ExceptionReport {
  action: string;
  exception: string;
  id: string;
  changes: string[];
}

const EXCEPTION_RE = /<Qry:exceptions\b[^>]*?(\/>|>[\s\S]*?<\/Qry:exceptions>)/g;

export function findExceptions(doc: string): ExceptionElement[] {
  const region = locateMainComponentRegion(doc, 'exception lookup');
  const sub = doc.slice(region.start, region.end);
  const out: ExceptionElement[] = [];
  EXCEPTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXCEPTION_RE.exec(sub)) !== null) {
    const full = m[0];
    const openTag = full.match(/^<Qry:exceptions\b[^>]*?\/?>/)?.[0] ?? full;
    out.push({
      id: openTag.match(/\bid="([^"]+)"/)?.[1] ?? '',
      description: unescapeXml(full.match(/<Qry:description\b[^>]*\bvalue="([^"]*)"/)?.[1] ?? ''),
      start: region.start + m.index,
      end: region.start + m.index + full.length,
      full,
    });
  }
  return out;
}

function resolveException(doc: string, ref: string, context: string): ExceptionElement {
  const all = findExceptions(doc);
  const byId = all.filter((e) => e.id === ref);
  const hits = byId.length > 0 ? byId : all.filter((e) => e.description === ref);
  if (hits.length === 0) {
    const known = all.map((e) => `'${e.description}'`).join(', ') || 'none';
    throw new Error(`${context}: no exception with id or description '${ref}' (exceptions: ${known}).`);
  }
  if (hits.length > 1) {
    throw new Error(`${context}: '${ref}' matches ${hits.length} exceptions (${hits.map((h) => h.id).join(', ')}). Use the id.`);
  }
  return hits[0];
}

function nextExceptionNumber(doc: string): number {
  let max = 0;
  for (const e of findExceptions(doc)) {
    const dh = e.full.match(/<Qry:defaultHint>[\s\S]*?<\/Qry:defaultHint>/)?.[0] ?? '';
    const n = dh.match(/<Qry:value>(\d+)<\/Qry:value>/)?.[1];
    if (n && parseInt(n, 10) > max) max = parseInt(n, 10);
  }
  return max + 1;
}

function checkThresholds(thresholds: ExceptionThreshold[], context: string): void {
  if (thresholds.length === 0) throw new Error(`${context}: thresholds must not be empty.`);
  for (const [i, t] of thresholds.entries()) {
    const where = `${context} threshold ${i + 1}`;
    if (!ALERT_LEVELS.includes(t.alert_level)) {
      throw new Error(`${where}: alert_level must be one of ${ALERT_LEVELS.join(', ')}.`);
    }
    if (!EXCEPTION_OPERATORS.includes(t.operator)) {
      throw new Error(`${where}: operator must be one of ${EXCEPTION_OPERATORS.join(', ')}.`);
    }
    const hasLow = t.value !== undefined && t.value !== '';
    if (hasLow === Boolean(t.variable)) throw new Error(`${where}: give either value or variable.`);
    const range = t.operator === 'Between' || t.operator === 'NotBetween';
    const hasHigh = (t.to_value !== undefined && t.to_value !== '') || Boolean(t.to_variable);
    if (range && !hasHigh) throw new Error(`${where}: ${t.operator} needs to_value or to_variable.`);
    if (!range && hasHigh) throw new Error(`${where}: to_value/to_variable only go with Between or NotBetween.`);
    if (t.to_value !== undefined && t.to_value !== '' && t.to_variable) {
      throw new Error(`${where}: give either to_value or to_variable.`);
    }
    for (const v of [t.value, t.to_value]) {
      if (v !== undefined && v !== '' && !/^-?\d+(\.\d+)?$/.test(String(v).trim())) {
        throw new Error(`${where}: '${v}' is not a number.`);
      }
    }
  }
}

function valueEl(tag: 'fromValue' | 'toValue', value: string | number | undefined, variable: ResolvedVariable | undefined, name?: string): string {
  if (variable) {
    return `<Qry:${tag}>\n      <Qry:type>VariableCIN</Qry:type>\n      <Qry:value>${escapeXml(name!.toUpperCase())}</Qry:value>\n` +
      `      <Qry:variable>${variable.componentId}</Qry:variable>\n    </Qry:${tag}>`;
  }
  return `<Qry:${tag}>\n      <Qry:type>Value</Qry:type>\n      <Qry:value>${escapeXml(String(value).trim())}</Qry:value>\n    </Qry:${tag}>`;
}

function buildTokens(thresholds: ExceptionThreshold[], variables: Map<string, ResolvedVariable>): string {
  return thresholds.map((t) => {
    const from = valueEl('fromValue', t.value, t.variable ? variables.get(t.variable.toUpperCase()) : undefined, t.variable);
    const hasHigh = (t.to_value !== undefined && t.to_value !== '') || Boolean(t.to_variable);
    const to = hasHigh
      ? '\n    ' + valueEl('toValue', t.to_value, t.to_variable ? variables.get(t.to_variable.toUpperCase()) : undefined, t.to_variable)
      : '';
    return `<Qry:tokens xsi:type="Qry:SelectionTokenForException" alertLevel="${t.alert_level}" operator="${t.operator}">\n    ${from}${to}\n  </Qry:tokens>`;
  }).join('\n  ');
}

type CellMode = { mode: 'AllElements' | 'GivenElement' | 'EvaluatedElement'; member?: string };

/** Map up to one member per structure onto the ordinal of its structure. */
function membersByStructure(structures: Structure[], refs: string[] | undefined, context: string): Map<1 | 2, string> {
  const out = new Map<1 | 2, string>();
  for (const ref of refs ?? []) {
    const hit = resolveStructureMember(structures, ref, context);
    if (out.has(hit.ordinal)) {
      throw new Error(`${context}: '${ref}' is the second member of the same structure; give at most one member per structure.`);
    }
    out.set(hit.ordinal, hit.id);
  }
  return out;
}

function cellModeEl(tag: string, cell: CellMode): string {
  const member = cell.member ? `\n    <Qry:member>${cell.member}</Qry:member>` : '';
  return `<Qry:${tag}>\n    <Qry:dataCellMode>${cell.mode}</Qry:dataCellMode>${member}\n  </Qry:${tag}>`;
}

function readCellMode(xml: string, tag: string): CellMode | undefined {
  const el = xml.match(new RegExp(`<Qry:${tag}>[\\s\\S]*?<\\/Qry:${tag}>`))?.[0];
  if (!el) return undefined;
  const mode = el.match(/<Qry:dataCellMode>([^<]*)<\/Qry:dataCellMode>/)?.[1] as CellMode['mode'] | undefined;
  const member = el.match(/<Qry:member>([^<]*)<\/Qry:member>/)?.[1];
  return mode ? { mode, ...(member ? { member } : {}) } : undefined;
}

interface CellScope {
  defined: [CellMode, CellMode];
  display: [CellMode, CellMode];
}

function scopeFor(structures: Structure[], op: ExceptionOperation, current: CellScope | undefined, context: string): CellScope {
  const defined: [CellMode, CellMode] = current
    ? [...current.defined]
    : [{ mode: 'AllElements' }, { mode: 'AllElements' }];
  const display: [CellMode, CellMode] = current
    ? [...current.display]
    : [{ mode: 'EvaluatedElement' }, { mode: 'EvaluatedElement' }];
  if (op.defined_on !== undefined) {
    const given = membersByStructure(structures, op.defined_on, `${context} defined_on`);
    for (const ord of [1, 2] as const) {
      const member = given.get(ord);
      defined[ord - 1] = member ? { mode: 'GivenElement', member } : { mode: 'AllElements' };
    }
  }
  if (op.display_on !== undefined || op.display_all_elements !== undefined) {
    const given = op.display_on !== undefined
      ? membersByStructure(structures, op.display_on, `${context} display_on`)
      : new Map([1, 2].flatMap((ord) => {
          const d = display[ord - 1];
          return d.mode === 'GivenElement' && d.member ? [[ord as 1 | 2, d.member]] : [];
        }));
    const rest: CellMode['mode'] = op.display_all_elements ? 'AllElements' : 'EvaluatedElement';
    for (const ord of [1, 2] as const) {
      const member = given.get(ord);
      display[ord - 1] = member ? { mode: 'GivenElement', member } : { mode: rest };
    }
  }
  return { defined, display };
}

function scopeEls(scope: CellScope): string {
  return [
    cellModeEl('definedCellFirstStruc', scope.defined[0]),
    cellModeEl('definedCellSecondStruc', scope.defined[1]),
    cellModeEl('dataCellFirstStruc', scope.display[0]),
    cellModeEl('dataCellSecondStruc', scope.display[1]),
  ].join('\n  ');
}

function flagAttrs(active: boolean, before: boolean, dataCells: boolean): string {
  return (active ? '' : ' active="false"') +
    (before ? '' : ' evaluateBeforeListCalc="false"') +
    (dataCells ? '' : ' affectsDataCells="false"');
}

function readFlag(openTag: string, attr: string): boolean {
  return openTag.match(new RegExp(`\\b${attr}="([^"]*)"`))?.[1] !== 'false';
}

function buildException(
  id: string,
  n: number,
  description: string,
  tokens: string,
  scope: CellScope,
  flags: { active: boolean; before: boolean; dataCells: boolean },
  chaCell: string,
): string {
  return `<Qry:exceptions id="${id}" affectsChasNotListed="all"${flagAttrs(flags.active, flags.before, flags.dataCells)}>
  <Qry:description default="false" value="${escapeXml(description)}"/>
  <Qry:defaultHint>
    <Qry:type>Constant</Qry:type>
    <Qry:value>${n}</Qry:value>
  </Qry:defaultHint>
  ${tokens}
  ${scopeEls(scope)}
  ${chaCell}
</Qry:exceptions>`;
}

/** After the last exception, or else right after the axes. */
function insertException(doc: string, xml: string): string {
  const existing = findExceptions(doc);
  const at = existing.length > 0
    ? existing[existing.length - 1].end
    : (() => {
        const region = locateMainComponentRegion(doc, 'exception insertion');
        const sub = doc.slice(region.start, region.end);
        const axisRe = /<Qry:(rows|columns|free)\b[^>]*?(\/>|>[\s\S]*?<\/Qry:\1>)/g;
        let axisEnd = -1;
        let m: RegExpExecArray | null;
        while ((m = axisRe.exec(sub)) !== null) axisEnd = m.index + m[0].length;
        if (axisEnd < 0) throw new Error('The query has no axes; an exception needs a key figure in the layout.');
        return region.start + axisEnd;
      })();
  return doc.slice(0, at) + '\n' + xml + doc.slice(at);
}

function describeScope(structures: Structure[], scope: CellScope): string {
  const name = (id: string | undefined) =>
    structures.flatMap((s) => s.members).find((m) => m.id === id)?.description ?? id ?? '';
  const part = (cells: [CellMode, CellMode], fallback: string) =>
    structures.map((s, i) => {
      const c = cells[i];
      const what = c.mode === 'GivenElement' ? `'${name(c.member)}'` : c.mode === 'AllElements' ? 'all elements' : fallback;
      return `${s.description}: ${what}`;
    }).join(', ');
  return `evaluated on ${part(scope.defined, 'all elements')}; shown on ${part(scope.display, 'the evaluated element')}`;
}

function thresholdVariables(thresholds: ExceptionThreshold[] | undefined): string[] {
  return (thresholds ?? []).flatMap((t) => [t.variable, t.to_variable]).filter((v): v is string => Boolean(v)).map((v) => v.toUpperCase());
}

function embedVariables(doc: string, names: string[], variables: Map<string, ResolvedVariable>): string {
  let out = doc;
  for (const name of names) {
    const v = variables.get(name)!;
    if (!hasSubComponentId(out, v.componentId)) out = insertSubComponent(out, v.subComponentXml);
    for (const extra of v.extraSubComponents) {
      if (!hasSubComponentId(out, extra.id)) out = insertSubComponent(out, extra.xml);
    }
  }
  return out;
}

/** Drop variable subComponents the removed exception referenced and nothing references any more. */
function dropUnusedVariables(doc: string, removedXml: string): string {
  let out = doc;
  for (const m of removedXml.matchAll(/<Qry:variable>([^<]+)<\/Qry:variable>/g)) {
    const id = m[1];
    const stillUsed = new RegExp(`<Qry:variable>${escapeRegex(id)}</Qry:variable>|\\bvariable="${escapeRegex(id)}"`).test(
      out.replace(/<Qry:subComponents\b[^>]*?(\/>|>[\s\S]*?<\/Qry:subComponents>)/g, '')
    );
    if (!stillUsed) out = removeSubComponentById(out, id);
  }
  return out;
}

function applyOperation(
  state: { doc: string },
  op: ExceptionOperation,
  variables: Map<string, ResolvedVariable>,
  reports: ExceptionReport[],
): void {
  const structures = listStructures(state.doc);
  switch (op.action) {
    case 'add_exception': {
      if (!op.description) throw new Error('description is required.');
      if (!op.thresholds) throw new Error('thresholds are required.');
      checkThresholds(op.thresholds, 'add_exception');
      if (structures.length === 0) {
        throw new Error('The query has no structure; an exception is evaluated on the members of the key figure structure.');
      }
      const targets = op.for_each_member && op.for_each_member.length > 0 ? op.for_each_member : [undefined];
      for (const member of targets) {
        let defined = op.defined_on;
        let description = op.description;
        if (member !== undefined) {
          const hit = resolveStructureMember(structures, member, 'for_each_member');
          const others = (op.defined_on ?? []).filter(
            (ref) => resolveStructureMember(structures, ref, 'defined_on').ordinal !== hit.ordinal
          );
          defined = [hit.id, ...others];
          description = `${op.description} ${hit.description}`;
        }
        const scope = scopeFor(structures, { ...op, defined_on: defined ?? [] }, undefined, 'add_exception');
        const vid = allocateVirtualId(state.doc);
        const xml = buildException(
          vid,
          nextExceptionNumber(state.doc),
          description,
          buildTokens(op.thresholds, variables),
          scope,
          {
            active: op.active ?? true,
            before: op.evaluate_before_calculations ?? true,
            dataCells: op.affects_data_cells ?? true,
          },
          '<Qry:chaCell>Rows</Qry:chaCell>',
        );
        state.doc = embedVariables(insertException(state.doc, xml), thresholdVariables(op.thresholds), variables);
        reports.push({
          action: 'add_exception',
          exception: description,
          id: vid,
          changes: [
            `thresholds: ${op.thresholds.map(formatThreshold).join('; ')}`,
            describeScope(structures, scope),
          ],
        });
      }
      return;
    }
    case 'update_exception': {
      if (!op.exception) throw new Error('exception is required.');
      if (op.for_each_member) throw new Error('for_each_member only goes with add_exception.');
      const target = resolveException(state.doc, op.exception, 'update_exception');
      const openTag = target.full.match(/^<Qry:exceptions\b[^>]*?>/)?.[0] ?? '';
      const changes: string[] = [];
      const current: CellScope = {
        defined: [
          readCellMode(target.full, 'definedCellFirstStruc') ?? { mode: 'AllElements' },
          readCellMode(target.full, 'definedCellSecondStruc') ?? { mode: 'AllElements' },
        ],
        display: [
          readCellMode(target.full, 'dataCellFirstStruc') ?? { mode: 'EvaluatedElement' },
          readCellMode(target.full, 'dataCellSecondStruc') ?? { mode: 'EvaluatedElement' },
        ],
      };
      const scope = scopeFor(structures, op, current, 'update_exception');
      if (op.defined_on !== undefined || op.display_on !== undefined || op.display_all_elements !== undefined) {
        changes.push(describeScope(structures, scope));
      }
      let tokens = [...target.full.matchAll(/<Qry:tokens\b[^>]*?(\/>|>[\s\S]*?<\/Qry:tokens>)/g)].map((m) => m[0]).join('\n  ');
      if (op.thresholds) {
        checkThresholds(op.thresholds, 'update_exception');
        tokens = buildTokens(op.thresholds, variables);
        changes.push(`thresholds: ${op.thresholds.map(formatThreshold).join('; ')}`);
      }
      const description = op.description ?? target.description;
      if (op.description !== undefined) changes.push(`description '${op.description}'`);
      const flags = {
        active: op.active ?? readFlag(openTag, 'active'),
        before: op.evaluate_before_calculations ?? readFlag(openTag, 'evaluateBeforeListCalc'),
        dataCells: op.affects_data_cells ?? readFlag(openTag, 'affectsDataCells'),
      };
      if (op.active !== undefined) changes.push(op.active ? 'active' : 'inactive');
      if (op.evaluate_before_calculations !== undefined) {
        changes.push(op.evaluate_before_calculations ? 'evaluated before calculations' : 'evaluated after calculations');
      }
      if (op.affects_data_cells !== undefined) changes.push(op.affects_data_cells ? 'shown in data cells' : 'not shown in data cells');
      if (changes.length === 0) throw new Error('Nothing to change: pass description, thresholds, defined_on, display_on or a flag.');
      const hint = target.full.match(/<Qry:defaultHint>[\s\S]*?<\/Qry:defaultHint>/)?.[0];
      const n = parseInt(hint?.match(/<Qry:value>(\d+)<\/Qry:value>/)?.[1] ?? '', 10) || nextExceptionNumber(state.doc);
      const chaCell = target.full.match(/<Qry:chaCell\b[^>]*?(\/>|>[\s\S]*?<\/Qry:chaCell>)/)?.[0] ?? '<Qry:chaCell>Rows</Qry:chaCell>';
      const xml = buildException(target.id, n, description, tokens, scope, flags, chaCell);
      let doc = state.doc.slice(0, target.start) + xml + state.doc.slice(target.end);
      if (op.thresholds) doc = dropUnusedVariables(embedVariables(doc, thresholdVariables(op.thresholds), variables), target.full);
      state.doc = doc;
      reports.push({ action: 'update_exception', exception: description, id: target.id, changes });
      return;
    }
    case 'remove_exception': {
      if (!op.exception) throw new Error('exception is required.');
      const target = resolveException(state.doc, op.exception, 'remove_exception');
      const before = state.doc.slice(0, target.start).replace(/\n[ \t]*$/, '');
      state.doc = dropUnusedVariables(before + state.doc.slice(target.end), target.full);
      reports.push({ action: 'remove_exception', exception: target.description, id: target.id, changes: ['removed'] });
      return;
    }
    default:
      throw new Error(`Unknown exception action '${String((op as { action?: string }).action)}'.`);
  }
}

function formatThreshold(t: ExceptionThreshold): string {
  const low = t.variable ? `variable ${t.variable.toUpperCase()}` : String(t.value);
  const high = t.to_variable ? `variable ${t.to_variable.toUpperCase()}` : t.to_value !== undefined ? String(t.to_value) : undefined;
  return `${t.alert_level} if ${t.operator} ${low}${high !== undefined ? ` and ${high}` : ''}`;
}

/** Apply all operations to a query document; exported for offline tests. */
export function applyExceptionOperations(
  doc: string,
  operations: ExceptionOperation[],
  variables: Map<string, ResolvedVariable> = new Map(),
): { doc: string; reports: ExceptionReport[] } {
  const state = { doc };
  const reports: ExceptionReport[] = [];
  operations.forEach((op, i) => {
    try {
      applyOperation(state, op, variables, reports);
    } catch (err) {
      throw new Error(`Operation ${i + 1} (${op.action}): ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return { doc: state.doc, reports };
}

export async function bwUpdateQueryExceptions(client: BwClient, args: UpdateQueryExceptionsArgs): Promise<string> {
  if (!args.query_name) throw new Error('query_name is required.');
  if (!Array.isArray(args.operations) || args.operations.length === 0) throw new Error('operations must be a non-empty array.');
  const variables = new Map<string, ResolvedVariable>();
  for (const name of new Set(args.operations.flatMap((op) => thresholdVariables(op.thresholds)))) {
    const resolved = await resolveVariable(client, name);
    if (resolved.characteristic !== '1FORMULA') {
      throw new Error(`Variable '${name}' is not a formula variable; an exception threshold takes a formula variable.`);
    }
    variables.set(name, resolved);
  }
  let reports: ExceptionReport[] = [];
  const { messages } = await withQueryDocument(client, args.query_name, (xml) => {
    const result = applyExceptionOperations(xml, args.operations, variables);
    reports = result.reports;
    return result.doc;
  }, args.transport);
  return JSON.stringify({
    success: true,
    query_name: args.query_name.toUpperCase(),
    operations: reports,
    note: 'Ids starting with !VIRTUAL- are placeholders the server replaced on save; bw_get_query shows the final ids.',
    check_messages: messages,
  });
}
