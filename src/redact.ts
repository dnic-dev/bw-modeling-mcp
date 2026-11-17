import { decodeXmlEntities } from './bw-client.js';

/**
 * Take the address of the BW system out of a message that goes to a remote caller.
 *
 * Error texts quote the request that failed, and behind a hosted server that is the internal
 * address of the backend: of no use to the caller, and a map of the network to anyone else.
 * Only the backend's own origin and host name are replaced. Other addresses in a message, such
 * as the namespace identifiers in a BW error document, say nothing about the landscape and are
 * often what makes the message readable.
 */
export function redactBackend(message: string, backendUrl: string | undefined): string {
  if (!backendUrl) return message;
  let url: URL;
  try {
    url = new URL(backendUrl);
  } catch {
    return message;
  }
  const literal = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let out = message.replace(literal(url.origin), '<backend>');
  if (url.hostname) out = out.replace(literal(url.host), '<backend>').replace(literal(url.hostname), '<backend>');
  return out;
}

const EXCEPTION_DOCUMENT = /(?:<\?xml[^>]*\?>\s*)?<exc:exception\b[\s\S]*?<\/exc:exception>/g;
const OTHER_DOCUMENT = /(^|\n)[ \t]*(?:<\?xml[^>]*\?>\s*)?<([A-Za-z_][\w.:-]*)(?:\s[^>]*)?>[\s\S]*<\/\2\s*>/g;
const DOCUMENT_TEXT_LIMIT = 300;

function exceptionText(document: string): string {
  const element = (tag: string) =>
    document.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();
  const property = (key: string) =>
    document.match(new RegExp(`<entry\\s+key="${key}"\\s*>([^<]*)</entry>`))?.[1]?.trim();
  const text = decodeXmlEntities(element('localizedMessage') || element('message') || '');
  const type = document.match(/<type\s+id="([^"]*)"/)?.[1];
  const messageId = [property('T100KEY-ID'), property('T100KEY-NO')].filter(Boolean).join(' ');
  const origin = [type, messageId].filter(Boolean).join(', ');
  if (!text) return origin || 'The backend reported an error without a message text.';
  return origin ? `${text} [${origin}]` : text;
}

function documentText(document: string): string {
  const text = decodeXmlEntities(document.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  if (!text) return '(a response document without text)';
  return text.length > DOCUMENT_TEXT_LIMIT ? `${text.slice(0, DOCUMENT_TEXT_LIMIT)}…` : text;
}

/**
 * Reduce the response documents quoted in an error to what they say.
 *
 * A failed request is reported with the body the backend answered, and that is a whole XML
 * document: the message, and around it the structure of the interface. A remote caller gets
 * the message, the exception type and the message number, which is everything there is to act
 * on. Any other document that ended up in an error, such as a lock response without a handle,
 * is reduced to its text and cut short.
 *
 * This runs where the answer leaves the server and nowhere earlier: the tools themselves read
 * these documents and decide on their content.
 */
export function trimBackendDocuments(message: string): string {
  return message
    .replace(EXCEPTION_DOCUMENT, (document) => exceptionText(document))
    .replace(OTHER_DOCUMENT, (document, lead: string) => `${lead}${documentText(document.slice(lead.length))}`);
}
