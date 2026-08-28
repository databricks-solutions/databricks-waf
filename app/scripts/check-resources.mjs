#!/usr/bin/env node
// Holds app.yaml and databricks.yml to the same configuration.
//
// Two files describe the same app to two different readers: the Apps runtime reads app.yaml, and
// a bundle deploy reads databricks.yml. The app is only correct if both agree.
//
// They describe the same bindings from opposite ends. `app.yaml` says "put the resource named
// postgres into LAKEBASE_ENDPOINT"; `databricks.yml` says which database to bind under that name.
// If the names drift, nothing fails at deploy time: the resource is never bound, the env var is
// never set, and the failure surfaces on the first boot after the deploy that caused it.
//
// A misspelling used to be quieter than that, and worse. Both stores had a fallback, so a drifted
// name produced an app that started, worked, and forgot everything on restart — reporting the loss
// as though an admin had chosen it. ADR 0031 removed the fallback, which turns this check from the
// only thing standing between a typo and silent data loss into a check that fails earlier than the
// app does.
//
// databricks.yml is the one that drifted furthest: it named a different app than app.yaml, so a
// deploy through it would have created a second app, and it declared neither the scopes nor the
// store, so the real one was patched by hand after every deploy.
//
// This checked three files until ADR 0030 dropped Marketplace as a distribution path and deleted
// manifest.yaml with it. The third leg was the only one that could not be tested by deploying,
// since installing a listing needs a published listing; the two that remain are both exercised by
// every deploy, which is a better position than the one this check was written for.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The resource names app.yaml refers to, and the env vars they feed.
 *
 * Parsed with a regex rather than a YAML library on purpose: this script runs in CI before
 * any install step, so it cannot depend on node_modules being present.
 */
function referenced() {
  const text = readFileSync(join(APP, 'app.yaml'), 'utf8');
  const pattern = /-\s+name:\s*([A-Za-z0-9_]+)\s*\n\s*valueFrom:\s*([A-Za-z0-9_-]+)/g;
  return [...text.matchAll(pattern)].map(([, envVar, resource]) => ({ envVar, resource }));
}

/** The app name each file states. A mismatch means a deploy creates a second app. */
function names() {
  const of = (file, pattern) => pattern.exec(readFileSync(join(APP, file), 'utf8'))?.[1];
  return {
    'app.yaml': of('app.yaml', /^name:\s*'?([A-Za-z0-9_-]+)'?/m),
    'databricks.yml': of('databricks.yml', /^\s{6}name:\s*'?([A-Za-z0-9_-]+)'?/m),
  };
}

/** The scopes a file requests, from whichever indentation it uses. */
function scopes(file) {
  const text = readFileSync(join(APP, file), 'utf8');
  const block = /^\s*user_api_scopes:\s*$/m.exec(text);
  if (block == null) return [];

  const found = [];
  for (const line of text.slice(block.index + block[0].length).split('\n')) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const scope = /^\s*-\s*([A-Za-z0-9_.:-]+)\s*$/.exec(line)?.[1];
    // The first line that is neither a comment nor a list item ends the block.
    if (scope == null) break;
    found.push(scope);
  }
  return found;
}

/** The resource names databricks.yml binds. */
function bound() {
  const text = readFileSync(join(APP, 'databricks.yml'), 'utf8');
  const block = text.split(/^\s{6}resources:\s*$/m)[1] ?? '';
  return [...block.matchAll(/-\s+name:\s*([A-Za-z0-9_-]+)/g)].map(([, name]) => name);
}

/**
 * Every environment variable a file sets, in order, as name -> how it is filled.
 *
 * Both files are read for this, because the bundle's `config.env` block replaces app.yaml's `env`
 * rather than merging with it. That is the failure this function exists for and it is invisible at
 * deploy time: a bundle that names one variable here drops every other one, the app starts, and it
 * reports the consequence — no database bound — as a resource problem, pointing at bindings that are
 * correct. Measured on labs, at the cost of an afternoon.
 *
 * `valueFrom` is app.yaml's spelling and `value_from` the bundle's; they mean the same thing and are
 * normalised to the resource name so the two lists can be compared.
 */
function environment(file, indent) {
  const text = readFileSync(join(APP, file), 'utf8');
  const block = new RegExp(`^\\s{${String(indent)}}env:\\s*$`, 'm').exec(text);
  if (block == null) return null;

  const found = new Map();
  for (const line of text.slice(block.index + block[0].length).split('\n')) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const item = /^\s*-\s+name:\s*([A-Za-z0-9_]+)\s*$/.exec(line);
    if (item != null) {
      found.set(item[1], '(nothing)');
      continue;
    }
    const fill = /^\s*(?:value|valueFrom|value_from):\s*'?([^'\n]*?)'?\s*$/.exec(line);
    if (fill != null && found.size > 0) {
      const [name] = [...found.keys()].slice(-1);
      found.set(name, fill[1]);
      continue;
    }
    // The first line that is neither a comment nor part of a list item ends the block.
    break;
  }
  return found;
}

