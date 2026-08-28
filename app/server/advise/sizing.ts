// What is wrong with the size and shape of a warehouse, and how confident the advisor is that it knows.
//
// Five conditions over the rows `workload_warehouse_pressure.sql` returns, joined to the warehouse
// definitions `compute_warehouse_inventory.sql` already reads. The words, the citations and every
// threshold are data — see `sizing-rules.yaml` — so what is here is the arithmetic and the join.
//
// # Why this is not part of rules.ts
//
// The query rules describe a statement and these describe a machine, and the difference decides who acts.
// A `DATA_SPILL` finding on a query shape is for whoever owns that query; the same spill aggregated to a
// warehouse is for whoever owns the warehouse, and they are usually not the same person. Keeping them in
// one module would also mean one rule id space, and `DATA_SPILL` and `WAREHOUSE_SPILL` genuinely are two
// findings from one measurement rather than a duplicate to be deduplicated.
//
// # The assessment's own statements are gone before this module sees a row
//
// Excluded by the statement, in a `WHERE` clause, so every figure the rules read here — utilisation, p95,
// queueing, spill, users — is the estate's own work. Nothing in this module discounts, suppresses or
// apologises for our share, because there is no share to apologise for.
//
// This replaced a gate. The share used to be computed here and a warehouse above the ruleset's
// `self_percent` was reported to the customer as "measuring ourselves" — a row in their list of
// warehouses, in the place advice goes, saying nothing they could act on. The reason for the gate was
// sound and measured (75% of one labs warehouse's query time was this app, which would have advised the
// customer to size for us) and the response was wrong: the fix for a number that is about us is to not
// compute it, rather than to compute it and ask the reader to set it aside.
//
// What survives is `ranAssessment`, and it is a boolean rather than a share. With our statements gone,
// `runs` of zero means two things that want opposite advice — nothing ran on this warehouse, or nothing
// but the assessment did — and telling a customer that the warehouse doing the assessing is unused
// invites them to delete it.
//
// Nothing here corrects a figure for our share of it, including utilisation, whose denominator is uptime
// and therefore cannot be attributed. An assessment is twenty small aggregates a week; where it is
// genuinely a warehouse's workload the answer is to give the app a dedicated 2X-Small rather than to
// discount arithmetic the reader cannot check. See ADR 0070.

import type { WarehousePressureRow, WarehouseRow } from '../collect/sql/shapes.js';
import type { Confidence, Evidence } from './rules.js';
import {
  sizingRules,
  type Severity,
  type SizingRuleId,
  type SizingRuleset,
  type WorkloadRule,
} from './workload-rules.js';

export interface SizingFinding {
  readonly rule: SizingRuleId;
  readonly warehouseId: string;
  readonly severity: Severity;
  readonly confidence: Confidence;
  /** Never empty, for the reason rules.ts gives: a finding a reader cannot check is one they must trust. */
  readonly evidence: readonly Evidence[];
}

/**
 * Why a warehouse reads the way it does, as one of five states rather than as an empty finding list.
 *
 * Four of the five are "no findings" and they are four different sentences. `clean` was asked for work and
 * coped. `unused` was not asked. `assessment-only` was asked for nothing but this assessment, which is a
 * different row from an idle one because acting on it means deleting the warehouse the assessment runs on.
 * And `unmeasured` is the one labs turned up: statements ran and none of them were timed, because they
 * were served from cache, cancelled or failed — so every rule declined for want of a measurement rather
 * than because the warehouse was fine. Reporting that warehouse as having coped was a claim about seven
 * days of evidence that did not exist.
 */
export type WarehouseState = 'advised' | 'clean' | 'unused' | 'assessment-only' | 'unmeasured';

export interface WarehouseSizing {
  readonly workspaceId: string;
  readonly warehouseId: string;
  /** From the inventory. The id itself where no definition could be matched — see `describe`. */
  readonly name: string;
  /** Exact Databricks warehouse page, when the workspace directory could resolve it. */
  readonly link?: string;
  readonly serverless?: boolean;
  readonly size?: string;
  /** The size one step below, where there is one, so a surface can name it rather than imply it. */
  readonly nextSizeDown?: string;
  readonly minClusters?: number;
  readonly maxClusters?: number;
  readonly autoStopMinutes?: number;
  readonly pressure: WarehousePressureRow;
  readonly state: WarehouseState;
  readonly findings: readonly SizingFinding[];
}

