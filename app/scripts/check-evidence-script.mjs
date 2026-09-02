#!/usr/bin/env node
// Proves the admin evidence script is what its docstring says it is.
//
// The script in `config/evidence` is downloaded by a customer's admin, reviewed by their security
// team, and run against production with account-admin authority. Everything that makes it
// acceptable to run is a claim: that it only reads, that it keeps only the fields it names, that it
// never asks for a secret, and that the requirements it says it answers are the ones the catalogue
// is waiting on. A security review can read the file and check all four — once, for the version
// they read. This is what keeps them true for the next version.
//
// The table is read from the script itself, via `--manifest`, rather than transcribed here. A
// transcription would be a second place to keep the truth, and the first thing to go stale.
//
// What this cannot prove is that the endpoints exist or return what the projections expect. That
// needs a workspace, and the script is built to degrade one requirement rather than the collection
// when it turns out an API moved.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { readdirSync } from 'node:fs';
import { codeOf } from './python-code.mjs';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(APP, 'config', 'evidence', 'collect-evidence.py');
const CONTROLS = join(APP, 'config', 'controls');

const { beyondAnyApp } = await import(join(APP, 'server', 'collect', 'rest', 'families.ts'));
const { REQUESTED_KEYS } = await import(join(APP, 'server', 'collect', 'rest', 'settings-keys.ts'));

const source = readFileSync(SCRIPT, 'utf8');
const failures = [];

function check(label, ok, detail) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
  if (!ok) failures.push(detail ?? label);
}

// ---------------------------------------------------------------------------------------------
// Read-only by construction
//
// A name check, like `check-read-only.mjs`, and crude for the same reason: there is nothing to
// configure and no way to write an exception. A mutating verb cannot be added without this
// failing, which puts the argument in the pull request rather than in a review nobody repeats.
// ---------------------------------------------------------------------------------------------

console.log('Read-only by construction');

let body = '';
try {
  body = codeOf(SCRIPT);
} catch (problem) {
  console.error(
    `\nCould not read collect-evidence.py as Python: ${problem.message}\n` +
      'This check tokenises the script to tell its code from its prose, so it needs python3 on PATH.'
  );
  process.exit(1);
}

const MUTATING = /\b(?:POST|PUT|PATCH|DELETE|post|put|patch|delete)\b/g;
const mutating = [...body.matchAll(MUTATING)].map((match) => match[0]);
check(
  'the script names no mutating verb',
  mutating.length === 0,
  `collect-evidence.py mentions ${[...new Set(mutating)].join(', ')}. This script may only read; if a ` +
    'verb name is appearing in prose, rephrase it rather than adding an exception here.'
);

check(
  'the verb is a constant, and it is get',
  /^VERB = "get"$/m.test(source),
  'collect-evidence.py no longer declares `VERB = "get"` at the top level. Every request goes through ' +
    'one function that names that constant, and this check is what keeps the constant the only verb.'
);

