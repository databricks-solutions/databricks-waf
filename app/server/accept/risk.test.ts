// The record held to the four things it refuses, because each refusal is the record's whole point.
//
// An acceptance with no compensating control, one with no end, one backdated over a period nothing was
// watching, and a second one running beside the first. All four are writable in the version of this
// feature that is a form with five fields, and all four are ways to record an exposure so that it reads
// as managed.

import { describe, expect, it } from 'vitest';
import {
  InvalidRiskError,
  acceptanceDays,
  effective,
  inForce,
  longestAcceptanceDays,
  needsAttention,
  recorded,
  revoked,
  riskFrom,
  standingOf,
  type AcceptedRisk,
} from './risk.js';
import type { Severity } from '../resolve/finding.js';

const NOW = new Date('2026-04-10T09:00:00.000Z');

const SEVERITIES: Readonly<Record<string, Severity>> = {
  'SEC-01': 'critical',
  'GOV-04': 'medium',
  'OPS-09': 'low',
};

const context = (over: { existing?: readonly AcceptedRisk[] } = {}) => ({
  knownControl: (id: string) => id in SEVERITIES,
  severityOf: (id: string) => SEVERITIES[id],
  now: NOW,
  ...over,
});

const BODY = {
  controlId: 'GOV-04',
  reason: 'The review is manual until the platform team finishes the rota tooling next quarter.',
  compensatingControl: 'The two workspaces are read-only to everybody outside the platform group, checked weekly.',
  residual: 'low',
  owner: 'platform-engineering',
  expiresAt: '2026-06-01T00:00:00.000Z',
};

const risk = (over: Partial<AcceptedRisk> = {}): AcceptedRisk => ({
  ...recorded(riskFrom(BODY, context()), 'ana@example.com', 'risk-1', NOW),
  ...over,
});

describe('what a written acceptance has to carry', () => {
  it('takes a whole one', () => {
    const draft = riskFrom(BODY, context());

    expect(draft.controlId).toBe('GOV-04');
    expect(draft.residual).toBe('low');
    expect(draft.owner).toBe('platform-engineering');
    // Effective from now where nothing said otherwise, rather than from an unstated date.
    expect(draft.effectiveFrom).toEqual(NOW);
  });

  it('refuses one with nothing holding the line', () => {
    expect(() => riskFrom({ ...BODY, compensatingControl: undefined }, context())).toThrow(InvalidRiskError);
    expect(() => riskFrom({ ...BODY, compensatingControl: 'Locked down.' }, context())).toThrow(/at least 20/);
  });

  it('refuses the words that defeat the field, and says what to write instead', () => {
    for (const answer of ['none', 'N/A', 'nothing.', 'TBC']) {
      expect(() => riskFrom({ ...BODY, compensatingControl: answer }, context())).toThrow(
        /nothing is holding the line/
      );
    }
  });

  it('refuses the reason repeated as the compensating control', () => {
    expect(() => riskFrom({ ...BODY, compensatingControl: BODY.reason }, context())).toThrow(/reason repeated/);
  });

  it('refuses one with no owner', () => {
    expect(() => riskFrom({ ...BODY, owner: '  ' }, context())).toThrow(/as owner/);
  });

  it('refuses one with no end date', () => {
    expect(() => riskFrom({ ...BODY, expiresAt: undefined }, context())).toThrow(/becomes policy/);
  });

  it('refuses a requirement this framework does not have', () => {
    expect(() => riskFrom({ ...BODY, controlId: 'NOPE-1' }, context())).toThrow(/no requirement with the id/);
  });

  it('refuses a residual risk worse than the requirement it is left over from', () => {
    // A compensating control on a medium requirement cannot leave a critical exposure: either the
    // control is not the one being described, or this is not the requirement being accepted.
    expect(() => riskFrom({ ...BODY, residual: 'critical' }, context())).toThrow(/cannot be critical/);
    expect(riskFrom({ ...BODY, residual: 'medium' }, context()).residual).toBe('medium');
  });

  it('refuses a residual risk that is not on the scale', () => {
    expect(() => riskFrom({ ...BODY, residual: 'minor' }, context())).toThrow(/as residual/);
  });
});

