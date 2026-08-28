// One question, everything a reader needs to answer it, and the form that records the answer.
//
// Extracted from AttestationsPage when the guided pass arrived, on the same reasoning as the detail
// panel it is built from: two surfaces asking the same question have to ask it identically. The pane
// carries the order that took several passes to get right — the question as the heading, then why it
// is being asked, then the previous answer, then the guidance, then the form, then the history — and
// a second copy of that order would drift from this one within a release.
//
// It is deliberately ignorant of which surface it is on. The walk's own controls sit outside it.

import { AnswerForm, answerFormKey } from './AnswerForm';
import { AnswerGuidance } from './AnswerGuidance';
import { AnswerHistory } from './AnswerHistory';
import { Surface } from './system';
import { IdentifierBadge, SeverityBadge } from './ui/StatusBadge';
import { StateBadge } from './StateBadge';
import {
  ANSWER_LABEL,
  ASKED_DETAIL,
  STATE_DETAIL,
  attributionPhrase,
  renewalPhrase,
  stateOf,
} from '../pages/attest-language';
import type { useSubmitAnswer } from '../api/hooks';
import type { AttestableRequirement } from '../api/types';

export interface QuestionPaneProps {
  readonly requirement: AttestableRequirement;
  readonly pillar: string;
  readonly submission: ReturnType<typeof useSubmitAnswer>;
  /** The walk's step controls, rendered under the form where the reader's hand already is. */
  readonly footer?: React.ReactNode;
}

export function QuestionPane({ requirement, pillar, submission, footer }: QuestionPaneProps) {
  const state = stateOf(requirement);
  const answer = requirement.attestation;

  return (
    <div className="space-y-3">
      {/* The framework's name for the requirement is the eyebrow and the question is the heading,
          because the question is what the reader is answering. It was the other way round — the
          title as the heading with the question beneath it in a lighter weight — which put two
          claims of the same thing at the top of the pane and gave the more important one less
          weight. The same customer-system roles build the finding workspace. */}
      <Surface
        tone="accent"
        title={requirement.question}
        description={`${pillar} · ${requirement.title}`}
        action={
          <span className="flex flex-wrap items-center gap-1.5">
            <IdentifierBadge>{requirement.controlId}</IdentifierBadge>
            <SeverityBadge severity={requirement.severity} />
            <StateBadge state={state} />
          </span>
        }
      >
        {/* What a defensible answer rests on, shown here and not only as a placeholder in the field
          below. A placeholder vanishes on the first keystroke — which is the moment the reader is
          deciding what to write — and is read inconsistently by screen readers.

          Then why it is a question at all, and what the current state costs. The reader deciding how
          much care to take needs to know whether their answer is the only evidence that will ever
          exist or a stand-in for a reading the app was refused. */}
        {requirement.evidenceGuidance != null && (
          <p className="wa-caption border-l-2 border-wa-divider pl-2">{requirement.evidenceGuidance}</p>
        )}
        <p className="wa-caption">
          {ASKED_DETAIL[requirement.askedBecause]} {STATE_DETAIL[state]}
        </p>
      </Surface>

      {answer != null && (
        <Surface tone="raised" title="Current answer" headingLevel={3}>
          <p className="wa-body-compact text-wa-text">
            {ANSWER_LABEL[answer.answer]} — {attributionPhrase(answer.attestedBy, answer.attestedAt)}
          </p>
          <blockquote className="wa-body-compact border-l-2 border-wa-divider pl-2 text-wa-text-secondary">
            {answer.statement}
          </blockquote>
          <p className="wa-caption">
            Accountable: {answer.owner}. {renewalPhrase(answer.reviewBy, state)}
          </p>
          {answer.evidenceUrl != null && (
            <a
              className="wa-body-compact text-wa-action hover:underline"
              href={answer.evidenceUrl}
              target="_blank"
              rel="noreferrer"
            >
              Evidence for this answer
            </a>
          )}
        </Surface>
      )}

      {/* Above the form rather than below it, and above the current answer's renewal note too. The
          reader's next action is to type, and guidance under the field is guidance read after the
          answer is written. Renders nothing where nobody has authored an entry yet. */}
      <AnswerGuidance controlId={requirement.controlId} />

      {/* Flush, both of them: the form and the history bring their own padding and their own header,
          and nesting either inside this pane's padding read as a panel within a panel. */}
      <div>
        {/* Keyed, so the fields reset when the subject changes — a different requirement, or this one
            after an answer is recorded. See answerFormKey. */}
        <AnswerForm
          key={answerFormKey(requirement)}
          requirement={requirement}
          onSubmit={submission.submit}
          saving={submission.saving}
          {...(submission.error != null ? { error: submission.error } : {})}
          saved={submission.saved === requirement.controlId}
        />
      </div>

      {footer}

      <div>
        <AnswerHistory key={requirement.controlId} controlId={requirement.controlId} />
      </div>
    </div>
  );
}
