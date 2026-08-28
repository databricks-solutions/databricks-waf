// The committing edge of scan setup. Form interaction changes only this value; the caller invokes
// `runScan` once, from submit, after this request has been shown back to the reader as a summary.

import { describe, expect, it } from 'vitest';
import { confirmedScan, confirmedScanRequest, eligiblePillars, pillarsForConfirmation } from './RunScanDialog';

describe('a confirmed scan scope', () => {
  it('runs the saved assessment without restating its fixed scope', () => {
    expect(
      confirmedScanRequest({
        basis: 'saved',
        definitionId: 'definition-1',
        workspaceScope: 'selected',
        workspaces: ['ignored-by-the-saved-assessment'],
      })
    ).toEqual({ definitionId: 'definition-1' });
  });

  it('keeps a targeted saved-assessment rerun in assessment context', () => {
    expect(
      confirmedScanRequest({
        basis: 'saved',
        definitionId: 'definition-1',
        pillars: ['reliability'],
        workspaceScope: 'account',
        workspaces: [],
      })
    ).toEqual({ pillars: ['reliability'] });
  });

  it('declines the selected assessment when a custom workspace set was confirmed', () => {
    expect(
      confirmedScanRequest({
        basis: 'custom',
        pillars: ['cost-optimization', 'security-compliance-and-privacy'],
        workspaceScope: 'selected',
        workspaces: ['w2', 'w1'],
      })
    ).toEqual({
      definitionId: null,
      pillars: ['cost-optimization', 'security-compliance-and-privacy'],
      workspaces: ['w2', 'w1'],
    });

    expect(
      confirmedScan({
        basis: 'custom',
        workspaceScope: 'selected',
        workspaces: ['w1'],
      })
    ).toEqual({
      request: { definitionId: null, workspaces: ['w1'] },
      chosen: { kind: 'none' },
    });
  });

  it('represents the entire visible account by omitting workspace ids', () => {
    expect(
      confirmedScanRequest({
        basis: 'custom',
        workspaceScope: 'account',
        workspaces: ['not-sent'],
      })
    ).toEqual({ definitionId: null });
  });
});

describe('pillars offered for a confirmed run', () => {
  const pillars = [{ id: 'cost' }, { id: 'reliability' }, { id: 'security' }] as const;

  it('offers only pillars this build measures for a custom run', () => {
    expect(eligiblePillars(pillars, ['cost', 'security'], undefined).map((pillar) => pillar.id)).toEqual([
      'cost',
      'security',
    ]);
  });

  it('intersects a saved assessment with the pillars this build measures', () => {
    const offered = eligiblePillars(pillars, ['cost', 'security'], ['reliability', 'security']).map(
      (pillar) => pillar.id
    );

    expect(offered).toEqual(['security']);
    expect(pillarsForConfirmation('all', 'saved', offered, [], ['reliability', 'security'])).toEqual(['security']);
    expect(
      confirmedScanRequest({
        basis: 'saved',
        definitionId: 'definition-1',
        pillars: offered,
        workspaceScope: 'account',
        workspaces: [],
      })
    ).toEqual({ pillars: ['security'] });
  });
});
