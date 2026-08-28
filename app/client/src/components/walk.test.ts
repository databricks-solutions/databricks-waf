// The ordering and the resume point, which are the two things a rendered test cannot check.
//
// Every case here is one somebody would only find by walking sixty-three questions by hand: a
// principle whose questions are out of catalogue order, a pass resumed after twelve answers, an
// answer that expired since the last pass, and the question deliberately left for a colleague.

import { describe, expect, it } from 'vitest';
import { EVERYTHING, isSettled, nextOutstandingAfter, planWalk, positionOf, resumeAt, stepFrom } from './walk';
import type { Attestation, AttestableRequirement, AttestationState } from '../api/types';

const question = (
  controlId: string,
  pillarId: string,
  principleId: string,
  state?: AttestationState
): AttestableRequirement => ({
  controlId,
  pillarId,
  principleId,
  title: `Title for ${controlId}`,
  severity: 'high',
  askedBecause: 'no-telemetry',
  question: `Question for ${controlId}?`,
  cadenceDays: 365,
  ...(state == null ? {} : { attestation: answer(controlId, state) }),
});

const answer = (controlId: string, state: AttestationState): Attestation => ({
  id: `att-${controlId}`,
  controlId,
  answer: 'met',
  statement: 'A statement long enough to satisfy the rule.',
  owner: 'platform-engineering',
  attestedBy: 'ada@example.com',
  attestedAt: '2026-01-01T00:00:00.000Z',
  reviewBy: '2026-07-01T00:00:00.000Z',
  state,
});

// Reliability first, then operational excellence, with the second principle of reliability
// deliberately listed before the ids would sort — which is what makes this a test of the order
// rather than of `localeCompare`.
const ORDER = ['REL-01-02', 'REL-01-10', 'REL-01-03', 'REL-04-01', 'OE-01-01', 'OE-01-02'];

const REQUIREMENTS: readonly AttestableRequirement[] = [
  question('OE-01-02', 'operational-excellence', 'oe-01'),
  question('REL-01-03', 'reliability', 'rel-01'),
  question('REL-04-01', 'reliability', 'rel-04'),
  question('REL-01-02', 'reliability', 'rel-01'),
  question('OE-01-01', 'operational-excellence', 'oe-01'),
  question('REL-01-10', 'reliability', 'rel-01'),
];

describe('the order a pass asks its questions in', () => {
  it('groups by principle and follows the catalogue inside each group', () => {
    const walk = planWalk(REQUIREMENTS, EVERYTHING, ORDER);

    expect(walk.groups.map((group) => group.principleId)).toEqual(['rel-01', 'rel-04', 'oe-01']);
    expect(walk.order.map((one) => one.controlId)).toEqual(ORDER);
  });

  it('orders the groups by where they start, not by principle id', () => {
    // `rel-04` sorts after `rel-01` and before `oe-01` lexically, which is the right answer here by
    // coincidence. Reversing the catalogue proves the order comes from the catalogue.
    const walk = planWalk(REQUIREMENTS, EVERYTHING, [...ORDER].reverse());

    expect(walk.groups.map((group) => group.principleId)).toEqual(['oe-01', 'rel-04', 'rel-01']);
  });

  it('does not fall back to sorting ids, which is wrong wherever a number is unpadded', () => {
    // REL-01-10 before REL-01-03 in the catalogue. A lexical sort puts `03` first and would look
    // correct on every id whose numbers happen to line up.
    const walk = planWalk(REQUIREMENTS, 'reliability', ORDER);

    expect(walk.order.map((one) => one.controlId)).toEqual(['REL-01-02', 'REL-01-10', 'REL-01-03', 'REL-04-01']);
  });

  it('still asks a question the catalogue has not mentioned', () => {
    // A requirement in the payload and absent from the catalogue order would be dropped by an
    // ordering that used the rank as a filter. It goes last, and it is still asked.
    const extra = question('REL-09-99', 'reliability', 'rel-09');
    const walk = planWalk([...REQUIREMENTS, extra], 'reliability', ORDER);

    expect(walk.order.map((one) => one.controlId)).toContain('REL-09-99');
    expect(walk.order.at(-1)?.controlId).toBe('REL-09-99');
  });

  it('narrows to one pillar when that is the scope', () => {
    const walk = planWalk(REQUIREMENTS, 'operational-excellence', ORDER);

    expect(walk.total).toBe(2);
    expect(walk.groups).toHaveLength(1);
  });
});

