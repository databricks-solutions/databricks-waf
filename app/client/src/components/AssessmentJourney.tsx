// The durable path from a definition to the customer result.
//
// This is deliberately not application navigation. Assess owns several routes, but a customer is
// completing one four-stage piece of work across them. Keeping the stages in one component prevents
// setup, collection and review from each inventing a different account of where the result comes from.

import { Check } from 'lucide-react';
import { ASSESSMENT_STAGES, assessmentStageState, type AssessmentStage } from './assessment-journey';

export function AssessmentJourney({
  current,
  published = false,
  detail,
}: {
  readonly current: AssessmentStage;
  readonly published?: boolean;
  readonly detail: string;
}) {
  return (
    <section className="wa-assessment-journey" aria-labelledby="assessment-journey-title">
      <header className="wa-journey-heading">
        <div>
          <p className="wa-label-eyebrow">Assessment journey</p>
          <h2 id="assessment-journey-title" className="wa-title-section text-wa-text">
            Prepare → Collect → Review → Publish
          </h2>
        </div>
        <p className="wa-body-compact text-wa-text-secondary">{detail}</p>
      </header>
      <ol className="wa-journey-stages">
        {ASSESSMENT_STAGES.map((stage, index) => {
          const state = assessmentStageState(stage.id, current, published);
          return (
            <li key={stage.id} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
              <span className="wa-journey-marker" aria-hidden>
                {state === 'complete' ? <Check className="h-3.5 w-3.5" /> : String(index + 1)}
              </span>
              <span className="min-w-0">
                <span className="wa-label block text-wa-text">{stage.label}</span>
                <span className="wa-caption block">{stage.hint}</span>
              </span>
              <span className="sr-only">{state}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
