// What the scan was a scan of, in workspaces.
//
// Correct numbers are not the same as explained numbers. The live-workspace filter took a
// finding from "0 of 68 warehouses" to "0 of 4", which is right — 58 of those workspaces
// had been cancelled and 6 were banned — but a user who saw both would reasonably conclude
// the tool had lost most of their estate. So the workspace set is reported alongside the
// score: how many the account has, which were assessed, and which were skipped and why.
//
// Derived rather than asserted. The count comes from the directory signal the scan already
// collects, so if that statement failed the summary says the set is undetermined instead of
// printing a number nobody measured.
//
// Region is part of the same problem and was briefly not part of this summary. The compute tables are
// regional, so a deployment assesses one region of a multi-region account; when that filter was applied
// to the queries alone, this said "Assessed 15 workspaces" over a scan that had covered 5. The directory
// now carries the region partition (see collect/sql/region.ts) and this reports it, because a coverage
// claim that is only true of part of the account has to say which part.

import type { SignalId, SignalResult } from '../collect/signal.js';
import type { ExcludedWorkspace, ExclusionReason, WorkspaceDirectory, WorkspaceRow } from '../collect/sql/shapes.js';

const DIRECTORY: SignalId = 'sql:estate.workspaces';

export interface WorkspaceRef {
  readonly id: string;
  readonly name: string;
  readonly url?: string;
  /** RUNNING, BANNED, FAILED, PROVISIONING or NOT_PROVISIONED. */
  readonly status: string;
  /**
   * Why it was excluded, on excluded workspaces only.
   *
   * Carried because status is not the reason for all of them: a workspace excluded for its region is
   * `RUNNING`, and listing it as excluded with RUNNING beside it explains nothing. Absent on assessed
   * workspaces, where there is nothing to explain.
   */
  readonly reason?: ExclusionReason;
}

export interface EstateSummary {
  /** Workspaces still in the account. Absent when the directory could not be read. */
  readonly workspacesInAccount?: number;
  readonly assessed: readonly WorkspaceRef[];
  /** Present in the account but not assessable, each carrying which reason applies. */
  readonly excluded: readonly WorkspaceRef[];
  /**
   * Of the assessed, how many had no readable region.
   *
   * These are assessed on the grounds that no evidence places them elsewhere, which is weaker than the
   * grounds for the rest, so the number is reported rather than folded into the total.
   */
  readonly regionUnverified?: number;
  /**
   * Assessable, and outside the scope this run was asked for.
   *
   * Absent on an unnarrowed scan. Named workspaces rather than a count, for two readers: the account
   * total only reconciles with them — assessed, excluded and these sum to `workspacesInAccount`, and a
   * summary that presented a correct total the reader could not check would be the failure this whole
   * summary exists to avoid — and the workspace picker is built from a stored estate, so a count would
   * leave an author unable to select the workspace their next definition should cover.
   */
  readonly outOfScope?: readonly WorkspaceRef[];
  /** The region this scan was scoped to, when it could be established. */
  readonly region?: string;
  /**
   * Why the workspace set is unknown, when it is. Its presence also means the account-reach
   * signals ran unfiltered, so their counts may include cancelled workspaces.
   */
  readonly undeterminedReason?: string;
}

export function summariseEstate(signals: ReadonlyMap<SignalId, SignalResult>): EstateSummary {
  const signal = signals.get(DIRECTORY);

  if (signal == null) {
    return {
      assessed: [],
      excluded: [],
      undeterminedReason:
        'The workspace directory was not collected, so this scan cannot say how many workspaces it covered.',
    };
  }

  if (signal.status !== 'observed') {
    return {
      assessed: [],
      excluded: [],
      // The collector's own reason, which names the missing grant or unreadable table
      // rather than leaving the reader to guess. Counts widened rather than failing, and
      // saying so here is the only place that widening becomes visible.
      undeterminedReason:
        `${signal.unmeasurableReason ?? 'The workspace directory could not be read.'} ` +
        'Resource counts in this scan may therefore include workspaces that have been cancelled.',
    };
  }

  const directory = signal.value as WorkspaceDirectory;
  return {
    workspacesInAccount: directory.workspaces.length,
    assessed: directory.live.map(reference),
    excluded: directory.excluded.map(reference),
    ...(directory.regionUnverified.length > 0 ? { regionUnverified: directory.regionUnverified.length } : {}),
    ...(directory.outOfScope.length > 0 ? { outOfScope: directory.outOfScope.map(reference) } : {}),
    ...(directory.homeRegion != null ? { region: directory.homeRegion } : {}),
  };
}

