//#region server/health/health.ts
/**
* Reads every dependency once.
*
* The probes run together rather than in sequence: they are independent, and a database that takes
* three seconds to time out should not make the identity reading three seconds older than it needed
* to be. Neither probe is allowed to reject — each is caught into its own reading — because a health
* endpoint that fails is the least useful thing this could be.
*/
async function readHealth(sources = {}) {
	const now = (sources.now ?? (() => /* @__PURE__ */ new Date()))();
	const [database, identity] = await Promise.all([databaseReading(sources, now), identityReading(sources, now)]);
	const readings = [
		warehouseReading(sources, now),
		database,
		identity,
		auditReading(sources, now)
	];
	return {
		at: now,
		readings,
		well: !readings.some((reading) => reading.standing === "degraded" || reading.standing === "silent"),
		unrecorded: sources.unrecorded ?? 0,
		...sources.auditGaps != null ? { gaps: sources.auditGaps } : {},
		...sources.auditGapsUnreadable != null ? { gapsUnreadable: sources.auditGapsUnreadable } : {}
	};
}
/**
* What the warehouse was last seen doing.
*
* Three cases, and the middle one is why this is worth a function. No binding is `unbound` and has a
* form to fill in. A binding no scan has used yet is `unknown` rather than `answering`, because the
* commonest way for this to be wrong is a warehouse id that names a warehouse the app cannot reach,
* and reporting that as healthy until somebody runs a scan would be the reading that matters being
* wrong for exactly as long as it mattered. A binding whose last run had statements refused is
* `degraded` — the warehouse answered, and the app could not read what it needed.
*/
function warehouseReading(sources, now) {
	if (sources.warehouseId == null || sources.warehouseId === "") return {
		dependency: "warehouse",
		standing: "unbound",
		provenance: "probed",
		at: now,
		detail: "No SQL warehouse is bound, so nothing this app measures from the system tables can run.",
		action: "Open the app in your workspace, choose Edit, and add a SQL warehouse resource. Everything the assessment reads comes from system tables through it."
	};
	const run = sources.lastRun;
	if (run == null) return {
		dependency: "warehouse",
		standing: "unknown",
		provenance: "observed",
		at: now,
		detail: `A warehouse is bound (${sources.warehouseId}) and nothing has used it yet, so whether this app can reach it is not established. Nothing here probes it, because waking a serverless warehouse to answer a status page would bill you for the answer.`,
		action: "Run an assessment. It will say which statements the warehouse answered and which it refused."
	};
	if (run.refused > 0) return {
		dependency: "warehouse",
		standing: "degraded",
		provenance: "observed",
		at: run.at,
		detail: `The warehouse answered the last run and refused ${String(run.refused)} of ${String(run.statements)} statements, so part of the assessment was measured and part of it was not.`,
		action: "Open Checks. It lists every statement, the table it reads and the grant it needs, and names the ones that were refused."
	};
	return {
		dependency: "warehouse",
		standing: "answering",
		provenance: "observed",
		at: run.at,
		detail: `The last run read all ${String(run.statements)} of its statements through the bound warehouse.`
	};
}
async function databaseReading(sources, now) {
	if (sources.pingDatabase == null) return {
		dependency: "database",
		standing: "unbound",
		provenance: "probed",
		at: now,
		detail: sources.storage ?? "No database is bound, so nothing this app records — scan history, answers, decisions — survives a restart.",
		action: "Open the app in your workspace, choose Edit, and add a database resource with CAN_CONNECT_AND_CREATE. The app creates its own schema on first boot."
	};
	try {
		await sources.pingDatabase();
	} catch (cause) {
		return {
			dependency: "database",
			standing: "silent",
			provenance: "probed",
			at: now,
			detail: `A database is bound and did not answer: ${describe(cause)}.`,
			action: "The records are not lost; they are unreachable. If this persists, check that the database resource is running and that the app service principal still has CAN_CONNECT_AND_CREATE on it."
		};
	}
	return {
		dependency: "database",
		standing: sources.durable === false ? "degraded" : "answering",
		provenance: "probed",
		at: now,
		detail: sources.durable === false ? sources.storage ?? "The database answered, and this app is not keeping its records in it." : sources.storage ?? "The database answered.",
		...sources.durable === false ? { action: "Nothing this app records will survive the next deploy. Unset WAF_DEMO_NO_PERSISTENCE and restart to keep it." } : {}
	};
}
async function identityReading(sources, now) {
	if (sources.probeIdentity == null) return {
		dependency: "identity",
		standing: "unknown",
		provenance: "probed",
		at: now,
		detail: "This request carried no forwarded token, so there was nothing to ask the identity endpoint with. Nothing is asked on the app’s own identity, because a membership it holds is not the membership the gate has to check.",
		action: "Open this page while signed in through the app, and it will report what the gate can establish."
	};
	try {
		await sources.probeIdentity();
	} catch (cause) {
		return {
			dependency: "identity",
			standing: "silent",
			provenance: "probed",
			at: now,
			detail: `The identity endpoint did not answer: ${describe(cause)}.`,
			action: "While this lasts, nobody can start a scan, answer a requirement or decide a finding — the gate refuses what it cannot establish. Reading the assessment is unaffected."
		};
	}
	return {
		dependency: "identity",
		standing: "answering",
		provenance: "probed",
		at: now,
		detail: "The identity endpoint answered, so the gate can establish who a caller is and what they may change."
	};
}
/**
* What the trail is missing.
*
* Its own reading rather than a number on the database one, because the two fail separately and the
* operator does different things about them. It is also the only reading here that reports a fault
* which has already happened and cannot be undone: an event that was not written is gone, and
* nothing an operator does now recovers it. Which is exactly why it is volunteered.
*
* Two views of the same loss, and they answer different questions. The count is this instance's and
* lives in memory, so it says what is going wrong now and is zero after a restart or on another
* replica. The markers are in the database, so they say what is missing whichever instance is asked
* and however long ago it was lost, until somebody acknowledges it. A reading that had only the first
* would be clean on the page of the first deploy after an outage.
*/
function auditReading(sources, now) {
	if (sources.unrecorded == null) return {
		dependency: "audit-log",
		standing: "unknown",
		provenance: "probed",
		at: now,
		detail: "This install records no audit events, so there is no trail to report on."
	};
	const marked = markedSentence(sources.auditGaps);
	const outstanding = [marked, sources.auditGapsUnreadable == null ? "" : `The markers for lost audit events could not be read (${sources.auditGapsUnreadable}), so this install cannot say whether any exist.`].filter((one) => one !== "").join(" ");
	const acknowledging = "Acknowledging a gap, in the list below, says that somebody has looked at it. It does not recover the event or change the trail, so what happened has to come from elsewhere.";
	if (sources.unrecorded > 0) {
		const strict = sources.auditPosture === "strict";
		return {
			dependency: "audit-log",
			standing: "degraded",
			provenance: "probed",
			at: now,
			detail: `${String(sources.unrecorded)} ${sources.unrecorded === 1 ? "action" : "actions"} could not be written to the trail since this instance last started. They happened; the record of them did not. A gap in the trail is not a gap in what was done.` + (strict ? " This install refuses an action it cannot reach the trail to record, so a count here is what that check could not prevent: a record that failed after the trail had answered, or a refusal the gate had already made before the check could run." : "") + (outstanding === "" ? "" : ` ${outstanding}`),
			action: (strict ? "The cause is the database reading above. Refusing before the action does not prevent this, so the count is a real gap: read it as you would on any install. If the trail stops answering altogether, the symptom changes — changes start being refused rather than going unrecorded." : "The cause is the database reading above. Once it answers, new events are recorded again — the ones already missed cannot be recovered, so what happened during the gap has to come from elsewhere.") + (marked === "" ? "" : ` ${acknowledging}`)
		};
	}
	if (outstanding !== "") return {
		dependency: "audit-log",
		standing: "degraded",
		provenance: "probed",
		at: now,
		detail: `This instance has not lost any since it started. ${outstanding}`,
		action: marked === "" ? "The cause is the database reading above. Once it answers, the list of lost events can be read again." : acknowledging
	};
	if (sources.auditDurable === false) return {
		dependency: "audit-log",
		standing: "degraded",
		provenance: "probed",
		at: now,
		detail: "Events are being recorded in memory and will be lost when this app restarts, which happens on every deploy. Nothing is missing yet, and everything will be.",
		action: "Bind a database, or unset WAF_DEMO_NO_PERSISTENCE, so the trail survives a restart."
	};
	return {
		dependency: "audit-log",
		standing: "answering",
		provenance: "probed",
		at: now,
		detail: "Every action since this instance last started has been written to the trail" + (sources.auditGaps == null ? ". " : ", and no lost event is waiting to be acknowledged. ") + (sources.auditPosture === "strict" ? "An action this app cannot record is refused rather than performed, so a change that is not in the trail did not happen — except for a record that fails after the trail has answered, which would show as a count above." : "An action this app cannot record still stands, and the count above is how many there have been.")
	};
}
/**
* The gaps that are waiting, as a sentence, or nothing when there are none.
*
* Says where they are held, because that is what makes the number different from the count beside it:
* these are in the database and so are reported by every instance, and a restart does not clear them.
* "At least" when the list was cut short, since a page that said "100" of a hundred and one would be
* reporting its own limit as the size of the problem.
*/
function markedSentence(gaps) {
	const count = gaps?.gaps.length ?? 0;
	if (gaps == null || count === 0) return "";
	return `${gaps.truncated ? "At least " : ""}${String(count)} lost audit ${count === 1 ? "event is" : "events are"} recorded as ${count === 1 ? "a gap" : "gaps"} in the trail and ${count === 1 ? "has" : "have"} not been acknowledged. They are held in the database, so every instance reports them and a restart does not clear them.`;
}
/**
* A cause, in as few words as carry information.
*
* The message rather than the class, which is the opposite of what the audit log does with the same
* value — and deliberately: this is a diagnostic read by an operator now, not a record kept for
* years and exported to third parties, and "connection refused" is the whole of what they need. The
* first line only, because a driver's stack has no business on a page.
*/
function describe(cause) {
	return ((cause instanceof Error ? cause.message : String(cause)).split("\n")[0] ?? "").trim() || "no reason given";
}
//#endregion
export { readHealth };
