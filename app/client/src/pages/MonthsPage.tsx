// The monthly cadence, as a page: preview while the month is still moving, published once it is frozen.
//
// ADR 0072 is the contract. Preview carries a named sentence and no digest, and offers publish.
// Published shows the instant, the digest, who acted, and whether this copy is superseded, and offers
// only a correction. The figures themselves are the same seven sections either way — strings the
// server already resolved — so this file does not join titles, recompute comparability, or guess
// which of two unsuperseded copies is "the" current one.

import { useCallback, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router';
import {
  useMonthDocument,
  useMonthPreview,
  useMonths,
  useMonthStanding,
  usePublishMonth,
  useSupersedeMonth,
} from '../api/hooks';
import type { MonthContent, MonthDocument, MonthPreview, PublishedMonth } from '../api/types';
import { CustomerPage, Surface, TaskWorkspace } from '../components/system';
import { EmptyState, type EmptyReason } from '../components/ui/EmptyState';
import { MonthFigures, PublishedHeader, PublishAction } from './MonthView';
import {
  MIN_SUPERSEDE_REASON,
  monthRowCaption,
  monthTitle,
  navigatorMonths,
  NOT_DURABLE_NOTE,
  PREVIEW_NOTE,
  standingCountNote,
  standingPhrase,
} from './month-language';

export function MonthsIndexPage() {
  const months = useMonths();
  if (months.error != null) {
    return <PageEmpty reason="collector-failed" heading="Could not load the months" detail={months.error} />;
  }
  if (months.data == null) {
    return (
      <PageEmpty reason="not-yet-collected" heading="Loading" detail="Reading which months have been published." />
    );
  }
  return <Navigate to={`/months/${months.data.currentMonth}`} replace />;
}

export function MonthPage() {
  const { month: raw } = useParams();
  const month = raw != null && monthTitle(raw) != null ? raw : undefined;
  const months = useMonths();
  const standing = useMonthStanding(month);
  const preview = useMonthPreview(month);
  const [params, setParams] = useSearchParams();
  const requested = params.get('publication') ?? undefined;

  const publications = standing.data?.publications ?? [];
  const selectedId = viewedPublicationId(requested, publications);
  const selected = publications.find((one) => one.id === selectedId);
  const document = useMonthDocument(month, selected?.id);

  /**
   * A write changes which copy is latest. The previous `?publication=` still names a row that
   * exists — the one just superseded — so selection would stay there unless the param moves onto
   * the id the write returned.
   */
  const afterWrite = useCallback(
    (id?: string) => {
      if (id == null) setParams({}, { replace: true });
      else setParams({ publication: id }, { replace: true });
      months.reload();
      standing.reload();
      preview.reload();
      document.reload();
    },
    [setParams, months, standing, preview, document]
  );

  if (month == null) {
    return (
      <PageEmpty reason="filtered-out" heading="Not a month" detail="A month is YYYY-MM, with the month in 01–12." />
    );
  }

  if (months.error != null || standing.error != null || preview.error != null) {
    return (
      <PageEmpty
        reason="collector-failed"
        heading="Could not load this month"
        detail={months.error ?? standing.error ?? preview.error ?? 'The month could not be read.'}
      />
    );
  }

  if (months.data == null || standing.data == null || preview.data == null) {
    return <PageEmpty reason="not-yet-collected" heading="Loading" detail={`Reading ${monthTitle(month)}.`} />;
  }

  const label = standing.data.label;
  const list = months.data;
  const published = list.months;
  const listed = navigatorMonths(list.currentMonth, published);

  return (
    <CustomerPage>
      <TaskWorkspace
        queueLabel="Months"
        taskLabel="Selected month"
        queue={
          <Surface tone="raised" title="Months" description={`${String(listed.length)} available`}>
            <ul className="wa-zebra">
              {listed.map((id) => (
                <li key={id}>
                  <Link to={`/months/${id}`} className="wa-row" data-selected={id === month ? true : undefined}>
                    <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                      <span className="wa-body-compact truncate font-medium text-wa-text">{monthTitle(id) ?? id}</span>
                      <span className="wa-caption">{monthRowCaption(id, list.currentMonth, published)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Surface>
        }
        task={
          <MonthDetail
            month={month}
            label={label}
            preview={preview.data}
            publications={publications}
            standingIds={standing.data.standing}
            selected={selected}
            document={document.data}
            documentError={document.error}
            onSelectPublication={(id) => setParams({ publication: id }, { replace: true })}
            onChanged={afterWrite}
          />
        }
      />
    </CustomerPage>
  );
}

/**
 * The selected month: preview or a published copy, and the action that moves between them.
 *
 * Exported so a test can render the claims without mounting the hooks.
 */
export function MonthDetail({
  month,
  label,
  preview,
  publications,
  standingIds,
  selected,
  document,
  documentError,
  onSelectPublication,
  onChanged,
}: {
  readonly month: string;
  readonly label: string;
  readonly preview: MonthPreview;
  readonly publications: readonly PublishedMonth[];
  readonly standingIds: readonly string[];
  readonly selected?: PublishedMonth;
  readonly document?: MonthDocument;
  readonly documentError?: string;
  readonly onSelectPublication: (id: string) => void;
  readonly onChanged: (id?: string) => void;
}) {
  const publish = usePublishMonth(month, onChanged);
  const supersede = useSupersedeMonth(month);
  const [reason, setReason] = useState('');
  const short = reason.trim().length < MIN_SUPERSEDE_REASON;
  const latest = publications[publications.length - 1];
  const viewingLatest = selected != null && latest != null && selected.id === latest.id;
  const publishedMode = selected != null;
  const content: MonthContent | undefined =
    publishedMode && document != null
      ? {
          runHealth: document.runHealth,
          findingDeltas: document.findingDeltas,
          movement: document.movement,
          actions: document.actions,
          exceptions: document.exceptions,
          outcomes: document.outcomes,
          // Forwarded as it came, undefined included: a document frozen before the section existed
          // does not carry it, and filling in an empty one here would turn bytes that say nothing
          // about a review into a page that says there was no record of one.
          review: document.review,
          trend: document.trend,
        }
      : publishedMode
        ? undefined
        : preview.content;

  return (
    <Surface tone="task" label={label} title={label} description={month}>
      <div className="space-y-4">
        {publications.length > 0 && (
          <div className="space-y-2">
            {standingCountNote(standingIds.length) != null && (
              <p className="wa-body-compact">{standingCountNote(standingIds.length)}</p>
            )}
            <ul className="space-y-1">
              {publications.map((one) => (
                <li key={one.id}>
                  <button
                    type="button"
                    className={`wa-body-compact text-left ${one.id === selected?.id ? 'font-medium text-wa-text' : 'text-wa-text-secondary hover:underline'}`}
                    onClick={() => onSelectPublication(one.id)}
                  >
                    {standingPhrase(one)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {publishedMode && selected != null ? (
          <PublishedHeader publication={selected} month={month} />
        ) : (
          <p className="wa-body-compact">{PREVIEW_NOTE}</p>
        )}

        {!preview.durable && <p className="wa-caption">{NOT_DURABLE_NOTE}</p>}

        {publications.length === 0 && (
          <PublishAction
            preview={preview}
            label={label}
            working={publish.working}
            error={publish.error}
            onPublish={publish.publish}
          />
        )}

        {viewingLatest && preview.durable && (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (short || supersede.saving || latest == null) return;
              void supersede.send({ supersedes: latest.id, reason: reason.trim() }).then((id) => {
                if (id == null) return;
                setReason('');
                onChanged(id);
              });
            }}
          >
            <label className="wa-label" htmlFor={`supersede-${month}`}>
              Why this month is being corrected
            </label>
            <textarea
              className="wa-textarea wa-body-compact"
              id={`supersede-${month}`}
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
            />
            <p className="wa-caption">
              {short
                ? `At least ${String(MIN_SUPERSEDE_REASON - reason.trim().length)} more characters.`
                : 'Long enough.'}
            </p>
            {supersede.error != null && (
              <p className="wa-body-compact text-wa-danger" role="alert">
                {supersede.error}
              </p>
            )}
            <button type="submit" className="wa-button-primary" disabled={short || supersede.saving}>
              {supersede.saving ? 'Correcting…' : 'Publish a correction'}
            </button>
          </form>
        )}

        {documentError != null && selected != null && (
          <p className="wa-body-compact text-wa-danger" role="alert">
            {documentError}
          </p>
        )}

        {content != null && <MonthFigures content={content} />}
      </div>
    </Surface>
  );
}

/**
 * Which publication the page shows: the requested id if it still names a row of this month,
 * otherwise the latest.
 *
 * A superseded copy stays in the list, so a `?publication=` that pointed at the standing one
 * before a correction still matches after. The write path has to retarget the param; this
 * function does not infer "they wanted the latest".
 */
export function viewedPublicationId(
  requested: string | undefined,
  publications: readonly { readonly id: string }[]
): string | undefined {
  if (requested != null && publications.some((one) => one.id === requested)) return requested;
  return publications.at(-1)?.id;
}

function PageEmpty({ reason, heading, detail }: { reason: EmptyReason; heading: string; detail: string }) {
  return (
    <CustomerPage>
      <Surface tone="task">
        <EmptyState reason={reason} heading={heading} detail={detail} />
      </Surface>
    </CustomerPage>
  );
}
