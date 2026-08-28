import { describe, expect, it } from 'vitest';
import type { FoundationReadiness, ReadinessDimension } from '../api/types';
import {
  bandPhrase,
  countPhrase,
  obligationPhrases,
  readingSentence,
  selectionPhrases,
  sharePhrase,
  standingPresentation,
  unreadSentence,
} from './foundation-language';

function dimension(over: Partial<ReadinessDimension> = {}): ReadinessDimension {
  return {
    id: 'lineage',
    version: 1,
    area: 'freshness',
    label: 'Lineage',
    asks: 'How many appear on either side of a lineage event inside the window.',
    sources: ['sql:serving.facts'],
    standing: 'ready',
    bands: { ready: 0.9, partial: 0.6 },
    denominator: { of: 'serving assets whose lineage was read', count: 10, excluded: 0, excludedBecause: '' },
    met: 10,
    short: 0,
    unmeasured: 0,
    share: 1,
    shortfall: [],
    ...over,
  };
}

function readiness(over: Partial<FoundationReadiness> = {}): FoundationReadiness {
  return {
    declaration: {
      version: 3,
      declaredAt: '2026-08-15T09:00:00.000Z',
      declaredBy: 'priya@example.com',
      fingerprint: 'sha256:abc',
      named: [{ catalog: 'main', schema: 'gold', table: 'orders' }],
      tagged: [{ key: 'certification', values: ['gold'], at: ['table'] }],
      requiredTagKeys: ['owner_team'],
      requiredMetadata: ['description', 'owner'],
      policy: [{ classification: 'pii', requires: ['column-mask'] }],
    },
    population: { assets: 12, missing: 0, truncated: false, undeclared: false },
    dimensions: [dimension()],
    absent: [],
    unread: [],
    durable: true,
    ...over,
  };
}

describe('a share', () => {
  it('never rounds up to whole coverage from below it', () => {
    // The one rounding error a reader acts on: 99.6% printed as 100% reads as done, and the asset it
    // is short of is the one somebody would have gone and fixed.
    expect(sharePhrase(0.996)).toBe('99%');
    expect(sharePhrase(1)).toBe('100%');
  });

  it('is a dash where there is none, rather than nought per cent', () => {
    expect(sharePhrase(null)).toBe('—');
  });
});

describe('what a dimension counted', () => {
  it('names the denominator in the same sentence as the number', () => {
    expect(countPhrase(dimension({ met: 7, denominator: { ...dimension().denominator, count: 10 } }))).toBe(
      '7 of 10 serving assets whose lineage was read.'
    );
  });

  it('says what was left out of the count and why, so the share is not read as of everything', () => {
    const phrase = countPhrase(
      dimension({
        met: 4,
        denominator: {
          of: 'serving assets that store data of their own',
          count: 5,
          excluded: 3,
          excludedBecause: 'they are views or federated relations, which hold no format of their own',
        },
      })
    );

    expect(phrase).toContain('4 of 5');
    expect(phrase).toContain('3 more are out of this count');
    expect(phrase).toContain('views or federated relations');
  });

  it('counts what could not be read separately from what fell short', () => {
    const phrase = countPhrase(
      dimension({ met: 4, short: 1, unmeasured: 2, denominator: { ...dimension().denominator, count: 5 } })
    );
    expect(phrase).toContain('2 could not be read');
  });

  it('keeps the denominator beside the reason where nothing was counted', () => {
    const phrase = countPhrase(
      dimension({
        denominator: { ...dimension().denominator, count: 0 },
        because: 'the catalogue was not read, so the declared assets could not be found in it',
      })
    );
    expect(phrase).toBe(
      '0 serving assets whose lineage was read. Reason: the catalogue was not read, so the declared assets could not be found in it.'
    );
  });
});

describe('the standing beside a dimension', () => {
  it('gives an unread dimension no colour, because it is a gap in the read and not in the estate', () => {
    expect(standingPresentation('unmeasured').tone).toBe('neutral');
    expect(standingPresentation('unmeasured').label).toBe('Not read');
  });

  it('carries a shape as well as a word, on all four', () => {
    for (const standing of ['ready', 'partial', 'short', 'unmeasured'] as const) {
      expect(standingPresentation(standing).Icon, standing).toBeTruthy();
      expect(standingPresentation(standing).label, standing).toMatch(/\S/);
    }
  });

  it('says where the two thresholds sit and whose they are', () => {
    expect(bandPhrase(dimension())).toContain('Ready at 90%');
    expect(bandPhrase(dimension())).toContain("this app's");
  });
});

