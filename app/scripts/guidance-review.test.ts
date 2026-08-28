// Whether the staleness gate can fire, and whether it fires on the right day.
//
// Every review date in the tree is days old, so `npm run verify` exercises exactly one branch of this
// — the one where nothing is wrong. The first real run is six months away, and a gate whose first run
// is six months away is an intention rather than a check: if the boundary is off by a month, or a
// future date turns out to buy silence, nobody finds out until the content it was protecting has
// already gone stale.
//
// So these tests are mostly about the boundaries and about the ways the gate could be *disabled*
// rather than tripped, which is the direction with no symptom.

import { describe, expect, it } from 'vitest';
import {
  AGEING_MONTHS,
  OURS_WITHIN_DAYS,
  STALE_MONTHS,
  addMonths,
  asDate,
  attributeCitation,
  monthsBetween,
  reviewStanding,
} from './guidance-review.mjs';

/** One authored entry reviewed on `reviewed`. */
function entry(reviewed: unknown, id = 'CO-01-01') {
  return { id, file: 'cost-optimization.yaml', reviewed };
}

const on = (text: string) => {
  const at = asDate(text);
  if (at == null) throw new Error(`test wrote an unparseable date: ${text}`);
  return at;
};

describe('asDate', () => {
  it('reads a plain ISO date as UTC', () => {
    const at = asDate('2026-08-05');
    expect(at?.toISOString()).toBe('2026-08-05T00:00:00.000Z');
  });

  it('refuses a date that does not exist rather than rolling it forward', () => {
    // `new Date('2026-02-30')` is 2 March in some runtimes. A gate that silently moved a deadline
    // three days later would be wrong in the direction nobody checks.
    expect(asDate('2026-02-30')).toBeNull();
    expect(asDate('2026-13-01')).toBeNull();
  });

  it('refuses anything that is not exactly YYYY-MM-DD', () => {
    expect(asDate('2026')).toBeNull();
    expect(asDate('2026-8-5')).toBeNull();
    expect(asDate('05/08/2026')).toBeNull();
    expect(asDate('')).toBeNull();
    expect(asDate(undefined)).toBeNull();
    expect(asDate(null)).toBeNull();
    expect(asDate(20260805)).toBeNull();
    expect(asDate(new Date())).toBeNull();
  });

  it('tolerates surrounding whitespace, which a YAML edit can leave behind', () => {
    expect(asDate(' 2026-08-05 ')?.toISOString()).toBe('2026-08-05T00:00:00.000Z');
  });
});

