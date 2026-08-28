// How much of a score's movement is the estate, and how much is the catalogue.
//
// "Down four points" is not a finding. "Down four points: three because two new critical
// requirements arrived, one because a warehouse regressed" is one, and it is the sentence a customer
// can take into a review. The difference between the two is this module.
//
// The split is arithmetic over a stable core rather than an estimate. Both runs are re-scored over
// exactly the requirements that existed in both catalogues, at the same weight, judged against the
// same thresholds — so the movement between those two numbers cannot be the catalogue, because
// nothing about those requirements moved. Everything else in the total is what the catalogue did.
//
// Two things are deliberately not attempted.
//
// It does not apportion the catalogue half across the individual requirements that arrived or left.
// A score is a mean of pillar means, so an added control's contribution is not a number that exists
// independently of every other control in its pillar; a per-control breakdown would be a plausible
// invention. The counts are reported instead, which is what a reader checks the figure against.
//
// It does not treat a requirement whose weight or thresholds moved as part of the estate half. The
// same estate scores differently under a rescoped requirement, so folding it in would attribute a
// change of question to the customer's platform. Those go in the catalogue half with the additions,
// which is a slightly pessimistic reading of the estate half and the right way round to be wrong.

import type { CatalogueSpan } from '../catalogue/changelog.js';
import type { Finding } from '../resolve/finding.js';
import { scoreFindings } from '../score/score.js';
import type { Scan } from './scan.js';

/** How a score's movement divides between the estate and the requirement set. */
export interface Attribution {
  /** The movement over requirements that both runs asked in the same terms. */
  readonly estate: number;
  /** The rest of the movement: requirements that arrived, left, or changed what they ask. */
  readonly catalogue: number;
  /** How many requirements both runs asked identically, which is what `estate` is out of. */
  readonly stable: number;
  readonly added: number;
  readonly removed: number;
  readonly renamed: number;
  /** Requirements in both catalogues whose weight, scope or thresholds moved. */
  readonly reweighted: number;
}

/**
 * The movement split, or nothing when it cannot be established.
 *
 * Absent rather than zeroed when either run has no overall score, or when the two catalogues share
 * no requirement asked in the same terms. A zero would say the estate did not move, which is a
 * claim; absence says nobody can tell, which is the fact.
 */
export function attribute(
  later: Scan,
  earlier: Scan,
  span: CatalogueSpan,
  aliasGroupOf?: (controlId: string) => string | undefined
): Attribution | undefined {
  const overall = later.score.overall;
  const before = earlier.score.overall;
  if (overall == null || before == null) return undefined;

  const stable = stableControls(later, earlier, span);
  if (stable.size === 0) return undefined;

  const options = aliasGroupOf != null ? { aliasGroupOf } : {};
  const laterCore = scoreFindings(
    later.findings.filter((finding) => stable.has(finding.controlId)),
    options
  );
  // The earlier run's findings under their later ids, so a renumbered requirement is scored as one
  // requirement rather than dropped from both sides for having two names.
  const earlierCore = scoreFindings(
    asLater(earlier.findings, span).filter((finding) => stable.has(finding.controlId)),
    options
  );

  if (laterCore.overall == null || earlierCore.overall == null) return undefined;

  const estate = round(laterCore.overall - earlierCore.overall);
  return {
    estate,
    // Derived by subtraction rather than computed independently, so the two halves add up to the
    // number on the page by construction. Two independent computations that ought to sum to a third
    // is three places for a rounding difference to become a visible contradiction.
    catalogue: round(overall - before - estate),
    // Scored units, not control ids. `scoreFindings` collapses an alias group to one unit — two
    // requirements asking the same question of the same reading count once — so counting ids here
    // would make the page say the estate half was measured over more requirements than it was.
    stable: scoredUnits(stable, aliasGroupOf),
    added: span.added.length,
    removed: span.removed.length,
    renamed: span.renamed.size,
    reweighted: span.changed.length,
  };
}

/** How many things the score is out of, which is one per alias group and one per ungrouped control. */
function scoredUnits(stable: ReadonlySet<string>, aliasGroupOf?: (controlId: string) => string | undefined): number {
  const units = new Set<string>();
  for (const id of stable) units.add(aliasGroupOf?.(id) ?? id);
  return units.size;
}

/**
 * The requirements both runs asked in the same terms, under the later run's ids.
 *
 * Three exclusions, and each is a way the arithmetic would otherwise attribute a change of question
 * to the estate: a requirement only one catalogue has, a requirement whose scoring shape moved, and
 * a requirement only one of the two runs produced a finding for — which is this identity's grants or
 * a collector's reach rather than the catalogue, but it is equally not a like-for-like comparison.
 */
function stableControls(later: Scan, earlier: Scan, span: CatalogueSpan): ReadonlySet<string> {
  const moved = new Set(span.changed.map((change) => change.id));
  const arrived = new Set(span.added);
  const inEarlier = new Set(asLater(earlier.findings, span).map((finding) => finding.controlId));

  const stable = new Set<string>();
  for (const finding of later.findings) {
    const id = finding.controlId;
    if (arrived.has(id) || moved.has(id) || !inEarlier.has(id)) continue;
    stable.add(id);
  }
  return stable;
}

/**
 * The earlier run's findings restated under the ids the later catalogue uses.
 *
 * Findings for requirements the span records as gone are dropped rather than carried, and that is
 * load-bearing beyond tidiness. Positional ids get reused: a requirement can leave and a renumbered
 * one can take the number it vacated later in the same span. Carrying both would put two findings on
 * one id, and scoring the pair would read the difference between two unrelated requirements as the
 * customer's estate moving. Dropped, the vacated id is simply not comparable, which is the truth.
 */
function asLater(findings: readonly Finding[], span: CatalogueSpan): readonly Finding[] {
  const gone = new Set(span.removed);
  const restated: Finding[] = [];
  for (const finding of findings) {
    if (gone.has(finding.controlId)) continue;
    const renamed = span.renamed.get(finding.controlId);
    restated.push(renamed == null ? finding : { ...finding, controlId: renamed });
  }
  return restated;
}

/** Two places, as scores are reported, so the two halves sum to the total the reader sees. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
