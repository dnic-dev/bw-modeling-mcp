import { BwClient, MEDIA_TYPES } from '../bw-client.js';
import { stripInfoAreaSentinel } from '../xml.js';

interface OpenHubField {
  name: string;
  label: string;
  infoObjectName?: string;
  typeName: string;
  length?: string;
  precision?: string;
  scale?: string;
  conversionRoutine?: string;
  compoundInfoObjects: string[];
  fieldName?: string;
  key: boolean;
}

interface FileProperties {
  fileName: string;
  separator: string;
  fileType: string;
  isFileOnAppserver: boolean;
  serverName: string;
  isLogicalFileNameSet: boolean;
  logicalFileName: string;
  targetCodePage: string;
  targetCodePageDescr: string;
}

interface OpenHubInfo {
  name: string;
  description: string;
  status: string;
  destinationType: string;
  sourceTlogo: string;
  sourceObjnm: string;
  dbTable: string;
  infoArea: string;
  package: string;
  fields: OpenHubField[];
  fileProperties?: FileProperties;
}

function attr(tag: string, attrName: string): string {
  const m = tag.match(new RegExp(`\\b${attrName}="([^"]*)"`));
  return m ? m[1] : '';
}

function parseOpenHubXml(xml: string, status: string): OpenHubInfo {
  // Root element attributes
  const rootMatch = xml.match(/<dest:destination([^>]*)>/);
  if (!rootMatch) {
    throw new Error('Unexpected XML structure: <dest:destination> root element not found. Cannot parse Open Hub Destination.');
  }
  const rootAttrs = rootMatch[1];
  const name = attr(rootAttrs, 'name');
  const destinationType = attr(rootAttrs, 'destinationType');
  const sourceTlogo = attr(rootAttrs, 'sourceTlogo');
  const sourceObjnm = attr(rootAttrs, 'sourceObjnm');
  const dbTable = attr(rootAttrs, 'dbTable');

  // Description from <endUserTexts label="..."> directly under root (first occurrence)
  const descMatch = xml.match(/<endUserTexts\b[^>]*\blabel="([^"]*)"/);
  const description = descMatch ? descMatch[1] : '';

  // tlogoProperties
  const tlMatch = xml.match(/<tlogoProperties([^>]*)>/);
  const tlAttrs = tlMatch?.[1] ?? '';
  const tlogoPkg = xml.match(/<adtcore:packageRef\b[^>]*\bname="([^"]*)"/)?.[1] ?? '';
  const infoArea = stripInfoAreaSentinel(xml.match(/<infoArea[^>]*>([^<]+)<\/infoArea>/)?.[1]?.trim() ?? '');

  // Key elements — collect the name tokens from #///<name>
  const keyNames = new Set<string>();
  const keyRegex = /<keyElement>[^<]*#\/\/\/([^<]+)<\/keyElement>/g;
  let km: RegExpExecArray | null;
  while ((km = keyRegex.exec(xml)) !== null) {
    keyNames.add(km[1]);
  }

  // Field elements
  const fields: OpenHubField[] = [];
  const elementRegex = /<element\b([^>]*)>([\s\S]*?)<\/element>/g;
  let em: RegExpExecArray | null;
  while ((em = elementRegex.exec(xml)) !== null) {
    const elAttrs = em[1];
    const elBody = em[2];

    const fieldName = attr(elAttrs, 'name');
    const infoObjectName = attr(elAttrs, 'infoObjectName') || undefined;
    const conversionRoutine = attr(elAttrs, 'conversionRoutine') || undefined;

    // Label from first <endUserTexts> inside this element
    const labelMatch = elBody.match(/<endUserTexts\b[^>]*\blabel="([^"]*)"/);
    const label = labelMatch ? labelMatch[1] : '';

    // inlineType
    const inlineMatch = elBody.match(/<inlineType\b([^>]*)\/?>/);
    const inlineAttrs = inlineMatch?.[1] ?? '';
    const typeName = attr(inlineAttrs, 'name');
    const length = attr(inlineAttrs, 'length') || undefined;
    const precision = attr(inlineAttrs, 'precision') || undefined;
    const scale = attr(inlineAttrs, 'scale') || undefined;

    // consumptionViewProperties fieldName (InfoObject-based fields)
    const cvpMatch = elBody.match(/<consumptionViewProperties\b([^>]*)/);
    const cvpFieldName = cvpMatch ? (attr(cvpMatch[1], 'fieldName') || undefined) : undefined;

    // Compounding
    const compoundInfoObjects: string[] = [];
    const compRegex = /<compoundInfoObject>([^<]+)<\/compoundInfoObject>/g;
    let cm: RegExpExecArray | null;
    while ((cm = compRegex.exec(elBody)) !== null) {
      // Value is "#///<name>" — strip prefix
      const compValue = cm[1].trim();
      const compName = compValue.startsWith('#///') ? compValue.slice(4) : compValue;
      compoundInfoObjects.push(compName);
    }

    // Key flag: field name appears in keyNames
    const key = keyNames.has(fieldName);

    fields.push({
      name: fieldName,
      label,
      infoObjectName,
      typeName,
      length,
      precision,
      scale,
      conversionRoutine,
      compoundInfoObjects,
      fieldName: cvpFieldName,
      key,
    });
  }

  // fileProperties (optional — only for destinationType FILE)
  let fileProperties: FileProperties | undefined;
  const fpMatch = xml.match(/<fileProperties\b([^>]*)\/?>/);
  if (fpMatch) {
    const fp = fpMatch[1];
    fileProperties = {
      fileName: attr(fp, 'fileName'),
      separator: attr(fp, 'separator'),
      fileType: attr(fp, 'fileType'),
      isFileOnAppserver: attr(fp, 'isFileOnAppserver') === 'true',
      serverName: attr(fp, 'serverName'),
      isLogicalFileNameSet: attr(fp, 'isLogicalFileNameSet') === 'true',
      logicalFileName: attr(fp, 'logicalFileName'),
      targetCodePage: attr(fp, 'targetCodePage'),
      targetCodePageDescr: attr(fp, 'targetCodePageDescr'),
    };
  }

  return {
    name,
    description,
    status,
    destinationType,
    sourceTlogo,
    sourceObjnm,
    dbTable,
    infoArea,
    package: tlogoPkg,
    fields,
    fileProperties,
  };
}

