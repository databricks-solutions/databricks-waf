// Where validation attempts are kept.
//
// An attempt is written twice and no more: once when somebody asks for it, once when something answers
// it. So it is stored the way plans and actions are — one row per revision, keyed on (id, revision) —
// and the revision does not need a field, because there are only two and which one a record is at is
// visible in the record: an attempt with an answer is revision 1 and an attempt without one is
// revision 0. A number that can be derived from the thing it describes, and can only ever take two
// values, is a number better not stored twice.
//
// That key buys the one guarantee this record needs beyond being kept. Two instances of this app both
// notice the same finished run and both try to answer the same outstanding attempt; the database
// refuses the second, and the second learns that it lost rather than overwriting an answer that
// already cites a run. Without it the resolution path would need a lock, and a lock held by a web
// process is a lock that outlives the process holding it.

import type { ValidationAttempt } from './attempt.js';
import { newestFirst } from './attempt.js';

/**
 * Raised when something else answered an attempt first.
 *
 * Its own class rather than a generic conflict, because the caller's response is specific: the
 * resolution path treats it as somebody else's success and moves on, where a route surfaces it. Named
 * for what happened rather than for the constraint that caught it — "duplicate key on
 * validation_attempts" tells whoever reads the log nothing about validations.
 */
export class AlreadyAnsweredError extends Error {
  constructor(readonly id: string) {
    super(`Validation ${id} was answered by something else first. Re-read it rather than answering again.`);
    this.name = 'AlreadyAnsweredError';
  }
}

export interface ValidationStore {
  /** True when attempts survive a process restart. Surfaced in the UI, never assumed. */
  readonly durable: boolean;

  /** Every attempt against one action, newest first. Nothing is ever removed from this list. */
  for(actionId: string): Promise<readonly ValidationAttempt[]>;

  /**
   * Every attempt still waiting to be answered, across every action.
   *
   * The read the resolution path makes after a run finishes, which is why it is a query rather than a
   * filter over `for`: the path does not know which actions have claims outstanding, and asking per
   * action would mean reading every action first to ask about the ones that have never been offered.
   */
  outstanding(): Promise<readonly ValidationAttempt[]>;

  /** Records a requested attempt. */
  add(attempt: ValidationAttempt): Promise<void>;

  /**
   * Records the answer, refusing one that has already been answered.
   *
   * Refusing rather than ignoring, unlike a note's duplicate id: two answers to one attempt are two
   * different readings of the estate, and the second arriving silently would leave whoever produced it
   * believing a run they read is the run on record.
   *
   * @throws AlreadyAnsweredError when something else answered it first.
   */
  answer(attempt: ValidationAttempt): Promise<void>;
}

/**
 * Attempts in memory, for a demo and for tests.
 *
 * Keyed by id with the answered row replacing the outstanding one, which is what the two Postgres rows
 * amount to on read. The revision is not modelled here for the same reason it is not stored: there are
 * two states and the record shows which it is in.
 */
export class InMemoryValidationStore implements ValidationStore {
  readonly durable = false;

  private readonly attempts = new Map<string, ValidationAttempt>();

  for(actionId: string): Promise<readonly ValidationAttempt[]> {
    return Promise.resolve(
      newestFirst([...this.attempts.values()].filter((attempt) => attempt.actionId === actionId))
    );
  }

  outstanding(): Promise<readonly ValidationAttempt[]> {
    return Promise.resolve(newestFirst([...this.attempts.values()].filter((attempt) => attempt.answer == null)));
  }

  add(attempt: ValidationAttempt): Promise<void> {
    this.attempts.set(attempt.id, attempt);
    return Promise.resolve();
  }

  answer(attempt: ValidationAttempt): Promise<void> {
    const stored = this.attempts.get(attempt.id);
    if (stored?.answer != null) return Promise.reject(new AlreadyAnsweredError(attempt.id));
    this.attempts.set(attempt.id, attempt);
    return Promise.resolve();
  }
}
