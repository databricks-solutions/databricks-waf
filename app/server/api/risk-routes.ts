// The HTTP surface for accepting a requirement being unmet, on purpose, for a while.
//
// Four endpoints: read every acceptance, read the ones against a requirement, record one, and revoke
// one. What is absent is an endpoint that changes an acceptance, and the absence is the record's whole
// argument — see ADR 0054.
//
// **Nothing here edits one.** An expiry that could be pushed out would make a risk carried for two
// years indistinguishable from one accepted last week, which is the fact the record exists to keep. So
// a longer run is a new acceptance naming the one it replaces, and an early end is a revocation with a
// reason. Both leave the original readable.
//
// **The standing is computed here.** Whether an acceptance has expired is a comparison against a clock,
// and the browser's clock is not the one the queue was built from. `standing` and `effective` are on
// the wire for the reason a decision's standing is: a page that derived them would eventually show an
// acceptance as active beside a finding the server has put back on the queue.
//
// **The cap comes from the requirement, not the request.** How long a requirement may be accepted for
// is keyed off its own severity, read from the catalogue here. A cap keyed off the residual risk the
// requester claims would be a cap the requester sets.

import type { Application, Request, Response } from 'express';
import type { AcceptedRiskPayload, RisksPayload } from '../../shared/api/contract.js';
import {
  InvalidRiskError,
  acceptanceDays,
  effective,
  newestFirst,
  recorded,
  revoked,
  riskFrom,
  standingOf,
  type AcceptedRisk,
} from '../accept/risk.js';
import {
  AlreadyAcceptedError,
  AlreadyRevokedError,
  RisksUnreadableError,
  type RiskStore,
} from '../accept/store.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import type { Act } from '../audit/record.js';
import type { Severity } from '../resolve/finding.js';
import { assessmentOf } from './assessment-query.js';
import { stamped } from '../store/assessment-scope.js';

/** What the catalogue says about one requirement, which is all these routes may know about it. */
export interface RiskControl {
  readonly title: string;
  readonly pillarId: string;
  readonly severity: Severity;
}

export interface RiskRouteOptions {
  /** Absent means acceptances are not kept, and the routes say so rather than losing one. */
  readonly risks?: RiskStore;
  /** What this install does about keeping them, in the reader's terms. */
  readonly riskStorage?: string;
  readonly controlOf: (controlId: string) => RiskControl | undefined;
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

const NO_STORE =
  'Accepted risks are not being kept on this installation, so there is nowhere to record one. Bind a ' +
  'database and restart: an acceptance that does not survive a deploy is an exposure nobody is watching.';

const NOT_DURABLE =
  'Accepted risks are being kept in memory on this installation, so a restart loses every one of them — ' +
  'including their expiry dates, which is what puts the work back. Bind a database before using this in ' +
  'earnest.';

export function registerRiskRoutes(app: Application, options: RiskRouteOptions): void {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());

  /**
   * Every acceptance this install has recorded, newest first.
   *
   * Including the expired, the revoked and the superseded, because the question this list answers is
   * how long each exposure has been carried rather than what is parked today. A list of the effective
   * ones would make a requirement accepted for the fourth quarter running look like a fresh decision.
   */
  app.get('/api/risks', async (request, response) => {
    const store = options.risks;
    if (store == null) {
      // 200 with an empty list rather than 503, like the decisions list: an install with no database
      // can still be read, and the reason is in the payload where a reader will see it.
      response.json(present([], options, false, now()));
      return;
    }

    try {
      response.json(present(await store.all(assessmentOf(request)), options, store.durable, now()));
    } catch (cause) {
      // Through the same translation the writes use, so an unreadable register says it could not be read
      // rather than reporting a fault. A page told "no exceptions" by a broken read is the one reading
      // this record cannot afford.
      respond(response, cause, options);
    }
  });

  /** Every acceptance ever recorded against one requirement, so a superseded one stays readable. */
  app.get('/api/risks/:controlId', async (request, response) => {
    const controlId = request.params.controlId ?? '';
    const store = options.risks;
    if (store == null) {
      response.json(present([], options, false, now(), controlId));
      return;
    }

    try {
      const risks = await store.for(controlId, assessmentOf(request));
      response.json(present(risks, options, store.durable, now(), controlId));
    } catch (cause) {
      respond(response, cause, options);
    }
  });

  /** Records an acceptance, or refuses it and says which field to fix. */
  app.post('/api/risks', async (request, response) => {
    const store = options.risks;
    if (store == null) {
      response.status(503).json({ error: 'risks-unavailable', message: options.riskStorage ?? NO_STORE });
      return;
    }

    let act: Act | undefined;
    try {
      // Before the body is read, like every other statement a person makes here: "the risk is accepted"
      // by somebody who wandered in is the sentence the gate exists to prevent, and it must not be
      // composed first and rejected after.
      const permission = await options.permitted(request, response, 'risk.accept');
      act = permission.act;

      const controlId = idFrom(request.body);
      // One read, used twice: it decides whether another acceptance may be written at all, and it is
      // what the new record's place in the requirement's history is computed from. A failed read raises
      // rather than answering as a requirement nobody has accepted — see `RisksUnreadableError`.
      const scope = assessmentOf(request);
      const previous = controlId == null ? [] : await store.for(controlId, scope);
      const draft = riskFrom(request.body, {
        knownControl: (id) => options.controlOf(id) != null,
        severityOf: (id) => options.controlOf(id)?.severity,
        existing: previous,
        now: now(),
      });

      const risk = stamped(recorded(draft, permission.actor, newId(), now(), previous), scope);
      await store.record(risk);
      await act.performed({ kind: 'control', id: risk.controlId });
      response.status(201).json(dated(presentRisk(risk, options, now())));
    } catch (cause) {
      await act?.failed(cause);
      respond(response, cause, options);
    }
  });

