// Durable serving declarations, in the Lakebase schema the app owns.
//
// One table, insert-only, no update statement and no delete — the same arrangement the notes store
// uses, and here it is the record's guarantee rather than a preference: a readiness outcome names the
// fingerprint of the declaration it was taken against, and a declaration that could be edited would
// re-date every reading ever taken of it.
//
// `version` is a column as well as a field of the body, and it is the primary key together with the
// assessment. That is what makes the refusal in `declare` the database's rather than this file's: two
// people declaring the next version at the same moment both write version 4, and the second insert is
// refused by a constraint instead of by a read-then-write that cannot see the other one.

import { digestOf } from '../records/digest.js';
import type { Postgres } from '../store/postgres.js';
import { applyScope, type AssessmentScope } from '../store/assessment-scope.js';
import type { ServingDeclaration, ServingStore } from './serving-store.js';
import { newestFirst, reviveDeclaration, ServingVersionError } from './serving-store.js';

/** Postgres's unique-violation SQLSTATE, spelled the same way the other four stores here spell it. */
const UNIQUE_VIOLATION = '23505';

function duplicate(error: unknown): boolean {
  return typeof error === 'object' && error != null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

export interface PostgresServingStoreOptions {
  readonly db: Postgres;
  readonly onError?: (operation: string, error: unknown) => void;
}

export class PostgresServingStore implements ServingStore {
  readonly durable = true;

  constructor(private readonly options: PostgresServingStoreOptions) {}

  async declare(declaration: ServingDeclaration): Promise<void> {
    const { db } = this.options;
    try {
      await db.query(
        `insert into ${db.schema}.serving_declarations
           (id, version, declared_at, declared_by, fingerprint, body, digest, definition_id)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
        [
          declaration.id,
          declaration.version,
          declaration.declaredAt,
          declaration.declaredBy,
          declaration.definition.fingerprint,
          JSON.stringify(declaration),
          digestOf(declaration),
          declaration.definitionId ?? null,
        ],
      );
    } catch (cause) {
      // A plain insert rather than `on conflict do nothing`, because the conflict is the thing worth
      // reporting. Unlike a note arriving twice — one note, written once — a second write at the same
      // version is two people declaring different populations, and the one whose write is dropped has
      // to be told. The constraint is the database's, so this refusal holds against two writers racing
      // rather than only against one that read first.
      if (!duplicate(cause)) throw cause;
      throw new ServingVersionError(
        `Version ${String(declaration.version)} of the serving declaration already exists. Re-read the ` +
          'current one and declare the next.',
      );
    }
  }

  async current(scope?: AssessmentScope): Promise<ServingDeclaration | undefined> {
    return (await this.history(scope))[0];
  }

  async history(scope?: AssessmentScope): Promise<readonly ServingDeclaration[]> {
    const { db } = this.options;
    const operation = 'read the serving declarations';
    try {
      const scoped = applyScope('', [], scope);
      const { rows } = await db.query<{ body: unknown }>(
        `select body from ${db.schema}.serving_declarations ${scoped.fragment} order by version desc`,
        scoped.values,
      );

      const declarations = rows.map((row) => reviveDeclaration(row.body));
      const unreadable = declarations.filter((one) => one == null).length;
      if (unreadable > 0) {
        // Counted once rather than per row, like the other stores: a rule change makes every row
        // unreadable at the same moment and the number is the useful part. It is also the more likely
        // cause here — `reviveDeclaration` re-derives the definition and compares fingerprints, so a
        // change to what `defineServing` accepts retires stored declarations rather than reinterpreting
        // them, which is the behaviour a readiness reading needs.
        this.options.onError?.(
          operation,
          new Error(`${String(unreadable)} stored serving declaration(s) could not be read`),
        );
      }
      return newestFirst(declarations.filter((one): one is ServingDeclaration => one != null));
    } catch (error) {
      // A failed read reads as nothing declared, and says so through onError. The readiness surface
      // renders that as unmeasured with a reason, which is what it renders for an estate that has
      // genuinely declared nothing — the two are told apart by the log rather than by the page, and
      // the alternative is a page that throws.
      this.options.onError?.(operation, error);
      return [];
    }
  }
}
