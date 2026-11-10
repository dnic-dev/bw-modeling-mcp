/**
 * The focused tool surface: a reduced set of tools in front of the full one.
 *
 * The server offers about twenty tools instead of the full set unless `BW_TOOL_MODE=full` asks
 * for every operation as a tool of its own. Each focused tool
 * stands for a group of the full tools and selects one of them through a discriminator
 * (`type` for reads, `operation` for everything else; no full tool has a parameter of either name). The call
 * is then handed to the full tool's handler unchanged, so a focused tool never has behaviour of
 * its own: the operation table below is a mapping, and the full tool definitions remain the
 * single source of every parameter, enum and description.
 *
 * Two things are derived from the table rather than written down twice: the schema of a
 * focused tool is the union of its members' parameters (reads share one `name`), and whatever
 * the scope or platform filter removes from the full list disappears from the discriminator.
 *
 * The large nested item schemas are the bulk of the full surface. A focused tool keeps a
 * parameter's type and first sentence and leaves the item detail to `bw_describe`, which
 * answers with the full tool's schema for one action.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

export type ToolMode = 'full' | 'focused';

export function toolMode(): ToolMode {
  return /^full$/i.test(process.env.BW_TOOL_MODE ?? '') ? 'full' : 'focused';
}

/** The focused call that stands for a full tool, for texts that name the full tool. */
export function focusedCallFor(fullTool: string): string | undefined {
  for (const spec of FOCUSED_TOOLS) {
    const member = spec.members.find((m) => m.tool === fullTool);
    if (member) return `${spec.name} with ${spec.discriminator}="${member.value}"`;
  }
  return undefined;
}

/** Rewrite the full tool names in a text to the focused calls, for the server instructions. */
export function translateToolNames(text: string): string {
  return text.replace(/\bbw_[a-z_]+\b/g, (name) => focusedCallFor(name) ?? name);
}

interface Member {
  /** The discriminator value that selects this operation. */
  value: string;
  /** The full tool the operation is handed to. */
  tool: string;
  /** For reads: the full tool's parameter that `name` stands for. */
  nameParam?: string;
}

interface FocusedToolSpec {
  name: string;
  discriminator: 'type' | 'operation';
  purpose: string;
  members: Member[];
}

const read = (value: string, tool: string, nameParam: string): Member => ({ value, tool, nameParam });
const op = (value: string, tool: string): Member => ({ value, tool });

