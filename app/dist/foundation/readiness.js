import { metadataReadings, policyReadings, servingPopulation } from "./serving-asset.js";
//#region server/foundation/readiness.ts
/** Neither threshold is measured. They are this app's, and they are on every reading for that reason. */
const BANDS = {
	ready: .9,
	partial: .6
};
/** A relation reached through a connection to another system, as `table_type` spells it. */
const FEDERATED = "FOREIGN";
/** The two `table_type` values that hold data of their own, which is what a format is a fact about. */
const STORED = /* @__PURE__ */ new Set(["MANAGED", "EXTERNAL"]);
/** The formats `45a` counted as `optimized_format_tables` on the measurement estate. */
const OPTIMISED = /* @__PURE__ */ new Set(["DELTA", "ICEBERG"]);
const UNDECLARED = "no serving definition is declared, so there is no population to read this over";
const NOT_READ = "the evidence for this dimension was not read";
/**
* The eight dimensions, each with the field it reads and the population it reads over.
*
* Declared as data rather than written as eight functions so that the denominator, the version and the
* rule sit in one place and cannot drift from each other — the failure `45a` measured is precisely a
* numerator that moved to a different population than the one its label named.
*/
const DIMENSIONS = [
	{
		id: "unity-catalog-boundary",
		version: 1,
		of: "serving assets whose relation kind was read",
		excludedBecause: "",
		verdict: (asset, context) => {
			const kind = context.facts.get(asset)?.kind;
			if (kind == null) return null;
			return kind.toUpperCase() === FEDERATED ? "short" : "met";
		}
	},
	{
		id: "table-metadata",
		version: 1,
		of: "serving assets whose description, owner and tags the definition requires",
		excludedBecause: "",
		verdict: (asset, context) => {
			const reading = context.metadata.get(asset);
			if (reading == null || reading.standing === "unmeasured") return null;
			return reading.standing === "met" ? "met" : "short";
		}
	},
	{
		id: "column-metadata",
		version: 1,
		of: "serving assets whose columns were read",
		excludedBecause: "",
		verdict: (asset, context) => {
			const facts = context.facts.get(asset);
			const columns = facts?.columns;
			const commented = facts?.commentedColumns;
			if (columns == null || commented == null) return null;
			if (columns === 0) return null;
			return commented >= columns ? "met" : "short";
		}
	},
	{
		id: "semantic-assets",
		version: 1,
		of: "serving assets whose relation kind and lineage were read",
		excludedBecause: "",
		verdict: (asset, context) => {
			const facts = context.facts.get(asset);
			if (facts == null) return null;
			if (facts.kind != null && facts.kind.toUpperCase() === "METRIC_VIEW") return "met";
			const readers = facts.semanticReaders;
			if (readers == null) return null;
			return readers > 0 ? "met" : "short";
		}
	},
	{
		id: "lineage",
		version: 1,
		of: "serving assets whose lineage was read",
		excludedBecause: "",
		verdict: (asset, context) => {
			const events = context.facts.get(asset)?.lineageEvents;
			if (events == null) return null;
			return events > 0 ? "met" : "short";
		}
	},
	{
		id: "quality-monitoring",
		version: 1,
		of: "serving assets whose quality monitoring was read",
		excludedBecause: "",
		verdict: (asset, context) => {
			const facts = context.facts.get(asset);
			if (facts == null || !("qualityStatus" in facts)) return null;
			return facts.qualityStatus == null ? "short" : "met";
		}
	},
	{
		id: "policy-controls",
		version: 1,
		of: "serving assets a classification rule requires a protection of",
		excludedBecause: "no rule in the declared matrix covers a classification on them",
		verdict: (asset, context) => {
			const reading = context.policy.get(asset);
			if (reading == null || reading.standing === "unmeasured") return null;
			if (reading.standing === "not-required") return "excluded";
			return reading.standing === "met" ? "met" : "short";
		}
	},
	{
		id: "storage-format",
		version: 1,
		of: "serving assets that store data of their own",
		excludedBecause: "they are views or federated relations, which hold no format of their own",
		verdict: (asset, context) => {
			const facts = context.facts.get(asset);
			if (facts == null || facts.kind == null) return null;
			if (!STORED.has(facts.kind.toUpperCase())) return "excluded";
			if (facts.format == null) return null;
			return OPTIMISED.has(facts.format.toUpperCase()) ? "met" : "short";
		}
	}
];
/**
* What a reader would come here for and will not find, with the reading that settled it.
*
* Two entries. The first is the one every reader arrives asking about; the second is the one a reader
* only notices after declaring a matrix that requires it. Exported so the surface can render them
* beside the dimensions rather than in a footnote nobody reaches.
*/
function absences() {
	return [{
		what: "how much any of this is used through Genie",
		because: "no platform source attributes a Genie event to a table. system.access.assistant_events carries no space, conversation, asset or feedback column, and a Genie space does not name the tables it serves, so a usage dimension here would be activity standing in for attribution.",
		measured: "seven columns on system.access.assistant_events over 99,418 events, and a complete walk of 4,181 Genie spaces. Measured on the large-estate calibration estate over the 30-day window ending 2026-08-15."
	}, {
		what: "whether an ABAC policy covers an asset a rule requires one of",
		because: "the read that would answer it costs more than the rest of this outcome put together, so nothing here queries it. An asset whose rules require an ABAC policy is reported unmeasured on the policy dimension rather than short: this app has not looked, which is not the same as not found.",
		measured: "720 rows in 16m 32s from system.information_schema.abac_policy_definitions, against 1.2 to 11 seconds for every other source timed. Measured on the large-estate calibration estate over the 30-day window ending 2026-08-15."
	}];
}
/**
* The eight readings over a declaration, or eight unmeasured ones where nothing is declared.
*
* The undeclared case is the one worth being deliberate about. A definition that selects nothing is
* refused rather than stored (`defineServing`), so "nobody has declared what they serve" arrives here
* as an absent definition rather than as an empty population — and the difference matters, because an
* empty population divides every share by zero and a surface that renders that as 0% is telling a
* customer their governance is failing when what is missing is a sentence about which tables are theirs.
*/
function readiness(definition, evidence) {
	if (definition == null) return {
		declared: null,
		population: {
			assets: 0,
			missing: 0,
			truncated: evidence.truncated === true,
			undeclared: true
		},
		dimensions: DIMENSIONS.map((dimension) => unreadable(dimension, UNDECLARED)),
		absent: absences()
	};
	const population = evidence.population ?? servingPopulation(definition, evidence.serving);
	const context = contextFor(definition, population, evidence);
	return {
		declared: {
			version: definition.version,
			fingerprint: definition.fingerprint
		},
		population: {
			assets: population.assets.length,
			missing: population.missing.length,
			truncated: evidence.truncated === true,
			undeclared: false
		},
		dimensions: DIMENSIONS.map((dimension) => read(dimension, population, context)),
		absent: absences()
	};
}
function contextFor(definition, population, evidence) {
	return {
		facts: new Map((evidence.facts ?? []).map((row) => [row.qualified, row])),
		factsRead: evidence.facts != null,
		metadata: new Map(metadataReadings(definition, population, evidence.serving).map((reading) => [reading.qualified, reading])),
		policy: new Map(policyReadings(definition, population, evidence.serving).map((reading) => [reading.qualified, reading]))
	};
}
function read(dimension, population, context) {
	let met = 0;
	let fell = 0;
	let unmeasured = 0;
	let excluded = 0;
	const shortfall = [];
	for (const asset of population.assets) {
		const verdict = dimension.verdict(asset.qualified, context);
		if (verdict === "met") met += 1;
		else if (verdict === "excluded") excluded += 1;
		else if (verdict === "short") {
			fell += 1;
			shortfall.push(asset.qualified);
		} else unmeasured += 1;
	}
	const counted = met + fell;
	const denominator = {
		of: dimension.of,
		count: counted,
		excluded,
		excludedBecause: excluded > 0 ? dimension.excludedBecause : ""
	};
	if (counted === 0) return {
		...unreadable(dimension, reasonForNothing(population, unmeasured, excluded, context.factsRead)),
		denominator,
		unmeasured
	};
	const share = met / counted;
	return {
		id: dimension.id,
		version: dimension.version,
		bands: BANDS,
		denominator,
		met,
		short: fell,
		unmeasured,
		share,
		standing: share >= BANDS.ready ? "ready" : share >= BANDS.partial ? "partial" : "short",
		shortfall: shortfall.sort((a, b) => a.localeCompare(b))
	};
}
/**
* Why a dimension counted nobody, in the reader's terms rather than in the code's.
*
* Four ways to arrive at an empty denominator and they are four different pieces of news. Only one of
* them — everything excluded — is a fact about the estate; the other three are facts about what was
* declared or what was read, and a surface that renders all four as "0%" reports the estate for all of
* them.
*/
function reasonForNothing(population, unmeasured, excluded, factsRead) {
	if (population.assets.length === 0) return population.catalogueUnread ? "the catalogue was not read, so the declared assets could not be found in it" : "the declaration selected no asset the catalogue holds";
	if (unmeasured > 0) return factsRead ? NOT_READ : "the per-asset read did not happen";
	if (excluded > 0) return "every serving asset is out of this denominator";
	return NOT_READ;
}
function unreadable(dimension, because) {
	return {
		id: dimension.id,
		version: dimension.version,
		bands: BANDS,
		denominator: {
			of: dimension.of,
			count: 0,
			excluded: 0,
			excludedBecause: ""
		},
		met: 0,
		short: 0,
		unmeasured: 0,
		share: null,
		standing: "unmeasured",
		because,
		shortfall: []
	};
}
//#endregion
export { absences, readiness };
