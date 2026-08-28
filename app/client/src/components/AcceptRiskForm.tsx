// Accepting that one requirement is unmet, on purpose, for a while.
//
// Two prose fields rather than one, and that is the whole design. Given a single box people write why
// the requirement is not met — which is the honest answer to "why", and not the thing a reviewer
// needs. So "why" is asked first and separately, and then the field this record exists for: what is
// holding the line instead. Asking them in that order is what makes the second one answerable; asking
// only the second gets the first one written into it.
//
// The form refuses before the server does wherever it can. It knows the cap on the expiry for this
// requirement's severity, so the date input cannot offer a date that would come back rejected. It
// knows the residual may not exceed the requirement's severity, so the higher options are not offered.
// The same principle put the one-at-a-time rule in the panel rather than here: this form is not opened
// while an acceptance is in force, because the alternative was offering to replace one and handing the
// reader back a filled-in form with the server's refusal under it.
// And it names the words the compensating-control field refuses, because somebody typing "n/a" has
// read the field as paperwork and needs telling what it is for — being told "write 17 more characters"
// teaches them to write "n/a for now, see above" instead.
//
// Nothing here can move the score, and the copy says so at the point of the choice.

import { useState } from 'react';
import type { RiskDraft } from '../api/hooks';
import type { Severity } from '../api/types';
import {
  acceptanceDaysFor,
  earliestExpiry,
  earliestStart,
  endOfDay,
  latestExpiry,
  MIN_PROSE,
  saysNothing,
  startOfDay,
  suggestedExpiry,
} from '../pages/accept-language';

/** Most to least, so the options below a requirement's own severity are a suffix of this. */
const RESIDUALS: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'informational'];

export interface AcceptRiskFormProps {
  readonly controlId: string;
  /** The requirement's own severity, which caps both the expiry and the residual. */
  readonly severity?: Severity;
  /** The caps the server enforces, from the risks payload. */
  readonly acceptanceDays?: Readonly<Record<Severity, number>>;
  readonly onSubmit: (draft: RiskDraft) => void;
  readonly saving: boolean;
  /** The server's refusal, against the form rather than as a toast that scrolls away. */
  readonly error?: string;
  readonly saved: boolean;
}

