// Where a query plan's extract is kept, and how many of them.
//
// The advisory record keeps `PlanRetrievalSummary` — how many plans came back — and that is all it can
// keep: it is one jsonb document, and `33b` measured the extracts at 2 MB per workspace per scan. So they
// go in their own table, which is also what their retention wants. Advice is kept for 90 days to see
// whether anybody acted on it; a plan is kept to be compared against the next two, and the number that
// bounds it is a count rather than a period.
//
// ## Three per shape, and why a count rather than a period
//
// The advisor's plan-level rules compare a shape's plan against its recent history: the same query
// planned differently is the finding, and one plan cannot show it. Three is the specification's number
// and it is a sensible one — two says something changed and cannot say which of the two is the outlier.
//
// A period would not do the same job. Shapes run at wildly different rates: the busiest runs hundreds of
// thousands of times in a window and a long tail runs weekly. Thirty days of one is thousands of
// executions and of the other is four, so a period keeps far too much of the first and not enough of the
// second to compare anything. The count is per shape for that reason.
//
// The table is *also* swept by age, in `retention.ts`, and the two bounds do different work: the count
// stops a busy shape from filling the table, and the sweep removes plans for shapes that stopped running
// altogether — which the count never reaches, because a shape with no new executions never displaces its
// own third row.
//
// ## What a row is filed under
//
// `(workspace_id, shape, statement_id)`. The workspace is in the key because
// `workload_query_shapes.sql` groups by it and one query text running in two workspaces is two shapes —
// the defect `33ma` shipped a fix for, in accounting that had left it out.
//
// `shape_version` is beside them and is not part of the key. It says which normalisation produced the
// shape, so a reader comparing three plans can tell three executions of one query from three values that
// happen to collide across a change to the fingerprint. `shape-version.ts` says where it comes from.

import type { PlanExtract } from '../collect/sql/plans/parse.js';
import type { ShapeKey } from '../collect/sql/plans/retrieve.js';
import type { Sql } from '../store/postgres.js';

/**
 * How many executions of one shape are kept.
 *
 * The specification's number, and exported so the store and its tests cannot disagree about it.
 */
export const RETAINED_EXECUTIONS = 3;

/** One execution's plan, as it is kept. */
export interface RetainedPlan extends ShapeKey {
  readonly statementId: string;
  /** The advisory run that fetched it, so a plan can be traced to the run that has the summary. */
  readonly advisoryId: string;
  /**
   * When that run finished, which is what retention ages the row from.
   *
   * Not `observedAt`, and the two are days apart: `retention.ts` says why a period measured from the
   * execution would sweep plans on the day they were filed.
   */
  readonly advisoryAt: Date;
  /** When the execution ran. The domain time, and what three of them are ordered by. */
  readonly observedAt: Date;
  /** Which shape normalisation produced `shape`. See `shape-version.ts`. */
  readonly shapeVersion: string;
  readonly extract: PlanExtract;
}

export interface PlanExtractStore {
  /**
   * Carried because the advisory store beside it carries one, and read by nothing yet: there is no
   * surface onto these rows. When one lands it will want to say the same thing the other surfaces say.
   */
  readonly durable: boolean;
  /**
   * Writes these plans and leaves at most `RETAINED_EXECUTIONS` per shape.
   *
   * One call rather than one per plan, so that a caller handing over several executions of one shape
   * trims that shape once. A run normally hands over one execution each, so the two are usually the
   * same thing; what the batch buys is that they need not be.
   */
  keep(plans: readonly RetainedPlan[]): Promise<void>;
  /**
   * A shape's kept executions, newest first, and never more than `RETAINED_EXECUTIONS`.
   *
   * What the plan-reading rules compare. The cap is on the read as well as on the write, because an
   * interrupted `keep` can leave a fourth row behind and a reader comparing four of three is comparing
   * against a plan the trim had already decided to drop.
   */
  forShape(key: ShapeKey): Promise<readonly RetainedPlan[]>;
}

/** What an ordering needs, which is less than a whole plan: the trim reads two columns. */
interface Execution {
  readonly statementId: string;
  readonly observedAt: Date;
}

