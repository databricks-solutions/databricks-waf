#!/usr/bin/env node
// A figure table in a plan document agrees with the recording it names.
//
// Every number this plan uses to decide what to build was transcribed by hand out of a JSON recording
// and into prose, and nothing compared the two afterwards. That is not hypothetical twice over. The
// runtime baseline table had drifted nine statements, one arity and a threefold duration away from the
// recording it named while reading exactly like a measurement — which is what `check:baseline-table`
// was written for, and it holds one file. And the review of `47` found three figures in one table
// wrong on arrival, each right about the arithmetic and wrong about which population it described.
//
// So the failure this catches is not a typo. It is a figure that is true of something other than what
// the sentence around it claims, which is the one kind of wrong number that reads as right.
//
// A table opts in by declaring, immediately above itself, the recording and the field behind each
// figure:
//
//     <!-- figures: ../../app/server/collect/sql/runtime-baseline/labs-job-audit-inputs.json
//     A: underutilised workers
//       12 = probes[rule A].rows[0].and_no_meaningful_swap_or_wait
//       11.6% = probes[utilisation distributions].rows[0].pairs_rule_b_would_consider of run_cluster_pairs
//     -->
//
// A table may name more than one recording, because `41b`'s does: it holds a column per estate, and the
// whole point of that table is the comparison. Each is given a name the paths then start with.
//
//     <!-- figures:
//       fieldeng = ../../app/server/collect/sql/runtime-baseline/large-estate-job-audit-inputs.json
//       labs = ../../app/server/collect/sql/runtime-baseline/labs-job-audit-inputs.json
//     Job runs by compute kind
//       13,732 = fieldeng probes[what kind of compute].rows[1].runs
//       44 = labs probes[what kind of compute].rows[0].runs
//     -->
//
// A table that declares nothing is not checked, rather than guessed at. Parsing every number in every
// sentence would need either a language model or a lie: prose figures carry their denominator in words
// — "of the 689 the worker join reaches" — and a table is a structure a check can read.
//
// What a declaration pins is both directions. The recording's value has to match the number, and the
// number has to actually appear in the row it is declared under: a declaration that drifts off its own
// figure would otherwise pass while checking nothing, which is the failure mode of every check that
// only looks one way.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

const files = execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter((file) => file !== '' && !file.startsWith('docs/design/reference/'));

const failures = [];
let figures = 0;
let tables = 0;

for (const file of files) {
  const text = readFileSync(path.join(ROOT, file), 'utf8');

  for (const block of declarationsIn(text)) {
    tables += 1;
    const recordings = new Map();
    let unreadable = false;

    for (const [name, where] of block.recordings) {
      const recording = readRecording(path.resolve(path.dirname(path.join(ROOT, file)), where));
      if (recording.error != null) {
        failures.push(`${file}:${String(block.line)}  ${where}\n    ${recording.error}`);
        unreadable = true;
        continue;
      }
      recordings.set(name, recording.value);
    }

    if (unreadable) continue;

    for (const claim of block.claims) {
      figures += 1;

      // A prefix, so a row label can be named by its first few words rather than transcribed — and
      // unique, for the same reason the probe selector below is: a key matching two rows would check
      // one of them by accident and report the other as fine.
      const matched = [...block.rows.keys()].filter((label) => label.startsWith(claim.row));

      if (matched.length === 0) {
        failures.push(
          `${file}:${String(block.line)}  ${claim.written} under "${claim.row}"\n` +
            `    no row of the table below starts with "${claim.row}", so this figure is declared about nothing`
        );
        continue;
      }

      if (matched.length > 1) {
        failures.push(
          `${file}:${String(block.line)}  ${claim.written} under "${claim.row}"\n` +
            `    "${claim.row}" starts ${String(matched.length)} rows, so which one it is about is luck:\n` +
            matched.map((label) => `      ${label}`).join('\n')
        );
        continue;
      }

      const row = block.rows.get(matched[0]);

      // Both directions. The value has to be the recording's, and the figure has to be the row's.
      if (!appearsIn(row, claim.written)) {
        failures.push(
          `${file}:${String(block.line)}  ${claim.written} under "${claim.row}"\n` +
            `    that row does not contain ${claim.written}, so this declaration has drifted off its own figure`
        );
        continue;
      }

      const recording = recordings.get(claim.recording);
      if (recording == null) {
        failures.push(
          `${file}:${String(block.line)}  ${claim.written}\n` +
            `    names the recording "${claim.recording}", which this table does not declare` +
            ` — it declares ${[...recordings.keys()].join(', ')}`
        );
        continue;
      }

      const measured = resolve(recording, claim.path);
      if (measured.error != null) {
        failures.push(`${file}:${String(block.line)}  ${claim.written}\n    ${measured.error}`);
        continue;
      }

      const of = claim.of == null ? null : resolve(recording, [...claim.path.slice(0, -1), claim.of]);
      if (of?.error != null) {
        failures.push(`${file}:${String(block.line)}  ${claim.written}\n    ${of.error}`);
        continue;
      }

      const said = Number(claim.written.replace(/,/g, '').replace(/%$/, ''));
      const decimals = (/\.(\d+)/.exec(claim.written)?.[1] ?? '').length;
      const actual =
        of == null ? Number(measured.value) : (100 * Number(measured.value)) / Number(of.value);

      if (Number.isNaN(actual)) {
        failures.push(
          `${file}:${String(block.line)}  ${claim.written}\n` +
            `    ${claim.path.join('.')} holds ${JSON.stringify(measured.value)}, which is not a number`
        );
        continue;
      }

      if (round(actual, decimals) !== said) {
        failures.push(
          `${file}:${String(block.line)}  ${claim.written} under "${claim.row}"\n` +
            `    the recording says ${String(round(actual, decimals))}` +
            (of == null ? '' : ` (${String(measured.value)} of ${String(of.value)})`) +
            `, read from ${claim.path.join('.')}${claim.of == null ? '' : ` of ${claim.of}`}`
        );
      }
    }
  }
}

