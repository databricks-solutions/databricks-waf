// Keeping a declaration, and refusing the second one written at the same version.
//
// The refusal is what most of this file is about, and it is the opposite of what the notes store does
// with a repeated id. A note arriving twice is one note written twice; a declaration arriving at a
// version that exists is two people declaring different populations, one of whom is about to be
// silently overruled. So the store refuses, and the refusal names the version that is current, which
// is the only thing the loser can act on.
//
// The other half is what a stored row is trusted to be. `reviveDeclaration` rebuilds the definition
// through `defineServing` and compares the fingerprint it computes against the stored one, so a row
// somebody edited and a row written by a build whose rules have since changed both read as unreadable.
// A readiness outcome names this fingerprint as the thing it is a reading of, and a definition that no
// longer means what its fingerprint says is worse than no definition at all.

import { describe, expect, it } from 'vitest';
import { FakePostgres } from '../store/postgres-fake.js';
import { defineServing, type ServingDraft } from './serving-asset.js';
import { PostgresServingStore } from './serving-postgres-store.js';
import {
  InMemoryServingStore,
  nextDeclaration,
  reviveDeclaration,
  ServingVersionError,
  type ServingDeclaration,
  type ServingStore,
} from './serving-store.js';

const NOW = new Date('2026-08-15T09:00:00.000Z');
const LATER = new Date('2026-08-16T09:00:00.000Z');

const DRAFT: ServingDraft = {
  named: [{ catalog: 'main', schema: 'gold', table: 'orders' }],
  tagged: [{ key: 'certification', values: ['gold'], at: ['table'] }],
  requiredTagKeys: ['owner_team'],
  requiredMetadata: ['description', 'owner'],
  policy: [{ classification: 'pii', requires: ['column-mask'] }],
};

function declaration(over: Partial<ServingDeclaration> = {}): ServingDeclaration {
  const version = over.version ?? 1;
  return {
    id: `serving-${String(version)}`,
    version,
    declaredAt: NOW,
    declaredBy: 'priya@example.com',
    definition: defineServing(DRAFT, version),
    ...over,
  };
}

/**
 * The two unique indexes the schema declares, as the fake models them.
 *
 * A pair rather than one over `(definition_id, version)`, for the reason `FakeUniqueConstraint`
 * records: nulls are distinct in Postgres, so an index over a nullable column does not constrain the
 * rows whose value is null — and every row on an install with no assessment defined is one of those.
 */
function postgres(): { store: ServingStore; db: FakePostgres; errors: string[] } {
  const db = new FakePostgres({
    keys: { serving_declarations: ['definition_id', 'version'] },
    unique: {
      serving_declarations: [
        { columns: ['definition_id', 'version'], when: (row) => row['definition_id'] != null },
        { columns: ['version'], when: (row) => row['definition_id'] == null },
      ],
    },
  });
  const errors: string[] = [];
  const store = new PostgresServingStore({ db, onError: (operation) => errors.push(operation) });
  return { store, db, errors };
}

const implementations: readonly [string, () => ServingStore][] = [
  ['in memory', (): ServingStore => new InMemoryServingStore()],
  ['in postgres', (): ServingStore => postgres().store],
];

describe.each(implementations)('keeping serving declarations %s', (_name, open) => {
  it('has nothing current where nobody has declared anything', async () => {
    const store = open();
    expect(await store.current()).toBeUndefined();
    expect(await store.history()).toEqual([]);
  });

  it('reads back what was declared, including who declared it and when', async () => {
    const store = open();
    await store.declare(declaration());

    const current = await store.current();
    expect(current?.version).toBe(1);
    expect(current?.declaredBy).toBe('priya@example.com');
    expect(current?.declaredAt).toEqual(NOW);
    expect(current?.definition.named).toEqual([{ catalog: 'main', schema: 'gold', table: 'orders' }]);
  });

  it('reads the newest as current and the history newest first, whatever order they were written in', async () => {
    const store = open();
    await store.declare(declaration({ version: 2, declaredAt: LATER }));
    await store.declare(declaration({ version: 1 }));

    expect((await store.current())?.version).toBe(2);
    expect((await store.history()).map((one) => one.version)).toEqual([2, 1]);
  });

  it('refuses a second declaration at a version that exists, rather than replacing it', async () => {
    // The lost update, and the reason this refuses where the notes store shrugs. Both writers here
    // declared something, and dropping either one silently is the failure.
    const store = open();
    await store.declare(declaration({ declaredBy: 'priya@example.com' }));

    await expect(store.declare(declaration({ declaredBy: 'sam@example.com' }))).rejects.toBeInstanceOf(
      ServingVersionError,
    );
    expect((await store.current())?.declaredBy).toBe('priya@example.com');
  });

  it('names the version that is current in the refusal, because that is what the caller can act on', async () => {
    const store = open();
    await store.declare(declaration());

    await expect(store.declare(declaration())).rejects.toThrow(/Version 1 .* already exists/);
  });

  it('keeps two assessments apart, including where both are at the same version', async () => {
    const store = open();
    await store.declare(declaration({ definitionId: 'def-a' }));
    await store.declare(declaration({ definitionId: 'def-b' }));

    expect((await store.current('def-a'))?.definitionId).toBe('def-a');
    expect((await store.history('def-b')).map((one) => one.version)).toEqual([1]);
    // Unscoped is the reader not having named one, which is the records that name none — not both at
    // once. See `assessment-scope.ts`.
    expect(await store.current(null)).toBeUndefined();
  });
});

