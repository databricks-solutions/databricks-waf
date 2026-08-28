// Whether the unattended assessment is working, and starting one by hand.
//
// # Why the read is ungated and the trigger is not
//
// The same split as the trail, the retention position and the run history, and for the same reason
// `run-routes.ts` gives at length: establishing that the nightly assessment actually ran is a question
// an auditor has without being someone who may start one, and making them hold the group that permits
// starting a scan in order to read whether one happened would be granting write access to satisfy a
// read. Whether a schedule exists, when it next fires and how the last ten runs ended are all facts
// about this app's own operation.
//
// Triggering is a change with a cost — a warehouse runs for minutes, and on a workspace where the
// assessors group is doing its job, the person who may spend that is a specific person. So it is gated
// by the same group that gates starting a scan by hand, and recorded as something a named person did,
// including when it was refused.
//
// # Why this is a job run and not a scan
//
// `POST /api/scan` already exists and starts a scan in this process. This route deliberately does not
// do that, and the difference is what it is for: it exercises **the schedule's own path** — the job,
// its compute, its run-as identity, its retry policy, its notifications — which is the half that fails
// silently at six on a Monday morning. An install whose scheduled runs have been failing for a month
// cannot find that out by clicking "Run a scan", because that is the path that works.
//
// So a reader who wants an assessment now uses the scan button, and a reader who wants to know whether
// the unattended one would work uses this. The two answers are not substitutes, and the surface says
// so rather than offering one button that does something ambiguous.

import type { Application, Request, Response } from 'express';

import type { SchedulePayload } from '../../shared/api/contract.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import type { Act } from '../audit/record.js';
import type { AssessmentNames } from '../schedule/schedule.js';
import { JOB_NAME, read } from '../schedule/schedule.js';
import type { ScheduleClient } from '../schedule/trigger.js';
import { trigger } from '../schedule/trigger.js';

export interface ScheduleRouteOptions {
  /**
   * The app's own client, or absent.
   *
   * Absent is a real configuration rather than a fault: a developer running locally against a CLI
   * profile has one, an install with no machine identity does not, and the routes answer `unreadable`
   * rather than failing. See `schedule/schedule.ts` for why this identity is the app's own and not the
   * signed-in user's — it is the one place in the app where that is true.
   */
  readonly client?: ScheduleClient;
  /**
   * How the assessment the job names becomes a name, where this install keeps definitions.
   *
   * Absent on an install that keeps none, and the read then reports the id the job carries without saying
   * whether anything answers to it. Ungated like the rest of this read: an assessment's name is on the
   * assessments page, which every reader may open.
   */
  readonly assessments?: AssessmentNames;
  readonly permitted: (
    request: Request,
    response: Response,
    action: AuditAction,
    context?: { readonly target?: AuditTarget; readonly correlation?: string }
  ) => Promise<{ readonly actor: string; readonly act: Act }>;
  readonly respondToFailure: (response: Response, cause: unknown) => void;
  readonly now?: () => Date;
}

export function scheduleRoutes(app: Application, options: ScheduleRouteOptions): void {
  const now = options.now ?? (() => new Date());

  app.get('/api/schedule', async (_request: Request, response: Response) => {
    try {
      const payload: SchedulePayload = await read({
        ...(options.client != null ? { client: options.client } : {}),
        ...(options.assessments != null ? { assessments: options.assessments } : {}),
        now,
      });

      response.json(payload);
    } catch (cause) {
      options.respondToFailure(response, cause);
    }
  });

  app.post('/api/schedule/run', async (request: Request, response: Response) => {
    let act: Act | undefined;
    try {
      // The target is the job by name rather than by id, because the id is not known until the job has
      // been found and the refusal has to be recorded whether or not it was. A name is what this app
      // has on the job anyway — see `schedule/schedule.ts` on why it is found rather than bound.
      const who = await options.permitted(request, response, 'schedule.trigger', {
        target: { kind: 'job', id: JOB_NAME },
      });
      act = who.act;

      if (options.client == null) {
        await act.failed('no-machine-identity');
        response.status(409).json({
          error: 'no-machine-identity',
          message:
            'This install has no machine identity, so the app cannot start its own scheduled job. A scan ' +
            'started by hand from the header does the same assessment; what it does not exercise is the ' +
            "schedule's own path.",
        });
        return;
      }

      const started = await trigger({ client: options.client, actor: who.actor });

      if (started.error != null) {
        // `failed` rather than `performed`: nothing is running, and an act recorded as performed would
        // tell an auditor a run began at a time when none did.
        await act.failed(started.error);
        response.status(started.status).json({ error: started.error, message: started.message });
        return;
      }

      await act.performed();
      response.status(202).json(started.run);
    } catch (cause) {
      await act?.failed(cause);
      options.respondToFailure(response, cause);
    }
  });
}
