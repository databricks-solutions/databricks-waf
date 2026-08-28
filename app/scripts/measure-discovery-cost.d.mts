/** Types for measure-discovery-cost.mjs, which is JavaScript so it can run from the CLI unbuilt. */

/** One CTE of the statement, as parsed out of its `WITH` clause. */
export interface Part {
  readonly name: string;
  readonly body: string;
}

/** The statement's `WITH` bodies and the final `SELECT` they feed. */
export interface Parts {
  readonly ctes: readonly Part[];
  readonly tail: string;
}

/** The statement rebuilt without one CTE, and what removing it cost the output. */
export interface Cut {
  readonly statement: string;
  /** The alias the dropped CTE was joined under, which is how its output columns were found. */
  readonly alias: string;
  /**
   * Whether the variant counts more rows than the statement ships, which an inner join's cut does
   * and a left join's does not. A reading taken over a wider population is still a reading; one
   * recorded without saying so is a number about a statement nobody runs.
   */
  readonly widensPopulation: boolean;
  readonly droppedColumns: number;
}

/** Whether a probe ran, ran out of polls, was refused, or never started. */
export type Verdict = 'ran' | 'unfinished' | 'refused' | 'not probed' | 'not a defined cut';

export interface Timing {
  readonly name: string;
  readonly verdict: Verdict;
  readonly ms: number | null;
  readonly error: string | null;
}

export interface PartTiming extends Timing {
  /** What the part returns on its own, which is the fan-out a join above it has to absorb. */
  readonly rows: number | null;
}

export interface CutTiming extends Timing {
  readonly droppedColumns: number | null;
  readonly widensPopulation: boolean | null;
  /** Why no variant could be built, where the cut is not defined for that CTE. */
  readonly undefinedBecause: string | null;
}

export interface DiscoveryStatementCost {
  readonly runFinishedAt: string;
  readonly profile?: string;
  readonly host?: string;
  readonly warehouse?: string;
  readonly lookbackDays: number;
  readonly statement: string;
  /** The statement text these readings are of, so a changed statement cannot inherit them. */
  readonly statementSha: string;
  readonly budget: {
    /** Shorter than the statement's: a part is asked whether it is the outlier, not what it costs. */
    readonly pollsPerPart: number;
    readonly pollsPerStatement: number;
    readonly runBudgetMs: number;
    readonly spentMs: number;
  };
  readonly whole: { readonly verdict: Verdict; readonly ms: number | null; readonly error: string | null };
  readonly parts: readonly PartTiming[];
  readonly withoutEachPart: readonly CutTiming[];
}

export function customerCatalog(text: string): string;

/** The named statement's shipped text. Defaults to the `STATEMENT` the run was started with. */
export function shipped(name?: string): string;

export function parts(text: string): Parts;

export function without(text: string, name: string): Cut;

export function splitTopLevel(list: string): readonly string[];

export function verdict(found: { ok?: boolean; error?: string; skipped?: string } | null): Verdict;

/**
 * The parts ordered by what each cost alone, dearest first, so a run that exhausts its budget has
 * measured the cut that can move the total rather than the ones that cannot.
 */
export function dearestFirst<T extends { readonly name: string }>(
  ctes: readonly T[],
  alone: readonly { readonly name: string; readonly ok?: boolean; readonly ms?: number; readonly error?: string }[]
): readonly T[];