/**
 * Whether the row contains the figure as a whole number rather than inside a longer one.
 *
 * A substring test passes `12` against a row whose only number is `120`, and the declaration would then
 * be pinning a figure the row does not carry while reporting that it does — the same one-way pass this
 * direction of the check exists to prevent.
 *
 * What continues a number is a digit, or a point or comma with a digit on the far side of it: `370` is in
 * `370, both inside` and is not in `1,370`. A percent sign does not — a table writes `15.3%` where the
 * recording holds `15.3`, and rejecting that would have failed nine correct declarations in `41b`'s own
 * table, which is how the first version of this boundary was caught.
 */
function appearsIn(row, written) {
  const escaped = written.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<!\\d)(?<![\\d][.,])${escaped}(?!\\d)(?![.,]\\d)`).test(row);
}

/** Rounded the way the document wrote it, so 11.58 satisfies "11.6%" and 11.5 does not. */
function round(value, decimals) {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

/**
 * The declaration blocks in a document, each with the table under it already split into rows.
 *
 * The table has to be the one immediately below: a declaration that hunts for its table by name would
 * keep passing after the table moved, which is the class of failure this check is for.
 */
function declarationsIn(text) {
  const blocks = [];
  const pattern = /<!--\s*figures:[ \t]*(\S*)\n([\s\S]*?)-->\s*\n+((?:\|[^\n]*\n)+)/g;

  for (const match of text.matchAll(pattern)) {
    const rows = new Map();
    for (const line of match[3].split('\n')) {
      const first = line.split('|')[1]?.trim();
      // The header's own rule, `| --- | --- |`, is not a row.
      if (first == null || first === '' || /^-+$/.test(first)) continue;
      rows.set(stripEmphasis(first), line);
    }

    const body = parseBody(match[2], match[1]);
    blocks.push({ ...body, line: text.slice(0, match.index).split('\n').length, rows });
  }

  return blocks;
}

/** The table's own emphasis is not part of its row's name, and half these rows are bolded. */
function stripEmphasis(cell) {
  return cell.replace(/\*\*/g, '').replace(/`/g, '').trim();
}

/**
 * The recordings a table names, and its claims grouped under the row each belongs to.
 *
 * `<figure> = [<recording>] <path>[ of <sibling>]`, where the recording name is omitted when the table
 * names only one — which most do, and requiring it there would be ceremony for a single fact.
 */
