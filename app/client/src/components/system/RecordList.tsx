import { ArrowUpRight, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';

export interface RecordListProps {
  readonly children: ReactNode;
  readonly label: string;
  readonly ordered?: boolean;
  readonly className?: string;
}

/** A customer-readable queue or record index. Height follows content; scale uses paging outside it. */
export function RecordList({ children, label, ordered = false, className }: RecordListProps) {
  const List = ordered ? 'ol' : 'ul';
  return (
    <List className={clsx('wa-record-list', className)} aria-label={label}>
      {children}
    </List>
  );
}

export interface RecordContentProps {
  readonly eyebrow?: ReactNode;
  readonly title: ReactNode;
  readonly summary?: ReactNode;
  readonly meta?: ReactNode;
  readonly aside?: ReactNode;
}

function RecordContent({ eyebrow, title, summary, meta, aside }: RecordContentProps) {
  return (
    <>
      <span className="wa-record-copy">
        {eyebrow != null && <span className="wa-record-eyebrow">{eyebrow}</span>}
        <span className="wa-record-title">{title}</span>
        {summary != null && <span className="wa-record-summary">{summary}</span>}
        {meta != null && <span className="wa-record-meta">{meta}</span>}
      </span>
      {aside != null && <span className="wa-record-aside">{aside}</span>}
    </>
  );
}

export interface RecordButtonProps extends RecordContentProps {
  readonly selected?: boolean;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly accessibleName?: string;
}

/** A selection inside the current task. The selected state is textually exposed through aria-pressed. */
export function RecordButton({
  selected = false,
  onSelect,
  disabled = false,
  accessibleName,
  ...content
}: RecordButtonProps) {
  return (
    <li className="wa-record-item">
      <button
        type="button"
        className="wa-record-action"
        aria-pressed={selected}
        aria-label={accessibleName}
        disabled={disabled}
        onClick={onSelect}
      >
        <RecordContent {...content} />
        <ChevronRight className="wa-record-open" aria-hidden />
      </button>
    </li>
  );
}

export interface RecordLinkProps extends RecordContentProps {
  readonly to: string;
  readonly selected?: boolean;
  readonly external?: boolean;
  readonly accessibleName?: string;
}

/** A record that changes route or selection URL. Exact external destinations retain their new-tab cue. */
export function RecordLink({ to, selected = false, external = false, accessibleName, ...content }: RecordLinkProps) {
  const classes = clsx('wa-record-action', selected && 'wa-is-selected');
  const open = external ? (
    <ArrowUpRight className="wa-record-open" aria-hidden />
  ) : (
    <ChevronRight className="wa-record-open" aria-hidden />
  );

  return (
    <li className="wa-record-item">
      {external ? (
        <a
          className={classes}
          href={to}
          aria-current={selected ? 'true' : undefined}
          aria-label={accessibleName}
          target="_blank"
          rel="noreferrer"
        >
          <RecordContent {...content} />
          {open}
        </a>
      ) : (
        <Link className={classes} to={to} aria-current={selected ? 'true' : undefined} aria-label={accessibleName}>
          <RecordContent {...content} />
          {open}
        </Link>
      )}
    </li>
  );
}

export type RecordValueProps = RecordContentProps;

/** A non-interactive record. It never receives a chevron or hover treatment that implies action. */
export function RecordValue(props: RecordValueProps) {
  return (
    <li className="wa-record-item">
      <div className="wa-record-value">
        <RecordContent {...props} />
      </div>
    </li>
  );
}
