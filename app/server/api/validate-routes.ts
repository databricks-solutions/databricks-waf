// The HTTP surface for validating a claim that work was done.
//
// Three endpoints: read the attempts against an action, ask for one, and withdraw a claim that is
// waiting. There is no fourth, and the absence is the design rather than a gap — see ADR 0053.
//
// **Nothing here answers an attempt.** An answer is a reading of the estate, so a run produces it,
// from `validate/resolve.ts` after a scan is saved. This module never calls `answeredBy`. That is the
// same rule ADR 0051 wrote for `verified` one layer up, and it is enforced the same way: the vocabulary
// has `validation.request` and `validation.withdraw` and no `validation.answer`, because no request can
// cause one.
//
// **What a caller may supply is one number.** Everything else about an attempt — which requirements,
// how each is answered, the date the claim was made — comes from the action and the catalogue. A
// request that could name its own requirements would be a request to validate something else, and one
// that could choose `attested` for a measurable requirement could validate it by saying so.
//
// **The reading says whether asking is possible, and why not.** `mayRequest` and `whyNot` are computed
// here from the domain's own refusal, so the surface offers the button exactly when the server would
// accept it. A client that decided for itself would be a second copy of the rule, and the copy is what
// offers a button that 400s.

import type { Application, Request, Response } from 'express';
import type {
  AttemptCheckPayload,
  ValidationAttemptPayload,
  ValidationsPayload,
} from '../../shared/api/contract.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import type { Act } from '../audit/record.js';
import type { Measurability } from '../catalogue/catalogue.js';
import type { ImprovementAction } from '../improve/action.js';
import type { ImprovementStore } from '../improve/store.js';
import { assessmentOf } from './assessment-query.js';
import {
  InvalidAttemptError,
  MAX_OBSERVE_DAYS,
  abandoned,
  draftFrom,
  newestFirst,
  requested,
  whyNotRequestable,
  type ValidationAttempt,
} from '../validate/attempt.js';
import { AlreadyAnsweredError, type ValidationStore } from '../validate/store.js';

export interface ValidateRouteOptions {
  /** Absent means validations are not kept, and the routes say so rather than losing one. */
  readonly validations?: ValidationStore;
  /** What this install does about keeping them, in the reader's terms. */
  readonly validationStorage?: string;
  /**
   * Where the actions are.
   *
   * Required, unlike the validation store: an attempt is a question about an action, and a surface
   * that could ask one without reading the action would be asking about an id.
   */
  readonly improvements?: ImprovementStore;
  /** What the catalogue says about a requirement, which decides how each one may be answered. */
  readonly measurabilityOf: (controlId: string) => Measurability | undefined;
  readonly titleOf: (controlId: string) => string | undefined;
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
  'This installation is not keeping validations, so there is nowhere to record one. Bind a database and ' +
  'restart, and the claims you ask a run to check will survive a deploy.';

const NOT_DURABLE =
  'Validations are being kept in memory on this installation, so a restart loses every attempt, ' +
  'including the ones that failed. The record of how many runs it took to hold is the part that is ' +
  'hardest to reconstruct afterwards — bind a database before using this in earnest.';

const NO_ACTIONS =
  'This installation is not keeping improvement plans, so there are no claims to validate. Bind a ' +
  'database and restart.';

export function registerValidateRoutes(app: Application, options: ValidateRouteOptions): void {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());

  /**
   * Every attempt against one action, and whether another may be asked for.
   *
   * Addressed under the action rather than under a validations collection of its own, because an
   * attempt is never read on its own: the question is always what has been tried on this claim.
   */
  app.get('/api/improvements/:planId/actions/:actionId/validations', async (request, response) => {
    const actionId = request.params.actionId ?? '';

    try {
      const action = await options.improvements?.action(actionId, assessmentOf(request));
      if (options.improvements == null || action == null) {
        response.status(404).json({
          error: 'unknown-action',
          message: options.improvements == null ? NO_ACTIONS : `No improvement action with id ${actionId}.`,
        });
        return;
      }

      // 200 with an empty list rather than 503, like the plans list: an install with no database can
      // still be looked at, and the reason is in the payload where a reader will see it.
      if (options.validations == null) {
        response.json(present(actionId, [], action, options, false));
        return;
      }

      const attempts = newestFirst(await options.validations.for(actionId));
      response.json(present(actionId, attempts, action, options, options.validations.durable));
    } catch (cause) {
      options.respondToFailure(response, cause);
    }
  });

  /** Asks for the claim on this action to be checked by a run. */
  app.post('/api/improvements/:planId/actions/:actionId/validations', async (request, response) => {
    if (options.validations == null || options.improvements == null) {
      response.status(503).json({
        error: 'validations-unavailable',
        message: options.validations == null ? NO_STORE : NO_ACTIONS,
      });
      return;
    }
    const store = options.validations;
    const actions = options.improvements;

    let act: Act | undefined;
    try {
      const actionId = request.params.actionId ?? '';
      // Before the action is read, like every other mutation here: a validation nobody is permitted to
      // ask for should not be composed first.
      const permission = await options.permitted(request, response, 'validation.request', {
        target: { kind: 'action', id: actionId },
      });
      act = permission.act;

      const action = await actions.action(actionId, assessmentOf(request));
      if (action == null) {
        await refuse(response, act, 404, 'unknown-action', `No improvement action with id ${actionId}.`);
        return;
      }

      const draft = draftFrom(action, request.body, {
        measurabilityOf: options.measurabilityOf,
        existing: await store.for(actionId),
      });
      const attempt = requested(draft, permission.actor, newId(), now());
      await store.add(attempt);
      // The action rather than the attempt, and the reason is the one the notes ADR gives for filing a
      // note under its subject: the question an auditor asks is what happened to this piece of work, and
      // one search then answers it across the raising, the moves and the validations. An attempt id
      // answers a question nobody has.
      await act.performed({ kind: 'action', id: action.id });
      response.status(201).json(dated(presentAttempt(attempt, options)));
    } catch (cause) {
      await act?.failed(cause);
      respond(response, cause, options);
    }
  });

