// The wire format, defined once for both sides of it.
//
// This file exists because the alternative was tried and drifted within a day. The
// client had its own hand-written copy of these shapes, on the reasonable argument that
// the server's types use `Date` and JSON does not. Then the footprint was restructured
// on the server, the client's copy still described the old shape, and the overview page
// compiled cleanly while rendering nothing. Two declarations of one contract will always
// end that way; the question is only how long it takes.
//
// So the date representation is a type parameter instead. The server builds
// `ScanPayload<Date>` and serialises it; the browser reads `ScanPayload<string>`, which
// is the default. One definition, both sides checked against it, and the difference
// between them is stated in the one place it actually exists.
//
// The payload is deliberately not the server's internal types re-exported. The response
// is a shaped view: the scheduler's budget records and limiter internals are collapsed
// into a per-surface summary here, so the wire format does not churn every time the
// scheduler grows a counter.

export type Outcome = 'pass' | 'fail' | 'partial' | 'unmeasurable' | 'not-applicable' | 'satisfied-by-architecture';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'informational';

export type ExecutionMode = 'on-behalf-of-user' | 'service-principal';

export type ScanState = 'complete' | 'partial';

export interface CoveragePayload {
  readonly mode: 'complete' | 'sampled';
  /** Which estate the mode is a statement about: the account, one metastore, or one workspace. */
  readonly reach?: 'account' | 'metastore' | 'workspace';
  readonly examined?: number;
  readonly population?: number;
  readonly basis?: string;
}

/**
 * Which surface produced a reading, under whose authority, and from where.
 *
 * Sent per piece of evidence rather than once per scan because a run holds more than one identity:
 * the estate is read as the signed-in user, the history is written as the app's service principal,
 * and object storage is read as whatever service credential the install configured. A per-scan
 * stamp reports the first of those as if it produced all three.
 *
 * What it is for is disagreement. A customer told a table carries eleven months of reclaimable
 * history should be able to run the same reading themselves, and these four fields are what that
 * takes: which surface, which collector on it, as whom, and where.
 */
export interface ProvenancePayload {
  readonly surface: 'sql' | 'describe' | 'rest' | 'cloud' | 'ai' | 'plans';
  readonly collector: string;
  /** `admin-cli` means no part of this app made the reading: an administrator ran the script and imported it. */
  readonly authority: ExecutionMode | 'service-credential' | 'admin-cli';
  readonly actor: string;
  /** Named as the reader would name it to read it again: a warehouse id, a host, a bucket. */
  readonly from?: string;
}

export interface EvidencePayload<TDate = string> {
  readonly signal: string;
  readonly observed: string;
  readonly expected?: string;
  readonly coverage: CoveragePayload;
  readonly collectedAt: TDate;
  /** Whether the outcome rests on this, or it locates a gap the outcome already stated. */
  readonly bearing?: 'outcome' | 'detail';
  /** Absent for evidence that came from outside a scan, where there is no authority to name. */
  readonly provenance?: ProvenancePayload;
  /**
   * The same resources `observed` names, as a list, so each can be its own link.
   *
   * Render this instead of `observed` where it is present, not alongside it: the two say the same
   * thing, and a page showing both asks the reader to read one list twice.
   * See server/resolve/locate.
   */
  readonly at?: LocatedPayload;
}

export interface LocatedPayload {
  readonly lead: string;
  readonly items: readonly LocatedItemPayload[];
  readonly more?: number;
}

export interface LocatedItemPayload {
  readonly label: string;
  /** Which workspace it is in, when more than one was assessed. Outside the link, not inside it. */
  readonly in?: string;
  readonly note?: string;
  /** Absent when this app has no route it trusts for the resource, or no URL for its workspace. */
  readonly url?: string;
  /**
   * What kind of resource it is, so two of them can be told apart when their names cannot.
   *
   * Not rendered. A finding may name a cluster and a SQL warehouse both called `analytics` in one
   * workspace — the auto-termination requirement names both kinds under one lead — and a reader
   * sees the difference in where each link goes. The inspector, folding those lists together, has
   * only these fields to go on, and without this it would treat the two as one resource named
   * twice. Absent on a record an older build wrote, where the fold falls back to the URL.
   */
  readonly kind?: 'job' | 'cluster' | 'warehouse' | 'pipeline' | 'table';
}

export interface FindingPayload<TDate = string> {
  readonly controlId: string;
  readonly pillarId: string;
  readonly principleId: string;
  readonly title: string;
  readonly outcome: Outcome;
  readonly severity: Severity;
  readonly coverage: CoveragePayload;
  readonly evidence: readonly EvidencePayload<TDate>[];
  readonly outcomeReason?: string;
  /** Why this is unknown, when it is. Absent on every other outcome. */
  readonly unmeasured?: Unmeasured;
  /**
   * What the reader can do to make this measurable, when a signal it needed did not answer.
   *
   * Distinct from `ControlPayload.remediation`, which is how to fix a requirement the app
   * measured and found unmet. This is the step before that: how to get an answer at all.
   */
  readonly remedy?: RemedyPayload;
  /** Present when someone's answer is part of this finding. See `AttestedFactPayload`. */
  readonly attested?: AttestedFactPayload<TDate>;
  /**
   * How firmly the outcome is established, and what stops it being firmer.
   *
   * Derived from the finding rather than stored on it, so a run recorded before this existed gains
   * it on being read and it can never disagree with the finding it describes. Nothing here is a
   * weight: a sampled observation and a complete one score identically, exactly as before.
   */
  readonly confidence?: ConfidencePayload;
  /**
   * How long this requirement has held this outcome, over the runs that can be compared to this one.
   *
   * Absent when the run was presented without a history to walk — which is a fact about the request
   * rather than about the estate, and is why it is optional rather than a streak of one.
   */
  readonly occurrence?: OccurrencePayload<TDate>;
}

/**
 * How firmly a finding is established. Distinct from a decision's `Standing`, which is about
 * whether a risk acceptance still holds.
 */
export type ConfidenceStanding = 'established' | 'qualified' | 'stated' | 'none';

export type LimitationKind = 'sampled' | 'reach' | 'imported' | 'attested' | 'expiring' | 'carried';

export interface LimitationPayload {
  readonly kind: LimitationKind;
  /** Shown verbatim. States what may not be concluded, not what went wrong. */
  readonly says: string;
}

export interface ConfidencePayload {
  readonly standing: ConfidenceStanding;
  /** One sentence saying what the standing rests on. Present even when nothing qualifies it. */
  readonly because: string;
  readonly limitations: readonly LimitationPayload[];
}

/** Why an occurrence history stops where it does. See `server/scan/occurrence.ts`. */
export type Horizon =
  | 'first-run'
  | 'changed'
  | 'not-comparable'
  | 'unrecorded'
  /** A catalogue release moved what this requirement asks, so an earlier answer answered something else. */
  | 'redefined'
  /** A catalogue release introduced this requirement, so the streak is its whole life. */
  | 'introduced'
  | 'retention';

export interface OccurrencePayload<TDate = string> {
  /** Consecutive runs, this one included, that reached the same outcome. Always at least 1. */
  readonly runs: number;
  readonly since: TDate;
  /** What says whether the streak is the whole story or only as far back as this build can see. */
  readonly horizon: Horizon;
  /** The outcome before the streak. Present only at `horizon: 'changed'`. */
  readonly changedFrom?: { readonly outcome: Outcome; readonly at: TDate };
}

/**
 * The action that would make an unmeasured requirement measurable, and who can take it.
 *
 * Ordered nearest-first: what the reader can fix themselves, what their platform team can fix,
 * what nobody can fix, and what is this app's own bug. The distinction earns its place because
 * getting it backwards is expensive in trust — an admin sent to grant something ungrantable
 * comes back having learnt to ignore the next message the app shows them.
 */
export type RemedyKind = 'grant' | 're-authorise' | 'attest' | 'enable' | 'retry' | 'report';

export interface RemedyPayload {
  readonly kind: RemedyKind;
  /** Shown verbatim. Written in the second person and names the specific thing. */
  readonly says: string;
  /** The platform's own refusal, so the sentence above can be checked rather than trusted. */
  readonly because?: string;
  /** The signals whose failure produced this, for a reader who wants to see the query. */
  readonly signals: readonly string[];
}

/** An answer to a requirement no telemetry can reach, as the UI reads it. */
export interface AttestedFactPayload<TDate = string> {
  /**
   * The attestation this fact came from. Absent on scans recorded before the field existed.
   */
  readonly id?: string;
  /** Whether the outcome rests on this answer, or a measurement decided it and this is beside it. */
  readonly bearing: 'outcome' | 'record';
  readonly by: string;
  readonly at: TDate;
  readonly statement: string;
  readonly owner: string;
  readonly evidenceUrl?: string;
  readonly reviewBy: TDate;
}

/**
 * Why a requirement is unknown, in the one dimension that decides what to do about it.
 *
 * `unreachable` and `unbuilt` are worth keeping apart even though both mean "no check ran": the
 * first is a scope Databricks Apps does not offer any app, so it needs an answer from a person and
 * an ask of the platform team, and the second is this project's own backlog.
 *
 * `disabled` is the only one that is not a gap: this install told the app not to score it. Not "not to
 * ask" — ADR 0059's second amendment makes a decision lapse when the reading turns `fail`, which it can
 * only do by taking the reading on every run. It travels on the wire so a surface can say that instead
 * of falling to `unreadable`, which claims the app tried and was refused.
 */
export type Unmeasured = 'attestation' | 'unreachable' | 'unbuilt' | 'unreadable' | 'disabled';

/** What the score would be if every unmeasured requirement failed, and if every one passed. */
export interface ScoreRangePayload {
  readonly low: number;
  readonly high: number;
}

export interface PillarScorePayload<TDate = string> {
  readonly pillarId: string;
  readonly score?: number;
  readonly range?: ScoreRangePayload;
  readonly counts: Readonly<Record<Outcome, number>>;
  readonly scored: number;
  readonly unmeasurable: number;
  /** The unmeasured split by what would answer them: a person, us, or access. */
  readonly unmeasuredBy: Readonly<Record<Unmeasured, number>>;
  /** What the scored requirements rest on, counted by class: measured, imported, or answered. */
  readonly composition: CompositionPayload;
  readonly notApplicable: number;
  readonly total: number;
  readonly worstFirst: readonly FindingPayload<TDate>[];
}

/**
 * How many scored requirements rest on each class of evidence.
 *
 * Every class is present, including at zero, so a consumer can render the mixture without deciding
 * what an absent key meant. `admin-collected` is zero in every run this build can produce; H4 is what
 * makes it non-zero, and the field exists now so that a report which states composition does not have
 * to change shape when it does.
 */
export type CompositionPayload = Readonly<Record<'observed' | 'admin-collected' | 'attested', number>>;

export interface ScorePayload<TDate = string> {
  readonly overall?: number;
  readonly range?: ScoreRangePayload;
  readonly pillars: readonly PillarScorePayload<TDate>[];
  readonly counts: Readonly<Record<Outcome, number>>;
  readonly scoredControls: number;
  /** Of `scoredControls`, what they rest on, by class. The same accounting as a pillar's. */
  readonly composition: CompositionPayload;
  readonly totalControls: number;
  /**
   * What a customer's applicability decisions took out of this score, and what lapsed.
   *
   * Absent when nothing was excluded, so a run from an install with no applicability path — or one
   * recorded before this existed — carries no exposure rather than an empty one. The lists let a
   * surface name what was removed from the denominator; the counts alone drive the provenance
   * sentence. See the server's `apply/apply.ts`.
   */
  readonly exposure?: ExposurePayload;
}

/** Which lever a customer used to take a requirement out of the score. */
export type ApplicabilityLeverPayload = 'not-applicable' | 'disabled';

/** One requirement taken out of the score, with who owns the decision and why. */
export interface ExclusionPayload {
  readonly controlId: string;
  readonly lever: ApplicabilityLeverPayload;
  readonly owner: string;
  readonly reason: string;
  readonly decisionId: string;
}

/** A decision set aside because the reading turned against it, so it did not move the score. */
export interface LapsePayload {
  readonly controlId: string;
  readonly lever: ApplicabilityLeverPayload;
  /** The reading that set it aside: `fail` or `partial`. */
  readonly reading: Outcome;
  readonly decisionId: string;
}

export interface ExposurePayload {
  readonly excluded: readonly ExclusionPayload[];
  readonly lapsed: readonly LapsePayload[];
  /**
   * How many pillars had a score before these decisions and have none after, so are not in the estate
   * mean.
   *
   * A count, and deliberately not a list: the provenance sentence built on it may say how many pillars
   * left the average and may not name one. Absent means none, or a run recorded before this was
   * computed.
   */
  readonly pillarsEmptied?: number;
}

export interface ScopePayload {
  /** The workspace the app runs in. Identifies the workspace-reach findings, not a filter. */
  readonly hostWorkspaceId?: string;
  /** Present only when the user asked to assess one workspace instead of the account. */
  readonly narrowedTo?: string;
  /**
   * The workspaces the run was asked to cover, when it was asked for a set of them.
   *
   * Distinct from `narrowedTo`, which is one workspace and forces every finding to workspace reach.
   * A set keeps account reach — a read of six workspaces is still a read across the account — so the
   * two cannot be collapsed into one field without making one of them lie. Absent means the whole
   * assessable estate.
   */
  readonly selected?: readonly string[];
  /** Shown verbatim, so what was covered reads as a stated fact rather than a caveat. */
  readonly description: string;
}

/**
 * What started a run. Absent on runs recorded before this was written.
 *
 * Note this is not `executionMode`, and the two are easy to confuse. This says what started the run
 * and that says what kind of identity ran it, and neither implies the other: a person can start a
 * run that a service principal executes, and a schedule is not the only thing a principal can start.
 * Until row 40f the mode was a literal, so every run said `on-behalf-of-user` and only `actor` told
 * the two apart. Runs recorded before it still say that, and their actor still tells them apart.
 */
export type ScanTriggerPayload = 'interactive' | 'scheduled';

/**
 * Whether an unattended assessment is going to happen again.
 *
 * Five states rather than a boolean, because the action each one calls for is different and three of
 * them look identical to a reader who is only told "no". `not-deployed` means the optional job was
 * never installed and the reader is running this by hand on purpose; `no-schedule` means the job is
 * there with its schedule removed, which is somebody's edit rather than a default; `paused` is the
 * state a fresh install ships in and the one action away from working; `unreadable` means the app
 * could not look, which is not the same as nothing being there.
 */
export type ScheduleStatePayload = 'not-deployed' | 'no-schedule' | 'paused' | 'live' | 'unreadable';

/** How a run of the scheduled job came about. */
export type ScheduleTriggerPayload = 'schedule' | 'hand' | 'retry' | 'unknown';

/**
 * One run of the scheduled job, as the platform recorded it.
 *
 * Distinct from `RunPayload`, which is this app's own record of a scan, and the two are not
 * interchangeable: a job run that never reached the app — a permission refusal, a compute failure, a
 * start that timed out — has no `RunPayload` at all, and those are exactly the runs a reader needs to
 * see. A cadence that is failing before it arrives is invisible in the app's own history.
 */
export interface ScheduleRunPayload<TDate = string> {
  readonly runId: string;
  readonly state: 'succeeded' | 'failed' | 'cancelled' | 'running' | 'waiting' | 'unknown';
  readonly trigger: ScheduleTriggerPayload;
  readonly startedAt?: TDate;
  readonly finishedAt?: TDate;
  /** The platform's own duration, which excludes time spent queued. */
  readonly durationMs?: number;
  /** Set on a failure, where the platform said why. */
  readonly message?: string;
  /**
   * What the failing task itself said, where the app could read it.
   *
   * Distinct from `message`, which is the platform describing the shape of the failure and not its
   * cause: measured on labs, every failed run's `message` was "Task readiness failed with message:
   * Workload failed, see run output for details", and the reason was one call away and read "Changing
   * an assessment is restricted to members of the admins group, and 5af463d1-… is not one". A reader
   * who has to open the workspace to learn which grant is missing has been sent away by the one panel
   * that exists to tell them.
   *
   * Only on the newest failure. It costs two calls, and the answer for an older run is the same answer
   * or archaeology.
   */
  readonly reason?: string;
  /** The run in the workspace, for a reader who needs the task log rather than the summary. */
  readonly url?: string;
  /**
   * Which attempt this run was, counting *job-level* retries only.
   *
   * Not the number a reader of this job wants, and the distinction cost a released defect. The Jobs API
   * increments `attempt_number` by creating a new run with an `original_attempt_run_id`, which happens
   * only under a job-level `max_retries` — and this job has none. Its retries are per task, and a task
   * retry keeps the same job run id (ADR 0064), so this field never moves off its default here.
   *
   * Kept because it is true of jobs that do set a job-level policy, and because its two consumers —
   * `runCaption` in `schedule-language.ts` and `captionOf` in `HistoryPage.tsx` — both mention it only
   * above one, so it stays silent rather than misleading. Nothing may derive "will it try again" or "it has
   * finished trying" from it, or from anything else: see `covered`.
   */
  readonly attempt?: number;
  /**
   * Whether the assessment is among the steps that broke — the step whose policy `supervision` reports.
   *
   * The fact that decides what a reader does about a red row, and the one the panel could not previously
   * tell them: `true` sends them to a traceback and `false` to a grant, because the bundle never retries
   * the readiness step.
   *
   * Read with `broke`, and not without it. This says *whether* the assessment was among them, not that it
   * was the only one, and a sentence that reads it as the latter is wrong on the run where two steps
   * failed.
   *
   * That run is not reachable on the job this repository's bundle deploys, and saying so is the point rather
   * than a reason to skip it. `assess` depends on `readiness`, so a readiness failure leaves `assess`
   * `UPSTREAM_FAILED`, which is deliberately not counted as broken. Two broken steps needs a job somebody
   * edited or built by hand — which the app reads whenever it carries the bundle's name.
   *
   * It also does not say the policy `supervision` reports is the one that governed *this* run. The policy
   * is read from the job now; the run may have finished ten weekly ticks ago; no field joins them.
   *
   * Deliberately not "will it retry" or "has it finished retrying". This surface carried each of those in
   * turn and both were false — the first on every failure the panel can render, the second on any job with
   * a *job-level* retry policy, where a retry is a new run and the original sits terminal and failed while
   * its retry is still going. Neither is derivable from what the app reads, so neither is claimed.
   *
   * Absent where nothing broke, which is a real state rather than a gap: a run cancelled for concurrency,
   * or one whose tasks were all skipped, reaches a result without any step having run. Rendered as silence.
   */
  readonly covered?: boolean;
  /**
   * How many steps broke, so a sentence about `covered` can be plural where the run was.
   *
   * Sent because `covered` alone cannot carry one: it is a disjunction over the broken steps, and every
   * definite-singular rendering of it — "the step that failed is the assessment" — is false when two
   * failed. Counting them is what makes the difference sayable.
   *
   * `FAILED` and `TIMEDOUT` only. A step taken down by one that broke did not break, and its error is the
   * run's own message again.
   */
  readonly broke?: number;
}

/**
 * What the job is configured to do about a failure, as against what it is configured to do at all.
 *
 * Two facts, and they answer the two questions a reader has about an unattended run that went wrong:
 * will it try again by itself, and does anybody hear about it if it does not.
 */
export interface SupervisionPayload {
  /**
   * How many times the assessment retries itself, and how a retry behaves. Absent where it does not.
   *
   * The assessment task's policy rather than the job's, because there is no job-level one: the readiness
   * task deliberately does not retry — its answer will not change by being asked again — and averaging
   * the two would describe neither. See `resources/scheduled-scan.yml`.
   */
  readonly retries?: {
    readonly times: number;
    /** How long it waits between attempts, where the job says. */
    readonly waitMs?: number;
    /**
     * Whether a run that ran out of time is retried.
     *
     * Worth its own field because the answer is counter-intuitive and load-bearing: a retry rejoins the
     * assessment already in flight rather than starting a second one, so retrying a timeout costs one
     * request and gains the result. A reader who assumes otherwise reads `true` here as a duplicate bill.
     */
    readonly onTimeout?: boolean;
  };
  /**
   * Who is emailed when a scheduled assessment fails.
   *
   * Named rather than counted, and that is the whole reason this field exists. The bundle's default
   * resolves at deploy time to whoever deployed, so the common failure is not an unconfigured recipient
   * but a configured one who has left. A reader can only notice that if they see the address.
   */
  readonly notifies?: readonly string[];
  /**
   * How many of the job's failure recipients are unsubstituted bundle variables.
   *
   * Its own state because the two alternatives both misreport it. Printing `${workspace.current_user.
   * userName}` to a reader as an address shows them a bug dressed as a recipient; dropping it silently and
   * saying no address is set is worse, because one *is* set. So the shape is dropped from `notifies` and
   * counted here.
   *
   * A count and not a flag. As a boolean it meant "one or more" and the panel rendered "one further
   * recipient" from it, which is a number the app had not read.
   *
   * Nothing here says what happens to those failures. Whether a literal `${...}` in a recipient field
   * silently drops the notification, bounces, or is rejected at deploy is not something this app has
   * observed, and the port reads neither per-task notifications nor webhooks, so it cannot see the rest of
   * the channel either.
   */
  readonly unresolved?: number;
}

