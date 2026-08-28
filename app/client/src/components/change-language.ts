// What moved since the last run, in words.
//
// Separated from the component that renders it because every sentence here is a claim about the
// customer's platform, and the ones that are hardest to get right are the ones about what the
// comparison does *not* establish: that a carried-forward pillar was not observed, that part of a
// movement is the catalogue changing rather than the estate, that a permitted comparison still
// carries a qualification. Each of those is a sentence that reads as reassurance if it is dropped,
// which is the failure mode a component test would not notice.

import { estateCoverage } from './coverage';
import type { ControlChange, RunChanges, Scan, ScanSummary } from '../api/types';

/**
 * The comparison as sentences, or the reason there isn't one.
 *
 * Refuses rather than approximates. Two runs measured by different identities differ in the
 * observer, and reporting that difference as change in the estate is the single easiest lie for a
 * history feature to tell. A difference of catalogue is no longer in that class — what changed
 * between two versions is recorded, so the comparison is drawn, split, and qualified.
 */
export function summariseChanges(
  // Narrowed to the fields these sentences are drawn from, so what the page claims can be tested
  // against the numbers that decide it rather than against a whole run.
  scan: Pick<Scan, 'score'>,
  changes: RunChanges | undefined,
  previous: Pick<ScanSummary, 'counts'> | undefined,
): readonly string[] {
  if (previous == null) {
    return ['This is the first recorded run, so there is nothing to compare it against yet.'];
  }

  if (changes != null && !changes.comparable) {
    return [
      changes.reason ??
        'The previous run was measured differently, so a difference between the two would not be a difference in the estate.',
    ];
  }

  const lines: string[] = [];

  // Coverage change leads, ahead of score change. On an estate at a quarter coverage, moving from
  // 18% to 24% assessed is the real progress and a score that moved 2 points is mostly a
  // consequence of it.
  const coverageNow = estateCoverage(scan.score);
  const coverageThen = coverageOfSummary(previous);
  if (coverageThen != null && Math.abs(coverageNow.percent - coverageThen) >= 0.5) {
    const direction = coverageNow.percent > coverageThen ? 'increased' : 'fell';
    lines.push(
      `Coverage ${direction} from ${String(Math.round(coverageThen))}% to ${String(Math.round(coverageNow.percent))}% of applicable requirements.`,
    );
    /*
     * And, on a fall, what the app could not read this time.
     *
     * Two runs minutes apart against an unchanged estate reported 38% and then 29%, and the sentence
     * above was the whole account of it. A reader has one way to take that: their platform got worse.
     * The cause was a collector that did not answer — a warehouse waking, a permission, an API refusing
     * — and the app knew, because every requirement it could not read carries the reason. Saying the
     * fall and withholding the readings behind it is the app inviting the wrong conclusion.
     *
     * "Some of that fall", not all of it: this run's unreadable count does not establish how many the
     * previous run could read, and a coverage fall can be both things at once.
     */
    const unread = unreadable(scan.score);
    if (direction === 'fell' && unread > 0) {
      lines.push(
        `${String(unread)} ${unread === 1 ? 'requirement' : 'requirements'} could not be read on this run, so some ` +
          'of that fall is what the app could reach rather than what the estate did.',
      );
    }
  } else {
    lines.push('Coverage is unchanged: the same requirements could be answered as last time.');
  }

  if (changes == null) return lines;

  lines.push(outcomes(changes));

  if (changes.overallDelta != null && Math.abs(changes.overallDelta) >= 0.05) {
    lines.push(movement(changes.overallDelta, changes.attribution));
  } else {
    lines.push('No posture change.');
  }

  // Last, because it qualifies the sentences above rather than replacing them. A comparison this run
  // was permitted to draw and a reader has to hold loosely is a different thing from a refusal, and
  // putting the qualification first would read as one.
  if (changes.caveat != null) lines.push(changes.caveat);

  return lines;
}

/**
 * Which of the four the brief's differential strip names a transition is.
 *
 * `absent` is tested first and it is the ordering that matters. A requirement with no outcome in
 * the earlier run cannot have regressed — nothing measured it to regress from — and counting a
 * newly asked failing requirement as a regression is the estate being blamed for the catalogue
 * gaining a question. That is the same distinction `changes.ts` draws server-side between a change
 * in the estate and a change in what was asked, kept here so both surfaces draw it the same way.
 */
