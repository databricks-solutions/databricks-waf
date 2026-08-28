import { spanBetween } from "../catalogue/changelog.js";
import { driftBetween } from "../catalogue/methodology.js";
import { CREDIT, SEVERITY_WEIGHT } from "../score/score.js";
import { PUBLIC_METHODOLOGY } from "../methodology/identity.js";
import { METHODOLOGY } from "../scan/identity.js";
//#region server/api/methodology-routes.ts
/**
* The loaded catalogue in the record's own terms, for comparison against it.
*
* Only the fingerprinted fields, and only so drift can be found. This is not a second definition of
* the methodology — the record is that — and nothing built here is served.
*
* Exported for `methodology-agreement.test.ts`, which drives the real bump script over a real
* catalogue and asserts this projection finds no drift in what the script recorded. That test is the
* only thing holding a JavaScript guard and a TypeScript module to one field list.
*/
function liveShapesFor(catalogue) {
	return catalogue.pillars.flatMap((pillar) => pillar.principles.flatMap((principle) => principle.controls.map((control) => ({
		id: control.id,
		pillar: pillar.code,
		principle: principle.id,
		title: control.title,
		provenance: control.provenance,
		severity: control.severity,
		measurability: control.measurability,
		coverage_mode: control.coverageMode,
		alias_group: control.aliasGroup ?? null,
		clouds: control.clouds,
		thresholds: control.thresholds ?? null,
		preconditions: (control.preconditions ?? []).map((one) => ({
			signal: one.signal,
			operator: one.operator,
			...one.value !== void 0 ? { value: one.value } : {},
			outcome: one.outcome,
			scope: one.scope ?? "segment"
		}))
	}))));
}
function requirementOf(shape, drifted) {
	return {
		id: shape.id,
		pillar: shape.pillar,
		principle: shape.principle,
		title: shape.title,
		provenance: shape.provenance,
		severity: shape.severity,
		measurability: shape.measurability,
		coverageMode: shape.coverage_mode,
		...shape.alias_group != null ? { aliasGroup: shape.alias_group } : {},
		clouds: shape.clouds,
		...shape.thresholds != null ? { thresholds: scalars(shape.thresholds) } : {},
		...shape.continues != null ? { continues: shape.continues } : {},
		preconditions: shape.preconditions.map((one) => ({
			signal: one.signal,
			operator: one.operator,
			...one.value !== void 0 ? { value: scalar(one.value) } : {},
			outcome: one.outcome,
			scope: one.scope
		})),
		...drifted != null && drifted.length > 0 ? { drifted } : {}
	};
}
/**
* A threshold map narrowed to what a threshold can be.
*
* The record is JSON this app wrote, so in practice these are numbers. Narrowed anyway because the
* file is on disk in a shipped install and can be edited, and the alternative to narrowing is
* `unknown` reaching a component that will render `[object Object]` into a sentence about how a
* requirement is judged.
*/
function scalars(thresholds) {
	return Object.fromEntries(Object.entries(thresholds).map(([key, value]) => [key, scalar(value)]));
}
function scalar(value) {
	return typeof value === "number" || typeof value === "string" || typeof value === "boolean" ? value : null;
}
function revisionOf(change) {
	return {
		revision: change.version,
		fingerprint: change.fingerprint,
		recordedAt: change.recordedAt,
		scoredUnits: change.scoredUnits,
		describes: change.describes,
		added: change.added,
		removed: change.removed,
		renamed: change.renamed.map((move) => ({
			from: move.from,
			to: move.to
		})),
		changed: change.changed.map((one) => ({
			id: one.id,
			fields: one.fields
		}))
	};
}
function registerMethodologyRoutes(app, options) {
	/**
	* The methodology of record, its history, and any disagreement with the loaded catalogue.
	*
	* One request rather than three, because the three only mean anything together: a requirement list
	* without the history cannot say whether this month's score is comparable with last month's, and a
	* history without the drift check would present a record as describing a build it may not.
	*/
	app.get("/api/methodology", (_request, response) => {
		const catalogue = options.catalogue;
		const recorded = catalogue.recorded;
		const drift = driftBetween(recorded, liveShapesFor(catalogue));
		const drifted = new Map(drift.changed.map((one) => [one.id, one.fields]));
		const payload = {
			release: {
				publicVersion: PUBLIC_METHODOLOGY.publicVersion,
				name: PUBLIC_METHODOLOGY.name,
				state: PUBLIC_METHODOLOGY.state,
				candidateStartedAt: PUBLIC_METHODOLOGY.candidateStartedAt,
				effectiveDate: PUBLIC_METHODOLOGY.effectiveDate ?? null,
				releaseCommit: PUBLIC_METHODOLOGY.releaseCommit ?? null,
				approvedBy: PUBLIC_METHODOLOGY.approvedBy ?? null,
				manifestDigest: PUBLIC_METHODOLOGY.manifestDigest
			},
			technical: {
				catalogueRevision: catalogue.version.version,
				catalogueFingerprint: catalogue.version.fingerprint,
				revisions: [...catalogue.changelog.entries].reverse().map(revisionOf)
			},
			scoring: {
				digest: METHODOLOGY,
				severityWeight: SEVERITY_WEIGHT,
				credit: CREDIT
			},
			...recorded.scoredUnits != null ? { scoredUnits: recorded.scoredUnits } : {},
			requirements: [...recorded.shapes.values()].sort((a, b) => a.id.localeCompare(b.id)).map((shape) => requirementOf(shape, drifted.get(shape.id))),
			missing: drift.missing,
			unrecorded: drift.unrecorded,
			...recorded.unavailable != null ? { unavailable: recorded.unavailable } : {}
		};
		response.json(payload);
	});
	/**
	* What separates two versions.
	*
	* Both endpoints are required and neither is defaulted. A default would answer a question the caller
	* did not ask — "since the version you happen to be on" is a different claim from "between 8 and 9"
	* — and the answers differ on precisely the installs that are behind.
	*/
	app.get("/api/methodology/catalogue-span", (request, response) => {
		const earlier = typeof request.query.from === "string" ? request.query.from : "";
		const later = typeof request.query.to === "string" ? request.query.to : "";
		if (earlier === "" || later === "") {
			response.status(400).json({
				error: "no-versions",
				message: "Name both versions to compare, as `from` and `to`."
			});
			return;
		}
		const span = spanBetween(options.catalogue.changelog, earlier, later);
		const payload = {
			earlier,
			later,
			describable: span.describable,
			...span.why != null ? { why: span.why } : {},
			added: span.added,
			removed: span.removed,
			renamed: [...span.renamed].map(([from, to]) => ({
				from,
				to
			})),
			changed: span.changed.map((one) => ({
				id: one.id,
				fields: one.fields
			})),
			versions: span.versions
		};
		response.json(payload);
	});
}
//#endregion
export { liveShapesFor, registerMethodologyRoutes };
