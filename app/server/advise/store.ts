// Where advisory runs are kept.
//
// One table, `advisories`, and it is not `scans` with a flag. ADR 0061's whole point is that the two
// have different retention, different cadence and different lifetimes, and a shared table would make
// every read of either say which it wanted — with the failure mode being an assessment export that
// swept up advice. The run record is shared (ADR 0069) because a run's lifecycle is the same either
// way; what a run *produced* is not.
//
// The body is stored as one JSON document rather than as columns, for the reason the scan store gives:
// what an analysis contains changes as analyses are added, and a shape that has to be migrated every
// time a rule is added is a shape that discourages adding rules. What is promoted to columns is only
// what is filtered or ordered on.

import type { Sql } from '../store/postgres.js';
import type { Advisory, AdvisoryState } from './advisory.js';
import type { AssessmentScope } from '../store/assessment-scope.js';
import { applyScope, inScope } from '../store/assessment-scope.js';

/** One line of advisory history, for a list that does not need the whole analysis. */
export interface AdvisorySummary {
  readonly id: string;
  readonly runId: string;
  readonly finishedAt: Date;
  readonly state: AdvisoryState;
  readonly scope: string;
  readonly lookbackDays: number;
  /** The assessment it ran against, when it ran against one. */
  readonly definitionId?: string;
  /** How many things the run's analyses had an opinion about — jobs plus query shapes. Zero is real. */
  readonly considered: number;
}

export interface AdvisoryStore {
  /** True when what it holds survives a process restart. Surfaced rather than assumed. */
  readonly durable: boolean;
  save(advisory: Advisory): Promise<void>;
  get(id: string, scope?: AssessmentScope): Promise<Advisory | undefined>;
  /** The most recent one, which is what a page with no id in its URL wants. */
  latest(scope?: AssessmentScope): Promise<Advisory | undefined>;
  /** The one a run produced, for a caller holding a run id and not an advisory id. */
  forRun(runId: string, scope?: AssessmentScope): Promise<Advisory | undefined>;
  history(limit?: number, scope?: AssessmentScope): Promise<readonly AdvisorySummary[]>;
}

/**
 * A store for an install with no database, and for tests.
 *
 * Bounded for the same reason the scan one is: an advisory holds a reading per signal and the app runs
 * under a memory limit, so an unbounded history eventually takes the process down — a worse failure
 * than a short history.
 */
export class InMemoryAdvisoryStore implements AdvisoryStore {
  readonly durable = false;

  private readonly advisories: Advisory[] = [];

  constructor(private readonly capacity = 20) {}

  save(advisory: Advisory): Promise<void> {
    this.advisories.unshift(advisory);
    if (this.advisories.length > this.capacity) this.advisories.length = this.capacity;
    return Promise.resolve();
  }

  get(id: string, scope?: AssessmentScope): Promise<Advisory | undefined> {
    const advisory = this.advisories.find((one) => one.id === id);
    if (advisory == null || !inScope(advisory.definition?.id, scope)) return Promise.resolve(undefined);
    return Promise.resolve(advisory);
  }

  latest(scope?: AssessmentScope): Promise<Advisory | undefined> {
    return Promise.resolve(this.advisories.find((one) => inScope(one.definition?.id, scope)));
  }

  forRun(runId: string, scope?: AssessmentScope): Promise<Advisory | undefined> {
    const advisory = this.advisories.find((one) => one.runId === runId);
    if (advisory == null || !inScope(advisory.definition?.id, scope)) return Promise.resolve(undefined);
    return Promise.resolve(advisory);
  }

  history(limit = this.capacity, scope?: AssessmentScope): Promise<readonly AdvisorySummary[]> {
    return Promise.resolve(
      this.advisories
        .filter((one) => inScope(one.definition?.id, scope))
        .slice(0, limit)
        .map(summarise)
    );
  }
}

/**
 * What a history line is projected from.
 *
 * Its own type rather than a `Pick` of the row below, so the column list and the fields it produces
 * cannot drift apart: a column dropped from `SUMMARY_COLUMNS` and left here would arrive as undefined
 * and be reported as a date of `Invalid Date` or a count of `NaN`, and nothing would fail.
 */
interface AdvisorySummaryRow {
  readonly id: string;
  readonly run_id: string;
  readonly finished_at: Date | string;
  readonly state: string;
  readonly scope: string;
  readonly lookback_days: number | string;
  readonly definition_id: string | null;
  readonly considered: number | string;
}

interface AdvisoryRow extends AdvisorySummaryRow {
  readonly started_at: Date | string;
  readonly body: unknown;
}

export class PostgresAdvisoryStore implements AdvisoryStore {
  readonly durable = true;

  constructor(private readonly db: Sql & { readonly schema: string }) {}

  async save(advisory: Advisory): Promise<void> {
    await this.db.query(
      `insert into ${this.db.schema}.advisories
         (id, run_id, started_at, finished_at, state, scope, lookback_days, definition_id, considered, body)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
         on conflict (id) do nothing`,
      [
        advisory.id,
        advisory.runId,
        advisory.startedAt,
        advisory.finishedAt,
        advisory.state,
        advisory.scope.description,
        advisory.lookbackDays,
        advisory.definition?.id ?? null,
        considered(advisory),
        JSON.stringify(encode(advisory)),
      ]
    );
  }

