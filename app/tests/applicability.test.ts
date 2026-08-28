// Tests for the behaviour that matters most: a good architectural decision must
// never read as a failure, and a control must never leave the denominator without a
// reason the customer can read.

import { describe, expect, it } from 'vitest';

import { COMPLETE, observed, unmeasurable, type SignalId, type SignalResult } from '../server/collect/signal.js';
import { resolveApplicability, type Precondition } from '../server/resolve/applicability.js';
import { comparabilityBarriers, narrowest, type ScanStamp } from '../server/resolve/finding.js';
import { resolveControl, ResolverRegistry, type ControlResolver } from '../server/resolve/resolver.js';

function signals(entries: Record<string, SignalResult>): Map<SignalId, SignalResult> {
  return new Map(Object.entries(entries) as [SignalId, SignalResult][]);
}

const SERVERLESS_ONLY: Precondition = {
  signal: 'sql:compute.profile',
  operator: 'eq',
  value: 'serverless-only',
  outcome: 'satisfied-by-architecture',
  reason:
    'This estate runs serverless compute exclusively. Serverless enforces the isolation this control asks a ' +
    'cluster policy to provide, so the control is met by the platform rather than by configuration.',
  scope: 'estate',
};

describe('applicability', () => {
  it('credits a serverless estate rather than scoring it down', () => {
    const result = resolveApplicability(
      [SERVERLESS_ONLY],
      signals({ 'sql:compute.profile': observed('sql:compute.profile', 'serverless-only', 12) })
    );

    expect(result.kind).toBe('satisfied-by-architecture');
    if (result.kind !== 'satisfied-by-architecture') throw new Error('expected credit');
    expect(result.reason).toContain('serverless');
  });

  it('leaves the control applicable when the precondition does not match', () => {
    const result = resolveApplicability(
      [SERVERLESS_ONLY],
      signals({ 'sql:compute.profile': observed('sql:compute.profile', 'mixed', 12) })
    );
    expect(result.kind).toBe('applicable');
  });

  it('reads the summary field when the signal value is structured', () => {
    const result = resolveApplicability(
      [SERVERLESS_ONLY],
      signals({
        'sql:compute.profile': observed(
          'sql:compute.profile',
          { summary: 'serverless-only', clusters: 0, warehouses: 3 },
          12
        ),
      })
    );
    expect(result.kind).toBe('satisfied-by-architecture');
  });

  it('stays applicable when the precondition signal is missing', () => {
    // Not knowing whether a control applies is not a reason to drop it from the
    // denominator. The alternative silently shrinks the denominator whenever
    // collection fails, which improves the score for the wrong reason.
    const result = resolveApplicability([SERVERLESS_ONLY], signals({}));
    expect(result.kind).toBe('undetermined');
  });

  it('stays applicable when the precondition signal is unmeasurable, and carries the reason forward', () => {
    const result = resolveApplicability(
      [SERVERLESS_ONLY],
      signals({
        'sql:compute.profile': unmeasurable('sql:compute.profile', 'No SELECT on system.billing.usage.'),
      })
    );

    expect(result.kind).toBe('undetermined');
    if (result.kind !== 'undetermined') throw new Error('expected undetermined');
    expect(result.detail).toContain('system.billing.usage');
  });

  it('refuses a segment-scoped precondition rather than treating it as estate-wide', () => {
    // Estate scope on a mixed estate answers "is any of this serverless?" when the
    // question was "which parts". One serverless job would excuse the entire classic
    // remainder from cluster-policy controls.
    const result = resolveApplicability(
      [{ ...SERVERLESS_ONLY, scope: 'segment' }],
      signals({ 'sql:compute.profile': observed('sql:compute.profile', 'serverless-only', 12) })
    );
    expect(result.kind).toBe('needs-segments');
  });

  it('defaults to segment scope when none is declared', () => {
    const { scope: _scope, ...withoutScope } = SERVERLESS_ONLY;
    const result = resolveApplicability(
      [withoutScope],
      signals({ 'sql:compute.profile': observed('sql:compute.profile', 'serverless-only', 12) })
    );
    expect(result.kind).toBe('needs-segments');
  });

  it('prefers credit over exclusion when both preconditions match', () => {
    // Excluding a control the platform genuinely satisfies loses the customer the
    // evidence that their architecture earned the pass.
    const exclusion: Precondition = {
      signal: 'sql:compute.profile',
      operator: 'eq',
      value: 'serverless-only',
      outcome: 'not-applicable',
      reason: 'There are no classic clusters in this estate for a cluster policy to govern.',
      scope: 'estate',
    };

    const result = resolveApplicability(
      [exclusion, SERVERLESS_ONLY],
      signals({ 'sql:compute.profile': observed('sql:compute.profile', 'serverless-only', 12) })
    );
    expect(result.kind).toBe('satisfied-by-architecture');
  });

  it('refuses an ordering comparison against a non-number instead of guessing', () => {
    const result = resolveApplicability(
      [{ ...SERVERLESS_ONLY, operator: 'gt', value: 5 }],
      signals({ 'sql:compute.profile': observed('sql:compute.profile', 'serverless-only', 12) })
    );
    expect(result.kind).toBe('undetermined');
  });
});

