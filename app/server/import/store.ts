// Where imported evidence is kept, and why a replay is a constraint rather than a check.
//
// The digest of the probe set is the primary key. That is the whole replay defence, and it is in the
// database rather than in the application on purpose: `trust.ts` also refuses a digest it has seen,
// but it does so by reading a set and then deciding, and two uploads of the same file arriving
// together both read a set that does not contain it. One of them has to lose, and the only thing that
// can reliably make it lose is the unique index. The check in `trust.ts` earns its place by producing
// a sentence an admin can act on; this earns its place by being true under a race.
//
// What is stored is the envelope as it was read, plus what the app concluded about it. Both halves are
// needed and for different readers. The envelope is the evidence, and a finding that cites it has to
// be able to show the reading it came from a year later. The conclusions — who imported it, when, and
// every caution the trust checks raised — are what makes the citation honest: an admin looking at a
// passing control needs to see that the evidence behind it was collected three weeks ago by an
// account admin the CLI could not name.
//
// Nothing here is ever updated or deleted. A superseding collection is a new row with a new digest,
// which is what makes "what did we believe in August, and on what basis" answerable after the estate
// has moved on.

import type { Sql } from '../store/postgres.js';
import type { Envelope } from './envelope.js';
import { summarise, summaryFrom, type EvidenceSummary } from './summary.js';
import type { CautionReason, Note } from './trust.js';

/** An envelope that was accepted, with the app's own record of what it accepted. */
export interface ImportedEvidence {
  /** The digest over the probe set, recomputed at import. The identity of the collection. */
  readonly digest: string;
  /** When the collection ran, from the envelope. */
  readonly generatedAt: Date;
  readonly importedAt: Date;
  /**
   * The signed-in user who uploaded it, which is not the user who collected it.
   *
   * Two different people in the ordinary case — an account admin runs the script and sends the file
   * to whoever is running the assessment — and conflating them would attribute a reading to somebody
   * who never made it. The collecting identity is in the envelope's tiers.
   */
  readonly importedBy: string;
  readonly envelope: Envelope;
  /**
   * What the trust checks said about it, stored rather than recomputed.
   *
   * Recomputing would give a different answer later: the file ages, so a collection accepted as fresh
   * becomes one that would now be refused. The record of what was true at import is what a reader
   * needs, and it is also the only honest basis for a finding that cites it.
   */
  readonly cautions: readonly Note<CautionReason>[];
}

/** Raised when the same probe set is imported twice, whether caught by the check or by the index. */
export class ReplayedImportError extends Error {
  constructor(readonly digest: string) {
    super(
      'These exact readings have already been imported. Nothing was recorded, because a second row ' +
        'for one collection would make a stale posture look like a maintained one.'
    );
    this.name = 'ReplayedImportError';
  }
}

/**
 * One import as the list shows it: what was accepted, without what was accepted.
 *
 * Separate from `ImportedEvidence` because the two readers want opposite things. The scan runner
 * needs every envelope — it revives signals out of them, so there is nothing to trim. The list needs
 * seven derived facts and never looks at a probe, and fetching envelopes to answer it is the cost row
 * 85 measured.
 */
export interface ImportedEvidenceSummary {
  readonly digest: string;
  readonly importedAt: Date;
  readonly importedBy: string;
  /**
   * What the envelope said, including when it was collected.
   *
   * There is no `generatedAt` beside `importedAt` here on purpose. The members of this record are the
   * app's own account of the import — who sent it, when it arrived, what the trust checks said — and
   * everything the envelope claims about itself belongs on the other side of that line, where a
   * reader can see it is the file speaking.
   */
  readonly summary: EvidenceSummary;
  readonly cautions: readonly Note<CautionReason>[];
}

export interface EvidenceImportStore {
  /** True when records survive a restart. Surfaced in the UI, never assumed. */
  readonly durable: boolean;
  /**
   * Every import, newest first, envelopes included.
   *
   * For the scan runner, which applies the readings in them. A caller that only needs to say what is
   * held wants `summaries` — see the comment on `ImportedEvidenceSummary`.
   */
  all(): Promise<readonly ImportedEvidence[]>;
  /** Every import, newest first, as the list shows them. */
  summaries(): Promise<readonly ImportedEvidenceSummary[]>;
  /** The digests already held, for the replay check to produce a message from. */
  digests(): Promise<ReadonlySet<string>>;
  /** Appends one. Raises `ReplayedImportError` when the digest is already held. */
  record(imported: ImportedEvidence): Promise<void>;
}

/** The summary of one held import, for the store that keeps envelopes in memory anyway. */
export function summaryOf(imported: ImportedEvidence): ImportedEvidenceSummary {
  return {
    digest: imported.digest,
    importedAt: imported.importedAt,
    importedBy: imported.importedBy,
    summary: summarise(imported.envelope),
    cautions: imported.cautions,
  };
}

