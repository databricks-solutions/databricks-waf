// The page header: where you are, what state the assessment is in, and what you can do to it.
//
// One header, owned by the shell, rather than a title block written again at the top of every page.
// The version this replaced had each page state its own name in an <h2> and nothing state the
// review's own facts, so the identity of the thing being looked at — measured as whom, when, over
// what — appeared once, three panels down the overview, and nowhere else in the app.
//
// It sits on the canvas with no fill of its own, which is measured rather than stylistic: in the
// reference every row from the breadcrumb to the tab strip is canvas-coloured, and the only white
// things in it are its two buttons. A white header bar puts a second surface above the cards and
// starts the page with a horizontal band that means nothing.
//
// The state badge is the same fact the overview says at length, in one word, because it changes how
// every number on every page should be read: a partial run's findings are a subset, and the reader
// must not have to remember which page they came from.
//
// # Which run the header is about
//
// Two of these pages are not populated by a scan at all. The Optimisation group shows what an
// advisory run concluded, which is a separate cycle with its own trigger, history and retention
// (ADR 0061) — and this header told those pages the scan's story: measured at 09:12, 30-day
// lookback, catalogue 1.4.0, with a button offering to run a scan that would change nothing on the
// page. Every clause was true of something the reader was not looking at, and the run that did
// produce it could not be started from the interface at all.
//
// So the line under the title, the badge and the button are all chosen from the section's source
// rather than fixed. The alternative — a second header written into the two pages — was rejected on
// what it costs: the identity of the thing being looked at would be stated in three places, and the
// page that forgot to state it would look like a page with nothing to state.

