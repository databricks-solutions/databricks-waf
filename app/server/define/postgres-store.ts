// Durable assessment definitions, in the Lakebase schema the app owns.
//
// Two tables rather than one, and the split is doing work the app would otherwise have to be
// trusted to do. `assessment_definitions` holds identity and lifecycle — the id, when it was
// created, whether it has been archived. `assessment_definition_versions` holds one row per
// version, keyed on the pair, and is only ever inserted into.
//
// That primary key is the point. A version is immutable, and here it is immutable because the
// database refuses a second row with the same number rather than because nothing in the app happens
// to write one. Two people revising the same assessment at the same moment both compute version 3
// from the same read; one insert wins and the other raises a unique violation, which surfaces as
// `DefinitionConflict` and sends its author back to look at what changed. Storing the aggregate in
// a single upserted row would have let the second write land on top and drop the first revision with
// nothing anywhere recording that it had existed.
//
// The alternative considered was one row per definition holding the versions as a `jsonb` array,
// which is what the `scans` table does. It is simpler and it is fine for a scan, because a scan is
// written once by the process that produced it. A definition is edited by people.

import { digestOf } from '../records/digest.js';
import type { Postgres } from '../store/postgres.js';
import type { AssessmentDefinition, DefinitionVersion } from './definition.js';
import { DefinitionConflict, newestFirst, type DefinitionStore } from './store.js';

/** Postgres' code for a unique or primary key violation. */
const UNIQUE_VIOLATION = '23505';

export interface PostgresDefinitionStoreOptions {
  readonly db: Postgres;
  readonly onError?: (operation: string, error: unknown) => void;
}

interface DefinitionRow {
  readonly id: string;
  readonly archived_at: string | Date | null;
}

interface VersionRow {
  readonly definition_id: string;
  readonly body: unknown;
}

export class PostgresDefinitionStore implements DefinitionStore {
  readonly durable = true;

  constructor(private readonly options: PostgresDefinitionStoreOptions) {}

  async all(): Promise<readonly AssessmentDefinition[]> {
    const { db } = this.options;
    try {
      const [definitions, versions] = await Promise.all([
        db.query<DefinitionRow>(`select id, archived_at from ${db.schema}.assessment_definitions`),
        // Unordered, and sorted by version number below. The event log makes the same choice for the
        // same reason: ordering done in one place cannot differ between this store and the in-memory
        // one, and the row count here is versions-per-assessment, not scans.
        db.query<VersionRow>(`select definition_id, body from ${db.schema}.assessment_definition_versions`),
      ]);

      const byDefinition = new Map<string, DefinitionVersion[]>();
      let unreadable = 0;
      for (const row of versions.rows) {
        const version = revive(row.body);
        if (version == null) {
          unreadable += 1;
          continue;
        }
        byDefinition.set(row.definition_id, [...(byDefinition.get(row.definition_id) ?? []), version]);
      }
      // Counted and reported once, because a schema change that makes every row unreadable would
      // otherwise emit a line per version and the number is the useful part.
      if (unreadable > 0) {
        this.options.onError?.(
          'read every assessment definition',
          new Error(`${String(unreadable)} stored definition versions could not be read and were skipped.`),
        );
      }

      const assembled: AssessmentDefinition[] = [];
      for (const row of definitions.rows) {
        const stored = byDefinition.get(row.id)?.sort((a, b) => a.version - b.version);
        // A definition row with no readable version is not a definition. Skipped rather than
        // returned as an empty shell, because every caller reads fields off its current version.
        if (stored == null || stored.length === 0) continue;
        const archivedAt = row.archived_at == null ? undefined : new Date(row.archived_at);
        assembled.push({
          id: row.id,
          versions: stored,
          ...(archivedAt != null && !Number.isNaN(archivedAt.getTime()) ? { archivedAt } : {}),
        });
      }
      return newestFirst(assembled);
    } catch (error) {
      this.options.onError?.('read every assessment definition', error);
      throw error;
    }
  }

  async get(id: string): Promise<AssessmentDefinition | undefined> {
    // Read through `all` rather than a narrowed query. There are tens of these, not thousands, and
    // one assembly path means the two cannot disagree about how a row becomes a definition.
    const definitions = await this.all();
    return definitions.find((definition) => definition.id === id);
  }

  async create(definition: AssessmentDefinition): Promise<void> {
    const { db } = this.options;
    const first = definition.versions[0];
    if (first == null) throw new Error(`Assessment ${definition.id} has no version to store.`);

    try {
      // Not in a transaction, and it is worth saying why rather than leaving it to be noticed. The
      // narrow `Sql` interface these stores share has one method, so a transaction would mean
      // widening it for every store to buy atomicity here. What a half-completed create leaves is a
      // definition row with no versions, which `all` already skips — an assessment that does not
      // appear, rather than one that appears broken. Retrying the create then works, because the
      // definition insert does nothing on conflict.
      await db.query(
        `insert into ${db.schema}.assessment_definitions (id, created_at, archived_at)
           values ($1, $2, $3)
         on conflict (id) do nothing`,
        [definition.id, first.createdAt, definition.archivedAt ?? null],
      );
      await this.insertVersion(definition.id, first);
    } catch (error) {
      this.options.onError?.(`create assessment definition ${definition.id}`, error);
      throw error;
    }
  }

