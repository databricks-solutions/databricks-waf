// Writing down a piece of work, or correcting one.
//
// The form asks for two things most trackers make optional, and refuses to submit without them: what
// will be true when this is done, and which requirements that covers. Both exist for the same reason
// — they are what lets a run disagree with the person who closed it. An action whose outcome is "fix
// IAM" names nothing measurable, so nothing can ever contradict it, and the board fills up with rows
// that are done because somebody said so.
//
// Once an action is past draft, three fields stop being editable: the requirements, the outcome and
// the definition of done. That is the server's rule and the form states it rather than discovering it
// — those three are what the owner agreed to, and editing them after the fact is how a missed target
// becomes a met one. Everything else stays open, because owners change and dates slip and neither is
// dishonest.

import { useState } from 'react';
import type { ActionDraft } from '../api/hooks';
import type { ActionEffort, ActionPriority, AdviceReference, ImprovementAction } from '../api/types';
import {
  EFFORTS,
  EFFORT_DETAIL,
  EFFORT_LABEL,
  PRIORITIES,
  PRIORITY_LABEL,
  dayOf,
  earliestDue,
  endOfDay,
} from '../pages/improve-language';

export interface ActionFormProps {
  /** Prefixes every field id, because two of these can be on a page at once. */
  readonly formId: string;
  /** The action being corrected, or undefined when raising a new one. */
  readonly action?: ImprovementAction;
  /** Requirements to start with, when raising from a finding. */
  readonly controlIds?: readonly string[];
  /** The run this is raised from, so the evidence behind it stays findable. */
  readonly raisedFrom?: string;
  /**
   * The advisor finding this is being raised from, when it is being raised from one.
   *
   * Its presence is what makes the requirements field optional: an advisor finding is about a
   * warehouse or a job, and the framework has no requirement that fails for either. Naming one anyway
   * is allowed and sometimes right — a job with no isolation is both — so the field stays offered.
   */
  readonly advice?: AdviceReference;
  /** The server's minimum for an outcome and a definition of done. */
  readonly minProse: number;
  /** The other actions in this plan, which are the only things this one may depend on. */
  readonly siblings: readonly ImprovementAction[];
  /** The catalogue's name for a requirement, so the reader sees more than an id. */
  readonly titleOf?: (controlId: string) => string | undefined;
  readonly onSubmit: (draft: ActionDraft) => void;
  readonly saving: boolean;
  readonly error?: string;
  readonly onCancel?: () => void;
}

