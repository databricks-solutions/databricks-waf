// How long a requirement has been in the state it is in.
//
// "Failing" and "failing since March, through six runs" are different findings to somebody deciding
// what to work on next, and only the second one distinguishes a regression that arrived this week
// from a gap the estate has carried all year. The outcome is on the finding; the history is not,
// because it is a property of the runs around it rather than of the run it is in.
//
// The whole of the difficulty is where to stop. A streak is a claim that the same question was asked
// of the same estate and got the same answer, and every run back through the history is a chance
// that one of those stopped being true. So the walk stops at the first run this build cannot compare
// to the current one, using `comparable` rather than a rule of its own — the temptation was a
// narrower check over the summary's flat fields, and that check would have claimed a streak straight
// through the methodology change ADR 0043 refuses a comparison across.
//
// Where it stopped is reported, because the four reasons mean different things and a bare "3 runs"
// hides which one applies. A streak of three that began with the estate's first ever run is a
// complete history; a streak of three that hit a catalogue change is three runs of an unknown
// longer story. Reporting them the same way would let the second read as the first.

import { NO_CHANGELOG, spanBetween, type CatalogueChangelog, type CatalogueSpan } from '../catalogue/changelog.js';
import { comparable, stampEnough } from './scan.js';
import type { Scan } from './scan.js';
import type { ScanSummary } from './store.js';
import type { Outcome } from '../resolve/finding.js';

/** Why the history stops where it does. */
export type Horizon =
  /** It does not: the walk reached the estate's first recorded run. */
  | 'first-run'
  /** The outcome before the streak is known, so the streak genuinely began there. */
  | 'changed'
  /** The next run back cannot be compared to this one. */
  | 'not-comparable'
  /** The next run back predates this build recording per-requirement outcomes. */
  | 'unrecorded'
  /** A catalogue release moved what this requirement asks, so an earlier answer answered something else. */
  | 'redefined'
  /** A catalogue release introduced this requirement, so the streak is its whole life. */
  | 'introduced'
  /** The walk reached the end of the runs it was given, which retention or a page size decides. */
  | 'retention';

export interface Occurrence {
  /** How many consecutive runs, this one included, reached the same outcome. Always at least 1. */
  readonly runs: number;
  /** When the earliest run in that streak finished. */
  readonly since: Date;
  /** Why the walk stopped, which is what says whether the streak is the whole story. */
  readonly horizon: Horizon;
  /**
   * The outcome immediately before the streak, and the run it was last seen in.
   *
   * Present only at `horizon: 'changed'`. At every other horizon there is a run before this one and
   * this build cannot say what it found, which is not the same as there being nothing before it.
   */
  readonly changedFrom?: { readonly outcome: Outcome; readonly at: Date };
}

/**
 * How long this requirement has held its outcome, over the runs given.
 *
 * `history` is newest-first, as every store returns it, and is expected to start with the run the
 * finding came from — that run is the streak's first member and its stamp is what the rest are
 * compared against. A history that does not start there, or that holds no per-requirement outcomes
 * at all, produces a streak of one at the honest horizon rather than nothing: a reader is told this
 * is the only run this build can speak for, which is true and useful, where an absent history reads
 * as a feature that failed to load.
 */
export function occurrenceOf(
  controlId: string,
  scan: Scan,
  history: readonly ScanSummary[],
  changelog: CatalogueChangelog = NO_CHANGELOG
): Occurrence {
  return occurrenceAcross(controlId, scan, crossings(scan, history, changelog), history.length);
}

/**
 * One earlier run, and what separates it from the run in hand.
 *
 * Precomputed for the whole scan rather than per requirement, because both halves are properties of
 * the pair of runs: `occurrencesIn` would otherwise recompose the same catalogue span a hundred and
 * eighty-four times per earlier run.
 */
interface Crossing {
  readonly summary: ScanSummary;
  /**
   * Whether the stored stamp holds enough to be compared at all.
   *
   * Kept apart from `ok` because the two mean opposite things to a reader. A run this build cannot
   * read is one it cannot speak for; a run it read and found incomparable is one it can say asked a
   * different question. Collapsing them would report a damaged record as a methodology change.
   */
  readonly readable: boolean;
  /** Whether these two runs can be compared, which is `comparable`'s answer and not a rule here. */
  readonly ok: boolean;
  /** What the catalogue did between them, when that can be established. */
  readonly span?: CatalogueSpan;
}

