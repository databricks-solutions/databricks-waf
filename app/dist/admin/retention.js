//#region server/admin/retention.ts
const RETENTION_CLASSES = [
	"temporary",
	"assessment",
	"governance",
	"advisory"
];
/**
* The approved defaults, in days (AUD-DEC-104).
*
* Days rather than months or years for every class, because a period a customer configures has to be
* comparable with the one beside it and "24 months or 730 days" is two units for one setting. 730 and
* 2555 are the plain readings of 24 months and 7 years, and neither is trying to be a calendar.
*/
const DEFAULT_PERIOD_DAYS = {
	temporary: 30,
	assessment: 730,
	governance: 2555,
	advisory: 90
};
const MAX_PERIOD_DAYS = 36500;
/**
* The one table that cannot be counted or removed by age alone.
*
* Named once and used by both the planning and the sweep, so the two cannot drift into disagreeing
* about which table is the chained one. Everything else here is a set of rows; this is a sequence,
* and both halves have to treat it as one.
*/
const CHAINED_TABLE = "audit_events";
/**
* The tables a sweep touches, in the order it touches them.
*
* The audit log is last, and that ordering is load-bearing for one reason: it is the table that
* records what the sweep did, and a sweep that throws partway through must not already have cut it.
* Removing scans and then failing on decisions is a partial sweep whose account of itself is intact;
* doing it the other way round is a partial sweep that has edited the only place the failure will be
* written down. The act's own event is appended when the route closes the act, which is after the
* trim, so the record of a sweep is above the floor that sweep declared rather than inside the
* prefix it removed.
*
* `written_at` is never the stamp. It says when this app wrote the row, which for an imported
* collection is months after the evidence was collected, and a retention period is a statement about
* the age of the *information* rather than about when it arrived here.
*/
const RETAINED = [
	{
		table: "assessment_setup_drafts",
		retentionClass: "temporary",
		stamp: "saved_at",
		holds: "Assessments somebody started writing and did not submit"
	},
	{
		table: "scans",
		retentionClass: "assessment",
		stamp: "started_at",
		holds: "Completed runs, with every finding and every reading behind them"
	},
	{
		table: "imported_evidence",
		retentionClass: "assessment",
		stamp: "generated_at",
		holds: "Collections an administrator ran and somebody uploaded"
	},
	{
		table: "attestations",
		retentionClass: "governance",
		stamp: "attested_at",
		holds: "Answers a person gave to a requirement no scan can reach"
	},
	{
		table: "decisions",
		retentionClass: "governance",
		stamp: "decided_at",
		holds: "What was accepted, planned, or claimed fixed, and by whom"
	},
	{
		table: "improvement_plans",
		retentionClass: "governance",
		stamp: "created_at",
		holds: "Plans somebody opened, what they were meant to achieve, and who owns them"
	},
	{
		table: "improvement_actions",
		retentionClass: "governance",
		stamp: "plan_created_at",
		holds: "Work raised against a plan, its owner, its definition of done, and every state it moved through"
	},
	{
		table: "validation_attempts",
		retentionClass: "governance",
		stamp: "plan_created_at",
		holds: "Every attempt to validate claimed work, what the estate said, and the ones that failed"
	},
	{
		table: "accepted_risks",
		retentionClass: "governance",
		stamp: "recorded_at",
		holds: "Requirements somebody accepted rather than met, what was holding the line, and who owned it"
	},
	{
		table: "applicability_decisions",
		retentionClass: "governance",
		stamp: "recorded_at",
		holds: "Requirements a customer took out of their own score, why, and who owned the decision"
	},
	{
		table: "notes",
		retentionClass: "governance",
		stamp: "noted_at",
		holds: "Observations somebody wrote about a run, a pillar or a requirement, and who wrote them"
	},
	{
		table: "pillar_reviews",
		retentionClass: "governance",
		stamp: "recorded_at",
		holds: "Each pillar of a review, confirmed or skipped, and who recorded it"
	},
	{
		table: "review_answers",
		retentionClass: "governance",
		stamp: "recorded_at",
		holds: "Answers given from inside a review, joining each attestation to the review that produced it"
	},
	{
		table: "assessment_results",
		retentionClass: "governance",
		stamp: "finalised_at",
		holds: "Finalised assessments, citing the run and the attestation ids they rest on"
	},
	{
		table: "assessment_reviews",
		retentionClass: "governance",
		stamp: "opened_at",
		holds: "Reviews of completed runs, opened so a person can confirm or skip each pillar"
	},
	{
		table: "month_publications",
		retentionClass: "governance",
		stamp: "published_at",
		holds: "Months published as an immutable record of what the operating cadence reported"
	},
	{
		table: "run_attempts",
		retentionClass: "advisory",
		stamp: "started_at",
		holds: "Each attempt at an advisory run, including the ones that were killed and taken over",
		only: (schema) => `run_id in (select id from ${schema}.runs where kind = 'advisory')`
	},
	{
		table: "run_attempts",
		retentionClass: "assessment",
		stamp: "started_at",
		holds: "Each attempt at an assessment run, including the ones that were killed and taken over",
		only: (schema) => `run_id in (select id from ${schema}.runs where kind = 'assessment' or kind is null)`
	},
	{
		table: "plan_extracts",
		retentionClass: "advisory",
		stamp: "advisory_at",
		holds: "The query plans the advisor read, three executions per shape, for comparing one against the next"
	},
	{
		table: "advisories",
		retentionClass: "advisory",
		stamp: "finished_at",
		holds: "What the workload advisor concluded, kept long enough to see whether anybody acted on it"
	},
	{
		table: "runs",
		retentionClass: "advisory",
		stamp: "requested_at",
		holds: "Every advisory run that was asked for, what was asked, and how it ended",
		only: () => "kind = 'advisory'"
	},
	{
		table: "runs",
		retentionClass: "assessment",
		stamp: "requested_at",
		holds: "Every assessment run that was asked for, what was asked, and how it ended",
		only: () => "kind = 'assessment' or kind is null"
	},
	{
		table: "run_checkpoints",
		retentionClass: "temporary",
		stamp: "at",
		holds: "Readings a run had reached, kept only so a retry does not read them again"
	},
	{
		table: "audit_events",
		retentionClass: "governance",
		stamp: "at",
		holds: "Every event this app recorded, including refused and failed actions"
	}
];
/** What the sweep does not touch, and why. Served rather than only commented, so the page can say it. */
const EXEMPT = [
	{
		table: "assessment_definition_versions",
		because: "A run is stamped with the definition version it answers to. Removing the version would leave a finished assessment unable to say what it was of, which is worse than keeping it. The personal data in a definition is its owners, and anonymisation is the answer to that rather than deletion."
	},
	{
		table: "assessment_definitions",
		because: "Held for as long as its versions are, for the same reason."
	},
	{
		table: "serving_declarations",
		because: "The newest row is configuration rather than a record: it is what this organisation currently says it serves, and a period would delete it on an install that had not revised it in a year. The older rows are the revisions, and they are what lets a reader see that the population behind a share changed rather than the estate. The personal data in one is who declared it, and anonymisation is the answer to that rather than deletion."
	}
];
/** The holds in force over a class. A released hold is history and stops nothing. */
function holdsOver(retentionClass, holds) {
	return holds.filter((hold) => hold.releasedAt == null && hold.covers.includes(retentionClass));
}
function cutoffFor(periodDays, now) {
	return /* @__PURE__ */ new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1e3);
}
/**
* What the policy makes eligible, without removing anything.
*
* Always the whole picture rather than only the eligible rows: a page that showed "4 scans eligible"
* and nothing else cannot answer the question an administrator actually has, which is whether the
* period is right. The total and the age of the oldest row are what makes that judgeable.
*
* A held class still reports what it would remove. Reporting zero would make a hold look like a
* period nothing has aged past, and the two are different facts about the same install — one lifts
* when somebody lifts it, and the other lifts on its own.
*/
async function planRetention(gateway, policy, holds, now = /* @__PURE__ */ new Date()) {
	const classes = [];
	let wouldRemove = 0;
	for (const retentionClass of RETENTION_CLASSES) {
		const periodDays = policy.periods[retentionClass];
		const cutoff = cutoffFor(periodDays, now);
		const heldBy = holdsOver(retentionClass, holds);
		const tables = await Promise.all(RETAINED.filter((one) => one.retentionClass === retentionClass).map(async (one) => ({
			...one.table === "audit_events" ? await gateway.countAuditPrefix(cutoff) : await gateway.count(one.table, one.stamp, cutoff, one.only),
			holds: one.holds
		})));
		if (heldBy.length === 0) wouldRemove += tables.reduce((sum, table) => sum + table.eligible, 0);
		classes.push({
			retentionClass,
			periodDays,
			cutoff,
			heldBy,
			tables
		});
	}
	return {
		at: now,
		policy,
		classes,
		holds,
		exempt: EXEMPT,
		wouldRemove
	};
}
/**
* Removes what the policy makes eligible, and answers what it removed.
*
* The audit log last, for the reason on `RETAINED`: it is where a failure partway through will be
* recorded, so it is the last thing a failure partway through should have touched. Held classes are
* skipped whole rather than partly — a hold that removed the oldest half of a class would preserve
* nothing worth preserving.
*/
async function sweepRetention(gateway, policy, holds, by, now = /* @__PURE__ */ new Date()) {
	const removals = [];
	const held = [];
	let auditFloor;
	for (const retentionClass of RETENTION_CLASSES) {
		const heldBy = holdsOver(retentionClass, holds);
		if (heldBy.length > 0) {
			held.push({
				retentionClass,
				holds: heldBy.map((hold) => hold.id)
			});
			continue;
		}
		const before = cutoffFor(policy.periods[retentionClass], now);
		for (const one of RETAINED.filter((table) => table.retentionClass === retentionClass)) {
			if (one.table === "audit_events") {
				const { removed, floor } = await gateway.trimAuditPrefix(before, by);
				if (floor != null) auditFloor = floor;
				removals.push({
					table: one.table,
					retentionClass,
					removed,
					before
				});
				continue;
			}
			removals.push({
				table: one.table,
				retentionClass,
				removed: await gateway.remove(one.table, one.stamp, before, one.only),
				before
			});
		}
	}
	return {
		at: now,
		by,
		removals,
		removed: removals.reduce((sum, removal) => sum + removal.removed, 0),
		held,
		...auditFloor != null ? { auditFloor } : {}
	};
}
/** Why a period was refused, in a sentence naming the bound. Undefined when it is usable. */
function periodRefusal(days) {
	if (typeof days !== "number" || !Number.isInteger(days)) return "A retention period is a whole number of days.";
	if (days < 1) return `A retention period of ${String(days)} days would delete records as fast as they are written. The shortest is ${String(1)} day.`;
	if (days > 36500) return `${String(days)} days is longer than this app can meaningfully promise. The longest is ${String(MAX_PERIOD_DAYS)} days, which is a hundred years.`;
}
/** Why a hold was refused. A hold with no reason and no scope is a hold nobody can act on later. */
function holdRefusal(reason, covers) {
	if (typeof reason !== "string" || reason.trim().length < 10) return "A legal hold needs a reason of at least ten characters. Whoever lifts it will not be whoever placed it.";
	if (!Array.isArray(covers) || covers.length === 0) return `A legal hold has to cover at least one of ${RETENTION_CLASSES.join(", ")}.`;
	const unknown = covers.filter((one) => !RETENTION_CLASSES.includes(one));
	if (unknown.length > 0) return `${unknown.map(String).join(", ")} is not something this app retains. The classes are ${RETENTION_CLASSES.join(", ")}.`;
}
/** The audit target for a hold, so the trail names what was held rather than only that something was. */
function holdTarget(id) {
	return {
		kind: "legal-hold",
		id
	};
}
//#endregion
export { CHAINED_TABLE, DEFAULT_PERIOD_DAYS, EXEMPT, MAX_PERIOD_DAYS, RETAINED, RETENTION_CLASSES, cutoffFor, holdRefusal, holdTarget, holdsOver, periodRefusal, planRetention, sweepRetention };
