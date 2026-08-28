// One final assessment, investigated as one system.
//
// The legacy pillar, findings and topology routes remain addressable, but they are record pages.
// This surface composes their authoritative payloads into the Architecture Studio workbench approved
// for 110d: pillar navigator, estate/evidence plane, selected-item inspector and the shell differential.

import { Link, useSearchParams } from 'react-router';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@databricks/appkit-ui/react';
import { ExternalLink } from 'lucide-react';
import type { TopologyEdge, TopologyNode, TopologyPayload } from '../../../shared/api/topology';
import { useAssessment } from '../api/assessment-context';
import { useDecisions, useResultChanges, useSelectableWorkspaces, useTopology } from '../api/hooks';
import type {
  CatalogueControl,
  Finding,
  LocatedItem,
  Outcome,
  PillarScore,
  SelectableWorkspaces,
  Severity,
} from '../api/types';
import { classOf, type ChangeClass } from '../components/change-language';
import { pillarCoverage } from '../components/coverage';
import { FindingDetail } from '../components/FindingDetail';
import { findingActionReason } from '../components/finding-action-language';
import { MeasurementRemedyAction } from '../components/MeasurementRemedyAction';
import {
  ActionPanel as CustomerActionPanel,
  CustomerPage,
  RecordButton,
  RecordLink,
  RecordList,
  RecordValue,
  StateNotice,
  Surface,
  TaskWorkspace,
  TechnicalDisclosure,
} from '../components/system';
import { EmptyState } from '../components/ui/EmptyState';
import { Pagination } from '../components/ui/Pagination';
import { OutcomeBadge, SeverityBadge } from '../components/ui/StatusBadge';
import { usePaged } from '../components/ui/paging';
import { TopologyCanvas } from './topology/canvas';
import { ResourceEndpoint, ResourceKind } from './topology/resource-kind';
import { RELATION_LABEL } from './topology-language';
import { updatedInvestigationParams } from './investigation-filter';
import { findingResources, investigationFocus, type InvestigationFocus } from './investigation-focus';
import { currentResourceUrl, resourceDestination, type ResourceDestination } from './resource-destination';
import { requirementHref } from './requirement-link';

const ALL = 'all';
const UNMET = 'unmet';
const MET = 'met';
const PAGE_SIZE = 10;

type OutcomeFilter = typeof ALL | typeof UNMET | typeof MET | Outcome;
type ChangeFilter = typeof ALL | ChangeClass;

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  informational: 4,
};

const OUTCOME_RANK: Readonly<Record<Outcome, number>> = {
  fail: 0,
  partial: 1,
  unmeasurable: 2,
  pass: 3,
  'satisfied-by-architecture': 4,
  'not-applicable': 5,
};

const CHANGE_LABEL: Readonly<Record<ChangeClass, string>> = {
  new: 'New',
  regressed: 'Regressed',
  changed: 'Changed',
  resolved: 'Resolved',
};

