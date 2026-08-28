import { describe, expect, it } from 'vitest';
import { DAY_MS } from '../attest/attestation.js';
import { draftFrom, longestParkDays, MIN_REASON, needsDate, type DraftContext } from './decision.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function context(overrides: Partial<DraftContext> = {}): DraftContext {
  return {
    knownControl: (id) => id === 'DG-02-01' || id === 'SCP-01-01',
    severityOf: (id) => (id === 'SCP-01-01' ? 'critical' : 'medium'),
    now: NOW,
    ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    controlId: 'DG-02-01',
    disposition: 'accepted',
    reason: 'The two clusters are in a lab account with no customer data, and it closes in November.',
    owner: 'platform-team@example.com',
    until: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('deciding what to do about a finding', () => {
  it('records the decision, its reason, its owner and its date', () => {
    const draft = draftFrom(body(), context());

    expect(draft.disposition).toBe('accepted');
    expect(draft.owner).toBe('platform-team@example.com');
    expect(draft.until?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('refuses a requirement this framework does not have, rather than storing an orphan', () => {
    expect(() => draftFrom(body({ controlId: 'XX-99-99' }), context())).toThrow(/no requirement with the id/);
  });

  it('refuses a decision with no reason, because the reason is the record', () => {
    // The whole value of the feature is that somebody months later can tell whether the
    // decision still holds. "Accepted" alone does not let them.
    expect(() => draftFrom(body({ reason: 'later' }), context())).toThrow(new RegExp(String(MIN_REASON)));
  });

  it('refuses an accepted risk nobody is answerable for', () => {
    expect(() => draftFrom(body({ owner: '   ' }), context())).toThrow(/answerable/);
  });

  it('asks for a review date on an acceptance, because one without a date becomes policy', () => {
    expect(() => draftFrom(body({ until: undefined }), context())).toThrow(/becomes policy/);
  });

  it('asks for a due date on a deferral, because one without a date is not a decision', () => {
    expect(() => draftFrom(body({ disposition: 'deferred', until: undefined }), context())).toThrow(
      /decision not to decide/
    );
  });

  it('refuses a date in the past, which would be lapsed the moment it was recorded', () => {
    expect(() => draftFrom(body({ until: '2026-01-01T00:00:00.000Z' }), context())).toThrow(/in the future/);
  });

  it('caps how long a finding can be parked by how much the requirement matters', () => {
    // A critical failure parked for a year with nobody looking again is the failure mode this
    // cap exists for. 90 days is not a promise that the fix lands; it is when somebody looks.
    const tooFar = new Date(NOW.getTime() + 200 * DAY_MS).toISOString();

    expect(() => draftFrom(body({ controlId: 'SCP-01-01', until: tooFar }), context())).toThrow(
      /at most 90 days at a time/
    );
    // The same date is fine on a medium requirement, whose cap is a year.
    expect(draftFrom(body({ until: tooFar }), context()).until?.toISOString()).toBe(tooFar);
  });

  it('refuses a date on a fix claim, because the next run is what settles it', () => {
    // Silently dropping it would let a reader believe they had set a reminder.
    expect(() => draftFrom(body({ disposition: 'fixed' }), context())).toThrow(/next run/);
    expect(draftFrom(body({ disposition: 'fixed', until: undefined }), context()).until).toBeUndefined();
  });

  it('lets a finding be put back on the list without an owner or a date', () => {
    const draft = draftFrom(
      { controlId: 'DG-02-01', disposition: 'reopened', reason: 'Accepted the wrong requirement by mistake.' },
      context()
    );

    expect(draft.disposition).toBe('reopened');
    expect(draft.owner).toBeUndefined();
    expect(draft.until).toBeUndefined();
  });

  it('knows which dispositions park a finding until a date', () => {
    expect(needsDate('accepted')).toBe(true);
    expect(needsDate('deferred')).toBe(true);
    expect(needsDate('fixed')).toBe(false);
    expect(needsDate('reopened')).toBe(false);
  });

  it('parks a critical finding for less time than an informational one', () => {
    expect(longestParkDays('critical')).toBeLessThan(longestParkDays('informational'));
  });
});
