// A requirement with a measured half and an unmeasured half, and what an answer may do to it.
//
// Five measured units stop at `partial` on purpose: the platform shows that the practice has an
// artefact, and cannot show that the artefact is the whole practice. Before this rule the only way
// an answer reached those units was by the app having nothing to measure, so an estate with no
// adoption at all could score `pass` on a "met" while one with every job deployed from a bundle
// stayed at `partial` on the same answer. Adoption lowered the score. These tests defend the
// reverse: decision D2 in docs/decisions.md.
//
// The rule has three edges and each is a test below. A current or due "met" lifts a capped
// `partial` to `pass`. Nothing lifts a `fail` or a shortfall the app measured, because a lift past
// a measured gap would let any finding be answered away. And no answer lowers a measurement.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../catalogue/catalogue.js';
import { DAY_MS, type Attestation, type AttestedAnswer } from '../attest/attestation.js';
import { observed, type SignalId, type SignalResult } from '../collect/signal.js';
import type {
  AssetCensus,
  JobRow,
  MlflowRunTracking,
  PlatformCensus,
  QueryCapacity,
  ServingModelEntity,
} from '../collect/sql/shapes.js';
import type { Finding, Outcome } from './finding.js';
import { resolveControl } from './resolver.js';
import { buildRegistry } from './resolvers/index.js';

const CENSUS = 'sql:uc.census' as SignalId;
const PLATFORM = 'sql:uc.platform_census' as SignalId;
const JOBS = 'sql:jobs.inventory' as SignalId;
const PIPELINES = 'sql:pipelines.inventory' as SignalId;
const CAPACITY = 'sql:query.capacity' as SignalId;
const SERVING_ENTITIES = 'sql:serving.model_entities' as SignalId;
const RUN_TRACKING = 'sql:mlflow.run_tracking' as SignalId;

const catalogue = loadCatalogue();
const registry = buildRegistry();
const NOW = new Date();

type Signals = ReadonlyMap<SignalId, SignalResult>;

function signalsOf(entries: readonly [SignalId, unknown][]): Signals {
  return new Map(entries.map(([id, value]) => [id, observed(id, value, 1, { mode: 'complete' })]));
}

function answer(controlId: string, given: AttestedAnswer, overrides: Partial<Attestation> = {}): Attestation {
  return {
    id: `answer-${controlId}-${given}`,
    controlId,
    answer: given,
    statement: 'Every deployment goes through the platform team’s pipeline and is reviewed first.',
    owner: 'platform-team@example.com',
    attestedBy: 'admin@example.com',
    attestedAt: new Date(NOW.getTime() - 5 * DAY_MS),
    reviewBy: new Date(NOW.getTime() + 180 * DAY_MS),
    ...overrides,
  };
}

/** What an answer to a control is, or no answer at all. */
type Given = AttestedAnswer | 'none';
const GIVEN: readonly Given[] = ['met', 'partially-met', 'not-met', 'none'];

function resolved(controlId: string, signals: Signals, given: Given, overrides: Partial<Attestation> = {}): Finding {
  const spec = catalogue.controls.find((control) => control.id === controlId);
  if (spec == null) throw new Error(`${controlId} is not in the catalogue`);
  return resolveControl(
    spec,
    signals,
    registry.get(controlId),
    given === 'none' ? undefined : answer(controlId, given, overrides)
  );
}

/**
 * How much of a requirement an outcome earns, for the monotonicity property.
 *
 * `unmeasurable` ranks with `fail` rather than above it: it earns nothing and widens the score's
 * range downwards, so a step from unmeasurable to anything measured is never a step down.
 */
const RANK: Readonly<Partial<Record<Outcome, number>>> = { unmeasurable: 0, fail: 0, partial: 1, pass: 2 };

function job(index: number, overrides: Partial<JobRow> = {}): JobRow {
  return {
    workspaceId: '1',
    jobId: `j-${index}`,
    name: `job-${index}`,
    scheduled: true,
    scheduledKnown: true,
    healthRuleCount: 1,
    healthRulesKnown: true,
    hasStreamBacklogRule: false,
    tagCount: 1,
    ...overrides,
  };
}

