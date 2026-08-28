import { qualify, servingPopulation } from "./serving-asset.js";
import { readiness } from "./readiness.js";
//#region server/foundation/readiness-read.ts
/** The evidence an undeclared estate has, which is none of it, and no statement was run to find out. */
const NOTHING = {
	catalogued: null,
	tags: null,
	classifications: null,
	protections: null
};
/**
* The one protection this read does not look for, declared rather than left to be inferred.
*
* `serving_asset_facts` reads masks and filters off `information_schema`, which answers in a second on
* a bounded population. It does not read `abac_policy_definitions`: `45a` measured that at 720 rows in
* sixteen and a half minutes, against one to eleven seconds for every other source it timed. Saying so
* here rather than omitting it is what stops a matrix requiring an ABAC policy from reporting every
* classified table as unprotected — `policyReadings` reads this and returns unmeasured instead.
*/
const UNREAD_PROTECTIONS = ["abac-policy"];
/**
* A readiness outcome for a declaration, or the undeclared one where there is nothing to read.
*
* The undeclared case runs no statement at all. That is worth being explicit about because the
* alternative — running the population statement with an empty name list and an empty key list — would
* charge the customer's warehouse for a question nobody asked and return an empty population that
* every share divides by.
*/
async function readReadiness(definition, sql) {
	if (definition == null) return {
		outcome: readiness(null, {
			serving: NOTHING,
			facts: null
		}),
		unread: []
	};
	const unread = [];
	const first = await attempt(() => sql.population(definition.named.map(qualify).join(","), definition.tagged.map((one) => one.key).join(",")), "sql:serving.population", unread);
	if (first == null) return {
		outcome: readiness(definition, {
			serving: NOTHING,
			facts: null
		}),
		unread
	};
	const selecting = {
		catalogued: first.matches.map(catalogued),
		tags: first.matches.flatMap(selectedBy),
		classifications: null,
		protections: null
	};
	const population = servingPopulation(definition, selecting);
	const assets = population.assets.map((asset) => asset.qualified).join(",");
	if (population.assets.length === 0) return {
		outcome: readiness(definition, {
			serving: selecting,
			facts: [],
			population
		}),
		unread
	};
	const [tags, facts, quality, classes] = await Promise.all([
		attempt(() => sql.tags(assets), "sql:serving.tags", unread),
		attempt(() => sql.facts(assets), "sql:serving.facts", unread),
		attempt(() => sql.quality(assets), "sql:serving.quality", unread),
		attempt(() => sql.classes(assets), "sql:serving.classes", unread)
	]);
	const complete = tags == null || tags.tagPopulation <= tags.tags.length;
	if (tags != null && !complete) unread.push({
		statement: "sql:serving.tags",
		kind: "capped",
		because: `the tag read stopped at its ceiling: ${String(tags.tags.length)} rows returned of ${String(tags.tagPopulation)} on the declared population, so which required keys an asset carries cannot be read from it.`
	});
	const read = complete ? tags : null;
	const wholeQuality = quality == null || quality.qualityPopulation <= quality.statuses.length;
	if (quality != null && !wholeQuality) unread.push({
		statement: "sql:serving.quality",
		kind: "capped",
		because: `the quality read stopped at its ceiling: ${String(quality.statuses.length)} rows returned of ${String(quality.qualityPopulation)} on the declared population, so which assets the platform has recorded a status for cannot be read from it.`
	});
	const statuses = wholeQuality ? quality : null;
	const wholeClasses = classes == null || classes.classPopulation <= classes.classified.length;
	if (classes != null && !wholeClasses) unread.push({
		statement: "sql:serving.classes",
		kind: "capped",
		because: `the classification read stopped at its ceiling: ${String(classes.classified.length)} rows returned of ${String(classes.classPopulation)} on the declared population, so which assets carry a classification cannot be read from it.`
	});
	const classified = wholeClasses ? classes : null;
	const named = new Map(population.assets.map((asset) => [asset.qualified, asset.name]));
	return {
		outcome: readiness(definition, {
			serving: {
				catalogued: selecting.catalogued,
				tags: read == null ? null : [...selecting.tags ?? [], ...read.tags.flatMap((row) => tagged(row, named))],
				classifications: classified == null ? null : classified.classified.flatMap((row) => classifications(row, named)),
				protections: facts == null ? null : facts.assets.flatMap((row) => protections(row, named)),
				unreadProtections: UNREAD_PROTECTIONS
			},
			facts: facts == null ? null : facts.assets.map((row) => assetFacts(row, statuses)),
			truncated: first.matchPopulation > first.matches.length || facts != null && facts.assetPopulation > facts.assets.length,
			population
		}),
		unread
	};
}
async function attempt(run, statement, unread) {
	try {
		return await run();
	} catch (error) {
		unread.push({
			statement,
			kind: "failed",
			because: error instanceof Error ? error.message : String(error)
		});
		return null;
	}
}
/** A qualified name back into its three parts. The only place this happens, and it is the SQL's own. */
function nameOf(row) {
	return {
		catalog: row.catalog,
		schema: row.schema,
		table: row.table
	};
}
function catalogued(row) {
	return {
		name: nameOf(row),
		description: row.description,
		owner: row.owner
	};
}
const LEVELS = {
	catalog: "catalog",
	schema: "schema",
	table: "table"
};
function selectedBy(row) {
	if (row.tagKey == null || row.tagValue == null) return [];
	const level = LEVELS[(row.tagLevel ?? "").toLowerCase()];
	if (level == null) return [];
	const name = nameOf(row);
	if (level === "catalog") return [{
		on: {
			level,
			catalog: name.catalog
		},
		key: row.tagKey,
		value: row.tagValue
	}];
	if (level === "schema") return [{
		on: {
			level,
			catalog: name.catalog,
			schema: name.schema
		},
		key: row.tagKey,
		value: row.tagValue
	}];
	return [{
		on: {
			level,
			...name
		},
		key: row.tagKey,
		value: row.tagValue
	}];
}
function tagged(row, named) {
	const on = named.get(row.qualified);
	if (on == null) return [];
	return [{
		on: {
			level: "table",
			...on
		},
		key: row.key,
		value: row.value
	}];
}
function classifications(row, named) {
	const on = named.get(row.qualified);
	if (on == null) return [];
	return row.classifications.map((classification) => ({
		on,
		classification
	}));
}
function protections(row, named) {
	const on = named.get(row.qualified);
	if (on == null) return [];
	const held = [];
	if (row.maskedColumns > 0) held.push({
		on,
		protection: "column-mask"
	});
	if (row.rowFilters > 0) held.push({
		on,
		protection: "row-filter"
	});
	return held;
}
/**
* One asset's facts, with the quality status folded in from the read that now carries it.
*
* The status is *omitted* rather than set to null when that read did not answer, and the difference is
* the whole reason the field is optional: `readiness.ts` reads an absent `qualityStatus` as the
* dimension being unmeasured and a null one as the platform holding no status, which is a failing
* dimension. Before row 65 the two could not be told apart, because a metastore without
* `system.data_quality_monitoring` failed the statement that carried all eight dimensions and the
* question never arose.
*/
function assetFacts(row, statuses) {
	const facts = {
		qualified: row.qualified,
		kind: row.relationKind,
		format: row.storageFormat,
		columns: row.columnCount,
		commentedColumns: row.commentedColumns,
		lineageEvents: row.lineageEvents,
		semanticReaders: row.semanticReaders
	};
	if (statuses == null) return facts;
	const held = statuses.statuses.find((one) => one.qualified === row.qualified);
	return {
		...facts,
		qualityStatus: held?.qualityStatus ?? null
	};
}
//#endregion
export { readReadiness };
