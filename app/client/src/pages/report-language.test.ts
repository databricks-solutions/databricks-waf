// What the printed review says, asserted rather than eyeballed.
//
// This copy leaves the building. A phrase on a screen can be corrected before the next reader sees
// it; a PDF in somebody's inbox is the version of record, and the two mistakes it must not make are
// naming the wrong identity and stating a score without its denominator.

import { describe, expect, it } from 'vitest';
import { appendixRows, fixNote, heldNote, RANKING_NOTE, reportPurpose, stampFacts } from './report-language';
import type { ReportedFinding, ReportedRun } from './report-language';
import type { Outcome, Score, ScanStamp } from '../api/types';

const stamp: ScanStamp = {
  catalogueVersion: '2026.07.1',
  // As the server stamps it, algorithm and all. The report is expected to drop the algorithm.
  catalogueFingerprint: 'sha256:ab12cd34ef5678901234',
  executionMode: 'on-behalf-of-user',
  actor: 'admin@example.com',
  trigger: 'interactive',
  scope: { description: 'The account, through the workspaces this identity can see.' },
  lookbackDays: 30,
  publicMethodology: {
    publicVersion: 1,
    manifestDigest: 'sha256:methodology-manifest',
    state: 'released',
    effectiveDate: '2026-09-01',
  },
};

const run: ReportedRun = {
  id: 'scan-9f2c',
  finishedAt: '2026-08-01T09:30:00.000Z',
  stamp,
};

const counts = (over: Partial<Record<Outcome, number>> = {}): Record<Outcome, number> => ({
  pass: 0,
  fail: 0,
  partial: 0,
  unmeasurable: 0,
  'not-applicable': 0,
  'satisfied-by-architecture': 0,
  ...over,
});

const score = (over: Partial<Score> = {}): Score => ({
  overall: 55.2,
  pillars: [],
  counts: counts({ pass: 30, fail: 4, unmeasurable: 100, 'not-applicable': 46 }),
  scoredControls: 34,
  composition: { observed: 0, 'admin-collected': 0, attested: 0 },
  totalControls: 184,
  ...over,
});

const value = (label: string, facts: readonly { label: string; value: string }[]): string | undefined =>
  facts.find((fact) => fact.label === label)?.value;

describe('stampFacts', () => {
  it('names the identity the run was made as, not the reader printing it', () => {
    expect(value('Ran as', stampFacts(run))).toBe('admin@example.com');
  });

  it('names a scheduled run as the service principal it was, which sees a different estate', () => {
    const scheduled: ReportedRun = {
      ...run,
      // The case ADR 0021 recorded: a schedule reaches the app through the same on-behalf-of door a
      // browser does, so the mode says nothing and the application id says everything.
      stamp: { ...stamp, actor: '5af463d1-8cb9-4417-b2a5-725cea64cce5', trigger: 'scheduled' },
    };

    expect(value('Ran as', stampFacts(scheduled))).toBe('service principal 5af463d1-8cb9-4417-b2a5-725cea64cce5');
    expect(value('Started', stampFacts(scheduled))).toBe('on a schedule');
  });

  it('omits how it started for a run that did not record it, rather than guessing', () => {
    const { trigger: _dropped, ...withoutTrigger } = stamp;
    expect(value('Started', stampFacts({ ...run, stamp: withoutTrigger }))).toBeUndefined();
  });

  it('carries the run id, so a reader holding the spreadsheet too can tell it is one run', () => {
    expect(value('Run', stampFacts(run))).toBe('scan-9f2c');
  });

  it('states the public methodology apart from technical catalogue provenance', () => {
    const facts = stampFacts(run);
    expect(value('Lookback', facts)).toBe('30 days');
    // The digest without its algorithm: sha256 is the same in every report ever printed, so eight
    // characters of "sha256:ab12cd34" would have been the word "sha256" and one hex digit.
    expect(value('Methodology', facts)).toBe('Methodology Version 1');
    expect(value('Methodology manifest', facts)).toBe('sha256:methodology-manifest');
    expect(value('Effective', facts)).toBe('2026-09-01');
    expect(value('Technical catalogue', facts)).toBe('revision 2026.07.1 · ab12cd34ef56');
    // And not under a label that makes a revision number look like a count of requirements.
    expect(value('Requirements', facts)).toBeUndefined();
  });

  it('classifies an old run as pre-release without inventing a Version 1 manifest', () => {
    const { publicMethodology: _dropped, ...development } = stamp;
    const facts = stampFacts({ ...run, stamp: development });

    expect(value('Methodology', facts)).toBe('Pre-release development');
    expect(value('Methodology manifest', facts)).toContain('Not recorded');
  });

  it('counts the workspaces only where the directory was readable', () => {
    expect(value('Workspaces assessed', stampFacts(run))).toBeUndefined();
    expect(value('Workspaces assessed', stampFacts({ ...run, stamp: { ...stamp, assessedWorkspaces: ['a', 'b'] } }))).toBe(
      '2'
    );
  });
});

describe('reportPurpose', () => {
  it('states the denominator in the sentence that introduces the document', () => {
    // 34 of 138, not 34 of 184: the 46 that do not apply to this estate are not a gap in coverage,
    // and counting them as one would understate the assessment as badly as omitting them overstates it.
    expect(reportPurpose(score())).toContain('34 of the 138 requirements that apply to this estate');
  });

  it('says the figures come from one run, because a reader will otherwise assume a trend', () => {
    expect(reportPurpose(score())).toContain('nothing is aggregated across runs');
  });
});

