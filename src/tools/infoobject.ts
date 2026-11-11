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

/** What the editors need to know about an InfoObject before they use it as a field or an attribute. */
export interface InfoObjectFacts {
  name: string;
  /** CHA, KYF, TIM, UNI or XXL. */
  objectType: string;
  /** Compounding parents of the InfoObject itself, in compounding order. */
  compoundParents: string[];
  compounded: boolean;
  attributeOnly: boolean;
  highCardinality: boolean;
  /** Unit InfoObject of a key figure that takes its unit or currency per record. */
  unitInfoObject?: string;
  /** InfoObject this one references, if any; its attributes are then inherited and fixed. */
  referencedInfoObject?: string;
  xml: string;
}

export function parseInfoObjectFacts(name: string, xml: string): InfoObjectFacts {
  const root = xml.match(/<\w+:infoObject\b[^>]*>/)?.[0] ?? '';
  // An attribute carries the compounding parents of its own InfoObject; only the ones
  // outside the attribute elements belong to this InfoObject.
  const own = xml.replace(/<attributeN\b[^>]*[^/]>[\s\S]*?<\/attributeN>/g, '');
  const compoundParents = [...own.matchAll(/<compoundParent\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1].toUpperCase());
  return {
    name: name.toUpperCase(),
    objectType: xml.match(/<infoObjectType>([^<]+)<\/infoObjectType>/)?.[1] ?? 'CHA',
    compoundParents,
    compounded: compoundParents.length > 0,
    attributeOnly: /\battributeOnly="true"/.test(root),
    highCardinality: /<highCardinality>true<\/highCardinality>/.test(xml),
    unitInfoObject: xml.match(/<unitCurrencyInfoObjectRef\b[^>]*\bname="([^"]+)"/)?.[1]?.toUpperCase(),
    referencedInfoObject: xml.match(/<referencedInfoObject\b[^>]*\bname="([^"]+)"/)?.[1]?.toUpperCase(),
    xml,
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
  with_master_data?: boolean;
  with_texts?: boolean;
  short_text?: boolean;
  medium_text?: boolean;
  long_text?: boolean;
  extra_long_text?: boolean;
  texts_language_dependent?: boolean;
  texts_time_dependent?: boolean;
  with_hierarchies?: boolean;
  hierarchy_version_dependent?: boolean;
  hierarchy_time_dependency?: 'none' | 'entire_hierarchy' | 'structure';
  hierarchy_intervals?: boolean;
  hierarchy_reverse_sign?: boolean;
  transport?: string;
}

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

/** Value of an attribute on the opening tag of the first element of that name. */
function openTagAttr(xml: string, element: string, attr: string): string | undefined {
  const open = xml.match(new RegExp(`<${element}\\b[^>]*>`))?.[0];
  return open?.match(new RegExp(`\\b${attr}="([^"]*)"`))?.[1];
}

