import { RETENTION_CLASSES, holdsOver } from "./retention.js";
//#region server/admin/reset.ts
/**
* Every table this app owns, in the order a reset empties them.
*
* The list is here rather than derived from `ensureSchema`, because a reset needs an order and a
* sentence per table and neither belongs in a DDL function. `reset.test.ts` holds it to the schema:
* it boots the fake through `ensureSchema`, scrapes the tables that get created, and fails when the
* two sets differ. So adding a table without deciding what a reset does with it is a failing test
* rather than data that quietly survives being emptied.
*
* # Why the two audit tables are last, in that order
*
* Last for the reason the sweep gives: the log is where a reset that throws partway through gets
* recorded, so it has to be the last thing such a reset has touched. Removing scans and then failing
* on notes leaves an install whose account of the failure is intact; doing it the other way round
* leaves a half-emptied install with nothing saying what happened.
*
* `audit_events` before `audit_floor` is the less obvious half. A crash between the two leaves an empty
* log with a floor still declaring where the last sweep cut: `head()` continues from that floor, the
* next event chains from its digest, and verification reads clean while saying the log begins above a
* trim. That sentence is stale — it was a reset, not a trim. The other order leaves the prefix gone
* with nothing left to account for it, which verification reports as a gap the app itself caused and
* can no longer explain. Between a stale explanation and an unexplainable break, take the stale one.
*/
const RESET_TABLES = [
	{
		table: "assessment_setup_drafts",
		holds: "Assessments somebody started writing and did not submit",
		swept: true,
		context: {
			kind: "scoped",
			because: "A draft is a draft of one assessment, and reads already filter on it"
		}
	},
	{
		table: "imported_evidence",
		holds: "Collections an administrator ran and somebody uploaded",
		swept: true,
		context: {
			kind: "installation-wide",
			because: "Keyed by the probe-set digest, which is the replay defence"
		}
	},
	{
		table: "attestations",
		holds: "Answers a person gave to a requirement no scan can reach",
		swept: true,
		context: {
			kind: "scoped",
			because: "An answer defaults to the assessment it was given under"
		}
	},
	{
		table: "decisions",
		holds: "What was accepted, planned, or claimed fixed, and by whom",
		swept: true,
		context: {
			kind: "scoped",
			because: "A decision is about a requirement of one assessment"
		}
	},
	{
		table: "improvement_plans",
		holds: "Plans somebody opened, and who owns them",
		swept: true,
		context: {
			kind: "scoped",
			because: "A plan is raised from the findings of one assessment"
		}
	},
	{
		table: "improvement_actions",
		holds: "Work raised against a plan, and every state it moved through",
		swept: true,
		context: {
			kind: "by-parent",
			parent: "improvement_plans",
			because: "An action belongs to the assessment its plan does"
		}
	},
	{
		table: "validation_attempts",
		holds: "Every attempt to validate claimed work, including the ones that failed",
		swept: true,
		context: {
			kind: "by-parent",
			parent: "improvement_actions",
			because: "An attempt belongs to the assessment its action does"
		}
	},
	{
		table: "accepted_risks",
		holds: "Requirements somebody accepted rather than met, and who owned them",
		swept: true,
		context: {
			kind: "scoped",
			because: "An acceptance is a judgement made under one assessment"
		}
	},
	{
		table: "applicability_decisions",
		holds: "Requirements a customer took out of their own score, and who owned the decision",
		swept: true,
		context: {
			kind: "scoped",
			because: "Taking a requirement out of a score names which score"
		}
	},
	{
		table: "notes",
		holds: "Observations somebody wrote, and who wrote them",
		swept: true,
		context: {
			kind: "scoped",
			because: "A note is written against a requirement of one assessment"
		}
	},
	{
		table: "serving_declarations",
		holds: "Which relations a customer says they serve, and what those must carry",
		swept: true,
		context: {
			kind: "scoped",
			because: "A declaration is a statement about one assessment’s estate, and two assessments declaring the same relations are two statements"
		}
	},
	{
		table: "review_answers",
		holds: "Answers given from inside a review, joining each attestation to the review that produced it",
		swept: true,
		context: {
			kind: "by-parent",
			parent: "assessment_reviews",
			because: "An answer record belongs to the assessment its review does"
		}
	},
	{
		table: "pillar_reviews",
		holds: "Each pillar of a review, confirmed or skipped, and who recorded it",
		swept: true,
		context: {
			kind: "by-parent",
			parent: "assessment_reviews",
			because: "A pillar record belongs to the assessment its review does"
		}
	},
	{
		table: "assessment_results",
		holds: "Finalised assessments, citing the run and the attestation ids they rest on",
		swept: true,
		context: {
			kind: "scoped",
			because: "A finalised result is of one assessment, and current is per assessment"
		}
	},
	{
		table: "scans",
		holds: "Completed runs, with every finding and every reading behind them",
		swept: true,
		context: {
			kind: "scoped",
			because: "A run is of one assessment, and the stamp inside the body has said so since A3"
		}
	},
	{
		table: "assessment_reviews",
		holds: "Reviews of completed runs, opened so a person can confirm or skip each pillar",
		swept: true,
		context: {
			kind: "scoped",
			because: "A review is of a run of one assessment"
		}
	},
	{
		table: "month_publications",
		holds: "Months published as an immutable record of what the operating cadence reported",
		swept: true,
		context: {
			kind: "scoped",
			because: "A published month reports one assessment, not the install"
		}
	},
	{
		table: "run_checkpoints",
		holds: "Readings a run in flight had reached, kept so a retry does not read them again",
		swept: true,
		context: {
			kind: "by-parent",
			parent: "runs",
			because: "A reading belongs to the assessment its run does"
		}
	},
	{
		table: "run_attempts",
		holds: "Each attempt at a run, including the ones that were killed",
		swept: true,
		context: {
			kind: "by-parent",
			parent: "runs",
			because: "An attempt belongs to the assessment its run does"
		}
	},
	{
		table: "plan_extracts",
		holds: "The query plans the advisor read, three executions per shape",
		swept: true,
		context: {
			kind: "installation-wide",
			because: "Keyed by workspace and shape, and shared by whichever advisory sees it next"
		}
	},
	{
		table: "advisories",
		holds: "What the workload advisor concluded on each of its runs",
		swept: true,
		context: {
			kind: "scoped",
			because: "An advisory is of one assessment, and has the column already"
		}
	},
	{
		table: "runs",
		holds: "Every run that was asked for, of either kind, and how it ended",
		swept: true,
		context: {
			kind: "scoped",
			because: "A run is of one assessment, of either kind"
		}
	},
	{
		table: "assessment_definition_versions",
		holds: "Every version of every assessment, which is what a finished run cites to say what it was of",
		swept: false,
		context: {
			kind: "installation-wide",
			because: "A version of the thing the others are scoped to"
		}
	},
	{
		table: "assessment_definitions",
		holds: "Every assessment ever defined here, including archived ones",
		swept: false,
		context: {
			kind: "installation-wide",
			because: "This is the thing the others are scoped to"
		}
	},
	{
		table: "retention_periods",
		holds: "How long each class is kept, and who set it. Emptied, so the periods return to their defaults",
		swept: false,
		context: {
			kind: "installation-wide",
			because: "A period is set per class of record, by the install"
		}
	},
	{
		table: "legal_holds",
		holds: "Holds placed and lifted, including the record of what a released hold once preserved",
		swept: false,
		context: {
			kind: "installation-wide",
			because: "A hold stops a sweep, and a sweep is the install’s"
		}
	},
	{
		table: "audit_events",
		holds: "Every event this app recorded. The deletion itself becomes the first entry of the new log",
		swept: true,
		context: {
			kind: "installation-wide",
			because: "One hash chain, or several that cannot show they are whole"
		}
	},
	{
		table: "audit_floor",
		holds: "Where the trail begins, when a sweep has cut the start of it",
		swept: false,
		context: {
			kind: "installation-wide",
			because: "Where the one install-wide trail begins"
		}
	}
];
/** Refused because something says this must not be removed. Thrown rather than returned — see below. */
var InstallHeld = class extends Error {
	holds;
	kind = "held";
	constructor(holds) {
		super(`A legal hold is in force (${holds.map((hold) => hold.id).join(", ")}), and a reset does not override one. Lift it first, which is itself recorded.`);
		this.holds = holds;
	}
};
/** Every in-force hold, whatever it covers. A reset crosses all three classes, so any hold refuses it. */
function holdsRefusingReset(holds) {
	const refusing = /* @__PURE__ */ new Map();
	for (const retentionClass of RETENTION_CLASSES) for (const hold of holdsOver(retentionClass, holds)) refusing.set(hold.id, hold);
	return [...refusing.values()];
}
/**
* What a reset would destroy, without destroying it.
*
* Every table, including the empty ones. A plane that listed only the tables with rows in them would
* shrink as the install emptied and would never quite say what the act covers, and "audit_floor: 0"
* is the line that tells a reader the act reaches the thing that explains their trail.
*/
async function planReset(gateway, holds, now = /* @__PURE__ */ new Date()) {
	const tables = await Promise.all(RESET_TABLES.map(async (one) => ({
		...one,
		rows: await gateway.countRows(one.table)
	})));
	const events = tables.find((one) => one.table === "audit_events")?.rows ?? 0;
	return {
		at: now,
		tables,
		records: tables.reduce((sum, one) => sum + one.rows, 0) - events,
		events,
		heldBy: holdsRefusingReset(holds)
	};
}
/**
* Empties every table, in the order `RESET_TABLES` declares, as one transaction.
*
* Sequentially rather than in parallel, which matters for one table in the list: the log is emptied
* last so that a failure before it has somewhere to be recorded, and `Promise.all` would make the
* ordering a coincidence of scheduling.
*
* The holds are read *inside* the transaction, after `resetting` has locked the table they live in,
* and that ordering is the guarantee rather than a precaution. Read before the lock, the answer is a
* fact about the past: a hold placed a millisecond later is in the same table this act is about to
* empty, so the check would have passed, the hold would be deleted, and nothing anywhere would say a
* hold had ever existed. Read after it, a concurrent placement is either already committed and refuses
* this reset, or is waiting and finds an install that holds nothing. There is no third case.
*
* A reader rather than an array, for the same reason: an array is a value somebody sampled at a time
* this function cannot see, and the whole point is *when* the read happens.
*
* It refuses on a hold even though the route ahead of it already has, which looks like belt and braces
* because it is. The throw is for the second caller: A4's supervisor will one day run this from a job,
* and a guarantee that lives only in one HTTP handler is a guarantee that lasts until somebody writes
* the second entry point.
*/
async function resetInstall(gateway, holds, by, now = /* @__PURE__ */ new Date()) {
	return gateway.resetting(async (within) => {
		const refusing = holdsRefusingReset(await holds());
		if (refusing.length > 0) throw new InstallHeld(refusing);
		const emptied = [];
		for (const one of RESET_TABLES) emptied.push({
			table: one.table,
			removed: await within.empty(one.table)
		});
		return {
			at: now,
			by,
			emptied,
			rows: emptied.reduce((sum, one) => sum + one.removed, 0),
			tables: emptied.filter((one) => one.removed > 0).length
		};
	});
}
//#endregion
export { InstallHeld, RESET_TABLES, holdsRefusingReset, planReset, resetInstall };
