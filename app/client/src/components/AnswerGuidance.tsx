// What a person needs in order to answer one question honestly.
//
// "Standardize DevOps processes (CI/CD): is this practice in place?" is not answerable as written,
// because it does not say which standard is being held up. The catalogue gives the title and the
// question and nothing else, so an answer to it is a guess with a timestamp on it — and a guess that
// becomes a score is worse than an unanswered requirement, which at least reports as unanswered.
//
// So this pane carries the authored guidance beside the form: what the practice means, why it matters
// as the risk of not doing it, the rubric an answer is measured against, when "partially" is the true
// answer, and — behind a disclosure — three worked examples, where to look, and the ways it is
// commonly got wrong. See server/guidance/guidance.ts for the content model.
//
// Above the form and not behind a tab. The reader's decision is what to type, and guidance they have
// to navigate away from the field to read is guidance they will answer without.

import { useGuidance } from '../api/hooks';
import { GuidanceAdvicePanel } from './GuidanceAdvicePanel';
import { Disclosure } from './ui/Disclosure';
import { Fact, FactList, Surface } from './system';
import type { Guidance, GuidanceCheckKind } from '../api/types';

/** How to check, in the reader's terms rather than the schema's. */
const HOW: Readonly<Record<GuidanceCheckKind, string>> = {
  ui: 'In the workspace',
  sql: 'By query',
  cli: 'From the CLI',
  api: 'Through the API',
  'by-hand': 'By asking',
};

export function AnswerGuidance({ controlId }: { controlId: string }) {
  const asked = useGuidance(controlId);

  // Nothing while it loads. It is a few hundred words from a file the server already has in memory,
  // so the wait is a frame or two, and a skeleton that appears and vanishes above a form is worse
  // than a pane that fills in.
  if (asked.loading) return null;

  if (asked.error != null) {
    return (
      <Surface tone="inset" title="How to answer this" headingLevel={3}>
        <p className="wa-caption">
          The answering guidance could not be read. {asked.error} The question is still answerable from what you can
          evidence.
        </p>
      </Surface>
    );
  }

  // Nothing, deliberately, for a question nobody has written up yet. Most of the catalogue is in
  // that state and will be for a while, and a notice saying so on ninety panes out of a hundred
  // would be this project reporting its own backlog inside somebody else's assessment.
  const guidance = asked.data?.status === 'authored' ? asked.data.guidance : undefined;
  if (guidance == null) return null;

  return <GuidancePanel guidance={guidance} />;
}

/**
 * The guidance itself, separated from the fetch.
 *
 * Split so the layout can be asserted. The wrapper's states — loading, absent, unreadable — are
 * three early returns and a fetch; the part with the reasoning in it is everything below, and a test
 * that had to mock a network call to reach it would be a test of the mock.
 */
