// Reading every stored record back and asking whether it is still what was written.
//
// The digest column is only worth having if something looks at it. This is that something: it reads
// each row, canonicalises the body, hashes it, and compares. What it can then say is narrow and
// useful — "these 214 records are byte-for-byte what this app wrote, and this one is not" — and the
// narrowness is the point. A row edited in `psql`, a body half-written by a failed deploy, a
// migration that rewrote a field: all three show up here as a mismatch naming the record.
//
// What it cannot say is that nothing was tampered with. An editor who changes a body and recomputes
// the digest passes this check, because both columns are ordinary columns and nothing here is
// secret. Closing that requires the chain and the signature, which is the rest of A3c and is not
// implied here — the report says so in its own words, because the person reading it is exactly the
// person who would otherwise assume otherwise.

import type { Sql } from '../store/postgres.js';
import { CanonicalisationError } from './canonical.js';
import { digestOf, fromBytes, sameDigest } from './digest.js';

/**
 * The tables that hold records, and the column each one is ordered by when only some are read.
 *
 * `versioned` marks the two whose primary key is a pair. A plan and an action are stored as one row
 * per revision, so `id` alone names three rows and an altered one reported as "action-7" would leave
 * whoever has to look at it reading every revision to find which. Those rows are named `action-7@2`.
 *
 * `bytes` marks the one table whose digest does not cover a canonicalised `body`. A published month
 * stores its document as text and its digest over those bytes exactly as a recipient holds them, so it
 * is verified by hashing the column named here rather than by canonicalising a document. It belongs in
 * this list for the reason it is the odd one out: the whole value of that record is that its bytes have
 * not moved, and it was the one table this check did not look at while the report said all stored
 * records were checked.
 */
const TABLES = [
  { table: 'scans', newest: 'started_at', versioned: false },
  { table: 'attestations', newest: 'attested_at', versioned: false },
  { table: 'decisions', newest: 'decided_at', versioned: false },
  { table: 'improvement_plans', newest: 'changed_at', versioned: true },
  { table: 'improvement_actions', newest: 'changed_at', versioned: true },
  // `requested_at` rather than a `changed_at`: the answering row is a second revision of the same
  // attempt, and the date it was asked for is what orders one attempt against the next.
  { table: 'validation_attempts', newest: 'requested_at', versioned: true },
  // `recorded_at` rather than the expiry: the revoking row is a second revision of the same
  // acceptance, and when it was decided is what orders one against the next.
  { table: 'accepted_risks', newest: 'recorded_at', versioned: true },
  // `recorded_at` for the reason the accepted risks give: the revoking row is a second revision of the
  // same decision, and when it was decided is what orders one against the next.
  { table: 'applicability_decisions', newest: 'recorded_at', versioned: true },
  { table: 'notes', newest: 'noted_at', versioned: false },
  { table: 'assessment_reviews', newest: 'opened_at', versioned: false },
  { table: 'pillar_reviews', newest: 'recorded_at', versioned: false },
  { table: 'assessment_results', newest: 'finalised_at', versioned: false },
  // The digest is over the JSON bytes, which are what identifies a publication (ADR 0072) and what a
  // recipient runs `shasum -a 256` on. The CSV is a rendering of the same document and carries its own
  // digest in the export, not in this row, so there is nothing here to check it against.
  { table: 'month_publications', newest: 'published_at', versioned: false, bytes: 'json' },
] as const;

export type RecordTable = (typeof TABLES)[number]['table'];

/**
 * The tables above, in the order they are verified.
 *
 * Exported for the live test, which asserts that the report covers every one of them. A list copied
 * into that test would go stale the first time a table was added here, and a coverage assertion that
 * has gone stale reports coverage it no longer has.
 */
export const RECORD_TABLES: readonly RecordTable[] = TABLES.map((one) => one.table);

/**
 * How many rows of one table are read.
 *
 * A cap rather than everything, because a scan body is tens to hundreds of kilobytes and a year of
 * daily runs is a request that reads a hundred megabytes to answer a question about integrity. The
 * newest are the ones a reader is asking about — the artefact they just exported, the answer they
 * just recorded — and the count that was skipped is reported rather than left out, so a partial
 * check cannot be mistaken for a whole one.
 */
export const DEFAULT_LIMIT = 200;

export interface TableVerification {
  readonly table: RecordTable;
  /** Rows in the table. */
  readonly total: number;
  /** Rows read and compared. Fewer than `total` when the cap bit. */
  readonly checked: number;
  /** Of those checked, how many matched the digest stored beside them. */
  readonly intact: number;
  /**
   * Rows carrying no digest, which is every row written before digests landed.
   *
   * Not a failure and not a pass. They cannot be given a digest now — see the schema comment — so
   * they are counted separately and named as unstamped wherever the number is shown.
   */
  readonly unstamped: number;
  /** The ids whose body no longer hashes to their digest. Named, because the point is to act on it. */
  readonly altered: readonly string[];
  /** Ids whose body could not be canonicalised at all, which is a different fault from a mismatch. */
  readonly unreadable: readonly string[];
}

export interface VerificationReport {
  readonly checkedAt: Date;
  /** True when every row that carries a digest still matches it. Unstamped rows do not affect it. */
  readonly intact: boolean;
  readonly tables: readonly TableVerification[];
  /** What this report does and does not establish, in the words a reader should quote. */
  readonly means: string;
}

