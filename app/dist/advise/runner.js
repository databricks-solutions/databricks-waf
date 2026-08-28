import { FileQuerySource } from "../collect/sql/queries.js";
import { rowsOf } from "../collect/sql/shapes.js";
import { clientFor } from "../collect/rest/client.js";
import { asJob, asWarehouse, linksIn } from "../resolve/locate.js";
import { workloadRules } from "./workload-rules.js";
import { CollectionScheduler } from "../scan/scheduler.js";
import { collectSignals, withInputs } from "../collect/collection.js";
import "../scan/runner.js";
import { JOB_INVENTORY, SERVERLESS_ANALYZER_SIGNALS, WORKSPACES, analyseServerless } from "../analyze/serverless.js";
import { localWarehouseIds } from "../collect/sql/plans/warehouses.js";
import { PlanFetcher } from "../collect/sql/plans/fetch.js";
import { retrievePlans, summarise } from "../collect/sql/plans/retrieve.js";
import { analyseJobs } from "./jobs.js";
import { analyseSizing } from "./sizing.js";
import { analyseWrites } from "./writes.js";
import { planIndex } from "./plan-index.js";
import { statsIndex } from "./stats-index.js";
import { analyseWorkload } from "./workload.js";
import { isBaseline, planCapability } from "./plan-capability.js";
import { SHAPE_STATEMENT, shapeFingerprintVersion } from "../collect/sql/shape-version.js";
import { randomUUID } from "node:crypto";
//#region server/advise/runner.ts
/** How far back a plan-reach baseline may come from. `baseline()` says why it is short. */
const BASELINE_LOOKBACK = 5;
/** The signal the workload analysis is built on. Its own constant, so the ask and the read agree. */
const QUERY_SHAPES = "sql:workload.query_shapes";
/**
* The estate's statistics maintenance history, which one rule reads.
*
* A second signal rather than a join inside the shapes statement, and not for tidiness: it is keyed on a table
* where the shapes are keyed on a shape, so joining them would multiply a shape's row by its tables. It is
* also the only signal here that reads `system.access.table_lineage`, and a run without that permission should
* lose this rule rather than the whole analysis — which is what a separate reading gets, because the workload
* analysis is gated on the shapes alone.
*/
const TABLE_STATISTICS = "sql:workload.table_statistics";
/**
* How the estate's jobs ran, which the job analysis is built on.
*
* Timing, outcome, repeats and cost, from the two Lakeflow timelines. The one input `33ca` found answerable
* on an all-serverless estate, and the analysis is gated on it alone.
*/
const JOB_RUN_HEALTH = "sql:workload.job_run_health";
/**
* What the workers of those jobs' classic clusters were doing, which four more rules read.
*
* Not gated on, and that is the point of it being a second signal: `system.compute.node_timeline` holds no
* row for serverless compute, so on an estate like labs this returns nothing and the four timeline rules
* still run. Where it is absent the four utilisation rules report no population rather than a clean estate —
* ADR 0074, and `analyseJobs` carries the distinction as `computeRead`.
*/
const JOB_COMPUTE = "sql:workload.job_compute_utilisation";
/**
* The two the sizing analysis reads.
*
* The pressure statement measures what a warehouse was asked to do, and the inventory names it — its
* size, its cluster range, whether it stops and whether it is serverless. Two signals rather than one
* statement that joins them, because the inventory already carries a fix a second reader of
* `system.compute.warehouses` would have to repeat: the latest row for a warehouse is the row recording
* its deletion, and ranking without accounting for that reported 5,101 live warehouses where 24 existed.
*/
const WAREHOUSE_PRESSURE = "sql:workload.warehouse_pressure";
const WAREHOUSE_INVENTORY = "sql:compute.warehouses";
/**
* How the estate writes, which the write analysis is built on.
*
* Its own signal over the same table the shapes come from, and gated on alone, because it is ranked by what
* a statement wrote where that one is ranked by what it cost — see `workload_write_patterns.sql`. An estate
* with no write statements returns nothing here and loses nothing else.
*/
const WRITE_PATTERNS = "sql:workload.write_patterns";
/**
* What an advisory run reads.
*
* A declared list, not a set derived from a catalogue, because there are no controls here: nothing
* scores, so nothing asks for a signal on a requirement's behalf. Adding an analysis means adding its
* signals to this list, which is the visible cost of a new analysis and the right place to pay it.
*/
const ADVISORY_SIGNALS = [
	...SERVERLESS_ANALYZER_SIGNALS,
	QUERY_SHAPES,
	TABLE_STATISTICS,
	JOB_RUN_HEALTH,
	JOB_COMPUTE,
	WAREHOUSE_PRESSURE,
	WAREHOUSE_INVENTORY,
	WRITE_PATTERNS
];
/**
* The real one: the SDK for the warehouse list, a raw `fetch` for the plan.
*
* The asymmetry is the SDK's. `WarehousesService.list` exists and paginates itself; `queryHistory`
* exposes `list` and no `get`, which is why `fetch.ts` exists at all.
*/
const REAL_PLAN_ACCESS = (credentials, identity) => ({
	warehouseIds: () => localWarehouseIds(clientFor(credentials)),
	fetcher: new PlanFetcher({
		host: identity.host,
		token: identity.token
	})
});
var AdvisoryInProgressError = class extends Error {
	startedAt;
	actor;
	constructor(startedAt, actor) {
		super(`An advisory run started by ${actor} at ${startedAt.toISOString()} is already running. One runs at a time so two people cannot double the load on the warehouse for the same advice. Wait for it to finish; its result will be the latest.`);
		this.startedAt = startedAt;
		this.actor = actor;
		this.name = "AdvisoryInProgressError";
	}
};
var AdvisoryRunner = class {
	options;
	inFlight;
	scheduler;
	shapeText;
	constructor(options) {
		this.options = options;
	}
	now() {
		return this.options.clock?.() ?? /* @__PURE__ */ new Date();
	}
	running() {
		if (this.inFlight == null) return void 0;
		const { startedAt, actor, scope } = this.inFlight;
		return {
			startedAt,
			actor,
			scope,
			callsMade: this.callsMade()
		};
	}
	/** The run in flight's promise, for a caller content to wait rather than be refused. */
	join() {
		return this.inFlight?.promise;
	}
	/**
	* Asks the run in flight to stop, and does nothing where there is none.
	*
	* Through the scheduler rather than by rejecting the promise, so the stop takes effect at a unit
	* boundary and what has been read is saved. Doing nothing when idle is deliberate: the coordinator
	* calls this whenever the process holds an advisory run's lease, and a run that has already finished
	* between the flag being written and this call is not an error.
	*/
	cancel() {
		this.scheduler?.cancel();
	}
	/** Calls that have reached a surface so far. Skipped work is left out, as in a scan. */
	callsMade() {
		if (this.scheduler == null) return 0;
		return Object.values(this.scheduler.footprint().tasks).reduce((total, surface) => total + surface.ok + surface.failed + surface.retries, 0);
	}
	/**
	* Starts a run, or refuses because one is already going.
	*
	* **Nothing is awaited between the check and the claim, and that is the whole of why this method is
	* shaped the way it is.** Two callers arriving in the same tick both run the synchronous prologue
	* before either suspends, so a claim taken after `await credentials.databricks()` is a claim both of
	* them pass — and the refusal that exists to stop two account-wide passes over `system.lakeflow`
	* would let both through. Resolving the identity is therefore inside the chain, and the claim's actor
	* is filled in when it arrives.
	*
	* `async` with nothing awaited before the claim, which is not a contradiction: the body of an async
	* function runs synchronously up to its first `await`, so the claim is taken in the same tick and the
	* refusal still reaches a caller as a rejection rather than as a throw from a method whose signature
	* promises one.
	*/
	async start(request) {
		const already = this.running();
		if (already != null) throw new AdvisoryInProgressError(already.startedAt, already.actor);
		const scheduler = new CollectionScheduler();
		const startedAt = this.now();
		const claim = {
			startedAt,
			actor: "somebody",
			scope: request.scope,
			promise: this.run(request, scheduler, startedAt, (actor) => claim.actor = actor).then(async (advisory) => {
				await this.options.store.save(advisory);
				await this.settled(advisory);
				return advisory;
			}).finally(() => {
				this.inFlight = void 0;
				this.scheduler = void 0;
			})
		};
		this.inFlight = claim;
		this.scheduler = scheduler;
		return claim.promise;
	}
	/**
	* Runs the after-the-save work, and swallows its failure.
	*
	* Caught here rather than left to the caller because of what the caller is: `start` resolves with the
	* advisory, and a rejection out of this would tell whoever asked for advice that their run failed
	* when it is saved and readable. Reported through the same console the scan path uses, since a
	* settlement that did not happen is late rather than lost — the next advisory settles it.
	*/
	async settled(advisory) {
		try {
			await this.options.onFinished?.(advisory);
		} catch (error) {
			console.error("[advisory] could not settle the work raised from earlier advice:", error);
		}
	}
	async run(request, scheduler, startedAt, named) {
		const identity = await request.credentials.databricks();
		named(identity.actor);
		const lookbackDays = request.lookbackDays ?? 30;
		const collected = await collectSignals(withInputs(new Set(ADVISORY_SIGNALS), request.collectors), {
			...request,
			lookbackDays
		}, scheduler, identity);
		const plans = await this.plans(collected, request, scheduler, identity);
		const alert = planCapability(plans == null ? void 0 : summarise(plans), await this.baseline());
		const readings = [...collected.values()];
		const footprint = scheduler.footprint();
		const id = randomUUID();
		const finishedAt = this.now();
		const retained = await this.keep(id, finishedAt, plans);
		return {
			id,
			runId: request.runId ?? randomUUID(),
			startedAt,
			finishedAt,
			state: state(footprint.cancelled, footprint.exhaustion != null),
			...footprint.cancelled ? { incompleteReason: "The run was cancelled. The advice below is formed from what it had read, and is not a complete picture of the estate." } : {},
			scope: request.scope,
			lookbackDays,
			stamp: {
				actor: identity.actor,
				executionMode: identity.mode,
				...request.warehouse != null ? { warehouse: request.warehouse } : {}
			},
			...request.definition != null ? { definition: request.definition } : {},
			readings: readings.map(withoutValue),
			...serverless(collected, lookbackDays),
			...workload(collected, lookbackDays, plans),
			...jobs(collected, lookbackDays),
			...sizing(collected, lookbackDays),
			...writes(collected, lookbackDays),
			...plans == null ? {} : { plans: summarise(plans) },
			...alert == null ? {} : { planCapability: alert },
			...retained == null ? {} : { retainedPlans: retained }
		};
	}
	/**
	* Keeps this run's extracts, and answers how many, or nothing where none were kept.
	*
	* Never throws, for the reason `baseline` does not: an advisory that produced a workload analysis and
	* failed to file its plans is worth saving, and losing it to a write on a table nothing has read yet
	* would be the worse trade. What stops that from being silent is the number it returns — the record
	* carries it, so a saved advisory reporting plans it read and no count of plans it kept says the write
	* did not finish. See `retainedPlans` on the record, which is the wording it can support: `keep` writes
	* a shape at a time, so a failure partway through has filed some of them and the count is absent.
	*
	* A plan with no `observedAt` is not kept. `retrievePlans` says why the field is optional: the case is
	* one the statement cannot produce, and an execution with no time cannot be ordered against the two it
	* would displace.
	*/
	async keep(advisoryId, advisoryAt, plans) {
		const store = this.options.planExtracts;
		if (store == null || plans == null || plans.plans.length === 0) return void 0;
		try {
			const shapeVersion = shapeFingerprintVersion(this.shapeStatement());
			const retained = plans.plans.flatMap((plan) => plan.observedAt == null ? [] : [{
				workspaceId: plan.workspaceId,
				shape: plan.shape,
				statementId: plan.statementId,
				advisoryId,
				advisoryAt,
				observedAt: plan.observedAt,
				shapeVersion,
				extract: plan.extract
			}]);
			await store.keep(retained);
			return retained.length;
		} catch {
			return;
		}
	}
	/**
	* The shape statement's text.
	*
	* Held on the runner rather than read per run: `FileQuerySource` reads and expands a 600-line file, and
	* a runner outlives the runs it performs. Reading it once is also what makes the version a statement
	* about the build rather than about whatever is on disk during a long-lived process.
	*/
	shapeStatement() {
		this.shapeText ??= (this.options.queries ?? new FileQuerySource()).text(SHAPE_STATEMENT);
		return this.shapeText;
	}
	/**
	* The newest earlier run whose plan reach means anything, or nothing.
	*
	* Bounded at five rather than the whole history, because the point of walking back at all is to step over
	* a run that could not list warehouses, and a baseline six runs old says less about today's estate than
	* about how long the app has been broken. Each candidate costs a `get`, since `history` returns summaries.
	*
	* Never throws: a baseline that cannot be read makes the alert quieter, and losing an advisory to a failed
	* history query would be a worse trade than losing the comparison.
	*/
	async baseline() {
		try {
			const history = await this.options.store.history(BASELINE_LOOKBACK);
			for (const entry of history) {
				const earlier = await this.options.store.get(entry.id);
				if (earlier?.plans != null && isBaseline(earlier.plans)) return {
					advisoryId: earlier.id,
					plans: earlier.plans
				};
			}
		} catch {
			return;
		}
	}
	/**
	* Fetches a plan for each shape the endpoint can answer for, or nothing when there are no shapes.
	*
	* After collection rather than inside it, because a plan fetch is not a signal: it reads nothing off
	* the estate that a control could score, and it needs the shapes as *rows* — which `collectSignals`
	* strips from the record but keeps in the map it returns.
	*
	* Never throws. The warehouse list is the one call here that can fail in a way that stops everything,
	* and the scheduler answers rather than raising: an advisory run that produced a workload analysis and
	* could not list warehouses should return the analysis, with the record saying plan retrieval was not
	* possible. `warehousesKnown` is what carries that, and it is why the empty set and the refusal are
	* not collapsed into one.
	*/
	async plans(collected, request, scheduler, identity) {
		const reading = collected.get(QUERY_SHAPES);
		if (reading?.status !== "observed") return void 0;
		const shapes = rowsOf(reading.value);
		if (shapes.length === 0) return void 0;
		const access = (this.options.planAccess ?? REAL_PLAN_ACCESS)(request.credentials, identity);
		const listing = await scheduler.run({
			surface: "rest",
			label: "rest:warehouses.list",
			run: () => access.warehouseIds()
		});
		return retrievePlans({
			shapes,
			localWarehouseIds: listing.status === "ok" ? listing.value : /* @__PURE__ */ new Set(),
			warehousesKnown: listing.status === "ok",
			fetcher: access.fetcher,
			scheduler
		});
	}
};
/** How completely the run got through its plan. */
function state(cancelled, exhausted) {
	return cancelled || exhausted ? "partial" : "complete";
}
/**
* The serverless analysis, when there was anything to analyse.
*
* Unconditional here, unlike in a scan where it is gated on the requirements being in scope: an
* advisory run exists in order to produce this, so gating it would gate the run's only output.
*/
function serverless(collected, lookbackDays) {
	const analysis = analyseServerless(collected, lookbackDays);
	return analysis == null ? {} : { serverless: analysis };
}
/**
* The workload analysis, when the shapes could be read.
*
* Absent rather than empty where the signal was unreadable or the window held no queries, for the reason
* `analyseWorkload` gives: an empty analysis renders as an estate with no expensive queries, which is a
* finding this run did not make. The readings on the record are what distinguish the two.
*
* Gated on the shapes alone, where the statistics reading only narrows what one rule can say. That asymmetry
* is the same one `sizing` draws against its inventory, and for the same reason: an estate whose lineage table
* is not readable should still get the twelve rules that do not need it.
*/
function workload(collected, lookbackDays, plans) {
	const reading = collected.get(QUERY_SHAPES);
	if (reading?.status !== "observed") return {};
	const statistics = collected.get(TABLE_STATISTICS);
	const analysis = analyseWorkload(rowsOf(reading.value), lookbackDays, workloadRules(), planIndex(plans?.plans), statsIndex(statistics?.status === "observed" ? rowsOf(statistics.value?.tables) : void 0));
	return analysis == null ? {} : { workload: analysis };
}
/**
* The job analysis, when the run health statement could be read.
*
* Gated on that statement alone, the same asymmetry `sizing` draws against its inventory: the inventory is
* what gives a job its name, and its absence costs the names rather than the analysis. An estate whose
* `system.lakeflow.jobs` read was refused still gets four rules over its runs, reported by job id.
*
* The compute reading is passed the same way and the asymmetry there is sharper: it is passed as
* `undefined` when the statement was not observed and as its rows — possibly none — when it was. The
* analysis renders those differently, because a run that did not ask and a run that asked and found an
* all-serverless estate are not the same fact about the estate's clusters.
*/
function jobs(collected, lookbackDays) {
	const reading = collected.get(JOB_RUN_HEALTH);
	if (reading?.status !== "observed") return {};
	const inventory = collected.get(JOB_INVENTORY);
	const compute = collected.get(JOB_COMPUTE);
	const analysis = analyseJobs(rowsOf(reading.value?.jobs), inventory?.status === "observed" ? rowsOf(inventory.value) : [], lookbackDays, void 0, compute?.status === "observed" ? rowsOf(compute.value?.jobs) : void 0);
	if (analysis == null) return {};
	const directory = collected.get(WORKSPACES);
	const locate = linksIn(directory?.status === "observed" ? directory.value : void 0);
	return { jobs: {
		...analysis,
		jobs: analysis.jobs.map((job) => {
			const link = locate(asJob(job));
			return {
				...job,
				...link != null ? { link } : {}
			};
		})
	} };
}
/**
* The warehouse sizing analysis, when the pressure statement could be read.
*
* Gated on the pressure signal alone. The inventory is what names a warehouse and what tells a classic one
* from serverless, and its absence degrades the analysis rather than voiding it: a warehouse with no
* matched definition is reported by id, and the one rule that needs to know the type declines to fire.
* Requiring both would throw away a readable measurement because a second statement failed.
*/
function sizing(collected, lookbackDays) {
	const reading = collected.get(WAREHOUSE_PRESSURE);
	if (reading?.status !== "observed") return {};
	const inventory = collected.get(WAREHOUSE_INVENTORY);
	const analysis = analyseSizing(rowsOf(reading.value), inventory?.status === "observed" ? rowsOf(inventory.value) : [], lookbackDays);
	if (analysis == null) return {};
	const directory = collected.get(WORKSPACES);
	const locate = linksIn(directory?.status === "observed" ? directory.value : void 0);
	return { sizing: {
		...analysis,
		warehouses: analysis.warehouses.map((warehouse) => {
			const link = locate(asWarehouse(warehouse));
			return {
				...warehouse,
				...link != null ? { link } : {}
			};
		})
	} };
}
/**
* The write pattern analysis, when the write statement could be read.
*
* Gated on that statement alone, and there is no second signal to degrade against: everything the two rules
* read is in the one row. An estate whose history could not be read has no analysis here rather than an
* empty one, for the reason `analyseWrites` gives — an empty one would say the estate writes nothing.
*/
function writes(collected, lookbackDays) {
	const reading = collected.get(WRITE_PATTERNS);
	if (reading?.status !== "observed") return {};
	const analysis = analyseWrites(rowsOf(reading.value), lookbackDays);
	return analysis == null ? {} : { writes: analysis };
}
/**
* A reading without its rows.
*
* The same thing `encodeScan` does before a scan is written, done here rather than in the store because
* an advisory in memory should not hold the estate either — the in-memory store keeps twenty of them.
*/
function withoutValue(reading) {
	const { value: _value, ...rest } = reading;
	return rest;
}
//#endregion
export { ADVISORY_SIGNALS, AdvisoryInProgressError, AdvisoryRunner, JOB_COMPUTE, JOB_RUN_HEALTH, QUERY_SHAPES, TABLE_STATISTICS, WAREHOUSE_INVENTORY, WAREHOUSE_PRESSURE, WRITE_PATTERNS };
