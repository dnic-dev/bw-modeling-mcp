import { BwClient, createClientFromEnv } from '../bw-client.js';

/**
 * Characteristic hierarchies through the BW/4HANA data API (/sap/bc/http/sap/bw4/v1/data),
 * the service behind the hierarchy maintenance app. Neither the modeling API nor a classic
 * release has a resource for hierarchy content.
 *
 * Two details of that API decide whether a write works:
 *   - It answers 415 unless every request, a GET included, carries Content-Type
 *     application/json and Accept *slash*.
 *   - The node content is written as the app's change log, not as the finished tree: each node
 *     is inserted ("I") with no links, then changed ("C") to its final child and next links,
 *     node ids as plain numbers. A tree sent as finished rows kept a work process busy until
 *     it was cancelled.
 */

const BASE = '/sap/bc/http/sap/bw4/v1';
const JSON_HEADERS = { Accept: '*/*', 'Content-Type': 'application/json' };
export const TEXT_NODE = '0HIER_NODE';

async function apiToken(client: BwClient): Promise<string> {
  const { headers } = await client.rawGet(`${BASE}/system/ping`, { ...JSON_HEADERS, 'x-csrf-token': 'Fetch' });
  const token = headers['x-csrf-token'];
  if (!token || token.toLowerCase() === 'required') {
    throw new Error('The BW/4HANA data API issued no CSRF token.');
  }
  return token;
}

/**
 * Run a write in a logon of its own and end that logon afterwards.
 *
 * Creating a hierarchy leaves an enqueue on it that the data API does not release, and that
 * closing the session context does not release either; only the end of the logon does. Left
 * in place, the hierarchy stays locked for every other session — the maintenance app, the
 * modeling tools, the next call of this server — until the logon times out. A logon of its
 * own keeps the logoff from ending the one the modeling calls of this client run in.
 */
async function inApiSession<T>(fn: (session: BwClient, headers: Record<string, string>) => Promise<T>): Promise<T> {
  const session = createClientFromEnv();
  try {
    const headers = { ...JSON_HEADERS, 'x-csrf-token': await apiToken(session) };
    return await fn(session, headers);
  } finally {
    await session.logoff();
  }
}

async function getJson<T>(client: BwClient, path: string): Promise<{ data: T; etag?: string }> {
  const { body, headers } = await client.rawGet(`${BASE}${path}`, JSON_HEADERS);
  return { data: (body.trim() ? JSON.parse(body) : null) as T, etag: headers['etag'] };
}

