// Which query shape a reader should look at first.
//
// Not total time, and the advisor document says why at line 530: *"Do not rank only by wall-clock
// duration. A query that runs for 20 seconds 10,000 times can matter more than a query that runs for 30
// minutes once."* Both of those are worth a reader's attention and only one of them is what an
// `ORDER BY total_ms` puts at the top.
//
// So the statement orders by time — something has to, to decide which forty shapes come back at all —
// and the ranking happens here, over those rows, on seven weighted features.
//
// # Three properties that are easy to drop and each of which breaks it
//
//   * **Every feature is capped at its 99th percentile within the window before combining** (line 547).
//     Without it one pathological shape sets the scale on whichever feature it is pathological in, and
//     every other shape's score on that feature collapses toward zero — so the ranking degrades into
//     "whatever the outlier is unusual about", which is the opposite of a composite.
//   * **The coefficients are versioned** (line 606), because they are a starting point the document
//     expects to be fitted from outcomes later, and a number compiled into a binary cannot be fitted.
//     `WEIGHTS_VERSION` travels on the analysis so a ranking recorded last month can be told from one
//     recorded under different weights rather than silently compared with it.
//   * **A missing feature contributes zero rather than an assumed value.** A shape that read no files
//     has no prune ratio, and treating an absent ratio as 0 would score it as though it pruned nothing —
//     which is the most alarming possible reading of a query that never touched a file.
//
// # What is not in the score, deliberately
//
// Failures. A shape that only ever fails has no measured time, so every feature here is zero and it
// ranks last — the single most actionable thing on the measured estate would be at the bottom of the
// page. Line 545 asks for the failure signal *"separately displayed rather than hidden in performance
// score"*, and separate means its own ordering over the same rows. See `byFailure`.

import type { QueryShapeRow } from '../collect/sql/shapes.js';

/**
 * The weights, and the version they are known by.
 *
 * The numbers are the advisor document's at line 594, unchanged. What is added here is the version,
 * because a coefficient set that cannot be named cannot be compared: two rankings a month apart under
 * different weights are two different questions, and a page that presented them as a trend would be
 * reporting the tuning as a change in the estate.
 *
 * Bumped when any weight changes. A new set is a new version even if the ordering it produces happens to
 * be the same on today's estate.
 */
export const WEIGHTS_VERSION = 'advisor-1';

export interface Weights {
  readonly duration: number;
  readonly volume: number;
  readonly frequency: number;
  readonly shuffleRatio: number;
  readonly spillRatio: number;
  readonly pruning: number;
  readonly skew: number;
}

export const WEIGHTS: Weights = {
  duration: 0.3,
  volume: 0.2,
  frequency: 0.15,
  shuffleRatio: 0.15,
  spillRatio: 0.1,
  pruning: 0.05,
  // Zero here and not in the document, which is the one departure and is worth naming. Its seventh term
  // is `max(skew, stats)`, and both of those come from the operator plan — `system.query.history` has no
  // per-task percentiles, no AQE annotations and no statistics freshness. The term is kept at its
  // document weight and fed nothing, so row 33b can supply it without the other six coefficients
  // shifting underneath the comparison. A version bump will say when that happens.
  skew: 0.05,
};

/** The seven features of one shape, each already on its own scale. */
interface Features {
  readonly duration: number;
  readonly volume: number;
  readonly frequency: number;
  readonly shuffleRatio: number;
  readonly spillRatio: number;
  readonly pruning: number;
  readonly skew: number;
}

/** A shape with its score, and the features the score was made of. */
export interface Ranked {
  readonly row: QueryShapeRow;
  readonly score: number;
  /**
   * The features after capping, normalised to 0–1.
   *
   * Kept because a score is not evidence. A reader told a shape scores 0.71 learns nothing; one told it
   * scores high on frequency and nothing else learns that the answer is caching rather than tuning.
   */
  readonly features: Features;
}

/**
 * Every shape, ranked, highest first.
 *
 * The caps are computed over the set passed in, which means the ranking is relative to the window and
 * to the rows the statement returned. That is the document's design and it has a consequence worth
 * stating: a score is not comparable across runs. Two shapes in one run are comparable; the same shape's
 * score this week and last week is not, because the 99th percentile it was scaled against moved.
 */
