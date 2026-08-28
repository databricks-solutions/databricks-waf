// One plan: its actions, in the order somebody working through it would take them.
//
// Blocked first, then waiting on a run, then in progress. That is not the lifecycle's order and it is
// deliberately not: a blocker is the only row on the board whose next move belongs to somebody other
// than the owner, so it is the only row where being at the top changes what happens.
//
// Contradicted actions are called out above the list rather than left to be found in it. Somebody
// marked those done and a run since has measured the requirement as still unmet — which is the single
// reading this whole surface exists to make impossible to miss, and it is also the reading a board
// sorted by state would bury under a green badge.

import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useAssessment } from '../api/assessment-context';
import { useClosePlan, useImprovementPlan } from '../api/hooks';
import { ActionForm } from '../components/ActionForm';
import { ActionPanel } from '../components/ActionPanel';
import { useRaiseAction } from '../api/hooks';
import { PlanFiles } from '../components/PlanFiles';
import { CustomerPage, RecordButton, RecordList, StateNotice, Surface, TaskWorkspace } from '../components/system';
import { EmptyState } from '../components/ui/EmptyState';
import { useRevealedPane } from '../components/ui/reveal';
import { Badge } from '../components/ui/StatusBadge';
import type { AdviceReference, ImprovementAction } from '../api/types';
import { adviceIn, advicePhrase } from './advice-link';
import { foundationIn, foundationPhrase, type FoundationHandoff } from './foundation-link';
import { requirementIn, type RequirementHandoff } from './requirement-link';
import {
  AGREEMENT_ICON,
  AGREEMENT_LABEL,
  AGREEMENT_TONE,
  LATENESS_LABEL,
  LATENESS_TONE,
  PRIORITY_LABEL,
  STATE_ICON,
  STATE_LABEL,
  STATE_RANK,
  STATE_TONE,
  standingPhrase,
} from './improve-language';

const EMPTY: readonly ImprovementAction[] = [];

