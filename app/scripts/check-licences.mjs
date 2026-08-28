#!/usr/bin/env node
// Check that every licence in the shipped dependency tree is approved for distribution
// alongside an application governed by the Databricks License.
//
// This lives in a script rather than inline in the workflow for one reason: it was
// inline, and so it only ever ran in CI. It failed there on a package that would
// have failed locally too, days after the dependency arrived. A check that cannot
// be run before pushing is a check that reports history rather than preventing it.
//
// Scoped to --production, because the licence question is about what we ship.
// Build and test tooling is not distributed and its licences do not constrain the
// outbound one.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CHECKER = 'license-checker-rseidelsohn@4.4.2';
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ROOT_PACKAGE = `${manifest.name}@${manifest.version}`;

// Permissive licences, plus one SPDX choice expression. dompurify is offered as
// "(MPL-2.0 OR Apache-2.0)", and a disjunction lets a distributor elect the
// Apache-2.0 terms. It belongs on the allowlist as a permitted licence, not as
// an exception to one.
const ALLOWED = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'CC-BY-4.0',
  'BlueOak-1.0.0',
  'Python-2.0',
  'MIT-0',
  '(MPL-2.0 OR Apache-2.0)',
];

// Named exclusions, on the same terms as the OSV exceptions: specific, reasoned,
// and narrow enough that a new package of the same kind still fails the check.
// Excluding by prefix rather than by exact version covers the per-platform binary
// packages, which differ by architecture and change on every release.
//
// lightningcss is MPL-2.0, which is not on the allowlist and is not being added to
// it. MPL-2.0 is file-level copyleft: it constrains the MPL-licensed files
// themselves and permits distribution within a larger work under other terms. It
// arrives as a transitive dependency of
// vite, which @databricks/appkit declares as a runtime rather than a build
// dependency, and it is a build-time CSS compiler that no shipped code path calls.
// The repository contains none of its source: dist/server.js is a 188-byte entry
// point that resolves @databricks/appkit from node_modules, so the install fetches
// these packages from the public registry rather than us redistributing them.
//
// This exclusion is deliberately package-specific. A different MPL dependency
// still fails the gate and needs its own distribution review.
const EXCLUDE_PREFIXES = ['lightningcss'];

const args = [
  '--yes',
  CHECKER,
  '--production',
  '--excludePrivatePackages',
  '--excludePackages',
  ROOT_PACKAGE,
  '--excludePackagesStartingWith',
  EXCLUDE_PREFIXES.join(','),
  '--onlyAllow',
  ALLOWED.join(';'),
  '--summary',
];

const result = spawnSync('npx', args, { stdio: 'inherit' });

if (result.error) {
  console.error(`Could not run ${CHECKER}: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(
    '\nA production dependency carries a licence that is not on the allowlist.\n\n' +
      'Do not add the licence to the allowlist to make this pass. Decide whether the\n' +
      'licence is compatible with distribution alongside the Databricks License,\n' +
      'record the reasoning, and only then change the list or add an exclusion.\n' +
      'A dual licence offering a permissive option can be allowed outright, since the\n' +
      'distributor elects which one applies.'
  );
  process.exit(result.status ?? 1);
}
