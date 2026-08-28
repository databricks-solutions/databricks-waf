// Whether the work was actually done, and what was tried.
//
// The pane above this one shows two readings of an action: what the owner says, and what the last run
// says. This one shows the third thing, which is neither: the questions somebody asked about a claim,
// and what came back. It is the surface for the part of the record an auditor asks for and a board
// never shows — an action verified at the fourth attempt, with the three failures still under it.
//
// Four decisions in here, each one a defect in the version without it.
//
// **Every attempt is rendered, not just the last.** A pane showing only the answer that held would tell
// the story of a fix that worked first time about a fix that took a month. The failures are the part
// that says what was tried.
//
// **Waiting is not a result.** An outstanding attempt gets its own neutral badge and a sentence about
// the run that will answer it. Colouring it, or leaving it out until something answers, are the two
// ways a reader concludes something about the estate from a question nobody has answered.
//
// **The button appears exactly when the server would accept it.** `mayRequest` and `whyNot` come from
// the response. A second copy of the rule in here is what offers a button that 400s, and the rule has
// four branches — state, a missing claim date, one already outstanding, a requirement the catalogue
// has dropped.
//
// **Nothing here answers an attempt.** There is no button that marks one passed, because there is no
// route: a run answers it, or nobody does. Withdrawing is the one thing a person may do to an
// outstanding attempt, and it closes it as incomplete rather than removing it.

import { useState } from 'react';
import { Link } from 'react-router';
import { useRequestValidation, useValidations, useWithdrawValidation } from '../api/hooks';
import type { ValidationAttempt } from '../api/types';
import { StateNotice, Surface } from './system';
import { Badge } from './ui/StatusBadge';
import {
  METHOD_DETAIL,
  METHOD_LABEL,
  RESULT_ICON,
  RESULT_TONE,
  WAITING_ICON,
  WAITING_TONE,
  WINDOW_PROMPT,
  answeredPhrase,
  askedPhrase,
  attemptLabel,
  attemptStanding,
  claimedPhrase,
  windowPhrase,
} from '../pages/validate-language';

export interface ValidationTrailProps {
  readonly planId: string;
  readonly actionId: string;
  /** True while the plan is closed, which is when nothing in it may be asked for or taken back. */
  readonly frozen?: boolean;
  /**
   * Re-reads the action.
   *
   * A request moves nothing, and a withdrawal moves nothing either — but both change what the action's
   * pane may offer next, and the state the reader is looking at was computed before either happened.
   */
  readonly onChanged?: () => void;
}

/** The attempts against one action, with its own fetch. */
export function ValidationTrail({ planId, actionId, frozen = false, onChanged }: ValidationTrailProps) {
  const validations = useValidations(planId, actionId);
  const attempts = validations.data?.attempts ?? [];
  const outstanding = attempts.find((attempt) => attempt.answer == null);

  const changed = () => {
    validations.reload();
    onChanged?.();
  };

  const request = useRequestValidation(planId, actionId, changed);
  const withdraw = useWithdrawValidation(planId, actionId, outstanding?.id, changed);
  // Whichever of the two was last refused. Only one of them is reachable at a time — a claim cannot be
  // both outstanding and requestable — so one line is enough and two would both be shown.
  const refusal = request.error ?? withdraw.error;

  return (
    <ValidationTrailView
      attempts={attempts}
      mayRequest={!frozen && (validations.data?.mayRequest ?? false)}
      {...(validations.data?.whyNot != null ? { whyNot: validations.data.whyNot } : {})}
      maxObserveDays={validations.data?.maxObserveDays ?? MAX_OBSERVE_DAYS}
      {...(validations.data?.durable === false && validations.data.durabilityNote != null
        ? { durabilityNote: validations.data.durabilityNote }
        : {})}
      {...(validations.error != null ? { error: validations.error } : {})}
      saving={request.saving || withdraw.saving}
      {...(refusal != null ? { writeError: refusal } : {})}
      onRequest={async (observeDays) => (await request.send(observeDays > 0 ? { observeDays } : {})) != null}
      {...(frozen
        ? {}
        : {
            onWithdraw: async (reason) => (await withdraw.send(reason === '' ? {} : { reason })) != null,
          })}
    />
  );
}

/**
 * The window the server accepts, before it has said.
 *
 * Only used for the frame while the response is in flight, and wrong in the safe direction if the two
 * ever diverge: the server's own sentence is what a refusal shows.
 */
const MAX_OBSERVE_DAYS = 90;

export interface ValidationTrailViewProps {
  /** Newest first, as the server sends them. Not re-sorted here. */
  readonly attempts: readonly ValidationAttempt[];
  readonly mayRequest: boolean;
  /** Why one cannot be asked for, in the server's words. */
  readonly whyNot?: string;
  readonly maxObserveDays: number;
  /** Present when attempts are being kept somewhere a restart empties. */
  readonly durabilityNote?: string;
  /** Why the attempts could not be read. */
  readonly error?: string;
  readonly saving: boolean;
  /** Why the last request or withdrawal was refused, as the server put it. */
  readonly writeError?: string;
  /** Asks for one, resolving true when it was recorded. */
  readonly onRequest: (observeDays: number) => Promise<boolean>;
  /**
   * Takes back the outstanding claim. Absent where the reader may not.
   *
   * One function rather than one per attempt, because there is only ever one attempt to take back: the
   * server refuses a second while one is waiting. The button is offered on the first unanswered attempt
   * in this list, which is the one the container bound it to — the same array in the same order.
   */
  readonly onWithdraw?: (reason: string) => Promise<boolean>;
  /** For the tests, and for a page that wants the phrases fixed. */
  readonly now?: Date;
}

