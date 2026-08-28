#!/usr/bin/env node
// The SQL quality release gate — Q1h.
//
// Bounds and grain already refuse undeclared result growth and a known historical-grain
// mistake. They do not hold price coverage, unit compatibility, identity uniqueness,
// generated identifier safety or the Q1a performance budgets. Without one command that
// runs those together, the audit can be completed once and drift immediately.
//
// This gate:
//
//   - enumerates every shipped statement and every generated Databricks SQL family;
//   - refuses a statement added without a declared bound and a benchmark class;
//   - holds each statement's recorded duration under two things: the class cap, which is a chosen
//     ceiling on how long a statement of that kind may take, and 1.5x the duration accepted in an
//     earlier commit, which is the half that can fail when a statement changes;
//   - runs the statement-shape checks, the adversarial semantic fixtures, the generated
//     SQL safety tests, the Lakebase access-path tests that have shipped, and the Q1a
//     recording gate;
//   - publishes a per-statement result; and
//   - reports whether every red audit finding has a regression test — Q1 itself is
//     complete only when that list is empty and no statement is over either ceiling.
//
//   npm run check:sql-release

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { faults } from './awaiting-reading.mjs';
import { GENERATED_SQL_FAMILIES } from './sql-identifiers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const STATEMENTS = join(APP, 'config', 'statements');
const BASELINE = join(APP, 'server', 'collect', 'sql', 'runtime-baseline', 'labs.json');
const ACCEPTED = join(APP, 'server', 'collect', 'sql', 'runtime-baseline', 'accepted.json');
const AWAITING = join(APP, 'server', 'collect', 'sql', 'runtime-baseline', 'awaiting-reading.json');

/**
 * The shape of a statement id the platform issues, which is what tells a reading from a written one.
 *
 * `01f193af-14b0-1bbb-bbbb-authlogin0002` sat in the recording for a statement that had never run, with
 * round numbers for duration and bytes and `error: null`, and this gate printed its duration as that
 * statement's measured budget under the words "every statement meets its measured budget". It is a real
 * execution id or it is not a measurement.
 */
const STATEMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Benchmark classes and their duration ceilings on the Q1a labs recording.
 *
 * **What these are, precisely:** each ceiling was read off the same committed recording it is checked
 * against — the slowest statement in the class, plus headroom nobody wrote down, ranging from 1.25× to
 * 2.24× depending on the class. Both sides therefore move together, and this comparison cannot fail on
 * a code change; it fails only when someone re-measures by hand and a statement lands outside the class
 * it declares. A statement also chooses its own class in a comment, so `-- Benchmark: coverage` is a
 * fourfold wider ceiling than `census` for the price of a word, and both statements added after the gate
 * landed took `coverage`.
 *
 * What 36l changed is the reading on the other side, not these numbers: a ceiling is now held against the
 * median of several samples rather than one. That does not make a ceiling measured, but it does mean a
 * statement passing one is passing on more than a single execution.
 *
 * So this is not a measured budget. It is the longest this project is willing to wait for a statement of
 * that kind, chosen once, and it is kept because an absolute cap is worth having even when it is a
 * preference — a statement that takes a minute should fail something. The check that can actually fail
 * on a change is the one against `accepted.json` below.
 */
/**
 * The fewest readings this gate will call a median.
 *
 * Two would give a median that is the mean of two numbers, which is the thing 36e found unreliable with
 * one. Three is what `measure-sql-baseline.mjs` takes by default, and it is a floor rather than a target:
 * a recording with more is fine, one with fewer fails and says to re-measure. Lowering `SAMPLES` on a run
 * therefore cannot quietly buy a faster measurement — it fails here instead.
 */
const MINIMUM_SAMPLES = 3;

const BENCHMARK_CLASSES = {
  census: { maxDurationMs: 5_000 },
  inventory: { maxDurationMs: 12_000 },
  billing: { maxDurationMs: 10_000 },
  coverage: { maxDurationMs: 20_000 },
  workload: { maxDurationMs: 20_000 },
};

/**
 * Statements measured outside their class, each with the measurement and the row that owns the fix.
 *
 * Per statement rather than by widening the class, so a *new* coverage statement still has to come in
 * under 20 seconds, and so the tolerance is a line somebody can read and delete rather than a number
 * that quietly got bigger. The gate prints these under their own heading for the same reason.
 */
const BUDGET_EXCEPTIONS = {};