export const FOCUSED_TOOLS: FocusedToolSpec[] = [
  {
    name: 'bw_read',
    discriminator: 'type',
    purpose: 'Read the definition of one BW object. type selects the object type, name is its technical name.',
    members: [
      read('adso', 'bw_get_adso', 'adso_name'),
      read('iobj', 'bw_get_infoobject', 'infoobject_name'),
      read('area', 'bw_get_infoarea', 'name'),
      read('trcs', 'bw_get_infosource', 'name'),
      read('trfn', 'bw_get_transformation', 'transformation_name'),
      read('dtpa', 'bw_get_dtp', 'dtp_name'),
      read('query', 'bw_get_query', 'query_name'),
      read('hcpr', 'bw_get_composite_provider', 'composite_provider_name'),
      read('ckf', 'bw_get_ckf', 'component_name'),
      read('rkf', 'bw_get_rkf', 'component_name'),
      read('structure', 'bw_get_structure', 'component_name'),
      read('variable', 'bw_get_variable', 'variable_name'),
      read('rsds', 'bw_get_datasource', 'datasource_name'),
      read('lsys', 'bw_get_source_system', 'source_system'),
      read('dest', 'bw_get_open_hub', 'open_hub_name'),
      read('rspc', 'bw_get_process_chain', 'chain_name'),
      read('process_variant', 'bw_get_process_variant', 'variant_name'),
      read('alvl', 'bw_get_aggregation_level', 'aggregation_level_name'),
      read('plse', 'bw_get_planning_function', 'planning_function_name'),
      read('plsq', 'bw_get_planning_sequence', 'planning_sequence_name'),
      read('planning_filter', 'bw_get_planning_filter', 'filter_name'),
      read('planning_properties', 'bw_get_planning_properties', 'plan_provider_name'),
      read('conversion_type', 'bw_get_conversion_type', 'name'),
      read('hierarchy', 'bw_get_hierarchy', 'characteristic'),
      read('push_schema', 'bw_get_push_schema', 'adso_name'),
      read('afo_workbook', 'bw_get_afo_workbook', 'name'),
      read('query_roles', 'bw_get_query_roles', 'query_name'),
    ],
  },
  {
    name: 'bw_find',
    discriminator: 'operation',
    purpose: 'Find BW objects and their relations: search by name, cross references, folder contents, data flows, source systems and DataSources, roles and their queries, metadata tables, system profile.',
    members: [
      op('search', 'bw_search'),
      op('xref', 'bw_xref'),
      op('contents', 'bw_list_contents'),
      op('dataflow', 'bw_get_dataflow'),
      op('dtps', 'bw_get_dtps'),
      op('source_systems', 'bw_list_source_systems'),
      op('datasources', 'bw_list_datasources'),
      op('remote_entities', 'bw_list_remote_entities'),
      op('afo_workbooks', 'bw_list_afo_workbooks'),
      op('roles', 'bw_get_roles'),
      op('role_queries', 'bw_get_role_queries'),
      op('metadata_tables', 'bw_read_metadata_tables'),
      op('system_profile', 'bw_system_profile'),
    ],
  },
  {
    name: 'bw_monitor',
    discriminator: 'operation',
    purpose: 'Monitor loads and runs: requests, process chain runs and their steps, remodeling requests, query statistics.',
    members: [
      op('requests', 'bw_list_requests'),
      op('request', 'bw_get_request'),
      op('chain_runs', 'bw_list_process_chain_runs'),
      op('chain_run_detail', 'bw_get_process_chain_run_detail'),
      op('chain_last_status', 'bw_list_process_chain_last_status'),
      op('remodeling_requests', 'bw_list_remodeling_requests'),
      op('remodeling_request', 'bw_get_remodeling_request'),
      op('query_statistics', 'bw_query_statistics'),
    ],
  },
  {
    name: 'bw_query_data',
    discriminator: 'operation',
    purpose: 'Run a query or read a provider and return its data.',
    members: [op('run', 'bw_query_data')],
  },
  {
    name: 'bw_data',
    discriminator: 'operation',
    purpose: 'Work with data rather than definitions: filter values, DataSource preview, push into a write-interface aDSO, selective deletion, save an Analysis for Office workbook.',
    members: [
      op('filter_values', 'bw_get_filter_values'),
      op('preview_datasource', 'bw_preview_datasource'),
      op('push', 'bw_push_data'),
      op('delete_selective', 'bw_delete_adso_data_selective'),
      op('save_afo_workbook', 'bw_save_afo_workbook'),
    ],
  },
  {
    name: 'bw_activate',
    discriminator: 'operation',
    purpose: 'Activate an object with the lock handle a write returned, release a lock, or activate a process chain.',
    members: [
      op('activate', 'bw_activate'),
      op('unlock', 'bw_unlock'),
      op('activate_process_chain', 'bw_activate_process_chain'),
    ],
  },
  {
    name: 'bw_delete',
    discriminator: 'operation',
    purpose: 'Delete a BW object permanently.',
    members: [op('delete', 'bw_delete')],
  },
  {
    name: 'bw_run',
    discriminator: 'operation',
    purpose: 'Execute: run a DTP, start a process chain or repeat a failed step, activate or delete a request, run a remodeling request.',
    members: [
      op('dtp', 'bw_run_dtp'),
      op('process_chain', 'bw_start_process_chain'),
      op('restart_chain_step', 'bw_restart_process_chain_step'),
      op('activate_request', 'bw_activate_request'),
      op('delete_request', 'bw_delete_request'),
      op('remodeling', 'bw_run_remodeling'),
    ],
  },
  {
    name: 'bw_write_adso',
    discriminator: 'operation',
    purpose: 'Create or change an aDSO: structure, keys, settings, planning mode.',
    members: [
      op('create', 'bw_create_adso'),
      op('update', 'bw_update_adso'),
      op('set_planning_mode', 'bw_set_adso_planning_mode'),
    ],
  },
  {
    name: 'bw_write_infoobject',
    discriminator: 'operation',
    purpose: 'Create or change an InfoObject and its hierarchies.',
    members: [
      op('create', 'bw_create_infoobject'),
      op('update', 'bw_update_infoobject'),
      op('create_hierarchy', 'bw_create_hierarchy'),
      op('update_hierarchy', 'bw_update_hierarchy'),
      op('delete_hierarchy', 'bw_delete_hierarchy'),
    ],
  },
  {
    name: 'bw_write_infosource',
    discriminator: 'operation',
    purpose: 'Create or change an InfoSource.',
    members: [op('create', 'bw_create_infosource'), op('update', 'bw_update_infosource')],
  },
  {
    name: 'bw_write_composite_provider',
    discriminator: 'operation',
    purpose: 'Create or change a CompositeProvider.',
    members: [op('create', 'bw_create_composite_provider'), op('update', 'bw_update_composite_provider')],
  },
  {
    name: 'bw_write_transformation',
    discriminator: 'operation',
    purpose: 'Create a transformation, change the rule of a field, and set or remove its routines and runtime.',
    members: [
      op('create', 'bw_create_transformation'),
      op('update_rule', 'bw_update_transformation'),
      op('set_routine', 'bw_set_transformation_routine'),
      op('set_expert_routine', 'bw_set_transformation_expert_routine'),
      op('set_routine_fields', 'bw_set_transformation_routine_fields'),
      op('delete_routine', 'bw_delete_transformation_routine'),
      op('set_runtime', 'bw_set_transformation_runtime'),
    ],
  },
  {
    name: 'bw_write_dtp',
    discriminator: 'operation',
    purpose: 'Create or change a DTP, including its filters and a filter routine.',
    members: [
      op('create', 'bw_create_dtp'),
      op('update', 'bw_update_dtp'),
      op('set_filter_routine', 'bw_set_dtp_filter_routine'),
    ],
  },
  {
    name: 'bw_write_datasource',
    discriminator: 'operation',
    purpose: 'Create a DataSource, set its fields, change its delta process.',
    members: [
      op('create', 'bw_create_datasource'),
      op('set_fields', 'bw_set_datasource_fields'),
      op('change_delta', 'bw_change_datasource_delta'),
    ],
  },
  {
    name: 'bw_write_open_hub',
    discriminator: 'operation',
    purpose: 'Create or change an Open Hub Destination.',
    members: [op('create', 'bw_create_open_hub'), op('update', 'bw_update_open_hub')],
  },
  {
    name: 'bw_write_query',
    discriminator: 'operation',
    purpose: 'Create or change a query and its reusable components: layout, filter, key figures, characteristics, cells, exceptions, settings, restricted and calculated key figures, structures, variables, role assignments.',
    members: [
      op('create', 'bw_create_query'),
      op('update_layout', 'bw_update_query_layout'),
      op('update_filter', 'bw_update_query_filter'),
      op('update_key_figures', 'bw_update_query_key_figures'),
      op('update_characteristic', 'bw_update_query_characteristic'),
      op('update_cells', 'bw_update_query_cells'),
      op('update_exceptions', 'bw_update_query_exceptions'),
      op('update_settings', 'bw_update_query_settings'),
      op('create_rkf', 'bw_create_rkf'),
      op('update_rkf', 'bw_update_rkf'),
      op('create_ckf', 'bw_create_ckf'),
      op('update_ckf', 'bw_update_ckf'),
      op('create_structure', 'bw_create_structure'),
      op('update_structure', 'bw_update_structure'),
      op('create_variable', 'bw_create_variable'),
      op('update_variable', 'bw_update_variable'),
      op('set_roles', 'bw_set_query_roles'),
    ],
  },
  {
    name: 'bw_write_planning',
    discriminator: 'operation',
    purpose: 'Create or change planning objects: aggregation levels, planning functions, sequences, filters, conversion types.',
    members: [
      op('create_aggregation_level', 'bw_create_aggregation_level'),
      op('update_aggregation_level', 'bw_update_aggregation_level'),
      op('create_function', 'bw_create_planning_function'),
      op('update_function', 'bw_update_planning_function'),
      op('create_sequence', 'bw_create_planning_sequence'),
      op('update_sequence', 'bw_update_planning_sequence'),
      op('create_filter', 'bw_create_planning_filter'),
      op('update_filter', 'bw_update_planning_filter'),
      op('create_conversion_type', 'bw_create_conversion_type'),
    ],
  },
  {
    name: 'bw_write_process_chain',
    discriminator: 'operation',
    purpose: 'Create or change a process chain: steps, edges, DTP and program steps, error links, decision variants.',
    members: [
      op('create', 'bw_create_process_chain'),
      op('update', 'bw_update_process_chain'),
      op('append_dtp', 'bw_append_process_chain_dtp'),
      op('swap_dtp', 'bw_swap_process_chain_dtp'),
      op('add_program', 'bw_add_process_chain_program'),
      op('add_plswitch', 'bw_add_process_chain_plswitch'),
      op('add_edge', 'bw_add_process_chain_edge'),
      op('remove_edge', 'bw_remove_process_chain_edge'),
      op('remove_step', 'bw_remove_process_chain_step'),
      op('add_error_links', 'bw_add_process_chain_error_links'),
      op('create_decision_variant', 'bw_create_decision_variant'),
    ],
  },
  {
    name: 'bw_manage',
    discriminator: 'operation',
    purpose: 'Repository management: InfoAreas, moving objects, package and transport assignment, transport tasks.',
    members: [
      op('create_infoarea', 'bw_create_infoarea'),
      op('move_object', 'bw_move_object'),
      op('change_package', 'bw_change_package'),
      op('create_transport_task', 'bw_create_transport_task'),
      op('changeable_transports', 'bw_list_changeable_transports'),
    ],
  },
];

