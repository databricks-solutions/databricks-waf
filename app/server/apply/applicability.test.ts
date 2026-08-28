// The record held to what it refuses, because each refusal is the record's whole point.
//
// A decision written against a failing measurement, one written against a failing measurement with the
// check switched off first, one backdated over a period nothing recorded, a second one running beside
// the first, and one with no owner or no end. All are writable in the version of this feature that is a
// form with five fields, and all are ways to take a requirement out of a score so it reads as managed.
//
// And the standing the record derives rather than stores: a decision the reading has turned against is
// set aside without being deleted, which is the lapse the whole exposure argument rests on.

import { describe, expect, it } from 'vitest';
import {
  InvalidApplicabilityError,
  LEVERS,
  applicabilityFrom,
  effective,
  inForce,
  needsAttention,
  recorded,
  revoked,
  standingOf,
  type ApplicabilityDecision,
  type MeasuredReading,
} from './applicability.js';
import { longestAcceptanceDays } from '../accept/risk.js';
import { DAY_MS } from '../attest/attestation.js';
import type { Outcome, Severity } from '../resolve/finding.js';

const NOW = new Date('2026-04-10T09:00:00.000Z');

const KNOWN = new Set(['GOV-04', 'SEC-01', 'STREAM-02']);

// The reading each requirement reads with in-force decisions set aside — the underlying measurement the
// refusal is about. STREAM-02 is the un-measured case the lever is for; SEC-01 is failing.
const READINGS: Readonly<Record<string, Outcome>> = {
  'GOV-04': 'pass',
  'SEC-01': 'fail',
};

// The severity the term is capped by. STREAM-02 is `high` so the body below, 174 days out, is inside its
// 180-day cap — the cap has to be reachable by a test without every other case tripping it.
const SEVERITIES: Readonly<Record<string, Severity>> = {
  'GOV-04': 'medium',
  'SEC-01': 'critical',
  'STREAM-02': 'high',
};

const context = (
  over: {
    existing?: readonly ApplicabilityDecision[];
    readings?: Record<string, Outcome>;
    /** False puts the reading on a run before the most recent one, which has no finding for it. */
    latest?: boolean;
  } = {}
) => ({
  knownControl: (id: string) => KNOWN.has(id),
  severityOf: (id: string) => SEVERITIES[id],
  reading: (id: string): MeasuredReading | undefined => {
    const outcome = (over.readings ?? READINGS)[id];
    return outcome == null ? undefined : { outcome, latest: over.latest ?? true };
  },
  now: NOW,
  existing: over.existing,
});

const BODY = {
  controlId: 'GOV-04',
  lever: 'not-applicable' as const,
  reason: 'This estate runs no external sharing, so the Delta Sharing requirement is about a thing it does not have.',
  owner: 'platform-engineering',
  expiresAt: '2026-10-01T00:00:00.000Z',
};

const decision = (over: Partial<ApplicabilityDecision> = {}): ApplicabilityDecision => ({
  ...recorded(applicabilityFrom(BODY, context()), 'ana@example.com', 'decision-1', NOW),
  ...over,
});

describe('what a written decision has to carry', () => {
  it('takes a whole one', () => {
    const draft = applicabilityFrom(BODY, context());

    expect(draft.controlId).toBe('GOV-04');
    expect(draft.lever).toBe('not-applicable');
    expect(draft.owner).toBe('platform-engineering');
    // Effective from now where nothing said otherwise, rather than from an unstated date.
    expect(draft.effectiveFrom).toEqual(NOW);
  });

  it('refuses an unknown lever, and names the ones that exist', () => {
    expect(() => applicabilityFrom({ ...BODY, lever: 'ignore' }, context())).toThrow(InvalidApplicabilityError);
    expect(() => applicabilityFrom({ ...BODY, lever: undefined }, context())).toThrow(/one of/);
    for (const lever of LEVERS) {
      expect(applicabilityFrom({ ...BODY, lever, controlId: 'STREAM-02' }, context()).lever).toBe(lever);
    }
  });

  it('refuses an unknown requirement', () => {
    expect(() => applicabilityFrom({ ...BODY, controlId: 'NOPE-99' }, context())).toThrow(/no requirement/);
  });

  it('refuses a reason that says nothing, and one too short', () => {
    for (const reason of ['none', 'N/A', 'nothing.', 'TBC']) {
      expect(() => applicabilityFrom({ ...BODY, controlId: 'STREAM-02', reason }, context())).toThrow(
        InvalidApplicabilityError
      );
    }
    expect(() => applicabilityFrom({ ...BODY, controlId: 'STREAM-02', reason: 'no room' }, context())).toThrow(
      /at least 20/
    );
  });

  it('refuses one with nobody answerable', () => {
    expect(() => applicabilityFrom({ ...BODY, controlId: 'STREAM-02', owner: undefined }, context())).toThrow(/owner/);
  });
});

