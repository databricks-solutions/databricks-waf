// How the estate writes, and which of its write shapes are worth looking at.
//
// Two conditions over the rows `workload_write_patterns.sql` returns. The words, the citations and both
// thresholds are data — see `write-rules.yaml` — so what is here is the arithmetic and the states.
//
// # Why this is not part of rules.ts or sizing.ts
//
// The same reason those two are separate from each other, one step further along. A query rule describes a
// statement that was slow and a sizing rule describes a machine that was the wrong shape; these describe a
// *pattern of writing*, which is neither, and the person who acts on it is the one who owns the pipeline
// rather than the query or the warehouse. Keeping them here also keeps the id spaces apart, which matters
// because `SMALL_FILES` already exists in the query ruleset and means something else: there it is a scan
// opening too many small files, here it is a load producing them.
//
// # What the honesty rule costs this module, and where
//
// `written_bytes` is null on a run the platform recorded no figure for, and both rules read a byte figure.
// So a shape whose runs stated nothing is not a shape with no findings — it is a shape this run could not
// judge, and `WriteState` carries that as `undeterminable` rather than as `clean`. Measured on
// `large-estate`, 10,470 of 10,472 write statements carried a figure, so this is a rare state on an estate
// that writes and the total state on one whose history predates the column.
//
// That distinction is the reason this analysis exists in the shape it does. An estate whose writes are all
// unreadable would otherwise render as an estate that writes perfectly, which is ADR 0074's failure with a
// page in front of it.

import type { WritePatternRow } from '../collect/sql/shapes.js';
import type { Confidence, Evidence } from './rules.js';
import { writeRules, type Severity, type WorkloadRule, type WriteRuleId, type WriteRuleset } from './workload-rules.js';

export interface WriteFinding {
  readonly rule: WriteRuleId;
  readonly shape: string;
  readonly severity: Severity;
  readonly confidence: Confidence;
  /** Never empty, for the reason rules.ts gives: a finding a reader cannot check is one they must trust. */
  readonly evidence: readonly Evidence[];
}

/**
 * Why a write shape reads the way it does, as one of three states rather than as an empty finding list.
 *
 * Two of the three are "no findings" and they are different sentences. `clean` was measured and is neither
 * pattern — a merge, a delete, a rewrite too small or too rare to be one. `undeterminable` is the shape
 * whose runs carried no written figure, so both rules declined for want of the number rather than because
 * the number was fine. Rendering the second as the first is the one thing this module exists not to do.
 */
export type WriteState = 'advised' | 'clean' | 'undeterminable';

export interface WriteShape {
  readonly workspaceId: string;
  readonly shape: string;
  readonly statementType: string;
  readonly pattern: WritePatternRow;
  readonly state: WriteState;
  readonly findings: readonly WriteFinding[];
}

export interface WriteAnalysis {
  /** The shapes the statement returned, largest writer first, each with its state and findings. */
  readonly shapes: readonly WriteShape[];
  readonly findingCount: number;
  /** Shapes whose runs stated no written figure, so no rule could read one. */
  readonly undeterminable: number;
  /** The estate's own write statements in the window, which the returned shapes are a part of. */
  readonly writeStatements: number;
  /** Of those, how many carried a written figure. The coverage a reader needs beside the shapes. */
  readonly writesStatingBytes: number;
  readonly estateWrittenBytes: number;
  /** Everything else the window saw, so a surface can say how much of the estate's SQL writes at all. */
  readonly otherStatements: number;
  readonly windowDays: number;
  readonly rulesVersion: number;
}

/**
 * The analysis, or `undefined` where there is nothing to analyse.
 *
 * The same distinction the other three analyzers draw, and here the empty case is the most flattering
 * absence in the app: an estate whose query history could not be read would render as an estate that
 * writes nothing at all, which on a lakehouse is not a conclusion anybody should reach from a failed read.
 */
export function analyseWrites(
  patterns: readonly WritePatternRow[],
  lookbackDays: number,
  ruleset: WriteRuleset = writeRules()
): WriteAnalysis | undefined {
  if (patterns.length === 0) return undefined;

  const described = patterns.map((row) => describe(row, ruleset));
  const first = patterns[0];

  return {
    // Findings first, then by what the shape wrote. The statement already ordered by bytes, so this only
    // lifts the shapes with something to say above the ones without.
    shapes: [...described].sort(
      (a, b) => worst(b) - worst(a) || b.pattern.writtenBytes - a.pattern.writtenBytes || a.shape.localeCompare(b.shape)
    ),
    findingCount: described.reduce((total, one) => total + one.findings.length, 0),
    undeterminable: described.filter((one) => one.state === 'undeterminable').length,
    writeStatements: first?.writeStatements ?? described.length,
    writesStatingBytes: first?.writesStatingBytes ?? 0,
    estateWrittenBytes: first?.estateWrittenBytes ?? 0,
    otherStatements: first?.otherStatements ?? 0,
    // Thirty, capped the way the statement caps it, so a caller asking for ninety is told what was read.
    windowDays: Math.min(lookbackDays, 30),
    rulesVersion: ruleset.version,
  };
}

/** The severity of a shape's worst finding, as a sort key. Zero where it has none. */
function worst(one: WriteShape): number {
  return one.findings.reduce((high, finding) => Math.max(high, 4 - RANK[finding.severity]), 0);
}

