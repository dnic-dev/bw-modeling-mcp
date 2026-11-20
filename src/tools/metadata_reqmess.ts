import type { BwClient } from '../bw-client.js';
import { queryTable, inListBatches, sqlLiteral, type Row } from './metadata_sql.js';

/**
 * The error text of a red InfoPackage request.
 *
 * The monitor message log of a classic load request is in RSMONMESS, one row per message,
 * keyed by the request (RNR). The E and A rows carry the cause, for example RSDS_ACCESS 049
 * with the file, the server, the user and "Permission denied". The text itself is in T100,
 * with the variables MSGV1 to MSGV4 put in. For a file load, RSSELDONE-FILENAME is the path
 * that the request opened, after a logical file name was resolved.
 *
 * A DTP request has no rows in RSMONMESS: its log is with the request in the request monitor.
 *
 * Read-only: SELECTs through DataPreview, like every other metadata read.
 */

/** RSREQDONE-TSTATUS and -QMSTATUS: the red icon. */
export const RED_REQUEST = '@0A@';

const MESSAGES_PER_REQUEST = 20;

export type RequestMessage = Row & { text?: string };

export interface RequestErrorEntry {
  messages: RequestMessage[];
  file: string;
}

export interface RequestErrors {
  byRequest: Map<string, RequestErrorEntry>;
  /** Set when RSMONMESS could not be read, so that an unreadable log does not look empty. */
  error: string | null;
}

/** T100 text with its variables: &1 to &4 by position, a bare & in turn, && as one &. */
export function fillMessage(text: string, vars: Array<string | undefined>): string {
  let next = 0;
  return text.replace(/&&|&([1-4])|&/g, (match: string, n?: string) => {
    if (match === '&&') return '&';
    const value = n ? vars[Number(n) - 1] : vars[next++];
    return (value ?? '').trim();
  });
}

async function messageTexts(client: BwClient, keys: string[]): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const key of keys) {
    const [id, no] = key.split(' ');
    try {
      const rows = await queryTable(
        client,
        `SELECT sprsl, text FROM t100 WHERE arbgb = '${sqlLiteral(id)}' AND msgnr = '${sqlLiteral(no)}'`,
        20,
      );
      const row = rows.find((r) => r.SPRSL === 'E') ?? rows[0];
      if (row?.TEXT) texts.set(key, row.TEXT);
    } catch {
      // The id, number and variables still identify the message.
    }
  }
  return texts;
}

/**
 * The E and A messages and the file name of each request, by RNR.
 * A failed read is returned as `error`, not swallowed: an empty log and an unreadable one
 * must not look the same.
 */
export async function requestErrors(client: BwClient, rnrs: string[]): Promise<RequestErrors> {
  const result: RequestErrors = { byRequest: new Map(), error: null };
  const unique = [...new Set(rnrs.filter(Boolean))];
  if (unique.length === 0) return result;
  for (const rnr of unique) result.byRequest.set(rnr, { messages: [], file: '' });

  const keys = new Set<string>();
  try {
    for (const batch of inListBatches(unique, 120)) {
      const rows = await queryTable(
        client,
        `SELECT rnr, msgty, msgid, msgno, msgv1, msgv2, msgv3, msgv4 FROM rsmonmess ` +
          `WHERE rnr IN (${batch}) AND msgty IN ('E', 'A')`,
        MESSAGES_PER_REQUEST * 10,
      );
      for (const r of rows) {
        const entry = result.byRequest.get(r.RNR);
        if (!entry || entry.messages.length >= MESSAGES_PER_REQUEST) continue;
        entry.messages.push(r);
        keys.add(`${r.MSGID} ${r.MSGNO}`);
      }
    }
  } catch (err) {
    result.error = `RSMONMESS could not be read (${err instanceof Error ? err.message : String(err)})`;
  }

  try {
    for (const batch of inListBatches(unique, 120)) {
      const rows = await queryTable(client, `SELECT rnr, filename FROM rsseldone WHERE rnr IN (${batch})`, 500);
      for (const r of rows) {
        const entry = result.byRequest.get(r.RNR);
        if (entry && !entry.file && r.FILENAME?.trim()) entry.file = r.FILENAME.trim();
      }
    }
  } catch {
    // The file name is an enrichment; the messages carry the cause.
  }

  const texts = await messageTexts(client, [...keys]);
  for (const entry of result.byRequest.values()) {
    for (const m of entry.messages) {
      const text = texts.get(`${m.MSGID} ${m.MSGNO}`);
      m.text = text ? fillMessage(text, [m.MSGV1, m.MSGV2, m.MSGV3, m.MSGV4]) : '';
    }
  }
  return result;
}

/** Lines for one request: the file, then each E and A message with its text. */
export function formatRequestErrors(entry: RequestErrorEntry, indent: string): string[] {
  const out: string[] = [];
  if (entry.file) out.push(`${indent}File:     ${entry.file}`);
  if (entry.messages.length === 0) {
    out.push(`${indent}Errors:   none in RSMONMESS (no E or A message for this request)`);
    return out;
  }
  const capped = entry.messages.length >= MESSAGES_PER_REQUEST ? ` (first ${MESSAGES_PER_REQUEST})` : '';
  out.push(`${indent}Errors:   ${entry.messages.length}${capped}`);
  for (const m of entry.messages) {
    const vars = [m.MSGV1, m.MSGV2, m.MSGV3, m.MSGV4].map((v) => (v ?? '').trim()).filter(Boolean);
    const text = m.text || (vars.length ? vars.join(' | ') : '(no text)');
    out.push(`${indent}  ${m.MSGTY} ${m.MSGID} ${m.MSGNO}: ${text}`);
  }
  return out;
}

/**
 * The red InfoPackage requests of one chain run (RSREQDONE-CHAIN_LOG_ID), with their errors.
 * DTP requests are not in RSREQDONE; their log is in the request monitor.
 */
export async function chainRunLoadErrors(client: BwClient, logId: string): Promise<string[]> {
  let requests: Row[];
  try {
    requests = await queryTable(
      client,
      `SELECT rnr, logdpid, tstatus, qmstatus FROM rsreqdone WHERE chain_log_id = '${sqlLiteral(logId)}'`,
      200,
    );
  } catch (err) {
    return [`  RSREQDONE could not be read (${err instanceof Error ? err.message : String(err)}).`];
  }
  const red = requests.filter((r) => r.TSTATUS === RED_REQUEST || r.QMSTATUS === RED_REQUEST);
  if (red.length === 0) {
    return [
      '  No InfoPackage request of this run ended red. A red DTP step has its log with its',
      '  request (bw_get_request where the system has the request monitor), not in RSMONMESS.',
    ];
  }
  const errors = await requestErrors(client, red.map((r) => r.RNR));
  const out: string[] = [];
  if (errors.error) out.push(`  ${errors.error}`);
  for (const r of red) {
    out.push(`  ${r.RNR}  InfoPackage ${r.LOGDPID}`);
    const entry = errors.byRequest.get(r.RNR);
    if (entry) out.push(...formatRequestErrors(entry, '      '));
  }
  return out;
}
