import { useId, type ReactNode } from 'react';
import clsx from 'clsx';

export interface CustomerPageProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly as?: 'div' | 'main';
  readonly id?: string;
  readonly tabIndex?: number;
}

/** Normal document flow for customer work. A true canvas can opt into a viewport separately. */
export function CustomerPage({ children, className, as = 'div', id, tabIndex }: CustomerPageProps) {
  const Element = as;
  return (
    <Element id={id} tabIndex={tabIndex} className={clsx('wa-customer-page', className)}>
      {children}
    </Element>
  );
}

export interface PageLeadProps {
  readonly eyebrow?: string;
  readonly title: string;
  readonly summary: ReactNode;
  readonly actions?: ReactNode;
  readonly context?: ReactNode;
  readonly headingLevel?: 1 | 2;
}

/** One page promise, a short account of it, and only the actions that operate at page scope. */
export function PageLead({ eyebrow, title, summary, actions, context, headingLevel = 1 }: PageLeadProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <header className="wa-page-lead">
      <div className="wa-page-lead-copy">
        {eyebrow != null && <p className="wa-type-eyebrow">{eyebrow}</p>}
        <Heading className="wa-type-page">{title}</Heading>
        <div className="wa-page-lead-summary">{summary}</div>
        {context != null && <div className="wa-page-lead-context">{context}</div>}
      </div>
      {actions != null && <div className="wa-page-lead-actions">{actions}</div>}
    </header>
  );
}

export type SurfaceTone = 'task' | 'section' | 'raised' | 'inset' | 'accent' | 'plain';

export interface SurfaceProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly tone?: SurfaceTone;
  readonly title?: string;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly label?: string;
  readonly headingLevel?: 2 | 3 | 4;
}

/** A role-based region. Tone follows information rank rather than nesting depth. */
export function Surface({
  children,
  className,
  tone = 'section',
  title,
  description,
  action,
  label,
  headingLevel = 2,
}: SurfaceProps) {
  const generated = useId();
  const headingId = title == null ? undefined : `${generated}-title`;
  const Heading = `h${headingLevel}` as const;

  return (
    <section
      className={clsx('wa-customer-surface', `wa-customer-surface-${tone}`, className)}
      {...(headingId != null ? { 'aria-labelledby': headingId } : label != null ? { 'aria-label': label } : {})}
    >
      {(title != null || description != null || action != null) && (
        <header className="wa-customer-surface-header">
          <div>
            {title != null && (
              <Heading id={headingId} className="wa-type-section">
                {title}
              </Heading>
            )}
            {description != null && <div className="wa-customer-surface-description">{description}</div>}
          </div>
          {action != null && <div className="wa-customer-surface-action">{action}</div>}
        </header>
      )}
      <div className="wa-customer-surface-body">{children}</div>
    </section>
  );
}
