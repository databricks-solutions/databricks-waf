// Whether a statement can be executed in slices and reassembled without changing its answer.
//
// The problem this solves: four statements return one row per job or per cluster, and at the declared
// estate `serverless_job_readiness` is 27.6 MiB against a 25 MiB inline cap — it fails at 90,606 jobs,
// under the estate the app claims to assess, and past the cap the API returns nothing rather than less.
// H1c executes those statements once per workspace and concatenates the results, which keeps every row
// and therefore keeps every number the app presents as estate-wide.
//
// That only works when the slice predicate partitions what the statement groups by. With
// `GROUP BY workspace_id, job_id`, filtering input rows to one workspace sends every row of a given
// output group into exactly one slice, so each group is computed over exactly the rows it would have
// been computed over anyway. Concatenating is then not an approximation of the whole result, it is the
// whole result. This holds for every aggregate including `count(DISTINCT …)`, because no group is ever
// split.
//
// Slice on something the aggregates consume instead and it silently stops holding. Date is the tempting
// one, and it is the reason this module exists rather than a comment saying "slice by workspace":
// `serverless_job_readiness` has twelve `count(DISTINCT …)` expressions over clusters, so a cluster used
// in two date windows is counted once by the whole statement and twice by the sum of its slices. Nothing
// fails. The migration verdicts just read high, and no test that mocks the collector would notice.
//
// So the axis is a property of the statement, declared in its own `-- Slice:` header next to `-- Rows:`,
// and `sliceProblem` reads the SQL to check the declaration is true rather than trusting it. What it
// checks is deliberately conservative: in any scope that mentions the slice column, every grouping key
// and every window partition must name it. A scope that never mentions the column is exempt, which is
// what makes a dimension lookup legal — `serverless_job_spend` joins a price table with no workspace
// dimension, whose rows are identical in every slice.

import { byList, lineAt, names, scopeAround, scopes, withoutComments, words } from './scan.js';

/** The axes a statement declares it can be sliced on, coarsest first. */
export interface DeclaredSlice {
  readonly columns: readonly string[];
}

/** One column of a statement's own top-level `ORDER BY`, with the direction it sorts in. */
export interface SortColumn {
  readonly column: string;
  readonly descending: boolean;
}

/**
 * The `-- Slice:` header a statement declares, or undefined when it declares none.
 *
 * Coarsest first, because that is the order the collector subdivides in: one execution per workspace,
 * and only if a workspace is still too large does it bucket by the next axis. Read from the statement
 * rather than held in a table here for the same reason `-- Rows:` is — the author changing the `GROUP BY`
 * is the person who knows whether the axis survived, and they are looking at the SQL, not at this file.
 */
export function declaredSlice(sql: string): DeclaredSlice | undefined {
  const header = /^--\s*Slice:\s*(.+)$/im.exec(sql);
  if (header == null) return undefined;

  const columns = (header[1] ?? '')
    .split(',')
    .map((column) => column.trim().toLowerCase())
    .filter((column) => column !== '');

  return columns.length === 0 ? undefined : { columns };
}

/**
 * Why slicing this statement on a column would change its answer, as prose, or undefined when it holds.
 *
 * Prose rather than a boolean because the fix is specific: a reader told "unsafe" has to re-derive which
 * of a dozen aggregates is the problem, and a reader told "the GROUP BY at line 87 does not include
 * workspace_id" is already looking at it.
 *
 * Conservative in one direction, which took two attempts to actually be. The exemption below is the only
 * thing here that can produce a miss, and it is driven by which scope a key resolves to: a scope larger
 * than the real one mentions the column more often and so exempts less, while a scope smaller than the
 * real one exempts an unsafe key. Both earlier versions resolved windows to something too small — first
 * the `OVER (…)` clause itself, then whichever region enclosed it, which for a nested window is a
 * function call. So `scan.ts` now stops only at query boundaries, where being imprecise means being
 * larger. A false alarm is an argument at review; a miss is inflated numbers on a customer's estimate.
 */
