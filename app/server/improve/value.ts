// Four figures about improvement work, kept apart on purpose.
//
// [ADR 0083](../../../docs/decisions/0083-four-value-figures-none-of-which-is-a-score-and-only-a-measured-one-aggregates.md)
// is the decision this implements, and the reason it needed one is that the four are easy to say in a
// sentence and produce four different numbers. Each is defined here by *what produced it* rather than
// by what it is about:
//
// - **Posture** is the assessment's own answer. Only a scan produces it, and it is restated here rather
//   than recomputed: this module reads a scan's score and never derives one.
// - **Opportunity** is what an advisor says is available, in the advisor's own arithmetic. The one
//   figure below that is not this app's: the serverless analysis totals its own estimate under its own
//   assumptions, and re-summing the jobs here would produce a second number with a different
//   denominator and the same name.
// - **Committed value** is the opportunity a person accepted by turning a finding into an action,
//   frozen on the action when it was raised.
// - **Realised value** is a measure read twice — the baseline the action kept and a later advisory's
//   reading of the same measure — and it is reported as both readings, never as their difference.
//
// **No figure here may move a WAF score, and no score enters the other three.** The prohibition is in
// both audit readings and in ADR 0083, and it is repeated at the top of the module that would be the
// natural place to break it: this is where all four are in scope at once.
//
// Four rules about arithmetic, each of which is a number this refuses to produce.
//
// **Opportunity and committed value are totalled inside one advisor and one currency, and labelled an
// estimate.** Adding a serverless saving to a warehouse's is adding two numbers computed under
// different assumptions by different rules, and the sum's only true property is that somebody wrote it
// down.
//
// **A resource is counted once.** The advisors price a *resource* — moving a job off classic compute —
// and an action is raised from one finding of the several a job may have. Two actions on the same job
// are two pieces of work and one saving, so the money totals deduplicate by resource and report both
// counts, and the count of actions is never the count the money is over.
//
// **Realised value aggregates only over the same measure.** One total per advisor, label and unit, over
// the distinct measurements behind it. `advice-reading.ts` has already refused every pair that was read
// over a different window or under a different rules version, so what arrives here is comparable or
// absent.
//
// **A finding that stopped firing contributes no realised number.** It is the outcome to aim for and it
// is the one with nothing to measure: the advisors compute evidence inside the condition that fires, so
// the run that shows the work landed is the run with no reading in it. Those are counted as `cleared`,
// beside the realised totals and never inside them, and the count is the honest form of "these worked".
//
// And the outcomes are reported whole. A realised total over the attempts that worked is a list of
// successes, which the audit asks not to be given: `outcomes` counts every advice-raised action by what
// the estate now says, including the ones the advisor still reports and the ones nothing could read.

import type { Agreement, ActionProgress } from './progress.js';
import type { AdviceProvenance, Advisor } from './advice.js';
import type { Evidence } from '../advise/rules.js';

/** The assessment's own answer, restated. Nothing here is computed from it. */
export interface Posture {
  readonly runId: string;
  readonly at: Date;
  /** Absent where nothing scored, which is a fact about the run rather than a zero. */
  readonly overall?: number;
  readonly scoredControls: number;
  readonly totalControls: number;
  readonly unmeasured: number;
}

/**
 * An advisor's money, with everything needed to argue with it.
 *
 * A range rather than a figure because that is how the advisor computes it, and the assumptions travel
 * with it because a saving conditional on the workload staying as it is reads as a promise without
 * them. `resources` is what the range is over; `actions` is how many pieces of work sit on those
 * resources, and the two differ whenever somebody raised two actions against one job.
 */
export interface Money {
  readonly advisor: Advisor;
  readonly low: number;
  readonly high: number;
  readonly currency: string;
  readonly region?: string;
  readonly resources: number;
  readonly actions?: number;
  readonly assumptions: readonly string[];
}

/** One measure, summed over the actions that carry it. Both readings, never their difference. */
export interface Measured {
  readonly advisor: Advisor;
  readonly label: string;
  readonly unit: Evidence['unit'];
  readonly before: number;
  readonly after: number;
  /** How many distinct measurements are in the two totals, so neither is a figure over nothing. */
  readonly measurements: number;
}

export interface ValueReport {
  readonly posture?: Posture;
  /** What the advisors say is available now, in their own totals. Empty where none of them prices anything. */
  readonly opportunity: readonly Money[];
  /** What people accepted by raising work against it, frozen at the day they did. */
  readonly committed: readonly Money[];
  readonly realised: readonly Measured[];
  /**
   * Advice-raised actions the latest advisory no longer reports, and which of them carried money.
   *
   * The count that would be a realised total if the advisors emitted their measures outside the
   * conditions that fire. They do not, so this is a count and says so.
   */
  readonly cleared: { readonly actions: number; readonly resources: number };
  /** Every advice-raised action by what the estate says now, so no total is only its successes. */
  readonly outcomes: Readonly<Record<Agreement, number>>;
}

