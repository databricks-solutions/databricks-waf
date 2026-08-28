// Whether the unattended assessment is working, above the history it is supposed to be filling.
//
// Here rather than on the overview, and the placement is the argument. The history below is where a
// reader forms the belief this panel exists to correct: a table whose newest row is three weeks old reads
// as an estate that has not changed, and there is nothing else on the page to say the reason is that
// nothing has run. Putting the cadence anywhere else leaves the misreading where it happens.
//
// # A status strip, because it shares a page with a table that takes the slack
//
// The first version was a full panel — badge, cadence, next run, paragraph, identity, four run rows with
// their messages — and driven at 1280x900 it measured 558px in a 772px column and squeezed the scan
// history to 94px. It happened because this status strip was written as if it were the page.
//
// Moving the run history behind a disclosure did not fix it, it hid it: closed the panel measured 286px,
// and one click on `Recent runs of the job` took it to 584px, left the table 13px, and made the document
// scroll. The job's runs are now a view of the table itself — see `RUNS_VIEWS` — which is where a list
// that pages and fits already lives.
//
// So what is left here is two lines, a paragraph, and the newest failure when there is one. Everything a
// reader only wants when something is wrong is behind one disclosure, and the runs are one click away in
// the table rather than inside this panel.

import { CalendarClock, CheckCircle2, CircleHelp, PauseCircle, XCircle } from 'lucide-react';
import { Link } from 'react-router';
import { Alert, AlertDescription, AlertTitle, Spinner } from '@databricks/appkit-ui/react';
import { useTestSchedule, type Loadable } from '../api/hooks';
import type { Schedule, ScheduleRun } from '../api/types';
import {
  jobSentence,
  retryCover,
  explain,
  health,
  HEALTH_LABEL,
  nextSentence,
  TRIGGER_EXPLANATION,
  TRIGGER_LABEL,
  WHY_A_SCHEDULE,
  WHY_NOT_A_SCAN,
  type Health,
} from '../pages/schedule-language';
import { Badge, type Tone } from './ui/StatusBadge';
import { Disclosure } from './ui/Disclosure';
import { Surface } from './system';

/**
 * The panel's own standing, which is a different claim from any single run's outcome.
 *
 * The first version reused the run badges here, and rendered five identical red pills down the panel
 * whose top one meant something the four below it did not. `PauseCircle` and `Loader` are the same icons a
 * run uses, so the distinction is carried by the label — "Failing" against "Failed" — and by this badge
 * being the only one on its line, beside the cadence rather than in a list.
 */
const HEALTH_PRESENTATION: Readonly<Record<Health, { readonly tone: Tone; readonly Icon: typeof CheckCircle2 }>> = {
  working: { tone: 'success', Icon: CheckCircle2 },
  // Warning rather than danger: a paused schedule is a decision somebody may have made on purpose, and a
  // red badge on a deliberate choice trains a reader to ignore the colour.
  stopped: { tone: 'warning', Icon: PauseCircle },
  failing: { tone: 'danger', Icon: XCircle },
  unknown: { tone: 'neutral', Icon: CircleHelp },
};

/**
 * @param schedule Read by the page rather than here, and passed in.
 *
 * Not a `useSchedule()` of its own, which is what this did first. The runs table on the same page needs
 * the same answer, so two components each called the hook and the page made two requests to the Jobs API
 * — 1.5 to 2.5s each — for one fact. That is slow, and worse than slow: they are separate states, so a
 * failure on one and a success on the other put a panel saying the schedule is running above a table
 * saying its runs cannot be read. One read, one answer, one thing for them to agree about.
 *
 * @param assessesAsName What the assessing identity calls itself, where the page could tell. Also from
 * the page, and for the same reason: the answer is in the scan history, which the page has and this does
 * not. The job definition names that identity by application id and nothing in the Jobs API resolves it.
 */
