// Operational excellence, and the line between a practice and its artefact.
//
// This pillar arrived with all 21 controls marked `attestation`, and seven of them were moved
// onto evidence. The risk that move creates is overreading: an asset bundle marker is not a
// code review, a health rule is not an on-call rota, and two catalogs are not a catalog
// strategy. So most of what these tests defend is the ceiling rather than the floor — that
// each resolver stops at partial where its evidence stops, and that the absence of a marker
// is never converted into a failure when the marker is one-way.
//
// The infrastructure-as-code case is the sharpest of those and gets the most attention: a
// Terraform-managed estate is indistinguishable from a hand-built one on this signal, so a
// `fail` there would be reporting the limits of the app's evidence as a defect in the
// customer's practice.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { observed, unmeasurable, type SignalId, type SignalResult } from '../../collect/signal.js';
import type {
  AssetCensus,
  ClusterRow,
  JobRow,
  LineageCoverage,
  MlflowRunTracking,
  PipelineRow,
  QueryCapacity,
  ServingModelEntity,
} from '../../collect/sql/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const CENSUS = 'sql:uc.census' as SignalId;
const LINEAGE = 'sql:uc.lineage_coverage' as SignalId;
const CLUSTERS = 'sql:compute.clusters' as SignalId;
const JOBS = 'sql:jobs.inventory' as SignalId;
const PIPELINES = 'sql:pipelines.inventory' as SignalId;
const PROFILE = 'sql:estate.compute_profile' as SignalId;

const catalogue = loadCatalogue();
const registry = buildRegistry();

function census(overrides: Partial<AssetCensus> = {}): AssetCensus {
  return {
    tableCount: 120,
    catalogCount: 4,
    schemaCount: 18,
    managedTables: 100,
    externalTables: 20,
    views: 12,
    metricViews: 0,
    foreignTables: 0,
    deltaTables: 118,
    icebergTables: 2,
    optimizedFormatTables: 120,
    describedTables: 60,
    distinctOwners: 5,
    databricksOwnedTables: 0,
    databricksOwnedCatalogs: '',
    ...overrides,
  };
}

/** A lineage reading that corroborates an empty metastore. */
function empty(): LineageCoverage {
  return { tableCount: 0, tablesWithLineage: 0, tablesWrittenWithLineage: 0, tablesReadWithLineage: 0, lineageEvents: 0 };
}

/** A lineage reading that contradicts one, since `system.access.table_lineage` is not filtered. */
function busy(): LineageCoverage {
  return { tableCount: 0, tablesWithLineage: 21, tablesWrittenWithLineage: 14, tablesReadWithLineage: 19, lineageEvents: 1_246 };
}

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    workspaceId: '1',
    jobId: 'j-1',
    name: 'nightly-load',
    scheduled: true,
    scheduledKnown: true,
    healthRuleCount: 1,
    healthRulesKnown: true,
    hasStreamBacklogRule: false,
    tagCount: 1,
    ...overrides,
  };
}

function pipeline(overrides: Partial<PipelineRow> = {}): PipelineRow {
  return {
    workspaceId: '1',
    pipelineId: 'p-1',
    name: 'bronze-to-silver',
    development: false,
    serverless: true,
    photon: true,
    tagCount: 0,
    updates: 14,
    failedUpdates: 0,
    ...overrides,
  };
}

function cluster(overrides: Partial<ClusterRow> = {}): ClusterRow {
  return {
    workspaceId: '1',
    clusterId: 'c-1',
    name: 'analytics',
    source: 'UI',
    hasPolicy: true,
    autoscaling: true,
    autoTerminates: true,
    gpuNode: false,
    initScriptCount: 0,
    dbfsInitScriptCount: 0,
    initScriptsKnown: true,
    tagCount: 2,
    workerCount: 2,
    minWorkers: 0,
    maxWorkers: 0,
    ...overrides,
  };
}

