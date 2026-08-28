// Which part of `uc_discovery_metadata` costs the hour. Ledger row `61`.
//
// `45a` ran the statement verbatim on `large-estate` and it took 4,023,076 ms — sixty-seven minutes —
// against 7,366 ms on labs, while the two statements beside it read the same catalogue over the same
// window in the same session for 84,313 ms and 14,632 ms. That is a property of this statement rather
// than of the estate being large, and it is the whole reason `61` exists.
//
// **This script measures and does not fix.** `AGENTS.md` requires the number before the rework and in its
// own pull request, because the measurement decides what the rework is: `H1` was written to rework eight
// statements and the measurement said one. The four parts below are equally plausible from reading the
// SQL and they are not equally plausible after running it, which is the only reason to run it.
//
// What it does. `uc_discovery_metadata` is four CTEs and three left joins onto the first. Each CTE is
// timed alone, wrapped in `SELECT count(*)` so the warehouse computes it and returns one row rather than
// shipping the body back — the question is what the estate costs to compute, not what it costs to
// serialise. Then the statement is rebuilt with one CTE and its output columns removed at a time, which
// is what says whether a part is expensive on its own or expensive where it joins.
//
// Why leave-one-out and not just the four CTEs. A CTE that is fast alone can still be the expensive one:
// `41c` found `uc_lineage_coverage` reading one relation ten times, and no per-CTE timing would have
// shown it. The pairing is what distinguishes "this part is slow" from "this part makes the join slow",
// and those ask for different reworks.
//
// The cost of running it. Every probe is bounded — a part by `PART_POLLS` and the statement and its
// variants by the longer `POLLS` — and the whole run by `BUDGET_MS`, because this reads a shared estate
// that is not ours: `docs/estates.md` says use it sparingly and leave nothing running. The cuts run
// dearest-part-first for the same reason, so the budget bites the readings that would only have confirmed
// the answer rather than the one that gives it. A probe that runs out is recorded as `unfinished` rather than
// dropped: a part that does not finish inside the budget is the strongest possible answer to which part
// costs the hour, and merging it with a refusal would report it as a permission problem. That is `41d`'s
// apparatus error and this script inherits the shape that corrects it.
//
// Reads catalogue metadata and system tables. No query text, no table contents, no sample rows.
//
// Run: cd app && DATABRICKS_HOST=... DATABRICKS_WAREHOUSE_ID=... DATABRICKS_CONFIG_PROFILE=large-estate \
//        node scripts/measure-discovery-cost.mjs
//
// Writes `server/collect/sql/runtime-baseline/<profile>-discovery-statement-cost.json`. The estate is in
// the name and the two guards in `recording-guards.mjs` check the name is true.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { corpusSettings, runStatement } from './plan-corpus.mjs';
import { refuseUnlessNamedForItsEstate } from './recording-guards.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINES = join(HERE, '..', 'server', 'collect', 'sql', 'runtime-baseline');
const STATEMENTS = join(HERE, '..', 'config', 'statements');

/**
 * Which statement to take apart. `uc_discovery_metadata` is the one `61` was opened about, and the
 * default stays there so the recording keeps the name it already has on disk.
 *
 * Nameable rather than fixed because `61b` moved the expensive part into `uc_discovery_columns.sql`:
 * the apparatus that found which CTE cost the hour is the apparatus that says whether the statement it
 * moved to still does, and a second copy of it would drift from this one.
 */
const STATEMENT = process.env.STATEMENT ?? 'uc_discovery_metadata';
const OUT = join(
  BASELINES,
  STATEMENT === 'uc_discovery_metadata'
    ? `${corpusSettings.profile}-discovery-statement-cost.json`
    : `${corpusSettings.profile}-${STATEMENT.replace(/_/g, '-')}-cost.json`
);

/** The app's own default, so the window is the statement's rather than this script's. */
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 30);

