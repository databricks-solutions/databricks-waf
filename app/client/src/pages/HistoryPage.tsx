// Scan history: every run, and enough about each to know why it differs from the last.
//
// A history of scores alone is close to useless here, because the score moves for reasons that are
// nothing to do with the estate — a different identity sees a different estate, a targeted rerun
// measures one pillar and carries six forward, a partial run stopped at a budget. So each row carries
// the identity it ran as, what it was asked to measure against what it measured, how long it took and
// what it found.
//
// The schedule panel sits above it, answering the question the table cannot: whether anything is going
// to appear here again. See `components/SchedulePanel.tsx`.
//
// # Two views, because there are two lists of runs and one table
//
// A scan is what the app recorded. A job run is what the scheduled job did, and the two differ exactly
// where it matters: a scheduled run that failed before it reached the app produced no scan at all, so it
// is invisible in the scans view and is the whole reason the schedule panel exists.
//
// Both were tried inside the panel first, as a disclosure. That measured badly enough to be a defect
// rather than a preference — 286px closed, 584px open, the scan history down to 13px of a 597px column.
// The bounded list is this table, so the
// job's runs are a view of it, chosen by the switch in the header and carried in the URL as `?runs=job`
// so it can be linked to.
//
// Paginated at ten rows. The store keeps twenty and a durable one will keep far more, and a table
// that grows without bound is a page whose height depends on how long the app has been installed.
// The comparability note is a disclosure rather than a paragraph above the table: it is important and
// it is the same every time, which is exactly what a disclosure is for.

import { Link, useSearchParams } from 'react-router';
import { Ban, CheckCircle2, CircleDashed, CircleHelp, Loader, XCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle, Spinner } from '@databricks/appkit-ui/react';
import { useNoteCounts, useScanHistory, useSchedule } from '../api/hooks';
import { SchedulePanel } from '../components/SchedulePanel';
import { noteCountPhrase } from './note-language';
import { useAssessment } from '../api/assessment-context';
import { Badge, type Tone } from '../components/ui/StatusBadge';
import { DataTable, type Column } from '../components/ui/DataTable';
import { Disclosure } from '../components/ui/Disclosure';
import type { EmptyStateProps } from '../components/ui/EmptyState';
import { Pagination } from '../components/ui/Pagination';
import { usePaged } from '../components/ui/paging';
import { CustomerPage, Surface } from '../components/system';
import { duration, identity, measured, requestSentence, startedBy, whoRan } from './run-language';
import {
  inZone,
  JOB_RUNS_CAPTION,
  REPEATED,
  RUN_STATE_LABEL,
  RUNS_VIEWS,
  took,
  triggerCaption,
  withoutRepeats,
  type RunsView,
  type ShownRun,
} from './schedule-language';
import type { ScanSummary, Schedule, ScheduleRun } from '../api/types';
import { methodologyLabel } from '../methodology-identity';

/**
 * @param notes How many notes each run carries, so a reader can see which were written about.
 *
 * A count rather than the notes, and in this column rather than one of its own. It is the only cell in
 * the table that is about what people said rather than what the estate did, and a column of mostly
 * blanks would spend width on the runs nobody annotated. The number is what a reader is scanning for:
 * a run somebody explained is the run worth opening.
 */
