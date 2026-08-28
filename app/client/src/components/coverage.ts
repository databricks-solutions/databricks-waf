// How much was measured, and what that entitles the reader to conclude.
//
// This module exists because the page was leading with the wrong number. Six score cards, equally
// weighted, above a caption nobody read — while the fact that decided whether any of them meant
// anything was that a quarter of the applicable framework had been evaluated. A reader who takes
// 52.7 from that page is not slightly misinformed, they are holding a number produced from 34 of
// 138 requirements and reading it as an architecture rating.
//
// So coverage and confidence are computed here, in the reader's terms, and every surface that
// shows a score takes its framing from this file rather than deciding for itself.
//
// The two axes are deliberately separate. Coverage is how much was looked at; posture is what was
// found in that part. A pillar can be thinly measured and healthy in the part that was measured,
// and collapsing the two into one colour is how "0.0" ends up on a pillar nobody assessed.

import { certainty } from './score-range';
import type { ApplicabilityLever, Outcome, PillarScore, Score, ScoreRange } from '../api/types';

export interface CoverageFacts {
  /** Every requirement in the framework for this subject. */
  readonly total: number;
  /** Those that apply to this estate: total less not-applicable. The honest denominator. */
  readonly applicable: number;
  /**
   * Those with an outcome: met, partly met or not met. The coverage numerator.
   *
   * Counted the way the reader can count it — from the same outcome tally the segment bar, the
   * findings list and the history row are drawn from. It is not `scored`, and the difference is not
   * cosmetic: this panel reported "34 of 169 applicable requirements were evaluated" directly above a
   * bar whose own segments added to 49, and the comparison beneath it read "coverage fell from 29% to
   * 20%" between two runs of an unchanged estate, because the two sides of that subtraction were
   * these two different numbers. A reader can count the bar. If the headline disagrees with it, the
   * headline is the thing that is wrong.
   */
  readonly assessed: number;
  /**
   * Those the score is computed from, which is fewer wherever the catalogue expresses one
   * requirement as several controls.
   *
   * Aliased controls are one requirement and are scored once, or an estate would be penalised twice
   * for one thing being wrong — see `dedupeAliases` in the scorer. That makes this the right
   * denominator for the composition shares below and the wrong one for coverage, since nothing the
   * reader can see is counted this way.
   */
  readonly scored: number;
  readonly unmeasured: number;
  readonly notApplicable: number;
  /**
   * Of `scored`, how many were answered by a person rather than observed.
   *
   * Part of coverage rather than a separate concern because it is the second half of the same
   * question. "How much was assessed" and "how much of that was assessed by asking" together decide
   * what the score is worth, and a surface that reported the first without the second would let a
   * set of answers given once read as a measured estate.
   */
  readonly attested: number;
  /**
   * Of `scored`, how many came from a reading an administrator imported rather than from this app.
   *
   * Zero in every run this build can produce, and carried anyway so the surfaces that describe the
   * mixture do not have to pretend the scored set is only ever two kinds of thing. It does not affect
   * confidence: an imported reading is a measurement, taken by someone with access this app lacks.
   */
  readonly adminCollected: number;
  /** Assessed as a share of applicable, 0–100. Zero when nothing applies. */
  readonly percent: number;
  /** Attested as a share of scored, 0–100. Zero when nothing was scored. */
  readonly attestedPercent: number;
  /**
   * How many requirements a customer's applicability decisions took out of this score.
   *
   * A count, not the requirements themselves: the sentence that reads it says how many were removed
   * from the denominator, and the list of which ones lives in the export, not here. Zero for a pillar
   * or an unassessed subject — exposure is an estate-level fact, carried on the whole-estate score.
   */
  readonly excludedByDecision: number;
  /**
   * Of `excludedByDecision`, how many were set aside under each lever.
   *
   * Split because the two make different claims and one sentence cannot carry both. `not-applicable`
   * says the requirement does not apply to this estate; `disabled` says the check behind it is switched
   * off in this install, which is a fact about the measurement and not about the estate. The single count
   * was rendered as the first of those for both, so a customer who switched two checks off was told two
   * requirements do not apply to their estate.
   */
  readonly notApplicableByDecision: number;
  readonly disabledByDecision: number;
  /**
   * How many such decisions were set aside because the requirement they name is failing or only
   * partly met, so they did not move the score. Counted apart from `excludedByDecision` because a
   * lapsed decision changed nothing, and a reader owed the difference.
   */
  readonly lapsedDecisions: number;
  /**
   * How many pillars had a score before those decisions and have none after, so left the estate
   * average.
   *
   * A count. Which pillars they were is not on the wire and must not appear in a sentence: the field
   * behind this is a number, and 31c's measurement — 75 with a range of 75–75 becoming 100 with a range
   * of 100–100 — is what a reader is owed a clause for, not the pillar's name.
   */
  readonly pillarsEmptiedByDecision: number;
}

