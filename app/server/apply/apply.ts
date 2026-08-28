// Applying applicability decisions to a scan's findings, before the findings are scored.
//
// This is the pure half of the propagation: findings in, findings out, with an exposure beside them. It
// runs at scan time (31g), not on read, because the score is computed once when a scan finishes and kept
// — so a decision recorded between scans takes effect on the next run, and the lapse below is judged
// against that run's fresh reading rather than a stale one.
//
// A decision in force rewrites its requirement's finding:
//
//   - **not-applicable** → outcome `not-applicable`. Leaves the weighted average (CREDIT maps it to
//     null) and does not widen the range, because a requirement that does not apply is not a gap in
//     knowledge.
//   - **disabled** → outcome `unmeasurable`, carrying the `disabled` kind 31c added so the reason reads
//     as a decision rather than a source the app could not read. Leaves the average too, and *does*
//     widen the range, because a check switched off is a thing that could have been measured. That the
//     two levers differ here and not in the figure is what 31c measured.
//
// **The lapse is decided here.** A decision that is date-effective but sits over a `fail` or `partial`
// reading is set aside: the finding is left exactly as it reads and the decision is returned as lapsed
// rather than applied. The write refused those readings (31b/31e), but a scan run after the decision was
// recorded can turn a pass into a failure, and a decision that went on removing a now-failing
// requirement would be a score held down by a measurement that has regressed. So the reading is checked
// again on every scan, which is the whole reason the lapse is derived rather than stored.
//
// The exposure is built from the decisions, not from the findings' pillar counts. 31c measured why: an
// alias group gives every pillar expressing a requirement the group's worst outcome, so a disable in one
// pillar turns a passing sibling in another pillar unmeasurable while that pillar's own counts show
// nothing removed. A reader owed "what was taken out of your score" cannot be answered from counts that
// cannot see the removal, so the removed list is the record of it.

import {
  effective,
  newestFirst,
  standingOf,
  REFUSED_READINGS,
  type ApplicabilityDecision,
  type ApplicabilityLever,
} from './applicability.js';
import type { Finding, Outcome } from '../resolve/finding.js';

/** One requirement taken out of the score, with who owns the decision and why. */
export interface Exclusion {
  readonly controlId: string;
  readonly lever: ApplicabilityLever;
  readonly owner: string;
  readonly reason: string;
  readonly decisionId: string;
}

/** A decision set aside because the reading turned against it, so it did not move the score. */
export interface Lapse {
  readonly controlId: string;
  readonly lever: ApplicabilityLever;
  /** The reading that set it aside: `fail` or `partial`. */
  readonly reading: Outcome;
  readonly decisionId: string;
}

/**
 * What a scan took out of its score, and what it declined to.
 *
 * Carried on the score (31g) so every surface that shows a number can show what was removed from it,
 * and built from the decisions rather than from pillar counts because 31c measured that an alias-group
 * removal is invisible to the untouched pillar's counts. Present on a score only when it is not empty:
 * a scan with no decisions in force has no exposure, not an empty one, so a score from an install with
 * no applicability path is unchanged.
 */
export interface Exposure {
  /** What was taken out of the score, newest decision per requirement. */
  readonly excluded: readonly Exclusion[];
  /** What would have been taken out but for a reading that turned against it. */
  readonly lapsed: readonly Lapse[];
  /**
   * How many pillars had a score before these decisions and have none after, so are not in the estate
   * mean. A count and nothing more: which pillars they are is not carried, because the sentence built on
   * this may not name one.
   *
   * Absent on a scan recorded by a build before this was computed, which reads as none — the same
   * convention the rest of the exposure uses for a run that predates it. Computed by the scan layer,
   * because it takes scoring the findings twice and `apply` does not score.
   */
  readonly pillarsEmptied?: number;
}

