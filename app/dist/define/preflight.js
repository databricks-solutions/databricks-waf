import { quoteIdent } from "../scripts/sql-identifiers.js";
import { currentVersion, resolveScope } from "./definition.js";
import { schemaOf } from "../collect/sql/reads.js";
//#region server/define/preflight.ts
const NOT_YET_RESOLVED = "No scan has read the account directory to resolve the scope against, so how much of the estate this covers is not known yet.";
/**
* A statement that reads nothing and proves the read is allowed.
*
* `WHERE false` rather than `LIMIT 0`. Both return no rows, and a permission check happens during
* analysis either way — but `LIMIT 0` is the form AppKit uses to validate its own queries at
* startup, and reusing it here would make a preflight execution indistinguishable from a startup
* validation in the customer's query history. `WHERE false` also survives a table whose statistics
* make the planner short-circuit differently.
*/
function probeStatement(table) {
	return `SELECT 1 FROM ${table} WHERE false`;
}
/**
* The grant that would fix a denial, as a line somebody can run.
*
* At schema level, because that is the unit `GRANT SELECT` is used at on system tables and because a
* reader given eleven table grants across five schemas will ask for the schemas anyway. The identity
* is backtick-quoted: these are email addresses and service principal ids, and an unquoted one is a
* syntax error the admin has to debug before they can help.
*
* The identity reaches here from a request header, and this app's output is a statement it tells
* somebody to run. Those two facts together mean the quoting has to hold: a backtick inside the value
* would close the identifier early and leave whatever followed as SQL a metastore admin pastes into a
* privileged session. Backticks are doubled, which is how Databricks escapes one inside a quoted
* identifier, so the value stays a single token whatever it contains.
*
* A line break is refused rather than escaped. There is no escape for one inside an identifier, an
* identity containing one is not a principal any platform issued, and a multi-line grant in a panel
* captioned "runnable as written" is a worse thing to emit than nothing.
*/
function grantFor(schema, identity) {
	const quoted = quoteIdent(identity);
	if (quoted == null) return void 0;
	return `GRANT SELECT ON SCHEMA ${schema} TO ${quoted}`;
}
/**
* Which reading a failure is, from what the platform said.
*
* On the message rather than a status code for the same reason `rest/reach.ts` classifies on the
* message: a missing grant and a schema that was never enabled both arrive as a failed statement,
* and only the text tells them apart. Everything unrecognised is `unknown`, which reports the
* failure without prescribing a fix — see the note on wrong grant instructions above.
*/
function readingFor(message) {
	const absent = /TABLE_OR_VIEW_NOT_FOUND|SCHEMA_NOT_FOUND|does not exist|cannot be found|UNRESOLVED_/i.test(message);
	const denied = /PERMISSION_DENIED|INSUFFICIENT_PERMISSIONS|does not have\b|requires? .*privilege|access denied|not authorized|unauthorized|\b403\b/i.test(message);
	if (absent && denied) return "unknown";
	if (absent) return "absent";
	if (denied) return "denied";
	return "unknown";
}
/**
* Probes every table the assessment's checks read, and reports what that means for the checks.
*
* One probe per distinct table rather than per check: nineteen statements read eleven tables, and
* probing per check would run the same read eight times over. Sequential, because a burst of
* simultaneous statements at a customer's warehouse is the impoliteness the whole scheduler exists
* to avoid and this runs on a button press.
*/
async function preflight(input, probe, now = /* @__PURE__ */ new Date()) {
	const current = currentVersion(input.definition);
	const measurement = current.measurement;
	const tablesBySignal = new Map(input.signals.map((signal) => [signal.id, signal.tables]));
	const blockedBy = /* @__PURE__ */ new Map();
	for (const check of input.checks) for (const signal of check.signals) for (const table of tablesBySignal.get(signal) ?? []) {
		const behind = blockedBy.get(table) ?? /* @__PURE__ */ new Set();
		behind.add(check.controlId);
		blockedBy.set(table, behind);
	}
	const sources = [];
	for (const table of [...blockedBy.keys()].sort()) sources.push({
		...await probeOne(table, probe, input.identity),
		blocks: [...blockedBy.get(table) ?? []].sort()
	});
	const unreadable = new Set(sources.filter((source) => source.reading !== "readable").map((source) => source.table));
	const grantByTable = new Map(sources.flatMap((source) => source.grant != null ? [[source.table, source.grant]] : []));
	const blocked = [];
	let ready = 0;
	for (const check of input.checks) {
		const missing = check.signals.filter((signal) => (tablesBySignal.get(signal) ?? []).some((table) => unreadable.has(table)));
		if (missing.length > 0) {
			const needs = /* @__PURE__ */ new Set();
			for (const signal of missing) for (const table of tablesBySignal.get(signal) ?? []) {
				const grant = grantByTable.get(table);
				if (grant != null) needs.add(grant);
			}
			blocked.push({
				controlId: check.controlId,
				pillarId: check.pillarId,
				needs: [...needs].sort()
			});
			continue;
		}
		ready += 1;
	}
	const scope = resolveScope(measurement, input.directory, input.directoryUnreadable ?? NOT_YET_RESOLVED);
	return {
		ranAt: now,
		ranAs: input.identity,
		definitionId: input.definition.id,
		version: current.version,
		fingerprint: current.fingerprint,
		sources,
		blocked: blocked.sort((a, b) => a.controlId.localeCompare(b.controlId)),
		ready,
		scope,
		verdict: verdictFor(sources, blocked, ready, scope, input.identity)
	};
}
async function probeOne(table, probe, identity) {
	const schema = schemaOf(table);
	try {
		await probe(table);
		return {
			table,
			schema,
			reading: "readable",
			detail: "The read was allowed."
		};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const reading = readingFor(detail);
		const grant = reading === "denied" ? grantFor(schema, identity) : void 0;
		return {
			table,
			schema,
			reading,
			detail,
			...grant != null ? { grant } : {}
		};
	}
}
/**
* The one sentence a reader takes away, and the one place this module states a judgement.
*
* Written as what the run would produce rather than as a status, because "3 sources denied" leaves
* the reader to work out whether that matters. Whether it matters depends on how many checks sit
* behind them, and the preflight is the only thing that knows.
*/
function verdictFor(sources, blocked, ready, scope, identity) {
	const total = ready + blocked.length;
	if (sources.length === 0) return "This assessment includes no checks that read a system table, so there is nothing to authorise.";
	if (blocked.length === 0) return [`Every source this assessment reads answered, so all ${String(total)} of its checks can run.`, coverage(scope)].filter((part) => part !== "").join(" ");
	const grants = new Set(blocked.flatMap((check) => check.needs));
	const unexplained = sources.filter((source) => source.reading === "unknown").length;
	const absent = sources.filter((source) => source.reading === "absent").length;
	const parts = [`${String(blocked.length)} of ${String(total)} checks in this assessment cannot run as ${identity}, and would report themselves unmeasured rather than failing.`];
	if (grants.size > 0) parts.push(`${String(grants.size)} grant${grants.size === 1 ? "" : "s"} would fix ${grants.size === 1 ? "them" : "most of them"}, listed below and runnable as written.`);
	if (absent > 0) parts.push(`${String(absent)} source${absent === 1 ? " is" : "s are"} not present on this metastore, which is a setting to enable rather than a grant to make.`);
	if (unexplained > 0) parts.push(`${String(unexplained)} failed for a reason this app does not recognise, so no remedy is offered for it — the platform’s own message is beside it.`);
	const covered = coverage(scope);
	if (covered !== "") parts.push(covered);
	return parts.join(" ");
}
/**
* What the checks would cover, when that is worth a sentence.
*
* Silent when the scope is complete: "all of it" adds nothing to a verdict that has already said every
* check can run. The unresolved case is not special-cased here because the resolution words it — an
* undetermined directory produces a description that says the coverage was not established, and the
* caller that knows why the read failed has already passed the reason in.
*/
function coverage(scope) {
	return scope.complete ? "" : scope.description;
}
/** Whether a definition's pillar filter includes this pillar. Absent means all of them. */
function includesPillar(measurement, pillarId) {
	return measurement.pillars == null || measurement.pillars.includes(pillarId);
}
/**
* What the assessment's checks read, derived from the same three things a scan is derived from.
*
* The closure over `derivedFrom` is the part that matters and the part a hand-written mapping would
* have got wrong. Every system-table statement filters on the workspace directory, so every SQL
* check depends on `system.access.workspaces_latest` whether or not its own statement names it. An
* identity denied that one table can read all the others and still measure nothing, and a preflight
* that reported eighteen sources readable and one denied — without saying the one takes the other
* eighteen with it — would be worse than no preflight, because it looks like a minor gap.
*/
function sourcesFor(options) {
	const byId = new Map(options.descriptors.map((descriptor) => [descriptor.id, descriptor]));
	const signals = options.descriptors.map((descriptor) => ({
		id: descriptor.id,
		tables: descriptor.touches.filter((touched) => /^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$/i.test(touched))
	}));
	const checks = [];
	for (const control of options.catalogue.controls) {
		if (!includesPillar(options.measurement, control.pillarId)) continue;
		const resolver = options.registry.get(control.id);
		if (resolver == null) continue;
		checks.push({
			controlId: control.id,
			pillarId: control.pillarId,
			signals: closureOf(resolver.requires, byId)
		});
	}
	return {
		checks,
		signals
	};
}
/**
* A signal set plus everything those signals are derived from, to a fixed point.
*
* Iterated rather than one pass, for the reason `plan.ts` gives for the same closure: an input can
* have an input, and one pass would satisfy today's two-step chains and silently drop the first
* three-step one.
*/
function closureOf(requires, byId) {
	const needed = new Set(requires);
	for (let added = true; added;) {
		added = false;
		for (const id of [...needed]) for (const input of byId.get(id)?.derivedFrom ?? []) if (!needed.has(input)) {
			needed.add(input);
			added = true;
		}
	}
	return [...needed].sort();
}
//#endregion
export { grantFor, includesPillar, preflight, probeStatement, readingFor, sourcesFor };
