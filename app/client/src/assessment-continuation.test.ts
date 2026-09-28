import { describe, expect, it } from 'vitest';
import { answerWalkPath, assessmentOverviewPath, continuationPath, runHistoryPath } from './assessment-continuation';

describe('continuing an unfinished run', () => {
  const custom = { id: 'custom-run', stamp: {} };
  const saved = { id: 'saved-run', stamp: { definition: { id: 'assessment-a' } } };

  it('opens the exact custom run and pillar in the question walk', () => {
    expect(answerWalkPath('custom-run', 'cost-optimization')).toBe(
      '/answers/walk?runId=custom-run&definitionId=&pillar=cost-optimization'
    );
    expect(continuationPath(custom, 'review-for-custom', 'cost-optimization')).toBe(
      '/answers/walk?runId=custom-run&definitionId=&pillar=cost-optimization'
    );
    expect(continuationPath(custom, 'review-for-custom')).toBe('/answers/walk?runId=custom-run&definitionId=');
    expect(runHistoryPath(custom)).toBe('/history/custom-run?definitionId=');
  });

  it('resumes a saved review, including a partly reviewed pillar', () => {
    expect(continuationPath(saved, 'review-a', 'reliability')).toBe(
      '/review/review-a?definitionId=assessment-a&pillar=reliability'
    );
    expect(continuationPath(saved, 'review-a')).toBe('/review/review-a?definitionId=assessment-a');
    expect(continuationPath(saved)).toBe('/review?definitionId=assessment-a');
    expect(runHistoryPath(saved)).toBe('/history/saved-run?definitionId=assessment-a');
  });

  it('keeps two in-progress assessments on their own continuation routes', () => {
    const first = { id: 'run-a', stamp: { definition: { id: 'assessment-a' } } };
    const second = { id: 'run-b', stamp: { definition: { id: 'assessment-b' } } };
    expect(continuationPath(first, 'review-a')).toBe('/review/review-a?definitionId=assessment-a');
    expect(continuationPath(second, 'review-b')).toBe('/review/review-b?definitionId=assessment-b');
    expect(assessmentOverviewPath('assessment-b')).toBe('/overview?definitionId=assessment-b');
    expect(assessmentOverviewPath(null)).toBe('/overview?definitionId=');
  });
});
