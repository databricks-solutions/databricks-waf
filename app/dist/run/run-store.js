import { applyScope } from "../store/assessment-scope.js";
//#region server/run/run-store.ts
const COLUMNS = "id, kind, requested_at, actor, trigger, idempotency_key, request, state, attempts, lease_holder, lease_until, cancel_requested_at, scan_id, advisory_id, finished_at, why";
var PostgresRunStore = class {
	db;
	durable = true;
	constructor(db) {
		this.db = db;
	}
	/**
	* Starts a run, letting the database refuse a duplicate key.
	*
	* `on conflict do nothing` and then a read, rather than reading first: the read-then-insert version
	* has both of two simultaneous retries see no run and both insert, and one of them raises. Doing it
	* this way, the second insert is a no-op and the read that follows finds the run the first created,
	* which is the answer the caller wanted anyway.
	*
	* The generated id is discarded in that case. That is fine and worth being explicit about: an id is
	* cheap, and the alternative — asking the caller to check first — is the race this avoids.
	*/
	async open(opening) {
		const key = opening.idempotencyKey;
		await this.db.query(`insert into ${this.db.schema}.runs
         (id, kind, requested_at, actor, trigger, idempotency_key, request, state, attempts, lease_until,
          definition_id)
         values ($1, $9, $2, $3, $4, $5, $6::jsonb, $7, $8, $2, $10)
         on conflict (idempotency_key) do nothing`, [
			opening.id,
			opening.requestedAt,
			opening.actor,
			opening.trigger,
			key ?? null,
			JSON.stringify(opening.request),
			"running",
			0,
			opening.kind,
			opening.request.definition?.id ?? null
		]);
		const mine = await this.get(opening.id);
		if (mine != null) return {
			run: mine,
			created: true
		};
		if (key == null) throw new Error(`Run ${opening.id} was neither written nor already present.`);
		const theirs = await this.byKey(key);
		if (theirs == null) throw new Error(`Run key ${key} conflicted and then could not be read.`);
		return {
			run: theirs,
			created: false
		};
	}
	async get(id, scope) {
		const scoped = applyScope("where id = $1", [id], scope);
		const { rows } = await this.db.query(`select ${COLUMNS} from ${this.db.schema}.runs ${scoped.fragment}`, scoped.values);
		const row = rows[0];
		return row == null ? void 0 : reviveRun(row);
	}
	async byKey(key) {
		const { rows } = await this.db.query(`select ${COLUMNS} from ${this.db.schema}.runs where idempotency_key = $1`, [key]);
		const row = rows[0];
		return row == null ? void 0 : reviveRun(row);
	}
	async unfinished() {
		const { rows } = await this.db.query(`select ${COLUMNS} from ${this.db.schema}.runs where finished_at is null order by requested_at desc`);
		return rows.map(reviveRun);
	}
	async recent(limit, scope) {
		const scoped = applyScope("order by requested_at desc", [], scope);
		const { rows } = await this.db.query(`select ${COLUMNS} from ${this.db.schema}.runs ${scoped.fragment} limit $${String(scoped.values.length + 1)}`, [...scoped.values, limit]);
		return rows.map(reviveRun);
	}
	/**
	* Takes the lease, if it is free.
	*
	* The condition is in the `where` and not in an `if` above it, which is the whole of the
	* two-processes defence. `lease_until <= $4` rather than `<` so that a lease expiring exactly now is
	* available: the alternative leaves a run unclaimable for one clock tick, which is harmless and
	* arbitrary, and `unheld` in the domain reads the same way.
	*
	* The state is in there too, because a run that answered while this was deciding must not be picked
	* up — the attempt would collect an estate for a run that already has a scan. A `failed` run is
	* claimable, and put back to `running` by the claim: failure is the one ending that is not an answer,
	* and a retry of it is one assessment attempted twice rather than two assessments. See `ANSWERED`.
	*/
	async claim(runId, holder, at) {
		const until = new Date(at.getTime() + 60 * 1e3);
		await this.db.query(`update ${this.db.schema}.runs
         set lease_holder = $2, lease_until = $3, attempts = attempts + 1, state = $5, finished_at = null
         where id = $1 and state in ($5, $6) and lease_until <= $4`, [
			runId,
			holder,
			until,
			at,
			"running",
			"failed"
		]);
		const run = await this.get(runId);
		if (run?.lease?.holder !== holder || run.lease.until.getTime() !== until.getTime()) return void 0;
		const attempt = {
			id: `${runId}-${String(run.attempts)}`,
			runId,
			number: run.attempts,
			holder,
			startedAt: at,
			heartbeatAt: at
		};
		await this.db.query(`insert into ${this.db.schema}.run_attempts (id, run_id, number, holder, started_at, heartbeat_at)
         values ($1, $2, $3, $4, $5, $6)`, [
			attempt.id,
			attempt.runId,
			attempt.number,
			attempt.holder,
			attempt.startedAt,
			attempt.heartbeatAt
		]);
		await this.db.query(`update ${this.db.schema}.run_attempts set ended_at = $2, outcome = $4
         where run_id = $1 and ended_at is null and number < $3`, [
			runId,
			at,
			attempt.number,
			"abandoned"
		]);
		return attempt;
	}
	/**
	* Renews a claim, and only the holder's own.
	*
	* `lease_holder = $2` in the predicate is what makes a renewal fail after a takeover. Without it, a
	* process that stalled past its lease, had its run taken, and then woke up would extend a lease it
	* no longer holds — putting two attempts on one run, which is the thing the lease exists to stop.
	* The false answer is the signal for that process to stop.
	*/
	async renew(attempt, at) {
		const until = new Date(at.getTime() + 60 * 1e3);
		await this.db.query(`update ${this.db.schema}.runs set lease_until = $3
         where id = $1 and lease_holder = $2`, [
			attempt.runId,
			attempt.holder,
			until
		]);
		await this.db.query(`update ${this.db.schema}.run_attempts set heartbeat_at = $2 where id = $1`, [attempt.id, at]);
		const run = await this.get(attempt.runId);
		return run?.lease?.holder === attempt.holder && run.lease.until.getTime() === until.getTime();
	}
	/**
	* Records that somebody asked for this to stop, and nothing else.
	*
	* `cancel_requested_at is null` keeps the first request, so a second press does not move the time
	* and a reader can tell when the decision was made rather than when it was last repeated. Nothing
	* here writes `state`: a cancel is a request the running attempt obeys, and a cancel that set the
	* state itself would race the attempt that is finishing and could overwrite a saved scan's outcome.
	*/
	async cancel(runId, at) {
		await this.db.query(`update ${this.db.schema}.runs set cancel_requested_at = $2
         where id = $1 and cancel_requested_at is null`, [runId, at]);
	}
	async cancelRequested(runId) {
		const { rows } = await this.db.query(`select cancel_requested_at from ${this.db.schema}.runs where id = $1`, [runId]);
		return rows[0]?.cancel_requested_at != null;
	}
	/**
	* Saves what a collection unit read.
	*
	* Upserted per signal rather than appended, so a resumed attempt that re-read a signal replaces its
	* reading instead of adding a second. Without that the table grows by a copy of the estate for every
	* attempt, and `resumeFrom` has to sort a pile to find the one that counts.
	*/
	async checkpoint(runId, readings, at) {
		for (const reading of readings) await this.db.query(`insert into ${this.db.schema}.run_checkpoints (run_id, signal_id, at, reading)
           values ($1, $2, $3, $4::jsonb)
           on conflict (run_id, signal_id) do update set at = $3, reading = $4::jsonb`, [
			runId,
			reading.id,
			at,
			JSON.stringify(reading)
		]);
	}
	async checkpoints(runId) {
		const { rows } = await this.db.query(`select signal_id, at, reading from ${this.db.schema}.run_checkpoints where run_id = $1 order by at asc`, [runId]);
		return rows.map((row) => ({
			runId,
			at: new Date(row.at),
			readings: [row.reading]
		}));
	}
	/**
	* Ends the run, releases the lease, and drops what it was resuming from once there is a scan.
	*
	* The checkpoints go when the run produced one, because what they hold is then a second copy of
	* readings the scan has, and keeping them would mean the retention sweep eventually removing readings
	* still cited by a scan it kept. Dropped last, so a failure leaves a finished run with a dead
	* checkpoint rather than a running run with nothing to resume from.
	*
	* They stay when it did not. That is the failed ending, and the readings it reached are the only
	* record of them anywhere — throwing them away would make a retry re-read an estate this run has
	* already paid to read.
	*
	* **Nothing here is written unless this attempt still holds the lease, and that is decided by the
	* first statement rather than checked before it.** A process whose lease lapsed keeps collecting — the
	* failed renewal is deliberately ignored, because a heartbeat that took the process down mid-scan
	* would be worse — so a stale attempt does reach here, having read an estate and saved a scan, while
	* another attempt holds the run. Its ending is not the run's, so `returning` reports whether the
	* conditional update matched and the rest follows that answer: the checkpoints belong to whoever holds
	* the run and are what that attempt is resuming from, and the attempt row already says `abandoned`,
	* which is the truer account of it than an ending it wrote after losing the run.
	*/
	async finish(attempt, ending) {
		const { rows } = await this.db.query(`update ${this.db.schema}.runs
         set state = $2, finished_at = $3, scan_id = $4, advisory_id = $5, why = $6,
             lease_holder = null, lease_until = $3
         where id = $1 and lease_holder = $7
         returning id`, [
			attempt.runId,
			ending.state,
			ending.at,
			ending.scanId ?? null,
			ending.advisoryId ?? null,
			ending.why ?? null,
			attempt.holder
		]);
		if (rows.length === 0) return false;
		await this.db.query(`update ${this.db.schema}.run_attempts set ended_at = $2, outcome = $3 where id = $1`, [
			attempt.id,
			ending.at,
			ending.state
		]);
		if (ending.scanId != null || ending.advisoryId != null) await this.db.query(`delete from ${this.db.schema}.run_checkpoints where run_id = $1`, [attempt.runId]);
		return true;
	}
	/**
	* Gives up the claim without ending the run.
	*
	* What a process does when it is shutting down cleanly rather than being killed: the run stays
	* running, its checkpoints stay, and the next trigger may take it immediately instead of waiting out
	* a lease nobody is renewing.
	*/
	async release(attempt, at) {
		await this.db.query(`update ${this.db.schema}.runs set lease_holder = null, lease_until = $3
         where id = $1 and lease_holder = $2`, [
			attempt.runId,
			attempt.holder,
			at
		]);
		await this.db.query(`update ${this.db.schema}.run_attempts set ended_at = $2, outcome = $3 where id = $1`, [
			attempt.id,
			at,
			"abandoned"
		]);
	}
	async attempts(runId) {
		const { rows } = await this.db.query(`select id, run_id, number, holder, started_at, heartbeat_at, ended_at, outcome
         from ${this.db.schema}.run_attempts where run_id = $1 order by number asc`, [runId]);
		return rows.map(reviveAttempt);
	}
};
function reviveRun(row) {
	const lease = row.lease_holder == null || row.lease_until == null ? void 0 : {
		holder: row.lease_holder,
		until: new Date(row.lease_until)
	};
	return {
		id: row.id,
		kind: row.kind ?? "assessment",
		requestedAt: new Date(row.requested_at),
		actor: row.actor,
		trigger: row.trigger,
		...row.idempotency_key != null ? { idempotencyKey: row.idempotency_key } : {},
		request: row.request,
		state: row.state,
		attempts: Number(row.attempts),
		...lease != null ? { lease } : {},
		...row.cancel_requested_at != null ? { cancelRequestedAt: new Date(row.cancel_requested_at) } : {},
		...row.scan_id != null ? { scanId: row.scan_id } : {},
		...row.advisory_id != null ? { advisoryId: row.advisory_id } : {},
		...row.finished_at != null ? { finishedAt: new Date(row.finished_at) } : {},
		...row.why != null ? { why: row.why } : {}
	};
}
function reviveAttempt(row) {
	return {
		id: row.id,
		runId: row.run_id,
		number: Number(row.number),
		holder: row.holder,
		startedAt: new Date(row.started_at),
		heartbeatAt: new Date(row.heartbeat_at),
		...row.ended_at != null ? { endedAt: new Date(row.ended_at) } : {},
		...row.outcome != null ? { outcome: row.outcome } : {}
	};
}
//#endregion
export { PostgresRunStore };
