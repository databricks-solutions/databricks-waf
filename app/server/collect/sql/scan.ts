// Enough SQL reading to check a claim about a statement, and deliberately not more.
//
// `columns.ts` needed to know a statement's arity, because a fixture narrower than its statement
// measured the wrong thing and nobody noticed for a whole pull request. `slices.ts` needs to know where
// a statement aggregates, because slicing is only exact where the slice column is part of every grouping
// key in scope, and that is a property of the SQL rather than of the collector calling it. Both want the
// same three primitives, so they live here once.
//
// This is not a SQL parser and must not grow into one. It tracks parentheses and string literals, and
// that is the whole model. What makes that safe is that every caller is a test or a build check: being
// wrong is a red build, never a wrong result, and anything unreadable throws rather than returning a
// guess. The moment something in `server/` at runtime wants to read SQL structure, this is the wrong
// tool and the statement should declare the fact in a header instead.

/** A word found in a statement, with the parenthesis depth it was found at. */
export interface Word {
  readonly at: number;
  readonly word: string;
  readonly depth: number;
}

/** A parenthesised region, as offsets into the text it was found in. */
export interface Scope {
  /** First character inside the opening parenthesis. */
  readonly start: number;
  /** The closing parenthesis. */
  readonly end: number;
  readonly depth: number;
}

/**
 * Comments removed, tracking string literals so a `--` inside one is left alone.
 *
 * Replaced with spaces rather than deleted, so every offset into the result still matches the original.
 * A checker that reports "line 132" has to mean line 132 of the file the reader will open. A block
 * comment's newlines are kept for the same reason; only the text inside its delimiters is blanked.
 *
 * Block comments are read before string literals rather than beside them, because this file's own prose
 * comments use apostrophes freely — "the estate's own work" opened a `quoted` region that would not close
 * until the next `'`, anywhere later in the statement, and every paren and keyword in between vanished
 * from what `words` and `scopes` could see. That silently broke arity and grouping-key checks for any
 * statement whose block comment happened to contain a possessive, which three of the twenty-two did:
 * `workload_query_shapes.sql`, `workload_sql_paths.sql` and `workload_warehouse_pressure.sql`.
 */
export function withoutComments(sql: string): string {
  const out = [...sql];
  let quoted = false;
  let blocked = false;
  for (let at = 0; at < out.length; at += 1) {
    const here = out[at];
    if (blocked) {
      if (here === '*' && out[at + 1] === '/') {
        out[at] = ' ';
        out[at + 1] = ' ';
        at += 1;
        blocked = false;
      } else if (here !== '\n') {
        out[at] = ' ';
      }
      continue;
    }
    if (quoted) {
      if (here === "'") quoted = out[at + 1] === "'" ? (at += 1) > 0 : false;
      continue;
    }
    if (here === '/' && out[at + 1] === '*') {
      out[at] = ' ';
      out[at + 1] = ' ';
      at += 1;
      blocked = true;
      continue;
    }
    if (here === "'") {
      quoted = true;
      continue;
    }
    if (here === '-' && out[at + 1] === '-') {
      while (at < out.length && out[at] !== '\n') {
        out[at] = ' ';
        at += 1;
      }
    }
  }
  return out.join('');
}

/**
 * Every bare word outside a string literal, upper-cased, with its parenthesis depth.
 *
 * Depth is yielded rather than filtered because the two callers want opposite things: a top-level
 * `SELECT` is the one at depth zero, and an aggregate that matters can be at any depth.
 */
export function* words(text: string, from = 0): Generator<Word> {
  let depth = 0;
  let quoted = false;
  for (let at = from; at < text.length; at += 1) {
    const here = text[at];
    if (quoted) {
      if (here === "'") quoted = text[at + 1] === "'" ? (at += 1) > 0 : false;
      continue;
    }
    if (here === "'") {
      quoted = true;
      continue;
    }
    if (here === '(') depth += 1;
    else if (here === ')') depth -= 1;
    else if (/[A-Za-z_]/.test(here)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(at))?.[0] ?? '';
      yield { at, word: word.toUpperCase(), depth };
      at += word.length - 1;
    }
  }
}