function parseBody(body, inline) {
  const recordings = new Map();
  const claims = [];
  let row = '';

  if (inline !== '') recordings.set('', inline);

  for (const line of body.split('\n')) {
    if (line.trim() === '') continue;

    const named = /^\s+([a-z][\w-]*)\s*=\s*(\S+\.json)\s*$/.exec(line);
    if (named != null && claims.length === 0) {
      recordings.set(named[1], named[2]);
      continue;
    }

    // The path is not `\S+`: a probe is addressed by a substring of its own label, and those have
    // spaces in them. Lazy, so a trailing `of <sibling>` lands in its own group rather than in the path.
    // The sibling is `\w+` rather than `\S+`, because a probe's label may contain the word "of" — and
    // with a looser pattern it does: `probes[what kind of compute]` split at its own label, leaving a
    // path ending in "what kind" and a denominator of "compute].rows[0].runs".
    const claim = /^\s+([\d,.]+%?)\s*=\s*(.+?)(?:\s+of\s+(\w+))?\s*$/.exec(line);
    if (claim == null) {
      row = stripEmphasis(line);
      continue;
    }

    const [named_, ...rest] = claim[2].split(' ');
    const one = recordings.size === 1 && recordings.has('');
    claims.push({
      row,
      written: claim[1],
      recording: one ? '' : named_,
      path: parsePath(one ? claim[2] : rest.join(' ')),
      of: claim[3],
    });
  }

  return { recordings, claims };
}

/**
 * `probes[rule A].rows[0].peak_cpu_percentiles[2]` as a list of steps.
 *
 * A bracket holding digits is an index and anything else is a substring of the element's own label, so
 * a probe is addressed by what it measured rather than by where it happens to sit in the file. The
 * recording is re-taken by a script whose probe order is not part of what it measured.
 */
function parsePath(written) {
  const steps = [];
  for (const part of written.split('.')) {
    const bracket = /^([^[]*)\[([^\]]+)\]$/.exec(part);
    if (bracket == null) {
      steps.push(part);
      continue;
    }
    if (bracket[1] !== '') steps.push(bracket[1]);
    steps.push(/^\d+$/.test(bracket[2]) ? Number(bracket[2]) : bracket[2]);
  }
  return steps;
}

function readRecording(file) {
  try {
    return { value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (cause) {
    return { error: `cannot be read as a recording: ${cause.message}` };
  }
}

/**
 * Walks a path into the recording.
 *
 * Two shapes need help. A probe is selected by a substring of its label, and a percentile column is a
 * JSON array inside a string — the recordings hold what the warehouse returned, and the warehouse
 * returns an array column as text.
 *
 * An element is named by `label` or by `name`, because the recordings use both and neither is wrong:
 * a probe carries the question it asked, and `61a`'s parts carry the CTE they are. Widened when the
 * second shape arrived rather than renaming a field in a recording that took an hour of a shared estate
 * to take — an hour is a poor price for a synonym, and editing a recording to suit a checker is the
 * direction this repository has agreed not to travel in.
 */
function resolve(recording, steps) {
  let at = recording;

  for (const step of steps) {
    if (typeof at === 'string' && at.startsWith('[')) {
      try {
        at = JSON.parse(at);
      } catch {
        return { error: `${steps.join('.')} runs into a string that is not an encoded array` };
      }
    }

    if (at == null) return { error: `${steps.join('.')} runs out at "${String(step)}"` };

    if (typeof step === 'string' && Array.isArray(at)) {
      const named = (element) => String(element?.label ?? element?.name ?? '');
      const found = at.filter((element) => named(element).includes(step));
      if (found.length === 0) return { error: `nothing in that list is named for "${step}"` };

      /*
       * Ambiguity fails rather than taking the first, and this is the check's own version of the defect
       * it exists to find. "rule G" matched two probes — the one asking whether rule G's inputs exist
       * for classic clusters, and the one asking whether the timing it needs is populated — and taking
       * the first read four figures off a population no sentence in the document was about. Silently
       * resolving to one of several is how a figure comes to be right about the arithmetic and wrong
       * about what it counted.
       */
      if (found.length > 1) {
        return {
          error:
            `"${step}" names ${String(found.length)} of them, so which population it reads is luck:\n` +
            found.map((element) => `      ${named(element)}`).join('\n'),
        };
      }

      at = found[0];
      continue;
    }

    at = at[step];
    if (at === undefined) return { error: `${steps.join('.')} names nothing: "${String(step)}" is absent` };
  }

  return { value: at };
}

if (failures.length > 0) {
  console.log(failures.join('\n'));
  console.log(
    `\n${String(failures.length)} of ${String(figures)} declared figures disagree with the recordings ` +
      'they name.\n' +
      'A figure that is true of a different population than the sentence around it is the one kind of ' +
      'wrong number that reads as right, which is why this fails the build.\n'
  );
  process.exit(1);
}

console.log(
  `${String(figures)} figures in ${String(tables)} tables agree with the recordings they name.\n`
);
