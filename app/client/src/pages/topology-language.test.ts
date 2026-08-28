import { describe, expect, it } from 'vitest';
import { TOPOLOGY_PAYLOAD_CAP } from '../../../shared/api/topology';
import {
  filteredSentence,
  graphSentence,
  missingSelectionSentence,
  resourceAccessibleName,
  selectedSentence,
} from './topology-language';

describe('graphSentence', () => {
  it('names the counts the payload carried', () => {
    expect(
      graphSentence({
        nodes: [{ id: 'job:1', kind: 'job', label: 'nightly', technicalId: '1' }],
        edges: [
          {
            id: 'e1',
            source: 'job:1',
            target: 'table:main.t',
            relation: 'job-to-table',
            joinedBy: 'system.access.table_lineage',
            lastSeen: '2026-08-18',
          },
        ],
        cap: TOPOLOGY_PAYLOAD_CAP,
        truncated: false,
      })
    ).toBe('1 edge across 1 node.');
  });

  it('uses the empty sentence when there are no edges, and does not say the estate is empty', () => {
    expect(graphSentence({ nodes: [], edges: [], cap: TOPOLOGY_PAYLOAD_CAP, truncated: false })).toBe(
      'The seven statements returned no edges in the last 30 days.'
    );
  });

  it('restates the cap when truncated, and does not say what was dropped', () => {
    expect(
      graphSentence({
        nodes: [],
        edges: new Array(TOPOLOGY_PAYLOAD_CAP).fill({
          id: 'e',
          source: 'a',
          target: 'b',
          relation: 'job-to-table',
          joinedBy: 'system.access.table_lineage',
          lastSeen: '2026-08-18',
        }),
        cap: TOPOLOGY_PAYLOAD_CAP,
        truncated: true,
      })
    ).toBe(`2000 edges across 0 nodes. The response stopped at ${String(TOPOLOGY_PAYLOAD_CAP)} edges.`);
  });
});

describe('selectedSentence', () => {
  it('names the label, the kind field, and the incident count', () => {
    expect(selectedSentence('nightly', 'cluster', 2)).toBe('nightly (Cluster). 2 edges in this response name it.');
  });
});

describe('missingSelectionSentence', () => {
  it('repeats the id and does not say the object was deleted', () => {
    expect(missingSelectionSentence('job:9')).toBe('job:9 is not in this response.');
  });
});

describe('filteredSentence', () => {
  it('names the toggles, not the estate', () => {
    expect(filteredSentence()).toBe('No edge remains for the kinds and relations that are on.');
  });
});

describe('resourceAccessibleName', () => {
  it('names kind, display name and the Databricks id without relying on colour', () => {
    expect(
      resourceAccessibleName({
        id: 'pipeline:p-1',
        kind: 'pipeline',
        label: 'Bronze ingest',
        technicalId: 'p-1',
      })
    ).toBe('Pipeline: Bronze ingest. Databricks id p-1');
  });
});
