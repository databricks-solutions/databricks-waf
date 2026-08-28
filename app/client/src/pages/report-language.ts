// The sentences and the tabulated facts a printed review is made of.
//
// Kept out of the page so they can be asserted rather than eyeballed, on the same reasoning as
// run-language: this is the copy that leaves the building. A screen the reader can re-open is
// forgiving of an awkward phrase; a PDF forwarded to a steering group is not, and neither is one
// that says "measured by the signed-in user" about a nightly service principal.
//
// The facts are a list of label-value pairs rather than a formatted block because the same set is
// wanted twice — as a table on the page and as prose in the summary — and deriving one from the
// other is what stops the two disagreeing about, say, which catalogue produced the findings.

import { estateCoverage } from '../components/coverage';
import { actorName, startedBy } from './run-language';
import type { Finding, Outcome, Scan, Score, Unmeasured } from '../api/types';
import { methodologyLabel } from '../methodology-identity';

/** As much of a run as this module reads. Narrowed so a test can state a case in ten lines. */
export type ReportedRun = Pick<Scan, 'id' | 'finishedAt' | 'stamp'>;

/** As much of a requirement's result as the appendix shows. */
export type ReportedFinding = Pick<Finding, 'controlId' | 'pillarId' | 'title' | 'outcome'> &
  Partial<Pick<Finding, 'outcomeReason' | 'unmeasured'>>;

/** A pillar, as the appendix needs it: an order and a name. */
export interface ReportedPillar {
  readonly id: string;
  readonly title: string;
}

export interface Fact {
  readonly label: string;
  readonly value: string;
}

/**
 * The run's identity, as the reader would have to state it to reproduce the run.
 *
 * Every entry is a reason two reports are not comparable: a different identity sees a different
 * estate, a different lookback measures a different period, a different catalogue asks different
 * questions. A report that carried the date alone would invite exactly the comparison it cannot
 * support.
 */
export function stampFacts(scan: ReportedRun): readonly Fact[] {
  const stamp = scan.stamp;
  const how = startedBy(stamp);

  return [
    { label: 'Measured', value: when(scan.finishedAt) },
    // The identity, not the person who printed it. These are the same on an interactive run and
    // routinely different on a scheduled one, and the findings belong to the former.
    { label: 'Ran as', value: actorName(stamp) },
    ...(how != null ? [{ label: 'Started', value: how }] : []),
    { label: 'Scope', value: stamp.scope.description },
    ...(stamp.assessedWorkspaces != null
      ? [{ label: 'Workspaces assessed', value: stamp.assessedWorkspaces.length.toLocaleString() }]
      : []),
    { label: 'Lookback', value: `${stamp.lookbackDays.toLocaleString()} days` },
    { label: 'Methodology', value: methodologyLabel(stamp) },
    ...(stamp.publicMethodology != null
      ? [{ label: 'Methodology manifest', value: stamp.publicMethodology.manifestDigest }]
      : [{ label: 'Methodology manifest', value: 'Not recorded on this pre-release development run' }]),
    ...(stamp.publicMethodology?.effectiveDate != null
      ? [{ label: 'Effective', value: stamp.publicMethodology.effectiveDate }]
      : []),
    // Technical provenance, not the customer release. The short fingerprint distinguishes two
    // catalogue shapes while the full public manifest above identifies the released standard.
    { label: 'Technical catalogue', value: `revision ${stamp.catalogueVersion} · ${digest(stamp.catalogueFingerprint)}` },
    // Printed so a reader holding both this and the spreadsheet can tell whether they are looking
    // at one run or two. It is the only opaque string in the block, and it earns its place there.
    { label: 'Run', value: scan.id },
  ];
}

function when(at: string): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });
}

/**
 * Enough of a hash to tell two catalogues apart, without the algorithm that produced it.
 *
 * The fingerprint arrives as `sha256:<64 hex>`, and the first draft of this line printed the first
 * eight characters of that — `sha256:5`, which distinguishes nothing from nothing. The algorithm is
 * a property of the app, identical in every report it will ever print; the digest is the part that
 * differs, so the digest is the part that shows.
 */
function digest(fingerprint: string): string {
  return fingerprint.replace(/^[a-z0-9]+:/i, '').slice(0, 12);
}

/**
 * What the document is, in the two sentences a reader gives it before deciding to read on.
 *
 * States the denominator in the first sentence, because the number this report leads with is
 * computed from the requirements that were measured and from no others — and a reader who takes
 * the score without that clause has been misled by a document that was accurate.
 */
export function reportPurpose(score: Score): string {
  const coverage = estateCoverage(score);
  const measured = `${coverage.assessed.toLocaleString()} of the ${coverage.applicable.toLocaleString()} requirements that apply to this estate`;

  return (
    `This review assesses ${measured}, against the Databricks Well-Architected Framework. ` +
    'Every figure in it comes from the single run recorded below; nothing is aggregated across ' +
    'runs, and nothing was edited after the run finished.'
  );
}

/**
 * The order the findings are presented in, and why the reader should trust it.
 *
 * Written out because a list of thirty findings is only actionable if its order means something,
 * and the reader has no way to tell a ranked list from an arbitrary one by looking at it.
 */
export const RANKING_NOTE =
  'Ordered by severity, then by how many resources are affected, then by how good the evidence is, ' +
  'then by whether a fix is written down. Two findings of equal severity are not equal work, and ' +
  'this order puts the one that can be closed today first.';

