// How a history is ordered when two records share a timestamp.
//
// Moved here from the volume event log, which is gone. The ordering is not about where records
// are kept: it is about what a supersession chain means, and it outlived the storage it was
// written for.

/** What every logged record has to have, whatever else it holds. */
export interface LoggedEvent {
  readonly id: string;
  /** The requirement this is about. */
  readonly controlId: string;
  /** The record this replaced, so a history is reconstructable rather than overwritten. */
  readonly supersedes?: string;
}

/**
 * Newest first, breaking ties by how much each record supersedes and then by id.
 *
 * Timestamps alone are not enough. Two answers to the same requirement can carry the same
 * millisecond — a correction typed straight after the original, a test that constructs both from
 * one clock — and a reader who sees the superseded one at the top of the list is being told the
 * wrong thing. The chain says which came later regardless of what the clock said, and the id
 * breaks the remaining ties so the order is at least stable.
 */
export function newestFirstBy<T extends LoggedEvent>(records: readonly T[], stampOf: (record: T) => Date): T[] {
  const depth = chainDepths(records);
  return [...records].sort(
    (a, b) =>
      stampOf(b).getTime() - stampOf(a).getTime() ||
      (depth.get(b.id) ?? 0) - (depth.get(a.id) ?? 0) ||
      a.id.localeCompare(b.id)
  );
}

/**
 * How many records each one supersedes, transitively.
 *
 * Guarded against a cycle. A cycle cannot arise from the register, which only ever names a record
 * that already exists, but it can arrive from storage — rows can be edited by anyone with access
 * to the database — and a sort comparator that hangs would take the whole request with it.
 */
function chainDepths(records: readonly LoggedEvent[]): ReadonlyMap<string, number> {
  const byId = new Map(records.map((record) => [record.id, record]));
  const depths = new Map<string, number>();

  for (const record of records) {
    let depth = 0;
    const seen = new Set<string>([record.id]);
    let previous = record.supersedes;
    while (previous != null && !seen.has(previous) && byId.has(previous)) {
      seen.add(previous);
      depth += 1;
      previous = byId.get(previous)?.supersedes;
    }
    depths.set(record.id, depth);
  }

  return depths;
}
