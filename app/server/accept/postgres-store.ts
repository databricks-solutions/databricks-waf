// Durable accepted risks, in the Lakebase schema the app owns.
//
// One table, insert-only, two rows per acceptance at most: revision 0 as recorded and revision 1 once
// revoked. Reads take both and keep the higher, the way the validation attempts and the improvement
// actions do, and for the same reason — the in-memory store has to answer identically, and one
// implementation of "the newest one" cannot drift from itself.
//
// `control_id` and `expires_at` are indexed copies of two facts already in the body. Both earn it: the
// acceptances of a requirement are read wherever that requirement is shown, and the register is read in
// expiry order, which is the order somebody reviewing them works in.

import { digestOf } from '../records/digest.js';
import type { Postgres } from '../store/postgres.js';
import { newestFirst, type AcceptedRisk, type ResidualRisk } from './risk.js';
import { AlreadyAcceptedError, AlreadyRevokedError, RisksUnreadableError, type RiskStore } from './store.js';
import { applyScope, type AssessmentScope } from '../store/assessment-scope.js';

/** Postgres' code for a unique or primary key violation. */
const UNIQUE_VIOLATION = '23505';

export interface PostgresRiskStoreOptions {
  readonly db: Postgres;
  readonly onError?: (operation: string, error: unknown) => void;
}

export class PostgresRiskStore implements RiskStore {
  readonly durable = true;

  constructor(private readonly options: PostgresRiskStoreOptions) {}

  async for(controlId: string, scope?: AssessmentScope): Promise<readonly AcceptedRisk[]> {
    const operation = `read accepted risks for ${controlId}`;
    const scoped = applyScope('where control_id = $1 order by revision asc', [controlId], scope);
    const rows = await this.read<{ body: unknown }>(
      operation,
      `select body from ${this.options.db.schema}.accepted_risks ${scoped.fragment}`,
      scoped.values
    );
    return newestFirst(this.highest(rows.map((row) => row.body), operation));
  }

  async all(scope?: AssessmentScope): Promise<readonly AcceptedRisk[]> {
    const operation = 'read accepted risks';
    const scoped = applyScope('order by revision asc', [], scope);
    const rows = await this.read<{ body: unknown }>(
      operation,
      `select body from ${this.options.db.schema}.accepted_risks ${scoped.fragment}`,
      scoped.values
    );
    return newestFirst(this.highest(rows.map((row) => row.body), operation));
  }

  record(risk: AcceptedRisk): Promise<void> {
    return this.write(risk);
  }

  revoke(risk: AcceptedRisk): Promise<void> {
    return this.write(risk);
  }

  private async write(risk: AcceptedRisk): Promise<void> {
    const { db } = this.options;
    const isRevoked = risk.revoked != null;
    // The revision is the state rather than a field. See store.ts.
    const revision = isRevoked ? 1 : 0;

    try {
      await db.query(
        `insert into ${db.schema}.accepted_risks
           (id, revision, control_id, ordinal, owner, residual, effective_from, expires_at, recorded_at,
            revoked, body, digest, definition_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)`,
        [
          risk.id,
          revision,
          risk.controlId,
          risk.ordinal,
          risk.owner,
          risk.residual,
          risk.effectiveFrom,
          risk.expiresAt,
          risk.recordedAt,
          isRevoked,
          JSON.stringify(risk),
          digestOf(risk),
          risk.definitionId ?? null,
        ]
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      // Which constraint decides which sentence, and the two are different situations rather than two
      // phrasings of one. The key is (id, revision): a collision there on the revoking write is somebody
      // else having revoked this first, and on the recording write it is a repeated id, which nothing
      // legitimate produces. The other constraint is the requirement and its ordinal, and a collision
      // there is two people accepting one requirement at the same moment.
      if (!onTheKey(error)) throw new AlreadyAcceptedError(risk.controlId);
      if (isRevoked) throw new AlreadyRevokedError(risk.id);
      throw error;
    }
  }

  /**
   * A read, or a raised failure.
   *
   * Reported *and* raised, which is not how the other stores here behave and is deliberate. Every one of
   * them answers a failed read as an empty list, on the argument that a degraded history is better than
   * a broken page. That argument does not survive this record: a caller deciding whether a requirement
   * may be accepted asks this store what is already on record, and an unreadable answer read as
   * "nothing is accepted" is how a second acceptance gets written over a standing one — with a different
   * owner, a different reason and a different expiry, neither of them the one in force.
   *
   * The register has the weaker version of the same problem. An estate with no live exceptions and an
   * estate whose exceptions cannot be read look identical, and only one of them is good news.
   */
  private async read<T>(operation: string, text: string, values: readonly unknown[]): Promise<T[]> {
    try {
      const { rows } = await this.options.db.query<T>(text, values);
      return rows;
    } catch (error) {
      this.options.onError?.(operation, error);
      throw new RisksUnreadableError(operation, error);
    }
  }

  /**
   * The newest readable revision of each acceptance, with unreadable rows counted rather than thrown on.
   *
   * An unreadable revocation row leaves the acceptance reading as standing, which is wrong in the
   * direction that keeps a finding parked. That is the wrong direction, so it is reported: whoever reads
   * the log gets a count, and the alternative — dropping the acceptance — would put the requirement back
   * on the queue with no record that it had ever been accepted, which is worse in the same way but
   * silently.
   */
  private highest(rows: readonly unknown[], operation: string): AcceptedRisk[] {
    const revived = rows.map(revive);
    const unreadable = revived.filter((risk) => risk == null).length;
    if (unreadable > 0) {
      this.options.onError?.(operation, new Error(`${String(unreadable)} stored accepted-risk row(s) could not be read`));
    }

    const newest = new Map<string, AcceptedRisk>();
    // Read in ascending revision order, so a later row is always the better one.
    for (const risk of revived) {
      if (risk != null) newest.set(risk.id, risk);
    }
    return [...newest.values()];
  }
}

function revive(raw: unknown): AcceptedRisk | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const candidate = raw as AcceptedRisk & {
    effectiveFrom: string | Date;
    expiresAt: string | Date;
    recordedAt: string | Date;
    revoked?: { by: string; at: string | Date; reason: string };
  };

  if (typeof candidate.id !== 'string' || typeof candidate.controlId !== 'string') return undefined;
  if (typeof candidate.reason !== 'string' || typeof candidate.compensatingControl !== 'string') return undefined;
  if (typeof candidate.owner !== 'string' || typeof candidate.recordedBy !== 'string') return undefined;
  if (typeof (candidate.residual as ResidualRisk | undefined) !== 'string') return undefined;

  const effectiveFrom = date(candidate.effectiveFrom);
  const expiresAt = date(candidate.expiresAt);
  const recordedAt = date(candidate.recordedAt);
  // All three decide whether the acceptance is in force, so a row missing any of them is unreadable
  // rather than dated now: an acceptance whose expiry defaulted to this moment would read as expired
  // and put work back with no reason anybody could give, and one dated forward would park a finding
  // because a column would not parse.
  if (effectiveFrom == null || expiresAt == null || recordedAt == null) return undefined;

  if (candidate.revoked == null) {
    return { ...candidate, effectiveFrom, expiresAt, recordedAt };
  }

  const revokedAt = date(candidate.revoked.at);
  // A revocation whose date will not parse is not read as an acceptance still standing: that would keep
  // a finding parked on a record somebody has already ended.
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
