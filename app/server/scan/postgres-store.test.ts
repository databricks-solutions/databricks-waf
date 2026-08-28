import { describe, expect, it, vi } from 'vitest';
import { PostgresScanStore } from './postgres-store.js';
import { chooseStore, DEMO_ENV } from './store-choice.js';
import { CollectionScheduler } from './scheduler.js';
import { FakePostgres } from '../store/postgres-fake.js';
import { ENDPOINT_ENV } from '../store/postgres.js';
import { digestOf } from '../records/digest.js';
import { verifyRecords } from '../records/verify.js';
import type { Scan } from './scan.js';

const ENDPOINT = 'projects/p/branches/b/endpoints/primary';

function scan(id: string, startedAt: string, overall?: number): Scan {
  const started = new Date(startedAt);
  return {
    id,
    startedAt: started,
    finishedAt: new Date(started.getTime() + 60_000),
    state: 'complete',
    stamp: {
      catalogueVersion: '3',
      catalogueFingerprint: 'abc',
      executionMode: 'on-behalf-of-user',
      actor: 'someone@example.com',
      scope: { description: 'the account' },
      lookbackDays: 30,
    },
    score: {
      ...(overall != null ? { overall } : {}),
      pillars: [],
      counts: {
        pass: 0,
        fail: 0,
        partial: 0,
        unmeasurable: 0,
        'not-applicable': 0,
        'satisfied-by-architecture': 0,
      },
      scoredControls: 0,
      composition: { observed: 0, 'admin-collected': 0, attested: 0 },
      totalControls: 0,
    },
    findings: [],
    signals: [],
    estate: { assessed: [], excluded: [] },
    measurement: [],
    footprint: new CollectionScheduler().footprint(),
    spend: [],
  };
}

function store(options: { readonly db?: FakePostgres; readonly onError?: (op: string, error: unknown) => void } = {}) {
  const db = options.db ?? new FakePostgres();
  return { db, store: new PostgresScanStore({ db, ...(options.onError ? { onError: options.onError } : {}) }) };
}

