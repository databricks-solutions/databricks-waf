// Delta CHECK constraints declared on the sampled tables.
//
// REL-02-04 asks whether constraints and expectations are declared on production tables, so a
// violation is caught by the platform rather than by a consumer. A Delta CHECK constraint is
// persisted as a `delta.constraints.<name>` entry in the table's properties, which the per-table
// `DESCRIBE DETAIL` pass already reads — so the presence of one is a reading, not a judgement, and
// this measure costs no statement the scan was not already issuing.
//
// What this does not read is the other half of the requirement. Pipeline expectations live in the
// pipeline definition, and a column's NOT NULL lives in the schema's nullability rather than in the
// properties. Both enforce data the same way and neither is in this signal. So the absence of a CHECK
// constraint is not evidence the practice is absent — it is unmeasured, and the requirement is handed
// to a person with that reason. Presence is the only thing this reading can settle, and it settles it
// towards a pass; there is deliberately no failure here, and no partial either, because both are a
// claim about mechanisms this scan cannot see.
//
// The population is a sample of the most-read tables, not the metastore, so a pass here is a pass over
// the sample and the finding says so. `information_schema.check_constraints` is deliberately not the
// source: it publishes the constraint columns and no rows, and `table_constraints` holds only the
// informational keys Unity Catalog records without enforcing — the first pass at this named the view
// and measured nothing, which is why the test below pins the signal to the per-table describe.

import type { ControlResolver, Resolution } from '../resolver.js';
import type { TableDetail, TableDetails } from '../../collect/sql/shapes.js';
import { evidenceFrom, fromSignal, percent, threshold, unmeasured } from './helpers.js';
import { DETAILS, describedNothing, nameOf, someOf } from './table-details.js';

const CONSTRAINT_PREFIX = 'delta.constraints.';

/**
 * The CHECK constraints a table declares, as `name (clause)`, empty where it declares none.
 *
 * Read from the properties map rather than from any information-schema view, because that is where a
 * Delta CHECK constraint is actually recorded and the only place that carries its clause.
 */
function constraintsOf(table: TableDetail): readonly string[] {
  return Object.entries(table.properties)
    .filter(([key]) => key.startsWith(CONSTRAINT_PREFIX))
    .map(([key, clause]) => `${key.slice(CONSTRAINT_PREFIX.length)} (${clause})`);
}

/** The share of sampled tables that must carry a CHECK constraint for a pass. */
const PASS_SHARE = 0.8;

/**
 * REL-02-04: constraints declared on the sampled tables.
 *
 * Two outcomes, and neither is a shortfall. A strong share of the sampled tables carrying a CHECK
 * constraint is a pass; anything else is unmeasured and goes to a person, whether no table declares one
 * or some do — because what the tables without one enforce may be a pipeline expectation or a NOT NULL
 * this signal does not carry, and a score against them would rest on not having read it.
 */
const constraints = fromSignal<TableDetails>(DETAILS, ['REL-02-04'], (details, context): Resolution => {
  const empty = describedNothing(details);
  if (empty != null) return empty;

  const passShare = threshold(context.spec, 'pass_share', PASS_SHARE);
  const withConstraint = details.tables.filter((table) => constraintsOf(table).length > 0);
  // Noun, and the verb for whichever count the sentence puts in front of it. "1 of the 1 Delta tables
  // examined declare" was reaching a reader, and it is the same defect #211 fixed for job triggers.
  const covered = `${details.tables.length.toLocaleString('en-US')} Delta table${details.tables.length === 1 ? '' : 's'} examined`;
  const declare = (count: number) => (count === 1 ? 'declares' : 'declare');

  // Absence is an `attestation` gap, not an `unreadable` one: the source was read in full and the
  // answer is genuinely not in it. That kind is what attaches an "answer this" remedy and lists the
  // requirement on the Answers page, which is where a reading that cannot settle the question belongs.
  if (withConstraint.length === 0) {
    return unmeasured(
      `None of the ${covered} ${declare(details.tables.length)} a Delta CHECK constraint, read from the ` +
        '`delta.constraints.*` ' +
        'properties. That is not a failure: pipeline expectations and column NOT NULL rules enforce data the ' +
        'same way, and this scan reads neither — so whether rules are declared elsewhere is a question for a ' +
        'person rather than a verdict. Primary and foreign keys are excluded deliberately, because Unity ' +
        'Catalog records them without enforcing them.',
      'attestation'
    );
  }

  const share = withConstraint.length / details.tables.length;
  const named = someOf(withConstraint, 3, (table) => `${nameOf(table)}: ${constraintsOf(table).join(', ')}`);
  const expected = `At least ${percent(passShare)} of the sampled tables declare a CHECK constraint`;

  if (share >= passShare) {
    return {
      outcome: 'pass',
      evidence: [
        evidenceFrom(
          context,
          DETAILS,
          `${withConstraint.length.toLocaleString('en-US')} of the ${covered} ${declare(withConstraint.length)} ` +
            `a Delta CHECK constraint that fails a violating write where it is written: ${named}`,
          expected
        ),
      ],
      outcomeReason:
        'A CHECK constraint fails a violating write at the write rather than leaving a consumer to catch it, ' +
        `which is what this requirement asks for, and ${withConstraint.length.toLocaleString('en-US')} of the ` +
        `sampled tables ${declare(withConstraint.length)} one. Measured over a sample of the most-read tables, ` +
        'so this is a pass over ' +
        'the sample rather than over the whole metastore, and it reads only CHECK constraints — pipeline ' +
        'expectations and NOT NULL rules enforce the same way and are not in this signal.',
    };
  }

  // Below the pass share this settles nothing, and used to score `partial`. A partial is a shortfall,
  // and the shortfall would have been the tables carrying no CHECK constraint — which is the claim two
  // paragraphs of this file's header say the signal cannot support, arrived at under a softer name. One
  // table with a constraint among fifty took the estate from unmeasured to scored, and the other
  // forty-nine were counted against it for enforcing their rules somewhere this scan does not read.
  // Presence stays the only verdict here until the signal carries NOT NULL and pipeline expectations.
  return unmeasured(
    `${withConstraint.length.toLocaleString('en-US')} of the ${covered} ${declare(withConstraint.length)} a ` +
      `Delta CHECK constraint (${named}), which is below the ${percent(passShare)} this reading settles a pass ` +
      'at. What the rest enforce is not readable here: pipeline expectations live in the pipeline definition ' +
      'and a column NOT NULL lives in its nullability, and this scan reads neither, so a table without a ' +
      'CHECK constraint is not a table without a rule. Counting those tables as a shortfall would be the ' +
      'failure this reading has no grounds for, so the remainder of the sample is a question for a person.',
    'attestation'
  );
});

export const CONSTRAINT_RESOLVERS: readonly ControlResolver[] = [constraints];
