//#region server/foundation/readiness-language.ts
const LANGUAGE = {
	"unity-catalog-boundary": {
		area: "governance",
		label: "Inside Unity Catalog",
		asks: "How many serving assets are relations Unity Catalog governs itself, rather than ones reached through a connection to another system.",
		sources: ["sql:serving.population", "sql:serving.facts"]
	},
	"table-metadata": {
		area: "metadata",
		label: "Table metadata",
		asks: "How many carry the description, the owner and the tag keys this declaration says a serving asset must have. What is required is the declaration’s own list, not this app’s.",
		sources: ["sql:serving.population", "sql:serving.tags"]
	},
	"column-metadata": {
		area: "metadata",
		label: "Column comments",
		asks: "How many have a comment on every column the read found. An asset with no columns read is not counted.",
		sources: ["sql:serving.population", "sql:serving.facts"]
	},
	"semantic-assets": {
		area: "semantics",
		label: "Semantic assets",
		asks: "How many are a metric view, or are read by one somewhere in the lineage window. Says nothing about whether the metrics defined over them are the right ones.",
		sources: ["sql:serving.population", "sql:serving.facts"]
	},
	lineage: {
		area: "freshness",
		label: "Lineage",
		asks: "How many appear on either side of a lineage event inside the window. An asset with none was not read or written in the window, which is not the same as an asset nothing depends on.",
		sources: ["sql:serving.population", "sql:serving.facts"]
	},
	"quality-monitoring": {
		area: "freshness",
		label: "Quality monitoring",
		asks: "How many have a status recorded against them by the platform’s own quality monitoring. Whether a status exists — not whether it was a passing one, which is the platform’s word and not this app’s.",
		sources: [
			"sql:serving.population",
			"sql:serving.facts",
			"sql:serving.quality"
		]
	},
	"policy-controls": {
		area: "governance",
		label: "Policy controls",
		asks: "Of the assets a classification rule in this declaration applies to, how many carry the protections it requires. Assets no rule covers are out of the count rather than passing it.",
		sources: [
			"sql:serving.population",
			"sql:serving.facts",
			"sql:serving.classes"
		]
	},
	"storage-format": {
		area: "performance",
		label: "Storage format",
		asks: "Of the assets that store data of their own, how many store it in Delta or Iceberg. A reading of the format column, and not of how anything performs.",
		sources: ["sql:serving.population", "sql:serving.facts"]
	}
};
function dimensionLanguage(id) {
	return LANGUAGE[id];
}
//#endregion
export { dimensionLanguage };
