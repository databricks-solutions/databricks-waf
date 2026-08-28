import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PARSER_VERSION, type PlanOperator } from '../collect/sql/plans/parse.js';
import type { ShapePlan } from '../collect/sql/plans/retrieve.js';
import inputs from '../collect/sql/runtime-baseline/labs-plan-rule-inputs.json' with { type: 'json' };
import type { QueryShapeRow, TableStatisticsRow } from '../collect/sql/shapes.js';
import { planIndex, readingFor } from './plan-index.js';
import { statsIndex } from './stats-index.js';
import { findings, findingsFor, UDF_TAG } from './rules.js';
import { loadWorkloadRules, workloadRules, WORKLOAD_RULE_IDS, workloadRulesDirectory } from './workload-rules.js';

function shape(overrides: Partial<QueryShapeRow> = {}): QueryShapeRow {
  return {
    workspaceId: 'w1',
    shape: 'aaaaaaaaaaaaaaaa',
    statementType: 'SELECT',
    kinds: 1,
    runsNow: 1000,
    runsBefore: 1000,
    measuredNow: 1000,
    measuredBefore: 1000,
    msNow: 1_000_000,
    msBefore: 1_000_000,
    meanMsNow: 1000,
    meanMsBefore: 1000,
    medianMs: 1000,
    worstMs: 1200,
    spilledBytes: 0,
    shuffleBytes: 0,
    readBytes: 10_000_000_000,
    writtenBytes: 0,
    prunedPercent: 90,
    readFiles: 100,
    prunedFiles: 900,
    parallelism: 4,
    compilationPercent: 2,
    queueMs: 0,
    cacheHits: 0,
    failures: 0,
    warehouses: 1,
    jobs: 0,
    pipelines: 0,
    coveredMs: 10_000_000,
    excludedMs: 0,
    coveredRuns: 10_000,
    excludedRuns: 0,
    selfMs: 0,
    selfRuns: 0,
    ambiguousMs: 0,
    ambiguousRuns: 0,
    ambiguousShapes: 0,
    representativeMeasured: true,
    ...overrides,
  };
}

function fired(row: QueryShapeRow): readonly string[] {
  return findingsFor(row).map((finding) => finding.rule);
}

/** A shape whose plan carries a UDF, kept apart from the default so no other test acquires a plan by accident. */
const withUdf = 'bbbbbbbbbbbbbbbb';

/**
 * One plan for one shape, with the operators a test wants and nothing else.
 *
 * The UDF tag is the one `33ia` measured on labs rather than an invention: `UNKNOWN.PhotonScalarUDF`. A test
 * that matched a tag this app has never seen would pass against a rule that can never fire.
 */
function udfPlan(shapeId: string, operators: readonly PlanOperator[] = [scalarUdf(MEASURED)]): ShapePlan {
  return planFor(shapeId, operators);
}

/**
 * One plan for one shape, with its operators and, where a rule walks them, its edges.
 *
 * Edges in the response's own direction, which `33ii` measured and `33id` held over 36 plans: an edge points
 * *from* the operator that consumes *to* the operator that produced. A fixture with them the other way round
 * would pass against a rule that reads the graph backwards.
 */
function planFor(
  shapeId: string,
  operators: readonly PlanOperator[],
  edges: readonly { from: string; to: string }[] = []
): ShapePlan {
  return {
    workspaceId: 'w1',
    shape: shapeId,
    statementId: 'st1',
    observedAt: new Date('2026-08-09T10:00:00Z'),
    extract: {
      parserVersion: PARSER_VERSION,
      fingerprint: 'ffffffffffffffff',
      operatorCount: operators.length,
      operators,
      operatorsWithoutMetrics: operators.filter((one) => one.keyMetrics == null).length,
      // Counted from the operators rather than written as 0, for the reason `AGENTS.md` gives about apparatus:
      // a fixture that contradicts what it describes is a measurement of something that does not exist. No rule
      // here reads the field, and one that does would read it off a plan where it is computed.
      operatorsWithZeroMetrics: operators.filter(
        (one) => one.keyMetrics != null && Object.values(one.keyMetrics).every((value) => value === 0)
      ).length,
      edges,
      // Zero, and it has to be: `sortsIn` says nothing at all where an edge leads to an operator the extract
      // does not have, because a walk that stops short reports "nothing reduces this sort" for a reason that is
      // not a fact about the query. A fixture claiming an unresolved edge it does not have would silence the
      // rule it is testing.
      edgesWithUnknownEndpoint: 0,
    },
  };
}

/**
 * The two metrics `33ia` recorded against the UDF operator on labs that this rule reads.
 *
 * Quoted so a number in a test is a number measured. The recording also carries `peak_memory_bytes`, which no
 * rule reads yet, so it is not here.
 */
const MEASURED = { duration_ms: 111_499, rows_num: 4935 } as const;

/** No argument means an operator carrying no `key_metrics` at all, which is one of the two spellings of absence. */
function scalarUdf(keyMetrics?: PlanOperator['keyMetrics']): PlanOperator {
  return { id: '7', tag: 'UNKNOWN.PhotonScalarUDF', ...(keyMetrics == null ? {} : { keyMetrics }) };
}

/** The shapes whose plans the graph rules read, apart from the UDF one for the same reason it is apart. */
const withExchanges = 'cccccccccccccccc';
const withSort = 'dddddddddddddddd';
const withSkew = 'eeeeeeeeeeeeeeee';
const withJoin = 'ffffffffffffffff';
const withStaleStats = 'aaaabbbbccccdddd';

/**
 * The four skew labels spelled as `NAMED_METRICS` spells them, quoted here so a fixture cannot drift from it.
 *
 * A test that named a label the parser does not keep would pass against a rule that can never fire — the
 * failure `bounds.ts` had. `plan-metrics.test.ts` holds the same labels against `NAMED_METRICS` in both
 * directions; here they are literals so the fixture reads as the response reads.
 */
const SKEW_PARTITIONS = 'MapStage - Skew num skewed partitions';
const SKEW_SIZE_RATIO = 'MapStage - Skew skewed data size ratio';
const SKEW_MAX_TO_MEDIAN = 'MapStage - Skew max to non-empty median ratio';
const SKEW_THRESHOLD_MET = 'ShuffleQueryStage - Adp reduce-side skew threshold met';

/**
 * A map stage carrying the skew metrics, with whatever the platform is said to have reported on it.
 *
 * `named` and not `keyMetrics`: these are the labelled metrics `33ic` added, and `33id` measured them on the
 * map-stage operators of 27 of its 36 plans. An operator with no `named` at all is the case where the platform
 * reported no skew counter, which is not the same as a count of zero — `skewIn` reads them apart and the tests
 * below hold both.
 */
function mapStage(id: string, named?: Readonly<Record<string, number>>): PlanOperator {
  return { id, tag: 'PHOTON_SHUFFLE_MAP_STAGE_EXEC', ...(named == null ? {} : { named }) };
}

/** A plan whose one map stage reports what `33id` measured on every plan of its corpus: no skewed partitions. */
function skewPlan(named: Readonly<Record<string, number>> | undefined, more: readonly PlanOperator[] = []) {
  return planFor(withSkew, [mapStage('m0', named), ...more]);
}

/**
 * A Photon plan with `boundaries` shuffle boundaries in it, spelled as the platform spells them.
 *
 * Two operators per boundary — `PHOTON_SHUFFLE_MAP_STAGE_EXEC` and `UNKNOWN.PhotonShuffleExchangeSink`, in
 * equal numbers — because that is what `33ia` measured and `33id` confirmed on all 28 plans of its corpus that
 * carry an exchange at all. A fixture with one operator per boundary would agree with a rule that counts tags,
 * which is the reading the measurement rejected.
 */
function shuffles(boundaries: number): readonly PlanOperator[] {
  return Array.from({ length: boundaries }, (_, index) => index).flatMap((index) => [
    { id: `m${String(index)}`, tag: 'PHOTON_SHUFFLE_MAP_STAGE_EXEC' },
    { id: `s${String(index)}`, tag: 'UNKNOWN.PhotonShuffleExchangeSink' },
  ]);
}

/**
 * A sort of `rows` rows, and whatever consumes it.
 *
 * The tag is the one every sort in `33id`'s corpus carried. The consumer is a result stage rather than nothing,
 * because a sort the walk finds nothing after is a sort this app cannot judge — `33id` measured that every sort
 * in the corpus had at least four operators after it, so a zero means the edge list did not reach the root.
 */
