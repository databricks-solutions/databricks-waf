// The HTTP surface for improvement plans and the actions in them.
//
// Its own module for the reason `definition-routes.ts` is: `routes.ts` is two thousand lines and the
// next reader of it should not have to thread a fifth resource through it. The gate and the failure
// responder arrive as functions, which is what makes this file testable against a stub that says yes
// or no rather than against a SCIM endpoint.
//
// Three things here are not obvious from the domain, and each is a property only a route can hold.
//
// **No route can verify an action.** `moved` refuses the transition — the table marks it `by: 'run'` —
// and this module never calls `verifiedBy`. So the vocabulary is `action.move` rather than
// `action.verify`, and a caller who sends `{ to: 'verified' }` gets the domain's own sentence about
// why nobody marks their own work verified. The alternative, an endpoint that took the word and
// refused it silently, would be a lifecycle whose central rule is invisible from the outside.
//
// **Progress is computed per request, against the run being read.** Nothing about an agreement is
// stored, so every read joins the actions to the latest run's findings. That makes the reading correct
// by construction and it makes these routes read the scan store, which is why it is a required option
// rather than an optional one: a build that served plans without findings would report every claim as
// `awaiting` for ever and look like it was working.
//
// **A plan is read before an action is written to it.** `addAction` and `changeAction` take the plan,
// so the route has to have read it — which is the read it needed anyway to refuse work on a closed
// plan. See `store.ts` for the retention half of that argument.
//
// ADR 0051.

import type { Application, Request, Response } from 'express';
import type {
  ActionsForControlPayload,
  ActionsRaisedPayload,
  ActionTransitionPayload,
  AdviceProvenancePayload,
  AdviceReadingPayload,
  ExportFilePayload,
  ExportRecordPayload,
  ImprovementActionPayload,
  ImprovementPlanDetailPayload,
  ImprovementPlanPayload,
  ImprovementsPayload,
  PlanExportsPayload,
  PlanProgressPayload,
  ValueReportPayload,
} from '../../shared/api/contract.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import type { Act } from '../audit/record.js';
import { DIGEST_HEADER, howToCheck, sealPlan } from '../export/artefact.js';
import {
  DEFAULT_PLAN_VARIANT,
  PLAN_VARIANT_SHAPES,
  PLAN_VARIANTS,
  planVariantOf,
  type PlanExportOptions,
  type PlanVariant,
} from '../export/plan-document.js';
import {
  InvalidActionError,
  MIN_PROSE,
  draftFrom as actionDraftFrom,
  moved,
  movesFor,
  revised,
  type ActionState,
  type ImprovementAction,
  type Transition,
} from '../improve/action.js';
import {
  UnknownAdviceError,
  adviceFrom,
  type AdviceProvenance,
  type AdviceReference,
} from '../improve/advice.js';
import { adviceReadingOf, type AdviceReading } from '../improve/advice-reading.js';
import { valueOf, type Money } from '../improve/value.js';
import type { Advisory } from '../advise/advisory.js';
import type { AdvisoryStore } from '../advise/store.js';
import { currentVersion } from '../define/definition.js';
import { InvalidPlanError, closed, draftFrom as planDraftFrom, type ImprovementPlan } from '../improve/plan.js';
import {
  planProgress,
  progressOf,
  type ActionProgress,
  type AgreementContext,
  type PlanProgress,
} from '../improve/progress.js';
import { ConcurrentChangeError, MismatchedPlanError, type ImprovementStore } from '../improve/store.js';
import type { ScanStore } from '../scan/store.js';
import type { Finding } from '../resolve/finding.js';
import type { DefinitionStore } from '../define/store.js';
import type { AssessmentScope } from '../store/assessment-scope.js';
import { assessmentOf, scopedHref } from './assessment-query.js';

export interface ImproveRouteOptions {
  /** Absent means plans are not kept, and the routes say so rather than losing one. */
  readonly improvements?: ImprovementStore;
  /** What this install does about keeping them, in the reader's terms. */
  readonly improvementStorage?: string;
  /**
   * The run every agreement is judged against.
   *
   * Required rather than optional. See the note at the top: plans served without findings would report
   * every claim as awaiting and look healthy while saying nothing.
   */
  readonly store: ScanStore;
  /** Whether a requirement exists, so an action cannot name one the framework does not have. */
  readonly knownControl: (id: string) => boolean;
  /** The requirement's title, for a board that would otherwise be a column of ids. */
  readonly titleOf: (id: string) => string | undefined;
  /** Where assessments are kept, so a plan cannot cite a version that does not exist. */
  readonly definitions?: DefinitionStore;
  /**
   * Where advisories are kept, so an action raised from advice can be given its provenance.
   *
   * Optional, and its absence refuses those actions rather than storing them without provenance: the
   * whole of what such an action is about lives in the advisory, and one recorded against an advisory
   * nobody kept would be a row saying an advisor said something, with no way to find out what.
   */
  readonly advisories?: AdvisoryStore;
  /** Establishes that the caller may change something, or throws, and opens the act for the log. */
  readonly permitted: (
    request: Request,
    response: Response,
    action: AuditAction,
    context?: { readonly target?: AuditTarget }
  ) => Promise<{ readonly actor: string; readonly act: Act }>;
  readonly respondToFailure: (response: Response, cause: unknown) => void;
  /**
   * Opens an act for a read nobody has to be permitted to make. Absent means this install records
   * nothing, and the export routes still serve.
   *
   * Separate from `permitted` because it is the opposite kind of thing: `permitted` establishes that a
   * caller may change something and throws when they may not, and this only ever opens a row. Passing
   * the guarded one and ignoring its refusal would put a gate on a download that has never had one.
   */
  readonly recordRead?: (
    request: Request,
    response: Response,
    action: AuditAction,
    context?: { readonly correlation?: string }
  ) => Act;
  /**
   * What has already been exported under this correlation, and whether a download now would match.
   *
   * Injected rather than reimplemented, because `routes.ts` already answers this question for the
   * assessment's exports and the comparison is the delicate half: a row shown as no longer matching is
   * a statement about this app rather than about the recipient's copy. Absent means no trail is bound,
   * which is an install where the digests are still worth publishing and nothing recorded who took one.
   */
  readonly takenFrom?: (
    action: AuditAction,
    correlation: string,
    current: ReadonlyMap<string, string>
  ) => Promise<readonly ExportRecordPayload<string>[]>;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

const NO_STORE =
  'This installation is not keeping improvement plans, so there is nowhere to put one. Bind a database ' +
  'and restart, and the plans you open will survive a deploy.';

const NOT_DURABLE =
  'Improvement plans are being kept in memory on this installation, so a restart loses every plan and ' +
  'every action in it. A plan is a fortnight of agreements between people about who is doing what, and ' +
  'nothing in the estate can reconstruct it — bind a database before using this in earnest.';

export function registerImproveRoutes(app: Application, options: ImproveRouteOptions): void {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());
  /** What the estate says, and when "now" is, for one response. See `judgedAgainst`. */
  const judged = (request: Request): Promise<AgreementContext> =>
    judgedAgainst(options, now(), assessmentOf(request));

