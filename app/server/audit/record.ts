// Writing an act down, from the place the act happens.
//
// `event.ts` says what an audit event is and what may not go in one. This is the only thing the
// routes see, and its shape is chosen so that the awkward case is the one that reads naturally:
//
//   const act = recorder.begin('attestation.record', identity);
//   try {
//     ...
//     await act.performed({ kind: 'control', id: control.id });
//   } catch (cause) {
//     await act.failed(cause);
//     ...
//   }
//
// An act is opened before the work and closed exactly once after it, in the branch that knows how
// it ended. That is deliberately more typing than a decorator that wrapped the handler, and it buys
// the thing a decorator cannot: the target and the outcome are recorded by code that knows what was
// acted on, so a failed create can say which definition it was for and a refused decision can name
// the control. A wrapper only ever knows the route.
//
// `settle` is the net under that, and it exists because the first version shipped without one and
// review found three routes with early returns — an unknown id, a stale version — that left the act
// open and so wrote nothing at all. A wrong outcome is a bad row; no row is a lie, because the
// table's whole claim is that an absence means nobody tried. It is bound to the response rather than
// written into each handler, since a `finally` per route is the line the fourteenth route omits.
//
// # Why a failure to record does not fail the act
//
// If the append throws, the act has already happened — the attestation is stored, the scan is
// running — and there are two ways to respond. Refuse the request, which makes the audit table a
// single point of failure for every mutation in the app: a customer whose database blips loses the
// ability to answer a requirement, and the audit gap is created by the very mechanism meant to
// close it. Or record what could not be recorded and carry on.
//
// This takes the second, and pays for it by counting. `unrecorded` is not a metric nobody reads: it
// is served on the health surface, so "the log is missing events" is a thing the app says about
// itself rather than something an auditor discovers by finding a mutation with no event.
//
// It stays the default. Refusal is a supported posture rather than an absent one: `WAF_AUDIT_STRICT=1`
// makes an unauditable mutation fail, for an install under a regime that says "no unaudited action"
// and is not satisfied by a counter however visible. ADR 0046 and its amendment carry both.
//
// The counter is per process and resets on deploy, which is honest for what it is: a signal that
// something is wrong now, not a durable count of everything ever lost. A durable one would need a
// durable place to put it, which is the table that is not writable.
//
// # Why the strict check runs before the act and not at the close
//
// A strict install wants the mutation not to have happened. By the time `performed` is called the
// answer is stored and the scan is running, so a failure there can only be reported — refusing the
// response then would tell the caller their change failed while it sat in the database, which is a
// worse lie than the gap it was trying to avoid. So the strict check is `refuseIfUnrecordable`,
// called by the gate before any handler runs, and the close keeps counting whatever the posture is.
//
// Which means a strict install can still show a count, by two routes rather than one. A close whose
// append fails after the check passed, described below. And a *refusal*, which the gate records
// before this check runs and must: the caller is being turned away rather than allowed to act, so
// there is no act to abandon, and failing that append on top would answer a 403 with a 503. The
// health surface names both, because a reading that named one would read as a diagnosis and be wrong
// half the time.
//
// What that check can and cannot prove is worth being exact about, because the setting is sold as a
// guarantee. It reads the chain head: the same table, through the same pool, so a database that is
// unreachable, a schema that is missing and a pool with nothing left in it all refuse before the
// act. It does not prove the *next insert* would have succeeded — a grant that allows select and
// not insert, a full disk, a serialisation failure under contention would each pass this and then
// fail at the close, where the act has already happened and the count is all there is. Proving the
// write would mean attempting one and rolling it back, and `Sql` is a pool with a `query` method:
// `begin` and `rollback` are separate calls with no promise of landing on the same connection. So
// this narrows the window rather than closing it, and the health surface reports the posture so a
// reader can tell a zero that means "nothing was lost" from one that means "nothing can be lost" —
// which in a strict install means "nothing was lost, and the ways it still could are named here".

import type { AuditAction, AuditEvent, AuditTarget } from './event.js';
import type { AuditLog } from '../store/audit-log.js';

