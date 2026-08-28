// A Postgres stand-in for the store tests.
//
// The stores are mostly SQL, so a fake that accepts anything and returns nothing would leave them
// untested, and a fake that pattern-matches loosely would pass a statement Postgres rejects. This
// one keeps rows in maps and recognises exactly the statements the three stores emit, by shape.
// Anything else throws with the statement in the message.
//
// That strictness is the point rather than an inconvenience. A store that changes its SQL breaks
// these tests immediately and visibly, which is the signal to check the new statement against a
// real database — see postgres.live.test.ts, which does exactly that and is skipped unless a
// database is bound. A lenient fake would have absorbed the change and reported green.
//
// One type is modelled, because a store's correctness turns on it: a value inserted through a
// `::jsonb` cast comes back parsed, exactly as the driver returns it. Without that, a store that
// forgot to revive a stored date would pass here and fail in production. Nothing else is coerced —
// a timestamptz column holds whatever Date went in — so a test that wants to prove a Date survives
// the wire has to go to `postgres.live.test.ts` for it.

import type { Sql } from './postgres.js';

export interface FakeRow {
  readonly [column: string]: unknown;
}

export interface FakePostgresOptions {
  readonly schema?: string;
  /** Throws on the nth matching statement, to test what a store does when a read or write fails. */
  readonly failOn?: (text: string, callNumber: number) => Error | undefined;
  /**
   * The primary key columns of a table, where it is not `id`.
   *
   * Declared rather than inferred because nothing in a statement says what a table's key is: an
   * insert names the columns it writes and a select names the ones it reads, and neither
   * distinguishes the pair that has to be unique. A store keyed on a pair — one row per version of
   * an assessment definition — would otherwise have every row collide on the same absent `id`,
   * which is a fake reporting a constraint the database does not have.
   */
  readonly keys?: Readonly<Record<string, readonly string[]>>;
  /**
   * Constraints that are unique but are not the key, per table.
   *
   * Declared for the same reason `keys` is — nothing in a statement says so — and needed because one
   * table here has two: a log keyed on a contiguous sequence, where the event's own id must also be
   * unique so a retry that follows an insert nobody reported cannot write the act twice. A fake that
   * modelled only the key would report that retry as a second event.
   *
   * A tuple where the constraint spans columns, because a store can depend on a combination being
   * unique without either column being so: two people accepting the same requirement at the same
   * moment both write a first acceptance of it, and the database refusing the second is what turns a
   * silently duplicated exception into a message its author can act on.
   */
  readonly unique?: Readonly<Record<string, readonly FakeUniqueConstraint[]>>;
}

/**
 * How a test declares one unique constraint, in the shapes the real schema uses.
 *
 * A string or a tuple is a plain unique index over those columns. The object form adds `when`, which is
 * a partial index — the constraint applies to the rows the predicate admits and to no others.
 *
 * `when` is here because of `42c`. It added a nullable `definition_id` to three unique indexes, which
 * does not narrow a constraint on a nullable column: nulls are distinct in Postgres, so for a row with
 * no assessment it removed the constraint, and every row on an install with no assessment defined is one
 * of those. What the schema now declares is a pair per table, partial on whether the row names an
 * assessment, and a fixture that declared one tuple could not model a pair — so a fixture asserting that
 * two acceptances collide agreed with the schema that they do not, both wrong in the same direction.
 * That is the one way a fake costs more than it saves, and it is what this exists to stop.
 */
export type FakeUniqueConstraint =
  | string
  | readonly string[]
  | {
      readonly columns: readonly string[];
      /**
       * The index's `where`, as a predicate on the row rather than as SQL, since nothing here parses
       * SQL. A row the predicate rejects is not in the index and collides with nothing in it.
       */
      readonly when?: (row: Readonly<Record<string, unknown>>) => boolean;
      /** The index's name, where a store tells one constraint from another by it. */
      readonly name?: string;
    };

/**
 * The fake, with the same surface the stores are given.
 *
 * `schema` is honoured rather than ignored: every statement is checked against it, so a store that
 * forgot to qualify a table name fails here instead of reading whichever schema happened to be on
 * the search path in production.
 */
