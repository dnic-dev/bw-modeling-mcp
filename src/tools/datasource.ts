import { BwClient, MEDIA_TYPES, bwNsName, bwSeg } from '../bw-client.js';

const BASE = '/sap/bw/modeling/repo/datasourcestructure';
const BASE_PREFIX = `${BASE}/`;

interface ParsedEntry {
  objectName: string;
  objectType: string;
  objectSubtype: string | null;
  objectStatus: string | null;
  displayObjectName: string | null;
  title: string;
  selfHref: string | null;
  childrenHref: string | null;
}

function parseEntries(xml: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  const entryRegex = /<atom:entry\b[^>]*>([\s\S]*?)<\/atom:entry>/g;
  let em: RegExpExecArray | null;

  while ((em = entryRegex.exec(xml)) !== null) {
    const body = em[1];

    const bwObjMatch = body.match(/<bwModel:object\b([\s\S]*?)(?:\/>|>)/);
    const bwAttrs = bwObjMatch?.[1] ?? '';
    const objectName = bwAttrs.match(/\bobjectName="([^"]*)"/)?.[1] ?? '';
    const objectType = bwAttrs.match(/\bobjectType="([^"]*)"/)?.[1] ?? '';
    const objectSubtype = bwAttrs.match(/\bobjectSubtype="([^"]*)"/)?.[1] ?? null;
    const objectStatus = bwAttrs.match(/\bobjectStatus="([^"]*)"/)?.[1] ?? null;
    const displayObjectName = bwAttrs.match(/\bdisplayObjectName="([^"]*)"/)?.[1] ?? null;

    const title = body.match(/<atom:title[^>]*>([^<]*)<\/atom:title>/)?.[1] ?? '';

    let selfHref: string | null = null;
    let childrenHref: string | null = null;

    const linkRegex = /<atom:link\b([\s\S]*?)(?:\/>|>)/g;
    let lm: RegExpExecArray | null;
    while ((lm = linkRegex.exec(body)) !== null) {
      const attrs = lm[1];
      const rel = attrs.match(/\brel="([^"]*)"/)?.[1] ?? '';
      const href = attrs.match(/\bhref="([^"]*)"/)?.[1] ?? '';
      if (rel === 'self') selfHref = href || null;
      else if (rel === 'http://www.sap.com/bw/modeling/relations:children') childrenHref = href || null;
    }

    entries.push({ objectName, objectType, objectSubtype, objectStatus, displayObjectName, title, selfHref, childrenHref });
  }

  return entries;
}

function stripBase(href: string): string {
  return href.startsWith(BASE_PREFIX) ? href.slice(BASE_PREFIX.length) : href;
}

export async function bwListSourceSystems(
  client: BwClient,
  sourceSystemType?: string
): Promise<string> {
  const ssysUrls: string[] = [];

  if (sourceSystemType) {
    ssysUrls.push(`${BASE}/ssys/${sourceSystemType.toLowerCase()}`);
  } else {
    const { body: rootBody } = await client.get(BASE, 'application/atom+xml');
    for (const e of parseEntries(rootBody)) {
      if (e.childrenHref) ssysUrls.push(e.childrenHref);
    }
  }

  const sourceSystems: object[] = [];
  for (const url of ssysUrls) {
    const { body } = await client.get(url, 'application/atom+xml');
    for (const e of parseEntries(body)) {
      if (e.objectType !== 'LSYS') continue;
      sourceSystems.push({
        name: e.objectName,
        description: e.title,
        source_system_type: e.objectSubtype,
        status: e.objectStatus,
        self_url: e.selfHref,
        children_path: e.childrenHref ? stripBase(e.childrenHref) : null,
      });
    }
  }

  return JSON.stringify({ count: sourceSystems.length, source_systems: sourceSystems }, null, 2);
}

export async function bwListDatasources(
  client: BwClient,
  sourceSystem: string,
  format: 'text' | 'raw' = 'text',
  apcoPathFilter?: string,
): Promise<string> {
  interface DatasourceEntry {
    name: string;
    description: string;
    status: string | null;
    self_url: string | null;
    apco_path: string[];
  }

  const filterSegments: string[] = apcoPathFilter
    ? apcoPathFilter.split('>').map(s => s.trim().toLowerCase()).filter(s => s.length > 0)
    : [];
  const filterLen = filterSegments.length;

  const segmentMatches = (title: string, name: string, idx: number): boolean => {
    const seg = filterSegments[idx];
    return title.trim().toLowerCase() === seg || name.trim().toLowerCase() === seg;
  };

  const advanceMatch = (currentPtr: number, title: string, name: string): number => {
    if (filterLen === 0) return 0;
    if (currentPtr >= filterLen) return currentPtr;
    if (segmentMatches(title, name, currentPtr)) return currentPtr + 1;
    if (currentPtr > 0 && segmentMatches(title, name, 0)) return 1;
    return 0;
  };

  const datasources: DatasourceEntry[] = [];
  const rawBlocks: string[] = [];
  const sourceSystemUpper = sourceSystem.toUpperCase();

  async function recurse(url: string, apcoPath: string[], matchPtr: number): Promise<void> {
    const { body } = await client.get(url, 'application/atom+xml');
    const inside = matchPtr >= filterLen;

    if (format === 'raw') {
      if (inside) rawBlocks.push(`Source System: ${sourceSystemUpper}\n${body}`);
      for (const e of parseEntries(body)) {
        if (e.objectType === 'APCO' && e.childrenHref) {
          const nextPtr = advanceMatch(matchPtr, e.title, e.objectName);
          await recurse(e.childrenHref, [...apcoPath, e.title], nextPtr);
        }
      }
      return;
    }

    for (const e of parseEntries(body)) {
      if (e.objectType === 'RSDS') {
        if (!inside) continue;
        const name = e.displayObjectName
          ? e.displayObjectName.split(' (')[0]
          : e.objectName.trim().split(' ')[0];
        datasources.push({
          name,
          description: e.title,
          status: e.objectStatus,
          self_url: e.selfHref,
          apco_path: [...apcoPath],
        });
      } else if (e.objectType === 'APCO' && e.childrenHref) {
        const nextPtr = advanceMatch(matchPtr, e.title, e.objectName);
        await recurse(e.childrenHref, [...apcoPath, e.title], nextPtr);
      }
    }
  }

  await recurse(`${BASE}/lsys/${bwSeg(sourceSystem)}`, [], 0);

  if (format === 'raw') return rawBlocks.join('\n\n');

  const p = (s: string, n: number) => s.padEnd(n);
  const header = `${p('NAME', 30)} ${p('STATUS', 9)} ${p('APCO PATH', 32)} ${p('DESCRIPTION', 36)} URL`;
  const sep = '-'.repeat(header.length);

  const headerLines: string[] = [
    `Source System: ${sourceSystemUpper}`,
    `DataSources: ${datasources.length}`,
  ];
  if (apcoPathFilter) headerLines.push(`APCO Path Filter: ${apcoPathFilter}`);

  const lines: string[] = [
    ...headerLines,
    '',
    header,
    sep,
  ];

  for (const ds of datasources) {
    const apco = ds.apco_path.join(' > ');
    lines.push(
      `${p(ds.name, 30)} ${p(ds.status ?? '', 9)} ${p(apco, 32)} ${p(ds.description, 36)} ${ds.self_url ?? ''}`
    );
  }

  return lines.join('\n');
}

