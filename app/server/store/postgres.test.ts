// What the connection promises, and what it refuses.
//
// The schema name is the interesting part, because it is the one value here that reaches SQL as
// text rather than as a parameter. `create schema $1` is not a statement, so the name is
// concatenated, and the only thing standing between a configured value and a DDL injection is the
// check these tests exercise.

import { describe, expect, it } from 'vitest';
import type { Sql } from './postgres.js';
import { DEFAULT_SCHEMA, ENDPOINT_ENV, ensureSchema, openPostgres, SCHEMA_ENV, schemaName } from './postgres.js';
import { FakePostgres } from './postgres-fake.js';

const ENDPOINT = 'projects/p/branches/b/endpoints/primary';

describe('naming the schema', () => {
  it('defaults when nothing is configured, so a plain install needs no setting', () => {
    expect(schemaName(undefined)).toBe(DEFAULT_SCHEMA);
    expect(schemaName('')).toBe(DEFAULT_SCHEMA);
    expect(schemaName('   ')).toBe(DEFAULT_SCHEMA);
  });

  it('accepts the shape Postgres folds to itself, so nothing depends on quoting', () => {
    expect(schemaName('waf')).toBe('waf');
    expect(schemaName('waf_dev')).toBe('waf_dev');
    expect(schemaName('_scratch2')).toBe('_scratch2');
    expect(schemaName(' waf ')).toBe('waf');
  });

  it('refuses anything that would change the meaning of the statement it lands in', () => {
    // Each of these is a value that concatenation would turn into something other than a name.
    for (const hostile of [
      'waf; drop schema public cascade',
      'waf"',
      "waf'",
      'waf public',
      'waf-dev',
      'WAF',
      '2waf',
      'a'.repeat(63),
    ]) {
      expect(schemaName(hostile), hostile).toBeUndefined();
    }
  });

  it('refuses the reserved prefix, rather than letting Postgres explain it', () => {
    // `create schema pg_x` fails with a message about reserved prefixes, which is a confusing way
    // to learn that a configured value was wrong.
    expect(schemaName('pg_temp')).toBeUndefined();
    expect(schemaName('pg_')).toBeUndefined();
  });
});