/**
 * The assessment a scheduled run answers to, read from the parameter the job carries it in.
 *
 * `GAP-036` asks that scheduled work carry an immutable target and report it, on the reasoning that a
 * schedule resolving its target when it fires silently changes assessment the moment a definition is
 * added. Measured while scoping row 55, the position was quieter than that: the job named no assessment
 * at all, so every unattended run was recorded outside every definition. This is the parameter that
 * fixes it, and this payload is the reporting half.
 *
 * Present whenever the job sets the parameter, whatever it holds. Absent means the job does not set it —
 * an install that has opted out of naming one, or a job deployed before the parameter existed — and the
 * two are the same fact to a reader: nothing the schedule produces answers to an assessment.
 */
export interface ScheduledAssessmentPayload {
  /** The id the job carries. Absent only where the parameter holds an unsubstituted bundle variable. */
  readonly id?: string;
  /**
   * What that assessment calls itself, where this install still keeps it.
   *
   * Resolved against the definition store rather than carried by the job, because the job holds an id and
   * a name in a job parameter would be a second copy of something the author can rename. Absent where
   * this install keeps no definitions, where the id names none, and where the store could not be read —
   * so a reader falls back to the id rather than to an empty space.
   */
  readonly name?: string;
  /**
   * True where the store was read and keeps no assessment under that id.
   *
   * Distinct from `name` being absent, which also happens on an install that keeps no definitions and on
   * a store that would not answer. This says the lookup happened and came back empty, which is the state
   * behind a job that fails every week: `POST /api/scan/scheduled` refuses a run naming an assessment it
   * cannot find.
   */
  readonly missing?: boolean;
  /** True where the assessment is archived, which the scan route also refuses a new run against. */
  readonly archived?: boolean;
  /**
   * True where the parameter holds an unsubstituted bundle variable rather than an id.
   *
   * The same third state `SupervisionPayload.unresolved` carries and for the same reason: printing
   * `${var.schedule_assessment_id}` to a reader as an assessment id shows them a bug dressed as a target,
   * and dropping it silently reports a job that names nothing as one that names none.
   */
  readonly unresolved?: boolean;
}

/** Whether the unattended assessment is working, when it next runs, and what it has been doing. */
export interface SchedulePayload<TDate = string> {
  readonly state: ScheduleStatePayload;
  readonly jobId?: string;
  /** The cadence in words, absent where the expression is one the app will not claim to have read. */
  readonly cadence?: string;
  readonly cron?: string;
  readonly timezone?: string;
  /** When the next run falls. Absent when paused, and when the cadence could not be read. */
  readonly dueAt?: TDate;
  /** The identity the job's notebook runs as. Supervises the run; does not perform the assessment. */
  readonly ranAs?: string;
  /**
   * The identity the assessment authenticates as, whose grants decide what a scheduled run can see.
   *
   * The one that matters, and not the same as `ranAs`. The notebook runs as `ranAs` and then calls the
   * app's scan route as this OAuth principal, so this is the membership that decides whether a scan is
   * permitted at all. Measured on labs they were two different identities, and naming only `ranAs` told
   * the reader the assessment ran as the bundle's deployer while every run was in fact being refused
   * for a service principal the panel never mentioned.
   */
  readonly assessesAs?: string;
  /**
   * What the job does when the assessment fails, read from the job rather than assumed.
   *
   * The bundle is authoritative for four things — schedule, run-as identity, retries and notifications
   * (AUD-DEC-108) — and the app's job is to show all four, because a reader who can only see two has to
   * open the repository to check the rest. The panel already carried the schedule and the identity and
   * cited a retry policy it never named.
   *
   * Absent where the job sets neither, which is a real state rather than a defect: a job with no retries
   * and no recipient fails once, silently, and telling a reader that is the point.
   */
  readonly supervision?: SupervisionPayload;
  /**
   * The assessment the job's runs answer to, as the job's own parameter says.
   *
   * Read from the job for the same reason `assessesAs` is: the job is authoritative about it, and the app
   * is deliberately not the place that decides what a scheduled run measures. Absent where the job sets no
   * such parameter.
   */
  readonly answers?: ScheduledAssessmentPayload;
  readonly runs: readonly ScheduleRunPayload<TDate>[];
  /**
   * Whether there is a job here that could be started by hand.
   *
   * A fact about the install, not about the reader. Whether *this* reader may start it is settled by
   * the gate when they try, and answered with the sentence that gate has been giving since the first
   * scan button — the app shows the action and explains a refusal rather than hiding what somebody
   * cannot do, which is the convention every other write in it follows. A second identity probe per
   * page load, to grey out one button, would buy a worse message.
   */
  readonly triggerable: boolean;
  /** Present only on `unreadable`, and says what was tried. */
  readonly unreadable?: string;
}

export type PublicMethodologyStatePayload = 'candidate' | 'released';

export interface PublicMethodologyIdentityPayload {
  readonly publicVersion: number;
  readonly manifestDigest: string;
  readonly state: PublicMethodologyStatePayload;
  readonly effectiveDate?: string;
}

export interface StampPayload {
  /**
   * The public customer methodology this run belongs to. Absent means a pre-release development
   * record; a catalogue revision alone must never be promoted into this field by a reader.
   */
  readonly publicMethodology?: PublicMethodologyIdentityPayload;
  readonly catalogueVersion: string;
  readonly catalogueFingerprint: string;
  readonly executionMode: ExecutionMode;
  readonly actor: string;
  /**
   * What the actor called itself when the run happened. For display; `actor` remains the identity.
   *
   * Recorded rather than resolved, and that is the whole design. A service principal's actor is an
   * application id, so a reader of the history sees a UUID where a colleague's row shows an email —
   * and the name that would fix it cannot be looked up later without an entitlement this app does not
   * hold. So it is captured at the moment the run is stamped, from the scanning identity's own SCIM
   * record, which is the one form of the question any identity may ask.
   *
   * A snapshot, deliberately. Rename the principal and old runs go on showing the name that was true
   * when they ran, which is what a record is for. `actor` is what joins them.
   *
   * Absent on runs recorded before this was written, and on any run whose SCIM probe did not answer —
   * so every reader falls back to the id rather than to an empty space.
   */
  readonly actorName?: string;
  readonly trigger?: ScanTriggerPayload;
  readonly scope: ScopePayload;
  readonly lookbackDays: number;
  /** Absent when the workspace directory could not be read, which is not the same as none. */
  readonly assessedWorkspaces?: readonly string[];
  /** The assessment this run answers to. Absent means it was started directly, not that one is missing. */
  readonly definition?: RunDefinitionPayload;
  /** What produced the run. Absent on runs recorded before the app noted it. */
  readonly identity?: RunIdentityPayload;
}

export interface RunDefinitionPayload {
  readonly id: string;
  readonly version: number;
  /** What two runs of one assessment are compared on: equal fingerprints, same question. */
  readonly fingerprint: string;
  /**
   * What the assessment was called when this run answered to it.
   *
   * Recorded here rather than joined at read time, and the two are not the same answer. A definition
   * can be renamed and can be archived, and a page that looked the name up now would relabel a run
   * from six months ago with a name nobody used then. This is the run's own record of what it was
   * answering, and it survives both.
   *
   * Absent on a run recorded before the app kept it, which is not the same as a run answering to
   * nothing — `definition` itself being absent is that. The header says which of the two it is
   * rather than treating them alike, because "started directly" and "we have lost the name" send a
   * reader to different places.
   */
  readonly name?: string;
}

/** One dimension of what produced a run: what it was, or why the app could not establish it. */
export interface AxisPayload {
  readonly id?: string;
  readonly unknown?: string;
}

export interface RunIdentityPayload {
  /** This app's version and a digest of the server bundle that ran. */
  readonly build: AxisPayload;
  /** A digest of the weighting and the credit each outcome earns. */
  readonly methodology: AxisPayload;
  /** The encoding the run is written down under. */
  readonly record: AxisPayload;
  /** Which surfaces answered, sorted. A surface that refused is not one that answered. */
  readonly sources: readonly string[];
  /**
   * Requirements removed from the score by applicability decisions, with their lever when recorded.
   * Absent on runs from before this dimension was stored; see the comparison rule for that distinction.
   */
  readonly exclusions?: readonly string[];
}

/**
 * One surface's activity, flattened from the scheduler's separate budget, counter and
 * limiter records.
 *
 * `budget` is included because "the scan stopped early" and "the scan used a tenth of
 * what it was allowed" are the two facts a reader needs to judge whether the limits are
 * set sensibly for their workspace.
 */
export interface SurfaceActivityPayload {
  readonly surface: string;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly retries: number;
  readonly spent: number;
  readonly budget: number;
  /**
   * Calls made, which exceeds `succeeded + failed` by whatever the retries cost.
   *
   * Absent on runs recorded before ADR 0093, and the distinction matters when reading an
   * old run: a missing count is a run that did not record one, not a run that made none.
   */
  readonly attempts?: number;
  /**
   * What the failures on this surface ended as, by kind, largest first. Empty where
   * nothing failed, and absent on runs recorded before ADR 0093.
   *
   * Present because `failed: 6` is not actionable and six statements throttled is a
   * different instruction to the reader than six refused for want of a grant.
   */
  readonly refusals?: readonly TerminalFailurePayload[];
}

/** One kind of terminal failure and how many of a surface's tasks ended on it. */
export interface TerminalFailurePayload {
  readonly kind: string;
  readonly tasks: number;
}

export interface FootprintPayload {
  readonly surfaces: readonly SurfaceActivityPayload[];
  readonly durationMs: number;
  readonly cancelled: boolean;
  /**
   * How many times a limiter reduced its own concurrency during the scan.
   *
   * Reported because it is the visible sign of the load discipline working: a non-zero
   * count means the warehouse pushed back and the scan yielded, which is the behaviour
   * the budgets exist to produce.
   */
  readonly concurrencyReductions: number;
}

/**
 * What the scan consumed, measured rather than estimated.
 *
 * Byte and row counts come from the result manifests the warehouse returned. DBUs are
 * absent: the same work does not appear in the billing tables for up to a day, so it is
 * resolved separately against `statementIds` rather than guessed at here.
 */
export interface SpendPayload {
  readonly surface: string;
  readonly name: string;
  readonly calls: number;
  readonly bytesRead?: number;
  readonly rowsReturned?: number;
  readonly statementIds?: readonly string[];
}

export interface SignalPayload {
  readonly id: string;
  readonly status: 'observed' | 'unmeasurable';
  readonly coverage: CoveragePayload;
  readonly unmeasurableReason?: string;
  readonly durationMs: number;
  readonly provenance?: ProvenancePayload;
}

export interface WorkspaceRefPayload {
  readonly id: string;
  readonly name: string;
  readonly url?: string;
  readonly status: string;
  /** On excluded workspaces: why. `other-region` ones are running, so status cannot carry it. */
  readonly reason?: 'not-running' | 'other-region';
}

/**
 * Which workspaces the scan covered.
 *
 * Sent because the regional signals filter to running workspaces in one region, and a filtered count
 * is only trustworthy if the filter is visible. Without this, a user whose account holds 68 warehouse
 * records but 4 live ones sees a number they cannot reconcile.
 */
export interface EstatePayload {
  readonly workspacesInAccount?: number;
  readonly assessed: readonly WorkspaceRefPayload[];
  readonly excluded: readonly WorkspaceRefPayload[];
  /** How many of the assessed had no readable region, and so are covered on weaker grounds. */
  readonly regionUnverified?: number;
  /**
   * Assessable, and outside the scope the run was asked for. Absent on an unnarrowed scan.
   *
   * On the wire as workspaces rather than a count because two readers need the names: the account total
   * only reconciles against these, and the workspace picker is built from a stored estate.
   */
  readonly outOfScope?: readonly WorkspaceRefPayload[];
  /** The region the scan was scoped to, when it could be established. */
  readonly region?: string;
  readonly undeterminedReason?: string;
  /** The server's own sentence, so the client renders one phrasing rather than inventing a second. */
  readonly note?: string;
}

/**
 * Which run measured one pillar in a result, and when.
 *
 * On the wire because a targeted rerun's result is a composite: the pillar that was rerun is
 * minutes old and the rest are as old as the last full scan. A UI that could not tell them
 * apart would date every pillar by the scan's own timestamp and present week-old evidence as
 * current, which is the one failure a rerun feature must not have.
 */
export interface MeasurementPayload<TDate = string> {
  readonly pillarId: string;
  readonly scanId: string;
  readonly measuredAt: TDate;
  readonly actor: string;
  readonly carriedForward: boolean;
}

export interface ScanPayload<TDate = string> {
  readonly id: string;
  readonly startedAt: TDate;
  readonly finishedAt: TDate;
  readonly state: ScanState;
  readonly stamp: StampPayload;
  readonly incompleteReason?: string;
  /** The pillars this run was asked to measure. Absent means all the build assesses. */
  readonly requestedPillars?: readonly string[];
  readonly measurement: readonly MeasurementPayload<TDate>[];
  /** Why a targeted run's untouched pillars are absent rather than carried forward. */
  readonly notCarried?: string;
  readonly score: ScorePayload<TDate>;
  /**
   * What the assessment committed to, each held against this run's score for that pillar.
   *
   * Absent when nothing was committed, when the run answers to no assessment, and when the definition
   * could not be read — three states that all mean "no commitments to report" and none of which is a
   * reason to fail the page. Which version's targets these are is decided by fingerprint; see
   * `targetsFor` in `server/api/routes.ts`.
   */
  readonly targets?: readonly TargetReadingPayload<TDate>[];
  readonly findings: readonly FindingPayload<TDate>[];
  readonly footprint: FootprintPayload;
  readonly spend: readonly SpendPayload[];
  readonly signals: readonly SignalPayload[];
  readonly estate: EstatePayload;
  /**
   * Where this run stands with its review, for the surfaces that show its score beside it.
   *
   * Absent where this install keeps no reviews. See `FinalisationPayload`, which says why that is
   * not the same answer as a run nobody has reviewed.
   */
  readonly finalisation?: FinalisationPayload<TDate>;
}

/** What a run found, by outcome, so a history row shows a result and not only a score. */
export interface OutcomeCountsPayload {
  readonly pass: number;
  readonly fail: number;
  readonly partial: number;
  readonly unmeasurable: number;
  readonly notApplicable: number;
}

export interface ScanSummaryPayload<TDate = string> {
  readonly id: string;
  /** The immutable customer result produced from this raw run, where its review is complete. */
  readonly resultId?: string;
  readonly startedAt: TDate;
  readonly finishedAt: TDate;
  readonly state: ScanState;
  readonly overall?: number;
  /**
   * How far `overall` could still move. See `ScanSummary.range` on the server.
   *
   * The history list reads it for the same reason the overview does: the verdict word is withheld
   * where too little was measured. Absent on a summary recorded before this was kept, and the list
   * renders no word for those rather than one it cannot check against the run's own range.
   */
  readonly range?: ScoreRangePayload;
  readonly actor: string;
  /** See `StampPayload.actorName`. On the summary too, because the history table reads only this. */
  readonly actorName?: string;
  readonly executionMode: ExecutionMode;
  /** Absent on runs recorded before this was written, which is not the same as interactive. */
  readonly trigger?: ScanTriggerPayload;
  readonly catalogueVersion: string;
  /** Absent means the run was asked for every pillar the build assesses. */
  readonly requestedPillars?: readonly string[];
  readonly measuredPillars: readonly string[];
  /** The pillars this run measured itself, rather than carried forward from an earlier one. */
  readonly freshPillars: readonly string[];
  readonly counts: OutcomeCountsPayload;
  /** Each pillar's score in this run, so a trend needs the index alone rather than every scan. */
  readonly pillarScores: Readonly<Record<string, number>>;
  /**
   * The full comparison basis retained by the history index.
   *
   * Optional because records written before the stamp was added do not carry one. A client must
   * report that gap rather than infer comparability from the flattened display fields above.
   */
  readonly stamp?: StampPayload;
}

export interface ScanHistoryPayload<TDate = string> {
  readonly durable: boolean;
  /** Present while history is not durable, so the UI never implies a record it lacks. */
  readonly durabilityNote?: string;
  /**
   * Present when the store could not be read, which is not the same as having nothing to show.
   *
   * Separate from `durabilityNote` because they say opposite things about the records: one means
   * nothing is being kept, the other means something is being kept and could not be reached. A
   * page that showed the same sentence for both would tell an admin to fix a binding that is fine.
   */
  readonly unreadable?: string;
  readonly scans: readonly ScanSummaryPayload<TDate>[];
}

/** A control's outcome in a run, or its absence from one. */
export type PresencePayload = Outcome | 'absent';

export interface ControlChangePayload {
  readonly controlId: string;
  readonly title: string;
  readonly pillarId: string;
  readonly severity: Severity;
  readonly from: PresencePayload;
  readonly to: PresencePayload;
  /** The id this control had in the earlier run, when the catalogue has since renamed it. */
  readonly wasKnownAs?: string;
  /** What the catalogue changed about this control between the two runs, when it changed one. */
  readonly redefined?: readonly string[];
}

/**
 * How much of the score's movement is the estate, and how much is the catalogue.
 *
 * A number that moved because the catalogue added a control is not an estate that got worse, and
 * presenting the two as one figure invites a reader to congratulate or blame themselves for a
 * release note. `estate` is the movement on the controls both runs scored on unchanged terms;
 * `catalogue` is the remainder.
 */
export interface AttributionPayload {
  readonly estate: number;
  readonly catalogue: number;
  readonly stable: number;
  readonly added: number;
  readonly removed: number;
  readonly renamed: number;
  readonly reweighted: number;
}

/**
 * What a run changed against the run before it.
 *
 * `unobserved` is the field that keeps this honest: a pillar carried forward holds the earlier
 * run's findings verbatim, so an empty change list for it is the absence of a measurement rather
 * than a measurement of no change.
 */
export interface RunChangesPayload<TDate = string> {
  readonly comparable: boolean;
  readonly reason?: string;
  readonly caveat?: string;
  readonly previous?: { readonly id: string; readonly finishedAt: TDate; readonly overall?: number };
  readonly overallDelta?: number;
  readonly attribution?: AttributionPayload;
  readonly changes: readonly ControlChangePayload[];
  readonly unobserved: readonly string[];
}

/**
 * What is happening right now, for a reader who did not start it.
 *
 * A run takes minutes, and until this carried more than a boolean the only reader who knew one
 * was happening was the one whose click started it. A scheduled run, a second admin's run, and
 * the same reader's own run after a page reload were all indistinguishable from an idle app
 * showing the previous assessment as though it were current.
 *
 * `callsMade` is a count and deliberately not a fraction. How many calls a run makes is not known
 * when it starts — a permission refusal skips work, budget exhaustion stops it early, and a
 * targeted rerun measures a subset — so any denominator would be invented, and a progress bar
 * that reaches 90% and stays there is worse than a count that only ever rises. See ADR 0055.
 */
export interface ScanStatusPayload<TDate = string> {
  readonly running: boolean;
  readonly startedAt?: TDate;
  readonly actor?: string;
  readonly scope?: ScopePayload;
  /** What started it, so a reader can tell the nightly run from a colleague's. */
  readonly trigger?: ScanTriggerPayload;
  /** Calls that have reached a surface so far, with no total: see the note above. */
  readonly callsMade?: number;
  /**
   * The record behind what is running, where this install keeps one.
   *
   * So a page watching a scan has the name of the thing that outlives it: when the process goes away
   * mid-run this endpoint says nothing is running, and the only way to find out what became of the work
   * is to have kept the run's id while it was still being reported.
   */
  readonly run?: string;
}

/**
 * Whether a scan started here would run, without starting one.
 *
 * Read by the scheduled job before it triggers, so that a refusal no retry can clear costs one
 * serverless start rather than four. Every field is something the trigger would otherwise discover by
 * failing: who the caller is, whether the gate would let them start a scan, whether there is a
 * warehouse to read the estate with, and whether an interrupted run could be resumed.
 *
 * `may.start` is false with the gate's own sentence rather than a code the job would have to phrase
 * for itself. The person reading the failed task is the person who has to fix the grant, and the
 * sentence that tells them how already exists.
 */