function facts(input: {
  total: number;
  assessed: number;
  scored: number;
  unmeasured: number;
  notApplicable: number;
  attested: number;
  adminCollected: number;
  excludedByDecision?: number;
  notApplicableByDecision?: number;
  disabledByDecision?: number;
  lapsedDecisions?: number;
  pillarsEmptiedByDecision?: number;
}): CoverageFacts {
  const applicable = Math.max(0, input.total - input.notApplicable);
  return {
    ...input,
    applicable,
    percent: applicable === 0 ? 0 : (input.assessed / applicable) * 100,
    attestedPercent: input.scored === 0 ? 0 : (input.attested / input.scored) * 100,
    excludedByDecision: input.excludedByDecision ?? 0,
    notApplicableByDecision: input.notApplicableByDecision ?? 0,
    disabledByDecision: input.disabledByDecision ?? 0,
    lapsedDecisions: input.lapsedDecisions ?? 0,
    pillarsEmptiedByDecision: input.pillarsEmptiedByDecision ?? 0,
  };
}

/**
 * The outcomes that mean a requirement was answered.
 *
 * Satisfied-by-architecture belongs here with the readings: it is a requirement decided, by a
 * precondition that holds, rather than one left open. The bar counts it under met and so does this.
 *
 * The same four outcomes as `answeredControls` in the server's scorer, which decides whether a
 * scheduled run read enough of the estate to be an assessment. Stated twice because the wire contract
 * between them carries types and no code, and a change to one is a change to both.
 */
function answered(counts: Readonly<Record<Outcome, number>>): number {
  return counts.pass + counts['satisfied-by-architecture'] + counts.partial + counts.fail;
}

/**
 * How many exclusions used one lever.
 *
 * Read off the entries rather than sent as two numbers, so the parts cannot disagree with the whole:
 * `excludedByDecision` is the length of the same list.
 */
function leverCount(score: Score, lever: ApplicabilityLever): number {
  return (score.exposure?.excluded ?? []).filter((exclusion) => exclusion.lever === lever).length;
}

export function estateCoverage(score: Score): CoverageFacts {
  return facts({
    total: score.totalControls,
    assessed: answered(score.counts),
    scored: score.scoredControls,
    unmeasured: score.counts.unmeasurable,
    notApplicable: score.counts['not-applicable'],
    // The decoder fills composition in for runs written before evidence classes existed, so this
    // does not need a fallback for historical data — see the mapping in the server's codec.
    attested: score.composition.attested,
    adminCollected: score.composition['admin-collected'],
    // Absent on a run from an install with no applicability path, or one recorded before exposure
    // existed. Absent reads as none excluded, which is what those runs were.
    excludedByDecision: score.exposure?.excluded.length ?? 0,
    notApplicableByDecision: leverCount(score, 'not-applicable'),
    disabledByDecision: leverCount(score, 'disabled'),
    lapsedDecisions: score.exposure?.lapsed.length ?? 0,
    pillarsEmptiedByDecision: score.exposure?.pillarsEmptied ?? 0,
  });
}

