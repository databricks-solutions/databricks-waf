// Scoring.
//
// Five decisions here carry all the weight, and each of them is a decision about
// honesty rather than arithmetic.
//
// Per-pillar normalisation. Security carries 70 controls and data governance 13, so
// a single estate-wide average is a security score with rounding error attached. Each
// pillar is scored on its own controls and the overall figure is the mean of the
// pillar scores, which is the only way a governance failure moves the number at all.
//
// Severity weighting. A missing critical control and a missing informational one are
// not the same finding, and counting them equally would let an estate pass by doing
// the easy things.
//
// Alias groups scored once *per pillar*, on the group's worst outcome. A requirement
// appearing in two pillars is one thing to fix, and counting it twice inside one pillar
// would penalise the estate for the catalogue's structure. Dropping it from one of the two
// pillars is a different error, and it was the one this made for several releases: the
// global dedupe kept one finding per group and the pillar that happened to hold it was
// decided by the order the catalogue files load. Measured on labs, reliability scored 0
// from a single control while reporting four measured outcomes, because three of them had
// been attributed to cost optimization by file order. Each pillar now scores every
// requirement it expresses, and the overall figure is a mean of pillar scores, so
// including a shared requirement in both pillars cannot inflate anything.
//
// Unmeasurable is excluded from the average, not counted as either outcome. Scoring it
// as a failure would mean the tool's own blind spots lower the customer's score, which
// rewards configuring the tool to see less. Scoring it as a pass would let an estate look
// compliant by denying access. Neither; it is reported as a gap in knowledge, counted
// separately, and the pillar states how much of it there is.
//
// Every score carries the range its unmeasured remainder still allows. This is the
// answer to a problem measured live: performance efficiency scored 100 from 5 of 24
// applicable requirements, and reliability scored 0 from 1 of 16. Both numbers were
// arithmetically correct and both were misleading, because a score computed from a
// twentieth of a pillar reads as a verdict on the pillar.
//
// The two alternatives were worse. A minimum coverage bar below which no score is shown
// puts an arbitrary threshold at the centre of the product. Weighting the overall by how
// much of each pillar was measured is worse still: it would raise the score of an estate
// the tool can see less of, which is the same perverse incentive as scoring unmeasurable
// as a pass, arrived at by a longer route.
//
// So instead the remainder is quantified. If every unmeasured requirement turned out to
// fail, the score would be `low`; if every one passed, `high`. A fully measured pillar has
// low equal to high, and a pillar measured at 1.4% has a range so wide that the number
// between them is self-evidently not a verdict. Nothing is hidden and no threshold is
// chosen.

import type { Finding, Outcome, Severity, Unmeasured } from '../resolve/finding.js';
import { composition, type Composition } from '../resolve/evidence-class.js';
import type { Exposure } from '../apply/apply.js';

export const SEVERITY_WEIGHT: Readonly<Record<Severity, number>> = {
  critical: 10,
  high: 6,
  medium: 3,
  low: 1,
  informational: 0.5,
};

/**
 * Credit earned per outcome, as a fraction of the control's weight.
 *
 * `partial` earns half rather than nothing, because an estate that moved coverage
 * from 40% to 80% has done real work, and a score that does not move teaches people
 * to stop reading it.
 *
 * Exported alongside `SEVERITY_WEIGHT` because the two of them are the scoring method: every run
 * records a digest of both, so a comparison can refuse when the weighting moved rather than drawing
 * a trend across a change in what the score is out of. See `scan/identity.ts`.
 */
export const CREDIT: Readonly<Record<Outcome, number | null>> = {
  pass: 1,
  'satisfied-by-architecture': 1,
  partial: 0.5,
  fail: 0,
  // Excluded from the weighted average entirely, then reported separately.
  unmeasurable: null,
  'not-applicable': null,
};

/**
 * What the score would be at the extremes of what is not yet known.
 *
 * `low` assumes every unmeasured requirement fails, `high` that every one passes. The
 * width between them is how much of the pillar is unknown, expressed in the same units as
 * the score, which is more use to a reader than a coverage percentage they have to
 * translate for themselves.
 */
export interface ScoreRange {
  readonly low: number;
  readonly high: number;
}

