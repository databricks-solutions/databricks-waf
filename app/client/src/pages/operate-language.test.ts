import { describe, expect, it } from 'vitest';
import { openAge, remainingPhrase, reviewTiming } from './operate-language';
import type { AssessmentReview, ScanSummary } from '../api/types';

const NOW = new Date('2026-08-20T10:00:00.000Z');

function review(over: Partial<AssessmentReview> = {}): AssessmentReview {
  return {
    id: 'review-1',
    runId: 'scan-1',
    openedBy: 'schedule-principal',
    openedAt: '2026-08-18T08:00:00.000Z',
    pillars: [],
    answers: [],
    durable: true,
    ...over,
  };
}

function scan(): ScanSummary {
  return {
    id: 'scan-1',
    startedAt: '2026-08-18T07:55:00.000Z',
    finishedAt: '2026-08-18T08:00:00.000Z',
    state: 'complete',
    actor: 'schedule-principal',
    executionMode: 'on-behalf-of-user',
    catalogueVersion: '16',
    measuredPillars: [],
    freshPillars: [],
    counts: { pass: 0, fail: 0, partial: 0, unmeasurable: 0, notApplicable: 0 },
    pillarScores: {},
  };
}

describe('operating inbox language', () => {
  it('reports work remaining from the two counts it was given', () => {
    expect(remainingPhrase(2, 7)).toBe('5 pillars left');
    expect(remainingPhrase(6, 7)).toBe('1 pillar left');
    expect(remainingPhrase(7, 7)).toBe('Every selected pillar recorded');
    expect(remainingPhrase(0, 0)).toBe('Work remaining unavailable');
  });

  it('reports age without predicting when the work will be done', () => {
    expect(openAge('2026-08-20T09:30:00.000Z', NOW)).toBe('Open less than an hour');
    expect(openAge('2026-08-20T08:00:00.000Z', NOW)).toBe('Open 2 hours');
    expect(openAge('2026-08-18T08:00:00.000Z', NOW)).toBe('Open 2 days');
  });

  it('keeps an open review visible even when its raw-run timing cannot be joined', () => {
    expect(reviewTiming(review(), undefined, NOW)).toContain('Collected run timing unavailable');
    expect(reviewTiming(review(), undefined, NOW)).not.toContain('scan-1');
    expect(reviewTiming(review(), undefined, NOW)).toContain('opened by schedule-principal');
  });

  it('reports the joined run time and duration when the history row is present', () => {
    const phrase = reviewTiming(review(), scan(), NOW);
    expect(phrase).toContain('Finished');
    expect(phrase).not.toContain('scan-1');
    expect(phrase).toContain('took 5m 0s');
    expect(phrase).toContain('Open 2 days');
  });
});
