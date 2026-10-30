import { describe, expect, it } from 'vitest';

import type { AcceptedRisk } from '../accept/risk.js';
import type { ImprovementAction } from '../improve/action.js';
import type { Run } from '../run/run.js';
import type { OutcomeCounts, ScanSummary } from '../scan/store.js';
import type { ScanStamp } from '../scan/scan.js';
import {
  closingScan,
  monthContent,
  openingReading,
  type MonthPoint,
  type MonthSources,
  type MonthWindow,
} from './content.js';
import { parseMonth, type MonthId } from './publication.js';

function month(value: string): MonthId {
  const parsed = parseMonth(value);
  if (parsed === undefined) throw new Error(`test wrote a bad month: ${value}`);
  return parsed;
}

/** August 2026, in UTC: the half-open span every "in the month" test is made against. */
const WINDOW: MonthWindow = {
  start: new Date('2026-08-01T00:00:00Z'),
  end: new Date('2026-09-01T00:00:00Z'),
};

function counts(over: Partial<OutcomeCounts> = {}): OutcomeCounts {
  return { pass: 0, fail: 0, partial: 0, unmeasurable: 0, notApplicable: 0, ...over };
}

function scan(over: Partial<ScanSummary> = {}): ScanSummary {
  return {
    id: 'scan',
    startedAt: new Date('2026-08-10T09:00:00Z'),
    finishedAt: new Date('2026-08-10T10:00:00Z'),
    state: 'complete',
    actor: 'analyst@example.com',
    executionMode: 'on-behalf-of-user',
    catalogueVersion: 'v1',
    measuredPillars: ['reliability'],
    freshPillars: ['reliability'],
    counts: counts(),
    pillarScores: {},
    ...over,
  };
}

function run(over: Partial<Run> = {}): Run {
  return {
    id: 'run',
    kind: 'assessment',
    requestedAt: new Date('2026-08-03T08:00:00Z'),
    actor: 'analyst@example.com',
    trigger: 'scheduled',
    request: { scope: { description: 'the account' }, lookbackDays: 30 },
    state: 'complete',
    attempts: 1,
    ...over,
  };
}

function risk(over: Partial<AcceptedRisk> = {}): AcceptedRisk {
  return {
    id: 'risk',
    controlId: 'C1',
    ordinal: 1,
    reason: 'a reason long enough to keep',
    compensatingControl: 'a compensating control kept',
    residual: 'low',
    owner: 'owner@example.com',
    effectiveFrom: new Date('2026-07-01T00:00:00Z'),
    expiresAt: new Date('2026-10-01T00:00:00Z'),
    recordedBy: 'owner@example.com',
    recordedAt: new Date('2026-07-01T00:00:00Z'),
    ...over,
  };
}

function action(over: Partial<ImprovementAction> = {}): ImprovementAction {
  return {
    id: 'action',
    planId: 'plan',
    controlIds: ['C1'],
    outcome: 'the estate improves',
    definitionOfDone: 'the run agrees it is met',
    owner: 'owner@example.com',
    priority: 'now',
    effort: 'small',
    steps: [],
    dependsOn: [],
    state: 'planned',
    createdBy: 'owner@example.com',
    createdAt: new Date('2026-08-05T00:00:00Z'),
    history: [],
    revision: 0,
    ...over,
  };
}

const label = (id: string): { requirement: string; pillar: string } | undefined =>
  id === 'C1' ? { requirement: 'Encrypt data at rest', pillar: 'Security' } : undefined;

function identity(over: { build?: { id: string } } = {}): NonNullable<ScanStamp['identity']> {
  return {
    build: { id: '0.1.0+aaaaaaaaaaaa' },
    methodology: { id: 'sha256:method' },
    record: { id: 'codec-2' },
    sources: ['sql'],
    ...over,
  };
}

/** A scan stamp, the fields `comparable` reads. The default is one basis; a case varies one axis. */
function stamp(over: Partial<ScanStamp> = {}): ScanStamp {
  return {
    publicMethodology: { publicVersion: 1, manifestDigest: 'sha256:manifest', state: 'released' },
    catalogueVersion: 'v1',
    catalogueFingerprint: 'sha256:catalogue',
    executionMode: 'on-behalf-of-user',
    actor: 'analyst@example.com',
    scope: { description: 'the account' },
    lookbackDays: 30,
    identity: identity(),
    ...over,
  };
}

