// Which queries cost the most, what is wrong with each, and whether it is getting worse.
//
// The estate's query history, grouped by the shape of the statement rather than by the statement, so
// a query that ran 40,000 times is one row and not 40,000. Twelve shapes, ranked by a composite of
// duration, volume, frequency, shuffle, spill and pruning — not by total time, because a query that
// takes 20 seconds ten thousand times matters more than one that takes half an hour once, and a
// duration sort puts the second at the top and the first nowhere.
//
// Nothing here changes the score, and the header says so rather than a footnote saying so. This is
// the second page in the Optimisation group for the same reason the first one is: a reader who finds
// performance advice beside a number reasonably assumes it moves the number.
//
// Four things the layout is deliberate about:
//
//   Coverage is above the list, not under it. The analysis does not rank materialised-view refreshes
//   — managed, with no query to change — and on the estate the thresholds were calibrated against
//   that was most of the query time. A reader who is not told that takes this list for the estate.
//
//   Failures are their own list, not a severity. A query that fails 8% of the time is not a slow
//   query, and ranking it by cost would bury it under twelve expensive ones that work.
//
//   The trend sits beside the cost rather than under it, because "always slow" and "40% slower than
//   last fortnight" send a reader to two different places, and the second one is a diff.
//
//   The query text is shown. It is the customer's own workspace, the reader already has the query
//   history it came from, and a finding about `118d86d07db5ece6` is a finding nobody can act on.

import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AlertTriangle } from 'lucide-react';
import { useAdvisor } from '../api/advisor-context';
import { RaiseFromAdvice } from '../components/RaiseFromAdvice';
import { AdvisoryRunNotice } from '../components/RunAdvisoryControl';
import { SpecialistOpportunity } from '../components/SpecialistOpportunity';
import {
  CustomerPage,
  RecordButton,
  RecordList,
  Surface,
  TaskWorkspace,
  TechnicalDisclosure,
} from '../components/system';
import { EmptyState } from '../components/ui/EmptyState';
import { Pagination } from '../components/ui/Pagination';
import { NotInList } from '../components/ui/NotInList';
import { onlySelection, selectionFrom, usePaged } from '../components/ui/paging';
import { useRevealedPane } from '../components/ui/reveal';
import { Badge, IdentifierBadge } from '../components/ui/StatusBadge';
import {
  CONFIDENCE_LABEL,
  coverageSentence,
  duration,
  evidencePhrase,
  leadFinding,
  representativeCaveat,
  SEVERITIES,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  shapeSentence,
  SHAPE_ICON,
  TREND_DETAIL,
  TREND_ICON,
  TREND_LABEL,
  TREND_TONE,
  trendSentence,
  versionSentence,
} from './workload-language';
import { actionableWorkloads } from './specialist-opportunities';
import type { Workload, WorkloadFinding, WorkloadShape } from '../api/types';

const ALL = 'all';

const EMPTY: readonly WorkloadShape[] = [];
const PAGE_SIZE = 10;

