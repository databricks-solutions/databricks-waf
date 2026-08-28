/**
 * Deterministic, invented customer states for development-only visual acceptance.
 *
 * These records are never written to the API or customer store. They exercise the exact published
 * Dashboard composition with plausible complete, sparse, empty and materially changed results.
 */

import type {
  CatalogueControl,
  CatalogueResponse,
  Finding,
  ImprovementAction,
  LocatedItem,
  Scan,
  SelectableWorkspaces,
  ValueReport,
} from '@/api/types';
import type { TopologyPayload } from '../../../shared/api/topology';
import type { CustomerPreviewState } from '../../../shared/customer-acceptance';
import type { Gap } from '@/components/evidence-gaps';
import { splitFindings, type RankedFinding } from '@/components/finding-rank';
import { pillarRows } from '@/components/pillar-rows';
import { appendixRows } from '@/pages/report-language';

export { CUSTOMER_PREVIEW_STATES, type CustomerPreviewState } from '../../../shared/customer-acceptance';

export const PREVIEW_PILLARS = [
  { id: 'cost-optimization', title: 'Cost optimization' },
  { id: 'data-and-ai-governance', title: 'Data and AI governance' },
  { id: 'interoperability-and-usability', title: 'Interoperability and usability' },
  { id: 'operational-excellence', title: 'Operational excellence' },
  { id: 'performance-efficiency', title: 'Performance efficiency' },
  { id: 'reliability', title: 'Reliability' },
  { id: 'security-compliance-and-privacy', title: 'Security, compliance, and privacy' },
] as const;

export const PREVIEW_CONTROLS: Readonly<Record<string, CatalogueControl>> = {
  'PE-03-01': {
    id: 'PE-03-01',
    title: 'Use serverless compute for repeatable production workloads',
    severity: 'critical',
    provenance: 'waf-docs',
    measurability: 'system-table',
    evaluatorStatus: 'implemented',
    criteria: 'Production jobs use a managed compute option appropriate to their workload.',
    rationale: 'Managed compute reduces undifferentiated operations and applies current platform defaults.',
    remediation: {
      summary: 'Open the job and select serverless compute for the production task, then run the job once.',
      deepLink: 'https://dbc-example.cloud.databricks.com/jobs/482901347110/tasks?o=7000000000000023',
    },
  },
  'SEC-02-04': {
    id: 'SEC-02-04',
    title: 'Restrict public network access',
    severity: 'high',
    provenance: 'waf-docs',
    measurability: 'rest-api',
    evaluatorStatus: 'implemented',
    remediation: { summary: 'Review workspace network access and remove public ingress that is not required.' },
  },
  'REL-03-02': {
    id: 'REL-03-02',
    title: 'Define recovery ownership and verification',
    severity: 'high',
    provenance: 'waf-docs',
    measurability: 'attestation',
    evaluatorStatus: 'implemented',
    remediation: { summary: 'Assign a recovery owner and record the evidence from the latest recovery exercise.' },
  },
  'OE-02-04': {
    id: 'OE-02-04',
    title: 'Keep production changes reproducible',
    severity: 'medium',
    provenance: 'waf-docs',
    measurability: 'derived',
    evaluatorStatus: 'implemented',
    remediation: { summary: 'Move the remaining manual configuration into the deployment repository.' },
  },
  'COST-01-03': {
    id: 'COST-01-03',
    title: 'Remove idle all-purpose compute',
    severity: 'medium',
    provenance: 'waf-docs',
    measurability: 'system-table',
    evaluatorStatus: 'implemented',
    remediation: { summary: 'Set an auto-termination policy appropriate to the interactive workload.' },
  },
};

const COMPLETE_FINDINGS = [
  finding(
    'PE-03-01',
    'performance-efficiency',
    'Use serverless compute for repeatable production workloads',
    'critical',
    3,
    3
  ),
  finding('SEC-02-04', 'security-compliance-and-privacy', 'Restrict public network access', 'high', 2, 9),
  finding('REL-03-02', 'reliability', 'Define recovery ownership and verification', 'high', 1, 1),
  finding('OE-02-04', 'operational-excellence', 'Keep production changes reproducible', 'medium', 4, 17),
  finding('COST-01-03', 'cost-optimization', 'Remove idle all-purpose compute', 'medium', 6, 22),
] as const;