  /**
   * Every plan, with the rollup of its actions.
   *
   * Closed plans included, like the definitions list and for the same reason: a closed plan is the
   * record of a period, and last quarter's is exactly the one somebody is looking for.
   *
   * The actions themselves are not sent. A list page shows counts and the three lists that matter —
   * contradicted, overdue, blocked — and sending every action of every plan would grow with the
   * programme rather than with the page.
   */
  app.get('/api/improvements', async (request, response) => {
    const store = options.improvements;
    if (store == null) {
      // 200 rather than 503, like the definitions list: an install with no database can still be
      // looked at, and a page that failed to load says less than an empty one that explains itself.
      response.json({ durable: false, durabilityNote: NO_STORE, plans: [], minProse: MIN_PROSE });
      return;
    }

    try {
      const scope = assessmentOf(request);
      const plans = await store.plans(scope);
      const context = await judged(request);
      // One read of every action rather than one per plan. `actions(planId)` in a loop is the same rows
      // fetched n times, and the rollup needs them all anyway.
      const actions = await Promise.all(plans.map((plan) => store.actions(plan.id, scope)));

      const payload: ImprovementsPayload<Date> = {
        durable: store.durable,
        ...(store.durable ? {} : { durabilityNote: options.improvementStorage ?? NOT_DURABLE }),
        plans: plans.map((plan, index) => presentPlan(plan, actions[index] ?? [], context)),
        ...(context.measuredAt != null ? { measuredAt: context.measuredAt } : {}),
        // Over every plan rather than per plan, and computed from the same readings the rows above
        // were: two passes would be two answers about one board.
        ...(await valuePayload(actions.flat(), context, options, scope)),
        minProse: MIN_PROSE,
      };
      response.json(dated(payload));
    } catch (cause) {
      options.respondToFailure(response, cause);
    }
  });

  app.post('/api/improvements', async (request, response) => {
    const store = options.improvements;
    if (store == null) {
      response.status(503).json({ error: 'improvements-unavailable', message: NO_STORE });
      return;
    }

    let act: Act | undefined;
    try {
      // Before the body is read, like every other mutation here: a plan nobody is permitted to open
      // should not be validated first.
      const permission = await options.permitted(request, response, 'plan.open');
      const { actor } = permission;
      act = permission.act;

      const draft = planDraftFrom(request.body, { knownAssessment: await assessmentReader(options) });
      const assessment = draft.assessment ?? (await citedFromQuery(request, options));
      const plan: ImprovementPlan = {
        ...draft,
        ...(assessment != null ? { assessment } : {}),
        id: newId(),
        createdBy: actor,
        createdAt: now(),
        revision: 0,
      };
      await store.addPlan(plan);
      await act.performed({ kind: 'plan', id: plan.id });
      response.status(201).json(dated(presentPlan(plan, [], await judged(request))));
    } catch (cause) {
      await act?.failed(cause);
      respond(response, cause, options);
    }
  });

  /**
   * Every action currently raised, so a page that lists many requirements can ask once.
   *
   * Registered before `/:id` because `raised` is one path segment and would otherwise be read as a
   * plan id. The per-requirement route stays: a findings pane that shows one control still asks
   * about that control.
   */
  app.get('/api/improvements/raised', async (request, response) => {
    const store = options.improvements;
    if (store == null) {
      response.json({ actions: [], durable: false, durabilityNote: NO_STORE, minProse: MIN_PROSE });
      return;
    }

    try {
      const actions = await store.actionsRaised(assessmentOf(request));
      const context = await judged(request);
      const payload: ActionsRaisedPayload<Date> = {
        actions: sorted(actions).map((action) => presentAction(progressOf(action, context), options)),
        durable: store.durable,
        ...(store.durable ? {} : { durabilityNote: options.improvementStorage ?? NOT_DURABLE }),
        ...(context.measuredAt != null ? { measuredAt: context.measuredAt } : {}),
        minProse: MIN_PROSE,
      };
      response.json(dated(payload));
    } catch (cause) {
      options.respondToFailure(response, cause);
    }
  });

