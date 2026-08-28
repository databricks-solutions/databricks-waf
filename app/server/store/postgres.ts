// The connection to Lakebase, and the schema this app owns in it.
//
// One narrow interface between the stores and the driver, for the same reason `VolumeFiles`
// was narrow before it: three stores share it, the tests fake it, and a store that only ever
// sees `query` cannot accidentally depend on a pool's lifecycle.
//
// Why the app creates its own schema on boot, rather than a migration step or a bundle
// resource: a Lakebase role holds `CAN_CONNECT_AND_CREATE`, which grants creating objects and
// nothing on objects it did not create. Whoever creates the schema owns it. So if a developer
// runs against the project before the app is deployed, the schema belongs to that developer and
// the app's service principal is refused on the tables it is supposed to own. Creating it from
// the app, as the identity that will use it, is what makes the owner right by construction.
//
// That is also why `WAF_PG_SCHEMA` exists. Local development against a shared project should not
// create the schema the deployed app will want, so a developer points at their own and the
// production one stays unowned until the app boots.

import { createLakebasePool, getUsernameWithApiLookup, getWorkspaceClient } from '@databricks/lakebase';

// The list of durable tables, and what each one's rows belong to. It lives beside the reset because
// that is where a test already holds it to what this file creates; see `keyByAssessment` at the foot
// of this file for why the schema reads the classification rather than repeating it.
import { RESET_TABLES } from '../admin/reset.js';
import { applyInvariants } from './invariants.js';

/**
 * What a store needs from Postgres, and no more.
 *
 * `rows` alone rather than a `pg.QueryResult`: nothing here reads `rowCount`, `fields` or
 * `command`, and a fake that had to produce them would be inventing shapes to satisfy a type
 * instead of standing in for a database.
 */
export interface Sql {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;

  /**
   * One connection, held for the life of `run`, with everything inside it in one transaction.
   *
   * Optional, and the one thing here that cannot be layered on top of `query`. A pool hands out a
   * different connection per statement, so `query('begin')` followed by `query('delete ...')` is a
   * transaction that begins on one connection and deletes on another — which reads as working and
   * commits nothing, the worst available outcome for a caller that asked for atomicity. So an
   * implementation whose `query` is pool-backed has to provide this, and a caller that needs a
   * transaction must refuse to proceed without it rather than fall back to running unprotected.
   *
   * Committed when `run` returns and rolled back when it throws, so a caller signals "undo this" by
   * throwing rather than by returning a flag nothing is obliged to read.
   */
  session?<T>(run: (sql: Sql) => Promise<T>): Promise<T>;
}

export interface Postgres extends Sql {
  /** The schema every statement is qualified with. Validated, because it reaches DDL as text. */
  readonly schema: string;
  end(): Promise<void>;
}

/** The env var the `postgres` resource binding resolves to, via `valueFrom` in app.yaml. */
export const ENDPOINT_ENV = 'LAKEBASE_ENDPOINT';

/** Where the app keeps its tables. Overridable so local work does not claim the deployed schema. */
export const SCHEMA_ENV = 'WAF_PG_SCHEMA';

export const DEFAULT_SCHEMA = 'waf';

/**
 * A schema name that is safe to interpolate into DDL.
 *
 * Parameters cannot carry an identifier — `create schema $1` is not a statement — so this value
 * is concatenated into SQL and has to be proven rather than trusted. Lower case only, so nothing
 * depends on Postgres folding an unquoted identifier, and the tables are then reachable from
 * `psql` without quoting.
 */
export function schemaName(raw: string | undefined): string | undefined {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return DEFAULT_SCHEMA;
  if (!/^[a-z_][a-z0-9_]{0,61}$/.test(trimmed)) return undefined;
  // `pg_` is reserved for system schemas and `create schema pg_x` fails with a message about
  // reserved prefixes, which is a confusing way to learn that a configured value was wrong.
  if (trimmed.startsWith('pg_')) return undefined;
  return trimmed;
}

export interface OpenOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Injected by the tests. Production resolves the pool through `@databricks/lakebase`. */
  readonly connect?: (endpoint: string, schema: string) => Promise<Sql>;
  /**
   * Whether to create the schema on the way in. True by default, because an app booting against a
   * fresh database must create what it needs.
   *
   * Set false by a caller that only reads. `ensureSchema` ends with `create index if not exists`,
   * which requires ownership of the table even when the index is already there, so an identity that
   * can read every row is still refused at connect with `must be owner of table scans` — measured on
   * the labs Lakebase `waf` schema, 2026-08-17. The refusal happens before the caller can send a
   * `select`, so the only way to read as a non-owner was to build a pool by hand and stop measuring
   * what the app does. See `91`.
   *
   * **This does not make the connection read-only.** It skips DDL the caller did not ask for; a role
   * with write privileges still has them. The guarantee is about what this function does, not about
   * what the handle it returns will refuse — and a name promising otherwise would be a claim nothing
   * here enforces.
   */
  readonly ensureSchema?: boolean;
}

/**
 * A pool against the bound endpoint, with the schema created if it was not there.
 *
 * Throws when the endpoint is unbound. The caller decides what to do about that, and this app's
 * answer is to refuse to start and say so — see `store-choice.ts`.
 */
export async function openPostgres(options: OpenOptions = {}): Promise<Postgres> {
  const env = options.env ?? process.env;

  const endpoint = (env[ENDPOINT_ENV] ?? '').trim();
  if (endpoint === '') {
    throw new Error(
      `${ENDPOINT_ENV} is unset, so there is no Lakebase endpoint to connect to. Bind a Lakebase ` +
        'database to this app.'
    );
  }

  const schema = schemaName(env[SCHEMA_ENV]);
  if (schema == null) {
    throw new Error(
      `${SCHEMA_ENV} is "${String(env[SCHEMA_ENV])}", which is not a usable Postgres schema name. Use ` +
        'lower-case letters, digits and underscores, starting with a letter or underscore, and not ' +
        'beginning with "pg_".'
    );
  }

  const sql = options.connect ? await options.connect(endpoint, schema) : await connectLakebase(endpoint);
  const end = (): Promise<void> =>
    'end' in sql && typeof sql.end === 'function' ? (sql.end as () => Promise<void>)() : Promise.resolve();

  try {
    if (options.ensureSchema !== false) await ensureSchema(sql, schema);
  } catch (cause) {
    // The pool is already open at this point, and the caller is about to be handed a rejection
    // rather than a handle, so nobody else can close it. That matters because the caller retries:
    // a role without CREATE fails here every thirty seconds, and each attempt would otherwise
    // leave a pool of ten connections behind until Lakebase refuses the next one.
    await end().catch(() => undefined);
    throw cause;
  }

  // Forwarded rather than reimplemented: only the handle that knows whether it is a pool or a single
  // connection can say what a transaction on it means.
  const session = sql.session?.bind(sql);
  return {
    schema,
    query: (text, values) => sql.query(text, values),
    ...(session != null ? { session } : {}),
    end,
  };
}

