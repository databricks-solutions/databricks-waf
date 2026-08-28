// Submits every statement on the awaiting-reading list to a warehouse and records what came back.
//
// Not a measurement. These statements read a system schema the calibration estate does not have, so
// they cannot return rows there and have no duration to publish — that is what puts them on the list.
// What this takes is the weaker fact the list was silently doing without: the platform read the
// statement and failed somewhere past parsing. Row 77 exists because one of them did not, for as long
// as it was exempt.
//
// By hand, against a bound warehouse, for ADR 0090's reasons — CI has no warehouse, and a pull request
// from a fork cannot be given one.
//
//   DATABRICKS_CONFIG_PROFILE=your-profile DATABRICKS_WAREHOUSE_ID=<id> npm run record:awaiting

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AWAITING, STATEMENTS, entries, shaOf } from './awaiting-reading.mjs';

const WAREHOUSE = process.env.DATABRICKS_WAREHOUSE_ID?.trim() ?? '';
const PROFILE = process.env.DATABRICKS_CONFIG_PROFILE?.trim() || 'labs';

if (WAREHOUSE === '') {
  console.error('Set DATABRICKS_WAREHOUSE_ID, and DATABRICKS_CONFIG_PROFILE if not labs.');
  process.exit(2);
}

/**
 * What each parameter is bound to, and why the values are placeholders rather than a population.
 *
 * A submission asks one question — did the platform read this statement — and the answer does not
 * depend on what the parameters hold. Binding a real serving population would make the record look
 * like a reading of something, which it is not: the schema these statements read is absent, so no
 * binding produces rows. The bindings are written into the record so nobody has to guess what was
 * sent, and the types are the ones `measure-sql-baseline.mjs` binds for the same names, because a
 * type mismatch fails before table resolution and would look like the defect this is here to catch.
 */
const BINDINGS = {
  lookback_days: { value: '30', type: 'INT' },
  workspace_id: { value: '', type: 'STRING' },
  live_workspace_ids: { value: '', type: 'STRING' },
  serving_assets: { value: 'main.default.placeholder', type: 'STRING' },
  serving_limit: { value: '2000', type: 'INT' },
  serving_names: { value: '', type: 'STRING' },
  serving_tag_keys: { value: '', type: 'STRING' },
};

const host = hostOf(PROFILE);
const token = tokenOf(PROFILE);
const list = entries();
const file = JSON.parse(readFileSync(AWAITING, 'utf8'));
const at = new Date().toISOString();

for (const name of Object.keys(list)) {
  const path = join(STATEMENTS, `${name}.sql`);
  const text = readFileSync(path, 'utf8');
  const names = declared(text);
  process.stdout.write(`submitting ${name} (${names.join(', ') || 'no parameters'})...\n`);

  const response = await fetch(`${host}/api/2.0/sql/statements`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      statement: text,
      warehouse_id: WAREHOUSE,
      wait_timeout: '50s',
      on_wait_timeout: 'CANCEL',
      format: 'JSON_ARRAY',
      parameters: names.map((one) => ({ name: one, ...binding(one) })),
    }),
  });
  const body = await response.json();
  const state = body.status?.state ?? (response.ok ? 'UNKNOWN' : 'HTTP_ERROR');

  // A success is not a result this list can hold. The statement returned rows, so it has a duration
  // and belongs in the Q1a recording rather than here, and the gate says the same from the other side.
  if (state === 'SUCCEEDED') {
    console.error(
      `${name} succeeded against ${PROFILE}. It is no longer awaiting a reading — measure it with ` +
        'measure-sql-baseline.mjs and delete its entry from awaiting-reading.json.'
    );
    process.exit(1);
  }

  const error = body.status?.error?.message ?? JSON.stringify(body.status ?? body);
  const sqlState = body.status?.sql_state ?? sqlStateIn(error) ?? '';
  file.statements[name] = {
    ...list[name],
    submitted: {
      at,
      profile: PROFILE,
      warehouseId: WAREHOUSE,
      statementSha: shaOf(text),
      sqlState,
      // The first line of the platform's message, which is where the bracketed error name is. The rest
      // is the echoed statement on a parse failure, and a recording that carried it would be a copy of
      // the file it sits beside.
      error: error.split('\n').find((line) => line.trim() !== '')?.trim() ?? '',
      parameters: Object.fromEntries(names.map((one) => [one, binding(one).value])),
    },
  };
  process.stdout.write(`  ${state} ${sqlState} — ${String(file.statements[name].submitted.error).slice(0, 120)}\n`);
}

writeFileSync(AWAITING, `${JSON.stringify(file, null, 2)}\n`);
process.stdout.write(`\nRecorded ${String(Object.keys(list).length)} submissions in ${AWAITING.slice(AWAITING.indexOf('app/'))}.\n`);

/** Every `:name` outside a line comment, which is what the baseline pack reads too. */
function declared(text) {
  const found = new Set();
  for (const match of text.replace(/--[^\n]*/g, '').matchAll(/:([a-z_][a-z0-9_]*)/g)) found.add(match[1]);
  return [...found].sort();
}

function binding(name) {
  const found = BINDINGS[name];
  if (found == null) throw new Error(`No binding is known for :${name}. Add one beside the others.`);
  return found;
}

/** The SQLSTATE out of the message, for the responses that carry it there and not as a field. */
function sqlStateIn(message) {
  return /SQLSTATE:\s*([0-9A-Z]{5})/.exec(message)?.[1];
}

function hostOf(profile) {
  const config = readFileSync(join(process.env.HOME ?? '', '.databrickscfg'), 'utf8');
  const section = new RegExp(`^\\[${profile}\\]([^\\[]*)`, 'm').exec(config)?.[1] ?? '';
  const host = /^\s*host\s*=\s*(\S+)/m.exec(section)?.[1];
  if (host == null) throw new Error(`No host for profile ${profile} in ~/.databrickscfg.`);
  return host.replace(/\/$/, '');
}

function tokenOf(profile) {
  return JSON.parse(execFileSync('databricks', ['auth', 'token', '-p', profile], { encoding: 'utf8' })).access_token;
}
