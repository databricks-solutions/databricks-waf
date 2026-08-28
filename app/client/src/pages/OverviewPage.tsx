import { Alert, AlertDescription, AlertTitle, Spinner } from '@databricks/appkit-ui/react';
import { ArrowRight, ExternalLink } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { useAssessment } from '../api/assessment-context';
import {
  useDecisions,
  useAttestations,
  usePlan,
  useRaisedActions,
  useResultChanges,
  useResultHistory,
  useReviewForRun,
} from '../api/hooks';
import { summariseChanges } from '../components/change-language';
import { CONFIDENCE_LABEL, confidenceOf, estateCoverage } from '../components/coverage';
import { evidenceGaps, pillarList } from '../components/evidence-gaps';
import { affectedPhrase, splitFindings, type RankedFinding } from '../components/finding-rank';
import { tooLittleMeasured } from '../components/score-range';
import { ScoreStrip } from '../components/ScoreStrip';
import { ActionPanel } from '../components/system/ActionPanel';
import { Signal } from '../components/system/Signal';
import { CustomerPage, Surface } from '../components/system/Surface';
import { TechnicalDisclosure } from '../components/system/TechnicalDisclosure';
import { UnpublishedSummary } from '../components/UnpublishedSummary';
import { EmptyState } from '../components/ui/EmptyState';
import { RunScanDialog } from '../components/RunScanDialog';
import { ScoreDisclaimerMark } from '../components/ui/ScoreDisclaimer';
import type { CatalogueControl, ImprovementAction, Scan, ScanSummary } from '../api/types';
import type { Gap } from '../components/evidence-gaps';

