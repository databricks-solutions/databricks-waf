// The estate graph 101e returns, drawn behind the adapter 101a chose.
//
// Navigator holds the kind and relation toggles and the edge table — that table is the list
// alternative prompt 05 requires. The canvas is the second pane and never imports the library.
// Selection is `?node=`, so a row and a node name the same id. A cluster is a node whose kind
// is cluster; the page does not put it on a data path.

import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { TOPOLOGY_KINDS, TOPOLOGY_RELATIONS } from '../../../shared/api/topology';
import type { TopologyKind, TopologyNode, TopologyPayload, TopologyRelation } from '../../../shared/api/topology';
import { useTopology } from '../api/hooks';
import {
  CustomerPage,
  RecordButton,
  RecordList,
  Surface,
  TaskWorkspace,
  TechnicalDisclosure,
} from '../components/system';
import { Disclosure } from '../components/ui/Disclosure';
import { EmptyState } from '../components/ui/EmptyState';
import { Pagination } from '../components/ui/Pagination';
import { usePaged } from '../components/ui/paging';
import { TopologyCanvas } from './topology/canvas';
import {
  ALL_KINDS,
  ALL_RELATIONS,
  toggleKind,
  toggleRelation,
  visibleGraph,
  visibleRelationships,
} from './topology/filter';
import { ResourceEndpoint, ResourceKind } from './topology/resource-kind';
import {
  filteredSentence,
  graphSentence,
  KIND_LABEL,
  missingSelectionSentence,
  RELATION_LABEL,
  selectedSentence,
} from './topology-language';

const RELATIONSHIP_PAGE_SIZE = 4;

export function TopologyPage() {
  const topology = useTopology();

  if (topology.reason != null || topology.error != null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Estate relationships unavailable">
          <EmptyState
            layout="compact"
            reason="collector-failed"
            heading="The graph cannot run"
            detail={topology.reason ?? topology.error ?? ''}
            action={
              <button type="button" className="wa-button-secondary" onClick={topology.reload}>
                Try again
              </button>
            }
          />
        </Surface>
      </CustomerPage>
    );
  }

  if (topology.data == null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Estate relationships loading">
          <EmptyState
            layout="compact"
            reason="not-yet-collected"
            heading="Reading"
            detail="Running the seven statements that name a pair."
          />
        </Surface>
      </CustomerPage>
    );
  }

  return <EstateGraph graph={topology.data} />;
}