/**
 * Newest import first, ties broken by digest.
 *
 * Not `newestFirstBy`, which orders the append-only logs: those are keyed on a control id and a
 * supersession chain, and an import supersedes nothing — a new collection is a new digest and both
 * remain true of the day they were collected. The digest tiebreak is there so two imports recorded in
 * the same millisecond come back in a stable order rather than whichever the database volunteered.
 */
export function newestFirst(imports: readonly ImportedEvidence[]): ImportedEvidence[] {
  return [...imports].sort(
    (left, right) => right.importedAt.getTime() - left.importedAt.getTime() || left.digest.localeCompare(right.digest)
  );
}

export class InMemoryEvidenceImportStore implements EvidenceImportStore {
  readonly durable = false;

  private readonly held: ImportedEvidence[] = [];

  all(): Promise<readonly ImportedEvidence[]> {
    return Promise.resolve(newestFirst(this.held));
  }

  summaries(): Promise<readonly ImportedEvidenceSummary[]> {
    // Computed per call rather than stored. There is nothing to save here: this store already holds
    // every envelope in the heap, so the read the Postgres one avoids does not exist.
    return Promise.resolve(newestFirst(this.held).map(summaryOf));
  }

  digests(): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set(this.held.map((imported) => imported.digest)));
  }

  record(imported: ImportedEvidence): Promise<void> {
    if (this.held.some((held) => held.digest === imported.digest)) {
      // The same refusal the unique index gives, so the two implementations are not distinguishable
      // by a caller. A memory store that quietly accepted a replay would make the adversarial suite
      // pass against the store nobody runs in production.
      return Promise.reject(new ReplayedImportError(imported.digest));
    }
    this.held.push(imported);
    return Promise.resolve();
  }
}

export interface PostgresEvidenceImportStoreOptions {
  readonly db: Sql & { readonly schema: string };
  /** Reported rather than thrown, matching the other stores: a read failure degrades the page. */
  readonly onError?: (operation: string, error: unknown) => void;
}

interface Row {
  readonly digest: string;
  readonly generated_at: string | Date;
  readonly imported_at: string | Date;
  readonly imported_by: string;
  readonly body: unknown;
  readonly cautions: unknown;
}

/** The same row without the envelope, which is the whole point of the column it reads instead. */
interface SummaryRow {
  readonly digest: string;
  readonly imported_at: string | Date;
  readonly imported_by: string;
  readonly summary: unknown;
  readonly cautions: unknown;
}

/** Postgres error code for a unique violation, which here means exactly one thing. */
const UNIQUE_VIOLATION = '23505';

export class PostgresEvidenceImportStore implements EvidenceImportStore {
  readonly durable = true;

  constructor(private readonly options: PostgresEvidenceImportStoreOptions) {}

  async all(): Promise<readonly ImportedEvidence[]> {
    const { db } = this.options;
    try {
      const { rows } = await db.query<Row>(
        `select digest, generated_at, imported_at, imported_by, body, cautions
           from ${db.schema}.imported_evidence
          order by imported_at desc`
      );
      return rows.map(revive).filter((one): one is ImportedEvidence => one != null);
    } catch (cause) {
      this.options.onError?.('read imported evidence', cause);
      return [];
    }
  }

  async summaries(): Promise<readonly ImportedEvidenceSummary[]> {
    const { db } = this.options;
    try {
      // `body` is deliberately absent. It is the only column in this table that is stored out of
      // line, and leaving it out is what makes this read flat in the size of the envelopes rather
      // than linear in their bytes.
      const { rows } = await db.query<SummaryRow>(
        `select digest, imported_at, imported_by, summary, cautions
           from ${db.schema}.imported_evidence
          order by imported_at desc`
      );

      const held = rows.map(reviveSummary).filter((one): one is ImportedEvidenceSummary => one != null);
      const missing = rows.filter((row) => summaryFrom(row.summary) == null).map((row) => row.digest);
      return missing.length === 0 ? held : [...held, ...(await this.repair(missing))].sort(newestSummaryFirst);
    } catch (cause) {
      this.options.onError?.('read imported evidence summaries', cause);
      return [];
    }
  }