describe('what each implementation says about itself', () => {
  it('is honest about durability, because the UI warns on the answer', () => {
    expect(new InMemoryServingStore().durable).toBe(false);
    expect(postgres().store.durable).toBe(true);
  });
});

describe('numbering the next declaration', () => {
  it('starts at 1 and counts up from what is stored', () => {
    const first = nextDeclaration(DRAFT, undefined, 'priya@example.com', NOW);
    expect(first.version).toBe(1);
    expect(first.id).toBe('serving-1');

    expect(nextDeclaration(DRAFT, first, 'sam@example.com', LATER).version).toBe(2);
  });

  it('fingerprints what was declared and not which version said it', () => {
    const first = nextDeclaration(DRAFT, undefined, 'priya@example.com', NOW);
    const same = nextDeclaration(DRAFT, first, 'priya@example.com', LATER);
    const changed = nextDeclaration({ ...DRAFT, requiredMetadata: ['description'] }, same, 'sam@example.com', LATER);

    // A revision that changes nothing is version 2 of the same population, and two readings either side
    // of it are comparable — which is the question the fingerprint is on the outcome to answer. A
    // fingerprint that moved with the version would make every revision look like a changed estate.
    expect(same.version).toBe(2);
    expect(same.definition.fingerprint).toBe(first.definition.fingerprint);
    expect(changed.definition.fingerprint).not.toBe(first.definition.fingerprint);
  });
});

describe('a durable store reading rows it cannot use', () => {
  /** A row as it sits in the table, so a test can put a body in that the store would never write. */
  function row(body: unknown, version = 9): Record<string, unknown> {
    return {
      id: `serving-${String(version)}`,
      version,
      declared_at: NOW,
      declared_by: 'priya@example.com',
      fingerprint: 'sha256:whatever',
      body,
      digest: 'sha256:whatever',
      definition_id: null,
    };
  }

  it('drops and reports a declaration whose stored fingerprint is not the one its rules produce', async () => {
    // A row edited in the database, or one written by a build whose rules have since changed. Both are
    // this, and both have to read as unreadable: a reading names the fingerprint, so a definition that
    // no longer means what its fingerprint says would have every past reading pointing at the wrong
    // population.
    const { store, db, errors } = postgres();
    await store.declare(declaration());
    const edited = declaration({ version: 9 });
    db.seed(
      'serving_declarations',
      row({ ...edited, definition: { ...edited.definition, requiredTagKeys: ['something_else'] } }, 9),
    );

    expect((await store.history()).map((one) => one.version)).toEqual([1]);
    expect(errors).toEqual(['read the serving declarations']);
  });

  it('drops and reports a declaration whose date will not parse, rather than dating it now', async () => {
    const { store, db, errors } = postgres();
    db.seed('serving_declarations', row({ ...declaration({ version: 9 }), declaredAt: 'the third of never' }, 9));

    expect(await store.history()).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('reads nothing and says why when the query fails, rather than throwing at a page', async () => {
    const { store, db, errors } = postgres();
    await db.end();

    expect(await store.history()).toEqual([]);
    expect(await store.current()).toBeUndefined();
    expect(errors).toEqual(['read the serving declarations', 'read the serving declarations']);
  });
});

describe('reviving a stored declaration', () => {
  it('accepts one this app wrote', () => {
    const stored = JSON.parse(JSON.stringify(declaration())) as unknown;
    expect(reviveDeclaration(stored)?.version).toBe(1);
  });

  it('refuses one whose definition no longer passes the rules it was written under', () => {
    // A definition that selects nothing is refused at declaration time, so a stored one that selects
    // nothing arrived some other way. Reviving it would put a population of zero behind eight shares.
    const stored = JSON.parse(JSON.stringify(declaration())) as Record<string, unknown>;
    expect(reviveDeclaration({ ...stored, definition: { named: [], tagged: [] } })).toBeUndefined();
  });

  it('refuses anything that is not a declaration at all', () => {
    for (const raw of [null, undefined, 'serving-1', 42, {}, { id: 'serving-1', version: 0 }]) {
      expect(reviveDeclaration(raw), JSON.stringify(raw)).toBeUndefined();
    }
  });
});
