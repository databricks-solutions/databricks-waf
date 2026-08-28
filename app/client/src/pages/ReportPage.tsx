// The whole review as one document, for the reader who was not in the room.
//
// This page exists because the other seven cannot be printed. They are a workbench: a rail, a
// focus panel that shows one pillar because the reader chose it, lists capped at four rows with a
// link to the rest, findings paged twenty at a time. Print any of them and you get a screenshot of
// an interaction — one pillar in depth, four of thirty findings, and a table whose remaining pages
// are behind a control that does not exist on paper. A print stylesheet alone cannot fix that,
// because what is missing is not styling: it is the rest of the content.
//
// So the document is a route. It renders every failing requirement in full, every pillar once, and
// a census of all 184 in an appendix — and it does it out of the same components the app uses, so
// the PDF cannot say something the app does not. The stylesheet in wa-print.css then does the part
// that is genuinely presentational: drop the chrome, flatten the planes, keep a heading with the
// section it introduces, and open anything the reader would otherwise have to click.
//
// The alternative was a server-rendered PDF, which means a headless browser in the image. That is
// a 300MB dependency, a second rendering path to keep in step with the first, and a marketplace
// review question about why an assessment app ships a browser. The browser the reader already has
// prints to PDF perfectly well.

import { Printer } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useAssessment } from '../api/assessment-context';
import type { AlsoAsking } from '../api/assessment-context';
import { customerResult } from '../api/final-result';
import {
  useDecisions,
  useImprovements,
  useNoteThreads,
  usePlan,
  useRaisedActions,
  useResult,
  useResultHistory,
  useScan,
} from '../api/hooks';
import { CoverageHero } from '../components/CoverageHero';
import { CONFIDENCE_LABEL, confidenceOf, estateCoverage } from '../components/coverage';
import { evidenceGaps, pillarList, type Gap } from '../components/evidence-gaps';
import { FindingDetail } from '../components/FindingDetail';
import { PillarMatrix } from '../components/PillarMatrix';
import { pillarRows } from '../components/pillar-rows';
import { splitFindings, type RankedFinding } from '../components/finding-rank';
import { tooLittleMeasured } from '../components/score-range';
import { Signal } from '../components/system/Signal';
import { CustomerPage, Surface } from '../components/system/Surface';
import { Disclosure } from '../components/ui/Disclosure';
import { EmptyState } from '../components/ui/EmptyState';
import { ScoreDisclaimerMark } from '../components/ui/ScoreDisclaimer';
import { OUTCOME_LABEL } from '../components/verdict-language';
import { ValueReportView } from '../components/ValueReport';
import { appendixRows, DECISIONS_NOTE, fixNote, reportPurpose, stampFacts } from './report-language';
import type { AppendixRow } from './report-language';
import type { PillarRow } from '../components/pillar-rows';
import type { CatalogueControl, Decision, ImprovementAction, Note, Scan, ValueReport } from '../api/types';

/** The report for the run the app has in hand, which is the newest one. */
export function ReportPage() {
  const { scan, result, loading, error } = useAssessment();
  return scan != null && result != null ? (
    <Report scan={scan} resultId={result.id} />
  ) : (
    <Nothing
      loading={loading}
      {...(error != null ? { error } : {})}
      heading="No report is available"
      detail={
        scan != null
          ? 'Finish the open review to publish the report.'
          : 'Run an assessment from the Dashboard, then return here to open its report.'
      }
      action={
        <Link className="wa-customer-primary-action" to={scan != null ? '/review' : '/overview'}>
          {scan != null ? 'Continue review' : 'Open Dashboard'}
        </Link>
      }
    />
  );
}

/**
 * The report for a named run, reached from that run's own record.
 *
 * A separate component rather than an optional route parameter, because the two get their scan from
 * different places and a hook cannot be called conditionally. It is also the honest split: this one
 * can fail with "that run is not in the recorded history", and the one above cannot.
 */
