// The friendly lead band under a page title: what is true, what it means, and the one next step.
//
// Progressive disclosure starts here. Before any table, signal or coverage figure, a page says in a
// plain sentence where things stand and — if there is one — what to do about it. The tone tints a
// single accent edge, and only that: the status is carried by the words, never by colour alone, so a
// reader who cannot tell the edge colours apart still reads the same thing. The dense technical
// detail lives behind DetailDisclosure, below this.

import type { ReactNode } from 'react';
import clsx from 'clsx';

/** Status colour, reserved for status meaning. Neutral spends no verdict colour at all. */
export type PlainTone = 'neutral' | 'info' | 'success' | 'caution' | 'warning' | 'danger' | 'unmeasured';

export interface PlainSummaryProps {
  /** The plain-language headline — what is true right now, in a sentence a non-expert reads first. */
  readonly status: ReactNode;
  /** One plain sentence of what it means, or what happens next. */
  readonly meaning?: ReactNode;
  /** The status colour. Defaults to neutral, which uses no verdict colour. */
  readonly tone?: PlainTone;
  /** A single next step — a link or a button — set beside the summary. */
  readonly nextAction?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
}

export function PlainSummary({
  status,
  meaning,
  tone = 'neutral',
  nextAction,
  children,
  className,
}: PlainSummaryProps) {
  return (
    <div className={clsx('wa-plain-summary', className)} data-tone={tone}>
      <div className="wa-plain-summary-copy">
        <p className="wa-plain-summary-status">{status}</p>
        {meaning != null && <p className="wa-plain-summary-meaning">{meaning}</p>}
        {children}
      </div>
      {nextAction != null && <div className="wa-plain-summary-action">{nextAction}</div>}
    </div>
  );
}
