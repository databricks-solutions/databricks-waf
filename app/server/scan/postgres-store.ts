// Durable scan history, in Lakebase.
//
// Replaces the Unity Catalog volume this was kept in, which was chosen because a Marketplace
// manifest could not ask a consumer for a database. ADR 0030 dropped Marketplace and ADR 0031
// records the move.
//
// What the volume needed and this does not: a second directory to make the history page cheap,
// filename encoding so a directory listing sorted chronologically, an index format with its own
// version so that adding a summary field did not invalidate every stored scan, and a
// re-summarise path for entries written before the index held what the page shows. All of that
// was working around the absence of an index and an ORDER BY.
//
// Written as the app's service principal, which is the identity that owns the schema. That is
// deliberately a different identity from the one that reads the estate: the estate is read as the
// signed-in user, so nobody sees more than they are entitled to, while scan history is the app's
// own bookkeeping about work a user already did. Anyone who can open the app can read it, which
// is the same authority they have to run the scan again themselves.

import type { Scan } from './scan.js';
import { summarise, type ScanStore, type ScanSummary } from './store.js';
import { decodeScan, encodeScan, UnreadableScanError } from './codec.js';
import type { Postgres } from '../store/postgres.js';
import { digestOf } from '../records/digest.js';
import { applyScope, type AssessmentScope } from '../store/assessment-scope.js';

export interface PostgresScanStoreOptions {
  readonly db: Postgres;
  /** Surfaced when reading fails, so a degraded store explains itself instead of looking empty. */
  readonly onError?: (operation: string, error: unknown) => void;
}

export class PostgresScanStore implements ScanStore {
  readonly durable = true;

  /** Set when a history read failed, cleared when one succeeds. Read by `/api/scans`. */
  private lastFailure: string | undefined;

  constructor(private readonly options: PostgresScanStoreOptions) {}

  unreadable(): string | undefined {
    return this.lastFailure;
  }

  async save(scan: Scan): Promise<void> {
    const { db } = this.options;
    const body = encodeScan(scan);

    // The encoded scan goes in as text and is cast, rather than handed to the driver as an
    // object: `encodeScan` is what decides the stored shape and its version, and letting the
    // driver serialise a `Scan` instead would put a second encoder in the path that nothing
    // tests. The summary is stringified for the same reason — one writer per column.
    // The digest is over the parsed document rather than the text just produced, because the text is
    // not what comes back: `jsonb` stores a parsed document and returns its keys in its own order, so
    // a digest over these bytes would fail to match itself on the very first read. `digestOf`
    // canonicalises first, which is the whole reason that module exists.
    // `definition_id` is the stamp's own `definition.id` promoted to a column, and promoted rather
    // than copied: the body stays the authority and this is the indexed handle `42c` filters on. Null
    // when the stamp has none, which `ScanStamp` documents as a fact about the run — nobody asked for
    // a defined assessment — and not as a gap to be filled in with a guess.
    await db.query(
      `insert into ${db.schema}.scans (id, started_at, summary, body, digest, definition_id)
         values ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
       on conflict (id) do update
         set started_at    = excluded.started_at,
             summary       = excluded.summary,
             body          = excluded.body,
             digest        = excluded.digest,
             definition_id = excluded.definition_id,
             written_at    = now()`,
      [
        scan.id,
        scan.startedAt,
        JSON.stringify(summarise(scan)),
        body,
        digestOf(JSON.parse(body)),
        scan.stamp.definition?.id ?? null,
      ]
    );
  }

  async get(id: string, scope?: AssessmentScope): Promise<Scan | undefined> {
    const { db } = this.options;
    const scoped = applyScope('where id = $1', [id], scope);
    const { rows } = await db.query<{ body: unknown }>(
      `select body from ${db.schema}.scans ${scoped.fragment}`,
      scoped.values
    );

    const body = rows[0]?.body;
    if (body == null) return undefined;

    try {
      // `jsonb` arrives parsed, and `decodeScan` takes the text it wrote, so it is re-serialised
      // rather than being handed a shape the codec never agreed to read. The cost is one
      // stringify per read of a document the driver just parsed; the alternative is a second
      // decode path whose only user is this line.
      return decodeScan(id, JSON.stringify(body));
    } catch (error) {
      this.report(`read scan ${id}`, error);
      // A row written by a different build of the app is not a reason to fail the request. It
      // reads as absent, which the UI already handles.
      if (error instanceof UnreadableScanError) return undefined;
      throw error;
    }
  }