// `uc_lineage_coverage` held the last exception here and does not any more.
//
// It was written at 30s and re-argued four times, because ten readings across four samplings put it
// between 20.4s and 27.1s on a statement that never changed: the 20s coverage ceiling had been set
// from a single 6.8s sample nobody could reproduce, and each sampling only established more firmly
// that the statement really did take twenty-something seconds. What none of them established was
// why, which is what an exception cannot do.
//
// 36k's scan pass answered it — the plan read `system.access.table_lineage` ten times — and 36m made
// it read the relation once, measuring a 4,739 ms median against 22,000 ms. So the ceiling is no
// longer the thing in question: the statement is inside its class by a factor of four, and the note
// that argued for 30s described a statement that no longer exists.
//
// Kept here as prose because the shape of the mistake is worth keeping. Four rounds of argument went
// into justifying a number, and the round that made the number unnecessary began by asking what the
// plan did. The reading history is in docs/design/q1a-runtime-baseline.md.

// `governance_audit_coverage` had an exception here and does not any more.
//
// It was written at 26s because eight readings across two samplings put it over its 20s coverage
// ceiling — 36e's five at a 22.7s median, 36l's three at 21.5s — and the note said it "has always been
// outside its class". 36k re-recorded it at 17.2s, 18.1s, 15.8s, a 17,202 ms median, wholly inside. So
// the note was no longer true, and an exception granting 26s to a statement measuring 17.2s is not a
// tolerance anyone would read: it is six seconds of room a real regression could hide in.
//
// Removed rather than rewritten, and the history kept in docs/design/q1a-runtime-baseline.md instead,
// on the reasoning that a recording landing it over 20s again "should fail this gate and be decided".
// It did, one row later: 36m's recording read 13.5s, 21.3s, 13.9s, 15.1s, 16.7s — straddling the
// ceiling, which the check below fails because a median that passes on which reading fell in the middle
// does not say the statement met its budget.
//
// It was decided by reading the plan rather than by widening anything. Photon gives each
// `count(DISTINCT <column>)` its own scan of the table, so three of them plus the plain aggregates read
// `system.access.audit` four times from one `FROM`; grouping once by those three columns is one scan and
// 7.9s. So the statement that spent four rounds arguing about its ceiling is now inside it by a factor
// of two and a half, and the seven other repeated readers are 36n.

/**
 * Red audit findings the Q phases remediates, and the regression that holds each one.
 *
 * A finding with `test: null` is still outstanding — the gate reports it and refuses to call Q1
 * complete. A finding with a test names the file **and the case**, and the gate looks for that case
 * in that file.
 *
 * The case is why this is worth anything. Naming only the file meant the check was `existsSync`, three
 * findings pointed at one file so one file closed three, and deleting the case that held a finding
 * changed nothing here. A case name is not proof the assertion inside it is right, but it is the
 * smallest thing that fails when the specific regression is removed.
 */
