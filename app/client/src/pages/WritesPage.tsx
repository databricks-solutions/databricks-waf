// How the estate writes, and which of its write shapes are worth a look.
//
// The fifth page in the Optimisation group, and the only one whose subject is a pattern rather than a
// thing. The workloads page names a statement to change, the warehouses page a warehouse to resize, the
// jobs page a schedule to look at; this names a *way of writing*, and the person who acts on it owns the
// pipeline behind the statement rather than the statement itself.
//
// Nothing here changes the score. The header says so, in the same words the other four use.
//
// Three things the layout is deliberate about:
//
//   The shapes are ordered by what they wrote and not by what they cost. A full rewrite is fast and still
//   the finding, and a page ranked by duration would bury it under the estate's slowest merge.
//
//   "Could not judge" is a state of its own and never an empty finding list. Both rules read a byte figure
//   and the platform records none on some runs, so a shape whose runs stated nothing had no rule applied to
//   it — see `writes-language.ts`.
//
//   Every finding names an alternative and none of them recommends it. Whether a `MERGE` or Auto Loader
//   applies depends on the pipeline, which is not in the query history, and the rules' own words stop at
//   what is worth checking.

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
  findingsSentence,
  leadWriteFinding,
  NOT_SCORED,
  NO_WRITES,
  REPRESENTATIVE_NOTE,
  rulesSentence,
  seenSentence,
  shapeLine,
  statedRunsSentence,
  statedSentence,
  stateFacts,
  WRITES_ICON,
  writesSentence,
} from './writes-language';
import { bytes, CONFIDENCE_LABEL, duration, evidencePhrase, SEVERITY_LABEL, SEVERITY_TONE } from './workload-language';
import { actionableRows } from './specialist-opportunities';
import type { WriteFinding, WriteShape, WriteState, Writes } from '../api/types';

const ALL = 'all';

const EMPTY: readonly WriteShape[] = [];
const PAGE_SIZE = 10;

