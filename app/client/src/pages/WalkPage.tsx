// A guided pass through the questions, one principle at a time.
//
// The Answers page beside this one is a filterable list sorted worst-first, which is the right shape
// for a renewal — you go to the four answers that lapsed and you fix them. It is the wrong shape for
// a first pass, and sixty-three questions is what a first pass is. Sorted by state and severity, the
// list interleaves every pillar, so a reader working down it answers a security question, then a cost
// question, then a reliability one, rebuilding the context each time.
//
// This page asks them in the framework's own order instead: pillar, then principle, then the
// catalogue's sequence within it. "Design for failure" is four questions about the same idea, and
// the reader who has just thought about the first is the cheapest possible person to ask the fourth.
//
// Resuming needs no session record, because the answers are already durable and dated. The pass
// resumes at the first question whose answer does not still count, which is a property a stored
// cursor cannot have: it is right after somebody else answers three of them from the other page, and
// it is right again next year when the answers expire. See walk.ts, and ADR 0036.

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@databricks/appkit-ui/react';
import { AlertTriangle, ArrowLeft, ArrowRight, List, SkipForward } from 'lucide-react';
import { useAssessment } from '../api/assessment-context';
import { useAttestations, useSubmitAnswer } from '../api/hooks';
import { ContentsRow } from '../components/ContentsRow';
import { QuestionPane } from '../components/QuestionPane';
import { CustomerPage, Surface, TaskWorkspace } from '../components/system';
import { EmptyState } from '../components/ui/EmptyState';
import {
  EVERYTHING,
  isSettled,
  nextOutstandingAfter,
  planWalk,
  positionOf,
  resumeAt,
  stepFrom,
} from '../components/walk';
import type { AttestableRequirement } from '../api/types';

const EMPTY: readonly AttestableRequirement[] = [];

/** The list, keeping this pass's scope so leaving mid-pass does not also widen it. */
function listTo(scope: string): string {
  return scope === EVERYTHING ? '/answers' : `/answers?pillar=${encodeURIComponent(scope)}`;
}

