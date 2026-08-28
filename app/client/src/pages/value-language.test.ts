// The sentences that could turn four figures into one.
//
// Every test here holds a phrase to saying no more than the field under it. The one worth reading is
// the first: `movementPhrase` writes both readings and no difference, because a difference asserts the
// two are comparable and only the server's `incomparable` knows whether they are.

import { describe, expect, it } from 'vitest';
import type { AdviceReading, ValueMoney } from '../api/types';
import {
  STANDING_LABEL,
  incomparablePhrase,
  measuredOver,
  moneyPhrase,
  moneySource,
  movementPhrase,
  readingPhrase,
} from './value-language';

function reading(over: Partial<AdviceReading> = {}): AdviceReading {
  return {
    advisoryId: 'adv-2',
    measuredAt: '2026-08-01T09:00:00.000Z',
    lookbackDays: 30,
    standing: 'still-firing',
    movements: [],
    unmatched: [],
    ...over,
  };
}

function money(over: Partial<ValueMoney> = {}): ValueMoney {
  return {
    advisor: 'serverless',
    low: 1000,
    high: 1400,
    currency: 'USD',
    region: 'us-east-1',
    resources: 3,
    actions: 3,
    assumptions: [],
    ...over,
  };
}

describe('a measure read twice', () => {
  it('writes both readings and never their difference', () => {
    const phrase = movementPhrase({ label: 'Failed runs', unit: 'count', before: 12, after: 4 });

    expect(phrase).toBe('Failed runs: 12 then, 4 now');
    expect(phrase).not.toContain('8');
  });

  it('writes both at the same scale, so neither reads as the smaller number', () => {
    // Two readings in bytes, one of which crosses a magnitude. Formatted separately by hand, this is
    // where "900 MiB then, 1.2 GiB now" comes from and where a reader concludes the smaller is worse.
    expect(movementPhrase({ label: 'Spilled', unit: 'bytes', before: 3_221_225_472, after: 1_073_741_824 })).toBe(
      'Spilled: 3 GiB then, 1 GiB now'
    );
  });

  it('says why two readings may not be subtracted, in terms of the apparatus', () => {
    expect(incomparablePhrase('window')).toContain('different numbers of days');
    expect(incomparablePhrase('rules-version')).toContain('different versions of the rules');
  });
});

describe('what a later advisory said', () => {
  it('does not describe a rule that stopped firing as work that landed', () => {
    // The sentence a reader most wants to read the other way. What the payload holds is that a later
    // run read the resource and did not report the rule; whether the work landed, the job stopped
    // running, or the window rolled past it is not in there.
    const phrase = readingPhrase(reading({ standing: 'cleared' }));

    expect(phrase).toContain('read this resource and did not report this rule');
    expect(phrase).not.toMatch(/fixed|resolved|done/);
    expect(STANDING_LABEL.cleared).toBe('No longer reported');
  });

  it('does not describe a resource missing from the later run as one reported clear', () => {
    expect(readingPhrase(reading({ standing: 'resource-absent' }))).toContain('not the same as reporting it clear');
  });

  it('says which run each sentence is about, by the day it finished', () => {
    expect(readingPhrase(reading({ standing: 'still-firing' }))).toContain('2026-08-01');
  });

  it('says nothing about a resource where the analysis never formed', () => {
    expect(readingPhrase(reading({ standing: 'advisor-unread' }))).toContain('formed no analysis');
  });
});

describe('an advisor’s money', () => {
  it('says what the range is over, which is resources and not actions', () => {
    expect(moneyPhrase(money({ resources: 3, actions: 5 }))).toBe(
      'Between $1,000 and $1,400 across 3 resources, carrying 5 actions'
    );
  });

  it('leaves the second count out where it would say the same thing twice', () => {
    expect(moneyPhrase(money({ resources: 3, actions: 3 }))).toBe('Between $1,000 and $1,400 across 3 resources');
  });

  it('collapses to one figure where the advisor gave no range', () => {
    expect(moneyPhrase(money({ low: 1200, high: 1200 }))).toContain('About $1,200');
  });

  it('names whose arithmetic it is, because an unattributed range is a promise', () => {
    expect(moneySource(money())).toBe("serverless readiness's own estimate priced in us-east-1, in USD.");
  });

  it('leaves the region out once two resources came from different price lists', () => {
    const { region: _region, ...priced } = money();

    expect(moneySource(priced)).toBe("serverless readiness's own estimate, in USD.");
  });
});

describe('a realised total', () => {
  it('says how many measurements it is over, so neither reading is a figure over nothing', () => {
    expect(
      measuredOver({ advisor: 'jobs', label: 'Failed runs', unit: 'count', before: 24, after: 8, measurements: 2 })
    ).toBe('job health, over 2 measurements');
  });

  it('counts one in the singular', () => {
    expect(
      measuredOver({ advisor: 'jobs', label: 'Failed runs', unit: 'count', before: 12, after: 4, measurements: 1 })
    ).toBe('job health, over 1 measurement');
  });
});
