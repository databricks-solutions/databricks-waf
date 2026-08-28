#!/usr/bin/env node
// Keep the lockfile resolvable by anyone, not just by whoever generated it.
//
// npm records the exact URL each tarball came from. Run npm install behind a
// private mirror and every one of those URLs names the mirror, so the committed
// lockfile only works for people who can reach it. That is a bad property for any
// repository and a disqualifying one for this project: the app is published as
// public, so the contributor we most need to support is one with a GitHub
// account and no access to any Databricks network. It also breaks CI, which fails
// by hanging on connections that will never open rather than by saying what is
// wrong.
//
// integrity hashes make the rewrite safe. They hash tarball contents, not the URL
// it was fetched from, and a mirror serves byte-identical tarballs. So pointing
// resolved at the public registry does not weaken verification: npm still refuses
// anything whose contents do not match what was locked.
//
// Usage:
//   node scripts/lockfile-registry.mjs           report
//   node scripts/lockfile-registry.mjs --check     exit non-zero if not public
//   node scripts/lockfile-registry.mjs --fix       rewrite to the public registry

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCK_PATH = join(HERE, '..', 'package-lock.json');

const PUBLIC_HOST = 'registry.npmjs.org';

// A private mirror lays its tarball paths out the same way the public registry
// does, so only the origin changes. Anything that is not a plain registry tarball
// URL -- a git dependency, a tarball URL someone pinned by hand -- is left alone
// and reported, because rewriting it would silently change what gets installed.
function classify(resolved) {
  let url;
  try {
    url = new URL(resolved);
  } catch {
    return { kind: 'unparseable' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'non-http' };
  if (url.host === PUBLIC_HOST) return { kind: 'public' };
  if (/\/-\/[^/]+\.tgz$/.test(url.pathname)) {
    return { kind: 'mirror', rewritten: `https://${PUBLIC_HOST}${url.pathname}` };
  }
  return { kind: 'foreign', host: url.host };
}

const mode = process.argv.includes('--fix') ? 'fix' : process.argv.includes('--check') ? 'check' : 'report';

const raw = readFileSync(LOCK_PATH, 'utf8');
const lock = JSON.parse(raw);

const counts = { public: 0, mirror: 0, foreign: 0, unparseable: 0, 'non-http': 0 };
const hosts = new Map();
const foreign = [];
let changed = 0;

for (const [name, entry] of Object.entries(lock.packages ?? {})) {
  if (!entry?.resolved) continue;
  const verdict = classify(entry.resolved);
  counts[verdict.kind]++;
  try {
    const h = new URL(entry.resolved).host;
    hosts.set(h, (hosts.get(h) ?? 0) + 1);
  } catch {
    /* counted as unparseable already */
  }
  if (verdict.kind === 'foreign' || verdict.kind === 'unparseable' || verdict.kind === 'non-http') {
    foreign.push(`${name || '(root)'} -> ${entry.resolved}`);
  }
  if (mode === 'fix' && verdict.kind === 'mirror') {
    entry.resolved = verdict.rewritten;
    changed++;
  }
}

console.log('Lockfile tarball origins:\n');
for (const [host, n] of [...hosts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${host}${host === PUBLIC_HOST ? '' : '   <- not publicly resolvable'}`);
}

// A dependency npm could not resolve to a registry tarball needs a human to look
// at it, whichever mode we are in.
if (foreign.length) {
  console.log(`\n${foreign.length} entr(ies) are not plain registry tarballs and were not rewritten:`);
  for (const f of foreign.slice(0, 20)) console.log(`  - ${f}`);
  if (foreign.length > 20) console.log(`  ... and ${foreign.length - 20} more`);
}

if (mode === 'fix') {
  if (changed === 0) {
    console.log('\nNothing to rewrite; every tarball already points at the public registry.');
    process.exit(0);
  }
  // Preserve the trailing newline npm writes, so the fix does not show up as a
  // whitespace change on top of the real one.
  writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`\nRewrote ${changed} tarball URL(s) to ${PUBLIC_HOST}.`);
  process.exit(0);
}

if (counts.mirror > 0) {
  const message =
    `\n${counts.mirror} tarball URL(s) point at a private mirror rather than the public registry.\n\n` +
    'This lockfile can only be installed by someone who can reach that mirror. CI\n' +
    'and outside contributors cannot, and it fails as a hang rather than an error.\n\n' +
    'Run `npm run lockfile:fix` and commit the result.';
  if (mode === 'check') {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
  process.exit(0);
}

console.log('\nEvery tarball resolves from the public registry.');
