// The sentences on this page that a reader would draw a conclusion from, asserted.
//
// Three of them are the reason the file exists, and all three were wrong once against real data:
//
//   The opening line has to keep "we looked and found nothing" apart from "we declined to look". On the
//   first workspace this ran against, both warehouses that ran anything were majority this app's own
//   statements, and the sentence said "no rule fired on any of them" — which reads as a clean bill of
//   health for an estate the advisor had refused to assess.
//
//   The subset disclosure has to reconcile the two numbers the opening line exposes. That estate had 24
//   warehouses and the page listed 5, because a warehouse that never started, never stopped and ran
//   nothing appears in neither system table the window reads.
//
//   The utilisation sentence has to say what the figure is not. It is statement execution over paid
//   cluster time, it looks like a CPU number, and a reader who took a warehouse at 6% for an idle CPU
//   would reach for a smaller size instead of a shorter auto-stop.

import { describe, expect, it } from 'vitest';
import {
  capSentence,
  carriedSentence,
  clustersSentence,
  configurationLine,
  leadSizingFinding,
  paidDiffers,
  rulesSentence,
  sizingSentence,
  STATE_DETAIL,
  STATE_LABEL,
  utilisationSentence,
  stateFacts,
  WAREHOUSE_STATES,
  workloadLine,
} from './warehouse-language';
import type { Sizing, SizingFinding, WarehouseSizing, WarehouseState } from '../api/types';

function warehouse(overrides: Partial<WarehouseSizing> = {}): WarehouseSizing {
  return {
    workspaceId: 'w1',
    warehouseId: 'wh1',
    name: 'Reporting',
    state: 'clean',
    findings: [],
    runs: 100,
    measuredRuns: 100,
    totalMs: 100_000,
    busyMs: 50_000,
    queueMs: 0,
    spilledBytes: 0,
    peakUsers: 3,
    daysUsed: 5,
    daysQueued: 0,
    daysSpilled: 0,
    upMs: 500_000,
    clusterMs: 500_000,
    starts: 4,
    peakClusters: 1,
    carriedIn: false,
    ...overrides,
  };
}

function sizing(overrides: Partial<Sizing> = {}): Sizing {
  return {
    warehouses: [warehouse()],
    findingCount: 0,
    used: 1,
    population: 1,
    matched: 1,
    windowDays: 7,
    rulesVersion: 1,
    ...overrides,
  };
}

function finding(overrides: Partial<SizingFinding> = {}): SizingFinding {
  return {
    rule: 'WAREHOUSE_QUEUEING',
    severity: 'high',
    confidence: 'high',
    action: 'Increase this warehouse’s maximum cluster count',
    headline: 'Statements queued for capacity',
    detail: 'Raise the maximum cluster count.',
    docUrl: 'https://docs.databricks.com/',
    evidence: [],
    ...overrides,
  };
}

describe('sizingSentence', () => {
  it('says nothing ran rather than nothing was wrong when no warehouse was used', () => {
    const line = sizingSentence(sizing({ used: 0, warehouses: [] }));

    expect(line).toContain('No warehouse ran a statement');
    expect(line).toContain('nothing to size against');
    expect(line).not.toContain('No rule fired');
  });

  it('reports the finding count where rules fired', () => {
    expect(sizingSentence(sizing({ findingCount: 3 }))).toBe(
      '1 warehouse ran statements in the last 7 days. 3 findings across them.'
    );
  });

  /*
   * The labs shape, and the reason the opening line names the exclusion.
   *
   * The only warehouse in the workspace is the one the app runs on. Our statements are excluded before
   * anything is counted, so it ran nothing — and "no warehouse ran a statement" printed above a row headed
   * "only this assessment ran" reads as the page contradicting itself.
   */
  it('says whose statements are missing where the only warehouse is the one assessing', () => {
    const line = sizingSentence(
      sizing({ used: 0, population: 1, warehouses: [warehouse({ state: 'assessment-only' })] })
    );

    expect(line).toContain('statement of yours');
    expect(line).toContain("assessment's own are excluded");
  });

  it('does not blame the exclusion where an estate simply ran nothing', () => {
    const line = sizingSentence(sizing({ used: 0, population: 1, warehouses: [warehouse({ state: 'unused' })] }));

    expect(line).toContain('No warehouse ran a statement in the last');
    expect(line).not.toContain('of yours');
  });

  /*
   * There used to be a clause here naming the warehouses withheld because their workload was mostly ours,
   * and four tests holding it to number agreement. Our statements are no longer counted, so no warehouse is
   * withheld and the verdict has one reason left to give.
   */
  it('reports on the rest where some warehouses were assessed and nothing fired', () => {
    const line = sizingSentence(
      sizing({
        used: 2,
        population: 2,
        findingCount: 0,
        warehouses: [warehouse({ state: 'unmeasured' }), warehouse({ warehouseId: 'wh2', state: 'clean' })],
      })
    );

    expect(line).toContain('1 ran nothing that could be timed');
    expect(line).toContain('Nothing fired on the rest.');
  });

  it('reports findings and untimed warehouses together where there are both', () => {
    const line = sizingSentence(
      sizing({
        used: 2,
        population: 2,
        findingCount: 1,
        warehouses: [warehouse({ state: 'advised' }), warehouse({ warehouseId: 'wh2', state: 'unmeasured' })],
      })
    );

    expect(line).toContain('1 finding across them');
    expect(line).toContain('1 ran nothing that could be timed');
  });

  it('says nothing fired where nothing fired and everything was measured', () => {
    expect(sizingSentence(sizing())).toContain('No rule fired on any of them.');
  });

  it('names the estate as the denominator where the inventory was read', () => {
    expect(sizingSentence(sizing({ live: 21 }))).toContain('of 21 in the estate');
  });

  it('claims no denominator where the inventory was not read', () => {
    expect(sizingSentence(sizing())).not.toContain('in the estate');
  });
});

