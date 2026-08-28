// What a finding rests on, and what stops it resting on more.
//
// The thing worth guarding here is that the standing can never be stronger than the limitations
// support. Every case below is a way a finding could read as better-established than it is — a
// sample presented as a complete reading, one workspace presented as an account, an import
// presented as an observation, an expired answer presented as an answer — and the assertion is that
// the limitation is named rather than absorbed.

import { describe, expect, it } from 'vitest';
import { confidenceOf } from './confidence.js';
import type { AttestedFact, Evidence, Finding, Outcome } from './finding.js';

function evidence(one: Partial<Evidence> = {}): Evidence {
  return {
    signal: 'unity_catalog_enabled' as Evidence['signal'],
    observed: 'Unity Catalog is attached',
    coverage: { mode: 'complete', reach: 'account' },
    collectedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...one,
  };
}

function finding(one: Partial<Finding> = {}): Finding {
  return {
    controlId: 'DG-01-01',
    pillarId: 'data-governance',
    principleId: 'dg-1',
    title: 'Unity Catalog governs the estate',
    outcome: 'pass',
    severity: 'high',
    coverage: { mode: 'complete', reach: 'account' },
    evidence: [evidence()],
    ...one,
  };
}

function answer(one: Partial<AttestedFact> = {}): AttestedFact {
  return {
    bearing: 'outcome',
    by: 'Dana Okafor',
    at: new Date('2026-06-01T00:00:00.000Z'),
    statement: 'Reviewed in the quarterly platform meeting.',
    owner: 'Platform Engineering',
    reviewBy: new Date('2026-12-01T00:00:00.000Z'),
    ...one,
  };
}

