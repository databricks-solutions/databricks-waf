// Holding a pillar score against what the customer said they would reach.
//
// # Why this reports a gap and never a miss
//
// A target here is the customer's own commitment — this build has no benchmark and cannot have one,
// because "is 78 good" has no answer from this data. That decides how a passed date has to read.
//
// The obvious design puts a red badge against a target whose date has gone by with the score still
// short. It is also the design that stops the feature being used: the only person who can set a target
// is the person the badge would be shown to, and a tool that turns their own stated intention into an
// accusation teaches them not to state one. What is left is a worse product — no targets, so no
// programme surface at all — reached by way of a feature that looked rigorous.
//
// So a passed date changes the *tense* and the arithmetic, not the verdict. `72 against a target of 80
// by 30 September, a gap of 8 points` is the same information a red badge carries, minus the judgement
// about whose fault it is, and it is the sentence somebody can take into a steering meeting. Nothing
// here says "missed", "overdue" or "failed".
//
// # Why there are five standings and not three
//
// The three obvious ones are met, short of it, and short of it with the date gone. The other two exist
// because a target can have nothing to be held against, and the two ways that happens need different
// remedies:
//
//   - `not-scored` — the pillar was in the run and produced no score, because everything in it was
//     unmeasurable or not applicable. The remedy is grants or evidence.
//   - `not-assessed` — the run did not cover the pillar at all. The remedy is the assessment's own
//     pillar list, or a run of the version that carries the target.
//
// Collapsing either into "short by 80" would be the worst available answer: it reports a gap that was
// never measured, against a commitment the customer may well be keeping. `resolveScope` draws the same
// distinction between a workspace that is absent and one the observer cannot see, for the same reason.

import type { PillarTarget } from '../define/definition.js';

/**
 * How a commitment stands. See the header for why there are five.
 *
 * `gap` is the one with a date in it — short, with the date behind us — and it is named for what the
 * surface reports rather than for what happened to the schedule.
 */
export type TargetStanding = 'met' | 'short' | 'gap' | 'not-scored' | 'not-assessed';

/**
 * Enough of a scored pillar to hold a target against.
 *
 * Structural rather than `PillarScore` from `score.ts`, so this module does not need the scoring
 * vocabulary — counts, composition, worst-first findings — to answer a question about one number.
 * Presence in the list means the run covered the pillar; an absent `score` means it covered it and
 * could not score it, which is the distinction the two absent standings rest on.
 */
export interface ScoredPillar {
  readonly pillarId: string;
  readonly score?: number;
}

export interface TargetReading {
  readonly pillar: string;
  /** The commitment, repeated here so a surface need not join back to the definition to say it. */
  readonly atLeast: number;
  readonly by: Date;
  readonly standing: TargetStanding;
  /** Whether the date has passed. Carried rather than derived, so a client cannot disagree about it. */
  readonly due: boolean;
  /** What the pillar scores now. Absent for both of the standings that had nothing to compare. */
  readonly score?: number;
  /** How many points short, when it is short. Never present alongside an absent score. */
  readonly shortBy?: number;
  /** Whole days until the date, when it has not passed. */
  readonly daysLeft?: number;
  /** The whole reading as one sentence, so every surface says it the same way. */
  readonly sentence: string;
}

const DAY = 86_400_000;

/**
 * Each target, held against the run that has just been read.
 *
 * In the definition's own order, which `normaliseTargets` has already sorted by pillar. Ordering by
 * urgency was the alternative and it is a worse default: the list is short, and a list that reorders
 * itself between runs is one a reader has to search rather than scan.
 */
export function readTargets(
  targets: readonly PillarTarget[],
  pillars: readonly ScoredPillar[],
  now: Date
): readonly TargetReading[] {
  const scored = new Map(pillars.map((pillar) => [pillar.pillarId, pillar]));
  return targets.map((target) => reading(target, scored.get(target.pillar), now));
}