export interface PillarScore {
  readonly pillarId: string;
  /** 0-100, or undefined when nothing in the pillar could be scored. */
  readonly score?: number;
  /**
   * How far the score could still move once what is unmeasured becomes known. Present
   * whenever `score` is, and equal to it on both sides when nothing is unmeasured.
   */
  readonly range?: ScoreRange;
  // No separate "measured share" field. It would be `1 - (high - low) / 100` exactly, and a
  // stored copy of derivable arithmetic is a second place for it to be wrong.
  readonly counts: Readonly<Record<Outcome, number>>;
  /** Controls that contributed to the score: pass, partial, fail, satisfied. */
  readonly scored: number;
  /** In the pillar but not in the score, and why, so a small denominator reads as fact. */
  readonly unmeasurable: number;
  /**
   * The same unmeasured requirements split by what would answer them.
   *
   * Reported because the aggregate is misleading on its own. Reliability measured live has
   * 13 of 18 unmeasured, which reads as a broken assessment; 12 of those are practice
   * statements no telemetry can answer and 1 is a source the app could not read, which
   * reads as an assessment doing its job and waiting on the customer.
   */
  readonly unmeasuredBy: Readonly<Record<Unmeasured, number>>;
  /**
   * What the requirements in the score rest on, counted by class.
   *
   * Reported because a score that does not distinguish measurement from an answer is a score an
   * organisation can raise by answering questions about itself, and nobody reading it could tell. A
   * pillar at 80 with two of twenty attested is an assessment; the same 80 with eighteen of twenty
   * attested is a questionnaire, and the reader is entitled to know which they have.
   *
   * A record of every class rather than one attested count, so the third class has somewhere to
   * arrive: an admin-collected reading is neither measured by this app nor somebody's word, and a
   * number that folded it into either would misdescribe it. See evidence-class.ts.
   */
  readonly composition: Composition;
  readonly notApplicable: number;
  readonly total: number;
  /** Failures ordered worst-first, for the pillar's remediation list. */
  readonly worstFirst: readonly Finding[];
}

export interface Score {
  /** Mean of the pillar scores, so one large pillar cannot dominate. */
  readonly overall?: number;
  /**
   * The same range as a pillar's, across the pillars that scored.
   *
   * Deliberately not narrowed by weighting the mean toward better-measured pillars. That
   * would flatter an estate for being unreadable.
   */
  readonly range?: ScoreRange;
  readonly pillars: readonly PillarScore[];
  readonly counts: Readonly<Record<Outcome, number>>;
  /**
   * Requirements the score is computed from, deduplicated: aliased controls are one requirement.
   *
   * Not the count to put in front of a reader as "how much was measured" — see `answeredControls`.
   */
  readonly scoredControls: number;
  /** Of `scoredControls`, what they rest on, by class. The same accounting as a pillar's. */
  readonly composition: Composition;
  readonly totalControls: number;
  /**
   * What a customer's applicability decisions took out of this score, and what lapsed.
   *
   * Attached by the scan layer rather than computed here, because the decisions are the store's business
   * and `scoreFindings` is pure arithmetic over the findings it is handed — by the time they reach here
   * an excluded requirement already reads `not-applicable` or `unmeasurable`, so the number is right
   * without this. The field exists so a reader is never shown a score without being shown what was
   * removed from it. Absent when nothing was excluded, so a score from an install with no applicability
   * path is unchanged. See `apply/apply.ts`.
   */
  readonly exposure?: Exposure;
}

/**
 * Requirements this run answered: met, met by architecture, partly met, not met.
 *
 * The count for any surface that tells a reader how much of their estate was assessed, and the reason
 * it is not `scoredControls`. That one is deduplicated so an estate is not penalised twice where the
 * catalogue expresses one requirement as several controls — correct for scoring, and smaller than the
 * outcome tally every surface also draws bars and lists from. A real run measured 49 requirements and
 * reported 34, and the two numbers appeared on the same panel.
 *
 * The client states the same four outcomes in `answered`, in its coverage module. Twice, because the
 * wire contract between them carries types and no code — so a change here is a change there.
 */
export function answeredControls(counts: Readonly<Record<Outcome, number>>): number {
  return counts.pass + counts['satisfied-by-architecture'] + counts.partial + counts.fail;
}

export interface ScoreOptions {
  /**
   * Controls sharing a group are one requirement and are scored once. The
   * representative is the worst outcome in the group: if the same requirement fails
   * when read from one pillar and passes from another, the failure is the true state
   * and the pass is the less complete view.
   */
  readonly aliasGroupOf?: (controlId: string) => string | undefined;
}

const OUTCOMES: readonly Outcome[] = [
  'pass',
  'fail',
  'partial',
  'unmeasurable',
  'not-applicable',
  'satisfied-by-architecture',
];

/** Worst first, so the alias representative and the remediation list use one order. */
const SEVERITY_OF_OUTCOME: Readonly<Record<Outcome, number>> = {
  fail: 0,
  partial: 1,
  unmeasurable: 2,
  pass: 3,
  'satisfied-by-architecture': 3,
  'not-applicable': 4,
};