const RSDS_ACCEPT =
  'application/vnd.sap.bw.modeling.rsds-v1_0_0+xml, application/vnd.sap.bw.modeling.rsds-v1_1_0+xml';

interface DatasourceField {
  name: string;
  description: string | null;
  type: string | null;
  length: number | null;
  transfer: boolean | null;
  selection_options: number | null;
  position: number | null;
  is_key: boolean;
  precision?: number;
  scale?: number;
  conversion_exit?: string;
  unit_currency_ref?: string;
}

interface DatasourceData {
  name: string | null;
  source_system: string | null;
  type: string | null;
  application_component: string | null;
  direct_access: string | null;
  delta: string | null;
  description: string | null;
  status: string | null;
  changed_at: string | null;
  changed_by: string | null;
  created_at: string | null;
  created_by: string | null;
  package: string | null;
  field_count: number;
  fields: DatasourceField[];
  adapter: Record<string, unknown>;
}

function summarizeDatasource(d: DatasourceData): string {
  const lines: string[] = [];

  lines.push(`DataSource: ${d.name ?? ''}`);
  lines.push(`Source System: ${d.source_system ?? ''}`);
  lines.push(`Status: ${d.status ?? ''} | Type: ${d.type ?? ''} | Delta: ${d.delta ?? ''} | Direct Access: ${d.direct_access ?? ''}`);
  lines.push(`Description: ${d.description ?? ''}`);
  lines.push(`Application Component: ${d.application_component ?? ''}`);
  lines.push(`Changed: ${d.changed_at ?? ''} by ${d.changed_by ?? ''}`);
  lines.push(`Created: ${d.created_at ?? ''} by ${d.created_by ?? ''}`);
  lines.push(`Package: ${d.package ?? ''}`);

  // ── Fields ────────────────────────────────────────────────────────────────
  lines.push('');
  lines.push(`── Fields (${d.field_count}) ──`);

  const compactLabel = (f: DatasourceField): string => {
    const len = f.length !== null
      ? String(f.length)
      : (f.precision !== undefined && f.scale !== undefined ? `P${f.precision}/S${f.scale}` : '');
    return `${f.name}(${f.type ?? ''}/${len})`;
  };

  const notTransferred = d.fields.filter(f => f.transfer === false);
  const keyFields      = d.fields.filter(f => f.is_key);
  const transferred    = d.fields.filter(f => f.transfer === true)
                                  .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const ntLabels = notTransferred.map(compactLabel);
  if (ntLabels.length === 0) {
    lines.push(`Not transferred (0):`);
  } else {
    const chunks: string[][] = [];
    for (let i = 0; i < ntLabels.length; i += 10) chunks.push(ntLabels.slice(i, i + 10));
    if (chunks.length === 1) {
      lines.push(`Not transferred (${notTransferred.length}): ${chunks[0].join(', ')}`);
    } else {
      lines.push(`Not transferred (${notTransferred.length}):`);
      for (const chunk of chunks) lines.push(`  ${chunk.join(', ')}`);
    }
  }

  lines.push(`Key fields (${keyFields.length}): ${keyFields.map(compactLabel).join(', ')}`);

  lines.push('');
  lines.push(`Transferred (${transferred.length}):`);

  const pe = (s: string, n: number) => s.padEnd(n);
  const pr = (s: string, n: number) => s.padStart(n);
  lines.push(`  ${'POS'.padEnd(4)}  ${'NAME'.padEnd(30)} ${'TYPE'.padEnd(7)} ${'LEN'.padStart(5)}  ${'KEY'.padEnd(4)} ${'SEL'.padEnd(4)} DESCRIPTION`);

  for (const f of transferred) {
    const pos    = String(f.position ?? 0).padStart(4, '0');
    const lenStr = f.length !== null
      ? String(f.length)
      : (f.precision !== undefined && f.scale !== undefined ? `P${f.precision}/S${f.scale}` : '');
    const keyStr = f.is_key ? 'key' : '';
    const selStr = String(f.selection_options ?? '');
    let desc = f.description ?? '';
    if (f.conversion_exit)   desc += ` [conv: ${f.conversion_exit}]`;
    if (f.unit_currency_ref) desc += ` [unit: ${f.unit_currency_ref}]`;

    lines.push(`  ${pos}  ${pe(f.name, 30)} ${pe(f.type ?? '', 7)} ${pr(lenStr, 5)}  ${pe(keyStr, 4)} ${pe(selStr, 4)} ${desc}`);
  }

  // ── Adapter ────────────────────────────────────────────────────────────────
  lines.push('');
  lines.push('── Adapter ──');
  for (const [key, value] of Object.entries(d.adapter)) {
    lines.push(`${key}: ${value ?? ''}`);
  }

  return lines.join('\n');
}

function parseDescLabel(xml: string): string | null {
  const re = /<description\b([^>]*)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    if (attrs.includes('textType="3"')) return attrs.match(/\blabel="([^"]*)"/)?.[1] ?? null;
  }
  return null;
}

