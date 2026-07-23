import { BwClient, bwSeg } from '../bw-client.js';

const ACCEPT = 'application/vnd.sap.bw4.modeling.processchain-v1_0_0+json';

interface Socket {
  sStatus?: string;
  sSubStatus?: string;
  sDescription?: string;
}

interface Detail {
  sName?: string;
  sDescription?: string;
  sValue?: string;
}

interface Node {
  sProcessType?: string;
  sProcessVariant?: string;
  sTypeDescription?: string;
  sVariantDescription?: string;
  sStatus?: string;
  bSkipped?: boolean;
  bIsReference?: boolean;
  aSocket?: Socket[];
  aDetail?: Detail[];
}

interface Edge {
  iNodeIndexFrom: number;
  iNodeIndexTo: number;
  sStatus?: string;
  sSubStatus?: string;
  sStrength?: string;
}

interface ProgramEntry {
  key?: string;
  row?: { package?: string };
}

interface EventIdEntry {
  key?: string;
}

interface VariantDetail {
  PROGRAM?: ProgramEntry[];
  eventid?: EventIdEntry[];
  eventparm?: string;
  startdttyp?: string;
}

interface InlineVariant {
  sProcessVariant?: string;
  bActive?: boolean;
  sVariantDescription?: string;
  oDetail?: VariantDetail;
}

interface JobOwner {
  sJobOwner?: string;
}

interface SchedulingAttributes {
  sJobPriority?: string;
  oJobOwner?: JobOwner;
  sExecutionServer?: string;
  bStreaming?: boolean;
}

interface MonitoringAttributes {
  bAutoMonitored?: boolean;
  bErrorNotification?: boolean;
  bKeepAlive?: boolean;
  bAutoResetFailures?: boolean;
}

interface Header {
  sProcessChainId?: string;
  sDescription?: string;
  sObjectStatus?: string;
  sObjectVersion?: string;
  sLocation?: string;
  sLocationDescription?: string;
  bActive?: boolean;
  oSchedulingAttributes?: SchedulingAttributes;
  oMonitoringAttributes?: MonitoringAttributes;
}

interface ProcessChain {
  oHeader?: Header;
  aNode?: Node[];
  aEdge?: Edge[];
  aInlineVariant?: InlineVariant[];
}

async function fetchVariantDetail(
  client: BwClient,
  processType: string,
  variantName: string,
): Promise<string | null> {
  const NO_DETAIL_TYPES = new Set(['OR', 'AND', 'EXOR', 'CHAIN', 'DTP_LOAD', 'DTP_ADSO']);
  if (NO_DETAIL_TYPES.has(processType.toUpperCase())) return null;
  try {
    const url = `/sap/bw4/v1/modeling/processtypes/${processType.toLowerCase()}/variants/${bwSeg(variantName)}/m`;
    const result = await client.rawGet(url, { Accept: '*/*' });
    if (result.body.trim().startsWith('<')) return null;
    const parsed = JSON.parse(result.body);
    const detail = parsed.oDetail;
    if (!detail || (typeof detail === 'string' && detail.trim() === '') || (typeof detail === 'object' && Object.keys(detail).length === 0)) return null;
    return JSON.stringify(detail, null, 2);
  } catch {
    return null;
  }
}

export async function bwGetProcessChain(
  client: BwClient,
  chainName: string,
  format: 'text' | 'raw' = 'text',
  includeVariantDetails: boolean = true,
): Promise<string> {
  const url = `/sap/bw/modeling/rspc/${bwSeg(chainName)}/m`;
  const result = await client.rawGet(url, { Accept: ACCEPT });
  const parsed = JSON.parse(result.body) as ProcessChain;

  if (format === 'raw') {
    return JSON.stringify(parsed, null, 2);
  }

  const variantDetailMap: Record<string, string> = {};
  if (format === 'text' && includeVariantDetails) {
    for (const node of parsed.aNode ?? []) {
      const type = node.sProcessType;
      const variant = node.sProcessVariant;
      if (type && variant) {
        const detail = await fetchVariantDetail(client, type, variant);
        if (detail) variantDetailMap[variant] = detail;
      }
    }
  }

  return renderText(parsed, variantDetailMap);
}

