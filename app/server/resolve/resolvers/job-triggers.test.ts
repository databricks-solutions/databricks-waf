// Two job-trigger measures, and the two ways a trigger column could have become a wrong answer.
//
// Both of these were questions until the jobs inventory was checked for the field each one asks
// about, and both fields answer something narrower than the control's whole population. What these
// tests defend is that narrowness:
//
// `trigger_type` says how a job starts, not what it does. An estate of nothing but cron jobs is
// therefore not an estate that polls for files — it may run no file ingestion at all — so the
// absence of a file-arrival trigger has to read as unmeasured rather than as a failure. Reading it
// as a share would report the app's inability to tell which jobs touch files as a defect in the
// customer's practice.
//
// `health_rules` is unwritten on job definitions not edited since early December 2025, so a job
// predating that column is not a job that was checked for a backlog rule and found not to have one.
// Those jobs stay out of the ratio in both directions.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { COMPLETE, observed, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { JobRow } from '../../collect/sql/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const JOBS = 'sql:jobs.inventory' as SignalId;

const catalogue = loadCatalogue();
const registry = buildRegistry();

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    workspaceId: '1',
    jobId: 'j-1',
    name: 'nightly-load',
    scheduled: true,
    scheduledKnown: true,
    healthRuleCount: 0,
    healthRulesKnown: true,
    hasStreamBacklogRule: false,
    tagCount: 1,
    ...overrides,
  };
}

function findingFor(controlId: string, jobs: readonly JobRow[]) {
  const spec = catalogue.controls.find((control) => control.id === controlId);
  if (spec == null) throw new Error(`${controlId} is not in the catalogue`);
  const signals = new Map<SignalId, SignalResult>([[JOBS, observed(JOBS, jobs, jobs.length, COMPLETE)]]);
  return resolveControl(spec, signals, registry.get(controlId));
}

describe('OE-02-05, reacting to file arrival rather than polling for one', () => {
  it('passes on a file-arrival trigger existing anywhere in the estate', () => {
    const finding = findingFor('OE-02-05', [
      job({ jobId: 'j-1', triggerType: 'FILE_ARRIVAL' }),
      job({ jobId: 'j-2', triggerType: 'CRON' }),
    ]);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('1 job triggered by file arrival');
  });

  it('reports unmeasurable rather than a failure over an estate of scheduled jobs', () => {
    // The reading the field cannot support. A cron job may be polling a landing path, or it may be
    // rebuilding an aggregate with no file anywhere in it, and `trigger_type` does not distinguish
    // them — so a fail here would be scoring the app's own blind spot.
    const finding = findingFor('OE-02-05', [
      job({ jobId: 'j-1', triggerType: 'CRON' }),
      job({ jobId: 'j-2', triggerType: 'PERIODIC' }),
    ]);

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toMatch(/not what the job does once it runs/);
  });

  it('excludes an estate whose jobs are on neither a schedule nor a file trigger', () => {
    const finding = findingFor('OE-02-05', [
      job({ jobId: 'j-1', continuous: true }),
      job({ jobId: 'j-2', triggerType: 'TABLE_UPDATE' }),
    ]);

    expect(finding.outcome).toBe('not-applicable');
  });

  it('does not exclude an estate whose trigger columns were never written', () => {
    // The defect this replaced: an unreadable `trigger_type` fell into neither bucket, so an estate
    // of definitions not edited since early December 2025 was reported as a control that does not
    // apply. That excluded the requirement from scoring for a system-table rollout date.
    const finding = findingFor('OE-02-05', [
      job({ jobId: 'j-1', scheduledKnown: false }),
      job({ jobId: 'j-2', scheduledKnown: false }),
    ]);

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toMatch(/unknown rather than absent/);
  });

  it('names the unreadable definitions beside a pass rather than hiding them', () => {
    const finding = findingFor('OE-02-05', [
      job({ jobId: 'j-1', triggerType: 'FILE_ARRIVAL' }),
      job({ jobId: 'j-2', scheduledKnown: false }),
    ]);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('1 job has no trigger this reading can name');
  });

  it('agrees the verb with the count it prints', () => {
    // This assertion previously encoded "1 job have", because the noun was pluralised and the verb
    // was not. A count and its verb are one decision, and a test that copies the output rather than
    // reading it will pin whichever the code happened to produce.
    const one = findingFor('OE-02-05', [
      job({ jobId: 'j-1', triggerType: 'FILE_ARRIVAL' }),
      job({ jobId: 'j-2', scheduledKnown: false }),
    ]);
    const several = findingFor('OE-02-05', [
      job({ jobId: 'j-1', triggerType: 'FILE_ARRIVAL' }),
      job({ jobId: 'j-2', scheduledKnown: false }),
      job({ jobId: 'j-3', scheduledKnown: false }),
    ]);

    expect(one.evidence[0]?.observed).toContain('1 job has');
    expect(one.evidence[0]?.observed).not.toContain('job have');
    expect(several.evidence[0]?.observed).toContain('2 jobs have');
  });

  it('counts unreadable definitions beside a polling estate too', () => {
    const finding = findingFor('OE-02-05', [
      job({ jobId: 'j-1', triggerType: 'CRON' }),
      job({ jobId: 'j-2', scheduledKnown: false }),
    ]);

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toMatch(/A further 1 job has no trigger this reading can name/);
  });

  /*
   * A job with two or more triggers. The platform sets `trigger_type` to `MULTIPLE` and leaves `trigger`
   * null, keeping the set in a `triggers` array `jobs_inventory.sql` does not project — and one of those
   * triggers may be the file arrival this control is looking for. The row is fully written, so a
   * predicate asking only whether the columns were populated called it readable and it fell through to
   * "none is triggered by file arrival": a definite claim about a field that says "read the other
   * column". https://docs.databricks.com/aws/en/admin/system-tables/jobs
   */
  it('does not claim a job with several triggers has no file-arrival trigger', () => {
    const finding = findingFor('OE-02-05', [job({ jobId: 'j-1', triggerType: 'MULTIPLE', scheduledKnown: false })]);

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toMatch(/records more than one/);
  });
});