const AUDIT_FINDINGS = [
  {
    id: 'lineage-identity',
    phase: 'Q1b',
    what: 'lineage counts each table once across source and target',
    test: 'server/resolve/resolvers/interoperability.test.ts',
    case: 'counts a table that is both source and target once, not twice',
  },
  {
    id: 'maintenance-attribution',
    phase: 'Q1b',
    what: 'manual maintenance credits only commands attributable to assessed tables',
    test: 'server/resolve/resolvers/maintenance.test.ts',
    case: 'does not credit a VACUUM that could not be attributed to the assessed population',
  },
  {
    id: 'unknown-job-triggers',
    phase: 'Q1b',
    what: 'unreadable job triggers stay unknown rather than manual',
    test: 'server/resolve/resolvers/operational-excellence.test.ts',
    case: 'leaves jobs with an unreadable trigger out of the share rather than calling them manual',
  },
  {
    id: 'price-coverage',
    phase: 'Q1c',
    what: 'monetary sums are priced rows only, with coverage beside them',
    test: 'server/collect/sql/billing-semantics.test.ts',
    case: 'measures the priced share per usage unit, not over units pooled together',
  },
  {
    id: 'price-boundary',
    phase: 'Q1c',
    what: 'list-price joins use usage_end_time',
    test: 'server/collect/sql/billing-semantics.test.ts',
    case: 'uses usage_end_time on every priced billing statement',
  },
  {
    id: 'serverless-vocabulary',
    phase: 'Q1c',
    what: 'serverless-only product list is identical across billing statements',
    test: 'server/collect/sql/billing-semantics.test.ts',
    case: 'is identical in compute mix, estate profile and job spend',
  },
  {
    id: 'generated-identifier-safety',
    phase: 'Q1f',
    what: 'every generated Databricks SQL path goes through quoteIdent',
    test: 'scripts/sql-identifiers.test.ts',
    case: 'lists every source that interpolates a backtick-quoted identifier',
  },
  {
    id: 'legal-hold-double-release',
    phase: 'Q1g',
    what: 'a second lift by the same actor returns false from UPDATE … RETURNING',
    test: 'server/admin/retention-store.test.ts',
    case: 'answers false when the same actor lifts twice, not true from reading their own prior release',
  },
  {
    id: 'warehouse-carried-state',
    phase: 'Q1d',
    what: 'warehouse pressure seeds state before the lookback boundary',
    test: 'server/collect/sql/advisor-populations.test.ts',
    case: 'seeds the boundary from the last event before the window',
  },
  {
    id: 'query-shape-exclusions',
    phase: 'Q1d',
    what: 'ambiguous query-shape populations are visible exclusions',
    test: 'server/collect/sql/advisor-populations.test.ts',
    case: 'returns the covered time that no returned shape describes',
  },
  {
    id: 'query-shape-fingerprint',
    phase: 'Q1d',
    // Amended by 36s, which measured the premise this criterion was written from and found it wrong. It
    // required a tokenizer or an engine fingerprint: the platform exposes no engine fingerprint (checked
    // 2026-08-11), and every one of the seven defects the two measurements found was lexical, so a
    // tokenizer would have been machinery bought for a problem nobody could measure. What the fingerprint
    // needs is not a particular implementation but a statement of what it should do that something checks,
    // which is what ADR 0075 decided and what this now requires.
    what: "the fingerprint's intended behaviour is declared pair by pair, held to a recording, and measured on the statement that ships",
    test: 'scripts/measure-shape-fingerprint.test.ts',
    case: [
      'measures the fingerprint that ships, rather than a second copy of it that has drifted',
      'says which pairs the shipped fingerprint gets right, and is not describing a run that has moved on',
    ],
  },
  {
    id: 'pipeline-workspace-scope',
    phase: 'Q1d',
    what: 'pipeline update joins use (workspace_id, pipeline_id) before aggregation',
    test: 'server/collect/sql/advisor-populations.test.ts',
    case: 'scopes and groups the update counts by workspace',
  },
  {
    id: 'readiness-config-time',
    phase: 'Q1d',
    what: 'serverless readiness states whether it reads current or run-time configuration',
    test: 'server/collect/sql/advisor-populations.test.ts',
    case: 'reads the latest cluster row rather than the one in force at the run',
  },
  {
    id: 'bucket-below-aggregate',
    phase: 'Q1e',
    what: 'adaptive hash bucketing filters source rows before grouping',
    test: 'scripts/measure-sql-plans.test.ts',
    case: 'found the predicate at the scan on all four, which is the premise Q1e was scheduled on',
  },
  {
    // 36p closed the shuffle and spill half of this and found the other half was not what this finding
    // said it was. The wording claimed four budgets with two held; measured, one was held. Duration is,
    // by the class ceiling and the regression check in this file. Read never was: `bytesRead` is the
    // result manifest's byte count rather than data scanned, and it is null on all 25 statements, so a
    // budget over it would have held nothing. The number the Q1e rework was actually about — `read_bytes`
    // from query history, the one every scan-count probe used — is not in the recording at all. Recording
    // it and holding it is 36q; until that lands, this names the three budgets that exist.
    id: 'repeated-scans',
    phase: 'Q1e',
    what: 'statements clear measured duration, shuffle and spill budgets after plan rework',
    test: 'server/collect/sql/runtime-baseline.test.ts',
    case: [
      'holds every statement to a shuffle ceiling and to no spill at all',
      'measured shuffle and spill for most statements, so the ceilings above are not skipped',
    ],
  },
  {
    // Two sides, deliberately. The ratio is above, in this file, because that is where budgets against
    // `accepted.json` live. What is held in a test is that both sides of the ratio exist at all — a
    // recording whose enrichment stopped filling the field would leave the check skipping every statement
    // while the gate still printed a budget, which is the failure 36p found in `repeated-scans`.
    id: 'read-bytes-budget',
    phase: 'Q1e',
    what: 'data actually scanned is recorded per statement and held to a budget',
    test: 'server/collect/sql/runtime-baseline.test.ts',
    case: 'recorded the data every statement scanned, and has an accepted reading to hold it against',
  },
  {
    id: 'repeated-reads-accounted',
    phase: 'Q1e',
    what: 'every relation read more than once is either taken to one read or accounted for',
    test: 'scripts/measure-sql-plans.test.ts',
    case: [
      'are the ones accounted for, and no more times than accounted for',
      'still read what the reasons above are about',
    ],
  },
  {
    id: 'lakebase-access-paths',
    phase: 'Q1g',
    what: 'Lakebase reads project and paginate in SQL rather than reducing full histories in TypeScript',
    test: null,
  },
];

const ROWS = /^--\s*Rows:\s*(.+?)\s*$/im;
const BENCHMARK = /^--\s*Benchmark:\s*([a-z][a-z0-9_-]*)\s*$/im;

const problems = [];
const statementResults = [];

const files = readdirSync(STATEMENTS)
  .filter((name) => name.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  problems.push('config/statements is empty, so this gate checked nothing.');
}

