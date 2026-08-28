#!/usr/bin/env node
// Proves the REST collector cannot write.
//
// This exists because of one scope. The serving endpoints call needs `model-serving`,
// which is a whole API package and carries the authority to create and delete endpoints
// as well as list them. The app wants none of that — but "we only read" is a promise, and
// a promise is not something a security review can check.
//
// So it is checked here instead. Every SDK call the REST probes make must be a
// read-shaped method, named from a small allowlist. A probe that called
// `servingEndpoints.delete` would fail this, whatever the review took on trust.
//
// Deliberately a name check rather than a permissions model. It is crude, and its
// crudeness is what makes it hold: there is no configuration to get wrong and no way to
// express an exception. A new read verb has to be added here in a commit that shows the
// verb being added, which is exactly the moment a reviewer should look.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REST = join(HERE, '..', 'server', 'collect', 'rest');

/**
 * Method names that only read.
 *
 * An exact list, not a `list*`/`get*` prefix rule. A prefix rule would be shorter and would
 * also admit anything the SDK ever names that way, including credential vending
 * (`getTemporaryCredentials` and friends), which reads like a read and is not one. The cost
 * is a line here whenever a new reader is used, which is the intended friction: the
 * `model-serving` scope this app holds is package-wide and carries write authority it must
 * never use, so this list is what proves the write authority is unreachable.
 *
 * `getStatus` reads oddly next to `setStatus`, which is not on the list: the workspace
 * settings service names its reader that way.
 *
 * `listScopes` and `listEndpoints` are the secrets and vector-search services naming their
 * list operations after what they list.
 */
const READ_VERBS = [
  'list',
  'get',
  'getStatus',
  'getPermissions',
  'getPermissionLevels',
  'summaries',
  'summary',
  'listScopes',
  'listEndpoints',
];

/** Calls on the SDK client: `client.<service>.<method>(`. */
const CALL = /\bclient\s*\.\s*([A-Za-z0-9_]+)\s*\.\s*([A-Za-z0-9_]+)\s*\(/g;

const problems = [];
const found = [];

for (const file of readdirSync(REST).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
  const contents = readFileSync(join(REST, file), 'utf8');
  for (const [, service, method] of contents.matchAll(CALL)) {
    found.push(`${service}.${method}`);
    if (!READ_VERBS.includes(method)) {
      problems.push(
        `${file}: client.${service}.${method}() is not a read.\n` +
          `    The REST collector may only read. If ${method} really is a read, add it to READ_VERBS in\n` +
          '    this script, in a commit that says so.'
      );
    }
  }
}

if (found.length === 0) {
  // An empty pass is worse than a failure: it would keep passing after a refactor moved
  // the calls somewhere this script does not look, and the guarantee would quietly become
  // a comment.
  console.error(
    'check-read-only found no SDK calls in server/collect/rest, so it proved nothing.\n' +
      'Either the probes moved, or the call shape changed. Update the pattern.'
  );
  process.exit(1);
}

if (problems.length > 0) {
  console.error('The REST collector makes calls that are not reads:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`REST collector is read-only (${found.length} calls: ${[...new Set(found)].sort().join(', ')}).`);
