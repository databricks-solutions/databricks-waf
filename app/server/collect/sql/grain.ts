// Whether a statement reading a change-log or timeline table ever gets down to the thing it talks about.
//
// These tables do not keep a row per thing. `system.lakeflow.jobs` keeps a row per configuration
// change, `system.lakeflow.job_run_timeline` keeps a row per *period* of a run, and
// `system.storage.table_metrics_history` keeps a row per daily snapshot. So `count(*)` counts versions,
// `avg(duration)` averages periods, and both return a number that is plausible, stable and about
// something nobody asked about.
//
// It is not the same bug as `history.ts`, which is why this is a second file. That one catches a
// lifecycle filter placed inside a window's own query, so the ranking chooses from rows a filter already
// chose. It only fires when there *is* a window. The defect here is that there is no window at all, and
// the two together are what the SCD2 hazard actually needs: pick the latest row, and pick it from
// everything.
//
// Found live on the day this was written, and it found exactly one defect:
// `lakeflow_pipeline_inventory.sql` declared `-- Rows: one per pipeline`, filtered `delete_time IS NULL`,
// and took no latest row. Measured against an internal workspace large enough to separate the two ways
// that fails, it returned 101,207 rows where 8,934 pipelines exist — over-reporting by 11.3x. Only
// 15,307 of those rows were live pipelines counted 1.7 times each; the other 85,900 belonged to
// pipelines that had been deleted, because a deleted object's pre-deletion rows all carry
// `delete_time IS NULL` and so survive the filter. 50,061 of that estate's 58,995 pipelines are deleted,
// which is why the second fault dwarfs the first: the filter did not merely miscount the estate, it
// resurrected it. Every finding about development mode and ETL frameworks was a share over that.
//
// Nine guidance steps failed the first draft of this check and all nine were correct — they used
// `GROUP BY ALL`, or pinned a snapshot date through a subquery, and the check could read neither. They
// are the reason `guarded` accepts a broad list and blanks nested queries before judging, and the reason
// the shapes it must not flag are pinned in the tests below. A check that cries wolf on correct SQL is
// removed by the third person it blocks, and then the real defect ships.
//
// What makes a read safe is one of a short list, deliberately broad: a ranking window partitioned by the
// entity, a `MAX_BY`, a `count(distinct entity)`, a `GROUP BY` naming the entity, or for a snapshot table
// a restriction to the latest snapshot. Broad because this gates a build and a false alarm stops work on
// a statement that is correct — the narrow version of this rule demanded a window and would have failed
// four aggregates that are right. What it cannot do is judge whether the entity named is the entity the
// assertion is about; that is a reviewer's job, and the check's job is that the question was asked at all.

import { byList, lineAt, names, scopeAround, scopes, withoutComments, words } from './scan.js';

/** How a table is grained, which decides what a safe read of it looks like. */
export type Grain = 'change' | 'period' | 'snapshot';

/** A table that keeps more than one row per thing, and the column that identifies the thing. */
export interface Grained {
  readonly grain: Grain;
  /**
   * Columns any one of which, named in a grouping key or a distinct count, gets down to one thing.
   *
   * Several rather than one because a table can be legitimately read at more than one level: a period
   * of a node belongs to an instance and to a cluster, and utilisation averaged per cluster is a fair
   * question while a duration averaged per period is not.
   */
  readonly entity: readonly string[];
}

/**
 * The tables that keep a row per change, per period or per snapshot.
 *
 * Named explicitly rather than matched on `_timeline` or `_history`, because the cost of the two
 * mistakes is not symmetric. A table missing from this list is unchecked, which is where every table
 * started. A table wrongly on it fails a correct statement and the person who hits that learns to
 * distrust the check.
 *
 * Event tables are deliberately absent. `system.billing.usage`, `system.query.history`,
 * `system.access.audit` and `system.access.table_lineage` also keep many rows per thing, and there the
 * many rows *are* the subject: a query over usage records is asking about usage records. Requiring a
 * dedupe on those would invent a failure on around forty statements and steps that are correct.
 */
export const GRAINED: Readonly<Record<string, Grained>> = {
  // Slowly changing dimensions: a row per configuration change, plus a final row carrying delete_time.
  'system.lakeflow.jobs': { grain: 'change', entity: ['job_id'] },
  'system.lakeflow.job_tasks': { grain: 'change', entity: ['task_key', 'job_id'] },
  'system.lakeflow.pipelines': { grain: 'change', entity: ['pipeline_id'] },
  'system.compute.clusters': { grain: 'change', entity: ['cluster_id'] },
  'system.compute.warehouses': { grain: 'change', entity: ['warehouse_id'] },

  // Timelines: a row per period of a run, so a row is not a run and a row's duration is not its duration.
  'system.lakeflow.job_run_timeline': { grain: 'period', entity: ['run_id'] },
  'system.lakeflow.job_task_run_timeline': { grain: 'period', entity: ['run_id', 'task_key'] },
  'system.lakeflow.pipeline_update_timeline': { grain: 'period', entity: ['update_id'] },
  'system.compute.node_timeline': { grain: 'period', entity: ['instance_id', 'cluster_id'] },

  // A row per table per day, so anything not restricted to one snapshot counts history as estate.
  'system.storage.table_metrics_history': { grain: 'snapshot', entity: ['snapshot_date'] },
};

