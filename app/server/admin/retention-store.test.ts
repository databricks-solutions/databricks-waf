import { describe, expect, it } from 'vitest';
import { FakePostgres } from '../store/postgres-fake.js';
import { DEFAULT_PERIOD_DAYS, RETAINED } from './retention.js';
import {
  InMemoryRetentionStore,
  PostgresRetentionGateway,
  PostgresRetentionStore,
  and,
  where,
} from './retention-store.js';

const NOW = new Date('2026-08-04T00:00:00.000Z');

function database(): FakePostgres {
  return new FakePostgres({
    keys: { retention_periods: ['retention_class'], legal_holds: ['id'], audit_events: ['sequence'], audit_floor: ['id'] },
    unique: { audit_events: ['id'] },
  });
}

describe('the retention policy, stored', () => {
  it('reports the approved defaults on a database nobody has configured', async () => {
    const store = new PostgresRetentionStore(database());

    await expect(store.policy()).resolves.toEqual({ periods: DEFAULT_PERIOD_DAYS });
  });

  it('keeps the classes nobody changed at their defaults', async () => {
    const store = new PostgresRetentionStore(database());

    await store.setPeriods({ temporary: 7 }, 'priya@example.com', NOW);
    const policy = await store.policy();

    expect(policy.periods).toEqual({ ...DEFAULT_PERIOD_DAYS, temporary: 7 });
    expect(policy.setBy).toBe('priya@example.com');
  });

  it('upserts rather than growing a row per change', async () => {
    const db = database();
    const store = new PostgresRetentionStore(db);

    await store.setPeriods({ temporary: 7 }, 'priya@example.com', NOW);
    await store.setPeriods({ temporary: 14 }, 'sam@example.com', new Date('2026-08-05T00:00:00.000Z'));

    expect(db.rows('retention_periods')).toHaveLength(1);
    const policy = await store.policy();
    expect(policy.periods.temporary).toBe(14);
    expect(policy.setBy).toBe('sam@example.com');
  });

  it('attributes the policy to whoever changed something most recently', async () => {
    const store = new PostgresRetentionStore(database());

    await store.setPeriods({ governance: 3650 }, 'sam@example.com', new Date('2026-08-05T00:00:00.000Z'));
    await store.setPeriods({ temporary: 7 }, 'priya@example.com', NOW);

    await expect(store.policy()).resolves.toMatchObject({ setBy: 'sam@example.com' });
  });

  it('ignores a period naming a class this build does not have, rather than refusing to read the policy', async () => {
    const db = database();
    db.seed('retention_periods', {
      retention_class: 'something-a-later-build-had',
      days: 5,
      set_by: 'sam@example.com',
      set_at: NOW,
    });

    await expect(new PostgresRetentionStore(db).policy()).resolves.toMatchObject({ periods: DEFAULT_PERIOD_DAYS });
  });
});

describe('legal holds, stored', () => {
  it('reads back what was placed', async () => {
    const store = new PostgresRetentionStore(database());

    await store.place({
      id: 'hold-1',
      reason: 'Litigation over the 2025 audit',
      covers: ['assessment', 'governance'],
      placedBy: 'priya@example.com',
      placedAt: NOW,
    });

    const [hold] = await store.holds();
    expect(hold).toMatchObject({ id: 'hold-1', covers: ['assessment', 'governance'], placedBy: 'priya@example.com' });
    expect(hold?.releasedAt).toBeUndefined();
  });

  it('keeps the row when a hold is lifted, with who lifted it', async () => {
    const db = database();
    const store = new PostgresRetentionStore(db);
    await store.place({
      id: 'hold-1',
      reason: 'Litigation over the 2025 audit',
      covers: ['assessment'],
      placedBy: 'priya@example.com',
      placedAt: NOW,
    });

    await expect(store.release('hold-1', 'sam@example.com', new Date('2026-09-01T00:00:00.000Z'))).resolves.toBe(true);

    expect(db.rows('legal_holds')).toHaveLength(1);
    const [hold] = await store.holds();
    expect(hold?.releasedBy).toBe('sam@example.com');
  });

  it('answers false for a hold that is not in force, so two lifts do not both claim it', async () => {
    const store = new PostgresRetentionStore(database());
    await store.place({
      id: 'hold-1',
      reason: 'Litigation over the 2025 audit',
      covers: ['assessment'],
      placedBy: 'priya@example.com',
      placedAt: NOW,
    });

    await store.release('hold-1', 'sam@example.com', NOW);

    await expect(store.release('hold-1', 'priya@example.com', NOW)).resolves.toBe(false);
    await expect(store.release('hold-nothing', 'sam@example.com', NOW)).resolves.toBe(false);
  });

  it('answers false when the same actor lifts twice, not true from reading their own prior release', async () => {
    // The bug: after a successful lift, a follow-up SELECT of released_by still equals this actor,
    // so a second call returned true without updating anything. UPDATE … RETURNING is what decides.
    const store = new PostgresRetentionStore(database());
    await store.place({
      id: 'hold-1',
      reason: 'Litigation over the 2025 audit',
      covers: ['assessment'],
      placedBy: 'priya@example.com',
      placedAt: NOW,
    });

    await expect(store.release('hold-1', 'sam@example.com', NOW)).resolves.toBe(true);
    await expect(store.release('hold-1', 'sam@example.com', NOW)).resolves.toBe(false);
  });
});

