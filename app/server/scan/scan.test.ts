// End-to-end scans against synthetic estates.
//
// No workspace involved: a collector that returns fixed signal values is enough,
// because the resolvers are pure. That is the point of the seam — the behaviour this
// file checks is the behaviour that matters most and would otherwise be untestable
// without a real all-serverless estate to point at.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../catalogue/catalogue.js';
import type { CatalogueSpan } from '../catalogue/changelog.js';
import type { Collector, CollectorContext, SignalId, SignalResult } from '../collect/signal.js';
import { COMPLETE, observed } from '../collect/signal.js';
import type { CredentialProvider, ExecutionMode } from '../collect/credentials.js';
import { ACCOUNT_SCOPE, workspaceScope } from '../collect/estate-scope.js';
import { buildRegistry } from '../resolve/resolvers/index.js';
import { comparable, runScan, type ScanStamp } from './scan.js';
import type { RunIdentity } from './identity.js';
import type { Finding, Outcome } from '../resolve/finding.js';
import type { ApplicabilityDecision, ApplicabilityLever } from '../apply/applicability.js';

const catalogue = loadCatalogue();
const registry = buildRegistry();

function credentialsFor(mode: ExecutionMode, actor: string): CredentialProvider {
  return {
    mode,
    databricks: () =>
      Promise.resolve({ mode, actor, host: 'https://example.cloud.databricks.com', token: () => Promise.resolve('t') }),
    cloud: () => Promise.resolve(null),
  };
}

const asUser = credentialsFor('on-behalf-of-user', 'someone@example.com');

/** A collector that answers from a fixed map, so an estate is a literal. */
function fakeCollector(values: Partial<Record<SignalId, unknown>>): Collector {
  return {
    surface: 'sql',
    name: 'synthetic',
    signals: Object.keys(values) as SignalId[],
    collect: (ids: readonly SignalId[], _context: CollectorContext): Promise<SignalResult[]> =>
      Promise.resolve(ids.map((id) => observed(id, values[id], 1, COMPLETE))),
  };
}

/** An all-purpose cluster with none of the cost controls in place. */
const CLASSIC_CLUSTER = {
  clusterId: 'c-1',
  name: 'analytics',
  source: 'UI',
  runtime: '13.3.x-scala2.12',
  hasPolicy: false,
  autoscaling: false,
  autoTerminates: false,
  gpuNode: false,
  availability: 'ON_DEMAND',
};

/**
 * The data estate, held identical between the two compute architectures below.
 *
 * Without it the comparison test is void: an estate where nothing is scoreable has no
 * score, and `undefined` cannot be compared against a number in either direction.
 */
const DATA_ESTATE = {
  'sql:uc.census': {
    tableCount: 100,
    catalogCount: 4,
    schemaCount: 20,
    managedTables: 90,
    externalTables: 10,
    views: 0,
    metricViews: 0,
    foreignTables: 0,
    deltaTables: 100,
    icebergTables: 0,
    optimizedFormatTables: 100,
    describedTables: 90,
    distinctOwners: 5,
  },
};

/** An estate on classic compute with none of the cost controls configured. */
const CLASSIC_ESTATE = {
  ...DATA_ESTATE,
  'sql:estate.compute_profile': {
    rows: [
      {
        product: 'JOBS',
        serverless: false,
        usageRecords: 10,
        usageQuantity: 100,
        distinctClusters: 2,
        distinctWarehouses: 0,
        distinctJobs: 4,
      },
    ],
    classicClusters: 2,
    classicUsage: 100,
    serverlessUsage: 0,
    summary: 2,
  },
  'sql:compute.clusters': [CLASSIC_CLUSTER, { ...CLASSIC_CLUSTER, clusterId: 'c-2', name: 'etl' }],
  'sql:compute.warehouses': [],
  'sql:cost.compute_mix': {
    totalCost: 1000,
    serverlessCost: 0,
    // All of this estate's spend is on compute somebody configured, and none of it is serverless, which
    // is what makes it a classic estate rather than one whose bill happens to be serving and storage.
    choiceCost: 1000,
    serverlessChoiceCost: 0,
    photonCost: 0,
    photonEligibleCost: 1000,
    allPurposeCost: 400,
    jobsOnAllPurposeCost: 400,
    distinctSkus: 3,
    // An estate the price list covers completely, so the cost controls report figures rather than
    // declining them. Stated because this fixture is untyped: without the coverage fields the gate saw
    // undefined where it expects a count, and the pooled ratio it used to compute was NaN — which
    // compared false and let every figure through, whatever the coverage actually was.
    usageRecords: 10,
    pricedRecords: 10,
    unpricedRecords: 0,
    leastPricedUnit: 'DBU',
    leastPricedShare: 1,
    usageUnitCount: 1,
    currencies: 1,
    duplicatePriceMatches: 0,
    currency: 'USD',
  },
};