  /**
   * Summarises the rows that have no summary, and writes the answers back.
   *
   * These are rows imported before the column existed. Recomputing rather than backfilling in SQL
   * keeps one definition of what a summary counts, in `summary.ts`, where a change to it is one edit;
   * the alternative puts the same claim in a migration where it can drift silently from the code that
   * renders it. Writing the answer back is what stops this being a permanent second read path — each
   * legacy row costs one detoast once, and an install with none never enters this method.
   *
   * A failed write is not raised. The summary in hand is correct either way, and the next call simply
   * recomputes it; refusing to render the list because a repair could not be persisted would turn a
   * slow page into a broken one.
   */
  private async repair(digests: readonly string[]): Promise<readonly ImportedEvidenceSummary[]> {
    const { db } = this.options;
    const { rows } = await db.query<Row>(
      `select digest, generated_at, imported_at, imported_by, body, cautions
         from ${db.schema}.imported_evidence
        where digest = any($1::text[])`,
      [digests]
    );

    const repaired: ImportedEvidenceSummary[] = [];
    for (const row of rows) {
      const one = revive(row);
      if (one == null) continue;
      const summary = summaryOf(one);
      repaired.push(summary);
      try {
        await db.query(`update ${db.schema}.imported_evidence set summary = $2::jsonb where digest = $1`, [
          row.digest,
          JSON.stringify(summary.summary),
        ]);
      } catch (cause) {
        this.options.onError?.('summarise an import written before the summary column', cause);
      }
    }
    return repaired;
  }

  async digests(): Promise<ReadonlySet<string>> {
    const { db } = this.options;
    try {
      const { rows } = await db.query<{ digest: string }>(`select digest from ${db.schema}.imported_evidence`);
      return new Set(rows.map((row) => row.digest));
    } catch (cause) {
      // An empty set means the replay check finds nothing and the insert below is what refuses the
      // replay. Degrading to "no digests" is safe for that reason and for no other, so it is worth
      // saying here rather than trusting the reader to notice.
      this.options.onError?.('read imported evidence digests', cause);
      return new Set();
    }
  }

  async record(imported: ImportedEvidence): Promise<void> {
    const { db } = this.options;
    try {
      await db.query(
        // The two jsonb columns are cast explicitly. Postgres would infer it from the column type,
        // so this is for the reader and for the fake: a value written without the cast comes back as
        // the text it was sent as, and a store that then skipped reviving it would pass its tests and
        // hand a string to a caller expecting an envelope.
        `insert into ${db.schema}.imported_evidence
           (digest, generated_at, imported_at, imported_by, body, cautions, summary)
         values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
        [
          imported.digest,
          imported.generatedAt.toISOString(),
          imported.importedAt.toISOString(),
          imported.importedBy,
          JSON.stringify(imported.envelope),
          JSON.stringify(imported.cautions),
          // Written in the same statement as the body it is derived from, so the two cannot disagree
          // about what was imported. A summary computed by a later pass could describe a row that a
          // concurrent failure never wrote.
          JSON.stringify(summarise(imported.envelope)),
        ]
      );
    } catch (cause) {
      if (isUniqueViolation(cause)) throw new ReplayedImportError(imported.digest);
      throw cause;
    }
  }
}

function isUniqueViolation(cause: unknown): boolean {
  return typeof cause === 'object' && cause != null && (cause as { code?: unknown }).code === UNIQUE_VIOLATION;
}

/**
 * A stored row back into a record, or nothing when it cannot be read.
 *
 * Dropped rather than guessed at, the same way the attestation store treats an unparseable date: an
 * import whose `generatedAt` does not parse would age unpredictably depending on where it was read.
 */
function revive(row: Row): ImportedEvidence | undefined {
  const generatedAt = new Date(row.generated_at);
  const importedAt = new Date(row.imported_at);
  if (Number.isNaN(generatedAt.getTime()) || Number.isNaN(importedAt.getTime())) return undefined;
  if (row.body == null || typeof row.body !== 'object') return undefined;

  return {
    digest: row.digest,
    generatedAt,
    importedAt,
    importedBy: row.imported_by,
    // Stored as the app read it, so it is returned as it was stored. Re-validating here would mean a
    // schema change could make history unreadable, and history is what the digest is over.
    envelope: row.body as Envelope,
    cautions: Array.isArray(row.cautions) ? (row.cautions as readonly Note<CautionReason>[]) : [],
  };
}

/**
 * A stored row into a summary, or nothing when the summary column cannot be read.
 *
 * Nothing covers two cases that behave identically here: a row written before the column existed, and
 * one whose summary is not the shape `summary.ts` defines. Both are recomputed from the body, so
 * neither needs distinguishing — and a summary this declined to read is the one case where reading
 * the envelope is the cheaper mistake.
 */
function reviveSummary(row: SummaryRow): ImportedEvidenceSummary | undefined {
  const importedAt = new Date(row.imported_at);
  if (Number.isNaN(importedAt.getTime())) return undefined;

  const summary = summaryFrom(row.summary);
  if (summary == null) return undefined;

  return {
    digest: row.digest,
    importedAt,
    importedBy: row.imported_by,
    summary,
    cautions: Array.isArray(row.cautions) ? (row.cautions as readonly Note<CautionReason>[]) : [],
  };
}

/** The order `newestFirst` gives, over summaries, for merging repaired rows back into the list. */
function newestSummaryFirst(left: ImportedEvidenceSummary, right: ImportedEvidenceSummary): number {
  return right.importedAt.getTime() - left.importedAt.getTime() || left.digest.localeCompare(right.digest);
}
