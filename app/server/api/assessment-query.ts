// The assessment a request is reading or writing.
//
// Query parameter rather than a header or a path prefix, so a link can name it and an export URL
// can carry it. Absent means the unscoped view: records that name no definition. That is the
// opposite of returning every assessment, which is the contamination this parameter exists to
// close. A reader who has not named one is not shown two.

import type { Request } from 'express';
import type { AssessmentScope } from '../store/assessment-scope.js';

/**
 * The assessment this request is of.
 *
 * A non-empty `definitionId` query parameter is that definition. Anything else — omitted, empty,
 * an array Express would produce from a repeated key — is the unscoped view. Routes pass the
 * result to every product read; they do not omit the argument, because omitting it at the store
 * is the installation-wide path and a forgotten query parameter must not reopen that path.
 */
export function assessmentOf(request: Request): AssessmentScope {
  const raw = request.query.definitionId;
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  return id === '' ? null : id;
}

/**
 * A product URL that names the assessment the resource belongs to.
 *
 * Built from the record, not from the request: a digest payload is copied off the page and fetched
 * later, and the request that published the href is gone by then. Unscoped records omit the
 * parameter, which is the unscoped view.
 */
export function scopedHref(path: string, definitionId: string | null | undefined): string {
  if (definitionId == null || definitionId === '') return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}definitionId=${encodeURIComponent(definitionId)}`;
}
