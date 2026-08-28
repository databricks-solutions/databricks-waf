// Deciding whether a control applies before deciding whether it passes.
//
// This runs first for a reason that is the most important single behaviour in the
// app. An estate running only serverless compute has no cluster policies, and a
// tool that reports that as three failures is telling a customer their best
// architectural decision made them less compliant. Every subsequent number is
// discredited by it.
//
// Three outcomes, not two. "Does not apply" and "the platform already does this"
// are different claims: the first leaves the denominator, the second counts as a
// pass. Collapsing them into one would either inflate scores by dropping controls
// that were genuinely met, or deflate them by dropping credit that was earned.

import type { SignalId, SignalResult } from '../collect/signal.js';

export type PreconditionOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'absent' | 'present';

export interface Precondition {
  readonly signal: SignalId;
  readonly operator: PreconditionOperator;
  readonly value?: unknown;
  readonly outcome: 'not-applicable' | 'satisfied-by-architecture';
  readonly reason: string;
  readonly scope?: 'estate' | 'segment';
}

export type Applicability =
  | { readonly kind: 'applicable' }
  | { readonly kind: 'not-applicable'; readonly reason: string; readonly signal: SignalId }
  | { readonly kind: 'satisfied-by-architecture'; readonly reason: string; readonly signal: SignalId }
  /**
   * A precondition was scoped to part of the estate, and the segment model that
   * would evaluate it does not exist yet.
   *
   * Reported explicitly rather than falling back to estate scope. Estate scope on a
   * mixed estate would answer "is any of this serverless?" when the question was
   * "which parts", and a single serverless job would excuse the whole classic
   * remainder from cluster-policy controls. Being visibly unfinished is much
   * cheaper than being quietly wrong in the direction of a better-looking score.
   */
  | { readonly kind: 'needs-segments'; readonly signal: SignalId; readonly reason: string }
  /**
   * The precondition itself could not be evaluated because its signal is missing.
   * The control stays applicable: not knowing whether something applies is not a
   * reason to drop it from the denominator.
   */
  | { readonly kind: 'undetermined'; readonly signal: SignalId; readonly detail: string };

/**
 * The scalar a precondition compares against.
 *
 * Signal values are shaped by their collectors and are usually structured. A
 * precondition needs one comparable value, so collectors expose it under `summary`
 * and this reads that, falling back to the value only when it is already scalar.
 * There is deliberately no path expression: a precondition that has to reach into a
 * collector's payload shape is coupled to it, and would break silently whenever the
 * query changed.
 */
function scalarOf(result: SignalResult): unknown {
  const value = result.value;
  if (value != null && typeof value === 'object' && 'summary' in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>).summary;
  }
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  return undefined;
}

function compare(operator: PreconditionOperator, observed: unknown, expected: unknown): boolean | undefined {
  if (operator === 'present') return observed != null;
  if (operator === 'absent') return observed == null;
  if (observed == null) return false;

  if (operator === 'eq') return observed === expected;
  if (operator === 'neq') return observed !== expected;

  // Ordering only makes sense on numbers. A string comparison here would silently
  // succeed and be wrong, so it is refused instead.
  if (typeof observed !== 'number' || typeof expected !== 'number') return undefined;

  switch (operator) {
    case 'gt':
      return observed > expected;
    case 'gte':
      return observed >= expected;
    case 'lt':
      return observed < expected;
    case 'lte':
      return observed <= expected;
  }
}

/**
 * Resolve a control's applicability from its preconditions.
 *
 * First match wins, and `satisfied-by-architecture` is preferred over
 * `not-applicable` when both match. A control the platform genuinely satisfies
 * should be credited rather than quietly removed: dropping it makes the pillar look
 * the same as one where the control was never relevant, and the customer loses the
 * evidence that their architecture earned the pass.
 */
export function resolveApplicability(
  preconditions: readonly Precondition[],
  signals: ReadonlyMap<SignalId, SignalResult>
): Applicability {
  if (preconditions.length === 0) return { kind: 'applicable' };

  const matches: Applicability[] = [];

  for (const precondition of preconditions) {
    if ((precondition.scope ?? 'segment') === 'segment') {
      matches.push({ kind: 'needs-segments', signal: precondition.signal, reason: precondition.reason });
      continue;
    }

    const result = signals.get(precondition.signal);
    if (result == null) {
      matches.push({
        kind: 'undetermined',
        signal: precondition.signal,
        detail: `Signal ${precondition.signal} was not collected, so this control is assessed as applicable.`,
      });
      continue;
    }
    if (result.status === 'unmeasurable') {
      matches.push({
        kind: 'undetermined',
        signal: precondition.signal,
        detail:
          result.unmeasurableReason ??
          `Signal ${precondition.signal} could not be measured, so this control is assessed as applicable.`,
      });
      continue;
    }

    const outcome = compare(precondition.operator, scalarOf(result), precondition.value);
    if (outcome === undefined) {
      matches.push({
        kind: 'undetermined',
        signal: precondition.signal,
        detail: `Precondition on ${precondition.signal} could not be evaluated: ${precondition.operator} needs comparable numbers.`,
      });
      continue;
    }
    if (outcome) {
      matches.push({ kind: precondition.outcome, reason: precondition.reason, signal: precondition.signal });
    }
  }

  return (
    matches.find((m) => m.kind === 'satisfied-by-architecture') ??
    matches.find((m) => m.kind === 'not-applicable') ??
    matches.find((m) => m.kind === 'needs-segments') ??
    matches.find((m) => m.kind === 'undetermined') ?? { kind: 'applicable' }
  );
}
