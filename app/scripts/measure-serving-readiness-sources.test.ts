import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { customerCatalogPredicate } from '../server/collect/sql/queries.js';
import {
  ASSET_EVENT_FIELDS,
  ASSET_FIELDS,
  FEEDBACK_FIELDS,
  SPACE_FIELDS,
  carries,
  count,
  customerCatalog,
  firstRow,
  only,
  verdict,
} from './measure-serving-readiness-sources.mjs';
import type { Probe, ServingReadinessSources } from './measure-serving-readiness-sources.d.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINES = join(HERE, '..', 'server', 'collect', 'sql', 'runtime-baseline');

const fieldEng = JSON.parse(
  readFileSync(join(BASELINES, 'large-estate-serving-readiness-sources.json'), 'utf8')
) as ServingReadinessSources;

describe('the apparatus separates the four things a source can do', () => {
  /*
   * `41d`'s lesson, applied to a reading that is entirely about which sources answer. A probe that raised
   * and a probe that returned nothing are different findings, and a probe that ran out of poll budget is a
   * third — a source that takes seventeen minutes reported as a permission problem is the reading that
   * would have deleted the one cost finding this row exists to produce.
   */
  it('never reads a refusal as an empty source', () => {
    expect(verdict({ label: 'a', ok: false, ms: 1, error: 'PERMISSION_DENIED' }, null)).toBe('refused');
    expect(verdict(null, null)).toBe('refused');
    expect(verdict({ label: 'a', ok: true, ms: 1, rows: [] }, 0)).toBe('empty');
  });

  it('separates a source that would not finish from one that would not answer', () => {
    const ranOut: Probe = {
      label: 'a',
      ok: false,
      ms: 300_000,
      error: 'statement did not succeed: {"state":"RUNNING"}',
    };
    expect(verdict(ranOut, null)).toBe('unfinished');
    expect(verdict({ ...ranOut, error: 'statement did not succeed: {"state":"PENDING"}' }, null)).toBe('unfinished');
    // And a genuine failure still reads as one, whatever else the error text holds.
    expect(verdict({ ...ranOut, error: 'PERMISSION_DENIED on system.access' }, null)).toBe('refused');
  });

  it('reads an absent field as no reading rather than as zero', () => {
    expect(count({ rows: '0' }, 'rows')).toBe(0);
    expect(count({ rows: null }, 'rows')).toBeNull();
    expect(count(null, 'rows')).toBeNull();
    expect(count({}, 'rows')).toBeNull();
    expect(verdict({ label: 'a', ok: true, ms: 1, rows: [] }, null)).toBe('unread');
  });

  it('returns nothing rather than an empty row for a probe that failed', () => {
    const failed: readonly Probe[] = [{ label: 'a', ok: false, ms: 1, error: 'PERMISSION_DENIED' }];
    expect(only(failed, 'a')?.ok).toBe(false);
    expect(firstRow(failed, 'a')).toBeNull();
    expect(only(failed, 'absent')).toBeNull();
  });

  it('expands the customer-catalog fragment to exactly what the app expands it to', () => {
    // Against the app's own predicate rather than against a transcription of it, as the other measurement
    // scripts do: a mirror asserted against string literals drifts the moment the original moves.
    expect(customerCatalog('WHERE {{customer_catalog table_catalog}}')).toBe(
      `WHERE ${customerCatalogPredicate('table_catalog')}`
    );
    expect(customerCatalog('WHERE {{customer_catalog k.catalog_name}}')).toBe(
      `WHERE ${customerCatalogPredicate('k.catalog_name')}`
    );
    expect(customerCatalog('WHERE {{customer_catalog table_catalog}}')).not.toContain('{{');
  });

  it('matches a field by its name and not by a substring of it', () => {
    /*
     * The apparatus defect this row caught in itself. The first pass tested `/space|room|conversation/i`
     * against the assistant-event column list and reported that an event names a Genie space; what it had
     * matched was `workspace_id`. The finding below — that Genie usage is not attributable — is the single
     * most decision-changing thing this measurement produced, and a substring search had it backwards.
     */
    expect(carries(['account_id', 'workspace_id'], SPACE_FIELDS)).toBe(false);
    expect(carries(['workspace_id', 'space_id'], SPACE_FIELDS)).toBe(true);
    expect(carries(['WORKSPACE_ID', 'Space_Id'], SPACE_FIELDS)).toBe(true);
    // Unread stays unread: an absent column list is not a source that carries nothing.
    expect(carries(null, SPACE_FIELDS)).toBeNull();
  });
});

