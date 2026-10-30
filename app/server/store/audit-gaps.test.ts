// The durable markers for audit events that could not be written, against the strict Postgres fake
// and the in-memory twin.
//
// Both implementations run the tests that are about the markers rather than about SQL, for the reason
// the audit log's tests do: the in-memory one is what a demo install gets, and a demo that behaves
// differently from the product is a demo of something else. The tests that need two app instances over
// one database run against the Postgres one alone, because the array has no second instance to share
// with.

import { describe, expect, it } from 'vitest';
import { FakePostgres } from './postgres-fake.js';
import { InMemoryAuditGapLog, PostgresAuditGapLog, type AuditGap, type AuditGapLog } from './audit-gaps.js';

/** The fake, told what the real table's one unique constraint besides its key is. */
function fake(): FakePostgres {
  return new FakePostgres({
    unique: { audit_gaps: [{ columns: ['gap_id'], name: 'audit_gaps_one_acknowledgement' }] },
  });
}

function gap(one: Partial<AuditGap> = {}): AuditGap {
  return {
    id: `gap-${String(Math.random()).slice(2)}`,
    at: new Date('2026-08-04T09:00:00.000Z'),
    actor: 'dana@example.com',
    action: 'attestation.record',
    outcome: 'performed',
    target: { kind: 'control', id: 'OE-02-04' },
    cause: 'AuditAppendError',
    ...one,
  };
}

const ACKNOWLEDGED_AT = new Date('2026-08-05T10:00:00.000Z');

const implementations: readonly [string, () => AuditGapLog][] = [
  ['the durable gap log', () => new PostgresAuditGapLog(fake())],
  ['the in-memory gap log', () => new InMemoryAuditGapLog()],
];

describe.each(implementations)('%s', (_name, open) => {
  it('starts with nothing to acknowledge, so an empty list means nothing was lost', async () => {
    expect(await open().unacknowledged()).toEqual({ gaps: [], truncated: false });
  });

  it('reads a marker back with the time as a time and the target it was recorded against', async () => {
    const gaps = open();
    await gaps.record(gap({ id: 'gap-1' }));

    const { gaps: found } = await gaps.unacknowledged();

    expect(found).toHaveLength(1);
    expect(found[0]).toEqual(gap({ id: 'gap-1' }));
    expect(found[0]?.at).toBeInstanceOf(Date);
  });

  it('reads a marker with no target without inventing one', async () => {
    const gaps = open();
    const { target: _target, ...bare } = gap({ id: 'gap-bare' });
    await gaps.record(bare);

    const [found] = (await gaps.unacknowledged()).gaps;

    expect(found).toBeDefined();
    expect(found).not.toHaveProperty('target');
  });

  it('lists the newest first, which is the one somebody is looking for', async () => {
    const gaps = open();
    await gaps.record(gap({ id: 'older', at: new Date('2026-08-01T00:00:00.000Z') }));
    await gaps.record(gap({ id: 'newer', at: new Date('2026-08-03T00:00:00.000Z') }));

    expect((await gaps.unacknowledged()).gaps.map((one) => one.id)).toEqual(['newer', 'older']);
  });

  it('records one marker for an event however many times it is reported', async () => {
    // The marker is keyed on the id of the event that was lost, so a retry that follows a write which
    // landed and failed to say so is the same marker rather than a second gap.
    const gaps = open();
    await gaps.record(gap({ id: 'gap-1' }));
    await gaps.record(gap({ id: 'gap-1' }));

    expect((await gaps.unacknowledged()).gaps).toHaveLength(1);
  });

  it('stops listing a marker once it is acknowledged, and says who acknowledged it', async () => {
    const gaps = open();
    await gaps.record(gap({ id: 'gap-1' }));
    await gaps.record(gap({ id: 'gap-2' }));

    const done = await gaps.acknowledge('gap-1', 'priya@example.com', ACKNOWLEDGED_AT);

    expect(done).toMatchObject({ by: 'priya@example.com', at: ACKNOWLEDGED_AT, already: false });
    expect(done?.gap.id).toBe('gap-1');
    expect((await gaps.unacknowledged()).gaps.map((one) => one.id)).toEqual(['gap-2']);
  });

  it('answers an acknowledgement that was already made with the first one, and writes no second', async () => {
    const gaps = open();
    await gaps.record(gap({ id: 'gap-1' }));
    await gaps.acknowledge('gap-1', 'priya@example.com', ACKNOWLEDGED_AT);

    const again = await gaps.acknowledge('gap-1', 'someone-else@example.com', new Date('2026-08-06T00:00:00.000Z'));

    // The first acknowledgement stands, so a second person clicking the same button does not rewrite
    // who dealt with it and when.
    expect(again).toMatchObject({ by: 'priya@example.com', at: ACKNOWLEDGED_AT, already: true });
  });

  it('does not acknowledge what was never recorded', async () => {
    const gaps = open();
    await gaps.record(gap({ id: 'gap-1' }));

    expect(await gaps.acknowledge('no-such-gap', 'priya@example.com', ACKNOWLEDGED_AT)).toBeUndefined();
    expect((await gaps.unacknowledged()).gaps).toHaveLength(1);
  });

  it('does not take an acknowledgement for a marker, so one cannot be acknowledged in turn', async () => {
    const gaps = open();
    await gaps.record(gap({ id: 'gap-1' }));
    await gaps.acknowledge('gap-1', 'priya@example.com', ACKNOWLEDGED_AT);

    expect(await gaps.acknowledge('gap-1.acknowledged', 'priya@example.com', ACKNOWLEDGED_AT)).toBeUndefined();
  });
});

