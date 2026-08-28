import { describe, expect, it } from 'vitest';
import { DAY_MS } from '../attest/attestation.js';
import type { Outcome } from '../resolve/finding.js';
import type { Decision, Disposition } from './decision.js';
import { needsAttention, parked, standingOf, standingsFor } from './standing.js';

const DECIDED = new Date('2026-06-01T12:00:00.000Z');
const NOW = new Date('2026-06-10T12:00:00.000Z');

function decision(disposition: Disposition, overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'd1',
    controlId: 'DG-02-01',
    disposition,
    reason: 'The two clusters are in a lab account with no customer data.',
    owner: 'platform-team@example.com',
    decidedBy: 'admin@example.com',
    decidedAt: DECIDED,
    ...(disposition === 'accepted' || disposition === 'deferred'
      ? { until: new Date(NOW.getTime() + 90 * DAY_MS) }
      : {}),
    ...overrides,
  };
}

function after(outcome: Outcome): { finding: { outcome: Outcome }; measuredAt: Date; now: Date } {
  return { finding: { outcome }, measuredAt: new Date(DECIDED.getTime() + DAY_MS), now: NOW };
}

describe('where a decision stands once the estate has had its say', () => {
  it('reports a claimed fix the next run still finds unmet as contradicted', () => {
    // The line this whole feature is for. A fix that was attempted and did not take is more
    // useful to know about than the original finding.
    expect(standingOf(decision('fixed'), after('fail'))).toBe('contradicted');
    expect(standingOf(decision('fixed'), after('partial'))).toBe('contradicted');
  });

  it('reports a claimed fix the next run agrees with as confirmed', () => {
    expect(standingOf(decision('fixed'), after('pass'))).toBe('confirmed');
    expect(standingOf(decision('fixed'), after('satisfied-by-architecture'))).toBe('confirmed');
  });

  it('does not confirm a fix from a run that could not measure the requirement', () => {
    // Otherwise a fix is verified by the app losing a permission, which is the opposite of
    // verification.
    expect(standingOf(decision('fixed'), after('unmeasurable'))).toBe('unverified');
  });

  it('does not confirm a fix from a run that finished before the claim', () => {
    // The run that prompted the claim cannot be the run that confirms it.
    const before = { finding: { outcome: 'pass' as Outcome }, measuredAt: new Date(DECIDED.getTime() - DAY_MS), now: NOW };

    expect(standingOf(decision('fixed'), before)).toBe('unverified');
  });

  it('leaves a fix claim unverified until something has measured it', () => {
    expect(standingOf(decision('fixed'), { now: NOW })).toBe('unverified');
  });

  it('counts down an acceptance to its review date, then lapses it', () => {
    const soon = decision('accepted', { until: new Date(NOW.getTime() + 10 * DAY_MS) });
    const later = decision('accepted', { until: new Date(NOW.getTime() + 200 * DAY_MS) });
    const gone = decision('accepted', { until: new Date(NOW.getTime() - DAY_MS) });

    expect(standingOf(later, { now: NOW })).toBe('current');
    expect(standingOf(soon, { now: NOW })).toBe('due');
    expect(standingOf(gone, { now: NOW })).toBe('lapsed');
  });

  it('treats a parked finding the estate has since fixed as settled', () => {
    // Nothing left to park. Keeping it on the decisions page as an accepted risk would have the
    // reader reviewing a risk that no longer exists.
    expect(standingOf(decision('accepted'), after('pass'))).toBe('settled');
    expect(standingOf(decision('deferred'), after('not-applicable'))).toBe('settled');
  });

  it('keeps a deferral parked while the finding is still unmet', () => {
    expect(standingOf(decision('deferred'), after('fail'))).toBe('current');
  });

  it('records a withdrawal as withdrawn rather than dropping it', () => {
    // Who put something back on the list, and why, is part of the record.
    expect(standingOf(decision('reopened'), after('fail'))).toBe('withdrawn');
  });

  it('takes off the queue only what somebody is actually holding', () => {
    expect([parked('current'), parked('due'), parked('unverified')]).toEqual([true, true, true]);
    expect([parked('lapsed'), parked('contradicted'), parked('withdrawn')]).toEqual([false, false, false]);
  });

  it('asks for attention where something has changed or run out', () => {
    expect([needsAttention('contradicted'), needsAttention('lapsed'), needsAttention('due')]).toEqual([
      true,
      true,
      true,
    ]);
    expect([needsAttention('current'), needsAttention('confirmed'), needsAttention('settled')]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('judges every decision against the run being read, and says what it was measured as', () => {
    const findings = [
      { controlId: 'DG-02-01', outcome: 'fail' as Outcome },
      { controlId: 'SCP-01-01', outcome: 'pass' as Outcome },
    ];

    const standings = standingsFor(
      [decision('fixed'), decision('fixed', { id: 'd2', controlId: 'SCP-01-01' })],
      {
        findings: findings as never,
        measuredAt: new Date(DECIDED.getTime() + DAY_MS),
        now: NOW,
      }
    );

    expect(standings.map((entry) => [entry.decision.controlId, entry.standing, entry.outcome])).toEqual([
      ['DG-02-01', 'contradicted', 'fail'],
      ['SCP-01-01', 'confirmed', 'pass'],
    ]);
  });
});
