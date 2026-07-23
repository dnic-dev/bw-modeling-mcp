import { BwClient, MEDIA_TYPES, createClientFromEnv, freshRead, bwSeg } from '../bw-client.js';

// ── KYF: objectSpecificDataType → keyfigureType / semantics ──────────────────

const KYF_TYPE_MAP: Record<string, { keyfigureType: string; semantics: string }> = {
  DEC:  { keyfigureType: 'NUM', semantics: 'NUM' },
  CURR: { keyfigureType: 'AMT', semantics: 'AMT' },
  FLTP: { keyfigureType: 'NUM', semantics: 'NUM' },
  QUAN: { keyfigureType: 'QUA', semantics: 'QUA' },
  DATS: { keyfigureType: 'DAT', semantics: 'DAT' },
  INT4: { keyfigureType: 'INT', semantics: 'INT4' },
  INT8: { keyfigureType: 'INT', semantics: 'INT8' },
  TIMS: { keyfigureType: 'NUM', semantics: 'NUM' },
};

// ── bwCreateInfoObject ────────────────────────────────────────────────────────

export interface CreateInfoObjectArgs {
  infoobject_type?: 'CHA' | 'KYF';
  name: string;
  info_area: string;
  description: string;
  // CHA
  data_type?: string;
  length?: number;
  conversion_routine?: string;
  with_master_data?: boolean;
  with_texts?: boolean;
  referenced_infoobject?: string;
  // KYF
  object_specific_data_type?: string;
  aggregation_type?: string;
  fixed_unit?: string;
  fixed_currency?: string;
  // compound parent InfoObjects — CHA only; order matters (matches BW compound order)
  compound_infoobjects?: string[];
  // common
  package?: string;
  transport?: string;
}

/**
 * bw_create_infoobject — create a new InfoObject (CHA or KYF, inactive).
 *
 * KYF flow (POST body accepted by API — no PUT needed):
 * 1. Lock (CREA, stateful_enqueue)  → lockHandle
 * 2. Create-POST with full KYF body → object created with correct values
 * 3. Unlock
 * 4. Return lockHandle="" (KYF activation requires no lock)
 *
 * CHA flow (POST body ignored — PUT required):
 * 1. Lock (CREA, stateful_enqueue)  → lockHandle
 * 2. Create-POST (minimal body)     → object created with server defaults
 * 3. GET /iobj/{name}/m             → server-enriched XML + timestamp header
 * 4. Lock (normal, no CREA)         → same lockHandle returned (CREA lock still active)
 * 5. PUT /iobj/{name}/m             → GET response with desired values substituted
 * 6. Return lockHandle for caller to use with bw_activate
 */
