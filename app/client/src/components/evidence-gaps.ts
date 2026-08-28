// Why the assessment is incomplete, in rows that add up.
//
// Separated from the component because the arithmetic here is the panel's whole claim and it was
// wrong: the rows were drawn from three different populations — the findings for the practices, the
// plan for the scopes, the signal log for the collectors — and printed under a header that names one
// of them. A reader saw "105 unanswered" above rows reading 67, 55 and 1, and the only question that
// invites is whether anything else in the document adds up either.
//
// The rule this module keeps: a row that shows a leading number is part of the header's count, and
// the numbers of those rows sum to it exactly. A row about something else — a collector that
// returned nothing, a pillar with no checks written, a requirement excluded from the score rather
// than left unanswered in it — carries its count inside its own sentence, so it can sit in the same
// list without joining the sum.

import type { Plan, Scan, Unmeasured } from '../api/types';

/**
 * As much of a run as this reads: the per-pillar split of what went unanswered, and the collectors
 * that returned nothing.
 *
 * Narrowed rather than taking a `Scan` so that a test can state a case in eight lines instead of
 * assembling 184 findings and a stamp to assert an addition. A `Scan` satisfies it structurally.
 */
export interface GapSource {
  readonly id: string;
  readonly score: {
    readonly pillars: readonly Pick<Scan['score']['pillars'][number], 'pillarId' | 'unmeasuredBy' | 'notApplicable'>[];
    /**
     * The number the panel puts in its header, carried so a test can check the rows against the total
     * rather than against the per-kind figures it built them from.
     *
     * The fixture derives this from the same object, so it is not an independent witness — what makes
     * it catch anything is that the derivation sums the complete `Record<Unmeasured, number>` while the
     * rows are enumerated by hand, so a kind with no row shows up as a shortfall. The identity between
     * the header and the server's own split is held elsewhere, by `score.test.ts`.
     *
     * Without it the sum test computed its expected total from the same per-pillar figures the rows
     * come from, so it could only catch a row double-counting — not a reason with no row at all,
     * which is how a fifth kind of unanswered arrived and left the rows adding up to less than the
     * header. Nothing here reads it except the assertion that they agree.
     */
    readonly counts: Pick<Scan['score']['counts'], 'unmeasurable'>;
  };
  readonly signals: readonly Pick<Scan['signals'][number], 'status' | 'unmeasurableReason'>[];
}

/** The pillars a scan's plan covers, and whether a check runs for any requirement in them. */
export interface GapPlan {
  readonly pillars: readonly Pick<Plan['pillars'][number], 'title' | 'measured' | 'totalControls'>[];
}

export interface Gap {
  readonly id: string;
  readonly title: string;
  readonly blocked: number;
  readonly pillars: readonly string[];
  /** What would resolve it, in the reader's terms. One sentence. */
  readonly resolve: string;
  /**
   * Whether this row is one of the unanswered requirements in the header.
   *
   * True for the five reasons a requirement can go unanswered, which partition that number. False
   * for a row counting something else, whose title states its own count.
   */
  readonly counted: boolean;
  readonly action?: { readonly label: string; readonly to: string };
}

/**
 * The reasons this run could not answer everything, worst first.
 *
 * Capped at five, because this renders in a rail as well as in the report and a sixth reason has
 * never been the one that changes what the reader does next.
 */