// Exactly one place starts a process.
//
// This asked for three — the API call, `--version` and `auth describe` — until running the script
// against a real account profile showed `auth describe --output json` failing outright on CLI 1.1.0
// and needing a text fallback. A fourth call site would have been the obvious way to add it. One
// helper that every caller goes through is the better answer and a stronger thing to check: there is
// a single argument list to inspect and a single absence of a shell to assert, and a new kind of
// invocation cannot be added without editing the function this counts.
// Spacing is loose because `body` is a token stream joined with spaces, so the source's
// `subprocess.run(` reaches this as `subprocess . run (`.
const invocations = [...body.matchAll(/subprocess\s*\.\s*run\s*\(/g)].length;
check(
  'exactly one place starts a process',
  invocations === 1,
  `collect-evidence.py calls subprocess.run in ${String(invocations)} places. Every invocation goes ` +
    'through the `run` helper, which is what makes "no shell, fixed argument list" one thing to check ' +
    'rather than a property of every call site.'
);

// Against the tokenised code, not the file. The file says "a single absence of `shell=True` to
// assert" in a docstring, and a check that fails on that sentence forbids documenting the guarantee
// it exists to enforce — the same trap the mutating-verb check above already fell into once.
check(
  'no shell is used to run them',
  !/shell\s*=\s*True/.test(body),
  'collect-evidence.py passes shell=True somewhere. The argument list must stay a list, so a path or a ' +
    'profile name cannot become part of a command.'
);

// Endpoints that return a secret, a script body or a share credential. The script does not call
// these, and the point is that it never asks — not that it asks and discards.
const FORBIDDEN = [
  ['secrets/get', 'the value of a secret'],
  ['secrets/list', 'the keys inside a secret scope'],
  ['dbfs/read', 'the contents of a file'],
  ['workspace/export', 'the contents of a notebook'],
  ['global-init-scripts/', 'the body of an init script'],
  ['recipients/', 'a Delta Sharing recipient activation token'],
  ['--sensitive', 'the credential behind the CLI profile'],
];
for (const [fragment, what] of FORBIDDEN) {
  check(
    `never asks for ${what}`,
    !body.includes(fragment),
    `collect-evidence.py mentions \`${fragment}\`, which would read ${what}. Nothing in the catalogue ` +
      'needs it, and a file an admin emails to a vendor must not be able to carry it.'
  );
}

// ---------------------------------------------------------------------------------------------
// The table, read from the script
// ---------------------------------------------------------------------------------------------

console.log('\nThe probe table');

let manifest;
try {
  manifest = JSON.parse(execFileSync('python3', [SCRIPT, '--manifest'], { encoding: 'utf8' }));
} catch (problem) {
  console.error(
    `\ncollect-evidence.py --manifest did not run: ${problem.message}\n` +
      'This check reads the probe table from the script rather than transcribing it, so it needs ' +
      'python3 on PATH. The script itself needs Python 3.9 or newer.'
  );
  process.exit(1);
}

check('the manifest lists probes', manifest.probes.length > 0, 'collect-evidence.py --manifest returned no probes.');

const PATH_SHAPE = /^\/api\/2\.\d\/[A-Za-z0-9._/{}-]+$/;
for (const probe of manifest.probes) {
  check(
    `${probe.label} names an API path`,
    PATH_SHAPE.test(probe.path),
    `${probe.label} has path ${probe.path}, which is not the shape the script's own guard allows. It ` +
      'would be refused at run time, so it is a probe that can never answer anything.'
  );
  check(
    `${probe.label} declares what it keeps`,
    probe.shape === 'shallow' || probe.fields.length > 0,
    `${probe.label} declares no fields and is not a shallow probe, so it would write an empty value.`
  );
  check(
    `${probe.label} says which requirements it answers`,
    probe.controls.length > 0,
    `${probe.label} names no controls. The dry-run output is an approval surface, and a call with no ` +
      'stated reason is one an admin should refuse.'
  );
  check(
    `${probe.label} declares a tier`,
    probe.tier === 'workspace' || probe.tier === 'account',
    `${probe.label} has tier ${probe.tier}. Only the two authorities exist, and the tier decides which ` +
      'admin can answer the requirement.'
  );
  if (probe.path.includes('{variant}')) {
    check(
      `${probe.label} lists its variants`,
      probe.variants.length > 0,
      `${probe.label} has a {variant} in its path and no variants to fill it with.`
    );
  }
  if (probe.tier === 'account') {
    check(
      `${probe.label} is addressed to an account`,
      probe.path.includes('{account_id}'),
      `${probe.label} is an account-tier probe whose path names no account. The account APIs are ` +
        'addressed per account, so this would be a call to nothing.'
    );
  }
}

// A field name that could carry a secret, a credential or a directory of people. Allowed in a
// declaration only as a shape — `:keys` for names without values, `:count` for a length.
//
// The script now carries this list too and refuses to run against a table that breaks it, because the
// script is the thing that leaves here. This copy is not redundant: it is what notices a name being
// dropped from the script's copy, which would otherwise be a silent widening.
const SHAPE_ONLY = [
  'spark_env_vars',
  'library',
  'tokens',
  'members',
  'ip_addresses',
  'allowed_ip_addresses',
  'init_scripts',
];

const declared = [...body.matchAll(/SHAPE_ONLY\s*=\s*\(([^)]*)\)/g)].flatMap((match) =>
  [...match[1].matchAll(/"([^"]+)"/g)].map((name) => name[1])
);
const missing = SHAPE_ONLY.filter((name) => !declared.includes(name));
check(
  'the script guards the same field names this check does',
  missing.length === 0,
  `collect-evidence.py's SHAPE_ONLY does not include ${missing.join(', ')}. The script checks its own ` +
    'table at start-up so a downloaded copy is not relying on a check that lives in this repository; ' +
    'the two lists have to say the same thing for that to mean anything.'
);

