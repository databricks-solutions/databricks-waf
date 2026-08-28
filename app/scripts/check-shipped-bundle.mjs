#!/usr/bin/env node
// Check that what we ship can actually run where it lands.
//
// We ship no `build` script, so a deploy installs dependencies from the lockfile and goes
// straight to the start command against the committed bundle. That is a decision, not a
// platform limit — the platform runs `npm run build` whenever the script exists, from a Git
// source or a workspace folder alike, and ADR 0009 records why we do not let it: the bundler
// needs a newer Node than the runtime pins, so the artefact CI tested is the one that should
// run. This check is what keeps the decision true, and the failure it guards against is a
// shipped file importing something only present on a developer machine: the build succeeds,
// the bundle looks right, and the app dies on first boot in the customer's workspace with a
// module resolution error.
//
// What this cannot do is prove the app serves traffic. AppKit's createApp performs a
// blocking startup handshake -- it resolves the bound warehouse and calls SCIM /Me
// for the workspace id -- so it cannot reach a listening state without a reachable
// workspace. Reaching that handshake is therefore the furthest point verifiable
// without one, and it is the point after every import has already resolved, which is
// what makes it a useful place to stop. Verifying that it serves is a live-workspace
// test and is tracked as such rather than faked here.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_BUNDLE = join(APP, 'dist', 'server.js');
const CLIENT_DIR = join(APP, 'client', 'dist');
const INDEX_HTML = join(CLIENT_DIR, 'index.html');

// Boot far enough to prove imports resolved. The handshake fails fast when there is
// no workspace to reach, so this is a ceiling rather than an expected wait.
const BOOT_TIMEOUT_MS = 30_000;

// The failures that mean the shipped tree is incomplete, as opposed to the expected
// failure of having no workspace to talk to.
const RESOLUTION_FAILURE =
  /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_REQUIRE_ESM|ERR_UNSUPPORTED_DIR_IMPORT|ERR_UNKNOWN_FILE_EXTENSION|SyntaxError|Cannot find (?:module|package)/;

const failures = [];

function check(label, ok, detail) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
  if (!ok) failures.push(detail ?? label);
}

console.log('Shipped artefacts');

// The Apps platform installs dependencies and then runs package.json `build` if one
// exists, so a script under that exact name means the platform rebuilds over the
// bundle we committed and tested. Verified on a real deployment: with a `build`
// script it ran it and failed, because the runtime is on Node 22.16.0 and our
// bundler requires ^22.18; renamed to `bundle`, it went straight to the start
// command and the app came up. The name is load-bearing, which is why it is checked
// rather than left to a comment.
const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'));
check(
  'package.json declares no `build` script for the platform to run',
  !('build' in (pkg.scripts ?? {})),
  'package.json has a `build` script. The Apps platform runs it on deploy, rebuilding ' +
    'over the committed bundle on a Node version we do not control. Use `bundle`.'
);

check('dist/server.js is committed', existsSync(SERVER_BUNDLE));
check('client/dist/index.html is committed', existsSync(INDEX_HTML));

if (failures.length) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`  - ${f}`);
  console.error('\nIf the bundle is missing, run `npm run bundle` and commit the output.');
  process.exit(1);
}