describe('capSentence', () => {
  it('says nothing where the page is the whole story', () => {
    expect(capSentence(sizing())).toBeUndefined();
  });

  it('discloses the row cap where more warehouses were seen than returned', () => {
    const line = capSentence(sizing({ population: 900 }));

    expect(line).toContain('busiest of 900');
  });

  /*
   * The second regression. 21 live warehouses, 5 rows, and nothing on the page accounting for the rest.
   */
  it('accounts for live warehouses the window never saw', () => {
    const line = capSentence(sizing({ population: 5, live: 21, matched: 3, warehouses: [warehouse(), warehouse()] }));

    // Live minus matched, not live minus population: labs saw five warehouses of which three were in the
    // inventory, so eighteen of the estate's twenty-one were quiet rather than sixteen.
    expect(line).toContain('18 of the estate');
    expect(line).toContain('neither ran a statement nor started or stopped');
  });

  it('says nothing about quiet warehouses where the window saw every live one', () => {
    expect(capSentence(sizing({ population: 1, live: 1, matched: 1 }))).toBeUndefined();
  });
});

describe('utilisationSentence', () => {
  it('says the figure is not a measure of how busy the cores were', () => {
    const line = utilisationSentence(warehouse({ executionPercent: 5.7 }));

    expect(line).toContain('not how busy the cores were');
  });

  /*
   * The sentence printed the two durations and left the reader to divide. On a warehouse that reached two
   * clusters the wall clock and the paid cluster time differ, so the reader's arithmetic came out at 5.6%
   * while the rules were firing on 5.7%. It now prints the share and names the divisor.
   */
  it('prints the share rather than leaving the reader to divide', () => {
    const line = utilisationSentence(warehouse({ executionPercent: 5.7 }));

    expect(line).toContain('5.7%');
    expect(line).toContain('cluster time');
  });

  it('names the wall clock separately where more than one cluster ran', () => {
    const line = utilisationSentence(
      warehouse({ executionPercent: 5.7, upMs: 500_000, clusterMs: 900_000, peakClusters: 2 })
    );

    expect(line).toContain('by the wall clock');
  });

  it('does not distinguish the two where they are the same number', () => {
    expect(utilisationSentence(warehouse({ executionPercent: 5.7 }))).not.toContain('wall clock');
  });

  /*
   * Labs printed `Time up 46.4 h` beside `Paid cluster time 46.4 h` and a sentence promising a difference
   * between them, because the two were 34 seconds apart in milliseconds and identical once rendered.
   */
  it('does not promise a difference the display rounds away', () => {
    const line = utilisationSentence(
      warehouse({ executionPercent: 5.7, upMs: 167_159_305, clusterMs: 167_193_458, peakClusters: 2 })
    );

    expect(line).not.toContain('wall clock');
  });

  it('explains a share over 100 as concurrency rather than leaving it as an error', () => {
    const line = utilisationSentence(warehouse({ executionPercent: 240 }));

    expect(line).toContain('several ran at once');
    expect(line).toContain('rather than an error');
    expect(line).toContain('240%');
  });

  it('says nothing where there was no uptime to divide by', () => {
    expect(utilisationSentence(warehouse({ upMs: 0, clusterMs: 0, executionPercent: 0 }))).toBeUndefined();
    expect(utilisationSentence(warehouse())).toBeUndefined();
  });
});

