// The words the definitions surface uses, in one place.
//
// Separated from the page for the reason the other language modules are: each of these sentences is
// conditional, and the conditions are the whole point. "Description only" and "what this measures
// changed" differ by one comparison and mean opposite things to a reader looking at a score that
// moved — one says the trend holds, the other says there is no trend, only two different questions
// answered on different dates. Written inline that comparison is a sentence nobody tests.

import type { DefinitionVersion } from '../api/types';

/**
 * What one version changed, relative to the one before it.
 *
 * The fingerprint is what makes this answerable rather than a guess. Two adjacent versions sharing
 * one changed the description and nothing a run is compared on, so results either side of it are of
 * the same question; two with different fingerprints are not. Saying "revised" for both would leave
 * a reader unable to tell a rename from a change of estate, which is the distinction that explains
 * a number moving.
 */
export function describeChange(version: DefinitionVersion, previous: DefinitionVersion | undefined): string {
  if (previous == null) return 'The first version.';
  if (version.fingerprint === previous.fingerprint) {
    return 'Description only. What this assessment measures did not change, so results either side of this compare.';
  }
  return 'What this assessment measures changed, so results either side of this are not of the same question.';
}

/**
 * What a version covers, as a sentence.
 *
 * An account-reach scope is described by what decides it rather than by a count, because the count
 * is not knowable from the definition — it is whatever the scanning identity's grants admit on the
 * day it runs. Naming a number there would be the app inventing a certainty it does not have.
 */
export function describeScope(version: DefinitionVersion): string {
  const { scope, lookbackDays, pillars } = version.measurement;
  const window = `over the last ${String(lookbackDays)} day${lookbackDays === 1 ? '' : 's'}`;
  const covering =
    pillars == null ? 'every pillar' : `${String(pillars.length)} pillar${pillars.length === 1 ? '' : 's'}`;

  if (scope.kind === 'account') {
    return `Every workspace the scanning identity can see, ${window}, covering ${covering}.`;
  }
  const count = scope.workspaceIds?.length ?? 0;
  return `${String(count)} chosen workspace${count === 1 ? '' : 's'}, ${window}, covering ${covering}.`;
}

/** Who is accountable, or the fact that nobody is. */
export function describeOwners(owners: readonly string[]): string {
  if (owners.length === 0) return 'Nobody has been recorded as owning this assessment.';
  return `Owned by ${owners.join(', ')}.`;
}
