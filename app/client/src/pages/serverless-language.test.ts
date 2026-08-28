// The sentences that carry a number, asserted.
//
// The cost phrasing is the reason this file exists. It is the one figure on the page somebody
// might repeat in a budget conversation, so it has to read as a range with two ends, collapse
// honestly when the ends coincide, and never assert a saving when the arithmetic could go the
// other way. Each of those is a test.

import { describe, expect, it } from 'vitest';
import {
  carriedPhrase,
  costPhrase,
  money,
  ratePhrase,
  savingPhrase,
  shareSentence,
  startupPhrase,
  VERDICT_DETAIL,
  VERDICT_LABEL,
  VERDICTS,
} from './serverless-language';

describe('the cost range', () => {
  it('reads as two ends rather than as a figure', () => {
    expect(costPhrase({ low: 600, high: 900, currency: 'USD' })).toBe('between $600 and $900');
  });

  it('collapses to one figure when there was no start-up time to span', () => {
    expect(costPhrase({ low: 900, high: 900, currency: 'USD' })).toBe('about $900');
  });

  it('says nothing at all when there is no estimate', () => {
    expect(costPhrase(undefined)).toBeUndefined();
  });

  it('keeps the cents on a small amount and drops them on a large one', () => {
    expect(money(4.5, 'USD')).toBe('$4.50');
    expect(money(12_481.37, 'USD')).toBe('$12,481');
  });

  it('prints an unknown currency code beside the number rather than throwing', () => {
    expect(money(120, 'NOTACURRENCY')).toBe('120 NOTACURRENCY');
  });
});

describe('which rate was used', () => {
  it('says the region as a place rather than as a SKU suffix', () => {
    expect(ratePhrase('US_EAST_N_VIRGINIA')).toBe(
      'Priced at the published serverless jobs rate for us east n virginia.'
    );
  });

  // Silence rather than a sentence about an absent region: the message explaining why there is
  // no estimate at all is the one that belongs there, and two of them would contradict.
  it('says nothing when no region was established', () => {
    expect(ratePhrase(undefined)).toBeUndefined();
    expect(ratePhrase('')).toBeUndefined();
  });
});

describe('what the move is worth', () => {
  it('states a saving when both ends of the range are cheaper', () => {
    expect(savingPhrase(1000, { low: 600, high: 800, currency: 'USD' })).toBe('Between $200 and $400 less');
  });

  // The case a page that only ever said "saving" would hide.
  it('states an increase when both ends are dearer', () => {
    expect(savingPhrase(500, { low: 700, high: 900, currency: 'USD' })).toBe('Between $200 and $400 more');
  });

  it('claims no direction when the range straddles the present cost', () => {
    expect(savingPhrase(800, { low: 600, high: 900, currency: 'USD' })).toBe(
      'Somewhere between $100 more and $200 less'
    );
  });

  it('says nothing when there is no cost to compare against', () => {
    expect(savingPhrase(undefined, { low: 1, high: 2, currency: 'USD' })).toBeUndefined();
    expect(savingPhrase(0, { low: 1, high: 2, currency: 'USD' })).toBeUndefined();
    expect(savingPhrase(100, undefined)).toBeUndefined();
  });
});

describe('start-up time', () => {
  it('says what share of the bill was waiting', () => {
    expect(startupPhrase(0.25)).toBe('25% of its billed time was cluster start-up, which serverless does not charge for.');
  });

  it('does not round a tiny share down to zero percent', () => {
    expect(startupPhrase(0.004)).toContain('Under 1%');
  });

  it('says nothing when no start-up time was measured', () => {
    expect(startupPhrase(0)).toBeUndefined();
    expect(startupPhrase(undefined)).toBeUndefined();
  });
});

describe('where the estate stands', () => {
  const estate = { jobsRan: 100, alreadyServerless: 40, onWarehouse: 10, lookbackDays: 30 };

  it('counts what ran, what is already serverless, and what is left', () => {
    const sentence = shareSentence(estate);
    expect(sentence).toContain('100 jobs ran in the last 30 days');
    expect(sentence).toContain('40 already ran entirely on serverless');
    expect(sentence).toContain('50 jobs still used classic compute');
  });

  it('sets warehouse-only jobs aside as a separate question', () => {
    expect(shareSentence(estate)).toContain('SQL warehouses');
  });

  it('says nothing ran rather than reporting zero of everything', () => {
    expect(shareSentence({ ...estate, jobsRan: 0, alreadyServerless: 0, onWarehouse: 0 })).toBe(
      'No job ran in the last 30 days, so there is nothing to assess.'
    );
  });

  it('says the work is done when everything already moved', () => {
    expect(shareSentence({ jobsRan: 12, alreadyServerless: 12, onWarehouse: 0, lookbackDays: 7 })).toContain(
      'Nothing to move'
    );
  });

  it('agrees with itself about one job', () => {
    expect(shareSentence({ jobsRan: 1, alreadyServerless: 0, onWarehouse: 0, lookbackDays: 30 })).toContain('1 job ran');
  });
});

describe('a carried-forward analysis', () => {
  it('dates it to the run that read it, not the run showing it', () => {
    expect(carriedPhrase({ measuredAt: '2026-07-01T10:00:00.000Z' })).toContain('Jul 1, 2026');
  });

  it('says so rather than throwing when the date cannot be read', () => {
    expect(carriedPhrase({ measuredAt: 'not a date' })).toContain('could not be read');
  });

  it('says nothing for an analysis this run produced', () => {
    expect(carriedPhrase(undefined)).toBeUndefined();
  });
});

describe('the verdicts', () => {
  it('lists worst first, so the row that changes a plan is at the top', () => {
    expect(VERDICTS[0]).toBe('blocked');
    expect(VERDICTS.at(-1)).toBe('ready');
  });

  it('hedges the positive verdict, because this reads compute and not code', () => {
    expect(VERDICT_LABEL.ready).toBe('Could move');
    expect(VERDICT_DETAIL.ready).toContain('not the same as');
  });

  it('says the undeterminable verdict is not a clean bill of health', () => {
    expect(VERDICT_DETAIL.unknown).toContain('No verdict');
    expect(VERDICT_DETAIL.unknown).toContain('not a clean bill of health');
  });

  it('says a blocker was named without saying where it was read from', () => {
    /*
     * Two rules produce this verdict and they read different things: `gpu-cluster` reads the compute, and
     * `run-exceeds-seven-days` reads how long the run took (`server/analyze/serverless.ts:338,341`). A sentence
     * saying every blocker was "read from the compute it ran on" is false of the second, and the wording before
     * that predicted what serverless could run. Both are pinned absent.
     */
    expect(VERDICT_DETAIL.blocked).toContain('for a reason named against each job');
    expect(VERDICT_DETAIL.blocked).not.toMatch(/read from the compute|cannot run this work/);
  });

  it('has a label and a detail for every verdict', () => {
    for (const verdict of VERDICTS) {
      expect(VERDICT_LABEL[verdict]).toBeTruthy();
      expect(VERDICT_DETAIL[verdict].length).toBeGreaterThan(40);
    }
  });
});
