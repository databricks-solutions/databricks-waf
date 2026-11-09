import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_HEADERS, serveComputePolicyApp, type PolicyEstate } from './fixtures/compute-policy-app.js';
import type { CurrentResultPayload, ScanPayload } from '../shared/api/contract.js';

// Over real local HTTP, including raw string SQL rows, collection, scoring, storage and serialization.
// Databricks is the synthetic boundary; no customer workspace or policies change during this suite.
describe('compute-policy scan end to end', () => {
  let fixture: Awaited<ReturnType<typeof serveComputePolicyApp>>;
  beforeAll(async () => {
    fixture = await serveComputePolicyApp();
  });
  afterAll(async () => {
    await fixture?.close();
  });

  it.each<[string, PolicyEstate, string]>([
    ['job-only without policies', { clusters: [{ id: 'nightly-etl', source: 'JOB', policy: false }] }, 'fail'],
    ['job-only with policies', { clusters: [{ id: 'nightly-etl', source: 'JOB', policy: true }] }, 'pass'],
    [
      'mixed groups with an ungoverned job',
      {
        clusters: [
          { id: 'interactive', source: 'UI', policy: true },
          { id: 'nightly-etl', source: 'JOB', policy: false },
        ],
      },
      'fail',
    ],
    [
      'pipeline excluded from adoption',
      {
        clusters: [
          { id: 'nightly-etl', source: 'JOB', policy: true },
          { id: 'pipeline', source: 'PIPELINE', policy: false },
        ],
      },
      'pass',
    ],
    ['no classic clusters in the inventory', { clusters: [] }, 'not-applicable'],
    [
      'unreadable cluster inventory',
      { clusters: [{ id: 'nightly-etl', source: 'JOB', policy: true }], unreadable: true },
      'unmeasurable',
    ],
  ])('%s', async (_name, estate, outcome) => {
    const scan = await fixture.scan(estate);
    for (const id of ['OE-02-02', 'IU-03-03']) {
      const finding = scan.findings.find((entry) => entry.controlId === id);
      expect(finding?.outcome).toBe(outcome);
    }
    const response = await fetch(`${fixture.origin}/api/scans/${scan.id}${fixture.scopeQuery}`);
    expect(response.status).toBe(200);
    const reloaded = (await response.json()) as ScanPayload;
    expect(reloaded.findings).toEqual(scan.findings);
    expect(fixture.statements).toContain('sql:compute.clusters');
    expect(fixture.statements).not.toContain('sql:estate.compute_profile');
  });

  it('publishes the measured policy finding without allowing a skipped practice to override it', async () => {
    const scan = await fixture.scan({ clusters: [{ id: 'nightly-etl', source: 'JOB', policy: false }] });
    const review = await fixture.publish(scan);
    expect(
      review.result?.finalAssessment?.outcome.findings.find((entry) => entry.finding.controlId === 'OE-02-02')?.finding
        .outcome
    ).toBe('fail');
    const response = await fetch(`${fixture.origin}/api/results/current${fixture.scopeQuery}`, {
      headers: FIXTURE_HEADERS,
    });
    expect(response.status).toBe(200);
    const current = (await response.json()) as CurrentResultPayload;
    expect(current.eligibility.eligible).toBe(true);
  });

  it('preserves the failed historical scan after a policy remediation', async () => {
    const before = await fixture.scan({ clusters: [{ id: 'nightly-etl', source: 'JOB', policy: false }] });
    const after = await fixture.scan({ clusters: [{ id: 'nightly-etl', source: 'JOB', policy: true }] });
    expect(after.id).not.toBe(before.id);
    const stored = (await fetch(`${fixture.origin}/api/scans/${before.id}${fixture.scopeQuery}`).then((response) =>
      response.json()
    )) as ScanPayload;
    expect(stored.findings.find((finding) => finding.controlId === 'OE-02-02')?.outcome).toBe('fail');
    expect(after.findings.find((finding) => finding.controlId === 'OE-02-02')?.outcome).toBe('pass');
    expect(after.score).not.toEqual(before.score);
  });
});