/** One sentence a reader can act on, or undefined when there is nothing worth saying. */
export function describeEstate(estate: EstateSummary): string | undefined {
  if (estate.undeterminedReason != null) return estate.undeterminedReason;

  const assessed = estate.assessed.length;
  const unasked = estate.outOfScope?.length ?? 0;
  if (assessed === 0 && estate.excluded.length === 0 && unasked === 0) return undefined;

  // Named because the number is only reconcilable against the console with it: five of fifteen is a
  // loss until the reader knows the other ten bill from somewhere this deployment cannot read.
  const covered = `Assessed ${count(assessed, 'workspace')}${estate.region != null ? ` in ${estate.region}` : ''}`;
  const sentences =
    estate.excluded.length === 0
      ? [`${covered}.`]
      : [`${covered}.`, `${count(estate.excluded.length, 'workspace')} excluded as not assessable: ${reasons(estate.excluded)}.`];

  // Said before the region caveats, because it is the larger fact about what this number covers: a
  // reader comparing two runs of the same estate needs to know the smaller one was asked to be smaller.
  // The second half is the honest limit of how far a selection reaches — the workspace filter narrows
  // the statements that take it, and a statement reading the metastore or the account cannot be held to
  // a subset of workspaces, so those findings answer for more than the scope names.
  if (unasked > 0) {
    sentences.push(
      `${count(unasked, 'assessable workspace')} ${unasked === 1 ? 'was' : 'were'} outside the scope this ` +
        'assessment names, so nothing was read from ' +
        `${unasked === 1 ? 'it' : 'them'}. Findings about Unity Catalog, this workspace’s own settings ` +
        'and account-wide configuration answer for what they can see rather than for the named ' +
        'workspaces, and each one says which.'
    );
  }

  // Two different facts, and the second is not a weaker version of the first. "This deployment does not
  // know its own region" means nothing was filtered at all, so the wider count is the one to explain;
  // "three of the assessed have no readable region" means the filter ran and three survived it unproven.
  const unproven = estate.regionUnverified ?? 0;
  if (estate.region == null && unproven > 0) {
    sentences.push(
      'This deployment could not establish its own region, so no workspace was excluded for region. Where ' +
        'an account spans regions, the compute and job tables answer for one region only, so these counts ' +
        'may be wider than what was read.'
    );
  } else if (unproven > 0) {
    sentences.push(
      `${String(unproven)} of those assessed billed no region-bearing SKU, so ${unproven === 1 ? 'its' : 'their'} ` +
        'region could not be confirmed.'
    );
  }

  return sentences.join(' ');
}

/**
 * The exclusions, grouped by what a reader would ask next.
 *
 * Region is one group because the workspaces in it are all `RUNNING` and their status says nothing; the
 * rest keep their status, because "58 cancelled and 6 banned" is the fact that makes a smaller number
 * legitimate and six banned workspaces is one fact rather than six.
 */
function reasons(excluded: readonly WorkspaceRef[]): string {
  const elsewhere = excluded.filter((workspace) => workspace.reason === 'other-region').length;
  const byStatus = new Map<string, number>();
  for (const workspace of excluded) {
    if (workspace.reason === 'other-region') continue;
    byStatus.set(workspace.status, (byStatus.get(workspace.status) ?? 0) + 1);
  }

  return [
    ...(elsewhere > 0 ? [`${String(elsewhere)} in another region`] : []),
    ...[...byStatus.entries()].map(([status, n]) => `${String(n)} ${status.toLowerCase()}`),
  ].join(', ');
}

function reference(workspace: WorkspaceRow | ExcludedWorkspace): WorkspaceRef {
  return {
    id: workspace.workspaceId,
    name: workspace.name,
    ...(workspace.url != null ? { url: workspace.url } : {}),
    status: workspace.status,
    ...('reason' in workspace ? { reason: workspace.reason } : {}),
  };
}

function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}