  async get(id: string, scope?: AssessmentScope): Promise<Advisory | undefined> {
    const scoped = applyScope('where id = $1', [id], scope);
    const { rows } = await this.db.query<AdvisoryRow>(
      `select ${COLUMNS} from ${this.db.schema}.advisories ${scoped.fragment}`,
      scoped.values
    );
    return rows[0] == null ? undefined : decode(rows[0]);
  }

  async latest(scope?: AssessmentScope): Promise<Advisory | undefined> {
    const scoped = applyScope('order by finished_at desc limit 1', [], scope);
    const { rows } = await this.db.query<AdvisoryRow>(
      `select ${COLUMNS} from ${this.db.schema}.advisories ${scoped.fragment}`,
      scoped.values
    );
    return rows[0] == null ? undefined : decode(rows[0]);
  }

  async forRun(runId: string, scope?: AssessmentScope): Promise<Advisory | undefined> {
    const scoped = applyScope('where run_id = $1', [runId], scope);
    const { rows } = await this.db.query<AdvisoryRow>(
      `select ${COLUMNS} from ${this.db.schema}.advisories ${scoped.fragment}`,
      scoped.values
    );
    return rows[0] == null ? undefined : decode(rows[0]);
  }

  async history(limit = 20, scope?: AssessmentScope): Promise<readonly AdvisorySummary[]> {
    const scoped = applyScope('order by finished_at desc', [], scope);
    // `SUMMARY_COLUMNS` rather than `COLUMNS`, which is the one difference between this read and the
    // three above it: a history line is eight scalars, and the four other reads want the record. The
    // body is the analyses an advisory run produced, so selecting it here fetched and detoasted the
    // largest column in the table to render a list that does not show it.
    //
    // This is a fixed cost rather than a growing one — `limit` bounds it, and 20 is the default — so it
    // is not in the [read budget](../../../docs/design/history-read-budget.md) and there is no number
    // beside it. It is removed because nothing reads it, not because anything measured it as slow.
    const { rows } = await this.db.query<AdvisorySummaryRow>(
      `select ${SUMMARY_COLUMNS} from ${this.db.schema}.advisories ${scoped.fragment} limit $${String(scoped.values.length + 1)}`,
      [...scoped.values, limit]
    );
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      finishedAt: new Date(row.finished_at),
      state: row.state as AdvisoryState,
      scope: row.scope,
      lookbackDays: Number(row.lookback_days),
      ...(row.definition_id != null ? { definitionId: row.definition_id } : {}),
      considered: Number(row.considered),
    }));
  }
}

const COLUMNS =
  'id, run_id, started_at, finished_at, state, scope, lookback_days, definition_id, considered, body';

/** The same list without the two columns a history line does not show. */
const SUMMARY_COLUMNS = 'id, run_id, finished_at, state, scope, lookback_days, definition_id, considered';

/** One line of history from a record already in hand. */
function summarise(advisory: Advisory): AdvisorySummary {
  return {
    id: advisory.id,
    runId: advisory.runId,
    finishedAt: advisory.finishedAt,
    state: advisory.state,
    scope: advisory.scope.description,
    lookbackDays: advisory.lookbackDays,
    ...(advisory.definition != null ? { definitionId: advisory.definition.id } : {}),
    considered: considered(advisory),
  };
}

/**
 * How many things the run's analyses had an opinion about.
 *
 * A column rather than a read of the body, because it is the one number a history row shows and counting
 * it by parsing every stored analysis would read the whole table to draw a list.
 *
 * Jobs plus query shapes, which is a sum of two unlike things and is the right one anyway: the number
 * exists so a reader scanning history can tell a run that found plenty from a run that found nothing, and
 * splitting it into two columns would make that judgement require arithmetic. `considered` counts the
 * shapes the statement returned rather than the twelve shown, so a run is not credited with less than it
 * looked at.
 */
function considered(advisory: Advisory): number {
  return (advisory.serverless?.jobs.length ?? 0) + (advisory.workload?.considered ?? 0);
}

/**
 * The parts of an advisory that go in the JSON body.
 *
 * Everything that is also a column is left out, so the two cannot disagree about the same fact. The
 * dates are the exception and are excluded for the same reason: a date in JSON is a string that has to
 * be revived, and having one authority for it is what stops a body and a column drifting by a timezone.
 *
 * Every analysis has to be listed here, and forgetting one is silent in exactly the way that ships: the
 * run that produced the advisory holds it in memory and hands it straight back, so the page works for
 * whoever pressed the button and is empty for everybody else, on every reload, and after every scheduled
 * run. The warehouse sizing analysis was missing from this object for one deployment and presented as a
 * permissions problem. `writes down every part of an advisory` in `store.test.ts` is what stops the next
 * one, for every field its fixture sets — so a new analysis goes in that fixture too.
 */
