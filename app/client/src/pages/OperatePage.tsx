// The repeatable operating path for one assessment.
//
// This page is an inbox, not a directory of record types. It ranks work that needs a person before
// publication, schedule and history context, and it reports only fields the server actually read.

import { Link } from 'react-router';
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  Hammer,
  History,
  RefreshCw,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import { useAssessment } from '../api/assessment-context';
import { useImprovements, useOpenReviews, useRisks, useScanHistory } from '../api/hooks';
import type { AcceptedRisk, AssessmentReview, ImprovementPlan, ScanSummary } from '../api/types';
import { PageLead, CustomerPage, Surface } from '../components/system/Surface';
import { TechnicalDisclosure } from '../components/system/TechnicalDisclosure';
import { EmptyState } from '../components/ui/EmptyState';
import { Badge } from '../components/ui/StatusBadge';
import { needsAttention } from './accept-language';
import { STATE_ICON, STATE_TONE, standingPhrase } from './improve-language';
import { dateTime, remainingPhrase, reviewTiming } from './operate-language';

export interface OperateCompositionProps {
  readonly reviews: readonly AssessmentReview[];
  readonly scans: readonly ScanSummary[];
  readonly plans: readonly ImprovementPlan[];
  readonly risks: readonly AcceptedRisk[];
  readonly pillarCount: number;
  readonly now: Date;
  readonly result?: PublicationRecord;
  readonly loading?: boolean;
  readonly error?: string;
  readonly durabilityNote?: string;
  readonly eligibilityReason?: string;
  readonly onReload?: () => void;
}

export interface PublicationRecord {
  readonly id: string;
  readonly finalisedBy: string;
  readonly finalisedAt: string;
}

export function OperatePage() {
  const { catalogue, result, loading: resultLoading, error: resultError } = useAssessment();
  const open = useOpenReviews();
  const history = useScanHistory();
  const improvements = useImprovements();
  const risks = useRisks();
  const plans = (improvements.data?.plans ?? []).filter((plan) => plan.closed == null);
  const eligibilityReason =
    open.data?.eligibility.eligible === false ? open.data.eligibility.reason.message : undefined;
  const error = open.error ?? history.error ?? improvements.error ?? risks.error ?? resultError;
  const loading =
    open.data == null || history.data == null || improvements.data == null || risks.data == null || resultLoading;

  return (
    <OperateComposition
      reviews={open.data?.reviews ?? []}
      scans={history.data?.scans ?? []}
      plans={plans}
      risks={risks.data?.risks ?? []}
      pillarCount={catalogue?.pillars.length ?? 0}
      now={new Date()}
      result={result}
      loading={loading}
      error={error}
      durabilityNote={open.data?.durabilityNote ?? improvements.data?.durabilityNote ?? history.data?.durabilityNote}
      eligibilityReason={eligibilityReason}
      onReload={() => {
        open.reload();
        history.reload();
        improvements.reload();
        risks.reload();
      }}
    />
  );
}

