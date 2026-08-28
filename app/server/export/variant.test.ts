// The four files, tested for the two things that make them safe to hand over.
//
// A variant is allowed to be shorter. It is not allowed to be quieter: whatever it drops, it still
// carries every requirement the run considered, it still says which of the four it is, and it still
// says where the whole of it is. Most of what is below is those three claims, one per variant,
// because the failure they guard against is a reader concluding from a fifteen-column file that the
// app never recorded the sixteenth thing.

import { describe, expect, it } from 'vitest';
import { assessmentDocument, assessmentRows } from './document.js';
import { seal } from './artefact.js';
import { EXPORT_VARIANTS, variantOf, VARIANT_SHAPES, type ExportVariant } from './variant.js';
import { CollectionScheduler } from '../scan/scheduler.js';
import type { Catalogue, CatalogueControl } from '../catalogue/catalogue.js';
import type { Finding } from '../resolve/finding.js';
import type { Scan } from '../scan/scan.js';

const RAN = new Date('2026-03-04T09:30:00.000Z');
const READ = new Date('2026-03-04T09:29:00.000Z');

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
    { id: 'security', code: 'SEC', title: 'Security, compliance and privacy', page: 'https://example.test', principles: [] },
  ],
  controls: [
    control({
      id: 'SEC-01-02',
      criteria: 'Every workspace has a cluster policy bound to non-admin users.',
      rationale: 'Unbounded cluster creation is the most common source of unplanned spend.',
      remediation: { summary: 'Bind the shared compute policy to all users.', docUrl: 'https://example.test/policies' },
    }),
    control({ id: 'SEC-02-01', principleId: 'SEC-02', title: 'Review access quarterly' }),
  ],
};

function finding(over: Partial<Finding> = {}): Finding {
  return {
    controlId: 'SEC-01-02',
    pillarId: 'security',
    principleId: 'SEC-01',
    title: 'Restrict cluster creation',
    outcome: 'fail',
    severity: 'high',
    outcomeReason: '14 of 20 workspaces have no policy bound.',
    coverage: { mode: 'complete', reach: 'account' },
    evidence: [
      {
        signal: 'sql:compute.clusters',
        observed: '14 of 20 workspaces have no policy',
        expected: 'every workspace',
        coverage: { mode: 'complete', reach: 'account' },
        collectedAt: READ,
        provenance: {
          surface: 'sql',
          collector: 'compute',
          authority: 'on-behalf-of-user',
          actor: 'alice@example.com',
          from: 'warehouse wh-1',
        },
      },
    ],
    ...over,
  };
}

/** Two findings and one that passed, so a variant that filtered rows would be visible as a count. */
const FINDINGS: readonly Finding[] = [
  finding(),
  finding({ controlId: 'SEC-02-01', principleId: 'SEC-02', title: 'Review access quarterly', outcome: 'pass' }),
];

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
      identity: {
        build: { id: '0.1.0+sha256:beef' },
        methodology: { id: 'sha256:cafe' },
        record: { id: 'codec-3' },
        sources: ['sql', 'rest'],
      },
      definition: { id: 'def-1', version: 2, fingerprint: 'sha256:feed' },
    },
    score: {
      pillars: [],
      counts: { pass: 1, fail: 1, partial: 0, unmeasurable: 0, 'not-applicable': 0, 'satisfied-by-architecture': 0 },
      scoredControls: 2,
      composition: { observed: 2, 'admin-collected': 0, attested: 0 },
      totalControls: 2,
    },
    findings: [...FINDINGS],
    signals: [],
    estate: { assessed: [], excluded: [] },
    measurement: [],
    footprint: new CollectionScheduler().footprint(),
    spend: [],
    ...over,
  };
}

function rows(variant: ExportVariant): { header: readonly string[]; body: readonly (readonly string[])[] } {
  const all = assessmentRows({ scan: scan(), catalogue: CATALOGUE, variant });
  return { header: all[0], body: all.slice(1) };
}

function document(variant: ExportVariant): Record<string, unknown> {
  return assessmentDocument({ scan: scan(), catalogue: CATALOGUE, variant });
}

