// Starting the scheduled job by hand.
//
// The one call this app makes that changes anything outside itself, and it is worth being clear about
// how narrow it is. The app's identity holds `CAN_MANAGE_RUN` on one job, granted by name in
// `resources/scheduled-scan.yml`; it can start that job and read it, and it cannot edit its schedule,
// its retry policy or its run-as identity. There is no other write-shaped outward call in the app, and
// `check:read-only` proves the estate collector has none.
//
// What a hand-started run does is exercise the path a scheduled one takes: the job's compute, its
// run-as identity's grants, its retry policy, its failure notification. That is the half nobody sees
// fail. The app's own `POST /api/scan` is the other half and always works, which is why one button
// cannot answer both questions — see `api/schedule-routes.ts`.

import type { ScheduleRunPayload } from '../../shared/api/contract.js';
import type { WorkspaceFactory } from './port.js';
import { JOB_NAME } from './schedule.js';

export type ScheduleClient = WorkspaceFactory;

export interface TriggerOptions {
  readonly client: ScheduleClient;
  /**
   * Who asked.
   *
   * Recorded in this app's audit log by the route, and **not** carried into the job run, which is a
   * limitation worth stating rather than working around. `run-now` takes no run name, and the one field
   * that would carry a note — `notebook_params` — replaces the task's `base_parameters` wholesale for
   * that run, which would strip the app URL and the credential the task needs and turn a hand-started
   * run into a failure. So the job's own history shows a `ONE_TIME` trigger, meaning somebody asked, and
   * who is answered by the app's trail.
   */
  readonly actor: string;
}

/**
 * What happened, as something the route can answer with directly.
 *
 * A result rather than a thrown error for the two refusals a caller can act on. `no-such-job` means
 * this install opted out of the schedule, and `already-running` means the answer is already on its way
 * — neither is an exception, and both need a status and a sentence rather than a stack.
 */
export type TriggerResult =
  | { readonly error?: undefined; readonly run: ScheduleRunPayload }
  | { readonly error: string; readonly status: number; readonly message: string };

export async function trigger(options: TriggerOptions): Promise<TriggerResult> {
  const workspace = await options.client();

  let jobId: number | undefined;
  for await (const job of workspace.jobs.list({ name: JOB_NAME, limit: 1 })) jobId = job.job_id;

  if (jobId == null) {
    return {
      error: 'no-such-job',
      status: 409,
      message:
        `No job named "${JOB_NAME}" is deployed in this workspace, so there is no scheduled assessment to ` +
        'start. It is the optional half of the bundle; deploying it adds the schedule, and until then ' +
        'assessments are the ones somebody runs.',
    };
  }

  // Asked before starting, because the job allows one run at a time and the platform's way of saying so
  // is a *run* that lands as SKIPPED with MAXIMUM_CONCURRENT_RUNS_REACHED. That run then sits in the
  // history this app reads to decide whether the cadence is healthy, so a double-click would report the
  // schedule as failing. Refusing here costs one call and keeps the health signal about the schedule.
  for await (const _active of workspace.jobs.listRuns({ job_id: jobId, active_only: true, limit: 1 })) {
    // No run id and no timestamp in the sentence. Both were there and both were wrong for a reader:
    // measured on labs, the message said "Run 533795292185972 began 2026-08-07T04:43:53.562Z" directly
    // above a list that showed the same run as "Fri 7 Aug, 14:43" — a bare fifteen-digit id and a raw
    // ISO instant with milliseconds, neither of which a person can match to the row beneath. The run is
    // in that list, with a link, which is where somebody who wants it should be sent.
    return {
      error: 'already-running',
      status: 409,
      message:
        'The scheduled assessment is already running, so a second one was not started — the job takes one at a ' +
        'time. It is the newest run listed here, and the completed scan appears there when it finishes.',
    };
  }

  const started = await workspace.jobs.runNow({ job_id: jobId });

  return {
    run: {
      runId: String(started.run_id ?? ''),
      // Waiting rather than running: `run-now` returns as soon as the run is accepted, and serverless
      // compute takes a couple of minutes to start. Reporting it as running would have the surface say
      // an assessment is under way while the estate has not been touched.
      state: 'waiting',
      trigger: 'hand',
    },
  };
}
