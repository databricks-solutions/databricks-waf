// Where the retention position is kept, and the gateway that acts on it.
//
// Two things live here, and they are separate on purpose. The *store* holds what an administrator
// decided: the periods, and the holds. The *gateway* is the narrow surface that counts and removes
// rows, and is the only part of retention that knows a table name is a table name — which is what
// lets the planning in `retention.ts` be tested against a handful of numbers rather than a schema.
//
// # Why the periods are rows rather than one document
//
// A row per class, so setting one is an upsert of one row. The alternative — a single row holding a
// JSON object of three periods — makes every change a read-modify-write, and two administrators
// setting different classes at the same time would have the second silently discard the first's
// change. Three rows race into three different keys and cannot.
//
// # Why a released hold is kept
//
// A hold is lifted by writing when and by whom, never by deleting the row. The hold is part of the
// record of what was preserved and why, and "there was a hold on this from March to July" is exactly
// the question somebody asks a year later about a record that is unexpectedly still here.

import type { Sql } from '../store/postgres.js';
import type {
  Eligibility,
  LegalHold,
  Only,
  RetentionClass,
  RetentionGateway,
  RetentionPolicy,
} from './retention.js';
import { CHAINED_TABLE, DEFAULT_PERIOD_DAYS, RETENTION_CLASSES } from './retention.js';
import type { ResetGateway, ResetTables } from './reset.js';

export interface RetentionStore {
  readonly durable: boolean;
  policy(): Promise<RetentionPolicy>;
  /** Sets one or more periods. Classes left out keep whatever they had. */
  setPeriods(periods: Partial<Record<RetentionClass, number>>, by: string, at: Date): Promise<void>;
  holds(): Promise<readonly LegalHold[]>;
  place(hold: LegalHold): Promise<void>;
  /** Lifts a hold. Answers false when there is no hold with that id still in force. */
  release(id: string, by: string, at: Date): Promise<boolean>;
}

interface PeriodRow {
  readonly retention_class: string;
  readonly days: number | string;
  readonly set_by: string | null;
  readonly set_at: Date | string | null;
}

interface HoldRow {
  readonly id: string;
  readonly reason: string;
  readonly covers: unknown;
  readonly placed_by: string;
  readonly placed_at: Date | string;
  readonly released_by: string | null;
  readonly released_at: Date | string | null;
}

export class PostgresRetentionStore implements RetentionStore {
  readonly durable = true;

  constructor(private readonly db: Sql & { readonly schema: string }) {}

  /**
   * The configured periods, with the defaults standing in for any class nobody has set.
   *
   * Merged over the defaults rather than requiring the rows to exist, so a database that has never
   * had a period set reports the approved defaults instead of nothing — and the first boot after this
   * lands does not need a seeding step that a second replica could race.
   */
  async policy(): Promise<RetentionPolicy> {
    const { rows } = await this.db.query<PeriodRow>(
      `select retention_class, days, set_by, set_at from ${this.db.schema}.retention_periods`
    );

    const periods: Record<RetentionClass, number> = { ...DEFAULT_PERIOD_DAYS };
    let setBy: string | undefined;
    let setAt: Date | undefined;

    for (const row of rows) {
      const retentionClass = RETENTION_CLASSES.find((one) => one === row.retention_class);
      // A row naming a class this build does not have is ignored rather than fatal: it is what a
      // downgrade leaves behind, and refusing to read the policy because of one is an app that will
      // not start over a setting it does not use.
      if (retentionClass == null) continue;
      periods[retentionClass] = Number(row.days);

      // The most recent change across the three, because "who set the retention policy" is one
      // question and three separate attributions would be a table nobody reads.
      const at = row.set_at == null ? undefined : new Date(row.set_at);
      if (at != null && (setAt == null || at > setAt)) {
        setAt = at;
        setBy = row.set_by ?? undefined;
      }
    }

    return { periods, ...(setBy != null ? { setBy } : {}), ...(setAt != null ? { setAt } : {}) };
  }