describe('PE-05-03, streaming backlog alerting', () => {
  const continuous = (overrides: Partial<JobRow> = {}) => job({ continuous: true, ...overrides });

  it('passes when every continuous job carries a backlog rule', () => {
    const finding = findingFor('PE-05-03', [
      continuous({ jobId: 'j-1', healthRuleCount: 1, hasStreamBacklogRule: true }),
      continuous({ jobId: 'j-2', healthRuleCount: 2, hasStreamBacklogRule: true }),
    ]);

    expect(finding.outcome).toBe('pass');
  });

  it('does not count a duration or failure rule as watching backlog', () => {
    // A job with health rules is not thereby a job watching lag. `RUN_DURATION_SECONDS` fires after
    // a run is already long; a backlog metric is what says lag is growing before a deadline is missed.
    const finding = findingFor('PE-05-03', [
      continuous({ jobId: 'j-1', healthRuleCount: 1, hasStreamBacklogRule: false }),
      continuous({ jobId: 'j-2', healthRuleCount: 1, hasStreamBacklogRule: false }),
    ]);

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.observed).toContain('0 of 2 continuous jobs');
  });

  it('leaves jobs whose health rules were never written out of the share, in both directions', () => {
    // Two jobs, one monitored and one predating the column. The share is 1 of 1 rather than 1 of 2:
    // the unwritten job is not evidence of a missing rule, so it neither passes nor fails the estate.
    const finding = findingFor('PE-05-03', [
      continuous({ jobId: 'j-1', healthRuleCount: 1, hasStreamBacklogRule: true }),
      continuous({ jobId: 'j-2', healthRulesKnown: false }),
    ]);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('1 of 1 continuous jobs');
    expect(finding.evidence[0]?.observed).toContain('1 more have no readable health-rules list');
  });

  it('reports unmeasurable when no continuous job has a readable health-rules list', () => {
    const finding = findingFor('PE-05-03', [
      continuous({ jobId: 'j-1', healthRulesKnown: false }),
      continuous({ jobId: 'j-2', healthRulesKnown: false }),
    ]);

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toMatch(/unknown rather than absent/);
  });

  it('excludes an estate that runs no continuous job at all', () => {
    const finding = findingFor('PE-05-03', [job({ jobId: 'j-1', triggerType: 'CRON' })]);

    expect(finding.outcome).toBe('not-applicable');
  });

  it('does not claim there is no streaming workload when the trigger struct was never written', () => {
    // `continuous` comes from the same struct `scheduledKnown` reports on, so an absent flag is an
    // unread job rather than a batch one. 36b added that field for this; the first form of this
    // resolver ignored it and told the reader there was nothing here to watch.
    const finding = findingFor('PE-05-03', [
      job({ jobId: 'j-1', scheduledKnown: false }),
      job({ jobId: 'j-2', scheduledKnown: false }),
    ]);

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toMatch(/unknown rather than settled/);
  });

  it('says why an estate with no jobs is excluded, rather than describing jobs it does not have', () => {
    // Both resolvers describe the population they counted, and none of those sentences is true of an
    // empty one: "every job here has a readable trigger" reads as a finding about jobs that exist.
    for (const controlId of ['OE-02-05', 'PE-05-03']) {
      const finding = findingFor(controlId, []);
      expect(finding.outcome).toBe('not-applicable');
      expect(finding.outcomeReason).toMatch(/no job definitions/);
    }
  });

  it('reads only the jobs inventory for both controls', () => {
    expect(registry.get('OE-02-05')?.requires).toEqual([JOBS]);
    expect(registry.get('PE-05-03')?.requires).toEqual([JOBS]);
  });
});
