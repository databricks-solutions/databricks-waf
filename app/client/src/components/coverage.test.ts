import { describe, expect, it } from 'vitest';
import {
  attestedClause,
  confidenceOf,
  confidenceSentence,
  estateCoverage,
  excludedClause,
  importedClause,
  pillarCoverage,
} from './coverage';
import type { Exposure, PillarScore, Score } from '../api/types';

const COUNTS = {
  pass: 0,
  partial: 0,
  fail: 0,
  unmeasurable: 0,
  'not-applicable': 0,
  'satisfied-by-architecture': 0,
} as const;

/**
 * A score, with `attested` as shorthand for the composition of its scored set.
 *
 * The shorthand is here because every case in this file varies the same one number, and spelling the
 * whole record out at each call site would bury what each test is about. The remainder is observed,
 * which is what the composition of a real run looks like today.
 *
 * Outcome counts are filled from `scoredControls` unless a case sets them, which describes a run with
 * no aliased controls — the shape most of these cases are about. The cases that are about the
 * difference set `counts` themselves.
 */
function score(over: Partial<Score> & { attested?: number } = {}): Score {
  const { attested = 0, ...rest } = over;
  const scored = rest.scoredControls ?? 100;
  const built: Score = {
    overall: 70,
    pillars: [],
    counts: { ...COUNTS, pass: scored },
    scoredControls: scored,
    composition: { observed: Math.max(0, scored - attested), 'admin-collected': 0, attested },
    totalControls: 100,
    ...rest,
  };
  return built;
}

function pillar(over: Partial<PillarScore> & { attested?: number } = {}): PillarScore {
  const { attested = 0, ...rest } = over;
  const scored = rest.scored ?? 10;
  return {
    pillarId: 'reliability',
    score: 60,
    counts: { ...COUNTS, pass: scored },
    scored,
    unmeasurable: 0,
    unmeasuredBy: { attestation: 0, unreachable: 0, unbuilt: 0, unreadable: 0, disabled: 0 },
    composition: { observed: Math.max(0, scored - attested), 'admin-collected': 0, attested },
    notApplicable: 0,
    total: 10,
    worstFirst: [],
    ...rest,
  };
}

describe('what coverage counts', () => {
  /**
   * A run whose catalogue aliases controls: 49 requirements answered, 34 of them distinct.
   *
   * This is not a contrived shape — it is a real labs run, and it is the shape that produced the bug.
   * Coverage was drawn from `scoredControls`, so the panel read "34 of 169 evaluated" above a segment
   * bar whose own segments added to 49, and the history line beneath read "coverage fell from 29% to
   * 20%" between two runs of an estate that had not changed, because one side of that subtraction
   * counted findings and the other counted alias groups.
   */
  const aliased = score({
    totalControls: 184,
    scoredControls: 34,
    counts: { ...COUNTS, pass: 29, partial: 7, fail: 13, unmeasurable: 120, 'not-applicable': 15 },
  });

  it('counts the outcomes the reader can count, not the deduplicated scoring set', () => {
    const coverage = estateCoverage(aliased);

    expect(coverage.assessed).toBe(49);
    expect(coverage.scored).toBe(34);
    expect(Math.round(coverage.percent)).toBe(29);
  });

  it('agrees with the segment bar drawn beside it, which is the whole point', () => {
    const coverage = estateCoverage(aliased);
    const { counts } = aliased;

    expect(coverage.assessed).toBe(counts.pass + counts.partial + counts.fail);
    expect(coverage.assessed + counts.unmeasurable + counts['not-applicable']).toBe(coverage.total);
  });

  it('counts a requirement met by architecture as answered, because the bar does', () => {
    const coverage = estateCoverage(
      score({ totalControls: 10, scoredControls: 4, counts: { ...COUNTS, pass: 2, 'satisfied-by-architecture': 2, unmeasurable: 6 } })
    );

    expect(coverage.assessed).toBe(4);
  });

  it('counts the same way for a pillar, so a pillar row cannot disagree with the estate', () => {
    const coverage = pillarCoverage(
      pillar({ total: 20, scored: 6, counts: { ...COUNTS, pass: 5, fail: 4, unmeasurable: 9, 'not-applicable': 2 } })
    );

    expect(coverage.assessed).toBe(9);
    expect(coverage.scored).toBe(6);
    expect(coverage.applicable).toBe(18);
    expect(Math.round(coverage.percent)).toBe(50);
  });
});