export interface SizingAnalysis {
  /** The warehouses the statement returned, busiest first, each with its state and findings. */
  readonly warehouses: readonly WarehouseSizing[];
  readonly findingCount: number;
  /** Warehouses that ran at least one statement in the window. */
  readonly used: number;
  /** Warehouses the window saw at all, which is what the statement's cap applies to. */
  readonly population: number;
  /** Live warehouses the inventory lists, where it was read. The denominator a reader expects. */
  readonly live?: number;
  /**
   * How many of the listed warehouses were found in that inventory.
   *
   * Not the same as `population`, and the difference is what makes "the estate's other warehouses were
   * quiet" arithmetic: the event stream is read across the metastore and the inventory only covers the
   * workspaces this run had reach into, so labs saw five warehouses of which three were in an inventory of
   * twenty-one. Subtracting the population from the live count there would have claimed sixteen quiet
   * warehouses where eighteen were.
   */
  readonly matched: number;
  readonly windowDays: number;
  readonly rulesVersion: number;
}

/**
 * The size ladder, smallest first, as the system table spells it.
 *
 * Here rather than in configuration because it is not a threshold — it is the platform's own vocabulary,
 * and a customer cannot choose a size that is not on it. Two things need it: a headroom finding must not
 * fire on a warehouse already at the smallest size, because there is nothing below it, and a surface
 * saying "the next size down" should be able to name which.
 *
 * Matched on the letters and digits alone, because the same size appears as `2X-Small` in the REST API
 * and `2X_SMALL` in the system table, and a ladder that recognised one form would silently stop working
 * when a reading came from the other.
 */
export const SIZE_LADDER = [
  '2X-Small',
  'X-Small',
  'Small',
  'Medium',
  'Large',
  'X-Large',
  '2X-Large',
  '3X-Large',
  '4X-Large',
] as const;

function ladderIndex(size: string | undefined): number {
  if (size == null) return -1;
  const key = normalise(size);
  return SIZE_LADDER.findIndex((step) => normalise(step) === key);
}

function normalise(size: string): string {
  return size.replace(/[^a-z0-9]/gi, '').toUpperCase();
}

/**
 * The size as the ladder spells it, where the reading is on the ladder.
 *
 * The system table says `X_SMALL` and the ladder says `X-Small`, and the payload carries both: the size
 * comes from the inventory and `nextSizeDown` comes from the ladder. Passing the reading through
 * unchanged produced "the next size down from X_SMALL is 2X-Small" on labs — two spellings of one
 * vocabulary in one sentence, which reads as a bug in the sentence rather than in the table.
 *
 * The reading itself where it is not on the ladder, because an unrecognised size is more likely a size
 * this ladder has not been told about than a mistake, and showing it is how anybody finds out.
 */
function spell(size: string | undefined): string | undefined {
  if (size == null) return undefined;
  const index = ladderIndex(size);
  return index < 0 ? size : SIZE_LADDER[index];
}

/**
 * The analysis, or `undefined` where there is nothing to analyse.
 *
 * The same distinction the workload and serverless analyzers draw, and it matters more here: no rows
 * means the statement could not be read, and an empty analysis would render as an estate whose
 * warehouses are all correctly sized — which is a conclusion, and not one this run reached.
 */
export function analyseSizing(
  pressure: readonly WarehousePressureRow[],
  warehouses: readonly WarehouseRow[],
  lookbackDays: number,
  ruleset: SizingRuleset = sizingRules()
): SizingAnalysis | undefined {
  if (pressure.length === 0) return undefined;

  const definitions = new Map(warehouses.map((row) => [`${row.workspaceId}/${row.warehouseId}`, row] as const));
  const described = pressure.map((row) =>
    describe(row, definitions.get(`${row.workspaceId}/${row.warehouseId}`), ruleset)
  );

  return {
    // Findings first, then by how much work the warehouse did. The statement already ordered by time, so
    // this only lifts the warehouses with something to say above the ones without.
    warehouses: [...described].sort(
      (a, b) => worst(b) - worst(a) || b.pressure.totalMs - a.pressure.totalMs || a.name.localeCompare(b.name)
    ),
    findingCount: described.reduce((total, one) => total + one.findings.length, 0),
    used: described.filter((one) => one.pressure.runs > 0).length,
    population: pressure[0]?.warehousePopulation ?? described.length,
    matched: described.filter((one) => definitions.has(`${one.workspaceId}/${one.warehouseId}`)).length,
    // Absent rather than zero where the inventory was not read: a denominator of nothing would make the
    // surface report that every warehouse in the estate was measured.
    ...(warehouses.length > 0 ? { live: warehouses.length } : {}),
    // Seven, capped the way the statement caps it, so a caller asking for thirty is told what was read.
    windowDays: Math.min(lookbackDays, 7),
    rulesVersion: ruleset.version,
  };
}