export function WorkloadsPage() {
  const advisor = useAdvisor();
  const [params, setParams] = useSearchParams();

  const severity = params.get('severity') ?? ALL;
  const selectedId = params.get('shape');

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === '' || value === ALL) next.delete(key);
    else next.set(key, value);
    if (key !== 'shape') next.delete('shape');
    setParams(next, { replace: true });
  };

  const analysis = advisor.advisory?.workload;
  const all = useMemo(
    () => actionableWorkloads(analysis?.top ?? EMPTY, analysis?.failing ?? EMPTY),
    [analysis?.failing, analysis?.top]
  );
  const rows = useMemo(
    () => (severity === ALL ? all : all.filter((shape) => shape.findings.some((f) => f.severity === severity))),
    [all, severity]
  );

  const selectedAt = rows.findIndex((shape) => shape.shape === selectedId);
  const paged = usePaged(rows, PAGE_SIZE, selectedAt);
  const { row: selected, missing } = selectionFrom({
    all: rows,
    page: paged.rows,
    asked: selectedId,
    at: selectedAt,
    known: rows.some((shape) => shape.shape === selectedId),
  });
  const pane = useRevealedPane(selectedId);

  if (advisor.error != null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Workload analysis unavailable">
          <EmptyState
            reason="collector-failed"
            heading="The analysis could not be read"
            detail={advisor.error}
            action={
              <button type="button" className="wa-button-secondary" onClick={advisor.reload}>
                Try again
              </button>
            }
          />
        </Surface>
      </CustomerPage>
    );
  }

  // The server's own sentence: either the advisor has not run here yet, or this install has no
  // advisor at all. Both are ordinary and neither is an error.
  if (advisor.reason != null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Workload analysis status">
          <EmptyState
            reason="not-yet-collected"
            heading={advisor.advising ? 'Reading the query history' : 'No workload analysis yet'}
            detail={advisor.adviseError ?? advisor.reason}
          />
        </Surface>
      </CustomerPage>
    );
  }

  if (analysis == null) {
    // A finished run with no analysis could not read the query history, which is a different answer
    // from an estate with no queries — and telling a customer they have nothing to optimise when a
    // grant is missing is the worse wrong answer of the two.
    const blind = advisor.advisory != null;
    return (
      <CustomerPage>
        <Surface tone="task" label="Workload analysis status">
          <EmptyState
            reason={blind ? 'collector-failed' : 'not-yet-collected'}
            heading={blind ? 'The query history could not be read' : 'Reading the query history'}
            detail={
              blind
                ? 'The advisor ran but could not read how queries performed in this window, so it cannot say which of them to change. The checks page lists what it reads and the permission that needs.'
                : 'Grouping similar query executions, and working out which groups cost the most.'
            }
            {...(blind
              ? {
                  action: (
                    <Link to="/checks" className="wa-button-secondary">
                      See what it reads
                    </Link>
                  ),
                }
              : {})}
          />
        </Surface>
      </CustomerPage>
    );
  }

  const counts = severityCounts(all);

  const filters = counts.some(([, count]) => count > 0) ? (
    <div className="wa-segmented flex-wrap" role="group" aria-label="Filter by severity">
      <Filter
        label={`All opportunities (${all.length})`}
        active={severity === ALL}
        onClick={() => set('severity', ALL)}
      />
      {counts
        .filter(([, count]) => count > 0)
        .map(([value, count]) => (
          <Filter
            key={value}
            label={`${SEVERITY_LABEL[value]} (${String(count)})`}
            active={severity === value}
            onClick={() => set('severity', value)}
          />
        ))}
    </div>
  ) : undefined;

  return (
    <CustomerPage>
      <Summary analysis={analysis} />

      {all.length === 0 && (
        <Surface tone="section" label="Query analysis result">
          <EmptyState
            reason="nothing-to-report"
            heading="No query opportunities"
            detail="No ranked or failure-tracked query group carries a recommendation. Coverage is summarized above; query groups without an action are not listed here."
          />
        </Surface>
      )}

      {all.length > 0 && (
        <TaskWorkspace
          queueLabel="Query opportunities"
          taskLabel="Selected query opportunity"
          queue={
            <Surface
              tone="section"
              title="Query opportunities"
              description={`${String(paged.total)} ${paged.total === 1 ? 'query group needs' : 'query groups need'} attention`}
              action={filters}
            >
              {paged.total === 0 ? (
                <EmptyState
                  reason="filtered-out"
                  heading="No opportunities at this severity"
                  detail="No query group carries a finding at that severity. Clearing the filter will bring the rest back."
                  action={
                    <button type="button" className="wa-customer-secondary-action" onClick={() => set('severity', ALL)}>
                      Show all opportunities
                    </button>
                  }
                />
              ) : (
                <>
                  <RecordList label="Query opportunities">
                    {paged.rows.map((shape) => (
                      <RecordButton
                        key={shape.shape}
                        selected={shape.shape === selected?.shape}
                        onSelect={() => set('shape', shape.shape)}
                        eyebrow={shape.statementType}
                        title={shape.statementText ?? shape.statementType}
                        summary={`${shape.runs.toLocaleString()} ${shape.runs === 1 ? 'run' : 'runs'} · ${duration(shape.totalMs)}`}
                        meta={[leadFinding(shape), `Evidence ${shape.shape.slice(0, 8)}`]
                          .filter((part): part is string => part != null)
                          .join(' · ')}
                        aside={<TrendBadge shape={shape} />}
                      />
                    ))}
                  </RecordList>
                  <Pagination paged={paged} noun="query groups" />
                </>
              )}
              <TechnicalDisclosure
                label="Analysis coverage"
                hint={`${String(analysis.considered)} query groups considered`}
              >
                <p className="wa-body-compact">
                  {all.length.toLocaleString()} actionable {all.length === 1 ? 'query group is' : 'query groups are'}{' '}
                  shown from {analysis.considered.toLocaleString()} query groups that ran in this window. Query groups
                  carrying no recommendation are omitted. {versionSentence(analysis)}
                </p>
              </TechnicalDisclosure>
            </Surface>
          }
          task={
            <div ref={pane}>
              <Surface
                tone="task"
                title={
                  selected == null
                    ? 'Select a query opportunity'
                    : (leadFinding(selected) ?? `${selected.statementType} query opportunity`)
                }
                description="What it cost, what is wrong with it, and the evidence behind the next action."
              >
                {missing != null ? (
                  <NotInList
                    id={missing.id}
                    known={missing.known}
                    noun="query group"
                    onClear={(keep) => setParams(onlySelection('shape', keep ? missing.id : null), { replace: true })}
                  />
                ) : selected == null ? (
                  <EmptyState
                    reason="not-yet-collected"
                    heading="Choose a query opportunity"
                    detail="Select a query group to read what it cost, what is wrong with it, and the numbers behind each finding."
                  />
                ) : (
                  <Selected key={selected.shape} shape={selected} />
                )}
              </Surface>
            </div>
          }
        />
      )}
    </CustomerPage>
  );
}