export class FakePostgres implements Sql {
  readonly schema: string;

  /** Every statement in order, for tests that assert on what was issued rather than the result. */
  readonly statements: string[] = [];

  private readonly tables = new Map<string, Map<string, FakeRow>>();
  private readonly created = new Set<string>();
  private calls = 0;
  private ended = false;
  private inSession = false;

  constructor(private readonly options: FakePostgresOptions = {}) {
    this.schema = options.schema ?? 'waf';
  }

  query<T = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    if (this.ended) return Promise.reject(new Error('query after end()'));

    const sql = collapse(text);
    this.statements.push(sql);
    this.calls += 1;

    const failure = this.options.failOn?.(sql, this.calls);
    if (failure) return Promise.reject(failure);

    // Resolved rather than thrown even for the failure cases, because a store that only handled a
    // synchronous throw would pass here and not against a driver, where every failure is a rejected
    // promise.
    try {
      return Promise.resolve({ rows: this.run(sql, values) as T[] });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * A transaction, with a rollback that really does undo the writes.
   *
   * Copying every row rather than recording a log to replay backwards. The fake holds objects and a
   * reset is tens of rows in a test, so the copy is free and it cannot get the undo of a statement
   * subtly wrong — which is the failure that would matter, because a test asserting "nothing was lost"
   * against a fake whose rollback is approximate proves nothing about the code it is testing.
   *
   * Nested sessions are refused rather than flattened: Postgres treats a second `begin` as a warning
   * and carries on in the first transaction, so a caller that nested them would get one commit point
   * here and one there, and the fake should not be the more forgiving of the two.
   */
  async session<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
    if (this.inSession) throw new Error('session() inside session(): Postgres has no nested transactions');
    this.inSession = true;
    const before = new Map([...this.tables].map(([name, rows]) => [name, new Map(rows)]));
    try {
      const answer = await run(this);
      return answer;
    } catch (cause) {
      this.tables.clear();
      for (const [name, rows] of before) this.tables.set(name, rows);
      throw cause;
    } finally {
      this.inSession = false;
    }
  }

  end(): Promise<void> {
    this.ended = true;
    return Promise.resolve();
  }

  /** Rows in a table, for assertions that would otherwise need the store's own reader. */
  rows(table: string): FakeRow[] {
    return [...(this.tables.get(table)?.values() ?? [])];
  }

  /** Puts a row in directly, to set up a read without going through a store's writer. */
  seed(table: string, row: FakeRow): void {
    this.table(table).set(this.keyOf(table, row), row);
  }

  /**
   * Takes a row out directly.
   *
   * For the one table nothing in the app deletes from. An append-only log's whole claim is that a
   * removed row is detectable, and a test of that claim needs a way to remove one that the store
   * itself does not offer — which is the point.
   */
  drop(table: string, row: FakeRow): void {
    this.table(table).delete(this.keyOf(table, row));
  }

  /** The primary key of a row, as one string. `id` unless the table declared something else. */
  private keyOf(table: string, row: FakeRow): string {
    const columns = this.options.keys?.[table] ?? ['id'];
    return columns.map((column) => String(row[column])).join('\u0000');
  }

