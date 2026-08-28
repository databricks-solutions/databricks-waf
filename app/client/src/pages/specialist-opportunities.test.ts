import { describe, expect, it } from 'vitest';
import { actionableRows, actionableWorkloads } from './specialist-opportunities';

describe('specialist opportunity lists', () => {
  it('exclude analyzer rows that have no customer action', () => {
    const rows = [
      { id: 'clean', findings: [] },
      { id: 'actionable', findings: [{ rule: 'RULE', severity: 'medium' as const }] },
      { id: 'informational', findings: [{ rule: 'INFO', severity: 'info' as const }] },
      { id: 'unmeasured', findings: [] },
    ];

    expect(actionableRows(rows).map((row) => row.id)).toEqual(['actionable']);
  });

  it('combines workload projections without duplicating an actionable shape', () => {
    const clean = { workspaceId: 'w1', shape: 'clean', findings: [] };
    const cacheOnly = {
      workspaceId: 'w1',
      shape: 'cache-only',
      findings: [{ rule: 'CACHE_HIT', severity: 'info' as const }],
    };
    const shared = {
      workspaceId: 'w1',
      shape: 'shared',
      findings: [
        { rule: 'A', severity: 'high' as const },
        { rule: 'CACHE_HIT', severity: 'info' as const },
      ],
    };
    const failing = {
      workspaceId: 'w1',
      shape: 'failing',
      findings: [{ rule: 'B', severity: 'critical' as const }],
    };

    expect(actionableWorkloads([clean, cacheOnly, shared], [shared, failing]).map((row) => row.shape)).toEqual([
      'shared',
      'failing',
    ]);
  });
});
