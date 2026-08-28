// Rerunning one pillar, asserted on the six it must not destroy.
//
// The bug this file exists to prevent is not subtle in effect and is very easy to write: a
// targeted rerun that saves only its own pillar, so the customer reruns Security and watches
// their overall score and six pillars disappear. The tests below are therefore mostly about
// what survives a rerun, and about the cases where survival would be a lie.

import { describe, expect, it } from 'vitest';
import { CollectionScheduler } from './scheduler.js';
import { carryForward } from './carry-forward.js';
import { exclusionKeys } from './identity.js';
import type { Scan } from './scan.js';
import type { Finding } from '../resolve/finding.js';
import type { ApplicabilityDecision } from '../apply/applicability.js';

const NO_ALIASES = () => undefined;

const DAY = 24 * 60 * 60 * 1000;
function decisionFor(controlId: string, lever: ApplicabilityDecision['lever']): ApplicabilityDecision {
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

function finding(controlId: string, pillarId: string, outcome: Finding['outcome'] = 'pass'): Finding {
  return {
    controlId,
    pillarId,
    principleId: controlId.slice(0, 5),
    title: controlId,
    outcome,
    severity: 'medium',
    coverage: { mode: 'complete' },
    evidence: [],
  };
}

function scan(overrides: Partial<Scan> = {}): Scan {
  const finishedAt = new Date('2026-08-01T10:00:00.000Z');
  const id = 'scan-1';
  return {
    id,
    startedAt: new Date('2026-08-01T09:59:00.000Z'),
    finishedAt,
    state: 'complete',
    stamp: {
      publicMethodology: { publicVersion: 1, manifestDigest: 'sha256:manifest', state: 'released' },
      catalogueVersion: '3',
      catalogueFingerprint: 'abc',
      executionMode: 'on-behalf-of-user',
      actor: 'someone@example.com',
      scope: { description: 'the account' },
      lookbackDays: 30,
      /*
       * Every fixture here used to omit the identity, and `identityBarriers` returns early when either
       * side is absent — so no test in this file could reach the axes it compares, including the
       * exclusion axis added later, which refused a merge for the first estate that used the feature.
       * Present by default now, identical on both sides, so a test that wants a barrier has to ask.
       */
      identity: {
        build: { id: '0.1.0+abcdef123456' },
        methodology: { id: 'sha256:aaa' },
        record: { id: 'codec-2' },
        sources: ['sql'],
        exclusions: [],
      },
    },
    score: {
      pillars: [],
      counts: { pass: 0, fail: 0, partial: 0, unmeasurable: 0, 'not-applicable': 0, 'satisfied-by-architecture': 0 },
      scoredControls: 0,
      composition: { observed: 0, 'admin-collected': 0, attested: 0 },
      totalControls: 0,
    },
    findings: [],
    signals: [],
    estate: { assessed: [{ id: 'w1', name: 'prod', status: 'RUNNING' }], excluded: [] },
    measurement: [],
    footprint: new CollectionScheduler().footprint(),
    spend: [],
    ...overrides,
  };
}

/** A full scan of two pillars, a week old. */
const previous = scan({
  id: 'older',
  finishedAt: new Date('2026-07-25T10:00:00.000Z'),
  findings: [finding('CO-01-01', 'cost-optimization'), finding('SCP-01-01', 'security-compliance-and-privacy', 'fail')],
  measurement: [
    {
      pillarId: 'cost-optimization',
      scanId: 'older',
      measuredAt: new Date('2026-07-25T10:00:00.000Z'),
      actor: 'someone@example.com',
      carriedForward: false,
    },
    {
      pillarId: 'security-compliance-and-privacy',
      scanId: 'older',
      measuredAt: new Date('2026-07-25T10:00:00.000Z'),
      actor: 'someone@example.com',
      carriedForward: false,
    },
  ],
  signals: [
    { id: 'sql:cost.tags', status: 'observed', coverage: { mode: 'complete' }, collectedAt: new Date(), durationMs: 1 },
  ],
});

/** A rerun of security alone. */
const fresh = scan({
  requestedPillars: ['security-compliance-and-privacy'],
  findings: [finding('SCP-01-01', 'security-compliance-and-privacy', 'pass')],
  measurement: [
    {
      pillarId: 'security-compliance-and-privacy',
      scanId: 'scan-1',
      measuredAt: new Date('2026-08-01T10:00:00.000Z'),
      actor: 'someone@example.com',
      carriedForward: false,
    },
  ],
});

describe('a targeted rerun', () => {
  const merged = carryForward({
    fresh,
    previous,
    measuredPillars: ['security-compliance-and-privacy'],
    aliasGroupOf: NO_ALIASES,
  });

  it('keeps the pillars it did not measure', () => {
    expect(merged.findings.map((f) => f.controlId).sort()).toEqual(['CO-01-01', 'SCP-01-01']);
  });

  it('takes the fresh result for the pillar it did measure, not the stale one', () => {
    const security = merged.findings.find((f) => f.pillarId === 'security-compliance-and-privacy');
    expect(security?.outcome).toBe('pass');
  });

  it('never presents a carried pillar as freshly measured', () => {
    const cost = merged.measurement.find((m) => m.pillarId === 'cost-optimization');
    const security = merged.measurement.find((m) => m.pillarId === 'security-compliance-and-privacy');

    expect(cost).toMatchObject({ carriedForward: true, scanId: 'older' });
    expect(cost?.measuredAt.toISOString()).toBe('2026-07-25T10:00:00.000Z');
    expect(security).toMatchObject({ carriedForward: false, scanId: 'scan-1' });
  });

  it('rescores over both halves, so the overall covers the whole assessment', () => {
    // Scoring only the fresh half is the same bug as saving only the fresh half, one layer
    // down: the findings would be right and the number on the front page would not.
    expect(merged.score.totalControls).toBe(2);
  });

  it('keeps the evidence behind the carried findings', () => {
    expect(merged.signals.map((signal) => signal.id)).toContain('sql:cost.tags');
  });

  it('reports its own cost, not the previous run\u2019s', () => {
    expect(merged.footprint).toBe(fresh.footprint);
    expect(merged.spend).toBe(fresh.spend);
  });
});

describe('a targeted rerun with nothing comparable to carry forward', () => {
  it('says there is no earlier scan rather than showing an empty assessment', () => {
    const merged = carryForward({
      fresh,
      previous: undefined,
      measuredPillars: ['security-compliance-and-privacy'],
      aliasGroupOf: NO_ALIASES,
    });

    expect(merged.findings).toHaveLength(1);
    expect(merged.notCarried).toContain('no earlier scan');
  });

  it('keeps the untouched pillars when a decision stands outside the pillar it reran', () => {
    /*
     * The defect, as the customer met it. A targeted run records the exclusions its *own* findings
     * carry — security's — while the previous full scan recorded them across the estate. Compared as
     * sets those differ by every decision outside the rerun, so the comparability check refused and
     * the six pillars nobody asked to rerun were dropped: one applicability decision anywhere was
     * enough to break every later targeted rerun, through the check that exists to protect them.
     */
    const merged = carryForward({
      fresh: {
        ...fresh,
        stamp: { ...fresh.stamp, identity: { ...fresh.stamp.identity!, exclusions: ['SCP-02-01'] } },
      },
      previous: {
        ...previous,
        stamp: { ...previous.stamp, identity: { ...previous.stamp.identity!, exclusions: ['SCP-02-01', 'CO-01-09'] } },
      },
      measuredPillars: ['security-compliance-and-privacy'],
      aliasGroupOf: NO_ALIASES,
    });

    expect(merged.notCarried).toBeUndefined();
    expect(merged.findings.map((one) => one.controlId).sort()).toEqual(['CO-01-01', 'SCP-01-01']);
  });

  it('keeps them when the same decision was switched to the other lever since', () => {
    /*
     * The lever joined the exclusion entries so a *trend* would refuse across a switch, since the two
     * levers give the same total a different range. The merge is a different act — it re-applies the
     * current decisions over the combined set and scores that once — so it has to stay permitted, and it
     * does because the lever went onto the axis the merge already asks to be excused rather than into
     * `refusals`. Widening the field without checking this would have cost the customer their pillars
     * again, for a decision the merge would have applied anyway.
     */
    const merged = carryForward({
      fresh: {
        ...fresh,
        stamp: {
          ...fresh.stamp,
          identity: { ...fresh.stamp.identity!, exclusions: exclusionKeys([{ controlId: 'SCP-02-01', lever: 'disabled' }]) },
        },
      },
      previous: {
        ...previous,
        stamp: {
          ...previous.stamp,
          identity: {
            ...previous.stamp.identity!,
            exclusions: exclusionKeys([{ controlId: 'SCP-02-01', lever: 'not-applicable' }]),
          },
        },
      },
      measuredPillars: ['security-compliance-and-privacy'],
      aliasGroupOf: NO_ALIASES,
    });

    expect(merged.notCarried).toBeUndefined();
    expect(merged.findings.map((one) => one.controlId).sort()).toEqual(['CO-01-01', 'SCP-01-01']);
  });

  it('still refuses a rerun that is not comparable for a reason the merge cannot repair', () => {
    // Permitting the exclusion axis drops one barrier. A changed scoring method still refuses, and the
    // reason still reaches the reader — otherwise the fix above would have turned the guard off.
    const merged = carryForward({
      fresh: {
        ...fresh,
        stamp: {
          ...fresh.stamp,
          identity: { ...fresh.stamp.identity!, methodology: { id: 'sha256:changed' }, exclusions: ['SCP-02-01'] },
        },
      },
      previous,
      measuredPillars: ['security-compliance-and-privacy'],
      aliasGroupOf: NO_ALIASES,
    });

    expect(merged.notCarried).toContain('scoring method changed');
    expect(merged.findings.map((one) => one.controlId)).toEqual(['SCP-01-01']);
  });

  it('refuses to combine scans assessed against different catalogues, and says which', () => {
    const merged = carryForward({
      fresh,
      previous: scan({ ...previous, stamp: { ...previous.stamp, catalogueFingerprint: 'moved', catalogueVersion: '2' } }),
      measuredPillars: ['security-compliance-and-privacy'],
      aliasGroupOf: NO_ALIASES,
    });

    // Combining them would produce a scan whose seven pillars answered two different sets of
    // questions, and whose overall was an average of both.
    expect(merged.findings.map((f) => f.controlId)).toEqual(['SCP-01-01']);
    expect(merged.notCarried).toContain('different catalogue versions');
  });

  it('refuses to combine scans run by different identities', () => {
    const merged = carryForward({
      fresh,
      previous: scan({ ...previous, stamp: { ...previous.stamp, actor: 'someone-else@example.com' } }),
      measuredPillars: ['security-compliance-and-privacy'],
      aliasGroupOf: NO_ALIASES,
    });

    expect(merged.notCarried).toContain('different identities');
  });
});

describe('a targeted rerun with the customer’s applicability decisions', () => {
  it('applies a decision to a carried pillar and scores the merge with it out of the denominator', () => {
    // CO-01-01 was measured a week ago and is carried forward; a decision recorded since takes it out
    // of the score on this run too, without the pillar having been re-measured.
    const merged = carryForward({
      fresh,
      previous,
      measuredPillars: ['security-compliance-and-privacy'],
      aliasGroupOf: NO_ALIASES,
      decisions: new Map([['CO-01-01', [decisionFor('CO-01-01', 'not-applicable')]]]),
    });

    expect(merged.findings.find((f) => f.controlId === 'CO-01-01')?.outcome).toBe('not-applicable');
    expect(merged.score.exposure?.excluded.map((e) => e.controlId)).toContain('CO-01-01');
  });

  it('carries no exposure when no decision is in force', () => {
    const merged = carryForward({
      fresh,
      previous,
      measuredPillars: ['security-compliance-and-privacy'],
      aliasGroupOf: NO_ALIASES,
    });

    expect(merged.score.exposure).toBeUndefined();
  });

  /*
   * A scan stores its findings already rewritten, so a carried finding for an excluded requirement
   * reads `not-applicable` with the raw reading gone. Re-applying finds no decision once it is revoked
   * and leaves the finding alone — which is right, since the reading it would revert to was not
   * collected. What used to go wrong is the exposure: the requirement stayed out of the score while the
   * exposure and the identity described a set that did not include it.
   */
  it('says a carried requirement is out of the score when the decision behind it has gone', () => {
    const merged = carryForward({
      fresh,
      previous: excludedPreviously('CO-01-01'),
      measuredPillars: ['security-compliance-and-privacy'],
      aliasGroupOf: NO_ALIASES,
      decisions: new Map(),
    });

    expect(merged.findings.find((one) => one.controlId === 'CO-01-01')?.outcome).toBe('not-applicable');
    expect(merged.score.exposure?.excluded.map((one) => one.controlId)).toEqual(['CO-01-01']);
    // With the lever, so a later comparison can see one switched for the other. See identity.ts.
    expect(merged.stamp.identity?.exclusions).toEqual(['CO-01-01:not-applicable']);
  });

  it('names a requirement whose decision still stands once, not twice', () => {
    const merged = carryForward({
      fresh,
      previous: excludedPreviously('CO-01-01'),
      measuredPillars: ['security-compliance-and-privacy'],
      aliasGroupOf: NO_ALIASES,
      decisions: new Map([['CO-01-01', [decisionFor('CO-01-01', 'not-applicable')]]]),
    });

    expect(merged.score.exposure?.excluded.map((one) => one.controlId)).toEqual(['CO-01-01']);
  });

  it('carries nothing forward for a requirement the previous run scored', () => {
    // A stale exposure entry against a finding that reads `pass` would overstate what was taken out.
    const stale = excludedPreviously('CO-01-01');
    const merged = carryForward({
      fresh,
      previous: { ...stale, findings: [finding('CO-01-01', 'cost-optimization', 'pass')] },
      measuredPillars: ['security-compliance-and-privacy'],
      aliasGroupOf: NO_ALIASES,
    });

    expect(merged.score.exposure).toBeUndefined();
  });
});

/** The previous scan as it is stored once a decision has been applied to it: rewritten, with the exposure. */
function excludedPreviously(controlId: string): Scan {
  const decision = decisionFor(controlId, 'not-applicable');
  return {
    ...previous,
    findings: previous.findings.map((one) =>
      one.controlId === controlId ? { ...one, outcome: 'not-applicable' as const, outcomeReason: decision.reason } : one
    ),
    score: {
      ...previous.score,
      exposure: {
        excluded: [
          {
            controlId,
            lever: decision.lever,
            owner: decision.owner,
            reason: decision.reason,
            decisionId: decision.id,
          },
        ],
        lapsed: [],
      },
    },
  };
}

describe('what a merged scan claims about itself', () => {
  it('is partial when the run it carried from was partial', () => {
    const merged = carryForward({
      fresh,
      previous: scan({ ...previous, state: 'partial', incompleteReason: 'It stopped at the query budget.' }),
      measuredPillars: ['security-compliance-and-privacy'],
      aliasGroupOf: NO_ALIASES,
    });

    // A complete rerun over pillars carried from an incomplete scan is not a complete
    // assessment, and letting it claim to be would launder every earlier gap.
    expect(merged.state).toBe('partial');
    expect(merged.incompleteReason).toContain('It stopped at the query budget.');
  });

  it('carries the workspace list forward when the rerun touched no system table', () => {
    // Security is entirely REST today, so a security-only rerun collects no workspace
    // directory. Reporting the estate as undetermined would drop the workspace names from
    // the overview for a reason that has nothing to do with the estate.
    const merged = carryForward({
      fresh: scan({ ...fresh, estate: { assessed: [], excluded: [], undeterminedReason: 'no directory signal' } }),
      previous,
      measuredPillars: ['security-compliance-and-privacy'],
      aliasGroupOf: NO_ALIASES,
    });

    expect(merged.estate.assessed.map((workspace) => workspace.id)).toEqual(['w1']);
    expect(merged.stamp.assessedWorkspaces).toEqual(['w1']);
  });

  it('leaves a full scan untouched, with nothing to explain', () => {
    const full = scan({ findings: [finding('CO-01-01', 'cost-optimization')] });

    const merged = carryForward({ fresh: full, previous, measuredPillars: [], aliasGroupOf: NO_ALIASES });

    expect(merged).toBe(full);
    expect(merged.notCarried).toBeUndefined();
  });
});