describe('the attested share of coverage', () => {
  it('is carried on the facts, so every surface reads the same number', () => {
    const coverage = estateCoverage(score({ scoredControls: 40, attested: 10, totalControls: 100 }));

    expect(coverage.attested).toBe(10);
    expect(coverage.attestedPercent).toBe(25);
  });

  it('is zero rather than undefined when nothing was scored', () => {
    expect(estateCoverage(score({ scoredControls: 0, attested: 0 })).attestedPercent).toBe(0);
  });

  it('comes off the pillar for a pillar', () => {
    expect(pillarCoverage(pillar({ scored: 8, attested: 4, total: 10 })).attestedPercent).toBe(50);
  });
});

describe('confidence when the coverage is self-reported', () => {
  it('is high for near-complete coverage that was observed', () => {
    expect(confidenceOf(estateCoverage(score({ scoredControls: 90, attested: 0, totalControls: 100 })))).toBe(
      'high'
    );
  });

  it('caps at moderate for near-complete coverage that is mostly answers', () => {
    // The check that stops the feature undoing the thing it was added to: answering 82
    // requirements takes coverage from 24% to near-total, and the page must not then call a set of
    // typed statements a stable score.
    expect(confidenceOf(estateCoverage(score({ scoredControls: 90, attested: 60, totalControls: 100 })))).toBe(
      'moderate'
    );
  });

  it('does not cap when the answers are a minority of what was assessed', () => {
    expect(confidenceOf(estateCoverage(score({ scoredControls: 90, attested: 20, totalControls: 100 })))).toBe(
      'high'
    );
  });

  it('drops middling coverage that is mostly answers to low', () => {
    expect(confidenceOf(estateCoverage(score({ scoredControls: 60, attested: 40, totalControls: 100 })))).toBe(
      'low'
    );
  });
});

describe('what the reader is told about it', () => {
  it('does not claim the score is stable when part of it was answered', () => {
    const sentence = confidenceSentence(
      estateCoverage(score({ scoredControls: 90, attested: 60, totalControls: 100 }))
    );

    expect(sentence).not.toContain('stable');
    expect(sentence).toContain('rest on an answer given by a person');
  });

  it('does claim stability for a fully observed, well-covered assessment', () => {
    expect(
      confidenceSentence(estateCoverage(score({ scoredControls: 90, attested: 0, totalControls: 100 })))
    ).toContain('stable');
  });

  it('states the attested count and share in requirements the reader can check', () => {
    const clause = attestedClause(estateCoverage(score({ scoredControls: 40, attested: 10 })));

    // Named apart from coverage's own count on purpose: this denominator is the deduplicated scoring
    // set, and calling it "assessed" is what let the panel state two different totals under one word.
    expect(clause).toContain('10 of the 40 requirements the score is computed from');
    expect(clause).toContain('25%');
  });

  it('says nothing at all when nothing was attested', () => {
    expect(attestedClause(estateCoverage(score()))).toBe('');
  });

  it('still reports no posture when nothing was assessed', () => {
    expect(confidenceSentence(estateCoverage(score({ scoredControls: 0, totalControls: 100 })))).toContain(
      'no posture'
    );
  });
});

describe('a reading an administrator imported', () => {
  const imported = (adminCollected: number, scored = 40): Score => {
    const built = score({ scoredControls: scored });
    return { ...built, composition: { observed: scored - adminCollected, 'admin-collected': adminCollected, attested: 0 } };
  };

  it('is carried on the facts, so a surface can describe the mixture', () => {
    expect(estateCoverage(imported(6)).adminCollected).toBe(6);
  });

  it('does not weaken confidence, because it is a measurement taken elsewhere', () => {
    // An imported reading is not somebody's word. Treating it like one would tell an estate that
    // running the check its administrator has access to made its assessment less trustworthy.
    expect(confidenceOf(estateCoverage(imported(80, 90)))).toBe('high');
  });

  it('is stated, so the attested clause does not imply the rest was observed here', () => {
    const sentence = confidenceSentence(estateCoverage(imported(30, 90)));

    expect(sentence).toContain('an administrator ran and imported');
  });

  it('says nothing when nothing was imported, which is every run this build produces', () => {
    expect(importedClause(estateCoverage(score({ scoredControls: 40 })))).toBe('');
  });
});

