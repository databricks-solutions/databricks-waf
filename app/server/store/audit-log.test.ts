// The audit log, against the strict Postgres fake and its in-memory twin.
//
// Both implementations run every test that is about the log rather than about SQL, because the
// in-memory one is what `WAF_DEMO_NO_PERSISTENCE=1` gets and a demo whose log behaves differently
// from the product's is a demo of something else. The two diverge only where the fake can prove
// something the array cannot — a lost race, a row edited underneath the reader — and those tests say
// so.

import { describe, expect, it } from 'vitest';
import { FakePostgres } from './postgres-fake.js';
import { InMemoryAuditLog, PostgresAuditLog, bodyOf, chain, type AuditLog } from './audit-log.js';
import { GENESIS, type AuditEvent } from '../audit/event.js';
import { digestOf } from '../records/digest.js';

/** The fake, told what the real table's two unique columns are. */
function fake(): FakePostgres {
  return new FakePostgres({
    keys: { audit_events: ['sequence'], audit_floor: ['id'] },
    unique: { audit_events: ['id'] },
  });
}

function event(one: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: `evt-${String(Math.random()).slice(2)}`,
    at: new Date('2026-08-04T09:00:00.000Z'),
    actor: 'dana@example.com',
    executionMode: 'on-behalf-of-user',
    action: 'attestation.record',
    outcome: 'performed',
    ...one,
  };
}

const implementations: readonly [string, () => AuditLog][] = [
  ['the durable log', () => new PostgresAuditLog(fake())],
  ['the in-memory log', () => new InMemoryAuditLog()],
];

