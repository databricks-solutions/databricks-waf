#!/usr/bin/env node
// Hold the answering guidance to its schema, to the catalogue, and to a floor that only rises.
//
// The rule this phase exists to enforce is that nothing ships without complete guidance. It cannot be
// enforced as an absolute today: 121 requirements need authoring, that is a content phase of its own,
// and a check demanding all of them now would fail on every commit until the last one landed — which
// in practice means a check somebody disables.
//
// So it is enforced as a ratchet instead. Shape is absolute and checked here in full: an entry that
// claims to be authored must satisfy every length and field rule, an entry must name a control that
// exists, and every requirement must at least have a scaffold so the backlog is visible in the tree
// rather than in somebody's head. Completeness is two numbers in config/guidance/authored.json that
// this check refuses to let fall — one for the nine original fields and one for the six L1b added.
// Row 38c of docs/plan-status.md raises them pillar by pillar, and when they reach the catalogue's
// own count the rule is absolute with nothing left to argue about.
//
// **The reach is every requirement, not every question.** It was the 52 attestation controls until
// L1b, on the reasoning that guidance for a measured requirement explains a finding rather than
// enabling an answer. Two things were wrong with that. A finding that says "pass" and stops is the
// state that makes this an audit rather than a path to best practice, which is the acceptance the
// advisor plan sets. And the narrower set was not even the set being asked about: measured
// 2026-08-10, this app can put 125 of the 184 to a person, and 62 of those had no guidance at all —
// every one of the 56 blocked questions, and 6 of the 17 inconclusive. The gate's required set was
// never the asked set, so it could not see that gap and did not report it.
//
// The half-authored case is the one worth naming, because it is the one that would reach a customer:
// an entry with three of nine fields written renders as guidance, reads as authored, and is worse
// than the sentence saying none was written. `status: authored` is the assertion, and the schema's
// conditional requirement is what holds it. The `advice` block is the same rule at a smaller scale —
// optional entirely, complete once present — because a recommendation rendered without the
// trade-offs beside it is a recommendation with its cost hidden.
//
// Three content rules join the shape rules, all measured against the corpus before being written so
// none of them is a threshold somebody picked: every authored entry cites something (63 of 63 already
// did), a named regulation is cited *by a reference that names it* (nothing names one yet, so it
// guards the security pillar's content phase), and no two entries say nearly the same thing (the
// closest existing pair scores 32%, against a bar of 50%).
//
// Filled is not the same as true, which is what the review gate below is for: an entry written against
// last year's console satisfies every rule above and reads exactly like a current one.
//
//   npm run check:guidance
//   npm run check:guidance -- --today 2027-03-01   # what the review gate will say on a given day
//   node scripts/scaffold-guidance.mjs             # writes the scaffolds this check asks for

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import * as yaml from 'js-yaml';
import { AGEING_MONTHS, STALE_MONTHS, asDate, reviewStanding } from './guidance-review.mjs';
import { SIMILAR, nearDuplicates, uncitedRegulations } from './guidance-prose.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
/*
 * The two tables that ask a question about a requirement this app otherwise measures.
 *
 * They matter here because guidance is keyed by control id and served by control id, so an entry
 * written for a control that later became measurable is still the guidance its question shows — see
 * the `asked()` helper in server/api/routes.ts, which falls through to both of these. Reading them
 * is what keeps this check from demanding that authored prose be deleted the day its requirement
 * gains a measure.
 */
const { INCONCLUSIVE_QUESTIONS } = await import(join(APP, 'server', 'attest', 'inconclusive-questions.ts'));
const { BLOCKED_QUESTIONS } = await import(join(APP, 'server', 'attest', 'blocked-questions.ts'));
const CONTROLS = join(APP, 'config', 'controls');
const GUIDANCE = join(APP, 'config', 'guidance');
const SCHEMA = join(GUIDANCE, 'guidance.schema.json');
const FLOOR = join(GUIDANCE, 'authored.json');

const problems = [];

/*
 * Said, but not fatal.
 *
 * The review gate needs to speak before it blocks, or its only two states are silence and a stopped
 * build — and the version of this that only blocks would have to block at twelve months to be fair,
 * so nothing would be said for a year while the content drifted.
 */
const warnings = [];

/**
 * The day to judge review dates against.
 *
 * Overridable so the gate can be demonstrated rather than described. Every date in the tree is days
 * old, so on any real run this branch does nothing, and `--today` is how a reader satisfies themselves
 * that it will do something in March. It only ever moves the *reading* of the dates, never a date.
 */
