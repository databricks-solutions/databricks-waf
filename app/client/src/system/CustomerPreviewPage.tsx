import { useEffect } from 'react';
import { Link, useLocation, useParams } from 'react-router';

import { AssessmentJourney } from '@/components/AssessmentJourney';
import { CustomerPage, PageLead, Surface } from '@/components/system/Surface';
import { UnpublishedSummary } from '@/components/UnpublishedSummary';
import { EmptyState } from '@/components/ui/EmptyState';
import { ActionPanel as ImprovementActionPanel } from '@/components/ActionPanel';
import { InvestigationPrimaryAction } from '@/pages/InvestigatePage';
import { OperateComposition } from '@/pages/OperatePage';
import { PendingReviewStatus, PublishedDashboard } from '@/pages/OverviewPage';
import { ReportDocument } from '@/pages/ReportPage';
import { AssessStatePage, PublishedReview } from '@/pages/ReviewPage';
import { investigationFocus } from '@/pages/investigation-focus';
import { resourceDestination } from '@/pages/resource-destination';
import {
  CUSTOMER_PREVIEW_STATES,
  PREVIEW_CONTROLS,
  PREVIEW_PILLARS,
  dashboardPreviewFixture,
  improvementPreviewAction,
  investigationPreviewFixture,
  reportPreviewFixture,
  type CustomerPreviewState,
} from './customer-preview-fixtures';
import {
  ASSESS_PREVIEW_STATES,
  OPERATE_PREVIEW_STATES,
  operatePreviewFixture,
  publishedReviewPreview,
  type AssessPreviewState,
  type OperatePreviewState,
} from './recurring-preview-fixtures';
import type { AssessmentReview, AttestableRequirement } from '@/api/types';

const AUTOMATED_PREVIEW_REVIEW: AssessmentReview = {
  id: 'preview-review',
  runId: 'preview-automated-run',
  openedBy: 'platform-owner@example.com',
  openedAt: '2026-08-27T08:00:00.000Z',
  pillars: [],
  answers: [],
  durable: true,
};