// Every step of the path, not the last one. `clusters[].spark_env_vars.DB_TOKEN` ends in a name this
// has no opinion about, and reaching through a denied field discloses exactly what keeping it would.
for (const probe of manifest.probes) {
  for (const path of probe.fields) {
    for (const step of path.split('.')) {
      const name = step.replace(/\[\]$/, '').replace(/:(?:keys|count)$/, '');
      if (!SHAPE_ONLY.includes(name)) continue;
      check(
        `${probe.label} keeps only the shape of ${name}`,
        step.endsWith(':keys') || step.endsWith(':count'),
        `${probe.label} declares \`${path}\`, which keeps or reaches through the value of ${name}. That ` +
          'field can carry a credential or a list of people, so it may only appear as `:keys` or ' +
          '`:count`. That is the difference between this file being a finding and being an export.'
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Coverage: every requirement no install can reach is probed or deferred
//
// The accounting that matters. A requirement that belongs to neither list is one the app tells the
// reader is coming, from a script that was never going to make the call.
// ---------------------------------------------------------------------------------------------

console.log('\nCoverage against the catalogue');

const collectors = new Set();
// Counted as well as collected, because three files tell a reader how many requirements this
// script is the answer to, and that sentence is what makes running it worth an admin's afternoon.
const asking = [];
for (const file of readdirSync(CONTROLS).filter((name) => name.endsWith('.yaml'))) {
  const pillar = parse(readFileSync(join(CONTROLS, file), 'utf8'));
  for (const principle of pillar?.principles ?? []) {
    for (const control of principle?.controls ?? []) {
      if (typeof control?.collector !== 'string') continue;
      collectors.add(control.collector);
      if (beyondAnyApp(control.collector)) asking.push(control.collector);
    }
  }
}

const unreachable = [...collectors].filter((collector) => beyondAnyApp(collector)).sort();
check(
  'the catalogue names requirements no install can reach',
  unreachable.length > 0,
  'No unreachable collectors were found, so this check proved nothing. Either the catalogue changed ' +
    'shape or families.ts stopped classifying, and either way the accounting below is vacuous.'
);

const probed = new Set(manifest.probes.flatMap((probe) => probe.signals));
const deferred = new Set(manifest.deferred.map((entry) => entry.signal));

for (const collector of unreachable) {
  check(
    `${collector} is probed or deferred`,
    probed.has(collector) || deferred.has(collector),
    `${collector} is a requirement no app install can read, and the admin script neither collects it ` +
      'nor says why not. Add a probe, or add it to DEFERRED with the reason — an unaccounted collector ' +
      'reports to the reader as an automated check that is coming.'
  );
}

for (const signal of [...probed, ...deferred].sort()) {
  check(
    `${signal} is a collector the catalogue names`,
    collectors.has(signal),
    `The admin script names ${signal}, which no control asks for. Either the catalogue's spelling ` +
      'changed or the probe answers nothing, and both mean an admin is being asked to make a call for ' +
      'no reason.'
  );
  check(
    `${signal} is beyond what an install can read`,
    beyondAnyApp(signal),
    `The admin script collects ${signal}, which this app can read for itself. Evidence an admin ran a ` +
      'script for is weaker than evidence the app observed, so a reachable collector belongs in the ' +
      'app rather than here.'
  );
}

for (const entry of manifest.deferred) {
  check(
    `the reason ${entry.signal} is deferred is a sentence`,
    entry.reason.length >= 80,
    `${entry.signal} is deferred with "${entry.reason}". The reason is read by whoever picks the work ` +
      'up, and one word is not a handover.'
  );
}

// The count in the prose, held against the count in the catalogue.
//
// Three files open by telling the reader how many requirements this script is the answer to, and
// that number is the entire case for running it. It was wrong on the first draft — written from an
// earlier catalogue, and off by eight — which nothing caught, because a stale number in a comment
// reads exactly like a current one. Here it is arithmetic instead.
const WORDS = new Map([
  [33, 'thirty-three'],
  [47, 'forty-seven'],
  [53, 'fifty-three'],
  [55, 'fifty-five'],
  [63, 'sixty-three'],
]);
const said = WORDS.get(asking.length);
const SAYING = [
  join('config', 'evidence', 'collect-evidence.py'),
  join('server', 'evidence', 'script.ts'),
  join('client', 'src', 'components', 'AdminScript.tsx'),
];

check(
  `the catalogue asks ${String(asking.length)} times for something no install can read`,
  said != null,
  `${String(asking.length)} controls name an unreachable collector, and this check has no word for ` +
    'that number. Add it to WORDS so the sentences below can be held against it.'
);

if (said != null) {
  for (const file of SAYING) {
    const prose = readFileSync(join(APP, file), 'utf8').slice(0, 2_000).toLowerCase();
    const stale = [...WORDS.values()].find((word) => word !== said && prose.includes(word));
    check(
      `${file} says how many requirements need this, and says ${said}`,
      prose.includes(said) && stale == null,
      `${file} opens by telling the reader how many requirements this script answers. The catalogue ` +
        `now names ${String(asking.length)} — "${said}" — and that file says ` +
        `${stale == null ? 'nothing' : `"${stale}"`}. It is the sentence that decides whether an admin ` +
        'runs the thing, so it does not get to be approximately right.'
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The settings keys, which live in two places and must not drift
// ---------------------------------------------------------------------------------------------

console.log('\nAgreement with the app');

const settingsProbe = manifest.probes.find((probe) => probe.signals.includes('rest:workspace:preview.workspace-conf'));
check(
  'the workspace settings probe exists',
  settingsProbe != null,
  'No probe collects rest:workspace:preview.workspace-conf, which sixteen requirements need.'
);

if (settingsProbe != null) {
  const asked = settingsProbe.query.find(([name]) => name === 'keys')?.[1]?.split(',') ?? [];
  const expected = [...REQUESTED_KEYS];
  check(
    'the script asks for exactly the keys the app resolves',
    asked.join(',') === expected.join(','),
    'The keys collect-evidence.py asks for differ from REQUESTED_KEYS in settings-keys.ts.\n' +
      `    script: ${asked.join(', ')}\n` +
      `    app:    ${expected.join(', ')}\n` +
      '    A key in the app and not the script is a requirement that silently stops being answerable.'
  );
  check(
    'it keeps exactly the keys it asks for',
    settingsProbe.fields.join(',') === asked.join(','),
    'The workspace settings probe keeps different keys from the ones it requests, which means it either ' +
      'discards an answer it asked for or writes a field nobody declared.'
  );
}

check(
  'the schema is versioned',
  /^waf-admin-evidence\/\d+$/.test(manifest.schema),
  `The envelope schema is "${manifest.schema}". The importer refuses a schema it does not know, so the ` +
    'version has to be there to be refused.'
);

check(
  'the script reports its own digest',
  typeof manifest.digest === 'string' && manifest.digest.startsWith('sha256:'),
  'collect-evidence.py did not report a digest of itself. The app publishes the checksum of the copy it ' +
    'ships so an outdated or edited script is flagged, and that comparison needs both halves.'
);

// ---------------------------------------------------------------------------------------------
// The dry run, which is the approval surface
// ---------------------------------------------------------------------------------------------

console.log('\nThe dry run');

let plan = '';
try {
  // A CLI that does not exist, so a dry run that reached the network would fail rather than pass
  // quietly. It prints the plan and nothing else.
  plan = execFileSync('python3', [SCRIPT, '--dry-run', '--profile', 'checked', '--cli', '/nonexistent/databricks'], {
    encoding: 'utf8',
  });
} catch (problem) {
  failures.push(`collect-evidence.py --dry-run exited non-zero: ${problem.message}`);
}

check(
  'the dry run needs no CLI',
  plan.includes('not found on PATH'),
  'The dry run did not report a missing CLI when pointed at one that does not exist, so it is doing ' +
    'something other than printing the plan.'
);

for (const probe of manifest.probes.filter((entry) => entry.tier === 'workspace')) {
  check(
    `the dry run names ${probe.label}`,
    plan.includes(probe.path.replace('{variant}', probe.variants[0] ?? '')),
    `The dry run does not mention ${probe.path}. Every call has to appear, or the output is not the ` +
      'approval surface the docstring says it is.'
  );
}

check(
  'the dry run says what it will not collect',
  manifest.deferred.every((entry) => plan.includes(entry.signal)),
  'The dry run does not list the deferred requirements. An admin deciding whether this script is worth ' +
    'running should see what it will not answer as well as what it will.'
);

if (failures.length > 0) {
  console.error(`\n${String(failures.length)} problem${failures.length === 1 ? '' : 's'} with the admin evidence script:\n`);
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

console.log(
  `\nThe admin evidence script is read-only, projects ${String(manifest.probes.length)} probes across both ` +
    `tiers, and accounts for all ${String(unreachable.length)} requirements no install can reach.`
);