  async setPeriods(periods: Partial<Record<RetentionClass, number>>, by: string, at: Date): Promise<void> {
    for (const [retentionClass, days] of Object.entries(periods)) {
      if (days == null) continue;
      await this.db.query(
        `insert into ${this.db.schema}.retention_periods (retention_class, days, set_by, set_at)
           values ($1, $2, $3, $4)
           on conflict (retention_class) do update set days = $2, set_by = $3, set_at = $4`,
        [retentionClass, days, by, at]
      );
    }
  }

  async holds(): Promise<readonly LegalHold[]> {
    const { rows } = await this.db.query<HoldRow>(
      `select id, reason, covers, placed_by, placed_at, released_by, released_at
         from ${this.db.schema}.legal_holds order by placed_at desc`
    );
    return rows.map(reviveHold);
  }

  async place(hold: LegalHold): Promise<void> {
    await this.db.query(
      `insert into ${this.db.schema}.legal_holds (id, reason, covers, placed_by, placed_at)
         values ($1, $2, $3::jsonb, $4, $5)`,
      [hold.id, hold.reason, JSON.stringify(hold.covers), hold.placedBy, hold.placedAt]
    );
  }

  /**
   * Lifts a hold, and only one that is still in force.
   *
   * `released_at is null` in the predicate rather than checked after reading, so two people lifting
   * the same hold at once cannot both record themselves as the one who did it. The second is told
   * there was nothing to lift, which is true.
   *
   * Whether *this* call lifted it is decided by `RETURNING`, not by a follow-up read of
   * `released_by`. A second lift by the same actor would still see itself as `released_by` on a
   * re-read and would report `true` twice — which is how a release that did nothing looked like one
   * that did.
   */
  async release(id: string, by: string, at: Date): Promise<boolean> {
    const { rows } = await this.db.query<{ id: string }>(
      `update ${this.db.schema}.legal_holds set released_by = $2, released_at = $3
         where id = $1 and released_at is null
         returning id`,
      [id, by, at]
    );
    return rows.length > 0;
  }
}

function reviveHold(row: HoldRow): LegalHold {
  const covers = Array.isArray(row.covers)
    ? row.covers.filter((one): one is RetentionClass => RETENTION_CLASSES.includes(one as RetentionClass))
    : [];

  return {
    id: row.id,
    reason: row.reason,
    covers,
    placedBy: row.placed_by,
    placedAt: new Date(row.placed_at),
    ...(row.released_by != null ? { releasedBy: row.released_by } : {}),
    ...(row.released_at != null ? { releasedAt: new Date(row.released_at) } : {}),
  };
}

/**
 * The same store over arrays, which is what the route tests run against.
 *
 * No install uses it: an install with nowhere durable to keep records gets no retention surface at
 * all — see `store-choice.ts` for why a period governing nothing is worse than no period. It is here
 * rather than in the test file because it is the second implementation of the interface, and an
 * interface with one implementation and a mock is an interface that has not been checked.
 */
export class InMemoryRetentionStore implements RetentionStore {
  readonly durable = false;

  private periods: Record<RetentionClass, number> = { ...DEFAULT_PERIOD_DAYS };
  private setBy?: string;
  private setAt?: Date;
  private readonly held: LegalHold[] = [];

  policy(): Promise<RetentionPolicy> {
    return Promise.resolve({
      periods: { ...this.periods },
      ...(this.setBy != null ? { setBy: this.setBy } : {}),
      ...(this.setAt != null ? { setAt: this.setAt } : {}),
    });
  }

  setPeriods(periods: Partial<Record<RetentionClass, number>>, by: string, at: Date): Promise<void> {
    for (const [retentionClass, days] of Object.entries(periods)) {
      if (days == null) continue;
      this.periods[retentionClass as RetentionClass] = days;
    }
    this.setBy = by;
    this.setAt = at;
    return Promise.resolve();
  }

