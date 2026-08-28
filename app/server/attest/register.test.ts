import { describe, expect, it } from 'vitest';
import { registerAttestation } from './register.js';
import { InMemoryAttestationStore } from './store.js';
import { DAY_MS, cadenceDaysFor, type AttestationDraft } from './attestation.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

const DRAFT: AttestationDraft = {
  controlId: 'OE-01-01',
  answer: 'met',
  statement: 'Reviewed quarterly by the platform team, minutes in the runbook.',
  owner: 'platform-team@example.com',
};

describe('recording an answer', () => {
  it('attributes it to the signed-in user, not to anything in the request', async () => {
    const store = new InMemoryAttestationStore();

    const recorded = await registerAttestation({
      store,
      draft: DRAFT,
      actor: 'admin@example.com',
      severity: 'medium',
      now: NOW,
    });

    expect(recorded.attestedBy).toBe('admin@example.com');
    expect(recorded.attestedAt).toEqual(NOW);
  });

  it('sets the review date from the requirement severity', async () => {
    const store = new InMemoryAttestationStore();

    const recorded = await registerAttestation({
      store,
      draft: DRAFT,
      actor: 'admin@example.com',
      severity: 'critical',
      now: NOW,
    });

    expect(recorded.reviewBy.getTime() - NOW.getTime()).toBe(cadenceDaysFor('critical') * DAY_MS);
  });

  it('honours the catalogue cadence over the severity default', async () => {
    const store = new InMemoryAttestationStore();

    const recorded = await registerAttestation({
      store,
      draft: DRAFT,
      actor: 'admin@example.com',
      severity: 'low',
      cadenceDays: 30,
      now: NOW,
    });

    expect(recorded.reviewBy.getTime() - NOW.getTime()).toBe(30 * DAY_MS);
  });

  it('names the answer it replaced, so the chain of claims is reconstructable', async () => {
    const store = new InMemoryAttestationStore();
    const first = await registerAttestation({
      store,
      draft: { ...DRAFT, answer: 'not-met' },
      actor: 'admin@example.com',
      severity: 'medium',
      now: NOW,
    });

    const second = await registerAttestation({
      store,
      draft: DRAFT,
      actor: 'someone.else@example.com',
      severity: 'medium',
      now: new Date(NOW.getTime() + DAY_MS),
    });

    expect(second.supersedes).toBe(first.id);
    // And the first is still there. Superseding records; it does not erase.
    expect(await store.historyFor('OE-01-01')).toHaveLength(2);
  });

  it('records no predecessor for a first answer', async () => {
    const store = new InMemoryAttestationStore();

    const recorded = await registerAttestation({
      store,
      draft: DRAFT,
      actor: 'admin@example.com',
      severity: 'medium',
      now: NOW,
    });

    expect(recorded.supersedes).toBeUndefined();
  });

  it('gives every answer a distinct id, so two on the same requirement are two records', async () => {
    const store = new InMemoryAttestationStore();
    const of = () =>
      registerAttestation({ store, draft: DRAFT, actor: 'admin@example.com', severity: 'medium', now: NOW });

    const [a, b] = [await of(), await of()];

    expect(a.id).not.toBe(b.id);
  });
});
