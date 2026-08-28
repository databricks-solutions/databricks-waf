// Which acts are being read, held in the address bar.
//
// The trail is filtered where it is stored (ADR 0049), so every control on the page is a query
// parameter and each control is a transformation of the URL. Those transformations are here rather
// than inline in the page for one reason: each of them is a rule about what happens to the *other*
// parameters, and getting one wrong shows the reader an empty page that looks like an absence of
// matching acts. A filter that keeps the cursor, a pager that replaces instead of pushes, a clear
// that misses a parameter the page has no control for — all three are silent.
//
// They are also the whole of what a reader can cite. An auditor's finding is "at 09:41 this person
// was refused", and the evidence is an address a second person can open, so what these functions
// put in the address is the evidence.

/**
 * Everything in the URL that narrows what is read, including the cursor.
 *
 * The whole set the store accepts rather than the three the filter strip offers, because the request is
 * built from the URL: an address carrying `since` or `correlation` — hand-written, or sent by somebody
 * who built it from the API — narrows the trail just as much, and a page that only knew about its own
 * three controls would render such an address's empty result as "nothing has been done yet" and offer
 * no way back. `before` is in the list for the same reason: a shared cursor stops resolving once
 * retention has trimmed past it (ADR 0048), and the reader needs to be told that rather than shown an
 * empty page with no pager on it.
 */
export const NARROWING = ['actor', 'action', 'outcome', 'target', 'since', 'until', 'correlation', 'before'] as const;

/** The value a select carries when it is not narrowing anything. Not a parameter; never written. */
export const ALL = 'all';

/**
 * A filter set or cleared, back at the newest page.
 *
 * The cursor is dropped on every filter change, and not dropping it is a subtle way to show a reader
 * nothing: `before=12` under a filter whose matches are all above 12 is an empty page that reads as
 * an absence of matching acts rather than as a stale cursor.
 */
export function withFilter(params: URLSearchParams, key: string, value: string): URLSearchParams {
  const next = new URLSearchParams(params);
  if (value === '' || value === ALL) next.delete(key);
  else next.set(key, value);
  next.delete('before');
  return next;
}

/** A page of the chain, by the cursor the server gave, or the newest when there is none. */
export function atPage(params: URLSearchParams, cursor?: number): URLSearchParams {
  const next = new URLSearchParams(params);
  if (cursor == null) next.delete('before');
  else next.set('before', String(cursor));
  return next;
}

/**
 * Every narrowing dropped, and nothing else.
 *
 * Not `new URLSearchParams()`: a parameter this page does not filter by is somebody else's, and a
 * clear button that emptied the query string would take it with them.
 */
export function withoutNarrowing(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const filter of NARROWING) next.delete(filter);
  return next;
}

/**
 * Whether the URL asks for less than the whole trail.
 *
 * Every parameter is compared rather than the three the filter strip offers, because everything the
 * store accepts reaches it: the request is built from the URL, so `since`, `until` and `correlation`
 * are forwarded whether or not this page has a control for them. A hand-written or shared address
 * carrying one of those, matching nothing, would otherwise render "nothing has been done yet" on an
 * install with a full trail — and the clear button would not remove the parameter that caused it.
 */
export function isNarrowed(params: URLSearchParams): boolean {
  return NARROWING.some((filter) => params.get(filter) != null);
}

/**
 * The request, which is the address plus how many rows the window holds.
 *
 * `limit` is the one thing the request has and the address does not. The URL states what is being
 * read — which acts, and from where in the chain — and the page size is not part of that: it is a
 * presentation bound rather than audit state. A shared address therefore preserves the filters and
 * cursor while the caller supplies the supported server-page limit.
 */
export function requested(params: URLSearchParams, limit: number): string {
  const asked = new URLSearchParams(params);
  asked.set('limit', String(limit));
  return asked.toString();
}
