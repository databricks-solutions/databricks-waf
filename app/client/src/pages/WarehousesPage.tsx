// Whether each SQL warehouse is the right size and shape for what it was actually asked to do.
//
// The third page in the Optimisation group, and the one that answers to a configuration rather than to a
// query. The workloads page beside it says which statement to change; this says which warehouse to change,
// and they are usually owned by different people.
//
// Nothing here changes the score. The header says so, in the same words the other two pages use.
//
// Four things the layout is deliberate about:
//
//   Warehouses with a finding are lifted above the ones without, and the order within the findings is what
//   went wrong first and what could be cheaper last. Leading with the saving would invite a reader to
//   shrink a warehouse whose statements are already queueing for capacity.
//
//   "No findings" is never shown as an empty list. It is one of three sentences — this coped, nobody used
//   it, or we were the ones using it — and the state badge carries which.
//
//   The current configuration is on the row, not behind a click. The advice is "add a cluster" or "try one
//   size down", and neither means anything without the size and cluster range it is relative to.
//
//   The utilisation figure is explained wherever it appears. It looks like a CPU number and is not one, and
//   a reader who took a warehouse at 6% for an idle CPU would reach for the wrong lever.

import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AlertTriangle } from 'lucide-react';
import { useAdvisor } from '../api/advisor-context';
import { RaiseFromAdvice } from '../components/RaiseFromAdvice';
import { AdvisoryRunNotice, RunAdvisoryControl } from '../components/RunAdvisoryControl';
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
  capSentence,
  carriedSentence,
  clustersSentence,
  configurationLine,
  leadSizingFinding,
  NOT_SCORED,
  paidDiffers,
  rulesSentence,
  sizingSentence,
  SIZING_ICON,
  stateFacts,
  utilisationSentence,
  workloadLine,
} from './warehouse-language';
import { bytes, CONFIDENCE_LABEL, duration, evidencePhrase, SEVERITY_LABEL, SEVERITY_TONE } from './workload-language';
import { actionableRows } from './specialist-opportunities';
import type { Sizing, SizingFinding, WarehouseSizing, WarehouseState } from '../api/types';

const ALL = 'all';

const EMPTY: readonly WarehouseSizing[] = [];
const PAGE_SIZE = 10;

