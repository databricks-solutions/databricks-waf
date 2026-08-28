import { describe, expect, it } from 'vitest';
import { DAY_MS, type Attestation } from './attestation.js';
import { InMemoryAttestationStore, effective, newestFirst } from './store.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function attestation(overrides: Partial<Attestation> = {}): Attestation {
  return {
    id: 'a1',
    controlId: 'OE-01-01',
    answer: 'met',
    statement: 'Reviewed quarterly by the platform team, minutes in the runbook.',
    owner: 'platform-team@example.com',
    attestedBy: 'admin@example.com',
    attestedAt: NOW,
    reviewBy: new Date(NOW.getTime() + 365 * DAY_MS),
    ...overrides,
  };
}

describe('the current answer for a requirement', () => {
  it('is the newest, and the ones it replaced are still readable', async () => {
    const store = new InMemoryAttestationStore();
    const first = attestation({ id: 'a1', answer: 'not-met', attestedAt: new Date('2026-01-01T00:00:00.000Z') });
    const second = attestation({ id: 'a2', answer: 'met', attestedAt: new Date('2026-05-01T00:00:00.000Z') });

    await store.record(first);
    await store.record(second);

    expect((await store.current()).map((entry) => entry.id)).toEqual(['a2']);
    // The whole point of appending rather than overwriting: nobody's answer disappears.
    expect((await store.historyFor('OE-01-01')).map((entry) => entry.id)).toEqual(['a2', 'a1']);
  });

  it('keeps one answer per requirement rather than one overall', async () => {
    const store = new InMemoryAttestationStore();
    await store.record(attestation({ id: 'a1', controlId: 'OE-01-01' }));
    await store.record(attestation({ id: 'a2', controlId: 'IU-02-03' }));

    expect((await store.current()).map((entry) => entry.controlId).sort()).toEqual(['IU-02-03', 'OE-01-01']);
  });

  it('says it does not survive a restart, so the UI can warn rather than imply a record', () => {
    expect(new InMemoryAttestationStore().durable).toBe(false);
  });

  it('has no history for a requirement nobody has answered', async () => {
    expect(await new InMemoryAttestationStore().historyFor('OE-01-01')).toEqual([]);
  });
});

describe('which answers count', () => {
  it('excludes a lapsed answer, leaving the requirement unmeasured', () => {
    const live = attestation({ id: 'live', controlId: 'OE-01-01' });
    const lapsed = attestation({
      id: 'lapsed',
      controlId: 'IU-02-03',
      reviewBy: new Date(NOW.getTime() - DAY_MS),
    });

    const map = effective([live, lapsed], NOW);

    expect(map.get('OE-01-01')?.id).toBe('live');
    expect(map.has('IU-02-03')).toBe(false);
  });

  it('includes one that is due, because warning is not the same as lapsing', () => {
    const due = attestation({ reviewBy: new Date(NOW.getTime() + 5 * DAY_MS) });

    expect(effective([due], NOW).has('OE-01-01')).toBe(true);
  });
});

describe('ordering', () => {
  it('puts the answer that superseded another above it when both share a timestamp', () => {
    // The case that matters, and it is not hypothetical: confirming an answer immediately after
    // giving it lands both in the same millisecond. Ordered by id, the corrected answer could sort
    // above the correction — so `current()` would return an answer already superseded, and the
    // history would show a fix above the thing it fixed.
    const first = attestation({ id: 'zzz-first' });
    const second = attestation({ id: 'aaa-second', supersedes: 'zzz-first' });

    expect(newestFirst([first, second]).map((entry) => entry.id)).toEqual(['aaa-second', 'zzz-first']);
  });

  it('orders a whole chain recorded in one millisecond', () => {
    const one = attestation({ id: 'one' });
    const two = attestation({ id: 'two', supersedes: 'one' });
    const three = attestation({ id: 'three', supersedes: 'two' });

    expect(newestFirst([two, one, three]).map((entry) => entry.id)).toEqual(['three', 'two', 'one']);
  });

  it('still prefers the clock, since a chain only breaks ties', () => {
    // A later answer that somehow records no supersedes is still the later answer.
    const older = attestation({ id: 'older', supersedes: 'gone', attestedAt: new Date('2026-01-01T00:00:00.000Z') });
    const newer = attestation({ id: 'newer', attestedAt: new Date('2026-05-01T00:00:00.000Z') });

    expect(newestFirst([older, newer]).map((entry) => entry.id)).toEqual(['newer', 'older']);
  });

  it('breaks a tie on id when there is no relationship between the two', () => {
    const b = attestation({ id: 'b', controlId: 'IU-02-03' });
    const a = attestation({ id: 'a', controlId: 'OE-01-01' });

    expect(newestFirst([b, a]).map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('does not hang on a cycle, which a hand-edited volume can produce', () => {
    const a = attestation({ id: 'a', supersedes: 'b' });
    const b = attestation({ id: 'b', supersedes: 'a' });

    expect(newestFirst([a, b])).toHaveLength(2);
  });
});
