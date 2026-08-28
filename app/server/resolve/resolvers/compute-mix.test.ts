// The three controls that score a share of spend, and what the share is a share of.
//
// Every test here is a reading the app gave a real workspace and got wrong. The estate was $16,190 over
// thirty days: $11,905 of Anthropic model serving, $3,157 of Databricks Apps, $864 of Lakebase, $258 of
// serverless SQL, $0.04 of serverless jobs, and $5 of networking and storage. Not one classic cluster,
// not one pro warehouse — every line of compute in it already serverless.
//
// It reported 19.1% serverless adoption and failed the Photon control.
//
// Three separate defects produced that, and all three were invisible to the tests that existed, because
// each resolver was checked against a fixture whose denominator had been chosen to make the arithmetic
// come out. Nothing asserted what the denominator was supposed to mean.
//
// **Spend nobody can move was in the denominator.** Model serving has no classic form. Neither does
// Lakebase, or Apps, or object storage. Counting them as spend that failed to become serverless makes
// the achievable share depend on how much of the bill is serving, which is why the file's own Photon
// denominator was already computed separately — the reasoning was there and had not been applied here.
//
// **`product_features.is_serverless` is false on serverless-only products.** Model serving and Lakebase
// both report false. Trusting the flag alone put $12,770 of serverless spend in the numerator's
// denominator and nowhere else.
//
// **All-purpose was matched on the SKU name.** Serverless all-purpose compute bills as
// `ENTERPRISE_ALL_PURPOSE_SERVERLESS_COMPUTE_<region>`, so `%ALL_PURPOSE%` booked the whole $3,157 of
// Apps spend as all-purpose cluster spend.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { COMPLETE, observed, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { ComputeMix } from '../../collect/sql/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const MIX = 'sql:cost.compute_mix' as SignalId;

const catalogue = loadCatalogue();
const registry = buildRegistry();

/** A mix with nothing in it, so each test states only the figures it is about. */
function mix(over: Partial<ComputeMix> = {}): ComputeMix {
  return {
    totalCost: 0,
    serverlessCost: 0,
    choiceCost: 0,
    serverlessChoiceCost: 0,
    photonCost: 0,
    photonEligibleCost: 0,
    allPurposeCost: 0,
    jobsOnAllPurposeCost: 0,
    distinctSkus: 1,
    usageRecords: 0,
    pricedRecords: 0,
    unpricedRecords: 0,
    leastPricedUnit: 'DBU',
    leastPricedShare: 1,
    usageUnitCount: 1,
    currencies: 1,
    duplicatePriceMatches: 0,
    currency: 'USD',
    ...over,
  };
}

/**
 * The workspace this file is about, as the corrected statement now reads it.
 *
 * Every serverless-only product is in `serverlessCost` and outside `choiceCost`; the $258 of serverless
 * SQL and $0.04 of serverless jobs are the only spend with a form somebody chose.
 */
const MEASURED_ESTATE = mix({
  totalCost: 16_191.19,
  serverlessCost: 16_186.03,
  choiceCost: 258.15,
  serverlessChoiceCost: 258.15,
  photonCost: 0,
  photonEligibleCost: 258.15,
  allPurposeCost: 0,
  jobsOnAllPurposeCost: 0,
  distinctSkus: 20,
  usageRecords: 1_000,
  pricedRecords: 1_000,
  unpricedRecords: 0,
});

function findingFor(computeMix: ComputeMix, controlId: string) {
  const spec = catalogue.controls.find((control) => control.id === controlId);
  if (spec == null) throw new Error(`${controlId} is not in the catalogue`);
  const signals = new Map<SignalId, SignalResult>([[MIX, observed(MIX, computeMix, 1, COMPLETE)]]);
  return resolveControl(spec, signals, registry.get(controlId));
}

const observedOf = (controlId: string, computeMix: ComputeMix): string =>
  findingFor(computeMix, controlId)
    .evidence.map((entry) => entry.observed)
    .join(' ');