function sortPlan(rows: number, after: readonly PlanOperator[] = [{ id: 'r', tag: 'PHOTON_RESULT_STAGE_EXEC' }]) {
  const sort: PlanOperator = { id: 'so', tag: 'PHOTON_SORT_EXEC', keyMetrics: { rows_num: rows } };
  // A chain from the sort outwards, each consumer pointing back at what it consumes.
  const edges = after.map((operator, index) => ({
    from: operator.id,
    to: index === 0 ? sort.id : after[index - 1].id,
  }));
  return planFor(withSort, [sort, ...after], edges);
}

/**
 * A join with two sides, each of the given width, and whatever algorithm the plan named.
 *
 * The tags and the algorithm strings are `33ifb`'s, measured over 13 joins: the two tags in that corpus were
 * `PHOTON_BROADCAST_HASH_JOIN_EXEC` and `PHOTON_BROADCAST_NESTED_LOOP_JOIN_EXEC`, and the two algorithm values
 * were `Photon Broadcast Hash` and `Photon Broadcast Nested Loop`. Nothing in that corpus was a shuffle join, so
 * the non-broadcast spellings here are Spark's own names and are an **assumption** — the same one the rule's
 * threshold is, and the reason `joinsIn` reads the broadcast tell off the tag as well as off the algorithm.
 *
 * Edges from the join to each side, in the response's own direction: `from` consumes, `to` produced.
 */
function joinPlan(
  sides: readonly (number | undefined)[],
  options: { readonly algorithm?: readonly string[]; readonly tag?: string; readonly shapeId?: string } = {}
): ShapePlan {
  const join: PlanOperator = {
    id: 'j',
    tag: options.tag ?? 'PHOTON_SHUFFLED_HASH_JOIN_EXEC',
    ...(options.algorithm == null ? {} : { meta: { JOIN_ALGORITHM: options.algorithm } }),
  };
  const inputs = sides.map((rows, index) => ({
    id: `i${String(index)}`,
    tag: 'PHOTON_SCAN_EXEC',
    ...(rows == null ? {} : { keyMetrics: { rows_num: rows } }),
  }));
  return planFor(
    options.shapeId ?? withJoin,
    [join, ...inputs],
    inputs.map((input) => ({ from: join.id, to: input.id }))
  );
}

/**
 * A plan whose scans name the tables given, spelled the way the platform spells them.
 *
 * `meta.SCAN_IDENTIFIER` and not a key metric: `33iga` measured the key on 57 scan operators across 36 plans
 * and found it three-part on 56 of them, which is what lets a plan be joined to a catalogue row at all. One
 * operator may carry several — a scan of a view reads more than one table — so the fixture takes a list per
 * operator to keep that shape available to a test.
 */
function scanPlan(shapeId: string, tables: readonly (readonly string[] | string)[]): ShapePlan {
  return planFor(
    shapeId,
    tables.map((one, index) => ({
      id: `s${String(index)}`,
      tag: 'PHOTON_SCAN_EXEC',
      meta: { SCAN_IDENTIFIER: typeof one === 'string' ? [one] : [...one] },
    }))
  );
}

/**
 * A table analysed and then written to, `hours` later.
 *
 * The sign is the whole reading — `33iga` measured 33 of 34 analysed tables on labs written *before* they were
 * analysed — so a negative `hours` is the ordinary case and is what the tests below pass to assert silence.
 */
function staleTable(table: string, hours: number, writeEvents = 4): TableStatisticsRow {
  return {
    table,
    analysedAt: new Date('2026-08-01T00:00:00Z'),
    analyseOperations: 1,
    writtenAt: new Date(Date.parse('2026-08-01T00:00:00Z') + hours * 3_600_000),
    writeEvents,
    hoursWrittenAfterAnalyse: hours,
  };
}

