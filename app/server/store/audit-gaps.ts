// The marks left by audit events that could not be written, appended to and never anything else.
//
// The recorder counts an event it could not write, and the count lives in one process: it is zero after
// the next deploy, and a second instance never had it. So the only evidence that the trail is missing
// something would disappear on the very occasion the trail was shaky enough to lose an event, which is
// when a restart is most likely. A marker is written to the database beside the trail, so the evidence
// outlives the process that saw the loss and is the same whichever instance is asked.
//
// # What a marker holds
//
// Who, what, against what, when, and the class of the failure. Never the event's payload and never the
// driver's message — `audit/event.ts` says what may not go in a row that is read by more people than any
// other and outlives the incident, and a marker is read by the same people. The identifier of the lost
// event is the marker's own id, so a marker and the event it stands for cannot disagree about which act
// they are, and a retry that reports the same loss twice is one marker.
//
// # Append-only, with acknowledgement as a second row
//
// A marker is never updated. Saying somebody has looked at it is another row in the same table, of a
// different `kind`, that names the marker. A single column set on the marker would be cheaper and would
// make "who acknowledged it, and when" a value that a later write could change; as a row it is as
// durable as the marker, and the database refuses a second acknowledgement of the same one, so the
// first stands.
//
// Acknowledging says that somebody has looked. It does not bring the event back, and it does not make
// the trail whole: `/api/audit/verification` reads the same chain it did before.
//
// # Where this sits next to the trail
//
// It takes the same pool as the log and not the same statement, and a pool hands out a connection per
// statement, so a marker is not written on a connection a failed append may have left in a bad state.
// It does not make the marker safe from the one failure that matters most: a database that is down
// refuses both writes. In that case the in-memory count and the console are all there is, as they were
// before. Decision D7 in docs/decisions.md says why no transactional mode is built to close that.

import type { AuditAction, AuditOutcome } from '../audit/event.js';
import type { Sql } from './postgres.js';

/** One event the app could not write down, as the mark it left. */
export interface AuditGap {
  /** The lost event's own id, so a marker names the act it stands for. */
  readonly id: string;
  /** When the act was decided, which is what the event would have been stamped with. */
  readonly at: Date;
  readonly actor: string;
  readonly action: AuditAction;
  readonly outcome: AuditOutcome;
  /** What the act was on. A kind and an id, as in the trail, and absent where the act named nothing. */
  readonly target?: { readonly kind: string; readonly id: string };
  /** The class of the failure, from `reasonFor`. Never a message. */
  readonly cause: string;
}

/** The gaps nobody has acknowledged, and whether the list is all of them. */
export interface UnacknowledgedGaps {
  /** Newest first. */
  readonly gaps: readonly AuditGap[];
  /** True when there were more than `gaps` holds, so a page cannot present the newest as all of them. */
  readonly truncated: boolean;
}

/** An acknowledgement, whether it was this call that made it or an earlier one. */
export interface Acknowledgement {
  readonly gap: AuditGap;
  readonly by: string;
  readonly at: Date;
  /** True when somebody had already acknowledged it, in which case `by` and `at` are theirs. */
  readonly already: boolean;
}

export interface AuditGapLog {
  /**
   * Whether what is written survives a restart.
   *
   * On the interface for the reason `AuditLog.durable` is: a list of gaps from a log that forgets
   * would be "nothing is missing" in exactly the case it cannot know.
   */
  readonly durable: boolean;
  /** Writes a marker. Rejects when the database refuses it, which the recorder reports and absorbs. */
  record(gap: AuditGap): Promise<void>;
  /** Rejects when it cannot read, so a failed read is never served as an empty list. */
  unacknowledged(): Promise<UnacknowledgedGaps>;
  /** Undefined when there is no such marker. */
  acknowledge(id: string, by: string, at: Date): Promise<Acknowledgement | undefined>;
}

/**
 * How many unacknowledged gaps one read returns.
 *
 * A bound rather than a courtesy: the table grows by a row per lost event for the life of the install,
 * and a diagnostics read that pulled all of it would work until the day there was a long outage, which
 * is the day it is read the most. Past it the list says so rather than presenting a page as the whole.
 */
export const MAX_GAPS = 100;

/** The two kinds of row, and the only two the table's check constraint admits. */
const GAP = 'gap';
const ACKNOWLEDGEMENT = 'acknowledgement';

const COLUMNS = 'id, at, actor, action, outcome, target_kind, target_id, cause';

interface StoredGap {
  readonly id: string;
  readonly at: Date | string;
  readonly actor: string;
  readonly action: string;
  readonly outcome: string;
  readonly target_kind: string | null;
  readonly target_id: string | null;
  readonly cause: string;
}

export class PostgresAuditGapLog implements AuditGapLog {
  readonly durable = true;

  private readonly limit: number;

  constructor(
    private readonly db: Sql & { readonly schema: string },
    options: { readonly limit?: number } = {}
  ) {
    this.limit = options.limit ?? MAX_GAPS;
  }