describe('how firmly a finding is established', () => {
  it('calls a complete account-wide reading established, and says nothing qualifies it', () => {
    const confidence = confidenceOf(finding());

    expect(confidence.standing).toBe('established');
    expect(confidence.limitations).toEqual([]);
    expect(confidence.because).toContain('Nothing qualifies it');
  });

  it('always says what the standing rests on, including when nothing limits it', () => {
    // An empty space where the strong case goes teaches a reader that the paragraph means bad news.
    for (const outcome of ['pass', 'fail', 'partial', 'satisfied-by-architecture'] as Outcome[]) {
      expect(confidenceOf(finding({ outcome })).because).not.toBe('');
    }
  });

  it('names the sample rather than presenting it as a reading of everything', () => {
    const confidence = confidenceOf(
      finding({ coverage: { mode: 'sampled', reach: 'account', examined: 20, population: 400 } })
    );

    expect(confidence.standing).toBe('qualified');
    expect(confidence.limitations.map((one) => one.kind)).toEqual(['sampled']);
    expect(confidence.limitations[0].says).toContain('20 of 400');
  });

  it('carries the sampling basis through, since it is what a reader judges the sample by', () => {
    const confidence = confidenceOf(
      finding({
        coverage: { mode: 'sampled', reach: 'account', examined: 20, population: 400, basis: 'The 20 busiest by DBU.' },
      })
    );

    expect(confidence.limitations[0].says).toContain('The 20 busiest by DBU.');
  });

  it('says a workspace-scoped reading says nothing about the other workspaces', () => {
    const confidence = confidenceOf(finding({ coverage: { mode: 'complete', reach: 'workspace' } }));

    expect(confidence.limitations.map((one) => one.kind)).toEqual(['reach']);
    expect(confidence.limitations[0].says).toContain('says nothing about the others');
  });

  it('treats an undeclared reach as this app\u2019s gap rather than the estate\u2019s', () => {
    const confidence = confidenceOf(finding({ coverage: { mode: 'complete' } }));

    expect(confidence.limitations[0].kind).toBe('reach');
    expect(confidence.limitations[0].says).toContain('gap in this app');
  });

  it('says an imported reading describes the estate as it stood, and cannot be re-read', () => {
    const confidence = confidenceOf(
      finding({
        evidence: [evidence({ evidenceClass: 'admin-collected', collectedAt: new Date('2026-07-04T00:00:00.000Z') })],
      })
    );

    expect(confidence.standing).toBe('qualified');
    expect(confidence.limitations.map((one) => one.kind)).toEqual(['imported']);
    expect(confidence.limitations[0].says).toContain('2026-07-04');
  });

  it('dates an import by its stalest bearing part, not its freshest', () => {
    const confidence = confidenceOf(
      finding({
        evidence: [
          evidence({ evidenceClass: 'admin-collected', collectedAt: new Date('2026-07-20T00:00:00.000Z') }),
          evidence({ evidenceClass: 'admin-collected', collectedAt: new Date('2026-07-04T00:00:00.000Z') }),
        ],
      })
    );

    expect(confidence.limitations[0].says).toContain('2026-07-04');
  });

  it('ignores an imported locator beside an observation that decided the outcome', () => {
    // A complete observation located by an imported list is still an observation.
    const confidence = confidenceOf(
      finding({
        evidence: [evidence(), evidence({ evidenceClass: 'admin-collected', bearing: 'detail' })],
      })
    );

    expect(confidence.standing).toBe('established');
  });

  it('calls an outcome resting on an answer stated, and names who is accountable', () => {
    const confidence = confidenceOf(finding({ attested: answer() }));

    expect(confidence.standing).toBe('stated');
    expect(confidence.limitations[0].kind).toBe('attested');
    expect(confidence.limitations[0].says).toContain('Dana Okafor');
    expect(confidence.limitations[0].says).toContain('Platform Engineering');
  });

  it('leaves an answer recorded beside a measurement out of the standing', () => {
    // `bearing: 'record'` means the app decided this itself and somebody's note sits next to it.
    const confidence = confidenceOf(finding({ attested: answer({ bearing: 'record' }) }));

    expect(confidence.standing).toBe('established');
    expect(confidence.limitations).toEqual([]);
  });

  it('warns that an answer is about to stop counting', () => {
    const confidence = confidenceOf(finding({ attested: answer({ reviewBy: new Date('2026-08-20T00:00:00.000Z') }) }), {
      asOf: new Date('2026-08-03T00:00:00.000Z'),
    });

    expect(confidence.limitations.map((one) => one.kind)).toEqual(['attested', 'expiring']);
    expect(confidence.limitations[1].says).toContain('17 days');
  });

  it('says an answer past its review date no longer counts', () => {
    const confidence = confidenceOf(finding({ attested: answer({ reviewBy: new Date('2026-07-20T00:00:00.000Z') }) }), {
      asOf: new Date('2026-08-03T00:00:00.000Z'),
    });

    expect(confidence.limitations[1].says).toContain('no longer counts');
  });

  it('does not claim an answer is expiring when the run did not say when it ran', () => {
    const confidence = confidenceOf(finding({ attested: answer({ reviewBy: new Date('2026-08-04T00:00:00.000Z') }) }));

    expect(confidence.limitations.map((one) => one.kind)).toEqual(['attested']);
  });

  it('says a carried-forward finding was not measured by this run', () => {
    const confidence = confidenceOf(finding(), { carriedForward: true });

    expect(confidence.standing).toBe('qualified');
    expect(confidence.limitations.map((one) => one.kind)).toEqual(['carried']);
  });

  it('compounds limitations rather than collapsing them to the worst', () => {
    const confidence = confidenceOf(
      finding({
        coverage: { mode: 'sampled', reach: 'workspace', examined: 5, population: 50 },
        evidence: [evidence({ evidenceClass: 'admin-collected' })],
      }),
      { carriedForward: true }
    );

    expect(confidence.limitations.map((one) => one.kind)).toEqual(['sampled', 'reach', 'imported', 'carried']);
    expect(confidence.because).toContain('4 limits');
  });

  it('reports no confidence for a finding that established nothing', () => {
    // `unmeasured` already says which of the five kinds of gap it is, which is the question here.
    const confidence = confidenceOf(
      finding({ outcome: 'unmeasurable', unmeasured: 'attestation', coverage: { mode: 'complete' }, evidence: [] })
    );

    expect(confidence.standing).toBe('none');
    expect(confidence.limitations).toEqual([]);
  });

  it('is a reading of the finding and never disagrees with the standing it reports', () => {
    // The standing is a function of the list, so no combination can assert a certainty the
    // limitations do not support.
    const cases = [
      finding(),
      finding({ coverage: { mode: 'sampled', reach: 'account', examined: 1, population: 2 } }),
      finding({ attested: answer() }),
      finding({ coverage: { mode: 'complete', reach: 'workspace' }, attested: answer() }),
    ];

    for (const one of cases) {
      const { standing, limitations } = confidenceOf(one);
      if (standing === 'established') expect(limitations).toEqual([]);
      else expect(limitations.length).toBeGreaterThan(0);
    }
  });
});
