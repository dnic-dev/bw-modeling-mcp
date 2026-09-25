import type { BwClient } from '../bw-client.js';
import { queryTable, sqlLiteral, formatStamp, inListBatches, type Row } from './metadata_sql.js';

/**
 * Read an Analysis Process (APD, TLOGO ANPR) from its metadata table.
 *
 * Unlike the other readers here this one closes no gap of a particular release: BW/4HANA
 * dropped the object type altogether and no release ever published a REST resource for it,
 * so the metadata table is the only route on any platform — the same situation as data
 * slices, and the reason the classic providers are read this way too.
 *
 * The whole definition sits in one XML document in `RSANT_PROCESS.XML`. That column is typed
 * STRG, and the DataPreview service does return it (verified) — worth stating, because the
 * service does drop other long-text column types and it would be easy to conclude the
 * definition is out of reach.
 */

// ── The node catalogue ──────────────────────────────────────────────────────

/**
 * What a node type is, and which of its attributes names the object it touches.
 *
 * The XML tag *is* the node type, and its prefix carries the category: DS_ reads, DST_
 * transforms, DT_ writes. That is what makes an unknown type harmless — it is still placed
 * in the right category and named, which is what the alternative (silently dropping it)
 * would not do. Collected from every analysis process on a reference system, the shipped
 * content included.
 */
const NODE_TYPES: Record<string, { label: string; objectAttr?: string }> = {
  // Sources
  DS_INFOPROV: { label: 'source: InfoProvider', objectAttr: 'INFOPROV' },
  DS_QUERY: { label: 'source: query', objectAttr: 'REPORT_ID' },
  DS_INFOOBJECT: { label: 'source: InfoObject master data', objectAttr: 'INFOOBJECT' },
  // Transformations
  DST_FILTER: { label: 'filter' },
  DST_FORMULAS: { label: 'formulas' },
  DST_JOIN: { label: 'join', objectAttr: 'TYPE' },
  DST_PROJECTION: { label: 'projection (field selection)' },
  DST_GROUP_BY: { label: 'aggregation (group by)' },
  DST_ROUTINE: { label: 'ABAP routine' },
  DST_HIERAGGR: { label: 'hierarchy aggregation' },
  DST_UNION: { label: 'union' },
  DST_SORT: { label: 'sort' },
  DST_DM_ABC: { label: 'data mining: ABC classification', objectAttr: 'DM_MODEL' },
  DST_REGRESSION: { label: 'data mining: regression' },
  DST_LIST_VEC: { label: 'transpose: list to vector' },
  DST_VEC_LIST: { label: 'transpose: vector to list' },
  // Targets
  DT_ODS: { label: 'target: DataStore object', objectAttr: 'ODS' },
  DT_FILE: { label: 'target: file', objectAttr: 'FILE' },
  DT_INFOOBJECT: { label: 'target: InfoObject master data', objectAttr: 'INFOOBJECT' },
  DT_DM_MODEL: { label: 'target: data mining model', objectAttr: 'DM_MODEL' },
  DT_TARGET_GROUP: { label: 'target: CRM target group', objectAttr: 'TARGET_GROUP' },
};

/** The category a node falls into, from its prefix — known type or not. */
function categoryOf(tag: string): 'source' | 'transformation' | 'target' | 'unknown' {
  if (tag.startsWith('DST_')) return 'transformation';
  if (tag.startsWith('DS_')) return 'source';
  if (tag.startsWith('DT_')) return 'target';
  return 'unknown';
}

function describeType(tag: string): string {
  const known = NODE_TYPES[tag];
  if (known) return known.label;
  const category = categoryOf(tag);
  // Named, not swallowed: a node type this catalogue does not know still has to appear with
  // its tag, because the alternative is a process that silently reads from nowhere.
  return category === 'unknown'
    ? `unknown node type ${tag}`
    : `${category}, type ${tag} not in this catalogue`;
}

// ── XML parsing ─────────────────────────────────────────────────────────────

