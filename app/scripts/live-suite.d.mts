/** Types for live-suite.mjs, which is JavaScript so `verify` can run it unbuilt. */

export interface LiveSuiteState {
  /** Every module that emits SQL against a real Postgres. */
  readonly all: readonly string[];
  /** Those the live suite drives, read from its own imports. */
  readonly covered: readonly string[];
  /** Those the fake alone stands behind. */
  readonly uncovered: readonly string[];
  readonly digest: string;
}

export const RECORDING: string;
export const SUITE: string;

export function surface(root?: string): string[];
export function covered(all: readonly string[], suite?: string): string[];
export function digest(paths: readonly string[]): string;
export function stripped(text: string): string;
export function state(): LiveSuiteState;
