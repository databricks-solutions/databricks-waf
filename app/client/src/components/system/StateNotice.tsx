import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Info,
  LoaderCircle,
  OctagonAlert,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import clsx from 'clsx';

export type StateNoticeTone = 'neutral' | 'info' | 'loading' | 'partial' | 'success' | 'warning' | 'danger';

const ICONS: Readonly<Record<StateNoticeTone, LucideIcon>> = {
  neutral: Info,
  info: Info,
  loading: LoaderCircle,
  partial: CircleDashed,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: OctagonAlert,
};

const TONE_CLASS: Readonly<Record<StateNoticeTone, string>> = {
  neutral: 'wa-state-notice-neutral',
  info: 'wa-state-notice-info',
  loading: 'wa-state-notice-loading',
  partial: 'wa-state-notice-partial',
  success: 'wa-state-notice-success',
  warning: 'wa-state-notice-warning',
  danger: 'wa-state-notice-danger',
};

export interface StateNoticeProps {
  readonly title: string;
  readonly detail: ReactNode;
  readonly tone?: StateNoticeTone;
  readonly action?: ReactNode;
  /**
   * Live-region semantics describe urgency, not colour. Partial and warning states are not alerts unless
   * the caller knows they interrupt the current task.
   */
  readonly announce?: 'status' | 'alert';
}

/** A loading, partial, recovery or completion state that keeps its next action beside the explanation. */
export function StateNotice({ title, detail, tone = 'neutral', action, announce }: StateNoticeProps) {
  const Icon = ICONS[tone];
  return (
    <div className={clsx('wa-state-notice', TONE_CLASS[tone])} role={announce}>
      <Icon className={clsx('wa-state-notice-icon', tone === 'loading' && 'wa-is-spinning')} aria-hidden />
      <div className="wa-state-notice-copy">
        <p className="wa-state-notice-title">{title}</p>
        <div className="wa-state-notice-detail">{detail}</div>
      </div>
      {action != null && <div className="wa-state-notice-action">{action}</div>}
    </div>
  );
}
