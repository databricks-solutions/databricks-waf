// Is anybody already on this?
//
// The question a reader asks on a failing requirement, immediately after "what do I do". Without an
// answer here they ask it in the plans surface instead, find the requirement mentioned in a plan they
// have never heard of, and raise a second action for the same thing — which is how a tracker starts
// disagreeing with itself.
//
// Every plan rather than the one the reader came from, because the plan an action lives in is rarely
// the one they were looking at. And states rather than a count: "two actions" says nothing, whereas
// "one in progress, one somebody claimed done that the last run still says is failing" is the answer.

import { useActionsFor } from '../api/hooks';
import type { ImprovementAction } from '../api/types';
import { RecordLink, RecordList, Surface } from './system';
import { Badge } from './ui/StatusBadge';
import {
  AGREEMENT_ICON,
  AGREEMENT_LABEL,
  AGREEMENT_TONE,
  STATE_ICON,
  STATE_LABEL,
  STATE_TONE,
  duePhrase,
} from '../pages/improve-language';

export function RaisedWork({
  controlId,
  actions: preloaded,
}: {
  readonly controlId: string;
  /**
   * Actions already read for this requirement. Passed by the report, which asks once for every
   * control. Absent, this pane fetches for itself — the findings page shows one requirement.
   */
  readonly actions?: readonly ImprovementAction[];
}) {
  const raised = useActionsFor(preloaded == null ? controlId : undefined);
  const loaded = preloaded ?? raised.data?.actions;

  // Silent on both failure and emptiness, and that is a deliberate asymmetry with the rest of the
  // pane. Everywhere else, a thing the app could not read is worth saying so about; here, "no
  // improvement actions could be read" on a requirement nobody has raised anything for would be a
  // permanent error message on the majority of findings, about a feature the reader has not used.
  if (loaded == null || loaded.length === 0) return null;

  const actions = [...loaded].sort(
    (a, b) =>
      Number(b.agreement === 'contradicted') - Number(a.agreement === 'contradicted') ||
      a.createdAt.localeCompare(b.createdAt)
  );

  return (
    <Surface
      tone="raised"
      title="Work already raised"
      description={`${String(actions.length)} action${actions.length === 1 ? '' : 's'}`}
      headingLevel={3}
    >
      <RecordList label="Improvement work for this requirement">
        {actions.map((action) => (
          <RecordLink
            key={action.id}
            to={`/improvements/${action.planId}?action=${action.id}`}
            eyebrow={
              <span className="flex flex-wrap items-center gap-1.5">
                <Badge tone={STATE_TONE[action.state]} Icon={STATE_ICON[action.state]}>
                  {STATE_LABEL[action.state]}
                </Badge>
                {action.agreement === 'contradicted' && (
                  <Badge tone={AGREEMENT_TONE.contradicted} Icon={AGREEMENT_ICON.contradicted}>
                    {AGREEMENT_LABEL.contradicted}
                  </Badge>
                )}
              </span>
            }
            title={action.outcome}
            meta={`${action.owner} · ${duePhrase(action)}`}
          />
        ))}
      </RecordList>
      <p className="wa-caption mt-2">
        Raising an action does not change this requirement&rsquo;s outcome. A run decides that, and the run is what
        would contradict whoever closes the work.
      </p>
    </Surface>
  );
}
