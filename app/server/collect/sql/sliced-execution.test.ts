// Executing one statement once per workspace, and what has to stay true when it does.
//
// The problem this exists for: `serverless_job_readiness` at the declared estate is 27.6 MiB of
// JSON against a 25 MiB inline cap, and past that cap the Statement Execution API returns an error
// rather than fewer rows. The options were to return less — a sample, a top-N, a narrower
// population — or to move the same rows in more responses. Every option in the first group changes
// the answer, because the four affected statements are the ones the app counts populations from.
//
// So these tests are about losslessness rather than about transport. A sliced statement has to
// produce the rows the unsliced one would, in the order the unsliced one would, and when it cannot
// it has to say which part of the estate is missing rather than present a short total as a total.

import { readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CollectionScheduler } from '../../scan/scheduler.js';
import { accountScope, selectedScope, workspaceScope, type EstateScope } from '../estate-scope.js';
import type { CollectorContext, SignalId, SignalResult } from '../signal.js';
import type { CredentialProvider } from '../credentials.js';
import { defaultLimits } from '../../scan/surfaces.js';
import { SQL_SIGNALS, SqlCollector, type SqlParameters } from './collector.js';
import { FileQuerySource, StaticQuerySource, queryDirectory, type QuerySource } from './queries.js';
import { SCALE_TARGETS } from './scale.js';
import { declaredSlice } from './slices.js';
import { MAX_EXECUTIONS, MAX_SLICES, collectSlices, sliceGroups } from './sliced.js';
import type { JobRow } from './shapes.js';

/** The four statements the slice headers declare, read off disk rather than restated here. */
const SLICED = ['jobs_inventory', 'compute_cluster_inventory', 'serverless_job_spend', 'serverless_job_readiness'];

const JOBS: SignalId = 'sql:jobs.inventory';
const DIRECTORY = 'workspace_directory';

function context(): CollectorContext {
  return { credentials: credentials(), scheduler: new CollectionScheduler(), collected: new Map() };
}

function credentials(): CredentialProvider {
  return {
    mode: 'on-behalf-of-user',
    databricks: () =>
      Promise.resolve({
        mode: 'on-behalf-of-user',
        actor: 'a@example.com',
        host: 'https://example.cloud.databricks.com',
        token: () => Promise.resolve('token'),
      }),
    cloud: () => Promise.resolve(null),
  };
}

/**
 * Query text carrying the headers slicing reads, so these tests exercise the sliced path.
 *
 * The other collector tests use text with no `-- Slice:` header, which is why they still assert the
 * whole-estate binding: an undeclared statement is deliberately not sliced. Both are real cases and
 * both need a fixture.
 */
function sliceable(order = 'ORDER BY name'): QuerySource {
  return new StaticQuerySource({
    [DIRECTORY]: `-- ${DIRECTORY}\n-- Rows: one per workspace\nSELECT 1`,
    jobs_inventory: `-- jobs_inventory\n-- Rows: one per job\n-- Slice: workspace_id, job_id\nSELECT 1\n${order}`,
  });
}

/** A directory row in the stringified shape the statement API returns. */
function workspaceRow(id: string) {
  return {
    workspace_id: id,
    workspace_name: `ws-${id}`,
    workspace_url: `https://ws-${id}.cloud.databricks.com`,
    status: 'RUNNING',
    region: 'US_WEST_OREGON',
    live: 'true',
    create_time: '2026-01-01T00:00:00.000Z',
  };
}

function jobRow(workspace: string, name: string) {
  return { workspace_id: workspace, job_id: `${workspace}-${name}`, name, scheduled: 'true' };
}

interface Executed {
  readonly query: string;
  readonly parameters: SqlParameters;
}

interface Answers {
  /** Rows per workspace id for `jobs_inventory`, keyed by the id bound to the slice. */
  readonly jobs?: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  /** Slices to fail rather than answer, by workspace id. */
  readonly failing?: Readonly<Record<string, Error>>;
  readonly workspaces?: readonly string[];
  readonly queries?: QuerySource;
  /** The scope to collect under. Account reach over every live workspace unless a test needs otherwise. */
  readonly scope?: EstateScope;
}

