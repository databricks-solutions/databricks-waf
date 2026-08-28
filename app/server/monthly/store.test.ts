import { describe, expect, it } from 'vitest';
import { FakePostgres } from '../store/postgres-fake.js';
import { parseMonth, type MonthId, type Publication } from './publication.js';
import {
  InMemoryPublicationStore,
  PostgresPublicationStore,
  PublicationRaceError,
  type PublicationStore,
} from './store.js';

/**
 * The unique index the schema declares, which nothing in an insert states.
 *
 * Declared here for the reason `FakePostgres` documents: a fake that modelled only the primary key would
 * report the race this store exists to refuse as a write that succeeded.
 *
 * Two of them, mirroring the pair the schema declares: one per assessment, and one over the rows that
 * name none. `42c` had a single index over a nullable `definition_id`, which left a month with no
 * assessment able to hold two first publications — see the fuller note in `accept/store.test.ts`.
 *
 * The unscoped one is `(month, ordinal)`, which is the index this table had before `42a`, and its nulls
 * are distinct as they were: `ordinal` is nullable too, rows written before `28c` gave publications a
 * position have none, and two of those are not two claims on position 1.
 */
const POSITION = {
  unique: {
    month_publications: [
      {
        columns: ['definition_id', 'month', 'ordinal'],
        when: (row: Readonly<Record<string, unknown>>): boolean => row.definition_id != null,
        name: 'month_publications_at_position_scoped',
      },
      {
        columns: ['month', 'ordinal'],
        when: (row: Readonly<Record<string, unknown>>): boolean => row.definition_id == null,
        name: 'month_publications_at_position_unscoped',
      },
    ],
  },
} as const;

function month(raw: string): MonthId {
  const parsed = parseMonth(raw);
  if (parsed == null) throw new Error(`test wants a valid month, ${raw} is not one`);
  return parsed;
}

function publication(over: Partial<Publication> = {}): Publication {
  return {
    id: 'pub-1',
    month: month('2026-08'),
    publishedAt: new Date('2026-09-01T09:00:00.000Z'),
    publishedBy: 'ana@example.com',
    documentVersion: 1,
    json: '{"documentKind":"databricks-waf-month"}',
    csv: 'month,publication_id\r\n2026-08,pub-1',
    digest: 'sha256:abc',
    definitionId: 'def-1',
    ...over,
  };
}

