// How the estate's Lakeflow jobs actually ran, and what fired on them.
//
// The fourth page in the Optimisation group. The workloads page says which statement to change and the
// warehouses page says which warehouse to resize; this says which job an operator should look at, and it
// is the only one of the four whose subject is a schedule somebody owns rather than a query or a
// configuration.
//
// Nothing here changes the score. The header says so, in the same words the other three use.
//
// Four things the layout is deliberate about:
//
//   Jobs with a finding are lifted above the ones without, and within a job the findings are ordered
//   failure first and duration last. A page led by "this job is slow" invites a reader to make it faster
//   at failing.
//
//   "Not assessed" is a state of its own and never an empty finding list. A job with fewer than three runs
//   in the window had no rule applied to it, and showing it as a job with nothing wrong would turn "not
//   assessed" into "assessed and fine" — see `jobs-language.ts`.
//
//   The standing note about compute is on the page rather than in a tooltip. Six of the audit's eight
//   rules read tables that hold nothing for serverless job compute, and a reader who takes four rules for
//   an audit of eight concludes their compute was examined and found fine.
//
//   The outcome, the repeats and the billed quantity are on the panel whether or not a rule fired on them.
//   They are the figures the findings are made of, and a job with no finding is the case where a reader
//   most wants to see them.

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
  busiestTaskSentence,
  coverageSentence,
  DURATION_NOTE,
  JOBS_ICON,
  jobsSentence,
  lastRunSentence,
  leadJobFinding,
  NOT_SCORED,
  COMPUTE_ABSENT,
  computeNote,
  computeSentence,
  computeWindowSentence,
  networkSentence,
  photonNote,
  photonSentence,
  OUTCOME_ABSENT,
  outcomeSentence,
  repeatSentence,
  REPEAT_NOTE,
  rulesSentence,
  runsLine,
  scheduleSentence,
  spendSentence,
  stateFacts,
} from './jobs-language';
import { CONFIDENCE_LABEL, duration, evidencePhrase, SEVERITY_LABEL, SEVERITY_TONE } from './workload-language';
import { actionableRows } from './specialist-opportunities';
import type { JobFinding, JobHealth, JobState, Jobs } from '../api/types';

const ALL = 'all';

const EMPTY: readonly JobHealth[] = [];
const PAGE_SIZE = 10;

/** A job is identified by its workspace and its id, because job ids are only unique inside a workspace. */
function keyOf(job: JobHealth): string {
  return `${job.workspaceId}:${job.jobId}`;
}