export async function bwCreateInfoObject(
  client: BwClient,
  args: CreateInfoObjectArgs
): Promise<string> {
  const isobjType = (args.infoobject_type ?? 'CHA').toUpperCase() as 'CHA' | 'KYF';
  const nameLower = args.name.toLowerCase();
  const nameUpper = args.name.toUpperCase();
  const pkg = args.package ?? '$TMP';
  const desc = args.description;
  const infoArea = args.info_area.toUpperCase();

  // Step 1: Lock with CREA headers (stateful_enqueue session)
  const lockHandle = await client.lock('iobj', nameLower, {
    activity_context: 'CREA',
    parent_name: infoArea,
    parent_type: 'AREA',
  }, 'stateful_enqueue');

  // ── KYF: POST body accepted — fixedUnit/fixedCurrency via GET+PUT ────────────
  if (isobjType === 'KYF') {
    const ost = (args.object_specific_data_type ?? 'DEC').toUpperCase();
    const mapped = KYF_TYPE_MAP[ost];
    const keyfigureType = mapped?.keyfigureType ?? ost;
    const semantics = mapped?.semantics ?? ost;
    const aggregationType = (args.aggregation_type ?? 'SUM').toUpperCase();

    // SAP ignores fixedUnit/fixedCurrency in the POST body — omit them here
    const language = process.env.BW_LANGUAGE ?? 'DE';
    const kyfXml = `<?xml version="1.0" encoding="UTF-8"?>
<InfoObject:infoObject
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:InfoObject="http://www.sap.com/bw/modeling/BwIobj.ecore"
  xmlns:adtcore="http://www.sap.com/adt/core"
  xsi:type="InfoObject:Keyfigure"
  name="${nameUpper}"
  shortDescriptionSet="false"
  keyFigureSemantic="_"
  keyfigureType="${keyfigureType}"
  objectSpecificDataType="${ost}">
  <infoObjectType>KYF</infoObjectType>
  <dataElement/>
  <longDescription>${desc}</longDescription>
  <shortDescription>${desc}</shortDescription>
  <tlogoProperties adtcore:language="${language}" adtcore:name="${nameUpper}" adtcore:type="IOBJ"
    adtcore:masterLanguage="${language}" adtcore:responsible="${process.env.BW_USER}">
    <infoArea>${infoArea}</infoArea>
  </tlogoProperties>
  <referencedInfoObject/>
  <semantics>${semantics}</semantics>
  <aggregationType>${aggregationType}</aggregationType>
  <exceptionAggregation>
    <referencedCharacteristic/>
  </exceptionAggregation>
  <displayProperties/>
  <inventoryContext/>
  <elimination/>
  <stockCoverageProperties calculationType="B">
    <referencedStockKeyfigure/>
    <referencedDemandKeyfigure/>
    <timeGranularityOfStockCoverage/>
  </stockCoverageProperties>
</InfoObject:infoObject>`;

    await client.create('iobj', nameLower, lockHandle, kyfXml, { 'Development-Class': pkg });
    await client.unlock('iobj', nameLower);

    // fixedUnit / fixedCurrency: SAP only accepts these via PUT after creation
    if (args.fixed_unit || args.fixed_currency) {
      const freshClient = createClientFromEnv();
      const getResult = await freshClient.get(`/sap/bw/modeling/iobj/${bwSeg(nameLower)}/m`, MEDIA_TYPES['iobj']);
      const timestamp = getResult.headers['timestamp'] ?? getResult.headers['TIMESTAMP'];
      let xml = getResult.body;

      const putLockHandle = await client.lock('iobj', nameLower, undefined, 'stateful_enqueue');

      if (args.fixed_unit) {
        const unit = args.fixed_unit.toUpperCase();
        xml = xml.replace('<unitCurrencyInfoObjectRef', `<fixedUnit>${unit}</fixedUnit><unitCurrencyInfoObjectRef`);
      }
      if (args.fixed_currency) {
        const cur = args.fixed_currency.toUpperCase();
        xml = xml.replace('<unitCurrencyInfoObjectRef', `<fixedCurrency>${cur}</fixedCurrency><unitCurrencyInfoObjectRef`);
      }

      await freshClient.put('iobj', nameLower, putLockHandle, xml, timestamp, args.transport);
      await client.unlock('iobj', nameLower);
    }

    const kyfResult: Record<string, unknown> = {
      success: true,
      infoobjectType: 'KYF',
      name: nameUpper,
      infoArea: args.info_area,
      description: desc,
      package: pkg,
      lockHandle: '',
      objectSpecificDataType: ost,
      keyfigureType,
      semantics,
      aggregationType,
    };
    if (args.fixed_unit) kyfResult['fixedUnit'] = args.fixed_unit.toUpperCase();
    if (args.fixed_currency) kyfResult['fixedCurrency'] = args.fixed_currency.toUpperCase();
    kyfResult['message'] = `InfoObject '${nameUpper}' created (inactive). Call bw_activate with lock_handle="" to activate.`;

    return JSON.stringify(kyfResult);
  }

  // ── CHA: POST body ignored — GET + PUT required ────────────────────────────

  // Step 2: Create-POST — API ignores body, creates object with defaults
  const minimalXml = `<?xml version="1.0" encoding="UTF-8"?><iobj:infoObject xmlns:iobj="http://www.sap.com/bw/modeling/BwIobj.ecore" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="iobj:Characteristic" name="${nameUpper}"/>`;
  await client.create('iobj', nameLower, lockHandle, minimalXml, { 'Development-Class': pkg });

  // Step 3: GET server-created object (defaults) to obtain enriched XML + timestamp
  const getResult = await client.get(`/sap/bw/modeling/iobj/${bwSeg(nameLower)}/m`, MEDIA_TYPES['iobj']);
  const timestamp = getResult.headers['timestamp'] ?? getResult.headers['TIMESTAMP'];

  // Step 4: Lock again (stateful_enqueue) — same session, server returns same lockHandle
  await client.lock('iobj', nameLower, undefined, 'stateful_enqueue');

  // Step 5: Build PUT body — substitute desired values into the GET response
  let putXml = getResult.body;

  // Remove fieldName attribute — it tells SAP the DDIC field already exists with the old
  // type/length, causing SAP to ignore dataType/length changes in the PUT body.
  putXml = putXml.replace(/\s+fieldName="[^"]*"/, '');
  // Normalise masterDataAccess — GET returns type="GEN" but PUT expects explicit empty attrs
  putXml = putXml.replace(/<masterDataAccess[^/]*\/>/, '<masterDataAccess readClass="" sapHanaPackage="" sapHanaView=""/>');

  const chaDataType = (args.data_type ?? 'CHAR').toUpperCase();
  const chaLength = args.length ?? 10;
  const defaultConv = (chaDataType === 'CHAR' || chaDataType === 'NUMC') ? 'ALPHA' : '';
  const chaConv = args.conversion_routine ?? defaultConv;
  const withMasterData = args.with_master_data ?? false;
  const withTexts = args.with_texts ?? false;

  // Root element attributes
  putXml = putXml.replace(/\bobjectSpecificDataType="[^"]*"/, `objectSpecificDataType="${chaDataType}"`);
  putXml = putXml.replace(/\boutputLength="[^"]*"/, `outputLength="${chaLength}"`);
  if (/\bconversionRoutine="/.test(putXml)) {
    putXml = putXml.replace(/\bconversionRoutine="[^"]*"/, `conversionRoutine="${chaConv}"`);
  } else if (chaConv) {
    // Add conversionRoutine attribute to root element if not present
    putXml = putXml.replace(/(<iobj:infoObject\b)/, `$1 conversionRoutine="${chaConv}"`);
  }
  // CHA child elements
  putXml = putXml.replace(/<dataType>[^<]*<\/dataType>/, `<dataType>${chaDataType}</dataType>`);
  putXml = putXml.replace(/<length>[^<]*<\/length>/, `<length>${chaLength}</length>`);

  // masterDataProperties — GET response has NO withMasterData attribute; PUT must add it
  putXml = putXml.replace(
    /<masterDataProperties(\s[^>]*)?>/,
    `<masterDataProperties withMasterData="${withMasterData}">`
  );

  // textProperties — set withTexts / shortTextAvailable / languageDependentTextAvailable
  if (withTexts) {
    putXml = putXml.replace(
      /<textProperties(\s[^>]*)?>/,
      `<textProperties shortTextAvailable="true" withTexts="true">`
    );
  } else {
    putXml = putXml.replace(
      /<textProperties(\s[^>]*)?>/,
      `<textProperties languageDependentTextAvailable="false" shortTextAvailable="false" withTexts="false">`
    );
  }

  // Common substitutions — descriptions, InfoArea, texts element, hana mapping
  // SAP XML texts use 1-letter language codes (D, E, F…); BW_LANGUAGE may be ISO (DE, EN…)
  const ISO_TO_SAP: Record<string, string> = {
    DE: 'D', EN: 'E', FR: 'F', IT: 'I', ES: 'S', NL: 'N', PT: 'P',
    RU: 'R', JA: 'J', KO: 'K', ZH: '1', PL: 'L', CS: 'C',
  };
  const bwLangRaw = process.env.BW_LANGUAGE;
  const bwLangSap = bwLangRaw
    ? (ISO_TO_SAP[bwLangRaw.toUpperCase()] ?? bwLangRaw)
    : undefined;
  putXml = putXml.replace(/<longDescription>[^<]*<\/longDescription>/, `<longDescription>${desc}</longDescription>`);
  putXml = putXml.replace(/<shortDescription>[^<]*<\/shortDescription>/, `<shortDescription>${desc}</shortDescription>`);
  putXml = putXml.replace(/(<texts\b[^/]*?)longText="[^"]*"/, `$1longText="${desc}"`);
  putXml = putXml.replace(/(<texts\b[^/]*?)shortText="[^"]*"/, `$1shortText="${desc}"`);
  if (bwLangSap) {
    putXml = putXml.replace(/(<texts\b[^/]*?)language="[^"]*"/, `$1language="${bwLangSap}"`);
  }
  putXml = putXml.replace(/\badtcore:description="[^"]*"/, `adtcore:description="${desc}"`);
  putXml = putXml.replace(/<infoArea>[^<]*<\/infoArea>/, `<infoArea>${infoArea}</infoArea>`);
  putXml = putXml.replace(/(<sourceField\b[^/]*?)\bdescription="[^"]*"/, `$1description="${desc}"`);
  putXml = putXml.replace(/(<sourceField\b[^/]*?)\bshortDescription="[^"]*"/, `$1shortDescription="${desc}"`);

  // Step 6: Insert compoundParent elements if compound_infoobjects is provided (CHA only)
  if (args.compound_infoobjects && args.compound_infoobjects.length > 0) {
    const freshClient = createClientFromEnv();
    const compoundParentElements: string[] = [];
    for (const parent of args.compound_infoobjects) {
      const parentLower = parent.toLowerCase();
      const parentUpper = parent.toUpperCase();
      const parentGet = await freshClient.get(`/sap/bw/modeling/iobj/${bwSeg(parentLower)}/a`, MEDIA_TYPES['iobj']);
      const parentXml = parentGet.body;
      const parentProps = parseInfoObjectProps(parentXml);
      const parentLongDescMatch = parentXml.match(/<longDescription>([^<]+)<\/longDescription>/);
      const parentDescription = parentLongDescMatch?.[1] ?? parentProps.label;
      compoundParentElements.push(
        `<compoundParent` +
        ` description="${parentDescription}"` +
        ` infoObjectType="CHA"` +
        ` name="${parentUpper}"` +
        ` ref="../../${parentLower}/a/model.iobj#//"` +
        ` dataType="${parentProps.dataType}"` +
        ` length="${parentProps.length}">` +
        `<referencedCharacteristic xsi:type="iobj:ReferencedInfoObject" description=""/>` +
        `</compoundParent>`
      );
    }
    const compoundParentXml = compoundParentElements.join('\n') + '\n';
    const insertionPoints = [
      '<externalSAPHANAView',
      '<runtimeProperties',
      '<sidTable',
      '</iobj:infoObject>',
    ];
    let inserted = false;
    for (const point of insertionPoints) {
      if (putXml.includes(point)) {
        putXml = putXml.replace(point, compoundParentXml + point);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      throw new Error('Could not find insertion point for compoundParent elements in PUT XML');
    }
  }

  // Step 7: PUT — applies the correct values
  await client.put('iobj', nameLower, lockHandle, putXml, timestamp, args.transport);

  const resultExtra: Record<string, unknown> = {
    dataType: chaDataType,
    length: chaLength,
    conversionRoutine: chaConv,
    withMasterData,
    withTexts,
  };
  if (args.referenced_infoobject) resultExtra['referencedInfoObject'] = args.referenced_infoobject.toUpperCase();
  if (args.compound_infoobjects?.length) resultExtra['compoundParents'] = args.compound_infoobjects.map(p => p.toUpperCase());

  return JSON.stringify({
    success: true,
    infoobjectType: 'CHA',
    name: nameUpper,
    infoArea: args.info_area,
    description: desc,
    package: pkg,
    lockHandle,
    ...resultExtra,
    message: `InfoObject '${nameUpper}' created (inactive). Call bw_activate with lock_handle="${lockHandle}" to activate.`,
  });
}

// ── InfoObject props (used by adso/transformation tools) ─────────────────────

export interface InfoObjectProps {
  conversionRoutine: string;
  label: string;
  dataType: string;
  length: string;
}

/**
 * Parse key properties from an InfoObject XML response.
 * Used by bw_update_adso and bw_update_transformation.
 */
export function parseInfoObjectProps(xml: string): InfoObjectProps {
  const convMatch = xml.match(/conversionRoutine="([^"]+)"/);
  const shortDescMatch = xml.match(/<shortDescription>([^<]+)<\/shortDescription>/);
  const dataTypeMatch = xml.match(/<dataType>([^<]+)<\/dataType>/);
  const lengthMatch = xml.match(/<length>([^<]+)<\/length>/);

  return {
    conversionRoutine: convMatch?.[1] ?? '',
    label: shortDescMatch?.[1] ?? '',
    dataType: dataTypeMatch?.[1] ?? 'CHAR',
    length: lengthMatch?.[1] ?? '20',
  };
}