export interface ApdNode {
  /** The XML tag, which is the node type. */
  type: string;
  name: string;
  text: string;
  attributes: Record<string, string>;
  /** Body of the element, empty for a self-closing one. */
  body: string;
}

/**
 * One field rule of a mapping: MR_COPY moves a source field into a target field, MR_CONST
 * sets a target field to a constant. Any other rule type is kept with its tag, so it still
 * shows up rather than being dropped.
 */
export interface ApdRule {
  type: string;
  source: string;
  target: string;
  value?: string;
}

export interface ApdEdge {
  name: string;
  text: string;
  source: string;
  target: string;
  rules: ApdRule[];
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(/([A-Z_0-9]+)="([^"]*)"/g)) attrs[m[1]] = m[2].trim();
  return attrs;
}

/**
 * Nodes and edges of one analysis process.
 *
 * Edges come from `<MAPPINGS>`, never from the order of `<NODES>` — the same trap as with
 * process chains, where the document order says nothing about what runs after what.
 */
export function parseApdXml(xml: string): { nodes: ApdNode[]; edges: ApdEdge[]; header: Record<string, string> } {
  const headerRaw = xml.match(/<ANALYSIS_PROCESS\b([^>]*)>/)?.[1] ?? '';
  const nodesBlock = xml.match(/<NODES>([\s\S]*?)<\/NODES>/)?.[1] ?? '';

  const nodes: ApdNode[] = [];
  // Self-closing and paired elements in one pass; the body of a paired one carries the
  // details (a filter's ranges, a routine's field lists).
  const re = /<([A-Z][A-Z_0-9]*)\s([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(nodesBlock)) !== null) {
    const attrs = parseAttributes(m[2]);
    if (!attrs.NAME) continue;
    nodes.push({
      type: m[1],
      name: attrs.NAME,
      text: attrs.TEXT ?? '',
      attributes: attrs,
      body: m[3] ?? '',
    });
  }

  const edges: ApdEdge[] = [];
  const mappings = xml.match(/<MAPPINGS>([\s\S]*?)<\/MAPPINGS>/)?.[1] ?? '';
  // The field rules of an edge sit in the body of its <MAPPING>, so the element has to be
  // read with its body, not just its opening tag.
  for (const e of mappings.matchAll(/<MAPPING\b([^>]*?)(?:\/>|>([\s\S]*?)<\/MAPPING>)/g)) {
    const attrs = parseAttributes(e[1]);
    if (attrs.SOURCE || attrs.TARGET) {
      const rules: ApdRule[] = [];
      for (const r of (e[2] ?? '').matchAll(/<(MR_[A-Z_0-9]+)\b([^>]*?)\/?>/g)) {
        const ra = parseAttributes(r[2]);
        rules.push({ type: r[1], source: ra.SOURCE ?? '', target: ra.TARGET ?? '', value: ra.VALUE });
      }
      edges.push({
        name: attrs.NAME ?? '',
        text: attrs.TEXT ?? '',
        source: attrs.SOURCE ?? '',
        target: attrs.TARGET ?? '',
        rules,
      });
    }
  }

  return { nodes, edges, header: parseAttributes(headerRaw) };
}

/**
 * Field rules as lines: copies as "source → target", constants as "target = 'value'".
 * Constants come first — a target field that no copy fills but a constant does, a version
 * for instance, is usually what the reader is looking for.
 */
export function renderRules(rules: ApdRule[], indent: string): string[] {
  const constants = rules.filter((r) => r.type === 'MR_CONST');
  const rest = rules.filter((r) => r.type !== 'MR_CONST');
  return [
    ...constants.map((r) => `${indent}${r.target} = '${r.value ?? ''}'   (constant)`),
    ...rest.map((r) =>
      r.type === 'MR_COPY'
        ? `${indent}${r.source} → ${r.target}`
        : `${indent}${r.source || '(none)'} → ${r.target || '(none)'}   ` +
          `(${r.type}${r.value !== undefined ? `, value '${r.value}'` : ''})`,
    ),
  ];
}