export async function bwGetDatasource(
  client: BwClient,
  datasourceName: string,
  sourceSystem: string,
  format: 'text' | 'raw' = 'text',
): Promise<string> {
  const url = `/sap/bw/modeling/rsds/${encodeURIComponent(bwNsName(datasourceName))}/${sourceSystem.toUpperCase()}/m`;
  const { body, headers } = await client.get(url, RSDS_ACCEPT);

  if (format === 'raw') return body;

  // Root element attributes
  const rootMatch = body.match(/<rsds:dataSource\b([\s\S]*?)>/);
  const rootAttrs = rootMatch?.[1] ?? '';
  const name = rootAttrs.match(/(?:^|\s)name="([^"]*)"/)?.[1] ?? null;
  const sourceSystemAttr = rootAttrs.match(/\bsourceSystemName="([^"]*)"/)?.[1] ?? null;
  const type = rootAttrs.match(/(?<![a-zA-Z:])type="([^"]*)"/)?.[1] ?? null;
  const applicationComponent = rootAttrs.match(/\bapplicationComponent="([^"]*)"/)?.[1] ?? null;
  const directAccess = rootAttrs.match(/\bdirectAccess="([^"]*)"/)?.[1] ?? null;

  // delta from <deltaProperties>
  const delta = body.match(/<deltaProperties\b[\s\S]*?\bdelta="([^"]*)"/)?.[1] ?? null;

  // DataSource-level description (header section, before first <segment>)
  const segStart = body.indexOf('<segment');
  const headerSection = segStart >= 0 ? body.slice(0, segStart) : body;
  const description = parseDescLabel(headerSection);

  // Status from response header (axios lowercases all header names)
  const status = (headers['object_status'] as string | undefined) ?? null;

  // tlogoProperties
  const tlogoMatch = body.match(/<tlogoProperties\b([\s\S]*?)>/);
  const tlogoAttrs = tlogoMatch?.[1] ?? '';
  const changedAt = tlogoAttrs.match(/\badtcore:changedAt="([^"]*)"/)?.[1] ?? null;
  const changedBy = tlogoAttrs.match(/\badtcore:changedBy="([^"]*)"/)?.[1] ?? null;
  const createdAt = tlogoAttrs.match(/\badtcore:createdAt="([^"]*)"/)?.[1] ?? null;
  const createdBy = tlogoAttrs.match(/\badtcore:createdBy="([^"]*)"/)?.[1] ?? null;

  // Package from <adtcore:packageRef adtcore:name="...">
  const pkg = body.match(/<adtcore:packageRef\b[\s\S]*?\badtcore:name="([^"]*)"/)?.[1] ?? null;

  // Segment ID="0001" — key fields and field list
  const segMatch = body.match(/<segment\b[^>]*ID="0001"[^>]*>([\s\S]*?)<\/segment>/);
  const segBody = segMatch?.[1] ?? '';

  const keyFields = new Set<string>();
  const kfRe = /<keyField>([^<]*)<\/keyField>/g;
  let kfm: RegExpExecArray | null;
  while ((kfm = kfRe.exec(segBody)) !== null) {
    const kv = kfm[1].trim().match(/^#\/\/\/0001\/(.+)$/);
    if (kv) keyFields.add(kv[1]);
  }

  const fields: DatasourceField[] = [];
  const fieldRe = /<field\b([\s\S]*?)>([\s\S]*?)<\/field>/g;
  let fm: RegExpExecArray | null;
  while ((fm = fieldRe.exec(segBody)) !== null) {
    const fTag = fm[1];
    const fBody = fm[2];

    const fieldName = fTag.match(/\bname="([^"]*)"/)?.[1] ?? '';

    const itMatch = fBody.match(/<inlineType\b([\s\S]*?)(?:\/>|>)/);
    const itAttrs = itMatch?.[1] ?? '';
    const fType = itAttrs.match(/\bname="([^"]*)"/)?.[1] ?? null;
    const lengthRaw = itAttrs.match(/\blength="([^"]*)"/)?.[1];
    const length = lengthRaw !== undefined ? parseInt(lengthRaw, 10) : null;
    const precisionRaw = itAttrs.match(/\bprecision="([^"]*)"/)?.[1];
    const scaleRaw = itAttrs.match(/\bscale="([^"]*)"/)?.[1];

    const fpMatch = fBody.match(/<fieldProperties\b([\s\S]*?)(?:\/>|>)/);
    const fpAttrs = fpMatch?.[1] ?? '';
    const transferRaw = fpAttrs.match(/\btransfer="([^"]*)"/)?.[1];
    const selOptRaw = fpAttrs.match(/\bselectionOptions="([^"]*)"/)?.[1];
    const posRaw = fpAttrs.match(/\bposition="([^"]*)"/)?.[1];
    const convExit = fpAttrs.match(/\bconversionExitSource="([^"]*)"/)?.[1] || undefined;

    const ucRaw = fBody.match(/<unitCurrencyElement>([^<]*)<\/unitCurrencyElement>/)?.[1];

    const field: Record<string, unknown> = {
      name: fieldName,
      description: parseDescLabel(fBody),
      type: fType,
      length,
      transfer: transferRaw === 'true' ? true : transferRaw === 'false' ? false : null,
      selection_options: selOptRaw !== undefined ? parseInt(selOptRaw, 10) : null,
      position: posRaw !== undefined ? parseInt(posRaw, 10) : null,
      is_key: keyFields.has(fieldName),
    };
    if (precisionRaw !== undefined) field['precision'] = parseInt(precisionRaw, 10);
    if (scaleRaw !== undefined) field['scale'] = parseInt(scaleRaw, 10);
    if (convExit) field['conversion_exit'] = convExit;
    if (ucRaw) field['unit_currency_ref'] = ucRaw.replace(/^#\/\/\/0001\//, '');

    fields.push(field as unknown as DatasourceField);
  }

  // Active adapter(s)
  const adapter: Record<string, unknown> = {};
  const adapterTagRe = /<adapter\b([\s\S]*?)(?:\/>|>)/g;
  let adm: RegExpExecArray | null;
  while ((adm = adapterTagRe.exec(body)) !== null) {
    const aAttrs = adm[1];
    if (!aAttrs.includes('currentlyUsed="true"')) continue;

    const rawAType = aAttrs.match(/\bxsi:type="([^"]*)"/)?.[1] ?? '';
    const aType = rawAType.replace(/^rsds:/, '');
    const extObj = aAttrs.match(/\bexternalObject="([^"]*)"/)?.[1] || null;

    if (aType === 'ConverterCSVFL') {
      const dataSep = aAttrs.match(/\bdataSeparator="([^"]*)"/)?.[1] ?? null;
      const escChar = aAttrs.match(/\bescapeCharacter="([^"]*)"/)?.[1] ?? null;
      if (dataSep !== null) adapter['data_separator'] = dataSep;
      if (escChar !== null) adapter['escape_character'] = escChar;
    } else {
      adapter['adapter_name'] = aAttrs.match(/(?:^|\s)name="([^"]*)"/)?.[1] ?? null;
      adapter['adapter_type'] = aType;
      if (extObj) adapter['external_object'] = extObj;

      if (aType === 'ExtractorODP') {
        adapter['context_description'] = aAttrs.match(/\bcontextDescription="([^"]*)"/)?.[1] ?? null;
        adapter['semantics'] = aAttrs.match(/\bsemantics="([^"]*)"/)?.[1] ?? null;
      } else if (aType === 'ExtractorHANA') {
        adapter['hana_type'] = aAttrs.match(/\bhanaType="([^"]*)"/)?.[1] ?? null;
        adapter['schema'] = aAttrs.match(/\bschema="([^"]*)"/)?.[1] ?? null;
        adapter['remote_source'] = aAttrs.match(/\bremoteSource="([^"]*)"/)?.[1] ?? null;
      } else if (aType.startsWith('ExtractorFile')) {
        const ignoreLines = aAttrs.match(/\bignoreLines="([^"]*)"/)?.[1] || null;
        if (ignoreLines !== null) adapter['ignore_lines'] = ignoreLines;
      }
    }
  }

  const data: DatasourceData = {
    name,
    source_system: sourceSystemAttr,
    type,
    application_component: applicationComponent,
    direct_access: directAccess,
    delta,
    description,
    status,
    changed_at: changedAt,
    changed_by: changedBy,
    created_at: createdAt,
    created_by: createdBy,
    package: pkg,
    field_count: fields.length,
    fields,
    adapter,
  };

  return summarizeDatasource(data);
}

