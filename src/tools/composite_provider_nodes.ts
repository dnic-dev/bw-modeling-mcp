import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * View nodes of a CompositeProvider.
 *
 * A CompositeProvider is a tree of view nodes that sit side by side in the document. An input
 * of a node is either a provider (`<entity>`) or another node (`<viewNode>#///NAME</viewNode>`),
 * and the root attribute `defaultNode` names the node whose fields are the fields of the
 * provider. Every node has its own fields; a node input maps the fields of the node below.
 *
 * The actions of the CompositeProvider tools work on one node. Rather than teaching each of
 * them the tree, the document is narrowed to that node when it is read and widened again
 * before it is saved: the other nodes are parked, and the references to nodes inside inputs
 * are renamed so that the node element stays the only `<viewNode>` in the text.
 */

export interface ViewNodeInfo {
  name: string;
  /** The xsi:type, e.g. "View:Union". */
  type: string;
  xml: string;
}

export type NodeKind = 'Join' | 'Union' | 'Projection' | 'Aggregation';

const NODE_TYPE: Record<NodeKind, string> = {
  Join: 'View:JoinNode',
  Union: 'View:Union',
  Projection: 'View:Projection',
  Aggregation: 'View:Aggregation',
};
const NODE_PREFIX: Record<NodeKind, string> = { Join: 'J', Union: 'U', Projection: 'P', Aggregation: 'A' };

