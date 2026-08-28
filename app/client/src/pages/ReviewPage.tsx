// Seven pillar summaries of a completed run: what the scan measured, what is reused, what still
// needs a person, then one confirm or an attributed skip.
//
// Asking only the outstanding questions is the whole value of the row. The Answers walk beside this
// page asks every unsettled question in catalogue order, which is the right shape for a first pass
// and the wrong shape for a review: eighty current answers sitting in the same list as four that
// lapsed is a list nobody finishes. This page splits the three piles per pillar and only the
// attention pile is a question.
//
// Confirm freezes the exact current attestation ids after every attention item is closed. Skip
// freezes every manual control it leaves unresolved. Neither can be undone, which is why both ask
// before they write, and why the skip's notice refuses to call itself a review.
//
// The answer piles are scoped to the reviewed run and read from the live attestation store. The
// server rechecks that same set at write time; the browser summary is guidance, never authority.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router';
import { AlertTriangle, ArrowRight, CheckCircle2, CircleSlash } from 'lucide-react';
import { useAssessment } from '../api/assessment-context';
import { useAnswerInReview, useAttestations, useOpenReviews, useRecordPillar, useReview, useScan } from '../api/hooks';
import { AnswerForm, answerFormKey } from '../components/AnswerForm';
import { AssessmentJourney } from '../components/AssessmentJourney';
import { StateBadge } from '../components/StateBadge';
import { CustomerPage, PageLead, Surface } from '../components/system/Surface';
import { TechnicalDisclosure } from '../components/system/TechnicalDisclosure';
import { EmptyState, type EmptyReason } from '../components/ui/EmptyState';
import { ASKED_LABEL, attributionPhrase, renewalPhrase, stateOf } from './attest-language';
import {
  ATTENTION_LABEL,
  automaticPhrase,
  citedPhrase,
  confirmNotice,
  finalisedPhrase,
  finalDecisionNotice,
  openedPhrase,
  pillarCaption,
  progressPhrase,
  recordedPhrase,
  reviewPillarCount,
  reusedPhrase,
  skipNotice,
  waitingPhrase,
} from './review-language';
import { pillarToWrite, resumePillar, summarisePillars, type PillarSummary } from './review-summary';
import type { AttestableRequirement, ReviewAnswer } from '../api/types';

const EMPTY_REQUIREMENTS: readonly AttestableRequirement[] = [];

function walkTo(pillarId: string, controlId: string): string {
  return `/answers/walk?pillar=${encodeURIComponent(pillarId)}&control=${encodeURIComponent(controlId)}`;
}

function runTo(runId: string): string {
  return `/history/${runId}`;
}