export interface ReadinessPayload {
  readonly actor: string;
  /** The group whose members may change an assessment, named so a refusal says what to join. */
  readonly group: string;
  readonly may:
    | { readonly start: true }
    | {
        readonly start: false;
        /** Turned away, or unable to establish membership at all — a fault rather than a refusal. */
        readonly refusal: 'not-a-member' | 'membership-unknown';
        readonly message: string;
      };
  /** Whether a warehouse is bound. False means a scan would start and read nothing. */
  readonly warehouse: boolean;
  /**
   * Whether runs are recorded here.
   *
   * False does not stop a scan; it stops a *resumed* one. Worth reporting rather than refusing,
   * because an install with nothing durable bound is a working install whose scheduled run cannot
   * survive the app being replaced — which an operator should hear before the week it happens.
   */
  readonly runs: boolean;
}

/**
 * A run of the assessment, as the record holds it.
 *
 * Separate from `ScanStatusPayload`, which reports what is happening in *this process* right now and
 * goes back to `{ running: false }` when the process restarts. This is read from the database, so it
 * answers the question a supervisor actually has — "what became of the run I asked for" — across a
 * restart, a retry and a cancel.
 */
export interface RunPayload<TDate = string> {
  readonly id: string;
  readonly state: 'running' | 'complete' | 'partial' | 'cancelled' | 'failed';
  readonly requestedAt: TDate;
  readonly actor: string;
  readonly trigger: ScanTriggerPayload;
  /** How many times something has taken hold of this run. Above one means a retry happened. */
  readonly attempts: number;
  /** Whether a process is working on it now, and until when its claim lasts. */
  readonly heldUntil?: TDate;
  readonly cancelRequestedAt?: TDate;
  /**
   * What this run is for.
   *
   * Named on every run rather than implied by which pointer is set, because a run that is still going
   * has neither — and "what is running" is the question this payload exists to answer.
   */
  readonly kind: RunKindPayload;
  /** What an assessment run produced. Never set together with `advisoryId`. */
  readonly scanId?: string;
  /** What an advisory run produced. */
  readonly advisoryId?: string;
  readonly finishedAt?: TDate;
  readonly why?: string;
  /** What was asked for, so a reader can tell two runs apart without reading their scans. */
  readonly lookbackDays: number;
  readonly pillars?: readonly string[];
}

/**
 * The runs this install has a record of.
 *
 * `durable` rather than reading the emptiness of the list, because an install that records nothing and
 * one that has recorded nothing yet both answer with no runs and mean opposite things: the first will
 * never have any, and saying so is the only useful thing the route can offer.
 */
export interface RunsPayload<TDate = string> {
  readonly durable: boolean;
  readonly runs: readonly RunPayload<TDate>[];
  /** Present only where nothing is recorded, and says what to do about it. */
  readonly unavailable?: string;
}

/**
 * Why a trigger could not join the run its key names.
 *
 * Four values rather than one error, because a supervisor's next move differs for each: `terminal`
 * means read the answer, `held` means wait, and the other two mean the key was reused for something
 * it does not describe and no amount of retrying will help.
 */
export type RunRefusalPayload = 'terminal' | 'held' | 'other-actor' | 'other-request' | 'other-kind';

/** What a run is for. Two kinds share one record and one key space — ADR 0069. */
export type RunKindPayload = 'assessment' | 'advisory';

/** What a caller is told when a run it triggered was already under way. */
export interface RunRefusedPayload<TDate = string> {
  readonly error: 'run-not-joinable';
  readonly refusal: RunRefusalPayload;
  readonly message: string;
  readonly run: RunPayload<TDate>;
  /**
   * What the run found, where it is `terminal` and produced a scan.
   *
   * Here so that a supervisor whose answer went missing can be told what it missed rather than only
   * that it missed it. The case is ordinary rather than exotic: a job task posts, the app completes the
   * assessment, the connection drops before the reply arrives, and the task's retry posts the same key.
   * Without this, the retry learns the run finished and nothing about whether the result was worth
   * keeping — so a run that came back blind would be reported as a success by the second attempt, which
   * is the one outcome the blind check exists to prevent.
   */
  readonly summary?: ScheduledScanSummary;
}

/**
 * What an unattended run answers with: a summary small enough to sit in a task log.
 *
 * Deliberately not the whole scan. The reader is a job, and what a job can act on is a handful of
 * numbers and an id it can follow later. The scan itself is on the store either way.
 */
export interface ScheduledScanSummary {
  readonly scan: string;
  /** The run the scan came out of, where this install records runs. Absent where it records none. */
  readonly run?: string;
  readonly trigger: ScanTriggerPayload;
  readonly ranAs: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly state: ScanState;
  readonly score: number | undefined;
  readonly confidence: { readonly low: number; readonly high: number } | undefined;
  readonly measured: number;
  readonly requirements: number;
  /**
   * Set where the run read less of the estate than it failed to read, and is therefore not an
   * assessment of it.
   *
   * A flag rather than a rule the reader applies, because there is exactly one reader — the scheduled
   * job — and a rule it re-derived from `measured` and `requirements` would be a second copy of a
   * judgement this app makes. The two would agree until one of them changed.
   */
  readonly blind?: true;
}

/**
 * Whether a job could move to serverless compute.
 *
 * `unknown` is not a fourth degree of readiness, it is the absence of a verdict: the
 * configuration could not be read, so nothing is claimed. Kept distinct from `ready` for the
 * obvious reason — an unreadable cluster is not a clean one — and from `rework` because
 * there is nothing specific to do about it.
 */
export type ServerlessVerdict = 'ready' | 'rework' | 'blocked' | 'unknown';

/** What a rule says a finding means, from `config/analyze/serverless-rules.yaml`. */
export type ServerlessRuleKind = 'blocker' | 'rework' | 'unknown' | 'note';

/**
 * One thing found about a job, and what it means.
 *
 * `observed` is about this estate; the rest is the rule. Separated so a reader can see that
 * the sentence about serverless is a general claim with a citation, and the sentence about
 * their job is a measurement — rather than one paragraph in which the two are indistinguishable.
 */
export interface ServerlessReasonPayload {
  readonly ruleId: string;
  readonly kind: ServerlessRuleKind;
  /** Absent on advisory records written before authored actions shipped. */
  readonly action?: string;
  readonly headline: string;
  readonly detail: string;
  readonly docUrl: string;
  readonly observed: string;
  /**
   * The same measurement as numbers, where what the rule fired on is a quantity.
   *
   * `observed` is a sentence, and two sentences cannot be subtracted: an action raised from a reason
   * carrying only prose can hold an estimate and can never report a realised value. Absent where the
   * condition is not a quantity — a continuous trigger, a runtime version — and absent on an advisory
   * written before `44b` added it.
   */
  readonly evidence?: readonly WorkloadEvidencePayload[];
}

export interface CostRangePayload {
  readonly low: number;
  readonly high: number;
  readonly currency: string;
  /**
   * The price list's own name for the region the serverless rate was read at — `AP_SYDNEY`
   * rather than `ap-southeast-2`. Shown so the rate can be checked against a published
   * price. Absent on an estate total spanning more than one region.
   */
  readonly region?: string;
}

/** An assumption the cost range rests on, shown with it rather than in a footnote. */
export interface CostAssumptionPayload {
  readonly id: string;
  readonly statement: string;
  readonly docUrl?: string;
}

export interface ServerlessJobPayload<TDate = string> {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly name: string;
  readonly verdict: ServerlessVerdict;
  readonly runs: number;
  readonly classicClusters: number;
  readonly reasons: readonly ServerlessReasonPayload[];
  readonly clusters: readonly string[];
  readonly workspace?: string;
  readonly link?: string;
  readonly lastRun?: TDate;
  /** What its classic compute cost over the window, in Databricks DBUs alone. */
  readonly cost?: number;
  readonly currency?: string;
  readonly estimate?: CostRangePayload;
  /** Why there is no estimate, where there is spend but no rate to price it against. */
  readonly noEstimate?: string;
  readonly startupShare?: number;
}

/**
 * Per-job serverless readiness, standing behind the four requirements that score the
 * estate's serverless share.
 *
 * Served from its own endpoint rather than inside the scan payload: the overview fetches a
 * scan on every page load, and forty jobs with their reasons would be carried into every one
 * of those for a page most readers never open.
 */
export interface ServerlessReadinessPayload<TDate = string> {
  readonly lookbackDays: number;
  readonly jobsRan: number;
  readonly alreadyServerless: number;
  readonly onWarehouse: number;
  readonly jobs: readonly ServerlessJobPayload<TDate>[];
  readonly counts: Readonly<Record<ServerlessVerdict, number>>;
  readonly cost?: number;
  readonly currency?: string;
  readonly estimate?: CostRangePayload & { readonly jobs: number };
  readonly assumptions: readonly CostAssumptionPayload[];
  /** The standing caveat: this reads compute configuration, not the code that ran on it. */
  readonly caveat: ServerlessReasonPayload;
  readonly truncated?: { readonly listed: number; readonly found: number };
  /** Set when this came from an earlier run because a targeted rerun did not reproduce it. */
  readonly carriedFrom?: { readonly scanId: string; readonly measuredAt: TDate };
  /** Set when a signal it needed could not be read, with the reason the collector gave. */
  readonly unmeasured?: string;
  /** The requirements this analysis elaborates, so the UI can link back to their findings. */
  readonly explains: readonly string[];
}

/**
 * What one run of the workload advisor concluded.
 *
 * Its own payload rather than a scan's, because the two are separate records with separate periods —
 * ADR 0061 — and a page that read advice out of a scan would be a page that goes stale on the
 * assessment's cadence rather than on its own.
 */
export interface AdvisoryPayload<TDate = string> {
  readonly id: string;
  /** The run that produced it, so a reader can see how many attempts it took. */
  readonly runId: string;
  readonly finishedAt: TDate;
  readonly state: 'complete' | 'partial';
  /** Named when the run stopped short, so advice formed from part of the window says so. */
  readonly incompleteReason?: string;
  readonly scope: string;
  readonly lookbackDays: number;
  readonly actor: string;
  /**
   * Whether anything at all was readable.
   *
   * False means the app could not see the estate, which is a different answer from an estate with
   * nothing to optimise — and the two are indistinguishable from an empty analysis. Telling a customer
   * they have no work to do when the truth is that a grant is missing is the worse wrong answer.
   */
  readonly sighted: boolean;
  readonly serverless?: ServerlessReadinessPayload<TDate>;
  readonly workload?: WorkloadPayload<TDate>;
  readonly sizing?: SizingPayload;
  readonly jobs?: JobsPayload<TDate>;
  readonly writes?: WritePayload<TDate>;
  /**
   * Whether this run could read query plans as well as an earlier one could.
   *
   * Structured rather than a sentence, following the rule the payloads above keep for numbers: what to say
   * about `lost-reach` is a surface's decision and it is a harder sentence than it looks — the counts here
   * are about this run and the baseline id is about another, and no field joins them to a cause.
   */
  readonly planCapability?: PlanCapabilityPayload;
}

/**
 * Absent covers two cases this payload cannot tell apart, and a surface must not read it as either alone.
 *
 * It is absent when reach held up against an earlier run, and equally when there was no earlier run to
 * compare against — a first run, a history with no run that had reach in it, or a history that could not be
 * read. So absence does not license "reach unchanged": that sentence would be false on a first run.
 * Distinguishing them means widening this payload, which no surface has needed yet.
 *
 * There is no proportional variant here on purpose: a "reach dropped by a fifth" alert needs a measured
 * distribution of normal run-to-run variation, and there is none. See `server/advise/plan-capability.ts`.
 */
export type PlanCapabilityPayload =
  /** The fetch stopped part-way because the endpoint kept failing, so some shapes were never asked about. */
  | { readonly kind: 'gave-up'; readonly failed: number; readonly abandoned: number }
  /** An earlier run read plans and this one read none. The id is that run's. */
  | { readonly kind: 'lost-reach'; readonly baselineAdvisoryId: string; readonly baselineAvailable: number }
  /**
   * The warehouse list was not read, so this run cannot say anything about reach in either direction.
   *
   * Not read, not refused: since `41c` the list goes through the scheduler, so this is a refusal, a
   * cancellation, or a spent budget, and nothing here says which. A surface rendering this may not name
   * the cause — `warehousesKnown` is one boolean over three, and widening it is what a sentence about
   * permissions would need first.
   */
  | { readonly kind: 'cannot-tell' };

/**
 * One measured number behind a workload finding.
 *
 * The raw value and what it is, never a formatted string. Formatting is the surface's decision, and a
 * payload that pre-rendered "500 MB" would leave a client unable to compare two findings the server had
 * rendered at different scales — or to change how bytes read without a server release.
 *
 * Named for the advisor rather than sharing `EvidencePayload`, which is an assessment finding's evidence:
 * a control's evidence is a sentence and a source, and this is a number and a unit. One name over both
 * would be a type that means two things.
 */
export interface WorkloadEvidencePayload {
  readonly label: string;
  readonly value: number;
  /**
   * `ratio` and `multiple` are both a number over a number, and they are two units because the surface
   * renders them differently and only one of the two renderings is right for either.
   *
   * A `ratio` is a share — spilled against read, queued against elapsed — and reads as a percentage. A
   * `multiple` is a factor: the largest partition against the median one is `19`, the design document
   * writes that condition as `max/median >= 10`, and rendered as a share the same number reads "1,900%".
   * Both are arithmetically true and one of them is what a reader means by skew.
   */
  readonly unit: 'bytes' | 'ms' | 'percent' | 'ratio' | 'multiple' | 'count';
}

/** One rule that fired on one shape, with the numbers behind it and the words that explain it. */
export interface WorkloadFindingPayload {
  readonly rule: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'info';
  /**
   * How much the advisor is claiming, which is not decoration.
   *
   * A queue is a queue: `high`. A mean file size is a fact and "therefore compact the table" is an
   * inference a deliberately fine partitioning would make wrong: `moderate`. Presenting both at the same
   * confidence teaches a reader to discount the first, which is the one they should act on.
   */
  readonly confidence: 'high' | 'moderate' | 'low';
  readonly action: string;
  readonly headline: string;
  readonly detail: string;
  readonly docUrl: string;
  /** Why the rule exists where no design document names it. Present on the two extensions. */
  readonly rationale?: string;
  /** Never empty: every finding carries numeric evidence or says evidence was unavailable. */
  readonly evidence: readonly WorkloadEvidencePayload[];
}

/** How a shape's cost is moving, over a fortnight at most. */
export interface WorkloadTrendPayload {
  readonly kind: 'regression' | 'chronic' | 'volatile' | 'improving' | 'new' | 'unmeasured';
  readonly ratio?: number;
  readonly meanMsNow?: number;
  readonly meanMsBefore?: number;
  readonly runsNow: number;
  readonly runsBefore: number;
}

/** One query shape as a reader sees it. */
export interface WorkloadShapePayload<TDate = string> {
  /** Sixteen hex characters of a hash over the normalised text. Short because it is shown. */
  readonly shape: string;
  readonly workspaceId: string;
  readonly statementType: string;
  /** The composite score. Comparable within a run and not across runs — see the note on `windowDays`. */
  readonly score: number;
  readonly trend: WorkloadTrendPayload;
  readonly findings: readonly WorkloadFindingPayload[];
  /**
   * The head of the representative execution's text.
   *
   * Shown as it is, not redacted. The app runs inside the customer's own environment against their own
   * workspace, and the reader already has access to the query history it came from — so redacting it back
   * from them costs the surface its usefulness for no gain. Absent where the platform recorded none.
   */
  readonly statementText?: string;
  /** The execution the text and any later plan belong to. */
  readonly statementId?: string;
  readonly representativeAt?: TDate;
  /**
   * Whether the execution the text came from produced timings.
   *
   * A shape every one of whose runs failed represents itself with its longest failure, because the list
   * of failing shapes is made of exactly those and showing them with no query at all was worse. False
   * here means the text is from a run that measured nothing, and `representativeStatus` says which kind:
   * a cancelled or failed run, or one served from the result cache.
   */
  readonly representativeMeasured: boolean;
  /** What that execution did — `FINISHED`, `FAILED` or `CANCELED`. Absent where none was recorded. */
  readonly representativeStatus?: string;
  readonly runs: number;
  /** Runs the timings are over: finished, and not served from cache. Never the same as `runs`. */
  readonly measuredRuns: number;
  readonly totalMs: number;
  readonly meanMs?: number;
  readonly medianMs?: number;
  readonly worstMs?: number;
  readonly readBytes: number;
  readonly spilledBytes: number;
  readonly shuffleBytes: number;
  readonly readFiles: number;
  readonly prunedPercent?: number;
  readonly parallelism?: number;
  readonly compilationPercent?: number;
  readonly queueMs: number;
  readonly cacheHits: number;
  readonly failures: number;
  /** Where it ran, so a reader can find it. */
  readonly warehouses: number;
  readonly jobs: number;
  readonly pipelines: number;
}

/**
 * How much of the estate's query time the analysis is about.
 *
 * Part of the payload rather than a sentence on the page. `REFRESH` is excluded because a materialised
 * view is a managed service with no knob to turn, and on the estate this was calibrated against that
 * removes 62.9% of query time — so a list headed "your costliest queries" would be describing about a
 * third of the workspace. A reader who is not told assumes the list is the estate, and catches the app out
 * the first time they compare it to a bill.
 */
export interface WorkloadCoveragePayload {
  readonly coveredMs: number;
  readonly excludedMs: number;
  /**
   * What the assessment's own queries cost, which is excluded and is the tool's rather than the estate's.
   *
   * Separate from `excludedMs` and disclosed on the page. The advisor reads the query history it is also
   * writing to, and on the first workspace it ran against 51.8% of query time was its own — eight of the
   * top twelve shapes, before the exclusion existed. That figure belongs in front of the reader rather
   * than folded into a general exclusion: it is what the assessment costs to run.
   */
  readonly selfMs: number;
  readonly coveredRuns: number;
  readonly excludedRuns: number;
  readonly selfRuns: number;
  /**
   * Covered work that no shape in the list describes, because its shape was not one shape.
   *
   * Some submission paths record the calling expression rather than the SQL it built, so a million
   * statements of eleven different kinds normalise to one string. The statement declines to describe
   * those and returns what declining cost: a subset of `coveredMs` and `coveredRuns`, not a fourth
   * slice of the window. `ambiguousShapes` is how many groups were dropped.
   */
  readonly ambiguousMs: number;
  readonly ambiguousRuns: number;
  readonly ambiguousShapes: number;
  /**
   * A percentage, 0 to 100, to one decimal — not a ratio.
   *
   * Covered less ambiguous, over the window's whole query time: the share that grouped into a shape this
   * advisor can describe, rather than the share of a kind it could in principle advise on. Not the share
   * the rows of any one page account for — the statement returns at most `:shape_limit` shapes out of
   * however many the estate has. Absent where the window ran nothing: complete coverage of nothing is
   * true and misleading. The units are said out loud
   * because the first page to read this field treated 93.8 as a ratio and rendered 9,380%, which no test
   * caught and one real run did.
   */
  readonly percent?: number;
}

/** What the workload advisor concluded about the estate's queries. */
export interface WorkloadPayload<TDate = string> {
  readonly top: readonly WorkloadShapePayload<TDate>[];
  /** Failing shapes, worst rate first, whatever they scored. A failure is not a performance finding. */
  readonly failing: readonly WorkloadShapePayload<TDate>[];
  readonly coverage: WorkloadCoveragePayload;
  readonly considered: number;
  readonly findingCount: number;
  /**
   * Which coefficient set and ruleset produced this.
   *
   * Carried so two runs can be told apart rather than compared. The features are capped at their 99th
   * percentile within the window, so a score is comparable between two shapes in one run and not between
   * the same shape in two runs — and a page that trended them would be reporting the tuning as a change in
   * the estate.
   */
  readonly rankingVersion: string;
  readonly rulesVersion: number;
  /** Days per half of the comparison. Fifteen is the ceiling; a quarterly trend is not available. */
  readonly windowDays: number;
}

/**
 * Why a warehouse reads the way it does.
 *
 * Five states rather than an empty finding list, because "no findings" is four different sentences. A
 * warehouse that coped was asked for work and handled it; one that was not asked has nothing to size
 * against; `assessment-only` was asked for nothing but this assessment, which is a separate row because
 * acting on it means deleting the warehouse the assessment runs on; and `unmeasured` ran statements none
 * of which were timed, so no rule had anything to read. A reader is told which rather than left to infer
 * it from silence.
 *
 * Every figure beside these excludes the assessment's own statements, so none of the five is a state
 * about us. `assessment-only` is the one that mentions us and it does so to keep `unused` honest.
 */
export type WarehouseStatePayload = 'advised' | 'clean' | 'unused' | 'assessment-only' | 'unmeasured';

