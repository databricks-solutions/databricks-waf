import { describe, expect, it } from 'vitest';
import {
  ATTENTION_LABEL,
  KIND_LABEL,
  automaticPhrase,
  attentionCountPhrase,
  citedPhrase,
  confirmNotice,
  finalisedPhrase,
  finalDecisionNotice,
  openedPhrase,
  pillarCaption,
  progressPhrase,
  recordedPhrase,
  reviewPillarCount,
  reusedPhrase,
  skipNotice,
  waitingPhrase,
} from './review-language';
import type { AssessmentResult, AssessmentReview, PillarReview } from '../api/types';

const CONFIRMED: PillarReview = {
  id: 'p1',
  reviewId: 'r1',
  runId: 'run-1',
  pillarId: 'reliability',
  kind: 'confirmed',
  attestationIds: ['a1', 'a2'],
  by: 'admin@example.com',
  at: '2026-08-02T00:00:00.000Z',
};

const SKIPPED: PillarReview = {
  id: 'p2',
  reviewId: 'r1',
  runId: 'run-1',
  pillarId: 'reliability',
  kind: 'skipped',
  by: 'admin@example.com',
  at: '2026-08-02T00:00:00.000Z',
};

const REVIEW: AssessmentReview = {
  id: 'r1',
  runId: 'run-1',
  openedBy: 'admin@example.com',
  openedAt: '2026-08-01T00:00:00.000Z',
  pillars: [CONFIRMED],
  answers: [],
  durable: true,
};

describe('kind labels', () => {
  it('calls a skip skipped, not reviewed', () => {
    expect(KIND_LABEL.skipped).toBe('Skipped');
    expect(KIND_LABEL.skipped.toLowerCase()).not.toContain('review');
    expect(KIND_LABEL.confirmed).toBe('Confirmed');
  });
});

describe('attention labels', () => {
  it('names the four reasons the fields support, and not changed or event-triggered', () => {
    expect(ATTENTION_LABEL.unanswered).toBe('Not yet answered');
    expect(ATTENTION_LABEL.expired).toBe('Lapsed');
    expect(ATTENTION_LABEL.due).toBe('Due for review');
    expect(ATTENTION_LABEL.inconclusive).toBe('Scan could not tell');
    expect(Object.keys(ATTENTION_LABEL)).not.toContain('changed');
    expect(Object.keys(ATTENTION_LABEL)).not.toContain('event-triggered');
  });
});

describe('captions', () => {
  it('shows the kind once a record exists, even when questions still need attention', () => {
    // Confirm-current does not answer the outstanding ones. The caption restates the record, not a
    // claim that the pillar is finished as a questionnaire.
    expect(pillarCaption(CONFIRMED, 4)).toBe('Confirmed');
    expect(pillarCaption(SKIPPED, 4)).toBe('Skipped');
  });

  it('counts what still needs attention when nothing has been recorded', () => {
    expect(pillarCaption(undefined, 0)).toBe('None need attention');
    expect(pillarCaption(undefined, 1)).toBe('1 needs attention');
    expect(pillarCaption(undefined, 3)).toBe('3 need attention');
  });
});

describe('a recorded pillar', () => {
  it('attributes a skip without calling it a review', () => {
    const sentence = recordedPhrase(SKIPPED);
    expect(sentence).toMatch(/^Skipped by admin@example.com on /);
    expect(sentence.toLowerCase()).not.toContain('review');
    expect(sentence.toLowerCase()).not.toContain('answered');
  });

  it('attributes a confirm and restates how many accepted answers it froze', () => {
    expect(recordedPhrase(CONFIRMED)).toMatch(/^Confirmed by admin@example.com on /);
    expect(recordedPhrase(CONFIRMED)).toContain('freezing 2 accepted answers');
  });

  it('does not invent a count when the confirm cited none', () => {
    expect(recordedPhrase({ ...CONFIRMED, attestationIds: [] })).toMatch(/^Confirmed by admin@example.com on /);
    expect(recordedPhrase({ ...CONFIRMED, attestationIds: [] })).not.toContain('citing');
  });
});

describe('progress', () => {
  it('restates the recorded count against the catalogue count', () => {
    expect(progressPhrase(0, 7)).toBe('0 of 7 pillars have a record.');
    expect(progressPhrase(7, 7)).toBe('Every selected pillar has a record (7).');
  });
});