describe('addMonths', () => {
  it('advances by calendar months', () => {
    expect(addMonths(on('2026-01-15'), 6).toISOString()).toBe('2026-07-15T00:00:00.000Z');
    expect(addMonths(on('2026-01-15'), 12).toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });

  it('clamps to the end of the target month instead of rolling into the next one', () => {
    // Without the clamp this is 3 March, which would give an entry reviewed on 31 August three extra
    // days of grace for no stated reason.
    expect(addMonths(on('2025-08-31'), 6).toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(addMonths(on('2023-08-31'), 6).toISOString()).toBe('2024-02-29T00:00:00.000Z');
    expect(addMonths(on('2026-01-31'), 1).toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });

  it('crosses a year boundary', () => {
    expect(addMonths(on('2026-11-30'), 6).toISOString()).toBe('2027-05-30T00:00:00.000Z');
  });
});

describe('monthsBetween', () => {
  it('rounds down to whole months', () => {
    expect(monthsBetween(on('2026-01-15'), on('2026-07-14'))).toBe(5);
    expect(monthsBetween(on('2026-01-15'), on('2026-07-15'))).toBe(6);
    expect(monthsBetween(on('2026-01-15'), on('2026-07-16'))).toBe(6);
  });

  it('is zero within the same month', () => {
    expect(monthsBetween(on('2026-08-01'), on('2026-08-31'))).toBe(0);
  });
});

describe('reviewStanding', () => {
  it('leaves a recently reviewed entry alone', () => {
    const standing = reviewStanding([entry('2026-08-03')], on('2026-08-05'));
    expect(standing.fresh).toHaveLength(1);
    expect(standing.ageing).toHaveLength(0);
    expect(standing.stale).toHaveLength(0);
  });

  it('warns on the day it turns six months old, not the day after', () => {
    const reviewed = '2026-02-15';
    expect(reviewStanding([entry(reviewed)], on('2026-08-14')).fresh).toHaveLength(1);
    expect(reviewStanding([entry(reviewed)], on('2026-08-15')).ageing).toHaveLength(1);
  });

  it('fails on the day it turns twelve months old, and warns until then', () => {
    const reviewed = '2026-02-15';
    expect(reviewStanding([entry(reviewed)], on('2027-02-14')).ageing).toHaveLength(1);
    expect(reviewStanding([entry(reviewed)], on('2027-02-15')).stale).toHaveLength(1);
  });

  it('puts an entry in exactly one bucket', () => {
    const standing = reviewStanding(
      [entry('2026-08-01', 'a'), entry('2026-01-01', 'b'), entry('2024-01-01', 'c')],
      on('2026-08-05')
    );
    expect(standing.fresh.map((one) => one.id)).toEqual(['a']);
    expect(standing.ageing.map((one) => one.id)).toEqual(['b']);
    expect(standing.stale.map((one) => one.id)).toEqual(['c']);
    expect(standing.undated).toHaveLength(0);
    expect(standing.ahead).toHaveLength(0);
  });

  it('reports a future date rather than treating it as fresh', () => {
    // The failure mode worth naming: a year keyed as 2027 reads as diligence and would buy silence
    // until 2028. Every other bucket would be a lie about this entry.
    const standing = reviewStanding([entry('2027-08-03')], on('2026-08-05'));
    expect(standing.ahead).toHaveLength(1);
    expect(standing.fresh).toHaveLength(0);
    expect(standing.stale).toHaveLength(0);
  });

  it('reports an unreadable date rather than passing it', () => {
    const standing = reviewStanding(
      [entry(undefined, 'a'), entry('soon', 'b'), entry('2026-02-30', 'c')],
      on('2026-08-05')
    );
    expect(standing.undated.map((one) => one.id)).toEqual(['a', 'b', 'c']);
    expect(standing.fresh).toHaveLength(0);
  });

  it('reports how many months old each entry is, for a message a reader can act on', () => {
    const standing = reviewStanding([entry('2025-02-15')], on('2026-08-05'));
    expect(standing.stale[0]?.months).toBe(17);
  });

  it('sorts the worst first within a bucket', () => {
    const standing = reviewStanding(
      [entry('2024-06-01', 'newer'), entry('2023-01-01', 'oldest'), entry('2024-01-01', 'middle')],
      on('2026-08-05')
    );
    expect(standing.stale.map((one) => one.id)).toEqual(['oldest', 'middle', 'newer']);
  });

  it('holds nothing when given nothing, rather than inventing a pass', () => {
    const standing = reviewStanding([], on('2026-08-05'));
    expect(standing.fresh).toHaveLength(0);
    expect(standing.stale).toHaveLength(0);
  });

  it('keeps the two thresholds in the order the messages assume', () => {
    expect(AGEING_MONTHS).toBeLessThan(STALE_MONTHS);
  });
});

// The branch a reader will actually be reading is the one that cannot run today: every URL in the
// tree was committed days ago, so a real scheduled run can only produce "recent". The long-standing
// case is what a failure in a year looks like, and getting it backwards would tell somebody to go and
// fix a citation that was right all along.
describe('attributeCitation', () => {
  const today = on('2026-08-05');

  it('blames the page when the citation has sat unchanged for months', () => {
    const said = attributeCitation({ known: true, since: '2026-01-05' }, today);
    expect(said).toContain('the page moved rather than the citation');
    expect(said).toContain('about 7 months');
  });

  it('blames the citation when it was added within the recent window', () => {
    const said = attributeCitation({ known: true, since: '2026-08-03' }, today);
    expect(said).toContain('2 days ago');
    expect(said).toContain('the citation is the likelier fault');
  });

  it('switches sides exactly at the window, not a day early', () => {
    const inside = addMonths(today, 0);
    inside.setUTCDate(inside.getUTCDate() - OURS_WITHIN_DAYS);
    const outside = addMonths(today, 0);
    outside.setUTCDate(outside.getUTCDate() - OURS_WITHIN_DAYS - 1);
    const iso = (at: Date) => at.toISOString().slice(0, 10);

    expect(attributeCitation({ known: true, since: iso(inside) }, today)).toContain('likelier fault');
    expect(attributeCitation({ known: true, since: iso(outside) }, today)).toContain('the page moved');
  });

  it('says an uncommitted citation is new work here, rather than calling it unknown', () => {
    // The strongest signal available and the one case a reader can act on immediately. Reporting it as
    // an unknown date threw that away, which is what this replaced.
    const said = attributeCitation({ known: true, uncommitted: true }, today);
    expect(said).toContain('not committed yet');
    expect(said).not.toContain('unknown');
  });

  it('admits when there is no history to reason from', () => {
    const said = attributeCitation({ known: false }, today);
    expect(said).toContain('no git history');
  });

  it('refuses to attribute an unreadable date', () => {
    expect(attributeCitation({ known: true, since: 'last spring' }, today)).toContain('unreadable date');
  });

  it('refuses to attribute a date after today rather than claiming the page moved', () => {
    const said = attributeCitation({ known: true, since: '2027-01-01' }, today);
    expect(said).toContain('check the clock');
    expect(said).not.toContain('the page moved');
  });

  it('reports days rather than months for a gap just past the window', () => {
    const said = attributeCitation({ known: true, since: '2026-07-20' }, today);
    expect(said).toContain('16 days');
    expect(said).toContain('the page moved');
  });
});
