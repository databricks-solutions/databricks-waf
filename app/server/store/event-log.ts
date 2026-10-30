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
   * Postgres narrows to each requirement's newest stamp and to every record tied with it, and what is
   * left is settled here. "Newest" is not only the timestamp: two records can carry the same
   * millisecond, and then the one that supersedes the other is the newer, which is what
   * `newestFirstBy` knows and SQL does not. Doing the whole choice in SQL would give a subtly different
   * answer from the in-memory store for the same data, and two implementations of one interface
   * disagreeing is worse than a query that reads a little more than it strictly needs.
   *
   * A requirement is settled from the narrowed rows alone when exactly one row is left and it reads.
   * Otherwise its whole history is read and reduced the way it always was: a tie is ordered by how much
   * each record supersedes, a count that runs through records older than the tie, and a newest record
   * that does not read hands the requirement to the newest one that does. Both are the exception, so
   * what a read costs is the requirements and not the statements recorded about them.
   */
  async current(scope?: AssessmentScope): Promise<readonly T[]> {
    const { db, table, stampColumn, stampOf, revive } = this.options;
    const operation = `read every ${this.options.noun}`;

    try {
      const scoped = applyScope('', [], scope);
      // The scope is on both sides: the inner one so another assessment's newer record cannot decide
      // what this one's newest is, and the outer one so a record of another assessment that shares the
      // requirement and the stamp is not returned as a tie.
      const inner = scoped.fragment === '' ? '' : ` ${scoped.fragment}`;
      const outer = scoped.fragment === '' ? '' : ` and ${scoped.fragment.replace(/^where /, '')}`;
      const { rows } = await db.query<{ control_id: string; body: unknown }>(
        `select control_id, body from ${db.schema}.${table}
           where (control_id, ${stampColumn}) in
             (select control_id, max(${stampColumn}) from ${db.schema}.${table}${inner} group by control_id)${outer}`,
        scoped.values
      );

      const narrowed = new Map<string, unknown[]>();
      for (const row of rows) narrowed.set(row.control_id, [...(narrowed.get(row.control_id) ?? []), row.body]);

      const newest: T[] = [];
      const undecided: string[] = [];
      for (const [controlId, bodies] of narrowed) {
        const only = bodies.length === 1 ? revive(bodies[0]) : undefined;
        if (only != null) newest.push(only);
        else undecided.push(controlId);
      }

      let unreadable = 0;
      if (undecided.length > 0) {
        const history = applyScope('where control_id = any($1::text[])', [undecided], scope);
        const fetched = await this.fetch(history.fragment, history.values);
        unreadable = fetched.unreadable;
        const chosen = new Map<string, T>();
        for (const record of newestFirstBy(fetched.records, stampOf)) {
          if (!chosen.has(record.controlId)) chosen.set(record.controlId, record);
        }
        newest.push(...chosen.values());
      }

      // Counted over the history that was read, so a row is reported once however it was reached.
      this.reportUnreadable(operation, unreadable);
      return newestFirstBy(newest, stampOf);
    } catch (error) {
      // As `read` does, and for the same reason.
      this.report(operation, error);
      return [];
    }
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

  private async read(operation: string, where: string, values: readonly unknown[]): Promise<T[]> {
    try {
      const { records, unreadable } = await this.fetch(where, values);
      this.reportUnreadable(operation, unreadable);
      return records;
    } catch (error) {
      // A read that fails reads as empty and says so through onError, rather than failing the
      // request. The alternative is a resolution pass that throws because one row is unreadable.
      this.report(operation, error);
      return [];
    }
  }

  /** The records a `where` selects, newest stamp first, and how many rows would not read. */
  private async fetch(where: string, values: readonly unknown[]): Promise<{ records: T[]; unreadable: number }> {
    const { db, table, stampColumn, revive } = this.options;
    const { rows } = await db.query<{ body: unknown }>(
      `select body from ${db.schema}.${table} ${where} order by ${stampColumn} desc`,
      values
    );

    const records = rows.map((row) => revive(row.body));
    return {
      records: records.filter((record): record is T => record != null),
      unreadable: records.filter((record) => record == null).length,
    };
  }

  /**
   * Reported once with a count rather than once per row: a schema change that makes every row
   * unreadable would otherwise emit one line per record, and the number is the useful part.
   */
  private reportUnreadable(operation: string, unreadable: number): void {
    if (unreadable > 0) {
      this.report(operation, new Error(`${String(unreadable)} stored ${this.options.noun} record(s) could not be read`));
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
