// What was decided about the findings, and whether the estate agrees.
//
// The register exists because a decision taken in a pane is invisible a fortnight later. Somebody
// accepts eleven risks across four pillars, each in the place it made sense, and there is then no
// screen in the app that answers "what have we agreed to live with" — which is the question a
// review asks, and the one an incoming owner asks first.
//
// It leads with the two rows that call for work rather than with the newest: a claimed fix the last
// run contradicts, and a decision whose date has passed. Everything else on this page is a record,
// and a record sorted by date is a record nobody reads to the bottom of.
//
// Nothing here can change the score, and the page says so in the header rather than in a footnote.
// A register of accepted failures that sat beside a rising number would be read as the cause of it.

import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@databricks/appkit-ui/react';
import { useAssessment } from '../api/assessment-context';
import { useDecisions } from '../api/hooks';
import { DecisionHistory } from '../components/DecisionHistory';
import { DecisionNote, StandingBadge } from '../components/DecisionNote';
import { CustomerPage, RecordButton, RecordList, StateNotice, Surface, TaskWorkspace } from '../components/system';
import { EmptyState } from '../components/ui/EmptyState';
import { Pagination } from '../components/ui/Pagination';
import { NotInList } from '../components/ui/NotInList';
import { onlySelection, selectionFrom, usePaged } from '../components/ui/paging';
import { useRevealedPane } from '../components/ui/reveal';
import { IdentifierBadge, SeverityBadge } from '../components/ui/StatusBadge';
import { DISPOSITION_LABEL, STANDING_LABEL, STANDING_RANK, decidedPhrase } from './decide-language';
import type { Decision, Standing } from '../api/types';

const ALL = 'all';

const EMPTY: readonly Decision[] = [];
const PAGE_SIZE = 10;

const STANDINGS: readonly Standing[] = [
  'contradicted',
  'lapsed',
  'due',
  'unverified',
  'current',
  'settled',
  'confirmed',
  'withdrawn',
];

