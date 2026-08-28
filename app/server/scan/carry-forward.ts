// Reruns of one pillar, without losing the other six.
//
// A targeted rerun is the obvious feature and the easy way to get it badly wrong. Running
// a scan for one pillar and saving the result would replace the latest scan with one that
// answers a seventh of the questions, and the overview would read as an estate that had
// lost most of its assessment overnight. That is worse than not offering reruns at all.
//
// So a targeted run measures what it was asked for and carries the rest forward from the
// previous scan — but only when the two runs are comparable in the sense scan.ts already
// defines. Different catalogue, different identity, different scope: the untouched pillars
// are answers to different questions and combining them would invent a scan that never
// happened. When that is the case the result covers only what was measured and says why.
//
// The carried pillars are never presented as fresh. Every pillar in the result names the
// run that measured it and when, which is what makes the merge honest rather than tidy.

import type { Finding } from '../resolve/finding.js';
import type { SignalId, SignalResult } from '../collect/signal.js';
import { pillarsEmptiedByDecision, scoreFindings } from '../score/score.js';
import { applyDecisions, exposureOf, type Exclusion } from '../apply/apply.js';
import type { ApplicabilityDecision } from '../apply/applicability.js';
import { comparable, type PillarMeasurement, type Scan } from './scan.js';
import { exclusionKeys } from './identity.js';

export interface CarryForwardOptions {
  /** The run that just happened, covering only `measuredPillars`. */
  readonly fresh: Scan;
  readonly previous: Scan | undefined;
  /** The pillars the fresh run was asked to measure. */
  readonly measuredPillars: readonly string[];
  readonly aliasGroupOf: (controlId: string) => string | undefined;
  /**
   * The customer's applicability decisions, by control id, so the merged findings are scored with the
   * same exclusions the fresh run used. Applied to the whole merged set, so a decision recorded since
   * the previous scan takes a carried requirement out of the score too — with the caveat inherent to
   * carrying forward: a carried pillar was not re-measured, so a decision *revoked* since the previous
   * scan is honoured on the next full scan rather than here, because the raw reading it would revert to
   * was not collected this run. Omitted means none, and the fresh run's own exposure is kept. See
   * `apply/apply.ts`.
   */
  readonly decisions?: ReadonlyMap<string, readonly ApplicabilityDecision[]>;
  /** The instant the lapse is judged against. Omitted means now. */
  readonly now?: Date;
}

/**
 * The fresh run's pillars plus the previous run's, or the fresh run alone with the reason.
 *
 * Returns a scan either way. A caller that had to handle "merged" and "not merged"
 * differently would be a caller with two save paths and two ways to be wrong.
 */
export function carryForward(options: CarryForwardOptions): Scan {
  const { aliasGroupOf, fresh, measuredPillars, previous } = options;

  // A run with no pillar list measured everything it assesses, so there is nothing outside it
  // to bring in. Guarded here rather than only at the call site, because getting this wrong
  // in the other direction — carrying every pillar forward over a full scan — would overwrite
  // a complete measurement with a stale one.
  if (measuredPillars.length === 0) return fresh;

  const refusal = why(fresh, previous, measuredPillars);
  if (refusal != null || previous == null) {
    return { ...fresh, ...(refusal != null ? { notCarried: refusal } : {}) };
  }

  const carried = previous.findings.filter((finding) => !measuredPillars.includes(finding.pillarId));
  if (carried.length === 0) return fresh;

  // The fresh findings arrive already applied (the fresh run applied the same decisions), and the
  // carried findings already reflect the previous run's decisions; re-applying over the merge is
  // idempotent for the ones still in force and applies any recorded since, so the combined result has
  // one coherent exposure rather than two half-scans' worth. See the caveat on `decisions` above.
  const merged: readonly Finding[] = [...fresh.findings, ...carried];
  const applied = applyDecisions(merged, (controlId) => options.decisions?.get(controlId) ?? [], options.now ?? new Date());
  const findings = applied.findings;
  const exposure = exposureOf(
    {
      ...applied,
      excluded: [...applied.excluded, ...stillExcluded(previous, carried, applied.excluded)],
    },
    // Over the merged set, because that is the set this scan scores: a pillar the rerun carried forward
    // is in the mean, and one the decisions emptied is not.
    pillarsEmptiedByDecision(merged, findings, { aliasGroupOf })
  );

  // The estate belongs to whichever run determined it. A pillar reachable without any
  // system-table query — security is entirely REST today — collects no workspace directory,
  // so a security-only rerun would otherwise report an estate it never looked at as
  // undetermined and lose the workspace names from the overview.
  const estate = fresh.estate.undeterminedReason == null ? fresh.estate : previous.estate;

  return {
    ...fresh,
    // Both runs' evidence, this run's winning on collision, since a signal collected twice
    // is the same signal and the newer reading is the one the fresh findings rest on.
    signals: mergeSignals(fresh.signals, previous.signals),
    findings,
    score: { ...scoreFindings(findings, { aliasGroupOf }), ...(exposure != null ? { exposure } : {}) },
    estate,
    stamp: {
      ...fresh.stamp,
      ...(estate.undeterminedReason == null
        ? { assessedWorkspaces: estate.assessed.map((workspace) => workspace.id).sort() }
        : {}),
      // The merged set has one exposure, so its identity must record the exclusions that exposure
      // holds rather than the fresh run's — a decision recorded since the previous scan can take a
      // carried requirement out, and a future comparison reads this set to refuse a trend across a
      // change in it. Left untouched when the fresh run recorded no identity (a run from before it).
      ...(fresh.stamp.identity != null
        ? { identity: { ...fresh.stamp.identity, exclusions: exclusionKeys(exposure?.excluded ?? []) } }
        : {}),
    },
    // Partial if either half is. A complete rerun over pillars carried forward from a scan
    // that stopped on its budget is not a complete assessment, and saying it is would let
    // one full rerun launder every earlier gap.
    state: fresh.state === 'partial' || previous.state === 'partial' ? 'partial' : 'complete',
    measurement: [...fresh.measurement, ...inherited(previous, measuredPillars)],
    // A scan carried nothing else forward here as of row 33d. The serverless analysis used to be
    // carried, because a rerun that did not touch the four requirements it stood behind never
    // collected the job history and dropping it emptied the page. It now belongs to the advisory
    // run, which is a separate run over a separate window and carries nothing across scans.
    ...(fresh.incompleteReason == null && previous.state === 'partial' && previous.incompleteReason != null
      ? { incompleteReason: `Carried forward from an incomplete scan. ${previous.incompleteReason}` }
      : {}),
  };
}

