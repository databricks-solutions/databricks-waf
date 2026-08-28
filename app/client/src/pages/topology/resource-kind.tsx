import { BriefcaseBusiness, Server, Table2, Warehouse, Workflow, type LucideIcon } from 'lucide-react';

import { TOPOLOGY_KIND_LABELS, type TopologyKind, type TopologyNode } from '../../../../shared/api/topology';

const KIND_ICON: Readonly<Record<TopologyKind, LucideIcon>> = {
  job: BriefcaseBusiness,
  cluster: Server,
  warehouse: Warehouse,
  pipeline: Workflow,
  table: Table2,
};

export function ResourceKind({ kind }: { readonly kind: TopologyKind }) {
  const Icon = KIND_ICON[kind];
  return (
    <span className="wa-resource-kind" data-kind={kind}>
      <Icon aria-hidden="true" />
      <span>{TOPOLOGY_KIND_LABELS[kind]}</span>
    </span>
  );
}

export function ResourceEndpoint({ node }: { readonly node: TopologyNode }) {
  return (
    <span className="wa-resource-endpoint">
      <ResourceKind kind={node.kind} />
      <span className="min-w-0 break-words font-medium text-wa-text">{node.label}</span>
    </span>
  );
}