describe('the denominators disagree, which is the finding the phase was ordered around', () => {
  const d = fieldEng.denominators;

  it('takes each denominator from the statement that scores the control, not from a reading of it', () => {
    /*
     * The apparatus correction this section is about, and the reason it is asserted rather than described.
     * The first pass wrote three probes from reading the three statements. Two matched; the third counted
     * distinct lineage sources where `uc_discovery_metadata` counts catalogued tables something read, so
     * it reported a correctly-computed description share over a population `DG-01-06` never scores.
     */
    const shipped = ['uc_asset_census, as shipped', 'uc_lineage_coverage, as shipped', 'uc_discovery_metadata, as shipped'];
    for (const label of shipped) {
      const found = only(fieldEng.probes, label);
      expect(found?.ok, label).toBe(true);
      expect(found?.rows, label).toHaveLength(1);
    }
    expect(d.everyRelation).toBe(Number(firstRow(fieldEng.probes, shipped[0])?.['table_count']));
    expect(d.storedTables).toBe(Number(firstRow(fieldEng.probes, shipped[1])?.['table_count']));
    expect(d.readTables).toBe(Number(firstRow(fieldEng.probes, shipped[2])?.['read_tables']));
  });

  it('counts the same estate three ways, an order of magnitude apart', () => {
    expect(d.everyRelation).toBe(495_558);
    expect(d.storedTables).toBe(187_974);
    expect(d.readTables).toBe(15_826);
    expect((d.everyRelation ?? 0) / (d.readTables ?? 1)).toBeGreaterThan(30);
  });

  it('reports one measure over three populations as three figures', () => {
    /*
     * The whole reason a readiness outcome cannot join these. Description coverage is 13.5% or 34.1%
     * depending only on which shipped statement a reader takes it from, and all three are correctly
     * computed. ADR 0083's rule — that two readings taken over different populations are reported as a
     * pair rather than as a difference — is why this is asserted as three numbers and never as one.
     */
    const share = (part: number | null, whole: number | null) => (100 * (part ?? 0)) / (whole ?? 1);
    expect(share(d.described.everyRelation, d.everyRelation)).toBeCloseTo(13.5, 1);
    expect(share(d.described.storedTables, d.storedTables)).toBeCloseTo(27.0, 1);
    expect(share(d.described.readTables, d.readTables)).toBeCloseTo(34.1, 1);
  });

  it('finds the read population is not a subset of the catalogued one', () => {
    // Lineage names 25,596 sources and 9,770 of them are not relations the catalogue lists at all.
    // `uc_discovery_metadata` joins reads onto the census, so those fall out of its 15,826 silently and
    // no shipped statement reports them — which is why this probe exists beside the three above.
    expect(d.lineageNames).toBe(25_596);
    expect(d.readButNotCatalogued).toBe(9_770);
    expect((d.readButNotCatalogued ?? 0) / (d.lineageNames ?? 1)).toBeGreaterThan(0.3);
    // And what the statement counts is the rest of it, give or take the relations it excludes by schema.
    expect(d.readTables ?? 0).toBeLessThan((d.lineageNames ?? 0) - (d.readButNotCatalogued ?? 0) + 1);
  });

  it('finds nearly half the catalogue is federated rather than held here', () => {
    // 232,617 FOREIGN of 495,558. A governance dimension over "every relation" is mostly a dimension over
    // tables in somebody else's system, which is a fact about what `DG-01-05` scores today.
    expect(d.byType.foreign).toBe(232_617);
    expect((d.byType.foreign ?? 0) / (d.everyRelation ?? 1)).toBeGreaterThan(0.46);
  });
});

describe('a shipped statement costs an hour on this estate, which is row 61', () => {
  const cost = fieldEng.cost;

  it('finds uc_discovery_metadata three orders of magnitude off its labs reading', () => {
    // 4,023,076 ms here against 7,366 ms on labs in the committed runtime baseline. The baseline is read
    // on labs and that is correct; what labs cannot show is a statement whose cost does not scale the way
    // its neighbours do, because on 408 catalogued relations every statement is fast.
    expect(cost['uc_discovery_metadata, as shipped']).toBeGreaterThan(3_600_000);
  });

  it('finds the two statements beside it absorbed the same estate', () => {
    // Same catalogue, same window, same session, same warehouse. So the hour is the statement rather than
    // the estate being large or the warehouse being small, which is what makes it a defect and not a size.
    expect(cost['uc_asset_census, as shipped']).toBeLessThan(120_000);
    expect(cost['uc_lineage_coverage, as shipped']).toBeLessThan(60_000);
    expect((cost['uc_discovery_metadata, as shipped'] ?? 0) / (cost['uc_asset_census, as shipped'] ?? 1)).toBeGreaterThan(40);
  });
});

