import { describe, expect, it } from 'vitest';

import { customerJourneyEvidenceCommit, historicalEvidence, journeyProblems } from './customer-journey.mjs';

const identity = {
  id: 'definition-1',
  version: 2,
  fingerprint: 'sha256:definition-1-v2',
};

function scenario(mode: 'allConfirmed' | 'onePillarSkipped') {
  const suffix = mode === 'allConfirmed' ? 'all' : 'skip';
  const runId = `run-${suffix}`;
  const reviewId = `review-${suffix}`;
  const resultId = `result-${suffix}`;
  const actionId = `action-${suffix}`;
  const foundationFingerprint = `sha256:foundation-${suffix}`;
  return {
    runId,
    reviewId,
    resultId,
    definition: identity,
    pillarDecisions: { confirmed: mode === 'allConfirmed' ? 7 : 6, skipped: mode === 'allConfirmed' ? [] : ['cost'] },
    report: { path: `/report/${resultId}`, resultId },
    export: { path: `/api/results/${resultId}/export.json`, finalResultId: resultId },
    improvement: {
      planId: `plan-${suffix}`,
      actionId,
      raisedFrom: runId,
      definitionId: identity.id,
      definitionVersion: identity.version,
    },
    foundation: { definitionId: identity.id, version: 1, fingerprint: foundationFingerprint },
    month: {
      month: '2026-08',
      runId,
      reviewId,
      finalResultId: resultId,
      definitionId: identity.id,
      definitionVersion: identity.version,
    },
    restartRead: {
      runId,
      reviewId,
      resultId,
      actionId,
      foundationFingerprint,
    },
  };
}

function fixture() {
  const recording = {
    sourceCommit: 'abc123',
    deployment: { id: 'deployment-1', origin: 'https://app.example' },
    browser: { product: 'Chrome', version: '140.0.0.0' },
    scenarios: {
      allConfirmed: scenario('allConfirmed'),
      onePillarSkipped: scenario('onePillarSkipped'),
      storeFailure: {
        currentResult: { status: 503, code: 'current-result-unreadable', scoreExposed: false },
        monthPreview: { status: 503, code: 'month-preview-unreadable', publicationEnabled: false },
      },
    },
  };
  const served = {
    served: { deploymentId: 'deployment-1', origin: 'https://app.example' },
    driven: { deploymentId: 'deployment-1', origin: 'https://app.example', drove: 37, declared: 37, failures: 0 },
  };
  const live = {
    commit: 'abc123',
    lifecycle: {
      restarted: true,
      definition: identity,
      runId: 'live-run',
      reviewId: 'live-review',
      resultId: 'live-result',
      planId: 'live-plan',
      actionId: 'live-action',
      foundationFingerprint: 'sha256:live-foundation',
      monthId: 'live-month',
      monthFinalResultId: 'live-result',
      rollback: {
        runId: 'live-rollback-run',
        reviewId: 'live-rollback-review',
        terminalPillarWritten: false,
        resultWritten: false,
      },
    },
  };
  const source: { ancestor: boolean; changed: string[] } = { ancestor: true, changed: [] };
  return { recording, served, live, source };
}