  /** One plan and every action in it, which is what the plan's own page reads. */
  app.get('/api/improvements/:id', async (request, response) => {
    const store = options.improvements;
    if (store == null) {
      response.status(404).json({ error: 'unknown-plan', message: NO_STORE });
      return;
    }

    try {
      const id = request.params.id ?? '';
      const plan = await store.plan(id, assessmentOf(request));
      if (plan == null) {
        response.status(404).json({ error: 'unknown-plan', message: `No improvement plan with id ${id}.` });
        return;
      }

      const actions = await store.actions(id, assessmentOf(request));
      const context = await judged(request);
      const payload: ImprovementPlanDetailPayload<Date> = {
        plan: presentPlan(plan, actions, context),
        actions: sorted(actions).map((action) => presentAction(progressOf(action, context), options)),
        durable: store.durable,
        ...(store.durable ? {} : { durabilityNote: options.improvementStorage ?? NOT_DURABLE }),
        ...(context.measuredAt != null ? { measuredAt: context.measuredAt } : {}),
        minProse: MIN_PROSE,
      };
      response.json(dated(payload));
    } catch (cause) {
      options.respondToFailure(response, cause);
    }
  });

  /**
   * Closes a plan, which is refused while any action in it is still live.
   *
   * Closed rather than deleted, and the refusal is the plan's only rule of its own — `plan.ts` says
   * why a closed plan with live actions under it is the state a programme review is misled by.
   */
  app.post('/api/improvements/:id/close', async (request, response) => {
    const store = options.improvements;
    if (store == null) {
      response.status(503).json({ error: 'improvements-unavailable', message: NO_STORE });
      return;
    }

    let act: Act | undefined;
    try {
      const id = request.params.id ?? '';
      const target = { kind: 'plan', id } as const;
      const permission = await options.permitted(request, response, 'plan.close', { target });
      const { actor } = permission;
      act = permission.act;

      const plan = await store.plan(id, assessmentOf(request));
      if (plan == null) {
        await refuse(response, act, 404, 'unknown-plan', `No improvement plan with id ${id}.`);
        return;
      }

      const reason = reasonFrom(request.body);
      const shut = closed(plan, await store.actions(id, assessmentOf(request)), { by: actor, reason, at: now() });
      await store.changePlan(shut);
      await act.performed(target);
      response.json(dated(presentPlan(shut, await store.actions(id, assessmentOf(request)), await judged(request))));
    } catch (cause) {
      await act?.failed(cause);
      respond(response, cause, options);
    }
  });

  /**
   * Raises an action in a plan.
   *
   * The plan is read first, and a closed one is refused: adding work to a closed plan would make its
   * rollup wrong the moment it was written, and the honest answer is that the plan has to be reopened —
   * which it cannot be, so the work belongs in a new one.
   */
  app.post('/api/improvements/:id/actions', async (request, response) => {
    const store = options.improvements;
    if (store == null) {
      response.status(503).json({ error: 'improvements-unavailable', message: NO_STORE });
      return;
    }

    let act: Act | undefined;
    try {
      const planId = request.params.id ?? '';
      const permission = await options.permitted(request, response, 'action.raise', {
        target: { kind: 'plan', id: planId },
      });
      const { actor } = permission;
      act = permission.act;

      const plan = await store.plan(planId, assessmentOf(request));
      if (plan == null) {
        await refuse(response, act, 404, 'unknown-plan', `No improvement plan with id ${planId}.`);
        return;
      }
      if (plan.closed != null) {
        await refuse(
          response,
          act,
          409,
          'plan-closed',
          `This plan was closed on ${plan.closed.at.toISOString().slice(0, 10)}. Raise the action in an open plan, ` +
            'so that what the plan reports finished stays true.'
        );
        return;
      }

      const siblings = await store.actions(planId, assessmentOf(request));
      const adviceFor = await adviceReader(request, options);
      const draft = actionDraftFrom(
        // The plan comes from the path rather than the body, so a request cannot name one plan in its
        // URL and another in its payload and have the two disagree about where the work landed.
        { ...asObject(request.body), planId },
        {
          knownControl: options.knownControl,
          siblings,
          now: now(),
          ...(adviceFor != null ? { adviceFor } : {}),
        }
      );
      const action: ImprovementAction = {
        ...draft,
        id: newId(),
        state: 'draft',
        createdBy: actor,
        createdAt: now(),
        history: [],
        revision: 0,
      };
      await store.addAction(action, plan);
      await act.performed({ kind: 'action', id: action.id });
      response.status(201).json(dated(presentAction(progressOf(action, await judged(request)), options)));
    } catch (cause) {
      await act?.failed(cause);
      respond(response, cause, options);
    }
  });

  /**
   * Replaces the revisable fields of an action.
   *
   * A whole replacement rather than a patch, for the reason `revised` gives. What it refuses is in the
   * domain: nothing about a verified or cancelled action, and nothing about what a live action is *for*
   * — only who is doing it, how much it matters, by when, and in what steps.
   */
  app.put('/api/improvements/:id/actions/:actionId', async (request, response) => {
    const store = options.improvements;
    if (store == null) {
      response.status(503).json({ error: 'improvements-unavailable', message: NO_STORE });
      return;
    }

    let act: Act | undefined;
    try {
      const planId = request.params.id ?? '';
      const actionId = request.params.actionId ?? '';
      const target = { kind: 'action', id: actionId } as const;
      act = (await options.permitted(request, response, 'action.revise', { target })).act;

      const plan = await store.plan(planId, assessmentOf(request));
      const action = await store.action(actionId, assessmentOf(request));
      if (plan == null || action == null || action.planId !== planId) {
        await refuse(response, act, 404, 'unknown-action', `Plan ${planId} has no action with id ${actionId}.`);
        return;
      }
      if (plan.closed != null) {
        await refuse(
          response,
          act,
          409,
          'plan-closed',
          'This plan is closed, so what it reports finished has to stay as it was. Revise the work in an open plan.'
        );
        return;
      }

      // Every other action in the plan, so a revised dependency is checked against the plan as it is —
      // and this action excluded, because `dependenciesFrom` walks the siblings to find a circle back to
      // it and the stored copy of itself would be the first thing it found.
      const siblings = (await store.actions(planId, assessmentOf(request))).filter((sibling) => sibling.id !== actionId);
      const after = revised(action, request.body, { knownControl: options.knownControl, siblings, now: now() });
      await store.changeAction(after, plan);
      await act.performed(target);
      response.json(dated(presentAction(progressOf(after, await judged(request)), options)));
    } catch (cause) {
      await act?.failed(cause);
      respond(response, cause, options);
    }
  });