export function JobsPage() {
  const advisor = useAdvisor();
  const [params, setParams] = useSearchParams();

  const selectedKey = params.get('job');

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === '' || value === ALL) next.delete(key);
    else next.set(key, value);
    if (key !== 'job') next.delete('job');
    setParams(next, { replace: true });
  };

  const analysis = advisor.advisory?.jobs;
  const all = analysis?.jobs ?? EMPTY;
  const rows = useMemo(() => actionableRows(all), [all]);

  const selectedAt = rows.findIndex((one) => keyOf(one) === selectedKey);
  const paged = usePaged(rows, PAGE_SIZE, selectedAt);
  const { row: selected, missing } = selectionFrom({
    all: rows,
    page: paged.rows,
    asked: selectedKey,
    at: selectedAt,
    known: rows.some((one) => keyOf(one) === selectedKey),
  });
  const pane = useRevealedPane(selectedKey);

  if (advisor.error != null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Job analysis unavailable">
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
        <Surface tone="task" label="Job analysis status">
          <EmptyState
            reason="not-yet-collected"
            heading={advisor.advising ? 'Reading how the jobs ran' : 'No job analysis yet'}
            detail={advisor.adviseError ?? advisor.reason}
          />
        </Surface>
      </CustomerPage>
    );
  }

  if (analysis == null) {
    // A finished run with no analysis could not read the run timelines, which is a different answer from a
    // workspace whose jobs all ran cleanly — and the same distinction the warehouses page draws. `advising`
    // is checked first for the reason that page records: a reader who had run the advisor before would
    // otherwise be shown a diagnosis for the length of the next run, with a spinner turning beside it.
    //
    // What the finished branch says names no cause. On the estate this was built against, a run with no
    // jobs at all and a run whose read was refused are indistinguishable from here, and asserting a
    // permission would send a reader to check a grant that may be fine.
    const blind = !advisor.advising && advisor.advisory != null;
    return (
      <CustomerPage>
        <Surface tone="task" label="Job analysis status">
          <EmptyState
            reason={blind ? 'collector-failed' : 'not-yet-collected'}
            heading={blind ? 'This run produced no job analysis' : 'Reading how the jobs ran'}
            detail={
              blind
                ? 'This page is built from the two Lakeflow run timelines, and the run got no usable answer from them — so it cannot say how any job ran. That can be a workspace whose jobs ran nothing in the window, a grant this identity does not hold, or a read that failed on the day. The checks page names the tables and what reading each one needs.'
                : 'Reading what each job’s runs did over the window. This takes a minute or two.'
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
        <Surface tone="section" label="Job analysis result">
          <EmptyState
            reason={all.length === 0 ? 'nothing-to-report' : 'filtered-out'}
            heading={all.length === 0 ? 'No job ran in the window' : 'No job opportunities'}
            detail={
              all.length === 0
                ? 'The run timelines recorded no job run at all over the window. That is ordinary in a workspace whose scheduled work lives elsewhere, and it is not a statement about jobs that exist and did not run.'
                : 'No analyzed job carries a recommendation. Coverage and jobs without an action are summarized above.'
            }
          />
        </Surface>
      )}

      {rows.length > 0 && (
        <TaskWorkspace
          queueLabel="Job opportunities"
          taskLabel="Selected job opportunity"
          queue={
            <Surface
              tone="section"
              title="Job opportunities"
              description={`${String(paged.total)} ${paged.total === 1 ? 'job needs' : 'jobs need'} attention`}
            >
              <RecordList label="Job opportunities">
                {paged.rows.map((job) => {
                  const active = selected != null && keyOf(job) === keyOf(selected);
                  return (
                    <RecordButton
                      key={keyOf(job)}
                      selected={active}
                      onSelect={() => set('job', keyOf(job))}
                      eyebrow={<StateBadge state={job.state} />}
                      title={job.name}
                      summary={runsLine(job)}
                      meta={leadJobFinding(job)}
                      aside={active ? 'Selected' : 'Open'}
                    />
                  );
                })}
              </RecordList>
              <Pagination paged={paged} noun="jobs" />
              <TechnicalDisclosure
                label="Analysis coverage"
                hint={`${String(all.length - rows.length)} clean analyzer ${all.length - rows.length === 1 ? 'row' : 'rows'} omitted`}
              >
                <p className="wa-body-compact">
                  {rows.length.toLocaleString()} job {rows.length === 1 ? 'opportunity' : 'opportunities'} shown.{' '}
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
                title={selected?.name ?? 'Select a job opportunity'}
                description="How its runs went, where their time went, and the exact next action."
              >
                {missing != null ? (
                  <NotInList
                    id={missing.id}
                    known={missing.known}
                    noun="job"
                    onClear={(keep) => setParams(onlySelection('job', keep ? missing.id : null), { replace: true })}
                  />
                ) : selected == null ? (
                  <EmptyState
                    reason="not-yet-collected"
                    heading="Choose a job opportunity"
                    detail="Select a job to read how its runs went, where their time went, and what fired on them."
                  />
                ) : (
                  <Selected key={keyOf(selected)} job={selected} />
                )}
              </Surface>
            </div>
          }
        />
      )}
    </CustomerPage>
  );
}

function Summary({ analysis }: { analysis: Jobs }) {
  const coverage = coverageSentence(analysis);
  // Only where the machine samples span a different window from the run history, which they did by 94 days
  // against 370 on the estate measured. Absent on a run that read no compute at all.
  const window = computeWindowSentence(analysis);
  return (
    <Surface tone="accent" title={`The last ${String(analysis.windowDays)} days of job runs`} description={NOT_SCORED}>
      <div className="space-y-2">
        <p className="wa-body-compact">{jobsSentence(analysis)}</p>
        {coverage != null && <p className="wa-caption">{coverage}</p>}
        <p className="wa-caption">{computeNote(analysis)}</p>
        {/* Its own line rather than a clause of the one above, because the two reach different jobs: the
            machine telemetry reaches the classic clusters that wrote node samples and the billing record
            reaches everything that billed non-serverless usage. */}
        <p className="wa-caption">{photonNote(analysis)}</p>
        {window != null && <p className="wa-caption">{window}</p>}
        <AdvisoryRunNotice />
      </div>
    </Surface>
  );
}

