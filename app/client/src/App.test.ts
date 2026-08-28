import { describe, expect, it } from 'vitest';
import { completedReviewPath } from './completed-review-route';

describe('the route after an interactive run completes', () => {
  it('carries the server-created review identity rather than reconstructing one from the run', () => {
    expect(completedReviewPath({ runId: 'run-exact-107c', reviewId: 'review-exact-107c' })).toBe(
      '/review/review-exact-107c'
    );
  });

  it('does not navigate for an unattended completion observed by the follower', () => {
    expect(completedReviewPath(undefined)).toBeUndefined();
  });
});
