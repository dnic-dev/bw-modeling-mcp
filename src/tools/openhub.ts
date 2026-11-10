import { BwClient, MEDIA_TYPES, bwSeg, stripInfoAreaSentinel } from '../bw-client.js';

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
  externalFormat: boolean;
  outputLength?: string;
  outputDataType?: string;
}

interface FileProperties {
  fileName: string;
  separator: string;
  fileType: string;
  isFileOnAppserver: boolean;
  serverName: string;
  isLogicalFileNameSet: boolean;
  logicalFileName: string;
  path: string;
  isHdfsFile: boolean;
  httpConnection: string;
  isSapStandardXml: boolean;
  isStandardBinaryXml: boolean;
  targetCodePage: string;
  targetCodePageDescr: string;
}

interface DatabaseProperties {
  writeMode: string;
  useTechnicalKey: boolean;
  connectionType: string;
  dbConnectionName: string;
}

interface OpenHubInfo {
  name: string;
  description: string;
  status: string;
  destinationType: string;
  sourceTlogo: string;
  sourceObjectName: string;
  dbTable: string;
  infoArea: string;
  package: string;
  systemCodePage: string;
  sendNotificationRFC: boolean;
  sendNotificationRFCDest: string;
  dtpExternalProgram: boolean;
  fields: OpenHubField[];
  fileProperties?: FileProperties;
  databaseProperties?: DatabaseProperties;
  thirdPartyProperties: Array<{ name: string; value: string }>;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attr(tag: string, attrName: string): string {
  const m = tag.match(new RegExp(`\\b${attrName}="([^"]*)"`));
  return m ? decodeXmlEntities(m[1]) : '';
}

function parseOpenHubXml(xml: string, status: string): OpenHubInfo {
  const rootMatch = xml.match(/<dest:destination([^>]*)>/);
  if (!rootMatch) {
    throw new Error('Unexpected XML structure: <dest:destination> root element not found. Cannot parse Open Hub Destination.');
  }
  const rootAttrs = rootMatch[1];
  const name = attr(rootAttrs, 'name');
  const destinationType = attr(rootAttrs, 'destinationType');
  const sourceTlogo = attr(rootAttrs, 'sourceTlogo');
  const sourceObjectName = attr(rootAttrs, 'sourceObjectName');
  const dbTable = attr(rootAttrs, 'dbTable');
  const systemCodePage = [attr(rootAttrs, 'systemCodePage'), attr(rootAttrs, 'systemCodePageDescr')].filter(Boolean).join(' ');
  // A classic release sends no object_status header; the status then comes from the body.
  if (status === 'unknown') {
    status = xml.match(/<objectStatus>([^<]*)<\/objectStatus>/)?.[1] ?? status;
  }
  const sendNotificationRFC = attr(rootAttrs, 'sendNotificationRFC') === 'true';
  const sendNotificationRFCDest = attr(rootAttrs, 'sendNotificationRFCDest');
  const dtpExternalProgram = attr(rootAttrs, 'dtpExternalProgram') === 'true';

  const descMatch = xml.match(/<endUserTexts\b[^>]*\blabel="([^"]*)"/);
  const description = descMatch ? decodeXmlEntities(descMatch[1]) : '';