/** One rule that fired on one warehouse. The same shape as a query finding, and a separate id space. */
export interface SizingFindingPayload {
  readonly rule: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'info';
  readonly confidence: 'high' | 'moderate' | 'low';
  readonly action: string;
  readonly headline: string;
  readonly detail: string;
  readonly docUrl: string;
  /** Why the rule exists where no design document names it. All five of these are extensions. */
  readonly rationale?: string;
  readonly evidence: readonly WorkloadEvidencePayload[];
}

/** One warehouse: what it is, what it was asked to do, and what to change about it. */
export interface WarehouseSizingPayload {
  readonly workspaceId: string;
  readonly warehouseId: string;
  /** The id itself where the warehouse was deleted after it ran and no definition could be matched. */
  readonly name: string;
  readonly link?: string;
  readonly serverless?: boolean;
  readonly size?: string;
  /** The size one step below, where there is one, so a surface can name it rather than imply it. */
  readonly nextSizeDown?: string;
  readonly minClusters?: number;
  readonly maxClusters?: number;
  readonly autoStopMinutes?: number;
  readonly state: WarehouseStatePayload;
  readonly findings: readonly SizingFindingPayload[];
  readonly runs: number;
  readonly measuredRuns: number;
  readonly totalMs: number;
  readonly busyMs: number;
  readonly queueMs: number;
  readonly spilledBytes: number;
  readonly peakUsers: number;
  readonly daysUsed: number;
  readonly daysQueued: number;
  readonly daysSpilled: number;
  readonly p95Ms?: number;
  readonly worstMs?: number;
  /** Wall-clock time with at least one cluster running, from the warehouse event stream. */
  readonly upMs: number;
  /**
   * The same weighted by the clusters running, which is what the account was billed for.
   *
   * On the page because it is the denominator `executionPercent` is over, and leaving it off invited the
   * reader to divide the execution time by the wall clock instead. On a warehouse that reached two clusters
   * those are different numbers, so the arithmetic a reader could check disagreed with the one the rules
   * fire on. Equal to `upMs` on a single-cluster warehouse.
   */
  readonly clusterMs: number;
  readonly starts: number;
  readonly peakClusters: number;
  /**
   * Whether the window opened with this warehouse already running.
   *
   * True where the last event before the window left a cluster up, so `upMs` counts from the window's
   * first instant rather than from anything the window recorded. It says nothing about how much of the
   * uptime that accounts for — only that the session had already begun. Carried to a surface because
   * `daysSeen` used to be the tell and is not: a warehouse up throughout the window and never resized has
   * no event in it at all, and reads identically to one that ran for six days and stopped.
   */
  readonly carriedIn: boolean;
  /**
   * Statement execution per cluster-millisecond of uptime, as a percentage.
   *
   * Over 100 on a genuinely concurrent warehouse, because statements execute at once and their durations
   * sum past the wall clock. Not a CPU figure: nothing in the tables behind this measures how busy a
   * cluster's cores were, only how much statement execution came out of the time that was paid for.
   */
  readonly executionPercent?: number;
  readonly queuePercent?: number;
}

/** What the advisor concluded about the size and shape of the estate's warehouses. */
export interface SizingPayload {
  /** Busiest first, with anything that has a finding lifted above the warehouses that do not. */
  readonly warehouses: readonly WarehouseSizingPayload[];
  readonly findingCount: number;
  /** Warehouses that ran at least one statement in the window. */
  readonly used: number;
  /** Warehouses the window saw, which is what the statement's row cap applies to. */
  readonly population: number;
  /** Live warehouses the inventory lists, where it was read. Absent rather than zero if it was not. */
  readonly live?: number;
  /**
   * How many of the listed warehouses were found in that inventory.
   *
   * `live` minus this is how many of the estate's warehouses the window saw nothing of at all. Subtracting
   * `population` instead undercounts, because the event stream is read across the metastore and the
   * inventory only covers the workspaces the run had reach into.
   */
  readonly matched: number;
  /** Seven. A sizing decision is made from a pattern, and the day counts are only readable at one width. */
  readonly windowDays: number;
  readonly rulesVersion: number;
}

/**
 * Why a write shape reads the way it does, and why `undeterminable` is not a quieter `clean`.
 *
 * Both rules read a byte figure, and `written_bytes` is null on a run the platform recorded none for. So a
 * shape whose runs stated nothing is one this run could not judge rather than one with nothing wrong, and
 * the difference is on the payload because a surface has to say which. Measured on the estate that writes,
 * 10,470 of 10,472 statements carried a figure; on one whose history predates the column, every shape is
 * this and the page would otherwise report an estate that writes flawlessly.
 */
export type WriteStatePayload = 'advised' | 'clean' | 'undeterminable';

/** One rule that fired on one write shape. The same shape as a query finding, and a separate id space. */
export interface WriteFindingPayload {
  readonly rule: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'info';
  readonly confidence: 'high' | 'moderate' | 'low';
  readonly action: string;
  readonly headline: string;
  readonly detail: string;
  readonly docUrl: string;
  /** Why the rule exists where no design document names it. Both of these are extensions. */
  readonly rationale?: string;
  readonly evidence: readonly WorkloadEvidencePayload[];
}

/** One write shape: what kind of write it was, how much it moved, and what to look at. */
export interface WriteShapePayload<TDate = string> {
  readonly workspaceId: string;
  /** Sixteen hex characters over the normalised text, the same fingerprint the query shapes carry. */
  readonly shape: string;
  /** One of `INSERT`, `MERGE`, `UPDATE`, `DELETE`, `COPY`, `REPLACE`. Never several. */
  readonly statementType: string;
  readonly state: WriteStatePayload;
  readonly findings: readonly WriteFindingPayload[];
  readonly runs: number;
  readonly finishedRuns: number;
  readonly daysRun: number;
  /**
   * Of `runs`, how many carried a written figure — the denominator of every byte field below.
   *
   * On the payload rather than folded into the sums, because the difference between "wrote nothing" and
   * "wrote an amount nobody recorded" is the whole of `undeterminable`, and a reader looking at a shape
   * with findings is entitled to know the figures are over part of its runs where they are.
   */
  readonly runsStatingBytes: number;
  readonly writtenBytes: number;
  readonly largestWriteBytes?: number;
  /** The middle write, which is what both rules read. Absent where no run stated a figure. */
  readonly medianWriteBytes?: number;
  readonly readBytes: number;
  readonly producedRows: number;
  readonly totalMs: number;
  readonly firstSeen?: TDate;
  readonly lastSeen?: TDate;
  /** The largest write of the group, as it was recorded, so a reader has a statement rather than a hash. */
  readonly statementText?: string;
  readonly representativeAt?: TDate;
}

/** What the advisor concluded about how the estate writes. */
export interface WritePayload<TDate = string> {
  /** Largest writer first, with anything that has a finding lifted above the shapes that do not. */
  readonly shapes: readonly WriteShapePayload<TDate>[];
  readonly findingCount: number;
  /** Shapes whose runs stated no written figure, so neither rule could read one. */
  readonly undeterminable: number;
  /** The estate's own write statements in the window, which the listed shapes are a part of. */
  readonly writeStatements: number;
  /** Of those, how many carried a written figure. */
  readonly writesStatingBytes: number;
  readonly estateWrittenBytes: number;
  /** Every other statement the window saw, so a surface can say how much of the estate's SQL writes. */
  readonly otherStatements: number;
  /** Thirty, capped where the statement caps it. */
  readonly windowDays: number;
  readonly rulesVersion: number;
}

/**
 * Why a job reads the way it does, and why `ineligible` is not a quieter `clean`.
 *
 * Every job rule requires three runs in the window, which is the audit document's own first condition. A
 * job below that was not assessed, and reporting it as a job with nothing wrong is a claim about evidence
 * that does not exist — on the estate this was measured against, four of seven jobs are this. So the state
 * is on the payload and a surface has to say which of the three it is rather than showing an empty list
 * three times.
 */
export type JobStatePayload = 'advised' | 'clean' | 'ineligible';

/** One rule that fired on one job. The same shape as a query or warehouse finding, and its own id space. */
export interface JobFindingPayload {
  readonly rule: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'info';
  readonly confidence: 'high' | 'moderate' | 'low';
  readonly action: string;
  readonly headline: string;
  readonly detail: string;
  readonly docUrl: string;
  /** Why the rule exists where the audit document does not name it. One of the four is an extension. */
  readonly rationale?: string;
  readonly evidence: readonly WorkloadEvidencePayload[];
}

/**
 * One job: how its runs went, what they came to, and what fired on them.
 *
 * Three things this payload deliberately does not carry, each because the platform does not record it at
 * this grain and a field would invite a sentence about it:
 *
 *   No setup or execution split. `system.lakeflow.job_run_timeline` has three duration columns and all
 *   three were written as zero on every run measured, so a field carrying them would report a job that
 *   starts instantly.
 *
 *   No retry count. `runsWithARepeatedTask` and `repeatedTaskRuns` are what a repeated `task_key` inside
 *   one run comes to; nothing distinguishes an automatic retry from a person repairing the run.
 *
 *   No Photon. It rides on the cluster configuration record and nothing has read it — that is rule E and
 *   ledger row `51` — so a surface may not say a job would benefit from it or is already using it.
 *
 * What it does carry, since `33ce`, is `compute`: what the workers of the job's classic clusters were
 * doing. It is absent on most jobs and on every job of an all-serverless estate, and **absent is not
 * zero** — see the field.
 */
export interface JobHealthPayload<TDate = string> {
  readonly workspaceId: string;
  readonly jobId: string;
  /** The id itself where the job was deleted after it ran and no definition could be matched. */
  readonly name: string;
  readonly link?: string;
  /**
   * Whether the definition carries a quartz schedule, and whether that is answerable at all.
   *
   * The three travel together because `scheduled: false` alone is undecidable: it is a job nobody gave a
   * trigger, a definition written before the column existed, and a job with several triggers whose set
   * lives in an array this app does not project. `triggerRecorded` is false for the middle case and a
   * surface renders nothing there; `multipleTriggers` marks the third, where the flag names no mechanism.
   * Reading the flag alone once dropped every manually-started job out of OE-02-04's denominator, and the
   * first version of the jobs page rebuilt the same claim in prose.
   */
  readonly scheduled?: boolean;
  readonly triggerRecorded?: boolean;
  readonly multipleTriggers?: boolean;
  readonly paused?: boolean;
  readonly timeoutSeconds?: number;
  readonly state: JobStatePayload;
  readonly findings: readonly JobFindingPayload[];
  /** Runs of this job the task timeline saw in the window. The denominator every share here is over. */
  readonly runs: number;
  /**
   * Wall clock per run, in milliseconds, from the timeline's period endpoints.
   *
   * Derived rather than read: `run_duration_seconds` was written as zero on every run measured. The
   * statement computes seconds and the payload scales them, so these are exact rather than estimates.
   */
  readonly totalMs: number;
  readonly meanMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  /** Task time summed across the job's runs, and the most tasks any one run had. */
  readonly taskMs: number;
  readonly tasksMost: number;
  readonly longestTaskMs: number;
  readonly busiestTaskKey?: string;
  readonly busiestTaskMs?: number;
  readonly runsWithARepeatedTask: number;
  readonly repeatedTaskRuns: number;
  readonly lastRun?: TDate;
  /**
   * Runs the run timeline wrote a terminal period for, and how those divide.
   *
   * `runsWithATerminalPeriod` counts periods, not outcomes: the three counts below divide it and one of
   * the three is the unknown. So a success rate over it is only a success rate where `runsUnresolved` is
   * zero. It can also sit below `runs`, because the two come from different timelines and a run the task
   * timeline saw may have no run-level row yet. Absent where the run timeline had no row for this job at
   * all, which is not zero failures.
   */
  readonly runsWithATerminalPeriod?: number;
  readonly runsSucceeded?: number;
  readonly runsDidNotSucceed?: number;
  readonly runsUnresolved?: number;
  /**
   * What the job billed, summed over every usage record naming it including the negative ones.
   *
   * Absent where no usage record named it, which is not a job that cost nothing. `usageRetractions` is how
   * a reader tells a settled figure from one still being corrected. No rule divides this by anything: cost
   * per successful run is the failure rate with a currency symbol on it.
   *
   * It is a quantity and not money, and `usageSkus` is why a surface has to say so: the sum runs across
   * every SKU the job billed, and a DBU of one SKU is not a DBU of another. Two jobs' figures are only
   * comparable where both bill one SKU and it is the same one, which this payload cannot say.
   */
  readonly usageQuantity?: number;
  readonly usageRecords?: number;
  readonly usageRetractions?: number;
  readonly usageSkus?: number;
  /**
   * How much of the job's non-serverless usage billing records as running without Photon.
   *
   * On the billing record rather than on the cluster configuration, and that is the whole of what makes
   * the rule readable: `system.compute.clusters` carries no Photon column, and the runtime version spells
   * it as a positive-only signal — naming Photon means on, not naming it means every other runtime.
   *
   * Three counts and not one share, because `stated` minus `off` is not `on`. A record that states nothing
   * is unread; `classicUsageRecords` above `classicRecordsStatingPhoton` is how much of the job's classic
   * usage this cannot speak about. All three absent on a reading taken before these columns existed, and
   * all three zero on a job with no classic usage — which is a serverless job, not a job with Photon on.
   */
  readonly classicUsageRecords?: number;
  readonly classicRecordsStatingPhoton?: number;
  readonly classicRecordsWithPhotonOff?: number;
  /** What the job's classic-cluster workers were doing, where the node join reached them. */
  readonly compute?: JobComputePayload<TDate>;
}

/**
 * The utilisation half of a job, from `system.compute.node_timeline` over each run's own window.
 *
 * Present on 689 of 4,158 jobs on the estate this was measured against and on none of an all-serverless
 * one. **A surface may render these figures where the field is here, and may render nothing where it is
 * not** — not a zero, not a dash with a tooltip about efficiency. The four rules that read it did not
 * assess the job, and `JobsPayload.computeRead` is the estate-level version of the same distinction.
 *
 * Every figure is a mean over the run-and-cluster pairs the join matched, with the driver excluded because
 * a driver idles by design. So `runClusterPairs` is the population, not `JobHealthPayload.runs`: a share
 * taken over the second with a numerator from the first is the division this payload is shaped to prevent.
 */
export interface JobComputePayload<TDate = string> {
  readonly runClusterPairs: number;
  readonly runsWithWorkerSamples: number;
  readonly clusters: number;
  /**
   * Pairs averaged over fewer than three one-minute samples, which the rules will not read a mean from.
   *
   * 48.2% of pairs on the estate measured. Here rather than filtered away so a surface can say how much of
   * a job's compute went unread, which is the same disclosure `ineligible` makes at the job level.
   */
  readonly pairsBelowThreeSamples: number;
  readonly avgCpuPercent: number;
  readonly peakCpuPercent: number;
  readonly avgCpuWaitPercent: number;
  readonly avgMemoryPercent: number;
  readonly peakMemoryPercent: number;
  /**
   * Average swap, which has a nonzero baseline and may not be rendered as "swapping".
   *
   * Non-zero on 95% of node-minutes at a median of 0.05%, so a surface showing a warning where this is
   * above zero would warn about almost every job. The rule that reads it uses a threshold well above that.
   */
  readonly avgSwapPercent: number;
  /**
   * Network traffic per minute of worker time, and the estate's own median beside it.
   *
   * **A rate and not a ratio, and a surface may not render it as I/O-bound.** The two conditions that
   * would compare it with data processed need a denominator `system.query.history` carries for no classic
   * job cluster — 0 rows of 4,106,493 in the window measured — so nothing here supports the comparison
   * those words imply. What the figure supports is a magnitude relative to the workspace: the population
   * measured spans five orders of magnitude around a median of 3.0 MiB per node-minute.
   *
   * Both absent where no pair ran long enough to have a rate. The median is over the estate's pairs rather
   * than over the returned jobs, because the returned jobs are the top `job_limit` by wall clock.
   */
  readonly networkBytesPerNodeMinute?: number;
  readonly pairsWithANetworkRate: number;
  /** Pairs whose every sample stated no network figure, which sum to zero and are not a measured zero. */
  readonly pairsStatingNoNetwork: number;
  readonly estateMedianBytesPerNodeMinute?: number;
  readonly estatePairsWithARate: number;
  /**
   * The worker node type as the cluster was configured when the run started, where that resolved.
   *
   * Absent rather than borrowed from a later record: relaxing the as-of ordering would name a type for
   * 53.6% of pairs instead of 8.7%, and every pair in the difference has its only configuration record
   * written after the run. `pairsWithAnAsOfConfig` is how many of the job's pairs the name came from, so a
   * surface may not render it as the job's compute without that count beside it.
   */
  readonly nodeType?: string;
  readonly pairsWithAnAsOfConfig: number;
  readonly workerCount?: number;
  /** Runs whose setup figure was null. Zero is a measured absence of a setup phase; null is an unread field. */
  readonly runsWithNoSetupFigure: number;
  readonly setupMsMax?: number;
  readonly setupMsMean?: number;
  /** The run duration the platform states, which was written as zero on every run on one estate measured. */
  readonly statedRunMsMean?: number;
  readonly earliestSample?: TDate;
  readonly latestSample?: TDate;
}

/**
 * How far the compute reading got, from the estate's jobs down to the ones it could read.
 *
 * Four steps because every one of them is attrition a reader would otherwise attribute to the rules:
 * 4,876 jobs ran on the estate measured, 4,158 carried a compute id, 1,064 ran on classic compute, and 689
 * were reachable by the worker join. A finding naming nine jobs is nine of 689.
 *
 * Absent on `JobsPayload` where the statement was not read at all. Present with zeros where it was read
 * and the estate runs everything on serverless, which is a reading about that workspace and not about the
 * platform — [ADR 0074] — and a surface has to be able to tell the two apart.
 */
export interface ComputeReachPayload<TDate = string> {
  readonly thatRan: number;
  readonly withAComputeId: number;
  readonly onClassicCompute: number;
  readonly withWorkerSamples: number;
  /**
   * The window the samples span, which is not the window the rest of the page is measured over.
   *
   * `system.compute.node_timeline` held 94 days of rows against the task timeline's 370 on the estate
   * measured. A utilisation figure rendered beside a duration trend is two windows on one page, and this
   * is what lets the surface say so.
   */
  readonly earliestSample?: TDate;
  readonly latestSample?: TDate;
}

/**
 * What the advisor concluded about how the estate's jobs ran.
 *
 * `eligible` out of `sampled` is the coverage sentence a surface owes a reader, and it is not a confidence
 * figure: it is how many of the jobs read had enough runs for any rule to read them.
 */
export interface JobsPayload<TDate = string> {
  /** Worst finding first, then by how long the job ran in total. */
  readonly jobs: readonly JobHealthPayload<TDate>[];
  readonly findingCount: number;
  readonly eligible: number;
  /**
   * Jobs that ran in the window, counted by the statement before its limit applied.
   *
   * The denominator, and it is not `jobs.length`. The statement takes the longest-running `job_limit` jobs
   * by total wall clock, because a row per job is 110% of an inline result at 100,000 jobs — see `H1` — so
   * a surface has to declare the sample against this. Both fields exist because the first version of this
   * payload carried one, set from the returned array, which made the cap disclosure a branch that could
   * never run and turned every job outside the top two hundred into a job reported as never having run.
   */
  readonly population: number;
  /** Jobs the statement returned: the longest-running `population` of them. Equals `jobs.length`. */
  readonly sampled: number;
  /** Live jobs the inventory lists, where it was read. Absent rather than zero if it was not. */
  readonly live?: number;
  /** How many of the listed jobs were found in that inventory, so a name can be told from an id. Of `sampled`. */
  readonly matched: number;
  /** How far the compute reading got, or absent where this run did not take one. See the type. */
  readonly computeRead?: ComputeReachPayload<TDate>;
  readonly windowDays: number;
  readonly rulesVersion: number;
}

/** One line of advisory history. */
export interface AdvisoryLinePayload<TDate = string> {
  readonly id: string;
  readonly runId: string;
  readonly finishedAt: TDate;
  readonly state: 'complete' | 'partial';
  readonly scope: string;
  readonly lookbackDays: number;
  readonly definitionId?: string;
  /** How many jobs the analysis had something to say about. Zero is a real answer. */
  readonly considered: number;
}

/**
 * The advisor's history, or why there is none.
 *
 * `available` rather than an empty list, for the reason `RunsPayload.durable` exists: an install with
 * no advisor and one that has never run it both answer with nothing and mean opposite things.
 */
export interface AdvisoryHistoryPayload<TDate = string> {
  readonly available: boolean;
  readonly runs: readonly AdvisoryLinePayload<TDate>[];
  readonly unavailable?: string;
}

export interface RemediationPayload {
  readonly summary?: string;
  readonly sql?: string;
  readonly cli?: string;
  readonly terraform?: string;
  /** What a person does where the fix is a judgement or an account-console action, not a command. */
  readonly byHand?: string;
  readonly deepLink?: string;
  readonly docUrl?: string;
  /** Where the fix trades something away, shown next to it rather than buried. */
  readonly caveat?: string;
}

