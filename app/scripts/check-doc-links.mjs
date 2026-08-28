#!/usr/bin/env node
// Every relative link in this repository's documentation resolves, anchors included.
//
// Twenty-eight did not, across four files, and they were found by a reader who guessed the same wrong
// filename the documents had. The failure is quiet in a way most broken links are not: this
// repository's prose carries its authority by citation — "see ADR 0074" is how a claim is made
// checkable — and a citation that 404s is indistinguishable, to a reader who does not follow it, from
// one that resolves. Twenty-three of the twenty-eight named files that exist, at paths correct from
// the repository root and written into a document two directories down, which is why nobody reading
// the prose noticed.
//
// Two things this does that the cheap version of it would not.
//
// Anchors are part of the link and most of the value. The ledger links each of its rows to a heading,
// so a heading renamed without its referrers is the same failure one level down, and a fragment
// naming no heading in the target file fails here rather than being skipped. Three of the twenty-eight
// were decisions cited by a description of what they decided rather than by their filename, which is
// what a writer produces who knows the decision and not the file.
//
// The kit under `docs/design/reference/` is not ours. Its own AGENTS.md says its paths are relative to
// its own tree, so its files are excluded by name — not by the check passing quietly on what it cannot
// resolve. Links *into* the kit from our documents are ours and are checked.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** Not ours; see above. Anything under here is not read for links. */
const NOT_OURS = 'docs/design/reference/';

const files = execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter((file) => file !== '')
  .filter((file) => !file.startsWith(NOT_OURS) && !file.includes('node_modules/') && !file.includes('/dist/'));

const blank = (match) => match.replace(/[^\n]/g, ' ');

/**
 * The same text with fenced blocks blanked out, keeping line and column numbers.
 *
 * A fenced block holds example commands and example links — `docs/` paths in a shell snippet are
 * illustrations, and checking them would report failures that are not ones — and it also holds comment
 * lines beginning with `#`, which read as headings to anything scanning for them. This repository's
 * documents are largely about shell scripts, so both cases are everywhere.
 */
function withoutFences(text) {
  return text.replace(/^ {0,3}(```+|~~~+)[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|$)/gm, blank);
}

/**
 * GitHub's heading slugs: lowercased, punctuation dropped, spaces hyphenated, repeats suffixed.
 *
 * Written to match what GitHub actually produces rather than what is tidy, because the links being
 * checked were written by reading a rendered page. Two headings with the same words get `-1` and `-2`
 * on the second and third, which the ledger relies on nowhere but a plan file could.
 */
function anchorsIn(text) {
  const seen = new Map();
  const anchors = new Set();

  for (const line of withoutFences(text).split('\n')) {
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading == null) continue;

    /*
     * A code span in a heading contributes its text and not its backticks: `## …the defect it found
     * (\`36r\`)` is `#…-the-defect-it-found-36r` on GitHub. The first version of this blanked spans out
     * before slugging, as the link scan below still does, and reported five links in `sql-quality.md`
     * as pointing at headings that do not exist — while offering the mangled slug it had computed
     * itself as the closest match, which is what gave it away. Every one of those five links was
     * correct. Two of the six failures the accessibility check reported in `59b` were its own in
     * exactly this way, so the apparatus gets read against what it claims to describe before its
     * output is believed.
     */
    const slug = heading[1]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .replace(/ /g, '-');

    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${String(count)}`);
  }

  return anchors;
}

/** Inline links, with the line they were written on so a failure can be found without searching. */
function linksIn(text) {
  const found = [];
  // Spans blanked here but not for headings above: a link written inside backticks is being shown to
  // the reader rather than offered to them, and several documents quote a wrong path on purpose.
  const source = withoutFences(text).replace(/`[^`\n]*`/g, blank);
  const pattern = /\[(?:[^\][]|\[[^\]]*\])*\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g;

  for (const match of source.matchAll(pattern)) {
    found.push({
      target: match[1],
      line: source.slice(0, match.index).split('\n').length,
    });
  }

  return found;
}

/** Anchors are read once per target file, because the ledger alone points at one file ninety times. */
const anchorCache = new Map();

function anchorsOf(file) {
  if (!anchorCache.has(file)) anchorCache.set(file, anchorsIn(readFileSync(file, 'utf8')));
  return anchorCache.get(file);
}

const failures = [];
let checked = 0;

for (const file of files) {
  const text = readFileSync(path.join(ROOT, file), 'utf8');

  for (const { target, line } of linksIn(text)) {
    // Off this repository, or a page-internal reference to something that is not a document.
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;

    checked += 1;
    const [where, fragment] = splitFragment(target);
    const at = `${file}:${String(line)}`;

    // A bare fragment is a link into the file it is written in, which is how a long document points
    // at its own sections — and the ledger's rows point at another file's, so both paths are the same
    // check with a different target.
    const resolved = where === '' ? path.join(ROOT, file) : path.resolve(path.dirname(path.join(ROOT, file)), where);

    if (!existsSync(resolved)) {
      failures.push(`${at}  ${target}\n    points at nothing: ${path.relative(ROOT, resolved)} does not exist`);
      continue;
    }

    if (fragment == null || fragment === '') continue;

    if (statSync(resolved).isDirectory()) {
      failures.push(`${at}  ${target}\n    a directory has no headings, so #${fragment} names nothing`);
      continue;
    }

    // A fragment on anything else is a line reference into source — `#L42` on a `.ts` file — which is
    // GitHub's own syntax and not a heading. Checking it would mean pinning line numbers in prose.
    if (!resolved.endsWith('.md')) continue;

    const anchors = anchorsOf(resolved);
    if (!anchors.has(fragment.toLowerCase())) {
      failures.push(
        `${at}  ${target}\n    ${path.relative(ROOT, resolved)} has no heading making #${fragment}` +
          `${nearest(fragment, anchors)}`
      );
    }
  }
}

/**
 * Splits a link into its path and its fragment.
 *
 * On the last `#` rather than the first, because a filename may contain one and a fragment may not.
 */
function splitFragment(target) {
  const hash = target.lastIndexOf('#');
  return hash === -1 ? [target, undefined] : [target.slice(0, hash), target.slice(hash + 1)];
}

/**
 * The closest heading in the target, when there is a close one.
 *
 * A renamed heading is the common case and its replacement is usually a word away, so the failure
 * that says which heading to write is the difference between a two-minute fix and opening the file.
 */
function nearest(fragment, anchors) {
  const words = new Set(fragment.toLowerCase().split('-').filter((word) => word.length > 2));
  if (words.size === 0) return '';

  const scored = [...anchors]
    .map((anchor) => {
      const has = anchor.split('-').filter((word) => words.has(word)).length;
      return { anchor, share: has / words.size };
    })
    .filter((candidate) => candidate.share >= 0.5)
    .sort((a, b) => b.share - a.share);

  return scored[0] == null ? '' : `. Closest is #${scored[0].anchor}`;
}

if (failures.length > 0) {
  console.log(failures.join('\n'));
  console.log(
    `\n${String(failures.length)} of ${String(checked)} relative links in ${String(files.length)} documents ` +
      'resolve to nothing.\n' +
      'A citation that 404s reads as sound to every reader who does not follow it, which is why this fails ' +
      'the build.\n'
  );
  process.exit(1);
}

console.log(
  `${String(checked)} relative links in ${String(files.length)} documents resolve, anchors included.\n`
);