/** The severity of a warehouse's worst finding, as a sort key. Zero where it has none. */
function worst(one: WarehouseSizing): number {
  return one.findings.reduce((high, finding) => Math.max(high, 4 - RANK[finding.severity]), 0);
}

const RANK: Readonly<Record<Severity, number>> = { critical: 0, high: 1, medium: 2, info: 3 };

function describe(
  row: WarehousePressureRow,
  definition: WarehouseRow | undefined,
  ruleset: SizingRuleset
): WarehouseSizing {
  const index = ladderIndex(definition?.size);
  const findings = row.runs === 0 || row.measured === 0 ? [] : findingsFor(row, definition, ruleset);

  return {
    workspaceId: row.workspaceId,
    warehouseId: row.warehouseId,
    // The id rather than a placeholder, and this is a real case rather than a defensive one: a warehouse
    // deleted after it ran leaves its statements in the history and no live definition to name it. An
    // unnamed row a reader cannot look up is worse than a row identified by the only thing that is left.
    name: definition?.name ?? row.warehouseId,
    ...(definition != null && { serverless: definition.serverless }),
    ...(spell(definition?.size) != null && { size: spell(definition?.size) }),
    ...(index > 0 && { nextSizeDown: SIZE_LADDER[index - 1] }),
    ...(definition?.minClusters != null && { minClusters: definition.minClusters }),
    ...(definition?.maxClusters != null && { maxClusters: definition.maxClusters }),
    ...(definition?.autoStopMinutes != null && { autoStopMinutes: definition.autoStopMinutes }),
    pressure: row,
    // `runs` counts the estate's statements only, so zero of them splits in two: a warehouse the
    // assessment ran on is the one doing the assessing, and a warehouse nothing ran on is a warehouse to
    // ask about. Both have no findings and they are not the same row.
    state:
      row.runs === 0
        ? row.ranAssessment
          ? 'assessment-only'
          : 'unused'
        : row.measured === 0
          ? 'unmeasured'
          : findings.length > 0
            ? 'advised'
            : 'clean',
    findings,
  };
}

function findingsFor(
  row: WarehousePressureRow,
  definition: WarehouseRow | undefined,
  ruleset: SizingRuleset
): readonly SizingFinding[] {
  const found = CONDITIONS.flatMap((condition) => {
    const rule = ruleset.rules.get(condition.id);
    if (rule == null) return [];
    const hit = condition.test(row, rule, definition);
    return hit == null ? [] : [{ rule: condition.id, warehouseId: row.warehouseId, ...hit }];
  });

  return [...found].sort((a, b) => RANK[a.severity] - RANK[b.severity] || order(a.rule) - order(b.rule));
}

function order(id: SizingRuleId): number {
  return CONDITIONS.findIndex((condition) => condition.id === id);
}

type Hit = Pick<SizingFinding, 'severity' | 'confidence' | 'evidence'>;

interface Condition {
  readonly id: SizingRuleId;
  readonly test: (
    row: WarehousePressureRow,
    rule: WorkloadRule,
    definition: WarehouseRow | undefined
  ) => Hit | undefined;
}

/**
 * The conditions, in reading order: what went wrong first, what could be cheaper last.
 *
 * The order is also the order they should be acted on. Queueing and spill are things that happened to
 * somebody, idle uptime is money, and headroom is an experiment. A page that led with the saving would be
 * inviting a reader to shrink a warehouse whose statements are already queueing.
 */
