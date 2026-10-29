// What a reader outside the assessor group is given in place of a restricted field.
//
// Three kinds of field, each replaced by a typed placeholder that says why it is gone and who can see
// it, and nothing else touched: outcomes, scores, coverage and the evidence that carries no one's name
// read the same for every reader. The projection is a function of the stored record, so a record
// written before this existed is covered without being rewritten.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Evidence } from '../resolve/finding.js';
import type { WithheldPayload } from '../../shared/api/contract.js';
import { COMPLETE } from '../collect/signal.js';
import {
  carriesPrincipals,
  projectAdvisoryPayload,
  projectEvidence,
  projectFindings,
  withheldFrom,
} from './projection.js';

const GROUP = 'waf-assessors';

/** Evidence as a projected copy may carry it: the stored fields, and the placeholder that can stand in. */
type Shown = Evidence & { readonly withheld?: WithheldPayload };

const evidence = (over: Partial<Evidence> = {}): Evidence => ({
  signal: 'sql:uc.census',
  observed: '10 tables',
  coverage: COMPLETE,
  collectedAt: new Date('2026-08-01T00:00:00Z'),
  ...over,
});

const tokenDetail = evidence({
  signal: 'rest:workspace:token.list',
  bearing: 'detail',
  observed: 'Held by: carol@example.com',
});

const jobsDetail = evidence({
  signal: 'sql:jobs.inventory',
  bearing: 'detail',
  observed: 'Running as a user account: etl (dana@example.com)',
  at: { lead: 'Running as a user account', items: [{ label: 'etl', note: 'dana@example.com' }] },
});

const imported = evidence({
  evidenceClass: 'admin-collected',
  observed: 'enableIpAccessLists is true',
  expected: 'Enabled',
  provenance: { surface: 'rest', collector: 'admin-script:conf', authority: 'admin-cli', actor: 'ops@example.com' },
});

describe('what carries a principal', () => {
  it('is the detail evidence naming token holders and the jobs run as a user, and nothing else', () => {
    expect(carriesPrincipals(tokenDetail)).toBe(true);
    expect(carriesPrincipals(jobsDetail)).toBe(true);

    expect(carriesPrincipals(evidence({ signal: 'rest:workspace:token.list', observed: '2 of 5 tokens never expire' }))).toBe(
      false
    );
    expect(
      carriesPrincipals(
        evidence({
          signal: 'sql:jobs.inventory',
          bearing: 'detail',
          at: { lead: 'Without a schedule', items: [{ label: 'etl' }] },
        })
      )
    ).toBe(false);
    expect(carriesPrincipals(evidence())).toBe(false);
  });

  // The two resolvers that print a principal beside a finding are known by name. A third one added
  // without a place in `carriesPrincipals` would publish names to everybody, so the sources that
  // read a principal off a row are held to this list rather than left to review.
  it('is every resolver that writes a principal onto a finding', () => {
    const directory = join(import.meta.dirname, '..', 'resolve', 'resolvers');
    const reading = readdirSync(directory)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .filter((name) => /\.(createdBy|runAs|userName)\b/.test(readFileSync(join(directory, name), 'utf8')))
      .sort();

    expect(reading).toEqual(['security-jobs.ts', 'security-settings.ts']);
  });
});

