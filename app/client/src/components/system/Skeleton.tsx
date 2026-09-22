// A placeholder that holds a block's shape while its content loads.
//
// A skeleton over a bare spinner because it reserves the space the content will take — no layout jump
// when the data lands — and reads as "this specific thing is loading" rather than "something,
// somewhere, is busy". The sheen is the one loop this design keeps, and only because a loading
// affordance is exactly the case the motion rules exempt; it is off the moment content arrives, and
// off entirely under prefers-reduced-motion, where the block is a quiet static rectangle.
//
// Decorative by default, so it is hidden from assistive technology; a standalone loading region
// passes a `label` and becomes an announced status instead.

import type { CSSProperties } from 'react';
import clsx from 'clsx';
import { usePrefersReducedMotion } from './motion';

export interface SkeletonProps {
  /** Block width. A number is pixels. */
  readonly width?: number | string;
  /** Block height. A number is pixels. */
  readonly height?: number | string;
  /** Corner radius. A number is pixels. Defaults to the small token. */
  readonly radius?: number | string;
  /** Whether to show the loading sheen. Defaults to true; always off under reduced motion. */
  readonly shimmer?: boolean;
  readonly className?: string;
  /** An accessible label. Given, the block is announced as a status; omitted, it is hidden. */
  readonly label?: string;
}

export function Skeleton({ width, height, radius, shimmer = true, className, label }: SkeletonProps) {
  const reduced = usePrefersReducedMotion();
  const animate = shimmer && !reduced;

  const style: CSSProperties = { width, height };
  if (radius != null) style.borderRadius = radius;

  return (
    <span
      className={clsx('wa-skeleton', animate && 'wa-skeleton-sheen', className)}
      style={style}
      {...(label != null ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
    />
  );
}
