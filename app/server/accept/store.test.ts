import { describe, expect, it } from 'vitest';
import { FakePostgres } from '../store/postgres-fake.js';
import { PostgresRiskStore } from './postgres-store.js';
import { revoked, type AcceptedRisk } from './risk.js';
import {
  AlreadyAcceptedError,
  AlreadyRevokedError,
  InMemoryRiskStore,
  RisksUnreadableError,
  type RiskStore,
} from './store.js';

const RECORDED = new Date('2026-04-10T09:00:00.000Z');
const EFFECTIVE = RECORDED;
const EXPIRES = new Date('2026-06-01T00:00:00.000Z');
const ENDED = new Date('2026-04-20T09:00:00.000Z');

function risk(over: Partial<AcceptedRisk> = {}): AcceptedRisk {
  return {
    id: 'risk-1',
    controlId: 'GOV-04',
    ordinal: 1,
    reason: 'The review is manual until the platform team finishes the rota tooling next quarter.',
    compensatingControl: 'The two workspaces are read-only outside the platform group, checked weekly.',
    residual: 'low',
    owner: 'platform-engineering',
    effectiveFrom: EFFECTIVE,
    expiresAt: EXPIRES,
    recordedBy: 'ana@example.com',
    recordedAt: RECORDED,
    definitionId: 'def-1',
    ...over,
  };
}

/**
 * The one-at-a-time constraint, declared because nothing in an insert says a table has one.
 *
 * Without it the fake would accept two first acceptances of one requirement, and the store's translation
 * of that collision would be code no test reaches.
 *
 * Two of them, because the schema declares two: one per assessment, and one over the rows that name no
 * assessment. While this fixture declared a single tuple it asserted a constraint the schema had stopped
 * having — `42c` added the nullable `definition_id` to the index and took Postgres's nulls-are-distinct
 * default, which for a row with no assessment removes the constraint rather than narrowing it, and this
 * fake skipped any constraint with a null in it. So both sides agreed that two unscoped acceptances
 * collide, and neither was right. Every fixture below carries a `definitionId`, so the case with no
 * protection was also the case no test named; the unscoped race further down is that case.
 */
const UNIQUE = {
  accepted_risks: [
    {
      columns: ['definition_id', 'control_id', 'ordinal', 'revision'],
      when: (row: Readonly<Record<string, unknown>>): boolean => row.definition_id != null,
      name: 'accepted_risks_at_position_scoped',
    },
    {
      columns: ['control_id', 'ordinal', 'revision'],
      when: (row: Readonly<Record<string, unknown>>): boolean => row.definition_id == null,
      name: 'accepted_risks_at_position_unscoped',
    },
  ],
} as const;

function ended(one: AcceptedRisk = risk()): AcceptedRisk {
  return revoked(one, 'raj@example.com', 'The read-only grant was removed in the March change.', ENDED);
}

function postgres(): { store: RiskStore; db: FakePostgres; errors: string[] } {
  const db = new FakePostgres({ keys: { accepted_risks: ['id', 'revision'] }, unique: UNIQUE });
  const errors: string[] = [];
  const store = new PostgresRiskStore({ db, onError: (operation) => errors.push(operation) });
  return { store, db, errors };
}

/*
 * Both implementations through the same tests, for the reason the validation store gives: the in-memory
 * one is what an install without a database runs on, and a difference between the two only shows up in
 * the configuration nobody tests in.
 */
const implementations: readonly [string, () => RiskStore][] = [
  ['in memory', (): RiskStore => new InMemoryRiskStore()],
  ['in postgres', (): RiskStore => postgres().store],
];