describe('opening the connection', () => {
  it('names the unbound resource rather than failing inside the driver', async () => {
    await expect(openPostgres({ env: {}, connect: unreachable })).rejects.toThrow(ENDPOINT_ENV);
  });

  it('quotes an unusable schema name back, so the person who set it can see what they set', async () => {
    const attempt = openPostgres({
      env: { [ENDPOINT_ENV]: ENDPOINT, [SCHEMA_ENV]: 'Waf-Dev' },
      connect: unreachable,
    });
    await expect(attempt).rejects.toThrow('"Waf-Dev"');
  });

  it('creates the schema before the tables that go in it', async () => {
    const fake = new FakePostgres();
    const db = await openPostgres({ env: { [ENDPOINT_ENV]: ENDPOINT }, connect: () => Promise.resolve(fake) });

    expect(db.schema).toBe(DEFAULT_SCHEMA);
    const created = fake.statements.filter((sql) => sql.startsWith('create'));
    expect(created[0]).toBe(`create schema if not exists ${DEFAULT_SCHEMA}`);
    expect(created.slice(1).every((sql) => sql.includes(`${DEFAULT_SCHEMA}.`))).toBe(true);
  });

  it('runs no statement at all when the caller says it does not need the schema', async () => {
    // `91`. `ensureSchema` ends with `create index if not exists`, which requires owning the table even
    // when the index is already there, so an identity that can read every row was refused at connect with
    // `must be owner of table scans` — measured on the labs Lakebase `waf` schema, 2026-08-17, and
    // reproduced from this option's own probe. The refusal lands before the caller can send a `select`,
    // which is why every measurement of stored state had been taken through a pool built by hand.
    //
    // Nothing rather than fewer statements: a caller that cannot run DDL cannot run the `create schema`
    // either, and skipping only the index would leave the same refusal one line earlier.
    const fake = new FakePostgres();
    const db = await openPostgres({
      env: { [ENDPOINT_ENV]: ENDPOINT },
      connect: () => Promise.resolve(fake),
      ensureSchema: false,
    });

    expect(fake.statements).toEqual([]);
    expect(db.schema).toBe(DEFAULT_SCHEMA);
  });

  it('creates the schema when the option is absent, so a booting app is unaffected', async () => {
    // The default has to stay the creating one: an app arriving at a fresh database must make what it
    // needs, and an option that quietly changed that would trade `91` for a store that never appears.
    const fake = new FakePostgres();
    await openPostgres({ env: { [ENDPOINT_ENV]: ENDPOINT }, connect: () => Promise.resolve(fake) });
    expect(fake.statements.length).toBeGreaterThan(0);
  });

  it('creates every table two replicas could race on with if-not-exists', async () => {
    // Two replicas boot together on a deploy, so every statement has to be safe to lose the race.
    const fake = new FakePostgres();
    await openPostgres({ env: { [ENDPOINT_ENV]: ENDPOINT }, connect: () => Promise.resolve(fake) });

    const created = fake.statements.filter((sql) => sql.startsWith('create'));

    // The property rather than a count. A number here has to be bumped by whoever adds a table,
    // which makes the test a chore that says nothing about what it was protecting — and a bump is
    // exactly as easy to do wrong as the omission it was meant to catch.
    expect(created.every((sql) => sql.includes('if not exists'))).toBe(true);
    expect(created.length).toBeGreaterThan(1);
  });

  it('creates the tables the app reads, so a missing one is a failed boot rather than a failed query', async () => {
    const fake = new FakePostgres();
    await openPostgres({ env: { [ENDPOINT_ENV]: ENDPOINT }, connect: () => Promise.resolve(fake) });

    const tables = fake.statements
      .map((sql) => /^create table if not exists \S+\.(\w+)/.exec(sql)?.[1])
      .filter((name) => name != null);

    // Named rather than counted, so this reads as the app's storage surface and a table that
    // disappears in a refactor is a failure that says which one.
    expect(new Set(tables)).toEqual(
      new Set([
        'scans',
        'attestations',
        'decisions',
        'assessment_definitions',
        'assessment_definition_versions',
        'assessment_setup_drafts',
        'imported_evidence',
        'improvement_plans',
        'improvement_actions',
        'validation_attempts',
        'accepted_risks',
        'applicability_decisions',
        'notes',
        'assessment_reviews',
        'pillar_reviews',
        'review_answers',
        'assessment_results',
        'audit_events',
        'audit_floor',
        'retention_periods',
        'legal_holds',
        'runs',
        'run_attempts',
        'run_checkpoints',
        'advisories',
        'plan_extracts',
        'month_publications',
        'serving_declarations',
      ])
    );
  });

  it('declares the constraints a store depends on for correctness rather than for speed', async () => {
    // A unique index here is not a performance decision: one publication per position per month is what
    // refuses two first publications of one month, which the endpoint cannot refuse because it reads and
    // then writes. A schema change that dropped it would leave the store's own test passing against a
    // fake that had been told the constraint existed.
    const fake = new FakePostgres();
    await openPostgres({ env: { [ENDPOINT_ENV]: ENDPOINT }, connect: () => Promise.resolve(fake) });

    const unique = fake.statements.filter((sql) => sql.startsWith('create unique index'));

    expect(unique.some((sql) => /month_publications \(definition_id, month, ordinal\)/.test(sql))).toBe(true);
    expect(unique.some((sql) => /accepted_risks \(definition_id, control_id, ordinal, revision\)/.test(sql))).toBe(
      true
    );
    expect(
      unique.some((sql) => /applicability_decisions \(definition_id, control_id, ordinal, revision\)/.test(sql))
    ).toBe(true);
    expect(unique.some((sql) => /assessment_reviews \(run_id\)/.test(sql))).toBe(true);
    expect(unique.some((sql) => /pillar_reviews \(review_id, pillar_id\)/.test(sql))).toBe(true);
    // One row per attestation, which is what makes `refreshed` a count of answers rather than of
    // requests: a retry of an answer whose response was lost writes the same attestation id again.
    expect(unique.some((sql) => /review_answers \(attestation_id\)/.test(sql))).toBe(true);
    expect(unique.some((sql) => /assessment_results \(review_id\)/.test(sql))).toBe(true);
  });

  it('adds nullable Version 2 result handles without rewriting legacy rows', async () => {
    const fake = new FakePostgres();
    await openPostgres({ env: { [ENDPOINT_ENV]: ENDPOINT }, connect: () => Promise.resolve(fake) });

    const altered = fake.statements.filter((sql) => sql.startsWith('alter table waf.assessment_'));
    expect(altered).toEqual(
      expect.arrayContaining([
        'alter table waf.assessment_reviews add column if not exists definition_version integer',
        'alter table waf.assessment_reviews add column if not exists definition_fingerprint text',
        'alter table waf.assessment_results add column if not exists schema_version integer',
        'alter table waf.assessment_results add column if not exists run_id text',
        'alter table waf.assessment_results add column if not exists definition_version integer',
        'alter table waf.assessment_results add column if not exists definition_fingerprint text',
        'alter table waf.assessment_results add column if not exists public_methodology_version integer',
        'alter table waf.assessment_results add column if not exists catalogue_revision text',
        'alter table waf.assessment_results add column if not exists eligible boolean',
      ])
    );
    expect(
      fake.statements.some(
        (sql) =>
          sql ===
          'create index if not exists assessment_results_current_final on waf.assessment_results (definition_id, finalised_at desc) where eligible is true'
      )
    ).toBe(true);
  });

  /*
   * The rule `42c` broke, held as a property of the DDL rather than named table by table.
   *
   * `42c` added the nullable `definition_id` to three unique indexes and took Postgres's default, where
   * nulls are distinct. That does not narrow a constraint on a nullable column — for a row with no
   * assessment it removes it, and an install with no assessment defined writes every row that way. Three
   * tables spent five merges with nothing refusing a second first acceptance, a second first
   * applicability decision or a second publication of one month, which is what ADR 0054 put the
   * constraint there for. Every test of those stores stayed green, because the fake skipped a constraint
   * whenever a column in it was null.
   *
   * So a unique index over `definition_id` needs a second one for the rows where it is null, and this
   * asks for the pair over whatever the DDL issues rather than by naming three tables that have already
   * been wrong once. A partial index is what makes that expressible: `nulls not distinct` would do it in
   * one index and is a property of the whole index, which on `month_publications` would also collide the
   * nullable `ordinal` and refuse rows written before positions existed.
   */
  it('constrains rows with no assessment too, on every table whose unique index names one', async () => {
    const fake = new FakePostgres();
    await openPostgres({ env: { [ENDPOINT_ENV]: ENDPOINT }, connect: () => Promise.resolve(fake) });

    const unique = fake.statements
      .filter((sql) => sql.startsWith('create unique index'))
      .map((sql) => sql.replace(/\s+/g, ' '));
    const table = (sql: string): string | undefined => /on \w+\.(\w+) \(/.exec(sql)?.[1];

    const scoped = unique.filter((sql) => /\(definition_id\b/.test(sql));
    expect(scoped.map(table)).toEqual([
      'serving_declarations',
      'accepted_risks',
      'applicability_decisions',
      'month_publications',
    ]);

    // Each one partial on the assessment being there, and each paired with the index that holds the
    // rows where it is not. Named indexes rather than a count, so the pair is legible in the failure.
    for (const sql of scoped) {
      expect(sql, sql).toMatch(/where definition_id is not null$/);
      const paired = unique.filter(
        (other) => table(other) === table(sql) && /where definition_id is null$/.test(other)
      );
      expect(paired, `${String(table(sql))} has no unique index for the rows with no assessment`).toHaveLength(1);
    }
  });

  /*
   * A boot that leaves the table unconstrained for a moment, every time, on every install.
   *
   * `42c` replaced `month_publications`'s index by dropping it and creating it again under the same
   * name, which is not idempotent: `create if not exists` never skips, the work repeats on every boot of
   * every replica, and between the two statements the table has no constraint at all. The other two
   * tables in the same change did not do this, which is how it went unnoticed.
   *
   * The property is the ordering rather than the absence of a drop — replacing an index is legitimate,
   * and cannot be done by altering one, since a partial index's predicate is fixed at creation. What is
   * not legitimate is dropping the name you are about to create, so the replacement takes a new name and
   * the old one goes afterwards.
   */
  it('never drops the index it is about to create, so no boot leaves a table unconstrained', async () => {
    const fake = new FakePostgres();
    await openPostgres({ env: { [ENDPOINT_ENV]: ENDPOINT }, connect: () => Promise.resolve(fake) });

    const named = (sql: string, pattern: RegExp): string | undefined => pattern.exec(sql.replace(/\s+/g, ' '))?.[1];
    const dropped = fake.statements
      .map((sql) => named(sql, /^drop index (?:if exists )?\w+\.(\w+)/i))
      .filter((name) => name != null);
    const created = fake.statements
      .map((sql) => named(sql, /^create unique index (?:if not exists )?(\w+)/i))
      .filter((name) => name != null);

    expect(dropped.filter((name) => created.includes(name))).toEqual([]);
  });

  /*
   * The one boot failure this change can cause, and what the operator is told.
   *
   * An install deployed between `42c` and `57a` may already hold two unscoped records at one position,
   * because for those five merges nothing refused the second. The index will not build, and that is the
   * intended outcome — `chooseStore` serves the explanation rather than degrading. What must not happen
   * is failing with Postgres's own sentence, which names an index nobody has heard of and no row.
   */
  it('names ADR 0054 and the table when a scoped unique index cannot be built', async () => {
    const fake = new FakePostgres({
      failOn: (sql) =>
        sql.includes('accepted_risks_at_position_unscoped')
          ? Object.assign(new Error('could not create unique index'), { code: '23505' })
          : undefined,
    });

    const boot = openPostgres({ env: { [ENDPOINT_ENV]: ENDPOINT }, connect: () => Promise.resolve(fake) });

    // The table, the constraint, which rows it is about, and where the rule comes from. Asserted as four
    // things a reader needs rather than as the whole sentence, so rewording it is not a test failure.
    await expect(boot).rejects.toThrow(/accepted_risks/);
    await expect(boot).rejects.toThrow(/definition_id is null/);
    await expect(boot).rejects.toThrow(/ADR 0054/);
    await expect(boot).rejects.toThrow(/could not create unique index/);
  });

  it('uses the configured schema throughout, so local work leaves the deployed one alone', async () => {
    const fake = new FakePostgres({ schema: 'waf_dev' });
    const db = await openPostgres({
      env: { [ENDPOINT_ENV]: ENDPOINT, [SCHEMA_ENV]: 'waf_dev' },
      connect: () => Promise.resolve(fake),
    });

    expect(db.schema).toBe('waf_dev');
    // The fake refuses a table outside its own schema, so reaching here proves every statement
    // was qualified with the configured name rather than the default.
    expect(fake.statements.filter((sql) => sql.includes('waf_dev')).length).toBeGreaterThan(0);
  });

  it('closes the pool when the schema cannot be created, because the caller never gets a handle', async () => {
    // A role with CONNECT and no CREATE fails here, and the caller retries every thirty seconds.
    // Nothing else holds a reference to this pool: `openPostgres` throws instead of returning, so
    // if it does not close what it opened, every retry strands ten connections.
    const fake = new FakePostgres({
      failOn: (sql) => (sql.startsWith('create schema') ? new Error('denied') : undefined),
    });

    await expect(
      openPostgres({ env: { [ENDPOINT_ENV]: ENDPOINT }, connect: () => Promise.resolve(fake) })
    ).rejects.toThrow('denied');
    await expect(fake.query('select 1')).rejects.toThrow('query after end()');
  });

  it('makes the three tables the three stores need', async () => {
    const fake = new FakePostgres();
    await ensureSchema(fake, fake.schema);

    for (const table of ['scans', 'attestations', 'decisions']) {
      expect(fake.statements.some((sql) => sql.includes(`create table if not exists ${fake.schema}.${table} `))).toBe(
        true
      );
    }
  });
});

/*
 * The transaction, and what it is forwarded from.
 *
 * `openPostgres` returns a handle built from whatever `connect` gave it, and a transaction is the one
 * capability that cannot be layered on top of `query`: a pool answers each statement on a different
 * connection, so `begin` and the statements after it would land in different sessions. So the handle
 * passes the underlying one through rather than synthesising it, and a handle that has none says so by
 * not having it — which is what lets a caller refuse instead of running unprotected.
 */
describe('a transaction on the handle', () => {
  it('forwards the session the driver gave it, rather than composing one out of query', async () => {
    const fake = new FakePostgres();
    const db = await openPostgres({ env: { [ENDPOINT_ENV]: ENDPOINT }, connect: () => Promise.resolve(fake) });
    fake.seed('scans', { id: 'scan-1' });

    const undone = db.session?.(async (sql) => {
      await sql.query('delete from waf.scans');
      throw new Error('and then the connection went');
    });

    await expect(undone).rejects.toThrow('and then the connection went');
    expect(fake.rows('scans')).toEqual([{ id: 'scan-1' }]);
  });

  it('has no session at all when the handle underneath cannot open one', async () => {
    const fake = new FakePostgres();
    const withoutOne: Sql = { query: (text, values) => fake.query(text, values) };
    const db = await openPostgres({ env: { [ENDPOINT_ENV]: ENDPOINT }, connect: () => Promise.resolve(withoutOne) });

    // Absent rather than present-and-pretending. A caller checks for it, so a stub that ran the callback
    // without a transaction would be the one shape that defeats the check. Asserted as the property not
    // being there at all, since `undefined` and "a function returning undefined" read the same to
    // anything that only checks truthiness.
    expect(Object.hasOwn(db, 'session')).toBe(false);
  });

  /*
   * Postgres answers a second `begin` with a warning and stays in the first transaction, so a nested
   * session would give one commit point where the caller thought there were two. The fake refuses rather
   * than being the more forgiving of the two.
   */
  it('refuses a session inside a session, the way one connection would', async () => {
    const fake = new FakePostgres();
    const nested = fake.session(() => fake.session(() => Promise.resolve(undefined)));
    await expect(nested).rejects.toThrow('nested transactions');
  });

  it('refuses transaction statements issued through query, since those would not nest either', async () => {
    const fake = new FakePostgres();
    await expect(fake.query('begin')).rejects.toThrow('use session()');
  });
});

function unreachable(): never {
  throw new Error('connect should not be reached');
}
