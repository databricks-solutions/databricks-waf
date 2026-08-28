import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { customerCatalogPredicate } from '../server/collect/sql/queries.js';
import { count, customerCatalog, firstRow, metricsVerdict, only } from './measure-table-layout-inputs.mjs';
import type { Probe, TableLayoutInputs } from './measure-table-layout-inputs.d.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINES = join(HERE, '..', 'server', 'collect', 'sql', 'runtime-baseline');

function read(estate: string): TableLayoutInputs {
  return JSON.parse(readFileSync(join(BASELINES, `${estate}-table-layout-inputs.json`), 'utf8')) as TableLayoutInputs;
}

const labs = read('labs');
const fieldEng = read('large-estate');
const estates: readonly (readonly [string, TableLayoutInputs])[] = [
  ['labs', labs],
  ['large-estate', fieldEng],
];

function probeIn(recording: TableLayoutInputs, label: string): Probe {
  const found = recording.probes.find((one) => one.label === label);
  if (found == null) throw new Error(`the recording has no probe called ${label}`);
  return found;
}

describe('an empty reading is separated from an unreadable one', () => {
  /*
   * The distinction this whole row exists for. `33g` read zero rows from the metrics table and concluded the
   * two rules behind it had no input; the reading could not carry that, because a refusal on a shared estate
   * returns nothing in exactly the same shape as an empty table, and nobody had checked which it was.
   */
  it('calls a zero unwritten only where something else in the schema answered', () => {
    expect(metricsVerdict(true, 0, 47)).toBe('unwritten');
    // The reading `33g` actually had: a zero, and no evidence the reader could have seen a row.
    expect(metricsVerdict(true, 0, 0)).toBe('empty-and-grant-unconfirmed');
    expect(metricsVerdict(true, 0, null)).toBe('empty-and-grant-unconfirmed');
  });

  it('never calls a refusal a fact about the platform', () => {
    expect(metricsVerdict(false, null, 173612)).toBe('refused');
    expect(metricsVerdict(true, null, 173612)).toBe('unread');
  });

  it('reports rows where there are rows', () => {
    expect(metricsVerdict(true, 1, 0)).toBe('written');
  });

  it('reads an absent field as no reading rather than as zero', () => {
    // A zero derived from a probe that failed is the one number this script may not produce, so every count
    // it takes is null-on-absent and every share above branches on the probe before it counts.
    expect(count({ rows: '0' }, 'rows')).toBe(0);
    expect(count({ rows: null }, 'rows')).toBeNull();
    expect(count(null, 'rows')).toBeNull();
    expect(count({}, 'rows')).toBeNull();
  });

  it('returns nothing rather than an empty row for a probe that failed', () => {
    const failed: readonly Probe[] = [{ label: 'a', ok: false, ms: 1, error: 'PERMISSION_DENIED' }];
    expect(only(failed, 'a')?.ok).toBe(false);
    expect(firstRow(failed, 'a')).toBeNull();
    expect(firstRow(failed, 'absent')).toBeNull();
    expect(only(failed, 'absent')).toBeNull();
  });

  it('expands the customer-catalog fragment to exactly what the app expands it to', () => {
    // The sample is loaded from the shipped statement rather than reproduced, and this is the one part of it
    // this script has to substitute itself. A fragment left unexpanded is a syntax error; a fragment expanded
    // differently is a reading about a population the control never sees. So this compares against the app's
    // own predicate rather than against a copy of its text: a mirror asserted against string literals drifts
    // the moment the original moves, which is the failure it was written to prevent.
    expect(customerCatalog('WHERE {{customer_catalog t.table_catalog}}')).toBe(
      `WHERE ${customerCatalogPredicate('t.table_catalog')}`
    );
    expect(customerCatalog('WHERE {{customer_catalog table_catalog}}')).toBe(
      `WHERE ${customerCatalogPredicate('table_catalog')}`
    );
    expect(customerCatalog('WHERE {{customer_catalog t.table_catalog}}')).not.toContain('{{');
  });
});

