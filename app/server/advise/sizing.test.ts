// The warehouse sizing analysis.
//
// Every case here is one the labs estate produced or one it would have produced without a guard. The two
// worth reading first are the warehouse the assessment was the only thing to run on — which must not be
// reported as unused, since acting on that means deleting the warehouse doing the assessing — and the
// cold-start rule declining to fire on a serverless warehouse that started 456 times in seven days, which
// is what serverless is for.
//
// Nothing here sets a self share, and that is not an omission. The statement excludes our statements in a
// `WHERE` clause, so a row reaching this module has none of them in it; `ranAssessment` is all that
// survives and it is a boolean no rule reads.

import { describe, expect, it } from 'vitest';
import type { WarehousePressureRow, WarehouseRow } from '../collect/sql/shapes.js';
import { analyseSizing, SIZE_LADDER } from './sizing.js';
import { loadSizingRules, workloadRulesDirectory } from './workload-rules.js';

const ruleset = loadSizingRules(workloadRulesDirectory());

function pressure(overrides: Partial<WarehousePressureRow> = {}): WarehousePressureRow {
  return {
    workspaceId: 'w1',
    warehouseId: 'wh1',
    runs: 500,
    measured: 500,
    totalMs: 1_000_000,
    busyMs: 800_000,
    queueMs: 0,
    spilledBytes: 0,
    peakUsers: 4,
    daysUsed: 7,
    daysQueued: 0,
    daysSpilled: 0,
    p95Ms: 60_000,
    worstMs: 120_000,
    worstQueueMs: 0,
    upMs: 3_600_000,
    clusterMs: 3_600_000,
    starts: 4,
    peakClusters: 1,
    daysSeen: 7,
    carriedIn: false,
    executionPercent: 80,
    queuePercent: 0,
    ranAssessment: false,
    warehousePopulation: 1,
    ...overrides,
  };
}

function definition(overrides: Partial<WarehouseRow> = {}): WarehouseRow {
  return {
    workspaceId: 'w1',
    warehouseId: 'wh1',
    name: 'analytics',
    type: 'PRO',
    serverless: false,
    size: 'Medium',
    minClusters: 1,
    maxClusters: 1,
    scalesOut: false,
    autoStopMinutes: 10,
    autoStops: true,
    tagCount: 0,
    ...overrides,
  };
}

function rules(row: WarehousePressureRow, warehouse?: WarehouseRow): readonly string[] {
  const analysis = analyseSizing([row], warehouse == null ? [] : [warehouse], 7, ruleset);
  return (analysis?.warehouses[0]?.findings ?? []).map((finding) => finding.rule);
}