describe('what every variant has to do', () => {
  it.each(EXPORT_VARIANTS)('carries a row for every requirement in %s, including the ones that passed', (variant) => {
    // The rule the whole design rests on. A file that leaves out the passes cannot be told apart
    // from a file that leaves out the inconvenient ones, and the reader has no way to know which
    // they hold.
    const { header, body } = rows(variant);
    expect(body.map((row) => row[header.indexOf('requirement')])).toEqual(['SEC-01-02', 'SEC-02-01']);
  });

  it.each(EXPORT_VARIANTS)('names itself on every row of %s, so a subset cannot be read as the whole', (variant) => {
    const { header, body } = rows(variant);
    expect(body.map((row) => row[header.indexOf('variant')])).toEqual([variant, variant]);
  });

  it.each(EXPORT_VARIANTS)('says in the %s document who it is for', (variant) => {
    const file = document(variant);
    expect(file.variant).toBe(variant);
    expect(file.variantMeans).toBe(VARIANT_SHAPES[variant].says);
  });

  it.each(EXPORT_VARIANTS)('says what %s leaves out, or nothing when it leaves nothing out', (variant) => {
    const file = document(variant);
    const omits = VARIANT_SHAPES[variant].omits;
    if (omits == null) {
      expect(file).not.toHaveProperty('variantOmits');
    } else {
      // Names the complete file, so a recipient who needs a missing column knows what to ask for
      // rather than concluding the app does not record it.
      expect(file.variantOmits).toContain('technical');
    }
  });

  it.each(EXPORT_VARIANTS)('states the verdict, the severity and the coverage in %s', (variant) => {
    // Three columns no audience is spared. Without coverage a `pass` reads as "this is fine" where
    // the truth may be "fine in the two hundred tables we sampled out of forty thousand".
    const { header } = rows(variant);
    for (const column of ['outcome', 'severity', 'coverage', 'requirement', 'run']) {
      expect(header).toContain(column);
    }
  });
});

describe('the executive file', () => {
  it('leaves the readings out and keeps the reason, so it says what is wrong without the estate detail', () => {
    const { header } = rows('executive');
    expect(header).not.toContain('observed');
    expect(header).not.toContain('read_as');
    expect(header).toContain('reason');
    expect(header).toContain('next_step');
  });

  it('carries no evidence array and no judging criteria in the structured form', () => {
    const first = (document('executive').findings as Record<string, unknown>[])[0];
    expect(first).not.toHaveProperty('evidence');
    expect(first).not.toHaveProperty('judgedBy');
    // What it does keep: the verdict, why, and what closes it.
    expect(first.outcome).toBe('fail');
    expect(first.reason).toBe('14 of 20 workspaces have no policy bound.');
    expect(first).toHaveProperty('remediation');
  });
});

describe('the improvement file', () => {
  it('carries what an owner needs and not who took the reading', () => {
    const { header } = rows('improvement');
    expect(header).toContain('observed');
    expect(header).toContain('next_step');
    expect(header).toContain('where');
    expect(header).toContain('decision_owner');
    expect(header).not.toContain('read_as');
  });

  it('keeps the observation and drops the provenance of it', () => {
    const first = (document('improvement').findings as Record<string, unknown>[])[0];
    const evidence = (first.evidence as Record<string, unknown>[])[0];
    expect(evidence.observed).toBe('14 of 20 workspaces have no policy');
    expect(evidence).not.toHaveProperty('readBy');
  });
});

