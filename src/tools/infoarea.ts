import { BwClient, MEDIA_TYPES, bwSeg, decodeXmlEntities, stripInfoAreaSentinel } from '../bw-client.js';

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
      href="/sap/bw/modeling/${typeLower}/${bwSeg(nameLower)}/m"
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
  const result = await client.get(`/sap/bw/modeling/area/${bwSeg(nameLower)}`, MEDIA_TYPES['area']);
  const body = result.body;

  try {
    const parsed = JSON.parse(body);

    const infoAreaName: string = parsed['name'] ?? name.toUpperCase();

    const label: string =
      parsed['endUserTexts']?.['label'] ??
      parsed['descriptions']?.['label'] ??
      parsed['label'] ??
      '';

    // Tree navigation is the one place the placeholder is meaningful, so an object parked
    // under it reports no parent rather than the placeholder's name.
    const parentArea: string | null =
      stripInfoAreaSentinel(
        parsed['tlogoProperties']?.['infoArea'] ??
        parsed['parentInfoArea'] ??
        '',
      ) || null;

    const objectStatus: string =
      parsed['tlogoProperties']?.['adtcore:version'] ??
      parsed['tlogoProperties']?.['objectStatus'] ??
      parsed['objectStatus'] ??
      '';

    return JSON.stringify({ name: infoAreaName, label, parent_area: parentArea || null, object_status: objectStatus }, null, 2);
  } catch {
    // Classic releases answer this resource in XML where BW/4HANA answers in JSON. Without
    // the second reader the tool handed back the whole document as `raw` and left the
    // caller to parse it — the same four fields are in there, just spelled differently.
    return parseInfoAreaXml(body, name);
  }
}

/** The four fields of `bw_get_infoarea`, read out of the XML form of the resource. */
function parseInfoAreaXml(xml: string, requestedName: string): string {
  const attr = (name: string) => xml.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
  const element = (name: string) => xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];

  const infoAreaName = attr('name') ?? requestedName.toUpperCase();
  const label = decodeXmlEntities(element('longDescription') ?? '');
  // The parent is an attribute on the root here, not a nested <infoArea> element.
  const parentArea = stripInfoAreaSentinel(decodeXmlEntities(attr('parentInfoArea') ?? '')) || null;
  const objectStatus = element('objectStatus') ?? '';

  return JSON.stringify(
    { name: infoAreaName, label, parent_area: parentArea, object_status: objectStatus },
    null,
    2,
  );
}