export function OperateComposition({
  reviews,
  scans,
  plans,
  risks,
  pillarCount,
  now,
  result,
  loading = false,
  error,
  durabilityNote,
  eligibilityReason,
  onReload,
}: OperateCompositionProps) {
  const scanById = new Map(scans.map((scan) => [scan.id, scan]));
  const openPlans = plans.filter((plan) => plan.closed == null).sort(rankPlan);
  const attentionRisks = risks.filter((risk) => needsAttention(risk.standing));
  const latestScheduled = scans
    .filter((scan) => scan.trigger === 'scheduled')
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0];
  const attentionCount =
    reviews.length +
    openPlans.filter((plan) => plan.progress.contradicted.length > 0 || plan.progress.overdue.length > 0).length +
    attentionRisks.length +
    Number(latestScheduled?.state === 'partial');
  const next = nextOperatingAction(reviews, openPlans, attentionRisks, latestScheduled);

  return (
    <CustomerPage className="wa-operate-page">
      <PageLead
        eyebrow="Operate"
        headingLevel={2}
        title="What needs attention now"
        summary="See what needs attention now, then inspect the records that keep the assessment cycle defensible."
        context={
          <>
            <span>
              {attentionCount === 0
                ? 'No recorded item needs attention'
                : `${String(attentionCount)} recorded ${attentionCount === 1 ? 'item needs' : 'items need'} attention`}
            </span>
            <span>
              {openPlans.length} open improvement {openPlans.length === 1 ? 'plan' : 'plans'}
            </span>
          </>
        }
        actions={
          <Link to="/overview" className="wa-customer-secondary-action">
            Dashboard
          </Link>
        }
      />

      {durabilityNote != null && (
        <p className="wa-operate-notice" role="status">
          {durabilityNote}
        </p>
      )}

      {error != null ? (
        <Surface tone="task" title="Next actions could not be read" label="Next actions error">
          <div className="wa-operate-error-state">
            <EmptyState
              reason="collector-failed"
              heading="Keep the current context and try again"
              detail="One or more records did not load. The Dashboard is unchanged."
              action={
                onReload == null ? undefined : (
                  <button type="button" className="wa-customer-secondary-action" onClick={onReload}>
                    <RefreshCw aria-hidden className="h-4 w-4" />
                    Try again
                  </button>
                )
              }
            />
            <TechnicalDisclosure label="Technical detail" hint="For support and diagnostics">
              <p className="wa-operate-technical-detail">{error}</p>
            </TechnicalDisclosure>
          </div>
        </Surface>
      ) : loading ? (
        <Surface tone="task" title="Reading the operating cycle" label="Loading next actions">
          <div className="wa-operate-loading" role="status">
            <CircleDashed aria-hidden />
            <div>
              <p>Reading reviews, improvement plans, exceptions, and run history.</p>
              <p>The current Dashboard remains available while these records load.</p>
            </div>
          </div>
        </Surface>
      ) : eligibilityReason != null ? (
        <Surface tone="task" title="Review status is unavailable" label="Review permission state">
          <div className="wa-operate-state" role="alert">
            <ShieldAlert aria-hidden />
            <div>
              <p>{eligibilityReason}</p>
              <Link className="wa-customer-secondary-action" to="/overview">
                Open Dashboard
              </Link>
            </div>
          </div>
        </Surface>
      ) : (
        <>
          <Surface
            tone={next == null ? 'accent' : 'task'}
            title={next?.title ?? 'The recorded cycle has no urgent work'}
            description={
              next?.detail ??
              'No review, contradicted or overdue plan, expiring exception, or partial scheduled run is recorded.'
            }
            action={
              next == null ? (
                <Link className="wa-customer-secondary-action" to="/overview">
                  Open Dashboard
                </Link>
              ) : (
                <Link className="wa-customer-primary-action" to={next.to}>
                  {next.action}
                  <ArrowRight aria-hidden className="h-4 w-4" />
                </Link>
              )
            }
            label="Next operating action"
          >
            <OperatingSignals
              reviews={reviews}
              plans={openPlans}
              attentionRisks={attentionRisks}
              latestScheduled={latestScheduled}
            />
          </Surface>

          <div className="wa-operate-layout">
            <Surface
              tone="raised"
              title="Needs attention"
              description="Open work is ordered before settled records. Each item links to the workflow that owns it."
              action={
                <Link className="wa-customer-secondary-action" to="/improvements">
                  <Hammer aria-hidden className="h-4 w-4" />
                  All improvement plans
                </Link>
              }
              className="wa-operate-inbox"
            >
              <AttentionInbox
                reviews={reviews}
                scans={scanById}
                plans={openPlans}
                risks={attentionRisks}
                scheduled={latestScheduled}
                pillarCount={pillarCount}
                now={now}
              />
            </Surface>

            <div className="wa-operate-context">
              <PublicationHealth result={result} newerReviews={reviews.length} />
              <ScheduleHealth scan={latestScheduled} />
              <ExceptionHealth risks={risks} attention={attentionRisks.length} />
              <Surface
                tone="inset"
                title="Cycle history"
                description="Every recorded run remains searchable without occupying Next actions."
                action={
                  <Link className="wa-customer-tertiary-action" to="/history">
                    <History aria-hidden className="h-4 w-4" />
                    All runs
                  </Link>
                }
              >
                <p className="wa-operate-supporting-copy">
                  {scans.length} recorded {scans.length === 1 ? 'run' : 'runs'}.
                </p>
              </Surface>
            </div>
          </div>
        </>
      )}
    </CustomerPage>
  );
}

interface OperatingAction {
  readonly title: string;
  readonly detail: string;
  readonly action: string;
  readonly to: string;
}

