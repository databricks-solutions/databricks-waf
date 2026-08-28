import { describe, expect, it } from 'vitest';
import { FakePostgres } from '../store/postgres-fake.js';
import { PostgresApplicabilityStore } from './postgres-store.js';
import { revoked, type ApplicabilityDecision } from './applicability.js';
import {
  AlreadyDecidedError,
  AlreadyRevokedError,
  DecisionIdReusedError,
  DecisionsUnreadableError,
  InMemoryApplicabilityStore,
  type ApplicabilityStore,
} from './store.js';

const RECORDED = new Date('2026-04-10T09:00:00.000Z');
const EFFECTIVE = RECORDED;
const EXPIRES = new Date('2026-10-01T00:00:00.000Z');
const ENDED = new Date('2026-04-20T09:00:00.000Z');

function decision(over: Partial<ApplicabilityDecision> = {}): ApplicabilityDecision {
  return {
    id: 'decision-1',
    controlId: 'GOV-04',
    lever: 'not-applicable',
    ordinal: 1,
    reason: 'This estate runs no external sharing, so the requirement is about a thing it does not have.',
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
 * Two of them, mirroring the pair the schema declares: one per assessment, and one over the rows that
 * name none. A single tuple over a nullable `definition_id` constrains nothing when the column is null,
 * which is the defect the fuller note in `accept/store.test.ts` describes.
 */
const UNIQUE = {
  applicability_decisions: [
    {
      columns: ['definition_id', 'control_id', 'ordinal', 'revision'],
      when: (row: Readonly<Record<string, unknown>>): boolean => row.definition_id != null,
      name: 'applicability_decisions_at_position_scoped',
    },
    {
      columns: ['control_id', 'ordinal', 'revision'],
      when: (row: Readonly<Record<string, unknown>>): boolean => row.definition_id == null,
      name: 'applicability_decisions_at_position_unscoped',
    },
  ],
} as const;

function ended(one: ApplicabilityDecision = decision()): ApplicabilityDecision {
  return revoked(one, 'raj@example.com', 'The estate took on external sharing in the March change.', ENDED);
}

function postgres(): { store: ApplicabilityStore; db: FakePostgres; errors: string[] } {
  const db = new FakePostgres({ keys: { applicability_decisions: ['id', 'revision'] }, unique: UNIQUE });
  const errors: string[] = [];
  const store = new PostgresApplicabilityStore({ db, onError: (operation) => errors.push(operation) });
  return { store, db, errors };
}

/*
 * Both implementations through the same tests: the in-memory one is what tests run on, and a difference
 * between the two only shows up in the configuration nobody tests in.
 */
const implementations: readonly [string, () => ApplicabilityStore][] = [
  ['in memory', (): ApplicabilityStore => new InMemoryApplicabilityStore()],
  ['in postgres', (): ApplicabilityStore => postgres().store],
];

describe.each(implementations)('keeping applicability decisions %s', (_name, open) => {
  it('reads back a decision, lever and dates and all', async () => {
    const store = open();
    await store.record(decision());

    const [read] = await store.for('GOV-04');
    expect(read).toMatchObject({ id: 'decision-1', owner: 'platform-engineering', lever: 'not-applicable' });
    expect(read?.effectiveFrom).toEqual(EFFECTIVE);
    expect(read?.expiresAt).toEqual(EXPIRES);
    expect(read?.revoked).toBeUndefined();
  });

  it('has nothing to say about a requirement nobody has excluded', async () => {
    expect(await open().for('SEC-01')).toEqual([]);
  });

  it('keeps one requirement’s decisions apart from another’s', async () => {
    const store = open();
    await store.record(decision());
    await store.record(decision({ id: 'decision-2', controlId: 'SEC-01', lever: 'disabled' }));

    expect((await store.for('GOV-04')).map((one) => one.id)).toEqual(['decision-1']);
    expect((await store.for('SEC-01')).map((one) => one.id)).toEqual(['decision-2']);
  });

  it('reads them newest first', async () => {
    const store = open();
    await store.record(decision({ id: 'first', recordedAt: new Date('2026-01-01T09:00:00.000Z') }));
    await store.record(decision({ id: 'second', ordinal: 2, recordedAt: RECORDED }));

    expect((await store.for('GOV-04')).map((one) => one.id)).toEqual(['second', 'first']);
  });

  it('offers every decision for a register, across requirements', async () => {
    const store = open();
    await store.record(decision());
    await store.record(decision({ id: 'decision-2', controlId: 'SEC-01' }));

    expect((await store.all()).map((one) => one.id).sort()).toEqual(['decision-1', 'decision-2']);
  });

  it('reads back a revocation, with who ended it and why', async () => {
    const store = open();
    await store.record(decision());
    await store.revoke(ended());

    const [read] = await store.for('GOV-04');
    expect(read?.revoked).toMatchObject({ by: 'raj@example.com' });
    expect(read?.revoked?.at).toEqual(ENDED);
    expect(read?.revoked?.reason).toContain('external sharing');
  });

  it('keeps the revoked reading rather than both, so a requirement shows one decision not two', async () => {
    const store = open();
    await store.record(decision());
    await store.revoke(ended());

    expect(await store.for('GOV-04')).toHaveLength(1);
  });

  it('keeps a renewal as its own record naming the one it replaced', async () => {
    const store = open();
    await store.record(decision());
    await store.record(
      decision({
        id: 'decision-2',
        ordinal: 2,
        recordedAt: ENDED,
        supersedes: 'decision-1',
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
      })
    );

    const read = await store.for('GOV-04');
    expect(read.map((one) => one.id)).toEqual(['decision-2', 'decision-1']);
    expect(read[0]?.supersedes).toBe('decision-1');
  });

  it('refuses a second first decision on one requirement, so a race cannot leave two in force', async () => {
    const store = open();
    await store.record(decision({ id: 'theirs' }));

    await expect(store.record(decision({ id: 'mine' }))).rejects.toThrow(AlreadyDecidedError);
    expect((await store.for('GOV-04')).map((one) => one.id)).toEqual(['theirs']);
  });

  it('refuses a second first decision when neither names an assessment, which is what a fresh install writes', async () => {
    // The case `42c` left unprotected and no test named: both rows null in `definition_id`, an index that
    // treated those nulls as distinct, and so two standing exclusions of one requirement with two owners.
    const store = open();
    await store.record(decision({ id: 'theirs', definitionId: undefined }));

    await expect(store.record(decision({ id: 'mine', definitionId: undefined }))).rejects.toThrow(
      AlreadyDecidedError
    );
    expect((await store.for('GOV-04', null)).map((one) => one.id)).toEqual(['theirs']);
  });

  it('lets two assessments exclude the same requirement, and does not return one from the other', async () => {
    const store = open();
    await store.record(decision({ id: 'under-a', definitionId: 'def-a' }));
    await store.record(decision({ id: 'under-b', definitionId: 'def-b' }));

    expect((await store.for('GOV-04', 'def-a')).map((one) => one.id)).toEqual(['under-a']);
    expect((await store.for('GOV-04', 'def-b')).map((one) => one.id)).toEqual(['under-b']);
    expect((await store.all('def-a')).map((one) => one.id)).toEqual(['under-a']);
  });

  it('refuses a second write under an id already on record, rather than replacing it', async () => {
    // The two stores disagreed here: Postgres refused on its primary key and the in-memory one replaced
    // the record. The test that was meant to hold them together wrote `.catch(() => undefined)`, so it
    // passed for both and asserted the opposite of its own name for one of them.
    const store = open();
    await store.record(decision());

    await expect(store.record(decision({ owner: 'someone-else', reason: 'A different reason entirely.' })))
      .rejects.toThrow(DecisionIdReusedError);

    // And the first record is the one that survived, with its own owner on it.
    const read = await store.for('GOV-04');
    expect(read).toHaveLength(1);
    expect(read[0]?.owner).toBe('platform-engineering');
  });

  it('refuses a second revocation, naming the decision rather than the constraint', async () => {
    const store = open();
    await store.record(decision());
    await store.revoke(ended());

    await expect(store.revoke(ended())).rejects.toThrow(AlreadyRevokedError);
  });

  it('leaves the first revocation standing when a second is refused', async () => {
    const store = open();
    await store.record(decision());
    await store.revoke(ended());

    const second = {
      ...decision(),
      revoked: { by: 'sam@example.com', at: ENDED, reason: 'A different reason entirely, written later.' },
    };
    await expect(store.revoke(second)).rejects.toThrow(AlreadyRevokedError);

    const [read] = await store.for('GOV-04');
    expect(read?.revoked?.by).toBe('raj@example.com');
  });
});

describe('applicability decisions in postgres', () => {
  it('writes two rows for one decision, the second being the revocation', async () => {
    const { store, db } = postgres();
    await store.record(decision());
    await store.revoke(ended());

    const rows = db.rows('applicability_decisions');
    expect(rows.map((row) => row.revision)).toEqual([0, 1]);
    expect(rows.map((row) => row.revoked)).toEqual([false, true]);
    expect(rows.every((row) => row.id === 'decision-1')).toBe(true);
  });

  it('copies the columns a register groups and reads by, so neither has to parse the body', async () => {
    const { store, db } = postgres();
    await store.record(decision());

    const [row] = db.rows('applicability_decisions');
    expect(row).toMatchObject({ control_id: 'GOV-04', owner: 'platform-engineering', lever: 'not-applicable' });
    expect(row?.expires_at).toEqual(EXPIRES);
    expect(row?.recorded_at).toEqual(RECORDED);
  });

  it('digests each row, so a body edited in the database is detectable', async () => {
    const { store, db } = postgres();
    await store.record(decision());

    const [row] = db.rows('applicability_decisions');
    expect(row?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('raises a failed read rather than answering as a requirement nobody has excluded', async () => {
    const db = new FakePostgres({
      keys: { applicability_decisions: ['id', 'revision'] },
      unique: UNIQUE,
      failOn: (text) => (text.startsWith('select') ? new Error('connection reset') : undefined),
    });
    const errors: string[] = [];
    const store = new PostgresApplicabilityStore({ db, onError: (operation) => errors.push(operation) });

    await expect(store.for('GOV-04')).rejects.toThrow(DecisionsUnreadableError);
    await expect(store.all()).rejects.toThrow(DecisionsUnreadableError);
    expect(errors).toEqual(['read applicability decisions for GOV-04', 'read applicability decisions']);
  });

  it('raises a failed write rather than reporting it, because a lost decision moves a score silently', async () => {
    const db = new FakePostgres({
      keys: { applicability_decisions: ['id', 'revision'] },
      unique: UNIQUE,
      failOn: (text) => (text.startsWith('insert') ? new Error('disk full') : undefined),
    });
    const store = new PostgresApplicabilityStore({ db });

    await expect(store.record(decision())).rejects.toThrow('disk full');
  });

  it('names a repeated id rather than passing the driver’s message up', async () => {
    // It raised the raw violation, which reaches a reader as a stack trace about a constraint. The shared
    // test above holds both stores to the named refusal; this one is about which sentence Postgres gives.
    const { store } = postgres();
    await store.record(decision());

    await expect(store.record(decision())).rejects.toThrow(DecisionIdReusedError);
    await expect(store.record(decision())).rejects.toThrow(/minted per request/);
  });

  it('counts a row it cannot read rather than throwing, and leaves the decision standing', async () => {
    const { store, db, errors } = postgres();
    await store.record(decision());
    db.seed('applicability_decisions', {
      id: 'decision-1',
      revision: 1,
      control_id: 'GOV-04',
      lever: 'not-applicable',
      owner: 'platform-engineering',
      expires_at: EXPIRES,
      recorded_at: RECORDED,
      revoked: true,
      body: { id: 'decision-1', controlId: 'GOV-04' },
      digest: 'x',
    });

    const read = await store.for('GOV-04');
    expect(read).toHaveLength(1);
    expect(read[0]?.revoked).toBeUndefined();
    expect(errors).toEqual(['read applicability decisions for GOV-04']);
  });

  it('drops a revoked row whose date will not parse rather than reading it as still standing', async () => {
    const { store, db } = postgres();
    const one = ended();
    db.seed('applicability_decisions', {
      id: 'decision-1',
      revision: 1,
      control_id: 'GOV-04',
      lever: 'not-applicable',
      owner: 'platform-engineering',
      expires_at: EXPIRES,
      recorded_at: RECORDED,
      revoked: true,
      body: { ...one, revoked: { ...one.revoked, at: 'the second Tuesday' } },
      digest: 'x',
    });

    expect(await store.for('GOV-04')).toEqual([]);
  });
});
