// Whether a statement filters a slowly-changing history table before deciding which of its rows is current.
//
// The bug this catches was live and silent. `system.compute.clusters` and `system.lakeflow.jobs` are
// documented as slowly-changing dimensions: a row per configuration change, and a final row when the
// object is deleted. Both statements picked each object's current row with
// `ROW_NUMBER() OVER (PARTITION BY workspace_id, cluster_id ORDER BY change_time DESC)` — correct — and
// both put `WHERE delete_time IS NULL` in the same query as that window.
//
// Which deletes the evidence of deletion. The only row where `delete_time` is set is the last one, so
// filtering it out first leaves the previous rows, one of which then wins the ranking and reports the
// object as current. Measured on a large account: 6,136,941 rows returned as live clusters where 135,154
// existed, a factor of 45, and 69,361 as live jobs where 13,365 existed. Nothing failed. Every runtime,
// autoscaling, auto-termination, policy, spot and init-script control simply computed its share over a
// population that was mostly deleted, and the score looked plausible.
//
// The general rule is about which column, not which keyword. A predicate in the same query as
// `PARTITION BY p` is safe when it is decided by `p`: filtering on `workspace_id` where the partition is
// `(workspace_id, cluster_id)` removes whole partitions and can never change which row wins inside one.
// It is unsafe when it reads a column that varies *within* a partition, because then it is choosing
// rows before the ranking chooses rows, and the ranking's answer is taken from what is left.
//
// Enforced narrowly, over the two lifecycle columns of these tables rather than over every column a
// `WHERE` can mention. The general form needs the predicate parsed well enough to tell a column from a
// function name, a parameter marker and a literal, and this check gates a build: a false alarm here
// stops work on a statement that is correct, which is a worse trade than a rule that names the two
// columns known to carry the hazard. `change_time` is included because it is the same mistake in the
// other direction — bounding a history table by when it was last edited, to make a result smaller,
// drops every object that is current but was configured a long time ago.

import { lineAt, scopeAround, scopes, withoutComments, words } from './scan.js';

/** The columns whose value differs between an object's history rows, so filtering on one picks rows. */
const LIFECYCLE = ['delete_time', 'change_time'] as const;

/** Clause keywords that end a `WHERE`, so the predicate is read without the rest of the query. */
const AFTER_WHERE = new Set(['GROUP', 'ORDER', 'HAVING', 'WINDOW', 'QUALIFY', 'LIMIT', 'UNION']);

/**
 * Why this statement's ranking is decided on the wrong rows, as prose, or undefined when it is not.
 *
 * Prose rather than a boolean for the same reason `sliceProblem` gives it: "unsafe" sends the reader
 * back to work out which of several windows is meant, where a line number and the column names put
 * them on the line that is wrong.
 */
export function historyProblem(sql: string): string | undefined {
  const text = withoutComments(sql);
  const all = scopes(text);
  const problems: string[] = [];

  for (const partition of partitions(text)) {
    const scope = scopeAround(text, all, partition.at);
    const region = text.slice(scope.start, scope.end);
    const predicate = whereOf(region);
    if (predicate == null) continue;

    // A partition key is safe to filter on: it removes whole partitions rather than choosing between
    // the rows of one. So a lifecycle column that is also a partition key is not the hazard.
    const filtered = LIFECYCLE.filter(
      (column) => mentions(predicate, column) && !mentions(partition.list, column)
    );
    if (filtered.length === 0) continue;

    problems.push(
      `the query containing the PARTITION BY at line ${String(lineAt(text, partition.at))} filters on ` +
        `${filtered.join(' and ')} in its own WHERE, so the window ranks whichever rows survive that ` +
        `filter instead of all of an object's history. Move the filter outside, onto the ranked result.`
    );
  }

  return problems.length === 0 ? undefined : problems.join(' Also, ');
}

/** Every window partition in a statement, with the text of its key list. */
function partitions(text: string): readonly { at: number; list: string }[] {
  const found: { at: number; list: string }[] = [];
  const seen = [...words(text)];

  for (let index = 0; index < seen.length; index += 1) {
    const word = seen[index];
    const next = seen[index + 1];
    if (word == null || next == null || word.word !== 'PARTITION' || next.word !== 'BY') continue;
    found.push({ at: word.at, list: listAfter(text, next.at + 'BY'.length) });
  }
  return found;
}

/**
 * A scope's own `WHERE` predicate, or undefined when it has none.
 *
 * Its own in two senses, and the second one cost a false alarm before it was handled. Only a `WHERE`
 * at the region's own nesting level is read, so a derived table's filter is not mistaken for this
 * query's. And any nested *query* inside the predicate is blanked out before it is examined, because
 * `workspace_id IN (SELECT workspace_id FROM other WHERE delete_time IS NULL)` filters the rows of
 * `other` and says nothing about which of this object's history rows survive.
 *
 * Nested queries rather than all brackets, which is the distinction that keeps the check honest in
 * both directions: blanking every bracket would also blank `(delete_time IS NULL OR retired)`, which
 * is the hazard, written with grouping.
 */
function whereOf(region: string): string | undefined {
  let start: number | undefined;
  for (const word of words(region)) {
    if (word.depth === 0 && word.word === 'WHERE') {
      start = word.at + 'WHERE'.length;
      break;
    }
  }
  if (start == null) return undefined;

  let end = region.length;
  for (const word of words(region, start)) {
    if (word.depth === 0 && AFTER_WHERE.has(word.word)) {
      end = word.at;
      break;
    }
  }

  return withoutSubqueries(region, start, end);
}

/** The text between two offsets with every nested query blanked, so only this query's predicate remains. */
function withoutSubqueries(region: string, start: number, end: number): string {
  const nested = scopes(region).filter((scope) => scope.start >= start && scope.start < end);
  let kept = '';
  for (let at = start; at < end; at += 1) {
    kept += nested.some((scope) => at >= scope.start && at < scope.end) ? ' ' : region[at];
  }
  return kept;
}

/** The parenthesised list following a `BY`, read to its closing bracket. */
function listAfter(text: string, from: number): string {
  const open = text.indexOf('(', from);
  const stop = /\bORDER\b/i.exec(text.slice(from));
  const limit = stop == null ? text.length : from + stop.index;
  if (open === -1 || open > limit) return text.slice(from, limit);

  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === '(') depth += 1;
    else if (text[at] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, at);
    }
  }
  return text.slice(open + 1, limit);
}

/** Whether a clause names a column, on a word boundary so `delete_time` is not found in `x_delete_time`. */
function mentions(clause: string, column: string): boolean {
  return new RegExp(`(?<![\\w.])${column}\\b`, 'i').test(clause);
}
