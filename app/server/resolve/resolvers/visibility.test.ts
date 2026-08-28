// The cross-check that stops the app calling an unreadable metastore an empty one.
//
// Three branches, and the middle one is the whole reason the helper returns `undefined` rather
// than a resolution: an estate that genuinely holds nothing must still be able to take a
// requirement out of the score, or every empty workspace reads as under-permissioned.
//
// The last test here is about the wiring rather than the logic. The scan plan collects exactly
// what resolvers declare, so a resolver that calls the cross-check without declaring the lineage
// reading is never handed it and takes the absent branch forever — reporting `unmeasurable` on
// estates it could have excluded, and doing so silently, because that branch is the safe one.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { observed, unmeasurable, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { LineageCoverage } from '../../collect/sql/shapes.js';
import type { Observation } from './helpers.js';
import { unestablishedEmptiness, VISIBILITY_CROSS_CHECK } from './visibility.js';

const LINEAGE = VISIBILITY_CROSS_CHECK as SignalId;

// One of the requirements this helper decides for, so the observation it is handed is the shape a
// resolver is handed rather than an approximation of one.
const SPEC = loadCatalogue().controls.find((control) => control.id === 'DG-01-04')!;

function coverage(overrides: Partial<LineageCoverage> = {}): LineageCoverage {
  return {
    tableCount: 0,
    tablesWithLineage: 21,
    tablesWrittenWithLineage: 14,
    tablesReadWithLineage: 19,
    lineageEvents: 1246,
    ...overrides,
  };
}

function context(signals: readonly (readonly [SignalId, SignalResult])[]): Observation {
  return { signals: new Map(signals), spec: SPEC };
}

function read(value: LineageCoverage): SignalResult {
  return observed(LINEAGE, value, 1, { mode: 'complete' });
}

describe('unestablishedEmptiness', () => {
  it('refuses the emptiness when lineage recorded activity the catalogue does not show', () => {
    const resolution = unestablishedEmptiness(context([[LINEAGE, read(coverage())]]));
    expect(resolution?.outcome).toBe('unmeasurable');
    expect(resolution?.unmeasured).toBe('unreadable');
    expect(resolution?.outcomeReason).toContain('1,246 events');
    expect(resolution?.outcomeReason).toContain('21 tables');
    expect(resolution?.remedy?.kind).toBe('grant');
    expect(resolution?.remedy?.says).toContain('BROWSE');
  });

  it('allows the emptiness when lineage corroborates it', () => {
    const quiet = coverage({
      tablesWithLineage: 0,
      tablesWrittenWithLineage: 0,
      tablesReadWithLineage: 0,
      lineageEvents: 0,
    });
    expect(unestablishedEmptiness(context([[LINEAGE, read(quiet)]]))).toBeUndefined();
  });

  it('refuses the emptiness when the corroborating reading is absent', () => {
    // Deliberately the same answer as a disagreement. The principal this exists for holds
    // nothing on the customer's catalogs and may hold nothing on `system.access` either, so
    // an unread cross-check is the case that produced the defect rather than an exception to it.
    const resolution = unestablishedEmptiness(context([]));
    expect(resolution?.outcome).toBe('unmeasurable');
    expect(resolution?.remedy?.says).toContain('BROWSE');
  });

  it('refuses the emptiness when the corroborating reading failed', () => {
    const refused = unmeasurable(LINEAGE, 'PERMISSION_DENIED');
    const resolution = unestablishedEmptiness(context([[LINEAGE, refused]]));
    expect(resolution?.outcome).toBe('unmeasurable');
  });
});

describe('the resolvers that call it', () => {
  it('each declare the reading it needs, or its answer is fixed before it runs', () => {
    for (const [file, declaration] of callers()) {
      const head = declaration.slice(0, declaration.indexOf('unestablishedEmptiness('));
      expect(head, `${file}: ${declaration.split('\n')[0]}`).toMatch(/VISIBILITY_CROSS_CHECK|LINEAGE/);
    }
  });
});

/** Every top-level declaration in this directory whose body calls the cross-check. */
function callers(): readonly (readonly [string, string])[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const found: (readonly [string, string])[] = [];

  for (const file of readdirSync(here)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file === 'visibility.ts') continue;
    const source = readFileSync(join(here, file), 'utf8');
    for (const declaration of source.split(/^const /m)) {
      if (declaration.includes('unestablishedEmptiness(')) found.push([file, declaration]);
    }
  }

  // A guard that finds nothing passes vacuously, and this one would have if the file layout had
  // moved. Ten callers at the time of writing; the floor only asserts that some were found.
  expect(found.length).toBeGreaterThan(0);
  return found;
}