describe('the audit package', () => {
  it('says what produced the run, which no other variant carries', () => {
    const run = document('audit').run as Record<string, unknown>;
    const produced = run.producedBy as Record<string, unknown>;
    expect(produced.build).toEqual({ id: '0.1.0+sha256:beef' });
    expect(produced.scoringMethod).toEqual({ id: 'sha256:cafe' });
    expect(produced.sources).toEqual(['sql', 'rest']);
    expect(produced.assessment).toEqual({ id: 'def-1', version: 2, fingerprint: 'sha256:feed' });

    for (const other of ['executive', 'technical', 'improvement'] as const) {
      expect(document(other).run).not.toHaveProperty('producedBy');
    }
  });

  it('carries the axes and the review date as columns as well', () => {
    const { header, body } = rows('audit');
    expect(body[0][header.indexOf('app_build')]).toBe('0.1.0+sha256:beef');
    expect(body[0][header.indexOf('scoring_method')]).toBe('sha256:cafe');
    expect(header).toContain('answer_review_by');
    expect(header).toContain('decision_id');
    // The join key the audit sentence promises for the other kind of decision. Both, or the sentence
    // is the one that was wrong: it said "the identifier of every decision" and carried one family's.
    expect(header).toContain('applicability_id');
  });

  it('is the only variant carrying either decision identifier', () => {
    for (const other of ['executive', 'technical', 'improvement'] as const) {
      const { header } = rows(other);
      expect(header).not.toContain('decision_id');
      expect(header).not.toContain('applicability_id');
    }
  });

  it('promises the identifiers of the two kinds of decision it carries, and no more than that', () => {
    const says = VARIANT_SHAPES.audit.says;
    expect(says).toContain('the two kinds of decision this file carries');
    // "every decision" was a claim over every decision this app records — retention, closing,
    // attestation — of which the file carries two.
    expect(says).not.toContain('identifier of every decision');
  });

  it('says why an axis is not known rather than leaving the cell blank', () => {
    // A blank in a column of digests reads as "the same as the ones above it" to somebody scanning.
    const unsure = scan({
      stamp: {
        ...scan().stamp,
        identity: {
          build: { unknown: 'the bundle beside this process is not the one that built it' },
          methodology: { id: 'sha256:cafe' },
          record: { id: 'codec-3' },
          sources: [],
        },
      },
    });
    const all = assessmentRows({ scan: unsure, catalogue: CATALOGUE, variant: 'audit' });
    expect(all[1][all[0].indexOf('app_build')]).toBe(
      'not established: the bundle beside this process is not the one that built it'
    );
  });
});

describe('choosing a variant', () => {
  it('treats an absent parameter as the complete file', () => {
    expect(variantOf(undefined)).toBe('technical');
    expect(variantOf('')).toBe('technical');
  });

  it('refuses a word this app does not produce rather than handing back the complete file', () => {
    // A caller handed the complete file after asking for `?variant=summary` will describe it to
    // somebody else as a summary, and the mistake surfaces in a meeting.
    expect(variantOf('summary')).toBeUndefined();
    expect(variantOf('EXECUTIVE')).toBeUndefined();
  });

  it('accepts each of the four', () => {
    for (const variant of EXPORT_VARIANTS) expect(variantOf(variant)).toBe(variant);
  });
});

describe('a sealed variant', () => {
  it('names the variant in the filename, so a digest is checked against the file it was published for', () => {
    expect(seal({ scan: scan(), catalogue: CATALOGUE, format: 'csv', variant: 'executive' }).name).toBe(
      'well-architected-2026-03-04-run-1234-executive.csv'
    );
    // The complete file keeps the name it has always had, so an existing runbook still matches.
    expect(seal({ scan: scan(), catalogue: CATALOGUE, format: 'csv' }).name).toBe(
      'well-architected-2026-03-04-run-1234.csv'
    );
  });

  it('gives each variant its own digest, because they are different bytes', () => {
    const digests = EXPORT_VARIANTS.map(
      (variant) => seal({ scan: scan(), catalogue: CATALOGUE, format: 'json', variant }).digest
    );
    expect(new Set(digests).size).toBe(EXPORT_VARIANTS.length);
  });

  it('produces the same bytes twice for one variant, which is what a published digest is worth', () => {
    const once = seal({ scan: scan(), catalogue: CATALOGUE, format: 'json', variant: 'audit' });
    const twice = seal({ scan: scan(), catalogue: CATALOGUE, format: 'json', variant: 'audit' });
    expect(once.digest).toBe(twice.digest);
  });
});
