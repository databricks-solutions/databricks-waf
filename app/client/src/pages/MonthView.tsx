// The monthly page's presentational pieces: preview action, published header, and the eight sections.
//
// Kept out of MonthsPage so the claims can be rendered in tests without pulling the shell's AppKit
// charts through a Button import. Native controls, same as the plan close form.

import { Ban, CheckCircle2, CircleDashed, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import { useAssessmentId, withAssessment } from '../api/assessment-id';
import type { MonthContent, MonthPreview, MonthTrendPoint, PublishedMonth } from '../api/types';
import { DigestCaveat } from '../components/ExportedFiles';
import { DataTable, type Column } from '../components/ui/DataTable';
import { Disclosure } from '../components/ui/Disclosure';
import { Badge, type Tone } from '../components/ui/StatusBadge';
import { COMPARABILITY_LABEL, instantDate, publishedBySentence, standingPhrase, unclosedNote } from './month-language';

export function PublishedHeader({
  publication,
  month,
}: {
  readonly publication: PublishedMonth;
  readonly month: string;
}) {
  const definitionId = useAssessmentId();
  const href = (path: string): string => withAssessment(path, definitionId ?? null) ?? path;
  return (
    <div className="space-y-2">
      <p className="wa-body-compact">{standingPhrase(publication)}</p>
      <p className="wa-caption">{publishedBySentence(publication.publishedBy)}</p>
      <p className="wa-caption">
        Published {instantDate(publication.publishedAt)}. Digest{' '}
        <span className="wa-code break-all">{publication.digest}</span>.
      </p>
      <DigestCaveat />
      <p className="wa-body-compact">
        <a
          className="wa-row-link font-medium text-wa-text"
          href={href(`/api/months/${month}/publications/${publication.id}.json`)}
          download
        >
          JSON
        </a>
        {' · '}
        <a
          className="wa-row-link font-medium text-wa-text"
          href={href(`/api/months/${month}/publications/${publication.id}.csv`)}
          download
        >
          CSV
        </a>
      </p>
    </div>
  );
}

export function PublishAction({
  preview,
  label,
  working,
  error,
  onPublish,
}: {
  readonly preview: MonthPreview;
  readonly label: string;
  readonly working: boolean;
  readonly error?: string;
  readonly onPublish: () => void;
}) {
  const disabled = !preview.durable || !preview.closed || !preview.eligibility.eligible || working;
  const blockedReview =
    !preview.eligibility.eligible &&
    preview.eligibility.reason.code === 'review-incomplete' &&
    preview.reviewId != null;
  return (
    <div className="space-y-2">
      {!preview.closed && (
        <p className="wa-caption">{unclosedNote(label, preview.availableFrom, preview.zone, preview.closedNote)}</p>
      )}
      {/* The server's complete refusal and recovery action. No local boolean may widen this gate. */}
      {!preview.eligibility.eligible && (
        <div
          className="wa-notice-warning space-y-2"
          {...(blockedReview ? { 'data-customer-action': 'recommendation' } : {})}
        >
          <div>
            <p className="wa-label">Do this</p>
            <p className="wa-body-compact font-medium text-wa-text">{preview.eligibility.reason.action}</p>
          </div>
          <div>
            <p className="wa-label">Why</p>
            <p className="wa-body-compact text-wa-text-secondary">{preview.eligibility.reason.message}</p>
          </div>
          {blockedReview && (
            <Link className="wa-button-primary" to={`/review/${preview.reviewId}`}>
              Continue this review
            </Link>
          )}
        </div>
      )}
      {preview.durable && (
        <button
          type="button"
          className={preview.eligibility.eligible ? 'wa-button-primary' : 'wa-button-secondary'}
          disabled={disabled}
          onClick={onPublish}
        >
          {working ? 'Publishing…' : `Publish ${label}`}
        </button>
      )}
      {preview.closingRun != null && (
        <Disclosure summary="Technical run provenance">
          <p>
            Run <span className="wa-code break-all">{preview.closingRun.id}</span>
          </p>
          <p>Finished {new Date(preview.closingRun.finishedAt).toLocaleString()}.</p>
        </Disclosure>
      )}
      {error != null && (
        <p className="wa-body-compact text-wa-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function MonthFigures({ content }: { readonly content: MonthContent }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <FactSection title="Run health" rows={content.runHealth} empty="No assessment runs landed in this month." />
        {/* Omitted, not empty, where the payload does not carry the section: no run closed the month, so
          there is nothing for a review to have been of — or the bytes were frozen before the section
          existed and cannot be asked about a review either way. */}
        {content.review != null && (
          <FactSection
            title="Review"
            rows={content.review}
            empty="This app holds no review record for the run this month reports."
          />
        )}
        <FactSection title="Actions" rows={content.actions} empty="No improvement actions moved in this month." />
        <MovementSection rows={content.movement} />
      </div>

      <Disclosure summary="Detailed month record">
        <div className="space-y-6" data-technical-evidence>
          <FactSection title="Outcomes" rows={content.outcomes} empty="No closing scan was in this month." />
          <DeltaSection rows={content.findingDeltas} />
          <ExceptionSection rows={content.exceptions} />
          <TrendSection rows={content.trend} />
        </div>
      </Disclosure>
    </div>
  );
}

function FactSection({
  title,
  rows,
  empty,
}: {
  readonly title: string;
  readonly rows: readonly { label: string; value: string }[];
  readonly empty: string;
}) {
  return (
    <section aria-label={title} className="space-y-2">
      <h2 className="wa-label-eyebrow text-wa-text">{title}</h2>
      {rows.length === 0 ? (
        <p className="wa-caption">{empty}</p>
      ) : (
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="wa-caption text-wa-text-secondary">{row.label}</dt>
              <dd className="wa-numeric wa-body-compact text-right">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function MovementSection({ rows }: { readonly rows: MonthContent['movement'] }) {
  return (
    <section aria-label="Coverage and score movement" className="space-y-2">
      <h2 className="wa-label-eyebrow text-wa-text">Coverage and score</h2>
      {rows.length === 0 ? (
        <p className="wa-caption">No opening and closing scans both exist for this month, so nothing moved.</p>
      ) : (
        <DataTable
          caption="Coverage and score movement"
          columns={[
            { key: 'label', header: 'Figure', cell: (row) => row.label },
            { key: 'from', header: 'Opened at', cell: (row) => row.from, numeric: true },
            { key: 'to', header: 'Closed at', cell: (row) => row.to, numeric: true },
          ]}
          rows={rows}
          rowKey={(row) => row.label}
          empty={{ reason: 'nothing-to-report', detail: 'No opening and closing scans both exist for this month.' }}
        />
      )}
    </section>
  );
}

function DeltaSection({ rows }: { readonly rows: MonthContent['findingDeltas'] }) {
  return (
    <section aria-label="Finding deltas" className="space-y-2">
      <h2 className="wa-label-eyebrow text-wa-text">Findings that changed</h2>
      <DataTable
        caption="Findings that changed"
        columns={[
          { key: 'control', header: 'Control', cell: (row) => <span className="wa-code">{row.control}</span> },
          { key: 'requirement', header: 'Requirement', cell: (row) => row.requirement },
          { key: 'from', header: 'Opened as', cell: (row) => row.from },
          { key: 'to', header: 'Closed as', cell: (row) => row.to },
          { key: 'note', header: 'Note', cell: (row) => row.note ?? '—' },
        ]}
        rows={rows}
        rowKey={(row) => `${row.control}:${row.from}:${row.to}`}
        empty={{ reason: 'nothing-to-report', detail: 'No finding changed between the opening and closing readings.' }}
      />
    </section>
  );
}

function ExceptionSection({ rows }: { readonly rows: MonthContent['exceptions'] }) {
  return (
    <section aria-label="Exceptions in force" className="space-y-2">
      <h2 className="wa-label-eyebrow text-wa-text">Exceptions in force at close</h2>
      <DataTable
        caption="Exceptions in force at close"
        columns={[
          { key: 'control', header: 'Control', cell: (row) => <span className="wa-code">{row.control}</span> },
          { key: 'requirement', header: 'Requirement', cell: (row) => row.requirement },
          { key: 'owner', header: 'Owner', cell: (row) => row.owner },
          { key: 'residual', header: 'Residual', cell: (row) => row.residual },
          { key: 'until', header: 'Until', cell: (row) => row.until, numeric: true },
        ]}
        rows={rows}
        rowKey={(row) => `${row.control}:${row.owner}:${row.until}`}
        empty={{ reason: 'nothing-to-report', detail: 'No accepted risk was in force when this month closed.' }}
      />
    </section>
  );
}

const COMPARABILITY_PRESENTATION: Readonly<
  Record<MonthTrendPoint['comparability'], { readonly tone: Tone; readonly Icon: LucideIcon }>
> = {
  permitted: { tone: 'success', Icon: CheckCircle2 },
  caveat: { tone: 'warning', Icon: CircleDashed },
  refused: { tone: 'neutral', Icon: Ban },
};

function TrendSection({ rows }: { readonly rows: readonly MonthTrendPoint[] }) {
  const columns: readonly Column<MonthTrendPoint>[] = [
    { key: 'label', header: 'Month', cell: (row) => row.label },
    { key: 'score', header: 'Score', cell: (row) => row.score, numeric: true },
    {
      key: 'comparability',
      header: 'Comparability',
      cell: (row) => {
        const { tone, Icon } = COMPARABILITY_PRESENTATION[row.comparability];
        return (
          <span data-comparability={row.comparability}>
            <Badge tone={tone} Icon={Icon}>
              {COMPARABILITY_LABEL[row.comparability]}
            </Badge>
          </span>
        );
      },
    },
    { key: 'note', header: 'Note', cell: (row) => row.note ?? '—' },
  ];

  return (
    <section aria-label="Trend" className="space-y-2">
      <h2 className="wa-label-eyebrow text-wa-text">Trend</h2>
      <DataTable
        caption="Monthly trend"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.month}
        empty={{
          reason: 'nothing-to-report',
          detail: 'No published months precede this one, so there is no series yet.',
        }}
      />
    </section>
  );
}
