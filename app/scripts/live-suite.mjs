// What the live Lakebase suite has proved, and whether it has proved this commit's SQL.
//
// `server/store/postgres.live.test.ts` skips unless `LAKEBASE_ENDPOINT` is bound, and nothing binds
// it: not `npm run verify`, not CI, not a hook. Two of its assertions were therefore wrong from
// #138 until `46b` ran the file for an unrelated reason — five months during which the file claimed
// an authority its execution did not have. ADR 0090 records what was decided about that; this is
// the apparatus.
//
// The surface is derived rather than listed: every module that imports the Postgres module emits
// SQL against a real database, and the subset of those the live test imports is what the live test
// proves. Deriving it means adding a store to the suite enrols it, and adding a store without
// enrolling it leaves it visibly uncovered rather than silently so.
//
// The digest is over the covered files' text with `//` comment lines and blank lines removed, and
// runs of whitespace collapsed. That over-triggers — renaming a local variable asks for a live run
// that would prove nothing new — and it was chosen in that direction on purpose: a digest that
// tries to isolate the SQL from the code that builds it cannot see a change to how a parameter is
// bound, and binding a parameter to the wrong column is exactly the class of defect a fake cannot
// catch. Asking for a run nobody needed costs four minutes; not asking for one is #138 again.
//
//   node scripts/live-suite.mjs --check    fail if the recording does not cover this commit's SQL
//   npm run test:live                      run the suite against a bound endpoint and record it
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const SERVER = join(APP, 'server');

export const RECORDING = join(APP, 'scripts', 'recordings', 'live-suite.json');
export const SUITE = join(SERVER, 'store', 'postgres.live.test.ts');

// The fake is in the surface by import and out of it by purpose: it is the thing the live suite
// exists to distrust, and no run of it touches a database.
const NOT_A_STORE = new Set(['server/store/postgres-fake.ts']);

/** Every module that emits SQL against a real Postgres, by the module it has to import to do so. */
export function surface(root = SERVER) {
  const found = [];
  for (const file of sources(root)) {
    const text = readFileSync(file, 'utf8');
    const path = relative(APP, file);
    if (path === 'server/store/postgres.ts') found.push(path);
    else if (/from '[^']*store\/postgres\.js'|from '\.\/postgres\.js'/.test(text)) found.push(path);
  }
  return found.filter((path) => !NOT_A_STORE.has(path)).sort();
}

/** The subset the live suite drives, read from its own imports rather than from a list here. */
export function covered(all, suite = SUITE) {
  const text = readFileSync(suite, 'utf8');
  const imported = new Set();
  for (const match of text.matchAll(/from '(\.[^']+)'/g)) {
    const resolved = relative(APP, join(dirname(suite), match[1].replace(/\.js$/, '.ts')));
    imported.add(resolved);
  }
  // The suite opens the database through `postgres.ts` itself, so its DDL is always covered.
  imported.add('server/store/postgres.ts');
  return all.filter((path) => imported.has(path));
}

export function digest(paths) {
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(path);
    hash.update('\0');
    hash.update(stripped(readFileSync(join(APP, path), 'utf8')));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

export function stripped(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))
    .join('\n')
    .replace(/[ \t]+/g, ' ');
}

function* sources(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) yield path;
  }
}

export function state() {
  const all = surface();
  const proved = covered(all);
  return { all, covered: proved, uncovered: all.filter((path) => !proved.includes(path)), digest: digest(proved) };
}

function check() {
  const now = state();
  if (!existsSync(RECORDING)) {
    throw new Error(
      'No live-suite recording. Run `npm run test:live` against a bound Lakebase endpoint — see CONTRIBUTING.md.'
    );
  }
  const recorded = JSON.parse(readFileSync(RECORDING, 'utf8'));
  if (recorded.digest !== now.digest) {
    const added = now.covered.filter((path) => !recorded.covered.includes(path));
    const gone = recorded.covered.filter((path) => !now.covered.includes(path));
    throw new Error(
      [
        `The live suite last passed against SQL this commit has changed (recorded ${recorded.digest}, now ${now.digest}).`,
        added.length > 0 ? `  Now covered and not then: ${added.join(', ')}` : '',
        gone.length > 0 ? `  Covered then and not now: ${gone.join(', ')}` : '',
        '  Run `npm run test:live` against a bound Lakebase endpoint and commit the recording it writes.',
        '  CONTRIBUTING.md has the endpoint, and docs/decisions/0090 has why this is a gate rather than a CI job.',
      ]
        .filter((line) => line !== '')
        .join('\n')
    );
  }
  console.log(
    `The live suite passed against this SQL on ${String(recorded.ran).slice(0, 10)}: ` +
      `${String(recorded.covered.length)} of ${String(now.all.length)} Postgres modules, ` +
      `${String(recorded.tests)} tests.`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) check();
  else console.log(JSON.stringify(state(), null, 2));
}
