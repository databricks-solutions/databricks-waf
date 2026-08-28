// The findings worth reading first. The answer to "what is worst", and the reason the overview exists.
//
// It was four rows two lines deep in a 340px rail beside a pillar focus panel, and the rail is why it
// read the way it did: severity was a badge at the end of a wrapped title, the pillar and the
// resource count shared one grey line under it, and nothing lined up down a column. A reader landing
// on the page could see that some things were wrong and could not see which was worst without
// reading all four. Two more facts per row — evidence quality, whether a fix exists — had already
// been cut for space, correctly, because in 340px they wrapped to a third line and said the same
// thing on every row.
//
// It has the wide column now, so it is one line per row with severity in the first column. That is
// the whole change and it is the point: severity down a column is read at a glance, severity at the
// end of a variable-length title is read one row at a time.
//
// How many rows is measured, not chosen. Nine "fit the band" on the screen they were counted on and
// left 390px of empty canvas under them on a 14" MacBook, which on the one page that must not scroll
// is the most visible kind of wrong. The list fills the band it is given and the rest is one click
// away — no pager here, because a landing page's job is the top of the queue rather than all of it.
//
// The whole row is the link, not the title. See `.wa-row:has(.wa-row-link)`.
//
// It deliberately does not repeat a "Not met" badge: severity and the panel's own title already say
// that, and a third statement of it crowds out the facts that differ per row.

import { useMemo } from 'react';
import { Link } from 'react-router';
import { useAssessment } from '../api/assessment-context';
import { useDecisions } from '../api/hooks';
import { parkedPhrase } from '../pages/decide-language';
import { StandingBadge } from './DecisionNote';
import { affectedPhrase, splitFindings, type RankedFinding } from './finding-rank';
import { shortPillarLabel } from './shell/pillar-label';
import { EmptyState } from './ui/EmptyState';
import { Surface } from './system';
import { Pagination } from './ui/Pagination';
import { usePaged } from './ui/paging';
import { SeverityBadge } from './ui/StatusBadge';
import type { Scan } from '../api/types';

export interface PriorityFindingsProps {
  readonly scan: Scan;
}

/**
 * What the `+1` on a row stands for, as a tooltip.
 *
 * The ids rather than the titles, because a title is as long as the one already on the row and this is
 * an attribute rather than a panel. Somebody who wants the titles opens the row, where the pane names
 * them in full. Undefined where there is nothing to add, so the attribute is absent rather than
 * restating what is visible.
 */
function alsoMeasured(entry: RankedFinding): string | undefined {
  if (entry.alsoNamed == null) return undefined;
  const named = entry.alsoNamed.map((one) => one.controlId).join(', ');
  return `One reading also answers ${named}, so they carry the same verdict. Open the row for the rest.`;
}

