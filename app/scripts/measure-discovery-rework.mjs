// Whether `61b`'s rework returns the same row as the statement it replaces, and how much faster. Row `61b`.
//
// **The rework this measures was rejected and reverted.** It is kept because it is the apparatus behind
// two committed recordings, and it does not run against `main` as it stands: `shipped()` reads the
// statement from disk, and with the restriction reverted the first form is the third and `columnsOnly`
// throws. Re-applying the change is what makes it runnable. The reading and what it decided are in
// `docs/plan/61-discovery-statement-cost.md`; the short version is that the statement's hour is
// compilation, so a restriction applied to rows cannot reach it.
//
// A third defect, found later and fixed here rather than in this file: it called both recording guards with
// the arguments in the wrong order and discarded what they returned, so on the one script that spent three
// hours of a shared estate neither could fire. `79` is the row, and the fix is that the guards are now
// applied by one function that throws — see `recording-guards.mjs`.
//
// Two defects of its own, neither of which moved a number and both of which cost the `large-estate` run.
// It writes its recording once, after all three forms, so killing it loses every form that had landed —
// that run was killed at the third and its recording had to be assembled from query history afterwards.
// And a killed client does not cancel a statement: the warehouse finished the abandoned form eighteen
// minutes later, which is `61a`'s own finding met from the other side.
//
// `61a` measured where the sixty-seven minutes went: the `columns` CTE, at 98.7% of the statement,
// aggregating the columns of all 495,468 tables in the estate so the final SELECT could read 24,714 of
// them. The rework restricts `columns` and `tagged` to the tables `reads` names.
//
// **The speed is the easy half and it is not the half that needs measuring.** A statement that is faster
// because it counts fewer things is what `AGENTS.md` and this row's own plan both warn about: DG-01-06
// would keep its id and quietly score a different population. The argument that the restriction cannot
// change the result is short and checkable — every output column touching `c` or `g` sits inside
// `CASE WHEN r.full_name IS NOT NULL`, so a row for a table nothing read is joined and multiplied by zero
// — but a short argument that a rewrite is equivalent is exactly the kind of claim that reads as true
// whether or not it is. Two of the three defects this repository has paid most for were that.
//
// So this runs both forms against the same estate in the same session and compares every field of the
// row, and the recording carries the comparison rather than only the durations. If they differ, the
// rework is wrong and the speed is irrelevant.
//
// The "before" is read from git rather than transcribed, so it is definitively the statement that was
// shipped rather than someone's memory of it. `41d`'s apparatus error was a fixture that did not match
// the statement it claimed to describe; a transcription here would be the same mistake with fewer steps.
//
// Reads catalogue metadata and system tables. No query text, no table contents, no sample rows.
//
// Run: cd app && DATABRICKS_HOST=... DATABRICKS_WAREHOUSE_ID=... DATABRICKS_CONFIG_PROFILE=large-estate \
//        node scripts/measure-discovery-rework.mjs
//
// Writes `server/collect/sql/runtime-baseline/<profile>-discovery-rework.json`.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { customerCatalog, shipped } from './measure-discovery-cost.mjs';
import { corpusSettings, runStatement } from './plan-corpus.mjs';
import { refuseUnlessNamedForItsEstate } from './recording-guards.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINES = join(HERE, '..', 'server', 'collect', 'sql', 'runtime-baseline');
const OUT = join(BASELINES, `${corpusSettings.profile}-discovery-rework.json`);

const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 30);

/** Ninety minutes, because the form being replaced took sixty-seven of them on this estate. */
const POLLS = 2700;

/** The statement as `main` holds it, which is the thing being replaced. */
export function beforeRework(ref = 'origin/main') {
  const path = 'app/config/statements/uc_discovery_metadata.sql';
  return execFileSync('git', ['show', `${ref}:${path}`], { cwd: join(HERE, '..', '..'), encoding: 'utf8' })
    .replace(/;\s*$/, '')
    .trim();
}

/** The restriction, as it appears on whichever CTE carries it. */
const RESTRICTION = (columns) =>
  `\n    AND concat_ws('.', ${columns}) IN (SELECT full_name FROM reads)`;

