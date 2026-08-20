import { BwClient, MEDIA_TYPES, bwSeg, bwSegUpper } from '../bw-client.js';
import { queryAccept, queryWriteMediaType } from './query.js';

function parseAtomTitles(xml: string): string[] {
  return [...xml.matchAll(/<atom:title[^>]*>([^<]+)<\/atom:title>/g)].map(m => m[1]);
}

/**
 * Delete a BW Query (TLOGO ELEM). Queries do not use the generic /{type}/{name}/m
 * delete flow; the wire protocol (payloads/query_delete.md) is a dedicated
 * sequence: lock through /comp/enq (activity_context DELE), DELETE the query URL
 * with an uppercase /A path, then unlock through the lowercase query URL.
 *
 * Reusable subComponents (variables, CKFs, RKFs) referenced by the query are NOT
 * deleted — only the query (ELEM) itself.
 */
async function bwDeleteQuery(
  client: BwClient,
  objectType: string,
  objectName: string
): Promise<string> {
  const nameUpper = objectName.toUpperCase();
  const nameLower = objectName.toLowerCase();

  // 1. Lock via the enqueue endpoint (name UPPERCASE, no compuid, DELE context).
  const csrf = await client.getCsrfToken();
  const lockResponse = await client.rawPost(
    `/sap/bw/modeling/comp/enq/${bwSegUpper(nameUpper)}?action=lock`,
    '',
    {
      'activity_context': 'DELE',
      'Accept': queryAccept(),
      'x-csrf-token': csrf,
    });
  const lockMatch = lockResponse.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/);
  if (!lockMatch) {
    throw new Error(`No <LOCK_HANDLE> in query delete lock response:\n${lockResponse.body}`);
  }
  const lockHandle = lockMatch[1];

  // Unlock through the lowercase query URL (asymmetric to the lock — replicate as traced).
  const unlock = async () => {
    await client.rawPost(
      `/sap/bw/modeling/query/${bwSeg(nameLower)}/a?action=unlock`,
      '',
      { 'Accept': queryAccept(), 'x-csrf-token': await client.getCsrfToken() });
  };

  try {
    // 2. DELETE — uppercase /A path. Use the safe negotiation form for Content-Type
    //    (the traced single v1_11 fails with HTTP 415 on lower-version backends).
    const deleteResponse = await client.rawDelete(
      `/sap/bw/modeling/query/${bwSegUpper(nameUpper)}/A?lockHandle=${lockHandle}`,
      {
        'Accept': queryAccept(),
        'Content-Type': `application/xml, ${queryWriteMediaType()}`,
      });

    // Success is an empty atom feed. HTTP 200 (rawDelete throws on >= 400) is
    // success regardless of feed content, but any checkresult entry with
    // messageType="Error" is surfaced as an error.
    const messages: string[] = [];
    const errorTitles: string[] = [];
    const entryRegex = /<atom:entry>([\s\S]*?)<\/atom:entry>/g;
    let em: RegExpExecArray | null;
    while ((em = entryRegex.exec(deleteResponse.body)) !== null) {
      const entry = em[1];
      const messageType = entry.match(/messageType="([^"]*)"/)?.[1] ?? '';
      const title = entry.match(/<atom:title[^>]*>([\s\S]*?)<\/atom:title>/)?.[1]?.trim() ?? '';
      if (messageType === 'Error') errorTitles.push(title || '(no title)');
      else if (title) messages.push(title);
    }
    if (errorTitles.length > 0) {
      throw new Error(`Query deletion reported errors: ${errorTitles.join('; ')}`);
    }

    // 3. Unlock — tolerate failures with a stderr warning.
    try {
      await unlock();
    } catch (unlockErr) {
      process.stderr.write(`Warning: failed to unlock query ${nameLower} after delete: ${unlockErr}\n`);
    }

    return JSON.stringify({
      success: true,
      object_type: objectType.toUpperCase(),
      object_name: nameUpper,
      messages,
    });
  } catch (err) {
    // The lock was acquired; attempt to release it before rethrowing.
    try {
      await unlock();
    } catch (unlockErr) {
      process.stderr.write(`Warning: failed to unlock query ${nameLower} after error: ${unlockErr}\n`);
    }
    throw err;
  }
}

export async function bwDelete(
  client: BwClient,
  objectType: string,
  objectName: string
): Promise<string> {
  const typeLower = objectType.toLowerCase();

  // Queries (TLOGO ELEM) need a dedicated delete sequence.
  if (typeLower === 'query' || typeLower === 'elem') {
    return bwDeleteQuery(client, objectType, objectName);
  }

  const mediaType = MEDIA_TYPES[typeLower] ?? 'application/xml';

  // 1. Lock — uses /m before ?action=lock (delete-specific lock URL)
  const lockHandle = await client.lockForDelete(typeLower, objectName, mediaType);

  // 2. DELETE
  const deleteResult = await client.delete(typeLower, objectName, lockHandle, mediaType);

  // 3. Unlock — no /m (same as normal unlock)
  await client.unlock(typeLower, objectName);

  // 4. Parse atom feed response
  const messages = parseAtomTitles(deleteResult);

  return JSON.stringify({
    success: true,
    object_type: objectType.toUpperCase(),
    object_name: objectName.toUpperCase(),
    messages,
  });
}