/**
 * A prior published month: the score its own document carries, and the basis its closing scan recorded.
 *
 * The default is a month whose closing scan is still readable on the default basis; a case varies the
 * stamp it was measured on, or replaces the point entirely where it is about a scan that cannot be read.
 */
function point(value: string, score?: number, on: ScanStamp = stamp()): MonthPoint {
  return { month: month(value), ...(score != null ? { score: String(score) } : {}), stamp: on, closingScan: 'read' };
}

/**
 * August's sources with a prior published series and a closing scan on the default basis, so a case
 * varies only the series points it is about.
 */
function withSeries(series: readonly MonthPoint[]): MonthSources {
  return {
    month: month('2026-08'),
    window: WINDOW,
    runs: [],
    scans: [scan({ id: 'closing', finishedAt: new Date('2026-08-25T10:00:00Z'), overall: 80, stamp: stamp() })],
    risks: [],
    actions: [],
    label,
    series,
  };
}

describe('monthContent', () => {
  it('assembles every section from a full month', () => {
    const prior = scan({
      id: 'prior',
      finishedAt: new Date('2026-07-31T12:00:00Z'),
      overall: 50,
      counts: counts({ pass: 5, fail: 5, unmeasurable: 2, notApplicable: 1 }),
      measuredPillars: ['a', 'b'],
      outcomes: { C1: 'pass', C2: 'pass', C3: 'fail' },
      // Both readings carry the basis they were measured on: a movement is published only between two
      // that `comparable` admits, and a reading with no stamp cannot be shown to be one.
      stamp: stamp(),
    });
    const closing = scan({
      id: 'closing',
      finishedAt: new Date('2026-08-25T10:00:00Z'),
      overall: 60,
      counts: counts({ pass: 8, fail: 2, partial: 1, notApplicable: 1 }),
      measuredPillars: ['a', 'b', 'c'],
      outcomes: { C1: 'fail', C2: 'pass', C4: 'pass' },
      stamp: stamp(),
    });
    const earlier = scan({ id: 'earlier', finishedAt: new Date('2026-08-10T10:00:00Z') });

    const sources: MonthSources = {
      month: month('2026-08'),
      window: WINDOW,
      runs: [
        run({ id: 'r1', state: 'complete', requestedAt: new Date('2026-08-03T08:00:00Z') }),
        run({ id: 'r2', state: 'failed', requestedAt: new Date('2026-08-10T08:00:00Z') }),
        run({ id: 'r3', state: 'complete', requestedAt: new Date('2026-07-20T08:00:00Z') }),
        run({ id: 'r4', kind: 'advisory', requestedAt: new Date('2026-08-05T08:00:00Z') }),
      ],
      // Deliberately unordered, so the closing-scan pick is by time and not by position.
      scans: [closing, earlier],
      priorScan: prior,
      risks: [
        risk({ id: 'r-c1-new', controlId: 'C1', recordedAt: new Date('2026-07-15T00:00:00Z') }),
        risk({
          id: 'r-c1-old',
          controlId: 'C1',
          recordedAt: new Date('2026-06-01T00:00:00Z'),
          expiresAt: new Date('2026-06-30T00:00:00Z'),
        }),
        risk({
          id: 'r-c2-expired',
          controlId: 'C2',
          expiresAt: new Date('2026-08-15T00:00:00Z'),
        }),
      ],
      actions: [
        action({ id: 'a-raised', createdAt: new Date('2026-08-05T00:00:00Z'), history: [] }),
        action({ id: 'a-old', createdAt: new Date('2026-07-01T00:00:00Z'), history: [] }),
        action({
          id: 'a-verified',
          createdAt: new Date('2026-07-15T00:00:00Z'),
          state: 'verified',
          history: [
            {
              from: 'ready-for-validation',
              to: 'verified',
              at: new Date('2026-08-20T00:00:00Z'),
              by: 'run',
              who: 'scan',
            },
          ],
        }),
        action({
          id: 'a-cancelled',
          createdAt: new Date('2026-07-16T00:00:00Z'),
          state: 'cancelled',
          history: [
            {
              from: 'planned',
              to: 'cancelled',
              at: new Date('2026-08-22T00:00:00Z'),
              by: 'person',
              who: 'owner@example.com',
              reason: 'answered another way',
            },
          ],
        }),
      ],
      label,
    };

    const content = monthContent(sources);

    expect(content.runHealth).toEqual([
      { label: 'Assessment runs', value: '2' },
      { label: 'Completed', value: '1' },
      { label: 'Partial', value: '0' },
      { label: 'Failed', value: '1' },
      { label: 'Cancelled', value: '0' },
      { label: 'Unfinished', value: '0' },
    ]);

    expect(content.movement).toEqual([
      { label: 'Overall score', from: '50', to: '60' },
      { label: 'Requirements answered', from: '10 of 13', to: '11 of 12' },
      { label: 'Pillars measured', from: '2', to: '3' },
    ]);

    // Only C1 changed across both readings; C2 held, C3 was dropped, C4 is new — none is a delta.
    expect(content.findingDeltas).toEqual([
      { control: 'C1', requirement: 'Encrypt data at rest', pillar: 'Security', from: 'pass', to: 'fail' },
    ]);

    expect(content.exceptions).toEqual([
      {
        control: 'C1',
        requirement: 'Encrypt data at rest',
        owner: 'owner@example.com',
        residual: 'low',
        until: '2026-10-01',
      },
    ]);

    expect(content.outcomes).toEqual([
      { label: 'Met', value: '8' },
      { label: 'Failing', value: '2' },
      { label: 'Partial', value: '1' },
      { label: 'Not applicable', value: '1' },
      { label: 'Unmeasured', value: '0' },
    ]);

    expect(content.actions).toEqual([
      { label: 'Actions raised', value: '1' },
      { label: 'Actions verified', value: '1' },
      { label: 'Actions cancelled', value: '1' },
    ]);

    // No prior published series, so the month is the only point, on a basis the rule admits.
    expect(content.trend).toEqual([
      { month: month('2026-08'), label: 'August 2026', score: '60', comparability: 'permitted' },
    ]);
    expect(content.movementNote).toBeUndefined();
  });

  it('records what the review of the closing run was made of, naming the skipped pillars in words', () => {
    const sources: MonthSources = {
      month: month('2026-08'),
      window: WINDOW,
      runs: [],
      scans: [
        scan({
          id: 'closing',
          finishedAt: new Date('2026-08-25T10:00:00Z'),
          stamp: stamp({
            definition: {
              id: 'customer-assessment',
              version: 3,
              fingerprint: 'sha256:customer-assessment-v3',
            },
          }),
        }),
      ],
      risks: [],
      actions: [],
      label,
      // The ids the review records carry, which are what `finalisationOf` puts in `skipped`. The
      // document displays every string it holds, so an id reaching this section is a permanent record
      // reading `cost-optimization — nobody confirmed…`.
      pillarTitle: (id) => ({ 'cost-optimization': 'Cost optimisation' })[id],
      finalisation: {
        reviewId: 'review-closing',
        resultId: 'result-closing',
        finalised: true,
        finalisedBy: 'ana@example.com',
        finalisedAt: new Date('2026-08-26T09:00:00Z'),
        recorded: 3,
        expected: 3,
        refreshed: 0,
        confirmed: 2,
        skipped: ['cost-optimization'],
        cited: 41,
      },
    };

    const content = monthContent(sources);
    expect(content.assessment).toEqual({
      runId: 'closing',
      reviewId: 'review-closing',
      finalResultId: 'result-closing',
      definition: {
        id: 'customer-assessment',
        version: 3,
        fingerprint: 'sha256:customer-assessment-v3',
      },
    });
    expect(content.review).toEqual([
      { label: 'Review', value: 'Finalised by ana@example.com' },
      { label: 'Pillars confirmed', value: '2 of 3' },
      {
        label: 'Pillars skipped',
        value: 'Cost optimisation — nobody confirmed its answers in this review',
      },
      { label: 'Answers cited', value: '41, which the run already held' },
    ]);
  });

  it('does not invent a month assessment identity before the review has a final result', () => {
    const sources: MonthSources = {
      month: month('2026-08'),
      window: WINDOW,
      runs: [],
      scans: [scan({ id: 'closing' })],
      risks: [],
      actions: [],
      label,
      finalisation: {
        reviewId: 'open-review',
        finalised: false,
        recorded: 6,
        expected: 7,
        refreshed: 0,
        confirmed: 6,
        skipped: [],
        cited: 0,
      },
    };

    expect(monthContent(sources).assessment).toBeUndefined();
  });

  it('falls back to the id where the catalogue no longer names a skipped pillar', () => {
    const sources: MonthSources = {
      month: month('2026-08'),
      window: WINDOW,
      runs: [],
      scans: [scan({ id: 'closing', finishedAt: new Date('2026-08-25T10:00:00Z') })],
      risks: [],
      actions: [],
      label,
      pillarTitle: () => undefined,
      finalisation: {
        reviewId: 'review-closing',
        finalised: true,
        recorded: 1,
        expected: 1,
        refreshed: 0,
        confirmed: 0,
        skipped: ['retired-pillar'],
        cited: 0,
      },
    };

    // An id is a poor sentence and it is the record; dropping the pillar would leave the document
    // saying a score was reviewed in full when part of it was skipped.
    expect(monthContent(sources).review?.[2]?.value).toContain('retired-pillar');
  });

  it('leaves the review section empty where this app has no record of one', () => {
    const sources: MonthSources = {
      month: month('2026-08'),
      window: WINDOW,
      runs: [],
      scans: [scan({ id: 'closing', finishedAt: new Date('2026-08-25T10:00:00Z') })],
      risks: [],
      actions: [],
      label,
    };

    // No row at all rather than a row reading "not reviewed": the absence of a record is not a fact
    // about whether anybody reviewed the run.
    expect(monthContent(sources).review).toEqual([]);
  });

  it('carries no review section at all for a month no run closed', () => {
    const sources: MonthSources = {
      month: month('2026-08'),
      window: WINDOW,
      runs: [],
      scans: [],
      risks: [],
      actions: [],
      label,
    };

    // Empty would say this app has no record of a review of the closing run, and there is no closing
    // run to have reviewed.
    expect(monthContent(sources).review).toBeUndefined();
  });

  it('accounts for every run it counted, including one no state finished', () => {
    // The rows counted the four terminal states while the total counted every run, so a month holding a
    // run still recorded as running printed a breakdown that did not sum to its own total.
    const sources: MonthSources = {
      month: month('2026-08'),
      window: WINDOW,
      runs: [
        run({ id: 'r1', state: 'complete' }),
        run({ id: 'r2', state: 'running' }),
        run({ id: 'r3', state: 'failed' }),
      ],
      scans: [],
      risks: [],
      actions: [],
      label,
    };

    const health = monthContent(sources).runHealth;

    const value = (label: string): number => Number(health.find((fact) => fact.label === label)?.value);
    expect(value('Assessment runs')).toBe(3);
    expect(value('Unfinished')).toBe(1);
    expect(value('Completed') + value('Partial') + value('Failed') + value('Cancelled') + value('Unfinished')).toBe(
      value('Assessment runs')
    );
  });

  it('leaves movement and finding deltas empty without a prior reading', () => {
    const sources: MonthSources = {
      month: month('2026-08'),
      window: WINDOW,
      runs: [],
      scans: [scan({ id: 'closing', finishedAt: new Date('2026-08-25T10:00:00Z'), outcomes: { C1: 'fail' } })],
      risks: [],
      actions: [],
      label,
    };
    const content = monthContent(sources);
    expect(content.movement).toEqual([]);
    expect(content.findingDeltas).toEqual([]);
    // The closing-scan census still lands.
    expect(content.outcomes.map((fact) => fact.label)).toEqual([
      'Met',
      'Failing',
      'Partial',
      'Not applicable',
      'Unmeasured',
    ]);
  });

  it('leaves the closing-scan sections empty when no scan landed in the month', () => {
    const sources: MonthSources = {
      month: month('2026-08'),
      window: WINDOW,
      // A scan exists, but its result landed outside the window.
      runs: [run({ id: 'r1', state: 'complete' })],
      scans: [scan({ id: 'stray', finishedAt: new Date('2026-09-15T10:00:00Z') })],
      priorScan: scan({
        id: 'prior',
        finishedAt: new Date('2026-07-31T12:00:00Z'),
        overall: 42,
        outcomes: { C1: 'pass' },
      }),
      risks: [],
      actions: [],
      label,
    };
    const content = monthContent(sources);
    expect(content.outcomes).toEqual([]);
    expect(content.movement).toEqual([]);
    expect(content.findingDeltas).toEqual([]);
    // Run health does not depend on a scan.
    expect(content.runHealth[0]).toEqual({ label: 'Assessment runs', value: '1' });
  });

  it('draws the month being published as the base of its own trend', () => {
    const sources: MonthSources = {
      month: month('2026-08'),
      window: WINDOW,
      runs: [],
      scans: [scan({ id: 'closing', finishedAt: new Date('2026-08-25T10:00:00Z'), overall: 71, stamp: stamp() })],
      risks: [],
      actions: [],
      label,
    };
    expect(monthContent(sources).trend).toEqual([
      { month: month('2026-08'), label: 'August 2026', score: '71', comparability: 'permitted' },
    ]);
  });

  it('refuses a pre-release development run even when it is the series base', () => {
    const sources: MonthSources = {
      month: month('2026-08'),
      window: WINDOW,
      runs: [],
      scans: [
        scan({
          id: 'closing',
          finishedAt: new Date('2026-08-25T10:00:00Z'),
          overall: 71,
          stamp: stamp({ publicMethodology: undefined }),
        }),
      ],
      risks: [],
      actions: [],
      label,
    };
    const [point] = monthContent(sources).trend;

    expect(point?.comparability).toBe('refused');
    expect(point?.note).toContain('pre-release development records');
    expect(point?.note).toContain('not points in a customer methodology trend');
  });

  it('draws prior published months oldest-first, with the month being published last', () => {
    const trend = monthContent(withSeries([point('2026-06', 40), point('2026-07', 55)])).trend;

    expect(trend.map((row) => row.month)).toEqual([month('2026-06'), month('2026-07'), month('2026-08')]);
    expect(trend.map((row) => row.score)).toEqual(['40', '55', '80']);
    expect(trend.at(-1)?.comparability).toBe('permitted');
  });

  it('permits a prior month measured on the same basis as the one being published', () => {
    const trend = monthContent(withSeries([point('2026-07', 55)])).trend;

    expect(trend[0]).toEqual({ month: month('2026-07'), label: 'July 2026', score: '55', comparability: 'permitted' });
  });

  it('caveats a prior month from a different build rather than dropping it', () => {
    const trend = monthContent(
      withSeries([point('2026-07', 55, stamp({ identity: identity({ build: { id: '0.2.0+bbbbbbbbbbbb' } }) }))])
    ).trend;

    expect(trend[0]?.comparability).toBe('caveat');
    expect(trend[0]?.note).toContain('different builds');
  });

  it('refuses a prior month whose catalogue changed, carrying the rule’s reason', () => {
    const trend = monthContent(
      withSeries([point('2026-07', 55, stamp({ catalogueFingerprint: 'sha256:other' }))])
    ).trend;

    expect(trend[0]?.comparability).toBe('refused');
    expect(trend[0]?.note).toContain('different catalogue versions');
  });

  it('refuses a month whose closing run did not record how it was measured', () => {
    const trend = monthContent(withSeries([{ month: month('2026-07'), score: '55', closingScan: 'read' }])).trend;

    expect(trend[0]?.comparability).toBe('refused');
    expect(trend[0]?.note).toContain('did not record how it was measured');
  });

  it('keeps the score of a month whose closing run this app can no longer read', () => {
    // Scans are kept 730 days and publications 2555, so a month can be on record with a score whose run
    // has aged out of history. It was scored, and its own document is where its basis is written down.
    const trend = monthContent(
      withSeries([{ month: month('2026-07'), score: '55', closingScan: 'not-in-history' }])
    ).trend;

    expect(trend[0]?.score).toBe('55');
    expect(trend[0]?.comparability).toBe('refused');
    expect(trend[0]?.note).toContain('not in the scan history this app reads');
    expect(trend[0]?.note).toContain('own published document');
    // The other case's sentence is false about this month: it did record how it was measured.
    expect(trend[0]?.note).not.toContain('did not record');
  });

  it('reads a point with no score on record as not scored', () => {
    const trend = monthContent(withSeries([{ month: month('2026-07'), closingScan: 'read' }])).trend;

    expect(trend[0]?.score).toBe('not scored');
  });

  it('is a pure function of its sources', () => {
    const sources: MonthSources = {
      month: month('2026-08'),
      window: WINDOW,
      runs: [run()],
      scans: [scan({ id: 'closing', finishedAt: new Date('2026-08-25T10:00:00Z') })],
      priorScan: scan({ id: 'prior', finishedAt: new Date('2026-07-31T12:00:00Z') }),
      risks: [risk()],
      actions: [action()],
      label,
    };
    expect(monthContent(sources)).toEqual(monthContent(sources));
  });
});