/** Development-only rendering of the exact published customer composition. */
export default function CustomerPreviewPage() {
  const { state: requested } = useParams<{ state: string }>();
  const location = useLocation();
  const routeSurface = location.pathname.split('/')[2];
  const surface =
    routeSurface === 'assess'
      ? 'assess'
      : routeSurface === 'operate'
        ? 'operate'
        : routeSurface === 'report'
          ? 'report'
          : routeSurface === 'investigate'
            ? 'investigate'
            : routeSurface === 'improvement'
              ? 'improvement'
              : 'dashboard';
  const state = isPreviewState(requested) ? requested : 'complete';

  useEffect(() => {
    document.title = `${surface[0]?.toUpperCase() ?? ''}${surface.slice(1)} preview · ${requested ?? state}`;
  }, [requested, state, surface]);

  if (surface === 'assess') {
    const assessState = isAssessPreviewState(requested) ? requested : 'review';
    return <AssessPreview state={assessState} />;
  }

  if (surface === 'operate') {
    const operateState = isOperatePreviewState(requested) ? requested : 'attention';
    return <OperateComposition {...operatePreviewFixture(operateState)} />;
  }

  if (surface === 'investigate') {
    const fixture = investigationPreviewFixture(state);
    if (fixture.finding == null) {
      return (
        <CustomerPage>
          <Surface tone="accent" label="Investigation state">
            <EmptyState
              reason="nothing-to-report"
              heading="No unmet requirement needs an improvement plan"
              detail="Clean results stay out of the action workspace."
              layout="compact"
              action={
                <Link className="wa-customer-secondary-action" to="/overview">
                  Open Dashboard
                </Link>
              }
            />
          </Surface>
        </CustomerPage>
      );
    }
    const focus = investigationFocus(
      fixture.finding,
      fixture.topology,
      (resource) => resourceDestination(resource, fixture.workspaceDirectory).standing === 'current'
    );
    return (
      <CustomerPage>
        <Surface
          tone="raised"
          title={fixture.finding.title}
          description={`${fixture.finding.controlId} · ${fixture.finding.outcomeReason ?? 'Published report finding'}`}
        >
          <InvestigationPrimaryAction
            finding={fixture.finding}
            control={fixture.control}
            focus={focus}
            workspaceDirectory={fixture.workspaceDirectory}
            selectedNodeId={null}
            {...(fixture.topologyError != null ? { topologyError: fixture.topologyError } : {})}
            onReloadTopology={() => undefined}
            onNode={() => undefined}
          />
        </Surface>
      </CustomerPage>
    );
  }

  if (surface === 'improvement') {
    const action = improvementPreviewAction(state);
    return (
      <CustomerPage>
        {action == null ? (
          <Surface tone="accent" label="Improvement state">
            <EmptyState
              reason="nothing-to-report"
              heading="No improvement action is open"
              detail="Verified and cancelled work does not remain in the active queue."
              layout="compact"
              action={
                <Link className="wa-customer-secondary-action" to="/investigate">
                  Review unmet requirements
                </Link>
              }
            />
          </Surface>
        ) : (
          <ImprovementActionPanel
            action={action}
            siblings={[action]}
            minProse={20}
            frozen={false}
            showValidation={false}
            titleOf={(controlId) => PREVIEW_CONTROLS[controlId]?.title}
            onChanged={() => undefined}
          />
        )}
      </CustomerPage>
    );
  }

  if (surface === 'report') {
    const fixture = reportPreviewFixture(state);
    const pillarTitle = (pillarId: string) =>
      PREVIEW_PILLARS.find((pillar) => pillar.id === pillarId)?.title ?? pillarId;
    return (
      <ReportDocument
        scan={fixture.scan}
        resultId={`preview-result-${state}`}
        ranked={fixture.ranked}
        held={[]}
        grouped={0}
        rows={fixture.rows}
        gaps={fixture.gaps}
        pillarRows={fixture.pillarRows}
        value={fixture.value}
        actions={fixture.actions}
        byControl={new Map()}
        raisedByControl={fixture.raisedByControl}
        notesByControl={new Map()}
        assessment={{
          controlOf: (controlId) => PREVIEW_CONTROLS[controlId],
          pillarTitle,
          alsoAsking: () => [],
          scan: fixture.scan,
        }}
      />
    );
  }

  if (surface === 'dashboard' && requested?.startsWith('automated') === true) {
    const fixture = dashboardPreviewFixture('sparse');
    const composite = requested === 'automated-composite';
    const partial = requested === 'automated-partial';
    const overPublished = requested === 'automated-over-published';
    const score = {
      ...fixture.scan.score,
      composition: {
        ...fixture.scan.score.composition,
        observed: fixture.scan.score.composition.observed + fixture.scan.score.composition.attested,
        attested: 0,
      },
      pillars: fixture.scan.score.pillars.map((pillar) => ({
        ...pillar,
        composition: {
          ...pillar.composition,
          observed: pillar.composition.observed + pillar.composition.attested,
          attested: 0,
        },
      })),
    };
    const requirements: readonly AttestableRequirement[] = score.pillars.flatMap((pillar) => {
      const count = Math.max(1, pillar.unmeasuredBy.attestation + pillar.unmeasuredBy.unreachable);
      return Array.from({ length: count }, (_, index) => ({
        controlId: `${pillar.pillarId}-${String(index + 1)}`,
        pillarId: pillar.pillarId,
        principleId: `${pillar.pillarId}-principle`,
        title: `Human evidence question ${String(index + 1)}`,
        severity: 'medium' as const,
        askedBecause:
          index === count - 1 && pillar.unmeasuredBy.unreachable > 0
            ? ('inconclusive' as const)
            : ('no-telemetry' as const),
        question: 'What practice is in place?',
        cadenceDays: 90,
      }));
    });
    const unpublished = (
      <UnpublishedSummary
        scan={{
          ...fixture.scan,
          id: 'preview-automated-run',
          state: partial ? 'partial' : 'complete',
          ...(partial ? { incompleteReason: 'Two collection surfaces did not return.' } : {}),
          measurement: PREVIEW_PILLARS.map((pillar, index) => ({
            pillarId: pillar.id,
            scanId: composite && index === 0 ? 'preview-earlier-run' : 'preview-automated-run',
            measuredAt: composite && index === 0 ? '2026-08-04T08:00:00.000Z' : '2026-08-27T08:00:00.000Z',
            actor: 'platform-owner@example.com',
            carriedForward: composite && index === 0,
          })),
          score,
          finalisation: { reviewId: 'preview-review' },
        }}
        pillars={PREVIEW_PILLARS}
        review={AUTOMATED_PREVIEW_REVIEW}
        reviewLoading={false}
        requirements={requirements}
        requirementsLoading={false}
      />
    );
    if (!overPublished) return <CustomerPage data-preview-state={requested}>{unpublished}</CustomerPage>;

    const published = dashboardPreviewFixture('complete');
    return (
      <CustomerPage data-preview-state={requested}>
        {unpublished}
        <PendingReviewStatus to="/review/preview-review" />
        <PublishedDashboard
          scan={published.scan}
          resultId="preview-previous-result"
          pillars={PREVIEW_PILLARS}
          history={[]}
          queue={published.queue}
          held={0}
          gaps={published.gaps}
          control={published.firstControl}
          actions={[]}
          changes={published.changes}
        />
      </CustomerPage>
    );
  }

  const fixture = dashboardPreviewFixture(state);

  return (
    <CustomerPage data-preview-state={state}>
      <PublishedDashboard
        scan={fixture.scan}
        resultId="preview-result"
        pillars={PREVIEW_PILLARS}
        history={[]}
        queue={fixture.queue}
        held={0}
        gaps={fixture.gaps}
        control={fixture.firstControl}
        actions={[]}
        changes={fixture.changes}
      />
    </CustomerPage>
  );
}

