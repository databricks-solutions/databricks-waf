/** Types for measure-read-paths.mjs, which is JavaScript so it can run from the CLI unbuilt. */

export interface Population {
  readonly scoped: readonly string[];
  readonly byParent: readonly { readonly table: string; readonly parent: string }[];
}

export interface Read {
  readonly file: string;
  readonly line: number;
  readonly table: string | null;
  readonly class: 'scoped' | 'by-parent' | null;
  readonly shape: 'predicate' | 'join' | 'unclassified';
  readonly alreadyFiltersDefinition: boolean;
  readonly reason: string | null;
  readonly sql: string;
}

export interface Census {
  readonly measuredAt?: string;
  readonly source: string;
  readonly population: Population;
  readonly reads: readonly Read[];
  readonly totals: {
    readonly reads: number;
    readonly predicate: number;
    readonly join: number;
    readonly unclassified: number;
    readonly alreadyFiltersDefinition: number;
    readonly byTable: Readonly<Record<string, number>>;
  };
}

export function populationFromReset(source: string): Population;

export function readsFromSource(source: string, file: string, population: Population): readonly Read[];

export function measure(): Census;