  async appendVersion(id: string, version: DefinitionVersion): Promise<void> {
    try {
      await this.insertVersion(id, version);
    } catch (error) {
      if (!(error instanceof DefinitionConflict)) {
        this.options.onError?.(`revise assessment definition ${id}`, error);
      }
      throw error;
    }
  }

  async archive(id: string, at: Date): Promise<void> {
    const { db } = this.options;
    try {
      // Only when it is not already archived, so the first archival's date is the one that stands
      // and a second call is genuinely idempotent rather than quietly moving the date forward.
      await db.query(
        `update ${db.schema}.assessment_definitions set archived_at = $2 where id = $1 and archived_at is null`,
        [id, at],
      );
    } catch (error) {
      this.options.onError?.(`archive assessment definition ${id}`, error);
      throw error;
    }
  }

  async unarchive(id: string): Promise<void> {
    const { db } = this.options;
    try {
      // Back to null rather than to a second column recording that it was once archived: the audit
      // log holds that history, and a row carrying both dates would leave every reader deciding
      // which one means "archived now".
      await db.query(
        `update ${db.schema}.assessment_definitions set archived_at = null where id = $1 and archived_at is not null`,
        [id],
      );
    } catch (error) {
      this.options.onError?.(`reopen assessment definition ${id}`, error);
      throw error;
    }
  }

  private async insertVersion(definitionId: string, version: DefinitionVersion): Promise<void> {
    const { db } = this.options;
    try {
      await db.query(
        `insert into ${db.schema}.assessment_definition_versions
           (definition_id, version, fingerprint, created_at, body, digest)
         values ($1, $2, $3, $4, $5::jsonb, $6)`,
        [
          definitionId,
          version.version,
          version.fingerprint,
          version.createdAt,
          JSON.stringify(version),
          digestOf(version),
        ],
      );
    } catch (error) {
      // No `on conflict do nothing` here, unlike the append-only logs. There, a repeated id is the
      // same record arriving twice and ignoring it is right. Here a repeated version number is a
      // different revision competing for the same slot, and silence would discard one.
      if (isUniqueViolation(error)) throw new DefinitionConflict(definitionId, version.version);
      throw error;
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

/**
 * A stored version back into a domain object, with its date restored.
 *
 * Typed as `unknown` on the way in and checked field by field, because what arrives is whatever is
 * in the column. A row written by an older build, or edited in `psql`, is not a `DefinitionVersion`
 * because the type says so — and a version whose number or fingerprint is missing would be compared
 * against other versions and stamped on a run.
 */
function revive(raw: unknown): DefinitionVersion | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const candidate: Record<string, unknown> = raw as Record<string, unknown>;

  const { version, fingerprint, createdBy, measurement, attribution, note } = candidate;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return undefined;
  if (typeof fingerprint !== 'string' || !fingerprint.startsWith('sha256:')) return undefined;
  if (typeof createdBy !== 'string') return undefined;
  if (typeof measurement !== 'object' || measurement === null) return undefined;
  if (typeof attribution !== 'object' || attribution === null) return undefined;

  const createdAt = new Date(candidate.createdAt as string);
  if (Number.isNaN(createdAt.getTime())) return undefined;

  // Assembled field by field rather than spread from the row. The two structured fields are checked
  // for being objects and no further, which is the honest limit of what can be asserted here — but
  // building the result explicitly means a column holding an extra key cannot ride along into a
  // version that gets fingerprinted and stamped on a run.
  return {
    version,
    fingerprint: fingerprint as DefinitionVersion['fingerprint'],
    createdAt,
    createdBy,
    measurement: measurement as DefinitionVersion['measurement'],
    attribution: attribution as DefinitionVersion['attribution'],
    ...targetsFrom(candidate.targets),
    ...(typeof note === 'string' && note !== '' ? { note } : {}),
  };
}

/**
 * The stored targets, with their dates back as dates.
 *
 * Its own function because targets are the one part of a version that does not survive `JSON.parse`
 * as itself: `by` is a `Date` in the domain and a string in the column, and a surface comparing a
 * string to `now` gets an answer that is wrong without being an error.
 *
 * A target that does not survive the check is dropped rather than failing the whole version. That is
 * the opposite of the choice made above for `version` and `fingerprint`, and for the opposite reason:
 * those decide what a run is compared against, so a bad one has to stop the row being used, while a
 * malformed target is a commitment that cannot be reported against. Losing the assessment because one
 * date is unreadable would take the customer's scope, owners and history with it.
 */
function targetsFrom(raw: unknown): { targets?: DefinitionVersion['targets'] } {
  if (!Array.isArray(raw)) return {};

  const targets = raw.flatMap((entry: unknown) => {
    if (entry == null || typeof entry !== 'object') return [];
    const { pillar, atLeast, by } = entry as Record<string, unknown>;
    if (typeof pillar !== 'string' || pillar === '') return [];
    if (typeof atLeast !== 'number' || !Number.isInteger(atLeast)) return [];
    const when = new Date(by as string);
    if (Number.isNaN(when.getTime())) return [];
    return [{ pillar, atLeast, by: when }];
  });

  return targets.length > 0 ? { targets } : {};
}
