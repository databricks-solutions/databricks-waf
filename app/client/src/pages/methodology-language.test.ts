// The sentences that say how somebody is being judged.
//
// Each of these is a claim, and the ones worth testing are the ones that read as reasonable while
// being wrong: an outcome left out of the score rendered as earning nothing, a run described as
// current when it was scored by a weighting the app has since changed, a field name printed raw
// because this build has never heard of it. None of those throws and none would fail a render test.

import { describe, expect, it } from 'vitest';
import {
  creditPhrase,
  creditSentence,
  fieldsPhrase,
  shapeSentence,
  spanSentence,
  standingSentence,
  revisionSentence,
  weightPhrase,
} from './methodology-language';

const WEIGHTS = { critical: 10, high: 6, medium: 3, low: 1, informational: 0.5 };

describe('what a field of the scoring shape is', () => {
  it('says what a field does rather than naming it', () => {
    expect(fieldsPhrase(['severity'])).toBe('how heavily it weighs');
    expect(fieldsPhrase(['thresholds'])).toBe('what it is judged against');
    expect(fieldsPhrase(['preconditions'])).toBe('when it does not apply');
  });

  it('joins several so the clause reads', () => {
    expect(fieldsPhrase(['severity', 'thresholds'])).toBe('how heavily it weighs and what it is judged against');
    expect(fieldsPhrase(['pillar', 'severity', 'clouds'])).toBe(
      'which pillar asks it, how heavily it weighs and which clouds it applies to',
    );
  });

  it('prints a field it has never heard of rather than dropping it', () => {
    // A record written by a newer build carries fields this one does not know. Dropping the unknown
    // one would tell the reader nothing moved, which is the opposite of what the record says.
    expect(fieldsPhrase(['weighting_curve'])).toBe('weighting_curve');
    expect(fieldsPhrase(['severity', 'weighting_curve'])).toBe('how heavily it weighs and weighting_curve');
  });
});

describe('what a release did', () => {
  const empty = { describes: true, added: [], removed: [], renamed: [], changed: [] };

  it('keeps the four kinds of move apart', () => {
    const said = revisionSentence({ ...empty, added: ['A'], removed: ['B', 'C'], changed: ['D'] });

    // Apart because a reader acts on them differently: an arrival or a departure changes what the
    // score is out of, and a redefinition changes how the same estate scores without changing what is
    // being asked about.
    expect(said).toBe('1 requirement added, 2 requirements removed, 1 requirement redefined.');
  });

  it('says a version moved nothing rather than saying nothing', () => {
    expect(revisionSentence(empty)).toBe('Nothing about any requirement moved in this catalogue revision.');
  });

  it('refuses to describe a version that did not write down what it changed', () => {
    // The state the first recorded version is in, and the state any version written by an older build
    // is in. An empty diff would read as "nothing changed" across a release nobody described.
    expect(revisionSentence({ ...empty, describes: false })).toBe(
      'What this catalogue revision changed was not written down, so scores either side of it are not comparable.',
    );
  });

  it('does not describe a version as unchanged when it was never described', () => {
    // The pair that matters: undescribed with moves recorded still refuses, because a partial record
    // is not a record.
    expect(revisionSentence({ ...empty, describes: false, added: ['A'] })).toContain('not written down');
  });
});

describe('what a severity is worth', () => {
  it('states the weight against the lightest, because the raw numbers mean nothing alone', () => {
    expect(weightPhrase('critical', WEIGHTS)).toBe('20× the lightest weight');
    expect(weightPhrase('high', WEIGHTS)).toBe('12× the lightest weight');
    expect(weightPhrase('informational', WEIGHTS)).toBe('the lightest weight');
  });

  it('keeps one decimal where the ratio is not whole', () => {
    expect(weightPhrase('high', { high: 5, low: 2 })).toBe('2.5× the lightest weight');
  });

  it('says nothing about a severity the table does not hold', () => {
    // A record from a newer build can carry a severity this one does not weigh. A fabricated ratio
    // would be a claim about how heavily it counts, which this build cannot make.
    expect(weightPhrase('catastrophic', WEIGHTS)).toBeUndefined();
  });
});

describe('what an outcome earns', () => {
  it('distinguishes earning nothing from being left out', () => {
    // The distinction the whole score rests on. Rendered as "0" for both, a requirement that does not
    // apply would look identical to one that failed, in the table that explains scoring.
    expect(creditPhrase(0)).toBe('earns none of the weight');
    expect(creditPhrase(null)).toBe('left out of the score entirely');
  });

  it('states a part share as a percentage of the weight', () => {
    expect(creditPhrase(1)).toBe('earns the full weight');
    expect(creditPhrase(0.5)).toBe('earns 50% of the weight');
  });

  it('agrees with a plural subject, the weight belonging to the requirement rather than the outcome', () => {
    // "pass and satisfied-by-architecture earn its full weight" was the first cut: a singular pronoun
    // on a plural subject, pointing at a noun that is not in the sentence.
    const [first] = creditSentence({ pass: 1, 'satisfied-by-architecture': 1 });
    expect(first).toBe('pass and satisfied-by-architecture earn the full weight.');
  });
});

