// Every requirement this estate has accepted being unmet, and what is holding the line instead.
//
// The register an auditor asks for by name. Somebody accepts nine exposures across four pillars, each
// in the pane where it made sense, and without this page there is no screen that answers "what are we
// carrying, on whose authority, and until when" — which is the first question of a review and the
// first question of an incoming owner.
//
// It leads with what has stopped holding rather than with the newest. An expired acceptance is the one
// row on the page that nobody decided: the requirement came back onto the queue on a date that passed,
// silently, because nothing wakes up and says so. Everything else here is doing what whoever wrote it
// intended.
//
// Nothing on this page moves the score, and the header says so rather than a footnote. A register of
// accepted failures beside a rising number would be read as the cause of it.

import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@databricks/appkit-ui/react';
import { useAssessment } from '../api/assessment-context';
import { useRisks } from '../api/hooks';
import { AcceptedRiskNote, RiskStandingBadge } from '../components/AcceptedRiskNote';
import { CustomerPage, RecordButton, RecordList, StateNotice, Surface, TaskWorkspace } from '../components/system';
import { EmptyState } from '../components/ui/EmptyState';
import { Pagination } from '../components/ui/Pagination';
import { NotInList } from '../components/ui/NotInList';
import { onlySelection, selectionFrom, usePaged } from '../components/ui/paging';
import { useRevealedPane } from '../components/ui/reveal';
import { IdentifierBadge, SeverityBadge } from '../components/ui/StatusBadge';
import {
  expiryPhrase,
  needsAttention,
  registerPhrase,
  RISK_STANDINGS,
  STANDING_LABEL,
  STANDING_RANK,
} from './accept-language';
import type { AcceptedRisk, RiskStanding } from '../api/types';

const ALL = 'all';

const EMPTY: readonly AcceptedRisk[] = [];
const PAGE_SIZE = 10;