async function connectLakebase(endpoint: string): Promise<Sql> {
  const workspaceClient = getWorkspaceClient({});
  // The Postgres role is the Databricks identity. On the platform that is the app's service
  // principal, arriving as DATABRICKS_CLIENT_ID; locally it is whoever the CLI profile is, which
  // needs the API lookup. `createLakebasePool` reads host, database and port from the
  // environment, all of which the platform injects for a bound `postgres` resource.
  const user = await getUsernameWithApiLookup({ workspaceClient });
  const pool = createLakebasePool({ endpoint, workspaceClient, ...(user != null ? { user } : {}) });

  // `pg` types `rows` as its own row constraint, and `Sql` asks for whatever the caller named. The two
  // are the same array; only the driver's generic bound differs, and this is the one place in the app
  // that meets it.
  const asRows = <T>(answer: Promise<{ rows: unknown[] }>): Promise<{ rows: T[] }> => answer as Promise<{ rows: T[] }>;

  return {
    query: (text, values) => asRows(pool.query(text, values as unknown[])),

    async session(run) {
      // One connection out of the pool, and released in `finally` whatever happens: a client leaked
      // here is a connection the pool never offers again, and ten of those is an app that stops
      // answering rather than one that reports a fault.
      const client = await pool.connect();
      try {
        await client.query('begin');
        const answer = await run({ query: (text, values) => asRows(client.query(text, values as unknown[])) });
        await client.query('commit');
        return answer;
      } catch (cause) {
        // Swallowed, because the caller is about to see `cause` and a rollback that itself failed
        // means the connection is already gone — reporting that instead would replace the reason
        // with a symptom.
        await client.query('rollback').catch(() => undefined);
        throw cause;
      } finally {
        client.release();
      }
    },
  };
}

/**
 * The tables, created if absent.
 *
 * Idempotent and run on every boot rather than versioned: there is one schema version, this is
 * it, and a migration framework for three tables nobody has shipped yet would be scaffolding
 * around a decision not yet made. When the shape changes and there is data to keep, that is when
 * a migration earns its place — and ADR 0031 says so rather than leaving it implied.
 *
 * Every statement is `if not exists`, so two app replicas booting together race harmlessly.
 */