  /**
   * Moves an action to another state.
   *
   * One route for all six person-made moves rather than a route per verb, because the rule about which
   * moves are legal lives in one table in the domain and a route per verb would be six places that
   * each have to agree with it. `verified` is refused here by the same table, and that refusal is the
   * point rather than an omission.
   */
  app.post('/api/improvements/:id/actions/:actionId/move', async (request, response) => {
    const store = options.improvements;
    if (store == null) {
      response.status(503).json({ error: 'improvements-unavailable', message: NO_STORE });
      return;
    }

    let act: Act | undefined;
    try {
      const planId = request.params.id ?? '';
      const actionId = request.params.actionId ?? '';
      const target = { kind: 'action', id: actionId } as const;
      const permission = await options.permitted(request, response, 'action.move', { target });
      const { actor } = permission;
      act = permission.act;

      const plan = await store.plan(planId, assessmentOf(request));
      const action = await store.action(actionId, assessmentOf(request));
      // One refusal for both absences and for the mismatch, because all three are the same thing from
      // the caller's side — this plan does not have that action — and three different sentences would
      // let a caller enumerate which actions exist in plans they were looking at the wrong one of.
      if (plan == null || action == null || action.planId !== planId) {
        await refuse(response, act, 404, 'unknown-action', `Plan ${planId} has no action with id ${actionId}.`);
        return;
      }
      /*
       * The same refusal raising and revising make, and it was missing here.
       *
       * A closed plan reports finished work, and every action in it is verified or cancelled — that is
       * what `plan.closed` insists on before it will close. Moving one afterwards puts live work back
       * under a plan whose whole claim is that there is none, and it does it in the one place a reader
       * would not look, because the pages treat a closed plan as frozen and never offer the move. An
       * API-only gap in a rule the surface obeys is the kind that stays open for a year.
       */
      if (plan.closed != null) {
        await refuse(
          response,
          act,
          409,
          'plan-closed',
          'This plan is closed, so what it reports finished has to stay as it was. Move the work in an open plan.'
        );
        return;
      }

      const body = asObject(request.body);
      const to = stateFrom(body.to);
      const reason = typeof body.reason === 'string' ? body.reason : undefined;
      const after = moved(action, { to, who: actor, at: now(), ...(reason != null ? { reason } : {}) });
      await store.changeAction(after, plan);
      await act.performed(target);
      response.json(dated(presentAction(progressOf(after, await judged(request)), options)));
    } catch (cause) {
      await act?.failed(cause);
      respond(response, cause, options);
    }
  });

  /**
   * Actions naming one requirement, across every plan.
   *
   * What a findings page asks: this requirement is failing, is it already somebody's work? Every plan
   * rather than the one being read, because the plan the action is in is rarely the one the reader
   * came from.
   */
  app.get('/api/improvements/for/:controlId', async (request, response) => {
    const store = options.improvements;
    if (store == null) {
      response.json({ actions: [], durable: false, durabilityNote: NO_STORE, minProse: MIN_PROSE });
      return;
    }

    try {
      const controlId = request.params.controlId ?? '';
      const actions = await store.actionsFor(controlId, assessmentOf(request));
      const context = await judged(request);
      const payload: ActionsForControlPayload<Date> = {
        actions: sorted(actions).map((action) => presentAction(progressOf(action, context), options)),
        durable: store.durable,
        ...(store.durable ? {} : { durabilityNote: options.improvementStorage ?? NOT_DURABLE }),
        ...(context.measuredAt != null ? { measuredAt: context.measuredAt } : {}),
        minProse: MIN_PROSE,
      };
      response.json(dated(payload));
    } catch (cause) {
      options.respondToFailure(response, cause);
    }
  });

  /**
   * The plan this export is about, or a 404 already sent.
   *
   * Shared by the three routes below so that a download and the digest published for it cannot end up
   * reading different plans — which is the failure that would be read as tampering.
   */
  const exportSubject = async (
    request: Request<{ id: string }>,
    response: Response
  ): Promise<PlanExportOptions | undefined> => {
    const store = options.improvements;
    if (store == null) {
      response.status(404).json({ error: 'unknown-plan', message: NO_STORE });
      return undefined;
    }

    const id = request.params.id ?? '';
    const scope = assessmentOf(request);
    const plan = await store.plan(id, scope);
    if (plan == null) {
      response.status(404).json({ error: 'unknown-plan', message: `No improvement plan with id ${id}.` });
      return undefined;
    }

    /*
     * The readings the page gets, and the export must use no more of them than it can reproduce.
     *
     * `context.now` is in here because `progressOf` computes an action's `lateness` from it, and nothing
     * the export writes may be derived from that: a document whose bytes move at midnight publishes a
     * digest that goes stale on an untouched plan, and the panel then tells a sender their recipient's
     * copy has been altered. `plan-document.ts` carries neither `lateness` nor the `overdue` rollup for
     * that reason, and a test seals the same plan a year apart and compares digests rather than trusting
     * this comment.
     */
    const context = await judgedAgainst(options, now(), scope);
    const actions = sorted(await store.actions(id, scope));

    return {
      plan,
      actions: actions.map((action) => progressOf(action, context)),
      progress: planProgress(plan.id, actions, context),
      titleOf: options.titleOf,
      ...(context.runId != null && context.measuredAt != null
        ? { judgedAgainst: { runId: context.runId, at: context.measuredAt } }
        : {}),
    };
  };

