// Inspect one restored WAF schema without changing it.
//
// This is a separate process because the recovery command has to select a database that is not the
// App's current binding. The parent supplies the exact endpoint, host, database, profile and expected
// record ids through its scrubbed environment; this process uses the App's own Lakebase connection and
// record-digest code so the recovery proof is not a second interpretation of those records.

import { createHash } from 'node:crypto';

import { digestOf } from '../server/records/digest.js';
import { verifyRecords } from '../server/records/verify.js';
import { openPostgres } from '../server/store/postgres.js';

interface ExpectedRecords {
  readonly result?: string;
  readonly review?: string;
  readonly action?: string;
  readonly publication?: string;
}

interface TableInspection {
  readonly table: string;
  readonly rows: number;
  readonly digest: string;
}

interface OwnershipInspection {
  readonly database: string;
  readonly schema: string;
  readonly appCanSetOwner: boolean;
  readonly relations: readonly { name: string; owner: string }[];
}

const expected = expectedRecords(process.env.WAF_RECOVERY_EXPECTED);
const expectedOwner = (process.env.WAF_RECOVERY_APP_ROLE ?? '').trim();
const recoveryOwner = (process.env.WAF_RECOVERY_OWNER_ROLE ?? '').trim();
const db = await openPostgres({ ensureSchema: false });

try {
  const ownership = await inspectOwnership(expectedOwner, recoveryOwner);
  verifyOwnership(ownership, expectedOwner, recoveryOwner);

  const tables = await inspectTables();
  const records = await verifyRecords({ db, limit: 9_007_199_254_740_991 });
  if (!records.intact) throw new Error('At least one restored application record does not match its stored digest.');

  const constraints = await db.query<{ table_name: string; name: string; definition: string; validated: boolean }>(
    `select relation.relname as table_name,
            relation_constraint.conname as name,
            pg_get_constraintdef(relation_constraint.oid, true) as definition,
            relation_constraint.convalidated as validated
       from pg_constraint relation_constraint
       join pg_class relation on relation.oid = relation_constraint.conrelid
      where relation_constraint.connamespace = $1::regnamespace
      order by relation.relname, relation_constraint.conname`,
    [db.schema]
  );

  const named = await inspectExpected(expected);
  const schemaDigest = createHash('sha256')
    .update(JSON.stringify({ tables, constraints: constraints.rows }))
    .digest('hex');
  process.stdout.write(
    `${JSON.stringify({
      version: 1,
      schema: db.schema,
      owner: ownership.schema,
      ownership,
      schemaDigest,
      tables,
      records: {
        intact: records.intact,
        tables: records.tables.map((one) => ({
          table: one.table,
          total: one.total,
          checked: one.checked,
          intact: one.intact,
          unstamped: one.unstamped,
        })),
      },
      relationships: { constraints: constraints.rows },
      named,
    })}\n`
  );
} finally {
  await db.end();
}

function expectedRecords(raw: string | undefined): ExpectedRecords {
  if (raw == null || raw.trim() === '') return {};
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const answer: Record<string, string> = {};
  for (const key of ['result', 'review', 'action', 'publication'] as const) {
    const value = parsed[key];
    if (value != null && (typeof value !== 'string' || value.trim() === '')) {
      throw new Error(`Expected record ${key} must be a non-empty string.`);
    }
    if (typeof value === 'string') answer[key] = value;
  }
  return answer;
}

async function inspectOwnership(appRole: string, sharedOwner: string): Promise<OwnershipInspection> {
  const database = await db.query<{ owner: string }>(
    `select pg_get_userbyid(datdba) as owner from pg_database where datname = current_database()`
  );
  const schema = await db.query<{ owner: string }>(
    `select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = $1`,
    [db.schema]
  );
  const databaseOwner = database.rows[0]?.owner;
  const schemaOwner = schema.rows[0]?.owner;
  if (databaseOwner == null) throw new Error('The recovery database has no reported owner.');
  if (schemaOwner == null) throw new Error(`Schema ${db.schema} does not exist in the recovery database.`);
  const relations = await db.query<{ name: string; owner: string }>(
    `select relation.relname as name, pg_get_userbyid(relation.relowner) as owner
       from pg_class relation
       join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = $1 and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
      order by relation.relname`,
    [db.schema]
  );
  const membership =
    appRole === '' || sharedOwner === ''
      ? { rows: [{ member: false }] }
      : await db.query<{ member: boolean }>(`select pg_has_role($1, $2, 'member') as member`, [appRole, sharedOwner]);
  return {
    database: databaseOwner,
    schema: schemaOwner,
    appCanSetOwner: membership.rows[0]?.member === true,
    relations: relations.rows,
  };
}