describe('the reading refusal — the rule ADR 0059 turned on', () => {
  it('refuses either lever against a failing reading', () => {
    for (const lever of LEVERS) {
      expect(() => applicabilityFrom({ ...BODY, controlId: 'SEC-01', lever }, context())).toThrow(
        /has been judged unmet/
      );
    }
  });

  it('does not say the app measured it, because a failing reading can be somebody’s answer', () => {
    // A resolver maps an attested `not-met` to `fail`, so the outcome this rule fires on is reachable
    // from a person's answer and nothing this function receives distinguishes the two. "The app measured
    // it and found the estate wanting" was false on every one of those.
    try {
      applicabilityFrom({ ...BODY, controlId: 'SEC-01' }, context());
      expect.unreachable('the refusal should have fired');
    } catch (cause) {
      expect((cause as Error).message).not.toContain('measured it');
      // The advice is the part worth keeping: the failure belongs in the score, visible.
      expect((cause as Error).message).toContain('accept the risk instead');
    }
  });

  it('refuses either lever against a partial reading', () => {
    const readings = { 'SEC-01': 'partial' as Outcome };
    for (const lever of LEVERS) {
      expect(() =>
        applicabilityFrom({ ...BODY, controlId: 'SEC-01', lever }, context({ readings }))
      ).toThrow(InvalidApplicabilityError);
    }
  });

  it('refuses a reading an earlier run took, where the latest run has none for it', () => {
    // Finding 11. An absent finding meant "nothing measured this", which is the case the lever is for, and
    // it is also what a targeted rerun leaves for every pillar it could not carry forward. The guard saw no
    // reading and admitted the requirement it exists to refuse.
    for (const lever of LEVERS) {
      expect(() =>
        applicabilityFrom({ ...BODY, controlId: 'SEC-01', lever }, context({ latest: false }))
      ).toThrow(InvalidApplicabilityError);
    }
  });

  it('says the reading was not the latest run’s, without saying when it was', () => {
    try {
      applicabilityFrom({ ...BODY, controlId: 'SEC-01' }, context({ latest: false }));
      expect.unreachable('the refusal should have fired');
    } catch (cause) {
      const { message } = cause as Error;
      expect(message).toContain('was read as fail by a run before the most recent one');
      // Not "is reading", which would be a claim about a run that has no reading for it.
      expect(message).not.toContain('is reading');
    }
  });

  it('allows a decision where nothing measured the requirement — the case the lever is for', () => {
    // STREAM-02 has no reading: a customer with no streaming workloads excluding the streaming rules.
    const draft = applicabilityFrom({ ...BODY, controlId: 'STREAM-02', lever: 'not-applicable' }, context());
    expect(draft.controlId).toBe('STREAM-02');
  });

  it('does not refuse a passing reading', () => {
    expect(applicabilityFrom(BODY, context()).controlId).toBe('GOV-04');
  });
});