export function WritesPage() {
  const advisor = useAdvisor();
  const [params, setParams] = useSearchParams();

  const selectedKey = params.get('shape');

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === '' || value === ALL) next.delete(key);
    else next.set(key, value);
    if (key !== 'shape') next.delete('shape');
    setParams(next, { replace: true });
  };

  const analysis = advisor.advisory?.writes;
  const all = analysis?.shapes ?? EMPTY;
  const rows = useMemo(() => actionableRows(all), [all]);

  const selectedAt = rows.findIndex((one) => one.shape === selectedKey);
  const paged = usePaged(rows, PAGE_SIZE, selectedAt);
  const { row: selected, missing } = selectionFrom({
    all: rows,
    page: paged.rows,
    asked: selectedKey,
    at: selectedAt,
    known: rows.some((one) => one.shape === selectedKey),
  });
  const pane = useRevealedPane(selectedKey);

  if (advisor.error != null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Write analysis unavailable">
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
        <Surface tone="task" label="Write analysis status">
          <EmptyState
            reason="not-yet-collected"
            heading={advisor.advising ? 'Reading how the estate writes' : 'No write analysis yet'}
            detail={advisor.adviseError ?? advisor.reason}
          />
        </Surface>
      </CustomerPage>
    );
  }

  if (analysis == null) {
    // A finished run with no analysis could not read the query history, which is a different answer from an
    // estate that writes nothing — and the most flattering absence in the app if the two are conflated. The
    // finished branch names no cause, for the reason the jobs page records: a refused read and an estate
    // with no writes are indistinguishable from here.
    const blind = !advisor.advising && advisor.advisory != null;
    return (
      <CustomerPage>
        <Surface tone="task" label="Write analysis status">
          <EmptyState
            reason={blind ? 'collector-failed' : 'not-yet-collected'}
            heading={blind ? 'This run produced no write analysis' : 'Reading how the estate writes'}
            detail={
              blind
                ? 'This page is built from the estate’s query history, and the run got no usable answer from it — so it cannot say how anything was written. That can be a workspace whose data is written from somewhere this history does not cover, a grant this identity does not hold, or a read that failed on the day. The checks page names the table and what reading it needs.'
                : 'Reading what the estate’s write statements did over the window. This takes a minute or two.'
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
        <Surface tone="section" label="Write analysis result">
          <EmptyState
            layout="compact"
            reason={all.length === 0 ? 'nothing-to-report' : 'filtered-out'}
            heading={all.length === 0 ? 'Nothing was written in the window' : 'No write opportunities'}
            detail={
              all.length === 0
                ? NO_WRITES
                : 'None of the analyzed write groups carries a recommendation. Coverage and unreadable groups are summarized above.'
            }
          />
        </Surface>
      )}

      {rows.length > 0 && (
        <TaskWorkspace
          queueLabel="Write opportunities"
          taskLabel="Selected write opportunity"
          queue={
            <Surface
              tone="section"
              title="Write opportunities"
              description={`${String(paged.total)} ${paged.total === 1 ? 'actionable write group' : 'actionable write groups'}`}
            >
              <RecordList label="Write opportunities">
                {paged.rows.map((shape) => (
                  <RecordButton
                    key={shape.shape}
                    selected={shape.shape === selected?.shape}
                    onSelect={() => set('shape', shape.shape)}
                    eyebrow={<StateBadge state={shape.state} />}
                    title={shape.statementText ?? shape.shape}
                    summary={shapeLine(shape)}
                    meta={leadWriteFinding(shape)}
                    aside={shape.shape === selected?.shape ? 'Selected' : 'Open'}
                  />
                ))}
              </RecordList>
              <Pagination paged={paged} noun="write groups" />
              <TechnicalDisclosure
                label="Analysis coverage"
                hint={`${String(all.length - rows.length)} clean analyzer ${all.length - rows.length === 1 ? 'row' : 'rows'} omitted`}
              >
                <p className="wa-body-compact">
                  {rows.length.toLocaleString()} opportunity {rows.length === 1 ? 'group' : 'groups'} shown.{' '}
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
                title={selected?.statementText ?? (selected == null ? 'Select a write opportunity' : selected.shape)}
                description="What was observed, why it matters, and the exact next action."
              >
                {missing != null ? (
                  <NotInList
                    id={missing.id}
                    known={missing.known}
                    noun="write group"
                    onClear={(keep) => setParams(onlySelection('shape', keep ? missing.id : null), { replace: true })}
                  />
                ) : selected == null ? (
                  <EmptyState
                    reason="not-yet-collected"
                    heading="Choose a write opportunity"
                    detail="Select a write group to read how often it ran, how much it wrote, and what fired on it."
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

function Summary({ analysis }: { analysis: Writes }) {
  const stated = statedSentence(analysis);
  return (
    <Surface tone="accent" title={`The last ${String(analysis.windowDays)} days of writes`} description={NOT_SCORED}>
      <div className="space-y-2">
        <p className="wa-body-compact">{writesSentence(analysis)}</p>
        {/* Its own line rather than a clause of the one above, because it withdraws part of that
            sentence's total rather than adding to it. */}
        {stated != null && <p className="wa-caption">{stated}</p>}
        <p className="wa-caption">{findingsSentence(analysis)}</p>
        <AdvisoryRunNotice />
      </div>
    </Surface>
  );
}

function Selected({ shape }: { shape: WriteShape }) {
  // The advisory these findings were read from, so a link out of one can name which run said it.
  const advisoryId = useAdvisor().advisory?.id;
  const seen = seenSentence(shape);
  const stated = statedRunsSentence(shape);
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" Icon={WRITES_ICON}>
            {shape.statementType}
          </Badge>
          <StateBadge state={shape.state} />
          <IdentifierBadge>{shape.shape}</IdentifierBadge>
        </div>
        <p className="wa-caption">{stateFacts(shape.state).detail}</p>
        {seen != null && <p className="wa-caption">{seen}</p>}
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
          <h2 className="wa-label">The statement</h2>
          {/* Shown as recorded, for the reason the workloads page gives: this runs inside the customer's
              own environment against their own history, and redacting it back would cost the surface its
              point. An estate under customer-managed keys has none of this to show. */}
          <pre className="wa-code-block mt-1 rounded-sm bg-wa-surface-subtle">{shape.statementText}</pre>
          <p className="wa-caption mt-1">{REPRESENTATIVE_NOTE}</p>
        </div>
      )}

      <div>
        <h2 className="wa-label">What it wrote</h2>
        <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
          <Measure label="Written in total" value={bytes(shape.writtenBytes)} />
          {shape.medianWriteBytes != null && (
            <Measure label="The middle run wrote" value={bytes(shape.medianWriteBytes)} />
          )}
          {shape.largestWriteBytes != null && (
            <Measure label="Largest run wrote" value={bytes(shape.largestWriteBytes)} />
          )}
          <Measure label="Read in total" value={bytes(shape.readBytes)} />
          <Measure label="Rows produced" value={shape.producedRows.toLocaleString()} />
          <Measure label="Time spent" value={duration(shape.totalMs)} />
        </dl>
        {/* Named rather than left to be inferred from two counts, and only where the two differ. */}
        {stated != null && <p className="wa-caption mt-1">{stated}</p>}
      </div>

      <div>
        <h2 className="wa-label">How often it ran</h2>
        <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
          <Measure label="Runs" value={shape.runs.toLocaleString()} />
          <Measure label="Runs that finished" value={shape.finishedRuns.toLocaleString()} />
          <Measure label="Days it ran on" value={shape.daysRun.toLocaleString()} />
        </dl>
      </div>
    </div>
  );
}

function Finding({ finding, advisoryId, resource }: { finding: WriteFinding; advisoryId?: string; resource: string }) {
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
      guidanceUrl={finding.docUrl}
      action={
        <RaiseFromAdvice primary advisoryId={advisoryId} advisor="writes" resource={resource} rule={finding.rule} />
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

function StateBadge({ state }: { state: WriteState }) {
  // Through `stateFacts` rather than the records directly: a stored advisory can name a state this build
  // does not have, and indexing straight in hands React an undefined component.
  const { label, tone, Icon, detail } = stateFacts(state);
  return (
    <Badge tone={tone} Icon={Icon} title={detail}>
      {label}
    </Badge>
  );
}
