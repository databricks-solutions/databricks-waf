// The join between this run's plans and the shapes they belong to.
//
// Small enough to look obvious, and it is the piece that decides which plan a finding is about. The workspace
// half of the key is the part worth a test: `33k` measured that one `shape` spans workspaces and that the two
// end differently, so a lookup on the shape alone answers with a plan from an estate the row is not about.

import { describe, expect, it } from 'vitest';
import { PARSER_VERSION, type PlanExtract } from '../collect/sql/plans/parse.js';
import type { ShapePlan } from '../collect/sql/plans/retrieve.js';
import { noPlans, planIndex, readingFor } from './plan-index.js';

function extract(fingerprint: string): PlanExtract {
  return {
    parserVersion: PARSER_VERSION,
    fingerprint,
    operatorCount: 1,
    operators: [{ id: '1', tag: 'UNKNOWN.PhotonScalarUDF' }],
    operatorsWithoutMetrics: 1,
    operatorsWithZeroMetrics: 0,
    edges: [],
    edgesWithUnknownEndpoint: 0,
  };
}

function plan(overrides: Partial<ShapePlan> = {}): ShapePlan {
  return {
    workspaceId: 'w1',
    shape: 'aaaaaaaaaaaaaaaa',
    statementId: 'st1',
    extract: extract('one'),
    observedAt: new Date('2026-08-09T10:00:00Z'),
    ...overrides,
  };
}

describe('indexing this run’s plans', () => {
  it('answers the plan for a shape in the workspace that ran it', () => {
    const index = planIndex([plan()]);

    expect(index.size).toBe(1);
    expect(index.for({ workspaceId: 'w1', shape: 'aaaaaaaaaaaaaaaa' })?.statementId).toBe('st1');
  });

  it('does not answer a sibling workspace’s plan for the same shape', () => {
    // The failure this key exists to prevent, and it is not hypothetical: the same statement text in two
    // workspaces is two rows sharing one `shape`, and the plan is fetchable in one and refused in the other.
    const index = planIndex([plan({ workspaceId: 'w2' })]);

    expect(index.for({ workspaceId: 'w1', shape: 'aaaaaaaaaaaaaaaa' })).toBeUndefined();
    expect(index.for({ workspaceId: 'w2', shape: 'aaaaaaaaaaaaaaaa' })).toBeDefined();
  });

  it('keeps both when two workspaces ran the same shape', () => {
    const index = planIndex([plan(), plan({ workspaceId: 'w2', statementId: 'st2' })]);

    expect(index.size).toBe(2);
    expect(index.for({ workspaceId: 'w2', shape: 'aaaaaaaaaaaaaaaa' })?.statementId).toBe('st2');
  });

  it('keeps the first where a shape somehow arrived twice', () => {
    // `retrievePlans` produces one plan per shape, so this is a tie-break nothing exercises. Asserted anyway,
    // because the alternative — last wins — would make which plan a rule read depend on array order, and that
    // is the kind of thing that changes under an unrelated edit and is never noticed.
    const index = planIndex([plan(), plan({ statementId: 'later' })]);

    expect(index.size).toBe(1);
    expect(index.for({ workspaceId: 'w1', shape: 'aaaaaaaaaaaaaaaa' })?.statementId).toBe('st1');
  });

  it('is empty for a run that retrieved nothing, and for one that could not try', () => {
    // Both spellings the runner can produce: `undefined` where plan retrieval never ran — no warehouses
    // readable, the signal unreadable — and an empty array where it ran and reached nothing.
    for (const index of [planIndex(undefined), planIndex([]), noPlans()]) {
      expect(index.size).toBe(0);
      expect(index.for({ workspaceId: 'w1', shape: 'aaaaaaaaaaaaaaaa' })).toBeUndefined();
    }
  });
});

describe('what a rule is handed', () => {
  it('carries the extract, and only that', () => {
    // Only that on purpose, and asserted rather than assumed: a field handed to every condition that no
    // condition reads is a field whose reason for existing cannot be checked. `observedAt` is on `ShapePlan`
    // for the store that files it, and reaches a rule when a rule and a surface can use it.
    const reading = readingFor(planIndex([plan()]), { workspaceId: 'w1', shape: 'aaaaaaaaaaaaaaaa' });

    expect(reading?.extract.fingerprint).toBe('one');
    expect(Object.keys(reading ?? {})).toEqual(['extract']);
  });

  it('answers nothing for a shape with no plan', () => {
    expect(readingFor(noPlans(), { workspaceId: 'w1', shape: 'aaaaaaaaaaaaaaaa' })).toBeUndefined();
  });
});