describe('dates', () => {
  it('refuses a backdated decision', () => {
    const effectiveFrom = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    expect(() => applicabilityFrom({ ...BODY, effectiveFrom }, context())).toThrow(/backdated/);
  });

  it('allows a future effective date', () => {
    const effectiveFrom = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString();
    expect(applicabilityFrom({ ...BODY, effectiveFrom }, context()).effectiveFrom.toISOString()).toBe(effectiveFrom);
  });

  it('requires an expiry, in the future, after the effective date', () => {
    expect(() => applicabilityFrom({ ...BODY, expiresAt: undefined }, context())).toThrow(/no end date/);
    expect(() => applicabilityFrom({ ...BODY, expiresAt: '2020-01-01T00:00:00.000Z' }, context())).toThrow(
      /in the future/
    );
    const effectiveFrom = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const expiresAt = new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(() => applicabilityFrom({ ...BODY, effectiveFrom, expiresAt }, context())).toThrow(/after the date/);
  });

  it('caps the term at the severity the same requirement could be accepted for', () => {
    // Marking a critical requirement not applicable until 2199 was accepted. This lever does strictly
    // more to a score than an acceptance does — the requirement leaves the denominator rather than
    // staying visible as a failure — so a longer term here would be the way around that cap.
    const body = { ...BODY, controlId: 'STREAM-02' };
    const cap = longestAcceptanceDays('high');
    const beyond = new Date(NOW.getTime() + (cap + 1) * DAY_MS).toISOString();
    const within = new Date(NOW.getTime() + (cap - 1) * DAY_MS).toISOString();

    expect(() => applicabilityFrom({ ...body, expiresAt: beyond }, context())).toThrow(
      new RegExp(`at most ${String(cap)} days`)
    );
    expect(applicabilityFrom({ ...body, expiresAt: within }, context()).expiresAt).toEqual(new Date(within));
  });

  it('caps a critical requirement tighter than a medium one, off the same table', () => {
    const days = (id: string, count: number): (() => unknown) => () =>
      applicabilityFrom(
        { ...BODY, controlId: id, expiresAt: new Date(NOW.getTime() + count * DAY_MS).toISOString() },
        context({ readings: {} })
      );

    // 120 days is inside a medium requirement's year and past a critical one's quarter.
    expect(days('GOV-04', 120)).not.toThrow();
    expect(days('SEC-01', 120)).toThrow(/at most 90 days/);
  });

  it('leaves the term uncapped where the severity cannot be read', () => {
    // The same tolerance `accept/risk.ts` has. A build that cannot read a severity has a worse problem
    // than a long exclusion, and refusing here would block the lever rather than bound it.
    const draft = applicabilityFrom(
      { ...BODY, expiresAt: '2199-01-01T00:00:00.000Z' },
      { ...context(), severityOf: () => undefined }
    );

    expect(draft.expiresAt).toEqual(new Date('2199-01-01T00:00:00.000Z'));
  });
});