const RANK: Readonly<Record<Severity, number>> = { critical: 0, high: 1, medium: 2, info: 3 };

function describe(row: WritePatternRow, ruleset: WriteRuleset): WriteShape {
  // No figure on any run means no rule can read one. Checked here rather than inside each condition, so
  // the state is decided once and a rule added later cannot forget it.
  const judgeable = row.runsStatingBytes > 0 && row.medianWriteBytes != null;
  const findings = judgeable ? findingsFor(row, ruleset) : [];

  return {
    workspaceId: row.workspaceId,
    shape: row.shape,
    statementType: row.statementType,
    pattern: row,
    state: !judgeable ? 'undeterminable' : findings.length > 0 ? 'advised' : 'clean',
    findings,
  };
}

function findingsFor(row: WritePatternRow, ruleset: WriteRuleset): readonly WriteFinding[] {
  const found = CONDITIONS.flatMap((condition) => {
    const rule = ruleset.rules.get(condition.id);
    if (rule == null) return [];
    const hit = condition.test(row, rule);
    return hit == null ? [] : [{ rule: condition.id, shape: row.shape, ...hit }];
  });

  return [...found].sort((a, b) => RANK[a.severity] - RANK[b.severity] || order(a.rule) - order(b.rule));
}

function order(id: WriteRuleId): number {
  return CONDITIONS.findIndex((condition) => condition.id === id);
}

type Hit = Pick<WriteFinding, 'severity' | 'confidence' | 'evidence'>;

interface Condition {
  readonly id: WriteRuleId;
  readonly test: (row: WritePatternRow, rule: WorkloadRule) => Hit | undefined;
}

/**
 * The two conditions, largest first.
 *
 * They cannot both fire on one shape — one requires a median write above a gibibyte and the other one
 * below 128 mebibytes — but the order is declared anyway, because a threshold moved in the YAML could make
 * the windows overlap and a finding list whose order depends on which condition ran first is one that
 * changes under a configuration edit nobody connected to it.
 */
const CONDITIONS: readonly Condition[] = [
  {
    id: 'TABLE_REWRITTEN_WHOLE',
    test: (row, rule) => {
      // Only the type the platform records for a full rewrite. An `INSERT` may or may not overwrite and
      // the history does not say which; reading it as one would put every append in the estate here.
      if (row.statementType !== 'REPLACE') return undefined;
      const median = row.medianWriteBytes;
      if (median == null) return undefined;
      if (row.runs < rule.thresholds['min_runs'] || row.daysRun < rule.thresholds['min_days']) return undefined;
      if (median < rule.thresholds['median_write_bytes']) return undefined;
      return {
        severity: row.writtenBytes >= rule.thresholds['critical_written_bytes'] ? 'critical' : rule.severity,
        // The rewrite is recorded and the repetition is counted, so the *pattern* is measured. What is not
        // is whether the change was partial, which is the one thing that would make a `MERGE` the answer —
        // it is in the code that built the statement, not in the history. So `moderate`, and the rule's own
        // words say the remedy is the thing to check rather than the thing to do.
        confidence: 'moderate',
        evidence: [
          { label: 'Written across the window', value: row.writtenBytes, unit: 'bytes' },
          { label: 'The middle run wrote', value: median, unit: 'bytes' },
          { label: 'Times it ran', value: row.runs, unit: 'count' },
          { label: 'Days it ran on', value: row.daysRun, unit: 'count' },
          ...unstated(row),
        ],
      };
    },
  },
  {
    id: 'INGEST_IN_SMALL_PIECES',
    test: (row, rule) => {
      // The two the platform records for a load. A `MERGE` writing small amounts is a merge doing its job,
      // and an `UPDATE` or a `DELETE` is not an ingest at all.
      if (row.statementType !== 'INSERT' && row.statementType !== 'COPY') return undefined;
      const median = row.medianWriteBytes;
      if (median == null) return undefined;
      if (row.runs < rule.thresholds['min_runs'] || row.daysRun < rule.thresholds['min_days']) return undefined;
      if (median > rule.thresholds['max_median_write_bytes']) return undefined;
      const perDay = row.runs / row.daysRun;
      if (perDay < rule.thresholds['min_runs_per_day']) return undefined;
      return {
        severity: rule.severity,
        // Every input is counted rather than inferred — the runs, the days, the middle write. What is
        // inferred is that a different ingest path would suit, and that depends on where the data comes
        // from, which the history does not record. So `moderate` for the same reason as the rule above.
        confidence: 'moderate',
        evidence: [
          { label: 'The middle run wrote', value: median, unit: 'bytes' },
          { label: 'Times it ran', value: row.runs, unit: 'count' },
          { label: 'Runs a day', value: Math.round(perDay * 10) / 10, unit: 'ratio' },
          { label: 'Days it ran on', value: row.daysRun, unit: 'count' },
          ...unstated(row),
        ],
      };
    },
  },
];

/**
 * The runs the byte figures above are not over, where there are any.
 *
 * Present only when some run stated nothing, because a zero here would read as a caveat on every finding
 * on every estate. A shape whose runs *all* stated nothing never reaches a condition — see `describe`.
 */
function unstated(row: WritePatternRow): readonly Evidence[] {
  const missing = row.runs - row.runsStatingBytes;
  return missing > 0 ? [{ label: 'Runs that stated no written figure', value: missing, unit: 'count' }] : [];
}