export const DESCRIBE_TOOL = 'bw_describe';

/** Parameters whose schema is longer than this keep only their type and first sentence. */
const DETAIL_LIMIT = 400;

/** Parameter descriptions longer than this are cut to their first sentences; bw_describe has the rest. */
const DESCRIPTION_LIMIT = 180;

/** The full tool a (focused tool, discriminator value) pair stands for. */
export function memberOf(tool: string, value: string): Member | undefined {
  return FOCUSED_TOOLS.find((t) => t.name === tool)?.members.find((m) => m.value === value);
}

/** Every full tool name the table covers — the parity check against the full surface. */
export function coveredTools(): string[] {
  return FOCUSED_TOOLS.flatMap((t) => t.members.map((m) => m.tool));
}

function firstSentence(text: string, max = 160): string {
  const cut = text.replace(/\s+/g, ' ').trim();
  const end = cut.search(/[.!?](\s|$)/);
  const sentence = end > 0 ? cut.slice(0, end + 1) : cut;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** Whole sentences from the start of a text, as many as fit the limit. */
function leadingSentences(text: string, max: number): string {
  const cut = text.replace(/\s+/g, ' ').trim();
  if (cut.length <= max) return cut;
  let out = '';
  for (const m of cut.matchAll(/[^.!?]+[.!?](?=\s|$)/g)) {
    if (out.length + m[0].length > max) break;
    out += m[0];
  }
  return out.trim() || `${cut.slice(0, max - 1).trimEnd()}…`;
}

function withShortDescription(schema: Record<string, unknown>): Record<string, unknown> {
  if (typeof schema.description !== 'string' || schema.description.length <= DESCRIPTION_LIMIT) return schema;
  return { ...schema, description: leadingSentences(schema.description, DESCRIPTION_LIMIT) };
}

/**
 * A parameter schema with its detail folded away: type, enum and first sentence stay, the
 * nested item or property definitions go, and the description says where they are.
 */
function foldDetail(schema: Record<string, unknown>, tool: string, discriminator: string, value: string): Record<string, unknown> {
  if (JSON.stringify(schema).length <= DETAIL_LIMIT) return schema;
  const out: Record<string, unknown> = {};
  if (schema.type !== undefined) out.type = schema.type;
  if (schema.enum !== undefined) out.enum = schema.enum;
  if (schema.type === 'array') out.items = { type: (schema.items as { type?: string } | undefined)?.type ?? 'object' };
  const intro = typeof schema.description === 'string' ? `${firstSentence(schema.description)} ` : '';
  out.description = `${intro}Full definition: bw_describe(tool: "${tool}", ${discriminator}: "${value}").`;
  return out;
}

/**
 * Build the focused tool definitions out of the full ones that are on offer. A member whose
 * full tool is not in the list (scope or platform) is left out, and a focused tool without
 * members is not offered at all.
 */
export function buildFocusedTools(offered: ToolDefinition[]): ToolDefinition[] {
  const byName = new Map(offered.map((t) => [t.name, t]));
  const tools: ToolDefinition[] = [];

  for (const spec of FOCUSED_TOOLS) {
    const members = spec.members.filter((m) => byName.has(m.tool));
    if (members.length === 0) continue;
    const isRead = spec.discriminator === 'type';

    const properties: Record<string, unknown> = {};
    const owners = new Map<string, string[]>();
    const shapes = new Map<string, string>();
    const differing = new Set<string>();
    const valueLines: string[] = [];

    for (const m of members) {
      const def = byName.get(m.tool) as ToolDefinition;
      const required = new Set(def.inputSchema.required ?? []);
      const params = Object.entries(def.inputSchema.properties ?? {});
      const needed = params.filter(([p]) => required.has(p) && p !== m.nameParam).map(([p]) => p);
      valueLines.push(`${m.value}: ${firstSentence(def.description)}${needed.length ? ` Requires ${needed.join(', ')}.` : ''}`);

      for (const [param, schema] of params) {
        if (param === m.nameParam) continue;
        const list = owners.get(param) ?? [];
        list.push(m.value);
        owners.set(param, list);
        const shape = JSON.stringify(schema);
        if (!(param in properties)) {
          properties[param] = withShortDescription(foldDetail(schema as Record<string, unknown>, spec.name, spec.discriminator, m.value));
          shapes.set(param, shape);
        } else if (shapes.get(param) !== shape) {
          differing.add(param);
        }
      }
    }
    // A parameter that several operations define differently keeps only its type; the
    // definition of each is one bw_describe call away.
    for (const param of differing) {
      const first = properties[param] as Record<string, unknown>;
      const out: Record<string, unknown> = { description: `Defined per operation — bw_describe(tool: "${spec.name}", ${spec.discriminator}: "…") gives each definition.` };
      if (first.type !== undefined) out.type = first.type;
      if (first.type === 'array') out.items = { type: ((first.items as { type?: string } | undefined)?.type ?? 'object') };
      properties[param] = out;
    }

    const discriminatorSchema = {
      type: 'string',
      enum: members.map((m) => m.value),
      description: `${isRead ? 'Object type' : 'Operation'} — one of: ${valueLines.join(' | ')}`,
    };
    const ordered: Record<string, unknown> = { [spec.discriminator]: discriminatorSchema };
    if (isRead) ordered.name = { type: 'string', description: 'Technical name of the object (for a DataSource together with source_system).' };
    // A parameter used by only some of the operations says which, so the model does not pass it elsewhere.
    for (const [param, schema] of Object.entries(properties)) {
      const used = owners.get(param) ?? [];
      const def = { ...(schema as Record<string, unknown>) };
      // A parameter one operation alone uses carries its first sentence; the operation's full
      // definition is one bw_describe call away and the enum values stay in place.
      if (used.length === 1 && members.length > 2 && typeof def.description === 'string') {
        def.description = firstSentence(def.description, 110);
      }
      if (used.length < members.length && members.length > 1) {
        const where = used.length <= 3 ? used.join(', ') : `${used.length} of ${members.length} operations`;
        def.description = `${typeof def.description === 'string' ? def.description + ' ' : ''}[${where}]`;
      }
      ordered[param] = def;
    }

    tools.push({
      name: spec.name,
      description:
        `${spec.purpose} The ${spec.discriminator} enum lists every operation with what it requires; ` +
        `bw_describe(tool: "${spec.name}", ${spec.discriminator}: "…") gives the complete parameter definition of one.`,
      inputSchema: {
        type: 'object',
        properties: ordered,
        required: isRead ? [spec.discriminator, 'name'] : [spec.discriminator],
      },
    });
  }

  tools.push({
    name: DESCRIBE_TOOL,
    description:
      'Describe the focused tools: without arguments the catalogue of every tool and its operations; ' +
      'with tool and the operation value (type for bw_read, operation otherwise) the complete parameter definition of that operation.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'A focused tool name, e.g. "bw_write_query".' },
        type: { type: 'string', description: 'For bw_read: the object type.' },
        operation: { type: 'string', description: 'For every other tool: the operation.' },
      },
    },
  });

  return tools;
}

