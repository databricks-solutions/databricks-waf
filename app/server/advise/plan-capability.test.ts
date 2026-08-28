import { describe, expect, it } from 'vitest';
import { isBaseline, planCapability, type PlanBaseline } from './plan-capability.js';
import type { PlanRetrievalSummary } from '../collect/sql/plans/retrieve.js';

function summary(overrides: Partial<PlanRetrievalSummary> = {}): PlanRetrievalSummary {
  return {
    available: 0,
    withoutPlan: 0,
    skipped: {},
    failed: 0,
    abandoned: 0,
    notRun: 0,
    warehousesKnown: true,
    ...overrides,
  };
}

function baseline(available: number, overrides: Partial<PlanRetrievalSummary> = {}): PlanBaseline {
  return { advisoryId: 'adv-earlier', plans: summary({ available, ...overrides }) };
}

describe('planCapability', () => {
  it('says nothing when there was no plan retrieval at all', () => {
    expect(planCapability(undefined, baseline(4))).toBeUndefined();
  });

  it('says nothing when reach held up', () => {
    expect(planCapability(summary({ available: 3, withoutPlan: 1 }), baseline(4))).toBeUndefined();
  });

  it('reports giving up, naming both counts rather than only the abandoned one', () => {
    const alert = planCapability(summary({ failed: 5, abandoned: 30 }), baseline(4));
    expect(alert).toEqual({ kind: 'gave-up', failed: 5, abandoned: 30 });
  });

  // The failure this row was split out to avoid: a run that could not list warehouses reads as zero reach,
  // and treating that as normal would set a floor the next run reads as unchanged.
  it('refuses to draw any conclusion when the warehouse list was refused', () => {
    expect(planCapability(summary({ warehousesKnown: false }), baseline(4))).toEqual({ kind: 'cannot-tell' });
    expect(isBaseline(summary({ warehousesKnown: false, withoutPlan: 3 }))).toBe(false);
  });

  it('reports reach lost against the run it was lost against', () => {
    const alert = planCapability(summary({ withoutPlan: 6 }), baseline(4));
    expect(alert).toEqual({ kind: 'lost-reach', baselineAdvisoryId: 'adv-earlier', baselineAvailable: 4 });
  });

  it('does not report lost reach on a first run, or against a baseline that never had any', () => {
    expect(planCapability(summary({ withoutPlan: 6 }), undefined)).toBeUndefined();
    expect(planCapability(summary({ withoutPlan: 6 }), baseline(0, { withoutPlan: 9 }))).toBeUndefined();
  });

  // Zero of zero is not a drop. An estate whose every shape ran on a warehouse this workspace cannot see
  // asked about nothing, and saying reach was lost would be a claim about the platform.
  it('does not report lost reach when nothing was asked about', () => {
    expect(planCapability(summary({ skipped: { 'warehouse-outside-workspace': 12 } }), baseline(4))).toBeUndefined();
  });

  it('prefers the cause over the effect when a run both gave up and has no reach', () => {
    const alert = planCapability(summary({ failed: 5, abandoned: 2 }), baseline(4));
    expect(alert).toMatchObject({ kind: 'gave-up' });
  });

  // The breaker can open part-way, so `gave-up` does not mean nothing was read. Named because the comment
  // above the branch used to claim it did.
  it('reports giving up even where some plans were read', () => {
    const alert = planCapability(summary({ available: 20, abandoned: 15 }), baseline(20));
    expect(alert).toEqual({ kind: 'gave-up', failed: 0, abandoned: 15 });
  });

  /*
   * A cancelled run is not a capability regression.
   *
   * Its shapes are `notRun`, which `asked` excludes on purpose. Counted as asked — which they were, while
   * `failed` absorbed every scheduler skip — a run cancelled by the person who started it reported reach
   * lost against the last good run.
   */
  it('says nothing where the scheduler never ran the fetch', () => {
    expect(planCapability(summary({ notRun: 40 }), baseline(4))).toBeUndefined();
  });
});

describe('isBaseline', () => {
  it('accepts a run that read plans and knew its warehouses', () => {
    expect(isBaseline(summary({ available: 2, withoutPlan: 1 }))).toBe(true);
    // Asked about nothing, so it establishes no floor either way.
    expect(isBaseline(summary({ skipped: { 'no-warehouse-id': 4 } }))).toBe(false);
  });

  /*
   * Reach, not activity.
   *
   * A degraded run asked about plenty and read nothing. Accepting it as a baseline silences the alert for
   * the run after it — `planCapability` bails on a zero baseline — while the older run that did have reach
   * is never looked at, because `baseline()` takes the first candidate that qualifies.
   */
  it('rejects a run that asked about plenty and read nothing', () => {
    expect(isBaseline(summary({ failed: 5, abandoned: 35 }))).toBe(false);
    expect(isBaseline(summary({ withoutPlan: 12 }))).toBe(false);
  });
});
