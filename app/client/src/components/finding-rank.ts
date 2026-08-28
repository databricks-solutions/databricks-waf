// Which five findings to show, out of a hundred and forty-eight.
//
// Severity alone is not an order of work. Two high findings where one affects twelve workloads on
// complete evidence and the other affects one on a sample are not the same call to action, and a
// list sorted by severity presents them as though they were. So the rank is severity first — that
// is what severity is for — then blast radius, then how good the evidence is, then whether a fix
// is written down. The last of those is the tie-break that makes the list actionable rather than
// merely accurate: between two equivalent findings, the one with a scripted remediation is the one
// a reader can close today.
//
// Every input is measured. Nothing here estimates effort in hours or invents a risk score: the
// affected count comes from the coverage the collector recorded, and the fix rating comes from
// whether the catalogue actually carries a statement to run.
//
// One row is one requirement, not one catalogue entry. Where two pillars ask for the same thing the
// catalogue holds both — deliberately, so a reader on either pillar's page finds it — and the scorer
// has always credited the pair once. The queue did not, so its top spent two slots on one title and
// its count read two higher than the score's. See `oneRowPerRequirement`.

import type { CatalogueControl, Decision, Finding, Severity } from '../api/types';

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  informational: 4,
};

/** How good the evidence behind one finding is. Not the same question as pillar confidence. */
export type EvidenceConfidence = 'complete' | 'sampled' | 'thin';

/** Whether there is something to run, something to read, or nothing. */
export type FixAvailability = 'scripted' | 'documented' | 'none';

export interface RankedFinding {
  readonly finding: Finding;
  /** How many resources the finding was observed across, when the collector counted them. */
  readonly affected?: number;
  readonly population?: number;
  readonly confidence: EvidenceConfidence;
  readonly fix: FixAvailability;
  /** What somebody decided about it, where a decision has been recorded. */
  readonly decision?: Decision;
  /**
   * The other requirements in this row, where a pillar asked for the same thing under its own id.
   *
   * Absent for all but a dozen requirements. Present, it is what lets the row say it stands for more
   * than one entry in the catalogue rather than looking like the list has a duplicate in it.
   */
  readonly alsoNamed?: readonly AlsoNamed[];
}

/** One of the other pillars asking for this requirement, and what it calls it. */
export interface AlsoNamed {
  readonly controlId: string;
  readonly pillarId: string;
}

export interface Ranking {
  /** The findings to work through, in order. */
  readonly queue: readonly RankedFinding[];
  /**
   * Findings a live decision is holding back, in the same order.
   *
   * Returned rather than dropped, because a queue that silently omits rows is a queue whose length
   * nobody can reconcile with the findings page. The caller shows the count, and can show the rows.
   */
  readonly held: readonly RankedFinding[];
}

/**
 * Which findings to work through, and in what order.
 *
 * Two things changed when decisions arrived, and both are about the queue rather than the score.
 * A finding somebody has accepted, planned or claimed to have fixed comes out of the queue until its
 * date passes, because a list that never responds to work done against it is a list people stop
 * reading. And a claimed fix the estate contradicts goes to the top regardless of severity — it is
 * the one row on the page that is genuinely news, and the reader who recorded the claim is the
 * reader who most needs to know it did not take.
 */
export function rankFindings(
  findings: readonly Finding[],
  controlOf: (controlId: string) => CatalogueControl | undefined,
  decisionOf: (controlId: string) => Decision | undefined = () => undefined
): readonly RankedFinding[] {
  return splitFindings(findings, controlOf, decisionOf).queue;
}

export function splitFindings(
  findings: readonly Finding[],
  controlOf: (controlId: string) => CatalogueControl | undefined,
  decisionOf: (controlId: string) => Decision | undefined = () => undefined
): Ranking {
  const ranked = oneRowPerRequirement(
    findings.filter((finding) => finding.outcome === 'fail' || finding.outcome === 'partial'),
    controlOf
  )
    .map(({ finding, alsoNamed }) => ({
      ...describe(finding, controlOf(finding.controlId), decisionOf(finding.controlId)),
      ...(alsoNamed.length > 0 ? { alsoNamed } : {}),
    }))
    .sort(
      (a, b) =>
        contradictedRank(a) - contradictedRank(b) ||
        SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
        (b.affected ?? 0) - (a.affected ?? 0) ||
        confidenceRank(a.confidence) - confidenceRank(b.confidence) ||
        fixRank(a.fix) - fixRank(b.fix) ||
        a.finding.controlId.localeCompare(b.finding.controlId)
    );

  return {
    queue: ranked.filter((entry) => entry.decision?.parked !== true),
    held: ranked.filter((entry) => entry.decision?.parked === true),
  };
}

/** A fix that was claimed and did not take, first. Nothing else in the estate is newer news. */
function contradictedRank(entry: RankedFinding): number {
  return entry.decision?.standing === 'contradicted' ? 0 : 1;
}