  /**
   * The plan as a file.
   *
   * A read that is recorded, for the reason `event.ts` gives about exports generally: it is the one
   * read that produces an artefact which outlives the app and travels outside the customer. A plan is
   * the sharper case of it — an assessment export says what is wrong, and a plan export says what
   * somebody committed to doing about it, which is the document that gets quoted back.
   */
  const exportPlan =
    (format: 'csv' | 'json') =>
    async (request: Request<{ id: string }>, response: Response): Promise<void> => {
      try {
        const subject = await exportSubject(request, response);
        if (subject == null) return;

        const variant = planVariantOf(request.query.variant);
        if (variant == null) {
          // The word the caller asked for is not quoted back, which is the same choice the assessment
          // export makes: a query parameter can arrive as an array or an object, and a message built from
          // one would read `[object Object]` to whoever is debugging their own script.
          response.status(400).json({
            error: 'unknown-variant',
            message:
              `This app produces three exports of a plan: ${PLAN_VARIANTS.join(', ')}. Ask for one of those, or ` +
              'omit the parameter for the complete file.',
          });
          return;
        }

        const file = sealPlan({ ...subject, format, variant });

        // Recorded as a read rather than through `permitted`: exports are not gated, and adding a gate
        // to a download that works today would be a behaviour change smuggled in beside a log. On an
        // install with no recorder this is a no-op act, so the route does not branch on it.
        await options
          .recordRead?.(request, response, 'export.plan', { correlation: subject.plan.id })
          .performed({ kind: 'artefact', id: file.name, digest: file.digest });

        response.setHeader('Content-Type', file.contentType);
        response.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
        response.setHeader('X-Content-Type-Options', 'nosniff');
        // The digest travels with the bytes as well as being recorded, so a client that downloaded the
        // file can check it without a second request.
        response.setHeader(DIGEST_HEADER, file.digest);
        // Read by Semgrep as reflected XSS, and waved away for the reason `routes.ts` sets out at the
        // assessment export: the body does contain text this app did not choose — an outcome somebody
        // typed, a requirement title — but it is a download and not a page. The content type is
        // explicit, `nosniff` above makes that binding, the disposition is `attachment`, and the
        // filename is an id and, where one was asked for, a variant.
        // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
        response.send(file.bytes);
      } catch (cause) {
        options.respondToFailure(response, cause);
      }
    };

  app.get('/api/improvements/:id/export.csv', exportPlan('csv'));
  app.get('/api/improvements/:id/export.json', exportPlan('json'));

  /**
   * What each export of this plan should hash to, without serving one.
   *
   * Not recorded: nothing left the app. The same separation the run's exports have, and for the same
   * reason — a sender who has already mailed a copy needs the value on a page they can read out
   * rather than in the response header of a download they no longer have.
   *
   * Every file is sealed to answer, which is six passes over one plan's actions. Deliberately the same
   * code path the download takes, over the same stored plan, so a published digest cannot drift from
   * the served bytes.
   */
  app.get('/api/improvements/:id/exports', async (request: Request<{ id: string }>, response: Response) => {
    try {
      const subject = await exportSubject(request, response);
      if (subject == null) return;

      const fileOf = (variant: PlanVariant, format: 'csv' | 'json'): ExportFilePayload => {
        const file = sealPlan({ ...subject, format, variant });
        return {
          name: file.name,
          format,
          variant,
          digest: file.digest,
          bytes: file.bytes.byteLength,
          href: scopedHref(
            variant === DEFAULT_PLAN_VARIANT
              ? `/api/improvements/${subject.plan.id}/export.${format}`
              : `/api/improvements/${subject.plan.id}/export.${format}?variant=${variant}`,
            subject.plan.assessment?.definitionId
          ),
          verify: howToCheck(file),
        };
      };

      const variants = PLAN_VARIANTS.map((variant) => {
        const shape = PLAN_VARIANT_SHAPES[variant];
        return {
          variant,
          says: shape.says,
          ...(shape.omits != null ? { omits: shape.omits } : {}),
          files: (['csv', 'json'] as const).map((format) => fileOf(variant, format)),
        };
      });

      const current = new Map(
        variants.flatMap((entry) => entry.files.map((file) => [file.name, file.digest] as const))
      );

      // Built with dates already as strings and sent without `dated`, unlike every other payload here:
      // the only date in it comes from the trail, which hands back ISO strings, and a traversal that
      // found nothing to convert would be a line whose purpose the next reader has to work out.
      const payload: PlanExportsPayload = {
        planId: subject.plan.id,
        ...(subject.judgedAgainst != null
          ? {
              judgedAgainst: {
                run: subject.judgedAgainst.runId,
                at: subject.judgedAgainst.at.toISOString(),
              },
            }
          : {}),
        variants,
        taken: (await options.takenFrom?.('export.plan', subject.plan.id, current)) ?? [],
      };
      response.json(payload);
    } catch (cause) {
      options.respondToFailure(response, cause);
    }
  });
}

/**
 * Resolves an advice reference in this request's body, or nothing where it names none.
 *
 * The advisory is read here, before the body is validated, because `draftFrom` is synchronous and the
 * record is a database read. So the id is taken from the body first and the finding is looked up
 * inside it afterwards — which also means a body naming one advisory cannot have its finding resolved
 * out of another.
 */