function collectorWith(answers: Answers = {}) {
  const executed: Executed[] = [];
  const workspaces = answers.workspaces ?? ['1', '2', '3'];

  const executor = vi.fn((statement: string, parameters: SqlParameters) => {
    const query = /^-- (\S+)/.exec(statement)?.[1] ?? statement;
    executed.push({ query, parameters });
    if (query === DIRECTORY) return Promise.resolve({ data: workspaces.map(workspaceRow) });

    const bound = parameters.live_workspace_ids?.value ?? '';
    const failure = answers.failing?.[bound];
    if (failure != null) return Promise.reject(failure);
    return Promise.resolve({ data: answers.jobs?.[bound] ?? [] });
  });

  return {
    executed,
    collector: new SqlCollector({
      executor,
      scope: answers.scope ?? accountScope('1'),
      queries: answers.queries ?? sliceable(),
    }),
    /** Every `live_workspace_ids` value bound to a named query, in execution order. */
    boundFor: (query: string) =>
      executed.filter((one) => one.query === query).map((one) => one.parameters.live_workspace_ids?.value),
  };
}

async function collect(collector: SqlCollector, ids: SignalId[] = [JOBS]): Promise<SignalResult> {
  const results = await collector.collect(ids, context());
  const result = results.find((one) => one.id === JOBS);
  if (result == null) throw new Error(`no result for ${JOBS}`);
  return result;
}

describe('the statements that declare a slice', () => {
  it('are the four the headers on disk name, so this path cannot silently widen', () => {
    // A fifth statement gaining a `-- Slice:` header starts being executed per workspace, which
    // multiplies its statement count by the estate. That should be a deliberate change with
    // `slices.ts`'s proof behind it, so it fails here first. Read off every file rather than off the
    // four, so a header added elsewhere is what fails rather than going unnoticed.
    const source = new FileQuerySource();
    const declared = readdirSync(queryDirectory())
      .filter((file) => file.endsWith('.sql'))
      .map((file) => file.replace(/\.sql$/, ''))
      .filter((name) => declaredSlice(source.text(name)) != null);

    expect([...declared].sort()).toEqual([...SLICED].sort());
  });

  it('all slice by workspace first, which is the only key the collector can bind', () => {
    // The collector filters a slice by binding `live_workspace_ids`. A statement declaring some
    // other first key would be excluded from slicing silently, so it says so here instead.
    const source = new FileQuerySource();
    const wrong = SLICED.filter((name) => declaredSlice(source.text(name))?.columns[0] !== 'workspace_id');

    expect(wrong).toEqual([]);
  });
});

describe('a sliced statement', () => {
  it('runs once per live workspace, each bound to that workspace alone', async () => {
    const { collector, boundFor } = collectorWith();

    await collect(collector);

    expect(boundFor('jobs_inventory')).toEqual(['1', '2', '3']);
  });

  /*
   * A run narrowed to a named set still slices, which is the difference between this and `narrowedTo`.
   * Six workspaces of forty is an estate to spread across, and the groups have to come from the narrowed
   * live set: drawn from the account they would execute a statement per workspace to have most of them
   * answer for workspaces the scope excludes.
   */
  it('slices the named workspaces and not the account', async () => {
    const { collector, boundFor } = collectorWith({
      workspaces: ['1', '2', '3', '4'],
      scope: selectedScope(accountScope('1'), ['2', '4']),
    });

    await collect(collector);

    expect(boundFor('jobs_inventory')).toEqual(['2', '4']);
  });

  it('keeps every row, which is what keeps every estate-wide number', async () => {
    // The whole justification for the slicing: the population is unchanged, so a control scoring a
    // share of jobs scores the same share it would have.
    const { collector } = collectorWith({
      jobs: { '1': [jobRow('1', 'alpha')], '2': [jobRow('2', 'beta'), jobRow('2', 'gamma')] },
    });

    const jobs = (await collect(collector)).value as JobRow[];

    expect(jobs).toHaveLength(3);
    expect(jobs.map((job) => job.workspaceId)).toEqual(['1', '2', '2']);
  });

  it('reports complete coverage when every slice answered', async () => {
    const { collector } = collectorWith({ jobs: { '1': [jobRow('1', 'alpha')] } });

    expect((await collect(collector)).coverage).toEqual({ mode: 'complete', reach: 'metastore' });
  });

  it('puts the concatenation back in the statement’s own order', async () => {
    // Without this the first rows of the value — the ones a finding quotes as its examples — come
    // from whichever workspace executed first rather than from the top of the estate's list.
    const { collector } = collectorWith({
      jobs: { '1': [jobRow('1', 'nightly')], '2': [jobRow('2', 'ad-hoc')], '3': [jobRow('3', 'monthly')] },
    });

    const jobs = (await collect(collector)).value as JobRow[];

    expect(jobs.map((job) => job.name)).toEqual(['ad-hoc', 'monthly', 'nightly']);
  });

  it('counts as one statement per slice against the query budget', async () => {
    // Each slice is a real statement on the customer's warehouse, so the surface budget has to see
    // three of them. Submitting them as one task would let a wide estate quietly spend three times
    // what the budget allows.
    const scheduler = new CollectionScheduler();
    const { collector } = collectorWith();

    await collector.collect([JOBS], { credentials: credentials(), scheduler, collected: new Map() });

    // The directory plus one per workspace.
    expect(scheduler.footprint().tasks.sql.ok).toBe(4);
  });
});