/**
 * The reworked statement with `tagged`'s restriction taken back off.
 *
 * A third form, because the two restrictions are not one decision. Each reference to `reads` is a
 * reference to a CTE, and Spark inlines a CTE per reference rather than computing it once — measured on
 * labs, the statement costs 6.1s as shipped, 8.6s with `columns` restricted and 10.0s with both, which
 * is `reads` being computed a second and a third time at about 2.3s each. So restricting `tagged` buys
 * whatever `tagged` costs on a large estate and always costs one more evaluation of `reads`, and
 * whether that trade is worth taking is a question about the estate rather than about the SQL.
 */
export function columnsOnly(text) {
  const without = text.replace(RESTRICTION('catalog_name, schema_name, table_name'), '');
  if (without === text) throw new Error("tagged no longer carries the restriction this variant removes.");
  return without;
}

/**
 * Whether two result rows say the same thing, field by field.
 *
 * Compared as strings because the API returns every column as one, and reported as the fields that
 * differ rather than as a boolean: "the rows differ" sends the reader back to the warehouse, and
 * "`read_table_columns` is 812,004 against 812,004 but `read_tables` is 24,714 against 24,713" does not.
 */
export function fieldsThatDiffer(before, after) {
  const names = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  return names
    .filter((name) => String(before?.[name]) !== String(after?.[name]))
    .map((name) => ({ field: name, before: before?.[name] ?? null, after: after?.[name] ?? null }));
}

async function timed(label, statement, parameters) {
  const started = Date.now();
  process.stdout.write(`  ${label}... `);
  try {
    const rows = await runStatement(statement, parameters, POLLS);
    const ms = Date.now() - started;
    process.stdout.write(`${String(Math.round(ms / 1000))}s\n`);
    return { label, ok: true, ms, row: rows[0] ?? null, rows: rows.length };
  } catch (error) {
    const ms = Date.now() - started;
    process.stdout.write(`failed after ${String(Math.round(ms / 1000))}s\n`);
    return { label, ok: false, ms, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  refuseUnlessNamedForItsEstate(OUT, corpusSettings.profile, corpusSettings.host);

  const parameters = [
    { name: 'lookback_days', value: String(LOOKBACK_DAYS), type: 'INT' },
    { name: 'workspace_id', value: '', type: 'STRING' },
  ];

  console.log(`comparing on ${corpusSettings.profile}, ${String(LOOKBACK_DAYS)}-day window:`);

  /*
   * The reworked forms first, and the shipped one last. If a restriction is wrong the run is short and
   * the mistake is found in a minute rather than after the hour the shipped form takes on a large
   * estate; and if they are right, that hour is spent knowing what it is buying. It has to be spent
   * either way, because identity is the claim being made and there is nothing to compare against
   * without it.
   */
  const reworked = await timed('both restricted', customerCatalog(shipped()), parameters);
  const partial = await timed('columns only', customerCatalog(columnsOnly(shipped())), parameters);
  const before = await timed('as shipped', customerCatalog(beforeRework()), parameters);

  const against = (one) => (before.ok && one.ok ? fieldsThatDiffer(before.row, one.row) : null);
  const forms = [
    { name: 'both restricted', ...reworked, differences: against(reworked) },
    { name: 'columns only', ...partial, differences: against(partial) },
  ];

  const recording = {
    runFinishedAt: new Date().toISOString(),
    profile: corpusSettings.profile,
    host: corpusSettings.host,
    warehouse: corpusSettings.warehouse,
    lookbackDays: LOOKBACK_DAYS,
    statement: 'uc_discovery_metadata',
    asShipped: {
      verdict: before.ok ? 'ran' : 'failed',
      ms: before.ok ? before.ms : null,
      error: before.error ?? null,
      row: before.row ?? null,
    },
    forms: forms.map((one) => ({
      name: one.name,
      verdict: one.ok ? 'ran' : 'failed',
      ms: one.ok ? one.ms : null,
      error: one.error ?? null,
      identical: one.differences == null ? null : one.differences.length === 0,
      differences: one.differences,
    })),
  };

  writeFileSync(OUT, `${JSON.stringify(recording, null, 2)}\n`);
  console.log(`\nwrote ${OUT}`);

  const wrong = forms.filter((one) => one.differences != null && one.differences.length > 0);
  for (const one of wrong) {
    console.error(`\n"${one.name}" does not return the same row, so its speed does not matter:`);
    for (const d of one.differences) console.error(`  ${d.field}: ${String(d.before)} -> ${String(d.after)}`);
  }
  if (wrong.length > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
