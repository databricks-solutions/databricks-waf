#!/usr/bin/env node
// Does every statement declare how many rows it can return, and is that number a constant?
//
// `statements.ts` asks the Statement Execution API for `INLINE` results, and justified it with a
// comment asserting that every statement in `config/statements` is "an aggregate or an explicitly
// capped detail query". Eight of nineteen were neither. The two worst return one row per job and one
// row per cluster with no `LIMIT` and no `GROUP BY`, against declared scale targets of 100,000 and
// 50,000 — and `system.compute.clusters` holds a row per job-cluster definition, so that second
// number runs ahead of any fleet a customer would recognise.
//
// Why this needs a check and not two edits. An inline result is capped at 25 MiB and **fails** past
// the cap rather than truncating, so the bigger the estate the likelier the customer gets no
// assessment instead of a smaller one. Every other limit in the scan degrades and says so: a surface
// budget records why it stopped, a sampled tier declares its sample. This one falls over, and it
// falls over first for the largest customers. Fixing the two known statements leaves the mechanism
// that produced them intact, and the next inventory query somebody adds is written the same way.
//
// It is a declaration gate rather than an analysis. Deciding whether an arbitrary SQL statement's
// result grows with its input is not something a script can do, and a script that guesses either
// blocks correct work or waves through the next `jobs_inventory`. So the author declares, in a
// header a reviewer reads, and two things hold them to it: this check refuses an undeclared
// statement or a newly estate-scaled one, and `bounds.ts` refuses at runtime a statement that
// returned more rows than it declared.
//
// The manifest below is the eight that already grow with the estate. It exists so the check can be
// switched on today rather than after the rework, and it is written to only ever shrink: an entry
// for a statement that has since been bounded fails just as loudly as a statement missing from it.
// An allowlist that can grow is how a check becomes a thing that always passes.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATEMENTS = join(HERE, '..', 'config', 'statements');

/**
 * The statements whose row count grows with the estate, and what each is waiting on.
 *
 * Every entry is a defect, tracked as H1 in docs/plan-status.md. Removing one is the goal; adding
 * one requires arguing here, in a file whose whole comment says not to.
 */
const ESTATE_SCALED = {
  jobs_inventory: 'one row per job, against a declared target of 100,000',
  compute_cluster_inventory: 'one row per cluster, against 50,000, and the table holds a row per job-cluster definition',
  compute_warehouse_inventory: 'one row per warehouse, against 1,000 — the shape is wrong rather than the size',
  lakeflow_pipeline_inventory: 'one row per pipeline',
  uc_catalog_inventory: 'one row per catalog, where uc_schema_census beside it already caps',
  workspace_directory: 'one row per workspace, against 500, and every account-reach filter depends on it',
  serverless_job_readiness: 'one row per job that ran on classic compute in the window',
  serverless_job_spend: 'one row per job and SKU family',
};

const DECLARATION = /^--\s*Rows:\s*(.+?)\s*$/im;
const FIXED = /^(?:at most )?(\d+)$/i;
const PARAMETERISED = /^at most :([a-z_][a-z0-9_]*)$/i;
const ONE_PER = /^one per ([a-z][a-z0-9 _-]*)$/i;

/**
 * A ceiling above which a fixed declaration is not really a ceiling.
 *
 * A statement declaring `at most 500000` has satisfied the letter of this check and none of its
 * point. The number is deliberately well under any plausible inline row count, because the only
 * legitimate fixed bounds here are platform vocabularies — operation types, billing products — and
 * those are tens of rows. Anything wanting more should be parameterised, so the cap is visible to
 * the collector and tunable without a code change.
 */
const FIXED_CEILING = 1000;

const files = readdirSync(STATEMENTS)
  .filter((name) => name.endsWith('.sql'))
  .sort();

const problems = [];
const scaled = new Set();