export interface ControlPayload {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly provenance: 'waf-docs' | 'security-guide' | 'extension';
  readonly measurability: 'system-table' | 'rest-api' | 'cloud-api' | 'attestation' | 'derived';
  readonly evaluatorStatus: 'implemented' | 'planned' | 'unimplemented';
  /**
   * The requirement this control is one expression of, where two pillars ask for the same thing.
   *
   * The Databricks guidance repeats itself across pillars on purpose — infrastructure as code is
   * operational excellence *and* interoperability, and a customer reading either page should find it.
   * The catalogue keeps both entries for that reason, and the scorer credits the group once so an
   * estate is not penalised twice for one thing being wrong (`dedupeAliases` in `score.ts`).
   *
   * It is on the wire because scoring was not the only place that had to know. A queue of work built
   * from findings alone spent two of its twenty slots on one requirement, under the same title, and
   * counted twenty where the score counted eighteen — two numbers for one estate, of which the more
   * alarming was the wrong one. The client cannot derive this: identical titles are a coincidence a
   * catalogue edit can create, and matching on them would fold two genuinely different requirements
   * together the day somebody reuses a heading.
   */
  readonly aliasGroup?: string;
  readonly criteria?: string;
  readonly rationale?: string;
  readonly remediation?: RemediationPayload;
  readonly sourceRef?: string;
}

export interface PrinciplePayload {
  readonly id: string;
  readonly title: string;
  readonly sourceAnchor?: string;
  readonly controls: readonly ControlPayload[];
}

export interface PillarPayload {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly page?: string;
  readonly principles: readonly PrinciplePayload[];
}

export interface CataloguePayload {
  readonly version: { readonly version: string; readonly fingerprint: string };
  /**
   * Which pillars the app measures today, or null when it measures all of them. Named
   * rather than inferred so the UI can say a pillar is catalogued but not yet measured,
   * instead of showing it at zero and letting the reader assume the estate failed it.
   */
  readonly measuredPillars: readonly string[] | null;
  readonly pillars: readonly PillarPayload[];
}

/**
 * A condition under which a requirement does not apply to an estate, as the methodology sets it.
 *
 * Product-controlled, and distinct from anything a customer records. This is "there are no
 * all-purpose clusters here, so the requirement about their runtimes has nothing to judge" — a rule
 * that ships, applies identically everywhere, and is why a comparable score can exclude a
 * requirement at all.
 */
export interface MethodologyPreconditionPayload {
  readonly signal: string;
  readonly operator: string;
  readonly value?: number | string | boolean | null;
  readonly outcome: string;
  readonly scope: string;
}

/**
 * One requirement, in the terms that decide how it scores.
 *
 * Deliberately not the whole requirement: no prose, no remediation, no references. Those are on
 * `/api/catalogue`, and duplicating them here would make this a second copy of the catalogue rather
 * than an answer to "what can a version bump change about my score". Every field below is one the
 * fingerprint covers, which is the same statement as: changing any of them makes two runs
 * incomparable until the change is described.
 */
export interface MethodologyRequirementPayload {
  readonly id: string;
  /** The pillar's code, as the record holds it. */
  readonly pillar: string;
  readonly principle: string;
  readonly title: string;
  readonly provenance: string;
  readonly severity: string;
  readonly measurability: string;
  readonly coverageMode: string;
  readonly aliasGroup?: string;
  readonly clouds: readonly string[];
  readonly thresholds?: Readonly<Record<string, number | string | boolean | null>>;
  /** The requirement this one continues, where a renumbering was declared. */
  readonly continues?: string;
  readonly preconditions: readonly MethodologyPreconditionPayload[];
  /**
   * Fields the catalogue this build loaded reads differently from the record.
   *
   * Absent is the ordinary case and means the two agree. Present means the shipped config has been
   * edited without the version being bumped, so runs are being stamped with a version that no longer
   * describes what they were scored against. Named in the record's own field names, so they read the
   * same here as in a changelog entry.
   */
  readonly drifted?: readonly string[];
}

/** What one pre-release technical catalogue revision did to the one before it. */
export interface CatalogueRevisionPayload {
  readonly revision: string;
  readonly fingerprint: string;
  /** The date the version was recorded. Empty on a record that did not hold one. */
  readonly recordedAt: string;
  readonly scoredUnits: number;
  /**
   * Whether this version wrote down what it changed.
   *
   * False for one recorded before the record held shapes — the first version, and any written by an
   * older build. Kept as an entry rather than dropped, because "this version exists and what it moved
   * was not written down" and "this build has never heard of this version" are different facts, and
   * only the second is a reason to distrust the build.
   */
  readonly describes: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly renamed: readonly { readonly from: string; readonly to: string }[];
  readonly changed: readonly { readonly id: string; readonly fields: readonly string[] }[];
}

/**
 * How a finding becomes a number.
 *
 * The other half of the methodology, and the half no requirement list can show. A reader told that a
 * requirement is `high` cannot turn that into a score without these two tables: the weight each
 * severity carries, and the credit each outcome earns against it.
 *
 * `digest` is the identifier a run records as its methodology axis. A run whose axis does not match it
 * was scored by a weighting this build no longer uses, which is why the app refuses to draw a trend
 * across the two.
 */
export interface ScoringMethodPayload {
  readonly digest: string;
  /** What each severity is worth, relative to the others. */
  readonly severityWeight: Readonly<Record<string, number>>;
  /**
   * The share of that weight each outcome earns.
   *
   * Null means the outcome is left out of the average entirely rather than earning nothing — the
   * difference between "this requirement does not apply" and "this requirement failed", which is the
   * distinction the whole score rests on.
   */
  readonly credit: Readonly<Record<string, number | null>>;
}

export interface MethodologyPayload {
  /** The one customer release this build may stamp. */
  readonly release: {
    readonly publicVersion: number;
    readonly name: string;
    readonly state: PublicMethodologyStatePayload;
    readonly candidateStartedAt: string;
    /** Explicitly null while the release remains a candidate. */
    readonly effectiveDate: string | null;
    /** Full source commit selected and approved for this release; null while it is a candidate. */
    readonly releaseCommit: string | null;
    /** Named approval recorded in the release contract; null while it is a candidate. */
    readonly approvedBy: string | null;
    readonly manifestDigest: string;
  };
  /** Engineering provenance. Revisions here are not customer methodology releases. */
  readonly technical: {
    readonly catalogueRevision: string;
    readonly catalogueFingerprint: string;
    /** Development history, newest first. */
    readonly revisions: readonly CatalogueRevisionPayload[];
  };
  readonly scoring: ScoringMethodPayload;
  /** Requirements after alias groups are folded, which is what a score is out of. */
  readonly scoredUnits?: number;
  /** Every requirement the recorded version holds, by id. */
  readonly requirements: readonly MethodologyRequirementPayload[];
  /** Requirements the record holds that this build's catalogue does not. */
  readonly missing: readonly string[];
  /** Requirements this build's catalogue holds that the record does not. */
  readonly unrecorded: readonly string[];
  /**
   * Why the methodology cannot be listed, where it cannot.
   *
   * A sentence rather than a flag, because the ways to get here are different facts: a version file
   * this build could not read, and one written before it held per-requirement shapes. Runs still
   * record which version scored them either way.
   */
  readonly unavailable?: string;
}

/** What separates two technical catalogue revisions, or why it cannot be said. */
export interface CatalogueSpanPayload {
  readonly earlier: string;
  readonly later: string;
  readonly describable: boolean;
  readonly why?: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly renamed: readonly { readonly from: string; readonly to: string }[];
  readonly changed: readonly { readonly id: string; readonly fields: readonly string[] }[];
  /** The versions crossed, later first. */
  readonly versions: readonly string[];
}

/**
 * Something the caller must be allowed to do for a check to run.
 *
 * Kinds are separated because the three are granted by different people in different places:
 * a metastore grant is a SQL statement, a workspace permission is an admin settings page, and
 * an app scope is a property of this app's deployment that nobody in the workspace can change.
 */
export interface RequirementPayload {
  readonly kind: 'metastore-grant' | 'workspace-permission' | 'app-scope';
  readonly what: string;
  /** For an app scope: false means no install of this app can hold it. ADR 0016. */
  readonly grantable?: boolean;
  readonly note?: string;
}

export interface SignalCostPayload {
  readonly kind: 'one-statement' | 'per-object' | 'one-call';
  readonly objects?: string;
  readonly ceiling?: number;
}

export interface PlannedSignalPayload {
  readonly id: string;
  readonly surface: string;
  readonly collector: string;
  readonly reach: 'account' | 'metastore' | 'workspace';
  readonly observes: string;
  /** System tables by name, or an endpoint by path. */
  readonly touches: readonly string[];
  readonly cost: SignalCostPayload;
  readonly requires: readonly RequirementPayload[];
  /** Requirement ids whose outcome rests on this signal. */
  readonly answers: readonly string[];
  /** Requirement ids this makes more specific without deciding. */
  readonly enriches: readonly string[];
  /** Requirement ids whose applicability this decides. */
  readonly gates: readonly string[];
  /** True when nothing reads it directly and it is collected because another check needs it. */
  readonly input: boolean;
}

export interface SurfaceCostPayload {
  readonly surface: string;
  readonly fixed: number;
  readonly variable: readonly { readonly signal: string; readonly objects: string; readonly ceiling?: number }[];
  readonly budget: number;
}

export interface SurfacePayload {
  readonly surface: string;
  readonly title: string;
  readonly how: string;
  readonly identity: string;
  readonly requires: readonly RequirementPayload[];
}

export interface UnansweredPayload {
  /** Practice, which no API answers for anybody. */
  readonly attestation: number;
  /** Configuration the app is refused authorisation to read. A person reads the screen instead. */
  readonly unreachable: number;
  /** A check this app means to build. The only one of the four that is a promise. */
  readonly planned: number;
  readonly unimplemented: number;
}

export interface PillarPlanPayload {
  readonly pillarId: string;
  readonly title: string;
  readonly measured: boolean;
  readonly totalControls: number;
  /** Requirements a check exists for. With `unanswered` this accounts for all of them. */
  readonly answeredControls: number;
  /** Of those checks, how many need a scope no install of this app can hold. A subset. */
  readonly blockedControls: number;
  readonly unanswered: UnansweredPayload;
  readonly signals: readonly PlannedSignalPayload[];
  readonly requires: readonly RequirementPayload[];
  readonly cost: readonly SurfaceCostPayload[];
}

/**
 * What a scan would execute, per pillar, before it runs.
 *
 * Sent as its own payload rather than folded into the catalogue because it answers a
 * different question and changes on a different schedule: the catalogue is what is assessed,
 * this is what assessing it does to the workspace.
 */
export interface PlanPayload {
  readonly surfaces: readonly SurfacePayload[];
  readonly pillars: readonly PillarPlanPayload[];
}

export type AttestedAnswer = 'met' | 'partially-met' | 'not-met' | 'not-applicable';

/** Where an answer stands against its own review date. `due` still counts; `expired` does not. */
export type AttestationState = 'current' | 'due' | 'expired';

export interface AttestationPayload<TDate = string> {
  readonly id: string;
  readonly controlId: string;
  readonly answer: AttestedAnswer;
  readonly statement: string;
  readonly evidenceUrl?: string;
  readonly owner: string;
  readonly attestedBy: string;
  readonly attestedAt: TDate;
  readonly reviewBy: TDate;
  /**
   * Computed on the server rather than derived in the browser from `reviewBy`.
   *
   * Whether an answer still counts decides whether a requirement is in the score, and the
   * server has already made that decision when it scored the scan. Recomputing it against
   * the browser's clock would let a machine with a skewed clock display a state that
   * contradicts the score it is displayed next to.
   */
  readonly state: AttestationState;
  readonly supersedes?: string;
}

/**
 * A requirement that can only be answered by a person, with its answer if it has one.
 *
 * The question and the guidance come from the catalogue rather than being composed in the
 * browser, so what the customer is asked is versioned with the framework and moves through
 * the same review as any other change to what the app assesses.
 */
/**
 * Why a requirement is being put to a person instead of measured.
 *
 * `no-telemetry` is the permanent case: the requirement is about practice — whether recovery is
 * rehearsed, whether ownership is defined — so no scan of any estate settles it. Read as "asked of
 * everybody, always", which is what the UI shows it as: `Practice`.
 *
 * Not read as "nothing in the platform bears on it", which the name would suggest and which the
 * audit in ADR 0071 disproved for most of them: of the practice questions, a minority have no signal
 * at all and the rest have one that narrows the answer without settling it. That is a different
 * judgement, recorded per question as `askedBecause` on the *catalogue* entry — a `TelemetryVerdict`,
 * published in the coverage ledger, and deliberately not this field. This one says which mechanism
 * put the question in front of a person; that one says what a machine could have contributed.
 *
 * Two things called `askedBecause` in one codebase is a hazard, and a reviewer duly read the wire
 * value as the catalogue verdict and reported the UI as claiming no telemetry exists. It does not —
 * the label is `Practice` — but the confusion is the reason both sides now name the other.
 *
 * `not-authorised` is the case that could change. The check is written and working, and the
 * platform grants apps no scope for its source, so no install of this app can run it (ADR 0016).
 * Distinguished in the payload because the two deserve different words and different weight: an
 * answer of the second kind is a person reporting a setting the app would otherwise have read, so
 * it is the weakest evidence in the assessment and the UI has to be able to say so.
 *
 * `inconclusive` is the third case, and the only one that depends on the estate rather than on the
 * app. The check ran, read what it needed, and the answer does not distinguish the two situations
 * it would have to. The example that prompted it: a job deployed by Terraform is written through
 * the same API a person uses and carries no marker of its origin, so an estate managed entirely as
 * code is byte-identical to one built by hand. Asking is the only way to tell, and only worth
 * asking of the estates where the reading came back ambiguous — which is why this one is decided
 * per scan rather than per catalogue entry.
 */
export type AskedBecause = 'no-telemetry' | 'not-authorised' | 'inconclusive';

export interface AttestableRequirementPayload<TDate = string> {
  readonly controlId: string;
  readonly pillarId: string;
  /**
   * The principle this requirement sits under, which is what the guided pass groups by.
   *
   * Carried on the requirement rather than looked up from the catalogue in the browser because the
   * grouping decides the order questions are asked in, and an order assembled from two payloads
   * that can arrive independently is an order that is briefly wrong. See `walk.ts`.
   */
  readonly principleId: string;
  readonly title: string;
  readonly severity: Severity;
  readonly askedBecause: AskedBecause;
  readonly question: string;
  readonly evidenceGuidance?: string;
  /** How long an answer stands before it must be given again. */
  readonly cadenceDays: number;
  readonly attestation?: AttestationPayload<TDate>;
}

export interface AttestationsPayload<TDate = string> {
  readonly durable: boolean;
  /** Present when answers would not survive a restart, so the UI can refuse to pretend. */
  readonly durabilityNote?: string;
  readonly requirements: readonly AttestableRequirementPayload<TDate>[];
}

/**
 * How to check something, and what a reader should see when they do.
 *
 * `by-hand` is not a failure of the other four. Some of what this framework asks about lives in a
 * runbook or in somebody's memory of last quarter, and naming that honestly is better than inventing
 * a query that appears to settle it.
 */
export type GuidanceCheckKind = 'ui' | 'sql' | 'cli' | 'api' | 'by-hand';

export interface GuidanceCheckPayload {
  readonly how: GuidanceCheckKind;
  readonly where: string;
  readonly expect?: string;
  /**
   * What the check cannot tell you, where a clean result would otherwise read as a good one.
   *
   * Separate from `expect` because they are different claims, and the review that produced most of
   * these found the distinction the hard way: several checks queried a table that structurally excludes
   * the population being asked about, so the estate that fails hardest returns no rows and reads as
   * exemplary. That belongs somewhere a reader cannot skim past, not appended to a sentence about what
   * good looks like.
   */
  readonly caveat?: string;
}

/** Three worked examples. `partial` is the one that does the work: without it, everybody is strong. */
export interface GuidanceExamplesPayload {
  readonly strong: string;
  readonly partial: string;
  readonly weak: string;
}

/**
 * What to do about the requirement, as against how to answer a question about it.
 *
 * Optional on the payload and complete when present, which is the loader's guarantee rather than a
 * hope: a block missing one of the six is dropped at read time and refused at check time. The panel
 * can therefore render six headings without asking whether each has a body, and a reader can take
 * "no trade-offs are listed" to mean the author listed none, rather than that a field was skipped.
 */
export interface GuidanceAdvicePayload {
  readonly startFrom: string;
  readonly dependsOn: readonly string[];
  readonly path: readonly string[];
  readonly costs: readonly string[];
  readonly retain: string;
  readonly revisit: string;
}

/**
 * What a person needs in order to answer a question honestly.
 *
 * Served per requirement rather than with the list of them. The list is 105 requirements and this is
 * several hundred words each, which would be a megabyte of prose to render one pane — and the reader
 * opens one requirement at a time.
 *
 * Every field is required here even though the file format allows most of them to be absent, because
 * only authored guidance is served. A draft is withheld and the pane says so; see
 * `server/guidance/guidance.ts` for why half an entry is worse than none.
 */
export interface GuidancePayload {
  readonly means: string;
  readonly matters: string;
  /** The rubric an answer is measured against, as signals a reader can look at and know. */
  readonly good: readonly string[];
  readonly examples: GuidanceExamplesPayload;
  readonly verify: readonly GuidanceCheckPayload[];
  readonly pitfalls: readonly string[];
  readonly partialWhen: string;
  readonly notApplicableWhen?: string;
  readonly ownerRole?: string;
  /**
   * When a person last read this against the current framework and product.
   *
   * Shown, not just recorded. This content has to survive years of revisions, and a reader deciding
   * how much to trust a verification step is entitled to know whether it describes this year's
   * console.
   */
  readonly lastReviewed?: string;
  readonly references: readonly string[];
  /**
   * Absent on most entries today, and that is a backlog rather than a statement.
   *
   * The six dimensions were added to the contract after 63 entries had been authored against the
   * nine that came before, so an entry written last month has none. The surfaces render what is
   * there and say nothing about what is not, for the same reason the panel says nothing about a
   * question with no guidance at all.
   */
  readonly advice?: GuidanceAdvicePayload;
}

export interface GuidanceResponse {
  readonly controlId: string;
  /**
   * `absent` covers both a question nobody has written yet and one whose entry is still a draft.
   *
   * One state rather than two, because the difference does not change what the reader can do about
   * it: in both cases no guidance exists to read, and telling them which kind of nothing it is would
   * be reporting on this project's backlog inside somebody's assessment.
   */
  readonly status: 'authored' | 'absent';
  readonly guidance?: GuidancePayload;
}

/** What somebody chose to do about a finding. See server/decide/decision.ts. */
export type Disposition = 'accepted' | 'deferred' | 'fixed' | 'reopened';

/** What has become of that choice, once the estate has had its say. See server/decide/standing.ts. */
export type Standing =
  'current' | 'due' | 'lapsed' | 'unverified' | 'confirmed' | 'contradicted' | 'settled' | 'withdrawn';

export interface DecisionPayload<TDate = string> {
  readonly id: string;
  readonly controlId: string;
  readonly disposition: Disposition;
  readonly reason: string;
  /** Absent only where there is no consequence to own, which is a withdrawal. */
  readonly owner?: string;
  /** The review date of an acceptance or the due date of a deferral. Absent on the other two. */
  readonly until?: TDate;
  readonly decidedBy: string;
  readonly decidedAt: TDate;
  readonly supersedes?: string;
  /**
   * Computed on the server against the run being read, not derived in the browser.
   *
   * The same reason an attestation's state is: whether a claimed fix has been contradicted is a
   * comparison between a decision's date and a run's, and a browser with a skewed clock would
   * otherwise show a standing that contradicts the findings shown beside it. It is also the only
   * place that knows which run the standing was judged against.
   */
  readonly standing: Standing;
  /**
   * Whether this takes the finding off the work queue, decided with the standing rather than
   * re-derived from it in the browser.
   *
   * A flag rather than a rule the client applies to `standing`, because the client would then hold
   * a second copy of which standings park a finding, and the two would eventually disagree about
   * whether an unverified fix claim counts. One of them would be the queue and the other would be
   * the count printed beside it.
   */
  readonly parked: boolean;
  /** What the run measured this requirement as, when it has a finding for it. */
  readonly outcome?: Outcome;
  /** The requirement's title and pillar, so a decisions page need not join against the catalogue. */
  readonly title?: string;
  readonly pillarId?: string;
  readonly severity?: Severity;
}