export function PlanPage() {
  const { planId } = useParams();
  const { controlOf } = useAssessment();
  const [params, setParams] = useSearchParams();
  const detail = useImprovementPlan(planId);
  /*
   * The advisor finding a reader arrived with, from the link on the finding by way of the plan list.
   *
   * The form opens on arrival when there is one, rather than waiting for a second click on a button
   * the reader has in effect already pressed — they chose this plan for this finding, and the page
   * says which finding above the form.
   */
  const advice = adviceIn(params);
  const foundation = foundationIn(params);
  const askedRequirement = requirementIn(params);
  const requirement =
    askedRequirement != null && controlOf(askedRequirement.controlId) != null ? askedRequirement : undefined;
  const [raising, setRaising] = useState(advice != null || foundation != null || requirement != null);
  const [closing, setClosing] = useState(false);
  // Revealed rather than always shown, and that is a server decision as much as a layout one: listing
  // the files seals six of them to publish their digests, and a page that did it on every visit would
  // pay for a document nobody is sending.
  const [sending, setSending] = useState(false);

  const selectedId = params.get('action');
  const select = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id == null) next.delete('action');
    else next.set('action', id);
    // The reference goes with the form it opened. Left in the URL it would reopen the form on the
    // next visit through the browser's history, offering to raise a second action from a finding
    // somebody has already dealt with.
    for (const key of ['advisory', 'advisor', 'resource', 'rule']) next.delete(key);
    next.delete('foundation');
    next.delete('control');
    setParams(next, { replace: true });
  };

  const actions = useMemo(() => {
    return [...(detail.data?.actions ?? EMPTY)].sort(
      (a, b) =>
        // Contradicted above everything within a state, because a claim the estate disputes is the
        // most likely thing on the board to be news to whoever is reading it.
        Number(b.agreement === 'contradicted') - Number(a.agreement === 'contradicted') ||
        STATE_RANK[a.state] - STATE_RANK[b.state] ||
        Number(b.lateness === 'overdue') - Number(a.lateness === 'overdue') ||
        (a.due ?? '9999').localeCompare(b.due ?? '9999') ||
        a.createdAt.localeCompare(b.createdAt)
    );
  }, [detail.data?.actions]);

  const plan = detail.data?.plan;
  // Arrival without an explicit deep link means "start with the highest-ranked work", not "reserve
  // a third of the screen for an empty inspector". An explicit but unknown id still shows the honest
  // not-selected state rather than silently substituting another action.
  const selected = actions.find((action) => action.id === selectedId) ?? (selectedId == null ? actions[0] : undefined);
  const pane = useRevealedPane(selected?.id ?? selectedId);
  const titleOf = (controlId: string) => controlOf(controlId)?.title;

  if (detail.error != null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Improvement plan unavailable">
          <EmptyState
            layout="compact"
            reason="collector-failed"
            heading="This plan could not be read"
            detail={detail.error}
            action={
              <Link to="/improvements" className="wa-button-secondary">
                Back to the plans
              </Link>
            }
          />
        </Surface>
      </CustomerPage>
    );
  }

  if (plan == null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Improvement plan loading">
          <EmptyState
            layout="compact"
            reason="not-yet-collected"
            heading={detail.loading ? 'Reading the plan' : 'No such plan'}
            detail={detail.loading ? 'Fetching the plan and every action in it.' : 'Nothing is held under that id.'}
          />
        </Surface>
      </CustomerPage>
    );
  }

  const frozen = plan.closed != null;

  return (
    <CustomerPage>
      {detail.data != null && !detail.data.durable && (
        <StateNotice
          tone="warning"
          announce="alert"
          title="This plan is not durable"
          detail={
            <p>
              This plan is held in memory and will be lost when the app restarts.{' '}
              {detail.data.durabilityNote ?? 'Unset WAF_DEMO_NO_PERSISTENCE and restart to keep it.'}
            </p>
          }
        />
      )}

      <TaskWorkspace
        queueLabel="Improvement plan actions"
        taskLabel="Selected improvement action"
        queue={
          <Surface
            tone="section"
            title="Plan actions"
            description={`${String(actions.length)} ${actions.length === 1 ? 'action' : 'actions'} · ${frozen ? 'closed' : 'open'}`}
          >
            <div className="mb-3 space-y-2">
              <h3 className="wa-type-title">{plan.title}</h3>
              <p className="wa-body-compact text-wa-text-secondary">{plan.outcome}</p>
              <p className="wa-caption">
                {plan.owners.join(', ')} · opened by {plan.createdBy}
                {plan.raisedFrom != null && (
                  <>
                    {' · '}
                    <Link className="text-wa-action hover:underline" to={`/history/${plan.raisedFrom}`}>
                      from the run it was raised against
                    </Link>
                  </>
                )}
              </p>
              <p className="wa-caption">{standingPhrase(plan.progress)}</p>
              {plan.closed != null && (
                <blockquote className="wa-body-compact border-l-2 border-wa-divider pl-2 text-wa-text-secondary">
                  Closed by {plan.closed.by}: {plan.closed.reason}
                </blockquote>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                {frozen && <span className="wa-caption">Closed</span>}
                {!frozen && (
                  <>
                    <button
                      type="button"
                      className="wa-customer-primary-action"
                      onClick={() => setRaising((was) => !was)}
                    >
                      {raising ? 'Cancel' : 'Raise an action'}
                    </button>
                    <button
                      type="button"
                      className="wa-customer-secondary-action"
                      onClick={() => setClosing((was) => !was)}
                    >
                      Close the plan
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="wa-customer-secondary-action"
                  aria-expanded={sending}
                  onClick={() => setSending((was) => !was)}
                >
                  {sending ? 'Hide the files' : 'Send this plan'}
                </button>
              </div>
            </div>

            {sending && <PlanFiles planId={plan.id} />}

            {closing && !frozen && (
              <ClosePlanForm
                planId={plan.id}
                outstanding={
                  actions.filter((action) => action.state !== 'verified' && action.state !== 'cancelled').length
                }
                onSaved={() => {
                  setClosing(false);
                  detail.reload();
                }}
                onCancel={() => setClosing(false)}
              />
            )}

            {raising && !frozen && (
              <div className="border-b border-wa-divider">
                <RaiseForm
                  planId={plan.id}
                  minProse={detail.data?.minProse ?? 20}
                  siblings={actions}
                  titleOf={titleOf}
                  {...(advice != null ? { advice } : {})}
                  {...(foundation != null ? { foundation } : {})}
                  {...(requirement != null ? { requirement } : {})}
                  onSaved={(id) => {
                    setRaising(false);
                    select(id ?? null);
                    detail.reload();
                  }}
                  onCancel={() => {
                    setRaising(false);
                    select(selectedId);
                  }}
                />
              </div>
            )}

            {actions.length === 0 ? (
              <EmptyState
                layout="compact"
                reason="not-yet-collected"
                heading="Nothing raised yet"
                detail={
                  'An action names the requirements it covers and what will be true when it is done, which is what lets a ' +
                  'later run agree or disagree with whoever closes it.'
                }
                {...(frozen
                  ? {}
                  : {
                      action: (
                        <Link to="/findings?outcome=unmet" className="wa-button-secondary">
                          Go to the findings
                        </Link>
                      ),
                    })}
              />
            ) : (
              <RecordList label="Actions in this improvement plan">
                {actions.map((action) => (
                  <RecordButton
                    key={action.id}
                    selected={action.id === selected?.id}
                    onSelect={() => select(action.id)}
                    eyebrow={
                      <span className="flex flex-wrap items-center gap-1.5">
                        {action.agreement === 'contradicted' && (
                          <Badge tone={AGREEMENT_TONE.contradicted} Icon={AGREEMENT_ICON.contradicted}>
                            {AGREEMENT_LABEL.contradicted}
                          </Badge>
                        )}
                        {action.lateness === 'overdue' && (
                          <Badge tone={LATENESS_TONE.overdue} Icon={STATE_ICON.planned}>
                            {LATENESS_LABEL.overdue}
                          </Badge>
                        )}
                        <Badge tone={STATE_TONE[action.state]} Icon={STATE_ICON[action.state]}>
                          {STATE_LABEL[action.state]}
                        </Badge>
                      </span>
                    }
                    title={action.outcome}
                    meta={[
                      action.owner,
                      PRIORITY_LABEL[action.priority],
                      action.controlIds.length > 0 ? action.controlIds.join(', ') : action.advice?.rule,
                    ]
                      .filter((part) => part != null && part !== '')
                      .join(' · ')}
                    aside={action.id === selected?.id ? 'Selected' : 'Open'}
                  />
                ))}
              </RecordList>
            )}
          </Surface>
        }

        task={
          <div ref={pane}>
            {selected == null ? (
              <Surface tone="task" title="Select an action">
                <EmptyState
                  layout="compact"
                  reason="not-yet-collected"
                  heading="Nothing selected"
                  detail="Choose an action to read what it covers, where it stands, and what the latest run makes of it."
                />
              </Surface>
            ) : (
              <ActionPanel
                key={selected.id}
                action={selected}
                siblings={actions}
                minProse={detail.data?.minProse ?? 20}
                frozen={frozen}
                titleOf={titleOf}
                onChanged={detail.reload}
              />
            )}
          </div>
        }
      />
    </CustomerPage>
  );
}

function RaiseForm({
  planId,
  minProse,
  siblings,
  titleOf,
  advice,
  foundation,
  requirement,
  onSaved,
  onCancel,
}: {
  readonly planId: string;
  readonly minProse: number;
  readonly siblings: readonly ImprovementAction[];
  readonly titleOf: (controlId: string) => string | undefined;
  readonly advice?: AdviceReference;
  readonly foundation?: FoundationHandoff;
  readonly requirement?: RequirementHandoff;
  readonly onSaved: (id: string | undefined) => void;
  readonly onCancel: () => void;
}) {
  const { scan } = useAssessment();
  // No `onSaved` on the hook: the new action's id is the return value, and the page wants to select
  // the row it has just created. Routing that through the hook's callback would read a state variable
  // set in the same tick and select nothing.
  const raise = useRaiseAction(planId);

  return (
    <>
      {advice != null && (
        <p className="wa-caption px-3 pt-3">
          Raising this against {advicePhrase(advice)}. What the finding says is read from the advisory when this is
          saved, and kept on the action as it was on the day.
        </p>
      )}
      {foundation != null && (
        <p className="wa-caption px-3 pt-3">
          Creating an improvement plan for {foundationPhrase(foundation)}. The related framework requirements are
          selected below so the existing action lifecycle can check the change; this does not turn the foundation
          reading into a score.
        </p>
      )}
      {requirement != null && (
        <p className="wa-caption px-3 pt-3">
          Creating an improvement plan for {requirement.controlId} — {titleOf(requirement.controlId)}. The requirement
          is selected below so a later assessment can verify the action against the same gap.
        </p>
      )}
      <ActionForm
        formId={`raise-${planId}`}
        minProse={minProse}
        siblings={siblings}
        titleOf={titleOf}
        {...(advice != null ? { advice } : {})}
        {...(foundation != null ? { controlIds: foundation.controlIds } : {})}
        {...(requirement != null ? { controlIds: [requirement.controlId] } : {})}
        {...(scan?.id != null ? { raisedFrom: scan.id } : {})}
        onSubmit={(draft) => {
          void raise.send(draft).then((id) => {
            if (id != null) onSaved(id);
          });
        }}
        saving={raise.saving}
        {...(raise.error != null ? { error: raise.error } : {})}
        onCancel={onCancel}
      />
    </>
  );
}

/**
 * Closing a plan.
 *
 * The count of what is still open is stated before the reason field rather than after the button,
 * because closing a plan with six actions in progress is a legitimate thing to do — priorities change
 * — and an illegitimate thing to do by accident. The server keeps the actions as they were either
 * way; closing is not a bulk cancel, and the copy says so.
 */
function ClosePlanForm({
  planId,
  outstanding,
  onSaved,
  onCancel,
}: {
  readonly planId: string;
  readonly outstanding: number;
  readonly onSaved: () => void;
  readonly onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const close = useClosePlan(planId, onSaved);
  const short = reason.trim().length < 20;
  // The server's rule, not a stricter one this form invented: a closed plan with live actions under it
  // reads as finished work in every rollup that counts plans, so `plan.closed` refuses while any action
  // is neither verified nor cancelled. Stated here and enforced on the button, because the alternative
  // is a reader writing a paragraph and being told afterwards.
  const blocked = outstanding > 0;

  return (
    <form
      className="space-y-1.5 border-b border-wa-divider p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (short || blocked || close.saving) return;
        void close.send({ reason: reason.trim() });
      }}
    >
      <label className="wa-label" htmlFor={`close-${planId}`}>
        Why this plan is closing
      </label>
      <textarea
        className="wa-textarea wa-body-compact"
        id={`close-${planId}`}
        rows={2}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        aria-describedby={`close-help-${planId}`}
        disabled={blocked}
        required
      />
      <p className="wa-caption" id={`close-help-${planId}`}>
        {blocked
          ? `${String(outstanding)} action${outstanding === 1 ? '' : 's'} in this plan ${outstanding === 1 ? 'is' : 'are'} still live. Verify or cancel each of them first — a closed plan with live actions under it reads as finished work in every rollup that counts plans.`
          : `Nothing in this plan is still live. Nothing in it can be changed after this. ${short ? `At least ${String(20 - reason.trim().length)} more characters.` : 'Long enough.'}`}
      </p>
      {close.error != null && (
        <p className="wa-body-compact text-wa-danger" role="alert">
          {close.error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button type="submit" className="wa-button-primary" disabled={short || blocked || close.saving}>
          {close.saving ? 'Closing…' : 'Close the plan'}
        </button>
        <button type="button" className="wa-button-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