describe('waiting', () => {
  it('does not pick a run when several are open', () => {
    const second: AssessmentReview = { ...REVIEW, id: 'r2', pillars: [] };
    expect(waitingPhrase([REVIEW, second], 7)).toBe('2 runs are waiting to be reviewed.');
  });

  it('restates how far the one open review has got', () => {
    expect(waitingPhrase([REVIEW], 7)).toBe('A run is waiting: 1 of 7 pillars have a record.');
  });

  it('uses the review selected set for its denominator and the catalogue only for legacy reviews', () => {
    expect(reviewPillarCount({ ...REVIEW, selectedPillars: ['reliability'] }, 7)).toBe(1);
    expect(reviewPillarCount(REVIEW, 7)).toBe(7);
    expect(waitingPhrase([{ ...REVIEW, pillars: [], selectedPillars: ['reliability'] }], 7)).toContain('0 of 1');
  });
});

describe('notices', () => {
  it('names the pillar on confirm and counts the exact current answers it freezes', () => {
    const sentence = confirmNotice('Reliability', 3);
    expect(sentence).toContain('Confirm Reliability?');
    expect(sentence).toContain('exact 3 current answers shown here');
    expect(sentence.toLowerCase()).not.toContain('still current in the live');
    expect(sentence.toLowerCase()).not.toContain('reviewed');
  });

  it('says a confirm records nothing when the run named no answer, rather than omitting the count', () => {
    // The reachable case this was wrong about: findings recorded before `attested.id` existed cite
    // nothing, and a notice that says only "this is written once" lets somebody write an empty record
    // believing it carried the answers listed above it.
    const sentence = confirmNotice('Reliability', 0);
    expect(sentence).toContain('records none');
    expect(sentence).not.toMatch(/\b0 answers\b/);
  });

  it('names the pillar, frozen unresolved count and consequence on skip without calling it a review', () => {
    const sentence = skipNotice('Reliability', 4);
    expect(sentence).toContain('Skip Reliability?');
    expect(sentence).toContain('4 manual controls');
    expect(sentence).toContain('unaccepted and unmeasured');
    expect(sentence).toContain('A skip is written once');
    expect(sentence).toContain('a skip is not a review of it');
    expect(sentence).not.toMatch(/this pillar (was|has been|is) reviewed/i);
  });

  it('states the application result boundary only for the final decision surface to opt into', () => {
    expect(finalDecisionNotice()).toContain('completes the selected pillar review');
    expect(finalDecisionNotice()).toContain('publishes the report');
    expect(finalDecisionNotice()).not.toContain('platform');
  });
});

describe('attribution', () => {
  it('restates who opened the review', () => {
    expect(openedPhrase(REVIEW)).toMatch(/^Opened by admin@example.com on /);
  });

  it('restates who finalised, without saying the score is published', () => {
    const result: AssessmentResult = {
      id: 'res-1',
      reviewId: 'r1',
      runId: 'run-1',
      finalisedBy: 'admin@example.com',
      finalisedAt: '2026-08-03T00:00:00.000Z',
      pillars: [CONFIRMED],
      attestationIds: ['a1'],
    };
    const sentence = finalisedPhrase(result);
    expect(sentence).toMatch(/^Every selected pillar has a record\. Finalised by admin@example.com on /);
    expect(sentence.toLowerCase()).not.toContain('publish');
    expect(sentence.toLowerCase()).not.toContain('score');
  });
});

describe('counts', () => {
  it('does not call measured findings answered', () => {
    expect(automaticPhrase(2)).toBe('2 requirements this run measured without asking a person.');
    expect(automaticPhrase(0).toLowerCase()).not.toContain('answered');
  });

  it('says when an answer is current without claiming a confirm reuses it', () => {
    // "Reused" would overstate the live store before the reviewer has made the decision.
    expect(reusedPhrase(1)).toBe('1 answer to this pillar is current on record now.');
    expect(reusedPhrase(2)).toBe('2 answers to this pillar are current on record now.');
    expect(reusedPhrase(1).toLowerCase()).not.toContain('reus');
    expect(reusedPhrase(0).toLowerCase()).not.toContain('reus');
    expect(attentionCountPhrase(0)).toBe('None need attention');
  });

  it('says the confirm freezes exact current evidence', () => {
    expect(citedPhrase(2)).toContain('exact 2 current answers');
    expect(citedPhrase(0)).toContain('no current human answer');
  });
});
