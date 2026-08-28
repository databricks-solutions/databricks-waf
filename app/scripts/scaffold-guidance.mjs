#!/usr/bin/env node
// Write an empty guidance entry for every requirement that has none, and report what is left to write.
//
// Authoring guidance is writing prose. It should never also be wiring structure, remembering which
// fields the schema wants, or working out which of 184 requirements still needs an entry — three
// tasks that between them are why content backlogs stall. So this writes the skeleton and the author
// fills it in, and `--report` answers "how far through are we" without touching a file.
//
// It never edits an entry that exists. An entry is somebody's writing, including a draft somebody is
// halfway through, and a scaffolder that rewrote drafts would eventually overwrite a paragraph
// somebody had not committed.
//
//   node scripts/scaffold-guidance.mjs           # write missing entries
//   node scripts/scaffold-guidance.mjs --report  # say what is missing and stop

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
/*
 * The two tables that put a question to a person about a requirement the catalogue calls measured.
 *
 * Read here for the same reason check-guidance.mjs reads them: whether somebody is asked about a
 * requirement is not answerable from `attestation.question` alone. 73 measured controls are asked
 * about through these, and scaffolding them with "this is measured, so guidance explains a finding"
 * would tell an author the opposite of what is true for the entries most urgently needing writing.
 */
const { INCONCLUSIVE_QUESTIONS } = await import(join(APP, 'server', 'attest', 'inconclusive-questions.ts'));
const { BLOCKED_QUESTIONS } = await import(join(APP, 'server', 'attest', 'blocked-questions.ts'));
const CONTROLS = join(APP, 'config', 'controls');
const GUIDANCE = join(APP, 'config', 'guidance');

const report = process.argv.includes('--report');

/*
 * A draft, written as YAML by hand rather than dumped by js-yaml.
 *
 * The dumper would produce a valid file and a useless one: keys in insertion order with no comments
 * and no indication of what any field is for, so an author would have to read the schema beside it.
 * This is the field list, in the order the panel reads them, with the sentence that says what each
 * one is for — which is the difference between filling in a form and guessing at one.
 */
const DRAFT = (controlId, title, question) =>
  [
    `  # ${title}`,
    question === ''
      ? `  # Never put to a person. Guidance here explains a finding rather than enabling an answer.`
      : `  # Q: ${question}`,
    `  ${controlId}:`,
    `    status: draft`,
    `    # owner_role: who typically holds this answer, e.g. Platform administrator`,
    `    # means: what the practice is, in plain terms. Not a restatement of the title.`,
    `    # matters: the risk of not doing it. A consequence, not a virtue.`,
    `    # good:            # the rubric an answer is measured against, two to eight signals`,
    `    #   - `,
    `    #   - `,
    `    # examples:        # so a reader places themselves honestly rather than aspirationally`,
    `    #   strong: `,
    `    #   partial: `,
    `    #   weak: `,
    `    # verify:          # where to look, so the answer is evidence-backed`,
    `    #   - how: ui      # ui | sql | cli | api | by-hand`,
    `    #     where: `,
    `    #     expect: `,
    `    # pitfalls:        # the ways this is got wrong, including the ways that look right`,
    `    #   - `,
    `    # partial_when: when "partially" is the honest answer`,
    `    # not_applicable_when: omit unless it can genuinely not apply`,
    `    # references:      # beyond the WAF anchor the control already carries`,
    `    #   - `,
    `    # last_reviewed: YYYY-MM-DD   # required once status is authored`,
    `    # advice:          # what to do about it, as against how to answer about it. All six or none.`,
    `    #   start_from: the safe default for a customer with no policy yet`,
    `    #   depends_on:    # what changes that default, and what it changes it to`,
    `    #     - `,
    `    #     - `,
    `    #   path:          # observed state, then a baseline, then the target`,
    `    #     - `,
    `    #     - `,
    `    #   costs:         # what following that path costs, in money, complexity or somebody's week`,
    `    #     - `,
    `    #   retain: the artefact that proves this at the next review`,
    `    #   revisit: the event or cadence that reopens the decision`,
  ].join('\n');

