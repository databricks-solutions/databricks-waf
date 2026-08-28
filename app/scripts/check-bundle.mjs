#!/usr/bin/env node
// Is the committed bundle the one this source produces?
//
// `dist` and `client/dist` are committed because the committed bundle is what the
// platform runs — there is deliberately no build step for it to find. That makes a
// stale bundle a correctness fault rather than an untidy one: the server runs last
// week's code, and a stale `index.html` pointing at a hash-named asset that no
// longer exists is a blank page at install time rather than a build error.
//
// CI has checked this since the bundle was first committed. This is the same check,
// run locally, added after it failed on three consecutive pull requests — each one a
// server file changed, a push, a ninety-second wait, and a second push carrying
// nothing but the rebuild. That is precisely the waste `verify.mjs` was written to
// end, and it had been ending it for every check except this one.
//
// Unlike every other check here, this one writes to the working tree: it runs the
// bundler. That is deliberate. The remedy for a stale bundle is to rebuild it and
// commit, so a check that leaves the rebuild in place has already done the first
// half. The output is reported as a diff against what was committed, which is the
// same thing CI prints.

import { spawnSync } from 'node:child_process';

function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32' });
}

const built = run('npm', ['run', 'bundle']);

if (built.status !== 0) {
  process.stdout.write('The bundler failed, so whether the committed bundle is current is unknown.\n');
  process.stdout.write([built.stdout, built.stderr].filter((part) => part?.trim()).join('\n'));
  process.exit(1);
}

const problems = [];

// Both outputs, for opposite reasons. A stale server bundle runs the wrong code; a
// stale client bundle serves an index referencing an asset that was deleted.
const changed = run('git', ['diff', '--stat', '--', 'dist', 'client/dist']);

if (changed.stdout.trim() !== '') {
  problems.push(`The committed bundle is not what this source builds:\n${changed.stdout.trim()}`);
}

// A fresh build producing a file that was never committed is invisible to `git diff`,
// and it is the more likely of the two: client assets are hash-named, so a changed
// chunk arrives as a new filename rather than as an edit.
const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '--', 'dist', 'client/dist']);

if (untracked.stdout.trim() !== '') {
  problems.push(`A fresh build produced files that are not committed:\n${untracked.stdout.trim()}`);
}

if (problems.length > 0) {
  process.stdout.write(`${problems.join('\n\n')}\n\nThe rebuild is already in your tree. Commit it.\n`);
  process.exit(1);
}

process.stdout.write('The committed bundle is what this source builds.\n');