const INVESTIGATION_RESOURCES: readonly LocatedItem[] = [
  {
    kind: 'job',
    label: 'Daily production ingestion',
    in: 'analytics-prod',
    url: 'https://dbc-example.cloud.databricks.com/jobs/482901347110?o=7000000000000023',
  },
  {
    kind: 'job',
    label: 'Customer feature refresh',
    in: 'ml-prod',
    url: 'https://dbc-example.cloud.databricks.com/jobs/581044822744?o=7000000000000023',
  },
  {
    kind: 'job',
    label: 'Finance reconciliation',
    in: 'data-products-prod',
    url: 'https://dbc-example.cloud.databricks.com/jobs/690155933855?o=7000000000000023',
  },
];

const INVESTIGATION_TOPOLOGY: TopologyPayload = {
  cap: 2_000,
  truncated: false,
  nodes: [
    { id: 'job:482901347110', kind: 'job', label: 'Daily production ingestion', technicalId: '482901347110' },
    {
      id: 'job:581044822744',
      kind: 'job',
      label: 'Customer feature refresh',
      technicalId: '581044822744',
    },
  ],
  edges: [
    {
      id: 'preview-job-pipeline',
      source: 'job:581044822744',
      target: 'job:482901347110',
      relation: 'job-to-job',
      joinedBy: 'system.lakeflow.job_run_timeline',
      lastSeen: '2026-08-22T00:03:00.000Z',
    },
  ],
};

const CURRENT_WORKSPACES: SelectableWorkspaces = {
  asOf: '2026-08-22T00:03:00.000Z',
  workspaces: [
    {
      id: '7000000000000023',
      name: 'labs',
      status: 'RUNNING',
      assessable: true,
      url: 'https://dbc-example.cloud.databricks.com',
    },
  ],
};

const HISTORICAL_WORKSPACES: SelectableWorkspaces = {
  asOf: '2026-08-22T00:03:00.000Z',
  workspaces: [
    {
      id: '7000000000000026',
      name: 'retired-labs',
      status: 'BANNED',
      assessable: false,
      reason: 'not-running',
      url: 'https://dbc-retired.example.com',
    },
  ],
};

export interface InvestigationPreviewFixture {
  readonly finding?: Finding;
  readonly control?: CatalogueControl;
  readonly topology?: TopologyPayload;
  readonly topologyError?: string;
  readonly workspaceDirectory?: SelectableWorkspaces;
}

export function investigationPreviewFixture(state: CustomerPreviewState): InvestigationPreviewFixture {
  if (state === 'empty') return {};
  const resources =
    state === 'sparse'
      ? [
          {
            ...INVESTIGATION_RESOURCES[0],
            url: 'https://dbc-retired.example.com/jobs/482901347110?o=7000000000000026',
          },
        ]
      : INVESTIGATION_RESOURCES;
  const base = COMPLETE_FINDINGS[0];
  if (base == null) throw new Error('The investigation preview needs one finding.');
  const findingWithResources: Finding = {
    ...base,
    evidence: base.evidence.map((entry, index) =>
      index === 0 ? { ...entry, at: { lead: 'Jobs using classic task compute', items: resources } } : entry
    ),
  };

  return {
    finding: findingWithResources,
    control: PREVIEW_CONTROLS[findingWithResources.controlId],
    workspaceDirectory: state === 'sparse' ? HISTORICAL_WORKSPACES : CURRENT_WORKSPACES,
    ...(state === 'complete' ? { topology: INVESTIGATION_TOPOLOGY } : {}),
    ...(state === 'changed' ? { topologyError: 'Relationship evidence could not be read with this identity.' } : {}),
  };
}

const COMPLETE_GAPS: readonly Gap[] = [
  {
    id: 'attestation',
    title: 'Requirements only a person can confirm',
    blocked: 5,
    pillars: ['Reliability', 'Operational excellence'],
    resolve: 'These practices need an accountable person to confirm the current operating evidence.',
    counted: true,
    action: { label: 'Answer requirements', to: '/answers' },
  },
  {
    id: 'unreadable',
    title: 'Requirements whose evidence could not be read',
    blocked: 3,
    pillars: ['Security, compliance, and privacy'],
    resolve: 'The latest collection was refused access to the evidence these requirements use.',
    counted: true,
    action: { label: 'Review access', to: '/checks' },
  },
];

