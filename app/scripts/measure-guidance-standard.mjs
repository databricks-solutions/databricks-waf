// What the guidance corpus already satisfies, so a rubric rule is adopted against a reading.
//
//   cd app && node scripts/measure-guidance-standard.mjs [--record]
//
// Offline and cheap: it reads `config/guidance/*.yaml` and `config/controls/*.yaml` and nothing else.
// `--record` writes `scripts/recordings/guidance-standard.json`, which `docs/plan/` quotes and
// `check:figure-tables` then holds against this reading.
//
// ## Why this exists
//
// `GAP-029` asks a product owner to approve a guidance quality standard, and `100a` is the row for it. The
// standard's prose already exists — `docs/design/guidance-authoring.md` has said what good looks like since
// row 10 — so the row's real question is narrower and mechanical: **which of its sentences is a check, and
// which is a judgement a reviewer has to make?**
//
// That question cannot be answered by reading the rubric. A rule is only worth enforcing if it fires on
// content that is wrong and stays quiet on content that is right, and the only way to know which it does is
// to run it over the 63 entries somebody has already written and reviewed. `AGENTS.md` puts it as a rule
// about premises: measure before designing the remedy. The near-duplicate bar in `check-guidance.mjs` is the
// worked example — 0.50, set against a corpus whose closest pair scored 0.32, so the headroom is a measured
// fact rather than a hopeful round number.
//
// ## What this measured, and what it cost the plan that proposed it
//
// Four candidate rules were named in `38c`'s replan. Two of them do not survive this reading, and one of the
// two was the one the replan called cheapest and most valuable:
//
// **`good` may not reword the control title — refuted, twice over.** A signal that says what the requirement
// is about shares the requirement's words, necessarily: the highest-scoring signal in the corpus is
// `PE-04-01`'s at 75%, and "Test data matches production in volume, or in a known and stated ratio" is a
// concrete signal under the title "Test on data representative of production data". The entry-to-entry
// near-duplicate check works because two requirements should not read alike; an entry and *its own title*
// should.
//
// The second reason is arithmetic and it is the decisive one. The metric divides by the smaller of the two
// word sets, and a control title is short: **37 of the 184 titles reduce to three significant words or
// fewer**, with a median of four. "Use caching" is two, so a signal sharing one word with it scores 50% no
// matter what else the signal says. The number would therefore be measuring how briefly a title was written,
// which is not a property of the guidance at all.
//
// **`depends_on` must name control ids that exist — not applicable.** Nothing in the corpus names a control
// id anywhere, in any field, in any of the 63 entries. `depends_on` holds decision-factor sentences, which
// is what the schema asks of it. The rule was designed for a field shape this project does not have.
//
// **`path` needs more than one step — already enforced**, by the schema, at `minItems: 2`.
//
// **`verify` must name something a reader can do — already true, and its stronger form is wrong.** Every one
// of the 191 steps carries a `where`, because the schema requires it. The stronger reading — that a step be
// runnable, `sql` or `cli` rather than `ui` or `by-hand` — would fail 7 of 63 entries whose requirements are
// genuinely answered by looking at a console page, which is not a defect in them.
//
// So the finding is that the standard is very nearly enforced already, and by the schema rather than by
// `check-guidance.mjs`. This script exists to keep that claim checkable, because the next person to propose
// a rubric rule will otherwise propose one of the refuted ones again.
//
// ## The one gap it found
//
// `expect` is optional on a check. The schema's own description of the field says "A location with no
// expectation is half a check", and all 191 steps carry one — so the rule costs nothing today, closes the
// door behind the corpus, and is asserted by the field's documentation while being enforced by nothing.
// That is the same shape as the citation rule, which also failed nothing on the day it landed.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const RECORDING = join(HERE, 'recordings/guidance-standard.json');

/*
 * Stop words and a word-overlap metric, matched to `check-guidance.mjs`'s.
 *
 * The point of reusing the metric rather than inventing one is that the refutation below has to be about the
 * rule and not about the arithmetic. If a `good`-against-title rule were ever adopted it would be
 * implemented with the function the near-duplicate bar already uses, so the number that refutes it has to
 * come from that function too.
 */
