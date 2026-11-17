/**
 * Title and behaviour hints of the tools, as a client shows and uses them.
 *
 * Without hints a client has to treat every tool as one that may destroy something, and asks
 * for confirmation before each read. The hints come from the classification that decides
 * access (scopes.ts), so what a tool is said to do and who may call it cannot drift apart.
 *
 * A focused tool stands for several operations and is described by the most consequential
 * one a caller is offered: it is read-only when every operation is, and destructive as soon as
 * one of them is.
 */
import { requiredScope } from './scopes.js';
import { DESCRIBE_TOOL, FOCUSED_TOOLS, type ToolDefinition } from './surface/focused.js';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

export interface PresentedTool extends ToolDefinition {
  title: string;
  annotations: ToolAnnotations;
}

/**
 * Hints of one full tool. Every tool works on the one BW system the server is connected to,
 * hence never an open world. A create adds an object and fails when it exists; everything else
 * that writes changes, removes, activates or runs something that is already there.
 */
export function hintsFor(tool: string): ToolAnnotations {
  if (requiredScope(tool) !== 'write') return { readOnlyHint: true, openWorldHint: false };
  return {
    readOnlyHint: false,
    destructiveHint: !tool.startsWith('bw_create_'),
    idempotentHint: false,
    openWorldHint: false,
  };
}

function combine(hints: ToolAnnotations[]): ToolAnnotations {
  if (hints.every((h) => h.readOnlyHint)) return { readOnlyHint: true, openWorldHint: false };
  return {
    readOnlyHint: false,
    destructiveHint: hints.some((h) => h.destructiveHint === true),
    idempotentHint: false,
    openWorldHint: false,
  };
}

const FOCUSED_TITLES: Record<string, string> = {
  bw_read: 'Read a BW object',
  bw_find: 'Find BW objects and relations',
  bw_monitor: 'Monitor loads and process chains',
  bw_query_data: 'Run a query or read a provider',
  bw_data: 'Read and write provider data',
  bw_activate: 'Check and activate objects',
  bw_delete: 'Delete objects',
  bw_run: 'Run loads and processes',
  bw_write_adso: 'Create and change aDSOs',
  bw_write_infoobject: 'Create and change InfoObjects',
  bw_write_infosource: 'Create and change InfoSources',
  bw_write_composite_provider: 'Create and change CompositeProviders',
  bw_write_transformation: 'Create and change transformations',
  bw_write_dtp: 'Create and change DTPs',
  bw_write_datasource: 'Create and change DataSources',
  bw_write_open_hub: 'Create and change Open Hub Destinations',
  bw_write_query: 'Create and change queries',
  bw_write_planning: 'Create and change planning objects',
  bw_write_process_chain: 'Create and change process chains',
  bw_manage: 'Manage transports, locks and settings',
  [DESCRIBE_TOOL]: 'Describe the tools and their operations',
};

const SPELLING: Record<string, string> = {
  adso: 'aDSO',
  afo: 'Analysis for Office',
  ckf: 'CKF',
  rkf: 'RKF',
  dtp: 'DTP',
  dtps: 'DTPs',
  datasource: 'DataSource',
  datasources: 'DataSources',
  infoarea: 'InfoArea',
  infoobject: 'InfoObject',
  infosource: 'InfoSource',
  xref: 'cross references',
};

const PHRASES: [RegExp, string][] = [
  [/composite provider/g, 'CompositeProvider'],
  [/open hub/g, 'Open Hub Destination'],
];

/** A readable title for a full tool, from its name. */
export function titleFor(tool: string): string {
  const fixed = FOCUSED_TITLES[tool];
  if (fixed) return fixed;
  let text = tool
    .replace(/^bw_/, '')
    .split('_')
    .map((word) => SPELLING[word] ?? word)
    .join(' ');
  for (const [pattern, replacement] of PHRASES) text = text.replace(pattern, replacement);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Add title and hints to the listed tools.
 *
 * `offered` are the full tools this caller may use on this system: a focused tool is described
 * by the operations that are left of it, so a reader's tool that kept only its reads says so.
 */
export function presentTools(listed: ToolDefinition[], offered: readonly string[]): PresentedTool[] {
  const available = new Set(offered);
  return listed.map((tool) => {
    const spec = FOCUSED_TOOLS.find((s) => s.name === tool.name);
    let annotations: ToolAnnotations;
    if (tool.name === DESCRIBE_TOOL) {
      annotations = { readOnlyHint: true, openWorldHint: false };
    } else if (spec) {
      const members = spec.members.filter((m) => available.has(m.tool));
      annotations = combine((members.length ? members : spec.members).map((m) => hintsFor(m.tool)));
    } else {
      annotations = hintsFor(tool.name);
    }
    return { ...tool, title: titleFor(tool.name), annotations };
  });
}
