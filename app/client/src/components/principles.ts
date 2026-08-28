// Met rate per principle, computed once.
//
// Kept out of the component because it is arithmetic over findings, and arithmetic in a render body
// is arithmetic nobody can test. It needs the catalogue to say which requirement belongs to which
// principle, which is why it cannot be read off the score the way the counts can.
//
// This file was `pillar-focus.ts` and carried two more exports — an outcome distribution for a donut
// and an unmet-by-severity split — both for the overview's focus panel. That panel is gone: it said
// about one pillar what /pillars/:id says with room to spare, and it was doing so on the landing page
// at the cost of showing four of seven pillar scores. The distribution's donut went with it, the
// severity split duplicated the one in pillar-rows.ts, and what is left is the one calculation that
// had no other home.

import type { CatalogueResponse, Finding, Outcome } from '../api/types';

export interface PrincipleRow {
  readonly id: string;
  readonly title: string;
  /** Met as a share of the principle's own measured requirements, 0–100, absent when none were. */
  readonly percent?: number;
  readonly met: number;
  readonly measured: number;
  readonly total: number;
}

/**
 * Met-rate per principle, which is the reference's "score by category" with our own denominator.
 *
 * The denominator is the principle's *measured* requirements, not all of them, and the count of
 * each is carried alongside — a principle showing 100% from one of nine requirements is a
 * different statement from one showing 100% from nine, and a bar alone cannot tell them apart.
 */
export function principleRows(
  catalogue: CatalogueResponse | undefined,
  findings: readonly Finding[],
  pillarId: string
): readonly PrincipleRow[] {
  const pillar = catalogue?.pillars.find((entry) => entry.id === pillarId);
  if (pillar == null) return [];

  const byControl = new Map(findings.filter((finding) => finding.pillarId === pillarId).map((f) => [f.controlId, f]));

  return pillar.principles.map((principle) => {
    const outcomes = principle.controls
      .map((control) => byControl.get(control.id)?.outcome)
      .filter((outcome): outcome is Outcome => outcome != null);

    // Not-applicable requirements leave the denominator entirely; unmeasured ones are not measured.
    const measuredOutcomes = outcomes.filter((outcome) => outcome !== 'unmeasurable' && outcome !== 'not-applicable');
    const met = measuredOutcomes.filter(
      (outcome) => outcome === 'pass' || outcome === 'satisfied-by-architecture'
    ).length;
    // Partly met counts as half. Rounding it to met would report a partial control as compliant.
    const partial = measuredOutcomes.filter((outcome) => outcome === 'partial').length;

    return {
      id: principle.id,
      title: unnumbered(principle.title),
      met,
      measured: measuredOutcomes.length,
      total: principle.controls.length,
      ...(measuredOutcomes.length > 0 ? { percent: ((met + partial * 0.5) / measuredOutcomes.length) * 100 } : {}),
    };
  });
}

/**
 * A principle's name without the catalogue's ordinal.
 *
 * Databricks numbers its principles in their published titles ("1. Design for failure"). The number
 * is position in the source document, and in a list sorted by met rate it reads as a rank — so a
 * principle at 50% appearing above one at 0% looked like "1st place, 50%".
 */
function unnumbered(title: string): string {
  return title.replace(/^\s*\d+[.)]\s*/, '');
}