const SPARSE_GAPS: readonly Gap[] = [
  {
    id: 'attestation',
    title: 'Requirements only a person can confirm',
    blocked: 37,
    pillars: ['Reliability', 'Operational excellence', 'Data and AI governance'],
    resolve: 'These practices need an accountable person to answer them before the score can settle.',
    counted: true,
    action: { label: 'Answer requirements', to: '/answers' },
  },
  {
    id: 'unreadable',
    title: 'Requirements whose evidence could not be read',
    blocked: 42,
    pillars: ['Security, compliance, and privacy', 'Cost optimization'],
    resolve: 'The signed-in reader does not currently have access to the required evidence.',
    counted: true,
    action: { label: 'Review access', to: '/checks' },
  },
  {
    id: 'unbuilt',
    title: 'Requirements without an automated check',
    blocked: 32,
    pillars: ['Interoperability and usability', 'Performance efficiency'],
    resolve: 'This version records no automated evaluation for these requirements.',
    counted: true,
    action: { label: 'Review requirements', to: '/investigate?outcome=unmeasurable' },
  },
  {
    id: 'not-applicable',
    title: '30 requirements that do not apply to this estate',
    blocked: 30,
    pillars: ['Cost optimization', 'Performance efficiency'],
    resolve: 'These requirements are outside the score rather than unanswered.',
    counted: false,
    action: { label: 'View requirements', to: '/investigate?outcome=not-applicable' },
  },
  {
    id: 'silent-signals',
    title: '2 collectors returned nothing',
    blocked: 2,
    pillars: [],
    resolve: 'The collectors ran and produced no usable observation.',
    counted: false,
    action: { label: 'See the run record', to: '/history/preview-sparse' },
  },
];

export interface DashboardPreviewFixture {
  readonly scan: Scan;
  readonly queue: readonly RankedFinding[];
  readonly gaps: readonly Gap[];
  readonly changes?: { readonly loading: boolean; readonly lines: readonly string[] };
  readonly firstControl?: CatalogueControl;
}

export function dashboardPreviewFixture(state: CustomerPreviewState): DashboardPreviewFixture {
  const sparse = state === 'sparse';
  const empty = state === 'empty';
  const findings = empty ? [] : COMPLETE_FINDINGS;
  const scan = makeScan({ sparse, empty, findings });
  const ranked = splitFindings(findings, (controlId) => PREVIEW_CONTROLS[controlId]);

  return {
    scan,
    queue: ranked.queue,
    gaps: sparse ? SPARSE_GAPS : empty ? [] : COMPLETE_GAPS,
    ...(state === 'changed'
      ? {
          changes: {
            loading: false,
            lines: [
              'Coverage increased from 88% to 95% of applicable requirements.',
              'Three high-priority requirements moved to met after the latest assessment.',
              'One new compute requirement entered the action queue.',
            ],
          },
        }
      : state === 'complete'
        ? {
            changes: {
              loading: false,
              lines: ['Measured posture is unchanged since the previous comparable assessment.'],
            },
          }
        : {}),
    ...(ranked.queue[0] == null ? {} : { firstControl: PREVIEW_CONTROLS[ranked.queue[0].finding.controlId] }),
  };
}

