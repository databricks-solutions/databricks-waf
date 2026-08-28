// What the schedule panel says, in one place because most of it is a judgement rather than a label.
//
// The panel answers one question — is the unattended assessment working — and the honest answer has
// five shapes. Getting each to say what a reader should *do* is the whole of the design: "paused" with
// no next step is a status light, and a status light nobody can act on is what this product exists to
// replace.
//
// Here rather than in the component for the reason every other `*-language.ts` gives: a sentence that
// asserts something about the estate is a claim, claims are what get reviewed, and a claim buried in
// JSX is one nobody reads twice.

import type { Schedule, ScheduleRun } from '../api/types';

/** Whether the cadence is holding, as the one word the header shows. */
export type Health = 'working' | 'stopped' | 'failing' | 'unknown';

/**
 * What the panel leads with.
 *
 * `failing` is separate from `stopped` because the reader's next move differs: a stopped schedule needs
 * a decision, a failing one needs a log. Folding them together — "not working" — would send somebody to
 * unpause a schedule that is already running and failing every week.
 */
export function health(schedule: Schedule): Health {
  if (schedule.state === 'unreadable') return 'unknown';
  if (schedule.state !== 'live') return 'stopped';

  // The last run that finished. A run in flight says nothing yet, and treating it as good news would
  // report a schedule as working for as long as its failing run takes to fail.
  const last = schedule.runs.find((run) => run.state !== 'running' && run.state !== 'waiting');
  if (last == null) return 'working';
  return last.state === 'succeeded' ? 'working' : 'failing';
}

/*
 * `working` says only that it is running, not how often.
 *
 * "Running weekly" was here, and the cadence is the job's to set: `readCadence` in `server/schedule/cron.ts`
 * reads daily, weekly and monthly crons, so a customer on a daily trigger read a label the app's own parser
 * contradicts. The cadence has its own sentence, from the cron that parser actually read.
 */
export const HEALTH_LABEL: Readonly<Record<Health, string>> = {
  working: 'Running',
  stopped: 'Not running',
  failing: 'Failing',
  unknown: 'Cannot tell',
};

/**
 * The sentence under the heading: what the state is, and what to do about it.
 *
 * Each of these names an action, because every one of these states has one. The two that read as dead
 * ends — `not-deployed` and `unreadable` — are the ones where a reader is most likely to conclude the
 * product is broken, so they say what is *unaffected* as well.
 *
 * # Two lines, and the reason is a measurement rather than a preference for brevity
 *
 * These were each three or four sentences, which made the schedule dominate the runs the page exists
 * to read. The current copy keeps the state and next action first; durable explanation is disclosed.
 *
 * What went is the *general* half of each — what a schedule is for, why a fresh install ships paused,
 * what a scheduled run proves. All of it is still on the page, in the disclosure directly below, which is
 * what this app uses a disclosure for. What is left is the particular half: this workspace, this state,
 * this next step. See `WHY_A_SCHEDULE`.
 */
export function explain(schedule: Schedule): string {
  switch (schedule.state) {
    case 'not-deployed':
      return 'No scheduled assessment is deployed here, so every run on this page is one somebody started.';

    case 'no-schedule':
      return (
        'The job is deployed with no schedule on it, so it runs only when somebody asks. The bundle ships a ' +
        'weekly one, so this was either removed on purpose or overwritten by a deploy.'
      );

    case 'paused':
      return (
        'The job is deployed and its schedule is paused, so nothing is running unattended. Unpausing it in the ' +
        'workspace starts the cadence.'
      );

    case 'unreadable':
      return schedule.unreadable ?? 'The app could not read its scheduled job, so it cannot say whether one runs.';

    case 'live':
      return liveExplanation(schedule);
  }
}