// A month is a record of a month, so publishing it in September and again in December has to produce the
// same document. The exceptions section is the part that reads a live register, and it reads it as of the
// month's close: an acceptance revoked in October covered the requirement for all of August, and August
// says so however long after the fact somebody asks.
describe('a month published again after its exceptions ended', () => {
  const august = (risks: readonly AcceptedRisk[]): MonthSources => ({
    month: month('2026-08'),
    window: WINDOW,
    runs: [],
    scans: [scan({ id: 'closing', finishedAt: new Date('2026-08-25T10:00:00Z'), overall: 60 })],
    risks,
    actions: [],
    label,
  });

  const held = risk();
  const ended: AcceptedRisk = {
    ...held,
    revoked: {
      by: 'raj@example.com',
      at: new Date('2026-10-14T00:00:00Z'),
      reason: 'The workspace was locked down properly, so nothing is being carried any more.',
    },
  };

  it('carries the acceptance that stood at the close, whether or not it has since been revoked', () => {
    const inSeptember = monthContent(august([held])).exceptions;
    const inDecember = monthContent(august([ended])).exceptions;

    expect(inSeptember).toEqual([
      {
        control: 'C1',
        requirement: 'Encrypt data at rest',
        owner: 'owner@example.com',
        residual: 'low',
        until: '2026-10-01',
      },
    ]);
    expect(inDecember).toEqual(inSeptember);
  });

  it('drops one revoked inside the month, because that one was not standing when the month closed', () => {
    const during: AcceptedRisk = {
      ...held,
      revoked: {
        by: 'raj@example.com',
        at: new Date('2026-08-14T00:00:00Z'),
        reason: 'The workspace was locked down properly, so nothing is being carried any more.',
      },
    };

    expect(monthContent(august([during])).exceptions).toEqual([]);
  });
});