export function GuidancePanel({ guidance }: { guidance: Guidance }) {
  return (
    <Surface
      tone="inset"
      title="How to answer this"
      description={guidance.lastReviewed != null ? `Reviewed ${reviewed(guidance.lastReviewed)}` : undefined}
      headingLevel={3}
    >
      <p className="wa-body-compact text-wa-text">{guidance.means}</p>
      <p className="wa-body-compact text-wa-text-secondary">{guidance.matters}</p>

      {guidance.good.length > 0 && (
        <div>
          <p className="wa-label">What good looks like</p>
          <ul className="wa-body-compact list-disc space-y-0.5 pl-4 text-wa-text-secondary">
            {guidance.good.map((signal) => (
              <li key={signal}>{signal}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Given its own field rather than folded into the rubric, because "partially" is one of the
          four answers on the form below and it is the one a reader talks themselves out of. A
          question with no stated middle produces a set of answers that are all "yes". */}
      {(guidance.partialWhen !== '' || guidance.notApplicableWhen != null) && (
        <FactList>
          {guidance.partialWhen !== '' && (
            <Fact label={'When "partially" is the true answer'} value={guidance.partialWhen} emphasis="quiet" />
          )}
          {guidance.notApplicableWhen != null && (
            <Fact label="When it does not apply" value={guidance.notApplicableWhen} emphasis="quiet" />
          )}
        </FactList>
      )}

      {/* The rest behind one disclosure. Everything in it is worth reading and none of it is worth
          pushing the form off the screen for: a reader who knows the practice needs the rubric and
          nothing else, and a reader who does not can open this before they type. */}
      <Disclosure summary="Worked examples, where to check, and what people get wrong">
        <Example label="A strong answer">{guidance.examples.strong}</Example>
        <Example label="A partial answer">{guidance.examples.partial}</Example>
        <Example label="A weak answer">{guidance.examples.weak}</Example>

        {guidance.verify.length > 0 && (
          <div>
            <p className="wa-label">Where to check</p>
            <ul className="space-y-1.5">
              {guidance.verify.map((check) => (
                <li key={`${check.how}:${check.where}`}>
                  <span className="text-wa-text">{HOW[check.how]}:</span>{' '}
                  {/* A statement is set as code and everything else as prose. Reflowed as a sentence, a
                      query with a CTE in it reads as one long line a reader can neither scan nor copy,
                      and these are written to be run rather than read about. */}
                  {check.how === 'sql' ? (
                    <pre className="wa-code-block mt-1 rounded-sm bg-wa-surface-subtle">{check.where}</pre>
                  ) : (
                    check.where
                  )}
                  {/* After a code block the expectation begins a line of its own, so it is sentenced as
                      one. Inline after prose it continues the sentence, so it is not. */}
                  {check.expect != null &&
                    (check.how === 'sql' ? (
                      <p className="wa-caption">Expect {check.expect}</p>
                    ) : (
                      <span className="wa-caption"> — expect {check.expect}</span>
                    ))}
                  {/* On its own line, not appended to the expectation. A caveat exists because a clean
                      result from this check would otherwise be read as a good one, so it has to survive
                      being skimmed — which the tail of a long sentence does not. */}
                  {check.caveat != null && <p className="wa-caption pl-3 text-wa-text-muted">But: {check.caveat}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {guidance.pitfalls.length > 0 && (
          <div>
            <p className="wa-label">Commonly got wrong</p>
            <ul className="list-disc space-y-0.5 pl-4">
              {guidance.pitfalls.map((pitfall) => (
                <li key={pitfall}>{pitfall}</li>
              ))}
            </ul>
          </div>
        )}

        {guidance.ownerRole != null && <p className="wa-caption">Usually answered by: {guidance.ownerRole}.</p>}

        {/* Below the answering material and inside the same disclosure, because the reader's task on
            this pane is to answer honestly and not to improve anything yet. It is here at all because
            a person who has just decided their answer is "partially" is the person most likely to
            want to know what the target was. */}
        {guidance.advice != null && (
          <GuidanceAdvicePanel advice={guidance.advice} label="If you want to change the answer" flush />
        )}

        {guidance.references.length > 0 && (
          <div>
            <p className="wa-label">Read further</p>
            <ul className="space-y-0.5">
              {guidance.references.map((reference) => (
                <li key={reference}>
                  <a className="text-wa-action hover:underline" href={reference} target="_blank" rel="noreferrer">
                    {label(reference)}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Disclosure>
    </Surface>
  );
}

function Example({ label: name, children }: { label: string; children: string }) {
  return (
    <div>
      <p className="wa-label">{name}</p>
      <blockquote className="border-l-2 border-wa-divider pl-2">{children}</blockquote>
    </div>
  );
}

/**
 * A reference as its page rather than as its URL.
 *
 * The full URL is the honest label and it is also 90 characters of docs path in a 380px pane. The
 * host plus the last segment is enough for a reader to know whether they have read it, and the link
 * still goes where it says.
 */
function label(reference: string): string {
  try {
    const url = new URL(reference);
    // `index.html` names the directory it sits in, so the segment before it is the page. Docs URLs
    // end that way often enough that taking the last segment blindly labels three links "index.html".
    const segments = url.pathname.split('/').filter((part) => part !== '' && !/^index\.\w+$/.test(part));
    const last = segments.at(-1);
    return last == null ? url.host : `${url.host} — ${last.replace(/[-_]/g, ' ').replace(/\.\w+$/, '')}`;
  } catch {
    return reference;
  }
}

/** The review date as a date, not a timestamp. Guidance is reviewed by the day. */
function reviewed(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  return when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