describe('a statement that is not sliced', () => {
  it('runs whole when it declares no slice, however divisible it looks', async () => {
    // `slices.ts` is what establishes that splitting a statement does not change its answer, and it
    // does that per statement. An undeclared statement has no such proof, so it keeps the binding
    // it always had.
    const { collector, boundFor } = collectorWith({
      queries: new StaticQuerySource({
        [DIRECTORY]: `-- ${DIRECTORY}\nSELECT 1`,
        jobs_inventory: '-- jobs_inventory\n-- Rows: one per job\nSELECT 1\nORDER BY name',
      }),
    });

    await collect(collector);

    expect(boundFor('jobs_inventory')).toEqual(['1,2,3']);
  });

  it('runs whole when one workspace is live, because a single slice is the statement', async () => {
    const { collector, boundFor } = collectorWith({ workspaces: ['1'] });

    await collect(collector);

    expect(boundFor('jobs_inventory')).toEqual(['1']);
  });

  it('runs whole when the user narrowed the scan to one workspace', async () => {
    const executed: Executed[] = [];
    const executor = vi.fn((statement: string, parameters: SqlParameters) => {
      const query = /^-- (\S+)/.exec(statement)?.[1] ?? statement;
      executed.push({ query, parameters });
      return Promise.resolve({ data: query === DIRECTORY ? [workspaceRow('1'), workspaceRow('2')] : [] });
    });
    const collector = new SqlCollector({ executor, scope: workspaceScope('1'), queries: sliceable() });

    await collect(collector);

    // One statement, and the user's own narrowing is what filters it. The live set still holds both
    // workspaces, and binding it per slice here would assess a workspace the user excluded.
    const jobs = executed.filter((one) => one.query === 'jobs_inventory');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.parameters.workspace_id?.value).toBe('1');
  });
});

