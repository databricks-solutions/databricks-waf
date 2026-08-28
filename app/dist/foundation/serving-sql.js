import { FileQuerySource } from "../collect/sql/queries.js";
import { parse } from "../collect/sql/shapes.js";
import { rowsOf } from "../collect/sql/collector.js";
import { sql } from "@databricks/appkit";
//#region server/foundation/serving-sql.ts
function servingSql(options) {
	const queries = options.queries ?? new FileQuerySource();
	const limit = sql.int(options.limit ?? 2e3);
	const run = async (name, parameters) => rowsOf(await options.executor(queries.text(name), parameters, options.signal));
	return {
		population: async (names, tagKeys) => parse.servingPopulation(await run("serving_population", {
			serving_names: sql.string(names),
			serving_tag_keys: sql.string(tagKeys),
			serving_limit: limit
		})),
		tags: async (assets) => parse.servingTags(await run("serving_asset_tags", {
			serving_assets: sql.string(assets),
			serving_limit: limit
		})),
		facts: async (assets) => parse.servingFacts(await run("serving_asset_facts", {
			serving_assets: sql.string(assets),
			serving_limit: limit,
			lookback_days: sql.int(options.lookbackDays)
		})),
		quality: async (assets) => parse.servingQuality(await run("serving_asset_quality", {
			serving_assets: sql.string(assets),
			serving_limit: limit,
			lookback_days: sql.int(options.lookbackDays)
		})),
		classes: async (assets) => parse.servingClasses(await run("serving_asset_classifications", {
			serving_assets: sql.string(assets),
			serving_limit: limit
		}))
	};
}
//#endregion
export { servingSql };
