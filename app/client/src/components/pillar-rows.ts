// Every pillar, as one comparable row.
//
// Built here rather than in the component because two pages show this table and the rows must be
// identical on both: an overview that ranked pillars differently from the pillars page would be
// two answers to one question. It also puts the awkward part in one place — the seven official
// pillars are the catalogue's, not the score's, and a pillar this build does not measure has to
// appear as a row with an absence in it rather than vanish from the table or arrive as a zero.

import { confidenceOf, pillarCoverage, postureOf, unassessedCoverage } from './coverage';
import { pillarSeries } from './trend';
import type { Confidence, CoverageFacts, Posture } from './coverage';
import type { CatalogueResponse, PillarScore, Scan, ScanSummary, Severity } from '../api/types';

export interface PillarRow {
  readonly pillarId: string;
  readonly title: string;
  readonly coverage: CoverageFacts;
  readonly posture: Posture;
  readonly confidence: Confidence;
  /** Unmet requirements by severity, informational and low folded away as they do not rank. */
  readonly unmet: Readonly<Record<'critical' | 'high' | 'medium' | 'low', number>>;
  /** Movement against the last comparable run that measured this pillar. Absent when there is none. */
  readonly delta?: number;
  /** False when the build catalogues the pillar but runs no check for it. */
  readonly assessed: boolean;
  /** Where the row leads: the pillar's results, or what a scan would run for it. */
  readonly to: string;
}

export function pillarRows(
  scan: Scan | undefined,
  catalogue: CatalogueResponse | undefined,
  history: readonly ScanSummary[]
): readonly PillarRow[] {
  // The catalogue drives the order and the membership. Taking the score's pillars instead is how
  // the previous page came to show six of seven with a hole where the seventh should have been.
  const pillars = catalogue?.pillars ?? [];
  if (pillars.length === 0) {
    return (scan?.score.pillars ?? []).map((pillar) => row(pillar.pillarId, pillar.pillarId, pillar, scan, history));
  }

  return pillars.map((pillar) => {
    const scored = scan?.score.pillars.find((candidate) => candidate.pillarId === pillar.id);
    return row(pillar.id, pillar.title, scored, scan, history, controlCount(pillar));
  });
}

function controlCount(pillar: CatalogueResponse['pillars'][number]): number {
  return pillar.principles.reduce((total, principle) => total + principle.controls.length, 0);
}

function row(
  pillarId: string,
  title: string,
  pillar: PillarScore | undefined,
  scan: Scan | undefined,
  history: readonly ScanSummary[],
  catalogued = 0
): PillarRow {
  const coverage = pillar != null ? pillarCoverage(pillar) : unassessedCoverage(catalogued);
  const stamp = scan?.stamp;
  const delta = stamp == null ? undefined : pillarSeries(history, pillarId, stamp).delta;

  return {
    pillarId,
    title,
    coverage,
    posture: postureOf(pillar, coverage),
    confidence: confidenceOf(coverage),
    unmet: unmetBySeverity(pillar),
    ...(delta != null ? { delta } : {}),
    assessed: pillar != null,
    // A pillar with no results has nothing to explore, so its row leads to what a scan would run
    // for it instead of to an empty page.
    to: pillar != null ? `/pillars/${pillarId}` : `/checks?pillar=${pillarId}`,
  };
}

function unmetBySeverity(pillar: PillarScore | undefined): PillarRow['unmet'] {
  const of = (severity: Severity) =>
    (pillar?.worstFirst ?? []).filter((finding) => finding.severity === severity).length;

  return { critical: of('critical'), high: of('high'), medium: of('medium'), low: of('low') };
}

/** Worst first, for a page that wants the pillars that need attention at the top. */
export function byUrgency(rows: readonly PillarRow[]): readonly PillarRow[] {
  const weight = (pillarRow: PillarRow) =>
    pillarRow.unmet.critical * 1000 + pillarRow.unmet.high * 100 + pillarRow.unmet.medium * 10 + pillarRow.unmet.low;

  return [...rows].sort((a, b) => weight(b) - weight(a) || a.title.localeCompare(b.title));
}
