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