function jobs(total: number, bundled: number): JobRow[] {
  return Array.from({ length: total }, (_, index) => job(index, index < bundled ? { deploymentKind: 'BUNDLE' } : {}));
}

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

function platform(overrides: Partial<PlatformCensus> = {}): PlatformCensus {
  return {
    shares: 0,
    recipients: 0,
    tokenRecipients: 0,
    recipientsWithIpAllowlist: 0,
    providers: 0,
    connections: 0,
    connectionTypes: '',
    externalLocations: 2,
    storageCredentials: 1,
    volumes: 3,
    managedVolumes: 3,
    routines: 4,
    columnMasks: 0,
    rowFilters: 0,
    taggedTables: 0,
    taggedColumns: 0,
    ownsMetastore: true,
    sharingPrivileges: [],
    ...overrides,
  };
}

function capacity(waiting: number, total = 10_000): QueryCapacity {
  return { totalStatements: total, waitingAtCapacity: waiting, totalWaitMs: waiting * 1_000 };
}

function entity(overrides: Partial<ServingModelEntity> = {}): ServingModelEntity {
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

function runs(overrides: Partial<MlflowRunTracking> = {}): MlflowRunTracking {
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

/** One rung of a unit's adoption ladder: a name, the readings, and what each answer should leave it as. */
interface Rung {
  readonly name: string;
  readonly signals: Signals;
}

interface Unit {
  /** Every control the unit's resolver answers, because an alias must read the same as its sibling. */
  readonly controls: readonly string[];
  /** Least measured adoption first. */
  readonly ladder: readonly Rung[];
  /** The index of the one rung where the measurement stops at a cap, and "met" can lift it. */
  readonly capped: readonly number[];
}

const UNITS: Readonly<Record<string, Unit>> = {
  'bundles (OE-01-02, OE-02-01, IU-01-05)': {
    controls: ['OE-01-02', 'OE-02-01', 'IU-01-05'],
    ladder: [
      {
        name: 'no job carries a marker',
        signals: signalsOf([
          [JOBS, jobs(10, 0)],
          [PIPELINES, []],
        ]),
      },
      {
        name: '1 of 10 jobs bundle-deployed',
        signals: signalsOf([
          [JOBS, jobs(10, 1)],
          [PIPELINES, []],
        ]),
      },
      {
        name: '10 of 10 jobs bundle-deployed',
        signals: signalsOf([
          [JOBS, jobs(10, 10)],
          [PIPELINES, []],
        ]),
      },
    ],
    capped: [1, 2],
  },
  'MLOps (OE-01-04)': {
    controls: ['OE-01-04'],
    ladder: [
      {
        name: 'no ML tooling visible',
        signals: signalsOf([
          [
            SERVING_ENTITIES,
            [entity({ liveEntities: 0, customModels: 0, customModelsWithAVersion: 0, customModelsNamedInUc: 0 })],
          ],
          [RUN_TRACKING, runs({ runs: 0, runsFromAJob: 0, runsWithoutASource: 0 })],
        ]),
      },
      {
        name: 'models served and every run started by a job',
        signals: signalsOf([
          [SERVING_ENTITIES, [entity()]],
          [RUN_TRACKING, runs({ runsFromAJob: 490, runsWithoutASource: 10 })],
        ]),
      },
    ],
    capped: [1],
  },
  'catalog strategy (OE-01-06)': {
    controls: ['OE-01-06'],
    ladder: [
      { name: 'one catalog holds every table', signals: signalsOf([[CENSUS, census({ catalogCount: 1 })]]) },
      { name: 'four catalogs', signals: signalsOf([[CENSUS, census({ catalogCount: 4 })]]) },
    ],
    capped: [1],
  },
  'data products (IU-04-01, IU-04-02)': {
    controls: ['IU-04-01', 'IU-04-02'],
    ladder: [
      {
        name: 'no tags and under 80% described',
        signals: signalsOf([
          [CENSUS, census({ describedTables: 10 })],
          [PLATFORM, platform({ taggedTables: 0 })],
        ]),
      },
      {
        name: 'no tags and 80% described',
        signals: signalsOf([
          [CENSUS, census({ describedTables: 100 })],
          [PLATFORM, platform({ taggedTables: 0 })],
        ]),
      },
      {
        name: 'tagged tables',
        signals: signalsOf([
          [CENSUS, census({ describedTables: 100 })],
          [PLATFORM, platform({ taggedTables: 40 })],
        ]),
      },
    ],
    capped: [2],
  },
  'service limits (OE-03-01)': {
    controls: ['OE-03-01'],
    ladder: [
      { name: '5% of statements waited', signals: signalsOf([[CAPACITY, capacity(500)]]) },
      { name: '0.5% of statements waited', signals: signalsOf([[CAPACITY, capacity(50)]]) },
      { name: 'no statement waited', signals: signalsOf([[CAPACITY, capacity(0)]]) },
    ],
    capped: [2],
  },
};

describe.each(Object.entries(UNITS))('%s', (_name, unit) => {
  describe.each(unit.controls)('%s', (controlId) => {
    it('lifts a capped partial to pass on a current "met", and says the answer decided it with the measurement', () => {
      for (const rung of unit.capped) {
        const signals = unit.ladder[rung].signals;
        const measured = resolved(controlId, signals, 'none');
        const lifted = resolved(controlId, signals, 'met');

        expect(measured.outcome, unit.ladder[rung].name).toBe('partial');
        expect(lifted.outcome, unit.ladder[rung].name).toBe('pass');
        expect(lifted.attested?.bearing).toBe('co-signed');
        // The measurement stays on the finding, because the lift does not replace it.
        expect(lifted.evidence).toEqual(measured.evidence);
        expect(lifted.capped).toBe(true);
      }
    });

    it('lifts on an answer that is due for renewal, as the score counts it', () => {
      const rung = unit.capped[0];
      const due = resolved(controlId, unit.ladder[rung].signals, 'met', {
        attestedAt: new Date(NOW.getTime() - 340 * DAY_MS),
        reviewBy: new Date(NOW.getTime() + 10 * DAY_MS),
      });
      expect(due.outcome).toBe('pass');
      expect(due.attested?.bearing).toBe('co-signed');
    });

    it('does not lift on an answer that has expired', () => {
      const rung = unit.capped[0];
      const expired = resolved(controlId, unit.ladder[rung].signals, 'met', {
        attestedAt: new Date(NOW.getTime() - 400 * DAY_MS),
        reviewBy: new Date(NOW.getTime() - 1 * DAY_MS),
      });
      expect(expired.outcome).toBe('partial');
      expect(expired.attested?.bearing).toBe('record');
    });

    it('never lowers a measurement, whatever the answer says', () => {
      for (const rung of unit.ladder) {
        const measured = resolved(controlId, rung.signals, 'none');
        if (measured.outcome === 'unmeasurable') continue;
        for (const given of ['partially-met', 'not-met'] as const) {
          const finding = resolved(controlId, rung.signals, given);
          expect(finding.outcome, `${rung.name} answered ${given}`).toBe(measured.outcome);
          // Recorded, and not counted.
          expect(finding.attested?.bearing).toBe('record');
        }
      }
    });

    it('never lifts a fail or a shortfall the app measured', () => {
      unit.ladder.forEach((rung, index) => {
        if (unit.capped.includes(index)) return;
        const measured = resolved(controlId, rung.signals, 'none');
        if (measured.outcome === 'unmeasurable') return;
        const finding = resolved(controlId, rung.signals, 'met');
        expect(finding.outcome, rung.name).toBe(measured.outcome);
        expect(finding.attested?.bearing, rung.name).toBe('record');
        expect(finding.capped, rung.name).toBeUndefined();
      });
    });

    it.each(GIVEN)('never scores a higher measured adoption lower, with the answer %s', (given) => {
      const ranks = unit.ladder.map((rung) => {
        const outcome = resolved(controlId, rung.signals, given).outcome;
        return { name: rung.name, outcome, rank: RANK[outcome] ?? 0 };
      });
      for (let index = 1; index < ranks.length; index += 1) {
        const lower = ranks[index - 1];
        const higher = ranks[index];
        expect(
          higher.rank,
          `"${higher.name}" scored ${higher.outcome} and "${lower.name}" scored ${lower.outcome}, with the answer ${given}`
        ).toBeGreaterThanOrEqual(lower.rank);
      }
    });
  });
});

describe('what was inverted before the rule', () => {
  it('no bundle-deployed jobs and "met" no longer outscores every job bundle-deployed and "met"', () => {
    const none = resolved('OE-02-01', UNITS['bundles (OE-01-02, OE-02-01, IU-01-05)'].ladder[0].signals, 'met');
    const all = resolved('OE-02-01', UNITS['bundles (OE-01-02, OE-02-01, IU-01-05)'].ladder[2].signals, 'met');
    expect(none.outcome).toBe('pass');
    expect(all.outcome).toBe('pass');
  });

  it('no ML tooling and "met" still passes, and fully automated training and "met" now passes too', () => {
    // The no-adoption branch keeps letting an answer decide. What changed is that the adopted branch
    // no longer scores below it: both read pass on the same answer, where one used to read partial.
    const { ladder } = UNITS['MLOps (OE-01-04)'];
    expect(resolved('OE-01-04', ladder[0].signals, 'met').outcome).toBe('pass');
    expect(resolved('OE-01-04', ladder[1].signals, 'met').outcome).toBe('pass');
  });

  it('a pass reached on an answer says it rests on one, so the score reports it as stated', () => {
    const { ladder } = UNITS['catalog strategy (OE-01-06)'];
    const finding = resolved('OE-01-06', ladder[1].signals, 'met');
    expect(finding.outcome).toBe('pass');
    expect(finding.attested?.statement).toContain('platform team');
  });
});

describe('OE-03-01 at the edges of its band', () => {
  it('fails when more than 1% of statements waited at a capacity limit', () => {
    const finding = resolved('OE-03-01', signalsOf([[CAPACITY, capacity(101)]]), 'none');
    expect(finding.outcome).toBe('fail');
  });

  it('stays partial at exactly 1%', () => {
    const finding = resolved('OE-03-01', signalsOf([[CAPACITY, capacity(100)]]), 'none');
    expect(finding.outcome).toBe('partial');
    expect(finding.capped).toBeUndefined();
  });

  it('is lifted by "met" at 0% and not at 1%', () => {
    expect(resolved('OE-03-01', signalsOf([[CAPACITY, capacity(0)]]), 'met').outcome).toBe('pass');
    expect(resolved('OE-03-01', signalsOf([[CAPACITY, capacity(100)]]), 'met').outcome).toBe('partial');
    expect(resolved('OE-03-01', signalsOf([[CAPACITY, capacity(101)]]), 'met').outcome).toBe('fail');
  });
});

describe('IU-04-01 where the cap does not apply', () => {
  it('keeps no tags and 80% described at partial, which "met" does not lift', () => {
    const signals = signalsOf([
      [CENSUS, census({ describedTables: 100 })],
      [PLATFORM, platform({ taggedTables: 0 })],
    ]);
    expect(resolved('IU-04-01', signals, 'none').outcome).toBe('partial');
    expect(resolved('IU-04-01', signals, 'met').outcome).toBe('partial');
  });
});

describe('bundles, where every job carries the marker', () => {
  it('does not say jobs remain when none do', () => {
    const { ladder } = UNITS['bundles (OE-01-02, OE-02-01, IU-01-05)'];
    const finding = resolved('OE-02-01', ladder[2].signals, 'none');
    expect(finding.outcomeReason).not.toMatch(/remaining jobs|unmarked ones/i);
  });

  it('still says which jobs cannot be told apart when some are unmarked', () => {
    const { ladder } = UNITS['bundles (OE-01-02, OE-02-01, IU-01-05)'];
    const finding = resolved('OE-02-01', ladder[1].signals, 'none');
    expect(finding.outcomeReason).toContain('Terraform-managed');
  });
});