function makeScan({
  sparse,
  empty,
  findings,
}: {
  readonly sparse: boolean;
  readonly empty: boolean;
  readonly findings: readonly Finding[];
}): Scan {
  const counts = sparse
    ? { pass: 34, fail: 5, partial: 4, unmeasurable: 111, 'not-applicable': 30, 'satisfied-by-architecture': 0 }
    : empty
      ? { pass: 169, fail: 0, partial: 0, unmeasurable: 0, 'not-applicable': 15, 'satisfied-by-architecture': 0 }
      : { pass: 143, fail: 12, partial: 6, unmeasurable: 8, 'not-applicable': 15, 'satisfied-by-architecture': 0 };
  const pillarTotals = [26, 27, 25, 27, 26, 27, 26];

  return {
    id: `preview-${sparse ? 'sparse' : empty ? 'empty' : 'complete'}`,
    startedAt: '2026-08-21T23:30:00.000Z',
    finishedAt: '2026-08-22T00:08:00.000Z',
    state: 'complete',
    stamp: {
      publicMethodology: {
        publicVersion: 1,
        manifestDigest: 'sha256:preview-methodology-manifest',
        state: 'released',
        effectiveDate: '2026-08-01',
      },
      catalogueVersion: 'customer-methodology-1',
      catalogueFingerprint: 'sha256:preview-catalogue',
      executionMode: 'on-behalf-of-user',
      actor: 'platform.assessor@example.com',
      actorName: 'Platform assessor',
      scope: { description: 'Production account · 9 workspaces' },
      lookbackDays: 30,
      assessedWorkspaces: ['analytics-prod', 'data-products-prod', 'ml-prod'],
      definition: {
        id: 'preview-definition',
        version: 3,
        fingerprint: 'preview-definition-v3',
        name: 'Production architecture review',
      },
    },
    measurement: [],
    score: {
      overall: empty ? 94 : sparse ? 79 : 82,
      range: empty ? { low: 94, high: 94 } : sparse ? { low: 24, high: 98 } : { low: 78, high: 86 },
      pillars: PREVIEW_PILLARS.map((pillar, index) =>
        pillarScore(pillar.id, pillarTotals[index] ?? 26, sparse, empty, index)
      ),
      counts,
      scoredControls: sparse ? 43 : empty ? 166 : 158,
      composition: sparse
        ? { observed: 39, attested: 4, 'admin-collected': 0 }
        : empty
          ? { observed: 158, attested: 8, 'admin-collected': 0 }
          : { observed: 147, attested: 11, 'admin-collected': 0 },
      totalControls: 184,
    },
    findings,
    footprint: { surfaces: [], durationMs: 2_280_000, cancelled: false, concurrencyReductions: 2 },
    spend: [],
    signals: [],
    estate: {
      workspacesInAccount: 9,
      assessed: [
        { id: '1001', name: 'analytics-prod', status: 'RUNNING' },
        { id: '1002', name: 'data-products-prod', status: 'RUNNING' },
        { id: '1003', name: 'ml-prod', status: 'RUNNING' },
      ],
      excluded: [],
      region: 'ap-southeast-2',
    },
    finalisation: {
      reviewId: 'preview-review',
      resultId: 'preview-result',
      finalised: true,
      recorded: PREVIEW_PILLARS.length,
      expected: PREVIEW_PILLARS.length,
      confirmed: PREVIEW_PILLARS.length,
      skipped: [],
      cited: sparse ? 4 : empty ? 8 : 11,
      refreshed: 2,
      finalisedBy: 'architecture.owner@example.com',
      finalisedAt: '2026-08-22T00:15:00.000Z',
    },
  };
}

function pillarScore(
  pillarId: string,
  total: number,
  sparse: boolean,
  empty: boolean,
  index: number
): Scan['score']['pillars'][number] {
  const notApplicable = sparse ? 4 : 2;
  const unmeasurable = empty
    ? 0
    : sparse
      ? Math.max(12, total - 10)
      : index === 6
        ? 3
        : index === 5
          ? 2
          : index < 3
            ? 1
            : 0;
  const fail = empty ? 0 : sparse ? (index % 2 === 0 ? 1 : 0) : index === 4 || index === 6 ? 3 : 1;
  const partial = empty ? 0 : sparse ? (index === 5 ? 2 : 0) : index % 3 === 0 ? 2 : 1;
  const pass = Math.max(0, total - notApplicable - unmeasurable - fail - partial);
  const assessed = pass + fail + partial;
  const score = empty ? 94 - index : sparse ? 68 + index * 3 : 74 + index * 3;

  return {
    pillarId,
    score,
    range: sparse
      ? { low: Math.max(0, score - 45), high: Math.min(100, score + 25) }
      : { low: score - 3, high: score + 3 },
    counts: { pass, fail, partial, unmeasurable, 'not-applicable': notApplicable, 'satisfied-by-architecture': 0 },
    scored: assessed,
    unmeasurable,
    unmeasuredBy: {
      attestation: Math.floor(unmeasurable / 3),
      unreachable: Math.floor(unmeasurable / 3),
      unbuilt: unmeasurable - Math.floor(unmeasurable / 3) * 2,
      unreadable: 0,
      disabled: 0,
    },
    composition: { observed: Math.max(0, assessed - 1), attested: assessed > 0 ? 1 : 0, 'admin-collected': 0 },
    notApplicable,
    total,
    worstFirst: [],
  };
}