export function AcceptRiskForm({
  controlId,
  severity,
  acceptanceDays,
  onSubmit,
  saving,
  error,
  saved,
}: AcceptRiskFormProps) {
  const cap = acceptanceDaysFor(severity, acceptanceDays);
  const [reason, setReason] = useState('');
  const [control, setControl] = useState('');
  const [owner, setOwner] = useState('');
  const [from, setFrom] = useState(earliestStart());
  const [until, setUntil] = useState(suggestedExpiry(cap));
  /*
   * Nothing preselected, for the reason the decision form preselects no disposition: a residual that
   * arrives chosen is a residual that gets submitted, and the one that would get chosen most is the
   * one that makes the exposure look smallest.
   */
  const [residual, setResidual] = useState<Severity | undefined>(undefined);

  // Only what this requirement's severity permits. A residual above it is an escalation rather than
  // an acceptance, and the server refuses it — so it is not offered.
  const permitted = severity == null ? RESIDUALS : RESIDUALS.slice(RESIDUALS.indexOf(severity));

  const reasonShort = reason.trim().length < MIN_PROSE;
  const controlShort = control.trim().length < MIN_PROSE;
  const controlEmpty = saysNothing(control);
  const ready =
    !reasonShort && !controlShort && !controlEmpty && residual != null && owner.trim() !== '' && until !== '';

  return (
    <form
      className="flex flex-col gap-4 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || saving || residual == null) return;
        onSubmit({
          controlId,
          reason: reason.trim(),
          compensatingControl: control.trim(),
          residual,
          owner: owner.trim(),
          // The start of the chosen day and the end of the chosen day: an acceptance effective from
          // the 4th covers the 4th, and one expiring on the 30th holds through the 30th.
          effectiveFrom: startOfDay(from),
          expiresAt: endOfDay(until),
        });
      }}
    >
      <div className="flex flex-col gap-1">
        <label className="wa-label" htmlFor={`risk-reason-${controlId}`}>
          Why the requirement is not met
        </label>
        <textarea
          className="wa-textarea wa-body-compact"
          id={`risk-reason-${controlId}`}
          rows={2}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="What stands in the way of meeting it, for now."
          aria-describedby={`risk-reason-help-${controlId}`}
          required
        />
        <p className="wa-caption" id={`risk-reason-help-${controlId}`}>
          {reasonShort ? `At least ${String(MIN_PROSE - reason.trim().length)} more characters.` : 'Long enough.'}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <label className="wa-label" htmlFor={`risk-control-${controlId}`}>
          What is holding the line instead
        </label>
        <textarea
          className="wa-textarea wa-body-compact"
          id={`risk-control-${controlId}`}
          rows={3}
          value={control}
          onChange={(event) => setControl(event.target.value)}
          placeholder="The control that reduces the exposure while this is unmet, and who checks it."
          aria-describedby={`risk-control-help-${controlId}`}
          required
        />
        {/*
         * The refusal of "none" is explained before it is triggered, and it explains what to write
         * instead. The honest case where nothing is holding the line is writable — it just has to be
         * written as a sentence, because that sentence is the one a reviewer needs.
         */}
        <p className="wa-caption" id={`risk-control-help-${controlId}`}>
          {controlEmpty
            ? 'If nothing is holding the line, write that as a sentence and say why the exposure is tolerable. That is the sentence a reviewer needs.'
            : controlShort
              ? `At least ${String(MIN_PROSE - control.trim().length)} more characters. This is the field an auditor reads first.`
              : 'Read by whoever reviews this exception.'}
        </p>
      </div>

      <fieldset className="flex flex-col gap-1">
        <legend className="wa-label pb-1.5">Risk left over, after that control</legend>
        <div className="flex flex-wrap gap-2">
          {permitted.map((value) => (
            <label key={value} className="wa-row cursor-pointer items-center gap-2 px-2 py-1" data-selected={residual === value}>
              <input
                type="radio"
                name={`residual-${controlId}`}
                value={value}
                checked={residual === value}
                onChange={() => setResidual(value)}
              />
              <span className="wa-body-compact text-wa-text">{value}</span>
            </label>
          ))}
        </div>
        <p className="wa-caption pt-1">
          {severity == null
            ? 'What is left after the control above, not what the requirement carries.'
            : `Cannot exceed ${severity}, which is what this requirement carries. A record claiming otherwise would be an escalation rather than an acceptance.`}
        </p>
      </fieldset>

      <div className="flex flex-col gap-1">
        <label className="wa-label" htmlFor={`risk-owner-${controlId}`}>
          Who is answerable
        </label>
        <input
          className="wa-field wa-body-compact"
          id={`risk-owner-${controlId}`}
          value={owner}
          onChange={(event) => setOwner(event.target.value)}
          placeholder="Team or person, e.g. platform-engineering"
          aria-describedby={`risk-owner-help-${controlId}`}
          required
        />
        <p className="wa-caption" id={`risk-owner-help-${controlId}`}>
          The team that carries the consequence, which need not be you. Yours is recorded as who accepted it.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="wa-label" htmlFor={`risk-from-${controlId}`}>
            In force from
          </label>
          <input
            className="wa-field wa-body-compact"
            id={`risk-from-${controlId}`}
            type="date"
            value={from}
            min={earliestStart()}
            onChange={(event) => setFrom(event.target.value)}
            aria-describedby={`risk-from-help-${controlId}`}
            required
          />
          <p className="wa-caption" id={`risk-from-help-${controlId}`}>
            Today or later. It cannot be backdated: an acceptance effective from last quarter would claim the exposure
            was covered when nothing was recorded.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label className="wa-label" htmlFor={`risk-until-${controlId}`}>
            Expires
          </label>
          <input
            className="wa-field wa-body-compact"
            id={`risk-until-${controlId}`}
            type="date"
            value={until}
            min={earliestExpiry()}
            max={latestExpiry(cap)}
            onChange={(event) => setUntil(event.target.value)}
            aria-describedby={`risk-until-help-${controlId}`}
            required
          />
          <p className="wa-caption" id={`risk-until-help-${controlId}`}>
            The requirement comes back on the list on this date. A {severity ?? 'requirement of this'} severity
            requirement can be accepted for at most {String(cap)} days at a time, measured from today.
          </p>
        </div>
      </div>

      {error != null && (
        <p className="wa-body-compact text-wa-danger" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        {/* Both halves. That it does not move the score is the property that makes the record safe;
            that there is no edit is the property that makes it worth keeping, and a reader who finds
            that out after writing one has been told too late. */}
        <p className="wa-caption">
          Does not change the score. Cannot be edited afterwards — a longer run is a new acceptance.
        </p>
        <div className="flex items-center gap-2">
          {saved && (
            <span className="wa-caption text-wa-success" role="status">
              Recorded
            </span>
          )}
          {/* One label, because there is one thing this form does. It offered "Replace acceptance"
              while a previous one was in force, which the server refuses by design — a requirement
              carries one acceptance at a time, so the panel no longer opens this form in that case. */}
          <button type="submit" className="wa-button-primary" disabled={!ready || saving}>
            {saving ? 'Recording…' : 'Accept the risk'}
          </button>
        </div>
      </div>
    </form>
  );
}