export function WarehousesPage() {
  const advisor = useAdvisor();
  const [params, setParams] = useSearchParams();

  const selectedId = params.get('warehouse');

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === '' || value === ALL) next.delete(key);
    else next.set(key, value);
    if (key !== 'warehouse') next.delete('warehouse');
    setParams(next, { replace: true });
  };

  const analysis = advisor.advisory?.sizing;
  const all = analysis?.warehouses ?? EMPTY;
  const rows = useMemo(() => actionableRows(all), [all]);

  const selectedAt = rows.findIndex((one) => one.warehouseId === selectedId);
  const paged = usePaged(rows, PAGE_SIZE, selectedAt);
  const { row: selected, missing } = selectionFrom({
    all: rows,
    page: paged.rows,
    asked: selectedId,
    at: selectedAt,
    known: rows.some((one) => one.warehouseId === selectedId),
  });
  const pane = useRevealedPane(selectedId);

  if (advisor.error != null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Warehouse analysis unavailable">
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

  // The server's own sentence: either the advisor has not run here yet, or this install has no advisor.
  if (advisor.reason != null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Warehouse analysis status">
          <EmptyState
            reason="not-yet-collected"
            heading={advisor.advising ? 'Reading how the warehouses ran' : 'No warehouse analysis yet'}
            detail={advisor.adviseError ?? advisor.reason}
          />
        </Surface>
      </CustomerPage>
    );
  }

  if (analysis == null) {
    // A finished run with no analysis could not read the two tables this needs, which is a different answer
    // from an estate whose warehouses are all correctly sized.
    //
    // `advising` is checked first, and not checking it was a real defect: a reader who had run the advisor
    // before landed in this branch for the ninety seconds of the next run and was shown a permissions
    // verdict — with the header beside it saying "Advising" and a spinner turning. The page said two
    // opposite things at once, and the one in the body sent them to Checks to debug a grant that was fine.
    //
    // What the finished branch says was wrong for a related reason, and the correction is narrower than it
    // looks. It named a permission as the cause. On labs, four consecutive runs by one identity produced no
    // sizing while each of them ranked forty query shapes out of the very query history the message said
    // could not be read, and the next identical run produced a full analysis. So a grant is one possible
    // cause of the several this page cannot distinguish between, and asserting it sent a reader to check
    // something that was never wrong. It now says what is known — no sizing came back — names both tables,
    // and leaves the diagnosis to the page that reads them one at a time.
    const blind = !advisor.advising && advisor.advisory != null;
    return (
      <CustomerPage>
        <Surface tone="task" label="Warehouse analysis status">
          <EmptyState
            reason={blind ? 'collector-failed' : 'not-yet-collected'}
            heading={blind ? 'This run produced no warehouse sizing' : 'Reading how the warehouses ran'}
            detail={
              blind
                ? 'This page is built from two tables — the query history and the warehouse event stream — and the run got no usable answer from at least one of them, so it cannot say whether any warehouse is the right size. That can be a grant this identity does not hold, or a read that failed on the day; running the advisor again distinguishes the two. The checks page names both tables and what reading each one needs.'
                : 'Measuring what each warehouse was asked to do against the uptime it was billed for. This takes a minute or two.'
            }
            action={
              blind ? (
                <Link to="/checks" className="wa-button-secondary">
                  See what it reads
                </Link>
              ) : (
                <RunAdvisoryControl />
              )
            }
          />
        </Surface>
      </CustomerPage>
    );
  }

  return (
    <CustomerPage>
      <Summary analysis={analysis} />

      {rows.length === 0 && (
        <Surface tone="section" label="Warehouse analysis result">
          <EmptyState
            reason={all.length === 0 ? 'nothing-to-report' : 'filtered-out'}
            heading={all.length === 0 ? 'No warehouse to size' : 'No warehouse opportunities'}
            detail={
              all.length === 0
                ? 'The window recorded no SQL warehouse at all — no statements and no starts. That is ordinary in an estate whose querying is all on serverless notebook or job compute, which has no size to advise on.'
                : 'No analyzed warehouse carries a sizing recommendation. Coverage and warehouses without an action are summarized above.'
            }
          />
        </Surface>
      )}

      {rows.length > 0 && (
        <TaskWorkspace
          queueLabel="Warehouse opportunities"
          taskLabel="Selected warehouse opportunity"
          queue={
            <Surface
              tone="section"
              title="Warehouse opportunities"
              description={`${String(paged.total)} ${paged.total === 1 ? 'warehouse needs' : 'warehouses need'} attention`}
            >
              <RecordList label="Warehouse opportunities">
                {paged.rows.map((warehouse) => (
                  <RecordButton
                    key={warehouse.warehouseId}
                    selected={warehouse.warehouseId === selected?.warehouseId}
                    onSelect={() => set('warehouse', warehouse.warehouseId)}
                    eyebrow={<StateBadge state={warehouse.state} />}
                    title={warehouse.name}
                    summary={configurationLine(warehouse)}
                    meta={[workloadLine(warehouse), leadSizingFinding(warehouse)]
                      .filter((part): part is string => part != null)
                      .join(' · ')}
                    aside={warehouse.warehouseId === selected?.warehouseId ? 'Selected' : 'Open'}
                  />
                ))}
              </RecordList>
              <Pagination paged={paged} noun="warehouses" />
              <TechnicalDisclosure
                label="Analysis coverage"
                hint={`${String(all.length - rows.length)} clean analyzer ${all.length - rows.length === 1 ? 'row' : 'rows'} omitted`}
              >
                <p className="wa-body-compact">
                  {rows.length.toLocaleString()} warehouse {rows.length === 1 ? 'opportunity' : 'opportunities'} shown.{' '}
                  {(all.length - rows.length).toLocaleString()} analyzer{' '}
                  {all.length - rows.length === 1 ? 'row is' : 'rows are'} omitted because{' '}
                  {all.length - rows.length === 1 ? 'it carries' : 'they carry'} no recommendation.{' '}
                  {rulesSentence(analysis)}
                </p>
              </TechnicalDisclosure>
            </Surface>
          }
          task={
            <div ref={pane}>
              <Surface
                tone="task"
                title={selected?.name ?? 'Select a warehouse opportunity'}
                description="What it was asked to do, what it was billed for, and the exact sizing action."
              >
                {missing != null ? (
                  <NotInList
                    id={missing.id}
                    known={missing.known}
                    noun="warehouse"
                    onClear={(keep) =>
                      setParams(onlySelection('warehouse', keep ? missing.id : null), { replace: true })
                    }
                  />
                ) : selected == null ? (
                  <EmptyState
                    reason="not-yet-collected"
                    heading="Choose a warehouse opportunity"
                    detail="Select a warehouse to read what it was asked to do, what it was billed for, and what to change about it."
                  />
                ) : (
                  <Selected key={selected.warehouseId} warehouse={selected} />
                )}
              </Surface>
            </div>
          }
        />
      )}
    </CustomerPage>
  );
}

function Summary({ analysis }: { analysis: Sizing }) {
  const cap = capSentence(analysis);
  return (
    <Surface
      tone="accent"
      title={`The last ${String(analysis.windowDays)} days of warehouse activity`}
      description={NOT_SCORED}
    >
      <div className="space-y-2">
        <p className="wa-body-compact">{sizingSentence(analysis)}</p>
        {cap != null && <p className="wa-caption">{cap}</p>}
        <AdvisoryRunNotice />
      </div>
    </Surface>
  );
}

