// What an action made from an advisor finding keeps of where it came from.
//
// `44a` measured what a finding carries, and the answer decided how this module is shaped: nothing
// carries a rules version or a resource on the finding itself, so provenance cannot be a copy of a
// finding object. It is assembled here, from the advisory record, out of a reference naming which
// finding was acted on — the advisory, the advisor, the resource, and the rule.
//
// **The reference is what a client sends and the provenance is what the server writes.** A client
// posting the fields directly would be posting whatever page it had open: a shape's numbers from a
// run three days old, a rule id the ruleset no longer holds, a saving computed under assumptions
// nobody recorded. Everything below comes from the stored advisory, which is why the four fields can
// be trusted afterwards by whatever asks whether the work helped.
//
// Two refusals are deliberate.
//
// A reference naming nothing is an error rather than an empty provenance, because an action recording
// "this came from an advisor finding" that cannot be resolved back to one is worse than an action
// with no provenance at all: it reads as checkable and is not.
//
// And a measurement that exists only as prose is not a baseline. A serverless reason's `observed` is
// the sentence `Its longest task run took 8.0 days`, and no later reading can be subtracted from that.
// The half of those reasons that fire on a quantity now carry it as evidence as well — that is the
// other half of `44b` — but a job configured to run continuously is a setting rather than a number, and
// so is an advisory written before the field existed. Where there is no number the sentence is kept, as
// an observation, and
// [ADR 0083](../../../docs/decisions/0083-four-value-figures-none-of-which-is-a-score-and-only-a-measured-one-aggregates.md)
// is what says an action carrying one may hold an opportunity and may not hold a realised value.

import type { Advisory } from '../advise/advisory.js';
import type { Evidence } from '../advise/rules.js';
import { jobRules, sizingRules, workloadRules, writeRules, type Severity } from '../advise/workload-rules.js';

/** The five analyses one advisory run produces, named as a reader's URL names them. */
export const ADVISORS = ['workload', 'sizing', 'jobs', 'writes', 'serverless'] as const;

export type Advisor = (typeof ADVISORS)[number];

/**
 * What kind of thing an advisor's finding was found on. One per advisor, and no advisor spans two.
 *
 * `shape` is two advisors rather than one, and that is not a spanning advisor — it is one kind of thing
 * that two analyses read. Both identify it by the same fingerprint over the same normalised text, so an
 * action raised from a write shape and one raised from a query shape name the same resource where the
 * statement is the same statement.
 */
export type AdviceResourceKind = 'shape' | 'warehouse' | 'job';

/**
 * Which finding was acted on, as a client can name it.
 *
 * Four fields, none of them prose: everything a reader sees is derived from these against the record.
 */
export interface AdviceReference {
  readonly advisoryId: string;
  readonly advisor: Advisor;
  /** The shape hash, warehouse id or job id the finding was found on. */
  readonly resource: string;
  readonly rule: string;
}

/** A version the advice was produced under, named because two of them move independently. */
export interface AdviceVersion {
  readonly name: string;
  readonly value: string;
}

export interface AdviceResource {
  readonly kind: AdviceResourceKind;
  readonly id: string;
  readonly workspaceId: string;
  /** The estate's own name for it, where the inventory had one. A shape has none. */
  readonly name?: string;
}

/**
 * What the advisor said was available on the resource, as it said it.
 *
 * A range and never a figure, because that is how the one advisor that prices anything computes it.
 * The assumptions beside it on the provenance are the terms it was computed under, and ADR 0083's rule
 * is that a saving without them attached reads as a promise.
 *
 * **It is the resource's, not the finding's.** The serverless analysis prices moving a job off classic
 * compute, and a job has as many reasons as it has reasons; an action raised from one of them is part
 * of the work that would earn this, not the whole of it. So nothing may present this as what the action
 * is worth, and `value.ts` totals it over distinct resources rather than over actions.
 */
export interface AdviceOpportunity {
  readonly low: number;
  readonly high: number;
  readonly currency: string;
  /** The price list the rate came from, which is the one part of it a reader can check. */
  readonly region?: string;
}

/**
 * Everything the action keeps about the finding it was raised from.
 *
 * Frozen at creation and never recomputed. The advisor's advice changes every run — that is what an
 * advisor is — and provenance that moved with it would leave every action describing the latest run
 * rather than the one somebody acted on.
 */