describe('serverless adoption, on the estate that read 19%', () => {
  it('passes an estate whose every movable workload is already serverless', () => {
    const finding = findingFor(MEASURED_ESTATE, 'CO-01-06');

    expect(finding.outcome).toBe('pass');
  });

  it('measures the share over the spend that has a serverless option, not over the bill', () => {
    // The number in the sentence is the assertion. $258 of $258 rather than $3,415 of $16,191, which is
    // the same estate described as one fifth serverless.
    expect(observedOf('CO-01-06', MEASURED_ESTATE)).toContain('$258 of $258');
    expect(observedOf('CO-01-06', MEASURED_ESTATE)).toContain('100%');
  });

  it('names the spend it left out, so a smaller denominator than the bill is not read as an error', () => {
    // A reader who knows the monthly bill is $16,000 and is shown a share of $258 will distrust the
    // finding unless the difference is accounted for on the same line.
    const observation = observedOf('CO-01-06', MEASURED_ESTATE);

    expect(observation).toContain('$15,933');
    expect(observation).toMatch(/no classic form/);
  });

  it('still fails a classic estate, which is the reading that has to keep working', () => {
    const classic = mix({ totalCost: 40_000, choiceCost: 40_000, serverlessChoiceCost: 0, photonEligibleCost: 40_000 });

    expect(findingFor(classic, 'CO-01-06').outcome).toBe('fail');
  });

  it('does not let serving spend carry a classic estate into a pass', () => {
    /*
     * The defect stated as a case. A million dollars of model serving beside half a million of classic
     * clusters read 67% serverless against the total bill — comfortably past the 80%... not quite, which
     * is the point: it read as partial rather than as the failure it is, and a heavier serving line
     * would have passed it outright.
     */
    const serving = mix({
      totalCost: 1_500_000,
      serverlessCost: 1_000_000,
      choiceCost: 500_000,
      serverlessChoiceCost: 0,
      photonEligibleCost: 500_000,
    });

    expect(findingFor(serving, 'CO-01-06').outcome).toBe('fail');
    expect(observedOf('CO-01-06', serving)).toContain('$0 of $500,000');
  });

  it('says there is nothing to assess where no product in the window had a choice', () => {
    // Not a failure: an estate of serving, Lakebase and Apps has not declined to adopt serverless.
    const noChoice = mix({ totalCost: 9_000, serverlessCost: 9_000 });
    const finding = findingFor(noChoice, 'CO-01-06');

    expect(finding.outcome).toBe('not-applicable');
    expect(finding.outcomeReason).toMatch(/no classic form to move away from/);
  });

  it('scores the other three controls that read this from the same figures', () => {
    // PE-02-01, REL-01-06 and IU-03-02 share the resolver. A denominator fixed in one place and not the
    // others would leave three controls disagreeing with the first about one estate.
    for (const id of ['PE-02-01', 'REL-01-06', 'IU-03-02']) {
      expect(findingFor(MEASURED_ESTATE, id).outcome, id).toBe('pass');
    }
  });
});

describe('Photon, on the estate that failed it', () => {
  it('credits the architecture when the eligible spend is serverless', () => {
    // Serverless SQL runs the vectorised engine and bills no Photon SKU, so measuring Photon adoption
    // here is measuring the absence of a setting that cannot be set.
    const finding = findingFor(MEASURED_ESTATE, 'CO-01-10');

    expect(finding.outcome).toBe('satisfied-by-architecture');
  });

  it('reads the serverless share over eligible spend, not over the whole bill', () => {
    /*
     * The failure, exactly. Against the total bill this estate is 21% serverless, the branch does not
     * fire, the ordinary path finds no Photon SKU, and a workspace running nothing but serverless SQL is
     * told it has 0% Photon adoption.
     */
    const finding = findingFor(MEASURED_ESTATE, 'CO-01-10');

    expect(finding.outcome).not.toBe('fail');
    expect(finding.outcomeReason).toContain('100%');
  });

  it('still measures Photon where there is classic compute to measure it on', () => {
    const classic = mix({
      totalCost: 10_000,
      choiceCost: 10_000,
      serverlessChoiceCost: 0,
      photonEligibleCost: 10_000,
      photonCost: 0,
    });

    expect(findingFor(classic, 'CO-01-10').outcome).toBe('fail');
  });
});