describe('one in force at a time', () => {
  it('refuses a second decision while one still stands', () => {
    const existing = [decision()];
    expect(() => applicabilityFrom(BODY, context({ existing }))).toThrow(/already excluded until/);
  });

  it('names who recorded the decision in the way, and who is answerable for it', () => {
    // `owner` is who is answerable while it stands, which the module documents and the refusal used as
    // though it were who decided. Both are on the record and they are different people here.
    const existing = [{ ...decision(), recordedBy: 'ana@example.com', owner: 'platform-engineering' }];

    expect(() => applicabilityFrom(BODY, context({ existing }))).toThrow(
      /recorded by ana@example.com with platform-engineering answerable/
    );
  });

  it('counts a pending decision as standing, without calling it an exclusion in force', () => {
    // A pending decision excludes nothing yet — the module says so where it defines the standing — and
    // the refusal told a reader the requirement was already excluded until a date it had not reached.
    const pending = decision({
      effectiveFrom: new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000),
      expiresAt: new Date(NOW.getTime() + 40 * 24 * 60 * 60 * 1000),
    });

    expect(() => applicabilityFrom(BODY, context({ existing: [pending] }))).toThrow(/taking effect/);
    expect(() => applicabilityFrom(BODY, context({ existing: [pending] }))).not.toThrow(/already excluded/);
  });

  it('counts a lapsed decision as standing, and says the reading set it aside', () => {
    // The one a reader is most likely to be trying to replace, and the one the old wording described as
    // an exclusion running until a future date while the requirement was being scored.
    const existing = [decision({ controlId: 'SEC-01' })];
    const body = { ...BODY, controlId: 'SEC-01' };

    expect(() => applicabilityFrom(body, context({ existing }))).toThrow(/this reading has set aside/);
  });

  it('lets a renewal through once the previous one has expired, and names what it renews', () => {
    const expired = decision({
      id: 'decision-old',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-03-01T00:00:00.000Z'),
      recordedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const draft = applicabilityFrom(BODY, context({ existing: [expired] }));
    const renewal = recorded(draft, 'ben@example.com', 'decision-2', NOW, [expired]);
    expect(renewal.ordinal).toBe(2);
    expect(renewal.supersedes).toBe('decision-old');
  });
});

describe('standing, derived from the dates and the reading', () => {
  it('is active while effective with room to spare', () => {
    expect(standingOf(decision(), { now: NOW })).toBe('active');
    expect(effective(standingOf(decision(), { now: NOW }))).toBe(true);
  });

  it('is expiring inside the due window', () => {
    const soon = decision({ expiresAt: new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000) });
    expect(standingOf(soon, { now: NOW })).toBe('expiring');
    expect(needsAttention(standingOf(soon, { now: NOW }))).toBe(true);
  });

  it('is pending before its effective date', () => {
    const later = decision({
      effectiveFrom: new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000),
      expiresAt: new Date(NOW.getTime() + 40 * 24 * 60 * 60 * 1000),
    });
    expect(standingOf(later, { now: NOW })).toBe('pending');
    expect(effective(standingOf(later, { now: NOW }))).toBe(false);
  });

  it('is expired once its expiry passes', () => {
    const past = decision({
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    expect(standingOf(past, { now: NOW })).toBe('expired');
    expect(needsAttention(standingOf(past, { now: NOW }))).toBe(true);
  });

  it('is superseded when told a later one replaced it', () => {
    expect(standingOf(decision(), { now: NOW, superseded: true })).toBe('superseded');
  });

  it('is revoked once ended early, before anything else', () => {
    const ended = revoked(decision(), 'sam@example.com', 'The estate took on streaming after all.', NOW);
    expect(standingOf(ended, { now: NOW, superseded: true })).toBe('revoked');
  });

  it('lapses — set aside, not deleted — when the reading turns against it', () => {
    // Effective by its dates, but the requirement now reads fail. It stops taking the requirement out of
    // the denominator, and it is a prompt to look.
    const standing = standingOf(decision(), { now: NOW, reading: 'fail' });
    expect(standing).toBe('lapsed');
    expect(effective(standing)).toBe(false);
    expect(needsAttention(standing)).toBe(true);
  });

  it('does not lapse on a reading that does not contradict it', () => {
    expect(standingOf(decision(), { now: NOW, reading: 'unmeasurable' })).toBe('active');
    expect(standingOf(decision(), { now: NOW, reading: 'pass' })).toBe('active');
  });
});

describe('revocation', () => {
  it('requires a reason of substance', () => {
    expect(() => revoked(decision(), 'sam@example.com', 'no', NOW)).toThrow(/at least 20/);
  });

  it('refuses a second revocation rather than rewriting the first', () => {
    const ended = revoked(decision(), 'sam@example.com', 'The estate took on streaming after all.', NOW);
    expect(() => revoked(ended, 'other@example.com', 'A different reason entirely, written later.', NOW)).toThrow(
      /already been revoked/
    );
  });
});

describe('inForce', () => {
  it('returns the effective decision, and nothing once the reading has set it aside', () => {
    const one = decision();
    expect(inForce([one], 'pass', NOW)?.id).toBe('decision-1');
    // Same decision, but the reading turned: it is lapsed, so it is not in force.
    expect(inForce([one], 'fail', NOW)).toBeUndefined();
  });
});