export function pillarCoverage(pillar: PillarScore): CoverageFacts {
  return facts({
    total: pillar.total,
    // All three off the one tally, though the pillar carries `unmeasurable` and `notApplicable` as
    // fields of their own that the scorer fills from exactly these counts. Reading one source keeps
    // the parts adding to the total by construction rather than by two fields agreeing.
    assessed: answered(pillar.counts),
    scored: pillar.scored,
    unmeasured: pillar.counts.unmeasurable,
    notApplicable: pillar.counts['not-applicable'],
    attested: pillar.composition.attested,
    adminCollected: pillar.composition['admin-collected'],
  });
}

/** A pillar in the catalogue that this build does not measure. Not a zero — an absence. */
export function unassessedCoverage(total: number): CoverageFacts {
  return facts({
    total,
    assessed: 0,
    scored: 0,
    unmeasured: total,
    notApplicable: 0,
    attested: 0,
    adminCollected: 0,
  });
}

export type Confidence = 'high' | 'moderate' | 'low' | 'none';

export const CONFIDENCE_LABEL: Readonly<Record<Confidence, string>> = {
  high: 'High',
  moderate: 'Moderate',
  low: 'Low',
  none: 'Not assessed',
};

/**
 * Confidence from coverage alone.
 *
 * Not from the score, and not from how confident the evidence behind each finding is: those are
 * different questions and folding them together would let a well-evidenced reading of a tenth of
 * a pillar report as trustworthy. The thresholds are round on purpose — they are a communication
 * device, not a measurement, and anything more precise would imply a rigour the input lacks.
 */
export function confidenceOf(coverage: CoverageFacts): Confidence {
  if (coverage.scored === 0) return 'none';
  /*
   * A mostly self-reported assessment cannot report high confidence, however complete it is.
   *
   * This is the check that keeps the attestation feature from undoing the thing it was added to.
   * Answering 82 requirements takes coverage from 24% to near-total, and without this the page
   * would then say "almost every applicable requirement has been evaluated, so the score is
   * stable" about a set of statements somebody typed. The threshold caps at moderate rather than
   * dropping to low, because the answers are real information given by someone accountable — they
   * are simply not observations, and confidence is a claim about observation.
   */
  const mostlyAttested = coverage.attestedPercent > 50;
  if (coverage.percent >= 80) return mostlyAttested ? 'moderate' : 'high';
  if (coverage.percent >= 50) return mostlyAttested ? 'low' : 'moderate';
  return 'low';
}

/** Why the confidence is what it is, and what would change it. One sentence, neutral. */
export function confidenceSentence(coverage: CoverageFacts): string {
  const confidence = confidenceOf(coverage);
  if (confidence === 'none') {
    // Nothing scored has two causes and they are not the same sentence. Where decisions took the
    // requirements out, "nothing has been evaluated yet" is false — they were evaluated and then set
    // aside — and this is the one branch where a reader most needs the exclusions named, so the clause
    // is appended rather than the early return being left as it was. Where no decision is involved,
    // the sentence is unchanged.
    const clause = excludedClause(coverage);
    if (clause === '') return 'Nothing here has been evaluated yet, so there is no posture to read.';
    return `Nothing here is in the score, so there is no posture to read. ${clause}`;
  }

  const base =
    confidence === 'low' && coverage.percent < 50
      ? 'Most applicable requirements have not been evaluated. Scores may change substantially as ' +
        'evidence coverage improves.'
      : coverage.percent >= 80
        ? 'Almost every applicable requirement has been evaluated.'
        : 'Around half the applicable requirements have been evaluated, so scores can still move.';

  const clauses = [attestedClause(coverage), importedClause(coverage), excludedClause(coverage)].filter(
    (clause) => clause !== ''
  );
  return clauses.length === 0 ? withStability(base, confidence, coverage) : [base, ...clauses].join(' ');
}

/**
 * The stability claim, which only a well-covered and observed assessment has earned.
 *
 * Split out because the sentence it belongs to reads as a conclusion, and the conclusion is wrong
 * whenever part of the coverage came from answers rather than measurements.
 */