const STOP = new Set(
  ('a an and are as at be by for from has have in is it its not of on or that the their they this to with' +
    ' you your which where when what who whom whose')
    .split(' '),
);

const words = (text) =>
  String(text)
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((word) => word.length > 2 && !STOP.has(word)) ?? [];

const overlap = (one, other) => {
  const left = new Set(words(one));
  const right = new Set(words(other));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
};

function catalogue() {
  const titles = new Map();
  const dir = join(APP, 'config/controls');
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.yaml'))) {
    const doc = yaml.load(readFileSync(join(dir, file), 'utf8'));
    for (const principle of doc?.principles ?? []) {
      for (const control of principle?.controls ?? []) titles.set(control.id, control.title);
    }
  }
  return titles;
}

function corpus() {
  const authored = [];
  const draft = [];
  const dir = join(APP, 'config/guidance');
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.yaml'))) {
    const doc = yaml.load(readFileSync(join(dir, file), 'utf8'));
    for (const [id, entry] of Object.entries(doc?.entries ?? {})) {
      (entry?.status === 'authored' ? authored : draft).push({ id, entry, file });
    }
  }
  return { authored, draft };
}

function spread(values) {
  const sorted = [...values].sort((one, other) => one - other);
  return {
    min: sorted[0] ?? 0,
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function measure() {
  const titles = catalogue();
  const { authored, draft } = corpus();

  // Candidate: `good` may not reword the control title.
  const signals = [];
  for (const { id, entry } of authored) {
    const title = titles.get(id) ?? '';
    for (const signal of entry.good ?? []) signals.push({ id, score: overlap(signal, title), signal });
  }
  signals.sort((one, other) => other.score - one.score);

  /*
   * How short a control title is, which is what that candidate would really have been measuring.
   *
   * Taken over the whole catalogue rather than the authored subset, because the rule would have applied to
   * all 184 as they were written and the short titles are not concentrated in the part already done.
   */
  const titleWords = [...titles.values()].map((title) => new Set(words(title)).size);

  // Candidate: `verify` names something a reader can do.
  const how = {};
  let steps = 0;
  let missingExpect = 0;
  let missingWhere = 0;
  for (const { entry } of authored) {
    for (const step of entry.verify ?? []) {
      steps += 1;
      how[step.how] = (how[step.how] ?? 0) + 1;
      if (step.expect == null) missingExpect += 1;
      if (step.where == null) missingWhere += 1;
    }
  }
  const runnable = authored.filter(({ entry }) =>
    (entry.verify ?? []).some((step) => step.how === 'sql' || step.how === 'cli'),
  );

  // Candidate: `depends_on` names control ids that exist. Asked of every field, not just that one, because
  // the question is whether this corpus references controls at all.
  const naming = authored.filter(({ entry }) => /[A-Z]{2,3}-\d{2}-\d{2}/.test(JSON.stringify(entry)));

  const advised = authored.filter(({ entry }) => entry.advice != null);

  return {
    takenAt: new Date().toISOString().slice(0, 10),
    corpus: {
      authored: authored.length,
      draft: draft.length,
      requirements: authored.length + draft.length,
      draftsCarryingAVerifyBlock: draft.filter(({ entry }) => (entry.verify ?? []).length > 0).length,
    },
    goodAgainstItsOwnTitle: {
      signals: signals.length,
      highest: Number(signals[0]?.score.toFixed(3) ?? 0),
      highestAt: signals[0]?.id ?? null,
      atOrAbove50: signals.filter((one) => one.score >= 0.5).length,
      atOrAbove40: signals.filter((one) => one.score >= 0.4).length,
      titlesOfThreeWordsOrFewer: titleWords.filter((count) => count <= 3).length,
      titlesMeasured: titleWords.length,
      medianTitleWords: spread(titleWords).median,
      verdict:
        'refuted: a signal about the requirement shares its words, and the metric divides by the shorter set ' +
        'so a two-word title scores 50% on one shared word',
    },
    verify: {
      steps,
      how,
      missingExpect,
      missingWhere,
      entriesWithARunnableStep: runnable.length,
      entriesWithNone: authored.length - runnable.length,
      whereTheyHaveNone: authored
        .filter((one) => !runnable.includes(one))
        .map(({ id }) => id)
        .sort(),
    },
    examples: {
      missingStrong: authored.filter(({ entry }) => entry.examples?.strong == null).length,
      missingPartial: authored.filter(({ entry }) => entry.examples?.partial == null).length,
      missingWeak: authored.filter(({ entry }) => entry.examples?.weak == null).length,
    },
    lists: {
      good: spread(authored.map(({ entry }) => (entry.good ?? []).length)),
      pitfalls: spread(authored.map(({ entry }) => (entry.pitfalls ?? []).length)),
      references: spread(authored.map(({ entry }) => (entry.references ?? []).length)),
      verify: spread(authored.map(({ entry }) => (entry.verify ?? []).length)),
    },
    controlIdsNamedInProse: {
      entries: naming.length,
      verdict: 'not applicable: depends_on holds decision factors, and no field names a control',
    },
    advice: {
      entries: advised.length,
      pathSteps: spread(advised.map(({ entry }) => (entry.advice?.path ?? []).length)),
    },
  };
}

function main() {
  const reading = measure();
  const record = process.argv.includes('--record');

  console.log(`Guidance standard, measured ${reading.takenAt}`);
  console.log(
    `  ${reading.corpus.authored} authored of ${reading.corpus.requirements} requirements, ` +
      `${reading.corpus.draft} draft and ${reading.corpus.draftsCarryingAVerifyBlock} of those carrying a verify block`,
  );
  console.log('');
  console.log('  a `good` signal against its own control title');
  console.log(
    `    highest ${Math.round(reading.goodAgainstItsOwnTitle.highest * 100)}% at ${reading.goodAgainstItsOwnTitle.highestAt}, ` +
      `${reading.goodAgainstItsOwnTitle.atOrAbove50} of ${reading.goodAgainstItsOwnTitle.signals} signals at or above 50%`,
  );
  console.log(
    `    ${reading.goodAgainstItsOwnTitle.titlesOfThreeWordsOrFewer} of ${reading.goodAgainstItsOwnTitle.titlesMeasured} titles ` +
      `reduce to 3 significant words or fewer, median ${reading.goodAgainstItsOwnTitle.medianTitleWords}`,
  );
  console.log(`    ${reading.goodAgainstItsOwnTitle.verdict}`);
  console.log('');
  console.log(`  verify: ${reading.verify.steps} steps, ${JSON.stringify(reading.verify.how)}`);
  console.log(
    `    missing expect ${reading.verify.missingExpect}, missing where ${reading.verify.missingWhere} — ` +
      `so expect is the gap and where is already required`,
  );
  console.log(
    `    ${reading.verify.entriesWithARunnableStep} entries have a sql or cli step; ` +
      `${reading.verify.entriesWithNone} have none, which a runnable-step rule would fail`,
  );
  console.log('');
  console.log(`  control ids named anywhere in an entry: ${reading.controlIdsNamedInProse.entries}`);
  console.log(`    ${reading.controlIdsNamedInProse.verdict}`);
  console.log('');
  console.log('  list lengths, as floors a rule could take');
  for (const [field, seen] of Object.entries(reading.lists)) {
    console.log(`    ${field.padEnd(11)} min ${seen.min}, median ${seen.median}, max ${seen.max}`);
  }

  if (record) {
    writeFileSync(RECORDING, `${JSON.stringify(reading, null, 2)}\n`);
    console.log(`\nRecorded to ${RECORDING.replace(`${APP}/`, '')}`);
  } else {
    console.log('\nNot recorded. Pass --record to write the recording the plan quotes.');
  }
}

if (process.argv[1] != null && import.meta.filename === process.argv[1]) {
  main();
}
