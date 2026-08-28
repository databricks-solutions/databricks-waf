// What a run changed, and the three things a diff must not claim.
//
// That an incomparable pair moved. That a control appearing or disappearing is the estate
// changing. And — the one a targeted rerun makes routine — that a carried-forward pillar with no
// changes was measured and found unchanged.

import { describe, expect, it } from 'vitest';
import { CollectionScheduler } from './scheduler.js';
import { changesBetween } from './changes.js';
import type { Catalogue, CatalogueControl } from '../catalogue/catalogue.js';
import type { CatalogueChange, CatalogueChangelog } from '../catalogue/changelog.js';
import type { Finding } from '../resolve/finding.js';
import type { PillarMeasurement, Scan } from './scan.js';

function finding(controlId: string, pillarId: string, outcome: Finding['outcome']): Finding {
  return {
    controlId,
    pillarId,
    principleId: controlId.slice(0, 5),
    title: controlId,
    outcome,
    severity: 'medium',
    coverage: { mode: 'complete' },
    evidence: [],
  };
}

function control(id: string, pillarId: string): CatalogueControl {
  return {
    id,
    pillarId,
    principleId: id.slice(0, 5),
    title: `Requirement ${id}`,
    severity: 'high',
    provenance: 'waf-docs',
    measurability: 'system-table',
    evaluatorStatus: 'implemented',
    coverageMode: 'complete',
    clouds: [],
    dasf: [],
    references: [],
  };
}

const catalogue: Pick<Catalogue, 'controls'> = {
  controls: [control('CO-01-01', 'cost-optimization'), control('REL-01-01', 'reliability')],
};

function measurement(pillarId: string, carriedForward: boolean): PillarMeasurement {
  return {
    pillarId,
    scanId: carriedForward ? 'older' : 'newer',
    measuredAt: new Date('2026-08-01T10:00:00.000Z'),
    actor: 'someone@example.com',
    carriedForward,
  };
}

function scan(overrides: Partial<Scan> = {}): Scan {
  return {
    id: 'newer',
    startedAt: new Date('2026-08-01T09:59:00.000Z'),
    finishedAt: new Date('2026-08-01T10:00:00.000Z'),
    state: 'complete',
    stamp: {
      publicMethodology: { publicVersion: 1, manifestDigest: 'sha256:manifest', state: 'released' },
      catalogueVersion: '3',
      catalogueFingerprint: 'abc',
      executionMode: 'on-behalf-of-user',
      actor: 'someone@example.com',
      scope: { description: 'the account' },
      lookbackDays: 30,
    },
    score: {
      pillars: [],
      counts: { pass: 0, fail: 0, partial: 0, unmeasurable: 0, 'not-applicable': 0, 'satisfied-by-architecture': 0 },
      scoredControls: 0,
      composition: { observed: 0, 'admin-collected': 0, attested: 0 },
      totalControls: 0,
      overall: 60,
    },
    findings: [],
    signals: [],
    estate: { assessed: [], excluded: [] },
    measurement: [],
    footprint: new CollectionScheduler().footprint(),
    spend: [],
    ...overrides,
  };
}

const before = scan({
  id: 'older',
  finishedAt: new Date('2026-07-25T10:00:00.000Z'),
  score: { ...scan().score, overall: 50 },
  findings: [finding('CO-01-01', 'cost-optimization', 'pass'), finding('REL-01-01', 'reliability', 'fail')],
});