function withStability(base: string, confidence: Confidence, coverage: CoverageFacts): string {
  return confidence === 'high' && coverage.percent >= 80 ? `${base} The score is stable.` : base;
}

/**
 * How much of what was assessed is somebody's answer. Stated in requirements, not a percentage.
 *
 * The denominator is named "the score is computed from" rather than "assessed", because it is
 * `scored` and the coverage line beside it counts `assessed` — two numbers that differ wherever the
 * catalogue aliases controls. Naming them apart is the whole of the fix: a reader who sees "12 of 34"
 * under "49 of 169 assessed" needs the shorter number to be about something else, or the panel is
 * back to contradicting itself.
 */
export function attestedClause(coverage: CoverageFacts): string {
  if (coverage.attested === 0) return '';
  const share = Math.round(coverage.attestedPercent);
  return (
    `${coverage.attested.toLocaleString()} of the ${coverage.scored.toLocaleString()} requirements the ` +
    `score is computed from (${String(share)}%) rest on an answer given by a person rather than on ` +
    'something this app observed.'
  );
}

/**
 * How much of what was assessed came from a reading an administrator imported.
 *
 * Separate from the attested clause because it is a different claim and the difference matters to the
 * reader: an imported reading is a measurement, taken against an authority this app cannot reach, so
 * it does not weaken confidence the way an answer does. Saying nothing about it would leave the
 * attested clause implying the remainder was observed here, which for those requirements is untrue.
 */
export function importedClause(coverage: CoverageFacts): string {
  if (coverage.adminCollected === 0) return '';
  return (
    `${coverage.adminCollected.toLocaleString()} of the ${coverage.scored.toLocaleString()} requirements ` +
    'the score is computed from came from a read-only check an administrator ran and imported, against ' +
    'an authority this app cannot reach itself.'
  );
}

/**
 * What a customer's applicability decisions took out of the score, and what lapsed.
 *
 * The provenance the score owes a reader: a denominator that a person narrowed is not the framework's
 * denominator, and the number cannot say so on its own. Both halves are counts — the requirements
 * themselves are named in the export, and a count is all this sentence may claim, because the field
 * behind it is a length and not a list.
 *
 * The first half is per lever, because the two levers claim different things and the sentence has to
 * carry whichever one was used. `not-applicable` says the requirement does not apply to this estate.
 * `disabled` says the check behind it is switched off in this install — a fact about the measurement,
 * which is why 31c gave it `unmeasurable` and a widened range rather than a smaller denominator alone.
 * One count rendered as the first wording covered both, so a customer who switched a check off read that
 * a requirement did not apply to their estate, and no fixture used the second lever to catch it.
 *
 * The lapsed half reports decisions that changed nothing: a decision to set a requirement aside does
 * not apply while that requirement is failing or only partly met. "failing or only partly met" is the
 * definition of a lapse and holds for every one counted here; it is not read off any single reading.
 *
 * The third half is the one a reader could not have inferred. A pillar whose last scored requirement is
 * set aside has no score, and the estate number is the mean of the pillars that do — so the pillar
 * leaves the average with no arithmetic error and, before this clause, nothing on the page. 31c measured
 * it at 75 with a range of 75–75 becoming 100 with a range of 100–100, under a sentence that said seven
 * requirements had been set aside. The clause says how many pillars, and never which: the field behind
 * it is a count.
 */