function Selected({ warehouse }: { warehouse: WarehouseSizing }) {
  // The advisory these findings were read from, so a link out of one can name which run said it.
  const advisoryId = useAdvisor().advisory?.id;
  const utilisation = utilisationSentence(warehouse);
  const carried = carriedSentence(warehouse);
  const clusters = clustersSentence(warehouse);
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" Icon={SIZING_ICON}>
            {warehouse.size ?? 'Size unknown'}
          </Badge>
          <StateBadge state={warehouse.state} />
          <IdentifierBadge>{warehouse.warehouseId}</IdentifierBadge>
        </div>
        <p className="wa-caption">{configurationLine(warehouse)}</p>
        <p className="wa-caption">{stateFacts(warehouse.state).detail}</p>
      </div>

      {warehouse.findings.length > 0 && (
        <div className="space-y-2">
          {warehouse.findings.map((finding) => (
            <Finding key={finding.rule} finding={finding} warehouse={warehouse} advisoryId={advisoryId} />
          ))}
        </div>
      )}

      <div>
        <h2 className="wa-label">What it was asked to do</h2>
        <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
          <Measure label="Statements" value={warehouse.runs.toLocaleString()} />
          <Measure label="Days it ran" value={String(warehouse.daysUsed)} />
          <Measure label="Elapsed" value={duration(warehouse.totalMs)} />
          <Measure label="Executing" value={duration(warehouse.busyMs)} />
          {warehouse.p95Ms != null && <Measure label="Slowest 5% within" value={duration(warehouse.p95Ms)} />}
          {warehouse.worstMs != null && <Measure label="Worst statement" value={duration(warehouse.worstMs)} />}
          <Measure label="Queued" value={duration(warehouse.queueMs)} />
          <Measure label="Spilled" value={bytes(warehouse.spilledBytes)} />
        </dl>
        {/* Named rather than left to be inferred from the two counts. A warehouse whose statements were
            partly cached or cancelled has timings over the subset that ran. */}
        {warehouse.measuredRuns < warehouse.runs && (
          <p className="wa-caption mt-1">
            {(warehouse.runs - warehouse.measuredRuns).toLocaleString()} of these statements were not timed — served
            from cache, cancelled, or failed. The figures above are over the {warehouse.measuredRuns.toLocaleString()}{' '}
            that were.
          </p>
        )}
      </div>

      <div>
        <h2 className="wa-label">What it was billed for</h2>
        <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
          <Measure label="Time up" value={duration(warehouse.upMs)} />
          {/* Only where the rendered figures differ, not the raw ones. See `paidDiffers`. */}
          {paidDiffers(warehouse) && <Measure label="Paid cluster time" value={duration(warehouse.clusterMs)} />}
          <Measure label="Times it started" value={warehouse.starts.toLocaleString()} />
          <Measure label="Clusters at peak" value={String(warehouse.peakClusters)} />
          <Measure label="Users on the busiest day" value={String(warehouse.peakUsers)} />
        </dl>
        {utilisation != null && <p className="wa-caption mt-1">{utilisation}</p>}
        {/* Where the uptime began before the window. Beside the uptime rather than beside the starts,
            because it is the figure it qualifies. See `carriedSentence`. */}
        {carried != null && <p className="wa-caption mt-1">{carried}</p>}
        {clusters != null && <p className="wa-caption mt-1">{clusters}</p>}
      </div>
    </div>
  );
}

function Finding({
  finding,
  warehouse,
  advisoryId,
}: {
  finding: SizingFinding;
  warehouse: WarehouseSizing;
  advisoryId?: string;
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
        <>
          {/* The size the advice is relative to, named rather than implied. "One size down" is not an
              instruction until the reader knows which size that is, and the ladder is the platform's. */}
          {finding.rule === 'WAREHOUSE_HEADROOM' && warehouse.nextSizeDown != null && (
            <p>
              The next size down from {warehouse.size ?? 'its current size'} is {warehouse.nextSizeDown}.
            </p>
          )}
          <ul className="wa-caption flex flex-wrap gap-x-3 gap-y-0.5">
            {finding.evidence.map((one) => (
              <li key={one.label} className="wa-code">
                {evidencePhrase(one)}
              </li>
            ))}
          </ul>
        </>
      }
      qualification={
        <>
          <p>{finding.detail}</p>
          <p>{CONFIDENCE_LABEL[finding.confidence]}</p>
          {finding.rationale != null && <p>{finding.rationale}</p>}
        </>
      }
      resourceUrl={warehouse.link}
      resourceLabel="Open warehouse in Databricks"
      guidanceUrl={finding.docUrl}
      action={
        <RaiseFromAdvice
          primary={warehouse.link == null}
          advisoryId={advisoryId}
          advisor="sizing"
          resource={warehouse.warehouseId}
          rule={finding.rule}
        />
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

function StateBadge({ state }: { state: WarehouseState }) {
  // Through `stateFacts` rather than the records directly, because a stored advisory can name a state this
  // build does not have. Indexing straight into them handed React an undefined component and turned the
  // page into an error boundary. See `warehouse-language.ts`.
  const { label, tone, Icon, detail } = stateFacts(state);
  return (
    <Badge tone={tone} Icon={Icon} title={detail}>
      {label}
    </Badge>
  );
}
