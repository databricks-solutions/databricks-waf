// Fades and gently rises a block into place as it mounts.
//
// The one deliberate reveal a page reaches for when a single element — a hero number, a callout —
// should arrive rather than simply be there. It is opt-in, not automatic: the page itself already
// fades in through .wa-customer-page, and layering a rise onto every surface would be the stagger
// spam this design avoids. Animates opacity and transform only, so it never moves layout, and under
// prefers-reduced-motion it renders the final state with no animation class or inline delay at all.

import type { CSSProperties, ReactNode } from 'react';
import clsx from 'clsx';
import { usePrefersReducedMotion } from './motion';

export interface RevealProps {
  readonly children: ReactNode;
  readonly className?: string;
  /** Delay before the reveal begins, in milliseconds. Use sparingly, for deliberate sequencing. */
  readonly delay?: number;
}

export function Reveal({ children, className, delay }: RevealProps) {
  const reduced = usePrefersReducedMotion();

  if (reduced) {
    return <div className={className}>{children}</div>;
  }

  const style = delay != null ? ({ '--wa-reveal-delay': `${delay}ms` } as CSSProperties) : undefined;
  return (
    <div className={clsx('wa-reveal', className)} style={style}>
      {children}
    </div>
  );
}
