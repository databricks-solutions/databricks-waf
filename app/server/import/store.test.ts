// The import store, held to behaving the same whichever implementation is under it.
//
// Most of the file runs both implementations through one set of assertions, because the property that
// matters is that they are indistinguishable: the adversarial suite for replay is only worth anything
// if the memory store refuses a replay too, and an in-memory store that quietly accepted one would
// make every replay test pass against the store nobody runs in production.
//
// The Postgres half additionally covers what only it can get wrong — a duplicate key arriving as a
// driver error rather than as a decision the app made, and a row that cannot be read back.

import { describe, expect, it } from 'vitest';
import { FakePostgres } from '../store/postgres-fake.js';
import { envelopeFrom, type Envelope } from './envelope.js';
import { envelope } from './envelope-fixture.js';
import {
  InMemoryEvidenceImportStore,
  PostgresEvidenceImportStore,
  ReplayedImportError,
  type EvidenceImportStore,
  type ImportedEvidence,
} from './store.js';
import { digestOf } from './trust.js';

/** The fake needs telling what the key is, since no statement says so. */
function fake(options: { failOn?: (text: string, call: number) => Error | undefined } = {}): FakePostgres {
  return new FakePostgres({ keys: { imported_evidence: ['digest'] }, ...options });
}

function sealed(overrides: Record<string, unknown> = {}): Envelope {
  const raw = envelope(overrides);
  return envelopeFrom({ ...raw, digest: digestOf(raw.probes) });
}

function imported(overrides: Partial<ImportedEvidence> = {}): ImportedEvidence {
  const held = sealed();
  return {
    digest: held.digest,
    generatedAt: new Date('2026-08-03T10:41:52Z'),
    importedAt: new Date('2026-08-03T12:00:00Z'),
    importedBy: 'importer@example.com',
    envelope: held,
    cautions: [{ reason: 'tier-not-run', message: 'The account tier was not run.' }],
    ...overrides,
  };
}

const implementations: readonly [string, () => EvidenceImportStore][] = [
  ['in memory', () => new InMemoryEvidenceImportStore()],
  ['on Postgres', () => new PostgresEvidenceImportStore({ db: fake() })],
];

describe.each(implementations)('an import store %s', (_name, build) => {
  it('holds what was imported, including what the app concluded about it', async () => {
    const store = build();
    await store.record(imported());

    const [held] = await store.all();
    expect(held.importedBy).toBe('importer@example.com');
    expect(held.generatedAt.toISOString()).toBe('2026-08-03T10:41:52.000Z');
    expect(held.envelope.probes).toHaveLength(1);
    // The cautions are the part a finding citing this evidence has to be able to show.
    expect(held.cautions.map((one) => one.reason)).toStrictEqual(['tier-not-run']);
  });

  it('refuses the same collection twice, and records nothing when it does', async () => {
    const store = build();
    await store.record(imported());

    await expect(store.record(imported())).rejects.toThrow(ReplayedImportError);
    expect(await store.all()).toHaveLength(1);
  });

  it('accepts a second collection of the same estate, since a new reading is a new digest', async () => {
    const store = build();
    await store.record(imported());
    await store.record(
      imported({
        digest: `sha256:${'e'.repeat(64)}`,
        importedAt: new Date('2026-08-04T12:00:00Z'),
      })
    );

    expect(await store.all()).toHaveLength(2);
  });

  it('returns the newest import first, because that is the one a reader is asking about', async () => {
    const store = build();
    await store.record(imported({ digest: `sha256:${'1'.repeat(64)}`, importedAt: new Date('2026-08-01T00:00:00Z') }));
    await store.record(imported({ digest: `sha256:${'2'.repeat(64)}`, importedAt: new Date('2026-08-05T00:00:00Z') }));
    await store.record(imported({ digest: `sha256:${'3'.repeat(64)}`, importedAt: new Date('2026-08-03T00:00:00Z') }));

    expect((await store.all()).map((one) => one.importedAt.toISOString())).toStrictEqual([
      '2026-08-05T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
    ]);
  });

  it('answers with the digests it holds, which is what the replay check reads', async () => {
    const store = build();
    expect(await store.digests()).toStrictEqual(new Set());

    const one = imported();
    await store.record(one);
    expect(await store.digests()).toStrictEqual(new Set([one.digest]));
  });

  it('summarises what it holds, in the order and with the counts the list shows', async () => {
    const store = build();
    await store.record(imported({ digest: `sha256:${'1'.repeat(64)}`, importedAt: new Date('2026-08-01T00:00:00Z') }));
    await store.record(imported({ digest: `sha256:${'2'.repeat(64)}`, importedAt: new Date('2026-08-05T00:00:00Z') }));

    const held = await store.summaries();
    expect(held.map((one) => one.importedAt.toISOString())).toStrictEqual([
      '2026-08-05T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
    ]);
    // Both implementations answer from the same `summarise`, so the counts are not implementation
    // detail: a store that summarised differently would show a different page.
    expect(held[0]?.summary.observed).toBe(1);
    expect(held[0]?.summary.requirements).toBeGreaterThan(0);
    expect(held[0]?.cautions.map((one) => one.reason)).toStrictEqual(['tier-not-run']);
  });

  it('shows the collection time the file states, not the one the column round-trips', async () => {
    // The envelope holds `generatedAt` as text because that is what the digest covers. Reading it
    // back off `generated_at` would show a normalised string that no longer matches the file, which
    // is the difference between quoting evidence and paraphrasing it.
    const store = build();
    await store.record(imported());

    const [held] = await store.summaries();
    expect(held?.summary.generatedAt).toBe(sealed().generatedAt);
  });
});

