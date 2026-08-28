// The estate summary exists to explain a number, so these tests are about what a reader
// is told rather than about the shape of the object.

import { describe, expect, it } from 'vitest';
import { observed, unmeasurable, type SignalId, type SignalResult } from '../collect/signal.js';
import type { WorkspaceDirectory, WorkspaceRow } from '../collect/sql/shapes.js';
import { scopedToRegion } from '../collect/sql/region.js';
import { scopedToSelection } from '../collect/sql/selection.js';
import { describeEstate, summariseEstate } from './estate.js';

const DIRECTORY: SignalId = 'sql:estate.workspaces';

function workspace(id: string, name: string, status: string, region?: string): WorkspaceRow {
  return {
    workspaceId: id,
    name,
    url: `https://${name}.cloud.databricks.com`,
    status,
    ...(region != null ? { region } : {}),
    live: status === 'RUNNING',
  };
}

/** The status-only partition the parser produces, before region.ts narrows it. */
function directoryOf(...workspaces: readonly WorkspaceRow[]): ReadonlyMap<SignalId, SignalResult> {
  return mapOf({
    workspaces,
    live: workspaces.filter((w) => w.live),
    excluded: workspaces.filter((w) => !w.live).map((w) => ({ ...w, reason: 'not-running' as const })),
    regionUnverified: [],
    outOfScope: [],
  });
}

function mapOf(value: WorkspaceDirectory): ReadonlyMap<SignalId, SignalResult> {
  return new Map([[DIRECTORY, observed(DIRECTORY, value, 10, { mode: 'complete', reach: 'account' })]]);
}

describe('summariseEstate', () => {
  it('separates the workspaces assessed from those the account merely still lists', () => {
    const estate = summariseEstate(
      directoryOf(
        workspace('1', 'field-eng', 'RUNNING'),
        workspace('2', 'old-poc', 'CANCELLED'),
        workspace('3', 'blocked', 'BANNED'),
      ),
    );

    expect(estate.workspacesInAccount).toBe(3);
    expect(estate.assessed.map((w) => w.name)).toEqual(['field-eng']);
    expect(estate.excluded.map((w) => w.status)).toEqual(['CANCELLED', 'BANNED']);
    expect(estate.undeterminedReason).toBeUndefined();
  });

  it('says the set is undetermined, and that counts widened, when the directory could not be read', () => {
    const signals = new Map<SignalId, SignalResult>([
      [DIRECTORY, unmeasurable(DIRECTORY, 'SELECT on system.access.workspaces_latest was denied.')],
    ]);

    const estate = summariseEstate(signals);

    expect(estate.assessed).toEqual([]);
    expect(estate.workspacesInAccount).toBeUndefined();
    // Both halves matter: the cause, and what it means for every other number on the page.
    expect(estate.undeterminedReason).toContain('workspaces_latest was denied');
    expect(estate.undeterminedReason).toContain('cancelled');
  });

  it('does not invent a workspace count when the directory was never collected', () => {
    const estate = summariseEstate(new Map());

    expect(estate.workspacesInAccount).toBeUndefined();
    expect(estate.undeterminedReason).toContain('not collected');
  });
});

