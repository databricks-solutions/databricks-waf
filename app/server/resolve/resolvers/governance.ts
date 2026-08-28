// Data and AI governance resolvers.
//
// The hard part in this pillar is that absence of evidence has two causes and the
// system tables cannot tell them apart. A table with no lineage is either inactive
// or being accessed outside Unity Catalog's view; an estate with no audit events
// either did nothing or lost its audit trail. Where that ambiguity exists the
// resolver reports it in the finding rather than picking the interpretation that
// makes the number look better or worse.

import type { ControlResolver } from '../resolver.js';
import type { Evidence } from '../finding.js';
import type {
  AssetCensus,
  AuditCoverage,
  DiscoveryColumns,
  DiscoveryMetadata,
  LineageCoverage,
} from '../../collect/sql/shapes.js';
import { share } from '../../collect/sql/rows.js';
import {
  bandOutcome,
  bandsOf,
  detailFrom,
  enrichedBy,
  evidenceFrom,
  fromSignal,
  notApplicable,
  observedValue,
  percent,
  threshold,
  unmeasured,
  type Observation,
} from './helpers.js';
import { estateExclusion, SCHEMA_CENSUS, whereTheGapIs } from './segments.js';
import { unestablishedEmptiness } from './visibility.js';

const CENSUS = 'sql:uc.census';
const LINEAGE = 'sql:uc.lineage_coverage';
const AUDIT = 'sql:governance.audit_coverage';
const DISCOVERY = 'sql:uc.discovery';
const DISCOVERY_COLUMNS = 'sql:uc.discovery_columns';

/**
 * DG-01-02 and DG-01-03: one governed metadata plane.
 *
 * This used to measure tables remaining in `hive_metastore`, and that measurement was not
 * merely unreliable — it was structurally always zero, because `system.information_schema`
 * covers the Unity Catalog metastore and the legacy catalog is outside it. So the pass
 * branch below read "All N tables are in Unity Catalog" on an estate with 1,101 tables
 * that were not, and a customer could have quoted that sentence into a steering paper.
 *
 * What replaces it is a count and no claim. The app measures Unity Catalog; a legacy
 * metastore is out of scope rather than unmeasured within scope, because the advice for
 * anything living there is to migrate and that needs no count to give. So the sentence
 * says how much this metastore governs and says nothing about what sits beside it — the
 * word "all" is what made the old one false, and it is not a word this resolver can earn
 * from the census.
 *
 * The consequence to be honest about: with no measurable gap, these two controls pass
 * whenever the metastore holds tables. That is an *honest* unconditional pass where the
 * old one was a false conditional pass, and it is a smaller claim rather than a better
 * measurement. Whether a critical control the app cannot fail should stay
 * `measurability: system-table` is recorded for review in `docs/plan/e1-populations.md`.
 */
const unityCatalogAdoption = enrichedBy(
  [SCHEMA_CENSUS, LINEAGE],
  fromSignal<AssetCensus>(CENSUS, ['DG-01-02', 'DG-01-03'], (census, context) => {
    if (census.tableCount === 0) {
      return (
        unestablishedEmptiness(context) ??
        notApplicable('This metastore contains no tables, so there is no asset estate to govern yet.')
      );
    }

    return {
      outcome: 'pass',
      evidence: [
        evidenceFrom(
          context,
          CENSUS,
          `${census.tableCount} tables are governed by Unity Catalog, across ${census.catalogCount} ` +
            `catalogs and ${census.schemaCount} schemas`,
          'Assets are registered in Unity Catalog rather than a workspace-local Hive metastore'
        ),
        ...excluded(context, census),
      ],
      outcomeReason:
        'Measured within the Unity Catalog metastore, which is the scope of every count here. Anything ' +
        'still held in a legacy Hive metastore is outside that scope and outside this measurement: it ' +
        'sits outside Unity Catalog access control, lineage and audit, and the remedy for it is ' +
        'migration rather than configuration. So this finding says what is governed and does not claim ' +
        'that it is everything.',
    };
  })
);

/**
 * DG-01-05: descriptions on assets.
 *
 * Counted on tables only. Column-level descriptions would be a better measure of
 * whether the estate is actually documented, but reading them means a row per column
 * across the metastore, and the cost of that query is not justified by the
 * improvement in the answer.
 */