/** Set attributes on the opening tag of the first element of that name; the rest of it stays. */
export function patchOpenTag(xml: string, element: string, attrs: Record<string, string | undefined>): string {
  const re = new RegExp(`<${element}\\b[^>]*>`);
  const open = xml.match(re)?.[0];
  if (!open) return xml;
  let patched = open;
  for (const [attr, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    const existing = new RegExp(`\\b${attr}="[^"]*"`);
    patched = existing.test(patched)
      ? patched.replace(existing, `${attr}="${value}"`)
      : patched.replace(/\s*(\/?>)$/, ` ${attr}="${value}"$1`);
  }
  return xml.replace(open, patched);
}

const HIERARCHY_TIME_DEPENDENCY: Record<string, string> = {
  none: 'NONE',
  entire_hierarchy: 'TIME_DEPENDENT',
  structure: 'TIME_DEPENDENT_STRUCTURE',
};

/**
 * Master data, text and hierarchy properties of a characteristic, with the rules of the
 * modeling tools: switching texts on selects the short text when no text length is chosen,
 * the extra long text goes with the long text, a hierarchy that is not time-dependent has
 * no temporal join.
 */
export function applyCharacteristicProperties(xml: string, args: UpdateInfoObjectArgs): { xml: string; notes: string[] } {
  const notes: string[] = [];
  const bool = (v: boolean | undefined) => (v === undefined ? undefined : String(v));
  const flag = (element: string, attr: string) => openTagAttr(xml, element, attr) === 'true';

  if (args.with_master_data !== undefined) {
    xml = patchOpenTag(xml, 'masterDataProperties', { withMasterData: String(args.with_master_data) });
  }

  const textArgs = [args.with_texts, args.short_text, args.medium_text, args.long_text, args.extra_long_text,
    args.texts_language_dependent, args.texts_time_dependent];
  if (textArgs.some((v) => v !== undefined)) {
    const withTexts = args.with_texts ?? flag('textProperties', 'withTexts');
    const lengths = {
      shortTextAvailable: args.short_text ?? flag('textProperties', 'shortTextAvailable'),
      mediumTextAvailable: args.medium_text ?? flag('textProperties', 'mediumTextAvailable'),
      longTextAvailable: args.long_text ?? flag('textProperties', 'longTextAvailable'),
    };
    let extraLong = args.extra_long_text ?? flag('textProperties', 'longTextXLAvailable');
    if (extraLong && !lengths.longTextAvailable) {
      if (args.extra_long_text) {
        throw new Error('extra_long_text needs the long text: pass long_text true as well.');
      }
      extraLong = false;
      notes.push('The extra long text was switched off with the long text.');
    }
    const anyLength = lengths.shortTextAvailable || lengths.mediumTextAvailable || lengths.longTextAvailable;
    if (!withTexts && [args.short_text, args.medium_text, args.long_text, args.extra_long_text,
      args.texts_language_dependent, args.texts_time_dependent].some((v) => v === true)) {
      throw new Error('The text settings need texts: pass with_texts true as well.');
    }
    if (withTexts && !anyLength) {
      if ([args.short_text, args.medium_text, args.long_text].some((v) => v === false) && args.with_texts !== true) {
        throw new Error('A characteristic with texts needs at least one text length (short_text, medium_text or long_text).');
      }
      lengths.shortTextAvailable = true;
      notes.push('The short text was selected, since a characteristic with texts needs a text length.');
    }
    xml = patchOpenTag(xml, 'textProperties', {
      withTexts: String(withTexts),
      shortTextAvailable: String(withTexts && lengths.shortTextAvailable),
      mediumTextAvailable: String(withTexts && lengths.mediumTextAvailable),
      longTextAvailable: String(withTexts && lengths.longTextAvailable),
      longTextXLAvailable: String(withTexts && extraLong),
      languageDependentTextAvailable: withTexts ? bool(args.texts_language_dependent) : 'false',
      timeDependentTextAvailable: withTexts ? bool(args.texts_time_dependent) : 'false',
    });
  }

  const hierarchyArgs = [args.with_hierarchies, args.hierarchy_version_dependent, args.hierarchy_time_dependency,
    args.hierarchy_intervals, args.hierarchy_reverse_sign];
  if (hierarchyArgs.some((v) => v !== undefined)) {
    const withHierarchies = args.with_hierarchies ?? flag('hierarchyProperties', 'withHierarchies');
    if (!withHierarchies && (args.hierarchy_version_dependent || args.hierarchy_intervals || args.hierarchy_reverse_sign ||
      (args.hierarchy_time_dependency !== undefined && args.hierarchy_time_dependency !== 'none'))) {
      throw new Error('The hierarchy settings need hierarchies: pass with_hierarchies true as well.');
    }
    const timeDependency = args.hierarchy_time_dependency !== undefined
      ? HIERARCHY_TIME_DEPENDENCY[args.hierarchy_time_dependency]
      : undefined;
    const structure = (timeDependency ?? openTagAttr(xml, 'hierarchyProperties', 'timeDependency')) === 'TIME_DEPENDENT_STRUCTURE';
    xml = patchOpenTag(xml, 'hierarchyProperties', {
      withHierarchies: String(withHierarchies),
      versionDependent: withHierarchies ? bool(args.hierarchy_version_dependent) : 'false',
      timeDependency: withHierarchies ? timeDependency : 'NONE',
      invervalsPermitted: withHierarchies ? bool(args.hierarchy_intervals) : 'false',
      reverseSignForNodes: withHierarchies ? bool(args.hierarchy_reverse_sign) : 'false',
      // The temporal join exists for a time-dependent structure only.
      temporalHierarchyJoin: !withHierarchies || !structure
        ? (openTagAttr(xml, 'hierarchyProperties', 'temporalHierarchyJoin') !== undefined ? 'false' : undefined)
        : undefined,
    });
  }
  return { xml, notes };
}

/**
 * One attribute element, self-closing or with child elements. The attribute part must not run
 * over the slash of a self-closing tag, or that element swallows everything up to the closing
 * tag of the next attribute that has children.
 */
const ATTRIBUTE_ELEMENT = /<attributeN\b(?:[^>/]|\/(?!>))*(?:\/>|>[\s\S]*?<\/attributeN>)/g;

interface ActivationOutcome {
  ok: boolean;
  messages: string[];
}

/** Activate and say what the server said: an activation that fails returns a feed, not an HTTP error. */
async function activateInfoObject(nameLower: string, lockHandle: string): Promise<ActivationOutcome> {
  const feed = await createClientFromEnv().activate('iobj', nameLower, lockHandle);
  const decode = (s: string) =>
    s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const entries = [...feed.matchAll(/<atom:entry>([\s\S]*?)<\/atom:entry>/g)].map((m) => ({
    error: /messageType=["']Error["']/.test(m[1]),
    text: decode(m[1].match(/<atom:title>([^<]*)<\/atom:title>/)?.[1] ?? ''),
  }));
  const failed = entries.some((e) => e.error) || /messageType=["']Error["']/.test(feed);
  return {
    ok: !failed,
    messages: [...new Set((failed ? entries.filter((e) => e.error) : entries).map((e) => e.text).filter(Boolean))],
  };
}

function notActivated(nameUpper: string, outcome: ActivationOutcome): string {
  return JSON.stringify({
    success: false,
    name: nameUpper,
    saved: true,
    activated: false,
    messages: outcome.messages,
    message:
      `InfoObject '${nameUpper}' was saved but not activated: ${outcome.messages.join(' ') || 'the activation reported an error.'} ` +
      'The active version is unchanged; the inactive version holds the change. Correct it with another call.',
  });
}

/**
 * bw_update_infoobject — change a characteristic (attributes, master data, texts, hierarchies,
 * description, lower case) or a key figure (unit, currency, description), then activate.
 *
 * Flow: lock → GET /m → apply → PUT → activate → unlock (in finally). The activation result is
 * read: a refused activation leaves the change in the inactive version and is reported as such.
 *
 * Attributes follow the modeling tools:
 * - an attribute that stays with the same type is kept as the server serves it; a new one, or
 *   one whose type changes, is written as a new attribute and the server derives the rest;
 * - the InfoObject type of the attribute comes from the attribute InfoObject (a key figure, a
 *   unit or a time characteristic can be a display attribute);
 * - a navigation attribute must be a characteristic or time characteristic that is not
 *   attribute-only;
 * - the compounding parents of an attribute and the unit InfoObject of a key figure attribute
 *   come along as display attributes;
 * - attributes need master data, which is switched on with the first attribute.
 */
export async function bwUpdateInfoObject(
  client: BwClient,
  args: UpdateInfoObjectArgs
): Promise<string> {
  const nameLower = args.name.toLowerCase();
  const nameUpper = args.name.toUpperCase();
  // Omitting attributes leaves the existing list untouched — otherwise a change to any
  // other property (description, lower_case) would silently drop every attribute.
  const replaceAttributes = args.attributes !== undefined;
  const requested = (args.attributes ?? []).map((a) => ({ ...a, name: a.name.trim().toUpperCase() }));
  const characteristicOnly: Array<[keyof UpdateInfoObjectArgs, string]> = [
    ['lower_case', 'lower_case'], ['attributes', 'attributes'], ['with_master_data', 'with_master_data'],
    ['with_texts', 'with_texts'], ['short_text', 'short_text'], ['medium_text', 'medium_text'], ['long_text', 'long_text'],
    ['extra_long_text', 'extra_long_text'], ['texts_language_dependent', 'texts_language_dependent'],
    ['texts_time_dependent', 'texts_time_dependent'], ['with_hierarchies', 'with_hierarchies'],
    ['hierarchy_version_dependent', 'hierarchy_version_dependent'], ['hierarchy_time_dependency', 'hierarchy_time_dependency'],
    ['hierarchy_intervals', 'hierarchy_intervals'], ['hierarchy_reverse_sign', 'hierarchy_reverse_sign'],
  ];

  if (replaceAttributes) {
    const seen = new Set<string>();
    for (const attr of requested) {
      if (attr.name === nameUpper) throw new Error(`InfoObject '${nameUpper}' cannot be its own attribute.`);
      if (seen.has(attr.name)) throw new Error(`Attribute ${attr.name} is listed twice.`);
      seen.add(attr.name);
    }
  }

  // Step 1: Lock with the original client (holds the lock session)
  const lockHandle = await client.lock('iobj', nameLower, undefined, 'stateful_enqueue');
  const notes: string[] = [];
  const addedDependencies: Array<{ attribute: string; needed_by: string; as: string }> = [];
  let attributes: AttributeDef[] = requested;

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
      const given = characteristicOnly.filter(([key]) => args[key] !== undefined).map(([, param]) => param);
      if (given.length > 0) {
        throw new Error(`InfoObject '${nameUpper}' is a Key Figure — ${given.join(', ')} appl${given.length === 1 ? 'ies' : 'y'} to Characteristics (CHA) only.`);
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
      const outcome = await activateInfoObject(nameLower, lockHandle);
      if (!outcome.ok) return notActivated(nameUpper, outcome);
      return JSON.stringify({
        success: true,
        name: nameUpper,
        message: `InfoObject '${nameUpper}' (KYF) updated and activated.`,
      });
    }

    const own = parseInfoObjectFacts(nameUpper, xml);
    // The server serves a compounded attribute with its compounding parents as child elements.
    // Those are derived and are not accepted back, so an attribute is kept as its opening tag
    // only; the parents are remembered for the dependency rules below.
    const existingAttributes = new Map<string, string>();
    const existingParents = new Map<string, string[]>();
    for (const m of xml.matchAll(ATTRIBUTE_ELEMENT)) {
      const open = m[0].match(/^<attributeN\b[^>]*>/)?.[0] ?? m[0];
      const name = open.match(/\bname="([^"]+)"/)?.[1] ?? '';
      existingAttributes.set(name, open.endsWith('/>') ? open : open.replace(/>$/, '/>'));
      existingParents.set(name, [...m[0].matchAll(/<compoundParent\b[^>]*\bname="([^"]+)"/g)].map((p) => p[1].toUpperCase()));
    }

    // Step 3: Master data, texts, hierarchies
    const withMasterDataNow = openTagAttr(xml, 'masterDataProperties', 'withMasterData') === 'true';
    if (args.with_master_data === false) {
      const remaining = replaceAttributes ? requested.length : existingAttributes.size;
      if (remaining > 0) {
        throw new Error(
          `InfoObject '${nameUpper}' has ${remaining} attribute(s), which need master data. ` +
          'Pass attributes: [] in the same call to remove them with the master data.',
        );
      }
    }
    const props = applyCharacteristicProperties(xml, args);
    xml = props.xml;
    notes.push(...props.notes);

    // Step 4: Build the attribute elements.
    const attrXmlParts: string[] = [];
    if (replaceAttributes) {
      const changesList =
        requested.length !== existingAttributes.size || requested.some((a) => !existingAttributes.has(a.name));
      if (own.referencedInfoObject && changesList) {
        throw new Error(
          `InfoObject '${nameUpper}' references ${own.referencedInfoObject} and takes its attributes from there; ` +
          'attributes cannot be added or removed here. Change them on the referenced InfoObject.',
        );
      }

      // The modeling tools bring along what an attribute cannot stand without.
      const facts = new Map<string, InfoObjectFacts>();
      const readFacts = async (name: string): Promise<InfoObjectFacts> => {
        let f = facts.get(name);
        if (!f) {
          const got = await freshClient.get(`/sap/bw/modeling/iobj/${bwSeg(name.toLowerCase())}/a`, MEDIA_TYPES['iobj']);
          f = parseInfoObjectFacts(name, got.body);
          facts.set(name, f);
        }
        return f;
      };
      const listed = new Set(requested.map((a) => a.name));
      const complete: AttributeDef[] = [];
      const parentsOf = async (name: string): Promise<string[]> =>
        existingParents.get(name) ?? (await readFacts(name)).compoundParents;
      for (const attr of requested) {
        const dependencies: Array<[string, string]> =
          (await parentsOf(attr.name)).map((p) => [p, 'compounding parent'] as [string, string]);
        if (!existingAttributes.has(attr.name)) {
          const f = await readFacts(attr.name);
          if (f.objectType === 'KYF' && f.unitInfoObject) dependencies.push([f.unitInfoObject, 'unit or currency']);
        }
        for (const [dependency, as] of dependencies) {
          if (listed.has(dependency) || dependency === nameUpper) continue;
          // The compounding parent of a navigation attribute has to navigate as well.
          complete.push({ name: dependency, type: as === 'compounding parent' && attr.type === 'NAV' ? 'NAV' : 'DIS' });
          listed.add(dependency);
          addedDependencies.push({ attribute: dependency, needed_by: attr.name, as });
        }
        complete.push(attr);
      }
      attributes = complete;
      for (const attr of attributes.filter((a) => a.type === 'NAV')) {
        const displayParents = (await parentsOf(attr.name)).filter((p) =>
          p !== nameUpper && attributes.find((a) => a.name === p)?.type !== 'NAV');
        if (displayParents.length > 0) {
          throw new Error(
            `${attr.name} is compounded to ${displayParents.join(', ')}: a navigation attribute needs its compounding ` +
            `parent as navigation attribute too. List ${displayParents.join(', ')} with type "NAV" as well.`,
          );
        }
      }

      for (const attr of attributes) {
        const attrLower = attr.name.toLowerCase();
        const existing = existingAttributes.get(attr.name);
        const existingType = existing?.match(/\btype="([^"]+)"/)?.[1] ?? (existing ? 'DIS' : undefined);

        if (attr.type === 'NAV' && existingType !== 'NAV') {
          const f = await readFacts(attr.name);
          if (f.objectType !== 'CHA' && f.objectType !== 'TIM') {
            throw new Error(
              `${attr.name} cannot be a navigation attribute: it is a ${f.objectType} InfoObject, and only ` +
              'characteristics and time characteristics navigate. Use type "DIS".',
            );
          }
          if (f.attributeOnly) {
            throw new Error(
              `${attr.name} cannot be a navigation attribute: the InfoObject is defined as attribute only. Use type "DIS".`,
            );
          }
        }

        const overridden =
          attr.displayInQuery !== undefined ||
          attr.useTextOfOriginalCharacteristic !== undefined ||
          attr.timeDependent !== undefined;
        if (existing && existingType === attr.type && !overridden) {
          attrXmlParts.push(existing.replace(/\bref="[^"]*"/, `ref="${attr.name}.iobj#//"`));
          continue;
        }
        if (existing && existingType === attr.type) {
          // Same attribute, same type: only the properties named change.
          let patched = existing.replace(/\bref="[^"]*"/, `ref="${attr.name}.iobj#//"`);
          const set = (key: string, value: boolean | undefined) => {
            if (value === undefined) return;
            patched = new RegExp(`\\b${key}="[^"]*"`).test(patched)
              ? patched.replace(new RegExp(`\\b${key}="[^"]*"`), `${key}="${value}"`)
              : patched.replace(/^<attributeN\b/, `<attributeN ${key}="${value}"`);
          };
          set('timeDependent', attr.timeDependent);
          set('displayInQuery', attr.displayInQuery);
          if (attr.type === 'NAV') set('useTextOfOriginalCharacteristic', attr.useTextOfOriginalCharacteristic);
          attrXmlParts.push(patched);
          continue;
        }

        const f = await readFacts(attr.name);
        const propsOfAttr = parseInfoObjectProps(f.xml);
        const esc = (s: string) => s.replace(/"/g, '&quot;');
        const description = f.xml.match(/<longDescription>([^<]+)<\/longDescription>/)?.[1] ?? propsOfAttr.label;
        const lengthAttr = /<length>[^<]+<\/length>/.test(f.xml) ? ` length="${propsOfAttr.length}"` : '';
        attrXmlParts.push(
          `<attributeN` +
          ` description="${esc(description)}"` +
          ` infoObjectType="${f.objectType}"` +
          ` name="${attr.name}"` +
          ` ref="../../${attrLower}/a/model.iobj#//"` +
          ` shortDescription="${esc(propsOfAttr.label)}"` +
          ` dataType="${propsOfAttr.dataType}"` +
          ` displayInQuery="${attr.displayInQuery ?? true}"` +
          ` f4HelpOrder="0"` +
          ` hasAttributes="false"` +
          lengthAttr +
          ` partOfIndex="false"` +
          ` sidKeyFigure="false"` +
          (attr.timeDependent ? ` timeDependent="true"` : '') +
          ` type="${attr.type}"` +
          ` useTextOfOriginalCharacteristic="${attr.useTextOfOriginalCharacteristic ?? true}"/>`
        );
      }

      if (attributes.length > 0 && args.with_master_data === undefined && !withMasterDataNow) {
        xml = patchOpenTag(xml, 'masterDataProperties', { withMasterData: 'true' });
        notes.push('Master data was switched on, since attributes need it.');
      }

      // Step 5: Remove all existing attribute elements
      xml = xml.replace(new RegExp(`\\s*${ATTRIBUTE_ELEMENT.source}`, 'g'), '');

      // Step 6: The server keeps one hanaAttributeMapping type="02" block per attribute and
      // adds the blocks of new attributes itself on activation, as BWMT relies on. A single
      // block listing several attributes, as this tool used to write, fails the save; only
      // the blocks of dropped attributes are removed here.
      const kept = new Set(attributes.map((a) => a.name));
      xml = xml.replace(/\s*<hanaAttributeMapping type="02">([\s\S]*?)<\/hanaAttributeMapping>/g, (block, body: string) => {
        const name = body.match(/<sourceField\b[^>]*\bname="([^"]+)"/)?.[1];
        return name && kept.has(name) ? block : '';
      });

      // Step 7: Insert new attributeN elements before <runtimeProperties
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
    const outcome = await activateInfoObject(nameLower, lockHandle);
    if (!outcome.ok) return notActivated(nameUpper, outcome);
  } finally {
    // Unlock with the original lock-session client
    await client.unlock('iobj', nameLower).catch(() => undefined);
  }

  const changes: string[] = [];
  if (replaceAttributes) changes.push(`${attributes.length} attribute(s)`);
  if (args.lower_case !== undefined) changes.push(`lowerCase=${args.lower_case}`);
  if (args.description) changes.push('description');
  if (args.with_master_data !== undefined) changes.push(`master data ${args.with_master_data ? 'on' : 'off'}`);
  if ([args.with_texts, args.short_text, args.medium_text, args.long_text, args.extra_long_text,
    args.texts_language_dependent, args.texts_time_dependent].some((v) => v !== undefined)) changes.push('text properties');
  if ([args.with_hierarchies, args.hierarchy_version_dependent, args.hierarchy_time_dependency,
    args.hierarchy_intervals, args.hierarchy_reverse_sign].some((v) => v !== undefined)) changes.push('hierarchy properties');

  const result: Record<string, unknown> = { success: true, name: nameUpper };
  if (replaceAttributes) {
    result['attributeCount'] = attributes.length;
    result['attributes'] = attributes.map((a) => ({ name: a.name, type: a.type }));
  }
  if (addedDependencies.length > 0) {
    result['added_dependencies'] = addedDependencies;
    notes.push(
      'Also added as attributes: ' +
      addedDependencies.map((d) => `${d.attribute} (${d.as} of ${d.needed_by})`).join(', ') + '.',
    );
  }
  if (args.lower_case !== undefined) result['lowerCase'] = args.lower_case;
  result['message'] =
    `InfoObject '${nameUpper}' updated and activated` +
    (changes.length > 0 ? ` (${changes.join(', ')}).` : '.') +
    (notes.length > 0 ? ` ${notes.join(' ')}` : '');

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
