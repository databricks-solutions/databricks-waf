// Finding the data directories that ship next to the bundle.
//
// The control catalogue and the check queries are data, not code: they are read
// from `config/` at runtime rather than compiled in. That keeps them reviewable
// as YAML and SQL, and lets the type generator read the same files the server
// runs. It also means the running process has to locate them on disk.
//
// Relative paths from the module's own location do not survive bundling, because
// a source file at `server/collect/sql/queries.ts` and its build output at
// `dist/collect/sql/queries.js` sit at different depths below the app root.
// Deriving the root from the depth got this wrong once already and only showed
// up as every control reporting unmeasurable in a deployed workspace. So search
// upwards for the directory instead: it is correct at any depth, in development,
// in the bundle, and wherever the process happened to be started from.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * Absolute path to `config/<name>`, found by searching upwards from `moduleUrl`.
 *
 * Throws rather than returning a guess. A missing data directory is a packaging
 * fault, and one loud failure naming the directory is worth more than a hundred
 * controls each reporting that they could not be measured.
 */
export function shippedConfigDirectory(name: string, moduleUrl: string): string {
  const from = dirname(fileURLToPath(moduleUrl));
  let here = from;

  for (;;) {
    const candidate = join(here, 'config', name);
    if (existsSync(candidate)) return candidate;

    const parent = resolve(here, '..');
    if (parent === here) {
      throw new Error(
        `No config/${name} directory found above ${from}. This data ships alongside the bundle, so its absence ` +
          `means the deployed tree is incomplete rather than that the workspace is missing something.`
      );
    }
    here = parent;
  }
}
