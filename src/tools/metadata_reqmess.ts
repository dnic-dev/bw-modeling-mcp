import type { BwClient } from '../bw-client.js';
import { queryTable, inListBatches, sqlLiteral, SAP_LANGUAGE, type Row } from './metadata_sql.js';

/**
 * Why an InfoPackage request ended red.
 *
 * The monitor log of an InfoPackage request is a table, not an application log: RSMONMESS holds
 * one row per message, keyed by the request, and the E and A rows name the cause. The text
 * comes from T100 with the four message variables put in. For a file load, RSSELDONE carries
 * the file the request opened, after a logical file name or a routine was resolved.
 *
 * A DTP request keeps its log elsewhere and has no rows in RSMONMESS; RSREQDONE can list it
 * all the same, so requests are told apart by the object that loaded them.
 *
 * Read-only: SELECTs through DataPreview, like every other metadata read.
 */

/** RSREQDONE-TSTATUS and -QMSTATUS: the red traffic light. */
const RED = '@0A@';
const MESSAGES_PER_REQUEST = 15;

export interface RequestErrorMessage {
  type: string;
  id: string;
  number: string;
  variables: string[];
  text: string;
}

export interface RequestErrors {
  messages: RequestErrorMessage[];
  /** More E and A rows exist than were kept. */
  truncated: boolean;
  file: string;
}

export interface RequestErrorRead {
  byRequest: Map<string, RequestErrors>;
  /** Set when RSMONMESS could not be read: an unreadable log must not look like an empty one. */
  unreadable?: string;
}

export function isRedRequest(row: Row): boolean {
  return row.TSTATUS === RED || row.QMSTATUS === RED;
}

/** A DTP request, as opposed to an InfoPackage request. */
export function isDtpRequest(row: Row): boolean {
  return (row.RNR ?? '').startsWith('DTPR_') || (row.LOGDPID ?? '').startsWith('DTP_');
}

/**
 * A T100 text with its variables: `&1` to `&4` by position, a bare `&` in order of appearance,
 * `&&` as a literal ampersand.
 */