/** The same data estate having moved entirely to serverless: no clusters exist to govern. */
const SERVERLESS_ESTATE = {
  ...DATA_ESTATE,
  'sql:estate.compute_profile': {
    rows: [
      {
        product: 'JOBS_SERVERLESS',
        serverless: true,
        usageRecords: 10,
        usageQuantity: 100,
        distinctClusters: 0,
        distinctWarehouses: 0,
        distinctJobs: 4,
      },
    ],
    classicClusters: 0,
    classicUsage: 0,
    serverlessUsage: 100,
    summary: 0,
  },
  'sql:compute.clusters': [],
  'sql:compute.warehouses': [],
  'sql:cost.compute_mix': {
    totalCost: 1000,
    serverlessCost: 1000,
    choiceCost: 1000,
    serverlessChoiceCost: 1000,
    photonCost: 0,
    photonEligibleCost: 0,
    allPurposeCost: 0,
    jobsOnAllPurposeCost: 0,
    distinctSkus: 2,
    usageRecords: 10,
    pricedRecords: 10,
    unpricedRecords: 0,
    leastPricedUnit: 'DBU',
    leastPricedShare: 1,
    usageUnitCount: 1,
    currencies: 1,
    duplicatePriceMatches: 0,
    currency: 'USD',
  },
};

async function scan(values: Partial<Record<SignalId, unknown>>) {
  return runScan({
    catalogue,
    registry,
    collectors: [fakeCollector(values)],
    credentials: asUser,
    scope: workspaceScope('123'),
    lookbackDays: 30,
    pillars: ['cost-optimization'],
    warehouse: 'wh-1',
  });
}

function findingFor(findings: readonly Finding[], controlId: string): Finding {
  const found = findings.find((finding) => finding.controlId === controlId);
  if (found == null) throw new Error(`No finding for ${controlId}`);
  return found;
}

/** The cluster-configuration controls that have nothing to assess on serverless. */
const CLUSTER_SHAPED = ['CO-02-01', 'CO-02-02', 'CO-02-03'];

describe('a scan of an all-serverless estate', () => {
  it('excludes the cluster-configuration controls rather than failing them', async () => {
    // The single most important behaviour in the app: a customer who moved to
    // serverless must not be told their best architectural decision made them less
    // compliant.
    const result = await scan(SERVERLESS_ESTATE);

    for (const controlId of CLUSTER_SHAPED) {
      expect(findingFor(result.findings, controlId).outcome, controlId).toBe('not-applicable');
    }
  });

  it('says why each exclusion happened, in the customer’s terms', async () => {
    const result = await scan(SERVERLESS_ESTATE);

    for (const controlId of CLUSTER_SHAPED) {
      const reason = findingFor(result.findings, controlId).outcomeReason ?? '';
      // A smaller denominator has to read as explained fact rather than score
      // inflation, so an exclusion without a reason is a bug even though it scores
      // identically.
      expect(reason, controlId).toContain('no classic compute');
    }
  });

  it('scores at least as well as the same estate on badly configured classic compute', async () => {
    const serverless = await scan(SERVERLESS_ESTATE);
    const classic = await scan(CLASSIC_ESTATE);

    // Both must actually be scoreable, or the comparison passes vacuously.
    expect(serverless.score.overall).toBeDefined();
    expect(classic.score.overall).toBeDefined();
    expect(serverless.score.overall ?? 0).toBeGreaterThanOrEqual(classic.score.overall ?? 0);
  });

  it('reports the excluded count so the two scores stay comparable', async () => {
    const result = await scan(SERVERLESS_ESTATE);
    const pillar = result.score.pillars.find((candidate) => candidate.pillarId === 'cost-optimization');

    expect(pillar?.notApplicable).toBeGreaterThanOrEqual(CLUSTER_SHAPED.length);
    expect(pillar?.total).toBe(result.findings.length);
  });
});

describe('a scan of a classic estate', () => {
  it('raises the cluster-configuration findings against it', async () => {
    const result = await scan(CLASSIC_ESTATE);

    for (const controlId of CLUSTER_SHAPED) {
      expect(['fail', 'partial'], controlId).toContain(findingFor(result.findings, controlId).outcome);
    }
  });

  it('puts the failures in worst-first order for remediation', async () => {
    const result = await scan(CLASSIC_ESTATE);
    const pillar = result.score.pillars.find((candidate) => candidate.pillarId === 'cost-optimization');

    expect(pillar?.worstFirst.length).toBeGreaterThan(0);
    expect(pillar?.worstFirst[0]?.outcome).toBe('fail');
  });
});

const DAY = 24 * 60 * 60 * 1000;
function decisionFor(controlId: string, lever: ApplicabilityLever): ApplicabilityDecision {
  const now = Date.now();
  return {
    id: `dec-${controlId}`,
    controlId,
    lever,
    ordinal: 1,
    reason: 'The customer took this requirement out of the score, in a sentence a reviewer can weigh.',
    owner: 'platform-team',
    effectiveFrom: new Date(now - DAY),
    expiresAt: new Date(now + 90 * DAY),
    recordedBy: 'someone@example.com',
    recordedAt: new Date(now - DAY),
  };
}