/**
 * Nodes in execution order: every node after the ones feeding it.
 *
 * A plain topological sort, and a cycle — which the editor should not allow but a corrupted
 * definition can still hold — ends the ordering rather than looping; whatever is left is
 * appended and marked, because dropping it would misreport the process as smaller than it is.
 */
export function orderApdNodes(nodes: ApdNode[], edges: ApdEdge[]): { ordered: ApdNode[]; cyclic: ApdNode[] } {
  const incoming = new Map<string, string[]>();
  for (const n of nodes) incoming.set(n.name, []);
  for (const e of edges) {
    if (incoming.has(e.target)) incoming.get(e.target)!.push(e.source);
  }

  const ordered: ApdNode[] = [];
  const done = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const n of nodes) {
      if (done.has(n.name)) continue;
      const preds = incoming.get(n.name) ?? [];
      if (preds.every((p) => done.has(p) || !incoming.has(p))) {
        ordered.push(n);
        done.add(n.name);
        progress = true;
      }
    }
  }

  return { ordered, cyclic: nodes.filter((n) => !done.has(n.name)) };
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** A filter node states its ranges; they are what the filter actually does. */
function renderFilter(body: string, indent: string): string[] {
  const out: string[] = [];
  for (const r of body.matchAll(/<RANGE\b([^>]*?)\/?>/g)) {
    const a = parseAttributes(r[1]);
    const value = a.VAR_LOW ? `variable ${a.VAR_LOW}` : `"${a.LOW ?? ''}"`;
    const high = a.HIGH ? `  to "${a.HIGH}"` : '';
    // NAME is the field the range applies to — a 25-character element id in a query source.
    out.push(`${indent}${a.NAME ?? '(field?)'}  [${a.SIGN ?? 'I'} ${a.OPT ?? a.OPTION ?? 'EQ'}]  ${value}${high}`);
  }
  return out;
}

/** The formulas of a formula node, one per line. */
function renderFormulas(body: string, indent: string): string[] {
  const out: string[] = [];
  for (const f of body.matchAll(/<FORMULA\b([^>]*?)\/?>/g)) {
    const a = parseAttributes(f[1]);
    const target = a.NAME ?? a.FIELD ?? '';
    const expr = a.FORMULA ?? a.DEFINITION ?? a.EXPRESSION ?? '';
    out.push(`${indent}${target}${expr ? ` = ${expr}` : ''}`);
  }
  return out;
}

function indentLines(code: string, indent: string): string[] {
  return code.split(/\r?\n/).map((l) => `${indent}| ${l}`);
}

/**
 * Query UIDs to their technical names.
 *
 * RSANT_PROCESSI records a query source as TLOGO `ELEM` with the 25-character component UID,
 * which identifies the object but says nothing to a reader. RSZCOMPDIR carries the name.
 * Best effort: an unresolved UID is still printed, which is what identifies the object.
 */
async function resolveQueryUids(client: BwClient, uids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set(uids.filter((u) => /^[A-Z0-9]{25}$/.test(u)))];
  if (unique.length === 0) return names;
  for (const batch of inListBatches(unique, 120)) {
    try {
      const rows = await queryTable(
        client,
        `SELECT compuid, compid, objvers FROM rszcompdir WHERE compuid IN (${batch})`,
        100,
      );
      for (const r of rows.filter((r) => r.OBJVERS === 'A')) names.set(r.COMPUID, r.COMPID);
      for (const r of rows) if (!names.has(r.COMPUID)) names.set(r.COMPUID, r.COMPID);
    } catch {
      // A name is an enrichment; the UID alone identifies the query.
    }
  }
  return names;
}

/**
 * The fields an analysis process reads from a query, with what each one is.
 *
 * A query source hands its key figures on under generic names (KYF_0001, …). The node that
 * consumes them lists each as a FIELD_REF whose NAME is the UID of the query's structure
 * element; the element's text is in RSZELTTXT, and the key figure behind it is its 1KYFNM
 * selection in RSZRANGE — a key figure name, or the UID of a calculated or restricted key
 * figure. Characteristics arrive under their field name and need no lookup. Resolving by UID
 * rather than by position keeps the mapping right when the structure is reordered.
 */
