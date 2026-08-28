import { configuredGroup } from "./authorize/group.js";
import { loadCatalogue } from "./catalogue/catalogue.js";
import { loadGuidance } from "./guidance/guidance.js";
import { SqlCollector } from "./collect/sql/collector.js";
import { DescribeCollector } from "./collect/sql/describe.js";
import { PredictiveOptimizationCollector } from "./collect/sql/predictive-optimization.js";
import { clientFor } from "./collect/rest/client.js";
import { RestCollector } from "./collect/rest/collector.js";
import { CloudCollector } from "./collect/cloud/collector.js";
import { workspaceHost } from "./collect/credentials.js";
import { declaredScopes } from "./collect/rest/declared-scopes.js";
import { StatementExecutor } from "./collect/sql/statements.js";
import { buildRegistry } from "./resolve/resolvers/index.js";
import { openedFor } from "./review/review.js";
import { finalAssessmentProjector } from "./review/projection.js";
import { AuditRecorder, postureFrom } from "./audit/record.js";
import { ScanRunner } from "./scan/runner.js";
import { Runs } from "./run/runs.js";
import { registerApi } from "./api/routes.js";
import { machineClient } from "./schedule/client.js";
import { AdvisoryRunner } from "./advise/runner.js";
import { resolveValidations } from "./validate/resolve.js";
import { settleAdvice } from "./improve/advice-settle.js";
import { chooseStore } from "./scan/store-choice.js";
import { startFallbackServer } from "./api/fallback.js";
import { analytics, createApp, server } from "@databricks/appkit";
//#region server/server.ts
/**
* Pillars the app measures today.
*
* Named rather than inferred, so the UI can say which pillars are assessed instead of
* showing one at zero and letting the reader assume the estate failed it.
*
* All seven, as of the operational-excellence and interoperability resolvers. Those two
* were the last holdouts and were absent for a reason worth recording: both arrived from
* the seed with every control marked `attestation`, on the reasoning that their published
* text is about process and a process is not a system table. That was true of about two
* thirds of them and false of the rest — "use Unity Catalog managed tables", "use
* declarative pipelines", "use open data formats" each name an artefact the metastore
* records plainly. Nineteen controls were measured by looking again, so the list is now
* the whole framework and this constant's remaining job is to be the thing a reviewer
* checks against the registry rather than a gate anything sits behind.
*/
const MEASURED_PILLARS = [
	"cost-optimization",
	"data-and-ai-governance",
	"interoperability-and-usability",
	"operational-excellence",
	"performance-efficiency",
	"reliability",
	"security-compliance-and-privacy"
];
/**
* The guidance library, or nothing when it cannot be read.
*
* Swallowed on purpose. Guidance makes a question easier to answer honestly; it is not what makes
* the question answerable. An install whose `config/guidance/` directory is missing should serve the
* assessment and say no guidance was written, not refuse to boot over a content directory.
*/
function readGuidance() {
	try {
		const library = loadGuidance();
		console.log(`[guidance] ${library.authored} of ${library.entries.size} entries are written`);
		return library;
	} catch (error) {
		console.error("[guidance] could not be read, questions will show none:", error);
		return;
	}
}
async function main() {
	const catalogue = loadCatalogue();
	const guidance = readGuidance();
	const registry = buildRegistry();
	const projector = finalAssessmentProjector({
		catalogue,
		registry
	});
	const assessorGroup = configuredGroup();
	console.log(`[authorize] changes are restricted to members of the ${assessorGroup} group`);
	const { store, attestations, decisions, definitions, drafts, imports, audit: auditLog, improvements, improvementExplanation: improvementStorage, notes, noteExplanation: noteStorage, serving, servingExplanation: servingStorage, reviews, reviewExplanation: reviewStorage, validations, validationExplanation: validationStorage, risks, riskExplanation: riskStorage, applicability: applicabilityStore, explanation: storage, attestationExplanation: attestationStorage, decisionExplanation: decisionStorage, definitionExplanation: definitionStorage, verify: verifyRecords, ping: pingDatabase, retention: retentionStore, retentionGateway, runs: runStore, advisories: advisoryStore, planExtracts, publications: publicationStore, close: closeStore } = await chooseStore({
		pillars: catalogue.pillars.map((pillar) => pillar.id),
		projector,
		onError: (operation, error) => {
			console.error(`[scan store] could not ${operation}:`, error);
		}
	});
	const machine = machineClient();
	console.log(`[schedule] ${machine == null ? "no machine identity; the scheduled job cannot be read" : "reading the scheduled job as the app"}`);
	console.log(`[scan store] ${storage}`);
	console.log(`[attestations] ${attestationStorage}`);
	console.log(`[decisions] ${decisionStorage}`);
	console.log(`[definitions] ${definitionStorage}`);
	console.log(`[improvements] ${improvementStorage}`);
	console.log(`[notes] ${noteStorage}`);
	console.log(`[serving declarations] ${servingStorage}`);
	console.log(`[reviews] ${reviewStorage}`);
	console.log(`[validations] ${validationStorage}`);
	console.log(`[accepted risks] ${riskStorage}`);
	const audit = new AuditRecorder(auditLog, {
		onError: (operation, error) => {
			console.error(`[audit] could not ${operation}:`, error);
		},
		posture: postureFrom(process.env)
	});
	console.log(`[audit] ${audit.posture === "strict" ? "an action that cannot be recorded is refused" : "an action that cannot be recorded still stands, and is counted"}`);
	const runner = new ScanRunner({
		catalogue,
		registry,
		store,
		attestations,
		imports,
		...applicabilityStore == null ? {} : { applicability: applicabilityStore },
		measuredPillars: MEASURED_PILLARS,
		declaredScopes: declaredScopes(),
		onFinished: async (scan) => {
			const settled = await resolveValidations(scan, {
				validations,
				improvements,
				onError: (operation, error) => {
					console.error(`[validations] could not ${operation}:`, error);
				}
			});
			if (settled.answered > 0 || settled.withdrawn > 0) console.log(`[validations] ${String(settled.answered)} answered by ${scan.id} (${String(settled.verified)} verified, ${String(settled.failed)} still failing, ${String(settled.incomplete)} unfinished), ${String(settled.withdrawn)} withdrawn, ${String(settled.waiting)} still waiting`);
			if (settled.stalled > 0) console.error(`[validations] ${String(settled.stalled)} validations passed and could not be recorded as verified. The attempts are on the record; ask for another validation of those actions.`);
			try {
				await reviews.open(openedFor(scan, { id: crypto.randomUUID() }));
			} catch (error) {
				console.error(`[reviews] could not open a review of ${scan.id}:`, error);
			}
		}
	});
	const advisor = advisoryStore == null ? void 0 : new AdvisoryRunner({
		store: advisoryStore,
		...planExtracts != null ? { planExtracts } : {},
		onFinished: async (advisory) => {
			const settled = await settleAdvice(advisory, {
				improvements,
				onError: (operation, error) => {
					console.error(`[advice] could not ${operation}:`, error);
				}
			});
			if (settled.cleared > 0 || settled.firing > 0) console.log(`[advice] ${String(settled.cleared)} cleared by ${advisory.id}, ${String(settled.firing)} still firing, ${String(settled.unreadable)} unreadable`);
			if (settled.stalled > 0) console.error(`[advice] ${String(settled.stalled)} actions cleared and could not be recorded as verified. They remain waiting; the next advisory will settle them.`);
		}
	});
	const runs = runStore == null ? void 0 : new Runs({
		store: runStore,
		runner,
		...advisor != null ? { advisor } : {}
	});
	console.log(`[runs] ${runs == null ? "a run is not stored durably; an interrupted run is lost" : "a run is recorded before it starts, and a retry carries on where it stopped"}`);
	const host = workspaceHost();
	try {
		await createApp({
			plugins: [analytics(), server()],
			onPluginsReady(appkit) {
				appkit.server.extend((app) => {
					registerApi(app, {
						catalogue,
						registry,
						runner,
						...runs == null ? {} : { runs },
						store,
						storage,
						attestations,
						attestationStorage,
						decisions,
						decisionStorage,
						definitions,
						drafts,
						imports,
						definitionStorage,
						improvements,
						improvementStorage,
						notes,
						noteStorage,
						serving,
						servingStorage,
						reviews,
						reviewStorage,
						validations,
						validationStorage,
						risks,
						riskStorage,
						host,
						assessorGroup,
						audit,
						...machine == null ? {} : { machineClient: machine },
						pillars: MEASURED_PILLARS,
						...guidance == null ? {} : { guidance },
						...verifyRecords == null ? {} : { verifyRecords },
						...pingDatabase == null ? {} : { pingDatabase },
						...retentionStore == null || retentionGateway == null ? {} : { retention: {
							store: retentionStore,
							gateway: retentionGateway
						} },
						...advisoryStore == null ? {} : { advisories: advisoryStore },
						...publicationStore == null ? {} : { publications: publicationStore },
						...applicabilityStore == null ? {} : { applicability: applicabilityStore },
						warehouse: () => {
							try {
								return warehouseId();
							} catch {
								return;
							}
						},
						collectorsFor: ({ credentials, scope, lookbackDays }) => {
							const executor = async (statement, parameters, signal) => {
								const databricks = await credentials.databricks();
								return new StatementExecutor({
									host: databricks.host,
									warehouseId: warehouseId(),
									token: databricks.token
								}).query(statement, parameters, signal);
							};
							return [
								new SqlCollector({
									executor,
									scope,
									lookbackDays
								}),
								new DescribeCollector({ executor }),
								new PredictiveOptimizationCollector({ executor }),
								new RestCollector({ client: clientFor(credentials) }),
								new CloudCollector()
							];
						}
					});
				});
			}
		});
	} catch (cause) {
		await closeStore?.().catch(() => void 0);
		throw cause;
	}
}
/**
* The warehouse the consuming admin bound at install time.
*
* Read per scan rather than captured at startup so that rebinding the resource takes
* effect on the next scan rather than on the next restart. Absent means the binding is
* missing, which is a sentence the admin can act on rather than a request that fails
* with a 400 from the warehouse.
*/
function warehouseId() {
	const id = process.env.DATABRICKS_WAREHOUSE_ID?.trim();
	if (id == null || id === "") throw new Error("No SQL warehouse is bound to this app, so there is nothing to run the assessment queries on. Bind a warehouse to the app resource named sql-warehouse and run the scan again.");
	return id;
}
/**
* The backstop for what no request owns.
*
* The containment proxy in `api/contain.ts` covers the route path, which is where row 89's outage came
* from. This covers what has no request to fail: a rejection from a timer, a stream, the scheduler
* between runs, or a store the app talks to outside a handler. Node's default for both of these is to
* terminate, and a terminated app here does not come back on its own — measured on labs, it stayed
* down until a hand redeploy, because `apps start` alone left the deployment association cleared.
*
* **Not exiting reverses Node's default, and that is a judgement rather than an oversight.**
* [ADR 0095](../../docs/decisions/0095-a-fault-with-no-request-logs-and-the-app-keeps-serving.md)
* records it: a read-path defect in one route is not evidence that the pool, the scheduler or the
* audit log are unsound, and 502 for every reader is a worse answer than a stack in the log. The
* opposite call is defensible, which is exactly why it is written down rather than implied by the
* absence of a handler.
*
* Registered before `main` so a fault during startup is covered too, and outside it so a retry does
* not stack a second pair of listeners on every attempt.
*/
function logAndKeepServing(kind, cause) {
	console.error(`${kind} with no request to answer. The app is still serving; this was not answered by anybody.`, cause instanceof Error ? cause.stack : cause);
}
process.on("unhandledRejection", (cause) => {
	logAndKeepServing("unhandledRejection", cause);
});
process.on("uncaughtException", (cause) => {
	logAndKeepServing("uncaughtException", cause);
});
main().catch((cause) => {
	startFallbackServer(cause, { retry: main });
});
//#endregion
export {};
