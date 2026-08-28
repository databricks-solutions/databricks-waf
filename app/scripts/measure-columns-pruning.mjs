// What the planner must load to answer `DG-01-06`, under four predicate forms. Row `75`.
//
// `61b`'s first candidate is that a predicate on `table_catalog` lets the planner prune the metadata it
// loads for `system.information_schema.columns`, where the shipped subquery form does not. Nobody has
// tested it. It is a claim about one engine, and `70` is the row that established what happens when this
// family chooses a rework by feel: a restriction that was argued equivalent, was equivalent, and was
// slower than the statement it replaced because the hour is compilation and a `WHERE` clause is applied
// to rows.
//
// So this measures compilation directly, from the platform's own query history rather than a wall clock,
// for a probe that references `columns` and nothing else:
//
//   1. `shipped`     — the `NOT IN (SELECT ...)` predicate `queries.ts` expands today
//   2. `literal one` — a single-catalog equality, the strongest form a planner could prune on
//   3. `literal in`  — every customer catalog as a literal list, which is the form `61b` could actually ship
//   4. `no predicate`— the floor, so "the subquery is the problem" is separable from "the reference is"
//
// Alongside them, how the estate's relations distribute across catalogs, because a predicate that prunes
// perfectly still saves nothing if the catalogues it keeps hold most of the columns.
//
// **Sparingly, and cancellably.** `docs/estates.md` has `large-estate` as shared and for measurement only,
// and `70` spent three hours of it and then killed its client, which does not cancel a statement — the
// warehouse finished the abandoned form eighteen minutes later. Both of that row's apparatus faults are
// fixed here because this is the run that would repeat them: each probe carries its own deadline and
// posts a real cancel when it passes, and the recording is written after every probe rather than at the
// end. The cheap forms run first, so a budget spent on the expensive one is spent knowing what it buys.
//
// Reads catalogue metadata and this run's own query history. No query text of anybody else's, no table
// contents, no sample rows.
//
// Run: cd app && DATABRICKS_HOST=... DATABRICKS_WAREHOUSE_ID=... DATABRICKS_CONFIG_PROFILE=large-estate \
//        node scripts/measure-columns-pruning.mjs
//
// Writes `server/collect/sql/runtime-baseline/<profile>-columns-pruning.json`.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { call, corpusSettings, runStatement } from './plan-corpus.mjs';
import { refuseUnlessNamedForItsEstate } from './recording-guards.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(
  HERE,
  '..',
  'server',
  'collect',
  'sql',
  'runtime-baseline',
  `${corpusSettings.profile}-columns-pruning.json`
);

/**
 * How long one probe may run before it is cancelled.
 *
 * Fifteen minutes, and it is a bound on somebody else's warehouse rather than a guess at the answer. It is
 * also enough to decide the question: `61b` chooses the pruning candidate only if a form compiles *in
 * seconds* where the shipped one compiles in minutes, so a form still running at fifteen minutes has
 * answered — it is not the candidate — and running it to completion would only say by how much.
 */
const PROBE_MS = Number(process.env.PROBE_MS ?? 15 * 60 * 1000);

/**
 * Mirrors `queries.ts`'s `customerCatalogPredicate`, as eight other scripts mirror it.
 *
 * A copy because this file runs under plain Node and cannot import the app's TypeScript.
 * `queries.test.ts` reads this source and fails when it stops saying what the original says, which is
 * the check row `80` added after finding the sentence wrong in all nine at once.
 */
const CUSTOMER_CATALOG = (column) =>
  `(${column} NOT IN (SELECT catalog_name FROM system.information_schema.catalogs ` +
  `WHERE catalog_owner = 'System user') AND lower(${column}) NOT IN ('system', 'samples')` +
  ` AND NOT startswith(lower(${column}), '__databricks_internal'))`;

/** The predicate `queries.ts` expands, which is the form the `shipped` probe below is timing. */
const SHIPPED_PREDICATE = CUSTOMER_CATALOG('table_catalog');

/** The customer catalogs, by the same rule, as names rather than as a predicate. */
const CATALOGS = `
SELECT t.table_catalog AS name, count(*) AS relations
FROM system.information_schema.tables t
WHERE ${CUSTOMER_CATALOG('t.table_catalog')}
GROUP BY ALL
ORDER BY relations DESC`;

/** A probe reads `columns` and nothing else, so what it times is the reference rather than a statement. */
const probeFor = (predicate) =>
  `SELECT count(*) AS columns_seen FROM system.information_schema.columns${predicate === '' ? '' : `\nWHERE ${predicate}`}`;

const quoted = (name) => `'${name.replace(/'/g, "''")}'`;

/**
 * Submits, polls to its own deadline, and cancels rather than abandoning.
 *
 * The cancel is the part `70` did not have. A killed client leaves the warehouse working, so an abandoned
 * probe costs the estate everything the probe would have cost and yields nothing — which is `61a`'s finding
 * met from the other side, and it happened while measuring `61a`'s own statement.
 *
 * Returns the statement id whether or not it finished, because the query-history read below is the
 * measurement and a cancelled statement still has compilation recorded against it.
 */
