// Durable validation attempts, in the Lakebase schema the app owns.
//
// One table, insert-only, two rows per attempt at most: revision 0 as requested and revision 1 once
// answered. Reads take both and keep the higher, the way `improvement_actions` does, and for the same
// reason — the in-memory store has to answer identically, and one implementation of "the newest one"
// cannot drift from itself.
//
// `action_id` and `answered` are indexed copies of two facts already in the body. Both earn it: an
// action's attempts are read on every page that shows the action, and `outstanding` is read after every
// finished run. Neither is proportional to what is outstanding — see `outstanding` for why that is not
// available without a second record of the same fact, and why the bound that is available is small.

import { digestOf } from '../records/digest.js';
import type { Postgres } from '../store/postgres.js';
import type { AttemptAnswer, AttemptCheck, ValidationAttempt } from './attempt.js';
import { newestFirst } from './attempt.js';
import { AlreadyAnsweredError, type ValidationStore } from './store.js';

/** Postgres' code for a unique or primary key violation. */
const UNIQUE_VIOLATION = '23505';

export interface PostgresValidationStoreOptions {
  readonly db: Postgres;
  /**
   * The plan an attempt belongs to, for the column retention measures its age from.
   *
   * A function rather than a date passed in by the caller, because the caller answering an attempt is
   * the resolution path — which holds a run and a list of attempts, and has no reason to hold plans.
   * Undefined for a plan that has gone, which is treated as the attempt's own date below.
   */
  readonly planCreatedAt?: (planId: string) => Promise<Date | undefined>;
  readonly onError?: (operation: string, error: unknown) => void;
}

export class PostgresValidationStore implements ValidationStore {
  readonly durable = true;

  constructor(private readonly options: PostgresValidationStoreOptions) {}

  async for(actionId: string): Promise<readonly ValidationAttempt[]> {
    const operation = `read validations of action ${actionId}`;
    const rows = await this.read<{ body: unknown }>(
      operation,
      `select body from ${this.options.db.schema}.validation_attempts where action_id = $1 order by revision asc`,
      [actionId]
    );
    if (rows == null) return [];
    return newestFirst(
      this.highest(
        rows.map((row) => row.body),
        operation
      )
    );
  }

  async outstanding(): Promise<readonly ValidationAttempt[]> {
    const operation = 'read outstanding validations';
    const { schema } = this.options.db;
    /*
     * The exclusion is the correctness of this method rather than an optimisation, and it is in SQL
     * rather than in the reduction because of what it costs there.
     *
     * An answer is a second row rather than a change to the first, so the revision-0 row of an
     * answered attempt carries `answered = false` for ever. Narrowing on that column alone hands back
     * every attempt this install has ever answered, and the run reading them answers each again: the
     * same claim validated twice against two different runs, with the second write failing on the key
     * if it is lucky and reporting a lost race if it is not.
     *
     * This used to read both sides and subtract them here — every unanswered-flagged body, and every
     * answered id — which is proportional to how many validations have ever been *asked for* rather
     * than to how many are open. Measured at the volume `history-volume.ts` derives, that was 22,080
     * rows fetched to answer with 192, the worst ratio in
     * [the budget](../../../docs/design/history-read-budget.md). `not exists` asks the same question
     * of the same rows one statement earlier, and the answer it sends is the outstanding attempts.
     */
    const requested = await this.read<{ body: unknown }>(
      operation,
      `select a.body
         from ${schema}.validation_attempts a
        where a.answered = $1
          and not exists (
                select 1
                  from ${schema}.validation_attempts b
                 where b.id = a.id
                   and b.answered = $2
              )
        order by a.revision asc`,
      [false, true]
    );
    if (requested == null) return [];

    const current = this.highest(
      requested.map((row) => row.body),
      operation
    );
    // Still filtered on the body, and the predicate above does not replace this one: `answered` is a
    // copy of what the body says, and a row whose column disagrees with its body was written by
    // something that is not this file. What moved into SQL is the subtraction, not the belief.
    return newestFirst(current.filter((attempt) => attempt.answer == null));
  }

  add(attempt: ValidationAttempt): Promise<void> {
    return this.write(attempt);
  }

  answer(attempt: ValidationAttempt): Promise<void> {
    return this.write(attempt);
  }