export async function bwGetOpenHub(client: BwClient, openHubName: string): Promise<string> {
  const path = `/sap/bw/modeling/dest/${openHubName.toLowerCase()}/m`;
  const result = await client.get(path, MEDIA_TYPES['dest']);
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';

  const info = parseOpenHubXml(result.body, status);

  const lines: string[] = [
    `Open Hub Destination: ${info.name}`,
    `Status:              ${info.status}`,
    `Description:         ${info.description}`,
    `Destination Type:    ${info.destinationType}`,
    '',
    `Source:   ${info.sourceTlogo} ${info.sourceObjnm}`,
    `DB Table: ${info.dbTable}`,
    `InfoArea: ${info.infoArea}`,
    `Package:  ${info.package}`,
    '',
    `── Fields (${info.fields.length}) ──`,
  ];

  for (const f of info.fields) {
    const keyMark = f.key ? '[KEY] ' : '      ';
    let typeInfo = f.typeName;
    if (f.precision !== undefined && f.scale !== undefined) {
      typeInfo += `(${f.precision},${f.scale})`;
    } else if (f.precision !== undefined) {
      typeInfo += `(${f.precision})`;
    } else if (f.length !== undefined) {
      typeInfo += `(${f.length})`;
    }
    let line = `  ${keyMark}${f.name}  ${typeInfo}`;
    if (f.label) line += `  "${f.label}"`;
    if (f.infoObjectName) line += `  [IOBJ: ${f.infoObjectName}]`;
    if (f.conversionRoutine) line += `  [conv: ${f.conversionRoutine}]`;
    if (f.fieldName && f.fieldName !== f.name) line += `  [col: ${f.fieldName}]`;
    lines.push(line);
    if (f.compoundInfoObjects.length > 0) {
      lines.push(`           Compounding: ${f.compoundInfoObjects.join(', ')}`);
    }
  }

  if (info.fileProperties) {
    const fp = info.fileProperties;
    lines.push(
      '',
      `── File Properties ──`,
      `  File name:      ${fp.fileName}`,
      `  Logical file:   ${fp.logicalFileName}`,
      `  Separator:      ${fp.separator}`,
      `  File type:      ${fp.fileType}`,
      `  App server:     ${fp.isFileOnAppserver ? `yes (${fp.serverName})` : 'no'}`,
      `  Target codepage: ${fp.targetCodePage} — ${fp.targetCodePageDescr}`,
    );
  }

  lines.push('', `── Raw XML ──`, result.body);

  return lines.join('\n');
}
