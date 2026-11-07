import { BwClient, MEDIA_TYPES, createClientFromEnv, freshRead, bwSeg } from '../bw-client.js';
import { resolveLogonUser } from './logon_user.js';
import { cachedPlatform } from '../platform.js';

/**
 * The full characteristic document a classic backend expects in the create POST.
 *
 * BW/4HANA ignores the create body and takes its values from the PUT that follows; a
 * classic release reads the body and refuses a stub. The element order and the empty
 * elements are not decoration — they are the document the resource validates against,
 * taken from an Eclipse BWMT trace of the same operation on 7.5.
 */
function characteristicCreateXml(o: {
  name: string;
  infoArea: string;
  description: string;
  dataType: string;
  length: number;
  conversionRoutine: string;
  withMasterData: boolean;
  withTexts: boolean;
  language: string;
  responsible: string;
}): string {
  const conv = o.conversionRoutine ? ` conversionRoutine="${o.conversionRoutine}"` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<InfoObject:infoObject xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:InfoObject="http://www.sap.com/bw/modeling/BwIobj.ecore" xmlns:adtcore="http://www.sap.com/adt/core" xsi:type="InfoObject:Characteristic" name="${o.name}" shortDescriptionSet="false"${conv} objectSpecificDataType="${o.dataType}">
  <infoObjectType>CHA</infoObjectType>
  <dataElement/>
  <dataType>${o.dataType}</dataType>
  <longDescription>${o.description}</longDescription>
  <shortDescription>${o.description}</shortDescription>
  <tlogoProperties adtcore:language="${o.language}" adtcore:name="${o.name}" adtcore:type="IOBJ" adtcore:masterLanguage="${o.language}" adtcore:responsible="${o.responsible}">
    <infoArea>${o.infoArea}</infoArea>
  </tlogoProperties>
  <referencedInfoObject/>
  <length>${o.length}</length>
  <displayProperties><display>2</display><selection>0</selection></displayProperties>
  <queryFilterValue forQueryDefinition="D"/>
  <baseUnitOfMeasure/>
  <unitsOfMeasureForCharacteristic/>
  <currencyAttribute/>
  <dataStoreObjectForAuthorityCheck/>
  <masterDataProperties withMasterData="${o.withMasterData}"><timeDependentAttributeSIDTable/><attributeSIDTable/><xxlAttributeTable/><masterDataView/><masterDataTable/><timeDependentMasterDataTable/></masterDataProperties>
  <textProperties languageDependentTextAvailable="false" shortTextAvailable="${o.withTexts}" withTexts="${o.withTexts}"><textTable/></textProperties>
  <masterDataAccess readClass="" sapHanaPackage="" sapHanaView=""/>
  <hierarchyProperties/>
  <bexMap><geographicalAttribute/></bexMap>
  <externalSAPHANAView><masterDataView/><infoProviderView/></externalSAPHANAView>
  <runtimeProperties/>
  <sidTable/>
  <masterDataRoutine/>
</InfoObject:infoObject>`;
}

// ── KYF: objectSpecificDataType → keyfigureType / semantics ──────────────────

export const KYF_TYPE_MAP: Record<string, { keyfigureType: string; semantics: string }> = {
  DEC:  { keyfigureType: 'NUM', semantics: 'NUM' },
  CURR: { keyfigureType: 'AMO', semantics: 'AMO' },
  FLTP: { keyfigureType: 'NUM', semantics: 'NUM' },
  QUAN: { keyfigureType: 'QUA', semantics: 'QUA' },
  DATS: { keyfigureType: 'DAT', semantics: 'DAT' },
  INT4: { keyfigureType: 'INT', semantics: 'INT4' },
  INT8: { keyfigureType: 'INT', semantics: 'INT8' },
  TIMS: { keyfigureType: 'NUM', semantics: 'NUM' },
};

// ── CHA: lower case flag (RSDCHABAS-LOWERCASE) ───────────────────────────────

/**
 * Set withLowerCaseLetters on the Characteristic root element.
 *
 * The attribute is absent from the XML of a characteristic that does not allow lower
 * case, so it has to be added rather than replaced in that case.
 */
export function setLowerCase(xml: string, lowerCase: boolean): string {
  if (/\bwithLowerCaseLetters="/.test(xml)) {
    return xml.replace(/\bwithLowerCaseLetters="[^"]*"/, `withLowerCaseLetters="${lowerCase}"`);
  }
  if (!lowerCase) return xml;
  return xml.replace(/(<\w+:infoObject\b)/, `$1 withLowerCaseLetters="true"`);
}

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
  lower_case?: boolean;
  referenced_infoobject?: string;
  // KYF
  object_specific_data_type?: string;
  aggregation_type?: string;
  fixed_unit?: string;
  fixed_currency?: string;
  unit_currency_infoobject?: string;
  // compound parent InfoObjects — CHA only; order matters (matches BW compound order)
  compound_infoobjects?: string[];
  // common
  package?: string;
  transport?: string;
}

function validateUnitCurrencyArgs(
  args: { fixed_unit?: string; fixed_currency?: string; unit_currency_infoobject?: string },
  isKyf: boolean
): void {
  if (!args.unit_currency_infoobject) return;
  if (!isKyf) {
    throw new Error('unit_currency_infoobject applies to Key Figures (KYF) only.');
  }
  if (args.fixed_unit || args.fixed_currency) {
    throw new Error(
      'unit_currency_infoobject and fixed_unit/fixed_currency exclude each other: a key figure has either ' +
      'a fixed unit/currency or takes it from a unit characteristic.'
    );
  }
}

/**
 * Point a key figure at the unit characteristic that supplies its unit or currency, the way
 * BWMT writes it, and drop any fixed unit or currency — BW accepts only one of the two.
 */
export function setUnitCurrencyReference(xml: string, infoObject: string): string {
  const ref = `<unitCurrencyInfoObjectRef name="${infoObject.toUpperCase()}" infoObjectType="UNI"/>`;
  const out = xml
    .replace(/<fixedUnit>[^<]*<\/fixedUnit>/, '')
    .replace(/<fixedCurrency>[^<]*<\/fixedCurrency>/, '')
    .replace(/<fixedUnit\s*\/>/, '')
    .replace(/<fixedCurrency\s*\/>/, '');
  const pattern = /<unitCurrencyInfoObjectRef\b[^>]*?(?:\/>|>[\s\S]*?<\/unitCurrencyInfoObjectRef>)/;
  if (pattern.test(out)) return out.replace(pattern, ref);
  if (out.includes('<displayProperties')) return out.replace('<displayProperties', `${ref}<displayProperties`);
  throw new Error('Cannot place the unit/currency reference: the key figure XML has no <unitCurrencyInfoObjectRef> or <displayProperties> element.');
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

  if (isobjType === 'KYF' && args.lower_case !== undefined) {
    throw new Error('lower_case applies to Characteristics (CHA) only — remove it for a Key Figure.');
  }
  validateUnitCurrencyArgs(args, isobjType === 'KYF');
  const responsible = await resolveLogonUser(client);

  // Step 1: Lock with CREA headers (stateful_enqueue session)
  const lockHandle = await client.lock('iobj', nameLower, {
    activity_context: 'CREA',
    parent_name: infoArea,
    parent_type: 'AREA',
  }, 'stateful_enqueue');

  // A failed step must not leave the CREA lock behind; on success a characteristic keeps it
  // for bw_activate, as before.
  try {
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
      adtcore:masterLanguage="${language}" adtcore:responsible="${responsible}">
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

      // fixedUnit / fixedCurrency / unit-currency reference: SAP only accepts these via PUT after creation
      if (args.fixed_unit || args.fixed_currency || args.unit_currency_infoobject) {
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
        if (args.unit_currency_infoobject) {
          xml = setUnitCurrencyReference(xml, args.unit_currency_infoobject);
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
      if (args.unit_currency_infoobject) kyfResult['unitCurrencyInfoObject'] = args.unit_currency_infoobject.toUpperCase();
      kyfResult['message'] = `InfoObject '${nameUpper}' created (inactive). Call bw_activate with lock_handle="" to activate.`;

      return JSON.stringify(kyfResult);
    }

    // ── CHA: POST body ignored — GET + PUT required ────────────────────────────

    // Step 2: Create-POST — API ignores body, creates object with defaults
    //
    // Except on a classic release, which reads it: there the minimal body is rejected
    // outright ("the object name must not be empty"), because nothing can be derived from
    // it. The wizard in Eclipse BWMT posts the whole object on 7.5, so this does too — the
    // GET and PUT below still run and apply everything this body does not carry.
    const minimalXml = `<?xml version="1.0" encoding="UTF-8"?><iobj:infoObject xmlns:iobj="http://www.sap.com/bw/modeling/BwIobj.ecore" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="iobj:Characteristic" name="${nameUpper}"/>`;
    const createXml = cachedPlatform()?.platform === 'classic'
      ? characteristicCreateXml({
          name: nameUpper,
          infoArea,
          description: desc,
          dataType: (args.data_type ?? 'CHAR').toUpperCase(),
          length: args.length ?? 10,
          conversionRoutine: args.conversion_routine
            ?? (((args.data_type ?? 'CHAR').toUpperCase() === 'CHAR' || (args.data_type ?? 'CHAR').toUpperCase() === 'NUMC') ? 'ALPHA' : ''),
          withMasterData: args.with_master_data ?? false,
          withTexts: args.with_texts ?? false,
          language: process.env.BW_LANGUAGE ?? 'DE',
          responsible,
        })
      : minimalXml;
    await client.create('iobj', nameLower, lockHandle, createXml, { 'Development-Class': pkg });

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
    const lowerCase = args.lower_case ?? false;

    // Root element attributes
    putXml = putXml.replace(/\bobjectSpecificDataType="[^"]*"/, `objectSpecificDataType="${chaDataType}"`);
    putXml = putXml.replace(/\boutputLength="[^"]*"/, `outputLength="${chaLength}"`);
    if (/\bconversionRoutine="/.test(putXml)) {
      putXml = putXml.replace(/\bconversionRoutine="[^"]*"/, `conversionRoutine="${chaConv}"`);
    } else if (chaConv) {
      // Add conversionRoutine attribute to root element if not present
      putXml = putXml.replace(/(<iobj:infoObject\b)/, `$1 conversionRoutine="${chaConv}"`);
    }
    putXml = setLowerCase(putXml, lowerCase);
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
      lowerCase,
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
  } catch (err) {
    await client.unlock('iobj', nameLower).catch(() => {/* best effort */});
    throw err;
  }
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
  /** Replaces the whole attribute list; [] removes all attributes, undefined keeps them. */
  attributes?: AttributeDef[];
  description?: string;
  lower_case?: boolean;
  fixed_unit?: string;
  fixed_currency?: string;
  unit_currency_infoobject?: string;
  transport?: string;
}

/**
 * bw_update_infoobject — replace the attribute list of a Characteristic InfoObject.
 *
 * Flow:
 * 1. Lock (update — no activity_context)
 * 2. GET /iobj/{name}/m → current XML + timestamp
 * 3. Keep unchanged attributes; for new or retyped ones GET /iobj/{attr}/a → description,
 *    shortDescription, dataType, length
 * 4. Remove all existing <attributeN .../> elements
 * 5. Remove the <hanaAttributeMapping type="02"> blocks of dropped attributes
 * 6. Insert the <attributeN> elements before <runtimeProperties>
 * 8. PUT full XML with timestamp
 * 9. Activate + Unlock (unlock in finally)
 */
/**
 * Set the description in the logon language only. The server serves one <texts> element per
 * maintained language (D, E, …); writing into the first one, as this tool used to, overwrote the
 * text of the original language whenever the logon language was another one (an English text
 * landed in the German entry and the English one stayed empty). The entry of the logon language
 * is changed, or added when the object has none yet; all other languages stay as they are.
 * The logon language comes from the served document (adtcore:language), else BW_LANGUAGE.
 */
export function patchDescriptionInLogonLanguage(xml: string, description: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const desc = esc(description);
  const shortText = esc(description.slice(0, 20));
  const ISO_TO_SAP: Record<string, string> = {
    DE: 'D', EN: 'E', FR: 'F', IT: 'I', ES: 'S', NL: 'N', PT: 'P',
    RU: 'R', JA: 'J', KO: 'K', ZH: '1', PL: 'L', CS: 'C',
  };
  const iso = (xml.match(/\badtcore:language="([^"]+)"/)?.[1] ?? process.env.BW_LANGUAGE ?? 'DE').toUpperCase();
  const lang = ISO_TO_SAP[iso] ?? iso;

  // Top-level descriptions and adtcore:description reflect the logon language.
  xml = xml.replace(/<longDescription>[^<]*<\/longDescription>/, `<longDescription>${desc}</longDescription>`);
  xml = xml.replace(/<shortDescription>[^<]*<\/shortDescription>/, `<shortDescription>${shortText}</shortDescription>`);
  xml = xml.replace(/\badtcore:description="[^"]*"/, `adtcore:description="${desc}"`);

  const entry = new RegExp(`<texts\\b(?=[^>]*\\blanguage="${lang}")[^>]*/>`);
  const newEntry = `<texts language="${lang}" shortText="${shortText}" longText="${desc}"/>`;
  if (entry.test(xml)) {
    xml = xml.replace(entry, newEntry);
  } else {
    const all = [...xml.matchAll(/<texts\b[^>]*\/>/g)];
    if (all.length > 0) {
      const last = all[all.length - 1];
      const at = (last.index ?? 0) + last[0].length;
      xml = xml.slice(0, at) + newEntry + xml.slice(at);
    } else {
      xml = xml.replace(/(<\/shortDescription>)/, `$1${newEntry}`);
    }
  }
  return xml;
}

export async function bwUpdateInfoObject(
  client: BwClient,
  args: UpdateInfoObjectArgs
): Promise<string> {
  const nameLower = args.name.toLowerCase();
  const nameUpper = args.name.toUpperCase();
  // Omitting attributes leaves the existing list untouched — otherwise a change to any
  // other property (description, lower_case) would silently drop every attribute.
  const replaceAttributes = args.attributes !== undefined;
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
    validateUnitCurrencyArgs(args, isKyf);
    if (isKyf) {
      if (args.lower_case !== undefined) {
        throw new Error(`InfoObject '${nameUpper}' is a Key Figure — lower_case applies to Characteristics (CHA) only.`);
      }
      if (args.description) {
        xml = patchDescriptionInLogonLanguage(xml, args.description);
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
      if (args.unit_currency_infoobject) {
        xml = setUnitCurrencyReference(xml, args.unit_currency_infoobject);
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

    // Step 3: Build the attribute elements. An attribute that stays with the same type is kept
    // as the server serves it (BWMT does the same); a new one, or one whose type changes, is
    // written in the form BWMT uses for a new attribute — for NAV too, the server derives the
    // navigation properties itself on activation.
    const existingAttributes = new Map(
      [...xml.matchAll(/<attributeN\b[^>]*\/>/g)].map((m) => [m[0].match(/\bname="([^"]+)"/)?.[1] ?? '', m[0]])
    );
    const attrXmlParts: string[] = [];

    for (const attr of attributes) {
      const attrUpper = attr.name.toUpperCase();
      const attrLower = attr.name.toLowerCase();

      const existing = existingAttributes.get(attrUpper);
      const overridden =
        attr.displayInQuery !== undefined ||
        attr.useTextOfOriginalCharacteristic !== undefined ||
        attr.timeDependent !== undefined;
      if (existing && existing.match(/\btype="([^"]+)"/)?.[1] === attr.type && !overridden) {
        attrXmlParts.push(existing.replace(/\bref="[^"]*"/, `ref="${attrUpper}.iobj#//"`));
        continue;
      }

      const attrGet = await freshClient.get(`/sap/bw/modeling/iobj/${bwSeg(attrLower)}/a`, MEDIA_TYPES['iobj']);
      const attrXml = attrGet.body;
      const props = parseInfoObjectProps(attrXml);
      const longDescMatch = attrXml.match(/<longDescription>([^<]+)<\/longDescription>/);
      const description = longDescMatch?.[1] ?? props.label;
      const shortDescription = props.label;

      const displayInQuery = attr.displayInQuery ?? true;
      const useTextOfOrig = attr.useTextOfOriginalCharacteristic ?? true;
      const timeDependent = attr.type === 'NAV' && (attr.timeDependent ?? false);
      attrXmlParts.push(
        `<attributeN` +
        ` description="${description}"` +
        ` infoObjectType="CHA"` +
        ` name="${attrUpper}"` +
        ` ref="../../${attrLower}/a/model.iobj#//"` +
        ` shortDescription="${shortDescription}"` +
        ` dataType="${props.dataType}"` +
        ` displayInQuery="${displayInQuery}"` +
        ` f4HelpOrder="0"` +
        ` hasAttributes="false"` +
        ` length="${props.length}"` +
        ` partOfIndex="false"` +
        ` sidKeyFigure="false"` +
        (timeDependent ? ` timeDependent="true"` : '') +
        ` type="${attr.type}"` +
        ` useTextOfOriginalCharacteristic="${useTextOfOrig}"/>`
      );
    }

    if (replaceAttributes) {
      // Step 4: Remove all existing <attributeN .../> self-closing elements
      xml = xml.replace(/\s*<attributeN\b[^>]*\/>/g, '');

      // Step 5: The server keeps one hanaAttributeMapping type="02" block per attribute and
      // adds the blocks of new attributes itself on activation, as BWMT relies on. A single
      // block listing several attributes, as this tool used to write, fails the save; only
      // the blocks of dropped attributes are removed here.
      const kept = new Set(attributes.map((a) => a.name.toUpperCase()));
      xml = xml.replace(/\s*<hanaAttributeMapping type="02">([\s\S]*?)<\/hanaAttributeMapping>/g, (block, body: string) => {
        const name = body.match(/<sourceField\b[^>]*\bname="([^"]+)"/)?.[1];
        return name && kept.has(name) ? block : '';
      });

      // Step 6: Insert new attributeN elements before <runtimeProperties
      if (attrXmlParts.length > 0) {
        const attrBlock = attrXmlParts.join('\n') + '\n';
        xml = xml.replace(/(<runtimeProperties)/, attrBlock + '$1');
      }
    }

    if (args.lower_case !== undefined) {
      xml = setLowerCase(xml, args.lower_case);
    }

    // Patch description if provided
    if (args.description) {
      xml = patchDescriptionInLogonLanguage(xml, args.description);
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

  const changes: string[] = [];
  if (replaceAttributes) changes.push(`${attributes.length} attribute(s)`);
  if (args.lower_case !== undefined) changes.push(`lowerCase=${args.lower_case}`);
  if (args.description) changes.push('description');

  const result: Record<string, unknown> = { success: true, name: nameUpper };
  if (replaceAttributes) {
    result['attributeCount'] = attributes.length;
    result['attributes'] = attributes.map((a) => ({ name: a.name.toUpperCase(), type: a.type }));
  }
  if (args.lower_case !== undefined) result['lowerCase'] = args.lower_case;
  result['message'] =
    `InfoObject '${nameUpper}' updated and activated` +
    (changes.length > 0 ? ` (${changes.join(', ')}).` : '.');

  return JSON.stringify(result);
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
  const path = `/sap/bw/modeling/iobj/${bwSeg(infoObjectName)}/m`;
  const result = await freshRead(path, accept);
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';
  return `InfoObject: ${infoObjectName.toUpperCase()}\nStatus: ${status}\n\n${result.body}`;
}
