import { useId, type ReactNode } from 'react';
import { ArrowUpRight, CheckCircle2, Wrench } from 'lucide-react';

export interface ActionPanelProps {
  /** An imperative customer action, such as “Enable serverless compute for this job”. */
  readonly title: string;
  /** The evidence-bounded reason for taking the action. */
  readonly why: ReactNode;
  /** Exact Databricks destination or the in-app workflow that owns the action. */
  readonly action: ReactNode;
  readonly destination?: ReactNode;
  readonly owner?: ReactNode;
  readonly verification?: ReactNode;
  readonly details?: ReactNode;
  readonly eyebrow?: string;
  /** Enrol a recommendation in the rendered customer-action gate. Committed improvement work is not a recommendation. */
  readonly recommendation?: boolean;
}

/** The one grammar every recommendation and opportunity must speak. */
export function ActionPanel({
  title,
  why,
  action,
  destination,
  owner,
  verification,
  details,
  eyebrow = 'Recommended action',
  recommendation = false,
}: ActionPanelProps) {
  const id = useId();

  return (
    <section
      className="wa-action-panel"
      aria-labelledby={`${id}-title`}
      {...(recommendation ? { 'data-customer-action': 'recommendation' } : {})}
    >
      <header className="wa-action-panel-header">
        <div className="wa-action-panel-heading">
          <span className="wa-action-panel-icon" aria-hidden>
            <Wrench />
          </span>
          <div>
            <p className="wa-type-eyebrow">{eyebrow}</p>
            <h2 id={`${id}-title`} className="wa-action-panel-title">
              {title}
            </h2>
          </div>
        </div>
        <div className="wa-action-panel-cta">{action}</div>
      </header>

      <div className="wa-action-panel-why">
        <p className="wa-action-panel-label">Why</p>
        <div>{why}</div>
      </div>

      {(destination != null || owner != null || verification != null) && (
        <dl className="wa-action-panel-facts">
          {destination != null && (
            <div>
              <dt>
                <ArrowUpRight aria-hidden /> Where
              </dt>
              <dd>{destination}</dd>
            </div>
          )}
          {owner != null && (
            <div>
              <dt>Owner</dt>
              <dd>{owner}</dd>
            </div>
          )}
          {verification != null && (
            <div>
              <dt>
                <CheckCircle2 aria-hidden /> Verify
              </dt>
              <dd>{verification}</dd>
            </div>
          )}
        </dl>
      )}

      {details != null && <div className="wa-action-panel-details">{details}</div>}
    </section>
  );
}
