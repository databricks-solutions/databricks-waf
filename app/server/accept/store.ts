// Where accepted risks are kept.
//
// An acceptance is written twice at most: once when it is recorded, once if somebody revokes it. So it
// is stored the way validation attempts are — one row per revision, keyed on (id, revision) — and the
// revision does not need a field, because there are two and which one a record is at is visible in the
// record: a revoked acceptance is revision 1 and one still standing is revision 0.
//
// A renewal is not a revision. It is a new acceptance naming the one it replaces, for the reason
// `risk.ts` gives: an expiry somebody could push out would make a risk carried for two years read like
// a fresh decision.
//
// The key buys the same guarantee it buys there. Two people revoke the same acceptance at the same
// moment, or the same person's second click arrives while the first is in flight; the database refuses
// the second write, and the caller learns that it lost rather than replacing a revocation that already
// names somebody else's reason. Who ended an acceptance, when, and why is the part of this record an
// auditor comes back for, and it is not something to let a race decide.

import { newestFirst, type AcceptedRisk } from './risk.js';
import type { AssessmentScope } from '../store/assessment-scope.js';
import { inScope } from '../store/assessment-scope.js';

/**
 * Raised when an acceptance was revoked by somebody else first.
 *
 * Its own class rather than a generic conflict, so a route can answer 409 with the record's own words
 * instead of a stack trace about a primary key.
 */
export class AlreadyRevokedError extends Error {
  constructor(readonly id: string) {
    super(
      `Accepted risk ${id} was revoked by something else first. Re-read it rather than revoking it again — the ` +
        'reason and the date on record are the ones that count.'
    );
    this.name = 'AlreadyRevokedError';
  }
}

/**
 * Raised when somebody else recorded the same acceptance of the same requirement first.
 *
 * The rule `riskFrom` enforces on read is enforced again here on write, by the database rather than by
 * this app: two people accepting one requirement in the same second both read nothing standing and both
 * write the first acceptance of it. Refusing the second is what keeps one requirement from carrying two
 * acceptances with two owners, two reasons and two expiry dates, neither of which is the one in force.
 */
export class AlreadyAcceptedError extends Error {
  constructor(readonly controlId: string) {
    super(
      `Another acceptance of ${controlId} was recorded first, so this one was not. Read what is on record — the ` +
        'requirement may already be accepted by somebody else, with a different owner and a different date.'
    );
    this.name = 'AlreadyAcceptedError';
  }
}

/**
 * Raised when the acceptances could not be read at all.
 *
 * Its own failure rather than an empty list, and the distinction is load-bearing rather than tidy: the
 * caller deciding whether a requirement may be accepted asks this store what is already on record, and
 * an unreadable answer read as "nothing" is how a second acceptance gets written over a standing one.
 * The register has the weaker version of the same problem — an estate with no exceptions and an estate
 * whose exceptions cannot be read look identical, and only one of them is good news.
 */
export class RisksUnreadableError extends Error {
  constructor(operation: string, readonly cause: unknown) {
    super(
      `The accepted risks could not be read (${operation}), so nothing here can say whether a requirement is ` +
        'already accepted. Try again once the database is reachable.'
    );
    this.name = 'RisksUnreadableError';
  }
}

export interface RiskStore {
  /** True when acceptances survive a process restart. Surfaced in the UI, never assumed. */
  readonly durable: boolean;

  /**
   * Every acceptance of one requirement, newest first. Nothing is ever removed from this list.
   *
   * @throws RisksUnreadableError where the read failed, rather than answering as a requirement nobody
   * has ever accepted.
   */
  for(controlId: string, scope?: AssessmentScope): Promise<readonly AcceptedRisk[]>;

  /**
   * Every acceptance this install has, newest first.
   *
   * The read a register page and an export make. Unbounded in principle and bounded in practice by the
   * number of requirements in the catalogue times the number of times each has been renewed, which is
   * the same bound the decisions list has lived with.
   */
  all(scope?: AssessmentScope): Promise<readonly AcceptedRisk[]>;

  /**
   * Records a new acceptance.
   *
   * @throws AlreadyAcceptedError where something else recorded the same acceptance of the same
   * requirement first.
   */
  record(risk: AcceptedRisk): Promise<void>;

  /**
   * Records a revocation, refusing one that has already been revoked.
   *
   * @throws AlreadyRevokedError when something else revoked it first.
   */
  revoke(risk: AcceptedRisk): Promise<void>;
}

/**
 * Acceptances in memory, for a demo and for tests.
 *
 * Keyed by id with the revoked row replacing the standing one, which is what the two Postgres rows
 * amount to on read.
 */
export class InMemoryRiskStore implements RiskStore {
  readonly durable = false;

  private readonly risks = new Map<string, AcceptedRisk>();

  for(controlId: string, scope?: AssessmentScope): Promise<readonly AcceptedRisk[]> {
    return Promise.resolve(
      newestFirst(
        [...this.risks.values()].filter((risk) => risk.controlId === controlId && inScope(risk.definitionId, scope))
      )
    );
  }

  all(scope?: AssessmentScope): Promise<readonly AcceptedRisk[]> {
    return Promise.resolve(newestFirst([...this.risks.values()].filter((risk) => inScope(risk.definitionId, scope))));
  }

  record(risk: AcceptedRisk): Promise<void> {
    // The constraint the Postgres store gets from the database, held here by hand so an install without
    // one behaves the same way. Both implementations answer the same questions or neither is tested.
    const taken = [...this.risks.values()].some(
      (one) =>
        one.controlId === risk.controlId &&
        one.ordinal === risk.ordinal &&
        one.id !== risk.id &&
        (one.definitionId ?? null) === (risk.definitionId ?? null)
    );
    if (taken) return Promise.reject(new AlreadyAcceptedError(risk.controlId));

    this.risks.set(risk.id, risk);
    return Promise.resolve();
  }

  revoke(risk: AcceptedRisk): Promise<void> {
    const stored = this.risks.get(risk.id);
    if (stored?.revoked != null) return Promise.reject(new AlreadyRevokedError(risk.id));
    this.risks.set(risk.id, risk);
    return Promise.resolve();
  }
}
