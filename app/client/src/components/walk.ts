// The order a guided pass asks its questions in, and where it resumes.
//
// Separate from the page for the reason the other arithmetic modules here are: this is the part that
// can be wrong without looking wrong. An off-by-one in the resume point sends a reader who has
// answered twelve questions back to the first one, and a component test that renders a list cannot
// tell you that the thirteenth was the right place to land.
//
// The ordering here is deliberately not the Answers page's ordering, and that is the whole reason
// this exists. That page sorts by state and then severity, which is triage order — the right answer
// to "what needs attention". A first pass is a different job: sixty-three questions read in
// catalogue order within their principle, so the context built reading the first question of
// "Design for failure" is still loaded when the fourth one is asked. Sorting a walk by severity
// would interleave four pillars and make the reader rebuild context on every question.

import type { AttestableRequirement } from '../api/types';
import { stateOf, type RequirementState } from '../pages/attest-language';

/** All seven pillars, as the scope value in the URL. A pillar id is the alternative. */
export const EVERYTHING = 'all';

/**
 * A principle and the questions in it, in catalogue order.
 *
 * `title` is absent when the catalogue has not arrived yet: the requirements come from
 * `/api/attestations` and the principle titles from `/api/catalogue`, so a group can exist before
 * it has a name. Rendering the id in that gap is better than holding the whole walk back.
 */
export interface WalkGroup {
  readonly pillarId: string;
  readonly principleId: string;
  readonly questions: readonly AttestableRequirement[];
  /** How many of this group's questions have an answer that still counts. */
  readonly settled: number;
}

export interface Walk {
  readonly groups: readonly WalkGroup[];
  /** Every question in scope, in the order the walk asks them. */
  readonly order: readonly AttestableRequirement[];
  readonly total: number;
  /** Answered and not yet due for review. The walk's own definition of done. */
  readonly settled: number;
  readonly counts: Readonly<Record<RequirementState, number>>;
}

/**
 * A question is done for the purposes of the walk when its answer still counts.
 *
 * `due` is deliberately not done. An answer inside its review window still scores, so the Answers
 * page is right to distinguish it from an expired one — but a pass whose point is to bring the set
 * up to date should stop on it, because it is the question whose answer is about to stop counting.
 * Treating `due` as settled would walk a reader past the exact questions they opened the pass for.
 */
export function isSettled(requirement: AttestableRequirement): boolean {
  return stateOf(requirement) === 'current';
}

/**
 * The questions in scope, grouped by principle, in catalogue order.
 *
 * `catalogueOrder` is the control ids as the catalogue lists them, which is the only place the
 * intended sequence exists — control ids sort lexically into something close to it and not equal to
 * it, because `PE-03-14` sorts before `PE-03-07` nowhere but is only correct by accident when the
 * numbers happen to be padded. Anything the catalogue does not mention keeps its relative order at
 * the end, so a requirement added to the payload before the catalogue knows about it is still asked.
 */
export function planWalk(
  requirements: readonly AttestableRequirement[],
  scope: string,
  catalogueOrder: readonly string[]
): Walk {
  const rank = new Map(catalogueOrder.map((id, index) => [id, index]));
  const at = (requirement: AttestableRequirement) => rank.get(requirement.controlId) ?? Number.MAX_SAFE_INTEGER;

  const inScope = requirements.filter((one) => scope === EVERYTHING || one.pillarId === scope);

  // Grouped by principle, and the groups themselves ordered by their first question rather than by
  // principle id. The catalogue's order is the document's order, and a principle's id says nothing
  // about where it appears in its pillar.
  const byPrinciple = new Map<string, AttestableRequirement[]>();
  for (const requirement of inScope) {
    const key = `${requirement.pillarId}\u0000${requirement.principleId}`;
    const existing = byPrinciple.get(key);
    if (existing == null) byPrinciple.set(key, [requirement]);
    else existing.push(requirement);
  }

  const groups = [...byPrinciple.entries()]
    .map(([key, questions]) => {
      const sorted = [...questions].sort((a, b) => at(a) - at(b) || a.controlId.localeCompare(b.controlId));
      const [pillarId = '', principleId = ''] = key.split('\u0000');
      return {
        pillarId,
        principleId,
        questions: sorted,
        settled: sorted.filter(isSettled).length,
      };
    })
    .sort((a, b) => first(a, at) - first(b, at));

  const order = groups.flatMap((group) => group.questions);

  const counts: Record<RequirementState, number> = { unanswered: 0, expired: 0, due: 0, current: 0 };
  for (const requirement of order) counts[stateOf(requirement)] += 1;

  return {
    groups,
    order,
    total: order.length,
    settled: order.filter(isSettled).length,
    counts,
  };
}