/**
 * Set to `1` so an act that cannot be recorded is refused instead of performed.
 *
 * Named for the posture rather than for the mechanism. `WAF_AUDIT_FAIL_CLOSED=1` would describe the
 * implementation to somebody who already knew what it did, and this has to be recognisable to the
 * person holding the control that requires it.
 */
export const STRICT_ENV = 'WAF_AUDIT_STRICT';

/** What this install does when an act cannot be written down. ADR 0046 and its amendment. */
export type AuditPosture =
  /** The act stands and the loss is counted. The default, and why is in ADR 0046. */
  | 'record-and-continue'
  /** The act is refused. For an install whose regime does not accept an unaudited action. */
  | 'strict';

/**
 * Which posture this process is in.
 *
 * Exactly `1`, like `WAF_DEMO_NO_PERSISTENCE`: `0` and `false` both read as off to a person, and a
 * setting that turned itself on for `false` would be the one kind of misconfiguration nobody checks
 * for, because the operator believes they have already disabled it.
 */
export function postureFrom(env: Readonly<Record<string, string | undefined>>): AuditPosture {
  return (env[STRICT_ENV] ?? '').trim() === '1' ? 'strict' : 'record-and-continue';
}

/**
 * The trail cannot take an event, and this install refuses acts it cannot record.
 *
 * Its own class so the gate's refusal can name the database. A strict refusal that reached the
 * caller as a permission problem would send them to their group membership, where they would find
 * nothing wrong and conclude the app was broken — and they would be right, just not about that.
 *
 * `cause` is kept for the operator's console and deliberately not for the response: a driver error
 * carries a connection string, and `event.ts` is explicit that estate detail does not leave here.
 */
export class TrailUnwritableError extends Error {
  readonly kind = 'trail-unwritable';

  constructor(readonly cause: unknown) {
    super(
      'This action was refused because it could not be written to the audit trail. The database that ' +
        'holds the trail did not answer, and this install is configured to refuse an action it cannot ' +
        'record rather than perform one it cannot account for.'
    );
    this.name = 'TrailUnwritableError';
  }
}

/** Enough of a caller to attribute an act to. The same two fields every route already has. */
export interface Actor {
  readonly actor: string;
  readonly executionMode: 'on-behalf-of-user' | 'service-principal';
}

/**
 * An act that has been started and not yet recorded.
 *
 * Both methods resolve rather than throwing, including when the append fails, because a caller in a
 * `catch` handling one failure must not have to handle a second. Both are also safe to call after
 * the act is closed, where they do nothing — see `begin`.
 */
export interface Act {
  /**
   * It happened.
   *
   * `emptied` is for the one act whose own event is the only surviving record of its scale — see the
   * field on `AuditEvent`. Optional and last, so the ordinary call is still `performed()` or
   * `performed(target)`; nothing else in the app passes it.
   */
  performed(target?: AuditTarget, emptied?: AuditEvent['emptied']): Promise<void>;
  /** The caller was permitted and it did not complete. */
  failed(cause: unknown, target?: AuditTarget): Promise<void>;
  /**
   * Closes an act nothing else closed, from the status the route answered with.
   *
   * The net under the other two, called once per act when the response closes — see `begin` in
   * `routes.ts`, which is the only place that should call it. A handler that returns early on an
   * unknown id or a stale version leaves an act open, and an act opened and never closed writes
   * *nothing*, which is worse than a wrong outcome: the whole claim this table makes is that an
   * absence means nobody tried, and one silent early return devalues every absence in it.
   *
   * It reads the status because that is the one thing the response reliably knows, and it is enough
   * to tell "the route did what was asked" from "the route refused it". A specific reason is better,
   * so the routes name theirs where the early return is, and this only ever fires for a path nobody
   * thought about — where `http-409` beside the act is still a great deal more than silence.
   */
  settle(status: number): Promise<void>;
}

export interface RecorderOptions {
  /** Injected so a test can pin the instant, like every other dated thing here. */
  readonly now?: () => Date;
  /** Injected so a test can assert on ids rather than on `expect.any(String)`. */
  readonly newId?: () => string;
  /** Where a failure to record goes, since it cannot go in the log. */
  readonly onError?: (operation: string, error: unknown) => void;
  /** What to do about an act that cannot be recorded. Defaults to ADR 0046's default. */
  readonly posture?: AuditPosture;
}