function findingFor(controlId: string, signals: Map<SignalId, SignalResult>) {
  const spec = catalogue.controls.find((control) => control.id === controlId);
  if (spec == null) throw new Error(`${controlId} is not in the catalogue`);
  return resolveControl(spec, signals, registry.get(controlId));
}

function signalsOf(entries: readonly [SignalId, unknown][]): Map<SignalId, SignalResult> {
  return new Map(entries.map(([id, value]) => [id, observed(id, value, 1, { mode: 'complete' })]));
}

describe('OE-02-03, Unity Catalog managed tables', () => {
  it('passes an estate whose storage is managed', () => {
    const finding = findingFor('OE-02-03', signalsOf([[CENSUS, census({ managedTables: 115, externalTables: 5 })]]));
    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('115 of 120');
  });

  it('excludes views from both halves of the share', () => {
    // A metastore of nothing but views has no storage to manage. Counting views in the
    // denominator would report a well-modelled semantic layer as having chosen external
    // storage for everything.
    const finding = findingFor(
      'OE-02-03',
      signalsOf([[CENSUS, census({ tableCount: 40, managedTables: 0, externalTables: 0, views: 40 })]])
    );
    expect(finding.outcome).toBe('not-applicable');
    expect(finding.outcomeReason).toContain('views');
  });

  it('says the external share is a question rather than a defect', () => {
    const finding = findingFor('OE-02-03', signalsOf([[CENSUS, census({ managedTables: 10, externalTables: 110 })]]));
    expect(finding.outcome).toBe('fail');
    expect(finding.outcomeReason).toContain('sometimes unavoidable');
  });
});

