// Deciding what to do about one finding.
//
// Four choices, and the form's whole job is to make the honest one easy. "Fixed it" is first because
// it is what somebody who has just done the work is looking for, and because it is the only claim
// the app can check — the next run either agrees with it or contradicts it, and the reader is told
// which. The other three are statements of intent, so each asks for the two things that make an
// intent reviewable later: a reason in words, and somebody's name.
//
// The date field appears only for the two dispositions that park a finding, and its maximum comes
// from the server's own cap for the requirement's severity. A reader who tries to accept a critical
// failure for a year is told before they press the button rather than after, and the input cannot
// offer a date the server would refuse.
//
// Nothing here can move the score, and the copy says so where the choice is made rather than in a
// footnote. That is the property that makes the feature safe: the queue responds to a decision, the
// measurement does not.

import { useState } from 'react';
import type { DecisionDraft } from '../api/hooks';
import type { Disposition, Severity } from '../api/types';
import {
  DISPOSITIONS,
  DISPOSITION_EFFECT,
  DISPOSITION_LABEL,
  earliestDate,
  endOfDay,
  latestDate,
  parkDaysFor,
  suggestedDate,
} from '../pages/decide-language';

/** The server's own minimum, repeated here so the reader is told before they submit, not after. */
const MIN_REASON = 20;

export interface DecisionFormProps {
  readonly controlId: string;
  readonly severity?: Severity;
  /** The caps the server enforces, from the decisions payload. */
  readonly parkDays?: Readonly<Record<Severity, number>>;
  /** True when a decision already stands, so the form offers to replace it rather than to add one. */
  readonly hasDecision: boolean;
  readonly onSubmit: (draft: DecisionDraft) => void;
  readonly saving: boolean;
  /** The server's rejection, shown against the form rather than as a toast that scrolls away. */
  readonly error?: string;
  readonly saved: boolean;
}

export function DecisionForm({
  controlId,
  severity,
  parkDays,
  hasDecision,
  onSubmit,
  saving,
  error,
  saved,
}: DecisionFormProps) {
  /*
   * Nothing preselected. A form that arrives with a disposition chosen is a form that collects
   * whatever it defaulted to, and the default that would get chosen most is the one that takes the
   * row off the list.
   */
  const [disposition, setDisposition] = useState<Disposition | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [owner, setOwner] = useState('');
  const cap = parkDaysFor(severity, parkDays);
  const [until, setUntil] = useState(suggestedDate(cap));

  const dated = disposition === 'accepted' || disposition === 'deferred';
  const short = reason.trim().length < MIN_REASON;
  const needsOwner = disposition != null && disposition !== 'reopened';
  const ready = disposition != null && !short && (!needsOwner || owner.trim() !== '') && (!dated || until !== '');

  return (
    <form
      className="flex flex-col gap-4 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || saving || disposition == null) return;
        onSubmit({
          controlId,
          disposition,
          reason: reason.trim(),
          ...(needsOwner ? { owner: owner.trim() } : {}),
          // The end of the day the reader picked, because that is what a date on a decision means:
          // "review this by the 30th" holds through the 30th. Sending the day's start instead would
          // send a moment already past for every reader west of UTC.
          ...(dated ? { until: endOfDay(until) } : {}),
        });
      }}
    >
      <fieldset className="flex flex-col gap-1.5">
        <legend className="wa-label pb-1.5">What are you doing about it</legend>
        {DISPOSITIONS.filter((value) => value !== 'reopened' || hasDecision).map((value) => (
          <label
            key={value}
            className="wa-row cursor-pointer items-start gap-2 py-1.5"
            data-selected={disposition === value}
          >
            <input
              type="radio"
              name={`disposition-${controlId}`}
              value={value}
              checked={disposition === value}
              onChange={() => setDisposition(value)}
              className="mt-0.5 shrink-0"
            />
            <span className="min-w-0">
              <span className="wa-body-compact block font-medium text-wa-text">{DISPOSITION_LABEL[value]}</span>
              <span className="wa-caption block">{DISPOSITION_EFFECT[value]}</span>
            </span>
          </label>
        ))}
        {/* The cap, before the choice rather than inside the date field it constrains. A reader
            deciding between accepting and fixing wants to know how long accepting buys them, and
            learning it only after picking a disposition means picking again. */}
        <p className="wa-caption pt-1">
          A {severity ?? 'requirement of this'} severity requirement can be parked for at most {String(cap)} days at a
          time, so somebody looks at it again by then.
        </p>
      </fieldset>

      {dated && (
        <div className="flex flex-col gap-1">
          <label className="wa-label" htmlFor={`until-${controlId}`}>
            {disposition === 'accepted' ? 'Review this by' : 'Fix due by'}
          </label>
          <input
            className="wa-field wa-body-compact"
            id={`until-${controlId}`}
            type="date"
            value={until}
            min={earliestDate()}
            max={latestDate(cap)}
            onChange={(event) => setUntil(event.target.value)}
            aria-describedby={`until-help-${controlId}`}
            required
          />
          <p className="wa-caption" id={`until-help-${controlId}`}>
            The finding comes back on the list on this date, whoever is looking at it then.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label className="wa-label" htmlFor={`reason-${controlId}`}>
          Why
        </label>
        <textarea
          className="wa-textarea wa-body-compact"
          id={`reason-${controlId}`}
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="What you changed, or why this is acceptable for now."
          aria-describedby={`reason-help-${controlId}`}
          required
        />
        <p className="wa-caption" id={`reason-help-${controlId}`}>
          Read by whoever inherits this.{' '}
          {short ? `At least ${String(MIN_REASON - reason.trim().length)} more characters.` : 'Long enough.'}
        </p>
      </div>

      {needsOwner && (
        <div className="flex flex-col gap-1">
          <label className="wa-label" htmlFor={`owner-${controlId}`}>
            Who is answerable
          </label>
          <input
            className="wa-field wa-body-compact"
            id={`owner-${controlId}`}
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
            placeholder="Team or person, e.g. platform-engineering"
            aria-describedby={`owner-help-${controlId}`}
            required
          />
          <p className="wa-caption" id={`owner-help-${controlId}`}>
            The team that carries the consequence, which need not be you. Yours is recorded as who decided.
          </p>
        </div>
      )}

      {error != null && (
        <p className="wa-body-compact text-wa-danger" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <p className="wa-caption">Does not change the score.</p>
        <div className="flex items-center gap-2">
          {saved && (
            <span className="wa-caption text-wa-success" role="status">
              Recorded
            </span>
          )}
          <button type="submit" className="wa-button-primary" disabled={!ready || saving}>
            {saving ? 'Recording…' : hasDecision ? 'Replace decision' : 'Record decision'}
          </button>
        </div>
      </div>
    </form>
  );
}