function liveExplanation(schedule: Schedule): string {
  const failing = health(schedule) === 'failing';

  if (failing) {
    // No direction in it. The first version ended "the other view of the table below", which was read by
    // somebody already on that view — the panel stays put when the table switches, so a sentence that
    // says where to go is wrong half the time. The links under the failure do the pointing instead.
    return 'Its last run did not succeed, so the scan history has stopped moving for a reason that is not the estate.';
  }

  if (schedule.runs.length === 0) {
    return (
      'It has not fired yet, so there is nothing to judge it by. Testing it now is how to find out rather than ' +
      'on the day it matters.'
    );
  }

  return (
    'Its last run succeeded, so the scan history is being kept up to date without anybody doing it — and the ' +
    'identity it runs as could still read the estate as recently as that run.'
  );
}

/**
 * What a schedule is for, which is the half of each state's explanation that is the same every time.
 *
 * In the disclosure rather than in the paragraph above it. Every sentence here was in `explain` and was
 * true, necessary and not what the reader came for, which is this app's own definition of a disclosure.
 */
export const WHY_A_SCHEDULE =
  'The schedule is the optional half of the bundle, and it ships paused: a deploy that started reading the ' +
  'estate on a timer would be a surprise on somebody’s bill. Unpaused, it runs on its own cadence and records ' +
  'each result, which turns this history into a trend rather than a list of the times somebody remembered.';

/**
 * When the next one falls, or why the app will not say.
 *
 * Stated in the schedule's own zone rather than the reader's, which is the same decision `cron.ts` made
 * for the cadence and for the same reason — and getting it wrong here was measured, not theorised. The
 * first version used the reader's locale, so a panel saying "Every Monday at 06:00 UTC" sat directly
 * above "Next run 8/10/2026, 4:00:00 PM" on an Australian screen, and the two read as a contradiction. A
 * reader cannot check a cadence against a next run in a different zone; they can only doubt both.
 */
export function nextSentence(schedule: Schedule, now: Date): string | undefined {
  if (schedule.state !== 'live') return undefined;

  if (schedule.dueAt == null) {
    // Only reachable with a cadence the reader can see and the app would not read. Saying which
    // expression, rather than "unknown", is what lets somebody decide whether they care.
    return schedule.cron != null
      ? `The app cannot read the schedule ${schedule.cron}, so it will not say when the next run falls — it ` +
          'covers daily, weekly and monthly cadences, and would rather say nothing than be a week out.'
      : undefined;
  }

  const due = new Date(schedule.dueAt);
  return `Next run ${inZone(due, schedule.timezone)}, ${away(due, now)}.`;
}

/**
 * A moment in a named zone, with the zone said.
 *
 * No seconds, because a weekly cadence is not accurate to one and showing three digits of precision on a
 * figure that moves by minutes invites a reader to trust it further than it deserves.
 */