export function excludedClause(coverage: CoverageFacts): string {
  const excluded = coverage.excludedByDecision;
  const lapsed = coverage.lapsedDecisions;
  const emptied = coverage.pillarsEmptiedByDecision;
  if (excluded === 0 && lapsed === 0 && emptied === 0) return '';

  const notApplicable = coverage.notApplicableByDecision;
  const disabled = coverage.disabledByDecision;

  const outside =
    notApplicable === 0
      ? ''
      : notApplicable === 1
        ? 'One requirement has been set aside as not applying to this estate and is not in the score.'
        : `${notApplicable.toLocaleString()} requirements have been set aside as not applying to this ` +
          'estate and are not in the score.';

  const off =
    disabled === 0
      ? ''
      : disabled === 1
        ? "One requirement's check is switched off in this install, so it was not scored either."
        : `${disabled.toLocaleString()} requirements have checks switched off in this install, so they ` +
          'were not scored either.';

  // A run recorded before the levers were counted separately carries the total and neither part. It
  // reported as the first lever for both, which is the defect; with no lever to name, the count is all
  // this may say.
  const unattributed =
    notApplicable + disabled > 0 || excluded === 0
      ? ''
      : excluded === 1
        ? 'One requirement has been set aside by a decision and is not in the score.'
        : `${excluded.toLocaleString()} requirements have been set aside by decisions and are not in ` +
          'the score.';

  const set = [outside, off, unattributed].filter((part) => part !== '').join(' ');

  // "further such" needs a decision already mentioned to be further than, and a lapse can be the only
  // thing here: a decision that lapsed was not applied, so it is not in `excluded`, and the clause then
  // opened on a comparative with nothing behind it.
  const kind = set === '' ? 'applicability decision' : 'further such decision';
  const held =
    lapsed === 0
      ? ''
      : lapsed === 1
        ? `One ${kind} was not applied, because the requirement it names is failing or only partly met.`
        : `${lapsed.toLocaleString()} ${kind}s were not applied, because the requirements they name are ` +
          'failing or only partly met.';

  const left =
    emptied === 0
      ? ''
      : emptied === 1
        ? 'One pillar has no scored requirement left as a result, so it is not in the estate average — ' +
          'which is the mean of the pillars that scored.'
        : `${emptied.toLocaleString()} pillars have no scored requirement left as a result, so they are ` +
          'not in the estate average — which is the mean of the pillars that scored.';

  return [set, held, left].filter((part) => part !== '').join(' ');
}

/**
 * Whether a score can be read as a verdict, or only as a reading of the part that was measured.
 *
 * The criterion is the range rather than the coverage percentage, because the range is already
 * severity-weighted: a pillar whose unmeasured requirements are all low-severity can be thinly
 * covered and still tightly bounded, and one critical unknown can widen a well-covered pillar.
 * `certainty` returns `mostly` when the score could still land anywhere across 50 points, which
 * is the point past which a number stops being a verdict about anything.
 */
export function isDirectional(range: ScoreRange | undefined): boolean {
  return certainty(range) === 'mostly';
}

/**
 * A pillar's posture as something to render: a number, or the reason there isn't one.
 *
 * `insufficient` is the case this exists for. Reliability scores 0.0 from one requirement of
 * sixteen, and 0.0 on a page of numbers is indistinguishable from a pillar that failed everything
 * — the worst single misreading this app can produce, and the one a reader is most likely to
 * screenshot.
 */
export type Posture =
  | { readonly kind: 'scored'; readonly score: number }
  | { readonly kind: 'directional'; readonly score: number; readonly range?: ScoreRange }
  | { readonly kind: 'insufficient' }
  | { readonly kind: 'unassessed' };

export function postureOf(pillar: PillarScore | undefined, coverage: CoverageFacts): Posture {
  if (pillar?.score == null) return coverage.total === 0 ? { kind: 'insufficient' } : { kind: 'unassessed' };
  // One requirement out of sixteen is arithmetic, not evidence. The number stays in the data and
  // in the pillar's own page, where the denominator is beside it; it does not go in a column of
  // seven numbers the reader will compare against each other.
  if (coverage.scored <= 2 && coverage.applicable >= 8) return { kind: 'insufficient' };
  if (isDirectional(pillar.range)) {
    return { kind: 'directional', score: pillar.score, ...(pillar.range != null ? { range: pillar.range } : {}) };
  }
  return { kind: 'scored', score: pillar.score };
}

/** "49 of 169 assessed" — the phrase, so every surface says it the same way. */
export function coveragePhrase(coverage: CoverageFacts): string {
  return `${coverage.assessed.toLocaleString()} of ${coverage.applicable.toLocaleString()} assessed`;
}
