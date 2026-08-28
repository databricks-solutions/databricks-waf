// One run, as a record.
//
// The distinction this page rests on: the overview shows the current assessment, which is whatever the
// latest run left behind. This shows a run — a thing that happened, at a time, as somebody, measuring
// some of the estate and costing something. Those are different objects and conflating them is how an
// audit trail becomes a dashboard.
//
// Three views rather than four stacked panels. Result, what changed, and what it cost were 2,000 pixels
// of page where the reader wanted one of the three; as views they are one screen each and the choice is
// explicit. The comparison is the second view rather than the first: it is the more interesting one when
// it exists, and it has to refuse itself when the two runs were measured differently, which is not what
// a page should open with. Where it does run, it says which pillars this run carried forward.

import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Alert, AlertDescription, AlertTitle, Spinner } from '@databricks/appkit-ui/react';
import { useAssessment } from '../api/assessment-context';
import { customerResult } from '../api/final-result';
import { useOpenReview, useResult, useResultExports, useReviewForRun, useRunChanges, useScan } from '../api/hooks';
import { AssessmentJourney } from '../components/AssessmentJourney';
import { MeasuredWhen } from '../components/MeasuredWhen';
import { NoteThread } from '../components/NoteThread';
import { RunFiles } from '../components/RunFiles';
import { RunCost, RunProvenance, Field } from '../components/RunRecord';
import { ReviewStandingNote } from '../components/ReviewStanding';
import { scoreTone } from '../components/verdict-language';
import { DataTable, type Column } from '../components/ui/DataTable';
import { EmptyState } from '../components/ui/EmptyState';
import { Pagination } from '../components/ui/Pagination';
import { usePaged } from '../components/ui/paging';
import { CustomerPage, PageLead, Surface, TaskWorkspace } from '../components/system';
import { ScoreDisclaimer } from '../components/ui/ScoreDisclaimer';
import { OutcomeBadge, SeverityBadge } from '../components/ui/StatusBadge';
import { classOf, type ChangeClass } from '../components/change-language';
import { countOutcomes, duration, identity, measured, requestSentence, results } from './run-language';
import type { ControlChange, RunChanges, Scan } from '../api/types';

type View = 'changes' | 'result' | 'cost';

const VIEW_LABEL: Readonly<Record<View, string>> = {
  changes: 'What changed',
  result: 'Result',
  cost: 'Provenance and cost',
};

/**
 * The view a link can ask for, so a page elsewhere can send a reader to the part of this run they were
 * promised.
 *
 * In the URL rather than in state alone because the export menu offers "every file, with its checksum"
 * and those live under provenance: landing on the result and expecting the reader to find the third tab
 * is the kind of near-miss that makes a menu item feel broken. Held in state as well, so pressing a tab
 * does not push a history entry per click — the URL is how a link arrives, not a log of the reader's
 * tab presses.
 */
function askedFor(value: string | null): View | undefined {
  return value === 'changes' || value === 'result' || value === 'cost' ? value : undefined;
}

/**
 * The class of transition a link asked to see, where it asked for one.
 *
 * The differential strip is the caller: its counts are only useful if the number is a way in, and
 * the way in has to land on the rows it counted rather than on all of them. Unlike `view` this is
 * not held in state — a reader who clears the filter should be able to press back and have it
 * return, because arriving filtered and then not being filtered are two different pages.
 */
function narrowedTo(value: string | null): ChangeClass | undefined {
  return value === 'new' || value === 'regressed' || value === 'resolved' || value === 'changed' ? value : undefined;
}

const NARROWED_LABEL: Readonly<Record<ChangeClass, string>> = {
  new: 'with no outcome in the previous run',
  regressed: 'that stopped being met',
  resolved: 'that stopped being unmet',
  changed: 'that changed in some other way',
};

