// Which job to move to serverless first, and what it would cost.
//
// Four requirements in the catalogue score the estate's serverless share, and all four answer
// with a percentage. That is the right thing to score and useless to act on: "43% of your
// compute spend is serverless" tells nobody which job to move on Monday. This page is the
// other half — a work queue, ordered by what the migration is worth, with the specific reason
// each job cannot move yet.
//
// Nothing here changes the score, and the header says so rather than a footnote saying so. A
// page of migration advice sitting beside a number would otherwise be read as a way to move it.
//
// Three things the layout is deliberate about:
//
//   The verdict counts come before the list, because the shape of the answer — mostly rework,
//   two hard blockers — is what a reader needs before they start reading rows.
//
//   The cost range never appears without its assumptions. They are one click away rather than
//   inline, since the alternative was five paragraphs above the number, but the disclosure is
//   open by default the first time the estimate is shown.
//
//   The standing caveat is at the top, not the bottom. This reads the compute a job ran on and
//   cannot read the code it ran, and a reader who takes "could move" as a promise will find out
//   the expensive way. That belongs before the list, not under it.
//
//   What the caveat may say is bounded by what the statement read: the clusters' configuration as
//   it stands now, joined to runs from the window. Nothing on this page may say a past run met a
//   blocker — the statement's header sets out why an as-of reading is a different question — so
//   every verdict sentence here is in the present tense about the compute rather than the past
//   tense about the run.

import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ExternalLink } from 'lucide-react';
import { useAdvisor } from '../api/advisor-context';
import { RaiseFromAdvice } from '../components/RaiseFromAdvice';
import { AdvisoryRunNotice } from '../components/RunAdvisoryControl';
import { SpecialistOpportunity } from '../components/SpecialistOpportunity';
import {
  CustomerPage,
  RecordButton,
  RecordList,
  StateNotice,
  Surface,
  TaskWorkspace,
  TechnicalDisclosure,
} from '../components/system';
import { Disclosure } from '../components/ui/Disclosure';
import { EmptyState } from '../components/ui/EmptyState';
import { Pagination } from '../components/ui/Pagination';
import { NotInList } from '../components/ui/NotInList';
import { onlySelection, selectionFrom, usePaged } from '../components/ui/paging';
import { useRevealedPane } from '../components/ui/reveal';
import { Figure, SegmentLegend, Segments, type Segment } from '../components/ui/Segments';
import { Badge, IdentifierBadge } from '../components/ui/StatusBadge';
import {
  carriedPhrase,
  costPhrase,
  KIND_LABEL,
  KIND_RANK,
  money,
  ratePhrase,
  savingPhrase,
  shareSentence,
  startupPhrase,
  VERDICT_DETAIL,
  VERDICT_LABEL,
  VERDICT_ICON,
  VERDICT_TONE,
  VERDICTS,
} from './serverless-language';
import type { ServerlessJob, ServerlessReadiness, ServerlessReason, ServerlessVerdict } from '../api/types';

const ALL = 'all';

const EMPTY: readonly ServerlessJob[] = [];
const PAGE_SIZE = 10;

/** The bar's tones, matching the badges so the two channels agree. */
const VERDICT_SEGMENT: Readonly<Record<ServerlessVerdict, Segment['tone']>> = {
  blocked: 'danger',
  rework: 'warning',
  unknown: 'unknown',
  ready: 'success',
};

