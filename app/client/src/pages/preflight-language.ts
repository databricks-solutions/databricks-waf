// Turning a preflight into the few sentences and one list a reader acts on.
//
// Its own module because the arithmetic is the point and it should be testable without a browser.
// The grouping is the whole design: the server reports per table, and per table is the wrong unit for
// somebody about to ask a metastore admin for something. Nine denied tables across two schemas are
// two requests, not nine, and a page that listed nine would make a two-line ask look like a project.

import type { Preflight, PreflightSource } from '@/api/types';

/** One thing to ask for, with what it buys. */
export interface Remedy {
  /** The statement, runnable as written. */
  readonly grant: string;
  /** Tables behind it, so a reader can see what they are being asked to open up. */
  readonly tables: readonly string[];
  /** Checks that would run once it is made. */
  readonly checks: number;
}

/**
 * What to ask for, most valuable first.
 *
 * Ordered by checks unblocked rather than by schema name, because the reader's question is which one
 * to chase first and a list sorted alphabetically answers a different one. Ties break on the grant
 * text so the order is stable between two reads of the same result.
 */
export function remediesFor(preflight: Preflight): readonly Remedy[] {
  const byGrant = new Map<string, { tables: Set<string>; checks: Set<string> }>();

  for (const source of preflight.sources) {
    if (source.grant == null) continue;
    const entry = byGrant.get(source.grant) ?? { tables: new Set<string>(), checks: new Set<string>() };
    entry.tables.add(source.table);
    // Only the checks this denial actually stops. `blocks` is every check that reads the table, and
    // for a table denied to this identity that is the same set — but taking it from `blocked` instead
    // would undercount, since a check blocked on two grants belongs to both.
    for (const controlId of source.blocks) {
      if (preflight.blocked.some((check) => check.controlId === controlId)) entry.checks.add(controlId);
    }
    byGrant.set(source.grant, entry);
  }

  return [...byGrant.entries()]
    .map(([grant, entry]) => ({ grant, tables: [...entry.tables].sort(), checks: entry.checks.size }))
    .sort((a, b) => b.checks - a.checks || a.grant.localeCompare(b.grant));
}

/**
 * Sources this panel has no grant to offer for, which it has to present differently.
 *
 * Separated because the reader's next action differs and lumping them together sends somebody to a
 * metastore admin for a schema that is not enabled, or for a warehouse that was merely asleep.
 *
 * A denial with no grant beside it belongs here too. The server declines to build one for an identity
 * it cannot quote safely, and such a source is in neither `remediesFor` nor the absent-and-unknown
 * set — so without this it would appear nowhere but the disclosure, leaving the verdict's count of
 * blocked checks larger than anything the page accounted for.
 */
export function unfixable(preflight: Preflight): readonly PreflightSource[] {
  return preflight.sources.filter(
    (source) => source.reading === 'absent' || source.reading === 'unknown' || (source.reading === 'denied' && source.grant == null),
  );
}

/** What a reading means, in the terms of what to do about it. */
export function describeReading(source: PreflightSource): string {
  switch (source.reading) {
    case 'readable':
      return 'Readable.';
    case 'denied':
      return source.grant == null
        ? 'Refused for want of a grant, which this app will not write out: the identity it ran as cannot be quoted as a ' +
            'single SQL identifier, so any statement here would be one to debug rather than one to run.'
        : 'Refused for want of a grant.';
    case 'absent':
      return 'Not present on this metastore. The system schema has to be enabled before anything can be granted on it.';
    case 'unknown':
      return 'Failed for a reason this app does not recognise, so it offers no remedy. The platform’s own words are below.';
  }
}

/**
 * Why a workspace in scope will not be measured.
 *
 * Worded as the state of the workspace rather than as an error, because two of the three are not
 * faults: a stopped workspace has nothing to read and a workspace in another region is unreachable
 * from this host by design. Only the third is a gap, and it says so.
 */
export function describeOmission(reason: 'not-running' | 'other-region' | 'unknown'): string {
  switch (reason) {
    case 'not-running':
      return 'Not running, so there is nothing to read.';
    case 'other-region':
      return 'In another region, which this host cannot reach.';
    case 'unknown':
      return 'Named in this assessment but not in the directory the last scan read, so it may have been deleted or renamed.';
  }
}

/**
 * When the two halves of a preflight were true, said as one sentence.
 *
 * The grants were checked in the request the reader just made; the scope was resolved against
 * whatever directory the last scan read. Presenting one date would let somebody act on a month-old
 * estate believing it had just been checked, which is the failure this sentence exists to prevent.
 */
export function describeFreshness(preflight: Preflight, now: Date = new Date()): string {
  const checked = `Grants checked ${describeWhen(new Date(preflight.ranAt), now)}, as ${preflight.ranAs}.`;
  // One date when there is only one. The verdict above already says the scope is unresolved and why,
  // and repeating it here put the same fact in two adjacent lines.
  if (preflight.scopeAsOf == null) return checked;
  return `${checked} The estate it is held against was read ${describeWhen(new Date(preflight.scopeAsOf), now)}.`;
}

function describeWhen(at: Date, now: Date): string {
  const days = Math.floor((now.getTime() - at.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${String(days)} days ago`;
  return `on ${at.toLocaleDateString()}`;
}