export function inZone(when: Date, timezone: string | undefined): string {
  try {
    const shown = new Intl.DateTimeFormat('en-GB', {
      ...(timezone != null ? { timeZone: timezone } : {}),
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(when);

    return timezone != null ? `${shown} ${timezone}` : shown;
  } catch {
    // A zone the browser does not know, which is a string somebody typed into a job. The reader's own
    // rendering is wrong for their purpose but it is not a lie, and it beats an empty line.
    return when.toLocaleString();
  }
}

/**
 * How far off something is, in the largest unit that is still honest.
 *
 * Days and hours only. Minutes on a weekly cadence is precision about the wrong thing, and a reader
 * asking "is this due before the review on Thursday" is answered by "in 3 days".
 */
export function away(when: Date, now: Date): string {
  const ms = when.getTime() - now.getTime();
  if (ms < 0) return 'which has passed';

  // Tested against the elapsed time rather than the rounded hours, because rounding first makes this
  // branch unreachable: half an hour rounds to one, and "in 1 hour" for something thirty minutes away
  // is the kind of small lie that makes a reader stop trusting the rest of the panel.
  if (ms < 3_600_000) return 'within the hour';

  const hours = Math.round(ms / 3_600_000);
  if (hours < 36) return `in ${String(hours)} ${hours === 1 ? 'hour' : 'hours'}`;

  const days = Math.round(hours / 24);
  return `in ${String(days)} days`;
}

/**
 * Whose grants decide what a scheduled run can see.
 *
 * Names the assessing identity where there is one, and it is not the job's run-as. The notebook runs as
 * one identity and calls the app's scan route as another, and the second is the one whose membership
 * decides whether a scan happens at all. Measured on labs, this sentence named the bundle's deployer
 * while every run was being refused for a service principal it never mentioned — which sent a reader
 * looking at the grants of an identity that was not involved.
 *
 * Both, where they differ, because both are true and a reader debugging a refusal needs to know which
 * of the two the refusal was about.
 *
 * `knownAs` names the assessing identity where the caller could work out what it calls itself. The job
 * holds only an application id, and the app cannot look one up — listing service principals needs an
 * entitlement it is not granted. What it can do is recognise the id: a run by that principal recorded
 * its own name, so the history has the answer even though the job definition does not. Absent leaves
 * the id, which is what the reader had before.
 */
export function identitySentence(schedule: Schedule, knownAs?: string): string | undefined {
  const named = knownAs?.trim();
  const assesses =
    schedule.assessesAs != null && named != null && named !== '' && named !== schedule.assessesAs
      ? `${named} (${schedule.assessesAs})`
      : schedule.assessesAs;
  const supervises = schedule.ranAs;

  if (assesses == null) {
    if (supervises == null) return undefined;
    return (
      `Runs as ${supervises}. A scheduled assessment measures what that identity can see, so a finding ` +
      'that reads as unmeasurable here and answers when you run it yourself may be a limit of that ' +
      'identity’s reach rather than of the estate.'
    );
  }

  return (
    `Assesses as ${assesses}, which is the identity whose grants decide what a scheduled run can see and ` +
    'whether it may start one at all — so a finding that reads as unmeasurable here and answers when you run ' +
    `it yourself may be a limit of that identity’s reach rather than of the estate.${supervises == null ? '' : ` The notebook itself runs as ${supervises}.`}`
  );
}

type Retries = NonNullable<NonNullable<Schedule['supervision']>['retries']>;

/**
 * What the job does about a failure: whether it tries again, and who hears about it.
 *
 * The two halves of AUD-DEC-108 the panel used to omit. It showed the schedule and the identity — two of
 * the four things the bundle is authoritative for — while `TRIGGER_EXPLANATION` and `WHY_NOT_A_SCAN` both
 * promised "its retry policy" that no surface named.
 *
 * One sentence rather than two, and it joins the identity paragraph rather than opening a fourth. A fourth
 * paragraph was measured at 472px, which puts the runs table under its three-row floor. They belong together
 * anyway — a reader asking what happens when an unattended run fails is asking one question, and "it retries
 * three times and then emails nobody" is one answer.
 *
 * Joining recovers only the 6px gap between two paragraphs, though, and this sentence's own length costs
 * more than that. `SchedulePanel` has the arithmetic and the caveat: the height is unverified until
 * `check:viewport` runs, so keep this to one sentence and assume it is close to the limit.
 *
 * # Nobody is a finding, not a gap in the panel
 *
 * The case worth writing for is a job that retries and then tells no one, because it is the *quiet*
 * failure: three attempts, a red row in a table nobody opens, and a trend line that stops moving. So an
 * empty recipient list is said rather than omitted, in the words a reader can act on — but only about
 * what was read. See `notifyClause`.
 */
/**
 * How the job is set up and who is involved in it, as the disclosure's one conditional paragraph.
 *
 * Two sentences joined rather than two paragraphs, and the join lives here rather than in the component
 * because it is a decision about prose and because the component has no test: this file's tests are where
 * the four branches — both, either, neither — are held. A `''` from joining nothing becomes undefined, so
 * the panel renders no empty paragraph.
 *
 * The paragraph count is a measured budget. A fourth paragraph took the panel to 472px on a click and put
 * the runs table under its three-row floor, so what the job does about a failure joins the identity rather
 * than opening one.
 */
export function jobSentence(schedule: Schedule, knownAs?: string): string | undefined {
  return (
    [identitySentence(schedule, knownAs), supervisionSentence(schedule), answersSentence(schedule)]
      .filter((said) => said != null)
      .join(' ') || undefined
  );
}

/**
 * Which assessment an unattended run answers to, read from the parameter the job carries it in.
 *
 * `GAP-036` asks for this because a schedule that resolved its target when it fired would change
 * assessment the moment somebody added a definition. What row 55 measured is quieter and worse: the job
 * named none, so every weekly run was recorded outside every assessment. The parameter is the fix and
 * this is the reporting half of it.
 *
 * # What each branch may say, and what it may not
 *
 * Every sentence here restates a field: the id the job carries, the name the store answered with, whether
 * the store answered at all. None of them predicts the next run's outcome. "The next run will answer to X"
 * is the sentence this function deliberately does not write, for the reason `retryCover` above documents at
 * length — the parameter is read from the job now, and a claim about a run that has not happened is a claim
 * about what the platform will do with a job somebody can edit in between.
 *
 * What it may say instead is what the app's own route does with what the job carries, because that is code
 * in this repository and tested: `POST /api/scan/scheduled` refuses a run naming an assessment it cannot
 * find, and refuses one naming an archived assessment. Both are the states behind a job that fails at six
 * every Monday, and neither is visible anywhere else in the product.
 *
 * # Where it renders, and the height it costs
 *
 * The fourth sentence of the disclosure's job paragraph rather than a fourth paragraph, which
 * `SchedulePanel` measured at 472px and which puts the runs table under its three-row floor. The paragraph
 * is now four sentences and the caveat in that file still stands: the height is unverified until
 * `check:viewport` runs against a workspace with a completed scan, so keep these to one sentence each.
 */
export function answersSentence(schedule: Schedule): string | undefined {
  const answers = schedule.answers;

  // Silence, not a sentence, where the app has not read a job at all. A panel reporting "names no
  // assessment" beside "no scheduled assessment is deployed here" would be describing a job that is not
  // there.
  if (schedule.state === 'not-deployed' || schedule.state === 'unreadable') return undefined;

  if (answers == null) {
    return (
      'The job names no assessment, so what a scheduled run records answers to none of them and does not ' +
      'join an assessment’s history.'
    );
  }

  if (answers.unresolved === true) {
    return (
      'The assessment set on the job is an unsubstituted bundle variable, still carrying the bundle’s ' +
      'placeholder rather than an id.'
    );
  }

  const id = answers.id;
  if (id == null) return undefined;

  if (answers.missing === true) {
    return (
      `The job names assessment ${id}, which is not one this install keeps — and a run naming an assessment ` +
      'the app cannot find is refused.'
    );
  }

  if (answers.archived === true) {
    return (
      `The job names ${answers.name ?? id}, an assessment that has been archived — and a run naming an ` +
      'archived one is refused, because a finished run still names it.'
    );
  }

  // The name where the store answered with one, and the id beside it: the id is what the job holds and
  // what a reviewer reading `scheduled-scan.yml` will be looking for.
  return answers.name != null
    ? `The job names the assessment ${answers.name} (${id}), which it carries as a parameter rather than looking one up.`
    : `The job names assessment ${id}, which it carries as a parameter rather than looking one up.`;
}

export function supervisionSentence(schedule: Schedule): string | undefined {
  const supervision = schedule.supervision;
  if (supervision == null) return undefined;

  const retries = retryClause(supervision.retries);
  const notifies = notifyClause(supervision);

  if (retries == null) return notifies;
  if (notifies == null) return retries;
  return `${retries} ${notifies}`;
}

function retryClause(retries: Retries | undefined): string | undefined {
  if (retries == null) return undefined;

  if (retries.times === 0) {
    // A job somebody has edited down to no retries, which is the state behind a single silent failure.
    //
    // "one bad Monday is a week with no assessment in it" was here. It reads the bundle's current cron as
    // a fact about the app, and the app's own parser refuses that: `readCadence` in `server/schedule/cron.ts`
    // covers daily, weekly and monthly cadences precisely because the schedule is the job's to set. A
    // customer on a daily trigger was told they had lost a week.
    return 'The assessment is not retried, so a failure waits for the next scheduled run.';
  }

  const attempts = `${String(retries.times)} ${retries.times === 1 ? 'time' : 'times'}`;
  // "apart" needs two gaps to be apart from each other, and one retry has one gap. The singular reads as
  // a schedule with two waits in it otherwise.
  const wait =
    retries.waitMs == null ? '' : retries.times === 1 ? `, ${waitFor(retries.waitMs)} later` : ` about ${waitFor(retries.waitMs)} apart`;

  /*
   * Both values are said, because they are different promises and the panel used to make only one of
   * them. `true` is worth spelling out because it reads as a duplicate bill and is not one: a retry posts
   * the same idempotency key, so it rejoins the assessment already in flight rather than starting a
   * second one, which is the whole argument for retrying a timeout at all and the argument ADR 0060
   * makes.
   *
   * `false` was silent, and silence here let the sentence above stand unqualified — a reader took "a
   * failed run retries itself 3 times" to cover the run that ran out of time, which under that policy is
   * the one failure that gets no second chance.
   */
  const timeout =
    retries.onTimeout === true
      ? ' An assessment that ran out of time is retried too, and rejoins the scan rather than restarting it.'
      : retries.onTimeout === false
        ? ' An assessment that ran out of time is not retried, so it waits for the next scheduled run.'
        : '';

  return `The assessment retries itself ${attempts}${wait}.${timeout}`;
}

/**
 * Who hears about a failure, said only of what the app read.
 *
 * The narrow wording is the point. Databricks also carries per-task `email_notifications`, webhook
 * notifications to PagerDuty and Slack, and `notification_settings`, none of which this app's port
 * declares — so the earlier "Nobody is emailed when it fails" was an absolute claim from a partial read,
 * and it was flatly wrong for the job most likely to be well run: one wired to an on-call rota and no
 * email address at all. Naming the field keeps the sentence true and still tells a reader with no
 * notifications anywhere the thing they need to know.
 *
 * The same limit applies to what an unsubstituted recipient costs. "Nothing is emailed" survived a round
 * of review here and was two unread claims: that this channel drops the notification, and that no channel
 * the port cannot see picks it up. Both branches now report the substitution and stop.
 */
function notifyClause(supervision: NonNullable<Schedule['supervision']>): string | undefined {
  const notifies = supervision.notifies;

  // Before the empty case, because it is not one: an address is set and the deploy did not resolve it.
  const nobodyElse = notifies == null || notifies.length === 0;

  // Counted from the payload, never from the branch. The round-four version wrote "One further recipient"
  // and "the job's only failure recipient" out of a boolean that meant "one or more", so a job with two
  // unsubstituted addresses was described with a number nothing had read. `unresolved` is a count now and
  // this reads it.
  //
  // The claim is also confined to substitution. Whether an unresolved recipient means the notification is
  // dropped, bounced or refused at deploy is not something this app has observed, and the port sees neither
  // per-task notifications nor webhooks, so "nothing is emailed" was two guesses in three words: about this
  // channel, and about every channel it cannot see.
  const missing = supervision.unresolved ?? 0;
  const one = missing === 1;

  /*
   * Built from two whole clauses rather than five interleaved ternaries, which is how the previous version
   * shipped "is unsubstituted bundle variable" — the article was inside one conditional and the noun inside
   * another, and the branch that lost it is the one this repository's own bundle produces, since
   * `scheduled-scan.yml` sets exactly one failure recipient. Assembling whole clauses makes a missing word a
   * visible gap in a string rather than a path through a nest.
   *
   * No agent, either. The previous wording said the deploy "should have replaced" the variable, and
   * `supervision` in `schedule.ts` records the opposite as the likelier history: a `databricks bundle deploy`
   * resolves `${...}` or fails, so a job carrying a literal template most plausibly never went through one.
   * Naming the deploy sends a reader to look at something that probably did not happen. The state is
   * reported; its cause is not.
   */
  const subject = one ? 'One failure address' : `${String(missing)} failure addresses`;
  const predicate = one ? 'is an unsubstituted bundle variable' : 'are unsubstituted bundle variables';
  const unresolved =
    missing === 0
      ? undefined
      : nobodyElse
        ? `${subject} set on the job ${predicate}, still carrying the bundle's placeholder rather than a name.`
        : `A further ${one ? 'address' : String(missing) + ' addresses'} set on the job ${predicate}, so ` +
          `${one ? 'that recipient is' : 'those recipients are'} not among them.`;

  if (nobodyElse) {
    return (
      unresolved ??
      'No email address is set on the job for failures, so unless something outside it is watching, a ' +
        'schedule that stops working is only visible to whoever opens this page.'
    );
  }

  // Named, not counted. The bundle's default resolves at deploy time to whoever deployed it, so the
  // common defect is not a missing recipient but one who has left the organisation — and a reader can
  // only notice that if they see the address.
  //
  // Capped, because this sits inside a measured height budget and a job wired to a rota of fifteen
  // addresses would spend the runs table's rows on them. Two is enough to recognise the convention.
  const named = notifies.slice(0, 2).join(' and ');
  const rest = notifies.length - 2;
  const sentence =
    rest > 0
      ? `Failures are emailed to ${notifies.slice(0, 2).join(', ')} and ${String(rest)} ${rest === 1 ? 'other' : 'others'}.`
      : `Failures are emailed to ${named}.`;

  // A list that resolved in part is still a deploy that did not, and the reader needs both halves: who does
  // hear, and that somebody who should is missing.
  //
  // Neither form says what to do about it. "Adding an address by hand will be overwritten by the next
  // deploy" was here, and it is a prediction about a tool this app does not run, on a repository it cannot
  // see, for a job it has only read.
  return unresolved == null ? sentence : `${sentence} ${unresolved}`;
}

/**
 * A retry interval in the units it was set in.
 *
 * Minutes above a minute, because a retry is not accurate to a second and "about 2 minutes" is what the
 * reader is deciding with. Seconds below one, because rounding up to a minute overstated a ten-second
 * wait six-fold — in the direction that has somebody wait longer than they need to before looking.
 */
function waitFor(ms: number): string {
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.round(ms / 1_000));
    return `${String(seconds)} ${seconds === 1 ? 'second' : 'seconds'}`;
  }

  const count = Math.round(ms / 60_000);
  return `${String(count)} ${count === 1 ? 'minute' : 'minutes'}`;
}