async function scanWith(
  values: Partial<Record<SignalId, unknown>>,
  decisions: ReadonlyMap<string, readonly ApplicabilityDecision[]>
) {
  return runScan({
    catalogue,
    registry,
    collectors: [fakeCollector(values)],
    credentials: asUser,
    scope: workspaceScope('123'),
    lookbackDays: 30,
    pillars: ['cost-optimization'],
    warehouse: 'wh-1',
    decisions,
  });
}

describe('a scan with the customer’s applicability decisions', () => {
  /** A control reading `outcome` in the classic estate, so a decision over it is deterministic. */
  async function aControlReading(outcome: Outcome): Promise<string> {
    const baseline = await scan(CLASSIC_ESTATE);
    const control = baseline.findings.find((finding) => finding.outcome === outcome);
    if (control == null) throw new Error(`no control reading ${outcome} to exclude`);
    return control.controlId;
  }

  it('rewrites a not-applicable decision to not-applicable, carrying the reason, and exposes it', async () => {
    const controlId = await aControlReading('pass');
    const result = await scanWith(CLASSIC_ESTATE, new Map([[controlId, [decisionFor(controlId, 'not-applicable')]]]));

    expect(findingFor(result.findings, controlId).outcome).toBe('not-applicable');
    expect(findingFor(result.findings, controlId).outcomeReason).toContain('took this requirement out');
    expect(result.score.exposure?.excluded.map((e) => e.controlId)).toContain(controlId);
    expect(result.score.exposure?.excluded.find((e) => e.controlId === controlId)?.lever).toBe('not-applicable');
  });

  it('rewrites a disabled decision to unmeasurable with the disabled kind', async () => {
    const controlId = await aControlReading('pass');
    const result = await scanWith(CLASSIC_ESTATE, new Map([[controlId, [decisionFor(controlId, 'disabled')]]]));

    expect(findingFor(result.findings, controlId).outcome).toBe('unmeasurable');
    expect(findingFor(result.findings, controlId).unmeasured).toBe('disabled');
  });

  it('sets a decision aside — lapsed, not excluded — when its reading has turned to a failure', async () => {
    const controlId = await aControlReading('fail');
    const result = await scanWith(CLASSIC_ESTATE, new Map([[controlId, [decisionFor(controlId, 'not-applicable')]]]));

    // The finding is left as it reads, and the decision is reported as lapsed rather than applied.
    expect(findingFor(result.findings, controlId).outcome).toBe('fail');
    expect(result.score.exposure?.excluded.map((e) => e.controlId)).not.toContain(controlId);
    expect(result.score.exposure?.lapsed.map((l) => l.controlId)).toContain(controlId);
  });

  it('carries no exposure at all when nothing is excluded, so an ordinary score is unchanged', async () => {
    const result = await scan(CLASSIC_ESTATE);
    expect(result.score.exposure).toBeUndefined();
  });
});

describe('a scan with no signals at all', () => {
  it('completes and reports every control as unmeasured rather than failing', async () => {
    // A customer with no system-table access must get an explanation, not a zero.
    const result = await scan({});

    expect(result.state).toBe('complete');
    expect(result.findings.every((finding) => finding.outcome !== 'fail')).toBe(true);
    expect(result.score.overall).toBeUndefined();
  });

  it('names what is missing on each control', async () => {
    const result = await scan({});
    const unmeasured = result.findings.filter((finding) => finding.outcome === 'unmeasurable');

    expect(unmeasured.length).toBeGreaterThan(0);
    expect(unmeasured.every((finding) => (finding.outcomeReason ?? '').length > 20)).toBe(true);
  });
});

describe('the scan stamp', () => {
  it('records what the result can be compared against', async () => {
    const result = await scan(SERVERLESS_ESTATE);

    expect(result.stamp.catalogueVersion).toBe(catalogue.version.version);
    expect(result.stamp.catalogueFingerprint).toBe(catalogue.version.fingerprint);
    expect(result.stamp.executionMode).toBe('on-behalf-of-user');
    expect(result.stamp.actor).toBe('someone@example.com');
    expect(result.stamp.scope.hostWorkspaceId).toBe('123');
  });

  it('attributes every reading to the identity the scan actually ran as', async () => {
    // Taken from the credential provider rather than from a caller's argument, on the same
    // reasoning as the stamp: an attribution that can disagree with the credentials used is worse
    // than none, because it is the field a reader would trust to settle a dispute.
    const result = await scan(SERVERLESS_ESTATE);

    expect(result.signals.length).toBeGreaterThan(0);
    for (const signal of result.signals) {
      expect(signal.provenance, signal.id).toEqual({
        surface: 'sql',
        collector: 'synthetic',
        authority: 'on-behalf-of-user',
        actor: 'someone@example.com',
        from: 'warehouse wh-1',
      });
    }
  });

  it('carries the attribution onto the evidence, where the reader disputing a number is looking', async () => {
    const result = await scan(SERVERLESS_ESTATE);
    const evidence = result.findings.flatMap((finding) => finding.evidence);

    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.every((one) => one.provenance?.actor === 'someone@example.com')).toBe(true);
  });

  it('records which pillars it measured, and does not claim any were requested', async () => {
    // `runScan` is given a pillar list here, as a build restriction. It must not record that
    // as a caller's request: only the runner can tell the two apart, and recording the
    // restriction made every ordinary scan present itself as a targeted rerun of itself.
    const result = await scan(SERVERLESS_ESTATE);

    expect(result.requestedPillars).toBeUndefined();
    expect(result.measurement.map((entry) => entry.pillarId)).toEqual(['cost-optimization']);
    expect(result.measurement.every((entry) => !entry.carriedForward)).toBe(true);
    expect(result.measurement[0].actor).toBe('someone@example.com');
  });
});