const LSYS_ACCEPT =
  'application/vnd.sap.bw.modeling.lsys-v1_0_0+xml, application/vnd.sap.bw.modeling.lsys-v1_1_0+xml';

function deriveSourceSystemType(xsiType: string, context: string | null, hanaType: string | null): string {
  if (xsiType === 'SourceSystemFILE') return 'FILE';
  if (xsiType === 'SourceSystemHANA') {
    return hanaType === '1' ? 'HANA_LOCAL' : 'HANA_SDA';
  }
  if (xsiType === 'SourceSystemODP') {
    if (context === 'SAPI') return 'ODP_SAP';
    if (context === 'ABAP_CDS') return 'ODP_CDS';
    if (context === 'BW') return 'ODP_BW';
    return 'ODP';
  }
  return xsiType;
}

export async function bwGetSourceSystem(client: BwClient, sourceSystem: string): Promise<string> {
  const url = `/sap/bw/modeling/lsys/${bwSeg(sourceSystem)}/a`;
  const { body, headers } = await client.get(url, LSYS_ACCEPT);

  // Root element opening tag attributes (up to first closing >)
  const rootMatch = body.match(/<lsys:sourceSystem\b([\s\S]*?)>/);
  const rootAttrs = rootMatch?.[1] ?? '';

  const name = rootAttrs.match(/(?:^|\s)name="([^"]*)"/)?.[1] ?? null;
  const rawXsiType = rootAttrs.match(/\bxsi:type="([^"]*)"/)?.[1] ?? '';
  const xsiType = rawXsiType.replace(/^lsys:/, '');
  // Use negative lookbehind to avoid matching xsi:type or adtcore:type
  const type = rootAttrs.match(/(?<![a-zA-Z:])type="([^"]*)"/)?.[1] ?? null;

  // ODP-specific root attributes
  const context = rootAttrs.match(/\bcontext="([^"]*)"/)?.[1] ?? null;
  const destination = rootAttrs.match(/\bdestination="([^"]*)"/)?.[1] ?? null;
  const destinationValid = rootAttrs.match(/\bdestinationValid="([^"]*)"/)?.[1] ?? null;
  const treeRemote = rootAttrs.match(/\btreeRemote="([^"]*)"/)?.[1] ?? null;
  const treeReplicatable = rootAttrs.match(/\btreeReplicatable="([^"]*)"/)?.[1] ?? null;

  // HANA-specific root attributes
  const hanaType = rootAttrs.match(/\bhanaType="([^"]*)"/)?.[1] ?? null;
  const remoteSource = rootAttrs.match(/\bremoteSource="([^"]*)"/)?.[1] ?? null;
  const database = rootAttrs.match(/\bdatabase="([^"]*)"/)?.[1] ?? null;
  const schema = rootAttrs.match(/\bschema="([^"]*)"/)?.[1] ?? null;
  const sdiAdapter = rootAttrs.match(/\bsdiAdapter="([^"]*)"/)?.[1] ?? null;

  // <description textType="3" label="..."/>
  let description: string | null = null;
  const descRegex = /<description\b([^>]*?)(?:\/>|>)/g;
  let dm: RegExpExecArray | null;
  while ((dm = descRegex.exec(body)) !== null) {
    const dAttrs = dm[1];
    if (dAttrs.includes('textType="3"')) {
      description = dAttrs.match(/\blabel="([^"]*)"/)?.[1] ?? null;
      break;
    }
  }

  // tlogoProperties attributes
  const tlogoMatch = body.match(/<tlogoProperties\b([\s\S]*?)>/);
  const tlogoAttrs = tlogoMatch?.[1] ?? '';
  const changedAt = tlogoAttrs.match(/\badtcore:changedAt="([^"]*)"/)?.[1] ?? null;
  const changedBy = tlogoAttrs.match(/\badtcore:changedBy="([^"]*)"/)?.[1] ?? null;

  // <objectStatus> text content
  const objectStatus = body.match(/<objectStatus>([^<]*)<\/objectStatus>/)?.[1] ?? null;

  // Response header (axios lowercases header names)
  const status = (headers['object_status'] as string | undefined) ?? null;

  const sourceSystemType = deriveSourceSystemType(xsiType, context, hanaType);

  const result: Record<string, unknown> = {
    name,
    xsi_type: xsiType,
    type,
    status,
    description,
    changed_at: changedAt,
    changed_by: changedBy,
    object_status: objectStatus,
    source_system_type: sourceSystemType,
  };

  if (xsiType === 'SourceSystemODP') {
    result['context'] = context;
    result['destination'] = destination;
    result['destination_valid'] = destinationValid === 'true' ? true : destinationValid === 'false' ? false : null;
    result['tree_remote'] = treeRemote === 'true' ? true : treeRemote === 'false' ? false : null;
    result['tree_replicatable'] = treeReplicatable === 'true' ? true : treeReplicatable === 'false' ? false : null;
  } else if (xsiType === 'SourceSystemHANA') {
    result['hana_type'] = hanaType;
    result['remote_source'] = remoteSource;
    result['database'] = database;
    result['schema'] = schema;
    result['sdi_adapter'] = sdiAdapter;
  }

  return JSON.stringify(result, null, 2);
}