describe('changesBetween', () => {
  it('refuses a first run rather than diffing it against nothing', () => {
    const answer = changesBetween(scan(), undefined, catalogue);
    expect(answer.comparable).toBe(false);
    expect(answer.reason).toContain('first recorded run');
    expect(answer.changes).toEqual([]);
  });

  it('refuses two runs measured as different identities, and says which', () => {
    const answer = changesBetween(
      scan({ stamp: { ...scan().stamp, actor: 'someone-else@example.com' } }),
      before,
      catalogue
    );
    expect(answer.comparable).toBe(false);
    expect(answer.reason).toContain('different identities');
    // The previous run is still named, so the reader knows what was refused.
    expect(answer.previous?.id).toBe('older');
    expect(answer.changes).toEqual([]);
  });

  it('reports a regression with the outcome on both sides', () => {
    const answer = changesBetween(
      scan({ findings: [finding('CO-01-01', 'cost-optimization', 'fail'), finding('REL-01-01', 'reliability', 'fail')] }),
      before,
      catalogue
    );

    expect(answer.comparable).toBe(true);
    expect(answer.changes).toEqual([
      {
        controlId: 'CO-01-01',
        title: 'Requirement CO-01-01',
        pillarId: 'cost-optimization',
        severity: 'high',
        from: 'pass',
        to: 'fail',
      },
    ]);
  });

  it('puts regressions before improvements, since one is urgent and the other is not', () => {
    const answer = changesBetween(
      scan({ findings: [finding('CO-01-01', 'cost-optimization', 'fail'), finding('REL-01-01', 'reliability', 'pass')] }),
      before,
      catalogue
    );

    expect(answer.changes.map((change) => change.controlId)).toEqual(['CO-01-01', 'REL-01-01']);
  });

  it('reports a control that disappeared as absent rather than as a failure', () => {
    const answer = changesBetween(
      scan({ findings: [finding('CO-01-01', 'cost-optimization', 'pass')] }),
      before,
      catalogue
    );

    expect(answer.changes).toHaveLength(1);
    expect(answer.changes[0]).toMatchObject({ controlId: 'REL-01-01', from: 'fail', to: 'absent' });
  });

  it('names a control the catalogue no longer holds rather than dropping it from the diff', () => {
    const answer = changesBetween(
      scan({ findings: [finding('GONE-01-01', 'reliability', 'pass')] }),
      before,
      catalogue
    );

    expect(answer.changes.map((change) => change.controlId)).toContain('GONE-01-01');
  });

  it('reports the score movement', () => {
    expect(changesBetween(scan(), before, catalogue).overallDelta).toBe(10);
  });

  it('names carried-forward pillars, so no change in them does not read as no movement', () => {
    const answer = changesBetween(
      scan({
        findings: [finding('CO-01-01', 'cost-optimization', 'pass'), finding('REL-01-01', 'reliability', 'fail')],
        measurement: [measurement('cost-optimization', false), measurement('reliability', true)],
      }),
      before,
      catalogue
    );

    expect(answer.comparable).toBe(true);
    expect(answer.changes).toEqual([]);
    expect(answer.unobserved).toEqual(['reliability']);
  });

  it('leaves unobserved empty when the run measured everything itself', () => {
    const answer = changesBetween(
      scan({ measurement: [measurement('cost-optimization', false), measurement('reliability', false)] }),
      before,
      catalogue
    );

    expect(answer.unobserved).toEqual([]);
  });
});