describe.each(implementations)('keeping accepted risks %s', (_name, open) => {
  it('reads back an acceptance, dates and all', async () => {
    const store = open();
    await store.record(risk());

    const [read] = await store.for('GOV-04');
    expect(read).toMatchObject({ id: 'risk-1', owner: 'platform-engineering', residual: 'low' });
    expect(read?.effectiveFrom).toEqual(EFFECTIVE);
    expect(read?.expiresAt).toEqual(EXPIRES);
    expect(read?.compensatingControl).toContain('read-only');
    expect(read?.revoked).toBeUndefined();
  });

  it('has nothing to say about a requirement nobody has accepted', async () => {
    expect(await open().for('SEC-01')).toEqual([]);
  });

  it('keeps one requirement’s acceptances apart from another’s', async () => {
    const store = open();
    await store.record(risk());
    await store.record(risk({ id: 'risk-2', controlId: 'SEC-01' }));

    expect((await store.for('GOV-04')).map((one) => one.id)).toEqual(['risk-1']);
    expect((await store.for('SEC-01')).map((one) => one.id)).toEqual(['risk-2']);
  });

  it('reads them newest first, because the last decision is the one in force', async () => {
    const store = open();
    await store.record(risk({ id: 'first', recordedAt: new Date('2026-01-01T09:00:00.000Z') }));
    await store.record(risk({ id: 'second', ordinal: 2, recordedAt: RECORDED }));

    expect((await store.for('GOV-04')).map((one) => one.id)).toEqual(['second', 'first']);
  });

  it('offers every acceptance for a register, across requirements', async () => {
    const store = open();
    await store.record(risk());
    await store.record(risk({ id: 'risk-2', controlId: 'SEC-01' }));

    expect((await store.all()).map((one) => one.id).sort()).toEqual(['risk-1', 'risk-2']);
  });

  it('reads back a revocation, with who ended it and why', async () => {
    const store = open();
    await store.record(risk());
    await store.revoke(ended());

    const [read] = await store.for('GOV-04');
    expect(read?.revoked).toMatchObject({ by: 'raj@example.com' });
    expect(read?.revoked?.at).toEqual(ENDED);
    expect(read?.revoked?.reason).toContain('read-only grant');
  });

  it('keeps the revoked reading rather than both, so a requirement shows one acceptance not two', async () => {
    const store = open();
    await store.record(risk());
    await store.revoke(ended());

    expect(await store.for('GOV-04')).toHaveLength(1);
  });

  it('keeps a renewal as its own record naming the one it replaced', async () => {
    const store = open();
    await store.record(risk());
    await store.record(
      risk({
        id: 'risk-2',
        ordinal: 2,
        recordedAt: ENDED,
        supersedes: 'risk-1',
        expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      })
    );

    const read = await store.for('GOV-04');
    // Both, because how long the exposure has been carried is the thing a renewal would otherwise hide.
    expect(read.map((one) => one.id)).toEqual(['risk-2', 'risk-1']);
    expect(read[0]?.supersedes).toBe('risk-1');
  });

  it('refuses a second first acceptance of one requirement, so a race cannot leave two in force', async () => {
    // Both writers read nothing standing and both compose the first acceptance of the requirement. The
    // store refusing the second is what turns two exceptions with two owners into a message its author
    // can act on — the rule `riskFrom` checks before the write, held again at the write.
    const store = open();
    await store.record(risk({ id: 'theirs' }));

    await expect(store.record(risk({ id: 'mine' }))).rejects.toThrow(AlreadyAcceptedError);
    expect((await store.for('GOV-04')).map((one) => one.id)).toEqual(['theirs']);
  });

  it('refuses a second first acceptance when neither names an assessment, which is what a fresh install writes', async () => {
    // The same race as above with the assessment absent, and for five merges it was the case with nothing
    // refusing it: the unique index named a nullable `definition_id` without `nulls not distinct`, so two
    // rows that are null there collided with nothing. An install with no assessment defined writes every
    // record this way, which is what a fresh install is, so the protection was missing where the rows are.
    const store = open();
    await store.record(risk({ id: 'theirs', definitionId: undefined }));

    await expect(store.record(risk({ id: 'mine', definitionId: undefined }))).rejects.toThrow(AlreadyAcceptedError);
    expect((await store.for('GOV-04', null)).map((one) => one.id)).toEqual(['theirs']);
  });

  it('lets two assessments accept the same requirement, and does not return one from the other', async () => {
    const store = open();
    await store.record(risk({ id: 'under-a', definitionId: 'def-a' }));
    await store.record(risk({ id: 'under-b', definitionId: 'def-b' }));

    expect((await store.for('GOV-04', 'def-a')).map((one) => one.id)).toEqual(['under-a']);
    expect((await store.for('GOV-04', 'def-b')).map((one) => one.id)).toEqual(['under-b']);
    expect((await store.all('def-a')).map((one) => one.id)).toEqual(['under-a']);
    expect((await store.all(null)).map((one) => one.id)).toEqual([]);
  });

  it('allows the same acceptance to be written again, so a retry after an unreported write is safe', async () => {
    const store = open();
    await store.record(risk());

    // Same id, same ordinal: this is the caller repeating itself rather than a second acceptance, and the
    // key refuses it in Postgres while the in-memory store overwrites the row with itself. Either way one
    // acceptance is on record, which is what a caller retrying an insert it never heard back from needs.
    await store.record(risk()).catch(() => undefined);

    expect(await store.for('GOV-04')).toHaveLength(1);
  });

  it('refuses a second revocation, naming the acceptance rather than the constraint', async () => {
    const store = open();
    await store.record(risk());
    await store.revoke(ended());

    await expect(store.revoke(ended())).rejects.toThrow(AlreadyRevokedError);
  });

  it('leaves the first revocation standing when a second is refused', async () => {
    const store = open();
    await store.record(risk());
    await store.revoke(ended());

    const second = { ...risk(), revoked: { by: 'sam@example.com', at: ENDED, reason: 'A different reason entirely.' } };
    await expect(store.revoke(second)).rejects.toThrow(AlreadyRevokedError);

    const [read] = await store.for('GOV-04');
    expect(read?.revoked?.by).toBe('raj@example.com');
  });
});