describe.each(implementations)('%s', (_name, open) => {
  it('starts at genesis, so an empty log is not mistaken for a missing one', async () => {
    const log = open();

    expect(await log.head()).toEqual({ sequence: 0, digest: GENESIS });
  });

  it('numbers events from one, contiguously, because a gap is what a deletion looks like', async () => {
    const log = open();

    const first = await log.append(event());
    const second = await log.append(event());
    const third = await log.append(event());

    expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3]);
  });

  it('names the event before it, starting from the genesis constant', async () => {
    const log = open();

    const first = await log.append(event());
    const second = await log.append(event());

    expect(first.previous).toBe(GENESIS);
    expect(second.previous).toBe(first.digest);
  });

  it('moves the head with every append, which is what a customer records elsewhere', async () => {
    const log = open();

    const first = await log.append(event());
    const before = await log.head();
    const second = await log.append(event());

    expect(before).toEqual({ sequence: 1, digest: first.digest });
    expect(await log.head()).toEqual({ sequence: 2, digest: second.digest });
  });

  it('covers the sequence and the predecessor with the digest, not just the body', async () => {
    // This is the whole of the tamper evidence. If the digest were over the body alone, an editor
    // could reorder or renumber events without any digest changing.
    const log = open();
    const first = await log.append(event());

    const elsewhere = chain({ ...first }, { sequence: 40, digest: GENESIS });

    expect(elsewhere.digest).not.toBe(first.digest);
  });

  it('records a refusal as an event, which is the thing the gate could not answer before', async () => {
    const log = open();

    const refused = await log.append(event({ outcome: 'refused', action: 'decision.record', reason: 'not-an-owner' }));

    expect(refused.outcome).toBe('refused');
    expect(refused.reason).toBe('not-an-owner');
  });

  it('treats a repeated id as the act it already holds, rather than as a second act', async () => {
    // A retry that follows an insert which succeeded and then failed to report it. Written twice, one
    // act would read as two in every count an auditor takes.
    const log = open();
    const first = await log.append(event({ id: 'the-same' }));
    await log.append(event());

    const again = await log.append(event({ id: 'the-same' }));

    expect(again.sequence).toBe(first.sequence);
    expect(again.digest).toBe(first.digest);
    expect((await log.head()).sequence).toBe(2);
  });

  describe('reading it back', () => {
    async function populated(): Promise<AuditLog> {
      const log = open();
      await log.append(event({ id: 'a', actor: 'dana@example.com', action: 'scan.start', correlation: 'run-1' }));
      await log.append(
        event({ id: 'b', actor: 'priya@example.com', action: 'decision.record', outcome: 'refused', reason: 'no' })
      );
      await log.append(
        event({ id: 'c', actor: 'dana@example.com', action: 'export.scan', target: { kind: 'scan', id: 'scan-9' } })
      );
      return log;
    }

    it('returns newest first, which is the order the question is asked in', async () => {
      const page = await (await populated()).search();

      expect(page.events.map((one) => one.id)).toEqual(['c', 'b', 'a']);
    });

    it('narrows to one actor', async () => {
      const page = await (await populated()).search({ actor: 'dana@example.com' });

      expect(page.events.map((one) => one.id)).toEqual(['c', 'a']);
    });

    it('narrows to the refusals, which is the query the log exists for', async () => {
      const page = await (await populated()).search({ outcome: 'refused' });

      expect(page.events.map((one) => one.id)).toEqual(['b']);
    });

    it('narrows to what was acted on', async () => {
      const page = await (await populated()).search({ targetId: 'scan-9' });

      expect(page.events.map((one) => one.id)).toEqual(['c']);
    });

    it('narrows to one run, so "what happened around this" needs no time range', async () => {
      const page = await (await populated()).search({ correlation: 'run-1' });

      expect(page.events.map((one) => one.id)).toEqual(['a']);
    });

    it('pages by sequence rather than by offset, so an append mid-read cannot skip a row', async () => {
      const log = await populated();

      const first = await log.search({ limit: 2 });
      expect(first.events.map((one) => one.id)).toEqual(['c', 'b']);
      expect(first.next).toBe(2);

      const second = await log.search({ limit: 2, before: first.next });
      expect(second.events.map((one) => one.id)).toEqual(['a']);
      expect(second.next).toBeUndefined();
    });

    it('does not offer a next page when the page reached the beginning', async () => {
      const page = await (await populated()).search({ limit: 3 });

      expect(page.events).toHaveLength(3);
      expect(page.next).toBeUndefined();
    });

    it('refuses to hand back the whole log however large a page is asked for', async () => {
      const log = open();
      for (let n = 0; n < 5; n += 1) await log.append(event());

      const page = await log.search({ limit: 100_000 });

      expect(page.events.length).toBeLessThanOrEqual(5);
    });
  });

  describe('verifying it', () => {
    it('says there is nothing to verify rather than reporting an intact empty chain', async () => {
      const answer = await open().verify();

      expect(answer.checked).toBe(0);
      expect(answer.breaks).toEqual([]);
      expect(answer.means).toContain('no chain to verify');
    });

    it('finds no break in a log it wrote itself', async () => {
      const log = open();
      for (let n = 0; n < 4; n += 1) await log.append(event());

      const answer = await log.verify();

      expect(answer.checked).toBe(4);
      expect(answer.breaks).toEqual([]);
      expect(answer.head?.sequence).toBe(4);
    });

    it('says what a clean result does not establish, since that is the sentence that gets quoted', async () => {
      const log = open();
      await log.append(event());

      const answer = await log.verify();

      // A green verification that a reader over-reads is worse than a red one.
      expect(answer.means).toContain('does not establish');
      expect(answer.means).toContain('head digest');
    });

    /*
     * A chain of one, which is not an edge case: it is what a freshly reset install has, and the
     * verification page is the first thing somebody reads after emptying one. "1 events, each matching
     * its own digest" is the app failing to count to one on the page it is asking to be trusted about
     * counting.
     */
    it('counts a chain of one in the singular, being the shape a reset leaves behind', async () => {
      const log = open();
      await log.append(event());

      const answer = await log.verify();

      expect(answer.means).toContain('1 event, matching its own digest');
      expect(answer.means).not.toContain('1 events');
    });

    it('counts more than one in the plural', async () => {
      const log = open();
      for (let n = 0; n < 2; n += 1) await log.append(event());

      expect((await log.verify()).means).toContain('2 events, each matching');
    });
  });
});

