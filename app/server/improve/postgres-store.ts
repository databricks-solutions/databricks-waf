// Durable plans and actions, in the Lakebase schema the app owns.
//
// Two tables, both keyed on (id, revision) and both insert-only. The reasoning for that key is in
// store.ts and matches `assessment_definition_versions`: a plan and an action are edited by people,
// often two at once, and a primary key the database enforces is the only thing that turns the second
// of two simultaneous transitions into a message rather than into silence.
//
// Reads take every revision and pick the highest per id in TypeScript rather than asking Postgres for
// `distinct on (id) ... order by revision desc`. Two reasons, in order of weight. The in-memory store
// has to answer identically, and one implementation of "highest revision" cannot drift from itself.
// And the row count is revisions-per-action — a handful each, over a few hundred actions — which is
// nothing beside the scans table this app already reads whole.
//
// `actionsFor` is the exception, and it is measured rather than argued: at the volume this app's own
// retention default allows, it fetched 11,136 rows and grew the heap by 152.7 MiB to answer with 17 —
// see [the history read budget](../../../docs/design/history-read-budget.md). What it narrows on is
// the body, not a denormalised `control_ids` column: one writer per fact, and the body is the writer.
// What it does *not* narrow is the revision, and the reason is beside the query.

import { digestOf } from '../records/digest.js';
import type { Postgres } from '../store/postgres.js';
import type { ImprovementAction, Transition } from './action.js';
import type { AdviceProvenance } from './advice.js';
import type { ImprovementPlan } from './plan.js';
import { ConcurrentChangeError, MismatchedPlanError, newestFirst, revisionOf, type ImprovementStore } from './store.js';
import { applyScope, inScope, type AssessmentScope } from '../store/assessment-scope.js';

/** Postgres' code for a unique or primary key violation. */
const UNIQUE_VIOLATION = '23505';

export interface PostgresImprovementStoreOptions {
  readonly db: Postgres;
  readonly onError?: (operation: string, error: unknown) => void;
}

interface BodyRow {
  readonly body: unknown;
}

export class PostgresImprovementStore implements ImprovementStore {
  readonly durable = true;

  constructor(private readonly options: PostgresImprovementStoreOptions) {}

  async plans(scope?: AssessmentScope): Promise<readonly ImprovementPlan[]> {
    const scoped = applyScope('', [], scope);
    const rows = await this.read('read every plan', 'improvement_plans', scoped.fragment, scoped.values);
    return newestFirst(highest(rows.map(revivePlan), (plan) => plan.id, this.reporter('read every plan')));
  }

  async plan(id: string, scope?: AssessmentScope): Promise<ImprovementPlan | undefined> {
    const scoped = applyScope('where id = $1', [id], scope);
    const rows = await this.read(`read plan ${id}`, 'improvement_plans', scoped.fragment, scoped.values);
    return highest(rows.map(revivePlan), (plan) => plan.id, this.reporter(`read plan ${id}`))[0];
  }

  addPlan(plan: ImprovementPlan): Promise<void> {
    return this.writePlan(plan);
  }

  changePlan(plan: ImprovementPlan): Promise<void> {
    return this.writePlan(plan);
  }

  async actions(planId: string, scope?: AssessmentScope): Promise<readonly ImprovementAction[]> {
    if (scope !== undefined) {
      const plan = await this.plan(planId, scope);
      if (plan == null) return [];
    }
    const operation = `read actions of plan ${planId}`;
    const rows = await this.read(operation, 'improvement_actions', 'where plan_id = $1', [planId]);
    return highest(rows.map(reviveAction), (action) => action.id, this.reporter(operation));
  }

  async action(id: string, scope?: AssessmentScope): Promise<ImprovementAction | undefined> {
    const rows = await this.read(`read action ${id}`, 'improvement_actions', 'where id = $1', [id]);
    const action = highest(rows.map(reviveAction), (action) => action.id, this.reporter(`read action ${id}`))[0];
    if (action == null || scope === undefined) return action;
    // The plan is read unscoped so a missing parent is distinguishable from one that belongs to
    // another assessment. An orphan is returned so the validation pass can report it rather than
    // treat it as out of scope; a plan that exists under a different definition is not.
    const plan = await this.plan(action.planId);
    if (plan == null) return action;
    return inScope(plan.assessment?.definitionId, scope) ? action : undefined;
  }

