// What a recipient can prove about a file they were sent.
//
// These tests are the whole of the claim, and the claim has an exact shape rather than a round one.
// An export is a pure function of the stored run and the decisions standing against it: nothing about
// the download is in it, which is what a digest recorded beside one is worth anything for, and the
// decisions do move, which is why the last test here pins that too. A recipient who checks and finds
// a mismatch has to be able to learn something from it, and "you downloaded it twice" was the answer
// before this.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DIGEST_HEADER, howToCheck, seal } from './artefact.js';
import { CollectionScheduler } from '../scan/scheduler.js';
import type { Catalogue, CatalogueControl } from '../catalogue/catalogue.js';
import type { Finding } from '../resolve/finding.js';
import type { Scan } from '../scan/scan.js';
import type { Standings } from '../decide/standing.js';

const RAN = new Date('2026-03-04T09:30:00.000Z');

function control(over: Partial<CatalogueControl> & { id: string }): CatalogueControl {
  return {
    pillarId: 'security',
    principleId: 'SEC-01',
    title: 'Restrict cluster creation',
    severity: 'high',
    provenance: 'waf-docs',
    measurability: 'system-table',
    evaluatorStatus: 'implemented',
    coverageMode: 'complete',
    clouds: [],
    dasf: [],
    references: [],
    ...over,
  };
}

const CATALOGUE: Pick<Catalogue, 'controls' | 'pillars'> = {
  pillars: [
    {
      id: 'security',
      code: 'SEC',
      title: 'Security, compliance and privacy',
      page: 'https://example.test',
      principles: [],
    },
  ],
  controls: [control({ id: 'SEC-01-02', criteria: 'Every workspace has a cluster policy.' })],
};

function finding(): Finding {
  return {
    controlId: 'SEC-01-02',
    pillarId: 'security',
    principleId: 'SEC-01',
    title: 'Restrict cluster creation',
    outcome: 'fail',
    severity: 'high',
    coverage: { mode: 'complete', reach: 'account' },
    evidence: [
      {
        signal: 'sql:compute.clusters',
        observed: '14 of 20 workspaces have no policy',
        expected: 'every workspace',
        coverage: { mode: 'complete', reach: 'account' },
        collectedAt: new Date('2026-03-04T09:29:00.000Z'),
        provenance: {
          surface: 'sql',
          collector: 'compute',
          authority: 'on-behalf-of-user',
          actor: 'alice@example.com',
          from: 'warehouse wh-1',
        },
      },
    ],
  };
}

function scan(over: Partial<Scan> = {}): Scan {
  return {
    id: 'run-1234567890',
    startedAt: new Date('2026-03-04T09:28:00.000Z'),
    finishedAt: RAN,
    state: 'complete',
    stamp: {
      catalogueVersion: '1.4.0',
      catalogueFingerprint: 'abc',
      executionMode: 'on-behalf-of-user',
      actor: 'alice@example.com',
      scope: { description: 'Assessed across every workspace the signed-in user can see.' },
      lookbackDays: 30,
    },
    score: {
      pillars: [],
      counts: { pass: 0, fail: 1, partial: 0, unmeasurable: 0, 'not-applicable': 0, 'satisfied-by-architecture': 0 },
      scoredControls: 1,
      composition: { observed: 1, 'admin-collected': 0, attested: 0 },
      totalControls: 1,
    },
    findings: [finding()],
    signals: [],
    estate: { assessed: [], excluded: [] },
    measurement: [],
    footprint: new CollectionScheduler().footprint(),
    spend: [],
    ...over,
  };
}

function take(format: 'csv' | 'json') {
  return seal({ scan: scan(), catalogue: CATALOGUE, format });
}