const baseline = existsSync(BASELINE)
  ? JSON.parse(readFileSync(BASELINE, 'utf8'))
  : null;

if (baseline == null) {
  problems.push(
    `No Q1a recording at ${BASELINE.slice(APP.length + 1)}.\n` +
      '  Measure with `npm run measure:sql-baseline` and commit the result before claiming budgets.'
  );
}

/**
 * The durations someone accepted, and the factor a fresh reading may exceed them by.
 *
 * This is the half of the duration check that can fail on a change. The class ceiling above came off the
 * same file it is compared against; this one holds the *current* recording against a duration accepted in
 * an earlier commit, so a statement that got half again slower fails until someone runs
 * `npm run baseline:accept` and commits the new number — which is a line in a diff a reviewer sees, not a
 * value that moved because a measurement moved.
 *
 * 36l re-baselined every one of these in the same commit as the recording they came from, which is the
 * one state this check cannot fail in. That was the price of changing the statistic: these were single
 * readings and are now medians, and a median held against a single reading is not a comparison. It costs
 * one commit's worth of the check being dormant, and from the next recording on both sides are medians
 * taken in different commits, which is what it was for.
 */
const accepted = existsSync(ACCEPTED) ? JSON.parse(readFileSync(ACCEPTED, 'utf8')) : null;

if (accepted == null) {
  problems.push(
    `No accepted durations at ${ACCEPTED.slice(APP.length + 1)}.\n` +
      '  Seed them with `npm run baseline:accept` from a recording you are willing to stand behind.'
  );
}

/**
 * Statements shipped with no reading, each with the row that owes one.
 *
 * The reasoning is in the file itself. What this side of it does: a name here is exempt from the
 * recording checks and from both ceilings — it has no numbers for either — and from nothing else, and
 * the exemption is priced. The statement prints as unbudgeted under its own heading, Q1 does not read
 * as complete while any name is on the list, and a name whose statement now has a reading is a
 * failure, so the entry is deleted by the change that measures it.
 *
 * Read defensively, because every name on this list is exempt from both ceilings while it is there. A
 * file this gate cannot parse would otherwise throw somewhere below and take the whole run with it,
 * which is a stack trace where a stated problem belongs; and a file with no `statements` object would
 * read as an empty list, which is the exemptions silently un-applying rather than being deleted.
 */
let awaiting = {};
if (existsSync(AWAITING)) {
  const where = AWAITING.slice(APP.length + 1);
  try {
    const statements = JSON.parse(readFileSync(AWAITING, 'utf8')).statements;
    if (statements != null && typeof statements === 'object' && !Array.isArray(statements)) {
      awaiting = statements;
    } else {
      problems.push(
        `${where} carries no \`statements\` object.\n` +
          '  Every name it holds is exempt from both duration ceilings, so an unreadable list is a\n' +
          '  problem to state rather than a shape to guess at. Delete the file or give it `statements: {}`.'
      );
    }
  } catch (cause) {
    problems.push(
      `${where} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}\n` +
        '  The statements below are held to the recording checks as though the list were empty, so read\n' +
        '  this problem before the ones about absent readings.'
    );
  }
}

