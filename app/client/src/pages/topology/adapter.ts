// The seam prompt 05 asked for. The page talks to this; the library lives behind it.
//
// Replacing the library is a change to the implementation of `TopologyCanvas`, not to
// the pane that mounts it. Coordinates come from `placeNodes`, not from the library.

import type { TopologyEdge, TopologyNode } from '../../../../shared/api/topology';

export interface TopologyCanvasProps {
  readonly nodes: readonly TopologyNode[];
  readonly edges: readonly TopologyEdge[];
  readonly selectedId?: string;
  readonly onSelect: (id: string | undefined) => void;
}
