import { describe, expect, it } from 'vitest';
import { evidenceGaps, pillarList } from './evidence-gaps';
import type { GapPlan, GapSource } from './evidence-gaps';
import type { Unmeasured } from '../api/types';

const NONE: Readonly<Record<Unmeasured, number>> = {
  attestation: 0,
  unreachable: 0,
  unbuilt: 0,
  unreadable: 0,
  disabled: 0,
};

/**
 * Enough of a run for the arithmetic: what went unanswered per pillar, and any silent collector.
 *
 * The header count is derived here the way the score derives it — every kind of unmeasured, summed —
 * so that a reason with no row shows up as rows that fall short of it. Hard-coding the expected total
 * in each test instead was how a fifth kind arrived without one.
 */
function run(unmeasuredBy: Partial<Record<Unmeasured, number>>, silent = 0, notApplicable = 0): GapSource {
  const by = { ...NONE, ...unmeasuredBy };

  return {
    id: 'scan-1',
    score: {
      pillars: [{ pillarId: 'security', unmeasuredBy: by, notApplicable }],
      counts: { unmeasurable: Object.values(by).reduce((sum, count) => sum + count, 0) },
    },
    signals: Array.from({ length: silent }, (_, index) => ({
      status: 'unmeasurable' as const,
      unmeasurableReason: `collector ${String(index)} returned nothing`,
    })),
  };
}

/** The rule the module exists to keep, as one assertion so every case below can make it. */
function addsUp(scan: GapSource, plan?: GapPlan): boolean {
  const counted = evidenceGaps(scan, plan, title).filter((gap) => gap.counted);

  return counted.reduce((sum, gap) => sum + gap.blocked, 0) === scan.score.counts.unmeasurable;
}

const title = (pillarId: string) => (pillarId === 'security' ? 'Security, compliance and privacy' : pillarId);

