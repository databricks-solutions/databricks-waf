// Carrying one foundation shortfall into the existing plan/action journey.
//
// A foundation reading is not advisor advice and is not a new requirement. The action lifecycle
// already has the durable ownership, dates, validation and value record this handoff needs, so the
// link carries the reading id and preselects the existing framework requirements that can verify the
// same change. It never copies a percentage or invents a foundation score.

export interface FoundationHandoff {
  readonly id: string;
  readonly label: string;
  readonly controlIds: readonly string[];
}

const HANDOFFS: Readonly<Record<string, FoundationHandoff>> = {
  'unity-catalog-boundary': {
    id: 'unity-catalog-boundary',
    label: 'Inside Unity Catalog',
    controlIds: ['DG-01-02', 'DG-01-03'],
  },
  'table-metadata': {
    id: 'table-metadata',
    label: 'Table metadata',
    controlIds: ['DG-01-03', 'DG-01-05'],
  },
  'column-metadata': {
    id: 'column-metadata',
    label: 'Column comments',
    controlIds: ['DG-01-05'],
  },
  'semantic-assets': {
    id: 'semantic-assets',
    label: 'Semantic assets',
    controlIds: ['DG-01-06'],
  },
  lineage: { id: 'lineage', label: 'Lineage', controlIds: ['DG-01-04'] },
  'quality-monitoring': {
    id: 'quality-monitoring',
    label: 'Quality monitoring',
    controlIds: ['DG-03-02'],
  },
  'policy-controls': {
    id: 'policy-controls',
    label: 'Policy controls',
    controlIds: ['DG-01-03'],
  },
  'storage-format': {
    id: 'storage-format',
    label: 'Storage format',
    controlIds: ['PE-03-06'],
  },
};

export function foundationHref(path: string, id: string): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}foundation=${encodeURIComponent(id)}`;
}

export function foundationIn(params: URLSearchParams): FoundationHandoff | undefined {
  const id = params.get('foundation');
  return id == null ? undefined : HANDOFFS[id];
}

export function foundationPhrase(handoff: FoundationHandoff): string {
  return `the ${handoff.label.toLowerCase()} foundation reading`;
}
