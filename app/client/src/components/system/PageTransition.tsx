// A subtle enter for a page's content.
//
// Most pages compose CustomerPage, which already fades its whole document in through
// .wa-customer-page, so they need nothing here. This is for the standalone canvas that does not — or
// for a later wave that wants to key an explicit re-enter on a route change. It fades and rises its
// children once on mount, opacity and transform only, and renders the final state with no animation
// under prefers-reduced-motion.

import type { ReactNode } from 'react';
import clsx from 'clsx';
import { usePrefersReducedMotion } from './motion';

export interface PageTransitionProps {
  readonly children: ReactNode;
  readonly className?: string;
}

export function PageTransition({ children, className }: PageTransitionProps) {
  const reduced = usePrefersReducedMotion();
  return <div className={clsx('wa-page-transition', !reduced && 'wa-reveal', className)}>{children}</div>;
}
