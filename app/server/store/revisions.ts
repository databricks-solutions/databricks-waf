// The newest readable revision of each record, chosen by the database and checked here.
//
// Two stores keep a record as one row per revision and want only the newest of each: Postgres can pick
// it with `distinct on`, and reading every revision to pick it here costs a transfer that grows with
// the retention period rather than with the number of records. What Postgres cannot know is whether
// the row it picked can be read — a row written by another build, or edited behind the app, is a
// document that will not revive — and an acceptance whose revocation will not parse has to go on
// reading as standing rather than disappear. So a record whose top row fails is asked for again, by
// id, with every revision, and the newest one that does read is taken.
//
// The two statements are the callers' because the table is a literal in each of them, which is what
// lets the read-path census see which table a read is of.

/** One stored revision: the record's id and the document in its body column. */
export interface RevisionRow {
  readonly id: string;
  readonly body: unknown;
}

export interface RevisionReads {
  /** One row per id, the highest revision. */
  readonly newest: () => Promise<readonly RevisionRow[]>;
  /** Every revision of the ids given, highest first. */
  readonly history: (ids: readonly string[]) => Promise<readonly RevisionRow[]>;
}

export interface NewestReadable<T> {
  readonly records: T[];
  /** Rows that were looked at and could not be read. A row is counted once however it was reached. */
  readonly unreadable: number;
}

export async function newestReadable<T>(
  reads: RevisionReads,
  revive: (body: unknown) => T | undefined
): Promise<NewestReadable<T>> {
  const records: T[] = [];
  const failed: string[] = [];
  for (const row of await reads.newest()) {
    const record = revive(row.body);
    if (record == null) failed.push(row.id);
    else records.push(record);
  }
  if (failed.length === 0) return { records, unreadable: 0 };

  // Every row of the failed ids comes back, the top row that failed included, so the count is taken here
  // and not above: counting both would report the one unreadable revision twice.
  let unreadable = 0;
  const settled = new Set<string>();
  for (const row of await reads.history(failed)) {
    if (settled.has(row.id)) continue;
    const record = revive(row.body);
    if (record == null) {
      unreadable += 1;
      continue;
    }
    settled.add(row.id);
    records.push(record);
  }
  return { records, unreadable };
}