/**
 * Two-second polls per probe — ninety minutes, the same number `45a` fixed and for the same reason.
 *
 * The reading this exists to take is of a statement that ran for sixty-seven minutes. Under the shared
 * default of 150 polls it comes back `unfinished` with no number beside it, which is a reading of the
 * constant rather than of the statement. Fixed rather than overridable because a shell that already
 * carries `STATEMENT_POLLS` would silently cap exactly the probe this row is about.
 */
const POLLS = 2700;

/**
 * A sixth of the polls for a part measured alone, against the full budget for the statement and its cuts.
 *
 * Two caps rather than one, because the two kinds of probe are asked different questions. The whole
 * statement is asked *how long it takes*, and a cap under its real cost would answer with the cap. A part
 * is asked only *whether it is the outlier*, and against neighbours that finish in 5 to 19 seconds a far
 * shorter bound settles that — while costing a shared warehouse the difference on every part that runs
 * long. What the expensive part costs exactly is not what this row needs: the share it accounts for comes
 * from the whole statement measured against the whole statement without it, and both of those get `POLLS`.
 *
 * **A poll is not two seconds, and this comment said fifteen minutes until a run measured it.** The loop
 * in `runStatement` sleeps two seconds and then makes a request, and against `large-estate` the request is
 * the larger half: 450 polls came back `unfinished after 3323s`, so a poll cost 7.4s and the bound is
 * nearer fifty-five minutes than fifteen. Left at 450 because fifty-five minutes still bounds a part
 * against neighbours that take seconds, and because the number that matters for reproducing a recording is
 * the count of polls, which is what goes in the recording. Read a wall-clock bound off the estate, not off
 * this constant.
 */
const PART_POLLS = 450;

/**
 * How long the whole run may take before it stops starting new probes.
 *
 * Six hours. Not a guess about what the probes cost — the point of the run is that nobody knows — but a
 * bound on what this script may occupy of an estate that belongs to other people. A probe already
 * running when the budget passes is allowed to finish, because killing a statement mid-flight leaves the
 * warehouse doing the work anyway and loses the reading.
 */
const BUDGET_MS = 6 * 60 * 60 * 1000;

/** Mirrors `queries.ts`'s `customerCatalogPredicate`, as four other measurement scripts do. */
const FRAGMENT = /\{\{customer_catalog ([A-Za-z_][\w.]*)\}\}/g;
export function customerCatalog(text) {
  return text.replace(
    FRAGMENT,
    (_whole, column) =>
      `(${column} NOT IN (SELECT catalog_name FROM system.information_schema.catalogs ` +
      `WHERE catalog_owner = 'System user') AND lower(${column}) NOT IN ('system', 'samples')` +
      ` AND NOT startswith(lower(${column}), '__databricks_internal'))`
  );
}

/**
 * The shipped statement, read rather than transcribed.
 *
 * `45a`'s first pass at this family transcribed three statements from reading their SQL and one of the
 * three counted a different population — a correctly-computed figure about tables the control does not
 * score. Everything below is derived from this text by cutting it, so a change to the statement changes
 * what this measures instead of quietly measuring the old one.
 */
export function shipped(name = STATEMENT) {
  return readFileSync(join(STATEMENTS, `${name}.sql`), 'utf8')
    .replace(/;\s*$/, '')
    .trim();
}

/**
 * The statement split into its `WITH` bodies and its final `SELECT`.
 *
 * A parser rather than a set of hand-copied fragments, for the reason above, and a deliberately narrow
 * one: it understands the shape `uc_discovery_metadata.sql` has — a `WITH`, comma-separated
 * `name AS ( ... )` bodies at depth zero, then a final `SELECT` — and throws on anything else rather
 * than returning a partial parse. A mis-parse here produces probes that run, return numbers, and
 * describe a statement that does not exist, which is the failure `46a`'s fixture had.
 */
