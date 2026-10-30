/**
 * The destination after an interactive run completes.
 *
 * The run id travels beside it for the provider's identity contract, but it is never used to invent
 * a review address: the server-created review id is the only route that can be exact.
 */
import { answerWalkPath, reviewPath } from './assessment-continuation';

export function completedReviewPath(
  completed: { readonly runId: string; readonly reviewId: string; readonly definitionId: string | null } | undefined
): string | undefined {
  if (completed == null) return undefined;
  return completed.definitionId == null
    ? answerWalkPath(completed.runId)
    : reviewPath(completed.reviewId, completed.definitionId);
}
