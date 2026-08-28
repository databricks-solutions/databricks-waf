// Where published months are kept, and the one rule that separates this store from every other here:
// it hands back the bytes it was given, unchanged.
//
// Every other store in this app keeps a domain object and rebuilds a document from it on read. This
// one keeps the document — the JSON and CSV text as they were built at publish — and returns them
// verbatim, because a published month is frozen and "frozen" is a promise about bytes. That is why
// `json` and `csv` are `text` and never `jsonb`: `jsonb` stores a parsed document and returns its keys
// in its own order, so a digest recorded at publish would not match what came back (ADR 0032, ADR
// 0072). The metadata columns beside the text are indexed copies for filtering and ordering; the text
// is the authority, and the digest covers it.
//
// Append-only, like the decisions and the notes: publishing is `insert`, there is no update and no
// delete, and a correction is a new row that names the one it supersedes. Deleting a superseded copy
// would leave a digest recorded in the audit trail pointing at bytes that no longer exist — the
// failure ADR 0050 exists to prevent, arriving by the back door. The write rules that decide *when* a
// publication may be created — a month closed, a duplicate refused, a supersession carrying a reason —
// are the endpoint's, in 28b. This store persists what it is handed and orders what it holds.

import type { Digest } from '../records/digest.js';
import type { Postgres } from '../store/postgres.js';
import { inPublishedOrder, parseMonth, type MonthId, type Publication } from './publication.js';
import { applyScope, inScope, type AssessmentScope } from '../store/assessment-scope.js';

/** Postgres' code for a unique or primary key violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * Raised when something else published at this position in the month first.
 *
 * Its own class rather than a generic conflict, so the endpoint answers 409 with a sentence a person can
 * act on instead of a stack trace about an index. One class for both races it refuses, because the answer
 * is the same in both: read the month again, because what you were working from is not what is on record.
 *
 * The rule it enforces was the endpoint's alone, and an endpoint that reads and then writes cannot enforce
 * it: two first publications of one month both read a month with nothing in it and both wrote.
 */
export class PublicationRaceError extends Error {
  constructor(readonly month: MonthId) {
    super(
      `Another publication of ${month} was recorded at this position first, so this one was not. Read the ` +
        'month again — what stands now is not what this was written against.'
    );
    this.name = 'PublicationRaceError';
  }
}

export interface PublicationStore {
  /** True when publications survive a restart. Surfaced in the UI, never assumed. */
  readonly durable: boolean;
  /**
   * Records a publication. Never overwrites: a correction is a new row naming the one it supersedes.
   *
   * A repeated id is the one case that is not a bug — a retry of a request whose answer was lost — and
   * it describes the row already written, so it is ignored rather than refused. Refusing a genuine
   * duplicate of *bytes* is the endpoint's job, not the store's.
   *
   * @throws PublicationRaceError where the month already holds a publication at this position. The one
   * rule here that is not the endpoint's, because the endpoint cannot hold it: it reads the month and then
   * writes, and two callers doing that at once both read a month that had room.
   */
  publish(publication: Publication): Promise<void>;
  /** Every publication of a month, oldest first, so the last is the current one and standing reads from position. */
  ofMonth(month: MonthId, scope?: AssessmentScope): Promise<readonly Publication[]>;
  /** One publication by its id, so a superseded copy stays reachable at its own digest. Absent if unknown. */
  byId(id: string, scope?: AssessmentScope): Promise<Publication | undefined>;
  /** The months that have at least one publication, newest first, for a list of what has been published. */
  months(scope?: AssessmentScope): Promise<readonly MonthId[]>;
}

export class InMemoryPublicationStore implements PublicationStore {
  readonly durable = false;

  private readonly rows: Publication[] = [];

  publish(publication: Publication): Promise<void> {
    if (this.rows.some((row) => row.id === publication.id)) return Promise.resolve();
    // The constraint the Postgres store gets from the database, held here by hand so an install with
    // nothing durable behaves the same way — and only where both rows carry a position, since a row
    // written before the column existed cannot lose a race that is already over.
    const taken = this.rows.some(
      (row) =>
        row.month === publication.month &&
        row.ordinal != null &&
        row.ordinal === publication.ordinal &&
        (row.definitionId ?? null) === (publication.definitionId ?? null)
    );
    if (taken) return Promise.reject(new PublicationRaceError(publication.month));

    this.rows.push(publication);
    return Promise.resolve();
  }

  ofMonth(month: MonthId, scope?: AssessmentScope): Promise<readonly Publication[]> {
    return Promise.resolve(
      inPublishedOrder(this.rows.filter((row) => row.month === month && inScope(row.definitionId, scope)))
    );
  }

  byId(id: string, scope?: AssessmentScope): Promise<Publication | undefined> {
    const row = this.rows.find((one) => one.id === id);
    if (row == null || !inScope(row.definitionId, scope)) return Promise.resolve(undefined);
    return Promise.resolve(row);
  }

  months(scope?: AssessmentScope): Promise<readonly MonthId[]> {
    const seen = new Set<MonthId>(
      this.rows.filter((row) => inScope(row.definitionId, scope)).map((row) => row.month)
    );
    return Promise.resolve([...seen].sort((left, right) => right.localeCompare(left)));
  }
}

export interface PostgresPublicationStoreOptions {
  readonly db: Postgres;
  readonly onError?: (operation: string, error: unknown) => void;
}