function renderText(pc: ProcessChain, variantDetailMap: Record<string, string> = {}): string {
  const lines: string[] = [];
  const header = pc.oHeader ?? {};
  const sched = header.oSchedulingAttributes ?? {};
  const mon = header.oMonitoringAttributes ?? {};
  const nodes = pc.aNode ?? [];
  const edges = pc.aEdge ?? [];
  const variants = pc.aInlineVariant ?? [];

  // Section 1 — header
  lines.push(`Process Chain: ${header.sProcessChainId ?? ''}`);
  lines.push(`Description:   ${header.sDescription ?? ''}`);
  lines.push(`Status:        ${header.sObjectStatus ?? ''} / Version: ${header.sObjectVersion ?? ''}`);
  lines.push(`InfoArea:      ${header.sLocation ?? ''} — ${header.sLocationDescription ?? ''}`);
  lines.push(`Active:        ${header.bActive ?? false}`);

  // Section 2 — Scheduling
  lines.push('');
  lines.push('── Scheduling ──');
  lines.push(`  Job Priority:  ${sched.sJobPriority ?? ''}  (A=high B=normal C=low)`);
  lines.push(`  Job Owner:     ${sched.oJobOwner?.sJobOwner || '(not set)'}`);
  lines.push(`  Server:        ${sched.sExecutionServer || '(not set)'}`);
  lines.push(`  Streaming:     ${sched.bStreaming ?? false}`);

  // Section 3 — Monitoring
  lines.push('');
  lines.push('── Monitoring ──');
  lines.push(`  Auto-Monitored:     ${mon.bAutoMonitored ?? false}`);
  lines.push(`  Error Notification: ${mon.bErrorNotification ?? false}`);
  lines.push(`  Keep-Alive:         ${mon.bKeepAlive ?? false}`);
  lines.push(`  Auto-Reset:         ${mon.bAutoResetFailures ?? false}`);

  // Section 4 — Steps
  lines.push('');
  lines.push(`── Steps (${nodes.length}) ──`);
  nodes.forEach((node, idx) => {
    const variantLabel = node.sVariantDescription || node.sProcessVariant || '';
    lines.push(`  [${idx}] ${node.sTypeDescription ?? ''} — ${variantLabel}`);
    lines.push(`      Type:    ${node.sProcessType ?? ''}`);
    lines.push(`      Variant: ${node.sProcessVariant ?? ''}`);
    lines.push(`      Status:  ${node.sStatus || 'neutral'}`);
    lines.push(`      Skipped: ${node.bSkipped ?? false}`);

    if (node.bIsReference === true) {
      lines.push(`      Sub-Chain: ${node.sProcessVariant ?? ''}  (referenced)`);
    }

    for (const d of node.aDetail ?? []) {
      if (d.sValue && d.sValue.length > 0) {
        lines.push(`      ${d.sName ?? ''}: ${d.sValue}`);
      }
    }

    if (node.sProcessType === 'DECISION') {
      const branches = (node.aSocket ?? []).filter(
        (s) => !(s.sSubStatus === '00' && s.sStatus === 'negative'),
      );
      if (branches.length > 0) {
        lines.push(`      Branches:`);
        for (const b of branches) {
          lines.push(`        [${b.sSubStatus ?? ''}] ${b.sDescription ?? ''}  (status: ${b.sStatus ?? ''})`);
        }
      }
    }

    if (node.sProcessType === 'OR') {
      lines.push(`      (join node — merges multiple incoming branches)`);
    }

    const detailJson = variantDetailMap[node.sProcessVariant ?? ''];
    if (detailJson) {
      lines.push(`      ── Variant Detail ──`);
      for (const line of detailJson.split('\n')) {
        lines.push(`      ${line}`);
      }
    }
  });

  // Section 5 — Dependencies
  lines.push('');
  lines.push(`── Dependencies (${edges.length}) ──`);
  for (const edge of edges) {
    const source = nodes[edge.iNodeIndexFrom];
    const target = nodes[edge.iNodeIndexTo];
    const sourceType = source?.sProcessType ?? '?';
    const targetType = target?.sProcessType ?? '?';

    let condition: string;
    if (edge.sSubStatus && edge.sSubStatus !== '00') {
      const socket = source?.aSocket?.find((s) => s.sSubStatus === edge.sSubStatus);
      condition = socket?.sDescription || edge.sStatus || '';
    } else {
      condition = edge.sStatus || '';
    }

    lines.push(`  Step ${edge.iNodeIndexFrom} (${sourceType}) → Step ${edge.iNodeIndexTo} (${targetType})`);
    lines.push(`      Condition: ${condition}  Strength: ${edge.sStrength ?? ''}`);
  }

  // Section 6 — Variants
  lines.push('');
  lines.push(`── Variants (${variants.length}) ──`);
  for (const v of variants) {
    const keys = Object.keys(v);
    const isStub = keys.length === 1 && keys[0] === 'sProcessVariant';
    if (isStub) {
      lines.push(`  ${v.sProcessVariant ?? ''}  (no detail — auto-generated variant)`);
      continue;
    }

    lines.push(`  ${v.sProcessVariant ?? ''}  (active: ${v.bActive ?? false})`);
    lines.push(`      ${v.sVariantDescription || '(no description)'}`);

    const detail = v.oDetail;
    if (detail) {
      if (detail.PROGRAM && detail.PROGRAM.length >= 1) {
        const p = detail.PROGRAM[0];
        lines.push(`      ABAP Program: ${p.key ?? ''}  Package: ${p.row?.package || '(unknown)'}`);
      }
      if (detail.eventid && detail.eventid.length >= 1) {
        lines.push(`      Trigger Event: ${detail.eventid[0].key ?? ''}  Param: ${detail.eventparm ?? ''}`);
      }
      if (detail.startdttyp !== undefined) {
        lines.push(`      Start Type: ${detail.startdttyp}  (E=event I=immediate P=periodic)`);
      }
    }
  }

  return lines.join('\n');
}
