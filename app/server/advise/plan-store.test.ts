import { describe, expect, it } from 'vitest';
import { FakePostgres } from '../store/postgres-fake.js';
import type { PlanExtract } from '../collect/sql/plans/parse.js';
import {
  InMemoryPlanExtractStore,
  PostgresPlanExtractStore,
  RETAINED_EXECUTIONS,
  type PlanExtractStore,
  type RetainedPlan,
} from './plan-store.js';

// An extract as `plan-parser-1` wrote one, which is what the retained corpus holds: no `edges` field at all,
// rather than an empty one. The store keeps what it was given, so this is also the shape `33ie` will meet when
// it walks a plan retained before `33ic` — and the reason `PlanExtract.edges` is optional.
const extract = (fingerprint: string): PlanExtract => ({
  parserVersion: 'plan-parser-1',
  fingerprint,
  operatorCount: 2,
  operators: [{ id: '1', tag: 'Scan' }],
  operatorsWithoutMetrics: 0,
  operatorsWithZeroMetrics: 0,
});

const plan = (statementId: string, observedAt: string, over: Partial<RetainedPlan> = {}): RetainedPlan => ({
  workspaceId: 'ws-1',
  shape: 'aaaabbbbccccdddd',
  statementId,
  advisoryId: 'adv-1',
  // The run's own date, and deliberately well after every execution date these tests use: retention ages
  // a row from this one, and a fixture that reused the execution's would hide the difference.
  advisoryAt: new Date('2026-08-10T00:00:00.000Z'),
  observedAt: new Date(observedAt),
  shapeVersion: 'shape-11112222',
  extract: extract(`fp-${statementId}`),
  ...over,
});

/** Both implementations against the same expectations, which is the only way the fake earns its keep. */
const stores: readonly [string, () => PlanExtractStore][] = [
  ['in memory', () => new InMemoryPlanExtractStore()],
  [
    'in Postgres',
    () =>
      new PostgresPlanExtractStore(
        new FakePostgres({ keys: { plan_extracts: ['workspace_id', 'shape', 'statement_id'] } })
      ),
  ],
];