// A catalogue update used to reset every customer's trend line. What replaces that refusal is a
// permitted comparison carrying a caveat and a split of the movement — so these tests are mostly
// about the difference between the two versions being described rather than assumed.
describe('a comparison that crosses a catalogue version', () => {
  const older = scan({
    id: 'older',
    finishedAt: new Date('2026-07-25T10:00:00.000Z'),
    stamp: { ...scan().stamp, catalogueVersion: '2', catalogueFingerprint: 'two' },
    score: { ...scan().score, overall: 100 },
    findings: [finding('CO-01-01', 'cost-optimization', 'pass'), finding('REL-01-01', 'reliability', 'pass')],
  });

  const newer = scan({
    stamp: { ...scan().stamp, catalogueVersion: '3', catalogueFingerprint: 'three' },
    score: { ...scan().score, overall: 50 },
    findings: [finding('CO-01-01', 'cost-optimization', 'fail'), finding('REL-01-01', 'reliability', 'pass')],
  });

  function history(one: Partial<CatalogueChange> = {}): CatalogueChangelog {
    return {
      entries: [
        {
          version: '3',
          fingerprint: 'three',
          recordedAt: '2026-07-30T00:00:00.000Z',
          scoredUnits: 2,
          describes: true,
          added: [],
          removed: [],
          renamed: [],
          changed: [],
          ...one,
        },
      ],
    };
  }

  it('refuses when nothing records what the newer catalogue changed', () => {
    const answer = changesBetween(newer, older, catalogue);

    expect(answer.comparable).toBe(false);
    expect(answer.reason).toContain('no record of what changed in catalogue version 3');
  });

  it('permits the comparison and qualifies it once the change is described', () => {
    const answer = changesBetween(newer, older, catalogue, history({ added: ['NEW-01-01'] }));

    expect(answer.comparable).toBe(true);
    expect(answer.caveat).toContain('1 added');
    expect(answer.overallDelta).toBe(-50);
  });

  it('splits the movement so a reader is not blamed for a release note', () => {
    // The arriving requirement is in the later run's findings and failing, and the total fell
    // further than the stable core did. Both of those matter: with the added control absent from
    // both runs it cannot affect either score, so the split would read correctly whether or not the
    // catalogue half were being computed at all.
    const withArrival = scan({
      stamp: { ...scan().stamp, catalogueVersion: '3', catalogueFingerprint: 'three' },
      score: { ...scan().score, overall: 40 },
      findings: [
        finding('CO-01-01', 'cost-optimization', 'fail'),
        finding('REL-01-01', 'reliability', 'pass'),
        finding('NEW-01-01', 'reliability', 'fail'),
      ],
    });

    const answer = changesBetween(
      withArrival,
      older,
      { controls: [...catalogue.controls, control('NEW-01-01', 'reliability')] },
      history({ added: ['NEW-01-01'] })
    );

    const split = answer.attribution;
    expect(split?.added).toBe(1);
    expect(split?.stable).toBe(2);
    // The estate half is the stable core's own movement, with the arrival excluded from it.
    expect(split?.estate).toBe(-50);
    // And the rest of the fall is the catalogue's, so the two halves sum to the printed total.
    expect(split?.catalogue).toBe(-10);
    expect((split?.estate ?? 0) + (split?.catalogue ?? 0)).toBe(answer.overallDelta);
  });

  it('counts the stable core in scored units, not ids, when requirements share an alias group', () => {
    // Two requirements collapsed to one scored unit is one requirement as far as the score is
    // concerned, so calling it two overstates the base the estate half was computed over.
    const grouped = { controls: catalogue.controls.map((one) => ({ ...one, aliasGroup: 'acid' })) };
    const answer = changesBetween(newer, older, grouped, history({ added: ['NEW-01-01'] }));

    expect(answer.attribution?.stable).toBe(1);
  });

  it('does not report a departed requirement under an id an arrival has since taken', () => {
    // Version 3 dropped `CO-01-01`; version 4 put an unrelated requirement on the number it freed.
    // The earlier run's finding for that number and the later run's are about different things, so
    // pairing them says a requirement regressed when one left and another arrived.
    const churned = scan({
      stamp: { ...scan().stamp, catalogueVersion: '4', catalogueFingerprint: 'four' },
      findings: [finding('CO-01-01', 'cost-optimization', 'fail'), finding('REL-01-01', 'reliability', 'pass')],
    });

    const answer = changesBetween(churned, older, catalogue, {
      entries: [
        ...history({ removed: ['CO-01-01'] }).entries,
        ...history({ added: ['CO-01-01'] }).entries.map((one) => ({ ...one, version: '4', fingerprint: 'four' })),
      ],
    });

    expect(answer.caveat).toContain('1 added, 1 removed');
    // The arrival is a row, because the later run holds a finding for it. The departure is not,
    // because the row would carry the arriving requirement's title under the departed one's outcome.
    expect(answer.changes).toEqual([
      expect.objectContaining({ controlId: 'CO-01-01', from: 'absent', to: 'fail' }),
    ]);
  });

  it('does not split a comparison within one catalogue version, where all of it is the estate', () => {
    expect(changesBetween(scan(), before, catalogue, history()).attribution).toBeUndefined();
  });

  it('shows a renumbered requirement as one row that moved, under its old and new names', () => {
    const renamedRun = scan({
      stamp: { ...scan().stamp, catalogueVersion: '3', catalogueFingerprint: 'three' },
      findings: [finding('CO-02-01', 'cost-optimization', 'fail'), finding('REL-01-01', 'reliability', 'pass')],
    });

    const answer = changesBetween(
      renamedRun,
      older,
      { controls: [...catalogue.controls, control('CO-02-01', 'cost-optimization')] },
      history({ renamed: [{ from: 'CO-01-01', to: 'CO-02-01' }] })
    );

    expect(answer.changes).toHaveLength(1);
    expect(answer.changes[0]).toMatchObject({ controlId: 'CO-02-01', wasKnownAs: 'CO-01-01', from: 'pass', to: 'fail' });
  });

  it('does not report a departed requirement under an id a renumbering has since taken', () => {
    // Version 3 dropped `CO-01-01`; version 4 renumbered `REL-01-01` onto the id it vacated. Both of
    // the earlier run's findings would otherwise key the same row.
    const collided = scan({
      stamp: { ...scan().stamp, catalogueVersion: '4', catalogueFingerprint: 'four' },
      findings: [finding('CO-01-01', 'cost-optimization', 'fail')],
    });

    const answer = changesBetween(collided, older, catalogue, {
      entries: [
        ...history({ removed: ['CO-01-01'] }).entries,
        ...history({ renamed: [{ from: 'REL-01-01', to: 'CO-01-01' }] }).entries.map((one) => ({
          ...one,
          version: '4',
          fingerprint: 'four',
        })),
      ],
    });

    // One row, and it belongs to the requirement that now holds the id.
    expect(answer.changes).toHaveLength(1);
    expect(answer.changes[0]).toMatchObject({ controlId: 'CO-01-01', wasKnownAs: 'REL-01-01', to: 'fail' });
  });

  it('marks a transition whose requirement was rescoped at the same time', () => {
    const answer = changesBetween(
      newer,
      older,
      catalogue,
      history({ changed: [{ id: 'CO-01-01', fields: ['severity'] }] })
    );

    expect(answer.changes[0]).toMatchObject({ controlId: 'CO-01-01', redefined: ['severity'] });
  });
});
