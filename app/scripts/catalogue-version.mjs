#!/usr/bin/env node
// Maintain the catalogue version, and make forgetting to bump it impossible.
//
// Every scan records the catalogue version it was scored against. Two scans are
// only comparable if they assessed the same requirements weighted the same way,
// so the trend view refuses to span a version change rather than drawing a line
// through it. A score that moves because the catalogue grew is not an estate
// that got worse, and presenting it as one destroys trust in every other number.
//
// A version a human has to remember to bump is a version that will be wrong. So
// the version is paired with a fingerprint computed from the catalogue itself,
// and CI fails when the content moved but the version did not. The human decides
// when a change is material; the machine notices that a change happened.
//
// What the fingerprint covers is the whole design decision. It covers what makes
// two scans comparable: which requirements exist, which pillar they score under,
// how heavily they weigh, what thresholds they are judged against, and when they
// leave the denominator. It deliberately excludes prose -- remediation text, pass
// criteria wording, attestation guidance, source links -- because fixing a typo
// in a remediation hint must not discard a customer's scan history.
//
// evaluator_status is also excluded, which is the least obvious call here. A
// control moving from planned to implemented does change what the app can
// measure, but that is a property of the code rather than of the requirement set,
// and it changes on nearly every release. Folding it in would bump the catalogue
// version continuously and leave the trend view permanently unable to compare
// anything. The scan record carries the app version separately for that.
//
// The version record also holds the scoring shape of every control, and every bump
// appends an entry to changelog.json describing the transition: what was added,
// removed, renamed, and which fields moved on the ones that stayed. That record is
// what lets the app compare two runs across a version change instead of refusing
// them -- a refusal is honest and is also a product failure on the month we ship a
// catalogue update, because the customer's trend resets in front of their
// executives for a reason that has nothing to do with their estate.
//
// A rename is declared, not guessed. A control that continues an earlier one names
// it in `continues:`, and the script pairs the two. Inferring a rename from shape
// similarity would silently merge two requirements' histories, which is worse than
// showing an addition beside a removal.
//
// Which leaves the case the declaration was simply forgotten. A version that both
// adds and removes a requirement is either a real exchange of scope or a renumbering
// missing its `continues:`, and the two produce identical catalogues -- so nothing
// here can tell them apart, and the changelog it writes reads as a fact afterwards
// either way. So a bump in that shape refuses until the author affirms which
// additions are unrelated to the removals, and it names the pairs it noticed so the
// affirmation is an answer to something rather than a box to tick. The affirmation
// enumerates ids, which is what stops it becoming a flag pasted from last release:
// it goes stale the moment the change set moves.
//
// Usage:
//   node scripts/catalogue-version.mjs           report and verify
//   node scripts/catalogue-version.mjs --check    exit non-zero on unrecorded change
//   node scripts/catalogue-version.mjs --bump     accept the change, increment
//   node scripts/catalogue-version.mjs --bump --unrelated ID,ID
//                                                affirm those additions renumber nothing

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));

// Overridable so the bump can be exercised against a small catalogue in a temporary
// directory. Without it the only way to test what a bump writes is to bump the real
// catalogue, which is a change to every customer's comparability to prove a diff.
const dirFlag = process.argv.indexOf('--dir');
const CONTROLS_DIR = dirFlag === -1 ? join(HERE, '..', 'config', 'controls') : process.argv[dirFlag + 1];
const VERSION_PATH = join(CONTROLS_DIR, 'version.json');
const CHANGELOG_PATH = join(CONTROLS_DIR, 'changelog.json');