describe('how many slices one statement becomes', () => {
  it('is one per workspace under the ceiling, which is what a real account gets', () => {
    expect(sliceGroups(['1', '2', '3'])).toEqual([['1'], ['2'], ['3']]);
  });

  it('groups workspaces once there are more of them than the ceiling allows', () => {
    const groups = sliceGroups(Array.from({ length: 500 }, (_unused, at) => String(at)));

    expect(groups).toHaveLength(MAX_SLICES);
    // Every workspace exactly once, in order: the split is only lossless if the groups partition the
    // set, and a rounding mistake here would drop the tail of the estate silently.
    expect(groups.flat()).toEqual(Array.from({ length: 500 }, (_unused, at) => String(at)));
    expect(groups.every((group) => group.length > 0)).toBe(true);
  });

  it('stays inside the sql budget at the declared estate, with room for sub-slicing', () => {
    // The reason there is a ceiling at all. One slice per workspace at 500 workspaces is 2,000
    // statements against a budget of 250: the scan would exhaust partway through the first sliced
    // statement and report the other eighteen signals as unmeasured. Derived from `defaultLimits` and
    // `SCALE_TARGETS` rather than restated, so raising the fan-out or lowering the budget fails here.
    const sliced = SLICED.length;
    const worst = SQL_SIGNALS.length - sliced + sliced * MAX_SLICES;

    expect(sliceGroups(Array.from({ length: SCALE_TARGETS.workspace }, (_unused, at) => String(at)))).toHaveLength(
      MAX_SLICES
    );
    expect(worst).toBeLessThan(defaultLimits('shared').sql.budget);
  });

  it('stays inside the budget even when every sliced statement sub-divides', () => {
    // The worst case the app can produce at all: sub-division is driven by the estate rather than by
    // the plan, so on a skewed account all four sliced statements spend their whole allowance. Without a
    // ceiling on the total this is twelve groups times twenty sub-slices times four statements.
    const worst = SQL_SIGNALS.length - SLICED.length + SLICED.length * MAX_EXECUTIONS;

    expect(MAX_EXECUTIONS).toBeGreaterThan(MAX_SLICES);
    expect(worst).toBeLessThan(defaultLimits('shared').sql.budget);
  });
});