// Full Accept header for the remote-entity value help (multiple supported versions).
const VALUEHELP_ACCEPT = [
  'application/vnd.sap-bw-modeling.valuehelp2-v1_0_0+xml',
  MEDIA_TYPES['valuehelp'],
  'application/vnd.sap-bw-modeling.isvaluehelp-v1_0_0+xml',
].join(', ');

interface RemoteEntity {
  technical_name: string;
  entity_type: string | null;
  path_suffix: string | null;
}

/**
 * bw_list_remote_entities — read-only discovery of the remote entities (HANA views /
 * virtual tables) exposed by a source system, as offered on the DataSource proposal page.
 *
 * The returned technical_name is exactly what binds into the adapter externalObject when
 * creating a DataSource via bw_create_datasource.
 */
export async function bwListRemoteEntities(
  client: BwClient,
  sourceSystem: string,
  searchPattern: string = '*',
  resultSize: number = 200,
): Promise<string> {
  const ssUpper = sourceSystem.toUpperCase();
  const url =
    `/sap/bw/modeling/rsdsint/values/hanaentity` +
    `?searchPattern=${encodeURIComponent(searchPattern)}` +
    `&sourcesystem=${encodeURIComponent(ssUpper)}` +
    `&resultSize=${resultSize}`;

  const { body } = await client.rawGet(url, { Accept: VALUEHELP_ACCEPT });

  // Root <vh:valueHelp size="..." resultComplete="..."> — surface truncation info.
  const rootAttrs = body.match(/<vh:valueHelp\b([^>]*)>/)?.[1] ?? '';
  const sizeRaw = rootAttrs.match(/\bsize="([^"]*)"/)?.[1];
  const size = sizeRaw !== undefined ? parseInt(sizeRaw, 10) : null;
  const resultComplete = rootAttrs.match(/\bresultComplete="([^"]*)"/)?.[1] === 'true';

  const entities: RemoteEntity[] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(body)) !== null) {
    const rowBody = rm[1];
    const technicalName = rowBody.match(/<technicalName>([^<]*)<\/technicalName>/)?.[1] ?? '';

    let entityType: string | null = null;
    let pathSuffix: string | null = null;
    const attrRe = /<attribute\b([^>]*)\/>/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(rowBody)) !== null) {
      const aAttrs = am[1];
      const aName = aAttrs.match(/\bname="([^"]*)"/)?.[1] ?? '';
      const aValue = aAttrs.match(/\bvalue="([^"]*)"/)?.[1] ?? '';
      if (aName === 'ENTITY_TYPE') entityType = aValue;
      else if (aName === 'PATH_SUFFIX') pathSuffix = aValue;
    }

    entities.push({ technical_name: technicalName, entity_type: entityType, path_suffix: pathSuffix });
  }

  return JSON.stringify({
    source_system: ssUpper,
    search_pattern: searchPattern,
    result_size: size,
    result_complete: resultComplete,
    count: entities.length,
    entities,
  }, null, 2);
}

/**
 * bw_create_datasource — create a DataSource on top of a remote entity, from the server's
 * field proposal, and leave it inactive. v1: local objects only ($TMP), no field/key/
 * partitioning editing. Activation is a separate step via bw_activate (object_type "rsds").
 *
 * Sequence (lock → create → unlock on the SAME session, via rawPost because the rsds compound
 * key and the copyFrom query params do not fit client.lock/create/unlock):
 *   1. POST ?action=lock with activity_context CREA → lockHandle
 *   2. POST the minimal proposal body to
 *      ?copyFromObjectName=initial&copyFromObjectType=_proposal&lockHandle=...
 *      (server derives the full segment + field structure from the remote entity)
 *   3. POST ?action=unlock
 *
 * The remote entity binds via the adapter externalObject attribute, not by name equality —
 * hanaEntity is its own parameter (defaulting to the DataSource name only as a convenience).
 */