  private run(sql: string, values: readonly unknown[]): FakeRow[] {
    // Accepted and recorded, and doing nothing, because nothing here runs concurrently: the lock's
    // purpose is to make a second connection wait, and the fake has no second connection. A test that
    // wants to prove the lock is taken asserts on `statements`, which is the only thing about it a
    // single-threaded fake can honestly answer.
    if (/^lock table /i.test(sql)) return [];
    if (/^(begin|commit|rollback)$/i.test(sql)) {
      throw new Error(`${sql}: use session() rather than issuing transaction statements through query()`);
    }

    const ddl = /^create (?:unique )?(schema|table|index)( if not exists)? (\S+)/i.exec(sql);
    if (ddl) {
      // Recorded rather than acted on, beyond noting the name, so a test can assert the schema was
      // created before the tables were — the ordering the real thing depends on.
      this.created.add(ddl[3] ?? '');
      return [];
    }

    // A column added to a table that already exists. Also recorded rather than acted on: the rows
    // here are objects, so a column is whatever a writer puts in one, and a fake that enforced a
    // declared column list would be modelling a schema this file has no other reason to know. What
    // it does check is the schema qualification, which is the mistake the strictness exists for.
    const altered = /^alter table (?:if exists )?(\S+) add column (?:if not exists )?(\w+)/i.exec(sql);
    if (altered) {
      this.created.add(`${this.unqualify(altered[1] ?? '')}.${altered[2] ?? ''}`);
      return [];
    }

    // A constraint or index replaced after a column is added. Recorded rather than acted on, like
    // the `alter` above: uniqueness in tests is declared on the fake's constructor, and a schema
    // boot that drops the install-wide unique so it can recreate it per assessment must not fail
    // here for want of a parser.
    if (/^alter table \S+ drop constraint if exists \w+$/i.test(sql)) return [];
    if (/^alter table \S+ add constraint /i.test(sql)) return [];
    if (/^do \$invariant\$/i.test(sql)) return [];
    if (/^drop index if exists \S+$/i.test(sql)) return [];

    // `select count(*) as total from t [where …]`. Special-cased rather than folded into the projection
    // below, which maps column names onto row properties and has nothing to map an aggregate onto. The
    // `where` is here because retention counts what is past a cutoff before removing it, and a fake
    // that counted the whole table would report every sweep as removing everything.
    const counted = /^select count\(\*\) as (\w+) from (\S+)(?: where (.+?))?$/i.exec(sql);
    if (counted) {
      const rows = this.rows(this.unqualify(counted[2] ?? '')).filter((row) => this.matches(row, counted[3], values));
      return [{ [counted[1] ?? 'count']: rows.length }];
    }

    const insert = /^insert into (\S+) \(([^)]+)\) values \(([^)]+)\)(.*)$/i.exec(sql);
    if (insert) return this.insert(insert, values);

    const updated = /^update (\S+) set (.+?) where (.+?)(?: returning (.+?))?$/i.exec(sql);
    if (updated) return this.update(updated, values);

    // `delete from t where …`, which one store depends on rather than uses as a convenience: an
    // unfinished assessment is removed when it is confirmed or abandoned, because nothing references
    // it and keeping it would mean the wizard offering to resume work somebody decided against.
    //
    // The `where` is optional for exactly one caller: a reset empties a table rather than removing
    // rows from it, and a fake that required a predicate would have made the one statement in the app
    // whose purpose is to have none unrepresentable. It is still `delete from` rather than `truncate`
    // — the gateway says why it does not truncate — so nothing here has to model a lock.
    const deleted = /^delete from (\S+)(?: where (.+?))?$/i.exec(sql);
    if (deleted) return this.delete(deleted, values);

    // The ids of the records whose body names a value in one of its arrays. One reader emits this —
    // a requirement drill-through asking which improvement actions cite it — and it is special-cased
    // rather than taught to `matches` for two reasons. The condition is on a field inside a `jsonb`
    // body rather than on a column, which is the one thing the where-clause language above
    // deliberately does not model, and the projection is `distinct`, which the one below does not.
    const naming =
      /^select distinct id from (\S+) where body -> '(\w+)' @> to_jsonb\(\$(\d+)::text\)$/i.exec(sql);
    if (naming) return this.naming(naming, values);

    // `select c, count(*)::text as n from t [where …] group by c`. Separate from the whole-table count
    // above for the same reason that one is separate from the projection: there is no row to map an
    // aggregate onto. One reader emits it — how many notes have been written about each subject — and it
    // is a `group by` rather than a row per note because nothing in the app bounds how many notes there
    // are.
    const tallied =
      /^select (\w+), count\(\*\)(?:::(\w+))? as (\w+) from (\S+)(?: where (.+?))? group by (\w+)$/i.exec(sql);
    if (tallied) return this.tallied(tallied, values);

    // `select … from t a where … and not exists (select 1 from t b where b.c = a.c and …)`.
    //
    // The one correlated subquery the stores emit, and it is modelled rather than left to break because
    // of what it is for: an attempt is answered by a second row, so "outstanding" means a row with no
    // answered sibling, and asking that in SQL is the difference between reading the open attempts and
    // reading every attempt ever made. Matched before the plain select, which would otherwise take the
    // subquery's `from` for the statement's own.
    const excluding =
      /^select (.+?) from (\S+) (\w+) where (.+?) and not exists \( select 1 from (\S+) (\w+) where (.+?) \)(?: order by (.+?))?$/i.exec(
        sql
      );
    if (excluding) return this.excluding(excluding, values);

    const select = /^select (.+?) from (\S+)(?: where (.+?))?(?: order by (.+?))?(?: limit (\S+))?(?: for update)?$/i.exec(sql);
    if (select) return this.select(select, values);

    throw new Error(`FakePostgres does not recognise: ${sql}`);
  }

  private insert(match: RegExpExecArray, values: readonly unknown[]): FakeRow[] {
    const table = this.unqualify(match[1] ?? '');
    const columns = (match[2] ?? '').split(',').map((column) => column.trim());
    const placeholders = (match[3] ?? '').split(',').map((value) => value.trim());
    const tail = (match[4] ?? '').trim().toLowerCase();

    const row: Record<string, unknown> = {};
    for (const [index, column] of columns.entries()) {
      const placeholder = placeholders[index] ?? '';
      const parsed = /^\$(\d+)(?:::(\w+))?$/.exec(placeholder);
      if (parsed == null) throw new Error(`FakePostgres wants a placeholder, got "${placeholder}"`);
      const value = values[Number(parsed[1]) - 1];
      // The one coercion this fake performs, and the reason it performs it is in the header: a
      // jsonb column is written as text and read back parsed, so a store that skipped reviving
      // would otherwise pass here and fail against a database.
      row[column] = parsed[2] === 'jsonb' ? JSON.parse(String(value)) : value;
    }

    const rows = this.table(table);
    const key = this.keyOf(table, row);
    const existing = rows.get(key);

    if (existing != null) {
      if (tail.startsWith('on conflict') && tail.includes('do nothing')) return [];
      if (tail.startsWith('on conflict') && tail.includes('do update')) {
        // Only the columns the `set` list names, which is the whole point of modelling this at all. A
        // fake that merged the incoming row wholesale would pass an upsert that had left a column out of
        // its `set` list, and against a database that column keeps its first value forever — the failure
        // is a stale field on a row that looks written, which is the kind nothing notices.
        rows.set(key, { ...existing, ...assigned(match[4] ?? '', row, values) });
        return [];
      }
      throw uniqueViolation(table);
    }

    // A declared non-key unique constraint collides the same way the key does. Checked after the key so
    // the two are reported in the order a database would find them, and named the way Postgres names an
    // unnamed one, because a store that tells a repeated key apart from a lost race does it by name.
    for (const constraint of this.options.unique?.[table] ?? []) {
      const declared = uniqueColumns(constraint);
      const { columns, when } = declared;
      // A partial index constrains the rows its predicate admits. Both sides are checked against it: a
      // row it rejects is not in the index, and rows already there that it rejects are not either — which
      // is what makes a pair of partial indexes two populations rather than one.
      if (when != null && !when(row)) continue;
      // A null collides with nothing, which is Postgres's default and load-bearing rather than pedantry:
      // a run started by a person has no idempotency key, and a fake that collided two nulls would report
      // the second interactive run as a duplicate of the first. The three tables that need two nulls to
      // collide say so with a predicate instead — see `FakeUniqueConstraint`.
      if (columns.some((column) => row[column] == null)) continue;
      const collides = [...rows.values()].some(
        (one) => (when == null || when(one)) && columns.every((column) => one[column] === row[column])
      );
      if (!collides) continue;
      // `on conflict` names a constraint, and Postgres honours it for a unique index as well as for the
      // key. A fake that raised here regardless would make an idempotent insert — the only reliable way
      // to refuse a duplicate trigger — untestable without a database.
      if (tail.startsWith('on conflict') && tail.includes(columns.join(', ')) && tail.includes('do nothing')) return [];
      throw uniqueViolation(table, declared.name ?? `${table}_${columns.join('_')}_key`);
    }

    rows.set(key, row);
    return [];
  }

  /*
   * `update t set c = $n` or `set c = null`, with the same narrow `where` the selects accept plus
   * `is null`.
   *
   * `is null` is here because a store depends on it for correctness rather than as a filter: an
   * archive that sets a date only where none is set is idempotent, and one that sets it
   * unconditionally moves the date forward every time it is called. A fake that ignored the clause
   * would report both as the same statement.
   *
   * A literal `null` on the right is accepted because clearing a column is how a state gets undone,
   * and `= $n` bound to null is not the same statement: it asks Postgres to infer a type for a
   * parameter whose only value is null. Reopening an archived definition writes the literal, so the
   * fake models the literal.
   *
   * `returning` is modelled because one store asks a question it can only ask that way: whether the
   * update it just issued was the one that matched. A store that read the row back afterwards would be
   * answering about the row's state rather than about its own write, and two processes racing would both
   * read the winner's row and both believe they had won.
   */
  private update(match: RegExpExecArray, values: readonly unknown[]): FakeRow[] {
    const table = this.unqualify(match[1] ?? '');
    const assignments = (match[2] ?? '').split(',').map((one) => one.trim());
    const where = match[3];
    const returning = match[4]
      ?.split(',')
      .map((one) => one.trim())
      .filter((one) => one !== '');

    const changes: Record<string, unknown> = {};
    for (const assignment of assignments) {
      const cleared = /^(\w+) = null$/i.exec(assignment);
      if (cleared != null) {
        changes[cleared[1] ?? ''] = null;
        continue;
      }
      // `set c = c + 1`, which one store depends on for correctness rather than convenience: the attempt
      // number has to come from the database, because two processes that read it and then wrote it back
      // would both be attempt two. Modelled so that dependence is tested here rather than only against a
      // real database.
      const incremented = /^(\w+) = (\w+) \+ (\d+)$/.exec(assignment);
      if (incremented != null) {
        if (incremented[1] !== incremented[2]) {
          throw new Error(`FakePostgres only increments a column by itself, got "${assignment}"`);
        }
        changes[incremented[1] ?? ''] = { increment: Number(incremented[3]) };
        continue;
      }
      const parsed = /^(\w+) = \$(\d+)(?:::(\w+))?$/.exec(assignment);
      if (parsed == null) {
        throw new Error(
          `FakePostgres only understands "column = $n", "column = null" and "column = column + n" in a set, ` +
            `got "${assignment}"`
        );
      }
      // The cast is honoured for the reason the insert path honours it, in the note at the top of this
      // file: a `::jsonb` value comes back parsed from a real driver, and a fake that stored the text
      // it was handed would let a store skip reviving it and still pass.
      const value = values[Number(parsed[2]) - 1];
      changes[parsed[1] ?? ''] = parsed[3]?.toLowerCase() === 'jsonb' ? JSON.parse(String(value)) : value;
    }

    const rows = this.table(table);
    const matched: FakeRow[] = [];
    for (const [key, row] of [...rows.entries()]) {
      if (!this.matches(row, where, values)) continue;
      const applied = Object.fromEntries(
        Object.entries(changes).map(([column, change]) =>
          isIncrement(change) ? [column, Number(row[column] ?? 0) + change.increment] : [column, change]
        )
      );
      const written = { ...row, ...applied };
      rows.set(key, written);
      matched.push(written);
    }
    if (returning == null) return [];
    return matched.map((row) => Object.fromEntries(returning.map((column) => [column, row[column]])));
  }

  private delete(match: RegExpExecArray, values: readonly unknown[]): FakeRow[] {
    const table = this.unqualify(match[1] ?? '');
    const where = match[2];

    const rows = this.table(table);
    for (const [key, row] of [...rows.entries()]) {
      if (this.matches(row, where, values)) rows.delete(key);
    }
    return [];
  }

  /** Whether a row satisfies a `where`, which is one or more terms joined by `and`. */
  private matches(row: FakeRow, where: string | undefined, values: readonly unknown[]): boolean {
    if (where == null) return true;
    return where.split(/ and /i).every((term) => {
      const trimmed = term.trim();
      const nullity = /^(\w+) is (not )?null$/i.exec(trimmed);
      if (nullity != null) {
        const value = row[nullity[1] ?? ''];
        const isNull = value == null;
        return nullity[2] == null ? isNull : !isNull;
      }
      // A set, for the one condition that turns on a column being any of several values: whether a run
      // may be taken hold of. Written as a membership rather than as two statements because the whole
      // point of that condition is that it is decided in the same statement that acts on it.
      const membership = /^(\w+) in \(([$\d, ]+)\)$/i.exec(trimmed);
      if (membership != null) {
        const left = row[membership[1] ?? ''];
        return (membership[2] ?? '')
          .split(',')
          .map((placeholder) => values[Number(placeholder.trim().slice(1)) - 1])
          .some((right) => left === right);
      }
      // A list bound as one value, which is a different thing from the membership above: the ids
      // are found by a read rather than written into the statement, so there is no placeholder per
      // element and the count is not known when the SQL is built.
      const anyOf = /^(\w+) = any\(\$(\d+)::\w+\[\]\)$/i.exec(trimmed);
      if (anyOf != null) {
        const held = values[Number(anyOf[2]) - 1];
        if (!Array.isArray(held)) throw new Error(`FakePostgres expected an array for "${trimmed}"`);
        return held.includes(row[anyOf[1] ?? '']);
      }
      // Comparisons as well as equality, because one table here is a log: it is read by time window
      // and paged by a cursor, and both of those are inequalities. Modelled rather than special-cased
      // so the strictness still holds — a comparison against a column of mixed types is a real
      // mistake, and `compare` orders the same way the `order by` above does.
      const comparison = /^(\w+) (=|<|<=|>|>=) \$(\d+)$/.exec(trimmed);
      if (comparison == null) {
        throw new Error(
          `FakePostgres only understands "column =|<|<=|>|>= $n", "column in ($n, $m)", ` +
            `"column = any($n::type[])" and "column is null", got "${trimmed}"`
        );
      }
      const [, column, operator, placeholder] = comparison;
      const left = row[column ?? ''];
      const right = values[Number(placeholder) - 1];
      if (operator === '=') return left === right;

      const order = compare(left, right);
      if (operator === '<') return order < 0;
      if (operator === '<=') return order <= 0;
      if (operator === '>') return order > 0;
      return order >= 0;
    });
  }

  /**
   * `select distinct id from t where body -> 'field' @> to_jsonb($n::text)`.
   *
   * The containment is modelled the way Postgres answers it for an array of scalars, and only that
   * way: a body whose field is not an array of strings matches nothing here, which is what `@>`
   * against a `to_jsonb(text)` does. Anything wider would be this fake inventing a semantics.
   */
  private naming(match: RegExpExecArray, values: readonly unknown[]): FakeRow[] {
    const field = match[2] ?? '';
    const wanted = values[Number(match[3]) - 1];

    const named = new Set<unknown>();
    for (const row of this.rows(this.unqualify(match[1] ?? ''))) {
      const held: unknown = (row['body'] as Record<string, unknown> | undefined)?.[field];
      if (Array.isArray(held) && held.includes(wanted)) named.add(row['id']);
    }
    return [...named].map((id) => ({ id }));
  }

  /**
   * `select c, count(*)::text as n from t [where …] group by c`.
   *
   * The cast is honoured rather than ignored: `count(*)` is `bigint`, which the driver hands back as a
   * string so nothing is silently rounded above 2^53, and a fake that answered with a number would let a
   * store that forgot to parse it pass here and produce `"12"` rows in production.
   */
  private tallied(match: RegExpExecArray, values: readonly unknown[]): FakeRow[] {
    const [, projected = '', cast, alias = 'count', table = '', where, grouped = ''] = match;
    if (projected !== grouped) {
      throw new Error(`FakePostgres groups by the column it projects, got "${projected}" and "${grouped}"`);
    }

    const tally = new Map<unknown, number>();
    for (const row of this.rows(this.unqualify(table))) {
      if (!this.matches(row, where, values)) continue;
      tally.set(row[grouped], (tally.get(row[grouped]) ?? 0) + 1);
    }
    return [...tally].map(([value, count]) => ({
      [grouped]: value,
      [alias]: cast?.toLowerCase() === 'text' ? String(count) : count,
    }));
  }

  /**
   * `select … from t a where … and not exists (select 1 from t b where b.c = a.c and …)`.
   *
   * The subquery's `where` is split into the terms that correlate the two rows — `b.c = a.c`, matched on
   * the aliases — and the terms that stand on their own, which go through the same narrow matcher every
   * other clause here does. An outer row is kept when no inner row satisfies all of both.
   *
   * Aliases are stripped rather than modelled: the projection, the outer `where` and the `order by` all
   * name columns of the one outer table, so `a.body` is `body`. A statement that joined two different
   * tables would need more than this, and nothing here emits one.
   */
  private excluding(match: RegExpExecArray, values: readonly unknown[]): FakeRow[] {
    const [, projected = '', outerTable = '', outerAlias = '', outerWhere, innerTable = '', innerAlias = '', innerWhere = '', order] =
      match;

    const strip = (text: string, alias: string): string => text.replace(new RegExp(`\\b${alias}\\.`, 'g'), '');

    const correlations: { readonly inner: string; readonly outer: string }[] = [];
    const standalone: string[] = [];
    for (const term of innerWhere.split(/ and /i)) {
      const correlated = new RegExp(`^${innerAlias}\\.(\\w+) = ${outerAlias}\\.(\\w+)$`, 'i').exec(term.trim());
      if (correlated == null) standalone.push(strip(term.trim(), innerAlias));
      else correlations.push({ inner: correlated[1] ?? '', outer: correlated[2] ?? '' });
    }
    if (correlations.length === 0) {
      throw new Error(`FakePostgres wants a correlated "not exists", got "${innerWhere}"`);
    }

    const inner = this.rows(this.unqualify(innerTable)).filter((row) =>
      standalone.every((term) => this.matches(row, term, values))
    );

    const kept = this.rows(this.unqualify(outerTable))
      .filter((row) => this.matches(row, outerWhere == null ? undefined : strip(outerWhere, outerAlias), values))
      .filter((row) => !inner.some((other) => correlations.every((on) => other[on.inner] === row[on.outer])));

    return this.shape(
      kept,
      strip(projected, outerAlias)
        .split(',')
        .map((column) => column.trim()),
      order == null ? undefined : strip(order, outerAlias),
      undefined,
      values
    );
  }

  private select(match: RegExpExecArray, values: readonly unknown[]): FakeRow[] {
    const columns = (match[1] ?? '').split(',').map((column) => column.trim());
    const table = this.unqualify(match[2] ?? '');
    const where = match[3];

    let rows = this.rows(table);
    if (where != null) rows = rows.filter((row) => this.matches(row, where, values));

    return this.shape(rows, columns, match[4], match[5], values);
  }

  /** The ordering, limit and projection shared by every read, whatever narrowed the rows. */
  private shape(
    matched: readonly FakeRow[],
    columns: readonly string[],
    order: string | undefined,
    limit: string | undefined,
    values: readonly unknown[]
  ): FakeRow[] {
    let rows = [...matched];

    if (order != null) {
      const sort = /^(\w+) (asc|desc)$/i.exec(order.trim());
      if (sort == null) throw new Error(`FakePostgres only understands "column asc|desc", got "${order}"`);
      const [, column, direction] = sort;
      const sign = (direction ?? 'asc').toLowerCase() === 'desc' ? -1 : 1;
      rows = [...rows].sort((left, right) => sign * compare(left[column ?? ''], right[column ?? '']));
    }

    if (limit != null) rows = rows.slice(0, Number(resolve(limit, values)));

    // `select *` is not emitted by anything here, so the projection is always explicit and a
    // column the store asked for but never wrote arrives as undefined rather than as a silent
    // empty object. `c as name` is understood because one reader projects a column whose name it does
    // not know until it runs — the retention stamp differs per table — and a fake that took the alias
    // literally would answer every one of those reads with undefined.
    return rows.map((row) =>
      Object.fromEntries(
        columns.map((column) => {
          const aliased = /^(\w+) as (\w+)$/i.exec(column);
          return aliased == null ? [column, row[column]] : [aliased[2] ?? '', row[aliased[1] ?? '']];
        })
      )
    );
  }

  private table(name: string): Map<string, FakeRow> {
    let rows = this.tables.get(name);
    if (rows == null) {
      rows = new Map();
      this.tables.set(name, rows);
    }
    return rows;
  }

  private unqualify(reference: string): string {
    const prefix = `${this.schema}.`;
    if (!reference.startsWith(prefix)) {
      throw new Error(`FakePostgres expected a table in schema "${this.schema}", got "${reference}"`);
    }
    return reference.slice(prefix.length);
  }
}