describe('the in-memory position', () => {
  it('reports the same defaults and says it is not durable', async () => {
    const store = new InMemoryRetentionStore();

    expect(store.durable).toBe(false);
    await expect(store.policy()).resolves.toEqual({ periods: DEFAULT_PERIOD_DAYS });
  });

  it('places and lifts a hold like the durable one', async () => {
    const store = new InMemoryRetentionStore();
    await store.place({
      id: 'hold-1',
      reason: 'Litigation over the 2025 audit',
      covers: ['assessment'],
      placedBy: 'priya@example.com',
      placedAt: NOW,
    });

    await expect(store.release('hold-1', 'sam@example.com', NOW)).resolves.toBe(true);
    await expect(store.release('hold-1', 'sam@example.com', NOW)).resolves.toBe(false);
    expect((await store.holds())[0]?.releasedBy).toBe('sam@example.com');
  });
});

describe('counting and removing', () => {
  it('counts the whole table and the part of it past the cutoff', async () => {
    const db = database();
    for (const [index, day] of ['2024-01-01', '2026-07-01', '2026-08-01'].entries()) {
      db.seed('scans', { id: `scan-${String(index)}`, started_at: new Date(`${day}T00:00:00.000Z`) });
    }

    const eligibility = await new PostgresRetentionGateway(db).count(
      'scans',
      'started_at',
      new Date('2026-07-15T00:00:00.000Z')
    );

    expect(eligibility).toMatchObject({ table: 'scans', total: 3, eligible: 2 });
  });

  it('answers the age of the oldest row, and nothing when the table is empty', async () => {
    const db = database();
    db.seed('scans', { id: 'scan-1', started_at: new Date('2024-01-01T00:00:00.000Z') });
    const gateway = new PostgresRetentionGateway(db);

    expect((await gateway.count('scans', 'started_at')).oldest?.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect((await gateway.count('decisions', 'decided_at')).oldest).toBeUndefined();
  });

  it('reports zero eligible when no cutoff is given, so a plan cannot be read as a removal', async () => {
    const db = database();
    db.seed('scans', { id: 'scan-1', started_at: new Date('2020-01-01T00:00:00.000Z') });

    await expect(new PostgresRetentionGateway(db).count('scans', 'started_at')).resolves.toMatchObject({ eligible: 0 });
  });

  it('removes only what is past the cutoff, and answers how many', async () => {
    const db = database();
    db.seed('scans', { id: 'old', started_at: new Date('2024-01-01T00:00:00.000Z') });
    db.seed('scans', { id: 'new', started_at: new Date('2026-08-01T00:00:00.000Z') });

    const removed = await new PostgresRetentionGateway(db).remove(
      'scans',
      'started_at',
      new Date('2026-07-15T00:00:00.000Z')
    );

    expect(removed).toBe(1);
    expect(db.rows('scans').map((row) => row.id)).toEqual(['new']);
  });

  it('issues no delete at all when nothing is eligible', async () => {
    const db = database();
    db.seed('scans', { id: 'new', started_at: new Date('2026-08-01T00:00:00.000Z') });
    db.statements.length = 0;

    await new PostgresRetentionGateway(db).remove('scans', 'started_at', new Date('2026-07-15T00:00:00.000Z'));

    expect(db.statements.some((statement) => statement.startsWith('delete'))).toBe(false);
  });
});

// A predicate is how one table serves two periods, which `runs` needs and nothing else does — see
// `Retained.only`. Tested as text, because the failure is in the text and cannot be reached any other
// way from here: the fake refuses a predicate it cannot parse, so a subquery one never gets as far as
// being evaluated. What the sweep does with these is a live test.
//
// This block used to hold the defect it now guards against, and how is worth recording. It declared
// `OWNED = "run_id in (select id from runs where kind = 'advisory')"` — a copy of the shipped clause,
// bare `runs` and all — and asserted that `and` and `where` did not mangle it. They did not. The
// clause was unresolvable on every install for four months anyway, because this app's tables are in a
// schema of their own and nothing sets a `search_path`, and a test that copies the subject cannot see
// what the subject is wrong about.
//
// So the clauses are read from `RETAINED` now rather than restated, and what is asserted of them is
// the property the old block assumed: that a table named inside one can be found.
describe('a predicate that narrows a class to part of a table', () => {
  const SCHEMA = 'waf';
  const clauses = RETAINED.filter((one) => one.only != null).map((one) => ({
    table: one.table,
    retentionClass: one.retentionClass,
    text: one.only?.(SCHEMA) ?? '',
  }));

  it('is only on the two tables that need it, and there are four of them', () => {
    expect(clauses.map((one) => `${one.table}/${one.retentionClass}`)).toEqual([
      'run_attempts/advisory',
      'run_attempts/assessment',
      'runs/advisory',
      'runs/assessment',
    ]);
  });

  // The check that would have caught `86`. Any relation a clause names has to carry the schema,
  // because the gateway qualifies the table it is composed onto and cannot reach inside the clause.
  it('qualifies every table it names with the schema it was handed', () => {
    const unqualified = clauses.flatMap(({ table, text }) =>
      [...text.matchAll(/\b(?:from|join)\s+([A-Za-z_][\w.]*)/gi)]
        .map((found) => found[1] ?? '')
        .filter((named) => !named.startsWith(`${SCHEMA}.`))
        .map((named) => `${table}: ${named}`)
    );
    expect(unqualified).toEqual([]);
  });

  it('names no schema at all where it names no table, rather than qualifying a column', () => {
    const columnOnly = clauses.filter((one) => !/\b(?:from|join)\b/i.test(one.text));
    expect(columnOnly.map((one) => one.text)).toEqual([
      "kind = 'advisory'",
      "kind = 'assessment' or kind is null",
    ]);
  });

  it('brackets the predicate so an `or` inside it cannot escape an `and` outside it', () => {
    const kinds = clauses.find((one) => one.text.includes('kind is null') && !one.text.includes('select'))?.text;
    expect(`select count(*) from ${SCHEMA}.runs where requested_at < $1${and(kinds)}`).toBe(
      `select count(*) from ${SCHEMA}.runs where requested_at < $1 and (kind = 'assessment' or kind is null)`
    );
  });

  it('brackets it in a `where` of its own too, for the count that has no cutoff', () => {
    const kinds = clauses.find((one) => one.text.includes('kind is null') && !one.text.includes('select'))?.text;
    expect(`select count(*) from ${SCHEMA}.runs${where(kinds)}`).toBe(
      `select count(*) from ${SCHEMA}.runs where (kind = 'assessment' or kind is null)`
    );
  });

  it('leaves a subquery predicate alone, which needs no help but must not be mangled', () => {
    const owned = clauses.find((one) => one.text.includes('select'))?.text ?? '';
    expect(owned).toContain(`${SCHEMA}.runs`);
    expect(and(owned)).toBe(` and (${owned})`);
    expect(where(owned)).toBe(` where (${owned})`);
  });

  it('composes nothing where an entry covers the whole table, rather than an empty clause', () => {
    expect(where(undefined)).toBe('');
    expect(and(undefined)).toBe('');
  });
});

describe('trimming the audit log', () => {
  function log(db: FakePostgres, count: number, from: string): void {
    for (let sequence = 1; sequence <= count; sequence += 1) {
      db.seed('audit_events', {
        sequence,
        id: `event-${String(sequence)}`,
        at: new Date(new Date(from).getTime() + sequence * 24 * 60 * 60 * 1000),
        digest: `sha256:${String(sequence).padStart(64, '0')}`,
      });
    }
  }

  it('keeps an event past its period rather than leaving a gap above it', async () => {
    const db = database();
    log(db, 5, '2026-07-01T00:00:00.000Z');
    // Event 2 is stamped ahead of the ones around it — a clock that ran fast, or a long-running act
    // recorded late. Deleting on age would take 1, 3 and 4 and leave 2 and 5, which is a gap a
    // verifier cannot tell from somebody removing events they did not want read.
    db.seed('audit_events', {
      sequence: 2,
      id: 'event-2',
      at: new Date('2026-09-01T00:00:00.000Z'),
      digest: `sha256:${String(2).padStart(64, '0')}`,
    });

    const { removed, floor } = await new PostgresRetentionGateway(db).trimAuditPrefix(
      new Date('2026-07-05T12:00:00.000Z'),
      'priya@example.com'
    );

    expect(removed).toBe(1);
    expect(floor).toBe(1);
    expect(db.rows('audit_events').map((row) => row.sequence)).toEqual([2, 3, 4, 5]);
  });

  it('counts the same prefix it would cut, so the page cannot promise a row the sweep will not take', async () => {
    const db = database();
    log(db, 5, '2026-07-01T00:00:00.000Z');
    db.seed('audit_events', {
      sequence: 2,
      id: 'event-2',
      at: new Date('2026-09-01T00:00:00.000Z'),
      digest: `sha256:${String(2).padStart(64, '0')}`,
    });
    const gateway = new PostgresRetentionGateway(db);
    const cutoff = new Date('2026-07-05T12:00:00.000Z');

    // Three events are older than the cutoff, but only one of them is below the event that has to be
    // kept. Counting by age would say three, and then the sweep would take one — leaving a
    // confirmation nobody could have satisfied on purpose.
    const counted = await gateway.countAuditPrefix(cutoff);
    const { removed } = await gateway.trimAuditPrefix(cutoff, 'priya@example.com');

    expect(counted).toMatchObject({ table: 'audit_events', total: 5, eligible: 1 });
    expect(removed).toBe(counted.eligible);
  });

  it('counts nothing to cut when the oldest event is the one that has to be kept', async () => {
    const db = database();
    log(db, 3, '2026-07-01T00:00:00.000Z');

    const counted = await new PostgresRetentionGateway(db).countAuditPrefix(new Date('2026-01-01T00:00:00.000Z'));

    expect(counted).toMatchObject({ total: 3, eligible: 0 });
    expect(counted.oldest?.toISOString()).toBe('2026-07-02T00:00:00.000Z');
  });

  it('records where the log now begins, with the digest of the last event it removed', async () => {
    const db = database();
    log(db, 5, '2026-07-01T00:00:00.000Z');

    await new PostgresRetentionGateway(db).trimAuditPrefix(new Date('2026-07-04T00:00:00.000Z'), 'priya@example.com');

    const [floor] = db.rows('audit_floor');
    expect(floor).toMatchObject({ sequence: 2, trimmed_by: 'priya@example.com' });
    expect(floor?.digest).toBe(`sha256:${String(2).padStart(64, '0')}`);
  });

  it('writes the floor before the delete, so a failed trim leaves a floor that is merely too low', async () => {
    const db = database();
    log(db, 5, '2026-07-01T00:00:00.000Z');
    db.statements.length = 0;

    await new PostgresRetentionGateway(db).trimAuditPrefix(new Date('2026-07-04T00:00:00.000Z'), 'priya@example.com');

    const floorAt = db.statements.findIndex((statement) => statement.includes('insert into waf.audit_floor'));
    const deleteAt = db.statements.findIndex((statement) => statement.startsWith('delete from waf.audit_events'));
    expect(floorAt).toBeGreaterThanOrEqual(0);
    expect(floorAt).toBeLessThan(deleteAt);
  });

  it('removes nothing when every event is inside the period', async () => {
    const db = database();
    log(db, 3, '2026-07-01T00:00:00.000Z');

    const result = await new PostgresRetentionGateway(db).trimAuditPrefix(
      new Date('2026-01-01T00:00:00.000Z'),
      'priya@example.com'
    );

    expect(result).toEqual({ removed: 0 });
    expect(db.rows('audit_floor')).toHaveLength(0);
    expect(db.rows('audit_events')).toHaveLength(3);
  });

  it('takes the whole log when every event is past the period, and still declares where it ended', async () => {
    const db = database();
    log(db, 3, '2026-01-01T00:00:00.000Z');

    const { removed, floor } = await new PostgresRetentionGateway(db).trimAuditPrefix(
      new Date('2026-07-01T00:00:00.000Z'),
      'priya@example.com'
    );

    expect(removed).toBe(3);
    expect(floor).toBe(3);
    expect(db.rows('audit_events')).toHaveLength(0);
  });

  it('removes nothing from an empty log', async () => {
    await expect(
      new PostgresRetentionGateway(database()).trimAuditPrefix(new Date('2026-07-01T00:00:00.000Z'), 'priya@example.com')
    ).resolves.toEqual({ removed: 0 });
  });
});

/*
 * The same gateway, counting and emptying without a cutoff.
 *
 * The statements are the point here rather than the arithmetic, which `reset.test.ts` covers against a
 * gateway of its own. What only a database can answer is whether an unqualified `delete from` is the
 * statement the app emits and whether the table is empty afterwards — and the fake refuses SQL it has
 * not seen, which is what makes it worth asserting on.
 */
describe('emptying a table', () => {
  it('counts every row, with no cutoff and no stamp to measure one from', async () => {
    const db = database();
    db.seed('legal_holds', { id: 'hold-1' });
    db.seed('legal_holds', { id: 'hold-2' });

    await expect(new PostgresRetentionGateway(db).countRows('legal_holds')).resolves.toBe(2);
  });

  it('reads an absent table as empty rather than as a fault', async () => {
    await expect(new PostgresRetentionGateway(database()).countRows('notes')).resolves.toBe(0);
  });

  it('empties the table and answers what it held', async () => {
    const db = database();
    db.seed('notes', { id: 'note-1' });
    db.seed('notes', { id: 'note-2' });

    await expect(new PostgresRetentionGateway(db).empty('notes')).resolves.toBe(2);
    expect(db.rows('notes')).toEqual([]);
  });

  /*
   * No statement at all against a table that is already empty. Not an optimisation: a reset covers
   * sixteen tables and most of them are empty on the install somebody is resetting, and a `delete` per
   * empty table is fifteen statements in the trail of a database session for no effect.
   */
  it('issues no delete against a table that holds nothing', async () => {
    const db = database();
    db.statements.length = 0;

    await expect(new PostgresRetentionGateway(db).empty('notes')).resolves.toBe(0);
    expect(db.statements.filter((statement) => statement.startsWith('delete'))).toEqual([]);
  });

  it('deletes without a predicate, which is the one statement in the app that has none', async () => {
    const db = database();
    db.seed('scans', { id: 'scan-1' });
    db.statements.length = 0;

    await new PostgresRetentionGateway(db).empty('scans');

    expect(db.statements).toContain('delete from waf.scans');
  });
});

/*
 * The transaction a reset runs in, and the lock it takes first.
 *
 * Both of these are about a second connection this test cannot have, so what is asserted is the
 * statement issued and the state after a throw. That the lock makes a concurrent writer wait is
 * Postgres's guarantee rather than this app's, and the app's part is asking for it.
 */
describe('running a reset as one transaction', () => {
  it('locks the holds table before anything reads it, since a reset empties that table too', async () => {
    const db = database();
    db.statements.length = 0;

    await new PostgresRetentionGateway(db).resetting(() => Promise.resolve(undefined));

    expect(db.statements[0]).toBe('lock table waf.legal_holds in share row exclusive mode');
  });

  /*
   * `share row exclusive` and not `access exclusive`. It conflicts with the `row exclusive` an insert
   * takes, so placing a hold waits — while a reader is not blocked, and the reader here is the retention
   * page somebody has open, which should not stall for the duration of a reset.
   */
  it('takes a lock that stops writers without stopping readers', async () => {
    const db = database();
    await new PostgresRetentionGateway(db).resetting(() => Promise.resolve(undefined));

    expect(db.statements[0]).not.toContain('access exclusive');
  });

  it('puts the rows back when the work inside it throws', async () => {
    const db = database();
    db.seed('scans', { id: 'scan-1' });
    const gateway = new PostgresRetentionGateway(db);

    const failed = gateway.resetting(async (within) => {
      await within.empty('scans');
      throw new Error('connection reset by peer');
    });

    await expect(failed).rejects.toThrow('connection reset');
    expect(db.rows('scans')).toEqual([{ id: 'scan-1' }]);
  });

  it('commits what it did when the work inside it returns', async () => {
    const db = database();
    db.seed('scans', { id: 'scan-1' });

    await new PostgresRetentionGateway(db).resetting((within) => within.empty('scans'));

    expect(db.rows('scans')).toEqual([]);
  });

  /*
   * A handle that cannot open a transaction refuses rather than emptying sixteen tables unprotected.
   * The alternative works every time nothing else is happening and loses data the one time something is,
   * which is not a guarantee — it is a guarantee-shaped absence of one.
   */
  it('refuses on a handle with no transaction rather than running without one', async () => {
    const db = database();
    const withoutSession = { schema: db.schema, query: db.query.bind(db) };

    const refused = new PostgresRetentionGateway(withoutSession).resetting(() => Promise.resolve(undefined));

    await expect(refused).rejects.toThrow('cannot open a transaction');
    await expect(refused).rejects.toThrow('Nothing was removed');
  });
});
