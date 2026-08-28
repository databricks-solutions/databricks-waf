// Two requirements the assessment answers by having run at all.
//
// The catalogue names a Unity Catalog admin endpoint for both — `unity-catalog.metastores` and
// `current-metastore-assignment` — and ADR 0016 measured that endpoint as refused to every app
// install. So both were on their way to the attestation page, where a person would have been asked
// to confirm something the app had just relied on.
//
// It had relied on it because `system.information_schema` is a Unity Catalog view. Reading it
// requires a metastore to exist and to be assigned to this workspace; a workspace with no
// assignment cannot answer the query at all, and the failure arrives as a signal that never
// collected rather than as a row saying no. So a census in hand is the assignment, observed. Asking
// a person to confirm it would be asking them to restate the premise of every other number on the
// page.
//
// This is why `measurability` in the catalogue is a claim about where the answer usually lives
// rather than a constraint: the reading here is `derived`, from a signal collected for something
// else, at no additional cost. Two of the 39 unreachable requirements turn out not to need the
// unreachable endpoint.

import type { ControlResolver } from '../resolver.js';
import type { AssetCensus } from '../../collect/sql/shapes.js';
import { evidenceFrom, fromSignal } from './helpers.js';

const CENSUS = 'sql:uc.census';

/**
 * SCP-04-14: a Unity Catalog metastore exists.
 *
 * Cannot fail, and that is stated rather than hidden. The only estate this control would fail for
 * is one where the metastore is absent, and there the census signal is absent too, so the control
 * reports unmeasured with the collection error attached — which says the same thing more precisely
 * than a failure would. A pass here is worth having anyway: it is the premise the governance pillar
 * rests on, and leaving it permanently unanswered implied a doubt that the data does not support.
 */
const metastoreExists = fromSignal<AssetCensus>(CENSUS, ['SCP-04-14'], (census, context) => ({
  outcome: 'pass',
  evidence: [
    evidenceFrom(
      context,
      CENSUS,
      `A Unity Catalog metastore governs this workspace, holding ${census.catalogCount} catalogs and ` +
        `${census.schemaCount} schemas`,
      'A Unity Catalog metastore exists and governs this workspace'
    ),
  ],
  outcomeReason:
    'Observed rather than reported: the assessment reads `system.information_schema`, which is a Unity ' +
    'Catalog view. A workspace with no metastore could not have produced any of the figures on this page.',
}));

/**
 * SCP-04-10: this workspace is attached to that metastore.
 *
 * The same evidence and a separate requirement, because the two come apart in one direction that
 * matters: an account can hold a metastore per region and leave a workspace unassigned to any of
 * them. What settles it here is that the census is scoped to the *current* metastore — the view
 * resolves through the assignment, so rows in it are the assignment.
 *
 * A count of tables still in `hive_metastore` used to ride along in the evidence, on the reasoning
 * that a reader told "the metastore is attached" while most of their tables sat outside it would
 * draw the wrong conclusion from a true sentence. The reasoning was right and the count was always
 * zero, so the sentence it produced was "all N tables are governed by it" — which is the wrong
 * conclusion, asserted by the app rather than drawn by the reader. It now states the assignment and
 * counts what the metastore governs, without implying that is the whole estate.
 */
const metastoreAssigned = fromSignal<AssetCensus>(CENSUS, ['SCP-04-10'], (census, context) => ({
  outcome: 'pass',
  evidence: [
    evidenceFrom(
      context,
      CENSUS,
      `Assigned, and governing ${census.tableCount} tables`,
      'This workspace is assigned to a Unity Catalog metastore'
    ),
  ],
  outcomeReason:
    '`system.information_schema` resolves through the workspace\'s metastore assignment, so a query that ' +
    'returned rows is the assignment. Assignment is not the same as adoption — DG-01-02 measures that.',
}));

export const METASTORE_RESOLVERS: readonly ControlResolver[] = [metastoreExists, metastoreAssigned];
