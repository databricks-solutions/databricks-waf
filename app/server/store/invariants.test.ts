import { describe, expect, it } from 'vitest';
import { FakePostgres } from './postgres-fake.js';
import { applyInvariants, INVARIANTS } from './invariants.js';
import { ensureSchema } from './postgres.js';

const EXPECTED_INVARIANTS = [
  'run_attempts_one_number',
  'run_attempts_run_fk',
  'run_checkpoints_run_fk',
  'advisories_run_fk',
  'definition_versions_definition_fk',
  'pillar_reviews_review_fk',
  'review_answers_review_fk',
  'assessment_results_review_fk',
  'assessment_results_run_fk',
  'assessment_results_definition_version_fk',
  'run_attempts_number_positive',
  'definition_versions_version_positive',
  'assessment_results_schema_version_positive',
  'assessment_results_eligible_complete',
].sort();

describe('INVARIANTS', () => {
  it('keeps the reviewed constraint set explicit and unique', () => {
    const named = INVARIANTS.map((one) => one.name).sort();
    expect(named).toEqual(EXPECTED_INVARIANTS);
    expect(new Set(named).size).toBe(named.length);
  });

  it('adds foreign keys restrict and not valid, so a populated install still boots', () => {
    const foreign = INVARIANTS.filter((one) => one.name.endsWith('_fk'));
    expect(foreign.length).toBeGreaterThan(0);
    for (const one of foreign) {
      const sql = one.sql('waf');
      expect(sql).toContain('on delete restrict');
      expect(sql).toContain('not valid');
    }
  });

  it('makes (run_id, number) unique', () => {
    const unique = INVARIANTS.find((one) => one.name === 'run_attempts_one_number');
    expect(unique?.sql('waf')).toContain('(run_id, number)');
  });
});

describe('applyInvariants', () => {
  it('is reached from ensureSchema, and the fake accepts the statements', async () => {
    const fake = new FakePostgres();
    await ensureSchema(fake, fake.schema);
    await applyInvariants(fake, fake.schema);

    expect(fake.statements.some((sql) => sql.includes('run_attempts_one_number'))).toBe(true);
    expect(fake.statements.some((sql) => sql.includes('run_attempts_run_fk'))).toBe(true);
    expect(fake.statements.some((sql) => sql.includes('on delete restrict'))).toBe(true);
  });
});