function nextOperatingAction(
  reviews: readonly AssessmentReview[],
  plans: readonly ImprovementPlan[],
  risks: readonly AcceptedRisk[],
  scheduled: ScanSummary | undefined
): OperatingAction | undefined {
  const review = reviews[0];
  if (review != null) {
    return {
      title:
        reviews.length === 1
          ? 'Finish the open assessment review'
          : `Choose from ${String(reviews.length)} open assessment reviews`,
      detail: 'The Dashboard remains unchanged until a review decides every selected pillar.',
      action: reviews.length === 1 ? 'Resume review' : 'Choose a review',
      to: reviews.length === 1 ? `/review/${review.id}` : '/review',
    };
  }
  const contradicted = plans.find((plan) => plan.progress.contradicted.length > 0);
  if (contradicted != null) {
    return {
      title: `Reopen the claim in “${contradicted.title}”`,
      detail: standingPhrase(contradicted.progress),
      action: 'Open contradicted work',
      to: `/improvements/${contradicted.id}`,
    };
  }
  const overdue = plans.find((plan) => plan.progress.overdue.length > 0);
  if (overdue != null) {
    return {
      title: `Review overdue work in “${overdue.title}”`,
      detail: standingPhrase(overdue.progress),
      action: 'Open overdue work',
      to: `/improvements/${overdue.id}`,
    };
  }
  const risk = risks[0];
  if (risk != null) {
    return {
      title: risk.standing === 'expired' ? 'Review an expired exception' : 'Review an expiring exception',
      detail: risk.title ?? risk.controlId,
      action: 'Open exceptions',
      to: `/exceptions?risk=${encodeURIComponent(risk.id)}`,
    };
  }
  if (scheduled?.state === 'partial') {
    return {
      title: 'Inspect the latest partial scheduled run',
      detail: `The run record reports partial and finished ${dateTime(scheduled.finishedAt)}.`,
      action: 'Open run record',
      to: `/history/${scheduled.id}`,
    };
  }
  return undefined;
}

function OperatingSignals({
  reviews,
  plans,
  attentionRisks,
  latestScheduled,
}: {
  readonly reviews: readonly AssessmentReview[];
  readonly plans: readonly ImprovementPlan[];
  readonly attentionRisks: readonly AcceptedRisk[];
  readonly latestScheduled?: ScanSummary;
}) {
  const contradicted = plans.reduce((count, plan) => count + plan.progress.contradicted.length, 0);
  const overdue = plans.reduce((count, plan) => count + plan.progress.overdue.length, 0);
  return (
    <dl className="wa-operate-signal-grid">
      <OperatingSignal label="Reviews" value={String(reviews.length)} detail="awaiting pillar decisions" />
      <OperatingSignal label="Still failing" value={String(contradicted)} detail="plan actions contradicted" />
      <OperatingSignal label="Overdue" value={String(overdue)} detail="actions past their due date" />
      <OperatingSignal label="Exceptions" value={String(attentionRisks.length)} detail="expired or expiring" />
      <OperatingSignal
        label="Latest scheduled run"
        value={latestScheduled?.state ?? 'None'}
        detail={latestScheduled == null ? 'no scheduled run recorded' : dateTime(latestScheduled.finishedAt)}
      />
    </dl>
  );
}

function OperatingSignal({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <strong>{value}</strong>
        <span>{detail}</span>
      </dd>
    </div>
  );
}

