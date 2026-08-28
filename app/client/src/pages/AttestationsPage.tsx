// The requirements no telemetry can reach, and the answers to them.
//
// Eighty-two of the catalogue's requirements are about practice rather than configuration: whether
// recovery is rehearsed, whether ownership is defined, whether a review actually happens. No API
// returns those. Before this page they reported as unmeasured, which was honest and left more than
// two-fifths of the framework permanently outside the score.
//
// The page is built around the distinction that makes the score worth reading: an answer here is
// somebody's statement, not an observation, and it is labelled that way everywhere it surfaces. It
// also expires. Both properties exist to stop this becoming the questionnaire that quietly replaces
// the assessment — a set of answers given once, never revisited, and indistinguishable in the total
// from what the tool measured itself.
//
// Filters and selection live in the URL, on the same reasoning as the findings page: "the lapsed
// answers in reliability" is a thing one person hands to another.

import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@databricks/appkit-ui/react';
import { AlertTriangle, ListOrdered } from 'lucide-react';
import { useAssessment } from '../api/assessment-context';
import { useAttestations, useSubmitAnswer } from '../api/hooks';
import { QuestionPane } from '../components/QuestionPane';
import { StateBadge } from '../components/StateBadge';
import { CustomerPage, Surface, TaskWorkspace } from '../components/system';
import { EmptyState } from '../components/ui/EmptyState';
import { Pagination } from '../components/ui/Pagination';
import { NotInList } from '../components/ui/NotInList';
import { onlySelection, selectionFrom, usePaged } from '../components/ui/paging';
import { useRevealed, useRevealedPane } from '../components/ui/reveal';
import { SeverityBadge } from '../components/ui/StatusBadge';
import {
  ANSWER_LABEL,
  ASKED_LABEL,
  EVERY_PILLAR,
  inPillar,
  REQUIREMENT_STATES,
  STATE_LABEL,
  STATE_RANK,
  type RequirementState,
  progressPhrase,
  stateOf,
} from './attest-language';
import type { AskedBecause, AttestableRequirement, Severity } from '../api/types';

/** The sentinel every filter here uses for "not narrowing". Taken from the pillar predicate rather
 *  than written again, so the value `/checks` counts against cannot drift from the value this list
 *  filters on. */
const ALL = EVERY_PILLAR;

const EMPTY: readonly AttestableRequirement[] = [];

/**
 * The guided pass, carrying this list's pillar filter into it.
 *
 * Carried because the reader who has filtered to reliability and then asks to answer in order means
 * reliability, and a pass that silently widened to all seven would be answering a question they did
 * not ask. The other filters are deliberately not carried: state and search narrow a triage list,
 * and a pass whose scope was "the expired ones matching 'backup'" is not a pass over a principle.
 */
function walkTo(pillar: string): string {
  return pillar === ALL ? '/answers/walk' : `/answers/walk?pillar=${encodeURIComponent(pillar)}`;
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  informational: 4,
};

