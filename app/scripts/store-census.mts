// What is in the bound Lakebase, counted through the app's own connect path.
//
// Written for `91`, and it is the reason that row asked for more than an option. Counting stored scans is
// the first thing anybody needs when deciding whether a stored-shape change is safe — `88` needed it, `84`
// needs it for relational invariants, `90` needs it to build a fixture from a real row — and until now it
// could not be done through `openPostgres`: the connect path runs `create index if not exists` on the way
// in, which requires owning the table even when the index already exists, so any identity but the app's
// service principal was refused before it could send a `select`. `88`'s numbers were therefore taken
// through a pool built by hand, which measures something adjacent to what the app does rather than what it
// does.
//
// So this reads with `ensureSchema: false`, which is the same pool, the same resolver, the same schema
// name and the same identity as the app — minus DDL nobody asked for.
//
//   DATABRICKS_CONFIG_PROFILE=your-profile LAKEBASE_ENDPOINT=<endpoint> npm run store:census
//
// The endpoint is what the platform injects for a bound `postgres` resource. `databricks apps get
// databricks-waf-assessment -p labs -o json` reports the binding; docs/estates.md has the profile trap
// worth knowing before trusting an empty reading.

import { openPostgres } from '../server/store/postgres.js';

interface Counted {
  readonly table: string;
  readonly rows: number;
}

/*
 * The tables are read from the catalogue rather than listed here.
 *
 * A list in this file would be a second declaration of the schema, and the census would then be silently
 * incomplete the first time a table was added — reporting a total that reads as "everything" over a set
 * nobody had rechecked. That is the same failure as the hand-maintained route array `drive-labs.mjs` used
 * to carry, which signed off on "every page rendered" while never opening three of them.
 */
const TABLES = `
  select table_name
  from information_schema.tables
  where table_schema = $1 and table_type = 'BASE TABLE'
  order by table_name
`;

const db = await openPostgres({ ensureSchema: false });

try {
  const { rows: tables } = await db.query<{ table_name: string }>(TABLES, [db.schema]);

  if (tables.length === 0) {
    process.stdout.write(
      `Schema ${db.schema} holds no tables. Either nothing has ever booted against this database, or ` +
        'this is not the database the app is bound to — an empty reading is a fact about a window on a ' +
        'workspace before it is a fact about the store. See ADR 0074 and docs/estates.md.\n'
    );
  } else {
    const counted: Counted[] = [];
    for (const { table_name: table } of tables) {
      /*
       * An identifier cannot be a parameter, so it is concatenated, so it is escaped rather than
       * trusted — a doubled `"` is how Postgres quotes a quote inside a quoted identifier.
       *
       * A first version wrapped the name in quotes and explained itself with "it came from
       * `information_schema` on this connection, so there is nothing to inject with". That is the
       * shape of claim this repository has been bitten by twice: confident, adjacent to true, and
       * unenforced. A name containing a `"` closes the identifier early and what follows is
       * statement text. Whether anyone can create such a table in this schema is a question about
       * grants somewhere else, which is exactly why it is not this line's assumption to make.
       */
      const quoted = `"${table.replace(/"/g, '""')}"`;
      const { rows } = await db.query<{ n: string }>(`select count(*)::text as n from ${db.schema}.${quoted}`);
      counted.push({ table, rows: Number(rows[0]?.n ?? '0') });
    }

    const width = Math.max(...counted.map(({ table }) => table.length));
    for (const { table, rows } of counted) {
      process.stdout.write(`  ${table.padEnd(width)}  ${String(rows).padStart(7)}\n`);
    }
    process.stdout.write(
      `\n${String(counted.length)} tables in ${db.schema}, ` +
        `${String(counted.reduce((sum, { rows }) => sum + rows, 0))} rows between them.\n`
    );

    /*
     * The encoding versions present, which is the question `88` was asking.
     *
     * A stored scan carries the version that wrote it, and this build refuses one it cannot read rather
     * than decoding it into a shape the reader will crash on. Reported per version so that "can this
     * build open what is stored?" is answerable before a deploy rather than after one — which is the
     * order it was answered in the first time, at the cost of the app.
     */
    if (counted.some(({ table }) => table === 'scans')) {
      const { rows: versions } = await db.query<{ version: string | null; n: string }>(
        `select body->>'codecVersion' as version, count(*)::text as n
         from ${db.schema}.scans group by 1 order by 1`
      );
      if (versions.length > 0) {
        process.stdout.write('\nStored scans by the encoding version that wrote them:\n');
        for (const { version, n } of versions) {
          process.stdout.write(`  ${version ?? 'no version recorded'}  ${n}\n`);
        }
      }
    }
  }
} finally {
  await db.end();
}