const descriptions = enrichedBy(
  [SCHEMA_CENSUS, LINEAGE],
  fromSignal<AssetCensus>(CENSUS, ['DG-01-05'], (census, context) => {
    if (census.tableCount === 0)
      return unestablishedEmptiness(context) ?? notApplicable('This metastore contains no tables to describe.');

    const described = share(census.describedTables, census.tableCount);
    // Where the undescribed tables are, when the per-schema census landed. Documenting an
    // estate is unbounded work and documenting four schemas is not, so the difference
    // between the two sentences is whether anyone starts.
    const gap = whereTheGapIs(context, (schema) => schema.tableCount - schema.describedTables);
    return {
      outcome: bandOutcome(described, bandsOf(context.spec, { pass: 0.8, partial: 0.4 })),
      evidence: [
        evidenceFrom(
          context,
          CENSUS,
          `${census.describedTables} of ${census.tableCount} tables carry a description (${percent(described)})`,
          'Assets carry descriptions so a consumer can tell what they contain without asking'
        ),
        ...(gap != null ? [detailFrom(context, SCHEMA_CENSUS, gap)] : []),
        ...excluded(context, census),
      ],
    };
  })
);

/**
 * DG-01-06: whether a consumer can find and understand an asset without asking a person.
 *
 * The same measure as DG-01-05 over a narrower population, and the narrowing is the whole
 * control. Descriptions across the estate say how documented it is; descriptions across the
 * tables anything actually read say whether the documentation is where the consumers are.
 * Measured on labs 2026-08-10: 4 of 19 tables carry a description, and of the 9 that
 * anything read in the previous 30 days, none did — both true, and only the second answers
 * this question.
 *
 * Scored on descriptions alone, with tags, owners and column comments beside it as detail.
 * A tag is a search key and a column comment is what makes a found table usable, but the
 * bands would have to weight three shares against each other and no measurement here says
 * how. One share, banded the same way DG-01-05 is banded, so the two are comparable on
 * sight; the rest is reported.
 *
 * The column share is an enrichment rather than a requirement, which is ADR 0092 and not a
 * judgement about how much it matters. It reads
 * `system.information_schema.columns`, and that reference took this measure from 52,699 ms
 * to 4,023,076 ms on `large-estate` (row 61a), of which 3,979,324 ms was compilation (row 70),
 * under a predicate no form of which reduces it (row 75). Since it never fed the band, the
 * estate where it cannot return is better served by the other six fields than by nothing.
 *
 * What the reading cannot see is the consumer who looked, could not tell what a table held,
 * and gave up: they read nothing and leave no lineage. So a well-scoring estate is one whose
 * *read* assets are described, which is weaker than one whose assets are all findable. The
 * finding says so rather than the resolver quietly meaning it.
 */
const discoverability = enrichedBy(
  [LINEAGE, DISCOVERY_COLUMNS],
  fromSignal<DiscoveryMetadata>(DISCOVERY, ['DG-01-06'], (metadata, context) => {
    if (metadata.estateTables === 0) {
      return (
        unestablishedEmptiness(context) ??
        notApplicable('This metastore contains no tables, so there is nothing for a consumer to discover.')
      );
    }

    // Nothing read is not a discoverability verdict either way. It is an estate whose assets
    // nobody reached for in the window, and this measure has no population over such an
    // estate — so it goes to the person rather than being scored against zero.
  if (metadata.readTables === 0) {
    return unmeasured(
      `Nothing read any of this metastore's ${metadata.estateTables} tables in the window, so there is no ` +
        'population of assets consumers reach for to measure discoverability over. Lineage is emitted on ' +
        'access, so an estate whose tables are all idle records none of it — which is not the same as an ' +
        'estate whose assets cannot be found, and this scan cannot tell the two apart.',
      // Not the default `unreadable`, which would send the reader after a grant. Both readings
      // landed: the census counted the tables and lineage was read for the window. What is
      // missing is a population, and no privilege creates one — only somebody reading a table
      // does, or somebody answering the question.
      'attestation'
    );
  }

    const described = share(metadata.readTablesDescribed, metadata.readTables);
    const estateDescribed = share(metadata.estateTablesDescribed, metadata.estateTables);
    const columns = observedValue<DiscoveryColumns>(context, DISCOVERY_COLUMNS);

    return {
      outcome: bandOutcome(described, bandsOf(context.spec, { pass: 0.8, partial: 0.4 })),
      evidence: [
        evidenceFrom(
          context,
          DISCOVERY,
          `${metadata.readTablesDescribed} of the ${metadata.readTables} tables anything read carry a ` +
            `description (${percent(described)})`,
          'The assets consumers reach for say what they contain, without a person to ask'
        ),
        detailFrom(
          context,
          DISCOVERY,
          `Across the whole estate, ${metadata.estateTablesDescribed} of ${metadata.estateTables} do ` +
            `(${percent(estateDescribed)})`
        ),
        detailFrom(
          context,
          DISCOVERY,
          `Of those read tables, ${metadata.readTablesTagged} carry a tag and ${metadata.readTablesOwned} ` +
            'record an owner'
        ),
        // Omitted rather than reported absent when the column statement did not return. The
        // reader is told which signals a control read on the evidence page, which is where a
        // missing one belongs; a line here saying a number is unavailable would be a sentence
        // about this app in the middle of three about the estate.
        ...(columns == null || columns.readTableColumns === 0
          ? []
          : [
              detailFrom(
                context,
                DISCOVERY_COLUMNS,
                `${columns.readTableColumnsDescribed} of those tables' ${columns.readTableColumns} columns ` +
                  `carry a comment (${percent(share(columns.readTableColumnsDescribed, columns.readTableColumns))})`
              ),
            ]),
      ],
      outcomeReason:
        `The population is the ${metadata.readTables} tables that appear as a read in lineage over the ` +
        `window, out of ${metadata.estateTables} in the metastore, drawn from ` +
        `${metadata.readEvents.toLocaleString('en-US')} read events. A consumer who searched, could not ` +
        'tell what an asset held and gave up reads nothing, so they are not in this population — which ' +
        'means a good share here says the assets people do use are documented, not that everything is ' +
        'findable.',
    };
  })
);

