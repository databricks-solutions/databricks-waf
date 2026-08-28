// DG-01-06, and the one thing that makes it a different control from DG-01-05.
//
// Both take the share of tables carrying a description. This one takes it over the tables
// lineage says something read, and the reason the row exists is that the two numbers come
// apart: measured on labs 2026-08-10, 4 of 19 tables are described and none of the 9 anything
// read are. An estate can raise the estate-wide share by documenting a long tail nobody opens,
// so the test that matters here is that a good estate-wide share does not carry the finding.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { COMPLETE, observed, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { DiscoveryColumns, DiscoveryMetadata, LineageCoverage } from '../../collect/sql/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const DISCOVERY = 'sql:uc.discovery' as SignalId;
const DISCOVERY_COLUMNS = 'sql:uc.discovery_columns' as SignalId;
const LINEAGE = 'sql:uc.lineage_coverage' as SignalId;

const catalogue = loadCatalogue();
const registry = buildRegistry();

function metadata(over: Partial<DiscoveryMetadata> = {}): DiscoveryMetadata {
  return {
    estateTables: 19,
    estateTablesDescribed: 4,
    readTables: 9,
    readTablesDescribed: 0,
    readTablesTagged: 0,
    readTablesOwned: 9,
    readEvents: 1247,
    ...over,
  };
}

function columns(over: Partial<DiscoveryColumns> = {}): DiscoveryColumns {
  return { readTableColumns: 43, readTableColumnsDescribed: 0, ...over };
}

/** A lineage reading that corroborates an empty estate, so E1d's cross-check is satisfied. */
function quietLineage(): LineageCoverage {
  return {
    tableCount: 0,
    tablesWithLineage: 0,
    tablesWrittenWithLineage: 0,
    tablesReadWithLineage: 0,
    lineageEvents: 0,
  };
}

function findingFor(
  value: DiscoveryMetadata,
  lineage: LineageCoverage = quietLineage(),
  columnReading: DiscoveryColumns | null = columns()
) {
  const spec = catalogue.controls.find((control) => control.id === 'DG-01-06');
  if (spec == null) throw new Error('DG-01-06 is not in the catalogue');
  const signals = new Map<SignalId, SignalResult>([
    [DISCOVERY, observed(DISCOVERY, value, 1, COMPLETE)],
    [LINEAGE, observed(LINEAGE, lineage, 1, COMPLETE)],
  ]);
  if (columnReading != null) {
    signals.set(DISCOVERY_COLUMNS, observed(DISCOVERY_COLUMNS, columnReading, 1, COMPLETE));
  }
  return resolveControl(spec, signals, registry.get('DG-01-06'));
}

describe('DG-01-06, discoverability over the assets consumers reach for', () => {
  it('scores the read population, not the estate', () => {
    // The labs reading. 21% of the estate is described and none of what anything read is, and
    // the finding is the second number: an estate scored on the first would read as partial.
    const finding = findingFor(metadata());

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.observed).toMatch(/0 of the 9 tables anything read carry a description \(0%\)/);
  });

  it('reports the estate-wide share beside it, so the gap between the two is visible', () => {
    const finding = findingFor(metadata());
    const detail = finding.evidence.map((item) => item.observed).join(' ');

    expect(detail).toMatch(/Across the whole estate, 4 of 19 do \(21.1%\)/);
  });

  it('passes an estate whose read assets are described, whatever the long tail looks like', () => {
    // The inverse of the case above and the reason the population is narrowed: 500 undescribed
    // tables nobody opens are a DG-01-05 finding and not a discoverability one.
    const finding = findingFor(
      metadata({ estateTables: 519, estateTablesDescribed: 9, readTables: 9, readTablesDescribed: 9 })
    );

    expect(finding.outcome).toBe('pass');
  });

  it('leaves an estate nothing read unmeasured rather than failing it for being idle', () => {
    // Lineage is emitted on access, so an idle estate records the same nothing as one whose
    // assets cannot be found. Scoring zero over an empty population would report the second.
    const finding = findingFor(metadata({ readTables: 0, readTablesOwned: 0, readEvents: 0 }), quietLineage(), {
      readTableColumns: 0,
      readTableColumnsDescribed: 0,
    });

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toMatch(/no population of assets consumers reach for/);
    // Not `unreadable`, which is the default and would send the reader after a grant. Both
    // readings landed; no privilege conjures a read event.
    expect(finding.unmeasured).toBe('attestation');
  });

  it('does send the reader after a grant when the estate reads empty and lineage disagrees', () => {
    // The other empty case, and the one a grant does fix: zero tables from a principal without
    // `BROWSE`, with lineage recording activity against the catalogs it cannot see.
    const busy = { ...quietLineage(), tableCount: 40, tablesWithLineage: 12, lineageEvents: 900 };
    const finding = findingFor(metadata({ estateTables: 0, readTables: 0, estateTablesDescribed: 0 }), busy);

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.unmeasured).toBe('unreadable');
    expect(finding.remedy?.says).toContain('BROWSE');
  });

  it('says the population excludes the consumer who looked and gave up', () => {
    // The limit of the reading, in the finding rather than left implied. A reader quoting this
    // share as "our data is discoverable" is quoting something narrower than that.
    const finding = findingFor(metadata({ readTablesDescribed: 9 }));

    expect(finding.outcomeReason).toMatch(/could not tell what an asset held and gave up reads nothing/);
  });

  it('names the tags, owners and columns it did not score on', () => {
    const detail = findingFor(metadata({ readTablesTagged: 3 }), quietLineage(), columns({ readTableColumnsDescribed: 20 }))
      .evidence.map((item) => item.observed)
      .join(' ');

    expect(detail).toMatch(/3 carry a tag and 9 record an owner/);
    expect(detail).toMatch(/20 of those tables' 43 columns carry a comment \(46.5%\)/);
  });

  // The column half is its own statement as of ADR 0090, because it reads
  // `system.information_schema.columns` and that reference is what takes this measure past an
  // hour on a large estate (row 75). The band never came from it, so the three tests below pin
  // that an estate where it does not return is scored the same and loses only the column line.
  it('scores the same when the column statement did not return', () => {
    const withColumns = findingFor(metadata({ readTablesDescribed: 4 }));
    const without = findingFor(metadata({ readTablesDescribed: 4 }), quietLineage(), null);

    expect(without.outcome).toBe(withColumns.outcome);
    expect(without.outcomeReason).toBe(withColumns.outcomeReason);
  });

  it('drops the column line rather than reporting it absent, when the column statement did not return', () => {
    const detail = findingFor(metadata(), quietLineage(), null)
      .evidence.map((item) => item.observed)
      .join(' ');

    expect(detail).toMatch(/9 record an owner/);
    expect(detail).not.toMatch(/column/i);
    expect(detail).not.toMatch(/unavailable|not read|could not/i);
  });

  it('drops the column line when the columns statement returned but counted none', () => {
    // Division by the count is the reason this branch exists rather than rendering "0 of 0".
    const detail = findingFor(metadata(), quietLineage(), columns({ readTableColumns: 0 }))
      .evidence.map((item) => item.observed)
      .join(' ');

    expect(detail).not.toMatch(/column/i);
  });

  it('bands the read share the same way DG-01-05 bands the estate share', () => {
    // Deliberate, and worth pinning: the two numbers are meant to be read against one ruler, so
    // the difference between them is the estate's and not the catalogue's.
    const ofControl = (id: string) => catalogue.controls.find((control) => control.id === id)?.thresholds;

    expect(ofControl('DG-01-06')).toEqual(ofControl('DG-01-05'));
  });
});