  holds(): Promise<readonly LegalHold[]> {
    return Promise.resolve([...this.held].sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime()));
  }

  place(hold: LegalHold): Promise<void> {
    this.held.push(hold);
    return Promise.resolve();
  }

  release(id: string, by: string, at: Date): Promise<boolean> {
    const index = this.held.findIndex((hold) => hold.id === id && hold.releasedAt == null);
    const hold = this.held[index];
    if (hold == null) return Promise.resolve(false);
    this.held[index] = { ...hold, releasedBy: by, releasedAt: at };
    return Promise.resolve(true);
  }
}

/**
 * A `where` clause for a row predicate, or nothing at all.
 *
 * Parenthesised, and that is the whole reason these are two functions rather than string
 * concatenation at four call sites. A predicate with an `or` in it — `kind = 'assessment' or kind is
 * null`, which is one of the two that exist — appended bare to `where started_at < $1 and …` binds as
 * `(… and kind = 'assessment') or (kind is null)`, and the sweep deletes every row whose kind is null
 * regardless of its age. That is the entire assessment run history of an install that predates the
 * column, removed by a period nobody changed.
 *
 * Exported for its own test, which is unusual here and is because of where this can be checked. The
 * fake refuses a predicate it cannot parse rather than matching everything — the right behaviour, and
 * it means a subquery predicate cannot reach these two functions through the fake at all. So the
 * composition is tested directly and the sweep it feeds is tested live.
 */
export function where(only?: string): string {
  return only == null ? '' : ` where (${only})`;
}

export function and(only?: string): string {
  return only == null ? '' : ` and (${only})`;
}

/**
 * Counting and removing, over the real schema.
 *
 * The only place in retention that composes a table name into SQL. The names come from `RETAINED` and
 * `RESET_TABLES` and from nowhere else — never from a request — which is what makes the concatenation
 * safe; a checked lookup here as well would be a second copy of a list whose whole purpose is to be
 * the only one.
 *
 * Both gateways, on one class. They are separate interfaces because the planning either side of them
 * is separate — a sweep is about age and a reset is not — but there is one set of tables and one
 * connection, and a second class would be a second place to get the schema name from.
 */
export class PostgresRetentionGateway implements RetentionGateway, ResetGateway {
  constructor(private readonly db: Sql & { readonly schema: string }) {}

  /**
   * One transaction, with `legal_holds` locked against writers before anything is read from it.
   *
   * `share row exclusive` rather than `access exclusive`: it conflicts with the `row exclusive` an
   * insert takes, so placing a hold waits, while a *reader* of the holds — the retention page somebody
   * has open — is not blocked. Refusing to serve that page for the duration of a reset would be a
   * stall in the surface whose job is to explain what is happening.
   *
   * Refuses outright when the handle cannot give it a session. That is a decision about which failure
   * is worse: running the sixteen deletes unprotected would work every time nothing else was happening
   * and lose data the one time something was, and a guarantee that holds until it matters is not one.
   */
  async resetting<T>(run: (within: ResetTables) => Promise<T>): Promise<T> {
    if (this.db.session == null) {
      throw new Error(
        'This database handle cannot open a transaction, and a reset that is not one can stop half ' +
          'way through an install with no record of where it stopped. Nothing was removed.'
      );
    }

    return this.db.session(async (sql) => {
      await sql.query(`lock table ${this.db.schema}.legal_holds in share row exclusive mode`);
      return run(new PostgresRetentionGateway({ ...sql, schema: this.db.schema, query: sql.query.bind(sql) }));
    });
  }

