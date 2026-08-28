import { assessmentOf } from "./assessment-query.js";
const NOTHING_RECORDED = "This install keeps no run records, so there is no history of what was asked for or what became of it. A scan still runs and its result is still shown, but a run that is interrupted is lost rather than resumed, and a scheduled run that failed leaves nothing behind saying so. Bind a Lakebase instance and runs are recorded from that point.";
/**
* One run, as a reader outside the process sees it.
*
* `now` decides whether the lease still holds, and is a parameter rather than a read of the clock so
* that the lapsed case is assertable: it is the one branch here whose answer depends on when it is read.
*/
function runPayload(run, now = /* @__PURE__ */ new Date()) {
	return {
		id: run.id,
		state: run.state,
		requestedAt: run.requestedAt.toISOString(),
		actor: run.actor,
		trigger: run.trigger,
		attempts: run.attempts,
		...run.lease != null && run.lease.until.getTime() > now.getTime() ? { heldUntil: run.lease.until.toISOString() } : {},
		...run.cancelRequestedAt != null ? { cancelRequestedAt: run.cancelRequestedAt.toISOString() } : {},
		kind: run.kind,
		...run.scanId != null ? { scanId: run.scanId } : {},
		...run.advisoryId != null ? { advisoryId: run.advisoryId } : {},
		...run.finishedAt != null ? { finishedAt: run.finishedAt.toISOString() } : {},
		...run.why != null ? { why: run.why } : {},
		lookbackDays: run.request.lookbackDays,
		...run.request.pillars != null ? { pillars: run.request.pillars } : {}
	};
}
/**
* What a caller is told when its trigger collided with a run it may not carry on.
*
* `summary` is passed in rather than read here, because what a finished run found is a question about a
* scan and this module knows only about runs. Present only for `terminal`, and only where the caller
* could load the scan: see `RunRefusedPayload.summary` for why a supervisor needs it.
*/
function refusedPayload(cause, summary) {
	return {
		error: "run-not-joinable",
		refusal: cause.refusal,
		message: cause.message,
		run: runPayload(cause.run),
		...summary != null ? { summary } : {}
	};
}
function registerRunRoutes(app, options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	/**
	* The runs this install has a record of, newest first.
	*
	* Capped, and the cap is not a page: nothing in the product asks for the run before last, and an
	* endpoint that could be asked for four years of nightly runs is one that reads a hundred thousand
	* rows to draw a list nobody scrolls. Where a reader wants an older run they have its id, from the
	* scan or from the job that asked for it.
	*
	* Two filters, and both exist because a supervisor has a question the id-addressed route cannot
	* answer. `?key=` is for the trigger whose response never arrived: the caller chose the key, so it
	* knows that, and it never saw the id the app minted. `?unfinished=true` is "is anything still going,
	* anywhere" — which is not what `/api/scan/status` reports, because that is about this process.
	*/
	app.get("/api/runs", async (request, response) => {
		const runs = options.runs;
		if (runs == null) {
			const nothing = {
				durable: false,
				runs: [],
				unavailable: NOTHING_RECORDED
			};
			response.json(nothing);
			return;
		}
		const key = typeof request.query.key === "string" ? request.query.key : void 0;
		try {
			const at = now();
			const payload = {
				durable: true,
				runs: (key != null ? [await runs.byKey(key)].filter((one) => one != null) : request.query.unfinished === "true" ? await runs.unfinished() : await runs.recent(50, assessmentOf(request))).map((one) => runPayload(one, at))
			};
			response.json(payload);
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	});
	/**
	* One run.
	*
	* A 404 for an id nothing knows, which is deliberately not the same answer as the one for an install
	* that records nothing: a supervisor polling an id it was given needs to tell "your run is gone" from
	* "this app never keeps runs", because the first is a fault and the second is a configuration.
	*/
	app.get("/api/runs/:id", async (request, response) => {
		const runs = options.runs;
		const id = request.params.id ?? "";
		if (runs == null) {
			response.status(409).json({
				error: "nothing-recorded",
				message: NOTHING_RECORDED
			});
			return;
		}
		try {
			const run = await runs.get(id, assessmentOf(request));
			if (run == null) {
				response.status(404).json({
					error: "no-such-run",
					message: `No run here has the id ${id}. Either it was never asked for, or it has been removed by a retention sweep — runs are kept for the assessment period, like the scans they produce.`
				});
				return;
			}
			response.json(runPayload(run, now()));
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	});
	/**
	* Stop a run, by name.
	*
	* Distinct from `POST /api/scan/cancel`, which stops whatever this process is doing and cannot name
	* what that was. This one is addressed, so a supervisor can stop the run it started rather than
	* whichever run happens to be in flight when its request lands — and it works on a run this process
	* is not running, because the request is recorded and obeyed by whoever picks the run up.
	*/
	app.post("/api/runs/:id/cancel", async (request, response) => {
		const id = request.params.id ?? "";
		let act;
		try {
			const kind = (await options.runs?.get(id))?.kind ?? "assessment";
			act = (await options.permitted(request, response, kind === "advisory" ? "advisory.cancel" : "scan.cancel", { target: {
				kind: "run",
				id
			} })).act;
			const runs = options.runs;
			if (runs == null) {
				await act.failed("nothing-recorded");
				response.status(409).json({
					error: "nothing-recorded",
					message: NOTHING_RECORDED
				});
				return;
			}
			const cancelled = await runs.cancel(id);
			if (cancelled === "no-such-run") {
				await act.failed("no-such-run");
				response.status(404).json({
					error: "no-such-run",
					message: `No run here has the id ${id}, so there was nothing to stop.`
				});
				return;
			}
			if (cancelled === "already-ended") {
				const ended = await runs.get(id);
				await act.failed("already-ended");
				response.status(409).json({
					error: "already-ended",
					message: `This run had already finished as ${ended?.state ?? "ended"}, so there was nothing to stop. What it read is recorded and can be read from the run.`,
					...ended != null ? { run: runPayload(ended, now()) } : {}
				});
				return;
			}
			await act.performed();
			response.json(runPayload(await runs.get(id), now()));
		} catch (cause) {
			await act?.failed(cause);
			options.respondToFailure(response, cause);
		}
	});
}
//#endregion
export { refusedPayload, registerRunRoutes, runPayload };
