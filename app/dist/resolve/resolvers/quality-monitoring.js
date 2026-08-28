import { share } from "../../collect/sql/rows.js";
import { agreeing, detailFrom, evidenceFrom, fromSignal, notApplicable, percent } from "./helpers.js";
//#region server/resolve/resolvers/quality-monitoring.ts
const MONITOR = "sql:uc.quality_monitoring";
const QUALITY_MONITORING_RESOLVERS = [fromSignal(MONITOR, ["DG-03-02"], (reading, context) => {
	if (reading.estateTables === 0) return notApplicable("This metastore contains no customer tables, so there is nothing for the quality monitor to cover.");
	const covered = share(reading.monitoredTables, reading.estateTables);
	const { noun: estateNoun } = agreeing(reading.estateTables, "customer table");
	const { noun: monitoredNoun, verb: monitoredVerb } = agreeing(reading.monitoredTables, "table");
	const coverage = covered == null ? `${monitoredNoun} monitored` : `${reading.monitoredTables.toLocaleString("en-US")} of the ${estateNoun} ${monitoredVerb} a latest quality-monitor verdict in the window (${percent(covered)})`;
	const verdicts = `${reading.healthy.toLocaleString("en-US")} Healthy, ${reading.unhealthy.toLocaleString("en-US")} Unhealthy, ${reading.training.toLocaleString("en-US")} Training, ${reading.errored.toLocaleString("en-US")} Error` + (reading.unnamedStatus > 0 ? `, ${reading.unnamedStatus.toLocaleString("en-US")} with a status this reading does not name` : "");
	return {
		outcome: "unmeasurable",
		unmeasured: "attestation",
		evidence: [evidenceFrom(context, MONITOR, `${coverage}, across ${reading.monitoredCatalogs.toLocaleString("en-US")} of ${reading.estateCatalogs.toLocaleString("en-US")} customer catalogs`, "The count and coverage of tables the quality monitor last wrote a verdict for"), detailFrom(context, MONITOR, `Of those monitored tables, the latest verdict was ${verdicts}`)],
		outcomeReason: `${coverage}. Of those, the latest verdict was ${verdicts}. That reading does not settle the requirement: a table the monitor watches is not a pipeline that stops or quarantines a bad row, and what happens on failure (\`expect\`, \`expect_or_drop\`, \`expect_or_fail\`) lives in pipeline code this scan does not read. The counts are reported rather than scored — estate coverage measures whether the monitor was turned on, and a Healthy share of the tables it already watches is what the monitor is for.`
	};
})];
//#endregion
export { QUALITY_MONITORING_RESOLVERS };
