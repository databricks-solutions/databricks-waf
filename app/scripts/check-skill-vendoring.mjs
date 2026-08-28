/**
 * Holds the repository to the branch of ADR 0002 it actually took.
 *
 * ADR 0002 vendors official Databricks skills into `app/vendor/skills/` and grounds the serverless
 * ruleset in them, with one condition left open: whether the licence permits redistributing those
 * files inside an Apache 2.0 repository. Until it is answered the directory is gitignored, nothing
 * reads it, and the ruleset carries a documentation citation per rule instead — the ADR's own
 * fallback, and what shipped.
 *
 * Nothing recorded that. What recorded it instead was a weekly job asserting a pin file that has
 * never existed, dying on the first line of its only substantive step, on every run since it landed.
 * `66` is that, and the measurement found the vendoring branch was never built at all: no lock file,
 * no `scripts/vendor-skills.mjs` behind the `vendor:skills` script `package.json` still offered, and
 * `databricks aitools update --check` answering `no skills installed` even given a lock file, because
 * the CLI reports drift against an installation rather than against a version string.
 *
 * So this asserts the fallback, in the direction that can go wrong. Adopting vendoring is not
 * forbidden here — it is the ADR's preferred branch. It is required to be visible: the moment a lock
 * file appears, or something starts reading the vendored directory, this fails and says the drift
 * gate has to come back with it. That is the asymmetry AGENTS.md asks to preserve, applied to the one
 * check that had lost it.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(APP);

/** The pin the drift workflow used to read. Its absence is ADR 0002's unresolved condition, recorded. */
export const LOCK = 'app/config/skills.lock.yaml';

/** Where the CLI's output would be copied to, and what `.gitignore` excludes. */
export const VENDOR = 'app/vendor/skills';

/**
 * The two files that name the directory as part of managing it rather than depending on it.
 *
 * `vendor-skills.mjs` is ADR 0002's own populating script — it has to write the path it writes to,
 * and writing it is the opposite of the thing this check is looking for. Excluding it is not a
 * loophole in the check but the difference the check is about: the concern is the *shipped app*
 * behaving one way for whoever ran that script and another way everywhere else, and a script cannot
 * do that to itself. A review caught this, having noticed that restoring the script ADR 0002
 * describes would have failed a check whose message says the app now depends on a gitignored tree.
 */
const TOOLING = ['scripts/vendor-skills.mjs', 'scripts/check-skill-vendoring'];

/**
 * Whether a file reads the vendored skills at runtime.
 *
 * Prose is excluded: four documents discuss the arrangement and one of them is the ADR. The workflow
 * is excluded for the same reason — it is the thing that comes back, not a reader.
 */
export function readsVendoredSkills(path, text) {
  if (path.endsWith('.md') || path.endsWith('.yml') || path.endsWith('.yaml')) return false;
  if (TOOLING.some((tool) => path.includes(tool))) return false;
  return /vendor\/skills/.test(text);
}

/**
 * What is wrong, in the reader's terms, or nothing.
 *
 * @param {{ lock: boolean, ignored: boolean, script: string | null, scriptExists: boolean, readers: readonly string[] }} state
 */
export function problems(state) {
  const found = [];

  if (state.lock) {
    found.push(
      `${LOCK} exists, so the vendoring branch of ADR 0002 has been taken. That is allowed and it is ` +
        'the branch the ADR prefers — but the drift gate has to come back in the same change, and this ' +
        'check has to be replaced by it. Restore the step in .github/workflows/skills-drift.yml that ' +
        'runs `databricks aitools update --check`, and note that the CLI reports drift against an ' +
        'installation rather than a version string, so the job has to install before it compares.'
    );
  }

  if (state.readers.length > 0) {
    found.push(
      `${state.readers.join(', ')} reads ${VENDOR}, which is gitignored, so this app would behave one ` +
        'way for whoever ran the vendoring script and another way everywhere else. ADR 0002 requires ' +
        'the directory be absent-tolerant until the licence question is answered.'
    );
  }

  if (!state.ignored) {
    found.push(
      `${VENDOR} is no longer in .gitignore. ADR 0002 keeps it out of the tree until the licence ` +
        'covering the skills distribution is confirmed to permit redistribution inside an Apache 2.0 ' +
        'repository, which as of this check is unanswered.'
    );
  }

  if (state.script != null && !state.scriptExists) {
    found.push(
      `package.json offers \`vendor:skills\`, which runs ${state.script} — and that file does not ` +
        'exist, so the script fails with MODULE_NOT_FOUND. An entry point to a branch nobody took ' +
        'reads as a branch somebody took.'
    );
  }

  return found;
}

/** The source the app is built from. `dist` is excluded because it is the same code compiled. */
const SOURCE = ['server', 'client/src', 'shared', 'scripts'];

function* sourceFiles(from) {
  for (const entry of readdirSync(from)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const path = join(from, entry);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else yield path;
  }
}

/** Every source file that reads the vendored directory, which today has to be none of them. */
export function readers() {
  const found = [];
  for (const dir of SOURCE) {
    const from = join(APP, dir);
    if (!existsSync(from)) continue;
    for (const path of sourceFiles(from)) {
      const shown = `app/${relative(APP, path)}`;
      if (readsVendoredSkills(shown, readFileSync(path, 'utf8'))) found.push(shown);
    }
  }
  return found;
}

function state() {
  const manifest = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'));
  const vendorScript = manifest.scripts?.['vendor:skills'] ?? null;
  const file = vendorScript == null ? null : (/node\s+(\S+)/.exec(vendorScript)?.[1] ?? null);

  return {
    lock: existsSync(join(ROOT, LOCK)),
    ignored: readFileSync(join(ROOT, '.gitignore'), 'utf8')
      .split('\n')
      .some((line) => line.trim().replace(/\/$/, '') === VENDOR),
    script: file,
    scriptExists: file != null && existsSync(join(APP, file)),
    readers: readers(),
  };
}

if (process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]) {
  const found = problems(state());
  if (found.length > 0) {
    process.stderr.write('The skill vendoring arrangement no longer matches ADR 0002.\n\n');
    for (const problem of found) process.stderr.write(`  - ${problem}\n\n`);
    process.exit(1);
  }
  process.stdout.write(
    'ADR 0002 is on its fallback branch: no pin, nothing reading the vendored directory, the ' +
      'serverless ruleset grounded in its own citations.\n'
  );
}
