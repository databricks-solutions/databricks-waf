// Reading the retention position, and changing it.
//
// # Why the read is ungated and the writes are not
//
// The same split as the trail. What the read answers — how long each class is kept, what is past its
// period, what a hold is preserving — is the first thing a privacy review asks for, and the person
// asking is an auditor rather than an assessor. Making them hold the group that permits changes so
// they can read a policy would be granting write access to satisfy a read.
//
// The writes are the other extreme: setting a period, placing a hold, and above all sweeping are acts
// with consequences nobody can undo, so each is gated and each is recorded as something a named person
// did — including when it was refused, which is the question this surface most needs to be able to
// answer a year later.
//
// # Why a sweep has to be confirmed with a number
//
// `POST /api/retention/sweep` requires the caller to state how many rows they expect it to remove, and
// refuses when the plan no longer agrees. That is not ceremony. A sweep is the only irreversible act
// in this app, the page that offers it is read from a plan that may be minutes old, and the difference
// between "remove 4 drafts" and "remove 4,000 scans" is one setting somebody changed in another tab.
// Echoing the number turns a stale page from a deletion nobody intended into a refusal that says why.
//
// # What is deliberately not here
//
// No route removes one record. Retention is a stated period applied uniformly, and an endpoint that
// deleted a nominated row would be a different feature with a different name — one whose absence from
// the audit trail is indistinguishable from tampering, since the record it removed is the evidence it
// existed. If a specific record must go, that is a data subject request, and the answer to those is
// anonymisation.

import type { Application, Request, Response } from 'express';
import type {
  EligibilityPayload,
  LegalHoldPayload,
  ResetPayload,
  ResetPlanPayload,
  RetentionClassPayload,
  RetentionPayload,
  SweepPayload,
} from '../../shared/api/contract.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import type { Act } from '../audit/record.js';
import {
  DEFAULT_PERIOD_DAYS,
  EXEMPT,
  holdRefusal,
  holdTarget,
  MAX_PERIOD_DAYS,
  MIN_PERIOD_DAYS,
  periodRefusal,
  planRetention,
  RETENTION_CLASSES,
  sweepRetention,
  type Eligibility,
  type LegalHold,
  type PlannedClass,
  type RetentionClass,
  type RetentionGateway,
} from '../admin/retention.js';
import type { RetentionStore } from '../admin/retention-store.js';
import { InstallHeld, planReset, resetInstall, type ResetGateway, type ResetPlan } from '../admin/reset.js';

/** What the routes need. Absent means this install keeps nothing, which the read says in a sentence. */
export interface Retention {
  readonly store: RetentionStore;
  /**
   * One object for both, because there is one set of tables behind them.
   *
   * The interfaces stay separate — the planning either side of them has nothing in common — but a
   * route that could be handed a sweep gateway over one schema and a reset gateway over another is a
   * route with a failure mode nobody would ever look for.
   */
  readonly gateway: RetentionGateway & ResetGateway;
}

export interface RetentionRouteOptions {
  readonly retention?: Retention;
  readonly permitted: (
    request: Request,
    response: Response,
    action: AuditAction,
    context?: { readonly target?: AuditTarget; readonly correlation?: string }
  ) => Promise<{ readonly actor: string; readonly act: Act }>;
  readonly respondToFailure: (response: Response, cause: unknown) => void;
  /** Injected so a test can pin the instant, like every other dated thing here. */
  readonly now?: () => Date;
  /** Injected so a hold's id is assertable rather than `expect.any(String)`. */
  readonly newId?: () => string;
}

const NOTHING_KEPT =
  'This install stores nothing that outlives a restart, so there is no retention period to set and ' +
  'nothing to remove. Everything it holds is in memory and is gone when the app stops. Bind a Lakebase ' +
  'instance and the policy below begins to apply from that point.';

function eligibilityOf(one: Eligibility & { readonly holds: string }): EligibilityPayload {
  return {
    table: one.table,
    holds: one.holds,
    total: one.total,
    eligible: one.eligible,
    ...(one.oldest != null ? { oldest: one.oldest.toISOString() } : {}),
  };
}

function classOf(planned: PlannedClass): RetentionClassPayload {
  return {
    retentionClass: planned.retentionClass,
    periodDays: planned.periodDays,
    defaultDays: DEFAULT_PERIOD_DAYS[planned.retentionClass],
    cutoff: planned.cutoff.toISOString(),
    heldBy: planned.heldBy.map((hold) => hold.id),
    tables: planned.tables.map(eligibilityOf),
  };
}