export interface DecisionsPayload<TDate = string> {
  readonly durable: boolean;
  /** Present when decisions would not survive a restart, so the UI can refuse to pretend. */
  readonly durabilityNote?: string;
  readonly decisions: readonly DecisionPayload<TDate>[];
  /** The run the standings were judged against, so the page can say what it compared to. */
  readonly measuredAt?: TDate;
  /**
   * How long a finding of each severity may be parked at a time, as the server enforces it.
   *
   * Sent rather than compiled into the client so the form can refuse a date before the reader
   * presses the button, without keeping a second copy of the rule. A form that could only learn the
   * cap by being rejected would teach it one rejection at a time, and a client-side table would
   * eventually disagree with the server about what it had already accepted.
   */
  readonly parkDays: Readonly<Record<Severity, number>>;
}

/**
 * An assessment definition, as the browser reads it.
 *
 * The whole version history rather than only the current one, because the list has to show what
 * changed and when: an assessment whose scope was widened in July is a different thing from one
 * that has always covered the estate, and a payload carrying only the latest version cannot say so.
 * There are tens of these with a handful of versions each, so the history costs nothing to send.
 */
export interface DefinitionScopePayload {
  readonly kind: 'account' | 'selected';
  /** The workspaces asked for, sorted. Absent under account reach, which names none. */
  readonly workspaceIds?: readonly string[];
}

export interface DefinitionMeasurementPayload {
  readonly scope: DefinitionScopePayload;
  readonly lookbackDays: number;
  /** Absent means every pillar, which is not the same claim as naming all of them. */
  readonly pillars?: readonly string[];
}

export interface DefinitionAttributionPayload {
  readonly name: string;
  readonly purpose?: string;
  readonly owners: readonly string[];
}

export interface DefinitionVersionPayload<TDate = string> {
  readonly version: number;
  /**
   * What two runs are compared on.
   *
   * Sent to the browser because the history has to show which revisions changed the question and
   * which only changed its description — two adjacent versions sharing a fingerprint is the visible
   * form of "this was a rename", and recomputing it in the browser would mean shipping the hash.
   */
  readonly fingerprint: string;
  readonly createdAt: TDate;
  readonly createdBy: string;
  readonly measurement: DefinitionMeasurementPayload;
  readonly attribution: DefinitionAttributionPayload;
  /** Absent when this version commits to nothing, which is not the same as committing to zero. */
  readonly targets?: readonly PillarTargetPayload<TDate>[];
  readonly note?: string;
}

/**
 * A score the customer has committed to reaching in one pillar, by a date.
 *
 * `atLeast` is in the units the app reports scores in: 0–100, severity-weighted. The name carries the
 * comparison as well as the value, because an `atLeast` beside `PillarScorePayload.score` cannot be
 * mistaken for it — one is promised and the other measured, and a reader of either should not have to
 * check which they have.
 *
 * Beside `measurement` and `attribution` rather than inside either. Not `measurement`, because that is
 * what the fingerprint is taken over and setting a target must not end a customer's trend; not
 * `attribution`, which answers who owns the result. See `server/define/definition.ts`.
 */
export interface PillarTargetPayload<TDate = string> {
  readonly pillar: string;
  readonly atLeast: number;
  readonly by: TDate;
}

/**
 * A target as an author part-way through setting one.
 *
 * `by` is a day rather than an instant — `YYYY-MM-DD`, as a date field gives it — and is read as UTC
 * when it becomes a definition so that the day cannot shift under a reader in another zone.
 */
export interface DraftTargetPayload {
  readonly pillar: string;
  readonly atLeast?: number;
  readonly by?: string;
}

/** How a commitment stands. `server/programme/targets.ts` says why there are five of these. */
export type TargetStandingPayload = 'met' | 'short' | 'gap' | 'not-scored' | 'not-assessed';

/**
 * One target, held against the run being read.
 *
 * `sentence` is the whole reading in words, and is what a surface shows. Composed on the server so
 * every surface says it identically and so the rule that this never accuses anybody of missing a
 * target lives in one place instead of in each component that renders one.
 *
 * `standing` is for emphasis and ordering rather than for the browser to write its own sentence from.
 * Two of the five mean there was no number to compare, and a client that treated an absent `score` as
 * zero would report a gap nobody measured.
 */
export interface TargetReadingPayload<TDate = string> {
  readonly pillar: string;
  readonly atLeast: number;
  readonly by: TDate;
  readonly standing: TargetStandingPayload;
  /** Whether the date has passed, as the server judged it, so the browser cannot disagree. */
  readonly due: boolean;
  /** Absent for both of the standings that had nothing to compare. */
  readonly score?: number;
  readonly shortBy?: number;
  readonly daysLeft?: number;
  readonly sentence: string;
}

export interface DefinitionPayload<TDate = string> {
  readonly id: string;
  readonly versions: readonly DefinitionVersionPayload<TDate>[];
  /** Set when the definition is closed to new runs. It is never deleted. */
  readonly archivedAt?: TDate;
}

export interface DefinitionsPayload<TDate = string> {
  readonly definitions: readonly DefinitionPayload<TDate>[];
  /** True when definitions survive a restart. The UI says so rather than assuming. */
  readonly durable: boolean;
  /** What this install does about keeping them, in the reader's terms. */
  readonly storage?: string;
}

/**
 * A workspace the picker can offer, and whether an assessment could cover it.
 *
 * `assessable` is not the same as `status === 'RUNNING'`: a running workspace in another region is
 * one this deployment cannot read, and offering it as though selecting it would do something is how
 * an author ends up with an assessment that claims more than it covers.
 */
export interface SelectableWorkspacePayload {
  readonly id: string;
  readonly name: string;
  readonly url?: string;
  readonly status: string;
  readonly assessable: boolean;
  /** Why not, on the ones that are not. Absent on assessable workspaces. */
  readonly reason?: 'not-running' | 'other-region';
}

export interface SelectableWorkspacesPayload<TDate = string> {
  readonly workspaces: readonly SelectableWorkspacePayload[];
  /**
   * When the estate this list describes was read.
   *
   * A fresh install reads the directory on demand. Once a scan has recorded one, the route may use
   * that stored directory instead, so the reader is always told when the list was true. A picker
   * that presented a month-old estate as current would let somebody select a workspace that no
   * longer exists and learn about it from a report.
   */
  readonly asOf?: TDate;
  /** Why there is no list, when there is none. */
  readonly unavailable?: string;
}

/** What a probe of one system table found, and what it costs the assessment. */
export interface PreflightSourcePayload {
  readonly table: string;
  /** Where a grant would be made, which is one level above the table. */
  readonly schema: string;
  readonly reading: 'readable' | 'denied' | 'absent' | 'unknown';
  /** The platform's own words, which is where a scope or privilege name appears. */
  readonly detail: string;
  /** Present only on a denial, and runnable exactly as written. */
  readonly grant?: string;
  /** Control ids that read this table, so a grant can be costed before it is asked for. */
  readonly blocks: readonly string[];
}

export interface PreflightBlockedPayload {
  readonly controlId: string;
  readonly pillarId: string;
  /** The grants that would unblock it. Empty when the remedy is not a grant. */
  readonly needs: readonly string[];
}

export interface PreflightScopePayload {
  /** Workspace ids the assessment would cover. */
  readonly assessed: readonly string[];
  readonly omitted: readonly {
    readonly workspaceId: string;
    readonly name?: string;
    readonly reason: 'not-running' | 'other-region' | 'unknown';
  }[];
  /** Assessable and deliberately left out. A count, since the picker already lists them. */
  readonly outOfScope: number;
  readonly complete: boolean;
  readonly description: string;
}

/**
 * Whether an assessment can run as the caller, checked before it is run.
 *
 * The two halves have different freshness and the payload says so: `sources` was probed live during
 * this request, and `scope` was resolved against the directory the last scan read, at `scopeAsOf`.
 * Presenting them as one timestamp would let a reader act on a month-old estate believing it had
 * just been checked.
 */
export interface PreflightPayload<TDate = string> {
  readonly ranAt: TDate;
  /** The identity the probes ran as, which is the identity the grants have to be made to. */
  readonly ranAs: string;
  readonly definitionId: string;
  readonly version: number;
  readonly fingerprint: string;
  readonly sources: readonly PreflightSourcePayload[];
  readonly blocked: readonly PreflightBlockedPayload[];
  /** Checks in the assessment that would produce a result. */
  readonly ready: number;
  readonly scope?: PreflightScopePayload;
  readonly scopeAsOf?: TDate;
  readonly verdict: string;
}

/**
 * The admin evidence script, described rather than served.
 *
 * Enough to verify a copy already downloaded, which is the case that matters: an admin is emailed
 * the file by a colleague and wants to know it is the one the app publishes before running it
 * against production with account-admin authority. So the digest travels separately from the bytes.
 */
export interface EvidenceScriptPayload<TDate = string> {
  readonly name: string;
  /** `sha256:<hex>` over the file, in the same spelling the script reports for itself. */
  readonly digest: string;
  readonly bytes: number;
  /** The envelope contract the script writes, so an importer can refuse a schema it predates. */
  readonly schema: string;
  readonly version: string;
  readonly modifiedAt: TDate;
  readonly href: string;
  /**
   * How to check the download, as commands rather than as a description.
   *
   * Both tools, because a check only happens if it is easy, and an admin on macOS and one on Linux
   * do not reach for the same one.
   */
  readonly verify: readonly string[];
}

/**
 * One file a run can be taken away as, described rather than served.
 *
 * The same shape and the same reasoning as `EvidenceScriptPayload`, for the same reason and in the
 * opposite direction: there, the app publishes a digest so an admin can check a file before running
 * it; here, so somebody who sent an export can tell a recipient what they should compute. Both need
 * the digest away from the bytes, because the person doing the checking is not the person who asked
 * this app for anything.
 *
 * It only means something because an export of a run is the same bytes every time. A digest for a
 * file that changed between two downloads would be a value nobody could reproduce, and publishing
 * one would be worse than publishing none. ADR 0050.
 */
export interface ExportFilePayload {
  readonly name: string;
  readonly format: 'csv' | 'json';
  /** Who the file is for, which decides its columns and fields. */
  readonly variant: string;
  /** `sha256:<hex>` over the bytes as served. */
  readonly digest: string;
  readonly bytes: number;
  readonly href: string;
  /** How to check a copy, as commands. Both tools, for the reason the script payload gives. */
  readonly verify: readonly string[];
}

/**
 * One audience a document can be exported for, described so a reader can choose.
 *
 * Shared by the assessment and the improvement plan, which have four audiences and three; the words
 * are not the same words and this type deliberately does not enumerate either. A page renders the
 * server's sentence rather than a list it holds itself, so adding a variant is a server change.
 */
export interface ExportVariantPayload {
  readonly variant: string;
  /** Who it is for, in the server's words, so the page and the file cannot describe it differently. */
  readonly says: string;
  /** What it leaves out and where the whole of it is. Absent for the complete file. */
  readonly omits?: string;
  readonly files: readonly ExportFilePayload[];
}

/**
 * A file that has already left, as the trail recorded it.
 *
 * Here because the question a sender asks is not only "what should this hash to" but "what did the
 * copy I already sent hash to" — and the answer can differ: an export describes the run *and the
 * decisions standing against it*, so accepting a risk after sending a file changes what the next
 * download says. A recipient who checks then reports a mismatch, and the sender needs to be able to
 * see that their copy predates a decision rather than spend an afternoon on a tampering scare.
 */
export interface ExportRecordPayload<TDate = string> {
  readonly name: string;
  readonly digest: string;
  readonly at: TDate;
  /** Who took it, from the forwarded identity the trail recorded. */
  readonly by: string;
  /**
   * Whether an export of that name taken now would hash to the same value.
   *
   * `false` means the record has moved since — a decision, an attestation — and is a statement about
   * this app rather than about the copy. Absent when the app cannot say, which is a name no current
   * variant produces: a file from an earlier version of this app, whose bytes it can no longer build.
   */
  readonly current?: boolean;
}

/** Every file this run can be exported as, with what each one should hash to, and what has already left. */
export interface RunExportsPayload<TDate = string> {
  readonly scanId: string;
  /**
   * The complete file in both formats, kept for the readers of this payload that predate variants.
   *
   * The same objects that appear under the technical entry in `variants`, so a page can list either
   * without the two disagreeing.
   */
  readonly files: readonly ExportFilePayload[];
  readonly variants: readonly ExportVariantPayload[];
  /** What has already been taken from this run, newest first. Empty when nothing has, or when the trail is not bound. */
  readonly taken: readonly ExportRecordPayload<TDate>[];
}

/**
 * One thing worth saying about an imported file, whether it was accepted or not.
 *
 * The reason travels beside the message so the page can group and style by cause without matching on
 * prose, and the message travels at all because the server is the only place that knows what was
 * compared against what — an id, an age in days, a count of workspaces. A client rebuilding these
 * sentences would be rebuilding the checks.
 */
export interface EvidenceNotePayload {
  readonly reason: string;
  readonly message: string;
}

/** A collection this app holds, as the page lists it. */
export interface EvidenceImportPayload<TDate = string> {
  readonly digest: string;
  readonly generatedAt: TDate;
  readonly importedAt: TDate;
  /** Who uploaded it. Not who collected it — see `collectedBy`. */
  readonly importedBy: string;
  /**
   * Who ran the script, when the CLI could say.
   *
   * Absent for an account-tier-only collection, because no account-plane endpoint names its caller.
   * The page says so rather than leaving a blank, since "nobody is accountable for this reading" and
   * "the tooling cannot name them" are different claims.
   */
  readonly collectedBy?: string;
  readonly workspaceTier: boolean;
  readonly accountTier: boolean;
  /** Readings that came back with a value. */
  readonly observed: number;
  /** Calls the API refused or that failed, which are unmeasured rather than passing. */
  readonly refused: number;
  /** Requirements the readings in this file speak to. */
  readonly requirements: number;
  readonly scriptVersion: string;
  /** What was true of it at import, kept rather than recomputed, because a file ages. */
  readonly cautions: readonly EvidenceNotePayload[];
}

/**
 * What happened to an upload.
 *
 * A refusal is a 422 carrying this same shape, because the reasons are the response: a caller told
 * only "rejected" has to guess between a tampered file, last quarter's file, and the right file for
 * somebody else's account, and those have three different fixes.
 */
export interface EvidenceImportVerdictPayload<TDate = string> {
  readonly accepted: boolean;
  readonly refusals: readonly EvidenceNotePayload[];
  readonly cautions: readonly EvidenceNotePayload[];
  /** Present when accepted. */
  readonly imported?: EvidenceImportPayload<TDate>;
}

/** Every collection held, and whether they survive a restart. */
export interface EvidenceImportsPayload<TDate = string> {
  readonly durable: boolean;
  readonly imports: readonly EvidenceImportPayload<TDate>[];
  /** How many days a collection is accepted for, so the page states the rule rather than implying it. */
  readonly acceptedForDays: number;
}

/**
 * An assessment part-written, as the wizard reads it back.
 *
 * Three of these fields are derived rather than stored, and sending them beats recomputing them in
 * the browser for the same reason the fingerprint is sent: the rules would then exist twice. `ready`
 * and `troubles` come from the same function the confirmation is refused by, so a step the strip
 * marks finished cannot be one the server then rejects. `resumeAt` is where the author is put back,
 * and it is derived from the troubles rather than stored, so a draft edited from a second browser
 * opens on what is actually unfinished instead of where the first browser had got to.
 */
export interface SetupDraftPayload<TDate = string> {
  /** Absent when this is a new assessment rather than a revision. */
  readonly definitionId?: string;
  readonly fromVersion?: number;
  readonly name?: string;
  readonly purpose?: string;
  readonly owners?: readonly string[];
  readonly scope?: {
    readonly kind: 'account' | 'selected';
    readonly workspaceIds?: readonly string[];
  };
  readonly lookbackDays?: number;
  /** Absent means every pillar, as it does on a definition. */
  readonly pillars?: readonly string[];
  /**
   * The commitments as far as they have been decided, which may be half-typed.
   *
   * Looser than `PillarTargetPayload`: a score with no date yet is a legitimate draft and an invalid
   * definition. Absent and empty both mean nothing has been committed to, and neither is unfinished
   * work — a target is optional, so an author who never opened the step has left nothing outstanding.
   */
  readonly targets?: readonly DraftTargetPayload[];
  readonly note?: string;
  readonly savedAt: TDate;
  /** The name of the assessment being revised, so a resume list reads as more than a list of ids. */
  readonly definitionName?: string;
  readonly ready: boolean;
  readonly troubles: readonly { readonly step: string; readonly trouble: string }[];
  readonly resumeAt: string;
  /**
   * Whether the assessment this revises is still the one it was started against.
   *
   * `superseded`, `archived` and `gone` all mean confirming would fail or would do damage, and each
   * is a different thing to tell the author — which is why this is a word and a sentence rather than
   * a boolean. Sent on the way in, so the refusal arrives before the author has re-read five steps.
   */
  readonly standing: 'new' | 'current' | 'superseded' | 'archived' | 'gone';
  readonly warning?: string;
}

export interface SetupDraftsPayload<TDate = string> {
  readonly drafts: readonly SetupDraftPayload<TDate>[];
  /** True when an unfinished assessment survives a restart. Said plainly, never assumed. */
  readonly durable: boolean;
  readonly storage?: string;
}

/**
 * What a scope would cover, held against the estate before anything is saved.
 *
 * The point of previewing rather than waiting for the run: a scope naming eleven workspaces of which
 * four have been decommissioned reads as an assessment of eleven, and the place to find that out is
 * while it can still be changed. `asOf` is here because the estate comes from the last scan's
 * directory, so this says what would have been covered then — which is the honest claim available
 * without running a collector.
 */
export interface ScopePreviewPayload<TDate = string> {
  readonly assessed: readonly { readonly workspaceId: string; readonly name: string }[];
  readonly omitted: readonly {
    readonly workspaceId: string;
    readonly name?: string;
    readonly reason: 'not-running' | 'other-region' | 'unknown';
  }[];
  /** Assessable and deliberately left out. A count, since the picker already lists them. */
  readonly outOfScope: number;
  readonly complete: boolean;
  readonly description: string;
  readonly asOf?: TDate;
  /** Why there is nothing to resolve against, when there is nothing. */
  readonly unavailable?: string;
}

/**
 * One act, as the trail shows it.
 *
 * `sequence` travels rather than being left on the server, because it is what the reader cites: a
 * page of events is identified by the numbers in it, and "the fourth row of the second page" is not
 * a citation. It is also the paging cursor, so a client that shows it is a client that can ask for
 * what comes before it without a second concept.
 */
export interface AuditEventPayload<TDate = string> {
  readonly sequence: number;
  readonly at: TDate;
  readonly actor: string;
  readonly executionMode: 'on-behalf-of-user' | 'service-principal';
  readonly action: string;
  readonly outcome: 'performed' | 'refused' | 'failed';
  readonly target?: {
    readonly kind: string;
    readonly id: string;
    /**
     * The digest of the target's content, present only for a file this app handed over.
     *
     * The row is where a recipient's copy is checked against what left: `shasum -a 256` on the file
     * they hold, compared with this. Every other kind of target can be looked up, so its row needs
     * no more than an id.
     */
    readonly digest?: string;
  };
  /** Why it ended that way, in the app's own words. Absent on `performed`. */
  readonly reason?: string;
  readonly correlation?: string;
  readonly digest: string;
}

/** Where the chain ends, which is the value a customer records elsewhere to pin the log. */
export interface AuditHeadPayload {
  readonly sequence: number;
  readonly digest: string;
}

/**
 * A page of the trail, and what the reader needs to judge it.
 *
 * `durable` is here for the same reason it is on the imports payload: a trail held in memory is a
 * trail that is empty after the next deploy, and a page showing an empty list without saying so
 * teaches the reader that nothing happened.
 *
 * `actions` is the vocabulary rather than the distinct values present, so the filter offers every
 * question the log can answer instead of only the ones it happens to have an answer for today —
 * "nobody has ever been refused" is a result worth being able to ask for.
 */
export interface AuditTrailPayload<TDate = string> {
  readonly durable: boolean;
  readonly events: readonly AuditEventPayload<TDate>[];
  /** Pass as `before` for the next page. Absent when this page reached the beginning. */
  readonly next?: number;
  readonly head?: AuditHeadPayload;
  /**
   * Every act this app records, in the words a person would use for it.
   *
   * The phrase is served rather than compiled into the client, for the reason `AUDIT_PHRASES` gives:
   * a client-side copy of the vocabulary goes stale in both directions at once, offering a filter for
   * an act nothing emits while showing a new act to the reader as its identifier.
   */
  readonly actions: readonly { readonly id: string; readonly phrase: string }[];
  /** Why there is no trail, when there is none. */
  readonly unavailable?: string;
}

