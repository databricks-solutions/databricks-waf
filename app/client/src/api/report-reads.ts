/**
 * The two collection reads the report makes, and the per-control paths it must not.
 *
 * Opening `/report` used to issue one improvements read and one notes read per control — 183
 * requests against labs, fifteen seconds of fetching on the page a customer sends to somebody
 * else. These two paths replaced them. The test beside this file is a count: neither path names a
 * control, and a path that does is the shape that grows with the catalogue.
 */

export const REPORT_COLLECTION_READS = {
  raised: '/api/improvements/raised',
  notes: '/api/notes/threads/control',
} as const;

/** True when the path is one request per requirement. */
export function isPerControlCollection(path: string): boolean {
  const pathname = (path.split('?')[0] ?? path).replace(/\/$/, '');
  return (
    /\/api\/improvements\/for\/[^/]+$/.test(pathname) || /\/api\/notes\/(?:control|pillar|run)\/[^/]+$/.test(pathname)
  );
}