describe('accepted risks in postgres', () => {
  it('writes two rows for one acceptance, the second being the revocation', async () => {
    const { store, db } = postgres();
    await store.record(risk());
    await store.revoke(ended());

    const rows = db.rows('accepted_risks');
    expect(rows.map((row) => row.revision)).toEqual([0, 1]);
    expect(rows.map((row) => row.revoked)).toEqual([false, true]);
    expect(rows.every((row) => row.id === 'risk-1')).toBe(true);
  });

  it('copies the columns a register and a finding read by, so neither has to parse the body', async () => {
    const { store, db } = postgres();
    await store.record(risk());

    const [row] = db.rows('accepted_risks');
    expect(row).toMatchObject({ control_id: 'GOV-04', owner: 'platform-engineering', residual: 'low' });
    expect(row?.expires_at).toEqual(EXPIRES);
    expect(row?.recorded_at).toEqual(RECORDED);
  });

  it('digests each row, so a body edited in the database is detectable', async () => {
    const { store, db } = postgres();
    await store.record(risk());

    const [row] = db.rows('accepted_risks');
    expect(row?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('raises a failed read rather than answering as a requirement nobody has accepted', async () => {
    // The one place this store differs from every other one here, and the difference is the record: a
    // caller told "nothing is accepted" by a broken read writes a second acceptance over a standing one.
    const db = new FakePostgres({
      keys: { accepted_risks: ['id', 'revision'] },
      unique: UNIQUE,
      failOn: (text) => (text.startsWith('select') ? new Error('connection reset') : undefined),
    });
    const errors: string[] = [];
    const store = new PostgresRiskStore({ db, onError: (operation) => errors.push(operation) });

    await expect(store.for('GOV-04')).rejects.toThrow(RisksUnreadableError);
    await expect(store.all()).rejects.toThrow(RisksUnreadableError);
    // Reported as well as raised, so the failure is in the log whatever the caller does with it.
    expect(errors).toEqual(['read accepted risks for GOV-04', 'read accepted risks']);
  });

  it('raises a failed write rather than reporting it, because a lost acceptance is an unwatched exposure', async () => {
    const db = new FakePostgres({
      keys: { accepted_risks: ['id', 'revision'] },
      unique: UNIQUE,
      failOn: (text) => (text.startsWith('insert') ? new Error('disk full') : undefined),
    });
    const store = new PostgresRiskStore({ db });

    await expect(store.record(risk())).rejects.toThrow('disk full');
  });

  it('reports a repeated id as itself, since nothing legitimate produces one', async () => {
    const { store } = postgres();
    await store.record(risk());

    await expect(store.record(risk())).rejects.toThrow(/duplicate key/);
  });

  it('counts a row it cannot read rather than throwing, and leaves the acceptance standing', async () => {
    const { store, db, errors } = postgres();
    await store.record(risk());
    db.seed('accepted_risks', {
      id: 'risk-1',
      revision: 1,
      control_id: 'GOV-04',
      owner: 'platform-engineering',
      residual: 'low',
      expires_at: EXPIRES,
      recorded_at: RECORDED,
      revoked: true,
      body: { id: 'risk-1', controlId: 'GOV-04' },
      digest: 'x',
    });

    const read = await store.for('GOV-04');
    expect(read).toHaveLength(1);
    expect(read[0]?.revoked).toBeUndefined();
    expect(errors).toEqual(['read accepted risks for GOV-04']);
  });

  it('drops a revoked row whose date will not parse rather than reading it as still standing', async () => {
    // The direction that matters: read as standing, a finding stays parked on an acceptance somebody
    // has already ended. Dropped, the requirement is back on the queue and the log says a row could
    // not be read.
    const { store, db, errors } = postgres();
    const one = ended();
    db.seed('accepted_risks', {
      id: 'risk-1',
      revision: 1,
      control_id: 'GOV-04',
      owner: 'platform-engineering',
      residual: 'low',
      expires_at: EXPIRES,
      recorded_at: RECORDED,
      revoked: true,
      body: { ...one, revoked: { ...one.revoked, at: 'the second Tuesday' } },
      digest: 'x',
    });

    expect(await store.for('GOV-04')).toEqual([]);
    expect(errors).toEqual(['read accepted risks for GOV-04']);
  });
});
