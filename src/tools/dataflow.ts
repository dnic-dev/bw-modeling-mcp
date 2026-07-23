import { BwClient, bwNsName } from '../bw-client.js';

const DMOD_ACCEPT = 'application/vnd.sap.bw.modeling.dmod-v1_0_0+xml';
const BASE = '/sap/bw/modeling/dmod/8TRANSIENT';

interface DataflowNode {
  id: number;
  objectName: string;
  objectType: string;
  objectSubType: string;
  objectDescription: string;
  objectStatus: string;
  persistent: boolean;
  exists: boolean;
  sourceNodeIds: number[];
  targetNodeIds: number[];
}

function parseNodes(xml: string): DataflowNode[] {
  const nodes: DataflowNode[] = [];
  const nodeRe = /<node\b([\s\S]*?)>([\s\S]*?)<\/node>/g;
  let m: RegExpExecArray | null;

  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    const body = m[2];

    const id = parseInt(attrs.match(/\bnodeID="([^"]*)"/)?.[1] ?? '0', 10);
    const objectName = attrs.match(/\bobjectName="([^"]*)"/)?.[1] ?? '';
    const objectType = attrs.match(/\bobjectType="([^"]*)"/)?.[1] ?? '';
    const objectSubType = attrs.match(/\bobjectSubType="([^"]*)"/)?.[1] ?? '';
    const objectDescription = attrs.match(/\bobjectDescription="([^"]*)"/)?.[1] ?? '';
    const objectStatus = attrs.match(/\bobjectStatus="([^"]*)"/)?.[1] ?? '';
    const persistent = attrs.match(/\bpersistent="([^"]*)"/)?.[1] === 'true';
    const exists = attrs.match(/\bexists="([^"]*)"/)?.[1] === 'true';

    const sourceNodeIds: number[] = [];
    const sourceRe = /<sourceNode>#\/\/\/(\d+)<\/sourceNode>/g;
    let sm: RegExpExecArray | null;
    while ((sm = sourceRe.exec(body)) !== null) {
      sourceNodeIds.push(parseInt(sm[1], 10));
    }

    const targetNodeIds: number[] = [];
    const targetRe = /<targetNode>#\/\/\/(\d+)<\/targetNode>/g;
    let tm: RegExpExecArray | null;
    while ((tm = targetRe.exec(body)) !== null) {
      targetNodeIds.push(parseInt(tm[1], 10));
    }

    nodes.push({ id, objectName, objectType, objectSubType, objectDescription, objectStatus, persistent, exists, sourceNodeIds, targetNodeIds });
  }

  return nodes;
}