export async function describeQueryFields(client: BwClient, nodes: ApdNode[]): Promise<string[]> {
  const refs = new Map<string, string>();
  for (const n of nodes) {
    for (const m of n.body.matchAll(/<FIELD_REF\b([^>]*?)\/?>/g)) {
      const a = parseAttributes(m[1]);
      if (a.NAME && a.FIELDNAME && !refs.has(a.FIELDNAME)) refs.set(a.FIELDNAME, a.NAME);
    }
  }
  const isUid = (v: string) => /^[A-Z0-9]{25}$/.test(v);
  const uids = [...new Set([...refs.values()].filter(isUid))];

  const texts = new Map<string, string>();
  const measures = new Map<string, string>();
  for (const batch of inListBatches(uids, 150)) {
    try {
      for (const r of await queryTable(
        client,
        `SELECT eltuid, langu, txtlg FROM rszelttxt WHERE objvers = 'A' AND eltuid IN (${batch})`,
        500,
      )) {
        if (r.TXTLG && (r.LANGU === 'E' || !texts.has(r.ELTUID))) texts.set(r.ELTUID, r.TXTLG.trim());
      }
      for (const r of await queryTable(
        client,
        `SELECT eltuid, low FROM rszrange WHERE objvers = 'A' AND iobjnm = '1KYFNM' AND eltuid IN (${batch})`,
        500,
      )) {
        measures.set(r.ELTUID, r.LOW);
      }
    } catch {
      // An enrichment; the field names are listed regardless.
    }
  }
  const componentNames = await resolveQueryUids(client, [...measures.values()].filter(isUid));

  return [...refs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([field, name]) => {
      if (!isUid(name)) return `${field} = ${name}`;
      const measure = measures.get(name);
      const behind = measure ? componentNames.get(measure) ?? measure : '';
      const text = texts.get(name);
      return `${field} = ${text ?? `element ${name}`}${behind ? ` (${behind})` : ''}`;
    });
}

// ── Entry point ─────────────────────────────────────────────────────────────

/** Which version to read, and what to say about it. A is the active one; D is shipped content. */
const VERSION_ORDER = ['A', 'D', 'M'] as const;
const VERSION_LABEL: Record<string, string> = {
  A: 'active',
  D: 'delivered content (not activated on this system)',
  M: 'modified (not activated)',
};

/**
 * The analysis processes matching a pattern. The BW search index does not contain them on
 * any release, so this is how they are found by name.
 */
async function listAnalysisProcesses(client: BwClient, pattern: string): Promise<string> {
  const like = sqlLiteral(pattern.trim().toUpperCase()).replace(/\*/g, '%');
  const rows = await queryTable(
    client,
    `SELECT process, objvers, tstpnm, timestmp FROM rsant_process WHERE process LIKE '${like}'`,
    1000,
  );
  const rank = (v: string) => {
    const i = (VERSION_ORDER as readonly string[]).indexOf(v);
    return i < 0 ? VERSION_ORDER.length : i;
  };
  const heads = new Map<string, Row>();
  for (const r of rows) {
    const held = heads.get(r.PROCESS);
    if (!held || rank(r.OBJVERS) < rank(held.OBJVERS)) {
      heads.set(r.PROCESS, r);
    }
  }
  if (heads.size === 0) {
    return (
      `No analysis process matches ${pattern} (RSANT_PROCESS). Analysis processes exist on ` +
      `classic SAP BW only — BW/4HANA does not have the object type.`
    );
  }

  const texts = new Map<string, string>();
  for (const batch of inListBatches([...heads.keys()], 150)) {
    try {
      const t = await queryTable(
        client,
        `SELECT process, spras, txtlg FROM rsant_processt WHERE process IN (${batch}) AND objvers = 'A'`,
        500,
      );
      for (const r of t) {
        if (r.TXTLG && (r.SPRAS === 'E' || !texts.has(r.PROCESS))) texts.set(r.PROCESS, r.TXTLG.trim());
      }
    } catch {
      // A description is an enrichment; the name identifies the process.
    }
  }

  const out = [`Analysis processes matching ${pattern.toUpperCase()}: ${heads.size}`, ''];
  for (const r of [...heads.values()].sort((a, b) => a.PROCESS.localeCompare(b.PROCESS))) {
    const text = texts.get(r.PROCESS);
    out.push(
      `  ${r.PROCESS}${text ? ` — ${text}` : ''}   [${VERSION_LABEL[r.OBJVERS] ?? r.OBJVERS}, ` +
        `changed ${formatStamp(r.TIMESTMP)} by ${r.TSTPNM || '(unknown)'}]`,
    );
  }
  out.push('', 'Read one with object_type="ANPR" and its name.');
  return out.join('\n');
}