describe('heldNote', () => {
  it('accounts for the difference between the fixes listed and the failures counted', () => {
    // A reader comparing "what to fix" with the census at the back will find more failures than
    // fixes. In a document sent to a steering group, an unexplained gap is read as an omission.
    expect(heldNote(4)).toContain('A further 4 requirements are unmet');
    expect(heldNote(4)).toContain('listed after this section');
  });

  it('agrees with itself in number', () => {
    expect(heldNote(1)).toContain('One further requirement is');
  });

  it('says the parked ones still count against the score', () => {
    // The sentence that stops the section reading as a list of solved problems.
    expect(heldNote(2)).toContain('still count against the score');
  });
});

describe('appendixRows', () => {
  const findings: readonly ReportedFinding[] = [
    { controlId: 'CO-02-01', pillarId: 'cost', title: 'Tag every cluster', outcome: 'fail' },
    { controlId: 'SE-01-02', pillarId: 'security', title: 'No init script bypass', outcome: 'pass' },
    { controlId: 'SE-01-01', pillarId: 'security', title: 'Unity Catalog enabled', outcome: 'pass' },
    {
      controlId: 'RE-04-01',
      pillarId: 'reliability',
      title: 'Multi-region recovery is exercised',
      outcome: 'unmeasurable',
      unmeasured: 'attestation',
    },
    {
      controlId: 'RE-04-02',
      pillarId: 'reliability',
      title: 'Serverless quotas reviewed',
      outcome: 'not-applicable',
      outcomeReason: 'This estate runs no serverless workloads.',
    },
  ];

  const pillars = [
    { id: 'security', title: 'Security, compliance and privacy' },
    { id: 'reliability', title: 'Reliability' },
    { id: 'cost', title: 'Cost optimisation' },
  ];

  it('follows the catalogue order rather than the alphabet, then the identifier within a pillar', () => {
    expect(appendixRows(findings, pillars).map((row) => row.controlId)).toEqual([
      'SE-01-01',
      'SE-01-02',
      'RE-04-01',
      'RE-04-02',
      'CO-02-01',
    ]);
  });

  it('does not group the failures together, since that would repeat the body of the report', () => {
    const outcomes = appendixRows(findings, pillars).map((row) => row.outcome);
    expect(outcomes.indexOf('fail')).toBeGreaterThan(outcomes.indexOf('pass'));
  });

  it('says why an unmeasured requirement has no result, in terms of what would answer it', () => {
    const row = appendixRows(findings, pillars).find((candidate) => candidate.controlId === 'RE-04-01');
    expect(row?.because).toBe('needs an answer from a person');
  });

  it('gives an excluded requirement the reason the resolver recorded', () => {
    const row = appendixRows(findings, pillars).find((candidate) => candidate.controlId === 'RE-04-02');
    expect(row?.because).toBe('This estate runs no serverless workloads.');
  });

  it('cuts a long exclusion reason to its first sentence, since the column is not the section', () => {
    // The full reason is three sentences on the pillar page. In a 184-row table it printed eleven
    // lines deep and cost three pages of appendix.
    const wordy: ReportedFinding = {
      controlId: 'RE-04-03',
      pillarId: 'reliability',
      title: 'Classic compute is governed',
      outcome: 'not-applicable',
      outcomeReason:
        'This estate ran no classic compute in the window, so there are no clusters for this to ' +
        'govern. The control is excluded from scoring rather than failed: serverless compute is ' +
        'configured by the platform rather than by you.',
    };
    const row = appendixRows([wordy], pillars).find((candidate) => candidate.controlId === 'RE-04-03');
    expect(row?.because).toBe('This estate ran no classic compute in the window, so there are no clusters for this to govern.');
  });

  it('leaves the note empty for a measured result, where a reason would be noise', () => {
    const row = appendixRows(findings, pillars).find((candidate) => candidate.controlId === 'SE-01-01');
    expect(row?.because).toBe('');
  });

  it('names a pillar the catalogue does not carry by its id rather than dropping the row', () => {
    // A run read back from a volume can hold a pillar this build no longer catalogues. Losing the
    // row would make the appendix disagree with the count in its own heading.
    const orphan: ReportedFinding = { controlId: 'XX-01', pillarId: 'retired', title: 'Old', outcome: 'pass' };
    const rows = appendixRows([...findings, orphan], pillars);
    expect(rows).toHaveLength(6);
    expect(rows.at(-1)).toMatchObject({ controlId: 'XX-01', pillar: 'retired' });
  });
});

describe('why "what to fix" is shorter than the census', () => {
  it('says only the order when nothing is missing from it', () => {
    const note = fixNote({ held: [], grouped: 0 });

    expect(note).toBe(RANKING_NOTE);
  });

  it('accounts for a requirement two pillars ask for', () => {
    // The appendix lists both pillars' entries, as the export does, and this section lists the
    // requirement once. A reader who counts one section against the other finds the difference
    // whether or not the document explains it; the only choice is which of them does the explaining.
    const note = fixNote({ held: [], grouped: 2 });

    expect(note).toContain('2 requirements above are asked for by more than one pillar');
    expect(note).toContain('how the score counts it');
  });

  it('accounts for both reasons at once, in one paragraph', () => {
    const note = fixNote({ held: [{}], grouped: 1 });

    expect(note).toContain('One further requirement is');
    expect(note).toContain('One requirement above is');
  });
});
