// Reading what became of a run, and stopping one by name.
//
// These sit beside `/api/scan/status`, which they do not replace and are not a better version of. The
// two answer different questions and both are needed:
//
//   * `/api/scan/status` says what *this process* is doing right now. It is what the page polls to
//     show a progress count, and it goes back to "nothing running" when the process restarts, because
//     that is the truth about the process.
//   * `/api/runs/:id` says what became of a run somebody asked for. It is read from the database, so it
//     survives the restart, the retry and the cancel — which is the question a supervisor has, and the
//     one the app could not answer at all before runs were records.
//
// # Why the read is ungated and the cancel is not
//
// The same split as the trail and the retention position. What a run says about itself — when it was
// asked for, by whom, how many attempts it took, what became of it — is operational history, and the
// person asking is often not the person who may start one: an auditor establishing that the nightly
// assessment actually ran, or a reader working out why last night's numbers are missing. Making them
// hold the group that permits starting a scan so they can read whether one happened would be granting
// write access to satisfy a read.
//
// Cancelling is a change with a consequence somebody has to own, so it is gated and recorded as
// something a named person did — including when it was refused.

import type { Application, Request, Response } from 'express';

import type {
  RunPayload,
  RunRefusedPayload,
  RunsPayload,
  ScheduledScanSummary,
} from '../../shared/api/contract.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import type { Act } from '../audit/record.js';
import type { Run } from '../run/run.js';
import { RunNotJoinable, type Runs } from '../run/runs.js';
import { assessmentOf } from './assessment-query.js';

/** How many runs the listing answers with, and why it is not everything. */
export const RECENT_RUNS = 50;

export interface RunRouteOptions {
  /**
   * The run records, where this install keeps them.
   *
   * Absent means an install with nothing durable behind it, which is a real configuration rather than a
   * broken one: the app runs, scans work, and nothing survives a restart. These routes then say so in a
   * sentence instead of reporting an empty history, because an empty list and "no history is kept" look
   * identical to a reader and mean opposite things.
   */
  readonly runs?: Runs;
  readonly permitted: (
    request: Request,
    response: Response,
    action: AuditAction,
    context?: { readonly target?: AuditTarget; readonly correlation?: string }
  ) => Promise<{ readonly actor: string; readonly act: Act }>;
  readonly respondToFailure: (response: Response, cause: unknown) => void;
  readonly now?: () => Date;
}

const NOTHING_RECORDED =
  'This install keeps no run records, so there is no history of what was asked for or what became of ' +
  'it. A scan still runs and its result is still shown, but a run that is interrupted is lost rather ' +
  'than resumed, and a scheduled run that failed leaves nothing behind saying so. Bind a Lakebase ' +
  'instance and runs are recorded from that point.';

/**
 * One run, as a reader outside the process sees it.
 *
 * `now` decides whether the lease still holds, and is a parameter rather than a read of the clock so
 * that the lapsed case is assertable: it is the one branch here whose answer depends on when it is read.
 */
export function runPayload(run: Run, now: Date = new Date()): RunPayload {
  return {
    id: run.id,
    state: run.state,
    requestedAt: run.requestedAt.toISOString(),
    actor: run.actor,
    trigger: run.trigger,
    attempts: run.attempts,
    // Only while something holds it. A lapsed lease is reported as nothing holding the run, which is
    // what it means: the holder stopped renewing, and the date it stopped is not a claim on anything.
    ...(run.lease != null && run.lease.until.getTime() > now.getTime()
      ? { heldUntil: run.lease.until.toISOString() }
      : {}),
    ...(run.cancelRequestedAt != null ? { cancelRequestedAt: run.cancelRequestedAt.toISOString() } : {}),
    kind: run.kind,
    ...(run.scanId != null ? { scanId: run.scanId } : {}),
    ...(run.advisoryId != null ? { advisoryId: run.advisoryId } : {}),
    ...(run.finishedAt != null ? { finishedAt: run.finishedAt.toISOString() } : {}),
    ...(run.why != null ? { why: run.why } : {}),
    lookbackDays: run.request.lookbackDays,
    ...(run.request.pillars != null ? { pillars: run.request.pillars } : {}),
  };
}

/**
 * What a caller is told when its trigger collided with a run it may not carry on.
 *
 * `summary` is passed in rather than read here, because what a finished run found is a question about a
 * scan and this module knows only about runs. Present only for `terminal`, and only where the caller
 * could load the scan: see `RunRefusedPayload.summary` for why a supervisor needs it.
 */
export function refusedPayload(cause: RunNotJoinable, summary?: ScheduledScanSummary): RunRefusedPayload {
  return {
    error: 'run-not-joinable',
    refusal: cause.refusal,
    message: cause.message,
    run: runPayload(cause.run),
    ...(summary != null ? { summary } : {}),
  };
}