export function sliceProblem(sql: string, column: string): string | undefined {
  const text = withoutComments(sql);
  const all = scopes(text);
  const problems: string[] = [];

  for (const key of keys(text)) {
    // The smallest enclosing *query*, which for a `PARTITION BY` is the query the window is evaluated in
    // rather than its own `OVER (…)`. Asking whether the `OVER` clause mentions the column is asking
    // whether the partition key includes it, which is the question — so it exempted every unsafe window
    // in the tree. Hopping one region outward instead was also wrong, because the region outside a window
    // is often a function call: `COALESCE(ROW_NUMBER() OVER (…), 0)` resolved to the arguments of
    // `COALESCE`, which mention nothing and so exempted the window again. `scopes` returns only queries.
    const scope = scopeAround(text, all, key.at);
    const region = text.slice(scope.start, scope.end);

    // A scope with no reference to the column cannot be partitioned by it, so it is the same in every
    // slice. This is the exemption that makes a dimension lookup legal rather than a special case.
    if (!names(region, column)) continue;
    if (names(key.list, column)) continue;

    const positional = /^\s*\d+\s*(?:,\s*\d+\s*)*$/.test(key.list);
    problems.push(
      positional
        ? `the ${key.kind} at line ${String(lineAt(text, key.at))} names its columns by position ` +
          `(\`${key.list.trim()}\`), so whether it includes ${column} cannot be read from the statement. ` +
          `Name the columns.`
        : `the ${key.kind} at line ${String(lineAt(text, key.at))} does not include ${column} ` +
          `(\`${collapse(key.list)}\`), and its scope does reference ${column} — so slicing on ${column} ` +
          `would split a group across slices and every aggregate over it would be counted twice.`
    );
  }

  if (!names(outputOf(text), column)) {
    problems.push(
      `the statement does not return ${column}, so slices could not be told apart in the concatenated ` +
        `result even if each one were correct.`
    );
  }

  return problems.length === 0 ? undefined : problems.join(' Also, ');
}

/**
 * The columns a statement's own top-level `ORDER BY` sorts on, unqualified, or undefined when it has none.
 *
 * Slicing preserves the row set and not the row order, which matters more than it sounds: `offenders()`
 * takes the first five rows and names them as examples without sorting, trusting the statement's
 * `ORDER BY` to have put the worst first. Concatenate per-workspace slices and those five come from
 * whichever workspace was executed first — a real change in what a customer reads, from a change that
 * keeps every row.
 *
 * So H1d re-sorts after concatenating, and this is what it sorts by. Exported from here rather than
 * hard-coded there because the sort belongs to the statement, and a statement whose `ORDER BY` changes
 * should move its consumers with it.
 */
export function orderKey(sql: string): readonly SortColumn[] | undefined {
  const text = withoutComments(sql);

  let start: number | undefined;
  for (const word of words(text)) {
    if (word.depth === 0 && word.word === 'ORDER') start = word.at;
  }
  if (start == null) return undefined;

  const after = /^ORDER\s+BY\b/i.exec(text.slice(start));
  if (after == null) return undefined;

  const columns = byList(text, start + after[0].length)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => ({
      // Direction carried, because it is half the order: `classic_uses DESC` puts the worst job first and
      // `name` puts the first alphabetically first, and a re-sort that dropped this would reverse one of
      // the two statements that name their most expensive jobs as examples.
      column: part
        .replace(/\s+(?:ASC|DESC)\b.*$/i, '')
        .replace(/^.*\./, '')
        .trim(),
      descending: /\bDESC\b/i.test(part),
    }))
    .filter((part) => part.column !== '');

  return columns.length === 0 ? undefined : columns;
}

/** Every grouping key and window partition in a statement, with the text of its column list. */
function keys(text: string): readonly { at: number; kind: string; list: string }[] {
  const found: { at: number; kind: string; list: string }[] = [];
  const seen = [...words(text)];

  for (let index = 0; index < seen.length; index += 1) {
    const word = seen[index];
    const next = seen[index + 1];
    if (word == null || next == null || next.word !== 'BY') continue;
    if (word.word !== 'GROUP' && word.word !== 'PARTITION') continue;

    const from = next.at + 'BY'.length;
    found.push({
      at: word.at,
      kind: word.word === 'GROUP' ? 'GROUP BY' : 'PARTITION BY',
      list: byList(text, from),
    });
  }
  return found;
}

/**
 * The statement's final select list, which is where a slice column has to survive to.
 *
 * Read as the text between the last top-level `SELECT` and the `FROM` closing it, rather than through
 * `columnsOf`, because this only needs to know whether a name appears — and unlike `columnsOf` it must
 * not throw on a statement it cannot fully read, since the caller is a build check reporting on all
 * nineteen at once.
 */
function outputOf(text: string): string {
  let start: number | undefined;
  for (const word of words(text)) if (word.depth === 0 && word.word === 'SELECT') start = word.at;
  if (start == null) return text;

  for (const word of words(text, start)) {
    if (word.depth === 0 && word.word === 'FROM') return text.slice(start, word.at);
  }
  return text.slice(start);
}

/** A clause on one line, for a failure message that stays readable. */
function collapse(clause: string): string {
  return clause.trim().replace(/\s+/g, ' ');
}