function first(group: WalkGroup, at: (one: AttestableRequirement) => number): number {
  return Math.min(...group.questions.map(at));
}

/**
 * Where the pass resumes: the first question in order whose answer does not still count.
 *
 * Derived rather than remembered, and that is the design rather than a shortcut. A stored cursor is
 * a second record of something the answers already say, and the two can disagree — answer a question
 * from the Answers page and a stored cursor still points at it; let an answer expire and a stored
 * cursor has walked past it. Deriving it from the durable answers means resuming cannot be stale,
 * and it makes a pass resumable across people and machines without a session record: the reader who
 * picks the work up tomorrow lands where the work actually is, not where somebody's browser was.
 *
 * `skipped` is the one thing that cannot be derived, because deliberately leaving a question for a
 * colleague is a decision and not a state of the answer. Passing them here keeps that decision out
 * of this function's own idea of done — a skipped question is stepped over when resuming and still
 * counted as outstanding.
 *
 * Undefined when every question in scope is settled, which the caller renders as a finished pass.
 */
export function resumeAt(walk: Walk, skipped: ReadonlySet<string> = new Set()): AttestableRequirement | undefined {
  return (
    walk.order.find((one) => !isSettled(one) && !skipped.has(one.controlId)) ??
    // Everything outstanding was skipped. Landing on the first of those is better than reporting the
    // pass as finished, which would be false, and better than landing nowhere.
    walk.order.find((one) => !isSettled(one))
  );
}

/**
 * Where to land after deliberately leaving a question: the next one still worth stopping on.
 *
 * Distinct from both of its neighbours here, and the reason is worth stating because either would
 * look like it would do. `stepFrom(+1)` is the literal next row, so leaving a question can land on
 * one that is already answered or one the reader has just set aside — which reads as the button not
 * working. `resumeAt` searches from the top, so leaving question forty lands on question three and
 * the pass appears to have thrown away the reader's place.
 *
 * So: forward from here first, then wrap to anything outstanding before here, and only then
 * `resumeAt`'s own last resort of a skipped question, because reporting a pass as finished when it
 * is not would be worse than revisiting one.
 */
export function nextOutstandingAfter(
  walk: Walk,
  controlId: string | undefined,
  skipped: ReadonlySet<string> = new Set()
): AttestableRequirement | undefined {
  const at = controlId == null ? -1 : walk.order.findIndex((one) => one.controlId === controlId);
  const worthStopping = (one: AttestableRequirement): boolean => !isSettled(one) && !skipped.has(one.controlId);

  return walk.order.slice(at + 1).find(worthStopping) ?? walk.order.find(worthStopping) ?? resumeAt(walk, skipped);
}

/** The question after this one, for the control that advances the pass. */
export function stepFrom(walk: Walk, controlId: string | undefined, by: 1 | -1): AttestableRequirement | undefined {
  if (controlId == null) return undefined;
  const at = walk.order.findIndex((one) => one.controlId === controlId);
  if (at < 0) return undefined;
  return walk.order[at + by];
}

/**
 * Which group a question is in, and where it sits in the pass.
 *
 * Returned together because the header shows all three — "question 4 of 12, Design for failure" —
 * and computing them separately means three scans of the same array.
 */
export interface WalkPosition {
  readonly group: WalkGroup;
  /** One-based, over the whole pass rather than the group, which is what progress means here. */
  readonly at: number;
  readonly inGroup: number;
}

export function positionOf(walk: Walk, controlId: string | undefined): WalkPosition | undefined {
  if (controlId == null) return undefined;
  const at = walk.order.findIndex((one) => one.controlId === controlId);
  if (at < 0) return undefined;
  const group = walk.groups.find((one) => one.questions.some((q) => q.controlId === controlId));
  if (group == null) return undefined;
  return {
    group,
    at: at + 1,
    inGroup: group.questions.findIndex((one) => one.controlId === controlId) + 1,
  };
}
