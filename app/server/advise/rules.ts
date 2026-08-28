// What is wrong with a query shape, and how confident the advisor is that it knows.
//
// The conditions over the rows `workload_query_shapes.sql` returns, one per id in `WORKLOAD_RULE_IDS` — which
// is where the count lives and is checked. The words, the citations and every threshold are data — see
// `workload-rules.ts` — so what is here is only the arithmetic, and the arithmetic is the part that has to be
// typed against what the platform actually records.
//
// # Every finding carries numeric evidence
//
// Line 912 of the advisor document: *"every finding must contain numeric evidence or an explicit statement
// that evidence was unavailable"*. That is enforced by shape rather than by convention — a `Finding` has
// no valid form without `evidence`, so a rule cannot fire a bare sentence. The reason it matters is what
// a reader does with a finding: "this query spills" is an assertion they have to take on trust, and "this
// query spilled 1.2 TB across 297 runs, 18% of what it read" is one they can check, argue with, and
// measure again after changing something.
//
// # And a confidence, which is not decoration
//
// Two of these rules read one number and mean one thing; others infer a cause from a symptom that has
// several. `CAPACITY_WAIT` at a queue-to-execution ratio of 3 is not a judgement call. A `SMALL_FILES`
// finding is: the mean file size is a fact, and "therefore compact the table" is an inference that a
// deliberately fine partitioning would make wrong. Reporting both at the same confidence would teach a
// reader to discount the first, which is the one they should act on.
//
// # One of them reads a plan, and it is a sample of one
//
// `UDF_OR_PYTHON_BOUNDARY` reads the operator graph of the one execution `workload_query_shapes.sql`
// nominated as the shape's representative, which `plan-index.ts` joins onto the row. Every other rule here
// reads sums over the window. So this one's words are narrower on purpose: what it may say is what that
// execution's plan showed, and its ruleset entry says so to the reader in those terms.
//
// Which execution it was does not reach the reader, and that is a gap rather than a decision. `Evidence` is a
// number and a unit, so a date has no channel here; a finding that says "one recorded run" cannot say which
// run. The phase file records it, because the sentence is honest as it stands and the fix is a surface change.
//
// # One of them reads a table rather than a query
//
// `MISSING_OR_STALE_STATS` is the only rule here whose input is not `system.query.history`. It reads the tables
// a plan says it scanned against `sql:workload.table_statistics`, which is a maintenance history rather than a
// workload one — so a second index is handed to the conditions beside the plan. `33iga` measured why it cannot
// be a plan reading: there is no stat-freshness label anywhere in the metric vocabulary, and the one command
// the design document suggests reports a `Statistics` row on tables nothing has ever analysed.

import type { QueryShapeRow } from '../collect/sql/shapes.js';
import { exchangeBoundaries, joinsIn, operatorsMatching, scansIn, skewIn, sortsIn, widest } from './plan-metrics.js';
import { noPlans, readingFor, type PlanIndex, type PlanReading } from './plan-index.js';
import { noStats, type StatsIndex } from './stats-index.js';
import { failureRate } from './ranking.js';
import { workloadRules, type Severity, type WorkloadRule, type WorkloadRuleId, type WorkloadRuleset } from './workload-rules.js';

/**
 * One measured number behind a finding.
 *
 * `unit` is what it is, not how to print it — the surface decides whether 524288000 bytes reads as
 * "500 MB". Keeping the raw value means a reader can compare two findings the app rendered at different
 * scales, and means a threshold change does not have to reformat anything.
 */
export interface Evidence {
  readonly label: string;
  readonly value: number;
  /** `ratio` is a share and renders as a percentage; `multiple` is a factor. See the contract's own note. */
  readonly unit: 'bytes' | 'ms' | 'percent' | 'ratio' | 'multiple' | 'count';
}

/**
 * How much the advisor is claiming.
 *
 * `high` — the measurement and the cause are the same thing. A queue is a queue.
 * `moderate` — the measurement is certain and the cause is inferred from it.
 * `low` — the signal is real but thin, usually because the sample is small.
 */
export type Confidence = 'high' | 'moderate' | 'low';

export interface Finding {
  readonly rule: WorkloadRuleId;
  readonly shape: string;
  readonly severity: Severity;
  readonly confidence: Confidence;
  /** Never empty: see the note above. */
  readonly evidence: readonly Evidence[];
}

/**
 * Every finding for one shape, in the order a reader should read them.
 *
 * Ordered by severity and then by the rule list's own order, which puts failure and the planner ahead of
 * the volume rules. That is calibration's ordering rather than either document's: with `REFRESH`
 * excluded there is no spill in the entire measured top twelve, and the findings that are actually
 * there are failures, compilation share and serial execution.
 */