export async function ensureSchema(sql: Sql, schema: string): Promise<void> {
  await sql.query(`create schema if not exists ${schema}`);

  // The full scan and its summary in one row, in two columns. The summary is what the history
  // page reads, and reading seven numbers out of a hundred-kilobyte document to draw a sparkline
  // is the cost the volume store kept a second directory to avoid. Here it is a second column.
  await sql.query(`
    create table if not exists ${schema}.scans (
      id          text        primary key,
      started_at  timestamptz not null,
      summary     jsonb       not null,
      body        jsonb       not null,
      written_at  timestamptz not null default now()
    )
  `);
  await sql.query(`create index if not exists scans_newest_first on ${schema}.scans (started_at desc)`);

  // Append-only, both of them. Superseding is recorded and never destructive, so there is no
  // update and no delete on either table — a corrected attestation is a new row that names the
  // one it replaced, which is what makes "who said what, when" answerable a year later.
  for (const [table, stamp] of [
    ['attestations', 'attested_at'],
    ['decisions', 'decided_at'],
  ] as const) {
    await sql.query(`
      create table if not exists ${schema}.${table} (
        id          text        primary key,
        control_id  text        not null,
        ${stamp}    timestamptz not null,
        body        jsonb       not null,
        written_at  timestamptz not null default now()
      )
    `);
    await sql.query(`create index if not exists ${table}_by_control on ${schema}.${table} (control_id, ${stamp} desc)`);
  }

  // Assessment definitions, in two tables, and the split is the point rather than normalisation for
  // its own sake. The first holds identity and lifecycle. The second holds one row per version,
  // keyed on the pair, and is only ever inserted into — so a version is immutable because the
  // database refuses to replace it, not because nothing in the app happens to try.
  //
  // That is what makes a lost race visible. Two people revising one assessment both compute version
  // 3 from the same read; one insert wins and the other raises a unique violation the store turns
  // into a conflict its author can act on. A single row holding the versions as an array would have
  // let the second write land on top, dropping a revision with nothing recording that it existed.
  await sql.query(`
    create table if not exists ${schema}.assessment_definitions (
      id          text        primary key,
      created_at  timestamptz not null,
      archived_at timestamptz
    )
  `);
  await sql.query(`
    create table if not exists ${schema}.assessment_definition_versions (
      definition_id text        not null,
      version       integer     not null,
      fingerprint   text        not null,
      created_at    timestamptz not null,
      body          jsonb       not null,
      digest        text,
      written_at    timestamptz not null default now(),
      primary key (definition_id, version)
    )
  `);
  // Runs are compared on the fingerprint, so finding the versions that share one is a read the
  // trend view makes rather than a report anybody runs by hand.
  await sql.query(
    `create index if not exists definition_versions_by_fingerprint on ${schema}.assessment_definition_versions (fingerprint)`
  );

  // An assessment part-written, one row per author per target. The only table here that is
  // overwritten and deleted rather than appended to, and the reason is that the key includes the
  // author: there is no second writer to lose a race with, so a repeated write is the same person
  // having typed more and refusing it would stop the wizard saving twice. Nothing references a
  // draft, so nothing dangles when it is removed.
  //
  // `definition_id` is not null and holds the empty string for a new assessment, because a nullable
  // column cannot be part of a primary key and `on conflict` needs the key to match on. Without
  // that, every save of a new assessment would insert another row and the author would come back to
  // a list of near-identical drafts.
  await sql.query(`
    create table if not exists ${schema}.assessment_setup_drafts (
      author        text        not null,
      definition_id text        not null,
      saved_at      timestamptz not null,
      body          jsonb       not null,
      primary key (author, definition_id)
    )
  `);

  // Evidence an admin collected and somebody uploaded, one row per collection.
  //
  // The digest of the probe set is the primary key, and that is the replay defence rather than a
  // convenience. `trust.ts` also refuses a digest it has already seen, but it reads a set and then
  // decides, so two uploads of one file arriving together both read a set without it in — one of them
  // has to lose, and the only thing that can make it lose reliably is this index. The check produces
  // the sentence; the constraint makes it true.
  //
  // `cautions` is stored beside the envelope rather than recomputed on read, because recomputing gives
  // a different answer later: a collection accepted as fresh becomes one that would now be refused.
  // What was true at import is what a finding citing it has to be able to show.
  await sql.query(`
    create table if not exists ${schema}.imported_evidence (
      digest       text        primary key,
      generated_at timestamptz not null,
      imported_at  timestamptz not null,
      imported_by  text        not null,
      body         jsonb       not null,
      cautions     jsonb       not null,
      written_at   timestamptz not null default now()
    )
  `);
  await sql.query(
    `create index if not exists imported_evidence_newest_first on ${schema}.imported_evidence (imported_at desc)`
  );
  // The seven facts the imports list shows, promoted out of `body` for the reason `considered` is
  // promoted out of an advisory's: drawing the list otherwise means detoasting and parsing every
  // stored envelope to compute a summary and throw the envelope away. `body` passes the two-kilobyte
  // threshold in every real collection, so every row of that list was an out-of-line read.
  //
  // Nullable, because a row written before this column existed has no summary and cannot be given one
  // in SQL — what a summary counts is defined in `import/summary.ts` and stating it a second time here
  // is the arrangement the comment above `runs.kind` declines. `summaries()` recomputes those rows
  // from their bodies and writes the answer back, so the null is transitional per row rather than a
  // second read path that stays.
  //
  // Row 85 measured what it saves: nothing at the size labs collects (25.8 KiB, 0.09 ms an import) and
  // 44 ms for a single import at the eight megabytes `read.ts` accepts. See
  // `docs/design/import-list-cost.md`.
  await sql.query(`alter table ${schema}.imported_evidence add column if not exists summary jsonb`);

  // What people did, as opposed to what it produced. Append-only and chained: `sequence` is the
  // primary key and is contiguous, so a removed row leaves a gap a verifier reports, and each row's
  // digest covers the digest of the row before it, so an edit in place cannot be made consistent
  // without rewriting everything after it.
  //
  // `sequence` is the key rather than `id` for one reason: two appends read the same head and both
  // compute the same next sequence, and the database refusing the second is what makes the chain
  // hold without a lock. `id` is unique as well, so a retry that follows an insert which succeeded
  // and failed to report it is refused rather than written twice.
  //
  // The columns beside `body` are duplicates of what is inside it, and exist only so Postgres can
  // filter and index. `body` is the authority — the digest covers it and not them — which is the
  // right way round: an editor who changes an indexed copy changes what a search finds and not what
  // a verifier reads, and the verifier is the one that reports the discrepancy.
  await sql.query(`
    create table if not exists ${schema}.audit_events (
      sequence    bigint      primary key,
      id          text        not null unique,
      at          timestamptz not null,
      actor       text        not null,
      action      text        not null,
      outcome     text        not null,
      target_id   text,
      correlation text,
      previous    text        not null,
      digest      text        not null,
      body        jsonb       not null,
      written_at  timestamptz not null default now()
    )
  `);
  // Newest first is how the log is read, and by actor and by action are the two questions an
  // administrator asks of it. `at` carries its own index because retention deletes on it.
  //
  // There is no index for newest-first itself. There was one — `(sequence desc)` — and it duplicated
  // the primary key, which a b-tree reads backwards at the same cost: measured over 200,000 events,
  // both plans take four buffers, whether the page is the newest fifty, a keyset page from the middle,
  // or `max(sequence)`. What it cost was 4.4 MB against a 16 MB heap and a write on every append, so
  // it is dropped below rather than left for a reader to wonder about. An index on a column already
  // ordered by the key earns nothing.
  await sql.query(`drop index if exists ${schema}.audit_events_newest_first`);
  await sql.query(`create index if not exists audit_events_by_actor on ${schema}.audit_events (actor, sequence desc)`);
  await sql.query(
    `create index if not exists audit_events_by_action on ${schema}.audit_events (action, sequence desc)`
  );
  await sql.query(`create index if not exists audit_events_by_time on ${schema}.audit_events (at)`);
  // The other two questions, each partial because most rows answer neither: an act on nothing in
  // particular has no target, and one that belongs to nothing larger has no correlation. A full index
  // on a mostly-null column is a copy of the table sorted by nothing.
  await sql.query(
    `create index if not exists audit_events_by_target on ${schema}.audit_events (target_id, sequence desc) where target_id is not null`
  );
  await sql.query(
    `create index if not exists audit_events_by_correlation on ${schema}.audit_events (correlation, sequence desc) where correlation is not null`
  );

  // Where the audit chain begins, once retention has removed a prefix of it. One row, keyed on a
  // literal 1, because there is exactly one floor per log and a second row would be a second answer
  // to "where does this start" — which is the question the row exists to settle.
  //
  // The digest is the one belonging to the last event that was removed, so a verifier picks the chain
  // up from a value it can compare against rather than finding an event whose predecessor is gone.
  await sql.query(`
    create table if not exists ${schema}.audit_floor (
      id         smallint    primary key,
      sequence   bigint      not null,
      digest     text        not null,
      trimmed_at timestamptz not null,
      trimmed_by text        not null
    )
  `);

  // Plans and the actions inside them, one row per revision of each, keyed on the pair. Insert-only,
  // like the definition versions above and for the same reason: these records are edited by people
  // and often by two people within the same minute, and a primary key the database enforces is what
  // turns the second of two simultaneous transitions into a message its author can act on. An
  // updated row would have taken the newer write and left the loser believing their move had landed.
  //
  // `revision` is the length of the record's own history, so nothing has to keep a counter in step.
  // `changed_at` is when this revision came to be; `created_at` is when the record did, and is what
  // retention measures. An action carries its plan's `created_at` as well, which is the column its
  // own retention reads — a plan and the work inside it age together, or a sweep leaves actions
  // nobody can trace back to the decision that raised them.
  for (const [table, extra] of [
    ['improvement_plans', ''],
    ['improvement_actions', 'plan_id text not null, plan_created_at timestamptz not null,'],
  ] as const) {
    await sql.query(`
      create table if not exists ${schema}.${table} (
        id         text        not null,
        revision   integer     not null,
        ${extra}
        created_at timestamptz not null,
        changed_at timestamptz not null,
        body       jsonb       not null,
        digest     text        not null,
        written_at timestamptz not null default now(),
        primary key (id, revision)
      )
    `);
  }
  // The plans list reads newest first, and an action is read by the plan it belongs to.
  await sql.query(
    `create index if not exists improvement_plans_newest_first on ${schema}.improvement_plans (created_at desc)`
  );
  await sql.query(
    `create index if not exists improvement_actions_by_plan on ${schema}.improvement_actions (plan_id, revision desc)`
  );
  // An action is also read by the requirement it names, which is a field of the body rather than a
  // column: a requirement drill-through asks which actions cite it. `jsonb_path_ops` indexes only
  // the containment operator, which is the only one this read uses, and is smaller for it. Indexing
  // the array rather than promoting it to a column keeps the body the single writer of that fact.
  await sql.query(
    `create index if not exists improvement_actions_by_control on ${schema}.improvement_actions
       using gin ((body -> 'controlIds') jsonb_path_ops)`
  );
  // Swept on `plan_created_at`. Neither index above reaches it — the GIN one indexes an expression.
  // Measured by `83`: 429 heap pages to 2, and it grows with the catalogue.
  await sql.query(
    `create index if not exists improvement_actions_by_sweep on ${schema}.improvement_actions (plan_created_at asc)`
  );

  /*
   * Validation attempts: whether the work an owner claimed was done actually was.
   *
   * The same key as the two tables above and at most two rows per attempt — revision 0 as requested,
   * revision 1 once answered — because an attempt has exactly two states and the second is written by
   * whichever instance of this app notices the answering run first. The key is what makes the second
   * instance lose rather than overwrite an answer that already cites a run.
   *
   * There is no `revision` field on the record: an attempt with an answer is revision 1 and one without
   * is revision 0, so the number is derived from the thing it describes rather than stored beside it.
   *
   * `answered` is an indexed copy of whether the body has an answer, for the one read here whose cost
   * would otherwise grow with every validation this install has ever finished rather than with the
   * number it is waiting on. `plan_created_at` is the plan's date, which is what retention measures, so
   * a plan, its actions and the validations of those actions age together — a verification left behind
   * citing a run and an action that are both gone is worse than nothing.
   */
  await sql.query(`
    create table if not exists ${schema}.validation_attempts (
      id              text        not null,
      revision        integer     not null,
      action_id       text        not null,
      plan_id         text        not null,
      plan_created_at timestamptz not null,
      requested_at    timestamptz not null,
      answered        boolean     not null,
      body            jsonb       not null,
      digest          text        not null,
      written_at      timestamptz not null default now(),
      primary key (id, revision)
    )
  `);
  // An action's attempts are read wherever the action is shown; the outstanding ones after every run.
  await sql.query(
    `create index if not exists validation_attempts_by_action on ${schema}.validation_attempts (action_id, revision desc)`
  );
  await sql.query(
    `create index if not exists validation_attempts_outstanding on ${schema}.validation_attempts (answered, requested_at asc)`
  );
  // Swept on `plan_created_at`, which nothing above leads with. Measured by `83`: the retention page's
  // count reads 1,392 heap pages here and 2 with this, the largest saving of the twenty-two, and the
  // table grows with the catalogue so the saving does too. See docs/design/retention-sweep-cost.md.
  await sql.query(
    `create index if not exists validation_attempts_by_sweep on ${schema}.validation_attempts (plan_created_at asc)`
  );

  /*
   * Accepted risks: the requirements somebody has decided not to meet, for a while, on purpose.
   *
   * The same key as the tables above and at most two rows per acceptance — revision 0 as recorded,
   * revision 1 once revoked — because an acceptance has exactly two states. A renewal is not one of
   * them: it is a new acceptance naming the one it replaces, so that a risk carried for two years
   * cannot be made to read like a fresh decision by moving a date.
   *
   * Four indexed copies of facts already in the body, and each is read rather than kept for symmetry.
   * `control_id` is how a finding asks whether it is accepted. `expires_at` is the order somebody
   * reviewing the register works in, and the column a report of what is about to come back reads.
   * `owner` is how an owner finds what they are carrying. `revoked` distinguishes the two revisions
   * without parsing jsonb.
   */
  await sql.query(`
    create table if not exists ${schema}.accepted_risks (
      id             text        not null,
      revision       integer     not null,
      control_id     text        not null,
      ordinal        integer     not null,
      owner          text        not null,
      residual       text        not null,
      effective_from timestamptz not null,
      expires_at     timestamptz not null,
      recorded_at    timestamptz not null,
      revoked        boolean     not null,
      body           jsonb       not null,
      digest         text        not null,
      written_at     timestamptz not null default now(),
      primary key (id, revision)
      -- One acceptance of a requirement at a time, per assessment. The unique index is created in
      -- scopeUniqueness after definition_id exists, because a column declared here would never
      -- appear on an install that predates it. See ADR 0054.
    )
  `);
  await sql.query(
    `create index if not exists accepted_risks_by_control on ${schema}.accepted_risks (control_id, revision desc)`
  );
  await sql.query(
    `create index if not exists accepted_risks_by_expiry on ${schema}.accepted_risks (expires_at asc, revoked)`
  );
  await sql.query(`create index if not exists accepted_risks_by_owner on ${schema}.accepted_risks (owner)`);
  // Swept on `recorded_at`. `accepted_risks_by_expiry` leads with a different timestamp, which serves
  // nothing here. Measured by `83`: 1,068 heap pages to 2, and it grows with the catalogue.
  await sql.query(`create index if not exists accepted_risks_by_sweep on ${schema}.accepted_risks (recorded_at asc)`);

  /*
   * Applicability decisions: the requirements a customer has taken out of their own score, either as not
   * applicable to their estate or by disabling the check.
   *
   * The same shape as the accepted risks above and for the same reasons — two rows per decision at most,
   * revision 0 as recorded and revision 1 once revoked, a renewal a new record naming the one it
   * replaces — because a decision has exactly two states and how long a requirement has been excluded
   * has to stay readable. The record and its rules are 31b; this table is 31d; nothing here moves a
   * score until 31f wires it in. See ADR 0059.
   *
   * `lever` is stored as a column as well as in the body because it is the one field a register groups
   * by — not-applicable and disabled read differently on the coverage bar (31c measured it) — and a
   * count of each is a read that should not parse jsonb. `control_id`, `expires_at` and `owner` earn
   * their indexes the way the accepted risks' do: the requirement asks whether it is excluded, the
   * register is read in expiry order, and an owner finds what they are carrying.
   */
  await sql.query(`
    create table if not exists ${schema}.applicability_decisions (
      id             text        not null,
      revision       integer     not null,
      control_id     text        not null,
      lever          text        not null,
      ordinal        integer     not null,
      owner          text        not null,
      effective_from timestamptz not null,
      expires_at     timestamptz not null,
      recorded_at    timestamptz not null,
      revoked        boolean     not null,
      body           jsonb       not null,
      digest         text        not null,
      written_at     timestamptz not null default now(),
      primary key (id, revision)
      -- One decision on a requirement at a time, per assessment. The unique index is created in
      -- scopeUniqueness after definition_id exists, for the same reason accepted_risks' is.
    )
  `);
  await sql.query(
    `create index if not exists applicability_by_control on ${schema}.applicability_decisions (control_id, revision desc)`
  );
  await sql.query(
    `create index if not exists applicability_by_expiry on ${schema}.applicability_decisions (expires_at asc, revoked)`
  );
  await sql.query(`create index if not exists applicability_by_owner on ${schema}.applicability_decisions (owner)`);
  // Swept on `recorded_at`, as `accepted_risks` is and for the same reason. 1,068 heap pages to 2.
  await sql.query(
    `create index if not exists applicability_by_sweep on ${schema}.applicability_decisions (recorded_at asc)`
  );

  /*
   * Notes: append-only prose about a run, a pillar or a requirement.
   *
   * No revision column and no `changed_at`, because there is no second version of a note. A correction
   * is another row naming the one it corrects, so the table only ever grows and the only key it needs
   * is the id.
   *
   * `subject_kind` and `subject_id` are indexed copies of two fields of the body, which is the same
   * arrangement `improvement_actions` uses for `plan_id`: a thread is fetched by subject on every page
   * that shows one, and a read that had to parse jsonb to find its rows is the one read here that
   * would get slower as people wrote more.
   */
  await sql.query(`
    create table if not exists ${schema}.notes (
      id           text        primary key,
      subject_kind text        not null,
      subject_id   text        not null,
      noted_at     timestamptz not null,
      body         jsonb       not null,
      digest       text        not null,
      written_at   timestamptz not null default now()
    )
  `);
  // A thread is read oldest first, which is the order the index gives it.
  await sql.query(
    `create index if not exists notes_by_subject on ${schema}.notes (subject_kind, subject_id, noted_at asc)`
  );

  /*
   * Serving declarations: which relations a customer says they serve, and what those must carry.
   *
   * Insert-only, and here that is the record's guarantee rather than a preference. A readiness outcome
   * is a reading *of a declaration* — every dimension is a share of the population it selects — and it
   * carries the declaration's fingerprint for that reason. A row that could be edited in place would
   * re-date every reading ever taken against it, so a revision is a new row at the next version.
   *
   * Both unique indexes are created here rather than in `scopeUniqueness`, which is the one difference
   * from the three tables that live there: those had rows before the constraint, and this table has
   * none, so there is nothing an index could fail to build over. The pair is the same pair, and for the
   * same reason — a null `definition_id` is not constrained by an index over it, so the two populations
   * are declared separately. What the constraint buys is that two people declaring the next version at
   * the same moment collide in the database rather than in a read-then-write that cannot see the other.
   *
   * `fingerprint` is a column as well as a field of the body so an outcome can be joined back to the
   * declaration it names without parsing jsonb. Nothing reads it that way yet; it is one word here and
   * a migration later. See ADR 0086.
   */
  await sql.query(`
    create table if not exists ${schema}.serving_declarations (
      id            text        not null,
      version       integer     not null,
      declared_at   timestamptz not null,
      declared_by   text        not null,
      fingerprint   text        not null,
      body          jsonb       not null,
      digest        text        not null,
      definition_id text,
      written_at    timestamptz not null default now()
    )
  `);
  await sql.query(
    `create unique index if not exists serving_declarations_version_scoped
       on ${schema}.serving_declarations (definition_id, version) where definition_id is not null`
  );
  await sql.query(
    `create unique index if not exists serving_declarations_version_unscoped
       on ${schema}.serving_declarations (version) where definition_id is null`
  );

  // A review of one completed scan, the pillar records written against it, and the result that
  // exists only when every pillar has one. Insert-only: a scheduled run arriving while a review is
  // open must not discard that review or the previous result, and the cheapest way to keep that
  // true for anything that can reach the table is for the update not to exist.
  //
  // Unique on `run_id` rather than `(definition_id, run_id)` because a scan is of one assessment
  // (or none), so one review per scan is the real constraint, and because nulls do not collide —
  // two unscoped reviews of the same scan would otherwise both exist.
  await sql.query(`
    create table if not exists ${schema}.assessment_reviews (
      id         text        primary key,
      run_id     text        not null,
      opened_at  timestamptz not null,
      body       jsonb       not null,
      digest     text        not null,
      written_at timestamptz not null default now()
    )
  `);
  await sql.query(
    `create unique index if not exists assessment_reviews_of_run on ${schema}.assessment_reviews (run_id)`
  );

  await sql.query(`
    create table if not exists ${schema}.pillar_reviews (
      id          text        primary key,
      review_id   text        not null,
      pillar_id   text        not null,
      recorded_at timestamptz not null,
      body        jsonb       not null,
      digest      text        not null,
      written_at  timestamptz not null default now()
    )
  `);
  await sql.query(
    `create unique index if not exists pillar_reviews_at_pillar on ${schema}.pillar_reviews (review_id, pillar_id)`
  );

  // Answers given from inside a review, which is the difference between an answer this review
  // produced and one it found on the run. Its own table rather than a fourth kind of pillar row,
  // because there are many per pillar and `pillar_reviews` is unique on the pair.
  //
  // Unique on the attestation: an attestation is written once, so one review record about it is the
  // whole of what there is to say, and a retried request lands the same row rather than counting an
  // answer twice.
  await sql.query(`
    create table if not exists ${schema}.review_answers (
      id             text        primary key,
      review_id      text        not null,
      pillar_id      text        not null,
      attestation_id text        not null,
      recorded_at    timestamptz not null,
      body           jsonb       not null,
      digest         text        not null,
      written_at     timestamptz not null default now()
    )
  `);
  await sql.query(
    `create unique index if not exists review_answers_of_attestation
       on ${schema}.review_answers (attestation_id)`
  );
  // Swept on `recorded_at`, which the unique index above does not reach. 593 heap pages to 2, and it
  // grows with the catalogue. Measured by `83` — see docs/design/retention-sweep-cost.md.
  await sql.query(`create index if not exists review_answers_by_sweep on ${schema}.review_answers (recorded_at asc)`);

  await sql.query(`
    create table if not exists ${schema}.assessment_results (
      id           text        primary key,
      review_id    text        not null,
      finalised_at timestamptz not null,
      body         jsonb       not null,
      digest       text        not null,
      written_at   timestamptz not null default now()
    )
  `);
  await sql.query(
    `create unique index if not exists assessment_results_of_review on ${schema}.assessment_results (review_id)`
  );

  // How long each class of record is kept. A row per class rather than one document of three, so two
  // administrators setting different classes at the same time cannot have the second discard the
  // first — three upserts into three keys race into nothing.
  //
  // Absent rows mean the defaults, which is why there is no seeding step: a fresh database reports
  // the approved periods without a write, and a write only happens when somebody changes one.
  await sql.query(`
    create table if not exists ${schema}.retention_periods (
      retention_class text        primary key,
      days            integer     not null,
      set_by          text        not null,
      set_at          timestamptz not null
    )
  `);

  // Reasons not to delete something. A released hold keeps its row: "there was a hold on this from
  // March to July" is the question somebody asks about a record that is unexpectedly still here, and
  // deleting the hold on release would make the retained rows unaccountable.
  await sql.query(`
    create table if not exists ${schema}.legal_holds (
      id          text        primary key,
      reason      text        not null,
      covers      jsonb       not null,
      placed_by   text        not null,
      placed_at   timestamptz not null,
      released_by text,
      released_at timestamptz,
      written_at  timestamptz not null default now()
    )
  `);
  // A sweep asks for the holds in force on every run, so the partial index is the one that is read.
  await sql.query(
    `create index if not exists legal_holds_in_force on ${schema}.legal_holds (placed_at desc) where released_at is null`
  );

  // A run of the assessment, as a record rather than as a promise in one process's memory.
  //
  // `idempotency_key` is unique and nullable, which is the whole of the duplicate-trigger defence.
  // `runs.ts` decides whether a repeated trigger may join a run, but it reads and then writes, so
  // two retries arriving together both read no run and one of them has to lose. Only this constraint
  // makes it lose reliably. Nullable because an admin pressing scan supplies no key and two admins
  // pressing it are two intentions, not one repeated — the single-run rule refuses the second.
  //
  // The lease is two columns rather than a row in a lock table because it is a property of the run:
  // asking "is anything working on this" is then the same read as asking what the run is, and there
  // is no arrangement in which a lock outlives the run it refers to.
  //
  // `lease_until` is not null, and never null even when nothing holds the run — it is then the moment
  // the run became free, which for a new run is the moment it was asked for. That is not tidiness. It
  // makes "may I take this" a single comparison, `lease_until <= now`, instead of a comparison or a
  // null check; and a condition with an `or` in it is one a later reader can get subtly wrong in a way
  // that puts two processes on one assessment. `lease_holder` is the column that says whether anything
  // holds it, and that one is nullable.
  await sql.query(`
    create table if not exists ${schema}.runs (
      id                    text        primary key,
      requested_at          timestamptz not null,
      actor                 text        not null,
      trigger               text        not null,
      idempotency_key       text        unique,
      request               jsonb       not null,
      state                 text        not null,
      attempts              integer     not null default 0,
      lease_holder          text,
      lease_until           timestamptz not null,
      cancel_requested_at   timestamptz,
      scan_id               text,
      finished_at           timestamptz,
      why                   text,
      written_at            timestamptz not null default now()
    )
  `);
  // Two reads, and both are on every boot or every trigger: what is still running, and what ran
  // recently. Neither is large enough today to need an index and both will be, because the table only
  // grows and the interesting rows are always the newest.
  await sql.query(
    `create index if not exists runs_unfinished on ${schema}.runs (requested_at desc) where finished_at is null`
  );
  await sql.query(`create index if not exists runs_newest_first on ${schema}.runs (requested_at desc)`);

  // What each attempt read, so that the next one does not read it again.
  //
  // Keyed on the run and the signal rather than appended to, because the useful question is "what
  // does this run already know", and a resumed attempt re-reading a signal should replace its reading
  // rather than accumulate two. `resumeFrom` takes the later of two anyway; this keeps the table from
  // growing by a copy of the estate per attempt.
  await sql.query(`
    create table if not exists ${schema}.run_checkpoints (
      run_id     text        not null,
      signal_id  text        not null,
      at         timestamptz not null,
      reading    jsonb       not null,
      primary key (run_id, signal_id)
    )
  `);

  // One row per attempt, so that a retry is a fact about the past rather than a counter.
  //
  // Without this, three attempts and one success is indistinguishable from one attempt that took
  // three times as long, and the question at a review — "does the scheduled run work" — has no
  // answer. `abandoned` is what an attempt records about the one it took over from, which is the only
  // way that ever gets written: the process it describes is not running.
  await sql.query(`
    create table if not exists ${schema}.run_attempts (
      id            text        primary key,
      run_id        text        not null,
      number        integer     not null,
      holder        text        not null,
      started_at    timestamptz not null,
      heartbeat_at  timestamptz not null,
      ended_at      timestamptz,
      outcome       text
    )
  `);
  await sql.query(`create index if not exists run_attempts_by_run on ${schema}.run_attempts (run_id, number asc)`);

  // The digest of each record, added by `alter` rather than declared in the tables above, and
  // nullable. Both of those are deliberate.
  //
  // By `alter` because a pilot's database already has these tables with rows in them, and `create
  // table if not exists` does nothing at all to a table that is already there — so a column added
  // to the declarations above would never appear on an existing database, and the digest would
  // silently never be written. This is the schema change ADR 0031 said would earn a migration when
  // there was data to keep. It is three statements, so it is here rather than in a framework.
  //
  // Nullable because a row written before this landed has no digest and cannot honestly be given one
  // now: computing it from the stored body today would stamp whatever that body says today, which is
  // exactly what a digest is supposed to be unable to do. `verifyRecords` reports those rows as
  // unstamped rather than as verified, which is the true answer.
  for (const table of ['scans', 'attestations', 'decisions'] as const) {
    await sql.query(`alter table ${schema}.${table} add column if not exists digest text`);
  }

  // What a run is for, added by `alter` for the same reason and nullable for a different one.
  //
  // By `alter` because `create table if not exists` does nothing to a table that already has rows, so
  // a column declared above would never appear on a pilot's database and every advisory run would be
  // written as an assessment.
  //
  // Nullable rather than defaulted to `'assessment'` in the schema, which would have been shorter. A
  // default here would put the claim "a row with no kind is an assessment" in two places — this line
  // and `reviveRun` — and the version that is easy to miss is the one in SQL. It is true because the
  // advisor is what added the column, and that reason is worth reading next to the code that relies
  // on it. See ADR 0069.
  await sql.query(`alter table ${schema}.runs add column if not exists kind text`);
  // The advisor's history is its own list, and so is the assessment's. Neither wants the other's rows,
  // and both ask for the newest first.
  await sql.query(`create index if not exists runs_by_kind on ${schema}.runs (kind, requested_at desc)`);
  // What an advisory run produced, for the same reason `scan_id` exists and pointedly not that column.
  // A pointer named for one kind of output holding another is how a report gets exported as an
  // assessment; ADR 0069 settled that each kind gets its own.
  await sql.query(`alter table ${schema}.runs add column if not exists advisory_id text`);

  // The advisor's own records.
  //
  // Its own table rather than `scans` with a flag, because ADR 0061 separated the two on retention,
  // cadence and how fast the answer goes stale — and a shared table would make every read of either
  // say which it wanted, with an assessment export that swept up advice as the failure mode.
  //
  // The analysis is a JSON body for the reason a scan's is: what an analysis contains changes as
  // analyses are added, and a shape needing a migration per rule is a shape that discourages rules.
  // Promoted to columns is only what is filtered or ordered on, plus `considered` — the one number a
  // history row shows, which would otherwise mean parsing every stored analysis to draw a list.
  await sql.query(`
    create table if not exists ${schema}.advisories (
      id            text        primary key,
      run_id        text        not null,
      started_at    timestamptz not null,
      finished_at   timestamptz not null,
      state         text        not null,
      scope         text        not null,
      lookback_days integer     not null,
      definition_id text,
      considered    integer     not null default 0,
      body          jsonb       not null,
      written_at    timestamptz not null default now()
    )
  `);
  // Two reads: the newest, and the one a given run produced. The second is how a supervisor holding a
  // run id finds what its run concluded, and it is unique in practice — a run produces at most one.
  await sql.query(`create index if not exists advisories_newest_first on ${schema}.advisories (finished_at desc)`);
  await sql.query(`create unique index if not exists advisories_by_run on ${schema}.advisories (run_id)`);

  // The query plans an advisory run retrieved, three executions per shape (33n).
  //
  // Its own table rather than the advisory's body, for two reasons that point the same way. `33b`
  // measured the extracts at 2 MB per workspace per scan against a body that is one document; and what
  // bounds them is a count per shape rather than the advisory's period, because a shape's plans are kept
  // to be compared against each other. `plan-store.ts` has the full argument.
  //
  // `advisory_id` is not a foreign key, for the reason the sweep gives: retention removes advisories on
  // their own period, and a constraint would make that removal fail rather than leave these rows to be
  // swept in the same pass. It is here to trace a plan to the run whose summary counted it — which is a
  // trace and not a guarantee: `keep` writes before the advisory is saved, so a run that failed at the
  // save leaves rows naming an advisory that was never stored. They are swept on their own period.
  //
  // Two timestamps, doing the two different jobs `improvement_actions` splits the same way. `observed_at`
  // is when the customer's query ran, and orders the three a shape keeps. `advisory_at` is the run that
  // filed them, and is what retention ages the row from — an execution can be a lookback window old on
  // the day it is filed, so aging from `observed_at` would let a configured period shorter than the
  // lookback sweep a plan the run had just written. See the entry in `retention.ts`.
  await sql.query(`
    create table if not exists ${schema}.plan_extracts (
      workspace_id  text        not null,
      shape         text        not null,
      statement_id  text        not null,
      advisory_id   text        not null,
      advisory_at   timestamptz not null,
      observed_at   timestamptz not null,
      shape_version text        not null,
      extract       jsonb       not null,
      written_at    timestamptz not null default now(),
      primary key (workspace_id, shape, statement_id)
    )
  `);
  // Every read and the trim are one shape's rows. The key's leading columns already serve that, so this
  // index exists for the sweep, which reads by age across every shape.
  await sql.query(`create index if not exists plan_extracts_by_age on ${schema}.plan_extracts (advisory_at)`);

  // A published month, frozen at publish and served back verbatim (ADR 0072, C2).
  //
  // `json` and `csv` are `text`, not `jsonb`, and this is the one place that choice is load-bearing
  // rather than incidental: a published month is frozen, and a digest recorded over the stored bytes
  // has to match what is read back. `jsonb` stores a parsed document and returns its keys in its own
  // order, so it would break the one property the record type exists to hold. The columns beside the
  // text — `month`, `published_at`, `document_version` — are indexed copies for filtering and ordering;
  // the text is the authority and the digest covers it.
  //
  // Append-only: `id` is the key, a month holds several publications, and a correction is a new row
  // whose `supersedes` names the one it replaces. There is no update and no delete — a superseded copy
  // stays readable at its own digest, because deleting it would leave a digest in the trail pointing at
  // bytes that are gone.
  await sql.query(`
    create table if not exists ${schema}.month_publications (
      id               text        primary key,
      month            text        not null,
      published_at     timestamptz not null,
      published_by     text        not null,
      supersedes       text,
      reason           text,
      document_version integer     not null,
      digest           text        not null,
      json             text        not null,
      csv              text        not null,
      ordinal          integer,
      written_at       timestamptz not null default now()
    )
  `);
  // The column on an install whose table predates it. Nullable rather than backfilled: a row already
  // written cannot lose a race that is over, and an `update` here would be this store's first — it is
  // append-only, and a backfill would be the schema writing history it did not observe.
  await sql.query(`alter table ${schema}.month_publications add column if not exists ordinal integer`);
  // The unique index that refuses two publications at one position used to be `(month, ordinal)` and
  // is now `(definition_id, month, ordinal)`, created in `scopeUniqueness` after the assessment key
  // exists. Dropped there rather than here so an install that already has the old index loses it in
  // the same pass that creates the new one.
  // A month's publications are read together, oldest first, so standing reads from position; the list
  // of published months is read newest first. Both are covered by an index on the pair.
  await sql.query(
    `create index if not exists month_publications_by_month on ${schema}.month_publications (month, published_at asc)`
  );

  await keyByAssessment(sql, schema);
  await versionFinalAssessments(sql, schema);
  await scopeUniqueness(sql, schema);
  await applyInvariants(sql, schema);
}

