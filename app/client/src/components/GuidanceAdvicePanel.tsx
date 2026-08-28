// What to do about a requirement, on the finding as well as on the question.
//
// The panel beside a question answers "what should I put". This one answers "and now what", which is
// a different reader at a different moment and — for 59 of the 184 requirements, the ones this app
// measures and never puts to anybody — the only one there is. Until this existed a reader who opened
// a failing finding got the evidence, a remedy command where one exists, and nothing about where they
// were supposed to end up.
//
// It renders on a pass too, and that is the point rather than an oversight. A finding that says
// "pass" and stops is what makes this an audit; the target state, what sustaining it costs and the
// event that reopens the decision are as true of an estate that is doing it as of one that is not.
// What changes with the outcome is the heading, which the caller supplies — see `FindingGuidance`,
// where "where to get to" over a pass would assert a gap the outcome beside it denies.
//
// Nothing here is model-generated and nothing here needs a model to render. The advisor plan
// sequences and tailors this material when AI is switched on, and a deployment with it switched off
// shows the same six sections in the same order — which is the difference between guidance and a
// prompt.

import { Disclosure } from './ui/Disclosure';
import { Fact, FactList, Surface } from './system';
import type { GuidanceAdvice } from '../api/types';

export function GuidanceAdvicePanel({
  advice,
  label,
  flush,
}: {
  readonly advice: GuidanceAdvice;
  readonly label: string;
  /** Set where the advice is already inside a padded task surface. */
  readonly flush?: boolean;
}) {
  return (
    <Surface tone={flush ? 'plain' : 'raised'} title={label} headingLevel={3}>
      {/* The body carries its own rhythm rather than leaning on the section's, because `flush` drops
          the padding and the spacing together and this panel only wants the padding gone. */}
      <div className="space-y-1.5">
        <p className="wa-body-compact text-wa-text">{advice.startFrom}</p>

        {/* The staged route is above the fold and the rest is not. A reader who has just been told
          their estate does not do this needs somewhere to stand between here and the target more
          than they need the trade-offs, and the first stage is usually "find out what you actually
          do", which is the step people skip.

          Headed neutrally, because this renders over a pass as well: "getting there" beside an
            outcome that says they are already there is the panel contradicting the finding above it. */}
        <div>
          <p className="wa-label">The staged route</p>
          <ol className="wa-body-compact list-decimal space-y-0.5 pl-4 text-wa-text-secondary">
            {advice.path.map((stage) => (
              <li key={stage}>{stage}</li>
            ))}
          </ol>
        </div>

        <Disclosure summary="What changes it, what it costs, and when to look again">
          <div>
            <p className="wa-label">What changes the recommendation</p>
            <ul className="wa-body-compact list-disc space-y-0.5 pl-4 text-wa-text-secondary">
              {advice.dependsOn.map((factor) => (
                <li key={factor}>{factor}</li>
              ))}
            </ul>
          </div>

          {/* Its own heading rather than a sentence inside the recommendation. A cost folded into the
              advice reads as a caveat on it; a cost with a heading is something the reader weighs. */}
          <div>
            <p className="wa-label">What it costs</p>
            <ul className="wa-body-compact list-disc space-y-0.5 pl-4 text-wa-text-secondary">
              {advice.costs.map((cost) => (
                <li key={cost}>{cost}</li>
              ))}
            </ul>
          </div>

          <FactList>
            <Fact label="Keep, as evidence" value={advice.retain} emphasis="quiet" />
            <Fact label="Look at this again when" value={advice.revisit} emphasis="quiet" />
          </FactList>
        </Disclosure>
      </div>
    </Surface>
  );
}
