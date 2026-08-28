// What a later advisory says about the finding an action was raised from.
//
// `44b` froze what the advisor said on the day. This is the other half of the pair: the same rule, on
// the same resource, read again by a later run. An action against a warehouse names no requirement, so
// no assessment can speak to it — a second advisory is the only thing that can, and this is where it
// does.
//
// The whole module is one judgement made six times: **what is not a fact about the work.**
//
// **A resource the later run does not mention is not a fixed resource.** Three of the four advisors
// report a ranked subset — the costliest shapes, the longest-running jobs — so a shape that has left
// the list may have been fixed, may have been overtaken by a worse one, or may simply not have run this
// month. The job advisor's population moves the same way. So absence answers nothing, and saying
// otherwise would verify work by the estate getting busier elsewhere.
//
// **An analysis the later run could not form is not an absence of findings.** `Advisory` leaves an
// analysis undefined when its signals were unreadable, which every advisor page already refuses to
// render as good news. The same refusal applies here and matters more, because here it would move an
// action to `verified`.
//
// **A rule this build no longer has cannot be said to have stopped firing.** Rule ids are free strings
// on the record — `44a`'s census — and ADR 0083 left the question of an action outliving its rule to
// this row. A withdrawn rule reads as unreadable: the action is about something the app can no longer
// look for, which is a fact about the ruleset and not about the resource.
//
// **Two numbers taken over different windows are not a before and an after.** A count of failed runs
// over 30 days and the same count over 7 is not an improvement of 77%. So a movement is only reported
// where the later advisory read the same number of days, and where the rules version that produced the
// two readings is the same — a threshold change is invisible in the label, and the label is all a
// comparison here has to match on. ADR 0083 asks for the same measure *by the same apparatus*; this is
// what that turns into in code.
//
// **A finding that has stopped firing carries no later number.** The advisors compute evidence inside
// the condition that fires — see `advise/rules.ts`, where `test` returns evidence only on a hit — and an
// advisory stores the analysis rather than the rows behind it. So the run that shows the work landed is
// exactly the run with nothing left to measure, and `cleared` is reported with no movements at all
// rather than with an invented zero. `44c`'s plan section records this, because it is the reason a
// realised value cannot be a single figure for every action that worked.

import type { Advisory } from '../advise/advisory.js';
import type { Evidence } from '../advise/rules.js';
import { jobRules, sizingRules, workloadRules } from '../advise/workload-rules.js';
import { serverlessRules } from '../analyze/serverless-rules.js';
import type { AdviceProvenance, Advisor } from './advice.js';

/** What the later run said about the finding. Only one of these is evidence that the work landed. */
export type AdviceStanding =
  /** The same rule fired again on the same resource. The advice still stands. */
  | 'still-firing'
  /** The resource was read again and the rule did not fire. The condition the action was about is gone. */
  | 'cleared'
  /** The later run says nothing about this resource, which is not the same as saying it is fine. */
  | 'resource-absent'
  /** The later run formed no analysis for this advisor, so it read nothing here at all. */
  | 'advisor-unread'
  /** This build's ruleset no longer has the rule, so nothing can look for it. */
  | 'rule-withdrawn'
  /** The advisory is not later than the advice, so it is the same reading or an earlier one. */
  | 'not-later';

/** Why two readings of the same measure may not be subtracted. Absent where they may. */
export type Incomparable =
  /** Different lookbacks. A 30-day count and a 7-day count are two measures with one name. */
  | 'window'
  /** Different rules versions. The label is unchanged and what it counts may not be. */
  | 'rules-version';

/** One measure, read twice. Both readings, never their difference — see ADR 0083. */
export interface Movement {
  readonly label: string;
  readonly unit: Evidence['unit'];
  readonly before: number;
  readonly after: number;
}

export interface AdviceReading {
  readonly advisoryId: string;
  /** When the later run finished. What the `after` of every movement is true of. */
  readonly measuredAt: Date;
  readonly lookbackDays: number;
  readonly standing: AdviceStanding;
  /**
   * The measures the baseline and this reading share, both readings each.
   *
   * Empty on every standing but `still-firing`, and empty there too where the two runs cannot be
   * compared. A reader is owed the difference between "nothing moved" and "these cannot be
   * subtracted", which is what `incomparable` beside this is for.
   */
  readonly movements: readonly Movement[];
  /** The baseline measures this reading does not carry, by label, so a partial comparison says so. */
  readonly unmatched: readonly string[];
  readonly incomparable?: Incomparable;
}

/**
 * What a later advisory says about one action's advice.
 *
 * A pure function of the two records, called wherever an action is read rather than stored beside it.
 * The same argument `progress.ts` opens with: the advisory already says this, and a stored copy would
 * be a field that drifts from the two records it was derived from.
 */