export function ActionForm({
  formId,
  action,
  controlIds,
  raisedFrom,
  advice,
  minProse,
  siblings,
  titleOf,
  onSubmit,
  saving,
  error,
  onCancel,
}: ActionFormProps) {
  /*
   * The three fields that freeze after draft.
   *
   * Held in state either way rather than only when editable, so the submitted draft is a whole
   * replacement in both cases. The route takes a replacement rather than a patch — an absent `steps`
   * would otherwise mean either "unchanged" or "cleared" — so a frozen field still has to be sent
   * back exactly as it was.
   */
  const agreed = action != null && action.state !== 'draft';
  const [controls, setControls] = useState((action?.controlIds ?? controlIds ?? []).join(', '));
  const [outcome, setOutcome] = useState(action?.outcome ?? '');
  const [done, setDone] = useState(action?.definitionOfDone ?? '');

  const [owner, setOwner] = useState(action?.owner ?? '');
  const [priority, setPriority] = useState<ActionPriority>(action?.priority ?? 'next');
  const [effort, setEffort] = useState<ActionEffort>(action?.effort ?? 'medium');
  const [due, setDue] = useState(dayOf(action?.due));
  const [steps, setSteps] = useState((action?.steps ?? []).join('\n'));
  const [dependsOn, setDependsOn] = useState<readonly string[]>(action?.dependsOn ?? []);

  const named = split(controls);
  const shortOutcome = Math.max(0, minProse - outcome.trim().length);
  const shortDone = Math.max(0, minProse - done.trim().length);
  // An action raised from advice is already about something the app can find again, so the
  // requirements are not what makes it submittable. Everything else is asked for either way.
  const fromAdvice = advice != null || action?.advice != null;
  const ready = (named.length > 0 || fromAdvice) && shortOutcome === 0 && shortDone === 0 && owner.trim() !== '';

  /*
   * Everything but the action being corrected and anything already terminal.
   *
   * Depending on a cancelled action means waiting for something nobody will do, and the server
   * refuses a dependency that would close a cycle — offering one it will reject teaches the reader
   * the form cannot be trusted. Verified stays on the list: depending on finished work is ordinary,
   * and it is how a second action records that the first was its precondition.
   */
  const available = siblings.filter((other) => other.id !== action?.id && other.state !== 'cancelled');

  return (
    <form
      className="flex flex-col gap-4 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || saving) return;
        onSubmit({
          controlIds: named,
          outcome: outcome.trim(),
          definitionOfDone: done.trim(),
          owner: owner.trim(),
          priority,
          effort,
          // The end of the chosen day, because that is what a date on an action means: due on the
          // 30th is done any time on the 30th. The day's start is already past for readers west of
          // UTC, and the server would refuse a date the form had just offered.
          ...(due !== '' ? { due: endOfDay(due) } : {}),
          steps: split(steps, '\n'),
          dependsOn,
          ...(raisedFrom != null ? { raisedFrom } : action?.raisedFrom != null ? { raisedFrom: action.raisedFrom } : {}),
          // Only when raising. A revision does not resend it: the provenance is frozen on the record,
          // and the server keeps the stored one whatever a body says.
          ...(advice != null && action == null ? { advice } : {}),
        });
      }}
    >
      <div className="flex flex-col gap-1">
        <label className="wa-label" htmlFor={`${formId}-controls`}>
          Which requirements this covers{fromAdvice ? ' (optional)' : ''}
        </label>
        <input
          className="wa-field wa-body-compact"
          id={`${formId}-controls`}
          value={controls}
          onChange={(event) => setControls(event.target.value)}
          placeholder="SEC-01, SEC-04"
          disabled={agreed}
          aria-describedby={`${formId}-controls-help`}
          required={!fromAdvice}
        />
        <p className="wa-caption" id={`${formId}-controls-help`}>
          {agreed
            ? 'Fixed once the action is agreed. Raise a separate action for anything else it turns out to cover.'
            : fromAdvice
              ? 'Optional here. This action is about an advisor finding, which no requirement in the framework ' +
                'measures — name one only if the same change also answers it.'
              : 'Comma separated. These are what a run measures to agree this is done, so an action naming none can never be verified.'}
        </p>
        {named.length > 0 && titleOf != null && (
          <ul className="wa-caption list-none space-y-0.5">
            {named.map((id) => (
              <li key={id}>
                {id} — {titleOf(id) ?? 'not in the catalogue this build assesses'}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label className="wa-label" htmlFor={`${formId}-outcome`}>
          What this achieves
        </label>
        <textarea
          className="wa-textarea wa-body-compact"
          id={`${formId}-outcome`}
          rows={2}
          value={outcome}
          onChange={(event) => setOutcome(event.target.value)}
          placeholder="Every production workspace reads its secrets from the vault rather than from cluster environment variables."
          disabled={agreed}
          aria-describedby={`${formId}-outcome-help`}
          required
        />
        <p className="wa-caption" id={`${formId}-outcome-help`}>
          {agreed
            ? 'Fixed once the action is agreed. This is what somebody signed up to.'
            : shortOutcome > 0
              ? `At least ${String(shortOutcome)} more characters.`
              : 'Long enough.'}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <label className="wa-label" htmlFor={`${formId}-done`}>
          How anyone will know it is done
        </label>
        <textarea
          className="wa-textarea wa-body-compact"
          id={`${formId}-done`}
          rows={2}
          value={done}
          onChange={(event) => setDone(event.target.value)}
          placeholder="No cluster policy permits a plaintext secret, and the requirement above passes on a run."
          disabled={agreed}
          aria-describedby={`${formId}-done-help`}
          required
        />
        <p className="wa-caption" id={`${formId}-done-help`}>
          {agreed
            ? 'Fixed once the action is agreed. Changing the target after the fact is how a miss becomes a hit.'
            : shortDone > 0
              ? `At least ${String(shortDone)} more characters.`
              : 'Read by whoever checks this, who will not be you.'}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="wa-label" htmlFor={`${formId}-owner`}>
            Who is doing it
          </label>
          <input
            className="wa-field wa-body-compact"
            id={`${formId}-owner`}
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
            placeholder="Team or person, e.g. platform-engineering"
            required
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="wa-label" htmlFor={`${formId}-due`}>
            Due by
          </label>
          <input
            className="wa-field wa-body-compact"
            id={`${formId}-due`}
            type="date"
            value={due}
            min={earliestDue()}
            onChange={(event) => setDue(event.target.value)}
            aria-describedby={`${formId}-due-help`}
          />
          <p className="wa-caption" id={`${formId}-due-help`}>
            Optional while this is a draft. Needed before it can be planned.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <fieldset className="flex flex-col gap-1">
          <legend className="wa-label pb-1">Priority</legend>
          <div className="flex flex-wrap gap-1.5">
            {PRIORITIES.map((value) => (
              <label key={value} className="wa-row cursor-pointer items-center gap-1.5 py-1" data-selected={priority === value}>
                <input
                  type="radio"
                  name={`${formId}-priority`}
                  value={value}
                  checked={priority === value}
                  onChange={() => setPriority(value)}
                />
                <span className="wa-body-compact">{PRIORITY_LABEL[value]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-1">
          <legend className="wa-label pb-1">Size</legend>
          <div className="flex flex-col gap-0.5">
            {EFFORTS.map((value) => (
              <label
                key={value}
                className="wa-row cursor-pointer items-start gap-1.5 py-1"
                data-selected={effort === value}
              >
                <input
                  type="radio"
                  name={`${formId}-effort`}
                  value={value}
                  checked={effort === value}
                  onChange={() => setEffort(value)}
                  className="mt-0.5 shrink-0"
                />
                <span className="min-w-0">
                  <span className="wa-body-compact block font-medium text-wa-text">{EFFORT_LABEL[value]}</span>
                  <span className="wa-caption block">{EFFORT_DETAIL[value]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="flex flex-col gap-1">
        <label className="wa-label" htmlFor={`${formId}-steps`}>
          Steps
        </label>
        <textarea
          className="wa-textarea wa-body-compact"
          id={`${formId}-steps`}
          rows={3}
          value={steps}
          onChange={(event) => setSteps(event.target.value)}
          placeholder={'One per line.\nDraft the policy change.\nRoll it out to staging.'}
          aria-describedby={`${formId}-steps-help`}
        />
        <p className="wa-caption" id={`${formId}-steps-help`}>
          Optional, one per line. Nothing checks them off — they are notes for whoever picks this up, not progress.
        </p>
      </div>

      {available.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="wa-label pb-1">Waits for</legend>
          <div className="flex flex-col gap-0.5">
            {available.map((other) => (
              <label key={other.id} className="wa-row cursor-pointer items-start gap-1.5 py-1">
                <input
                  type="checkbox"
                  checked={dependsOn.includes(other.id)}
                  onChange={(event) =>
                    setDependsOn((was) =>
                      event.target.checked ? [...was, other.id] : was.filter((id) => id !== other.id)
                    )
                  }
                  className="mt-0.5 shrink-0"
                />
                <span className="wa-body-compact min-w-0">{other.outcome}</span>
              </label>
            ))}
          </div>
          <p className="wa-caption">
            Only actions in this plan. A dependency across plans would make one plan&rsquo;s progress depend on
            somebody else&rsquo;s, invisibly.
          </p>
        </fieldset>
      )}

      {error != null && (
        <p className="wa-body-compact text-wa-danger" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <p className="wa-caption">Does not change the score.</p>
        <div className="flex items-center gap-2">
          {onCancel != null && (
            <button type="button" className="wa-button-secondary" onClick={onCancel} disabled={saving}>
              Cancel
            </button>
          )}
          <button type="submit" className="wa-button-primary" disabled={!ready || saving}>
            {saving ? 'Saving…' : action != null ? 'Save changes' : 'Raise it'}
          </button>
        </div>
      </div>
    </form>
  );
}

/** Split on a separator, trimmed, with the blanks dropped rather than sent as empty entries. */
function split(value: string, separator: string | RegExp = ','): readonly string[] {
  return value
    .split(separator)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}
