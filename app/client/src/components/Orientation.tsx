// The welcome, and the only place in the app that says what it will not do.
//
// A component rather than a page, because it is rendered in two situations that want different
// framing around it: on arrival, where it is the whole screen and the reader has not chosen it, and
// from the rail afterwards, where they have. Both get identical words. A shorter version for the
// second case would mean the reader who came back to check one thing found a summary of the thing
// they were trying to check.
//
// The order is the argument, and it is deliberately not the flattering one.
//
// What it does comes first because a reader who cannot tell what the product is will not read the
// caveats. Then what it does not do — before any score exists to be pleased with, because a boundary
// stated after a result reads as an excuse for the result. Then how to read a number, which is the
// one thing everybody takes away and the thing most often taken away wrong. Then the vocabulary,
// last, because it is reference rather than argument: nobody reads a glossary on the way in, and the
// reason it is on this page at all is so there is somewhere to come back to.
//
// Two columns above 1024px, and this is the one page in the app where the split is by kind of
// reading rather than by relationship — argument on the left, reference on the right. Stacked, the
// glossary pushes "how to read a score" a screen and a half down on a laptop, and it is the sentence
// the app most needs read.

import { Ban, Check, ExternalLink } from 'lucide-react';
import { Link } from 'react-router';
import { FRAMEWORK_URL, LIMITS, ONWARD, PROMISE, STANDING, WORDS } from './orientation-language';
import { Disclosure } from './ui/Disclosure';
import { Surface } from './system';

export interface OrientationProps {
  /**
   * What the reader does next, and how they leave without reading it.
   *
   * Passed in rather than drawn here: arriving on the app for the first time and coming back to
   * re-read the glossary are the same words with different exits, and the exit is the difference.
   */
  readonly onward?: React.ReactNode;
}

export function Orientation({ onward }: OrientationProps) {
  return (
    <div className="space-y-4">
      <Surface tone="task" title={PROMISE.heading}>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="space-y-2">
            <p className="wa-body-compact text-wa-text max-w-prose font-medium">{PROMISE.lead}</p>
            <ul className="space-y-1.5">
              {PROMISE.points.map((point) => (
                <li key={point} className="flex items-start gap-2">
                  <Check aria-hidden className="text-wa-success mt-0.5 h-4 w-4 shrink-0" />
                  <span className="wa-body-compact text-wa-text-secondary max-w-prose">{point}</span>
                </li>
              ))}
            </ul>
          </div>
          {onward != null && (
            <div className="space-y-2 lg:max-w-sm">
              <p className="wa-label">{ONWARD.heading}</p>
              <p className="wa-caption">{ONWARD.detail}</p>
              {onward}
            </div>
          )}
        </div>
      </Surface>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* The limits are a list of claims, each with the reason it holds. Marked with a symbol that
            means refusal rather than warning: none of these is a risk the reader can mitigate, and a
            warning triangle beside "it changes nothing in your estate" would read as a caution about
            the very thing that makes the app safe to point at production. */}
        <Surface tone="raised" title={LIMITS.heading}>
          <ul>
            {LIMITS.points.map((limit) => (
              <li key={limit.claim} className="wa-row-inset flex items-start gap-2">
                <Ban aria-hidden className="text-wa-text-muted mt-0.5 h-4 w-4 shrink-0" />
                <span className="flex min-w-0 flex-col">
                  <span className="wa-body-compact text-wa-text font-medium">{limit.claim}</span>
                  <span className="wa-caption max-w-prose">{limit.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </Surface>

        <Surface tone="raised" title={STANDING.heading}>
          <ul className="space-y-1.5">
            {STANDING.points.map((point) => (
              <li key={point} className="wa-body-compact text-wa-text-secondary max-w-prose">
                {point}
              </li>
            ))}
          </ul>
        </Surface>
      </div>

      <Surface
        tone="raised"
        title="The words this app uses"
        action={
          <a
            className="wa-aside-link wa-caption text-wa-action shrink-0 hover:underline"
            href={FRAMEWORK_URL}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink aria-hidden className="h-3.5 w-3.5" />
            The framework
          </a>
        }
      >
        {/*
          A definition list, which is what this is: one term, one meaning, ten times. The `dt`/`dd`
          pairing is the only structure here that a screen reader can navigate as a glossary, and the
          places in this app that dropped `dl` did so because their pairs had grown a third element —
          these have not.
        */}
        <div>
          <Disclosure summary="Open the product glossary">
            <dl className="divide-wa-divider divide-y">
              {WORDS.map((word) => (
                <div key={word.term} className="py-2">
                  <dt className="wa-label text-wa-text">
                    {word.at != null ? (
                      <Link className="text-wa-action hover:underline" to={word.at}>
                        {word.term}
                      </Link>
                    ) : (
                      word.term
                    )}
                  </dt>
                  <dd className="wa-caption max-w-prose">{word.meaning}</dd>
                </div>
              ))}
            </dl>
          </Disclosure>
        </div>
      </Surface>
    </div>
  );
}