async function adviceReader(
  request: Request,
  options: ImproveRouteOptions
): Promise<((reference: AdviceReference) => AdviceProvenance) | undefined> {
  const store = options.advisories;
  if (store == null) return undefined;

  const body: unknown = request.body;
  const supplied = body != null && typeof body === 'object' ? (body as { advice?: unknown }).advice : undefined;
  if (supplied == null || typeof supplied !== 'object') return undefined;

  const advisoryId = (supplied as { advisoryId?: unknown }).advisoryId;
  if (typeof advisoryId !== 'string' || advisoryId === '') return undefined;

  const advisory = await store.get(advisoryId, assessmentOf(request));
  return (reference) => {
    if (advisory == null || advisory.id !== reference.advisoryId) {
      throw new UnknownAdviceError(
        `There is no advisory ${reference.advisoryId} in this assessment. An action can only be raised from ` +
          'advice this installation still holds, because the advice is what the action is about.'
      );
    }
    return adviceFrom(advisory, reference);
  };
}

/**
 * The run every agreement in a response is judged against.
 *
 * The latest run rather than the run a plan was raised from, which is the whole point: the baseline is
 * what the plan was written against, and the question a board answers is what the estate says *now*. A
 * store with nothing in it yields no findings and no date, and every claim reads `awaiting` — which is
 * the honest reading before anything has been measured.
 */
async function judgedAgainst(
  options: ImproveRouteOptions,
  now: Date,
  scope?: AssessmentScope
): Promise<Measured> {
  const [latest, advised] = await Promise.all([options.store.latest(scope), advisedBy(options, scope)]);
  // `now` even with nothing measured, because lateness is a reading about dates rather than about the
  // estate: an action can be overdue on an install that has never run a scan. The advisory is read on
  // the same terms and separately: an install may hold one and no scan, or a scan and no advisory, and
  // an action raised from advice is judged by the second of the two.
  if (latest == null) return { now, ...advised };

  /*
   * `attested` travels with the outcome, and leaving it behind quietly switched off a rule.
   *
   * `progressOf` uses it for one thing: a requirement a run reports as met on the strength of an
   * attestation recorded *before* the claim is not evidence the work happened, and reads `unmeasured`
   * rather than `agreed` — which is the whole of AUD-DEC-107. Fifty-five requirements in this catalogue
   * are answered by somebody's word, so it is not a corner. An absent `attested` means the app measured
   * the requirement itself and `refreshed` returns true, so narrowing the finding to two fields made
   * every one of those actions read as agreed and the rule fire never.
   *
   * It mattered least while this only fed a page. It matters most in the `audit` export, whose stated
   * purpose is showing that a claim was made before a run agreed with it rather than after.
   */
  const findings: readonly Pick<Finding, 'controlId' | 'outcome' | 'attested'>[] = latest.findings.map(
    (finding) => ({
      controlId: finding.controlId,
      outcome: finding.outcome,
      ...(finding.attested != null ? { attested: finding.attested } : {}),
    })
  );
  return { findings, measuredAt: latest.finishedAt, runId: latest.id, now, ...advised };
}

/**
 * The latest advisory as a reading of one action's advice, and the advisor's own totals beside it.
 *
 * Read once per response and closed over, rather than fetched per action: every action's finding is in
 * a different advisory and every reading is against the same latest one, so a lookup per action would
 * be the same row fetched as many times as there is work on the board.
 *
 * Absent where this install keeps no advisories or has run none, which is `unjudged` on every
 * advice-raised action and no value figures at all. Not an error: three of the four figures are the
 * advisors', and an install without them has nothing to report rather than zeroes to show.
 */
async function advisedBy(
  options: ImproveRouteOptions,
  scope?: AssessmentScope
): Promise<{ readonly adviceReading?: (advice: AdviceProvenance) => AdviceReading; readonly opportunity?: readonly Money[] }> {
  const store = options.advisories;
  if (store == null) return {};

  const latest = await store.latest(scope);
  if (latest == null) return {};

  return {
    adviceReading: (advice) => adviceReadingOf(advice, latest),
    opportunity: opportunityIn(latest),
  };
}

/**
 * The four figures, or nothing where none of them can be read.
 *
 * Absent rather than empty when this install has no advisory: three of the four come from one, and a
 * report showing a posture beside three zeroes would say the estate has nothing to gain — which is a
 * claim about the advisors nobody has run.
 *
 * The posture is the scan's own score restated, read here rather than passed through `AgreementContext`
 * because the context is a comparison and this is a figure. Nothing below derives one from the other:
 * ADR 0083's prohibition is that no advisor figure moves a score and no score enters the other three,
 * and this function is the one place all four are in scope.
 */
async function valuePayload(
  actions: readonly ImprovementAction[],
  context: Measured,
  options: ImproveRouteOptions,
  scope?: AssessmentScope
): Promise<{ readonly value?: ValueReportPayload<Date> }> {
  if (context.adviceReading == null) return {};

  const latest = await options.store.latest(scope);
  const posture =
    latest == null
      ? undefined
      : {
          runId: latest.id,
          at: latest.finishedAt,
          ...(latest.score.overall != null ? { overall: latest.score.overall } : {}),
          scoredControls: latest.score.scoredControls,
          totalControls: latest.score.totalControls,
          unmeasured: latest.score.counts.unmeasurable,
        };

  return {
    value: valueOf({
      progress: actions.map((action) => progressOf(action, context)),
      ...(context.opportunity != null ? { opportunity: context.opportunity } : {}),
      ...(posture != null ? { posture } : {}),
    }),
  };
}

/**
 * What the advisors say is available, in their own totals.
 *
 * One entry, because one advisor prices anything: the serverless analysis, which computes a range
 * across the jobs it could price and declares the assumptions it did so under. The other three report
 * no money, and an empty entry for each of them would be three zeroes that read as nothing to gain.
 *
 * The analysis's own total rather than a sum over its jobs. Re-adding them here would produce a second
 * number with a different denominator — `estimate.jobs` is the count of jobs it could price, which is
 * not the count of jobs with a finding — and two totals with one name is the defect this avoids.
 */