// Only the durable log, because these are about a row changing underneath the reader and the
// in-memory one holds objects nothing outside it can reach.
describe('the durable log, against a table somebody edited', () => {
  async function written(): Promise<{ db: FakePostgres; log: PostgresAuditLog }> {
    const db = fake();
    const log = new PostgresAuditLog(db);
    for (const id of ['a', 'b', 'c']) await log.append(event({ id }));
    return { db, log };
  }

  it('reports the event whose body no longer matches its digest', async () => {
    const { db, log } = await written();
    const row = db.rows('audit_events').find((one) => one.sequence === 2);
    db.seed('audit_events', { ...row, body: { ...(row?.body as object), actor: 'someone-else@example.com' } });

    const answer = await log.verify();

    expect(answer.breaks).toEqual([expect.objectContaining({ sequence: 2, kind: 'digest' })]);
  });

  it('reports one break for one edited event, rather than every link after it', async () => {
    // A single altered row reported as a cascade reads as a catastrophe, and an operator who has
    // seen one of those learns to skip the whole page.
    const { db, log } = await written();
    const row = db.rows('audit_events').find((one) => one.sequence === 2);
    db.seed('audit_events', { ...row, body: { ...(row?.body as object), reason: 'invented' } });

    const answer = await log.verify();

    expect(answer.breaks).toHaveLength(1);
  });

  it('reports the gap a removed row leaves, since removal from the middle is the thing to catch', async () => {
    const { db, log } = await written();
    db.drop('audit_events', { sequence: 2 });

    const answer = await log.verify();

    expect(answer.breaks).toEqual([
      expect.objectContaining({ sequence: 3, kind: 'gap' }),
      // The link too, because event 3 names an event that is no longer there. Both are true and both
      // are worth reporting: the gap says a row went, the link says the chain no longer closes.
      expect.objectContaining({ sequence: 3, kind: 'link' }),
    ]);
  });

  it('reports the link a rewritten predecessor breaks', async () => {
    const { db, log } = await written();
    const row = db.rows('audit_events').find((one) => one.sequence === 3);
    db.seed('audit_events', { ...row, previous: GENESIS });

    const answer = await log.verify();

    expect(answer.breaks).toEqual([
      expect.objectContaining({ sequence: 3, kind: 'link' }),
      // And its own digest, because `previous` is inside what the digest covers.
      expect.objectContaining({ sequence: 3, kind: 'digest' }),
    ]);
  });

  it('says how many breaks and what the events below them still establish', async () => {
    const { db, log } = await written();
    const row = db.rows('audit_events').find((one) => one.sequence === 2);
    db.seed('audit_events', { ...row, body: { ...(row?.body as object), actor: 'x@example.com' } });

    const answer = await log.verify();

    expect(answer.means).toContain('1 break');
    expect(answer.means).toContain('below the first break');
  });

  it('reads the body rather than the indexed columns, so editing a column cannot fool a reader', async () => {
    // The columns beside `body` exist only so Postgres can filter. The digest covers the body, so a
    // row whose `actor` column was edited still verifies — and a verifier that trusted the column
    // would report the edited value as authentic.
    const { db, log } = await written();
    const row = db.rows('audit_events').find((one) => one.sequence === 2);
    db.seed('audit_events', { ...row, actor: 'not-in-the-body@example.com' });

    const page = await log.search({ before: 3 });
    const answer = await log.verify();

    expect(page.events[0]?.actor).toBe('dana@example.com');
    expect(answer.breaks).toEqual([]);
  });

  it('writes the sequence, the actor and the action as columns, so a search is an index read', async () => {
    const { db } = await written();
    const row = db.rows('audit_events').find((one) => one.sequence === 1);

    expect(row).toMatchObject({ actor: 'dana@example.com', action: 'attestation.record', outcome: 'performed' });
  });
});