/** The estate-boundary note, as evidence, when the census excluded anything. */
function excluded(context: Observation, census: AssetCensus): readonly Evidence[] {
  const note = estateExclusion(census);
  return note != null ? [detailFrom(context, CENSUS, note)] : [];
}

/**
 * DG-01-04: lineage.
 *
 * The share is deliberately reported against the whole table estate while the
 * finding says why that denominator overstates the gap. Lineage is emitted on
 * access, so an inactive table has none and never will. Restricting the denominator
 * to active tables would need a second query over query history and would still
 * only move the number, not settle the question.
 */
const lineage = fromSignal<LineageCoverage>(LINEAGE, ['DG-01-04'], (coverage, context) => {
  // The clearest case of E1d, because both readings are columns of the same row: a filtered
  // `table_count` beside an unfiltered `lineage_events`. No enrichment needed.
  if (coverage.tableCount === 0)
    return (
      unestablishedEmptiness(context) ??
      notApplicable('This metastore contains no tables, so there is no lineage to track.')
    );

  const touched = Math.min(coverage.tableCount, coverage.tablesWithLineage);
  const covered = share(touched, coverage.tableCount);

  if (coverage.lineageEvents === 0) {
    return {
      outcome: 'fail',
      evidence: [
        evidenceFrom(
          context,
          LINEAGE,
          `No lineage events were recorded across ${coverage.tableCount} tables in the window`,
          'Reads and writes of governed tables produce lineage'
        ),
      ],
      outcomeReason:
        'No lineage at all means either nothing accessed these tables in the window, or access is ' +
        'happening through paths Unity Catalog does not see. The two need different responses, and ' +
        'the system tables cannot distinguish them.',
    };
  }

  return {
    outcome: bandOutcome(covered, bandsOf(context.spec, { pass: 0.5, partial: 0.15 })),
    evidence: [
      evidenceFrom(
        context,
        LINEAGE,
        `${touched} of ${coverage.tableCount} tables appear in lineage (${percent(covered)}), ` +
          `from ${coverage.lineageEvents} events`,
        'Governed assets appear in lineage, so data flow through the platform is visible'
      ),
    ],
    outcomeReason:
      'The denominator is every table, including ones nothing read or wrote in the window. Lineage is ' +
      'emitted on access, so an idle table has none by definition and the real coverage of active ' +
      'assets is higher than this share.',
  };
});

/**
 * DG-02-02, DG-02-03 and SCP-04-18: audit trail.
 *
 * Recency rather than volume. The audit table exists whether or not anything is
 * being written to it, so its presence proves nothing; a gap since the last event is
 * the signal that something stopped.
 *
 * Three controls because two frameworks and two pillars ask for the same configuration.
 * SCP-04-18 is the security guide's version and its own title says "or see GOV-3", so the
 * duplication is acknowledged at the source; it joins the alias group so one measurement is
 * scored in both pillars rather than the security pillar carrying an unmeasured copy of a
 * requirement the governance pillar has already answered.
 */