const today = (() => {
  const flag = process.argv.indexOf('--today');
  if (flag === -1) return new Date(new Date().toISOString().slice(0, 10));
  const given = asDate(process.argv[flag + 1]);
  if (given == null) {
    process.stderr.write(`--today needs a YYYY-MM-DD date, not '${String(process.argv[flag + 1])}'.\n`);
    process.exit(2);
  }
  return given;
})();

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(SCHEMA, 'utf8')));

/**
 * Every requirement, and the pillar file it belongs to.
 *
 * This is the reach change L1b exists for, and it is one line: the set that must carry an entry was
 * the 52 attestation controls and is now all 184. The plan states the reason as an acceptance —
 * every possible finding, a pass and a not-applicable included, should be able to say what the
 * target state is and when the advice changes — and a passing requirement that says "pass" and stops
 * is the state that makes this an audit rather than a path to best practice.
 */
const wanted = new Map();
/**
 * The requirements this app can put to a person, which is not the same set and is wider than it looks.
 *
 * Measured 2026-08-10: 125 of 184, being the 52 attestation controls plus 56 blocked questions and 17
 * inconclusive ones. That number is why the reach rule below is not the interesting half of this
 * change. The gate's required set was the 52; the *asked* set was 125; and 62 of those were being put
 * to a person with no guidance at all — every one of the 56 blocked questions, and 6 of the 17
 * inconclusive. A reader was being asked a question this app knew it could not answer, and given
 * nothing to answer it with.
 */
const askable = new Set([...Object.keys(INCONCLUSIVE_QUESTIONS), ...Object.keys(BLOCKED_QUESTIONS)]);
const known = new Set();
const files = new Map();

for (const name of yamlFiles(CONTROLS)) {
  const doc = yaml.load(readFileSync(join(CONTROLS, name), 'utf8'));
  const pillar = doc?.pillar?.id ?? name.replace(/\.yaml$/, '');
  files.set(name, pillar);

  for (const principle of doc?.principles ?? []) {
    for (const control of principle.controls ?? []) {
      known.add(control.id);
      wanted.set(control.id, { pillar, file: name, title: control.title });
      if (control.measurability === 'attestation') askable.add(control.id);
    }
  }
}

if (wanted.size === 0) {
  problems.push('The catalogue declares no controls at all, so this check proved nothing. That is a catalogue fault.');
}

/** Every guidance entry, validated as it is read. */
const entries = new Map();

for (const name of yamlFiles(GUIDANCE)) {
  const path = join(GUIDANCE, name);
  let doc;
  try {
    doc = yaml.load(readFileSync(path, 'utf8'));
  } catch (error) {
    problems.push(`${name} is not valid YAML: ${error.message}`);
    continue;
  }

  if (!validate(doc)) {
    for (const fault of validate.errors ?? []) {
      problems.push(`${name}${fault.instancePath}: ${fault.message}`);
    }
  }

  const expected = files.get(name);
  if (expected != null && doc?.pillar !== expected) {
    problems.push(`${name} declares pillar '${String(doc?.pillar)}', but the catalogue file of that name is '${expected}'`);
  }

  for (const [controlId, entry] of Object.entries(doc?.entries ?? {})) {
    if (entries.has(controlId)) {
      problems.push(`${controlId} has guidance in two files: ${entries.get(controlId).file} and ${name}`);
      continue;
    }
    entries.set(controlId, { file: name, entry: entry ?? {} });

    // An orphan is a rename that happened upstream, and this is the day to notice: the entry is
    // somebody's writing and it is about to become unreachable.
    if (!known.has(controlId)) {
      problems.push(
        `${name} has guidance for ${controlId}, which is not in the catalogue. ` +
          'Either the control was renamed — move the entry — or the id is a typo.'
      );
      continue;
    }

    const home = wanted.get(controlId);
    if (home != null && home.file !== name) {
      problems.push(`${controlId} belongs to ${home.pillar}, so its guidance belongs in ${home.file}, not ${name}`);
    }
  }
}

/*
 * Scaffolds, so the backlog lives in the tree.
 *
 * A missing entry and an unwritten one are different states and only one of them is visible: without
 * this, "which requirements still need guidance" is answered by running a script, and the answer
 * never appears in a diff or a review.
 */