/**
 * Which step failed, and whether the retry policy above governs it, said beside the failure.
 *
 * A different question from `supervisionSentence`, asked at a different moment. That one describes a
 * policy to somebody auditing the configuration; this one answers the reader in front of a red row, whose
 * next move depends on it: a readiness refusal is a settled permission problem and a grant to fix, and an
 * assessment failure is a fault to read.
 *
 * # This surface has now been wrong twice, in opposite tenses, and that is why it says so little
 *
 * The first version said "Attempt 1 of 4, so it will try again by itself", from `run.attempt`. False on
 * every failure the panel can render: `attempt` tracks the *job* run's `attempt_number`, which moves only
 * under a job-level retry policy this job does not have, and a task retry keeps the same job run id
 * (ADR 0064). On-call read it, waited, and nothing tried again.
 *
 * The second said "This failure is final … so its 3 retries are spent", reasoning that a run still
 * retrying has no result yet so `stateOf` would not call it `failed`. That holds for *task* retries and
 * fails for job-level ones, where the SDK is explicit that a retry is a **new run** — "subsequent runs are
 * created with an `original_attempt_run_id`" — leaving the original attempt terminal and failed while its
 * retry is in flight. `withReason` picks the newest *ended* run, which is exactly that original. So the
 * panel called a failure settled while the table one panel below showed its retry running, and the app
 * could not even detect the condition, because `JobSettings` declares no job-level `max_retries`.
 *
 * The third said the quoted policy "is the one that applied to it". Also unsupportable, and by a route the
 * first two shared: `supervision.retries` is read from `jobs.get`, which answers for the job **now**, while
 * `covered` comes from a run that finished up to ten weekly ticks ago. Nothing in the API connects them —
 * `RunTask` carries `attempt_number` and no retry policy — so the sentence claimed a relationship the app
 * cannot read. Edit `max_retries` to 0 after a failure and the panel would present today's policy as having
 * governed a run it never touched, which in that direction reads a transient as a hard fault.
 *
 * All three were derived claims about what the platform *will do*, *has finished doing*, or *did do*, each
 * built on a premise about retry mechanics that turned out to have a hole. So this no longer derives
 * anything. It names which step failed, and says which step the quoted policy belongs to — both read
 * directly, neither a statement about this run's history. That is the whole of what changes the reader's
 * next action: a readiness failure sends them to a grant, an assessment failure to a traceback.
 *
 * The policy is also not "above", and it is not "that policy" either. It renders inside a `Disclosure`
 * that is collapsed on arrival and sits *below* this line, so a reader meeting this sentence has been
 * shown no retry policy at all — which makes a bare demonstrative as empty as the deixis it replaced. Both
 * branches name the step the policy belongs to instead, because the step is on the page.
 *
 * # Plural where the run was
 *
 * `covered` is a disjunction: true when *any* broken step was the assessment. The fourth round of review
 * caught this rendering it as "the step that failed is the assessment", which is false on a run where two
 * steps broke — a run `schedule.test.ts` constructs, and one where `blamed` used to show the other step's
 * error directly above this line. So `broke` is read alongside it and the sentence is plural when the run
 * was. `blamed` now prefers the assessment too, so the words underneath belong to the step named here.
 *
 * # What is deliberately not said
 *
 * How many times anything ran. `RunTask.attempt_number` looks like where that lives, but the SDK documents
 * the base only for a job run, and a count that is off by one is the same confident wrong number twice
 * removed. Nor "so it ran once" for an uncovered step: `resources/scheduled-scan.yml` records, measured
 * twice on labs, that the platform retries an internal error whatever the policy says.
 *
 * Nor whether the failure is final, per above.
 *
 * Undefined where the app cannot tell, rather than guessed.
 */
