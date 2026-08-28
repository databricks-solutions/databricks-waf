import { ChevronDown, FileSearch, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export interface TechnicalDisclosureProps {
  readonly children: ReactNode;
  readonly label?: string;
  readonly hint?: string;
  readonly icon?: LucideIcon;
  readonly open?: boolean;
}

/** Tertiary evidence remains available without competing with the task on arrival. */
export function TechnicalDisclosure({
  children,
  label = 'Technical evidence',
  hint,
  icon: Icon = FileSearch,
  open = false,
}: TechnicalDisclosureProps) {
  return (
    <details className="wa-technical-disclosure" open={open}>
      <summary>
        <span className="wa-technical-disclosure-label">
          <Icon aria-hidden />
          <span>{label}</span>
        </span>
        {hint != null && <span className="wa-technical-disclosure-hint">{hint}</span>}
        <ChevronDown aria-hidden className="wa-technical-disclosure-chevron" />
      </summary>
      <div className="wa-technical-disclosure-body">{children}</div>
    </details>
  );
}