describe('the ruleset as data', () => {
  it('loads from the shipped configuration, with every rule the advisor fires', () => {
    const ruleset = loadWorkloadRules(workloadRulesDirectory());

    expect([...ruleset.rules.keys()].sort()).toEqual([...WORKLOAD_RULE_IDS].sort());
  });

  it('cites a page and names a version for every rule', () => {
    // The same requirement the serverless ruleset carries: a recommendation with no source is a claim
    // nobody can check, and these pages change — one of them describes a threshold that was calibrated
    // against an estate measurement rather than a docs page.
    for (const rule of workloadRules().rules.values()) {
      expect(rule.docUrl, rule.id).toMatch(/^https:\/\//);
      expect(rule.action.length, rule.id).toBeGreaterThan(20);
      expect(rule.detail.length, rule.id).toBeGreaterThan(80);
    }
  });

  it('requires a rationale from a rule no design document names', () => {
    // Two of them are extensions, and they are the two the calibrated estate put at the top of the page.
    // An extension owes an explanation where an anchored rule carries its anchor.
    const extensions = [...workloadRules().rules.values()].filter((rule) => rule.provenance === 'extension');

    expect(extensions.map((rule) => rule.id).sort()).toEqual(['FAILURE_RATE', 'SERIAL_EXECUTION']);
    for (const rule of extensions) expect(rule.rationale, rule.id).toBeTruthy();
  });

  it('refuses a rule whose threshold the code reads and the file omits', async () => {
    // The failure this check exists for does not announce itself: `row.spilledBytes > undefined` is
    // `false` in JavaScript, so a rule missing a threshold loads, runs, never fires, and reports an estate
    // with no spill. A load-time refusal is the only place that is visible.
    const directory = await mkdtemp(join(tmpdir(), 'workload-rules-'));
    const original = await readFile(join(workloadRulesDirectory(), 'workload-rules.yaml'), 'utf8');
    await writeFile(join(directory, 'workload-rules.yaml'), original.replace('      spill_ratio: 0.05\n', ''));

    expect(() => loadWorkloadRules(directory)).toThrow(/DATA_SPILL.*spill_ratio/s);
  });
});

describe('what fires and what does not', () => {
  it('finds nothing wrong with a healthy shape', () => {
    // The evaluation set the plan defers asks for exactly this case — "a good query with nothing wrong" —
    // and it is the one that decides whether the page is worth opening. Every rule over an ordinary shape
    // must be silent, or every shape carries a finding and none of them means anything.
    expect(fired(shape())).toEqual([]);
  });

  it('names the planner when most of the time is spent compiling', () => {
    // Measured at 89.5% on a shape of 121,097 runs. The execution is fine and the answer is
    // parameterisation, which no volume rule would ever suggest.
    const found = findingsFor(shape({ compilationPercent: 89.5 }));

    expect(found.map((one) => one.rule)).toEqual(['COMPILATION_DOMINATED']);
    expect(found[0]?.severity).toBe('critical');
    expect(found[0]?.evidence).toContainEqual({ label: 'Time spent compiling', value: 89.5, unit: 'percent' });
  });

  it('stays silent on a shape planned slowly only once', () => {
    // Frequency is part of the pathology: the planner is being asked the same question repeatedly. One
    // slow plan is one slow plan.
    expect(fired(shape({ compilationPercent: 89.5, measuredNow: 4, runsNow: 4 }))).toEqual([]);
  });

  it('separates serial work from work that is merely large', () => {
    // The pair calibration used: 0.06 over 26 hours against 50.2 over the same kind of duration. Both read
    // as slow in every other signal and the advice is opposite — more compute helps the second and does
    // nothing at all for the first. Thirty runs of an hour each, so the shape is one somebody would
    // plausibly consider putting a bigger warehouse behind.
    const long = { runsNow: 30, measuredNow: 30, msNow: 108_000_000 };

    expect(fired(shape({ ...long, parallelism: 0.06 }))).toEqual(['SERIAL_EXECUTION']);
    expect(fired(shape({ ...long, parallelism: 50.2 }))).toEqual([]);
  });

  it('does not call a fast shape serial', () => {
    expect(fired(shape({ parallelism: 0.06, msNow: 5000 }))).toEqual([]);
  });

  /*
   * The finding the first real workspace produced twelve of, and the reason `mean_ms` exists.
   *
   * `min_ms` is aggregate, so 353 runs of four seconds clears a minute by a factor of twenty-four and the
   * rule fired on every shape in the estate — all of them small system-table aggregates, serial because
   * they are small. The claim a reader takes from this finding is that a bigger warehouse will not help,
   * which is only worth making about a query somebody would consider a bigger warehouse for.
   */
  it('does not call a frequent short query serial, however much time it adds up to', () => {
    const frequent = shape({ runsNow: 353, measuredNow: 353, msNow: 5_094_737, parallelism: 0.11 });

    expect(frequent.msNow / frequent.measuredNow).toBeLessThan(30_000);
    expect(fired(frequent)).toEqual([]);
  });

  it('does not call a single long run a pattern', () => {
    // One execution at ten minutes and a parallelism of 0.03 was in that same run. It might be serial
    // every time or it might have been unlucky once, and a rule that cannot tell should not say.
    expect(fired(shape({ runsNow: 1, measuredNow: 1, msNow: 600_000, parallelism: 0.03 }))).toEqual([]);
  });

  it('reports a queue against elapsed time, not against nothing', () => {
    const found = findingsFor(shape({ queueMs: 400_000 }));

    expect(found.map((one) => one.rule)).toEqual(['CAPACITY_WAIT']);
    expect(found[0]?.confidence).toBe('high');
  });

  it('ignores a queue that is trivial beside the work', () => {
    // The ported ruleset's floor of five seconds, and the ratio beside it. Five seconds of queue in front
    // of an hour of execution is not a warehouse finding.
    expect(fired(shape({ queueMs: 6000, msNow: 3_600_000 }))).toEqual([]);
  });

  it('will not claim poor pruning about a query that read no files', () => {
    // 3,621 of one measured workspace's 5,885 statements were served without touching a file, and their
    // prune ratio is absent rather than zero. Firing here would be perfect confidence about a table the
    // query never opened.
    expect(fired(shape({ prunedPercent: undefined, readFiles: 0, readBytes: 0 }))).toEqual([]);
  });

  it('finds poor pruning where files were actually read', () => {
    // Calibration measured 0.5% and 0.6% on real shapes, well under the 30% threshold.
    const found = findingsFor(shape({ prunedPercent: 0.6, readFiles: 50_000, readBytes: 400_000_000_000 }));

    expect(found.map((one) => one.rule)).toContain('LOW_FILE_PRUNING');
    expect(found.find((one) => one.rule === 'LOW_FILE_PRUNING')?.severity).toBe('high');
  });

  /*
   * The other finding the first real workspace over-produced, and the reason `min_read_bytes` exists.
   *
   * Eighteen thousand files at 0% pruning, which sounds like the worst table layout in the estate and was
   * a scan of `system.query.history` — a table the reader does not lay out and cannot cluster. A file
   * count cannot tell a wide scan of a large table from a wide scan of a small one; the volume can.
   */
  it('does not advise relaying out a table it barely read', () => {
    const small = shape({ prunedPercent: 0, readFiles: 18_592, readBytes: 2_000_000_000 });

    expect(fired(small)).not.toContain('LOW_FILE_PRUNING');
  });

  it('finds spill and calls half a terabyte critical', () => {
    const found = findingsFor(shape({ spilledBytes: 600_000_000, readBytes: 1_000_000_000 }));

    expect(found[0]?.rule).toBe('DATA_SPILL');
    expect(found[0]?.severity).toBe('critical');
  });

  it('reports spill without a ratio where nothing was read, rather than not at all', () => {
    // A shape that spilled half a terabyte having read nothing from storage is still spilling. The ratio
    // is stated as unavailable by being absent from the evidence rather than by being invented.
    const found = findingsFor(shape({ spilledBytes: 600_000_000, readBytes: 0 }));

    expect(found[0]?.rule).toBe('DATA_SPILL');
    expect(found[0]?.evidence.map((one) => one.label)).not.toContain('Spilled per byte read');
  });

  it('finds a scan opening a great many tiny files', () => {
    expect(fired(shape({ readFiles: 200_000, readBytes: 1_000_000_000, prunedPercent: 90 }))).toContain('SMALL_FILES');
  });

  /*
   * A thousand small files is not a compaction problem, which the first real workspace showed twice.
   *
   * 1,439 files and 210 MB, then 1,113 files and 50 MB. Both true, both about a second of I/O, and both
   * scans of `system.*` tables nobody can compact. Per-file overhead is a cost of *many* files.
   */
  it('does not call a thousand small files a compaction problem', () => {
    expect(fired(shape({ readFiles: 1439, readBytes: 210_000_000, prunedPercent: 90 }))).not.toContain('SMALL_FILES');
  });

  it('says a mostly-cached shape is cached rather than fast', () => {
    // Not a problem, and it changes how every other number on the row reads: the timings are over the runs
    // that executed, so the shape is submitted more often than they suggest.
    const found = findingsFor(shape({ cacheHits: 900, runsNow: 1000, measuredNow: 100 }));

    expect(found.map((one) => one.rule)).toEqual(['CACHE_HIT']);
    expect(found[0]?.severity).toBe('info');
  });

  it('puts failure first among a shape’s findings', () => {
    // Severity order, and it is calibration's order rather than either document's: with REFRESH excluded
    // there is no spill in the measured top twelve at all, and what is there is failures and the planner.
    const found = fired(shape({ failures: 300, runsNow: 1000, parallelism: 0.1 }));

    expect(found[0]).toBe('FAILURE_RATE');
  });

  it('will not call two failures out of three a pattern', () => {
    expect(fired(shape({ runsNow: 3, failures: 2 }))).toEqual([]);
  });

  it('carries numeric evidence on every finding it makes', () => {
    // Line 912 of the advisor document: every finding must contain numeric evidence or an explicit
    // statement that evidence was unavailable. Asserted across every rule at once, because the rule that
    // ships without it will be the tenth one somebody adds.
    const rows = [
      shape({ failures: 500, runsNow: 1000 }),
      shape({ compilationPercent: 80 }),
      shape({ parallelism: 0.1, runsNow: 30, measuredNow: 30, msNow: 108_000_000 }),
      shape({ queueMs: 500_000 }),
      shape({ spilledBytes: 900_000_000, readBytes: 1_000_000_000 }),
      shape({ shuffleBytes: 20_000_000_000, readBytes: 1_000_000_000 }),
      shape({ prunedPercent: 1, readFiles: 50_000, readBytes: 400_000_000_000 }),
      shape({ readFiles: 200_000, readBytes: 1_000_000_000 }),
      shape({ cacheHits: 900, runsNow: 1000 }),
      shape({ shape: withUdf }),
      shape({ shape: withExchanges }),
      shape({ shape: withSort }),
      shape({ shape: withSkew }),
      shape({ shape: withJoin }),
      shape({ shape: withStaleStats }),
    ];

    // The six plan rules need the index passed for this to stay a check over every rule rather than over
    // every rule but six. Without it the assertion below counts short, and the rules that needed the
    // evidence check most are the ones it skips.
    const all = findings(
      rows,
      workloadRules(),
      planIndex([
        udfPlan(withUdf),
        planFor(withExchanges, shuffles(8)),
        sortPlan(2_000_000),
        skewPlan({ [SKEW_PARTITIONS]: 3 }),
        joinPlan([9, 4_000_000]),
        scanPlan(withStaleStats, ['main.sales.orders']),
      ]),
      // And the statistics index for the sixth, which is the one rule here that reads something other than a
      // shape and its plan.
      statsIndex([staleTable('main.sales.orders', 100)])
    );

    expect(new Set(all.map((one) => one.rule)).size).toBe(WORKLOAD_RULE_IDS.length);
    for (const finding of all) {
      expect(finding.evidence.length, finding.rule).toBeGreaterThan(0);
      for (const evidence of finding.evidence) expect(Number.isFinite(evidence.value), finding.rule).toBe(true);
    }
  });

  it('fires every rule the design document names, which the ruleset is now the whole of', () => {
    // This assertion used to be its inverse: `MISSING_OR_STALE_STATS` was asserted *absent*, so that adding it
    // would be a deliberate act rather than a rule wired to a signal nothing collects. `33igb` collected it,
    // and the check kept is that the thirteen of the design document are thirteen here — a rule dropped from
    // the ruleset while its section stays in the document fails this.
    expect(WORKLOAD_RULE_IDS as readonly string[]).toContain('MISSING_OR_STALE_STATS');
  });
});

describe('the rule that reads a plan', () => {
  const costly = shape({ shape: withUdf, msNow: 1_000_000, measuredNow: 100 });
  const read = (row: QueryShapeRow, plans: readonly ShapePlan[]) =>
    findingsFor(row, workloadRules(), readingFor(planIndex(plans), row));

  it('fires on the UDF tag the plan actually carries, with its recorded numbers', () => {
    const found = read(costly, [udfPlan(withUdf)]);

    expect(found.map((one) => one.rule)).toEqual(['UDF_OR_PYTHON_BOUNDARY']);
    expect(found[0]?.confidence).toBe('moderate');
    expect(found[0]?.evidence).toEqual([
      { label: 'UDF steps in the plan', value: 1, unit: 'count' },
      { label: 'Longest time recorded on a UDF step', value: 111_499, unit: 'ms' },
      { label: 'Most rows recorded through a UDF step', value: 4935, unit: 'count' },
      { label: 'Total time', value: 1_000_000, unit: 'ms' },
    ]);
  });

  it('says nothing where the run has no plan for the shape', () => {
    // The common case, and it is about reach rather than about the query: `33k` measured that a shape whose
    // warehouse belongs to a sibling workspace cannot be fetched at all. A rule that read absence as "no UDF"
    // would report the same sentence about a plan it never saw.
    expect(read(costly, []).map((one) => one.rule)).toEqual([]);
  });

  it('does not read another workspace’s plan for the same shape', () => {
    // One `shape` is one normalised statement, and the same text runs in several workspaces. Keyed on the
    // shape alone the rule would answer from whichever row happened to be first.
    const elsewhere: ShapePlan = { ...udfPlan(withUdf), workspaceId: 'w2' };

    expect(read(costly, [elsewhere]).map((one) => one.rule)).toEqual([]);
  });

  it('reports the count and not a duration when the operator carried no metrics', () => {
    // The first of the two unit behaviours the advisor document asks for: never claim a metric that was
    // absent. 17 of 123 operators `33b` measured carry no `key_metrics` at all, and a finding that rendered
    // "0 ms" against one of them would tell a reader the step is free.
    const found = read(costly, [udfPlan(withUdf, [scalarUdf()])]);

    expect(found[0]?.evidence).toEqual([
      { label: 'UDF steps in the plan', value: 1, unit: 'count' },
      { label: 'Total time', value: 1_000_000, unit: 'ms' },
    ]);
  });

  it('reports a zero it was given, because a zero was recorded', () => {
    // The other spelling of absence, and the reason the two are held apart. 3 of the same 123 operators carry
    // metrics whose three values are all zero — the operator did nothing, or nothing was measured, and the
    // response does not say which. What this app can say is what it read.
    const found = read(costly, [udfPlan(withUdf, [scalarUdf({ duration_ms: 0, rows_num: 0 })])]);

    expect(found[0]?.evidence).toEqual([
      { label: 'UDF steps in the plan', value: 1, unit: 'count' },
      { label: 'Longest time recorded on a UDF step', value: 0, unit: 'ms' },
      { label: 'Most rows recorded through a UDF step', value: 0, unit: 'count' },
      { label: 'Total time', value: 1_000_000, unit: 'ms' },
    ]);
  });

  it('counts every UDF step, and reports each figure as the widest recorded rather than as one step’s', () => {
    // Two maxima taken separately, so on this plan they come off different operators — 400 ms on one and 900
    // rows on another. Evidence saying "the slowest step, and the rows through it" would be a join no field
    // makes, which is why neither label names a step. The projection is excluded from both.
    const found = read(costly, [
      udfPlan(withUdf, [
        scalarUdf({ duration_ms: 10, rows_num: 900 }),
        { id: '9', tag: 'UNKNOWN.PhotonVectorizedUDF', keyMetrics: { duration_ms: 400, rows_num: 3 } },
        { id: '2', tag: 'PHOTON_PROJECT_EXEC', keyMetrics: { duration_ms: 90_000, rows_num: 90_000 } },
      ]),
    ]);

    expect(found[0]?.evidence).toEqual([
      { label: 'UDF steps in the plan', value: 2, unit: 'count' },
      { label: 'Longest time recorded on a UDF step', value: 400, unit: 'ms' },
      { label: 'Most rows recorded through a UDF step', value: 900, unit: 'count' },
      { label: 'Total time', value: 1_000_000, unit: 'ms' },
    ]);
  });

  it('reports the longest recorded time even where an untimed UDF step may have been slower', () => {
    // The reason the label says "recorded" and not "the slowest step". An operator carrying no `key_metrics` is
    // 17 of the 123 `33b` measured, and nothing in the response says what it cost — so the widest figure here
    // is the widest that was read, and a superlative over the steps themselves is not available.
    const found = read(costly, [udfPlan(withUdf, [scalarUdf({ duration_ms: 12 }), scalarUdf()])]);

    expect(found[0]?.evidence[0]).toEqual({ label: 'UDF steps in the plan', value: 2, unit: 'count' });
    expect(found[0]?.evidence[1]).toEqual({ label: 'Longest time recorded on a UDF step', value: 12, unit: 'ms' });
  });

  it('does not fire on a projection, which is the tell it would be easiest to get wrong', () => {
    // The design document asks for "a row-wise boundary where native SQL functions may exist", and a tell
    // wide enough to catch every row-wise boundary catches `PHOTON_PROJECT_EXEC` — which is on every one of
    // the five plans `33ia` measured, including the four with no UDF in them.
    const projection: PlanOperator = { id: '2', tag: 'PHOTON_PROJECT_EXEC', keyMetrics: { duration_ms: 90_000 } };

    expect(read(costly, [udfPlan(withUdf, [projection])]).map((one) => one.rule)).toEqual([]);
  });

  it('matches one tag of the whole vocabulary the estate’s plans carried', () => {
    // The claim the tell rests on, held against the recording rather than asserted in a comment beside the
    // regex. `33ia` ran five probes designed to exercise six rules, and their plans between them carry 26
    // distinct operator tags — one UDF and 25 that a pattern reaching for "every row-wise boundary" would sweep
    // up. Widening `UDF_TAG` into that set fails here, which is the only place it would be noticed.
    const tags = new Set(inputs.probes.flatMap((probe) => probe.rungs.include_plans?.inventory?.tags ?? []));

    expect(tags.size).toBe(26);
    expect([...tags].filter((tag) => UDF_TAG.test(tag))).toEqual(['UNKNOWN.PhotonScalarUDF']);
  });

  it('will not report a UDF in a shape that costs almost nothing', () => {
    const cheap = shape({ shape: withUdf, msNow: 30_000, measuredNow: 100 });

    expect(read(cheap, [udfPlan(withUdf)]).map((one) => one.rule)).toEqual([]);
  });

  it('does report a UDF in a fast statement run a great many times', () => {
    // The case a per-run floor would silence, asserted so nobody adds one without reading why it is absent.
    // Ten million runs of 200 ms is 23 days of query time, and a row-wise function is the whole of what a
    // rewrite would remove. SERIAL_EXECUTION's floor is right for SERIAL_EXECUTION: its advice is compute.
    const often = shape({ shape: withUdf, msNow: 2_000_000_000, measuredNow: 10_000_000 });

    expect(read(often, [udfPlan(withUdf)]).map((one) => one.rule)).toEqual(['UDF_OR_PYTHON_BOUNDARY']);
  });

  it('will not report a UDF in a shape measured too few times', () => {
    const rare = shape({ shape: withUdf, msNow: 1_000_000, measuredNow: 2 });

    expect(read(rare, [udfPlan(withUdf)]).map((one) => one.rule)).toEqual([]);
  });

  it('leaves the rest of the ruleset alone when a plan is present', () => {
    // The plumbing is a third argument on every condition, so the check is that nine of them ignore it.
    const failing = shape({ shape: withUdf, failures: 500, runsNow: 1000, measuredNow: 1000 });

    expect(read(failing, [udfPlan(withUdf)]).map((one) => one.rule)).toEqual([
      'FAILURE_RATE',
      'UDF_OR_PYTHON_BOUNDARY',
    ]);
    expect(fired(failing)).toEqual(['FAILURE_RATE']);
  });
});

describe('the rule that counts shuffle boundaries', () => {
  const costly = shape({ shape: withExchanges, msNow: 1_000_000, measuredNow: 100 });
  const read = (row: QueryShapeRow, plans: readonly ShapePlan[]) =>
    findingsFor(row, workloadRules(), readingFor(planIndex(plans), row));

  it('counts a Photon boundary once, so eight boundaries fire and sixteen operators are not sixteen', () => {
    const found = read(costly, [planFor(withExchanges, shuffles(8))]);

    expect(found.map((one) => one.rule)).toEqual(['EXCESSIVE_EXCHANGES']);
    expect(found[0]?.confidence).toBe('moderate');
    expect(found[0]?.evidence).toEqual([
      { label: 'Shuffle boundaries in the plan', value: 8, unit: 'count' },
      { label: 'Steps in the plan', value: 16, unit: 'count' },
      { label: 'Total time', value: 1_000_000, unit: 'ms' },
      { label: 'Runs in the window', value: 100, unit: 'count' },
    ]);
  });

  it('does not fire on the plan the tag reading would have selected', () => {
    /*
     * The measured cost of counting tags rather than boundaries. One plan of `33id`'s 36 carried three map
     * stages, three sinks, a query stage and a reused exchange — eight exchange-named operators and five
     * boundaries. A rule counting tags fires on it at a threshold of eight while its boundary count is three
     * short of the threshold, and the finding's own evidence would have said eight.
     */
    const asMeasured = [
      ...shuffles(3),
      { id: 'q', tag: 'SHUFFLE_QUERY_STAGE_EXEC' },
      { id: 'u', tag: 'REUSED_EXCHANGE_EXEC' },
    ];

    expect(read(costly, [planFor(withExchanges, asMeasured)]).map((one) => one.rule)).toEqual([]);
  });

  it('counts a query stage and a reused exchange as one boundary each', () => {
    // Neither is paired — `33id` measured a query stage on one plan and a reused exchange on one — so the
    // count is six pairs plus the two, which is the threshold. The previous test is the same shape three pairs
    // short, so between them they say the two singles are counted and counted once.
    const eight = [
      ...shuffles(6),
      { id: 'q', tag: 'SHUFFLE_QUERY_STAGE_EXEC' },
      { id: 'u', tag: 'REUSED_EXCHANGE_EXEC' },
    ];
    const found = read(costly, [planFor(withExchanges, eight)]);

    expect(found.map((one) => one.rule)).toEqual(['EXCESSIVE_EXCHANGES']);
    expect(found[0]?.evidence[0]).toEqual({ label: 'Shuffle boundaries in the plan', value: 8, unit: 'count' });
  });

  it('counts a non-Photon exchange as a whole boundary, because the one measured was unpaired', () => {
    // `SHUFFLE_EXCHANGE_EXEC` is the single tag in `33id`'s corpus that named itself an exchange and matched
    // none of Photon's four spellings. It sat on a `MERGE` beside a Photon pair that was already equal, so it
    // is a boundary in its own right rather than a half of one. Seven pairs plus it is eight.
    const mixed = [...shuffles(7), { id: 'x', tag: 'SHUFFLE_EXCHANGE_EXEC' }];

    expect(read(costly, [planFor(withExchanges, mixed)]).map((one) => one.rule)).toEqual(['EXCESSIVE_EXCHANGES']);
  });

  it('does not count a broadcast exchange, which is what the other rules recommend', () => {
    // The reason the count is of recognised shuffle spellings and not of everything matching "exchange". A
    // broadcast is the *fix* a BROADCAST_CANDIDATE finding asks for, so a count wide enough to include one
    // fires on the plan that took the advice. Reported separately instead, and never added.
    const withBroadcasts = [
      ...shuffles(7),
      { id: 'b1', tag: 'PHOTON_BROADCAST_EXCHANGE_EXEC' },
      { id: 'b2', tag: 'UNKNOWN.PhotonBroadcastExchange' },
    ];
    const found = read(costly, [planFor(withExchanges, withBroadcasts)]);

    expect(found.map((one) => one.rule)).toEqual([]);
    // And when the rule does fire, the uncounted ones are on the finding rather than dropped silently.
    const alsoEight = read(costly, [
      planFor(withExchanges, [...shuffles(8), { id: 'b1', tag: 'PHOTON_BROADCAST_EXCHANGE_EXEC' }]),
    ]);
    expect(alsoEight[0]?.evidence).toContainEqual({
      label: 'Exchange steps not counted as boundaries',
      value: 1,
      unit: 'count',
    });
  });

  it('says nothing about a shape whose plan this run does not have', () => {
    expect(read(costly, []).map((one) => one.rule)).toEqual([]);
  });

  it('will not report boundaries in a shape that costs almost nothing, or one measured twice', () => {
    const cheap = shape({ shape: withExchanges, msNow: 30_000, measuredNow: 100 });
    const rare = shape({ shape: withExchanges, msNow: 1_000_000, measuredNow: 2 });

    expect(read(cheap, [planFor(withExchanges, shuffles(8))]).map((one) => one.rule)).toEqual([]);
    expect(read(rare, [planFor(withExchanges, shuffles(8))]).map((one) => one.rule)).toEqual([]);
  });

  it('reports the shape the calibration estate would have selected, and its numbers', () => {
    // The one shape in `33id`'s corpus the shipped thresholds select: ten boundaries in a 55-operator plan,
    // 51 runs and 264 seconds over the window. Held here because the rule's whole justification is that it
    // fires on the tail of a real distribution rather than on a fixture built to make it fire.
    const measured = shape({ shape: withExchanges, msNow: 264_066, measuredNow: 51 });
    const found = read(measured, [
      planFor(withExchanges, [
        ...shuffles(10),
        ...Array.from({ length: 35 }, (_, index) => ({ id: `o${String(index)}`, tag: 'PHOTON_PROJECT_EXEC' })),
      ]),
    ]);

    expect(found.map((one) => one.rule)).toEqual(['EXCESSIVE_EXCHANGES']);
    expect(found[0]?.evidence[0]).toEqual({ label: 'Shuffle boundaries in the plan', value: 10, unit: 'count' });
    expect(found[0]?.evidence[1]).toEqual({ label: 'Steps in the plan', value: 55, unit: 'count' });
  });
});

describe('the rule that reads what follows a sort', () => {
  const costly = shape({ shape: withSort, msNow: 1_000_000, measuredNow: 100 });
  const read = (row: QueryShapeRow, plans: readonly ShapePlan[]) =>
    findingsFor(row, workloadRules(), readingFor(planIndex(plans), row));

  it('fires on a large sort with nothing narrowing it', () => {
    const found = read(costly, [sortPlan(2_000_000)]);

    expect(found.map((one) => one.rule)).toEqual(['LARGE_SORT']);
    expect(found[0]?.confidence).toBe('low');
    expect(found[0]?.evidence).toEqual([
      { label: 'Most rows recorded through an unreduced sort', value: 2_000_000, unit: 'count' },
      { label: 'Sorts with nothing reducing them', value: 1, unit: 'count' },
      { label: 'Sorts in the plan', value: 1, unit: 'count' },
      { label: 'Total time', value: 1_000_000, unit: 'ms' },
    ]);
  });

  it('says nothing where a limit is downstream of the sort', () => {
    const limited = sortPlan(2_000_000, [
      { id: 'p', tag: 'PHOTON_PROJECT_EXEC' },
      { id: 'l', tag: 'UNKNOWN.PhotonLimit' },
    ]);

    expect(read(costly, [limited]).map((one) => one.rule)).toEqual([]);
  });

  it('does not read a limit that feeds the sort as one that follows it', () => {
    // The direction, as a test. `33ii` measured that an edge points from the consumer to the producer, so a
    // limit *upstream* of a sort is an edge from the sort to the limit — and the sort still orders every row it
    // was handed. A walk the other way would call this reduced and stay quiet on the finding.
    const sort: PlanOperator = { id: 'so', tag: 'PHOTON_SORT_EXEC', keyMetrics: { rows_num: 2_000_000 } };
    const upstream = planFor(
      withSort,
      [sort, { id: 'l', tag: 'UNKNOWN.PhotonLimit' }, { id: 'r', tag: 'PHOTON_RESULT_STAGE_EXEC' }],
      [
        { from: 'so', to: 'l' },
        { from: 'r', to: 'so' },
      ]
    );

    expect(read(costly, [upstream]).map((one) => one.rule)).toEqual(['LARGE_SORT']);
  });

  it('does not treat a top-k as an unreduced sort', () => {
    // A top-k is a sort whose limit the planner already applied — `33ii` measured that an `ORDER BY … LIMIT`
    // produces one with no sort operator at all — and `33id` counted 19 of them in the corpus against 14 sorts.
    // Counting them here would report the estate's limited queries as its unlimited ones.
    const topK = planFor(
      withSort,
      [
        { id: 'so', tag: 'UNKNOWN.PhotonTopK', keyMetrics: { rows_num: 2_000_000 } },
        { id: 'r', tag: 'PHOTON_RESULT_STAGE_EXEC' },
      ],
      [{ from: 'r', to: 'so' }]
    );

    expect(read(costly, [topK]).map((one) => one.rule)).toEqual([]);
  });

  it('does not read a sort-merge join as a sort', () => {
    // The design document's line 1017 is about skew and the trap is the same one: a sort-merge join is a
    // legitimate strategy and its tag contains the word. A pattern of `/SORT/` would report every one of them.
    const join = planFor(
      withSort,
      [
        { id: 'j', tag: 'PHOTON_SHUFFLED_SORT_MERGE_JOIN_EXEC', keyMetrics: { rows_num: 40_000_000 } },
        { id: 'a', tag: 'UNKNOWN.PhotonSortAggregate', keyMetrics: { rows_num: 40_000_000 } },
        { id: 'r', tag: 'PHOTON_RESULT_STAGE_EXEC' },
      ],
      [
        { from: 'a', to: 'j' },
        { from: 'r', to: 'a' },
      ]
    );

    expect(read(costly, [join]).map((one) => one.rule)).toEqual([]);
  });

  it('says nothing about a sort the corpus’s own size, which is the census the threshold prevents', () => {
    // 17,010 rows is the widest sort of the 14 `33id` measured, and every one of the 14 has nothing reducing
    // it. A rule on the graph condition alone fires on all of them, which is a census rather than a finding —
    // this assertion is what a lowered `sort_rows` would break.
    expect(read(costly, [sortPlan(17_010)]).map((one) => one.rule)).toEqual([]);
  });

  it('says nothing where the walk found nothing after the sort at all', () => {
    // Distinct from "nothing reduces it": every sort in the corpus had at least four operators downstream, so
    // a plan whose sort reaches none is an edge list that did not reach the root rather than a query with
    // nothing after its sort. Reading the empty walk as evidence would report it as unreduced.
    expect(read(costly, [sortPlan(2_000_000, [])]).map((one) => one.rule)).toEqual([]);
  });

  it('says nothing where the extract predates edges, rather than reading absence as no limit', () => {
    // A retained row written by `plan-parser-2` revives with `edges` undefined. The whole condition is a
    // statement about the graph, so without one there is nothing to say — and the alternative is reporting
    // every sort in the store as unreduced.
    const older = sortPlan(2_000_000);
    const withoutEdges: ShapePlan = {
      ...older,
      extract: {
        ...older.extract,
        parserVersion: 'plan-parser-2',
        edges: undefined,
        edgesWithUnknownEndpoint: undefined,
      },
    };

    expect(read(costly, [withoutEdges]).map((one) => one.rule)).toEqual([]);
  });

  it('says nothing where an edge led to an operator the extract does not have', () => {
    // `parse.ts` counts those rather than dropping them silently, for this case: a walk missing an edge may
    // stop before the limit it was looking for, and then "nothing reduces this sort" is a fact about the
    // extract. All the edges of all three plans `33ii` measured resolved, so this costs nothing measured.
    const broken = sortPlan(2_000_000);
    const unresolved: ShapePlan = {
      ...broken,
      extract: { ...broken.extract, edgesWithUnknownEndpoint: 1 },
    };

    expect(read(costly, [unresolved]).map((one) => one.rule)).toEqual([]);
  });

  it('reports the widest unreduced sort and counts the reduced ones apart', () => {
    // Two sorts, one limited and one not, so the three counts in the evidence are three different numbers
    // rather than the same number three times. The rows figure is the widest of the *unreduced* ones: a
    // maximum over both would report a limited sort's size as the cost of an unlimited one.
    const sortA: PlanOperator = { id: 'sa', tag: 'PHOTON_SORT_EXEC', keyMetrics: { rows_num: 9_000_000 } };
    const sortB: PlanOperator = { id: 'sb', tag: 'PHOTON_SORT_EXEC', keyMetrics: { rows_num: 3_000_000 } };
    const two = planFor(
      withSort,
      [sortA, sortB, { id: 'l', tag: 'UNKNOWN.PhotonLimit' }, { id: 'r', tag: 'PHOTON_RESULT_STAGE_EXEC' }],
      [
        // A limit consumes sortA, and the result stage consumes sortB directly.
        { from: 'l', to: 'sa' },
        { from: 'r', to: 'l' },
        { from: 'r', to: 'sb' },
      ]
    );
    const found = read(costly, [two]);

    expect(found[0]?.evidence).toEqual([
      { label: 'Most rows recorded through an unreduced sort', value: 3_000_000, unit: 'count' },
      { label: 'Sorts with nothing reducing them', value: 1, unit: 'count' },
      { label: 'Sorts in the plan', value: 2, unit: 'count' },
      { label: 'Total time', value: 1_000_000, unit: 'ms' },
    ]);
  });

  it('says nothing where the sort carried no row count, rather than treating absence as small or large', () => {
    // The same absent-versus-zero distinction the UDF rule turns on. A sort with no `key_metrics` is an
    // operator nobody instrumented, and this rule's entire condition is its size.
    const unmeasured = planFor(
      withSort,
      [
        { id: 'so', tag: 'PHOTON_SORT_EXEC' },
        { id: 'r', tag: 'PHOTON_RESULT_STAGE_EXEC' },
      ],
      [{ from: 'r', to: 'so' }]
    );

    expect(read(costly, [unmeasured]).map((one) => one.rule)).toEqual([]);
  });
});

describe('the rule that reads what adaptive execution counted', () => {
  // No cost floor on this rule, so the row carries the default cost — and that is the point rather than an
  // oversight: `33id` measured the trigger reading zero on all 60 operators that carried it, so there is
  // nothing for a floor to protect a reader from. A row costing a second a week with skewed partitions is a
  // finding; one of these tests holds that.
  const row = shape({ shape: withSkew });
  const read = (one: QueryShapeRow, plans: readonly ShapePlan[]) =>
    findingsFor(one, workloadRules(), readingFor(planIndex(plans), one));

  it('fires on a counter above zero, reporting the figures whose scale is known and no others', () => {
    const found = read(row, [
      skewPlan({
        [SKEW_PARTITIONS]: 3,
        // Carried, and read by nothing: zero on all 60 operators of `33id`'s corpus establishes that the
        // platform sends it and nothing about its scale, and a share and a factor are the same number
        // rendered ninefold apart at 0.09. The assertion below is that it does not reach the reader.
        [SKEW_SIZE_RATIO]: 0.42,
        // 19 is the widest max-to-median ratio in `33id`'s corpus, on the one plan of 36 that reaches the
        // design document's screening value of 10. Quoted so the number in the evidence is a number measured.
        [SKEW_MAX_TO_MEDIAN]: 19,
      }),
    ]);

    expect(found.map((one) => one.rule)).toEqual(['DATA_SKEW']);
    expect(found[0]?.severity).toBe('high');
    expect(found[0]?.confidence).toBe('moderate');
    expect(found[0]?.evidence).toEqual([
      { label: 'Most skewed partitions reported on any one step', value: 3, unit: 'count' },
      { label: 'Steps reporting skewed partitions', value: 1, unit: 'count' },
      { label: 'Steps where the platform reported a skew count', value: 1, unit: 'count' },
      // A multiple rather than a ratio, because the surface renders a ratio as a percentage and 19 as a
      // percentage reads "1,900%" — true, and not what the design document means by `max/median >= 10`.
      { label: 'Widest ratio of largest partition to median, on any one step', value: 19, unit: 'multiple' },
      { label: 'Total time', value: 1_000_000, unit: 'ms' },
    ]);
  });

  it('says nothing about the corpus as measured, where the counter is carried and zero on every step', () => {
    // The measurement this rule rests on: 27 of `33id`'s 36 plans carry the counter and it reads zero on all 60
    // operators of them, none of which had skew designed in. The ratio is 4 at the p90 over those same plans,
    // so this fixture is an ordinary plan of that corpus — and if this test ever fires, the rule reports skew
    // on most of the estate.
    const ordinary = skewPlan({
      [SKEW_PARTITIONS]: 0,
      [SKEW_SIZE_RATIO]: 0,
      [SKEW_MAX_TO_MEDIAN]: 4,
    });

    expect(read(row, [ordinary]).map((one) => one.rule)).toEqual([]);
  });

  it('does not fire on the ratio alone, at the value the design document offers as a screening threshold', () => {
    // `max/median >= 10` is line 1048's number and line 1048 also says its screening values are to be confirmed
    // against stage-level evidence before recommending salting or a partition-key change. On the corpus the
    // ordinary reading is 1 to 4 and one plan reaches 19, so a rule triggered by this would fire on a plan
    // nobody has established anything about. This assertion is what wiring the trigger to the ratio would break.
    const highRatio = skewPlan({ [SKEW_PARTITIONS]: 0, [SKEW_MAX_TO_MEDIAN]: 19 });

    expect(read(row, [highRatio]).map((one) => one.rule)).toEqual([]);
  });

  it('does not read the reduce-side threshold marker as skew, at the value most of the corpus carries', () => {
    // Non-zero on 17 of `33id`'s 36 plans — 2 on sixteen of them, 1 on one. Nearly the same value on nearly
    // half of the estate's costliest shapes is not a measurement of anything a reader could act on, so it is
    // neither the trigger nor part of the evidence. `33ia` suspected this from four probes and `33id` counted it.
    const marker = skewPlan({ [SKEW_PARTITIONS]: 0, [SKEW_THRESHOLD_MET]: 2 });

    expect(read(row, [marker]).map((one) => one.rule)).toEqual([]);
  });

  it('says nothing where no step carried the counter, rather than reporting no skew', () => {
    // 9 of the 36 plans carry no skew counter at all, and eight of those nine have no exchange operator — so
    // the absence mostly follows from there being nothing to shuffle. On the ninth the plan shuffles and the
    // counter is missing, and that says nothing either way. Reading absence as zero would be a measurement
    // this app did not take.
    expect(read(row, [skewPlan(undefined)]).map((one) => one.rule)).toEqual([]);
  });

  it('says nothing where the extract predates named metrics, rather than reading absence as no skew', () => {
    // A retained row written by `plan-parser-2` kept no named metrics at all, so its silence about skew is the
    // parser's. `namedMetricsAreReadable` is the gate and this is the case it exists for.
    const older = skewPlan({ [SKEW_PARTITIONS]: 3 });
    const before: ShapePlan = { ...older, extract: { ...older.extract, parserVersion: 'plan-parser-2' } };

    expect(read(row, [before]).map((one) => one.rule)).toEqual([]);
  });

  it('reports the widest count over the steps and how many of them reported anything', () => {
    // Three map stages, two reporting. The maximum is over the steps that carried the counter and is labelled
    // as one: the counter sits on every map stage in a plan, so "the skewed step" would claim a uniqueness no
    // field here carries. The two counts differ, which is what makes them two numbers rather than one twice.
    const several = skewPlan({ [SKEW_PARTITIONS]: 2 }, [
      mapStage('m1', { [SKEW_PARTITIONS]: 7 }),
      mapStage('m2', { [SKEW_PARTITIONS]: 0 }),
    ]);
    const found = read(row, [several]);

    expect(found[0]?.evidence.slice(0, 3)).toEqual([
      { label: 'Most skewed partitions reported on any one step', value: 7, unit: 'count' },
      { label: 'Steps reporting skewed partitions', value: 2, unit: 'count' },
      { label: 'Steps where the platform reported a skew count', value: 3, unit: 'count' },
    ]);
  });

  it('fires on a cheap shape, because the trigger is not a cost signal', () => {
    // Deliberately unlike the two rules above it, whose floors exist because their triggers fire on ordinary
    // work. This one fired on nothing in the corpus, so a cost floor could only silence a true finding — and
    // that decision is here rather than only in the ruleset's comment, because a `min_ms` added later would
    // pass every other test in this file.
    const cheap = shape({ shape: withSkew, msNow: 4000, measuredNow: 1, runsNow: 1 });

    expect(read(cheap, [skewPlan({ [SKEW_PARTITIONS]: 1 })]).map((one) => one.rule)).toEqual(['DATA_SKEW']);
  });

  it('says nothing where the run has no plan for the shape', () => {
    expect(read(row, []).map((one) => one.rule)).toEqual([]);
  });
});

describe('the rule that reads a join’s two sides', () => {
  const costly = shape({ shape: withJoin, msNow: 1_000_000, measuredNow: 100 });
  const read = (one: QueryShapeRow, plans: readonly ShapePlan[]) =>
    findingsFor(one, workloadRules(), readingFor(planIndex(plans), one));

  it('fires on a shuffle join with a narrow side, reporting the rows and not a size', () => {
    const found = read(costly, [joinPlan([9, 4_000_000])]);

    expect(found.map((one) => one.rule)).toEqual(['BROADCAST_CANDIDATE']);
    // Low, and the threshold is why. Every other plan rule's remedy changes what the query asks for; this
    // one's changes how the engine runs it, and the row count is standing in for a byte size nothing carries.
    expect(found[0]?.confidence).toBe('low');
    expect(found[0]?.evidence).toEqual([
      { label: 'Fewest rows on a side of a join that does not broadcast', value: 9, unit: 'count' },
      { label: 'Joins that do not broadcast and have a narrow side', value: 1, unit: 'count' },
      { label: 'Joins in the plan', value: 1, unit: 'count' },
      { label: 'Total time', value: 1_000_000, unit: 'ms' },
    ]);
    // No evidence in bytes, and this is the assertion the whole row turns on. `33ifb` measured the three size
    // metrics: two read zero on all eleven joins that carried them, and `Hashed relation size` moves against
    // the rows. A finding that reported one of them would be reporting an allocation as a size.
    for (const evidence of found[0]?.evidence ?? []) expect(evidence.unit).not.toBe('bytes');
  });

  it('says nothing about a join that already broadcasts, which is what it recommends', () => {
    // Every one of the 13 joins in `33ifb`'s corpus is this case, so it is the ordinary one rather than the
    // edge. `EXCESSIVE_EXCHANGES` leaves a broadcast exchange out of its boundary count for the same reason:
    // a finding here on a join that took the advice is the same defect from the other end.
    const already = joinPlan([9, 4_000_000], {
      tag: 'PHOTON_BROADCAST_HASH_JOIN_EXEC',
      algorithm: ['Photon Broadcast Hash'],
    });

    expect(read(costly, [already]).map((one) => one.rule)).toEqual([]);
  });

  it('reads the broadcast off the tag where the plan named no algorithm', () => {
    // The two tells are different claims and the weaker one has to hold: a plan whose `JOIN_ALGORITHM` is
    // missing still has its tag, and `33ifb` measured both spellings of a broadcast join tag in the corpus.
    const tagOnly = joinPlan([9, 4_000_000], { tag: 'PHOTON_BROADCAST_NESTED_LOOP_JOIN_EXEC' });

    expect(read(costly, [tagOnly]).map((one) => one.rule)).toEqual([]);
  });

  it('says nothing where the narrower side is wider than the threshold', () => {
    // Ten thousand is an assumption — arithmetic on Spark's 10 MB default at a kilobyte a row — and this is
    // the assertion that a raised threshold has to move deliberately.
    expect(read(costly, [joinPlan([50_000, 4_000_000])]).map((one) => one.rule)).toEqual([]);
  });

  it('says nothing where one side carried no row count, rather than calling the other side the narrower', () => {
    // The narrower of one known side and one unknown is not the known one. `33ifb` measured `rows_num` on 26
    // of 26 inputs, so this costs nothing measured and prevents the reading that would fire on a wide join
    // whose second side was never instrumented.
    expect(read(costly, [joinPlan([9, undefined])]).map((one) => one.rule)).toEqual([]);
  });

  it('says nothing where the walk reached only one side', () => {
    // A join with one producer is a join whose other side the edges did not reach, which is a fact about the
    // extract. `33ifb` measured exactly two producers on 13 of 13 joins.
    expect(read(costly, [joinPlan([9])]).map((one) => one.rule)).toEqual([]);
  });

  it('says nothing where the extract predates the readable join keys', () => {
    // `plan-parser-1` stored `JOIN_ALGORITHM` as `[]` on every plan, because it read the wrong one of the two
    // spellings a `meta_data` entry takes — `33ih` fixed that. A rule that may not fire on a broadcast cannot
    // read a plan that cannot tell it which joins are broadcasts, so `metaIsReadable` refuses the extract
    // outright rather than reading its silence as "named no algorithm".
    const plan = joinPlan([9, 4_000_000]);
    const older: ShapePlan = { ...plan, extract: { ...plan.extract, parserVersion: 'plan-parser-1' } };

    expect(read(costly, [older]).map((one) => one.rule)).toEqual([]);
  });

  it('says nothing where the extract predates edges, rather than reading absence as an unsized side', () => {
    const plan = joinPlan([9, 4_000_000]);
    const withoutEdges: ShapePlan = {
      ...plan,
      extract: { ...plan.extract, edges: undefined, edgesWithUnknownEndpoint: undefined },
    };

    expect(read(costly, [withoutEdges]).map((one) => one.rule)).toEqual([]);
  });

  it('says nothing where an edge led to an operator the extract does not have', () => {
    const plan = joinPlan([9, 4_000_000]);
    const unresolved: ShapePlan = { ...plan, extract: { ...plan.extract, edgesWithUnknownEndpoint: 1 } };

    expect(read(costly, [unresolved]).map((one) => one.rule)).toEqual([]);
  });

  it('counts the joins it declined beside the ones it fired on', () => {
    // Three joins: one shuffle join with a narrow side, one that already broadcasts, one whose narrow side is
    // over the threshold. The three evidence counts are three different numbers, which is what makes each of
    // them worth reporting — and the narrowest is a minimum over the candidates rather than over every join.
    const join = (id: string, tag: string, sides: readonly number[]) => ({
      operators: [
        { id, tag },
        ...sides.map((rows, index) => ({
          id: `${id}i${String(index)}`,
          tag: 'PHOTON_SCAN_EXEC',
          keyMetrics: { rows_num: rows },
        })),
      ],
      edges: sides.map((_, index) => ({ from: id, to: `${id}i${String(index)}` })),
    });
    const a = join('ja', 'PHOTON_SHUFFLED_HASH_JOIN_EXEC', [40, 9_000_000]);
    const b = join('jb', 'PHOTON_BROADCAST_HASH_JOIN_EXEC', [3, 9_000_000]);
    const c = join('jc', 'PHOTON_SHUFFLED_HASH_JOIN_EXEC', [80_000, 9_000_000]);
    const three = planFor(
      withJoin,
      [...a.operators, ...b.operators, ...c.operators],
      [...a.edges, ...b.edges, ...c.edges]
    );
    const found = read(costly, [three]);

    expect(found[0]?.evidence.slice(0, 3)).toEqual([
      // 40 and not 3: the broadcast join's side is narrower and is not a candidate.
      { label: 'Fewest rows on a side of a join that does not broadcast', value: 40, unit: 'count' },
      { label: 'Joins that do not broadcast and have a narrow side', value: 1, unit: 'count' },
      { label: 'Joins in the plan', value: 3, unit: 'count' },
    ]);
  });

  it('says nothing on a cheap shape, unlike the skew rule above it', () => {
    // The floor exists here and not there, and the difference is what the trigger fires on: a skew counter read
    // zero on every operator measured, while a shuffle join with a narrow side is ordinary work on any estate
    // that has one. Without the floor this fires on every cheap query that joins a lookup table.
    const cheap = shape({ shape: withJoin, msNow: 4000, measuredNow: 1, runsNow: 1 });

    expect(read(cheap, [joinPlan([9, 4_000_000])]).map((one) => one.rule)).toEqual([]);
  });

  it('says nothing where the run has no plan for the shape', () => {
    expect(read(costly, []).map((one) => one.rule)).toEqual([]);
  });
});

describe('the rule that reads the estate’s statistics history', () => {
  const costly = shape({ shape: withStaleStats, msNow: 1_000_000, measuredNow: 100 });
  const read = (one: QueryShapeRow, plans: readonly ShapePlan[], tables: readonly TableStatisticsRow[] = []) =>
    findingsFor(one, workloadRules(), readingFor(planIndex(plans), one), statsIndex(tables));

  it('fires on a table written after it was analysed, reporting the gap and what changed in it', () => {
    const found = read(
      costly,
      [scanPlan(withStaleStats, ['main.sales.orders'])],
      [staleTable('main.sales.orders', 100)]
    );

    expect(found.map((one) => one.rule)).toEqual(['MISSING_OR_STALE_STATS']);
    // Low, and the sample is not the reason. Both timestamps are the platform's own records; what is thin is
    // the step from "written since analysed" to "the planner chose badly", because nothing here sizes the write
    // against what was already there.
    expect(found[0]?.confidence).toBe('low');
    expect(found[0]?.evidence).toEqual([
      // Milliseconds, because that is the unit the evidence formatter has for a duration. 100 hours.
      { label: 'Longest a table went from analysed to written', value: 360_000_000, unit: 'ms' },
      { label: 'Tables scanned and written since analysed', value: 1, unit: 'count' },
      { label: 'Tables scanned that anything analysed', value: 1, unit: 'count' },
      { label: 'Writes recorded since', value: 4, unit: 'count' },
      { label: 'Total time', value: 1_000_000, unit: 'ms' },
    ]);
  });

  it('says nothing where the table was analysed after it was last written, which is most of a healthy estate', () => {
    // The measurement the rule's sign rests on: 33 of the 34 analysed tables on labs are this case. A rule on
    // the absolute gap fires on all of them, and this is the assertion that removing the sign would break.
    const healthy = [staleTable('main.sales.orders', -100)];

    expect(read(costly, [scanPlan(withStaleStats, ['main.sales.orders'])], healthy).map((one) => one.rule)).toEqual([]);
  });

  it('says nothing where nothing analysed the tables this shape scans, rather than calling them unanalysed', () => {
    // The half of its own name the rule declines, and the reason is `33iga`: `DESCRIBE EXTENDED` reported a
    // `Statistics` row on 11 of 12 scanned tables while 7 of those 11 had no ANALYZE record of any kind, because
    // that row is the Delta log's own estimate. A table missing from this index is one nothing analysed, which
    // cannot be told from one the automatic maintenance has not reached — so a finding here would be the
    // collector's blind spot reported as the estate's problem.
    expect(read(costly, [scanPlan(withStaleStats, ['main.sales.orders'])], []).map((one) => one.rule)).toEqual([]);
  });

  it('counts the tables it could compare beside the ones it fired on', () => {
    // Three tables scanned, two of them analysed, one of those stale. The two counts differ and the difference
    // is the point: without the denominator a reader cannot tell one stale table out of two from one out of a
    // hundred, and a shape whose tables are mostly unanalysed reads as mostly fine.
    const three = scanPlan(withStaleStats, ['main.sales.orders', 'main.sales.customers', 'main.sales.regions']);
    const found = read(
      costly,
      [three],
      [staleTable('main.sales.orders', 100, 9), staleTable('main.sales.customers', -40)]
    );

    expect(found[0]?.evidence.slice(1, 4)).toEqual([
      { label: 'Tables scanned and written since analysed', value: 1, unit: 'count' },
      { label: 'Tables scanned that anything analysed', value: 2, unit: 'count' },
      { label: 'Writes recorded since', value: 9, unit: 'count' },
    ]);
  });

  it('reports the widest gap where several tables are behind', () => {
    const both = scanPlan(withStaleStats, [['main.sales.orders', 'main.sales.customers']]);
    const found = read(costly, [both], [staleTable('main.sales.orders', 30), staleTable('main.sales.customers', 200)]);

    expect(found[0]?.evidence[0]).toEqual({
      label: 'Longest a table went from analysed to written',
      value: 720_000_000,
      unit: 'ms',
    });
    expect(found[0]?.evidence[1]).toEqual({
      label: 'Tables scanned and written since analysed',
      value: 2,
      unit: 'count',
    });
  });

  it('matches a table whose plan and catalogue spell it in different cases', () => {
    // Two assemblies of one identity: the plan's `SCAN_IDENTIFIER` is written by the engine and the statement's
    // is a `concat_ws` of three catalogue columns. Unity Catalog names are case-insensitive and these two
    // strings are not guaranteed to agree, so a case-sensitive index would silently miss.
    const shouting = read(
      costly,
      [scanPlan(withStaleStats, ['MAIN.Sales.Orders'])],
      [staleTable('main.sales.orders', 100)]
    );

    expect(shouting.map((one) => one.rule)).toEqual(['MISSING_OR_STALE_STATS']);
  });

  it('counts a table scanned twice in one plan once', () => {
    // A self-join scans the same table on both sides, and a shape doing that is not two tables behind.
    const twice = scanPlan(withStaleStats, ['main.sales.orders', 'main.sales.orders']);
    const found = read(costly, [twice], [staleTable('main.sales.orders', 100)]);

    expect(found[0]?.evidence[1]).toEqual({
      label: 'Tables scanned and written since analysed',
      value: 1,
      unit: 'count',
    });
  });

  it('says nothing where the gap is inside the threshold', () => {
    // A day, and it is an assumption — see the threshold's comment. A table analysed this morning and appended
    // to this afternoon is not a problem, and this is the assertion a lowered threshold has to move.
    expect(
      read(costly, [scanPlan(withStaleStats, ['main.sales.orders'])], [staleTable('main.sales.orders', 6)]).map(
        (one) => one.rule
      )
    ).toEqual([]);
  });

  it('says nothing where lineage saw no write, rather than reading absence as fresh', () => {
    // A table analysed with no write recorded in the window. The statement returns the row with a null gap
    // because lineage records what it observed, so "no write seen" is not "no write" — and a rule reading the
    // null either way would be reporting lineage's coverage as a fact about the table.
    const unwritten: TableStatisticsRow = {
      table: 'main.sales.orders',
      analysedAt: new Date('2026-08-01T00:00:00Z'),
      analyseOperations: 1,
    };

    expect(read(costly, [scanPlan(withStaleStats, ['main.sales.orders'])], [unwritten]).map((one) => one.rule)).toEqual(
      []
    );
  });

  it('says nothing where the extract predates readable scan identifiers', () => {
    // `plan-parser-1` stored every `meta_data` key as `[]` — `33ih` fixed it — so an extract from it says its
    // query scans no tables. Reading that as "no tables to check" is the same defect as reading it as "no
    // broadcast joins", and `metaIsReadable` refuses the extract for the same reason.
    const plan = scanPlan(withStaleStats, ['main.sales.orders']);
    const older: ShapePlan = { ...plan, extract: { ...plan.extract, parserVersion: 'plan-parser-1' } };

    expect(read(costly, [older], [staleTable('main.sales.orders', 100)]).map((one) => one.rule)).toEqual([]);
  });

  it('says nothing on a cheap shape, for the reason the join rule has a floor and the skew rule has none', () => {
    // A table written since it was analysed is ordinary on any estate that writes. Without the floor this fires
    // on every cheap query against a table that receives appends.
    const cheap = shape({ shape: withStaleStats, msNow: 4000, measuredNow: 1, runsNow: 1 });

    expect(
      read(cheap, [scanPlan(withStaleStats, ['main.sales.orders'])], [staleTable('main.sales.orders', 100)]).map(
        (one) => one.rule
      )
    ).toEqual([]);
  });

  it('says nothing where the run has no plan for the shape', () => {
    expect(read(costly, [], [staleTable('main.sales.orders', 100)]).map((one) => one.rule)).toEqual([]);
  });
});