describe('control resolution', () => {
  const spec = {
    id: 'SCP-01-18',
    pillarId: 'security-compliance-and-privacy',
    principleId: 'SCP-01',
    title: 'Use cluster policies to constrain compute configuration',
    severity: 'high' as const,
    preconditions: [SERVERLESS_ONLY],
  };

  const failing: ControlResolver = {
    controls: [spec.id],
    requires: ['rest:cluster_policies.list'],
    resolve: () => ({
      outcome: 'fail',
      evidence: [
        {
          signal: 'rest:cluster_policies.list',
          observed: 'No cluster policies are defined.',
          expected: 'At least one policy constraining compute configuration.',
          coverage: COMPLETE,
          collectedAt: new Date(),
        },
      ],
    }),
  };

  it('does not evaluate a control the architecture already satisfies', () => {
    // The resolver would return a failure here, because there genuinely are no
    // cluster policies. Running it anyway is how "100% serverless" turns into three
    // findings, which is the single most damaging bug this app could ship.
    const finding = resolveControl(
      spec,
      signals({ 'sql:compute.profile': observed('sql:compute.profile', 'serverless-only', 12) }),
      failing
    );

    expect(finding.outcome).toBe('satisfied-by-architecture');
    expect(finding.evidence).toHaveLength(0);
    expect(finding.outcomeReason).toContain('Serverless enforces the isolation');
  });

  it('evaluates it on a mixed estate', () => {
    const finding = resolveControl(
      spec,
      signals({ 'sql:compute.profile': observed('sql:compute.profile', 'mixed', 12) }),
      failing
    );

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence).toHaveLength(1);
  });

  it('says so on the finding when per-segment applicability was not resolved', () => {
    const finding = resolveControl(
      { ...spec, preconditions: [{ ...SERVERLESS_ONLY, scope: 'segment' }] },
      signals({ 'sql:compute.profile': observed('sql:compute.profile', 'serverless-only', 12) }),
      failing
    );

    expect(finding.outcome).toBe('fail');
    expect(finding.outcomeReason).toContain('not yet implemented');
  });

  it('reports unmeasurable, not fail, when no resolver is implemented', () => {
    const finding = resolveControl({ ...spec, preconditions: [] }, signals({}), undefined);
    expect(finding.outcome).toBe('unmeasurable');
  });
});

describe('resolver registry', () => {
  it('refuses two resolvers for one control', () => {
    const registry = new ResolverRegistry();
    const one: ControlResolver = {
      controls: ['CO-01-01'],
      requires: [],
      resolve: () => ({ outcome: 'pass', evidence: [] }),
    };
    const two: ControlResolver = {
      controls: ['CO-01-01'],
      requires: [],
      resolve: () => ({ outcome: 'fail', evidence: [] }),
    };

    registry.register(one);
    // Last-one-wins would make the outcome depend on registration order, and the
    // difference would not show up until the two disagreed.
    expect(() => registry.register(two)).toThrow(/already has a resolver/);
  });

  it('deduplicates the signals needed for a set of controls', () => {
    // The reason the layer exists: one observation about autoscaling answers a cost
    // control and a reliability control, and should be collected once.
    const registry = new ResolverRegistry();
    registry.register({
      controls: ['CO-02-01', 'REL-03-01'],
      requires: ['sql:compute.autoscaling'],
      resolve: () => ({ outcome: 'pass', evidence: [] }),
    });
    registry.register({
      controls: ['CO-02-02'],
      requires: ['sql:compute.autoscaling', 'sql:compute.auto_termination'],
      resolve: () => ({ outcome: 'pass', evidence: [] }),
    });

    expect(registry.signalsFor(['CO-02-01', 'REL-03-01', 'CO-02-02']).sort()).toEqual([
      'sql:compute.auto_termination',
      'sql:compute.autoscaling',
    ]);
  });
});

describe('coverage and comparability', () => {
  it('takes the narrowest coverage when a control rests on mixed evidence', () => {
    // The weakest evidence governs what may be claimed.
    expect(
      narrowest([
        COMPLETE,
        { mode: 'sampled', examined: 100, population: 10_000 },
        { mode: 'sampled', examined: 500, population: 10_000 },
      ])
    ).toEqual({ mode: 'sampled', examined: 100, population: 10_000 });

    expect(narrowest([COMPLETE, COMPLETE])).toEqual({ mode: 'complete' });
  });

  it('refuses to compare scans that saw the estate through different identities', () => {
    const base: ScanStamp = {
      catalogueVersion: '1.0.0',
      catalogueFingerprint: 'abc123',
      executionMode: 'on-behalf-of-user',
      actor: 'admin@example.com',
      completeness: 'complete',
      anySampled: false,
    };

    expect(comparabilityBarriers(base, base)).toEqual([]);

    const scheduled: ScanStamp = { ...base, executionMode: 'service-principal', actor: 'sp-1234' };
    expect(comparabilityBarriers(base, scheduled)[0]).toContain('do not see the same estate');
  });

  it('refuses to compare across a catalogue change', () => {
    const a: ScanStamp = {
      catalogueVersion: '1.0.0',
      catalogueFingerprint: 'abc123',
      executionMode: 'on-behalf-of-user',
      actor: 'admin@example.com',
      completeness: 'complete',
      anySampled: false,
    };
    const b: ScanStamp = { ...a, catalogueVersion: '1.1.0', catalogueFingerprint: 'def456' };

    expect(comparabilityBarriers(a, b)[0]).toContain('set of scored requirements changed');
  });

  it('flags a partial scan as not comparable', () => {
    const a: ScanStamp = {
      catalogueVersion: '1.0.0',
      catalogueFingerprint: 'abc123',
      executionMode: 'on-behalf-of-user',
      actor: 'admin@example.com',
      completeness: 'complete',
      anySampled: false,
    };
    expect(comparabilityBarriers(a, { ...a, completeness: 'partial' })[0]).toContain('stopped early');
  });
});