export class PostgresPublicationStore implements PublicationStore {
  readonly durable = true;

  constructor(private readonly options: PostgresPublicationStoreOptions) {}

  async publish(publication: Publication): Promise<void> {
    const { db } = this.options;
    try {
      await db.query(
        `insert into ${db.schema}.month_publications
           (id, month, published_at, published_by, supersedes, reason, document_version, digest, json, csv,
            ordinal, definition_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         on conflict (id) do nothing`,
        [
          publication.id,
          publication.month,
          publication.publishedAt,
          publication.publishedBy,
          publication.supersedes ?? null,
          publication.reason ?? null,
          publication.documentVersion,
          publication.digest,
          publication.json,
          publication.csv,
          publication.ordinal ?? null,
          publication.definitionId ?? null,
        ]
      );
    } catch (error) {
      // The key is `id`, and `on conflict (id) do nothing` has already absorbed a repeated one, so a
      // violation that gets here is the other constraint: the month and the position.
      if (!isUniqueViolation(error)) throw error;
      throw new PublicationRaceError(publication.month);
    }
  }

  async ofMonth(month: MonthId, scope?: AssessmentScope): Promise<readonly Publication[]> {
    const operation = `read the publications of ${month}`;
    const scoped = applyScope('where month = $1 order by published_at asc', [month], scope);
    const rows = await this.read(operation, scoped.fragment, scoped.values);
    return inPublishedOrder(this.revived(rows, operation));
  }

  async byId(id: string, scope?: AssessmentScope): Promise<Publication | undefined> {
    const operation = `read publication ${id}`;
    const scoped = applyScope('where id = $1', [id], scope);
    const rows = await this.read(operation, scoped.fragment, scoped.values);
    return this.revived(rows, operation)[0];
  }

  async months(scope?: AssessmentScope): Promise<readonly MonthId[]> {
    const { db } = this.options;
    const operation = 'list the months that have been published';
    try {
      const scoped = applyScope('order by month desc', [], scope);
      const { rows } = await db.query<{ month: string }>(
        `select month from ${db.schema}.month_publications ${scoped.fragment}`,
        scoped.values
      );
      const seen = new Set<MonthId>();
      for (const row of rows) {
        const month = parseMonth(row.month);
        if (month != null) seen.add(month);
      }
      return [...seen];
    } catch (error) {
      this.options.onError?.(operation, error);
      return [];
    }
  }

  private async read(operation: string, where: string, values: readonly unknown[]): Promise<PublicationRow[]> {
    const { db } = this.options;
    try {
      const { rows } = await db.query<PublicationRow>(
        `select id, month, published_at, published_by, supersedes, reason, document_version, digest, json, csv,
                ordinal, definition_id
           from ${db.schema}.month_publications ${where}`,
        values
      );
      return rows;
    } catch (error) {
      this.options.onError?.(operation, error);
      return [];
    }
  }

  private revived(rows: readonly PublicationRow[], operation: string): Publication[] {
    const publications = rows.map(revive);
    const unreadable = publications.filter((publication) => publication == null).length;
    if (unreadable > 0) {
      this.options.onError?.(
        operation,
        new Error(`${String(unreadable)} stored publication row(s) could not be read`)
      );
    }
    return publications.filter((publication): publication is Publication => publication != null);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error != null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

/** The columns as they come back from the driver, before revival proves them a `Publication`. */
interface PublicationRow {
  readonly id: unknown;
  readonly month: unknown;
  readonly published_at: unknown;
  readonly published_by: unknown;
  readonly supersedes: unknown;
  readonly reason: unknown;
  readonly document_version: unknown;
  readonly digest: unknown;
  readonly json: unknown;
  readonly csv: unknown;
  readonly ordinal: unknown;
  readonly definition_id: unknown;
}

/**
 * A stored row back into a `Publication`, or `undefined` when a field is not what it must be.
 *
 * Unreadable rather than guessed at, for the reason the other stores give: a row that cannot be
 * proven is reported and skipped, not dated now or defaulted, because a publication with a wrong
 * month or an unparseable instant is worse than one that is missing and has been logged.
 */
function revive(row: PublicationRow): Publication | undefined {
  const month = parseMonth(row.month);
  if (month == null) return undefined;
  if (typeof row.id !== 'string' || typeof row.published_by !== 'string') return undefined;
  if (typeof row.digest !== 'string' || typeof row.json !== 'string' || typeof row.csv !== 'string') return undefined;
  if (typeof row.document_version !== 'number') return undefined;

  const publishedAt = new Date(row.published_at as string | number | Date);
  if (Number.isNaN(publishedAt.getTime())) return undefined;

  return {
    id: row.id,
    month,
    publishedAt,
    publishedBy: row.published_by,
    ...(typeof row.supersedes === 'string' ? { supersedes: row.supersedes } : {}),
    ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
    documentVersion: row.document_version,
    digest: row.digest as Digest,
    json: row.json,
    csv: row.csv,
    // Absent on a row written before the column existed, which is a fact about that row and not a gap:
    // see `Publication.ordinal`. Not defaulted from position, because a position guessed here is exactly
    // the invention the field exists to stop.
    ...(typeof row.ordinal === 'number' ? { ordinal: row.ordinal } : {}),
    ...(typeof row.definition_id === 'string' ? { definitionId: row.definition_id } : {}),
  };
}