export function retryCover(schedule: Schedule, run: ScheduleRun): string | undefined {
  if (schedule.supervision?.retries == null || run.covered == null) return undefined;

  /*
   * Membership where the count is unknown, not identity.
   *
   * `broke` is absent from a server older than the one that added it, and an earlier comment here claimed the
   * singular was the safe fallback because "it claims less". That is backwards. "The step that failed is the
   * assessment" asserts both that one step failed and which; "The assessment is among the steps that failed"
   * asserts membership and is true whether one broke or three. The plural is the weaker sentence, so it is
   * the one to fall back to.
   */
  const several = run.broke == null || run.broke > 1;

  // The common designed-for failure, and the one the first version got most wrong: it promised three more
  // attempts on a step the bundle sets to never retry, because its answer will not change by being asked
  // again.
  if (!run.covered) {
    return several
      ? "No step that failed is one the assessment's retry policy covers."
      : "The step that failed is not one the assessment's retry policy covers.";
  }

  return several
    ? "The assessment is among the steps that failed, and the assessment's retry policy covers it."
    : "The step that failed is the assessment, which the assessment's retry policy covers.";
}

export const RUN_STATE_LABEL: Readonly<Record<ScheduleRun['state'], string>> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  running: 'Running',
  waiting: 'Starting',
  unknown: 'Unclear',
};