export function ServerlessPage() {
  const advisor = useAdvisor();
  const [params, setParams] = useSearchParams();

  const verdict = params.get('verdict') ?? ALL;
  const selectedId = params.get('job');

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === '' || value === ALL) next.delete(key);
    else next.set(key, value);
    if (key !== 'job') next.delete('job');
    setParams(next, { replace: true });
  };

  const analysis = advisor.advisory?.serverless;
  const all = useMemo(() => analysis?.jobs ?? EMPTY, [analysis?.jobs]);
  const rows = useMemo(() => (verdict === ALL ? all : all.filter((job) => job.verdict === verdict)), [all, verdict]);

  const selectedAt = rows.findIndex((job) => key(job) === selectedId);
  const paged = usePaged(rows, PAGE_SIZE, selectedAt);
  const { row: selected, missing } = selectionFrom({
    all: rows,
    page: paged.rows,
    asked: selectedId,
    at: selectedAt,
    known: all.some((job) => key(job) === selectedId),
  });
  const pane = useRevealedPane(selectedId);

  if (advisor.error != null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Serverless analysis unavailable">
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
  // advisor at all. Both are ordinary states of a fresh install and neither is an error, so neither
  // gets a red banner. The shared page header carries the one run action for every advisor view.
  if (advisor.reason != null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Serverless analysis status">
          <EmptyState
            reason="not-yet-collected"
            heading={advisor.advising ? 'Reading the job history' : 'No serverless analysis yet'}
            detail={advisor.adviseError ?? advisor.reason}
          />
        </Surface>
      </CustomerPage>
    );
  }

  if (analysis == null) {
    // Two states with the same shape and different answers. A run that finished with no analysis
    // could not read the job history at all, and saying "there is nothing to move" there would be
    // telling a customer they have no work to do because a grant is missing.
    const blind = advisor.advisory != null;
    return (
      <CustomerPage>
        <Surface tone="task" label="Serverless analysis status">
          <EmptyState
            reason={blind ? 'collector-failed' : 'not-yet-collected'}
            heading={blind ? 'The job history could not be read' : 'Reading the job history'}
            detail={
              blind
                ? 'The advisor ran but could not see how jobs ran in this window, so it cannot say which of them could move. The checks page lists what it reads and the permission that needs.'
                : 'Working out which jobs ran on classic compute, what stops each of them moving, and what the move would cost.'
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

  const data = analysis;
  const carried = carriedPhrase(data.carriedFrom);

  const filters = (
    <div className="wa-segmented flex-wrap" role="group" aria-label="Filter by verdict">
      <Filter
        label={`Ran in this window (${all.length})`}
        active={verdict === ALL}
        onClick={() => set('verdict', ALL)}
      />
      {VERDICTS.filter((value) => data.counts[value] > 0).map((value) => (
        <Filter
          key={value}
          label={`${VERDICT_LABEL[value]} (${String(data.counts[value])})`}
          active={verdict === value}
          onClick={() => set('verdict', value)}
        />
      ))}
    </div>
  );

  return (
    <CustomerPage>
      <StateNotice
        tone="info"
        announce="status"
        title="Confirm workload compatibility before moving"
        detail={
          <p>
            {data.caveat.detail}{' '}
            <a href={data.caveat.docUrl} target="_blank" rel="noreferrer" className="text-wa-action hover:underline">
              Read the serverless limitations
            </a>
            .
          </p>
        }
      />

      {data.unmeasured != null && (
        <StateNotice
          tone="partial"
          announce="status"
          title="Some readiness evidence is unavailable"
          detail={data.unmeasured}
        />
      )}

      <AdvisoryRunNotice />

      <Summary analysis={data} carried={carried} />

      {all.length === 0 ? (
        <Surface tone="section" title="Jobs still on classic compute" description="0 to move">
          <EmptyState
            reason="nothing-to-report"
            heading="No serverless migration work"
            detail="Every job that ran in this window was already on serverless compute or a SQL warehouse. There is no classic job compute to migrate."
            layout="compact"
          />
        </Surface>
      ) : (
        <TaskWorkspace
          queueLabel="Jobs on classic compute"
          taskLabel="Selected serverless migration"
          queue={
            <Surface
              tone="section"
              title="Ordered by what the move is worth"
              description={
                paged.total === all.length
                  ? `${String(all.length)} jobs listed`
                  : `${String(paged.total)} of ${String(all.length)} jobs shown`
              }
              action={filters}
            >
              {paged.total === 0 ? (
                <EmptyState
                  reason="filtered-out"
                  heading="No jobs with this verdict"
                  detail="No job has that verdict. Clearing the filter will bring the rest back."
                  action={
                    <button type="button" className="wa-customer-secondary-action" onClick={() => set('verdict', ALL)}>
                      Show every job
                    </button>
                  }
                />
              ) : (
                <>
                  <RecordList label="Serverless migration opportunities">
                    {paged.rows.map((job) => {
                      const active = key(job) === key(selected);
                      return (
                        <RecordButton
                          key={key(job)}
                          selected={active}
                          onSelect={() => set('job', key(job) ?? '')}
                          eyebrow={<VerdictBadge verdict={job.verdict} />}
                          title={job.name}
                          summary={`${job.workspace} · ${job.runs.toLocaleString()} ${job.runs === 1 ? 'run' : 'runs'}`}
                          meta={[
                            job.cost != null && job.currency != null
                              ? `${money(job.cost, job.currency)} on classic compute`
                              : undefined,
                            leadReason(job),
                          ]
                            .filter((part): part is string => part != null)
                            .join(' · ')}
                          aside={active ? 'Selected' : 'Open'}
                        />
                      );
                    })}
                  </RecordList>
                  <Pagination paged={paged} noun="jobs" />
                </>
              )}
              {data.truncated != null && (
                <TechnicalDisclosure
                  label="Queue coverage"
                  hint={`${String(data.truncated.listed)} of ${data.truncated.found.toLocaleString()} listed`}
                >
                  <p className="wa-body-compact">
                    {data.truncated.found.toLocaleString()} jobs used classic compute in this window. The{' '}
                    {String(data.truncated.listed)} whose migration is worth most are listed; the rest are the tail of
                    the spend.
                  </p>
                </TechnicalDisclosure>
              )}
            </Surface>
          }
          task={
            <div ref={pane}>
              <Surface
                tone="task"
                title={selected?.name ?? 'Select a serverless migration'}
                description="What stops this job moving, what the change takes, and the estimated cost."
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
                    heading="Choose a serverless migration"
                    detail="Select a job to read what stops it moving, what that would take, and what the move is estimated to cost."
                  />
                ) : (
                  <Selected
                    key={key(selected)}
                    job={selected}
                    assumptions={data.assumptions}
                    explains={data.explains}
                  />
                )}
              </Surface>
            </div>
          }
        />
      )}
    </CustomerPage>
  );
}

