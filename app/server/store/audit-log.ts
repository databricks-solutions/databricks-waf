// The audit log, appended to and never anything else.
//
// Two properties, and the second is the one that took the thought.
//
// It is append-only in the literal sense: there is no update and no delete on this table anywhere in
// the app, and the retention that will eventually remove rows from it (A5) has to remove a
// contiguous prefix and say it did, because removing from the middle is indistinguishable from
// hiding something. `check:read-only` cannot help here — that check is about the customer's estate —
// so the discipline is a code review and this sentence.
//
// It is chained. Each event's digest is taken over its body *including* the digest of the event
// before it, which is what turns a set of independently-digested rows into a sequence that cannot be
// edited in place. ADR 0032 was explicit that a per-record digest catches an accident and not an
// adversary, because whoever edits the body can recompute the digest; the chain is the answer, and
// what it actually buys is worth stating precisely rather than leaving to the reader:
//
//   Editing event 400 of 900 requires recomputing 500 digests. That is not hard for somebody with
//   write access — it is a loop — so the chain alone does not make the log authentic either.
//
//   What it makes impossible is editing it *without changing the head*. So the head digest is the
//   thing to protect, and it is small enough to protect by other means: it is shown in the app,
//   carried on every export, and a customer who writes last month's head into their own ticketing
//   system can prove the whole log up to that point is unchanged, using nothing of ours.
//
// That is why `head()` is part of the interface rather than an implementation detail, and why
// `verifyChain` reports the first break by sequence rather than a boolean.
//
// # Ordering, and why the sequence is read then written
//
// `sequence` is contiguous, because a gap is what a deleted row looks like and `max(sequence)` alone
// would let one be hidden by renumbering. Contiguity means the writer has to know the current head,
// which means read-then-write, which means two appends can race.
//
// They race into a unique violation rather than into a corrupted chain: `sequence` is the primary
// key, so the loser is refused by the database and retries against the new head. Optimistic rather
// than a lock, because mutations here are rare by construction — the comment on `permitted` in
// routes.ts says why, one identity round trip per mutation is already the dominant cost — and a lock
// held across an append is a lock held across a network call to Lakebase.

import type { Sql } from './postgres.js';
import { digestOf, sameDigest, type Digest } from '../records/digest.js';
import {
  GENESIS,
  type AuditAction,
  type AuditEvent,
  type AuditOutcome,
  type ChainedAuditEvent,
} from '../audit/event.js';

/** Where the chain currently ends. `sequence: 0` at `GENESIS` means nothing has been written. */
export interface ChainHead {
  readonly sequence: number;
  readonly digest: Digest;
}

/**
 * Where the chain begins, when retention has removed a prefix of it.
 *
 * The last event that was removed, by sequence and digest, so a verifier can start after it instead
 * of at genesis. Without this the first surviving event names a predecessor no row can produce, and
 * an honest retention pass would be indistinguishable from somebody deleting the beginning of the log
 * — which is exactly the reading a chained log exists to prevent.
 *
 * Declared rather than inferred, and that is the point: a gap the app cannot account for is still a
 * break. This is the app accounting for one, with who did it and when.
 */
export interface AuditFloor {
  readonly sequence: number;
  readonly digest: Digest;
  readonly trimmedAt: Date;
  readonly trimmedBy: string;
}

/** What a reader is looking for. Every field narrows; absent means "any". */
export interface AuditQuery {
  readonly actor?: string;
  readonly action?: AuditAction;
  readonly outcome?: AuditOutcome;
  readonly targetId?: string;
  readonly correlation?: string;
  readonly since?: Date;
  readonly until?: Date;
  /** For paging: only events below this sequence. The sequence is the cursor, not an offset. */
  readonly before?: number;
  readonly limit?: number;
}

export interface AuditPage {
  readonly events: readonly ChainedAuditEvent[];
  /** Pass as `before` to get the next page. Absent when the page reached the beginning. */
  readonly next?: number;
}

/** Where a chain stops being verifiable, and why. */
export interface ChainBreak {
  readonly sequence: number;
  readonly kind: 'digest' | 'link' | 'gap';
  readonly says: string;
}

