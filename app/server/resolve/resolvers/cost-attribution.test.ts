// CO-03-01, the tagging share, and what it does when the bill it reads is not fully priced.
//
// The control had no test of its own. It acquired a price-coverage guard in Q1c and, like the two
// compute-mix controls beside it, checked its monetary total for zero one line above that guard —
// which is unreachable in the case it was written for, because the total is priced rows only.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { COMPLETE, observed, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { CostAttribution } from '../../collect/sql/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const ATTRIBUTION = 'sql:cost.attribution' as SignalId;

const catalogue = loadCatalogue();
const registry = buildRegistry();

/** Nothing billed and nothing priced, so each test states only the figures it is about. */
function attribution(over: Partial<CostAttribution> = {}): CostAttribution {
  return {
    usageRecords: 0,
    pricedRecords: 0,
    unpricedRecords: 0,
    leastPricedUnit: 'DBU',
    leastPricedShare: 1,
    usageUnitCount: 1,
    currencies: 1,
    duplicatePriceMatches: 0,
    listCost: 0,
    customTaggedCost: 0,
    identifiableCost: 0,
    tagKeys: [],
    currency: 'USD',
    ...over,
  };
}

function findingFor(reading: CostAttribution) {
  const spec = catalogue.controls.find((control) => control.id === 'CO-03-01');
  if (spec == null) throw new Error('CO-03-01 is not in the catalogue');
  const signals = new Map<SignalId, SignalResult>([[ATTRIBUTION, observed(ATTRIBUTION, reading, 1, COMPLETE)]]);
  return resolveControl(spec, signals, registry.get('CO-03-01'));
}

describe('cost attribution', () => {
  it('scores the tagged share of priced spend', () => {
    const tagged = attribution({
      usageRecords: 1_000,
      pricedRecords: 1_000,
      listCost: 100_000,
      customTaggedCost: 90_000,
      identifiableCost: 100_000,
      tagKeys: ['cost_center'],
    });

    expect(findingFor(tagged).outcome).toBe('pass');
  });

  it('does not report a wholly unpriced bill as no bill', () => {
    // `listCost` is priced rows only, so an estate absent from `list_prices` reaches this resolver
    // with zero spend and usage quantity behind it. Answering not-applicable there states something
    // about the estate that the reading does not carry.
    const unpriced = attribution({ usageRecords: 800, unpricedRecords: 800, leastPricedShare: 0 });

    expect(findingFor(unpriced).outcome).toBe('unmeasurable');
    expect(findingFor(unpriced).outcomeReason).toMatch(/no matching list price/);
  });

  it('still says there is nothing to attribute where nothing was billed', () => {
    expect(findingFor(attribution()).outcome).toBe('not-applicable');
    expect(findingFor(attribution()).outcomeReason).toMatch(/No billable usage/);
  });
});