function holdOf(hold: LegalHold): LegalHoldPayload {
  return {
    id: hold.id,
    reason: hold.reason,
    covers: hold.covers,
    placedBy: hold.placedBy,
    placedAt: hold.placedAt.toISOString(),
    ...(hold.releasedBy != null ? { releasedBy: hold.releasedBy } : {}),
    ...(hold.releasedAt != null ? { releasedAt: hold.releasedAt.toISOString() } : {}),
  };
}

function resetPlanOf(plan: ResetPlan): ResetPlanPayload {
  return {
    tables: plan.tables.map((one) => ({ table: one.table, holds: one.holds, swept: one.swept, rows: one.rows })),
    records: plan.records,
    events: plan.events,
    heldBy: plan.heldBy.map((hold) => hold.id),
  };
}

/**
 * The holds in force, as one comparable string.
 *
 * Only the ones still in force, and only their ids: a hold whose reason was edited preserves the same
 * classes, and refusing a sweep over that would be refusing over a typo. What matters is whether the
 * set of things saying "do not delete this" is the set the plan was computed from.
 */
function heldIds(holds: readonly LegalHold[]): string {
  return holds
    .filter((hold) => hold.releasedAt == null)
    .map((hold) => hold.id)
    .sort()
    .join(' ');
}

/**
 * The periods from a request body, or a refusal.
 *
 * A partial map rather than all three, so setting one class does not require the caller to restate
 * the other two — which would make a page that had read a stale policy silently reset them.
 */
function periodsFrom(body: unknown): { periods: Partial<Record<RetentionClass, number>> } | { refusal: string } {
  if (typeof body !== 'object' || body == null) {
    return { refusal: 'A period change is an object of retention classes to whole numbers of days.' };
  }

  const periods: Partial<Record<RetentionClass, number>> = {};
  const asked = (body as { periods?: unknown }).periods;
  const source = typeof asked === 'object' && asked != null ? (asked as Record<string, unknown>) : {};

  for (const [key, value] of Object.entries(source)) {
    const retentionClass = RETENTION_CLASSES.find((one) => one === key);
    if (retentionClass == null) {
      return {
        refusal: `\`${key}\` is not something this app retains. The classes are ${RETENTION_CLASSES.join(', ')}.`,
      };
    }
    const refusal = periodRefusal(value);
    if (refusal != null) return { refusal };
    periods[retentionClass] = value as number;
  }

  if (Object.keys(periods).length === 0) {
    return { refusal: `Nothing was asked for. Name at least one of ${RETENTION_CLASSES.join(', ')}.` };
  }
  return { periods };
}