const unscaffolded = [...wanted.keys()].filter((id) => !entries.has(id));
if (unscaffolded.length > 0) {
  problems.push(
    `${unscaffolded.length} requirement${unscaffolded.length === 1 ? '' : 's'} have no guidance entry at all: ` +
      `${unscaffolded.slice(0, 6).join(', ')}${unscaffolded.length > 6 ? ', …' : ''}\n` +
      '      Run `node scripts/scaffold-guidance.mjs`, which writes the skeleton so authoring is only prose.'
  );
}

const authored = [...entries.entries()].filter(([, held]) => held.entry?.status === 'authored');

/*
 * The ratchet.
 *
 * `authored.json` records the floor and this refuses to let it fall, which is what makes a content
 * backlog finish: a pillar that gets written stays written, and the number in the file is the only
 * place the project's own claim about coverage lives. It is raised by hand in the same change that
 * authors the entries, because a script that raised it automatically would be a script that lowered
 * it automatically.
 */
const floor = readFloor();
if (floor != null && authored.length < floor.authored) {
  problems.push(
    `${authored.length} entries are authored, but config/guidance/authored.json records a floor of ${floor.authored}.\n` +
      '      Guidance was removed or set back to draft. Restore it, or — if the entry was genuinely wrong and\n' +
      '      withdrawing it is the honest fix — lower the floor in the same change and say why in the commit.'
  );
}

const advised = authored.filter(([, held]) => held.entry?.advice != null);

/*
 * The second ratchet, over the six dimensions L1b added.
 *
 * Its own floor rather than a share of the first, because the two backlogs finish at different times:
 * every entry authored before 2026-08-10 was written against nine fields and has none of the six, so
 * folding them into one number would report the older corpus as incomplete on the day the schema
 * changed. L1c raises this one entry by entry, the same way row 10 raised the other.
 */
if (floor != null && advised.length < floor.advised) {
  problems.push(
    `${advised.length} entries carry advice, but config/guidance/authored.json records a floor of ${floor.advised}.\n` +
      '      Same rule as the line above: restore it, or lower the floor in the same change and say why.'
  );
}

/*
 * An authored entry cites something.
 *
 * Absolute rather than a ratchet, which the measurement earned: all 63 authored entries already carry
 * at least one reference, so this fails nothing today and cannot be satisfied by the next entry
 * quietly omitting one. The plan asks for required citations because the model phases synthesize over
 * this corpus, and a paragraph with no source behind it is the one that becomes an invented best
 * practice with a machine's confidence attached.
 */
const uncited = authored.filter(([, held]) => (held.entry?.references ?? []).length === 0);
if (uncited.length > 0) {
  problems.push(
    `${uncited.length} authored entr${uncited.length === 1 ? 'y cites' : 'ies cite'} nothing: ${uncited.map(([id]) => id).join(', ')}\n` +
      '      Add at least one `references` URL. The control already carries the framework anchor, so this is the\n' +
      '      documentation somebody would read next — and it is what a later reader checks the prose against.'
  );
}

/*
 * A regulation named is a regulation cited.
 *
 * Nothing in the tree names one today, so this catches nothing and is a guardrail for the content
 * phase rather than a correction. It is worth having pointed at that phase in particular: 70 of the
 * 184 requirements are security, compliance and privacy, "this is required under GDPR" is the
 * sentence that writes itself while authoring them, and it is a legal claim this project is not in a
 * position to make. Naming the regulation is fine; naming it with nothing to read is not.
 *
 * The citation has to be *of the regulation*, which is what distinguishes this from the rule above it.
 * Written the obvious way — fail when the entry names one and cites nothing — it would have been dead
 * code from the day it landed, because the rule above already fails every authored entry that cites
 * nothing at all. The sentence it is meant to stop is "GDPR requires this" beside a link to the
 * cluster policy documentation, and that entry cites something.
 */
for (const [id, held] of authored) {
  for (const regulation of uncitedRegulations(held.entry)) {
    problems.push(
      `${id} names ${regulation.named}, and none of its references does.\n` +
        '      A regulatory claim sourced to a page about something else is this project telling a customer what\n' +
        '      the law requires of them. Cite the obligation itself, or describe the practice without naming the\n' +
        '      regulation it is usually asked for by. This cannot check that the source says what the entry says\n' +
        '      it says — `last_reviewed` is the only guard for that — so it asks only that the source be about it.'
    );
  }
}