function AssessPreview({ state }: { readonly state: AssessPreviewState }) {
  if (state === 'loading') {
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
  if (state === 'error') {
    return (
      <AssessStatePage
        title="Review the collected evidence"
        summary="This review could not be read. No pillar decision or published report has changed."
        heading="This review could not be read"
        detail="The saved review could not be read."
        reason="collector-failed"
        action={
          <button type="button" className="wa-customer-secondary-action">
            Try again
          </button>
        }
      />
    );
  }
  if (state === 'partial') {
    return (
      <AssessStatePage
        title="Review the collected evidence"
        summary="The review is open, but its current human evidence could not be read."
        heading="Human evidence is unavailable"
        detail="The current identity cannot read the saved attestations for this assessment. Completed collection remains unchanged."
        reason="permission-required"
        action={
          <Link className="wa-customer-secondary-action" to="/diagnostics">
            Open diagnostics
          </Link>
        }
      />
    );
  }
  if (state === 'empty') {
    return (
      <AssessStatePage
        title="Review the collected evidence"
        summary="No completed run is waiting for a pillar decision. The latest report remains available."
        heading="No run is waiting to be reviewed"
        detail="A review opens when a scan finishes and remains here until every selected pillar has a confirm or an explicit skip."
        reason="nothing-to-report"
        action={
          <Link className="wa-customer-primary-action" to="/overview">
            Open Dashboard
          </Link>
        }
      />
    );
  }
  if (state === 'published') return <PublishedReview review={publishedReviewPreview()} />;

  const pillars = [
    ['Cost optimization', 'Confirmed'],
    ['Data and AI governance', 'Confirmed'],
    ['Interoperability and usability', 'Confirmed'],
    ['Operational excellence', '2 questions need attention'],
    ['Performance efficiency', 'Not yet recorded'],
    ['Reliability', 'Not yet recorded'],
    ['Security, compliance, and privacy', 'Not yet recorded'],
  ] as const;
  return (
    <CustomerPage className="wa-assess-page" data-preview-state={state}>
      <PageLead
        eyebrow="Assess · Review"
        headingLevel={2}
        title="Decide the remaining evidence"
        summary="Review what the run measured, keep current human evidence, and answer only what remains unsettled."
        context={
          <>
            <span>3 of 7 pillars recorded</span>
            <span>
              Indicative pillar scores are on the Dashboard; the report publishes after every selected pillar is
              reviewed
            </span>
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
      <div className="wa-assess-workspace">
        <Surface
          tone="task"
          title="Operational excellence"
          description="2 questions remain before this pillar can be confirmed."
          className="wa-assess-task"
        >
          <div className="wa-assess-decision">
            <div className="wa-assess-decision-actions">
              <button type="button" className="wa-customer-primary-action">
                Answer: Keep production changes reproducible <span aria-hidden>→</span>
              </button>
              <button type="button" className="wa-customer-secondary-action">
                Skip this pillar
              </button>
            </div>
            <p className="wa-assess-decision-help">
              Start with the question named on the action. 2 questions need an answer or refresh before this pillar can
              be confirmed.
            </p>
          </div>
          <section className="wa-assess-evidence-section">
            <h3>Measured by this run</h3>
            <p>18 automated requirements have collected evidence.</p>
            <Link className="wa-customer-tertiary-action" to="/history/preview-run">
              This run
            </Link>
          </section>
          <section className="wa-assess-evidence-section">
            <h3>On record now</h3>
            <p>1 current answer remains part of this review.</p>
            <ul className="wa-assess-evidence-list">
              <li>
                <p>Production change approval is recorded</p>
                <small>Recorded by platform.owner@example.com · review by 30 Sep 2026</small>
              </li>
            </ul>
          </section>
          <section className="wa-assess-evidence-section">
            <h3>Needs attention</h3>
            <p>Current answers stay above. Only unsettled questions appear here.</p>
            <ul className="wa-assess-question-list">
              <li>
                <Link className="wa-assess-question-link" to="/answers/walk?control=OE-02-04">
                  <span>
                    <strong>Keep production changes reproducible</strong>
                  </span>
                  <small>No current human answer · required to confirm this pillar</small>
                </Link>
              </li>
              <li>
                <Link className="wa-assess-question-link" to="/answers/walk?control=OE-04-01">
                  <span>
                    <strong>Record operational readiness ownership</strong>
                  </span>
                  <small>Answer has reached its review date</small>
                </Link>
              </li>
            </ul>
          </section>
        </Surface>
        <Surface
          tone="section"
          title="Assessment progress"
          description="3 of 7 pillars recorded"
          className="wa-assess-progress"
        >
          <ol className="wa-assess-pillar-list">
            {pillars.map(([title, caption]) => (
              <li key={title}>
                <button
                  type="button"
                  className="wa-assess-pillar-button"
                  data-selected={title === 'Operational excellence'}
                >
                  <span>{title}</span>
                  <small>{caption}</small>
                </button>
              </li>
            ))}
          </ol>
          <div className="wa-assess-progress-foot">
            <Link to="/history/preview-run">Collected run</Link>
            <Link to="/answers">Human evidence</Link>
          </div>
        </Surface>
      </div>
    </CustomerPage>
  );
}

function isPreviewState(value: string | undefined): value is CustomerPreviewState {
  return value != null && CUSTOMER_PREVIEW_STATES.some((state) => state === value);
}

function isAssessPreviewState(value: string | undefined): value is AssessPreviewState {
  return value != null && ASSESS_PREVIEW_STATES.some((state) => state === value);
}

function isOperatePreviewState(value: string | undefined): value is OperatePreviewState {
  return value != null && OPERATE_PREVIEW_STATES.some((state) => state === value);
}