function finding(
  controlId: string,
  pillarId: string,
  title: string,
  severity: Finding['severity'],
  examined: number,
  population: number
): Finding {
  return {
    controlId,
    pillarId,
    principleId: `${pillarId}-principle`,
    title,
    outcome: 'fail',
    severity,
    outcomeReason: `${examined.toLocaleString()} of ${population.toLocaleString()} named resources did not meet this requirement.`,
    coverage: { mode: 'complete', reach: 'workspace', examined, population },
    evidence: [
      {
        signal: `preview:${controlId.toLowerCase()}`,
        observed: `${examined.toLocaleString()} affected resources`,
        expected: 'Every in-scope resource meets the published requirement.',
        coverage: { mode: 'complete', reach: 'workspace', examined, population },
        collectedAt: '2026-08-22T00:03:00.000Z',
        provenance: {
          surface: 'sql',
          collector: `preview:${controlId.toLowerCase()}`,
          authority: 'on-behalf-of-user',
          actor: 'platform.assessor@example.com',
          from: '0123456789abcdef',
        },
      },
    ],
    confidence: {
      standing: 'established',
      because: 'The assessment read the complete in-scope population.',
      limitations: [],
    },
  };
}

export const PREVIEW_CATALOGUE: CatalogueResponse = {
  version: { version: 'customer-methodology-1', fingerprint: 'sha256:preview-catalogue' },
  measuredPillars: PREVIEW_PILLARS.map((pillar) => pillar.id),
  pillars: PREVIEW_PILLARS.map((pillar, index) => ({
    id: pillar.id,
    code: `P${String(index + 1)}`,
    title: pillar.title,
    principles: [
      {
        id: `${pillar.id}-principle`,
        title: `${pillar.title} practices`,
        controls: Object.values(PREVIEW_CONTROLS).filter((control) =>
          COMPLETE_FINDINGS.some((entry) => entry.controlId === control.id && entry.pillarId === pillar.id)
        ),
      },
    ],
  })),
};

const REPORT_COMPLETE_GAPS: readonly Gap[] = COMPLETE_GAPS.slice(0, 2).map((gap, index) => ({
  ...gap,
  blocked: index === 0 ? 2 : 1,
}));

const REPORT_SPARSE_GAPS: readonly Gap[] = SPARSE_GAPS.slice(0, 3).map((gap, index) => ({
  ...gap,
  blocked: 6 - index,
}));

const PREVIEW_ACTIONS: readonly ImprovementAction[] = [
  {
    id: 'preview-action-serverless',
    planId: 'preview-plan',
    controlIds: ['PE-03-01'],
    outcome: 'Production ingestion runs on serverless compute.',
    definitionOfDone: 'A later assessment reads the job on serverless compute and PE-03-01 no longer fails.',
    owner: 'Platform engineering',
    priority: 'now',
    effort: 'medium',
    due: '2026-09-15T23:59:59.999Z',
    steps: ['Change the job compute setting.', 'Run the production task once.', 'Publish a later assessment.'],
    dependsOn: [],
    state: 'in-progress',
    raisedFrom: 'preview-report-complete',
    createdBy: 'architecture.owner@example.com',
    createdAt: '2026-08-18T02:00:00.000Z',
    history: [
      {
        from: 'planned',
        to: 'in-progress',
        at: '2026-08-19T01:00:00.000Z',
        by: 'person',
        who: 'platform.owner@example.com',
      },
    ],
    agreement: 'unclaimed',
    lateness: 'on-time',
    unmet: ['PE-03-01'],
    unreadable: [],
    moves: ['blocked', 'ready-for-validation', 'cancelled'],
    titles: { 'PE-03-01': 'Use serverless compute for repeatable production workloads' },
  },
  {
    id: 'preview-action-recovery',
    planId: 'preview-plan',
    controlIds: ['REL-03-02'],
    outcome: 'Recovery ownership and evidence are current.',
    definitionOfDone: 'The next assessment cites a current recovery exercise and an accountable owner.',
    owner: 'Reliability engineering',
    priority: 'next',
    effort: 'small',
    steps: ['Name the recovery owner.', 'Attach the latest recovery exercise record.'],
    dependsOn: [],
    state: 'blocked',
    raisedFrom: 'preview-report-complete',
    createdBy: 'architecture.owner@example.com',
    createdAt: '2026-08-18T02:05:00.000Z',
    history: [],
    agreement: 'unclaimed',
    lateness: 'undated',
    unmet: ['REL-03-02'],
    unreadable: [],
    moves: ['in-progress', 'cancelled'],
    titles: { 'REL-03-02': 'Define recovery ownership and verification' },
  },
];