/** Whether the trail is still what this app wrote, in the same register as record verification. */
export interface AuditVerificationPayload {
  readonly checked: number;
  readonly head?: AuditHeadPayload;
  readonly breaks: readonly {
    readonly sequence: number;
    readonly kind: 'digest' | 'link' | 'gap';
    readonly says: string;
  }[];
  readonly means: string;
}

/** What a dependency was doing, and what to do about it. See `server/health/health.ts`. */
export interface ReadingPayload {
  readonly dependency: 'warehouse' | 'database' | 'identity' | 'audit-log';
  readonly standing: 'answering' | 'degraded' | 'silent' | 'unbound' | 'unknown';
  /**
   * Whether this was established now or is what the last user of the dependency found.
   *
   * On the wire rather than folded into the prose because the page renders it differently: an observed
   * reading is shown with its date, since "answering" as of eleven hours ago is a different claim from
   * "answering" as of this second, and a reader who cannot see which will take the stronger one.
   */
  readonly provenance: 'probed' | 'observed';
  readonly at: string;
  readonly detail: string;
  readonly action?: string;
}

/** Everything this install can and cannot reach, in one answer. */
export interface DiagnosticsPayload {
  readonly at: string;
  readonly well: boolean;
  /** Acts this process could not write to the trail. Zero on a healthy install. */
  readonly unrecorded: number;
  readonly readings: readonly ReadingPayload[];
}

/** One table, how much it holds, and how much of that is past its period. */
export interface EligibilityPayload {
  readonly table: string;
  /** What it holds, so a period can be judged against the thing rather than against a table name. */
  readonly holds: string;
  readonly total: number;
  readonly eligible: number;
  /** The age of the oldest row. Absent when the table is empty. */
  readonly oldest?: string;
}

/**
 * Why a record is kept, which is what a period is set against.
 *
 * Named rather than spelled out at each of the four places that carry it. It was spelled out, and a
 * fourth class arriving with the advisor meant four edits where one of them — the eligibility rows —
 * had drifted into a shape the server could no longer satisfy.
 */
export type RetentionClassName = 'temporary' | 'assessment' | 'governance' | 'advisory';

/** A class of record, its period, and what that period currently makes eligible. */
export interface RetentionClassPayload {
  readonly retentionClass: RetentionClassName;
  readonly periodDays: number;
  /** The approved default, so a page can show what a changed period was changed from. */
  readonly defaultDays: number;
  readonly cutoff: string;
  /** Ids of the holds stopping this class from being swept. Empty when nothing is held. */
  readonly heldBy: readonly string[];
  readonly tables: readonly EligibilityPayload[];
}

export interface LegalHoldPayload {
  readonly id: string;
  readonly reason: string;
  readonly covers: readonly RetentionClassName[];
  readonly placedBy: string;
  readonly placedAt: string;
  readonly releasedBy?: string;
  readonly releasedAt?: string;
}

/** How long this install keeps what it wrote, and what that makes eligible now. */
export interface RetentionPayload {
  /**
   * Whether anything here outlives a restart.
   *
   * False means the policy is inert rather than absent: the periods still read as they would apply, and
   * `unavailable` says why nothing will ever age past them.
   */
  readonly durable: boolean;
  readonly at?: string;
  readonly setBy?: string;
  readonly setAt?: string;
  readonly classes: readonly RetentionClassPayload[];
  readonly holds: readonly LegalHoldPayload[];
  /** Tables deliberately not swept, with the reason, so the omission is stated rather than inferred. */
  readonly exempt: readonly { readonly table: string; readonly because: string }[];
  readonly wouldRemove: number;
  readonly bounds: { readonly least: number; readonly most: number };
  readonly unavailable?: string;
  /** What emptying this install would destroy. Absent when nothing here is kept. */
  readonly reset?: ResetPlanPayload;
}

/** One table a reset empties, and what a reader loses when it does. */
export interface ResetTablePayload {
  readonly table: string;
  readonly holds: string;
  /** Whether a sweep can ever reach it. False for the five that are the reason a reset exists. */
  readonly swept: boolean;
  readonly rows: number;
}

/** What emptying this install would destroy, and what would refuse it. */
export interface ResetPlanPayload {
  /** Every table, including the empty ones, so the act's reach is stated rather than inferred. */
  readonly tables: readonly ResetTablePayload[];
  /**
   * What would go, not counting the trail. This is the number a reset is confirmed with.
   *
   * Separate from `events` because the trail grows every time anybody does anything — including a
   * refused reset. A single total would mean a mistyped confirmation refuses, the refusal records
   * itself, and the number quoted back is already wrong by one.
   */
  readonly records: number;
  /** How many audit events would go with them. */
  readonly events: number;
  /** Ids of holds in force. Any hold at all refuses a reset, whatever it covers. */
  readonly heldBy: readonly string[];
}

/** What a reset did. Its own account, beside the genesis event that is now the trail's first entry. */
export interface ResetPayload {
  readonly at: string;
  readonly by: string;
  readonly emptied: readonly { readonly table: string; readonly removed: number }[];
  /** Everything, trail included, which is the number the genesis event carries. */
  readonly rows: number;
  readonly tables: number;
}

/**
 * The seven states an action moves through. See server/improve/action.ts.
 *
 * `verified` is on this list and is not a state any request can set: the server refuses it, because a
 * fix an owner marks verified is the claim the whole lifecycle exists to distinguish from a
 * measurement. A client renders it and never offers it.
 */
export type ActionStatePayload =
  'draft' | 'planned' | 'in-progress' | 'blocked' | 'ready-for-validation' | 'verified' | 'cancelled';

export type ActionPriorityPayload = 'now' | 'next' | 'later';

export type ActionEffortPayload = 'small' | 'medium' | 'large' | 'programme';

/**
 * What the estate says about the requirements an action names. See server/improve/progress.ts.
 *
 * `unjudged` is the one that is not about a measurement's result: an action raised from an advisor
 * finding names no requirement, so no assessment run can agree or disagree with it, and the word says
 * that rather than reporting an empty comparison as agreement.
 */
export type AgreementPayload = 'unclaimed' | 'awaiting' | 'agreed' | 'contradicted' | 'unmeasured' | 'unjudged';

/** One of the five Optimisation advisors, naming which analysis a finding came from. */
export type AdvisorPayload = 'workload' | 'sizing' | 'jobs' | 'writes' | 'serverless';

/**
 * Which advisor finding an action is being raised from, as a client names it.
 *
 * Five ids and nothing a reader typed: the server reads the finding out of the stored advisory and
 * writes the provenance itself. A client sending the finding's own numbers would be sending whatever
 * page it had open — see server/improve/advice.ts.
 */
export interface AdviceReferencePayload {
  readonly advisoryId: string;
  readonly advisor: AdvisorPayload;
  /** The query shape, warehouse id or job id the finding was found on. */
  readonly resource: string;
  readonly rule: string;
}

/** A number the advice was measured in, with the unit that makes it mean something. */
export interface AdviceEvidencePayload {
  readonly label: string;
  readonly value: number;
  readonly unit: 'bytes' | 'ms' | 'percent' | 'ratio' | 'multiple' | 'count';
}

/**
 * What an action kept of the advisor finding it was raised from.
 *
 * Frozen at the moment it was raised, so it describes the advice somebody acted on rather than what
 * the advisor says today. `baseline` empty means the advisor measured in prose — `observation` is then
 * all there is, and ADR 0083 is what says such an action can hold an opportunity and not a realised
 * value.
 */
export interface AdviceProvenancePayload<TDate = string> {
  readonly advisoryId: string;
  readonly advisor: AdvisorPayload;
  readonly rule: string;
  /** Every version the analysis declared. Empty where it declared none, which is a fact worth seeing. */
  readonly versions: readonly { readonly name: string; readonly value: string }[];
  readonly resource: {
    readonly kind: 'shape' | 'warehouse' | 'job';
    readonly id: string;
    readonly workspaceId: string;
    readonly name?: string;
  };
  readonly headline: string;
  readonly detail: string;
  readonly docUrl: string;
  readonly severity?: 'critical' | 'high' | 'medium' | 'info';
  readonly baseline: readonly AdviceEvidencePayload[];
  /** The measurement as the advisor wrote it, where a sentence was all it had. */
  readonly observation?: string;
  /** What the advisor's figures rest on, in its own words. Shown wherever a figure from it is. */
  readonly assumptions: readonly string[];
  /**
   * What the advisor said moving the resource would be worth, where it priced one.
   *
   * The resource's range and not this finding's share of it: a job has as many reasons as it has, and
   * the analysis prices the move rather than the reason. Absent on three of the four advisors, which
   * estimate no money at all, and on a job whose spend could not be read.
   */
  readonly opportunity?: AdviceOpportunityPayload;
  readonly measuredAt: TDate;
  readonly lookbackDays: number;
}

export interface AdviceOpportunityPayload {
  readonly low: number;
  readonly high: number;
  readonly currency: string;
  /** The price list the rate was read from, which is the part of it a reader can check. */
  readonly region?: string;
}

/** What a later advisory said about the finding an action was raised from. */
export type AdviceStandingPayload =
  /** The same rule fired again on the same resource. */
  | 'still-firing'
  /** The resource was read again and the rule did not fire. */
  | 'cleared'
  /** The later run says nothing about this resource, which is not the same as saying it is fine. */
  | 'resource-absent'
  /** The later run formed no analysis for this advisor. */
  | 'advisor-unread'
  /** This build's ruleset no longer has the rule, so nothing can look for it. */
  | 'rule-withdrawn'
  /** The advisory is not later than the advice it is being compared with. */
  | 'not-later';

/** One measure read twice. Both readings and never their difference — see ADR 0083. */
export interface AdviceMovementPayload {
  readonly label: string;
  readonly unit: AdviceEvidencePayload['unit'];
  readonly before: number;
  readonly after: number;
}

/**
 * The latest advisory's reading of an action's advice.
 *
 * Only ever about the same rule on the same resource. `movements` is empty on every standing but
 * `still-firing` — a rule that has stopped firing leaves no reading of the measure it fired on, which
 * is why a cleared finding is a count rather than a realised figure.
 */
export interface AdviceReadingPayload<TDate = string> {
  readonly advisoryId: string;
  readonly measuredAt: TDate;
  readonly lookbackDays: number;
  readonly standing: AdviceStandingPayload;
  readonly movements: readonly AdviceMovementPayload[];
  /** Baseline measures this reading does not carry, by label, so a partial comparison says so. */
  readonly unmatched: readonly string[];
  /** Why the two readings may not be subtracted, where they may not. */
  readonly incomparable?: 'window' | 'rules-version';
}

export type LatenessPayload = 'undated' | 'on-time' | 'due' | 'overdue';

export interface ActionTransitionPayload<TDate = string> {
  readonly from: ActionStatePayload;
  readonly to: ActionStatePayload;
  readonly at: TDate;
  /**
   * Which kind of thing moved it, because `who` is an id for two of the three.
   *
   * `run` is a scan and `advisor` is an advisory: an action raised from advisor advice is verified by
   * a later advisory no longer reporting its finding, and a reader told `run` would look for that id
   * among the scans.
   */
  readonly by: 'person' | 'run' | 'advisor';
  readonly who: string;
  readonly reason?: string;
}

export interface ImprovementActionPayload<TDate = string> {
  readonly id: string;
  readonly planId: string;
  readonly controlIds: readonly string[];
  readonly outcome: string;
  readonly definitionOfDone: string;
  readonly owner: string;
  readonly priority: ActionPriorityPayload;
  readonly effort: ActionEffortPayload;
  readonly due?: TDate;
  readonly steps: readonly string[];
  readonly dependsOn: readonly string[];
  readonly state: ActionStatePayload;
  /** The run it was raised from, so the evidence behind it can still be found. */
  readonly raisedFrom?: string;
  /** The advisor finding it was raised from, where it was raised from one rather than a requirement. */
  readonly advice?: AdviceProvenancePayload<TDate>;
  readonly createdBy: string;
  readonly createdAt: TDate;
  readonly history: readonly ActionTransitionPayload<TDate>[];
  /**
   * Where the action stands, computed on the server against the run being read.
   *
   * On the wire rather than derived in the browser, for the reason a decision's standing is: the
   * comparison is between the date the owner claimed the work done and the date a run measured the
   * requirements, and a browser with a skewed clock would show an agreement that contradicts the
   * findings beside it. It is also the only place that knows which run the reading was taken against.
   */
  readonly agreement: AgreementPayload;
  readonly lateness: LatenessPayload;
  /** The requirements behind the agreement, named rather than counted, so a reader can check it. */
  readonly unmet: readonly string[];
  readonly unreadable: readonly string[];
  /**
   * What the latest advisory says about the finding this was raised from.
   *
   * Present only where the action has advice and this install holds an advisory later than it. For an
   * action that names no requirement it is what the agreement above was computed from; for one that
   * names both, it is beside the agreement rather than behind it — the assessment is what judges an
   * action that answers a requirement, and the advisor's reading is still worth showing.
   */
  readonly adviceReading?: AdviceReadingPayload<TDate>;
  /**
   * The states a person may move this to from here, as the server's own table gives them.
   *
   * Sent rather than compiled into the client, for the reason `parkDays` is: a second copy of the
   * lifecycle in the browser would eventually offer a move the server refuses, and the reader would
   * learn the real rule one rejection at a time.
   */
  readonly moves: readonly ActionStatePayload[];
  /** The requirement titles, so a board need not join against the catalogue to be readable. */
  readonly titles: Readonly<Record<string, string>>;
}

export interface PlanAssessmentPayload {
  readonly definitionId: string;
  readonly version: number;
}

export interface PlanClosurePayload<TDate = string> {
  readonly at: TDate;
  readonly by: string;
  readonly reason: string;
}

/**
 * How a plan's actions stand, as counts and named lists rather than as a percentage.
 *
 * No single figure, deliberately: three of five actions verified is not 60% of an outcome, because
 * the remaining two are usually the hard ones. See server/improve/progress.ts.
 */
export interface PlanProgressPayload<TDate = string> {
  readonly planId: string;
  readonly states: Readonly<Record<ActionStatePayload, number>>;
  /** Action ids whose claim the estate contradicts. The reason to read a rollup at all. */
  readonly contradicted: readonly string[];
  readonly overdue: readonly string[];
  readonly blocked: readonly string[];
  /** Every action is verified or cancelled. Not the same claim as the plan having achieved anything. */
  readonly settled: boolean;
  readonly nextDue?: TDate;
}

export interface ImprovementPlanPayload<TDate = string> {
  readonly id: string;
  readonly title: string;
  readonly outcome: string;
  readonly owners: readonly string[];
  readonly assessment?: PlanAssessmentPayload;
  /** The run the plan was raised from. This is the baseline, by reference rather than as a copy. */
  readonly raisedFrom?: string;
  readonly createdBy: string;
  readonly createdAt: TDate;
  readonly closed?: PlanClosurePayload<TDate>;
  readonly progress: PlanProgressPayload<TDate>;
}

export interface ImprovementsPayload<TDate = string> {
  readonly durable: boolean;
  /** Present when plans would not survive a restart, so the UI can refuse to pretend. */
  readonly durabilityNote?: string;
  readonly plans: readonly ImprovementPlanPayload<TDate>[];
  /** The run every agreement was judged against, so a page can say what it compared to. */
  readonly measuredAt?: TDate;
  /**
   * The four value figures over every plan, which is the level they mean anything at.
   *
   * Not per plan: a plan is a period, and an estate's opportunity is not divisible into fortnights.
   * Absent on an install with no advisories, which is where three of the four figures come from.
   */
  readonly value?: ValueReportPayload<TDate>;
  /** The shortest outcome, definition of done or reason the server accepts, so a form can say so. */
  readonly minProse: number;
}

/** An advisor's money, with what it is over and what it assumes. Never summed across advisors. */
export interface ValueMoneyPayload {
  readonly advisor: AdvisorPayload;
  readonly low: number;
  readonly high: number;
  readonly currency: string;
  readonly region?: string;
  /** How many resources the range is over. The count the money means, where `actions` is not. */
  readonly resources: number;
  /** How many pieces of work sit on those resources. More than `resources` where a job has two. */
  readonly actions?: number;
  readonly assumptions: readonly string[];
}

/** One measure summed over the actions carrying it, as two readings. */
export interface ValueMeasuredPayload {
  readonly advisor: AdvisorPayload;
  readonly label: string;
  readonly unit: AdviceEvidencePayload['unit'];
  readonly before: number;
  readonly after: number;
  readonly measurements: number;
}

/**
 * The four figures ADR 0083 defines, side by side and never added together.
 *
 * Posture is the assessment's, restated. Opportunity is what the advisors say is available. Committed
 * value is what people accepted by raising work against it. Realised value is a measure read twice.
 * No figure here moves a WAF score and no score enters the other three.
 */
export interface ValueReportPayload<TDate = string> {
  readonly posture?: {
    readonly runId: string;
    readonly at: TDate;
    readonly overall?: number;
    readonly scoredControls: number;
    readonly totalControls: number;
    readonly unmeasured: number;
  };
  readonly opportunity: readonly ValueMoneyPayload[];
  readonly committed: readonly ValueMoneyPayload[];
  readonly realised: readonly ValueMeasuredPayload[];
  /**
   * Actions whose finding the latest advisory no longer reports, and the resources under them.
   *
   * A count rather than a figure, and the reason is the apparatus: an advisor computes its evidence
   * inside the condition that fires, so the run that shows the work landed carries no reading of what
   * it fired on. These are the ones that worked and they add nothing to `realised`.
   */
  readonly cleared: { readonly actions: number; readonly resources: number };
  /** Every advice-raised action by what the estate says now, so no total is only its successes. */
  readonly outcomes: Readonly<Record<AgreementPayload, number>>;
}

/** One plan with its actions, which is what the plan's own page reads. */
export interface ImprovementPlanDetailPayload<TDate = string> {
  readonly plan: ImprovementPlanPayload<TDate>;
  readonly actions: readonly ImprovementActionPayload<TDate>[];
  readonly durable: boolean;
  readonly durabilityNote?: string;
  readonly measuredAt?: TDate;
  readonly minProse: number;
}

/**
 * Every file this plan can be exported as, with what each should hash to, and what has already left.
 *
 * The plan's counterpart to `RunExportsPayload`, and the shapes under it are the same ones — a file
 * is a file. What differs is the caution a page has to print beside the digests. An assessment export
 * changes when a decision is recorded; a plan export changes when anybody moves an action, which is
 * daily, and also when a new run disagrees with a claim somebody made. So the digests here go stale
 * faster than a run's, and `revision` is carried so a reader holding two exports can tell which is
 * later without hashing either.
 */
export interface PlanExportsPayload<TDate = string> {
  readonly planId: string;
  /**
   * The run these digests were judged against, and when it finished. Absent where none has ever run.
   *
   * Here because it is the first thing a sender needs when a recipient reports that the file they hold
   * does not hash to the published value. Half the reasons for that are the estate rather than the plan
   * — an agreement is measured against the latest run rather than stored — so a panel that could not
   * name the run left the sender unable to tell "somebody moved an action" from "a new scan disagreed
   * with one".
   *
   * What was here before was the plan's `revision`, and it was worse than useless. A plan's revision
   * rises when the plan record is written, which is closing it; moving an action raises the *action's*
   * revision and not the plan's. So two exports a fortnight apart were both labelled revision 0, and a
   * reader holding them would conclude they were the same document. `planExportName` declines to put
   * that number in a filename for exactly this reason, and the panel should not have put it on the page
   * either.
   */
  readonly judgedAgainst?: { readonly run: string; readonly at: TDate };
  readonly variants: readonly ExportVariantPayload[];
  /** What has already been taken from this plan, newest first. Empty when the trail is not bound. */
  readonly taken: readonly ExportRecordPayload<TDate>[];
}

/**
 * The work already raised against one requirement, across every plan.
 *
 * What a findings page asks: this is failing, is somebody on it? Every plan rather than the one being
 * read, because the plan the action is in is rarely the one the reader came from.
 */
export interface ActionsForControlPayload<TDate = string> {
  readonly actions: readonly ImprovementActionPayload<TDate>[];
  readonly durable: boolean;
  readonly durabilityNote?: string;
  readonly measuredAt?: TDate;
  readonly minProse: number;
}

/**
 * Every action currently raised, so a page that lists many requirements can ask once.
 *
 * The same fields as the per-requirement read: each action already names the controls it belongs
 * to, and the caller groups. A second shape would be two answers about one board.
 */
export type ActionsRaisedPayload<TDate = string> = ActionsForControlPayload<TDate>;

/** How one requirement in a validation is answered. From the catalogue, never from the request. */
export type AttemptMethodPayload = 'measured' | 'attested';

export interface AttemptCheckPayload {
  readonly controlId: string;
  readonly method: AttemptMethodPayload;
  /** The requirement's title, where this framework still has it. */
  readonly title?: string;
}

