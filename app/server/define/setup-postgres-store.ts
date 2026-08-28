// Unfinished assessments, in the Lakebase schema the app owns.
//
// One row per author per target, upserted. The `on conflict` clause is what makes the wizard's
// second save an update rather than a second row, and it needs the primary key to match on — which
// is why an absent definition id is stored as the empty string rather than as null. A nullable
// column cannot be part of a primary key, and `on conflict (author, definition_id)` against a null
// would never match, so every keystroke's worth of saving a new assessment would have left another
// row behind and the author would return to a list of drafts that were all the same draft.
//
// Read back field by field, like the version store, because what arrives is whatever is in the
// column: a row written by an older build is not a `SetupDraft` merely because the type says so.
// Unlike a version, though, a draft that cannot be read is dropped and not counted. A version is
// something a finished run points at and losing one silently would break a trend line; a draft is
// one person's scratch, and the worst an unreadable one costs is that they start again — which is
// what they would have to do anyway.

import type { Postgres } from '../store/postgres.js';
import type { DraftScope, DraftTarget, SetupDraft } from './setup.js';
import { newestFirst, targetOf, type SetupDraftStore } from './setup-store.js';

export interface PostgresSetupDraftStoreOptions {
  readonly db: Postgres;
  readonly onError?: (operation: string, error: unknown) => void;
}

interface DraftRow {
  readonly author: string;
  readonly definition_id: string;
  readonly body: unknown;
}

export class PostgresSetupDraftStore implements SetupDraftStore {
  readonly durable = true;

  constructor(private readonly options: PostgresSetupDraftStoreOptions) {}

  async get(author: string, definitionId?: string): Promise<SetupDraft | undefined> {
    const { db } = this.options;
    try {
      const rows = await db.query<DraftRow>(
        `select author, definition_id, body from ${db.schema}.assessment_setup_drafts
          where author = $1 and definition_id = $2`,
        [author, targetOf(definitionId)]
      );
      const row = rows.rows[0];
      return row == null ? undefined : revive(row);
    } catch (error) {
      this.options.onError?.('read an unfinished assessment', error);
      throw error;
    }
  }

  async mine(author: string): Promise<readonly SetupDraft[]> {
    const { db } = this.options;
    try {
      const rows = await db.query<DraftRow>(
        `select author, definition_id, body from ${db.schema}.assessment_setup_drafts where author = $1`,
        [author]
      );
      const drafts: SetupDraft[] = [];
      for (const row of rows.rows) {
        const draft = revive(row);
        if (draft != null) drafts.push(draft);
      }
      return newestFirst(drafts);
    } catch (error) {
      this.options.onError?.('read every unfinished assessment', error);
      throw error;
    }
  }

  async save(draft: SetupDraft): Promise<void> {
    const { db } = this.options;
    try {
      await db.query(
        `insert into ${db.schema}.assessment_setup_drafts (author, definition_id, saved_at, body)
           values ($1, $2, $3, $4::jsonb)
         on conflict (author, definition_id)
           do update set saved_at = excluded.saved_at, body = excluded.body`,
        [draft.author, targetOf(draft.definitionId), draft.savedAt, JSON.stringify(draft)]
      );
    } catch (error) {
      this.options.onError?.('keep an unfinished assessment', error);
      throw error;
    }
  }

  async discard(author: string, definitionId?: string): Promise<void> {
    const { db } = this.options;
    try {
      await db.query(`delete from ${db.schema}.assessment_setup_drafts where author = $1 and definition_id = $2`, [
        author,
        targetOf(definitionId),
      ]);
    } catch (error) {
      this.options.onError?.('discard an unfinished assessment', error);
      throw error;
    }
  }
}

/**
 * A stored row back into a draft.
 *
 * The author and the target come from the key columns rather than from the body, so a body edited in
 * `psql` to name somebody else cannot hand one author's draft to another. Everything else is
 * optional on the way in because it is optional in the type, and a field of the wrong shape is
 * dropped rather than carried: a `lookbackDays` of `"thirty"` would otherwise reach `troubles`,
 * which asks whether it is an integer and would report the answer as a lookback nobody typed.
 */
function revive(row: DraftRow): SetupDraft | undefined {
  const raw: unknown = row.body;
  if (raw == null || typeof raw !== 'object') return undefined;
  const candidate = raw as Record<string, unknown>;

  const savedAt = new Date(candidate.savedAt as string);
  if (Number.isNaN(savedAt.getTime())) return undefined;

  const { name, purpose, owners, lookbackDays, pillars, note, fromVersion } = candidate;
  const scope = scopeOf(candidate.scope);
  const targets = targetsOf(candidate.targets);

  return {
    author: row.author,
    ...(row.definition_id !== '' ? { definitionId: row.definition_id } : {}),
    ...(typeof fromVersion === 'number' && Number.isInteger(fromVersion) ? { fromVersion } : {}),
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof purpose === 'string' ? { purpose } : {}),
    ...(isStrings(owners) ? { owners } : {}),
    ...(scope != null ? { scope } : {}),
    ...(typeof lookbackDays === 'number' ? { lookbackDays } : {}),
    ...(isStrings(pillars) ? { pillars } : {}),
    ...(targets != null ? { targets } : {}),
    ...(typeof note === 'string' ? { note } : {}),
    savedAt,
  };
}

/**
 * The stored targets, keeping the half-written ones.
 *
 * A row missing its score or its date is kept, because that is the state this table exists to hold —
 * dropping it here would lose exactly the work a draft is for. A row of the wrong *shape* is dropped
 * field by field for the reason `lookbackDays` is: a score of `"eighty"` reaching `troubles` would be
 * reported to the author as a complaint about a number they never typed.
 *
 * A row with no pillar at all is dropped whole, since there is nothing for the wizard to show it
 * against.
 */
function targetsOf(raw: unknown): readonly DraftTarget[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  return raw.flatMap((entry: unknown) => {
    if (entry == null || typeof entry !== 'object') return [];
    const { pillar, atLeast, by } = entry as Record<string, unknown>;
    if (typeof pillar !== 'string') return [];
    return [
      {
        pillar,
        ...(typeof atLeast === 'number' ? { atLeast } : {}),
        ...(typeof by === 'string' ? { by } : {}),
      },
    ];
  });
}

function scopeOf(raw: unknown): DraftScope | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const { kind, workspaceIds } = raw as Record<string, unknown>;
  if (kind !== 'account' && kind !== 'selected') return undefined;
  return {
    kind,
    ...(isStrings(workspaceIds) ? { workspaceIds } : {}),
  };
}

function isStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((one) => typeof one === 'string');
}