export function RunPage() {
  const { scanId } = useParams<{ scanId: string }>();
  const navigate = useNavigate();
  const ofRun = useReviewForRun(scanId ?? '');
  const opening = useOpenReview((id) => {
    void navigate(`/review/${id}`);
  });
  const { pillarTitle, definitionId } = useAssessment();
  const run = useScan(scanId ?? '');
  const finalResult = useResult(ofRun.data?.result?.id ?? '');
  const changes = useRunChanges(scanId ?? '');
  const files = useResultExports(ofRun.data?.result?.id ?? '');
  const [params] = useSearchParams();
  // Result, not changes. A first run has nothing to compare against, so opening on the comparison
  // greeted the reader of the only run they had with an empty panel explaining why it was empty. A
  // link that named a view wins over that default, because it was chosen for the reader arriving.
  const [view, setView] = useState<View>(askedFor(params.get('view')) ?? 'result');
  const narrowed = narrowedTo(params.get('changed'));

  if (run.loading || definitionId === undefined) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Loading run">
          <div className="flex items-center gap-2 px-3 py-8 text-wa-text-secondary">
            <Spinner className="h-3.5 w-3.5" /> Loading this run
          </div>
        </Surface>
      </CustomerPage>
    );
  }

  if (run.data == null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Run not found">
          <EmptyState
            reason="no-evidence"
            heading="That run is not in the history"
            detail={
              run.reason ??
              run.error ??
              'No run with that id was found. History written before durable storage was configured does not survive a restart.'
            }
            action={
              <Link to="/history" className="wa-button-secondary">
                Back to history
              </Link>
            }
          />
        </Surface>
      </CustomerPage>
    );
  }

  const scan = run.data;
  const final = customerResult(finalResult.data, scan);
  // Fail closed while the review read is loading or unavailable. A run carrying raw arithmetic is
  // not a customer-complete result; only the result joined through its exact review releases it.
  const scoreReleased = final != null;
  const reviewId = ofRun.data?.id ?? scan.finalisation?.reviewId;

  return (
    <CustomerPage>
      <PageLead
        eyebrow="Assessment record"
        headingLevel={2}
        title="Assessment run"
        summary={`Finished ${new Date(scan.finishedAt).toLocaleString()}.`}
        context={
          <span className="wa-caption">
            took {duration(scan)} · {identity(scan.stamp)}
          </span>
        }
        actions={
          <>
            {reviewId != null ? (
              <Link className={scoreReleased ? 'wa-button-secondary' : 'wa-button-primary'} to={`/review/${reviewId}`}>
                {scoreReleased ? 'Open completed review' : 'Continue review'}
              </Link>
            ) : (
              <button
                type="button"
                className="wa-button-secondary"
                disabled={opening.saving || ofRun.loading || definitionId === undefined}
                onClick={() => {
                  if (scanId != null) opening.open(scanId);
                }}
              >
                {opening.saving ? 'Opening…' : 'Review this run'}
              </button>
            )}
            <span className="wa-segmented">
              {(['changes', 'result', 'cost'] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={view === candidate}
                  onClick={() => setView(candidate)}
                >
                  {candidate === 'result' && !scoreReleased ? 'Evidence' : VIEW_LABEL[candidate]}
                </button>
              ))}
            </span>
          </>
        }
      />
      <AssessmentJourney
        current={scoreReleased ? 'publish' : 'review'}
        published={scoreReleased}
        detail={
          scoreReleased
            ? 'This run is included in its published report.'
            : reviewId != null
              ? 'Indicative pillar scores are available on the Dashboard. Continue this run’s review to publish the report and its files.'
              : 'Indicative pillar scores are available on the Dashboard. Open a review to decide the selected pillars and publish the report.'
        }
      />
      {opening.error != null && (
        <Alert variant="destructive">
          <AlertTitle>The review could not be opened</AlertTitle>
          <AlertDescription>{opening.error}</AlertDescription>
        </Alert>
      )}

      {scan.state === 'partial' && (
        <PartialRunStatus reason={scan.incompleteReason ?? 'The run stopped before completing its plan.'} />
      )}

      {scan.notCarried != null && (
        <Alert>
          <AlertTitle>This run could not reuse the run before it</AlertTitle>
          <AlertDescription>{scan.notCarried}</AlertDescription>
        </Alert>
      )}

      {view === 'changes' && (
        <Changes
          changes={changes.data}
          loading={changes.loading}
          pillarTitle={pillarTitle}
          {...(narrowed != null ? { narrowed } : {})}
          scanId={scanId ?? ''}
        />
      )}
      {view === 'result' &&
        (scoreReleased ? (
          <Result scan={final.assessment} pillarTitle={pillarTitle} />
        ) : (
          <ReviewGate scan={scan} pillarTitle={pillarTitle} {...(reviewId != null ? { reviewId } : {})} />
        ))}
      {view === 'cost' && (
        <div className="grid gap-4 xl:grid-cols-2">
          <RunProvenance scan={scan} />
          <RunCost scan={scan} />
          {/* Under the two, in the view about where this run's numbers came from. A file's checksum
                is provenance of the same kind — it is how somebody outside this app establishes that
                what they were sent is what this run produced — and it belongs beside how the run was
                measured rather than beside the result it measured. */}
          {scoreReleased ? (
            <RunFiles exports={files.data} />
          ) : (
            <Surface tone="raised" label="Report files" title="Report files">
              <p className="wa-body-compact p-3">
                Report files become available when this run&apos;s review publishes the report.
              </p>
            </Surface>
          )}
        </div>
      )}
    </CustomerPage>
  );
}