describe('what a customer’s applicability decisions took out of the score', () => {
  const excluded = (
    controlId: string,
    // Defaulted rather than fixed, because every fixture here used to hardcode `not-applicable` and
    // that is why nothing caught the sentence being wrong for the other lever.
    lever: Exposure['excluded'][number]['lever'] = 'not-applicable'
  ): Exposure['excluded'][number] => ({
    controlId,
    lever,
    owner: 'platform-team',
    reason: 'managed elsewhere',
    decisionId: `d-${controlId}`,
  });
  const lapsed = (controlId: string): Exposure['lapsed'][number] => ({
    controlId,
    lever: 'not-applicable',
    reading: 'fail',
    decisionId: `d-${controlId}`,
  });
  const withExposure = (exposure: Exposure): Score => score({ scoredControls: 90, totalControls: 100, exposure });

  it('counts the excluded and lapsed requirements onto the facts', () => {
    const coverage = estateCoverage(withExposure({ excluded: [excluded('a'), excluded('b')], lapsed: [lapsed('c')] }));

    expect(coverage.excludedByDecision).toBe(2);
    expect(coverage.lapsedDecisions).toBe(1);
  });

  it('reads absent exposure as none excluded, which is what a run without it was', () => {
    const coverage = estateCoverage(score({ scoredControls: 90, totalControls: 100 }));

    expect(coverage.excludedByDecision).toBe(0);
    expect(coverage.lapsedDecisions).toBe(0);
  });

  it('carries no exposure onto a pillar, since exposure is an estate-level fact', () => {
    expect(pillarCoverage(pillar()).excludedByDecision).toBe(0);
  });

  it('names how many requirements were set aside, as a count and nothing more', () => {
    const clause = excludedClause(estateCoverage(withExposure({ excluded: [excluded('a'), excluded('b')], lapsed: [] })));

    expect(clause).toContain('2 requirements have been set aside');
    expect(clause).toContain('not in the score');
  });

  it('says the lapsed half without claiming which reading set each one aside', () => {
    const clause = excludedClause(
      estateCoverage(withExposure({ excluded: [excluded('a')], lapsed: [lapsed('c'), lapsed('d')] }))
    );

    expect(clause).toContain('2 further such decisions were not applied');
    expect(clause).toContain('failing or only partly met');
  });

  it('does not say "further such" where a lapse is the only thing in the sentence', () => {
    // A lapsed decision was not applied, so it is not in `excluded` — a clause of lapses alone is a
    // state the app can reach, and it opened on a comparative with nothing behind it.
    const clause = excludedClause(estateCoverage(withExposure({ excluded: [], lapsed: [lapsed('c')] })));

    expect(clause).toContain('One applicability decision was not applied');
    expect(clause).not.toContain('further');
  });

  it('says a switched-off check is switched off, not that the requirement does not apply', () => {
    const clause = excludedClause(estateCoverage(withExposure({ excluded: [excluded('a', 'disabled')], lapsed: [] })));

    expect(clause).toContain("One requirement's check is switched off in this install");
    expect(clause).not.toContain('not applying to this estate');
  });

  it('carries both levers where both were used, rather than one wording for both', () => {
    const clause = excludedClause(
      estateCoverage(
        withExposure({ excluded: [excluded('a'), excluded('b', 'disabled'), excluded('c', 'disabled')], lapsed: [] })
      )
    );

    expect(clause).toContain('One requirement has been set aside as not applying to this estate');
    expect(clause).toContain('2 requirements have checks switched off in this install');
  });

  it('does not tell an estate whose requirements were all set aside that nothing was evaluated', () => {
    // The one branch where a reader most needs the exclusions named, and the one that returned before
    // reaching them.
    const sentence = confidenceSentence(
      estateCoverage(
        score({
          scoredControls: 0,
          totalControls: 100,
          exposure: { excluded: [excluded('a'), excluded('b')], lapsed: [] },
        })
      )
    );

    expect(sentence).not.toContain('has been evaluated yet');
    expect(sentence).toContain('Nothing here is in the score');
    expect(sentence).toContain('2 requirements have been set aside');
  });

  it('still says nothing has been evaluated where no decision is involved', () => {
    expect(confidenceSentence(estateCoverage(score({ scoredControls: 0, totalControls: 100 })))).toBe(
      'Nothing here has been evaluated yet, so there is no posture to read.'
    );
  });

  it('counts the levers apart, and to the same total as the list', () => {
    const coverage = estateCoverage(
      withExposure({ excluded: [excluded('a'), excluded('b', 'disabled')], lapsed: [] })
    );

    expect(coverage.notApplicableByDecision).toBe(1);
    expect(coverage.disabledByDecision).toBe(1);
    expect(coverage.notApplicableByDecision + coverage.disabledByDecision).toBe(coverage.excludedByDecision);
  });

  it('uses the singular for one of each', () => {
    const clause = excludedClause(estateCoverage(withExposure({ excluded: [excluded('a')], lapsed: [lapsed('c')] })));

    expect(clause).toContain('One requirement has been set aside');
    expect(clause).toContain('One further such decision was not applied');
  });

  it('says nothing when nothing was excluded or lapsed', () => {
    expect(excludedClause(estateCoverage(score({ scoredControls: 90, totalControls: 100 })))).toBe('');
  });

  it('says how many pillars left the average, since the number moves with nothing else to show it', () => {
    // 31c measured this: 75 with a range of 75–75 became 100 with a range of 100–100, under a sentence
    // that said seven requirements had been set aside and nothing about a pillar leaving.
    const clause = excludedClause(
      estateCoverage(withExposure({ excluded: [excluded('a')], lapsed: [], pillarsEmptied: 2 }))
    );

    expect(clause).toContain('2 pillars have no scored requirement left');
    expect(clause).toContain('not in the estate average');
  });

  it('uses the singular for one emptied pillar, and never names it', () => {
    const clause = excludedClause(
      estateCoverage(withExposure({ excluded: [excluded('a')], lapsed: [], pillarsEmptied: 1 }))
    );

    expect(clause).toContain('One pillar has no scored requirement left');
    // The wire carries a count. A name in this sentence would be a claim the field cannot support.
    expect(clause).not.toMatch(/reliability|cost|security|operational/i);
  });

  it('reads a run recorded before the count existed as no pillar having left', () => {
    const clause = excludedClause(estateCoverage(withExposure({ excluded: [excluded('a')], lapsed: [] })));

    expect(clause).toContain('One requirement has been set aside');
    expect(clause).not.toContain('estate average');
  });

  it('appends the exclusion to the confidence sentence', () => {
    const sentence = confidenceSentence(estateCoverage(withExposure({ excluded: [excluded('a')], lapsed: [] })));

    expect(sentence).toContain('set aside as not applying to this estate');
  });
});

