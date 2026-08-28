// The gate that keeps the live suite honest, tested against the repository it describes.
//
// What matters about it is the direction of its errors: it must not call a moved statement covered,
// and it must derive the covered set from the suite rather than from a list that can drift.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { digest, RECORDING, state, stripped, surface } from './live-suite.mjs';

describe('the surface the live suite is measured against', () => {
  it('is every module that emits SQL against a real Postgres, and not the fake', () => {
    const all = surface();
    expect(all).toContain('server/store/postgres.ts');
    expect(all).toContain('server/improve/postgres-store.ts');
    expect(all).not.toContain('server/store/postgres-fake.ts');
    // Databricks SQL is not Postgres SQL, and no run of this suite touches a warehouse.
    expect(all).not.toContain('server/collect/sql/statements.ts');
  });

  it('counts as covered only what the suite itself imports', () => {
    const { covered: proved, uncovered } = state();
    expect(proved).toContain('server/improve/postgres-store.ts');
    // Named rather than counted, because this is where a newly driven store becomes a claim the
    // recording has to keep. The note store crossed this line in `36i`; `107a` brings the review
    // store's migration, uniqueness and failure constraints through the same real connection.
    expect(proved).toContain('server/note/postgres-store.ts');
    expect(proved).toContain('server/review/postgres-store.ts');
    expect(proved.some((path) => uncovered.includes(path))).toBe(false);
  });
});

describe('the digest', () => {
  it('moves when a covered file does, which is the whole of the gate', () => {
    const one = digest(['server/store/postgres.ts']);
    const two = digest(['server/store/postgres.ts', 'server/improve/postgres-store.ts']);
    expect(one).not.toEqual(two);
  });

  it('does not move for a comment, because a comment does not reach the database', () => {
    // The digest's own stripping rather than a second copy of it here, which is the mistake
    // `bounds.ts` made: a test that strips the same way cannot see what the stripping loses.
    const source = 'const a = 1;\nawait db.query(`select 1 from ${schema}.t`);\n';
    expect(stripped(`// why\n${source}`)).toEqual(stripped(source));
    expect(stripped(source.replace('select 1', 'select 2'))).not.toEqual(stripped(source));
  });

  it('moves for a parameter bound to a different column, which no SQL-only digest would see', () => {
    const one = 'await db.query(text, [plan.id, action.id]);\n';
    const two = 'await db.query(text, [action.id, plan.id]);\n';
    expect(stripped(one)).not.toEqual(stripped(two));
  });
});

describe('the recording', () => {
  it('describes this commit, or verify is failing and saying so', () => {
    const recorded = JSON.parse(readFileSync(RECORDING, 'utf8')) as { digest: string; tests: number };
    expect(recorded.digest).toEqual(state().digest);
    expect(recorded.tests).toBeGreaterThan(0);
  });
});