export function findingsFor(
  row: QueryShapeRow,
  ruleset: WorkloadRuleset = workloadRules(),
  plan?: PlanReading,
  // The estate's table statistics, not this shape's — the same index for every row, where `plan` is one shape's.
  // A fourth argument rather than a field on `PlanReading`, because a maintenance history is not something read
  // off a plan and putting it there would make `plan == null` mean two things.
  stats: StatsIndex = noStats()
): readonly Finding[] {
  const found = CONDITIONS.flatMap((condition) => {
    const rule = ruleset.rules.get(condition.id);
    if (rule == null) return [];
    const hit = condition.test(row, rule, plan, stats);
    return hit == null ? [] : [{ rule: condition.id, shape: row.shape, ...hit }];
  });

  return [...found].sort((a, b) => RANK[a.severity] - RANK[b.severity] || order(a.rule) - order(b.rule));
}

/** Findings across every shape, flattened. */
export function findings(
  rows: readonly QueryShapeRow[],
  ruleset: WorkloadRuleset = workloadRules(),
  plans: PlanIndex = noPlans(),
  stats: StatsIndex = noStats()
): readonly Finding[] {
  return rows.flatMap((row) => findingsFor(row, ruleset, readingFor(plans, row), stats));
}

const RANK: Readonly<Record<Severity, number>> = { critical: 0, high: 1, medium: 2, info: 3 };

function order(id: WorkloadRuleId): number {
  return CONDITIONS.findIndex((condition) => condition.id === id);
}

/** What a condition returns when it fires: everything about the finding except which shape it is on. */
type Hit = Pick<Finding, 'severity' | 'confidence' | 'evidence'>;

interface Condition {
  readonly id: WorkloadRuleId;
  /**
   * `plan` is this run's plan for this shape, absent for almost every row.
   *
   * A third argument on every condition rather than a second list of plan conditions, which is the shape
   * `sizing.ts` already uses for its warehouse definition. A separate list would double the ordering,
   * the severity sort and the ruleset lookup to serve one rule, and there is no version of the page where
   * a plan finding and a shape finding are read in different places.
   *
   * Absent means this run has no plan for the shape, which is the common case and not a fact about the
   * estate: `33k` measured that a statement whose warehouse lives in another workspace cannot be fetched
   * at all. A condition that reads it says nothing when it is absent, rather than saying the plan showed
   * nothing.
   *
   * `stats` is the estate's table statistics and is the same index for every row, where `plan` is one shape's.
   * Always present and empty where the statement was unreadable, because a miss in it already means unknown —
   * see `stats-index.ts` — so a second spelling of absence would be a distinction with nothing behind it.
   */
  readonly test: (
    row: QueryShapeRow,
    rule: WorkloadRule,
    plan: PlanReading | undefined,
    stats: StatsIndex
  ) => Hit | undefined;
}

/**
 * The conditions, in reading order.
 *
 * Deliberately not the order either design document lists them in. Both lead with the five volume rules,
 * and calibration measured those firing on almost nothing once `REFRESH` is excluded — so leading with
 * them here would put the rules that rarely fire above the ones that decide what the page looks like.
 */
