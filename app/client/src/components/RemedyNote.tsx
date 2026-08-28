// What would make an unmeasured requirement measurable.
//
// Its own file rather than a helper inside the detail pane, because it is the piece of that pane
// most likely to be wrong in a way typechecking cannot see: the whole point of it is that a
// reader is told to grant something only when granting would work, and that distinction lives in
// which of six headings appears above the sentence.
//
// Stacked rather than laid out as a row. The owner started as a pill opposite the heading, which
// measured 372px of content in a 366px pane — so it wrapped to a second line on every finding at
// every viewport width, and the pill fill turned out to be the same token as the callout fill,
// leaving it a ring at 1.1:1. As lighter text after the heading it cannot collide with anything,
// and the heading keeps the emphasis without having to compete for it.
//
// Order is heading, advice, the link that acts on the advice, then everything optional. The version
// before this closed with "Closed by whoever owns the practice." on all 105 findings, underneath the
// link — a line identical on every one of them, saying what the advice already said, positioned so
// the eye left the pane past the only clickable thing on it. What survives below the link is only
// what differs per finding: the platform's own refusal, and which signals were read.
//
// The platform's own words go under the advice rather than instead of it, and behind a disclosure
// rather than in front of one. A reader being told to issue a grant is entitled to see the refusal
// that prompted it; a reader being told nothing can be done needs it more, because that is the
// claim they have most reason to doubt. Neither of them needs a stack trace in their way first.
//
// `controlId` is a prop rather than something read from the remedy, and it is not decoration: the
// link carries it so the answers page opens on *this* requirement. It first shipped as a bare
// `/answers`, which that page reads as "no selection" and answers by selecting the first of 105 — so
// from any finding but the alphabetically-first one, a link reading "Answer this requirement" opened
// a different requirement's form, complete with its question and a live button to record it. Worse
// than a dead link, and it survived review because the finding used to test it happened to sort
// first.

import { Link } from 'react-router';
import { presentRemedy } from './remedy-language';
import type { Remedy } from '../api/types';

export function RemedyNote({ remedy, controlId }: { remedy: Remedy; controlId: string }) {
  const { heading, owner, tone, action } = presentRemedy(remedy.kind);

  return (
    <div className={tone == null ? 'wa-callout space-y-1.5' : `wa-callout ${tone} space-y-1.5`}>
      <p className="wa-body-compact font-semibold text-wa-text">
        {heading}
        {/* On the heading's line, so it frames the advice instead of following the link that acts on
            it, and set lighter so it reads as the qualifier it is rather than as part of the label. */}
        {owner != null && <span className="font-normal text-wa-text-secondary"> · {owner}</span>}
      </p>
      <p className="wa-body-compact text-wa-text-secondary">{remedy.says}</p>

      {action != null && (
        <Link
          to={`${action.to}?control=${encodeURIComponent(controlId)}`}
          className="wa-body-compact inline-block font-medium text-wa-action hover:underline"
        >
          {action.label} →
        </Link>
      )}

      {remedy.because != null && (
        <details>
          <summary className="wa-caption cursor-pointer text-wa-action hover:underline">What the platform said</summary>
          {/* On the pane surface rather than the callout's own fill, which the callout took from
              the same token: a block quoting the platform verbatim has to look quoted. */}
          <pre className="wa-code-block mt-1 rounded-sm bg-wa-surface">{remedy.because}</pre>
        </details>
      )}

      {remedy.signals.length > 0 && (
        <p className="wa-caption">
          Read from <span className="wa-code">{remedy.signals.join(', ')}</span>.
        </p>
      )}
    </div>
  );
}
