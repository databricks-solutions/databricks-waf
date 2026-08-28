// One action: what it is for, where it stands, and the moves a person may make.
//
// Two readings sit side by side at the top and are never merged. The state is what the owner says; the
// agreement is what the last run says. A row that reads "Waiting on a run" beside "Still failing" is
// the pane doing its job — somebody marked the work done, the estate disagrees, and the only honest
// presentation of that is both sentences at once.
//
// The moves come from the server rather than from a table in here, because a second copy of the
// lifecycle in the browser eventually offers a move the server refuses and the reader learns the real
// rule one rejection at a time. `verified` is never among them: no person may make that move, and a
// button for it would be the app inviting somebody to close a row the estate has not agreed with.

import { useState } from 'react';
import { Link } from 'react-router';
import { useMoveAction, useReviseAction } from '../api/hooks';
import type { ActionState, ImprovementAction } from '../api/types';
import { ActionForm } from './ActionForm';
import { AdviceNote } from './AdviceNote';
import { ValidationTrail } from './ValidationTrail';
import { ActionPanel as CustomerActionPanel, Surface } from './system';
import { Badge } from './ui/StatusBadge';
import {
  AGREEMENT_ICON,
  AGREEMENT_TONE,
  CLAIMED_WITHOUT_REQUIREMENTS,
  EFFORT_LABEL,
  LATENESS_LABEL,
  LATENESS_TONE,
  MOVE_LABEL,
  PRIORITY_LABEL,
  STATE_DETAIL,
  STATE_ICON,
  STATE_LABEL,
  STATE_TONE,
  agreementDetail,
  agreementLabel,
  duePhrase,
  reasonPrompt,
  transitionPhrase,
} from '../pages/improve-language';
import { CalendarClock } from 'lucide-react';

export interface ActionPanelProps {
  readonly action: ImprovementAction;
  /** The plan's other actions, for the dependency list and for naming what this waits on. */
  readonly siblings: readonly ImprovementAction[];
  readonly minProse: number;
  /** True while the plan is closed, which is when nothing in it may be changed. */
  readonly frozen: boolean;
  readonly titleOf?: (controlId: string) => string | undefined;
  /** False only for a deterministic local preview that has no backing validation record. */
  readonly showValidation?: boolean;
  /** Re-reads the plan. A move changes the rollup and which moves come next, so the page refetches. */
  readonly onChanged: () => void;
}