export function columns(
  pillarTitle: (pillarId: string) => string,
  notes: Readonly<Record<string, number>> | undefined
): readonly Column<ScanSummary>[] {
  return [
    {
      key: 'finishedAt',
      header: 'Finished',
      cell: (scan) => (
        <span className="flex flex-col">
          {/* `wa-row-link`, so the whole run is the target rather than its timestamp. Every other
              cell in the row — posture, results, pillars, identity — is a fact about the run whose
              record the reader wants, and aiming at the date to get there is the layout's job being
              done by the reader. See `.wa-table tbody tr:has(.wa-row-link)`. */}
          <Link to={`/history/${scan.id}`} className="wa-row-link wa-numeric text-wa-text">
            {new Date(scan.finishedAt).toLocaleString()}
          </Link>
          <span className="wa-caption">
            took {duration(scan)}
            {noteCountPhrase(notes, scan.id) != null && ` · ${String(noteCountPhrase(notes, scan.id))}`}
          </span>
        </span>
      ),
    },
    {
      key: 'review',
      header: 'Report',
      cell: (scan) =>
        scan.resultId == null ? (
          <Link to={`/history/${scan.id}`} className="wa-caption wa-aside-link wa-row-inset">
            Awaiting review
          </Link>
        ) : (
          <Link to={`/report/${scan.resultId}`} className="wa-body-compact wa-aside-link wa-row-inset">
            Open report
          </Link>
        ),
    },
    {
      key: 'pillars',
      header: 'Pillars',
      cell: (scan) => (
        <span className="flex flex-col">
          <span className="wa-body-compact">{measured(scan)}</span>
          {requestSentence(scan, pillarTitle) != null && (
            <span className="wa-caption">{requestSentence(scan, pillarTitle)}</span>
          )}
        </span>
      ),
    },
    {
      key: 'actor',
      header: 'Measured as',
      cell: (scan) => (
        <span className="flex flex-col">
          <span className="wa-body-compact truncate">{whoRan(scan)}</span>
          {/* The kind of identity and, where the run says so, whether anybody was watching. A
              column of runs is where the distinction earns its place: a nightly service
              principal and an admin spot-check sit next to each other and read very differently. */}
          <span className="wa-caption">
            {identity(scan)}
            {startedBy(scan) != null && ` · ${String(startedBy(scan))}`}
          </span>
        </span>
      ),
    },
    {
      key: 'state',
      header: 'State',
      cell: (scan) => (
        <span className="flex flex-col">
          <span className="wa-body-compact">{scan.state === 'partial' ? 'Partial' : 'Complete'}</span>
          <span className="wa-caption">
            {scan.stamp == null ? 'Pre-release development' : methodologyLabel(scan.stamp)}
          </span>
        </span>
      ),
    },
  ];
}

/** What became of one job run. The same tones the schedule panel's own badge uses, for its own states. */
const RUN_PRESENTATION: Readonly<
  Record<ScheduleRun['state'], { readonly tone: Tone; readonly Icon: typeof CheckCircle2 }>
> = {
  succeeded: { tone: 'success', Icon: CheckCircle2 },
  failed: { tone: 'danger', Icon: XCircle },
  cancelled: { tone: 'neutral', Icon: Ban },
  running: { tone: 'info', Icon: Loader },
  waiting: { tone: 'info', Icon: CircleDashed },
  unknown: { tone: 'neutral', Icon: CircleHelp },
};

/**
 * A run of the job, in the four columns that distinguish one from another.
 *
 * No score, no pillars, no findings: a job run that produced a scan has all of that in the other view,
 * and one that did not has none of it. What is here is what the platform knows — what became of it, when,
 * how long, who asked — and the message, which is the column the view exists for.
 *
 * # One line per cell, which keeps the bounded page scannable
 *
 * A job run has less to say than a scan does: when, how long and who asked fit on one line
 * together, and the message is clamped to one with the whole of it in the row's tooltip and behind `Open`.
 * That is 36px a row, which fits the smallest window this app supports.
 */