export interface ValueInput {
  /** Every action being reported on, with the reading each one already has. */
  readonly progress: readonly ActionProgress[];
  /**
   * The advisors' own totals from the latest advisory, which is where opportunity comes from.
   *
   * A narrowed shape rather than an `Advisory`, because the only thing this module may take from one
   * is a total the advisor computed itself.
   */
  readonly opportunity?: readonly Money[];
  readonly posture?: Posture;
}

const NO_OUTCOMES: Readonly<Record<Agreement, number>> = {
  unclaimed: 0,
  awaiting: 0,
  agreed: 0,
  contradicted: 0,
  unmeasured: 0,
  unjudged: 0,
};

export function valueOf(input: ValueInput): ValueReport {
  const advised = input.progress.filter((one) => one.action.advice != null);

  const outcomes = { ...NO_OUTCOMES };
  for (const one of advised) outcomes[one.agreement] += 1;

  return {
    ...(input.posture != null ? { posture: input.posture } : {}),
    opportunity: input.opportunity ?? [],
    committed: committedFrom(advised),
    realised: realisedFrom(advised),
    cleared: clearedFrom(advised),
    outcomes,
  };
}

/**
 * What was accepted, by advisor and currency, over the resources it was accepted on.
 *
 * Cancelled work is out and everything else is in, including the verified: committed value is what
 * somebody agreed to, and dropping it once the work is done would make the total fall as the programme
 * succeeds. A cancelled action is the one case where the commitment was withdrawn.
 */
function committedFrom(advised: readonly ActionProgress[]): readonly Money[] {
  interface Total {
    readonly advisor: Advisor;
    readonly currency: string;
    low: number;
    high: number;
    /** One region, or none once two disagree. See below. */
    region: string | undefined;
    regions: number;
    readonly resources: Set<string>;
    actions: number;
    readonly assumptions: Set<string>;
  }
  const totals = new Map<string, Total>();

  for (const one of advised) {
    const advice = one.action.advice as AdviceProvenance;
    const opportunity = advice.opportunity;
    if (opportunity == null || one.action.state === 'cancelled') continue;

    const key = `${advice.advisor}\u0000${opportunity.currency}`;
    const total: Total = totals.get(key) ?? {
      advisor: advice.advisor,
      currency: opportunity.currency,
      low: 0,
      high: 0,
      region: opportunity.region,
      regions: 0,
      resources: new Set<string>(),
      actions: 0,
      assumptions: new Set<string>(),
    };
    totals.set(key, total);

    total.actions += 1;
    for (const assumption of advice.assumptions) total.assumptions.add(assumption);

    // The same resource priced twice is one saving. Its second action is real work and adds nothing
    // to the money, which is the difference the two counts on the total exist to show.
    if (total.resources.has(advice.resource.id)) continue;
    total.resources.add(advice.resource.id);
    total.low += opportunity.low;
    total.high += opportunity.high;
    // A region is named on the total only while every resource in it came from the same price list.
    // Naming the first of two would attribute the whole range to a rate that produced half of it.
    if (total.region !== opportunity.region) total.region = undefined;
    total.regions += 1;
  }

  return [...totals.values()].map((total) => ({
    advisor: total.advisor,
    low: round(total.low),
    high: round(total.high),
    currency: total.currency,
    ...(total.region != null ? { region: total.region } : {}),
    resources: total.resources.size,
    actions: total.actions,
    assumptions: [...total.assumptions],
  }));
}

/** Two decimal places, because these are sums of money and floating point makes long tails of them. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Every comparable measure, summed per advisor, label and unit over the distinct measurements. */
function realisedFrom(advised: readonly ActionProgress[]): readonly Measured[] {
  const totals = new Map<string, { readonly measured: Measured; readonly seen: Set<string> }>();

  for (const one of advised) {
    const advice = one.action.advice as AdviceProvenance;
    for (const movement of one.advice?.movements ?? []) {
      const key = `${advice.advisor}\u0000${movement.label}\u0000${movement.unit}`;
      // One measurement per resource, rule and measure. Two actions raised from the same finding are
      // two commitments and one reading, and adding it twice would report a movement that half
      // happened.
      const measurement = `${advice.resource.id}\u0000${advice.rule}`;
      const total = totals.get(key);

      if (total == null) {
        totals.set(key, {
          measured: {
            advisor: advice.advisor,
            label: movement.label,
            unit: movement.unit,
            before: movement.before,
            after: movement.after,
            measurements: 1,
          },
          seen: new Set([measurement]),
        });
        continue;
      }
      if (total.seen.has(measurement)) continue;
      total.seen.add(measurement);
      totals.set(key, {
        seen: total.seen,
        measured: {
          ...total.measured,
          before: total.measured.before + movement.before,
          after: total.measured.after + movement.after,
          measurements: total.measured.measurements + 1,
        },
      });
    }
  }

  return [...totals.values()].map((total) => total.measured);
}

function clearedFrom(advised: readonly ActionProgress[]): { readonly actions: number; readonly resources: number } {
  const cleared = advised.filter((one) => one.advice?.standing === 'cleared');
  const resources = new Set(cleared.map((one) => (one.action.advice as AdviceProvenance).resource.id));
  return { actions: cleared.length, resources: resources.size };
}
