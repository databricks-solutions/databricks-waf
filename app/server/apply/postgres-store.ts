// Durable applicability decisions, in the Lakebase schema the app owns.
//
// One table, insert-only, two rows per decision at most: revision 0 as recorded and revision 1 once
// revoked. Reads take both and keep the higher, the way the accepted risks and the improvement actions
// do, and for the same reason — the in-memory store has to answer identically, and one implementation
// of "the newest one" cannot drift from itself.
//
// `control_id` and `expires_at` are indexed copies of two facts already in the body. Both earn it: the
// decisions on a requirement are read wherever that requirement is scored, and the register is read in
// expiry order, which is the order somebody reviewing them works in.

import { digestOf } from '../records/digest.js';
import type { Postgres } from '../store/postgres.js';
import { newestFirst, type ApplicabilityDecision, type ApplicabilityLever } from './applicability.js';
import { applyScope, type AssessmentScope } from '../store/assessment-scope.js';
import {
  AlreadyDecidedError,
  AlreadyRevokedError,
  DecisionIdReusedError,
  DecisionsUnreadableError,
  type ApplicabilityStore,
} from './store.js';

/** Postgres' code for a unique or primary key violation. */
const UNIQUE_VIOLATION = '23505';

export interface PostgresApplicabilityStoreOptions {
  readonly db: Postgres;
  readonly onError?: (operation: string, error: unknown) => void;
}

export class PostgresApplicabilityStore implements ApplicabilityStore {
  readonly durable = true;

  constructor(private readonly options: PostgresApplicabilityStoreOptions) {}

  async for(controlId: string, scope?: AssessmentScope): Promise<readonly ApplicabilityDecision[]> {
    const operation = `read applicability decisions for ${controlId}`;
    const scoped = applyScope('where control_id = $1 order by revision asc', [controlId], scope);
    const rows = await this.read<{ body: unknown }>(
      operation,
      `select body from ${this.options.db.schema}.applicability_decisions ${scoped.fragment}`,
      scoped.values
    );
    return newestFirst(this.highest(rows.map((row) => row.body), operation));
  }

  async all(scope?: AssessmentScope): Promise<readonly ApplicabilityDecision[]> {
    const operation = 'read applicability decisions';
    const scoped = applyScope('order by revision asc', [], scope);
    const rows = await this.read<{ body: unknown }>(
      operation,
      `select body from ${this.options.db.schema}.applicability_decisions ${scoped.fragment}`,
      scoped.values
    );
    return newestFirst(this.highest(rows.map((row) => row.body), operation));
  }

  record(decision: ApplicabilityDecision): Promise<void> {
    return this.write(decision);
  }

  revoke(decision: ApplicabilityDecision): Promise<void> {
    return this.write(decision);
  }