async function probe(label, statement) {
  process.stdout.write(`  ${label}... `);
  const started = Date.now();
  const submitted = await call('/api/2.0/sql/statements', {
    method: 'POST',
    body: JSON.stringify({
      statement,
      warehouse_id: corpusSettings.warehouse,
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
      wait_timeout: '0s',
    }),
  });

  const id = submitted.statement_id;
  let state = submitted.status?.state ?? 'PENDING';
  let last = submitted;

  while (state === 'PENDING' || state === 'RUNNING') {
    if (Date.now() - started > PROBE_MS) {
      await call(`/api/2.0/sql/statements/${id}/cancel`, { method: 'POST' }).catch(() => undefined);
      process.stdout.write(`cancelled at ${String(Math.round((Date.now() - started) / 1000))}s\n`);
      return { label, statementId: id, verdict: 'cancelled', wallMs: Date.now() - started };
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    last = await call(`/api/2.0/sql/statements/${id}`, { method: 'GET' });
    state = last.status?.state ?? 'PENDING';
  }

  const wallMs = Date.now() - started;
  if (state !== 'SUCCEEDED') {
    process.stdout.write(`${state.toLowerCase()} after ${String(Math.round(wallMs / 1000))}s\n`);
    return {
      label,
      statementId: id,
      verdict: state === 'CANCELED' ? 'cancelled' : 'failed',
      wallMs,
      error: JSON.stringify(last.status?.error ?? null).slice(0, 400),
    };
  }

  process.stdout.write(`${String(Math.round(wallMs / 1000))}s\n`);
  return {
    label,
    statementId: id,
    verdict: 'ran',
    wallMs,
    columnsSeen: Number(last.result?.data_array?.[0]?.[0] ?? Number.NaN),
  };
}

/**
 * What the platform says each probe spent, which is the reading — the wall clock above is not.
 *
 * `70`'s whole finding is the split: 3,979,324 ms of a 3,984,316 ms run was compilation. A wall clock
 * cannot see that, and a rework chosen against a wall clock is the rework `70` reverted.
 *
 * Read after every probe has finished rather than per probe, because history lands asynchronously and
 * polling for a row that has not been written yet is another thing to get wrong.
 */
async function history(ids) {
  if (ids.length === 0) return new Map();
  const list = ids.map((id) => quoted(id)).join(', ');
  const rows = await runStatement(`
    SELECT statement_id, execution_status, total_duration_ms, compilation_duration_ms,
           execution_duration_ms, waiting_for_compute_duration_ms, read_bytes, read_files
    FROM system.query.history
    WHERE statement_id IN (${list})`);
  return new Map(rows.map((row) => [row.statement_id, row]));
}

const millis = (row, field) => (row?.[field] == null ? null : Number(row[field]));

refuseUnlessNamedForItsEstate(OUT, corpusSettings.profile, corpusSettings.host);

const recording = {
  what: 'What the planner must load to reference system.information_schema.columns, for row 75.',
  measuredAt: new Date().toISOString(),
  profile: corpusSettings.profile,
  host: corpusSettings.host,
  warehouseId: corpusSettings.warehouse,
  probeDeadlineMs: PROBE_MS,
  forms: [],
};
const save = () => writeFileSync(OUT, `${JSON.stringify(recording, null, 2)}\n`);
save();

console.log(`counting the estate's catalogs on ${corpusSettings.host}...`);
const catalogs = await runStatement(CATALOGS);
const relations = catalogs.reduce((sum, one) => sum + Number(one.relations), 0);
recording.estate = {
  customerCatalogs: catalogs.length,
  customerRelations: relations,
  // The distribution, because a predicate that prunes perfectly saves nothing if what it keeps is most of
  // the estate. Ten is enough to see a head; the whole list would be 2,886 rows of somebody else's names.
  largestTen: catalogs.slice(0, 10).map((one) => ({ catalog: one.name, relations: Number(one.relations) })),
  shareInLargestTen:
    relations === 0 ? null : catalogs.slice(0, 10).reduce((sum, one) => sum + Number(one.relations), 0) / relations,
};
save();
console.log(`  ${String(catalogs.length)} customer catalogs, ${String(relations)} relations`);

const names = catalogs.map((one) => one.name);
const literalIn = names.length === 0 ? null : `table_catalog IN (${names.map((name) => quoted(name)).join(', ')})`;
const literalOne = names.length === 0 ? null : `table_catalog = ${quoted(names[0])}`;

/*
 * Cheapest-looking first, and it is not politeness. If `literal one` compiles in seconds the question is
 * already answered in the direction `61b` hoped for, and every probe after it is confirmation bought with
 * somebody else's warehouse. If it does not, the expensive ones are worth running and the run knows why.
 */
const forms = [
  ['literal one', literalOne],
  ['literal in', literalIn],
  ['shipped', SHIPPED_PREDICATE],
  ['no predicate', ''],
];

console.log(`four forms, each cancelled at ${String(Math.round(PROBE_MS / 60000))} minutes:`);
for (const [label, predicate] of forms) {
  if (predicate == null) {
    recording.forms.push({ label, verdict: 'not probed', why: 'the estate returned no customer catalogs' });
    save();
    continue;
  }
  recording.forms.push({ label, predicateChars: predicate.length, ...(await probe(label, probeFor(predicate))) });
  save();
}

console.log('reading what the platform says each one spent...');
const spent = await history(recording.forms.map((form) => form.statementId).filter((id) => id != null));
for (const form of recording.forms) {
  const row = spent.get(form.statementId);
  form.platform =
    row == null
      ? null
      : {
          status: row.execution_status,
          totalMs: millis(row, 'total_duration_ms'),
          compilationMs: millis(row, 'compilation_duration_ms'),
          executionMs: millis(row, 'execution_duration_ms'),
          waitingForComputeMs: millis(row, 'waiting_for_compute_duration_ms'),
          readBytes: millis(row, 'read_bytes'),
          readFiles: millis(row, 'read_files'),
        };
}
save();

console.log('');
for (const form of recording.forms) {
  const compilation = form.platform?.compilationMs;
  console.log(
    `  ${form.label.padEnd(14)} ${String(form.verdict).padEnd(10)} ` +
      `compilation ${compilation == null ? 'unrecorded' : `${String(compilation)} ms`}`
  );
}
console.log(`\nWrote ${OUT.slice(OUT.indexOf('app/'))}.`);