describe('the joined customer journey proof', () => {
  it('reads release evidence from the journey evidence commit instead of the candidate checkout', () => {
    const one = fixture();
    const evidenceCommit = customerJourneyEvidenceCommit((...args) => {
      expect(args).toEqual(['log', '-1', '--format=%H', 'HEAD', '--', 'app/scripts/recordings/customer-journey.json']);
      return 'evidence123';
    });
    const reads: Array<{ commit: string; path: string }> = [];
    const evidence = historicalEvidence(evidenceCommit, (commit, path) => {
      reads.push({ commit, path });
      return JSON.stringify(path.endsWith('served.json') ? one.served : one.live);
    });

    expect(reads.map(({ commit }) => commit)).toEqual(['evidence123', 'evidence123']);
    expect(reads.map(({ path }) => path.endsWith('recordings/served.json'))).toEqual([true, false]);
    expect(reads.map(({ path }) => path.endsWith('recordings/live-suite.json'))).toEqual([false, true]);
    expect(evidence.problems).toEqual([]);
    expect(journeyProblems(one.recording, evidence.served, evidence.live, one.source)).toEqual([]);
  });

  it('fails when the source commit lacks a recording or contains invalid JSON', () => {
    const missing = historicalEvidence('abc123', (_commit, path) => {
      if (path.endsWith('served.json')) throw new Error('not in tree');
      return '{';
    });

    expect(missing.problems).toEqual([
      'evidence commit abc123 does not contain app/scripts/recordings/served.json.',
      'app/scripts/recordings/live-suite.json at evidence commit abc123 is not valid JSON.',
    ]);
    expect(historicalEvidence('', () => '')).toEqual({
      problems: ['customer-journey evidence commit is missing.'],
    });
  });

  it('accepts two independent identity-carrying journeys and their release evidence', () => {
    const one = fixture();
    expect(journeyProblems(one.recording, one.served, one.live, one.source)).toEqual([]);
  });

  it('rejects a raw run id in every final-result consumer', () => {
    const one = fixture();
    one.recording.scenarios.allConfirmed.resultId = 'run-all';
    one.recording.scenarios.allConfirmed.report.resultId = 'run-all';
    one.recording.scenarios.allConfirmed.export.finalResultId = 'run-all';
    one.recording.scenarios.allConfirmed.month.finalResultId = 'run-all';
    one.recording.scenarios.allConfirmed.restartRead.resultId = 'run-all';

    expect(journeyProblems(one.recording, one.served, one.live, one.source)).toContain(
      'allConfirmed.resultId is the raw run id; customer result consumers require the immutable final-result id.'
    );
  });

  it('keeps a named release proof valid while later application work is developed', () => {
    const one = fixture();
    one.source.changed = ['app/server/server.ts'];

    expect(journeyProblems(one.recording, one.served, one.live, one.source)).toEqual([]);
  });

  it('rejects deployment drift and incomplete route coverage', () => {
    const one = fixture();
    one.served.driven.deploymentId = 'deployment-2';
    one.served.driven.drove = 36;

    const problems = journeyProblems(one.recording, one.served, one.live, one.source);
    expect(problems.some((problem) => problem.includes('served route-census deployment id'))).toBe(true);
    expect(problems.some((problem) => problem.includes('36 of 37'))).toBe(true);
  });

  it('rejects a recording whose source commit is outside the candidate history', () => {
    const one = fixture();
    one.source.ancestor = false;

    expect(journeyProblems(one.recording, one.served, one.live, one.source)).toContain(
      'sourceCommit abc123 is not an ancestor of HEAD.'
    );
  });

  it('requires the controlled browser failures and the real-store restart/rollback proof', () => {
    const one = fixture();
    one.recording.scenarios.storeFailure.currentResult.scoreExposed = true;
    one.recording.scenarios.storeFailure.monthPreview.publicationEnabled = true;
    one.live.lifecycle.restarted = false;
    one.live.lifecycle.rollback.resultWritten = true;

    const problems = journeyProblems(one.recording, one.served, one.live, one.source);
    expect(problems).toContain('storeFailure.currentResult exposed a score.');
    expect(problems).toContain('storeFailure.monthPreview enabled publication.');
    expect(problems).toContain('live-suite.json does not record the lifecycle restart read.');
    expect(problems.some((problem) => problem.includes('terminal projection rollback'))).toBe(true);
  });

  it('rejects a live proof from another commit or with identities that do not join after restart', () => {
    const one = fixture();
    one.live.commit = 'different-commit';
    one.live.lifecycle.monthFinalResultId = 'different-result';
    one.live.lifecycle.rollback.runId = one.live.lifecycle.runId;

    const problems = journeyProblems(one.recording, one.served, one.live, one.source);
    expect(problems.some((problem) => problem.includes('live-suite commit'))).toBe(true);
    expect(problems.some((problem) => problem.includes('monthFinalResultId'))).toBe(true);
    expect(problems.some((problem) => problem.includes('rollback reuses'))).toBe(true);
  });
});