export function fillMessageText(text: string, variables: string[]): string {
  let next = 0;
  return text
    .replace(/&&|&([1-4])|&/g, (match: string, position?: string) => {
      if (match === '&&') return '&';
      return (position ? variables[Number(position) - 1] : variables[next++])?.trim() ?? '';
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function messageTexts(client: BwClient, keys: Set<string>): Promise<Map<string, string>> {
  const preferred = [SAP_LANGUAGE[(client.language ?? '').toUpperCase()], 'E', 'D'].filter(Boolean);
  const texts = new Map<string, string>();
  for (const key of keys) {
    const [id, number] = key.split(' ');
    try {
      const rows = await queryTable(
        client,
        `SELECT sprsl, text FROM t100 WHERE arbgb = '${sqlLiteral(id)}' AND msgnr = '${sqlLiteral(number)}'`,
        60,
      );
      const row = preferred.map((l) => rows.find((r) => r.SPRSL === l && r.TEXT)).find(Boolean) ?? rows.find((r) => r.TEXT);
      if (row) texts.set(key, row.TEXT);
    } catch {
      // Without the text, id, number and variables still identify the message.
    }
  }
  return texts;
}

/** The E and A messages and the file of each request, by request number. */
export async function readRequestErrors(client: BwClient, requests: string[]): Promise<RequestErrorRead> {
  const read: RequestErrorRead = { byRequest: new Map() };
  const unique = [...new Set(requests.filter(Boolean))];
  for (const rnr of unique) read.byRequest.set(rnr, { messages: [], truncated: false, file: '' });
  if (unique.length === 0) return read;

  const keys = new Set<string>();
  try {
    for (const batch of inListBatches(unique, 110)) {
      const rows = await queryTable(
        client,
        `SELECT rnr, msgty, msgid, msgno, msgv1, msgv2, msgv3, msgv4 FROM rsmonmess ` +
          `WHERE rnr IN (${batch}) AND msgty IN ('E', 'A')`,
        400,
      );
      for (const r of rows) {
        const entry = read.byRequest.get(r.RNR);
        if (!entry) continue;
        const variables = [r.MSGV1, r.MSGV2, r.MSGV3, r.MSGV4].map((v) => (v ?? '').trim());
        // The monitor repeats a message per data package; once is enough to name the cause.
        if (entry.messages.some((m) => m.id === r.MSGID && m.number === r.MSGNO && m.variables.join('\u0000') === variables.join('\u0000'))) continue;
        if (entry.messages.length >= MESSAGES_PER_REQUEST) {
          entry.truncated = true;
          continue;
        }
        entry.messages.push({ type: r.MSGTY, id: r.MSGID, number: r.MSGNO, variables, text: '' });
        keys.add(`${r.MSGID} ${r.MSGNO}`);
      }
    }
  } catch (err) {
    read.unreadable = `RSMONMESS could not be read (${err instanceof Error ? err.message.split('\n')[0] : String(err)}).`;
  }

  try {
    for (const batch of inListBatches(unique, 180)) {
      const rows = await queryTable(client, `SELECT rnr, filename FROM rsseldone WHERE rnr IN (${batch})`, 500);
      for (const r of rows) {
        const entry = read.byRequest.get(r.RNR);
        if (entry && !entry.file && r.FILENAME?.trim()) entry.file = r.FILENAME.trim();
      }
    }
  } catch {
    // The file is an enrichment; the messages carry the cause.
  }

  const texts = await messageTexts(client, keys);
  for (const entry of read.byRequest.values()) {
    for (const m of entry.messages) {
      const text = texts.get(`${m.id} ${m.number}`);
      m.text = text ? fillMessageText(text, m.variables) : '';
    }
  }
  return read;
}

/** Lines for one red request: the file, then each E and A message with its text. */
export function formatRequestErrors(entry: RequestErrors, indent: string): string[] {
  const out: string[] = [];
  if (entry.file) out.push(`${indent}File:     ${entry.file}`);
  if (entry.messages.length === 0) {
    out.push(`${indent}Errors:   no E or A message in the monitor log of this request`);
    return out;
  }
  out.push(`${indent}Errors:`);
  for (const m of entry.messages) {
    const variables = m.variables.filter(Boolean);
    const text = m.text || (variables.length ? variables.join(' | ') : '(no text)');
    out.push(`${indent}  ${m.type} ${m.id} ${m.number}: ${text}`);
  }
  if (entry.truncated) out.push(`${indent}  (first ${MESSAGES_PER_REQUEST} distinct messages — the request has more)`);
  return out;
}

/** The red load requests of one chain run with the errors of the InfoPackage requests among them. */
export async function chainRunLoadErrors(client: BwClient, logId: string): Promise<string[]> {
  let requests: Row[];
  try {
    requests = await queryTable(
      client,
      `SELECT rnr, logdpid, tstatus, qmstatus FROM rsreqdone WHERE chain_log_id = '${sqlLiteral(logId)}'`,
      300,
    );
  } catch (err) {
    return [`  RSREQDONE could not be read (${err instanceof Error ? err.message.split('\n')[0] : String(err)}).`];
  }
  const red = requests.filter(isRedRequest);
  const infoPackages = red.filter((r) => !isDtpRequest(r));
  const dtps = red.filter(isDtpRequest);

  const out: string[] = [];
  if (infoPackages.length > 0) {
    const errors = await readRequestErrors(client, infoPackages.map((r) => r.RNR));
    if (errors.unreadable) out.push(`  ${errors.unreadable}`);
    for (const r of infoPackages) {
      out.push(`  ${r.RNR}  InfoPackage ${r.LOGDPID}`);
      const entry = errors.byRequest.get(r.RNR);
      if (entry) out.push(...formatRequestErrors(entry, '      '));
    }
  } else {
    out.push('  No InfoPackage request of this run ended red.');
  }
  for (const r of dtps) out.push(`  ${r.RNR}  DTP ${r.LOGDPID}`);
  out.push('  The log of a red DTP request is kept with the request in the DTP monitor and is not');
  out.push('  readable through table access; the same holds for steps that load nothing.');
  return out;
}
