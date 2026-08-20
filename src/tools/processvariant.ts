import { BwClient, bwSeg } from '../bw-client.js';

interface Socket {
  sStatus?: string;
  sSubStatus?: string;
  sDescription?: string;
}

interface ExecutionOption {
  name?: string;
  description?: string;
}

interface ProcessVariant {
  bActive?: boolean;
  sVariantDescription?: string;
  oDetail?: unknown;
  aSocket?: Socket[];
  aExecutionOption?: ExecutionOption[];
}

export async function bwGetProcessVariant(
  client: BwClient,
  processType: string,
  variantName: string,
  format: 'text' | 'raw' = 'text',
): Promise<string> {
  const url = `/sap/bw4/v1/modeling/processtypes/${encodeURIComponent(processType.toLowerCase())}/variants/${bwSeg(variantName)}/m`;
  const result = await client.rawGet(url, { Accept: 'application/json' });
  const parsed = JSON.parse(result.body) as ProcessVariant;

  if (format === 'raw') {
    return JSON.stringify(parsed, null, 2);
  }

  return renderText(parsed, processType, variantName);
}

function renderText(pv: ProcessVariant, processType: string, variantName: string): string {
  const lines: string[] = [];

  lines.push(`Process Variant: ${variantName.toUpperCase()}`);
  lines.push(`Type:            ${processType.toUpperCase()}`);
  lines.push(`Description:     ${pv.sVariantDescription || '(none)'}`);
  lines.push(`Active:          ${pv.bActive ?? false}`);

  lines.push('');
  lines.push('── Detail ──');
  const detail = pv.oDetail;
  const detailEmpty =
    detail === undefined ||
    detail === null ||
    (typeof detail === 'string' && detail.length === 0);
  if (detailEmpty) {
    lines.push('  (no detail available)');
  } else {
    const indented = JSON.stringify(detail, null, 2)
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n');
    lines.push(indented);
  }

  const sockets = pv.aSocket ?? [];
  if (sockets.length > 0) {
    lines.push('');
    lines.push('── Sockets ──');
    for (const s of sockets) {
      lines.push(`  [${s.sSubStatus ?? ''}] ${s.sStatus ?? ''} — ${s.sDescription ?? ''}`);
    }
  }

  const options = (pv.aExecutionOption ?? []).filter((o) => o.name && o.name.length > 0);
  if (options.length > 0) {
    lines.push('');
    lines.push('── Execution Options ──');
    for (const o of options) {
      lines.push(`  [${o.name}] ${o.description ?? ''}`);
    }
  }

  return lines.join('\n');
}