/**
 * Newest first, then by statement id.
 *
 * The second key is not decoration: two executions of one shape can carry the same `start_time` to the
 * millisecond, and an order that stopped at the timestamp would decide which of the three to drop
 * differently on each read. A trim has to be repeatable or it removes a different row every run.
 */
function newestFirst(left: Execution, right: Execution): number {
  const byTime = right.observedAt.getTime() - left.observedAt.getTime();
  return byTime !== 0 ? byTime : right.statementId.localeCompare(left.statementId);
}

/**
 * The two fields together, as a map key.
 *
 * One-way: what a caller needs the shape back for is grouping, and a map that holds the shape beside
 * its plans has it already. Splitting the string again would need the separator to be a character
 * neither field can hold — true of an id in every estate anyone has looked at, and worth nothing here,
 * since a wrong split would trim a shape that was never written and leave the real one growing.
 */
function shapeKey(key: ShapeKey): string {
  return `${key.workspaceId}\u0000${key.shape}`;
}

/**
 * This run's plans, grouped by the shape they belong to, so each shape is written and trimmed once.
 *
 * The shape is carried beside its plans rather than recovered from the map key: a group always has a plan
 * to read it from, and reading it from there is one fewer thing that can be parsed wrongly.
 */
function byShape(plans: readonly RetainedPlan[]): Map<string, { key: ShapeKey; plans: RetainedPlan[] }> {
  const grouped = new Map<string, { key: ShapeKey; plans: RetainedPlan[] }>();
  for (const plan of plans) {
    const group = grouped.get(shapeKey(plan));
    if (group == null) grouped.set(shapeKey(plan), { key: plan, plans: [plan] });
    else group.plans.push(plan);
  }
  return grouped;
}

/**
 * For tests and for nothing else.
 *
 * There is no demo path onto this store. A3b's rule is that a new record type may not inherit a store
 * that falls back to process memory, and `chooseStore` follows the advisories it sits beside: an install
 * with nothing durable has no advisor at all rather than one that forgets.
 */
export class InMemoryPlanExtractStore implements PlanExtractStore {
  readonly durable = false;
  private readonly byShape = new Map<string, RetainedPlan[]>();

  keep(plans: readonly RetainedPlan[]): Promise<void> {
    for (const plan of plans) {
      const key = shapeKey(plan);
      const kept = (this.byShape.get(key) ?? []).filter((one) => one.statementId !== plan.statementId);
      kept.push(plan);
      this.byShape.set(key, kept.sort(newestFirst).slice(0, RETAINED_EXECUTIONS));
    }
    return Promise.resolve();
  }

  forShape(key: ShapeKey): Promise<readonly RetainedPlan[]> {
    // Copied. The array behind it is the store's own state, and a caller that sorted what it was handed
    // would reorder what the next trim reads.
    return Promise.resolve([...(this.byShape.get(shapeKey(key)) ?? [])]);
  }
}

/**
 * A row as the driver hands it back.
 *
 * The timestamps are `Date | string` because the two drivers disagree: `pg` parses `timestamptz` into a
 * `Date`, and the fake that stands in for it in tests returns what it was given. `when` takes either, so
 * the store does not have to care which one it is talking to.
 */
interface PlanRow {
  readonly workspace_id: string;
  readonly shape: string;
  readonly statement_id: string;
  readonly advisory_id: string;
  readonly advisory_at: Date | string;
  readonly observed_at: Date | string;
  readonly shape_version: string;
  readonly extract: unknown;
}

/**
 * Either form of a timestamp, as a `Date`.
 *
 * Refuses one it cannot read rather than returning an invalid `Date`, because the ordering these feed is
 * arithmetic on `getTime`: `NaN` compares as neither before nor after, so a single unparseable row would
 * make `newestFirst` return 0 against everything and the trim would drop whichever row the sort happened
 * to leave fourth.
 */
function when(value: Date | string, column: string): Date {
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`plan_extracts.${column} is not a time this store can read: ${String(value)}`);
  }
  return at;
}

export class PostgresPlanExtractStore implements PlanExtractStore {
  readonly durable = true;

  constructor(private readonly db: Sql & { readonly schema: string }) {}