const CONDITIONS: readonly Condition[] = [
  {
    // Its own ordering exists in `ranking.ts` too, because a shape that only ever fails has no measured
    // time and would rank last. Here it is simply first among the findings on whatever row it is on.
    id: 'FAILURE_RATE',
    test: (row, rule) => {
      const rate = failureRate(row);
      if (row.runsNow < rule.thresholds['min_runs'] || rate < rule.thresholds['failure_rate']) return undefined;
      return {
        severity: rate >= rule.thresholds['critical_failure_rate'] ? 'critical' : rule.severity,
        // A count of terminal statuses is not an inference. The one thing it cannot say is *why*, which is
        // why the rule's own words send the reader to the error rather than offering a cause.
        confidence: 'high',
        evidence: [
          { label: 'Runs that failed or were cancelled', value: row.failures, unit: 'count' },
          { label: 'Runs in the window', value: row.runsNow, unit: 'count' },
          { label: 'Failure rate', value: round(rate * 100, 1), unit: 'percent' },
        ],
      };
    },
  },
  {
    id: 'COMPILATION_DOMINATED',
    test: (row, rule) => {
      const share = row.compilationPercent;
      if (share == null || row.measuredNow < rule.thresholds['min_runs']) return undefined;
      if (share < rule.thresholds['compilation_percent']) return undefined;
      return {
        severity: share >= rule.thresholds['critical_compilation_percent'] ? 'critical' : rule.severity,
        // Two measured durations from the same table, and the cause follows from their ratio rather than
        // being inferred beside it: time in the planner is time in the planner.
        confidence: 'high',
        evidence: [
          { label: 'Time spent compiling', value: share, unit: 'percent' },
          { label: 'Runs in the window', value: row.measuredNow, unit: 'count' },
          { label: 'Total time', value: row.msNow, unit: 'ms' },
        ],
      };
    },
  },
  {
    id: 'SERIAL_EXECUTION',
    test: (row, rule) => {
      const parallelism = row.parallelism;
      if (parallelism == null || row.msNow < rule.thresholds['min_ms']) return undefined;
      if (row.measuredNow < rule.thresholds['min_runs']) return undefined;
      // The per-run gate, and the reason it exists is in the ruleset beside `mean_ms`. A shape is only a
      // serial-execution problem if a single run is long enough that somebody would consider throwing
      // compute at it; `min_ms` above is aggregate and any shape run often enough clears it.
      const mean = row.msNow / row.measuredNow;
      if (mean < rule.thresholds['mean_ms']) return undefined;
      if (parallelism >= rule.thresholds['parallelism']) return undefined;
      return {
        severity: rule.severity,
        // Moderate, and this is the honest tier rather than a hedge. Task time over execution time is a
        // ratio of two recorded sums, so the *measurement* is certain — but the cause it points at, a
        // single-partition step, is one of several things that produce it, and the table cannot say which.
        confidence: 'moderate',
        evidence: [
          { label: 'Cores busy on average', value: parallelism, unit: 'ratio' },
          { label: 'Mean time per run', value: Math.round(mean), unit: 'ms' },
          { label: 'Total time', value: row.msNow, unit: 'ms' },
        ],
      };
    },
  },
  {
    id: 'CAPACITY_WAIT',
    test: (row, rule) => {
      // Against total time rather than execution time, because that is the elapsed time a reader waited
      // and the only figure available per shape here. Named as such in the evidence so nobody reads it as
      // the document's execution-time ratio.
      if (row.msNow <= 0 || row.queueMs < rule.thresholds['queue_ms']) return undefined;
      const ratio = row.queueMs / row.msNow;
      if (ratio < rule.thresholds['queue_to_execution']) return undefined;
      return {
        severity: ratio >= rule.thresholds['critical_queue_to_execution'] ? 'high' : rule.severity,
        // The platform records the wait itself. There is no inference between "waited for capacity" and
        // "was waiting for capacity".
        confidence: 'high',
        evidence: [
          { label: 'Time queued', value: row.queueMs, unit: 'ms' },
          { label: 'Share of elapsed time queued', value: round(ratio * 100, 1), unit: 'percent' },
        ],
      };
    },
  },
  {
    id: 'DATA_SPILL',
    test: (row, rule) => {
      if (row.spilledBytes < rule.thresholds['spill_bytes']) return undefined;
      // Where nothing was read, the ratio is not available and the absolute volume stands on its own —
      // a shape that spilled half a terabyte having read nothing from storage is still spilling.
      const ratio = row.readBytes > 0 ? row.spilledBytes / row.readBytes : undefined;
      if (ratio != null && ratio < rule.thresholds['spill_ratio']) return undefined;
      return {
        severity: row.spilledBytes >= rule.thresholds['critical_spill_bytes'] ? 'critical' : rule.severity,
        confidence: 'high',
        evidence: [
          { label: 'Spilled to disk', value: row.spilledBytes, unit: 'bytes' },
          { label: 'Read from storage', value: row.readBytes, unit: 'bytes' },
          // The document's confidence for this rule is 0.8, and the missing fifth is exactly this: which
          // operator spilled, and therefore what to change, is not in the system table. Absent evidence
          // is stated rather than left out, per line 912.
          ...(ratio == null
            ? []
            : [{ label: 'Spilled per byte read', value: round(ratio, 2), unit: 'ratio' as const }]),
        ],
      };
    },
  },
  {
    id: 'HIGH_SHUFFLE',
    test: (row, rule) => {
      if (row.readBytes <= 0 || row.shuffleBytes < rule.thresholds['shuffle_bytes']) return undefined;
      const ratio = row.shuffleBytes / row.readBytes;
      if (ratio < rule.thresholds['shuffle_ratio']) return undefined;
      return {
        severity: rule.severity,
        // The bytes are measured; that they indicate a fixable join or an unnecessary repartition is
        // inference, and which of those it is needs the plan (row 33b).
        confidence: 'moderate',
        evidence: [
          { label: 'Shuffled between workers', value: row.shuffleBytes, unit: 'bytes' },
          { label: 'Read from storage', value: row.readBytes, unit: 'bytes' },
          { label: 'Shuffled per byte read', value: round(ratio, 2), unit: 'ratio' },
        ],
      };
    },
  },
  {
    id: 'LOW_FILE_PRUNING',
    test: (row, rule) => {
      const pruned = row.prunedPercent;
      // Absent, not zero. A statement served from metadata or memory pruned nothing because it read
      // nothing, and 3,621 of one measured workspace's 5,885 statements are in that state — firing here
      // would report perfect certainty about a table the query never opened.
      if (pruned == null || row.readFiles < rule.thresholds['min_read_files']) return undefined;
      // And enough data read to be worth relaying out a table for. A file count on its own cannot tell a
      // wide scan of a large table from a wide scan of a small one, and on the first real workspace the
      // difference was every finding this rule made: eighteen thousand files of `system.*` at 0% pruning,
      // where the layout is not the reader's to change. See `min_read_bytes` in the ruleset.
      if (row.readBytes < rule.thresholds['min_read_bytes']) return undefined;
      if (pruned >= rule.thresholds['pruned_percent']) return undefined;
      return {
        severity: pruned <= rule.thresholds['critical_pruned_percent'] ? 'high' : rule.severity,
        // The ratio is measured. The recommendation — cluster on the filtered column — needs to know
        // which table and which column, and `system.query.history` carries no table attribution for a
        // statement at all. That gap is row 33b's entire reason for existing.
        confidence: 'moderate',
        evidence: [
          { label: 'Files skipped', value: pruned, unit: 'percent' },
          { label: 'Files read', value: row.readFiles, unit: 'count' },
          { label: 'Read from storage', value: row.readBytes, unit: 'bytes' },
        ],
      };
    },
  },
  {
    id: 'SMALL_FILES',
    test: (row, rule) => {
      if (row.readFiles < rule.thresholds['min_read_files'] || row.readBytes <= 0) return undefined;
      const mean = row.readBytes / row.readFiles;
      if (mean >= rule.thresholds['mean_file_bytes']) return undefined;
      return {
        severity: rule.severity,
        // The mean is arithmetic on two recorded numbers. That it means the table wants compacting is the
        // inference, and a deliberately fine partitioning would make it wrong — which is why this is
        // moderate and not high.
        confidence: 'moderate',
        evidence: [
          { label: 'Files read', value: row.readFiles, unit: 'count' },
          { label: 'Mean file size', value: Math.round(mean), unit: 'bytes' },
          { label: 'Read from storage', value: row.readBytes, unit: 'bytes' },
        ],
      };
    },
  },
  {
    /**
     * The one rule that reads the plan, and the only one whose input is a single execution.
     *
     * The tell is a tag, measured: `33ia` ran a Python UDF on labs and the plan carried
     * `UNKNOWN.PhotonScalarUDF`, the only one of the 26 distinct tags across five probes that matches
     * `UDF_TAG`. So on the plans measured this cannot fire on a projection, which was the risk — the design
     * document's phrasing is "a row-wise boundary where native SQL functions may exist", and a tell wide
     * enough to catch every row-wise boundary catches `PHOTON_PROJECT_EXEC` and fires on every query in the
     * estate.
     *
     * The `python` alternative in the pattern is an **assumption**, and the only one here: those five probes
     * ran on a Photon warehouse, so a non-Photon plan's spelling of the same operator is not measured.
     * `BatchEvalPython` and `ArrowEvalPython` are what Spark's own plans are expected to use. It cannot
     * false-positive on anything measured, and if the assumption is simply wrong the rule stays quiet on
     * classic compute rather than firing wrongly.
     */
    id: 'UDF_OR_PYTHON_BOUNDARY',
    test: (row, rule, plan) => {
      // Nothing at all when there is no plan. Absence here is about reach, not about the query: `33k`
      // measured that a shape whose warehouse is in a sibling workspace can never be fetched, and most
      // shapes in a run have no plan for that reason alone.
      if (plan == null) return undefined;
      const udfs = operatorsMatching(plan.extract, UDF_TAG);
      if (udfs.length === 0) return undefined;
      // A floor on what the shape cost over the window's measured runs, so a UDF in a shape costing a second a
      // week is not a finding somebody has to triage. Aggregate only, and no per-run floor: the ruleset says
      // why, and it is the one place this rule's thresholds differ from `SERIAL_EXECUTION`'s.
      if (row.msNow < rule.thresholds['min_ms'] || row.measuredNow < rule.thresholds['min_runs']) return undefined;

      // Absent, not zero. 17 of 123 operators on the statement `33b` measured carry no `key_metrics` at all,
      // so a figure is reported when it was recorded and left out when it was not, rather than rendered as a
      // UDF that took no time. The count is always evidence, which is what keeps the finding numeric.
      const duration = widest(udfs, 'duration_ms');
      const rows = widest(udfs, 'rows_num');
      return {
        severity: rule.severity,
        // Moderate, and the missing part is not the operator — that is read off the plan. It is the step from
        // "this shape crosses a UDF boundary" to "that is what it should stop doing": a UDF may be doing
        // something SQL cannot express, and the plan cannot say which. The sample of one is the other half.
        confidence: 'moderate',
        evidence: [
          { label: 'UDF steps in the plan', value: udfs.length, unit: 'count' },
          // Two maxima over the set, each labelled as one, and deliberately not attributed to a single step.
          // They are separate `widest` calls, so on a plan with several UDF operators they can come off
          // different ones — "the slowest step, and the rows through it" would be a join no field makes. Nor
          // is either a superlative over the UDF steps as such: 17 of 123 operators carried no `key_metrics`,
          // so the longest *recorded* time is all that was read and an untimed step may have been slower.
          //
          // The time is the operator's own figure and not the shape's or the execution's elapsed — what the
          // response records against an operator, and whether that is summed across its tasks is not something
          // this app has measured. A label saying "of its runtime" would be inventing the base.
          ...(duration == null ? [] : [{ label: 'Longest time recorded on a UDF step', value: duration, unit: 'ms' as const }]),
          ...(rows == null ? [] : [{ label: 'Most rows recorded through a UDF step', value: rows, unit: 'count' as const }]),
          { label: 'Total time', value: row.msNow, unit: 'ms' },
        ],
      };
    },
  },
  {
    /**
     * Many shuffle boundaries in a shape that costs real time.
     *
     * The count is `33id`'s measured reading rather than a count of exchange-named tags, and that difference
     * decides whether the design document's eight is the right number: Photon renders one boundary as two
     * operators, so tags double every plan and a threshold of eight fires on a plan with five boundaries.
     * `exchangeBoundaries` folds the pair and records why.
     *
     * The duration half is restated rather than ported, and this is the one judgement in the row.
     * Line 978's condition is one execution over a minute; the plan here *is* one execution, but every other
     * number on the row is the window's, and `33id` measured that on labs the shape whose representative ran
     * for 74 seconds has two boundaries while the three plans with eight or more have their longest run at 6,
     * 12 and 36 seconds. So a per-execution minute would report nothing and say nothing about whether the rule
     * works. The floor is the window total instead — the same one `UDF_OR_PYTHON_BOUNDARY` uses, for the same
     * reason, which the ruleset states: a rewrite pays back per run, so a 6-second shape run 51 times is
     * exactly the case where removing a repartition is worth the work.
     */
    id: 'EXCESSIVE_EXCHANGES',
    test: (row, rule, plan) => {
      if (plan == null) return undefined;
      const { boundaries, unrecognisedExchanges } = exchangeBoundaries(plan.extract);
      if (boundaries < rule.thresholds['exchanges']) return undefined;
      if (row.msNow < rule.thresholds['min_ms'] || row.measuredNow < rule.thresholds['min_runs']) return undefined;
      return {
        severity: rule.severity,
        // Moderate. The boundary count is read off the plan and the pairing behind it is measured over a
        // corpus, so the number is not in doubt. What is inferred is that some of the repartitioning is
        // avoidable — the design document's own words are that repeated repartitioning *can* add overhead —
        // and a plan cannot say which boundary the query needed.
        confidence: 'moderate',
        evidence: [
          { label: 'Shuffle boundaries in the plan', value: boundaries, unit: 'count' },
          // Beside the boundary count because the design document's rule is "many exchange boundaries relative
          // to operator count or query duration" (line 902), and eight boundaries in a 124-operator plan is a
          // different thing from eight in a plan of twenty.
          { label: 'Steps in the plan', value: plan.extract.operatorCount, unit: 'count' },
          // Only when there were any, and never folded into the count above. An exchange operator this app
          // does not recognise might be a broadcast, which is what a `BROADCAST_CANDIDATE` finding asks for.
          ...(unrecognisedExchanges === 0
            ? []
            : [{ label: 'Exchange steps not counted as boundaries', value: unrecognisedExchanges, unit: 'count' as const }]),
          { label: 'Total time', value: row.msNow, unit: 'ms' },
          { label: 'Runs in the window', value: row.measuredNow, unit: 'count' },
        ],
      };
    },
  },
  {
    /**
     * A sort of many rows with nothing after it that reduces them.
     *
     * The graph half is the whole of what the design document asks for — "expensive sort with no obvious
     * limiting/filtering reduction" — and `33id` measured that on its own it is a census rather than a
     * finding: 14 of 36 plans contain a sort, and not one of the 14 has a limiting operator after it. Part of
     * that is Photon's planning rather than the estate's queries, because an `ORDER BY … LIMIT` becomes a
     * top-k carrying no sort operator at all, so the sorts that remain are the ones the planner could not
     * reduce. Either way the graph condition alone selects every sort there is.
     *
     * So the size decides, and `rows_num` is the only size the response carries here. `33id` measured
     * `peak_memory_bytes` taking exactly two values across all 14 sorts — 28 MiB on twelve, 26 MiB on two —
     * while their rows ran from 2 to 17,010, and the widest sort read the *smaller* of the two values. No byte
     * threshold separates them. Spill was zero on all 14, so that cannot narrow them either.
     */
    id: 'LARGE_SORT',
    test: (row, rule, plan) => {
      if (plan == null) return undefined;
      // Nothing where the walk cannot be trusted: an extract with no edges, or one with an edge leading to an
      // operator it does not have. `sortsIn` says why, and the cost of the guard is silence rather than a
      // finding that says "nothing reduces this sort" because the walk stopped early.
      const sorts = sortsIn(plan.extract);
      if (sorts == null) return undefined;
      const unreduced = sorts.filter(
        // A sort with nothing downstream at all is a sort this walk could not judge rather than one nothing
        // follows: every sort in `33id`'s corpus had at least four operators after it, and a zero here means
        // the edges did not reach the root.
        (sort) => sort.downstream > 0 && !sort.limitedDownstream
      );
      const rows = widest(
        unreduced.map((sort) => sort.operator),
        'rows_num'
      );
      if (rows == null || rows < rule.thresholds['sort_rows']) return undefined;
      if (row.msNow < rule.thresholds['min_ms'] || row.measuredNow < rule.thresholds['min_runs']) return undefined;
      return {
        severity: rule.severity,
        // Low, and the sample is only half of why. The rows are measured and the walk is measured, but "no
        // limiting operator downstream" is a statement about the tags this app recognises as limiting, and the
        // step from there to "this sort is avoidable" is one an ordered result set the reader wanted would
        // make wrong. The other rules at this tier are thin for want of runs; this one is thin for want of
        // knowing what the query is for.
        confidence: 'low',
        evidence: [
          { label: 'Most rows recorded through an unreduced sort', value: rows, unit: 'count' },
          { label: 'Sorts with nothing reducing them', value: unreduced.length, unit: 'count' },
          { label: 'Sorts in the plan', value: sorts.length, unit: 'count' },
          { label: 'Total time', value: row.msNow, unit: 'ms' },
        ],
      };
    },
  },
  {
    /**
     * Adaptive execution reporting that it found skewed partitions.
     *
     * The trigger is a counter rather than a ratio, and `33id` measured why that is the whole of this rule's
     * design. Of the nine skew-named metrics in the vocabulary, `MapStage - Skew num skewed partitions` and
     * `MapStage - Skew skewed data size ratio` are carried by the same 27 of 36 plans and read **zero on all 60
     * operators** of them. The max-to-median partition ratio the design document offers as a screening value is
     * non-zero on 23 of those 27 with a p90 of 4, so a rule wired to it above zero reports skew on most of the
     * estate, and one wired to the document's 10 selects a single plan on a corpus whose ordinary reading is 1
     * to 4. Line 1017's instruction — never tell a customer skew exists from a `SortMergeJoin` alone — is about
     * exactly this distance between a signal and a finding.
     *
     * So the counter fires and the ratio is reported. `skewIn` says what "reported" means and what silence
     * means, and the two are not the same: no operator carrying the counter is a plan the platform said nothing
     * about, which on `33id`'s corpus was mostly a plan with nothing to shuffle.
     *
     * No duration floor, and that is a departure from the two rules above it. Theirs exist because their
     * triggers fire on ordinary work and somebody has to triage the result; this trigger read zero on every
     * operator of every plan in the corpus, so a cost floor could only silence a true positive on a cheap
     * shape. The ruleset carries `skewed_partitions` instead, which is the number to tune if that turns out to
     * be wrong on a larger estate.
     */
    id: 'DATA_SKEW',
    test: (row, rule, plan) => {
      if (plan == null) return undefined;
      const skew = skewIn(plan.extract);
      if (skew == null) return undefined;
      if (skew.worstPartitions < rule.thresholds['skewed_partitions']) return undefined;
      return {
        severity: rule.severity,
        // Moderate rather than high, and the design document's own remedy is why: it says to confirm the key
        // distribution before salting or pre-aggregating. What is certain is that adaptive execution counted
        // skewed partitions on this execution. What is inferred is that the query's key distribution is the
        // thing to change, and the plan carries no key distribution to check that against — no field in the
        // extract names the skewed key, which is why neither this evidence nor the ruleset's words name one.
        confidence: 'moderate',
        evidence: [
          // A maximum over the operators that carried the counter, labelled as one. Not "the skewed step":
          // the counter sits on every map stage in the plan and several may report, so a definite article
          // here would claim a uniqueness the field does not carry.
          { label: 'Most skewed partitions reported on any one step', value: skew.worstPartitions, unit: 'count' },
          { label: 'Steps reporting skewed partitions', value: skew.reporting, unit: 'count' },
          { label: 'Steps where the platform reported a skew count', value: skew.carrying, unit: 'count' },
          // Only where the plan carried it, and a separate maximum from the one above — so on a plan with
          // several map stages the two can come off different steps, which is why neither is attributed to
          // one. It is here because it is the figure a reader needs to judge how uneven the partitions were,
          // and it is not part of the condition, for the reason in the comment above.
          //
          // A `multiple` and not a `ratio`: the widest reading in the measured corpus is 19, the design
          // document writes the condition as `max/median >= 10`, and as a share the surface renders the same
          // number "1,900%".
          ...(skew.worstMaxToMedian == null
            ? []
            : [
                {
                  label: 'Widest ratio of largest partition to median, on any one step',
                  value: round(skew.worstMaxToMedian, 2),
                  unit: 'multiple' as const,
                },
              ]),
          { label: 'Total time', value: row.msNow, unit: 'ms' },
        ],
      };
    },
  },
  {
    /**
     * A join that does not broadcast, one of whose sides is narrow.
     *
     * `33ifb` measured this rule's premise and every part of it came back short, so what is here is narrower
     * than the design document's line and says so in three places.
     *
     * **It reads rows, not bytes.** The condition as specified is a side "small enough to broadcast", which is a
     * byte size. Of the three metrics a plan carries that name a size, `33ifb` measured `Aggressive BHJ
     * Extrapolated Size` and `Aggressive BHJ Decision` as zero on all eleven joins that carried them, and
     * `Hashed relation size` as an *allocation* rather than a size: four distinct values over eleven joins,
     * moving the wrong way against the rows, so a 3,003-row join reports 4,325,376 and a 9-row join reports
     * 8,519,680. No byte threshold separates them. The one size that exists anywhere near a join is the row
     * count on its inputs, present on 26 of 26 of them.
     *
     * **Its threshold is an assumption.** All 13 joins in that corpus already broadcast, so the population this
     * rule is about is empty there: nothing to calibrate against and no false positive to observe. The ruleset
     * states the arithmetic behind the number and marks it.
     *
     * **It declines on a join that already broadcasts.** `EXCESSIVE_EXCHANGES` leaves a broadcast exchange out
     * of its boundary count on the reasoning that a broadcast is what this rule recommends, and a finding here
     * on a join that took the advice would be the same defect from the other end. `joinsIn` reads the tell from
     * the algorithm and from the tag, so an extract whose meta is unreadable is refused rather than read as
     * naming no algorithm.
     */
    id: 'BROADCAST_CANDIDATE',
    test: (row, rule, plan) => {
      if (plan == null) return undefined;
      const joins = joinsIn(plan.extract);
      if (joins == null) return undefined;
      const candidates = joins.filter(
        (join) =>
          !join.broadcast &&
          // Both sides, and both sized. A join with one input is a join whose other side the walk did not
          // reach, and "the narrower side" of one known side and one unknown is not the known one.
          join.inputs.length >= 2 &&
          join.narrowestInputRows != null &&
          join.narrowestInputRows <= rule.thresholds['build_side_rows']
      );
      // The narrowest side of any candidate, which is the side a reader would broadcast first.
      const narrowest = candidates.reduce<number | undefined>(
        (least, join) => (least == null || (join.narrowestInputRows ?? 0) < least ? join.narrowestInputRows : least),
        undefined
      );
      if (narrowest == null) return undefined;
      if (row.msNow < rule.thresholds['min_ms'] || row.measuredNow < rule.thresholds['min_runs']) return undefined;
      return {
        severity: rule.severity,
        // Low, and the threshold is why rather than the sample. The row counts are read off the plan and the
        // join's algorithm is the platform's own word for itself, so the measurement is not in doubt. What is
        // assumed is that a side of this many rows is small enough to broadcast, which is a byte question no
        // field here answers — and the remedy, unlike every other rule's, changes how the engine executes
        // rather than what the query asks for.
        confidence: 'low',
        evidence: [
          // A minimum over the candidate joins, labelled as one. Not "the smaller side": several joins in a
          // plan may qualify and the count says how many, so a definite article would claim a uniqueness no
          // field carries.
          { label: 'Fewest rows on a side of a join that does not broadcast', value: narrowest, unit: 'count' },
          { label: 'Joins that do not broadcast and have a narrow side', value: candidates.length, unit: 'count' },
          { label: 'Joins in the plan', value: joins.length, unit: 'count' },
          { label: 'Total time', value: row.msNow, unit: 'ms' },
        ],
      };
    },
  },
  {
    /**
     * A table this shape scans that was written after its statistics were last computed.
     *
     * The design document's rule is `MISSING_OR_STALE_STATS` and this answers the second half of its own name.
     * `33iga` measured why, and the reason is not a shortcut:
     *
     * **Missing is not observable.** A table with no ANALYZE record is indistinguishable from a table
     * predictive optimization has not reached. `DESCRIBE EXTENDED`, which the design document names, reports a
     * `Statistics` row on tables nothing has ever analysed — 7 of the 11 that carried one in that measurement
     * — because the row is the Delta log's own size estimate rather than a statistics record. So a rule firing
     * on absence would be reporting the collector's blind spot as the estate's problem, and a *miss* in the
     * index is read as unknown here rather than as a finding.
     *
     * **Its silence therefore has two meanings**, which is unusual among these rules and is why the ruleset's
     * words say so: either nothing this shape scans is stale, or nothing analysed it and there was nothing to
     * compare. The evidence carries both counts so the reader can tell which.
     *
     * **The gap is signed and only a positive one is a finding.** 33 of the 34 analysed tables on labs were
     * last written *before* their statistics were computed, which is predictive optimization working. A rule
     * on the absolute gap would fire on all of them.
     */
    id: 'MISSING_OR_STALE_STATS',
    test: (row, rule, plan, stats) => {
      if (plan == null) return undefined;
      // The tables this shape's plan says it scanned. `undefined` where the key is unreadable, which is an
      // extract from `plan-parser-1`: `33ih` stored `[]` for it on every plan, and reading that as "this query
      // scans nothing" would report a fixed bug as a query with no tables.
      const scanned = scansIn(plan.extract);
      if (scanned == null) return undefined;
      const known = [...new Set(scanned.map((table) => table.toLowerCase()))].flatMap((table) => {
        const reading = stats.for(table);
        return reading == null ? [] : [reading];
      });
      const stale = known.filter(
        (reading) =>
          reading.hoursWrittenAfterAnalyse != null &&
          reading.hoursWrittenAfterAnalyse >= rule.thresholds['stale_hours']
      );
      const worstHours = stale.reduce<number | undefined>(
        (most, reading) =>
          most == null || (reading.hoursWrittenAfterAnalyse ?? 0) > most ? reading.hoursWrittenAfterAnalyse : most,
        undefined
      );
      if (worstHours == null) return undefined;
      if (row.msNow < rule.thresholds['min_ms'] || row.measuredNow < rule.thresholds['min_runs']) return undefined;
      return {
        severity: rule.severity,
        // Low, and the sample is not why. Both timestamps are the platform's own records, so neither is in
        // doubt. What is thin is the step from "written since analysed" to "the planner chose badly": a write
        // of one row into a billion-row table moves this number and changes no plan, and nothing here can see
        // how much was written relative to what was there. The write count is in the evidence for that reason.
        confidence: 'low',
        evidence: [
          // "A table", not "the table": several of a shape's tables may be stale and the count below says how
          // many, so a definite article would claim a uniqueness no field carries. The gap is collected in
          // hours and rendered in milliseconds because that is the unit the evidence formatter has for a
          // duration; the number is the same span either way.
          {
            label: 'Longest a table went from analysed to written',
            value: Math.round(worstHours * 3_600_000),
            unit: 'ms',
          },
          { label: 'Tables scanned and written since analysed', value: stale.length, unit: 'count' },
          // The denominator, and it is the honest one: tables this shape scans that anything analysed, not
          // tables it scans. A shape scanning ten tables of which one was analysed reports 1 here, and that is
          // what the reader needs to know before reading the count above as a share of anything.
          { label: 'Tables scanned that anything analysed', value: known.length, unit: 'count' },
          { label: 'Writes recorded since', value: stale.reduce((total, reading) => total + (reading.writeEvents ?? 0), 0), unit: 'count' },
          { label: 'Total time', value: row.msNow, unit: 'ms' },
        ],
      };
    },
  },
  {
    id: 'CACHE_HIT',
    test: (row, rule) => {
      if (row.runsNow < rule.thresholds['min_runs']) return undefined;
      const rate = row.cacheHits / row.runsNow;
      if (rate < rule.thresholds['cache_rate']) return undefined;
      return {
        severity: rule.severity,
        confidence: 'high',
        evidence: [
          { label: 'Runs served from cache', value: row.cacheHits, unit: 'count' },
          { label: 'Runs in the window', value: row.runsNow, unit: 'count' },
          { label: 'Share served from cache', value: round(rate * 100, 1), unit: 'percent' },
        ],
      };
    },
  },
];

/**
 * What a UDF operator's tag looks like.
 *
 * Deliberately two words rather than a list of exact tags. `UNKNOWN.PhotonScalarUDF` is the measured one, and
 * an exact match on it would miss the vectorised and aggregate spellings of the same boundary — which are an
 * assumption about naming rather than a measurement, since no probe produced one. A pattern over the whole tag
 * would risk a projection.
 *
 * That it does not match a projection is not left to this comment: `rules.test.ts` reads the tag vocabulary out
 * of `33ia`'s committed recording and asserts this pattern matches one of the 26, which fails the day somebody
 * widens it. Exported for that test and for nothing else.
 *
 * It matches more kinds of operator than one sentence can describe, and that bounds what the ruleset's words
 * may say: a scalar UDF is row-at-a-time and a vectorised one is not, so the detail describes both rather than
 * asserting the first of a tag that may be either.
 */
export const UDF_TAG = /udf|python/i;

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