export interface AdviceProvenance {
  readonly advisoryId: string;
  readonly advisor: Advisor;
  readonly rule: string;
  /** Every version the analysis declared, so an action cites all of what produced its advice. */
  readonly versions: readonly AdviceVersion[];
  readonly resource: AdviceResource;
  readonly headline: string;
  readonly detail: string;
  readonly docUrl: string;
  readonly severity?: Severity;
  /**
   * The numbers the rule fired on, with their units. Empty where the advisor measured in prose.
   *
   * This is the field a later reading is compared against, so an empty one is not a formatting
   * detail: it is the difference between an action whose outcome can be measured and one whose
   * outcome can only be asserted.
   */
  readonly baseline: readonly Evidence[];
  /** The measurement as the advisor wrote it, where that is all there was. */
  readonly observation?: string;
  /**
   * What the advisor said moving this resource would be worth, where it said anything.
   *
   * Present on serverless findings whose job could be priced, and absent everywhere else — three of
   * the four advisors estimate no money at all, and the fourth has no rate for a job whose spend it
   * could not read. Absent therefore means the advisor named no figure, which is what committed value
   * is silent about rather than zero.
   */
  readonly opportunity?: AdviceOpportunity;
  /** What the advisor's own figures rest on, in its words. Only serverless declares any today. */
  readonly assumptions: readonly string[];
  /** When the advisory that produced this finished. The date the baseline was true of. */
  readonly measuredAt: Date;
  /** How many days of estate the advisory read, so the baseline says what it is an average over. */
  readonly lookbackDays: number;
}

export class UnknownAdviceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownAdviceError';
  }
}

/**
 * The provenance for one finding of one advisory, or an error saying which part of the reference
 * named nothing.
 *
 * The messages name the part rather than the whole, because a reference is four fields assembled by
 * two different pieces of code and "no such finding" sends whoever reads it to check all four.
 */