function AttentionInbox({
  reviews,
  scans,
  plans,
  risks,
  scheduled,
  pillarCount,
  now,
}: {
  readonly reviews: readonly AssessmentReview[];
  readonly scans: ReadonlyMap<string, ScanSummary>;
  readonly plans: readonly ImprovementPlan[];
  readonly risks: readonly AcceptedRisk[];
  readonly scheduled?: ScanSummary;
  readonly pillarCount: number;
  readonly now: Date;
}) {
  const attentionPlans = plans.filter(
    (plan) => plan.progress.contradicted.length > 0 || plan.progress.overdue.length > 0
  );
  const partialScheduled = scheduled?.state === 'partial' ? scheduled : undefined;
  if (reviews.length === 0 && attentionPlans.length === 0 && risks.length === 0 && partialScheduled == null) {
    return (
      <EmptyState
        reason="nothing-to-report"
        heading="Nothing in Next actions"
        detail="Open improvement plans without a contradicted or overdue action remain available under All improvement plans."
      />
    );
  }
  return (
    <ol className="wa-operate-attention-list">
      {reviews.map((review) => (
        <li key={review.id}>
          <Link to={`/review/${review.id}`}>
            <span className="wa-operate-attention-icon">
              <CircleDashed aria-hidden />
            </span>
            <span className="wa-operate-attention-copy">
              <strong>
                {scans.get(review.runId)?.trigger === 'scheduled' ? 'Scheduled review' : 'Assessment review'}
              </strong>
              <span>{remainingPhrase(review.pillars.length, pillarCount)}</span>
              <small>{reviewTiming(review, scans.get(review.runId), now)}</small>
            </span>
            <ArrowRight aria-hidden />
          </Link>
        </li>
      ))}
      {attentionPlans.map((plan) => (
        <li key={plan.id}>
          <Link to={`/improvements/${plan.id}`}>
            <span className="wa-operate-attention-icon">
              <Hammer aria-hidden />
            </span>
            <span className="wa-operate-attention-copy">
              <strong>{plan.title}</strong>
              <span>{standingPhrase(plan.progress)}</span>
              <small>{plan.owners.length === 0 ? 'No owner recorded' : plan.owners.join(', ')}</small>
            </span>
            <ArrowRight aria-hidden />
          </Link>
        </li>
      ))}
      {risks.map((risk) => (
        <li key={risk.id}>
          <Link to={`/exceptions?risk=${encodeURIComponent(risk.id)}`}>
            <span className="wa-operate-attention-icon">
              <ShieldAlert aria-hidden />
            </span>
            <span className="wa-operate-attention-copy">
              <strong>{risk.title ?? risk.controlId}</strong>
              <span>{risk.standing === 'expired' ? 'Exception expired' : 'Exception expiring'}</span>
              <small>{risk.owner}</small>
            </span>
            <ArrowRight aria-hidden />
          </Link>
        </li>
      ))}
      {partialScheduled != null && (
        <li>
          <Link to={`/history/${partialScheduled.id}`}>
            <span className="wa-operate-attention-icon">
              <CalendarClock aria-hidden />
            </span>
            <span className="wa-operate-attention-copy">
              <strong>Partial scheduled run</strong>
              <span>The recorded state is partial</span>
              <small>Finished {dateTime(partialScheduled.finishedAt)}</small>
            </span>
            <ArrowRight aria-hidden />
          </Link>
        </li>
      )}
    </ol>
  );
}

function PublicationHealth({
  result,
  newerReviews,
}: {
  readonly result?: PublicationRecord;
  readonly newerReviews: number;
}) {
  return (
    <Surface
      tone="section"
      title="Latest report"
      action={
        result == null ? (
          <Link className="wa-customer-tertiary-action" to="/review">
            Assess
          </Link>
        ) : (
          <Link className="wa-customer-tertiary-action" to="/overview">
            Dashboard
          </Link>
        )
      }
    >
      {result == null ? (
        <StatusLine Icon={CircleDashed} label="No report has been published" tone="neutral" />
      ) : (
        <>
          <StatusLine Icon={CheckCircle2} label="The latest report is on the Dashboard" />
          <p className="wa-operate-supporting-copy">
            Finalised by {result.finalisedBy} on {dateTime(result.finalisedAt)}.
          </p>
          {newerReviews > 0 && (
            <p className="wa-operate-supporting-copy">
              {newerReviews} newer {newerReviews === 1 ? 'review is' : 'reviews are'} open.
            </p>
          )}
        </>
      )}
    </Surface>
  );
}

function ScheduleHealth({ scan }: { readonly scan?: ScanSummary }) {
  return (
    <Surface
      tone={scan?.state === 'partial' ? 'accent' : 'section'}
      title="Latest scheduled run"
      action={
        scan == null ? (
          <Link className="wa-customer-tertiary-action" to="/history">
            History
          </Link>
        ) : (
          <Link className="wa-customer-tertiary-action" to={`/history/${scan.id}`}>
            Run record
          </Link>
        )
      }
    >
      {scan == null ? (
        <StatusLine Icon={CalendarClock} label="No scheduled run has been recorded" tone="neutral" />
      ) : (
        <>
          <StatusLine
            Icon={scan.state === 'partial' ? AlertTriangle : CheckCircle2}
            label={`The recorded state is ${scan.state}`}
            tone={scan.state === 'partial' ? 'warning' : 'success'}
          />
          <p className="wa-operate-supporting-copy">
            Finished {dateTime(scan.finishedAt)} · {scan.actorName ?? scan.actor}
          </p>
        </>
      )}
    </Surface>
  );
}

