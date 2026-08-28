import { RESET_TABLES } from "../admin/reset.js";
import { applyInvariants } from "./invariants.js";
import { createLakebasePool, getUsernameWithApiLookup, getWorkspaceClient } from "@databricks/lakebase";
//#region server/store/postgres.ts
/** The env var the `postgres` resource binding resolves to, via `valueFrom` in app.yaml. */
const ENDPOINT_ENV = "LAKEBASE_ENDPOINT";
/** Where the app keeps its tables. Overridable so local work does not claim the deployed schema. */
const SCHEMA_ENV = "WAF_PG_SCHEMA";
/**
* A schema name that is safe to interpolate into DDL.
*
* Parameters cannot carry an identifier — `create schema $1` is not a statement — so this value
* is concatenated into SQL and has to be proven rather than trusted. Lower case only, so nothing
* depends on Postgres folding an unquoted identifier, and the tables are then reachable from
* `psql` without quoting.
*/
function schemaName(raw) {
	const trimmed = (raw ?? "").trim();
	if (trimmed === "") return "waf";
	if (!/^[a-z_][a-z0-9_]{0,61}$/.test(trimmed)) return void 0;
	if (trimmed.startsWith("pg_")) return void 0;
	return trimmed;
}
/**
* A pool against the bound endpoint, with the schema created if it was not there.
*
* Throws when the endpoint is unbound. The caller decides what to do about that, and this app's
* answer is to refuse to start and say so — see `store-choice.ts`.
*/
async function openPostgres(options = {}) {
	const env = options.env ?? process.env;
	const endpoint = (env["LAKEBASE_ENDPOINT"] ?? "").trim();
	if (endpoint === "") throw new Error(`${ENDPOINT_ENV} is unset, so there is no Lakebase endpoint to connect to. Bind a Lakebase database to this app.`);
	const schema = schemaName(env[SCHEMA_ENV]);
	if (schema == null) throw new Error(`${SCHEMA_ENV} is "${String(env[SCHEMA_ENV])}", which is not a usable Postgres schema name. Use lower-case letters, digits and underscores, starting with a letter or underscore, and not beginning with "pg_".`);
	const sql = options.connect ? await options.connect(endpoint, schema) : await connectLakebase(endpoint);
	const end = () => "end" in sql && typeof sql.end === "function" ? sql.end() : Promise.resolve();
	try {
		if (options.ensureSchema !== false) await ensureSchema(sql, schema);
	} catch (cause) {
		await end().catch(() => void 0);
		throw cause;
	}
	const session = sql.session?.bind(sql);
	return {
		schema,
		query: (text, values) => sql.query(text, values),
		...session != null ? { session } : {},
		end
	};
}
async function connectLakebase(endpoint) {
	const workspaceClient = getWorkspaceClient({});
	const user = await getUsernameWithApiLookup({ workspaceClient });
	const pool = createLakebasePool({
		endpoint,
		workspaceClient,
		...user != null ? { user } : {}
	});
	const asRows = (answer) => answer;
	return {
		query: (text, values) => asRows(pool.query(text, values)),
		async session(run) {
			const client = await pool.connect();
			try {
				await client.query("begin");
				const answer = await run({ query: (text, values) => asRows(client.query(text, values)) });
				await client.query("commit");
				return answer;
			} catch (cause) {
				await client.query("rollback").catch(() => void 0);
				throw cause;
			} finally {
				client.release();
			}
		}
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
async function ensureSchema(sql, schema) {
	await sql.query(`create schema if not exists ${schema}`);
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
	for (const [table, stamp] of [["attestations", "attested_at"], ["decisions", "decided_at"]]) {
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
	await sql.query(`create index if not exists definition_versions_by_fingerprint on ${schema}.assessment_definition_versions (fingerprint)`);
	await sql.query(`
    create table if not exists ${schema}.assessment_setup_drafts (
      author        text        not null,
      definition_id text        not null,
      saved_at      timestamptz not null,
      body          jsonb       not null,
      primary key (author, definition_id)
    )
  `);
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
	await sql.query(`create index if not exists imported_evidence_newest_first on ${schema}.imported_evidence (imported_at desc)`);
	await sql.query(`alter table ${schema}.imported_evidence add column if not exists summary jsonb`);
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
	await sql.query(`drop index if exists ${schema}.audit_events_newest_first`);
	await sql.query(`create index if not exists audit_events_by_actor on ${schema}.audit_events (actor, sequence desc)`);
	await sql.query(`create index if not exists audit_events_by_action on ${schema}.audit_events (action, sequence desc)`);
	await sql.query(`create index if not exists audit_events_by_time on ${schema}.audit_events (at)`);
	await sql.query(`create index if not exists audit_events_by_target on ${schema}.audit_events (target_id, sequence desc) where target_id is not null`);
	await sql.query(`create index if not exists audit_events_by_correlation on ${schema}.audit_events (correlation, sequence desc) where correlation is not null`);
	await sql.query(`
    create table if not exists ${schema}.audit_floor (
      id         smallint    primary key,
      sequence   bigint      not null,
      digest     text        not null,
      trimmed_at timestamptz not null,
      trimmed_by text        not null
    )
  `);
	for (const [table, extra] of [["improvement_plans", ""], ["improvement_actions", "plan_id text not null, plan_created_at timestamptz not null,"]]) await sql.query(`
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
	await sql.query(`create index if not exists improvement_plans_newest_first on ${schema}.improvement_plans (created_at desc)`);
	await sql.query(`create index if not exists improvement_actions_by_plan on ${schema}.improvement_actions (plan_id, revision desc)`);
	await sql.query(`create index if not exists improvement_actions_by_control on ${schema}.improvement_actions
       using gin ((body -> 'controlIds') jsonb_path_ops)`);
	await sql.query(`create index if not exists improvement_actions_by_sweep on ${schema}.improvement_actions (plan_created_at asc)`);
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
	await sql.query(`create index if not exists validation_attempts_by_action on ${schema}.validation_attempts (action_id, revision desc)`);
	await sql.query(`create index if not exists validation_attempts_outstanding on ${schema}.validation_attempts (answered, requested_at asc)`);
	await sql.query(`create index if not exists validation_attempts_by_sweep on ${schema}.validation_attempts (plan_created_at asc)`);
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
	await sql.query(`create index if not exists accepted_risks_by_control on ${schema}.accepted_risks (control_id, revision desc)`);
	await sql.query(`create index if not exists accepted_risks_by_expiry on ${schema}.accepted_risks (expires_at asc, revoked)`);
	await sql.query(`create index if not exists accepted_risks_by_owner on ${schema}.accepted_risks (owner)`);
	await sql.query(`create index if not exists accepted_risks_by_sweep on ${schema}.accepted_risks (recorded_at asc)`);
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
	await sql.query(`create index if not exists applicability_by_control on ${schema}.applicability_decisions (control_id, revision desc)`);
	await sql.query(`create index if not exists applicability_by_expiry on ${schema}.applicability_decisions (expires_at asc, revoked)`);
	await sql.query(`create index if not exists applicability_by_owner on ${schema}.applicability_decisions (owner)`);
	await sql.query(`create index if not exists applicability_by_sweep on ${schema}.applicability_decisions (recorded_at asc)`);
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
	await sql.query(`create index if not exists notes_by_subject on ${schema}.notes (subject_kind, subject_id, noted_at asc)`);
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
	await sql.query(`create unique index if not exists serving_declarations_version_scoped
       on ${schema}.serving_declarations (definition_id, version) where definition_id is not null`);
	await sql.query(`create unique index if not exists serving_declarations_version_unscoped
       on ${schema}.serving_declarations (version) where definition_id is null`);
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
	await sql.query(`create unique index if not exists assessment_reviews_of_run on ${schema}.assessment_reviews (run_id)`);
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
	await sql.query(`create unique index if not exists pillar_reviews_at_pillar on ${schema}.pillar_reviews (review_id, pillar_id)`);
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
	await sql.query(`create unique index if not exists review_answers_of_attestation
       on ${schema}.review_answers (attestation_id)`);
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
	await sql.query(`create unique index if not exists assessment_results_of_review on ${schema}.assessment_results (review_id)`);
	await sql.query(`
    create table if not exists ${schema}.retention_periods (
      retention_class text        primary key,
      days            integer     not null,
      set_by          text        not null,
      set_at          timestamptz not null
    )
  `);
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
	await sql.query(`create index if not exists legal_holds_in_force on ${schema}.legal_holds (placed_at desc) where released_at is null`);
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
	await sql.query(`create index if not exists runs_unfinished on ${schema}.runs (requested_at desc) where finished_at is null`);
	await sql.query(`create index if not exists runs_newest_first on ${schema}.runs (requested_at desc)`);
	await sql.query(`
    create table if not exists ${schema}.run_checkpoints (
      run_id     text        not null,
      signal_id  text        not null,
      at         timestamptz not null,
      reading    jsonb       not null,
      primary key (run_id, signal_id)
    )
  `);
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
	for (const table of [
		"scans",
		"attestations",
		"decisions"
	]) await sql.query(`alter table ${schema}.${table} add column if not exists digest text`);
	await sql.query(`alter table ${schema}.runs add column if not exists kind text`);
	await sql.query(`create index if not exists runs_by_kind on ${schema}.runs (kind, requested_at desc)`);
	await sql.query(`alter table ${schema}.runs add column if not exists advisory_id text`);
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
	await sql.query(`create index if not exists advisories_newest_first on ${schema}.advisories (finished_at desc)`);
	await sql.query(`create unique index if not exists advisories_by_run on ${schema}.advisories (run_id)`);
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
	await sql.query(`create index if not exists plan_extracts_by_age on ${schema}.plan_extracts (advisory_at)`);
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
	await sql.query(`alter table ${schema}.month_publications add column if not exists ordinal integer`);
	await sql.query(`create index if not exists month_publications_by_month on ${schema}.month_publications (month, published_at asc)`);
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
async function versionFinalAssessments(sql, schema) {
	for (const [table, columns] of [["assessment_reviews", ["definition_version integer", "definition_fingerprint text"]], ["assessment_results", [
		"schema_version integer",
		"run_id text",
		"definition_version integer",
		"definition_fingerprint text",
		"public_methodology_version integer",
		"catalogue_revision text",
		"eligible boolean"
	]]]) for (const column of columns) await sql.query(`alter table ${schema}.${table} add column if not exists ${column}`);
	await sql.query(`create index if not exists assessment_results_current_final
       on ${schema}.assessment_results (definition_id, finalised_at desc)
       where eligible is true`);
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
async function keyByAssessment(sql, schema) {
	for (const one of RESET_TABLES) {
		if (one.context.kind !== "scoped") continue;
		await sql.query(`alter table ${schema}.${one.table} add column if not exists definition_id text`);
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
async function scopeUniqueness(sql, schema) {
	for (const one of [
		{
			table: "accepted_risks",
			position: "control_id, ordinal, revision"
		},
		{
			table: "applicability_decisions",
			position: "control_id, ordinal, revision"
		},
		{
			table: "month_publications",
			position: "month, ordinal"
		}
	]) {
		await create(`${one.table}_at_position_scoped`, one.table, `definition_id, ${one.position}`, "definition_id is not null");
		await create(`${one.table}_at_position_unscoped`, one.table, one.position, "definition_id is null");
		await sql.query(`drop index if exists ${schema}.${one.table}_at_position`);
	}
	await sql.query(`alter table ${schema}.accepted_risks drop constraint if exists accepted_risks_control_id_ordinal_revision_key`);
	await sql.query(`alter table ${schema}.applicability_decisions drop constraint if exists applicability_decisions_control_id_ordinal_revision_key`);
	async function create(index, table, columns, when) {
		try {
			await sql.query(`create unique index if not exists ${index}
           on ${schema}.${table} (${columns}) where ${when}`);
		} catch (cause) {
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
async function duplicateReport(sql, schema, table, columns, when, cause) {
	const said = cause instanceof Error ? cause.message : String(cause);
	const head = `${schema}.${table} cannot take the unique index on (${columns}) where ${when}, which ADR 0054 requires, because it already holds rows the index would forbid. They were written while a build was running without it: 42c added the assessment to the constraint in a way that left rows with no assessment unconstrained, and every row on an install with no assessment defined is one of those. Postgres said: ` + said;
	try {
		const { rows } = await sql.query(`select ${columns}, count(*) as copies from ${schema}.${table}
         where ${when} group by ${columns} having count(*) > 1 order by copies desc limit 10`);
		if (rows.length === 0) return head;
		return `${head}\n\nThe keys with more than one row, worst first (up to ten):\n  ${rows.map((row) => Object.entries(row).map(([column, value]) => `${column}=${shown(value)}`).join(" ")).join("\n  ")}\n\nEach is two records that both claim to be the same position. Decide which one stands — they have different owners and expiry dates — revoke the other through the app if it is still reachable, or delete the losing row, and restart. Nothing here chooses for you.`;
	} catch {
		return head;
	}
	function shown(value) {
		if (value == null) return "null";
		if (typeof value === "string") return value;
		if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return value.toString();
		if (value instanceof Date) return value.toISOString();
		return JSON.stringify(value) ?? "unprintable";
	}
}
//#endregion
export { ENDPOINT_ENV, SCHEMA_ENV, ensureSchema, openPostgres, schemaName };
