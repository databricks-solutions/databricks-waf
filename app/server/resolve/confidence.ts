// How firmly a finding is established, and what stops it being firmer.
//
// A reader deciding what to do about a failing requirement is asking two questions the outcome
// alone does not answer: how sure is this, and what would make it surer. Both answers are already
// in the finding — the class of the evidence, how much of the estate it covers, which estate,
// whether it was read this run or carried from an earlier one, whether it is somebody's word. They
// are spread across five fields and a reader has to assemble them. This assembles them once.
//
// Three properties this deliberately has.
//
// It is derived, never stored. Confidence is a reading of a finding, so it cannot disagree with the
// finding it describes and there is no second record to keep in step. A run written by an earlier
// build gains confidence the moment it is read by this one.
//
// It does not touch the score. A sampled observation and a complete one both count once, exactly as
// before, and nothing here is a weight. Downgrading a score for weak evidence sounds prudent and is
// the same mistake as scoring an unreadable permission as a failure: it rewards configuring the tool
// to see less, and it puts a judgement about evidence quality inside a number nobody can decompose.
// The standing sits beside the outcome and says what it rests on. GAP-006 asked for exactly that —
// "define finding-level confidence without changing scoring".
//
// The standing is a label for the limitations, not a judgement on top of them. Every finding shows
// both, and the standing is a function of the list: no limitations is `established`, a limitation
// that narrows what was read is `qualified`, and an outcome resting on somebody's answer is
// `stated`. So a reader who distrusts the label can read what produced it, and a label can never
// assert a certainty the list does not support.

import type { Coverage, Reach } from '../collect/signal.js';
import { classOf } from './evidence-class.js';
import type { Evidence, Finding } from './finding.js';

/**
 * How firmly the outcome is established.
 *
 * Ordered, and the order is the evidence-class precedence with coverage folded in. `none` is not a
 * fourth grade: it is the absence of the question, for a finding that established nothing.
 */
export type ConfidenceStanding = 'established' | 'qualified' | 'stated' | 'none';

export type LimitationKind =
  /** Part of the population was examined, not all of it. */
  | 'sampled'
  /** The reading covers less than the whole account. */
  | 'reach'
  /** Read by an administrator against an authority this app does not hold, and imported. */
  | 'imported'
  /** The outcome is somebody's answer about a practice. */
  | 'attested'
  /** That answer stops counting soon. */
  | 'expiring'
  /** The evidence was read in an earlier run and carried into this one. */
  | 'carried';

export interface Limitation {
  readonly kind: LimitationKind;
  /** Shown verbatim. States what may not be concluded, not what went wrong. */
  readonly says: string;
}

export interface Confidence {
  readonly standing: ConfidenceStanding;
  /**
   * One sentence saying what the standing rests on, always present.
   *
   * Present even at `established`, because "nothing qualifies this" is the fact a reader wants
   * and an empty space is not it — a page that says nothing about strong evidence and a paragraph
   * about weak evidence teaches the reader that the paragraph means bad news, which is a reason
   * to skip it.
   */
  readonly because: string;
  /** Every reason the standing is not `established`, in the order they narrow the claim. */
  readonly limitations: readonly Limitation[];
}

/** Context a finding does not carry about itself, but which limits what it may claim. */
export interface Circumstances {
  /**
   * True when this finding's pillar was not measured by this run and was carried from an earlier
   * one, so every date on it is that run's rather than this one's.
   */
  readonly carriedForward?: boolean;
  /** When the run reporting this finished, for judging how near an attestation is to expiry. */
  readonly asOf?: Date;
}

/** An attestation within this many days of its review date is called out as expiring. */
const EXPIRING_WITHIN_DAYS = 30;

/**
 * What a finding rests on, and what limits it.
 *
 * An `unmeasurable` finding gets `none` and no limitations. Nothing was established, so there is
 * nothing to qualify — and `unmeasured` already says which of the five kinds of gap it is, which is
 * the question a reader actually has there. Listing limitations against it would read as though a
 * better-covered scan would have produced an answer, which is true for one of the five kinds and
 * false for the other four.
 */
export function confidenceOf(finding: Finding, circumstances: Circumstances = {}): Confidence {
  if (finding.outcome === 'unmeasurable') {
    return { standing: 'none', because: 'Nothing was established, so there is no confidence to report.', limitations: [] };
  }

  const limitations = limitationsOf(finding, circumstances);
  const standing = standingOf(finding, limitations);
  return { standing, because: because(standing, limitations), limitations };
}

function standingOf(finding: Finding, limitations: readonly Limitation[]): ConfidenceStanding {
  if (classOf(finding) === 'attested') return 'stated';
  return limitations.length === 0 ? 'established' : 'qualified';
}

/**
 * Narrowest first, which is the order a reader needs rather than the order they are computed in.
 *
 * The list can hold more than one and they compound: a sampled reading of one workspace, imported,
 * is three separate statements about what may not be concluded and collapsing them to the worst
 * would drop two of them.
 */
