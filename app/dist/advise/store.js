import { applyScope } from "../store/assessment-scope.js";
//#region server/advise/store.ts
var PostgresAdvisoryStore = class {
	db;
	durable = true;
	constructor(db) {
		this.db = db;
	}
	async save(advisory) {
		await this.db.query(`insert into ${this.db.schema}.advisories
         (id, run_id, started_at, finished_at, state, scope, lookback_days, definition_id, considered, body)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
         on conflict (id) do nothing`, [
			advisory.id,
			advisory.runId,
			advisory.startedAt,
			advisory.finishedAt,
			advisory.state,
			advisory.scope.description,
			advisory.lookbackDays,
			advisory.definition?.id ?? null,
			considered(advisory),
			JSON.stringify(encode(advisory))
		]);
	}
	async get(id, scope) {
		const scoped = applyScope("where id = $1", [id], scope);
		const { rows } = await this.db.query(`select ${COLUMNS} from ${this.db.schema}.advisories ${scoped.fragment}`, scoped.values);
		return rows[0] == null ? void 0 : decode(rows[0]);
	}
	async latest(scope) {
		const scoped = applyScope("order by finished_at desc limit 1", [], scope);
		const { rows } = await this.db.query(`select ${COLUMNS} from ${this.db.schema}.advisories ${scoped.fragment}`, scoped.values);
		return rows[0] == null ? void 0 : decode(rows[0]);
	}
	async forRun(runId, scope) {
		const scoped = applyScope("where run_id = $1", [runId], scope);
		const { rows } = await this.db.query(`select ${COLUMNS} from ${this.db.schema}.advisories ${scoped.fragment}`, scoped.values);
		return rows[0] == null ? void 0 : decode(rows[0]);
	}
	async history(limit = 20, scope) {
		const scoped = applyScope("order by finished_at desc", [], scope);
		const { rows } = await this.db.query(`select ${SUMMARY_COLUMNS} from ${this.db.schema}.advisories ${scoped.fragment} limit $${String(scoped.values.length + 1)}`, [...scoped.values, limit]);
		return rows.map((row) => ({
			id: row.id,
			runId: row.run_id,
			finishedAt: new Date(row.finished_at),
			state: row.state,
			scope: row.scope,
			lookbackDays: Number(row.lookback_days),
			...row.definition_id != null ? { definitionId: row.definition_id } : {},
			considered: Number(row.considered)
		}));
	}
};
const COLUMNS = "id, run_id, started_at, finished_at, state, scope, lookback_days, definition_id, considered, body";
/** The same list without the two columns a history line does not show. */
const SUMMARY_COLUMNS = "id, run_id, finished_at, state, scope, lookback_days, definition_id, considered";
/**
* How many things the run's analyses had an opinion about.
*
* A column rather than a read of the body, because it is the one number a history row shows and counting
* it by parsing every stored analysis would read the whole table to draw a list.
*
* Jobs plus query shapes, which is a sum of two unlike things and is the right one anyway: the number
* exists so a reader scanning history can tell a run that found plenty from a run that found nothing, and
* splitting it into two columns would make that judgement require arithmetic. `considered` counts the
* shapes the statement returned rather than the twelve shown, so a run is not credited with less than it
* looked at.
*/
function considered(advisory) {
	return (advisory.serverless?.jobs.length ?? 0) + (advisory.workload?.considered ?? 0);
}
/**
* The parts of an advisory that go in the JSON body.
*
* Everything that is also a column is left out, so the two cannot disagree about the same fact. The
* dates are the exception and are excluded for the same reason: a date in JSON is a string that has to
* be revived, and having one authority for it is what stops a body and a column drifting by a timezone.
*
* Every analysis has to be listed here, and forgetting one is silent in exactly the way that ships: the
* run that produced the advisory holds it in memory and hands it straight back, so the page works for
* whoever pressed the button and is empty for everybody else, on every reload, and after every scheduled
* run. The warehouse sizing analysis was missing from this object for one deployment and presented as a
* permissions problem. `writes down every part of an advisory` in `store.test.ts` is what stops the next
* one, for every field its fixture sets — so a new analysis goes in that fixture too.
*/
function encode(advisory) {
	return {
		scope: advisory.scope,
		stamp: advisory.stamp,
		readings: advisory.readings,
		...advisory.incompleteReason != null ? { incompleteReason: advisory.incompleteReason } : {},
		...advisory.definition != null ? { definition: advisory.definition } : {},
		...advisory.serverless != null ? { serverless: advisory.serverless } : {},
		...advisory.workload != null ? { workload: advisory.workload } : {},
		...advisory.sizing != null ? { sizing: advisory.sizing } : {},
		...advisory.writes != null ? { writes: advisory.writes } : {},
		...advisory.jobs != null ? { jobs: advisory.jobs } : {},
		...advisory.plans != null ? { plans: advisory.plans } : {},
		...advisory.planCapability != null ? { planCapability: advisory.planCapability } : {},
		...advisory.retainedPlans != null ? { retainedPlans: advisory.retainedPlans } : {}
	};
}
function decode(row) {
	const body = row.body;
	return {
		...body,
		id: row.id,
		runId: row.run_id,
		startedAt: new Date(row.started_at),
		finishedAt: new Date(row.finished_at),
		state: row.state,
		lookbackDays: Number(row.lookback_days),
		readings: body.readings.map((reading) => ({
			...reading,
			collectedAt: new Date(reading.collectedAt)
		})),
		...body.workload != null ? { workload: revive(body.workload) } : {},
		...body.jobs != null ? { jobs: reviveJobs(body.jobs) } : {},
		...body.writes != null ? { writes: reviveWrites(body.writes) } : {}
	};
}
/**
* The write analysis with its three dates per shape turned back into dates.
*
* Same defect as `revive` and `reviveJobs` were written for, three times over on one row: a surface
* formatting `firstSeen`, `lastSeen` or `representativeAt` prints an ISO string, and only on a record that
* has been through the database — never on the one the run that produced it holds in memory.
*/
function reviveWrites(writes) {
	return {
		...writes,
		shapes: writes.shapes.map((shape) => ({
			...shape,
			pattern: {
				...shape.pattern,
				...shape.pattern.firstSeen != null ? { firstSeen: new Date(shape.pattern.firstSeen) } : {},
				...shape.pattern.lastSeen != null ? { lastSeen: new Date(shape.pattern.lastSeen) } : {},
				...shape.pattern.representativeAt != null ? { representativeAt: new Date(shape.pattern.representativeAt) } : {}
			}
		}))
	};
}
/**
* The job analysis with its one date per job turned back into a date.
*
* `lastRun` is a `Date` on the type and a string through jsonb, and the same defect `revive` was written for
* applies here: a surface formatting it prints an ISO string, and only on a record that has been through the
* database — never on the one the run that produced it hands back.
*/
function reviveJobs(jobs) {
	return {
		...jobs,
		jobs: jobs.jobs.map((job) => job.health.lastRun == null ? job : {
			...job,
			health: {
				...job.health,
				lastRun: new Date(job.health.lastRun)
			}
		})
	};
}
/**
* The workload analysis with its one date turned back into a date.
*
* `representativeAt` is a `Date` on the type and a string through jsonb. Without this the surface prints
* an ISO string where every other date on the page is formatted, which is the kind of defect that ships
* because it only appears on a record that has been through the database — never on the one the run that
* produced it holds in memory.
*/
function revive(workload) {
	const shapes = (given) => given.map((shape) => shape.row.representativeAt == null ? shape : {
		...shape,
		row: {
			...shape.row,
			representativeAt: new Date(shape.row.representativeAt)
		}
	});
	return {
		...workload,
		top: shapes(workload.top),
		failing: shapes(workload.failing)
	};
}
//#endregion
export { PostgresAdvisoryStore };