  async count(table: string, stamp: string, before?: Date, only?: Only): Promise<Eligibility> {
    // The schema goes into the clause here and nowhere else, because here is the only place that has
    // one. See `Only` in `retention.ts`: two of these name a second table, and a bare name is looked
    // for in `"$user"` and `public` and found in neither.
    const clause = only?.(this.db.schema);
    // `total` is narrowed by `only` too, not just `eligible`. Both numbers are shown side by side on
    // the page — "how many are there" beside "how many would go" — and a total counting the whole
    // table would report every assessment run under the advisory period, which reads as a period about
    // to delete far more than it will.
    const { rows } = await this.db.query<{ total: number | string }>(
      `select count(*) as total from ${this.db.schema}.${table}${where(clause)}`
    );
    const total = Number(rows[0]?.total ?? 0);

    const oldest = await this.oldest(table, stamp, clause);
    if (before == null) return { table, total, eligible: 0, ...(oldest != null ? { oldest } : {}) };

    const { rows: aged } = await this.db.query<{ total: number | string }>(
      `select count(*) as total from ${this.db.schema}.${table} where ${stamp} < $1${and(clause)}`,
      [before]
    );
    return {
      table,
      total,
      eligible: Number(aged[0]?.total ?? 0),
      ...(oldest != null ? { oldest } : {}),
    };
  }

  /**
   * The age of the oldest row, or nothing when the table is empty.
   *
   * Read even when no cutoff was asked for, because it is what makes a period judgeable: "40 scans,
   * none eligible" leaves an administrator no way to tell a period that is about to start removing
   * things from one that never will.
   */
  private async oldest(table: string, stamp: string, only?: string): Promise<Date | undefined> {
    const { rows } = await this.db.query<{ oldest: Date | string }>(
      `select ${stamp} as oldest from ${this.db.schema}.${table}${where(only)} order by ${stamp} asc limit 1`
    );
    const row = rows[0];
    return row?.oldest == null ? undefined : new Date(row.oldest);
  }

