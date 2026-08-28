// What survives being written down.
//
// The interesting half is the round trip, because an advisory is a JSON body plus columns and the two
// have to agree: a date that comes back as a string prints an ISO timestamp on a page where everything
// else is a date, and a column that disagrees with the body is a history row describing a record it is
// not about. Both are the kind of fault that passes a type check.

import { describe, expect, it } from 'vitest';

import { accountScope } from '../collect/estate-scope.js';
import { observed } from '../collect/signal.js';
import { FakePostgres } from '../store/postgres-fake.js';
import type { Advisory } from './advisory.js';
import { InMemoryAdvisoryStore, PostgresAdvisoryStore } from './store.js';

const READINESS = 'sql:serverless.job_readiness';
const AT = new Date('2026-08-06T02:00:00.000Z');

function advisory(over: Partial<Advisory> = {}): Advisory {
  return {
    id: 'adv-1',
    runId: 'run-1',
    startedAt: AT,
    finishedAt: new Date(AT.getTime() + 120_000),
    state: 'complete',
    scope: accountScope(),
    lookbackDays: 30,
    stamp: { actor: 'ada@example.com', executionMode: 'service-principal', warehouse: 'wh-1' },
    readings: [observed(READINESS as never, [], 12)],
    ...over,
  };
}

describe('keeping an advisory', () => {
  it('reads back what was written, dates included', async () => {
    const store = new PostgresAdvisoryStore(new FakePostgres());
    const written = advisory({
      serverless: {
        lookbackDays: 30,
        jobs: [],
        alreadyServerless: 4,
        assumption: { basis: 'list-price', note: 'x' },
      } as never,
    });
    await store.save(written);

    const back = await store.get('adv-1');
    expect(back?.finishedAt).toBeInstanceOf(Date);
    expect(back?.finishedAt.toISOString()).toBe(written.finishedAt.toISOString());
    expect(back?.stamp).toEqual(written.stamp);
    expect(back?.scope.description).toBe(written.scope.description);
    expect(back?.serverless?.alreadyServerless).toBe(4);
    // A reading's own date, which arrives through jsonb as a string and is the one a page formats.
    expect(back?.readings[0]?.collectedAt).toBeInstanceOf(Date);
  });

  it('is found by the run that produced it, for a supervisor that only has the run id', async () => {
    const store = new PostgresAdvisoryStore(new FakePostgres());
    await store.save(advisory());

    expect((await store.forRun('run-1'))?.id).toBe('adv-1');
    expect(await store.forRun('run-nothing')).toBeUndefined();
  });

  it('does not return another assessment\'s advice', async () => {
    const store = new PostgresAdvisoryStore(new FakePostgres());
    await store.save(advisory({ id: 'under-a', definition: { id: 'def-a', version: 1, fingerprint: 'f' } }));
    await store.save(
      advisory({ id: 'under-b', runId: 'run-2', definition: { id: 'def-b', version: 1, fingerprint: 'g' } })
    );

    expect((await store.latest('def-a'))?.id).toBe('under-a');
    expect((await store.latest('def-b'))?.id).toBe('under-b');
    expect(await store.get('under-b', 'def-a')).toBeUndefined();
    expect(await store.latest(null)).toBeUndefined();
  });

  it('ignores a second write of the same record, so a retry is not a duplicate', async () => {
    const store = new PostgresAdvisoryStore(new FakePostgres());
    await store.save(advisory());
    await store.save(advisory({ state: 'partial' }));

    // The first write wins. Which of the two is arbitrary; what matters is that the id is the identity
    // and a repeated save cannot make one advisory into two rows a history page would list twice.
    expect((await store.get('adv-1'))?.state).toBe('complete');
    expect(await store.history()).toHaveLength(1);
  });

  it('summarises history without reading the analysis, and counts what was considered', async () => {
    // The assertion on the statement is the point, and until `36i` this test's name was the only thing
    // making the claim: `history` selected the body along with everything else, and every one of the
    // expectations below passed while it did. What a history line shows is eight scalars; the body is
    // the analyses, which is the largest column in the table.
    const db = new FakePostgres();
    const store = new PostgresAdvisoryStore(db);
    await store.save(
      advisory({
        serverless: { lookbackDays: 30, jobs: [{ jobId: '1' }, { jobId: '2' }] } as never,
        definition: { id: 'def-1', versionId: 'v1', fingerprint: 'f' } as never,
      })
    );

    const [line] = await store.history();
    expect(line?.considered).toBe(2);
    expect(line?.definitionId).toBe('def-1');
    expect(line?.scope).toBe(accountScope().description);

    const read = db.statements.filter((one) => one.startsWith('select') && one.includes('advisories'));
    expect(read).toHaveLength(1);
    expect(read[0]).not.toContain('body');
  });

  it('brings the workload analysis back with its representative date as a date', async () => {
    // The defect this exists for only appears on a record that has been through the database — never on the
    // one the run holds in memory — so nothing else in the suite would catch a page printing a raw ISO
    // string beside a dozen formatted dates.
    const store = new PostgresAdvisoryStore(new FakePostgres());
    const shape = {
      shape: 'abc0000000000000',
      workspaceId: 'w1',
      statementType: 'SELECT',
      score: 0.42,
      features: {},
      trend: { kind: 'chronic', runsNow: 10, runsBefore: 10 },
      findings: [],
      row: { shape: 'abc0000000000000', representativeAt: AT, msNow: 5 },
    };
    await store.save(
      advisory({
        workload: {
          top: [shape],
          failing: [shape],
          coverage: { coveredMs: 3, excludedMs: 7, coveredRuns: 1, excludedRuns: 1, percent: 30 },
          considered: 40,
          findingCount: 0,
          rankingVersion: 'advisor-1',
          rulesVersion: 1,
          windowDays: 14,
        } as never,
      })
    );

    const back = await store.get('adv-1');
    expect(back?.workload?.top[0]?.row.representativeAt).toBeInstanceOf(Date);
    expect(back?.workload?.failing[0]?.row.representativeAt).toBeInstanceOf(Date);
    expect(back?.workload?.coverage.percent).toBe(30);
    // The history column counts what was looked at, not what was shown.
    expect((await store.history())[0]?.considered).toBe(40);
  });

  it('brings the warehouse sizing analysis back', async () => {
    const store = new PostgresAdvisoryStore(new FakePostgres());
    await store.save(
      advisory({
        sizing: {
          warehouses: [{ workspaceId: 'w1', warehouseId: 'wh-1', name: 'cost-wh', state: 'clean', findings: [] }],
          findingCount: 0,
          used: 1,
          population: 1,
          matched: 1,
          windowDays: 7,
          rulesVersion: 1,
        } as never,
      })
    );

    expect((await store.get('adv-1'))?.sizing?.warehouses[0]?.name).toBe('cost-wh');
  });

  it('brings the job analysis back, with its last run as a date rather than a string', async () => {
    // The date is the half of this the structural test below cannot see. `lastRun` is a `Date` on the type
    // and a string through jsonb, so a surface formatting it prints an ISO string — and only on a record
    // that has been through the database, never on the one the run that produced it hands back.
    const store = new PostgresAdvisoryStore(new FakePostgres());
    await store.save(
      advisory({
        jobs: {
          jobs: [
            {
              workspaceId: 'w1',
              jobId: '471148922192497',
              name: 'daily_ingest',
              state: 'clean',
              findings: [],
              health: { workspaceId: 'w1', jobId: '471148922192497', runs: 3, lastRun: new Date('2026-08-10T22:15:00Z') },
            },
          ],
          findingCount: 0,
          eligible: 1,
          population: 1,
          matched: 1,
          windowDays: 30,
          rulesVersion: 1,
        } as never,
      })
    );

    const back = await store.get('adv-1');
    expect(back?.jobs?.jobs[0]?.name).toBe('daily_ingest');
    expect(back?.jobs?.jobs[0]?.health.lastRun).toBeInstanceOf(Date);
  });

  /*
   * The one that would have caught the defect this test was written after.
   *
   * `encode` lists the analyses by hand, the sizing one was not on the list, and nothing failed: the run
   * that produced the advisory hands its in-memory copy straight back, so the page worked for whoever
   * pressed the button and was empty on every reload, for every other reader, and after every scheduled
   * run — where it presented as a missing permission.
   *
   * Asserted structurally rather than analysis by analysis, so a further analysis added to `Advisory`
   * without a line in `encode` fails here rather than in front of a customer. The keys are read off the
   * object that went in, which is what makes it notice a field it was never told about — but only for the
   * fields this fixture sets, so a new one belongs in the object below as well. `plans` and
   * `retainedPlans` were each added to `encode` and to that object together, and each line was confirmed
   * to fail this test when removed.
   */
  it('writes down every part of an advisory, including analyses added later', async () => {
    const store = new PostgresAdvisoryStore(new FakePostgres());
    const written = advisory({
      serverless: { lookbackDays: 30, jobs: [], alreadyServerless: 0 } as never,
      workload: { top: [], failing: [], considered: 0, findingCount: 0, windowDays: 14 } as never,
      sizing: { warehouses: [], findingCount: 0, used: 0, population: 0, matched: 0, windowDays: 7 } as never,
      jobs: { jobs: [], findingCount: 0, eligible: 0, population: 0, matched: 0, windowDays: 30 } as never,
      definition: { id: 'def-1', versionId: 'v1', fingerprint: 'f' } as never,
      plans: { available: 1, withoutPlan: 0, skipped: {}, failed: 0, abandoned: 0, notRun: 0, warehousesKnown: true },
      planCapability: { kind: 'gave-up', failed: 5, abandoned: 30 },
      retainedPlans: 1,
      incompleteReason: 'One statement was refused.',
    });
    await store.save(written);

    const back = await store.get('adv-1');
    for (const key of Object.keys(written) as (keyof Advisory)[]) {
      expect(back?.[key], `${key} did not survive being written down`).toBeDefined();
    }
  });
});

describe('keeping an advisory without a database', () => {
  it('answers the same questions, and forgets the oldest rather than growing without bound', async () => {
    const store = new InMemoryAdvisoryStore(2);
    await store.save(advisory({ id: 'a', runId: 'r-a' }));
    await store.save(advisory({ id: 'b', runId: 'r-b' }));
    await store.save(advisory({ id: 'c', runId: 'r-c' }));

    expect((await store.latest())?.id).toBe('c');
    expect(await store.get('a')).toBeUndefined();
    expect((await store.forRun('r-b'))?.id).toBe('b');
    expect(store.durable).toBe(false);
  });
});
