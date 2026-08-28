// What a statement with no labs reading still has to have proved, and whether it still proves it.
//
// `awaiting-reading.json` excuses a statement from the Q1a duration ceilings, for the two that read a
// system schema an account admin enables per metastore and the calibration estate does not have. Its
// own prose enumerates what a name on it costs and is careful about it. What it did not say, because
// nobody had noticed it was being given away, is that **a labs reading is the only thing in this build
// that parses SQL** — the bounds and grain checks read statements with `scan.ts`, which says in its
// own header that it is not a parser and must not become one.
//
// So `serving_asset_quality.sql` shipped with a missing comma between its two CTEs, and no machine
// read it for as long as it was on the list. Submitted to labs it returned `PARSE_SYNTAX_ERROR` at the
// second CTE; with the comma it returns the `TABLE_OR_VIEW_NOT_FOUND` its entry claims. Row 77.
//
// What this adds is the submission, not the measurement. An entry now carries the error the platform
// returned, the text it returned it for, and when — and the gate refuses an entry whose error is a
// parse failure, or whose statement has changed since. A statement on the list is then unbudgeted,
// which is what the list is for, and not unread, which is what it had quietly become.
//
// `npm run record:awaiting` takes the submission, by hand, against a bound warehouse. ADR 0090's
// reasoning about why this is not a CI job applies unchanged: CI has no warehouse and a pull request
// from a fork cannot be given one.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const APP = join(HERE, '..');
export const STATEMENTS = join(APP, 'config', 'statements');
export const AWAITING = join(APP, 'server', 'collect', 'sql', 'runtime-baseline', 'awaiting-reading.json');

/**
 * The SQLSTATE classes that mean the platform never got as far as the statement's tables.
 *
 * Held as SQLSTATE rather than as the bracketed error name, because the name is a Databricks string
 * that can be renamed and the state is the standard's. `42601` is a syntax error and `42000` its
 * unqualified parent; both mean the text is not a statement, so an entry recording one is an entry
 * whose excuse describes something that never happened.
 *
 * The list is what a recorded submission may *not* be. Everything else is allowed, including errors
 * this row did not anticipate: a permission failure is a fact about the estate the statement was
 * submitted against, and refusing it here would make the list unusable on the day somebody's grant
 * lapses. What matters is that the platform read the statement.
 */
export const UNPARSED = new Set(['42601', '42000']);

/**
 * The digest of a statement as committed.
 *
 * Over the file rather than over what the app sends, which is the narrower claim and the one this can
 * keep: `queries.ts` expands `{{customer_catalog …}}` before execution, and a third copy of that
 * expansion — `measure-sql-baseline.mjs` already keeps the second — is a worse thing to have than a
 * digest that means "the file". A listed statement carrying a fragment is refused below instead, so
 * the gap cannot be entered rather than being documented and then walked into.
 */
export function shaOf(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** The fragment marker `queries.ts` expands, which a submission of the raw file would not have sent. */
const FRAGMENT = /\{\{[a-z_]+ [^}]*\}\}/;

/** The awaiting list, or an empty one where the file is absent. Throws when it is unreadable. */
export function entries(file = AWAITING) {
  if (!existsSync(file)) return {};
  const statements = JSON.parse(readFileSync(file, 'utf8')).statements;
  if (statements == null || typeof statements !== 'object' || Array.isArray(statements)) {
    throw new Error('awaiting-reading.json carries no `statements` object');
  }
  return statements;
}

/**
 * What is wrong with an entry, as sentences, or an empty list.
 *
 * Takes the statement text rather than reading it, so the caller decides what "the statement" is —
 * the gate reads the tree, the tests pass a string. A missing file is the caller's to report: this
 * one is about the entry.
 */
export function faults(entry, text) {
  const found = [];
  if (text != null && FRAGMENT.test(text)) {
    found.push(
      'holds a `{{…}}` fragment, which queries.ts expands before the app sends it. A submission of the\n' +
        '  file is then of a text nothing runs, so this list cannot stand behind it. Measure the statement\n' +
        '  on an estate that has its schema, or teach the recorder the expansion queries.ts owns'
    );
  }
  const submitted = entry?.submitted;
  if (submitted == null || typeof submitted !== 'object') {
    found.push(
      'has no recorded submission. An entry here is exempt from the duration ceilings, and a labs\n' +
        '  reading is the only thing in this build that parses SQL, so an entry with no submission is a\n' +
        '  statement nothing has read. Run `npm run record:awaiting` against a bound warehouse'
    );
    return found;
  }
  if (typeof submitted.sqlState !== 'string' || submitted.sqlState.trim() === '') {
    found.push('records a submission with no SQLSTATE, so it cannot say the platform read the statement');
  } else if (UNPARSED.has(submitted.sqlState.trim())) {
    found.push(
      `records SQLSTATE ${submitted.sqlState} — the platform did not parse this statement, so its entry\n` +
        `  here describes a failure that never happened. ${String(submitted.error ?? '')}`.trimEnd()
    );
  }
  if (typeof submitted.at !== 'string' || Number.isNaN(Date.parse(submitted.at))) {
    found.push('records a submission with no usable date');
  }
  if (typeof submitted.statementSha !== 'string') {
    found.push('records a submission with no statementSha, so it cannot be tied to a text');
  } else if (text != null && submitted.statementSha !== shaOf(text)) {
    found.push(
      'has changed since it was submitted. The recorded submission is of a different text, so nothing\n' +
        '  has read what is in the tree. Run `npm run record:awaiting` again'
    );
  }
  return found;
}

/** Every fault across the list, each already prefixed with the statement it is about. */
export function problems({ file = AWAITING, dir = STATEMENTS } = {}) {
  const found = [];
  for (const [name, entry] of Object.entries(entries(file))) {
    const path = join(dir, `${name}.sql`);
    const text = existsSync(path) ? readFileSync(path, 'utf8') : null;
    for (const fault of faults(entry, text)) found.push(`${name} ${fault}`);
  }
  return found;
}