function opportunityIn(advisory: Advisory): readonly Money[] {
  const estimate = advisory.serverless?.estimate;
  if (estimate == null) return [];

  return [
    {
      advisor: 'serverless',
      low: estimate.low,
      high: estimate.high,
      currency: estimate.currency,
      ...(estimate.region != null ? { region: estimate.region } : {}),
      resources: estimate.jobs,
      assumptions: (advisory.serverless?.assumptions ?? []).map((one) => one.statement),
    },
  ];
}

/**
 * The agreement context, plus which run it came from.
 *
 * The run's identity is not part of `AgreementContext` because nothing in the domain needs it: an
 * agreement is a comparison against findings and a date. A file that leaves the app does need it —
 * `contradicted` in an export is a statement about a particular measurement, and a recipient with no
 * access to this app cannot look up which. So it is carried here, beside the context, rather than
 * added to a domain type to satisfy an exporter.
 */
interface Measured extends AgreementContext {
  readonly runId?: string;
  /** The advisors' own totals from the same advisory the readings came from. See `advisedBy`. */
  readonly opportunity?: readonly Money[];
}

/**
 * The assessment the request is in, as a plan citation, when the body did not name one.
 *
 * The UI posts through `useScopedPath` and does not send an `assessment` field — PlanForm cites the
 * run, not the definition. Without this, a plan opened on an assessment is stored unscoped and
 * vanishes from the list that created it. The version is the current one when a store is bound, and
 * 1 when it is not: a build with no definition store already accepts any citation unchecked, and
 * the id is what the filter reads.
 */
async function citedFromQuery(
  request: Request,
  options: ImproveRouteOptions
): Promise<{ readonly definitionId: string; readonly version: number } | undefined> {
  const id = assessmentOf(request);
  if (id == null) return undefined;
  const store = options.definitions;
  if (store == null) return { definitionId: id, version: 1 };
  const definition = await store.get(id);
  if (definition == null) {
    throw new InvalidPlanError(`There is no assessment ${id}.`);
  }
  return { definitionId: definition.id, version: currentVersion(definition).version };
}

/**
 * Whether a definition version exists, for the citation on a plan.
 *
 * Absent when this install keeps no definitions, in which case the citation is accepted unchecked
 * rather than refused: a build with no definition store has no way to know, and refusing every
 * citation would make a plan unwritable for a reason that has nothing to do with the plan. The
 * alternative — accepting silently and calling it verified — is the one to avoid, which is why this
 * returns undefined and the domain treats the absence as "not checked".
 */
async function assessmentReader(
  options: ImproveRouteOptions
): Promise<((definitionId: string, version: number) => boolean) | undefined> {
  const store = options.definitions;
  if (store == null) return undefined;

  const definitions = await store.all();
  const versions = new Map(definitions.map((one) => [one.id, one.versions.map((version) => version.version)]));
  return (definitionId, version) => versions.get(definitionId)?.includes(version) ?? false;
}

/**
 * Newest first, and within a plan that is the order work was raised in reversed.
 *
 * Sorted here rather than in the store, because the store's contract deliberately promises no order —
 * `actionsFor` reads across plans and a durable one reads by revision. The page that needs a different
 * order sorts what it was sent.
 *
 * The id breaks a tie, and that stopped being cosmetic when this order started reaching an export. Two
 * actions raised in the same millisecond — one request that seeds a plan from a run does exactly that —
 * compare equal, and a stable sort then keeps whatever order the store happened to return. Postgres
 * promises none for equal keys, so the same plan could serialise two ways, produce two digests, and have
 * the panel report a recipient's unaltered copy as no longer matching.
 */
function sorted(actions: readonly ImprovementAction[]): readonly ImprovementAction[] {
  return [...actions].sort(
    (left, right) => right.createdAt.getTime() - left.createdAt.getTime() || left.id.localeCompare(right.id)
  );
}

function presentPlan(
  plan: ImprovementPlan,
  actions: readonly ImprovementAction[],
  context: AgreementContext
): ImprovementPlanPayload<Date> {
  return {
    id: plan.id,
    title: plan.title,
    outcome: plan.outcome,
    owners: plan.owners,
    ...(plan.assessment != null ? { assessment: plan.assessment } : {}),
    ...(plan.raisedFrom != null ? { raisedFrom: plan.raisedFrom } : {}),
    createdBy: plan.createdBy,
    createdAt: plan.createdAt,
    ...(plan.closed != null ? { closed: plan.closed } : {}),
    progress: progressPayload(planProgress(plan.id, actions, context)),
  };
}

/**
 * The rollup, field by field rather than passed through.
 *
 * Written out because the two types are structurally identical today and are allowed to stop being: the
 * domain is free to grow a field the wire should not carry, and a spread would carry it silently the
 * day somebody adds one.
 */
function progressPayload(progress: PlanProgress): PlanProgressPayload<Date> {
  return {
    planId: progress.planId,
    states: progress.states,
    contradicted: progress.contradicted,
    overdue: progress.overdue,
    blocked: progress.blocked,
    settled: progress.settled,
    ...(progress.nextDue != null ? { nextDue: progress.nextDue } : {}),
  };
}

