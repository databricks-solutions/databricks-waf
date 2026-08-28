// Recording a decision.
//
// Separate from the store for the same reason the attestations' register is: the parts a client may
// not decide are decided here — who decided, when, and which earlier decision this replaces. A
// route that assembled those inline would be a route where a forgotten field silently becomes an
// accepted risk attributed to nobody.

import { randomUUID } from 'node:crypto';
import type { Decision, DecisionDraft } from './decision.js';
import type { DecisionStore } from './store.js';

export interface RegisterDecisionOptions {
  readonly store: DecisionStore;
  readonly draft: DecisionDraft;
  /** From the forwarded user token, never from the request body. */
  readonly actor: string;
  readonly now?: Date;
  /** The assessment this decision is recorded under. Absent means it names none. */
  readonly definitionId?: string;
}

export async function registerDecision(options: RegisterDecisionOptions): Promise<Decision> {
  const now = options.now ?? new Date();

  // Read before writing so the new record names the one it replaces. Not a transaction, and it does
  // not need to be: two decisions recorded at once both survive as events and the later one wins on
  // read. The worst case is that one of them records no predecessor, which costs a link in the chain
  // rather than a decision.
  const previous = (await options.store.current(options.definitionId ?? null)).find(
    (entry) => entry.controlId === options.draft.controlId
  );

  const decision: Decision = {
    id: randomUUID(),
    ...options.draft,
    decidedBy: options.actor,
    decidedAt: now,
    ...(previous != null ? { supersedes: previous.id } : {}),
    ...(options.definitionId != null ? { definitionId: options.definitionId } : {}),
  };

  await options.store.record(decision);
  return decision;
}
