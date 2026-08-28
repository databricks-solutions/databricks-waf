// What the scheduled assessment's own identity needs, read from this tree and checked against a
// workspace.
//
// `docs/scheduled-scans.md` used to be the only place the answer lived: a list of grants in prose,
// copied by hand. Two things go wrong with that and both were measured rather than imagined. The
// list drifts from the statements the app actually runs, and nothing notices, because a schema
// nobody granted reads as an unmeasured requirement rather than as an error. And a principal that
// is short one grant produces a run that looks like an assessment — the app scores what it could
// read and says so, and weeks later the trend line is flat for a reason nobody can name.
//
// So the required grants are derived from `config/statements/` rather than written down, and this
// reports what a nominated principal holds against them. It changes nothing unless asked:
//
//   DATABRICKS_CONFIG_PROFILE=your-profile npm run schedule:principal
//   DATABRICKS_CONFIG_PROFILE=your-profile npm run schedule:principal -- --apply
//
// Estate visibility is the one thing it will not do without being told twice. `--catalogs all` adds
// `BROWSE` on the customer's catalogs to what it asks for, `--sharing` adds the four metastore
// grants that make the sharing configuration countable, and `--revoke` is the undo for everything
// it can undo precisely:
//
//   DATABRICKS_CONFIG_PROFILE=your-profile npm run schedule:principal -- --catalogs all --sharing --apply
//   DATABRICKS_CONFIG_PROFILE=your-profile npm run schedule:principal -- --revoke --apply
//
// `--revoke` takes neither: it removes the derived set whatever this run asked for, because revoking
// only what was named this time would leave behind whatever an earlier run granted. The combination
// is refused rather than ignored, since a flag that reads like it scopes the teardown and does not is
// worse than one that is not accepted.
//
// It is not part of `npm run verify` and cannot be: it needs a workspace, a warehouse and
// credentials. The pure half — which grants are needed, and what a report of them says — is tested
// in `schedule-principal.test.ts`, because the interesting cases are the ones a real run will not
// reach on a workspace that is already set up correctly.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isApplicationId, quoteIdent } from './sql-identifiers.mjs';

/** Where the statements the assessment runs live, and therefore where the grant list comes from. */
const STATEMENTS = 'config/statements';

/** The catalogue the system tables sit in. Not configurable, and not by us. */
export const SYSTEM_CATALOG = 'system';

/**
 * Schemas under `system` that no grant makes readable, with why.
 *
 * `information_schema` is the one, and it is here because the obvious grant is *accepted* and does
 * nothing. Measured on a real workspace: a principal reading `system.information_schema.tables` saw
 * 202 rows where an admin saw 347, `GRANT USE SCHEMA, SELECT ON SCHEMA system.information_schema`
 * succeeded, and the same principal still saw 202. The views are filtered by the reader's privileges
 * on the objects they describe, so the way to widen them is to grant on the catalogs — which is the
 * separate, deliberate decision `docs/scheduled-scans.md` puts under its own heading.
 *
 * Listing it as a required grant would therefore be worse than leaving it out: the report would say
 * held, and the estate would still be half-visible.
 */
export const NOT_GRANTABLE = Object.freeze({
  information_schema:
    'its views are filtered by what the reader may see rather than by a grant on the schema, ' +
    'so granting SELECT on it is accepted and changes nothing',
});

/** What a schema grant has to carry. `SELECT` alone fails with `INSUFFICIENT_PERMISSIONS`. */
export const SCHEMA_PRIVILEGES = Object.freeze(['USE SCHEMA', 'SELECT']);

/**
 * What a customer catalog is granted, where the operator asks for estate visibility at all.
 *
 * `BROWSE` and not `SELECT`. Measured on labs, in `docs/plan/e1-populations.md` under `E1d`: with
 * `BROWSE` on the five customer catalogs and nothing else, the census returned the admin's 21 tables
 * where it had returned none, and a scheduled scan answered 43 requirements where it had answered 25.
 * It is a catalog-level metadata privilege — no `USE CATALOG`, no `USE SCHEMA`, and no access to a
 * single row.
 *
 * What it does not reach is `DESCRIBE DETAIL`, which is six requirements about table layout and needs
 * `SELECT`. That was measured rather than read off the privilege reference, and it is the line between
 * the second and third options in `docs/scheduled-scans.md`.
 */
export const CATALOG_PRIVILEGE = 'BROWSE';