export function adviceFrom(advisory: Advisory, reference: AdviceReference): AdviceProvenance {
  const common = { advisoryId: advisory.id, measuredAt: advisory.finishedAt, lookbackDays: advisory.lookbackDays };

  if (reference.advisor === 'workload') {
    const analysis = advisory.workload;
    if (analysis == null) throw missing('workload', advisory.id);
    const shape = [...analysis.top, ...analysis.failing].find((one) => one.shape === reference.resource);
    if (shape == null) throw noResource('query group', reference.resource, advisory.id);
    const finding = shape.findings.find((one) => one.rule === reference.rule);
    if (finding == null) throw noRule(reference.rule, 'query group', reference.resource);
    const rule = workloadRules().rules.get(finding.rule);
    if (rule == null) throw noWords(reference.rule);
    return {
      ...common,
      advisor: 'workload',
      rule: finding.rule,
      versions: [
        { name: 'rulesVersion', value: String(analysis.rulesVersion) },
        { name: 'rankingVersion', value: analysis.rankingVersion },
      ],
      resource: { kind: 'shape', id: shape.shape, workspaceId: shape.workspaceId },
      headline: rule.headline,
      detail: rule.detail,
      docUrl: rule.docUrl,
      severity: finding.severity,
      baseline: finding.evidence,
      assumptions: [],
    };
  }

  if (reference.advisor === 'sizing') {
    const analysis = advisory.sizing;
    if (analysis == null) throw missing('warehouse sizing', advisory.id);
    const warehouse = analysis.warehouses.find((one) => one.warehouseId === reference.resource);
    if (warehouse == null) throw noResource('warehouse', reference.resource, advisory.id);
    const finding = warehouse.findings.find((one) => one.rule === reference.rule);
    if (finding == null) throw noRule(reference.rule, 'warehouse', reference.resource);
    const rule = sizingRules().rules.get(finding.rule);
    if (rule == null) throw noWords(reference.rule);
    return {
      ...common,
      advisor: 'sizing',
      rule: finding.rule,
      versions: [{ name: 'rulesVersion', value: String(analysis.rulesVersion) }],
      resource: {
        kind: 'warehouse',
        id: warehouse.warehouseId,
        workspaceId: warehouse.workspaceId,
        name: warehouse.name,
      },
      headline: rule.headline,
      detail: rule.detail,
      docUrl: rule.docUrl,
      severity: finding.severity,
      baseline: finding.evidence,
      assumptions: [],
    };
  }

  if (reference.advisor === 'jobs') {
    const analysis = advisory.jobs;
    if (analysis == null) throw missing('job health', advisory.id);
    const job = analysis.jobs.find((one) => one.jobId === reference.resource);
    if (job == null) throw noResource('job', reference.resource, advisory.id);
    const finding = job.findings.find((one) => one.rule === reference.rule);
    if (finding == null) throw noRule(reference.rule, 'job', reference.resource);
    const rule = jobRules().rules.get(finding.rule);
    if (rule == null) throw noWords(reference.rule);
    return {
      ...common,
      advisor: 'jobs',
      rule: finding.rule,
      versions: [{ name: 'rulesVersion', value: String(analysis.rulesVersion) }],
      resource: { kind: 'job', id: job.jobId, workspaceId: job.workspaceId, name: job.name },
      headline: rule.headline,
      detail: rule.detail,
      docUrl: rule.docUrl,
      severity: finding.severity,
      baseline: finding.evidence,
      assumptions: [],
    };
  }

  if (reference.advisor === 'writes') {
    const analysis = advisory.writes;
    if (analysis == null) throw missing('write patterns', advisory.id);
    const shape = analysis.shapes.find((one) => one.shape === reference.resource);
    if (shape == null) throw noResource('write group', reference.resource, advisory.id);
    const finding = shape.findings.find((one) => one.rule === reference.rule);
    if (finding == null) throw noRule(reference.rule, 'write group', reference.resource);
    const rule = writeRules().rules.get(finding.rule);
    if (rule == null) throw noWords(reference.rule);
    return {
      ...common,
      advisor: 'writes',
      rule: finding.rule,
      versions: [{ name: 'rulesVersion', value: String(analysis.rulesVersion) }],
      // No name, and a shape has none for the same reason a query shape has none: it is a fingerprint over
      // text rather than an object the estate named. The statement itself is on the page, not here.
      resource: { kind: 'shape', id: shape.shape, workspaceId: shape.workspaceId },
      headline: rule.headline,
      detail: rule.detail,
      docUrl: rule.docUrl,
      severity: finding.severity,
      baseline: finding.evidence,
      // Neither write rule prices anything, so there is nothing to state terms for. Empty rather than a
      // sentence about the absence, which is what `assumptions` means on the three advisors above.
      assumptions: [],
    };
  }

  const analysis = advisory.serverless;
  if (analysis == null) throw missing('serverless readiness', advisory.id);
  const job = analysis.jobs.find((one) => one.jobId === reference.resource);
  if (job == null) throw noResource('job', reference.resource, advisory.id);
  const reason = job.reasons.find((one) => one.ruleId === reference.rule);
  if (reason == null) throw noRule(reference.rule, 'job', reference.resource);
  return {
    ...common,
    advisor: 'serverless',
    rule: reason.ruleId,
    // The serverless analysis declares no version on its payload, which `44a`'s census reports and
    // this leaves visible rather than filling in: an empty list says the record does not carry one,
    // and a version invented here would be a fact about this file.
    versions: [],
    resource: { kind: 'job', id: job.jobId, workspaceId: job.workspaceId, name: job.name },
    headline: reason.headline,
    detail: reason.detail,
    docUrl: reason.docUrl,
    // Whatever the reason measured as a number, which `44b` gave the ones that fire on a count or a
    // duration. Empty for the rest, and for a reason read out of an advisory written before the
    // field existed — in both cases the sentence below is the whole of the measurement.
    baseline: reason.evidence ?? [],
    observation: reason.observed,
    // The job's estimate, which is the estate's only priced advice. Copied rather than apportioned
    // between the job's reasons: the analysis prices the move and not the reason, and a share of it
    // computed here would be a number this file invented. `AdviceOpportunity` says what follows from
    // that, and `value.ts` is where it is totalled once per job however many actions name it.
    ...(job.estimate != null ? { opportunity: job.estimate } : {}),
    // The analysis's assumptions rather than the job's, because that is where they are declared: they
    // are the terms the whole cost range was computed under, and every job's estimate rests on them.
    assumptions: analysis.assumptions.map((one) => one.statement),
  };
}

function missing(advisor: string, advisoryId: string): UnknownAdviceError {
  return new UnknownAdviceError(
    `Advisory ${advisoryId} has no ${advisor} analysis, so nothing in it can be acted on. A run that could ` +
      'not read that part of the estate has no findings there rather than none to report.'
  );
}

function noResource(kind: string, id: string, advisoryId: string): UnknownAdviceError {
  return new UnknownAdviceError(`Advisory ${advisoryId} says nothing about the ${kind} ${id}.`);
}

function noRule(rule: string, kind: string, id: string): UnknownAdviceError {
  return new UnknownAdviceError(
    `No rule called ${rule} fired on the ${kind} ${id} in this advisory. Advice changes between runs, so a ` +
      'finding that has gone is raised again from the run that shows it.'
  );
}

function noWords(rule: string): UnknownAdviceError {
  return new UnknownAdviceError(
    `The rule ${rule} fired in this advisory and this build's ruleset has no words for it, so an action ` +
      'raised from it would say nothing about what it is.'
  );
}
