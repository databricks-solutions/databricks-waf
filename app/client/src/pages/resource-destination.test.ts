import { describe, expect, it } from 'vitest';
import type { LocatedItem, SelectableWorkspaces } from '../api/types';
import { currentResourceUrl, resourceDestination } from './resource-destination';

const RESOURCE: LocatedItem = {
  kind: 'warehouse',
  label: 'Analytics warehouse',
  url: 'https://dbc.example/sql/warehouses/wh-1?o=w1',
};

function directory(status = 'RUNNING', assessable = true): SelectableWorkspaces {
  return {
    asOf: '2026-08-22T00:00:00.000Z',
    workspaces: [{ id: 'w1', name: 'Analytics', url: 'https://dbc.example', status, assessable }],
  };
}

describe('a recorded Databricks destination', () => {
  it('is current when the latest directory records its workspace as running', () => {
    expect(resourceDestination(RESOURCE, directory())).toMatchObject({
      standing: 'current',
      asOf: '2026-08-22T00:00:00.000Z',
    });
    expect(currentResourceUrl(RESOURCE, directory())).toBe(RESOURCE.url);
  });

  it('is unavailable when the latest directory records its workspace as banned', () => {
    expect(resourceDestination(RESOURCE, directory('BANNED', false))).toMatchObject({
      standing: 'unavailable',
      workspace: { id: 'w1', status: 'BANNED' },
    });
    expect(currentResourceUrl(RESOURCE, directory('BANNED', false))).toBeUndefined();
  });

  it('keeps a running workspace in another region actionable', () => {
    expect(
      resourceDestination(RESOURCE, {
        ...directory(),
        workspaces: [
          {
            id: 'w1',
            name: 'Analytics',
            url: 'https://dbc.example',
            status: 'RUNNING',
            assessable: false,
            reason: 'other-region',
          },
        ],
      }).standing
    ).toBe('current');
  });

  it('says unknown when inventory, workspace identity or a matching workspace is absent', () => {
    expect(resourceDestination(RESOURCE).standing).toBe('unknown');
    expect(
      resourceDestination({ ...RESOURCE, url: 'https://dbc.example/sql/warehouses/wh-1' }, directory()).standing
    ).toBe('unknown');
    expect(resourceDestination(RESOURCE, { workspaces: [], asOf: '2026-08-22T00:00:00.000Z' }).standing).toBe(
      'unknown'
    );
  });

  it('does not trust a matching workspace id on another host', () => {
    expect(
      resourceDestination({ ...RESOURCE, url: 'https://elsewhere.example/jobs/1?o=w1' }, directory()).standing
    ).toBe('unknown');
  });
});