describe('comparing two scans', () => {
  /**
   * Two runs of the same build by default, because that is what two runs a week apart normally are,
   * and it keeps each test below about the one axis it names. What an absent identity means is its own
   * case further down.
   */
  const SAME_BUILD: RunIdentity = {
    build: { id: '0.1.0+abc123def456' },
    methodology: { id: 'sha256:aaa' },
    record: { id: 'codec-2' },
    sources: ['sql'],
  };

  function stamp(overrides: Partial<ScanStamp> = {}): ScanStamp {
    return {
      publicMethodology: {
        publicVersion: 1,
        manifestDigest: 'sha256:manifest',
        state: 'released',
        effectiveDate: '2026-09-01',
      },
      catalogueVersion: '3',
      catalogueFingerprint: 'abc',
      executionMode: 'on-behalf-of-user',
      actor: 'someone@example.com',
      scope: ACCOUNT_SCOPE,
      lookbackDays: 30,
      identity: SAME_BUILD,
      ...overrides,
    };
  }

  it('compares two scans of the same estate by the same identity', () => {
    expect(comparable(stamp(), stamp())).toEqual({ ok: true });
  });

  describe('when the public methodology identity differs', () => {
    it('refuses a development record rather than attaching it to Version 1', () => {
      const result = comparable(stamp(), stamp({ publicMethodology: undefined }));

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('pre-release development record');
    });

    it('refuses two development records as customer trend points', () => {
      const result = comparable(
        stamp({ publicMethodology: undefined }),
        stamp({ publicMethodology: undefined }),
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('not points in a customer methodology trend');
    });

    it('refuses the same version label at different manifest digests', () => {
      const result = comparable(
        stamp({ publicMethodology: { publicVersion: 1, manifestDigest: 'sha256:new', state: 'released' } }),
        stamp(),
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('different manifest digests');
    });

    it('compares two records of the same candidate without calling either released', () => {
      const candidate = stamp({
        publicMethodology: { publicVersion: 1, manifestDigest: 'sha256:manifest', state: 'candidate' },
      });

      expect(comparable(candidate, candidate)).toEqual({ ok: true });
    });
  });

  it('refuses to compare an account-wide scan with one narrowed to a single workspace', () => {
    // The failure this guards against is a trend line showing a score collapse when
    // nothing changed except how much of the account was looked at.
    const result = comparable(stamp(), stamp({ scope: workspaceScope('123') }));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('the whole account');
    expect(result.ok === false && result.reason).toContain('workspace 123 alone');
  });

  it('compares two scans narrowed to the same workspace', () => {
    const narrowed = stamp({ scope: workspaceScope('123') });
    expect(comparable(narrowed, narrowed)).toEqual({ ok: true });
  });

  it('refuses to compare scans narrowed to different workspaces', () => {
    const result = comparable(stamp({ scope: workspaceScope('123') }), stamp({ scope: workspaceScope('456') }));

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('workspace 456 alone');
  });

  describe('when the assessed workspace set moved', () => {
    // Deliberately not a refusal. A workspace added with poor configuration lowers the
    // score for a real reason and the trend should draw it. The tool cannot distinguish
    // that from the identity's grants widening over an unchanged estate, so it draws the
    // line and says what else changed.
    it('allows the comparison and names what appeared', () => {
      const result = comparable(
        stamp({ assessedWorkspaces: ['1', '2', '3'] }),
        stamp({ assessedWorkspaces: ['1', '2'] }),
      );

      expect(result.ok).toBe(true);
      expect(result.caveat).toContain('1 appeared (3)');
    });

    it('names what is no longer assessed', () => {
      const result = comparable(stamp({ assessedWorkspaces: ['1'] }), stamp({ assessedWorkspaces: ['1', '2'] }));

      expect(result.ok).toBe(true);
      expect(result.caveat).toContain('no longer assessed (2)');
    });

    it('says nothing when the same workspaces were assessed', () => {
      const set = ['1', '2'];
      expect(comparable(stamp({ assessedWorkspaces: set }), stamp({ assessedWorkspaces: set }))).toEqual({ ok: true });
    });

    it('does not invent drift when one scan could not read the directory', () => {
      // An absent set is unknown, not empty. Treating it as empty would report every
      // assessed workspace as newly appeared, turning a failed measurement into a finding.
      const result = comparable(stamp({ assessedWorkspaces: ['1', '2'] }), stamp());

      expect(result).toEqual({ ok: true });
    });
  });

  /*
   * The set a run was asked to cover, as against the set it turned out to assess. Asked refuses and
   * answered annotates, which is ADR 0042's distinction: a selected set is a question somebody wrote
   * down, and changing the question changes what the total is of.
   */
  describe('when the workspaces the run was asked to cover differ', () => {
    const asked = (...ids: string[]): Partial<ScanStamp> => ({
      scope: { ...ACCOUNT_SCOPE, selected: ids },
    });

    it('compares two runs asked for the same workspaces', () => {
      expect(comparable(stamp(asked('1', '2')), stamp(asked('1', '2')))).toEqual({ ok: true });
    });

    it('refuses when one was asked for a set and the other for whatever it could see', () => {
      const result = comparable(stamp(asked('1', '2')), stamp());

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('the workspaces an assessment names');
    });

    it('names which workspaces were added and removed', () => {
      const result = comparable(stamp(asked('1', '3')), stamp(asked('1', '2')));

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('3 added');
      expect(result.reason).toContain('2 removed');
    });
  });

  /*
   * The definition axis A2 built and did not wire. The fingerprint decides rather than the version
   * number, which is ADR 0037's property being spent: a rename produces a new version at the same
   * fingerprint, and two runs either side of it are still two measurements of one assessment.
   */
  describe('when the runs answer to an assessment', () => {
    const answering = (version: number, fingerprint: string, id = 'def-1'): Partial<ScanStamp> => ({
      definition: { id, version, fingerprint },
    });

    it('compares two runs of the same version', () => {
      expect(comparable(stamp(answering(2, 'sha256:aa')), stamp(answering(2, 'sha256:aa')))).toEqual({ ok: true });
    });

    it('compares across a revision that only renamed the assessment', () => {
      expect(comparable(stamp(answering(3, 'sha256:aa')), stamp(answering(2, 'sha256:aa')))).toEqual({ ok: true });
    });

    it('refuses when the assessment changed what it measures', () => {
      const result = comparable(stamp(answering(3, 'sha256:bb')), stamp(answering(2, 'sha256:aa')));

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('changed what it measures between version 2 and version 3');
    });

    it('refuses two different assessments', () => {
      const result = comparable(stamp(answering(1, 'sha256:aa', 'def-1')), stamp(answering(1, 'sha256:aa', 'def-2')));

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('different assessments');
    });

    it('refuses a defined run against a directly-started one', () => {
      const result = comparable(stamp(answering(1, 'sha256:aa')), stamp());

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('started directly');
    });
  });

  /*
   * What produced the run, as against what it was about. The split between refusing and qualifying is
   * per axis and argued in identity.ts; these hold it to that.
   */
  describe('when what produced the runs differs', () => {
    it('refuses a changed scoring method, because the totals are out of different things', () => {
      const result = comparable(stamp(), stamp({ identity: { ...SAME_BUILD, methodology: { id: 'sha256:bbb' } } }));

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('scoring method changed');
    });

    it('refuses when one run could not establish how it scored', () => {
      const result = comparable(
        stamp(),
        stamp({ identity: { ...SAME_BUILD, methodology: { unknown: 'the tables could not be read' } } })
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('does not record how findings were weighted');
    });

    it('draws the comparison across a build change and says so', () => {
      const result = comparable(stamp(), stamp({ identity: { ...SAME_BUILD, build: { id: '0.1.0+999999999999' } } }));

      expect(result.ok).toBe(true);
      expect(result.caveat).toContain('different builds of this app');
    });

    it('says when a source answered in one run and not the other', () => {
      const result = comparable(stamp(), stamp({ identity: { ...SAME_BUILD, sources: ['sql', 'rest'] } }));

      expect(result.ok).toBe(true);
      expect(result.caveat).toContain('rest answered in the earlier run and not the later');
    });

    /*
     * A run recorded before this app noted what produced it. Qualified rather than refused, because
     * refusing retroactively would empty every history in the product on the deploy that introduced
     * the field — a worse answer than a sentence saying the earlier run does not record it.
     */
    it('qualifies a comparison against a run that never recorded its build', () => {
      const older: ScanStamp = { ...stamp(), identity: undefined };
      const result = comparable(stamp(), older);

      expect(result.ok).toBe(true);
      expect(result.caveat).toContain('recorded before this app noted what produced it');
    });

    it('refuses across a change in what the customer excluded, unless the caller asks otherwise', () => {
      /*
       * Two scores over different denominators are not a trend, so the default refuses — and this is
       * the assertion that keeps that true now the axis is reported on its own field. `permit` is for
       * `carryForward`, which merges findings and scores the merge once instead of comparing two scores.
       */
      const later = stamp({ identity: { ...SAME_BUILD, exclusions: ['CO-01-02'] } });
      const earlier = stamp({ identity: { ...SAME_BUILD, exclusions: [] } });

      expect(comparable(later, earlier).ok).toBe(false);
      expect(comparable(later, earlier).reason).toContain('different denominators');
      expect(comparable(later, earlier, undefined, { acrossExclusionChange: 'permit' }).ok).toBe(true);
    });

    it('still refuses a permitted exclusion change when another axis refuses too', () => {
      // `permit` drops one barrier, not the check. A changed scoring method refuses either way.
      const later = stamp({ identity: { ...SAME_BUILD, exclusions: ['CO-01-02'], methodology: { id: 'sha256:bbb' } } });
      const earlier = stamp({ identity: { ...SAME_BUILD, exclusions: [] } });

      const result = comparable(later, earlier, undefined, { acrossExclusionChange: 'permit' });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('scoring method changed');
    });

    it('carries both the workspace drift and the build caveat, rather than one of the two', () => {
      const result = comparable(
        stamp({ assessedWorkspaces: ['1', '2'] }),
        stamp({ assessedWorkspaces: ['1'], identity: { ...SAME_BUILD, build: { id: '0.1.0+999999999999' } } })
      );

      expect(result.ok).toBe(true);
      expect(result.caveat).toContain('1 appeared (2)');
      expect(result.caveat).toContain('different builds');
    });
  });

  describe('a catalogue version described by the record', () => {
    /** A span the loader would produce, defaulting to the fingerprint the stamps carry. */
    function span(overrides: Partial<CatalogueSpan> = {}): CatalogueSpan {
      return {
        describable: true,
        added: [],
        removed: [],
        renamed: new Map(),
        changed: [],
        versions: ['4'],
        recordedFingerprint: 'def',
        ...overrides,
      };
    }

    it('permits the comparison without a caveat when nothing in the scoring shape moved', () => {
      // A release can move the fingerprint without moving anything a score depends on — declaring
      // that one requirement continues another, for instance. Refusing that reset every customer's
      // trend line over an edit they are not measured on, which is the failure this record exists to
      // remove rather than an example of it.
      const result = comparable(stamp({ catalogueVersion: '4', catalogueFingerprint: 'def' }), stamp(), span());

      expect(result).toEqual({ ok: true });
    });

    it('qualifies the comparison when the requirement set moved', () => {
      const result = comparable(
        stamp({ catalogueVersion: '4', catalogueFingerprint: 'def' }),
        stamp(),
        span({ added: ['NEW-01-01'] })
      );

      expect(result.ok).toBe(true);
      expect(result.caveat).toContain('1 added');
    });

    it('refuses when the record describes a different catalogue than the run was scored against', () => {
      // The entry and the catalogue it claims to describe have parted company: a hand-edited record,
      // or a version bumped without its entry being rewritten. Either way the span was composed from
      // some other pair of catalogues, and it is not evidence about these two runs.
      const result = comparable(
        stamp({ catalogueVersion: '4', catalogueFingerprint: 'def' }),
        stamp(),
        span({ recordedFingerprint: 'something-else', added: ['NEW-01-01'] })
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('does not match the catalogue this run was scored against');
    });
  });

  it('names the differing field rather than merely refusing', () => {
    for (const [field, differing] of [
      ['catalogue', stamp({ catalogueFingerprint: 'def', catalogueVersion: '4' })],
      ['identity', stamp({ actor: 'someone-else@example.com' })],
      ['execution mode', stamp({ executionMode: 'service-principal' })],
      ['window', stamp({ lookbackDays: 90 })],
    ] as const) {
      const result = comparable(stamp(), differing);
      expect(result.ok, field).toBe(false);
      // A refusal the user cannot act on generates a support ticket; one that names what
      // differs tells them which scan to re-run.
      expect((result.reason ?? '').length, field).toBeGreaterThan(40);
    }
  });
});

describe('a collector that throws', () => {
  it('does not take the scan down with it', async () => {
    // A collector is supposed to return unmeasurable results rather than throw. When
    // one breaks that contract, its bug must not deny the customer every other pillar.
    const broken: Collector = {
      surface: 'sql',
      name: 'broken',
      signals: ['sql:compute.clusters'],
      collect: () => Promise.reject(new Error('the warehouse went away')),
    };

    const result = await runScan({
      catalogue,
      registry,
      collectors: [broken],
      credentials: credentialsFor('service-principal', 'sp-1234'),
      scope: ACCOUNT_SCOPE,
      lookbackDays: 30,
      pillars: ['cost-optimization'],
    });

    expect(result.state).toBe('complete');
    const finding = findingFor(result.findings, 'CO-02-02');
    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toContain('the warehouse went away');
  });
});

describe('a collector whose input no control reads', () => {
  // Found on a live scan rather than here, which is why it is now here. The scan collects
  // only what something asks for, and the per-table pass depends on a table sample that
  // no control reads directly — so the sample was filtered out of the plan and the pass
  // reported that it had nothing to describe. Declaring the dependency is the fix; these
  // tests are what stop it regressing.
  const INPUT = 'sql:internal.input' as SignalId;
  const OUTPUT = 'sql:internal.output' as SignalId;

  function producing(signals: readonly SignalId[], seen: SignalId[], requires?: readonly SignalId[]): Collector {
    return {
      surface: 'sql',
      name: `producer-of-${signals.join(',')}`,
      signals,
      ...(requires != null ? { requires } : {}),
      collect: (ids) => {
        seen.push(...ids);
        // An empty array rather than an empty object, because the real cluster resolvers
        // read this signal as a list. The point of the test is the collection plan, but
        // it still has to hand the resolvers something they can read.
        return Promise.resolve(ids.map((id) => observed(id, [], 1, COMPLETE)));
      },
    };
  }

  it('collects the declared input even though nothing else asks for it', async () => {
    const seen: SignalId[] = [];
    const consumer = producing(['sql:compute.clusters'], seen, [INPUT]);

    await runScan({
      catalogue,
      registry,
      collectors: [producing([INPUT], seen), consumer],
      credentials: asUser,
      scope: workspaceScope('123'),
      lookbackDays: 30,
      pillars: ['cost-optimization'],
    });

    expect(seen).toContain(INPUT);
  });

  it('follows a chain of inputs rather than resolving only the first step', async () => {
    // A single resolution pass would satisfy the case above and silently drop the middle
    // of any two-step chain, so the loop runs until it settles.
    const seen: SignalId[] = [];

    await runScan({
      catalogue,
      registry,
      collectors: [
        producing([INPUT], seen),
        producing([OUTPUT], seen, [INPUT]),
        producing(['sql:compute.clusters'], seen, [OUTPUT]),
      ],
      credentials: asUser,
      scope: workspaceScope('123'),
      lookbackDays: 30,
      pillars: ['cost-optimization'],
    });

    expect(seen).toContain(OUTPUT);
    expect(seen).toContain(INPUT);
  });

  it('leaves the input uncollected when the collector needing it does not run', async () => {
    // The dependency is only real if its consumer is. Collecting an input for a collector
    // that no control needs would be a statement the scan paid for and nothing read.
    const seen: SignalId[] = [];

    await runScan({
      catalogue,
      registry,
      collectors: [producing([INPUT], seen), producing(['sql:unwanted'], seen, [INPUT])],
      credentials: asUser,
      scope: workspaceScope('123'),
      lookbackDays: 30,
      pillars: ['cost-optimization'],
    });

    expect(seen).not.toContain(INPUT);
  });
});

describe('how much of an interrupted collector is lost', () => {
  // What the checkpoint grain is worth, from the scan's side. A collector that reads several
  // statements in sequence used to have all of them written at once, at the end, so a kill part-way
  // through cost every statement already read. Reporting each as it settles is what makes the loss
  // one statement — and the reason this is checked here rather than trusted is that the saving is
  // invisible in a passing scan: it only shows up in a run that was killed.
  const FIRST = 'sql:compute.clusters' as SignalId;
  const SECOND = 'sql:compute.warehouses' as SignalId;

  /** A collector that reports each of its signals before returning them all. */
  function reporting(signals: readonly SignalId[], options: { readonly throwsAfter?: number } = {}): Collector {
    return {
      surface: 'sql',
      name: 'progressive',
      signals,
      collect: async (ids, context) => {
        const results: SignalResult[] = [];
        for (const [index, id] of ids.entries()) {
          if (options.throwsAfter === index) throw new Error('the warehouse went away');
          const result = observed(id, [], 1, COMPLETE);
          results.push(result);
          await context.settled?.(result);
        }
        return results;
      },
    };
  }

  function recorder() {
    const written: (readonly SignalResult[])[] = [];
    const writes = () => written.map((readings) => readings.map((reading) => reading.id));
    return {
      writes,
      written,
      checkpoint: (readings: readonly SignalResult[]) => {
        written.push(readings);
        return Promise.resolve();
      },
    };
  }

  function scanWith(collector: Collector, checkpoint: (readings: readonly SignalResult[]) => Promise<void>) {
    return runScan({
      catalogue,
      registry,
      collectors: [collector],
      credentials: asUser,
      scope: workspaceScope('123'),
      lookbackDays: 30,
      pillars: ['cost-optimization'],
      checkpoint,
    });
  }

  it('writes each reading a collector reports, rather than the collector all at once', async () => {
    const { writes, checkpoint } = recorder();

    await scanWith(reporting([FIRST, SECOND]), checkpoint);

    // Two writes of one, not one write of two. The distinction is the whole feature: a kill between
    // them leaves the first reading on the record.
    expect(writes()).toEqual([[FIRST], [SECOND]]);
  });

  it('does not write a reported reading again when the collector returns it', async () => {
    // Reporting says when a reading becomes durable; it does not excuse returning it, so every
    // reported reading also arrives in the returned array. Without reconciling the two, each one
    // would be written twice and the second write would be pure cost.
    const { writes, checkpoint } = recorder();

    await scanWith(reporting([FIRST, SECOND]), checkpoint);

    expect(writes().flat()).toEqual([FIRST, SECOND]);
  });

  it('still writes what a collector that broke part-way through settled as unmeasurable', async () => {
    // A collector that throws has its remaining signals marked unmeasurable with the fault named, and
    // those are as final as a reading: re-running a collector already known to fail buys the same
    // answer and another minute of load. So they are checkpointed too — and the signal it had already
    // reported is not written a second time.
    const { writes, written, checkpoint } = recorder();

    await scanWith(reporting([FIRST, SECOND], { throwsAfter: 1 }), checkpoint);

    expect(writes()).toEqual([[FIRST], [SECOND]]);
    // And the two writes are not the same kind of thing, which is what tells this case from the one
    // above: the reading it reported stands, and the one it never reached is settled as unreadable
    // with the fault named, so a retry does not run the broken collector again for the same answer.
    expect(written[0]?.[0]?.status).toBe('observed');
    expect(written[1]?.[0]?.status).toBe('unmeasurable');
    expect(written[1]?.[0]?.unmeasurableReason).toContain('the warehouse went away');
  });

  it('does not turn a store that refused one write into an estate it cannot read', async () => {
    // The failure this guards is a scan that lies. `settled` is awaited inside `collector.collect`, so
    // a throw from the store arrives at the catch that reads any throw as the collector breaking its
    // contract — which marks every signal it had not yet read as unmeasurable, with the store's error
    // as the reason, checkpoints those, and finishes. A momentary hiccup in Lakebase would reach a
    // customer as an estate the app cannot see, and the run would look successful.
    //
    // So a refused write degrades the grain and nothing else: the reading is still collected, still
    // returned, and still carried by the checkpoint at the end of the unit.
    const written: (readonly SignalResult[])[] = [];
    let refuse = true;

    const scan = await scanWith(reporting([FIRST, SECOND]), (readings) => {
      // Only the first per-signal write fails, which is what a hiccup looks like. A store broken for
      // longer fails the unit's own checkpoint, and that one is deliberately not caught.
      if (refuse && readings.length === 1) {
        refuse = false;
        return Promise.reject(new Error('the store went away'));
      }
      written.push(readings);
      return Promise.resolve();
    });

    // Both signals were read, and neither is unmeasurable. Before the fix the second was reported as
    // "The progressive collector failed: the store went away" — a statement that was never executed,
    // recorded as unreadable and skipped on resume.
    expect(scan.signals.map((reading) => [reading.id, reading.status])).toEqual([
      [FIRST, 'observed'],
      [SECOND, 'observed'],
    ]);

    // And the reading whose write was refused is not lost: it is not in `written` as a single, and it
    // arrives in the checkpoint at the end of the unit instead. That is the old grain, which is the
    // correct thing to fall back to.
    expect(written.map((readings) => readings.map((reading) => reading.id))).toEqual([[SECOND], [FIRST]]);
  });

  it('offers no way to report progress when there is nowhere to write it', async () => {
    // A collector must be able to tell the difference, because awaiting a write that goes nowhere is
    // a per-signal cost for no per-signal benefit. An interactive scan with no run record is exactly
    // that case.
    let offered: boolean | undefined;

    await runScan({
      catalogue,
      registry,
      collectors: [
        {
          surface: 'sql',
          name: 'asking',
          signals: [FIRST],
          collect: (ids, context) => {
            offered = context.settled != null;
            return Promise.resolve(ids.map((id) => observed(id, [], 1, COMPLETE)));
          },
        },
      ],
      credentials: asUser,
      scope: workspaceScope('123'),
      lookbackDays: 30,
      pillars: ['cost-optimization'],
    });

    expect(offered).toBe(false);
  });

  it('stamps a reported reading and shows it to the collector that reads it next', async () => {
    // A reading written but absent from the collection would be one the resumed attempt has and this
    // attempt does not — so a collector building on it would find it missing until the scan was killed
    // and restarted. Stamped for the same reason every other reading is: the identity on a reading has
    // to be the one the scan actually read as.
    const { checkpoint } = recorder();
    let seen: SignalResult | undefined;

    await runScan({
      catalogue,
      registry,
      collectors: [
        reporting([FIRST]),
        {
          surface: 'sql',
          name: 'downstream',
          signals: [SECOND],
          requires: [FIRST],
          collect: (ids, context) => {
            seen = context.collected.get(FIRST);
            return Promise.resolve(ids.map((id) => observed(id, [], 1, COMPLETE)));
          },
        },
      ],
      credentials: asUser,
      scope: workspaceScope('123'),
      lookbackDays: 30,
      pillars: ['cost-optimization'],
      checkpoint,
    });

    expect(seen?.provenance?.collector).toBe('progressive');
    expect(seen?.provenance?.actor).toBe('someone@example.com');
  });
});
