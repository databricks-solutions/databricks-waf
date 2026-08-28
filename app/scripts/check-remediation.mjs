#!/usr/bin/env node
// Does every requirement this app can fail have something a reader can act on?
//
// The app measures 84 requirements, and a run that finds 40 of them unmet produces 40 rows. What
// makes those rows worth anything is what the reader does next, and for most of the build that was
// a sentence: "Move scheduled work off all-purpose clusters onto job compute." True, and not a
// fix. The reader still has to find out which clusters, which page, which flag — which is the work
// — and an assessment that stops at the diagnosis has handed them a to-do list, not a remedy.
//
// So the gate: a requirement the app can measure as failing must carry either something runnable —
// SQL, a CLI command, Terraform — or an explicit statement that no command exists and what a
// person does instead. Both are acceptable answers. What is not acceptable is silence, because
// silence is indistinguishable from nobody having thought about it.
//
// The `by_hand` escape hatch is the part worth defending. Plenty of these fixes genuinely are not
// commands: "confirm each GPU cluster serves a deep-learning workload" is a judgement, and
// assigning a workspace to a metastore in another region is an account-console action with no API
// this app should be telling people to drive. A gate that demanded a snippet for those would be
// satisfied by inventing one, and an invented command that half-works is worse than a paragraph
// that is honest. What the gate can insist on is that the statement is specific enough to follow
// and says where to go, which is why `by_hand` requires a link beside it.
//
// Two failure modes this deliberately catches beyond the missing case:
//
//   A snippet nobody could run. `-- see the docs` in a SQL field satisfies a naive check for a
//   non-empty string and satisfies nothing else. Snippets have to look like the thing they claim
//   to be, and placeholders have to be obviously placeholders.
//
//   One paragraph pasted across a pillar. The same `by_hand` text on nine unrelated requirements
//   is a template with extra steps, and the check that rejected the generic attestation question
//   exists because that is exactly what happened there. Repetition is allowed only inside an alias
//   group, where it is the same requirement written down twice on purpose.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTROLS = join(HERE, '..', 'config', 'controls');

/** Below this a statement is a label. The attested answers use the same floor for the same reason. */
const MIN_BY_HAND = 80;

/**
 * Text that passes for an instruction without being one.
 *
 * Matched as whole phrases rather than words, because "documentation" is a legitimate part of a
 * real instruction and "see the documentation" is the absence of one.
 */
const EMPTY_PHRASES = [
  'see the documentation',
  'see the docs',
  'refer to the documentation',
  'follow the documentation',
  'contact your administrator',
  'consult your',
  'as appropriate',
  'as needed',
  'tbd',
  'todo',
];

const controls = load();
const failable = controls.filter((control) => control.evaluator_status === 'implemented');
const problems = [];

for (const control of failable) {
  const fix = remediationFor(control, controls);
  if (fix == null) {
    problems.push(
      `${control.id} — ${control.title}\n` +
        '      No remediation at all. This is a requirement the app can report as failed, so a run\n' +
        '      will put it in front of a reader with nothing to do about it.'
    );
    continue;
  }

  const runnable = ['sql', 'cli', 'terraform'].filter((kind) => text(fix[kind]) != null);
  const byHand = text(fix.by_hand);

  if (runnable.length === 0 && byHand == null) {
    problems.push(
      `${control.id} — ${control.title}\n` +
        `      Prose only: "${(text(fix.summary) ?? '').slice(0, 70)}…"\n` +
        '      Give a sql, cli or terraform snippet, or say in by_hand what a person does instead\n' +
        '      and where. A summary tells the reader what to achieve; neither of those tells them\n' +
        '      what to run.'
    );
  }

  for (const kind of runnable) problems.push(...unrunnable(control, kind, text(fix[kind]) ?? ''));
  if (byHand != null) problems.push(...unusable(control, byHand, fix));
}

problems.push(...pastedByHand(failable, controls));

if (problems.length > 0) {
  // Counted as problems rather than as requirements, because one requirement can have two: a CLI
  // snippet that is both a cloud-provider command and carries a TODO is two things to fix.
  process.stderr.write(
    `${String(problems.length)} problem(s) with the fixes for the ${String(failable.length)} requirements this app ` +
      'can measure as failing.\n\n'
  );
  for (const problem of problems) process.stderr.write(`  - ${problem}\n\n`);
  process.stderr.write(
    'Author the fix in config/controls/enrichment.mjs and run `npm run enrich:catalogue`. The\n' +
      'pillar YAML is the product of that table, so editing it directly will be reverted.\n'
  );
  process.exit(1);
}

const scripted = failable.filter((control) => {
  const fix = remediationFor(control, controls) ?? {};
  return ['sql', 'cli', 'terraform'].some((kind) => text(fix[kind]) != null);
}).length;

process.stdout.write(
  `Every one of the ${String(failable.length)} measured requirements can be acted on: ` +
    `${String(scripted)} with something runnable, ${String(failable.length - scripted)} by hand with a link.\n`
);