function Selected({ job }: { job: JobHealth }) {
  // The advisory these findings were read from, so a link out of one can name which run said it.
  const advisoryId = useAdvisor().advisory?.id;
  const outcome = outcomeSentence(job);
  const repeats = repeatSentence(job);
  const busiest = busiestTaskSentence(job);
  const spend = spendSentence(job);
  const schedule = scheduleSentence(job);
  const lastRun = lastRunSentence(job);
  const machines = computeSentence(job);
  const network = networkSentence(job);
  const photon = photonSentence(job);
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" Icon={JOBS_ICON}>
            {job.runs.toLocaleString()} run{job.runs === 1 ? '' : 's'}
          </Badge>
          <StateBadge state={job.state} />
          <IdentifierBadge>{job.jobId}</IdentifierBadge>
        </div>
        <p className="wa-caption">{stateFacts(job.state).detail}</p>
        {schedule != null && <p className="wa-caption">{schedule}</p>}
        {lastRun != null && <p className="wa-caption">{lastRun}</p>}
      </div>

      {job.findings.length > 0 && (
        <div className="space-y-2">
          {job.findings.map((finding) => (
            <Finding
              key={finding.rule}
              finding={finding}
              advisoryId={advisoryId}
              resource={job.jobId}
              resourceUrl={job.link}
            />
          ))}
        </div>
      )}

      <div>
        <h2 className="wa-label">How long the runs took</h2>
        <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
          <Measure label="Total" value={duration(job.totalMs)} />
          <Measure label="Median run" value={duration(job.medianMs)} />
          <Measure label="Mean run" value={duration(job.meanMs)} />
          <Measure label="Slowest 5% within" value={duration(job.p95Ms)} />
          <Measure label="Longest run" value={duration(job.maxMs)} />
          <Measure label="Longest single task" value={duration(job.longestTaskMs)} />
        </dl>
        {/* In the language file with the rest of the page's facts, and held by a test there: this caption
            has to hold for all six figures above it, and the version written inline did not. */}
        <p className="wa-caption mt-1">{DURATION_NOTE}</p>
      </div>

      <div>
        <h2 className="wa-label">How the runs ended</h2>
        {outcome != null ? (
          <p className="wa-caption mt-1">{outcome}</p>
        ) : (
          <p className="wa-caption mt-1">{OUTCOME_ABSENT}</p>
        )}
        {repeats != null && <p className="wa-caption mt-1">{repeats}</p>}
        {repeats == null && job.runs > 0 && (
          <p className="wa-caption mt-1">No task ran twice in any of these runs. {REPEAT_NOTE}</p>
        )}
      </div>

      <div>
        <h2 className="wa-label">Where the time went</h2>
        <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
          <Measure label="Task time in total" value={duration(job.taskMs)} />
          <Measure label="Tasks in a run at most" value={String(job.tasksMost)} />
        </dl>
        {busiest != null && <p className="wa-caption mt-1">{busiest}</p>}
        {/* Only where there is one task, because that is the case where the share above is arithmetic
            rather than a finding — and the dominance rule declines to fire on it for the same reason. */}
        {job.tasksMost < 2 && (
          <p className="wa-caption mt-1">
            This job ran one task per run, so all of its task time is in that task by construction and there is no split
            to read.
          </p>
        )}
      </div>

      <div>
        <h2 className="wa-label">What the machines were doing</h2>
        {/* Always rendered, and that is the point of the section rather than an oversight: a job with no
            telemetry has to be told apart from one whose telemetry was clean, and a section that
            disappeared would say the second. */}
        {machines != null ? (
          <>
            <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
              <Measure label="Average worker CPU" value={`${String(job.compute?.avgCpuPercent ?? 0)}%`} />
              <Measure label="Average worker memory" value={`${String(job.compute?.avgMemoryPercent ?? 0)}%`} />
              <Measure label="Peak worker CPU" value={`${String(job.compute?.peakCpuPercent ?? 0)}%`} />
              <Measure label="Peak worker memory" value={`${String(job.compute?.peakMemoryPercent ?? 0)}%`} />
            </dl>
            <p className="wa-caption mt-1">{machines}</p>
            {/* Below the utilisation figures and not among them: it is a rate against the workspace
                rather than a share of a capacity, and no figure here says what the traffic was for. */}
            {network != null && <p className="wa-caption mt-1">{network}</p>}
          </>
        ) : (
          <p className="wa-caption mt-1">{COMPUTE_ABSENT}</p>
        )}
      </div>

      {/* Outside the machines section, because it reaches jobs that section cannot: the setting is on the
          billing record and not on the cluster, so a job with no node telemetry can still have one. */}
      {photon != null && (
        <div>
          <h2 className="wa-label">Whether it ran with Photon</h2>
          <p className="wa-caption mt-1">{photon}</p>
        </div>
      )}

      {spend != null && (
        <div>
          <h2 className="wa-label">What it billed</h2>
          <p className="wa-caption mt-1">{spend}</p>
        </div>
      )}
    </div>
  );
}

function Finding({
  finding,
  advisoryId,
  resource,
  resourceUrl,
}: {
  finding: JobFinding;
  advisoryId?: string;
  resource: string;
  resourceUrl?: string;
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
      resourceUrl={resourceUrl}
      resourceLabel="Open job in Databricks"
      guidanceUrl={finding.docUrl}
      action={
        <RaiseFromAdvice
          primary={resourceUrl == null}
          advisoryId={advisoryId}
          advisor="jobs"
          resource={resource}
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

function StateBadge({ state }: { state: JobState }) {
  // Through `stateFacts` rather than the records directly: a stored advisory can name a state this build
  // does not have, and indexing straight in hands React an undefined component. See `jobs-language.ts`.
  const { label, tone, Icon, detail } = stateFacts(state);
  return (
    <Badge tone={tone} Icon={Icon} title={detail}>
      {label}
    </Badge>
  );
}