export function DecisionsPage() {
  const { pillarTitle } = useAssessment();
  const [params, setParams] = useSearchParams();
  const decisions = useDecisions();

  const standing = params.get('standing') ?? ALL;
  const query = params.get('q') ?? '';
  const selectedId = params.get('control');

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === '' || value === ALL) next.delete(key);
    else next.set(key, value);
    if (key !== 'control') next.delete('control');
    setParams(next, { replace: true });
  };

  const all = useMemo(() => decisions.data?.decisions ?? EMPTY, [decisions.data?.decisions]);

  const counts = useMemo(() => {
    const tally = new Map<Standing, number>();
    for (const decision of all) tally.set(decision.standing, (tally.get(decision.standing) ?? 0) + 1);
    return tally;
  }, [all]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all
      .filter((decision) => standing === ALL || decision.standing === standing)
      .filter(
        (decision) =>
          needle === '' ||
          (decision.title ?? '').toLowerCase().includes(needle) ||
          decision.controlId.toLowerCase().includes(needle) ||
          decision.reason.toLowerCase().includes(needle) ||
          (decision.owner ?? '').toLowerCase().includes(needle)
      )
      .sort(
        (a, b) =>
          STANDING_RANK[a.standing] - STANDING_RANK[b.standing] ||
          // Newest first within a standing: two lapsed acceptances are equally overdue, and the one
          // decided last week is the one somebody still remembers the reasoning for.
          b.decidedAt.localeCompare(a.decidedAt) ||
          a.controlId.localeCompare(b.controlId)
      );
  }, [all, standing, query]);

  const selectedAt = rows.findIndex((decision) => decision.controlId === selectedId);
  const paged = usePaged(rows, PAGE_SIZE, selectedAt);
  const { row: selected, missing } = selectionFrom({
    all: rows,
    page: paged.rows,
    asked: selectedId,
    at: selectedAt,
    known: all.some((decision) => decision.controlId === selectedId),
  });
  const pane = useRevealedPane(selectedId);

  if (decisions.error != null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Decisions unavailable">
          <EmptyState
            reason="collector-failed"
            heading="The decisions could not be read"
            detail={decisions.error}
            action={
              <button type="button" className="wa-button-secondary" onClick={decisions.reload}>
                Try again
              </button>
            }
          />
        </Surface>
      </CustomerPage>
    );
  }

  return (
    <CustomerPage>
      {/* Said before anything is read, not before anything is written — by the time somebody is on
          this page the decisions already exist, and what they need to know is that the record they
          are reviewing will not survive a restart. */}
      {decisions.data != null && !decisions.data.durable && all.length > 0 && (
        <StateNotice
          tone="warning"
          announce="alert"
          title="These decisions are not durable"
          detail={
            <p>
              These decisions are held in memory and will be lost when the app restarts.{' '}
              {decisions.data.durabilityNote ?? 'Unset WAF_DEMO_NO_PERSISTENCE and restart to keep them.'}{' '}
              <Link className="text-wa-action hover:underline" to="/diagnostics">
                What this app can reach →
              </Link>
            </p>
          }
        />
      )}

      {all.length === 0 && !decisions.loading ? (
        <Surface tone="section" title="Decisions about unmet requirements" description="0 recorded">
          <EmptyState
            reason="not-yet-collected"
            heading="Nothing decided yet"
            detail="From an unmet requirement, accept a risk, create an improvement plan, or record that planned work is complete. Each decision appears here with its owner and current standing."
            layout="compact"
            action={
              <Link to="/investigate?outcome=unmet" className="wa-button-primary">
                Review unmet requirements
              </Link>
            }
          />
        </Surface>
      ) : (
        <TaskWorkspace
          queueLabel="Decisions taken"
          taskLabel="Selected decision"
          queue={
            <Surface
              tone="section"
              title="Decisions about unmet requirements"
              description={
                paged.total === all.length
                  ? `${String(all.length)} recorded`
                  : `${String(paged.total)} of ${String(all.length)} shown`
              }
            >
              <search className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  className="wa-field wa-body-compact w-full"
                  placeholder="Search requirement, owner or reason"
                  aria-label="Search decisions by requirement, owner or reason"
                  value={query}
                  onChange={(event) => set('q', event.target.value)}
                />
                <Select value={standing} onValueChange={(value) => set('standing', value)}>
                  <SelectTrigger className="wa-select w-full" aria-label="Filter by standing">
                    <SelectValue placeholder="Any standing" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>Any standing ({all.length})</SelectItem>
                    {/* Only the standings this set contains. Eight options of which six read "(0)" is a
                    filter that mostly offers dead ends. */}
                    {STANDINGS.filter((value) => (counts.get(value) ?? 0) > 0).map((value) => (
                      <SelectItem key={value} value={value}>
                        {STANDING_LABEL[value]} ({counts.get(value) ?? 0})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </search>

              {decisions.loading && all.length === 0 ? (
                <EmptyState
                  reason="not-yet-collected"
                  heading="Reading the decisions"
                  detail="Fetching what has been decided about each finding, and checking it against the latest run."
                />
              ) : paged.total === 0 ? (
                <EmptyState
                  reason={all.length === 0 ? 'not-yet-collected' : 'filtered-out'}
                  {...(all.length === 0
                    ? {
                        heading: 'Nothing decided yet',
                        detail:
                          'Accepting a risk, planning a fix or recording one is done from the finding itself, where the evidence is. Anything decided there is listed here.',
                        // Unmet rather than failed. A decision can be recorded against a partly met
                        // requirement too, so `outcome=fail` hid half the queue this page is sending
                        // somebody off to decide about.
                        action: (
                          <Link to="/findings?outcome=unmet" className="wa-button-secondary">
                            Go to the findings
                          </Link>
                        ),
                      }
                    : {
                        detail:
                          'These filters exclude every decision. Widening the standing or clearing the search will bring them back.',
                        action: (
                          <button
                            type="button"
                            className="wa-button-secondary"
                            onClick={() => setParams({}, { replace: true })}
                          >
                            Clear filters
                          </button>
                        ),
                      })}
                />
              ) : (
                <>
                  <RecordList label="Decision records">
                    {paged.rows.map((decision) => (
                      <RecordButton
                        key={decision.id}
                        selected={decision.controlId === selected?.controlId}
                        onSelect={() => set('control', decision.controlId)}
                        eyebrow={
                          <span className="flex flex-wrap items-center gap-1.5">
                            {decision.severity != null && <SeverityBadge severity={decision.severity} />}
                            <StandingBadge standing={decision.standing} />
                          </span>
                        }
                        title={decision.title ?? decision.controlId}
                        summary={[
                          DISPOSITION_LABEL[decision.disposition],
                          decision.pillarId != null ? pillarTitle(decision.pillarId) : undefined,
                        ]
                          .filter((part): part is string => part != null)
                          .join(' · ')}
                        meta={decidedPhrase(decision)}
                        aside={decision.controlId === selected?.controlId ? 'Selected' : 'Open'}
                      />
                    ))}
                  </RecordList>
                  <Pagination paged={paged} noun="decisions" />
                </>
              )}
            </Surface>
          }
          task={
            <div ref={pane}>
              <Surface
                tone="task"
                title={selected?.title ?? selected?.controlId ?? 'Select a decision'}
                description="Reasoning, ownership, current standing, and the evidence behind the decision."
              >
                {missing != null ? (
                  <NotInList
                    id={missing.id}
                    known={missing.known}
                    noun="decision"
                    onClear={(keep) => setParams(onlySelection('control', keep ? missing.id : null), { replace: true })}
                  />
                ) : selected == null ? (
                  <EmptyState
                    reason="not-yet-collected"
                    heading="Nothing selected"
                    detail="Choose a decision to read the reasoning, who is answerable for it, and what the latest run makes of it."
                  />
                ) : (
                  <Selected
                    key={selected.controlId}
                    decision={selected}
                    pillar={pillarTitle(selected.pillarId ?? '')}
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

function Selected({ decision, pillar }: { decision: Decision; pillar: string }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="wa-caption text-wa-text-secondary">{pillar}</span>
        {decision.severity != null && <SeverityBadge severity={decision.severity} />}
        <StandingBadge standing={decision.standing} />
        <IdentifierBadge>{decision.controlId}</IdentifierBadge>
      </div>

      <DecisionNote decision={decision} badged={false} />

      {/* The way back to the evidence. This page states what was decided; the reasoning behind it
            is only checkable against what was observed, which lives on the finding. */}
      <Link
        to={`/findings?control=${decision.controlId}`}
        className="wa-body-compact inline-block text-wa-action hover:underline"
      >
        Open the finding
      </Link>
      <DecisionHistory controlId={decision.controlId} />
    </div>
  );
}
