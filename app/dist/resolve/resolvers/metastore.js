import { evidenceFrom, fromSignal } from "./helpers.js";
//#region server/resolve/resolvers/metastore.ts
const CENSUS = "sql:uc.census";
const METASTORE_RESOLVERS = [fromSignal(CENSUS, ["SCP-04-14"], (census, context) => ({
	outcome: "pass",
	evidence: [evidenceFrom(context, CENSUS, `A Unity Catalog metastore governs this workspace, holding ${census.catalogCount} catalogs and ${census.schemaCount} schemas`, "A Unity Catalog metastore exists and governs this workspace")],
	outcomeReason: "Observed rather than reported: the assessment reads `system.information_schema`, which is a Unity Catalog view. A workspace with no metastore could not have produced any of the figures on this page."
})), fromSignal(CENSUS, ["SCP-04-10"], (census, context) => ({
	outcome: "pass",
	evidence: [evidenceFrom(context, CENSUS, `Assigned, and governing ${census.tableCount} tables`, "This workspace is assigned to a Unity Catalog metastore")],
	outcomeReason: "`system.information_schema` resolves through the workspace's metastore assignment, so a query that returned rows is the assignment. Assignment is not the same as adoption — DG-01-02 measures that."
}))];
//#endregion
export { METASTORE_RESOLVERS };
