// Where decisions are kept.
//
// The same two implementations, on the same terms, as the attested answers: Lakebase when a
// database is bound, memory only under the demo flag, and neither may silently forget what
// somebody typed. What is lost differs though. A lost scan is a button press away from being
// recovered; a lost decision is the record of who accepted a risk and why, which is exactly the
// sentence somebody will be asked for in six months.

import { PostgresEventLog } from '../store/event-log.js';
import { newestFirstBy } from '../store/ordering.js';
import type { Postgres } from '../store/postgres.js';
import type { Decision } from './decision.js';
import type { AssessmentScope } from '../store/assessment-scope.js';
import { inScope } from '../store/assessment-scope.js';

export interface DecisionStore {
  /** True when records survive a process restart. Surfaced in the UI, never assumed. */
  readonly durable: boolean;
  /**
   * The newest decision for each requirement, lapsed ones included.
   *
   * Lapsed records are returned rather than filtered because "nobody has ever decided anything
   * about this" and "this was accepted until March and nobody looked again" are different things
   * to tell a reader, and only one of them is news.
   */
  current(scope?: AssessmentScope): Promise<readonly Decision[]>;
  /** Every decision ever recorded for one requirement, newest first. */
  historyFor(controlId: string, scope?: AssessmentScope): Promise<readonly Decision[]>;
  /** Appends a decision. Never overwrites: superseding is recorded, not destructive. */
  record(decision: Decision): Promise<void>;
}

/** Newest first, breaking ties by the supersession chain. See `newestFirstBy`. */
export function newestFirst(decisions: readonly Decision[]): Decision[] {
  return newestFirstBy(decisions, (decision) => decision.decidedAt);
}

export class InMemoryDecisionStore implements DecisionStore {
  readonly durable = false;

  private readonly events: Decision[] = [];

  current(scope?: AssessmentScope): Promise<readonly Decision[]> {
    const newest = new Map<string, Decision>();
    for (const decision of newestFirst(this.events)) {
      if (!inScope(decision.definitionId, scope)) continue;
      if (!newest.has(decision.controlId)) newest.set(decision.controlId, decision);
    }
    return Promise.resolve([...newest.values()]);
  }

  historyFor(controlId: string, scope?: AssessmentScope): Promise<readonly Decision[]> {
    return Promise.resolve(
      newestFirst(this.events.filter((event) => event.controlId === controlId && inScope(event.definitionId, scope)))
    );
  }

  record(decision: Decision): Promise<void> {
    this.events.push(decision);
    return Promise.resolve();
  }
}

export interface PostgresDecisionStoreOptions {
  readonly db: Postgres;
  readonly onError?: (operation: string, error: unknown) => void;
}

export class PostgresDecisionStore implements DecisionStore {
  readonly durable = true;

  private readonly log: PostgresEventLog<Decision>;

  constructor(options: PostgresDecisionStoreOptions) {
    this.log = new PostgresEventLog<Decision>({
      db: options.db,
      table: 'decisions',
      stampColumn: 'decided_at',
      stampOf: (decision) => decision.decidedAt,
      revive,
      noun: 'decision',
      ...(options.onError ? { onError: options.onError } : {}),
    });
  }

  current(scope?: AssessmentScope): Promise<readonly Decision[]> {
    return this.log.current(scope);
  }

  historyFor(controlId: string, scope?: AssessmentScope): Promise<readonly Decision[]> {
    return this.log.historyFor(controlId, scope);
  }

  record(decision: Decision): Promise<void> {
    return this.log.append(decision);
  }
}

/**
 * A stored record back into a domain object, with its dates restored.
 *
 * `until` is optional and its absence is meaningful — a fix claim has no date — so a missing one
 * passes and an unparseable one fails. A record whose dates do not parse would be current or
 * lapsed depending on where it was read, so it is treated as unreadable rather than guessed at.
 */
function revive(raw: unknown): Decision | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const candidate = raw as Decision & { decidedAt: string | Date; until?: string | Date };

  const decidedAt = new Date(candidate.decidedAt);
  if (Number.isNaN(decidedAt.getTime())) return undefined;
  if (typeof candidate.controlId !== 'string' || typeof candidate.reason !== 'string') return undefined;

  if (candidate.until == null) return { ...candidate, decidedAt, until: undefined };
  const until = new Date(candidate.until);
  if (Number.isNaN(until.getTime())) return undefined;

  return { ...candidate, decidedAt, until };
}