function jobColumns(timezone: string | undefined): readonly Column<ShownRun>[] {
  return [
    {
      key: 'state',
      header: 'Outcome',
      cell: (run) => (
        <Badge tone={RUN_PRESENTATION[run.state].tone} Icon={RUN_PRESENTATION[run.state].Icon}>
          {RUN_STATE_LABEL[run.state]}
        </Badge>
      ),
    },
    {
      key: 'startedAt',
      header: 'Started',
      // In the job's zone, matching the cadence the panel above states. A run in the reader's locale
      // under a cadence in UTC reads as a contradiction — see `inZone`.
      cell: (run) => (
        <span className="wa-caption whitespace-nowrap text-wa-text">
          {run.startedAt != null ? inZone(new Date(run.startedAt), timezone) : '—'}
          {captionFor(run) !== '' && <span className="text-wa-text-secondary"> · {captionFor(run)}</span>}
        </span>
      ),
    },
    {
      key: 'message',
      header: 'What the platform said',
      // The platform's message, and deliberately not the app's own reason even though the newest failed
      // run now carries one. Shot against labs with the reason here, the column read: the cause on row
      // one, "Task readiness failed with message: Workload failed…" on row two, and "the same failure
      // again" on rows three and four — four identical refusals described three ways, with the two that
      // looked most different being consecutive. This column's job is the pattern over time, which needs
      // one sentence per failure to compare. The cause of the current one belongs in the panel above,
      // which is about now rather than about the trend.
      cell: (run) => (
        <span className="wa-caption line-clamp-1 max-w-prose" title={run.message ?? undefined}>
          {run.message ?? (run.repeated === true ? REPEATED : <span className="text-wa-text-placeholder">—</span>)}
        </span>
      ),
    },
    {
      key: 'open',
      header: '',
      cell: (run) =>
        run.url != null ? (
          <a href={run.url} target="_blank" rel="noreferrer" className="wa-aside-link whitespace-nowrap">
            Open
          </a>
        ) : null,
    },
  ];
}

/** How long it took, who asked, and which attempt — the three facts that fit beside the timestamp. */
function captionFor(run: ShownRun): string {
  return [
    took(run),
    triggerCaption(run),
    run.attempt != null && run.attempt > 1 ? `attempt ${String(run.attempt)}` : undefined,
  ]
    .filter((part) => part != null)
    .join(' · ');
}

/**
 * Which kind of nothing, when the job-runs view has no rows.
 *
 * Three different answers, and folding them together is the sort of thing that sends a reader to fix a
 * schedule that was never deployed. Only the last is a state the reader can act on by testing it.
 */
function emptyJobRuns(error: string | undefined, schedule: Schedule | undefined): EmptyStateProps {
  if (error != null) {
    return { reason: 'collector-failed', heading: 'The job’s runs could not be read', detail: error };
  }

  if (schedule == null || schedule.state === 'not-deployed' || schedule.state === 'unreadable') {
    return {
      reason: 'not-yet-collected',
      heading: 'There is no scheduled job to have runs',
      detail:
        'The schedule is the optional half of the bundle and this workspace does not have it, so every run in the Scans view is one somebody started.',
    };
  }

  return {
    reason: 'not-yet-collected',
    heading: 'The scheduled job has not run',
    detail:
      'Nothing has run it, on its schedule or by hand. Testing the schedule from the panel above is the way to find out whether it works before the day it matters.',
  };
}