describe('OE-02-04, jobs that start themselves', () => {
  it('passes an estate whose jobs are all scheduled or triggered', () => {
    const finding = findingFor(
      'OE-02-04',
      signalsOf([[JOBS, [job(), job({ jobId: 'j-2', scheduled: false, continuous: true })]]])
    );
    expect(finding.outcome).toBe('pass');
  });

  it('counts a paused schedule as unautomated, and says why', () => {
    // A paused schedule fires nothing. Crediting it would pass an estate whose automation is
    // switched off, which is the state this control exists to find.
    const finding = findingFor('OE-02-04', signalsOf([[JOBS, [job({ paused: true }), job({ jobId: 'j-2' })]]]));
    expect(finding.outcome).not.toBe('pass');
    expect(finding.outcomeReason).toContain('paused schedule');
  });

  it('names the jobs a person has to start', () => {
    const finding = findingFor(
      'OE-02-04',
      signalsOf([[JOBS, [job(), job({ jobId: 'j-2', name: 'adhoc-backfill', scheduled: false })]]])
    );
    expect(finding.evidence.some((item) => (item.observed ?? '').includes('adhoc-backfill'))).toBe(true);
  });

  it('says the requirement does not apply to an estate with no jobs', () => {
    const finding = findingFor('OE-02-04', signalsOf([[JOBS, []]]));
    expect(finding.outcome).toBe('not-applicable');
    expect(finding.outcomeReason).toContain('interactive notebooks');
  });

  it('leaves jobs with an unreadable trigger out of the share rather than calling them manual', () => {
    /*
     * Definitions not edited since early December 2025 can carry a null trigger struct. Collapsing that
     * into scheduled: false failed long-standing jobs for a change in the system table.
     *
     * Nineteen scheduled jobs beside the one silent definition, rather than one beside one, and the count
     * is doing work: at one apiece the two readings of that definition score differently and the finding
     * says so instead (the case below). Here they agree, so leaving it out is the whole of the answer.
     */
    const finding = findingFor(
      'OE-02-04',
      signalsOf([
        [
          JOBS,
          [
            ...Array.from({ length: 19 }, (_, index) => job({ jobId: `j-${String(index)}` })),
            job({
              jobId: 'j-legacy',
              name: 'legacy-definition',
              scheduled: false,
              scheduledKnown: false,
              continuous: undefined,
              triggerType: undefined,
            }),
          ],
        ],
      ])
    );
    expect(finding.outcome).toBe('pass');
    expect(finding.evidence.map((item) => item.observed).join(' ')).toMatch(/left out of the share/);
    expect(finding.evidence.some((item) => (item.observed ?? '').includes('legacy-definition'))).toBe(false);
  });

  it('reports unmeasurable when every job has an unreadable trigger', () => {
    const finding = findingFor(
      'OE-02-04',
      signalsOf([
        [
          JOBS,
          [
            job({
              scheduled: false,
              scheduledKnown: false,
              continuous: undefined,
              triggerType: undefined,
            }),
          ],
        ],
      ])
    );
    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toMatch(/no trigger recorded against any of them/);
  });

  /*
   * The defect this pair exists for. `scheduledKnown` is `trigger IS NOT NULL`, and a job nobody
   * scheduled has no trigger struct either — so the flag is false for both a blank pre-rollout row and a
   * manually-started job, and dropping every false out of the denominator dropped the population the
   * control exists to find. Three scheduled jobs beside ninety-seven silent ones scored 100% automated.
   */
  it('does not score an estate whose silent definitions would change the answer', () => {
    const finding = findingFor(
      'OE-02-04',
      signalsOf([
        [
          JOBS,
          [
            ...Array.from({ length: 3 }, (_, index) => job({ jobId: `j-${String(index)}` })),
            ...Array.from({ length: 97 }, (_, index) =>
              job({
                jobId: `j-silent-${String(index)}`,
                scheduled: false,
                scheduledKnown: false,
                continuous: undefined,
                triggerType: undefined,
              })
            ),
          ],
        ],
      ])
    );

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toMatch(/does not settle this either way/);
  });

  /*
   * The same estate, once the rows are recent. The platform reference says the trigger columns are "not
   * populated for rows emitted before early December 2025", so a row written after that with no trigger
   * is a job with no trigger — which is a manual job, and scored as one.
   * https://docs.databricks.com/aws/en/admin/system-tables/jobs
   */
  it('counts a job as manual when its definition was written after the trigger columns were', () => {
    const finding = findingFor(
      'OE-02-04',
      signalsOf([
        [
          JOBS,
          [
            job({ jobId: 'j-scheduled' }),
            ...Array.from({ length: 9 }, (_, index) =>
              job({
                jobId: `j-manual-${String(index)}`,
                name: `manual-${String(index)}`,
                scheduled: false,
                scheduledKnown: false,
                continuous: undefined,
                triggerType: undefined,
                changeTime: new Date('2026-06-01T00:00:00.000Z'),
              })
            ),
          ],
        ],
      ])
    );

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence.some((item) => (item.observed ?? '').includes('manual-0'))).toBe(true);
  });
});

describe('OE-02-06 and OE-02-11, declarative pipelines', () => {
  it('passes when pipelines carry most of the orchestration', () => {
    const finding = findingFor(
      'OE-02-06',
      signalsOf([
        [PIPELINES, [pipeline(), pipeline({ pipelineId: 'p-2' }), pipeline({ pipelineId: 'p-3' })]],
        [JOBS, [job()]],
      ])
    );
    expect(finding.outcome).toBe('pass');
  });

  it('fails an estate orchestrating everything by hand, without calling it wrong', () => {
    const finding = findingFor('OE-02-11', signalsOf([[PIPELINES, []], [JOBS, [job(), job({ jobId: 'j-2' })]]]));
    expect(finding.outcome).toBe('fail');
    expect(finding.outcomeReason).toContain('not wrong for every workload');
  });

  it('says the ratio is biased against an estate that starts pipelines from jobs', () => {
    // A job whose only task is to start a pipeline lands on the job side of this share, and
    // the jobs inventory cannot say which jobs those are. Stated rather than corrected.
    const finding = findingFor('OE-02-06', signalsOf([[PIPELINES, [pipeline()]], [JOBS, [job()]]]));
    expect(finding.outcomeReason).toContain('does not record which jobs call a pipeline');
  });

  it('reports pipelines left in development mode', () => {
    const finding = findingFor(
      'OE-02-06',
      signalsOf([[PIPELINES, [pipeline({ development: true }), pipeline({ pipelineId: 'p-2' })]], [JOBS, []]])
    );
    expect(finding.outcomeReason).toContain('development mode');
    expect(finding.evidence.some((item) => (item.observed ?? '').includes('1 in production mode'))).toBe(true);
  });

  it('says the requirement does not apply with no orchestration at all', () => {
    expect(findingFor('OE-02-06', signalsOf([[PIPELINES, []], [JOBS, []]])).outcome).toBe('not-applicable');
  });
});

