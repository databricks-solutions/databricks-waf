/** Where a reader can continue a run without losing its assessment or pillar context. */
export interface ContinuableRun {
  readonly id: string;
  readonly stamp: { readonly definition?: { readonly id: string } };
}

/** An empty definitionId deliberately selects the unscoped, custom-run view. */
export function runScope(run: ContinuableRun): string {
  return `definitionId=${encodeURIComponent(run.stamp.definition?.id ?? '')}`;
}

/** Switching away from a run-specific page must carry the newly chosen scope in the destination. */
export function assessmentOverviewPath(definitionId: string | null): string {
  return `/overview?definitionId=${encodeURIComponent(definitionId ?? '')}`;
}

export function answerWalkPath(runId: string, pillarId?: string): string {
  return answerWalkForRunPath({ id: runId, stamp: {} }, pillarId);
}

export function answerWalkForRunPath(run: ContinuableRun, pillarId?: string): string {
  const query = new URLSearchParams({ runId: run.id, definitionId: run.stamp.definition?.id ?? '' });
  if (pillarId != null) query.set('pillar', pillarId);
  return `/answers/walk?${query.toString()}`;
}

/** A carried-forward pillar is outside the new run's question scope but belongs to this assessment. */
export function answerWalkForAssessmentPath(definitionId: string, pillarId: string): string {
  const query = new URLSearchParams({ definitionId, pillar: pillarId });
  return `/answers/walk?${query.toString()}`;
}

export function reviewPath(reviewId: string, definitionId: string, pillarId?: string): string {
  const query = new URLSearchParams({ definitionId });
  if (pillarId != null) query.set('pillar', pillarId);
  return `/review/${encodeURIComponent(reviewId)}?${query.toString()}`;
}

export function runHistoryPath(run: ContinuableRun): string {
  return `/history/${encodeURIComponent(run.id)}?${runScope(run)}`;
}

/** A report URL must retain its assessment when opened later or shared. */
export function resultReportPath(resultId: string, definitionId: string | null): string {
  return `/report/${encodeURIComponent(resultId)}?definitionId=${encodeURIComponent(definitionId ?? '')}`;
}

export function continuationPath(run: ContinuableRun, reviewId?: string, pillarId?: string): string {
  if (run.stamp.definition == null) return answerWalkForRunPath(run, pillarId);
  if (reviewId == null) return `/review?${runScope(run)}`;
  return reviewPath(reviewId, run.stamp.definition.id, pillarId);
}