describe('an import store on Postgres', () => {
  it('says whether it is durable, since the UI has to warn when it is not', () => {
    expect(new PostgresEvidenceImportStore({ db: fake() }).durable).toBe(true);
    expect(new InMemoryEvidenceImportStore().durable).toBe(false);
  });

  it('turns a duplicate key from the driver into a replay, not an unexplained failure', async () => {
    // The race the check in `trust.ts` cannot win: two uploads of one file, both reading a digest set
    // that does not contain it. This is the path that refuses the second one.
    const db = fake();
    const store = new PostgresEvidenceImportStore({ db });
    await store.record(imported());

    // Straight to the insert, bypassing any read — which is what the losing side of the race does.
    await expect(store.record(imported())).rejects.toBeInstanceOf(ReplayedImportError);
  });

  it('degrades a failed read to nothing held, and says so through onError', async () => {
    const problems: string[] = [];
    const store = new PostgresEvidenceImportStore({
      db: fake({ failOn: (text) => (text.includes('select') ? new Error('connection reset') : undefined) }),
      onError: (operation) => problems.push(operation),
    });

    expect(await store.all()).toStrictEqual([]);
    expect(await store.digests()).toStrictEqual(new Set());
    expect(problems).toStrictEqual(['read imported evidence', 'read imported evidence digests']);
  });

  it('does not swallow a write failure that is not a duplicate key', async () => {
    // The distinction the fake exists to keep honest: a lost race is a decision the app explains, and
    // a broken connection is not something to report as a replay.
    const store = new PostgresEvidenceImportStore({
      db: fake({ failOn: (text) => (text.includes('insert') ? new Error('connection reset') : undefined) }),
    });

    await expect(store.record(imported())).rejects.toThrow('connection reset');
  });

  it('draws the list without reading a single envelope', async () => {
    // The point of row 85. `body` is the only out-of-line column in this table, so naming it in the
    // list read is what made the read cost the size of the collections rather than their number.
    const db = fake();
    const store = new PostgresEvidenceImportStore({ db });
    await store.record(imported());
    db.statements.length = 0;

    await store.summaries();

    const reads = db.statements.filter((text) => text.includes('select'));
    expect(reads).toHaveLength(1);
    expect(reads[0]).not.toContain('body');
    expect(reads[0]).toContain('summary');
  });

  it('summarises a row written before the column existed, and writes the answer back', async () => {
    // The rows an upgrade inherits. They cannot be summarised in SQL without stating what a summary
    // counts a second time, so they are recomputed from their bodies — once each, because the answer
    // is stored. A store that recomputed on every read would leave the old rows permanently expensive.
    const db = fake();
    const store = new PostgresEvidenceImportStore({ db });
    const legacy = imported();
    await store.record(legacy);
    await db.query(`update ${db.schema}.imported_evidence set summary = null where digest = $1`, [legacy.digest]);

    const [first] = await store.summaries();
    expect(first?.summary.observed).toBe(1);
    expect(first?.summary.generatedAt).toBe(sealed().generatedAt);

    // Repaired, so the second call is the cheap read and nothing fetches a body.
    db.statements.length = 0;
    const [again] = await store.summaries();
    expect(again?.summary.observed).toBe(1);
    expect(db.statements.filter((text) => text.includes('body'))).toStrictEqual([]);
  });

  it('still shows a legacy row when the repair cannot be written, since the summary is right either way', async () => {
    const problems: string[] = [];
    const db = fake({ failOn: (text) => (text.includes('update') ? new Error('read only') : undefined) });
    const store = new PostgresEvidenceImportStore({ db, onError: (operation) => problems.push(operation) });
    const legacy = imported();
    await store.record(legacy);
    // Blanked through the fake's own state, since the update path is the one this test fails.
    for (const row of db.rows('imported_evidence')) Object.assign(row, { summary: null });

    const held = await store.summaries();
    expect(held).toHaveLength(1);
    expect(held[0]?.summary.observed).toBe(1);
    expect(problems).toStrictEqual(['summarise an import written before the summary column']);
  });

  it('degrades a failed summary read to nothing held, and says so through onError', async () => {
    const problems: string[] = [];
    const store = new PostgresEvidenceImportStore({
      db: fake({ failOn: (text) => (text.includes('select') ? new Error('connection reset') : undefined) }),
      onError: (operation) => problems.push(operation),
    });

    expect(await store.summaries()).toStrictEqual([]);
    expect(problems).toStrictEqual(['read imported evidence summaries']);
  });

  it('drops a row whose timestamps cannot be read rather than aging it unpredictably', async () => {
    const db = fake();
    await db.query(
      `insert into ${db.schema}.imported_evidence
         (digest, generated_at, imported_at, imported_by, body, cautions)
       values ($1, $2, $3, $4, $5, $6)`,
      [`sha256:${'f'.repeat(64)}`, 'not a date', 'not a date', 'importer@example.com', '{}', '[]']
    );

    expect(await new PostgresEvidenceImportStore({ db }).all()).toStrictEqual([]);
  });
});
