import { ScanInProgressError } from "../scan/runner.js";
import { AdvisoryInProgressError } from "../advise/runner.js";
import { RunAdmissionRefused, answered, endedAs, joinable, live, refusalMeans, resumeFrom, unheld } from "./run.js";
import { randomUUID } from "node:crypto";
//#region server/run/runs.ts
/** A trigger that could not join the run its key names, with the reason a caller is owed. */
var RunNotJoinable = class extends Error {
	run;
	refusal;
	constructor(run, refusal) {
		super(refusalMeans(refusal, run));
		this.run = run;
		this.refusal = refusal;
		this.name = "RunNotJoinable";
	}
};
var Runs = class {
	options;
	holder;
	heartbeatMs;
	now;
	/**
	* The run this process is collecting, per kind, while it is collecting it.
	*
	* Kept here rather than read back from the store because the question it answers is about this
	* process: the in-progress refusal and the status of a scan this process started need the run's name,
	* and which run *another* instance holds is for `live` to say. Per kind because an assessment and an
	* advisory run may be going at once, and one pointer would have whichever started last hide the other.
	*
	* Set only for an attempt that actually started collecting, and cleared only by that attempt: a
	* trigger that was refused must leave the pointer of the run that is still going as it found it.
	*/
	held = {};
	constructor(options) {
		this.options = options;
		this.holder = options.holder ?? `${process.pid.toString()}-${randomUUID().slice(0, 8)}`;
		this.heartbeatMs = options.heartbeatMs ?? 15 * 1e3;
		this.now = options.now ?? (() => /* @__PURE__ */ new Date());
	}
	/**
	* Starts a run, or carries on the one this key already names.
	*
	* Throws `RunNotJoinable` where the key names a run this trigger may not continue, which is four
	* different mistakes with four different answers — see `refusalMeans`. It does not throw for the
	* ordinary duplicate: a retry arriving while the first attempt is dead is the case this is for.
	*/
	async trigger(request, who) {
		const asked = requestOf(request, this.options.defaultLookbackDays);
		const at = this.now();
		await this.refuseIfBusy("assessment", who.idempotencyKey);
		const { run, created } = await this.options.store.open({
			id: randomUUID(),
			kind: "assessment",
			actor: who.actor,
			trigger: request.trigger ?? "interactive",
			...who.idempotencyKey != null ? { idempotencyKey: who.idempotencyKey } : {},
			request: asked,
			requestedAt: at
		}).catch((cause) => {
			throw this.inProgress("assessment", cause);
		});
		if (!created) {
			const refusal = joinable(run, {
				actor: who.actor,
				kind: "assessment",
				request: asked
			}, at);
			if (refusal != null) throw new RunNotJoinable(run, refusal);
			const busy = this.busy("assessment");
			if (busy != null) throw busy;
		}
		const attempt = await this.options.store.claim(run.id, this.holder, at);
		if (attempt == null) throw new RunNotJoinable(await this.options.store.get(run.id) ?? run, "held");
		const reached = resumeFrom(await this.options.store.checkpoints(run.id));
		return {
			run: await this.options.store.get(run.id) ?? run,
			resumed: !created || reached.size > 0,
			resumedFrom: reached.size,
			scan: this.collect("assessment", attempt, reached, () => this.options.runner.running() != null, (resumption) => this.options.runner.start({
				...request,
				...resumption
			}), (scan) => ({ scanId: scan.id }))
		};
	}
	/**
	* Starts an advisory run, or carries on the one this key already names.
	*
	* The same five steps in the same order as `trigger`, and deliberately the same code for four of
	* them: what differs between the two kinds is what gets collected and what the run points at when it
	* ends, and neither of those is a reason for a second copy of the lease, the checkpoints, the
	* idempotency key and the cancel flag. See ADR 0069, which argues this at length because the
	* temptation to fork was strong and the bug it would reintroduce is a specific one.
	*/
	async advise(request, who) {
		const advisor = this.options.advisor;
		if (advisor == null) throw new Error("This build has no workload advisor, so there is nothing to run. An install without it has no Optimisation section either, so reaching here means something called the coordinator directly.");
		const asked = adviceOf(request, this.options.defaultLookbackDays);
		const at = this.now();
		await this.refuseIfBusy("advisory", who.idempotencyKey);
		const { run, created } = await this.options.store.open({
			id: randomUUID(),
			kind: "advisory",
			actor: who.actor,
			trigger: who.trigger ?? "interactive",
			...who.idempotencyKey != null ? { idempotencyKey: who.idempotencyKey } : {},
			request: asked,
			requestedAt: at
		}).catch((cause) => {
			throw this.inProgress("advisory", cause);
		});
		if (!created) {
			const refusal = joinable(run, {
				actor: who.actor,
				kind: "advisory",
				request: asked
			}, at);
			if (refusal != null) throw new RunNotJoinable(run, refusal);
			const busy = this.busy("advisory");
			if (busy != null) throw busy;
		}
		const attempt = await this.options.store.claim(run.id, this.holder, at);
		if (attempt == null) throw new RunNotJoinable(await this.options.store.get(run.id) ?? run, "held");
		const reached = resumeFrom(await this.options.store.checkpoints(run.id));
		return {
			run: await this.options.store.get(run.id) ?? run,
			resumed: !created || reached.size > 0,
			resumedFrom: reached.size,
			advisory: this.collect("advisory", attempt, reached, () => advisor.running() != null, (resumption) => advisor.start({
				...request,
				...resumption,
				runId: run.id
			}), (advisory) => ({ advisoryId: advisory.id }))
		};
	}
	/**
	* Records that somebody asked a run to stop, and then makes sure something stops it.
	*
	* Which is three different situations, and the record alone only settles one of them. Where this
	* process holds the run, the in-process cancel makes it take effect between units rather than at the
	* next trigger. Where another process holds it, the flag is what reaches it, and that process ends
	* the run.
	*
	* Where **nothing** holds it — a run whose attempt was killed, which is the ordinary way a run is
	* left lying about — there is no attempt to obey the flag. An earlier version stopped at the record
	* and left that run `running` for ever unless somebody happened to trigger it again, so cancelling
	* the abandoned run a supervisor could see was the one cancel that did nothing at all. So this
	* concludes it here: take the lease, which nothing else may then take, and end it as cancelled.
	*
	* A run that already said something about the estate is refused rather than flagged, and the check
	* comes before the write. Answering a cancel of last night's finished assessment with "stopped" tells
	* a supervisor its retry was called off when nothing was called off, and writes a cancel date onto a
	* complete run for a reader to make what they can of later. A `failed` run is not refused: nothing
	* about the estate came of it, it can be taken back up, and "do not pick this one up again" is a real
	* thing to ask for.
	*/
	async cancel(runId) {
		const run = await this.options.store.get(runId);
		if (run == null) return "no-such-run";
		const at = this.now();
		if (answered(run.state)) return "already-ended";
		await this.options.store.cancel(runId, at);
		if (run.lease?.holder === this.holder) {
			if (run.kind === "advisory") this.options.advisor?.cancel();
			else this.options.runner.cancel();
			return "stopping";
		}
		if (!unheld(run, at)) return "stopping";
		const attempt = await this.options.store.claim(runId, this.holder, at);
		if (attempt == null) return "stopping";
		await this.options.store.finish(attempt, {
			state: "cancelled",
			at,
			why: "Somebody asked for this run to stop while no process was working on it."
		});
		return "stopping";
	}
	/** The run of a kind this process is collecting, or undefined when it is collecting none. */
	holding(kind = "assessment") {
		return this.held[kind];
	}
	/** Whether a run is this process's own, either because it is collecting it or has just claimed its lease. */
	owns(run) {
		return this.held[run.kind] === run.id || run.lease?.holder === this.holder;
	}
	/**
	* The run of a kind that something is working on, wherever it is working.
	*
	* Read from the record, so that every instance answers the same: the status of a scan is a fact about
	* the install, and a page that happened to be served by a different instance from the one that started
	* it should still be told. Newest first, though admission keeps it to one.
	*/
	async live(kind) {
		const at = this.now();
		return (await this.options.store.unfinished()).find((run) => run.kind === kind && live(run, at));
	}
	async get(runId, scope) {
		return this.options.store.get(runId, scope);
	}
	async recent(limit, scope) {
		return this.options.store.recent(limit, scope);
	}
	/**
	* The run a key names, for a caller that has its own key and not the id.
	*
	* Which is the ordinary case for a supervisor whose trigger did not come back: it knows what it asked
	* for, because it chose the key, and it never saw the id the app minted.
	*/
	async byKey(key) {
		return this.options.store.byKey(key);
	}
	/** The runs nothing has finished, anywhere — not only the one this process is collecting. */
	async unfinished() {
		return this.options.store.unfinished();
	}
	/**
	* The refusal for a run of this kind already collecting in this process, or undefined where none is.
	*
	* Named with the run this process holds, where it holds one: a scan started outside the coordinator
	* has no record, and the refusal then says so by carrying none.
	*/
	busy(kind) {
		if (kind === "advisory") {
			const going = this.options.advisor?.running();
			return going == null ? void 0 : new AdvisoryInProgressError(going.startedAt, going.actor, this.held.advisory);
		}
		const going = this.options.runner.running();
		return going == null ? void 0 : new ScanInProgressError(going, this.held.assessment);
	}
	/**
	* Turns away a trigger this process can already see will not start, before anything is written.
	*
	* Skipped for a key that already names a run. That is a retry, and what it is owed is the answer
	* `joinable` gives — still being worked on, already finished, somebody else's — rather than a
	* statement that something is running. A key that names nothing is a new intention like any other and
	* is refused here; the read costs one round trip against the write and the failed run it avoids.
	*/
	async refuseIfBusy(kind, key) {
		const busy = this.busy(kind);
		if (busy == null) return;
		if (key != null && await this.options.store.byKey(key) != null) return;
		throw busy;
	}
	/**
	* The in-progress error for a run another instance is working on, in the form each kind of run
	* already answers with. Anything else the store raised passes through as it was.
	*
	* What another instance has done so far is not known here, so a scan's call count is reported as zero
	* rather than guessed: the count is a progress figure for the process doing the work.
	*/
	inProgress(kind, cause) {
		if (!(cause instanceof RunAdmissionRefused)) return cause;
		const { run } = cause;
		if (kind === "advisory") return new AdvisoryInProgressError(run.requestedAt, run.actor, run.id);
		return new ScanInProgressError({
			startedAt: run.requestedAt,
			actor: run.actor,
			scope: run.request.scope,
			trigger: run.trigger,
			callsMade: 0
		}, run.id);
	}
	/**
	* Runs the collection under a claim, and ends the run whatever happens.
	*
	* Every exit writes an ending, including the throw. A run left `running` by a failure is one the
	* lease will eventually free, so nothing is stuck — but for the minute until then the app reports a
	* run in progress that is not, and the reason it failed is nowhere. `failed` with the message is
	* both true and readable.
	*/
	async collect(kind, attempt, reached, occupied, execute, produced) {
		const beating = setInterval(() => {
			this.options.store.renew(attempt, this.now()).catch(() => void 0);
		}, this.heartbeatMs);
		beating.unref?.();
		const started = !occupied();
		if (started) this.held[kind] = attempt.runId;
		try {
			const result = await execute({
				...reached.size > 0 ? { resume: reached } : {},
				checkpoint: (readings) => this.options.store.checkpoint(attempt.runId, readings, this.now()),
				stopping: () => this.options.store.cancelRequested(attempt.runId)
			});
			const asked = await this.options.store.cancelRequested(attempt.runId);
			await this.options.store.finish(attempt, {
				state: endedAs(result, asked),
				at: this.now(),
				...produced(result),
				...asked ? { why: "Somebody asked for this run to stop, and it saved what it had reached." } : {}
			});
			return result;
		} catch (cause) {
			await this.options.store.finish(attempt, {
				state: "failed",
				at: this.now(),
				why: cause instanceof Error ? cause.message : String(cause)
			});
			throw cause;
		} finally {
			clearInterval(beating);
			if (started && this.held[kind] === attempt.runId) delete this.held[kind];
		}
	}
};
/**
* What an advisory trigger asked for, as the record keeps it.
*
* `pillars` is never set, because an advisory run has none — nothing here scores, so there is no subset
* to narrow to. Its absence is what makes the same key mean the same request across a retry, so it is
* left off rather than set to an empty list, which would compare as a different ask.
*/
function adviceOf(request, defaultLookbackDays = 30) {
	return {
		scope: request.scope,
		lookbackDays: request.lookbackDays ?? defaultLookbackDays,
		...request.warehouse != null ? { warehouse: request.warehouse } : {},
		...request.definition != null ? { definition: request.definition } : {}
	};
}
/** What was asked for, as the record keeps it, with the window resolved to the number the run will use. */
function requestOf(request, defaultLookbackDays = 30) {
	return {
		scope: request.scope,
		lookbackDays: request.lookbackDays ?? defaultLookbackDays,
		...request.pillars != null ? { pillars: request.pillars } : {},
		...request.warehouse != null ? { warehouse: request.warehouse } : {},
		...request.definition != null ? { definition: request.definition } : {}
	};
}
//#endregion
export { RunNotJoinable, Runs, adviceOf, requestOf };
