/** Types for awaiting-reading.mjs, which is JavaScript so the SQL release gate can run it unbuilt. */

/** What a statement on the awaiting list was submitted as, and what came back. */
export interface Submission {
  readonly at: string;
  readonly profile: string;
  readonly warehouseId: string;
  readonly statementSha: string;
  readonly sqlState: string;
  readonly error: string;
  readonly parameters: Readonly<Record<string, string>>;
}

/** One statement with no labs reading, the row that owes one, and the submission behind its excuse. */
export interface AwaitingEntry {
  readonly since: string;
  readonly why: string;
  readonly owedBy: string;
  readonly submitted: Submission;
}

export const APP: string;
export const STATEMENTS: string;
export const AWAITING: string;
export const UNPARSED: ReadonlySet<string>;

export function shaOf(text: string): string;
export function entries(file?: string): Readonly<Record<string, AwaitingEntry>>;
export function faults(entry: unknown, text: string | null): string[];
export function problems(options?: { file?: string; dir?: string }): string[];
