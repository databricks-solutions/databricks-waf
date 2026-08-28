// Answering one requirement.
//
// The form asks for more than the answer, and the extra fields are the point of the feature rather
// than friction added to it. An attestation with no statement, no named owner and no review date is
// a checkbox: it moves the score, nobody can tell what it was based on, and in a year nobody knows
// whether it is still true. So the statement is required and the owner is required, and both are
// recorded against the person who pressed the button — which the server takes from the request
// token rather than from this form, because a field for "who is answering" is a field that can be
// filled in with somebody else's name.
//
// The answer defaults to nothing selected. A form that arrives with "In place" preselected is a
// form that collects agreement rather than an answer.

import { useState } from 'react';
import type { AttestableRequirement, AttestedAnswer } from '../api/types';
import type { AnswerDraft } from '../api/hooks';
import { ANSWER_EFFECT, ANSWER_LABEL, ANSWERS, cadencePhrase } from '../pages/attest-language';

/** The server's own minimum, repeated here so the reader is told before they submit, not after. */
const MIN_STATEMENT = 20;

export function answerBlockingReasons(
  answer: AttestedAnswer | undefined,
  statement: string,
  owner: string
): readonly string[] {
  const reasons: string[] = [];
  if (answer == null) reasons.push('choose an answer');
  const remaining = Math.max(0, MIN_STATEMENT - statement.trim().length);
  if (remaining > 0) reasons.push(`write ${String(remaining)} more characters in “What this is based on”`);
  if (owner.trim() === '') reasons.push('name who is accountable');
  return reasons;
}