// The month's movement is a claim about the estate, frozen on publication. It is made only between
// two readings of the same question, and the month closes on the scheduled run — the system of record —
// so an assessor's spot-check cannot replace it, or be compared against it.
describe('what a month opens and closes at', () => {
  const SERVICE = { executionMode: 'service-principal' as const, actor: 'sp-schedule' };

  /** An earlier scan on the default basis, with an outcome the closing scan can be read against. */
  function earlier(over: Partial<ScanSummary> = {}): ScanSummary {
    return scan({
      id: 'prior',
      finishedAt: new Date('2026-07-31T12:00:00Z'),
      overall: 50,
      counts: counts({ pass: 5, fail: 5 }),
      outcomes: { C1: 'pass' },
      stamp: stamp(),
      ...over,
    });
  }

  function closes(over: Partial<ScanSummary> = {}): ScanSummary {
    return scan({
      id: 'closing',
      finishedAt: new Date('2026-08-25T10:00:00Z'),
      overall: 60,
      counts: counts({ pass: 6, fail: 4 }),
      outcomes: { C1: 'fail' },
      stamp: stamp(),
      ...over,
    });
  }

  function august(scans: readonly ScanSummary[], priorScan?: ScanSummary, priorRefusal?: string): MonthSources {
    return {
      month: month('2026-08'),
      window: WINDOW,
      runs: [],
      scans,
      ...(priorScan != null ? { priorScan } : {}),
      ...(priorRefusal != null ? { priorRefusal } : {}),
      risks: [],
      actions: [],
      label,
    };
  }

  it('publishes no movement across an opening by one identity and a closing by another', () => {
    const opening = earlier({ stamp: stamp({ actor: 'analyst@example.com' }) });
    const closing = closes({
      trigger: 'scheduled',
      ...SERVICE,
      stamp: stamp({ ...SERVICE, trigger: 'scheduled' }),
    });

    const content = monthContent(august([closing], opening));

    expect(content.movement).toEqual([]);
    expect(content.findingDeltas).toEqual([]);
    // The reason is the comparability rule's own, which names the two identities.
    expect(content.movementNote).toContain('Movement and finding changes are not shown');
    expect(content.movementNote).toContain('as the identity that started it and the other as a service principal');
  });

  it('publishes no movement between two identities of one execution mode, and says which', () => {
    const opening = earlier({ stamp: stamp({ actor: 'ana@example.com' }) });
    const closing = closes({ stamp: stamp({ actor: 'raj@example.com' }) });

    const note = monthContent(august([closing], opening)).movementNote;

    expect(note).toContain('ana@example.com');
    expect(note).toContain('raj@example.com');
  });

  it('publishes no movement across the Version 1 to Version 2 methodology transition', () => {
    const released = (publicVersion: number) => ({
      publicMethodology: {
        publicVersion,
        manifestDigest: `sha256:manifest-${String(publicVersion)}`,
        state: 'released' as const,
      },
    });
    const opening = earlier({ stamp: stamp(released(1)) });
    const closing = closes({ stamp: stamp(released(2)) });

    const content = monthContent(august([closing], opening));

    expect(content.movement).toEqual([]);
    expect(content.findingDeltas).toEqual([]);
    expect(content.movementNote).toContain('different public methodology versions (2 and 1)');
  });

  it('publishes no movement from an opening that did not record how it was measured', () => {
    const opening = earlier({ stamp: undefined });

    const content = monthContent(august([closes()], opening));

    expect(content.movement).toEqual([]);
    expect(content.findingDeltas).toEqual([]);
    expect(content.movementNote).toContain('did not record how it was measured');
  });

  it('carries the refusal the endpoint recorded when it found no comparable opening', () => {
    const content = monthContent(
      august([closes()], undefined, 'These scans looked back over different windows (30 and 90 days).')
    );

    expect(content.movement).toEqual([]);
    expect(content.movementNote).toContain('different windows (30 and 90 days)');
  });

  it('says there was nothing to measure from when no scan came before the month', () => {
    const content = monthContent(august([closes()]));

    expect(content.movement).toEqual([]);
    expect(content.movementNote).toContain('no scan finished before August 2026');
  });

  it('has no movement note for a month no run closed', () => {
    expect(monthContent(august([])).movementNote).toBeUndefined();
  });

  it('measures a comparable pair exactly as before, with no note', () => {
    const content = monthContent(august([closes()], earlier()));

    expect(content.movement).toEqual([
      { label: 'Overall score', from: '50', to: '60' },
      { label: 'Requirements answered', from: '10 of 10', to: '10 of 10' },
      { label: 'Pillars measured', from: '1', to: '1' },
    ]);
    expect(content.findingDeltas).toEqual([
      { control: 'C1', requirement: 'Encrypt data at rest', pillar: 'Security', from: 'pass', to: 'fail' },
    ]);
    expect(content.movementNote).toBeUndefined();
  });

  describe('closingScan', () => {
    it('closes the month on the scheduled run even when an interactive one finished later', () => {
      const scheduled = closes({ id: 'scheduled', trigger: 'scheduled', finishedAt: new Date('2026-08-20T02:00:00Z') });
      const interactive = closes({
        id: 'by-hand',
        trigger: 'interactive',
        finishedAt: new Date('2026-08-28T15:00:00Z'),
      });

      expect(closingScan([interactive, scheduled], WINDOW)?.id).toBe('scheduled');
      expect(closingScan([scheduled, interactive], WINDOW)?.id).toBe('scheduled');
    });

    it('takes the latest of several scheduled runs', () => {
      const first = closes({ id: 'first', trigger: 'scheduled', finishedAt: new Date('2026-08-06T02:00:00Z') });
      const second = closes({ id: 'second', trigger: 'scheduled', finishedAt: new Date('2026-08-13T02:00:00Z') });

      expect(closingScan([second, first], WINDOW)?.id).toBe('second');
    });

    it('falls back to the latest scan of any kind where the month has no scheduled run', () => {
      const early = closes({ id: 'early', trigger: 'interactive', finishedAt: new Date('2026-08-04T10:00:00Z') });
      const late = closes({ id: 'late', trigger: 'interactive', finishedAt: new Date('2026-08-27T10:00:00Z') });

      expect(closingScan([early, late], WINDOW)?.id).toBe('late');
    });

    it('does not treat a run that recorded no trigger as scheduled', () => {
      const unrecorded = closes({ id: 'unrecorded', finishedAt: new Date('2026-08-28T10:00:00Z') });
      const scheduled = closes({ id: 'scheduled', trigger: 'scheduled', finishedAt: new Date('2026-08-02T02:00:00Z') });

      expect(closingScan([unrecorded, scheduled], WINDOW)?.id).toBe('scheduled');
    });

    it('ignores a scheduled run outside the month', () => {
      const outside = closes({ id: 'outside', trigger: 'scheduled', finishedAt: new Date('2026-09-02T02:00:00Z') });
      const inside = closes({ id: 'inside', trigger: 'interactive' });

      expect(closingScan([outside, inside], WINDOW)?.id).toBe('inside');
    });
  });

  describe('the closing statement', () => {
    it('says the scheduled run closed the month', () => {
      const closing = closes({ trigger: 'scheduled' });

      expect(monthContent(august([closing])).closing).toEqual({
        kind: 'scheduled',
        statement: 'The month closes on its latest scheduled run, the system of record.',
      });
    });

    it('says so when a month with no scheduled run closes on a scan started by hand', () => {
      const closing = closes({ trigger: 'interactive' });

      expect(monthContent(august([closing])).closing).toEqual({
        kind: 'latest-scan',
        statement:
          'No scheduled run finished in August 2026, so the month closes on its latest scan, which was started by hand.',
      });
    });

    it('does not claim a hand start for a scan that recorded no trigger', () => {
      expect(monthContent(august([closes()])).closing?.statement).toContain(
        'did not record whether it was scheduled or started by hand'
      );
    });

    it('is absent where no run closed the month', () => {
      expect(monthContent(august([])).closing).toBeUndefined();
    });
  });

  describe('openingReading', () => {
    it('passes over a newer earlier scan that cannot be compared for an older one that can', () => {
      const closing = closes();
      const otherLookback = earlier({
        id: 'newer',
        finishedAt: new Date('2026-07-30T12:00:00Z'),
        stamp: stamp({ lookbackDays: 90 }),
      });
      const comparablePrior = earlier({ id: 'older', finishedAt: new Date('2026-07-20T12:00:00Z') });

      expect(openingReading([comparablePrior, otherLookback], closing).scan?.id).toBe('older');
    });

    it('refuses with the nearest scan’s reason when none can be compared', () => {
      const closing = closes();
      const near = earlier({
        id: 'near',
        finishedAt: new Date('2026-07-30T12:00:00Z'),
        stamp: stamp({ lookbackDays: 90 }),
      });
      const far = earlier({ id: 'far', finishedAt: new Date('2026-07-01T12:00:00Z'), stamp: undefined });

      const opening = openingReading([far, near], closing);

      expect(opening.scan).toBeUndefined();
      expect(opening.refusal).toContain('different windows (30 and 90 days)');
    });

    it('has nothing to open without a closing run, or without an earlier scan', () => {
      expect(openingReading([earlier()], undefined)).toEqual({});
      expect(openingReading([], closes())).toEqual({});
    });
  });
});
