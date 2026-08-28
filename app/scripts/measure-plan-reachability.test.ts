import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { interpret, skipReason } from './measure-plan-reachability.mjs';

const LOCAL = new Set(['0123456789abcdef', '0123456789abcdef']);

describe('skipReason', () => {
  it('calls for a warehouse this workspace can see', () => {
    expect(skipReason({ computeType: 'WAREHOUSE', warehouseId: '0123456789abcdef' }, LOCAL)).toBeNull();
  });

  it('skips a warehouse in another workspace, which is the 3.10%', () => {
    expect(skipReason({ computeType: 'WAREHOUSE', warehouseId: '764d4f92c9107ad0' }, LOCAL)).toBe(
      'warehouse-outside-workspace',
    );
  });

  it('skips compute that is not a warehouse, which is the 0.11%', () => {
    expect(skipReason({ computeType: 'SERVERLESS_COMPUTE', warehouseId: null }, LOCAL)).toBe(
      'not-warehouse-compute',
    );
  });

  it('skips a warehouse row with no id rather than probing an empty path', () => {
    expect(skipReason({ computeType: 'WAREHOUSE', warehouseId: '' }, LOCAL)).toBe('no-warehouse-id');
    expect(skipReason({ computeType: 'WAREHOUSE', warehouseId: null }, LOCAL)).toBe('no-warehouse-id');
  });
});

describe('interpret', () => {
  it('reads a plan as available', () => {
    expect(interpret(200, { plans_state: 'EXISTS' })).toBe('available');
  });

  it('keeps no-plan and not-retrievable apart, because only the first is knowledge', () => {
    // 200 EMPTY is the platform reporting that no plan was produced. The app read that.
    expect(interpret(200, { plans_state: 'EMPTY' })).toBe('no-plan');
    // 404 is the absence of an answer. Whether a plan exists is not in the response.
    expect(interpret(404, null)).toBe('not-retrievable');
    expect(interpret(200, { plans_state: 'EMPTY' })).not.toBe(interpret(404, null));
  });

  it('does not read an unknown state as either', () => {
    expect(interpret(200, { plans_state: 'PENDING' })).toBe('unknown-state');
    expect(interpret(200, {})).toBe('unknown-state');
    expect(interpret(200, null)).toBe('unknown-state');
  });

  it('separates a transport failure from both', () => {
    expect(interpret(500, null)).toBe('error');
    expect(interpret(429, null)).toBe('error');
  });
});

interface RecordedProbe {
  readonly probeClass: string;
  readonly warehouseIsLocal: boolean;
  readonly skipReason: string | null;
  readonly status: number;
  readonly plansState: string | null;
  readonly outcome: string;
}

interface Recorded {
  readonly warehousesVisible: number;
  readonly census: {
    readonly statements: number;
    readonly inWorkspace: number;
    readonly outsideWorkspace: number;
    readonly notWarehouse: number;
    readonly outsideWarehouseIds: number;
    readonly shareRetrievablePct: number;
    readonly shareSkippableWithoutACallPct: number;
  };
  readonly probes: readonly RecordedProbe[];
  readonly oldestLocalStatement: { readonly ageHours: number; readonly status: number } | null;
}

describe('the recorded measurement', () => {
  const recorded = JSON.parse(
    readFileSync(
      join(__dirname, '..', 'server', 'collect', 'sql', 'runtime-baseline', 'labs-plan-reachability.json'),
      'utf8',
    ),
  ) as Recorded;

  it('records a census that accounts for every statement', () => {
    const { statements, inWorkspace, outsideWorkspace, notWarehouse } = recorded.census;
    expect(inWorkspace + outsideWorkspace + notWarehouse).toBe(statements);
    expect(statements).toBeGreaterThan(1000);
  });

  it('records that skipping the predictable misses costs no calls and saves some', () => {
    expect(recorded.census.shareSkippableWithoutACallPct).toBeGreaterThan(0);
    expect(recorded.census.shareRetrievablePct + recorded.census.shareSkippableWithoutACallPct).toBeCloseTo(
      100,
      0,
    );
  });

  it('records more warehouse ids in history than the workspace can see, which is why 404 happens', () => {
    expect(recorded.census.outsideWarehouseIds).toBeGreaterThan(0);
    expect(recorded.warehousesVisible).toBeGreaterThan(0);
  });

  // The first wrong attribution: type looked like the discriminator because every 404 sampled was foreign.
  it('records no local statement 404ing on account of its type', () => {
    const localProbes = recorded.probes.filter((probe) => probe.warehouseIsLocal);
    expect(localProbes.length).toBeGreaterThan(0);
    for (const probe of localProbes) {
      expect(probe.status).toBe(200);
      expect(probe.outcome).not.toBe('not-retrievable');
    }
  });

  // The second wrong attribution: three cache hits 404'd, and all three had run in another workspace.
  it('records cache hits on a local warehouse as an empty plan, not a missing one', () => {
    const cacheHits = recorded.probes.filter((probe) => probe.probeClass === 'local-cache-hit');
    expect(cacheHits.length).toBeGreaterThan(0);
    for (const probe of cacheHits) {
      expect(probe.status).toBe(200);
      expect(probe.plansState).toBe('EMPTY');
      expect(probe.outcome).toBe('no-plan');
    }
  });

  it('records every foreign-warehouse probe as skippable before the call, and 404 when called anyway', () => {
    const foreign = recorded.probes.filter(
      (probe) => probe.probeClass === 'warehouse-outside-workspace',
    );
    expect(foreign.length).toBeGreaterThan(0);
    for (const probe of foreign) {
      expect(probe.skipReason).toBe('warehouse-outside-workspace');
      expect(probe.status).toBe(404);
      expect(probe.outcome).toBe('not-retrievable');
    }
  });

  // The retention question 33j would otherwise have designed around.
  it('records no expiry inside twice the window the shapes statement reads', () => {
    const oldest = recorded.oldestLocalStatement;
    expect(oldest).not.toBeNull();
    expect(oldest?.ageHours).toBeGreaterThan(24 * 15);
    expect(oldest?.status).toBe(200);
  });
});