describe('evidenceGaps', () => {
  it('adds its counted rows up to the number the panel puts in its header', () => {
    // The defect this replaces: the scope row was taken from the plan, which counts a control the
    // reach classifier also sends to attestation, so the rows read 67 and 55 under a header of 105.
    const scan = run({ attestation: 67, unreachable: 38 }, 1);
    const counted = evidenceGaps(scan, undefined, title).filter((gap) => gap.counted);

    expect(scan.score.counts.unmeasurable).toBe(105);
    expect(counted.reduce((sum, gap) => sum + gap.blocked, 0)).toBe(105);
    expect(counted.map((gap) => gap.id)).toEqual(['attestation', 'blocked-scope']);
  });

  it('gives every reason a requirement can go unanswered a row, so none of them goes missing', () => {
    // A reason with no row was not a hypothetical: `disabled` arrived as a fifth kind and this panel
    // deliberately left it out, so a run with three of them showed 2 under a header of 5. Asserting
    // per known kind rather than per row means the next kind fails here instead of shipping.
    const kinds: readonly Unmeasured[] = ['attestation', 'unreachable', 'unbuilt', 'unreadable', 'disabled'];

    for (const kind of kinds) {
      expect(addsUp(run({ [kind]: 3 }))).toBe(true);
    }
  });

  it('holds the sum when there are more reasons than the panel shows', () => {
    // Seven rows are possible and five are returned, so dropping by size alone drops counted reasons:
    // on this case the two smallest counted rows are `disabled` at 4 and `unbuilt` at 1, and the panel
    // read 125 of 130. Measured with the size-only sort restored, rather than reasoned about.
    const scan = run({ attestation: 67, unreachable: 38, unbuilt: 1, unreadable: 20, disabled: 4 }, 9);
    const plan: GapPlan = {
      pillars: [{ title: 'Interoperability and usability', measured: false, totalControls: 12 }],
    };
    const gaps = evidenceGaps(scan, plan, title);

    expect(gaps).toHaveLength(5);
    expect(gaps.every((gap) => gap.counted)).toBe(true);
    expect(addsUp(scan, plan)).toBe(true);
  });

  it('says what a switched-off check costs without offering to put it right', () => {
    const row = evidenceGaps(run({ disabled: 4 }), undefined, title).find((gap) => gap.id === 'disabled');

    // No action: the owner, the reason and the dates belong to a surface row 31b has not built. And
    // the sentence reports the decision rather than classifying it as a fault to resolve.
    expect(row?.action).toBeUndefined();
    expect(row?.counted).toBe(true);
    expect(row?.resolve).not.toMatch(/should|must|switch (them|it) back|fix/i);

    // Two claims this sentence has made and had to retract, pinned because nothing held them and it was
    // wrong twice. "The app did not ask" contradicts ADR 0059's second amendment, which lapses a
    // decision when the reading turns `fail` and can only do that by reading on every run. And "not
    // counted for or against you" is false in both directions: the same ADR measures a disabled
    // requirement taking a pillar from 50 to 100, and a disabled requirement tips `underGranted`.
    expect(row?.resolve).not.toMatch(/did not ask|never asked|didn.t ask/i);
    expect(row?.resolve).not.toMatch(/not counted|neither counted|for or against/i);
  });

  it('never returns more counted rows than the cap can show', () => {
    // The sum above holds because five counted reasons fit a cap of five exactly, which the ordering
    // relies on and nothing states. A sixth counted kind would truncate one silently and the header
    // would stop matching its rows — this fails first instead.
    // The excluded row is the largest thing on the list here and still may not take a slot from a
    // counted one, which is what the counted-first sort is for.
    const everything = evidenceGaps(
      run({ attestation: 1, unreachable: 1, unbuilt: 1, unreadable: 1, disabled: 1 }, 3, 28),
      { pillars: [{ title: 'Interoperability and usability', measured: false, totalControls: 12 }] },
      title
    );

    expect(everything.filter((gap) => gap.counted)).toHaveLength(5);
    expect(everything).toHaveLength(5);
  });

  it('keeps a row about something other than a requirement out of that sum', () => {
    const silent = evidenceGaps(run({ attestation: 67 }, 1), undefined, title).find(
      (gap) => gap.id === 'silent-signals'
    );

    expect(silent?.counted).toBe(false);
    // The count has to survive somewhere, so it is in the sentence the reader reads.
    expect(silent?.title).toBe('One collector returned nothing');
  });

  it('reports what left the score without adding it to the count of what went unanswered in it', () => {
    // The omission this closes: 28 excluded and 25 unanswered, and the panel showed only the 25.
    const scan = run({ attestation: 25 }, 0, 28);
    const row = evidenceGaps(scan, undefined, title).find((gap) => gap.id === 'not-applicable');

    expect(row?.counted).toBe(false);
    expect(row?.title).toBe('28 requirements that do not apply to this estate');
    expect(row?.pillars).toEqual(['Security, compliance and privacy']);
    expect(addsUp(scan)).toBe(true);
  });

  it('does not describe an excluded requirement as one the run failed to answer', () => {
    const row = evidenceGaps(run({}, 0, 28), undefined, title).find((gap) => gap.id === 'not-applicable');

    // Both levers or neither: the field under this sentence is one total, so it may not say which
    // of the two put a given requirement outside the score.
    expect(row?.resolve).toMatch(/precondition/i);
    expect(row?.resolve).toMatch(/decision/i);
    expect(row?.resolve).not.toMatch(/could not (read|answer)|failed to|blocked/i);
  });

  it('states the requirement count of an unassessed pillar in its title, since it is not in the header', () => {
    const plan: GapPlan = {
      pillars: [
        { title: 'Interoperability and usability', measured: false, totalControls: 12 },
        { title: 'Reliability', measured: true, totalControls: 17 },
      ],
    };
    const row = evidenceGaps(run({ attestation: 4 }), plan, title).find((gap) => gap.id === 'unassessed-pillars');

    expect(row?.counted).toBe(false);
    expect(row?.title).toBe('12 requirements in a pillar this version does not assess');
  });

  it('omits a reason that blocked nothing rather than showing a zero', () => {
    expect(evidenceGaps(run({ attestation: 4 }), undefined, title).map((gap) => gap.id)).toEqual(['attestation']);
  });

  it('orders by what is blocking most, because that is what is worth unblocking first', () => {
    const gaps = evidenceGaps(run({ attestation: 10, unreachable: 40 }), undefined, title);
    expect(gaps.map((gap) => gap.blocked)).toEqual([40, 10]);
  });

  it('names the pillars a gap belongs to, and the estate where it belongs to none', () => {
    const gaps = evidenceGaps(run({ attestation: 4 }), undefined, title);
    expect(gaps[0]?.pillars).toEqual(['Security, compliance and privacy']);
    expect(pillarList([])).toBe('Across the estate');
    expect(pillarList(['One', 'Two'])).toBe('One and Two');
    expect(pillarList(['One', 'Two', 'Three', 'Four'])).toBe('One, Two and 2 more');
  });
});