// ── bwUpdateInfoObject ────────────────────────────────────────────────────────

export interface AttributeDef {
  name: string;
  type: 'DIS' | 'NAV';
  timeDependent?: boolean;
  displayInQuery?: boolean;
  useTextOfOriginalCharacteristic?: boolean;
}

export interface UpdateInfoObjectArgs {
  name: string;
  attributes?: AttributeDef[];
  description?: string;
  fixed_unit?: string;
  fixed_currency?: string;
  transport?: string;
}

/**
 * bw_update_infoobject — replace the attribute list of a Characteristic InfoObject.
 *
 * Flow:
 * 1. Lock (update — no activity_context)
 * 2. GET /iobj/{name}/m → current XML + timestamp
 * 3. For each attribute: GET /iobj/{attr}/a → description, shortDescription, dataType, length
 * 4. Remove all existing <attributeN .../> elements
 * 5. Remove existing <hanaAttributeMapping type="02"> block
 * 6. Insert new <attributeN> elements before <externalSAPHANAView>
 * 7. If attributes present: insert <hanaAttributeMapping type="02"> before type="03"
 * 8. PUT full XML with timestamp
 * 9. Activate + Unlock (unlock in finally)
 */
export async function bwUpdateInfoObject(
  client: BwClient,
  args: UpdateInfoObjectArgs
): Promise<string> {
  const nameLower = args.name.toLowerCase();
  const nameUpper = args.name.toUpperCase();
  const attributes = args.attributes ?? [];

  // Step 1: Lock with the original client (holds the lock session)
  const lockHandle = await client.lock('iobj', nameLower, undefined, 'stateful_enqueue');

  try {
    // Step 2: GET current XML — fresh session to avoid SAP session state pollution
    const freshClient = createClientFromEnv();
    const getResult = await freshClient.get(`/sap/bw/modeling/iobj/${bwSeg(nameLower)}/m`, MEDIA_TYPES['iobj']);
    const timestamp = getResult.headers['timestamp'] ?? getResult.headers['TIMESTAMP'];
    let xml = getResult.body;

    // ── KYF fast path: only patch fixedUnit / fixedCurrency / description ─────
    const isKyf = /<infoObjectType>KYF<\/infoObjectType>/.test(xml);
    if (isKyf) {
      if (args.description) {
        const desc = args.description;
        xml = xml.replace(/<longDescription>[^<]*<\/longDescription>/, `<longDescription>${desc}</longDescription>`);
        xml = xml.replace(/<shortDescription>[^<]*<\/shortDescription>/, `<shortDescription>${desc}</shortDescription>`);
        xml = xml.replace(/(<texts\b[^/]*?)longText="[^"]*"/, `$1longText="${desc}"`);
        xml = xml.replace(/(<texts\b[^/]*?)shortText="[^"]*"/, `$1shortText="${desc}"`);
        xml = xml.replace(/\badtcore:description="[^"]*"/, `adtcore:description="${desc}"`);
      }
      if (args.fixed_unit) {
        const unit = args.fixed_unit.toUpperCase();
        if (/<fixedUnit>/.test(xml)) {
          xml = xml.replace(/<fixedUnit>[^<]*<\/fixedUnit>/, `<fixedUnit>${unit}</fixedUnit>`);
        } else {
          xml = xml.replace('<unitCurrencyInfoObjectRef', `<fixedUnit>${unit}</fixedUnit><unitCurrencyInfoObjectRef`);
        }
      }
      if (args.fixed_currency) {
        const cur = args.fixed_currency.toUpperCase();
        if (/<fixedCurrency>/.test(xml)) {
          xml = xml.replace(/<fixedCurrency>[^<]*<\/fixedCurrency>/, `<fixedCurrency>${cur}</fixedCurrency>`);
        } else {
          xml = xml.replace('<unitCurrencyInfoObjectRef', `<fixedCurrency>${cur}</fixedCurrency><unitCurrencyInfoObjectRef`);
        }
      }
      await freshClient.put('iobj', nameLower, lockHandle, xml, timestamp, args.transport);
      const activationClient = createClientFromEnv();
      await activationClient.activate('iobj', nameLower, lockHandle);
      return JSON.stringify({
        success: true,
        name: nameUpper,
        message: `InfoObject '${nameUpper}' (KYF) updated and activated.`,
      });
    }

    // Step 3: Fetch referenced InfoObject properties for each attribute
    const attrXmlParts: string[] = [];
    const sourceFieldParts: string[] = [];

    for (const attr of attributes) {
      const attrUpper = attr.name.toUpperCase();
      const attrLower = attr.name.toLowerCase();

      const attrGet = await freshClient.get(`/sap/bw/modeling/iobj/${bwSeg(attrLower)}/a`, MEDIA_TYPES['iobj']);
      const attrXml = attrGet.body;
      const props = parseInfoObjectProps(attrXml);
      const longDescMatch = attrXml.match(/<longDescription>([^<]+)<\/longDescription>/);
      const description = longDescMatch?.[1] ?? props.label;
      const shortDescription = props.label;

      const displayInQuery = attr.displayInQuery ?? true;
      const useTextOfOrig = attr.useTextOfOriginalCharacteristic ?? true;
      const ref = `../../${attrLower}/a/model.iobj#//`;

      if (attr.type === 'NAV') {
        const timeDependent = attr.timeDependent ?? false;
        attrXmlParts.push(
          `<attributeN` +
          ` description="${description}"` +
          ` infoObjectType="CHA"` +
          ` name="${attrUpper}"` +
          ` ref="${ref}"` +
          ` shortDescription="${shortDescription}"` +
          ` calculationScenarioNavigationAttribute="true"` +
          ` dataType="${props.dataType}"` +
          ` displayInQuery="${displayInQuery}"` +
          ` f4HelpOrder="0"` +
          ` length="${props.length}"` +
          (timeDependent ? ` timeDependent="true"` : '') +
          ` type="NAV"` +
          ` useTextOfOriginalCharacteristic="${useTextOfOrig}"/>`
        );
      } else {
        attrXmlParts.push(
          `<attributeN` +
          ` description="${description}"` +
          ` infoObjectType="CHA"` +
          ` name="${attrUpper}"` +
          ` ref="${ref}"` +
          ` shortDescription="${shortDescription}"` +
          ` dataType="${props.dataType}"` +
          ` displayInQuery="${displayInQuery}"` +
          ` f4HelpOrder="0"` +
          ` hasAttributes="false"` +
          ` length="${props.length}"` +
          ` partOfIndex="false"` +
          ` sidKeyFigure="false"` +
          ` type="DIS"` +
          ` useTextOfOriginalCharacteristic="${useTextOfOrig}"/>`
        );
      }

      sourceFieldParts.push(
        `<sourceField description="${description}" infoObjectType="CHA"` +
        ` name="${attrUpper}" shortDescription="${shortDescription}"/>`
      );
    }

    // Step 4: Remove all existing <attributeN .../> self-closing elements
    xml = xml.replace(/\s*<attributeN\b[^>]*\/>/g, '');

    // Step 5: Remove existing hanaAttributeMapping type="02" block — only when rebuilding
    // with new attributes. When removing all attributes (empty list), SAP cleans up
    // hanaAttributeMapping type="02" automatically on activation.
    if (attrXmlParts.length > 0) {
      xml = xml.replace(/\s*<hanaAttributeMapping type="02">[\s\S]*?<\/hanaAttributeMapping>/g, '');
    }

    // Step 6: Insert new attributeN elements before <runtimeProperties
    if (attrXmlParts.length > 0) {
      const attrBlock = attrXmlParts.join('\n') + '\n';
      xml = xml.replace(/(<runtimeProperties)/, attrBlock + '$1');
    }

    // Step 7: Insert hanaAttributeMapping type="02" before type="03" if attributes present
    if (sourceFieldParts.length > 0) {
      const hanaMappingBlock =
        `<hanaAttributeMapping type="02">\n` +
        sourceFieldParts.join('\n') + '\n' +
        `</hanaAttributeMapping>\n`;
      xml = xml.replace('<hanaAttributeMapping type="03">', hanaMappingBlock + '<hanaAttributeMapping type="03">');
    }

    // Patch description if provided
    if (args.description) {
      const desc = args.description;
      xml = xml.replace(/<longDescription>[^<]*<\/longDescription>/, `<longDescription>${desc}</longDescription>`);
      xml = xml.replace(/<shortDescription>[^<]*<\/shortDescription>/, `<shortDescription>${desc}</shortDescription>`);
      xml = xml.replace(/(<texts\b[^/]*?)longText="[^"]*"/, `$1longText="${desc}"`);
      xml = xml.replace(/(<texts\b[^/]*?)shortText="[^"]*"/, `$1shortText="${desc}"`);
      xml = xml.replace(/\badtcore:description="[^"]*"/, `adtcore:description="${desc}"`);
    }

    // Step 8: PUT full XML — same fresh session as GET
    await freshClient.put('iobj', nameLower, lockHandle, xml, timestamp, args.transport);

    // Step 9: Activate — another fresh session (mirrors TRFN pattern)
    const activationClient = createClientFromEnv();
    await activationClient.activate('iobj', nameLower, lockHandle);
  } finally {
    // Unlock with the original lock-session client
    await client.unlock('iobj', nameLower).catch(() => undefined);
  }

  return JSON.stringify({
    success: true,
    name: nameUpper,
    attributeCount: attributes.length,
    attributes: attributes.map((a) => ({ name: a.name.toUpperCase(), type: a.type })),
    message: `InfoObject '${nameUpper}' updated and activated with ${attributes.length} attribute(s).`,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * bw_get_infoobject — read an InfoObject definition (inactive version).
 * Returns raw XML + object status from response headers.
 */
export async function bwGetInfoObject(
  client: BwClient,
  infoObjectName: string
): Promise<string> {
  const accept = MEDIA_TYPES['iobj'];
  const path = `/sap/bw/modeling/iobj/${infoObjectName.toLowerCase()}/m`;
  const result = await freshRead(path, accept);
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';
  return `InfoObject: ${infoObjectName.toUpperCase()}\nStatus: ${status}\n\n${result.body}`;
}