describe('jobs on all-purpose compute', () => {
  it('measures the waste against compute somebody configured, not against the bill', () => {
    /*
     * $50,000 of jobs pinned to all-purpose clusters is the whole of this estate's cluster spend and all
     * of it is the finding. Against a bill that is mostly model serving it was 5% waste, which lands in
     * the pass band and reports an estate running every job on the wrong compute as fine.
     */
    const serving = mix({
      totalCost: 1_000_000,
      serverlessCost: 950_000,
      choiceCost: 50_000,
      allPurposeCost: 50_000,
      jobsOnAllPurposeCost: 50_000,
      photonEligibleCost: 50_000,
    });

    expect(findingFor(serving, 'CO-01-02').outcome).toBe('fail');
    expect(observedOf('CO-01-02', serving)).toContain('$50,000 of $50,000');
  });

  it('passes an estate with no job-attributed all-purpose spend', () => {
    expect(findingFor(MEASURED_ESTATE, 'CO-01-02').outcome).toBe('pass');
  });

  it('says there is nothing to get wrong where no compute was configured at all', () => {
    const noChoice = mix({ totalCost: 9_000, serverlessCost: 9_000 });

    expect(findingFor(noChoice, 'CO-01-02').outcome).toBe('not-applicable');
  });

  it('declines a definitive share when unpriced quantity is material', () => {
    // One percent of a unit's quantity unpriced is enough that a coalesced $0 would move the share.
    const gap = mix({ ...MEASURED_ESTATE, unpricedRecords: 50, leastPricedShare: 0.99 });

    expect(findingFor(gap, 'CO-01-06').outcome).toBe('unmeasurable');
    expect(findingFor(gap, 'CO-01-06').outcomeReason).toMatch(/incomplete bill/);
  });

  it('sees a gap in the unit the price list covers worst, not pooled into the one it covers best', () => {
    /*
     * The defect stated as a case, with labs' own units. A wholly unpriced GB population is 21.91 of
     * 139,265 pooled quantity — 0.016%, past which the pooled gate reported a definitive share — while
     * being all of the GB there was. The share reported per unit is 0%, and the figure is declined.
     */
    const gb = mix({
      ...MEASURED_ESTATE,
      unpricedRecords: 394,
      leastPricedUnit: 'GB',
      leastPricedShare: 0,
      usageUnitCount: 3,
    });

    expect(findingFor(gb, 'CO-01-06').outcome).toBe('unmeasurable');
    expect(findingFor(gb, 'CO-01-06').outcomeReason).toMatch(
      /0% of GB quantity priced, the least covered of 3 usage units/
    );
  });

  it('declines every figure when the same usage matched two list prices', () => {
    // Each extra match adds that row's cost again to every sum in the statement.
    const doubled = mix({ ...MEASURED_ESTATE, duplicatePriceMatches: 12 });

    expect(findingFor(doubled, 'CO-01-06').outcome).toBe('unmeasurable');
    expect(findingFor(doubled, 'CO-01-06').outcomeReason).toMatch(
      /12 usage records have more than one matching list price/
    );
  });

  it('declines a figure that would add amounts in two currencies', () => {
    // `max(currency_code)` would label the sum with whichever sorted last, as though it were the total's.
    const mixed = mix({ ...MEASURED_ESTATE, currencies: 2 });

    expect(findingFor(mixed, 'CO-01-06').outcome).toBe('unmeasurable');
    expect(findingFor(mixed, 'CO-01-06').outcomeReason).toMatch(/priced in 2 currencies/);
  });

  it('does not report a wholly unpriced bill as no bill', () => {
    /*
     * The reading is priced rows only, so an estate whose SKUs are absent from `list_prices` arrives
     * with every monetary field at zero and usage quantity behind it. Both controls used to check the
     * zero first and answer "no billable usage was recorded in the window" — a statement about the
     * estate, drawn from a gap in the price list, with the guard written for exactly this case sitting
     * one line further down where it could not run.
     */
    const unpriced = mix({ usageRecords: 4_000, unpricedRecords: 4_000, leastPricedShare: 0 });

    for (const controlId of ['CO-01-02', 'CO-01-06']) {
      expect(findingFor(unpriced, controlId).outcome).toBe('unmeasurable');
      expect(findingFor(unpriced, controlId).outcomeReason).toMatch(/no matching list price/);
    }
  });

  it('still says no usage where there was none, priced or otherwise', () => {
    // The branch the reordering moved is not removed: an empty window is a real not-applicable.
    for (const controlId of ['CO-01-02', 'CO-01-06']) {
      expect(findingFor(mix(), controlId).outcome).toBe('not-applicable');
      expect(findingFor(mix(), controlId).outcomeReason).toMatch(/No billable usage/);
    }
  });

  it('agrees the verb with the record count it prints', () => {
    // "1 usage record … have no matching list price" was reaching a reader on three of these sentences.
    // The count and its verb are one decision, which is why `agreeing` returns both.
    const one = mix({ usageRecords: 1, unpricedRecords: 1, leastPricedShare: 0 });
    const several = mix({ usageRecords: 2, unpricedRecords: 2, leastPricedShare: 0 });

    for (const controlId of ['CO-01-02', 'CO-01-06']) {
      expect(findingFor(one, controlId).outcomeReason).toMatch(/1 usage record has no matching list price/);
      expect(findingFor(several, controlId).outcomeReason).toMatch(/2 usage records have no matching list price/);
    }
  });
});