export function adviceReadingOf(advice: AdviceProvenance, advisory: Advisory): AdviceReading {
  const common = {
    advisoryId: advisory.id,
    measuredAt: advisory.finishedAt,
    lookbackDays: advisory.lookbackDays,
    unmatched: [] as readonly string[],
  };
  const nothing = { ...common, movements: [] as readonly Movement[] };

  // Same-or-earlier is refused before anything is looked up, and `>=` rather than `>` because the
  // advisory an action was raised from is the commonest thing to be handed here: it is the latest one
  // until the next run, and it agrees with itself by construction.
  if (advisory.finishedAt.getTime() <= advice.measuredAt.getTime()) {
    return { ...nothing, standing: 'not-later' };
  }
  if (!known(advice.advisor, advice.rule)) return { ...nothing, standing: 'rule-withdrawn' };

  const found = locate(advisory, advice);
  if (found.analysis == null) return { ...nothing, standing: 'advisor-unread' };
  if (!found.analysis.resource) return { ...nothing, standing: 'resource-absent' };
  if (found.analysis.evidence == null) return { ...nothing, standing: 'cleared' };

  const incomparable = whyIncomparable(advice, advisory, found.analysis.versions);
  if (incomparable != null) {
    return { ...nothing, standing: 'still-firing', incomparable };
  }

  const later = new Map(found.analysis.evidence.map((one) => [one.label, one]));
  const movements: Movement[] = [];
  const unmatched: string[] = [];
  for (const before of advice.baseline) {
    const after = later.get(before.label);
    // The unit as well as the label, because a rule that changed what it reports a duration in would
    // otherwise produce a movement from milliseconds to seconds and call it a hundredfold improvement.
    if (after == null || after.unit !== before.unit) {
      unmatched.push(before.label);
      continue;
    }
    movements.push({ label: before.label, unit: before.unit, before: before.value, after: after.value });
  }

  return { ...common, standing: 'still-firing', movements, unmatched };
}

/** Whether this build still has the rule, which is what decides `rule-withdrawn`. */
function known(advisor: Advisor, rule: string): boolean {
  if (advisor === 'workload') return workloadRules().rules.has(rule);
  if (advisor === 'sizing') return sizingRules().rules.has(rule);
  if (advisor === 'jobs') return jobRules().rules.has(rule);
  return serverlessRules().rules.has(rule);
}

/** What the later analysis holds for this resource and rule, or nothing where the analysis is absent. */
interface Location {
  readonly resource: boolean;
  /** The rule's evidence where it fired, and absent where it did not. Empty is a rule that fired on prose. */
  readonly evidence?: readonly Evidence[];
  /** The versions this analysis declares, to compare with the ones the action kept. */
  readonly versions: readonly { readonly name: string; readonly value: string }[];
}

function locate(advisory: Advisory, advice: AdviceProvenance): { readonly analysis?: Location } {
  if (advice.advisor === 'workload') {
    const analysis = advisory.workload;
    if (analysis == null) return {};
    const versions = [
      { name: 'rulesVersion', value: String(analysis.rulesVersion) },
      { name: 'rankingVersion', value: analysis.rankingVersion },
    ];
    const shape = [...analysis.top, ...analysis.failing].find((one) => one.shape === advice.resource.id);
    if (shape == null) return { analysis: { resource: false, versions } };
    const finding = shape.findings.find((one) => one.rule === advice.rule);
    return { analysis: { resource: true, versions, ...(finding == null ? {} : { evidence: finding.evidence }) } };
  }

  if (advice.advisor === 'sizing') {
    const analysis = advisory.sizing;
    if (analysis == null) return {};
    const versions = [{ name: 'rulesVersion', value: String(analysis.rulesVersion) }];
    const warehouse = analysis.warehouses.find((one) => one.warehouseId === advice.resource.id);
    if (warehouse == null) return { analysis: { resource: false, versions } };
    const finding = warehouse.findings.find((one) => one.rule === advice.rule);
    return { analysis: { resource: true, versions, ...(finding == null ? {} : { evidence: finding.evidence }) } };
  }

  if (advice.advisor === 'jobs') {
    const analysis = advisory.jobs;
    if (analysis == null) return {};
    const versions = [{ name: 'rulesVersion', value: String(analysis.rulesVersion) }];
    const job = analysis.jobs.find((one) => one.jobId === advice.resource.id);
    if (job == null) return { analysis: { resource: false, versions } };
    const finding = job.findings.find((one) => one.rule === advice.rule);
    return { analysis: { resource: true, versions, ...(finding == null ? {} : { evidence: finding.evidence }) } };
  }

  const analysis = advisory.serverless;
  if (analysis == null) return {};
  const job = analysis.jobs.find((one) => one.jobId === advice.resource.id);
  // No version to compare: the serverless analysis declares none, which `44a` reported and `44b` left
  // as an empty list rather than filling in. Two empty lists agree, so a serverless movement is
  // compared on its window alone — which is the honest consequence of the record carrying no version.
  if (job == null) return { analysis: { resource: false, versions: [] } };
  const reason = job.reasons.find((one) => one.ruleId === advice.rule);
  return { analysis: { resource: true, versions: [], ...(reason == null ? {} : { evidence: reason.evidence ?? [] }) } };
}

/**
 * Why the two readings may not be subtracted, or nothing where they may.
 *
 * The window first, because it is the one that is different every time somebody reruns an advisory
 * over a different period and the one a reader can act on: run it again over the same days.
 */
function whyIncomparable(
  advice: AdviceProvenance,
  advisory: Advisory,
  versions: readonly { readonly name: string; readonly value: string }[]
): Incomparable | undefined {
  if (advisory.lookbackDays !== advice.lookbackDays) return 'window';

  const before = new Map(advice.versions.map((one) => [one.name, one.value]));
  for (const version of versions) {
    // A version the action does not carry is a version that has appeared since, which is the same
    // problem as one that changed: the reading was produced by an apparatus the baseline was not.
    if (before.get(version.name) !== version.value) return 'rules-version';
  }
  return before.size === versions.length ? undefined : 'rules-version';
}