function buildDisplayName(objectName: string, objectType: string): string {
  if (objectType === 'RSDS') {
    return objectName.trimEnd().replace(/\s+(\S+)$/, ' / $1');
  }
  return objectName.trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function renderFlatTable(nodes: DataflowNode[], header: string): string {
  const lines: string[] = [
    header,
    '',
    `${'TYPE'.padEnd(6)} ${'NAME'.padEnd(34)} ${'DESCRIPTION'.padEnd(38)} STATUS`,
    `${'------'} ${'----------------------------------'.padEnd(34)} ${'--------------------------------------'.padEnd(38)} -------`,
  ];

  const typeOrder = ['LSYS', 'RSDS', 'TRCS', 'TRFN', 'DTPA', 'IOBJ', 'ADSO', 'HCPR', 'ELEM'];
  const sorted = [...nodes].sort((a, b) => {
    const ai = typeOrder.indexOf(a.objectType);
    const bi = typeOrder.indexOf(b.objectType);
    const diff = (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    if (diff !== 0) return diff;
    return a.objectName.localeCompare(b.objectName);
  });

  for (const n of sorted) {
    const name = truncate(buildDisplayName(n.objectName, n.objectType), 34);
    const desc = truncate(n.objectDescription, 38);
    const status = n.objectStatus || '-';
    lines.push(`${n.objectType.padEnd(6)} ${name.padEnd(34)} ${desc.padEnd(38)} ${status}`);
  }

  return lines.join('\n');
}

function renderTree(nodes: DataflowNode[], header: string, direction: 'upwards' | 'downwards' | 'both'): string {
  if (nodes.length === 0) return `${header}\n\n(no nodes)`;

  const byId = new Map<number, DataflowNode>(nodes.map((n) => [n.id, n]));

  const reverseDir = direction === 'downwards';
  const roots = reverseDir
    ? nodes.filter((n) => n.targetNodeIds.length === 0)
    : nodes.filter((n) => n.sourceNodeIds.length === 0);

  const lines: string[] = [header, ''];

  function nodeLabel(n: DataflowNode): string {
    const name = buildDisplayName(n.objectName, n.objectType);
    const subType = n.objectSubType ? `:${n.objectSubType}` : '';
    const desc = n.objectDescription ? ` — ${n.objectDescription}` : '';
    const status = n.objectStatus && n.objectStatus !== 'active' ? ` (${n.objectStatus})` : n.objectStatus === 'active' ? ' (active)' : '';
    return `[${n.objectType}${subType}] ${name}${desc}${status}`;
  }

  const visited = new Set<number>();

  function renderNode(n: DataflowNode, displayPrefix: string, childContinuation: string): void {
    if (visited.has(n.id)) {
      lines.push(`${displayPrefix}${nodeLabel(n)}  ↑ already shown`);
      return;
    }
    lines.push(`${displayPrefix}${nodeLabel(n)}`);
    visited.add(n.id);

    const nextIds = reverseDir ? n.sourceNodeIds : n.targetNodeIds;
    const children = nextIds.map((id) => byId.get(id)).filter((x): x is DataflowNode => x !== undefined);
    for (let i = 0; i < children.length; i++) {
      const isLast = i === children.length - 1;
      const branch = isLast ? '└─ ' : '├─ ';
      const nextContinuation = childContinuation + (isLast ? '     ' : '│    ');
      renderNode(children[i], childContinuation + branch, nextContinuation);
    }
  }

  for (let i = 0; i < roots.length; i++) {
    renderNode(roots[i], '', '');
    if (i < roots.length - 1) lines.push('');
  }

  return lines.join('\n');
}

export async function bwGetDataflow(
  client: BwClient,
  objectName: string,
  objectType: string,
  sourceSystem: string | undefined,
  direction: 'upwards' | 'downwards' | 'both',
  levels: number,
  format: 'text' | 'raw',
): Promise<string> {
  const typeUpper = objectType.toUpperCase();

  if (typeUpper === 'RSDS') {
    if (!sourceSystem) {
      throw new Error('bw_get_dataflow with object_type RSDS requires source_system parameter.');
    }
  }

  // Build objectname param
  let encodedName: string;
  if (typeUpper === 'RSDS') {
    const padded = objectName.toUpperCase().padEnd(30) + sourceSystem!.toUpperCase();
    encodedName = padded.replace(/ /g, '+');
  } else {
    encodedName = encodeURIComponent(bwNsName(objectName.toUpperCase()));
  }

  // Build query string
  const params: string[] = [
    `objecttype=${typeUpper}`,
    `objectname=${encodedName}`,
  ];

  if (direction === 'upwards' || direction === 'both') {
    params.push(`levelupwards=${levels}`);
  }
  if (direction === 'downwards' || direction === 'both') {
    params.push(`leveldownwards=${levels}`);
  }

  const url = `${BASE}?${params.join('&')}`;
  const { body } = await client.get(url, DMOD_ACCEPT);

  if (format === 'raw') return body;

  const nodes = parseNodes(body);

  const dirLabel = direction === 'both' ? 'upwards + downwards' : direction;
  const displayObjectName = typeUpper === 'RSDS'
    ? `${typeUpper} ${objectName.toUpperCase()} / ${sourceSystem!.toUpperCase()}`
    : `${typeUpper} ${objectName.toUpperCase()}`;
  const header = `Dataflow: ${displayObjectName} (${dirLabel}, ${nodes.length} nodes)`;

  if (nodes.length > 30) {
    return renderFlatTable(nodes, header);
  }
  return renderTree(nodes, header, direction);
}