/**
 * Additive handles for the Version 2 final-assessment body.
 *
 * Nullable is the compatibility rule: a null schema version is a legacy result, not Version 2 with
 * guessed fields. Indexed copies are promoted from the body by the writer and never become a second
 * authority. The eligibility check in `invariants.ts` prevents a partial row being marked eligible.
 */
async function versionFinalAssessments(sql: Sql, schema: string): Promise<void> {
  for (const [table, columns] of [
    ['assessment_reviews', ['definition_version integer', 'definition_fingerprint text']],
    [
      'assessment_results',
      [
        'schema_version integer',
        'run_id text',
        'definition_version integer',
        'definition_fingerprint text',
        'public_methodology_version integer',
        'catalogue_revision text',
        'eligible boolean',
      ],
    ],
  ] as const) {
    for (const column of columns) {
      await sql.query(`alter table ${schema}.${table} add column if not exists ${column}`);
    }
  }

  await sql.query(
    `create index if not exists assessment_results_current_final
       on ${schema}.assessment_results (definition_id, finalised_at desc)
       where eligible is true`
  );
}

/**
 * Which assessment each scoped record belongs to, as a column.
 *
 * Last in `ensureSchema` because it alters tables the whole function above creates, and by `alter`
 * rather than in each `create` for the reason the digest column is: `create table if not exists`
 * does nothing to a table that already has rows, so a column declared up there would never appear on
 * an install that predates this and every read `42c` adds would filter on nothing.
 *
 * Nullable, and null means *not stated* rather than *the install's*. That distinction is the half of
 * the audit's requirement that survived ADR 0080: a record is never guessed into a scope. `ScanStamp`
 * already says the same thing about the field this promotes — "absent is therefore a fact rather than
 * a gap" — and this column inherits that reading rather than inventing a second one.
 *
 * True of ten of the eleven, and the eleventh is worth knowing before writing a predicate against
 * this set. `assessment_setup_drafts` had the column first, as `not null` inside its primary key, and
 * spells not-stated as the empty string rather than as null — with the reason on the line where the
 * table is created, that a nullable column cannot be part of a key `on conflict` matches on. So
 * `definition_id is null` finds nothing there. `alter` is also a no-op on that table and on
 * `advisories`, which both had the column before this; the loop covers them so that the set stays
 * one set rather than a list of exceptions.
 *
 * The set comes from `RESET_TABLES` and not from a list written here, because a second list is the
 * bug `reset.test.ts` exists to prevent, one file further along. A table classified `scoped` gets a
 * key; `by-parent` and `installation-wide` do not, and the walk that proves `by-parent` reaches a key
 * is a test in that file.
 */
