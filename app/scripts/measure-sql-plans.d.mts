// Types for the functions `measure-sql-plans.mjs` exports so a test can hold them against what ships.
// The script stays JavaScript for the reason its header gives — it runs straight from source with no
// build step, like every other live measurement script here.

/** The bucket wrapper, which has to be the one `server/collect/sql/buckets.ts` builds. */
export function bucketed(statement: string, column: string, of: number, index: number): string;

/** The `-- Slice:` axes the script reads, which have to be the ones `slices.ts` reads. */
export function declaredSliceColumns(statement: string): string[];

/** One node of a formatted plan that reads something, or stands where a read was folded away. */
export interface PlanRead {
  readonly node: number;
  /** The node's own name: `Scan`, `PhotonScan`, `LocalTableScan`. */
  readonly kind: string;
  /** The relation, with the format word stripped. Empty for a fold, which names none. */
  readonly relation: string;
  /** What the engine says the node outputs, or null where the plan did not say. */
  readonly columnCount: number | null;
  /** `Arguments: <empty>` — a fold over a relation with nothing in it. */
  readonly emptyArguments: boolean;
}

/**
 * The reads in a formatted plan, split by whether the engine performs them.
 *
 * `scans` are real reads and answer both of Q1k's premises: how many columns come off a relation, and
 * how many times the plan reads it. `folded` are reads the optimiser replaced with a constant, which
 * answer neither — and have to be reported rather than skipped, because a statement with none of the
 * first and several of the second otherwise reads as a refutation.
 */
export function scansOf(plan: string): { scans: PlanRead[]; folded: PlanRead[] };