export function parts(text) {
  const withAt = /^WITH\s/m.exec(text);
  if (withAt == null) throw new Error('the statement no longer opens with a WITH clause.');
  const body = text.slice(withAt.index + withAt[0].length);

  const ctes = [];
  let at = 0;
  for (;;) {
    const named = /^\s*(?:--[^\n]*\n\s*)*([a-z_][a-z0-9_]*)\s+AS\s*\(/i.exec(body.slice(at));
    if (named == null) break;
    const opens = at + named.index + named[0].length;
    let depth = 1;
    let cursor = opens;
    while (cursor < body.length && depth > 0) {
      const character = body[cursor];
      if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
      cursor += 1;
    }
    if (depth !== 0) throw new Error(`the CTE ${named[1]} has no closing bracket.`);
    ctes.push({ name: named[1], body: body.slice(opens, cursor - 1).trim() });
    const after = /^\s*,/.exec(body.slice(cursor));
    if (after == null) {
      at = cursor;
      break;
    }
    at = cursor + after[0].length;
  }

  const tail = body.slice(at).trim();
  if (ctes.length === 0 || !/^SELECT\s/i.test(tail)) {
    throw new Error(`parsed ${String(ctes.length)} CTEs and a tail beginning ${tail.slice(0, 40)}.`);
  }
  return { ctes, tail };
}

/**
 * The statement rebuilt without one CTE, its join, and the output columns that read it.
 *
 * The columns go because a `SELECT` list referring to a dropped alias does not run, and they are found
 * by the alias the join binds rather than by their names: the aliases are one letter each and searching
 * the text for `c` would cut the statement to pieces. Every output expression mentioning the alias as a
 * whole word goes, and the count of what went is recorded beside the reading — a variant that dropped
 * more of the statement than it meant to is otherwise a fast number with nothing to say.
 *
 * Cutting an inner join is a different thing from cutting a left one and the caller is told which it
 * got. A LEFT JOIN contributes no rows, so the variant counts the same population; an inner join
 * restricts, so the variant counts a wider one and is a reading about a statement nobody ships. Still
 * worth taking — it is what says whether the reference or the restriction costs — but not worth
 * recording as though it were the same kind of cut, which is `AGENTS.md`'s apparatus rule.
 */
export function without(text, name) {
  const { ctes, tail } = parts(text);
  const kept = ctes.filter((one) => one.name !== name);
  if (kept.length === ctes.length) throw new Error(`${name} is not a CTE of this statement.`);

  const join = new RegExp(`^\\s*(LEFT\\s+)?JOIN\\s+${name}\\s+([a-z][a-z0-9_]*)\\s+ON[^\\n]*$`, 'im').exec(tail);
  if (join == null) throw new Error(`${name} is not joined in the final SELECT, so this cut is not defined.`);
  const alias = join[2];
  const widensPopulation = join[1] == null;

  const withoutJoin = tail.replace(join[0], '').replace(/\n{2,}/g, '\n');
  const head = /^SELECT\s([\s\S]*?)\nFROM\s/i.exec(withoutJoin);
  if (head == null) throw new Error('the final SELECT no longer has a FROM this can cut against.');

  const mentions = new RegExp(`\\b${alias}\\.`);
  const expressions = splitTopLevel(head[1]);
  const survivors = expressions.filter((one) => !mentions.test(one));
  if (survivors.length === 0) throw new Error(`every output column reads ${name}, so there is nothing left to time.`);

  const rebuilt =
    `WITH ${kept.map((one) => `${one.name} AS (\n${one.body}\n)`).join(',\n')}\n` +
    withoutJoin.replace(head[1], survivors.join(',\n'));
  return { statement: rebuilt, alias, widensPopulation, droppedColumns: expressions.length - survivors.length };
}

/**
 * A select list into its expressions, splitting on the commas that are not inside brackets.
 *
 * Line comments are skipped, and the reason is a probe this script refused on `large-estate`. The
 * statement's last-but-one output column is introduced by *"Not part of any share: it says how much
 * activity the population above was drawn from, which is the difference between a quiet estate and an
 * unread one."* The comma in that sentence split the comment in two, the first half became an
 * expression of its own, and — reading no alias — it survived every filter. For three of the four cuts
 * that was invisible, because a comment followed by a real column is legal wherever a column may go.
 * Cutting `reads` removed the column underneath it, leaving a comma before a comment before `FROM`,
 * and Spark answered `PARSE_SYNTAX_ERROR` after the eleven minutes it took to get there.
 *
 * Worth stating plainly, since the shape recurs: a splitter that does not know what a comment is will
 * agree with one that does on almost every input, and prose is where it stops agreeing.
 */
export function splitTopLevel(list) {
  const found = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < list.length; at += 1) {
    if (list.startsWith('--', at)) {
      const ends = list.indexOf('\n', at);
      if (ends === -1) break;
      at = ends;
      continue;
    }
    const character = list[at];
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      found.push(list.slice(start, at));
      start = at + 1;
    }
  }
  found.push(list.slice(start));
  return found.filter((one) => one.trim() !== '');
}

