import { accountOf, workspaceOf } from "../import/envelope.js";
import { newestFirst } from "../apply/applicability.js";
import { CollectionScheduler } from "./scheduler.js";
import { readingsFrom } from "../import/signals.js";
import { aliasLookup, runScan } from "./scan.js";
import { restWorkspace } from "../collect/estate-scope.js";
import { effective } from "../attest/store.js";
import { carryForward } from "./carry-forward.js";
//#region server/scan/runner.ts
var ScanInProgressError = class extends Error {
	running;
	run;
	/**
	* `run` names the record behind the scan that is running, where there is one, so a refused caller
	* can follow it. Absent for a scan started outside the coordinator, which has no record to name.
	*/
	constructor(running, run) {
		super(`A scan started by ${running.actor} at ${running.startedAt.toISOString()} is already running${run == null ? "" : ` as run ${run}`}. Only one scan runs at a time so two admins cannot double the load on the warehouse for the same answer. Wait for it to finish; its results will be the latest scan.`);
		this.running = running;
		this.run = run;
		this.name = "ScanInProgressError";
	}
};
var ScanRunner = class {
	options;
	inFlight;
	scheduler;
	constructor(options) {
		this.options = options;
	}
	/**
	* The run in flight, if there is one, with its progress as at this call.
	*
	* Composed rather than stored, because the count rises while the run goes: a stored one would be
	* the count as at the moment the run started, which is always zero.
	*/
	running() {
		if (this.inFlight == null) return void 0;
		return {
			...this.inFlight.started,
			callsMade: this.callsMade()
		};
	}
	/**
	* Calls that have reached a surface so far.
	*
	* Skipped work is left out on purpose — see `RunningScan.callsMade`. Retries are counted,
	* because a retry is another call the warehouse or the API actually served.
	*/
	callsMade() {
		if (this.scheduler == null) return 0;
		return Object.values(this.scheduler.footprint().tasks).reduce((total, surface) => total + surface.ok + surface.failed + surface.retries, 0);
	}
	/** The in-flight scan's promise, for a caller content to wait rather than be refused. */
	join() {
		return this.inFlight?.promise;
	}
	/**
	* Starts a scan, or refuses because one is already running.
	*
	* **Nothing is awaited between the check and the claim.** Two admins pressing scan in the same tick
	* both run the synchronous prologue before either suspends, so a claim taken after
	* `await credentials.databricks()` is one both of them pass — and the lock that exists to stop two
	* full passes over the same system tables would allow exactly the case it was written for. Everything
	* that needs awaiting therefore happens inside `pass`, and the actor on the claim is filled in when
	* the credentials arrive: a second caller in that window is told the truth about the timing and
	* "somebody" about the person, which is better than being let through.
	*
	* `async` with nothing awaited before the claim, which is not a contradiction: the body of an async
	* function runs synchronously up to its first `await`, so the claim is taken in the same tick and the
	* refusal still reaches a caller as a rejection rather than as a throw from a method whose signature
	* promises one.
	*/
	async start(request) {
		const already = this.running();
		if (already != null) throw new ScanInProgressError(already);
		const scheduler = new CollectionScheduler();
		const started = {
			startedAt: /* @__PURE__ */ new Date(),
			actor: "somebody",
			scope: request.scope,
			...request.trigger != null && { trigger: request.trigger }
		};
		const promise = this.pass(request, scheduler, started).finally(() => {
			this.inFlight = void 0;
			this.scheduler = void 0;
		});
		this.inFlight = {
			started,
			promise
		};
		this.scheduler = scheduler;
		return promise;
	}
	/** The scan itself, from the first thing that has to be awaited onwards. */
	async pass(request, scheduler, started) {
		started.actor = (await request.credentials.databricks()).actor;
		const evaluate = request.pillars ?? this.options.measuredPillars;
		const scope = request.definition?.id ?? null;
		const attestations = await this.answers(scope);
		const imported = await this.importedReadings(request.scope);
		const decisions = await this.decisions(scope);
		const fresh = await runScan({
			catalogue: this.options.catalogue,
			registry: this.options.registry,
			collectors: request.collectors,
			credentials: request.credentials,
			scope: request.scope,
			lookbackDays: request.lookbackDays ?? this.options.defaultLookbackDays ?? 30,
			scheduler,
			attestations,
			...decisions.size > 0 ? { decisions } : {},
			...imported.size > 0 ? { imported } : {},
			...request.warehouse != null ? { warehouse: request.warehouse } : {},
			...request.trigger != null ? { trigger: request.trigger } : {},
			...request.definition != null ? { definition: request.definition } : {},
			...evaluate != null ? { pillars: evaluate } : {},
			...this.options.declaredScopes != null ? { declaredScopes: this.options.declaredScopes } : {},
			...request.resume != null ? { resume: request.resume } : {},
			...request.checkpoint != null ? { checkpoint: request.checkpoint } : {},
			...request.stopping != null ? { stopping: request.stopping } : {}
		});
		const scan = await this.merge(fresh, request.pillars, decisions, scope);
		await this.options.store.save(scan);
		await this.settled(scan);
		return scan;
	}
	/**
	* Runs the after-the-scan work, and swallows a failure in it.
	*
	* After the save rather than before, so the run is on the record before anything reads it, and
	* swallowed because the two are not the same claim: a scan that measured the estate and could not
	* settle a validation has still measured the estate, and rejecting here would turn that into a scan
	* the caller is told failed and can nonetheless find in the history. The hook's own job is to report
	* what it could not do.
	*/
	async settled(scan) {
		if (this.options.onFinished == null) return;
		try {
			await this.options.onFinished(scan);
		} catch {}
	}
	/**
	* The attested answers that still count, by control id.
	*
	* A store that cannot be read yields none rather than failing the scan. An unreachable
	* volume should cost the attested requirements, which then report as unmeasured with a
	* reason — not the other five pillars, which do not depend on it at all.
	*/
	async answers(scope) {
		if (this.options.attestations == null) return /* @__PURE__ */ new Map();
		try {
			return effective(await this.options.attestations.current(scope));
		} catch {
			return /* @__PURE__ */ new Map();
		}
	}
	/**
	* The readings imported administrators collected that are about what this scan assesses, newest
	* collection winning.
	*
	* Read here for the same reasons the answers are: one read at the start of the run, so every
	* finding reflects the same set of imports, and a store that cannot be read yields none rather
	* than failing the scan — an unreachable table should cost the imported requirements, which then
	* report as unmeasured with a reason, not the pillars that never depended on it.
	*
	* Scoped, because an account install holds files from several workspaces and a setting is a fact
	* about one of them. The workspace half of a file applies only when it was collected from the
	* workspace the REST surface describes — the one this app is installed in, or the one the scan was
	* narrowed to — and never to a scan whose workspace is not known, since a reading that cannot be
	* attributed cannot be shown to be about anything. The account half describes the account, so it
	* applies to every scan but only from files of the scan's account: the one the newest file for the
	* scanned workspace names, or failing that the newest file that names one at all. When no file
	* names an account there is nothing to hold them to and they all apply. The import-time check
	* refuses a file for a different account than the one already held, so this is the second of two.
	*
	* Oldest applied first so that a newer collection of the same signal overwrites an older one, which
	* makes the winner the newest import for each signal and workspace: only one workspace's files get
	* this far. That ordering is this method's business and not `merged`'s, which is deliberately
	* ignorant of dates: it enforces the class rule between observed and imported, and both of these
	* are imported.
	*/
	async importedReadings(scope) {
		if (this.options.imports == null) return /* @__PURE__ */ new Map();
		try {
			const held = await this.options.imports.all();
			const describes = restWorkspace(scope);
			const newest = [...held].sort((a, b) => b.generatedAt.getTime() - a.generatedAt.getTime());
			const account = [...newest.filter((one) => describes != null && (one.workspaceId ?? workspaceOf(one.envelope)) === describes), ...newest].map((one) => accountOf(one.envelope)).find((id) => id != null);
			const applied = /* @__PURE__ */ new Map();
			for (const one of [...newest].reverse()) {
				const workspaceId = one.workspaceId ?? workspaceOf(one.envelope);
				const tiers = [];
				if (account == null || accountOf(one.envelope) === account) tiers.push("account");
				if (describes != null && workspaceId === describes) tiers.push("workspace");
				for (const [id, reading] of readingsFrom(one, tiers).signals) applied.set(id, reading);
			}
			return applied;
		} catch {
			return /* @__PURE__ */ new Map();
		}
	}
	/**
	* The customer's applicability decisions, by control id, newest first.
	*
	* Grouped here so `runScan` and `carryForward` are handed a lookup rather than a store to query per
	* control. A store that cannot be read yields none rather than failing the scan — the same choice the
	* answers and imports make — because an unreadable decisions table should cost the exclusions, which
	* then simply do not apply this run, not the whole assessment.
	*/
	async decisions(scope) {
		if (this.options.applicability == null) return /* @__PURE__ */ new Map();
		try {
			const byControl = /* @__PURE__ */ new Map();
			for (const decision of await this.options.applicability.all(scope)) {
				const group = byControl.get(decision.controlId) ?? [];
				group.push(decision);
				byControl.set(decision.controlId, group);
			}
			return new Map([...byControl].map(([controlId, group]) => [controlId, newestFirst(group)]));
		} catch {
			return /* @__PURE__ */ new Map();
		}
	}
	/**
	* A targeted run's result, with the pillars it left alone brought forward.
	*
	* Read here rather than inside `runScan` because the previous scan is the store's
	* business, and a scan that fetched its own predecessor would be a scan that cannot be
	* run against a store at all.
	*/
	async merge(fresh, pillars, decisions, scope) {
		if (pillars == null) return fresh;
		const previous = await this.options.store.latest(scope);
		return carryForward({
			fresh: {
				...fresh,
				requestedPillars: pillars
			},
			previous,
			measuredPillars: pillars,
			aliasGroupOf: aliasLookup(this.options.catalogue),
			...decisions.size > 0 ? { decisions } : {},
			now: fresh.finishedAt
		});
	}
	/** Cancels the running scan cooperatively. Its partial results are still saved. */
	cancel() {
		if (this.scheduler == null) return false;
		this.scheduler.cancel();
		return true;
	}
};
//#endregion
export { ScanInProgressError, ScanRunner };
