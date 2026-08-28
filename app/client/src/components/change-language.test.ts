// The sentences the page says about a customer's platform having moved.
//
// The ones worth testing are all the same shape: a fact the reader needs that reads as reassurance
// when it is missing. A carried-forward pillar with no changes is not a pillar that held. A score
// that fell across a catalogue update is not an estate that got worse. A comparison drawn with a
// qualification is not the same as one drawn without. None of those is visible in a rendered
// paragraph unless somebody knows to look for the sentence that isn't there.

import { describe, expect, it } from 'vitest';
import { summariseChanges } from './change-language';
import type { RunChanges, Scan, ScanSummary } from '../api/types';

function scan(): Pick<Scan, 'score'> {
  return {
    score: {
      pillars: [],
      counts: { pass: 5, fail: 5, partial: 0, unmeasurable: 0, 'not-applicable': 0, 'satisfied-by-architecture': 0 },
      scoredControls: 10,
      totalControls: 10,
      composition: { observed: 10, 'admin-collected': 0, attested: 0 },
      overall: 50,
    },
  };
}

function previousRun(): Pick<ScanSummary, 'counts'> {
  return { counts: { pass: 5, fail: 5, partial: 0, unmeasurable: 0, notApplicable: 0 } };
}

function changes(overrides: Partial<RunChanges> = {}): RunChanges {
  return { comparable: true, changes: [], unobserved: [], ...overrides };
}

describe('what the page says about a run it cannot compare', () => {
  it('says there is nothing to compare a first run against', () => {
    expect(summariseChanges(scan(), undefined, undefined)).toEqual([
      'This is the first recorded run, so there is nothing to compare it against yet.',
    ]);
  });

  it('gives the refusal and nothing else, so no line reads as a measurement', () => {
    const lines = summariseChanges(
      scan(),
      changes({ comparable: false, reason: 'These scans ran as different identities.' }),
      previousRun(),
    );

    expect(lines).toEqual(['These scans ran as different identities.']);
  });
});

describe('the coverage comparison', () => {
  /**
   * The two sides of the subtraction, for one run, in the two shapes the app stores them in.
   *
   * A run is kept whole and also summarised, and coverage has to come out the same from either. It did
   * not: the run side divided the deduplicated scoring count by the applicable count, the summary side
   * divided the outcome tally by it, and where a catalogue aliases controls those are different
   * numbers. Two runs of an unchanged estate minutes apart reported "coverage fell from 29% to 20%".
   */
  function bothShapes(counts: { pass: number; partial: number; fail: number; unmeasurable: number; notApplicable: number }, scoredControls: number) {
    return {
      whole: {
        score: {
          ...scan().score,
          counts: {
            pass: counts.pass,
            partial: counts.partial,
            fail: counts.fail,
            unmeasurable: counts.unmeasurable,
            'not-applicable': counts.notApplicable,
            'satisfied-by-architecture': 0,
          },
          scoredControls,
          totalControls: counts.pass + counts.partial + counts.fail + counts.unmeasurable + counts.notApplicable,
        },
      } satisfies Pick<Scan, 'score'>,
      summary: { counts } satisfies Pick<ScanSummary, 'counts'>,
    };
  }

  it('reports no change between a run and its own summary, whatever the catalogue aliases', () => {
    const run = bothShapes({ pass: 29, partial: 7, fail: 13, unmeasurable: 120, notApplicable: 15 }, 34);

    expect(summariseChanges(run.whole, changes(), run.summary)).toContain(
      'Coverage is unchanged: the same requirements could be answered as last time.',
    );
  });

  it('still reports a real change, so the fix did not silence the comparison', () => {
    // Eleven more requirements answered on the same catalogue: 49 of 169, then 60 of 169.
    const now = bothShapes({ pass: 40, partial: 10, fail: 10, unmeasurable: 109, notApplicable: 15 }, 34);
    const then = bothShapes({ pass: 29, partial: 7, fail: 13, unmeasurable: 120, notApplicable: 15 }, 34);

    expect(summariseChanges(now.whole, changes(), then.summary)).toContain(
      'Coverage increased from 29% to 36% of applicable requirements.',
    );
  });
});

describe('what the page says about a run it can compare', () => {
  it('does not report an unchanged carried-forward pillar as a pillar that held', () => {
    const lines = summariseChanges(scan(), changes({ unobserved: ['reliability'] }), previousRun());

    expect(lines.join(' ')).toContain('were not observed, so that is not evidence they held');
  });

  it('reports no requirement changed when everything was actually measured', () => {
    const lines = summariseChanges(scan(), changes(), previousRun());

    expect(lines).toContain('No requirement changed outcome since the previous run.');
  });

  it('treats a movement below a tenth of a point as no movement rather than rounding it to zero', () => {
    const lines = summariseChanges(scan(), changes({ overallDelta: 0.01 }), previousRun());

    expect(lines).toContain('No posture change.');
  });

  it('gives a movement within one catalogue version as a single figure', () => {
    const lines = summariseChanges(scan(), changes({ overallDelta: -4 }), previousRun());

    expect(lines).toContain('Measured posture moved -4.0 points.');
  });
});