async function keyByAssessment(sql: Sql, schema: string): Promise<void> {
  for (const one of RESET_TABLES) {
    if (one.context.kind !== 'scoped') continue;

    await sql.query(`alter table ${schema}.${one.table} add column if not exists definition_id text`);
    // What `42c` filters on, and it filters on this alone: an index on the key by itself covers a
    // predicate on it, and every one of these tables already has an index or a primary key serving
    // the order or the lookup it reads in. Composing the two per table would be guessing at queries
    // that are not written yet.
    await sql.query(`create index if not exists ${one.table}_by_definition on ${schema}.${one.table} (definition_id)`);
  }
}

/**
 * Uniqueness that includes the assessment, so a filter is a boundary.
 *
 * Three tables were classified scoped while still constrained as if they were not: two people
 * accepting the same requirement under two assessments, or publishing the same January, were
 * refused as duplicates of each other. The read predicate `42c` adds would hide the other
 * assessment's rows while the write side still refused to create them.
 *
 * After `keyByAssessment` because the unique index names `definition_id`, and that column is
 * what the function above adds.
 *
 * **Two indexes per table, not one, and that is the whole correctness of the change.** Postgres
 * treats nulls as distinct in a unique index, so adding a nullable `definition_id` to
 * `(control_id, ordinal, revision)` did not narrow that constraint — for a row with no assessment it
 * removed it. Two people accepting the same requirement in the same second both wrote a first
 * acceptance, both null in `definition_id`, and both landed: the register grew two standing
 * exceptions on one requirement with different owners and different expiry dates, which is the
 * outcome [ADR 0054](../../../docs/decisions/0054-an-accepted-risk-names-what-is-holding-the-line-and-expires.md)
 * put the constraint there to refuse. Its argument — a rule checked before the write is a rule a race
 * walks through — is untouched by the assessment boundary. ADR 0081 records the change.
 *
 * A row with no assessment is not an edge case. An install with none defined writes every record that
 * way, which is what a fresh install is and what every install before `42a` was, so the tables lost
 * the protection exactly where the most rows are.
 *
 * So each table gets a pair, partial on whether the row names an assessment: the scoped index holds a
 * position unique within one assessment, and the unscoped index is the constraint these tables had
 * before `42a`, unchanged, over the rows that still have no assessment. Together they say the thing
 * the single index was meant to: one acceptance of a requirement at a time, per assessment, and the
 * rows outside every assessment are one population like any other.
 *
 * **A partial pair rather than `nulls not distinct`**, which is the other way to make two nulls
 * collide and was the first attempt here. That clause is a property of the whole index rather than of
 * a column, and `month_publications.ordinal` is also nullable: rows written before `28c` gave
 * publications a position have none, two of them are not two claims on position 1, and
 * `nulls not distinct` refuses the second. Four tests said so. Nothing warns that the clause reaches
 * further than the column it was written for, and the pair cannot reach further than its predicate.
 *
 * The index names are new rather than reusing the one `42c` created, because an index's uniqueness
 * cannot be altered: a name already taken keeps its old semantics forever under `create if not
 * exists`. Dropping first instead — which is what `month_publications` did — re-does the work on
 * every boot of every replica and leaves a moment on each with nothing enforced. Creating under the
 * new names and dropping the old afterwards means no boot has neither.
 */