export function SchedulePanel({
  schedule,
  assessesAsName,
}: {
  readonly schedule: Loadable<Schedule>;
  readonly assessesAsName?: string;
}) {
  const trigger = useTestSchedule(schedule.reload);

  // A line of the same height rather than nothing while it is read. Returning null and then appearing
  // shoves the table down two seconds into every visit — the Jobs API takes 1.5 to 2.5s — and a page that
  // rearranges itself after the reader has started reading is worse than one that says it is not ready.
  if (schedule.loading || schedule.data == null) {
    return (
      <Surface tone="raised" title="Scheduled assessment">
        <div className="flex items-center gap-2 text-wa-text-secondary">
          <Spinner className="h-3.5 w-3.5" />
          <span className="wa-body-compact">Reading the scheduled job</span>
        </div>
      </Surface>
    );
  }

  return <Panel schedule={schedule.data} trigger={trigger} now={new Date()} assessesAsName={assessesAsName} />;
}

function Panel({
  schedule,
  trigger,
  now,
  assessesAsName,
}: {
  readonly schedule: Schedule;
  readonly trigger: ReturnType<typeof useTestSchedule>;
  readonly now: Date;
  readonly assessesAsName?: string;
}) {
  const standing = health(schedule);
  const { tone, Icon } = HEALTH_PRESENTATION[standing];
  const next = nextSentence(schedule, now);
  // One paragraph rather than two, to hold the disclosure's measured paragraph budget. The join is in
  // `schedule-language.ts` with the sentences it joins, and tested there.
  const aboutTheJob = jobSentence(schedule, assessesAsName);
  // The failure a reader is being sent to, said here rather than left to the table. Only when the panel
  // says failing, so a schedule that is working does not carry the last thing that went wrong.
  const failure = standing === 'failing' ? schedule.runs.find((run) => run.state === 'failed') : undefined;

  return (
    <Surface
      tone="raised"
      title="Scheduled assessment"
      action={
        schedule.triggerable ? (
          /*
           * The app's own button class rather than AppKit's `Button`, and the reason is the focus
           * ring. This was the one bare vendor button left in the app, and it was the app's only
           * 2.4.7 failure: AppKit indicates focus by recolouring its border and suppresses the
           * outline to do it, so a keyboard user tabbing onto it saw nothing that the check —
           * which reads `outlineWidth` — could find either. `.wa-select` is the same fault fixed
           * the other way, restoring the outline over the vendor styles, because a select has no
           * app-native equivalent. A button does.
           */
          <button
            type="button"
            className="wa-button-secondary shrink-0"
            onClick={trigger.test}
            disabled={trigger.working}
            title={TRIGGER_EXPLANATION}
          >
            {trigger.working ? <Spinner className="h-3.5 w-3.5" /> : <CalendarClock className="h-3.5 w-3.5" />}
            {TRIGGER_LABEL}
          </button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-2">
        {/* The standing, the cadence and the next run on one line, because they are one answer. Wrapping
            rather than truncating: the cadence and the due date are both sentences, and a clipped one is
            a fact the reader has to guess at. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge tone={tone} Icon={Icon}>
            {HEALTH_LABEL[standing]}
          </Badge>
          {schedule.cadence != null && <span className="wa-body-compact text-wa-text">{schedule.cadence}</span>}
          {next != null && <span className="wa-body-compact text-wa-text-secondary">{next}</span>}
        </div>

        <p className="wa-body-compact max-w-prose text-wa-text-secondary">{explain(schedule)}</p>

        {failure != null && <Failure run={failure} cover={retryCover(schedule, failure)} />}

        {/* After the panel's own answer rather than in the middle of it. The first version put these
            between the identity and the run list, which displaced everything under them by 88px the
            moment a reader pressed the button. */}
        {trigger.error != null && (
          <Alert variant="destructive">
            <AlertTitle>The schedule was not started</AlertTitle>
            <AlertDescription>{trigger.error}</AlertDescription>
          </Alert>
        )}

        {trigger.started && (
          <Alert>
            <AlertTitle>Started</AlertTitle>
            <AlertDescription>
              The job was asked to run and is starting its compute, which takes a couple of minutes before anything
              reads the estate. It appears in the table&rsquo;s Job runs view as it goes, and the scan it produces joins
              the Scans view when it finishes.
            </AlertDescription>
          </Alert>
        )}

        {/* Three paragraphs, and the count is a budget rather than an accident. This had a fourth — that
            job runs and scans are different lists — and it said what the table's own `Why some of these
            produced no scan` disclosure says, one panel below, where a reader looking at those rows will
            actually meet it. Four paragraphs took the panel to 472px on a click and put the runs table
            back under its three-row floor, which is the defect this row has already fixed twice.

            Opening the disclosure may extend the document, but it may not obscure or reorder the runs below.

            So what the job does about a failure joins the identity paragraph rather than opening a fourth.
            It was briefly a fourth, against this comment, and the measurement above is the reason it is
            not: the two belong in one paragraph anyway, which is the one that says how this job is set up
            and who is involved in it. Where there is no identity to name, it becomes the third.

            **The paragraph count is not the whole budget, and joining is not a fix.** The measured quantity
            is height. Joining removes only the gap between two paragraphs — `Disclosure` uses `space-y-1.5`,
            so 6px — while the added sentence is itself around 200 characters, which at `wa-body-compact` in
            a `max-w-prose` column is two or three more wrapped lines, on the order of 47px. So this change
            spends height it has not measured, and the count is held mainly so the earlier measurement still
            describes the shape of the thing. Assume nothing here until `check:viewport` has run against a
            workspace with a completed scan; it is on row 27's verification list and is not done. */}
        <Disclosure summary="What the schedule is, and why testing it is not running a scan">
          <p>{WHY_A_SCHEDULE}</p>
          <p>{WHY_NOT_A_SCAN}</p>
          {aboutTheJob != null && <p>{aboutTheJob}</p>}
        </Disclosure>
      </div>
    </Surface>
  );
}

/**
 * The newest failure, in two lines, with the two ways out of it.
 *
 * Prefers the task's own reason over the platform's message, because only one of them says why. Measured
 * on labs, the message was "Task readiness failed with message: Workload failed, see run output for
 * details" on every failed run, and the reason under it read "Changing an assessment is restricted to
 * members of the admins group, and 5af463d1-… is not one" — a sentence this app wrote, naming the grant
 * to fix. Showing the first and hiding the second sent every reader to the workspace to find out what the
 * app already knew.
 *
 * Clamped to two lines. A refusal that names a group and an identity does not fit in one, and the whole
 * of it is the tooltip for a reader who wants it.
 *
 * Two links because they answer different questions. The table's other view says whether this failure is
 * the first or the fifth in a row, which is what decides how urgent it is; the workspace says which task
 * failed and gives the traceback, which is what a reader needs when the reason is not enough.
 *
 * @param cover Whether the retry policy covered this particular failure, which decides whether the reader
 * is looking for a grant or a fault, and was previously not on the page at all. On the same line as the
 * links rather than its own paragraph, because the panel's height is what the runs table is sized from —
 * and it reads as what it is there, a fact about this failure rather than a policy.
 */
function Failure({ run, cover }: { readonly run: ScheduleRun; readonly cover?: string }) {
  const said = run.reason ?? run.message;

  return (
    <div className="wa-caption max-w-prose text-wa-text">
      <p className={run.reason == null ? 'line-clamp-1' : 'line-clamp-2'} title={said ?? undefined}>
        {said ?? 'The platform did not say why.'}
      </p>
      <p className="flex flex-wrap gap-x-3">
        {cover != null && <span className="text-wa-text-secondary">{cover}</span>}
        {run.url != null && (
          <a href={run.url} target="_blank" rel="noreferrer" className="wa-aside-link">
            Open the run in the workspace
          </a>
        )}
        <Link to="/history?runs=job" className="wa-aside-link">
          See whether it has failed before
        </Link>
      </p>
    </div>
  );
}