for (const file of files) {
  const name = file.replace(/\.sql$/, '');
  const text = readFileSync(join(STATEMENTS, file), 'utf8');
  const rows = ROWS.exec(text)?.[1] ?? null;
  const benchmark = BENCHMARK.exec(text)?.[1] ?? null;
  const recorded = baseline?.statements?.[name] ?? null;
  const issues = [];

  if (rows == null) {
    issues.push('declares no `-- Rows:` bound');
  }
  if (benchmark == null) {
    issues.push(
      `declares no \`-- Benchmark:\` class (one of ${Object.keys(BENCHMARK_CLASSES).join(', ')})`
    );
  } else if (!(benchmark in BENCHMARK_CLASSES)) {
    issues.push(
      `benchmark class "${benchmark}" is not one of ${Object.keys(BENCHMARK_CLASSES).join(', ')}`
    );
  }

  let labsMs = null;
  let budgetMs = null;
  let acceptedMs = null;
  let regressionMs = null;
  let spread = null;
  let samples = null;
  if (benchmark != null && benchmark in BENCHMARK_CLASSES) {
    budgetMs = BENCHMARK_CLASSES[benchmark].maxDurationMs;
  }
  const exception = BUDGET_EXCEPTIONS[name] ?? null;
  if (exception != null) budgetMs = exception.maxDurationMs;

  const unread = awaiting[name] ?? null;
  if (unread != null && recorded != null) {
    issues.push(
      'is on the awaiting-reading list and has a reading in the Q1a recording. Delete its entry from\n' +
        '  runtime-baseline/awaiting-reading.json — that list is for statements with no numbers, and a\n' +
        '  measured statement left on it is exempt from the ceilings it can now be held to'
    );
  }
  if (unread != null && (String(unread.why ?? '').trim() === '' || String(unread.owedBy ?? '').trim() === '')) {
    issues.push('is awaiting a reading without naming a reason and the ledger row that owes it');
  }
  // The submission, which is a weaker fact than a reading and the one the list was doing without. A
  // labs reading is the only thing in this build that parses SQL, so a statement exempt from having one
  // was exempt from being read at all — and `serving_asset_quality` shipped unparseable. Row 77.
  if (unread != null) for (const fault of faults(unread, text)) issues.push(fault);

  if (baseline != null && unread == null) {
    if (recorded == null) {
      issues.push('absent from the Q1a labs recording');
    } else if (recorded.error != null) {
      issues.push(`Q1a recording carries error: ${String(recorded.error)}`);
    } else if (typeof recorded.durations?.median !== 'number') {
      issues.push(
        'Q1a recording has no sampled durations, so its duration is one reading rather than a median. ' +
          'Re-measure with `npm run measure:sql-baseline`'
      );
    } else if (recorded.durations.samples < MINIMUM_SAMPLES) {
      issues.push(
        `Q1a recording has ${String(recorded.durations.samples)} sample(s), under the ` +
          `${String(MINIMUM_SAMPLES)} this gate holds a median to. Re-measure without lowering SAMPLES`
      );
    } else if (!STATEMENT_ID.test(String(recorded.statementId ?? ''))) {
      issues.push(
        `Q1a recording carries no platform statement id (${String(recorded.statementId)}), so this ` +
          'reading did not come from an execution'
      );
    } else if (typeof recorded.measuredAt !== 'string' || typeof recorded.statementSha !== 'string') {
      issues.push('Q1a recording has no measuredAt or statementSha, so it cannot be tied to a run or a text');
    } else {
      labsMs = recorded.durations.median;
      spread = recorded.durations.spreadRatio ?? null;
      samples = recorded.durations.samples;
      if (budgetMs != null && labsMs > budgetMs) {
        issues.push(
          exception == null
            ? `labs median duration ${String(labsMs)} ms over ${String(samples)} samples exceeds class ` +
              `ceiling ${String(budgetMs)} ms (readings ${recorded.durations.readings.join(', ')} ms)`
            : `labs median duration ${String(labsMs)} ms over ${String(samples)} samples exceeds even its ` +
              `recorded exception of ${String(budgetMs)} ms`
        );
      }
    }
  }

  // Against the accepted duration, which came from an earlier commit than the reading above.
  const stands = accepted?.statements?.[name] ?? null;
  if (accepted != null && labsMs != null) {
    if (stands == null) {
      issues.push(
        'has no accepted duration. Run `npm run baseline:accept` and commit it, so the next reading has ' +
          'something from before it to be held against'
      );
    } else {
      acceptedMs = stands.durationMs;
      regressionMs = Math.round(stands.durationMs * accepted.factor);
      // Both the median and the fastest reading have to be over the line. 36m measured how thick a
      // median of a few readings is: `workspace_directory`, held against itself so that any difference
      // was the apparatus, gave eight readings spanning ×1.67 and two medians of four that were 21%
      // apart — about a third of the ×1.5 this compares against. A recording then failed this check on
      // that statement at 8,906 ms against an accepted 4,884 ms, and eight readings said the accepted
      // number was right and the recording had caught a slow patch on the warehouse.
      //
      // Requiring the min as well is the same idea as the straddle check below, pointed the other way:
      // if even the fastest of several readings is half again the accepted median, the slowdown is not
      // which readings landed where. If the fastest is inside, this recording does not establish a
      // regression, and a check that fires on the warehouse's mood is one people learn to re-run rather
      // than read.
      //
      // The cost is real and preferred: a statement that genuinely got half again slower, but whose
      // fastest reading is still inside, passes here until a later recording puts its min over too. That
      // is a delay in catching a regression rather than a hole — the median check above still holds the
      // class ceiling on every recording, and 36l's straddle check holds the ambiguity.
      if (labsMs > regressionMs && recorded.durations.min > regressionMs) {
        issues.push(
          `labs median duration ${String(labsMs)} ms is more than ${String(accepted.factor)}× the accepted ` +
            `median ${String(stands.durationMs)} ms from ${String(stands.acceptedAt).slice(0, 10)}, and so is ` +
            `its fastest reading of ${String(recorded.durations.min)} ms (readings ` +
            `${recorded.durations.readings.join(', ')} ms). If the statement is legitimately slower, accept ` +
            'the new reading in its own commit; if it is not, this is the regression this check exists for'
        );
      }
    }
  }

  // Against the data the accepted reading scanned, which is a different quantity from the one above and
  // moves for different reasons. 36q measured both recordings before choosing the factor, and what it
  // measured is why the factor is 1.75 rather than the tighter number the row was scheduled to build: two
  // recordings 30 minutes apart, unchanged, ranged from 0.325× to 1.094× of one another. The floor is
  // because `read_bytes` does not count `information_schema`, so seven statements sit at zero while
  // returning rows, and a ratio against zero fails on the platform rather than on us.
  if (accepted != null && stands != null && recorded?.scannedBytes != null) {
    const before = stands.scannedBytes ?? null;
    if (before == null) {
      issues.push(
        'has no accepted scanned-byte reading. Run `npm run baseline:accept` and commit it, so the next ' +
          'recording has something from before it to be held against'
      );
    } else if (before >= accepted.scannedFloorBytes || recorded.scannedBytes >= accepted.scannedFloorBytes) {
      const ceiling = Math.round(before * accepted.scannedFactor);
      if (recorded.scannedBytes > ceiling) {
        issues.push(
          `scanned ${String(recorded.scannedBytes)} bytes, more than ${String(accepted.scannedFactor)}× the ` +
            `accepted ${String(before)} from ${String(stands.acceptedAt).slice(0, 10)}. A step of this size is ` +
            'usually a relation being read more than once — check the plan before accepting. If the estate ' +
            'genuinely grew, accept the new reading in its own commit'
        );
      }
    }
  }

  // The readings disagreeing about the ceiling, which is the one thing a median cannot settle.
  //
  // Not a threshold on the spread itself. A wide spread is usually one cold first reading — 36l measured
  // `jobs_inventory` at 8,607 then 4,826 and 4,342 ms, ×1.98 — and the median is exactly what absorbs
  // that, so failing on the spread would fail on the noise the median was introduced to handle. What the
  // median cannot absorb is a recording whose fastest reading is inside the ceiling and whose slowest is
  // outside it: that recording does not say whether the statement meets its budget, whichever side the
  // middle reading happened to land.
  if (recorded?.durations != null && budgetMs != null) {
    const { min, max, readings } = recorded.durations;
    if (min <= budgetMs && max > budgetMs) {
      issues.push(
        `its ${String(samples)} readings straddle the ${String(budgetMs)} ms ceiling — ` +
          `${readings.join(', ')} ms. This recording does not say whether the statement is inside its ` +
          'budget, so the median passing is an accident of which reading fell in the middle'
      );
    }
  }

  const ok = issues.length === 0;
  if (!ok) {
    for (const issue of issues) problems.push(`${file}: ${issue}`);
  }

  statementResults.push({
    name,
    unread: unread != null,
    bound: rows ?? '—',
    class: benchmark ?? '—',
    budgetMs,
    acceptedMs,
    regressionMs,
    labsMs,
    spread,
    samples,
    ok,
    excepted: exception != null,
    // A statement declaring a slice column was measured with every live workspace bound at once, and
    // the collector executes it once per workspace, re-executing truncating slices as hash buckets. The
    // budget beside it is therefore the cost of a form the app never runs, and this table is where that
    // has to be said, because this table is where the number gets read as a budget.
    unslicedForm: recorded?.sliceColumn != null && recorded.slicedInRecording !== true,
  });
}