export function PriorityFindings({ scan }: PriorityFindingsProps) {
  const { controlOf, pillarTitle } = useAssessment();
  // Decisions are read here rather than passed in because this panel appears on two pages and the
  // request is one call for the whole set. A build with nothing bound to keep decisions in answers
  // with an empty list, so the queue behaves exactly as it did before the feature existed.
  const decisions = useDecisions();
  const byControl = useMemo(
    () => new Map((decisions.data?.decisions ?? []).map((decision) => [decision.controlId, decision])),
    [decisions.data?.decisions]
  );
  const { queue, held } = useMemo(
    () => splitFindings(scan.findings, controlOf, (controlId) => byControl.get(controlId)),
    [scan.findings, controlOf, byControl]
  );
  const paged = usePaged(queue, 8);
  const shown = paged.rows;
  const parked = parkedPhrase(held.length);

  return (
    <Surface
      tone="raised"
      label="Priority findings"
      title="Highest risk"
      action={
        <Link to="/investigate?outcome=unmet" className="wa-caption wa-aside-link hover:underline">
          All {queue.length + held.length} unmet →
        </Link>
      }
    >
      {/* The link is filtered to the union its own label counts. Unfiltered, "all 46 unmet" opened a
          list of 148 requirements including the passing ones, and the reader's first act on the page
          they had been sent to was working out what had gone wrong. */}
      {shown.length === 0 ? (
        /* Three empty states, not one. "Nothing unmet" is true when nothing failed and false when
           several things failed and somebody parked all of them — and telling a reader their estate
           is clean because their colleague accepted every finding in it is the single worst sentence
           this app could print. */
        held.length > 0 ? (
          <EmptyState
            reason="held-by-decision"
            detail={`Everything unmet has been accepted, planned or claimed fixed — ${String(held.length)} in all. The requirements still fail and still cost their points.`}
            action={
              <Link to="/decisions" className="wa-button-secondary">
                Review decisions
              </Link>
            }
          />
        ) : (
          <EmptyState
            reason={scan.score.scoredControls === 0 ? 'no-evidence' : 'nothing-to-report'}
            heading="Nothing unmet"
            detail={
              scan.score.scoredControls === 0
                ? 'No requirement was evaluated, so nothing could come back unmet. That is a gap in evidence rather than a clean result.'
                : 'No requirement this scan evaluated came back unmet or partly met. Requirements it could not evaluate are listed under evidence gaps.'
            }
          />
        )
      ) : (
        <>
          <ol>
            {shown.map((entry) => (
              <li key={entry.finding.controlId} className="wa-row items-center gap-3 py-1.5">
                {/* Severity first and in a fixed column, so the worst rows are found by running down
                    one edge rather than by reading nine titles to their ends. */}
                <span className="flex w-[84px] shrink-0 items-center gap-1.5">
                  <SeverityBadge severity={entry.finding.severity} />
                </span>

                <Link
                  to={`/investigate?control=${encodeURIComponent(entry.finding.controlId)}`}
                  className="wa-row-link wa-body-compact min-w-0 flex-1 truncate font-medium text-wa-text"
                  title={entry.finding.title}
                >
                  {entry.finding.title}
                </Link>

                {/* Where this row stands for more than one requirement, because one reading answers
                    several. Beside the title rather than in the pillar column, which is where it was
                    first put and where it said the wrong thing: three of the five groups in a real
                    run are two requirements inside one pillar, so a `+1` next to the pillar name read
                    as a second pillar that does not exist. The count with no names is deliberate —
                    the alternative is a second title in a row that has to stay one line — and the
                    tooltip and the pane both name them. */}
                {entry.alsoNamed != null && (
                  <span className="wa-caption shrink-0" title={alsoMeasured(entry)}>
                    +{entry.alsoNamed.length}
                  </span>
                )}

                {/* Only where the estate disagrees with a claim. Every other standing has taken the
                    row off this list, so a badge here always means the same thing. */}
                {entry.decision?.standing === 'contradicted' && (
                  <span className="shrink-0">
                    <StandingBadge standing={entry.decision.standing} />
                  </span>
                )}

                {/* Both hidden below 1100px rather than wrapped. A fourth column that becomes a
                    second line turns a nine-row list into fourteen rows of ragged height, and the
                    findings page states both per row with room to spare. */}
                <span className="wa-caption hidden w-[132px] shrink-0 truncate lg:block">
                  {shortPillarLabel(entry.finding.pillarId, pillarTitle(entry.finding.pillarId))}
                </span>
                <span className="wa-caption hidden w-[148px] shrink-0 truncate text-right xl:block">
                  {affectedPhrase(entry) ?? ''}
                </span>
              </li>
            ))}
          </ol>
          <Pagination paged={paged} noun="priority findings" />
          {/* What this list is not showing, and where to see it. A queue that quietly drops rows is
              a queue whose length nobody can reconcile with the findings page. */}
          {parked != null && (
            <p className="wa-caption border-t border-wa-divider px-3 py-2">
              {parked}.{' '}
              <Link to="/decisions" className="text-wa-action hover:underline">
                Decisions
              </Link>
            </p>
          )}
        </>
      )}
    </Surface>
  );
}
