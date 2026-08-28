/** Types for check-skill-vendoring.mjs, which is JavaScript so it can run from the CLI unbuilt. */

/** The pin the drift workflow used to read, as a repository-relative path. */
export const LOCK: string;

/** The vendored directory `.gitignore` excludes, as a repository-relative path. */
export const VENDOR: string;

/** What the check knows about the repository, gathered from disk. */
export interface VendoringState {
  readonly lock: boolean;
  readonly ignored: boolean;
  /** The file `npm run vendor:skills` would run, or null where no such script is declared. */
  readonly script: string | null;
  readonly scriptExists: boolean;
  readonly readers: readonly string[];
}

/** Every way the arrangement departs from ADR 0002's fallback, in the reader's terms. */
export function problems(state: VendoringState): readonly string[];

/** Every source file that reads the vendored directory, scanned from disk. */
export function readers(): readonly string[];

/** Whether a file reads the vendored skills, as opposed to discussing the arrangement. */
export function readsVendoredSkills(path: string, text: string): boolean;