/*
 * Advice that would fit anywhere fits nowhere.
 *
 * Generic material repeated across unrelated requirements is the failure mode the plan names for the
 * content phase, and it is invisible one entry at a time: each reads plausibly, and only the corpus
 * shows that four of them say the same thing. So it is checked over pairs.
 *
 * The threshold is measured rather than chosen. Across the 1,953 pairs of authored entries, the most
 * similar `means` scores 0.185 by this metric, the most similar `matters` 0.317 and the most similar
 * `partial_when` 0.261 — so the corpus as written tops out at about a third. Half is well clear of
 * that and well below what a templated paragraph scores, and the gap is the headroom: an author is
 * not going to trip this by writing two entries about related requirements.
 */
for (const { one, other, field, overlap } of nearDuplicates(authored.map(([id, held]) => [id, held.entry]))) {
  problems.push(
    `${one} and ${other} say nearly the same thing in \`${field}\` (${Math.round(overlap * 100)}% of the significant ` +
      `words in common, against a bar of ${Math.round(SIMILAR * 100)}% and a corpus whose closest pair was 32% when ` +
      'that bar was set).\n' +
      '      Advice that would fit either requirement is advice about neither. Say what is specific to each, or — if\n' +
      '      they genuinely share a practice — say it once and let the other point at the requirement that holds it.'
  );
}

/*
 * The review gate.
 *
 * Two thresholds, because "is this stale" is not a boolean. Past six months somebody should look; past
 * twelve the entry has stopped being evidence that anybody has. The clock is `last_reviewed`, which the
 * schema already requires on an authored entry — what it cannot check is whether the date is true, and
 * neither can this. What it can do is refuse to let the claim go unexamined for a year.
 *
 * A date in the future fails immediately and separately. It is the only fault here that turns the gate
 * off instead of tripping it: a year keyed as 2027 reads as diligence and buys silence until 2028.
 */
const standing = reviewStanding(
  authored.map(([id, held]) => ({ id, file: held.file, reviewed: held.entry?.last_reviewed })),
  today
);

const listed = (entries) =>
  entries
    .slice(0, 8)
    .map((one) => `${one.id} (${one.file}, ${one.months ?? '?'}m)`)
    .join(', ') + (entries.length > 8 ? `, and ${entries.length - 8} more` : '');

if (standing.stale.length > 0) {
  problems.push(
    `${standing.stale.length} authored entr${standing.stale.length === 1 ? 'y has' : 'ies have'} not been reviewed for ${STALE_MONTHS} months: ${listed(standing.stale)}\n` +
      '      Read each against the current console and framework, correct what has moved, and set\n' +
      "      `last_reviewed` to the day you read it. Do not set the date without reading — that is the\n" +
      '      one thing this check cannot detect, and the whole value of the field rests on it.'
  );
}

if (standing.ahead.length > 0) {
  problems.push(
    `${standing.ahead.length} authored entr${standing.ahead.length === 1 ? 'y is' : 'ies are'} dated in the future: ${listed(standing.ahead)}\n` +
      '      A `last_reviewed` after today silences this gate for as long as the date is wrong, which is\n' +
      '      why it fails rather than warns. Almost always a mistyped year.'
  );
}

if (standing.undated.length > 0) {
  problems.push(
    `${standing.undated.length} authored entr${standing.undated.length === 1 ? 'y has' : 'ies have'} no readable review date: ${standing.undated.map((one) => `${one.id} (${one.file})`).join(', ')}\n` +
      '      The schema requires `last_reviewed` on an authored entry and expects `YYYY-MM-DD`. An\n' +
      '      unreadable one is not a missing field, it is a gate that cannot run on that entry.'
  );
}

if (standing.ageing.length > 0) {
  warnings.push(
    `${standing.ageing.length} authored entr${standing.ageing.length === 1 ? 'y is' : 'ies are'} over ${AGEING_MONTHS} months old: ${listed(standing.ageing)}\n` +
      `      Not a failure until ${STALE_MONTHS} months. Worth a read before then, oldest first.`
  );
}

// Counted over the requirements rather than over every entry, because an entry for a control the
// catalogue does not have is a hard failure above and would otherwise deflate this line on the way
// past — a summary that reads better on a broken tree than a sound one.
const outstanding = wanted.size - authored.filter(([id]) => wanted.has(id)).length;
/*
 * The requirements somebody is being asked about, reported separately from the total.
 *
 * Two numbers rather than one, because they are two different failures. An unauthored measured
 * requirement means a finding that says "pass" and stops; an unauthored *asked* one means a person
 * is answering a question with nothing to answer it from, and that reader is in front of the gap
 * today. The second number is the one to close first, and it is only visible if it is printed.
 */
