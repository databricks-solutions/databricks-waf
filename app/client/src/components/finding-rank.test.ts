// What the queue shows, and what a decision is allowed to do to it.
//
// This is the one place in the client where a human record changes what a reader is shown, so it is
// the one place where a mistake hides a real failure. Two properties hold it: a parked finding leaves
// the queue but is still returned to be counted, and a claimed fix the estate contradicts is pushed
// to the top rather than dropped — a bug that swapped those two would look like a working feature.

import { describe, expect, it } from 'vitest';
import { splitFindings } from './finding-rank';
import type { Decision, Finding, Severity, Standing } from '../api/types';

function finding(controlId: string, severity: Severity = 'high'): Finding {
  return {
    controlId,
    pillarId: 'data-and-ai-governance',
    principleId: 'DG-02',
    title: controlId,
    outcome: 'fail',
    severity,
    coverage: { mode: 'complete' },
    evidence: [],
  };
}

function decision(controlId: string, standing: Standing, parked: boolean): Decision {
  return {
    id: `dec-${controlId}`,
    controlId,
    disposition: standing === 'contradicted' ? 'fixed' : 'accepted',
    reason: 'Recorded for the purposes of this test, at some length.',
    decidedBy: 'ada@example.com',
    decidedAt: '2026-06-01T00:00:00.000Z',
    standing,
    parked,
  };
}

const noDecisions = () => undefined;
const noControls = () => undefined;

describe('a finding somebody has parked', () => {
  const findings = [finding('DG-02-01', 'critical'), finding('DG-02-02')];
  const decided = (controlId: string) => (controlId === 'DG-02-01' ? decision(controlId, 'current', true) : undefined);

  it('leaves the queue', () => {
    const { queue } = splitFindings(findings, noControls, decided);

    expect(queue.map((entry) => entry.finding.controlId)).toEqual(['DG-02-02']);
  });

  it('is still returned, so the count beside the queue can be honest', () => {
    // A queue that silently drops rows is a queue whose length nobody can reconcile with the
    // findings page, and the reconciliation is the only reason to trust it.
    const { held } = splitFindings(findings, noControls, decided);

    expect(held.map((entry) => entry.finding.controlId)).toEqual(['DG-02-01']);
  });
});

describe('a fix the estate disagrees with', () => {
  it('goes above a more severe finding nobody has touched', () => {
    // The one row on the page that is genuinely news: somebody did the work, recorded it, and the
    // requirement still fails. Sorting it by severity would bury it under findings nobody has read.
    const findings = [finding('DG-02-01', 'critical'), finding('DG-02-02', 'low')];
    const { queue } = splitFindings(findings, noControls, (controlId) =>
      controlId === 'DG-02-02' ? decision(controlId, 'contradicted', false) : undefined
    );

    expect(queue.map((entry) => entry.finding.controlId)).toEqual(['DG-02-02', 'DG-02-01']);
  });

  it('stays in the queue rather than being held', () => {
    const { queue, held } = splitFindings([finding('DG-02-01')], noControls, (controlId) =>
      decision(controlId, 'contradicted', false)
    );

    expect(queue).toHaveLength(1);
    expect(held).toEqual([]);
  });
});

describe('a lapsed decision', () => {
  it('puts the finding back in the queue', () => {
    const { queue } = splitFindings([finding('DG-02-01')], noControls, (controlId) =>
      decision(controlId, 'lapsed', false)
    );

    expect(queue).toHaveLength(1);
  });
});

describe('a requirement two pillars ask for', () => {
  /*
   * The catalogue's own arrangement: one requirement, two entries, one alias group. `IU-01-05` and
   * `OE-02-01` are the real pair, and the labs run that found this had two of them.
   */
  const asKin = (controlId: string) =>
    controlId === 'IU-01-05' || controlId === 'OE-02-01'
      ? ({ id: controlId, aliasGroup: 'infrastructure-as-code' } as never)
      : undefined;

  const interop: Finding = { ...finding('IU-01-05'), pillarId: 'interoperability-and-usability' };
  const opex: Finding = { ...finding('OE-02-01'), pillarId: 'operational-excellence' };

  it('is one row, not two', () => {
    // Twenty unmet requirements in a real run were eighteen. Two of the twenty rows restated the row
    // above them under a different pillar label, and the count disagreed with the score, which has
    // always credited an alias group once.
    const { queue } = splitFindings([interop, opex, finding('DG-02-02')], asKin, noDecisions);

    // Two rows for three findings, ordered by the tie-break these three share: the control id.
    expect(queue.map((entry) => entry.finding.controlId)).toEqual(['DG-02-02', 'IU-01-05']);
  });

  it('names the pillar it stood in for', () => {
    const { queue } = splitFindings([interop, opex], asKin, noDecisions);

    expect(queue[0]?.alsoNamed).toEqual([{ controlId: 'OE-02-01', pillarId: 'operational-excellence' }]);
  });

  it('shows the worse of the two readings', () => {
    // If the queue kept one reading and the score kept the other, a reader could open a row this list
    // called partly met and find the pane calling it failed.
    const partly: Finding = { ...interop, outcome: 'partial' };
    const { queue } = splitFindings([partly, opex], asKin, noDecisions);

    expect(queue[0]?.finding.controlId).toBe('OE-02-01');
    expect(queue[0]?.finding.outcome).toBe('fail');
  });

  it('is left alone on a list filtered to one pillar', () => {
    // Nothing is folded because only one member of the group is present, so a pillar's page shows the
    // requirement under the id that pillar knows it by rather than the other pillar's.
    const { queue } = splitFindings([opex], asKin, noDecisions);

    expect(queue.map((entry) => entry.finding.controlId)).toEqual(['OE-02-01']);
    expect(queue[0]?.alsoNamed).toBeUndefined();
  });

  it('holds the row once when a decision parks it', () => {
    // Otherwise a parked requirement is counted once in the queue and twice in the held count, and
    // the sentence under the list — "2 held by a decision" — is about one accepted risk.
    const { queue, held } = splitFindings([interop, opex], asKin, (controlId) =>
      controlId === 'IU-01-05' ? decision(controlId, 'current', true) : undefined
    );

    expect(queue).toEqual([]);
    expect(held).toHaveLength(1);
  });
});

describe('with nothing decided', () => {
  it('ranks by severity, as it did before decisions existed', () => {
    const findings = [finding('DG-02-01', 'low'), finding('DG-02-02', 'critical')];
    const { queue, held } = splitFindings(findings, noControls, noDecisions);

    expect(queue.map((entry) => entry.finding.controlId)).toEqual(['DG-02-02', 'DG-02-01']);
    expect(held).toEqual([]);
  });

  it('leaves out what did not fail', () => {
    const passed: Finding = { ...finding('DG-02-03'), outcome: 'pass' };
    const { queue } = splitFindings([passed, finding('DG-02-01')], noControls, noDecisions);

    expect(queue.map((entry) => entry.finding.controlId)).toEqual(['DG-02-01']);
  });
});