describe('a workspace whose own slice is too large to return', () => {
  /**
   * An executor that behaves like the warehouse does with a `byte_limit`: it honours the bucket
   * predicate, and any slice over `capacity` rows comes back trimmed with `truncated: true`.
   *
   * The trimmed prefix is returned deliberately, because the collector has to discard it. Keeping it
   * alongside the buckets that replace it would count the same jobs twice, which is a wrong number in
   * the direction nobody checks.
   */
  function truncatingCollector(rows: Readonly<Record<string, readonly Record<string, unknown>[]>>, capacity: number) {
    const statements: string[] = [];
    const executor = vi.fn((statement: string, parameters: SqlParameters) => {
      if (/^-- workspace_directory/.test(statement)) {
        return Promise.resolve({ data: ['1', '2'].map(workspaceRow) });
      }
      statements.push(statement);

      const bound = (parameters.live_workspace_ids?.value ?? '').split(',');
      const all = bound.flatMap((id) => rows[id] ?? []);
      const bucket = /pmod\(hash\(sliced\.`(\w+)`\), (\d+)\) = (\d+)/.exec(statement);
      const mine =
        bucket == null
          ? all
          : all.filter((row) => hashOf(String(row[bucket[1] ?? ''])) % Number(bucket[2]) === Number(bucket[3]));

      return mine.length > capacity
        ? Promise.resolve({ data: mine.slice(0, capacity), truncated: true })
        : Promise.resolve({ data: mine });
    });

    return {
      statements,
      collector: new SqlCollector({ executor, scope: accountScope('1'), queries: sliceable() }),
    };
  }

  /** Whatever `hash()` does, it is deterministic and this stands in for it. */
  function hashOf(value: string): number {
    let hash = 0;
    for (const character of value) hash = (hash * 31 + character.codePointAt(0)!) % 1_000_003;
    return hash;
  }

  const many = (workspace: string, count: number) =>
    Array.from({ length: count }, (_unused, at) => jobRow(workspace, `job-${String(at)}`));

  it('is re-executed as buckets of its key, and every row still arrives', async () => {
    // The case the workspace axis does not cover: eleven jobs in workspace 1, one in workspace 2, and a
    // slice that carries four. No grouping of two workspaces helps, because the group that does not fit
    // is a single workspace.
    const { collector } = truncatingCollector({ '1': many('1', 11), '2': many('2', 1) }, 4);

    const result = await collect(collector);
    const jobs = result.value as JobRow[];

    expect(result.status).toBe('observed');
    expect(jobs).toHaveLength(12);
    // Every job exactly once. A bucket predicate that overlapped would duplicate and one that left a
    // gap would drop, and both look like a plausible estate from the outside.
    expect(new Set(jobs.map((job) => job.jobId)).size).toBe(12);
    expect(result.coverage).toEqual({ mode: 'complete', reach: 'metastore' });
  });

  it('divides again when a bucket is itself too large', async () => {
    // Four buckets of a hundred jobs are still over a slice that carries ten, so each is divided again.
    // Sixteen buckets of the workspace, and the recursion is what makes the depth arbitrary rather than
    // a guess about how skewed one workspace can be.
    const { collector, statements } = truncatingCollector({ '1': many('1', 100), '2': many('2', 1) }, 10);

    const jobs = (await collect(collector)).value as JobRow[];

    expect(jobs).toHaveLength(101);
    expect(new Set(jobs.map((job) => job.jobId)).size).toBe(101);
    // Divided at two moduli, which is the nesting: the second level asks for sixteenths of the same
    // keys the first level's quarters held.
    expect(statements.filter((sql) => sql.includes(', 4) ='))).toHaveLength(4);
    expect(statements.filter((sql) => sql.includes(', 16) ='))).toHaveLength(16);
  });

  it('stops dividing at the declared depth and says the estate is past it', async () => {
    // A workspace that does not fit in a sixteenth of itself. There is no honest number to report for
    // it, so it is reported as missing rather than as a population — and the sentence says what it is
    // rather than "an error occurred", because the reader's next move is to ask Databricks.
    const { collector } = truncatingCollector({ '1': many('1', 1000), '2': many('2', 1) }, 10);

    const result = await collect(collector);

    expect(result.coverage.mode).toBe('sampled');
    expect(result.coverage.basis).toContain('1 of 2 groups did not complete');
    expect(result.coverage.basis).toContain('divided sixteen ways');
    // And the workspace that did fit is still measured, which is the point of reporting a shortfall
    // rather than failing the signal.
    expect((result.value as JobRow[]).map((job) => job.workspaceId)).toEqual(['2']);
  });

  it('discards the truncated rows rather than counting them alongside the buckets', async () => {
    // The trimmed prefix and the buckets that replace it are the same rows. `serverless_job_spend`
    // sums dollars per job, so a duplicated row is a doubled cost in a customer's report.
    const { collector } = truncatingCollector({ '1': many('1', 6), '2': many('2', 1) }, 4);

    const jobs = (await collect(collector)).value as JobRow[];

    expect(jobs).toHaveLength(7);
  });

  it('reports a shortfall rather than bucketing when the statement declares no finer axis', async () => {
    // `slices.ts` checks each declared axis against the SQL. An axis it did not check is an axis whose
    // aggregates may consume it, and bucketing on one would inflate every `count(DISTINCT …)` in the
    // statement without failing.
    const executor = vi.fn((statement: string, parameters: SqlParameters) =>
      /^-- workspace_directory/.test(statement)
        ? Promise.resolve({ data: ['1', '2'].map(workspaceRow) })
        : Promise.resolve({
            data: [jobRow(parameters.live_workspace_ids?.value ?? '', 'one')],
            truncated: (parameters.live_workspace_ids?.value ?? '') === '1',
          })
    );
    const collector = new SqlCollector({
      executor,
      scope: accountScope('1'),
      queries: new StaticQuerySource({
        [DIRECTORY]: `-- ${DIRECTORY}\n-- Rows: one per workspace\nSELECT 1`,
        jobs_inventory: '-- jobs_inventory\n-- Rows: one per job\n-- Slice: workspace_id\nSELECT 1\nORDER BY name',
      }),
    });

    const result = await collect(collector);

    expect(result.coverage.mode).toBe('sampled');
    expect(result.coverage.basis).toContain('no axis inside a workspace to divide it on');
  });

  it('is unmeasured, not short, when a statement that cannot be sliced is truncated', async () => {
    // One workspace, so nothing is sliced and there is no second attempt to make. Reported as
    // unmeasured because the rows are a prefix of the answer: before `byte_limit` this was an API
    // failure, and the change must not turn it into a quiet undercount.
    const executor = vi.fn((statement: string) =>
      /^-- workspace_directory/.test(statement)
        ? Promise.resolve({ data: [workspaceRow('1')] })
        : Promise.resolve({ data: [jobRow('1', 'one')], truncated: true })
    );
    const collector = new SqlCollector({ executor, scope: accountScope('1'), queries: sliceable() });

    const result = await collect(collector);

    expect(result.status).toBe('unmeasurable');
    expect(result.unmeasurableReason).toContain('more data than an inline result can carry');
  });
});

