// Pillars, and one pillar in detail.
//
// The list is the same matrix the overview shows, on purpose: two tables ranking seven pillars
// differently would be two answers to one question. What this page adds is the second half of the
// story the overview has no room for — not just how much of each pillar is unanswered, but which of
// the three reasons it is unanswered for, because a pillar blocked on practice statements and a
// pillar blocked on missing grants need different people.
//
// The detail page is a summary and a paginated requirement list rather than three stacked columns of
// cards. Seventy security requirements as expanded cards was 40 screens of scrolling, and everything
// past the first screen went unread. Requirements lead to the findings page, which has the room to
// show evidence and remediation properly.

import { useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useAssessment } from '../api/assessment-context';
import { useResultHistory } from '../api/hooks';
import { CommitmentFor, Commitments } from '../components/Commitments';
import { MeasuredWhen } from '../components/MeasuredWhen';
import { NoteThread } from '../components/NoteThread';
import { PillarMatrix } from '../components/PillarMatrix';
import { byUrgency, pillarRows } from '../components/pillar-rows';
import { principleRows } from '../components/principles';
import { RerunPillar } from '../components/RerunPillar';
import { RunScanDialog } from '../components/RunScanDialog';
import { shortPillarLabel } from '../components/shell/pillar-label';
import { CONFIDENCE_LABEL, confidenceOf, coveragePhrase, pillarCoverage, postureOf } from '../components/coverage';
import { scoreTone } from '../components/verdict-language';
import { rangeSentence } from '../components/score-range';
import { BarList, type Bar } from '../components/ui/charts';
import { Disclosure } from '../components/ui/Disclosure';
import { EmptyState, type EmptyReason } from '../components/ui/EmptyState';
import { Pagination } from '../components/ui/Pagination';
import { usePaged } from '../components/ui/paging';
import { CustomerPage, PageLead, Surface, TaskWorkspace } from '../components/system';
import { ScoreDisclaimer } from '../components/ui/ScoreDisclaimer';
import { Segments, SegmentLegend, type Segment } from '../components/ui/Segments';
import { OutcomeBadge, SeverityBadge } from '../components/ui/StatusBadge';
import type { Finding, PillarScore, Severity, Unmeasured } from '../api/types';

export function PillarsPage() {
  const { scan, latestRun, catalogue } = useAssessment();
  const history = useResultHistory();
  const [order, setOrder] = useState<'framework' | 'urgency'>('framework');

  const rows = pillarRows(scan, catalogue, history.data?.results ?? []);
  const ordered = order === 'urgency' ? byUrgency(rows) : rows;

  if (scan == null && latestRun != null) {
    const reviewId = latestRun.finalisation?.reviewId;
    return (
      <PageEmpty
        reason="not-yet-collected"
        heading="No published report yet"
        detail="The latest run is waiting for review. Pillar posture appears here after every selected pillar is confirmed or explicitly skipped and the report is published."
        action={
          <Link className="wa-button-primary" to={reviewId == null ? '/review' : `/review/${reviewId}`}>
            Continue review
          </Link>
        }
      />
    );
  }

  if (scan == null) {
    return (
      <PageEmpty
        reason="not-yet-collected"
        heading="No assessment run yet"
        detail="Run an assessment to compare posture and measurement coverage across the selected pillars."
        action={
          <RunScanDialog>
            <button type="button" className="wa-button-primary">
              Run assessment
            </button>
          </RunScanDialog>
        }
      />
    );
  }

  if (rows.length === 0) {
    return (
      <PageEmpty
        reason="not-yet-collected"
        heading="No pillars loaded"
        detail="The requirement catalogue could not be read, so there are no pillars to show. Reload the page; if it persists, the app could not reach its own catalogue."
      />
    );
  }

  return (
    <CustomerPage>
      <PageLead
        eyebrow="Assess"
        headingLevel={2}
        title="Compare assessed pillars"
        summary="Compare posture and measurement coverage across the Well-Architected pillars in this report."
      />
      {/* The matrix takes the page. Beside a sidebar its six columns had 700px to fit into at 1280,
          which put "2 high" over "1 medium" in the unmet column and pushed the change column under
          the panel next to it — a comparison table that cannot be compared across. */}
      <div className="space-y-4">
        <Surface
          tone="task"
          label="Pillar scores"
          title="Assessed pillars"
          action={
            <span className="wa-segmented">
              <button type="button" aria-pressed={order === 'framework'} onClick={() => setOrder('framework')}>
                Framework order
              </button>
              <button type="button" aria-pressed={order === 'urgency'} onClick={() => setOrder('urgency')}>
                Needs attention
              </button>
            </span>
          }
        >
          <PillarMatrix rows={ordered} />
        </Surface>

        <Committed />

        <WhyIncomplete />
      </div>
    </CustomerPage>
  );
}

