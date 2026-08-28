// Where a decision stands, once the estate has had its say.
//
// A decision is a statement made on a date, and a run is a measurement made on a later one. Most
// of what is worth knowing about a decision comes from putting the two together, which is why this
// is a function of both rather than a field on the record: nothing is written when a run
// contradicts a claim, because the run already says it.
//
// The case this exists for is `fixed`. Somebody reads a finding, changes the estate, and records
// that they fixed it. The next run either agrees or it does not, and a claim the estate contradicts
// is the single most useful line in the assessment — more useful than the original finding, because
// it says the fix was attempted and did not take. Discovering that months later, from a spreadsheet,
// is how a remediation programme loses a quarter.
//
// The other three matter for a duller reason: a queue that never forgets is a queue nobody uses.
// An accepted or deferred finding drops out of "where to start" until its date, and comes back when
// the date passes — which is the whole point of having taken the decision in the first place.

import type { Finding, Outcome } from '../resolve/finding.js';
import { DAY_MS, DUE_WINDOW_DAYS } from '../attest/attestation.js';
import type { Decision } from './decision.js';

/**
 * The eight states a decision can be in, which are eight different things to say to the reader.
 *
 * Deliberately more states than there are dispositions. The disposition is what somebody chose;
 * this is what has become of that choice, and the difference between them is where every useful
 * sentence on the decisions page comes from.
 */
export type Standing =
  /** Accepted or deferred, and its date is comfortably ahead. Off the queue, quietly. */
  | 'current'
  /** Its date is close. Off the queue, but worth raising before it lapses rather than after. */
  | 'due'
  /** Its date has passed. Back on the queue, and the reader is owed the fact that it was parked. */
  | 'lapsed'
  /** A fix was claimed and no run has measured the requirement since. Nothing agrees or disagrees yet. */
  | 'unverified'
  /** A fix was claimed and the run since agrees. The best outcome this app can report. */
  | 'confirmed'
  /** A fix was claimed and the run since still finds it unmet. The loudest line on the page. */
  | 'contradicted'
  /** Parked, but the estate now meets the requirement anyway, so there is nothing left to park. */
  | 'settled'
  /** Withdrawn deliberately. Kept because who un-parked something, and why, is part of the record. */
  | 'withdrawn';

export interface Standings {
  readonly decision: Decision;
  readonly standing: Standing;
  /** The finding the standing was judged against, when a run has one. */
  readonly outcome?: Outcome;
}

export interface StandingContext {
  /** The finding for this requirement in the run being read, if it has one. */
  readonly finding?: Pick<Finding, 'outcome'>;
  /** When that run finished. A run that predates the decision cannot speak to it. */
  readonly measuredAt?: Date;
  readonly now?: Date;
}

/** Outcomes that mean the requirement is not currently a problem. */
function met(outcome: Outcome): boolean {
  return outcome === 'pass' || outcome === 'satisfied-by-architecture' || outcome === 'not-applicable';
}

function unmet(outcome: Outcome): boolean {
  return outcome === 'fail' || outcome === 'partial';
}

export function standingOf(decision: Decision, context: StandingContext = {}): Standing {
  const now = context.now ?? new Date();
  const outcome = context.finding?.outcome;
  // A run that finished before the decision was recorded is evidence about the estate as it was
  // when the decision was taken, not about whether the decision held. Treating it as verification
  // would confirm a fix claim with the very measurement that prompted it.
  const since = context.measuredAt != null && context.measuredAt.getTime() > decision.decidedAt.getTime();

  if (decision.disposition === 'reopened') return 'withdrawn';

  if (decision.disposition === 'fixed') {
    if (outcome == null || !since) return 'unverified';
    if (unmet(outcome)) return 'contradicted';
    // An `unmeasurable` outcome is not a confirmation. A run that could not read the setting has
    // not agreed with the claim, and reporting it as confirmed would let a fix be verified by the
    // app losing a permission.
    return met(outcome) ? 'confirmed' : 'unverified';
  }

  if (outcome != null && since && met(outcome)) return 'settled';

  const remaining = (decision.until?.getTime() ?? now.getTime()) - now.getTime();
  if (remaining <= 0) return 'lapsed';
  return remaining <= DUE_WINDOW_DAYS * DAY_MS ? 'due' : 'current';
}

/**
 * Whether the finding may drop out of the work queue.
 *
 * `unverified` counts as parked, which is a judgement worth stating: the requirement is still
 * measured as failing, so hiding it is hiding a failure on somebody's unchecked word. It is parked
 * anyway because the alternative — a queue that keeps demanding work that has just been done —
 * teaches the reader that the queue is not listening, and because the run that follows will say
 * `contradicted` far more loudly than leaving the row in place ever would. The count of parked
 * findings is shown wherever the queue is, so nothing disappears silently.
 */
export function parked(standing: Standing): boolean {
  return standing === 'current' || standing === 'due' || standing === 'unverified';
}

/**
 * Whether the reader is owed a prompt about this one.
 *
 * `contradicted` first, because a fix that did not take is the thing most likely to be news.
 */
export function needsAttention(standing: Standing): boolean {
  return standing === 'contradicted' || standing === 'lapsed' || standing === 'due';
}

/** The decisions that still bear on a run, judged against it, with the withdrawn ones dropped. */
export function standingsFor(
  decisions: readonly Decision[],
  context: { readonly findings?: readonly Finding[]; readonly measuredAt?: Date; readonly now?: Date } = {}
): readonly Standings[] {
  const byControl = new Map((context.findings ?? []).map((finding) => [finding.controlId, finding]));

  return decisions.map((decision) => {
    const finding = byControl.get(decision.controlId);
    const standing = standingOf(decision, {
      ...(finding != null ? { finding } : {}),
      ...(context.measuredAt != null ? { measuredAt: context.measuredAt } : {}),
      ...(context.now != null ? { now: context.now } : {}),
    });
    return {
      decision,
      standing,
      ...(finding != null ? { outcome: finding.outcome } : {}),
    };
  });
}