const CONDITIONS: readonly Condition[] = [
  {
    id: 'WAREHOUSE_QUEUEING',
    test: (row, rule) => {
      const share = row.queuePercent;
      if (share == null || row.runs < rule.thresholds['min_runs']) return undefined;
      if (row.daysQueued < rule.thresholds['days_queued']) return undefined;
      if (share < rule.thresholds['queue_percent']) return undefined;
      return {
        severity: share >= rule.thresholds['critical_queue_percent'] ? 'critical' : rule.severity,
        // The platform records the wait. There is no inference between "waited for capacity" and "was
        // waiting for capacity", which is the same reason `CAPACITY_WAIT` is high on a query shape.
        confidence: 'high',
        evidence: [
          { label: 'Share of elapsed time queued', value: share, unit: 'percent' },
          { label: 'Days it queued on', value: row.daysQueued, unit: 'count' },
          { label: 'Most any one statement waited', value: row.worstQueueMs ?? 0, unit: 'ms' },
          { label: 'Clusters it reached', value: row.peakClusters, unit: 'count' },
        ],
      };
    },
  },
  {
    id: 'WAREHOUSE_SPILL',
    test: (row, rule) => {
      if (row.runs < rule.thresholds['min_runs']) return undefined;
      if (row.daysSpilled < rule.thresholds['days_spilled']) return undefined;
      if (row.spilledBytes < rule.thresholds['spill_bytes']) return undefined;
      return {
        severity: row.spilledBytes >= rule.thresholds['critical_spill_bytes'] ? 'critical' : rule.severity,
        // Spilling is recorded rather than deduced. What is inferred is that the *warehouse* is the thing
        // to change rather than one query, which is why the rule's own words send a reader to the profile
        // first — so `moderate` rather than `high`.
        confidence: 'moderate',
        evidence: [
          { label: 'Spilled to disk', value: row.spilledBytes, unit: 'bytes' },
          { label: 'Days it spilled on', value: row.daysSpilled, unit: 'count' },
          { label: 'Statements in the window', value: row.runs, unit: 'count' },
        ],
      };
    },
  },
  {
    id: 'WAREHOUSE_IDLE_UPTIME',
    test: (row, rule, definition) => {
      const share = row.executionPercent;
      if (share == null || row.upMs < rule.thresholds['min_up_ms']) return undefined;
      if (row.daysUsed < rule.thresholds['min_days']) return undefined;
      if (share >= rule.thresholds['execution_percent']) return undefined;
      return {
        severity: rule.severity,
        // The two durations are measured and their ratio is arithmetic, but the cause — an auto-stop
        // longer than the gaps in the work — is one of several things that produce it. A warehouse held
        // open by a BI tool's idle session looks identical.
        confidence: 'moderate',
        evidence: [
          { label: 'Paid cluster time spent executing', value: share, unit: 'percent' },
          { label: 'Time up', value: row.upMs, unit: 'ms' },
          { label: 'Time executing statements', value: row.busyMs, unit: 'ms' },
          // Only where the definition was matched. A zero here would read as a warehouse that stops
          // immediately, which is the opposite of what this finding is about.
          ...(definition?.autoStopMinutes != null
            ? [{ label: 'Auto-stop', value: definition.autoStopMinutes, unit: 'count' as const }]
            : []),
        ],
      };
    },
  },
  {
    id: 'WAREHOUSE_COLD_STARTS',
    test: (row, rule, definition) => {
      // Classic only, and a warehouse whose definition could not be matched is not assumed to be either.
      // On serverless a start is seconds and this is the behaviour the product is for: labs measured 456
      // starts in seven days on a serverless warehouse, which is nothing to report.
      if (definition == null || definition.serverless) return undefined;
      if (row.starts < rule.thresholds['min_starts'] || row.daysSeen < rule.thresholds['min_days']) return undefined;
      const perDay = row.starts / row.daysSeen;
      if (perDay < rule.thresholds['starts_per_day']) return undefined;
      return {
        severity: rule.severity,
        // The starts are counted, not inferred. Which of the two answers applies — a longer auto-stop or
        // serverless — depends on what the warehouse is for, and the rule says both rather than choosing.
        confidence: 'moderate',
        evidence: [
          { label: 'Times it started', value: row.starts, unit: 'count' },
          { label: 'Starts a day', value: Math.round(perDay * 10) / 10, unit: 'ratio' },
          ...(definition.autoStopMinutes != null
            ? [{ label: 'Auto-stop', value: definition.autoStopMinutes, unit: 'count' as const }]
            : []),
        ],
      };
    },
  },
  {
    id: 'WAREHOUSE_HEADROOM',
    test: (row, rule, definition) => {
      const p95 = row.p95Ms;
      if (p95 == null || row.measured < rule.thresholds['min_runs']) return undefined;
      if (row.daysUsed < rule.thresholds['min_days']) return undefined;
      if (p95 >= rule.thresholds['p95_ms']) return undefined;
      // Nothing else may have gone wrong. A warehouse whose tail is fast *because* the slow statements
      // queued or spilled is not one with room to spare, and suggesting a smaller size there would be
      // advice in the wrong direction on the evidence of the other rules on the same row.
      if (row.queueMs > 0 || row.spilledBytes > 0) return undefined;
      // And there has to be a size below the current one. At the bottom of the ladder there is nothing to
      // recommend, and a finding whose action does not exist is worse than no finding.
      if (ladderIndex(definition?.size) < 1) return undefined;
      return {
        severity: rule.severity,
        // The lowest tier, and the rule's own words say why: this is the absence of a problem over one
        // week, offered as something to test rather than something to do.
        confidence: 'low',
        evidence: [
          { label: 'Slowest 5% of statements finished within', value: p95, unit: 'ms' },
          { label: 'Statements measured', value: row.measured, unit: 'count' },
          { label: 'Days it ran on', value: row.daysUsed, unit: 'count' },
        ],
      };
    },
  },
];