/**
 * The four metastore grants that make the sharing configuration countable, and what each one counts.
 *
 * Measured on labs 2026-08-10, one at a time, as the metastore owner and as this principal — the
 * table is in `docs/plan/e1-populations.md` under `E1f`. `BROWSE` recovers none of them: with it in
 * place the scheduled principal still read 0 providers of 1 and 0 connections of 1, which is why this
 * is a second flag rather than more of what `--catalogs` asks for.
 *
 * Metastore-level and not per object, because three of the four cannot be granted per object at all —
 * `GRANT USE PROVIDER ON PROVIDER` is refused with `PRIVILEGES_SUPPORT_NOT_ENABLED` and
 * `GRANT ... ON SHARE <name>` does not parse — and because a per-object set is complete only on the
 * day it is issued, where a census is a claim about all of them.
 */
export const SHARING_PRIVILEGES = Object.freeze([
  Object.freeze({ privilege: 'USE SHARE', counts: 'the shares this metastore publishes' }),
  Object.freeze({ privilege: 'USE RECIPIENT', counts: 'the recipients it publishes them to' }),
  Object.freeze({ privilege: 'USE PROVIDER', counts: 'the providers it receives shared data from' }),
  Object.freeze({ privilege: 'USE CONNECTION', counts: 'the Lakehouse Federation connections' }),
]);

/**
 * Which catalogs are the customer's, as the app's own statements decide it.
 *
 * A copy of `server/collect/sql/queries.ts`'s `customerCatalogPredicate`, because this file runs
 * under plain Node and cannot import a `.ts`. `schedule-principal.test.ts` imports both and fails
 * when they diverge, which is the only thing that makes a copy safe: a tool granting on a set derived
 * differently from the set the assessment reads would grant on the wrong catalogs and report success.
 */
const DATABRICKS_OWNED = "'system', 'samples'";
const DATABRICKS_INTERNAL = "'__databricks_internal'";
const SYSTEM_OWNER = "'System user'";

export function customerCatalogPredicate(column) {
  return (
    `(${column} NOT IN (SELECT catalog_name FROM system.information_schema.catalogs ` +
    `WHERE catalog_owner = ${SYSTEM_OWNER}) AND lower(${column}) NOT IN (${DATABRICKS_OWNED})` +
    ` AND NOT startswith(lower(${column}), ${DATABRICKS_INTERNAL}))`
  );
}

/** The statement that derives them, rather than a list somebody maintains. */
export function customerCatalogsQuery() {
  return (
    'SELECT catalog_name FROM system.information_schema.catalogs ' +
    `WHERE ${customerCatalogPredicate('catalog_name')} ORDER BY catalog_name`
  );
}

/**
 * Which catalogs the operator asked for, against the derived set.
 *
 * Absent `--catalogs` means none, and that is the decision rather than the default being lazy: ADR
 * 0063 made estate visibility the customer's call, and this row's job is to make it one command away
 * rather than to make it happen. A named catalog outside the derived set is refused instead of
 * granted, so a typo cannot put `BROWSE` on something the assessment does not read.
 *
 * @param {readonly string[]} argv
 * @param {readonly string[]} derived
 */
export function catalogsAsked(argv, derived) {
  const joined = argv.find((one) => one.startsWith('--catalogs='));
  const at = argv.indexOf('--catalogs');
  if (at === -1 && joined == null) return [];

  // `--catalogs=all` is the other spelling of the same flag, and reading only the spaced one made it
  // a silent no-op — the one outcome this function refuses everywhere else, since a typo that grants
  // nothing and says nothing is indistinguishable from a run that was never asked.
  const asked = joined != null ? joined.slice('--catalogs='.length).trim() : argv[at + 1]?.trim();
  if (asked == null || asked === '' || asked.startsWith('--')) {
    throw new Error('--catalogs needs a value: `all`, or a comma-separated list of catalog names.');
  }
  if (asked === 'all') return [...derived];

  const named = asked
    .split(',')
    .map((one) => one.trim())
    .filter((one) => one !== '');
  const unknown = named.filter((one) => !derived.includes(one));
  if (unknown.length > 0) {
    throw new Error(
      `Not a customer catalog in this metastore: ${unknown.join(', ')}.\n` +
        `The derived set is ${derived.length === 0 ? '(empty)' : derived.join(', ')}. ` +
        'Databricks-owned catalogs are excluded the same way the assessment excludes them.'
    );
  }
  return named;
}

/**
 * A SCIM `eq` filter, with the value quoted as SCIM requires.
 *
 * The quotes are not decoration. An unquoted value is a syntax error rather than a miss, so this went
 * wrong in two different ways at once: an assessor group named `Well-Architected assessors` produced
 * `displayName eq Well-Architected assessors`, which is not a filter at all, and the tool reported
 * that the group did not exist. A workspace where the group name happened to be one bare word — which
 * is what a laptop test uses — never showed it.
 */