function encode(advisory: Advisory): Record<string, unknown> {
  return {
    scope: advisory.scope,
    stamp: advisory.stamp,
    readings: advisory.readings,
    ...(advisory.incompleteReason != null ? { incompleteReason: advisory.incompleteReason } : {}),
    ...(advisory.definition != null ? { definition: advisory.definition } : {}),
    ...(advisory.serverless != null ? { serverless: advisory.serverless } : {}),
    ...(advisory.workload != null ? { workload: advisory.workload } : {}),
    ...(advisory.sizing != null ? { sizing: advisory.sizing } : {}),
    // Three dates of its own per shape — when the pattern was first and last seen, and when its
    // representative ran — so it is revived on the way back, like `workload` and `jobs`.
    ...(advisory.writes != null ? { writes: advisory.writes } : {}),
    // Carries a date of its own — each job's `lastRun` — so it is revived on the way back, like `workload`.
    ...(advisory.jobs != null ? { jobs: advisory.jobs } : {}),
    // Counts and a boolean, so unlike `workload` it needs nothing revived on the way back.
    ...(advisory.plans != null ? { plans: advisory.plans } : {}),
    // Carries an advisory id rather than a date, for the same reason: nothing here needs reviving.
    ...(advisory.planCapability != null ? { planCapability: advisory.planCapability } : {}),
    // A count, and it has to survive the round trip: its absence beside a non-zero `plans.available` is
    // what says the plan write failed, and a field dropped here would say that on every reload.
    ...(advisory.retainedPlans != null ? { retainedPlans: advisory.retainedPlans } : {}),
  };
}

function decode(row: AdvisoryRow): Advisory {
  const body = row.body as Omit<Advisory, 'id' | 'runId' | 'startedAt' | 'finishedAt' | 'state' | 'lookbackDays'>;
  return {
    ...body,
    id: row.id,
    runId: row.run_id,
    startedAt: new Date(row.started_at),
    finishedAt: new Date(row.finished_at),
    state: row.state as AdvisoryState,
    lookbackDays: Number(row.lookback_days),
    // Revived from the readings' own strings. `collectedAt` is a Date on the type and a string through
    // jsonb, and a page that formatted it would print an ISO string where every other date is a date.
    readings: body.readings.map((reading) => ({ ...reading, collectedAt: new Date(reading.collectedAt) })),
    ...(body.workload != null ? { workload: revive(body.workload) } : {}),
    ...(body.jobs != null ? { jobs: reviveJobs(body.jobs) } : {}),
    ...(body.writes != null ? { writes: reviveWrites(body.writes) } : {}),
  };
}

/**
 * The write analysis with its three dates per shape turned back into dates.
 *
 * Same defect as `revive` and `reviveJobs` were written for, three times over on one row: a surface
 * formatting `firstSeen`, `lastSeen` or `representativeAt` prints an ISO string, and only on a record that
 * has been through the database — never on the one the run that produced it holds in memory.
 */
function reviveWrites(writes: NonNullable<Advisory['writes']>): NonNullable<Advisory['writes']> {
  return {
    ...writes,
    shapes: writes.shapes.map((shape) => ({
      ...shape,
      pattern: {
        ...shape.pattern,
        ...(shape.pattern.firstSeen != null ? { firstSeen: new Date(shape.pattern.firstSeen) } : {}),
        ...(shape.pattern.lastSeen != null ? { lastSeen: new Date(shape.pattern.lastSeen) } : {}),
        ...(shape.pattern.representativeAt != null
          ? { representativeAt: new Date(shape.pattern.representativeAt) }
          : {}),
      },
    })),
  };
}

/**
 * The job analysis with its one date per job turned back into a date.
 *
 * `lastRun` is a `Date` on the type and a string through jsonb, and the same defect `revive` was written for
 * applies here: a surface formatting it prints an ISO string, and only on a record that has been through the
 * database — never on the one the run that produced it hands back.
 */
function reviveJobs(jobs: NonNullable<Advisory['jobs']>): NonNullable<Advisory['jobs']> {
  return {
    ...jobs,
    jobs: jobs.jobs.map((job) =>
      job.health.lastRun == null
        ? job
        : { ...job, health: { ...job.health, lastRun: new Date(job.health.lastRun) } }
    ),
  };
}

/**
 * The workload analysis with its one date turned back into a date.
 *
 * `representativeAt` is a `Date` on the type and a string through jsonb. Without this the surface prints
 * an ISO string where every other date on the page is formatted, which is the kind of defect that ships
 * because it only appears on a record that has been through the database — never on the one the run that
 * produced it holds in memory.
 */
function revive(workload: NonNullable<Advisory['workload']>): NonNullable<Advisory['workload']> {
  const shapes = (given: NonNullable<Advisory['workload']>['top']) =>
    given.map((shape) =>
      shape.row.representativeAt == null
        ? shape
        : { ...shape, row: { ...shape.row, representativeAt: new Date(shape.row.representativeAt) } }
    );
  return { ...workload, top: shapes(workload.top), failing: shapes(workload.failing) };
}