export type FocusedCall =
  | { kind: 'dispatch'; tool: string; arguments: Record<string, unknown> }
  | { kind: 'describe'; text: string }
  | { kind: 'error'; text: string };

/**
 * Resolve a call to a focused tool into the full tool and its arguments. The discriminator is
 * checked against the members on offer and `name` becomes the full tool's own name parameter;
 * a missing required parameter is named before anything reaches BW.
 */
export function resolveFocusedCall(
  name: string,
  args: Record<string, unknown> | undefined,
  offered: ToolDefinition[],
): FocusedCall | undefined {
  const byName = new Map(offered.map((t) => [t.name, t]));
  if (name === DESCRIBE_TOOL) return { kind: 'describe', text: describe(args ?? {}, offered) };

  const spec = FOCUSED_TOOLS.find((t) => t.name === name);
  if (!spec) return undefined;
  const members = spec.members.filter((m) => byName.has(m.tool));
  const value = args?.[spec.discriminator];
  const member = typeof value === 'string' ? members.find((m) => m.value === value) : undefined;
  if (!member) {
    return {
      kind: 'error',
      text:
        `${name}: ${spec.discriminator} ${value === undefined ? 'is required' : `"${String(value)}" is not one`}. ` +
        `Allowed values: ${members.map((m) => m.value).join(', ')}. bw_describe(tool: "${name}") lists them with their parameters.`,
    };
  }

  const def = byName.get(member.tool) as ToolDefinition;
  const forwarded: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (k === spec.discriminator) continue;
    if (k === 'name' && member.nameParam) forwarded[member.nameParam] = v;
    else forwarded[k] = v;
  }
  const missing = (def.inputSchema.required ?? []).filter((p) => forwarded[p] === undefined);
  if (missing.length > 0) {
    return {
      kind: 'error',
      text:
        `${name} ${spec.discriminator} "${member.value}" needs ${missing.map((p) => (p === member.nameParam ? 'name' : p)).join(', ')}. ` +
        `bw_describe(tool: "${name}", ${spec.discriminator}: "${member.value}") gives the full definition.`,
    };
  }
  return { kind: 'dispatch', tool: member.tool, arguments: forwarded };
}

