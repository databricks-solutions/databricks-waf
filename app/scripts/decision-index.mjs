#!/usr/bin/env node
/**
 * Writes the index over `docs/decisions/`, or checks that the committed one is current.
 *
 * Sixty decisions in sixty files is the right shape for editing — one decision per file, appended to
 * rather than rewritten — and the wrong shape for finding one. Answering "which decision covers
 * retention" meant grepping sixty long filenames, and the cost of that is not the seconds: it is that
 * a decision nobody can find gets made a second time, differently.
 *
 * Generated rather than written, because an index maintained by hand is the first thing to go stale,
 * and a stale index is worse than none — it answers confidently with a list that is missing the
 * decision you needed. `--check` is what makes it true: adding a file without regenerating fails
 * `npm run verify`.
 *
 * The parser reads three shapes, because the repository has three. That is drift, and the index
 * reports it rather than smoothing it over: the count of each shape is in the file, so the choice to
 * normalise them stays visible instead of being hidden behind a generator that copes.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DECISIONS = join(HERE, '..', '..', 'docs', 'decisions');
const INDEX = join(DECISIONS, 'README.md');

/** The statuses a decision may carry. Anything else is a typo, and the parse says so. */
const STATUSES = ['accepted', 'proposed', 'rejected', 'deprecated', 'superseded'];

/**
 * One decision's front matter, read from whichever of the three shapes it uses.
 *
 * The number comes from the filename rather than the heading, because the heading is exactly what
 * has drifted — twenty-four use `0001 — `, twelve use `15. `, and nine carry no number at all — while
 * `NNNN-slug.md` has held for all sixty. Deriving identity from the one stable thing means the index
 * is complete even where the prose is inconsistent.
 */