export function scoreFindings(findings: readonly Finding[], options: ScoreOptions = {}): Score {
  const groupOf = options.aliasGroupOf ?? (() => undefined);
  const deduped = dedupeAliases(findings, options.aliasGroupOf);
  // The worst outcome per group, which is what every pillar expressing that requirement
  // scores. Built from the same reduction the global dedupe uses, so the two cannot disagree
  // about which reading of a shared requirement is the true one.
  const worstInGroup = new Map<string, Outcome>();
  for (const finding of deduped) {
    const group = groupOf(finding.controlId);
    if (group != null) worstInGroup.set(group, finding.outcome);
  }
  const byPillar = new Map<string, Finding[]>();

  // Every finding is reported in its own pillar, including the alias duplicates that
  // do not score. A control that appears in two pillars has to be visible in both,
  // or the second pillar's report has a hole where a requirement used to be.
  for (const finding of findings) {
    const group = byPillar.get(finding.pillarId) ?? [];
    group.push(finding);
    byPillar.set(finding.pillarId, group);
  }

  const pillars = [...byPillar.entries()]
    .map(([pillarId, pillarFindings]) => pillarScore(pillarId, pillarFindings, groupOf, worstInGroup))
    .sort((a, b) => a.pillarId.localeCompare(b.pillarId));

  const scored = pillars.filter((pillar) => pillar.score != null);
  const mean = (of: (pillar: PillarScore) => number): number =>
    round(scored.reduce((sum, pillar) => sum + of(pillar), 0) / scored.length);

  return {
    ...(scored.length > 0
      ? {
          overall: mean((pillar) => pillar.score ?? 0),
          range: {
            low: mean((pillar) => pillar.range?.low ?? pillar.score ?? 0),
            high: mean((pillar) => pillar.range?.high ?? pillar.score ?? 0),
          },
        }
      : {}),
    pillars,
    counts: tally(findings),
    scoredControls: deduped.filter((finding) => CREDIT[finding.outcome] != null).length,
    // Over the deduplicated set, so a requirement two pillars express counts once — the same set
    // `scoredControls` counts, which is what makes the two numbers comparable.
    composition: composition(deduped.filter((finding) => CREDIT[finding.outcome] != null)),
    totalControls: findings.length,
  };
}

/**
 * How many pillars had a score before a customer's decisions were applied and have none after.
 *
 * There is no division by zero to fix here — `pillarScore` emits a score only when `available > 0`, and
 * a pillar with nothing left scores nothing. The defect is quieter: a pillar with no score is not in the
 * mean, so excluding a pillar's last scored requirement raises or lowers the estate number with no
 * arithmetic error and nothing on the page to say a pillar left. 31c measured it: 75 with a range of
 * 75–75 became 100 with a range of 100–100, and the provenance sentence said seven requirements had been
 * set aside while the doubt collapsed to certainty.
 *
 * Both sides are scored by the same function rather than compared by counting credit-bearing outcomes,
 * because an alias group's worst reading can take credit off a finding whose own outcome carries it —
 * counting outcomes would report a pillar as emptied by a decision when it had never scored.
 */
export function pillarsEmptiedByDecision(
  before: readonly Finding[],
  after: readonly Finding[],
  options: ScoreOptions = {}
): number {
  const scoredIn = (findings: readonly Finding[]): ReadonlySet<string> =>
    new Set(
      scoreFindings(findings, options).pillars
        .filter((pillar) => pillar.score != null)
        .map((pillar) => pillar.pillarId)
    );
  const had = scoredIn(before);
  const has = scoredIn(after);
  return [...had].filter((pillarId) => !has.has(pillarId)).length;
}

/**
 * Unmeasured requirements grouped by remedy.
 *
 * Counted over the same set the pillar's other counts use, so the parts add up to
 * `unmeasurable` rather than to some other number. An unmeasurable finding with no
 * discriminator counts as `unreadable`, the most conservative reading: it says the app
 * tried, which never claims a requirement is someone else's to answer.
 *
 * That default is why `disabled` exists as a kind of its own rather than as an absent
 * discriminator. A check the customer switched off is the one case where nothing was wrong with
 * the read, and falling to `unreadable` would report a deliberate decision as a failed one.
 */
function unmeasuredBy(findings: readonly Finding[]): Readonly<Record<Unmeasured, number>> {
  const tallied: Record<Unmeasured, number> = {
    attestation: 0,
    unreachable: 0,
    unbuilt: 0,
    unreadable: 0,
    disabled: 0,
  };
  for (const finding of findings) {
    if (finding.outcome !== 'unmeasurable') continue;
    tallied[finding.unmeasured ?? 'unreadable'] += 1;
  }
  return tallied;
}

