/**
 * The destination after an interactive run completes.
 *
 * The run id travels beside it for the provider's identity contract, but it is never used to invent
 * a review address: the server-created review id is the only route that can be exact.
 */
export function completedReviewPath(
  completed: { readonly runId: string; readonly reviewId: string } | undefined
): string | undefined {
  return completed == null ? undefined : `/review/${completed.reviewId}`;
}