function Summary({ analysis, carried }: { analysis: ServerlessReadiness; carried: string | undefined }) {
  // Each verdict filters the list below rather than leaving the page. The chips at the head of that
  // list do the same thing, but a reader reading the estate summary is looking at this legend, and
  // a segment reading "6 blocked" that cannot be followed sends them hunting for the control that
  // can be.
  const segments: readonly Segment[] = VERDICTS.map((verdict) => ({
    label: VERDICT_LABEL[verdict],
    value: analysis.counts[verdict],
    tone: VERDICT_SEGMENT[verdict],
    to: `/serverless?verdict=${verdict}`,
  }));
  const assessed = VERDICTS.reduce((total, verdict) => total + analysis.counts[verdict], 0);
  const saving = savingPhrase(analysis.cost, analysis.estimate);
  // Absent when the priced jobs span more than one region, because the total is then a sum
  // across two price lists and naming one of them would say it all came from there.
  const estateRate = ratePhrase(analysis.estimate?.region);

  return (
    <Surface tone="accent" title="Serverless readiness" description="Not scored">
      <div className="space-y-3">
        <p className="wa-body-compact text-wa-text-secondary">{shareSentence(analysis)}</p>
        {carried != null && <p className="wa-caption">{carried}</p>}

        {assessed > 0 && (
          <div className="space-y-1.5">
            <Segments
              segments={segments}
              total={assessed}
              of={`the ${String(assessed)} jobs still on classic compute`}
            />
            <SegmentLegend segments={segments} total={assessed} />
          </div>
        )}

        {analysis.estimate != null && analysis.cost != null && analysis.currency != null && (
          <div className="space-y-2 border-t border-wa-divider pt-3">
            <div className="flex flex-wrap gap-x-8 gap-y-3">
              <Figure label={`Classic compute over ${String(analysis.lookbackDays)} days`} tone="lead">
                {money(analysis.cost, analysis.currency)}
              </Figure>
              <Figure
                label={`Estimated on serverless, for the ${String(analysis.estimate.jobs)} that could move`}
                tone="lead"
              >
                {costPhrase(analysis.estimate) ?? '—'}
              </Figure>
              {saving != null && <Figure label="Difference, at list price">{saving}</Figure>}
            </div>

            {estateRate != null && <p className="wa-caption">{estateRate}</p>}

            {/* Open by default the one time the estimate is first shown: the range is arithmetic
                on two observed numbers and one assumption, and publishing the number without the
                assumption is the part that would be dishonest. */}
            <Disclosure summary="What this estimate assumes" open>
              <ul className="space-y-1.5">
                {analysis.assumptions.map((assumption) => (
                  <li key={assumption.id}>
                    {assumption.statement}
                    {assumption.docUrl != null && (
                      <>
                        {' '}
                        <a
                          href={assumption.docUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-wa-action hover:underline"
                        >
                          Reference
                        </a>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </Disclosure>
          </div>
        )}
      </div>
    </Surface>
  );
}

function Selected({
  job,
  assumptions,
  explains,
}: {
  readonly job: ServerlessJob;
  readonly assumptions: ServerlessReadiness['assumptions'];
  readonly explains: readonly string[];
}) {
  // Blockers first, notes last. A reader working one job wants the reason it cannot move before
  // the reason its compute policy will stop applying.
  const reasons = [...job.reasons].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  // The advisory these reasons were read from, so a link out of one can name which run said it.
  const advisoryId = useAdvisor().advisory?.id;
  const startup = startupPhrase(job.startupShare);
  const rate = ratePhrase(job.estimate?.region);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="wa-caption text-wa-text-secondary">{job.workspace ?? 'This workspace'}</span>
          <VerdictBadge verdict={job.verdict} />
          <IdentifierBadge>{job.jobId}</IdentifierBadge>
        </div>
        {job.link != null && (
          <a
            href={job.link}
            target="_blank"
            rel="noreferrer"
            className="wa-body-compact inline-flex items-center gap-1 text-wa-action hover:underline"
          >
            Open the job in Databricks
            <ExternalLink aria-hidden className="h-3 w-3" />
          </a>
        )}
      </div>

      <p className="wa-body-compact text-wa-text-secondary">{VERDICT_DETAIL[job.verdict]}</p>

      {reasons.length === 0 ? (
        <p className="wa-body-compact text-wa-text-secondary">
          Nothing readable about this job’s compute stops it moving. The caveat at the top of the page still applies.
        </p>
      ) : (
        <ul className="space-y-2 border-t border-wa-divider pt-3">
          {reasons.map((reason) => (
            <Reason
              key={reason.ruleId}
              reason={reason}
              advisoryId={advisoryId}
              resource={job.jobId}
              resourceUrl={job.link}
            />
          ))}
        </ul>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Fact label="Runs in the window">{job.runs.toLocaleString()}</Fact>
        <Fact label={job.classicClusters === 1 ? 'Classic cluster' : 'Classic clusters'}>
          {job.classicClusters.toLocaleString()}
        </Fact>
        {job.cost != null && job.currency != null && (
          <Fact label="Classic compute cost">{money(job.cost, job.currency)}</Fact>
        )}
        {job.estimate != null && <Fact label="Estimated on serverless">{costPhrase(job.estimate) ?? '—'}</Fact>}
      </dl>

      {job.clusters.length > 0 && (
        <p className="wa-caption">
          Ran on {job.clusters.join(', ')}
          {job.classicClusters > job.clusters.length
            ? ` and ${String(job.classicClusters - job.clusters.length)} more`
            : ''}
          .
        </p>
      )}

      {rate != null && <p className="wa-caption">{rate}</p>}

      {startup != null && <p className="wa-caption">{startup}</p>}

      {/* Said where the number would have been, rather than leaving the field blank. A blank
            reads as free. */}
      {job.noEstimate != null && <p className="wa-caption">{job.noEstimate}</p>}

      {job.estimate != null && (
        <Disclosure summary="What this estimate assumes">
          <ul className="space-y-1.5">
            {assumptions.map((assumption) => (
              <li key={assumption.id}>{assumption.statement}</li>
            ))}
          </ul>
        </Disclosure>
      )}

      {/* The way back to the requirements this elaborates. Read from the payload rather than
            hard-coded, so a change to which requirements the analysis stands behind does not
            need a matching edit here. */}
      <p className="wa-caption border-t border-wa-divider pt-3">
        Elaborates{' '}
        {explains.map((controlId, index) => (
          <span key={controlId}>
            {index > 0 ? ', ' : ''}
            <Link to={`/findings?control=${controlId}`} className="text-wa-action hover:underline">
              {controlId}
            </Link>
          </span>
        ))}
        . None of them is scored differently because of what is on this page.
      </p>
    </div>
  );
}

/**
 * One reason, with the measurement and the general claim kept apart.
 *
 * The observed line is about this estate; the detail is a claim about the platform and carries
 * a citation. Running the two together in one paragraph is how a tool ends up asserting a
 * limitation as though it had measured it.
 */
function Reason({
  reason,
  advisoryId,
  resource,
  resourceUrl,
}: {
  reason: ServerlessReason;
  advisoryId?: string;
  resource: string;
  resourceUrl?: string;
}) {
  return (
    <li>
      <SpecialistOpportunity
        recommendation={reason.action ?? 'Inspect this requirement before moving the job'}
        title={reason.headline}
        detail={reason.observed}
        status={<span className="wa-caption">{KIND_LABEL[reason.kind]}</span>}
        qualification={<p>{reason.detail}</p>}
        resourceUrl={resourceUrl}
        resourceLabel="Open job in Databricks"
        guidanceUrl={reason.docUrl}
        action={
          <RaiseFromAdvice
            primary={resourceUrl == null}
            advisoryId={advisoryId}
            advisor="serverless"
            resource={resource}
            rule={reason.ruleId}
          />
        }
      />
    </li>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="wa-caption">{label}</dt>
      <dd className="wa-body-compact wa-numeric font-medium text-wa-text">{children}</dd>
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: ServerlessVerdict }) {
  return (
    <Badge tone={VERDICT_TONE[verdict]} Icon={VERDICT_ICON[verdict]} title={VERDICT_DETAIL[verdict]}>
      {VERDICT_LABEL[verdict]}
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

/**
 * The worst thing found about this job, for the row.
 *
 * One reason rather than a count, because "runs on GPUs" is what makes a reader stop on a row
 * and "3 reasons" is not. Sorted by kind, so the blocker wins over the note beside it.
 */
function leadReason(job: ServerlessJob): string | undefined {
  const worst = [...job.reasons].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind])[0];
  return worst?.headline;
}

/** Jobs are identified per workspace, so a job id alone is ambiguous across an account. */
function key(job: ServerlessJob | undefined): string | undefined {
  return job == null ? undefined : `${job.workspaceId}/${job.jobId}`;
}