  /**
   * The newest scan, in one query rather than a summary read followed by a body read.
   *
   * Not `history(1)` then `get()`, for two reasons beyond the round trip. A scan whose summary
   * column is unreadable would drop out of the history and take the newest scan with it, leaving a
   * dashboard that says no scan has ever run while the scan itself sits in the table readable by
   * id. And the two-step version can disagree with itself: a scan written between the two queries
   * makes `history` name one row and `get` fetch a different one.
   */
  async latest(scope?: AssessmentScope): Promise<Scan | undefined> {
    const { db } = this.options;
    try {
      const scoped = applyScope('order by started_at desc limit 1', [], scope);
      const { rows } = await db.query<{ id: string; body: unknown }>(
        `select id, body from ${db.schema}.scans ${scoped.fragment}`,
        scoped.values
      );
      const newest = rows[0];
      if (newest == null) return undefined;
      return decodeScan(newest.id, JSON.stringify(newest.body));
    } catch (error) {
      this.report('read the newest scan', error);
      // Same reasoning as `get`: a row this build cannot read is an absent scan, and the app opens
      // on the empty state rather than an error page.
      if (error instanceof UnreadableScanError) return undefined;
      throw error;
    }
  }

  async history(limit = 20, scope?: AssessmentScope): Promise<ScanSummary[]> {
    const { db } = this.options;
    try {
      const scoped = applyScope('order by started_at desc', [], scope);
      const { rows } = await db.query<{ summary: unknown }>(
        `select summary from ${db.schema}.scans ${scoped.fragment} limit $${String(scoped.values.length + 1)}`,
        [...scoped.values, limit]
      );
      this.lastFailure = undefined;
      return rows.map((row) => revive(row.summary)).filter((summary): summary is ScanSummary => summary != null);
    } catch (error) {
      // An unreadable history is a page that says so, not a request that fails. The scans
      // themselves are still openable by id. Remembered as well as logged, because an empty list
      // and a list nobody could read look identical from the client, and one of them means the
      // estate has never been assessed.
      this.report('read scan history', error);
      this.lastFailure = error instanceof Error ? error.message : String(error);
      return [];
    }
  }

  private report(operation: string, error: unknown): void {
    this.options.onError?.(operation, error);
  }
}

/**
 * A stored summary with its two dates restored.
 *
 * There is no version check here, unlike the volume index this replaces. That check existed
 * because a summary written by an earlier build lacked fields the page shows, and the recovery
 * was to open the whole scan and re-summarise it. This schema started empty — ADR 0031 — so there
 * was no earlier shape to meet, and inventing the upgrade path before there was anything to upgrade
 * would have been guessing at which field gets added.
 *
 * A field has since been added: `range`, by row 40h. The spread below is what carries its absence —
 * a row written before it comes back without the key rather than with a zero-width range — and an
 * absent `range` is read as "this run's width was never recorded", which the history page renders
 * as a score with no verdict word beside it. That is the whole upgrade path, and it holds for an
 * optional field a reader can distinguish from a recorded value. A field that could not be
 * distinguished that way would need the re-summarise this paragraph declined to write.
 *
 * A row whose dates do not parse is dropped rather than shown, because a history row rendering
 * "Invalid Date" is worse than a history with one fewer row in it, and the scan is still readable
 * by id.
 */
function revive(raw: unknown): ScanSummary | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const summary = raw as ScanSummary;

  const startedAt = new Date(summary.startedAt);
  const finishedAt = new Date(summary.finishedAt);
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(finishedAt.getTime())) return undefined;
  if (typeof summary.id !== 'string' || summary.id === '') return undefined;

  return { ...summary, startedAt, finishedAt };
}