function describe(args: Record<string, unknown>, offered: ToolDefinition[]): string {
  const byName = new Map(offered.map((t) => [t.name, t]));
  const toolName = typeof args.tool === 'string' ? args.tool : undefined;
  const spec = toolName ? FOCUSED_TOOLS.find((t) => t.name === toolName) : undefined;

  if (!spec) {
    const lines: string[] = [toolName ? `Unknown tool "${toolName}". The focused tools are:` : 'Focused tools and their operations:', ''];
    for (const t of FOCUSED_TOOLS) {
      const members = t.members.filter((m) => byName.has(m.tool));
      if (members.length === 0) continue;
      lines.push(`${t.name} (${t.discriminator}) — ${t.purpose}`);
      for (const m of members) lines.push(`  ${m.value}: ${firstSentence((byName.get(m.tool) as ToolDefinition).description)}`);
      lines.push('');
    }
    lines.push(`${DESCRIBE_TOOL}(tool, type|operation) returns the complete parameter definition of one operation.`);
    return lines.join('\n');
  }

  const value = args[spec.discriminator];
  const members = spec.members.filter((m) => byName.has(m.tool));
  const member = typeof value === 'string' ? members.find((m) => m.value === value) : undefined;
  if (!member) {
    return [
      `${spec.name} — ${spec.purpose}`,
      `${spec.discriminator} values:`,
      ...members.map((m) => `  ${m.value}: ${firstSentence((byName.get(m.tool) as ToolDefinition).description)}`),
      `${DESCRIBE_TOOL}(tool: "${spec.name}", ${spec.discriminator}: "<value>") gives the parameters of one.`,
    ].join('\n');
  }

  const def = byName.get(member.tool) as ToolDefinition;
  const schema = { ...def.inputSchema, properties: { ...(def.inputSchema.properties ?? {}) } } as ToolDefinition['inputSchema'];
  if (member.nameParam && schema.properties && member.nameParam in schema.properties) {
    const props = schema.properties as Record<string, unknown>;
    const renamed: Record<string, unknown> = { name: props[member.nameParam] };
    for (const [k, v] of Object.entries(props)) if (k !== member.nameParam) renamed[k] = v;
    schema.properties = renamed;
    schema.required = (schema.required ?? []).map((p) => (p === member.nameParam ? 'name' : p));
  }
  return [
    `${spec.name} ${spec.discriminator}="${member.value}"`,
    '',
    def.description,
    '',
    'Parameters (JSON Schema):',
    JSON.stringify(schema, null, 2),
  ].join('\n');
}