function Summary({ analysis }: { analysis: Workload }) {
  return (
    <Surface
      tone="accent"
      title={`The last ${String(analysis.windowDays)} days of query history`}
      description="Not scored"
    >
      <div className="space-y-2">
        <p className="wa-body-compact">{shapeSentence(analysis)}</p>
        {/* The disclosure, above the list rather than beneath it. */}
        <p className="wa-caption">{coverageSentence(analysis.coverage)}</p>
        <AdvisoryRunNotice />
      </div>
    </Surface>
  );
}

function Selected({ shape }: { shape: WorkloadShape }) {
  // The advisory these findings were read from, so a link out of one can name which run said it.
  const advisoryId = useAdvisor().advisory?.id;
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" Icon={SHAPE_ICON}>
            {shape.statementType}
          </Badge>
          <TrendBadge shape={shape} measured />
          <IdentifierBadge>{shape.shape}</IdentifierBadge>
        </div>
        <p className="wa-caption">{TREND_DETAIL[shape.trend.kind]}</p>
      </div>

      {shape.findings.length > 0 && (
        <div className="space-y-2">
          {shape.findings.map((finding) => (
            <Finding key={finding.rule} finding={finding} advisoryId={advisoryId} resource={shape.shape} />
          ))}
        </div>
      )}

      {shape.statementText != null && (
        <div>
          <h2 className="wa-label">The query</h2>
          {/* Shown as recorded. See the note at the head of this file on why it is not redacted, and
              why an estate under customer-managed keys has none of this to show. */}
          <pre className="wa-code-block mt-1 rounded-sm bg-wa-surface-subtle">{shape.statementText}</pre>
          {/* Where the shape had no run that measured anything, the text is from one that did not. Said
              because the cost figures below are over other runs than this one, and a reader opening the
              profile of a failed execution and finding no plan in it should know why before they do.
              The sentence itself points at neither, so this block can move without falsifying it. */}
          {!shape.representativeMeasured && <p className="wa-caption mt-1">{representativeCaveat(shape)}</p>}
        </div>
      )}

      <div>
        <h2 className="wa-label">What it cost</h2>
        <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
          <Measure label="Runs" value={shape.runs.toLocaleString()} />
          <Measure label="Timed runs" value={shape.measuredRuns.toLocaleString()} />
          <Measure label="Total time" value={duration(shape.totalMs)} />
          {shape.meanMs != null && <Measure label="Mean" value={duration(shape.meanMs)} />}
          {shape.medianMs != null && <Measure label="Median" value={duration(shape.medianMs)} />}
          {shape.worstMs != null && <Measure label="Worst" value={duration(shape.worstMs)} />}
        </dl>
        {/* Named rather than left to be inferred from the two counts above. A shape whose runs and
            timed runs differ was partly served from cache, cancelled or failed, and a mean over the
            difference would be an average of the runs that did work presented as an average of all. */}
        {shape.measuredRuns < shape.runs && (
          <p className="wa-caption mt-1">
            {(shape.runs - shape.measuredRuns).toLocaleString()} of these runs were not timed — served from cache,
            cancelled, or failed. The durations above are over the {shape.measuredRuns.toLocaleString()} that were.
          </p>
        )}
      </div>

      {shape.findings.length === 0 && (
        <p className="wa-body-compact">
          No rule fired on this query group. It is here because it is expensive, not because anything is wrong with it —
          the cheapest way to make it cost less may be to run it less often.
        </p>
      )}

      <p className="wa-caption">
        Ran on {plural(shape.warehouses, 'warehouse')}
        {shape.jobs > 0 ? `, from ${plural(shape.jobs, 'job')}` : ''}
        {shape.pipelines > 0 ? `, from ${plural(shape.pipelines, 'pipeline')}` : ''}.
        {shape.statementId != null ? ` Representative execution ${shape.statementId}.` : ''}
      </p>
    </div>
  );
}