export async function bwCreateDatasource(
  client: BwClient,
  datasourceName: string,
  sourceSystem: string,
  applicationComponent: string,
  hanaEntity?: string,
  description?: string,
): Promise<string> {
  const dsUpper = datasourceName.toUpperCase();
  const dsLower = datasourceName.toLowerCase();
  const ssUpper = sourceSystem.toUpperCase();
  const apco = applicationComponent.toUpperCase();
  // externalObject must match the remote entity's technicalName exactly — do NOT transform case.
  const externalObject = hanaEntity ?? datasourceName;
  const desc = description ?? externalObject;

  const language = process.env.BW_LANGUAGE ?? 'DE';
  const masterSystem = new URL(process.env.BW_URL ?? 'http://localhost').hostname.split('.')[0].toUpperCase();
  const responsible = (process.env.BW_USER ?? '').toUpperCase();

  const lockUrl   = `/sap/bw/modeling/rsds/${bwSeg(datasourceName)}/${ssUpper}?action=lock`;
  const unlockUrl = `/sap/bw/modeling/rsds/${bwSeg(datasourceName)}/${ssUpper}?action=unlock`;

  // Step 1: Lock (CREA) — establishes the enqueue session + CSRF on this client.
  const csrf = await client.getCsrfToken();
  const lockResponse = await client.rawPost(lockUrl, '', {
    'activity_context': 'CREA',
    'Accept': RSDS_ACCEPT,
    'x-csrf-token': csrf,
  });
  const lockHandle = lockResponse.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1] ?? '';
  if (!lockHandle) {
    throw new Error(`No <LOCK_HANDLE> in CREA lock response:\n${lockResponse.body}`);
  }

  // Step 2: Create from proposal (with lockHandle). Server materialises the full structure.
  const createUrl =
    `/sap/bw/modeling/rsds/${bwSeg(datasourceName)}/${ssUpper}` +
    `?copyFromObjectName=initial&copyFromObjectType=_proposal&lockHandle=${encodeURIComponent(lockHandle)}`;

  const postBody = `<?xml version="1.0" encoding="UTF-8"?>
<dataSource:dataSource
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:adtcore="http://www.sap.com/adt/core"
  xmlns:dataSource="http://www.sap.com/bw/modeling/DataSource.ecore"
  applicationComponent="${apco}"
  name="${dsUpper}"
  sourceSystemName="${ssUpper}"
  type="D">
  <description label="${desc}" textType="3"/>
  <adapter xsi:type="dataSource:ExtractorHANA" category="E" currentlyUsed="true"
           name="HANA" externalObject="${externalObject}" pathSuffix=""/>
  <tlogoProperties adtcore:language="${language}" adtcore:name="${dsUpper}"
                   adtcore:type="RSDS" adtcore:masterLanguage="${language}"
                   adtcore:masterSystem="${masterSystem}" adtcore:responsible="${responsible}"/>
</dataSource:dataSource>`;

  try {
    await client.rawPost(createUrl, postBody, {
      'Development-Class': '$TMP',
      'Content-Type': MEDIA_TYPES['rsds'],
      'Accept': MEDIA_TYPES['rsds'],
      'x-csrf-token': csrf,
    });
  } finally {
    // Step 3: Unlock on the same session, even if create failed.
    await client.rawPost(unlockUrl, '', {
      'Content-Type': MEDIA_TYPES['rsds'],
      'Accept': MEDIA_TYPES['rsds'],
      'x-csrf-token': csrf,
    });
  }

  // Read back the derived structure so the caller sees what the proposal produced.
  const structure = await bwGetDatasource(client, dsLower, ssUpper, 'text');

  const header = [
    `DataSource created (inactive): ${dsUpper} / ${ssUpper}`,
    `Package: $TMP (local)`,
    `Application Component: ${apco}`,
    `HANA entity bound (adapter externalObject): ${externalObject}`,
    '',
    `Next step: activate with bw_activate — object_type "rsds", object_name "${dsUpper}", ` +
      `source_system "${ssUpper}", lock_handle "".`,
    '',
    '── Read-back (GET .../m) ──',
  ].join('\n');

  return `${header}\n${structure}`;
}

export async function bwPreviewDatasource(
  client: BwClient,
  datasourceName: string,
  sourceSystem: string,
  records: number = 20,
): Promise<string> {
  const structureUrl = `/sap/bw/modeling/rsds/${bwSeg(datasourceName)}/${sourceSystem.toUpperCase()}/m`;
  const { body: structureBody } = await client.get(structureUrl, RSDS_ACCEPT);

  const segMatch = structureBody.match(/<segment\b[^>]*ID="0001"[^>]*>([\s\S]*?)<\/segment>/);
  const segBody = segMatch?.[1] ?? '';

  const fieldEntries: Array<{ name: string; position: number }> = [];
  const fieldRe = /<field\b([\s\S]*?)>([\s\S]*?)<\/field>/g;
  let fm: RegExpExecArray | null;
  while ((fm = fieldRe.exec(segBody)) !== null) {
    const fTag = fm[1];
    const fBody = fm[2];
    const fieldName = fTag.match(/\bname="([^"]*)"/)?.[1] ?? '';
    const fpMatch = fBody.match(/<fieldProperties\b([\s\S]*?)(?:\/>|>)/);
    const fpAttrs = fpMatch?.[1] ?? '';
    const transferRaw = fpAttrs.match(/\btransfer="([^"]*)"/)?.[1];
    if (transferRaw === 'false') continue;
    const posRaw = fpAttrs.match(/\bposition="([^"]*)"/)?.[1];
    const position = posRaw !== undefined ? parseInt(posRaw, 10) : 0;
    fieldEntries.push({ name: fieldName, position });
  }
  fieldEntries.sort((a, b) => a.position - b.position);
  const fieldNames = fieldEntries.map(f => f.name);

  const url = `/sap/bw/modeling/rsdsint/dataprev/${encodeURIComponent(bwNsName(datasourceName).toUpperCase())}/${sourceSystem.toUpperCase()}?records=${records}&external=true`;
  const csrfToken = await client.getCsrfToken();
  const { body: previewBody } = await client.rawPost(url, '', {
    'x-csrf-token': csrfToken,
    'X-sap-adt-profiling': 'server-time',
  });

  const contentMatch = previewBody.match(/<simpleParams\b[^>]*\bcontent="([^"]*)"/);
  const content = contentMatch?.[1] ?? '';
  const decoded = Buffer.from(content, 'base64').toString('utf-8');
  const parsed = JSON.parse(decoded) as { T_DATA_0001?: string[][] };
  const rows: string[][] = parsed['T_DATA_0001'] ?? [];

  const summaryHeader = [
    `DataSource: ${datasourceName.toUpperCase()} / Source System: ${sourceSystem.toUpperCase()}`,
    `Records: ${rows.length} (requested: ${records})`,
  ].join('\n');

  if (rows.length === 0) {
    return `${summaryHeader}\n(no data returned)`;
  }

  const columnCount = rows[0].length;
  let headers: string[];
  let mismatchWarning: string | null = null;
  if (fieldNames.length !== columnCount) {
    headers = Array.from({ length: columnCount }, (_, i) => `COL_${i + 1}`);
    mismatchWarning = `Warning: field count mismatch (fields: ${fieldNames.length}, columns: ${columnCount}) — column names may be incorrect.`;
  } else {
    headers = fieldNames;
  }

  const MAX_WIDTH = 30;
  const truncate = (s: string): string => (s.length > MAX_WIDTH ? s.slice(0, 27) + '...' : s);

  const truncatedRows = rows.map(row => row.map(truncate));
  const truncatedHeaders = headers.map(truncate);

  const widths: number[] = truncatedHeaders.map((h, i) => {
    let w = h.length;
    for (const row of truncatedRows) {
      const cell = row[i] ?? '';
      if (cell.length > w) w = cell.length;
    }
    return Math.min(w, MAX_WIDTH);
  });

  const formatRow = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i])).join(' ');

  const headerLine = formatRow(truncatedHeaders);
  const sepLine = widths.map(w => '-'.repeat(w)).join(' ');

  const lines: string[] = [summaryHeader, '', headerLine, sepLine];
  for (const row of truncatedRows) {
    const cells = headers.map((_, i) => row[i] ?? '');
    lines.push(formatRow(cells));
  }
  if (mismatchWarning) {
    lines.push('');
    lines.push(mismatchWarning);
  }

  return lines.join('\n');
}