function limitationsOf(finding: Finding, circumstances: Circumstances): readonly Limitation[] {
  const limitations: Limitation[] = [];

  const attested = finding.attested;
  if (attested != null && attested.bearing === 'outcome') {
    limitations.push({
      kind: 'attested',
      says:
        `This is ${attested.by}'s answer about the practice, recorded ${on(attested.at)}, not something this app read. ` +
        `${attested.owner} is accountable for it.`,
    });
    const days = daysUntil(attested.reviewBy, circumstances.asOf);
    if (days != null && days <= EXPIRING_WITHIN_DAYS) {
      limitations.push({
        kind: 'expiring',
        says:
          days <= 0
            ? `The answer was due for review ${on(attested.reviewBy)} and no longer counts.`
            : `The answer is due for review ${on(attested.reviewBy)}, in ${String(days)} ${days === 1 ? 'day' : 'days'}, after which it stops counting.`,
      });
    }
  }

  const sampled = sampling(finding.coverage);
  if (sampled != null) limitations.push(sampled);

  const narrow = narrowReach(finding.coverage.reach);
  if (narrow != null) limitations.push(narrow);

  const imported = importedAt(finding.evidence);
  if (imported != null) {
    limitations.push({
      kind: 'imported',
      says:
        `An administrator collected this against an authority this app cannot hold, and imported it. ` +
        `It describes the estate as it stood ${on(imported)}, and this app cannot re-read it to check.`,
    });
  }

  if (circumstances.carriedForward === true) {
    limitations.push({
      kind: 'carried',
      says: 'This run did not measure this pillar. The outcome and its evidence are from the run named on it.',
    });
  }

  return limitations;
}

function sampling(coverage: Coverage): Limitation | undefined {
  if (coverage.mode !== 'sampled') return undefined;

  const of =
    coverage.examined != null && coverage.population != null
      ? `${String(coverage.examined)} of ${String(coverage.population)}`
      : 'part of the population';
  const basis = coverage.basis != null ? ` ${coverage.basis}` : '';
  return {
    kind: 'sampled',
    says: `Read over ${of}, so the outcome describes what was examined rather than the whole of it.${basis}`,
  };
}

/**
 * A reach narrower than the account, which is what the reader of a multi-workspace estate assumes.
 *
 * An unstated reach is a limitation too, and the sentence says whose fault it is: a collector that
 * did not declare what it was a statement about leaves the reader unable to tell a complete account
 * reading from a single-workspace one, and that gap is this app's rather than the estate's.
 */
function narrowReach(reach: Reach | undefined): Limitation | undefined {
  if (reach === 'account') return undefined;
  if (reach === 'metastore') {
    return {
      kind: 'reach',
      says:
        'Read from the Unity Catalog metastore attached to this workspace. An account with metastores in ' +
        'more than one region needs this app installed once per region before this covers all of them.',
    };
  }
  if (reach === 'workspace') {
    return {
      kind: 'reach',
      says: 'Read from this workspace only. It says nothing about the others in the account.',
    };
  }
  return {
    kind: 'reach',
    says: 'The collector did not declare which part of the estate this is a statement about, which is a gap in this app.',
  };
}

/** When the outcome-bearing imported evidence was collected, or nothing when none of it was. */
function importedAt(evidence: readonly Evidence[]): Date | undefined {
  const bearing = evidence.filter((one) => one.bearing !== 'detail' && one.evidenceClass === 'admin-collected');
  if (bearing.length === 0) return undefined;
  // The oldest, because the claim is only as current as its stalest part.
  return bearing.reduce((oldest, one) => (one.collectedAt < oldest ? one.collectedAt : oldest), bearing[0].collectedAt);
}

function because(standing: ConfidenceStanding, limitations: readonly Limitation[]): string {
  if (standing === 'established') {
    return 'Read by this app from the sources named below, over the whole of the estate it can see. Nothing qualifies it.';
  }
  if (standing === 'stated') {
    const also = limitations.filter((one) => one.kind !== 'attested' && one.kind !== 'expiring');
    return also.length === 0
      ? 'The outcome is somebody\u2019s answer about the practice rather than a reading, so it is as good as their account of it.'
      : 'The outcome is somebody\u2019s answer about the practice rather than a reading, and what is recorded beside it is qualified too.';
  }
  return limitations.length === 1
    ? 'Read by this app, with one limit on what it establishes.'
    : `Read by this app, with ${String(limitations.length)} limits on what it establishes.`;
}

function daysUntil(when: Date, asOf: Date | undefined): number | undefined {
  if (asOf == null) return undefined;
  return Math.ceil((when.getTime() - asOf.getTime()) / 86_400_000);
}

/** The date alone. A finding shows several and a time on each would be noise. */
function on(date: Date): string {
  return `on ${date.toISOString().slice(0, 10)}`;
}