/**
 * Why the untouched pillars cannot come forward, or undefined when they can.
 *
 * A full run has nothing to carry and needs no explanation, so it is not a refusal.
 */
function why(fresh: Scan, previous: Scan | undefined, measuredPillars: readonly string[]): string | undefined {
  if (previous == null) {
    return (
      `This run measured only ${list(measuredPillars)}. There is no earlier scan to take the other pillars ` +
      'from, so they are absent from this result rather than shown as unmeasured. Run a full scan to assess them.'
    );
  }

  /*
   * Every comparability axis except the exclusion set.
   *
   * A targeted run records the exclusions its own findings carry, which are the ones inside the
   * pillars it measured; the previous full scan recorded them across the estate. Compared as sets those
   * differ by every decision standing outside the rerun, so the axis refused, and the customer lost the
   * six pillars they had not asked to rerun — which is the failure this file exists to prevent, arriving
   * through the check meant to protect it.
   *
   * Permitting it is not a relaxation. The axis refuses a *comparison* of two scores because their
   * denominators differ, and nothing here compares two scores: the merge re-applies the current
   * decisions over the combined set and scores that once, so there is one denominator. The identity
   * written below records the exclusions that scoring actually used, which is what a later trend reads.
   */
  const verdict = comparable(fresh.stamp, previous.stamp, undefined, { acrossExclusionChange: 'permit' });
  if (!verdict.ok) {
    return (
      `This run measured only ${list(measuredPillars)}. The other pillars were not carried forward from the ` +
      `previous scan because the two are not comparable: ${verdict.reason ?? 'the runs differ.'} ` +
      'Run a full scan to assess them under the same conditions.'
    );
  }

  return undefined;
}

/**
 * Requirements a carried finding is still out of the denominator for, whose decision no longer applies.
 *
 * The gap this closes. Since 31g a scan stores its findings already rewritten, so a carried finding for
 * an excluded requirement reads `not-applicable` or `unmeasurable` on disk with the raw reading gone.
 * Re-applying over the merge finds nothing when the decision behind it has been revoked or has expired,
 * and leaves that finding alone — correctly, because the reading it would revert to was not collected
 * this run. What did not follow is the exposure: the requirement stayed out of the score while the
 * exposure, the identity and the export all described a set that included it, so three surfaces
 * disagreed with the number they were describing and a trend could be drawn between two scans whose
 * denominators differed.
 *
 * So the previous scan's own entry comes forward with the finding it belongs to. Its `owner` and
 * `reason` are what that decision said when it was applied, which is what took the requirement out; no
 * surface reads this as a claim that the decision is in force today. Only `excluded` — a lapse left its
 * requirement in the score, so there is nothing to carry.
 */
function stillExcluded(
  previous: Scan,
  carried: readonly Finding[],
  applied: readonly Exclusion[]
): readonly Exclusion[] {
  const reapplied = new Set(applied.map((exclusion) => exclusion.controlId));
  // The two outcomes a rewrite produces. A carried entry against a finding reading anything else is a
  // requirement the merge is scoring, so carrying it would overstate what was taken out.
  const rewritten = new Set(
    carried
      .filter((finding) => finding.outcome === 'not-applicable' || finding.outcome === 'unmeasurable')
      .map((finding) => finding.controlId)
  );
  return (previous.score.exposure?.excluded ?? []).filter(
    (exclusion) => rewritten.has(exclusion.controlId) && !reapplied.has(exclusion.controlId)
  );
}

/** Previous measurements for the pillars this run left alone, marked as carried. */
function inherited(previous: Scan, measuredPillars: readonly string[]): readonly PillarMeasurement[] {
  return previous.measurement
    .filter((measurement) => !measuredPillars.includes(measurement.pillarId))
    .map((measurement) => ({ ...measurement, carriedForward: true }));
}

function mergeSignals(fresh: readonly SignalResult[], previous: readonly SignalResult[]): readonly SignalResult[] {
  const byId = new Map<SignalId, SignalResult>(previous.map((signal) => [signal.id, signal]));
  for (const signal of fresh) byId.set(signal.id, signal);
  return [...byId.values()];
}

function list(pillars: readonly string[]): string {
  return pillars.length === 1 ? (pillars[0] ?? '') : `${pillars.slice(0, -1).join(', ')} and ${pillars.at(-1) ?? ''}`;
}
