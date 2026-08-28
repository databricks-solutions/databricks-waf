// Durable attestations, in the Lakebase schema the app owns.
//
// Almost nothing here, and that is the point: the append-only design this store was written around
// turned out to be the design the recorded decisions needed too, so it lives in store/event-log.ts
// where both sit on one copy of it. What stays is what is specific to an answer — which of its
// fields are dates, and what makes one unreadable.
//
// The two version numbers the volume-backed store carried are gone. `RECORD_VERSION` described a
// JSON file's shape and `PROJECTION_VERSION` the index rebuilt beside it; a table has a schema and
// a `current()` that is a query, so neither number had anything left to describe. ADR 0031.

import type { Attestation } from './attestation.js';
import type { AttestationStore } from './store.js';
import { PostgresEventLog } from '../store/event-log.js';
import type { Postgres } from '../store/postgres.js';
import type { AssessmentScope } from '../store/assessment-scope.js';

export interface PostgresAttestationStoreOptions {
  readonly db: Postgres;
  readonly onError?: (operation: string, error: unknown) => void;
}

export class PostgresAttestationStore implements AttestationStore {
  readonly durable = true;

  private readonly log: PostgresEventLog<Attestation>;

  constructor(options: PostgresAttestationStoreOptions) {
    this.log = new PostgresEventLog<Attestation>({
      db: options.db,
      table: 'attestations',
      stampColumn: 'attested_at',
      stampOf: (attestation) => attestation.attestedAt,
      revive: reviveStoredAttestation,
      noun: 'attestation',
      ...(options.onError ? { onError: options.onError } : {}),
    });
  }

  current(scope?: AssessmentScope): Promise<readonly Attestation[]> {
    return this.log.current(scope);
  }

  get(id: string, scope?: AssessmentScope): Promise<Attestation | undefined> {
    return this.log.get(id, scope);
  }

  historyFor(controlId: string, scope?: AssessmentScope): Promise<readonly Attestation[]> {
    return this.log.historyFor(controlId, scope);
  }

  record(attestation: Attestation): Promise<void> {
    return this.log.append(attestation);
  }
}

/** A stored record back into a domain object, with its two dates restored. */
export function reviveStoredAttestation(raw: unknown): Attestation | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const candidate = raw as Attestation & { attestedAt: string | Date; reviewBy: string | Date };
  const attestedAt = new Date(candidate.attestedAt);
  const reviewBy = new Date(candidate.reviewBy);
  // A record whose dates do not parse would expire-or-not unpredictably depending on where it was
  // read, so it is treated as unreadable rather than guessed at.
  if (Number.isNaN(attestedAt.getTime()) || Number.isNaN(reviewBy.getTime())) return undefined;
  if (typeof candidate.controlId !== 'string' || typeof candidate.statement !== 'string') return undefined;

  return { ...candidate, attestedAt, reviewBy };
}
