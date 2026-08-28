// `@xyflow/react` behind the adapter. The only file that may import the library.
//
// 101a measured the two costs this mount pays: a 2px focus ring on nodes and zoom
// controls (2.4.7), and no default attribution link (1.4.3). Handles stay untargetable
// because this graph is read-only. `onlyRenderVisibleElements` is the cull prompt 05
// asked for; layout is `placeNodes`, not the library.

import { Background, Controls, ReactFlow, type Edge, type Node, type ReactFlowInstance } from '@xyflow/react';
import { useEffect, useMemo, useRef } from 'react';

import { COMPUTE_RELATIONS, resourceAccessibleName } from '../topology-language';
import type { TopologyCanvasProps } from './adapter';
import { NODE_HEIGHT, NODE_WIDTH, openingNode, placeNodes, type PlacedNode } from './layout';
import { ResourceKind } from './resource-kind';
import { READABLE_GRAPH_ZOOM, readableSelectionZoom } from './viewport';

const COMPUTE = new Set<string>(COMPUTE_RELATIONS);

export function TopologyCanvas({ nodes, edges, selectedId, onSelect }: TopologyCanvasProps) {
  const fitted = useRef(false);
  const pane = useRef<HTMLDivElement>(null);
  const flowInstance = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const placed = useMemo(() => placeNodes(nodes), [nodes]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const byPlacement = useMemo(() => new Map(placed.map((node) => [node.id, node])), [placed]);
  const opening = useMemo(() => openingNode(nodes, edges, selectedId), [edges, nodes, selectedId]);

  useEffect(() => {
    if (selectedId == null || flowInstance.current == null) return;
    const selected = byPlacement.get(selectedId);
    if (selected == null) return;
    focusNode(flowInstance.current, selected);
  }, [byPlacement, selectedId]);

  useEffect(() => {
    // Background is a decorative field of dots; control SVGs repeat the names already carried by
    // their Zoom in, Zoom out and Fit view buttons. xyflow does not expose aria-hidden props for
    // these SVGs, so state the same fact on what it mounts. Edge SVGs are different: each contains
    // the library's labelled role=img group and remains in the accessibility tree.
    for (const svg of pane.current?.querySelectorAll('.react-flow__background, .react-flow__controls svg') ?? []) {
      svg.setAttribute('aria-hidden', 'true');
    }
  }, []);

  const neighbors = useMemo(() => {
    if (selectedId == null) return new Set<string>();
    const next = new Set<string>([selectedId]);
    for (const edge of edges) {
      if (edge.source === selectedId) next.add(edge.target);
      if (edge.target === selectedId) next.add(edge.source);
    }
    return next;
  }, [edges, selectedId]);

  const flowNodes: Node[] = useMemo(() => {
    const next: Node[] = [];
    for (const at of placed) {
      const node = byId.get(at.id);
      if (node == null) continue;
      next.push({
        id: node.id,
        position: { x: at.x, y: at.y },
        data: {
          label: (
            <span className="wa-topology-node-content">
              <span className="wa-topology-node-name" title={node.label}>
                {node.label}
              </span>
              <span className="wa-topology-node-meta">
                <ResourceKind kind={node.kind} />
                <span className="wa-topology-node-id" title={node.technicalId}>
                  {node.technicalId}
                </span>
              </span>
            </span>
          ),
        },
        ariaLabel: resourceAccessibleName(node),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        // xyflow's unlayered default-node rule otherwise outranks the product's layered CSS and
        // restores a second 10px padding box around this fixed-height node.
        style: { padding: 0, textAlign: 'left' },
        className: [
          'wa-topology-node',
          `wa-topology-node--${node.kind}`,
          neighbors.has(node.id) ? 'wa-topology-node--near' : '',
          selectedId === node.id ? 'wa-topology-node--selected' : '',
        ]
          .filter((part) => part !== '')
          .join(' '),
        draggable: false,
        connectable: false,
      });
    }
    return next;
  }, [byId, neighbors, placed, selectedId]);

  const flowEdges: Edge[] = useMemo(
    () =>
      edges.map((edge) => {
        const compute = COMPUTE.has(edge.relation);
        const near = selectedId != null && (edge.source === selectedId || edge.target === selectedId);
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          className: [
            'wa-topology-edge',
            `wa-topology-edge--${edge.relation}`,
            compute ? 'wa-topology-edge--compute' : 'wa-topology-edge--data',
            near ? 'wa-topology-edge--near' : '',
          ]
            .filter((part) => part !== '')
            .join(' '),
          markerEnd: compute ? undefined : { type: 'arrowclosed' },
          focusable: false,
        } satisfies Edge;
      }),
    [edges, selectedId]
  );

  return (
    <div ref={pane} className="wa-topology-pane">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        onNodeClick={(_event, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(undefined)}
        nodesConnectable={false}
        nodesDraggable={false}
        // The fitted relationship list is the complete keyboard surface: each row names both
        // endpoints and selects into the same graph. Making the canvas nodes focusable as well put
        // hundreds of transformed, mostly off-canvas groups into the tab order; measured on labs it
        // produced 52 distinct missing/obscured-focus failures and stopped after the 60-stop bound.
        // Pointer selection remains available through onNodeClick.
        nodesFocusable={false}
        elementsSelectable
        onlyRenderVisibleElements
        onInit={(instance) => {
          flowInstance.current = instance;
          if (fitted.current) return;
          const openingPlacement = opening == null ? undefined : byPlacement.get(opening.id);
          if (selectedId != null && openingPlacement != null) {
            focusNode(instance, openingPlacement);
          } else if (flowNodes.length <= 24 || openingPlacement == null) {
            void instance.fitView({ padding: 0.16, maxZoom: 1 });
          } else {
            // At estate scale, open with labels readable. Fit View remains available when the
            // reader wants the whole boundary rather than one exact neighbourhood.
            void instance.setCenter(openingPlacement.x + NODE_WIDTH / 2, openingPlacement.y + NODE_HEIGHT / 2, {
              zoom: READABLE_GRAPH_ZOOM,
            });
          }
          fitted.current = true;
        }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function focusNode(instance: ReactFlowInstance<Node, Edge>, node: PlacedNode): void {
  void instance.setCenter(node.x + NODE_WIDTH / 2, node.y + NODE_HEIGHT / 2, {
    zoom: readableSelectionZoom(instance.getZoom()),
  });
}
