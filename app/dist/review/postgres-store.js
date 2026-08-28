import { digestOf } from "../records/digest.js";
import { decodeScan } from "../scan/codec.js";
import { applyScope } from "../store/assessment-scope.js";
import { InvalidReviewError, assertReviewAccepts, complete, finalised, selectedPillarsOf } from "./review.js";
import { reviveFinalAssessment } from "./final-assessment.js";
import { reviveStoredAttestation } from "../attest/postgres-store.js";
//#region server/review/postgres-store.ts
const UNIQUE_VIOLATION = "23505";
var PostgresReviewStore = class {
	options;
	durable = true;
	constructor(options) {
		this.options = options;
	}
	async open(review) {
		selectedPillarsOf(review, this.options.pillars);
		const { db } = this.options;
		await db.query(`insert into ${db.schema}.assessment_reviews
         (id, run_id, opened_at, body, digest, definition_id, definition_version, definition_fingerprint)
         values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
       on conflict (run_id) do nothing`, [
			review.id,
			review.runId,
			review.openedAt,
			JSON.stringify(review),
			digestOf(review),
			review.definitionId ?? null,
			review.definitionVersion ?? null,
			review.definitionFingerprint ?? null
		]);
		const existing = await this.forRun(review.runId);
		if (existing == null) throw new InvalidReviewError("The review was written and then could not be read back.");
		return existing.review;
	}
	async record(pillar) {
		if (this.options.projector != null) return this.recordProjected(pillar);
		const assembled = await this.get(pillar.reviewId);
		if (assembled == null) throw new InvalidReviewError("There is no review with that id, so there is nowhere to record a pillar against.");
		if (assembled.result != null) throw new InvalidReviewError("This review already has a result, so another pillar record would not be part of it.");
		assertReviewAccepts(assembled.review, pillar.pillarId, this.options.pillars);
		const { db } = this.options;
		try {
			await db.query(`insert into ${db.schema}.pillar_reviews (id, review_id, pillar_id, recorded_at, body, digest)
           values ($1, $2, $3, $4, $5::jsonb, $6)`, [
				pillar.id,
				pillar.reviewId,
				pillar.pillarId,
				pillar.at,
				JSON.stringify(pillar),
				digestOf(pillar)
			]);
		} catch (error) {
			if (isDuplicate(error)) return this.finaliseIfComplete(assembled.review, pillar, { duplicate: true });
			throw error;
		}
		return this.finaliseIfComplete(assembled.review, pillar);
	}
	/**
	* Complete a Version 2 result while holding the review row lock.
	*
	* The lock serialises requests that can both believe they carry the last pillar. The transaction
	* then makes the terminal pillar, immutable source reads and result insert one commit point: a
	* missing, expired or digest-mismatched source rolls the pillar back as well.
	*/
	async recordProjected(pillar) {
		const { db, projector } = this.options;
		const session = db.session?.bind(db);
		if (session == null || projector == null) throw new InvalidReviewError("Final assessment projection requires a database transaction, and this database binding does not provide one.");
		return session(async (sql) => {
			const { rows: reviewRows } = await sql.query(`select body from ${db.schema}.assessment_reviews where id = $1 for update`, [pillar.reviewId]);
			const review = reviveReview(reviewRows[0]?.body);
			if (review == null) throw new InvalidReviewError("There is no review with that id, so there is nowhere to record a pillar against.");
			const selected = assertReviewAccepts(review, pillar.pillarId, this.options.pillars);
			const existing = await this.resultOfReviewUsing(sql, review.id);
			if (existing != null) return {
				review,
				result: existing
			};
			if ((await this.pillarsOfUsing(sql, review.id)).some((one) => one.pillarId === pillar.pillarId)) throw new InvalidReviewError(`This review already has a record for ${pillar.pillarId}. A confirm or a skip is written once.`);
			await sql.query(`insert into ${db.schema}.pillar_reviews (id, review_id, pillar_id, recorded_at, body, digest)
           values ($1, $2, $3, $4, $5::jsonb, $6)`, [
				pillar.id,
				pillar.reviewId,
				pillar.pillarId,
				pillar.at,
				JSON.stringify(pillar),
				digestOf(pillar)
			]);
			const next = await this.pillarsOfUsing(sql, review.id);
			if (!complete(selected, next)) return { review };
			const completing = next.reduce((latest, one) => one.at.getTime() > latest.at.getTime() ? one : latest);
			const base = finalised({
				id: (this.options.newId ?? (() => crypto.randomUUID()))(),
				review,
				pillars: next,
				finalisedBy: completing.by,
				finalisedAt: completing.at
			}, selected);
			const { rows: scanRows } = await sql.query(`select id, body, digest from ${db.schema}.scans where id = $1`, [review.runId]);
			const storedScan = scanRows[0];
			if (storedScan == null) throw new InvalidReviewError("The run this review is of could not be read for finalisation.");
			if (digestOf(storedScan.body) !== storedScan.digest) throw new InvalidReviewError("The stored run body no longer matches its recorded digest.");
			const scan = decodeScan(storedScan.id, JSON.stringify(storedScan.body));
			const answers = await this.answersOfUsing(sql, review.id);
			const attestations = await this.attestationsUsing(sql, base.attestationIds);
			const result = projector({
				result: base,
				scan,
				runDigest: storedScan.digest,
				answers,
				attestations
			});
			const contract = result.finalAssessment;
			await sql.query(`insert into ${db.schema}.assessment_results
           (id, review_id, run_id, finalised_at, body, digest, definition_id, definition_version,
            definition_fingerprint, schema_version, public_methodology_version, catalogue_revision, eligible)
           values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13)
         on conflict (review_id) do nothing`, [
				result.id,
				result.reviewId,
				result.runId,
				result.finalisedAt,
				JSON.stringify(result),
				digestOf(result),
				result.definitionId ?? null,
				result.definitionVersion ?? null,
				result.definitionFingerprint ?? null,
				result.schemaVersion,
				contract.versions.methodology.publicVersion,
				contract.versions.catalogue.revision,
				contract.publication.eligible
			]);
			const stored = await this.resultOfReviewUsing(sql, review.id);
			if (stored == null) throw new InvalidReviewError("The final assessment was written and then could not be read back.");
			return {
				review,
				result: stored
			};
		}).catch((error) => {
			this.options.onError?.(`record projected pillar ${pillar.pillarId} of review ${pillar.reviewId}`, error);
			throw error;
		});
	}
	async answer(one) {
		const assembled = await this.get(one.reviewId);
		if (assembled == null) throw new InvalidReviewError("There is no review with that id, so there is nowhere to record an answer against.");
		if (assembled.result != null) throw new InvalidReviewError("This review already has a result, so an answer recorded now would not be part of it.");
		assertReviewAccepts(assembled.review, one.pillarId, this.options.pillars);
		if (assembled.pillars.some((pillar) => pillar.pillarId === one.pillarId)) throw new InvalidReviewError(`This review has already recorded ${one.pillarId}, so an answer to it now is not one this review acted on.`);
		const { db } = this.options;
		await db.query(`insert into ${db.schema}.review_answers
         (id, review_id, pillar_id, attestation_id, recorded_at, body, digest)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7)
       on conflict (attestation_id) do nothing`, [
			one.id,
			one.reviewId,
			one.pillarId,
			one.attestationId,
			one.at,
			JSON.stringify(one),
			digestOf(one)
		]);
	}
	async get(id, scope) {
		const scoped = applyScope("where id = $1", [id], scope);
		return this.load(`read review ${id}`, scoped.fragment, scoped.values);
	}
	async forRun(runId, scope) {
		const scoped = applyScope("where run_id = $1", [runId], scope);
		return this.load(`read review of scan ${runId}`, scoped.fragment, scoped.values);
	}
	async openReviews(scope) {
		const { db } = this.options;
		const operation = "read open reviews";
		try {
			const scoped = applyScope("order by opened_at asc", [], scope);
			const { rows } = await db.query(`select body from ${db.schema}.assessment_reviews ${scoped.fragment}`, scoped.values);
			const { rows: done } = await db.query(`select review_id from ${db.schema}.assessment_results`);
			const finished = new Set(done.map((row) => row.review_id));
			const reviews = this.revivedReviews(rows.map((row) => row.body), operation).filter((one) => !finished.has(one.id));
			const assembled = [];
			for (const review of reviews) {
				const pillars = await this.pillarsOf(review.id);
				const answers = await this.answersOf(review.id);
				assembled.push({
					review,
					pillars,
					answers
				});
			}
			return assembled;
		} catch (error) {
			this.options.onError?.(operation, error);
			return [];
		}
	}
	async current(scope) {
		const scoped = applyScope("order by finalised_at desc", [], scope);
		return (await this.readResults("read current result", `${scoped.fragment} limit 1`, scoped.values))[0];
	}
	async result(id, scope) {
		const scoped = applyScope("where id = $1", [id], scope);
		return (await this.readResults(`read result ${id}`, scoped.fragment, scoped.values))[0];
	}
	/**
	* Writes the result when every named pillar has a record.
	*
	* `duplicate` is the recovery for a last-pillar write that stored the pillar and not the result:
	* the retry is refused as a duplicate unless the set is already complete, in which case this
	* writes the missing row rather than leaving a review `openReviews` still lists.
	*/
	async finaliseIfComplete(review, pillar, from = {}) {
		const next = await this.pillarsOf(review.id);
		const selected = assertReviewAccepts(review, pillar.pillarId, this.options.pillars);
		if (!complete(selected, next)) {
			if (from.duplicate === true) throw new InvalidReviewError(`This review already has a record for ${pillar.pillarId}. A confirm or a skip is written once.`);
			return { review };
		}
		const existing = await this.resultOfReview(review.id);
		if (existing != null) {
			if (from.duplicate === true) throw new InvalidReviewError("This review already has a result, so another pillar record would not be part of it.");
			return {
				review,
				result: existing
			};
		}
		const completing = from.duplicate === true ? next.reduce((latest, one) => one.at.getTime() > latest.at.getTime() ? one : latest) : pillar;
		const result = finalised({
			id: (this.options.newId ?? (() => crypto.randomUUID()))(),
			review,
			pillars: next,
			finalisedBy: completing.by,
			finalisedAt: completing.at
		}, selected);
		const { db } = this.options;
		try {
			await db.query(`insert into ${db.schema}.assessment_results
           (id, review_id, run_id, finalised_at, body, digest, definition_id, definition_version, definition_fingerprint)
           values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
         on conflict (review_id) do nothing`, [
				result.id,
				result.reviewId,
				result.runId,
				result.finalisedAt,
				JSON.stringify(result),
				digestOf(result),
				result.definitionId ?? null,
				result.definitionVersion ?? null,
				result.definitionFingerprint ?? null
			]);
		} catch (error) {
			this.options.onError?.("write result", error);
			throw error;
		}
		return {
			review,
			result: await this.resultOfReview(review.id) ?? result
		};
	}
	async resultOfReview(reviewId) {
		try {
			return await this.resultOfReviewUsing(this.options.db, reviewId);
		} catch (error) {
			this.options.onError?.(`read result of review ${reviewId}`, error);
			return;
		}
	}
	async load(operation, where, values) {
		const review = (await this.readReviews(operation, where, values))[0];
		if (review == null) return void 0;
		const pillars = await this.pillarsOf(review.id);
		const answers = await this.answersOf(review.id);
		const result = await this.resultOfReview(review.id);
		return {
			review,
			pillars,
			answers,
			...result != null ? { result } : {}
		};
	}
	async answersOf(reviewId) {
		const operation = `read answers recorded in ${reviewId}`;
		try {
			return await this.answersOfUsing(this.options.db, reviewId);
		} catch (error) {
			this.options.onError?.(operation, error);
			return [];
		}
	}
	async pillarsOf(reviewId) {
		const operation = `read pillar records of ${reviewId}`;
		try {
			return await this.pillarsOfUsing(this.options.db, reviewId);
		} catch (error) {
			this.options.onError?.(operation, error);
			return [];
		}
	}
	async resultOfReviewUsing(sql, reviewId) {
		const { db } = this.options;
		const { rows } = await sql.query(`select body from ${db.schema}.assessment_results where review_id = $1`, [reviewId]);
		if (rows[0] == null) return void 0;
		const result = reviveResult(rows[0].body);
		if (result == null) throw new InvalidReviewError("The stored final assessment could not be read.");
		return result;
	}
	async answersOfUsing(sql, reviewId) {
		const { db } = this.options;
		const { rows } = await sql.query(`select body from ${db.schema}.review_answers where review_id = $1 order by recorded_at asc`, [reviewId]);
		const answers = rows.map((row) => reviveAnswer(row.body));
		if (answers.some((one) => one == null)) throw new InvalidReviewError("A stored answer record in this review could not be read.");
		return answers;
	}
	async pillarsOfUsing(sql, reviewId) {
		const { db } = this.options;
		const { rows } = await sql.query(`select body from ${db.schema}.pillar_reviews where review_id = $1 order by recorded_at asc`, [reviewId]);
		const pillars = rows.map((row) => revivePillar(row.body));
		if (pillars.some((one) => one == null)) throw new InvalidReviewError("A stored pillar record in this review could not be read.");
		return pillars;
	}
	async attestationsUsing(sql, ids) {
		if (ids.length === 0) return [];
		const { db } = this.options;
		const { rows } = await sql.query(`select id, body, digest from ${db.schema}.attestations where id = any($1::text[])`, [ids]);
		const byId = /* @__PURE__ */ new Map();
		for (const row of rows) {
			if (digestOf(row.body) !== row.digest) throw new InvalidReviewError(`Attestation ${row.id} no longer matches its recorded digest.`);
			const attestation = reviveStoredAttestation(row.body);
			if (attestation == null || attestation.id !== row.id) throw new InvalidReviewError(`Attestation ${row.id} could not be read exactly by id.`);
			byId.set(row.id, attestation);
		}
		if (byId.size !== ids.length || ids.some((id) => !byId.has(id))) throw new InvalidReviewError("An attestation cited by this review could not be read for finalisation.");
		return ids.map((id) => byId.get(id));
	}
	async readReviews(operation, where, values) {
		const { db } = this.options;
		try {
			const { rows } = await db.query(`select body from ${db.schema}.assessment_reviews ${where}`, values);
			return this.revivedReviews(rows.map((row) => row.body), operation);
		} catch (error) {
			this.options.onError?.(operation, error);
			return [];
		}
	}
	async readResults(operation, where, values) {
		const { db } = this.options;
		try {
			const { rows } = await db.query(`select body from ${db.schema}.assessment_results ${where}`, values);
			return this.revivedResults(rows.map((row) => row.body), operation);
		} catch (error) {
			this.options.onError?.(operation, error);
			return [];
		}
	}
	revivedReviews(rows, operation) {
		return this.kept(rows.map(reviveReview), operation, "review");
	}
	revivedResults(rows, operation) {
		return this.kept(rows.map(reviveResult), operation, "result");
	}
	kept(rows, operation, kind) {
		const unreadable = rows.filter((one) => one == null).length;
		if (unreadable > 0) this.options.onError?.(operation, /* @__PURE__ */ new Error(`${String(unreadable)} stored ${kind} row(s) could not be read`));
		return rows.filter((one) => one != null);
	}
};
function isDuplicate(error) {
	return typeof error === "object" && error != null && error.code === UNIQUE_VIOLATION;
}
function reviveReview(raw) {
	if (raw == null || typeof raw !== "object") return void 0;
	const candidate = raw;
	if (typeof candidate.id !== "string" || typeof candidate.runId !== "string") return void 0;
	if (typeof candidate.openedBy !== "string") return void 0;
	if (candidate.selectedPillars != null && (!Array.isArray(candidate.selectedPillars) || candidate.selectedPillars.some((one) => typeof one !== "string"))) return void 0;
	const openedAt = new Date(candidate.openedAt);
	if (Number.isNaN(openedAt.getTime())) return void 0;
	return {
		...candidate,
		openedAt
	};
}
function revivePillar(raw) {
	if (raw == null || typeof raw !== "object") return void 0;
	const candidate = raw;
	if (typeof candidate.id !== "string" || typeof candidate.reviewId !== "string") return void 0;
	if (typeof candidate.runId !== "string" || typeof candidate.pillarId !== "string") return void 0;
	if (candidate.kind !== "confirmed" && candidate.kind !== "skipped") return void 0;
	if (typeof candidate.by !== "string") return void 0;
	const at = new Date(candidate.at);
	if (Number.isNaN(at.getTime())) return void 0;
	return {
		...candidate,
		at
	};
}
function reviveAnswer(raw) {
	if (raw == null || typeof raw !== "object") return void 0;
	const candidate = raw;
	if (typeof candidate.id !== "string" || typeof candidate.reviewId !== "string") return void 0;
	if (typeof candidate.runId !== "string" || typeof candidate.pillarId !== "string") return void 0;
	if (typeof candidate.controlId !== "string" || typeof candidate.attestationId !== "string") return void 0;
	if (typeof candidate.by !== "string") return void 0;
	const at = new Date(candidate.at);
	if (Number.isNaN(at.getTime())) return void 0;
	return {
		...candidate,
		at
	};
}
function reviveResult(raw) {
	if (raw == null || typeof raw !== "object") return void 0;
	const candidate = raw;
	if (typeof candidate.id !== "string" || typeof candidate.reviewId !== "string") return void 0;
	if (typeof candidate.runId !== "string" || typeof candidate.finalisedBy !== "string") return void 0;
	if (!Array.isArray(candidate.pillars) || !Array.isArray(candidate.attestationIds)) return void 0;
	if (candidate.selectedPillars != null && (!Array.isArray(candidate.selectedPillars) || candidate.selectedPillars.some((one) => typeof one !== "string"))) return void 0;
	const finalisedAt = new Date(candidate.finalisedAt);
	if (Number.isNaN(finalisedAt.getTime())) return void 0;
	const pillars = candidate.pillars.map(revivePillar);
	if (pillars.some((one) => one == null)) return void 0;
	try {
		return reviveFinalAssessment({
			...candidate,
			finalisedAt,
			pillars
		});
	} catch {
		return;
	}
}
//#endregion
export { PostgresReviewStore };
