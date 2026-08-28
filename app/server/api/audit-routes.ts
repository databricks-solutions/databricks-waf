// Reading the trail.
//
// # Why this is not gated
//
// Every mutation in this app is refused to anybody outside the assessor group, and reading the trail
// deliberately is not. That looks inconsistent and is the opposite: the reader this exists for is an
// auditor, and an auditor is precisely the person who should *not* hold the group that permits
// changes. Gating the trail on that group would leave the one role it was built for as the one role
// that cannot see it, and the workaround — granting an auditor change rights so they can read — is a
// worse outcome than an open read.
//
// It is also not new exposure. The answers page names who answered each requirement, the decisions
// page names who accepted each risk, and the history page names who ran each scan. What the trail
// adds over those is the attempts: refused, failed, and the acts that leave no row of their own. So
// the honest description of the boundary is that anybody who can open this app can see who has been
// using it, which was already true, and that the app is opened through the Databricks Apps proxy
// with the customer's own permissions in front of it.
//
// A search is therefore not recorded either. It would be the only read in the app that writes, and
// a table that grows a row every time somebody opens the page that displays it is a table whose
// signal is buried by the act of looking for it.
//
// # Why an unrecognised filter is refused rather than ignored
//
// `?action=scan.started` is a plausible typo for `scan.start` and ignoring it serves the whole log
// under a heading that says one action. The reader gets a longer list than they asked for and
// nothing says why, which is the same silent-wrong-answer failure `check:routes` exists to catch on
// the client side. So an unknown action or outcome is a 400 naming the vocabulary.

import type { Application, Request, Response } from 'express';
import type { AuditEventPayload, AuditTrailPayload, AuditVerificationPayload } from '../../shared/api/contract.js';
import {
  AUDIT_ACTIONS,
  AUDIT_PHRASES,
  type AuditAction,
  type AuditOutcome,
  type ChainedAuditEvent,
} from '../audit/event.js';
import { MAX_PAGE, type AuditLog, type AuditQuery } from '../store/audit-log.js';

export interface AuditRouteOptions {
  /**
   * The trail. Absent means this install records nothing, which the page says rather than shows as
   * an empty list — an empty trail and no trail send a reader to opposite conclusions.
   */
  readonly audit?: AuditLog;
  /** Whether what it holds survives a restart, for the sentence the page shows. */
  readonly durable?: boolean;
  readonly respondToFailure: (response: Response, cause: unknown) => void;
}

const OUTCOMES: readonly AuditOutcome[] = ['performed', 'refused', 'failed'];

/** The vocabulary, paired with its prose, in the order `event.ts` groups it. */
const VOCABULARY = AUDIT_ACTIONS.map((id) => ({ id, phrase: AUDIT_PHRASES[id] }));

const NO_LOG =
  'This install records no events, so there is no trail to search. Events are written to the bound ' +
  'database, and this app has none — bind a Lakebase instance and the trail begins from that point. ' +
  'Nothing before it can be recovered, because an event nobody wrote down is not somewhere else.';

/** Thrown by the parser, caught by the route, and never reaches the failure responder. */
class BadFilterError extends Error {
  constructor(
    readonly parameter: string,
    message: string
  ) {
    super(message);
  }
}

function eventOf(event: ChainedAuditEvent): AuditEventPayload {
  return {
    sequence: event.sequence,
    at: event.at.toISOString(),
    actor: event.actor,
    executionMode: event.executionMode,
    action: event.action,
    outcome: event.outcome,
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
    digest: event.digest,
  };
}

function one(request: Request, name: string): string | undefined {
  const raw = request.query[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value.trim();
}

/**
 * A whole number from the query, or a refusal.
 *
 * `limit` and `before` both arrive as text and both have a wrong answer that looks like a right one:
 * `limit=abc` as `NaN` reaching the store becomes a page of whatever the driver makes of it, and
 * `before=0` would serve nothing while reading as the first page.
 */
function counted(request: Request, name: string, least: number): number | undefined {
  const raw = one(request, name);
  if (raw == null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < least) {
    throw new BadFilterError(
      name,
      `\`${name}\` must be a whole number of at least ${String(least)}, and was \`${raw}\`.`
    );
  }
  return value;
}

function dated(request: Request, name: string): Date | undefined {
  const raw = one(request, name);
  if (raw == null) return undefined;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw new BadFilterError(
      name,
      `\`${name}\` must be a date, and was \`${raw}\`. An ISO 8601 instant is what the trail records.`
    );
  }
  return at;
}

