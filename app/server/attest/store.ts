// Where attestations are kept.
//
// The same two-implementation shape the scan store uses, for the same reason: an install
// with no volume bound has to work, and has to say what it cannot do rather than silently
// forget what someone typed.
//
// The difference from the scan store is what a loss means. A lost scan can be re-run in
// minutes by pressing a button. A lost attestation is somebody's written statement about
// how their organisation works, and asking them to type it again because the app redeployed
// is the kind of thing that gets a tool uninstalled. So the in-memory implementation here
// is a fallback that the UI is expected to warn about loudly, not a reasonable default.

import type { Attestation } from './attestation.js';
import { counts } from './attestation.js';
import { newestFirstBy } from '../store/event-log.js';
import type { AssessmentScope } from '../store/assessment-scope.js';
import { inScope } from '../store/assessment-scope.js';

export interface AttestationStore {
  /** True when records survive a process restart. Surfaced in the UI, never assumed. */
  readonly durable: boolean;
  /**
   * The newest attestation for each requirement, expired ones included.
   *
   * Expired records are returned rather than filtered because the caller needs to tell "no
   * answer was ever given" from "the answer lapsed in March". Both leave the requirement
   * unmeasured and they call for different things to be said about it.
   */
  current(scope?: AssessmentScope): Promise<readonly Attestation[]>;
  /** One exact immutable answer by id, for a final result that cites rather than reselects it. */
  get(id: string, scope?: AssessmentScope): Promise<Attestation | undefined>;
  /** Every answer ever recorded for one requirement, newest first. */
  historyFor(controlId: string, scope?: AssessmentScope): Promise<readonly Attestation[]>;
  /** Appends an answer. Never overwrites: superseding is recorded, not destructive. */
  record(attestation: Attestation): Promise<void>;
}

/** The current attestations that still count, by control id. What resolution reads. */
export function effective(
  attestations: readonly Attestation[],
  now: Date = new Date()
): ReadonlyMap<string, Attestation> {
  const live = new Map<string, Attestation>();
  for (const attestation of attestations) {
    if (counts(attestation, now)) live.set(attestation.controlId, attestation);
  }
  return live;
}

/** Newest first, breaking ties by the supersession chain. See `newestFirstBy`. */
export function newestFirst(attestations: readonly Attestation[]): Attestation[] {
  return newestFirstBy(attestations, (attestation) => attestation.attestedAt);
}

export class InMemoryAttestationStore implements AttestationStore {
  readonly durable = false;

  private readonly events: Attestation[] = [];

  current(scope?: AssessmentScope): Promise<readonly Attestation[]> {
    const newest = new Map<string, Attestation>();
    for (const attestation of newestFirst(this.events)) {
      if (!inScope(attestation.definitionId, scope)) continue;
      if (!newest.has(attestation.controlId)) newest.set(attestation.controlId, attestation);
    }
    return Promise.resolve([...newest.values()]);
  }

  get(id: string, scope?: AssessmentScope): Promise<Attestation | undefined> {
    return Promise.resolve(this.events.find((event) => event.id === id && inScope(event.definitionId, scope)));
  }

  historyFor(controlId: string, scope?: AssessmentScope): Promise<readonly Attestation[]> {
    return Promise.resolve(
      newestFirst(
        this.events.filter((event) => event.controlId === controlId && inScope(event.definitionId, scope))
      )
    );
  }

  record(attestation: Attestation): Promise<void> {
    this.events.push(attestation);
    return Promise.resolve();
  }
}