export function ActionPanel({
  action,
  siblings,
  minProse,
  frozen,
  titleOf,
  showValidation = true,
  onChanged,
}: ActionPanelProps) {
  const [editing, setEditing] = useState(false);
  const revise = useReviseAction(action.planId, action.id, () => {
    setEditing(false);
    onChanged();
  });

  const movesId = `action-moves-${action.id}`;
  const firstRequirement = action.controlIds[0];

  return (
    <>
      <CustomerActionPanel
        eyebrow="Improvement action"
        title={action.outcome}
        why={
          <p className="wa-body-compact text-wa-text-secondary">
            {firstRequirement != null
              ? `This action closes ${firstRequirement} — ${action.titles[firstRequirement] ?? titleOf?.(firstRequirement) ?? 'the linked requirement'}.`
              : 'This action records improvement work that is not tied to a scored requirement.'}
          </p>
        }
        action={
          !frozen && action.moves.length > 0 ? (
            <a className="wa-button-primary" href={`#${movesId}`}>
              Update status
            </a>
          ) : firstRequirement != null ? (
            <Link
              className="wa-button-secondary"
              to={`/investigate?control=${encodeURIComponent(firstRequirement)}`}
            >
              Review requirement
            </Link>
          ) : null
        }
        destination={
          firstRequirement != null ? (
            <Link to={`/investigate?control=${encodeURIComponent(firstRequirement)}`}>
              {action.titles[firstRequirement] ?? titleOf?.(firstRequirement) ?? firstRequirement}
            </Link>
          ) : (
            'This improvement plan'
          )
        }
        owner={action.owner}
        verification={action.definitionOfDone}
      />

      <div className="space-y-3">
        <Surface
          tone="accent"
          title="Current standing"
          description={`${PRIORITY_LABEL[action.priority]} · ${EFFORT_LABEL[action.effort]} · ${action.owner}`}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={STATE_TONE[action.state]} Icon={STATE_ICON[action.state]}>
              {STATE_LABEL[action.state]}
            </Badge>
            <Badge tone={AGREEMENT_TONE[action.agreement]} Icon={AGREEMENT_ICON[action.agreement]}>
              {agreementLabel(action)}
            </Badge>
            {/* Only when it says something. An "On time" badge on every row is furniture, and a
                dateless draft has nothing to be on time for. */}
            {action.lateness !== 'on-time' && action.lateness !== 'undated' && (
              <Badge tone={LATENESS_TONE[action.lateness]} Icon={CalendarClock}>
                {LATENESS_LABEL[action.lateness]}
              </Badge>
            )}
          </div>
          {/* The general sentence for this state promises a run that measures every requirement this
              names, which an action raised from advice does not have. See `CLAIMED_WITHOUT_REQUIREMENTS`. */}
          <p className="wa-body-compact mt-2 text-wa-text-secondary">
            {action.state === 'ready-for-validation' && action.controlIds.length === 0
              ? CLAIMED_WITHOUT_REQUIREMENTS
              : STATE_DETAIL[action.state]}
          </p>
        </Surface>

        <Surface tone="raised" title="What the estate says" headingLevel={3}>
          <p className="wa-body-compact text-wa-text-secondary">{agreementDetail(action)}</p>
          {action.unmet.length > 0 && (
            <p className="wa-caption">
              Still unmet:{' '}
              {action.unmet.map((id, at) => (
                <span key={id}>
                  {at > 0 && ', '}
                  <Link className="text-wa-action hover:underline" to={`/findings?control=${id}`}>
                    {id}
                  </Link>
                </span>
              ))}
            </p>
          )}
          {action.unreadable.length > 0 && (
            <p className="wa-caption">
              The last run could not read {action.unreadable.join(', ')}, which is not the same as failing.
            </p>
          )}
        </Surface>

        <Surface tone="raised" title="Done when" headingLevel={3}>
          <p className="wa-body-compact text-wa-text">{action.definitionOfDone}</p>
          <p className="wa-caption mt-1">{duePhrase(action)}</p>
        </Surface>

        {action.advice != null && (
          <AdviceNote
            advice={action.advice}
            {...(action.adviceReading != null ? { reading: action.adviceReading } : {})}
          />
        )}

        {/* Absent on an action raised from advice, which names none. An empty list under a heading
          reads as a requirement the page failed to load. */}
        {action.controlIds.length > 0 && (
          <Surface tone="raised" title="Requirements it covers" headingLevel={3}>
            <ul className="wa-body-compact list-none space-y-0.5">
              {action.controlIds.map((id) => (
                <li key={id}>
                  <Link className="text-wa-action hover:underline" to={`/findings?control=${id}`}>
                    {id}
                  </Link>
                  {' — '}
                  {action.titles[id] ?? titleOf?.(id) ?? 'not in the catalogue this build assesses'}
                </li>
              ))}
            </ul>
          </Surface>
        )}

        {action.steps.length > 0 && (
          <Surface tone="raised" title="Steps" description="Notes, not progress" headingLevel={3}>
            <ol className="wa-body-compact list-decimal space-y-0.5 pl-4">
              {action.steps.map((step, at) => (
                <li key={`${String(at)}-${step}`}>{step}</li>
              ))}
            </ol>
          </Surface>
        )}

        {action.dependsOn.length > 0 && (
          <Surface tone="raised" title="Waits for" headingLevel={3}>
            <ul className="wa-body-compact list-none space-y-0.5">
              {action.dependsOn.map((id) => {
                const other = siblings.find((sibling) => sibling.id === id);
                return (
                  <li key={id}>
                    {other?.outcome ?? id}
                    {other != null && <span className="wa-caption"> · {STATE_LABEL[other.state]}</span>}
                  </li>
                );
              })}
            </ul>
          </Surface>
        )}

        {/* Under what the estate says and above the moves, which is where it sits in the argument: the
          agreement is the last run's reading of the requirement, and this is what was asked about this
          claim. Renders nothing on an action nobody has offered for validation yet. */}
        {showValidation && (
          <ValidationTrail planId={action.planId} actionId={action.id} frozen={frozen} onChanged={onChanged} />
        )}

        {action.raisedFrom != null && (
          <Surface tone="inset" title="Raised from" headingLevel={3}>
            <Link className="wa-body-compact text-wa-action hover:underline" to={`/history/${action.raisedFrom}`}>
              The run this came out of
            </Link>
          </Surface>
        )}

        {!frozen && (
          <Surface tone="raised" title="Move it" headingLevel={3}>
            <div id={movesId}>
              {editing ? (
                <ActionForm
                  formId={`revise-${action.id}`}
                  action={action}
                  minProse={minProse}
                  siblings={siblings}
                  titleOf={titleOf}
                  onSubmit={(draft) => void revise.send(draft)}
                  saving={revise.saving}
                  {...(revise.error != null ? { error: revise.error } : {})}
                  onCancel={() => setEditing(false)}
                />
              ) : (
                <Moves action={action} onChanged={onChanged} onEdit={() => setEditing(true)} />
              )}
            </div>
          </Surface>
        )}

        {frozen && (
          <Surface tone="inset" label="Closed plan notice">
            <p className="wa-caption">
              This plan is closed, so nothing in it can be moved or corrected. Reopening is not something the app does —
              open a new plan and raise what is left.
            </p>
          </Surface>
        )}

        <Surface
          tone="inset"
          title="History"
          description={`${String(action.history.length)} recorded`}
          headingLevel={3}
        >
          {action.history.length === 0 ? (
            <p className="wa-caption">
              Nothing has moved yet. Raised{' '}
              {transitionPhrase({ by: 'person', who: action.createdBy, at: action.createdAt })}.
            </p>
          ) : (
            <ol className="space-y-1.5">
              {[...action.history].reverse().map((entry, at) => (
                <li key={`${entry.at}-${String(at)}`}>
                  <p className="wa-body-compact text-wa-text">
                    {STATE_LABEL[entry.from]} → {STATE_LABEL[entry.to]}
                  </p>
                  <p className="wa-caption">{transitionPhrase(entry)}</p>
                  {entry.reason != null && (
                    <blockquote className="wa-body-compact border-l-2 border-wa-divider pl-2 text-wa-text-secondary">
                      {entry.reason}
                    </blockquote>
                  )}
                </li>
              ))}
            </ol>
          )}
        </Surface>
      </div>
    </>
  );
}