export function registerRunRoutes(app: Application, options: RunRouteOptions): void {
  const now = options.now ?? (() => new Date());

  /**
   * The runs this install has a record of, newest first.
   *
   * Capped, and the cap is not a page: nothing in the product asks for the run before last, and an
   * endpoint that could be asked for four years of nightly runs is one that reads a hundred thousand
   * rows to draw a list nobody scrolls. Where a reader wants an older run they have its id, from the
   * scan or from the job that asked for it.
   *
   * Two filters, and both exist because a supervisor has a question the id-addressed route cannot
   * answer. `?key=` is for the trigger whose response never arrived: the caller chose the key, so it
   * knows that, and it never saw the id the app minted. `?unfinished=true` is "is anything still going,
   * anywhere" — which is not what `/api/scan/status` reports, because that is about this process.
   */
  app.get('/api/runs', async (request, response) => {
    const runs = options.runs;
    if (runs == null) {
      // 200 with a sentence rather than an error, like the trail and the retention position: "nothing
      // is recorded" is a complete answer, and a failure status would render an error in its place.
      const nothing: RunsPayload = { durable: false, runs: [], unavailable: NOTHING_RECORDED };
      response.json(nothing);
      return;
    }
    const key = typeof request.query.key === 'string' ? request.query.key : undefined;
    try {
      const at = now();
      const found =
        key != null
          ? [await runs.byKey(key)].filter((one): one is Run => one != null)
          : request.query.unfinished === 'true'
            ? await runs.unfinished()
            : await runs.recent(RECENT_RUNS, assessmentOf(request));
      const payload: RunsPayload = { durable: true, runs: found.map((one) => runPayload(one, at)) };
      response.json(payload);
    } catch (cause) {
      options.respondToFailure(response, cause);
    }
  });

  /**
   * One run.
   *
   * A 404 for an id nothing knows, which is deliberately not the same answer as the one for an install
   * that records nothing: a supervisor polling an id it was given needs to tell "your run is gone" from
   * "this app never keeps runs", because the first is a fault and the second is a configuration.
   */
  app.get('/api/runs/:id', async (request, response) => {
    const runs = options.runs;
    const id = request.params.id ?? '';
    if (runs == null) {
      response.status(409).json({ error: 'nothing-recorded', message: NOTHING_RECORDED });
      return;
    }
    try {
      const run = await runs.get(id, assessmentOf(request));
      if (run == null) {
        response.status(404).json({
          error: 'no-such-run',
          message:
            `No run here has the id ${id}. Either it was never asked for, or it has been removed by a ` +
            'retention sweep — runs are kept for the assessment period, like the scans they produce.',
        });
        return;
      }
      response.json(runPayload(run, now()));
    } catch (cause) {
      options.respondToFailure(response, cause);
    }
  });

  /**
   * Stop a run, by name.
   *
   * Distinct from `POST /api/scan/cancel`, which stops whatever this process is doing and cannot name
   * what that was. This one is addressed, so a supervisor can stop the run it started rather than
   * whichever run happens to be in flight when its request lands — and it works on a run this process
   * is not running, because the request is recorded and obeyed by whoever picks the run up.
   */
  app.post('/api/runs/:id/cancel', async (request, response) => {
    const id = request.params.id ?? '';
    let act: Act | undefined;
    try {
      // Read before the gate, and only in order to name the act. What is being stopped decides which
      // action the trail gets — `advisory.cancel` for the advisor's run, `scan.cancel` for an assessment
      // — and a log where both read as a cancelled scan would say an assessment ended at a time when
      // none did. Not a permission bypass: the same read is served ungated by the route above, because
      // knowing what became of a run is not a privilege. Falls back to a scan where there is nothing to
      // read, so the refusal below is still recorded under an action that exists.
      const kind = (await options.runs?.get(id))?.kind ?? 'assessment';
      const who = await options.permitted(request, response, kind === 'advisory' ? 'advisory.cancel' : 'scan.cancel', {
        target: { kind: 'run', id },
      });
      act = who.act;

      const runs = options.runs;
      if (runs == null) {
        await act.failed('nothing-recorded');
        response.status(409).json({ error: 'nothing-recorded', message: NOTHING_RECORDED });
        return;
      }

      const cancelled = await runs.cancel(id);
      // `failed` rather than `performed` wherever nothing was stopped, for the reason the unaddressed
      // cancel gives: what an auditor takes from "somebody cancelled at 14:02" is that a run ended
      // there, and recording a cancellation that stopped nothing would make that reading false.
      if (cancelled === 'no-such-run') {
        await act.failed('no-such-run');
        response.status(404).json({
          error: 'no-such-run',
          message: `No run here has the id ${id}, so there was nothing to stop.`,
        });
        return;
      }
      // 409 rather than 404: the run is here and readable, and what it says is why this arrived too
      // late. The state is in the message because a supervisor cancelling a run it thought was stuck
      // wants to know it completed, which changes what it does next.
      if (cancelled === 'already-ended') {
        const ended = await runs.get(id);
        await act.failed('already-ended');
        response.status(409).json({
          error: 'already-ended',
          message:
            `This run had already finished as ${ended?.state ?? 'ended'}, so there was nothing to stop. ` +
            'What it read is recorded and can be read from the run.',
          ...(ended != null ? { run: runPayload(ended, now()) } : {}),
        });
        return;
      }

      await act.performed();
      // Read back rather than reporting what was asked for, so the answer carries the cancel date the
      // store wrote and whether a process still holds the run — which is what says "asked, not yet
      // stopped" rather than implying it has ended.
      response.json(runPayload((await runs.get(id))!, now()));
    } catch (cause) {
      await act?.failed(cause);
      options.respondToFailure(response, cause);
    }
  });
}
