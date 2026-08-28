// Recording an answer.
//
// Separate from the store because the parts a client may not decide are decided here: who
// made the claim, when, how long it stands, and which earlier answer it replaces. A route
// that assembled those inline would be a route where a forgotten field silently becomes an
// attestation attributed to nobody, or one that never expires.

import { randomUUID } from 'node:crypto';
import {
  cadenceDaysFor,
  reviewDateFrom,
  type Attestation,
  type AttestationDraft,
} from './attestation.js';
import type { AttestationStore } from './store.js';
import type { Severity } from '../resolve/finding.js';

export interface RegisterOptions {
  readonly store: AttestationStore;
  readonly draft: AttestationDraft;
  /** From the forwarded user token, never from the request body. */
  readonly actor: string;
  readonly severity: Severity;
  /** The catalogue's own cadence for this requirement, when it sets one. */
  readonly cadenceDays?: number;
  readonly now?: Date;
  /** The assessment this answer is given under. Absent means it names none. */
  readonly definitionId?: string;
}

export async function registerAttestation(options: RegisterOptions): Promise<Attestation> {
  const now = options.now ?? new Date();
  const cadence = cadenceDaysFor(options.severity, options.cadenceDays);

  // Read before writing so the new record names the one it replaces. Not a transaction, and
  // it does not need to be: two answers recorded at once both survive as events, and the
  // later one wins on read. The worst case is that one of them records no predecessor, which
  // costs a link in the chain rather than an answer.
  const previous = (await options.store.current(options.definitionId ?? null)).find(
    (entry) => entry.controlId === options.draft.controlId
  );

  const attestation: Attestation = {
    id: randomUUID(),
    ...options.draft,
    attestedBy: options.actor,
    attestedAt: now,
    reviewBy: reviewDateFrom(now, cadence),
    ...(previous != null ? { supersedes: previous.id } : {}),
    ...(options.definitionId != null ? { definitionId: options.definitionId } : {}),
  };

  await options.store.record(attestation);
  return attestation;
}