  async record(gap: AuditGap): Promise<void> {
    try {
      await this.db.query(
        `insert into ${this.db.schema}.audit_gaps (id, kind, at, actor, action, outcome, target_kind, target_id, cause, gap_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          gap.id,
          GAP,
          gap.at,
          gap.actor,
          gap.action,
          gap.outcome,
          gap.target?.kind ?? null,
          gap.target?.id ?? null,
          gap.cause,
          null,
        ]
      );
    } catch (error) {
      // The same loss reported twice is one marker. Anything else is the database refusing, which the
      // recorder reports and counts.
      if (!isDuplicate(error)) throw error;
    }
  }

  async unacknowledged(): Promise<UnacknowledgedGaps> {
    // The anti-join is in the statement rather than in two reads subtracted here, so the answer is of
    // one moment and its cost follows how many are open rather than how many have ever been lost. One
    // more than asked for, so "is there more" is answered by the read and not by a second count.
    const { rows } = await this.db.query<StoredGap>(
      `select a.id, a.at, a.actor, a.action, a.outcome, a.target_kind, a.target_id, a.cause
         from ${this.db.schema}.audit_gaps a
        where a.kind = $1
          and not exists (
                select 1
                  from ${this.db.schema}.audit_gaps b
                 where b.gap_id = a.id
                   and b.kind = $2
              )
        order by a.at desc
        limit $3`,
      [GAP, ACKNOWLEDGEMENT, this.limit + 1]
    );
    return { gaps: rows.slice(0, this.limit).map(revive), truncated: rows.length > this.limit };
  }

  async acknowledge(id: string, by: string, at: Date): Promise<Acknowledgement | undefined> {
    const gap = await this.find(id);
    if (gap == null) return undefined;

    try {
      await this.db.query(
        `insert into ${this.db.schema}.audit_gaps (id, kind, at, actor, action, outcome, target_kind, target_id, cause, gap_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [acknowledgementId(id), ACKNOWLEDGEMENT, at, by, null, null, null, null, null, id]
      );
      return { gap, by, at, already: false };
    } catch (error) {
      if (!isDuplicate(error)) throw error;
    }

    // Somebody got there first. Their acknowledgement stands, and is what is reported, so two people
    // acting on the same page do not each believe they were the one who dealt with it.
    const first = await this.acknowledgement(id);
    return first == null ? undefined : { gap, by: first.by, at: first.at, already: true };
  }

  private async find(id: string): Promise<AuditGap | undefined> {
    const { rows } = await this.db.query<StoredGap>(
      `select ${COLUMNS} from ${this.db.schema}.audit_gaps where id = $1 and kind = $2`,
      [id, GAP]
    );
    const row = rows[0];
    return row == null ? undefined : revive(row);
  }

  private async acknowledgement(id: string): Promise<{ by: string; at: Date } | undefined> {
    const { rows } = await this.db.query<{ actor: string; at: Date | string }>(
      `select actor, at from ${this.db.schema}.audit_gaps where gap_id = $1 and kind = $2`,
      [id, ACKNOWLEDGEMENT]
    );
    const row = rows[0];
    return row == null ? undefined : { by: row.actor, at: new Date(row.at) };
  }
}

/**
 * The gap log for a build with nothing to persist to.
 *
 * Kept for `WAF_DEMO_NO_PERSISTENCE=1`, with the same behaviour as the durable one so the tests that
 * matter run against the same rules, and with `durable` false so a page can say the markers go with
 * the process.
 */
export class InMemoryAuditGapLog implements AuditGapLog {
  readonly durable = false;

  private readonly gaps = new Map<string, AuditGap>();
  private readonly acknowledged = new Map<string, { by: string; at: Date }>();

  record(gap: AuditGap): Promise<void> {
    if (!this.gaps.has(gap.id)) this.gaps.set(gap.id, gap);
    return Promise.resolve();
  }

  unacknowledged(): Promise<UnacknowledgedGaps> {
    const open = [...this.gaps.values()]
      .filter((gap) => !this.acknowledged.has(gap.id))
      .sort((left, right) => right.at.getTime() - left.at.getTime());
    return Promise.resolve({ gaps: open.slice(0, MAX_GAPS), truncated: open.length > MAX_GAPS });
  }

  acknowledge(id: string, by: string, at: Date): Promise<Acknowledgement | undefined> {
    const gap = this.gaps.get(id);
    if (gap == null) return Promise.resolve(undefined);

    const first = this.acknowledged.get(id);
    if (first != null) return Promise.resolve({ gap, by: first.by, at: first.at, already: true });

    this.acknowledged.set(id, { by, at });
    return Promise.resolve({ gap, by, at, already: false });
  }
}

/** The id an acknowledgement row is written under, derived so it is one per marker by construction. */
function acknowledgementId(gapId: string): string {
  return `${gapId}.acknowledged`;
}

function revive(row: StoredGap): AuditGap {
  return {
    id: row.id,
    at: new Date(row.at),
    actor: row.actor,
    action: row.action as AuditAction,
    outcome: row.outcome as AuditOutcome,
    ...(row.target_kind != null && row.target_id != null ? { target: { kind: row.target_kind, id: row.target_id } } : {}),
    cause: row.cause,
  };
}

/** Postgres's duplicate-key code, which is what a repeated id or a second acknowledgement arrives as. */
function isDuplicate(error: unknown): boolean {
  return typeof error === 'object' && error != null && (error as { code?: unknown }).code === '23505';
}