describe('a coverage fall', () => {
  /** A run that answered three of ten and could not read the rest, against a run that answered all ten. */
  function fell(unreadable: number): Pick<Scan, 'score'> {
    const built = scan();
    return {
      score: {
        ...built.score,
        counts: { ...built.score.counts, pass: 3, fail: 0, unmeasurable: 7 },
        scoredControls: 3,
        pillars: [
          {
            pillarId: 'reliability',
            score: 60,
            counts: { pass: 3, partial: 0, fail: 0, unmeasurable: 7, 'not-applicable': 0, 'satisfied-by-architecture': 0 },
            scored: 3,
            unmeasurable: 7,
            unmeasuredBy: { attestation: 0, unreachable: 0, unbuilt: 0, unreadable, disabled: 0 },
            composition: { observed: 3, 'admin-collected': 0, attested: 0 },
            notApplicable: 0,
            total: 10,
            worstFirst: [],
          },
        ],
      },
    };
  }

  it('names the readings behind it, so the reader does not conclude their estate got worse', () => {
    const lines = summariseChanges(fell(7), changes(), previousRun());

    expect(lines).toContain('Coverage fell from 100% to 30% of applicable requirements.');
    expect(lines.join(' ')).toContain('7 requirements could not be read on this run');
  });

  it('claims only some of the fall, because this run cannot establish what the last one read', () => {
    const lines = summariseChanges(fell(7), changes(), previousRun());

    expect(lines.join(' ')).toContain('some of that fall is what the app could reach rather than what the estate did');
  });

  it('says nothing about readings when the fall is not one, so a rise is not explained away', () => {
    const risen = summariseChanges(scan(), changes(), {
      counts: { pass: 2, fail: 0, partial: 0, unmeasurable: 8, notApplicable: 0 },
    });

    expect(risen).toContain('Coverage increased from 20% to 100% of applicable requirements.');
    expect(risen.join(' ')).not.toContain('could not be read');
  });

  it('says nothing about readings when every requirement was read, so the fall stands as the estate', () => {
    expect(summariseChanges(fell(0), changes(), previousRun()).join(' ')).not.toContain('could not be read');
  });
});

describe('a movement that crosses a catalogue version', () => {
  const across = changes({
    overallDelta: -4,
    attribution: { estate: -1, catalogue: -3, stable: 180, added: 2, removed: 0, renamed: 0, reweighted: 0 },
    caveat: 'The catalogue moved from version 9 to 10 between these runs (2 added).',
  });

  it('names how much of the fall is the estate and how much is the requirement set', () => {
    const line = summariseChanges(scan(), across, previousRun()).find((one) => one.includes('Measured posture'));

    expect(line).toContain('-1.0 from the estate');
    expect(line).toContain('-3.0 from the requirements themselves changing');
  });

  it('says what the estate half was measured over, so the reader can weigh it', () => {
    const line = summariseChanges(scan(), across, previousRun()).find((one) => one.includes('Measured posture'));

    expect(line).toContain('180 requirements both runs asked in the same terms');
  });

  it('shows two halves that add up to the total, whatever the rounding', () => {
    // The server derives the catalogue half by subtracting the estate half from the total, precisely
    // so the two add up to the figure on the page. Rounding all three for display independently
    // gives that away again: +0.45 and +0.55 inside a +1.0 total print as +0.5 and +0.6, and a
    // reader who adds up the sentence finds it contradicts itself.
    const rounding = changes({
      overallDelta: 1,
      attribution: { estate: 0.45, catalogue: 0.55, stable: 180, added: 1, removed: 0, renamed: 0, reweighted: 0 },
    });

    const line = summariseChanges(scan(), rounding, previousRun()).find((one) => one.includes('Measured posture'));

    expect(line).toContain('+1.0 points');
    expect(line).toContain('+0.5 from the estate');
    expect(line).toContain('+0.5 from the requirements themselves changing');
  });

  it('puts the qualification last, where it qualifies rather than replaces', () => {
    const lines = summariseChanges(scan(), across, previousRun());

    expect(lines.at(-1)).toContain('The catalogue moved from version 9 to 10');
  });

  it('leaves the split out entirely when there is nothing to split', () => {
    const lines = summariseChanges(scan(), changes({ overallDelta: -4 }), previousRun());

    expect(lines.join(' ')).not.toContain('from the estate');
  });
});
