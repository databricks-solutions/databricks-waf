export interface CustomerHierarchyReading {
  readonly headings: readonly string[];
  readonly emptyCount: number;
  readonly primaryActionLabels: readonly string[];
  readonly recommendations: readonly {
    readonly text: string;
    readonly destinationCount: number;
    readonly beforeSupport: boolean;
    readonly inFirstViewport: boolean;
  }[];
}

export function customerHierarchyProblems(reading: CustomerHierarchyReading): string[];
