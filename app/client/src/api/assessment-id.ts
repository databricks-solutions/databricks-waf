// The assessment the product is currently reading, held apart from the scan payload.
//
// Hooks that fetch lists need this without importing the full assessment context, because that
// context is built from those same hooks. A second, tiny context is the way out of the cycle.
// `undefined` means definitions are still loading, so a list must not fetch yet — the alternative
// is a request with no `definitionId`, which the server treats as the unscoped view.

import { createContext, useContext } from 'react';

/**
 * `string` is that definition. `null` is the unscoped view (without an assessment). `undefined`
 * is still loading, and a fetch must wait.
 */
export const AssessmentIdContext = createContext<string | null | undefined>(undefined);

export function useAssessmentId(): string | null | undefined {
  return useContext(AssessmentIdContext);
}

/**
 * A product path scoped to the assessment being read.
 *
 * `undefined` (still loading) asks for nothing. `null` (without an assessment) omits the parameter,
 * which the server treats as records that name none. A string appends `definitionId`.
 */
export function withAssessment(path: string | null, definitionId: string | null | undefined): string | null {
  if (path == null || definitionId === undefined) return null;
  if (definitionId === null) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}definitionId=${encodeURIComponent(definitionId)}`;
}