  /**
   * Writes each shape's plans, cutting that shape back to three before moving to the next.
   *
   * Not in a transaction, which is a decision and the opposite of the one `resetting` makes in
   * `retention-store.ts`. That one refuses a handle without a session, because sixteen deletes half done
   * is lost data. Here the worst an interruption leaves is a shape holding a surplus row until the next
   * run, and the trim is idempotent — so requiring a session would mean declining to keep plans at all on
   * a handle that cannot open one, in exchange for a guarantee about an outcome that corrects itself.
   *
   * A shape at a time rather than every insert and then every trim, so that the surplus an interruption
   * can leave is bounded by the shape it stopped inside. Writing all of them first would mean a failure
   * anywhere left *every* shape untrimmed, since the trims had not started — and "until the next run"
   * only holds for the shapes that run again.
   */
  async keep(plans: readonly RetainedPlan[]): Promise<void> {
    for (const group of byShape(plans).values()) {
      for (const plan of group.plans) {
        await this.db.query(
          `insert into ${this.db.schema}.plan_extracts
             (workspace_id, shape, statement_id, advisory_id, advisory_at, observed_at, shape_version, extract)
             values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
             on conflict (workspace_id, shape, statement_id) do update
               set advisory_id = $4, advisory_at = $5, observed_at = $6, shape_version = $7,
                   extract = $8::jsonb`,
          [
            plan.workspaceId,
            plan.shape,
            plan.statementId,
            plan.advisoryId,
            plan.advisoryAt.toISOString(),
            plan.observedAt.toISOString(),
            plan.shapeVersion,
            JSON.stringify(plan.extract),
          ]
        );
      }
      await this.trim(group.key);
    }
  }

  /**
   * Removes the surplus by reading the shape's rows and deleting the ones past the third.
   *
   * A window function would do this in one statement, and the reason it is two is that the surplus is
   * normally a single row — a run adds one execution of a shape and displaces one — so ranking a table to
   * delete a row whose key the previous statement already returned would be the more clever of the two
   * and not the cheaper one. The loop is a loop because that "normally" is not a guarantee: a caller can
   * hand over several executions of one shape, and an interrupted earlier run can leave one behind.
   *
   * Ordered here rather than in the `select`, so the row this drops is the row `forShape` would call
   * fourth. Two orderings over the same rows are two answers wherever they tie, and these tie whenever
   * two executions of a shape share a millisecond.
   */
  private async trim(key: ShapeKey): Promise<void> {
    const { rows } = await this.db.query<Pick<PlanRow, 'statement_id' | 'observed_at'>>(
      `select statement_id, observed_at from ${this.db.schema}.plan_extracts
         where workspace_id = $1 and shape = $2`,
      [key.workspaceId, key.shape]
    );

    const ordered = rows
      .map((row) => ({
        statementId: row.statement_id,
        observedAt: when(row.observed_at, 'observed_at'),
      }))
      .sort(newestFirst);

    for (const row of ordered.slice(RETAINED_EXECUTIONS)) {
      await this.db.query(
        `delete from ${this.db.schema}.plan_extracts
           where workspace_id = $1 and shape = $2 and statement_id = $3`,
        [key.workspaceId, key.shape, row.statementId]
      );
    }
  }

  async forShape(key: ShapeKey): Promise<readonly RetainedPlan[]> {
    const { rows } = await this.db.query<PlanRow>(
      `select workspace_id, shape, statement_id, advisory_id, advisory_at, observed_at, shape_version,
              extract
         from ${this.db.schema}.plan_extracts
         where workspace_id = $1 and shape = $2`,
      [key.workspaceId, key.shape]
    );
    // Ordered here and not in the statement, for the reason `trim` is: one comparator, so the row a trim
    // drops and the row a read calls fourth are the same row. Cut to the same count for the same reason.
    return rows.map(revive).sort(newestFirst).slice(0, RETAINED_EXECUTIONS);
  }
}

function revive(row: PlanRow): RetainedPlan {
  return {
    workspaceId: row.workspace_id,
    shape: row.shape,
    statementId: row.statement_id,
    advisoryId: row.advisory_id,
    advisoryAt: when(row.advisory_at, 'advisory_at'),
    observedAt: when(row.observed_at, 'observed_at'),
    shapeVersion: row.shape_version,
    extract: row.extract as PlanExtract,
  };
}