function queryFrom(request: Request): AuditQuery {
  const action = one(request, 'action');
  if (action != null && !AUDIT_ACTIONS.includes(action as AuditAction)) {
    throw new BadFilterError(
      'action',
      `\`${action}\` is not an act this app records. It records: ${AUDIT_ACTIONS.join(', ')}.`
    );
  }

  const outcome = one(request, 'outcome');
  if (outcome != null && !OUTCOMES.includes(outcome as AuditOutcome)) {
    throw new BadFilterError('outcome', `\`${outcome}\` is not an outcome. An event is ${OUTCOMES.join(', ')}.`);
  }

  const since = dated(request, 'since');
  const until = dated(request, 'until');
  if (since != null && until != null && since > until) {
    // Refused rather than swapped. A range the caller got backwards is a caller with the wrong idea
    // of what they are looking at, and silently correcting it hides that from them.
    throw new BadFilterError('since', '`since` is after `until`, so this range covers nothing.');
  }

  const actor = one(request, 'actor');
  const targetId = one(request, 'target');
  const correlation = one(request, 'correlation');
  const before = counted(request, 'before', 1);
  const limit = counted(request, 'limit', 1);

  return {
    ...(actor != null ? { actor } : {}),
    ...(action != null ? { action: action as AuditAction } : {}),
    ...(outcome != null ? { outcome: outcome as AuditOutcome } : {}),
    ...(targetId != null ? { targetId } : {}),
    ...(correlation != null ? { correlation } : {}),
    ...(since != null ? { since } : {}),
    ...(until != null ? { until } : {}),
    ...(before != null ? { before } : {}),
    // Clamped rather than refused, because a caller asking for more than a page is asking for
    // everything and the answer to that is the largest page plus a cursor, not an error.
    ...(limit != null ? { limit: Math.min(limit, MAX_PAGE) } : {}),
  };
}

export function registerAuditRoutes(app: Application, options: AuditRouteOptions): void {
  app.get('/api/audit', async (request, response) => {
    const log = options.audit;
    if (log == null) {
      // 200 with a sentence, for the reason the imports listing gives one: "nowhere to record" is a
      // complete answer to "what happened here", and an error status would have the page render a
      // failure instead of the explanation.
      const empty: AuditTrailPayload = {
        durable: false,
        events: [],
        actions: VOCABULARY,
        unavailable: NO_LOG,
      };
      response.json(empty);
      return;
    }

    let query: AuditQuery;
    try {
      query = queryFrom(request);
    } catch (cause) {
      if (cause instanceof BadFilterError) {
        response.status(400).json({ error: 'bad-filter', parameter: cause.parameter, message: cause.message });
        return;
      }
      options.respondToFailure(response, cause);
      return;
    }

    try {
      const page = await log.search(query);
      // The head comes from the log rather than from the page, so it is where the chain ends now
      // rather than where this page happens to stop. A reader recording it to pin the trail needs
      // the first; a reader paging needs `next`, which is separate for that reason.
      const head = await log.head();
      const payload: AuditTrailPayload = {
        durable: options.durable ?? false,
        events: page.events.map(eventOf),
        ...(page.next != null ? { next: page.next } : {}),
        ...(head.sequence > 0 ? { head: { sequence: head.sequence, digest: head.digest } } : {}),
        actions: VOCABULARY,
      };
      response.json(payload);
    } catch (cause) {
      options.respondToFailure(response, cause);
    }
  });

  /**
   * Whether the trail is still what this app wrote.
   *
   * Separate from `/api/records/verification`, which checks the scans, answers and decisions. Both
   * report and neither enforces, for the reason stated there — but the two are different claims and
   * a combined endpoint would let one of them pass while the reader read the other's result.
   */
  app.get('/api/audit/verification', async (_request, response) => {
    const log = options.audit;
    if (log == null) {
      const nothing: AuditVerificationPayload = {
        checked: 0,
        breaks: [],
        means: 'This install records no events, so there is no chain to verify.',
      };
      response.json(nothing);
      return;
    }

    try {
      const report = await log.verify();
      const payload: AuditVerificationPayload = {
        checked: report.checked,
        ...(report.head != null ? { head: { sequence: report.head.sequence, digest: report.head.digest } } : {}),
        breaks: report.breaks,
        means: report.means,
      };
      response.json(payload);
    } catch (cause) {
      // A verification that could not run must not read as one that passed, which is why this is a
      // 503 rather than a report of zero events with the reassuring sentence attached.
      response.status(503).json({
        error: 'verification-unavailable',
        message:
          'The trail could not be read back, so nothing about its integrity is being claimed. ' +
          `The database reported: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  });
}