describe('the Lakebase scan store', () => {
  it('stamps a saved run with the digest of the document it stored', async () => {
    const { db, store: scans } = store();
    await scans.save(scan('aaa', '2026-08-01T01:00:00.000Z', 0.62));

    const [row] = db.rows('scans');
    // Recomputed from the stored body, not from the object that was saved: the body is what a reader
    // hashes later, and the digest has to be a statement about that.
    expect(row?.digest).toBe(digestOf(row?.body));
    expect(await verifyRecords({ db })).toMatchObject({ intact: true });
  });

  it('keys a saved run to the assessment its stamp names', async () => {
    const { db, store: scans } = store();
    const one = scan('aaa', '2026-08-01T01:00:00.000Z', 0.62);
    await scans.save({ ...one, stamp: { ...one.stamp, definition: { id: 'def-1', version: 3, fingerprint: 'f' } } });

    expect(db.rows('scans')[0]?.definition_id).toBe('def-1');
  });

  it('leaves the key null on a run nobody asked an assessment for, rather than choosing one', async () => {
    // The half of the audit's requirement that survived ADR 0080. A direct run belongs to no
    // assessment, `ScanStamp` says so in as many words, and the column has to be able to say it too —
    // defaulting this to anything would make an unscoped run indistinguishable from a scoped one.
    const { db, store: scans } = store();
    await scans.save(scan('aaa', '2026-08-01T01:00:00.000Z', 0.62));

    expect(db.rows('scans')[0]?.definition_id).toBeNull();
  });

  it('does not return another assessment\'s scans', async () => {
    const { store: scans } = store();
    const underA = scan('scan-a', '2026-08-01T01:00:00.000Z');
    const underB = scan('scan-b', '2026-08-01T02:00:00.000Z');
    await scans.save({ ...underA, stamp: { ...underA.stamp, definition: { id: 'def-a', version: 1, fingerprint: 'f' } } });
    await scans.save({ ...underB, stamp: { ...underB.stamp, definition: { id: 'def-b', version: 1, fingerprint: 'g' } } });

    expect((await scans.latest('def-a'))?.id).toBe('scan-a');
    expect((await scans.latest('def-b'))?.id).toBe('scan-b');
    expect(await scans.get('scan-b', 'def-a')).toBeUndefined();
    expect(await scans.latest(null)).toBeUndefined();
    expect((await scans.history(20, 'def-a')).map((entry) => entry.id)).toEqual(['scan-a']);
  });

  it('re-keys a run it overwrote, so the column never describes the previous body', async () => {
    // A scan is saved when it starts and again when it finishes. The column is a handle on the body,
    // so the update has to carry it: the failure this catches is a finished run keyed to whatever the
    // starting one said, which is the same bug as the stale digest below and less visible.
    const { db, store: scans } = store();
    const one = scan('aaa', '2026-08-01T01:00:00.000Z');
    await scans.save({ ...one, stamp: { ...one.stamp, definition: { id: 'def-1', version: 3, fingerprint: 'f' } } });
    await scans.save({ ...one, stamp: { ...one.stamp, definition: { id: 'def-2', version: 1, fingerprint: 'g' } } });

    expect(db.rows('scans')[0]?.definition_id).toBe('def-2');
  });

  it('re-stamps a run it overwrote, so the digest never describes the previous body', async () => {
    // A scan is saved twice — once when it starts and once when it finishes — and the second write
    // updates the row. A digest left behind by the first would report the finished run as altered.
    const { db, store: scans } = store();
    await scans.save(scan('aaa', '2026-08-01T01:00:00.000Z'));
    await scans.save(scan('aaa', '2026-08-01T01:00:00.000Z', 0.62));

    expect(await verifyRecords({ db })).toMatchObject({ intact: true });
    expect(db.rows('scans')).toHaveLength(1);
  });

  it('reads back a scan it wrote, with its dates as dates', async () => {
    const { store: scans } = store();
    const written = scan('aaa', '2026-08-01T01:00:00.000Z', 0.62);

    await scans.save(written);
    const read = await scans.get('aaa');

    expect(read?.id).toBe('aaa');
    expect(read?.score.overall).toBe(0.62);
    expect(read?.startedAt).toBeInstanceOf(Date);
    expect(read?.startedAt.toISOString()).toBe('2026-08-01T01:00:00.000Z');
  });

  it('writes the summary and the scan in one statement, so a page can never advertise a scan it cannot open', async () => {
    // The volume store this replaces needed two writes and an ordering rule between them: the scan
    // first, then the index that advertised it, because a crash between them had to leave a
    // readable volume. One row makes the ordering unnecessary rather than merely observed.
    const { db, store: scans } = store();
    await scans.save(scan('aaa', '2026-08-01T01:00:00.000Z'));

    const writes = db.statements.filter((sql) => sql.startsWith('insert'));
    expect(writes).toHaveLength(1);
    expect(db.rows('scans')).toHaveLength(1);
  });

  it('orders history newest first without reading a single scan body', async () => {
    const { db, store: scans } = store();
    await scans.save(scan('older', '2026-07-01T00:00:00.000Z'));
    await scans.save(scan('newer', '2026-08-01T00:00:00.000Z'));
    await scans.save(scan('middle', '2026-07-15T00:00:00.000Z'));

    const history = await scans.history();

    expect(history.map((entry) => entry.id)).toEqual(['newer', 'middle', 'older']);
    // The summary column exists so that drawing the history page does not deserialise three
    // hundred-kilobyte documents. A query that selected `body` would defeat the reason for it.
    expect(db.statements.some((sql) => sql.startsWith('select summary from'))).toBe(true);
    expect(db.statements.some((sql) => sql.startsWith('select body from'))).toBe(false);
  });

  it('revives the summary dates, so the history page does not render Invalid Date', async () => {
    const { store: scans } = store();
    await scans.save(scan('aaa', '2026-08-01T01:00:00.000Z'));

    const [entry] = await scans.history();

    expect(entry?.startedAt).toBeInstanceOf(Date);
    expect(entry?.finishedAt).toBeInstanceOf(Date);
    expect(entry?.startedAt.toISOString()).toBe('2026-08-01T01:00:00.000Z');
  });

  it('carries the score range through the summary column, and does not invent one', async () => {
    // The claim the history page's verdict rests on: `range` rides the index's whole-document JSON
    // rather than a column somebody has to add. The pair is the point — a row saved without a range
    // has to come back without one, because the page reads that absence as "never recorded" and
    // renders no verdict word for it. An explicit field list in `revive` would break the first; a
    // default would break the second, and both would be silent.
    const { store: scans } = store();
    const wide = scan('scored', '2026-08-01T01:00:00.000Z', 65.3);
    await scans.save({ ...wide, score: { ...wide.score, range: { low: 14.2, high: 91.8 } } });
    await scans.save(scan('unscored', '2026-07-01T01:00:00.000Z'));

    const [scored, unscored] = await scans.history();

    expect(scored?.range).toEqual({ low: 14.2, high: 91.8 });
    expect(unscored).not.toHaveProperty('range');
  });

  it('honours the limit, so a long history is not read whole to show ten rows', async () => {
    const { store: scans } = store();
    for (const day of [1, 2, 3, 4, 5]) {
      await scans.save(scan(`s${String(day)}`, `2026-08-0${String(day)}T00:00:00.000Z`));
    }

    expect((await scans.history(2)).map((entry) => entry.id)).toEqual(['s5', 's4']);
  });

  it('resolves latest through the summary index rather than sorting whole scans', async () => {
    const { store: scans } = store();
    await scans.save(scan('older', '2026-07-01T00:00:00.000Z'));
    await scans.save(scan('newer', '2026-08-01T00:00:00.000Z'));

    expect((await scans.latest())?.id).toBe('newer');
  });

  it('treats a fresh install as empty history rather than an error', async () => {
    const { store: scans } = store();

    expect(await scans.history()).toEqual([]);
    expect(await scans.latest()).toBeUndefined();
  });

  it('reports a scan that was never written as absent', async () => {
    const { store: scans } = store();

    expect(await scans.get('never-written')).toBeUndefined();
  });

  it('reads a scan written by another build as absent, and says so once', async () => {
    const onError = vi.fn();
    const db = new FakePostgres();
    // A row whose body the current codec refuses: the shape a future or past build wrote.
    db.seed('scans', {
      id: 'aaa',
      started_at: new Date('2026-08-01T00:00:00.000Z'),
      summary: { id: 'aaa' },
      body: { version: 999, unknown: true },
    });
    const { store: scans } = store({ db, onError });

    expect(await scans.get('aaa')).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toContain('aaa');
  });

  it('skips a summary it cannot read rather than failing the whole page', async () => {
    const db = new FakePostgres();
    db.seed('scans', { id: 'good', started_at: new Date('2026-08-02T00:00:00.000Z'), summary: goodSummary() });
    db.seed('scans', { id: 'bad', started_at: new Date('2026-08-01T00:00:00.000Z'), summary: { id: 'bad' } });
    const { store: scans } = store({ db });

    expect((await scans.history()).map((entry) => entry.id)).toEqual(['good']);
  });

  it('explains a failed read instead of looking empty', async () => {
    const onError = vi.fn();
    const db = new FakePostgres({
      failOn: (sql) => (sql.startsWith('select summary') ? new Error('connection terminated') : undefined),
    });
    const { store: scans } = store({ db, onError });

    expect(await scans.history()).toEqual([]);
    expect(onError).toHaveBeenCalledWith('read scan history', expect.any(Error));
    // Logged is not enough. An empty list and a list nobody could read are identical to the client,
    // and the difference is whether the estate has ever been assessed, so the store keeps the
    // reason and `/api/scans` passes it on.
    expect(scans.unreadable()).toContain('connection terminated');
  });

  it('stops reporting a failed read once one succeeds', async () => {
    // Otherwise a single blip leaves a banner on the history page until the app restarts.
    let broken = true;
    const db = new FakePostgres({
      failOn: (sql) => (broken && sql.startsWith('select summary') ? new Error('connection terminated') : undefined),
    });
    const { store: scans } = store({ db });

    await scans.history();
    expect(scans.unreadable()).toBeDefined();

    broken = false;
    await scans.history();
    expect(scans.unreadable()).toBeUndefined();
  });

  it('saves the same id twice without a duplicate-key failure, so a retried write is safe', async () => {
    const { db, store: scans } = store();
    await scans.save(scan('aaa', '2026-08-01T00:00:00.000Z', 0.1));
    await scans.save(scan('aaa', '2026-08-01T00:00:00.000Z', 0.9));

    expect(db.rows('scans')).toHaveLength(1);
    expect((await scans.get('aaa'))?.score.overall).toBe(0.9);
  });

  it('declares itself durable, which is what the UI reports to the person looking at it', () => {
    expect(store().store.durable).toBe(true);
  });
});