if (baseline != null) {
  for (const name of Object.keys(baseline.statements).sort()) {
    if (!files.includes(`${name}.sql`)) {
      problems.push(
        `runtime-baseline/labs.json still records "${name}", which has no file under config/statements.`
      );
    }
  }
}

process.stdout.write('SQL release gate\n\n');
process.stdout.write(
  `  ${String(files.length)} shipped statements, ${String(GENERATED_SQL_FAMILIES.length)} generated SQL families,\n` +
    `  ${String(AUDIT_FINDINGS.length)} red audit findings tracked.\n\n`
);

process.stdout.write('Generated SQL families\n\n');
for (const family of GENERATED_SQL_FAMILIES) {
  const path = join(APP, family.path);
  const present = existsSync(path);
  process.stdout.write(`  ${present ? 'ok' : 'MISSING'}  ${family.id.padEnd(24)} ${family.path}\n`);
  if (!present) {
    problems.push(`Generated SQL family "${family.id}" is missing at ${family.path}.`);
  }
}

process.stdout.write('\nPer-statement budgets\n\n');
const nameWidth = Math.max(...statementResults.map((row) => row.name.length), 'statement'.length);
const boundWidth = Math.max(...statementResults.map((row) => row.bound.length), 'bound'.length);
process.stdout.write(
  `  ${'statement'.padEnd(nameWidth)}  ${'bound'.padEnd(boundWidth)}  class         cap  accepted  ` +
    `${`${String(accepted?.factor ?? '?')}x`.padStart(5)}  median  n  spread  result\n`
);
for (const row of statementResults) {
  const budget = row.budgetMs == null ? '—' : String(row.budgetMs);
  const acceptedShown = row.acceptedMs == null ? '—' : String(row.acceptedMs);
  const regression = row.regressionMs == null ? '—' : String(row.regressionMs);
  const labs = row.labsMs == null ? '—' : String(row.labsMs);
  const samples = row.samples == null ? '—' : String(row.samples);
  const spread = row.spread == null ? '—' : `×${String(row.spread)}`;
  const result = row.ok
    ? row.unread
      ? 'no reading'
      : row.excepted
        ? 'ok (excepted)'
        : 'ok'
    : 'FAIL';
  process.stdout.write(
    `  ${row.name.padEnd(nameWidth)}  ${row.bound.padEnd(boundWidth)}  ${row.class.padEnd(10)}  ` +
      `${budget.padStart(6)}  ${acceptedShown.padStart(8)}  ${regression.padStart(6)}  ${labs.padStart(6)}  ` +
      `${samples.padStart(1)}  ${spread.padStart(6)}  ${result}${row.unslicedForm ? '  unsliced form' : ''}\n`
  );
}
process.stdout.write(
  '\n  "median" is the middle of "n" readings of the same statement text on one warehouse, and "spread" is\n' +
    '  the widest of those over the narrowest. Both ceilings to its left are held against the median, so a\n' +
    '  statement passing them is passing on more than one execution. A wide spread is not itself a failure —\n' +
    '  the first reading of a statement is usually its slowest, and the median is what absorbs that. What\n' +
    '  fails is readings that straddle the cap, because those do not say whether the statement met it.\n'
);