/** A probe, timed, with a refusal and a timeout kept apart rather than both thrown. */
async function probe(label, statement, parameters, deadline, polls = POLLS) {
  if (Date.now() > deadline) return { label, ok: false, ms: 0, skipped: 'the run budget was spent before this started' };
  const started = Date.now();
  process.stdout.write(`  ${label}... `);
  try {
    const rows = await runStatement(statement, parameters, polls);
    const ms = Date.now() - started;
    process.stdout.write(`${String(Math.round(ms / 1000))}s\n`);
    return { label, ok: true, ms, rows };
  } catch (error) {
    const ms = Date.now() - started;
    const text = String(error).slice(0, 300);
    process.stdout.write(`${/"state":"(RUNNING|PENDING)"/.test(text) ? 'unfinished' : 'failed'} after ${String(Math.round(ms / 1000))}s\n`);
    return { label, ok: false, ms, error: text };
  }
}

/** One of four words, keeping a poll-budget timeout apart from a refusal for `41d`'s reason. */
export function verdict(found) {
  if (found == null) return 'not probed';
  if (found.skipped != null) return 'not probed';
  if (found.ok === true) return 'ran';
  return /"state":"(RUNNING|PENDING)"/.test(found.error ?? '') ? 'unfinished' : 'refused';
}

/**
 * The parts, most expensive alone first, with a part that did not finish counted as the most expensive.
 *
 * A part that ran out of its own poll budget is the strongest candidate there is — it outlasted a cap its
 * neighbours cleared in seconds — so it sorts ahead of every part that returned a number rather than
 * falling to the bottom of a sort on a null. That is the same distinction `verdict` keeps: an unfinished
 * probe is a reading, and only a refusal is an absence.
 */
export function dearestFirst(ctes, alone) {
  const cost = new Map(
    alone.map((one) => [one.name, one.ok === true ? one.ms : verdict(one) === 'unfinished' ? Infinity : -1])
  );
  return [...ctes].sort((left, right) => (cost.get(right.name) ?? -1) - (cost.get(left.name) ?? -1));
}

function bindings() {
  return [
    { name: 'lookback_days', value: String(LOOKBACK_DAYS), type: 'INT' },
    { name: 'workspace_id', value: '', type: 'STRING' },
  ];
}

/** Only the parameters a statement actually mentions, since binding an unused one is rejected. */
function boundFor(statement) {
  return bindings().filter((one) => new RegExp(`:${one.name}\\b`).test(statement));
}

