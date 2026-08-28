// What the capture keeps, shortens and counts — the claims each fixture's `_capture` note makes about itself.
//
// This file exists because of `33ih`. The capping of unread `meta_data` values read one of the two spellings
// an entry takes, so nine entries in the committed capture went past it untouched while `cappedUnreadFields`
// reported the capping had happened. Nothing failed: the parser does not read those keys, `parse.test.ts`
// asserts nothing about them, and the note was the only record — which is the shape of every defect this
// phase has found so far, an apparatus describing itself rather than what it did.

import { describe, expect, it } from 'vitest';

import {
  NAMED_METRICS as CAPTURE_NAMED_METRICS,
  PROMISED_META,
  capEntry,
  capUnread,
  trimPlans,
} from './capture-plan-fixtures.mjs';
import type { Capped } from './capture-plan-fixtures.d.mts';
import { NAMED_METRICS, PROMISED_META_KEYS } from '../server/collect/sql/plans/parse.js';

const long = 'x'.repeat(200);

describe('capping an unread meta_data value', () => {
  it('shortens both spellings and counts each once', () => {
    const capped: Capped = {};
    expect(capEntry({ key: 'SCAN_RELATION_DESC', value: long }, capped)).toEqual({
      key: 'SCAN_RELATION_DESC',
      value: `${'x'.repeat(120)}…[capped]`,
    });
    expect(capEntry({ key: 'OUTPUT', values: [long, 'short'] }, capped)).toEqual({
      key: 'OUTPUT',
      values: [`${'x'.repeat(120)}…[capped]`, 'short'],
    });
    expect(capped.meta_data_values).toBe(2);
  });

  it('leaves a promised key whole, however long it is', () => {
    // The six the parser reads are the behaviour under test. A capped `SCAN_IDENTIFIER` would make the
    // fixture prove something about a table name that no response carries.
    const capped: Capped = {};
    expect(capEntry({ key: 'SCAN_IDENTIFIER', value: long }, capped)).toEqual({
      key: 'SCAN_IDENTIFIER',
      value: long,
    });
    expect(capped.meta_data_values).toBeUndefined();
  });

  it('counts nothing when nothing was over the cap, which is the committed capture', () => {
    // The longest unread value in `json-plan.json` is 28 characters. So a `meta_data_values` count on that
    // fixture would be the defect `33ih` fixed, in the other direction.
    const capped: Capped = {};
    capEntry({ key: 'JOIN_TYPE', value: 'Inner' }, capped);
    capEntry({ key: 'LEFT_KEYS', values: ['account_id'] }, capped);
    expect(capped.meta_data_values).toBeUndefined();
  });

  it('reproduces a non-string rather than coercing it, in either spelling', () => {
    // The parser coerces, because a rule reads a string. The capture does not, because `parse.test.ts:166`
    // asserts the parser survives a boolean `value`, and that shape has to be capturable to be a fixture.
    const capped: Capped = {};
    expect(capEntry({ key: 'IS_DELTA', value: true }, capped)).toEqual({ key: 'IS_DELTA', value: true });
    expect(capEntry({ key: 'FILTERS', values: [1, null] }, capped)).toEqual({ key: 'FILTERS', values: [1, null] });
    expect(capEntry({ key: 'FILTERS', values: 'not a list' }, capped)).toEqual({
      key: 'FILTERS',
      values: 'not a list',
    });
    expect(capped.meta_data_values).toBeUndefined();
  });
});

/**
 * The two lists this script keeps whole, held to the parser's own.
 *
 * They are copies because a `.mjs` capture script cannot import the TypeScript parser. A copy that has fallen
 * behind is worse than no copy: the label the parser started reading is the one the trim throws away, and the
 * fixture then passes every test about a field it no longer carries. Cheap to enforce, so enforced.
 */
describe('what the trim knows the parser reads', () => {
  it('keeps the same metric labels the parser selects', () => {
    expect([...CAPTURE_NAMED_METRICS].sort()).toEqual([...NAMED_METRICS].sort());
  });

  it('keeps the same meta_data keys the parser promises', () => {
    expect([...PROMISED_META].sort()).toEqual([...PROMISED_META_KEYS].sort());
  });
});