/*
 * The one field that distinguishes an observed session from an inferred one.
 *
 * A warehouse up for the whole window and never resized records no event inside it, so before the seed
 * existed it reported no uptime, and after the seed it reports uptime with no starts and no days seen.
 * Those two rows are indistinguishable on the page without this, and the difference between them is
 * whether the figure was measured or carried.
 */
describe('carriedSentence', () => {
  it('says the window opened with the warehouse already up', () => {
    const line = carriedSentence(warehouse({ carriedIn: true, upMs: 500_000 }));

    expect(line).toContain('already running when the window opened');
    // And explains the reading it is there to prevent: uptime beside no starts is not a contradiction.
    expect(line).toContain('no event');
  });

  /*
   * `carriedIn` is one bit — the seeded interval exists — and says nothing about how much of the uptime
   * it accounts for. A sentence naming a share would be more specific than the field under it.
   */
  it('names no duration or share, because the field carries neither', () => {
    expect(carriedSentence(warehouse({ carriedIn: true, upMs: 500_000 }))).not.toMatch(/\d/);
  });

  it('says nothing where the window opened with the warehouse down', () => {
    expect(carriedSentence(warehouse({ carriedIn: false, upMs: 500_000 }))).toBeUndefined();
  });
});

describe('paidDiffers', () => {
  it('compares what the reader will see, not what the record holds', () => {
    expect(paidDiffers(warehouse({ upMs: 167_159_305, clusterMs: 167_193_458 }))).toBe(false);
    expect(paidDiffers(warehouse({ upMs: 500_000, clusterMs: 900_000 }))).toBe(true);
  });

  it('is false where nothing distinguishes them at all', () => {
    expect(paidDiffers(warehouse({ upMs: 500_000, clusterMs: 500_000 }))).toBe(false);
  });
});

describe('clustersSentence', () => {
  /*
   * Labs put "1 cluster" in the configuration caption and "Clusters at peak 2" in a grid a panel away, with
   * nothing reconciling them. Both readings are sincere; the page has to say which is which.
   */
  it('reconciles a peak above the configured maximum', () => {
    const line = clustersSentence(warehouse({ maxClusters: 1, peakClusters: 2 }));

    expect(line).toContain('2 clusters at its peak');
    expect(line).toContain('maximum of 1');

    /*
     * The reconciliation is the whole value here, and the cause was invented. This used to end "so the
     * likeliest reason is that the cluster range was changed during the window", which the app had not read:
     * there is no configuration-change event behind it, and a scaling policy or a warehouse recreated during
     * the window fits the same two numbers. The assertion below was `toContain('changed during the window')`,
     * so it pinned the wording of the guess and would have passed forever whether or not it was true — the
     * `bounds.ts` failure AGENTS.md cites, in a test.
     */
    expect(line).not.toMatch(/likeliest|changed during the window/);
  });

  it('says nothing where the peak is within the configured range', () => {
    expect(clustersSentence(warehouse({ maxClusters: 4, peakClusters: 2 }))).toBeUndefined();
    expect(clustersSentence(warehouse({ maxClusters: 1, peakClusters: 1 }))).toBeUndefined();
  });

  it('says nothing where no configuration was read, rather than comparing against a guess', () => {
    expect(clustersSentence(warehouse({ peakClusters: 9 }))).toBeUndefined();
  });
});

describe('configurationLine', () => {
  it('names the size, the type, the cluster range and the auto-stop', () => {
    const line = configurationLine(
      warehouse({ size: 'Small', serverless: false, minClusters: 1, maxClusters: 4, autoStopMinutes: 10 })
    );

    expect(line).toBe('Small · Classic · 1–4 clusters · stops after 10 min');
  });

  it('says a single cluster in the singular', () => {
    expect(configurationLine(warehouse({ minClusters: 1, maxClusters: 1 }))).toBe('1 cluster');
  });

  it('names a warehouse that never stops rather than reporting zero minutes', () => {
    expect(configurationLine(warehouse({ autoStopMinutes: 0 }))).toBe('never stops');
  });

  /*
   * Not defensive. A warehouse deleted after its statements were recorded has history and no definition,
   * and inventing "Small · 1 cluster" would be advising on a configuration nobody can check.
   */
  it('refuses to invent a configuration, and names both reasons one could be missing', () => {
    const line = configurationLine(warehouse());

    expect(line).toContain('No definition read');
    // Both, because on labs the cause was the second and the sentence only offered the first.
    expect(line).toContain('deleted');
    expect(line).toContain('could not reach');
  });
});