const REF = /<viewNode\b([^>]*)>(#\/\/\/[^<]*)<\/viewNode>/g;
const MASKED_REF = /<nodeRef\b([^>]*)>([^<]*)<\/nodeRef>/g;
const NODE = /<viewNode\b(?:[^>/]|\/(?!>))*(?:\/>|>[\s\S]*?<\/viewNode>)/g;
const ELEMENT = /<element\b(?:[^>/]|\/(?!>))*(?:\/>|>[\s\S]*?<\/element>)/g;
const INPUT = /<input\b[^>]*>[\s\S]*?<\/input>/g;

const attrOf = (tag: string, name: string): string => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '';
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const openTag = (xml: string): string => xml.match(/^<[^>]*>/)?.[0] ?? '';

/** Rename the node references inside inputs, so that `<viewNode>` only ever means a node. */
export function maskNodeRefs(xml: string): string {
  return xml.replace(REF, (_all, attrs: string, ref: string) => `<nodeRef${attrs}>${ref}</nodeRef>`);
}

export function unmaskNodeRefs(xml: string): string {
  return xml.replace(MASKED_REF, (_all, attrs: string, ref: string) => `<viewNode${attrs}>${ref}</viewNode>`);
}

/** The nodes of a document whose node references are masked. */
export function viewNodes(maskedXml: string): ViewNodeInfo[] {
  return [...maskedXml.matchAll(NODE)].map((m) => ({
    name: attrOf(openTag(m[0]), 'name'),
    type: attrOf(openTag(m[0]), 'xsi:type'),
    xml: m[0],
  }));
}

export function defaultNodeName(xml: string): string {
  const root = xml.match(/<Composite:compositeView\b[^>]*>/)?.[0] ?? '';
  return attrOf(root, 'defaultNode').replace(/^#\/+/, '') || attrOf(xml.match(/<viewNode\b[^>]*\bname="[^"]*"[^>]*>/)?.[0] ?? '', 'name');
}

/** The node an input stands for, if it is a node input (masked document). */
export function nodeOfInput(inputBlock: string): string | undefined {
  return inputBlock.match(/<nodeRef\b[^>]*>#\/+([^<]*)<\/nodeRef>/)?.[1];
}

export function elementNames(nodeXml: string): string[] {
  return [...nodeXml.matchAll(/<element\b[^>]*\bname="([^"]*)"/g)].map((m) => m[1]);
}

function inputOfNode(parentXml: string, childName: string): string | undefined {
  return [...parentXml.matchAll(INPUT)].map((m) => m[0]).find((block) => nodeOfInput(block) === childName);
}

function parentOf(nodes: ViewNodeInfo[], childName: string): ViewNodeInfo | undefined {
  return nodes.find((n) => inputOfNode(n.xml, childName) !== undefined);
}

/** Tree of the nodes for the read tool: what each one is made of. */
export function describeNodes(xml: string): Array<Record<string, unknown>> {
  const masked = maskNodeRefs(xml);
  const nodes = viewNodes(masked);
  const root = defaultNodeName(xml);
  return nodes.map((n) => ({
    name: n.name,
    type: n.type.split(':').pop()?.replace(/^JoinNode$/, 'Join'),
    ...(n.name === root ? { default_node: true } : { input_of: parentOf(nodes, n.name)?.name }),
    field_count: elementNames(n.xml).length,
    inputs: [...n.xml.matchAll(INPUT)].map((m) => {
      const child = nodeOfInput(m[0]);
      return {
        alias: attrOf(openTag(m[0]), 'alias'),
        ...(child ? { view_node: child } : { provider: attrOf(openTag(m[0]), 'name') }),
      };
    }),
  }));
}

// ── Narrowing the document to one node ───────────────────────────────────────

interface NodeScope {
  wanted?: string;
  node?: string;
  others: ViewNodeInfo[];
  fieldsBefore: string[];
  renamed: Array<[string, string]>;
  notes: string[];
}

const storage = new AsyncLocalStorage<NodeScope>();
const freshScope = (wanted?: string): NodeScope => ({
  wanted: wanted?.trim() || undefined, others: [], fieldsBefore: [], renamed: [], notes: [],
});

/** Start a tool call: the node its action works on, the default node when none is named. */
export function selectNode(node?: string): void {
  storage.enterWith(freshScope(node));
}

function scope(): NodeScope {
  let s = storage.getStore();
  if (!s) {
    s = freshScope();
    storage.enterWith(s);
  }
  return s;
}

/** Narrow a document that was just read to the selected node. */
export function enterScope(xml: string): string {
  const s = scope();
  const masked = maskNodeRefs(xml);
  const nodes = viewNodes(masked);
  const wanted = s.wanted ?? defaultNodeName(xml);
  const target = nodes.find((n) => n.name === wanted) ?? (s.wanted ? undefined : nodes[0]);
  if (!target) {
    if (nodes.length === 0) return masked;
    throw new Error(`View node ${wanted} not found. Nodes: ${nodes.map((n) => n.name).join(', ')}.`);
  }
  s.node = target.name;
  s.others = nodes.filter((n) => n !== target);
  s.fieldsBefore = elementNames(target.xml);
  s.renamed = [];
  let out = masked;
  for (const other of s.others) out = out.replace(other.xml, () => `<!--node:${other.name}-->`);
  return out;
}

/** A field of the selected node was renamed: the node above has to follow. */
export function noteFieldRename(oldName: string, newName: string): void {
  scope().renamed.push([oldName, newName]);
}

/** A parked node, for an action that needs to look at the node below an input. */
export function parkedNode(name: string): ViewNodeInfo | undefined {
  return scope().others.find((n) => n.name === name);
}

export function selectedNodeName(): string | undefined {
  return storage.getStore()?.node;
}

/** What widening the document changed in the node above; empty when nothing. */
export function scopeNotes(): string[] {
  return storage.getStore()?.notes ?? [];
}

/**
 * Carry a change of the fields of a node into the node above: a renamed field keeps its
 * mapping and its place in a join condition, a removed one loses its mapping.
 */
export function followFieldChanges(
  parentXml: string,
  childName: string,
  renamed: Array<[string, string]>,
  removed: string[],
): { xml: string; dropped: Array<{ source: string; target: string }> } {
  const input = inputOfNode(parentXml, childName);
  if (!input) return { xml: parentXml, dropped: [] };
  const alias = attrOf(openTag(input), 'alias');
  const dropped: Array<{ source: string; target: string }> = [];
  let newInput = input;
  for (const [oldName, newName] of renamed) {
    newInput = newInput.replace(new RegExp(`(<mapping\\b[^>]*\\bsourceName=")${escapeRegex(oldName)}"`, 'g'), (_all, lead: string) => `${lead}${newName}"`);
  }
  const gone = removed.filter((name) => !renamed.some(([oldName]) => oldName === name));
  newInput = newInput.replace(/[ \t]*<mapping\b[^>]*\/>\n?/g, (mapping) => {
    const source = attrOf(mapping, 'sourceName');
    if (!source || !gone.includes(source)) return mapping;
    dropped.push({ source, target: attrOf(mapping, 'targetName') });
    return '';
  });
  let out = parentXml.replace(input, () => newInput);
  if (renamed.length) {
    out = out.replace(/<join\b([^>]*)>([\s\S]*?)<\/join>/g, (join, head: string, body: string) => {
      let newBody = body;
      for (const [side, tag] of [['leftInput', 'leftElementName'], ['rightInput', 'rightElementName']]) {
        if (attrOf(head, side).replace(/^.*\//, '') !== alias) continue;
        for (const [oldName, newName] of renamed) {
          newBody = newBody.split(`<${tag}>${oldName}</${tag}>`).join(`<${tag}>${newName}</${tag}>`);
        }
      }
      return newBody === body ? join : `<join${head}>${newBody}</join>`;
    });
  }
  return { xml: out, dropped };
}

/** Widen a narrowed document again, right before it is saved. */
export function leaveScope(xml: string): string {
  const s = storage.getStore();
  if (!s || s.others.length === 0) return unmaskNodeRefs(xml);
  const node = viewNodes(xml).find((n) => n.name === s.node);
  const now = node ? elementNames(node.xml) : s.fieldsBefore;
  const removed = s.fieldsBefore.filter((name) => !now.includes(name));
  const parent = s.node ? parentOf(s.others, s.node) : undefined;
  if (parent && s.node && (removed.length || s.renamed.length)) {
    const followed = followFieldChanges(parent.xml, s.node, s.renamed, removed);
    parent.xml = followed.xml;
    if (followed.dropped.length) {
      s.notes.push(
        `Node ${parent.name} above lost ${followed.dropped.length} mapping(s) of removed fields: ` +
        followed.dropped.map((d) => `${d.source} -> ${d.target}`).join(', ') +
        `. The fields stay in ${parent.name}: map them anew or remove them there.`,
      );
    }
  }
  let out = xml;
  for (const other of s.others) out = out.replace(`<!--node:${other.name}-->`, () => other.xml);
  s.renamed = [];
  return unmaskNodeRefs(out);
}

// ── Changing the tree ────────────────────────────────────────────────────────

function nextNodeName(nodes: ViewNodeInfo[], kind: NodeKind): string {
  let i = 1;
  while (nodes.some((n) => n.name === `${NODE_PREFIX[kind]}${i}`)) i++;
  return `${NODE_PREFIX[kind]}${i}`;
}

/** Copies of fields for another node: references move along, a unit outside the copy is dropped. */
function copyElements(nodeXml: string, names: string[], fromNode: string, toNode: string): string {
  const blocks = new Map([...nodeXml.matchAll(ELEMENT)].map((m) => [attrOf(openTag(m[0]), 'name'), m[0]]));
  return names
    .map((name) => blocks.get(name) ?? '')
    .map((block) =>
      block
        .replace(/<unitCurrencyElement>#\/\/\/[^/<]*\/([^<]*)<\/unitCurrencyElement>/, (all, unit: string) =>
          names.includes(unit) ? all : '')
        .split(`#///${fromNode}/`).join(`#///${toNode}/`))
    .join('');
}

const mappingXml = (target: string, source: string): string =>
  `<mapping xsi:type="Type:ElementMapping" targetName="${target}" sourceName="${source}"/>`;

export interface InsertedNode {
  xml: string;
  node: string;
  /** The node the new one became an input of; absent when it is the new default node. */
  parent?: string;
  fields: string[];
}

/**
 * Put a new node between an input and its node. The input moves into the new node with its
 * mappings; the new node gets the fields that input fed, under the names they have above,
 * and takes the place of the input there — in the mappings and in the join condition.
 */
export function insertNodeAboveInput(xml: string, alias: string, kind: NodeKind): InsertedNode {
  const masked = maskNodeRefs(xml);
  const nodes = viewNodes(masked);
  const inputRe = new RegExp(`<input\\b[^>]*\\balias="${escapeRegex(alias)}"[^>]*>[\\s\\S]*?<\\/input>`);
  const parent = nodes.find((n) => inputRe.test(n.xml));
  const input = parent?.xml.match(inputRe)?.[0];
  if (!parent || !input) throw new Error(`Input ${alias} not found. No changes made.`);
  const name = nextNodeName(nodes, kind);

  const mappings = [...input.matchAll(/<mapping\b[^>]*\/>/g)].map((m) => m[0]);
  const constants = mappings.filter((m) => m.includes('ConstantElementMapping'));
  const fed = mappings.filter((m) => !constants.includes(m))
    .map((m) => ({ target: attrOf(m, 'targetName'), source: attrOf(m, 'sourceName') }));
  const fields = [...new Set(fed.map((m) => m.target))];

  let moved = input;
  for (const constant of constants) moved = moved.replace(constant, () => '');
  const nodeInput =
    `<input xsi:type="Composite:CompositeInput" alias="${name}"><nodeRef xsi:type="${NODE_TYPE[kind]}">#///${name}</nodeRef>` +
    fields.map((f) => mappingXml(f, f)).join('') + constants.join('') + '</input>';

  let newParent = parent.xml.replace(input, () => nodeInput);
  newParent = newParent.replace(/<join\b([^>]*)>([\s\S]*?)<\/join>|<join\b([^>]*)\/>/g, (join, head: string | undefined, body: string | undefined, bare: string | undefined) => {
    let newHead = head ?? bare ?? '';
    let newBody = body ?? '';
    let touched = false;
    for (const [side, tag] of [['leftInput', 'leftElementName'], ['rightInput', 'rightElementName']]) {
      if (attrOf(newHead, side).replace(/^.*\//, '') !== alias) continue;
      touched = true;
      newHead = newHead.replace(new RegExp(`(\\b${side}="[^"]*/)${escapeRegex(alias)}"`), (_all, lead: string) => `${lead}${name}"`);
      newBody = newBody.replace(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'), (_all, key: string) => {
        const target = fed.find((m) => m.source === key)?.target;
        if (!target) throw new Error(`Join key ${key} of input ${alias} is not mapped, so the new node cannot hand it on.`);
        return `<${tag}>${target}</${tag}>`;
      });
    }
    if (!touched) return join;
    return head === undefined ? `<join${newHead}/>` : `<join${newHead}>${newBody}</join>`;
  });

  const newNode =
    `<viewNode xsi:type="${NODE_TYPE[kind]}" name="${name}">` +
    copyElements(parent.xml, fields, parent.name, name) + moved + '</viewNode>';
  return {
    xml: unmaskNodeRefs(masked.replace(parent.xml, () => newParent + newNode)),
    node: name,
    parent: parent.name,
    fields,
  };
}

/**
 * Put a new node on top: it gets every field of the default node, takes that node as its
 * input and becomes the default node itself.
 */
export function insertNodeAboveRoot(xml: string, kind: NodeKind): InsertedNode {
  const masked = maskNodeRefs(xml);
  const nodes = viewNodes(masked);
  const rootName = defaultNodeName(xml);
  const root = nodes.find((n) => n.name === rootName);
  if (!root) throw new Error('The CompositeProvider has no default node.');
  const name = nextNodeName(nodes, kind);
  const fields = elementNames(root.xml);
  const newNode =
    `<viewNode xsi:type="${NODE_TYPE[kind]}" name="${name}">` +
    copyElements(root.xml, fields, root.name, name) +
    `<input xsi:type="Composite:CompositeInput" alias="${root.name}"><nodeRef xsi:type="${root.type}">#///${root.name}</nodeRef>` +
    fields.map((f) => mappingXml(f, f)).join('') + '</input></viewNode>';
  const out = masked
    .replace(root.xml, () => root.xml + newNode)
    .replace(/(<Composite:compositeView\b[^>]*\bdefaultNode=")[^"]*"/, (_all, lead: string) => `${lead}#///${name}"`);
  return { xml: unmaskNodeRefs(out), node: name, fields };
}

/** Add a provider as a further input of a node, without mappings, with an empty join to an input it has. */
export function addJoinPartner(
  xml: string,
  nodeName: string,
  inputXml: string,
  alias: string,
): string {
  const masked = maskNodeRefs(xml);
  const node = viewNodes(masked).find((n) => n.name === nodeName);
  if (!node) throw new Error(`View node ${nodeName} not found.`);
  const left = attrOf(openTag(node.xml.match(INPUT)?.[0] ?? ''), 'alias');
  const join = `<join leftInput="#///${nodeName}/${left}" rightInput="#///${nodeName}/${alias}" joinType="inner"/>`;
  return unmaskNodeRefs(masked.replace(node.xml, () => node.xml.replace(/<\/viewNode>$/, () => `${inputXml}${join}</viewNode>`)));
}

export interface RemovedNode {
  xml: string;
  removed: string[];
  parent?: string;
}

/**
 * Take a node out together with the nodes below it. The input that stood for it goes too;
 * the fields it fed stay in the node above.
 */
export function removeNode(xml: string, nodeName: string): RemovedNode {
  const masked = maskNodeRefs(xml);
  const nodes = viewNodes(masked);
  const node = nodes.find((n) => n.name === nodeName);
  if (!node) throw new Error(`View node ${nodeName} not found. Nodes: ${nodes.map((n) => n.name).join(', ')}.`);
  if (nodeName === defaultNodeName(xml)) {
    throw new Error(`View node ${nodeName} is the default node of the CompositeProvider and cannot be removed.`);
  }
  const removed: ViewNodeInfo[] = [];
  const collect = (n: ViewNodeInfo) => {
    removed.push(n);
    for (const m of n.xml.matchAll(INPUT)) {
      const child = nodes.find((c) => c.name === nodeOfInput(m[0]));
      if (child && !removed.includes(child)) collect(child);
    }
  };
  collect(node);
  const parent = parentOf(nodes, nodeName);
  let out = masked;
  if (parent) {
    const input = inputOfNode(parent.xml, nodeName) ?? '';
    out = out.replace(parent.xml, () => parent.xml.replace(input, () => ''));
  }
  for (const gone of removed) out = out.replace(gone.xml, () => '');
  return { xml: unmaskNodeRefs(out), removed: removed.map((n) => n.name), parent: parent?.name };
}