/** Window functions whose result is a position, so one of them plus a partition picks a row. */
const RANKING = new Set(['ROW_NUMBER', 'RANK', 'DENSE_RANK']);

/** Clause keywords that end a `WHERE`, so a predicate is read without the rest of the query. */
const AFTER_WHERE = new Set(['GROUP', 'ORDER', 'HAVING', 'WINDOW', 'QUALIFY', 'LIMIT', 'UNION']);

/** What each grain is called when a message has to explain what a row is. */
const ROW_IS: Readonly<Record<Grain, string>> = {
  change: 'a row per configuration change',
  period: 'a row per period of a run, not per run',
  snapshot: 'a row per snapshot, not per thing',
};

/** One unguarded read, with everything a message needs to point at it. */
export interface GrainFault {
  readonly table: string;
  readonly grain: Grain;
  readonly entity: readonly string[];
  readonly line: number;
}

/**
 * Every read of a change-grained table that never gets down to one thing.
 *
 * Returns the faults rather than prose, because two callers want different sentences out of them: a
 * statement names a file and a guidance step names a control and a pillar.
 */
export function grainFaults(sql: string): readonly GrainFault[] {
  const text = withoutComments(sql);
  const all = scopes(text);
  const faults: GrainFault[] = [];

  for (const [table, grained] of Object.entries(GRAINED)) {
    for (const at of readsOf(text, table)) {
      const scope = scopeAround(text, all, at);
      const region = text.slice(scope.start, scope.end);
      if (guarded(region, grained)) continue;
      faults.push({ table, grain: grained.grain, entity: grained.entity, line: lineAt(text, at) });
    }
  }

  return faults.sort((a, b) => a.line - b.line);
}

/** The same faults as one sentence, or undefined when there are none. */
export function grainProblem(sql: string): string | undefined {
  const faults = grainFaults(sql);
  if (faults.length === 0) return undefined;

  return faults
    .map(
      (fault) =>
        `line ${String(fault.line)} reads ${fault.table}, which keeps ${ROW_IS[fault.grain]}, and the ` +
        `query around it neither takes one row per ${fault.entity[0]} nor aggregates to it. ` +
        `Rank by ${fault.entity[0]} and keep the first row, or count distinct ${fault.entity[0]}, or ` +
        `group by it — otherwise the result counts ${fault.grain === 'change' ? 'versions' : 'rows'} ` +
        'and reads as a count of things.'
    )
    .join(' Also, ');
}

/**
 * Where a table is read, as offsets of its name.
 *
 * The name is matched with a boundary in front so `system.lakeflow.jobs` is not found inside
 * `system.lakeflow.jobs_extra`, and case-insensitively because the tree contains both.
 */
function readsOf(text: string, table: string): readonly number[] {
  const found: number[] = [];
  const pattern = new RegExp(`(?<![\\w.])${table.replace(/\./g, '\\.')}(?![\\w.])`, 'gi');
  for (let hit = pattern.exec(text); hit != null; hit = pattern.exec(text)) found.push(hit.index);
  return found;
}

/**
 * Whether a query gets from many rows per thing down to one, by any of the accepted means.
 *
 * Judged on the query's *own* clauses, with every nested query blanked first — the same correction
 * `history.ts` had to make, and here it was the difference between catching the live defect and missing
 * it. `lakeflow_pipeline_inventory.sql` reads `system.lakeflow.pipelines` at the top level and joins a
 * derived table that groups by `pipeline_id`; counting that nested grouping as this query's guard
 * accepted the statement, which is the one statement in the tree that is actually wrong.
 */