export function ExceptionsPage() {
  const { pillarTitle } = useAssessment();
  const [params, setParams] = useSearchParams();
  const risks = useRisks();

  const standing = params.get('standing') ?? ALL;
  const query = params.get('q') ?? '';
  const selectedId = params.get('risk');

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === '' || value === ALL) next.delete(key);
    else next.set(key, value);
    if (key !== 'risk') next.delete('risk');
    setParams(next, { replace: true });
  };

  const all = useMemo(() => risks.data?.risks ?? EMPTY, [risks.data?.risks]);

  const counts = useMemo(() => {
    const tally = new Map<RiskStanding, number>();
    for (const risk of all) tally.set(risk.standing, (tally.get(risk.standing) ?? 0) + 1);
    return tally;
  }, [all]);

  /*
   * How many rows are somebody's to act on now, which is what the header leads with.
   *
   * Counted over everything rather than over the filtered rows: a reader who has filtered to the
   * replaced ones is still owed the number of expired ones, and a count that moved with the filter
   * would be a different statistic under the same words.
   */
  const attention = useMemo(() => all.filter((risk) => needsAttention(risk.standing)).length, [all]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all
      .filter((risk) => standing === ALL || risk.standing === standing)
      .filter(
        (risk) =>
          needle === '' ||
          (risk.title ?? '').toLowerCase().includes(needle) ||
          risk.controlId.toLowerCase().includes(needle) ||
          risk.reason.toLowerCase().includes(needle) ||
          // The compensating control is searched because it is the field somebody comes here looking
          // for: "which exceptions rest on the quarterly access review" is the review's own question.
          risk.compensatingControl.toLowerCase().includes(needle) ||
          risk.owner.toLowerCase().includes(needle)
      )
      .sort(
        (a, b) =>
          STANDING_RANK[a.standing] - STANDING_RANK[b.standing] ||
          // Soonest expiry first within a standing, rather than newest: two acceptances that are both
          // expiring are not equally urgent, and the date is the thing that separates them.
          a.expiresAt.localeCompare(b.expiresAt) ||
          a.controlId.localeCompare(b.controlId)
      );
  }, [all, standing, query]);

  const selectedAt = rows.findIndex((risk) => risk.id === selectedId);
  const paged = usePaged(rows, PAGE_SIZE, selectedAt);
  const { row: selected, missing } = selectionFrom({
    all: rows,
    page: paged.rows,
    asked: selectedId,
    at: selectedAt,
    known: all.some((risk) => risk.id === selectedId),
  });
  const pane = useRevealedPane(selectedId);

  if (risks.error != null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Accepted risks unavailable">
          <EmptyState
            reason="collector-failed"
            heading="The accepted risks could not be read"
            detail={risks.error}
            action={
              <button type="button" className="wa-button-secondary" onClick={risks.reload}>
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
      {/* The expiry is the part of this record that puts work back, and it is the first thing a
          restart loses. Said before anything is read: by the time somebody is on this page the
          exceptions exist, and what they need to know is that the register will not survive. */}
      {risks.data != null && !risks.data.durable && all.length > 0 && (
        <StateNotice
          tone="warning"
          announce="alert"
          title="These acceptances are not durable"
          detail={
            <p>
              These acceptances are held in memory and will be lost when the app restarts, including their expiry dates.{' '}
              {risks.data.durabilityNote ?? 'Bind a database and restart to keep them.'}{' '}
              <Link className="text-wa-action hover:underline" to="/diagnostics">
                What this app can reach →
              </Link>
            </p>
          }
        />
      )}

      {all.length === 0 && !risks.loading ? (
        <Surface tone="section" title="Accepted exceptions" description="0 recorded">
          <EmptyState
            reason="not-yet-collected"
            heading="No accepted risks"
            detail="Accept an unmet requirement from its evidence when a compensating control will hold it for a defined period. Accepted risks appear here with their owner and expiry."
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
          queueLabel="Accepted risks"
          taskLabel="Selected acceptance"
          queue={
            <Surface
              tone="section"
              title="Accepted exceptions"
              description={
                paged.total === all.length
                  ? `${String(all.length)} recorded`
                  : `${String(paged.total)} of ${String(all.length)} shown`
              }
            >
              {/* The state of the register in one line, above the filters. A reader who lands here wants
              to know whether anything needs them before they start reading rows. */}
              <p className="wa-caption mb-3">{registerPhrase(all.length, attention)}</p>

              <search className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  className="wa-field wa-body-compact w-full"
                  placeholder="Search requirement, owner, reason or control"
                  aria-label="Search accepted risks by requirement, owner, reason or compensating control"
                  value={query}
                  onChange={(event) => set('q', event.target.value)}
                />
                <Select value={standing} onValueChange={(value) => set('standing', value)}>
                  <SelectTrigger className="wa-select w-full" aria-label="Filter by standing">
                    <SelectValue placeholder="Any standing" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>Any standing ({all.length})</SelectItem>
                    {/* Only the standings this set contains, for the reason the decisions filter gives:
                    six options reading "(0)" is a filter that mostly offers dead ends. */}
                    {RISK_STANDINGS.filter((value) => (counts.get(value) ?? 0) > 0).map((value) => (
                      <SelectItem key={value} value={value}>
                        {STANDING_LABEL[value]} ({counts.get(value) ?? 0})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </search>

              {risks.loading && all.length === 0 ? (
                <EmptyState
                  reason="not-yet-collected"
                  heading="Reading the register"
                  detail="Fetching what has been accepted, and working out which of them still hold."
                />
              ) : paged.total === 0 ? (
                <EmptyState
                  reason={all.length === 0 ? 'not-yet-collected' : 'filtered-out'}
                  {...(all.length === 0
                    ? {
                        heading: 'Nothing has been accepted',
                        detail:
                          'Accepting a requirement being unmet is done from the finding itself, where the evidence is. It asks what is holding the line instead, and for a date it stops — both of which are listed here.',
                        action: (
                          <Link to="/findings?outcome=unmet" className="wa-button-secondary">
                            Go to the findings
                          </Link>
                        ),
                      }
                    : {
                        detail:
                          'These filters exclude every acceptance. Widening the standing or clearing the search will bring them back.',
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
                  <RecordList label="Accepted risk records">
                    {paged.rows.map((risk) => (
                      <RecordButton
                        key={risk.id}
                        selected={risk.id === selected?.id}
                        onSelect={() => set('risk', risk.id)}
                        eyebrow={
                          <span className="flex flex-wrap items-center gap-1.5">
                            {risk.severity != null && <SeverityBadge severity={risk.severity} />}
                            <RiskStandingBadge standing={risk.standing} />
                          </span>
                        }
                        title={risk.title ?? risk.controlId}
                        summary={risk.pillarId != null ? pillarTitle(risk.pillarId) : undefined}
                        meta={`${expiryPhrase(risk)} · ${risk.owner} is answerable`}
                        aside={risk.id === selected?.id ? 'Selected' : 'Open'}
                      />
                    ))}
                  </RecordList>
                  <Pagination paged={paged} noun="acceptances" />
                </>
              )}
            </Surface>
          }
          task={
            <div ref={pane}>
              <Surface
                tone="task"
                title={selected?.title ?? selected?.controlId ?? 'Select an accepted risk'}
                description="Compensating control, residual exposure, ownership, expiry, and supporting evidence."
              >
                {missing != null ? (
                  <NotInList
                    id={missing.id}
                    known={missing.known}
                    noun="acceptance"
                    onClear={(keep) => setParams(onlySelection('risk', keep ? missing.id : null), { replace: true })}
                  />
                ) : selected == null ? (
                  <EmptyState
                    reason="not-yet-collected"
                    heading="Nothing selected"
                    detail="Choose an acceptance to read what is holding the line, how much risk is left, and when it stops."
                  />
                ) : (
                  <Selected key={selected.id} risk={selected} pillar={pillarTitle(selected.pillarId ?? '')} />
                )}
              </Surface>
            </div>
          }
        />
      )}
    </CustomerPage>
  );
}

function Selected({ risk, pillar }: { risk: AcceptedRisk; pillar: string }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="wa-caption text-wa-text-secondary">{pillar}</span>
        {risk.severity != null && <SeverityBadge severity={risk.severity} />}
        <RiskStandingBadge standing={risk.standing} />
        <IdentifierBadge>{risk.controlId}</IdentifierBadge>
      </div>

      <AcceptedRiskNote risk={risk} badged={false} />

      {/*
       * That this replaced an earlier one, and the way to the rest of the chain.
       *
       * Named rather than linked to on its own, because the id of a superseded acceptance is not
       * something a reader can do anything with — what they want is the requirement's whole history,
       * which is on the finding.
       */}
      {risk.supersedes != null && (
        <p className="wa-caption">
          This replaced an earlier acceptance of the same requirement. Both are kept, so how long the exposure has been
          carried stays readable.
        </p>
      )}

      {/* No "Accepted by" line here. The note above already ends with who accepted it, who is
            answerable and when it expires, and this pane repeated the first of those verbatim two
            paragraphs later — the same stutter two modules composing produced on the action pane. */}

      {/* The way back to the evidence. This page states what is being carried; whether that is
            reasonable is only checkable against what was observed, which lives on the finding. */}
      <Link
        to={`/findings?control=${risk.controlId}`}
        className="wa-body-compact inline-block text-wa-action hover:underline"
      >
        Open the finding
      </Link>
    </div>
  );
}