export interface ChainVerification {
  readonly checked: number;
  readonly head?: ChainHead;
  readonly breaks: readonly ChainBreak[];
  /** What the result establishes, in the same honest register as `records/verify.ts`. */
  readonly means: string;
}

export interface AuditLog {
  /**
   * Whether what is appended survives a restart.
   *
   * On the interface rather than inferred from which class it is, because the surface that shows the
   * trail has to say so: an empty list from a log that forgets is the reading "nothing has happened
   * here", and it is wrong in the one direction that matters.
   */
  readonly durable: boolean;
  append(event: AuditEvent): Promise<ChainedAuditEvent>;
  head(): Promise<ChainHead>;
  /** The declared start of the surviving chain, when retention has trimmed a prefix. */
  floor(): Promise<AuditFloor | undefined>;
  search(query?: AuditQuery): Promise<AuditPage>;
  verify(): Promise<ChainVerification>;
}

/** The largest page a caller can ask for, so a query cannot pull the whole log into memory. */
export const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

/** How many times an append re-reads the head after losing a race before giving up. */
const ATTEMPTS = 5;

/** How many events a verification pass holds at once. Large enough to be one round trip in practice. */
const VERIFY_BATCH = 1000;

/**
 * Thrown when an append could not find a free sequence.
 *
 * Bounded rather than looping forever, because an unbounded retry against a table that is somehow
 * always conflicting is an app that hangs a request instead of reporting a fault. Five is far past
 * anything the contention here can produce; reaching it means something other than a race.
 */
export class AuditAppendError extends Error {
  constructor(attempts: number) {
    super(
      `The audit log could not be appended to after ${String(attempts)} attempts. The act itself may ` +
        'have happened, and this app could not record that it did, which is a fault worth ' +
        'investigating rather than a permission problem.'
    );
  }
}

export class PostgresAuditLog implements AuditLog {
  readonly durable = true;

  constructor(private readonly db: Sql & { readonly schema: string }) {}