describe('what the page is a reading of', () => {
  it('says nothing is declared rather than reporting an estate of nothing', () => {
    const sentence = readingSentence(
      readiness({ declaration: null, population: { assets: 0, missing: 0, truncated: false, undeclared: true } })
    );
    expect(sentence).toContain('Nobody has said which data');
    expect(sentence).toContain('unread rather than failing');
  });

  it('names the version, because a reading is a reading of one', () => {
    expect(readingSentence(readiness())).toContain('Version 3');
    expect(readingSentence(readiness())).toContain('12 relations');
  });

  it('says a named relation the catalogue did not hold is missing rather than dropping it', () => {
    const sentence = readingSentence(
      readiness({ population: { assets: 11, missing: 1, truncated: false, undeclared: false } })
    );
    expect(sentence).toContain('1 named relation is not in the catalogue');
  });

  it('says the shares are of part of the declaration when the read hit its ceiling', () => {
    const sentence = readingSentence(
      readiness({ population: { assets: 2000, missing: 0, truncated: true, undeclared: false } })
    );
    expect(sentence).toContain('share of part of what was declared');
  });

  it('says what is missing when there is nothing to read with', () => {
    const sentence = readingSentence(readiness({ unavailable: 'No SQL warehouse is bound to this installation.' }));
    expect(sentence).toBe('No SQL warehouse is bound to this installation.');
  });
});

describe('a statement this reading cannot use', () => {
  it('is named rather than counted, because the three leave different things unread', () => {
    const sentence = unreadSentence([{ statement: 'sql:serving.facts', kind: 'failed', because: 'timed out' }]);
    expect(sentence).toContain('sql:serving.facts');
    expect(sentence).toContain('timed out');
    expect(sentence).toContain('unread rather than as nothing found');
  });

  it('says a capped read stopped at its ceiling rather than that it did not answer', () => {
    // A capped read answered. Told otherwise, a reader goes looking for a grant that is not missing.
    const sentence = unreadSentence([
      { statement: 'sql:serving.tags', kind: 'capped', because: '5000 rows returned of 9000' },
    ]);
    expect(sentence).toContain('stopped at its ceiling');
    expect(sentence).not.toContain('did not answer');
  });

  it('gives each statement its own verb, so a mixed list claims neither of the other', () => {
    const sentence = unreadSentence([
      { statement: 'sql:serving.tags', kind: 'capped', because: 'ceiling' },
      { statement: 'sql:serving.facts', kind: 'failed', because: 'no grant' },
    ]);
    expect(sentence).toContain('sql:serving.tags stopped at its ceiling');
    expect(sentence).toContain('sql:serving.facts did not answer');
  });

  it('says nothing where all of them answered', () => {
    expect(unreadSentence([])).toBeUndefined();
  });
});

describe('what the declaration says', () => {
  it('states both halves of the selection, including the empty one', () => {
    const [named, tagged] = selectionPhrases({ ...readiness().declaration!, tagged: [] });
    expect(named).toContain('1 relation is named');
    expect(tagged).toBe('No tag selects a relation.');
  });

  it('says a selector with no values matches any value of the key', () => {
    const [, tagged] = selectionPhrases({
      ...readiness().declaration!,
      tagged: [{ key: 'data_product', at: ['schema'] }],
    });
    expect(tagged).toContain('any value');
  });

  it('reads the obligations off the declaration rather than off this app', () => {
    const phrases = obligationPhrases(readiness().declaration!);
    expect(phrases.join(' ')).toContain('must carry: description, owner');
    expect(phrases.join(' ')).toContain('owner_team');
    expect(phrases.join(' ')).toContain('classified pii must carry column-mask');
  });

  it('says so plainly where a declaration requires nothing further', () => {
    const phrases = obligationPhrases({
      ...readiness().declaration!,
      requiredMetadata: [],
      requiredTagKeys: [],
      policy: [],
    });
    expect(phrases).toEqual(['The declaration requires nothing of a serving relation beyond being one.']);
  });
});