export function InvestigatePage() {
  const { scan, result, pillarTitle, controlOf } = useAssessment();
  const topology = useTopology();
  const workspaces = useSelectableWorkspaces();
  const decisions = useDecisions();
  const resultChanges = useResultChanges(result?.id ?? '');
  const [params, setParams] = useSearchParams();

  if (scan == null || result == null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Investigation unavailable">
          <EmptyState
            layout="compact"
            reason="not-yet-collected"
            heading="No published report to investigate"
            detail="Complete the open review to publish the report. The Dashboard remains available while that work is open."
            action={
              <span className="flex flex-wrap gap-2">
                <Link className="wa-button-primary" to="/review">
                  Open review
                </Link>
                <Link className="wa-button-secondary" to="/overview">
                  Dashboard
                </Link>
              </span>
            }
          />
        </Surface>
      </CustomerPage>
    );
  }

  const selectedPillar = params.get('pillar') ?? ALL;
  const selectedControl = params.get('control');
  const selectedNodeId = params.get('node');
  const askedOutcome = params.get('outcome');
  // Investigation exists to close gaps. Passing requirements remain one filter away, but the first
  // view contains the work a customer can act on rather than 184 rows and a graph of everything.
  const outcome: OutcomeFilter = isOutcomeFilter(askedOutcome) ? askedOutcome : UNMET;
  const askedChange = params.get('changed');
  const change: ChangeFilter = isChangeFilter(askedChange) ? askedChange : ALL;
  const set = (entries: Readonly<Record<string, string | undefined>>, replace = true) => {
    const next = updatedInvestigationParams(params, entries);
    setParams(next, { replace });
  };

  const changeSet =
    change === ALL || resultChanges.data?.comparable !== true
      ? undefined
      : new Set(
          resultChanges.data.changes.filter((entry) => classOf(entry) === change).map((entry) => entry.controlId)
        );

  const visible = scan.findings
    .filter((finding) => selectedPillar === ALL || finding.pillarId === selectedPillar)
    .filter((finding) => matchesOutcome(finding.outcome, outcome))
    .filter((finding) => changeSet == null || changeSet.has(finding.controlId))
    .sort(
      (left, right) =>
        OUTCOME_RANK[left.outcome] - OUTCOME_RANK[right.outcome] ||
        SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
        left.controlId.localeCompare(right.controlId)
    );

  // The ranked queue already answers which gap comes first. Use it on arrival instead of pairing the
  // queue with an empty inspector; a named control still wins, and a named missing control is never
  // replaced with a different requirement.
  const selectedFinding =
    visible.find((finding) => finding.controlId === selectedControl) ??
    (selectedControl == null && selectedNodeId == null ? visible[0] : undefined);
  const knownFinding = scan.findings.some((finding) => finding.controlId === selectedControl);
  const byControl = new Map((decisions.data?.decisions ?? []).map((decision) => [decision.controlId, decision]));
  const selectedNode = topology.data?.nodes.find((node) => node.id === selectedNodeId);
  const incident =
    selectedNodeId == null
      ? []
      : (topology.data?.edges ?? []).filter((edge) => edge.source === selectedNodeId || edge.target === selectedNodeId);
  const focus =
    selectedFinding == null
      ? undefined
      : investigationFocus(
          selectedFinding,
          topology.data,
          (resource) => resourceDestination(resource, workspaces.data).standing === 'current'
        );

  const selectFinding = (finding: Finding) => set({ control: finding.controlId, node: undefined }, false);
  return (
    <CustomerPage>
      <InvestigationNavigator
        finalisedAt={result.finalisedAt}
        pillars={scan.score.pillars}
        selectedPillar={selectedPillar}
        outcome={outcome}
        change={change}
        changes={resultChanges.data?.comparable === true ? resultChanges.data.changes : []}
        comparisonReason={
          change === ALL
            ? undefined
            : resultChanges.loading
              ? 'Reading the previous comparable report.'
              : resultChanges.data?.comparable === true
                ? undefined
                : (resultChanges.data?.reason ?? 'This report has no comparable predecessor.')
        }
        pillarTitle={pillarTitle}
        onPillar={(pillar) => set({ pillar, control: undefined, node: undefined })}
        onOutcome={(next) => set({ outcome: next, control: undefined, node: undefined })}
        onChange={(next) => set({ changed: next, control: undefined, node: undefined })}
      />
      <TaskWorkspace
        queueLabel="Requirements to improve"
        taskLabel="Selected requirement and closure plan"
        queue={
          <InvestigationCanvas
            findings={visible}
            selectedControl={selectedControl}
            onFinding={selectFinding}
            pillarTitle={pillarTitle}
          />
        }
        task={
          <InvestigationInspector
            finding={selectedFinding}
            askedControl={selectedControl}
            knownFinding={knownFinding}
            node={selectedNode}
            askedNode={selectedNodeId}
            incident={incident}
            graph={topology.data}
            decision={selectedFinding == null ? undefined : byControl.get(selectedFinding.controlId)}
            control={selectedFinding == null ? undefined : controlOf(selectedFinding.controlId)}
            focus={focus}
            workspaceDirectory={workspaces.data}
            selectedNodeId={selectedNodeId}
            {...(topology.reason != null || topology.error != null
              ? { topologyError: topology.reason ?? topology.error }
              : {})}
            onReloadTopology={topology.reload}
            onNode={(id) => set({ node: id }, false)}
            // Clear filters for a sibling reading: a shared requirement can belong to another pillar,
            // and carrying the current pillar would deliberately open the "outside these filters"
            // state instead of the requirement the reader chose.
            controlHref={(controlId) => `/investigate?control=${encodeURIComponent(controlId)}`}
            onClearFilters={() => {
              const next = new URLSearchParams();
              if (selectedControl != null) next.set('control', selectedControl);
              setParams(next, { replace: true });
            }}
          />
        }
      />
    </CustomerPage>
  );
}

