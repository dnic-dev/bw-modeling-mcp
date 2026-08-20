import { BwClient, MEDIA_TYPES, createClientFromEnv, bwSeg } from '../bw-client.js';

/**
 * Parse all <atom:title> entries from an activation/atom feed response.
 * Used to extract success messages and deactivated DTP names.
 */
export function parseActivationMessages(xml: string): string[] {
  const messages: string[] = [];
  const regex = /<atom:title>([^<]+)<\/atom:title>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    messages.push(match[1]);
  }
  return messages;
}

/**
 * Parse DTP names that were deactivated by impact analysis from activation response.
 * Matches both German and English SAP system messages containing a DTP name and a deactivation keyword.
 */
export function parseDtpsDeactivated(xml: string): string[] {
  const dtps: string[] = [];
  const messages = parseActivationMessages(xml);
  for (const msg of messages) {
    // Match DTP name pattern in German or English activation messages
    const dtpMatch = msg.match(/\b(DTP_[A-Z0-9]+)\b/i);
    if (dtpMatch && (msg.toLowerCase().includes('deaktiv') || msg.toLowerCase().includes('deactiv'))) {
      dtps.push(dtpMatch[1].toUpperCase());
    }
  }
  return dtps;
}

/**
 * bw_activate — activate one BW object (aDSO, Transformation, or DTP).
 *
 * Sequence:
 *   1. POST /sap/bw/modeling/activation   (with lockHandle in body)
 *   2. POST ?action=unlock                (skipped for DTP — no unlock needed)
 *
 * For DTP activation pass lock_handle="" (empty string).
 * The lockHandle is obtained from bw_update_adso or bw_update_transformation.
 *
 * Returns all messages from the activation response, including any DTPs
 * that were deactivated by impact analysis (these must be re-activated with bw_activate).
 */