const asked = [...askable].filter((id) => wanted.has(id));
const askedWritten = authored.filter(([id]) => askable.has(id)).length;

process.stdout.write('Guidance\n\n');
for (const [name, pillar] of files) {
  const inFile = [...wanted.values()].filter((one) => one.file === name).length;
  if (inFile === 0) continue;
  const written = authored.filter(([id]) => wanted.get(id)?.file === name).length;
  const withAdvice = advised.filter(([id]) => wanted.get(id)?.file === name).length;
  process.stdout.write(
    `  ${pillar.padEnd(34)} ${String(written).padStart(3)} of ${String(inFile).padStart(3)} authored, ` +
      `${String(withAdvice).padStart(3)} advised\n`
  );
}
process.stdout.write(
  `\n  ${authored.filter(([id]) => wanted.has(id)).length} of ${wanted.size} requirements carry authored guidance`
);
process.stdout.write(floor == null ? '.\n' : `, against a floor of ${floor.authored}.\n`);
process.stdout.write(
  `  ${advised.length} of those also carry the six advice dimensions` +
    (floor == null ? '.\n' : `, against a floor of ${floor.advised}.\n`)
);
process.stdout.write(
  `  ${askedWritten} of the ${asked.length} this app can put to a person are written, which is the part a reader meets.\n`
);
if (outstanding > 0) {
  process.stdout.write(
    `  ${outstanding} still to write. They are scaffolded, and a requirement with none shows the reader that\n` +
      '  rather than an empty panel — see docs/design/guidance-authoring.md.\n'
  );
}

if (authored.length > 0) {
  const oldest = [...standing.stale, ...standing.ageing, ...standing.fresh].at(0);
  // The unplaceable count is stated rather than left out, so this line cannot read as a clean bill of
  // health while some entries were never measured. The problems above name them; this is what stops a
  // reader who only skims the summary from concluding the gate ran on everything.
  const unplaceable = standing.undated.length + standing.ahead.length;
  process.stdout.write(
    `\n  Reviewed: ${standing.fresh.length} within ${AGEING_MONTHS} months` +
      `${standing.ageing.length > 0 ? `, ${standing.ageing.length} ageing` : ''}` +
      `${standing.stale.length > 0 ? `, ${standing.stale.length} stale` : ''}` +
      `${unplaceable > 0 ? `, ${unplaceable} with a date this cannot use` : ''}` +
      `${oldest?.months == null ? '' : `. Oldest is ${oldest.months} month${oldest.months === 1 ? '' : 's'} old`}.\n`
  );
}

if (warnings.length > 0) {
  process.stdout.write(`\n${warnings.length} warning${warnings.length === 1 ? '' : 's'}:\n`);
  for (const warning of warnings) process.stdout.write(`  - ${warning}\n`);
}

if (problems.length > 0) {
  process.stderr.write(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.exit(1);
}

process.stdout.write('\nGuidance matches the catalogue and its schema.\n');

function yamlFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.yaml'))
    .sort();
}

/*
 * The floors, or a problem saying why there are none.
 *
 * A missing key is a fault rather than an absence. Returning `null` for one would have made both
 * ratchets removable by deleting a line — the check would pass, the summary would quietly drop the
 * `against a floor of N` clause, and the only trace would be an absence nobody reads. A ratchet that
 * can be taken off silently is not one, and the design deliberately allows a floor to be *lowered*
 * with a reason in the commit, which is the reviewable version of the same act.
 */
function readFloor() {
  if (!existsSync(FLOOR)) {
    problems.push('config/guidance/authored.json is missing, so neither coverage floor could be checked.');
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(FLOOR, 'utf8'));
  } catch {
    problems.push('config/guidance/authored.json is not readable JSON, so neither coverage floor could be checked.');
    return null;
  }
  const missing = ['authored', 'advised'].filter((key) => typeof parsed?.[key] !== 'number');
  if (missing.length > 0) {
    problems.push(
      `config/guidance/authored.json has no numeric ${missing.join(' and no numeric ')}, so that floor is not being\n` +
        '      checked at all. Lowering a floor is allowed with a reason in the commit; removing one is not, because\n' +
        '      the only trace it leaves is a missing clause in a summary line.'
    );
    return null;
  }
  return parsed;
}