describe('OE-02-01 and IU-01-05, infrastructure as code', () => {
  it('caps at partial with bundles in use, because the rest cannot be told apart', () => {
    // The ceiling that matters. A bundle marker proves a deployment pipeline exists for the
    // jobs that carry it; it says nothing about the jobs that do not.
    const finding = findingFor(
      'OE-02-01',
      signalsOf([[JOBS, Array.from({ length: 10 }, (_, index) => job({ jobId: `j-${index}`, deploymentKind: 'BUNDLE' }))], [PIPELINES, []]])
    );
    expect(finding.outcome).toBe('partial');
    expect(finding.outcomeReason).toContain('Terraform-managed jobs carry no');
  });

  it('never fails an estate for the absence of a marker', () => {
    // The Terraform provider writes jobs through the same API a person uses and leaves no
    // trace of itself, so a fully Terraform-managed estate looks exactly like a hand-built
    // one here. Failing that would report the limits of the evidence as a defect.
    const finding = findingFor('OE-02-01', signalsOf([[JOBS, [job(), job({ jobId: 'j-2' })]], [PIPELINES, []]]));
    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toContain('Terraform provider');
    // And says so as a question for a person, not as a source the scan was denied. The job list
    // answered in full; there is no marker to read anywhere, so nothing a reader grants would
    // change this reading and the coverage summary must not offer them a grant to chase.
    expect(finding.unmeasured).toBe('attestation');
    expect(finding.remedy?.kind).toBe('attest');
  });

  it('reads the same way for its alias', () => {
    const finding = findingFor('IU-01-05', signalsOf([[JOBS, [job({ deploymentKind: 'BUNDLE' })]], [PIPELINES, []]]));
    expect(finding.outcome).toBe('partial');
  });
});

describe('OE-02-02 and IU-03-03, standardized compute', () => {
  function withClusters(controlId: string, clusters: readonly ClusterRow[]) {
    return findingFor(
      controlId,
      signalsOf([
        [CLUSTERS, clusters],
        [PROFILE, { distinctClusters: clusters.length, summary: clusters.length }],
      ])
    );
  }

  it('passes when all-purpose clusters come from a policy', () => {
    expect(withClusters('OE-02-02', [cluster(), cluster({ clusterId: 'c-2' })]).outcome).toBe('pass');
  });

  it('names the clusters configured freehand', () => {
    const finding = withClusters('OE-02-02', [cluster(), cluster({ clusterId: 'c-2', name: 'ad-hoc', hasPolicy: false })]);
    expect(finding.outcome).not.toBe('pass');
    expect(finding.evidence.some((item) => (item.observed ?? '').includes('ad-hoc'))).toBe(true);
  });

  it('is satisfied by architecture on an estate with no classic all-purpose compute', () => {
    // Serverless exposes no instance type, node count or runtime for a user to choose, which
    // is the decision a policy exists to settle. That is the requirement met, not skipped.
    const finding = withClusters('IU-03-03', [cluster({ source: 'JOB', hasPolicy: false })]);
    expect(finding.outcome).toBe('satisfied-by-architecture');
  });
});