export async function bwActivate(
  client: BwClient,
  objectType: string,
  objectName: string,
  lockHandle: string,
  corrNr?: string,
  sourceSystem?: string
): Promise<string> {
  const typeLower = objectType.toLowerCase();

  // Validate object type
  if (!['adso', 'trfn', 'dtpa', 'iobj', 'trcs', 'rsds', 'hcpr', 'alvl'].includes(typeLower)) {
    return JSON.stringify({
      success: false,
      message: `Unknown object type: ${objectType}. Supported: adso, trfn, dtpa, iobj, trcs, rsds, hcpr, alvl`,
    });
  }

  // RSDS (DataSource) has a compound key — the source system is mandatory.
  if (typeLower === 'rsds' && !sourceSystem) {
    return JSON.stringify({
      success: false,
      message: `object_type "rsds" requires source_system (a DataSource is identified by DataSource name plus source system).`,
    });
  }

  // Step 2: Activate
  // trfn and dtpa activate in a fresh SAP session. The shared module-level client carries a
  // stale session buffer that still sees the transformation as inactive (the state from DTP
  // creation time); a fresh session reads the current DB state and avoids the false
  // "transformation inactive" rejection, as well as cross-call session/CSRF collisions.
  const activationClient = (typeLower === 'trfn' || typeLower === 'dtpa')
    ? createClientFromEnv()
    : client;

  // Step 1: For trfn/dtpa, GET the object with forceCacheUpdate=true before activating.
  // This mirrors Eclipse, which always issues GET /m?forceCacheUpdate=true right before the
  // activation POST. The parameter forces the server-side model cache to sync the just-PUT
  // inactive (/m) version; without it the activation can pick up a stale cached /m and activate
  // the OLD content (e.g. a runtime switch to HANA silently activates the previous ABAP version,
  // so the active version never flips). The priming GET must run in the SAME session that
  // performs the activation, otherwise it refreshes a buffer other than the one activating.
  if (typeLower === 'trfn' || typeLower === 'dtpa') {
    const mediaKey = typeLower as keyof typeof MEDIA_TYPES;
    await activationClient.get(
      `/sap/bw/modeling/${typeLower}/${bwSeg(objectName)}/m?forceCacheUpdate=true`,
      MEDIA_TYPES[mediaKey]
    );
  }

  const activationXml = await activationClient.activate(typeLower, objectName, lockHandle, corrNr, sourceSystem);

  // Step 3: Unlock (skipped for dtpa and rsds — both are standalone activations with no lock)
  // Always use the original client session — BW locks are session-bound and can only
  // be released by the session that acquired them. activationClient is a fresh session
  // for trfn and would silently fail to release the lock.
  if (lockHandle && typeLower !== 'dtpa' && typeLower !== 'rsds') {
    await client.unlock(typeLower, objectName);
  }

  // Parse result messages
  const messages = parseActivationMessages(activationXml);
  const deactivatedDtps = parseDtpsDeactivated(activationXml);

  // Check for errors in the response
  const hasError = activationXml.includes('messageType="Error"') ||
    activationXml.includes("messageType='Error'");
  const hasWarning = activationXml.includes('messageType="Warning"') ||
    activationXml.includes("messageType='Warning'");

  // BW pattern: when a transformation contains a mapping rule for a field that no
  // longer exists in the target aDSO, BW fails the first activation with an Error
  // but simultaneously deletes the invalid rule. A single retry then succeeds.
  // Detect this by looking for "is not valid and is being deleted" in the messages.
  const hasDeletedRule = messages.some(
    (m) => m.toLowerCase().includes('is not valid and is being deleted')
  );
  if (hasError && hasDeletedRule && typeLower === 'trfn') {
    const retryClient = createClientFromEnv();
    const retryXml = await retryClient.activate(typeLower, objectName, lockHandle, corrNr);
    if (lockHandle) {
      await client.unlock(typeLower, objectName);
    }
    const retryMessages = parseActivationMessages(retryXml);
    const retryDeactivatedDtps = parseDtpsDeactivated(retryXml);
    const retryHasError = retryXml.includes('messageType="Error"') ||
      retryXml.includes("messageType='Error'");
    const retryHasWarning = retryXml.includes('messageType="Warning"') ||
      retryXml.includes("messageType='Warning'");
    const retryResult: Record<string, unknown> = {
      success: !retryHasError,
      object_type: objectType.toUpperCase(),
      object_name: objectName.toUpperCase(),
      messages: retryMessages,
      retried: true,
    };
    if (retryHasWarning) retryResult['warning'] = true;
    if (retryDeactivatedDtps.length > 0) {
      retryResult['dtps_deactivated_by_impact_analysis'] = retryDeactivatedDtps;
      retryResult['next_step'] =
        `Re-activate the deactivated DTPs using bw_activate with object_type="dtpa" and lock_handle="".`;
    }
    return JSON.stringify(retryResult, null, 2);
  }

  // BW pattern: when activating a trfn fails and a non-empty lockHandle was passed,
  // retry once with an empty lockHandle after a short delay. This handles cases where
  // the transformation was never explicitly locked by the caller (stale lockHandle).
  if (hasError && typeLower === 'trfn' && lockHandle) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const retryClient = createClientFromEnv();
    const retryXml = await retryClient.activate(typeLower, objectName, '', corrNr);
    // No unlock needed here — retrying with empty lockHandle means the object was not locked
    const retryMessages = parseActivationMessages(retryXml);
    const retryDeactivatedDtps = parseDtpsDeactivated(retryXml);
    const retryHasError = retryXml.includes('messageType="Error"') ||
      retryXml.includes("messageType='Error'");
    const retryHasWarning = retryXml.includes('messageType="Warning"') ||
      retryXml.includes("messageType='Warning'");
    const retryResult: Record<string, unknown> = {
      success: !retryHasError,
      object_type: objectType.toUpperCase(),
      object_name: objectName.toUpperCase(),
      messages: retryMessages,
      retried: true,
    };
    if (retryHasWarning) retryResult['warning'] = true;
    if (retryDeactivatedDtps.length > 0) {
      retryResult['dtps_deactivated_by_impact_analysis'] = retryDeactivatedDtps;
      retryResult['next_step'] =
        `Re-activate the deactivated DTPs using bw_activate with object_type="dtpa" and lock_handle="".`;
    }
    return JSON.stringify(retryResult, null, 2);
  }

  const result: Record<string, unknown> = {
    success: !hasError,
    object_type: objectType.toUpperCase(),
    object_name: objectName.toUpperCase(),
    messages,
  };

  if (hasWarning) {
    result['warning'] = true;
  }

  if (deactivatedDtps.length > 0) {
    result['dtps_deactivated_by_impact_analysis'] = deactivatedDtps;
    result['next_step'] =
      `Re-activate the deactivated DTPs using bw_activate with object_type="dtpa" and lock_handle="".`;
  }

  return JSON.stringify(result, null, 2);
}
