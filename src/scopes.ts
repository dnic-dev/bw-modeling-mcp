/**
 * Scope enforcement for the HTTP transport.
 *
 * Three scopes, matching three role collections:
 *   read    — everything that only reads, the modelling surface and the data alike.
 *   analyst — reporting: run a query (or query a provider directly) and everything needed to
 *             find and understand what to run. Deliberately small, and a strict subset of
 *             `read` — it exists to give a business user a client with fourteen tools instead
 *             of a hundred, not to take anything away from a reader.
 *   write   — create, update, delete, activate, push, run, unlock. Implies both others.
 * The exact counts live in tests/tool-surface.test.mjs, where they are enforced rather
 * than left to rot in a comment.
 *
 * Every analyst tool is also a read tool, so a reader lost nothing when the role was added.
 * The two are still separate sets rather than one with a flag: what belongs in a reporting
 * client is a different question from what only reads, and a tool therefore carries the *set*
 * of scopes that admit it rather than one required scope.
 *
 * The sets are the explicit part, and anything unrecognised requires `write`. That direction
 * matters: a tool added later without touching this file is unavailable to read-only callers
 * rather than silently offered to them. The opposite arrangement — listing the writes —
 * would default a new mutating tool to `read`.
 *
 * Classification comes from what the implementation actually does, not from the tool name:
 * `bw_query_data` and `bw_preview_datasource` issue POSTs but only read, while `bw_unlock`
 * looks harmless and mutates server-side lock state.
 *
 * This gates who may call the server. What a caller can actually see or change in BW is
 * decided by BW, against the ABAP user behind the request — under principal propagation
 * that is the caller themselves. Scopes restrict; they never widen.
 *
 * stdio has no authInfo and therefore no scopes: whoever runs the process already holds
 * the credentials.
 */
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

export type Scope = 'read' | 'analyst' | 'write';

export const SCOPES: readonly Scope[] = ['read', 'analyst', 'write'];

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
  'bw_get_variable',
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

/**
 * What a business user needs to ask a question of the data, and nothing else.
 *
 * Three groups: run the query, find what can be run, understand what the numbers mean. The
 * modelling surface is deliberately absent — an analyst has no use for transformations, DTPs,
 * process chains or routine source, and a client carrying all 105 tools picks the wrong one
 * far more often than one carrying fourteen. The size of this set is a feature.
 *
 * `bw_preview_datasource` is *not* here although it returns rows: it previews source-system
 * data while modelling an extraction, which is an ETL task, not reporting. It stays available
 * under `read`, as does everything else left out here — this set narrows a client, not a
 * permission.
 * `bw_list_contents` is not here either — it walks the repository tree by object type folder
 * (`adso`, `trfn`, `dtpa`), which is the modeller's way in; an analyst starts from the roles
 * assigned to them or from a search.
 */
const ANALYST_TOOLS = new Set([
  // Ask the question
  'bw_query_data',
  'bw_get_filter_values',
  // Find what there is to ask
  'bw_search',
  'bw_get_roles',
  'bw_get_role_queries',
  // Understand what is being asked
  'bw_get_query',
  'bw_get_ckf',
  'bw_get_rkf',
  'bw_get_structure',
  'bw_get_infoobject',
  'bw_get_composite_provider',
  'bw_get_adso',
  'bw_get_aggregation_level',
  // "Is today's data loaded yet?" — a reporting question, not a monitoring one
  'bw_list_requests',
]);

/**
 * Every scope that admits this tool.
 *
 * `write` is in every list: a caller who may change things may read them. A reporting tool
 * appears with `read` and `analyst` both, since the analyst set is a subset — the caller
 * needs only one of them.
 */
export function scopesFor(toolName: string): Scope[] {
  const scopes: Scope[] = [];
  if (READ_TOOLS.has(toolName)) scopes.push('read');
  if (ANALYST_TOOLS.has(toolName)) scopes.push('analyst');
  scopes.push('write');
  return scopes;
}

/**
 * The narrowest scope that admits this tool, for the message a rejected caller gets.
 * `scopesFor` is what decides access; this only names it.
 */
export function requiredScope(toolName: string): Scope {
  return scopesFor(toolName)[0];
}

/** Accepts bare or XSUAA-qualified scopes (`bwmcp!t123.read`). */
function has(scopes: readonly string[], scope: Scope): boolean {
  return scopes.some((s) => s === scope || s.endsWith(`.${scope}`));
}

export function hasScope(authInfo: AuthInfo | undefined, scope: Scope): boolean {
  if (!authInfo) return true; // stdio
  const scopes = authInfo.scopes ?? [];
  if (has(scopes, scope)) return true;
  return scope !== 'write' && has(scopes, 'write'); // write implies read and analyst
}

/** May this caller invoke this tool? True when any scope admitting it is held. */
export function mayCall(toolName: string, authInfo: AuthInfo | undefined): boolean {
  if (!authInfo) return true; // stdio
  return scopesFor(toolName).some((s) => hasScope(authInfo, s));
}

/** Hide tools the caller cannot invoke, so a model never proposes a call that will be denied. */
export function filterToolsByScope<T extends { name: string }>(
  tools: T[],
  authInfo: AuthInfo | undefined,
): T[] {
  if (!authInfo) return tools;
  return tools.filter((t) => mayCall(t.name, authInfo));
}