import { type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { Spinner } from '@databricks/appkit-ui/react';
import { CheckCircle2, ChevronRight, CircleDashed, CircleSlash } from 'lucide-react';
import { useAdvisor } from '../../api/advisor-context';
import { useAssessment } from '../../api/assessment-context';
import { customerResult } from '../../api/final-result';
import { useResult, useReviewForRun, useScan } from '../../api/hooks';
import { ExportMenu } from '../ExportMenu';
import { RunAdvisoryControl } from '../RunAdvisoryControl';
import { RunInFlight } from '../RunInFlight';
import { RunScanControl } from '../RunScanControl';
import { ThemeToggle } from '../ThemeToggle';
import { Palette } from './Palette';
import { canonicalCustomerPath, isCustomerPreview, itemFor, taskFor } from './nav';
import { PillarIcon } from './PillarIcon';
import { advisoryProvenance, liveProvenance, resultProvenance, scanProvenance } from './provenance';
import type { Advisory, Scan } from '../../api/types';

export interface ReviewHeaderProps {
  /** The mobile navigation trigger. Belongs to the shell, sits here because this is the header. */
  readonly menu?: ReactNode;
}

export function ReviewHeader({ menu }: ReviewHeaderProps) {
  const { pathname } = useLocation();
  const canonicalPath = canonicalCustomerPath(pathname);
  const preview = isCustomerPreview(pathname);
  const { pillarId, scanId, resultId } = useParams<{ pillarId: string; scanId: string; resultId: string }>();
  const { scan, result, latestRun, scanning, loading: readingScan, pillarTitle } = useAssessment();
  const { advisory, advising, loading: readingAdvisory } = useAdvisor();
  const addressedResult = useResult(resultId ?? '');
  const addressedRun = useScan(addressedResult.data?.runId ?? '');
  const addressed = customerResult(addressedResult.data, addressedRun.data);
  const shownResult = addressed ?? result;
  // A State of the Nation can be absent while a newer raw run waits for review. The header may name
  // that technical run and its collection state; it must not claim no scan exists, and it must not
  // promote the run's provisional score into the customer result.
  const shownScan = addressed?.assessment ?? scan ?? latestRun;
  const showingCustomerResult = addressed != null || (scanId == null && resultId == null && result != null);

  const section = itemFor(pathname);
  const task = taskFor(pathname);
  const globalOrientation = canonicalPath === '/' || section?.to === '/overview';
  // Which cycle this page is about. Read from the nav rather than from the path, so a page added to
  // the Optimisation group is described by the run that populates it without touching this file.
  const onAdvisory = section?.source === 'advisory';
  // Neither cycle. The header then says which, and says nothing about a run — see `liveProvenance`.
  const onLive = section?.source === 'live';
  const onPillar = pillarId != null;
  // The leaf of the breadcrumb, where the route has one. Named from the route rather than left to
  // the page, so a page cannot be reached with the header still titled after its section.
  const leaf = onPillar ? pillarTitle(pillarId) : scanId != null ? 'Run record' : undefined;
  const exportRun = scanId ?? shownScan?.id;
  const exportReview = useReviewForRun(exportRun ?? '');
  // A raw run can still be inspected as evidence, but customer result files are released only by
  // the final assessment joined through this exact review. Loading and read failure both withhold.
  const resultExportable = resultId ?? (scanId != null ? exportReview.data?.result?.id : shownResult?.id);

  return (
    <header className="wa-page-header">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        {menu != null && <div className="wa-nav-menu -ml-1 shrink-0">{menu}</div>}

        <div className="min-w-0 flex-1">
          <nav aria-label="Breadcrumb" className="wa-caption flex flex-wrap items-center gap-1">
            <span>Well-Architected</span>
            <ChevronRight aria-hidden className="h-3 w-3 shrink-0" />
            {task != null ? (
              <Link to={task.to} className="font-medium text-wa-text-secondary hover:text-wa-text hover:underline">
                {task.label}
              </Link>
            ) : !globalOrientation ? (
              <span className="font-medium text-wa-text-secondary">Utilities</span>
            ) : null}
            {section != null && (
              <>
                <ChevronRight aria-hidden className="h-3 w-3 shrink-0" />
                {/* A link only where it goes somewhere else. A breadcrumb to the page you are on is
                    a click that does nothing, and the reader learns to distrust the rest. */}
                {leaf != null ? (
                  <Link to={section.to} className="hover:text-wa-text hover:underline">
                    {section.label}
                  </Link>
                ) : (
                  <span className="font-medium text-wa-text-secondary">{section.label}</span>
                )}
              </>
            )}
            {leaf != null && (
              <>
                <ChevronRight aria-hidden className="h-3 w-3 shrink-0" />
                <span className="font-medium text-wa-text-secondary">{leaf}</span>
              </>
            )}
          </nav>

          <div className="mt-1 flex flex-wrap items-center gap-3">
            {onPillar && <PillarIcon pillarId={pillarId} className="h-5 w-5 text-wa-text-secondary" />}
            <h1 className="wa-title-page text-wa-text">{leaf ?? section?.label ?? 'Well-Architected review'}</h1>
            {/* No chip at all on a live page. The two chips each say how far the run behind the page
                got, and there is no run behind this one — a "Complete" beside figures a scan did not
                produce would be read as this page's own standing. */}
            {preview ? (
              <Chip tone="neutral" Icon={CircleDashed} label="Preview data" />
            ) : onLive ? null : onAdvisory ? (
              <AdvisoryBadge advisory={advisory} advising={advising} />
            ) : (
              <StateBadge scan={shownScan} scanning={scanning} raw={!showingCustomerResult} />
            )}
          </div>

          {/* The scan's scope is on the line now, in the shape rather than the sentence — see
              `scopeShape`. The advisory's is still a tooltip because it is a sentence the advisor
              wrote and there is no shape to reduce it to; `32f` covered the assessment's bar and
              the advisor's is the row after it. A tooltip is a poor place for a fact and it is
              where this one was, so nothing has got worse and one of the two has got better. */}
          <p className="wa-caption mt-1" {...(onAdvisory ? { title: advisory?.scope } : {})}>
            {/* The loading flag matters on the pages that can draw themselves before their run
                arrives — see `Waiting`. Passed on both branches rather than the one that was measured,
                because which pages those are is a property of where their content comes from. */}
            {preview
              ? 'Deterministic local acceptance data · no workspace record is changed'
              : onLive
                ? liveProvenance()
                : onAdvisory
                  ? advisoryProvenance(advisory, { loading: readingAdvisory })
                  : shownResult != null && scanId == null
                    ? resultProvenance(shownResult)
                    : scanProvenance(shownScan, { loading: readingScan })}
          </p>
        </div>

        {/*
          `shrink-0` from `sm` up and not below it. The four controls are 457px of intrinsic width and
          a phone hands them 376px, so on a 390px viewport the group wrapped onto its own line, kept
          its full width anyway, and ran off the right edge — where `.wa-app`'s `overflow-x: hidden`
          took it. The primary button read "Run a" with its label, its chevron and the whole
          split-menu beyond the edge and no scroll that reached them: the app's principal action,
          unreachable on a phone, on five pages. Above `sm` the group must not shrink, because the
          title beside it has `flex-1` and would otherwise squeeze it there instead.
        */}
        <div
          id="run-controls"
          tabIndex={-1}
          className="flex min-w-0 basis-full flex-wrap items-center justify-end gap-2 sm:basis-auto sm:shrink-0"
        >
          {/* First of the four, and the only one that is about getting somewhere rather than about
              the run. It is here because the header is where a reader looks for a search box, and
              because ⌘K needs something on screen that says it exists. */}
          <Palette />
          <ThemeToggle />
          {/* The run in view, which on a historic run record is not the newest one.
              Absent on the advisory pages: this exports an assessment, and offering it beside a page
              of query shapes would hand a reader a file that does not contain what they were reading.
              The advisor has no export of its own yet — noted in the plan, not papered over here. */}
          {!preview && !onAdvisory && (
            <ExportMenu
              {...(resultExportable != null ? { resultId: resultExportable } : {})}
              {...(exportRun != null ? { runId: exportRun } : {})}
              reportTo={resultExportable != null ? `/report/${resultExportable}` : '/report'}
            />
          )}
          {/* Whichever run this page is about. The scan control names the assessment the run answers
              to; the advisory one has nothing to name. See both files. */}
          {!preview && (onAdvisory ? <RunAdvisoryControl /> : <RunScanControl />)}
        </div>
      </div>

      {/*
        In the header rather than on a page, because a run in flight is true of the app and not of
        wherever the reader happens to be standing. It was on the overview alone, which is the one
        page a reader is least likely to be on while they wait — and the header does not scroll, so
        here it stays on screen for the whole run.
      */}
      {!preview && <RunInFlight />}
    </header>
  );
}

/**
 * Whether this workspace has been assessed, and whether the assessment finished.
 *
 * A chip rather than a badge, because the header's scale is its own — but held to the same rule as
 * every other status in the app: a word and a shape. Three of these four were a tinted pill and a
 * word, and the pair that matters most is `Partial` against `Complete`, which is the difference
 * between a score a reader may quote and one they may not.
 */
function StateBadge({ scan, scanning, raw = false }: { scan?: Scan; scanning: boolean; raw?: boolean }) {
  if (scanning) {
    return <Chip tone="neutral" Icon={Spinner} label="Scanning" />;
  }
  if (scan == null) return <Chip tone="neutral" Icon={CircleDashed} label="Not run" />;
  if (scan.state === 'partial')
    return <Chip tone="warning" Icon={CircleSlash} label={raw ? 'Run partial' : 'Partial'} />;
  return <Chip tone="success" Icon={CheckCircle2} label={raw ? 'Run complete' : 'Complete'} />;
}

/**
 * The same four states for the advisor, in its own words.
 *
 * "Advising" rather than "Scanning" while it runs, because the two cost different money against
 * different tables, and a reader who cannot tell which one is happening cannot tell whether the
 * number they are waiting for is the score or the ranking.
 */
function AdvisoryBadge({ advisory, advising }: { advisory?: Advisory; advising: boolean }) {
  if (advising) return <Chip tone="neutral" Icon={Spinner} label="Advising" />;
  if (advisory == null) return <Chip tone="neutral" Icon={CircleDashed} label="Not run" />;
  // Partial means some of what the advisor reads was unreadable, so what is on the page is a subset
  // of the estate — the same warning a partial scan carries, for the same reason.
  if (advisory.state === 'partial') return <Chip tone="warning" Icon={CircleSlash} label="Partial" />;
  return <Chip tone="success" Icon={CheckCircle2} label="Complete" />;
}

function Chip({
  tone,
  Icon,
  label,
}: {
  tone: 'neutral' | 'warning' | 'success';
  Icon: (props: { className?: string }) => ReactNode;
  label: string;
}) {
  return (
    <span data-status className={`wa-chip wa-chip-${tone}`}>
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}