export function AttestationsPage() {
  const { pillarTitle } = useAssessment();
  const [params, setParams] = useSearchParams();
  const answers = useAttestations();
  const submission = useSubmitAnswer(answers.reload);

  const state = params.get('state') ?? ALL;
  const pillar = params.get('pillar') ?? ALL;
  const because = params.get('because') ?? ALL;
  const query = params.get('q') ?? '';
  const selectedId = params.get('control');

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === '' || value === ALL) next.delete(key);
    else next.set(key, value);
    if (key !== 'control') next.delete('control');
    setParams(next, { replace: true });
  };

  // Memoised only so the three derivations below have a stable dependency. `?? []` allocates a new
  // array on every render, which would make every memo that reads it useless.
  const all = useMemo(() => answers.data?.requirements ?? EMPTY, [answers.data?.requirements]);

  const counts = useMemo(() => {
    const tally: Record<RequirementState, number> = { unanswered: 0, expired: 0, due: 0, current: 0 };
    for (const requirement of all) tally[stateOf(requirement)] += 1;
    return tally;
  }, [all]);

  const pillars = useMemo(() => [...new Set(all.map((one) => one.pillarId))].sort(), [all]);

  const kinds = useMemo(() => {
    const tally: Record<AskedBecause, number> = { 'no-telemetry': 0, 'not-authorised': 0, inconclusive: 0 };
    for (const requirement of all) tally[requirement.askedBecause] += 1;
    return tally;
  }, [all]);

  const requirements = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (
      all
        .filter((one) => state === ALL || stateOf(one) === state)
        // The same predicate `/checks` counts its offer over. Shared rather than repeated: that link
        // promised 23 requirements and this list showed 47 of them for as long as the two surfaces
        // decided separately what a pillar's questions were.
        .filter((one) => inPillar(one, pillar))
        .filter((one) => because === ALL || one.askedBecause === because)
        .filter(
          (one) =>
            needle === '' ||
            one.title.toLowerCase().includes(needle) ||
            one.controlId.toLowerCase().includes(needle) ||
            one.question.toLowerCase().includes(needle)
        )
        .sort(
          (a, b) =>
            STATE_RANK[stateOf(a)] - STATE_RANK[stateOf(b)] ||
            SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
            a.controlId.localeCompare(b.controlId)
        )
    );
  }, [all, state, pillar, because, query]);

  // Paged around the selection rather than from the top. Arriving from a finding's "Answer this
  // requirement" link selects a requirement that may be seventy rows down, and the list used to stay
  // on page one — the form on the right showed a cost requirement while the ten rows on the left were
  // all security, with nothing highlighted among them.
  const selectedAt = requirements.findIndex((one) => one.controlId === selectedId);
  // Ten rows keep the queue bounded while preserving enough context to scan before answering.
  const paged = usePaged(requirements, 10, selectedAt);
  // No silent fallback to the first row: this pane carries a form that writes an answer against
  // whichever requirement it is showing. See selectionFrom.
  const { row: selected, missing } = selectionFrom({
    all: requirements,
    page: paged.rows,
    asked: selectedId,
    at: selectedAt,
    known: all.some((one) => one.controlId === selectedId),
  });
  // Paging to the right page is not the same as putting the row on screen. See reveal.
  const reveal = useRevealed(selected?.controlId);
  // At compact widths the selected task follows the queue in normal flow. A cold deep link must
  // still reveal the question it names rather than leaving it two screens below the address target.
  const pane = useRevealedPane(params.get('control'));
  if (answers.error != null) {
    return (
      <CustomerPage>
        <Surface tone="task">
          <EmptyState
            reason="collector-failed"
            heading="The answers could not be read"
            detail={answers.error}
            action={
              <button type="button" className="wa-button-secondary" onClick={answers.reload}>
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
      {/* The one thing a reader has to know before they type: whether what they write will still
          be here tomorrow. A page that accepted a considered statement and lost it on the next
          restart would be worse than one that refused it, so this is a banner and not a footnote. */}
      {answers.data != null && !answers.data.durable && (
        <div className="wa-notice-warning flex items-start gap-2" role="alert">
          <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-wa-warning" />
          <p className="wa-body-compact">
            Answers are being held in memory and will be lost when the app restarts.{' '}
            {answers.data.durabilityNote ?? 'Unset WAF_DEMO_NO_PERSISTENCE and restart to keep them.'}{' '}
            {/* The cause of this is a binding rather than anything on this page, and it is the same
                binding behind three other complaints elsewhere. Naming where they are all reconciled
                is the difference between a warning and a next step. */}
            <Link className="text-wa-action hover:underline" to="/diagnostics">
              What this app can reach →
            </Link>
          </p>
        </div>
      )}

      {/* The queue and selected requirement remain one task workspace: bounded pagination keeps the
          choice readable, while the task follows it in normal document flow at compact widths. */}
      <TaskWorkspace
        queueLabel="Requirements that need an answer"
        taskLabel="Selected requirement"
        queue={
          <Surface
            tone="raised"
            label="Requirements that need an answer"
            title="Answered by a person"
            description={progressPhrase(all)}
            action={
              /* The way into the guided pass, and the only one. This list is the right shape for
                    picking off the four answers that lapsed; it is the wrong shape for a first pass
                    of sixty-three, which is what the pass beside it is for. A reader who has never
                    done one has no reason to guess that a second surface exists, so it is offered
                    here rather than added to the rail — the rail would present two pages as
                    alternatives when one is a mode of the other. */
              <Link className="wa-button-secondary shrink-0" to={walkTo(pillar)}>
                <ListOrdered aria-hidden className="h-4 w-4" />
                Answer in order
              </Link>
            }
          >
            {/* A grid rather than a wrapping flex row. Four controls do not fit the pane's measure at
              any width the two-column layout exists at, so a flex row always broke — leaving one
              control alone on a second line beside 500px of nothing, and a first line that stopped
              short of the right edge because the three widths were all different. Two columns that
              fill is the same information looking deliberate. */}
            <search className="grid grid-cols-1 gap-2 border-b border-wa-divider p-2 sm:grid-cols-2">
              <input
                className="wa-field wa-body-compact w-full"
                placeholder="Search title, id or question"
                aria-label="Search requirements by title, control id or question"
                value={query}
                onChange={(event) => set('q', event.target.value)}
              />
              <Select value={state} onValueChange={(value) => set('state', value)}>
                <SelectTrigger className="wa-select w-full" aria-label="Filter by whether it is answered">
                  <SelectValue placeholder="Any state" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Any state ({all.length})</SelectItem>
                  {REQUIREMENT_STATES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {STATE_LABEL[value]} ({counts[value]})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={pillar} onValueChange={(value) => set('pillar', value)}>
                <SelectTrigger className="wa-select w-full" aria-label="Filter by pillar">
                  <SelectValue placeholder="Any pillar" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Any pillar</SelectItem>
                  {pillars.map((value) => (
                    <SelectItem key={value} value={value}>
                      {pillarTitle(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Filterable because the two kinds are different work. Answering the practice
                questions is a conversation with the teams that own them; answering the blocked
                settings is one person with the workspace admin console open. */}
              <Select value={because} onValueChange={(value) => set('because', value)}>
                <SelectTrigger className="wa-select w-full" aria-label="Filter by why it needs an answer">
                  <SelectValue placeholder="Any reason" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Asked for any reason</SelectItem>
                  <SelectItem value="no-telemetry">
                    {ASKED_LABEL['no-telemetry']} ({kinds['no-telemetry']})
                  </SelectItem>
                  <SelectItem value="not-authorised">
                    {ASKED_LABEL['not-authorised']} ({kinds['not-authorised']})
                  </SelectItem>
                </SelectContent>
              </Select>
            </search>

            {answers.loading && all.length === 0 ? (
              <EmptyState
                reason="not-yet-collected"
                heading="Reading the answers"
                detail="Fetching every requirement that needs a person to answer it, and the answers already given."
              />
            ) : paged.total === 0 ? (
              <EmptyState
                reason={all.length === 0 ? 'nothing-to-report' : 'filtered-out'}
                {...(all.length === 0
                  ? {
                      heading: 'Nothing needs answering',
                      detail:
                        'Every requirement in this build can be measured from the platform, so none of them rests on a statement.',
                    }
                  : {
                      detail:
                        'These filters exclude every requirement. Widening the state or clearing the search will bring results back.',
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
                <ul className="wa-zebra">
                  {paged.rows.map((requirement) => {
                    const chosen = requirement.controlId === selected?.controlId;
                    return (
                      <li key={requirement.controlId} ref={chosen ? reveal : undefined}>
                        <RequirementRow
                          requirement={requirement}
                          pillar={pillarTitle(requirement.pillarId)}
                          selected={chosen}
                          onSelect={() => set('control', requirement.controlId)}
                        />
                      </li>
                    );
                  })}
                </ul>
                <Pagination paged={paged} noun="requirements" />
              </>
            )}
          </Surface>
        }

        task={
          <div ref={pane}>
            <Surface tone="task" label="Selected requirement">
              {missing != null ? (
                <NotInList
                  id={missing.id}
                  known={missing.known}
                  noun="requirement"
                  onClear={(keep) => setParams(onlySelection('control', keep ? missing.id : null), { replace: true })}
                />
              ) : selected == null ? (
                <EmptyState
                  reason="not-yet-collected"
                  heading="Nothing selected"
                  detail="Choose a requirement to read the question, see who last answered it, and answer it yourself."
                />
              ) : (
                <QuestionPane
                  key={selected.controlId}
                  requirement={selected}
                  pillar={pillarTitle(selected.pillarId)}
                  submission={submission}
                />
              )}
            </Surface>
          </div>
        }
      />
    </CustomerPage>
  );
}

interface RequirementRowProps {
  readonly requirement: AttestableRequirement;
  readonly pillar: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

function RequirementRow({ requirement, pillar, selected, onSelect }: RequirementRowProps) {
  const state = stateOf(requirement);
  const answer = requirement.attestation;

  return (
    <button
      type="button"
      className="wa-row flex-col items-start gap-0.5 py-1.5 text-left"
      data-selected={selected}
      aria-current={selected}
      onClick={onSelect}
    >
      <span className="flex w-full items-center justify-between gap-2">
        <span className="wa-body-compact min-w-0 break-words font-medium text-wa-text sm:truncate">
          {requirement.title}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <SeverityBadge severity={requirement.severity} />
          <StateBadge state={state} />
        </span>
      </span>
      <span className="wa-caption w-full min-w-0 break-words sm:truncate">
        {pillar} · {requirement.controlId} · {ASKED_LABEL[requirement.askedBecause]}
        {answer != null && ` · ${ANSWER_LABEL[answer.answer]} by ${answer.attestedBy}`}
      </span>
    </button>
  );
}