describe('describeEstate', () => {
  it('gives the reason the assessed number is smaller than the account total', () => {
    const estate = summariseEstate(
      directoryOf(
        workspace('1', 'field-eng', 'RUNNING'),
        workspace('2', 'a', 'CANCELLED'),
        workspace('3', 'b', 'CANCELLED'),
        workspace('4', 'c', 'BANNED'),
      ),
    );

    // Grouped by status: two cancelled workspaces are one fact, not two.
    expect(describeEstate(estate)).toBe(
      'Assessed 1 workspace. 3 workspaces excluded as not assessable: 2 cancelled, 1 banned.',
    );
  });

  it('says nothing about exclusions when there are none', () => {
    const estate = summariseEstate(directoryOf(workspace('1', 'a', 'RUNNING'), workspace('2', 'b', 'RUNNING')));

    expect(describeEstate(estate)).toBe('Assessed 2 workspaces.');
  });

  it('leads with the failure when the set is undetermined', () => {
    const estate = summariseEstate(new Map());

    expect(describeEstate(estate)).toBe(estate.undeterminedReason);
  });

  it('names the region and the workspaces left out of it', () => {
    // The sentence this replaces was "Assessed 2 workspaces." over a scan whose compute signals had
    // covered two of four, because the region filter was applied to the query parameter alone. Five of
    // fifteen reads as a tool that lost most of an estate until it says where the other ten are.
    const estate = summariseEstate(
      mapOf(
        scopedToRegion(
          {
            workspaces: [
              workspace('1', 'field-eng', 'RUNNING', 'AP_SYDNEY'),
              workspace('2', 'analytics', 'RUNNING', 'AP_SYDNEY'),
              workspace('3', 'us-prod', 'RUNNING', 'US_WEST_OREGON'),
              workspace('4', 'old-poc', 'CANCELLED', 'AP_SYDNEY'),
            ],
            live: [
              workspace('1', 'field-eng', 'RUNNING', 'AP_SYDNEY'),
              workspace('2', 'analytics', 'RUNNING', 'AP_SYDNEY'),
              workspace('3', 'us-prod', 'RUNNING', 'US_WEST_OREGON'),
            ],
            excluded: [{ ...workspace('4', 'old-poc', 'CANCELLED', 'AP_SYDNEY'), reason: 'not-running' }],
            regionUnverified: [],
            outOfScope: [],
          },
          '1'
        )
      )
    );

    expect(estate.region).toBe('AP_SYDNEY');
    expect(describeEstate(estate)).toBe(
      'Assessed 2 workspaces in AP_SYDNEY. 2 workspaces excluded as not assessable: 1 in another region, 1 cancelled.'
    );
  });

  it('says when an assessed workspace’s region could not be confirmed', () => {
    // Assessed on weaker grounds than the rest, so the grounds are stated. Silence here is what let a
    // classic-only workspace in another region count as covered while contributing no rows.
    const estate = summariseEstate(
      mapOf(
        scopedToRegion(
          {
            workspaces: [workspace('1', 'field-eng', 'RUNNING', 'AP_SYDNEY'), workspace('2', 'classic', 'RUNNING')],
            live: [workspace('1', 'field-eng', 'RUNNING', 'AP_SYDNEY'), workspace('2', 'classic', 'RUNNING')],
            excluded: [],
            regionUnverified: [],
            outOfScope: [],
          },
          '1'
        )
      )
    );

    expect(describeEstate(estate)).toBe(
      'Assessed 2 workspaces in AP_SYDNEY. 1 of those assessed billed no region-bearing SKU, so its region ' +
        'could not be confirmed.'
    );
  });

  it('explains a wider count when the app could not establish its own region', () => {
    // Distinct from the case above and not a bigger version of it: here the filter never ran, so the
    // number to explain is why 15 were assessed rather than why one of them is unproven. Measured shape
    // — a classic-only host workspace on an account spanning five regions.
    const rows = [workspace('1', 'classic-host', 'RUNNING'), workspace('2', 'us', 'RUNNING', 'US_WEST_OREGON')];
    const estate = summariseEstate(
      mapOf(scopedToRegion({ workspaces: rows, live: rows, excluded: [], regionUnverified: [], outOfScope: [] }, '1'))
    );

    expect(estate.region).toBeUndefined();
    expect(describeEstate(estate)).toBe(
      'Assessed 2 workspaces. This deployment could not establish its own region, so no workspace was ' +
        'excluded for region. Where an account spans regions, the compute and job tables answer for one ' +
        'region only, so these counts may be wider than what was read.'
    );
  });

  /*
   * A run started for an assessment that names its workspaces. The number to explain here is not a loss —
   * the reader asked for it — but a run of two beside a run of eleven of the same account is a comparison
   * somebody will make, so what the smaller one was asked to cover has to be on it.
   */
  it('says which assessable workspaces the assessment did not ask about', () => {
    const estate = summariseEstate(
      mapOf(
        scopedToSelection(
          scopedToRegion(
            {
              workspaces: [
                workspace('1', 'field-eng', 'RUNNING', 'AP_SYDNEY'),
                workspace('2', 'analytics', 'RUNNING', 'AP_SYDNEY'),
                workspace('3', 'old-poc', 'CANCELLED', 'AP_SYDNEY'),
              ],
              live: [
                workspace('1', 'field-eng', 'RUNNING', 'AP_SYDNEY'),
                workspace('2', 'analytics', 'RUNNING', 'AP_SYDNEY'),
              ],
              excluded: [{ ...workspace('3', 'old-poc', 'CANCELLED', 'AP_SYDNEY'), reason: 'not-running' }],
              regionUnverified: [],
              outOfScope: [],
            },
            '1'
          ),
          ['1']
        )
      )
    );

    // The three sets still sum to the account, which is what a reader checks the total against.
    expect(estate.workspacesInAccount).toBe(3);
    expect(estate.assessed.map((one) => one.name)).toEqual(['field-eng']);
    expect(estate.outOfScope?.map((one) => one.name)).toEqual(['analytics']);
    expect(describeEstate(estate)).toBe(
      'Assessed 1 workspace in AP_SYDNEY. 1 workspace excluded as not assessable: 1 cancelled. ' +
        '1 assessable workspace was outside the scope this assessment names, so nothing was read from it. ' +
        'Findings about Unity Catalog, this workspace’s own settings and account-wide configuration answer ' +
        'for what they can see rather than for the named workspaces, and each one says which.'
    );
  });

  it('leaves the field off entirely when the run covered the whole assessable estate', () => {
    const estate = summariseEstate(directoryOf(workspace('1', 'field-eng', 'RUNNING')));

    expect(estate.outOfScope).toBeUndefined();
  });
});