describe('what the two ways of removing a requirement do to coverage', () => {
  /*
   * The second difference between disabling a check and marking it not applicable, after the range.
   *
   * ADR 0059's second amendment first said the range was the only one left. It is not: `facts`
   * computes `applicable` as `total - notApplicable`, so not-applicable leaves both sides of the
   * coverage fraction and disabling leaves only the numerator. The two therefore move the reported
   * coverage in opposite directions from the same estate, and the confidence drawn from it can
   * differ as well. Pinned because the amendment now says so.
   */
  const ten = (fail: number, unmeasurable: number, notApplicable: number): Score =>
    score({
      scoredControls: 5 + fail,
      totalControls: 10,
      counts: { ...COUNTS, pass: 5, fail, unmeasurable, 'not-applicable': notApplicable },
    });

  it('reports the same estate as 90%, 50% or 83.3% depending on how four failures were removed', () => {
    expect(estateCoverage(ten(4, 1, 0)).percent).toBeCloseTo(90, 1);
    expect(estateCoverage(ten(0, 5, 0)).percent).toBeCloseTo(50, 1);
    expect(estateCoverage(ten(0, 1, 4)).percent).toBeCloseTo(83.3, 1);
  });

  it('drops confidence when the four are disabled and holds it when they are marked not applicable', () => {
    // Disabling is the more exposed of the two here, not the less, which is the opposite of what
    // "the range is the honest half" implied when the range was the only difference on the list.
    expect(confidenceOf(estateCoverage(ten(4, 1, 0)))).toBe('high');
    expect(confidenceOf(estateCoverage(ten(0, 5, 0)))).toBe('moderate');
    expect(confidenceOf(estateCoverage(ten(0, 1, 4)))).toBe('high');
  });
});