/** Every control in the catalogue, flattened, keeping the fields this check reads. */
function load() {
  const all = [];
  for (const file of readdirSync(CONTROLS).filter((name) => name.endsWith('.yaml'))) {
    const doc = yaml.load(readFileSync(join(CONTROLS, file), 'utf8'));
    for (const principle of doc.principles ?? []) {
      for (const control of principle.controls ?? []) all.push({ ...control, file });
    }
  }
  return all;
}

/**
 * The fix that reaches the reader, which is not always the one written on the control.
 *
 * Mirrors `withSharedRemediation` in server/catalogue/catalogue.ts: a member of an alias group with
 * no fix of its own shows the one its group agrees on. Checking the raw YAML instead would demand
 * four copies of the Delta conversion snippet and get them, which is the drift that function exists
 * to prevent.
 */
function remediationFor(control, all) {
  if (control.remediation != null) return control.remediation;
  if (control.alias_group == null) return undefined;

  const authored = all
    .filter((one) => one.alias_group === control.alias_group && one.remediation != null)
    .map((one) => one.remediation);
  if (authored.length === 0) return undefined;

  const [first] = authored;
  return authored.every((one) => JSON.stringify(sorted(one)) === JSON.stringify(sorted(first))) ? first : undefined;
}

function sorted(remediation) {
  return Object.fromEntries(Object.entries(remediation).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Whether a snippet is the kind of thing it says it is.
 *
 * Shape rather than syntax: this is not going to parse SQL, and it does not need to. What it needs
 * to catch is a field filled in to satisfy the gate — a doc link in the `cli` slot, a sentence in
 * the `sql` slot — because those pass a length check and fail a reader.
 */
function unrunnable(control, kind, snippet) {
  const problems = [];
  const at = `${control.id} (${kind})`;

  if (snippet.startsWith('http')) {
    problems.push(`${at}\n      A URL, not a command. Links belong in doc_url.`);
    return problems;
  }

  if (kind === 'cli' && !/^databricks\s/m.test(snippet)) {
    problems.push(
      `${at}\n      Does not start with \`databricks\`. If the fix is a cloud-provider command or a\n` +
        '      console action, say so in by_hand rather than putting it in the CLI slot.'
    );
  }

  if (kind === 'sql' && !snippet.trimEnd().endsWith(';')) {
    problems.push(`${at}\n      Unterminated. A reader copies this into an editor and runs it, so end the statement.`);
  }

  // Placeholders are expected — nobody's cluster id is in the catalogue — but they have to read as
  // placeholders. `<cluster-id>` and `1234-567890-abc123` are; a real-looking value is a trap.
  if (/\bTODO\b|\bFIXME\b|xxx+/i.test(snippet)) {
    problems.push(`${at}\n      Contains a marker left behind: ${/\bTODO\b|\bFIXME\b|xxx+/i.exec(snippet)?.[0] ?? ''}.`);
  }

  return problems;
}

/**
 * Whether a by-hand instruction is one a reader could follow.
 *
 * The two things that make the difference are length — because the short version is always a
 * restatement of the title — and a destination, because "assign the workspace to a metastore" is
 * only actionable if the reader knows the account console is where that happens.
 */
function unusable(control, byHand, fix) {
  const problems = [];
  const at = `${control.id} (by_hand)`;

  if (byHand.length < MIN_BY_HAND) {
    problems.push(
      `${at}\n      Too short at ${String(byHand.length)} characters (minimum ${String(MIN_BY_HAND)}). A fix with no\n` +
        '      command has to earn its place by being specific about what to do instead.'
    );
  }

  const empty = EMPTY_PHRASES.find((phrase) => byHand.toLowerCase().includes(phrase));
  if (empty != null) {
    problems.push(`${at}\n      Says "${empty}", which is where the reader was already stuck.`);
  }

  if (text(fix.doc_url) == null && text(fix.deep_link) == null) {
    problems.push(
      `${at}\n      No doc_url or deep_link. A fix nobody can run needs somewhere to go; without one\n` +
        '      the reader is being told to do something and left to find the page themselves.'
    );
  }

  return problems;
}

/**
 * One paragraph doing duty for several requirements.
 *
 * Allowed inside an alias group, which is the same requirement written down in two pillars, and
 * refused everywhere else. The generic-attestation check exists because a template got authored
 * once; this is the same failure with a different field.
 */
function pastedByHand(failable, all) {
  const seen = new Map();
  for (const control of failable) {
    const byHand = text(remediationFor(control, all)?.by_hand);
    if (byHand == null) continue;
    const key = byHand.toLowerCase().replace(/\s+/g, ' ');
    seen.set(key, [...(seen.get(key) ?? []), control]);
  }

  const problems = [];
  for (const [, group] of seen) {
    const groups = new Set(group.map((control) => control.alias_group ?? control.id));
    if (group.length > 1 && groups.size > 1) {
      problems.push(
        `${group.map((control) => control.id).join(', ')}\n` +
          '      Share one by_hand paragraph across requirements that are not the same requirement.\n' +
          '      Write what each of them actually needs, or give them an alias_group if they really\n' +
          '      are one thing said twice.'
      );
    }
  }
  return problems;
}

function text(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
