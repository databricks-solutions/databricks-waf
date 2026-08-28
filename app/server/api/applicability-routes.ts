// The HTTP surface for taking a requirement out of the customer's own score — as not applicable to
// their estate, or by disabling its check — on purpose, for a while.
//
// Four endpoints: read every decision, read the ones against a requirement, record one, and revoke one.
// What is absent is an endpoint that edits one, for the reason the accepted-risk routes give: an expiry
// somebody could push out would make a requirement excluded for two years read like a fresh decision. A
// longer run is a new decision naming the one it replaces; an early end is a revocation with a reason.
//
// **The reading refusal happens here, because only here can it read the scan.** `applicabilityFrom`
// refuses either lever against a `fail` or `partial` reading, and the reading it judges is resolved from
// the latest scan — with every applicability decision in force on the requirement set aside, which is a
// no-op until 31f wires applicability into scoring and becomes load-bearing the moment it does. Passed
// in as a resolver rather than read here, so this module keeps no opinion about what a scan means.
//
// **The standing is computed here**, like the accepted risks', so a page cannot show a decision as
// active against a clock that is not the server's. The lapse — a decision the reading has turned against
// — is not applied on this register: that is 31f's, on every scan, where the reading is already in hand.
// Here a decision reads by its dates alone.

import type { Application, Request, Response } from 'express';
import type { MeasuredReading } from '../apply/applicability.js';
import {
  InvalidApplicabilityError,
  effective,
  newestFirst,
  recorded,
  revoked,
  standingOf,
  applicabilityFrom,
  type ApplicabilityDecision,
  type ApplicabilityStanding,
} from '../apply/applicability.js';
import {
  AlreadyDecidedError,
  AlreadyRevokedError,
  DecisionsUnreadableError,
  type ApplicabilityStore,
} from '../apply/store.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import type { Act } from '../audit/record.js';
import type { Outcome, Severity } from '../resolve/finding.js';
import type { AssessmentScope } from '../store/assessment-scope.js';
import { stamped } from '../store/assessment-scope.js';
import { assessmentOf } from './assessment-query.js';

/** What the catalogue says about one requirement, which is all these routes may know about it. */
export interface ApplicabilityControl {
  readonly title: string;
  readonly pillarId: string;
  readonly severity: Severity;
}

export interface ApplicabilityRouteOptions {
  /** Absent means decisions are not kept, and the routes say so rather than losing one. */
  readonly applicability?: ApplicabilityStore;
  readonly controlOf: (controlId: string) => ApplicabilityControl | undefined;
  /**
   * The last reading of the requirement any scan produced, and whether it was the latest scan's.
   *
   * Absent means no scan in the history read this requirement at all, which is the case the lever is for.
   * `latest` is what keeps that apart from a requirement the most recent run did not cover: a targeted
   * rerun whose other pillars could not be carried forward leaves no finding for them, and an absent
   * finding read as "nothing measured this" let the refusal admit a requirement an earlier scan measured
   * as failing. The two callers want different halves — the refusal fires on either and says which, the
   * register only treats the latest as having set a decision aside.
   */
  readonly readingOf: (controlId: string, scope: AssessmentScope) => Promise<MeasuredReading | undefined>;
  readonly permitted: (
    request: Request,
    response: Response,
    action: AuditAction,
    context?: { readonly target?: AuditTarget }
  ) => Promise<{ readonly actor: string; readonly act: Act }>;
  readonly respondToFailure: (response: Response, cause: unknown) => void;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

interface DecisionPayload {
  readonly id: string;
  readonly controlId: string;
  readonly lever: ApplicabilityDecision['lever'];
  readonly reason: string;
  readonly owner: string;
  readonly effectiveFrom: Date;
  readonly expiresAt: Date;
  readonly recordedBy: string;
  readonly recordedAt: Date;
  readonly supersedes?: string;
  readonly revoked?: { readonly by: string; readonly at: Date; readonly reason: string };
  readonly standing: ApplicabilityStanding;
  readonly effective: boolean;
  readonly title?: string;
  readonly pillarId?: string;
  readonly severity?: Severity;
}

interface DecisionsPayload {
  readonly decisions: readonly DecisionPayload[];
  readonly controlId?: string;
  readonly durable: boolean;
  readonly durabilityNote?: string;
}

const NO_STORE =
  'Applicability decisions are not being kept on this installation, so there is nowhere to record one. ' +
  'Bind a database and restart: a requirement taken out of the score by a decision that does not survive a ' +
  'deploy would silently return to it, moving the score for a reason nobody recorded.';

export function registerApplicabilityRoutes(app: Application, options: ApplicabilityRouteOptions): void {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());