const unsliced = statementResults.filter((row) => row.unslicedForm).map((row) => row.name);
if (unsliced.length > 0) {
  process.stdout.write(
    `\n  ${String(unsliced.length)} of these were measured unsliced: ${unsliced.join(', ')}.\n` +
      '  The harness binds every live workspace at once; the collector runs them once per workspace and\n' +
      '  re-executes truncating slices as hash buckets. Their durations bound a form of the statement the\n' +
      '  app does not run, and 39r records that rather than the harness having been taught to slice.\n'
  );
}

const unreadEntries = Object.entries(awaiting);
if (unreadEntries.length > 0) {
  process.stdout.write('\nAwaiting a first reading\n\n');
  for (const [name, entry] of unreadEntries) {
    if (!files.includes(`${name}.sql`)) {
      problems.push(
        `runtime-baseline/awaiting-reading.json names "${name}", which has no file under config/statements.\n` +
          '  Delete the entry.'
      );
    }
    process.stdout.write(
      `  ${name} — since ${String(entry.since)}, owed by ${String(entry.owedBy)}\n    ${String(entry.why)}\n`
    );
  }
  process.stdout.write(
    '\n  These ship with no duration, no scanned-byte reading and no accepted number, so neither ceiling\n' +
      '  applies to them and this gate publishes no budget for them. Everything else they owe still holds.\n'
  );
}

const exceptions = Object.entries(BUDGET_EXCEPTIONS);
if (exceptions.length > 0) {
  process.stdout.write('\nBudget exceptions\n\n');
  for (const [name, exception] of exceptions) {
    if (!files.includes(`${name}.sql`)) {
      problems.push(
        `Budget exception names "${name}", which has no file under config/statements. Delete the exception.`
      );
    }
    process.stdout.write(
      `  ${name} — ${String(exception.maxDurationMs)} ms, owned by ${exception.owner}\n    ${exception.why}\n`
    );
  }
}

process.stdout.write('\nAudit findings\n\n');
let outstanding = 0;
let covered = 0;
for (const finding of AUDIT_FINDINGS) {
  if (finding.test == null) {
    outstanding += 1;
    process.stdout.write(`  open   ${finding.phase.padEnd(4)}  ${finding.id} — ${finding.what}\n`);
    continue;
  }
  const path = join(APP, finding.test);
  if (!existsSync(path)) {
    problems.push(
      `Finding "${finding.id}" (${finding.phase}) names regression ${finding.test}, which is absent.`
    );
    process.stdout.write(`  MISSING ${finding.phase.padEnd(4)}  ${finding.id} — ${finding.test}\n`);
    continue;
  }
  // A finding may name more than one case, because a claim can have more than one way of stopping being
  // true and naming only one of them leaves the other free to be deleted. `repeated-reads-accounted` is
  // the reason this is a list: one case fails when a statement starts reading a relation twice, and the
  // other when a reason outlives the read it explained, and the finding is only held while both exist.
  const cases = finding.case == null ? [] : [finding.case].flat();
  if (cases.length === 0) {
    problems.push(
      `Finding "${finding.id}" (${finding.phase}) names a file but no test case. A file resolving on disk\n` +
        '  is not a regression: name the `it(...)` that fails when the regression comes back.'
    );
    process.stdout.write(`  MISSING ${finding.phase.padEnd(4)}  ${finding.id} — no named case\n`);
    continue;
  }
  const text = readFileSync(path, 'utf8');
  const absent = cases.filter((one) => !text.includes(one));
  if (absent.length > 0) {
    problems.push(
      `Finding "${finding.id}" (${finding.phase}) names case "${absent[0]}" in ${finding.test},\n` +
        '  which no longer contains it. Either the case was renamed — say so here — or the regression it\n' +
        '  held was deleted, which is the thing this check exists to catch.'
    );
    process.stdout.write(`  MISSING ${finding.phase.padEnd(4)}  ${finding.id} — case gone\n`);
    continue;
  }
  covered += 1;
  process.stdout.write(`  ok     ${finding.phase.padEnd(4)}  ${finding.id}\n`);
}