describe('the metrics table is unwritten on both estates, and the reading says why that is a finding', () => {
  for (const [name, recording] of estates) {
    it(`${name}: read unbounded, with the grant established rather than assumed`, () => {
      expect(recording.metricsTable.verdict).toBe('unwritten');
      expect(recording.metricsTable.readable).toBe(true);
      // No window at all, where both prior readings had one and one of them was never written down.
      expect(recording.metricsTable.bounded).toBe(false);
      expect(recording.metricsTable.rows).toBe(0);
      // The sibling is the grant evidence: same schema, same principal, same session, and it answered.
      expect(recording.metricsTable.siblingRows).toBeGreaterThan(0);
      expect(recording.metricsTable.listedInTheSchema).toBe(true);
    });

    it(`${name}: states the population the zero is a zero against`, () => {
      // ADR 0014 reported zero rows against 347 catalogued tables, and the shape of that sentence is what
      // makes a zero mean anything. A count with no denominator is not a reading. Two denominators here,
      // because the wider one counts views that could never have a row in a per-table snapshot.
      expect(recording.metricsTable.cataloguedRelations).toBeGreaterThan(0);
      expect(recording.metricsTable.cataloguedStoredTables).toBeGreaterThan(0);
      expect(recording.metricsTable.cataloguedStoredTables ?? 0).toBeLessThan(
        recording.metricsTable.cataloguedRelations ?? 0
      );
      expect(recording.metricsTable.tables).toBe(0);
    });

    it(`${name}: the relation exists and carries what it would need to`, () => {
      const schema = probeIn(recording, 'the metrics table schema');
      expect(schema.ok).toBe(true);
      const columns = (schema.rows ?? []).map((row) => String(row['col_name']));
      // The three fields the two rules would read. Their presence is why the table keeps being reached for.
      expect(columns).toContain('active_files');
      expect(columns).toContain('active_bytes');
      expect(columns).toContain('predictive_optimization_enabled');
    });
  }

  it('is a reading about two estates of very different sizes, which is what makes it more than labs', () => {
    // 195,010 stored tables and no snapshot of any of them. One metastore's silence could be a metastore;
    // this one is large, shared, and busy enough to have written 173,649 rows to the table beside it.
    expect(fieldEng.metricsTable.cataloguedStoredTables).toBeGreaterThan(100_000);
    expect(labs.metricsTable.cataloguedStoredTables).toBeLessThan(10_000);
    expect(fieldEng.metricsTable.siblingRows).toBeGreaterThan(100_000);
  });
});

describe('the partitioned-table census, bounded', () => {
  it('returned for every catalog it visited, on both estates', () => {
    for (const [, recording] of estates) {
      for (const one of recording.census.perCatalog) {
        expect(one.returned).toBe(true);
        expect(one.partitionedTables).not.toBeNull();
      }
    }
  });

  it('shows the bound was the difference between an answer and no answer', () => {
    // Unbounded, this census did not return inside five and a half minutes on the measurement estate, and
    // `33g` recorded that as a fact about how many partitioned tables there are. Per catalog it takes six
    // minutes a catalog *there* and two seconds a catalog on labs, so the bound is what produced a number.
    const slowest = Math.max(...fieldEng.census.perCatalog.map((one) => one.ms ?? 0));
    const quickest = Math.max(...labs.census.perCatalog.map((one) => one.ms ?? 0));
    expect(slowest).toBeGreaterThan(60_000);
    expect(quickest).toBeLessThan(10_000);
  });

  it('finds partitioning to be rare where there is any at all', () => {
    const partitioned = fieldEng.census.perCatalog.reduce((sum, one) => sum + (one.partitionedTables ?? 0), 0);
    const tables = fieldEng.census.perCatalog.reduce((sum, one) => sum + (one.tables ?? 0), 0);
    expect(partitioned).toBeGreaterThan(0);
    // 150 of 202,348 on the three largest customer catalogs. The claim held here is the order of magnitude
    // rather than the number, because the number is three catalogs of a metastore and moves with the estate.
    expect(partitioned / tables).toBeLessThan(0.01);
    // Labs has none at all, which is the reading `33g` took and reported honestly.
    expect(labs.census.perCatalog.every((one) => one.partitionedTables === 0)).toBe(true);
  });

  it('says what share of the metastore it covered, so the count is not read as an estate', () => {
    // Three catalogs is about a third of either metastore. Without the share beside it, "150 partitioned
    // tables" reads as a total, and the census was bounded precisely because a total did not return.
    for (const [name, recording] of estates) {
      const covered = recording.census.relationsCovered ?? 0;
      const all = recording.metricsTable.cataloguedRelations ?? 0;
      expect(covered, name).toBeGreaterThan(0);
      expect(covered / all, name).toBeLessThan(0.5);
      expect(covered, name).toBe(recording.census.perCatalog.reduce((sum, one) => sum + (one.tables ?? 0), 0));
    }
  });

  it('ranks customer catalogs, since a census of Databricks-owned ones answers a different question', () => {
    // Unfiltered, labs' three largest are `samples`, `system` and a workshop. The controls exclude those, so
    // a census that included them would count tables no finding is ever written about.
    const visited = estates.flatMap(([, recording]) => recording.census.perCatalog.map((one) => one.catalog));
    expect(visited).not.toContain('system');
    expect(visited).not.toContain('samples');
    expect(visited).not.toContain('__databricks_internal');
  });

  it('cannot answer the rule by itself, whatever it counts', () => {
    // The WAF's threshold is a size and this relation carries none, so the census can count partitioned tables
    // and can never say whether one is over-partitioned. That is a property of the relation rather than of
    // either estate, which is why it is asserted once rather than per estate.
    const columns = (probeIn(labs, 'what the census relation carries').rows ?? []).map((row) =>
      String(row['col_name'])
    );
    expect(columns).toContain('partition_index');
    expect(columns.some((name) => /bytes|size|files/i.test(name))).toBe(false);
  });
});

