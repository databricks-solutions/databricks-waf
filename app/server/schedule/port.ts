// The four calls this app makes about its own scheduled job, and no more.
//
// A port rather than the SDK's `WorkspaceClient`, and the reason is not testability — though a fake of
// this needs no type assertion, where a fake of the client needed a double one. It is that the app's own
// identity is the one credential here that is not the signed-in user's, and what it may do should be
// legible from a type rather than from a promise in a comment. This interface is four methods wide;
// nothing reachable through it can read a table, a secret or a token, and a reviewer confirming that
// reads this file instead of auditing call sites.
//
// The real `WorkspaceClient` satisfies it structurally, so `client.ts` hands one over with no cast. The
// shapes below are deliberately the subsets that are used: adding a field here is how a new call gets
// noticed in review.

/** What the app asks about jobs. Satisfied by the SDK's client, and by a fake in a test. */
export interface JobsPort {
  list(request: { readonly name: string; readonly limit?: number }): AsyncIterable<{
    readonly job_id?: number;
    readonly settings?: JobSettings;
  }>;

  get(request: { readonly job_id: number }): Promise<{ readonly job_id?: number; readonly settings?: JobSettings }>;

  listRuns(request: {
    readonly job_id: number;
    readonly limit?: number;
    readonly active_only?: boolean;
    readonly expand_tasks?: boolean;
  }): AsyncIterable<JobRun>;

  runNow(request: { readonly job_id: number }): Promise<{ readonly run_id?: number }>;

  /** One run with its tasks, so the failed one can be named. Only asked about a run that failed. */
  getRun(request: { readonly run_id: number }): Promise<{ readonly tasks?: readonly JobRunTask[] }>;

  /**
   * What a task said as it failed, which is the only place the reason exists.
   *
   * The run's own `state_message` is the platform narrating the shape of the failure — "Task readiness
   * failed with message: Workload failed, see run output for details" — and never the cause. Measured on
   * labs, the cause was one call away and read "Changing an assessment is restricted to members of the
   * admins group, and 5af463d1-… is not one", which is the whole answer to why the cadence is not working.
   */
  getRunOutput(request: { readonly run_id: number }): Promise<{ readonly error?: string }>;
}

export interface JobRunTask {
  readonly run_id?: number;
  /**
   * Required, matching the SDK's own `RunTask.task_key`.
   *
   * Optional here first, which made "the platform did not name the task" look like a state the app had to
   * handle and a test assert. It is not one: a run that has tasks has keys on all of them, so the only way
   * the app fails to learn which step broke is a run it cannot read or one where nothing broke.
   */
  readonly task_key: string;
  readonly state?: { readonly life_cycle_state?: string; readonly result_state?: string };
}

export interface JobSettings {
  readonly name?: string;
  readonly schedule?: {
    readonly quartz_cron_expression: string;
    readonly timezone_id: string;
    readonly pause_status?: string;
  };
  readonly run_as?: { readonly user_name?: string; readonly service_principal_name?: string };
  /**
   * Where the job sends a failure, which is the field whose default is silently wrong.
   *
   * `resources/scheduled-scan.yml` sets `on_failure` to `${workspace.current_user.userName}`, and that
   * substitutes at deploy time to whoever ran the deploy. On a customer install that is very often an
   * engineer who set up a pilot and moved on, so the alerting is configured, looks configured, and
   * arrives nowhere. Nothing in the workspace calls that out — a job with a recipient looks the same as
   * a job with the right recipient — and this app is the only surface positioned to show a reader the
   * address and let them notice whose it is.
   */
  readonly email_notifications?: {
    readonly on_failure?: readonly string[];
  };
  /**
   * Read for one parameter and, since AUD-DEC-108, for the retry policy as well.
   *
   * The parameter is the identity the assessment authenticates as. Not the same as `run_as`, and the
   * difference is not academic: `run_as` is who runs the notebook; the notebook then calls the app's
   * scan route as the OAuth principal in `client_id`, and it is that one whose group membership decides
   * whether a scan is permitted and whose grants decide what the scan can see. Measured on labs, they
   * were two different identities and the panel named the wrong one — it said the assessment ran as the
   * bundle's deployer while every run was being refused for a service principal the reader was never
   * shown.
   *
   * The retry policy is per task rather than per job, and reading it from the job is the only way the
   * app can say it. The two tasks are deliberately different — the readiness task does not retry a
   * settled permission refusal, the assessment retries three times because its failures are transient —
   * so a single number would misdescribe both. `retriesOf` in `schedule.ts` takes the assessment's.
   */
  readonly tasks?: readonly {
    readonly task_key?: string;
    readonly notebook_task?: { readonly base_parameters?: Readonly<Record<string, string>> };
    readonly max_retries?: number;
    readonly min_retry_interval_millis?: number;
    readonly retry_on_timeout?: boolean;
  }[];
}

export interface JobRun {
  readonly run_id?: number;
  readonly state?: { readonly life_cycle_state?: string; readonly result_state?: string; readonly state_message?: string };
  readonly trigger?: string;
  readonly start_time?: number;
  readonly end_time?: number;
  readonly run_duration?: number;
  readonly run_page_url?: string;
  readonly attempt_number?: number;
}

/** The app's own identity, narrowed to the jobs it may ask about. */
export interface Workspace {
  readonly jobs: JobsPort;
}

/** Resolved lazily, because an install with no identity of its own must not pay for one. */
export type WorkspaceFactory = () => Promise<Workspace>;
