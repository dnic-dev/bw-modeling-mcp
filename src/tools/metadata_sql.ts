import { BwClient } from '../bw-client.js';

/**
 * ADT DataPreview access and the formatting primitives the metadata-table readers share.
 *
 * Separate from the readers so that a reader module can use them without importing the
 * dispatcher that dispatches to it.
 *
 * Every statement built on top of this is fixed in code. Nothing is assembled from caller
 * input beyond the object name, which is escaped before use.
 */

// ── DataPreview access ──────────────────────────────────────────────────────

export type Row = Record<string, string>;

/** Single quotes are the only character that could break out of the literal. */
export function sqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/**
 * The response is column-oriented: one <columns> block per column, each carrying the
 * column name and a <dataSet> holding one <data> element per row. Rows are rebuilt by
 * index; an empty cell arrives as a self-closing element.
 */
export function parseDataPreview(xml: string): Row[] {
  const columns: { name: string; values: string[] }[] = [];
  const blockRe = /<dataPreview:columns>([\s\S]*?)<\/dataPreview:columns>/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(xml)) !== null) {
    const name = block[1].match(/dataPreview:name="([^"]+)"/)?.[1];
    if (!name) continue;
    const values: string[] = [];
    const cellRe = /<dataPreview:data\s*\/>|<dataPreview:data>([\s\S]*?)<\/dataPreview:data>/g;
    let cell: RegExpExecArray | null;
    while ((cell = cellRe.exec(block[1])) !== null) {
      values.push(cell[1] === undefined ? '' : decodeEntities(cell[1]));
    }
    columns.push({ name, values });
  }
  const rowCount = columns.length ? Math.max(...columns.map((c) => c.values.length)) : 0;
  const rows: Row[] = [];
  for (let i = 0; i < rowCount; i++) {
    const row: Row = {};
    // Trailing only: SAP pads CHAR columns, but leading blanks carry meaning — they are
    // the indentation of ABAP source lines read from RSAABAP.
    for (const col of columns) row[col.name] = (col.values[i] ?? '').replace(/\s+$/, '');
    rows.push(row);
  }
  return rows;
}

/**
 * Run one ABAP SQL statement through ADT DataPreview.
 *
 * Retried once on a rejected CSRF token. The token is fetched from the BW modeling service
 * and spent on the ADT service, and the backend rotates it out from under the client —
 * reading modeling metadata first, or two of these POSTs in flight at once, is enough to
 * have the token refused with HTTP 403. The statement has no side effects, so a second
 * attempt with a freshly fetched token is safe, and without it a read fails for a reason
 * that has nothing to do with the data.
 *
 * Retried once on a dropped connection for the same reason. A read that needs several
 * statements keeps a connection busy long enough for the server to recycle it, and the
 * resulting ECONNRESET reaches the caller as a stack trace rather than as an answer
 * (verified: reproducible on a run of consecutive reads, and gone on the next attempt with
 * the same object). One retry, because a genuinely unreachable host must still fail fast.
 *
 * Retried once on HTTP 500 as well, which is what a classic release answers when two of
 * these POSTs are the first calls of a session: with no session cookie yet, both requests
 * open their own session and one of them loses (verified on a 7.5 system — reproducible on
 * a cold client, never on one that has run a single statement before). A malformed
 * statement does not come back this way; the service reports that as HTTP 400 with a
 * message, so the retry cannot swallow a real SQL error.
 */
export async function queryTable(client: BwClient, sql: string, maxRows = 500): Promise<Row[]> {
  const run = async (): Promise<string> => {
    const token = await client.getCsrfToken();
    const { body } = await client.rawPost(
      `/sap/bc/adt/datapreview/freestyle?rowNumber=${maxRows}`,
      sql,
      {
        'Content-Type': 'text/plain',
        Accept: 'application/xml, application/vnd.sap.adt.datapreview.table.v1+xml',
        'X-CSRF-Token': token,
      },
    );
    return body;
  };

  try {
    return parseDataPreview(await run());
  } catch (err) {
    const message = String((err as Error).message);
    if (/HTTP 403|CSRF/i.test(message)) {
      client.clearCsrfToken();
      return parseDataPreview(await run());
    }
    if (/ECONNRESET|ECONNABORTED|EPIPE|socket hang up/i.test(message)) {
      return parseDataPreview(await run());
    }
    if (/HTTP 500/.test(message)) {
      return parseDataPreview(await run());
    }
    throw err;
  }
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Tables store `/NAMESPACE/FIELD`; the REST API and the frontend render `$NAMESPACE$FIELD`. */
export function toDisplayName(field: string): string {
  const m = field.match(/^\/([^/]+)\/(.+)$/);
  return m ? `$${m[1]}$${m[2]}` : field;
}

/** `20190111125226` and `20190111125226.6875150` alike become `2019-01-11 12:52:26`. */
export function formatStamp(date: string | undefined, time?: string): string {
  const d = (date ?? '').trim();
  if (!d || /^0+$/.test(d)) return '';
  const digits = d.replace(/\..*$/, '');
  const day = digits.slice(0, 8);
  const clock = (time ?? digits.slice(8, 14)).padEnd(6, '0');
  if (day.length < 8) return d;
  return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)} ` +
    `${clock.slice(0, 2)}:${clock.slice(2, 4)}:${clock.slice(4, 6)}`;
}

/** Seconds between two RSBKREQUEST timestamps, which carry fractions after the dot. */
export function durationSeconds(start: string | undefined, finish: string | undefined): string {
  const toSec = (v: string | undefined): number | undefined => {
    const m = (v ?? '').trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$/);
    if (!m) return undefined;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return ms / 1000 + (m[7] ? Number(`0.${m[7]}`) : 0);
  };
  const a = toSec(start);
  const b = toSec(finish);
  if (a === undefined || b === undefined || b < a) return '';
  const secs = b - a;
  if (secs < 60) return `${secs.toFixed(1)} s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${(secs % 60).toFixed(0)}s`;
  // Hours, because the things measured here run that long: a nightly load, or a chain that
  // waited overnight for a cancelled step to be repeated. "1107m 29s" states the same
  // duration and no reader converts it in their head.
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

/**
 * Split values into quoted IN-list fragments that keep the statement inside the length the
 * DataPreview service accepts.
 *
 * That service parses at most 255 characters of statement; beyond it the text is cut and the
 * parser complains about an unterminated literal rather than about the length. `budget` is the
 * room left for the list once the rest of the statement is counted.
 */
export function inListBatches(values: string[], budget: number): string[] {
  const batches: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const v of values) {
    const piece = `'${sqlLiteral(v)}'`;
    const added = piece.length + (current.length > 0 ? 2 : 0);
    if (current.length > 0 && length + added > budget) {
      batches.push(current.join(', '));
      current = [];
      length = 0;
    }
    current.push(piece);
    length += piece.length + (current.length > 1 ? 2 : 0);
  }
  if (current.length > 0) batches.push(current.join(', '));
  return batches;
}