// The client assets are hash-named, so an index.html referencing a hash that no
// longer exists is a blank page at install time rather than a build error. That makes
// it the quietest of the packaging faults and the one worth checking directly.
const html = readFileSync(INDEX_HTML, 'utf8');
const referenced = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)]
  .map((m) => m[1])
  .filter((ref) => !/^(?:https?:)?\/\//.test(ref) && !ref.startsWith('data:'));

const missing = referenced.filter((ref) => !existsSync(join(CLIENT_DIR, ref.replace(/^\//, ''))));
check(
  `index.html references ${referenced.length} local asset(s), all present`,
  missing.length === 0,
  `index.html references files that do not exist: ${missing.join(', ')}`
);

// Local acceptance fixtures deliberately carry invented assessment records and exact preview
// routes. import.meta.env.DEV is meant to erase both. Checking the built JavaScript makes that a
// release property instead of trusting the source guard or a bundler optimisation to keep working.
const clientJavaScript = readdirSync(join(CLIENT_DIR, 'assets'), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  .map((entry) => ({ name: entry.name, source: readFileSync(join(CLIENT_DIR, 'assets', entry.name), 'utf8') }));
const previewMarkers = [
  '/preview/dashboard/',
  '/preview/report/',
  '/preview/investigate/',
  '/preview/improvement/',
  '/preview/assess/',
  '/preview/operate/',
  '/preview/acceptance',
  'acceptance renders passed',
  'preview-review-attention',
  'preview-methodology-manifest',
];
const previewLeaks = clientJavaScript.flatMap(({ name, source }) =>
  previewMarkers.filter((marker) => source.includes(marker)).map((marker) => `${name}: ${marker}`)
);
check(
  'development-only customer previews are absent from the shipped client',
  previewLeaks.length === 0,
  `the production client contains development preview data or routes: ${previewLeaks.join(', ')}`
);

// Warn rather than fail: locally the tree usually has dev dependencies installed, so
// a dev-only import would resolve here and the check would pass for the wrong
// reason. Saying so is better than reporting a pass this run cannot support.
const productionOnly = !existsSync(join(APP, 'node_modules', 'vitest'));
if (!productionOnly) {
  console.log(
    '\nNote: dev dependencies are installed, so a dev-only import would resolve\n' +
      'here regardless. Run `npm ci --omit=dev` for the check that means something.\n' +
      'CI does this on a clean tree.'
  );
}

console.log('\nCold boot from the committed bundle');

// Strip the environment a developer machine carries, so the run reflects a fresh
// install rather than inheriting credentials or a warehouse from the shell.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DATABRICKS_')));
env.NODE_ENV = 'production';
// The platform's own port variable, set back after the strip: it is the one AppKit reads
// and therefore the one the degradation path has to bind. A port unlikely to collide,
// since a bound port would fail for a reason that has nothing to do with this check.
env.DATABRICKS_APP_PORT = '18327';

const child = spawn(process.execPath, [SERVER_BUNDLE], {
  cwd: APP,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (d) => (output += d));
child.stderr.on('data', (d) => (output += d));

// The handshake cannot succeed here -- there is no workspace -- so the interesting
// question is what the app does about that. It is supposed to serve an explanation on
// the port and keep retrying, because the likeliest error in a fresh install is a
// mis-bound resource and a dead process tells the admin nothing. Polling the port is how
// that promise is verified rather than assumed.
async function probe() {
  try {
    const response = await fetch(`http://127.0.0.1:${env.DATABRICKS_APP_PORT}/api/scans`, {
      headers: { accept: 'application/json' },
    });
    return { status: response.status, body: await response.text() };
  } catch {
    return undefined;
  }
}

const outcome = await new Promise((resolve) => {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;

  const poll = setInterval(() => {
    if (Date.now() > deadline) {
      clearInterval(poll);
      resolve({ kind: 'silent' });
      return;
    }
    void probe().then((answer) => {
      if (answer === undefined) return;
      clearInterval(poll);
      resolve({ kind: 'serving', ...answer });
    });
  }, 250);

  child.on('exit', (code) => {
    clearInterval(poll);
    resolve({ kind: 'exited', code });
  });
  child.on('error', (err) => {
    clearInterval(poll);
    resolve({ kind: 'spawn-failed', err });
  });
});

child.kill('SIGKILL');

check('the bundle executes', outcome.kind !== 'spawn-failed', `could not run node: ${outcome.err}`);

const resolutionError = RESOLUTION_FAILURE.exec(output);
check(
  'every import resolves from production dependencies',
  !resolutionError,
  `the shipped bundle imports something that is not a production dependency: ${resolutionError?.[0]}`
);

check(
  'startup reaches the workspace handshake',
  outcome.kind === 'serving' || output.trim().length > 0,
  'the process exited without output, so it never reached AppKit startup'
);

// Two legitimate outcomes, depending on whether the machine happens to have workspace
// credentials. On CI it does not, so the handshake fails and the app serves its
// explanation; on a developer machine a `~/.databrickscfg` profile is usually enough for
// it to start properly. Either is a pass. What is never a pass is the port answering
// nothing, or the process exiting.
check(
  'the boot serves traffic, either the app or an explanation of what is missing',
  outcome.kind === 'serving' && (outcome.status === 200 || outcome.status === 503),
  outcome.kind === 'exited'
    ? `the process exited with code ${outcome.code} instead of serving`
    : outcome.kind === 'serving'
      ? `the port answered ${outcome.status}: ${outcome.body.slice(0, 200)}`
      : 'nothing answered on the port within the boot timeout'
);

// The explanation counts as a pass because it means "no workspace bound", which is
// expected here. It must not be allowed to paper over a broken package: a missing file or
// an unresolvable import surfaces through the same 503, and without this check a tree that
// cannot find its own control catalogue would pass as a polite degradation. That is not
// hypothetical — it is how this check first went green over a bundle whose catalogue path
// was wrong. The app classifies its own startup failures, so this reads the classification
// rather than pattern-matching the prose a second time.
check(
  'the explanation is about a missing workspace, not a missing part of the app',
  outcome.kind !== 'serving' || outcome.status !== 503 || !outcome.body.includes('"kind":"app-incomplete"'),
  `the app failed to start because the shipped tree is incomplete, not because a resource is unbound: ${outcome.body?.slice(0, 300)}`
);

if (failures.length) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`  - ${f}`);
  console.error('\n--- captured output ---');
  console.error(output.trim() || '(none)');
  process.exit(1);
}

console.log(
  '\nThe committed bundle runs from production dependencies alone, with no build step\n' +
    'and no credentials. Without a workspace to bind, it serves an explanation of what\n' +
    'is missing rather than exiting.'
);
