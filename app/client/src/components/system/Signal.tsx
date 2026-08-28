import clsx from 'clsx';
import type { ReactNode } from 'react';

export type SignalTone = 'neutral' | 'positive' | 'warning' | 'critical' | 'directional';

export interface SignalProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly detail?: ReactNode;
  readonly tone?: SignalTone;
}

/** A supporting fact. Directional values are intentionally quieter than settled posture. */
export function Signal({ label, value, detail, tone = 'neutral' }: SignalProps) {
  return (
    <div className={clsx('wa-signal', `wa-signal-${tone}`)}>
      <p className="wa-signal-label">{label}</p>
      <p className="wa-signal-value">{value}</p>
      {detail != null && <div className="wa-signal-detail">{detail}</div>}
    </div>
  );
}
