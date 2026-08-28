// A run is a record before it is a promise.
//
// Until this existed a scan was an in-flight promise and a lock in one process's memory. Restart the
// app mid-run and the work was gone, the status was gone, and the only trace was an audit event
// saying somebody started something. For a run nobody is watching — which is the entire reason the
// scheduled path exists — that is indistinguishable from a run that never happened.
//
// ADR 0060 decided that restart-safety is a property of the record rather than of where the code
// runs, and named the four mechanisms. This file is the domain half of all four:
//
//   * a **lease** an attempt holds and renews, so two processes cannot run one assessment, and a
//     killed process does not hold a run hostage for ever;
//   * a **checkpoint** after each collection unit, so a resumed attempt starts from what was read;
//   * an **idempotency key** on the trigger, so a duplicate joins the run instead of starting a
//     second;
//   * a **cancel flag** the executor reads between units, so cancelling is a record the running
//     process obeys rather than a signal that needs it to still be listening.
//
// ## What resumption cannot do, and why it is a trigger rather than a boot hook
//
// The obvious shape is: on boot, find the runs left behind and carry on. It cannot be built, and the
// reason is worth stating because it is a property of the product rather than of this file.
//
// The app reads the estate with the *caller's* on-behalf-of token (ADR 0021). It holds no authority
// of its own and stores no credential, which is most of what makes an unattended run safe to give a
// customer. A process that woke up and resumed a run would have no token to read with, and the only
// way to give it one would be to store a credential — trading the property the design is built on
// for the convenience of not having to be asked twice.
//
// So a run resumes when it is **triggered again**: the supervisor retries, the new trigger carries
// fresh credentials, and the app joins the existing run and continues from its checkpoint. The
// actors must match, because a run whose readings were collected half as one identity and half as
// another describes an estate neither of them can see. See `joinable`.
//
// That is also the honest bound on the process-kill gate: killing the app does not lose the run, and
// it does lose the reading in flight. Resumption is one signal wide — a collector that reports each
// signal as it settles loses the one it was on, not the ones it had already read. See ADR 0066 and
// `CollectorContext.settled`.

import type { SignalId, SignalResult } from '../collect/signal.js';
import type { EstateScope } from '../collect/estate-scope.js';
import type { RunDefinition } from '../scan/identity.js';
import type { ScanTrigger } from '../scan/scan.js';

/**
 * How long an attempt's claim on a run lasts without being renewed.
 *
 * Long enough that an ordinary pause does not lose the lease — a slow warehouse statement, a garbage
 * collection, a scheduler backoff — and short enough that a killed process does not block a retry
 * for longer than a supervisor will wait. Sixty seconds against a heartbeat every fifteen means four
 * missed renewals before another attempt may take it, which is a process that has stopped rather
 * than one that is busy.
 */
export const LEASE_SECONDS = 60;

/** How often a working attempt renews its claim. A quarter of the lease, so three may be missed. */
export const HEARTBEAT_SECONDS = 15;

/**
 * What a run is for.
 *
 * Two kinds share this record because everything above is about a run's lifecycle and nothing above
 * has an opinion about its content — see ADR 0069, which also says why the alternative was a second
 * copy of the four mechanisms rather than a smaller change.
 *
 * `assessment` produces a scan and is scored. `advisory` produces perishable advice, is scored
 * nowhere, and appears in no scan record: ADR 0061 separated the two cycles, and this is the field
 * that makes the separation something the store can enforce rather than something the callers
 * remember.
 */
export type RunKind = 'assessment' | 'advisory';

export const RUN_KINDS: readonly RunKind[] = ['assessment', 'advisory'];

/** Where a run can end up, and nowhere else. */
export type RunState = 'running' | 'complete' | 'partial' | 'cancelled' | 'failed';

/** The states a run does not leave of its own accord. */
export const TERMINAL: readonly RunState[] = ['complete', 'partial', 'cancelled', 'failed'];

export function terminal(state: RunState): boolean {
  return TERMINAL.includes(state);
}

/**
 * The states in which the run said something about the estate, or somebody decided it should not.
 *
 * Narrower than {@link TERMINAL} by exactly one state, and the distinction is what a retry turns on. A
 * complete or partial run produced a scan, and a cancelled one was stopped on purpose; a second trigger
 * against any of those should be told to read the answer rather than quietly replacing it.
 *
 * A `failed` run is over and produced nothing. Refusing to retry it under its own key would mean
 * telling a caller to go and read an answer that does not exist, and forcing it to invent a new key —
 * which files each retry as a separate assessment of the estate, when what happened was one assessment
 * attempted twice. So failure is not an answer, and a retry may take a failed run back up: its
 * checkpoints are kept for that reason, and `attempts` is what records that it took more than one go.
 */