/**
 * Why the list above is shorter than the failure count, when decisions have moved things out of it.
 *
 * Printed only when something was actually held back. The document has to account for the
 * difference: a reader comparing "what to fix" against the census in the appendix will find more
 * failures than fixes listed, and an unexplained gap in a document sent to a steering group is read
 * as an omission rather than as a decision.
 */
export function heldNote(count: number): string {
  return (
    `${count === 1 ? 'One further requirement is' : `A further ${count.toLocaleString()} requirements are`} unmet and ` +
    'held by a recorded decision — accepted, planned for later, or reported fixed. They are listed after this ' +
    'section, and they still count against the score exactly as the ones above do.'
  );
}

/**
 * The whole note above "What to fix": the order, and each reason this list is shorter than the census.
 *
 * Composed here rather than in the page, because it is three sentences that only sometimes appear and
 * the page had already grown a nested conditional to choose between two of them. A third would have
 * made four branches, of which the page tested none.
 */
export function fixNote(short: { readonly held: readonly unknown[]; readonly grouped: number }): string {
  return [
    RANKING_NOTE,
    short.held.length > 0 ? heldNote(short.held.length) : undefined,
    short.grouped > 0 ? groupedNote(short.grouped) : undefined,
  ]
    .filter((one) => one != null)
    .join(' ');
}

/**
 * Why the list above is shorter than the appendix for a second reason: a requirement two pillars ask
 * for is listed once.
 *
 * Printed only when the run actually holds one, and it accounts for the same kind of gap `heldNote`
 * accounts for. The appendix is the census — one row per entry in the catalogue, matching the export —
 * and this section is the work, where listing infrastructure as code twice under two pillar headings
 * would have a steering group asking which of the two to fix. Both numbers are right and a document
 * that prints them without saying why they differ has invited the reader to find the discrepancy
 * themselves, in a meeting.
 */
export function groupedNote(count: number): string {
  return (
    `${count === 1 ? 'One requirement above is' : `${count.toLocaleString()} requirements above are`} asked for by ` +
    'more than one pillar. The appendix lists every pillar’s own entry, as the exported file does; this section ' +
    'lists the requirement once, which is also how the score counts it.'
  );
}

/**
 * What the decisions section is, said before it rather than in a caption inside it.
 *
 * The sentence that stops this being read as a list of solved problems. Each entry is a failure
 * somebody chose not to fix now, with the reason and the date they chose, which is the material a
 * review is supposed to challenge.
 */
export const DECISIONS_NOTE =
  'Each of these is unmet and has a decision recorded against it: the reason, who is answerable, and ' +
  'the date it comes back. Nothing here is fixed by being listed — where a fix was reported and the ' +
  'run disagreed, that is stated on the entry.';

/** Why a requirement went unanswered, in the words the appendix column uses. */
const UNMEASURED_WORD: Readonly<Record<Unmeasured, string>> = {
  attestation: 'needs an answer from a person',
  unreachable: 'no app can read this',
  unbuilt: 'no check written yet',
  unreadable: 'the source could not be read',
  disabled: 'switched off in this install',
};

export interface AppendixRow {
  readonly controlId: string;
  readonly title: string;
  readonly pillar: string;
  readonly outcome: Outcome;
  /** Why it is unknown, for the unmeasured. Empty for every other outcome. */
  readonly because: string;
}

/**
 * Every requirement the run considered, once, in the catalogue's own order.
 *
 * The appendix exists because the body of the report is a selection — the failures, ranked — and a
 * selection invites the question the body cannot answer: what about the rest. Sorting by pillar
 * then by identifier rather than by outcome is deliberate; grouping the failures together again
 * here would make this a second copy of the body instead of a census.
 */
export function appendixRows(
  findings: readonly ReportedFinding[],
  pillars: readonly ReportedPillar[]
): readonly AppendixRow[] {
  const order = new Map(pillars.map((pillar, index) => [pillar.id, index]));
  const title = new Map(pillars.map((pillar) => [pillar.id, pillar.title]));

  return [...findings]
    .sort(
      (a, b) =>
        (order.get(a.pillarId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.pillarId) ?? Number.MAX_SAFE_INTEGER) ||
        a.controlId.localeCompare(b.controlId)
    )
    .map((finding) => ({
      controlId: finding.controlId,
      title: finding.title,
      pillar: title.get(finding.pillarId) ?? finding.pillarId,
      outcome: finding.outcome,
      because: reason(finding),
    }));
}

function reason(finding: ReportedFinding): string {
  if (finding.outcome === 'not-applicable') return firstSentence(finding.outcomeReason ?? '');
  if (finding.outcome !== 'unmeasurable') return '';
  return finding.unmeasured != null ? UNMEASURED_WORD[finding.unmeasured] : 'no reason recorded';
}

/**
 * The reason, cut to its first sentence.
 *
 * An exclusion reason runs to three sentences because on the pillar page it is the whole
 * explanation. In a 184-row census it is a column, and printed in full it took eleven lines per row
 * and turned two pages of the appendix into five. The first sentence is the reason; the rest is the
 * justification, and the reader who wants it has the section above.
 */
function firstSentence(text: string): string {
  const end = text.search(/[.:]\s/);
  return end === -1 ? text : text.slice(0, end + 1);
}
