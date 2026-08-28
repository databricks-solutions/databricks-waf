// The words an outcome is allowed to be given.
//
// Separated from the components that render them so the wording has one home. The
// vocabulary is the product: "unmeasured" must never render as a failure, and "not
// applicable" must always be able to say why. Both are one careless copy-paste away from
// being wrong on a page nobody re-reads.
//
// Tone and icon moved to ui/StatusBadge.tsx, where the two channels are decided together —
// splitting them left the colour rule here and the icon that has to agree with it elsewhere.

import { tooLittleMeasured } from './score-range';
import type { Coverage, Outcome, ScoreRange, Severity } from '../api/types';

export const OUTCOME_LABEL: Readonly<Record<Outcome, string>> = {
  pass: 'Met',
  fail: 'Not met',
  partial: 'Partly met',
  unmeasurable: 'Unmeasured',
  'not-applicable': 'Not applicable',
  'satisfied-by-architecture': 'Met by architecture',
};

export const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  informational: 'Informational',
};

export function outcomeLabel(outcome: Outcome): string {
  return OUTCOME_LABEL[outcome];
}

/**
 * What a coverage claim actually entitles the reader to conclude.
 *
 * Two independent limits, and either one alone can make a passing finding misleading:
 * how much of the population was examined, and which population it was. A complete scan
 * of one metastore and a complete scan of the whole account both arrive here as
 * `complete`, so reach has to be stated separately or the narrower of the two reads as
 * the broader.
 *
 * Account reach with complete coverage is the unqualified claim, so it gets no note —
 * a caveat on every finding is a caveat nobody reads.
 */
export function coverageNote(coverage: Coverage): string | undefined {
  const sampling = coverage.mode === 'sampled' ? samplingNote(coverage) : undefined;
  const reach = reachNote(coverage.reach);

  if (sampling == null) return reach;
  return reach == null ? sampling : `${sampling} ${reach}`;
}

function samplingNote(coverage: Coverage): string {
  const examined = coverage.examined;
  const population = coverage.population;
  const scale =
    examined != null && population != null
      ? `${examined.toLocaleString()} of ${population.toLocaleString()}`
      : 'a subset';
  const basis = coverage.basis != null ? ` (${coverage.basis})` : '';
  return `Measured over ${scale}${basis}, so this result describes the sample rather than the whole estate.`;
}

function reachNote(reach: Coverage['reach']): string | undefined {
  if (reach === 'metastore') {
    return (
      'Covers the Unity Catalog metastore attached to this workspace. If the account has ' +
      'metastores in other regions, they are not included.'
    );
  }
  if (reach === 'workspace') {
    return 'Covers this workspace only, because the setting is not exposed account-wide.';
  }
  return undefined;
}

/**
 * Three bands and a neutral, from the semantic palette rather than from Tailwind's.
 *
 * One function decides the band and everything that draws a score derives its colour from it,
 * because the alternative was found in this codebase: a text colour rule here, a bar fill that
 * was always blue, and a verdict word nobody had written. The number then read as "fair" in one
 * channel and "fine" in another on the same card.
 *
 * The middle band used to be a raw amber pair with a separate dark-mode override: two values to
 * keep in step by hand, neither contrast-checked against the planes this app actually draws on.
 * `wa-warning` is the single token already tuned for both themes.
 */
export type Band = 'strong' | 'fair' | 'weak' | 'unknown';

export function scoreBand(score: number | undefined): Band {
  if (score == null) return 'unknown';
  if (score >= 80) return 'strong';
  if (score >= 50) return 'fair';
  return 'weak';
}

const TEXT: Readonly<Record<Band, string>> = {
  strong: 'text-wa-success',
  fair: 'text-wa-warning',
  weak: 'text-wa-danger',
  unknown: 'text-wa-text-muted',
};

const FILL: Readonly<Record<Band, string>> = {
  strong: 'bg-wa-success',
  fair: 'bg-wa-warning',
  weak: 'bg-wa-danger',
  unknown: 'bg-wa-text-muted',
};

const STROKE: Readonly<Record<Band, string>> = {
  strong: 'stroke-wa-success',
  fair: 'stroke-wa-warning',
  weak: 'stroke-wa-danger',
  unknown: 'stroke-wa-text-muted',
};

export function scoreTone(score: number | undefined): string {
  return TEXT[scoreBand(score)];
}

/** For meters and posture dots. */
export function scoreFill(score: number | undefined): string {
  return FILL[scoreBand(score)];
}

/** For the trend line, which is drawn rather than filled. */
export function scoreStroke(score: number | undefined): string {
  return STROKE[scoreBand(score)];
}

/**
 * The band as a word.
 *
 * Withheld, not softened, when too little was measured: a pillar scored from a fifth of its
 * requirements has no verdict, and 'Poor' would be this app asserting one on the strength of the
 * four fifths it never read. That is the separation of posture from coverage the design kit
 * requires. The number stays readable with the range that shows how far it could move, while the
 * score strip mutes its posture colour and gives the space below it to the evidence-gap action.
 *
 * The range decides that, rather than a boolean the caller works out: given `isUncertain`, this
 * withheld the verdict from a tenth of a point of width upwards, which is every pillar that has one
 * requirement outstanding. `tooLittleMeasured` is the same band `rangeSentence` uses to switch from
 * stating the span to telling the reader to read the findings instead, so the word and the sentence
 * now say the same thing.
 *
 * Required rather than optional, even though `undefined` is a legitimate answer for a record written
 * before ranges were kept. Optional, it was omitted by two of the three callers and neither omission
 * was visible at the call site: the history list banded a run "Fair" while the overview withheld the
 * verdict on the same run, and the rail announced a pillar "Poor" that its own page declined to name.
 * A caller with nothing to pass now says so, and a fourth caller cannot inherit the defect silently.
 */
export function scoreVerdict(score: number | undefined, range: ScoreRange | undefined): string {
  if (score == null) return 'Not scored';
  if (tooLittleMeasured(range)) return 'Too little measured';
  return { strong: 'Good', fair: 'Fair', weak: 'Poor', unknown: 'Not scored' }[scoreBand(score)];
}

/**
 * What it means that one reading answers several requirements.
 *
 * The catalogue groups requirements this app cannot tell apart, and it does so for two reasons that
 * look the same from here. Sometimes the guidance repeats itself across pillars — infrastructure as
 * code is operational excellence *and* interoperability, and a customer reading either page should be
 * told to do it. Sometimes two neighbouring requirements have one reading between them: "establish
 * monitoring processes" and "use native and external tools for platform monitoring" are different
 * asks, and the only thing this app can measure about either is whether jobs carry health rules.
 *
 * Both end in the same place, which is why one sentence covers them: one reading, one verdict, one
 * fix, and a score that counts it once (`dedupeAliases` in the scorer). It says both halves because
 * either alone leaves the reader somewhere wrong — that the catalogue is duplicated, or that one
 * failure is being counted several times, and the second is the damaging one because it makes the
 * score look inflated.
 *
 * It talks about the measurement rather than about pillars, which the first draft got wrong: a pair
 * inside one pillar read "asked for by Operational excellence and Operational excellence".
 */
export function measuredTogether(requirements: number): string {
  const pair = requirements === 2;
  return (
    `One reading answers ${pair ? 'both' : `all ${requirements.toLocaleString()}`}, so they carry the same verdict ` +
    'and the same fix, and the score counts them once: an estate is not marked down ' +
    `${pair ? 'twice' : `${requirements.toLocaleString()} times`} for one thing being wrong.`
  );
}