const problems = [];
const refs = referenced();

const appNames = names();
if (appNames['app.yaml'] !== appNames['databricks.yml']) {
  problems.push(
    `app.yaml names the app "${String(appNames['app.yaml'])}" and databricks.yml names it ` +
      `"${String(appNames['databricks.yml'])}". A bundle deploy would create a second app beside the real one,\n` +
      '    leaving the deployed code and the configured scopes on different apps.'
  );
}

const declaredScopes = scopes('app.yaml');
const bundleScopes = scopes('databricks.yml');
if (declaredScopes.length === 0) {
  problems.push('app.yaml requests no user_api_scopes, so this check proved nothing about them.');
}
if (declaredScopes.join(',') !== bundleScopes.join(',')) {
  problems.push(
    "app.yaml and databricks.yml request different scopes. The app object's scopes are the ones the proxy\n" +
      `    mints tokens against, so the bundle's list is what takes effect.\n` +
      `      app.yaml:       ${declaredScopes.join(', ') || '(none)'}\n` +
      `      databricks.yml: ${bundleScopes.join(', ') || '(none)'}`
  );
}

const runtimeEnv = environment('app.yaml', 0);
const bundleEnv = environment('databricks.yml', 8);

if (runtimeEnv == null || runtimeEnv.size === 0) {
  problems.push('app.yaml sets no environment variables, so this check proved nothing about them.');
} else if (bundleEnv == null) {
  // Not a problem: with no config block the bundle leaves app.yaml's env alone, which is the
  // arrangement this whole comparison exists to make safe.
  console.log('databricks.yml declares no config.env, so app.yaml\u2019s env is what the app gets.');
} else {
  const missing = [...runtimeEnv.keys()].filter((name) => !bundleEnv.has(name));
  if (missing.length > 0) {
    problems.push(
      `databricks.yml has a config.env block, which replaces app.yaml's env rather than merging with it,\n` +
        `    and it omits ${missing.join(', ')}. A bundle deploy would leave ${missing.length === 1 ? 'that variable' : 'those variables'} unset.\n` +
        '    Nothing fails at deploy time; the app starts and misreports the consequence. Declare every name in both.'
    );
  }
  for (const [name, fill] of bundleEnv) {
    if (!runtimeEnv.has(name)) {
      problems.push(
        `databricks.yml sets ${name}, which app.yaml never declares. A deploy that does not go through the\n` +
          '    bundle would leave it unset. Declare it in both, with whatever value suits a reader that has no bundle.'
      );
      continue;
    }
    const declared = runtimeEnv.get(name);
    // A value may differ — that is the point of a bundle variable. A binding may not: the two are
    // naming the same resource, and a drifted name is the silent failure above.
    const binding = (value) => (bound().includes(value) ? value : null);
    if (binding(fill) !== binding(declared)) {
      problems.push(
        `app.yaml fills ${name} from "${String(declared)}" and databricks.yml from "${fill}". One of them binds a\n` +
          '    resource the other does not, so the app gets a different value depending on how it was deployed.'
      );
    }
  }
}

for (const resource of bound()) {
  if (!refs.some((ref) => ref.resource === resource)) {
    problems.push(
      `databricks.yml binds a resource named "${resource}" that app.yaml never reads. Either wire it through\n` +
        '    an env var or stop binding it.'
    );
  }
}
for (const { resource, envVar } of refs) {
  if (!bound().includes(resource)) {
    problems.push(
      `app.yaml fills ${envVar} from "${resource}", but databricks.yml does not bind it. A bundle deploy would\n` +
        `    leave ${envVar} unset, and the app refuses to start without it.`
    );
  }
}

if (refs.length === 0) {
  console.error('check-resources found no valueFrom references in app.yaml, so it proved nothing.');
  process.exit(1);
}

if (problems.length > 0) {
  console.error('app.yaml and databricks.yml disagree:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `app.yaml and databricks.yml agree on ${String(refs.length)} resource(s), ` +
    `${String(declaredScopes.length)} scope(s) and ${String(runtimeEnv?.size ?? 0)} environment variable(s): ` +
    refs.map(({ resource, envVar }) => `${resource} -> ${envVar}`).join(', ')
);