describe('workloadLine', () => {
  it('says what ran and over how many days', () => {
    expect(workloadLine(warehouse({ runs: 1452, daysUsed: 7 }))).toContain('1,452 statements over 7 days');
  });

  it('keeps a warehouse that was paid for and idle apart from one with nothing recorded', () => {
    expect(workloadLine(warehouse({ runs: 0, upMs: 600_000 }))).toContain('ran nothing');
    expect(workloadLine(warehouse({ runs: 0, upMs: 0 }))).toContain('no uptime recorded');
  });

  it('says one statement in the singular', () => {
    expect(workloadLine(warehouse({ runs: 1, daysUsed: 1 }))).toContain('1 statement over 1 day');
  });
});

describe('the states', () => {
  it('gives every state a label and a full explanation', () => {
    for (const state of WAREHOUSE_STATES) {
      expect(STATE_LABEL[state]).toBeTruthy();
      expect(STATE_DETAIL[state].length).toBeGreaterThan(80);
    }
  });

  it('leads with the state that has something to do', () => {
    expect(WAREHOUSE_STATES[0]).toBe('advised');
  });

  /*
   * The four that mean "no findings" have to be four different sentences, or the page has made the reader
   * guess which one it meant. `unmeasured` exists because labs reported it as `clean`.
   */
  it('keeps the four empty states apart', () => {
    const empty = [STATE_DETAIL.clean, STATE_DETAIL.unmeasured, STATE_DETAIL.unused, STATE_DETAIL['assessment-only']];

    expect(new Set(empty).size).toBe(4);
    expect(STATE_DETAIL.unused).toContain('no workload to size it against');
    expect(STATE_DETAIL.unmeasured).toContain('for want of a measurement');
    expect(STATE_LABEL.unmeasured).not.toBe(STATE_LABEL.clean);
  });

  /*
   * The labs crash, pinned. A stored advisory outlives the build that wrote it, so renaming a state was
   * enough to hand React `undefined` where a component goes and turn the whole page into an error
   * boundary. Every read of these records goes through `stateFacts` now.
   */
  it('describes a state this build has never heard of rather than resolving to nothing', () => {
    // `ours` is the real value on disk: the state this change removed, still in the analysis labs stored.
    const stale = stateFacts('ours' as WarehouseState);

    expect(stale.label).toBe('State not recognised');
    expect(stale.Icon).toBeTruthy();
    expect(stale.tone).toBe('neutral');
    // And it tells the reader what to do about it, rather than translating a word it cannot read.
    expect(stale.detail).toContain('a different version');
    expect(stale.detail).toContain('Run the advisor again');
  });

  it('still answers from the records for a state it does know', () => {
    for (const state of WAREHOUSE_STATES) {
      const facts = stateFacts(state);
      expect(facts.label).toBe(STATE_LABEL[state]);
      expect(facts.detail).toBe(STATE_DETAIL[state]);
      expect(facts.Icon).toBeTruthy();
    }
  });

  /*
   * The label is the thing the user objected to. "Measuring ourselves" is the tool talking about itself in
   * a list of the customer's warehouses; the reader's question is what ran on it.
   */
  it('describes the assessment-only warehouse by what ran on it, not by who we are', () => {
    expect(STATE_LABEL['assessment-only']).toBe('Only this assessment ran');
    expect(STATE_LABEL['assessment-only']).not.toContain('ourselves');
    // And it must not read as an idle warehouse, because acting on that means deleting it.
    expect(STATE_LABEL['assessment-only']).not.toBe(STATE_LABEL.unused);
    expect(STATE_DETAIL['assessment-only']).toContain('excluded from every figure');
  });
});

describe('leadSizingFinding', () => {
  it('carries the worst finding, which the analyzer sorted first', () => {
    expect(leadSizingFinding(warehouse({ findings: [finding(), finding({ rule: 'WAREHOUSE_SPILL' })] }))).toBe(
      'Statements queued for capacity'
    );
  });

  it('says nothing where there is nothing to say', () => {
    expect(leadSizingFinding(warehouse())).toBeUndefined();
  });
});

describe('rulesSentence', () => {
  it('names the rule set and the window, so two runs can be compared', () => {
    const line = rulesSentence(sizing({ rulesVersion: 2 }));

    expect(line).toContain('sizing rule set 2');
    expect(line).toContain('7 days');
  });

  /*
   * One advisory run reports three windows across three pages. Each is defensible and the difference read as
   * one of the pages being stale, so the page that has the shortest window says why it has it.
   */
  it('says why this window is shorter than the rest of the run', () => {
    expect(rulesSentence(sizing())).toContain('shorter than the rest of the run');
  });
});