export const ANSWERED: readonly RunState[] = ['complete', 'partial', 'cancelled'];

export function answered(state: RunState): boolean {
  return ANSWERED.includes(state);
}

/** What was asked for, kept so that a resumed attempt measures the same thing. */
export interface RunRequest {
  readonly scope: EstateScope;
  readonly lookbackDays: number;
  readonly pillars?: readonly string[];
  readonly warehouse?: string;
  readonly definition?: RunDefinition;
}

/** One run, as the store holds it. */
export interface Run {
  readonly id: string;
  /**
   * What this run is for, and not optional.
   *
   * Required rather than defaulted so that a read which has not decided which kind it wants is a
   * compile error instead of a page quietly listing both — see ADR 0069. Rows written before the
   * column existed read as `assessment`, which is what they were.
   */
  readonly kind: RunKind;
  readonly requestedAt: Date;
  /**
   * Who asked. Compared against a later trigger's actor before joining, so a run's readings are all
   * collected as one identity.
   */
  readonly actor: string;
  readonly trigger: ScanTrigger;
  /**
   * What makes a repeat of the same trigger the same run.
   *
   * Absent for a person pressing a button: two admins pressing scan are two intentions, and the
   * single-run rule already refuses the second. A supervisor's retry is one intention repeated, and
   * that is what a key is for.
   */
  readonly idempotencyKey?: string;
  readonly request: RunRequest;
  readonly state: RunState;
  readonly attempts: number;
  /** Who holds the run now, and until when. Absent once no attempt does. */
  readonly lease?: { readonly holder: string; readonly until: Date };
  /** When somebody asked for this to stop. The executor reads it between collection units. */
  readonly cancelRequestedAt?: Date;
  /**
   * The scan this run produced, once it produced one. Null on an advisory run, always.
   *
   * An advisory run's output gets its own pointer rather than borrowing this one, because a column
   * named for one kind of output and holding another is how advice ends up exported as an assessment.
   */
  readonly scanId?: string;
  /** The advisory this run produced, once it produced one. Null on an assessment run, always. */
  readonly advisoryId?: string;
  readonly finishedAt?: Date;
  /** Why it ended as it did, for the states where that is not obvious. */
  readonly why?: string;
}

/** One attempt at a run, so that a retry is a fact rather than an increment. */
export interface RunAttempt {
  readonly id: string;
  readonly runId: string;
  readonly number: number;
  readonly holder: string;
  readonly startedAt: Date;
  readonly heartbeatAt: Date;
  readonly endedAt?: Date;
  /** How it ended. `abandoned` is what another attempt records about the one it took over from. */
  readonly outcome?: 'complete' | 'partial' | 'cancelled' | 'failed' | 'abandoned';
}

/** One collection unit's readings, kept so a resumed attempt does not read them again. */
export interface Checkpoint {
  readonly runId: string;
  readonly at: Date;
  readonly readings: readonly SignalResult[];
}

/**
 * Whether a run's claim has lapsed as at `now`.
 *
 * A run with no lease is unheld — either nothing has claimed it yet, or an attempt released it. A
 * lease whose `until` has passed is one whose holder stopped renewing, which is the only evidence
 * available that a process died: it cannot be asked, and waiting for it to say so is what leaves a
 * run stuck for ever.
 */
export function unheld(run: Run, now: Date): boolean {
  return run.lease == null || run.lease.until.getTime() <= now.getTime();
}

/** Why a trigger may not join a run, or `undefined` when it may. */
export type Refusal = 'terminal' | 'held' | 'other-actor' | 'other-request' | 'other-kind';

/**
 * Whether a repeated trigger may join an existing run and carry it on.
 *
 * The refusals are different mistakes and it matters which is reported. A run that already
 * answered should be read rather than replaced. A held run is being worked on by a process that is
 * still alive, so joining would put two attempts on one assessment. A run asked for by somebody
 * else, or for something else, is not this trigger's run at all and continuing it would produce an
 * assessment attributed to a request nobody made.
 *
 * Answered rather than terminal, which lets a retry take up a run whose attempt broke — see
 * {@link ANSWERED} for why failure is the one ending that is not an answer.
 *
 * The kind is compared before the request, and it is its own refusal rather than a difference in the
 * request. Two kinds share one key space (ADR 0069), so a key naming an assessment can be presented
 * by an advisory trigger; reporting that as `other-request` would be true and useless, because the
 * scope and window it names may match exactly and the caller would go looking for a difference that
 * is not there.
 */
export function joinable(
  run: Run,
  by: { readonly actor: string; readonly kind: RunKind; readonly request: RunRequest },
  now: Date
): Refusal | undefined {
  if (answered(run.state)) return 'terminal';
  if (run.kind !== by.kind) return 'other-kind';
  if (run.actor !== by.actor) return 'other-actor';
  if (!sameRequest(run.request, by.request)) return 'other-request';
  if (!unheld(run, now)) return 'held';
  return undefined;
}

