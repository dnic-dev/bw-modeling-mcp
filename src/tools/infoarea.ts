import { BwClient, MEDIA_TYPES } from '../bw-client.js';
import { stripInfoAreaSentinel } from '../xml.js';

// ── bwMoveObject ──────────────────────────────────────────────────────────────

export interface MoveObjectArgs {
  objectType: string;
  objectName: string;
  targetInfoArea: string;
}

/**
 * bw_move_object — move any BW object to a different InfoArea.
 *
 * Single POST to /sap/bw/modeling/move_requests — no lock needed.
 */
export async function bwMoveObject(
  client: BwClient,
  args: MoveObjectArgs
): Promise<string> {
  const typeLower = args.objectType.toLowerCase();
  const nameLower = args.objectName.toLowerCase();
  const targetUpper = args.targetInfoArea.toUpperCase();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xmlns:bwModel="http://www.sap.com/bw/modeling">
  <atom:entry>
    <atom:content type="application/xml">
      <bwModel:moveProperties
        targetObjectType="AREA"
        targetObjectName="${targetUpper}"
        movePosition="CHILD"
        version="inactive"
        lockHandle="">
      </bwModel:moveProperties>
    </atom:content>
    <atom:link
      href="/sap/bw/modeling/${typeLower}/${nameLower}/m"
      type="application/*"
      rel="self">
    </atom:link>
  </atom:entry>
</atom:feed>`;

  await client.postRaw('/sap/bw/modeling/move_requests', xml, 'application/atom+xml;type=entry');

  return JSON.stringify({
    success: true,
    objectType: typeLower,
    objectName: nameLower,
    targetInfoArea: targetUpper,
    message: `Object '${args.objectName.toUpperCase()}' moved to InfoArea '${targetUpper}'.`,
  });
}

// ── bwCreateInfoArea ──────────────────────────────────────────────────────────

export interface CreateInfoAreaArgs {
  name: string;
  parent_info_area?: string;
  description?: string;
  package?: string;
}

/**
 * bw_create_infoarea — create a new InfoArea (immediately active, no activation step needed).
 *
 * Flow:
 * 1. Lock (CREA, no parent_name/parent_type)  → lockHandle
 * 2. POST with XML body                        → InfoArea created and active
 *    (unlock is automatic after POST)
 */
export async function bwCreateInfoArea(
  client: BwClient,
  args: CreateInfoAreaArgs
): Promise<string> {
  const nameUpper = args.name.toUpperCase();
  const nameLower = args.name.toLowerCase();
  const pkg = args.package ?? '$TMP';
  const desc = args.description ?? '';
  const parentUpper = args.parent_info_area?.toUpperCase() ?? '';

  const language = process.env.BW_LANGUAGE?.toUpperCase() ?? 'DE';
  const user = process.env.BW_USER?.toUpperCase() ?? '';

  // Step 1: Lock with CREA (no parent_name / parent_type for InfoArea)
  const lockHandle = await client.lock('area', nameLower, {
    activity_context: 'CREA',
  }, 'stateful_enqueue');

  // Step 2: POST — creates and activates the InfoArea in one step
  const parentAttr = parentUpper ? ` parentInfoArea="${parentUpper}"` : '';
  const parentElement = parentUpper ? parentUpper : '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<InfoArea:infoArea
  xmlns:InfoArea="http://www.sap.com/bw/modeling/BwInfoArea.ecore"
  xmlns:adtcore="http://www.sap.com/adt/core"
  name="${nameUpper}"${parentAttr}>
  <longDescription>${desc}</longDescription>
  <tlogoProperties
    adtcore:language="${language}"
    adtcore:name="${nameUpper}"
    adtcore:type="AREA"
    adtcore:masterLanguage="${language}"
    adtcore:responsible="${user}">
    <infoArea>${parentElement}</infoArea>
  </tlogoProperties>
</InfoArea:infoArea>`;

  await client.create('area', nameLower, lockHandle, xml, { 'Development-Class': pkg });
  await client.unlock('area', nameLower);

  return JSON.stringify({
    success: true,
    name: nameUpper,
    parentInfoArea: parentUpper || null,
    description: desc,
    package: pkg,
    message: `InfoArea '${nameUpper}' created and active.`,
  });
}

// ── bwGetInfoarea ─────────────────────────────────────────────────────────────

/**
 * bw_get_infoarea — read an InfoArea definition.
 *
 * GET /sap/bw/modeling/area/{name}
 */
export async function bwGetInfoarea(client: BwClient, name: string): Promise<string> {
  const nameLower = name.toLowerCase();
  const result = await client.get(`/sap/bw/modeling/area/${nameLower}`, MEDIA_TYPES['area']);
  const body = result.body;

  try {
    const parsed = JSON.parse(body);

    const infoAreaName: string = parsed['name'] ?? name.toUpperCase();

    const label: string =
      parsed['endUserTexts']?.['label'] ??
      parsed['descriptions']?.['label'] ??
      parsed['label'] ??
      '';

    const parentArea: string | null =
      parsed['tlogoProperties']?.['infoArea'] ??
      parsed['parentInfoArea'] ??
      null;

    const objectStatus: string =
      parsed['tlogoProperties']?.['adtcore:version'] ??
      parsed['tlogoProperties']?.['objectStatus'] ??
      parsed['objectStatus'] ??
      '';

    return JSON.stringify({ name: infoAreaName, label, parent_area: stripInfoAreaSentinel(parentArea ?? '') || null, object_status: objectStatus }, null, 2);
  } catch {
    return JSON.stringify({ raw: body });
  }
}
