export interface LegacyDesignInventory {
  readonly deprecatedImports: Record<string, string[]>;
  readonly deprecatedElements: Record<string, Record<string, number>>;
  readonly fittedLists: Record<string, number>;
  readonly legacyClasses: Record<string, Record<string, number>>;
  readonly legacySelectors: Record<string, Record<string, number>>;
}

export interface LegacyDesignTotals {
  readonly importingFiles: number;
  readonly elements: number;
  readonly fittedLists: number;
  readonly classes: number;
  readonly selectors: number;
}

export function legacyDesignClasses(source: string): Record<string, number>;
export function legacyDesignInventory(): LegacyDesignInventory;
export function legacyDesignTotals(inventory: LegacyDesignInventory): LegacyDesignTotals;
export function legacyDesignIsEmpty(inventory: LegacyDesignInventory): boolean;
