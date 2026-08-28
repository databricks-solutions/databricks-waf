import { share } from "../../collect/sql/rows.js";
import { bandOutcome, bandsOf, detailFrom, enrichedBy, evidenceFrom, fromSignal, fromSignals, notApplicable, observedValue, percent, sourcedFrom, unmeasured, valueOf } from "./helpers.js";
import { VISIBILITY_CROSS_CHECK, unestablishedEmptiness, unestablishedSharing } from "./visibility.js";
//#region server/resolve/resolvers/interoperability.ts
const CENSUS = "sql:uc.census";
const PLATFORM = "sql:uc.platform_census";
const LINEAGE = "sql:uc.lineage_coverage";
const SERVING = "rest:workspace:serving-endpoints";
const VECTOR = "rest:workspace:vector-search.endpoints";
const INTEROPERABILITY_RESOLVERS = [
	fromSignal(PLATFORM, ["IU-02-02"], (platform, context) => {
		const unseen = unestablishedSharing(platform, [
			"shares",
			"recipients",
			"providers"
		], `${platform.shares} Delta Sharing share${platform.shares === 1 ? "" : "s"}, ${platform.recipients} recipient${platform.recipients === 1 ? "" : "s"} and ${platform.providers} inbound provider${platform.providers === 1 ? "" : "s"}`);
		if (unseen != null) return unseen;
		if (!(platform.shares > 0 || platform.recipients > 0 || platform.providers > 0)) return notApplicable("This metastore publishes no Delta Sharing shares and receives none, so there is no sharing configuration to assess. Nothing here says sharing should be set up: whether to share data outside the account is a business decision, not a posture defect.");
		if (platform.shares === 0) return {
			outcome: "pass",
			evidence: [evidenceFrom(context, PLATFORM, `${platform.providers} inbound provider${platform.providers === 1 ? "" : "s"}, publishing nothing outward`, "Data leaving or entering the account travels through Delta Sharing rather than copies")],
			outcomeReason: "This metastore consumes shared data but publishes none, so the outbound controls — recipient authentication and token allowlists — have nothing to govern. Consuming through Delta Sharing is itself the open-interface behaviour this control asks for."
		};
		if (platform.recipients === 0) return {
			outcome: "partial",
			evidence: [evidenceFrom(context, PLATFORM, `${platform.shares} share${platform.shares === 1 ? "" : "s"} defined, with no recipients`, "Shares are granted to recipients, so what is defined is actually reachable")],
			outcomeReason: "Shares exist but no recipient can read them, so nothing is actually being shared. This is either a setup someone did not finish or shares kept for a consumer who has not been onboarded."
		};
		return {
			outcome: "pass",
			evidence: [evidenceFrom(context, PLATFORM, `${platform.shares} share${platform.shares === 1 ? "" : "s"} to ${platform.recipients} recipient${platform.recipients === 1 ? "" : "s"}` + (platform.providers > 0 ? `, plus ${platform.providers} inbound provider${platform.providers === 1 ? "" : "s"}` : ""), "Data leaving or entering the account travels through Delta Sharing rather than copies"), ...platform.tokenRecipients > 0 ? [detailFrom(context, PLATFORM, `${platform.tokenRecipients} of them authenticate with a bearer token, ${platform.recipientsWithIpAllowlist} with an IP allowlist`)] : []],
			outcomeReason: "Sharing is configured and reachable. Whether the right data is shared with the right party is not something the metastore can answer — the security pillar measures how those recipients authenticate."
		};
	}),
	fromSignal(PLATFORM, ["IU-01-02"], (platform, context) => {
		const unseen = unestablishedSharing(platform, ["connections"], `${platform.connections} Lakehouse Federation connection${platform.connections === 1 ? "" : "s"}`);
		if (unseen != null) return unseen;
		if (platform.connections === 0) return unmeasured("No Lakehouse Federation connections exist in this metastore, which does not mean external data is being moved badly. Managed ingestion connectors, Auto Loader and partner tools all bring data in without registering a connection, and none of them are visible here. Answer the attestation to record which of them is in use.", "attestation");
		return {
			outcome: "pass",
			evidence: [evidenceFrom(context, PLATFORM, `${platform.connections} federated connection${platform.connections === 1 ? "" : "s"}` + (platform.connectionTypes !== "" ? ` (${platform.connectionTypes})` : ""), "External sources are reached through governed connectors rather than hand-written extracts")],
			outcomeReason: "A federated connection queries the source where it lives, with predicate pushdown and Unity Catalog permissions, instead of a scheduled extract that has to be maintained and reconciled."
		};
	}),
	fromSignals([CENSUS, LINEAGE], ["IU-04-03"], (context) => {
		const census = valueOf(context, CENSUS);
		const lineage = valueOf(context, LINEAGE);
		if (census.tableCount === 0) return unestablishedEmptiness(context) ?? notApplicable("This metastore contains no tables, so there is nothing to discover yet.");
		const described = share(census.describedTables, census.tableCount);
		const touched = Math.min(lineage.tableCount, lineage.tablesWithLineage);
		const traced = lineage.tableCount > 0 ? share(touched, lineage.tableCount) : void 0;
		const measured = [described, traced].filter((value) => value != null);
		return {
			outcome: bandOutcome(measured.length > 0 ? Math.min(...measured) : 0, bandsOf(context.spec, {
				pass: .7,
				partial: .3
			})),
			evidence: [evidenceFrom(context, CENSUS, `${census.tableCount} tables registered in Unity Catalog, ${census.describedTables} of them described (${percent(described)})`, "Assets are registered in one catalogue and described well enough to be found"), evidenceFrom(context, LINEAGE, traced == null ? "No table access was recorded in the window, so lineage coverage has no population to measure" : `${touched} of ${lineage.tableCount} tables appear in lineage (${percent(traced)})`, "Data flow between assets is visible, so a consumer can see where a table comes from")],
			outcomeReason: "Scored on the weaker of description and lineage rather than their average, because discovery fails at its weakest link: a registered table nobody described is not findable, and a well-described one with no lineage cannot be traced to its source. Registration itself is not scored — every table counted here is registered in Unity Catalog by virtue of being visible to the census, and whether anything sits outside it is beyond what this assessment measures." + (traced == null ? " Lineage is left out of this verdict, because no table access was recorded in the window at all and an empty population is not a coverage gap." : "")
		};
	}),
	enrichedBy([VISIBILITY_CROSS_CHECK], sourcedFrom([CENSUS], fromSignal(PLATFORM, ["IU-04-01", "IU-04-02"], (platform, context) => {
		const census = observedValue(context, CENSUS);
		if (census == null || census.tableCount === 0) return unestablishedEmptiness(context) ?? notApplicable("This metastore contains no tables, so there are no data products to publish. Ownership and tagging apply once there are assets to own.");
		const described = share(census.describedTables, census.tableCount);
		const tagged = share(platform.taggedTables, census.tableCount);
		if (platform.taggedTables === 0) return {
			outcome: described != null && described >= .8 ? "partial" : "fail",
			evidence: [evidenceFrom(context, PLATFORM, `No tables carry a tag, against ${census.describedTables} of ${census.tableCount} carrying a description (${percent(described)})`, "Published assets are tagged with their status, so a consumer can tell a product from a working table")],
			outcomeReason: "Without tags there is nothing in the metastore that distinguishes a table published as a product from a staging table someone left behind. A description says what a table is; a tag says whether you should build on it."
		};
		return {
			outcome: "partial",
			evidence: [evidenceFrom(context, PLATFORM, `${platform.taggedTables} of ${census.tableCount} tables tagged (${percent(tagged)}), ${platform.taggedColumns} tagged columns`, "Published assets are tagged with their status, so a consumer can tell a product from a working table"), detailFrom(context, PLATFORM, `${census.describedTables} tables described, ${census.distinctOwners} distinct owners, ${platform.routines} registered function${platform.routines === 1 ? "" : "s"}`)],
			outcomeReason: "Tagging and descriptions are in use, which is the metadata a data product needs. This caps at partial because the rest of the requirement is semantic: whether the same business concept is named the same way across schemas, and whether the business actually trusts these assets, is not something the metastore records."
		};
	}))),
	sourcedFrom([VECTOR], fromSignals([SERVING], ["IU-03-04"], (context) => {
		const serving = valueOf(context, SERVING);
		const vector = observedValue(context, VECTOR);
		const endpoints = serving.endpoints.length;
		const indexes = vector?.endpoints.length ?? 0;
		if (endpoints === 0 && indexes === 0) return unmeasured("No model serving or vector search endpoints exist, which is not the same as no AI in use. Those two are the only AI surfaces an app can be authorised to read; SQL AI functions, Genie, the assistant and pay-per-token foundation model calls all leave no endpoint behind and are invisible here. Answer the attestation to record which of them is in play.", "attestation");
		return {
			outcome: "pass",
			evidence: [evidenceFrom(context, SERVING, `${endpoints} model serving endpoint${endpoints === 1 ? "" : "s"}` + (indexes > 0 ? ` and ${indexes} vector search endpoint${indexes === 1 ? "" : "s"}` : ""), "The platform’s AI capabilities are used to shorten delivery rather than rebuilt elsewhere")]
		};
	}))
];
//#endregion
export { INTEROPERABILITY_RESOLVERS };