export function evidenceGaps(
  scan: GapSource,
  plan: GapPlan | undefined,
  pillarTitle: (pillarId: string) => string
): readonly Gap[] {
  const pillarsWith = (kind: Unmeasured) =>
    scan.score.pillars
      .filter((pillar) => (pillar.unmeasuredBy?.[kind] ?? 0) > 0)
      .map((pillar) => pillarTitle(pillar.pillarId));

  const total = (kind: Unmeasured) =>
    scan.score.pillars.reduce((sum, pillar) => sum + (pillar.unmeasuredBy?.[kind] ?? 0), 0);

  // Requirements that left the score rather than went unanswered inside it, so they are not in the
  // header's number and this row states its own, like the two below it.
  const excluded = scan.score.pillars.reduce((sum, pillar) => sum + (pillar.notApplicable ?? 0), 0);
  const excludedPillars = scan.score.pillars
    .filter((pillar) => (pillar.notApplicable ?? 0) > 0)
    .map((pillar) => pillarTitle(pillar.pillarId));

  // A pillar the build catalogues but never runs a check for is a gap of a different kind: not a
  // check that failed to answer, a pillar that was never asked. Its requirements are not in the
  // unanswered count at all, which is why this row states its own number.
  const unassessed = plan?.pillars.filter((pillarPlan) => !pillarPlan.measured) ?? [];
  const unassessedControls = unassessed.reduce((sum, pillarPlan) => sum + pillarPlan.totalControls, 0);

  const silent = scan.signals.filter((signal) => signal.status === 'unmeasurable');

  const gaps: readonly (Gap | undefined)[] = [
    total('attestation') > 0
      ? {
          id: 'attestation',
          title: 'Requirements only a person can confirm',
          blocked: total('attestation'),
          pillars: pillarsWith('attestation'),
          resolve:
            'These are practices — review cadences, ownership, documented procedures — that no telemetry can observe. They stay unanswered rather than being counted against you.',
          counted: true,
          action: { label: 'View requirements', to: '/investigate?outcome=unmeasurable' },
        }
      : undefined,

    /*
     * The scopes the platform does not offer an app.
     *
     * Counted from the findings, not from the plan. The plan's own figure for this is larger,
     * because a control it records as blocked by scope can still reach the reader as a question to
     * answer, and does: the reach classifier sends the non-grantable families to attestation. Taking
     * the plan's number here counted those controls twice — once as a scope nobody can grant and
     * again as a practice only a person can confirm — and the two rows then overran the header by
     * seventeen. The plan is right about what a scan can run; the findings are right about what this
     * run answered, and this panel is about the run.
     */
    total('unreachable') > 0
      ? {
          id: 'blocked-scope',
          title: 'Access no install of this app can hold',
          blocked: total('unreachable'),
          pillars: pillarsWith('unreachable'),
          resolve:
            'The platform does not offer these API scopes to apps, so no grant in your workspace would unblock them. Answer them yourself instead — there is nothing here to raise a support request for.',
          counted: true,
          action: { label: 'Answer these', to: '/answers' },
        }
      : undefined,

    total('unbuilt') > 0
      ? {
          id: 'unbuilt',
          title: 'No automated check in this version',
          blocked: total('unbuilt'),
          pillars: pillarsWith('unbuilt'),
          resolve: 'A check for these is not written yet. Nothing in your estate is blocking them.',
          counted: true,
          action: { label: 'See what a scan runs', to: '/checks' },
        }
      : undefined,

    total('unreadable') > 0
      ? {
          id: 'unreadable',
          title: 'Sources the scan could not read',
          blocked: total('unreadable'),
          pillars: pillarsWith('unreadable'),
          resolve:
            'The identity that ran the scan could not read the source behind these — a missing grant, or a table with no rows for the lookback period.',
          counted: true,
          action: { label: 'See what access is needed', to: '/checks' },
        }
      : undefined,

    unassessedControls > 0
      ? {
          id: 'unassessed-pillars',
          title: `${unassessedControls.toLocaleString()} requirements in ${
            unassessed.length === 1 ? 'a pillar' : `${String(unassessed.length)} pillars`
          } this version does not assess`,
          blocked: unassessedControls,
          pillars: unassessed.map((pillarPlan) => pillarPlan.title),
          resolve:
            'Catalogued, but no check runs for any requirement in them yet, so they are absent from the assessment rather than scored at zero.',
          counted: false,
          action: { label: 'See what a scan runs', to: '/checks' },
        }
      : undefined,

    /*
     * What left the score rather than went unanswered in it.
     *
     * Uncounted, because `counts.unmeasurable` does not include it and this panel's rule is that the
     * numerals add to the header. It is here because the panel reads as the account of why the
     * assessment is short, and an excluded requirement is short of the score as surely as an
     * unanswered one: the scheduled runs measured under `E1d` in docs/plan/e1-populations.md carried
     * 28 of them, and this panel named none.
     *
     * The sentence names both levers without apportioning them, because the field under it is one
     * total. Which requirements went, and under which, is in the export and on the pillar page.
     */
    excluded > 0
      ? {
          id: 'not-applicable',
          title: `${excluded.toLocaleString()} requirements that do not apply to this estate`,
          blocked: excluded,
          pillars: excludedPillars,
          resolve:
            'A precondition the scan read, or an applicability decision recorded in this install, put these outside the score entirely. They are excluded rather than unanswered.',
          counted: false,
          action: { label: 'View requirements', to: '/investigate?outcome=not-applicable' },
        }
      : undefined,

    /*
     * A row, and a counted one, though the first draft of this left it out on the grounds that a
     * check the customer switched off is neither blocked nor ours to resolve.
     *
     * That reasoning was about the sentence and the header does not care about the sentence. The
     * figure above these rows is `counts.unmeasurable`, which counts a disabled requirement like any
     * other, so leaving this out left the rows adding up to less than the number above them —
     * measured at 2 under a header of 5, where three requirements were disabled and two awaited an
     * answer. That is the arithmetic this module exists to keep, and a reader who finds it broken has
     * no way to tell which of the two numbers to believe.
     *
     * What the original objection was right about is the wording, so this row says what was done and
     * what it costs rather than offering to fix it, and it carries no action: the place to see the
     * owner, the reason and the dates is row 31b's own surface, which does not exist yet.
     */
    total('disabled') > 0
      ? {
          id: 'disabled',
          // "Requirements", like its siblings, because the count beside it is of requirements. An alias
          // group means one check can serve several, so a count of checks would be a different number.
          title: 'Requirements whose check is switched off here',
          blocked: total('disabled'),
          pillars: pillarsWith('disabled'),
          resolve: 'This install has the check for these switched off, so this run did not score them.',
          counted: true,
        }
      : undefined,

    silent.length > 0
      ? {
          id: 'silent-signals',
          title: `${silent.length === 1 ? 'One collector' : `${String(silent.length)} collectors`} returned nothing`,
          blocked: silent.length,
          pillars: [],
          resolve: silent[0]?.unmeasurableReason ?? 'The collector ran and produced no usable observation.',
          counted: false,
          action: { label: 'See the run record', to: `/history/${scan.id}` },
        }
      : undefined,
  ];

  // Counted rows first, then by size. The cap and the header's claim are in tension: there are eight
  // possible rows and five may be shown, so truncating by size alone can drop a counted reason and
  // leave the remaining rows adding up to less than the number above them. Five counted reasons and a
  // cap of five is not a coincidence to rely on, but it does mean this ordering makes the sum hold in
  // every case rather than in most.
  //
  // What gets dropped is dropped silently, and that is a gap rather than a design. `EvidenceGaps`
  // computes its "more reasons" foot from what fits the viewport, against a list this function has
  // already capped, so a run with eight reasons shows five and says nothing about the other three.
  // The cap predates this row; the foot not covering it is worth fixing where the foot is.
  return gaps
    .filter((gap): gap is Gap => gap != null)
    .sort((a, b) => Number(b.counted) - Number(a.counted) || b.blocked - a.blocked)
    .slice(0, 5);
}

/** Bounded: five pillar names in a caption is a paragraph nobody reads. */
export function pillarList(pillars: readonly string[]): string {
  if (pillars.length === 0) return 'Across the estate';
  if (pillars.length <= 2) return pillars.join(' and ');
  return `${pillars.slice(0, 2).join(', ')} and ${String(pillars.length - 2)} more`;
}