  const tlogoPkg = xml.match(/<adtcore:packageRef\b[^>]*\bname="([^"]*)"/)?.[1] ?? '';
  const infoArea = stripInfoAreaSentinel(xml.match(/<infoArea[^>]*>([^<]+)<\/infoArea>/)?.[1]?.trim() ?? '');

  const keyNames = new Set<string>();
  const keyRegex = /<keyElement>[^<]*#\/\/\/([^<]+)<\/keyElement>/g;
  let km: RegExpExecArray | null;
  while ((km = keyRegex.exec(xml)) !== null) {
    keyNames.add(km[1]);
  }

  const fields: OpenHubField[] = [];
  const elementRegex = /<element\b([^>]*)>([\s\S]*?)<\/element>/g;
  let em: RegExpExecArray | null;
  while ((em = elementRegex.exec(xml)) !== null) {
    const elAttrs = em[1];
    const elBody = em[2];

    const fieldName = attr(elAttrs, 'name');
    const infoObjectName = attr(elAttrs, 'infoObjectName') || undefined;
    const conversionRoutine = attr(elAttrs, 'conversionRoutine') || undefined;

    const labelMatch = elBody.match(/<endUserTexts\b[^>]*\blabel="([^"]*)"/);
    const label = labelMatch ? decodeXmlEntities(labelMatch[1]) : '';

    const inlineMatch = elBody.match(/<inlineType\b([^>]*)\/?>/);
    const inlineAttrs = inlineMatch?.[1] ?? '';
    const typeName = attr(inlineAttrs, 'name');
    const length = attr(inlineAttrs, 'length') || undefined;
    const precision = attr(inlineAttrs, 'precision') || undefined;
    const scale = attr(inlineAttrs, 'scale') || undefined;

    const cvpMatch = elBody.match(/<consumptionViewProperties\b([^>]*)/);
    const cvpFieldName = cvpMatch ? (attr(cvpMatch[1], 'fieldName') || undefined) : undefined;

    const compoundInfoObjects: string[] = [];
    const compRegex = /<compoundInfoObject>([^<]+)<\/compoundInfoObject>/g;
    let cm: RegExpExecArray | null;
    while ((cm = compRegex.exec(elBody)) !== null) {
      const compValue = cm[1].trim();
      compoundInfoObjects.push(compValue.startsWith('#///') ? compValue.slice(4) : compValue);
    }

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
      key: keyNames.has(fieldName),
      externalFormat: attr(elAttrs, 'externalFormat') === 'true',
      outputLength: attr(elAttrs, 'outputLength') || undefined,
      outputDataType: attr(elAttrs, 'outputDataType') || undefined,
    });
  }

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
      path: attr(fp, 'path'),
      isHdfsFile: attr(fp, 'isHdfsFile') === 'true',
      httpConnection: attr(fp, 'httpConnection'),
      isSapStandardXml: attr(fp, 'isSapStandardXml') === 'true',
      isStandardBinaryXml: attr(fp, 'isStandardBinaryXml') === 'true',
      targetCodePage: attr(fp, 'targetCodePage'),
      targetCodePageDescr: attr(fp, 'targetCodePageDescr'),
    };
  }

  let databaseProperties: DatabaseProperties | undefined;
  const dbMatch = xml.match(/<databaseProperties\b([^>]*)\/?>/);
  if (dbMatch) {
    const db = dbMatch[1];
    databaseProperties = {
      writeMode: attr(db, 'writeMode'),
      useTechnicalKey: attr(db, 'useTechnicalKey') === 'true',
      connectionType: attr(db, 'connectionType'),
      dbConnectionName: attr(db, 'dbConnectionName'),
    };
  }

  const thirdPartyProperties: Array<{ name: string; value: string }> = [];
  for (const tp of xml.matchAll(/<thirdPartyProperties\b([^>]*)\/?>/g)) {
    thirdPartyProperties.push({ name: attr(tp[1], 'propertyName'), value: attr(tp[1], 'propertyValue') });
  }

  return {
    name,
    description,
    status,
    destinationType,
    sourceTlogo,
    sourceObjectName,
    dbTable,
    infoArea,
    package: tlogoPkg,
    systemCodePage,
    sendNotificationRFC,
    sendNotificationRFCDest,
    dtpExternalProgram,
    fields,
    fileProperties,
    databaseProperties,
    thirdPartyProperties,
  };
}

const DESTINATION_TYPE_LABELS: Record<string, string> = {
  TAB: 'Database table',
  FILE: 'Flat file',
  TAB3: 'Third-party tool',
};

const FILE_TYPE_LABELS: Record<string, string> = {
  FILE: 'CSV',
  FILE_FIX: 'fixed length (TXT)',
  FILE_XML: 'XML',
};

function formatOpenHub(info: OpenHubInfo, rawXml: string): string {
  const lines: string[] = [
    `Open Hub Destination: ${info.name}`,
    `Status:              ${info.status}`,
    `Description:         ${info.description}`,
    `Destination Type:    ${info.destinationType}${DESTINATION_TYPE_LABELS[info.destinationType] ? ` (${DESTINATION_TYPE_LABELS[info.destinationType]})` : ''}`,
    '',
    `InfoArea: ${info.infoArea || '(none)'}`,
    `Package:  ${info.package}`,
    `DB Table: ${info.dbTable}`,
  ];
  if (info.sourceObjectName) lines.push(`Source:   ${info.sourceTlogo} ${info.sourceObjectName}`);
  if (info.systemCodePage) lines.push(`System code page: ${info.systemCodePage}`);
  if (info.sendNotificationRFC) lines.push(`RFC notification after load: yes (${info.sendNotificationRFCDest || 'no destination'})`);
  if (info.dtpExternalProgram) lines.push(`DTP started by external program: yes`);

  if (info.databaseProperties) {
    const db = info.databaseProperties;
    lines.push(
      '',
      `── Database Properties ──`,
      `  Write mode:      ${db.writeMode}`,
      `  Technical key:   ${db.useTechnicalKey ? 'yes' : 'no (semantic key from the key fields)'}`,
      `  Connection type: ${db.connectionType}${db.dbConnectionName ? ` (${db.dbConnectionName})` : ''}`,
    );
  }

  if (info.fileProperties) {
    const fp = info.fileProperties;
    const location = fp.isHdfsFile
      ? `HDFS (${fp.httpConnection || 'no HTTP connection'})`
      : fp.isFileOnAppserver
        ? `application server${fp.serverName ? ` ${fp.serverName}` : ''}`
        : 'local workstation';
    lines.push(
      '',
      `── File Properties ──`,
      `  File type:      ${fp.fileType}${FILE_TYPE_LABELS[fp.fileType] ? ` (${FILE_TYPE_LABELS[fp.fileType]})` : ''}`,
      `  File name:      ${fp.isLogicalFileNameSet ? `${fp.logicalFileName} (logical file name)` : fp.fileName}`,
      `  Location:       ${location}`,
    );
    if (fp.path) lines.push(`  Directory:      ${fp.path}`);
    if (fp.fileType === 'FILE') lines.push(`  Separator:      ${fp.separator}`);
    if (fp.fileType === 'FILE_XML') {
      lines.push(`  XML flavour:    ${fp.isSapStandardXml ? 'SAP standard XML' : fp.isStandardBinaryXml ? 'SAP binary protocol XML' : 'plain'}`);
    }
    if (fp.targetCodePage) lines.push(`  Target code page: ${fp.targetCodePage} ${fp.targetCodePageDescr}`.trimEnd());
  }

  if (info.thirdPartyProperties.length > 0) {
    lines.push('', `── Third-Party Properties ──`);
    for (const p of info.thirdPartyProperties) lines.push(`  ${p.name}: ${p.value}`);
  }

  lines.push('', `── Fields (${info.fields.length}) ──`);
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
    if (f.externalFormat) line += `  [external: ${f.outputDataType ?? 'CHAR'}(${f.outputLength ?? '?'})]`;
    lines.push(line);
    if (f.compoundInfoObjects.length > 0) {
      lines.push(`           Compounding: ${f.compoundInfoObjects.join(', ')}`);
    }
  }

  lines.push('', `── Raw XML ──`, rawXml);
  return lines.join('\n');
}

