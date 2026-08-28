// Run the live Lakebase suite and record that it passed, against what.
//
// The recording is written here rather than by hand because a hand-written one records an
// intention. This writes only on a green run of the real file against a real endpoint, and what it
// writes is the digest `live-suite.mjs --check` reads — so a store's SQL cannot move without either
// a run or a visible failure. ADR 0090 has why that is the shape rather than a CI job.
//
//   npm run test:live
//
// with `LAKEBASE_ENDPOINT`, `PGHOST` and a Databricks profile bound. CONTRIBUTING.md has the
// endpoint lookup; `app/.env` is where a developer keeps theirs.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RECORDING, SUITE, state } from './live-suite.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const REPORT = join(APP, 'node_modules', '.cache', 'live-suite-report.json');
const LIFECYCLE_REPORT = join(APP, 'node_modules', '.cache', 'live-suite-lifecycle.json');

if (process.env.LAKEBASE_ENDPOINT == null || process.env.LAKEBASE_ENDPOINT === '') {
  console.error(
    'LAKEBASE_ENDPOINT is not bound, so the suite would skip and the recording would say it passed.\n' +
      'Bind it — CONTRIBUTING.md, "A store change is verified against a database" — and run this again.'
  );
  process.exit(1);
}

mkdirSync(dirname(REPORT), { recursive: true });
rmSync(REPORT, { force: true });
rmSync(LIFECYCLE_REPORT, { force: true });

const suite = relative(APP, SUITE);
const run = spawnSync(
  'npx',
  ['vitest', 'run', suite, '--reporter=default', '--reporter=json', `--outputFile=${REPORT}`],
  {
    cwd: APP,
    stdio: 'inherit',
    env: { ...process.env, WAF_LIVE_LIFECYCLE_REPORT: LIFECYCLE_REPORT },
  }
);

if (run.status !== 0) {
  console.error('\nThe live suite did not pass, so nothing was recorded.');
  process.exit(run.status ?? 1);
}

const report = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')) : { numPassedTests: 0 };
const tests = report.numTotalTests ?? 0;
const passed = report.numPassedTests ?? 0;

if (tests === 0 || passed !== tests) {
  console.error(
    `\nThe suite reported ${String(passed)} of ${String(tests)} tests passed. ` +
      'A skipped file exits zero, so nothing was recorded.'
  );
  process.exit(1);
}

const now = state();
if (!existsSync(LIFECYCLE_REPORT)) {
  console.error('\nThe suite passed without recording its restart/rollback lifecycle, so nothing was recorded.');
  process.exit(1);
}
const lifecycle = JSON.parse(readFileSync(LIFECYCLE_REPORT, 'utf8'));
const recording = {
  what: 'The last run of server/store/postgres.live.test.ts that passed, and the SQL it passed against.',
  ran: new Date().toISOString(),
  commit: sha(),
  endpoint: kind(process.env.LAKEBASE_ENDPOINT),
  tests,
  digest: now.digest,
  lifecycle,
  covered: now.covered,
  uncovered: now.uncovered,
};

writeFileSync(RECORDING, `${JSON.stringify(recording, null, 2)}\n`);
console.log(
  `\nRecorded: ${String(tests)} tests passed against ${String(now.covered.length)} Postgres modules ` +
    `(${String(now.uncovered.length)} the suite does not drive), digest ${now.digest}.`
);

function sha() {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: APP, encoding: 'utf8' });
  return head.status === 0 ? head.stdout.trim() : 'unknown';
}

/** The kind, not the host: which of the two Lakebase shapes it was, without naming a workspace. */
function kind(endpoint) {
  return endpoint.startsWith('projects/') ? 'autoscaling' : 'provisioned';
}