export function PartialRunStatus({ reason }: { readonly reason: string }) {
  return (
    <Alert role="status">
      <AlertTitle>This run is partial</AlertTitle>
      <AlertDescription>{reason}</AlertDescription>
    </Alert>
  );
}

/**
 * The evidence boundary before a final assessment exists.
 *
 * This run record stays an evidence view rather than becoming a second score dashboard. The indicative
 * pillar scores are visible on the Dashboard; final posture and files still come from the immutable
 * result. Counts here rest only on stored measurement and signal fields. The review id is the exact
 * server-created record, never reconstructed from the run id.
 */
export function ReviewGate({
  scan,
  pillarTitle,
  reviewId,
}: {
  readonly scan: Scan;
  readonly pillarTitle: (pillarId: string) => string;
  readonly reviewId?: string;
}) {
  const returned = scan.signals.filter((signal) => signal.status === 'observed').length;
  const missed = scan.signals.length - returned;
  const standing = scan.finalisation;

  return (
    <TaskWorkspace
      queueLabel="Review before results"
      taskLabel="Evidence by pillar"
      queue={
        <Surface tone="raised" label="Review before results" title="Review before results">
          <div className="space-y-3 p-3">
            <p className="wa-body-compact">
              This run is evidence, not the published report. Its indicative pillar scores are available on the
              Dashboard. Final posture and report files publish after its selected pillars are reviewed.
            </p>
            <dl className="space-y-3">
              <Field label="Evidence sources returned">{returned.toLocaleString()}</Field>
              <Field label="Sources without evidence">{missed.toLocaleString()}</Field>
              <Field label="Pillars in this run">{scan.measurement.length.toLocaleString()}</Field>
              <Field label="Review progress">
                {standing == null
                  ? 'Waiting for its review record'
                  : `${standing.recorded.toLocaleString()} of ${standing.expected.toLocaleString()} pillars recorded`}
              </Field>
            </dl>
            {reviewId != null && (
              <Link className="wa-button-primary" to={`/review/${reviewId}`}>
                Continue this review
              </Link>
            )}
          </div>
        </Surface>
      }
      task={
        <Surface tone="task" label="Evidence by pillar" title="Evidence by pillar">
          <ul>
            {scan.measurement.map((measurement) => (
              <li key={measurement.pillarId} className="wa-row justify-between gap-3 py-2">
                <span className="wa-body-compact font-medium text-wa-text">{pillarTitle(measurement.pillarId)}</span>
                <MeasuredWhen scan={scan} pillarId={measurement.pillarId} />
              </li>
            ))}
          </ul>
        </Surface>
      }
    />
  );
}