describe('capping the arrays a node carries', () => {
  it('keeps every metric the parser reads and caps what is left, rather than the reverse', () => {
    // The ordering is the whole behaviour. `metrics` is 264 KB of a 350 KB node list, so it has to be capped;
    // capping first would leave the eighteen the parser reads on the floor for any node that listed them after
    // the first entry, and the fixture would then prove that the parser reads nothing.
    const capped: Capped = {};
    const node = capUnread(
      {
        id: '1',
        tag: 'SHUFFLE',
        metrics: [
          { label: 'Rows output', value: 1 },
          { label: 'Something else', value: 2 },
          { label: 'Hashed relation size', value: 4096 },
          { label: 'MapStage - Skew num skewed partitions', value: 0 },
        ],
      },
      capped,
    );

    expect(node.metrics?.map((metric) => metric.label)).toEqual([
      'Hashed relation size',
      'MapStage - Skew num skewed partitions',
      'Rows output',
    ]);
    // One dropped of four, which is what the note reports — the count is of entries removed, not of entries
    // the cap would have removed had nothing been kept.
    expect(capped.metrics).toBe(1);
  });

  it('counts a zero-valued metric as kept, because absence and zero are different to a rule', () => {
    const capped: Capped = {};
    const node = capUnread(
      { id: '1', tag: 'SHUFFLE', metrics: [{ label: 'MapStage - Skew num skewed partitions', value: 0 }] },
      capped,
    );

    expect(node.metrics).toEqual([{ label: 'MapStage - Skew num skewed partitions', value: 0 }]);
    expect(capped.metrics).toBeUndefined();
  });
});

/**
 * The filter that matched nothing, and the count that would have said so.
 *
 * This read `edge.source ?? edge.from` against a node's `id`. Neither name is what the response uses, so every
 * committed fixture carried `edges: []` beneath a note claiming the edges had been filtered to the kept nodes —
 * and `33ic` would have shipped a parser for a field tested against a graph with none of it. `33ii` had to run
 * a live probe to find the names, because nothing in the tree recorded the count before the filter.
 */
describe('trimming a graph’s edges', () => {
  const body = (edges: readonly unknown[]): unknown => ({
    plans: {
      one: {
        nodes: [
          { id: '1', tag: 'A' },
          { id: '2', tag: 'B' },
          { id: '3', tag: 'A' },
        ],
        edges,
      },
    },
  });

  it('keeps an edge between two kept nodes, on the field names the response uses', () => {
    const { body: trimmed, original } = trimPlans(body([{ from_id: '1', to_id: '2' }]));

    expect(trimmed.plans?.one.edges).toEqual([{ from_id: '1', to_id: '2' }]);
    expect(original?.edges).toBe(1);
    expect(original?.edgesKept).toBe(1);
  });

  it('drops an edge to a node the trim did not keep, and says how many it dropped', () => {
    // The trim keeps one node per distinct tag and then fills to its bound, so on a real plan it drops nodes
    // and their edges go with them. Written as an edge naming a node the graph never had, because the bound is
    // 60 and a test that built 61 nodes to reach it would be testing the bound. Without both counts in
    // `_capture`, a fixture with no edges cannot say whether this happened or whether the plan had none.
    const { body: trimmed, original } = trimPlans(
      body([{ from_id: '1', to_id: '2' }, { from_id: '2', to_id: '99' }]),
    );

    expect(trimmed.plans?.one.edges).toEqual([{ from_id: '1', to_id: '2' }]);
    expect(original?.edges).toBe(2);
    expect(original?.edgesKept).toBe(1);
  });

  it('matches an endpoint that arrived as a number, because the parser coerces the id it compares', () => {
    // The silent half of the original defect: a filter comparing `1` against `'1'` with `Set.has` keeps nothing
    // and reports nothing, which is indistinguishable from a plan whose edges name other operators.
    const { original } = trimPlans({
      plans: { one: { nodes: [{ id: 1, tag: 'A' }, { id: 2, tag: 'B' }], edges: [{ from_id: 1, to_id: 2 }] } },
    });

    expect(original?.edgesKept).toBe(1);
  });

  it('reports no edges as none rather than as filtered away', () => {
    const { original } = trimPlans(body([]));

    expect(original?.edges).toBe(0);
    expect(original?.edgesKept).toBe(0);
  });
});