/**
 * Whether two requests measure the same thing.
 *
 * Compared field by field rather than by deep equality of the whole object, because two of the
 * fields are allowed to differ and silently accepting a difference in the others would resume a run
 * that had been asked a different question — the mirror of the fingerprint rule for definitions.
 *
 * Field by field all the way down, and that is not fastidiousness. This compared scopes by
 * `JSON.stringify` and a live run found it: one side is the scope the caller just built and the other
 * has been through `jsonb`, which stores an object by its own key order rather than the one it arrived
 * in. Two identical scopes stringified to different strings, so the supervisor's retry after the app
 * was killed mid-scan was refused as a different request — the one moment the whole design exists for.
 */
export function sameRequest(one: RunRequest, other: RunRequest): boolean {
  return (
    one.lookbackDays === other.lookbackDays &&
    sameScope(one.scope, other.scope) &&
    sameList(one.pillars, other.pillars) &&
    one.definition?.id === other.definition?.id &&
    one.definition?.version === other.definition?.version
  );
}

/**
 * Whether two scopes cover the same estate.
 *
 * `description` is deliberately not compared. It is prose derived from the three fields that are, and
 * comparing it would mean a run could not be resumed across a release that reworded a sentence — a
 * refusal with no estate behind it, reported to a supervisor as a request that measures something
 * else.
 */
function sameScope(one: EstateScope, other: EstateScope): boolean {
  return (
    one.hostWorkspaceId === other.hostWorkspaceId &&
    one.narrowedTo === other.narrowedTo &&
    sameList(one.selected, other.selected)
  );
}

/**
 * Whether two lists name the same things, in whatever order.
 *
 * Absent and empty compare equal because neither field this serves can be empty: an empty selection is
 * refused where it is built, and an empty pillar list is refused at the route. What arrives here is a
 * list of somethings or nothing at all.
 */
function sameList(one: readonly string[] | undefined, other: readonly string[] | undefined): boolean {
  const first = [...(one ?? [])].sort();
  const second = [...(other ?? [])].sort();
  return first.length === second.length && first.every((value, at) => value === second[at]);
}

/**
 * The state a finished scan leaves its run in.
 *
 * `partial` rather than `complete` for a scan that was cut short, and `cancelled` only when somebody
 * asked: a run that hit its budget and one somebody stopped are both partial assessments, and a
 * reader deciding whether to re-run needs to know which. A cancelled run still has a scan, because
 * the readings it reached are real and are saved — see `ScanRunner`.
 */
export function endedAs(scan: { readonly state: 'complete' | 'partial' }, cancelled: boolean): RunState {
  if (cancelled) return 'cancelled';
  return scan.state === 'complete' ? 'complete' : 'partial';
}

/** The readings a resumed attempt starts from, newest checkpoint of a signal winning. */
export function resumeFrom(checkpoints: readonly Checkpoint[]): Map<SignalId, SignalResult> {
  const readings = new Map<SignalId, SignalResult>();
  for (const checkpoint of [...checkpoints].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    for (const reading of checkpoint.readings) readings.set(reading.id, reading);
  }
  return readings;
}

/**
 * What to tell a caller whose trigger could not join the run their key names.
 *
 * Here rather than at the route because the same four sentences are owed to an HTTP caller and to
 * the job's task output, and because the useful part of each is which of the four it is.
 */
export function refusalMeans(refusal: Refusal, run: Run): string {
  switch (refusal) {
    case 'terminal':
      return (
        `That run already finished as ${run.state}${run.scanId == null ? '' : `, recorded as scan ${run.scanId}`}. ` +
        'Read it rather than running it again, or trigger a new run with a new key.'
      );
    case 'held':
      return (
        'That run is being worked on by a process that is still renewing its claim on it, so this ' +
        'would be a second attempt at one assessment. Wait for it, or read its progress.'
      );
    case 'other-actor':
      return (
        `That run was asked for by ${run.actor}. A run's readings are collected as one identity, so ` +
        'continuing somebody else\u2019s run would describe an estate neither of you can see.'
      );
    case 'other-request':
      return (
        'That key names a run that was asked a different question — a different scope, window, ' +
        'pillar set or assessment version. Continuing it would answer the earlier request under this ' +
        'one\u2019s name.'
      );
    case 'other-kind':
      return (
        `That key names ${run.kind === 'assessment' ? 'an assessment' : 'an advisory'} run, and this ` +
        `trigger is ${run.kind === 'assessment' ? 'an advisory' : 'an assessment'} one. The two are ` +
        'separate cycles that happen to share a key space, so this needs a key of its own rather than ' +
        'continuing that run.'
      );
  }
}