/*
 * The rejection a driver produces for a duplicate key, code and constraint included.
 *
 * The code is the part that matters. A store telling a lost race apart from a broken connection has
 * to branch on something, `23505` is what Postgres sends, and an `Error` carrying only a message
 * would let a store that branched on the message text pass here and miss in production.
 *
 * `constraint` is here for the store that has two unique constraints on one table and a different
 * sentence for each: a repeated id is a bug, and a repeated pair is somebody else having got there
 * first. Postgres sends the name, so a store may read it.
 */
/** One declared constraint in the shape the check above wants, whichever way it was written. */
function uniqueColumns(constraint: FakeUniqueConstraint): {
  readonly columns: readonly string[];
  readonly when?: (row: Readonly<Record<string, unknown>>) => boolean;
  readonly name?: string;
} {
  if (typeof constraint === 'string') return { columns: [constraint] };
  if (Array.isArray(constraint)) return { columns: constraint };
  return constraint as Exclude<FakeUniqueConstraint, string | readonly string[]>;
}

function uniqueViolation(table: string, constraint = `${table}_pkey`): Error {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: '23505',
    constraint,
  });
}

/**
 * What an `on conflict … do update set` list actually writes.
 *
 * The three forms the stores use: `col = $n`, with the same `::jsonb` coercion an insert performs;
 * `col = excluded.col`, which reads the value the insert would have written; and `col = now()`, which the
 * scan store uses to re-stamp an overwritten row. Anything else is refused rather than ignored — a clause
 * this cannot read is one it would otherwise silently not apply, and an assignment nobody applied is
 * exactly the defect modelling the list is here to catch.
 */