export class AuditRecorder {
  private lost = 0;

  constructor(
    private readonly log: AuditLog,
    private readonly options: RecorderOptions = {}
  ) {}

  /**
   * Opens an act, capturing who and when.
   *
   * The instant is taken here rather than at the outcome, so the event is stamped with when the app
   * began the act. A mutation that takes four seconds and then fails is otherwise timestamped four
   * seconds after the thing the reader is correlating it with.
   */
  begin(
    action: AuditAction,
    who: Actor,
    context: { readonly correlation?: string; readonly target?: AuditTarget } = {}
  ): Act {
    const at = (this.options.now ?? (() => new Date()))();
    let closed = false;

    const write = async (
      outcome: 'performed' | 'failed',
      target: AuditTarget | undefined,
      reason: string | undefined,
      emptied?: AuditEvent['emptied']
    ): Promise<void> => {
      // Closed once, and the first close wins.
      //
      // Not defensive tidiness: the pattern the routes use is `await act.performed(...)` and then a
      // `catch` that calls `act.failed(cause)`, and there is real work between the two — a draft
      // discarded, a response composed. When that work throws, both are called for one act, and
      // without this the log would say the same act both happened and failed. The first close is the
      // one that describes the act itself; what follows it is a different failure.
      if (closed) return;
      closed = true;

      // A target named when the act was opened stands for every outcome of it, and a close may
      // override it. Most routes know what they are acting on from the URL before they know how it
      // went, and without this each outcome would have to repeat it — so the refusal paths, which
      // are the ones worth reading, would be exactly the ones that dropped it. `settle` names none
      // at all, so this is what stops the net writing a row that says nothing about its object.
      const on = target ?? context.target;

      await this.record({
        id: this.mintId(),
        at,
        actor: who.actor,
        executionMode: who.executionMode,
        action,
        outcome,
        ...(on != null ? { target: on } : {}),
        ...(reason != null ? { reason } : {}),
        ...(context.correlation != null ? { correlation: context.correlation } : {}),
        ...(emptied != null ? { emptied } : {}),
      });
    };

    return {
      performed: (target, emptied) => write('performed', target, undefined, emptied),
      failed: (cause, target) => write('failed', target, reasonFor(cause)),
      settle: (status) =>
        status < 400 ? write('performed', undefined, undefined) : write('failed', undefined, `http-${String(status)}`),
    };
  }

  /**
   * Records an act the gate turned away.
   *
   * Its own method rather than an outcome on `Act`, because a refusal happens before the handler
   * runs: `permitted` throws, so there is nobody holding an act to close. That is also why this is
   * the one place the recorder is called from outside a route handler.
   */
  async refused(action: AuditAction, who: Actor, reason: string, target?: AuditTarget): Promise<void> {
    await this.record({
      id: this.mintId(),
      at: (this.options.now ?? (() => new Date()))(),
      actor: who.actor,
      executionMode: who.executionMode,
      action,
      outcome: 'refused',
      reason,
      ...(target != null ? { target } : {}),
    });
  }

  /** How many events this process could not write. Served on the health surface, not a debug aid. */
  get unrecorded(): number {
    return this.lost;
  }

  /**
   * What this install does about an act it cannot record.
   *
   * Read by the health surface rather than inferred there from the environment. A second reading of
   * `WAF_AUDIT_STRICT` beside this one is a second chance to disagree with the recorder that is
   * actually enforcing it, and the disagreement would surface as a page confidently reporting a
   * posture the app is not in.
   */
  get posture(): AuditPosture {
    return this.options.posture ?? 'record-and-continue';
  }