/**
 * The moves, and the sentence two of them insist on.
 *
 * Blocking and cancelling ask for a reason before the request is sent, because the server refuses
 * them without one and a rejection after the fact costs the reader the whole form. The prompt is
 * different for each: a blocker nobody named is a blocker nobody can clear.
 */
function Moves({
  action,
  onChanged,
  onEdit,
}: {
  readonly action: ImprovementAction;
  readonly onChanged: () => void;
  readonly onEdit: () => void;
}) {
  const [asking, setAsking] = useState<ActionState | undefined>(undefined);
  const [reason, setReason] = useState('');
  const move = useMoveAction(action.planId, action.id, () => {
    setAsking(undefined);
    setReason('');
    onChanged();
  });

  const request = (to: ActionState) => {
    if (reasonPrompt(to) != null) {
      setAsking(to);
      setReason('');
      return;
    }
    // Cleared before sending, not only on success. With the block form open, pressing "Start it" sent
    // the move and left the block prompt mounted underneath it — a form asking why this is blocked,
    // about a transition that had already gone the other way.
    setAsking(undefined);
    setReason('');
    void move.send({ to });
  };

  const prompt = asking == null ? undefined : reasonPrompt(asking);
  // The server's own minimum for a reason. Ten rather than the twenty an outcome needs: "waiting on
  // the network team" is a complete answer to what a blocker is, and demanding a paragraph for it
  // collects a paragraph of nothing.
  const short = reason.trim().length < 10;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {action.moves.map((to) => (
          <button
            key={to}
            type="button"
            className={to === 'cancelled' ? 'wa-button-secondary' : 'wa-button-primary'}
            onClick={() => request(to)}
            disabled={move.saving}
          >
            {MOVE_LABEL[to]}
          </button>
        ))}
        <button type="button" className="wa-button-secondary" onClick={onEdit} disabled={move.saving}>
          Correct it
        </button>
      </div>

      {action.moves.length === 0 && (
        <p className="wa-caption">
          Nothing to move. {action.state === 'verified' ? 'A run agreed with this.' : 'This was cancelled.'}
        </p>
      )}

      {asking != null && prompt != null && (
        <form
          className="space-y-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (short || move.saving) return;
            void move.send({ to: asking, reason: reason.trim() });
          }}
        >
          <label className="wa-label" htmlFor={`reason-${action.id}`}>
            {MOVE_LABEL[asking]}
          </label>
          <textarea
            className="wa-textarea wa-body-compact"
            id={`reason-${action.id}`}
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            aria-describedby={`reason-help-${action.id}`}
            required
          />
          <p className="wa-caption" id={`reason-help-${action.id}`}>
            {prompt}
          </p>
          <div className="flex items-center gap-2">
            <button type="submit" className="wa-button-primary" disabled={short || move.saving}>
              {move.saving ? 'Recording…' : MOVE_LABEL[asking]}
            </button>
            <button
              type="button"
              className="wa-button-secondary"
              onClick={() => {
                setAsking(undefined);
                setReason('');
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {move.error != null && (
        <p className="wa-body-compact text-wa-danger" role="alert">
          {move.error}
        </p>
      )}

      <p className="wa-caption">
        <span className="font-medium text-wa-text">Nothing here changes the score. </span>
        Moving an action records what somebody is doing about a requirement. Whether the requirement is met is decided
        by a run, and only by a run.
      </p>
    </div>
  );
}