  /**
   * Writes the event at the end of the chain, retrying against a new head if it lost a race.
   *
   * Returns the stored form rather than void, because the caller occasionally needs the sequence —
   * an export cites the head it was taken at — and re-reading to find out what was just written is
   * a second race.
   */
  async append(event: AuditEvent): Promise<ChainedAuditEvent> {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const head = await this.head();
      const chained = chain(event, head);

      try {
        await this.insert(chained);
        return chained;
      } catch (error) {
        if (!isDuplicate(error)) throw error;

        // A duplicate `id` means this event is already in the log, which happens when a retry
        // follows an insert that succeeded and then failed to report it. Treating that as an error
        // would turn one recorded act into a reported fault.
        //
        // The *stored* form is returned rather than the one just composed. They differ: the stored
        // one sits at the sequence it won, and this attempt composed a later one against a head that
        // has since moved. Handing back the composed one would give the caller a sequence and digest
        // that are in no log, and an export citing them would cite nothing.
        const already = await this.find(event.id);
        if (already != null) return already;

        // Otherwise the collision was on `sequence`: another append won the race. Retry against the
        // head it left behind.
      }
    }
    throw new AuditAppendError(ATTEMPTS);
  }

  /**
   * The end of the chain, or the declared floor when retention has removed every surviving event.
   *
   * The fallback is load-bearing. Reading an empty table as genesis is right on a fresh install and
   * wrong after a trim that took the lot: the next append would be sequence 1 again, below a floor
   * that names sequence 4,000, and the log would have two beginnings. Continuing from the floor keeps
   * the sequence monotonic for the life of the install, which is what every reader of it assumes.
   */
  async head(): Promise<ChainHead> {
    const { rows } = await this.db.query<{ sequence: number | string; digest: string }>(
      `select sequence, digest from ${this.db.schema}.audit_events order by sequence desc limit 1`
    );
    const row = rows[0];
    if (row != null) return { sequence: Number(row.sequence), digest: row.digest as Digest };

    const floor = await this.floor();
    return floor == null ? { sequence: 0, digest: GENESIS } : { sequence: floor.sequence, digest: floor.digest };
  }

  async floor(): Promise<AuditFloor | undefined> {
    const { rows } = await this.db.query<{
      sequence: number | string;
      digest: string;
      trimmed_at: Date | string;
      trimmed_by: string;
    }>(`select sequence, digest, trimmed_at, trimmed_by from ${this.db.schema}.audit_floor where id = $1`, [1]);
    const row = rows[0];
    if (row == null) return undefined;
    return {
      sequence: Number(row.sequence),
      digest: row.digest as Digest,
      trimmedAt: new Date(row.trimmed_at),
      trimmedBy: row.trimmed_by,
    };
  }

  async search(query: AuditQuery = {}): Promise<AuditPage> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
    const { where, values } = conditions(query);

    // One more than asked for, so "is there another page" is answered by the read rather than by a
    // second count that can disagree with it.
    const { rows } = await this.db.query<StoredRow>(
      `select sequence, previous, digest, body from ${this.db.schema}.audit_events${where} order by sequence desc limit $${String(values.length + 1)}`,
      [...values, limit + 1]
    );

    const events = rows.slice(0, limit).map(revive);
    const last = events.at(-1);
    return rows.length > limit && last != null ? { events, next: last.sequence } : { events };
  }

  /**
   * Walks the whole chain from the beginning, recomputing every digest and every link.
   *
   * From the beginning rather than from a checkpoint, because a checkpoint is a claim that the
   * prefix below it was verified once and has not changed since, and nothing here can establish the
   * second half of that.
   *
   * Read in batches rather than in one statement. The table grows by a row per mutation for the life
   * of the install and this is the one query with no natural limit on it, so a single `select *`
   * would be the request that takes the app down on the day it finally matters. The walk itself only
   * ever needs the row in front of it and the previous digest, so a batch boundary costs nothing.
   */
  async verify(): Promise<ChainVerification> {
    const breaks: ChainBreak[] = [];
    // Where the walk starts. Genesis unless retention declared a floor *and* the events below it are
    // actually gone: a floor with its prefix still present is a trim that did not finish, and walking
    // that prefix reports it as sound rather than as a break the app itself caused.
    const floor = await this.floor();
    const start = floor != null && (await this.lowest()) > floor.sequence ? floor : undefined;

    let expected: Digest = start?.digest ?? GENESIS;
    let expectedSequence = (start?.sequence ?? 0) + 1;
    let checked = 0;
    let head: ChainHead | undefined;
    let after = start?.sequence ?? 0;

    for (;;) {
      const { rows } = await this.db.query<StoredRow>(
        `select sequence, previous, digest, body from ${this.db.schema}.audit_events
           where sequence > $1 order by sequence asc limit $2`,
        [after, VERIFY_BATCH]
      );
      if (rows.length === 0) break;

      for (const row of rows) {
        const stored = revive(row);
        ({ expected, expectedSequence } = this.step(stored, expected, expectedSequence, breaks));
        checked += 1;
        head = { sequence: stored.sequence, digest: stored.digest };
        after = stored.sequence;
      }

      if (rows.length < VERIFY_BATCH) break;
    }

    return {
      checked,
      ...(head != null ? { head } : {}),
      breaks,
      means: means(checked, breaks) + (start == null ? '' : ` ${fromFloor(start)}`),
    };
  }

  /** The lowest surviving sequence, or `Infinity` when the table is empty. */
  private async lowest(): Promise<number> {
    const { rows } = await this.db.query<{ sequence: number | string }>(
      `select sequence from ${this.db.schema}.audit_events order by sequence asc limit 1`
    );
    const row = rows[0];
    return row == null ? Number.POSITIVE_INFINITY : Number(row.sequence);
  }

  /** One event's place in the chain, checked. Extracted so the batching above stays legible. */
  private step(
    stored: ChainedAuditEvent,
    expected: Digest,
    expectedSequence: number,
    breaks: ChainBreak[]
  ): { expected: Digest; expectedSequence: number } {
    let at = expectedSequence;

    if (stored.sequence !== at) {
      breaks.push({
        sequence: stored.sequence,
        kind: 'gap',
        says:
          `The log jumps from ${String(at - 1)} to ${String(stored.sequence)}. A sequence is ` +
          'contiguous by construction, so a gap means rows were removed from the middle of it.',
      });
      at = stored.sequence;
    }

    if (!sameDigest(stored.previous, expected)) {
      breaks.push({
        sequence: stored.sequence,
        kind: 'link',
        says:
          `Event ${String(stored.sequence)} names a predecessor that is not the event before it, so the ` +
          'chain was rewritten from here or an event was replaced.',
      });
    }

    if (!sameDigest(stored.digest, digestOf(bodyOf(stored)))) {
      breaks.push({
        sequence: stored.sequence,
        kind: 'digest',
        says: `Event ${String(stored.sequence)} does not match its own digest, so its contents changed after it was written.`,
      });
    }

    // The stored digest rather than the recomputed one, so a single altered event reports as one
    // break rather than as one break plus every link after it. The alternative reads as a
    // catastrophe when what happened is one edited row.
    return { expected: stored.digest, expectedSequence: at + 1 };
  }

  private async insert(event: ChainedAuditEvent): Promise<void> {
    await this.db.query(
      `insert into ${this.db.schema}.audit_events (sequence, id, at, actor, action, outcome, target_id, correlation, previous, digest, body)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [
        event.sequence,
        event.id,
        event.at,
        event.actor,
        event.action,
        event.outcome,
        event.target?.id ?? null,
        event.correlation ?? null,
        event.previous,
        event.digest,
        JSON.stringify(bodyOf(event)),
      ]
    );
  }

  private async find(id: string): Promise<ChainedAuditEvent | undefined> {
    const { rows } = await this.db.query<StoredRow>(
      `select sequence, previous, digest, body from ${this.db.schema}.audit_events where id = $1 limit 1`,
      [id]
    );
    const row = rows[0];
    return row == null ? undefined : revive(row);
  }
}

/**
 * The event with its place in the chain, and its digest over both.
 *
 * A free function rather than a method, because the export and the independent verifier both need
 * to produce the same bytes from the same event and neither of them has a database.
 */
export function chain(event: AuditEvent, head: ChainHead): ChainedAuditEvent {
  const placed = { ...event, sequence: head.sequence + 1, previous: head.digest };
  return { ...placed, digest: digestOf(bodyOf(placed)) };
}

/**
 * What the digest is taken over: the event, its sequence and its predecessor, and not its own
 * digest.
 *
 * Written out rather than spread from the event, so adding a field to `AuditEvent` without deciding
 * whether it is covered by the digest is a type error here rather than a silent change of meaning
 * for every row written afterwards.
 */
export function bodyOf(event: Omit<ChainedAuditEvent, 'digest'>): Record<string, unknown> {
  return {
    id: event.id,
    at: event.at.toISOString(),
    actor: event.actor,
    executionMode: event.executionMode,
    action: event.action,
    outcome: event.outcome,
    sequence: event.sequence,
    previous: event.previous,
    ...(event.target != null
      ? {
          target: {
            kind: event.target.kind,
            id: event.target.id,
            ...(event.target.digest != null ? { digest: event.target.digest } : {}),
          },
        }
      : {}),
    ...(event.reason != null ? { reason: event.reason } : {}),
    ...(event.correlation != null ? { correlation: event.correlation } : {}),
    // Covered by the digest, like everything else here. A reset's own event is the only record of
    // what it destroyed, so a count that could be edited afterwards without the digest noticing
    // would be a number worth exactly nothing.
    ...(event.emptied != null ? { emptied: { rows: event.emptied.rows, tables: event.emptied.tables } } : {}),
  };
}

interface StoredRow {
  readonly sequence: number | string;
  readonly previous: string;
  readonly digest: string;
  readonly body: unknown;
}

/**
 * A stored row back into an event.
 *
 * The body is the authority for everything the digest covers, and the columns beside it exist only
 * so the database can index and filter — so a row whose `actor` column disagrees with its body is a
 * row whose body wins here, and whose digest still verifies. That is the right way round: the
 * indexed copies are derived, and a verifier that trusted them could be fooled by editing one.
 */
function revive(row: StoredRow): ChainedAuditEvent {
  const body = (row.body ?? {}) as Record<string, unknown>;
  const target = body.target as { kind: string; id: string; digest?: string } | undefined;

  return {
    id: text(body.id),
    at: new Date(text(body.at)),
    actor: text(body.actor),
    executionMode: body.executionMode === 'service-principal' ? 'service-principal' : 'on-behalf-of-user',
    action: body.action as AuditAction,
    outcome: body.outcome as AuditOutcome,
    sequence: Number(row.sequence),
    previous: row.previous as Digest,
    digest: row.digest as Digest,
    ...(target != null
      ? {
          target: {
            kind: target.kind as never,
            id: target.id,
            ...(typeof target.digest === 'string' ? { digest: target.digest as Digest } : {}),
          },
        }
      : {}),
    ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
    ...(typeof body.correlation === 'string' ? { correlation: body.correlation } : {}),
    ...emptiedFrom(body.emptied),
  };
}

/**
 * A reset's count, when the stored body has one that is actually a pair of numbers.
 *
 * Checked rather than cast, for the reason `text` gives above: the body is `jsonb` and holds whatever
 * was written. A half-present pair — rows without tables — is dropped whole, because "emptied 41,208
 * rows across an unknown number of tables" is a worse answer than a row the surface reports as
 * carrying no count and whose digest, which covered the original pair, no longer verifies.
 */
function emptiedFrom(value: unknown): { emptied?: { rows: number; tables: number } } {
  if (typeof value !== 'object' || value == null) return {};
  const { rows, tables } = value as { rows?: unknown; tables?: unknown };
  if (typeof rows !== 'number' || typeof tables !== 'number') return {};
  return { emptied: { rows, tables } };
}

/**
 * A stored value as a string, or empty when it is not one.
 *
 * Rather than `String(value)`, which turns an object into `[object Object]` and a number into a
 * plausible-looking id. The body is `jsonb`, so its shape is whatever was written rather than what
 * the type says, and a field that arrives as the wrong type is a damaged record — which reads as an
 * empty field here and fails verification, both of which are visible. A coerced one would not be.
 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The `where` clause and its values, built only from fields the caller actually narrowed on. */
function conditions(query: AuditQuery): { where: string; values: unknown[] } {
  const terms: string[] = [];
  const values: unknown[] = [];

  const narrow = (column: string, operator: string, value: unknown): void => {
    if (value == null) return;
    values.push(value);
    terms.push(`${column} ${operator} $${String(values.length)}`);
  };

  narrow('actor', '=', query.actor);
  narrow('action', '=', query.action);
  narrow('outcome', '=', query.outcome);
  narrow('target_id', '=', query.targetId);
  narrow('correlation', '=', query.correlation);
  narrow('at', '>=', query.since);
  narrow('at', '<=', query.until);
  narrow('sequence', '<', query.before);

  return { where: terms.length === 0 ? '' : ` where ${terms.join(' and ')}`, values };
}

/**
 * What a verification result establishes, said in the response rather than left to the reader.
 *
 * The same discipline as `records/verify.ts`: a green result that a reader over-reads is worse than
 * a red one, because it is the one that ends up quoted in a report.
 */
function means(checked: number, breaks: readonly ChainBreak[]): string {
  if (checked === 0) {
    return 'Nothing has been recorded yet, so there is no chain to verify.';
  }
  // A chain of one is not a curiosity to be phrased around: it is what a freshly reset install has, and
  // "1 events, each matching its own digest" on the first page somebody reads after emptying an install
  // is the app failing to count to one in the place it is asking to be trusted about counting.
  const events = checked === 1 ? '1 event' : `${String(checked)} events`;
  if (breaks.length > 0) {
    const found = breaks.length === 1 ? '1 break' : `${String(breaks.length)} breaks`;
    return (
      `${found} in ${events}. Each one is a place the log was changed ` +
      'after it was written. The events below the first break are still internally consistent.'
    );
  }
  return (
    `${events}, ${checked === 1 ? 'matching its own digest and naming what came before it' : 'each matching its own digest and naming the one before it'}. This establishes that ` +
    'the log has not been edited in place. It does not establish that the whole log was not rewritten: ' +
    'anybody who can write to this table can recompute every digest in it. What makes that detectable is ' +
    'the head digest — compare the one shown here with one recorded elsewhere at an earlier date, and a ' +
    'rewrite of any event below it changes the head.'
  );
}

/**
 * What a declared floor adds to the reading, appended to whatever the walk established.
 *
 * Said rather than left out, because "4,000 events, each naming the one before it" read against a log
 * whose first surviving event is number 3,001 invites the reader to believe they verified the whole
 * history. They verified what survives, and the app is the one saying where that starts.
 */
function fromFloor(floor: AuditFloor): string {
  return (
    `This log begins at event ${String(floor.sequence + 1)}: everything below it was removed on ` +
    `${floor.trimmedAt.toISOString().slice(0, 10)} by ${floor.trimmedBy} under the retention policy, and the ` +
    'chain continues from the digest recorded for the last removed event. What was removed cannot be ' +
    'verified from here, and this app is the only witness that it was removed on purpose.'
  );
}

/** Postgres's duplicate-key code, which is what a lost race arrives as. */
function isDuplicate(error: unknown): boolean {
  return typeof error === 'object' && error != null && (error as { code?: unknown }).code === '23505';
}

/**
 * The log for a build with nothing to persist to.
 *
 * Kept because `WAF_DEMO_NO_PERSISTENCE=1` exists and an app that cannot boot without a database it
 * was told not to use would be a worse answer than a log that says it is not durable. Chained the
 * same way, so the tests that matter run against the same logic.
 */
export class InMemoryAuditLog implements AuditLog {
  readonly durable = false;

  private readonly events: ChainedAuditEvent[] = [];

  append(event: AuditEvent): Promise<ChainedAuditEvent> {
    const existing = this.events.find((one) => one.id === event.id);
    if (existing != null) return Promise.resolve(existing);

    const chained = chain(event, this.headNow());
    this.events.push(chained);
    return Promise.resolve(chained);
  }

  head(): Promise<ChainHead> {
    return Promise.resolve(this.headNow());
  }

  /** Never trimmed: a log that does not survive a restart has no retention to apply to it. */
  floor(): Promise<AuditFloor | undefined> {
    return Promise.resolve(undefined);
  }

  search(query: AuditQuery = {}): Promise<AuditPage> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
    const matching = this.events
      .filter((event) => matches(event, query))
      .sort((left, right) => right.sequence - left.sequence);

    const events = matching.slice(0, limit);
    const last = events.at(-1);
    return Promise.resolve(matching.length > limit && last != null ? { events, next: last.sequence } : { events });
  }

  /**
   * The same walk as the durable log, rather than a claim that an unwritable array is intact.
   *
   * Returning `breaks: []` unconditionally was the shortcut, and it would have made `means` say
   * "each matching its own digest" about digests nothing recomputed. A sentence about verification
   * that was not produced by verifying is the one kind of output this app must not have.
   */
  verify(): Promise<ChainVerification> {
    const breaks: ChainBreak[] = [];
    let expected: Digest = GENESIS;
    let at = 1;

    for (const event of this.events) {
      if (event.sequence !== at) at = event.sequence;
      if (!sameDigest(event.previous, expected)) {
        breaks.push({ sequence: event.sequence, kind: 'link', says: 'This event does not name the one before it.' });
      }
      if (!sameDigest(event.digest, digestOf(bodyOf(event)))) {
        breaks.push({ sequence: event.sequence, kind: 'digest', says: 'This event does not match its own digest.' });
      }
      expected = event.digest;
      at += 1;
    }

    const head = this.events.at(-1);
    return Promise.resolve({
      checked: this.events.length,
      ...(head != null ? { head: { sequence: head.sequence, digest: head.digest } } : {}),
      breaks,
      means: means(this.events.length, breaks),
    });
  }

  private headNow(): ChainHead {
    const last = this.events.at(-1);
    return last == null ? { sequence: 0, digest: GENESIS } : { sequence: last.sequence, digest: last.digest };
  }
}

function matches(event: ChainedAuditEvent, query: AuditQuery): boolean {
  if (query.actor != null && event.actor !== query.actor) return false;
  if (query.action != null && event.action !== query.action) return false;
  if (query.outcome != null && event.outcome !== query.outcome) return false;
  if (query.targetId != null && event.target?.id !== query.targetId) return false;
  if (query.correlation != null && event.correlation !== query.correlation) return false;
  if (query.since != null && event.at < query.since) return false;
  if (query.until != null && event.at > query.until) return false;
  if (query.before != null && event.sequence >= query.before) return false;
  return true;
}