describe('what the pass counts as done', () => {
  it('counts a current answer and not an unanswered question', () => {
    expect(isSettled(question('REL-01-02', 'reliability', 'rel-01', 'current'))).toBe(true);
    expect(isSettled(question('REL-01-02', 'reliability', 'rel-01'))).toBe(false);
  });

  it('does not count an answer that is due, because that is what the pass is for', () => {
    // `due` still scores, so the Answers page shows it as distinct from expired. A pass that skipped
    // it would walk the reader past the answer that is about to stop counting.
    expect(isSettled(question('REL-01-02', 'reliability', 'rel-01', 'due'))).toBe(false);
    expect(isSettled(question('REL-01-02', 'reliability', 'rel-01', 'expired'))).toBe(false);
  });

  it('reports progress over the whole pass and per group', () => {
    const walk = planWalk(
      [
        question('REL-01-02', 'reliability', 'rel-01', 'current'),
        question('REL-01-10', 'reliability', 'rel-01', 'due'),
        question('REL-01-03', 'reliability', 'rel-01'),
        question('REL-04-01', 'reliability', 'rel-04', 'current'),
      ],
      'reliability',
      ORDER
    );

    expect(walk.settled).toBe(2);
    expect(walk.total).toBe(4);
    expect(walk.groups.map((group) => group.settled)).toEqual([1, 1]);
    expect(walk.counts).toEqual({ current: 2, due: 1, unanswered: 1, expired: 0 });
  });
});

describe('where the pass resumes', () => {
  it('lands on the first question whose answer does not still count', () => {
    const walk = planWalk(
      [
        question('REL-01-02', 'reliability', 'rel-01', 'current'),
        question('REL-01-10', 'reliability', 'rel-01', 'current'),
        question('REL-01-03', 'reliability', 'rel-01'),
        question('REL-04-01', 'reliability', 'rel-04'),
      ],
      'reliability',
      ORDER
    );

    expect(resumeAt(walk)?.controlId).toBe('REL-01-03');
  });

  it('goes back for an answer that expired since the last pass', () => {
    // The property a stored cursor cannot have. Nothing changed but the date, and the pass has to
    // notice — a cursor written last quarter points past this question.
    const walk = planWalk(
      [
        question('REL-01-02', 'reliability', 'rel-01', 'expired'),
        question('REL-01-10', 'reliability', 'rel-01', 'current'),
      ],
      'reliability',
      ORDER
    );

    expect(resumeAt(walk)?.controlId).toBe('REL-01-02');
  });

  it('steps over a question left for a colleague', () => {
    const walk = planWalk(
      [question('REL-01-02', 'reliability', 'rel-01'), question('REL-01-10', 'reliability', 'rel-01')],
      'reliability',
      ORDER
    );

    expect(resumeAt(walk, new Set(['REL-01-02']))?.controlId).toBe('REL-01-10');
  });

  it('returns to the skipped questions once they are all that is left', () => {
    // Reporting the pass as finished here would be false, and landing nowhere would leave the reader
    // on an empty pane with outstanding questions.
    const walk = planWalk([question('REL-01-02', 'reliability', 'rel-01')], 'reliability', ORDER);

    expect(resumeAt(walk, new Set(['REL-01-02']))?.controlId).toBe('REL-01-02');
  });

  it('is undefined when every question in scope is settled', () => {
    const walk = planWalk([question('REL-01-02', 'reliability', 'rel-01', 'current')], 'reliability', ORDER);

    expect(resumeAt(walk)).toBeUndefined();
  });
});

