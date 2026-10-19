import { BwClient, createClientFromEnv } from '../bw-client.js';

// The manage datastore endpoints answer HTTP 415 to Accept: application/json; they
// serve a vendor type and need the wildcard.
const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: '*/*' };

interface DatastoreField {
  fieldname: string;
  fieldnameInTable: string;
  datatype?: string;
  isKey?: boolean;
  isKeyfigure?: boolean;
  description?: string;
  availForSelectiveDeletion?: boolean;
  conversionExit?: string;
}

interface DatastoreInfo {
  datastore: string;
  description?: string;
  planningMode?: boolean;
  writeChangelog?: boolean;
  fields?: DatastoreField[];
}

interface ManageMessage {
  message?: string;
  severity?: string;
}

interface ManageResponse {
  success?: boolean;
  messages?: ManageMessage[];
  count?: number;
}

function datastoreUrl(adsoName: string): string {
  return `/sap/bc/http/sap/bw4/v1/manage/datastores/${encodeURIComponent(adsoName.toLowerCase())}`;
}

async function readDatastore(client: BwClient, adsoName: string): Promise<DatastoreInfo> {
  const res = await client.rawGet(datastoreUrl(adsoName), JSON_HEADERS);
  return JSON.parse(res.body) as DatastoreInfo;
}

function formatMessages(messages: ManageMessage[] | undefined): string[] {
  return (messages ?? [])
    .filter((m) => m.message)
    .map((m) => `${m.severity ?? 'info'}: ${m.message}`);
}

