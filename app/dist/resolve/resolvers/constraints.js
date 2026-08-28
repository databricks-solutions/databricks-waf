import { evidenceFrom, fromSignal, percent, threshold, unmeasured } from "./helpers.js";
import { DETAILS, describedNothing, nameOf, someOf } from "./table-details.js";
//#region server/resolve/resolvers/constraints.ts
const CONSTRAINT_PREFIX = "delta.constraints.";
/**
* The CHECK constraints a table declares, as `name (clause)`, empty where it declares none.
*
* Read from the properties map rather than from any information-schema view, because that is where a
* Delta CHECK constraint is actually recorded and the only place that carries its clause.
*/
function constraintsOf(table) {
	return Object.entries(table.properties).filter(([key]) => key.startsWith(CONSTRAINT_PREFIX)).map(([key, clause]) => `${key.slice(18)} (${clause})`);
}
/** The share of sampled tables that must carry a CHECK constraint for a pass. */
const PASS_SHARE = .8;
const CONSTRAINT_RESOLVERS = [fromSignal(DETAILS, ["REL-02-04"], (details, context) => {
	const empty = describedNothing(details);
	if (empty != null) return empty;
	const passShare = threshold(context.spec, "pass_share", PASS_SHARE);
	const withConstraint = details.tables.filter((table) => constraintsOf(table).length > 0);
	const covered = `${details.tables.length.toLocaleString("en-US")} Delta table${details.tables.length === 1 ? "" : "s"} examined`;
	const declare = (count) => count === 1 ? "declares" : "declare";
	if (withConstraint.length === 0) return unmeasured(`None of the ${covered} ${declare(details.tables.length)} a Delta CHECK constraint, read from the \`delta.constraints.*\` properties. That is not a failure: pipeline expectations and column NOT NULL rules enforce data the same way, and this scan reads neither — so whether rules are declared elsewhere is a question for a person rather than a verdict. Primary and foreign keys are excluded deliberately, because Unity Catalog records them without enforcing them.`, "attestation");
	const share = withConstraint.length / details.tables.length;
	const named = someOf(withConstraint, 3, (table) => `${nameOf(table)}: ${constraintsOf(table).join(", ")}`);
	const expected = `At least ${percent(passShare)} of the sampled tables declare a CHECK constraint`;
	if (share >= passShare) return {
		outcome: "pass",
		evidence: [evidenceFrom(context, DETAILS, `${withConstraint.length.toLocaleString("en-US")} of the ${covered} ${declare(withConstraint.length)} a Delta CHECK constraint that fails a violating write where it is written: ${named}`, expected)],
		outcomeReason: `A CHECK constraint fails a violating write at the write rather than leaving a consumer to catch it, which is what this requirement asks for, and ${withConstraint.length.toLocaleString("en-US")} of the sampled tables ${declare(withConstraint.length)} one. Measured over a sample of the most-read tables, so this is a pass over the sample rather than over the whole metastore, and it reads only CHECK constraints — pipeline expectations and NOT NULL rules enforce the same way and are not in this signal.`
	};
	return unmeasured(`${withConstraint.length.toLocaleString("en-US")} of the ${covered} ${declare(withConstraint.length)} a Delta CHECK constraint (${named}), which is below the ${percent(passShare)} this reading settles a pass at. What the rest enforce is not readable here: pipeline expectations live in the pipeline definition and a column NOT NULL lives in its nullability, and this scan reads neither, so a table without a CHECK constraint is not a table without a rule. Counting those tables as a shortfall would be the failure this reading has no grounds for, so the remainder of the sample is a question for a person.`, "attestation");
})];
//#endregion
export { CONSTRAINT_RESOLVERS };