export function improvementPreviewAction(state: CustomerPreviewState): ImprovementAction | undefined {
  if (state === 'empty') return undefined;
  const first = PREVIEW_ACTIONS[0];
  const blocked = PREVIEW_ACTIONS[1];
  if (first == null || blocked == null) throw new Error('The improvement preview needs two actions.');
  if (state === 'sparse') return blocked;
  if (state === 'changed') {
    return {
      ...first,
      state: 'ready-for-validation',
      agreement: 'contradicted',
      unmet: ['PE-03-01'],
      moves: ['in-progress', 'blocked', 'cancelled'],
    };
  }
  return first;
}

const PREVIEW_VALUE: ValueReport = {
  posture: {
    runId: 'preview-report-complete',
    at: '2026-08-22T00:08:00.000Z',
    overall: 76,
    scoredControls: 19,
    totalControls: 24,
    unmeasured: 3,
  },
  opportunity: [
    {
      advisor: 'jobs',
      low: 2_400,
      high: 4_100,
      currency: 'USD',
      region: 'ap-southeast-2',
      resources: 3,
      actions: 4,
      assumptions: ['The advisor used the latest 30-day list-price reading.'],
    },
  ],
  committed: [
    {
      advisor: 'jobs',
      low: 1_200,
      high: 2_100,
      currency: 'USD',
      region: 'ap-southeast-2',
      resources: 2,
      actions: 2,
      assumptions: ['The range is frozen from the advice when work was raised.'],
    },
  ],
  realised: [{ advisor: 'jobs', label: 'Monthly DBUs', unit: 'count', before: 640, after: 490, measurements: 2 }],
  cleared: { actions: 1, resources: 1 },
  outcomes: { unclaimed: 1, awaiting: 0, agreed: 1, contradicted: 0, unmeasured: 0, unjudged: 0 },
};

export interface ReportPreviewFixture {
  readonly scan: Scan;
  readonly ranked: readonly RankedFinding[];
  readonly rows: ReturnType<typeof appendixRows>;
  readonly gaps: readonly Gap[];
  readonly pillarRows: ReturnType<typeof pillarRows>;
  readonly value?: ValueReport;
  readonly actions: readonly ImprovementAction[];
  readonly raisedByControl: ReadonlyMap<string, readonly ImprovementAction[]>;
}

export function reportPreviewFixture(state: CustomerPreviewState): ReportPreviewFixture {
  const scan = makeReportScan(state);
  const ranked = splitFindings(scan.findings, (controlId) => PREVIEW_CONTROLS[controlId]);
  const actions = state === 'empty' ? [] : PREVIEW_ACTIONS;
  const raisedByControl = new Map<string, ImprovementAction[]>();
  for (const action of actions) {
    for (const controlId of action.controlIds) {
      const related = raisedByControl.get(controlId) ?? [];
      related.push(action);
      raisedByControl.set(controlId, related);
    }
  }

  return {
    scan,
    ranked: ranked.queue,
    rows: appendixRows(scan.findings, PREVIEW_PILLARS),
    gaps: state === 'sparse' ? REPORT_SPARSE_GAPS : state === 'empty' ? [] : REPORT_COMPLETE_GAPS,
    pillarRows: pillarRows(scan, PREVIEW_CATALOGUE, []),
    ...(state === 'empty'
      ? {}
      : {
          value: {
            ...PREVIEW_VALUE,
            posture: {
              ...PREVIEW_VALUE.posture!,
              runId: scan.id,
              overall: scan.score.overall,
              unmeasured: scan.score.counts.unmeasurable,
            },
          },
        }),
    actions,
    raisedByControl,
  };
}