async function scopeUniqueness(sql: Sql, schema: string): Promise<void> {
  /*
   * The three tables, and what a position is on each.
   *
   * A loop rather than twelve statements, because the ordering below — create both replacements, then
   * drop what they replace — has to be the same on all three, and under `42c` it was not:
   * `month_publications` dropped its index first and recreated it under the same name.
   */
  const scoped = [
    { table: 'accepted_risks', position: 'control_id, ordinal, revision' },
    { table: 'applicability_decisions', position: 'control_id, ordinal, revision' },
    { table: 'month_publications', position: 'month, ordinal' },
  ] as const;

  for (const one of scoped) {
    // Within an assessment. `definition_id is not null` is what keeps the null case out of an index
    // that would not constrain it, so the predicate and the column list are one decision.
    await create(
      `${one.table}_at_position_scoped`,
      one.table,
      `definition_id, ${one.position}`,
      'definition_id is not null'
    );

    // Outside every assessment: the constraint that was there before `42a`, over the rows that still
    // have no assessment. This is the one that can fail on an install, because it is the one whose
    // rows went unconstrained while `42c` was deployed.
    await create(`${one.table}_at_position_unscoped`, one.table, one.position, 'definition_id is null');

    // Only now. While all three exist the strictest applies, so a boot interrupted between the
    // statements leaves a table over-constrained rather than under-constrained.
    await sql.query(`drop index if exists ${schema}.${one.table}_at_position`);
  }

  // The install-wide table constraints these replaced, named as Postgres named them. Outside the loop:
  // they are constraints rather than indexes, only two of the three ever had one, and the name is
  // spelled from the column list rather than from the index's.
  await sql.query(
    `alter table ${schema}.accepted_risks drop constraint if exists accepted_risks_control_id_ordinal_revision_key`
  );
  await sql.query(
    `alter table ${schema}.applicability_decisions drop constraint if exists applicability_decisions_control_id_ordinal_revision_key`
  );

  async function create(index: string, table: string, columns: string, when: string): Promise<void> {
    try {
      await sql.query(
        `create unique index if not exists ${index}
           on ${schema}.${table} (${columns}) where ${when}`
      );
    } catch (cause) {
      // An install that ran a build without this constraint can already hold the rows it forbids, and
      // this statement is then the first thing that has ever looked. Failing is right: `chooseStore`
      // serves the explanation rather than degrading, and continuing would mean running on without the
      // constraint ADR 0054 requires. Failing with Postgres's own sentence is not — it names an index
      // nobody has heard of and no row — so the colliding keys are read back and named.
      throw new Error(await duplicateReport(sql, schema, table, columns, when, cause));
    }
  }
}