  async actionsFor(controlId: string, scope?: AssessmentScope): Promise<readonly ImprovementAction[]> {
    const operation = `read actions naming ${controlId}`;
    // Two statements rather than one, and the second reads by the ids the first found.
    //
    // The obvious single statement — `where id in (select id from … where body @> …)` — was measured
    // and is worse: the planner has no estimate for how few ids come back, so it hash-joins the
    // subquery against a sequential scan of the whole table and reads every row anyway. Asking for
    // the ids first lets the second read be a primary-key lookup on a handful of them.
    //
    // What is fetched is every revision of the actions that have *ever* named this requirement,
    // rather than the rows that name it. Two things need the wider set. An action edited to drop the
    // requirement has an older revision that still names it, and narrowing to matching rows would
    // make that stale revision the highest one the reduction below sees — the reader would be shown
    // work that no longer belongs to what they opened. And `highest` falls back to the newest
    // *readable* revision, which it cannot do when the unreadable one is the only row fetched.
    //
    // So the reduction and the filter stay exactly where they were, both of them in TypeScript and
    // both shared with the in-memory store. What moved is how much the database sends to feed them.
    const candidates = await this.naming(operation, controlId);
    if (candidates.length === 0) return [];
    const rows = await this.read(operation, 'improvement_actions', 'where id = any($1::text[])', [candidates]);
    const current = highest(rows.map(reviveAction), (action) => action.id, this.reporter(operation));
    const named = current.filter((action) => action.controlIds.includes(controlId));
    if (scope === undefined) return named;
    const plans = await this.plans(scope);
    const allowed = new Set(plans.map((plan) => plan.id));
    return named.filter((action) => allowed.has(action.planId));
  }

  async actionsRaised(scope?: AssessmentScope): Promise<readonly ImprovementAction[]> {
    const plans = await this.plans(scope);
    const collected = await Promise.all(plans.map((plan) => this.actions(plan.id, scope)));
    return collected.flat();
  }

  addAction(action: ImprovementAction, plan: ImprovementPlan): Promise<void> {
    return this.writeAction(action, plan);
  }

  changeAction(action: ImprovementAction, plan: ImprovementPlan): Promise<void> {
    return this.writeAction(action, plan);
  }

  private async writePlan(plan: ImprovementPlan): Promise<void> {
    const { db } = this.options;
    const revision = revisionOf(plan);
    // `changed_at` is the closure date once there is one, and the creation date before: the column
    // says when this revision came to be, which for revision 0 is when the plan did. Retention reads
    // `created_at`, so a plan and every revision of it age together rather than a closure keeping the
    // original row alive past its period.
    const changedAt = plan.closed?.at ?? plan.createdAt;
    await this.insert('plan', plan.id, () =>
      db.query(
        // `definition_id` is `assessment.definitionId` promoted to a column, written from the body on
        // every revision. Not because the citation is editable — no route rewrites it today, only
        // `POST` sets it and `closed()` spreads it forward — but because the column is a handle on the
        // body rather than a second record of it, and a handle is written wherever the body is. The
        // alternative is a write path that is correct only while an endpoint that does not exist
        // continues not to exist.
        `insert into ${db.schema}.improvement_plans
           (id, revision, created_at, changed_at, body, digest, definition_id)
           values ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [
          plan.id,
          revision,
          plan.createdAt,
          changedAt,
          JSON.stringify(plan),
          digestOf(plan),
          plan.assessment?.definitionId ?? null,
        ]
      )
    );
  }

  private async writeAction(action: ImprovementAction, plan: ImprovementPlan): Promise<void> {
    if (action.planId !== plan.id) throw new MismatchedPlanError(action, plan);

    const { db } = this.options;
    const revision = revisionOf(action);
    const changedAt = action.history.at(-1)?.at ?? action.createdAt;
    // `plan_created_at` is the plan's date, not this action's, and that is the column retention
    // measures an action's age from — so a sweep removes a plan and the actions inside it in one
    // pass. Measured from its own date, an action raised late in a long plan would outlive the plan
    // it belongs to, and what is left reads as work nobody can trace to a decision.
    await this.insert('action', action.id, () =>
      db.query(
        `insert into ${db.schema}.improvement_actions
           (id, revision, plan_id, plan_created_at, created_at, changed_at, body, digest)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          action.id,
          revision,
          action.planId,
          plan.createdAt,
          action.createdAt,
          changedAt,
          JSON.stringify(action),
          digestOf(action),
        ]
      )
    );
  }

  private async insert(kind: 'plan' | 'action', id: string, write: () => Promise<unknown>): Promise<void> {
    try {
      await write();
    } catch (error) {
      // The only failure translated rather than raised: a duplicate key here means somebody else
      // wrote this revision first, which is a thing to tell the author rather than an outage. Every
      // other failure — a closed pool, a permission that was revoked — reaches the route as itself.
      if (isUniqueViolation(error)) throw new ConcurrentChangeError(kind, id);
      throw error;
    }
  }

  /**
   * The ids of the actions any revision of which names this requirement.
   *
   * Answered from `improvement_actions_by_control`, and a failure reads as none — the same shape as
   * `read` below, for the same reason: a requirement page missing its actions and saying so is
   * better than one that will not render.
   */
  private async naming(operation: string, controlId: string): Promise<string[]> {
    const { db } = this.options;
    try {
      const { rows } = await db.query<{ id: string }>(
        `select distinct id from ${db.schema}.improvement_actions
           where body -> 'controlIds' @> to_jsonb($1::text)`,
        [controlId]
      );
      return rows.map((row) => row.id);
    } catch (error) {
      this.options.onError?.(operation, error);
      return [];
    }
  }

  private async read(
    operation: string,
    table: 'improvement_plans' | 'improvement_actions',
    where: string,
    values: readonly unknown[]
  ): Promise<unknown[]> {
    const { db } = this.options;
    try {
      const { rows } = await db.query<BodyRow>(
        `select body from ${db.schema}.${table} ${where} order by revision asc`,
        values
      );
      return rows.map((row) => row.body);
    } catch (error) {
      // A failed read reads as empty and says so through onError, which is what every other store
      // here does. A plans page that throws because one row is unreadable is worse than a plans page
      // that is missing a plan and has logged why.
      this.options.onError?.(operation, error);
      return [];
    }
  }

  private reporter(operation: string): (unreadable: number, noun: string) => void {
    return (unreadable, noun) => {
      // Counted and reported once. A shape change that makes every row unreadable would otherwise
      // emit a line per revision, and the number is the useful part.
      this.options.onError?.(operation, new Error(`${String(unreadable)} stored ${noun} row(s) could not be read`));
    };
  }
}

