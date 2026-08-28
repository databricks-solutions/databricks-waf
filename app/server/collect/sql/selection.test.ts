// The scope partition, which decides whether a narrowed assessment reads what it says it reads.
//
// The defect this exists to prevent is not a crash and does not look like one from any single place. A
// definition naming three workspaces produced a scope resolution saying "Assessed 3 of the 3 workspaces
// this assessment covers" over statements that had read the whole account, and both halves were
// internally consistent. So these assert the whole shape each time, including the sets not under test,
// and the reconciliation that makes the account total checkable against a console.

import { describe, expect, it } from 'vitest';
import type { ExcludedWorkspace, WorkspaceDirectory, WorkspaceRow } from './shapes.js';
import { scopedToSelection } from './selection.js';
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

/** What the parser produces: the status partition, region and scope untouched. */
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

describe('scoping the directory to what an assessment names', () => {
  it('keeps what was named and holds the rest apart from what cannot be assessed', () => {
    const directory = scopedToSelection(parsed(workspace('1'), workspace('2'), workspace('3', undefined, false)), [
      '1',
    ]);

    expect(names(directory.live)).toEqual(['1']);
    expect(names(directory.outOfScope)).toEqual(['2']);
    // Still the estate's own answer, not the assessment's. Widening the scope will not make it assessable.
    expect(names(directory.excluded)).toEqual(['3']);
  });

  /*
   * The property the whole summary rests on. Without a third set, narrowing `live` leaves a workspace in
   * no set at all, and the account total becomes a correct number the reader cannot check against the
   * console it came from.
   */
  it('leaves the three sets summing to the account', () => {
    const directory = scopedToSelection(
      parsed(workspace('1'), workspace('2'), workspace('3'), workspace('4', undefined, false)),
      ['1', '2']
    );

    expect(directory.live.length + directory.outOfScope.length + directory.excluded.length).toBe(
      directory.workspaces.length
    );
  });

  it('reads an unverified region as a caveat on the assessed rather than on the estate', () => {
    const directory = scopedToSelection(
      scopedToRegion(parsed(workspace('1', 'AP_SYDNEY'), workspace('2'), workspace('3')), '1'),
      ['1', '3']
    );

    // '2' has no readable region and was not asked for, so it is no longer a caveat on anything.
    expect(names(directory.regionUnverified)).toEqual(['3']);
  });

  /*
   * The two narrowings answer different questions and only one of them has a remedy. A named workspace in
   * another region stays excluded with that reason, because "in a region this deployment cannot read"
   * tells an admin to deploy there and "not asked for" tells them to widen a scope that already names it.
   */
  it('does not restate a region exclusion as a scope one', () => {
    const directory = scopedToSelection(
      scopedToRegion(parsed(workspace('1', 'AP_SYDNEY'), workspace('2', 'US_WEST_OREGON')), '1'),
      ['1', '2']
    );

    expect(names(directory.live)).toEqual(['1']);
    expect(directory.outOfScope).toEqual([]);
    expect(directory.excluded.map((one) => [one.workspaceId, one.reason])).toEqual([['2', 'other-region']]);
  });

  /*
   * A selected id no row matches is not an error here and cannot be one: the collector has no row to
   * place. It is either stopped, elsewhere, or gone, and only the definition domain can tell the third
   * from the first two, because only it holds what the author asked for against the directory by name.
   */
  it('ignores a named workspace the directory has no row for', () => {
    const directory = scopedToSelection(parsed(workspace('1')), ['1', 'w-gone']);

    expect(names(directory.live)).toEqual(['1']);
    expect(directory.outOfScope).toEqual([]);
  });

  it('narrows to nothing rather than widening when nothing named is assessable', () => {
    const directory = scopedToSelection(parsed(workspace('1'), workspace('2')), ['w-gone']);

    expect(directory.live).toEqual([]);
    expect(names(directory.outOfScope)).toEqual(['1', '2']);
  });

  it('leaves the home region alone, since a scope is not a claim about geography', () => {
    const directory = scopedToSelection(
      scopedToRegion(parsed(workspace('1', 'AP_SYDNEY'), workspace('2', 'AP_SYDNEY')), '1'),
      ['2']
    );

    expect(directory.homeRegion).toBe('AP_SYDNEY');
  });
});
