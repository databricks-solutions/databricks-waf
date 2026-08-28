// Holds `runtime-baseline/labs.json` to shape, not to a live warehouse.
//
// The measurement itself is `scripts/measure-sql-baseline.mjs`, run by hand against a real workspace
// because nothing in `npm run verify` may depend on a warehouse being reachable. What runs here instead
// is the check that recording was honest about the same three things H1a's own fixture got wrong: every
// statement present, every field present even where its value is null, and the arity the file recorded
// matching the arity `columns.ts` reads from the statement itself — the same discipline `scale.test.ts`
// holds `scale-fixtures.ts` to, applied to this pack's fixture instead.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { columnsOf } from './columns.js';
import { expandFragments, queryDirectory } from './queries.js';

interface StatementRecord {
  readonly name: string;
  readonly statementId: string | null;
  readonly measuredAt: string | null;
  readonly warehouseId: string | null;
  readonly statementSha: string | null;
  readonly slicedInRecording: boolean;
  readonly sliceColumn: string | null;
  readonly rows: number | null;
  readonly columnCount: number | null;
  readonly serializedBytes: number | null;
  readonly durationMs: number | null;
  readonly durations?: {
    readonly readings: readonly number[];
    readonly samples: number;
    readonly min: number;
    readonly median: number;
    readonly max: number;
    readonly spreadRatio: number;
  };
  /** The size of the answer, from the result manifest. Not the data read to compute it. */
  readonly bytesRead: number | null;
  readonly truncated: boolean | null;
  /** The data read to compute the answer, from query history. Held to a budget below. */
  readonly scannedBytes: number | null;
  readonly shuffleReadBytes: number | null;
  readonly spilledLocalBytes: number | null;
  readonly plan: unknown;
  readonly error: string | null;
  readonly parameters: Readonly<Record<string, string>>;
}

interface PopulationRecord {
  readonly statementId?: string;
  readonly measuredAt?: string;
  readonly durationMs?: number;
  readonly columns?: readonly (string | null)[];
  readonly rows?: readonly (readonly (string | null)[])[];
  readonly error?: string;
}

interface BaselineFile {
  readonly runFinishedAt: string;
  readonly profile: string;
  readonly lookbackDays: number;
  readonly workspaceId: string;
  readonly liveWorkspaceCount: number;
  readonly statements: Readonly<Record<string, StatementRecord>>;
  readonly populations: Readonly<Record<string, PopulationRecord>>;
}

/**
 * The correctness populations this release baseline requires, in their stable order.
 * Named here rather than only in the measurement script, so a probe silently dropped from the pack
 * fails this gate rather than disappearing with its recorded result.
 */
const EXPECTED_POPULATIONS = [
  'lineage_overlap',
  'maintenance_attribution',
  'jobs_trigger_unknown',
  'billing_price_coverage',
  'usage_units',
  'warehouse_boundary',
  'query_shapes_empty_text',
  'query_shapes_ambiguity',
] as const;

const BASELINE_DIR = join(import.meta.dirname, 'runtime-baseline');
const PROBES_DIR = join(BASELINE_DIR, 'probes');
const BASELINE_PATH = join(BASELINE_DIR, 'labs.json');
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as BaselineFile;

/**
 * Statements shipped with no reading yet, and the row that owes each one.
 *
 * The recording is allowed to omit these and nothing else about them is relaxed. `awaiting-reading.json`
 * carries the reasoning; what this file adds is that the list can only shrink — a name here whose
 * statement has since been measured fails the case below, so the entry has to go in the same change as
 * the reading rather than sitting there granting an exemption nobody needs any more.
 */
interface AwaitingFile {
  readonly statements: Readonly<
    Record<string, { readonly since: string; readonly why: string; readonly owedBy: string }>
  >;
}
const awaiting = JSON.parse(
  readFileSync(join(BASELINE_DIR, 'awaiting-reading.json'), 'utf8')
) as AwaitingFile;
const awaitingNames = Object.keys(awaiting.statements).sort();

/**
 * The readings the release gate holds the recording above against, from an earlier commit than it. Read
 * here so the recording's own suite can say whether the gate has both sides of that comparison.
 */
