// What this install can reach, on one page.
//
// # Why this is not gated
//
// For the reason the trail is not: the person who needs it is the person fixing a half-bound install,
// and the group that permits changes to an assessment is not the group that binds resources. An admin
// who has just added a warehouse and wants to know whether the app can see it should not have to be
// an assessor first, and the sentence they need — "no database is bound" — is one this app already
// says on four other pages to anybody who opens them.
//
// What that constrains is what may be in here, and the constraint is taken seriously: no schema
// contents, no estate data, no identifiers beyond the warehouse id the workspace already shows in the
// resource binding. And nothing in here spends the customer's money, which is the whole reason the
// warehouse reading is observed rather than probed — see `health.ts`.
//
// The lost audit events are the one exception that names people, and they are within the rule: an
// actor, an act and the id of what it was on are what the trail page already shows to everybody who can
// open the app, and a marker holds nothing the trail row it stands for would not have held.
//
// # Why it is not `/health`
//
// A path a platform probe would find. This app's liveness is AppKit's business and the fallback
// server's, and a monitor that started polling this one would take an identity probe with every
// poll. `/api/diagnostics` says who it is for: a person reading, once, while something is wrong.
//
// # Acknowledging a lost event is gated, though reading it is not
//
// Seeing that the trail is missing something needs nothing, for the reason above. Saying that somebody
// has looked at it is a statement, like an answer or a decision, and takes the same gate: the caller's
// groups, the verified identity, an event in the trail naming who did it. It does not repair anything
// and the route says so by what it writes: one more row beside the marker, and the marker untouched.

import type { Application, Request, Response } from 'express';
import type {
  AcknowledgedGapPayload,
  AuditGapPayload,
  AuditGapsPayload,
  DiagnosticsPayload,
  ReadingPayload,
} from '../../shared/api/contract.js';
import { readHealth, type HealthSources, type Reading } from '../health/health.js';
import { AUDIT_PHRASES, type AuditAction, type AuditTarget } from '../audit/event.js';
import type { Act } from '../audit/record.js';
import type { AuditGap, AuditGapLog, UnacknowledgedGaps } from '../store/audit-gaps.js';

export interface HealthRouteOptions {
  /**
   * What to read, composed per request rather than once at boot.
   *
   * A function of the request because two of the four readings depend on it: the identity probe needs
   * the caller's forwarded token, and there is no other authority to ask with. The rest could have
   * been captured at boot and are not, because a reading taken at boot and served an hour later is
   * the overclaim this whole module is arranged to avoid.
   */
  readonly sourcesFor: (request: {
    readonly headers: NodeJS.Dict<string | string[]>;
  }) => HealthSources | Promise<HealthSources>;
  readonly respondToFailure: (response: Response, cause: unknown) => void;
  /** Where lost events are marked. Absent on an install that keeps none, which cannot acknowledge. */
  readonly gaps?: AuditGapLog;
  /** The gate an acknowledgement goes through, the same one every other change takes. */
  readonly permitted?: (
    request: Request,
    response: Response,
    action: AuditAction,
    context?: { readonly target?: AuditTarget }
  ) => Promise<{ readonly actor: string; readonly act: Act }>;
  readonly now?: () => Date;
}

function readingOf(reading: Reading): ReadingPayload {
  return {
    dependency: reading.dependency,
    standing: reading.standing,
    provenance: reading.provenance,
    at: reading.at.toISOString(),
    detail: reading.detail,
    ...(reading.action != null ? { action: reading.action } : {}),
  };
}

function gapOf(gap: AuditGap): AuditGapPayload {
  return {
    id: gap.id,
    at: gap.at.toISOString(),
    actor: gap.actor,
    action: gap.action,
    // The vocabulary is the server's, for the reason `event.ts` gives: a client-side copy is a second
    // statement of it, and the failure is silent in both directions.
    phrase: AUDIT_PHRASES[gap.action] ?? gap.action,
    outcome: gap.outcome,
    ...(gap.target != null ? { target: { kind: gap.target.kind, id: gap.target.id } } : {}),
    cause: gap.cause,
  };
}

/**
 * The markers as the page is told them, or nothing for an install that keeps none.
 *
 * A read that failed is served as such, with an empty list beside the reason, and not as an empty list:
 * a page told "nothing lost" by a read that threw would be the one reading this record cannot afford.
 */
function gapsOf(found: UnacknowledgedGaps | undefined, unreadable: string | undefined): AuditGapsPayload | undefined {
  if (unreadable != null) return { gaps: [], truncated: false, unreadable };
  if (found == null) return undefined;
  return { gaps: found.gaps.map(gapOf), truncated: found.truncated };
}

export function registerHealthRoutes(app: Application, options: HealthRouteOptions): void {
  const now = options.now ?? (() => new Date());

  app.get('/api/diagnostics', async (request, response) => {
    try {
      const health = await readHealth(await options.sourcesFor(request));
      const auditGaps = gapsOf(health.gaps, health.gapsUnreadable);
      const payload: DiagnosticsPayload = {
        at: health.at.toISOString(),
        well: health.well,
        unrecorded: health.unrecorded,
        ...(auditGaps != null ? { auditGaps } : {}),
        readings: health.readings.map(readingOf),
      };
      response.json(payload);
    } catch (cause) {
      // `readHealth` catches each probe into its own reading, so reaching here means the composition
      // itself broke rather than a dependency. Which is worth a 500 rather than a page that reports
      // everything as unknown: the second would look like a diagnosis and be the absence of one.
      options.respondToFailure(response, cause);
    }
  });

  /**
   * Says that somebody has looked at a lost audit event.
   *
   * Idempotent in what it records: a second acknowledgement of the same event answers with the first,
   * and writes nothing, so two people acting on the same page do not each believe they dealt with it
   * and the name beside it is not rewritten by whoever clicked last.
   */
  app.post('/api/diagnostics/audit-gaps/:id/acknowledge', async (request, response) => {
    const gaps = options.gaps;
    if (gaps == null || options.permitted == null) {
      response.status(503).json({
        error: 'audit-gaps-unavailable',
        message:
          'This install keeps no markers for audit events it could not write, so there is nothing to ' +
          'acknowledge here.',
      });
      return;
    }

    const id = request.params.id ?? '';
    let act: Act | undefined;
    try {
      // The target is the lost event, named from the URL so a refusal at the gate is recorded against
      // the gap it was about rather than against nothing.
      const permission = await options.permitted(request, response, 'gap.acknowledge', {
        target: { kind: 'audit-gap', id },
      });
      act = permission.act;

      const done = await gaps.acknowledge(id, permission.actor, now());
      if (done == null) {
        await act.failed('unknown-gap', { kind: 'audit-gap', id });
        response.status(404).json({ error: 'unknown-gap', message: `No lost audit event is recorded with id ${id}.` });
        return;
      }

      // A repeat changed nothing, and the first acknowledgement already has its event: a second one
      // would put a second "acknowledged" in the trail for a gap that was acknowledged once.
      if (done.already) act.unchanged();
      else await act.performed({ kind: 'audit-gap', id });
      const payload: AcknowledgedGapPayload = {
        id,
        acknowledgedBy: done.by,
        acknowledgedAt: done.at.toISOString(),
        already: done.already,
      };
      response.json(payload);
    } catch (cause) {
      await act?.failed(cause);
      options.respondToFailure(response, cause);
    }
  });
}
