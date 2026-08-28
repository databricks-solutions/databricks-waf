// The region partition, which decides what a deployment claims to have assessed.
//
// Tested on its own because the mistake it exists to prevent is not a crash: the previous arrangement
// filtered the query parameter and left the summary describing the wider set, so a scan of five
// workspaces reported fifteen and every number beside it read as complete. A partition that is right in
// one place and wrong in another is the failure mode here, so these assert the whole shape each time
// rather than only the field under test.

import { describe, expect, it } from 'vitest';
import type { ExcludedWorkspace, WorkspaceDirectory, WorkspaceRow } from './shapes.js';
import { scopedToRegion } from './region.js';

function workspace(id: string, region?: string, live = true): WorkspaceRow {
  return {
    workspaceId: id,
    name: `ws-${id}`,
    status: live ? 'RUNNING' : 'CANCELLED',
    ...(region != null ? { region } : {}),
    live,
  };
}

/** What the parser produces: the status partition, region untouched. */
function parsed(...workspaces: readonly WorkspaceRow[]): WorkspaceDirectory {
  return {
    workspaces,
    live: workspaces.filter((one) => one.live),
    excluded: workspaces
      .filter((one) => !one.live)
      .map<ExcludedWorkspace>((one) => ({ ...one, reason: 'not-running' })),
    regionUnverified: [],
    outOfScope: [],
  };
}

const names = (rows: readonly WorkspaceRow[]) => rows.map((row) => row.workspaceId);

describe('scoping the directory to the region the app runs in', () => {
  it('assesses the home region and excludes the rest, saying which reason applies', () => {
    const directory = scopedToRegion(
      parsed(
        workspace('1', 'AP_SYDNEY'),
        workspace('2', 'AP_SYDNEY'),
        workspace('3', 'US_WEST_OREGON'),
        workspace('4', 'EUROPE_IRELAND'),
        workspace('5', 'AP_SYDNEY', false),
      ),
      '1'
    );

    expect(names(directory.live)).toEqual(['1', '2']);
    expect(directory.homeRegion).toBe('AP_SYDNEY');
    // Both reasons present, and distinguishable. A reader seeing `3` listed as excluded needs the
    // region, because its status is RUNNING and says nothing.
    expect(directory.excluded.map((one) => [one.workspaceId, one.reason])).toEqual([
      ['5', 'not-running'],
      ['3', 'other-region'],
      ['4', 'other-region'],
    ]);
    // Nothing is lost: the account list is still whole, so a count taken from it reconciles.
    expect(directory.workspaces).toHaveLength(5);
    expect(names(directory.live).length + directory.excluded.length).toBe(5);
  });

  it('keeps a workspace whose region could not be read, and names it as unproven', () => {
    // Classic-only billing carries no region in any SKU name. Dropping it would exclude a workspace
    // that may well be in this region on the strength of a missing column.
    const directory = scopedToRegion(parsed(workspace('1', 'AP_SYDNEY'), workspace('2')), '1');

    expect(names(directory.live)).toEqual(['1', '2']);
    expect(names(directory.regionUnverified)).toEqual(['2']);
    expect(directory.excluded).toEqual([]);
  });

  it('filters nothing when the app cannot establish its own region, and says every live one is unproven', () => {
    // The host workspace bills only classic compute, so there is no home region to compare against.
    // Assessing everything is the wider claim and the honest one; what it must not do is assess
    // everything while reporting a region it did not establish.
    const directory = scopedToRegion(parsed(workspace('1'), workspace('2', 'US_WEST_OREGON')), '1');

    expect(names(directory.live)).toEqual(['1', '2']);
    expect(names(directory.regionUnverified)).toEqual(['1', '2']);
    expect(directory.homeRegion).toBeUndefined();
    expect(directory.excluded).toEqual([]);
  });

  it('filters nothing when the app does not know which workspace it is in', () => {
    const directory = scopedToRegion(parsed(workspace('1', 'AP_SYDNEY'), workspace('2', 'US_WEST_OREGON')));

    expect(names(directory.live)).toEqual(['1', '2']);
    expect(directory.homeRegion).toBeUndefined();
  });

  it('leaves the not-running exclusions alone rather than reclassifying them', () => {
    // A cancelled workspace in another region is excluded once, for the reason a reader can act on
    // first. Counting it twice would make the excluded total disagree with the account list.
    const directory = scopedToRegion(parsed(workspace('1', 'AP_SYDNEY'), workspace('2', 'US_WEST_OREGON', false)), '1');

    expect(directory.excluded.map((one) => [one.workspaceId, one.reason])).toEqual([['2', 'not-running']]);
    expect(directory.excluded).toHaveLength(1);
  });
});