export function RunReportPage() {
  const { resultId } = useParams<{ resultId: string }>();
  const result = useResult(resultId ?? '');
  const run = useScan(result.data?.runId ?? '');
  const final = customerResult(result.data, run.data);

  return final != null ? (
    <Report scan={final.assessment} resultId={final.id} />
  ) : (
    <Nothing
      loading={result.loading || run.loading}
      {...((result.error ?? run.error) != null ? { error: result.error ?? run.error } : {})}
      detail="That report or its source run is not in the recorded history. Both are kept in the bound Lakebase database unless this app is running without persistence."
      action={
        <Link className="wa-customer-secondary-action" to="/report">
          Current report
        </Link>
      }
    />
  );
}

function Nothing({
  loading,
  error,
  heading = 'There is no run to report',
  detail,
  action,
}: {
  loading: boolean;
  error?: string;
  heading?: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <CustomerPage>
      <Surface tone="task" label="Report status">
        <EmptyState
          reason={loading ? 'not-yet-collected' : 'no-evidence'}
          heading={loading ? 'Loading' : heading}
          detail={loading ? 'Reading the run.' : (error ?? detail)}
          action={loading ? undefined : action}
        />
      </Surface>
    </CustomerPage>
  );
}

function Report({ scan, resultId }: { scan: Scan; resultId: string }) {
  const { catalogue, controlOf, pillarTitle, alsoAsking } = useAssessment();
  const history = useResultHistory();
  const plan = usePlan();
  const decisions = useDecisions();
  const improvements = useImprovements();
  const raised = useRaisedActions();
  const notes = useNoteThreads('control');
  const actions = useMemo(() => raised.data?.actions ?? [], [raised.data?.actions]);
  const raisedByControl = useMemo(() => groupRaised(actions), [actions]);
  const notesByControl = useMemo(() => indexThreads(notes.data?.threads ?? []), [notes.data?.threads]);

  /*
   * Decisions appear in the document only when it reports the run they were judged against.
   *
   * A standing is a comparison between a decision and a particular run: "reported fixed, and the run
   * still measures it as unmet" is a statement about that run. Printing it into a report of an
   * earlier one would be a claim the document cannot support — and the report of a six-week-old run
   * is exactly the artefact somebody produces to show what the estate looked like then. So an
   * historical report prints the run as measured, with no decisions in it, and says nothing it would
   * have to qualify.
   */
  const judged =
    decisions.data?.measuredAt != null &&
    new Date(decisions.data.measuredAt).getTime() === new Date(scan.finishedAt).getTime();
  const byControl = useMemo(
    () =>
      judged
        ? new Map((decisions.data?.decisions ?? []).map((one) => [one.controlId, one]))
        : new Map<string, Decision>(),
    [judged, decisions.data?.decisions]
  );

  const { queue: ranked, held } = splitFindings(scan.findings, controlOf, (controlId) => byControl.get(controlId));
  const rows = appendixRows(scan.findings, catalogue?.pillars ?? []);
  const gaps = evidenceGaps(scan, plan.data, pillarTitle);
  // How many of the entries below stand for more than one row of the appendix. Both numbers are right
  // and the document says why they differ, rather than leaving a steering group to find it.
  const grouped = ranked.filter((entry) => entry.alsoNamed != null).length;

  return (
    <ReportDocument
      scan={scan}
      resultId={resultId}
      ranked={ranked}
      held={held}
      grouped={grouped}
      rows={rows}
      gaps={gaps}
      pillarRows={pillarRows(scan, catalogue, history.data?.results ?? [])}
      value={improvements.data?.value}
      actions={actions}
      byControl={byControl}
      raisedByControl={raisedByControl}
      notesByControl={notesByControl}
      assessment={{ controlOf, pillarTitle, alsoAsking, scan }}
    />
  );
}