for (const file of files) {
  const name = file.replace(/\.sql$/, '');
  const text = readFileSync(join(STATEMENTS, file), 'utf8');
  const declaration = DECLARATION.exec(text);

  if (declaration == null) {
    problems.push(
      `${file} declares no row bound.\n` +
        `  Add a '-- Rows:' line to its header, directly under '-- Signal:'. One of:\n` +
        `    -- Rows: 1                        an aggregate returning a single row\n` +
        `    -- Rows: at most 40               a fixed count, from a platform vocabulary\n` +
        `    -- Rows: at most :table_limit     capped by a parameter the collector binds\n` +
        `    -- Rows: one per table            grows with the estate, and needs an entry in this script`
    );
    continue;
  }

  const value = declaration[1];
  const fixed = FIXED.exec(value);
  const parameterised = PARAMETERISED.exec(value);
  const onePer = ONE_PER.exec(value);

  if (fixed != null) {
    if (Number(fixed[1]) > FIXED_CEILING) {
      problems.push(
        `${file} declares 'Rows: ${value}', which is a number rather than a bound.\n` +
          `  Fixed declarations are for platform vocabularies, which are tens of rows. Anything\n` +
          `  larger should be 'at most :some_limit', so the collector binds the cap and it can be\n` +
          `  tuned without editing SQL.`
      );
    }
  } else if (parameterised != null) {
    // A declared cap parameter has to be the statement's actual cap, not a name that reads like one.
    // `-- Rows: at most :made_up_limit` satisfied every layer of this before: the regex above matched,
    // the `bind exactly the parameters their text uses` test strips comment lines so it never saw the
    // parameter, and the runtime treated an unbound cap as nothing to enforce. Three checks agreeing
    // that a declaration is fine because none of them could see it.
    const parameter = parameterised[1];
    if (!new RegExp(String.raw`\bLIMIT\s+:${parameter}\b`, 'i').test(sql(text))) {
      problems.push(
        `${file} declares 'Rows: ${value}', and nothing in the statement is capped by :${parameter}.\n` +
          `  The declaration has to name the parameter that does the capping, so write ':${parameter}'\n` +
          `  into a LIMIT or declare the bound the statement really has. As written the header is\n` +
          `  decorative: 'bind exactly the parameters their text uses' strips comments and never sees\n` +
          `  it, and the runtime has no value to hold the statement to.`
      );
    }
  } else if (onePer == null) {
    problems.push(
      `${file} declares 'Rows: ${value}', which is not a form this check understands.\n` +
        `  Use '1', 'at most <number>', 'at most :<parameter>', or 'one per <thing>'.`
    );
  }

  if (onePer != null) scaled.add(name);
}

// Both directions, because a manifest that only catches additions is a manifest that grows stale in
// the useful direction: the entry left behind after a statement is fixed is what tells the next
// reader the work is still owed when it is not.
for (const name of scaled) {
  if (!(name in ESTATE_SCALED)) {
    problems.push(
      `${name}.sql declares a row count that grows with the estate, and is not in this script's\n` +
        `  ESTATE_SCALED manifest.\n` +
        `  An inline result is capped at 25 MiB and fails past it rather than truncating, so this\n` +
        `  statement stops the whole scan on a large enough customer. Aggregate it, or cap it with a\n` +
        `  bound parameter as uc_schema_census does.\n` +
        `  Adding it to the manifest is not the fix. That list is eight statements written before\n` +
        `  this check existed and is meant to shrink.`
    );
  }
}

for (const name of Object.keys(ESTATE_SCALED)) {
  if (!files.includes(`${name}.sql`)) {
    problems.push(`${name} is in the ESTATE_SCALED manifest and has no file. Remove the entry.`);
  } else if (!scaled.has(name)) {
    problems.push(
      `${name}.sql no longer declares an estate-scaled row count, so it should come off the\n` +
        `  ESTATE_SCALED manifest in this script — and off the H1 list in docs/plan-status.md.`
    );
  }
}

if (problems.length > 0) {
  process.stderr.write(`\nStatement row bounds:\n\n${problems.map((problem) => `  ${problem}`).join('\n\n')}\n\n`);
  process.exit(1);
}

/**
 * A statement with its comment lines removed, so a cap mentioned in prose is not read as a cap.
 *
 * Whole lines only, matching `bind exactly the parameters their text uses`, which is the test this
 * check composes with: it proves the statement's parameters are the ones the collector binds, and the
 * cap search here proves the declared one is among them. `uc_catalog_inventory` is why this is not
 * optional — its header explains that `uc_schema_census` beside it carries `LIMIT :segment_limit`, and
 * searching the raw text would find that sentence.
 */
function sql(text) {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

const bounded = files.length - scaled.size;
process.stdout.write(
  `Every statement declares its row bound: ${String(bounded)} of ${String(files.length)} bounded, ` +
    `${String(scaled.size)} still growing with the estate (H1).\n`
);