interface AcceptedFile {
  readonly factor: number;
  readonly scannedFactor: number;
  readonly scannedFloorBytes: number;
  readonly statements: Readonly<
    Record<string, { readonly durationMs: number; readonly scannedBytes: number | null }>
  >;
}
const accepted = JSON.parse(
  readFileSync(join(BASELINE_DIR, 'accepted.json'), 'utf8')
) as AcceptedFile;

/** The probes on disk, named as the recording names them. */
const probeNames = readdirSync(PROBES_DIR)
  .filter((name) => name.endsWith('.sql'))
  .map((name) => name.replace(/\.sql$/, '').replaceAll('-', '_'))
  .sort();

/** The statement as submitted, which is what `statementSha` fingerprints. */
function submitted(name: string): string {
  const raw = readFileSync(join(queryDirectory(), `${name}.sql`), 'utf8');
  return expandFragments(raw.replace(/;\s*$/, '').trim());
}

function sha(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

const statementNames = readdirSync(queryDirectory())
  .filter((name) => name.endsWith('.sql'))
  .map((name) => name.replace(/\.sql$/, ''))
  .sort();

describe('the recorded runtime baseline', () => {
  it('has a statement to check, so a passing run is not an empty one', () => {
    expect(statementNames.length).toBeGreaterThan(0);
  });

  it('names the warehouse and the date on every reading, not once for the file', () => {
    // A file-level date over per-statement readings is how three readings spliced in from later runs
    // came to sit under a single measurement date. Each record now carries its own, and the file
    // states only when the run finished — a fact about the run, which no reading can be attributed to.
    expect(baseline.runFinishedAt).toBeTruthy();
    expect(Number.isNaN(new Date(baseline.runFinishedAt).getTime())).toBe(false);
    expect(Object.hasOwn(baseline, 'measuredAt'), 'file-level measuredAt is back').toBe(false);

    const finished = new Date(baseline.runFinishedAt).getTime();
    for (const [name, record] of Object.entries(baseline.statements)) {
      expect(record.warehouseId, `${name}.warehouseId`).toBeTruthy();
      expect(record.measuredAt, `${name}.measuredAt`).toBeTruthy();
      const at = new Date(record.measuredAt ?? '').getTime();
      expect(Number.isNaN(at), `${name}.measuredAt does not parse`).toBe(false);
      // A reading taken after the run finished came from somewhere else.
      expect(at, `${name} was measured after the run that wrote it finished`).toBeLessThanOrEqual(finished);
    }
    for (const [name, record] of Object.entries(baseline.populations)) {
      if (record.error != null) continue;
      expect(record.measuredAt, `${name}.measuredAt`).toBeTruthy();
    }
  });

  it('fingerprints the statement text each reading came from', () => {
    // Arity was the only tie between a reading and a statement, so any rewrite preserving column count
    // kept the old duration in place as a measured budget for a statement that no longer existed —
    // which is what happened to auth_login_paths. This recomputes the hash the harness records.
    for (const name of statementNames) {
      const record = baseline.statements[name];
      if (record == null) continue;
      expect(record.statementSha, `${name}.statementSha`).toBe(sha(submitted(name)));
    }
  });

  it('says the four sliced statements were measured unsliced, since the app never runs them that way', () => {
    // The harness binds every live workspace at once; the collector executes these once per workspace
    // and re-executes truncating slices as hash buckets. The reading is of a form the app never runs,
    // and the recording has to carry that rather than leaving the gate to publish it as the budget.
    const declared = statementNames.filter((name) => /^--\s*Slice:/m.test(submitted(name)));
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect(baseline.statements[name]?.sliceColumn, `${name}.sliceColumn`).toBeTruthy();
      expect(baseline.statements[name]?.slicedInRecording, `${name}.slicedInRecording`).toBe(false);
    }
    for (const name of statementNames.filter((one) => !declared.includes(one))) {
      if (awaitingNames.includes(name)) continue;
      expect(baseline.statements[name]?.sliceColumn, `${name}.sliceColumn`).toBeNull();
    }
  });

  it('has an entry for every statement file, and no entry for a statement that no longer exists', () => {
    const recorded = Object.keys(baseline.statements).sort();
    expect(recorded).toEqual(statementNames.filter((name) => !awaitingNames.includes(name)));
  });

  it('has no reading for any statement the awaiting list names, so that list can only shrink', () => {
    // The half of the exemption that makes it temporary. Without this, a name could stay on the list
    // after its statement was measured, and the entry would sit there exempting a statement from checks
    // it now passes — which reads as a tolerance somebody decided to keep rather than an omission
    // nobody could fix. It also stops the list being used the other way: a measured statement over its
    // ceiling cannot be moved here to make the gate quiet, because moving it here fails this.
    const measured = awaitingNames.filter((name) => baseline.statements[name] != null);
    expect(measured, 'awaiting a first reading, and yet recorded').toEqual([]);
  });

  it('names a statement that exists, a reason and a tracking reference on every awaiting entry', () => {
    for (const [name, entry] of Object.entries(awaiting.statements)) {
      expect(statementNames, `${name} is awaiting a reading and has no statement file`).toContain(name);
      expect(entry.why, `${name}.why`).toMatch(/\S/);
      expect(Number.isNaN(new Date(entry.since).getTime()), `${name}.since does not parse`).toBe(false);
      // The distribution repository does not include the private delivery ledger. Preserve the stable
      // tracking reference in the recording so maintainers can reconcile it in the development source,
      // while keeping this release check reproducible from the files that actually ship.
      expect(entry.owedBy, `${name}.owedBy`).toMatch(/^[A-Za-z0-9][A-Za-z0-9.-]*$/);
    }
  });

  it('carries every schema field on every statement, even where the value is null', () => {
    // The measurement script's own error path is what this protects: a statement that failed still has
    // to report `null` for each metric rather than omitting the key, or a reader of the JSON cannot tell
    // "not measured" from "the field does not exist on this shape".
    const fields = [
      'name',
      'statementId',
      'measuredAt',
      'warehouseId',
      'statementSha',
      'slicedInRecording',
      'sliceColumn',
      'rows',
      'columnCount',
      'serializedBytes',
      'durationMs',
      'durations',
      'bytesRead',
      'truncated',
      'scannedBytes',
      'shuffleReadBytes',
      'spilledLocalBytes',
      'plan',
      'error',
      'parameters',
    ] as const;

    for (const [name, record] of Object.entries(baseline.statements)) {
      for (const field of fields) {
        expect(Object.hasOwn(record, field), `${name}.${field}`).toBe(true);
      }
    }
  });

  it('took at least three readings of every statement, and the median is one of the numbers beside it', () => {
    // The gate holds a class ceiling and a regression factor against `durations.median`, so this file has
    // to carry a median the gate can trust. What that means concretely, and what is checked here: the
    // readings are the ones the summary was computed from, `min` and `max` are that array's own, and
    // `durationMs` is the first of them — the reading the statement id, row counts and sha belong to.
    for (const [name, record] of Object.entries(baseline.statements)) {
      if (record.error != null) continue;
      const durations = record.durations;
      expect(durations, `${name}.durations`).toBeDefined();
      if (durations == null) continue;
      expect(durations.samples, `${name}.durations.samples`).toBeGreaterThanOrEqual(3);
      expect(durations.readings, `${name}.durations.readings`).toHaveLength(durations.samples);
      expect(durations.min, `${name}.durations.min`).toBe(Math.min(...durations.readings));
      expect(durations.max, `${name}.durations.max`).toBe(Math.max(...durations.readings));
      // The median recomputed from the readings, not merely inside their range: a hand-edited file could
      // put any number between min and max here and satisfy a range check, and this number is what the
      // release gate holds a class ceiling against.
      const sorted = [...durations.readings].sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      expect(durations.median, `${name}.durations.median is not the median of its readings`).toBe(
        sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle]
      );
      expect(durations.spreadRatio, `${name}.durations.spreadRatio`).toBe(
        Math.round((durations.max / durations.min) * 100) / 100
      );
      expect(durations.readings[0], `${name}.durations.readings[0] is not the recorded durationMs`).toBe(
        record.durationMs
      );
    }
  });

  it('recorded the data every statement scanned, and has an accepted reading to hold it against', () => {
    /*
     * The gate holds `scannedBytes` against `accepted.json` with a factor, and that comparison is only
     * worth anything if both sides exist. This is the side a recording can lose: an enrichment that
     * silently stopped filling the field would leave the gate skipping every statement and reporting a
     * budget it was not applying, which is the exact failure `36p` found in the finding this closes.
     *
     * `read_bytes` is data scanned, and it is not `bytesRead` beside it in the record — that one is the
     * result manifest's `total_byte_count`, the size of the answer. The two were confused for long enough
     * that a plan document claimed a budget was held over a field that is null on every statement.
     *
     * A zero is a real reading and is not "read nothing": `read_bytes` does not count `information_schema`,
     * so `uc_schema_census` returns four rows against a zero. That is why this asserts the field is present
     * rather than positive, and why the gate does not hold a ratio below its floor.
     */
    const missing: string[] = [];
    const unaccepted: string[] = [];
    for (const [name, record] of Object.entries(baseline.statements)) {
      if (record.error != null) continue;
      if (record.scannedBytes == null) missing.push(name);
      else if (accepted.statements[name]?.scannedBytes == null) unaccepted.push(name);
    }
    expect(missing, 'statements with no scanned-byte reading in the recording').toEqual([]);
    expect(unaccepted, 'statements the gate has no accepted scanned-byte reading for').toEqual([]);
    expect(accepted.scannedFactor, 'accepted.json carries no scanned factor').toBeGreaterThan(1);
    expect(accepted.scannedFloorBytes, 'accepted.json carries no scanned floor').toBeGreaterThan(0);
  });

  it('holds every statement to a shuffle ceiling and to no spill at all', () => {
    /*
     * The half of the release gate's `repeated-scans` finding that its duration ceiling does not cover.
     * Both numbers were recorded from `system.query.history` for every statement and compared to nothing,
     * which is how a field goes stale without anyone noticing: 36p exists because writing Q1e's status
     * found the finding naming four budgets and claiming two were held. Measured while writing this, one
     * was — see that finding for where the read-byte budget went.
     *
     * The two ceilings come from different evidence and are not the same kind of number.
     *
     * **No spill at all**, because nothing on this warehouse spills. Measured 2026-08-11 over every
     * statement `system.query.history` held for a day — 3,216 of them, ours and the workspace's — and
     * `spilled_local_bytes` was positive for none. So this is vacuous today by construction, and that is
     * the point: it is a tripwire, not a calibration. A statement that starts spilling has changed
     * materially, and nothing else here would say so.
     *
     * **A shuffle ceiling that is a chosen number**, not a measured one, and the choice is worth stating
     * plainly. Shuffle here is intermittent and mostly absent: over that same day 102 of 2,052 executions
     * of our own statements shuffled anything at all, the largest was 3.66 MB, and the statements with the
     * largest `read_bytes` — 130 MB of `system.query.history` — shuffled nothing. In the recording this
     * file holds, all 25 shuffled nothing. So the observed distribution cannot set a ceiling that means
     * much: a ceiling near the observed maximum would fire on the warehouse picking a shuffle plan rather
     * than on a statement getting worse. 64 MiB is far above everything observed and far below a statement
     * shuffling a relation it used to aggregate locally, which is the regression worth catching.
     *
     * So both ceilings are vacuous against today's recording, and neither is idle: what they hold is the
     * shape of these statements, which aggregate at the leaf and hand small results upward. Tighten the
     * shuffle number against an estate where shuffle is ordinary rather than incidental.
     */
    const SHUFFLE_CEILING_BYTES = 64 * 1024 * 1024;
    for (const [name, record] of Object.entries(baseline.statements)) {
      if (record.error != null) continue;
      // Null is not zero. Query history had not caught up with these submissions when the enrichment pass
      // gave up, and reading that as "shuffled nothing" would report an unmeasured statement as perfect.
      // A recording where every statement is null passes this and fails the case below it.
      if (record.shuffleReadBytes != null) {
        expect(record.shuffleReadBytes, `${name}.shuffleReadBytes`).toBeLessThanOrEqual(
          SHUFFLE_CEILING_BYTES
        );
      }
      if (record.spilledLocalBytes != null) {
        expect(record.spilledLocalBytes, `${name}.spilledLocalBytes`).toBe(0);
      }
    }
  });

  it('measured shuffle and spill for most statements, so the ceilings above are not skipped', () => {
    // The ceilings skip a null, so a recording that enriched nothing would satisfy them without measuring
    // anything. This is what makes that visible. Not "every statement": the enrichment is best-effort
    // against a system table that lags, and one statement missing it is a slow table rather than a fault.
    const enriched = Object.values(baseline.statements).filter(
      (record) => record.error == null && record.shuffleReadBytes != null && record.spilledLocalBytes != null
    ).length;
    const measurable = Object.values(baseline.statements).filter((record) => record.error == null).length;
    const carried = `${String(enriched)} of ${String(measurable)} statements carry shuffle and spill`;
    expect(enriched, carried).toBeGreaterThan(measurable / 2);
  });

  it('recorded every statement without error', () => {
    // Not a requirement of the schema above — a failed run is still a valid recording of a failure — but
    // worth failing loudly on here rather than in a design document nobody re-reads: this pack exists to
    // publish budgets, and a statement with no successful measurement has no budget to publish.
    const failed = Object.entries(baseline.statements)
      .filter(([, record]) => record.error != null)
      .map(([name, record]) => `${name}: ${String(record.error)}`);
    expect(failed).toEqual([]);
  });

  it('recorded no statement as a truncated result', () => {
    // A truncated result is a prefix of the answer, so its duration and bytes are the cost of reading
    // part of it. `truncated` was written and never asserted, and `error` stays null on that path, so a
    // partial read passed this gate and its numbers became the published budget. The collector treats
    // the same condition as fatal.
    const truncated = Object.entries(baseline.statements)
      .filter(([, record]) => record.truncated === true)
      .map(([name]) => name);
    expect(truncated).toEqual([]);
  });

  it('has all seven correctness populations Q1a lists, as probes on disk and as records', () => {
    // Comparing the expected names against the committed JSON alone meant deleting a probe passed:
    // both sides moved together, and the comment claimed the opposite. The probes directory is the
    // third side, and it is the one that says whether a probe still exists.
    expect(probeNames).toEqual([...EXPECTED_POPULATIONS].sort());
    expect(Object.keys(baseline.populations).sort()).toEqual([...EXPECTED_POPULATIONS].sort());
  });

  it('recorded every population without error', () => {
    const failed = Object.entries(baseline.populations)
      .filter(([, record]) => record.error != null)
      .map(([name, record]) => `${name}: ${String(record.error)}`);
    expect(failed).toEqual([]);
  });

  it('recorded at least one row for every probe whose shape always produces one', () => {
    // A probe that ran and returned zero rows is a legitimate finding (see warehouse_boundary in
    // docs/design/q1a-runtime-baseline.md); a probe that returned no rows AT ALL, including the summary
    // row every ungrouped one of these queries is written to always produce, means the query shape
    // itself is wrong rather than the population being empty.
    //
    // Two of the seven end in `GROUP BY`, and for those the claim is false: an estate with no manual
    // maintenance returns no groups, and the rule as written failed `verify` on the first such estate
    // and told it its query shape was wrong. Whether a probe groups is read from the probe rather than
    // listed here, so adding a grouped probe does not need this test edited.
    for (const [name, record] of Object.entries(baseline.populations)) {
      const grouped = /\bGROUP\s+BY\b/i.test(readFileSync(join(PROBES_DIR, `${name.replaceAll('_', '-')}.sql`), 'utf8'));
      if (grouped) {
        // Nothing is asserted about how many groups exist. What is asserted is that the probe returned
        // a result at all: columns present means it ran and its shape was read.
        expect((record.columns?.length ?? 0) > 0, `${name} recorded no columns`).toBe(true);
        continue;
      }
      expect(record.rows?.length ?? 0, name).toBeGreaterThan(0);
    }
  });

  describe.each(statementNames)('%s', (name) => {
    it('has a columnCount matching the arity columnsOf reads from the statement', () => {
      const record = baseline.statements[name];
      if (record?.columnCount == null) return; // A failed statement has nothing to check arity against.

      const text = readFileSync(join(queryDirectory(), `${name}.sql`), 'utf8');
      const columns = columnsOf(text);
      expect(
        record.columnCount,
        `${name} recorded ${String(record.columnCount)} columns; columnsOf reads ${String(columns.length)}: ` +
          `${columns.map((column) => column ?? '?').join(', ')}`
      ).toBe(columns.length);
    });
  });
});