/** The exact report document, independent of API reads for deterministic local and print review. */
export function ReportDocument({
  scan,
  resultId,
  ranked,
  held,
  grouped,
  rows,
  gaps,
  pillarRows: reportPillars,
  value,
  actions,
  byControl,
  raisedByControl,
  notesByControl,
  assessment,
}: {
  readonly scan: Scan;
  readonly resultId: string;
  readonly ranked: readonly RankedFinding[];
  readonly held: readonly RankedFinding[];
  readonly grouped: number;
  readonly rows: readonly AppendixRow[];
  readonly gaps: readonly Gap[];
  readonly pillarRows: readonly PillarRow[];
  readonly value?: ValueReport;
  readonly actions: readonly ImprovementAction[];
  readonly byControl: ReadonlyMap<string, Decision>;
  readonly raisedByControl: ReadonlyMap<string, readonly ImprovementAction[]>;
  readonly notesByControl: ReadonlyMap<string, readonly Note[]>;
  readonly assessment: {
    readonly controlOf: (controlId: string) => CatalogueControl | undefined;
    readonly pillarTitle: (pillarId: string) => string;
    readonly alsoAsking: (controlId: string) => readonly AlsoAsking[];
    readonly scan: Scan;
  };
}) {
  return (
    <CustomerPage className="wa-report-page">
      <Masthead scan={scan} />

      <ExecutiveSummary scan={scan} ranked={ranked} held={held} actions={actions} />

      {/* Screen only. The assessment result now leads; print mechanics are available without
          becoming the report's opening sentence. On paper the browser dialogue is not a thing the
          document can invite a reader to press, and a button that cannot be pressed is ink. */}
      <div className="flex flex-wrap items-start justify-between gap-3" data-print="omit">
        <Disclosure summary="How to save or print this report">
          <p>
            Use your browser&rsquo;s print dialogue and choose &ldquo;Save as PDF&rdquo;. Leave headers and footers on
            for page numbers. Turn on background graphics if you want the meters in colour; every figure is also written
            out, so a plain print loses nothing.
          </p>
        </Disclosure>
        <button type="button" className="wa-button-secondary" onClick={() => window.print()}>
          <Printer aria-hidden className="h-3.5 w-3.5" />
          Print
        </button>
      </div>

      <ReportSection title="Assessment scope and assurance">
        <CoverageHero scan={scan} pillarTitle={assessment.pillarTitle} />
      </ReportSection>

      {value != null && (
        <ReportSection title="Improvement value and progress">
          <ValueReportView value={value} />
        </ReportSection>
      )}

      <ReportProvenance scan={scan} resultId={resultId} />

      <ReportSection title="Posture by pillar">
        <Surface tone="section" label="Every pillar" className="wa-report-matrix-surface">
          <PillarMatrix rows={reportPillars} />
        </Surface>
      </ReportSection>

      <ReportSection
        id="material-risks"
        title="Material risks and required action"
        note={ranked.length > 0 ? fixNote({ held, grouped }) : undefined}
      >
        {ranked.length === 0 ? (
          <Surface tone="inset" label="Material risk status">
            {/* The same distinction the overview draws, and it matters more on paper: a document
                that told a steering group nothing was found unmet, when eleven things were and
                somebody accepted them all, would be the most damaging page this app can print. */}
            {held.length > 0 ? (
              <EmptyState
                reason="held-by-decision"
                heading="Nothing outstanding"
                detail={`Every unmet requirement this run measured has a decision recorded against it — ${String(held.length)} in all, listed below. They still count against the score.`}
              />
            ) : (
              <EmptyState
                reason="nothing-to-report"
                heading="Nothing was found unmet"
                detail="No requirement this run measured was found unmet or partly met. The coverage above is what that statement is worth."
              />
            )}
          </Surface>
        ) : (
          // Margins rather than a flex gap, because this is the list that has to break across
          // pages and a flex column does not fragment. See wa-print.css.
          <div className="space-y-3">
            {ranked.map(({ finding }) => (
              // Deliberately not a keep-together block. A finding runs from 400 to 700 pixels and
              // the printable page is a little over a thousand, so holding each one whole put one
              // finding on most pages and left a third of the paper white — 28 pages for 33
              // findings. It reads as padding, and a reader flicking through padding stops. What
              // must not separate is smaller than a finding: its pillar and title from its verdict,
              // an observation from what was expected, a command from its label. Those are held in
              // wa-print.css, and the paragraph that runs over a page boundary simply runs over.
              <div key={finding.controlId} id={`control-${finding.controlId}`} className="wa-report-finding">
                <Surface tone="task" label={finding.title} className="wa-report-record-surface">
                  <FindingDetail
                    finding={finding}
                    decision={byControl.get(finding.controlId)}
                    printed
                    raised={raisedByControl.get(finding.controlId) ?? []}
                    notes={notesByControl.get(finding.controlId) ?? []}
                    assessment={assessment}
                  />
                </Surface>
              </div>
            ))}
          </div>
        )}
      </ReportSection>

      {/* After what to fix, not folded into it. These are the same kind of failure and a different
          kind of work: the section above is for whoever is fixing things, this one is for whoever
          has to agree that not fixing them was reasonable. */}
      {held.length > 0 && (
        <ReportSection id="governance-decisions" title="Governance decisions" note={DECISIONS_NOTE}>
          <div className="space-y-3">
            {held.map(({ finding }) => (
              <Surface
                key={finding.controlId}
                tone="section"
                label={finding.title}
                className="wa-report-record-surface"
              >
                <FindingDetail
                  finding={finding}
                  decision={byControl.get(finding.controlId)}
                  printed
                  raised={raisedByControl.get(finding.controlId) ?? []}
                  notes={notesByControl.get(finding.controlId) ?? []}
                  assessment={assessment}
                />
              </Surface>
            ))}
          </div>
        </ReportSection>
      )}

      <ReportSection id="measurement-gaps" title="Measurement gaps">
        <ReportMeasurementGaps gaps={gaps} unanswered={scan.score.counts.unmeasurable} />
      </ReportSection>

      <ReportSection
        title="Every requirement"
        fresh
        note={
          `All ${rows.length.toLocaleString()} requirements this run considered, in the catalogue's own order. ` +
          'The section above is a selection; this is the census it was selected from.'
        }
      >
        <Surface tone="inset" label="Every requirement considered" className="wa-report-table-surface">
          <ReportAppendixTable rows={rows} />
        </Surface>
      </ReportSection>
    </CustomerPage>
  );
}