describe('what the shipped controls would see', () => {
  /*
   * The three rules are not unbuilt: over-partitioning is `PE-03-13`, small files is `readFragmentation`
   * behind `CO-03-05` and `PE-03-11`, and maintenance coverage is `PE-03-11` over the predictive-optimization
   * collector. All three read `DESCRIBE DETAIL` and the catalogue rather than the metrics table. So the
   * question this section asks is not whether they exist but whether their input does, here.
   */
  for (const [name, recording] of estates) {
    it(`${name}: every table the sample described carried a size and a file count`, () => {
      expect(recording.sample.described).toBeGreaterThan(0);
      expect(recording.sample.withSizeAndFileCount).toBe(recording.sample.described);
    });
  }

  it('records the refusals as coverage rather than as tables without layout', () => {
    // Refusals are the expected failure on a shared estate, and a recording that counted them as tables with
    // no partitioning would report a clean estate off reads that never happened. So a refused describe carries
    // an error and no layout, and every count above is taken over the ones that carry layout.
    expect(fieldEng.sample.failed).toBeGreaterThan(0);
    const refused = fieldEng.described.filter((one) => one.error != null);
    expect(refused).toHaveLength(fieldEng.sample.failed);
    for (const one of refused) {
      expect(one.partitionColumns).toBeUndefined();
      expect(one.sizeBytes).toBeUndefined();
    }
    // And the tables the counts are taken over are the ones that answered, not the ones that were asked.
    expect(fieldEng.sample.described).toBe(fieldEng.described.length - refused.length);
    expect(fieldEng.sample.partitioned).toBeLessThanOrEqual(fieldEng.sample.described);
    expect(labs.sample.failed).toBe(0);
  });

  it('draws the sample at the two limits the app applies, not at one number chosen here', () => {
    // `collector.ts` binds table_limit 200 and `DescribeCollector` describes the first 50 of what comes back.
    // A reading taken at 25 — which this script first did — ranks against a shorter list and describes a
    // different set, so every sentence about what the control sees would be about a population it never sees.
    expect(fieldEng.selectLimit).toBe(200);
    expect(fieldEng.describeLimit).toBe(50);
    expect(fieldEng.sample.selected).toBe(200);
    expect(fieldEng.sample.attempted).toBe(50);
    // Labs has fewer eligible tables than either cap, so both bind on the estate instead: 38 of 38.
    expect(labs.sample.selected).toBe(labs.sample.eligible);
    expect(labs.sample.attempted).toBe(labs.sample.selected);
  });

  it('states the sample as a fraction of what it was drawn from', () => {
    // 9 described of 184,605 eligible. The controls behind this sample already say so in their own findings;
    // the recording has to, or a count off it reads as an estate.
    expect(fieldEng.sample.eligible).toBeGreaterThan(fieldEng.sample.selected ?? 0);
    expect(labs.sample.eligible).toBeGreaterThan(0);
  });

  it('finds the over-partitioning control has input, and that what it fires on here is an empty table', () => {
    // The one table in either sample that `PE-03-13` would fail. It is partitioned by `region` and holds no
    // bytes in no files, so the finding it produces — partitions too small to skip usefully, and small files
    // that slow every read — is about neither. `48` is that defect; this assertion is what it changes.
    expect(fieldEng.sample.partitioned).toBe(1);
    expect(fieldEng.sample.overPartitioned).toBe(1);
    // And it is not an unread size read as a zero, which is the one way this assertion could pass wrongly.
    expect(fieldEng.sample.sized).toBe(fieldEng.sample.described);
    const [offender] = fieldEng.described.filter((one) => (one.partitionColumns ?? []).length > 0);
    expect(offender?.sizeBytes).toBe(0);
    expect(offender?.fileCount).toBe(0);
  });

  it('finds the fragmentation control has a population on both estates', () => {
    // `readFragmentation` asks its question only of tables holding at least one target-sized file, and
    // reports not-applicable where none does. Both estates clear that on the sample, so the small-files
    // control has an input on both — from the describe, not from the metrics table.
    expect(labs.sample.compactable).toBeGreaterThan(0);
    expect(fieldEng.sample.compactable).toBeGreaterThan(0);
  });
});