function pillarScore(
  pillarId: string,
  findings: readonly Finding[],
  groupOf: (controlId: string) => string | undefined,
  worstInGroup: ReadonlyMap<string, Outcome>
): PillarScore {
  let earned = 0;
  let available = 0;
  let scored = 0;
  // Weight of the requirements that apply to this estate but could not be measured. Not
  // in the score, and the whole basis of the range around it.
  let unmeasured = 0;
  /** The scored requirements, kept so their composition can be counted once at the end. */
  const scoredFindings: Finding[] = [];
  /** Requirements already counted in this pillar, so one expressed twice here scores once. */
  const counted = new Set<string>();

  for (const finding of findings) {
    const group = groupOf(finding.controlId);
    const requirement = group ?? finding.controlId;
    if (counted.has(requirement)) continue;
    counted.add(requirement);

    const weight = SEVERITY_WEIGHT[finding.severity];
    // The group's worst reading rather than this control's own, so a requirement two
    // pillars disagree about is scored the same way in both. Where nothing disagrees —
    // the usual case, since aliased controls share a resolver and its thresholds — this is
    // the finding's own outcome.
    //
    // Except where this pillar says the requirement does not apply to it, which the group may not
    // overrule. A verdict is shared and applicability is local: `pass` and `fail` are readings of one
    // requirement, so the worst of them is the honest one for every pillar expressing it, but
    // `not-applicable` is not a reading at all — it is a precondition answering that there is nothing
    // here to read. Preconditions are evaluated per control against the estate that control describes,
    // so one firing in this pillar is about this pillar.
    //
    // Measured, because the override ran in both directions and was wrong in both. A pillar whose only
    // requirement was inapplicable and whose sibling failed scored 0 — penalised for something it had
    // excluded. Worse, when the sibling passed it scored **100**: full marks, on a requirement its own
    // report shows as not applicable, and the estate went 50 to 100 on it.
    const outcome =
      finding.outcome === 'not-applicable'
        ? 'not-applicable'
        : group != null
          ? (worstInGroup.get(group) ?? finding.outcome)
          : finding.outcome;

    const credit = CREDIT[outcome];
    if (credit == null) {
      // `not-applicable` is not a gap in knowledge — the requirement does not apply, so
      // measuring it would not change the score. Only `unmeasurable` widens the range.
      if (outcome === 'unmeasurable') unmeasured += weight;
      continue;
    }

    earned += weight * credit;
    available += weight;
    scored += 1;
    scoredFindings.push(finding);
  }

  const counts = tally(findings);
  const total = available + unmeasured;

  return {
    pillarId,
    ...(available > 0
      ? {
          score: round((earned / available) * 100),
          range: { low: round((earned / total) * 100), high: round(((earned + unmeasured) / total) * 100) },
        }
      : {}),
    counts,
    scored,
    unmeasurable: counts.unmeasurable,
    unmeasuredBy: unmeasuredBy(findings),
    composition: composition(scoredFindings),
    notApplicable: counts['not-applicable'],
    total: findings.length,
    worstFirst: [...findings]
      .filter((finding) => finding.outcome === 'fail' || finding.outcome === 'partial')
      .sort(
        (a, b) =>
          SEVERITY_OF_OUTCOME[a.outcome] - SEVERITY_OF_OUTCOME[b.outcome] ||
          SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] ||
          a.controlId.localeCompare(b.controlId)
      ),
  };
}

/**
 * One finding per requirement.
 *
 * Where a group has several findings the worst is kept. The alternative — averaging
 * them — would let an estate improve its score by having the same requirement
 * assessed from more angles, which is a property of the catalogue rather than of the
 * estate.
 */
function dedupeAliases(
  findings: readonly Finding[],
  aliasGroupOf: ((controlId: string) => string | undefined) | undefined
): Finding[] {
  if (aliasGroupOf == null) return [...findings];

  const representatives = new Map<string, Finding>();
  const ungrouped: Finding[] = [];

  for (const finding of findings) {
    const group = aliasGroupOf(finding.controlId);
    if (group == null) {
      ungrouped.push(finding);
      continue;
    }
    const existing = representatives.get(group);
    if (existing == null || SEVERITY_OF_OUTCOME[finding.outcome] < SEVERITY_OF_OUTCOME[existing.outcome]) {
      representatives.set(group, finding);
    }
  }

  return [...ungrouped, ...representatives.values()];
}

function tally(findings: readonly Finding[]): Record<Outcome, number> {
  const counts = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<Outcome, number>;
  for (const finding of findings) counts[finding.outcome] += 1;
  return counts;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
