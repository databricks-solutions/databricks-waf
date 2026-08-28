// The columns a statement actually returns, read from its own text.
//
// Exists because a fixture that is narrower than its statement measures the wrong statement, and does
// it silently. The `serverless_job_readiness` sample stopped at `cluster_names` and never carried the
// `runtimes` list after it — twenty-eight values against a statement returning twenty-nine — which put
// the measured payload at 99% of the inline cap instead of the 110% it is, and produced the wrong
// headline for the pull request that introduced the measurement. Caught in review, not by anything here,
// which is why this is here.
//
// Not a SQL parser. It finds the last `SELECT` at paren depth zero, reads to the `FROM` that closes it,
// and splits the list on top-level commas — enough for these nineteen statements and no more. It is
// used only by tests, so being wrong is a failing test rather than a wrong result, and a statement
// shaped in a way this cannot read fails loudly at `columnsOf` rather than quietly returning too few.
//
// The scanning lives in `scan.ts`, shared with `slices.ts`, which asks a different question of the same
// three primitives.

import { withoutComments, words } from './scan.js';

/**
 * The output column names of a statement's final `SELECT`, in order.
 *
 * An expression with no alias comes back as undefined at its position, so the length is the arity even
 * where a name could not be read. `scale.test.ts` holds every fixture to that length.
 */
export function columnsOf(sql: string): readonly (string | undefined)[] {
  const text = withoutComments(sql);
  const start = lastTopLevelSelect(text);
  if (start == null) throw new Error('No top-level SELECT: columnsOf cannot read this statement.');

  const list = text.slice(start, endOfSelectList(text, start));
  return split(list).map(alias);
}

/** Where the last depth-zero `SELECT` list begins, past the keyword and any `DISTINCT`. */
function lastTopLevelSelect(text: string): number | undefined {
  let found: number | undefined;
  for (const { at, word, depth } of words(text)) {
    if (depth === 0 && word === 'SELECT') found = at + 'SELECT'.length;
  }
  if (found == null) return undefined;

  const distinct = /^\s+DISTINCT\b/i.exec(text.slice(found));
  return found + (distinct?.[0].length ?? 0);
}

/** Where that list ends: the `FROM` closing it, or the end of the statement for a `SELECT` without one. */
function endOfSelectList(text: string, start: number): number {
  for (const { at, word, depth } of words(text, start)) {
    if (depth === 0 && word === 'FROM') return at;
  }
  return text.length;
}

/** A select list split on the commas that separate its columns, not the ones inside its expressions. */
function split(list: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let at = 0; at < list.length; at += 1) {
    const here = list[at];
    if (quoted) {
      if (here === "'") quoted = list[at + 1] === "'" ? (at += 1) > 0 : false;
      continue;
    }
    if (here === "'") quoted = true;
    else if (here === '(') depth += 1;
    else if (here === ')') depth -= 1;
    else if (here === ',' && depth === 0) {
      parts.push(list.slice(start, at));
      start = at + 1;
    }
  }
  parts.push(list.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * The name a column is returned under: its alias, or the last segment of a plain reference.
 *
 * Undefined for an unaliased expression rather than a guess, because a wrong name in a failure message
 * is worse than no name — it sends the reader to a column that does not exist.
 */
function alias(column: string): string | undefined {
  const aliased = /\bAS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*$/i.exec(column);
  if (aliased != null) return aliased[1];

  const plain = /^[A-Za-z_][A-Za-z0-9_]*(?:\.([A-Za-z_][A-Za-z0-9_]*))?$/.exec(column);
  if (plain != null) return plain[1] ?? plain[0];

  return undefined;
}