  /**
   * Refuses an act this install could not account for, before the act happens.
   *
   * Called by the gate rather than by each route, in the same place and for the same reason the
   * permission check is: a change nobody could record should not be validated, stored or partially
   * applied first. It resolves without touching the database in the default posture, so the round
   * trip is paid for only by the installs that asked for it.
   *
   * The header on this file says what the reading proves and what it does not. In short: the trail's
   * head comes back, so the table is reachable through the pool that would carry the insert. An
   * insert that would have been refused on its own terms is not covered, and that is why the close
   * keeps counting in this posture too.
   */
  async refuseIfUnrecordable(): Promise<void> {
    if (this.posture !== 'strict') return;

    try {
      await this.log.head();
    } catch (cause) {
      // Reported here as well as to the caller. The refusal is the one event this app would most
      // like in the trail and is by hypothesis the one it cannot put there, so the operator's copy
      // is all there is — the same bargain `recordRefusal` makes for a gate refusal.
      this.options.onError?.('reach the trail, so the action was refused', cause);
      throw new TrailUnwritableError(cause);
    }
  }

  /**
   * The log this writes to, for the surface that reads it back.
   *
   * Reached through the recorder rather than passed to the API a second time, so there is one log by
   * construction. Two references would be two chances to wire the trail page to a different log from
   * the one the routes append to — a page that is always empty and never wrong, which is the one
   * failure mode an audit surface must not have.
   */
  get trail(): AuditLog {
    return this.log;
  }

  /**
   * Counting in both postures, which is not an oversight.
   *
   * A strict install reaches here having already passed `refuseIfUnrecordable`, so an append that
   * fails now is one the check could not foresee — and the act it describes has happened. Rethrowing
   * would fail a response for a change that is in the database, which is the dishonest order the
   * amendment to ADR 0046 exists to avoid. So it is counted, and the health surface names the
   * posture beside the count so a strict install's non-zero reads as the gap it is.
   */
  private async record(event: AuditEvent): Promise<void> {
    try {
      await this.log.append(event);
    } catch (error) {
      this.lost += 1;
      this.options.onError?.(`record that ${event.actor} ${event.outcome} ${event.action}`, error);
    }
  }

  private mintId(): string {
    return (this.options.newId ?? (() => crypto.randomUUID()))();
  }
}

/**
 * Enough of a response to know when it ended and how. Structural, so this file needs no Express.
 */
export interface Answered {
  readonly statusCode: number;
  once(event: 'close', listener: () => void): unknown;
}

/**
 * Binds an act's close to the end of the response, and hands the act back.
 *
 * The net described on `settle`, in one place so that neither a route nor a test can stand in for it
 * with something subtly different. Every act this app opens goes through here.
 *
 * `close` rather than `finish`, because it fires on an abandoned request as well as a completed one:
 * an act the server carried out is recorded whether or not the caller stayed to read the answer. Not
 * awaited, because there is nobody left to await it — the response is already gone — and `settle`
 * resolves rather than throwing however the append went.
 */
export function closedWhenAnswered(act: Act, response: Answered): Act {
  response.once('close', () => {
    void act.settle(response.statusCode);
  });
  return act;
}

/**
 * Why an act failed, in this app's words.
 *
 * The error's *class* and never its message. `event.ts` is explicit that the log holds identifiers
 * and not contents, and an exception message is the single most likely place in this app for a
 * connection string, a host name or a fragment of a query to end up — a driver error carries all
 * three. A class name says as much as an auditor needs ("it conflicted", "the estate refused it")
 * and cannot carry an estate detail into a document that outlives the incident.
 *
 * The name is checked against an identifier shape rather than trusted, because a thrown value can
 * be anything: an object with a crafted `constructor.name` would otherwise write whatever it liked
 * into an audit row.
 */
export function reasonFor(cause: unknown): string {
  // A bare word is a reason this app chose rather than a thrown value: the import route's refusal
  // reasons and the gate's refusal kinds are already closed vocabularies, and `act.failed('replayed')`
  // says more than the `Error` a wrapper class would report. Held to the identifier shape like
  // everything else here, so it cannot become a channel for prose.
  if (typeof cause === 'string') return IDENTIFIER.test(cause) ? cause : 'unknown';

  const kind = (cause as { kind?: unknown } | null)?.kind;
  if (typeof kind === 'string' && IDENTIFIER.test(kind)) return kind;

  const name = (cause as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  return typeof name === 'string' && IDENTIFIER.test(name) ? name : 'unknown';
}

/** What a reason may look like: a class name or a refusal kind, and nothing that reads as prose. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9-]{0,60}$/;