export function ReviewIndexPage() {
  const { catalogue } = useAssessment();
  const open = useOpenReviews();
  const pillarCount = catalogue?.pillars.length ?? 0;

  if (open.error != null) {
    return (
      <AssessStatePage
        title="Review the collected evidence"
        summary="The reviews are unavailable. The Dashboard is unchanged."
        heading="The reviews could not be read"
        detail="The open reviews did not load. Try again or return to the Dashboard."
        technicalDetail={open.error}
        reason="collector-failed"
        action={
          <button type="button" className="wa-customer-secondary-action" onClick={open.reload}>
            Try again
          </button>
        }
      />
    );
  }

  if (open.data == null) {
    return (
      <AssessStatePage
        title="Review the collected evidence"
        summary="Reading which completed runs still need a pillar decision."
        heading="Reading the reviews"
        detail="Fetching which completed runs still need a pillar recorded."
        reason="not-yet-collected"
      />
    );
  }

  const waiting = open.data.reviews;
  if (waiting.length === 1 && waiting[0] != null) {
    return <Navigate to={`/review/${waiting[0].id}`} replace />;
  }

  if (waiting.length === 0) {
    return (
      <AssessStatePage
        title="Review the collected evidence"
        summary="No completed run is waiting for a pillar decision. The latest report remains available."
        heading="No run is waiting to be reviewed"
        detail="A review opens when a scan finishes and remains here until every selected pillar has a confirm or an explicit skip."
        reason="nothing-to-report"
        action={
          <div className="wa-assess-state-actions">
            <Link className="wa-customer-primary-action" to="/overview">
              Open Dashboard
            </Link>
            <Link className="wa-customer-secondary-action" to="/history">
              Run history
            </Link>
          </div>
        }
      />
    );
  }

  return (
    <CustomerPage className="wa-assess-page">
      <PageLead
        eyebrow="Assess"
        headingLevel={2}
        title="Choose the assessment to review"
        summary={waitingPhrase(waiting, pillarCount)}
        context="Opening a review does not replace the latest report on the Dashboard."
        actions={
          <Link className="wa-customer-secondary-action" to="/overview">
            Dashboard
          </Link>
        }
      />
      <AssessmentJourney
        current="review"
        detail="Collect is complete. Choose the review whose pillar decisions you want to resume."
      />
      <Surface tone="task" title="Open reviews" description="Each completed run keeps its own review progress.">
        <ol className="wa-assess-review-list">
          {waiting.map((one) => (
            <li key={one.id}>
              <Link to={`/review/${one.id}`}>
                <span>
                  <strong>{openedPhrase(one)}</strong>
                  <small>
                    {pillarCount > 0
                      ? progressPhrase(one.pillars.length, reviewPillarCount(one, pillarCount))
                      : 'Pillar count unavailable'}
                  </small>
                </span>
                <span>
                  Resume <ArrowRight aria-hidden />
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </Surface>
    </CustomerPage>
  );
}

export function AssessStatePage({
  title,
  summary,
  heading,
  detail,
  reason,
  action,
  technicalDetail,
}: {
  readonly title: string;
  readonly summary: string;
  readonly heading: string;
  readonly detail: string;
  readonly reason: EmptyReason;
  readonly action?: ReactNode;
  readonly technicalDetail?: string;
}) {
  return (
    <CustomerPage className="wa-assess-page">
      <PageLead
        eyebrow="Assess · Review"
        headingLevel={2}
        title={title}
        summary={summary}
        actions={
          <Link className="wa-customer-secondary-action" to="/overview">
            Dashboard
          </Link>
        }
      />
      <AssessmentJourney current="review" detail={summary} />
      <Surface tone="task" title={heading} label="Assessment review state">
        <div className="wa-assess-state-content">
          <EmptyState reason={reason} heading={heading} detail={detail} action={action} />
          {technicalDetail != null && (
            <TechnicalDisclosure label="Technical detail" hint="For support and diagnostics">
              <p className="wa-assess-technical-detail">{technicalDetail}</p>
            </TechnicalDisclosure>
          )}
        </div>
      </Surface>
    </CustomerPage>
  );
}

export function ReviewPage() {
  const { reviewId } = useParams<{ reviewId: string }>();
  const { catalogue, pillarTitle, error: assessmentError, acceptResult } = useAssessment();
  const [params, setParams] = useSearchParams();
  const review = useReview(reviewId ?? '');
  const answers = useAttestations(review.data == null ? null : review.data.runId);
  const scan = useScan(review.data?.runId ?? '');
  const recording = useRecordPillar(reviewId ?? '', (written) => {
    review.accept(written);
    if (written.result != null) acceptResult(written.result);
  });
  // The answer moves the requirement between two piles this page renders — out of attention, into
  // "On record now" — and both are derived from the attestations, not from the review. So the review
  // is accepted from the response and the answers are re-read, rather than either being patched.
  const answering = useAnswerInReview(reviewId ?? '', (written) => {
    review.accept(written);
    answers.reload();
  });

  const cataloguePillarIds = useMemo(() => (catalogue?.pillars ?? []).map((one) => one.id), [catalogue?.pillars]);
  const pillarIds = useMemo(() => {
    const selected = review.data?.selectedPillars;
    if (selected == null) return cataloguePillarIds;
    const wanted = new Set(selected);
    return cataloguePillarIds.filter((id) => wanted.has(id));
  }, [cataloguePillarIds, review.data?.selectedPillars]);
  const requirements = answers.data?.requirements ?? EMPTY_REQUIREMENTS;

  const summaries = useMemo(
    () =>
      review.data == null ? [] : summarisePillars(pillarIds, review.data, scan.data?.findings ?? [], requirements),
    [pillarIds, review.data, scan.data?.findings, requirements]
  );

  const requested = params.get('pillar');
  const currentId = resumePillar(summaries, requested);
  const current = summaries.find((one) => one.pillarId === currentId);

  const go = (pillarId: string) => {
    const next = new URLSearchParams(params);
    next.set('pillar', pillarId);
    setParams(next, { replace: true });
  };

  useEffect(() => {
    const nextId = pillarToWrite(requested, currentId);
    if (nextId == null) return;
    const next = new URLSearchParams(params);
    next.set('pillar', nextId);
    setParams(next, { replace: true });
    // Catch-up only: depending on `params` would rewrite on every search change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested, currentId]);

  if (review.error != null) {
    return (
      <AssessStatePage
        title="Review the collected evidence"
        summary="This review could not be read. No pillar record or published report has changed."
        heading="This review could not be read"
        detail="The saved review did not load. Choose another open review or try again."
        technicalDetail={review.error}
        reason="collector-failed"
        action={
          <Link className="wa-customer-secondary-action" to="/review">
            Open reviews
          </Link>
        }
      />
    );
  }

  // `unknown-review` is `reason`, not `error` — useGet treats that code as absence, the same way a
  // missing run is absence. Treating `data == null` as loading would spin on a URL that will never
  // grow a review. Treating `!loading` as absence would flash "not here" while definitions are still
  // loading: a scoped path is null until then, and useGet with a null path is not loading.
  if (review.reason != null) {
    return (
      <AssessStatePage
        title="Review the collected evidence"
        summary="The requested review is unavailable. Choose another open review or return to the Dashboard."
        heading="This review is not here"
        detail="This saved review is not available. Choose another open review."
        technicalDetail={review.reason}
        reason="no-evidence"
        action={
          <Link className="wa-customer-secondary-action" to="/review">
            Open reviews
          </Link>
        }
      />
    );
  }

  if (review.data == null) {
    return (
      <AssessStatePage
        title="Review the collected evidence"
        summary="Reading the saved progress for this exact review."
        heading="Reading the review"
        detail="Fetching the pillar records of this run."
        reason="not-yet-collected"
      />
    );
  }

  if (review.data.definitionId == null) {
    return <AssessmentDefinitionRequired runId={review.data.runId} />;
  }

  if (answers.error != null) {
    return (
      <AssessStatePage
        title="Review the collected evidence"
        summary="The review is open, but its current human evidence could not be read."
        heading="The answers could not be read"
        detail="The human evidence linked to this review did not load. Choose another review or try again."
        technicalDetail={answers.error}
        reason="collector-failed"
        action={
          <Link className="wa-customer-secondary-action" to="/review">
            Open reviews
          </Link>
        }
      />
    );
  }

  if (scan.error != null) {
    return (
      <AssessStatePage
        title="Review the collected evidence"
        summary="The review is open, but the collected run behind it could not be read."
        heading="This run could not be read"
        detail="The collected evidence linked to this review did not load. Open the run record or try again."
        technicalDetail={scan.error}
        reason="collector-failed"
        action={
          <Link className="wa-customer-secondary-action" to={`/history/${review.data.runId}`}>
            This run
          </Link>
        }
      />
    );
  }

  if (scan.reason != null) {
    return (
      <AssessStatePage
        title="Review the collected evidence"
        summary="The review points to a run that is not available in this assessment history."
        heading="This run is not here"
        detail="The collected evidence linked to this review is not available in the current history."
        technicalDetail={scan.reason}
        reason="no-evidence"
        action={
          <Link className="wa-customer-secondary-action" to="/history">
            Run history
          </Link>
        }
      />
    );
  }

  if (assessmentError != null && catalogue == null) {
    return (
      <AssessStatePage
        title="Review the collected evidence"
        summary="The pillar catalogue could not be read, so this review cannot accept a decision."
        heading="The catalogue could not be read"
        detail="The assessment catalogue did not load. No review decision can be recorded until it is available."
        technicalDetail={assessmentError}
        reason="collector-failed"
        action={
          <Link className="wa-customer-secondary-action" to="/review">
            Open reviews
          </Link>
        }
      />
    );
  }

  // Confirm and skip are written once. The piles they sit on come from the run, the answers, and
  // the catalogue, so offering either while those are still an empty fallback would let a reader
  // skip a pillar that still has questions.
  if (catalogue == null || answers.data == null || scan.data == null) {
    return (
      <AssessStatePage
        title="Review the collected evidence"
        summary="Assembling the collected and human evidence for this review."
        heading="Reading what this run measured"
        detail="Fetching the catalogue, findings and answers that determine the remaining review work."
        reason="not-yet-collected"
      />
    );
  }

  const assembled = review.data;

  if (assembled.result != null) {
    return <PublishedReview review={assembled} />;
  }

  return (
    <CustomerPage className="wa-assess-page">
      <PageLead
        eyebrow="Assess · Review"
        headingLevel={2}
        title="Decide the remaining evidence"
        summary="Review what the run measured, keep current human evidence, and answer only what remains unsettled."
        context={
          <>
            <span>{progressPhrase(assembled.pillars.length, pillarIds.length)}</span>
            <span>
              Indicative pillar scores are on the Dashboard; the report publishes after every selected pillar is
              reviewed
            </span>
            <span>{openedPhrase(assembled)}</span>
          </>
        }
        actions={
          <Link className="wa-customer-secondary-action" to="/overview">
            Dashboard
          </Link>
        }
      />
      <AssessmentJourney
        current="review"
        detail="Prepare and Collect are complete. Review the remaining pillar decisions before Publish."
      />
      {assembled.durable === false && (
        <div className="wa-assess-warning" role="alert">
          <AlertTriangle aria-hidden />
          <p>
            Reviews are being held in memory and will be lost when the app restarts.{' '}
            {assembled.durabilityNote ?? 'Unset WAF_DEMO_NO_PERSISTENCE and restart to keep them.'}
          </p>
        </div>
      )}

      <div className="wa-assess-workspace">
        <Surface
          tone="task"
          title={current == null ? 'Choose a pillar' : pillarTitle(current.pillarId)}
          description={
            current == null
              ? 'Choose the next pillar whose evidence you want to decide.'
              : current.recorded == null
                ? current.attention.length === 0
                  ? 'The evidence is ready for a confirm or an explicit skip.'
                  : `${String(current.attention.length)} ${current.attention.length === 1 ? 'question remains' : 'questions remain'} before this pillar can be confirmed.`
                : pillarCaption(current.recorded, current.attention.length)
          }
          className="wa-assess-task"
        >
          {current == null ? (
            <EmptyState
              reason="not-yet-collected"
              heading="Choose a pillar"
              detail="Each pillar shows what the run measured, which answers remain current, and which decision is still required."
            />
          ) : (
            <PillarPane
              key={current.pillarId}
              summary={current}
              title={pillarTitle(current.pillarId)}
              runId={assembled.runId}
              recording={recording}
              answering={answering}
              answeredHere={assembled.answers}
              busy={recording.saving || review.loading}
              finalDecision={assembled.pillars.length === pillarIds.length - 1 && current.recorded == null}
            />
          )}
        </Surface>

        <Surface
          tone="section"
          title="Assessment progress"
          description={progressPhrase(assembled.pillars.length, pillarIds.length)}
          className="wa-assess-progress"
        >
          {pillarIds.length === 0 ? (
            <EmptyState
              reason="not-yet-collected"
              heading="Reading the catalogue"
              detail="The pillars this review records against come from the catalogue this build ships."
            />
          ) : (
            <ol className="wa-assess-pillar-list">
              {summaries.map((one) => (
                <li key={one.pillarId}>
                  <button
                    type="button"
                    className="wa-assess-pillar-button"
                    data-selected={one.pillarId === currentId}
                    data-pillar={one.pillarId}
                    aria-current={one.pillarId === currentId}
                    onClick={() => go(one.pillarId)}
                  >
                    <span>{pillarTitle(one.pillarId)}</span>
                    <small>{pillarCaption(one.recorded, one.attention.length)}</small>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="wa-assess-progress-foot">
            <Link to={`/history/${assembled.runId}`}>Collected run</Link>
            <Link to="/answers">Human evidence</Link>
          </div>
        </Surface>
      </div>
    </CustomerPage>
  );
}

export function AssessmentDefinitionRequired({ runId }: { readonly runId: string }) {
  return (
    <AssessStatePage
      title="Define an assessment to continue"
      summary="This custom run remains available as an indicative automated result, but it cannot become a published report."
      heading="Review needs a saved assessment"
      detail="This run has no saved assessment definition, so Review cannot record human decisions or publish a report. Define the scope, then run that assessment to continue."
      reason="not-yet-collected"
      action={
        <div className="wa-assess-state-actions">
          <Link className="wa-customer-primary-action" to="/definitions/setup">
            Define an assessment
            <ArrowRight aria-hidden />
          </Link>
          <Link className="wa-customer-secondary-action" to={runTo(runId)}>
            View automated result
          </Link>
        </div>
      }
    />
  );
}

export function PublishedReview({ review }: { readonly review: import('../api/types').AssessmentReview }) {
  const result = review.result;
  if (result == null) return null;
  const confirmed = result.pillars.filter((one) => one.kind === 'confirmed').length;
  const skipped = result.pillars.filter((one) => one.kind === 'skipped').length;
  const reasons = result.finalAssessment?.publication.reasons ?? [];

  return (
    <CustomerPage className="wa-assess-page">
      <PageLead
        eyebrow="Assess · Publish"
        headingLevel={2}
        title="Assessment complete"
        summary="The published report is ready and the Dashboard now reads from it."
        context={finalisedPhrase(result)}
        actions={
          <Link className="wa-customer-secondary-action" to="/operate">
            Operate
          </Link>
        }
      />
      <AssessmentJourney
        current="publish"
        published
        detail="The report is published. The Dashboard now reads from it."
      />
      <Surface
        tone="task"
        title="Your Dashboard is ready"
        description={finalisedPhrase(result)}
        action={
          <Link className="wa-customer-primary-action" to="/overview">
            Open Dashboard
            <ArrowRight aria-hidden className="h-4 w-4" />
          </Link>
        }
        label="Completed assessment"
      >
        <div className="wa-assess-published">
          <CheckCircle2 aria-hidden className="wa-assess-published-icon" />
          <dl className="wa-assess-result-facts">
            <ReviewFact label="Pillars recorded" value={String(result.pillars.length)} />
            <ReviewFact label="Confirmed" value={String(confirmed)} />
            <ReviewFact label="Skipped" value={String(skipped)} />
          </dl>
          {reasons.length > 0 && (
            <div className="wa-assess-publication-hold">
              <CircleSlash aria-hidden />
              <p>
                Methodology Version 1 is not released, so monthly publication remains held. This published report
                remains on the Dashboard.
              </p>
            </div>
          )}
        </div>
      </Surface>
    </CustomerPage>
  );
}

function ReviewFact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function PillarPane({
  summary,
  title,
  runId,
  recording,
  answering,
  answeredHere,
  busy,
  finalDecision,
}: {
  readonly summary: PillarSummary;
  readonly title: string;
  readonly runId: string;
  readonly recording: ReturnType<typeof useRecordPillar>;
  readonly answering: ReturnType<typeof useAnswerInReview>;
  readonly answeredHere: readonly ReviewAnswer[];
  readonly busy: boolean;
  readonly finalDecision: boolean;
}) {
  const [pending, setPending] = useState<'confirm' | 'skip' | null>(null);
  // One open form at a time. Two would be two half-written statements competing for the reader's
  // attention in a pane they scroll, and the server takes one answer per request either way.
  const [answeringControl, setAnsweringControl] = useState<string | null>(null);
  const here = useMemo(
    () => new Set(answeredHere.filter((one) => one.pillarId === summary.pillarId).map((one) => one.controlId)),
    [answeredHere, summary.pillarId]
  );
  const noticeId = useId();
  const confirmHelpId = useId();
  const proceed = useRef<HTMLButtonElement | null>(null);
  const answerForm = useRef<HTMLDivElement | null>(null);
  const nextQuestionItem = summary.attention[0];
  const nextQuestion = nextQuestionItem?.requirement.controlId;

  // The notice replaces the button that opened it, so without this the reader's focus lands on the
  // document body and a screen reader says nothing at all — the warning renders where focus is not.
  // Moving to the proceeding button, described by the notice, announces the consequence and the
  // action in one utterance and leaves Escape-equivalent ("Do not confirm") one tab away.
  useEffect(() => {
    if (pending != null) proceed.current?.focus();
  }, [pending]);

  useEffect(() => {
    if (answeringControl != null) answerForm.current?.querySelector('input')?.focus();
  }, [answeringControl]);

  return (
    <>
      {finalDecision && (
        <div className="wa-assess-final-note" role="status">
          <p>Complete the review</p>
          <p>The next accepted confirm or skip completes the selected pillar review and publishes the report.</p>
        </div>
      )}

      {summary.recorded != null ? (
        // role=status, not alert: this renders on arrival for a pillar recorded earlier as well as
        // after a write, and an assertive region on page load interrupts whatever the reader was
        // being told about the page.
        <p className="wa-assess-recorded" role="status">
          {recordedPhrase(summary.recorded)}
        </p>
      ) : (
        <div className="wa-assess-decision">
          {pending == null ? (
            <div>
              <div className="wa-assess-decision-actions">
                {summary.attention.length > 0 ? (
                  <button
                    type="button"
                    className="wa-customer-primary-action"
                    disabled={busy || nextQuestion == null}
                    onClick={() => setAnsweringControl(nextQuestion ?? null)}
                  >
                    Answer: {nextQuestionItem?.requirement.title ?? 'next question'}
                    <ArrowRight aria-hidden className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="wa-customer-primary-action"
                    disabled={busy}
                    onClick={() => setPending('confirm')}
                  >
                    {finalDecision ? 'Confirm and finalise assessment' : 'Confirm this pillar'}
                  </button>
                )}
                <button
                  type="button"
                  className="wa-customer-secondary-action"
                  disabled={busy}
                  onClick={() => setPending('skip')}
                >
                  {finalDecision ? 'Skip and finalise assessment' : 'Skip this pillar'}
                </button>
              </div>
              {summary.attention.length > 0 && (
                <p className="wa-assess-decision-help" id={confirmHelpId}>
                  Start with the question named on the action. {String(summary.attention.length)}{' '}
                  {summary.attention.length === 1 ? 'question needs' : 'questions need'} an answer or refresh before
                  this pillar can be confirmed.
                </p>
              )}
            </div>
          ) : (
            <div className="wa-assess-confirmation">
              <p id={noticeId}>
                {pending === 'confirm'
                  ? `${confirmNotice(title, summary.cited)}${finalDecision ? ` ${finalDecisionNotice()}` : ''}`
                  : `${skipNotice(title, summary.reused.length + summary.attention.length)}${finalDecision ? ` ${finalDecisionNotice()}` : ''}`}
              </p>
              <div className="wa-assess-decision-actions">
                <button
                  ref={proceed}
                  type="button"
                  className="wa-customer-primary-action"
                  aria-describedby={noticeId}
                  disabled={busy}
                  onClick={() => {
                    if (pending === 'confirm') recording.confirm(summary.pillarId);
                    else recording.skip(summary.pillarId);
                  }}
                >
                  {pending === 'confirm' ? 'Confirm' : 'Skip'} {title}
                </button>
                <button
                  type="button"
                  className="wa-customer-secondary-action"
                  disabled={busy}
                  onClick={() => setPending(null)}
                >
                  Do not {pending === 'confirm' ? 'confirm' : 'skip'}
                </button>
              </div>
            </div>
          )}
          {recording.error != null && recording.errorPillarId === summary.pillarId && (
            <p className="wa-assess-error" role="alert">
              {recording.error}
            </p>
          )}
        </div>
      )}

      <section className="wa-assess-evidence-section">
        <h3>Measured by this run</h3>
        <p>{automaticPhrase(summary.automatic.length)}</p>
        {summary.automatic.length > 0 && runId !== '' && (
          <p>
            <Link className="wa-customer-tertiary-action" to={runTo(runId)}>
              This run
            </Link>
          </p>
        )}
      </section>

      <section className="wa-assess-evidence-section">
        <h3>On record now</h3>
        <p>{reusedPhrase(summary.reused.length)}</p>
        {/* What the button freezes, beside the current records it is derived from. Standing rather
            than only in the notice, because a reader deciding whether to confirm needs it before
            they press, not after. */}
        <p>{citedPhrase(summary.cited)}</p>
        {summary.reused.length > 0 && (
          <ul className="wa-assess-evidence-list">
            {summary.reused.map((one) => (
              <li key={one.controlId}>
                <p>{one.title}</p>
                {one.attestation != null && (
                  <small>
                    {attributionPhrase(one.attestation.attestedBy, one.attestation.attestedAt)}
                    {' · '}
                    {renewalPhrase(one.attestation.reviewBy, stateOf(one))}
                  </small>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="wa-assess-evidence-section">
        <h3>Needs attention</h3>
        <p>
          {summary.attention.length === 0
            ? 'Nothing to ask in this pillar.'
            : 'These are the questions this review asks. Answers that are current sit under On record now, not here.'}
        </p>
        {summary.attention.length > 0 && (
          <ul className="wa-assess-question-list">
            {summary.attention.map((item) => {
              const open = answeringControl === item.requirement.controlId;
              return (
                <li key={item.requirement.controlId}>
                  <Link className="wa-assess-question-link" to={walkTo(summary.pillarId, item.requirement.controlId)}>
                    <span>
                      <StateBadge state={stateOf(item.requirement)} />
                      <strong>{item.requirement.title}</strong>
                    </span>
                    <small>
                      {ATTENTION_LABEL[item.reason]}
                      {item.reason === 'inconclusive' ? '' : ` · ${ASKED_LABEL[item.requirement.askedBecause]}`}
                    </small>
                  </Link>
                  {/* Beside the link out, not instead of it. The walk shows the guidance, the
                      history and the neighbouring questions, and a reviewer who needs those should
                      not have to answer from a pane that has none of them. What this adds is the
                      case the walk cannot serve: the answer is already known, and leaving the
                      review to record it is what stopped `refreshed` being countable. */}
                  {/* Shown in the gap, not as a steady state. An answer makes the requirement current,
                      which moves it out of attention entirely — but the review comes back from the
                      write and the answers are re-read after it, so for that window the row is still
                      here and the review already knows it was answered. Without this the reader gets
                      the empty form back, which reads as the answer not having been taken. */}
                  {here.has(item.requirement.controlId) ? (
                    <p className="wa-assess-answered" role="status">
                      Answered in this review.
                    </p>
                  ) : open ? (
                    <div ref={answerForm} className="wa-assess-answer-form">
                      <AnswerForm
                        key={answerFormKey(item.requirement)}
                        requirement={item.requirement}
                        saving={answering.saving}
                        saved={answering.saved === item.requirement.controlId}
                        {...(answering.error != null ? { error: answering.error } : {})}
                        onSubmit={(draft) => {
                          answering.submit(summary.pillarId, draft);
                        }}
                      />
                      <div>
                        <button
                          type="button"
                          className="wa-customer-secondary-action"
                          disabled={answering.saving}
                          onClick={() => setAnsweringControl(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="wa-customer-tertiary-action wa-assess-inline-answer"
                      disabled={busy || summary.recorded != null}
                      onClick={() => setAnsweringControl(item.requirement.controlId)}
                    >
                      Answer this question here
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {summary.recorded != null && summary.attention.length > 0 && (
          // Says why the buttons above are not available, rather than leaving them disabled with no
          // reason. Bounded to this pillar's record: the review as a whole is not finished.
          <p className="wa-assess-recorded-help">
            This pillar has a record, so it takes no more answers from inside this review. The walk still does.
          </p>
        )}
      </section>
    </>
  );
}
