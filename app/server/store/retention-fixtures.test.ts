import { describe, expect, it } from 'vitest';
import { RETAINED } from '../admin/retention';
import { SWEPT_VOLUMES } from '../admin/retention-volume';
import { ORIGIN, rowFor } from './retention-fixtures';

const TABLES = [...new Set(RETAINED.map((one) => one.table))];

describe('the rows the retention measurement seeds', () => {
  // The exhaustiveness the switch cannot declare. A table added to the sweep with no branch here
  // throws at seed time rather than seeding nothing — but only if something calls it for every
  // table, and this is that something.
  it('builds a row for every table the sweep visits', () => {
    for (const table of TABLES) {
      expect(() => rowFor(table, 0, 10, 30)).not.toThrow();
    }
  });

  it('refuses a table it has no branch for, rather than returning an empty row', () => {
    expect(() => rowFor('a_table_nobody_added', 0, 10, 30)).toThrow(/No fixture for a_table_nobody_added/);
  });

  // The column the whole measurement turns on. A row missing its stamp would be rejected by the
  // schema — every one of them is `not null` — but the failure would arrive as a driver error deep
  // in a seeding loop, and the reader would be looking at the wrong thing.
  it('stamps every row on the column its sweep entry filters', () => {
    for (const entry of RETAINED) {
      const row = rowFor(entry.table, 3, 10, 30) as Record<string, unknown>;
      expect(Object.keys(row), `${entry.table} has no ${entry.stamp}`).toContain(entry.stamp);
      expect(row[entry.stamp]).toBeInstanceOf(Date);
    }
  });

  // Even spread across the period is what makes the two cutoffs mean what they are named. Row 0 sits
  // at the period boundary, so a cutoff there catches nothing; a cutoff a tenth of the way in catches
  // a tenth. Clustered rows would still produce numbers and they would be about a different sweep.
  it('spreads the stamps evenly from the period boundary to now', () => {
    const total = 100;
    const days = 30;
    const stamps = Array.from(
      { length: total },
      (_, index) => (rowFor('attestations', index, total, days) as { attested_at: Date }).attested_at
    );

    const oldest = stamps[0];
    const newest = stamps.at(-1);
    if (oldest == null || newest == null) throw new Error('no stamps');
    const spanDays = (newest.getTime() - oldest.getTime()) / (24 * 60 * 60 * 1000);
    expect(spanDays).toBeGreaterThan(days * 0.98);
    expect(spanDays).toBeLessThanOrEqual(days);

    // From `ORIGIN`, not from `Date.now()`. Taking it from the clock is the drift the fixed origin
    // exists to remove, and doing it here would reintroduce it in the test that checks for it.
    const cutoff = ORIGIN.getTime() - days * 0.9 * 24 * 60 * 60 * 1000;
    const eligible = stamps.filter((stamp) => stamp.getTime() < cutoff).length;
    expect(eligible).toBe(10);
  });

  it('measures every stamp back from one instant, so a slow seed does not move the boundary', () => {
    const first = (rowFor('notes', 0, 10, 30) as { noted_at: Date }).noted_at;
    const again = (rowFor('notes', 0, 10, 30) as { noted_at: Date }).noted_at;
    expect(first.getTime()).toBe(again.getTime());
  });

  // At each table's own volume, not at a round number. A fixture whose key space is narrower than
  // the volume seeds fewer rows than the measurement then reports, and `on conflict do nothing`
  // makes that silent — which would publish a page count for a table a third the size it claims.
  it('gives every row a distinct key at the volume the measurement seeds', () => {
    // The tables whose key is not `id`, checked on the columns the schema actually keys them by.
    const keys: Readonly<Record<string, readonly string[]>> = {
      assessment_setup_drafts: ['author', 'definition_id'],
      imported_evidence: ['digest'],
      run_checkpoints: ['run_id', 'signal_id'],
      plan_extracts: ['workspace_id', 'shape', 'statement_id'],
      audit_events: ['sequence'],
      improvement_actions: ['id', 'revision'],
      validation_attempts: ['id', 'revision'],
      accepted_risks: ['id', 'revision'],
      applicability_decisions: ['id', 'revision'],
      improvement_plans: ['id', 'revision'],
    };

    for (const table of TABLES) {
      const columns = keys[table] ?? ['id'];
      const rows = SWEPT_VOLUMES.find((one) => one.table === table)?.rows(141) ?? 0;
      expect(rows, `${table} has no volume`).toBeGreaterThan(0);
      const seen = new Set(
        Array.from({ length: rows }, (_, index) => {
          const row = rowFor(table, index, rows, 30) as Record<string, unknown>;
          return columns.map((column) => String(row[column])).join('|');
        })
      );
      expect(seen.size, `${table} repeats a key`).toBe(rows);
    }
  });

  // Past the volume as well as at it, because the write-cost probe inserts a thousand rows beyond
  // whatever was seeded. A key space that wraps at the volume would collide with every one of them
  // and `on conflict do nothing` would price an index against inserts that never happened.
  it('keeps giving distinct keys past the volume, which is where the write probe writes', () => {
    for (const table of TABLES) {
      const rows = SWEPT_VOLUMES.find((one) => one.table === table)?.rows(141) ?? 0;
      const keys = new Set(
        Array.from({ length: 200 }, (_, index) => JSON.stringify(rowFor(table, rows + index, rows + 200, 30)))
      );
      expect(keys.size, `${table} repeats past its volume`).toBe(200);
    }
  });

  // The width rule the module's header states, checked at the boundary that decides it. A body under
  // two kilobytes stays in the heap page and a count pays for it; one over it is TOASTed out and a
  // count does not. Both cases are represented here on purpose, and a fixture that quietly became
  // `{}` everywhere would report every sequential scan as cheap.
  it('writes bodies at the widths the app writes, in and out of line', () => {
    const inLine = rowFor('notes', 0, 10, 30) as { body: string };
    const outOfLine = rowFor('scans', 0, 10, 30) as { body: string };
    expect(inLine.body.length).toBeGreaterThan(400);
    expect(inLine.body.length).toBeLessThan(2_000);
    expect(outOfLine.body.length).toBeGreaterThan(100_000);
  });

  // Filler that compresses is filler that does not measure what a real body costs, which is why
  // `prose` is words. A run of one character would TOAST down to nothing and the page count with it.
  it('fills bodies with words rather than a repeated character', () => {
    const { body } = rowFor('scans', 1, 10, 30) as { body: string };
    const distinct = new Set(body.split(/\W+/).filter((word) => word.length > 0));
    expect(distinct.size).toBeGreaterThan(10);
  });

  // `run_attempts` is swept through a subquery on `runs.kind`, so its rows have to name runs that
  // exist. A fixture that did not would measure a semi-join matching nothing.
  it('names run ids that the runs fixture also produces', () => {
    const runIds = new Set(Array.from({ length: 200 }, (_, index) => (rowFor('runs', index, 200, 730) as { id: string }).id));
    const attempts = Array.from(
      { length: 50 },
      (_, index) => (rowFor('run_attempts', index, 50, 730) as { run_id: string }).run_id
    );
    expect(attempts.every((one) => runIds.has(one))).toBe(true);
  });

  it('gives runs both kinds, so the sweep’s `only` clause selects a share rather than all or none', () => {
    const kinds = Array.from({ length: 118 }, (_, index) => (rowFor('runs', index, 118, 730) as { kind: string }).kind);
    expect(kinds.filter((one) => one === 'advisory').length).toBeGreaterThan(0);
    expect(kinds.filter((one) => one === 'assessment').length).toBeGreaterThan(0);
  });
});