const header = (pillarId) =>
  [
    '# Answering guidance for the questions in this pillar.',
    '#',
    '# Keyed by control id, flat rather than nested by principle: the catalogue owns that structure.',
    '# Scaffolded by scripts/scaffold-guidance.mjs, which never edits an entry that already exists.',
    '# Held to config/guidance/guidance.schema.json by scripts/check-guidance.mjs.',
    '#',
    '# docs/design/guidance-authoring.md fixes the voice and works one entry through end to end.',
    `pillar: ${pillarId}`,
    'entries:',
  ].join('\n');

/*
 * Every question in the catalogue, grouped by the file it belongs in.
 *
 * The pillar files are read from the directory rather than listed here. A list would have been shorter
 * and would have silently skipped an eighth pillar, which is exactly the failure this whole phase is
 * about: content missing without anything saying so.
 */
const questions = new Map();
for (const name of readdirSync(CONTROLS).filter((one) => one.endsWith('.yaml')).sort()) {
  const file = name.replace(/\.yaml$/, '');
  const doc = yaml.load(readFileSync(join(CONTROLS, name), 'utf8'));
  if (doc?.principles == null) continue;
  const wanted = [];

  for (const principle of doc?.principles ?? []) {
    for (const control of principle.controls ?? []) {
      // Every requirement, not only the ones a person is asked about. A measured requirement that
      // passes still has a target state, a cost of sustaining it and an event that reopens it, and a
      // finding that says "pass" and stops is what makes this an audit rather than a path to best
      // practice. See the reach note at the top of check-guidance.mjs.
      //
      // The header line still says which it is, because the two need different prose and an author
      // who cannot tell from the scaffold will write the wrong one.
      wanted.push({ id: control.id, title: control.title, question: asked(control) });
    }
  }

  questions.set(file, { pillar: doc?.pillar?.id ?? file, wanted });
}

/**
 * The question this app puts to a person about a requirement, or `''` where it puts none.
 *
 * Three sources in the order the app falls through them, which is the order in `asked()` in
 * server/api/routes.ts: the catalogue's own question, then the inconclusive table, then the blocked
 * one. Only a requirement in none of the three is never put to anybody.
 */
function asked(control) {
  const question =
    control.attestation?.question ??
    INCONCLUSIVE_QUESTIONS[control.id]?.question ??
    BLOCKED_QUESTIONS[control.id]?.question ??
    '';
  return question.replace(/\s+/g, ' ').trim();
}

const rows = [];
let written = 0;
let missing = 0;

for (const [file, { pillar, wanted }] of questions) {
  const path = join(GUIDANCE, `${file}.yaml`);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const parsed = existing == null ? null : yaml.load(existing);
  const have = new Set(Object.keys(parsed?.entries ?? {}));
  const absent = wanted.filter((one) => !have.has(one.id));
  const authored = Object.values(parsed?.entries ?? {}).filter((one) => one?.status === 'authored').length;

  missing += absent.length;
  rows.push({ file, questions: wanted.length, authored, drafts: have.size - authored, absent: absent.length });

  if (report || absent.length === 0) continue;

  const body = absent.map((one) => DRAFT(one.id, one.title, one.question)).join('\n\n');
  const next = existing == null ? `${header(pillar)}\n${body}\n` : `${existing.replace(/\s*$/, '')}\n\n${body}\n`;
  writeFileSync(path, next, 'utf8');
  written += absent.length;
}

const total = rows.reduce((sum, row) => sum + row.questions, 0);
const authored = rows.reduce((sum, row) => sum + row.authored, 0);

process.stdout.write('Guidance coverage\n\n');
process.stdout.write('  file                             requirements  authored  drafts  no entry\n');
for (const row of rows) {
  process.stdout.write(
    `  ${row.file.padEnd(34)}  ${String(row.questions).padStart(9)}  ${String(row.authored).padStart(8)}  ` +
      `${String(row.drafts).padStart(6)}  ${String(row.absent).padStart(8)}\n`
  );
}

process.stdout.write(`\n  ${authored} of ${total} requirements have authored guidance.\n`);
if (written > 0) process.stdout.write(`  Scaffolded ${written} new entr${written === 1 ? 'y' : 'ies'}.\n`);
if (report && missing > 0) process.stdout.write(`  ${missing} have no entry at all. Run without --report to scaffold them.\n`);
