// The authored guidance a finding can use, which is a different half of the entry from the question's.
//
// One corpus, two readers. `AnswerGuidance` shows the half that makes a question answerable — worked
// answers, when "partially" is true, the rubric an answer is measured against — and none of that
// means anything beside a finding the app worked out for itself. What a finding wants is the target
// state, how to reach it, at what cost, and when the decision reopens, which is the `advice` block,
// plus the two sentences that say what the practice is and why it matters.
//
// The advisor plan is explicit that there must not be a second LLM-only guidance corpus, so this
// reads the same file the question pane reads and the same gate holds both.

import { useGuidance } from '../api/hooks';
import { GuidanceAdvicePanel } from './GuidanceAdvicePanel';
import { Surface } from './system';
import type { Guidance, Outcome } from '../api/types';

/*
 * The heading the advice sits under, which the outcome decides.
 *
 * "Where to get to" over a passing finding asserts a gap the outcome one line above it denies, and
 * the reader believes the sentence over the badge. The advice itself is the same either way — the
 * target state, the cost of sustaining it, the event that reopens it — so what changes is only
 * whether it is being offered as a destination or as the thing already being held.
 */
const LABEL: Readonly<Record<Outcome, string>> = {
  pass: 'What holds this in place',
  fail: 'Where to get to',
  partial: 'Where to get to',
  unmeasurable: 'The recommended position',
  'not-applicable': 'The recommended position',
  'satisfied-by-architecture': 'What holds this in place',
};

export function FindingGuidance({ controlId, outcome }: { controlId: string; outcome: Outcome }) {
  const asked = useGuidance(controlId);

  // Nothing while it loads, and nothing if it fails. The finding above is complete without this and
  // an error notice under a result would read as something being wrong with the result.
  if (asked.loading || asked.error != null) return null;

  // The payload types `guidance` as optional independently of `status`, so both are checked rather
  // than one inferred from the other.
  const guidance = asked.data?.status === 'authored' ? asked.data.guidance : undefined;
  if (guidance == null) return null;

  return <FindingGuidancePanel guidance={guidance} outcome={outcome} />;
}

/** The rendering, separated from the fetch so the wording can be asserted without a server. */
export function FindingGuidancePanel({ guidance, outcome }: { guidance: Guidance; outcome: Outcome }) {
  return (
    <>
      <Surface tone="raised" title="What this is for" headingLevel={3}>
        <p className="wa-body-compact text-wa-text">{guidance.means}</p>
        <p className="wa-body-compact text-wa-text-secondary">{guidance.matters}</p>
      </Surface>

      {/* A requirement whose entry predates the advice contract shows the two sentences and stops,
          rather than a heading with nothing under it. Most of the corpus is in that state until 38c. */}
      {guidance.advice != null && <GuidanceAdvicePanel advice={guidance.advice} label={LABEL[outcome]} />}
    </>
  );
}