function makeReportScan(state: CustomerPreviewState): Scan {
  const sparse = state === 'sparse';
  const empty = state === 'empty';
  const open: Finding[] = empty
    ? []
    : sparse
      ? COMPLETE_FINDINGS.slice(0, 2).map((entry, index) => (index === 1 ? { ...entry, outcome: 'partial' } : entry))
      : COMPLETE_FINDINGS.map((entry, index) => (index >= 3 ? { ...entry, outcome: 'partial' } : entry));
  const pass = empty ? 22 : sparse ? 5 : 14;
  const unmeasured = empty ? 0 : sparse ? 15 : 3;
  const notApplicable = 2;
  const findings: Finding[] = [
    ...open,
    ...Array.from({ length: pass }, (_, index) => reportFinding(index, 'pass')),
    ...Array.from({ length: unmeasured }, (_, index) => reportFinding(index + pass, 'unmeasurable')),
    ...Array.from({ length: notApplicable }, (_, index) => reportFinding(index + pass + unmeasured, 'not-applicable')),
  ];
  const counts = {
    pass,
    fail: open.filter((entry) => entry.outcome === 'fail').length,
    partial: open.filter((entry) => entry.outcome === 'partial').length,
    unmeasurable: unmeasured,
    'not-applicable': notApplicable,
    'satisfied-by-architecture': 0,
  };
  const pillarTotals = [4, 4, 3, 4, 3, 3, 3];
  const base = makeScan({ sparse, empty, findings });

  return {
    ...base,
    id: `preview-report-${state}`,
    score: {
      ...base.score,
      overall: empty ? 94 : sparse ? 84 : 76,
      range: empty ? { low: 94, high: 94 } : sparse ? { low: 18, high: 99 } : { low: 68, high: 84 },
      counts,
      scoredControls: pass + open.length,
      totalControls: findings.length,
      composition: { observed: Math.max(0, pass + open.length - 2), attested: empty ? 2 : 2, 'admin-collected': 0 },
      pillars: PREVIEW_PILLARS.map((pillar, index) =>
        smallReportPillar(pillar.id, pillarTotals[index] ?? 3, sparse, empty, index)
      ),
    },
    findings,
  };
}

function smallReportPillar(
  pillarId: string,
  total: number,
  sparse: boolean,
  empty: boolean,
  index: number
): Scan['score']['pillars'][number] {
  const notApplicable = index < 2 ? 1 : 0;
  const unmeasurable = empty ? 0 : sparse ? Math.max(1, total - 2) : index < 3 ? 1 : 0;
  const fail = empty ? 0 : index === 4 || index === 6 ? 1 : 0;
  const partial = empty ? 0 : index === 0 || index === 3 ? 1 : 0;
  const pass = Math.max(0, total - notApplicable - unmeasurable - fail - partial);
  const assessed = pass + fail + partial;
  const score = empty ? 94 - index : sparse ? 72 + index * 2 : 68 + index * 4;
  return {
    pillarId,
    score,
    range: sparse ? { low: Math.max(0, score - 50), high: 100 } : { low: score - 5, high: score + 5 },
    counts: { pass, fail, partial, unmeasurable, 'not-applicable': notApplicable, 'satisfied-by-architecture': 0 },
    scored: assessed,
    unmeasurable,
    unmeasuredBy: { attestation: unmeasurable, unreachable: 0, unbuilt: 0, unreadable: 0, disabled: 0 },
    composition: { observed: Math.max(0, assessed - 1), attested: assessed > 0 ? 1 : 0, 'admin-collected': 0 },
    notApplicable,
    total,
    worstFirst: [],
  };
}

function reportFinding(index: number, outcome: Finding['outcome']): Finding {
  const pillar = PREVIEW_PILLARS[index % PREVIEW_PILLARS.length];
  if (pillar == null) throw new Error('The report preview needs at least one pillar.');
  const controlId = `${pillar.id.slice(0, 3).toUpperCase()}-${String(index + 10).padStart(2, '0')}`;
  return {
    controlId,
    pillarId: pillar.id,
    principleId: `${pillar.id}-principle`,
    title:
      outcome === 'pass'
        ? `Verified ${pillar.title.toLowerCase()} practice ${String(index + 1)}`
        : outcome === 'unmeasurable'
          ? `Evidence needed for ${pillar.title.toLowerCase()} practice ${String(index + 1)}`
          : `Excluded ${pillar.title.toLowerCase()} practice ${String(index + 1)}`,
    outcome,
    severity: 'informational',
    outcomeReason: outcome === 'not-applicable' ? 'The published scope excludes this practice.' : undefined,
    unmeasured: outcome === 'unmeasurable' ? 'attestation' : undefined,
    remedy:
      outcome === 'unmeasurable'
        ? { kind: 'attest', says: 'Ask the accountable owner to record the current practice.', signals: [] }
        : undefined,
    coverage: { mode: 'complete' },
    evidence: [],
  };
}