describe('projecting evidence', () => {
  it('leaves everything alone for an assessor', () => {
    expect(projectEvidence(tokenDetail, { assessor: true, group: GROUP })).toBe(tokenDetail);
    expect(projectEvidence(imported, { assessor: true, group: GROUP })).toBe(imported);
  });

  it('replaces principal evidence with a placeholder naming the group, and drops the structured copy', () => {
    const shown = projectEvidence(jobsDetail, { assessor: false, group: GROUP });

    expect(shown.withheld).toEqual(withheldFrom('principal-identifiers', GROUP));
    expect(shown.withheld?.visibleTo).toBe(GROUP);
    expect(shown.withheld?.reason).toContain(GROUP);
    expect(shown.observed).toContain(GROUP);
    expect(JSON.stringify(shown)).not.toContain('dana@example.com');
    expect(shown.at).toBeUndefined();
    expect(shown.signal).toBe(jobsDetail.signal);
    expect(shown.coverage).toEqual(jobsDetail.coverage);
    expect(shown.bearing).toBe('detail');
  });

  it('replaces an imported reading, keeps what it was expected to be, and drops who collected it', () => {
    const shown = projectEvidence(imported, { assessor: false, group: GROUP });

    expect(shown.withheld?.withheld).toBe('admin-reading');
    expect(shown.expected).toBe('Enabled');
    expect(shown.evidenceClass).toBe('admin-collected');
    expect(JSON.stringify(shown)).not.toContain('enableIpAccessLists');
    expect(JSON.stringify(shown)).not.toContain('ops@example.com');
    expect(shown.provenance).toBeUndefined();
  });

  it('leaves ordinary evidence, and its attribution, alone', () => {
    const ordinary = evidence({
      provenance: { surface: 'sql', collector: 'sql', authority: 'on-behalf-of-user', actor: 'runner@example.com' },
    });

    expect(projectEvidence(ordinary, { assessor: false, group: GROUP })).toBe(ordinary);
  });
});

describe('projecting findings', () => {
  it('changes only the evidence of a finding, so outcomes and summaries read the same', () => {
    const finding = {
      controlId: 'SCP-01-03',
      outcome: 'fail',
      outcomeReason: 'A token with no expiry stays valid until someone revokes it.',
      evidence: [evidence(), tokenDetail] as readonly Shown[],
    };

    const [shown] = projectFindings([finding], { assessor: false, group: GROUP });

    expect(shown).toMatchObject({ controlId: 'SCP-01-03', outcome: 'fail', outcomeReason: finding.outcomeReason });
    expect(shown?.evidence[0]).toBe(finding.evidence[0]);
    expect(shown?.evidence[1]?.withheld).toBeDefined();
  });

  it('hands an assessor the very findings it was given', () => {
    const findings = [{ evidence: [tokenDetail] }];

    expect(projectFindings(findings, { assessor: true, group: GROUP })).toBe(findings);
  });
});

describe('projecting an advisory', () => {
  interface Shape {
    readonly shape: string;
    readonly statementType?: string;
    readonly statementText?: string;
    readonly statementWithheld?: WithheldPayload;
  }
  const shape: Shape = { shape: 'aaaa', statementText: 'select 1', statementType: 'SELECT' };
  const advisory: {
    readonly id: string;
    readonly workload: { readonly top: readonly Shape[]; readonly failing: readonly Shape[] };
    readonly writes: { readonly shapes: readonly Shape[] };
  } = {
    id: 'a1',
    workload: { top: [shape], failing: [shape] },
    writes: { shapes: [{ shape: 'bbbb', statementText: 'insert into t select 1' }] },
  };

  it('replaces the statement text in every list that carries it', () => {
    const shown = projectAdvisoryPayload(advisory, { assessor: false, group: GROUP });
    const text = JSON.stringify(shown);

    expect(text).not.toContain('select 1');
    expect(text).not.toContain('insert into');
    expect(shown.workload?.top[0]?.statementWithheld?.withheld).toBe('statement-text');
    expect(shown.workload?.failing[0]?.statementWithheld?.visibleTo).toBe(GROUP);
    expect(shown.writes?.shapes[0]?.statementWithheld?.withheld).toBe('statement-text');
    expect(shown.workload?.top[0]?.shape).toBe('aaaa');
  });

  it('does not mark a shape that had no text to withhold', () => {
    const bare = { id: 'a2', workload: { top: [{ shape: 'cccc' }], failing: [] } };

    expect(projectAdvisoryPayload(bare, { assessor: false, group: GROUP }).workload?.top[0]).toEqual({ shape: 'cccc' });
  });

  it('hands an assessor the advisory it was given', () => {
    expect(projectAdvisoryPayload(advisory, { assessor: true, group: GROUP })).toBe(advisory);
  });
});
