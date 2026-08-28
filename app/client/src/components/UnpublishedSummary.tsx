// The Dashboard before there is a final assessment.
//
// An automated run is already useful evidence. It is not the published assessment: review can add
// selected human evidence, and the immutable result is what owns final posture, findings, comparisons,
// reports and exports. Hiding every number until that boundary made the questionnaire an unlock for the
// work the scan had already done. This surface shows the run's indicative pillar scores while saying,
// beside each one, exactly what was evaluated and what still needs a person.

import { AlertTriangle, Ban, CheckCircle2, CircleDashed, CircleHelp, History, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import { pillarCoverage } from './coverage';
import { Value } from './ScoreStrip';
import { PillarIcon } from './shell/PillarIcon';
import { shortPillarLabel } from './shell/pillar-label';
import { Badge, type Tone } from './ui/StatusBadge';
import { Surface } from './system';
import { attentionReason } from '../pages/review-summary';
import type { AssessmentReview, AttestableRequirement, Score } from '../api/types';

/** The run fields the indicative Dashboard reads before a final assessment exists. */
export interface UnpublishedScan {
  readonly id: string;
  readonly state: 'complete' | 'partial';
  readonly incompleteReason?: string;
  readonly measurement: readonly {
    readonly pillarId: string;
    readonly scanId: string;
    readonly measuredAt: string;
    readonly actor: string;
    readonly carriedForward: boolean;
  }[];
  readonly estate: {
    readonly assessed: readonly unknown[];
    readonly undeterminedReason?: string;
  };
  readonly findings: readonly unknown[];
  readonly score: Score;
  readonly finalisation?: { readonly reviewId: string };
}

export interface UnpublishedSummaryProps {
  readonly scan: UnpublishedScan;
  readonly pillars: readonly { readonly id: string; readonly title: string }[];
  readonly review?: AssessmentReview;
  readonly reviewLoading: boolean;
  /** The server's reason, unchanged. Absence and a failed read must not become zero progress. */
  readonly reviewIssue?: string;
  readonly requirements?: readonly AttestableRequirement[];
  readonly requirementsLoading: boolean;
  /** A failed question read is unknown, never zero remaining work. */
  readonly requirementsIssue?: string;
}

interface Standing {
  readonly label: string;
  readonly tone: Tone;
  readonly Icon: LucideIcon;
}

const AWAITING: Standing = { label: 'Awaiting review', tone: 'info', Icon: CircleDashed };
const READING: Standing = { label: 'Reading status', tone: 'neutral', Icon: CircleDashed };
const UNKNOWN: Standing = { label: 'Status unavailable', tone: 'neutral', Icon: CircleHelp };
const UNMEASURED: Standing = { label: 'Not measured', tone: 'neutral', Icon: CircleHelp };

function standingOf(
  pillarId: string,
  measured: ReadonlySet<string>,
  review: AssessmentReview | undefined,
  reviewLoading: boolean,
  reviewIssue: string | undefined
): Standing {
  if (reviewIssue != null) return UNKNOWN;
  if (review == null && reviewLoading) return READING;

  const recorded = review?.pillars.find((one) => one.pillarId === pillarId);
  if (recorded?.kind === 'confirmed') {
    return { label: 'Confirmed', tone: 'success', Icon: CheckCircle2 };
  }
  if (recorded?.kind === 'skipped') {
    return { label: 'Skipped', tone: 'warning', Icon: Ban };
  }
  return measured.has(pillarId) ? AWAITING : UNMEASURED;
}

function countPhrase(count: number, singular: string): string {
  return `${count.toLocaleString()} ${singular}${count === 1 ? '' : 's'}`;
}

function Fact({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="min-w-0 border-t border-wa-divider px-4 py-3 first:border-t-0 sm:border-l sm:border-t-0 sm:first:border-l-0">
      <dt className="wa-label">{label}</dt>
      <dd className="wa-body-compact pt-0.5 text-wa-text">{children}</dd>
    </div>
  );
}

function reviewPath(reviewId: string | undefined, pillarId: string): string {
  if (reviewId == null) return '/review';
  return `/review/${reviewId}?pillar=${encodeURIComponent(pillarId)}`;
}

function evidenceMix(observed: number, imported: number, attested: number): string {
  const parts = [`${countPhrase(observed, 'automated observation')}`];
  if (imported > 0) parts.push(`${countPhrase(imported, 'imported reading')}`);
  if (attested > 0) parts.push(`${countPhrase(attested, 'human answer')}`);
  return parts.join(' · ');
}

function measuredDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function UnpublishedSummary({
  scan,
  pillars,
  review,
  reviewLoading,
  reviewIssue,
  requirements,
  requirementsLoading,
  requirementsIssue,
}: UnpublishedSummaryProps) {
  const measured = new Set(scan.measurement.map((one) => one.pillarId));
  const reviewId = review?.id ?? scan.finalisation?.reviewId;
  const assessed = scan.estate.assessed.length;
  const recorded = review?.pillars.length;
  const scope =
    scan.estate.undeterminedReason == null ? countPhrase(assessed, 'workspace') : 'Scope could not be determined';
  const progress =
    reviewIssue != null
      ? 'Review status unavailable'
      : recorded != null
        ? `${String(recorded)} of ${String(pillars.length)} pillars recorded`
        : reviewLoading
          ? 'Reading review progress'
          : 'No review record read';
  const includesOtherEvidence = scan.score.pillars.some(
    (pillar) => pillar.composition.attested > 0 || pillar.composition['admin-collected'] > 0
  );
  const includesCarriedEvidence = scan.measurement.some((measurement) => measurement.carriedForward);
  const complete = scan.state === 'complete';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <Surface tone="task" label="Publication status">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1 space-y-2">
            <Badge tone={complete ? 'success' : 'warning'} Icon={complete ? CheckCircle2 : AlertTriangle}>
              {complete ? 'Automated checks complete' : 'Collection incomplete'}
            </Badge>
            <h2 className="wa-title-section text-wa-text">
              {complete ? 'Your indicative results are ready' : 'Indicative results from the partial run'}
            </h2>
            <p className="wa-body-compact text-wa-text-secondary">
              {complete
                ? 'Review the evidence and add the human context the scan cannot observe.'
                : (scan.incompleteReason ?? 'The run stopped before completing its collection plan.')}
              {' These scores are available now, but they are not the published report.'}
            </p>
            {reviewIssue != null && <p className="wa-caption text-wa-danger">{reviewIssue}</p>}
            {requirementsIssue != null && <p className="wa-caption text-wa-danger">{requirementsIssue}</p>}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Link className="wa-button-primary" to={reviewId == null ? '/review' : `/review/${reviewId}`}>
              Complete review
            </Link>
            <Link className="wa-button-secondary" to={`/history/${scan.id}`}>
              Inspect collected evidence
            </Link>
          </div>
        </div>

        <dl className="grid border-t border-wa-divider sm:grid-cols-2 xl:grid-cols-4">
          <Fact label="Scope read">{scope}</Fact>
          <Fact label="Pillars collected">{countPhrase(measured.size, 'pillar')}</Fact>
          <Fact label="Requirement readings">{scan.score.totalControls.toLocaleString()} recorded</Fact>
          <Fact label="Review progress">{progress}</Fact>
        </dl>
      </Surface>

      <Surface
        tone="raised"
        title="Indicative scores by pillar"
        description={
          includesCarriedEvidence
            ? "Based on recorded evidence for this run. Carried-forward pillars name the earlier scan that measured them. These are not the published report's scores."
            : includesOtherEvidence
              ? "Based on this scan's recorded evidence mix. These are not the published report's scores."
              : "Based on automated observations from this scan. These are not the published report's scores."
        }
        label="Indicative pillar scores"
      >
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-7">
          {pillars.map((pillar) => {
            const standing = standingOf(pillar.id, measured, review, reviewLoading, reviewIssue);
            const score = scan.score.pillars.find((one) => one.pillarId === pillar.id);
            const measurement = scan.measurement.find((one) => one.pillarId === pillar.id);
            const coverage = score == null ? undefined : pillarCoverage(score);
            const humanAttention = requirements
              ?.filter((requirement) => requirement.pillarId === pillar.id)
              .filter((requirement) => attentionReason(requirement) != null).length;
            return (
              <li key={pillar.id} className="wa-scorecard">
                <span className="flex items-start gap-1.5">
                  <span aria-hidden className="wa-icon-frame">
                    <PillarIcon pillarId={pillar.id} className="h-3.5 w-3.5" />
                  </span>
                  <span
                    className="wa-caption wa-scorecard-label pt-0.5 font-semibold text-wa-text"
                    title={pillar.title}
                  >
                    {shortPillarLabel(pillar.id, pillar.title)}
                  </span>
                </span>

                <span className="wa-label text-wa-text-secondary">Indicative score</span>
                {score?.score != null && score.scored > 0 ? (
                  <Value score={score.score} range={score.range} />
                ) : (
                  <span className="wa-scorecard-value flex flex-col gap-0.5">
                    <span className="wa-metric-value text-wa-unmeasured">—</span>
                    <span className="wa-body-compact font-medium text-wa-text-muted">Not assessed</span>
                  </span>
                )}

                {coverage != null && (
                  <div className="space-y-1 border-t border-wa-divider pt-2">
                    <p className="wa-caption text-wa-text-secondary">
                      {coverage.assessed.toLocaleString()} of {coverage.applicable.toLocaleString()} applicable
                      evaluated
                    </p>
                    <p className="wa-caption text-wa-text-muted">
                      {evidenceMix(
                        score?.composition.observed ?? 0,
                        score?.composition['admin-collected'] ?? 0,
                        score?.composition.attested ?? 0
                      )}
                    </p>
                    <p className={`wa-caption ${(humanAttention ?? 0) > 0 ? 'text-wa-warning' : 'text-wa-text-muted'}`}>
                      {requirementsIssue != null
                        ? 'Human-evidence questions unavailable'
                        : humanAttention == null && requirementsLoading
                          ? 'Reading human-evidence questions'
                          : humanAttention == null
                            ? 'Human-evidence questions not read'
                            : humanAttention > 0
                              ? `${countPhrase(humanAttention, 'human-evidence question')} ${humanAttention === 1 ? 'needs' : 'need'} attention`
                              : 'No human-evidence questions need attention'}
                    </p>
                  </div>
                )}

                {measurement?.carriedForward === true && (
                  <p className="wa-caption inline-flex items-start gap-1 text-wa-text-secondary">
                    <History aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>
                      Carried forward from{' '}
                      <Link
                        className="font-semibold text-wa-action hover:underline"
                        to={`/history/${measurement.scanId}`}
                      >
                        the {measuredDate(measurement.measuredAt)} scan
                      </Link>
                    </span>
                  </p>
                )}

                <div className="mt-auto flex flex-col items-start gap-2 pt-1">
                  {standing !== AWAITING && (
                    <Badge tone={standing.tone} Icon={standing.Icon}>
                      {standing.label}
                    </Badge>
                  )}
                  <Link
                    className="wa-caption font-semibold text-wa-action hover:underline"
                    to={reviewPath(reviewId, pillar.id)}
                  >
                    {(humanAttention ?? 0) > 0
                      ? `Review ${countPhrase(humanAttention ?? 0, 'question')}`
                      : 'Review this pillar'}
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      </Surface>
    </div>
  );
}
