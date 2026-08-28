import { describe, expect, it } from 'vitest';

import { parseTopologyEdges } from './parse.js';

const TABLE_TO_TABLE = {
  relation: 'table-to-table',
  sourceKind: 'table',
  targetKind: 'table',
  joinedBy: 'system.access.table_lineage',
} as const;

describe('parseTopologyEdges', () => {
  it('qualifies both ends with the kind, so a job 1 and a table 1 are not one node', () => {
    const [edge] = parseTopologyEdges(
      {
        relation: 'job-to-table',
        sourceKind: 'job',
        targetKind: 'table',
        joinedBy: 'system.access.table_lineage',
      },
      [{ source_id: '1', target_id: 'main.default.t', last_seen: '2026-08-18T00:00:00.000Z' }],
    );

    expect(edge).toEqual({
      id: 'job-to-table:job:1:table:main.default.t',
      source: 'job:1',
      target: 'table:main.default.t',
      relation: 'job-to-table',
      joinedBy: 'system.access.table_lineage',
      lastSeen: '2026-08-18T00:00:00.000Z',
    });
  });

  it('drops a row that does not name both ends or a last seen', () => {
    expect(
      parseTopologyEdges(TABLE_TO_TABLE, [
        { source_id: 'a', target_id: null, last_seen: '2026-08-18T00:00:00.000Z' },
        { source_id: 'a', target_id: 'b', last_seen: null },
        { source_id: '', target_id: 'b', last_seen: '2026-08-18T00:00:00.000Z' },
      ]),
    ).toEqual([]);
  });
});
