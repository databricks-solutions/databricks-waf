/**
 * Types for the reading measure-scope-registry.mjs exports, so its test type-checks.
 *
 * Only the verdict is exported: it is the part that decides what the measurement reports, and it read a
 * rejection as an acceptance once.
 */

/** What the registry did with a scope name. `unclear` is a refusal to guess, not a third outcome. */
export type ScopeVerdict = 'accepted' | 'rejected' | 'unclear';

export function verdict(status: number, message: string, absentApp?: string): ScopeVerdict;