  /**
   * How many rows a table holds, with no cutoff and no oldest.
   *
   * Its own method rather than `count(table, stamp)` with the stamp ignored, because half the tables a
   * reset covers have no stamp a period is measured from — `retention_periods` is keyed on a class,
   * `audit_floor` is one row — and passing a column name that is never read would be a parameter whose
   * only purpose is to be wrong eventually.
   */
  async countRows(table: string): Promise<number> {
    const { rows } = await this.db.query<{ total: number | string }>(
      `select count(*) as total from ${this.db.schema}.${table}`
    );
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * Empties a table, and answers how many rows it held.
   *
   * Counted first for the reason `remove` gives: the `Sql` interface carries no row count, and the
   * disagreement a separate count can produce is in the safe direction here too — a row written
   * between the two is one the reset then removes and does not report, which understates by one and
   * loses nothing.
   *
   * `delete` rather than `truncate`. Truncate would be faster and takes an exclusive lock on the table
   * for the duration, which on an install somebody is still using is a stall rather than a refusal;
   * it also cannot be rolled back by the surrounding transaction on some configurations. A reset of a
   * demonstration install is at most tens of thousands of rows and this is not the place to buy speed.
   */
  async empty(table: string): Promise<number> {
    const held = await this.countRows(table);
    if (held === 0) return 0;
    await this.db.query(`delete from ${this.db.schema}.${table}`);
    return held;
  }

  async remove(table: string, stamp: string, before: Date, only?: Only): Promise<number> {
    // Counted first rather than read from a `rowCount` the `Sql` interface does not carry. The two
    // can disagree if something is written between them, and the disagreement is in the safe
    // direction: a row written during the sweep is newer than the cutoff and was never eligible.
    const { eligible } = await this.count(table, stamp, before, only);
    if (eligible === 0) return 0;
    await this.db.query(`delete from ${this.db.schema}.${table} where ${stamp} < $1${and(only?.(this.db.schema))}`, [
      before,
    ]);
    return eligible;
  }

  /**
   * Trims the audit log to a contiguous prefix and records where it now starts.
   *
   * The prefix is decided by *sequence*, not by age, and the difference is the whole point. Deleting
   * every row with `at < cutoff` would leave a gap wherever one event's clock ran behind the event
   * after it, and a gap in a chained log is indistinguishable from an event somebody removed to hide
   * it. So this finds the earliest event that must be kept and removes everything below it — which
   * keeps a handful of events past their period rather than making the log unverifiable.
   *
   * The floor is written before the delete. If the delete then fails, the floor names a digest that
   * is still present, and verification starts at the event after it and passes: a floor that is too
   * low is harmless. The other order — delete, then fail to record the floor — leaves a log whose
   * first surviving event names a predecessor nothing can produce, which reads as tampering forever.
   */
  /**
   * The last sequence a trim would take, or zero when it would take nothing.
   *
   * Shared with `countAuditPrefix` rather than written twice, so what the page reports and what the
   * sweep removes are the same rule by construction. Two copies of this would be two chances for the
   * page to promise a number the sweep does not deliver, which is exactly what the confirmation on
   * the sweep route exists to prevent.
   */
  private async prefixEnd(before: Date): Promise<number> {
    const { rows: keep } = await this.db.query<{ sequence: number | string }>(
      `select sequence from ${this.db.schema}.${CHAINED_TABLE} where at >= $1 order by sequence asc limit 1`,
      [before]
    );

    const first = keep[0];
    if (first != null) return Number(first.sequence) - 1;

    // Nothing has to be kept, so the prefix is everything. Read rather than assumed, because
    // "delete the lot" and "there is nothing to delete" are the same statement here and only one of
    // them should write a floor.
    const { rows: last } = await this.db.query<{ sequence: number | string }>(
      `select sequence from ${this.db.schema}.${CHAINED_TABLE} order by sequence desc limit 1`
    );
    return Number(last[0]?.sequence ?? 0);
  }

  async countAuditPrefix(before: Date): Promise<Eligibility> {
    const table = CHAINED_TABLE;
    const { rows } = await this.db.query<{ total: number | string }>(
      `select count(*) as total from ${this.db.schema}.${table}`
    );
    const total = Number(rows[0]?.total ?? 0);
    const oldest = await this.oldest(table, 'at');

    const cut = await this.prefixEnd(before);
    if (cut <= 0) return { table, total, eligible: 0, ...(oldest != null ? { oldest } : {}) };

    // By sequence, not by age. An event stamped before the cutoff but sequenced above one that has
    // to be kept is not eligible, because removing it would leave a gap.
    const { rows: within } = await this.db.query<{ total: number | string }>(
      `select count(*) as total from ${this.db.schema}.${table} where sequence <= $1`,
      [cut]
    );
    return {
      table,
      total,
      eligible: Number(within[0]?.total ?? 0),
      ...(oldest != null ? { oldest } : {}),
    };
  }

  async trimAuditPrefix(before: Date, by: string): Promise<{ removed: number; floor?: number }> {
    const cut = await this.prefixEnd(before);
    if (cut <= 0) return { removed: 0 };

    const { rows: floorRows } = await this.db.query<{ sequence: number | string; digest: string }>(
      `select sequence, digest from ${this.db.schema}.${CHAINED_TABLE} where sequence = $1`,
      [cut]
    );
    const floor = floorRows[0];
    if (floor == null) return { removed: 0 };

    await this.db.query(
      // The single row's key is bound rather than written into the statement, so every value in it
      // arrives the same way and nothing here composes SQL from anything but the schema name.
      `insert into ${this.db.schema}.audit_floor (id, sequence, digest, trimmed_at, trimmed_by)
         values ($1, $2, $3, $4, $5)
         on conflict (id) do update set sequence = $2, digest = $3, trimmed_at = $4, trimmed_by = $5`,
      [1, Number(floor.sequence), floor.digest, new Date(), by]
    );

    const { rows: counted } = await this.db.query<{ total: number | string }>(
      `select count(*) as total from ${this.db.schema}.${CHAINED_TABLE}`
    );
    const before_ = Number(counted[0]?.total ?? 0);
    await this.db.query(`delete from ${this.db.schema}.${CHAINED_TABLE} where sequence <= $1`, [cut]);
    const { rows: after } = await this.db.query<{ total: number | string }>(
      `select count(*) as total from ${this.db.schema}.${CHAINED_TABLE}`
    );

    return { removed: before_ - Number(after[0]?.total ?? 0), floor: Number(floor.sequence) };
  }
}
