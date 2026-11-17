/**
 * Refuse a request that would leave the path it was built for, or the backend altogether.
 *
 * Tools put names from their arguments into request paths, and the HTTP client resolves dot
 * segments before sending: a name of "../../other/service" would reach whatever else the
 * backend, or the tunnel in front of it, serves on that host. Checking every request where it
 * is sent covers the tools that encode their names and the ones that do not, today's and
 * tomorrow's.
 *
 * A segment is decoded before the comparison because an encoded dot is a dot to the server,
 * and split again afterwards because an encoded slash may be one too. Encoded slashes as such
 * stay valid: namespaced names depend on them. The query string is not looked at; it cannot
 * change where a request goes.
 */
export function assertBackendPath(url: string | undefined, baseUrl: string | undefined): void {
  if (!url) return;
  const refused = (why: string) => new Error(`Request refused: ${why}. The object name or path passed to the tool is not valid.`);

  let local = url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) {
    let target: URL;
    let base: URL;
    try {
      target = new URL(url, baseUrl);
      base = new URL(baseUrl ?? '');
    } catch {
      throw refused('the address cannot be read');
    }
    if (target.origin !== base.origin) throw refused('the address points away from the BW system');
    local = url.replace(/^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]*/i, '');
  }

  const path = local.split(/[?#]/)[0];
  if (path.includes('\\')) throw refused('the path contains a backslash');
  for (const segment of path.split('/')) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // Not valid percent-encoding: the server will not decode it either.
    }
    if (decoded.split(/[/\\]/).some((part) => part === '.' || part === '..')) {
      throw refused('the path contains a relative segment');
    }
  }
}