describe('the durable gap log', () => {
  it('says it survives a restart, and the in-memory one that it does not', () => {
    expect(new PostgresAuditGapLog(fake()).durable).toBe(true);
    expect(new InMemoryAuditGapLog().durable).toBe(false);
  });

  it('keeps a marker across a restart: a new log over the same database reports it', async () => {
    const db = fake();
    await new PostgresAuditGapLog(db).record(gap({ id: 'gap-1' }));

    const afterRestart = new PostgresAuditGapLog(db);

    expect((await afterRestart.unacknowledged()).gaps.map((one) => one.id)).toEqual(['gap-1']);
  });

  it('reports a marker one instance recorded from another instance over the same database', async () => {
    // Two replicas of the app share a database and nothing else. A gap one of them recorded has to be
    // on the page the other serves, or whether an auditor sees it depends on which replica answered.
    const db = fake();
    const first = new PostgresAuditGapLog(db);
    const second = new PostgresAuditGapLog(db);

    await first.record(gap({ id: 'from-first' }));

    expect((await second.unacknowledged()).gaps.map((one) => one.id)).toEqual(['from-first']);

    await second.acknowledge('from-first', 'priya@example.com', ACKNOWLEDGED_AT);

    expect((await first.unacknowledged()).gaps).toEqual([]);
  });

  it('adds a row to acknowledge and never edits or removes the marker', async () => {
    const db = fake();
    const gaps = new PostgresAuditGapLog(db);
    await gaps.record(gap({ id: 'gap-1' }));
    const before = db.rows('audit_gaps')[0];

    await gaps.acknowledge('gap-1', 'priya@example.com', ACKNOWLEDGED_AT);

    const rows = db.rows('audit_gaps');
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === 'gap-1')).toEqual(before);
    expect(db.statements.some((sql) => /^(update|delete)\b/i.test(sql))).toBe(false);
  });

  it('holds identifiers and a cause class and nothing else', async () => {
    const db = fake();
    await new PostgresAuditGapLog(db).record(gap({ id: 'gap-1' }));

    // The column set, so a field added to the marker is a decision rather than a drive-by: an audit
    // row is read by more people than any other and outlives the incident.
    expect(Object.keys(db.rows('audit_gaps')[0] ?? {}).sort()).toEqual([
      'action',
      'actor',
      'at',
      'cause',
      'gap_id',
      'id',
      'kind',
      'outcome',
      'target_id',
      'target_kind',
    ]);
  });

  it('says when the list was cut short, rather than presenting a page as the whole', async () => {
    const gaps = new PostgresAuditGapLog(fake(), { limit: 2 });
    for (const id of ['a', 'b', 'c']) {
      await gaps.record(gap({ id, at: new Date(`2026-08-0${id === 'a' ? 1 : id === 'b' ? 2 : 3}T00:00:00.000Z`) }));
    }

    const { gaps: found, truncated } = await gaps.unacknowledged();

    expect(found.map((one) => one.id)).toEqual(['c', 'b']);
    expect(truncated).toBe(true);
  });

  it('propagates a failure to read, so a page cannot report "nothing lost" from a broken read', async () => {
    const broken = new PostgresAuditGapLog(
      new FakePostgres({ failOn: (sql) => (sql.startsWith('select') ? new Error('the database is unreachable') : undefined) })
    );

    await expect(broken.unacknowledged()).rejects.toThrow('unreachable');
  });
});