describe.each(stores)('retained plans, %s', (_name, open) => {
  it('reads back what it kept', async () => {
    const store = open();
    await store.keep([plan('s-1', '2026-08-01T00:00:00.000Z')]);

    const kept = await store.forShape({ workspaceId: 'ws-1', shape: 'aaaabbbbccccdddd' });

    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ statementId: 's-1', shapeVersion: 'shape-11112222' });
    expect(kept[0]?.observedAt.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    // The extract survives the round trip, jsonb and all. A store that wrote the summary and lost the
    // operators would pass every count assertion here and hold nothing the plan rules can read.
    expect(kept[0]?.extract.operators).toEqual([{ id: '1', tag: 'Scan' }]);
    // And it comes back as it went in rather than as the current parser would have written it. The store casts
    // on the way out, so an older extract's missing `edges` is missing here too — the value a rule at `33ie`
    // will actually meet, and the reason the field is declared optional.
    expect(kept[0]?.extract.edges).toBeUndefined();
    expect(kept[0]?.extract.parserVersion).toBe('plan-parser-1');
  });

  it('answers with nothing for a shape it has never seen', async () => {
    expect(await open().forShape({ workspaceId: 'ws-1', shape: 'no-such-shape' })).toEqual([]);
  });

  it('keeps three executions of a shape, newest first', async () => {
    const store = open();
    await store.keep([plan('s-1', '2026-08-01T00:00:00.000Z')]);
    await store.keep([plan('s-2', '2026-08-02T00:00:00.000Z')]);
    await store.keep([plan('s-3', '2026-08-03T00:00:00.000Z')]);

    const kept = await store.forShape({ workspaceId: 'ws-1', shape: 'aaaabbbbccccdddd' });

    expect(kept.map((one) => one.statementId)).toEqual(['s-3', 's-2', 's-1']);
    expect(kept).toHaveLength(RETAINED_EXECUTIONS);
  });

  it('drops the oldest when a fourth arrives', async () => {
    const store = open();
    for (const [index, day] of ['01', '02', '03', '04'].entries()) {
      await store.keep([plan(`s-${index + 1}`, `2026-08-${day}T00:00:00.000Z`)]);
    }

    const kept = await store.forShape({ workspaceId: 'ws-1', shape: 'aaaabbbbccccdddd' });

    expect(kept.map((one) => one.statementId)).toEqual(['s-4', 's-3', 's-2']);
  });

  it('drops by age rather than by arrival, so a late-arriving old execution does not displace a newer one', async () => {
    // The case a capacity-truncating store would get wrong. `plan_extracts` is not a history of what the
    // app fetched, it is three executions of a query — so what decides is when they ran.
    const store = open();
    await store.keep([plan('s-recent', '2026-08-09T00:00:00.000Z')]);
    await store.keep([plan('s-mid', '2026-08-05T00:00:00.000Z')]);
    await store.keep([plan('s-old', '2026-08-02T00:00:00.000Z')]);
    await store.keep([plan('s-ancient', '2026-01-01T00:00:00.000Z')]);

    const kept = await store.forShape({ workspaceId: 'ws-1', shape: 'aaaabbbbccccdddd' });

    expect(kept.map((one) => one.statementId)).toEqual(['s-recent', 's-mid', 's-old']);
  });

  it('counts the three per shape rather than per table', async () => {
    // The reason the count is per shape and not a capacity: shapes run at wildly different rates, and a
    // global bound would let the busiest shape evict every other shape's history.
    const store = open();
    const other = { workspaceId: 'ws-1', shape: 'eeeeffff00001111' };
    for (const [index, day] of ['01', '02', '03', '04'].entries()) {
      await store.keep([plan(`busy-${index + 1}`, `2026-08-${day}T00:00:00.000Z`)]);
    }
    await store.keep([plan('quiet-1', '2026-07-01T00:00:00.000Z', other)]);

    expect(await store.forShape(other)).toHaveLength(1);
    expect(await store.forShape({ workspaceId: 'ws-1', shape: 'aaaabbbbccccdddd' })).toHaveLength(3);
  });

  it('holds one query text running in two workspaces as two shapes', async () => {
    // The defect `33ma` shipped a fix for, one layer down. `workload_query_shapes.sql` groups by
    // workspace, so a key without it would make the second workspace's plan overwrite the first's.
    const store = open();
    const elsewhere = { workspaceId: 'ws-2', shape: 'aaaabbbbccccdddd' };
    await store.keep([plan('here', '2026-08-01T00:00:00.000Z')]);
    await store.keep([plan('there', '2026-08-01T00:00:00.000Z', elsewhere)]);

    expect((await store.forShape({ workspaceId: 'ws-1', shape: 'aaaabbbbccccdddd' })).map((o) => o.statementId)).toEqual(
      ['here']
    );
    expect((await store.forShape(elsewhere)).map((one) => one.statementId)).toEqual(['there']);
  });

  it('replaces an execution it has already kept rather than counting it twice', async () => {
    // Two runs a week apart can nominate the same execution: the representative is the longest run in the
    // window, and the windows overlap. Counted twice, one execution would fill two of the three slots.
    const store = open();
    await store.keep([plan('s-1', '2026-08-01T00:00:00.000Z')]);
    await store.keep([plan('s-1', '2026-08-01T00:00:00.000Z', { advisoryId: 'adv-2' })]);

    const kept = await store.forShape({ workspaceId: 'ws-1', shape: 'aaaabbbbccccdddd' });

    expect(kept).toHaveLength(1);
    expect(kept[0]?.advisoryId).toBe('adv-2');
  });

  it('breaks a tie in the same order it reads, so the row it drops is the row it calls fourth', async () => {
    // Two executions of one shape can share a millisecond. An order that stopped at the timestamp would
    // drop a different row on each run, and the trend would be over a set that changed underneath it.
    const store = open();
    const same = '2026-08-01T00:00:00.000Z';
    for (const id of ['s-a', 's-b', 's-c', 's-d']) await store.keep([plan(id, same)]);

    const first = (await store.forShape({ workspaceId: 'ws-1', shape: 'aaaabbbbccccdddd' })).map((o) => o.statementId);

    expect(first).toEqual(['s-d', 's-c', 's-b']);
  });

  it('writes several shapes in one call', async () => {
    const store = open();
    const other = { workspaceId: 'ws-1', shape: 'eeeeffff00001111' };
    await store.keep([plan('s-1', '2026-08-01T00:00:00.000Z'), plan('s-2', '2026-08-01T00:00:00.000Z', other)]);

    expect(await store.forShape({ workspaceId: 'ws-1', shape: 'aaaabbbbccccdddd' })).toHaveLength(1);
    expect(await store.forShape(other)).toHaveLength(1);
  });

  it('trims a shape handed four executions of it in one call', async () => {
    // The case that makes the trim a loop rather than a single delete. One call carrying four executions of
    // one shape leaves three rows surplus at once, and a trim written for "a run displaces one" would cut
    // one of them and leave the shape holding four.
    const store = open();
    await store.keep([
      plan('s-1', '2026-08-01T00:00:00.000Z'),
      plan('s-2', '2026-08-02T00:00:00.000Z'),
      plan('s-3', '2026-08-03T00:00:00.000Z'),
      plan('s-4', '2026-08-04T00:00:00.000Z'),
    ]);

    const kept = await store.forShape({ workspaceId: 'ws-1', shape: 'aaaabbbbccccdddd' });

    expect(kept.map((one) => one.statementId)).toEqual(['s-4', 's-3', 's-2']);
  });

  it('keeps the run that filed each execution, which is what its retention is measured from', async () => {
    const store = open();
    await store.keep([plan('s-1', '2026-08-01T00:00:00.000Z', { advisoryAt: new Date('2026-08-06T09:00:00.000Z') })]);

    const kept = await store.forShape({ workspaceId: 'ws-1', shape: 'aaaabbbbccccdddd' });

    // Not the execution's date, which is five days earlier. `retention.ts` ages the row from this column
    // because a period shorter than the shapes lookback would otherwise sweep a plan on the day it landed.
    expect(kept[0]?.advisoryAt.toISOString()).toBe('2026-08-06T09:00:00.000Z');
  });

  it('does nothing with nothing', async () => {
    await expect(open().keep([])).resolves.toBeUndefined();
  });
});

