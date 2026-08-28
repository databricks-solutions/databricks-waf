import { describe, expect, it } from 'vitest';

import { parseTopologyNames, topologyNameParameters } from './names.js';

describe('topology names', () => {
  it('keys exact names by kind-qualified id and drops unsupported or empty rows', () => {
    expect(
      parseTopologyNames([
        { kind: 'job', technical_id: '7', name: '  Daily finance  ' },
        { kind: 'table', technical_id: 'main.t', name: 'ignored' },
        { kind: 'pipeline', technical_id: 'p-1', name: '' },
        { kind: 'cluster', technical_id: null, name: 'ignored' },
      ])
    ).toEqual({ 'job:7': 'Daily finance' });
  });

  it('binds only non-table platform ids and refuses comma-delimited ids', () => {
    const parameters = topologyNameParameters(
      [
        { id: 'job:7', kind: 'job', label: 'Job', technicalId: '7' },
        { id: 'cluster:c-1', kind: 'cluster', label: 'Cluster', technicalId: 'c-1' },
        { id: 'warehouse:w,2', kind: 'warehouse', label: 'SQL warehouse', technicalId: 'w,2' },
        { id: 'table:main.t', kind: 'table', label: 'main.t', technicalId: 'main.t' },
      ],
      'ws-1'
    );

    expect(parameters.workspace_id.value).toBe('ws-1');
    expect(parameters.job_ids.value).toBe('7');
    expect(parameters.cluster_ids.value).toBe('c-1');
    expect(parameters.warehouse_ids.value).toBe('');
    expect(parameters.pipeline_ids.value).toBe('');
  });
});