function read(file) {
  const numbered = /^(\d{4})-(.+)\.md$/.exec(file);
  if (numbered == null) return { file, problem: 'filename is not NNNN-slug.md' };

  const number = Number(numbered[1]);
  const lines = readFileSync(join(DECISIONS, file), 'utf8').split('\n');

  const h1 = lines.find((line) => line.startsWith('# '));
  if (h1 == null) return { file, number, problem: 'no level-one heading' };

  // Three prefixes to strip, and the em dash matters: `0001 — Outbound licence` and
  // `15. Scope has three reaches` are the same field spelled two ways.
  const title = h1
    .replace(/^# /, '')
    .replace(/^\d{4}\s+—\s+/, '')
    .replace(/^\d{1,2}\.\s+/, '')
    .trim();

  const bare = h1.replace(/^# /, '');
  const heading = /^\d{4}\s+—\s+/.test(bare)
    ? 'four digits and an em dash'
    : /^\d{1,2}\.\s+/.test(bare)
      ? 'a number and a full stop'
      : 'no number';

  // Three spellings of the same field: `- Date: x`, bare `Date: x`, and nothing.
  const date =
    lines.find((line) => /^-\s*Date:/.test(line))?.replace(/^-\s*Date:\s*/, '').trim() ??
    lines.find((line) => /^Date:/.test(line))?.replace(/^Date:\s*/, '').trim() ??
    '';

  // And three of status, which is the field that matters most and drifted worst. A list item, a bare
  // line, or prose under a `## Status` heading where the first non-blank line is the claim and
  // everything after it is the argument for the claim.
  let stated = '';
  let matter = '';
  const listed = lines.find((line) => /^-\s*Status:/.test(line));
  const plain = lines.find((line) => /^Status:/.test(line));
  if (listed != null) {
    stated = listed.replace(/^-\s*Status:\s*/, '').trim();
    matter = 'a list under the heading';
  } else if (plain != null) {
    stated = plain.replace(/^Status:\s*/, '').trim();
    matter = 'bare lines under the heading';
  } else {
    const at = lines.findIndex((line) => /^##\s+Status\s*$/i.test(line));
    if (at !== -1) {
      // The whole first paragraph, rejoined. Taking one line would cut a qualification in half at
      // whatever column the author happened to wrap at, and a half-sentence in an index reads as
      // though the decision itself trails off.
      const after = lines.slice(at + 1);
      const start = after.findIndex((line) => line.trim() !== '');
      const rest = start === -1 ? [] : after.slice(start);
      const end = rest.findIndex((line) => line.trim() === '');
      stated = (end === -1 ? rest : rest.slice(0, end)).join(' ').replace(/\s+/g, ' ').trim();
      matter = 'prose under a Status heading';
    }
  }

  const word = STATUSES.find((candidate) => stated.toLowerCase().startsWith(candidate)) ?? '';
  // A qualification is what narrows the status *in the same sentence*. `Accepted, with a known gap`
  // qualifies; `Accepted. Supersedes the scoping in estate-scope.ts` does not — the second sentence is
  // the argument, and every one of these files has pages of that. Splitting on the full stop is what
  // keeps the dagger meaning "this decision does not hold as written" rather than "this file has prose
  // in it", which would be all sixty.
  const trailing = word === '' ? '' : stated.slice(word.length);
  // `superseded` is the exception: what replaced it is the only thing a reader wants and it is written
  // as a continuation rather than a qualification — `Superseded by ADR 0031`, no comma. Reading it the
  // strict way would leave the index saying a decision no longer holds without saying what replaced it.
  const punctuated = /^\s*[,;—-]/.test(trailing);
  const continues = word === 'superseded' || punctuated;
  const qualifier = continues
    ? trailing
        .replace(/^[\s,;—-]+/, '')
        .split(/\.(?:\s|$)/)[0]
        .trim()
    : '';
  // How the source joined the two, kept so the index does not write `superseded, by ADR 0031`.
  const separator = punctuated ? ', ' : ' ';

  const closes = lines
    .find((line) => /^-\s*Closes:/.test(line))
    ?.replace(/^-\s*Closes:\s*/, '')
    .trim();

  return {
    file,
    number,
    title,
    date,
    heading,
    matter,
    status: word,
    qualifier,
    separator,
    closes: closes ?? '',
    problem: word === '' ? `no status found (read "${stated.slice(0, 40)}")` : '',
  };
}

/** Every GAP the text mentions, so the index can answer "which decision closed GAP-011". */
function gaps(file) {
  const contents = readFileSync(join(DECISIONS, file), 'utf8');
  return [...new Set(contents.match(/GAP-\d{3}/g) ?? [])].sort();
}

const files = readdirSync(DECISIONS)
  .filter((name) => name.endsWith('.md') && name !== 'README.md')
  .sort();

const entries = files.map((file) => ({ ...read(file), gaps: gaps(file) }));
const problems = entries.filter((entry) => entry.problem !== '');

/** How many decisions use each spelling of a field, so the drift is a number rather than an impression. */
function tally(pick) {
  const counted = new Map();
  for (const entry of entries) counted.set(pick(entry), (counted.get(pick(entry)) ?? 0) + 1);
  return [...counted.entries()].sort(([, a], [, b]) => b - a);
}

const headings = tally((entry) => entry.heading);
const matters = tally((entry) => entry.matter);

const escape = (value) => value.replace(/\|/g, '\\|');

/** The table, widest column first so a reader scanning for a subject does not read past the number. */
function table() {
  const rows = entries.map((entry) => {
    const status =
      entry.qualifier === '' ? entry.status : `${entry.status} †`;
    const subject = `[${escape(entry.title)}](${entry.file})`;
    return `| ${String(entry.number).padStart(4, '0')} | ${subject} | ${entry.date} | ${status} |`;
  });
  return [
    '| No. | Decision | Date | Status |',
    '| ---: | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** Qualified statuses, spelled out, because the dagger in the table is a pointer rather than a fact. */
function qualified() {
  const rows = entries.filter((entry) => entry.qualifier !== '');
  if (rows.length === 0) return [];
  return [
    '## † Statuses that do not stand alone',
    'A bare status in the table means the decision holds as written, across whatever it is about. These\n' +
      'do not: each carries an unresolved condition, a limit on what it covers, or the decision that\n' +
      'replaced it. Read the qualification before citing one of these as settled.',
    rows
      .map(
        (entry) =>
          `- [${String(entry.number).padStart(4, '0')} — ${escape(entry.title)}](${entry.file}) — ` +
          `${entry.status}${entry.separator}${entry.qualifier}`
      )
      .join('\n'),
  ];
}

/** Which decision speaks to which audit gap, for the reader arriving from the gap register. */
function byGap() {
  const map = new Map();
  for (const entry of entries) {
    for (const gap of entry.gaps) {
      if (!map.has(gap)) map.set(gap, []);
      map.get(gap).push(entry);
    }
  }
  if (map.size === 0) return [];
  const rows = [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([gap, list]) => {
      const links = list
        .sort((a, b) => a.number - b.number)
        .map((entry) => {
          const number = String(entry.number).padStart(4, '0');
          // Bold where the decision says it closes this gap. Four do, and they are the ones a reader
          // tracing a gap wants first — but the others are not noise: `0028` is where the audit was
          // committed, so it names six gaps and is a real place each was reasoned about.
          const link = `[${number}](${entry.file})`;
          return entry.closes.includes(gap) ? `**${link}**` : link;
        })
        .join(', ');
      return `| ${gap} | ${links} |`;
    });
  return [
    '## Which decisions mention which gap',
    'Every `GAP-NNN` named anywhere in a decision, not only the ones a decision closes — a reader\n' +
      'tracing a gap wants every place it was reasoned about. **Bold** is a decision that declares it\n' +
      'closes that gap; `docs/audit/13-gap-register.csv` is what actually decides that, and only four\n' +
      'decisions make the claim in their own front matter.',
    ['| Gap | Decisions |', '| --- | --- |', ...rows].join('\n'),
  ];
}

const counts = STATUSES.map((status) => [status, entries.filter((entry) => entry.status === status).length])
  .filter(([, count]) => count > 0)
  .map(([status, count]) => `${count} ${status}`)
  .join(', ');

// Blocks, joined by a blank line. Lines within a block are already wrapped by hand, so a paragraph
// that has to read as one paragraph is one string rather than several.
const blocks = [
  '# Decisions',
  'Generated by `npm run decisions:index`. `npm run verify` fails if it is out of date, so a new\n' +
    'decision cannot be committed without appearing here.',
  'One decision per file is the right shape for writing and the wrong one for finding, which is what\n' +
    'this index is for: a decision nobody can find gets made a second time, differently.',
  `**${entries.length} decisions:** ${counts}.`,
  table(),
  ...qualified(),
  ...byGap(),
  '## The front matter has drifted, and this index does not hide it',
  'Two things drifted independently, which is why neither is visible from reading any single file.',
  `**Where the number lives:** ${headings.map(([shape, count]) => `${count} with ${shape}`).join(', ')}.\n` +
    "The index takes the number from the filename rather than the heading, because the filename is the\n" +
    `one thing all ${entries.length} agree on — so the numbering here is right even where a heading is not.`,
  `**Where the status lives:** ${matters.map(([shape, count]) => `${count} in ${shape}`).join(', ')}.\n` +
    'The generator reads all of them.',
  'Reported rather than smoothed over. Normalising sixty files is a change to the repository that\n' +
    'nobody has decided to make, and a generator that quietly coped would have made it look as though\n' +
    'the question had been settled.',
];

const rendered = `${blocks.join('\n\n')}\n`;

if (problems.length > 0) {
  process.stderr.write('The decisions cannot be indexed.\n\n');
  for (const entry of problems) {
    process.stderr.write(`  - ${entry.file}: ${entry.problem}\n`);
  }
  process.stderr.write('\n');
  process.exit(1);
}

if (process.argv.includes('--check')) {
  const committed = (() => {
    try {
      return readFileSync(INDEX, 'utf8');
    } catch {
      return null;
    }
  })();
  if (committed === null) {
    process.stderr.write(
      'docs/decisions/README.md does not exist. Run `npm run decisions:index`.\n'
    );
    process.exit(1);
  }
  if (committed !== rendered) {
    process.stderr.write(
      'docs/decisions/README.md is out of date.\n\n' +
        '  A decision was added, retitled, or restatused without regenerating the index. An index\n' +
        '  that is confidently missing the decision you needed is worse than no index at all.\n\n' +
        '  Run `npm run decisions:index` and commit the result.\n'
    );
    process.exit(1);
  }
  process.stdout.write(`docs/decisions/README.md is current (${entries.length} decisions).\n`);
} else {
  writeFileSync(INDEX, rendered);
  process.stdout.write(`Wrote docs/decisions/README.md (${entries.length} decisions).\n`);
}