// Serialise with keys in a fixed order so the fingerprint depends on content and
// not on the order a YAML editor happened to leave things in.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// The comparability-relevant projection of a control. Anything not named here is
// free to change without invalidating history.
function scoringShape(pillarCode, principleId, control) {
  return {
    id: control.id,
    pillar: pillarCode,
    principle: principleId,
    title: control.title,
    provenance: control.provenance,
    severity: control.severity,
    measurability: control.measurability,
    coverage_mode: control.coverage_mode ?? 'complete',
    alias_group: control.alias_group ?? null,
    clouds: [...(control.clouds ?? ['aws', 'azure', 'gcp'])].sort(),
    thresholds: control.thresholds ?? null,
    // Which earlier requirement this one continues, so a renumbering keeps its
    // history instead of reading as a removal beside an unrelated addition.
    //
    // In the fingerprint when set, because declaring a continuation is a change to
    // the requirement set and a bump should follow it. Omitted entirely rather than
    // written as null when unset, so introducing the field did not change a single
    // existing digest and discard every customer's history to add a mechanism none
    // of them had used.
    ...(control.continues != null ? { continues: control.continues } : {}),
    // The reason text is omitted deliberately: it is shown to the user, but
    // rewording an explanation does not change whether the control applies.
    preconditions: (control.applicability?.preconditions ?? []).map((p) => ({
      signal: p.signal,
      operator: p.operator,
      value: p.value,
      outcome: p.outcome,
      scope: p.scope ?? 'segment',
    })),
  };
}

