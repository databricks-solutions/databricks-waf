// One product sentence for specialist advice.
//
// Workloads, warehouses, jobs and writes used to carry four almost-identical finding cards, while
// serverless used a fifth structure. The evidence was sound, but a reader had to relearn where the
// observation, qualification and action lived on every lens. This frame fixes the reading order
// without flattening the analyzers into one model: each caller still supplies its own observation,
// evidence and qualification, and the frame supplies only the shared customer grammar.

import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { Disclosure } from './ui/Disclosure';

export interface SpecialistOpportunityProps {
  /** The concrete first step, written as an imperative. */
  readonly recommendation: string;
  readonly title: string;
  /** What this analyzer observed about this resource. */
  readonly detail: ReactNode;
  /** Severity, kind or other analyzer-owned state. */
  readonly status?: ReactNode;
  /** The measurements and denominator that support the opportunity. */
  readonly evidence?: ReactNode;
  /** Confidence, rationale or a limit on what the evidence can say. */
  readonly qualification?: ReactNode;
  /** Exact Databricks workspace location for the affected resource, when the analyzer can resolve it. */
  readonly resourceUrl?: string;
  readonly resourceLabel?: string;
  readonly guidanceUrl?: string;
  /** The existing evidence-preserving handoff into improvement work. */
  readonly action?: ReactNode;
}

export function SpecialistOpportunity({
  recommendation,
  title,
  detail,
  status,
  evidence,
  qualification,
  resourceUrl,
  resourceLabel = 'Open in Databricks',
  guidanceUrl,
  action,
}: SpecialistOpportunityProps) {
  const hasProvenance = evidence != null || qualification != null;
  const hasNextAction = resourceUrl != null || guidanceUrl != null || action != null;

  return (
    <article
      className="space-y-2 border-t border-wa-divider py-3 first:border-t-0"
      data-customer-action="recommendation"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="wa-label">Do this</p>
          <h2 className="wa-title-section text-wa-text">{recommendation}</h2>
        </div>
        {status != null && <span className="shrink-0">{status}</span>}
      </div>

      <div className="space-y-1">
        <p className="wa-label">Why</p>
        <p className="wa-body-compact font-medium text-wa-text">{title}</p>
        <div className="wa-body-compact text-wa-text-secondary">{detail}</div>
      </div>

      {hasNextAction && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-wa-divider pt-2">
          {resourceUrl != null && (
            <a href={resourceUrl} target="_blank" rel="noreferrer" className="wa-customer-primary-action">
              {resourceLabel}
              <ExternalLink aria-hidden className="ml-1 inline h-3 w-3" />
            </a>
          )}
          {guidanceUrl != null && (
            <a href={guidanceUrl} target="_blank" rel="noreferrer" className="wa-customer-secondary-action">
              Read implementation guidance
              <ExternalLink aria-hidden className="ml-1 inline h-3 w-3" />
            </a>
          )}
          {action}
        </div>
      )}

      {hasProvenance && (
        <Disclosure summary="Evidence and qualification">
          {evidence}
          {qualification}
        </Disclosure>
      )}
    </article>
  );
}