export async function bwGetOpenHub(client: BwClient, openHubName: string): Promise<string> {
  const path = `/sap/bw/modeling/dest/${bwSeg(openHubName)}/m`;
  const result = await client.get(path, MEDIA_TYPES['dest']);
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';
  return formatOpenHub(parseOpenHubXml(result.body, status), result.body);
}

// ── Update ───────────────────────────────────────────────────────────────────

export interface OpenHubFieldInput {
  name: string;
  infoObjectName?: string;
  type: string;
  length: number;
  label: string;
  isKey?: boolean;
}

export interface OpenHubUpdateOptions {
  description?: string;
  writeMode?: OpenHubWriteMode;
  useTechnicalKey?: boolean;
  connectionType?: OpenHubConnectionType;
  dbConnectionName?: string;
  fileType?: OpenHubFileType;
  fileName?: string;
  separator?: string;
  fileOnAppServer?: boolean;
  serverName?: string;
  logicalFileName?: string;
  directory?: string;
  keyFields?: string[];
  externalFormatOn?: string[];
  externalFormatOff?: string[];
  sendNotificationRfc?: boolean;
  rfcDestination?: string;
  dtpExternalProgram?: boolean;
  fields?: OpenHubFieldInput[];
  removeFields?: string[];
  transport?: string;
}

/**
 * The output length of a field in external format, as the modeling tools compute it from the
 * inline type when the external format is switched on.
 */
function externalOutputLength(inlineTypeTag: string): number {
  const type = attr(inlineTypeTag, 'name');
  const length = Number(attr(inlineTypeTag, 'length') || 0);
  const precision = Number(attr(inlineTypeTag, 'precision') || 0);
  const scale = Number(attr(inlineTypeTag, 'scale') || 0);
  switch (type) {
    case 'CHAR': case 'NUMC': return length;
    case 'STRG': case 'SSTR': case 'RSTR': return 0;
    case 'CUKY': return 5;
    case 'UNIT': return 3;
    case 'DEC': case 'CURR': case 'QUAN': {
      let charLength = 31;
      if (length !== 0) charLength = Math.floor(length / 2) * 2 + 1;
      if (precision !== 0) {
        charLength = Math.floor(precision / 2) * 2 + 1;
        if (scale > 0) {
          charLength += 1 + scale;
          if (scale > 31) charLength -= 31;
        }
      }
      return charLength;
    }
    case 'FLTP': return 23;
    case 'INT1': return 3;
    case 'INT2': return 5;
    case 'INT4': return 10;
    case 'INT8': return 19;
    case 'LANG': return 2;
    case 'DATS': return 10;
    case 'TIMS': return 8;
    case 'CLNT': return 3;
    default: return 10;
  }
}

function setTagAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`\\s${name}="[^"]*"`);
  return re.test(tag) ? tag.replace(re, ` ${name}="${value}"`) : tag.replace(/(\s*\/?>)$/, ` ${name}="${value}"$1`);
}

function setElementAttr(xml: string, element: string, name: string, value: string, destName: string): string {
  const re = new RegExp(`<${element}\\b[^>]*>`);
  const m = xml.match(re);
  if (!m) throw new Error(`Open Hub Destination ${destName} has no <${element}> element; this option applies to the other destination type.`);
  return xml.replace(re, () => setTagAttr(m[0], name, value));
}

function elementBlock(xml: string, fieldName: string): RegExpMatchArray | null {
  const esc = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return xml.match(new RegExp(`<element\\b[^>]*\\bname="${esc}"[^>]*>[\\s\\S]*?</element>`));
}

