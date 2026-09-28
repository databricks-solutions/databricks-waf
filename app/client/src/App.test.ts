import { describe, expect, it } from 'vitest';
import { completedReviewPath } from './completed-review-route';

describe('the route after an interactive run completes', () => {
  it('carries the server-created review identity rather than reconstructing one from the run', () => {
    expect(
      completedReviewPath({ runId: 'run-exact-107c', reviewId: 'review-exact-107c', definitionId: 'assessment-a' })
    ).toBe('/review/review-exact-107c?definitionId=assessment-a');
  });

  it('opens the questions for a completed custom run', () => {
    expect(completedReviewPath({ runId: 'run-custom', reviewId: 'review-custom', definitionId: null })).toBe(
      '/answers/walk?runId=run-custom&definitionId='
    );
  });

  it('does not navigate for an unattended completion observed by the follower', () => {
    expect(completedReviewPath(undefined)).toBeUndefined();
  });
});
