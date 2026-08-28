// What one run changed against the run before it.
//
// The reason this is a module rather than a subtraction in the API layer: most of the work is
// deciding what a difference means, and only some of it is finding one. Three cases have to be
// kept apart or the page lies.
//
// A control that moved from met to not met is a change in the estate, which is what the reader
// came for. A control that appeared or disappeared is a change in the catalogue or in what the
// identity could read, not in the estate. And a pillar carried forward from an earlier run
// cannot have changed at all — its findings are the previous run's findings by construction, so
// reporting "no change" for it would be reporting the absence of a measurement as a result.
//
// The third case is the one a diff gets wrong by default, and it is now the normal case,
// because a targeted rerun carries most pillars forward.

import type { Catalogue } from '../catalogue/catalogue.js';
import { NO_CHANGELOG, spanBetween, type CatalogueChangelog } from '../catalogue/changelog.js';
import type { Outcome, Severity } from '../resolve/finding.js';
import { attribute, type Attribution } from './attribution.js';
import { comparable, type Scan } from './scan.js';

/** A control's outcome in a run, or its absence from one. */
export type Presence = Outcome | 'absent';

export interface ControlChange {
  readonly controlId: string;
  readonly title: string;
  readonly pillarId: string;
  readonly severity: Severity;
  readonly from: Presence;
  readonly to: Presence;
  /**
   * The id this requirement had in the earlier run, when the catalogue renumbered it.
   *
   * Carried so the transition can be shown as one requirement that moved rather than as a removal
   * beside an unrelated addition, and so a reader searching last quarter's pack for the old id
   * finds it.
   */
  readonly wasKnownAs?: string;
  /**
   * Which parts of this requirement's definition moved between the two catalogues.
   *
   * Present only when something did. It is the "refuse per control rather than per scan" half of the
   * contract: this transition is real, and how much of it is the estate cannot be established,
   * because the question changed at the same time as the answer.
   */
  readonly redefined?: readonly string[];
}

export interface RunChanges {
  /** False when the two runs cannot be compared. `reason` then says why, and `changes` is empty. */
  readonly comparable: boolean;
  readonly reason?: string;
  /** True about a permitted comparison that changes how to read it. */
  readonly caveat?: string;
  readonly previous?: { readonly id: string; readonly finishedAt: Date; readonly overall?: number };
  readonly overallDelta?: number;
  /**
   * How much of `overallDelta` is the estate and how much is the catalogue.
   *
   * Present only when the two runs were scored against different catalogue versions and the
   * difference between them is described. A comparison within one version needs no split, because
   * all of it is the estate.
   */
  readonly attribution?: Attribution;
  readonly changes: readonly ControlChange[];
  /**
   * Pillars whose findings this run did not measure, so no change in them could be observed.
   *
   * Named rather than omitted, because a reader looking at an unchanged pillar needs to know
   * whether it was measured and found the same or was not measured at all.
   */
  readonly unobserved: readonly string[];
}

/**
 * What changed between a run and the one before it.
 *
 * `previous` is the run immediately before by finish time, which the caller resolves — this
 * function does not go to the store, so it can be tested with two objects.
 */