export const MEANS =
  'Every record here was hashed when it was written, and the hash was recomputed just now from what ' +
  'is stored. A record reported as altered is not what this app wrote. A record reported as intact ' +
  'has not been changed by anything that did not also update its digest — which a person with write ' +
  'access to the database could do, so this establishes that the records are internally consistent, ' +
  'not that they are authentic.';

export interface VerifyOptions {
  readonly db: Sql & { readonly schema: string };
  readonly limit?: number;
  readonly now?: () => Date;
}

/** Reads back and checks every table, newest rows first. */
export async function verifyRecords(options: VerifyOptions): Promise<VerificationReport> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const tables: TableVerification[] = [];

  for (const entry of TABLES) {
    const bytes = 'bytes' in entry ? entry.bytes : undefined;
    tables.push(await verifyTable(options.db, entry.table, entry.newest, entry.versioned, limit, bytes));
  }

  return {
    checkedAt: (options.now ?? ((): Date => new Date()))(),
    intact: tables.every((one) => one.altered.length === 0 && one.unreadable.length === 0),
    tables,
    means: MEANS,
  };
}

async function verifyTable(
  db: Sql & { readonly schema: string },
  table: RecordTable,
  newest: string,
  versioned: boolean,
  limit: number,
  bytes?: string
): Promise<TableVerification> {
  const counted = await db.query<{ total: unknown }>(`select count(*) as total from ${db.schema}.${table}`);
  const total = Number(counted.rows[0]?.total ?? 0);

  // Aliased to `body` so the loop below reads one row shape whichever column the digest covers.
  const stored = bytes ?? 'body';
  const { rows } = await db.query<{ id: string; revision?: number; body: unknown; digest: string | null }>(
    `select id, ${versioned ? 'revision, ' : ''}${stored} as body, digest from ${db.schema}.${table} ` +
      `order by ${newest} desc limit $1`,
    [limit]
  );

  let intact = 0;
  let unstamped = 0;
  const altered: string[] = [];
  const unreadable: string[] = [];

  for (const row of rows) {
    if (row.digest == null || row.digest === '') {
      unstamped += 1;
      continue;
    }

    const named = row.revision == null ? row.id : `${row.id}@${String(row.revision)}`;
    try {
      if (sameDigest(digestFor(row.body, bytes), row.digest)) intact += 1;
      else altered.push(named);
    } catch (error) {
      // A body that cannot be canonicalised is reported rather than counted as altered: the two mean
      // different things to whoever has to act. A mismatch says the content changed; this says the
      // content is not a document this app could have written, which is a deeper fault and usually a
      // write that never came from here at all.
      if (error instanceof CanonicalisationError) unreadable.push(named);
      else throw error;
    }
  }

  return { table, total, checked: rows.length, intact, unstamped, altered, unreadable };
}

/**
 * The digest of one stored record, computed the way that record's digest was written.
 *
 * A `body` is a document, so it is canonicalised first and the digest covers the canonical bytes. A
 * frozen text column is already the bytes, and canonicalising it would compare a digest over a JSON
 * string against one over the document that string contains — a mismatch on every row, reported as a
 * table full of altered records.
 *
 * A text column read back as anything but a string is not text this app wrote, which is the same fault a
 * body that cannot be canonicalised is, and is reported the same way.
 */
function digestFor(stored: unknown, bytes: string | undefined): string {
  if (bytes == null) return digestOf(stored);
  if (typeof stored !== 'string') throw new CanonicalisationError(`a ${bytes} column that is not text`);
  return fromBytes(Buffer.from(stored, 'utf8'));
}

/**
 * The report as one sentence.
 *
 * Here rather than in the UI because the numbers and the words about them have to agree, and an
 * endpoint that returned only the numbers would leave every consumer to invent the sentence — which
 * is how "verified" ends up on a screen above a table containing an unstamped row.
 */
export function describeVerification(report: VerificationReport): string {
  const checked = report.tables.reduce((sum, one) => sum + one.checked, 0);
  const total = report.tables.reduce((sum, one) => sum + one.total, 0);
  const altered = report.tables.flatMap((one) => one.altered);
  const unreadable = report.tables.flatMap((one) => one.unreadable);
  const unstamped = report.tables.reduce((sum, one) => sum + one.unstamped, 0);

  const scope =
    checked === total
      ? `All ${String(total)} stored records were checked`
      : `The newest ${String(checked)} of ${String(total)} stored records were checked`;

  if (altered.length > 0 || unreadable.length > 0) {
    const named = [...altered, ...unreadable].slice(0, 5).join(', ');
    const rest = altered.length + unreadable.length - Math.min(5, altered.length + unreadable.length);
    return (
      `${scope}, and ${String(altered.length + unreadable.length)} no longer match the digest written ` +
      `with them: ${named}${rest > 0 ? ` and ${String(rest)} more` : ''}. Those records are not what this ` +
      `app wrote.`
    );
  }

  // Said separately rather than as a caveat when every record is unstamped, which is what a database
  // that predates this change looks like on the first read. "Each one still matches the digest written
  // with it" is true of the empty set and reads as a pass, and a pass is the one thing this must not
  // say about records that were never stamped at all.
  if (checked > 0 && unstamped === checked) {
    return (
      `${scope}, and none of them carry a digest: all ${String(checked)} were written before this app ` +
      `recorded them, so nothing here is verified. Records written from now on are.`
    );
  }

  const caveat =
    unstamped === 0
      ? ''
      : ` ${String(unstamped)} of them were written before this app recorded digests and carry none, so ` +
        `they are unstamped rather than verified.`;
  return `${scope} and each one still matches the digest written with it.${caveat}`;
}
