import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { TOPOLOGY_PAYLOAD_CAP } from '../../../shared/api/topology';
import type { TopologyPayload } from '../../../shared/api/topology';
import { EstateGraph } from './TopologyPage';

const empty: TopologyPayload = {
  nodes: [],
  edges: [],
  cap: TOPOLOGY_PAYLOAD_CAP,
  truncated: false,
};

const populated: TopologyPayload = {
  nodes: [
    { id: 'job:1', kind: 'job', label: 'nightly', technicalId: '1' },
    { id: 'warehouse:w', kind: 'warehouse', label: 'cost-wh', technicalId: 'w' },
    ...['a', 'b', 'c', 'd', 'e'].map((id) => ({
      id: `table:${id}`,
      kind: 'table' as const,
      label: `main.demo.${id}`,
      technicalId: id,
    })),
  ],
  edges: [
    ...['a', 'b'].map((id) => ({
      id: `job-${id}`,
      source: 'job:1',
      target: `table:${id}`,
      relation: 'job-to-table' as const,
      joinedBy: 'system.access.table_lineage',
      lastSeen: '2026-08-21',
    })),
    ...['c', 'd', 'e'].map((id) => ({
      id: `warehouse-${id}`,
      source: 'warehouse:w',
      target: `table:${id}`,
      relation: 'warehouse-to-table' as const,
      joinedBy: 'system.access.table_lineage ⋈ system.query.history',
      lastSeen: '2026-08-21',
    })),
  ],
  cap: TOPOLOGY_PAYLOAD_CAP,
  truncated: false,
};

const html = (graph: TopologyPayload, path = '/topology'): string =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <EstateGraph graph={graph} />
    </MemoryRouter>
  );

describe('EstateGraph', () => {
  it('prints the empty sentence and does not mount the canvas', () => {
    const markup = html(empty);
    expect(markup).toContain('The seven statements returned no edges in the last 30 days.');
    expect(markup).not.toContain('react-flow');
  });

  it('names a selected id that is not in the response, and does not say it was deleted', () => {
    expect(html(empty, '/topology?node=job:9')).toContain('job:9 is not in this response.');
  });

  it('offers every kind and relation as a pressed toggle on arrival', () => {
    const markup = html(empty);
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('job → table');
    expect(markup).toContain('cluster');
  });

  it('bounds the relationship alternative and states the visible range', () => {
    expect(html(populated)).toContain('1–4 of 5 relationships');
  });

  it('focuses a deep-linked resource without removing the explicit all-relationships control', () => {
    const markup = html(populated, '/topology?node=job:1');
    expect(markup).toContain('1–2 of 2 relationships');
    expect(markup).toContain('aria-label="Relationship scope"');
    expect(markup).toContain('All filtered');
  });
});
