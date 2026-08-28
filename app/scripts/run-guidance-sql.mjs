// Runs every `how: sql` verify step in config/guidance/ against a real warehouse.
//
// A verification step that does not parse is worse than none: the reader runs it, gets an error, and
// concludes the guidance is wrong about their estate rather than about its own SQL. Nothing else in
// the tree catches that, because a `where` clause is a string as far as the schema is concerned.
//
// Not part of `npm run verify` and it cannot be: it needs a warehouse and credentials, so it is a
// tool you run by hand when you author or edit a verify step.
//
//   DATABRICKS_WAREHOUSE_ID=<id> npm run guidance:sql -- [pillar-name-fragment]

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

const WAREHOUSE = process.env.DATABRICKS_WAREHOUSE_ID?.trim();
const PROFILE = process.env.DATABRICKS_CONFIG_PROFILE?.trim() ?? 'DEFAULT';
const DIRECTORY = 'config/guidance';
const only = process.argv[2];

if (WAREHOUSE == null || WAREHOUSE === '') {
  console.error('Set DATABRICKS_WAREHOUSE_ID to a warehouse these statements can run against.');
  console.error('DATABRICKS_CONFIG_PROFILE selects the CLI profile, and defaults to DEFAULT.');
  process.exit(2);
}

function run(statement) {
  const body = JSON.stringify({
    warehouse_id: WAREHOUSE,
    statement,
    wait_timeout: '50s',
    format: 'JSON_ARRAY',
    disposition: 'INLINE',
  });
  try {
    const result = JSON.parse(
      execFileSync('databricks', ['api', 'post', '/api/2.0/sql/statements', '-p', PROFILE, '--json', body], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    );
    if (result.status?.state !== 'SUCCEEDED') {
      return { ok: false, why: result.status?.error?.message ?? String(result.status?.state) };
    }
    return { ok: true, rows: (result.result?.data_array ?? []).length };
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message.split('\n')[0] : String(error) };
  }
}

let failures = 0;
for (const name of readdirSync(DIRECTORY).filter((one) => one.endsWith('.yaml')).sort()) {
  if (only != null && !name.includes(only)) continue;
  const file = load(readFileSync(join(DIRECTORY, name), 'utf8'));
  for (const [controlId, entry] of Object.entries(file?.entries ?? {})) {
    if (entry?.status !== 'authored') continue;
    for (const check of entry.verify ?? []) {
      if (check.how !== 'sql') continue;
      // A step written as a template for the reader to fill in cannot be run here.
      if (/<[^>]+>/.test(check.where)) {
        console.log(`skip ${controlId}  template: ${check.where.slice(0, 60).replace(/\s+/g, ' ')}`);
        continue;
      }
      const outcome = run(check.where);
      if (outcome.ok) {
        console.log(`ok   ${controlId}  ${String(outcome.rows)} rows`);
      } else {
        failures += 1;
        console.log(`FAIL ${controlId}  ${outcome.why}`);
        console.log(`     ${check.where.replace(/\s+/g, ' ')}`);
      }
    }
  }
}

console.log(failures === 0 ? '\nEvery runnable sql step parsed.' : `\n${String(failures)} steps do not run.`);
process.exit(failures === 0 ? 0 : 1);
