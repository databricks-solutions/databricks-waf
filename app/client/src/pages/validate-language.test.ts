// The words, held to the three distinctions the surface exists to keep.
//
// Waiting is not failing, an attempt the app could not finish is not a near miss, and a window somebody
// asked for is a decision they have to defend rather than a date. Each of those is one sentence away
// from being lost, and the sentence is in here.

import { describe, expect, it } from 'vitest';
import type { ValidationAttempt } from '../api/types';
import {
  ATTEMPT_RESULTS,
  METHOD_LABEL,
  RESULT_DETAIL,
  RESULT_LABEL,
  RESULT_TONE,
  WAITING_LABEL,
  answeredPhrase,
  askedPhrase,
  attemptLabel,
  attemptStanding,
  claimedPhrase,
  momentOf,
  windowPhrase,
} from './validate-language';

const ATTEMPT: ValidationAttempt = {
  id: 'val-1',
  planId: 'plan-1',
  actionId: 'act-1',
  checks: [{ controlId: 'SEC-01', method: 'measured' }],
  claimedAt: '2026-04-09T09:00:00.000Z',
  requestedBy: 'ana@example.com',
  requestedAt: '2026-04-09T09:05:00.000Z',
  observeFrom: '2026-04-12T09:05:00.000Z',
  observeDays: 3,
};

describe('what an attempt is called', () => {
  it('calls one nothing has answered waiting, which is not one of the results', () => {
    expect(attemptLabel(ATTEMPT)).toBe(WAITING_LABEL);
    expect(ATTEMPT_RESULTS.map((result) => RESULT_LABEL[result])).not.toContain(WAITING_LABEL);
  });

  it('calls an answered one by its result', () => {
    const answered: ValidationAttempt = {
      ...ATTEMPT,
      answer: { result: 'passed', at: '2026-04-13T02:00:00.000Z', unmet: [], unreadable: [] },
    };

    expect(attemptLabel(answered)).toBe(RESULT_LABEL.passed);
  });

  it('colours a pass and a failure and does not colour what it could not tell as either', () => {
    expect(RESULT_TONE.passed).toBe('success');
    expect(RESULT_TONE.failed).toBe('danger');
    expect(RESULT_TONE.incomplete).toBe('warning');
  });

  it('says an attempt it could not finish is not a statement about the work', () => {
    expect(RESULT_DETAIL.incomplete).toContain('Nothing here says the work was not done');
  });
});

describe('where an outstanding attempt stands', () => {
  it('names the moment the window ends while it is still ahead', () => {
    const standing = attemptStanding(ATTEMPT, new Date('2026-04-10T12:00:00.000Z'));

    expect(standing).toContain('Waiting until');
    expect(standing).toContain('has not caught up');
  });

  it('says any run may answer it once the window has passed', () => {
    const standing = attemptStanding(ATTEMPT, new Date('2026-04-13T12:00:00.000Z'));

    expect(standing).toBe('Waiting on the next run. Any run that finishes from now on can answer this.');
  });

  it('says what the result means once there is one', () => {
    const failed: ValidationAttempt = {
      ...ATTEMPT,
      answer: { result: 'failed', at: '2026-04-13T02:00:00.000Z', unmet: ['SEC-01'], unreadable: [] },
    };

    expect(attemptStanding(failed, new Date())).toBe(RESULT_DETAIL.failed);
  });

  it('does not invent a date it could not read', () => {
    expect(attemptStanding({ ...ATTEMPT, observeFrom: 'not a date' }, new Date())).toBe('Waiting on the next run.');
  });
});

describe('the window', () => {
  it('is a phrase where one was asked for', () => {
    expect(windowPhrase(3)).toBe('3 days were allowed before any run could answer this.');
    expect(windowPhrase(1)).toContain('1 day ');
  });

  it('is nothing where there was none, rather than nought days', () => {
    expect(windowPhrase(0)).toBeUndefined();
  });
});

describe('the lines under an attempt', () => {
  it('names who asked and when', () => {
    expect(askedPhrase(ATTEMPT)).toContain('Asked by ana@example.com');
  });

  it('names the claim the evidence has to postdate', () => {
    expect(claimedPhrase(ATTEMPT)).toContain('Claimed done on');
  });

  it('names the run that answered, where a run did', () => {
    expect(answeredPhrase({ at: '2026-04-13T02:00:00.000Z', scanId: 'scan-9' })).toContain('by run scan-9');
  });

  it('says a claim taken back was closed rather than answered', () => {
    const phrase = answeredPhrase({ at: '2026-04-13T02:00:00.000Z' });

    expect(phrase).toContain('Closed on');
    expect(phrase).not.toContain('run');
  });

  it('shows a date it could not read as it arrived rather than as a plausible one', () => {
    expect(momentOf('not a date')).toBe('not a date');
  });
});

describe('how a requirement is answered', () => {
  it('says it in terms of who answers rather than in the record’s own word', () => {
    expect(METHOD_LABEL.measured).toBe('the app reads it');
    expect(METHOD_LABEL.attested).toBe('somebody answers it');
  });
});