/**
 * The attempts and the form, with no fetching of its own.
 *
 * Split from the container for the reason the note thread is: what is worth holding is what the markup
 * says — that a failed attempt stays visible, that waiting is not coloured as a result, that no button
 * marks anything verified — and none of it is reachable through a component that renders only once its
 * own request has resolved.
 */
export function ValidationTrailView({
  attempts,
  mayRequest,
  whyNot,
  maxObserveDays,
  durabilityNote,
  error,
  saving,
  writeError,
  onRequest,
  onWithdraw,
  now,
}: ValidationTrailViewProps) {
  /*
   * Nothing at all where there is nothing to say.
   *
   * An action nobody has claimed done cannot be validated and has no attempts, and a section explaining
   * that on every draft in the plan is a paragraph of furniture on the rows furthest from being
   * checked. It appears when there is history to read or something to ask for.
   */
  if (attempts.length === 0 && !mayRequest && error == null) return null;

  const attested = attempts.some((attempt) => attempt.checks.some((check) => check.method === 'attested'));
  const waiting = attempts.find((attempt) => attempt.answer == null);

  return (
    <Surface
      tone="raised"
      title="Checked by a run"
      {...(attempts.length === 0 ? {} : { description: `${String(attempts.length)} attempted` })}
      headingLevel={3}
    >
      {durabilityNote != null && (
        <StateNotice
          tone="warning"
          announce="alert"
          title="Validation history is not durable"
          detail={durabilityNote}
        />
      )}

      {error != null && (
        <p className="wa-body-compact text-wa-danger" role="alert">
          {error}
        </p>
      )}

      {attempts.length > 0 && (
        <ol className="space-y-3">
          {attempts.map((attempt) => (
            <li key={attempt.id}>
              <Attempt
                attempt={attempt}
                {...(now != null ? { now } : {})}
                {...(attempt.id === waiting?.id && onWithdraw != null ? { onWithdraw } : {})}
                saving={saving}
              />
            </li>
          ))}
        </ol>
      )}

      {mayRequest ? (
        <RequestForm
          maxObserveDays={maxObserveDays}
          saving={saving}
          {...(writeError != null ? { error: writeError } : {})}
          onSubmit={onRequest}
        />
      ) : (
        <>
          {whyNot != null && <p className="wa-caption">{whyNot}</p>}
          {/* The withdrawal's refusal has nowhere else to go: the form above is not rendered, and the
              button that sent it sits inside an attempt that has just been re-read. */}
          {writeError != null && (
            <p className="wa-body-compact text-wa-danger" role="alert">
              {writeError}
            </p>
          )}
        </>
      )}

      {attested && (
        <p className="wa-caption">
          <span className="font-medium text-wa-text">One of these rests on somebody’s word. </span>
          {METHOD_DETAIL.attested}
        </p>
      )}
    </Surface>
  );
}

/**
 * One attempt: what was asked, what came back, and what is left to do about it.
 *
 * The badge is the result or the fact that nothing has answered yet, never both and never a guess in
 * between. Everything under it is dated against the claim, which is the line the whole feature turns
 * on: evidence from before it describes the estate as it was.
 */
function Attempt({
  attempt,
  now,
  onWithdraw,
  saving,
}: {
  readonly attempt: ValidationAttempt;
  readonly now?: Date;
  readonly onWithdraw?: (reason: string) => Promise<boolean>;
  readonly saving: boolean;
}) {
  const answer = attempt.answer;
  const window = windowPhrase(attempt.observeDays);

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          tone={answer == null ? WAITING_TONE : RESULT_TONE[answer.result]}
          Icon={answer == null ? WAITING_ICON : RESULT_ICON[answer.result]}
        >
          {attemptLabel(attempt)}
        </Badge>
        <span className="wa-caption">
          {claimedPhrase(attempt)} · {askedPhrase(attempt)}
        </span>
      </div>

      <p className="wa-body-compact text-wa-text-secondary">{attemptStanding(attempt, now ?? new Date())}</p>

      {window != null && <p className="wa-caption">{window}</p>}

      {answer != null && (
        <p className="wa-caption">
          {answer.scanId == null ? (
            answeredPhrase(answer)
          ) : (
            <Link className="text-wa-action hover:underline" to={`/history/${answer.scanId}`}>
              {answeredPhrase(answer)}
            </Link>
          )}
        </p>
      )}

      {answer != null && answer.unmet.length > 0 && (
        <p className="wa-caption">
          Still unmet: <ControlIds ids={answer.unmet} />
        </p>
      )}

      {answer != null && answer.unreadable.length > 0 && (
        <p className="wa-caption">
          No answer for: <ControlIds ids={answer.unreadable} />
        </p>
      )}

      {answer?.why != null && (
        <blockquote className="wa-body-compact border-l-2 border-wa-divider pl-2 text-wa-text-secondary">
          {answer.why}
        </blockquote>
      )}

      <ul className="wa-caption list-none space-y-0.5">
        {attempt.checks.map((check) => (
          <li key={check.controlId}>
            <Link className="text-wa-action hover:underline" to={`/findings?control=${check.controlId}`}>
              {check.controlId}
            </Link>
            {check.title != null && ` — ${check.title}`} · {METHOD_LABEL[check.method]}
          </li>
        ))}
      </ul>

      {onWithdraw != null && <Withdraw attempt={attempt} saving={saving} onWithdraw={onWithdraw} />}
    </div>
  );
}