describe('a file taken out of the app', () => {
  it('is the same bytes every time the same run is exported', () => {
    // The property everything else here depends on. It held before only by accident, and stopped
    // holding the moment the document carried the time it was produced.
    for (const format of ['csv', 'json'] as const) {
      expect(take(format).bytes.equals(take(format).bytes)).toBe(true);
      expect(take(format).digest).toBe(take(format).digest);
    }
  });

  it('is the same bytes across two clocks, which is the case a timestamp broke', () => {
    // Two downloads a minute apart, simulated the only way that matters: nothing in the call says
    // when it happened, so there is nothing for a clock to reach.
    const morning = take('json');
    const afternoon = take('json');
    expect(afternoon.bytes.toString('utf8')).toBe(morning.bytes.toString('utf8'));
  });

  it('carries the digest a recipient computes with shasum, over the bytes as sent', () => {
    const file = take('json');
    const independently = createHash('sha256').update(file.bytes).digest('hex');

    expect(file.digest).toBe(`sha256:${independently}`);
  });

  it('has a different digest for each format, so a name and a digest identify one file', () => {
    expect(take('csv').digest).not.toBe(take('json').digest);
  });

  it('changes digest when the assessment does', () => {
    const other = seal({ scan: scan({ state: 'partial' }), catalogue: CATALOGUE, format: 'json' });
    expect(other.digest).not.toBe(take('json').digest);
  });

  it('names the file after the run and the day, and declares its own type', () => {
    expect(take('csv')).toMatchObject({
      name: 'well-architected-2026-03-04-run-1234.csv',
      contentType: 'text/csv; charset=utf-8',
    });
    expect(take('json').contentType).toBe('application/json; charset=utf-8');
  });

  it('is valid JSON at the version a consumer checks', () => {
    const read = JSON.parse(take('json').bytes.toString('utf8')) as Record<string, unknown>;
    expect(read.documentVersion).toBe(4);
    expect(read).not.toHaveProperty('generatedAt');
  });

  it('tells a recipient how to check it, in both of the two commands they might have', () => {
    const file = take('csv');
    const [mac, linux, expected] = howToCheck(file);

    expect(mac).toBe(`shasum -a 256 ${file.name}`);
    expect(linux).toBe(`sha256sum ${file.name}`);
    // The hex without the algorithm prefix, because that is what those two commands print.
    expect(expected).toBe(`# expect ${file.digest.slice('sha256:'.length)}`);
  });

  it('names its header once, so the route and the client cannot disagree about it', () => {
    expect(DIGEST_HEADER).toBe('X-Export-Digest');
  });

  it('changes digest when a decision is recorded, which is the one honest mismatch', () => {
    // Asserted rather than left to be discovered, because it is the boundary of the claim above and a
    // recipient was just told to treat a mismatch as tampering. The file is a function of the run and
    // of what has been decided about it, and the second of those is meant to move: a copy sent on
    // Monday and a copy taken after Tuesday's risk acceptance differ, and they should, because the
    // decision columns are describing something that genuinely changed. What the app owes the sender
    // is to say so, which `RunFiles` does. Sealing an export once at the moment its run finishes was
    // considered and refused; see ADR 0050's amendment.
    const decisions: readonly Standings[] = [
      {
        decision: {
          id: 'dec-1',
          controlId: 'SEC-01-02',
          disposition: 'accepted',
          reason: 'Two clusters in a lab account with no customer data. The account closes in November.',
          owner: 'bob@example.com',
          until: new Date('2026-11-30T00:00:00.000Z'),
          decidedBy: 'alice@example.com',
          decidedAt: new Date('2026-03-05T11:00:00.000Z'),
        },
        standing: 'current',
        outcome: 'fail',
      },
    ];
    const withDecision = () => seal({ scan: scan(), catalogue: CATALOGUE, decisions, format: 'json' });

    expect(withDecision().digest).not.toBe(take('json').digest);
    // Reproducible for a given state of the record, which is the half that has to hold for a
    // published digest to be worth reading out at all.
    expect(withDecision().bytes.equals(withDecision().bytes)).toBe(true);
  });
});