  private async write(attempt: ValidationAttempt): Promise<void> {
    const { db } = this.options;
    const answered = attempt.answer != null;
    // The revision is the state rather than a field. See store.ts.
    const revision = answered ? 1 : 0;
    const planCreatedAt = (await this.options.planCreatedAt?.(attempt.planId)) ?? attempt.requestedAt;

    try {
      await db.query(
        `insert into ${db.schema}.validation_attempts
           (id, revision, action_id, plan_id, plan_created_at, requested_at, answered, body, digest)
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
        [
          attempt.id,
          revision,
          attempt.actionId,
          attempt.planId,
          planCreatedAt,
          attempt.requestedAt,
          answered,
          JSON.stringify(attempt),
          digestOf(attempt),
        ]
      );
    } catch (error) {
      // The only failure translated rather than raised, and only on the answering write: a duplicate
      // key at revision 1 is another instance having answered this attempt first, which the resolution
      // path treats as somebody else's success. A duplicate at revision 0 is a repeated request id,
      // which nothing legitimate produces, so it reaches the caller as itself.
      if (answered && isUniqueViolation(error)) throw new AlreadyAnsweredError(attempt.id);
      throw error;
    }
  }

  /**
   * A read, or undefined where it failed.
   *
   * Undefined rather than an empty list, because the two mean different things to the caller here:
   * `outstanding` reads twice and a failure of either has to stop the pass, where an empty result is
   * an answer. A failed read is reported through `onError` and nothing throws, as every other store
   * here behaves — the consequence being that a resolution pass which cannot read answers nothing and
   * the next run answers instead. Late is the right way for this to fail; the alternative is a scan's
   * own completion path holding an error about validations.
   */
  private async read<T>(operation: string, text: string, values: readonly unknown[]): Promise<T[] | undefined> {
    try {
      const { rows } = await this.options.db.query<T>(text, values);
      return rows;
    } catch (error) {
      this.options.onError?.(operation, error);
      return undefined;
    }
  }

  /**
   * The newest readable revision of each attempt, with unreadable rows counted rather than thrown on.
   *
   * An unreadable answer row leaves the attempt reading as outstanding, which is visible and wrong in
   * the safe direction: it will be offered to the next run, and answering it again writes the row that
   * would not revive. Dropping the attempt entirely would lose the record that a claim was ever
   * checked.
   */
  private highest(rows: readonly unknown[], operation: string): ValidationAttempt[] {
    const revived = rows.map(revive);
    const unreadable = revived.filter((attempt) => attempt == null).length;
    if (unreadable > 0) {
      this.options.onError?.(
        operation,
        new Error(`${String(unreadable)} stored validation row(s) could not be read`)
      );
    }

    const newest = new Map<string, ValidationAttempt>();
    // Read in ascending revision order, so a later row is always the better one and no comparison is
    // needed here.
    for (const attempt of revived) {
      if (attempt != null) newest.set(attempt.id, attempt);
    }
    return [...newest.values()];
  }
}

function revive(raw: unknown): ValidationAttempt | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const candidate = raw as ValidationAttempt & {
    claimedAt: string | Date;
    requestedAt: string | Date;
    observeFrom: string | Date;
    answer?: AttemptAnswer & { at: string | Date };
  };
  if (typeof candidate.id !== 'string' || typeof candidate.actionId !== 'string') return undefined;
  if (typeof candidate.planId !== 'string' || typeof candidate.requestedBy !== 'string') return undefined;
  if (typeof candidate.observeDays !== 'number') return undefined;

  // Checked through a widened view of the property rather than on the property itself, because
  // `Array.isArray` narrows to `any[]` and would leave every read of a check below unchecked.
  if (!Array.isArray((candidate as { checks?: unknown }).checks)) return undefined;
  const checks: readonly AttemptCheck[] = candidate.checks;
  if (checks.some((check) => typeof check.controlId !== 'string' || typeof check.method !== 'string')) {
    return undefined;
  }

  const claimedAt = date(candidate.claimedAt);
  const requestedAt = date(candidate.requestedAt);
  const observeFrom = date(candidate.observeFrom);
  // All three decide whether a run may answer this attempt, so a row missing any of them is
  // unreadable rather than dated now: an attempt whose window began this moment would accept the next
  // run whatever it measured, which is the failure the window exists to stop.
  if (claimedAt == null || requestedAt == null || observeFrom == null) return undefined;

  if (candidate.answer == null) {
    return { ...candidate, claimedAt, requestedAt, observeFrom };
  }

  const answeredAt = date(candidate.answer.at);
  // An answer whose date will not parse is not read as an unanswered attempt: that would offer it to
  // the next run and produce a second answer to a question already settled.
  if (answeredAt == null) return undefined;

  return {
    ...candidate,
    claimedAt,
    requestedAt,
    observeFrom,
    answer: { ...candidate.answer, at: answeredAt },
  };
}

function date(value: string | Date): Date | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error != null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}
