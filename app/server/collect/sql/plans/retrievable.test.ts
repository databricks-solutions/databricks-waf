import { describe, expect, it } from 'vitest';

import { skipReason as measuredSkipReason } from '../../../../scripts/measure-plan-reachability.mjs';
import reachability from '../runtime-baseline/labs-plan-reachability.json' with { type: 'json' };
import { planCandidates, skipReason, type NominatedExecution, type SkipReason } from './retrievable.js';

const LOCAL = new Set(['wh-local-1', 'wh-local-2']);

function ran(warehouseId: string | undefined, computeType = 'WAREHOUSE'): NominatedExecution {
  return {
    statementId: 'stmt-1',
    representativeComputeType: computeType,
    ...(warehouseId === undefined ? {} : { representativeWarehouseId: warehouseId }),
  };
}

describe('deciding whether the endpoint can answer', () => {
  it('calls for a warehouse this workspace owns', () => {
    expect(skipReason(ran('wh-local-1'), LOCAL)).toBeNull();
  });

  it('skips the two classes 33k measured, and tells them apart', () => {
    // 3.10% of labs' statements over fifteen days, and 0.11%. Both 404, and the response body says
    // which for neither — which is why they are separated here rather than after the call.
    expect(skipReason(ran('wh-elsewhere'), LOCAL)).toBe('warehouse-outside-workspace');
    expect(skipReason(ran(undefined, 'SERVERLESS_COMPUTE'), LOCAL)).toBe('not-warehouse-compute');
  });

  it('reads a warehouse-shaped row with no id as unfetchable rather than as local', () => {
    // The empty string is the case to hold: `text()` returns it for a column the warehouse sent empty,
    // and a set lookup on '' would be a miss anyway — but for the wrong reason and under the wrong name.
    expect(skipReason(ran(undefined), LOCAL)).toBe('no-warehouse-id');
    expect(skipReason(ran(''), LOCAL)).toBe('no-warehouse-id');
  });

  it('refuses a shape with no nominated execution instead of fetching undefined', () => {
    expect(skipReason({}, LOCAL)).toBe('no-statement');
    expect(skipReason({ statementId: '', representativeComputeType: 'WAREHOUSE' }, LOCAL)).toBe('no-statement');
  });

  it('skips everything when the warehouse list could not be read', () => {
    // Not "no restriction". A caller that read no warehouses has established that no id is local, and
    // the whole fetch 404ing is a worse answer than none of it being attempted.
    expect(skipReason(ran('wh-local-1'), new Set())).toBe('warehouse-outside-workspace');
  });

  it('asks the questions in an order where each answer is the true one', () => {
    // A pipeline statement carries no warehouse id either. Reported as `not-warehouse-compute`, which
    // is the fact a reader can act on; `no-warehouse-id` would describe the same row as a gap in the
    // system table.
    expect(skipReason({ statementId: 'stmt-1', representativeComputeType: 'PIPELINE' }, LOCAL)).toBe(
      'not-warehouse-compute',
    );
  });
});

describe('splitting a scan of shapes', () => {
  it('hands back the shapes themselves, with a reason on each it declined', () => {
    const shapes = [
      { shape: 'a', ...ran('wh-local-1') },
      { shape: 'b', ...ran('wh-elsewhere') },
      { shape: 'c', ...ran(undefined, 'PIPELINE') },
      { shape: 'd', ...ran('wh-local-2') },
    ];

    const { fetch, skipped } = planCandidates(shapes, LOCAL);

    expect(fetch.map((one) => one.shape)).toStrictEqual(['a', 'd']);
    expect(skipped.map((one) => [one.shape.shape, one.reason])).toStrictEqual([
      ['b', 'warehouse-outside-workspace'],
      ['c', 'not-warehouse-compute'],
    ]);
  });

  it('is empty on both sides for no shapes, rather than throwing', () => {
    expect(planCandidates([], LOCAL)).toStrictEqual({ fetch: [], skipped: [] });
  });
});

describe('the drift guard', () => {
  it('agrees with the script 33k measured the 3.21% with', () => {
    // The census in `labs-plan-reachability.json` is a claim about what this pre-filter will skip, and
    // it was produced by the script's classifier rather than by this one. If the two drift, that
    // recorded percentage stops describing what ships — and it is the number 33m's circuit-breaker
    // threshold is set against, so nothing downstream would notice it had stopped being true.
    const cases: readonly (readonly [string | undefined, string | undefined])[] = [
      ['WAREHOUSE', 'wh-local-1'],
      ['WAREHOUSE', 'wh-elsewhere'],
      ['WAREHOUSE', undefined],
      ['WAREHOUSE', ''],
      ['SERVERLESS_COMPUTE', undefined],
      ['PIPELINE', 'wh-local-1'],
      [undefined, 'wh-local-1'],
    ];

    for (const [computeType, warehouseId] of cases) {
      // `no-statement` is this module's alone — the script classifies history rows, which always carry
      // an id — so every case here nominates one and the two classifiers answer over the same domain.
      const mine = skipReason(
        {
          statementId: 'stmt-1',
          ...(computeType === undefined ? {} : { representativeComputeType: computeType }),
          ...(warehouseId === undefined ? {} : { representativeWarehouseId: warehouseId }),
        },
        LOCAL,
      );
      const theirs = measuredSkipReason({ computeType, warehouseId }, LOCAL);
      expect<SkipReason | null>(mine).toBe(theirs);
    }
  });

  it('skips the share of labs the recording says it will', () => {
    // Non-vacuous in the direction that matters: the census is only a reason to build this if the two
    // skippable classes are what it says they are, and they sum to what it says they sum to.
    const { census } = reachability;
    expect(census.inWorkspace + census.outsideWorkspace + census.notWarehouse).toBe(census.statements);

    const skippable = census.outsideWorkspace + census.notWarehouse;
    expect(Number(((100 * skippable) / census.statements).toFixed(2))).toBe(census.shareSkippableWithoutACallPct);
    expect(census.shareRetrievablePct + census.shareSkippableWithoutACallPct).toBeCloseTo(100, 1);
  });
});
