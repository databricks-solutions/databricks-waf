// The constraints ADR 0100 adds. Called from `ensureSchema` on every boot.
//
// `NOT VALID` is the boot path the row asked for: a populated install is not re-judged, and a
// row already there that the new rule would refuse does not fail the process that only started
// up. New writes are checked. `ON DELETE RESTRICT` is the only deletion action; cascade is
// declined in the ADR.

interface Sql {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

export interface Invariant {
  readonly name: string;
  readonly sql: (schema: string) => string;
}

export const INVARIANTS: readonly Invariant[] = [
  {
    name: 'run_attempts_one_number',
    sql: (schema) =>
      `create unique index if not exists run_attempts_one_number on ${schema}.run_attempts (run_id, number)`,
  },
  {
    name: 'run_attempts_run_fk',
    sql: (schema) => addForeignKey(schema, 'run_attempts', 'run_attempts_run_fk', 'run_id', 'runs', 'id'),
  },
  {
    name: 'run_checkpoints_run_fk',
    sql: (schema) => addForeignKey(schema, 'run_checkpoints', 'run_checkpoints_run_fk', 'run_id', 'runs', 'id'),
  },
  {
    name: 'advisories_run_fk',
    sql: (schema) => addForeignKey(schema, 'advisories', 'advisories_run_fk', 'run_id', 'runs', 'id'),
  },
  {
    name: 'definition_versions_definition_fk',
    sql: (schema) =>
      addForeignKey(
        schema,
        'assessment_definition_versions',
        'definition_versions_definition_fk',
        'definition_id',
        'assessment_definitions',
        'id'
      ),
  },
  {
    name: 'pillar_reviews_review_fk',
    sql: (schema) =>
      addForeignKey(schema, 'pillar_reviews', 'pillar_reviews_review_fk', 'review_id', 'assessment_reviews', 'id'),
  },
  {
    name: 'review_answers_review_fk',
    sql: (schema) =>
      addForeignKey(schema, 'review_answers', 'review_answers_review_fk', 'review_id', 'assessment_reviews', 'id'),
  },
  {
    name: 'assessment_results_review_fk',
    sql: (schema) =>
      addForeignKey(
        schema,
        'assessment_results',
        'assessment_results_review_fk',
        'review_id',
        'assessment_reviews',
        'id'
      ),
  },
  {
    name: 'assessment_results_run_fk',
    sql: (schema) => addForeignKey(schema, 'assessment_results', 'assessment_results_run_fk', 'run_id', 'scans', 'id'),
  },
  {
    name: 'assessment_results_definition_version_fk',
    sql: (schema) =>
      addCompositeForeignKey(
        schema,
        'assessment_results',
        'assessment_results_definition_version_fk',
        ['definition_id', 'definition_version'],
        'assessment_definition_versions',
        ['definition_id', 'version']
      ),
  },
  {
    name: 'run_attempts_number_positive',
    sql: (schema) => addCheck(schema, 'run_attempts', 'run_attempts_number_positive', 'number >= 1'),
  },
  {
    name: 'definition_versions_version_positive',
    sql: (schema) =>
      addCheck(schema, 'assessment_definition_versions', 'definition_versions_version_positive', 'version >= 1'),
  },
  {
    name: 'assessment_results_schema_version_positive',
    sql: (schema) =>
      addCheck(
        schema,
        'assessment_results',
        'assessment_results_schema_version_positive',
        'schema_version is null or schema_version >= 1'
      ),
  },
  {
    name: 'assessment_results_eligible_complete',
    sql: (schema) =>
      addCheck(
        schema,
        'assessment_results',
        'assessment_results_eligible_complete',
        'eligible is not true or (schema_version = 2 and run_id is not null and definition_id is not null and definition_version is not null and definition_fingerprint is not null and public_methodology_version is not null and catalogue_revision is not null)'
      ),
  },
];

export async function applyInvariants(sql: Sql, schema: string): Promise<void> {
  for (const invariant of INVARIANTS) {
    await sql.query(invariant.sql(schema));
  }
}

function addForeignKey(
  schema: string,
  table: string,
  name: string,
  column: string,
  parent: string,
  parentColumn: string
): string {
  return addConstraint(
    schema,
    table,
    name,
    `foreign key (${column}) references ${schema}.${parent} (${parentColumn}) on delete restrict not valid`
  );
}

function addCompositeForeignKey(
  schema: string,
  table: string,
  name: string,
  columns: readonly string[],
  parent: string,
  parentColumns: readonly string[]
): string {
  return addConstraint(
    schema,
    table,
    name,
    `foreign key (${columns.join(', ')}) references ${schema}.${parent} (${parentColumns.join(', ')}) on delete restrict not valid`
  );
}

function addCheck(schema: string, table: string, name: string, expression: string): string {
  return addConstraint(schema, table, name, `check (${expression}) not valid`);
}

function addConstraint(schema: string, table: string, name: string, body: string): string {
  return `
    do $invariant$
    begin
      if not exists (
        select 1
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
          join pg_namespace n on n.oid = t.relnamespace
         where n.nspname = '${schema}'
           and c.conname = '${name}'
      ) then
        alter table ${schema}.${table} add constraint ${name} ${body};
      end if;
    end
    $invariant$;
  `;
}