const auditLogging = fromSignal<AuditCoverage>(AUDIT, ['DG-02-02', 'DG-02-03', 'SCP-04-18'], (audit, context) => {
  const maxGapDays = threshold(context.spec, 'max_days_since_event', 2);

  // Zero events is two situations that cannot be told apart from here, and only one of
  // them is a finding. The audit tables cannot be turned off, and a user who cannot read
  // them gets a permission error rather than an empty result — so an empty result means
  // either nothing happened in the window or delivery stopped. An account nobody used has
  // no audit trail to be healthy or unhealthy, and reporting that as a failure marks an
  // estate down for being idle. Reported unmeasured, naming both readings.
  if (audit.events === 0) {
    return unmeasured(
      'No audit events were recorded in the window, so whether the audit trail is healthy could not be ' +
        'determined. The audit system tables cannot be disabled and an unreadable one raises a permission ' +
        'error rather than returning nothing, so this means either no activity took place across the ' +
        'assessed workspaces or delivery has stopped. Any activity at all — including running this scan — ' +
        'should produce events, so a second scan that still shows none points at delivery.'
    );
  }

  const gap = audit.daysSinceLastEvent;
  const stale = gap != null && gap > maxGapDays;

  return {
    outcome: stale ? 'partial' : 'pass',
    evidence: [
      evidenceFrom(
        context,
        AUDIT,
        `${audit.events.toLocaleString('en-US')} events across ${audit.services} services and ${audit.actors} actors; ` +
          `last event ${gap == null ? 'at an unrecorded time' : gap === 0 ? 'today' : `${gap} day${gap === 1 ? '' : 's'} ago`}`,
        `Audit events are arriving and no more than ${maxGapDays} days stale`
      ),
      evidenceFrom(
        context,
        AUDIT,
        `${audit.unityCatalogEvents.toLocaleString('en-US')} of them are Unity Catalog events`,
        'Data access through Unity Catalog is audited, not just workspace administration'
      ),
    ],
    ...(stale
      ? {
          outcomeReason: `The most recent audit event is ${String(gap)} days old, which suggests either an idle workspace or interrupted audit delivery.`,
        }
      : {}),
  };
});

/** DG-01-07: AI assets governed alongside data, evidenced by their presence in the metastore. */
const aiAssetGovernance = enrichedBy(
  [LINEAGE],
  fromSignal<AssetCensus>(CENSUS, ['DG-01-07'], (census, context) => {
    // Every branch below argues from the presence of a governed data estate, and with no
    // tables there is none to argue from — "the data estate is fully governed by Unity
    // Catalog" over zero tables is a sentence about nothing. The model and function
    // inventory this control really wants is not collected yet, so with the table census
    // empty there is no evidence at all rather than weak evidence.
    //
    // This one already declined to pass, so E1d changes no outcome here. What it changes is
    // the sentence: "This metastore holds no tables" is a claim about the estate, and where
    // the reading is privilege-limited it is a false one with no remedy attached.
    if (census.tableCount === 0) {
      return (
        unestablishedEmptiness(context) ??
        unmeasured(
          'This metastore holds no tables, and the model and function inventory that would evidence AI asset ' +
            'governance directly is not collected yet, so there is nothing to assess. It is left unmeasured ' +
            'rather than passed: an empty metastore is not evidence that AI assets are governed.'
        )
      );
    }

    // Both branches used to return `partial` and differed only in their sentence, one of which
    // cited the always-zero legacy count. Dropping it loses no outcome.
    return {
      outcome: 'partial',
      evidence: [
        evidenceFrom(
          context,
          CENSUS,
          `${census.catalogCount} Unity Catalog catalogs containing ${census.tableCount} tables`,
          'Models, functions and data share one governance plane'
        ),
      ],
      outcomeReason:
        'Unity Catalog governs a data estate, which is the precondition for governing AI assets with it. ' +
        'Confirming that models and functions are registered there needs an inventory this scan does not ' +
        'yet collect.',
    };
  })
);

export const GOVERNANCE_RESOLVERS: readonly ControlResolver[] = [
  unityCatalogAdoption,
  descriptions,
  discoverability,
  lineage,
  auditLogging,
  aiAssetGovernance,
];