export async function readAnalysisProcess(client: BwClient, processName: string): Promise<string> {
  if (processName.includes('*')) return listAnalysisProcesses(client, processName);
  const name = sqlLiteral(processName.trim().toUpperCase());

  const versions = await queryTable(
    client,
    `SELECT process, objvers, objstat, activfl, appl, tstpnm, timestmp ` +
      `FROM rsant_process WHERE process = '${name}'`,
    10,
  );
  if (versions.length === 0) {
    return (
      `Analysis process ${processName} not found (no entry in RSANT_PROCESS). Analysis ` +
      `processes exist on classic SAP BW only — BW/4HANA does not have the object type.`
    );
  }

  const head =
    VERSION_ORDER.map((v) => versions.find((r) => r.OBJVERS === v)).find(Boolean) ?? versions[0];
  const version = head.OBJVERS;

  const [texts, [xmlRow], used] = [
    await queryTable(client, `SELECT spras, txtlg, txtsh FROM rsant_processt WHERE process = '${name}' AND objvers = '${version}'`, 20),
    await queryTable(client, `SELECT xml FROM rsant_process WHERE process = '${name}' AND objvers = '${version}'`, 1),
    await queryTable(client, `SELECT tlogo, objnm FROM rsant_processi WHERE process = '${name}' AND objvers = '${version}'`, 200),
  ];

  const description =
    texts.find((t) => t.SPRAS === 'E' && t.TXTLG)?.TXTLG ?? texts.find((t) => t.TXTLG)?.TXTLG ?? '';

  const out: string[] = [];
  out.push(`Analysis Process: ${head.PROCESS}`);
  out.push('Source: metadata tables (read-only — no release publishes a REST resource for the');
  out.push('        analysis process, and BW/4HANA does not have the object type at all)');
  if (description) out.push(`Description:  ${description.trim()}`);
  out.push(`Application:  ${head.APPL || '(none)'}`);
  out.push(`Version:      ${version} — ${VERSION_LABEL[version] ?? 'unknown version'}`);
  if (versions.length > 1) {
    out.push(`              (also present as ${versions.filter((v) => v.OBJVERS !== version).map((v) => v.OBJVERS).join(', ')})`);
  }
  out.push(`Last changed: ${formatStamp(head.TIMESTMP)} by ${head.TSTPNM || '(unknown)'}`);

  const xml = xmlRow?.XML ?? '';
  if (!xml.trim()) {
    out.push('');
    out.push('The definition (RSANT_PROCESS.XML) is empty for this version — nothing to render.');
    return out.join('\n');
  }

  const { nodes, edges } = parseApdXml(xml);
  const queryFields = nodes.some((n) => n.type === 'DS_QUERY') ? await describeQueryFields(client, nodes) : [];
  const { ordered, cyclic } = orderApdNodes(nodes, edges);

  const predecessors = new Map<string, string[]>();
  for (const e of edges) {
    predecessors.set(e.target, [...(predecessors.get(e.target) ?? []), e.source]);
  }

  out.push('');
  out.push(`── Nodes (${nodes.length}, in execution order) ──`);
  for (const [i, node] of [...ordered, ...cyclic].entries()) {
    const known = NODE_TYPES[node.type];
    out.push(`  ${i + 1}. ${node.name}${node.text ? ` — ${node.text}` : ''}   [${describeType(node.type)}]`);

    const preds = predecessors.get(node.name) ?? [];
    out.push(`       after: ${preds.length > 0 ? preds.join(', ') : '(start of the process)'}`);

    const objectValue = known?.objectAttr ? node.attributes[known.objectAttr] : '';
    if (objectValue) out.push(`       ${known!.objectAttr!.toLowerCase()}: ${objectValue}`);

    if (node.type === 'DS_QUERY' && queryFields.length > 0) {
      out.push(`       output fields (${queryFields.length}):`);
      for (const f of queryFields) out.push(`         ${f}`);
    }

    // Details that are the point of the node rather than decoration.
    if (node.type === 'DT_FILE') {
      const a = node.attributes;
      const bits = [a.FILE_TYPE, a.FILE_WITH_HEADER === 'X' ? 'with header' : '', a.FILE_WRITE_MODE]
        .filter(Boolean)
        .join(', ');
      if (bits) out.push(`       format: ${bits}`);
    }
    if (node.type === 'DST_ROUTINE' && node.attributes.CODE) {
      out.push(`       ABAP routine:`);
      out.push(...indentLines(node.attributes.CODE, '         '));
    }
    if (node.body) {
      const filter = renderFilter(node.body, '         ');
      if (filter.length > 0) {
        out.push(`       filter (${filter.length}):`);
        out.push(...filter);
      }
      const formulas = renderFormulas(node.body, '         ');
      if (formulas.length > 0) {
        out.push(`       formulas (${formulas.length}):`);
        out.push(...formulas);
      }
    }
  }

  if (cyclic.length > 0) {
    out.push('');
    out.push(
      `${cyclic.length} node(s) could not be ordered — their mappings form a cycle, so the ` +
        `positions above are not an execution order for them.`,
    );
  }

  const unknown = nodes.filter((n) => !NODE_TYPES[n.type]);
  if (unknown.length > 0) {
    out.push('');
    out.push(`Node types not in this reader's catalogue: ${[...new Set(unknown.map((n) => n.type))].join(', ')}.`);
    out.push('They are listed above with their attributes; only the readable label is missing.');
  }

  out.push('');
  out.push(`── Edges (${edges.length}) ──`);
  if (edges.length === 0) {
    out.push('  (none — the nodes are not connected)');
  } else {
    for (const e of edges) {
      out.push(`  ${e.source} → ${e.target}${e.text ? `   (${e.text})` : ''}`);
      if (e.rules.length === 0) {
        out.push('      (no field rules stored for this edge)');
        continue;
      }
      out.push(`      field rules (${e.rules.length}):`);
      out.push(...renderRules(e.rules, '        '));
    }
  }

  // One row per usage kind (ASC_TYPE), so the same object appears several times. The kind is
  // not reported here, and listing an object twice would read as two dependencies.
  const distinct = [...new Map(used.map((u) => [`${u.TLOGO}/${u.OBJNM}`, u])).values()].sort((a, b) =>
    (a.TLOGO + a.OBJNM).localeCompare(b.TLOGO + b.OBJNM),
  );
  if (distinct.length > 0) {
    const names = await resolveQueryUids(
      client,
      distinct.filter((u) => u.TLOGO === 'ELEM').map((u) => u.OBJNM),
    );
    out.push('');
    out.push(`── BW objects used (${distinct.length}, from RSANT_PROCESSI) ──`);
    for (const u of distinct) {
      const readable = names.get(u.OBJNM);
      out.push(`  ${u.TLOGO}  ${u.OBJNM}${readable ? ` — ${readable}` : ''}`);
    }
  }

  return out.join('\n');
}

export type { Row };