export type ChangeClass = 'new' | 'regressed' | 'resolved' | 'changed';

export function classOf(change: Pick<ControlChange, 'from' | 'to'>): ChangeClass {
  if (change.from === 'absent') return 'new';
  // Withdrawn, and 'changed' rather than a fifth class: the strip names four, and a requirement the
  // catalogue dropped is not a movement in the estate either.
  if (change.to === 'absent') return 'changed';
  if (isUnmet(change.to) && !isUnmet(change.from)) return 'regressed';
  if (isUnmet(change.from) && !isUnmet(change.to)) return 'resolved';
  return 'changed';
}

export function countChanges(changes: readonly ControlChange[]): Readonly<Record<ChangeClass, number>> {
  const counted: Record<ChangeClass, number> = { new: 0, regressed: 0, resolved: 0, changed: 0 };
  for (const change of changes) counted[classOf(change)] += 1;
  return counted;
}

/** How many requirements moved, and in which direction. */
function outcomes(changes: RunChanges): string {
  const counted = countChanges(changes.changes);

  if (changes.changes.length === 0) {
    return changes.unobserved.length > 0
      ? 'No requirement changed outcome. Pillars this run carried forward were not observed, so that is not evidence they held.'
      : 'No requirement changed outcome since the previous run.';
  }

  return (
    [
      counted.regressed > 0 ? `${String(counted.regressed)} newly unmet` : undefined,
      counted.resolved > 0 ? `${String(counted.resolved)} resolved` : undefined,
      counted.new > 0 ? `${String(counted.new)} with no outcome in the previous run` : undefined,
      counted.changed > 0 ? `${String(counted.changed)} otherwise changed` : undefined,
    ]
      .filter((part): part is string => part != null)
      .join(', ') + '.'
  );
}

/**
 * The score movement, split when part of it is the catalogue rather than the estate.
 *
 * A single figure across a catalogue update tells the reader their platform got worse when what
 * happened is that we added two requirements. The split is only shown when there is one: a
 * comparison within a version is all estate, and printing "none of it is the catalogue" every time
 * teaches the reader to skip the line on the month it isn't.
 */
function movement(delta: number, attribution: RunChanges['attribution']): string {
  const moved = `Measured posture moved ${signed(delta)} points`;
  if (attribution == null) return `${moved}.`;

  // The server derives the catalogue half by subtracting the estate half from the total, precisely
  // so the two add up to the figure the reader sees. Rounding all three independently for display
  // gives that away again — +0.45 and +0.55 inside a +1.0 total print as +0.5 and +0.6 — so the
  // displayed catalogue half is derived from the displayed estate half, the same way round.
  const estate = round(attribution.estate);
  const catalogue = round(delta) - estate;

  return (
    `${moved}: ${signed(estate)} from the estate, measured over the ` +
    `${String(attribution.stable)} requirements both runs asked in the same terms, and ` +
    `${signed(catalogue)} from the requirements themselves changing.`
  );
}

/** One decimal, as scores are shown. Kept off the floating-point tail so `-0` cannot be printed. */
function round(value: number): number {
  return Math.round(value * 10) / 10 + 0;
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
}

function isUnmet(presence: string): boolean {
  return presence === 'fail' || presence === 'partial';
}

/**
 * How many requirements this run could not read, across every pillar.
 *
 * The estate score keeps outcome counts and no breakdown of why the unmeasurable ones went
 * unmeasured; the pillars keep the breakdown. So the total is summed from them, the same way the
 * coverage hero and the evidence gaps do it.
 */
function unreadable(score: Scan['score']): number {
  return score.pillars.reduce((sum, pillar) => sum + (pillar.unmeasuredBy?.unreadable ?? 0), 0);
}

/** A summary carries counts rather than a coverage figure, so it is derived the same way here. */
function coverageOfSummary(summary: Pick<ScanSummary, 'counts'>): number | undefined {
  const { counts } = summary;
  const total = counts.pass + counts.fail + counts.partial + counts.unmeasurable + counts.notApplicable;
  const applicable = total - counts.notApplicable;
  if (applicable <= 0) return undefined;
  return ((counts.pass + counts.fail + counts.partial) / applicable) * 100;
}
