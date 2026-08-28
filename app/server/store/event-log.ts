// An append-only log of records about requirements, in Lakebase.
//
// Attestations and decisions are the same problem twice: somebody records a statement about a
// requirement, later somebody records a better one, and both have to survive because the question
// a year later is who said what and when. So neither table is ever updated and neither is ever
// deleted from — a correction is a new row naming the one it replaced.
//
// This file kept the same shape over a Unity Catalog volume, where an append was a file per
// record and `current()` was a projection file rebuilt on write because listing and reading a
// directory per request was too slow to do twice. None of that survives: the projection is a
// query, and the two versions it carried existed to let a stored file be read by a build that
// wrote a different shape.

import type { Sql } from './postgres.js';
import { newestFirstBy, type LoggedEvent } from './ordering.js';
import { digestOf } from '../records/digest.js';
import { applyScope, type AssessmentScope } from './assessment-scope.js';

export type { LoggedEvent } from './ordering.js';
export { newestFirstBy } from './ordering.js';

export interface EventLogOptions<T extends LoggedEvent> {
  readonly db: Sql & { readonly schema: string };
  /** `attestations` or `decisions`. Interpolated into SQL, so it is a literal, never input. */
  readonly table: 'attestations' | 'decisions';
  /** The timestamp column, which differs per table because the domain word differs. */
  readonly stampColumn: 'attested_at' | 'decided_at';
  readonly stampOf: (record: T) => Date;
  /** A stored row back into a domain object, or undefined when it cannot be trusted. */
  readonly revive: (raw: unknown) => T | undefined;
  /** For the error message. `attestation` or `decision`. */
  readonly noun: string;
  readonly onError?: (operation: string, error: unknown) => void;
}

export class PostgresEventLog<T extends LoggedEvent> {
  constructor(private readonly options: EventLogOptions<T>) {}

  async append(record: T): Promise<void> {
    const { db, table, stampColumn, stampOf } = this.options;
    // Stamped with the digest of the record as it is being written down. `digestOf` canonicalises,
    // so it survives `jsonb` reordering the document on the way back out — and it is computed from
    // the record rather than from the JSON text for the same reason the text is what is stored: one
    // writer per column, and the digest is over the document, not over one serialisation of it.
    await db.query(
      `insert into ${db.schema}.${table} (id, control_id, ${stampColumn}, body, digest, definition_id)
         values ($1, $2, $3, $4::jsonb, $5, $6)
       on conflict (id) do nothing`,
      [record.id, record.controlId, stampOf(record), JSON.stringify(record), digestOf(record), definitionIdOf(record)]
    );
  }

  /**
   * The newest record for each requirement.
   *
   * Every row is read and the newest picked in TypeScript, rather than `distinct on (control_id)`
   * picking it in Postgres. The reason is that "newest" is not only the timestamp: two records can
   * carry the same millisecond, and then the one that supersedes the other is the newer, which is
   * what `newestFirstBy` knows and SQL does not. Doing it in SQL would give a subtly different
   * answer from the in-memory store for the same data, and two implementations of one interface
   * disagreeing is worse than a query that reads more than it strictly needs.
   *
   * What it costs: one row per recorded statement, not per scan. That is bounded by the number of
   * requirements a customer has answered, times how often they have revised an answer — hundreds,
   * growing slowly. If it ever reaches the tens of thousands, the fix is a `distinct on` narrowing
   * followed by the same projection over the survivors, which keeps the tie-break.
   */
  async current(scope?: AssessmentScope): Promise<readonly T[]> {
    const records = await this.all(scope);
    const newest = new Map<string, T>();
    for (const record of newestFirstBy(records, this.options.stampOf)) {
      if (!newest.has(record.controlId)) newest.set(record.controlId, record);
    }
    return [...newest.values()];
  }

  async get(id: string, scope?: AssessmentScope): Promise<T | undefined> {
    const scoped = applyScope('where id = $1', [id], scope);
    const rows = await this.read(`read ${this.options.noun} ${id}`, scoped.fragment, scoped.values);
    return rows[0];
  }

  async historyFor(controlId: string, scope?: AssessmentScope): Promise<readonly T[]> {
    const scoped = applyScope('where control_id = $1', [controlId], scope);
    const rows = await this.read(`read ${this.options.noun} history for ${controlId}`, scoped.fragment, scoped.values);
    return newestFirstBy(rows, this.options.stampOf);
  }

  private async all(scope?: AssessmentScope): Promise<readonly T[]> {
    const scoped = applyScope('', [], scope);
    return this.read(`read every ${this.options.noun}`, scoped.fragment, scoped.values);
  }

  private async read(operation: string, where: string, values: readonly unknown[]): Promise<T[]> {
    const { db, table, stampColumn, noun, revive } = this.options;
    try {
      const { rows } = await db.query<{ body: unknown }>(
        `select body from ${db.schema}.${table} ${where} order by ${stampColumn} desc`,
        values
      );

      const records = rows.map((row) => revive(row.body));
      const unreadable = records.filter((record) => record == null).length;
      // Reported once with a count rather than once per row: a schema change that makes every row
      // unreadable would otherwise emit one line per record, and the number is the useful part.
      if (unreadable > 0) {
        this.report(operation, new Error(`${String(unreadable)} stored ${noun} record(s) could not be read`));
      }
      return records.filter((record): record is T => record != null);
    } catch (error) {
      // A read that fails reads as empty and says so through onError, rather than failing the
      // request. The alternative is a resolution pass that throws because one row is unreadable.
      this.report(operation, error);
      return [];
    }
  }

  private report(operation: string, error: unknown): void {
    this.options.onError?.(operation, error);
  }
}

function definitionIdOf(record: LoggedEvent): string | null {
  if (!('definitionId' in record)) return null;
  const value = (record as { definitionId?: unknown }).definitionId;
  return typeof value === 'string' ? value : null;
}
