/**
 * Scope enforcement for the HTTP transport.
 *
 * Two scopes, matching the two role collections:
 *   read  — the tools that only read (including `bw_query_data` and
 *           `bw_preview_datasource`, which return rows but change nothing).
 *   write — the tools that create, update, delete, activate, push, run, or unlock.
 *           `write` implies `read`.
 * The exact counts live in tests/tool-surface.test.mjs, where they are enforced rather
 * than left to rot in a comment.
 *
 * The READ set is the explicit one, and anything unrecognised requires `write`. That
 * direction matters: a tool added later without touching this file is unavailable to
 * read-only callers rather than silently offered to them. The opposite arrangement —
 * listing the writes — would default a new mutating tool to `read`.
 *
 * Classification comes from the HTTP verb each implementation actually uses, not from
 * the tool name: `bw_query_data` and `bw_preview_datasource` issue POSTs but only read,
 * while `bw_unlock` looks harmless and mutates server-side lock state.
 *
 * This gates who may call the server. What a caller can actually see or change in BW is
 * decided by BW, against the ABAP user behind the request — under principal propagation
 * that is the caller themselves. Scopes restrict; they never widen.
 *
 * stdio has no authInfo and therefore no scopes: whoever runs the process already holds
 * the credentials.
 */
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

export type Scope = 'read' | 'write';

const READ_TOOLS = new Set([
  'bw_get_adso',
  'bw_get_aggregation_level',
  'bw_get_ckf',
  'bw_get_composite_provider',
  'bw_get_dataflow',
  'bw_get_datasource',
  'bw_get_dtp',
  'bw_get_dtps',
  'bw_get_filter_values',
  'bw_get_infoarea',
  'bw_get_infoobject',
  'bw_get_infosource',
  'bw_get_open_hub',
  'bw_get_planning_function',
  'bw_get_planning_properties',
  'bw_get_planning_sequence',
  'bw_get_process_chain',
  'bw_get_process_chain_run_detail',
  'bw_get_process_variant',
  'bw_get_push_schema',
  'bw_get_query',
  'bw_get_query_roles',
  'bw_get_remodeling_request',
  'bw_get_request',
  'bw_get_rkf',
  'bw_get_role_queries',
  'bw_get_roles',
  'bw_get_source_system',
  'bw_get_structure',
  'bw_get_transformation',
  'bw_list_changeable_transports',
  'bw_list_contents',
  'bw_list_datasources',
  'bw_list_process_chain_last_status',
  'bw_list_process_chain_runs',
  'bw_list_remodeling_requests',
  'bw_list_remote_entities',
  'bw_list_requests',
  'bw_list_source_systems',
  'bw_preview_datasource',
  'bw_query_data',
  'bw_read_metadata_tables',
  'bw_search',
  'bw_system_profile',
  'bw_xref',
]);

export function requiredScope(toolName: string): Scope {
  return READ_TOOLS.has(toolName) ? 'read' : 'write';
}

/** Accepts bare or XSUAA-qualified scopes (`bwmcp!t123.read`). */
function has(scopes: readonly string[], scope: Scope): boolean {
  return scopes.some((s) => s === scope || s.endsWith(`.${scope}`));
}

export function hasScope(authInfo: AuthInfo | undefined, scope: Scope): boolean {
  if (!authInfo) return true; // stdio
  const scopes = authInfo.scopes ?? [];
  if (has(scopes, scope)) return true;
  return scope === 'read' && has(scopes, 'write'); // write implies read
}

/** Hide tools the caller cannot invoke, so a model never proposes a call that will be denied. */
export function filterToolsByScope<T extends { name: string }>(
  tools: T[],
  authInfo: AuthInfo | undefined,
): T[] {
  if (!authInfo) return tools;
  return tools.filter((t) => hasScope(authInfo, requiredScope(t.name)));
}