  private async write(decision: ApplicabilityDecision): Promise<void> {
    const { db } = this.options;
    const isRevoked = decision.revoked != null;
    // The revision is the state rather than a field. See store.ts.
    const revision = isRevoked ? 1 : 0;

    try {
      await db.query(
        `insert into ${db.schema}.applicability_decisions
           (id, revision, control_id, lever, ordinal, owner, effective_from, expires_at, recorded_at,
            revoked, body, digest, definition_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)`,
        [
          decision.id,
          revision,
          decision.controlId,
          decision.lever,
          decision.ordinal,
          decision.owner,
          decision.effectiveFrom,
          decision.expiresAt,
          decision.recordedAt,
          isRevoked,
          JSON.stringify(decision),
          digestOf(decision),
          decision.definitionId ?? null,
        ]
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      // Which constraint decides which sentence. The key is (id, revision): a collision there on the
      // revoking write is somebody else having revoked this first, and on the recording write it is a
      // repeated id, which nothing legitimate produces. The other constraint is the requirement and its
      // ordinal, and a collision there is two people excluding one requirement at the same moment.
      if (!onTheKey(error)) throw new AlreadyDecidedError(decision.controlId);
      if (isRevoked) throw new AlreadyRevokedError(decision.id);
      // A repeated id on the recording write. Named rather than raised as the driver's error, so the
      // in-memory store can refuse it the same way and a shared test can hold the two to it.
      throw new DecisionIdReusedError(decision.id);
    }
  }

  /**
   * A read, or a raised failure.
   *
   * Reported *and* raised, unlike the history stores here and for the reason the accepted-risk store
   * gives: a caller deciding whether a requirement may be excluded asks this store what is on record,
   * and an unreadable answer read as "nothing excluded" is how a second decision gets written over a
   * standing one — and, once 31f wires it, how a requirement a customer took out of their score gets put
   * back into it because a column would not read.
   */
  private async read<T>(operation: string, text: string, values: readonly unknown[]): Promise<T[]> {
    try {
      const { rows } = await this.options.db.query<T>(text, values);
      return rows;
    } catch (error) {
      this.options.onError?.(operation, error);
      throw new DecisionsUnreadableError(operation, error);
    }
  }

  /**
   * The newest readable revision of each decision, with unreadable rows counted rather than thrown on.
   *
   * An unreadable revocation row leaves the decision reading as standing, which keeps a requirement out
   * of the score on a decision somebody has already ended. That is the wrong direction, so it is
   * reported: whoever reads the log gets a count, and dropping the decision instead would put the
   * requirement back into the score with no record it had ever been excluded, which is worse in the same
   * way but silently.
   */
  private highest(rows: readonly unknown[], operation: string): ApplicabilityDecision[] {
    const revived = rows.map(revive);
    const unreadable = revived.filter((decision) => decision == null).length;
    if (unreadable > 0) {
      this.options.onError?.(
        operation,
        new Error(`${String(unreadable)} stored applicability-decision row(s) could not be read`)
      );
    }

    const newest = new Map<string, ApplicabilityDecision>();
    // Read in ascending revision order, so a later row is always the better one.
    for (const decision of revived) {
      if (decision != null) newest.set(decision.id, decision);
    }
    return [...newest.values()];
  }
}

const LEVERS = new Set<ApplicabilityLever>(['not-applicable', 'disabled']);

function revive(raw: unknown): ApplicabilityDecision | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const candidate = raw as ApplicabilityDecision & {
    effectiveFrom: string | Date;
    expiresAt: string | Date;
    recordedAt: string | Date;
    revoked?: { by: string; at: string | Date; reason: string };
  };

  if (typeof candidate.id !== 'string' || typeof candidate.controlId !== 'string') return undefined;
  if (typeof candidate.reason !== 'string' || typeof candidate.owner !== 'string') return undefined;
  if (typeof candidate.recordedBy !== 'string') return undefined;
  if (!LEVERS.has(candidate.lever)) return undefined;

  const effectiveFrom = date(candidate.effectiveFrom);
  const expiresAt = date(candidate.expiresAt);
  const recordedAt = date(candidate.recordedAt);
  // All three decide whether the decision is in force, so a row missing any of them is unreadable rather
  // than dated now: a decision whose expiry defaulted to this moment would read as expired and put a
  // requirement back into the score with no reason anybody could give.
  if (effectiveFrom == null || expiresAt == null || recordedAt == null) return undefined;

  if (candidate.revoked == null) {
    return { ...candidate, effectiveFrom, expiresAt, recordedAt };
  }

  const revokedAt = date(candidate.revoked.at);
  // A revocation whose date will not parse is not read as a decision still standing: that would keep a
  // requirement out of the score on a decision somebody has already ended.
  if (revokedAt == null) return undefined;

  return {
    ...candidate,
    effectiveFrom,
    expiresAt,
    recordedAt,
    revoked: { ...candidate.revoked, at: revokedAt },
  };
}

function date(value: string | Date): Date | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error != null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

/**
 * Whether the violation was the primary key rather than the one-at-a-time constraint.
 *
 * By name, which Postgres sends, rather than by parsing the message. Anything that does not name a key
 * is read as the other constraint: a violation this app cannot attribute is better reported as a lost
 * race, which asks the caller to look, than as a repeated id, which asks them to file a bug.
 */
function onTheKey(error: unknown): boolean {
  const constraint = (error as { constraint?: unknown }).constraint;
  return typeof constraint === 'string' && constraint.endsWith('_pkey');
}