export function OverviewPage() {
  const {
    scan,
    result,
    latestRun,
    catalogue,
    loading,
    error,
    emptyReason,
    scanning,
    scanError,
    controlOf,
    pillarTitle,
  } = useAssessment();
  const history = useResultHistory();
  const plan = usePlan();
  const decisions = useDecisions();
  const raised = useRaisedActions();
  const latestReview = useReviewForRun(latestRun?.id ?? '');
  const attestations = useAttestations(latestRun?.id ?? null);
  const resultChanges = useResultChanges(result?.id ?? '');
  const pillars = catalogue?.pillars ?? [];

  const decisionByControl = useMemo(
    () => new Map((decisions.data?.decisions ?? []).map((decision) => [decision.controlId, decision])),
    [decisions.data?.decisions]
  );
  const ranked = useMemo(
    () =>
      scan == null
        ? { queue: [], held: [] }
        : splitFindings(scan.findings, controlOf, (controlId) => decisionByControl.get(controlId)),
    [scan, controlOf, decisionByControl]
  );
  const gaps = useMemo(
    () => (scan == null ? [] : evidenceGaps(scan, plan.data, pillarTitle)),
    [scan, plan.data, pillarTitle]
  );

  return (
    <CustomerPage>
      {error != null && (
        <Alert variant="destructive">
          <AlertTitle>The app could not load the assessment</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {scanError != null && (
        <Alert variant="destructive">
          <AlertTitle>The scan did not run</AlertTitle>
          <AlertDescription>{scanError}</AlertDescription>
        </Alert>
      )}

      <div aria-live="polite" className="sr-only">
        {!scanning && scan != null ? 'The assessment is ready.' : ''}
      </div>

      {scan?.state === 'partial' && (
        <PartialScanStatus reason={scan.incompleteReason ?? 'The scan stopped before completing its plan.'} />
      )}

      {loading && scan == null && !scanning && (
        <Surface tone="task" label="Loading assessment">
          <div className="flex items-center gap-2 text-wa-text-secondary">
            <Spinner className="h-3.5 w-3.5" /> Loading
          </div>
        </Surface>
      )}

      {scan == null && latestRun == null && !loading && !scanning && (
        <Surface tone="task" label="Start assessment">
          <EmptyState
            reason="not-yet-collected"
            heading="No assessment run yet"
            detail={
              (emptyReason ?? 'Run an assessment to evaluate this workspace.') +
              ' Every score is reported alongside what it covers: which requirements applied, which were excluded' +
              ' and why, and which were measured over a sample rather than the whole estate.'
            }
            action={
              <RunScanDialog>
                <button type="button" className="wa-customer-primary-action">
                  Run assessment
                </button>
              </RunScanDialog>
            }
          />
        </Surface>
      )}

      {latestRun != null && (scan == null || latestRun.id !== scan.id) && error == null && !loading && !scanning && (
        <UnpublishedSummary
          scan={latestRun}
          pillars={pillars}
          review={latestReview.data}
          reviewLoading={latestReview.loading}
          reviewIssue={latestReview.error ?? latestReview.reason}
          requirements={attestations.data?.requirements}
          requirementsLoading={attestations.loading}
          requirementsIssue={attestations.error ?? attestations.reason}
        />
      )}

      {scan != null && (
        <>
          {latestRun != null && latestRun.id !== scan.id && (
            <PendingReviewStatus
              to={
                latestReview.data?.id == null
                  ? latestRun.finalisation?.reviewId == null
                    ? '/review'
                    : `/review/${latestRun.finalisation.reviewId}`
                  : `/review/${latestReview.data.id}`
              }
            />
          )}

          <PublishedDashboard
            scan={scan}
            resultId={result?.id}
            pillars={pillars}
            history={history.data?.results ?? []}
            queue={ranked.queue}
            held={ranked.held.length}
            gaps={gaps}
            control={ranked.queue[0] == null ? undefined : controlOf(ranked.queue[0].finding.controlId)}
            actions={raised.data?.actions ?? []}
            changes={
              result == null
                ? undefined
                : {
                    loading: resultChanges.loading,
                    lines: summariseChanges(
                      scan,
                      resultChanges.data,
                      (history.data?.results ?? []).find((run) => run.id !== scan.id)
                    ),
                  }
            }
          />
        </>
      )}
    </CustomerPage>
  );
}

export function PartialScanStatus({ reason }: { readonly reason: string }) {
  return (
    <Alert role="status">
      <AlertTitle>This scan is partial</AlertTitle>
      <AlertDescription>{reason}</AlertDescription>
    </Alert>
  );
}

export function PendingReviewStatus({ to }: { readonly to: string }) {
  return (
    <Alert role="status">
      <AlertTitle>This Dashboard shows the latest published report</AlertTitle>
      <AlertDescription>
        The newer run&apos;s indicative scores are above. The published report below remains current until that review
        publishes another report.{' '}
        <Link className="text-wa-action hover:underline" to={to}>
          Continue review
        </Link>
      </AlertDescription>
    </Alert>
  );
}

/**
 * The published Dashboard body, kept independent of API reads for deterministic local acceptance.
 *
 * OverviewPage remains the production data boundary. This component is the exact composition it
 * renders after publication, which lets the development-only preview exercise complete, sparse,
 * changed and empty states without writing a fabricated assessment into the customer store.
 */
export function PublishedDashboard({
  scan,
  resultId,
  pillars,
  history,
  queue,
  held,
  gaps,
  control,
  actions,
  changes,
}: {
  readonly scan: Scan;
  readonly resultId?: string;
  readonly pillars: readonly { readonly id: string; readonly title: string }[];
  readonly history: readonly ScanSummary[];
  readonly queue: readonly RankedFinding[];
  readonly held: number;
  readonly gaps: readonly Gap[];
  readonly control?: Pick<CatalogueControl, 'remediation'>;
  readonly actions: readonly Pick<
    ImprovementAction,
    'controlIds' | 'state' | 'id' | 'planId' | 'owner' | 'definitionOfDone'
  >[];
  readonly changes?: { readonly loading: boolean; readonly lines: readonly string[] };
}) {
  return (
    <>
      <DashboardPosture scan={scan} resultId={resultId} />

      <DashboardPriority scan={scan} gaps={gaps} first={queue[0]} control={control} actions={actions} />

      <div className="wa-dashboard-work-grid">
        <DashboardActionQueue queue={queue} held={held} />
        <div className="wa-dashboard-context-stack">
          {changes != null && (
            <DashboardChanges scan={scan} history={history} loading={changes.loading} lines={changes.lines} />
          )}
          <DashboardMeasurementGaps gaps={gaps} />
        </div>
      </div>

      <TechnicalDisclosure label="Posture by pillar" hint={`${String(pillars.length)} framework pillars`} open>
        <ScoreStrip scan={scan} history={history} pillars={pillars} />
      </TechnicalDisclosure>
    </>
  );
}

export function DashboardActionQueue({
  queue,
  held,
}: {
  readonly queue: readonly RankedFinding[];
  readonly held: number;
}) {
  const shown = queue.slice(0, 5);

  if (shown.length === 0) return null;

  return (
    <Surface
      tone="task"
      title="Next actions"
      description="The highest-priority unmet requirements that are ready to work."
      action={
        <Link className="wa-customer-secondary-action" to="/investigate?outcome=unmet">
          View all {queue.length + held} <ArrowRight aria-hidden className="h-4 w-4" />
        </Link>
      }
    >
      <ol className="wa-dashboard-action-list">
        {shown.map((entry, index) => {
          const affected = affectedPhrase(entry);
          return (
            <li key={entry.finding.controlId}>
              <Link
                to={`/investigate?control=${encodeURIComponent(entry.finding.controlId)}`}
                className="wa-dashboard-action-row"
              >
                <span className="wa-dashboard-action-rank" aria-hidden>
                  {index + 1}
                </span>
                <span className="wa-dashboard-action-copy">
                  <span className="wa-dashboard-action-title">{entry.finding.title}</span>
                  <span className="wa-dashboard-action-meta">
                    <span data-severity={entry.finding.severity}>{entry.finding.severity}</span>
                    {affected != null && <span>{affected}</span>}
                    <span>{entry.finding.controlId}</span>
                  </span>
                </span>
                <span className="wa-dashboard-action-open">
                  Open <ArrowRight aria-hidden className="h-4 w-4" />
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
      {held > 0 && (
        <p className="wa-dashboard-action-foot">
          {held.toLocaleString()} more {held === 1 ? 'requirement is' : 'requirements are'} held by a recorded decision.{' '}
          <Link to="/decisions">Review decisions</Link>
        </p>
      )}
    </Surface>
  );
}

export function DashboardChanges({
  scan,
  history,
  lines,
  loading,
}: {
  readonly scan: Pick<Scan, 'id'>;
  readonly history: readonly Pick<ScanSummary, 'id' | 'finishedAt'>[];
  readonly lines: readonly string[];
  readonly loading: boolean;
}) {
  return (
    <Surface
      tone="section"
      title="What materially changed"
      action={
        <Link className="wa-customer-tertiary-action" to={`/history/${scan.id}`}>
          Run record <ArrowRight aria-hidden className="h-4 w-4" />
        </Link>
      }
    >
      {loading ? (
        <p className="wa-dashboard-context-copy">Comparing with the previous assessment.</p>
      ) : (
        <ul className="wa-dashboard-change-list">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {history.length > 0 && (
        <div className="wa-dashboard-recent-runs">
          <span>Recent assessments</span>
          {history.slice(0, 3).map((run) => (
            <Link key={run.id} to={`/history/${run.id}`}>
              {new Date(run.finishedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </Link>
          ))}
        </div>
      )}
    </Surface>
  );
}

export function DashboardMeasurementGaps({ gaps }: { readonly gaps: readonly Gap[] }) {
  const actionable = gaps.filter((gap) => gap.action != null && gap.blocked > 0);
  if (actionable.length === 0) return null;

  const counted = actionable.filter((gap) => gap.counted);
  const other = actionable.filter((gap) => !gap.counted);
  const total = counted.reduce((sum, gap) => sum + gap.blocked, 0);
  const countedSummary = `${total.toLocaleString()} unanswered requirement${total === 1 ? '' : 's'} ${
    total === 1 ? 'has' : 'have'
  } a next step.`;
  const otherSummary = `${other.length.toLocaleString()} assessment follow-up${other.length === 1 ? '' : 's'} ${
    other.length === 1 ? 'is' : 'are'
  } listed below.`;
  const description =
    total > 0
      ? `${countedSummary}${
          other.length > 0
            ? ` ${other.length.toLocaleString()} separate assessment follow-up${
                other.length === 1 ? '' : 's'
              } ${other.length === 1 ? 'is' : 'are'} listed below.`
            : ''
        }`
      : otherSummary;

  return (
    <Surface tone="accent" title="Review assessment coverage" description={description}>
      <ul className="wa-dashboard-gap-list">
        {actionable.map((gap) => (
          <li key={gap.id}>
            <Link to={gap.action?.to ?? '/investigate?outcome=unmeasurable'}>
              <span className="wa-dashboard-gap-count">{gap.blocked.toLocaleString()}</span>
              <span>
                <strong>{gapActionTitle(gap)}</strong>
                <small>{pillarList(gap.pillars)}</small>
              </span>
              <ArrowRight aria-hidden className="h-4 w-4" />
            </Link>
          </li>
        ))}
      </ul>
    </Surface>
  );
}

export function DashboardPosture({
  scan,
  resultId,
}: {
  readonly scan: Pick<Scan, 'finishedAt' | 'score'>;
  readonly resultId?: string;
}) {
  const coverage = estateCoverage(scan.score);
  const confidence = confidenceOf(coverage);
  const directional = tooLittleMeasured(scan.score.range);
  const unmet = scan.score.counts.fail + scan.score.counts.partial;

  return (
    <Surface
      tone="raised"
      title="Current estate posture"
      description={`Published ${new Date(scan.finishedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`}
      action={
        resultId == null ? null : (
          <Link className="wa-customer-secondary-action" to={`/report/${resultId}`}>
            Open report <ArrowRight aria-hidden className="h-4 w-4" />
          </Link>
        )
      }
    >
      <div className="wa-dashboard-posture">
        <div className="wa-dashboard-coverage">
          <p className="wa-type-eyebrow">Assessment coverage</p>
          <p className="wa-dashboard-coverage-value">{Math.round(coverage.percent)}%</p>
          <p className="wa-dashboard-coverage-copy">
            {coverage.assessed.toLocaleString()} of {coverage.applicable.toLocaleString()} applicable requirements were
            evaluated.
          </p>
          <div className="wa-dashboard-coverage-track" aria-hidden>
            <span style={{ width: `${String(Math.min(100, Math.max(0, coverage.percent)))}%` }} />
          </div>
        </div>

        <div className="wa-signal-grid">
          <Signal
            label="Measured posture"
            value={scan.score.overall == null ? '—' : `${String(Math.round(scan.score.overall))}/100`}
            detail={
              <>
                <ScoreDisclaimerMark /> ·{' '}
                {directional ? 'Directional—close evidence gaps first' : 'Based on evaluated requirements'}
              </>
            }
            tone={directional ? 'directional' : 'neutral'}
          />
          <Signal
            label="Confidence"
            value={CONFIDENCE_LABEL[confidence]}
            detail={`${Math.round(coverage.percent)}% of applicable requirements assessed`}
            tone={confidence === 'high' ? 'positive' : confidence === 'none' ? 'directional' : 'warning'}
          />
          <Signal
            label="Unmet"
            value={unmet.toLocaleString()}
            detail={`${scan.score.counts.fail.toLocaleString()} not met · ${scan.score.counts.partial.toLocaleString()} partly met`}
            tone={unmet > 0 ? 'critical' : 'positive'}
          />
          <Signal
            label="Unanswered"
            value={scan.score.counts.unmeasurable.toLocaleString()}
            detail="Excluded from measured posture"
            tone={scan.score.counts.unmeasurable > 0 ? 'warning' : 'positive'}
          />
        </div>
      </div>
    </Surface>
  );
}

export function DashboardPriority({
  scan,
  gaps,
  first,
  control,
  actions,
}: {
  readonly scan: Pick<Scan, 'score'>;
  readonly gaps: readonly Gap[];
  readonly first?: Pick<RankedFinding, 'affected' | 'population'> & {
    readonly finding: Pick<RankedFinding['finding'], 'controlId' | 'title' | 'severity' | 'outcomeReason'>;
  };
  readonly control?: Pick<CatalogueControl, 'remediation'>;
  readonly actions: readonly Pick<
    ImprovementAction,
    'controlIds' | 'state' | 'id' | 'planId' | 'owner' | 'definitionOfDone'
  >[];
}) {
  const closeCoverageFirst = tooLittleMeasured(scan.score.range);
  const actionableGap = gaps.find((gap) => gap.action != null);

  if ((closeCoverageFirst || first == null) && actionableGap?.action != null) {
    return (
      <ActionPanel
        eyebrow="Do this first"
        title={gapActionTitle(actionableGap)}
        why={actionableGap.resolve}
        action={
          <Link className="wa-customer-primary-action" to={actionableGap.action.to}>
            {actionableGap.action.label} <ArrowRight aria-hidden className="h-4 w-4" />
          </Link>
        }
        destination="Assessment evidence workflow"
        verification="Publish a later assessment, then review the updated coverage on this Dashboard."
      />
    );
  }

  if (first == null) {
    const unanswered = scan.score.counts.unmeasurable;
    return (
      <Surface tone="accent" title="No open improvement plan">
        <p className="wa-dashboard-empty-copy">
          {unanswered > 0
            ? `No evaluated requirement is currently unmet or partly met. Review the ${unanswered.toLocaleString()} unanswered requirement${unanswered === 1 ? '' : 's'} before treating this as a complete result.`
            : 'Every applicable requirement was evaluated and none was found unmet or partly met. Continue monitoring for material change.'}
        </p>
      </Surface>
    );
  }

  const requirement = first.finding.controlId;
  const active = actions.find(
    (action) => action.controlIds.includes(requirement) && action.state !== 'verified' && action.state !== 'cancelled'
  );
  const remediation = control?.remediation;
  const deepLink = remediation?.deepLink;
  const affected =
    first.affected == null
      ? undefined
      : first.population == null
        ? `${first.affected.toLocaleString()} resources affected`
        : `${first.affected.toLocaleString()} of ${first.population.toLocaleString()} resources affected`;
  const why = `${first.finding.severity[0]?.toUpperCase() ?? ''}${first.finding.severity.slice(1)} priority. ${
    affected == null ? 'The assessment recorded this requirement as unmet.' : `The assessment recorded ${affected}.`
  }`;

  return (
    <ActionPanel
      eyebrow="Do this first"
      title={first.finding.title}
      why={why}
      action={
        deepLink != null ? (
          <a className="wa-customer-primary-action" href={deepLink} target="_blank" rel="noreferrer">
            Open in Databricks <ExternalLink aria-hidden className="h-4 w-4" />
          </a>
        ) : (
          <Link
            className="wa-customer-primary-action"
            to={
              active == null
                ? `/investigate?control=${encodeURIComponent(requirement)}`
                : `/improvements/${active.planId}?control=${encodeURIComponent(requirement)}`
            }
          >
            {active == null ? 'Open requirement' : 'Continue improvement'}{' '}
            <ArrowRight aria-hidden className="h-4 w-4" />
          </Link>
        )
      }
      destination={
        deepLink != null ? 'Exact Databricks workspace location' : `${requirement} in Investigate and Improve`
      }
      {...(active != null ? { owner: active.owner, verification: active.definitionOfDone } : {})}
      details={
        <TechnicalDisclosure label="Requirement and evidence" hint={requirement}>
          <p>
            <Link
              className="text-wa-action hover:underline"
              to={`/investigate?control=${encodeURIComponent(requirement)}`}
            >
              {requirement} — {first.finding.title}
            </Link>
          </p>
          {first.finding.outcomeReason != null && <p className="mt-2">{first.finding.outcomeReason}</p>}
          {remediation?.summary != null && (
            <p className="mt-2">
              <strong>Implementation guidance:</strong> {remediation.summary}
            </p>
          )}
        </TechnicalDisclosure>
      }
    />
  );
}

function gapActionTitle(gap: Gap): string {
  if (gap.id === 'attestation') return `Answer ${gap.blocked.toLocaleString()} practice requirements`;
  if (gap.id === 'blocked-scope') return `Answer ${gap.blocked.toLocaleString()} requirements this app cannot read`;
  if (gap.id === 'unreadable') return `Restore evidence for ${gap.blocked.toLocaleString()} unreadable requirements`;
  if (gap.id === 'unbuilt') return `Review ${gap.blocked.toLocaleString()} requirements without an automated check`;
  if (gap.id === 'unassessed-pillars') {
    return `Review ${gap.blocked.toLocaleString()} requirements this version does not assess`;
  }
  if (gap.id === 'not-applicable') {
    return `Review ${gap.blocked.toLocaleString()} excluded requirement${gap.blocked === 1 ? '' : 's'}`;
  }
  if (gap.id === 'silent-signals') {
    return `Inspect ${gap.blocked.toLocaleString()} collector${gap.blocked === 1 ? '' : 's'} that returned nothing`;
  }
  if (gap.counted) return `Resolve ${gap.blocked.toLocaleString()} unanswered requirements`;
  return `Review ${gap.title.toLowerCase()}`;
}