export function rank(rows: readonly QueryShapeRow[], weights: Weights = WEIGHTS): readonly Ranked[] {
  const featured = rows.map((row) => ({ row, raw: featuresOf(row) }));

  // One cap per feature, over this window's values. `log1p` is applied before capping on the three
  // unbounded features, so the cap is on the log scale the score uses rather than on the raw bytes —
  // capping bytes and then taking the log would compress everything below the cap into the top of the
  // range and undo what the log is for.
  const caps: Features = {
    duration: percentile(featured.map((one) => one.raw.duration)),
    volume: percentile(featured.map((one) => one.raw.volume)),
    frequency: percentile(featured.map((one) => one.raw.frequency)),
    shuffleRatio: percentile(featured.map((one) => one.raw.shuffleRatio)),
    spillRatio: percentile(featured.map((one) => one.raw.spillRatio)),
    pruning: percentile(featured.map((one) => one.raw.pruning)),
    skew: percentile(featured.map((one) => one.raw.skew)),
  };

  return featured
    .map(({ row, raw }) => {
      const features: Features = {
        duration: scaled(raw.duration, caps.duration),
        volume: scaled(raw.volume, caps.volume),
        frequency: scaled(raw.frequency, caps.frequency),
        shuffleRatio: scaled(raw.shuffleRatio, caps.shuffleRatio),
        spillRatio: scaled(raw.spillRatio, caps.spillRatio),
        pruning: scaled(raw.pruning, caps.pruning),
        skew: scaled(raw.skew, caps.skew),
      };
      return { row, features, score: combined(features, weights) };
    })
    // Tie-broken on the shape id rather than left to the sort's stability, so two runs over the same
    // rows produce the same order. A page whose rows swap places between refreshes reads as a page
    // whose numbers are unreliable.
    .sort((a, b) => b.score - a.score || a.row.shape.localeCompare(b.row.shape));
}

/**
 * The shapes that failed, worst rate first.
 *
 * Its own ordering over the same rows, for the reason at the top of this file. Shapes with no failures
 * are left out rather than sorted to the bottom: the answer to "what is failing" is a list of things
 * that are failing, and padding it with healthy shapes would make an estate with nothing wrong look the
 * same as one nobody had checked.
 *
 * Rate rather than count, then count as the tie-break. A shape failing 3 of 4 runs is a broken shape; one
 * failing 300 of 300,000 is a flaky one, and the first is what somebody should look at even though the
 * second has a hundred times the failures.
 */
export function byFailure(rows: readonly QueryShapeRow[]): readonly QueryShapeRow[] {
  return rows
    .filter((row) => row.failures > 0)
    .sort((a, b) => failureRate(b) - failureRate(a) || b.failures - a.failures || a.shape.localeCompare(b.shape));
}

/** What fraction of a shape's terminal runs did not finish. Zero where it never ran. */
export function failureRate(row: QueryShapeRow): number {
  return row.runsNow === 0 ? 0 : row.failures / row.runsNow;
}

/**
 * The raw features, before capping.
 *
 * Each `??` and each `nullif`-shaped guard here is a case the platform records as absent, and the
 * choice is always to contribute nothing rather than to assume. See the note at the top.
 */
function featuresOf(row: QueryShapeRow): Features {
  const volume = row.readBytes + row.shuffleBytes + row.spilledBytes;
  return {
    duration: Math.log1p(row.msNow),
    volume: Math.log1p(volume),
    frequency: Math.log1p(row.measuredNow),
    // Per byte read, which is what "more than a byte shuffled per byte read" means. Zero where nothing
    // was read: a shape that shuffled without reading is not a ratio, and the shuffle bytes are already
    // in `volume`.
    shuffleRatio: row.readBytes > 0 ? row.shuffleBytes / row.readBytes : 0,
    spillRatio: row.readBytes > 0 ? row.spilledBytes / row.readBytes : 0,
    // `1 - pruneRatio`, so poor pruning scores high. Absent where no files were read, and zero is the
    // right contribution for that: it is not that the shape pruned perfectly, it is that pruning is not
    // a fact about it.
    pruning: row.prunedPercent == null ? 0 : 1 - row.prunedPercent / 100,
    // Fed by nothing until row 33b. See the note on `WEIGHTS.skew`.
    skew: 0,
  };
}

function combined(features: Features, weights: Weights): number {
  return (
    weights.duration * features.duration +
    weights.volume * features.volume +
    weights.frequency * features.frequency +
    weights.shuffleRatio * features.shuffleRatio +
    weights.spillRatio * features.spillRatio +
    weights.pruning * features.pruning +
    weights.skew * features.skew
  );
}

/**
 * The 99th percentile of a set of values, by nearest rank.
 *
 * Nearest rank rather than interpolated, because interpolation between the top two values of a small set
 * is a number neither of them has — and at forty rows the 99th percentile *is* the largest value, which
 * is the honest answer for a window with too few shapes to have a tail.
 */
function percentile(values: readonly number[], at = 0.99): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(at * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

/**
 * One feature as a fraction of its cap, clamped.
 *
 * A cap of zero means no shape in the window had any of this feature, and the answer is zero rather than
 * a division. Values above the cap clamp to 1, which is the capping.
 */
function scaled(value: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.min(1, value / cap);
}