/** The messages of an answer, success or not, as one line each. */
function messagesOf(answer: unknown): string[] {
  const a = answer as { messages?: Array<{ message?: string }>; message?: { message?: string }; log?: Array<{ message?: string }> };
  const list = [...(a?.messages ?? []), ...(a?.log ?? []), ...(a?.message ? [a.message] : [])];
  return [...new Set(list.map((m) => m?.message ?? '').filter(Boolean))];
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface HierarchyHeader {
  hieid: string;
  objvers: string;
  hienm: string;
  version: string;
  datefrom: string;
  dateto: string;
  iobjnm: string;
  txtsh?: string;
  txtlg?: string;
  numberlevel?: string;
  maxnodeid?: string;
  owner?: string;
}

export interface HierarchyNodeRow {
  NODEID: string;
  IOBJNM: string;
  NODENAME: string;
  NODEDESCRIPTION?: string;
  TLEVEL: string;
  PARENTID: string;
  CHILDID: string;
  NEXTID: string;
  LINK?: boolean;
  INTERVL?: string;
  DATEFROM?: string;
  DATETO?: string;
}

export async function listHierarchies(client: BwClient, characteristic: string): Promise<HierarchyHeader[]> {
  const { data } = await getJson<HierarchyHeader[]>(
    client,
    `/data/infoobjects/${encodeURIComponent(characteristic.toUpperCase())}/hierarchies`,
  );
  return data ?? [];
}

/** The one hierarchy of the characteristic with that name, preferring the active version. */
async function findHierarchy(
  client: BwClient,
  characteristic: string,
  name: string,
  version?: 'A' | 'M',
): Promise<HierarchyHeader | undefined> {
  const matches = (await listHierarchies(client, characteristic)).filter(
    (h) => h.hienm.toUpperCase() === name.toUpperCase() && (!version || h.objvers === version),
  );
  return matches.find((h) => h.objvers === 'A') ?? matches[0];
}

/**
 * The nodes of a hierarchy by node name, or undefined when the characteristic has no
 * hierarchy of that name. Reads the active version, the one a query evaluates.
 */
export async function hierarchyNodesByName(
  client: BwClient,
  characteristic: string,
  name: string,
): Promise<Map<string, HierarchyNodeRow> | undefined> {
  const header = await findHierarchy(client, characteristic, name);
  if (!header) return undefined;
  const { data: rows } = await getJson<HierarchyNodeRow[]>(
    client,
    `/data/hierarchies/${encodeURIComponent(header.hieid)}/versions/${header.objvers}/content?depth=99`,
  );
  return new Map((rows ?? []).map((r) => [r.NODENAME, r]));
}

/** Children of each node in sibling order, from the parent/child/next links. */
export function buildTree(rows: HierarchyNodeRow[]): { roots: HierarchyNodeRow[]; children: Map<string, HierarchyNodeRow[]> } {
  const byId = new Map(rows.map((r) => [Number(r.NODEID), r]));
  const ordered = (firstId: number) => {
    const out: HierarchyNodeRow[] = [];
    const seen = new Set<number>();
    for (let id = firstId; id && byId.has(id) && !seen.has(id); id = Number(byId.get(id)!.NEXTID)) {
      seen.add(id);
      out.push(byId.get(id)!);
    }
    return out;
  };
  const children = new Map<string, HierarchyNodeRow[]>();
  for (const r of rows) if (Number(r.CHILDID)) children.set(String(Number(r.NODEID)), ordered(Number(r.CHILDID)));
  // Roots are the nodes without a parent; the first root is the one no root points to as next.
  const rootRows = rows.filter((r) => !Number(r.PARENTID));
  const pointedTo = new Set(rootRows.map((r) => Number(r.NEXTID)));
  const first = rootRows.find((r) => !pointedTo.has(Number(r.NODEID)));
  const roots = first ? ordered(Number(first.NODEID)) : rootRows;
  return { roots, children };
}

function renderTree(rows: HierarchyNodeRow[], characteristic: string): string[] {
  const { roots, children } = buildTree(rows);
  const lines: string[] = [];
  const walk = (nodes: HierarchyNodeRow[], depth: number) => {
    for (const n of nodes) {
      const kind = n.IOBJNM === TEXT_NODE ? 'text node' : n.IOBJNM === characteristic ? 'value' : n.IOBJNM;
      const text = n.NODEDESCRIPTION ? `  ${n.NODEDESCRIPTION}` : '';
      const link = n.LINK ? '  (link)' : '';
      lines.push(`${'  '.repeat(depth + 1)}${n.NODENAME}  [${kind}]${text}${link}  id=${Number(n.NODEID)}`);
      walk(children.get(String(Number(n.NODEID))) ?? [], depth + 1);
    }
  };
  walk(roots, 0);
  return lines;
}

export interface GetHierarchyArgs {
  characteristic: string;
  hierarchy_name?: string;
  version?: 'A' | 'M';
  format?: 'text' | 'raw';
}

const titleOf = (h: HierarchyHeader & { txtmd?: string }) => h.txtlg || h.txtmd || h.txtsh || '';
const date = (d: string | undefined) => (!d || /^0{4}-0{2}-0{2}$/.test(d) ? '' : d);

export async function bwGetHierarchy(client: BwClient, args: GetHierarchyArgs): Promise<string> {
  if (!args.characteristic) throw new Error('characteristic is required.');
  const cha = args.characteristic.toUpperCase();

  if (!args.hierarchy_name) {
    const list = await listHierarchies(client, cha);
    if (args.format === 'raw') return JSON.stringify(list, null, 2);
    if (list.length === 0) return `Characteristic ${cha} has no hierarchies.`;
    const lines = [`Hierarchies of ${cha} (${list.length}):`, ''];
    for (const h of list) {
      const validity = date(h.datefrom) || h.dateto !== '9999-12-31' ? `  valid ${date(h.datefrom) || '…'} – ${h.dateto}` : '';
      lines.push(
        `  ${h.hienm.padEnd(30)} ${h.objvers === 'A' ? 'active' : 'revised (M)'}${h.version ? `  version ${h.version}` : ''}` +
          `${validity}  levels ${Number(h.numberlevel ?? 0)}  nodes ${Number(h.maxnodeid ?? 0)}  ${titleOf(h)}`,
      );
    }
    return lines.join('\n');
  }

  const header = await findHierarchy(client, cha, args.hierarchy_name, args.version);
  if (!header) throw new Error(`Characteristic ${cha} has no hierarchy named ${args.hierarchy_name.toUpperCase()}.`);
  const { data: rows } = await getJson<HierarchyNodeRow[]>(
    client,
    `/data/hierarchies/${encodeURIComponent(header.hieid)}/versions/${header.objvers}/content?depth=99`,
  );
  if (args.format === 'raw') return JSON.stringify({ header, nodes: rows }, null, 2);

  const nodes = rows ?? [];
  const lines = [
    `Hierarchy:      ${header.hienm}${titleOf(header) ? ` — ${titleOf(header)}` : ''}`,
    `Characteristic: ${cha}`,
    `Version:        ${header.objvers === 'A' ? 'active' : 'revised (M)'}${header.version ? `, hierarchy version ${header.version}` : ''}`,
    ...(date(header.datefrom) || header.dateto !== '9999-12-31' ? [`Valid:          ${date(header.datefrom) || '…'} – ${header.dateto}`] : []),
    `Nodes:          ${nodes.length}`,
    `Hierarchy id:   ${header.hieid}`,
    '',
    ...renderTree(nodes, cha),
  ];
  lines.push(
    '',
    'A text node is selected in bw_query_data with nodeType "0HIER_NODE", a value node with the characteristic; ' +
      'pass the node name as low (or its key as lowInt) with nodeId 1.',
  );
  return lines.join('\n');
}


// ── Writing ──────────────────────────────────────────────────────────────────

export interface HierarchyNodeInput {
  /** A text node: its name (unique in the hierarchy). */
  text_node?: string;
  /** Text of a text node; defaults to its name. */
  text?: string;
  /** A characteristic value node: the value. */
  value?: string;
  children?: HierarchyNodeInput[];
}

export interface ChangeRecord {
  ACTION: 'I' | 'C' | 'D';
  HIEID: string;
  OBJVERS: 'M';
  NODEID: string;
  NODENAME: string;
  IOBJNM: string;
  NODEDESCRIPTION: string;
  TXTSH: string;
  TXTMD: string;
  TXTLG: string;
  LINK: boolean;
  SIGNCH: string;
  TLEVEL: number;
  PARENTID: number;
  CHILDID: number;
  NEXTID: number;
}

/**
 * The change log the maintenance app writes for a tree: every node inserted without links,
 * then every node with a child or a next sibling changed to its final links. Node ids start at
 * `firstId`, so a replacement tree does not reuse the ids of the nodes it removes.
 */
export function buildChangeLog(
  hieid: string,
  characteristic: string,
  roots: HierarchyNodeInput[],
  firstId = 1,
): ChangeRecord[] {
  interface Flat { id: number; input: HierarchyNodeInput; level: number; parent: number; child: number; next: number }
  const flat: Flat[] = [];
  const names = new Set<string>();
  let nextId = firstId;
  const add = (nodes: HierarchyNodeInput[], level: number, parent: number): number[] => {
    const ids: number[] = [];
    for (const input of nodes) {
      const isText = input.text_node !== undefined;
      if (isText === (input.value !== undefined)) {
        throw new Error('Each node needs exactly one of text_node or value.');
      }
      const name = String(isText ? input.text_node : input.value).trim();
      if (!name) throw new Error('A node name or value may not be empty.');
      const key = `${isText ? TEXT_NODE : characteristic}/${name.toUpperCase()}`;
      if (names.has(key)) throw new Error(`Node ${name} occurs twice; a node may appear only once in a hierarchy.`);
      names.add(key);
      const f: Flat = { id: nextId++, input, level, parent, child: 0, next: 0 };
      flat.push(f);
      ids.push(f.id);
      f.child = add(input.children ?? [], level + 1, f.id)[0] ?? 0;
    }
    ids.forEach((id, i) => { flat.find((f) => f.id === id)!.next = ids[i + 1] ?? 0; });
    return ids;
  };
  add(roots, 1, 0);
  if (flat.length === 0) throw new Error('nodes must contain at least one node.');

  const record = (f: Flat, action: 'I' | 'C'): ChangeRecord => {
    const isText = f.input.text_node !== undefined;
    const name = String(isText ? f.input.text_node : f.input.value).trim();
    const text = isText ? (f.input.text ?? name.toUpperCase()) : '';
    return {
      ACTION: action,
      HIEID: hieid,
      OBJVERS: 'M',
      NODEID: String(f.id),
      NODENAME: isText ? name.toUpperCase() : name,
      IOBJNM: isText ? TEXT_NODE : characteristic,
      NODEDESCRIPTION: text,
      TXTSH: text.slice(0, 20),
      TXTMD: text.slice(0, 40),
      TXTLG: text.slice(0, 60),
      LINK: false,
      SIGNCH: '',
      TLEVEL: f.level,
      PARENTID: f.parent,
      CHILDID: action === 'I' ? 0 : f.child,
      NEXTID: action === 'I' ? 0 : f.next,
    };
  };
  return [
    ...flat.map((f) => record(f, 'I')),
    ...flat.filter((f) => f.child || f.next).map((f) => record(f, 'C')),
  ];
}

/** Delete records for the nodes a hierarchy has now, as the app writes them when a node is cut. */
export function deleteRecords(hieid: string, rows: HierarchyNodeRow[]): ChangeRecord[] {
  return rows.map((r) => ({
    ACTION: 'D' as const,
    HIEID: hieid,
    OBJVERS: 'M' as const,
    NODEID: String(Number(r.NODEID)),
    NODENAME: r.NODENAME,
    IOBJNM: r.IOBJNM,
    NODEDESCRIPTION: r.NODEDESCRIPTION ?? '',
    TXTSH: '',
    TXTMD: '',
    TXTLG: '',
    LINK: r.LINK ?? false,
    SIGNCH: '',
    TLEVEL: Number(r.TLEVEL),
    PARENTID: Number(r.PARENTID),
    CHILDID: Number(r.CHILDID),
    NEXTID: Number(r.NEXTID),
  }));
}

const descriptionTexts = (d: string) => ({ txtsh: d.slice(0, 20), txtmd: d.slice(0, 40), txtlg: d.slice(0, 60) });

function parseAnswer(body: string): { success?: boolean; hieid?: string; objvers?: string } & Record<string, unknown> {
  try { return body.trim() ? JSON.parse(body) : {}; } catch { return { success: false, raw: body.slice(0, 500) }; }
}

async function activate(session: BwClient, headers: Record<string, string>, hieid: string): Promise<{ ok: boolean; messages: string[] }> {
  const { body } = await session.rawPost(`${BASE}/data/hierarchies/${encodeURIComponent(hieid)}/versions/M/activate`, '', headers);
  const answer = parseAnswer(body);
  return { ok: answer.success === true, messages: messagesOf(answer) };
}

export interface CreateHierarchyArgs {
  characteristic: string;
  hierarchy_name: string;
  description: string;
  nodes: HierarchyNodeInput[];
  activate?: boolean;
}

export async function bwCreateHierarchy(client: BwClient, args: CreateHierarchyArgs): Promise<string> {
  if (!args.characteristic) throw new Error('characteristic is required.');
  if (!args.hierarchy_name) throw new Error('hierarchy_name is required.');
  if (!args.description) throw new Error('description is required.');
  if (!Array.isArray(args.nodes) || args.nodes.length === 0) throw new Error('nodes must be a non-empty array.');
  const cha = args.characteristic.toUpperCase();
  const name = args.hierarchy_name.toUpperCase();
  buildChangeLog('PENDING', cha, args.nodes);

  if (await findHierarchy(client, cha, name)) {
    throw new Error(`Characteristic ${cha} already has a hierarchy named ${name}. Change it with bw_update_hierarchy.`);
  }

  return inApiSession(async (session, write) => {
    const created = await session.rawPost(`${BASE}/data/hierarchies`, JSON.stringify({
      oHiesel: { hietype: '1', hienm: name, objvers: 'M', version: '', datefrom: '0000-00-00', dateto: '9999-12-31', iobjnm: cha },
      aHietext: [descriptionTexts(args.description)],
      oHiedir: { owner: '' },
    }), write);
    const head = parseAnswer(created.body);
    if (!head.success || !head.hieid) {
      throw new Error(`The hierarchy was not created: ${messagesOf(head).join(' ') || created.body.slice(0, 500)}`);
    }
    const hieid = head.hieid;
    const base = `${BASE}/data/hierarchies/${encodeURIComponent(hieid)}/versions/M`;
    // A failed node write leaves an empty revised hierarchy behind; it is removed again.
    const discard = () => session.rawDelete(base, write).catch(() => {/* best effort */});

    const log = buildChangeLog(hieid, cha, args.nodes);
    let saved;
    try {
      saved = await session.rawPut(`${base}/content`, JSON.stringify(log), write);
    } catch (err) {
      await discard();
      throw err;
    }
    const savedAnswer = parseAnswer(saved.body);
    if (!savedAnswer.success) {
      await discard();
      throw new Error(`The nodes were not saved: ${messagesOf(savedAnswer).join(' ') || saved.body.slice(0, 500)}`);
    }

    const result: Record<string, unknown> = {
      success: true,
      characteristic: cha,
      hierarchy_name: name,
      hierarchy_id: hieid,
      node_count: log.filter((r) => r.ACTION === 'I').length,
    };
    if (args.activate === false) {
      return JSON.stringify({ ...result, version: 'M', message: `Hierarchy ${name} saved as revised version, not activated.` }, null, 2);
    }
    const activation = await activate(session, write, hieid);
    return JSON.stringify({
      ...result,
      success: activation.ok,
      version: activation.ok ? 'A' : 'M',
      messages: activation.messages,
      message: activation.ok
        ? `Hierarchy ${name} created and active.`
        : `Hierarchy ${name} was saved but not activated; it exists as revised version.`,
    }, null, 2);
  });
}

export interface UpdateHierarchyArgs {
  characteristic: string;
  hierarchy_name: string;
  /** New description. */
  description?: string;
  /** The complete new tree; replaces every node the hierarchy has now. */
  nodes?: HierarchyNodeInput[];
  activate?: boolean;
}

/**
 * Change a hierarchy: its description and/or its whole tree. The tree is replaced, not merged:
 * every current node is removed and the new tree inserted with fresh node ids, in one change
 * log. Read the current tree with bw_get_hierarchy, edit it, and pass it back whole.
 */
export async function bwUpdateHierarchy(client: BwClient, args: UpdateHierarchyArgs): Promise<string> {
  if (!args.characteristic) throw new Error('characteristic is required.');
  if (!args.hierarchy_name) throw new Error('hierarchy_name is required.');
  if (args.description === undefined && args.nodes === undefined) throw new Error('Nothing to do: pass description and/or nodes.');
  if (args.nodes !== undefined && (!Array.isArray(args.nodes) || args.nodes.length === 0)) {
    throw new Error('nodes must be a non-empty array (the complete new tree).');
  }
  const cha = args.characteristic.toUpperCase();
  if (args.nodes) buildChangeLog('PENDING', cha, args.nodes);
  const header = await findHierarchy(client, cha, args.hierarchy_name);
  if (!header) throw new Error(`Characteristic ${cha} has no hierarchy named ${args.hierarchy_name.toUpperCase()}.`);

  return inApiSession(async (session, write) => {
    const hieid = header.hieid;
    const id = encodeURIComponent(hieid);
    const revisedExists = async () =>
      (await listHierarchies(session, cha)).some((h) => h.hieid === hieid && h.objvers === 'M');
    const headerOf = (v: string) => getJson<Record<string, unknown>>(session, `/data/hierarchies/${id}/versions/${v}`);
    const putHeader = async (v: string, description?: string) => {
      const { data, etag } = await headerOf(v);
      const texts = (data?.['aHiedirT'] as Array<Record<string, unknown>> | undefined) ?? [];
      const aHiedirT = description === undefined
        ? texts
        : [{ ...(texts[0] ?? { langu: '', hieid }), objvers: v, ...descriptionTexts(description) }];
      const put = await session.rawPut(`${BASE}/data/hierarchies/${id}/versions/${v}`, JSON.stringify({
        aHiedirT,
        aLevel: data?.['aLevel'] ?? [],
        oHiedir: data?.['oHiedir'] ?? header,
      }), etag ? { ...write, 'If-Match': etag } : write);
      const answer = parseAnswer(put.body);
      if (answer.success === false) throw new Error(`The hierarchy header was not saved: ${messagesOf(answer).join(' ')}`);
    };

    // Changes go to the revised version. An active hierarchy without one gets it the way the
    // maintenance app does: saving the header of the active version copies it to a revised one.
    if (!(await revisedExists())) {
      await putHeader('A');
      if (!(await revisedExists())) throw new Error('No revised version of the hierarchy could be opened for the change.');
    }
    const applied: string[] = [];

    if (args.description !== undefined) {
      await putHeader('M', args.description);
      applied.push('description changed');
    }

    if (args.nodes) {
      const { data: rows } = await getJson<HierarchyNodeRow[]>(session, `/data/hierarchies/${id}/versions/M/content?depth=99`);
      const old = rows ?? [];
      const firstId = old.reduce((m, r) => Math.max(m, Number(r.NODEID)), 0) + 1;
      const log = [...deleteRecords(hieid, old), ...buildChangeLog(hieid, cha, args.nodes, firstId)];
      const { etag } = await headerOf('M');
      const put = await session.rawPut(`${BASE}/data/hierarchies/${id}/versions/M/content`, JSON.stringify(log),
        etag ? { ...write, 'If-Match': etag } : write);
      const answer = parseAnswer(put.body);
      if (!answer.success) throw new Error(`The nodes were not saved: ${messagesOf(answer).join(' ') || put.body.slice(0, 500)}`);
      applied.push(`tree replaced: ${old.length} node(s) removed, ${log.filter((r) => r.ACTION === 'I').length} inserted`);
    }

    const result: Record<string, unknown> = { success: true, characteristic: cha, hierarchy_name: header.hienm, hierarchy_id: hieid, applied };
    if (args.activate === false) return JSON.stringify({ ...result, version: 'M', message: 'Saved as revised version, not activated.' }, null, 2);
    const activation = await activate(session, write, hieid);
    return JSON.stringify({ ...result, success: activation.ok, version: activation.ok ? 'A' : 'M', messages: activation.messages }, null, 2);
  });
}

export interface DeleteHierarchyArgs {
  characteristic: string;
  hierarchy_name: string;
  version?: 'A' | 'M';
}

export async function bwDeleteHierarchy(client: BwClient, args: DeleteHierarchyArgs): Promise<string> {
  if (!args.characteristic) throw new Error('characteristic is required.');
  if (!args.hierarchy_name) throw new Error('hierarchy_name is required.');
  const cha = args.characteristic.toUpperCase();
  const header = await findHierarchy(client, cha, args.hierarchy_name, args.version);
  if (!header) throw new Error(`Characteristic ${cha} has no hierarchy named ${args.hierarchy_name.toUpperCase()}.`);
  return inApiSession(async (session, write) => {
    const { body } = await session.rawDelete(
      `${BASE}/data/hierarchies/${encodeURIComponent(header.hieid)}/versions/${header.objvers}`,
      write,
    );
    const answer = parseAnswer(body);
    if (answer.success === false) throw new Error(`The hierarchy was not deleted: ${messagesOf(answer).join(' ')}`);
    return JSON.stringify({ success: true, characteristic: cha, hierarchy_name: header.hienm, version: header.objvers, messages: messagesOf(answer) }, null, 2);
  });
}