  /** Every decision this install has recorded, newest first, including expired and revoked ones. */
  app.get('/api/applicability', async (request, response) => {
    const store = options.applicability;
    if (store == null) {
      response.json(present([], false, now()));
      return;
    }
    try {
      const scope = assessmentOf(request);
      const decisions = await store.all(scope);
      response.json(present(decisions, store.durable, now(), options, undefined, await readings(decisions, options, scope)));
    } catch (cause) {
      respond(response, cause, options);
    }
  });

  /** Every decision ever recorded against one requirement, so a superseded one stays readable. */
  app.get('/api/applicability/:controlId', async (request, response) => {
    const controlId = request.params.controlId ?? '';
    const store = options.applicability;
    if (store == null) {
      response.json(present([], false, now(), options, controlId));
      return;
    }
    try {
      const scope = assessmentOf(request);
      const decisions = await store.for(controlId, scope);
      response.json(
        present(decisions, store.durable, now(), options, controlId, await readings(decisions, options, scope))
      );
    } catch (cause) {
      respond(response, cause, options);
    }
  });

  /** Records a decision, or refuses it and says which field to fix, or why the reading forbids it. */
  app.post('/api/applicability', async (request, response) => {
    const store = options.applicability;
    if (store == null) {
      response.status(503).json({ error: 'applicability-unavailable', message: NO_STORE });
      return;
    }

    let act: Act | undefined;
    try {
      // Before the body is read, like every other statement a person makes: "the requirement is excluded"
      // by somebody who wandered in is what the gate exists to prevent, and it must not be composed first
      // and rejected after.
      const permission = await options.permitted(request, response, 'applicability.record');
      act = permission.act;

      const controlId = idFrom(request.body);
      // One read, used twice: it decides whether another decision may be written at all, and it is what
      // the new record's place in the requirement's history is computed from. A failed read raises rather
      // than answering as a requirement nobody has excluded — see DecisionsUnreadableError.
      const scope = assessmentOf(request);
      const previous = controlId == null ? [] : await store.for(controlId, scope);
      // The reading resolved once, for the single requirement, so the sync rule can read it. Only where
      // the body named a requirement — an unnamed one is refused by the rule before the reading matters.
      const reading = controlId == null ? undefined : await options.readingOf(controlId, scope);
      const draft = applicabilityFrom(request.body, {
        knownControl: (id) => options.controlOf(id) != null,
        severityOf: (id) => options.controlOf(id)?.severity,
        reading: (id) => (id === controlId ? reading : undefined),
        existing: previous,
        now: now(),
      });

      const decision = stamped(recorded(draft, permission.actor, newId(), now(), previous), scope);
      await store.record(decision);
      await act.performed({ kind: 'control', id: decision.controlId });
      // The reading resolved above, rather than a second read: the record just written is presented
      // against the same reading its refusal was checked against.
      response.status(201).json(
        dated(presentDecision(decision, options, now(), false, reading?.latest === true ? reading.outcome : undefined))
      );
    } catch (cause) {
      await act?.failed(cause);
      respond(response, cause, options);
    }
  });

  /** Ends a decision before its expiry, with a reason — putting the requirement back into the score. */
  app.post('/api/applicability/:decisionId/revoke', async (request, response) => {
    const store = options.applicability;
    if (store == null) {
      response.status(503).json({ error: 'applicability-unavailable', message: NO_STORE });
      return;
    }

    let act: Act | undefined;
    try {
      const decisionId = request.params.decisionId ?? '';
      const permission = await options.permitted(request, response, 'applicability.revoke');
      act = permission.act;

      const decision = (await store.all(assessmentOf(request))).find((one) => one.id === decisionId);
      if (decision == null) {
        await refuse(response, act, 404, 'unknown-decision', `No applicability decision with id ${decisionId}.`);
        return;
      }

      const ended = revoked(decision, permission.actor, reasonFrom(request.body), now());
      await store.revoke(ended);
      await act.performed({ kind: 'control', id: ended.controlId });
      response.json(dated(presentDecision(ended, options, now())));
    } catch (cause) {
      await act?.failed(cause);
      respond(response, cause, options);
    }
  });
}

/**
 * The reading behind each requirement a decision names, so the register can say a decision has lapsed.
 *
 * One read per requirement rather than per decision, because a requirement's history is several decisions
 * and they all lapse or none do. The same `readingOf` the write path uses, so the register and the refusal
 * cannot disagree about what the estate reads.
 */