/**
 * Why the unique index would not build, in a sentence an operator can act on.
 *
 * Only reached when `create unique index` fails, which on these three tables means rows the constraint
 * forbids are already there — written while it was absent. The keys are read back so the message names
 * the requirement or the month rather than the index, because the person reading it has to decide which
 * of two standing exceptions is the real one, and that is not a decision this code can take: they carry
 * different owners, reasons and expiry dates, which is the whole reason ADR 0054 refuses the second.
 *
 * The read is itself allowed to fail — a role without select on the table would fail here too — and
 * then the original error is what gets reported, because a diagnostic that swallows the failure it was
 * explaining is worse than no diagnostic.
 */
async function duplicateReport(
  sql: Sql,
  schema: string,
  table: string,
  columns: string,
  when: string,
  cause: unknown
): Promise<string> {
  const said = cause instanceof Error ? cause.message : String(cause);
  const head =
    `${schema}.${table} cannot take the unique index on (${columns}) where ${when}, which ADR 0054 ` +
    'requires, because it already holds rows the index would forbid. They were written while a build was ' +
    'running without it: 42c added the assessment to the constraint in a way that left rows with no ' +
    'assessment unconstrained, and every row on an install with no assessment defined is one of those. ' +
    'Postgres said: ' +
    said;

  try {
    const { rows } = await sql.query<Record<string, unknown>>(
      `select ${columns}, count(*) as copies from ${schema}.${table}
         where ${when} group by ${columns} having count(*) > 1 order by copies desc limit 10`
    );
    if (rows.length === 0) return head;
    const listed = rows
      .map((row) =>
        Object.entries(row)
          .map(([column, value]) => `${column}=${shown(value)}`)
          .join(' ')
      )
      .join('\n  ');
    return (
      `${head}\n\nThe keys with more than one row, worst first (up to ten):\n  ${listed}\n\n` +
      'Each is two records that both claim to be the same position. Decide which one stands — they have ' +
      'different owners and expiry dates — revoke the other through the app if it is still reachable, or ' +
      'delete the losing row, and restart. Nothing here chooses for you.'
    );
  } catch {
    return head;
  }

  /*
   * One column's value, for a message rather than for a machine.
   *
   * The columns read here are text, integers and dates, so the primitive branch is the whole of it in
   * practice. `unknown` is what the driver promises, though, and a row shape that surprised this would
   * otherwise reach an operator as `[object Object]` — a message that says a duplicate exists and will
   * not say which.
   */
  function shown(value: unknown): string {
    if (value == null) return 'null';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
      return value.toString();
    }
    if (value instanceof Date) return value.toISOString();
    return JSON.stringify(value) ?? 'unprintable';
  }
}