export function HistoryPage() {
  const { data, loading, error } = useScanHistory();
  const { pillarTitle } = useAssessment();
  const notes = useNoteCounts('run');
  const schedule = useSchedule();
  const [params, setParams] = useSearchParams();
  const view: RunsView = params.get('runs') === 'job' ? 'job' : 'scans';

  const show = (next: RunsView) => {
    const to = new URLSearchParams(params);
    if (next === 'scans') to.delete('runs');
    else to.set('runs', next);
    setParams(to, { replace: true });
  };

  const jobRuns = withoutRepeats(schedule.data?.runs ?? []);
  // What the scheduled job's assessing identity calls itself, if it has ever run. The job names it by
  // application id and nothing in the Jobs API resolves one, but a scan recorded the name as it ran — so
  // the history answers a question the job definition cannot. Undefined before its first run, which is
  // honest: there is nothing to know yet.
  const assessesAsName = data?.scans.find((scan) => scan.actor === schedule.data?.assessesAs)?.actorName;

  const paged = usePaged(data?.scans ?? [], 10);
  const pagedJobs = usePaged(jobRuns, 10);

  return (
    <CustomerPage>
      {error != null && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the history</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {data?.durabilityNote != null && (
        <Alert>
          <AlertTitle>This history is not durable yet</AlertTitle>
          <AlertDescription>{data.durabilityNote}</AlertDescription>
        </Alert>
      )}

      {/* Destructive rather than the neutral variant above, and the wording says the rows are
            still there. A short list that looks complete is the failure mode worth shouting
            about: it reads as an estate nobody has assessed. */}
      {data?.unreadable != null && (
        <Alert variant="destructive">
          <AlertTitle>This history could not be read</AlertTitle>
          <AlertDescription>{data.unreadable}</AlertDescription>
        </Alert>
      )}

      {/* Above the table, because the table is where the misreading happens: a history whose newest
            row is three weeks old reads as an estate that has not changed, and nothing else on the page
            says the reason is that nothing has run. */}
      <SchedulePanel schedule={schedule} assessesAsName={assessesAsName} />

      <Surface
        tone="task"
        label="Scan history"
        title="Runs"
        description="Recorded assessments and the scheduled job runs that may or may not have produced one."
        action={
          <>
            {/* The same control the run page uses for its three views. In the URL rather than in a
                    state hook, so a reader can be sent to the job's runs — which is what the schedule
                    panel above does when a scheduled run has failed. */}
            <span className="wa-segmented">
              {(Object.keys(RUNS_VIEWS) as readonly RunsView[]).map((one) => (
                <button
                  key={one}
                  type="button"
                  aria-pressed={one === view}
                  onClick={() => {
                    show(one);
                  }}
                >
                  {RUNS_VIEWS[one]}
                </button>
              ))}
            </span>
          </>
        }
      >
        {(view === 'scans' ? loading : schedule.loading) ? (
          <div className="flex items-center gap-2 px-3 py-8 text-wa-text-secondary">
            <Spinner className="h-3.5 w-3.5" /> Loading
          </div>
        ) : (
          <>
            <div>
              {view === 'scans' ? (
                <DataTable
                  caption="Previous scans of this workspace, newest first"
                  columns={columns(pillarTitle, notes.data?.counts)}
                  rows={paged.rows}
                  rowKey={(scan) => scan.id}
                  empty={{
                    reason: 'not-yet-collected',
                    heading: 'No scans recorded',
                    detail:
                      'Run an assessment from the Dashboard. Once two runs have been recorded on the same basis, this page can compare them.',
                  }}
                />
              ) : (
                <DataTable
                  caption={JOB_RUNS_CAPTION}
                  columns={jobColumns(schedule.data?.timezone)}
                  rows={pagedJobs.rows}
                  rowKey={(run) => run.runId}
                  empty={emptyJobRuns(schedule.error, schedule.data)}
                />
              )}
            </div>
            {(view === 'scans' ? paged : pagedJobs).total > 0 && (
              <Pagination paged={view === 'scans' ? paged : pagedJobs} noun={view === 'scans' ? 'runs' : 'job runs'} />
            )}
          </>
        )}

        <div className="border-t border-wa-divider p-3">
          {view === 'scans' ? (
            <Disclosure summary="When two runs can be compared">
              <p>
                A score is only comparable with another under the same public methodology and measurement basis — the
                same identity, definition, scoring basis, scope and window. Where those differ, the difference is in the
                question or observer rather than the estate.
              </p>
              <p>
                A run that carried pillars forward includes scores it did not measure itself; the Pillars column
                identifies them.
              </p>
            </Disclosure>
          ) : (
            // A different caveat for a different list, and the one this view is most likely to be
            // misread as: a job run is not a scan, and the rows here that have no scan behind them are
            // exactly the ones worth reading.
            <Disclosure summary="Why some of these produced no scan">
              <p>
                These are runs of the scheduled job rather than scans. A run that failed before it reached the app —
                compute that would not start, a grant that has lapsed, a task that failed on the way in — recorded
                nothing in the Scans view, so it is visible here and nowhere else.
              </p>
              <p>
                What the platform said is its message, not the app&rsquo;s. Where it repeats the run above it the column
                says so rather than printing the same sentence again.
              </p>
            </Disclosure>
          )}
        </div>
      </Surface>
    </CustomerPage>
  );
}