/** Exported so a test can render the claims without mounting the hook. */
export function EstateGraph({ graph }: { readonly graph: TopologyPayload }) {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('node') ?? undefined;
  const [kinds, setKinds] = useState<ReadonlySet<TopologyKind>>(ALL_KINDS);
  const [relations, setRelations] = useState<ReadonlySet<TopologyRelation>>(ALL_RELATIONS);
  const [relationshipQuery, setRelationshipQuery] = useState('');
  const [showAllRelationships, setShowAllRelationships] = useState(false);

  const visible = useMemo(() => visibleGraph(graph, { kinds, relations }), [graph, kinds, relations]);
  const byId = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const selected = selectedId == null ? undefined : byId.get(selectedId);
  const selectedVisible = selectedId != null && visible.nodes.some((node) => node.id === selectedId);
  const focusSelected = selectedVisible && !showAllRelationships;
  const listedRelationships = useMemo(
    () =>
      visibleRelationships(visible.edges, visible.nodes, {
        selectedId: focusSelected ? selectedId : undefined,
        query: relationshipQuery,
      }),
    [focusSelected, relationshipQuery, selectedId, visible.edges, visible.nodes]
  );
  const pagedRelationships = usePaged(listedRelationships, RELATIONSHIP_PAGE_SIZE);

  const incident = useMemo(
    () =>
      selectedId == null ? [] : graph.edges.filter((edge) => edge.source === selectedId || edge.target === selectedId),
    [graph.edges, selectedId]
  );

  const select = (id: string | undefined) => {
    const next = new URLSearchParams(params);
    if (id == null) next.delete('node');
    else next.set('node', id);
    setShowAllRelationships(false);
    setParams(next, { replace: true });
  };

  return (
    <CustomerPage>
      <Surface
        tone="inset"
        title="Find estate relationships"
        description="Filter by resource name, type, or relationship."
      >
        <label className="block">
          <span className="wa-caption text-wa-text-muted">Find a relationship</span>
          <input
            type="search"
            className="wa-field wa-body-compact mt-1 w-full"
            placeholder="Resource name or Databricks ID"
            value={relationshipQuery}
            onChange={(event) => setRelationshipQuery(event.target.value)}
          />
        </label>
        <div className="mt-3 border-t border-wa-divider pt-3">
          <Disclosure summary="Kinds and relationship types">
            <fieldset>
              <legend className="wa-caption text-wa-text-muted">Kind</legend>
              <div className="wa-segmented mt-1 flex-wrap">
                {TOPOLOGY_KINDS.map((kind) => (
                  <Toggle
                    key={kind}
                    label={KIND_LABEL[kind]}
                    pressed={kinds.has(kind)}
                    onClick={() => setKinds(toggleKind(kinds, kind))}
                  />
                ))}
              </div>
            </fieldset>
            <fieldset className="pt-2">
              <legend className="wa-caption text-wa-text-muted">Relation</legend>
              <div className="wa-segmented mt-1 flex-wrap">
                {TOPOLOGY_RELATIONS.map((relation) => (
                  <Toggle
                    key={relation}
                    label={RELATION_LABEL[relation]}
                    pressed={relations.has(relation)}
                    onClick={() => setRelations(toggleRelation(relations, relation))}
                  />
                ))}
              </div>
            </fieldset>
          </Disclosure>
        </div>
      </Surface>

      <TaskWorkspace
        queueLabel="Estate relationships"
        taskLabel="Selected estate object"
        queue={
          <Surface
            tone="section"
            title="Relationships"
            description={
              focusSelected
                ? `${String(listedRelationships.length)} for selected`
                : `${String(listedRelationships.length)} of ${String(visible.edges.length)}`
            }
          >
            {selectedVisible && (
              <div className="mb-3 flex items-center justify-between gap-2">
                <span className="wa-caption truncate">{selected?.label}</span>
                <div className="wa-segmented shrink-0" role="group" aria-label="Relationship scope">
                  <button
                    type="button"
                    aria-pressed={!showAllRelationships}
                    onClick={() => setShowAllRelationships(false)}
                  >
                    Selected
                  </button>
                  <button
                    type="button"
                    aria-pressed={showAllRelationships}
                    onClick={() => setShowAllRelationships(true)}
                  >
                    All filtered
                  </button>
                </div>
              </div>
            )}
            {listedRelationships.length === 0 ? (
              <EmptyState
                reason={graph.edges.length === 0 ? 'nothing-to-report' : 'filtered-out'}
                detail={
                  graph.edges.length === 0
                    ? graphSentence(graph)
                    : relationshipQuery.trim() === ''
                      ? filteredSentence()
                      : 'No relationship matches that resource name or Databricks ID.'
                }
              />
            ) : (
              <>
                <RecordList label="Estate relationships">
                  {pagedRelationships.rows.map((edge) => {
                    const source = byId.get(edge.source);
                    const target = byId.get(edge.target);
                    const peerId = edge.source === selectedId ? edge.target : edge.source;
                    const peer = byId.get(peerId);
                    const current = !focusSelected && (selectedId === edge.source || selectedId === edge.target);
                    return (
                      <RecordButton
                        key={edge.id}
                        selected={current}
                        onSelect={() => select(focusSelected ? peerId : edge.source)}
                        eyebrow={RELATION_LABEL[edge.relation]}
                        title={
                          <span className="wa-resource-relation">
                            {focusSelected ? (
                              peer == null ? (
                                peerId
                              ) : (
                                <ResourceEndpoint node={peer} />
                              )
                            ) : (
                              <>
                                {source == null ? edge.source : <ResourceEndpoint node={source} />}
                                <span aria-hidden="true">→</span>
                                {target == null ? edge.target : <ResourceEndpoint node={target} />}
                              </>
                            )}
                          </span>
                        }
                        meta={`${edge.joinedBy} · ${edge.lastSeen}`}
                        aside={current ? 'Selected' : 'Open'}
                      />
                    );
                  })}
                </RecordList>
                <Pagination paged={pagedRelationships} noun="relationships" />
              </>
            )}
          </Surface>
        }
        task={
          <Surface
            tone="task"
            title={selected?.label ?? 'Select an estate object'}
            description="Resource type, readable identity, and the relationships attached to it."
          >
            <SelectedNode selected={selected} selectedId={selectedId} incident={incident.length} />
          </Surface>
        }
      />

      <TechnicalDisclosure label="Relationship map" hint="Optional visual context">
        <p className="wa-body-compact mb-3 text-wa-text-secondary">{graphSentence(graph)}</p>
        {visible.nodes.length === 0 ? (
          <EmptyState
            reason={graph.edges.length === 0 ? 'nothing-to-report' : 'filtered-out'}
            detail={graph.edges.length === 0 ? graphSentence(graph) : filteredSentence()}
          />
        ) : (
          <TopologyCanvas nodes={visible.nodes} edges={visible.edges} selectedId={selectedId} onSelect={select} />
        )}
      </TechnicalDisclosure>
    </CustomerPage>
  );
}

function SelectedNode({
  selected,
  selectedId,
  incident,
}: {
  readonly selected: TopologyNode | undefined;
  readonly selectedId: string | undefined;
  readonly incident: number;
}) {
  if (selectedId == null) {
    return (
      <p className="wa-body-compact text-wa-text-secondary">Choose a relationship to inspect one of its resources.</p>
    );
  }
  if (selected == null) {
    return <p className="wa-body-compact text-wa-text-secondary">{missingSelectionSentence(selectedId)}</p>;
  }
  return (
    <div className="space-y-2">
      <ResourceKind kind={selected.kind} />
      <p className="wa-body-compact text-wa-text">{selectedSentence(selected.label, selected.kind, incident)}</p>
      <p className="wa-caption break-all">Databricks ID {selected.technicalId}</p>
    </div>
  );
}

function Toggle({
  label,
  pressed,
  onClick,
}: {
  readonly label: string;
  readonly pressed: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick}>
      {label}
    </button>
  );
}