/**
 * Every parenthesised region that is a query rather than an expression.
 *
 * A region qualifies when its content begins with `SELECT`, which covers a CTE body, a derived table and
 * a scalar subquery, and excludes a function call's arguments and an `OVER (…)` clause.
 *
 * That distinction is the whole point of the filter, and it was not here at first. `slices.ts` asks
 * "does the smallest scope containing this aggregate also mention the slice column", and treating every
 * parenthesis as a scope made `COALESCE(ROW_NUMBER() OVER (PARTITION BY job_id …), 0)` resolve to the
 * arguments of `COALESCE` — a region with no `workspace_id` in it, so the exemption for dimension tables
 * fired and accepted an unsafe window. A region that is too large only makes the answer more
 * conservative; a region that is too small misses. Only query boundaries are safe to stop at.
 */
export function scopes(text: string): readonly Scope[] {
  const found: Scope[] = [];
  const open: { at: number; depth: number }[] = [];
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const here = text[at];
    if (quoted) {
      if (here === "'") quoted = text[at + 1] === "'" ? (at += 1) > 0 : false;
      continue;
    }
    if (here === "'") quoted = true;
    else if (here === '(') open.push({ at, depth: open.length });
    else if (here === ')') {
      const start = open.pop();
      if (start == null) continue;
      const scope = { start: start.at + 1, end: at, depth: start.depth };
      if (/^\s*SELECT\b/i.test(text.slice(scope.start, scope.end))) found.push(scope);
    }
  }
  return found;
}

/**
 * The smallest query containing an offset, or the whole text when nothing does.
 *
 * The fallback is the outermost query, which has no parentheses of its own but is still a scope with a
 * grouping key — the final `GROUP BY` of every statement here lives there.
 */
export function scopeAround(text: string, all: readonly Scope[], at: number): Scope {
  let best: Scope | undefined;
  for (const scope of all) {
    if (at < scope.start || at > scope.end) continue;
    if (best == null || scope.end - scope.start < best.end - best.start) best = scope;
  }
  return best ?? { start: 0, end: text.length, depth: -1 };
}

/** Words that end a `GROUP BY` or `PARTITION BY` list, so a clause can be read without a grammar. */
const CLAUSE_END = new Set([
  'ORDER',
  'LIMIT',
  'HAVING',
  'QUALIFY',
  'WINDOW',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'ROWS',
  'RANGE',
]);

/**
 * The text of a `BY` list starting at an offset, read to whatever ends it.
 *
 * Ends at the parenthesis closing the clause's own scope — which for a `PARTITION BY` is the end of the
 * `OVER (…)` and for a `GROUP BY` in a CTE is the end of the CTE — or at a keyword that cannot appear
 * inside a grouping key, or at the end of the text.
 *
 * Scanned here rather than over `words`, which measures depth from wherever it was told to start and so
 * cannot tell "left the enclosing scope" from "started at depth zero". That mismatch is worth naming: it
 * silently returned an empty list for every `PARTITION BY` in the tree, and an empty list looks exactly
 * like a partition key that omits the slice column. Every one of the four statements was reported unsafe
 * on an axis all four are safe on. A checker's failures have to be trustworthy in both directions.
 */
export function byList(text: string, from: number): string {
  let depth = 0;
  let quoted = false;
  for (let at = from; at < text.length; at += 1) {
    const here = text[at];
    if (quoted) {
      if (here === "'") quoted = text[at + 1] === "'" ? (at += 1) > 0 : false;
      continue;
    }
    if (here === "'") quoted = true;
    else if (here === '(') depth += 1;
    else if (here === ')') {
      if (depth === 0) return text.slice(from, at);
      depth -= 1;
    } else if (depth === 0 && /[A-Za-z_]/.test(here)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(at))?.[0] ?? '';
      if (CLAUSE_END.has(word.toUpperCase())) return text.slice(from, at);
      at += word.length - 1;
    }
  }
  return text.slice(from);
}

/** Whether a column is named in a clause, as a bare name or qualified with a table alias. */
export function names(clause: string, column: string): boolean {
  return new RegExp(`(?:^|[^A-Za-z0-9_.])(?:[A-Za-z_][A-Za-z0-9_]*\\.)?${column}(?![A-Za-z0-9_])`, 'i').test(clause);
}

/** The 1-based line an offset falls on, so a failure can point at the file rather than at a number. */
export function lineAt(text: string, at: number): number {
  return text.slice(0, at).split('\n').length;
}