describe('the slice loop itself', () => {
  const ok = (rows: readonly Record<string, unknown>[]) => ({
    status: 'ok' as const,
    value: { rows: [...rows] },
    attempts: 1,
  });
  const describe_ = () => 'because it did not';
  const groupsOf = (...ids: string[]) => ids.map((id) => [id]);

  it('runs one slice at a time, so a wide estate does not queue behind itself', async () => {
    // The scheduler bounds concurrency, and this loop is the largest multiplier in the scan: four
    // statements times the workspace count. Issuing them together would put the customer's own
    // queries behind all of them.
    let running = 0;
    let mostAtOnce = 0;

    await collectSlices({
      groups: groupsOf('1', '2', '3'),
      order: undefined,
      describe: describe_,
      run: async () => {
        running += 1;
        mostAtOnce = Math.max(mostAtOnce, running);
        await Promise.resolve();
        running -= 1;
        return ok([]);
      },
    });

    expect(mostAtOnce).toBe(1);
  });

  it('reads an all-empty result as a reading, not as a failure', async () => {
    // An estate where no workspace has a job. Only the statement's own `noAnswer` can tell that from
    // a statement that measured nothing, so this must not decide it here.
    const reading = await collectSlices({
      groups: groupsOf('1', '2'),
      order: undefined,
      describe: describe_,
      run: () => Promise.resolve(ok([])),
    });

    expect(reading).toEqual({ status: 'read', rows: [] });
  });

  it('carries the first failure out when nothing answered', async () => {
    const reading = await collectSlices({
      groups: groupsOf('1', '2'),
      order: undefined,
      describe: describe_,
      run: (workspaces) =>
        Promise.resolve({
          status: 'skipped' as const,
          reason: 'permission-denied' as const,
          detail: `slice ${workspaces.join(',')}`,
        }),
    });

    expect(reading.status).toBe('none');
    expect(reading.status === 'none' && reading.outcome.status === 'skipped' && reading.outcome.detail).toBe('slice 1');
  });

  it('leaves every group its own execution rather than spending the allowance on the first', async () => {
    // A skewed estate could otherwise cost the rest of itself: the first workspace subdivides, and
    // subdividing is depth-first, so without a reserve the groups after it would be refused for a budget
    // the first one spent. Reported the other way round — group one short, groups two and three read —
    // because that is the choice, not an accident of ordering.
    const runs: (string | undefined)[] = [];
    const reading = await collectSlices({
      groups: groupsOf('1', '2', '3'),
      order: undefined,
      describe: describe_,
      bucketOn: 'job_id',
      limit: 4,
      run: (workspaces, bucket) => {
        runs.push(bucket == null ? workspaces.join(',') : `${workspaces.join(',')}#${String(bucket.index)}`);
        return Promise.resolve(
          workspaces[0] === '1'
            ? { status: 'ok' as const, value: { rows: [], truncated: true }, attempts: 1 }
            : ok([{ workspace_id: workspaces[0] }])
        );
      },
    });

    expect(runs).toEqual(['1', '2', '3']);
    expect(reading.status === 'read' && reading.rows).toHaveLength(2);
    expect(reading.status === 'read' && reading.shortfall?.read).toBe(2);
    expect(reading.status === 'read' && reading.shortfall?.of).toBe(3);
    expect(reading.status === 'read' && reading.shortfall?.why).toContain('executions one check is allowed');
  });

  it('keeps the buckets that answered when one of them did not', async () => {
    // Each bucket is a complete set of rows for the keys it holds, because the bucket column is a key of
    // the statement's own grouping — so three of four is three quarters of a workspace, not a quarter of
    // an answer. The group still counts against coverage.
    const reading = await collectSlices({
      groups: groupsOf('1'),
      order: undefined,
      describe: () => 'One bucket was refused.',
      bucketOn: 'job_id',
      run: (_workspaces, bucket) => {
        if (bucket == null) {
          return Promise.resolve({ status: 'ok' as const, value: { rows: [], truncated: true }, attempts: 1 });
        }
        return bucket.index === 0
          ? Promise.resolve({
              status: 'skipped' as const,
              reason: 'permission-denied' as const,
              detail: 'bucket 1 was refused',
            })
          : Promise.resolve(ok([{ job_id: String(bucket.index) }]));
      },
    });

    expect(reading.status === 'read' && reading.rows.map((row) => row.job_id)).toEqual(['1', '2', '3']);
    expect(reading.status === 'read' && reading.shortfall?.why).toContain('One bucket was refused.');
  });
});