/**
 * Taking back a claim that is waiting.
 *
 * The reason is optional, unlike the one a cancelled action insists on, because this is a question
 * taken back before anything answered it rather than a decision a colleague inherits. The line under
 * the button says what happens to the attempt, because "withdraw" reads like "delete" and it is not.
 */
function Withdraw({
  attempt,
  saving,
  onWithdraw,
}: {
  readonly attempt: ValidationAttempt;
  readonly saving: boolean;
  readonly onWithdraw: (reason: string) => Promise<boolean>;
}) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');

  if (!asking) {
    return (
      <button
        type="button"
        className="wa-caption mt-0.5 text-wa-action hover:underline"
        onClick={() => setAsking(true)}
      >
        Withdraw the claim
      </button>
    );
  }

  return (
    <form
      className="mt-1 space-y-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (saving) return;
        void onWithdraw(reason.trim()).then((withdrawn) => {
          if (withdrawn) {
            setAsking(false);
            setReason('');
          }
        });
      }}
    >
      <label className="wa-label" htmlFor={`withdraw-${attempt.id}`}>
        Why take it back?
      </label>
      <input
        className="wa-field wa-body-compact"
        id={`withdraw-${attempt.id}`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Tested in the wrong workspace."
        aria-describedby={`withdraw-help-${attempt.id}`}
      />
      <p className="wa-caption" id={`withdraw-help-${attempt.id}`}>
        Optional. The attempt stays on the record, closed as unanswered, so the fact that this was offered and taken
        back is not lost. Moving the work back to in progress is a separate step.
      </p>
      <div className="flex items-center gap-2">
        <button type="submit" className="wa-button-primary" disabled={saving}>
          {saving ? 'Withdrawing…' : 'Withdraw it'}
        </button>
        <button
          type="button"
          className="wa-button-secondary"
          onClick={() => {
            setAsking(false);
            setReason('');
          }}
          disabled={saving}
        >
          Keep waiting
        </button>
      </div>
    </form>
  );
}

/**
 * Asking a run to check the claim.
 *
 * One field, because one field is all the server takes: the requirements, the method for each and the
 * date the claim was made come from the action and the catalogue. A form that offered more would be
 * offering to validate something other than what was claimed.
 */
function RequestForm({
  maxObserveDays,
  saving,
  error,
  onSubmit,
}: {
  readonly maxObserveDays: number;
  readonly saving: boolean;
  readonly error?: string;
  readonly onSubmit: (observeDays: number) => Promise<boolean>;
}) {
  const [days, setDays] = useState('');
  const observeDays = days.trim() === '' ? 0 : Number(days);
  const bad = !Number.isInteger(observeDays) || observeDays < 0 || observeDays > maxObserveDays;

  return (
    <form
      className="mt-1.5 space-y-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (bad || saving) return;
        void onSubmit(observeDays).then((asked) => {
          if (asked) setDays('');
        });
      }}
    >
      <label className="wa-label" htmlFor="observe-days">
        Wait before checking
      </label>
      <input
        className="wa-field wa-body-compact w-24"
        id="observe-days"
        type="number"
        min={0}
        max={maxObserveDays}
        step={1}
        value={days}
        onChange={(event) => setDays(event.target.value)}
        placeholder="0"
        aria-describedby="observe-days-help"
      />
      <p className="wa-caption" id="observe-days-help">
        {bad
          ? `A whole number of days, from none to ${String(maxObserveDays)}. Longer than that is work in hand that nothing is measuring.`
          : WINDOW_PROMPT}
      </p>

      {error != null && (
        <p className="wa-body-compact text-wa-danger" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="wa-caption">The run answers this, not a person.</span>
        <button type="submit" className="wa-button-primary" disabled={bad || saving}>
          {saving ? 'Asking…' : 'Ask a run to check it'}
        </button>
      </div>
    </form>
  );
}

/** Requirement ids, each linked to what the last run said about it. */
function ControlIds({ ids }: { readonly ids: readonly string[] }) {
  return (
    <>
      {ids.map((id, at) => (
        <span key={id}>
          {at > 0 && ', '}
          <Link className="text-wa-action hover:underline" to={`/findings?control=${id}`}>
            {id}
          </Link>
        </span>
      ))}
    </>
  );
}