/** How a run came about, said only where it is not the schedule doing its job. */
export function triggerCaption(run: ScheduleRun): string | undefined {
  switch (run.trigger) {
    case 'schedule':
      return undefined;
    case 'hand':
      return 'started by hand';
    case 'retry':
      return 'a retry';
    case 'unknown':
      return undefined;
  }
}

/** How long a finished run took, in the units a reader compares by. */
export function took(run: ScheduleRun): string | undefined {
  if (run.durationMs == null) return undefined;

  const seconds = Math.round(run.durationMs / 1000);
  if (seconds < 90) return `took ${String(seconds)}s`;
  return `took ${String(Math.round(seconds / 60))} min`;
}

/**
 * The caption under a run: when, how long, and which attempt.
 *
 * The attempt is only mentioned above one, because "attempt 1" on every row is noise. On this job it is
 * never above one — `attempt` counts job-level retries and the job has no job-level policy — so in practice
 * the caption omits it, and it is kept only for a job that does set one. `ScheduleRunPayload.attempt` has
 * the detail, including the rule that no retry claim may be derived from it.
 */
export function runCaption(run: ScheduleRun, timezone?: string): string {
  const parts = [
    // The schedule's zone, matching the cadence and the next run above it. Three clock formats on one
    // panel was measured: a cadence in UTC, a run in the reader's locale and a refusal in raw ISO, for
    // instants an hour apart. A reader comparing them concludes the panel is wrong about something.
    run.startedAt != null ? inZone(new Date(run.startedAt), timezone) : undefined,
    took(run),
    triggerCaption(run),
    run.attempt != null && run.attempt > 1 ? `attempt ${String(run.attempt)}` : undefined,
  ].filter((part): part is string => part != null);

  return parts.join(' · ');
}