/** The report census remains a table on wide screens and becomes labelled records on mobile. */
export function ReportAppendixTable({ rows }: { readonly rows: readonly AppendixRow[] }) {
  return (
    <table className="wa-table">
      <caption className="sr-only">
        Every requirement in the catalogue with its outcome, and for the unmeasured and the excluded, the reason there
        is no result.
      </caption>
      {/* Declared, because auto layout measured this table badly: it gave the requirement
          column the width of its widest word and wrapped 184 titles into four lines each,
          beside a note column that was mostly white. */}
      <colgroup>
        <col className="w-1/3" />
        <col className="w-1/6" />
        <col className="w-1/12" />
        <col />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">Requirement</th>
          <th scope="col">Pillar</th>
          <th scope="col">Outcome</th>
          <th scope="col">Note</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.controlId}>
            <td data-label="Requirement">
              <span className="wa-code text-wa-text-muted">{row.controlId}</span>
              <span className="wa-body-compact block text-wa-text">{row.title}</span>
            </td>
            <td data-label="Pillar" className="wa-body-compact text-wa-text-secondary">
              {row.pillar}
            </td>
            <td data-label="Outcome" className="wa-body-compact whitespace-nowrap">
              {OUTCOME_LABEL[row.outcome]}
            </td>
            <td data-label="Note" className="wa-caption">
              {row.because}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ReportMeasurementGaps({
  gaps,
  unanswered,
}: {
  readonly gaps: readonly Gap[];
  readonly unanswered: number;
}) {
  if (gaps.length === 0) {
    return (
      <Surface tone="inset" title="No measurement gap">
        <p className="wa-report-gap-empty">Every applicable requirement was evaluated in this assessment.</p>
      </Surface>
    );
  }

  const actionable = gaps.filter((gap) => gap.action != null && gap.blocked > 0).length;
  return (
    <Surface
      tone="section"
      title={`${unanswered.toLocaleString()} unanswered requirement${unanswered === 1 ? '' : 's'}`}
      description={`${actionable.toLocaleString()} measurement-gap ${actionable === 1 ? 'category has' : 'categories have'} a recorded next step.`}
    >
      <ul className="wa-report-gap-list">
        {gaps.map((gap) => (
          <li key={gap.id}>
            <div className="wa-report-gap-heading">
              {gap.counted && <span className="wa-report-gap-count">{gap.blocked.toLocaleString()}</span>}
              <div>
                <h3 className="wa-type-title">{gap.title}</h3>
                <p>{pillarList(gap.pillars)}</p>
              </div>
            </div>
            <p className="wa-report-gap-reason">{gap.resolve}</p>
            {gap.action != null && (
              <Link className="wa-customer-tertiary-action" to={gap.action.to} data-print="show-link">
                {gap.action.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </Surface>
  );
}

export function ExecutiveSummary({
  scan,
  ranked,
  held,
  actions,
}: {
  readonly scan: Pick<Scan, 'score'>;
  readonly ranked: readonly {
    readonly finding: Pick<RankedFinding['finding'], 'controlId' | 'title' | 'severity'>;
  }[];
  readonly held: readonly unknown[];
  readonly actions: readonly Pick<ImprovementAction, 'state'>[];
}) {
  const coverage = estateCoverage(scan.score);
  const confidence = confidenceOf(coverage);
  const directional = tooLittleMeasured(scan.score.range);
  const active = actions.filter((action) => action.state !== 'verified' && action.state !== 'cancelled');
  const verified = actions.filter((action) => action.state === 'verified');
  const blocked = actions.filter((action) => action.state === 'blocked');
  const first = ranked[0];

  return (
    <Surface
      tone="raised"
      title="Executive summary"
      description="Current posture, material risks, improvement progress and governance assurance from this assessment."
      className="wa-report-executive"
    >
      <div className="wa-signal-grid">
        <Signal
          label="Framework assessed"
          value={`${String(Math.round(coverage.percent))}%`}
          detail={`${coverage.assessed.toLocaleString()} of ${coverage.applicable.toLocaleString()} applicable · ${CONFIDENCE_LABEL[confidence]} confidence`}
          tone={confidence === 'high' ? 'positive' : 'warning'}
        />
        <Signal
          label="Measured posture"
          value={scan.score.overall == null ? '—' : `${String(Math.round(scan.score.overall))}/100`}
          detail={
            <>
              <ScoreDisclaimerMark /> ·{' '}
              {directional
                ? 'Directional—too little is measured for a settled score'
                : 'Based on evaluated requirements'}
            </>
          }
          tone={directional ? 'directional' : 'neutral'}
        />
        <Signal
          label="Open requirements"
          value={(ranked.length + held.length).toLocaleString()}
          detail={`${ranked.length.toLocaleString()} need action · ${held.length.toLocaleString()} held by decisions`}
          tone={ranked.length + held.length > 0 ? 'critical' : 'positive'}
        />
        <Signal
          label="Improvement work"
          value={`${active.length.toLocaleString()} active`}
          detail={`${verified.length.toLocaleString()} verified · ${blocked.length.toLocaleString()} blocked`}
          tone={blocked.length > 0 ? 'warning' : active.length > 0 ? 'neutral' : 'positive'}
        />
      </div>

      <div className="wa-report-summary-grid">
        <section>
          <p className="wa-type-eyebrow">First action</p>
          {first == null ? (
            <p className="wa-dashboard-empty-copy">No evaluated requirement is currently in the open action queue.</p>
          ) : (
            <>
              <h3 className="wa-type-title">{first.finding.title}</h3>
              <p className="wa-dashboard-empty-copy">
                {first.finding.severity[0]?.toUpperCase()}
                {first.finding.severity.slice(1)} priority · {first.finding.controlId}
              </p>
              <a className="wa-customer-secondary-action" href={`#control-${first.finding.controlId}`}>
                Read the requirement
              </a>
            </>
          )}
        </section>

        <section>
          <p className="wa-type-eyebrow">Governance assurance</p>
          <p className="wa-dashboard-empty-copy">
            {scan.score.counts.unmeasurable.toLocaleString()} requirements were unanswered and{' '}
            {held.length.toLocaleString()} unmet requirements are held by recorded decisions. These remain separate from
            verified improvement work.
          </p>
          <div className="wa-report-summary-links">
            <a href="#measurement-gaps">Review measurement gaps</a>
            {held.length > 0 && <a href="#governance-decisions">Review decisions</a>}
          </div>
        </section>
      </div>
    </Surface>
  );
}

/**
 * The document's own first page: what it is and what the result means.
 *
 * The exact run identity remains in the provenance immediately after the customer result. Keeping it
 * out of this masthead means the report no longer asks a reader to cross a technical identity table
 * before reaching the thing the document exists to communicate.
 */
function Masthead({ scan }: { scan: Scan }) {
  return (
    <header className="wa-report-block space-y-3">
      <div>
        <p className="wa-label-eyebrow">Databricks Well-Architected Framework</p>
        {/*
         * The document's title, at level two, because the shell's header already holds the page's
         * only h1 and it names the estate this report is about. Two h1s made a screen reader's
         * heading list open on a choice between "Acme production" and "Architecture review" with
         * nothing to say which contained which.
         */}
        <h2 className="wa-title-page text-wa-text">Architecture review</h2>
      </div>

      <p className="wa-body-compact max-w-prose text-wa-text-secondary">{reportPurpose(scan.score)}</p>

      {scan.state === 'partial' && (
        <p className="wa-notice-warning wa-body-compact">
          This run is partial, so the requirements below are a subset of the plan.{' '}
          {scan.incompleteReason ?? 'The scan stopped before completing its plan.'}
        </p>
      )}
    </header>
  );
}

/** Exact identity and methodology, available on screen and printed after the result it qualifies. */
function ReportProvenance({ scan, resultId }: { scan: Scan; resultId: string }) {
  return (
    <section className="wa-report-block">
      <Disclosure summary="How this assessment was produced">
        <table className="wa-table">
          <caption className="sr-only">
            The identity, scope, public methodology and technical catalogue behind this report.
          </caption>
          <tbody>
            {[{ label: 'Report ID', value: resultId }, ...stampFacts(scan)].map((fact) => (
              <tr key={fact.label}>
                {/* A row header rather than a first cell: the label names the row, and a screen
                    reader reading the value alone would read a date with nothing to attach it to. */}
                <th scope="row" className="w-48 align-top font-medium">
                  {fact.label}
                </th>
                <td className="wa-body-compact text-wa-text">{fact.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Disclosure>
    </section>
  );
}

function groupRaised(actions: readonly ImprovementAction[]): Map<string, ImprovementAction[]> {
  const by = new Map<string, ImprovementAction[]>();
  for (const action of actions) {
    for (const controlId of action.controlIds) {
      const held = by.get(controlId) ?? [];
      held.push(action);
      by.set(controlId, held);
    }
  }
  return by;
}

function indexThreads(
  threads: readonly { readonly subject: { readonly id: string }; readonly notes: readonly Note[] }[]
): Map<string, readonly Note[]> {
  return new Map(threads.map((thread) => [thread.subject.id, thread.notes]));
}

/**
 * A titled part of the document, with the sentence that qualifies it.
 *
 * The heading is separate from the panels below it rather than being their section header, because
 * a part of this document is often more than one panel and the print rules need something to hold
 * a heading to the content it introduces. See `break-after: avoid` in wa-print.css.
 */
function ReportSection({
  id,
  title,
  note,
  fresh = false,
  children,
}: {
  readonly id?: string;
  readonly title: string;
  readonly note?: string;
  /** Starts on a new sheet. For the appendix, which is a reference rather than a continuation. */
  readonly fresh?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section id={id} className={`space-y-3${fresh ? ' wa-report-fresh' : ''}`} aria-label={title}>
      <div className="wa-report-heading">
        <h2 className="wa-title-section text-wa-text">{title}</h2>
        {note != null && <p className="wa-caption mt-1 max-w-prose">{note}</p>}
      </div>
      {children}
    </section>
  );
}