function Finding({
  finding,
  advisoryId,
  resource,
}: {
  finding: WorkloadFinding;
  advisoryId?: string;
  resource: string;
}) {
  return (
    <SpecialistOpportunity
      recommendation={finding.action}
      title={finding.headline}
      detail={finding.evidence.length === 0 ? finding.detail : finding.evidence.map(evidencePhrase).join(' · ')}
      status={
        <Badge tone={SEVERITY_TONE[finding.severity]} Icon={AlertTriangle}>
          {SEVERITY_LABEL[finding.severity]}
        </Badge>
      }
      evidence={
        /* Every finding carries its numbers. A rule that fired and cannot say on what is an opinion,
           and this page's whole claim is that it is not making any. */
        <ul className="wa-caption flex flex-wrap gap-x-3 gap-y-0.5">
          {finding.evidence.map((one) => (
            <li key={one.label} className="wa-code">
              {evidencePhrase(one)}
            </li>
          ))}
        </ul>
      }
      qualification={
        <>
          <p>{finding.detail}</p>
          <p>{CONFIDENCE_LABEL[finding.confidence]}</p>
          {finding.rationale != null && <p>{finding.rationale}</p>}
        </>
      }
      guidanceUrl={finding.docUrl}
      action={
        <RaiseFromAdvice primary advisoryId={advisoryId} advisor="workload" resource={resource} rule={finding.rule} />
      }
    />
  );
}

function Measure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="wa-caption">{label}</dt>
      <dd className="wa-body-compact wa-code text-wa-text">{value}</dd>
    </div>
  );
}

/**
 * How a shape's cost is moving.
 *
 * `measured` is where the badge says how much and not only which way, and it is the pane rather than
 * the list for two reasons that arrived as layout failures. The quantified form is a sentence —
 * "Getting better — 31% faster per run than the previous window" — and a badge is `nowrap`, so at
 * 370px in a 344px row it put the pane 14px past its own edge at both desktop widths. Allowed to wrap
 * there, it is two lines tall and makes the queue harder to scan. So the row states which way and the task states how far,
 * which is also the right way round for
 * a list somebody is scanning: the sentence under the badge in the pane is where the detail already
 * lives.
 */
function TrendBadge({ shape, measured = false }: { shape: WorkloadShape; measured?: boolean }) {
  const kind = shape.trend.kind;
  const said = measured ? trendSentence(shape.trend) : TREND_LABEL[kind];

  return (
    <Badge
      tone={TREND_TONE[kind]}
      Icon={TREND_ICON[kind]}
      title={TREND_DETAIL[kind]}
      {...(said === TREND_LABEL[kind] ? {} : { className: 'wa-badge-sentence' })}
    >
      {said}
    </Badge>
  );
}

function Filter({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}>
      {label}
    </button>
  );
}

/** Severity counts over a list, in worst-first order, for the filter chips. */
function severityCounts(shapes: readonly WorkloadShape[]): readonly (readonly [WorkloadFinding['severity'], number])[] {
  return SEVERITIES.map(
    (severity) =>
      [
        severity,
        shapes.filter((shape) => shape.findings.some((finding) => finding.severity === severity)).length,
      ] as const
  );
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}