export function scimFilter(attribute, value) {
  return `${attribute} eq "${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * SQL with its comments removed, so that a schema named only in a comment is not read as a grant.
 *
 * This is not fussiness. `storage_sample_selection.sql` explains in a comment that it wanted
 * `system.storage.table_metrics_history` and could not use it, and a plain search for `system.<x>`
 * asks for a grant on a schema the app never reads — which is the exact failure this file exists to
 * stop, pointing the other way.
 */
export function withoutComments(sql) {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * Every schema under `system` the given statements read.
 *
 * @param {readonly { name: string, sql: string }[]} statements
 * @returns {string[]} sorted, deduplicated schema names
 */
export function schemasRead(statements) {
  const found = new Set();
  for (const { sql } of statements) {
    for (const [, schema] of withoutComments(sql).matchAll(/\bsystem\.([a-z_][a-z0-9_]*)/gi)) {
      found.add(schema.toLowerCase());
    }
  }
  return [...found].sort();
}

/** The schemas a grant can actually widen, and the ones it cannot, kept apart. */
export function grantableSchemas(schemas) {
  return {
    grantable: schemas.filter((one) => !(one in NOT_GRANTABLE)),
    ungrantable: schemas.filter((one) => one in NOT_GRANTABLE),
  };
}

/**
 * The derived grantable schemas divided by what this workspace currently offers.
 *
 * The first list remains derived from the statements. Availability is a workspace reading layered
 * over it, not a second source of truth: dropping a schema from the derived set because labs does not
 * offer it would make a workspace that does offer it silently under-granted.
 *
 * @param {readonly string[]} schemas
 * @param {readonly string[]} listed
 */
export function partitionAvailableSchemas(schemas, listed) {
  const available = new Set(listed.map((one) => one.toLowerCase()));
  return {
    present: schemas.filter((one) => available.has(one.toLowerCase())),
    unavailable: schemas.filter((one) => !available.has(one.toLowerCase())),
  };
}

/**
 * Read the held privileges for each schema, tolerating only the schema disappearing.
 *
 * Discovery and grant reads are separate statements. A Databricks-managed schema can therefore be
 * listed and then disappear before `SHOW GRANTS` reaches it. That is still platform availability,
 * not a missing grant and not something `--apply` can repair. Every other error remains an error.
 *
 * @param {readonly string[]} schemas
 * @param {(schema: string) => readonly string[]} read
 */
export function schemaGrantsHeld(schemas, read) {
  const held = {};
  const unavailable = [];
  for (const schema of schemas) {
    try {
      const privileges = read(schema);
      held[`schema:${schema}`] = SCHEMA_PRIVILEGES.every((one) => privileges.includes(one));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('SCHEMA_DOES_NOT_EXIST')) throw error;
      unavailable.push(schema);
    }
  }
  return { held, unavailable };
}

/**
 * Reconcile discovery with the later grant reads before any need or statement is built.
 *
 * Keeping this boundary pure is what proves a schema that disappears cannot reach `--apply`:
 * `needsOf` receives only `present`, so it has no GRANT or REVOKE to offer for `unavailable`.
 *
 * @param {{ present: readonly string[], unavailable: readonly string[] }} discovered
 * @param {{ unavailable: readonly string[] }} grantReading
 */
export function reconcileSchemaAvailability(discovered, grantReading) {
  return {
    present: discovered.present.filter((schema) => !grantReading.unavailable.includes(schema)),
    unavailable: [...new Set([...discovered.unavailable, ...grantReading.unavailable])],
  };
}

/**
 * Everything the scheduled run's identity needs, in the order a reader should check it.
 *
 * Order is deliberate and matches how a broken setup presents. Group membership first because
 * without it the run is refused at the door with a `403` and none of the grants below has been
 * consulted; then the app, whose absence arrives as a bare `401` from the proxy before the app is
 * reached; then the warehouse, without which every statement is refused; then the catalogue and its
 * schemas, whose absence is the quiet one — a run that succeeds and measures almost nothing.
 *
 * Catalogs and the sharing grants come last and only when asked for. They are the needs here that are
 * nobody's default: every other entry is what a scheduled run cannot work without, and these two are
 * decisions about how much of the estate an unattended identity may see.
 *
 * @param {{ principal: string, group: string, app: string, warehouse: string, schemas: readonly string[], catalogs?: readonly string[], sharing?: boolean }} where
 */
export function needsOf({ principal, group, app, warehouse, schemas, catalogs = [], sharing = false }) {
  // Refuse rather than emit a grant with an unquotable principal. The statements below are what an
  // admin pastes or what `--apply` runs; a backtick or newline left raw would close the identifier
  // early and leave the rest as SQL against a privileged session.
  const quoted = quoteIdent(principal);
  if (quoted == null) {
    throw new Error(
      'The scheduled principal cannot be quoted into Databricks SQL: it is empty or contains a line break.'
    );
  }
  return [
    {
      id: 'group',
      what: `a direct member of ${group}`,
      why: 'starting an assessment is a change, and only that group may make one',
      kind: 'membership',
    },
    {
      id: 'app',
      what: `CAN_USE on the app ${app}`,
      why: 'the proxy refuses before the app is reached, and the refusal is an empty 401',
      kind: 'permission',
    },
    {
      id: 'warehouse',
      what: `CAN_USE on warehouse ${warehouse}`,
      why: 'every system-table reading goes through it',
      kind: 'permission',
    },
    {
      id: 'catalog',
      what: `USE CATALOG on ${SYSTEM_CATALOG}`,
      why: 'without it every statement fails, whatever the schema grants say',
      kind: 'grant',
      statement: `GRANT USE CATALOG ON CATALOG ${SYSTEM_CATALOG} TO ${quoted}`,
      undo: `REVOKE USE CATALOG ON CATALOG ${SYSTEM_CATALOG} FROM ${quoted}`,
    },
    ...grantableSchemas(schemas).grantable.map((schema) => ({
      id: `schema:${schema}`,
      what: `${SCHEMA_PRIVILEGES.join(' and ')} on ${SYSTEM_CATALOG}.${schema}`,
      why: `the assessment reads ${SYSTEM_CATALOG}.${schema}`,
      kind: 'grant',
      statement: `GRANT ${SCHEMA_PRIVILEGES.join(', ')} ON SCHEMA ${SYSTEM_CATALOG}.${schema} TO ${quoted}`,
      undo: `REVOKE ${SCHEMA_PRIVILEGES.join(', ')} ON SCHEMA ${SYSTEM_CATALOG}.${schema} FROM ${quoted}`,
    })),
    ...catalogs.map((catalog) => {
      const named = quoteIdent(catalog);
      if (named == null) throw new Error(`The catalog ${JSON.stringify(catalog)} cannot be quoted into a GRANT.`);
      return {
        id: `catalog:${catalog}`,
        what: `${CATALOG_PRIVILEGE} on catalog ${catalog}`,
        why: 'without it the assessment reads this catalog as empty and excludes what it holds',
        kind: 'grant',
        statement: `GRANT ${CATALOG_PRIVILEGE} ON CATALOG ${named} TO ${quoted}`,
        undo: `REVOKE ${CATALOG_PRIVILEGE} ON CATALOG ${named} FROM ${quoted}`,
      };
    }),
    ...(sharing ? SHARING_PRIVILEGES : []).map(({ privilege, counts }) => ({
      id: `sharing:${privilege}`,
      what: `${privilege} on the metastore`,
      why: `without it the assessment counts none of ${counts}, whatever is configured`,
      kind: 'grant',
      statement: `GRANT ${privilege} ON METASTORE TO ${quoted}`,
      undo: `REVOKE ${privilege} ON METASTORE FROM ${quoted}`,
    })),
  ];
}

/**
 * What this deliberately never asks for, so that a reader can see the shape of the omission.
 *
 * Present as data rather than prose because the question at a review is not "is it least
 * privilege" but "least privilege compared with what", and a list of the things a setup guide
 * could plausibly have told somebody to grant answers that.
 */
export const WITHHELD = Object.freeze([
  'workspace or account admin — an unattended reader needs neither, and both would let it change the estate',
  'metastore admin — it would make every catalog readable, which is the decision the reader should make themselves',
  '`all-apis` on the token — measured and refused by the proxy anyway, and it would be wider than the app itself holds',
  "any grant on the store — scan history is written by the app's own identity, not by whoever asked for the run",
  'SELECT on data catalogs — it is what reads the rows, and only the six table-layout requirements need it. ' +
    'BROWSE, which makes the same catalogs countable without reading anything in them, is what --catalogs asks ' +
    'for instead.',
]);

/**
 * Each need placed against what the workspace says is already there.
 *
 * @param {readonly ReturnType<typeof needsOf>[number][]} needs
 * @param {(need: { id: string }) => boolean} holds
 */
export function standing(needs, holds) {
  return needs.map((need) => ({ ...need, held: holds(need) }));
}

/**
 * The report, as lines.
 *
 * `catalogs` is the derived customer set rather than the asked-for one, so the report can say the
 * option exists on a run that did not use it. An operator who never learns of `--catalogs` gets the
 * behaviour ADR 0063 chose — no estate visibility — without ever having chosen it, which is the
 * failure mode of an opt-in nobody is told about.
 *
 * @param {{ principal: string, profile: string, settled: readonly { id: string, what: string, why: string, held: boolean }[], applied: readonly string[], ungrantable: readonly string[], unavailable?: readonly string[], catalogs?: readonly string[] }} reading
 */
export function lines({ principal, profile, settled, applied, ungrantable, unavailable = [], catalogs = [] }) {
  const out = [`${principal} on ${profile}`, ''];
  for (const need of settled) {
    const mark = need.held ? 'held' : applied.includes(need.id) ? 'granted' : 'MISSING';
    out.push(`  ${mark.padEnd(8)} ${need.what}`);
    if (!need.held && !applied.includes(need.id)) out.push(`           ${need.why}`);
  }

  const missing = settled.filter((need) => !need.held && !applied.includes(need.id));
  out.push('');
  if (missing.length === 0) {
    out.push(
      applied.length > 0
        ? `Granted ${String(applied.length)} of ${String(settled.length)}. The principal now holds everything a scheduled run needs.`
        : 'The principal holds everything a scheduled run needs.'
    );
  } else {
    out.push(
      `${String(missing.length)} of ${String(settled.length)} missing. A run now would measure part of the estate and ` +
        'report the rest as unreadable, which is honest and not an assessment.',
      'Add them with --apply, or by hand from docs/scheduled-scans.md.'
    );
  }

  for (const schema of ungrantable) {
    out.push('', `Not asked for: ${SYSTEM_CATALOG}.${schema} — ${NOT_GRANTABLE[schema]}.`);
  }

  for (const schema of unavailable) {
    out.push(
      '',
      `Platform-unavailable: ${SYSTEM_CATALOG}.${schema} — the workspace did not expose this Databricks-managed schema when checked.`,
      '           --apply cannot create it and will not propose or issue a grant for it.'
    );
  }

  const asked = settled.filter((need) => need.id.startsWith('catalog:')).length;
  if (asked === 0 && catalogs.length > 0) {
    out.push(
      '',
      `Not asked for: ${CATALOG_PRIVILEGE} on ${String(catalogs.length)} customer ` +
        `catalog${catalogs.length === 1 ? '' : 's'} — ${catalogs.join(', ')}.`,
      `           Without it every reading of ${SYSTEM_CATALOG}.information_schema is filtered to what this`,
      '           principal may see, which for a principal holding nothing is an estate of no tables.',
      `           Add them with --catalogs all, which grants ${CATALOG_PRIVILEGE} and no access to any row.`
    );
  }

  if (!settled.some((need) => need.id.startsWith('sharing:'))) {
    out.push(
      '',
      'Not asked for: the four metastore grants that make the sharing configuration countable —',
      `           ${SHARING_PRIVILEGES.map((one) => one.privilege).join(', ')}.`,
      '           Without them shares, recipients, providers and connections all count zero for this',
      '           principal whatever is configured, and the requirements that read them report',
      `           themselves unreadable rather than answered. ${CATALOG_PRIVILEGE} does not cover these:`,
      '           measured on labs, a principal holding it read 0 providers of 1 and 0 connections of 1.',
      '           Add them with --sharing. Measured on labs, a principal holding all four was still',
      '           refused CREATE FOREIGN CATALOG on a connection they had made visible.'
    );
  }

  out.push('', 'Deliberately not granted:');
  for (const one of WITHHELD) out.push(`  - ${one}`);
  return out;
}

/**
 * The teardown report: what will be removed, or what was.
 *
 * Separate from `lines` because it answers a different question and gets a different pass over the
 * same needs — a need that is *not* held is nothing to report here, where in the report above it is
 * the whole point.
 *
 * Two things it says plainly rather than implying. It revokes the set this tool derives from the
 * principal it was given, and a grant somebody made by hand is indistinguishable from one this made,
 * so an identical grant that predates the tool is removed too. And the two object permissions are not
 * revoked at all: the API replaces an access list rather than editing it, so removing one entry means
 * writing back everybody else's, and a tool asked to remove one principal's access has no business
 * being able to remove another's.
 *
 * @param {{ principal: string, profile: string, settled: readonly { id: string, what: string, kind: string, held: boolean }[], removed: readonly string[], unavailable?: readonly string[] }} reading
 */
export function removalLines({ principal, profile, settled, removed, unavailable = [] }) {
  const held = settled.filter((need) => need.held);
  const revocable = held.filter((need) => REVOCABLE.has(need.kind));
  const out = [`${principal} on ${profile}`, ''];

  if (revocable.length === 0) {
    // Not "holds nothing": the two object permissions below are held and are not revocable here, so
    // saying nothing is held would be contradicted four lines later by the list of what is. This is
    // the second `--revoke --apply`, which is a normal thing for an operator to run.
    out.push(
      held.length === 0
        ? 'Nothing to revoke: the principal holds nothing this tool issues.'
        : 'Nothing this tool can revoke. What it found is below.'
    );
  } else {
    out.push(removed.length > 0 ? 'Revoked:' : 'Would revoke:');
    for (const need of revocable) {
      out.push(`  ${(removed.includes(need.id) ? 'revoked' : 'to go').padEnd(8)} ${need.what}`);
    }
    out.push(
      '',
      'This is the set this tool derives, taken from the principal named above. It cannot tell a grant',
      'it issued from an identical one somebody made by hand, and removes either.'
    );
    if (removed.length === 0) out.push('', 'Nothing has changed yet. Add --apply to issue the statements above.');
  }

  for (const schema of unavailable) {
    out.push(
      '',
      `Platform-unavailable: ${SYSTEM_CATALOG}.${schema} — the workspace did not expose this Databricks-managed schema when checked.`,
      '           --apply cannot create it and will not propose or issue a grant for it.'
    );
  }

  const kept = held.filter((need) => !REVOCABLE.has(need.kind));
  if (kept.length > 0) {
    out.push('', "Left in place, because removing it would rewrite other principals' access:");
    for (const need of kept) out.push(`  kept     ${need.what}`);
    out.push(
      '',
      'The permissions API replaces an access list rather than editing it, so dropping one entry means',
      "writing back everybody else's. Remove these in the UI, or with set-permissions and the full list",
      'you mean to leave behind.'
    );
  }
  return out;
}

/** The two kinds this tool can take back one principal at a time. `permission` is not one of them. */
const REVOCABLE = new Set(['grant', 'membership']);

/** Every statement in the tree, as this reads them. */
export function statementsIn(directory = STATEMENTS) {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(directory, name), 'utf8') }));
}

// ---------------------------------------------------------------------------------------------
// Everything below talks to a workspace, and so is exercised by running it rather than by a test.
// ---------------------------------------------------------------------------------------------

const PROFILE = process.env.DATABRICKS_CONFIG_PROFILE?.trim() ?? 'DEFAULT';
const APPLY = process.argv.includes('--apply');
const REVOKE = process.argv.includes('--revoke');

// `-o json` is not the default and not optional: `databricks groups list` and
// `service-principals list` answer in a two-column text table unless asked, which parses as JSON
// right up to the first space.
function cli(args, { json = true } = {}) {
  const asked = json && !args.includes('-o') ? [...args, '-o', 'json'] : args;
  const out = execFileSync('databricks', [...asked, '-p', PROFILE], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return json ? JSON.parse(out === '' ? 'null' : out) : out;
}

function sql(warehouse, statement) {
  const answer = cli([
    'api',
    'post',
    '/api/2.0/sql/statements',
    '--json',
    JSON.stringify({
      warehouse_id: warehouse,
      statement,
      wait_timeout: '50s',
      format: 'JSON_ARRAY',
      disposition: 'INLINE',
    }),
  ]);
  if (answer?.status?.state !== 'SUCCEEDED') {
    throw new Error(`${statement}\n  ${answer?.status?.error?.message ?? String(answer?.status?.state)}`);
  }
  return answer.result?.data_array ?? [];
}

/** The bundle as the CLI resolves it, which is the only reading that has the variables filled in. */
function bundle() {
  const resolved = cli(['bundle', 'validate', '-o', 'json']);
  const app = resolved?.resources?.apps?.app;
  const warehouse = app?.resources?.find((one) => one.name === 'sql-warehouse')?.sql_warehouse?.id;
  const clientId = resolved?.variables?.schedule_client_id?.value;
  return { app: app?.name, warehouse, clientId, resolved };
}

/**
 * The assessor group.
 *
 * From the resolved bundle, which is the group the next deploy will gate on — and resolved rather
 * than read, so it is the selected target's value rather than the default. It was parsed out of
 * `app.yaml` with a regular expression until the group moved, which had the same answer only while
 * no target overrode it.
 *
 * Overridable with `--group` because a running install can have been changed since: the Apps API
 * does not report an app's environment back, so this file cannot read what is deployed and does not
 * pretend to.
 */
function assessorGroup(resolved) {
  const named = process.argv.indexOf('--group');
  if (named !== -1) return process.argv[named + 1]?.trim();

  const declared = resolved?.resources?.apps?.app?.config?.env ?? [];
  return declared.find((one) => one.name === 'WAF_ASSESSOR_GROUP')?.value?.trim();
}

function stop(why) {
  console.error(why);
  process.exit(2);
}

function main() {
  const named = process.argv.indexOf('--client-id');
  const { app, warehouse, clientId, resolved } = bundle();
  const principal = named === -1 ? clientId : process.argv[named + 1];
  const group = assessorGroup(resolved);

  if (app == null || warehouse == null) stop('The bundle resolves no app or no warehouse. Fix databricks.yml first.');
  if (group == null || group === '') {
    stop('The bundle sets no WAF_ASSESSOR_GROUP for this target, so nothing could start a scan.');
  }
  if (principal == null || principal === '') {
    stop(
      'No principal to check. Set `schedule_client_id` in the target, or pass --client-id <application-id>.\n' +
        'Create one with: databricks service-principals create --display-name "Well-Architected schedule"'
    );
  }
  if (!isApplicationId(principal)) {
    stop(
      `The principal ${JSON.stringify(principal)} is not an application id (a UUID). ` +
        "Pass the service principal's application id, not its display name or numeric id."
    );
  }
  if (quoteIdent(principal) == null) {
    stop('The principal contains a character that cannot appear in a Databricks SQL identifier.');
  }

  const schemas = schemasRead(statementsIn());
  const { grantable, ungrantable } = grantableSchemas(schemas);
  // Availability is read rather than assumed. System schemas are Databricks-managed and optional
  // across workspaces; a grant tool cannot create one and must not report its absence as a grant it
  // can repair.
  const listedSchemas = sql(warehouse, `SHOW SCHEMAS IN ${SYSTEM_CATALOG}`).map(([name]) => String(name));
  const discovered = partitionAvailableSchemas(grantable, listedSchemas);
  // Derived from the metastore the operator can see, which is the same exclusion the assessment's own
  // statements apply. A teardown asks for the derived set too: revoking only what was asked for this
  // time would leave behind whatever an earlier `--catalogs` had granted.
  const customer = sql(warehouse, customerCatalogsQuery()).map(([name]) => String(name));
  if (REVOKE && process.argv.some((one) => one === '--catalogs' || one.startsWith('--catalogs='))) {
    stop('--revoke removes the whole derived set and takes no --catalogs. Drop the flag and run it again.');
  }
  // `--sharing=anything` is refused rather than ignored: it takes no value, and a flag that looks
  // accepted and grants nothing is how an operator concludes the grants did not help.
  const sharingAsked = process.argv.filter((one) => one === '--sharing' || one.startsWith('--sharing='));
  if (sharingAsked.some((one) => one !== '--sharing')) {
    stop('--sharing takes no value: it asks for all four metastore grants or none. Drop the value and run it again.');
  }
  if (REVOKE && sharingAsked.length > 0) {
    stop('--revoke removes the whole derived set and takes no --sharing. Drop the flag and run it again.');
  }
  const catalogs = REVOKE ? customer : catalogsAsked(process.argv, customer);
  // A teardown considers all four whether or not this run asked for them, for the same reason it
  // considers every customer catalog: what an earlier `--sharing` granted is what a `--revoke` is for.
  const sharing = REVOKE || sharingAsked.length > 0;
  // Read everything first, so the report is of one moment rather than of the changes it is making.
  const groups = cli(['groups', 'list', '--filter', scimFilter('displayName', group)]) ?? [];
  const members =
    groups[0]?.id == null
      ? []
      : (cli(['groups', 'get', String(groups[0].id)])?.members ?? []).map((one) => String(one.value));
  // SCIM records a member by numeric id or by application id depending on how it was added, and both
  // are the same principal. Checking one shape only reports a member as missing and then adds it twice.
  const numeric = cli(['service-principals', 'list', '--filter', scimFilter('applicationId', principal)])?.[0]?.id;
  const member = members.includes(principal)
    ? principal
    : numeric != null && members.includes(String(numeric))
      ? String(numeric)
      : undefined;
  const grants = grantsHeld(warehouse, principal, discovered.present, catalogs, sharing);
  const reconciled = reconcileSchemaAvailability(discovered, grants);
  const needs = needsOf({ principal, group, app, warehouse, schemas: reconciled.present, catalogs, sharing });
  const held = {
    group: member != null,
    app: hasPermission(cli(['apps', 'get-permissions', app]), principal),
    warehouse: hasPermission(cli(['warehouses', 'get-permissions', warehouse]), principal),
    ...grants.held,
  };

  const settled = standing(needs, (need) => held[need.id] === true);

  if (REVOKE) {
    const removed = [];
    if (APPLY) {
      for (const need of settled.filter((one) => one.held && REVOCABLE.has(one.kind))) {
        undo(need, { warehouse, member, group: groups[0]?.id });
        removed.push(need.id);
      }
    }
    console.log(
      removalLines({ principal, profile: PROFILE, settled, removed, unavailable: reconciled.unavailable }).join('\n')
    );
    process.exit(0);
  }

  const applied = [];
  if (APPLY) {
    for (const need of settled.filter((one) => !one.held)) {
      apply(need, { app, warehouse, principal, numeric, group: groups[0]?.id });
      applied.push(need.id);
    }
  }

  console.log(
    lines({
      principal,
      profile: PROFILE,
      settled,
      applied,
      ungrantable,
      unavailable: reconciled.unavailable,
      catalogs: customer,
    }).join('\n')
  );
  process.exit(settled.some((need) => !need.held) && !APPLY ? 1 : 0);
}

function hasPermission(permissions, principal) {
  return (permissions?.access_control_list ?? []).some(
    (entry) =>
      entry.service_principal_name === principal &&
      (entry.all_permissions ?? []).some(
        (one) => one.permission_level === 'CAN_USE' || one.permission_level === 'CAN_MANAGE'
      )
  );
}

/** What the principal already holds on the catalogue, each schema, each customer catalog and the metastore. */
function grantsHeld(warehouse, principal, schemas, catalogs = [], sharing = false) {
  const quoted = quoteIdent(principal);
  if (quoted == null) stop('The principal cannot be quoted into SHOW GRANTS.');
  const on = (securable) =>
    sql(warehouse, `SHOW GRANTS ${quoted} ON ${securable}`).map(([, privilege]) => String(privilege));

  const catalog = on(`CATALOG ${SYSTEM_CATALOG}`);
  const held = { catalog: catalog.includes('USE CATALOG') };
  const schemaReading = schemaGrantsHeld(schemas, (schema) => on(`SCHEMA ${SYSTEM_CATALOG}.${schema}`));
  Object.assign(held, schemaReading.held);
  for (const name of catalogs) {
    const named = quoteIdent(name);
    if (named == null) stop(`The catalog ${JSON.stringify(name)} cannot be quoted into SHOW GRANTS.`);
    held[`catalog:${name}`] = on(`CATALOG ${named}`).includes(CATALOG_PRIVILEGE);
  }
  if (sharing) {
    // One read for all four, and the privileges come back spaced — `USE CONNECTION`, not
    // `USE_CONNECTION`, which is the underscored form `information_schema` uses for the same thing.
    //
    // Direct grants only: `SHOW GRANTS <principal>` reports what was granted to that principal, not
    // what it holds through a group, so a privilege held through `account users` reads as missing
    // here while the census reads it as held. The consequences are both the safe way round — an
    // `--apply` issues a direct grant the principal did not need, and a `--revoke` leaves a group
    // grant it did not issue alone.
    const metastore = on('METASTORE');
    for (const { privilege } of SHARING_PRIVILEGES) held[`sharing:${privilege}`] = metastore.includes(privilege);
  }
  return { held, unavailable: schemaReading.unavailable };
}

function apply(need, { app, warehouse, principal, numeric, group }) {
  if (need.kind === 'grant') {
    sql(warehouse, need.statement);
    return;
  }
  if (need.id === 'app') {
    cli([
      'apps',
      'update-permissions',
      app,
      '--json',
      JSON.stringify({ access_control_list: [{ service_principal_name: principal, permission_level: 'CAN_USE' }] }),
    ]);
    return;
  }
  if (need.id === 'warehouse') {
    cli([
      'warehouses',
      'update-permissions',
      warehouse,
      '--json',
      JSON.stringify({ access_control_list: [{ service_principal_name: principal, permission_level: 'CAN_USE' }] }),
    ]);
    return;
  }
  if (need.id === 'group') {
    if (group == null) stop('The assessor group does not exist, so nothing can be added to it.');
    if (numeric == null) stop(`No service principal has application id ${principal}.`);
    // The one member being added, and not the current membership alongside it. A SCIM `add` appends to
    // a multi-valued attribute rather than replacing it, so sending everybody who is already in the
    // group asks the workspace to add each of them again — and it is `replace` that would need the full
    // list, which is a statement this has no business making. A tool run to grant one principal one
    // membership should not be able to change anybody else's, and rewriting the list from what a read a
    // moment earlier returned is how it would: anybody added in between is removed by the write.
    cli([
      'groups',
      'patch',
      String(group),
      '--json',
      JSON.stringify({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'add', value: { members: [{ value: String(numeric) }] } }],
      }),
    ]);
  }
}

/**
 * The teardown, for the two kinds that can be taken back one principal at a time.
 *
 * Same asymmetry as `apply`, for the same reason and in the other direction: SCIM removes one named
 * member without being told the rest of the list, and the permissions API has no equivalent — which
 * is why `permission` is not in `REVOCABLE` and `removalLines` says so rather than this failing.
 */
function undo(need, { warehouse, member, group }) {
  if (need.kind === 'grant') {
    sql(warehouse, need.undo);
    return;
  }
  if (need.kind === 'membership') {
    if (group == null) stop('The assessor group does not exist, so nothing can be removed from it.');
    // Removed by the value the membership is recorded under, which SCIM writes as either the numeric
    // id or the application id depending on how it was added. Filtering on the other one removes
    // nothing and reports success, so the report would say revoked while the principal stayed a member.
    if (member == null) stop('The membership is recorded under neither id this read, so nothing can be removed.');
    cli([
      'groups',
      'patch',
      String(group),
      '--json',
      JSON.stringify({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'remove', path: `members[value eq ${JSON.stringify(String(member))}]` }],
      }),
    ]);
  }
}

// Run only when this file is the entry point, so the tests can import the pure half.
if (process.argv[1]?.endsWith('schedule-principal.mjs') === true) {
  try {
    main();
  } catch (error) {
    stop(error instanceof Error ? error.message : String(error));
  }
}