  /**
   * Withdraws a claim that is waiting on a run.
   *
   * A withdrawal closes the attempt as incomplete rather than deleting it, so the record still says
   * somebody offered work for validation and took it back. It does not move the action: taking the work
   * back to `in-progress` is a separate act with its own audit event, and doing both from one endpoint
   * would make one refusal undo half of two changes.
   */
  app.post(
    '/api/improvements/:planId/actions/:actionId/validations/:validationId/withdraw',
    async (request, response) => {
      if (options.validations == null) {
        response.status(503).json({ error: 'validations-unavailable', message: NO_STORE });
        return;
      }
      const store = options.validations;

      let act: Act | undefined;
      try {
        const actionId = request.params.actionId ?? '';
        const validationId = request.params.validationId ?? '';
        const permission = await options.permitted(request, response, 'validation.withdraw', {
          target: { kind: 'action', id: actionId },
        });
        act = permission.act;

        const action = await options.improvements?.action(actionId, assessmentOf(request));
        if (options.improvements == null || action == null) {
          await refuse(
            response,
            act,
            404,
            'unknown-action',
            options.improvements == null ? NO_ACTIONS : `No improvement action with id ${actionId}.`
          );
          return;
        }

        const attempts = await store.for(actionId);
        const attempt = attempts.find((one) => one.id === validationId);
        if (attempt == null) {
          await refuse(
            response,
            act,
            404,
            'unknown-validation',
            `No validation with id ${validationId} against action ${actionId}.`
          );
          return;
        }
        if (attempt.answer != null) {
          await refuse(
            response,
            act,
            409,
            'already-answered',
            'This validation has already been answered by a run, so there is nothing waiting to withdraw. Its ' +
              'answer stays on the record either way.'
          );
          return;
        }

        const why = whyFrom(request.body, permission.actor);
        const closed = abandoned(attempt, why, now());
        await store.answer(closed);
        await act.performed({ kind: 'action', id: actionId });
        response.json(dated(presentAttempt(closed, options)));
      } catch (cause) {
        await act?.failed(cause);
        respond(response, cause, options);
      }
    }
  );
}

function present(
  actionId: string,
  attempts: readonly ValidationAttempt[],
  action: ImprovementAction,
  options: ValidateRouteOptions,
  durable: boolean
): unknown {
  const refusal =
    options.validations == null
      ? NO_STORE
      : whyNotRequestable(action, { measurabilityOf: options.measurabilityOf, existing: attempts });

  const payload: ValidationsPayload<Date> = {
    actionId,
    attempts: attempts.map((attempt) => presentAttempt(attempt, options)),
    mayRequest: refusal == null,
    ...(refusal != null ? { whyNot: refusal } : {}),
    maxObserveDays: MAX_OBSERVE_DAYS,
    durable,
    ...(durable ? {} : { durabilityNote: options.validationStorage ?? NOT_DURABLE }),
  };
  return dated(payload);
}

function presentAttempt(attempt: ValidationAttempt, options: ValidateRouteOptions): ValidationAttemptPayload<Date> {
  return {
    id: attempt.id,
    planId: attempt.planId,
    actionId: attempt.actionId,
    checks: attempt.checks.map((check): AttemptCheckPayload => {
      const title = options.titleOf(check.controlId);
      return { controlId: check.controlId, method: check.method, ...(title != null ? { title } : {}) };
    }),
    claimedAt: attempt.claimedAt,
    requestedBy: attempt.requestedBy,
    requestedAt: attempt.requestedAt,
    observeFrom: attempt.observeFrom,
    observeDays: attempt.observeDays,
    ...(attempt.answer != null
      ? {
          answer: {
            result: attempt.answer.result,
            ...(attempt.answer.scanId != null ? { scanId: attempt.answer.scanId } : {}),
            at: attempt.answer.at,
            unmet: attempt.answer.unmet,
            unreadable: attempt.answer.unreadable,
            ...(attempt.answer.why != null ? { why: attempt.answer.why } : {}),
          },
        }
      : {}),
  };
}

/**
 * Why the claim is being withdrawn, with the withdrawer's name in it.
 *
 * A reason is optional here, unlike on a cancelled action, and the difference is what the sentence is
 * for: a cancelled action is a decision a colleague inherits and cannot interpret, where a withdrawn
 * validation is a question taken back before anything answered it. Demanding prose for it would mostly
 * collect "wrong workspace" — which the default already says as well as it can be said.
 */
function whyFrom(body: unknown, actor: string): string {
  const raw = body == null || typeof body !== 'object' ? {} : (body as Record<string, unknown>);
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  const withdrawn = `${actor} withdrew the claim before a run answered it`;
  return reason === '' ? `${withdrawn}.` : `${withdrawn}: ${reason}`;
}

async function refuse(response: Response, act: Act, status: number, error: string, message: string): Promise<void> {
  await act.failed(error);
  response.status(status).json({ error, message });
}

function respond(response: Response, cause: unknown, options: ValidateRouteOptions): void {
  if (cause instanceof InvalidAttemptError) {
    response.status(400).json({ error: 'invalid-validation', message: cause.message });
    return;
  }
  if (cause instanceof AlreadyAnsweredError) {
    // 409 rather than 500: a run answered the attempt between the read and the write, and nothing is
    // broken. The answer on record is the run's, which is the one that counts.
    response.status(409).json({ error: 'already-answered', message: cause.message });
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