/**
 * What the assessment committed to, and where each commitment stands.
 *
 * Under the matrix rather than above it. The scores are what the reader came for and the commitments
 * are what to make of them, and a panel of promises above the numbers they are about would be read
 * as the assessment's subject rather than its plan.
 *
 * Absent entirely when nothing was committed to. Most assessments commit to nothing, and an empty
 * panel headed "What this assessment committed to" on every one of them would be a permanent
 * reproach for not having used a feature.
 */
function Committed() {
  const { scan, pillarTitle } = useAssessment();
  const targets = scan?.targets ?? [];
  if (targets.length === 0) return null;

  return (
    <Surface
      tone="raised"
      label="What this assessment committed to"
      title="What it is aiming for"
      action={
        <Link to="/definitions" className="wa-caption wa-aside-link hover:underline">
          Where these are set →
        </Link>
      }
    >
      <Commitments targets={targets} pillarTitle={pillarTitle} />
    </Surface>
  );
}

/**
 * Which of the three reasons each pillar is unanswered for.
 *
 * The overview says how much is unanswered. This says whose move it is, which is the difference
 * between a list the reader can act on and a number they can only regret.
 */
function WhyIncomplete() {
  const { scan, pillarTitle } = useAssessment();
  const pillars = (scan?.score.pillars ?? []).filter((pillar) => pillar.unmeasurable > 0);

  return (
    <Surface
      tone="section"
      label="Why each pillar is incomplete"
      title="Why they are incomplete"
      action={<span className="wa-caption">unanswered requirements</span>}
    >
      {pillars.length === 0 ? (
        <EmptyState
          reason="nothing-to-report"
          heading="Nothing unanswered"
          detail="Every applicable requirement in every measured pillar was answered."
        />
      ) : (
        /*
         * Two abreast and one line each, under the matrix rather than beside it: short rows do not
         * need a page's height, and the matrix needs the page's width.
         *
         * It was four abreast and two lines each, and the arithmetic that chose that has been redone
         * twice. Three columns was the count while five pillars had something unanswered; seven do on
         * a real estate, and seven in threes is three rows. Four columns fixed that and cost 152px,
         * because a 229px column wraps the reasons of the one pillar with two of them and a grid row
         * is as tall as its tallest cell — so one wrap was paid for by all four.
         *
         * Two columns is 480px, which holds a name and both reasons on one line, and seven of those
         * is 116px. It is fewer columns and less height, which is the shape the content wanted: these
         * are seven short facts and were being laid out as though they were cards. The 36px it gives
         * back is what let the header state the scope and the evidence range without pushing this
         * page past the fold — measured at 1280x800, where this page is the tightest in the app.
         */
        <ul className="grid gap-x-6 px-3 pb-1 lg:grid-cols-2">
          {pillars.map((pillar) => (
            /* 2px of padding, and the row is still 29px, because the name link inside it keeps its
               own 24px minimum — which is the number that matters here, since 2.5.8 is about the
               target and not about the row it sits in. */
            <li key={pillar.pillarId} className="flex items-baseline gap-3 border-t border-wa-divider py-0.5">
              {/*
               * The short label, which the rail, the score cards and the queue already pay: "Security,
               * compliance, and privacy" crowds the reasons beside it, and a title cut mid-word is
               * worse than one deliberately shortened. The full title is on the matrix directly above
               * this, in the tooltip, and in the name a screen reader is given.
               */}
              <Link
                to={`/pillars/${pillar.pillarId}`}
                title={pillarTitle(pillar.pillarId)}
                aria-label={pillarTitle(pillar.pillarId)}
                className="wa-body-compact min-h-6 shrink-0 leading-6 font-medium text-wa-text hover:underline"
              >
                {shortPillarLabel(pillar.pillarId, pillarTitle(pillar.pillarId))}
              </Link>
              <Reasons pillar={pillar} />
              {/* The count goes to the requirements, not to the pillar. Two targets in one row
                  because they are two questions: "how is this pillar doing" and "which are the
                  nine it could not answer". */}
              <Link
                to={`/findings?pillar=${pillar.pillarId}&outcome=unmeasurable`}
                className="wa-caption wa-aside-link wa-numeric ml-auto shrink-0 hover:underline"
              >
                {pillar.unmeasurable}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Surface>
  );
}

/**
 * Whose move it is, with each reason leading where that move is made.
 *
 * The reasons need different people and different pages, which is the whole argument for splitting
 * the number rather than printing it. Leaving them as one grey sentence made the split a fact to
 * read instead of a route to take: "37 need a person" is the answering page, "12 have no check yet"
 * is what this build measures, and "3 could not be read" is a grant problem.
 *
 * All five reasons, and `unreachable` is the reason this is a component rather than a string. The
 * sentence version listed three and omitted `unreachable`, which on a live estate was the largest:
 * Security read 47 unanswered above a line accounting for 9 of them, in a panel titled "Why they are
 * incomplete". The overview's evidence gaps had the missing 38 the whole time.
 */
function Reasons({ pillar }: { pillar: PillarScore }) {
  const by = pillar.unmeasuredBy;
  const of = (kind: Unmeasured) => by?.[kind] ?? 0;
  const parts = REASONS.filter((reason) => of(reason.kind) > 0).map((reason) => ({
    count: of(reason.kind),
    phrase: reason.phrase,
    to: reason.to(pillar.pillarId),
  }));

  // Reached when the run predates the split being recorded. The count above is still true, so
  // saying nothing here would be less honest than admitting the breakdown is missing.
  if (parts.length === 0) return <span className="wa-caption">Reason not recorded</span>;

  return (
    <span className="wa-caption flex flex-wrap items-baseline gap-x-1.5">
      {parts.map((part, index) => (
        <span key={part.phrase} className="flex items-baseline gap-1.5">
          {index > 0 && <span aria-hidden>·</span>}
          <Link to={part.to} className="wa-aside-link hover:text-wa-text hover:underline">
            {part.count} {part.phrase}
          </Link>
        </span>
      ))}
    </span>
  );
}

/**
 * The five reasons a requirement goes unanswered, each with the page that resolves it.
 *
 * Declared once and read by both the reason line and the denominator disclosure, because those two
 * were separate lists of the same things and one of them was missing an entry.
 *
 * `unreachable` and `attestation` share a destination and are still two reasons: one is a practice
 * no API reports, the other is a scope the platform does not offer an app. The next action is the
 * same and the thing to stop chasing is not.
 *
 * `disabled` shares a destination with `unreadable` and is the one reason here that is not a gap:
 * this install told the app not to use the reading. It says only that, because the record carrying
 * who switched it off and why is row 31b's and does not exist yet. It does not say the app never
 * asked: the same amendment that refuses a disable over a failing requirement makes the decision
 * lapse when the reading turns, which it can only do by taking the reading every time.
 *
 * Keyed off `Unmeasured` rather than written as an array of five, so that a sixth kind is a type
 * error here instead of a reason that renders as nothing. The insertion order is the display order.
 */
interface Reason {
  readonly kind: Unmeasured;
  readonly phrase: string;
  readonly sentence: string;
  readonly to: (pillarId: string) => string;
}

const REASON: Readonly<Record<Unmeasured, Omit<Reason, 'kind'>>> = {
  attestation: {
    phrase: 'need a person',
    sentence: 'await your attestation',
    to: (pillarId) => `/answers?pillar=${pillarId}`,
  },
  unreachable: {
    phrase: 'are out of this app’s reach',
    sentence: 'ask for access no install of this app can hold, so they need answering by hand',
    to: (pillarId) => `/answers?pillar=${pillarId}`,
  },
  unbuilt: {
    phrase: 'have no check yet',
    sentence: 'have no automated check yet',
    to: (pillarId) => `/checks?pillar=${pillarId}`,
  },
  unreadable: {
    phrase: 'could not be read',
    sentence: 'could not be read',
    to: (pillarId) => `/findings?pillar=${pillarId}&outcome=unmeasurable`,
  },
  disabled: {
    phrase: 'are switched off here',
    sentence: 'are switched off in this install, so this run did not score them',
    to: (pillarId) => `/findings?pillar=${pillarId}&outcome=unmeasurable`,
  },
};

const REASONS: readonly Reason[] = Object.entries(REASON).map(([kind, reason]) => ({
  kind: kind as Unmeasured,
  ...reason,
}));

type View = 'attention' | 'excluded' | 'met';

const VIEW_LABEL: Readonly<Record<View, string>> = {
  attention: 'Needs attention',
  excluded: 'Unanswered',
  met: 'Met',
};

export function PillarDetailPage() {
  const { pillarId } = useParams<{ pillarId: string }>();
  const { scan, latestRun, catalogue, pillarTitle } = useAssessment();
  const [view, setView] = useState<View>('attention');

  const pillar = scan?.score.pillars.find((candidate) => candidate.pillarId === pillarId);
  const findings = useMemo(
    () => (scan?.findings ?? []).filter((finding) => finding.pillarId === pillarId),
    [scan?.findings, pillarId]
  );

  const shown = useMemo(() => {
    if (view === 'attention') return pillar?.worstFirst ?? [];
    if (view === 'excluded') {
      return findings.filter((finding) => finding.outcome === 'unmeasurable' || finding.outcome === 'not-applicable');
    }
    return findings.filter((finding) => finding.outcome === 'pass' || finding.outcome === 'satisfied-by-architecture');
  }, [view, pillar?.worstFirst, findings]);

  const paged = usePaged(shown, 8);

  /*
   * Three different reasons this page can have nothing to show, and they were one message.
   *
   * "No results for this pillar. It may not be assessed in this build, or the scan may have stopped
   * before reaching it" was shown for a URL naming a pillar that does not exist, for a workspace
   * where no scan has run, and for a pillar the build catalogues but never measures. The first is a
   * bad link, the second needs a scan, the third needs a check to be written — and a reader told
   * "may not be assessed, or may have stopped" has been given a guess instead of an answer.
   */
  const known = catalogue == null || catalogue.pillars.some((candidate) => candidate.id === pillarId);

  if (!known) {
    return (
      <PageEmpty
        reason="not-applicable"
        heading="No pillar by that name"
        detail={`The framework has no pillar with the identifier "${pillarId ?? ''}". The link that brought you here is out of date, or the address was typed.`}
        action={
          <Link className="wa-button-secondary" to="/pillars">
            All pillars
          </Link>
        }
      />
    );
  }

  if (scan == null) {
    const reviewId = latestRun?.finalisation?.reviewId;
    return (
      <PageEmpty
        reason="not-yet-collected"
        heading={latestRun == null ? 'No scan yet' : 'No published report yet'}
        detail={
          latestRun == null
            ? 'Nothing has been measured in this workspace, so this pillar has no results to show. Run an assessment from the header to assess it.'
            : 'The latest run is waiting for review. This pillar appears here after the report is published.'
        }
        {...(latestRun == null
          ? {}
          : {
              action: (
                <Link className="wa-button-primary" to={reviewId == null ? '/review' : `/review/${reviewId}`}>
                  Continue review
                </Link>
              ),
            })}
      />
    );
  }

  if (pillar == null || pillarId == null) {
    return (
      <PageEmpty
        reason="no-evidence"
        heading="This pillar was not measured"
        detail="It is in the catalogue, but this scan ran no check against it, so it has no score and no findings."
        action={
          <Link className="wa-button-secondary" to="/checks">
            What each pillar scans
          </Link>
        }
      />
    );
  }

  const coverage = pillarCoverage(pillar);
  const posture = postureOf(pillar, coverage);

  return (
    <CustomerPage>
      <PageLead
        eyebrow="Pillar"
        headingLevel={2}
        title={`${pillarTitle(pillarId)} posture and requirements`}
        summary="Understand measured posture, unresolved requirements, and the exact evidence gap behind this pillar."
      />
      <TaskWorkspace
        queueLabel="Pillar summary"
        taskLabel="Pillar requirements"
        queue={
          <Surface
            tone="raised"
            label="Pillar summary"
            title="Summary"
            action={
              <Link to={`/checks?pillar=${pillarId}`} className="wa-caption wa-aside-link hover:underline">
                What this measures →
              </Link>
            }
          >
            <div className="space-y-3 p-3">
              <div>
                {posture.kind === 'insufficient' || posture.kind === 'unassessed' ? (
                  <p className="wa-title-section text-wa-text">Insufficient evidence</p>
                ) : (
                  <p className="flex items-baseline gap-2">
                    <span
                      className={`wa-numeric text-3xl leading-none font-semibold ${
                        posture.kind === 'directional' ? 'text-wa-text-secondary' : scoreTone(posture.score)
                      }`}
                    >
                      {posture.score.toFixed(1)}
                    </span>
                    <span className="wa-caption">/ 100</span>
                  </p>
                )}
                <p className="wa-caption mt-1">
                  {coveragePhrase(coverage)} · confidence {CONFIDENCE_LABEL[confidenceOf(coverage)].toLowerCase()}
                  {posture.kind === 'directional' && ' · directional'}
                </p>
                <ScoreDisclaimer />
              </div>

              <Segments
                segments={pillarSegments(pillar, pillarId)}
                total={pillar.total}
                of={`the ${String(pillar.total)} requirements in ${pillarTitle(pillarId)}`}
              />
              <SegmentLegend segments={pillarSegments(pillar, pillarId)} total={pillar.total} />

              <MeasuredWhen scan={scan} pillarId={pillarId} />
              <CommitmentFor targets={scan?.targets} pillarId={pillarId} />
              <RerunPillar pillarId={pillarId} />

              <Disclosure summary="Why the denominator is what it is">
                <p>{describeDenominator(pillar)}</p>
                {rangeSentence(pillar.range, pillar.unmeasurable, { by: pillar.unmeasuredBy }) != null && (
                  <p>{rangeSentence(pillar.range, pillar.unmeasurable, { by: pillar.unmeasuredBy })}</p>
                )}
              </Disclosure>
            </div>

            <Surface tone="plain" title="Unmet by severity" headingLevel={3}>
              <BarList
                bars={severityBars(pillar)}
                /*
                 * Each bar goes to the findings page filtered to that severity within this pillar.
                 * A bar reading "2 high" that cannot be followed is the reader being told a number and
                 * then asked to reconstruct which two requirements it counted.
                 */
                hrefFor={(bar) => `/findings?pillar=${pillarId}&severity=${bar.label.toLowerCase()}&outcome=unmet`}
                empty={
                  <p className="wa-body-compact text-wa-text-secondary">
                    Nothing in this pillar came back unmet
                    {pillar.unmeasurable > 0 ? ', of the part that could be answered.' : '.'}
                  </p>
                }
              />
            </Surface>

            {/*
            Met rate per principle: the framework's own subdivision of the pillar, and the one thing
            the overview's focus panel said that nothing else did. It moved here when that panel was
            removed, which is also where it belongs — a rate per principle is a fact about one pillar,
            and it was competing for the landing page's height with the estate's own scores.
          */}
            <Surface tone="plain" title="Met rate by principle" headingLevel={3}>
              <Principles pillarId={pillarId} />
            </Surface>

            {/* Last in the summary, because a note about a pillar is the reader's own words and
              everything above it is the estate's. It records the standing explanations — "we do not
              use Unity Catalog for the archive, on purpose" — that otherwise get re-explained in
              every review this page is opened in. */}
            <Surface tone="plain" title="Notes" headingLevel={3}>
              <NoteThread
                subject={{ kind: 'pillar', id: pillarId }}
                observedIn={scan.id}
                label="Notes on this pillar"
              />
            </Surface>
          </Surface>
        }

        task={
          <Surface
            tone="task"
            label="Requirements"
            title="Requirements"
            action={
              <span className="wa-segmented">
                {(['attention', 'excluded', 'met'] as const).map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    aria-pressed={view === candidate}
                    onClick={() => setView(candidate)}
                  >
                    {VIEW_LABEL[candidate]}
                  </button>
                ))}
              </span>
            }
          >
            {paged.total === 0 ? (
              <EmptyState {...emptyFor(view)} />
            ) : (
              <>
                <ul className="wa-zebra">
                  {paged.rows.map((finding) => (
                    <RequirementRow key={finding.controlId} finding={finding} view={view} />
                  ))}
                </ul>
                <Pagination paged={paged} noun="requirements" />
              </>
            )}
          </Surface>
        }
      />
    </CustomerPage>
  );
}

/**
 * Met rate per principle, each row a link into the requirements it counted.
 *
 * The denominator travels with the rate because 100% of one requirement and 100% of nine are not the
 * same claim and a bar cannot tell them apart.
 */
function Principles({ pillarId }: { pillarId: string }) {
  const { scan, catalogue } = useAssessment();
  const rows = principleRows(catalogue, scan?.findings ?? [], pillarId).filter((row) => row.percent != null);

  if (rows.length === 0) {
    return (
      <p className="wa-caption">
        No principle in this pillar has a measured requirement yet, so there is no rate to show.
      </p>
    );
  }

  return (
    <ul className="space-y-1.5">
      {rows.map((row) => (
        /* Two lines, because this is in a 300px rail. On one line the name shared the row with a
           meter, a percentage and a denominator, and what was left of it was "Mana…" — a principle
           called "Manage identity and access" and a principle called "Manage data quality" both
           render as the same five characters, so the rate beside them belonged to nothing. */
        <li key={row.id} className="wa-row flex-col items-stretch gap-1 py-1.5">
          <Link
            to={`/findings?pillar=${pillarId}&principle=${row.id}`}
            className="wa-row-link wa-body-compact min-w-0 truncate text-wa-text-secondary"
            title={row.title}
          >
            {row.title}
          </Link>
          <span className="flex items-center gap-2">
            <PrincipleMeter percent={row.percent ?? 0} />
            <span className="wa-numeric wa-body-compact w-9 shrink-0 text-right font-medium text-wa-text">
              {(row.percent ?? 0).toFixed(0)}%
            </span>
            <span className="wa-caption wa-numeric w-10 shrink-0 text-right">
              {row.measured}/{row.total}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function PrincipleMeter({ percent }: { percent: number }) {
  const tone = percent >= 80 ? 'bg-wa-success-fill' : percent >= 50 ? 'bg-wa-warning-fill' : 'bg-wa-danger-fill';
  return (
    <span className="wa-bar-track" role="img" aria-label={`${percent.toFixed(0)} per cent met`}>
      <span className={tone} style={{ width: `${String(Math.max(2, percent))}%` }} />
    </span>
  );
}

/**
 * One requirement, at list density.
 *
 * The evidence and the remediation are one click away rather than inline. A list where every row is
 * an expanded card is a list nobody can compare across, and comparison is the only reason to show
 * eight of them at once.
 */
function RequirementRow({ finding, view }: { finding: Finding; view: View }) {
  // A "Not met" badge on every row of a list called Needs attention states the list's own name once
  // per row. Partly met differs from the rest of the tab, so that one keeps its badge.
  const redundant = view === 'attention' && finding.outcome === 'fail';

  return (
    <li className="wa-row flex-col items-start gap-1 py-2">
      <span className="flex w-full items-start justify-between gap-3">
        <Link
          to={`/findings?control=${finding.controlId}`}
          className="wa-body-compact min-w-0 font-medium text-wa-text hover:underline"
        >
          {finding.title}
        </Link>
        <span className="flex shrink-0 items-center gap-1.5">
          <SeverityBadge severity={finding.severity} />
          {!redundant && <OutcomeBadge outcome={finding.outcome} />}
        </span>
      </span>
      {finding.outcomeReason != null && <span className="wa-caption line-clamp-1">{finding.outcomeReason}</span>}
    </li>
  );
}

function emptyFor(view: View): { reason: EmptyReason; heading: string; detail: string } {
  if (view === 'attention') {
    return {
      reason: 'nothing-to-report',
      heading: 'Nothing unmet',
      detail: 'No requirement in this pillar came out as not met or partly met.',
    };
  }
  if (view === 'excluded') {
    return {
      reason: 'nothing-to-report',
      heading: 'Nothing unanswered',
      detail: 'Every requirement in this pillar was answered and scored.',
    };
  }
  return {
    reason: 'no-evidence',
    heading: 'Nothing met',
    detail:
      'No requirement in this pillar is currently met, which is a finding in itself rather than a gap in the data.',
  };
}

/**
 * What the pillar is made of. Unmeasured is a segment, and on most pillars the largest.
 *
 * Every segment carries the filtered list behind it, "Met" included. It counts two outcomes —
 * passed, and met by architecture — and used to be the one segment that could not be followed,
 * because the findings page filtered a single outcome and a link would have had to drop half the
 * number printed beside it. `outcome=met` is that union, so the segment and its list now agree.
 */
function pillarSegments(pillar: PillarScore, pillarId: string): readonly Segment[] {
  const to = (outcome: string) => `/findings?pillar=${pillarId}&outcome=${outcome}`;

  return [
    {
      label: 'Met',
      value: pillar.counts.pass + pillar.counts['satisfied-by-architecture'],
      tone: 'success',
      to: to('met'),
    },
    { label: 'Partly met', value: pillar.counts.partial, tone: 'warning', to: to('partial') },
    { label: 'Not met', value: pillar.counts.fail, tone: 'danger', to: to('fail') },
    { label: 'Unanswered', value: pillar.unmeasurable, tone: 'unknown', to: to('unmeasurable') },
    { label: 'Not applicable', value: pillar.notApplicable, tone: 'excluded', to: to('not-applicable') },
  ];
}

function severityBars(pillar: PillarScore): readonly Bar[] {
  const of = (severity: Severity) => pillar.worstFirst.filter((finding) => finding.severity === severity).length;

  return (['critical', 'high', 'medium', 'low'] as const)
    .map((severity) => ({
      label: `${severity[0]?.toUpperCase() ?? ''}${severity.slice(1)}`,
      value: of(severity),
      tone: severity === 'critical' || severity === 'high' ? ('danger' as const) : ('warning' as const),
    }))
    .filter((bar) => bar.value > 0);
}

/** The denominator in words, so a small one cannot be mistaken for a flattering one. */
function describeDenominator(pillar: PillarScore): string {
  const parts = [`${pillar.scored} of ${pillar.total} requirements contributed to this score`];
  if (pillar.notApplicable > 0) {
    parts.push(`${pillar.notApplicable} do not apply to this estate and are excluded entirely`);
  }
  if (pillar.unmeasurable > 0) {
    const by = pillar.unmeasuredBy;
    // From the same four-reason list the line above the disclosure reads. Restated here, this
    // sentence had the same missing entry, so a pillar blocked mostly on unreachable scopes said
    // "47 are unanswered — 9 await your attestation" and left the reader to wonder about 38.
    const kinds = REASONS.filter((reason) => (by?.[reason.kind] ?? 0) > 0).map(
      (reason) => `${String(by?.[reason.kind])} ${reason.sentence}`
    );

    parts.push(
      kinds.length > 0
        ? `${pillar.unmeasurable} are unanswered and neither credited nor penalised — ${kinds.join(', ')}`
        : `${pillar.unmeasurable} could not be measured and are neither credited nor penalised`
    );
  }
  return `${parts.join('. ')}.`;
}

function PageEmpty({
  reason,
  heading,
  detail,
  action,
}: {
  reason: EmptyReason;
  heading: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <CustomerPage>
      <Surface tone="task">
        <EmptyState reason={reason} heading={heading} detail={detail} {...(action != null && { action })} />
      </Surface>
    </CustomerPage>
  );
}