  /**
   * Ends an acceptance before its expiry, with a reason.
   *
   * A second version of the same record rather than a deletion: the requirement goes back on somebody's
   * queue ahead of the date they were told to expect, and who decided that and why is the part anybody
   * comes back for.
   */
  app.post('/api/risks/:riskId/revoke', async (request, response) => {
    const store = options.risks;
    if (store == null) {
      response.status(503).json({ error: 'risks-unavailable', message: options.riskStorage ?? NO_STORE });
      return;
    }

    let act: Act | undefined;
    try {
      const riskId = request.params.riskId ?? '';
      const permission = await options.permitted(request, response, 'risk.revoke');
      act = permission.act;

      const risk = (await store.all(assessmentOf(request))).find((one) => one.id === riskId);
      if (risk == null) {
        await refuse(response, act, 404, 'unknown-risk', `No accepted risk with id ${riskId}.`);
        return;
      }

      const ended = revoked(risk, permission.actor, reasonFrom(request.body), now());
      await store.revoke(ended);
      await act.performed({ kind: 'control', id: ended.controlId });
      response.json(dated(presentRisk(ended, options, now())));
    } catch (cause) {
      await act?.failed(cause);
      respond(response, cause, options);
    }
  });
}

function present(
  risks: readonly AcceptedRisk[],
  options: RiskRouteOptions,
  durable: boolean,
  at: Date,
  controlId?: string
): unknown {
  const ordered = newestFirst(risks);
  // Superseded is a fact about the set rather than about a record, so it is decided here, once, from
  // the whole list: an acceptance is superseded where a newer one for the same requirement exists.
  const newest = new Map<string, string>();
  for (const risk of ordered) if (!newest.has(risk.controlId)) newest.set(risk.controlId, risk.id);

  const payload: RisksPayload<Date> = {
    risks: ordered.map((risk) => presentRisk(risk, options, at, newest.get(risk.controlId) !== risk.id)),
    ...(controlId != null ? { controlId } : {}),
    durable,
    ...(durable ? {} : { durabilityNote: options.riskStorage ?? NOT_DURABLE }),
    acceptanceDays: acceptanceDays(),
  };
  return dated(payload);
}

function presentRisk(
  risk: AcceptedRisk,
  options: RiskRouteOptions,
  at: Date,
  superseded = false
): AcceptedRiskPayload<Date> {
  const standing = standingOf(risk, { now: at, superseded });
  const control = options.controlOf(risk.controlId);
  return {
    id: risk.id,
    controlId: risk.controlId,
    reason: risk.reason,
    compensatingControl: risk.compensatingControl,
    residual: risk.residual,
    owner: risk.owner,
    effectiveFrom: risk.effectiveFrom,
    expiresAt: risk.expiresAt,
    recordedBy: risk.recordedBy,
    recordedAt: risk.recordedAt,
    ...(risk.supersedes != null ? { supersedes: risk.supersedes } : {}),
    ...(risk.revoked != null
      ? { revoked: { by: risk.revoked.by, at: risk.revoked.at, reason: risk.revoked.reason } }
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
 * Why it is being revoked, straight from the body.
 *
 * Required, unlike a withdrawn validation's reason, and `revoked` in the domain enforces the length
 * rather than this function: the refusal is a rule about the record and belongs where the record is.
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

function respond(response: Response, cause: unknown, options: RiskRouteOptions): void {
  if (cause instanceof InvalidRiskError) {
    response.status(400).json({ error: 'invalid-risk', message: cause.message });
    return;
  }
  if (cause instanceof AlreadyRevokedError) {
    // 409 rather than 500: somebody else revoked it between the read and the write, and the reason on
    // record is theirs. Nothing is broken and there is nothing to retry.
    response.status(409).json({ error: 'already-revoked', message: cause.message });
    return;
  }
  if (cause instanceof AlreadyAcceptedError) {
    // The same 409, for the same reason one revision along: the requirement is accepted, just not by
    // this caller, and re-sending would write a second exception rather than the one they intended.
    response.status(409).json({ error: 'already-accepted', message: cause.message });
    return;
  }
  if (cause instanceof RisksUnreadableError) {
    // 503 rather than 500: the acceptances are unreadable, so nothing here can say whether this
    // requirement is already accepted, and writing anyway is the one outcome worth refusing.
    response.status(503).json({ error: 'risks-unreadable', message: cause.message });
    return;
  }
  options.respondToFailure(response, cause);
}

/** Every date as an ISO string, in one traversal at the edge. See `improve-routes.ts`. */
function dated<T>(payload: T): unknown {
  if (payload instanceof Date) return payload.toISOString();
  if (Array.isArray(payload)) return payload.map((entry: unknown) => dated(entry));
  if (payload != null && typeof payload === 'object') {
    return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, dated(value)]));
  }
  return payload;
}