export function registerRetentionRoutes(app: Application, options: RetentionRouteOptions): void {
  const at = (): Date => (options.now ?? (() => new Date()))();
  const mintId = (): string => (options.newId ?? (() => crypto.randomUUID()))();

  /**
   * The policy, what it makes eligible, and what is being held.
   *
   * One request rather than three, because the three are only meaningful together: a period without
   * the counts cannot be judged, and counts without the holds would show rows as due for removal that
   * nothing will remove.
   */
  app.get('/api/retention', async (_request, response) => {
    const retention = options.retention;
    if (retention == null) {
      // 200 with a sentence, like the trail and the imports listing: "nothing is kept" is a complete
      // answer, and an error status would render a failure in place of the explanation.
      const empty: RetentionPayload = {
        durable: false,
        classes: [],
        holds: [],
        exempt: EXEMPT.map((one) => ({ ...one })),
        wouldRemove: 0,
        bounds: { least: MIN_PERIOD_DAYS, most: MAX_PERIOD_DAYS },
        unavailable: NOTHING_KEPT,
      };
      response.json(empty);
      return;
    }

    try {
      const policy = await retention.store.policy();
      const holds = await retention.store.holds();
      const now = at();
      const plan = await planRetention(retention.gateway, policy, holds, now);
      // Read in the same request rather than from a route of its own. The reset plane is the same
      // page, and a second fetch would let it render a total that disagrees with the table above it
      // for as long as the two requests are apart. Five extra counts on a page an administrator opens
      // deliberately is the cheaper half of that trade.
      const reset = await planReset(retention.gateway, holds, now);

      const payload: RetentionPayload = {
        durable: true,
        at: plan.at.toISOString(),
        ...(policy.setBy != null ? { setBy: policy.setBy } : {}),
        ...(policy.setAt != null ? { setAt: policy.setAt.toISOString() } : {}),
        classes: plan.classes.map(classOf),
        holds: holds.map(holdOf),
        exempt: plan.exempt.map((one) => ({ ...one })),
        wouldRemove: plan.wouldRemove,
        bounds: { least: MIN_PERIOD_DAYS, most: MAX_PERIOD_DAYS },
        reset: resetPlanOf(reset),
      };
      response.json(payload);
    } catch (cause) {
      options.respondToFailure(response, cause);
    }
  });

  /** How long each class is kept. */
  app.put('/api/retention/periods', async (request, response) => {
    const retention = options.retention;
    let act: Act | undefined;
    try {
      const who = await options.permitted(request, response, 'retention.configure');
      act = who.act;

      if (retention == null) {
        await act.failed('nothing-retained');
        response.status(409).json({ error: 'nothing-retained', message: NOTHING_KEPT });
        return;
      }

      const parsed = periodsFrom(request.body);
      if ('refusal' in parsed) {
        await act.failed('bad-period');
        response.status(400).json({ error: 'bad-period', message: parsed.refusal });
        return;
      }

      await retention.store.setPeriods(parsed.periods, who.actor, at());
      await act.performed();
      response.status(204).end();
    } catch (cause) {
      await act?.failed(cause);
      options.respondToFailure(response, cause);
    }
  });

  /** A reason not to delete something, placed by a named person. */
  app.post('/api/retention/holds', async (request, response) => {
    const retention = options.retention;
    let act: Act | undefined;
    try {
      const who = await options.permitted(request, response, 'retention.hold');
      act = who.act;

      if (retention == null) {
        await act.failed('nothing-retained');
        response.status(409).json({ error: 'nothing-retained', message: NOTHING_KEPT });
        return;
      }

      const body = (typeof request.body === 'object' && request.body != null ? request.body : {}) as {
        reason?: unknown;
        covers?: unknown;
      };
      const refusal = holdRefusal(body.reason, body.covers);
      if (refusal != null) {
        await act.failed('bad-hold');
        response.status(400).json({ error: 'bad-hold', message: refusal });
        return;
      }

      const hold: LegalHold = {
        id: mintId(),
        reason: (body.reason as string).trim(),
        covers: body.covers as readonly RetentionClass[],
        placedBy: who.actor,
        placedAt: at(),
      };
      await retention.store.place(hold);
      await act.performed(holdTarget(hold.id));
      response.status(201).json(holdOf(hold));
    } catch (cause) {
      await act?.failed(cause);
      options.respondToFailure(response, cause);
    }
  });

  /**
   * Lifting a hold.
   *
   * A `post` to `release` rather than a `delete` of the hold, because the hold is not deleted: the row
   * stays, with who lifted it and when. "There was a hold on this from March to July" is the question
   * somebody asks about a record that is unexpectedly still here, and a `delete` would be the verb for
   * an operation that made that unanswerable.
   */
  app.post('/api/retention/holds/:id/release', async (request, response) => {
    const retention = options.retention;
    const id = request.params.id;
    let act: Act | undefined;
    try {
      const who = await options.permitted(request, response, 'retention.release', { target: holdTarget(id) });
      act = who.act;

      if (retention == null) {
        await act.failed('nothing-retained');
        response.status(409).json({ error: 'nothing-retained', message: NOTHING_KEPT });
        return;
      }

      const lifted = await retention.store.release(id, who.actor, at());
      if (!lifted) {
        // 409 rather than 404, because the usual cause is not a wrong id: it is two people looking at
        // the same page and the other one lifting it first. The distinction matters to the reader,
        // who otherwise concludes the hold never existed.
        await act.failed('not-in-force');
        response.status(409).json({
          error: 'not-in-force',
          message:
            `There is no hold \`${id}\` still in force. Either it was never placed, or somebody lifted it ` +
            'first — the trail records which, and the hold itself keeps who lifted it.',
        });
        return;
      }

      await act.performed();
      response.status(204).end();
    } catch (cause) {
      await act?.failed(cause);
      options.respondToFailure(response, cause);
    }
  });

  /**
   * Removing what is past its period.
   *
   * The only irreversible act this app performs, so it is the only one that asks the caller to state
   * what they expect it to do. `expect` is the row count the plan showed them; a disagreement means the
   * ground moved between reading and asking, and the answer to that is a refusal carrying the new plan
   * rather than a deletion of whatever is there now.
   */
  app.post('/api/retention/sweep', async (request, response) => {
    const retention = options.retention;
    let act: Act | undefined;
    try {
      const who = await options.permitted(request, response, 'retention.sweep');
      act = who.act;

      if (retention == null) {
        await act.failed('nothing-retained');
        response.status(409).json({ error: 'nothing-retained', message: NOTHING_KEPT });
        return;
      }

      const expected = (request.body as { expect?: unknown } | undefined)?.expect;
      if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
        await act.failed('unconfirmed');
        response.status(400).json({
          error: 'unconfirmed',
          message:
            'A sweep has to be confirmed with the number of records it is expected to remove, as ' +
            '`expect`. This is the one action here that cannot be undone, and the number is what proves ' +
            'the caller is acting on a plan they have read.',
        });
        return;
      }

      const now = at();
      const policy = await retention.store.policy();
      const holds = await retention.store.holds();
      const plan = await planRetention(retention.gateway, policy, holds, now);

      if (plan.wouldRemove !== expected) {
        // Named rather than left to the net, because this is the refusal a reader will come looking
        // for: it says the ground moved under a page somebody was acting from, which is a different
        // event from a malformed request even though both answer 409.
        await act.failed('plan-moved');
        response.status(409).json({
          error: 'plan-moved',
          message:
            `The plan now removes ${String(plan.wouldRemove)} records rather than the ${String(expected)} ` +
            'that were confirmed. Nothing was removed. Read the plan again — a period may have been ' +
            'changed, a hold placed or lifted, or a scan finished since it was shown.',
          wouldRemove: plan.wouldRemove,
        });
        return;
      }

      // The holds are read again, immediately before anything is removed.
      //
      // The plan above was computed from a read that is now several queries old, and a hold placed in
      // that window is precisely the case a hold exists for: somebody has just been told to preserve
      // this. Sweeping from the earlier list would delete a class that is held by the time the delete
      // runs. This cannot be closed completely without a transaction spanning the whole sweep, which
      // would hold a lock across every retained table, but it narrows the window from the width of
      // the plan to the width of one read — and it narrows it in the direction that preserves data.
      const inForce = await retention.store.holds();
      if (heldIds(inForce) !== heldIds(holds)) {
        await act.failed('holds-moved');
        response.status(409).json({
          error: 'plan-moved',
          message:
            'A legal hold was placed or lifted while this sweep was being prepared. Nothing was ' +
            'removed. Read the plan again — it will show what the hold now preserves.',
          wouldRemove: plan.wouldRemove,
        });
        return;
      }

      const sweep = await sweepRetention(retention.gateway, policy, inForce, who.actor, now);
      // Closed after the sweep, which is what puts the event above the floor the sweep just declared
      // rather than inside the prefix it removed. Nothing here restates the count: an event carries
      // the act and its outcome, and the numbers are in the response and in the plan the next read
      // returns. A count in a reason would be the first prose in a field `event.ts` holds to
      // identifiers.
      await act.performed();

      const payload: SweepPayload = {
        at: sweep.at.toISOString(),
        by: sweep.by,
        removed: sweep.removed,
        removals: sweep.removals.map((removal) => ({
          table: removal.table,
          retentionClass: removal.retentionClass,
          removed: removal.removed,
          before: removal.before.toISOString(),
        })),
        held: sweep.held.map((one) => ({ retentionClass: one.retentionClass, holds: one.holds })),
        ...(sweep.auditFloor != null ? { auditFloor: sweep.auditFloor } : {}),
      };
      response.json(payload);
    } catch (cause) {
      await act?.failed(cause);
      options.respondToFailure(response, cause);
    }
  });

  /**
   * Emptying the install.
   *
   * Confirmed with `expect`, like the sweep, and for the same reason — but against the record count
   * rather than the total, because the total includes the trail and the trail grows every time
   * anybody does anything. A refused reset records itself, so a caller retrying with the number the
   * refusal quoted would be refused again, by one, forever. The plan's `records` does not move under
   * the app's own bookkeeping.
   *
   * The order at the end is the whole act. The tables are emptied, `audit_events` among them, and only
   * then is the act closed — so the event this route writes lands in an empty log at sequence 1, naming
   * genesis as its predecessor. That event *is* the chain's new root, which is why nothing here appends
   * a second one to say a reset happened: a purpose-built "genesis" event beside the act's own would be
   * two records of one act, and the second would be the one nothing verified against a permission
   * check. ADR 0048's amendment.
   */
  app.post('/api/retention/reset', async (request, response) => {
    const retention = options.retention;
    let act: Act | undefined;
    try {
      const who = await options.permitted(request, response, 'retention.reset');
      act = who.act;

      if (retention == null) {
        await act.failed('nothing-retained');
        response.status(409).json({ error: 'nothing-retained', message: NOTHING_KEPT });
        return;
      }

      const expected = (request.body as { expect?: unknown } | undefined)?.expect;
      if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
        await act.failed('unconfirmed');
        response.status(400).json({
          error: 'unconfirmed',
          message:
            'A reset has to be confirmed with the number of records it is expected to remove, as ' +
            '`expect`. That is the count the plan reports as `records`, which is everything except the ' +
            'audit trail — the trail goes too, and its size moves whenever anybody does anything.',
        });
        return;
      }

      const now = at();
      const holds = await retention.store.holds();
      const plan = await planReset(retention.gateway, holds, now);

      // The holds first, because a held install is a refusal about the act rather than about the
      // number, and telling somebody their count is stale when the real answer is "a hold says no"
      // would send them to re-read a page that will refuse them again.
      if (plan.heldBy.length > 0) {
        await act.failed('held');
        response.status(409).json({
          error: 'held',
          message:
            `A legal hold is in force (${plan.heldBy.map((hold) => hold.id).join(', ')}), and a reset ` +
            'does not override one. Nothing was removed. Lift the hold first — which is itself ' +
            'recorded, and is the point: somebody decided this had to be preserved.',
          heldBy: plan.heldBy.map((hold) => hold.id),
        });
        return;
      }

      if (plan.records !== expected) {
        await act.failed('plan-moved');
        response.status(409).json({
          error: 'plan-moved',
          message:
            `This install now holds ${String(plan.records)} records rather than the ${String(expected)} ` +
            'that were confirmed. Nothing was removed. Read the page again — a run may have finished, ' +
            'or somebody may have answered a requirement, since it was shown.',
          records: plan.records,
        });
        return;
      }

      // The hold check that decides this is the one inside `resetInstall`, which reads them after the
      // holds table has been locked — see `ResetGateway.resetting`. This one is here to answer with the
      // 409 and the sentence, since by the time the transaction throws there is nothing left to say
      // beyond what went wrong. So it is a second read that can be beaten by a concurrent placement,
      // and being beaten costs nothing: the reset behind it refuses on its own read.
      const inForce = await retention.store.holds();
      if (heldIds(inForce) !== heldIds(holds)) {
        await act.failed('held');
        const standing = inForce.filter((hold) => hold.releasedAt == null).map((hold) => hold.id);
        // Said from what changed rather than assumed. In practice this is always a placement — a hold
        // that was already in force refuses at the check above, so by here nothing was held — but a
        // refusal that names a hold and then lists none sends the reader looking for something that is
        // not there, and the wording should not depend on that argument staying true.
        const placed = standing.filter((id) => !holds.some((hold) => hold.id === id && hold.releasedAt == null));
        response.status(409).json({
          error: 'held',
          message:
            placed.length > 0
              ? 'A legal hold was placed while this reset was being prepared. Nothing was removed. Read ' +
                'the page again — it will show what the hold now preserves.'
              : 'The legal holds changed while this reset was being prepared, so it was refused rather ' +
                'than run against an install other than the one confirmed. Nothing was removed, and ' +
                'nothing is held now: read the page again and it will go through.',
          heldBy: standing,
        });
        return;
      }

      const reset = await resetInstall(retention.gateway, () => retention.store.holds(), who.actor, now);
      // No target: the object of a reset is the install, and this app mints no id for one. The count
      // is what the event is for.
      await act.performed(undefined, { rows: reset.rows, tables: reset.tables });

      const payload: ResetPayload = {
        at: reset.at.toISOString(),
        by: reset.by,
        emptied: reset.emptied.map((one) => ({ table: one.table, removed: one.removed })),
        rows: reset.rows,
        tables: reset.tables,
      };
      response.json(payload);
    } catch (cause) {
      /*
       * The refusal, told apart from a fault.
       *
       * `resetInstall` reads the holds inside its transaction, after locking the table they live in, and
       * that read is the one that decides — which means it can refuse after the check above it passed: a
       * hold that commits in the gap is exactly the case the in-transaction read exists for. Left to the
       * generic handler it would answer 500, and "something went wrong" over an install that is intact
       * and deliberately protected is the wrong end of the two possible mistakes. Nothing was removed,
       * and the caller should be told why rather than that the app broke.
       */
      if (cause instanceof InstallHeld) {
        await act?.failed('held');
        response.status(409).json({
          error: 'held',
          message:
            'A legal hold was placed while this reset was running, and it takes precedence. Nothing ' +
            'was removed. Read the page again — it will show what the hold now preserves.',
          heldBy: cause.holds.map((hold) => hold.id),
        });
        return;
      }

      await act?.failed(cause);
      options.respondToFailure(response, cause);
    }
  });
}