/**
 * A run with its message removed where it repeats the one above it.
 *
 * Measured on the labs job, the first version printed *Task readiness failed with message: Workload
 * failed, see run output for details. This caused all downstream tasks to get skipped.* three times, once
 * per failed run, in three consecutive full-width lines. Three identical sentences do not say a schedule
 * failed three times any more clearly than one does, and they took the panel's whole height to do it.
 *
 * Consecutive rather than global: the same failure four weeks apart with a success between them is a
 * pattern worth seeing twice, where the same failure four times running is one fact.
 *
 * Compares the platform's message, which is what the table shows. The newest failure also carries the
 * app's own reason for it, and that is the panel's to show rather than this column's — a column that
 * mixed the two described four identical refusals three ways.
 */
export function withoutRepeats(runs: readonly ScheduleRun[]): readonly ShownRun[] {
  let previous: string | undefined;

  return runs.map((run) => {
    const repeats = run.message != null && run.message === previous;
    previous = run.message;

    if (!repeats) return run;
    const { message: _dropped, ...rest } = run;
    return { ...rest, repeated: true };
  });
}

/** A run as the panel shows it: its own fields, plus whether its message was dropped as a repeat. */
export type ShownRun = ScheduleRun & { readonly repeated?: boolean };

/** Said in place of a message that repeats, so the row still accounts for itself. */
export const REPEATED = 'the same failure again';