function verifyOwnership(ownership: OwnershipInspection, wanted: string, sharedOwner: string): void {
  if (wanted === '') return;
  const direct = ownership.schema === wanted;
  const shared =
    sharedOwner !== '' &&
    ownership.database === sharedOwner &&
    ownership.schema === sharedOwner &&
    ownership.appCanSetOwner;
  if (!direct && !shared) {
    throw new Error(
      `Schema ${db.schema} is owned by ${ownership.schema} under database owner ${ownership.database}, not the App PostgreSQL role ${wanted}.`
    );
  }
  const expectedRelationOwner = direct ? wanted : sharedOwner;
  const wrong = ownership.relations.filter((one) => one.owner !== expectedRelationOwner);
  if (wrong.length > 0) {
    throw new Error(
      `${wrong.length} restored relations are not owned through ${expectedRelationOwner}: ${wrong
        .slice(0, 5)
        .map((one) => one.name)
        .join(', ')}.`
    );
  }
}

async function inspectTables(): Promise<readonly TableInspection[]> {
  const found = await db.query<{ table_name: string }>(
    `select table_name
       from information_schema.tables
      where table_schema = $1 and table_type = 'BASE TABLE'
      order by table_name`,
    [db.schema]
  );
  if (found.rows.length === 0) throw new Error(`Schema ${db.schema} contains no base tables.`);

  const inspected: TableInspection[] = [];
  for (const { table_name: table } of found.rows) {
    const quoted = `"${table.replace(/"/g, '""')}"`;
    const answer = await db.query<{ row: unknown }>(
      `select to_jsonb(one) as row from ${db.schema}.${quoted} one order by to_jsonb(one)::text`
    );
    const hash = createHash('sha256');
    for (const row of answer.rows) hash.update(digestOf(row.row)).update('\n');
    inspected.push({ table, rows: answer.rows.length, digest: hash.digest('hex') });
  }
  return inspected;
}

async function inspectExpected(wanted: ExpectedRecords): Promise<Record<string, unknown>> {
  const named: Record<string, unknown> = {};
  if (wanted.result != null) {
    const answer = await db.query<{ id: string; eligible: boolean | null }>(
      `select id, eligible from ${db.schema}.assessment_results where id = $1`,
      [wanted.result]
    );
    if (answer.rows.length !== 1) throw new Error(`Named final assessment ${wanted.result} is absent.`);
    if (answer.rows[0]?.eligible !== true) {
      throw new Error(`Named final assessment ${wanted.result} is present but is not publication eligible.`);
    }
    named.result = { id: wanted.result, eligible: true };
  }
  if (wanted.review != null) {
    const answer = await db.query<{ id: string }>(`select id from ${db.schema}.assessment_reviews where id = $1`, [
      wanted.review,
    ]);
    if (answer.rows.length !== 1) throw new Error(`Named assessment review ${wanted.review} is absent.`);
    named.review = { id: wanted.review };
  }
  if (wanted.action != null) {
    const answer = await db.query<{ id: string; revision: number }>(
      `select id, max(revision)::integer as revision
         from ${db.schema}.improvement_actions where id = $1 group by id`,
      [wanted.action]
    );
    if (answer.rows.length !== 1) throw new Error(`Named improvement action ${wanted.action} is absent.`);
    named.action = { id: wanted.action, revision: answer.rows[0]?.revision };
  }
  if (wanted.publication != null) {
    const answer = await db.query<{ id: string; digest: string }>(
      `select id, digest from ${db.schema}.month_publications where id = $1`,
      [wanted.publication]
    );
    if (answer.rows.length !== 1) throw new Error(`Named month publication ${wanted.publication} is absent.`);
    named.publication = { id: wanted.publication, digest: answer.rows[0]?.digest };
  }
  return named;
}