describe('OE-01-06, a catalog strategy', () => {
  it('fails one catalog holding the whole estate', () => {
    const finding = findingFor('OE-01-06', signalsOf([[CENSUS, census({ catalogCount: 1 })]]));
    expect(finding.outcome).toBe('fail');
    expect(finding.outcomeReason).toContain('when no boundary was chosen');
  });

  it('caps at partial when the estate is spread, because the boundary is not readable', () => {
    const finding = findingFor('OE-01-06', signalsOf([[CENSUS, census({ catalogCount: 4 })]]));
    expect(finding.outcome).toBe('partial');
    expect(finding.outcomeReason).toContain('not readable from the metastore');
  });

  it('says one owner in the singular', () => {
    const finding = findingFor('OE-01-06', signalsOf([[CENSUS, census({ distinctOwners: 1 })]]));
    expect(finding.evidence[0]?.observed).toContain('1 distinct owner');
    expect(finding.evidence[0]?.observed).not.toContain('1 distinct owners');
  });

  it('says the requirement does not apply to a metastore corroborated as empty', () => {
    const finding = findingFor('OE-01-06', signalsOf([[CENSUS, census({ tableCount: 0 })], [LINEAGE, empty()]]));
    expect(finding.outcome).toBe('not-applicable');
  });

  it('declines to call the metastore empty when lineage recorded activity in it', () => {
    // E1d. A scan whose identity holds nothing on the customer's catalogs reads zero tables from
    // `system.information_schema`, which is filtered by the reader's privileges. Excluding the
    // requirement on that reading drops it out of the score on a claim the scan cannot make.
    const finding = findingFor('OE-01-06', signalsOf([[CENSUS, census({ tableCount: 0 })], [LINEAGE, busy()]]));
    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.unmeasured).toBe('unreadable');
    expect(finding.remedy?.says).toContain('BROWSE');
  });
});

describe('OE-04-01 and OE-04-02, monitoring', () => {
  it('passes when jobs declare health rules', () => {
    expect(findingFor('OE-04-01', signalsOf([[JOBS, [job(), job({ jobId: 'j-2' })]]])).outcome).toBe('pass');
  });

  it('reports unmeasured when every job definition predates the column', () => {
    // The same trap as the cluster init-script column: reading an unwritten column as zero
    // would fail a monitored estate for the age of its job definitions.
    const finding = findingFor('OE-04-01', signalsOf([[JOBS, [job({ healthRulesKnown: false, healthRuleCount: 0 })]]]));
    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toContain('older than');
    // Routed to a person rather than to a rerun. Waiting for the column to fill would only ever
    // answer half of it: alerting built on the audit logs leaves nothing in the workspace to read.
    expect(finding.unmeasured).toBe('attestation');
  });

  it('measures over the jobs that do record rules, and says how many that was', () => {
    const finding = findingFor(
      'OE-04-01',
      signalsOf([[JOBS, [job(), job({ jobId: 'j-2', healthRulesKnown: false, healthRuleCount: 0 })]]])
    );
    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('predate the column');
  });

  it('names the jobs nobody will be told about', () => {
    const finding = findingFor(
      'OE-04-02',
      signalsOf([[JOBS, [job({ name: 'silent-etl', healthRuleCount: 0 }), job({ jobId: 'j-2' })]]])
    );
    expect(finding.evidence.some((item) => (item.observed ?? '').includes('silent-etl'))).toBe(true);
  });

  it('says external tooling would look unmonitored here', () => {
    const finding = findingFor('OE-04-01', signalsOf([[JOBS, [job()]]]));
    expect(finding.outcomeReason).toContain('Datadog');
  });
});