export function changesBetween(
  scan: Scan,
  previous: Scan | undefined,
  // Narrowed to the fields this reads, so a caller can be tested without a whole catalogue
  // and so the dependency is legible from the signature.
  catalogue: Pick<Catalogue, 'controls'>,
  // Absent means no record of what any catalogue version changed, which is the state this app was
  // in before one existed: a comparison across a version is refused rather than attributed.
  changelog: CatalogueChangelog = NO_CHANGELOG
): RunChanges {
  if (previous == null) {
    return {
      comparable: false,
      reason: 'This is the first recorded run, so there is nothing to compare it against.',
      changes: [],
      unobserved: [],
    };
  }

  const span = spanBetween(changelog, previous.stamp.catalogueVersion, scan.stamp.catalogueVersion);
  const verdict = comparable(scan.stamp, previous.stamp, span);
  if (!verdict.ok) {
    return {
      comparable: false,
      ...(verdict.reason != null ? { reason: verdict.reason } : {}),
      previous: summary(previous),
      changes: [],
      unobserved: [],
    };
  }

  // A pillar this run carried forward holds the earlier run's findings verbatim, so any
  // comparison of it is a comparison of a result with itself.
  const carried = new Set(
    scan.measurement.filter((entry) => entry.carriedForward).map((entry) => entry.pillarId)
  );

  // Keyed on the later run's ids, so a requirement the catalogue renumbered is one row rather than
  // an addition beside a removal. `wasKnownAs` keeps the earlier name visible, because a reader
  // holding last quarter's pack is searching for it.
  const renamedFrom = new Map([...span.renamed].map(([from, to]) => [to, from]));
  const arrived = new Set(span.added);
  // An id the earlier catalogue used can be occupied by a different requirement at the later end,
  // two ways: a renumbering moved onto it, or a plain addition landed on it. Either way the earlier
  // run's finding for that id and the later run's finding for it are about different requirements,
  // and the title, pillar and severity the row would carry belong to the one that arrived — so the
  // departed one is left out rather than shown under a name that now means something else. It stays
  // counted in the caveat's tally of what left.
  //
  // Both cases, because catching only the renumbering was catching only the shape that had a test.
  // The addition shape reported the arriving requirement's number with the departed one's earlier
  // outcome — one row saying a requirement regressed, contradicting the caveat printed beside it,
  // and invisible altogether when the two outcomes happened to match.
  const occupied = new Set([...span.removed].filter((id) => renamedFrom.has(id) || arrived.has(id)));
  const before = new Map(
    previous.findings
      .filter((finding) => !occupied.has(finding.controlId))
      .map((finding) => [span.renamed.get(finding.controlId) ?? finding.controlId, finding.outcome])
  );
  const after = new Map(scan.findings.map((finding) => [finding.controlId, finding.outcome]));
  const titles = new Map(catalogue.controls.map((control) => [control.id, control]));
  const redefined = new Map(span.changed.map((change) => [change.id, change.fields]));

  const changes: ControlChange[] = [];
  for (const controlId of new Set([...before.keys(), ...after.keys()])) {
    const from = before.get(controlId) ?? 'absent';
    const to = after.get(controlId) ?? 'absent';
    if (from === to) continue;

    const control = titles.get(controlId);
    const was = renamedFrom.get(controlId);
    const fields = redefined.get(controlId);
    // A control absent from the catalogue is one the catalogue dropped between the runs.
    // Reported with its id rather than skipped, since a requirement disappearing is
    // exactly the kind of change a reader wants to see.
    changes.push({
      controlId,
      title: control?.title ?? controlId,
      pillarId: control?.pillarId ?? 'unknown',
      severity: control?.severity ?? 'informational',
      from,
      to,
      ...(was != null ? { wasKnownAs: was } : {}),
      ...(fields != null ? { redefined: fields } : {}),
    });
  }

  const overallDelta =
    scan.score.overall != null && previous.score.overall != null
      ? scan.score.overall - previous.score.overall
      : undefined;

  // Only across a version change. Within one version every requirement is asked in the same terms,
  // so a split would report a catalogue half of zero on every comparison and teach the reader to
  // stop reading it.
  const attribution =
    scan.stamp.catalogueFingerprint === previous.stamp.catalogueFingerprint
      ? undefined
      : attribute(scan, previous, span, aliasGroupOf(catalogue));

  return {
    comparable: true,
    ...(verdict.caveat != null ? { caveat: verdict.caveat } : {}),
    previous: summary(previous),
    ...(overallDelta != null ? { overallDelta } : {}),
    ...(attribution != null ? { attribution } : {}),
    // Sorted so the reader meets regressions first: a control that stopped being met is
    // more urgent than one that started.
    changes: changes.sort((a, b) => rank(a) - rank(b) || a.controlId.localeCompare(b.controlId)),
    unobserved: [...carried].sort(),
  };
}

/**
 * How to collapse requirements expressed in more than one pillar, for the re-score the split needs.
 *
 * Taken from the catalogue the comparison was drawn against, so the stable core is scored the way
 * the runs were. A re-score that double-counted a shared requirement would move the estate half by
 * the size of the overlap and blame the customer's platform for it.
 */
function aliasGroupOf(catalogue: Pick<Catalogue, 'controls'>): (controlId: string) => string | undefined {
  const groups = new Map(catalogue.controls.map((control) => [control.id, control.aliasGroup]));
  return (controlId: string) => groups.get(controlId);
}

function summary(scan: Scan): NonNullable<RunChanges['previous']> {
  return {
    id: scan.id,
    finishedAt: scan.finishedAt,
    ...(scan.score.overall != null ? { overall: scan.score.overall } : {}),
  };
}

/** Regressions, then things that stopped being measured, then improvements. */
function rank(change: ControlChange): number {
  const met = (presence: Presence) => presence === 'pass' || presence === 'satisfied-by-architecture';

  if (met(change.from) && !met(change.to)) return 0;
  if (change.to === 'absent' || change.to === 'unmeasurable') return 1;
  if (!met(change.from) && met(change.to)) return 3;
  return 2;
}
