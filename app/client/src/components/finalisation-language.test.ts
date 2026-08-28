// The refusals, not the wording. Each of these is a sentence that would be more specific than the
// field under it, and each was reachable from the payload before the module refused it.

import { describe, expect, it } from 'vitest';
import { reviewStanding } from './finalisation-language';
import type { Finalisation } from '../api/types';

const TITLES: Readonly<Record<string, string>> = {
  reliability: 'Reliability',
  security: 'Security and compliance',
  'cost-optimisation': 'Cost optimisation',
};

const titleOf = (id: string) => TITLES[id] ?? id;

function standing(overrides: Partial<Finalisation> = {}): Finalisation {
  return {
    reviewId: 'review-1',
    finalised: false,
    recorded: 0,
    expected: 7,
    confirmed: 0,
    skipped: [],
    cited: 0,
    refreshed: 0,
    ...overrides,
  };
}

describe('what may be said about a run’s review', () => {
  it('says nothing where the payload is absent, because that is an install and not a person', () => {
    expect(reviewStanding(undefined, titleOf)).toBeNull();
  });

  it('does not call a run reviewed when part of it was skipped', () => {
    const words = reviewStanding(
      standing({ finalised: true, recorded: 7, confirmed: 6, skipped: ['cost-optimisation'], cited: 12 }),
      titleOf
    );

    expect(words?.label).toBe('Partly reviewed');
    expect(words?.caption).toBe('6 of 7 pillars confirmed, 1 skipped.');
  });

  it('names the skipped pillars and refuses to call their requirements answered', () => {
    const words = reviewStanding(
      standing({ finalised: true, recorded: 7, confirmed: 5, skipped: ['cost-optimisation', 'security'], cited: 9 }),
      titleOf
    );

    const skips = words?.detail.at(-1) ?? '';
    expect(skips).toContain('Cost optimisation and Security and compliance were skipped');
    expect(skips).toContain('Nobody confirmed their answers in this review');
    // The run can hold attested answers for a pillar the review skipped, so what the skip says is that
    // nobody cited them — not that the requirements went unanswered.
    expect(skips).not.toMatch(/were not answered/);
    // The count cannot stand in for the names: a reader deciding whether to quote the score needs to
    // know which parts of it nobody looked at.
    expect(skips).not.toMatch(/2 pillars were skipped/);
  });

  it('calls a review finished with every pillar skipped what it is, which is not reviewed', () => {
    const words = reviewStanding(
      standing({ finalised: true, recorded: 2, expected: 2, confirmed: 0, skipped: ['reliability', 'security'] }),
      titleOf
    );

    expect(words?.label).toBe('Not reviewed');
    expect(words?.detail[1]).toContain('No pillar has been confirmed');
  });

  it('says where the cited count came from, so it is not read as the answers on record now', () => {
    const words = reviewStanding(
      standing({ finalised: true, recorded: 7, confirmed: 7, skipped: [], cited: 41 }),
      titleOf
    );

    expect(words?.label).toBe('Reviewed');
    expect(words?.detail[1]).toBe(
      '7 pillars confirmed, citing 41 answers this run already held. Not a count of what is on record now.'
    );
  });

  it('reports an unfinished review as a fraction and never as a deadline', () => {
    const words = reviewStanding(standing({ recorded: 3, expected: 7, confirmed: 3, cited: 4 }), titleOf);

    expect(words?.label).toBe('Review not finished');
    expect(words?.caption).toBe('3 of 7 pillars reviewed or skipped.');
    expect(words?.detail[0]).toContain('3 of 7 pillars have a record');
    // No field carries when a review is owed by, so no sentence may imply one.
    for (const sentence of words?.detail ?? []) {
      expect(sentence).not.toMatch(/due|overdue|late|provisional/i);
    }
  });

  it('agrees with itself about one pillar', () => {
    const words = reviewStanding(
      standing({ finalised: true, recorded: 1, expected: 1, confirmed: 0, skipped: ['reliability'] }),
      titleOf
    );

    expect(words?.detail.at(-1)).toBe('Reliability was skipped. Nobody confirmed its answers in this review.');
  });

  it('does not call a review of six pillars a review of the seven there now are', () => {
    // A review finalises against the catalogue as it stood, so a pillar added afterwards leaves a
    // finished review with nothing recorded for it: seven expected, six confirmed, nothing skipped.
    const words = reviewStanding(
      standing({ finalised: true, recorded: 6, expected: 7, confirmed: 6, skipped: [], cited: 30 }),
      titleOf
    );

    expect(words?.label).toBe('Partly reviewed');
    expect(words?.caption).toBe('6 of 7 pillars confirmed.');
    expect(words?.caption).not.toContain('All 7');
  });
});

describe('what may be said about answers given inside the review', () => {
  it('says nothing at all when none were, rather than reporting a zero as an absence of effort', () => {
    const words = reviewStanding(standing({ finalised: true, recorded: 7, confirmed: 7, cited: 12 }), titleOf);

    expect(words?.detail.join(' ')).not.toContain('refresh');
    expect(words?.detail.join(' ')).not.toContain('given from inside');
  });

  it('bounds the count to this review, because an answer given elsewhere while it was open is not in it', () => {
    const words = reviewStanding(
      standing({ finalised: true, recorded: 7, confirmed: 7, cited: 12, refreshed: 3 }),
      titleOf
    );

    expect(words?.detail).toContain(
      '3 answers were given from inside this review. Answers recorded elsewhere while it was open are not counted here.'
    );
  });

  it('counts answers and never requirements, because answering one twice writes two attestations', () => {
    const words = reviewStanding(standing({ refreshed: 2 }), titleOf);

    const said = words?.detail.join(' ') ?? '';
    expect(said).toContain('2 answers');
    expect(said).not.toContain('requirement');
  });

  it('never describes the count as the reviewer’s work, which is a claim about a person', () => {
    const words = reviewStanding(standing({ refreshed: 4 }), titleOf);

    const said = words?.detail.join(' ').toLowerCase() ?? '';
    for (const forbidden of ['effort', 'you answered', 'brought up to date', 'work done', 'caused']) {
      expect(said).not.toContain(forbidden);
    }
  });

  it('reads singular for one, so the sentence is not a template with a number in it', () => {
    const words = reviewStanding(standing({ refreshed: 1 }), titleOf);

    expect(words?.detail.join(' ')).toContain('1 answer was given from inside this review.');
  });
});
