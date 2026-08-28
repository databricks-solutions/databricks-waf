// Where applicability decisions are kept.
//
// A decision is written twice at most: once when it is recorded, once if somebody revokes it. So it is
// stored the way accepted risks are — one row per revision, keyed on (id, revision) — and the revision
// does not need a field, because there are two and which one a record is at is visible in it: a revoked
// decision is revision 1 and one still standing is revision 0.
//
// A renewal is not a revision. It is a new decision naming the one it replaces, for the reason
// `applicability.ts` gives: an expiry somebody could push out would make a requirement excluded for two
// years read like a fresh decision.
//
// The key buys the same guarantee it buys for accepted risks. Two people exclude the same requirement
// at the same moment, or one person's second click arrives while the first is in flight; the database
// refuses the second write, and the caller learns it lost rather than replacing a decision that already
// names somebody else's reason and owner.

import { newestFirst, type ApplicabilityDecision } from './applicability.js';
import type { AssessmentScope } from '../store/assessment-scope.js';
import { inScope } from '../store/assessment-scope.js';

/**
 * Raised when a decision was revoked by somebody else first.
 *
 * Its own class rather than a generic conflict, so a route can answer 409 with the record's own words
 * instead of a stack trace about a primary key.
 */
export class AlreadyRevokedError extends Error {
  constructor(readonly id: string) {
    super(
      `Applicability decision ${id} was revoked by something else first. Re-read it rather than revoking it ` +
        'again — the reason and the date on record are the ones that count.'
    );
    this.name = 'AlreadyRevokedError';
  }
}

/**
 * Raised when somebody else recorded the same decision on the same requirement first.
 *
 * The rule `applicabilityFrom` enforces on read is enforced again here on write, by the database: two
 * people excluding one requirement in the same second both read nothing standing and both write the
 * first decision on it. Refusing the second keeps one requirement from carrying two decisions with two
 * owners and two expiry dates, neither of which is the one in force.
 */
export class AlreadyDecidedError extends Error {
  constructor(readonly controlId: string) {
    super(
      `Another applicability decision on ${controlId} was recorded first, so this one was not. Read what is on ` +
        'record — the requirement may already be excluded by somebody else, with a different owner and a ' +
        'different date.'
    );
    this.name = 'AlreadyDecidedError';
  }
}

/**
 * Raised when a decision is recorded under an id already on record.
 *
 * Nothing legitimate produces one: the id is minted server-side per request, so a retry mints a new one
 * and a repeated id is a bug or a replayed write. It is refused rather than allowed to replace, because
 * the record it would replace carries somebody's reason, owner and expiry — and the two stores disagreed
 * about this, Postgres refusing on its primary key while the in-memory one overwrote, under a shared test
 * that swallowed the difference.
 */
export class DecisionIdReusedError extends Error {
  constructor(readonly id: string) {
    super(
      `An applicability decision with id ${id} is already on record, so this write was refused rather than ` +
        'replacing it. Ids are minted per request, so this is a repeated write rather than a second decision.'
    );
    this.name = 'DecisionIdReusedError';
  }
}

/**
 * Raised when the decisions could not be read at all.
 *
 * Its own failure rather than an empty list, and the distinction is load-bearing rather than tidy: the
 * caller deciding whether a requirement may be excluded asks this store what is already on record, and
 * an unreadable answer read as "nothing" is how a second decision gets written over a standing one. It
 * also decides what leaves the score, so an unreadable read taken for "nothing excluded" would put a
 * requirement back into a figure a customer had deliberately taken it out of.
 */
export class DecisionsUnreadableError extends Error {
  constructor(operation: string, readonly cause: unknown) {
    super(
      `The applicability decisions could not be read (${operation}), so nothing here can say whether a ` +
        'requirement is already excluded. Try again once the database is reachable.'
    );
    this.name = 'DecisionsUnreadableError';
  }
}

export interface ApplicabilityStore {
  /** True when decisions survive a process restart. Surfaced in the UI, never assumed. */
  readonly durable: boolean;

  /**
   * Every decision on one requirement, newest first. Nothing is ever removed from this list.
   *
   * @throws DecisionsUnreadableError where the read failed, rather than answering as a requirement
   * nobody has ever excluded.
   */
  for(controlId: string, scope?: AssessmentScope): Promise<readonly ApplicabilityDecision[]>;

  /**
   * Every decision this install has, newest first.
   *
   * The read a register page and an export make. Bounded in practice by the number of requirements
   * times the number of times each has been renewed, the bound the accepted-risk register lives with.
   */
  all(scope?: AssessmentScope): Promise<readonly ApplicabilityDecision[]>;

  /**
   * Records a new decision.
   *
   * @throws AlreadyDecidedError where something else recorded the same decision on the same requirement
   * first.
   * @throws DecisionIdReusedError where the id is already on record, which nothing legitimate produces.
   */
  record(decision: ApplicabilityDecision): Promise<void>;

  /**
   * Records a revocation, refusing one that has already been revoked.
   *
   * @throws AlreadyRevokedError when something else revoked it first.
   */
  revoke(decision: ApplicabilityDecision): Promise<void>;
}

/**
 * Decisions in memory, for a demo and for tests.
 *
 * Keyed by id with the revoked row replacing the standing one, which is what the two Postgres rows
 * amount to on read.
 */
export class InMemoryApplicabilityStore implements ApplicabilityStore {
  readonly durable = false;

  private readonly decisions = new Map<string, ApplicabilityDecision>();

  for(controlId: string, scope?: AssessmentScope): Promise<readonly ApplicabilityDecision[]> {
    return Promise.resolve(
      newestFirst(
        [...this.decisions.values()].filter(
          (decision) => decision.controlId === controlId && inScope(decision.definitionId, scope)
        )
      )
    );
  }

  all(scope?: AssessmentScope): Promise<readonly ApplicabilityDecision[]> {
    return Promise.resolve(
      newestFirst([...this.decisions.values()].filter((decision) => inScope(decision.definitionId, scope)))
    );
  }

  record(decision: ApplicabilityDecision): Promise<void> {
    // Both constraints the Postgres store gets from the database, held here by hand so an install without
    // one behaves the same way. Both implementations answer the same questions or neither is tested.
    const taken = [...this.decisions.values()].some(
      (one) =>
        one.controlId === decision.controlId &&
        one.ordinal === decision.ordinal &&
        one.id !== decision.id &&
        (one.definitionId ?? null) === (decision.definitionId ?? null)
    );
    if (taken) return Promise.reject(new AlreadyDecidedError(decision.controlId));
    // The primary key. `set` replaced the record silently, which is the one difference between the two
    // stores that the shared test could not see: it wrote `.catch(() => undefined)` and so asserted the
    // opposite of its own name for whichever store was not the one it was written against.
    if (this.decisions.has(decision.id)) return Promise.reject(new DecisionIdReusedError(decision.id));

    this.decisions.set(decision.id, decision);
    return Promise.resolve();
  }

  revoke(decision: ApplicabilityDecision): Promise<void> {
    const stored = this.decisions.get(decision.id);
    if (stored?.revoked != null) return Promise.reject(new AlreadyRevokedError(decision.id));
    this.decisions.set(decision.id, decision);
    return Promise.resolve();
  }
}
