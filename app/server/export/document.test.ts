// The export, tested for what a recipient can conclude from it.
//
// Most of these assertions are about a row being complete rather than about a value being right.
// A file that leaves the app is read by somebody with no access to the app, three weeks later, and
// the failure mode is not a wrong number — it is a row nobody can act on or argue with.

import { describe, expect, it } from 'vitest';
import { assessmentCsv, assessmentDocument, assessmentRows, exportName } from './document.js';
import { CollectionScheduler } from '../scan/scheduler.js';
import type { Catalogue, CatalogueControl } from '../catalogue/catalogue.js';
import type { Decision } from '../decide/decision.js';
import type { Standing, Standings } from '../decide/standing.js';
import type { Finding } from '../resolve/finding.js';
import type { Scan } from '../scan/scan.js';
import type { ExportVariant } from './variant.js';
import type { FinalisationPayload } from '../../shared/api/contract.js';

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
    {
      id: 'security',
      code: 'SEC',
      title: 'Security, compliance and privacy',
      page: 'https://docs.databricks.com/aws/en/lakehouse-architecture/security-compliance-and-privacy',
      principles: [],
    },
  ],
  controls: [
    control({
      id: 'SEC-01-02',
      criteria: 'Every workspace has a cluster policy bound to non-admin users.',
      rationale: 'Unbounded cluster creation is the most common source of unplanned spend.',
      remediation: {
        summary: 'Bind the shared compute policy to all users in each workspace.',
        docUrl: 'https://docs.databricks.com/aws/en/admin/clusters/policies',
      },
      sourceRef: 'https://docs.databricks.com/waf#restrict-cluster-creation',
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

function scan(over: Partial<Scan> = {}): Scan {
  return {
    id: 'run-1234567890',
    startedAt: new Date('2026-03-04T09:28:00.000Z'),
    finishedAt: RAN,
    state: 'complete',
    stamp: {
      publicMethodology: {
        publicVersion: 1,
        manifestDigest: 'sha256:manifest',
        state: 'released',
        effectiveDate: '2026-09-01',
      },
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
      totalControls: 2,
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

function rowsOf(over: Partial<Scan> = {}): { header: readonly string[]; cell: (name: string) => string } {
  const rows = assessmentRows({ scan: scan(over), catalogue: CATALOGUE });
  const header = rows[0];
  return { header, cell: (name) => rows[1][header.indexOf(name)] };
}

describe('a row of the spreadsheet', () => {
  it('names the requirement, the verdict and how serious it is', () => {
    const { cell } = rowsOf();
    expect(cell('requirement')).toBe('SEC-01-02');
    expect(cell('title')).toBe('Restrict cluster creation');
    expect(cell('outcome')).toBe('fail');
    expect(cell('severity')).toBe('high');
    expect(cell('pillar')).toBe('Security, compliance and privacy');
  });

  it('repeats the run, its date and its identity on every row', () => {
    // Repetition on purpose. A spreadsheet has no header block, and a reader who filters to the
    // twelve failures has to still be able to see what produced them and when.
    const { cell } = rowsOf();
    expect(cell('run')).toBe('run-1234567890');
    expect(cell('ran_at')).toBe('2026-03-04T09:30:00.000Z');
    expect(cell('ran_as')).toBe('alice@example.com');
    expect(cell('ran_with')).toBe('the identity that started it');
    expect(cell('methodology_version')).toBe('1');
    expect(cell('methodology_state')).toBe('released');
    expect(cell('methodology_manifest')).toBe('sha256:manifest');
    expect(cell('methodology_effective_date')).toBe('2026-09-01');
    expect(cell('catalogue_revision')).toBe('1.4.0');
  });

  it('says which kind of identity a scheduled run read with, and not whose it is', () => {
    // Reachable since row 40f derived the mode instead of writing a literal. The principal is the
    // customer's — labs runs its scans as `waf-schedule-probe` — so this column said "the app's
    // service principal" about an identity the app does not own, one cell away from `ran_as` naming
    // it. The kind is what the field carries and the name is already in the next column.
    const { cell } = rowsOf({
      stamp: {
        ...scan().stamp,
        executionMode: 'service-principal',
        actor: '5af463d1-8cb9-4417-b2a5-725cea64cce5',
      },
    });

    expect(cell('ran_as')).toBe('5af463d1-8cb9-4417-b2a5-725cea64cce5');
    expect(cell('ran_with')).toBe('a service principal');
  });

  it('says what was observed against what was expected', () => {
    const { cell } = rowsOf();
    expect(cell('observed')).toBe('14 of 20 workspaces have no policy');
    expect(cell('expected')).toBe('every workspace');
  });

  it('states the coverage, including which estate it is a statement about', () => {
    expect(rowsOf().cell('coverage')).toBe('complete of the account');
  });

  it('states a sample as a fraction rather than as the word sampled', () => {
    const sampled = finding({ coverage: { mode: 'sampled', examined: 200, population: 4000, reach: 'metastore' } });
    const { cell } = rowsOf({ findings: [sampled] });
    expect(cell('coverage')).toBe('sampled, 200 of 4000 of the metastore');
  });

  it('says what the outcome rests on, so a recipient can filter to what was measured here', () => {
    expect(rowsOf().cell('evidence')).toBe('observed');
  });

  it('says attested where an answer decided it, beside the name of whoever gave it', () => {
    const answered = finding({
      evidence: [],
      attested: {
        bearing: 'outcome',
        by: 'admin@example.com',
        at: new Date('2026-03-01T00:00:00Z'),
        statement: 'Rehearsed each quarter.',
        owner: 'platform-team@example.com',
        reviewBy: new Date('2026-09-01T00:00:00Z'),
      },
    });
    const { cell } = rowsOf({ findings: [answered] });

    expect(cell('evidence')).toBe('attested');
    expect(cell('answered_by')).toBe('admin@example.com');
  });

  it('leaves the class blank where nothing bears on the outcome', () => {
    // An unmeasurable requirement rests on nothing, and a class in that cell would say it rested on
    // a reading that was never taken.
    const nothing = finding({ outcome: 'unmeasurable', evidence: [] });

    expect(rowsOf({ findings: [nothing] }).cell('evidence')).toBe('');
  });

  it('says whose permissions the reading was taken with, and from where', () => {
    // The column that lets a customer who disputes a figure go and run the same thing.
    expect(rowsOf().cell('read_as')).toBe('alice@example.com (on-behalf-of-user), from warehouse wh-1');
    expect(rowsOf().cell('collected_at')).toBe('2026-03-04T09:29:00.000Z');
  });

  it('carries the fix for a failure', () => {
    expect(rowsOf().cell('next_step')).toBe('Bind the shared compute policy to all users in each workspace.');
    expect(rowsOf().cell('documentation')).toBe('https://docs.databricks.com/aws/en/admin/clusters/policies');
  });

  it('carries the page each named resource is configured on', () => {
    // The row is going to be handed to whoever owns the resource. Without this they get a name and
    // have to go looking; with it the fix is one click from the spreadsheet.
    const located = finding({
      evidence: [
        {
          signal: 'sql:compute.clusters',
          observed: 'Without it: etl',
          bearing: 'detail',
          coverage: { mode: 'complete', reach: 'account' },
          collectedAt: READ,
          at: {
            lead: 'Without it',
            // Qualified, unlike the link on the page: a spreadsheet row has no sentence above it to
            // say which of four workspaces the name belongs to.
            items: [{ label: 'etl', in: 'field-eng', url: 'https://dbc-1.cloud.databricks.com/compute/clusters/c-etl' }],
          },
        },
      ],
    });

    expect(rowsOf({ findings: [located] }).cell('where')).toBe(
      'etl (field-eng): https://dbc-1.cloud.databricks.com/compute/clusters/c-etl'
    );
    expect(rowsOf().cell('where')).toBe('');
  });

  it('carries the way to close the gap for something unmeasured, instead of the fix', () => {
    // Different question, same column: what do I do about this row. A cell holding both would be
    // telling the reader to fix a requirement the app never measured.
    const gap = finding({
      outcome: 'unmeasurable',
      unmeasured: 'unreadable',
      evidence: [],
      remedy: { kind: 'grant', says: 'Ask an account admin to grant this app the audit scope.', signals: [] },
    });
    const { cell } = rowsOf({ findings: [gap] });
    expect(cell('next_step')).toBe('Ask an account admin to grant this app the audit scope.');
    expect(cell('why_unmeasured')).toBe('the app asked and did not get an answer');
  });

  it('explains an unmeasured row in words even when nothing suggested a remedy', () => {
    const gap = finding({ outcome: 'unmeasurable', unmeasured: 'attestation', evidence: [] });
    expect(rowsOf({ findings: [gap] }).cell('why_unmeasured')).toBe('no telemetry can answer this; a person has to');
  });

  it('answers next_step with a step and why_unmeasured with a reason, for every kind', () => {
    // One string filled both columns, so a reader filtering to the rows with something to do found the
    // reason in the cell they were going to work from. Every kind, because the two that route through a
    // table rather than a resolver's own remedy are the two nobody looks at.
    const steps = new Map<NonNullable<Finding['unmeasured']>, string>([
      ['attestation', 'Answer this in the questionnaire, with the name of whoever answered.'],
      ['unreachable', 'Nothing, until the platform exposes it. No install of this app can read it.'],
      ['unbuilt', 'Nothing. Answer it in the questionnaire if you need it recorded before then.'],
      ['unreadable', 'Re-run the scan. If it persists, check what this app is permitted to read.'],
      ['disabled', 'Switch the check back on if this requirement should apply here.'],
    ]);

    for (const [kind, step] of steps) {
      const { cell } = rowsOf({ findings: [finding({ outcome: 'unmeasurable', unmeasured: kind, evidence: [] })] });
      expect(cell('next_step'), kind).toBe(step);
      expect(cell('why_unmeasured'), kind).not.toBe(step);
    }
  });

  it('distinguishes a verdict a colleague answered from one the app measured', () => {
    // Without this the most self-reported row in the file reads as the best established one.
    const answered = finding({
      outcome: 'pass',
      evidence: [],
      attested: {
        bearing: 'outcome',
        by: 'bob@example.com',
        at: new Date('2026-02-01T00:00:00.000Z'),
        statement: 'Reviewed in the quarterly access review.',
        owner: 'Platform team',
        reviewBy: new Date('2026-05-01T00:00:00.000Z'),
      },
    });
    const { cell } = rowsOf({ findings: [answered] });
    expect(cell('answered_by')).toBe('bob@example.com');
    expect(cell('answered_at')).toBe('2026-02-01T00:00:00.000Z');
    expect(cell('accountable')).toBe('Platform team');
    expect(cell('read_as')).toBe('');
  });

  it('keeps a not-applicable requirement in the file, with its reason', () => {
    // An absent row cannot be told apart from a requirement the app forgot, and that suspicion is
    // the one an assessment does not recover from.
    const skipped = finding({
      outcome: 'not-applicable',
      outcomeReason: 'This estate runs no classic compute, so cluster policies cannot apply.',
      evidence: [],
    });
    const { cell } = rowsOf({ findings: [skipped] });
    expect(cell('outcome')).toBe('not-applicable');
    expect(cell('reason')).toBe('This estate runs no classic compute, so cluster policies cannot apply.');
  });

  it('leaves a cell empty rather than writing undefined into the spreadsheet', () => {
    const bare = finding({ controlId: 'SEC-02-01', outcome: 'pass', evidence: [] });
    const row = assessmentRows({ scan: scan({ findings: [bare] }), catalogue: CATALOGUE })[1];
    expect(row).not.toContain(undefined);
    expect(row.some((cell) => cell.includes('undefined'))).toBe(false);
  });
});

describe('a row for a finding somebody has decided about', () => {
  const DECIDED = new Date('2026-03-01T10:00:00.000Z');

  function decided(over: Partial<Decision> = {}, standing: Standing = 'contradicted'): Standings {
    return {
      decision: {
        id: 'dec-1',
        controlId: 'SEC-01-02',
        disposition: 'fixed',
        reason: 'Bound the shared policy in all twenty workspaces on the first.',
        decidedBy: 'ada@example.com',
        decidedAt: DECIDED,
        ...over,
      },
      standing,
    };
  }

  function cellsWith(entry: Standings): (name: string) => string {
    const rows = assessmentRows({ scan: scan(), catalogue: CATALOGUE, decisions: [entry] });
    const header = rows[0];
    return (name) => rows[1][header.indexOf(name)];
  }

  it('says what was chosen, why, and by whom', () => {
    const cell = cellsWith(decided());
    expect(cell('decision')).toBe('reported fixed');
    expect(cell('decision_reason')).toContain('twenty workspaces');
    expect(cell('decided_by')).toBe('ada@example.com');
    expect(cell('decided_at')).toBe(DECIDED.toISOString());
  });

  it('says in words that the run still finds it unmet', () => {
    // The row this feature exists to produce: work was reported done, and the measurement disagrees.
    // A recipient filtering a spreadsheet has to find it without knowing the app's vocabulary.
    expect(cellsWith(decided())('decision_standing')).toBe('this run still finds it unmet');
  });

  it('keeps the outcome the run measured, rather than the decision', () => {
    // The point the whole feature rests on. A decision changes which findings are asked for
    // attention; it does not change what was measured, and a spreadsheet that said otherwise would
    // let a failure be closed by being accepted.
    expect(cellsWith(decided())('outcome')).toBe('fail');
  });

  it('carries the date it comes back for a parked finding, and none for a reported fix', () => {
    const until = new Date('2026-06-01T00:00:00.000Z');
    const accepted = decided({ disposition: 'accepted', owner: 'platform-engineering', until }, 'current');

    expect(cellsWith(accepted)('decision')).toBe('risk accepted');
    expect(cellsWith(accepted)('decision_owner')).toBe('platform-engineering');
    expect(cellsWith(accepted)('decision_date')).toBe(until.toISOString());
    expect(cellsWith(decided())('decision_date')).toBe('');
  });

  it('leaves the columns empty for a withdrawn decision', () => {
    // Withdrawn is history, not a state of the requirement. "Reopened" in a cell beside a failure
    // reads as something being done about it.
    expect(cellsWith(decided({ disposition: 'reopened' }, 'withdrawn'))('decision')).toBe('');
  });

  it('leaves them empty when no decision was recorded at all', () => {
    const { cell } = rowsOf();
    expect(cell('decision')).toBe('');
    expect(cell('decision_standing')).toBe('');
  });

  it('keeps the decision out of the finding\u2019s own verdict in the JSON', () => {
    const document = assessmentDocument({ scan: scan(), catalogue: CATALOGUE, decisions: [decided()] });
    const first = (document.findings as readonly Record<string, unknown>[])[0];
    const decision = first.decision as Record<string, unknown>;

    expect(first.outcome).toBe('fail');
    expect(decision.choice).toBe('fixed');
    expect(decision.standing).toBe('contradicted');
    expect(decision.standingMeans).toBe('this run still finds it unmet');
  });
});

describe('the review that travels with the file', () => {
  function reviewCellOf(finalisation?: FinalisationPayload<Date>): string {
    const rows = assessmentRows({
      scan: scan(),
      catalogue: CATALOGUE,
      ...(finalisation != null ? { finalisation } : {}),
    });
    return rows[1][rows[0].indexOf('review')];
  }

  function standing(overrides: Partial<FinalisationPayload<Date>> = {}): FinalisationPayload<Date> {
    return {
      reviewId: 'review-1',
      finalised: false,
      recorded: 0,
      expected: 7,
      confirmed: 0,
      skipped: [],
      cited: 0,
      refreshed: 0,
      ...overrides,
    };
  }

  it('leaves the cell and the block out where this app keeps no reviews', () => {
    // Blank rather than `not reviewed`. An install with nowhere to record a review has nobody who
    // failed to do one, and a file saying otherwise puts that on a person.
    expect(reviewCellOf()).toBe('');
    expect(assessmentDocument({ scan: scan(), catalogue: CATALOGUE })).not.toHaveProperty('review');
  });

  it('never says a run was reviewed while pillars are still unrecorded', () => {
    expect(reviewCellOf(standing({ recorded: 3, confirmed: 3 }))).toBe('review unfinished (3 of 7 pillars)');
  });

  it('does not call a finalised review with skips a fully confirmed one', () => {
    expect(reviewCellOf(standing({ finalised: true, recorded: 7, confirmed: 6, skipped: ['security'] }))).toBe(
      'finalised, 6 of 7 pillars confirmed'
    );
    expect(reviewCellOf(standing({ finalised: true, recorded: 7, confirmed: 7 }))).toBe(
      'finalised, every pillar confirmed'
    );
    // Finished and unreviewed at once, which the two states above cannot express.
    expect(reviewCellOf(standing({ finalised: true, recorded: 7, skipped: ['a', 'b'] }))).toBe(
      'finalised, no pillar confirmed'
    );
  });

  it('names the skipped pillars in the JSON, and says what the cited count is not', () => {
    const document = assessmentDocument({
      scan: scan(),
      catalogue: CATALOGUE,
      finalisation: standing({
        finalised: true,
        recorded: 7,
        confirmed: 6,
        skipped: ['cost-optimisation'],
        cited: 41,
        finalisedAt: new Date('2026-08-03T09:00:00.000Z'),
        finalisedBy: 'alice',
      }),
    });
    const review = document.review as Record<string, unknown>;

    expect(review.pillarsSkipped).toEqual(['cost-optimisation']);
    expect(review.answersCited).toBe(41);
    // A recipient holding the file has no other way to tell which of the two counts they have.
    expect(review.answersCitedMeans).toContain('Not a count of the answers on record now');
    // What the record says: nobody cited these pillars' answers here. Not that the requirements have
    // none — the run can hold attested answers a skipped pillar's confirm would have copied.
    expect(review.pillarsSkippedMeans).toContain('Nobody confirmed the answers of these pillars');
    expect(review.pillarsSkippedMeans).not.toMatch(/were not answered/);
    expect(review.finalisedBy).toBe('alice');
  });

  it('is beside the score and not inside the run, which is the half that cannot move', () => {
    const document = assessmentDocument({
      scan: scan(),
      catalogue: CATALOGUE,
      finalisation: standing({ finalised: true, recorded: 7, confirmed: 7, cited: 4 }),
    });

    expect(document.run).not.toHaveProperty('review');
    expect(document).toHaveProperty('review');
  });
});

describe('a requirement a customer took out of the score', () => {
  function cellsFrom(over: Partial<Scan>, variant?: ExportVariant): (name: string) => string {
    const rows = assessmentRows({ scan: scan(over), catalogue: CATALOGUE, ...(variant != null ? { variant } : {}) });
    const header = rows[0];
    return (name) => rows[1][header.indexOf(name)];
  }

  it('says a customer decided it, and who owns that, beside the outcome', () => {
    const cell = cellsFrom({
      findings: [finding({ outcome: 'not-applicable', outcomeReason: 'No streaming workloads here at all.' })],
      score: {
        ...scan().score,
        exposure: {
          excluded: [
            {
              controlId: 'SEC-01-02',
              lever: 'not-applicable',
              owner: 'platform-team',
              reason: 'No streaming workloads here at all.',
              decisionId: 'dec-1',
            },
          ],
          lapsed: [],
        },
      },
    });

    expect(cell('outcome')).toBe('not-applicable');
    expect(cell('applicability')).toBe('not applicable, by customer decision');
    expect(cell('applicability_owner')).toBe('platform-team');
    expect(cell('applicability_reason')).toContain('No streaming workloads');
  });

  it('shows a decision this run did not apply, without claiming the requirement was ever out', () => {
    const cell = cellsFrom({
      score: {
        ...scan().score,
        exposure: {
          excluded: [],
          lapsed: [{ controlId: 'SEC-01-02', lever: 'disabled', reading: 'fail', decisionId: 'dec-1' }],
        },
      },
    });

    // The finding reads as it did — the decision did not change it — and the column says why the
    // requirement is scored. Not "back in the score": a decision recorded while nothing had measured
    // the requirement, and read as failing by the first scan to reach it, excluded nothing to be back
    // from, and this field cannot tell that case from a pass that later regressed.
    expect(cell('applicability')).toContain('not applied');
    expect(cell('applicability')).toContain('this run reads fail');
    expect(cell('applicability')).not.toContain('back in');
    expect(cell('applicability_owner')).toBe('');
  });

  it('carries the decision id, which is the join key back to the register', () => {
    const excluded = cellsFrom(
      {
        findings: [finding({ outcome: 'not-applicable' })],
        score: {
          ...scan().score,
          exposure: {
            excluded: [
              {
                controlId: 'SEC-01-02',
                lever: 'not-applicable',
                owner: 'platform-team',
                reason: 'No streaming workloads here at all.',
                decisionId: 'dec-1',
              },
            ],
            lapsed: [],
          },
        },
      },
      'audit'
    );
    const lapsed = cellsFrom(
      {
        score: {
          ...scan().score,
          exposure: {
            excluded: [],
            lapsed: [{ controlId: 'SEC-01-02', lever: 'disabled', reading: 'fail', decisionId: 'dec-2' }],
          },
        },
      },
      'audit'
    );

    // Both, because the exposure carries the id for both and a reader reconciling the file against the
    // register needs the lapsed one most: it is the row whose requirement is scored despite a decision.
    expect(excluded('applicability_id')).toBe('dec-1');
    expect(lapsed('applicability_id')).toBe('dec-2');
  });

  it('leaves the columns blank where no applicability decision bears on the row', () => {
    const cell = cellsFrom({});
    expect(cell('applicability')).toBe('');
    expect(cell('applicability_owner')).toBe('');
    expect(cell('applicability_reason')).toBe('');
  });
});

describe('the CSV file', () => {
  it('starts with a header naming every column', () => {
    const [first] = assessmentCsv({ scan: scan(), catalogue: CATALOGUE }).split('\r\n');
    expect(first).toBe(
      'run,variant,ran_at,ran_as,ran_with,started_by,methodology_version,methodology_state,methodology_manifest,' +
        'methodology_effective_date,catalogue_revision,review,pillar,requirement,title,outcome,severity,' +
        'reason,observed,expected,coverage,evidence,why_unmeasured,next_step,answered_by,answered_at,accountable,' +
        'decision,decision_standing,decision_reason,decided_by,decided_at,decision_owner,decision_date,' +
        'applicability,applicability_owner,applicability_reason,' +
        'read_as,collected_at,documentation,where'
    );
  });

  it('has one row per finding and nothing else', () => {
    const file = assessmentCsv({ scan: scan({ findings: [finding(), finding()] }), catalogue: CATALOGUE });
    expect(file.split('\r\n')).toHaveLength(3);
  });

  it('quotes a value from the estate that contains a comma', () => {
    const wordy = finding({
      evidence: [
        {
          signal: 'sql:compute.clusters',
          observed: 'analytics, marketing and finance have no policy',
          coverage: { mode: 'complete' },
          collectedAt: READ,
        },
      ],
    });
    expect(assessmentCsv({ scan: scan({ findings: [wordy] }), catalogue: CATALOGUE })).toContain(
      '"analytics, marketing and finance have no policy"'
    );
  });
});

describe('the JSON file', () => {
  it('names its own format and version, so a consumer can refuse one it does not understand', () => {
    const document = assessmentDocument({ scan: scan(), catalogue: CATALOGUE });
    expect(document.document).toBe('databricks-waf-assessment');
    expect(document.documentVersion).toBe(4);
  });

  it('says nothing about when it was produced, which is what makes two exports of one run comparable', () => {
    // The field this replaced was the only difference between two downloads of one run, so a
    // recipient checking a digest could not tell tampering from a second download. Asserted as an
    // absence because a well-meaning change that puts a timestamp back is invisible otherwise.
    expect(assessmentDocument({ scan: scan(), catalogue: CATALOGUE })).not.toHaveProperty('generatedAt');
  });

  it('records the run’s identity and completeness, which decide whether it may be compared', () => {
    const run = assessmentDocument({ scan: scan(), catalogue: CATALOGUE }).run as Record<string, unknown>;
    expect(run.ranAs).toBe('alice@example.com');
    expect(run.ranWith).toBe('on-behalf-of-user');
    expect(run.state).toBe('complete');
    expect(run.covered).toBe('Assessed across every workspace the signed-in user can see.');
    expect(run.lookbackDays).toBe(30);
    expect(run.methodology).toEqual({
      classification: 'public',
      publicVersion: 1,
      manifestDigest: 'sha256:manifest',
      state: 'released',
      effectiveDate: '2026-09-01',
    });
    expect(run.technicalCatalogue).toEqual({ revision: '1.4.0', fingerprint: 'abc' });
  });

  it('says whether anything in the run rested on a sample', () => {
    // The difference between "no workspace has a policy" and "none of the two hundred tables we
    // looked at, out of forty thousand". A recipient who misses it reports the wrong thing upward.
    expect((assessmentDocument({ scan: scan(), catalogue: CATALOGUE }).run as Record<string, unknown>).anySampled).toBe(
      false
    );

    const sampled = finding({ coverage: { mode: 'sampled', examined: 200, population: 40_000 } });
    const run = assessmentDocument({ scan: scan({ findings: [sampled] }), catalogue: CATALOGUE }).run as Record<
      string,
      unknown
    >;
    expect(run.anySampled).toBe(true);
  });

  it('carries the requirement text, so the file stands on its own', () => {
    // The wire format the UI reads omits this: the page already has the catalogue. A file does not.
    const [first] = assessmentDocument({ scan: scan(), catalogue: CATALOGUE }).findings as Record<string, unknown>[];
    expect(first.judgedBy).toBe('Every workspace has a cluster policy bound to non-admin users.');
    expect(first.whyItMatters).toContain('unplanned spend');
    expect((first.remediation as { summary: string }).summary).toContain('shared compute policy');
  });

  it('states the class of every piece of evidence and what the finding rests on', () => {
    const [first] = assessmentDocument({ scan: scan(), catalogue: CATALOGUE }).findings as Record<string, unknown>[];

    expect(first.restsOn).toBe('observed');
    // Written out rather than left absent, so a consumer does not have to know what this app's
    // missing field meant.
    expect((first.evidence as Record<string, unknown>[])[0].evidenceClass).toBe('observed');
  });

  it('omits what a finding rests on where it rests on nothing', () => {
    const gap = finding({ outcome: 'unmeasurable', evidence: [] });
    const [first] = assessmentDocument({ scan: scan({ findings: [gap] }), catalogue: CATALOGUE })
      .findings as Record<string, unknown>[];

    expect(first).not.toHaveProperty('restsOn');
  });

  it('carries the composition of the score, so a mixture is visible in the file', () => {
    const score = (assessmentDocument({ scan: scan(), catalogue: CATALOGUE }).score as Record<string, unknown>)
      .composition;

    expect(score).toEqual({ observed: 1, 'admin-collected': 0, attested: 0 });
  });

  it('writes every date as an ISO string rather than leaving a Date to JSON.stringify', () => {
    const serialised = JSON.stringify(assessmentDocument({ scan: scan(), catalogue: CATALOGUE }));
    expect(serialised).toContain('"collectedAt":"2026-03-04T09:29:00.000Z"');
    expect(serialised).toContain('"finishedAt":"2026-03-04T09:30:00.000Z"');
  });

  it('says what an unmeasured requirement means in words, not only as a keyword', () => {
    const gap = finding({ outcome: 'unmeasurable', unmeasured: 'unreachable', evidence: [] });
    const [first] = assessmentDocument({ scan: scan({ findings: [gap] }), catalogue: CATALOGUE })
      .findings as Record<string, unknown>[];
    expect(first.unmeasured).toEqual({
      kind: 'unreachable',
      means: 'the platform does not authorise any install of this app to read it',
    });
  });
});

describe('the filename', () => {
  it('carries the date and the run, so two downloads in a folder can be told apart', () => {
    expect(exportName(scan(), 'csv')).toBe('well-architected-2026-03-04-run-1234.csv');
    expect(exportName(scan(), 'json')).toBe('well-architected-2026-03-04-run-1234.json');
  });
});