// Retention removes a prefix of the log, and the whole point of a chained log is that a removed row is
// visible. So a trim declares where the log now begins, and these are about the reading that follows.
describe('the durable log, after retention trimmed a prefix', () => {
  async function trimmed(): Promise<{ db: FakePostgres; log: PostgresAuditLog }> {
    const db = fake();
    const log = new PostgresAuditLog(db);
    for (const id of ['a', 'b', 'c', 'd']) await log.append(event({ id }));

    const second = db.rows('audit_events').find((one) => one.sequence === 2);
    db.seed('audit_floor', {
      id: 1,
      sequence: 2,
      digest: second?.digest,
      trimmed_at: new Date('2026-08-04T00:00:00.000Z'),
      trimmed_by: 'priya@example.com',
    });
    for (const sequence of [1, 2]) db.drop('audit_events', { sequence });
    return { db, log };
  }

  it('verifies the surviving events instead of reporting the removal as a break', async () => {
    const { log } = await trimmed();

    const answer = await log.verify();

    expect(answer.breaks).toEqual([]);
    expect(answer.checked).toBe(2);
  });

  it('says where the log begins and who removed what came before, rather than implying it read the lot', async () => {
    const { log } = await trimmed();

    const answer = await log.verify();

    expect(answer.means).toContain('begins at event 3');
    expect(answer.means).toContain('priya@example.com');
    expect(answer.means).toContain('cannot be verified from here');
  });

  it('appends after the floor when the trim took every surviving event', async () => {
    const { db, log } = await trimmed();
    for (const sequence of [3, 4]) db.drop('audit_events', { sequence });
    db.seed('audit_floor', {
      id: 1,
      sequence: 4,
      digest: `sha256:${'a'.repeat(64)}`,
      trimmed_at: new Date('2026-08-04T00:00:00.000Z'),
      trimmed_by: 'priya@example.com',
    });

    // Not sequence 1 again. A log with two beginnings is one whose sequence says nothing, and every
    // reader of it — the pager, the verifier, the floor itself — assumes the number only goes up.
    const appended = await log.append(event({ id: 'e' }));

    expect(appended.sequence).toBe(5);
    expect(appended.previous).toBe(`sha256:${'a'.repeat(64)}`);
  });

  it('walks a prefix a failed trim left behind rather than skipping past it', async () => {
    // A floor written and the delete then failing is the safe direction: the events are still there,
    // and reading them from genesis reports them as sound — which they are.
    const db = fake();
    const log = new PostgresAuditLog(db);
    for (const id of ['a', 'b', 'c']) await log.append(event({ id }));
    const second = db.rows('audit_events').find((one) => one.sequence === 2);
    db.seed('audit_floor', {
      id: 1,
      sequence: 2,
      digest: second?.digest,
      trimmed_at: new Date('2026-08-04T00:00:00.000Z'),
      trimmed_by: 'priya@example.com',
    });

    const answer = await log.verify();

    expect(answer.checked).toBe(3);
    expect(answer.breaks).toEqual([]);
    expect(answer.means).not.toContain('begins at event');
  });
});

describe('what the digest is taken over', () => {
  it('leaves out the digest itself, since a value cannot cover itself', async () => {
    const log = new InMemoryAuditLog();
    const stored = await log.append(event());

    expect(Object.keys(bodyOf(stored))).not.toContain('digest');
    expect(digestOf(bodyOf(stored))).toBe(stored.digest);
  });

  it('omits an absent field rather than writing a null, so two shapes cannot share a digest', async () => {
    const log = new InMemoryAuditLog();
    const bare = await log.append(event({ id: 'bare' }));

    expect(Object.keys(bodyOf(bare))).not.toContain('reason');
    expect(Object.keys(bodyOf(bare))).not.toContain('target');
    expect(Object.keys(bodyOf(bare))).not.toContain('correlation');
  });

  it('is stable across a round trip through the store, which is what makes verification mean anything', async () => {
    const db = fake();
    const log = new PostgresAuditLog(db);
    const written = await log.append(
      event({ id: 'round-trip', target: { kind: 'scan', id: 's-1' }, correlation: 'run-2', reason: undefined })
    );

    const [read] = (await log.search()).events;

    expect(read).toBeDefined();
    expect(read?.digest).toBe(written.digest);
    expect(read == null ? undefined : digestOf(bodyOf(read))).toBe(written.digest);
  });

  it('covers an exported file’s digest, so the row cannot be edited to point at other bytes', async () => {
    // The one claim an export row makes that nothing else in this app can check later: the file is
    // gone, so if the digest beside it were outside the chain, changing it would leave no trace and
    // a recipient's mismatch would be unarguable in the wrong direction.
    const db = fake();
    const log = new PostgresAuditLog(db);
    const artefact = { kind: 'artefact', id: 'well-architected.csv', digest: 'sha256:abc' } as const;
    const written = await log.append(event({ id: 'exported', action: 'export.scan', target: artefact }));

    const [read] = (await log.search()).events;

    expect(read?.target).toEqual(artefact);
    expect(read == null ? undefined : digestOf(bodyOf(read))).toBe(written.digest);
    // And a row whose recorded digest was swapped verifies as altered rather than as itself.
    expect(digestOf(bodyOf({ ...written, target: { ...artefact, digest: 'sha256:def' } }))).not.toBe(written.digest);
  });
});