describe('the pillar, as the catalogue now describes it', () => {
  it('measures the seven controls that have an artefact, and asks about the rest', () => {
    const measured = ['OE-01-06', 'OE-02-01', 'OE-02-02', 'OE-02-03', 'OE-02-04', 'OE-02-06', 'OE-02-11', 'OE-04-01', 'OE-04-02'];
    for (const id of measured) {
      expect(registry.get(id), `${id} needs a resolver or it goes back on the attestation page`).toBeDefined();
      expect(catalogue.controls.find((control) => control.id === id)?.measurability).not.toBe('attestation');
    }
  });

  it('reports unmeasured rather than a verdict when a signal is refused', () => {
    for (const id of ['OE-02-03', 'OE-01-06']) {
      const finding = findingFor(id, new Map([[CENSUS, unmeasurable(CENSUS, 'query refused')]]));
      expect(finding.outcome).toBe('unmeasurable');
      // A refused query is the other kind entirely: the app asked and was told no, so it reads as
      // a source the scan could not read and the reader is offered something to do about it.
      expect(finding.unmeasured).toBe('unreadable');
    }
  });
});

const CAPACITY = 'sql:query.capacity' as SignalId;
const SERVING_ENTITIES = 'sql:serving.model_entities' as SignalId;
const RUN_TRACKING = 'sql:mlflow.run_tracking' as SignalId;

function capacity(overrides: Partial<QueryCapacity> = {}): QueryCapacity {
  return {
    totalStatements: 100_000,
    waitingAtCapacity: 0,
    totalWaitMs: 0,
    ...overrides,
  };
}

function runTracking(overrides: Partial<MlflowRunTracking> = {}): MlflowRunTracking {
  return {
    runs: 500,
    experimentsWithRuns: 20,
    runsFromAJob: 300,
    experimentsWithAJobRun: 15,
    runsFromANotebook: 150,
    runsFromElsewhere: 30,
    runsFromAProject: 10,
    runsWithoutASource: 10,
    runsThatFinished: 480,
    experiments: 30,
    liveExperiments: 25,
    ...overrides,
  };
}

function servingEntity(overrides: Partial<ServingModelEntity> = {}): ServingModelEntity {
  return {
    workspaceId: '1',
    servedEntityId: 'se-1',
    endpointId: 'ep-1',
    endpointName: 'fraud-scoring',
    servedEntityName: 'fraud-scoring-v1',
    entityType: 'CUSTOM_MODEL',
    entityName: 'prod.models.fraud_scoring',
    entityVersion: '7',
    requests: 10_000,
    daysWithTraffic: 5,
    failedRequests: 12,
    requestsWithoutStatus: 0,
    liveEntities: 1,
    liveEndpoints: 1,
    customModels: 1,
    foundationModels: 0,
    externalModels: 0,
    featureSpecs: 0,
    customModelsWithAVersion: 1,
    customModelsNamedInUc: 1,
    ...overrides,
  };
}

describe('OE-03-01, service limits and quotas', () => {
  it('reports partial when no statements waited at capacity — limits not biting does not confirm monitoring', () => {
    const finding = findingFor('OE-03-01', signalsOf([[CAPACITY, capacity()]]));
    expect(finding.outcome).toBe('partial');
    // The partial reason distinguishes "no events" from "events but not many"
    expect(finding.outcomeReason).toContain('proactive monitoring');
  });

  it('reports fail when a significant share of statements hit a capacity limit', () => {
    // 5% of statements waiting is above the 1% threshold and should fail
    const finding = findingFor(
      'OE-03-01',
      signalsOf([[CAPACITY, capacity({ totalStatements: 10_000, waitingAtCapacity: 500 })]])
    );
    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.observed).toContain('500');
    expect(finding.evidence[0]?.observed).toContain('10,000');
  });

  it('reports partial when a small share of statements hit capacity — minor pressure, not a clear failure', () => {
    // 0.5% waiting is below the 1% threshold: biting, but not a fail
    const finding = findingFor(
      'OE-03-01',
      signalsOf([[CAPACITY, capacity({ totalStatements: 10_000, waitingAtCapacity: 50 })]])
    );
    expect(finding.outcome).toBe('partial');
    expect(finding.evidence[0]?.observed).toContain('50');
  });

  it('reports not-applicable when there is no query history to read', () => {
    const finding = findingFor('OE-03-01', signalsOf([[CAPACITY, capacity({ totalStatements: 0 })]]));
    expect(finding.outcome).toBe('not-applicable');
  });

  it('reports unmeasurable when the signal itself could not be read', () => {
    const finding = findingFor('OE-03-01', signalsOf([]));
    expect(finding.outcome).toBe('unmeasurable');
  });

  it('names the count in the evidence so an admin can act on it', () => {
    const finding = findingFor(
      'OE-03-01',
      signalsOf([[CAPACITY, capacity({ totalStatements: 50_000, waitingAtCapacity: 1_000 })]])
    );
    // 2% exceeds the 1% threshold → fail
    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.observed).toContain('1,000');
  });
});

