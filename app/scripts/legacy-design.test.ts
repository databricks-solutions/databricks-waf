import { describe, expect, it } from 'vitest';

import { legacyDesignClasses, legacyDesignInventory, legacyDesignIsEmpty, legacyDesignTotals } from './legacy-design.mjs';

describe('the deprecated design-system boundary', () => {
  it('permits no deprecated production reference', () => {
    const current = legacyDesignInventory();

    expect(legacyDesignIsEmpty(current)).toBe(true);
    expect(legacyDesignTotals(current)).toEqual({ importingFiles: 0, elements: 0, fittedLists: 0, classes: 0, selectors: 0 });
  });

  it('detects a legacy class in component source even when no selector is defined', () => {
    expect(legacyDesignClasses('<div className="wa-panel" />')).toEqual({ 'wa-panel': 1 });
  });
});