function Result({ scan, pillarTitle }: { scan: Scan; pillarTitle: (pillarId: string) => string }) {
  return (
    <TaskWorkspace
      queueLabel="Run result and notes"
      taskLabel="Where each pillar was measured"
      queue={
        <div className="flex flex-col gap-4">
          {/* No section header on this one: the view switcher above the page says which of the three
            views is open, and a plane repeating its own tab's label is a line of the reader's screen
            spent telling them where they already know they are. */}
          <Surface tone="raised" label="What this run produced" title="What this run produced">
            <div className="space-y-3 p-3">
              <div className="flex items-end gap-2">
                <span className={`wa-numeric text-3xl leading-none font-semibold ${scoreTone(scan.score.overall)}`}>
                  {scan.score.overall?.toFixed(1) ?? '—'}
                </span>
                <span className="wa-caption">/ 100</span>
              </div>
              <ScoreDisclaimer />
              {/* Directly under the number, above the census. The findings and pillar counts below say
                what the run measured; this says whether anybody has been over what it could not. */}
              <ReviewStandingNote
                {...(scan.finalisation != null ? { finalisation: scan.finalisation } : {})}
                pillarTitle={pillarTitle}
              />
              <dl className="space-y-3">
                <Field label="Findings">{results(countOutcomes(scan.findings))}</Field>
                <Field label="Pillars">{measured(summaryOf(scan))}</Field>
                <Field label="State">{scan.state === 'partial' ? 'Partial' : 'Complete'}</Field>
                <Field label="Asked to measure">
                  {requestSentence(summaryOf(scan), pillarTitle) ?? 'Every pillar'}
                </Field>
              </dl>
            </div>
          </Surface>

          {/* Under the summary in the narrow column, because a note about a run qualifies the number
            above it — "this ran during the migration, so the compute half is noise" — and that is the
            number somebody quoting this run would otherwise quote unqualified.

            It is written here rather than after the pillar table because the two planes of this column
            are now one pane, and a pane's children are its reading order: a screen reader met the
            notes between the two columns while the eye had them under the score. */}
          <Surface tone="section" label="Notes on this run" title="Notes">
            <NoteThread subject={{ kind: 'run', id: scan.id }} label="Notes on this run" />
          </Surface>
        </div>
      }

      task={
        <Surface tone="task" label="Where each pillar was measured" title="Where each pillar was measured">
          <ul>
            {/* The whole point of recording a run: a pillar in this result that this run did not measure
              must not read as something this run found. */}
            {scan.score.pillars.map((pillar) => (
              <li key={pillar.pillarId} className="wa-row justify-between gap-3 py-2">
                <Link
                  to={`/pillars/${pillar.pillarId}`}
                  className="wa-body-compact font-medium text-wa-text hover:underline"
                >
                  {pillarTitle(pillar.pillarId)}
                </Link>
                <span className="flex shrink-0 items-center gap-3">
                  <MeasuredWhen scan={scan} pillarId={pillar.pillarId} />
                  <span className={`wa-numeric ${scoreTone(pillar.score)}`}>
                    {pillar.score?.toFixed(1) ?? 'Not scored'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Surface>
      }
    />
  );
}

/** The scan's own measurement record in the shape the run-language helpers read. */
function summaryOf(scan: Scan) {
  return {
    measuredPillars: scan.measurement.map((entry) => entry.pillarId),
    freshPillars: scan.measurement.filter((entry) => !entry.carriedForward).map((entry) => entry.pillarId),
    ...(scan.requestedPillars != null ? { requestedPillars: scan.requestedPillars } : {}),
  };
}

const CHANGE_COLUMNS: readonly Column<ControlChange>[] = [
  {
    key: 'control',
    header: 'Requirement',
    /*
     * To the requirement's current state, which is the question a changed row provokes: something
     * went from met to not met, and the next thing anybody wants is the evidence. It is deliberately
     * the current finding rather than this run's — the app holds one assessment, the latest — and
     * for the newest run those are the same thing.
     */
    cell: (change) => (
      <Link to={`/findings?control=${change.controlId}`} className="wa-row-link wa-body-compact text-wa-text">
        {change.title}
      </Link>
    ),
  },
  { key: 'severity', header: 'Severity', cell: (change) => <SeverityBadge severity={change.severity} /> },
  {
    key: 'from',
    header: 'Was',
    cell: (change) =>
      change.from === 'absent' ? (
        <span className="wa-caption">not assessed</span>
      ) : (
        <OutcomeBadge outcome={change.from} />
      ),
  },
  {
    key: 'to',
    header: 'Now',
    cell: (change) =>
      change.to === 'absent' ? (
        <span className="wa-caption">no longer assessed</span>
      ) : (
        <OutcomeBadge outcome={change.to} />
      ),
  },
];

function Changes({
  changes,
  loading,
  pillarTitle,
  narrowed,
  scanId,
}: {
  changes?: RunChanges;
  loading: boolean;
  pillarTitle: (pillarId: string) => string;
  narrowed?: ChangeClass;
  scanId: string;
}) {
  const shown =
    narrowed == null ? (changes?.changes ?? []) : (changes?.changes ?? []).filter((one) => classOf(one) === narrowed);
  const paged = usePaged(shown, 10);

  return (
    <Surface tone="task" label="What this run changed" title="What this run changed">
      {loading ? (
        <div className="flex items-center gap-2 px-3 py-6 text-wa-text-secondary">
          <Spinner className="h-3.5 w-3.5" /> Comparing
        </div>
      ) : changes == null ? (
        <EmptyState
          reason="no-evidence"
          heading="No comparison available"
          detail="The run before this one could not be read, so there is nothing to compare against."
        />
      ) : !changes.comparable ? (
        <div className="p-3">
          <Alert>
            <AlertTitle>These runs are not comparable</AlertTitle>
            <AlertDescription>
              {changes.reason ??
                'The two runs were measured differently, so a difference between them would not be a difference in the estate.'}
            </AlertDescription>
          </Alert>
        </div>
      ) : (
        <>
          <div className="space-y-1.5 p-3">
            <p className="wa-body-compact text-wa-text-secondary">
              Against the run of {new Date(changes.previous?.finishedAt ?? '').toLocaleString()}
              {changes.overallDelta != null && (
                <>
                  {'. Posture moved '}
                  <span className="wa-numeric">
                    {changes.overallDelta >= 0 ? '+' : ''}
                    {changes.overallDelta.toFixed(1)}
                  </span>
                </>
              )}
              .
            </p>
            {changes.caveat != null && <p className="wa-body-compact text-wa-text">{changes.caveat}</p>}
            {changes.unobserved.length > 0 && (
              <p className="wa-caption">
                {changes.unobserved.length === 1 ? 'One pillar was' : `${changes.unobserved.length} pillars were`}{' '}
                carried forward rather than measured by this run — {changes.unobserved.map(pillarTitle).join(', ')}. No
                change in {changes.unobserved.length === 1 ? 'it' : 'them'} could be observed, so an absence of changes
                there is not evidence that nothing moved.
              </p>
            )}
          </div>

          {/* Said as a fact about the list rather than as a chip, and with the way out beside it:
              a reader who followed a count from the strip has to be able to see it was a subset,
              or the table reads as the whole comparison with most of it missing. */}
          {narrowed != null && (
            <p className="wa-caption px-3 pb-1">
              Showing the {String(shown.length)} of {String(changes.changes.length)} {NARROWED_LABEL[narrowed]}.{' '}
              <Link to={`/history/${scanId}?view=changes`} className="underline hover:text-wa-text">
                Show all
              </Link>
            </p>
          )}

          {/* The rows take the slack; the body is what is measured, not the wrapper, whose height
              includes the sticky header row. */}
          <div>
            <DataTable
              caption="Requirements whose outcome differs from the previous run, regressions first"
              columns={CHANGE_COLUMNS}
              rows={paged.rows}
              rowKey={(change) => change.controlId}
              empty={{
                reason: 'nothing-to-report',
                heading: 'Nothing changed',
                detail: 'Every requirement this run measured came out the same as it did in the run before.',
              }}
            />
          </div>
          {paged.total > 0 && <Pagination paged={paged} noun="changes" />}
        </>
      )}
    </Surface>
  );
}
