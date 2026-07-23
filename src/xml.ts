/**
 * SAP returns the sentinel `NODESNOTCONNECTED` as the InfoArea of an object whose node is not
 * attached to an InfoArea in the requested tree view. It is not a real InfoArea name, so it must
 * never be surfaced in an object summary. Normalize it to an empty string; every reader that
 * displays an InfoArea passes its extracted value through this helper.
 */
export function stripInfoAreaSentinel(v: string): string {
  return v === 'NODESNOTCONNECTED' ? '' : v;
}