// ── bwChangeDatasourceDelta ─────────────────────────────────────────────────────

export interface ChangeDatasourceDeltaArgs {
  datasourceName: string;
  sourceSystem: string;
  deltaProcess: string;
}

/**
 * bw_change_datasource_delta — change the delta process (deltaProperties@delta) of a
 * DataSource. Full read-modify-write on the RSDS /m resource. Activation is separate
 * (bw_activate, object_type "rsds"). See payloads/change_datasource_delta.md.
 */
export async function bwChangeDatasourceDelta(
  client: BwClient,
  args: ChangeDatasourceDeltaArgs
): Promise<string> {
  const dsUpper = args.datasourceName.toUpperCase();
  const ssUpper = args.sourceSystem.toUpperCase();
  const mUrl = `/sap/bw/modeling/rsds/${encodeURIComponent(bwNsName(args.datasourceName).toUpperCase())}/${ssUpper}/m`;

  // 1. Read current full body (this exact XML is PUT back with one attribute changed).
  const { body: current } = await client.rawGet(mUrl, { Accept: RSDS_ACCEPT });

  const dpMatch = current.match(/<deltaProperties\b[^>]*\bdelta="([^"]*)"[^>]*>/);
  if (!dpMatch) {
    return JSON.stringify({
      success: false,
      message: 'No <deltaProperties delta="..."> element found in the DataSource body.',
    }, null, 2);
  }
  const currentDelta = dpMatch[1];

  // Validate against the admissible delta values enumerated in the adapter block.
  const admBlock = current.match(/<admissibleAttributes>([\s\S]*?)<\/admissibleAttributes>/)?.[1] ?? '';
  const allowed: string[] = [];
  const deltaRe = /<delta>([^<]*)<\/delta>/g;
  let dm: RegExpExecArray | null;
  while ((dm = deltaRe.exec(admBlock)) !== null) allowed.push(dm[1]);
  if (allowed.length > 0 && !allowed.includes(args.deltaProcess)) {
    return JSON.stringify({
      success: false,
      current_delta: currentDelta,
      requested_delta: args.deltaProcess,
      allowed_deltas: allowed,
      message: 'Requested delta process is not admissible for this DataSource.',
    }, null, 2);
  }

  // 2. Lock; capture LOCK_HANDLE and the timestamp response header for the PUT.
  // Writing requests (lock, PUT, unlock) must carry a fetched CSRF token — rawPost/rawPut
  // do not add one automatically. Reuse the same token across the whole sequence, on the
  // same cookie session (same pattern as bwCreateDatasource).
  const lockUrl = `/sap/bw/modeling/rsds/${bwSeg(args.datasourceName)}/${ssUpper}?action=lock`;
  const unlockUrl = `/sap/bw/modeling/rsds/${bwSeg(args.datasourceName)}/${ssUpper}?action=unlock`;
  const csrf = await client.getCsrfToken();
  const lockRes = await client.rawPost(lockUrl, '', { Accept: RSDS_ACCEPT, 'x-csrf-token': csrf });
  const lockHandle = lockRes.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1] ?? '';
  if (!lockHandle) {
    return JSON.stringify({
      success: false,
      message: `No <LOCK_HANDLE> in lock response:\n${lockRes.body}`,
    }, null, 2);
  }
  const timestamp = (lockRes.headers['timestamp'] as string | undefined) ?? '';

  try {
    // 3. Replace only deltaProperties@delta (anchored so the adapter's delta="" is untouched).
    const modified = current.replace(
      /(<deltaProperties\b[^>]*\bdelta=")[^"]*(")/,
      `$1${args.deltaProcess}$2`
    );

    // 4. PUT the full modified body.
    const putUrl = `${mUrl}?lockHandle=${encodeURIComponent(lockHandle)}`;
    const putRes = await client.rawPut(putUrl, modified, {
      'Content-Type': 'application/xml, application/vnd.sap.bw.modeling.rsds-v1_1_0+xml',
      Accept: 'application/vnd.sap.bw.modeling.rsds-v1_1_0+xml',
      'x-csrf-token': csrf,
      ...(timestamp ? { timestamp } : {}),
    });

    const hasError = putRes.body.includes('messageType="Error"');
    const title = putRes.body.match(/<atom:title>([^<]*)<\/atom:title>/)?.[1] ?? '';

    const result: Record<string, unknown> = {
      success: !hasError,
      datasource: dsUpper,
      source_system: ssUpper,
      previous_delta: currentDelta,
      new_delta: args.deltaProcess,
    };
    if (title) result['message'] = title;
    if (!hasError) {
      result['next_step'] =
        'DataSource is inactive. Activate with bw_activate (object_type "rsds", pass source_system).';
    }
    return JSON.stringify(result, null, 2);
  } finally {
    // 5. Release the enqueue (best-effort, also on failure).
    try {
      await client.rawPost(unlockUrl, '', { Accept: RSDS_ACCEPT, 'x-csrf-token': csrf });
    } catch {
      // ignore unlock failure
    }
  }
}

// ── bwSetDatasourceFields ────────────────────────────────────────────────────────