function presentAction(progress: ActionProgress, options: ImproveRouteOptions): ImprovementActionPayload<Date> {
  const { action } = progress;
  return {
    id: action.id,
    planId: action.planId,
    controlIds: action.controlIds,
    outcome: action.outcome,
    definitionOfDone: action.definitionOfDone,
    owner: action.owner,
    priority: action.priority,
    effort: action.effort,
    ...(action.due != null ? { due: action.due } : {}),
    steps: action.steps,
    dependsOn: action.dependsOn,
    state: action.state,
    ...(action.raisedFrom != null ? { raisedFrom: action.raisedFrom } : {}),
    ...(action.advice != null ? { advice: presentAdvice(action.advice) } : {}),
    createdBy: action.createdBy,
    createdAt: action.createdAt,
    history: action.history.map(transition),
    agreement: progress.agreement,
    lateness: progress.lateness,
    unmet: progress.unmet,
    unreadable: progress.unreadable,
    ...(progress.advice != null ? { adviceReading: presentReading(progress.advice) } : {}),
    moves: movesFor(action.state),
    // Only the requirements this action names, and only the ones the catalogue has a title for. A
    // requirement dropped by a later catalogue version keeps its id on the board rather than
    // disappearing from it, which is what a reader of an old plan needs to see.
    titles: Object.fromEntries(
      action.controlIds
        .map((id) => [id, options.titleOf(id)] as const)
        .filter((entry): entry is readonly [string, string] => entry[1] != null)
    ),
  };
}

/**
 * The provenance on the wire, field by field for the reason `progressPayload` is written out.
 *
 * Nothing is summarised here and nothing is computed. A saving inferred from a baseline would be this
 * file's arithmetic rather than the advisor's, and a surface that showed it would be quoting a figure
 * with no assumptions attached to it — which is the one thing 44b's own note refuses.
 */
function presentAdvice(advice: AdviceProvenance): AdviceProvenancePayload<Date> {
  return {
    advisoryId: advice.advisoryId,
    advisor: advice.advisor,
    rule: advice.rule,
    versions: advice.versions,
    resource: advice.resource,
    headline: advice.headline,
    detail: advice.detail,
    docUrl: advice.docUrl,
    ...(advice.severity != null ? { severity: advice.severity } : {}),
    baseline: advice.baseline,
    ...(advice.observation != null ? { observation: advice.observation } : {}),
    assumptions: advice.assumptions,
    ...(advice.opportunity != null ? { opportunity: advice.opportunity } : {}),
    measuredAt: advice.measuredAt,
    lookbackDays: advice.lookbackDays,
  };
}

function presentReading(reading: AdviceReading): AdviceReadingPayload<Date> {
  return {
    advisoryId: reading.advisoryId,
    measuredAt: reading.measuredAt,
    lookbackDays: reading.lookbackDays,
    standing: reading.standing,
    movements: reading.movements,
    unmatched: reading.unmatched,
    ...(reading.incomparable != null ? { incomparable: reading.incomparable } : {}),
  };
}

function transition(entry: Transition): ActionTransitionPayload<Date> {
  return {
    from: entry.from,
    to: entry.to,
    at: entry.at,
    by: entry.by,
    who: entry.who,
    ...(entry.reason != null ? { reason: entry.reason } : {}),
  };
}

/**
 * The payload with every date as an ISO string.
 *
 * One traversal at the edge rather than `toISOString()` at forty field sites, which is the shape the
 * rest of the API arrived at the long way round. The payload types are generic in their date so the
 * server can hold `Date` and the client reads `string`, and this is the single place the two meet.
 */
function dated<T>(payload: T): unknown {
  if (payload instanceof Date) return payload.toISOString();
  if (Array.isArray(payload)) return payload.map((entry: unknown) => dated(entry));
  if (payload != null && typeof payload === 'object') {
    return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, dated(value)]));
  }
  return payload;
}

/**
 * The state a move is asking for, refused rather than defaulted.
 *
 * `verified` passes this check and is refused by `moved`, deliberately: the sentence a caller needs is
 * the domain's one about nobody marking their own work verified, and a parser that rejected the word
 * as unknown would tell them it does not exist.
 */
function stateFrom(raw: unknown): ActionState {
  if (typeof raw !== 'string' || raw === '') {
    throw new InvalidActionError('Say which state to move this to, as to.');
  }
  return raw as ActionState;
}

function reasonFrom(body: unknown): string {
  const reason = asObject(body).reason;
  if (typeof reason !== 'string') {
    throw new InvalidPlanError('Say why the plan is being closed, as reason.');
  }
  return reason;
}

function asObject(body: unknown): Record<string, unknown> {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvalidActionError('This is described by an object.');
  }
  return body as Record<string, unknown>;
}

/**
 * Answers with a refusal this route decided on, and closes the act with the same word.
 *
 * The same helper, and the same argument, as `definition-routes.ts`: the body's `error` doubles as the
 * audit reason so the two vocabularies cannot drift, and the one that drifts unnoticed is the one in
 * the log because nobody reads it until the day it matters.
 */
async function refuse(response: Response, act: Act, status: number, error: string, message: string): Promise<void> {
  await act.failed(error);
  response.status(status).json({ error, message });
}

function respond(response: Response, cause: unknown, options: ImproveRouteOptions): void {
  if (cause instanceof ConcurrentChangeError) {
    // 409 rather than 500, because nothing is broken: two people acted on one record and the second
    // needs to re-read. The domain's own sentence says exactly that.
    response.status(409).json({ error: 'concurrent-change', message: cause.message });
    return;
  }
  if (cause instanceof InvalidActionError) {
    response.status(400).json({ error: 'invalid-action', message: cause.message });
    return;
  }
  if (cause instanceof UnknownAdviceError) {
    // 400 rather than 404, and the distinction is about what is missing: the plan and the action in
    // the URL are both fine, and what does not exist is something the body named. A 404 here would
    // read, on a page and in a log, as the plan having gone.
    response.status(400).json({ error: 'unknown-advice', message: cause.message });
    return;
  }
  if (cause instanceof InvalidPlanError) {
    response.status(400).json({ error: 'invalid-plan', message: cause.message });
    return;
  }
  if (cause instanceof MismatchedPlanError) {
    // A programming mistake rather than bad input, and it reaches the caller as one: the route already
    // refuses a mismatch with a 404 before it gets here, so arriving here means this module has a bug.
    options.respondToFailure(response, cause);
    return;
  }
  options.respondToFailure(response, cause);
}