describe('the dates', () => {
  it('refuses a backdated acceptance', () => {
    expect(() => riskFrom({ ...BODY, effectiveFrom: '2026-01-01T00:00:00.000Z' }, context())).toThrow(
      /cannot be backdated/
    );
  });

  it('allows one that starts later, because the work is still expected until then', () => {
    const draft = riskFrom({ ...BODY, effectiveFrom: '2026-05-01T00:00:00.000Z' }, context());

    expect(draft.effectiveFrom.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('refuses an expiry before the acceptance starts', () => {
    expect(() =>
      riskFrom({ ...BODY, effectiveFrom: '2026-05-01T00:00:00.000Z', expiresAt: '2026-04-20T00:00:00.000Z' }, context())
    ).toThrow(/after the date this becomes effective/);
  });

  it('refuses an expiry that has already passed', () => {
    expect(() => riskFrom({ ...BODY, expiresAt: '2026-04-01T00:00:00.000Z' }, context())).toThrow(/in the future/);
  });

  it('caps how long a requirement may be accepted for by how much it matters', () => {
    const cap = longestAcceptanceDays('critical');
    const tooFar = new Date(NOW.getTime() + (cap + 5) * 86_400_000).toISOString();

    expect(() =>
      riskFrom({ ...BODY, controlId: 'SEC-01', residual: 'critical', expiresAt: tooFar }, context())
    ).toThrow(/at most/);
    // A less serious requirement may be accepted for longer, from the same table.
    expect(longestAcceptanceDays('low')).toBeGreaterThan(cap);
    expect(acceptanceDays().critical).toBe(cap);
  });

  it('measures the cap from now rather than from a future start, so a late start cannot buy a longer run', () => {
    const cap = longestAcceptanceDays('medium');
    const start = new Date(NOW.getTime() + 30 * 86_400_000).toISOString();
    const end = new Date(NOW.getTime() + (cap + 10) * 86_400_000).toISOString();

    expect(() => riskFrom({ ...BODY, effectiveFrom: start, expiresAt: end }, context())).toThrow(/at most/);
  });
});

describe('one at a time', () => {
  it('refuses a second acceptance while one is in force', () => {
    expect(() => riskFrom(BODY, context({ existing: [risk()] }))).toThrow(/already accepted until/);
  });

  it('names the day the first one ends, rather than quoting a timestamp at the reader', () => {
    // The refusal said "until 2026-10-03T23:59:59.999Z", which is the correct instant and reads as a
    // fault in the app. The reader's question is which day the requirement comes back.
    const held = risk({ expiresAt: new Date('2026-10-03T23:59:59.999Z') });

    expect(() => riskFrom(BODY, context({ existing: [held] }))).toThrow(/3 October 2026/);
    expect(() => riskFrom(BODY, context({ existing: [held] }))).not.toThrow(/T23:59/);
  });

  it('refuses a second one while the first has not started yet', () => {
    const pending = risk({ effectiveFrom: new Date('2026-05-01T00:00:00.000Z') });

    expect(() => riskFrom(BODY, context({ existing: [pending] }))).toThrow(/already accepted until/);
  });

  it('permits one where the previous acceptance expired', () => {
    const expired = risk({
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-03-01T00:00:00.000Z'),
    });

    expect(riskFrom(BODY, context({ existing: [expired] })).controlId).toBe('GOV-04');
  });

  it('permits one where the previous acceptance was revoked', () => {
    const ended = revoked(risk(), 'raj@example.com', 'The read-only grant was removed, so nothing is holding it.', NOW);

    expect(riskFrom(BODY, context({ existing: [ended] })).controlId).toBe('GOV-04');
  });
});

describe('where an acceptance stands', () => {
  it('is active while it is running with its expiry comfortably ahead', () => {
    expect(standingOf(risk(), { now: NOW })).toBe('active');
    expect(effective('active')).toBe(true);
  });

  it('is expiring once the date is close enough to have to decide again', () => {
    const standing = standingOf(risk(), { now: new Date('2026-05-20T00:00:00.000Z') });

    expect(standing).toBe('expiring');
    // Still parked: the decision to renew or not has not been made, and the acceptance is in force.
    expect(effective(standing)).toBe(true);
    expect(needsAttention(standing)).toBe(true);
  });

  it('is expired once the date has passed, and expiry puts the work back', () => {
    const standing = standingOf(risk(), { now: new Date('2026-07-01T00:00:00.000Z') });

    expect(standing).toBe('expired');
    expect(effective(standing)).toBe(false);
    expect(needsAttention(standing)).toBe(true);
  });

  it('is pending before it starts, and does not park the finding yet', () => {
    const later = risk({ effectiveFrom: new Date('2026-05-01T00:00:00.000Z') });

    expect(standingOf(later, { now: NOW })).toBe('pending');
    expect(effective('pending')).toBe(false);
  });

  it('is revoked once somebody ended it, whatever its dates say', () => {
    const ended = revoked(risk(), 'raj@example.com', 'The compensating control was removed in the March change.', NOW);

    expect(standingOf(ended, { now: NOW })).toBe('revoked');
    expect(effective(standingOf(ended, { now: NOW }))).toBe(false);
  });

  it('is not yet revoked at an instant before the revocation, because that is when it was still held', () => {
    const ended = revoked(risk(), 'raj@example.com', 'The compensating control was removed in the March change.', new Date('2026-05-20T00:00:00.000Z'));

    expect(standingOf(ended, { now: NOW })).toBe('active');
    expect(effective(standingOf(ended, { now: NOW }))).toBe(true);
    expect(standingOf(ended, { now: new Date('2026-05-20T00:00:00.000Z') })).toBe('revoked');
  });

  it('reads its own dates at that instant too, rather than treating a later revocation as the answer', () => {
    // Revoked after it had already expired: at an instant between the two, expiry is what happened.
    const late = revoked(
      risk(),
      'raj@example.com',
      'Tidying the register: this one had already run out.',
      new Date('2026-08-01T00:00:00.000Z')
    );

    expect(standingOf(late, { now: new Date('2026-07-01T00:00:00.000Z') })).toBe('expired');
  });

  it('reads a revoked acceptance as revoked rather than as superseded, even when both are true', () => {
    const ended = revoked(risk(), 'raj@example.com', 'The compensating control was removed in the March change.', NOW);

    expect(standingOf(ended, { now: NOW, superseded: true })).toBe('revoked');
  });

  it('is superseded where a later acceptance replaced it', () => {
    expect(standingOf(risk(), { now: NOW, superseded: true })).toBe('superseded');
  });

  it('does not need a sweep to expire, because the standing is read rather than written', () => {
    const one = risk();

    expect(standingOf(one, { now: NOW })).toBe('active');
    expect(standingOf(one, { now: new Date('2026-09-01T00:00:00.000Z') })).toBe('expired');
  });
});

describe('revoking', () => {
  it('keeps who ended it, when, and why', () => {
    const ended = revoked(risk(), 'raj@example.com', 'The read-only grant was removed in the March change.', NOW);

    expect(ended.revoked?.by).toBe('raj@example.com');
    expect(ended.revoked?.at).toEqual(NOW);
    expect(ended.revoked?.reason).toContain('read-only grant');
    // The acceptance itself is untouched: what it said, and who owned it, is the record.
    expect(ended.reason).toBe(BODY.reason);
    expect(ended.expiresAt).toEqual(risk().expiresAt);
  });

  it('insists on a reason, because this puts work back before the date somebody expected', () => {
    expect(() => revoked(risk(), 'raj@example.com', 'no', NOW)).toThrow(/at least 20/);
  });

  it('refuses to rewrite a revocation', () => {
    const ended = revoked(risk(), 'raj@example.com', 'The read-only grant was removed in the March change.', NOW);

    expect(() => revoked(ended, 'sam@example.com', 'Revoking it again for a different reason entirely.', NOW)).toThrow(
      /already been revoked/
    );
  });
});

describe('what is in force', () => {
  it('is the newest acceptance that is effective now', () => {
    const old = risk({ id: 'risk-0', recordedAt: new Date('2026-02-01T00:00:00.000Z') });
    const current = risk({ id: 'risk-2', recordedAt: new Date('2026-04-01T00:00:00.000Z') });

    expect(inForce([old, current], NOW)?.id).toBe('risk-2');
  });

  it('is nothing where every acceptance has expired or been revoked', () => {
    const expired = risk({ expiresAt: new Date('2026-04-01T00:00:00.000Z') });

    expect(inForce([expired], NOW)).toBeUndefined();
  });

  it('is nothing where the only acceptance has not started', () => {
    expect(inForce([risk({ effectiveFrom: new Date('2026-05-01T00:00:00.000Z') })], NOW)).toBeUndefined();
  });

  it('is the acceptance that stood at a past instant, not one a later revocation removes', () => {
    const ended = revoked(
      risk(),
      'raj@example.com',
      'The compensating control was removed in the May change.',
      new Date('2026-05-20T00:00:00.000Z')
    );

    expect(inForce([ended], NOW)?.id).toBe('risk-1');
    expect(inForce([ended], new Date('2026-05-21T00:00:00.000Z'))).toBeUndefined();
  });
});

describe('what it does not do', () => {
  it('records who wrote it separately from who owns it', () => {
    const one = recorded(riskFrom(BODY, context()), 'ana@example.com', 'risk-9', NOW);

    expect(one.recordedBy).toBe('ana@example.com');
    expect(one.owner).toBe('platform-engineering');
  });

  it('names the acceptance it renews rather than moving a date', () => {
    const first = risk({ id: 'risk-1' });

    const renewal = recorded(riskFrom(BODY, context()), 'ana@example.com', 'risk-2', NOW, [first]);

    expect(renewal.supersedes).toBe('risk-1');
    expect(renewal.id).not.toBe('risk-1');
  });

  it('counts how many times the requirement has been accepted, so a fourth cannot read as a first', () => {
    const history = [risk({ id: 'risk-1' }), risk({ id: 'risk-2' })];

    const third = recorded(riskFrom(BODY, context()), 'ana@example.com', 'risk-3', NOW, history);

    expect(third.ordinal).toBe(3);
    // And a first is 1 rather than 0, because it is a count of acceptances and not an index into them.
    expect(recorded(riskFrom(BODY, context()), 'ana@example.com', 'risk-9', NOW).ordinal).toBe(1);
  });
});
