import { describe, expect, it } from 'vitest';
import { FakePostgres } from '../store/postgres-fake.js';
import { digestOf, fromBytes } from './digest.js';
import { describeVerification, verifyRecords, type VerificationReport } from './verify.js';

/** A stored scan row, digested the way `PostgresScanStore.save` digests one. */
function scan(id: string, body: Record<string, unknown> = { codecVersion: 2, scan: { id } }): Record<string, unknown> {
  return { id, started_at: new Date(`2026-08-0${id.slice(-1)}T00:00:00.000Z`), body, digest: digestOf(body) };
}

function db(): FakePostgres {
  // The two versioned tables are keyed on the pair, and the fake has to be told: a seed of two
  // revisions of one action would otherwise collide on the absent `id` key and the second would
  // replace the first, which is the fake reporting a constraint the database does not have.
  return new FakePostgres({
    keys: { improvement_plans: ['id', 'revision'], improvement_actions: ['id', 'revision'] },
  });
}

function tableIn(report: VerificationReport, table: string): NonNullable<VerificationReport['tables'][number]> {
  const found = report.tables.find((one) => one.table === table);
  if (found == null) throw new Error(`no ${table} in the report`);
  return found;
}

describe('verifying the stored records', () => {
  it('reports every row intact when nothing has been touched', async () => {
    const fake = db();
    fake.seed('scans', scan('scan-1'));
    fake.seed('scans', scan('scan-2'));

    const report = await verifyRecords({ db: fake });

    expect(report.intact).toBe(true);
    expect(tableIn(report, 'scans')).toMatchObject({ total: 2, checked: 2, intact: 2, unstamped: 0, altered: [] });
    expect(describeVerification(report)).toBe(
      'All 2 stored records were checked and each one still matches the digest written with it.'
    );
  });

  it('does not care what order the keys come back in', async () => {
    // The case this whole design turns on: `jsonb` returns a document with its own key order, so a
    // digest that depended on the order would report every row as altered on the first read.
    const fake = db();
    const body = { codecVersion: 2, scan: { id: 'scan-1', score: { overall: 62 } } };
    fake.seed('scans', { id: 'scan-1', started_at: new Date(), body, digest: digestOf(body) });
    fake.seed('scans', {
      id: 'scan-2',
      started_at: new Date(),
      body: { scan: { score: { overall: 62 }, id: 'scan-1' }, codecVersion: 2 },
      digest: digestOf(body),
    });

    expect((await verifyRecords({ db: fake })).intact).toBe(true);
  });

  it('names the record whose body no longer matches its digest', async () => {
    const fake = db();
    fake.seed('scans', scan('scan-1'));
    const edited = scan('scan-2');
    // What an edit in `psql` looks like from here: the body changed, the digest column did not.
    fake.seed('scans', { ...edited, body: { codecVersion: 2, scan: { id: 'scan-2', score: { overall: 99 } } } });

    const report = await verifyRecords({ db: fake });

    expect(report.intact).toBe(false);
    expect(tableIn(report, 'scans')).toMatchObject({ checked: 2, intact: 1, altered: ['scan-2'] });
    expect(describeVerification(report)).toContain('1 no longer match the digest written with them: scan-2');
    expect(describeVerification(report)).toContain('not what this app wrote');
  });

  it('counts a row with no digest as unstamped, which is neither a pass nor a failure', async () => {
    // Every row written before this landed. It cannot be given a digest now — that would stamp
    // whatever the body says today — so it is reported as what it is.
    const fake = db();
    fake.seed('scans', scan('scan-1'));
    fake.seed('scans', { id: 'scan-2', started_at: new Date(), body: { codecVersion: 2, scan: {} }, digest: null });

    const report = await verifyRecords({ db: fake });

    expect(report.intact).toBe(true);
    expect(tableIn(report, 'scans')).toMatchObject({ checked: 2, intact: 1, unstamped: 1, altered: [] });
    expect(describeVerification(report)).toContain('1 of them were written before this app recorded digests');
    expect(describeVerification(report)).toContain('unstamped rather than verified');
  });

  it('does not read as a pass when every record predates digests', async () => {
    // What a pilot's database looks like the first time this runs, which is how it read on labs: four
    // scans, none stamped. "Each one still matches the digest written with it" is true of the empty
    // set and is the one thing this must not say.
    const fake = db();
    fake.seed('scans', { id: 'old-1', started_at: new Date(), body: {}, digest: null });
    fake.seed('scans', { id: 'old-2', started_at: new Date(), body: {}, digest: null });

    const summary = describeVerification(await verifyRecords({ db: fake }));

    expect(summary).toContain('none of them carry a digest');
    expect(summary).toContain('nothing here is verified');
    expect(summary).not.toContain('still matches');
  });

  it('separates a body it cannot canonicalise from one that merely changed', async () => {
    const fake = db();
    // A document containing something no writer of this app produces. It is a deeper fault than a
    // mismatch — it is not a document this app could have written — so it is reported separately.
    fake.seed('scans', { id: 'scan-1', started_at: new Date(), body: { at: new Map() }, digest: 'sha256:whatever' });

    const report = await verifyRecords({ db: fake });

    expect(report.intact).toBe(false);
    expect(tableIn(report, 'scans')).toMatchObject({ altered: [], unreadable: ['scan-1'] });
  });

  it('checks answers and decisions as well as runs', async () => {
    const fake = db();
    const answer = { id: 'a1', controlId: 'c1', said: 'yes' };
    fake.seed('attestations', { id: 'a1', control_id: 'c1', attested_at: new Date(), body: answer, digest: digestOf(answer) });
    const decision = { id: 'd1', controlId: 'c1', accepted: true };
    fake.seed('decisions', { id: 'd1', control_id: 'c1', decided_at: new Date(), body: decision, digest: 'sha256:no' });

    const report = await verifyRecords({ db: fake });

    expect(tableIn(report, 'attestations')).toMatchObject({ checked: 1, intact: 1, altered: [] });
    expect(tableIn(report, 'decisions')).toMatchObject({ checked: 1, intact: 0, altered: ['d1'] });
    expect(report.intact).toBe(false);
  });

  it('names the revision of an altered plan or action, since the id alone names several rows', async () => {
    const fake = db();
    const action = { id: 'action-7', planId: 'plan-1', state: 'planned' };
    fake.seed('improvement_actions', {
      id: 'action-7',
      revision: 0,
      plan_id: 'plan-1',
      changed_at: new Date(),
      body: action,
      digest: digestOf(action),
    });
    // The second revision, edited behind the app. Reported as `action-7@2` rather than `action-7`, so
    // whoever has to look at it is not left reading every revision to find which one moved.
    fake.seed('improvement_actions', {
      id: 'action-7',
      revision: 2,
      plan_id: 'plan-1',
      changed_at: new Date(),
      body: { ...action, state: 'verified' },
      digest: digestOf(action),
    });

    const report = await verifyRecords({ db: fake });

    expect(tableIn(report, 'improvement_actions')).toMatchObject({ checked: 2, intact: 1, altered: ['action-7@2'] });
  });

  it('reads the newest rows only, and says how many it left out', async () => {
    // A year of daily runs is a hundred megabytes of bodies. The cap is what keeps this a request
    // rather than an outage, and the count that was skipped is reported so a partial check cannot be
    // read as a whole one.
    const fake = db();
    for (let at = 1; at <= 5; at += 1) fake.seed('scans', scan(`scan-${String(at)}`));

    const report = await verifyRecords({ db: fake, limit: 2 });

    expect(tableIn(report, 'scans')).toMatchObject({ total: 5, checked: 2 });
    expect(describeVerification(report)).toBe(
      'The newest 2 of 5 stored records were checked and each one still matches the digest written with it.'
    );
  });

  it('says what it does and does not establish, in the report itself', async () => {
    const report = await verifyRecords({ db: db() });
    expect(report.means).toContain('internally consistent, not that they are authentic');
  });

  /*
   * The record whose whole value is that its bytes have not moved was the one table this check did not
   * look at, while the report said all stored records were checked. Its digest is over the stored text
   * rather than over a canonicalised document, which is why it needed more than a line in the list: the
   * two are computed differently, and hashing the JSON string as a document would report every
   * publication as altered.
   */
  describe('a published month, whose digest covers the bytes it stored', () => {
    const publication = (id: string, json: string, digest = fromBytes(Buffer.from(json, 'utf8'))): Record<string, unknown> => ({
      id,
      month: '2026-07',
      published_at: new Date('2026-08-01T00:00:00.000Z'),
      published_by: 'ana@example.com',
      document_version: 1,
      json,
      csv: 'month\r\n2026-07',
      digest,
    });

    it('reads it back and finds the bytes it wrote', async () => {
      const fake = db();
      fake.seed('month_publications', publication('pub-1', '{"documentKind":"month","trend":[]}'));

      const report = await verifyRecords({ db: fake });

      expect(tableIn(report, 'month_publications')).toMatchObject({ total: 1, checked: 1, intact: 1, altered: [] });
      expect(report.intact).toBe(true);
    });

    it('names one whose frozen bytes were edited behind the app', async () => {
      const fake = db();
      const frozen = '{"documentKind":"month","trend":[]}';
      fake.seed('month_publications', {
        ...publication('pub-1', frozen),
        json: '{"documentKind":"month","trend":[{"score":"99"}]}',
      });

      const report = await verifyRecords({ db: fake });

      expect(tableIn(report, 'month_publications')).toMatchObject({ checked: 1, intact: 0, altered: ['pub-1'] });
      expect(describeVerification(report)).toContain('pub-1');
    });

    it('reports a json column that is not text as unreadable rather than as altered', async () => {
      const fake = db();
      // What the column would look like if it had been declared `jsonb`, which is the mistake ADR 0032
      // exists to prevent: a parsed document rather than the bytes a recipient holds.
      fake.seed('month_publications', { ...publication('pub-1', '{}'), json: { documentKind: 'month' } });

      const report = await verifyRecords({ db: fake });

      expect(tableIn(report, 'month_publications')).toMatchObject({ altered: [], unreadable: ['pub-1'] });
    });
  });

  it('names at most five altered records and counts the rest', async () => {
    const fake = db();
    for (let at = 1; at <= 7; at += 1) {
      fake.seed('scans', { ...scan(`scan-${String(at)}`), digest: 'sha256:stale' });
    }

    expect(describeVerification(await verifyRecords({ db: fake }))).toMatch(/and 2 more\. Those records/);
  });
});