describe('the sizing analysis', () => {
  it('reports nothing rather than a correctly sized estate when the statement could not be read', () => {
    // The same distinction the workload analyzer draws, and it matters more here: an empty analysis would
    // render as an estate whose warehouses are all the right size, which is a conclusion nothing reached.
    expect(analyseSizing([], [definition()], 7, ruleset)).toBeUndefined();
  });

  /*
   * The labs case this replaced a suppression gate for.
   *
   * Our statements used to be counted as load, and a warehouse more than half ours was reported to the
   * customer as "measuring ourselves" — a row in their warehouse list, where advice goes, saying nothing
   * they could act on. They are now excluded by the statement, so such a row arrives here with no
   * statements on it at all and the only question left is which kind of empty it is.
   */
  it('keeps the warehouse the assessment runs on apart from one nothing ran on', () => {
    const empty = { runs: 0, measured: 0, totalMs: 0, busyMs: 0 };
    const assessing = analyseSizing([pressure({ ...empty, ranAssessment: true })], [definition()], 7, ruleset);
    const idle = analyseSizing([pressure({ ...empty, ranAssessment: false })], [definition()], 7, ruleset);

    expect(assessing?.warehouses[0]?.state).toBe('assessment-only');
    expect(idle?.warehouses[0]?.state).toBe('unused');
    // Neither is advised on, and neither counts as a warehouse that ran work. The states differ because
    // "delete this" is right about one of them and wrong about the other.
    expect(assessing?.warehouses[0]?.findings).toEqual([]);
    expect(assessing?.used).toBe(0);
    expect(idle?.used).toBe(0);
  });

  it('advises on a warehouse the assessment merely shared, since our statements are already gone', () => {
    // The shared-warehouse case. Once the statement has filtered us out, what is left is the estate's own
    // work and it gets the same advice it would have got had we never run there.
    const shared = pressure({ queueMs: 400_000, queuePercent: 40, daysQueued: 6, ranAssessment: true });

    const analysis = analyseSizing([shared], [definition()], 7, ruleset);

    expect(analysis?.warehouses[0]?.state).toBe('advised');
    expect(rules(shared, definition())).toContain('WAREHOUSE_QUEUEING');
  });

  it('separates a warehouse that was not asked for anything from one that coped', () => {
    const idle = analyseSizing([pressure({ runs: 0, measured: 0, totalMs: 0 })], [definition()], 7, ruleset);
    const fine = analyseSizing([pressure()], [definition()], 7, ruleset);

    expect(idle?.warehouses[0]?.state).toBe('unused');
    expect(fine?.warehouses[0]?.state).toBe('clean');
    expect(idle?.used).toBe(0);
    expect(fine?.used).toBe(1);
  });

  /*
   * The labs regression. A warehouse ran one statement, it was cancelled, and nothing about it was timed —
   * so every rule declined for want of a measurement and the warehouse was reported as having coped with
   * its work. That is a claim about seven days of evidence that did not exist.
   */
  it('does not claim a warehouse coped when nothing on it was timed', () => {
    const untimed = analyseSizing(
      [pressure({ runs: 1, measured: 0, totalMs: 0, busyMs: 0, p95Ms: undefined })],
      [definition()],
      7,
      ruleset
    );

    expect(untimed?.warehouses[0]?.state).toBe('unmeasured');
    expect(untimed?.warehouses[0]?.findings).toEqual([]);
    // Still used: a statement ran on it. The count answers "was this warehouse asked for anything".
    expect(untimed?.used).toBe(1);
  });

  /*
   * The denominator behind "the estate's other warehouses were quiet". The event stream is read across the
   * metastore and the inventory only covers the workspaces the run reached, so the two counts differ: labs
   * saw five warehouses of which three were in an inventory of twenty-one.
   */
  it('counts how many of the warehouses it saw were in the inventory', () => {
    const analysis = analyseSizing(
      [pressure(), pressure({ warehouseId: 'elsewhere' })],
      [definition(), definition({ warehouseId: 'unseen' })],
      7,
      ruleset
    );

    expect(analysis?.matched).toBe(1);
    expect(analysis?.live).toBe(2);
  });

  /*
   * Both spellings of one vocabulary. The system table says `X_SMALL`, the ladder says `X-Small`, and the
   * payload carries the size from one and the next size down from the other — so labs rendered "the next
   * size down from X_SMALL is 2X-Small" in a single sentence.
   */
  it('spells the size the way it names the size below it', () => {
    const analysis = analyseSizing([pressure()], [definition({ size: 'X_SMALL' })], 7, ruleset);

    expect(analysis?.warehouses[0]?.size).toBe('X-Small');
    expect(analysis?.warehouses[0]?.nextSizeDown).toBe('2X-Small');
  });

  it('keeps a size the ladder does not know rather than dropping it', () => {
    const analysis = analyseSizing([pressure()], [definition({ size: 'ENORMOUS' })], 7, ruleset);

    expect(analysis?.warehouses[0]?.size).toBe('ENORMOUS');
    expect(analysis?.warehouses[0]?.nextSizeDown).toBeUndefined();
  });

  describe('queueing', () => {
    const queued = pressure({ queueMs: 200_000, queuePercent: 20, daysQueued: 5, worstQueueMs: 9000 });

    it('fires on a sustained pattern', () => {
      expect(rules(queued, definition())).toContain('WAREHOUSE_QUEUEING');
    });

    it('does not fire on one bad day', () => {
      // Labs: a warehouse queued on 1 day of 8 at 0.3% of elapsed time. That is a Tuesday, not a size.
      expect(rules({ ...queued, daysQueued: 1 }, definition())).not.toContain('WAREHOUSE_QUEUEING');
      expect(rules(pressure({ queueMs: 3000, queuePercent: 0.3, daysQueued: 1 }), definition())).toEqual([]);
    });

    it('is critical where a fifth of elapsed time went in the queue', () => {
      const analysis = analyseSizing([queued], [definition()], 7, ruleset);
      expect(analysis?.warehouses[0]?.findings[0]?.severity).toBe('critical');
    });
  });

  describe('spill', () => {
    it('fires on a gigabyte across several days, and not on an incidental spill', () => {
      const spilling = pressure({ spilledBytes: 5_000_000_000, daysSpilled: 4 });
      expect(rules(spilling, definition())).toContain('WAREHOUSE_SPILL');
      expect(rules({ ...spilling, spilledBytes: 1_000_000 }, definition())).not.toContain('WAREHOUSE_SPILL');
      expect(rules({ ...spilling, daysSpilled: 1 }, definition())).not.toContain('WAREHOUSE_SPILL');
    });
  });

  describe('idle uptime', () => {
    // Both active labs warehouses: 5.7% and 9.5% of paid cluster time spent executing statements.
    const idling = pressure({ busyMs: 200_000, upMs: 50 * 3_600_000, clusterMs: 50 * 3_600_000, executionPercent: 5.7 });

    it('fires where most of the paid time produced nothing', () => {
      expect(rules(idling, definition())).toContain('WAREHOUSE_IDLE_UPTIME');
    });

    it('says nothing about a warehouse that came up once for a minute', () => {
      expect(rules({ ...idling, upMs: 60_000, clusterMs: 60_000 }, definition())).not.toContain(
        'WAREHOUSE_IDLE_UPTIME'
      );
    });

    it('carries the auto-stop only where the definition was matched', () => {
      const withDefinition = analyseSizing([idling], [definition()], 7, ruleset);
      const without = analyseSizing([idling], [], 7, ruleset);
      const labels = (found: typeof withDefinition) =>
        (found?.warehouses[0]?.findings[0]?.evidence ?? []).map((one) => one.label);

      expect(labels(withDefinition)).toContain('Auto-stop');
      // A zero here would read as a warehouse that stops immediately, which is the opposite of the finding.
      expect(labels(without)).not.toContain('Auto-stop');
    });
  });

  describe('cold starts', () => {
    const churning = pressure({ starts: 456, daysSeen: 7 });

    it('fires on a classic warehouse that spent the window starting', () => {
      expect(rules(churning, definition())).toContain('WAREHOUSE_COLD_STARTS');
    });

    it('never fires on serverless, however often it started', () => {
      // Labs measured exactly this: 456 starts in seven days on a serverless warehouse with a five-minute
      // auto-stop. A start there is seconds, and reporting it would be reporting the product working.
      expect(rules(churning, definition({ serverless: true }))).not.toContain('WAREHOUSE_COLD_STARTS');
    });

    it('does not guess the type where no definition could be matched', () => {
      expect(rules(churning)).not.toContain('WAREHOUSE_COLD_STARTS');
    });
  });

  describe('headroom', () => {
    const quiet = pressure({ p95Ms: 4000, worstMs: 8000 });

    it('offers the next size down where nothing went wrong', () => {
      expect(rules(quiet, definition())).toContain('WAREHOUSE_HEADROOM');
    });

    it('is the lowest confidence of the five, because it measures an absence', () => {
      const analysis = analyseSizing([quiet], [definition()], 7, ruleset);
      expect(analysis?.warehouses[0]?.findings[0]?.confidence).toBe('low');
    });

    it('stays quiet where the same warehouse queued or spilled', () => {
      // A tail that is fast *because* the slow statements queued is not headroom, and shrinking the
      // warehouse would be advice in the opposite direction to the other rules on the same row.
      expect(rules({ ...quiet, queueMs: 5000 }, definition())).not.toContain('WAREHOUSE_HEADROOM');
      expect(rules({ ...quiet, spilledBytes: 5000 }, definition())).not.toContain('WAREHOUSE_HEADROOM');
    });

    it('stays quiet at the bottom of the ladder, where there is nothing to recommend', () => {
      expect(rules(quiet, definition({ size: '2X-Small' }))).not.toContain('WAREHOUSE_HEADROOM');
      // And on a size the ladder does not know, rather than guessing a step below it.
      expect(rules(quiet, definition({ size: 'Enormous' }))).not.toContain('WAREHOUSE_HEADROOM');
    });

    it('recognises the size in either spelling the platform uses', () => {
      // `X-Small` from the REST API and `X_SMALL` from the system table are the same size, and a ladder
      // that knew one would silently stop working when a reading came from the other.
      const table = analyseSizing([quiet], [definition({ size: 'X_SMALL' })], 7, ruleset);
      expect(table?.warehouses[0]?.nextSizeDown).toBe('2X-Small');
      expect(table?.warehouses[0]?.findings.map((one) => one.rule)).toContain('WAREHOUSE_HEADROOM');
    });
  });

  it('names a warehouse by its id where its definition is gone', () => {
    // A warehouse deleted after it ran leaves its statements in the history and no live row to name it.
    const analysis = analyseSizing([pressure()], [], 7, ruleset);
    expect(analysis?.warehouses[0]?.name).toBe('wh1');
    expect(analysis?.live).toBeUndefined();
  });

  it('puts the warehouses with something wrong above the ones without', () => {
    const busy = pressure({ warehouseId: 'busy', totalMs: 9_000_000 });
    const queued = pressure({
      warehouseId: 'queued',
      totalMs: 1_000_000,
      queueMs: 300_000,
      queuePercent: 30,
      daysQueued: 5,
    });

    const analysis = analyseSizing(
      [busy, queued],
      [definition({ warehouseId: 'busy', name: 'busy' }), definition({ warehouseId: 'queued', name: 'queued' })],
      7,
      ruleset
    );

    expect(analysis?.warehouses.map((one) => one.warehouseId)).toEqual(['queued', 'busy']);
    expect(analysis?.live).toBe(2);
  });

  it('reports the window it read rather than the one it was asked for', () => {
    // Capped the way the statement caps it. A caller asking for thirty days is told seven.
    expect(analyseSizing([pressure()], [definition()], 30, ruleset)?.windowDays).toBe(7);
  });

  it('carries the population the statement saw, so a capped result can say so', () => {
    const analysis = analyseSizing([pressure({ warehousePopulation: 940 })], [definition()], 7, ruleset);
    expect(analysis?.population).toBe(940);
  });
});

describe('the size ladder', () => {
  it('starts at the smallest size a customer can choose', () => {
    // The headroom rule declines to fire at index 0, so an extra step at the bottom would invent a size.
    expect(SIZE_LADDER[0]).toBe('2X-Small');
  });
});