/**
 * The two views of the runs table, and why the job's runs are there rather than in the panel.
 *
 * The first version listed them in a disclosure inside the panel, and driving it measured the cost: the
 * panel went from 286px to 584px on a click and left the scan history 13px of a 597px column.
 *
 * That was the wrong shape rather than a sizing mistake. Both are lists of runs of the same assessment,
 * the page is called Runs, and the bounded table already owns that record role — so the job's
 * runs are a view of it. The panel goes back to being a status strip, and neither list competes with the
 * other for the same pixels.
 */
export const RUNS_VIEWS = { scans: 'Scans', job: 'Job runs' } as const;

export type RunsView = keyof typeof RUNS_VIEWS;

/** What the job-runs view is a list of, as the table's caption for a screen reader. */
export const JOB_RUNS_CAPTION =
  'Runs of the scheduled job, newest first. A run that failed before it reached the app produced no scan.';

/** What the trigger button offers, worded so nobody mistakes it for running a scan. */
export const TRIGGER_LABEL = 'Test the schedule';

/** What the button does, as a tooltip: an imperative, because it describes an action. */
export const TRIGGER_EXPLANATION =
  'Starts the scheduled job now, taking the same path a scheduled run takes: its own compute, its own identity, ' +
  'its retry policy.';

/**
 * Why the button is not the scan button, as prose under a heading that asks that question.
 *
 * Deliberately not the tooltip text. The two have different jobs and the first version used one string
 * for both, which put a subjectless imperative — "Starts the scheduled job now…" — under the heading
 * "Why this is not the same as running a scan", answering a question nobody asked.
 */
export const WHY_NOT_A_SCAN =
  'A scan starts inside the app, on the path that is already fine — it works on an install whose unattended ' +
  'runs have been failing for a month. Testing the schedule starts the job instead, which exercises the parts ' +
  'that fail where nobody is watching: its own compute, the grants of the identity it runs as, its retry policy.';