export interface SetDatasourceFieldsArgs {
  datasourceName: string;
  sourceSystem: string;
  fields?: Array<{ name: string; transfer: boolean }>;
  languageField?: string;
  transport?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * bw_set_datasource_fields — set the transfer flag (fieldProperties@transfer) of one or
 * more DataSource fields. Full read-modify-write on the RSDS /m resource. Only
 * fieldProperties@transfer is changed; the adapter fieldMapping is left untouched.
 * Activation is separate (bw_activate, object_type "rsds"). See payloads/set_datasource_fields.md.
 */
export async function bwSetDatasourceFields(
  client: BwClient,
  args: SetDatasourceFieldsArgs
): Promise<string> {
  const dsUpper = args.datasourceName.toUpperCase();
  const dsLower = bwSeg(args.datasourceName);
  const ssUpper = args.sourceSystem.toUpperCase();
  const mUrl = `/sap/bw/modeling/rsds/${encodeURIComponent(bwNsName(args.datasourceName).toUpperCase())}/${ssUpper}/m`;

  const hasFields = !!args.fields && args.fields.length > 0;
  if (!hasFields && args.languageField === undefined) {
    return JSON.stringify({ success: false, message: 'Neither fields nor language_field given.' }, null, 2);
  }

  // 1. Read current full body.
  const { body: current } = await client.rawGet(mUrl, { Accept: RSDS_ACCEPT });

  // Resolve each requested field against its <field>/<fieldProperties>.
  const changed: Array<{ name: string; transfer: boolean; previous: boolean }> = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  let modified = current;

  for (const f of args.fields ?? []) {
    const nameEsc = escapeRegExp(f.name);
    const fpRe = new RegExp(
      `<field name="${nameEsc}"[^>]*>[\\s\\S]*?<fieldProperties\\b([^>]*)\\/>`
    );
    const fpMatch = modified.match(fpRe);
    if (!fpMatch) {
      skipped.push({ name: f.name, reason: 'field not found' });
      continue;
    }
    const fpAttrs = fpMatch[1];
    const previous = /\btransfer="true"/.test(fpAttrs);
    const transferNotAllowed = /\btransferNotAllowed="true"/.test(fpAttrs);
    if (f.transfer && transferNotAllowed) {
      skipped.push({ name: f.name, reason: 'transfer not allowed for this field' });
      continue;
    }
    // Replace transfer only within this field's fieldProperties element.
    const replaceRe = new RegExp(
      `(<field name="${nameEsc}"[^>]*>[\\s\\S]*?<fieldProperties\\b[^>]*\\btransfer=")[^"]*(")`
    );
    modified = modified.replace(replaceRe, `$1${f.transfer ? 'true' : 'false'}$2`);
    changed.push({ name: f.name, transfer: f.transfer, previous });
  }

  // Segment-level languageField patch (primary segment only). The GET serialization
  // is round-tripped back with just this one attribute value changed.
  let segmentChange: { languageField: string; previous: string } | undefined;
  if (args.languageField !== undefined) {
    const prev = modified.match(/<segment\b[^>]*\blanguageField="([^"]*)"/)?.[1];
    if (prev === undefined) {
      skipped.push({ name: 'languageField', reason: 'no languageField attribute on segment' });
    } else {
      modified = modified.replace(
        /(<segment\b[^>]*\blanguageField=")[^"]*(")/,
        `$1${args.languageField}$2`
      );
      segmentChange = { languageField: args.languageField, previous: prev };
    }
  }

  if (changed.length === 0 && segmentChange === undefined) {
    return JSON.stringify({
      success: false,
      datasource: dsUpper,
      source_system: ssUpper,
      skipped,
      message: 'No fields were changed.',
    }, null, 2);
  }

  // 2. Lock; capture LOCK_HANDLE and the timestamp response header.
  const lockUrl = `/sap/bw/modeling/rsds/${dsLower}/${ssUpper}?action=lock`;
  const unlockUrl = `/sap/bw/modeling/rsds/${dsLower}/${ssUpper}?action=unlock`;
  const csrf = await client.getCsrfToken();
  const lockRes = await client.rawPost(lockUrl, '', { Accept: RSDS_ACCEPT, 'x-csrf-token': csrf });
  const lockHandle = lockRes.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1] ?? '';
  if (!lockHandle) {
    return JSON.stringify({
      success: false,
      message: `No <LOCK_HANDLE> in lock response:\n${lockRes.body}`,
    }, null, 2);
  }
  const timestamp = (lockRes.headers['timestamp'] as string | undefined) ?? '';

  try {
    // 3. PUT. corrNr (camelCase!) + Transport-Lock-Holder only when a transport is used.
    const query = args.transport
      ? `?corrNr=${encodeURIComponent(args.transport)}&lockHandle=${encodeURIComponent(lockHandle)}`
      : `?lockHandle=${encodeURIComponent(lockHandle)}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/xml, application/vnd.sap.bw.modeling.rsds-v1_1_0+xml',
      Accept: 'application/vnd.sap.bw.modeling.rsds-v1_1_0+xml',
    };
    if (timestamp) headers['timestamp'] = timestamp;
    if (args.transport) headers['Transport-Lock-Holder'] = args.transport;
    headers['x-csrf-token'] = csrf;

    const putRes = await client.rawPut(`${mUrl}${query}`, modified, headers);
    const hasError = putRes.body.includes('messageType="Error"');
    const title = putRes.body.match(/<atom:title>([^<]*)<\/atom:title>/)?.[1] ?? '';

    const result: Record<string, unknown> = {
      success: !hasError,
      datasource: dsUpper,
      source_system: ssUpper,
      changed,
    };
    if (segmentChange) result['segment_change'] = segmentChange;
    if (skipped.length > 0) result['skipped'] = skipped;
    if (title) result['message'] = title;
    if (!hasError) {
      result['next_step'] =
        'DataSource is inactive. Activate with bw_activate (object_type "rsds", pass source_system and, if transportable, transport).';
    }
    return JSON.stringify(result, null, 2);
  } finally {
    try {
      await client.rawPost(unlockUrl, '', { Accept: RSDS_ACCEPT, 'x-csrf-token': csrf });
    } catch {
      // ignore unlock failure
    }
  }
}