function reading(target: PillarTarget, pillar: ScoredPillar | undefined, now: Date): TargetReading {
  const due = target.by.getTime() <= now.getTime();
  const by = dayNamed(target.by);
  const common = { pillar: target.pillar, atLeast: target.atLeast, by: target.by, due };

  if (pillar == null) {
    return {
      ...common,
      standing: 'not-assessed',
      sentence:
        `Not covered by this run, so a target of ${String(target.atLeast)} by ${by} has not been ` +
        'reported against.',
    };
  }

  if (pillar.score == null) {
    return {
      ...common,
      standing: 'not-scored',
      sentence:
        'Nothing here could be scored in this run, so there is no number to hold the target of ' +
        `${String(target.atLeast)} by ${by} against.`,
    };
  }

  // Rounded to the place the score is reported to, and rounded *before* it is subtracted.
  //
  // A live run put "0.7999999999999972 points short" in front of a customer: the score was 79.2, the
  // target 80, and binary floating point does not hold either exactly. Rounding the sentence alone
  // would not have been enough, because `shortBy` is in the payload too and anything reading it would
  // have inherited the same digits.
  const score = round(pillar.score);
  // Whole days, rounded up, so the last day of a target reads as "1 day to the date" until it passes
  // rather than as "0 days" for the twenty-four hours somebody could still act in.
  const daysLeft = due ? undefined : Math.ceil((target.by.getTime() - now.getTime()) / DAY);

  if (score >= target.atLeast) {
    return {
      ...common,
      standing: 'met',
      score,
      ...(daysLeft != null ? { daysLeft } : {}),
      // The date is said either way. A met target whose date has not arrived can still be lost, and a
      // sentence that dropped the date would read as final when it is not.
      sentence:
        `${String(score)} against a target of ${String(target.atLeast)} by ${by}, which it meets` +
        (daysLeft == null ? '.' : ` with ${days(daysLeft)} to the date.`),
    };
  }

  const shortBy = round(target.atLeast - score);
  if (due) {
    return {
      ...common,
      standing: 'gap',
      score,
      shortBy,
      sentence: `${String(score)} against a target of ${String(target.atLeast)} by ${by}, a gap of ${points(shortBy)}.`,
    };
  }

  return {
    ...common,
    standing: 'short',
    score,
    shortBy,
    ...(daysLeft != null ? { daysLeft } : {}),
    sentence:
      `${String(score)} against a target of ${String(target.atLeast)} by ${by}, ` +
      `${points(shortBy)} short with ${days(daysLeft ?? 0)} to the date.`,
  };
}

function days(count: number): string {
  return `${String(count)} day${count === 1 ? '' : 's'}`;
}

/**
 * A number to the one decimal place a pillar score is reported to.
 *
 * `Number(x.toFixed(1))` rather than `x.toFixed(1)`, so what leaves here is a number: the payload
 * carries `score` and `shortBy` as numbers, and a string that looks like one would be a different
 * shape for the same field depending on which branch produced it.
 */
function round(value: number): number {
  return Number(value.toFixed(1));
}

/**
 * A count of points, singular only when it is exactly one.
 *
 * A gap is fractional, so "0.8 points" and "1.5 points" are both plural and only "1 point" is not.
 */
function points(count: number): string {
  return `${String(count)} point${count === 1 ? '' : 's'}`;
}

/**
 * A date in a sentence a person reads, rather than the timestamp it is stored as.
 *
 * UTC for the reason `risk.ts` gives for the identical helper there: the stored date is a day, and
 * rendering it in the server's zone would name the day before or after it depending on where the app
 * happens to be deployed. Not shared with that one, because the day two modules of this app agree on
 * how to print a date is the day somebody moves the printer and changes a sentence they were not
 * reading — and these two sentences are read by different people for different reasons.
 */
function dayNamed(when: Date): string {
  return when.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}