export function WalkPage() {
  const { catalogue, pillarTitle } = useAssessment();
  const [params, setParams] = useSearchParams();
  const answers = useAttestations();
  const submission = useSubmitAnswer(answers.reload);

  const scope = params.get('pillar') ?? EVERYTHING;
  const asked = params.get('control');

  /*
   * Questions left for somebody else, held for this visit only.
   *
   * Deliberately not persisted. A skip is "not me, not now" — it is about the person at the keyboard,
   * not about the estate — and writing it to the store would make one reader's deferral look like a
   * property of the assessment to the next one. What it must not do is send the reader back to the
   * same question every time they answer another, which is what a purely derived resume point does.
   * The durable version of this is a handover, and that is row 11b with a session record behind it.
   */
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());

  const requirements = useMemo(() => answers.data?.requirements ?? EMPTY, [answers.data?.requirements]);

  // The catalogue's own sequence, which is the only place the intended order of the questions exists.
  const order = useMemo(
    () =>
      (catalogue?.pillars ?? []).flatMap((pillar) =>
        pillar.principles.flatMap((principle) => principle.controls.map((control) => control.id))
      ),
    [catalogue?.pillars]
  );

  const walk = useMemo(() => planWalk(requirements, scope, order), [requirements, scope, order]);

  const pillars = useMemo(() => [...new Set(requirements.map((one) => one.pillarId))].sort(), [requirements]);

  const principleTitle = useMemo(() => {
    const titles = new Map<string, string>();
    for (const pillar of catalogue?.pillars ?? []) {
      for (const principle of pillar.principles) titles.set(principle.id, unnumbered(principle.title));
    }
    return (id: string) => titles.get(id) ?? id;
  }, [catalogue?.pillars]);

  const resume = resumeAt(walk, skipped);
  // The question on screen. A `control` in the URL wins so the pass is linkable and the back button
  // works; without one the pass resumes, which is what arriving fresh means.
  const current = walk.order.find((one) => one.controlId === asked) ?? resume;
  const position = positionOf(walk, current?.controlId);

  const go = (controlId: string | undefined) => {
    const next = new URLSearchParams(params);
    if (controlId == null) next.delete('control');
    else next.set('control', controlId);
    setParams(next, { replace: true });
  };

  const rescope = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === EVERYTHING) next.delete('pillar');
    else next.set('pillar', value);
    // The question on screen belongs to the old scope. Dropping it lets the new scope resume.
    next.delete('control');
    setParams(next, { replace: true });
  };

  /*
   * The URL catches up with the question on screen, once the answers have arrived.
   *
   * Without this the address bar says `/answers/walk` while the pane shows question thirteen, so
   * copying the URL to hand the pass over sends the next reader back to wherever *their* answers
   * resume — which is a different question. Replaced rather than pushed: the resume is not a
   * navigation the reader made, and a back button that returns to the same page is a trap.
   *
   * The condition is "the URL disagrees with the pane", not "the URL is empty", and the difference is
   * a real case rather than defensiveness: a link to a question in the security pillar opened with
   * `?pillar=cost` names a control this pass does not contain, so the pane falls back to the resume
   * while the address bar still carries the control it could not honour. Handing that URL on would
   * pass the same disagreement to the next reader.
   */
  useEffect(() => {
    if (current != null && asked !== current.controlId) go(current.controlId);
    // `go` closes over `params`, and depending on it would re-run this on every parameter change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, current?.controlId]);

  const previous = stepFrom(walk, current?.controlId, -1);
  const next = stepFrom(walk, current?.controlId, 1);
  const outstanding = walk.total - walk.settled;

  if (answers.error != null) {
    return (
      <CustomerPage>
        <Surface tone="task">
          <EmptyState
            reason="collector-failed"
            heading="The questions could not be read"
            detail={answers.error}
            action={
              <button type="button" className="wa-button-secondary" onClick={answers.reload}>
                Try again
              </button>
            }
          />
        </Surface>
      </CustomerPage>
    );
  }

  return (
    <CustomerPage>
      {answers.data != null && !answers.data.durable && (
        <div className="wa-notice-warning flex items-start gap-2" role="alert">
          <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-wa-warning" />
          <p className="wa-body-compact">
            Answers are being held in memory and will be lost when the app restarts.{' '}
            {answers.data.durabilityNote ?? 'Unset WAF_DEMO_NO_PERSISTENCE and restart to keep them.'}
          </p>
        </div>
      )}

      {/* Contents narrow and question wide, which is the opposite weighting to the Answers page and
          the right one here: there the list is the subject and the form is a side panel, and on a
          guided pass the question is the whole point. The contents column earns its place by showing
          how much is left — a pass with no visible end is a pass people abandon. */}
      <TaskWorkspace
        queueLabel="The questions in this pass"
        taskLabel="The question being answered"
        queue={
          <Surface
            tone="raised"
            label="The questions in this pass"
            title="This pass"
            action={
              <Link className="wa-button-secondary shrink-0" to={listTo(scope)}>
                <List aria-hidden className="h-4 w-4" />
                All answers
              </Link>
            }
          >
            {/* The count is deliberately not in this header. It was, alongside the link, and between
              them they left "This pass" reading as "This p…" in a 280px column — while saying the
              same thing as the sentence under the scope selector two lines below. */}
            <div className="border-b border-wa-divider p-2">
              <Select value={scope} onValueChange={rescope}>
                <SelectTrigger className="wa-select w-full" aria-label="Which pillar this pass covers">
                  <SelectValue placeholder="Every pillar" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={EVERYTHING}>Every pillar ({requirements.length})</SelectItem>
                  {pillars.map((value) => (
                    <SelectItem key={value} value={value}>
                      {pillarTitle(value)} ({requirements.filter((one) => one.pillarId === value).length})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Progress, and it is the reason this column exists — a pass with no visible end is a
                pass people abandon. Not `progressPhrase` from the Answers page: that counts a `due`
                answer as answered, because it still scores, and this pass deliberately stops on one.
                Two surfaces disagreeing about a number is worse than two sentences. */}
              <p className="wa-caption pt-1.5">
                {outstanding === 0
                  ? 'Every question in this pass has an answer that still counts.'
                  : /* The count of what is left is only worth stating alongside what is done. On a
                     first pass they are the same number, and "0 of 105 answered, 105 to go" spends a
                     line saying 105 twice. */
                    `${walk.settled === 0 ? `${walk.total} to answer` : `${walk.settled} of ${walk.total} answered, ${outstanding} to go`}${
                      skipped.size > 0 ? `, ${skipped.size} left for later` : ''
                    }.`}
              </p>
            </div>

            {answers.loading && walk.total === 0 ? (
              <EmptyState
                reason="not-yet-collected"
                heading="Reading the questions"
                detail="Fetching every requirement that needs a person to answer it."
              />
            ) : walk.total === 0 ? (
              <EmptyState
                reason="nothing-to-report"
                heading="Nothing to ask"
                detail="Every requirement in this scope can be measured from the platform, so none of them rests on a statement."
              />
            ) : (
              /* Deliberately unpaged: the contents list shows the whole pass so a reader can see how
                 much is left and jump to any question. */
              <ol>
                {walk.groups.map((group, index) => (
                  <li key={`${group.pillarId}:${group.principleId}`}>
                    {/* The pillar only where it changes. It was on every principle line — needed,
                      because "Monitoring" appears under more than one pillar — but repeating it
                      twenty-three times down a 280px column pushed every principle onto three lines
                      and buried the name that distinguishes them. Announced as a heading so the
                      grouping is structure rather than a visual grouping a screen reader misses. */}
                    {group.pillarId !== walk.groups[index - 1]?.pillarId && (
                      <h2 className="wa-label border-b border-wa-divider bg-wa-band px-2 py-1 text-wa-text-secondary">
                        {pillarTitle(group.pillarId)}
                      </h2>
                    )}
                    {/* Pillar then principle as levels two and three, which is what the nesting already
                      is visually. Headings rather than styled text because thirty of them are how
                      somebody reading by heading moves around a hundred-question pass, and the level
                      has to descend from the pillar or the outline claims the principle is its peer. */}
                    <h3 className="wa-caption border-b border-wa-divider px-2 py-1 font-normal">
                      {principleTitle(group.principleId)}{' '}
                      <span className="text-wa-text-muted">
                        · {group.settled}/{group.questions.length}
                      </span>
                    </h3>
                    <ul>
                      {group.questions.map((question) => (
                        <li key={question.controlId}>
                          <ContentsRow
                            question={question}
                            selected={question.controlId === current?.controlId}
                            deferred={skipped.has(question.controlId)}
                            onSelect={() => go(question.controlId)}
                          />
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            )}
          </Surface>
        }

        task={
          <Surface tone="task" label="The question being answered">
            {/* Loading before empty, in the same order as the column beside it. Requirements are empty
              until the fetch returns, so testing `total === 0` first told a reader arriving on a
              deep link that there was nothing to ask, next to a contents column that was still
              honestly saying it was reading the questions. */}
            {answers.loading && walk.total === 0 ? (
              <EmptyState
                reason="not-yet-collected"
                heading="Reading the questions"
                detail="Fetching every requirement that needs a person to answer it."
              />
            ) : walk.total === 0 ? (
              <EmptyState
                reason="nothing-to-report"
                heading="Nothing to ask"
                detail="Choose a different pillar, or answer the remaining questions from the Answers page."
              />
            ) : current == null ? (
              /* Every question in scope has a current answer. Not an empty state — it is the finished
               state, and reporting it as nothing to show would read as a defect. */
              <EmptyState
                reason="nothing-to-report"
                heading="This pass is complete"
                detail={`All ${walk.total} questions in this scope have an answer that still counts. Widen the scope to keep going, or come back when the first of them is due for review.`}
              />
            ) : (
              <QuestionPane
                key={current.controlId}
                requirement={current}
                pillar={pillarTitle(current.pillarId)}
                submission={submission}
                footer={
                  <Surface tone="inset" label="Question navigation" headingLevel={3}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="wa-caption">
                        {position == null
                          ? null
                          : `Question ${position.at} of ${walk.total} · ${principleTitle(position.group.principleId)}`}
                      </p>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className="wa-button-secondary"
                          disabled={previous == null}
                          onClick={() => go(previous?.controlId)}
                        >
                          <ArrowLeft aria-hidden className="h-4 w-4" />
                          Previous
                        </button>
                        {/* Skipping is offered only where there is something to skip to, and only for a
                          question that is actually outstanding — offering it on an answered question
                          would suggest the answer had been set aside. */}
                        {!isSettled(current) && (
                          <button
                            type="button"
                            className="wa-button-secondary"
                            onClick={() => {
                              const deferred = new Set([...skipped, current.controlId]);
                              setSkipped(deferred);
                              go(nextOutstandingAfter(walk, current.controlId, deferred)?.controlId);
                            }}
                          >
                            <SkipForward aria-hidden className="h-4 w-4" />
                            Leave for later
                          </button>
                        )}
                        <button
                          type="button"
                          className="wa-button-primary"
                          disabled={next == null}
                          onClick={() => go(next?.controlId)}
                        >
                          Next
                          <ArrowRight aria-hidden className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </Surface>
                }
              />
            )}
          </Surface>
        }
      />
    </CustomerPage>
  );
}

/**
 * A principle's name without the catalogue's ordinal.
 *
 * Databricks numbers its principles in their published titles ("1. Design for failure"). Here the
 * number would read as a step count — "1. Design for failure" as the third group of a pass is
 * actively misleading about where the reader is, which the header beside it already answers.
 */
function unnumbered(title: string): string {
  return title.replace(/^\s*\d+[.)]\s*/, '');
}