describe('stepping through the pass', () => {
  const walk = planWalk(REQUIREMENTS, EVERYTHING, ORDER);

  it('crosses a principle boundary rather than stopping at it', () => {
    // The last question of `rel-01` is followed by the first of `rel-04`. A next button scoped to
    // the group would dead-end here and the reader would have to find the next group themselves.
    expect(stepFrom(walk, 'REL-01-03', 1)?.controlId).toBe('REL-04-01');
  });

  it('goes back as well as forward', () => {
    expect(stepFrom(walk, 'REL-04-01', -1)?.controlId).toBe('REL-01-03');
  });

  it('has nothing past either end', () => {
    expect(stepFrom(walk, 'OE-01-02', 1)).toBeUndefined();
    expect(stepFrom(walk, 'REL-01-02', -1)).toBeUndefined();
  });

  it('has nothing to step from for a question outside the scope', () => {
    expect(stepFrom(walk, 'SCP-01-01', 1)).toBeUndefined();
    expect(stepFrom(walk, undefined, 1)).toBeUndefined();
  });
});

describe('where leaving a question for later lands', () => {
  it('skips past the answers that already count', () => {
    // The bug this pins: advancing by one row landed on the next question whether or not it needed
    // answering, so leaving one question behind could put a settled one on screen.
    const walk = planWalk(
      [
        question('REL-01-02', 'reliability', 'rel-01'),
        question('REL-01-10', 'reliability', 'rel-01', 'current'),
        question('REL-01-03', 'reliability', 'rel-01'),
      ],
      'reliability',
      ORDER
    );

    expect(nextOutstandingAfter(walk, 'REL-01-02', new Set(['REL-01-02']))?.controlId).toBe('REL-01-03');
  });

  it('does not offer a question already left for later', () => {
    const walk = planWalk(
      [
        question('REL-01-02', 'reliability', 'rel-01'),
        question('REL-01-10', 'reliability', 'rel-01'),
        question('REL-01-03', 'reliability', 'rel-01'),
      ],
      'reliability',
      ORDER
    );

    const deferred = new Set(['REL-01-02', 'REL-01-10']);

    expect(nextOutstandingAfter(walk, 'REL-01-10', deferred)?.controlId).toBe('REL-01-03');
  });

  it('keeps the place the reader was at rather than restarting the pass', () => {
    // Searching from the top would answer `REL-01-02` here, which is the other half of the same bug:
    // a reader who opened question three from the contents and left it would be sent back to one.
    const walk = planWalk(
      [
        question('REL-01-02', 'reliability', 'rel-01'),
        question('REL-01-10', 'reliability', 'rel-01'),
        question('REL-01-03', 'reliability', 'rel-01'),
      ],
      'reliability',
      ORDER
    );

    expect(nextOutstandingAfter(walk, 'REL-01-10', new Set(['REL-01-10']))?.controlId).toBe('REL-01-03');
  });

  it('wraps to what is outstanding earlier once nothing is left ahead', () => {
    const walk = planWalk(
      [
        question('REL-01-02', 'reliability', 'rel-01'),
        question('REL-01-10', 'reliability', 'rel-01'),
        question('REL-01-03', 'reliability', 'rel-01', 'current'),
      ],
      'reliability',
      ORDER
    );

    expect(nextOutstandingAfter(walk, 'REL-01-10', new Set(['REL-01-10']))?.controlId).toBe('REL-01-02');
  });

  it('comes back to a deferred question rather than claiming the pass is done', () => {
    const walk = planWalk([question('REL-01-02', 'reliability', 'rel-01')], 'reliability', ORDER);

    expect(nextOutstandingAfter(walk, 'REL-01-02', new Set(['REL-01-02']))?.controlId).toBe('REL-01-02');
  });

  it('is undefined when the pass is finished', () => {
    const walk = planWalk([question('REL-01-02', 'reliability', 'rel-01', 'current')], 'reliability', ORDER);

    expect(nextOutstandingAfter(walk, 'REL-01-02')).toBeUndefined();
  });
});

describe('where the reader is', () => {
  const walk = planWalk(REQUIREMENTS, EVERYTHING, ORDER);

  it('counts over the whole pass and within the group', () => {
    const position = positionOf(walk, 'REL-04-01');

    expect(position?.at).toBe(4);
    expect(position?.inGroup).toBe(1);
    expect(position?.group.principleId).toBe('rel-04');
  });

  it('is undefined for a question the pass does not ask', () => {
    expect(positionOf(walk, 'SCP-01-01')).toBeUndefined();
    expect(positionOf(walk, undefined)).toBeUndefined();
  });
});