function crossings(scan: Scan, history: readonly ScanSummary[], changelog: CatalogueChangelog): readonly Crossing[] {
  return before(scan.id, history).map((summary) => {
    if (!stampEnough(summary.stamp)) return { summary, readable: false, ok: false };
    const span = spanBetween(changelog, summary.stamp.catalogueVersion, scan.stamp.catalogueVersion);
    return { summary, readable: true, ok: comparable(scan.stamp, summary.stamp, span).ok, span };
  });
}

function occurrenceAcross(controlId: string, scan: Scan, walk: readonly Crossing[], given: number): Occurrence {
  const outcome = scan.findings.find((finding) => finding.controlId === controlId)?.outcome;
  if (outcome == null) return { runs: 1, since: scan.finishedAt, horizon: 'retention' };

  let runs = 1;
  let since = scan.finishedAt;

  for (const { summary, readable, ok, span } of walk) {
    if (summary.outcomes == null || !readable) return { runs, since, horizon: 'unrecorded' };
    if (!ok) return { runs, since, horizon: 'not-comparable' };

    // A catalogue release the two runs straddle is a reason to stop for *this* requirement only if it
    // touched this requirement. Stopping for all of them was the earlier rule, and it gave back with
    // one hand what the changelog took with the other: the whole point of recording a release is that
    // most of two catalogues is the same catalogue, so a requirement the release left alone was asked
    // identically either side of it and its streak runs straight through.
    if (span != null) {
      if (span.changed.some((one) => one.id === controlId)) return { runs, since, horizon: 'redefined' };
      if (span.added.includes(controlId)) return { runs, since, horizon: 'introduced' };
    }

    // Under the number that run used it, since a renumbering is not a break in the requirement's
    // history — it is the same question with a different label, which is exactly what `continues`
    // declares and what the reader holding last quarter's pack is looking for.
    const then = summary.outcomes[asItWas(controlId, span)];
    if (then !== outcome) {
      // A requirement the earlier run did not hold at all is a change of question rather than a
      // change of outcome, and saying "it used to be absent" invites the reading that the estate
      // lost something. The streak ends and the horizon says only that this build cannot see past it.
      if (then == null) return { runs, since, horizon: 'unrecorded' };
      return { runs, since, horizon: 'changed', changedFrom: { outcome: then, at: summary.finishedAt } };
    }

    runs += 1;
    since = summary.finishedAt;
  }

  return { runs, since, horizon: horizonAtEnd(walk, given) };
}

/** The id an earlier run knew this requirement by, following any renumbering the span records. */
function asItWas(controlId: string, span: CatalogueSpan | undefined): string {
  if (span == null) return controlId;
  for (const [from, to] of span.renamed) if (to === controlId) return from;
  return controlId;
}

/**
 * The summaries older than the run in hand, newest first.
 *
 * A history that does not name the run is treated as entirely older than it, which is what a
 * just-finished scan looks like before it is written.
 */
function before(id: string, history: readonly ScanSummary[]): readonly ScanSummary[] {
  const at = history.findIndex((summary) => summary.id === id);
  return at < 0 ? history : history.slice(at + 1);
}

/**
 * Whether running out of summaries means the estate has no earlier run, or only that nobody asked
 * for one.
 *
 * The distinction rests on the caller having asked for the whole history rather than a page of it,
 * which it cannot know from here — so the honest reading of a full-looking list is `retention`, and
 * `first-run` is claimed only when the walk consumed everything it was given and the caller gave it
 * something. A page boundary presented as the beginning of the estate's record would turn "we have
 * only ever seen this fail" into a statement about the estate rather than about the page.
 */
function horizonAtEnd(walked: readonly Crossing[], given: number): Horizon {
  return walked.length === 0 && given <= 1 ? 'first-run' : 'retention';
}

/** Every requirement in the run, so a page showing a list does not walk the history once per row. */
export function occurrencesIn(
  scan: Scan,
  history: readonly ScanSummary[],
  changelog: CatalogueChangelog = NO_CHANGELOG
): ReadonlyMap<string, Occurrence> {
  const walk = crossings(scan, history, changelog);
  const occurrences = new Map<string, Occurrence>();
  for (const finding of scan.findings) {
    occurrences.set(finding.controlId, occurrenceAcross(finding.controlId, scan, walk, history.length));
  }
  return occurrences;
}