export function InvestigationNavigator({
  finalisedAt,
  pillars,
  selectedPillar,
  outcome,
  change,
  changes,
  comparisonReason,
  pillarTitle,
  onPillar,
  onOutcome,
  onChange,
}: {
  readonly finalisedAt: string;
  readonly pillars: readonly PillarScore[];
  readonly selectedPillar: string;
  readonly outcome: OutcomeFilter;
  readonly change: ChangeFilter;
  readonly changes: readonly { readonly pillarId: string; readonly from: string; readonly to: string }[];
  readonly comparisonReason?: string;
  readonly pillarTitle: (pillarId: string) => string;
  readonly onPillar: (pillar: string) => void;
  readonly onOutcome: (outcome: OutcomeFilter) => void;
  readonly onChange: (change: ChangeFilter) => void;
}) {
  const changedByPillar = new Map<string, number>();
  for (const entry of changes) changedByPillar.set(entry.pillarId, (changedByPillar.get(entry.pillarId) ?? 0) + 1);

  return (
    <Surface
      tone="inset"
      title="Published report"
      description={`Published ${new Date(finalisedAt).toLocaleString()} · ${String(pillars.length)} pillars`}
    >
      <div className="grid gap-2 lg:grid-cols-3">
        <Select value={selectedPillar} onValueChange={onPillar}>
          <SelectTrigger className="wa-select w-full" aria-label="Filter requirements by pillar">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>
              All pillars · {String(pillars.reduce((sum, pillar) => sum + pillar.total, 0))} requirements
            </SelectItem>
            {pillars.map((pillar) => {
              const coverage = pillarCoverage(pillar);
              const unmet = pillar.counts.fail + pillar.counts.partial;
              const moved = changedByPillar.get(pillar.pillarId) ?? 0;
              return (
                <SelectItem key={pillar.pillarId} value={pillar.pillarId}>
                  {pillarTitle(pillar.pillarId)} · {unmet} unmet · {Math.round(coverage.percent)}% coverage
                  {moved > 0 ? ` · ${String(moved)} changed` : ''}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <Select value={outcome} onValueChange={(value) => onOutcome(value as OutcomeFilter)}>
          <SelectTrigger className="wa-select w-full" aria-label="Filter requirements by outcome">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any outcome</SelectItem>
            <SelectItem value={UNMET}>Unmet</SelectItem>
            <SelectItem value={MET}>Met</SelectItem>
            <SelectItem value="unmeasurable">Unmeasured</SelectItem>
          </SelectContent>
        </Select>
        <Select value={change} onValueChange={(value) => onChange(value as ChangeFilter)}>
          <SelectTrigger className="wa-select w-full" aria-label="Filter requirements by movement">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any movement</SelectItem>
            {Object.entries(CHANGE_LABEL).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {comparisonReason != null && (
        <p className="wa-caption mt-2">{comparisonReason} The movement filter is not applied.</p>
      )}
    </Surface>
  );
}

function InvestigationCanvas({
  findings,
  selectedControl,
  onFinding,
  pillarTitle,
}: {
  readonly findings: readonly Finding[];
  readonly selectedControl: string | null;
  readonly onFinding: (finding: Finding) => void;
  readonly pillarTitle: (pillarId: string) => string;
}) {
  const selectedAt = findings.findIndex((finding) => finding.controlId === selectedControl);
  const paged = usePaged(findings, PAGE_SIZE, selectedAt);

  return (
    <Surface
      tone="section"
      title="Requirements to improve"
      description={`${String(findings.length)} shown`}
      action={
        <Link className="wa-button-secondary" to="/topology">
          View full architecture
        </Link>
      }
    >
      {findings.length === 0 ? (
        <EmptyState
          reason="filtered-out"
          heading="No requirement matches this view"
          detail="Choose another pillar, outcome or movement filter to widen the report."
        />
      ) : (
        <>
          <RecordList label="Requirements to improve">
            {paged.rows.map((finding) => {
              const selected = finding.controlId === selectedControl;
              const resources = affectedResources(finding);
              return (
                <RecordButton
                  key={finding.controlId}
                  selected={selected}
                  onSelect={() => onFinding(finding)}
                  eyebrow={
                    <span className="flex flex-wrap items-center gap-1">
                      <SeverityBadge severity={finding.severity} />
                      <OutcomeBadge outcome={finding.outcome} />
                    </span>
                  }
                  title={finding.title}
                  summary={pillarTitle(finding.pillarId)}
                  meta={
                    <>
                      {finding.controlId} ·{' '}
                      {resources === 0
                        ? 'no affected-resource list'
                        : `${String(resources)} affected ${resources === 1 ? 'resource' : 'resources'}`}
                    </>
                  }
                  aside={selected ? 'Selected' : 'Open'}
                />
              );
            })}
          </RecordList>
          <Pagination paged={paged} noun="requirements" />
        </>
      )}
    </Surface>
  );
}

export function FindingResourceScope({
  finding,
  focus,
  workspaceDirectory,
  selectedNodeId,
  topologyError,
  onReloadTopology,
  onNode,
}: {
  readonly finding: Finding;
  readonly focus: ReturnType<typeof investigationFocus>;
  readonly workspaceDirectory?: SelectableWorkspaces;
  readonly selectedNodeId: string | null;
  readonly topologyError?: string;
  readonly onReloadTopology: () => void;
  readonly onNode: (id: string | undefined) => void;
}) {
  return (
    <Surface
      tone="raised"
      title="Affected resources"
      description={
        focus.resources.length === 0
          ? 'Scope-wide reading'
          : `${String(focus.resources.length)} ${focus.resources.length === 1 ? 'resource' : 'resources'} named`
      }
      headingLevel={3}
    >
      {focus.resources.length === 0 ? (
        <div className="space-y-1.5">
          <p className="wa-body-compact font-medium text-wa-text">This report did not name individual resources.</p>
          <p className="wa-body-compact text-wa-text-secondary">
            It measures a scope-wide share or policy. Use the closure plan in the inspector; the app will not fill the
            canvas with unrelated resources.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="min-w-0">
            <p className="wa-caption mb-2">
              Named by this requirement&rsquo;s evidence. Exact links remain actions only while the latest recorded
              workspace directory still identifies an available workspace.
            </p>
            <RecordList label={`Affected resources for ${finding.title}`}>
              {focus.resources.map((resource, index) => {
                const destination = resourceDestination(resource, workspaceDirectory);
                const content = {
                  eyebrow: resource.kind != null ? <ResourceKind kind={resource.kind} /> : undefined,
                  title: resource.label,
                  summary: [resource.in, resource.note].filter(Boolean).join(' · ') || undefined,
                  meta:
                    resource.url != null && destination.standing !== 'current'
                      ? recordedDestinationStatus(destination)
                      : undefined,
                };
                return resource.url != null && destination.standing === 'current' ? (
                  <RecordLink
                    key={resourceKey(resource, index)}
                    {...content}
                    to={resource.url}
                    external
                    aside="Open in Databricks"
                  />
                ) : (
                  <RecordValue key={resourceKey(resource, index)} {...content} />
                );
              })}
            </RecordList>
          </div>

          {focus.nodes.length > 0 && (
            <TechnicalDisclosure
              label="Relationship context"
              hint={`${String(focus.nodes.length)} related ${focus.nodes.length === 1 ? 'resource' : 'resources'} · optional`}
            >
              <div>
                <p className="wa-caption mb-2">
                  Neighbours touching the named resource are context, not additional affected resources and not a claim
                  of causation.
                </p>
                <TopologyCanvas
                  nodes={focus.nodes}
                  edges={focus.edges}
                  selectedId={
                    selectedNodeId != null && focus.nodes.some((node) => node.id === selectedNodeId)
                      ? selectedNodeId
                      : [...focus.selectedNodeIds][0]
                  }
                  onSelect={onNode}
                />
              </div>
            </TechnicalDisclosure>
          )}

          {topologyError != null && (
            <StateNotice
              tone="partial"
              title="Relationship context is unavailable"
              detail="The recorded resource list and destination actions remain; relationship context is a separate reading."
              action={
                <button type="button" className="wa-customer-secondary-action" onClick={onReloadTopology}>
                  Try context again
                </button>
              }
            />
          )}
        </div>
      )}
    </Surface>
  );
}

export function InvestigationPrimaryAction({
  finding,
  control,
  focus,
  workspaceDirectory,
  selectedNodeId,
  topologyError,
  onReloadTopology,
  onNode,
}: {
  readonly finding: Finding;
  readonly control?: CatalogueControl;
  readonly focus: InvestigationFocus;
  readonly workspaceDirectory?: SelectableWorkspaces;
  readonly selectedNodeId: string | null;
  readonly topologyError?: string;
  readonly onReloadTopology: () => void;
  readonly onNode: (id: string | undefined) => void;
}) {
  return (
    <div className="space-y-3">
      {finding.outcome === 'unmeasurable' ? (
        <MeasurementRemedyAction finding={finding} />
      ) : (
        <GapClosure
          finding={finding}
          control={control}
          resources={focus.resources}
          workspaceDirectory={workspaceDirectory}
        />
      )}
      <FindingResourceScope
        finding={finding}
        focus={focus}
        workspaceDirectory={workspaceDirectory}
        selectedNodeId={selectedNodeId}
        {...(topologyError != null ? { topologyError } : {})}
        onReloadTopology={onReloadTopology}
        onNode={onNode}
      />
    </div>
  );
}

function resourceKey(resource: LocatedItem, index: number): string {
  return [resource.kind ?? '', resource.url ?? '', resource.in ?? '', resource.label, String(index)].join(':');
}

function InvestigationInspector({
  finding,
  askedControl,
  knownFinding,
  node,
  askedNode,
  incident,
  graph,
  decision,
  control,
  focus,
  workspaceDirectory,
  selectedNodeId,
  topologyError,
  onReloadTopology,
  onNode,
  controlHref,
  onClearFilters,
}: {
  readonly finding?: Finding;
  readonly askedControl: string | null;
  readonly knownFinding: boolean;
  readonly node?: TopologyNode;
  readonly askedNode: string | null;
  readonly incident: readonly TopologyEdge[];
  readonly graph?: TopologyPayload;
  readonly decision?: Parameters<typeof FindingDetail>[0]['decision'];
  readonly control?: CatalogueControl;
  readonly focus?: ReturnType<typeof investigationFocus>;
  readonly workspaceDirectory?: SelectableWorkspaces;
  readonly selectedNodeId: string | null;
  readonly topologyError?: string;
  readonly onReloadTopology: () => void;
  readonly onNode: (id: string | undefined) => void;
  readonly controlHref: (controlId: string) => string;
  readonly onClearFilters: () => void;
}) {
  if (finding != null) {
    return (
      <div className="space-y-3">
        <FindingDetail
          finding={finding}
          decision={decision}
          controlHref={controlHref}
          resourceHref={(resource) => currentResourceUrl(resource, workspaceDirectory)}
          leadingAction={
            focus == null ? undefined : (
              <InvestigationPrimaryAction
                finding={finding}
                control={control}
                focus={focus}
                workspaceDirectory={workspaceDirectory}
                selectedNodeId={selectedNodeId}
                {...(topologyError != null ? { topologyError } : {})}
                onReloadTopology={onReloadTopology}
                onNode={onNode}
              />
            )
          }
        />
      </div>
    );
  }

  if (askedControl != null) {
    return (
      <Surface tone="task" title="Selected requirement unavailable">
        <EmptyState
          reason="filtered-out"
          heading={knownFinding ? 'The selected requirement is outside these filters' : 'Requirement not found'}
          detail={
            knownFinding
              ? 'The report contains this requirement, but the selected pillar, outcome or movement excludes it.'
              : `${askedControl} is not in this report.`
          }
          action={
            knownFinding ? (
              <button type="button" className="wa-customer-secondary-action" onClick={onClearFilters}>
                Clear filters and show it
              </button>
            ) : undefined
          }
        />
      </Surface>
    );
  }

  if (node != null) {
    const byId = new Map((graph?.nodes ?? []).map((candidate) => [candidate.id, candidate]));
    return (
      <Surface
        tone="task"
        title={node.label}
        description="Resource and recorded relationships"
        action={<ResourceKind kind={node.kind} />}
      >
        <div className="space-y-3">
          <p className="wa-body-compact text-wa-text-secondary">
            {incident.length} {incident.length === 1 ? 'edge' : 'edges'} in this report name this resource. The graph
            does not state that it caused a framework finding.
          </p>
          {incident.length > 0 && (
            <Surface tone="raised" title="Exact relationships" headingLevel={3}>
              <RecordList label="Exact relationships">
                {incident.map((edge) => (
                  <RecordValue
                    key={edge.id}
                    eyebrow={RELATION_LABEL[edge.relation]}
                    title={
                      <span className="wa-resource-relation">
                        {byId.get(edge.source) == null ? (
                          edge.source
                        ) : (
                          <ResourceEndpoint node={byId.get(edge.source)!} />
                        )}
                        <span aria-hidden="true">→</span>
                        {byId.get(edge.target) == null ? (
                          edge.target
                        ) : (
                          <ResourceEndpoint node={byId.get(edge.target)!} />
                        )}
                      </span>
                    }
                    meta={`${edge.joinedBy} · ${edge.lastSeen}`}
                  />
                ))}
              </RecordList>
            </Surface>
          )}
          <TechnicalDisclosure label="Technical identity" hint="Databricks ID">
            <p className="wa-caption break-all font-mono text-wa-text-secondary">{node.technicalId}</p>
          </TechnicalDisclosure>
        </div>
      </Surface>
    );
  }

  if (askedNode != null) {
    return (
      <Surface tone="task" title="Resource not found">
        <EmptyState
          reason="filtered-out"
          heading="Resource not found"
          detail={`${askedNode} is not in this report's architecture view.`}
        />
      </Surface>
    );
  }

  return (
    <Surface tone="task" title="Choose a requirement">
      <EmptyState
        reason="nothing-to-report"
        heading="Choose evidence or a resource"
        detail="Select a requirement to inspect its observed state, affected resources, evidence source and recommended action, or select a graph node to inspect its exact relationships."
      />
    </Surface>
  );
}

export function GapClosure({
  finding,
  control,
  resources,
  workspaceDirectory,
}: {
  readonly finding: Finding;
  readonly control?: CatalogueControl;
  readonly resources: readonly LocatedItem[];
  readonly workspaceDirectory?: SelectableWorkspaces;
}) {
  const exact = resources.filter((resource) => resource.url != null);
  const destination = exact.length === 1 ? resourceDestination(exact[0], workspaceDirectory) : undefined;
  const currentDestination = destination?.standing === 'current';
  const doThis =
    control?.remediation?.summary ?? finding.remedy?.says ?? 'Create an improvement plan for this requirement.';
  const why = findingActionReason(finding.outcomeReason, control?.rationale);
  const verification =
    control?.criteria ?? 'A later assessment will evaluate this requirement again against current evidence.';
  const remediation = requirementHref('/improvements', finding.controlId);

  return (
    <CustomerActionPanel
      eyebrow="Do this"
      recommendation
      title={doThis}
      why={<p className="wa-body-compact text-wa-text-secondary">{why}</p>}
      action={
        <div className="flex flex-wrap justify-end gap-2">
          {currentDestination ? (
            <a className="wa-button-primary" href={exact[0].url} target="_blank" rel="noreferrer">
              Open in Databricks <ExternalLink aria-hidden className="h-3.5 w-3.5" />
            </a>
          ) : (
            <Link className="wa-button-primary" to={remediation}>
              Create improvement plan
            </Link>
          )}
          {currentDestination && (
            <Link className="wa-button-secondary" to={remediation}>
              Create improvement plan
            </Link>
          )}
          {control?.remediation?.docUrl != null && (
            <a className="wa-button-secondary" href={control.remediation.docUrl} target="_blank" rel="noreferrer">
              Databricks guide <ExternalLink aria-hidden className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      }
      destination={
        currentDestination
          ? exact[0].label
          : exact.length === 1
            ? destinationDescription(exact[0], destination!)
            : exact.length > 1
              ? `Affected resources names ${String(exact.length)} exact Databricks objects.`
              : 'The improvement planning workflow in this app.'
      }
      owner="Assign in the improvement plan"
      verification={verification}
    />
  );
}

function recordedDestinationStatus(destination: ResourceDestination): string {
  if (destination.standing === 'unavailable') {
    return `Recorded resource · workspace ${statusLabel(destination.workspace?.status)}${asOf(destination.asOf)}. Create an improvement plan here, then run a fresh assessment to refresh the destination.`;
  }
  return `Recorded resource · current destination not verified${asOf(destination.asOf)}. Create an improvement plan here, then run a fresh assessment to refresh it.`;
}

function destinationDescription(resource: LocatedItem, destination: ResourceDestination): string {
  if (destination.standing === 'unavailable') {
    return `${resource.label} was recorded by this assessment. The workspace directory records its workspace as ${statusLabel(destination.workspace?.status)}${asOf(destination.asOf)}. Run a fresh assessment to refresh the destination.`;
  }
  return `${resource.label} was recorded by this assessment, but the current destination could not be verified${asOf(destination.asOf)}. Run a fresh assessment to refresh it.`;
}

function statusLabel(status: string | undefined): string {
  return status == null ? 'unavailable' : status.toLocaleLowerCase().replaceAll('_', ' ');
}

function asOf(value: string | undefined): string {
  return value == null ? '' : ` as of ${value.slice(0, 10)}`;
}

function matchesOutcome(actual: Outcome, filter: OutcomeFilter): boolean {
  if (filter === ALL) return true;
  if (filter === UNMET) return actual === 'fail' || actual === 'partial';
  if (filter === MET) return actual === 'pass' || actual === 'satisfied-by-architecture';
  return actual === filter;
}

function affectedResources(finding: Finding): number {
  return findingResources(finding).length;
}

function isOutcomeFilter(value: string | null): value is OutcomeFilter {
  return (
    value === ALL ||
    value === UNMET ||
    value === MET ||
    value === 'fail' ||
    value === 'partial' ||
    value === 'unmeasurable' ||
    value === 'pass' ||
    value === 'satisfied-by-architecture' ||
    value === 'not-applicable'
  );
}

function isChangeFilter(value: string | null): value is ChangeFilter {
  return value === ALL || value === 'new' || value === 'regressed' || value === 'changed' || value === 'resolved';
}