function buildDestElement(field: OpenHubFieldInput): string {
  const name = field.name.toUpperCase();
  const label = escapeXmlAttr(field.label);
  if (field.infoObjectName) {
    const iobj = field.infoObjectName.toUpperCase();
    return (
      `<element externalFormat="false" xsi:type="dest:DestElement" name="${name}" infoObjectName="${iobj}">` +
      `<endUserTexts label="${label}"/>` +
      `<inlineType name="${field.type}" globalElementName="${iobj}" length="${field.length}"/>` +
      `<localProperties xsi:type="BwCore:LocalCharacteristicProperties"/>` +
      `<associationType>1</associationType>` +
      `</element>`
    );
  }
  return (
    `<element externalFormat="false" xsi:type="dest:DestElement" name="${name}">` +
    `<endUserTexts label="${label}"/>` +
    `<inlineType name="${field.type}" length="${field.length}"/>` +
    `<localProperties xsi:type="BwCore:LocalCharacteristicProperties"/>` +
    `</element>`
  );
}

/**
 * Change an Open Hub Destination as the modeling tools' editor does: the document is read,
 * changed in place and written back. The destination type itself is not switched here, since
 * the editor drops every property and the key on a switch; create a new destination instead.
 */
export async function bwUpdateOpenHub(client: BwClient, openHubName: string, o: OpenHubUpdateOptions): Promise<string> {
  const name = openHubName.toUpperCase();
  const destMedia = MEDIA_TYPES['dest'];
  const path = `/sap/bw/modeling/dest/${bwSeg(name)}/m`;
  const applied: string[] = [];

  const lockHandle = await client.lock('dest', name);
  try {
    const got = await client.get(`${path}?forceCacheUpdate=true`, destMedia);
    const timestamp = got.headers['timestamp'] ?? got.headers['TIMESTAMP'];
    let xml = got.body;
    const destType = attr(xml.match(/<dest:destination\b[^>]*>/)?.[0] ?? '', 'destinationType');
    const isTable = destType === 'TAB';
    const isFile = destType === 'FILE';

    if (o.description !== undefined) {
      const at = xml.indexOf('<element');
      const head = at >= 0 ? xml.slice(0, at) : xml;
      const tag = `<endUserTexts label="${escapeXmlAttr(o.description)}"/>`;
      xml = /<endUserTexts\b[^>]*\/>/.test(head)
        ? head.replace(/<endUserTexts\b[^>]*\/>/, tag) + (at >= 0 ? xml.slice(at) : '')
        : xml.replace(/(<dest:destination\b[^>]*>)/, `$1${tag}`);
      applied.push('description');
    }

    const dbOptions = o.writeMode !== undefined || o.useTechnicalKey !== undefined || o.connectionType !== undefined || o.dbConnectionName !== undefined;
    if (dbOptions && !isTable) throw new Error(`Open Hub Destination ${name} is a ${destType} destination; the database options apply to a table destination only.`);
    const fileOptions = o.fileType !== undefined || o.fileName !== undefined || o.separator !== undefined || o.fileOnAppServer !== undefined || o.serverName !== undefined || o.logicalFileName !== undefined || o.directory !== undefined;
    if (fileOptions && !isFile) throw new Error(`Open Hub Destination ${name} is a ${destType} destination; the file options apply to a file destination only.`);

    if (isTable) {
      const dbTag = () => xml.match(/<databaseProperties\b[^>]*>/)?.[0] ?? '';
      const technicalKey = o.useTechnicalKey ?? attr(dbTag(), 'useTechnicalKey') === 'true';
      let writeMode = o.writeMode ?? attr(dbTag(), 'writeMode');
      if (o.useTechnicalKey !== undefined) {
        xml = setElementAttr(xml, 'databaseProperties', 'useTechnicalKey', String(o.useTechnicalKey), name);
        applied.push(`technical key ${o.useTechnicalKey}`);
        if (o.useTechnicalKey) {
          // The editor clears the semantic key and turns overwrite into delete-and-insert.
          if (/<keyElement>/.test(xml)) {
            xml = xml.replace(/<keyElement>[^<]*<\/keyElement>/g, '');
            applied.push('semantic key removed (technical key)');
          }
          if (writeMode === 'OVERWRITE' && o.writeMode === undefined) {
            writeMode = 'DEL_INSERT';
            xml = setElementAttr(xml, 'databaseProperties', 'writeMode', 'DEL_INSERT', name);
            applied.push('write mode DEL_INSERT (overwrite needs a semantic key)');
          }
        }
      }
      if (o.writeMode !== undefined) {
        if (technicalKey && o.writeMode === 'OVERWRITE') {
          throw new Error('write_mode "OVERWRITE" needs a semantic key; with a technical key only "INSERT" or "DEL_INSERT" are possible.');
        }
        xml = setElementAttr(xml, 'databaseProperties', 'writeMode', o.writeMode, name);
        applied.push(`write mode ${o.writeMode}`);
      }
      if (o.connectionType !== undefined) {
        const connectionName = o.dbConnectionName ?? attr(dbTag(), 'dbConnectionName');
        if (o.connectionType !== 'LOCAL' && !connectionName) throw new Error(`connection_type "${o.connectionType}" requires db_connection_name.`);
        xml = setElementAttr(xml, 'databaseProperties', 'connectionType', o.connectionType, name);
        if (o.connectionType === 'LOCAL' && o.dbConnectionName === undefined) xml = setElementAttr(xml, 'databaseProperties', 'dbConnectionName', '', name);
        applied.push(`connection type ${o.connectionType}`);
      }
      if (o.dbConnectionName !== undefined) {
        xml = setElementAttr(xml, 'databaseProperties', 'dbConnectionName', escapeXmlAttr(o.dbConnectionName), name);
        applied.push(`connection name ${o.dbConnectionName || '(none)'}`);
      }
      if (o.keyFields !== undefined) {
        if (technicalKey) throw new Error('key_fields cannot be set while the technical key is used; set use_technical_key false first.');
        const names = o.keyFields.map((f) => f.trim()).filter(Boolean);
        for (const f of names) {
          if (!elementBlock(xml, f) && !(o.fields ?? []).some((n) => n.name.toUpperCase() === f.toUpperCase())) {
            throw new Error(`key field ${f} is not a field of Open Hub Destination ${name}. bw_get_open_hub lists the field names, including any $BIC$ prefix.`);
          }
        }
        xml = xml.replace(/<keyElement>[^<]*<\/keyElement>/g, '');
        const keyXml = names.map((f) => `<keyElement>#///${f}</keyElement>`).join('');
        xml = xml.replace(/<tlogoProperties\b/, `${keyXml}<tlogoProperties`);
        applied.push(`key fields ${names.join(', ') || '(none)'}`);
      }
    } else if (o.keyFields !== undefined) {
      throw new Error(`key_fields apply to a table destination only; ${name} is a ${destType} destination.`);
    }

    if (isFile) {
      const fpTag = () => xml.match(/<fileProperties\b[^>]*>/)?.[0] ?? '';
      if (o.fileType !== undefined) {
        const lit = FILE_TYPE_LITERALS[o.fileType];
        xml = setElementAttr(xml, 'fileProperties', 'fileType', lit.literal, name);
        const current = attr(fpTag(), 'fileName');
        if (o.fileName === undefined && current.includes('.')) {
          xml = setElementAttr(xml, 'fileProperties', 'fileName', current.replace(/\.[^.]*$/, '') + lit.extension, name);
        }
        if (o.fileType === 'XML' && attr(fpTag(), 'isSapStandardXml') !== 'true' && attr(fpTag(), 'isStandardBinaryXml') !== 'true') {
          xml = setElementAttr(xml, 'fileProperties', 'isSapStandardXml', 'true', name);
        }
        applied.push(`file type ${o.fileType}`);
      }
      if (o.fileName !== undefined) {
        xml = setElementAttr(xml, 'fileProperties', 'fileName', escapeXmlAttr(o.fileName), name);
        applied.push(`file name ${o.fileName}`);
      }
      if (o.separator !== undefined) {
        if (attr(fpTag(), 'fileType') !== 'FILE') throw new Error('separator applies to a CSV file only.');
        if (o.separator.length !== 1) throw new Error('separator must be exactly one character.');
        xml = setElementAttr(xml, 'fileProperties', 'separator', escapeXmlAttr(o.separator), name);
        applied.push(`separator ${o.separator}`);
      }
      if (o.fileOnAppServer !== undefined) {
        xml = setElementAttr(xml, 'fileProperties', 'isFileOnAppserver', String(o.fileOnAppServer), name);
        if (!o.fileOnAppServer) {
          // The editor drops the logical file name and the directory when the file leaves the server.
          xml = setElementAttr(xml, 'fileProperties', 'isLogicalFileNameSet', 'false', name);
          xml = setElementAttr(xml, 'fileProperties', 'path', o.directory !== undefined ? escapeXmlAttr(o.directory) : '', name);
        }
        applied.push(`file on application server ${o.fileOnAppServer}`);
      }
      const onServer = attr(fpTag(), 'isFileOnAppserver') === 'true';
      if (o.serverName !== undefined) {
        if (!onServer) throw new Error('server_name applies to a file on the application server.');
        xml = setElementAttr(xml, 'fileProperties', 'serverName', escapeXmlAttr(o.serverName), name);
        applied.push(`server ${o.serverName}`);
      }
      if (o.logicalFileName !== undefined) {
        if (!onServer) throw new Error('logical_file_name applies to a file on the application server.');
        xml = setElementAttr(xml, 'fileProperties', 'isLogicalFileNameSet', String(o.logicalFileName !== ''), name);
        xml = setElementAttr(xml, 'fileProperties', 'logicalFileName', escapeXmlAttr(o.logicalFileName), name);
        applied.push(o.logicalFileName ? `logical file name ${o.logicalFileName}` : 'logical file name removed');
      }
      if (o.directory !== undefined && o.fileOnAppServer !== false) {
        // The server keeps its work directory for a file on the application server, whatever is sent.
        if (onServer) throw new Error('directory applies to a file on the local workstation; on the application server the server always uses its work directory.');
        xml = setElementAttr(xml, 'fileProperties', 'path', escapeXmlAttr(o.directory), name);
        applied.push(`directory ${o.directory || '(none)'}`);
      }
    }

    if (o.sendNotificationRfc !== undefined || o.rfcDestination !== undefined) {
      const send = o.sendNotificationRfc ?? attr(xml.match(/<dest:destination\b[^>]*>/)?.[0] ?? '', 'sendNotificationRFC') === 'true';
      if (send && !(o.rfcDestination ?? attr(xml.match(/<dest:destination\b[^>]*>/)?.[0] ?? '', 'sendNotificationRFCDest'))) {
        throw new Error('send_notification_rfc needs rfc_destination, the RFC destination that is notified after a load.');
      }
      xml = setElementAttr(xml, 'dest:destination', 'sendNotificationRFC', String(send), name);
      xml = setElementAttr(xml, 'dest:destination', 'sendNotificationRFCDest', send ? escapeXmlAttr(o.rfcDestination ?? '') : '', name);
      applied.push(send ? `RFC notification to ${o.rfcDestination}` : 'RFC notification off');
    }
    if (o.dtpExternalProgram !== undefined) {
      xml = setElementAttr(xml, 'dest:destination', 'dtpExternalProgram', String(o.dtpExternalProgram), name);
      applied.push(`DTP started by external program ${o.dtpExternalProgram}`);
    }

    if (o.removeFields?.length) {
      for (const raw of o.removeFields) {
        const block = elementBlock(xml, raw);
        if (!block) throw new Error(`field ${raw} is not a field of Open Hub Destination ${name}.`);
        xml = xml.replace(block[0], '');
        xml = xml.replace(new RegExp(`<keyElement>#///${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</keyElement>`), '');
      }
      applied.push(`fields removed ${o.removeFields.join(', ')}`);
    }
    if (o.fields?.length) {
      const added: string[] = [];
      const keys: string[] = [];
      for (const f of o.fields) {
        if (elementBlock(xml, f.name.toUpperCase())) continue;
        xml = xml.replace(/<keyElement>|<tlogoProperties\b/, (m) => buildDestElement(f) + m);
        added.push(f.name.toUpperCase());
        if (f.isKey) keys.push(f.name.toUpperCase());
      }
      if (keys.length) {
        if (!isTable || attr(xml.match(/<databaseProperties\b[^>]*>/)?.[0] ?? '', 'useTechnicalKey') === 'true') {
          throw new Error('is_key needs a table destination with a semantic key.');
        }
        xml = xml.replace(/<tlogoProperties\b/, keys.map((k) => `<keyElement>#///${k}</keyElement>`).join('') + '<tlogoProperties');
      }
      applied.push(added.length ? `fields added ${added.join(', ')}` : 'no new fields (all exist)');
    }

    const formatChanges: Array<[string[] | undefined, boolean]> = [[o.externalFormatOn, true], [o.externalFormatOff, false]];
    for (const [list, on] of formatChanges) {
      for (const raw of list ?? []) {
        const block = elementBlock(xml, raw);
        if (!block) throw new Error(`field ${raw} is not a field of Open Hub Destination ${name}.`);
        let el = block[0];
        const openTag = el.match(/<element\b[^>]*>/)![0];
        let newTag = setTagAttr(openTag, 'externalFormat', String(on));
        if (on) {
          const inlineTag = el.match(/<inlineType\b[^>]*>/)?.[0] ?? '';
          newTag = setTagAttr(newTag, 'outputLength', String(externalOutputLength(inlineTag)));
          newTag = setTagAttr(newTag, 'outputDataType', /name="(STRG|SSTR|RSTR)"/.test(inlineTag) ? 'STRG' : 'CHAR');
        } else {
          newTag = newTag.replace(/\soutputDataType="[^"]*"/, '');
        }
        el = el.replace(openTag, newTag);
        xml = xml.replace(block[0], () => el);
      }
      if (list?.length) applied.push(`external format ${on ? 'on' : 'off'} for ${list.join(', ')}`);
    }
    if (isTable && o.externalFormatOn?.length) {
      // The editor refuses a key whose external output lengths exceed 449 characters.
      const keyNames = [...xml.matchAll(/<keyElement>#\/\/\/([^<]+)<\/keyElement>/g)].map((m) => m[1]);
      let sum = 0;
      for (const k of keyNames) {
        const tag = elementBlock(xml, k)?.[0].match(/<element\b[^>]*>/)?.[0] ?? '';
        if (attr(tag, 'externalFormat') === 'true') sum += Number(attr(tag, 'outputLength') || 0);
      }
      if (sum > 449) throw new Error(`The external output lengths of the key fields add up to ${sum}, more than the 449 characters the modeling tools allow.`);
    }

    if (applied.length === 0) {
      return JSON.stringify({ success: true, open_hub_name: name, message: 'Nothing to change.' });
    }
    xml = xml.replace(/<consumptionViewProperties\b[^>]*\/>/g, '');
    xml = xml.replace(/<contentState>[^<]*<\/contentState>/, '<contentState>REV</contentState>');
    await client.put('dest', name, lockHandle, xml, timestamp, o.transport);
  } finally {
    await client.unlock('dest', name).catch(() => {/* the result of the write decides */});
  }

  const result = await client.get(path, destMedia);
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';
  const info = parseOpenHubXml(result.body, status);
  return JSON.stringify(
    {
      success: true,
      open_hub_name: name,
      status: info.status,
      applied,
      field_count: info.fields.length,
      key_fields: info.fields.filter((f) => f.key).map((f) => f.name),
      database_properties: info.databaseProperties,
      file_properties: info.fileProperties,
      message:
        `Open Hub Destination ${name} updated (${applied.join('; ')}). Activate it with bw_activate (object_type "dest", lock_handle ""). ` +
        `The activation recreates the database table and is refused while the table holds data: delete the requests of ${name} first (bw_delete_request with target_type "DEST").`,
    },
    null,
    2,
  );
}

// ── Create ───────────────────────────────────────────────────────────────────

export type OpenHubDestinationType = 'TAB' | 'FILE';
export type OpenHubWriteMode = 'INSERT' | 'DEL_INSERT' | 'OVERWRITE';
export type OpenHubConnectionType = 'LOCAL' | 'SDA' | 'DBCON';
export type OpenHubFileType = 'CSV' | 'FIXED' | 'XML';

export interface OpenHubCreateOptions {
  description: string;
  infoArea: string;
  pkg?: string;
  destinationType: OpenHubDestinationType;
  templateObjectName: string;
  templateObjectType: 'ADSO' | 'HCPR';
  writeMode?: OpenHubWriteMode;
  useTechnicalKey?: boolean;
  connectionType?: OpenHubConnectionType;
  dbConnectionName?: string;
  fileType?: OpenHubFileType;
  fileName?: string;
  separator?: string;
  fileOnAppServer?: boolean;
  serverName?: string;
  logicalFileName?: string;
  directory?: string;
}

const FILE_TYPE_LITERALS: Record<OpenHubFileType, { literal: string; extension: string }> = {
  CSV: { literal: 'FILE', extension: '.CSV' },
  FIXED: { literal: 'FILE_FIX', extension: '.TXT' },
  XML: { literal: 'FILE_XML', extension: '.XML' },
};

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function validateCreateOptions(o: OpenHubCreateOptions): void {
  if (o.destinationType === 'TAB') {
    if (o.useTechnicalKey && o.writeMode === 'OVERWRITE') {
      throw new Error('write_mode "OVERWRITE" needs a semantic key: with use_technical_key the modeling tools only allow "INSERT" or "DEL_INSERT".');
    }
    if (o.connectionType && o.connectionType !== 'LOCAL' && !o.dbConnectionName) {
      throw new Error(`connection_type "${o.connectionType}" requires db_connection_name.`);
    }
    if (o.fileType || o.fileName || o.separator || o.fileOnAppServer !== undefined || o.serverName || o.logicalFileName || o.directory) {
      throw new Error('File options are only valid for destination_type "FILE".');
    }
  } else {
    if (o.writeMode || o.useTechnicalKey !== undefined || o.connectionType || o.dbConnectionName) {
      throw new Error('Database options are only valid for destination_type "TAB".');
    }
    if (o.logicalFileName && !o.fileOnAppServer) {
      throw new Error('logical_file_name is only available for a file on the application server (file_on_app_server: true).');
    }
    if (o.directory && o.fileOnAppServer) {
      throw new Error('directory applies to a file on the local workstation only: on the application server the server always uses its work directory on create.');
    }
    if (!o.fileOnAppServer && !o.directory) {
      throw new Error('A file on the local workstation needs directory (the activation check refuses an empty path).');
    }
    if (o.separator !== undefined && o.fileType && o.fileType !== 'CSV') {
      throw new Error('separator applies to file_type "CSV" only.');
    }
    if (o.separator !== undefined && o.separator.length !== 1) {
      throw new Error('separator must be exactly one character.');
    }
  }
}

function buildPropertiesXml(name: string, o: OpenHubCreateOptions): string {
  if (o.destinationType === 'TAB') {
    const attrs: string[] = [];
    if (o.writeMode) attrs.push(`writeMode="${o.writeMode}"`);
    if (o.useTechnicalKey !== undefined) attrs.push(`useTechnicalKey="${o.useTechnicalKey}"`);
    if (o.connectionType) attrs.push(`connectionType="${o.connectionType}"`);
    if (o.dbConnectionName) attrs.push(`dbConnectionName="${escapeXmlAttr(o.dbConnectionName)}"`);
    return `  <databaseProperties${attrs.length ? ' ' + attrs.join(' ') : ''}/>\n`;
  }
  const attrs: string[] = [];
  const fileType = o.fileType ?? 'CSV';
  const lit = FILE_TYPE_LITERALS[fileType];
  attrs.push(`fileType="${lit.literal}"`);
  // The modeling tools name the file after the destination and swap the extension with the type.
  const baseName = (o.fileName ?? name).replace(/\.[^.]*$/, '');
  attrs.push(`fileName="${escapeXmlAttr(o.fileName && /\.[^.]+$/.test(o.fileName) ? o.fileName : baseName + lit.extension)}"`);
  if (fileType === 'CSV') attrs.push(`separator="${escapeXmlAttr(o.separator ?? ';')}"`);
  if (fileType === 'XML') attrs.push(`isSapStandardXml="true" isStandardBinaryXml="false"`);
  if (o.fileOnAppServer) {
    attrs.push(`isFileOnAppserver="true"`);
    if (o.serverName) attrs.push(`serverName="${escapeXmlAttr(o.serverName)}"`);
    if (o.logicalFileName) {
      attrs.push(`isLogicalFileNameSet="true" logicalFileName="${escapeXmlAttr(o.logicalFileName)}"`);
    }
  } else if (o.directory) {
    attrs.push(`path="${escapeXmlAttr(o.directory)}"`);
  }
  return `  <fileProperties ${attrs.join(' ')}/>\n`;
}

/**
 * Create an Open Hub Destination the way the BW modeling tools' wizard does: a lock with
 * activity CREA, then a POST of the destination shell with the template object as
 * copyFrom parameters. The server copies the template's fields and key, generates the
 * DB table name and fills the defaults of the chosen destination type; the properties
 * given here are written into the same POST and are kept by the server.
 */
export async function bwCreateOpenHub(client: BwClient, openHubName: string, o: OpenHubCreateOptions): Promise<string> {
  validateCreateOptions(o);
  const name = openHubName.toUpperCase();
  const pkg = o.pkg ?? '$TMP';
  const destMedia = MEDIA_TYPES['dest'];
  const language = process.env.BW_LANGUAGE ?? 'DE';

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<dest:destination\n` +
    `  xmlns:adtcore="http://www.sap.com/adt/core"\n` +
    `  xmlns:dest="http://www.sap.com/bw/modeling/dest.ecore"\n` +
    `  name="${name}" destinationType="${o.destinationType}">\n` +
    `  <endUserTexts label="${escapeXmlAttr(o.description)}"/>\n` +
    `  <tlogoProperties\n` +
    `    adtcore:language="${language}"\n` +
    `    adtcore:name="${name}"\n` +
    `    adtcore:type="DEST"\n` +
    `    adtcore:masterLanguage="${language}">\n` +
    `    <infoArea>${o.infoArea.toUpperCase()}</infoArea>\n` +
    `  </tlogoProperties>\n` +
    buildPropertiesXml(name, o) +
    `</dest:destination>`;

  const lockHandle = await client.lock('dest', name, { activity_context: 'CREA' });
  const url =
    `/sap/bw/modeling/dest/${bwSeg(name)}` +
    `?copyFromObjectName=${encodeURIComponent(o.templateObjectName.toUpperCase())}` +
    `&copyFromObjectType=${o.templateObjectType}` +
    `&lockHandle=${lockHandle}`;
  try {
    await client.postWithCsrf(url, body, `application/xml, ${destMedia}`, {
      'Development-Class': pkg,
      Accept: destMedia,
    });
  } finally {
    await client.unlock('dest', name).catch(() => {/* the create result decides, not the unlock */});
  }

  const result = await client.get(`/sap/bw/modeling/dest/${bwSeg(name)}/m`, destMedia);
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';
  const info = parseOpenHubXml(result.body, status);

  // The activation check refuses a table destination without any key: the template's key is
  // copied, but a CompositeProvider has none. The technical key is the way out on create.
  const keyFields = info.fields.filter((f) => f.key).map((f) => f.name);
  const warning =
    info.destinationType === 'TAB' && keyFields.length === 0 && !info.databaseProperties?.useTechnicalKey
      ? 'No key field: the activation check will refuse this destination. Recreate it with use_technical_key: true, or use a template that carries a key.'
      : undefined;

  return JSON.stringify(
    {
      success: true,
      ...(warning ? { warning } : {}),
      open_hub_name: info.name,
      destination_type: info.destinationType,
      status: info.status,
      db_table: info.dbTable,
      template: `${o.templateObjectType} ${o.templateObjectName.toUpperCase()}`,
      field_count: info.fields.length,
      key_fields: keyFields,
      database_properties: info.databaseProperties,
      file_properties: info.fileProperties,
      message:
        `Open Hub Destination ${info.name} created inactive in InfoArea ${info.infoArea} with ${info.fields.length} fields ` +
        `copied from ${o.templateObjectType} ${o.templateObjectName.toUpperCase()}. ` +
        `Activate it with bw_activate (object_type "dest", lock_handle ""); a DTP into it is created with bw_create_dtp (target_type "DEST").`,
    },
    null,
    2,
  );
}