// Both implementations run the same suite, because the whole point of the in-memory store is to be
// the same store without a database. A behaviour that held for one and not the other is a behaviour
// the tests would let diverge.
function suite(name: string, make: () => PublicationStore): void {
  describe(name, () => {
    it('reads back the bytes it was given, unchanged', async () => {
      // The record type's whole promise. What goes in comes out, verbatim, so a digest recorded at
      // publish still matches.
      const store = make();
      const pub = publication();
      await store.publish(pub);
      const [read] = await store.ofMonth(month('2026-08'));
      expect(read?.json).toBe(pub.json);
      expect(read?.csv).toBe(pub.csv);
      expect(read?.digest).toBe(pub.digest);
      expect(read?.documentVersion).toBe(1);
      expect(read?.publishedAt.toISOString()).toBe('2026-09-01T09:00:00.000Z');
    });

    it('is append-only: a repeated id is ignored rather than overwriting', async () => {
      const store = make();
      await store.publish(publication({ json: '{"first":true}' }));
      // A retry of a request whose answer was lost. It describes the row already written.
      await store.publish(publication({ json: '{"second":true}' }));
      const held = await store.ofMonth(month('2026-08'));
      expect(held).toHaveLength(1);
      expect(held[0]?.json).toBe('{"first":true}');
    });

    it('keeps several publications of a month, oldest first', async () => {
      const store = make();
      const second = publication({
        id: 'pub-2',
        supersedes: 'pub-1',
        reason: 'A run repaired after the first publication.',
        publishedAt: new Date('2026-09-05T09:00:00.000Z'),
      });
      await store.publish(second);
      await store.publish(publication());
      const held = await store.ofMonth(month('2026-08'));
      expect(held.map((one) => one.id)).toEqual(['pub-1', 'pub-2']);
      // The correction carries what it superseded and why; the first carries neither.
      expect(held[0]?.supersedes).toBeUndefined();
      expect(held[0]?.reason).toBeUndefined();
      expect(held[1]?.supersedes).toBe('pub-1');
      expect(held[1]?.reason).toBe('A run repaired after the first publication.');
    });

    it('finds a publication by id, so a superseded copy stays reachable', async () => {
      const store = make();
      await store.publish(publication({ id: 'pub-1' }));
      await store.publish(publication({ id: 'pub-2', publishedAt: new Date('2026-09-05T09:00:00.000Z') }));
      expect((await store.byId('pub-1'))?.id).toBe('pub-1');
      expect(await store.byId('missing')).toBeUndefined();
    });

    it('lists the months that have publications, newest first and deduped', async () => {
      const store = make();
      await store.publish(publication({ id: 'a', month: month('2026-08') }));
      await store.publish(publication({ id: 'b', month: month('2026-08') }));
      await store.publish(publication({ id: 'c', month: month('2026-10') }));
      await store.publish(publication({ id: 'd', month: month('2026-09') }));
      expect(await store.months()).toEqual(['2026-10', '2026-09', '2026-08']);
    });

    it('returns nothing for a month never published', async () => {
      const store = make();
      expect(await store.ofMonth(month('2026-08'))).toEqual([]);
    });

    /*
     * Finding 7. The endpoint read the month, found nothing published and wrote — so two callers doing
     * that at once both wrote, and the month held two publications neither of which superseded the other.
     * The rule was in a place that cannot hold it, and this is the store holding it.
     */
    it('refuses a second publication at a position the month already holds', async () => {
      const store = make();
      await store.publish(publication({ id: 'theirs', ordinal: 1 }));

      await expect(store.publish(publication({ id: 'mine', ordinal: 1 }))).rejects.toThrow(PublicationRaceError);
      expect((await store.ofMonth(month('2026-08'))).map((one) => one.id)).toEqual(['theirs']);
    });

    it('refuses the second of two corrections of one standing copy', async () => {
      // The same race one position along: both read the same current publication and both claim to
      // supersede it, which would leave the month with two second publications and one predecessor.
      const store = make();
      await store.publish(publication({ id: 'first', ordinal: 1 }));
      await store.publish(publication({ id: 'theirs', ordinal: 2, supersedes: 'first', reason: 'A repair.' }));

      await expect(
        store.publish(publication({ id: 'mine', ordinal: 2, supersedes: 'first', reason: 'Another repair.' }))
      ).rejects.toThrow(PublicationRaceError);
    });

    it('refuses a second publication at one position when neither names an assessment', async () => {
      // The unscoped case, which `42c` left with no constraint and no test: both rows null in
      // `definition_id`, nulls treated as distinct, so one month could hold two first publications with
      // different bytes and different digests and nothing to say which one the month is.
      const store = make();
      await store.publish(publication({ id: 'theirs', ordinal: 1, definitionId: undefined }));

      await expect(
        store.publish(publication({ id: 'mine', ordinal: 1, definitionId: undefined }))
      ).rejects.toThrow(PublicationRaceError);
      expect((await store.ofMonth(month('2026-08'), null)).map((one) => one.id)).toEqual(['theirs']);
    });

    it('lets two assessments publish the same month at the same position', async () => {
      const store = make();
      await store.publish(publication({ id: 'a', definitionId: 'def-a', ordinal: 1 }));
      await expect(store.publish(publication({ id: 'b', definitionId: 'def-b', ordinal: 1 }))).resolves.toBeUndefined();

      expect((await store.ofMonth(month('2026-08'), 'def-a')).map((one) => one.id)).toEqual(['a']);
      expect((await store.ofMonth(month('2026-08'), 'def-b')).map((one) => one.id)).toEqual(['b']);
      expect(await store.months('def-a')).toEqual(['2026-08']);
      expect(await store.months(null)).toEqual([]);
    });

    it('keeps a position per month rather than across them', async () => {
      const store = make();
      await store.publish(publication({ id: 'august', month: month('2026-08'), ordinal: 1 }));

      await expect(
        store.publish(publication({ id: 'september', month: month('2026-09'), ordinal: 1 }))
      ).resolves.toBeUndefined();
    });

    it('holds a row that predates the position against nothing', async () => {
      // A row already written cannot lose a race that is over, so an absent position is not a claim on
      // position 1 — and two of them are not two claims on the same one.
      const store = make();
      await store.publish(publication({ id: 'old-one' }));

      await expect(store.publish(publication({ id: 'old-two' }))).resolves.toBeUndefined();
      expect(await store.ofMonth(month('2026-08'))).toHaveLength(2);
    });

    it('carries the position back on a read, so a correction can claim the next one', async () => {
      const store = make();
      await store.publish(publication({ ordinal: 1 }));

      expect((await store.ofMonth(month('2026-08')))[0]?.ordinal).toBe(1);
    });
  });
}

suite('in memory', () => new InMemoryPublicationStore());
suite('on postgres (faked)', () => new PostgresPublicationStore({ db: new FakePostgres(POSITION) }));

describe('the postgres store when a read fails', () => {
  it('reports through onError and reads as empty rather than throwing', async () => {
    const errors: string[] = [];
    const db = new FakePostgres({ failOn: (text) => (text.startsWith('select') ? new Error('down') : undefined) });
    const store = new PostgresPublicationStore({ db, onError: (operation) => errors.push(operation) });
    expect(await store.ofMonth(month('2026-08'))).toEqual([]);
    expect(await store.months()).toEqual([]);
    expect(errors).toContain('read the publications of 2026-08');
    expect(errors).toContain('list the months that have been published');
  });
});
