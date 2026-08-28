// Accepts the durations in the committed recording as the ones a later reading is held against.
//
// The release gate's per-class ceiling was read off the same recording it checks, so both sides moved
// together and the comparison could not fail on a change. This is the other side: a duration accepted in
// one commit, and a reading taken in a later one, with a factor between them. A statement that gets half
// again slower fails the gate until someone runs this and commits the new number — which is a line a
// reviewer sees, rather than a ceiling that moved because a measurement moved.
//
//   node scripts/accept-baseline-durations.mjs             accept every statement's current reading
//   node scripts/accept-baseline-durations.mjs jobs_inventory uc_lineage_coverage
//
// Accepting is deliberately a separate act from measuring. `measure:sql-baseline` records what the
// warehouse did; this says the recording is a number the project will be held to.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const DIR = join(APP, 'server', 'collect', 'sql', 'runtime-baseline');
const BASELINE = join(DIR, 'labs.json');
const ACCEPTED = join(DIR, 'accepted.json');

/** How much slower than the accepted reading a later one may be before the gate fails. */
const FACTOR = 1.5;

/**
 * How much more data than the accepted reading a later one may scan, and a floor below which the ratio is
 * not held at all.
 *
 * **36q set out to make this tighter than the duration factor and measured its way to the opposite.** The
 * premise was that data scanned does not move with warehouse load, so it could take a much tighter factor
 * than 1.5. Two recordings 30 minutes apart with no change between them say otherwise: four statements
 * were bit-identical, six above the floor grew by 1.4% to 9.4%, and four *shrank* — `storage_sample_selection`
 * to 0.325 of its earlier reading, `uc_discovery_metadata` to 0.339, `uc_lineage_coverage` to 0.409. So the
 * quantity is volatile in both directions on an unchanged statement, and a factor near 1 would have failed
 * the gate on the warehouse rather than on our SQL. Both recordings are in q1a-runtime-baseline.md.
 *
 * 1.75 is above all observed growth and below the smallest regression this is for. The regressions Q1e
 * found are multiplicative — `uc_lineage_coverage` read one relation ten times — and one extra full read of
 * a dominant relation is 2×. What bounds the growth side is 30 minutes of evidence, not a week, and labs
 * ran between 374 and 7,032 executions a day over the fortnight to 2026-08-11, so a genuine change in
 * estate activity moves these numbers and re-acceptance is the expected answer to it.
 *
 * The floor exists because a ratio is the wrong instrument at small sizes. Seven statements scan zero
 * bytes, and a zero is not "read nothing": `read_bytes` does not count `information_schema`, so
 * `uc_schema_census` returns four rows against a zero. Against a factor alone, any of those going from
 * zero to a single counted byte fails, which would report a change in how the platform serves a metadata
 * view as a regression in our SQL.
 */
const SCANNED_FACTOR = 1.75;
const SCANNED_FLOOR_BYTES = 4 * 1024 * 1024;

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const previous = existsSync(ACCEPTED) ? JSON.parse(readFileSync(ACCEPTED, 'utf8')) : null;

const named = process.argv.slice(2).filter((argument) => !argument.startsWith('-'));
const at = new Date().toISOString();

const statements = { ...(previous?.statements ?? {}) };
const changed = [];
for (const [name, record] of Object.entries(baseline.statements)) {
  if (named.length > 0 && !named.includes(name)) continue;
  if (record.error != null) continue;
  // The median of the recording's samples, not its first reading, because that is the number the gate
  // holds and the two sides of a comparison have to be the same statistic. A recording from before 36l
  // has no samples, and accepting one is refused rather than silently accepting a single reading as a
  // median: re-measure instead.
  if (typeof record.durations?.median !== 'number') {
    console.log(`  ${name}: skipped, the recording has no sampled durations. Re-measure it.`);
    continue;
  }
  const durationMs = record.durations.median;
  // The first reading's, which is the sample the statement id belongs to: query history is asked about one
  // execution per statement, so unlike the duration this is a single reading rather than a median.
  const scannedBytes = record.scannedBytes ?? null;
  const before = statements[name]?.durationMs ?? null;
  const scannedBefore = statements[name]?.scannedBytes ?? null;
  if (before === durationMs && scannedBefore === scannedBytes) continue;
  statements[name] = {
    durationMs,
    scannedBytes,
    samples: record.durations.samples,
    spreadRatio: record.durations.spreadRatio,
    // The reading this came from, so an accepted number can be traced to the execution behind it rather
    // than to whoever ran this script.
    statementId: record.statementId,
    statementSha: record.statementSha,
    measuredAt: record.measuredAt,
    acceptedAt: at,
  };
  const wasScanned = scannedBefore == null ? 'new' : String(scannedBefore);
  changed.push(
    `${name}: ${before == null ? 'new' : `${String(before)} ms`} -> ${String(durationMs)} ms, ` +
      `scanned ${wasScanned} -> ${scannedBytes == null ? 'unmeasured' : String(scannedBytes)} bytes`
  );
}

for (const name of Object.keys(statements)) {
  if (!Object.hasOwn(baseline.statements, name)) {
    delete statements[name];
    changed.push(`${name}: dropped, no longer in the recording`);
  }
}

const output = {
  factor: FACTOR,
  scannedFactor: SCANNED_FACTOR,
  scannedFloorBytes: SCANNED_FLOOR_BYTES,
  why:
    'Each duration here is the median of a recording in an earlier commit than the one the gate checks, ' +
    'which is what lets the comparison fail on a change. `samples` and `spreadRatio` are that recording\'s, ' +
    'so a reader can see how thick the median under a number is. The factor is the slowdown tolerated ' +
    'without a fresh acceptance; it is a choice, not a measurement. `scannedBytes` is the data read to ' +
    'compute the answer rather than the size of the answer, it is one reading rather than a median, and it ' +
    'carries its own factor because it moves for different reasons: two recordings 30 minutes apart, with ' +
    'no change between them, ranged from 0.325x to 1.094x of each other. So the factor is above observed ' +
    'growth and below one extra full read of a dominant relation, which is the regression it is for. Below ' +
    '`scannedFloorBytes` the ratio is not held: seven statements scan zero counted bytes, so a ratio there ' +
    'would fail on how the platform serves a metadata view rather than on our SQL.',
  acceptedAt: at,
  statements: Object.fromEntries(Object.keys(statements).sort().map((name) => [name, statements[name]])),
};

writeFileSync(ACCEPTED, `${JSON.stringify(output, null, 2)}\n`);
console.log(`wrote ${ACCEPTED.slice(APP.length + 1)}`);
if (changed.length === 0) {
  console.log('nothing changed: every accepted duration already matches the recording.');
} else {
  for (const line of changed) console.log(`  ${line}`);
}