async function main() {
  refuseUnlessNamedForItsEstate(OUT, corpusSettings.profile, corpusSettings.host);

  const text = shipped();
  const { ctes } = parts(customerCatalog(text));
  const deadline = Date.now() + BUDGET_MS;
  process.stdout.write(`${String(ctes.length)} CTEs parsed: ${ctes.map((one) => one.name).join(', ')}\n`);

  // Each part alone, counted rather than returned. `count(*)` over the body makes the warehouse compute
  // the CTE and hand back one row, so the reading is the cost of the part and not of shipping it.
  process.stdout.write('each part alone:\n');
  const alone = [];
  for (const cte of ctes) {
    const statement = `SELECT count(*) AS rows FROM (\n${cte.body}\n)`;
    alone.push({
      name: cte.name,
      ...(await probe(cte.name, statement, boundFor(statement), deadline, PART_POLLS)),
    });
  }

  // The whole statement, so the parts have something to be parts of. Re-measured rather than quoted from
  // `45a`: that reading is from another session on a warehouse whose load nobody recorded, and a share of
  // a total taken an hour apart from its parts is a share of two different totals.
  process.stdout.write('the statement as shipped:\n');
  const whole = await probe('as shipped', customerCatalog(text), boundFor(text), deadline);

  // One part removed at a time, which is what separates a slow part from a part that makes the join slow.
  //
  // Dearest part first, and that ordering is the whole reason this loop does not simply walk `ctes`. Every
  // cut of a statement that costs an hour costs about an hour unless the cut is the expensive one, so a run
  // that walks the parts in source order spends its budget on the cuts that cannot move the total and may
  // reach the one that can with nothing left. Ordering by what each part cost alone puts the reading this
  // row exists for first, and leaves the budget to bite the cuts that would only have confirmed it.
  //
  // The first attempt at this run was stopped for exactly that: `columns` is the last of the four in the
  // source, so `without columns` was scheduled behind two cuts of roughly an hour each on an estate
  // `docs/estates.md` says to use sparingly.
  process.stdout.write('one part removed at a time:\n');
  const cuts = [];
  for (const cte of dearestFirst(ctes, alone)) {
    let cut;
    try {
      cut = without(text, cte.name);
    } catch (error) {
      cuts.push({ name: cte.name, undefinedBecause: String(error).slice(0, 200) });
      process.stdout.write(`  without ${cte.name}: not a defined cut — ${String(error).slice(0, 120)}\n`);
      continue;
    }
    const statement = customerCatalog(cut.statement);
    cuts.push({
      name: cte.name,
      droppedColumns: cut.droppedColumns,
      widensPopulation: cut.widensPopulation,
      ...(await probe(`without ${cte.name}`, statement, boundFor(statement), deadline)),
    });
  }

  const reading = {
    runFinishedAt: new Date().toISOString(),
    profile: corpusSettings.profile,
    host: corpusSettings.host,
    warehouse: corpusSettings.warehouse,
    lookbackDays: LOOKBACK_DAYS,
    statement: STATEMENT,
    // The text these readings are of. A recording that cannot say which version of the statement it
    // measured is a recording nobody can re-take, and this statement is one `61` expects to change.
    statementSha: shaOf(text),
    budget: {
      pollsPerPart: PART_POLLS,
      pollsPerStatement: POLLS,
      runBudgetMs: BUDGET_MS,
      spentMs: BUDGET_MS - (deadline - Date.now()),
    },
    whole: { verdict: verdict(whole), ms: whole.ok === true ? whole.ms : null, error: whole.error ?? null },
    parts: alone.map((one) => ({
      name: one.name,
      verdict: verdict(one),
      ms: one.ok === true ? one.ms : null,
      rows: one.ok === true ? Number(one.rows[0]?.['rows'] ?? 0) : null,
      error: one.error ?? null,
    })),
    withoutEachPart: cuts.map((one) => ({
      name: one.name,
      verdict: one.undefinedBecause != null ? 'not a defined cut' : verdict(one),
      ms: one.ok === true ? one.ms : null,
      droppedColumns: one.droppedColumns ?? null,
      widensPopulation: one.widensPopulation ?? null,
      undefinedBecause: one.undefinedBecause ?? null,
      error: one.error ?? null,
    })),
  };

  writeFileSync(OUT, `${JSON.stringify(reading, null, 2)}\n`);
  process.stdout.write(`\nwrote ${OUT}\n`);
}

function shaOf(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// Guarded so a test can import the parser and the cut without running a scan, which is every measurement
// script's shape. It matters more here than usual: the cut is the part most likely to be wrong, and a test
// of it is the only thing that says the variants describe the statement rather than a mangling of it.
if (process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