async function postManage(
  client: BwClient,
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<ManageResponse> {
  const csrfToken = await client.getCsrfToken();
  const res = await client.rawPost(url, JSON.stringify(body), {
    ...JSON_HEADERS,
    'x-csrf-token': csrfToken,
    ...extraHeaders,
  });
  const parsed = (res.body ? JSON.parse(res.body) : {}) as ManageResponse;
  // BW answers HTTP 200 with success:false when it refuses the action.
  if (parsed.success === false) {
    const lines = formatMessages(parsed.messages);
    throw new Error(`BW refused the request.${lines.length ? '\n' + lines.join('\n') : ''}`);
  }
  return parsed;
}

export type PlanningMode = 'planning' | 'loading';

/**
 * Current runtime mode of a planning-enabled aDSO, read in a new session (the shared one may
 * still buffer an earlier state). Undefined where the manage API is missing (classic BW) or
 * does not answer.
 */
export async function readPlanningMode(adsoName: string): Promise<PlanningMode | undefined> {
  try {
    const info = await readDatastore(createClientFromEnv(), adsoName);
    if (info.planningMode === undefined) return undefined;
    return info.planningMode ? 'planning' : 'loading';
  } catch {
    return undefined;
  }
}

/**
 * bw_set_adso_planning_mode — switch a planning-enabled aDSO between interactive planning and
 * loading (the cockpit's "Planung | Staging" toggle).
 *
 * POST .../manage/datastores/{adso}/switchplanningmode with {"mode":"planning"|"loading"}; the
 * current state is the planningMode flag of GET .../manage/datastores/{adso}, read before and
 * after so the result reports the verified state rather than the HTTP status. The read after
 * the switch has to come from a new session (verified on BW/4HANA).
 */
export async function bwSetAdsoPlanningMode(adsoName: string, mode: PlanningMode): Promise<string> {
  if (mode !== 'planning' && mode !== 'loading') {
    throw new Error(`mode must be "planning" or "loading", got "${mode}".`);
  }
  const client = createClientFromEnv();
  const before = await readDatastore(client, adsoName);
  const res = await postManage(client, `${datastoreUrl(adsoName)}/switchplanningmode`, { mode });
  // The session that switched keeps serving the old datastore metadata; only a new session
  // sees the new mode.
  const after = await readDatastore(createClientFromEnv(), adsoName);

  const wanted = mode === 'planning';
  if (after.planningMode !== wanted) {
    throw new Error(
      `BW accepted the switch but ${adsoName.toUpperCase()} still reports planningMode=` +
      `${String(after.planningMode)}. Check that the aDSO is planning-enabled.`,
    );
  }

  return JSON.stringify({
    success: true,
    adso: adsoName.toUpperCase(),
    previous_mode: before.planningMode ? 'planning' : 'loading',
    mode: after.planningMode ? 'planning' : 'loading',
    messages: formatMessages(res.messages),
  });
}

export interface SelectiveDeletionCondition {
  field: string;
  sign?: 'I' | 'E';
  option?: string;
  low: string;
  high?: string;
}

export interface SelectiveDeletionOptions {
  simulate?: boolean;
  propagateDeletion?: boolean;
  forceDeletion?: boolean;
  jobName?: string;
}

const RANGE_OPTIONS = new Set(['EQ', 'NE', 'LT', 'LE', 'GT', 'GE', 'BT', 'CP']);

interface FilterRange {
  sign: string;
  option: string;
  low: string;
  high?: string;
  keyfl?: string;
}

/**
 * bw_delete_adso_data_selective — delete the rows of an aDSO that match a set of conditions, or
 * simulate it. BW picks the tables by aDSO type and reports a count per table; the returned
 * count is their sum.
 *
 * POST .../manage/datastores/{adso}/deletedata, mode "Z" simulates and only counts, mode "D"
 * deletes. Conditions are select-option rows per field; the field metadata the body needs
 * (table field name, key figure flag, CP restriction) comes from the datastore GET, so the caller
 * only names the field. Only key characteristics are accepted when the aDSO has a key, and an
 * empty condition list is rejected because the backend reads it as "no restriction".
 * Values must be in external format: an internal value (e.g. a period without separator) is
 * accepted by BW but silently matches nothing (verified on BW/4HANA).
 */
export async function bwDeleteAdsoDataSelective(
  adsoName: string,
  conditions: SelectiveDeletionCondition[],
  options: SelectiveDeletionOptions = {},
): Promise<string> {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    throw new Error(
      'conditions must contain at least one condition. Deleting all data is not done ' +
      'through this tool.',
    );
  }
  const simulate = options.simulate ?? true;
  const client = createClientFromEnv();
  const info = await readDatastore(client, adsoName);
  const fields = info.fields ?? [];

  // availForSelectiveDeletion is also true for non-key characteristics, but BW refuses them
  // when the aDSO has a key ("filter object does not belong to the key").
  const hasKey = fields.some((f) => f.isKey);
  const isAllowed = (f: DatastoreField) =>
    Boolean(f.availForSelectiveDeletion) && !f.isKeyfigure && (!hasKey || Boolean(f.isKey));
  const allowed = fields.filter(isAllowed).map((f) => f.fieldname);

  const grouped = new Map<string, { field: DatastoreField; ranges: FilterRange[] }>();
  for (const cond of conditions) {
    const wanted = (cond.field ?? '').toUpperCase();
    const field = fields.find(
      (f) => f.fieldname.toUpperCase() === wanted || f.fieldnameInTable.toUpperCase() === wanted,
    );
    if (!field) {
      throw new Error(
        `Field "${cond.field}" does not exist in ${adsoName.toUpperCase()}. ` +
        `Allowed: ${allowed.join(', ')}.`,
      );
    }
    if (!isAllowed(field)) {
      throw new Error(
        `Field "${field.fieldname}" is not available for selective deletion. ` +
        `Allowed: ${allowed.join(', ')}.`,
      );
    }

    const sign = (cond.sign ?? 'I').toUpperCase();
    if (sign !== 'I' && sign !== 'E') {
      throw new Error(`sign must be "I" or "E", got "${cond.sign}".`);
    }
    const option = (cond.option ?? 'EQ').toUpperCase();
    if (!RANGE_OPTIONS.has(option)) {
      throw new Error(`option must be one of ${[...RANGE_OPTIONS].join(', ')}, got "${cond.option}".`);
    }
    const noCp = Boolean(field.conversionExit) || field.datatype === 'DATS' || field.datatype === 'TIMS';
    if (option === 'CP' && noCp) {
      throw new Error(
        `Field "${field.fieldname}" has a conversion exit or is a date/time field; BW does not ` +
        `accept the pattern option CP there. Use EQ or BT.`,
      );
    }
    if (option === 'BT' && (cond.high === undefined || cond.high === '')) {
      throw new Error(`option BT on field "${field.fieldname}" needs high.`);
    }
    if (cond.low === undefined || cond.low === null) {
      throw new Error(`Condition on field "${field.fieldname}" needs low.`);
    }

    const range: FilterRange = { sign, option, low: String(cond.low) };
    if (option === 'BT') range.high = String(cond.high);
    if (range.low || range.high) range.keyfl = 'X';

    const entry = grouped.get(field.fieldname) ?? { field, ranges: [] };
    entry.ranges.push(range);
    grouped.set(field.fieldname, entry);
  }

  const body = {
    operation: 2,
    propagateDeletion: options.propagateDeletion ?? false,
    forceDeletion: options.forceDeletion ?? false,
    fields: [...grouped.values()].map(({ field, ranges }) => ({
      fieldname: field.fieldname,
      fieldnameInTable: field.fieldnameInTable,
      isKeyfigure: false,
      noCpOperator: Boolean(field.conversionExit) || field.datatype === 'DATS' || field.datatype === 'TIMS',
      filterRanges: ranges,
    })),
    jobName: options.jobName ? options.jobName.trim().toUpperCase() : '',
    mode: simulate ? 'Z' : 'D',
  };

  const res = await postManage(client, `${datastoreUrl(adsoName)}/deletedata`, body, {
    'sap-bw4-no-validation': 'true',
  });

  return JSON.stringify({
    success: true,
    adso: adsoName.toUpperCase(),
    mode: simulate ? 'simulation' : 'deletion',
    records: res.count ?? 0,
    conditions: body.fields.map((f) => ({ field: f.fieldname, ranges: f.filterRanges })),
    messages: formatMessages(res.messages),
    note:
      (simulate
        ? 'Simulation only, nothing was deleted. Run again with simulate=false to delete these records. '
        : 'The records were deleted. ') +
      'BW picks the tables by aDSO type; records is the sum over the tables named in the messages.',
  });
}