describe('choosing a store', () => {
  it('refuses to start when no database is bound, naming the binding', async () => {
    await expect(chooseStore({ env: {} })).rejects.toThrow(ENDPOINT_ENV);
  });

  it('uses the bound database for all three kinds of record', async () => {
    const fake = new FakePostgres();
    const chosen = await chooseStore({ env: { [ENDPOINT_ENV]: ENDPOINT }, connect: () => Promise.resolve(fake) });

    expect(chosen.store.durable).toBe(true);
    expect(chosen.attestations.durable).toBe(true);
    expect(chosen.decisions.durable).toBe(true);
    expect(chosen.reviews.durable).toBe(true);
    expect(chosen.explanation).toContain('waf');
    expect(chosen.reviewExplanation).toContain('waf');
    expect(chosen.close).toBeTypeOf('function');
  });

  it('keeps nothing under the demo flag, and every explanation names the flag', async () => {
    // Three explanations rather than one shared sentence, because losing a scan and losing
    // somebody's written attestation are not the same loss and should not read as though they were.
    const chosen = await chooseStore({ env: { [DEMO_ENV]: '1' } });

    expect(chosen.store.durable).toBe(false);
    expect(chosen.attestations.durable).toBe(false);
    expect(chosen.decisions.durable).toBe(false);
    expect(chosen.reviews.durable).toBe(false);
    for (const explanation of [
      chosen.explanation,
      chosen.attestationExplanation,
      chosen.decisionExplanation,
      chosen.reviewExplanation,
    ]) {
      expect(explanation).toContain(DEMO_ENV);
    }
    expect(chosen.close).toBeUndefined();
  });

  it('ignores a demo flag set to anything but 1, so a stray value does not silently discard history', async () => {
    // `WAF_DEMO_NO_PERSISTENCE=0` and `=false` both read as "off" to a person, and a check for
    // presence rather than value would read them as "on".
    for (const value of ['0', 'false', 'no', '']) {
      await expect(chooseStore({ env: { [DEMO_ENV]: value } })).rejects.toThrow(ENDPOINT_ENV);
    }
  });

  it('closes the pool without throwing when draining fails, since shutdown cannot fail usefully', async () => {
    const onError = vi.fn();
    const fake = new FakePostgres();
    vi.spyOn(fake, 'end').mockRejectedValue(new Error('pool would not drain'));
    const chosen = await chooseStore({
      env: { [ENDPOINT_ENV]: ENDPOINT },
      connect: () => Promise.resolve(fake),
      onError,
    });

    await expect(chosen.close?.()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith('close the database pool', expect.any(Error));
  });
});

function goodSummary(): Record<string, unknown> {
  return {
    id: 'good',
    startedAt: '2026-08-02T00:00:00.000Z',
    finishedAt: '2026-08-02T00:01:00.000Z',
    state: 'complete',
  };
}