async function readings(
  decisions: readonly ApplicabilityDecision[],
  options: ApplicabilityRouteOptions,
  scope: AssessmentScope
): Promise<ReadonlyMap<string, Outcome | undefined>> {
  const ids = [...new Set(decisions.map((decision) => decision.controlId))];
  const found = await Promise.all(
    ids.map(async (id) => {
      const reading = await options.readingOf(id, scope);
      // The latest scan's only. A lapse is this run having put the requirement back into the score, and an
      // earlier run's reading did not do that — the requirement is not in the latest score at all.
      return [id, reading?.latest === true ? reading.outcome : undefined] as const;
    })
  );
  return new Map(found);
}

function present(
  decisions: readonly ApplicabilityDecision[],
  durable: boolean,
  at: Date,
  options?: ApplicabilityRouteOptions,
  controlId?: string,
  readings?: ReadonlyMap<string, Outcome | undefined>
): unknown {
  const ordered = newestFirst(decisions);
  // Superseded is a fact about the set rather than a record, so it is decided here, once: a decision is
  // superseded where a newer one for the same requirement exists.
  const newest = new Map<string, string>();
  for (const decision of ordered) if (!newest.has(decision.controlId)) newest.set(decision.controlId, decision.id);

  const payload: DecisionsPayload = {
    decisions: ordered.map((decision) =>
      presentDecision(
        decision,
        options,
        at,
        newest.get(decision.controlId) !== decision.id,
        readings?.get(decision.controlId)
      )
    ),
    ...(controlId != null ? { controlId } : {}),
    durable,
    ...(durable ? {} : { durabilityNote: NO_STORE }),
  };
  return dated(payload);
}

function presentDecision(
  decision: ApplicabilityDecision,
  options: ApplicabilityRouteOptions | undefined,
  at: Date,
  superseded = false,
  reading?: Outcome
): DecisionPayload {
  // With the reading, so `standing` can be `lapsed` and `effective` can be false for a decision the
  // latest score set aside. Without it the register reported a decision as holding while the scan it is
  // read beside had already put the requirement back — a register whose one job is to say what is in
  // force disagreeing with the score about exactly that.
  const standing = standingOf(decision, { now: at, superseded, ...(reading != null ? { reading } : {}) });
  const control = options?.controlOf(decision.controlId);
  return {
    id: decision.id,
    controlId: decision.controlId,
    lever: decision.lever,
    reason: decision.reason,
    owner: decision.owner,
    effectiveFrom: decision.effectiveFrom,
    expiresAt: decision.expiresAt,
    recordedBy: decision.recordedBy,
    recordedAt: decision.recordedAt,
    ...(decision.supersedes != null ? { supersedes: decision.supersedes } : {}),
    ...(decision.revoked != null
      ? { revoked: { by: decision.revoked.by, at: decision.revoked.at, reason: decision.revoked.reason } }
      : {}),
    standing,
    effective: effective(standing),
    ...(control != null
      ? { title: control.title, pillarId: control.pillarId, severity: control.severity }
      : {}),
  };
}

/** The requirement the body names, for the read that has to happen before the draft is validated. */
function idFrom(body: unknown): string | undefined {
  if (body == null || typeof body !== 'object') return undefined;
  const raw = (body as Record<string, unknown>).controlId;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Why it is being revoked, straight from the body. The length is enforced by `revoked` in the domain,
 * because the refusal is a rule about the record and belongs where the record is.
 */
function reasonFrom(body: unknown): string {
  if (body == null || typeof body !== 'object') return '';
  const raw = (body as Record<string, unknown>).reason;
  return typeof raw === 'string' ? raw : '';
}

async function refuse(response: Response, act: Act, status: number, error: string, message: string): Promise<void> {
  await act.failed(error);
  response.status(status).json({ error, message });
}

function respond(response: Response, cause: unknown, options: ApplicabilityRouteOptions): void {
  if (cause instanceof InvalidApplicabilityError) {
    response.status(400).json({ error: 'invalid-applicability', message: cause.message });
    return;
  }
  if (cause instanceof AlreadyRevokedError) {
    response.status(409).json({ error: 'already-revoked', message: cause.message });
    return;
  }
  if (cause instanceof AlreadyDecidedError) {
    response.status(409).json({ error: 'already-decided', message: cause.message });
    return;
  }
  if (cause instanceof DecisionsUnreadableError) {
    // 503: the decisions are unreadable, so nothing here can say whether this requirement is already
    // excluded, and writing anyway is the one outcome worth refusing.
    response.status(503).json({ error: 'applicability-unreadable', message: cause.message });
    return;
  }
  options.respondToFailure(response, cause);
}

/** Every date as an ISO string, in one traversal at the edge. See `risk-routes.ts`. */
function dated<T>(payload: T): unknown {
  if (payload instanceof Date) return payload.toISOString();
  if (Array.isArray(payload)) return payload.map((entry: unknown) => dated(entry));
  if (payload != null && typeof payload === 'object') {
    return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, dated(value)]));
  }
  return payload;
}