process.stdout.write(
  `\n  ${String(covered)} covered, ${String(outstanding)} outstanding` +
    (outstanding === 0
      ? ' — every red finding has a regression test.\n'
      : ' — Q1 is not complete until these close.\n')
);

/** Suites this gate owns, in the order a reader of the phase description would expect. */
const SUITES = [
  {
    name: 'statement-shape: bounds',
    run: ['npm', 'run', 'check:statement-bounds'],
  },
  {
    name: 'statement-shape: grain',
    run: ['npm', 'run', 'check:grain'],
  },
  {
    name: 'adversarial semantic fixtures',
    run: [
      'npx',
      'vitest',
      'run',
      'server/collect/sql/billing-semantics.test.ts',
      'server/resolve/resolvers/interoperability.test.ts',
      'server/resolve/resolvers/maintenance.test.ts',
      'server/resolve/resolvers/operational-excellence.test.ts',
      'server/resolve/resolvers/compute-mix.test.ts',
    ],
  },
  {
    name: 'generated SQL safety',
    run: ['npx', 'vitest', 'run', 'scripts/sql-identifiers.test.ts'],
  },
  {
    name: 'Lakebase access-path (shipped)',
    run: ['npx', 'vitest', 'run', 'server/admin/retention-store.test.ts'],
  },
  {
    name: "Q1a performance budgets (recording)",
    run: ['npx', 'vitest', 'run', 'server/collect/sql/runtime-baseline.test.ts'],
  },
];

process.stdout.write('\nSuites\n\n');
for (const suite of SUITES) {
  const started = Date.now();
  const [command, ...args] = suite.run;
  const result = spawnSync(command, args, {
    cwd: APP,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  const failed = result.status !== 0;
  process.stdout.write(`  ${failed ? 'FAIL' : 'ok  '}  ${suite.name.padEnd(42)} ${elapsed}\n`);
  if (failed) {
    const output = [result.stdout, result.stderr]
      .filter((part) => part != null && part.trim() !== '')
      .join('\n')
      .trim();
    problems.push(
      `Suite "${suite.name}" failed.\n` +
        (output === '' ? '  (no output)' : output.split('\n').map((line) => `  ${line}`).join('\n'))
    );
  }
}

const statementsOk = statementResults.every((row) => row.ok);
// A statement with no reading is not a failure and is not completeness either. Q1 is the claim that
// every shipped statement is inside a budget somebody measured, and that claim is false while any of
// them has no numbers — so the list unsets it, and the gate still passes, which is the distinction
// between "this build is broken" and "this build ships something nobody has measured yet".
const q1Complete = outstanding === 0 && statementsOk && unreadEntries.length === 0 && problems.length === 0;

process.stdout.write('\n');
if (q1Complete) {
  process.stdout.write(
    'Q1 complete: every red audit finding names a test case that exists, and no statement is over its\n' +
      '  class cap or more than the accepted factor slower than the duration accepted before it.\n'
  );
} else if (outstanding === 0 && statementsOk && problems.length === 0) {
  process.stdout.write(
    `Q1 incomplete: ${String(unreadEntries.length)} statement(s) ship with no reading, listed above.\n` +
      'Nothing here failed — this gate cannot say every statement meets a budget while some have none.\n'
  );
} else {
  process.stdout.write(
    'Q1 incomplete: outstanding findings remain, or a statement/suite failed above.\n' +
      'Mark the Q1 family done only when this gate reports complete.\n'
  );
}

if (problems.length > 0) {
  process.stderr.write(`\n${String(problems.length)} problem${problems.length === 1 ? '' : 's'}:\n\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n\n`);
  process.exit(1);
}

process.stdout.write('\nSQL release gate passed.\n');
process.exit(0);