/**
 * One row per requirement, where the catalogue expresses a requirement as several controls.
 *
 * Two pillars asking for the same thing is deliberate in the catalogue and correct on a pillar's own
 * page: interoperability lists infrastructure as code, so does operational excellence, and a reader on
 * either should find it. A queue of work across the whole estate is the one place it is wrong. Twenty
 * unmet requirements in a labs run were eighteen: "Use infrastructure as code" and "Manage Delta
 * history" each appeared twice, under one title, differing only in a pillar label the row truncates —
 * so the top of the queue spent two of its slots restating itself, and the count above it said twenty
 * where the score, which has always credited an alias group once, said eighteen. Of two numbers for one
 * estate the alarming one gets believed, and it was the wrong one.
 *
 * The worst reading wins, which is the rule `dedupeAliases` in the scorer uses. It has to be the same
 * rule: if the queue kept the interoperability reading and the score kept the operational-excellence
 * one, a reader could open the row the list called partial and find the pane calling it failed.
 *
 * Scoped to the findings it is given, which is what makes it safe on a filtered list. Filtered to one
 * pillar there is only ever one member of a group present, so nothing is folded and nothing is hidden —
 * the pillar's own entry is the row, under the id that pillar knows it by.
 */
function oneRowPerRequirement(
  findings: readonly Finding[],
  controlOf: (controlId: string) => CatalogueControl | undefined
): readonly { readonly finding: Finding; readonly alsoNamed: readonly AlsoNamed[] }[] {
  /** Group id to the findings expressing it, in the order they arrived. */
  const groups = new Map<string, Finding[]>();
  const rows: { finding: Finding; group?: string }[] = [];

  for (const finding of findings) {
    const group = controlOf(finding.controlId)?.aliasGroup;
    if (group == null) {
      rows.push({ finding });
      continue;
    }
    const kin = groups.get(group);
    if (kin == null) {
      groups.set(group, [finding]);
      rows.push({ finding, group });
      continue;
    }
    kin.push(finding);
  }

  return rows.map(({ finding, group }) => {
    const kin = group == null ? [finding] : (groups.get(group) ?? [finding]);
    // The worst outcome, then the lowest id, so a run with two partials folds the same way twice.
    const worst = [...kin].sort((a, b) => weigh(a.outcome) - weigh(b.outcome) || a.controlId.localeCompare(b.controlId));
    const stands = worst[0] ?? finding;
    return {
      finding: stands,
      alsoNamed: kin
        .filter((one) => one.controlId !== stands.controlId)
        .map((one) => ({ controlId: one.controlId, pillarId: one.pillarId })),
    };
  });
}

/**
 * Which of two readings of one requirement is the one to show. Failed beats everything else.
 *
 * Only `fail` and `partial` reach this, because `splitFindings` has already dropped the rest — so this
 * is two cases written as a comparison rather than a table with four rows nothing exercises.
 */
function weigh(outcome: Finding['outcome']): number {
  return outcome === 'fail' ? 0 : 1;
}

function describe(finding: Finding, control: CatalogueControl | undefined, decision?: Decision): RankedFinding {
  const { coverage } = finding;

  return {
    finding,
    ...(coverage.examined != null ? { affected: coverage.examined } : {}),
    ...(coverage.population != null ? { population: coverage.population } : {}),
    confidence: confidenceOfEvidence(finding),
    fix: fixOf(control),
    ...(decision != null ? { decision } : {}),
  };
}

function confidenceOfEvidence(finding: Finding): EvidenceConfidence {
  // A finding with no evidence at all is a resolver's default rather than an observation, and it
  // must not outrank an observed one on the strength of its severity alone.
  if (finding.evidence.length === 0) return 'thin';
  return finding.coverage.mode === 'sampled' ? 'sampled' : 'complete';
}

function fixOf(control: CatalogueControl | undefined): FixAvailability {
  const remediation = control?.remediation;
  if (remediation == null) return 'none';
  if (remediation.sql != null || remediation.cli != null || remediation.terraform != null) return 'scripted';
  if (remediation.summary != null || remediation.docUrl != null || remediation.deepLink != null) return 'documented';
  return 'none';
}

function confidenceRank(confidence: EvidenceConfidence): number {
  return confidence === 'complete' ? 0 : confidence === 'sampled' ? 1 : 2;
}

function fixRank(fix: FixAvailability): number {
  return fix === 'scripted' ? 0 : fix === 'documented' ? 1 : 2;
}

export const CONFIDENCE_PHRASE: Readonly<Record<EvidenceConfidence, string>> = {
  complete: 'Complete evidence',
  sampled: 'Sampled evidence',
  thin: 'No evidence recorded',
};

export const FIX_PHRASE: Readonly<Record<FixAvailability, string>> = {
  scripted: 'Fix is scripted',
  documented: 'Fix is documented',
  none: 'No fix documented',
};

/** "12 of 40 workloads", or nothing when the collector did not count. */
export function affectedPhrase(ranked: RankedFinding, noun = 'resources'): string | undefined {
  if (ranked.affected == null) return undefined;
  if (ranked.population == null) return `${ranked.affected.toLocaleString()} ${noun} affected`;
  return `${ranked.affected.toLocaleString()} of ${ranked.population.toLocaleString()} ${noun}`;
}
