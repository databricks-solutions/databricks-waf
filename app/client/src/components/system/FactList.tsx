import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface FactListProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly label?: string;
}

/** Evidence-backed facts whose labels and values remain associated at every width. */
export function FactList({ children, className, label }: FactListProps) {
  return (
    <dl className={clsx('wa-fact-list', className)} aria-label={label}>
      {children}
    </dl>
  );
}

export interface FactProps {
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly detail?: ReactNode;
  readonly emphasis?: 'normal' | 'strong' | 'quiet';
}

export function Fact({ label, value, detail, emphasis = 'normal' }: FactProps) {
  return (
    <div className="wa-fact" data-emphasis={emphasis}>
      <dt>{label}</dt>
      <dd>
        <span className="wa-fact-value">{value}</span>
        {detail != null && <span className="wa-fact-detail">{detail}</span>}
      </dd>
    </div>
  );
}