describe('what a reader is handed', () => {
  it('never answers with a fourth execution, even where one is in the table', async () => {
    // An interrupted `keep` can leave a surplus row behind: the writes and the trim are separate
    // statements, deliberately, and `keep` says why. A reader comparing four of three would be comparing
    // against the plan the next trim is about to drop, so the cap is on the read as well.
    const db = new FakePostgres({ keys: { plan_extracts: ['workspace_id', 'shape', 'statement_id'] } });
    const store = new PostgresPlanExtractStore(db);
    for (const [index, day] of ['01', '02', '03'].entries()) {
      await store.keep([plan(`s-${index + 1}`, `2026-08-${day}T00:00:00.000Z`)]);
    }
    // Written behind the store's back, which is what an interruption between the insert and the trim
    // leaves: a fourth row nothing has cut yet.
    await db.query(
      `insert into waf.plan_extracts
         (workspace_id, shape, statement_id, advisory_id, advisory_at, observed_at, shape_version, extract)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        'ws-1',
        'aaaabbbbccccdddd',
        's-4',
        'adv-1',
        '2026-08-10T00:00:00.000Z',
        '2026-08-04T00:00:00.000Z',
        'shape-11112222',
        JSON.stringify(extract('fp-s-4')),
      ]
    );

    const kept = await store.forShape({ workspaceId: 'ws-1', shape: 'aaaabbbbccccdddd' });

    expect(kept.map((one) => one.statementId)).toEqual(['s-4', 's-3', 's-2']);
  });

  it('hands over a copy, so a caller that sorts it does not reorder the store', async () => {
    const store = new InMemoryPlanExtractStore();
    await store.keep([plan('s-1', '2026-08-01T00:00:00.000Z'), plan('s-2', '2026-08-02T00:00:00.000Z')]);
    const key = { workspaceId: 'ws-1', shape: 'aaaabbbbccccdddd' };

    (await store.forShape(key) as RetainedPlan[]).reverse();

    expect((await store.forShape(key)).map((one) => one.statementId)).toEqual(['s-2', 's-1']);
  });

  it('refuses a timestamp it cannot read rather than ordering by a NaN', async () => {
    // `newestFirst` subtracts `getTime`s, and NaN compares as neither before nor after — so one unreadable
    // row would make every comparison equal and the trim would drop whichever row the sort left fourth.
    const db = new FakePostgres({ keys: { plan_extracts: ['workspace_id', 'shape', 'statement_id'] } });
    await db.query(
      `insert into waf.plan_extracts
         (workspace_id, shape, statement_id, advisory_id, advisory_at, observed_at, shape_version, extract)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      ['ws-1', 'aaaabbbbccccdddd', 's-1', 'adv-1', 'not a time', 'not a time', 'shape-1', '{}'],
    );

    await expect(
      new PostgresPlanExtractStore(db).forShape({ workspaceId: 'ws-1', shape: 'aaaabbbbccccdddd' })
    ).rejects.toThrow('not a time this store can read');
  });

  it('reads a driver that parses timestamps into dates as well as one that hands back strings', async () => {
    // `pg` returns a `Date` for a `timestamptz` and the fake returns what it was given, so the store has to
    // take either. A store written for one of them fails against the other, and only one of the two is what
    // production talks to.
    const db = new FakePostgres({ keys: { plan_extracts: ['workspace_id', 'shape', 'statement_id'] } });
    await db.query(
      `insert into waf.plan_extracts
         (workspace_id, shape, statement_id, advisory_id, advisory_at, observed_at, shape_version, extract)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        'ws-1',
        'aaaabbbbccccdddd',
        's-1',
        'adv-1',
        new Date('2026-08-10T00:00:00.000Z'),
        new Date('2026-08-01T00:00:00.000Z'),
        'shape-1',
        '{}',
      ]
    );

    const kept = await new PostgresPlanExtractStore(db).forShape({
      workspaceId: 'ws-1',
      shape: 'aaaabbbbccccdddd',
    });

    expect(kept[0]?.observedAt.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(kept[0]?.advisoryAt.toISOString()).toBe('2026-08-10T00:00:00.000Z');
  });
});

describe('what the two implementations claim about themselves', () => {
  it('says the Postgres one is durable and the memory one is not', () => {
    // A3b: the point of the flag is that a surface can say which it has. There is no demo path onto this
    // store — `chooseStore` binds it with the advisories or not at all — and the memory one is for tests.
    expect(new PostgresPlanExtractStore(new FakePostgres()).durable).toBe(true);
    expect(new InMemoryPlanExtractStore().durable).toBe(false);
  });

  it('writes the extract as jsonb, so it comes back parsed rather than as a string', async () => {
    // The one thing the fake models rather than records, and it models it because a store that skipped
    // the cast would pass against an object map and fail against a database.
    const db = new FakePostgres({ keys: { plan_extracts: ['workspace_id', 'shape', 'statement_id'] } });
    await new PostgresPlanExtractStore(db).keep([plan('s-1', '2026-08-01T00:00:00.000Z')]);

    expect(db.statements.some((sql) => sql.includes('$8::jsonb'))).toBe(true);
  });

  it('names every mutable column in the update it does on a conflict', async () => {
    // The fake applies the `set` list rather than merging the row, so this is a real assertion rather than
    // a restatement of the code: a column left out of that list keeps its first value forever against a
    // database, on a row that looks like it was written.
    const db = new FakePostgres({ keys: { plan_extracts: ['workspace_id', 'shape', 'statement_id'] } });
    const store = new PostgresPlanExtractStore(db);
    await store.keep([plan('s-1', '2026-08-01T00:00:00.000Z')]);
    await store.keep([
      plan('s-1', '2026-08-07T00:00:00.000Z', {
        advisoryId: 'adv-2',
        advisoryAt: new Date('2026-08-08T00:00:00.000Z'),
        shapeVersion: 'shape-33334444',
        extract: extract('fp-second'),
      }),
    ]);

    const kept = await store.forShape({ workspaceId: 'ws-1', shape: 'aaaabbbbccccdddd' });

    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ advisoryId: 'adv-2', shapeVersion: 'shape-33334444' });
    expect(kept[0]?.observedAt.toISOString()).toBe('2026-08-07T00:00:00.000Z');
    expect(kept[0]?.advisoryAt.toISOString()).toBe('2026-08-08T00:00:00.000Z');
    expect(kept[0]?.extract.fingerprint).toBe('fp-second');
  });
});