export type AttemptResultPayload = 'passed' | 'failed' | 'incomplete';

export interface AttemptAnswerPayload<TDate = string> {
  readonly result: AttemptResultPayload;
  /** The run that answered it. Absent where nothing measured it — a claim withdrawn while waiting. */
  readonly scanId?: string;
  readonly at: TDate;
  readonly unmet: readonly string[];
  readonly unreadable: readonly string[];
  /** Why it could not be finished, in the app's words. Absent on a pass or a fail. */
  readonly why?: string;
}

/**
 * One attempt to validate a claim that work was done.
 *
 * Every attempt is on the wire, including the ones that failed: an action verified at the fourth
 * attempt is a different story from one verified at the first, and a surface that showed only the last
 * would tell the second story about the first case.
 */
export interface ValidationAttemptPayload<TDate = string> {
  readonly id: string;
  readonly planId: string;
  readonly actionId: string;
  readonly checks: readonly AttemptCheckPayload[];
  /** When the owner said the work was done. Every date here is measured against this one. */
  readonly claimedAt: TDate;
  readonly requestedBy: string;
  readonly requestedAt: TDate;
  /** The earliest run that may answer this, and how many days that is from the request. */
  readonly observeFrom: TDate;
  readonly observeDays: number;
  /** Absent means outstanding: nothing has answered it yet. */
  readonly answer?: AttemptAnswerPayload<TDate>;
}

/** Every attempt against one action, newest first, with what the caller may do next. */
export interface ValidationsPayload<TDate = string> {
  readonly actionId: string;
  readonly attempts: readonly ValidationAttemptPayload<TDate>[];
  /**
   * Whether a validation may be asked for now, and why not where it may not.
   *
   * On the wire rather than derived in the browser, for the reason the moves on an action are: the
   * answer depends on the action's state and on whether one is already outstanding, and a second copy
   * of that rule in the client is a button that offers something the server refuses.
   */
  readonly mayRequest: boolean;
  readonly whyNot?: string;
  /** The longest window the server will accept, so the form does not carry a second copy of it. */
  readonly maxObserveDays: number;
  readonly durable: boolean;
  readonly durabilityNote?: string;
}

/** Where an acceptance stands, computed on the server against its dates. */
export type RiskStandingPayload = 'pending' | 'active' | 'expiring' | 'expired' | 'revoked' | 'superseded';

export interface RevocationPayload<TDate = string> {
  readonly by: string;
  readonly at: TDate;
  readonly reason: string;
}

/**
 * One requirement somebody decided not to meet, on purpose, for a while.
 *
 * The compensating control and the residual risk are on the wire beside the reason, because the three
 * of them are one sentence: this is not met, this is holding the line instead, and this is what is
 * left. A payload with the reason alone is the record this one exists to replace.
 */
export interface AcceptedRiskPayload<TDate = string> {
  readonly id: string;
  readonly controlId: string;
  readonly reason: string;
  readonly compensatingControl: string;
  readonly residual: Severity;
  readonly owner: string;
  readonly effectiveFrom: TDate;
  readonly expiresAt: TDate;
  readonly recordedBy: string;
  readonly recordedAt: TDate;
  readonly supersedes?: string;
  readonly revoked?: RevocationPayload<TDate>;
  /**
   * Where it stands, computed on the server for the reason a decision's standing is: whether an
   * acceptance has expired is a comparison against a clock, and the browser's is not the one the queue
   * was built from.
   */
  readonly standing: RiskStandingPayload;
  /**
   * Whether this one is taking the requirement off the work queue right now.
   *
   * A flag rather than a rule the client applies to `standing`, so which standings park a finding is
   * stated once. A second copy in the browser is a count that disagrees with the queue beside it.
   */
  readonly effective: boolean;
  /** The requirement, so a page of acceptances need not join against the catalogue. */
  readonly title?: string;
  readonly pillarId?: string;
  readonly severity?: Severity;
}

export interface RisksPayload<TDate = string> {
  readonly risks: readonly AcceptedRiskPayload<TDate>[];
  /** Present where the list is the history of one requirement rather than everything recorded. */
  readonly controlId?: string;
  readonly durable: boolean;
  readonly durabilityNote?: string;
  /**
   * How long a requirement of each severity may be accepted for at a time, as the server enforces it.
   *
   * Sent for the reason `parkDays` is: the form refuses an expiry the server would refuse, without a
   * second copy of the table that can drift from the one doing the refusing.
   */
  readonly acceptanceDays: Readonly<Record<Severity, number>>;
}

/** What a note can be about. The three places a reader forms an opinion, and no free-form fourth. */
export type NoteSubjectKindPayload = 'run' | 'pillar' | 'control';

export interface NoteSubjectPayload {
  readonly kind: NoteSubjectKindPayload;
  readonly id: string;
}

/**
 * One note, as it is read.
 *
 * No field for whether it has been corrected. The correction names the note it corrects and the client
 * threads them, which keeps one fact in one place — a `correctedBy` here would be the same
 * relationship written twice, and the copy is the one that goes stale.
 */
export interface NotePayload<TDate = string> {
  readonly id: string;
  readonly subject: NoteSubjectPayload;
  /** The run the writer was reading. Absent on a note about a run, where the subject is the run. */
  readonly observedIn?: string;
  /** The note this one corrects. The corrected note is kept and stays readable. */
  readonly corrects?: string;
  readonly body: string;
  readonly by: string;
  readonly at: TDate;
}

export interface NoteThreadPayload<TDate = string> {
  readonly subject: NoteSubjectPayload;
  /** Oldest first, because a correction makes no sense above the note it corrects. */
  readonly notes: readonly NotePayload<TDate>[];
  readonly durable: boolean;
  readonly durabilityNote?: string;
  /** The floors the server enforces, so the form does not carry a second copy of them. */
  readonly minNote: number;
  readonly maxNote: number;
}

/** How many notes each subject of one kind carries, so a list can show which have been written about. */
export interface NoteCountsPayload {
  readonly counts: Readonly<Record<string, number>>;
  readonly durable: boolean;
  readonly durabilityNote?: string;
}

/**
 * Every thread of one kind, so a page that lists many subjects can ask once.
 *
 * Empty threads are omitted: a count of zero is what `/api/notes/:kind` is for, and repeating an
 * empty thread per requirement is the payload this collection exists to stop sending.
 */
export interface NoteThreadsPayload<TDate = string> {
  readonly kind: NoteSubjectKindPayload;
  readonly threads: readonly NoteThreadPayload<TDate>[];
  readonly durable: boolean;
  readonly durabilityNote?: string;
  readonly minNote: number;
  readonly maxNote: number;
}

/** Confirm-current, or an attributed skip. Never "reviewed" for a skip. */
export type PillarReviewKindPayload = 'confirmed' | 'skipped';

export interface PillarReviewPayload<TDate = string> {
  readonly id: string;
  readonly reviewId: string;
  readonly runId: string;
  readonly pillarId: string;
  readonly kind: PillarReviewKindPayload;
  /** Present on a confirm. Absent on a skip — a skipped pillar cites nothing. */
  readonly attestationIds?: readonly string[];
  /** Present on a skip: every manual control that decision leaves unaccepted. */
  readonly unresolvedControlIds?: readonly string[];
  readonly by: string;
  readonly at: TDate;
}

/**
 * A requirement answered from inside the review, joined to the pillar it was answered under.
 *
 * The answer itself is an attestation like any other and is read from the attestation surfaces;
 * this is the join, and it carries no statement text for that reason.
 */
export interface ReviewAnswerPayload<TDate = string> {
  readonly id: string;
  readonly pillarId: string;
  readonly controlId: string;
  readonly attestationId: string;
  readonly by: string;
  readonly at: TDate;
}

export interface AssessmentReviewPayload<TDate = string> {
  readonly id: string;
  readonly runId: string;
  readonly openedBy: string;
  readonly openedAt: TDate;
  /** The saved assessment this review can publish. Absent for an ad-hoc run. */
  readonly definitionId?: string;
  /** Exact run scope. Absent only for legacy full-catalogue reviews. */
  readonly selectedPillars?: readonly string[];
  readonly pillars: readonly PillarReviewPayload<TDate>[];
  /** Answers this review produced, oldest first. Empty until somebody answers one. */
  readonly answers: readonly ReviewAnswerPayload<TDate>[];
  readonly result?: AssessmentResultPayload<TDate>;
  readonly durable: boolean;
  readonly durabilityNote?: string;
}

export interface AssessmentResultPayload<TDate = string> {
  readonly id: string;
  readonly reviewId: string;
  readonly runId: string;
  readonly finalisedBy: string;
  readonly finalisedAt: TDate;
  readonly pillars: readonly PillarReviewPayload<TDate>[];
  readonly attestationIds: readonly string[];
  /**
   * The immutable customer result. Absent on legacy review results, which remain readable records
   * of a review but are not a score this build can publish or put on the State of the Nation.
   */
  readonly finalAssessment?: FinalAssessmentPayload<TDate>;
}

export interface FinalAssessmentFindingPayload<TDate = string> {
  readonly id: string;
  readonly finding: FindingPayload<TDate>;
  readonly evidenceIds: readonly string[];
  readonly confidence: ConfidencePayload;
}

export interface FinalAssessmentPillarScorePayload {
  readonly pillarId: string;
  readonly score?: number;
  readonly range?: ScoreRangePayload;
  readonly counts: Readonly<Record<Outcome, number>>;
  readonly scored: number;
  readonly unmeasurable: number;
  readonly unmeasuredBy: Readonly<Record<Unmeasured, number>>;
  readonly composition: CompositionPayload;
  readonly notApplicable: number;
  readonly total: number;
}

export interface FinalAssessmentScorePayload {
  readonly overall?: number;
  readonly range?: ScoreRangePayload;
  readonly pillars: readonly FinalAssessmentPillarScorePayload[];
  readonly counts: Readonly<Record<Outcome, number>>;
  readonly scoredControls: number;
  readonly composition: CompositionPayload;
  readonly totalControls: number;
  readonly exposure?: ExposurePayload;
}

export type FinalAssessmentPublicationReasonPayload =
  | 'legacy-result'
  | 'unsupported-schema'
  | 'incomplete-contract'
  | 'methodology-not-released'
  | 'pillar-set-incomplete'
  | 'scope-mismatch'
  | 'evidence-manifest-mismatch'
  | 'disclosure-mismatch'
  | 'publication-mismatch';

/** The Version 2 result body as a customer may read it. */
export interface FinalAssessmentPayload<TDate = string> {
  readonly schemaVersion: 2;
  readonly definition: { readonly id: string; readonly version: number; readonly fingerprint: string };
  readonly versions: {
    /** The customer release identity. Catalogue and scoring fingerprints below remain technical provenance. */
    readonly methodology: PublicMethodologyIdentityPayload;
    readonly catalogue: { readonly revision: string; readonly fingerprint: string };
    readonly scoring: string;
  };
  readonly executionMode: ExecutionMode;
  readonly automatedEvidence: {
    readonly runDigest: string;
    readonly findingIds: readonly string[];
    readonly evidenceIds: readonly string[];
  };
  readonly humanEvidence: readonly {
    readonly attestationId: string;
    readonly pillarId: string;
    readonly controlId: string;
    readonly selection: 'reused' | 'refreshed';
  }[];
  readonly decisions: readonly {
    readonly decisionId: string;
    readonly pillarId: string;
    readonly kind: PillarReviewKindPayload;
    readonly unresolvedControlIds: readonly string[];
  }[];
  readonly outcome: {
    readonly findings: readonly FinalAssessmentFindingPayload<TDate>[];
    readonly score: FinalAssessmentScorePayload;
    readonly coverage: { readonly answered: number; readonly total: number };
  };
  readonly disclosure: {
    readonly reusedAttestationIds: readonly string[];
    readonly refreshedAttestationIds: readonly string[];
    readonly skippedPillarIds: readonly string[];
    readonly unresolvedControlIds: readonly string[];
    readonly unmeasuredControlIds: readonly string[];
    readonly counts: {
      readonly reused: number;
      readonly refreshed: number;
      readonly skipped: number;
      readonly unresolved: number;
      readonly unmeasured: number;
    };
  };
  readonly publication: {
    readonly eligible: boolean;
    readonly reasons: readonly FinalAssessmentPublicationReasonPayload[];
  };
}

/**
 * Where a run stands with the person who has to review it, for the surfaces that show its score.
 *
 * The score a reader sees first is the automated half. This says whether anybody has been over the
 * other half, and what their record was made of — so a score can be shown as reviewed or not without
 * the page inferring either from the presence of a run. `43c`, `GAP-033`.
 *
 * Absent on a scan payload when this install keeps no reviews, which is not the same as a run nobody
 * has reviewed: an install with nowhere to keep the record cannot tell the two apart, and reporting
 * `finalised: false` there would say a person had not done something this app cannot see.
 */
export interface FinalisationPayload<TDate = string> {
  /** The exact review of this run. Present before and after finalisation. */
  readonly reviewId: string;
  /** The immutable customer result joined to this raw run, once the review is final. */
  readonly resultId?: string;
  /** True only when every pillar the catalogue names has a confirm or a skip against this run. */
  readonly finalised: boolean;
  /** Pillars with a record, of the pillars the catalogue names. Both, so a reader is told the fraction. */
  readonly recorded: number;
  readonly expected: number;
  /** Pillars whose answers somebody confirmed still stand. */
  readonly confirmed: number;
  /**
   * The pillars somebody skipped, by id, rather than a count of them.
   *
   * Named because the disclosure has to say which parts of the score nobody reviewed, and a number
   * cannot. A skipped pillar was not reviewed and its requirements were not answered.
   */
  readonly skipped: readonly string[];
  /**
   * How many attestations the confirmed pillars cited, which is what the review put its name to.
   *
   * The run's own ids, copied at confirm time. Not a count of answers current in the attestation
   * store today, and not a claim that these still are.
   */
  readonly cited: number;
  /**
   * How many answers this review itself produced, counted by attestation.
   *
   * Answers given through the review's own action, not answers that happen to have been written
   * while it was open. The distinction is the whole of row `60`: a count of the second would
   * include everything anybody in the estate answered in that window, which on a review left open
   * over a weekend counts the weekend.
   *
   * Zero on every review finalised before that action existed, and zero is what those reviews did
   * produce — the action was not there to use. It is not a claim about how much work the reviewer
   * did: an answer given from the questionnaire, in a separate tab, during the same review, is
   * invisible here by design, because nothing joins it to the review.
   */
  readonly refreshed: number;
  readonly finalisedAt?: TDate;
  readonly finalisedBy?: string;
}

export interface OpenReviewsPayload<TDate = string> {
  /** Whether the server completed the review-store read. */
  readonly eligibility: import('./eligibility.js').GateEligibilityPayload;
  readonly reviews: readonly AssessmentReviewPayload<TDate>[];
  readonly durable: boolean;
  readonly durabilityNote?: string;
}

export interface CurrentResultPayload<TDate = string> {
  /** Eligible only when `result` is the readable immutable current result. */
  readonly eligibility: import('./eligibility.js').GateEligibilityPayload;
  readonly result?: AssessmentResultPayload<TDate>;
  readonly durable: boolean;
  readonly durabilityNote?: string;
}

/** Customer result history. Raw runs have their own `/api/scans` record and never appear here unfinished. */
export interface FinalResultHistoryPayload<TDate = string> {
  /** Whether the server completed the result-history read. */
  readonly eligibility: import('./eligibility.js').GateEligibilityPayload;
  readonly durable: boolean;
  readonly durabilityNote?: string;
  readonly results: readonly ScanSummaryPayload<TDate>[];
}

/**
 * What a customer declared they serve, on the wire.
 *
 * The definition travels whole rather than summarised, because the readiness outcome beside it is a
 * reading *of this*: a page that showed eight dimensions and a sentence saying a declaration exists
 * would leave a reader unable to answer the first question they have, which is what counts as serving
 * data here. The fingerprint travels for the same reason — two readings can then say whether they were
 * taken of the same declaration, and a reader comparing months can tell a changed estate from a
 * changed definition.
 */
export interface ServingDeclarationPayload<TDate = string> {
  /** The assessment this declaration belongs to. Absent only for the legacy unscoped assessment. */
  readonly definitionId?: string;
  readonly version: number;
  readonly declaredAt: TDate;
  readonly declaredBy: string;
  readonly fingerprint: string;
  readonly named: readonly { readonly catalog: string; readonly schema: string; readonly table: string }[];
  readonly tagged: readonly {
    readonly key: string;
    /** Absent means any value of the key counts. An empty list is refused, so it never arrives. */
    readonly values?: readonly string[];
    readonly at: readonly ('catalog' | 'schema' | 'table')[];
  }[];
  readonly requiredTagKeys: readonly string[];
  readonly requiredMetadata: readonly string[];
  readonly policy: readonly { readonly classification: string; readonly requires: readonly string[] }[];
}

/** One readiness dimension, with the population its share is a share of. */
export interface ReadinessDimensionPayload {
  readonly id: string;
  readonly version: number;
  /** The customer question this reading belongs to. Kept separate rather than rolled up. */
  readonly area: 'governance' | 'metadata' | 'semantics' | 'freshness' | 'performance';
  readonly label: string;
  /** What the dimension is asking, in the reader's terms. Written server-side, never composed here. */
  readonly asks: string;
  /** The statement ids this reading uses. Never inferred from a successful or failed result. */
  readonly sources: readonly string[];
  readonly standing: 'ready' | 'partial' | 'short' | 'unmeasured';
  readonly bands: { readonly ready: number; readonly partial: number };
  readonly denominator: {
    readonly of: string;
    readonly count: number;
    readonly excluded: number;
    readonly excludedBecause: string;
  };
  readonly met: number;
  readonly short: number;
  readonly unmeasured: number;
  readonly share: number | null;
  readonly because?: string;
  readonly shortfall: readonly string[];
}

/**
 * Whether the declared serving data is ready to be served, dimension by dimension.
 *
 * Eight readings and no total. There is no score field on this payload and adding one would be the
 * thing the module it comes from refuses: the eight are shares of eight different populations, each
 * named in its own `denominator`, and a number that added them would have no property except that
 * somebody computed it.
 */
export interface FoundationReadinessPayload<TDate = string> {
  readonly declaration: ServingDeclarationPayload<TDate> | null;
  readonly population: {
    readonly assets: number;
    readonly missing: number;
    readonly truncated: boolean;
    readonly undeclared: boolean;
  };
  readonly dimensions: readonly ReadinessDimensionPayload[];
  /** What a reader would expect and will not find, with what settled it. Never empty. */
  readonly absent: readonly { readonly what: string; readonly because: string; readonly measured: string }[];
  /**
   * A statement whose answer cannot be read from, and what happened. Empty where all three can be.
   *
   * Two ways in, and the field says which, because a reader's next move differs: `failed` is a
   * statement that rejected, which is usually a grant; `capped` is one that answered and stopped at its
   * row ceiling, which is a population too large for the ceiling and nothing to fix in the workspace.
   */
  readonly unread: readonly {
    readonly statement: string;
    readonly kind: 'failed' | 'capped';
    readonly because: string;
  }[];
  /** Absent where the read ran. Present where it could not be attempted at all, with the reason. */
  readonly unavailable?: string;
  readonly durable: boolean;
  readonly durabilityNote?: string;
}

/** What a sweep did, which is the only record of it besides the audit event. */
export interface SweepPayload {
  readonly at: string;
  readonly by: string;
  readonly removed: number;
  readonly removals: readonly {
    readonly table: string;
    readonly retentionClass: RetentionClassName;
    readonly removed: number;
    readonly before: string;
  }[];
  /** Classes a hold kept whole, so the result says what it did not do as well as what it did. */
  readonly held: readonly {
    readonly retentionClass: RetentionClassName;
    readonly holds: readonly string[];
  }[];
  /** Where the audit chain now begins, when the sweep trimmed it. */
  readonly auditFloor?: number;
}

/**
 * An error the API returned with an explanation, as opposed to a transport failure.
 *
 * Two shapes arrive under this type. A running app sends `message`. An app that could
 * not start at all sends `kind`, `summary` and `action` from the startup-degradation
 * server, which is answering a different question — not "this request failed" but "this
 * installation is not configured, and here is what to change". The client shows whichever
 * it got, which is why both are optional rather than split into two types it would have
 * to discriminate before it could display anything.
 */
export interface ApiErrorPayload {
  readonly error: string;
  /** The same server-owned gate returned by previews and successful result reads. */
  readonly eligibility?: import('./eligibility.js').GateEligibilityPayload;
  readonly message?: string;
  readonly kind?: 'no-warehouse' | 'permission' | 'app-incomplete' | 'unknown';
  readonly summary?: string;
  readonly action?: string;
  readonly detail?: string;
}