describe('a sliced statement that could not read every workspace', () => {
  const failing = { '2': Object.assign(new Error('PERMISSION_DENIED: user has no SELECT'), { status: 403 }) };

  it('reports what it read as a sample of the estate rather than as the estate', async () => {
    const { collector } = collectorWith({
      failing,
      jobs: { '1': [jobRow('1', 'alpha')], '3': [jobRow('3', 'gamma')] },
    });

    const result = await collect(collector);

    expect(result.status).toBe('observed');
    expect(result.coverage.mode).toBe('sampled');
    // In the basis, in words, and deliberately not in `examined`/`population`: those two count the
    // resource a control is about — schemas, tables — and the UI renders them as "2 of 3 resources
    // affected" and ranks on the first number. Slices there would report a jobs finding covering
    // thirteen thousand jobs as affecting two resources.
    expect(result.coverage.examined).toBeUndefined();
    expect(result.coverage.population).toBeUndefined();
    expect(result.coverage.basis).toContain('1 of 3 groups did not complete');
    // The reason travels with the count, because "2 of 3" on its own tells the reader nothing they
    // can act on, and this one is a grant they can make.
    expect(result.coverage.basis).toContain('PERMISSION_DENIED');
  });

  it('still keeps the rows it did read, because two workspaces of evidence is evidence', async () => {
    const { collector } = collectorWith({ failing, jobs: { '1': [jobRow('1', 'alpha')] } });

    expect((await collect(collector)).value).toHaveLength(1);
  });

  it('is unmeasured when the slices that answered held no rows', async () => {
    // The rows it does have came from the groups that answered, and the groups that did not are
    // where the rows would be. Reported as a measurement it would reach a resolver as an estate with
    // no jobs in it — the same wrong answer `noAnswer` exists to prevent, by a route slicing opened.
    const { collector } = collectorWith({ failing, jobs: {} });

    const result = await collect(collector);

    expect(result.status).toBe('unmeasurable');
    expect(result.unmeasurableReason).toContain('1 of 3 groups did not complete');
  });

  it('names every distinct reason, not just the first', async () => {
    // Nine throttles and one permission denial have different answers, and a reader told only about
    // the throttle fixes half the problem.
    const { collector } = collectorWith({
      failing: {
        '1': Object.assign(new Error('PERMISSION_DENIED: no SELECT'), { status: 403 }),
        '2': Object.assign(new Error('TABLE_OR_VIEW_NOT_FOUND: system.lakeflow.jobs'), { status: 404 }),
      },
      jobs: { '3': [jobRow('3', 'gamma')] },
    });

    const basis = (await collect(collector)).coverage.basis ?? '';

    expect(basis).toContain('PERMISSION_DENIED');
    expect(basis).toContain('TABLE_OR_VIEW_NOT_FOUND');
  });

  it('is unmeasured rather than sampled when no slice answered', async () => {
    // Nothing was read, so there is no partial reading to report. Reporting zero of three as a
    // sample would put an empty population into a control's denominator.
    const { collector } = collectorWith({
      failing: {
        '1': new Error('one'),
        '2': new Error('two'),
        '3': new Error('three'),
      },
    });

    const result = await collect(collector);

    expect(result.status).toBe('unmeasurable');
    expect(result.coverage.mode).toBe('complete');
  });

  it('is complete when every slice answered with nothing, because that is an estate with no jobs', async () => {
    // The distinction the case above turns on: no rows and no failures is a measurement.
    const { collector } = collectorWith();

    const result = await collect(collector);

    expect(result.status).toBe('observed');
    expect(result.value).toEqual([]);
    expect(result.coverage).toEqual({ mode: 'complete', reach: 'metastore' });
  });
});