export function fingerprint(controlsDir = CONTROLS_DIR) {
  const entries = [];
  const files = readdirSync(controlsDir)
    .filter((f) => f.endsWith('.yaml'))
    .sort();

  for (const file of files) {
    const doc = yaml.load(readFileSync(join(controlsDir, file), 'utf8'));
    if (!doc?.pillar) continue;
    for (const principle of doc.principles ?? []) {
      for (const control of principle.controls ?? []) {
        entries.push(scoringShape(doc.pillar.code, principle.id, control));
      }
    }
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  const hash = createHash('sha256').update(canonical(entries)).digest('hex');
  return { fingerprint: `sha256:${hash}`, entries };
}

function readRecorded() {
  if (!existsSync(VERSION_PATH)) return null;
  return JSON.parse(readFileSync(VERSION_PATH, 'utf8'));
}

function write(record) {
  writeFileSync(VERSION_PATH, `${JSON.stringify(record, null, 2)}\n`);
}

// Alias-grouped controls express one requirement and score once, so the recorded
// count has to be requirements rather than catalogue entries.
function countAliasCollapse(list) {
  const groups = new Map();
  for (const e of list) {
    if (!e.alias_group) continue;
    groups.set(e.alias_group, (groups.get(e.alias_group) ?? 0) + 1);
  }
  return [...groups.values()].reduce((a, n) => a + (n - 1), 0);
}

// The scoring shape of every control, keyed by id.
//
// Recorded rather than the id list it replaces, for two reasons. It makes the
// fingerprint auditable -- what version 9 covered was previously unanswerable from
// anything but the digest itself -- and it is what a bump diffs against to say
// which fields moved on a control that stayed.
function shapesOf(entries) {
  const shapes = {};
  for (const entry of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
    const { id, ...rest } = entry;
    shapes[id] = rest;
  }
  return shapes;
}

function buildRecord(version, fp, entries) {
  return {
    version,
    fingerprint: fp,
    scored_units: entries.length - countAliasCollapse(entries),
    controls: shapesOf(entries),
  };
}

/**
 * What moved between the recorded catalogue and this one.
 *
 * Four kinds, kept apart because they mean different things to a reader comparing
 * two scores. An addition and a removal change the denominator. A rename changes
 * neither and has to carry a control's history with it. A field moving on a control
 * that stayed -- its severity, its scope, what it is judged against -- changes how
 * the same estate scores without changing what is being asked about.
 */
function describeChange(recorded, entries) {
  const before = recorded?.controls ?? null;
  if (before == null) return null;

  const now = shapesOf(entries);
  const nowIds = new Set(Object.keys(now));
  const beforeIds = new Set(Object.keys(before));

  const appeared = [...nowIds].filter((id) => !beforeIds.has(id)).sort();
  const gone = [...beforeIds].filter((id) => !nowIds.has(id)).sort();

  // Declared continuations first, so a renumbering is one rename rather than an
  // addition beside a removal. Only paired when the earlier id really left: a
  // control naming a predecessor that is still in the catalogue is two live
  // requirements, whatever the field says.
  const renamed = [];
  for (const id of appeared) {
    const from = now[id].continues;
    if (from != null && gone.includes(from)) renamed.push({ from, to: id });
  }
  const renamedTo = new Set(renamed.map((pair) => pair.to));
  const renamedFrom = new Set(renamed.map((pair) => pair.from));

  const changed = [];
  for (const id of [...nowIds].sort()) {
    const was = before[renamedTo.has(id) ? now[id].continues : id];
    if (was == null) continue;
    const fields = Object.keys(now[id])
      .filter((field) => field !== 'continues')
      .filter((field) => canonical(now[id][field]) !== canonical(was[field]))
      .sort();
    if (fields.length > 0) changed.push({ id, fields });
  }

  return {
    added: appeared.filter((id) => !renamedTo.has(id)),
    removed: gone.filter((id) => !renamedFrom.has(id)),
    renamed,
    changed,
  };
}

function readChangelog() {
  if (!existsSync(CHANGELOG_PATH)) return [];
  return JSON.parse(readFileSync(CHANGELOG_PATH, 'utf8'));
}

/**
 * Append the transition to the changelog.
 *
 * Append-only, and never rewritten: an entry describes what a released version did
 * to the one before it, and a run stamped with that version is read against it
 * years later. Editing history here would silently restate what a customer's
 * finished assessment was of.
 *
 * Which is why an entry that already describes its version is not replaced. That
 * used to be a filter-and-push, and it was reachable without anybody meaning it:
 * the path that backfills control shapes calls this for the *current* version with
 * nothing to describe, so a version.json that lost its shapes would downgrade a
 * described entry to `describes: false` on the next plain `npm run
 * catalogue:version` — and every comparison across that version would silently
 * become a refusal. An undescribed entry can still be filled in, since that adds
 * knowledge rather than discarding it.
 */
function recordTransition(entry) {
  const log = readChangelog();
  const existing = log.find((one) => String(one.version) === String(entry.version));
  if (existing?.describes === true) {
    if (existing.fingerprint !== entry.fingerprint) {
      console.error(
        `The changelog already describes catalogue version ${entry.version}, at a different ` +
          'fingerprint. Refusing to rewrite it: bump to a new version rather than restating a ' +
          'released one, since runs already stamped with this version are read against that entry.'
      );
      process.exit(1);
    }
    return;
  }

  const kept = log.filter((one) => String(one.version) !== String(entry.version));
  kept.push(entry);
  kept.sort((a, b) => Number(a.version) - Number(b.version));
  writeFileSync(CHANGELOG_PATH, `${JSON.stringify(kept, null, 2)}\n`);
}

function transition(version, fp, entries, change) {
  return {
    version,
    fingerprint: fp,
    recordedAt: new Date().toISOString().slice(0, 10),
    scored_units: entries.length - countAliasCollapse(entries),
    ...(change == null ? { describes: false } : { describes: true, ...change }),
  };
}

/**
 * Pairs a removal with an addition that might be the same requirement renumbered.
 *
 * A hint, and only ever a hint. It exists so the author is answering a question
 * rather than dismissing a warning -- "is DG-01-04 now DG-02-01?" is answerable in
 * seconds, whereas "confirm nothing here is a rename" invites a reflex. Nothing
 * downstream reads this: pairing on it would be the inference ADR 0044 refuses,
 * because a wrong guess merges two requirements' histories and the merge is
 * indistinguishable from a fact once the two catalogues it compared are gone.
 *
 * Ranked by how much the two have in common, since a shared title is a much stronger
 * suggestion than a shared pillar, and an author reading a long list reads the top of
 * it. Requirements with nothing in common are not offered at all -- an exhaustive
 * cross product of every removal against every addition would bury the one pair worth
 * looking at.
 */
function renumberingCandidates(before, now, change) {
  const grounds = (was, is) => {
    if (was.title === is.title) return { rank: 0, why: 'the same title' };
    if (was.pillar === is.pillar && was.principle === is.principle) {
      return { rank: 1, why: 'the same pillar and principle' };
    }
    if (was.pillar === is.pillar) return { rank: 2, why: 'the same pillar' };
    return null;
  };

  const pairs = [];
  for (const from of change.removed) {
    for (const to of change.added) {
      const found = grounds(before[from], now[to]);
      if (found != null) pairs.push({ from, to, ...found });
    }
  }
  return pairs.sort((a, b) => a.rank - b.rank || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

// The ids the author affirmed renumber nothing, or null when the flag was not passed.
// An empty list is not the same as no flag: `--unrelated` with nothing after it is a
// mistake, and reading it as "there are no unrelated additions" would let the gate
// pass a version whose additions were never considered at all.
function affirmedUnrelated() {
  const at = process.argv.indexOf('--unrelated');
  if (at === -1) return null;
  const raw = process.argv[at + 1];
  if (raw == null || raw.startsWith('--')) return [];
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * Refuse a bump that exchanges scope until the author says the exchange is real.
 *
 * Only when a version both adds and removes -- an addition on its own cannot be a
 * renumbering of anything, and a removal on its own has nothing to have become. Both
 * lists have already had declared continuations taken out of them, so what is left is
 * exactly the set this cannot account for.
 */
function refuseUnaffirmedExchange(change, before, now) {
  const affirmed = affirmedUnrelated();
  const exchanging = change != null && change.added.length > 0 && change.removed.length > 0;

  if (!exchanging) {
    if (affirmed == null) return;
    console.error(
      'Nothing in this version both adds and removes a requirement, so there is nothing for\n' +
        '`--unrelated` to affirm. Refusing rather than ignoring it: a flag that is accepted where\n' +
        'it means nothing is a flag that will still be there when it means something.'
    );
    process.exit(1);
  }

  const missing = change.added.filter((id) => !(affirmed ?? []).includes(id));
  const unknown = (affirmed ?? []).filter((id) => !change.added.includes(id));
  if (affirmed != null && missing.length === 0 && unknown.length === 0) return;

  console.error(
    `This version removes ${String(change.removed.length)} requirement(s) and adds ` +
      `${String(change.added.length)}, and none of the additions declares a \`continues:\`.\n` +
      'That is either a real exchange of scope or a renumbering whose declaration was forgotten,\n' +
      'and the two leave identical catalogues behind. Refusing to guess: recording a renumbering\n' +
      'as a removal beside an addition tells every later screen that scope left and other scope\n' +
      'arrived, which is a plausible-looking record of something that did not happen.\n'
  );
  console.error(`  removed:  ${change.removed.join(', ')}`);
  console.error(`  added:    ${change.added.join(', ')}\n`);

  const candidates = renumberingCandidates(before, now, change);
  if (candidates.length > 0) {
    console.error('Pairs worth a look, on shape alone:\n');
    for (const pair of candidates) console.error(`  ${pair.from} -> ${pair.to}, ${pair.why}`);
    console.error('');
  } else {
    console.error(
      'Nothing here looks like a pair on shape alone, which is not evidence that none is —\n' +
        'a renumbering that also rewrote the requirement has nothing left to notice it by.\n'
    );
  }

  if (unknown.length > 0) {
    console.error(
      `\`--unrelated\` names ${unknown.join(', ')}, which this version does not add. Either the\n` +
        'catalogue moved since that command was written, or the id is a typo.\n'
    );
  }
  if (affirmed != null && missing.length > 0) {
    console.error(
      `\`--unrelated\` does not account for ${missing.join(', ')}. Every addition has to be named,\n` +
        'so affirming one release cannot quietly affirm the next.\n'
    );
  }

  console.error(
    'If any of these is a renumbering, declare it on the arriving requirement — `continues: <old id>`\n' +
      '— and bump again. That is what carries the requirement\'s history forward, and it is recorded in\n' +
      'the catalogue rather than in a command nobody can read afterwards.\n\n' +
      'If the exchange is real, say so by naming what arrived:\n\n' +
      `  npm run catalogue:bump -- --unrelated ${change.added.join(',')}`
  );
  process.exit(1);
}

function summarise(change) {
  if (change == null) return ['  the previous record did not hold control shapes, so what moved is not described.'];
  const lines = [];
  if (change.added.length) lines.push(`  added:    ${change.added.join(', ')}`);
  if (change.removed.length) lines.push(`  removed:  ${change.removed.join(', ')}`);
  for (const pair of change.renamed) lines.push(`  renamed:  ${pair.from} -> ${pair.to}`);
  for (const one of change.changed) lines.push(`  changed:  ${one.id} (${one.fields.join(', ')})`);
  if (lines.length === 0) lines.push('  nothing in the scoring shape moved, so the fingerprint changed for another reason.');
  return lines;
}

const mode = process.argv.includes('--bump') ? 'bump' : process.argv.includes('--check') ? 'check' : 'report';

const { fingerprint: current, entries } = fingerprint();
const recorded = readRecorded();

if (!recorded) {
  if (mode === 'check') {
    console.error('No version.json recorded. Run `npm run catalogue:bump` to establish version 1.');
    process.exit(1);
  }
  write(buildRecord(1, current, entries));
  recordTransition(transition(1, current, entries, null));
  console.log(`Established catalogue version 1 (${current}).`);
  process.exit(0);
}

if (recorded.fingerprint === current) {
  // The catalogue has not moved, but the record may predate control shapes, and without
  // them the next bump cannot say which fields changed. Filling them in is not a version
  // change and must not read as one: the fingerprint is the same, so every scan already
  // recorded stays comparable. `--check` reports it and passes, since nothing about the
  // requirement set is unrecorded.
  if (recorded.controls == null) {
    if (mode === 'check') {
      console.log(
        `Catalogue version ${recorded.version} (${current}) -- unchanged, and the record predates ` +
          'control shapes. Run `npm run catalogue:version` to fill them in.'
      );
      process.exit(0);
    }
    write(buildRecord(recorded.version, current, entries));
    recordTransition(transition(recorded.version, current, entries, null));
    console.log(
      `Catalogue version ${recorded.version} (${current}) -- unchanged. Recorded the shape of ` +
        `${String(entries.length)} controls, so the next bump can say what moved.`
    );
    process.exit(0);
  }
  console.log(`Catalogue version ${recorded.version} (${current}) -- unchanged.`);
  process.exit(0);
}

const change = describeChange(recorded, entries);

if (mode === 'bump') {
  refuseUnaffirmedExchange(change, recorded.controls ?? {}, shapesOf(entries));
  const version = recorded.version + 1;
  write(buildRecord(version, current, entries));
  recordTransition(transition(version, current, entries, change));
  console.log(`Catalogue version ${recorded.version} -> ${version}.`);
  for (const line of summarise(change)) console.log(line);
  console.log(
    '\nRecorded in changelog.json, which is what lets the app compare a run taken before\n' +
      'this version with one taken after and attribute the difference.'
  );
  process.exit(0);
}

console.error(`The catalogue changed but version ${recorded.version} was not bumped.\n`);
for (const line of summarise(change)) console.error(line);
console.error(`\n  recorded: ${recorded.fingerprint}`);
console.error(`  current:  ${current}`);
console.error(
  '\nIf the change is intended, run `npm run catalogue:bump`. The bump records what moved\n' +
    'in changelog.json, so a scan taken before it can still be compared with one taken\n' +
    'after, with the part of the difference that is the catalogue named separately.'
);

// Said here as well as at the bump, because this is where the author first reads what
// moved, and a renumbering is cheapest to declare before the version is written rather
// than after the bump has refused it.
if (change != null && change.added.length > 0 && change.removed.length > 0) {
  const candidates = renumberingCandidates(recorded.controls ?? {}, shapesOf(entries), change);
  console.error(
    '\nThis version both adds and removes requirements, and none of the additions declares a\n' +
      '`continues:`. If any of them renumbers one of the removals, declare it there first — the\n' +
      'bump will ask.'
  );
  if (candidates.length > 0) {
    console.error('');
    for (const pair of candidates) console.error(`  ${pair.from} -> ${pair.to}, ${pair.why}`);
  }
}
process.exit(1);