export interface Applied {
  /** The findings as they should be scored, with excluded requirements rewritten. */
  readonly findings: readonly Finding[];
  /** What was taken out of the score, so a reader can be shown it. Newest decision per requirement. */
  readonly excluded: readonly Exclusion[];
  /** What would have been taken out but for a reading that turned against it. */
  readonly lapsed: readonly Lapse[];
}

/**
 * The exposure half of an {@link Applied}, for carrying onto a score. Empty means omit it.
 *
 * `pillarsEmptied` is passed in rather than derived: it is the difference between two scorings, which is
 * the caller's to compute. Omitted when zero, so the field is present exactly when there is something to
 * say.
 */
export function exposureOf(applied: Applied, pillarsEmptied = 0): Exposure | undefined {
  if (applied.excluded.length === 0 && applied.lapsed.length === 0) return undefined;
  return {
    excluded: applied.excluded,
    lapsed: applied.lapsed,
    ...(pillarsEmptied > 0 ? { pillarsEmptied } : {}),
  };
}

/**
 * A scan's findings with the decisions in force applied, and the exposure beside them.
 *
 * `decisionsFor` returns every decision recorded against a requirement, newest first — the store's
 * `for`. The one in force by its dates is found here rather than passed in, because whether it applies
 * or lapses is a function of this run's reading, which only this pass holds.
 */
export function applyDecisions(
  findings: readonly Finding[],
  decisionsFor: (controlId: string) => readonly ApplicabilityDecision[],
  now: Date
): Applied {
  const excluded: Exclusion[] = [];
  const lapsed: Lapse[] = [];

  const applied = findings.map((finding) => {
    const decision = inForceByDate(decisionsFor(finding.controlId), now);
    if (decision == null) return finding;

    // The reading turned against a decision that is otherwise in force: set it aside, leave the finding
    // as it reads, and record the lapse rather than the exclusion.
    if (REFUSED_READINGS.includes(finding.outcome)) {
      lapsed.push({
        controlId: finding.controlId,
        lever: decision.lever,
        reading: finding.outcome,
        decisionId: decision.id,
      });
      return finding;
    }

    excluded.push({
      controlId: finding.controlId,
      lever: decision.lever,
      owner: decision.owner,
      reason: decision.reason,
      decisionId: decision.id,
    });
    return rewrite(finding, decision);
  });

  return { findings: applied, excluded, lapsed };
}

/**
 * The finding as the lever makes it read.
 *
 * `not-applicable` and `disabled` both leave the denominator; the kind is what keeps them apart on the
 * surfaces that show them, and is why a disabled check is `unmeasurable` with a reason rather than a
 * fourth outcome. Coverage and its provenance are left as measured: what the estate showed has not
 * changed, only whether the customer is being scored on it.
 *
 * The `not-applicable` rewrite carries the decision's reason into `outcomeReason`, which the report and
 * the export show verbatim for that outcome — so a smaller denominator reads as an explained decision
 * rather than a requirement the tool skipped. The `disabled` rewrite has no such field on `unmeasurable`
 * and does not need one: the `disabled` kind is the explanation, and the attribution is in the exposure.
 */
function rewrite(finding: Finding, decision: ApplicabilityDecision): Finding {
  if (decision.lever === 'not-applicable') {
    return { ...finding, outcome: 'not-applicable', outcomeReason: decision.reason };
  }
  return { ...finding, outcome: 'unmeasurable', unmeasured: 'disabled' };
}

/**
 * The decision in force by its dates alone — active or expiring, not pending, expired, revoked or
 * superseded — ignoring the reading, because the reading decides apply-versus-lapse and is checked by
 * the caller against the finding it holds.
 *
 * Newest first from the store, and `applicabilityFrom` refuses a second effective decision, so in
 * practice this finds the only one. Superseding is a fact about the set, handled by taking the newest
 * that is effective: an older one a newer replaced is not returned.
 */
function inForceByDate(decisions: readonly ApplicabilityDecision[], now: Date): ApplicabilityDecision | undefined {
  return newestFirst(decisions).find((decision) => effective(standingOf(decision, { now })));
}