/**
 * The highest revision of each record, with unreadable rows counted rather than thrown on.
 *
 * A row that will not revive is skipped, which for a record with several revisions means the newest
 * readable one is used. That is the right failure: a plan whose closure row is unreadable reads as
 * open, which is visible and wrong in the safe direction, where dropping the plan entirely would
 * lose the actions hanging off it.
 */
function highest<T extends { readonly id: string }>(
  revived: readonly (T | undefined)[],
  idOf: (record: T) => string,
  report: (unreadable: number, noun: string) => void
): T[] {
  const unreadable = revived.filter((record) => record == null).length;
  if (unreadable > 0) report(unreadable, 'improvement');

  const newest = new Map<string, T>();
  for (const record of revived) {
    if (record == null) continue;
    // Read in ascending revision order, so a later row is always the better one and no comparison is
    // needed here. Ordering in the query rather than in a comparator keeps this honest about what it
    // depends on: change the `order by` and this line is wrong.
    newest.set(idOf(record), record);
  }
  return [...newest.values()];
}

function revivePlan(raw: unknown): ImprovementPlan | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const candidate = raw as ImprovementPlan & { createdAt: string | Date; closed?: { at: string | Date } };
  if (typeof candidate.id !== 'string' || typeof candidate.title !== 'string') return undefined;
  // Unreadable rather than defaulted to 0, because the revision is what the next write is keyed on: a
  // record revived a revision short would be written over the row it came from.
  if (typeof candidate.revision !== 'number') return undefined;

  const createdAt = date(candidate.createdAt);
  if (createdAt == null) return undefined;

  if (candidate.closed == null) return { ...candidate, createdAt };

  const closedAt = date(candidate.closed.at);
  // A closure whose date will not parse is not treated as an open plan: the plan would then accept
  // new actions, which is precisely what closing it was meant to stop. Unreadable is safer.
  if (closedAt == null) return undefined;
  return { ...candidate, createdAt, closed: { ...candidate.closed, at: closedAt } };
}

function reviveAction(raw: unknown): ImprovementAction | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const candidate = raw as ImprovementAction & {
    createdAt: string | Date;
    due?: string | Date;
    history: readonly (Transition & { at: string | Date })[];
  };
  if (typeof candidate.id !== 'string' || typeof candidate.planId !== 'string') return undefined;
  if (typeof candidate.revision !== 'number') return undefined;

  // Checked through a widened view of the property rather than on the property itself. `Array.isArray`
  // narrows to `any[]`, so asking it about `candidate.history` would replace the declared element type
  // with `any` and leave every read of a transition below unchecked — the opposite of what the check
  // is for.
  if (!Array.isArray((candidate as { history?: unknown }).history)) return undefined;
  const stored: readonly (Transition & { at: string | Date })[] = candidate.history;

  const createdAt = date(candidate.createdAt);
  if (createdAt == null) return undefined;

  const history: Transition[] = [];
  for (const transition of stored) {
    const at = date(transition.at);
    // One unreadable transition makes the whole action unreadable, rather than the history being
    // returned short. The history is what says how the action reached the state it claims, and a
    // record that has silently forgotten a step of that is worse to show than one that is missing.
    if (at == null) return undefined;
    history.push({ ...transition, at });
  }

  const due = candidate.due == null ? undefined : date(candidate.due);
  if (candidate.due != null && due == null) return undefined;

  const advice = reviveAdvice(candidate.advice);
  // Unreadable rather than dropped, on the same terms as a transition whose date will not parse. An
  // action raised from advice is one whose provenance is the only account of what it is for; served
  // without it, it reads as an action about nothing, and its owner is the only person who could say
  // otherwise.
  if (candidate.advice != null && advice == null) return undefined;

  return {
    ...candidate,
    createdAt,
    history,
    ...(due == null ? {} : { due }),
    ...(advice == null ? {} : { advice }),
  };
}

function reviveAdvice(raw: unknown): AdviceProvenance | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const candidate = raw as AdviceProvenance & { measuredAt: string | Date };
  if (typeof candidate.advisoryId !== 'string' || typeof candidate.rule !== 'string') return undefined;

  const measuredAt = date(candidate.measuredAt);
  if (measuredAt == null) return undefined;
  return { ...candidate, measuredAt };
}

function date(value: string | Date): Date | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error != null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}
