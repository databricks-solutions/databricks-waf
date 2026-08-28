// One question in the contents of a guided pass.
//
// Its own module rather than a function inside WalkPage, so that the marking rule below can be
// tested. WalkPage transitively imports AppKit's charts, which do not resolve under vitest, so
// anything that needs a test has to live outside the page — which is also where QuestionPane and
// StateBadge ended up.

import { Check } from 'lucide-react';
import { StateBadge } from './StateBadge';
import { stateOf } from '../pages/attest-language';
import type { AttestableRequirement } from '../api/types';

export interface ContentsRowProps {
  readonly question: AttestableRequirement;
  readonly selected: boolean;
  /** Deliberately left for later, which is a decision and not a state of the answer. */
  readonly deferred: boolean;
  readonly onSelect: () => void;
}

export function ContentsRow({ question, selected, deferred, onSelect }: ContentsRowProps) {
  const state = stateOf(question);

  return (
    <button
      type="button"
      className="wa-row items-start gap-2 py-1.5 text-left"
      data-selected={selected}
      aria-current={selected}
      onClick={onSelect}
    >
      {/* Marked by exception, because a contents list of a hundred rows cannot afford a badge on each.
          A tick where the question is answered and still counts, a badge where the answer needs
          attention — due or expired — and nothing at all for unanswered, which on a first pass is
          every row: badging all of them said "Unanswered" a hundred times down the column and left
          the titles competing with it for the width. No unanswered marker in the row's audio either,
          for the same reason and to keep the two modalities saying the same thing; the state is
          spelled out in full in the question pane, which is where a reader acts on it.

          If you are tempted to add a hidden one back: it costs more than a node. `sr-only` is
          absolutely positioned, so with nothing positioned between it and the shell its containing
          block is the document and `.wa-app`'s `overflow: hidden` does not clip it. Ninety-five of
          them down a 5227px scrolling list took the document's scroll height to 5494 on a shell
          locked to 900px — invisible on screen, and caught only by `npm run check:viewport`. */}
      <span className="mt-0.5 shrink-0">
        {state === 'current' ? (
          <Check aria-label="Answered" className="h-4 w-4 text-wa-success" />
        ) : state === 'unanswered' ? null : (
          <StateBadge state={state} />
        )}
      </span>
      <span className="wa-body-compact min-w-0 flex-1 text-wa-text">
        {question.title}
        {deferred && <span className="wa-caption block">Left for later</span>}
      </span>
    </button>
  );
}