describe('every candidate source answered, and one of them cannot be collected inside a scan', () => {
  it('read all ten without a refusal, so no verdict here is a grant', () => {
    // On a shared estate a refusal is the expected failure, and it would bound what this reading covers.
    // None happened, which is what lets the numbers above be read as the estate rather than as the token.
    for (const [name, source] of Object.entries(fieldEng.sources)) {
      expect(source.verdict, name).toBe('written');
    }
  });

  it('finds the ABAC relation costs two orders of magnitude more than any other source', () => {
    // 997,720 ms — sixteen and a half minutes — for 720 rows, against 1.2 to 11 seconds for everything
    // else. This is question 2's answer for the candidate sources, and it is a design constraint on `45c`
    // rather than a curiosity: a dimension reading this inside a scan does not have a budget.
    const abac = fieldEng.sources['abacPolicies']?.ms ?? 0;
    const others = Object.entries(fieldEng.sources)
      .filter(([name]) => name !== 'abacPolicies')
      .map(([, source]) => source.ms ?? 0);
    expect(abac).toBeGreaterThan(900_000);
    expect(Math.max(...others)).toBeLessThan(15_000);
    expect(abac / Math.max(...others)).toBeGreaterThan(80);
  });

  it('finds the policy matrix has an input rather than a plan', () => {
    // The audit's fourth point is that masks and filters apply where a classification policy requires
    // them. That is answerable here: 720 policies over 3 securable types, 690 of them keyed on columns,
    // against 1,151,202 classification results over 83,872 tables in 42 classes.
    expect(fieldEng.sources['abacPolicies']?.['with_match_columns']).toBe(690);
    expect(fieldEng.sources['classification']?.['classified_tables']).toBe(83_872);
    expect(fieldEng.sources['classification']?.['distinct_classes']).toBe(42);
  });

  it('finds a required-tag-key rule would be a migration rather than a rule', () => {
    // 2,046 distinct table tag keys across 9,556 tagged tables. An estate with no convention cannot be
    // scored against required keys without first being told what they are, which is `45b`'s problem and
    // not a threshold `45c` can pick.
    expect(fieldEng.sources['tableTags']?.['distinct_keys']).toBe(2_046);
    expect(fieldEng.sources['tableTags']?.['tagged_tables']).toBe(9_556);
  });
});

describe('Genie usage is not attributable from a platform source, and neither is the serving population', () => {
  /*
   * The audit's fifth point asks for attributable usage only where a platform source proves it. Measured,
   * the platform source proves nothing of the kind, and this is why `45c` is being re-scoped rather than
   * built as written.
   */
  it('finds an assistant event names no space, no asset and no feedback', () => {
    expect(fieldEng.genieAttribution.columns).toEqual([
      'account_id',
      'workspace_id',
      'event_id',
      'event_time',
      'event_date',
      'user_agent',
      'initiated_by',
    ]);
    expect(fieldEng.genieAttribution.namesASpace).toBe(false);
    expect(fieldEng.genieAttribution.namesAnAsset).toBe(false);
    expect(fieldEng.genieAttribution.carriesFeedback).toBe(false);
    // And the names it was checked against are in the recording, so the next reader checks the set.
    expect(fieldEng.genieAttribution.lookedFor.space).toEqual([...SPACE_FIELDS]);
    expect(fieldEng.genieAttribution.lookedFor.asset).toEqual([...ASSET_EVENT_FIELDS]);
    expect(fieldEng.genieAttribution.lookedFor.feedback).toEqual([...FEEDBACK_FIELDS]);
  });

  it('is a reading over a population large enough that the absence is the schema', () => {
    // 99,418 events in thirty days from 1,054 initiators across 3 workspaces. The events are there; the
    // columns that would attribute one to a space or a table are not.
    expect(fieldEng.sources['assistantEvents']?.rows).toBe(99_418);
    expect(fieldEng.sources['assistantEvents']?.['initiators']).toBe(1_054);
  });

  it('finds a Genie space does not name its tables, over a complete walk', () => {
    // 4,181 spaces, walked to exhaustion rather than to a page cap — `complete` is what makes the count a
    // total. A space carries a title, a description and a warehouse, and nothing that says which tables
    // it serves, so the serving population cannot be read off the spaces and the audit's second point
    // (explicitly selected or governed by tag) is the only option rather than a preference.
    expect(fieldEng.semanticAssets.genieSpaces.complete).toBe(true);
    expect(fieldEng.semanticAssets.genieSpaces.walked).toBe(4_181);
    expect(fieldEng.semanticAssets.genieSpaces.fields).toEqual([
      'create_time',
      'description',
      'space_id',
      'title',
      'update_time',
      'warehouse_id',
    ]);
    expect(fieldEng.semanticAssets.genieSpaces.namesItsAssets).toBe(false);
    expect(fieldEng.semanticAssets.genieSpaces.lookedFor).toEqual([...ASSET_FIELDS]);
  });

  it('finds the semantic-asset population that does exist', () => {
    // Metric views are a `table_type`, so unlike Genie spaces they are already inside every denominator
    // above: 4,703 of them, which is a dimension with a population rather than one with an intention.
    expect(fieldEng.semanticAssets.metricViews).toBe(4_703);
    expect(fieldEng.semanticAssets.metricViews).toBe(fieldEng.denominators.byType.metricViews);
  });
});

describe('what the recording says about itself', () => {
  it('names the estate it was taken on and the warehouse that took it', () => {
    // On a shared estate the apparatus is part of the reading, and `docs/estates.md` records two probes
    // lost to a host that was not the one the profile named.
    expect(fieldEng.profile).toBe('large-estate');
    expect(fieldEng.host).toBe('https://example.cloud.databricks.com');
    expect(fieldEng.warehouse).not.toBe('');
    expect(fieldEng.lookbackDays).toBe(30);
  });
});
