/**
 * Calling an RFC-enabled function module over the SOAP RFC service (/sap/bc/soap/rfc).
 *
 * Some things BW serves only to its own front ends through RFC, with no REST resource and no
 * table a DataPreview statement could read in full: a stored Analysis for Office workbook is
 * one, its file sits in a string column the preview cuts after a few bytes. The SOAP RFC
 * service reaches such a module over the same HTTP connection, as the same user, so BW checks
 * that user's authorizations exactly as it does for the front end.
 *
 * The service is an ICF node that many systems leave inactive. When it does not answer, the
 * caller is told which node to activate rather than shown the ICF logon error page.
 */
import type { BwClient } from './bw-client.js';

export const SOAP_RFC_PATH = '/sap/bc/soap/rfc';

const NS = 'urn:sap-com:document:sap:rfc:functions';

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/** A scalar, a structure (its fields by name) or a table (its rows, each sent as an item). */
export type RfcValue = string | RfcValue[] | { [field: string]: RfcValue };

function serialize(name: string, value: RfcValue): string {
  if (typeof value === 'string') return `<${name}>${escapeXml(value)}</${name}>`;
  if (Array.isArray(value)) return `<${name}>${value.map((row) => serialize('item', row)).join('')}</${name}>`;
  return `<${name}>${Object.entries(value).map(([k, v]) => serialize(k, v)).join('')}</${name}>`;
}

/**
 * A table parameter comes back only when the request names it, so an output table is passed
 * as an empty array.
 */
export function rfcEnvelope(fm: string, params: Record<string, RfcValue>): string {
  const body = Object.entries(params)
    .map(([k, v]) => serialize(k, v))
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/"><soap-env:Body>' +
    `<urn:${fm} xmlns:urn="${NS}">${body}</urn:${fm}>` +
    '</soap-env:Body></soap-env:Envelope>'
  );
}

/** A classic RFC exception arrives as a SOAP fault whose detail names the exception. */
export function soapFault(xml: string): string | undefined {
  if (!/<(?:[\w-]+:)?Fault>/.test(xml)) return undefined;
  const fault = xml.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/)?.[1]?.trim();
  const exception = xml.match(/<(?:[\w-]+:)?detail>\s*<(?:[\w-]+:)?([A-Za-z_][\w.]*)/)?.[1];
  return [exception, fault].filter(Boolean).join(': ') || 'SOAP fault without a message';
}

export async function callRfc(client: BwClient, fm: string, params: Record<string, RfcValue>): Promise<string> {
  let body: string;
  try {
    ({ body } = await client.rawPost(SOAP_RFC_PATH, rfcEnvelope(fm, params), {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: `${NS}:${fm}`,
    }));
  } catch (err) {
    const message = String((err as Error).message);
    if (/HTTP (401|403|404)/.test(message)) {
      throw new Error(
        `The SOAP RFC service ${SOAP_RFC_PATH} is not reachable for this user (${message.match(/HTTP \d+/)![0]}). ` +
          `Activate the ICF service default_host${SOAP_RFC_PATH} (transaction SICF); the user needs S_RFC for ${fm}. ` +
          `Behind the SAP Cloud Connector, ${SOAP_RFC_PATH} must also be exposed as a resource.`,
      );
    }
    const fault = soapFault(message);
    if (fault) throw new Error(`${fm} failed: ${fault}`);
    // What the service answers for a module it cannot call: a reply Node cannot even parse.
    if (/Parse Error|Invalid header/i.test(message)) {
      throw new Error(`${fm} could not be called over ${SOAP_RFC_PATH}: the module does not exist on this system or is not remote-enabled.`);
    }
    throw err;
  }
  const fault = soapFault(body);
  if (fault) throw new Error(`${fm} failed: ${fault}`);
  return body;
}

/** The text of one element in the response, or '' when it is empty or absent. */
export function rfcField(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : '';
}

/**
 * The rows of a table or the fields of a structure in the response, values unescaped and
 * untrimmed: some keys carry meaning in their padding, such as a role key, which is the role
 * name padded to 30 characters followed by a node number.
 */
export function rfcRows(xml: string, name: string): Array<Record<string, string>> {
  const section = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? '';
  return [...section.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => rfcStruct(m[1]));
}

export function rfcStruct(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of xml.matchAll(/<([A-Za-z_][\w]*)>([^<]*)<\/\1>|<([A-Za-z_][\w]*)\s*\/>/g)) {
    if (m[1]) out[m[1]] = unescapeXml(m[2]);
    else out[m[3]] = '';
  }
  return out;
}