function ExceptionHealth({
  risks,
  attention,
}: {
  readonly risks: readonly AcceptedRisk[];
  readonly attention: number;
}) {
  return (
    <Surface
      tone={attention > 0 ? 'accent' : 'section'}
      title="Accepted exceptions"
      action={
        <Link className="wa-customer-tertiary-action" to="/exceptions">
          Exception register
        </Link>
      }
    >
      <StatusLine
        Icon={attention > 0 ? ShieldAlert : CheckCircle2}
        label={
          attention > 0
            ? `${String(attention)} ${attention === 1 ? 'exception needs' : 'exceptions need'} attention`
            : 'No expired or expiring exception is recorded'
        }
        tone={attention > 0 ? 'warning' : 'success'}
      />
      <p className="wa-operate-supporting-copy">
        {risks.length} accepted {risks.length === 1 ? 'exception' : 'exceptions'} recorded.
      </p>
    </Surface>
  );
}

export function ReviewInbox({
  reviews,
  scans,
  pillarCount,
  now,
}: {
  readonly reviews: readonly AssessmentReview[];
  readonly scans: ReadonlyMap<string, ScanSummary>;
  readonly pillarCount: number;
  readonly now: Date;
}) {
  return <AttentionInbox reviews={reviews} scans={scans} plans={[]} risks={[]} pillarCount={pillarCount} now={now} />;
}

export function OwnedWork({
  plans,
  loading,
  error,
}: {
  readonly plans: readonly ImprovementPlan[];
  readonly loading: boolean;
  readonly error?: string;
}) {
  const ordered = [...plans].sort(rankPlan);
  const contradicted = ordered.reduce((count, plan) => count + plan.progress.contradicted.length, 0);
  const overdue = ordered.reduce((count, plan) => count + plan.progress.overdue.length, 0);
  return (
    <Surface
      tone="section"
      title="Improvement plans"
      action={
        <Link className="wa-customer-secondary-action" to="/improvements">
          <Hammer aria-hidden className="h-4 w-4" />
          Open plans
        </Link>
      }
    >
      {error != null ? (
        <p role="alert" className="wa-operate-error">
          {error}
        </p>
      ) : loading && ordered.length === 0 ? (
        <p className="wa-operate-supporting-copy">Reading improvement plans.</p>
      ) : ordered.length === 0 ? (
        <p className="wa-operate-supporting-copy">No open improvement plan is recorded.</p>
      ) : (
        <>
          <div className="wa-operate-badges">
            <Badge tone="neutral" Icon={Hammer}>
              {ordered.length} open {ordered.length === 1 ? 'plan' : 'plans'}
            </Badge>
            {contradicted > 0 && (
              <Badge tone={STATE_TONE.blocked} Icon={STATE_ICON.blocked}>
                {contradicted} still failing
              </Badge>
            )}
            {overdue > 0 && (
              <Badge tone={STATE_TONE.planned} Icon={STATE_ICON.planned}>
                {overdue} overdue
              </Badge>
            )}
          </div>
          <ul className="wa-operate-owned-list">
            {ordered.slice(0, 3).map((plan) => (
              <li key={plan.id}>
                <Link className="wa-customer-tertiary-action" to={`/improvements/${plan.id}`}>
                  {plan.title}
                </Link>
                <span>
                  {plan.owners.join(', ')} · {standingPhrase(plan.progress)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="wa-operate-specialists">
        <p>
          Specialist findings use the same improvement planning workflow. Creating a plan does not change the Dashboard.
        </p>
        <div>
          <Link to="/workloads">Workloads</Link>
          <Link to="/warehouses">Warehouses</Link>
          <Link to="/serverless">Serverless</Link>
          <Link to="/foundation">Serving data</Link>
        </div>
      </div>
    </Surface>
  );
}

function rankPlan(a: ImprovementPlan, b: ImprovementPlan): number {
  return (
    b.progress.contradicted.length - a.progress.contradicted.length ||
    b.progress.overdue.length - a.progress.overdue.length ||
    b.progress.blocked.length - a.progress.blocked.length ||
    a.title.localeCompare(b.title)
  );
}

function StatusLine({
  Icon,
  label,
  tone = 'success',
}: {
  readonly Icon: LucideIcon;
  readonly label: string;
  readonly tone?: 'success' | 'warning' | 'neutral';
}) {
  const toneClass =
    tone === 'success'
      ? 'wa-operate-status-success'
      : tone === 'warning'
        ? 'wa-operate-status-warning'
        : 'wa-operate-status-neutral';
  return (
    <p className={`wa-operate-status ${toneClass}`}>
      <Icon aria-hidden />
      {label}
    </p>
  );
}