describe('an undescribed version', () => {
  const undescribed = { describes: false, added: [], removed: [], renamed: [], changed: [] };

  it('does not accuse the earliest recorded version of failing to write down what it changed', () => {
    // The only entry every install has today. There is no version before it in the record for it to
    // have differed from, so "not written down" would read as somebody's omission.
    const sentence = revisionSentence(undescribed, true);
    expect(sentence).toContain('earliest catalogue revision this build records');
    expect(sentence).not.toContain('either side');
  });

  it('keeps the consequence, which is the same either way', () => {
    expect(revisionSentence(undescribed, true)).toContain('cannot be compared');
    expect(revisionSentence(undescribed)).toContain('not comparable');
  });

  it('treats a later undescribed version as the omission it is', () => {
    expect(revisionSentence(undescribed, false)).toContain('was not written down');
  });
});

describe('what separates the version a run used from the one shipped', () => {
  const base = { earlier: '8', later: '10', describable: true, added: [], removed: [], renamed: [], changed: [] };

  it('counts what moved, naming both versions', () => {
    expect(spanSentence({ ...base, added: ['CO-09-01'], changed: [{}, {}] })).toBe(
      'Between version 8 and version 10: 1 requirement added, 2 requirements redefined.',
    );
  });

  it('says plainly that nothing moved, which is not the same as being unable to say', () => {
    // Reachable and worth distinguishing: the two versions can differ in weighting alone, in which case
    // the app still refuses one trend across them and no requirement changed.
    expect(spanSentence(base)).toBe('Nothing about any requirement moved between version 8 and version 10.');
  });

  it('gives the reason a span cannot be described rather than a count of the part that can', () => {
    expect(
      spanSentence({ ...base, describable: false, why: 'Version 9 did not record what it changed.', added: ['CO-09-01'] }),
    ).toBe('Version 9 did not record what it changed.');
  });

  it('falls back to naming both versions where the server gave no reason', () => {
    expect(spanSentence({ ...base, describable: false })).toContain('was not written down');
  });
});

describe('what decides how a requirement scores', () => {
  const base = {
    provenance: 'waf-docs',
    measurability: 'system-table',
    coverageMode: 'complete',
    preconditions: [],
  };

  it('says how it can be answered and what it is judged against', () => {
    expect(shapeSentence({ ...base, thresholds: { pass_share: 0.95, partial_share: 0.7 } })).toBe(
      'read from system tables · pass share 95%, partial share 70%',
    );
  });

  it('leaves out what is true of nearly every requirement', () => {
    // 180 of the 184 come from the framework and are scored completely. Saying so on every row costs a
    // line and tells the reader nothing about the row they are on — the same argument that keeps the
    // severity weight off it.
    expect(shapeSentence(base)).toBe('read from system tables');
    expect(shapeSentence({ ...base, coverageMode: 'complete' })).not.toContain('sampled');
  });

  it('names a source that is not the framework', () => {
    expect(shapeSentence({ ...base, provenance: 'extension' })).toBe('added by this app · read from system tables');
    expect(shapeSentence({ ...base, provenance: 'security-guide' })).toContain('security best practices guide');
  });

  it('says when a requirement is excluded, and by what', () => {
    // The reason a comparable score may leave a requirement out at all, so the condition has to be
    // visible rather than the exclusion taken on trust.
    expect(
      shapeSentence({ ...base, preconditions: [{ signal: 'sql:estate.compute_profile' }] }),
    ).toContain('excluded by sql:estate.compute_profile');
  });

  it('says a requirement is scored once where two pillars ask for it', () => {
    expect(shapeSentence({ ...base, aliasGroup: 'delta-history' })).toContain('scored once with its alias');
  });

  it('prints a threshold name it has never seen rather than dropping the threshold', () => {
    // A resolver's threshold names are its own and new ones arrive with new resolvers. Dropping an
    // unrecognised one would present a requirement as judged against nothing.
    expect(shapeSentence({ ...base, thresholds: { min_runtime_major: 14 } })).toContain('min runtime major 14');
    // Only a share is a percentage. `min_runtime_major: 14` as "1400%" would be a confident wrong
    // answer about what the requirement asks.
    expect(shapeSentence({ ...base, thresholds: { min_runtime_major: 14 } })).not.toContain('%');
  });

  it('prints a measurability it has never seen rather than saying nothing', () => {
    expect(shapeSentence({ ...base, measurability: 'quantum-oracle' })).toBe('quantum-oracle');
  });
});

describe('whether the last run records this public methodology', () => {
  const current = {
    publicVersion: 1,
    manifestDigest: 'sha256:aaa',
    state: 'released' as const,
    effectiveDate: '2026-09-01',
  };

  it('confirms the exact released identity the run records', () => {
    expect(
      standingSentence(current, {
        publicVersion: 1,
        manifestDigest: 'sha256:aaa',
        state: 'released',
        effectiveDate: '2026-09-01',
      }),
    ).toBe('The most recent run records released Methodology Version 1, effective 2026-09-01.');
  });

  it('classifies a run with no public identity as pre-release instead of backfilling Version 1', () => {
    expect(standingSentence(current, undefined)).toContain('pre-release development record');
  });

  it('names a different public version without translating its catalogue revision', () => {
    expect(
      standingSentence(current, { publicVersion: 2, manifestDigest: 'sha256:two', state: 'released' }),
    ).toBe('The most recent run records Methodology Version 2, not Version 1.');
  });

  it('reports a different manifest even where the public version label matches', () => {
    expect(
      standingSentence(current, { publicVersion: 1, manifestDigest: 'sha256:bbb', state: 'released' }),
    ).toContain('different manifest digest');
  });

  it('does not call candidate evidence released', () => {
    expect(
      standingSentence(current, { publicVersion: 1, manifestDigest: 'sha256:aaa', state: 'candidate' }),
    ).toBe('The most recent run records Methodology Version 1 as a release candidate.');
  });
});