function listPhrase(items: readonly string[]): string {
  if (items.length < 2) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

export interface AnswerFormProps {
  readonly requirement: AttestableRequirement;
  readonly onSubmit: (draft: AnswerDraft) => void;
  readonly saving: boolean;
  /** The server's rejection, shown against the form rather than as a toast that scrolls away. */
  readonly error?: string;
  /** True once this requirement's answer is recorded, so the form can confirm rather than reset. */
  readonly saved: boolean;
}

/**
 * The identity of what is being answered, for the caller's `key`.
 *
 * The form's fields are initialised from the previous answer and then owned by the typist, so they
 * have to be discarded when the subject changes — a different requirement, or the same one after a
 * new answer was recorded. Expressed as a key rather than as an effect that writes four setStates:
 * remounting is how React resets derived state, and the effect version renders the stale values
 * once before correcting them.
 */
export function answerFormKey(requirement: AttestableRequirement): string {
  return `${requirement.controlId}:${requirement.attestation?.id ?? 'unanswered'}`;
}

export function AnswerForm({ requirement, onSubmit, saving, error, saved }: AnswerFormProps) {
  const previous = requirement.attestation;
  /*
   * Confirming an existing answer starts from that answer; a new one starts from nothing selected.
   *
   * Re-confirmation is the common case after the first cycle, and retyping a statement somebody
   * already wrote is how re-attestation turns into a rubber stamp: the shortest path has to be
   * reviewing the previous words, not replacing them with "as before". A form arriving with an
   * answer preselected where there was none would be collecting agreement instead.
   */
  const [answer, setAnswer] = useState<AttestedAnswer | undefined>(previous?.answer);
  const [statement, setStatement] = useState(previous?.statement ?? '');
  const [owner, setOwner] = useState(previous?.owner ?? '');
  const [evidenceUrl, setEvidenceUrl] = useState(previous?.evidenceUrl ?? '');

  const short = statement.trim().length < MIN_STATEMENT;
  const blockingReasons = answerBlockingReasons(answer, statement, owner);
  const ready = blockingReasons.length === 0;
  const actionLabel = previous != null ? 'Confirm answer' : 'Record answer';
  const submitHelpId = `submit-help-${requirement.controlId}`;

  return (
    <form
      className="flex flex-col gap-4 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || saving || answer == null) return;
        onSubmit({
          controlId: requirement.controlId,
          answer,
          statement: statement.trim(),
          owner: owner.trim(),
          ...(evidenceUrl.trim() !== '' ? { evidenceUrl: evidenceUrl.trim() } : {}),
        });
      }}
    >
      <fieldset className="flex flex-col gap-1.5">
        <legend className="wa-label pb-1.5">Your answer</legend>
        {ANSWERS.map((value) => (
          <label
            key={value}
            className="wa-row cursor-pointer items-start gap-2 py-1.5"
            data-selected={answer === value}
          >
            <input
              type="radio"
              name={`answer-${requirement.controlId}`}
              value={value}
              checked={answer === value}
              onChange={() => setAnswer(value)}
              className="mt-0.5 shrink-0"
            />
            <span className="min-w-0">
              <span className="wa-body-compact block font-medium text-wa-text">{ANSWER_LABEL[value]}</span>
              <span className="wa-caption block">{ANSWER_EFFECT[value]}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="flex flex-col gap-1">
        <label className="wa-label" htmlFor={`statement-${requirement.controlId}`}>
          What this is based on
        </label>
        {/* Plain elements with the design system's own field classes rather than the AppKit inputs.
            Those are Radix-backed and pull the whole component barrel — charts included — for a
            textarea and two text boxes, which costs the bundle and puts a form nobody can render in
            a test behind a chart library's module resolution. */}
        <textarea
          className="wa-textarea wa-body-compact"
          id={`statement-${requirement.controlId}`}
          rows={4}
          value={statement}
          onChange={(event) => setStatement(event.target.value)}
          // Short, because what the answer should rest on is stated above the question where it
          // survives the first keystroke. Repeating it here would be a hint that disappears
          // exactly when it is being followed.
          placeholder="Name the process, document or system this rests on."
          aria-describedby={`statement-help-${requirement.controlId}`}
          required
        />
        <p className="wa-caption" id={`statement-help-${requirement.controlId}`}>
          {/* The count is live because the minimum is a server rule: a reader who writes eight
              words and is rejected on submit has been made to guess at a threshold. */}
          Recorded with the answer and shown wherever this requirement appears.{' '}
          {short ? `At least ${String(MIN_STATEMENT - statement.trim().length)} more characters.` : 'Long enough.'}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <label className="wa-label" htmlFor={`owner-${requirement.controlId}`}>
          Who is accountable
        </label>
        <input
          className="wa-field wa-body-compact"
          id={`owner-${requirement.controlId}`}
          value={owner}
          onChange={(event) => setOwner(event.target.value)}
          placeholder="Team or person, e.g. platform-engineering"
          aria-describedby={`owner-help-${requirement.controlId}`}
          required
        />
        <p className="wa-caption" id={`owner-help-${requirement.controlId}`}>
          {/* Separate from the attester on purpose: the person with the console open is often not
              the person who owns the practice, and conflating them is how a review lands with
              somebody who cannot act on it. */}
          The team that owns the practice, which need not be you. Yours is recorded as the answer&rsquo;s author.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <label className="wa-label" htmlFor={`evidence-${requirement.controlId}`}>
          Link to evidence <span className="font-normal text-wa-text-muted">(optional)</span>
        </label>
        <input
          className="wa-field wa-body-compact"
          id={`evidence-${requirement.controlId}`}
          type="url"
          value={evidenceUrl}
          onChange={(event) => setEvidenceUrl(event.target.value)}
          placeholder="https://"
        />
      </div>

      {error != null && (
        // Assertive: the reader has just pressed a button and is waiting on the result, so a
        // polite announcement would be queued behind whatever else is speaking.
        <p className="wa-body-compact text-wa-danger" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-end justify-between gap-3 border-t border-wa-border pt-3">
        <div className="min-w-0 space-y-1">
          <p className="wa-caption">{cadencePhrase(requirement.cadenceDays)}</p>
          {!ready && !saving && (
            <p className="wa-body-compact max-w-[64ch] text-wa-text-secondary" id={submitHelpId}>
              <span className="font-medium text-wa-text">To enable {actionLabel}:</span>{' '}
              {listPhrase(blockingReasons)}.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {saved && (
            <span className="wa-caption text-wa-success" role="status">
              Recorded
            </span>
          )}
          <button
            type="submit"
            className="wa-button-primary shrink-0"
            disabled={!ready || saving}
            aria-describedby={!ready && !saving ? submitHelpId : undefined}
          >
            {saving ? 'Recording…' : actionLabel}
          </button>
        </div>
      </div>
    </form>
  );
}