function assigned(
  tail: string,
  incoming: Readonly<Record<string, unknown>>,
  values: readonly unknown[]
): Record<string, unknown> {
  const list = /\bdo update\s+set\s+(.+)$/i.exec(tail);
  if (list == null) throw new Error(`FakePostgres wants a "set" list on a do-update, got "${tail}"`);

  const written: Record<string, unknown> = {};
  for (const assignment of (list[1] ?? '').split(',')) {
    const parsed = /^\s*(\w+)\s*=\s*(?:\$(\d+)(?:::(\w+))?|excluded\.(\w+)|(now\(\)))\s*$/i.exec(assignment);
    if (parsed == null) {
      throw new Error(`FakePostgres does not recognise the assignment "${assignment.trim()}"`);
    }
    const [, column = '', placeholder, cast, excluded, now] = parsed;
    if (now != null) written[column] = new Date();
    else if (excluded != null) written[column] = incoming[excluded];
    else {
      const value = values[Number(placeholder) - 1];
      written[column] = cast?.toLowerCase() === 'jsonb' ? JSON.parse(String(value)) : value;
    }
  }
  return written;
}

/** A pending `c = c + n`, held as an object so it cannot be mistaken for the value to store. */
function isIncrement(change: unknown): change is { readonly increment: number } {
  return typeof change === 'object' && change !== null && 'increment' in change;
}

/** One line, single-spaced. The stores indent their SQL across several lines; the matching does not. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A literal, or the bound value behind a `$n`. */
function resolve(token: string, values: readonly unknown[]): unknown {
  const position = /^\$(\d+)$/.exec(token)?.[1];
  return position == null ? token : values[Number(position) - 1];
}

function compare(left: unknown, right: unknown): number {
  const key = (value: unknown): number | string =>
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : String(value);
  const [a, b] = [key(left), key(right)];
  return a < b ? -1 : a > b ? 1 : 0;
}