describe('OE-01-04, standardized MLOps processes', () => {
  it('reports partial when both custom models and job-sourced runs are present', () => {
    const finding = findingFor(
      'OE-01-04',
      signalsOf([
        [SERVING_ENTITIES, [servingEntity()]],
        [RUN_TRACKING, runTracking()],
      ])
    );
    expect(finding.outcome).toBe('partial');
    // Evidence names both signals
    const observed = finding.evidence.map((e) => e.observed ?? '').join(' ');
    expect(observed).toContain('custom model');
    expect(observed).toContain('MLflow run');
  });

  it('reports partial when custom models exist but no job-sourced runs — models served but training not automated', () => {
    const finding = findingFor(
      'OE-01-04',
      signalsOf([
        [SERVING_ENTITIES, [servingEntity()]],
        [RUN_TRACKING, runTracking({ runs: 0, runsFromAJob: 0, runsWithoutASource: 0 })],
      ])
    );
    expect(finding.outcome).toBe('partial');
  });

  it('reports partial when job-sourced runs exist but no custom models — training tracked but no managed serving', () => {
    const totals = servingEntity({ liveEntities: 0, customModels: 0 });
    const finding = findingFor(
      'OE-01-04',
      signalsOf([
        [SERVING_ENTITIES, [totals]],
        [RUN_TRACKING, runTracking()],
      ])
    );
    expect(finding.outcome).toBe('partial');
  });

  it('reports unmeasurable when neither signal has activity — no ML workload visible', () => {
    const empty = servingEntity({ liveEntities: 0, customModels: 0 });
    const finding = findingFor(
      'OE-01-04',
      signalsOf([
        [SERVING_ENTITIES, [empty]],
        [RUN_TRACKING, runTracking({ runs: 0, runsFromAJob: 0, runsWithoutASource: 0 })],
      ])
    );
    expect(finding.outcome).toBe('unmeasurable');
    // The unmeasured kind is unreadable (not attestation): the estate may have ML outside the platform
    expect(finding.unmeasured).toBe('unreadable');
  });

  it('caps at partial even when both signals are strong — process standardization is beyond telemetry', () => {
    // A very active ML estate: many models, many automated runs. Still partial.
    const bigEstate = servingEntity({
      liveEntities: 100,
      customModels: 80,
      customModelsWithAVersion: 80,
    });
    const finding = findingFor(
      'OE-01-04',
      signalsOf([
        [SERVING_ENTITIES, [bigEstate]],
        [RUN_TRACKING, runTracking({ runs: 10_000, runsFromAJob: 9_500 })],
      ])
    );
    expect(finding.outcome).toBe('partial');
    expect(finding.outcomeReason).toContain('standardized');
  });

  it('reports unmeasurable when the serving signal is refused', () => {
    const finding = findingFor(
      'OE-01-04',
      new Map([
        [SERVING_ENTITIES, unmeasurable(SERVING_ENTITIES, 'query refused')],
        [RUN_TRACKING, observed(RUN_TRACKING, runTracking(), 1, { mode: 'complete' })],
      ])
    );
    expect(finding.outcome).toBe('unmeasurable');
  });
});
