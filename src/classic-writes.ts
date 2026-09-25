/**
 * What the write tools do on a classic BW release.
 *
 * The platform filter in platform.ts answers a different question: it hides a tool whose
 * REST collection a system does not publish. Everything it leaves visible used to count as
 * "works on 7.5" by omission. For the reads that held, because they were verified object by
 * object. For the writes it was an assumption, so each one was run against a classic system
 * and its result read back, and the outcome is recorded here rather than left to inference:
 *
 *   verified  — ran on a classic system, the result read back
 *   blocked   — the tool reaches the backend and the backend refuses it; the note says what
 *               to do instead
 *   untested  — could not be exercised on the verification system, with the missing
 *               precondition named
 *
 * `untested` is for a missing system precondition only, never for "we did not get to it".
 * `bw_system_profile` prints this table on a classic system, so the tool surface and this
 * file cannot drift apart the way a prose document would.
 */

export type ClassicWriteVerdict = 'verified' | 'blocked' | 'untested';

export interface ClassicWriteStatus {
  verdict: ClassicWriteVerdict;
  /** What was covered, what to do instead, or which precondition is missing. */
  note?: string;
}

/** Verified on SAP_BASIS 750 (`bw.b4hanamode = STANDARD`) on 2026-09-20. */
export const CLASSIC_WRITE_STATUS: Record<string, ClassicWriteStatus> = {
  bw_create_infoarea: { verdict: 'verified' },
  bw_create_infoobject: { verdict: 'verified', note: 'characteristic and key figure, with length, texts and InfoArea as given' },
  bw_update_infoobject: { verdict: 'verified' },
  bw_create_adso: { verdict: 'verified' },
  bw_update_adso: { verdict: 'verified', note: 'add_field, add_pure_field, manage_keys, update_settings, update_field_properties' },
  bw_create_infosource: { verdict: 'verified' },
  bw_update_infosource: { verdict: 'verified' },
  bw_create_composite_provider: { verdict: 'verified' },
  bw_update_composite_provider: { verdict: 'verified', note: 'add_input, update_mapping' },
  bw_create_aggregation_level: { verdict: 'verified', note: 'the provider must be direct-update without a change log — a standard aDSO is not planning-enabled here' },
  bw_update_aggregation_level: { verdict: 'verified' },

  bw_create_query: { verdict: 'verified' },
  bw_update_query_layout: { verdict: 'verified' },
  bw_update_query_filter: { verdict: 'verified' },
  bw_update_query_key_figures: { verdict: 'verified' },
  bw_update_query_characteristic: { verdict: 'verified' },
  bw_update_query_settings: { verdict: 'verified' },
  bw_update_query_cells: { verdict: 'verified', note: 'reference, formula and help cells; decimals and scaling with their priorities' },
  bw_create_variable: { verdict: 'verified' },
  bw_update_variable: { verdict: 'verified' },
  bw_create_rkf: { verdict: 'verified' },
  bw_update_rkf: { verdict: 'verified' },
  bw_create_ckf: { verdict: 'verified' },
  bw_update_ckf: { verdict: 'verified' },
  bw_create_structure: { verdict: 'verified' },
  bw_update_structure: { verdict: 'verified' },
  bw_set_query_roles: { verdict: 'verified' },

  bw_set_datasource_fields: { verdict: 'verified' },
  bw_change_datasource_delta: { verdict: 'verified' },

  bw_activate: { verdict: 'verified', note: 'adso, trcs, hcpr, alvl, iobj' },
  bw_delete: { verdict: 'verified', note: 'area, adso, trcs, hcpr, alvl, iobj and the reusable query components' },
  bw_move_object: { verdict: 'verified' },
  bw_unlock: { verdict: 'verified' },
  bw_create_transport_task: { verdict: 'verified' },

  bw_create_datasource: {
    verdict: 'blocked',
    note: 'the backend refuses the create although the lock it was given succeeded, and it does so for the ' +
      'request Eclipse BWMT sends for the same object. Create the DataSource in BWMT or the SAP GUI — reading ' +
      'it, selecting its fields and changing its delta process all work from here afterwards',
  },
};

/** The verdicts in the order the profile prints them, with their headings. */
export const CLASSIC_WRITE_HEADINGS: Record<ClassicWriteVerdict, string> = {
  verified: 'verified — ran on this platform, the result read back',
  blocked: 'blocked — the backend refuses the write',
  untested: 'still to test — precondition missing on the verification system',
};