function guarded(region: string, grained: Grained): boolean {
  const own = withoutNested(region);
  const seen = [...words(own)];

  for (let index = 0; index < seen.length; index += 1) {
    const word = seen[index];
    if (word == null) continue;

    // A ranking window partitioned by the entity, which is the documented way to read an SCD2 table.
    // `QUALIFY` on its own counts too: it exists to filter a window's result and a statement using one
    // over a table like this is doing precisely what is being asked for.
    if (word.word === 'QUALIFY') return true;
    if (RANKING.has(word.word) && partitionNames(own, word.at, grained.entity)) return true;

    // `MAX_BY(x, change_time)` is the same idea as a window, written as an aggregate.
    if (word.word === 'MAX_BY') return true;

    // `count(distinct run_id)` counts things rather than rows, whatever the rows are.
    if (word.word === 'COUNT' && distinctNames(own, word.at, grained.entity)) return true;

    // `max(snapshot_date)` reduces the column that carries the repetition to one value, which is how a
    // snapshot table's latest day is found. Restricted to an aggregate over the entity column itself:
    // `max(change_time)` says nothing about how many rows per job survive.
    if ((word.word === 'MAX' || word.word === 'MIN') && callNames(own, word.at, grained.entity)) return true;

    // A grouping key naming the entity collapses its rows, so what is aggregated is one thing's worth.
    if (word.word === 'GROUP' && seen[index + 1]?.word === 'BY') {
      const list = byList(own, (seen[index + 1]?.at ?? word.at) + 'BY'.length);
      if (grained.entity.some((column) => names(list, column))) return true;
      // `GROUP BY ALL` means every non-aggregated column in the select list, so the grouping key is
      // there rather than here. Four correct queries in the tree are written this way and the version
      // of this check that could not read it failed all four.
      if (/^\s*ALL\s*$/i.test(list) && grained.entity.some((column) => names(selectList(own), column))) {
        return true;
      }
    }
  }

  // A snapshot table restricted on its snapshot column is pinned to one day, however the value is
  // arrived at — `= (select max(...))`, `= current_date()`, or a literal. The nested query that finds
  // the maximum has been blanked by now, so the predicate is read for the column it constrains.
  return grained.grain === 'snapshot' && grained.entity.some((column) => names(whereOf(own) ?? '', column));
}

/** The text with every nested query replaced by spaces, so offsets hold and only this query remains. */
function withoutNested(region: string): string {
  const nested = scopes(region);
  const out = [...region];
  for (const scope of nested) {
    for (let at = scope.start; at < scope.end; at += 1) out[at] = ' ';
  }
  return out.join('');
}

/** A query's own select list, between its `SELECT` and the `FROM` that follows it. */
function selectList(region: string): string {
  let from: number | undefined;
  let to: number | undefined;
  for (const word of words(region)) {
    if (word.depth !== 0) continue;
    if (from == null && word.word === 'SELECT') from = word.at + 'SELECT'.length;
    else if (from != null && word.word === 'FROM') {
      to = word.at;
      break;
    }
  }
  return from == null ? '' : region.slice(from, to ?? region.length);
}

/** A query's own `WHERE` predicate, read to whatever clause ends it. */
function whereOf(region: string): string | undefined {
  let from: number | undefined;
  for (const word of words(region)) {
    if (word.depth === 0 && word.word === 'WHERE') {
      from = word.at + 'WHERE'.length;
      break;
    }
  }
  if (from == null) return undefined;

  for (const word of words(region, from)) {
    if (word.depth === 0 && AFTER_WHERE.has(word.word)) return region.slice(from, word.at);
  }
  return region.slice(from);
}

/** Whether the call starting at an offset takes one of the entity columns as an argument. */
function callNames(region: string, from: number, entity: readonly string[]): boolean {
  const open = region.indexOf('(', from);
  if (open === -1 || open > from + 'MAX'.length + 2) return false;
  const close = region.indexOf(')', open);
  if (close === -1) return false;
  const args = region.slice(open + 1, close);
  return entity.some((column) => names(args, column));
}

/** Whether the `PARTITION BY` of the window starting at an offset names one of the entity columns. */
function partitionNames(region: string, from: number, entity: readonly string[]): boolean {
  const over = /\bOVER\s*\(/i.exec(region.slice(from));
  if (over == null) return false;
  const opens = from + over.index + over[0].length;
  const partition = /\bPARTITION\s+BY\b/i.exec(region.slice(opens));
  if (partition == null) return false;
  const list = byList(region, opens + partition.index + partition[0].length);
  return entity.some((column) => names(list, column));
}

/**
 * Whether the `count(` starting at an offset is a `count(distinct <entity>)`.
 *
 * Read from the arguments rather than from the whole query, so a `count(*)` beside an unrelated
 * `distinct` elsewhere does not pass as one.
 */
function distinctNames(region: string, from: number, entity: readonly string[]): boolean {
  const open = region.indexOf('(', from);
  if (open === -1 || open > from + 'COUNT'.length + 2) return false;

  let depth = 0;
  for (let at = open; at < region.length; at += 1) {
    if (region[at] === '(') depth += 1;
    else if (region[at] === ')') {
      depth -= 1;
      if (depth === 0) {
        const args = region.slice(open + 1, at);
        return /\bDISTINCT\b/i.test(args) && entity.some((column) => names(args, column));
      }
    }
  }
  return false;
}
