import { digestOf } from "../records/digest.js";
import { encodeScan } from "../scan/codec.js";
import { inScope } from "../store/assessment-scope.js";
import { InvalidReviewError, assertReviewAccepts, complete, finalised, selectedPillarsOf } from "./review.js";
//#region server/review/store.ts
var InMemoryReviewStore = class {
	durable = false;
	reviews = /* @__PURE__ */ new Map();
	byRun = /* @__PURE__ */ new Map();
	pillars = /* @__PURE__ */ new Map();
	answers = /* @__PURE__ */ new Map();
	results = /* @__PURE__ */ new Map();
	resultByReview = /* @__PURE__ */ new Map();
	known;
	projection;
	constructor(options) {
		this.known = options.pillars;
		this.projection = options.projection;
	}
	open(review) {
		selectedPillarsOf(review, this.known);
		const existingId = this.byRun.get(review.runId);
		if (existingId != null) {
			const existing = this.reviews.get(existingId);
			if (existing != null) return Promise.resolve(existing);
		}
		this.reviews.set(review.id, review);
		this.byRun.set(review.runId, review.id);
		this.pillars.set(review.id, []);
		this.answers.set(review.id, []);
		return Promise.resolve(review);
	}
	answer(one) {
		const refused = this.refusalToAnswer(one);
		if (refused != null) return Promise.reject(new InvalidReviewError(refused));
		const held = this.answers.get(one.reviewId) ?? [];
		if (held.some((was) => was.attestationId === one.attestationId)) return Promise.resolve();
		this.answers.set(one.reviewId, [...held, one]);
		return Promise.resolve();
	}
	/** The three reasons an answer has nowhere to go, in the order the caller would hit them. */
	refusalToAnswer(one) {
		const review = this.reviews.get(one.reviewId);
		if (review == null) return "There is no review with that id, so there is nowhere to record an answer against.";
		if (this.resultByReview.has(review.id)) return "This review already has a result, so an answer recorded now would not be part of it.";
		try {
			assertReviewAccepts(review, one.pillarId, this.known);
		} catch (cause) {
			return cause instanceof InvalidReviewError ? cause.message : "This review cannot accept that answer.";
		}
		if ((this.pillars.get(review.id) ?? []).some((pillar) => pillar.pillarId === one.pillarId)) return `This review has already recorded ${one.pillarId}, so an answer to it now is not one this review acted on.`;
		return null;
	}
	async record(pillar) {
		const review = this.reviews.get(pillar.reviewId);
		if (review == null) throw new InvalidReviewError("There is no review with that id, so there is nowhere to record a pillar against.");
		if (this.resultByReview.has(review.id)) throw new InvalidReviewError("This review already has a result, so another pillar record would not be part of it.");
		const selected = assertReviewAccepts(review, pillar.pillarId, this.known);
		const recorded = this.pillars.get(review.id) ?? [];
		if (recorded.some((one) => one.pillarId === pillar.pillarId)) throw new InvalidReviewError(`This review already has a record for ${pillar.pillarId}. A confirm or a skip is written once.`);
		const next = [...recorded, pillar];
		if (!complete(selected, next)) {
			this.pillars.set(review.id, next);
			return { review };
		}
		const base = finalised({
			id: `result-${review.id}`,
			review,
			pillars: next,
			finalisedBy: pillar.by,
			finalisedAt: pillar.at
		}, selected);
		let result = base;
		const projection = this.projection;
		if (projection != null) {
			const scan = await projection.scan(review.runId);
			if (scan == null) throw new InvalidReviewError("The run this review is of could not be read for finalisation.");
			const attestations = await Promise.all(base.attestationIds.map((id) => projection.attestation(id, review.definitionId)));
			if (attestations.some((one) => one == null)) throw new InvalidReviewError("An attestation cited by this review could not be read for finalisation.");
			const encoded = JSON.parse(encodeScan(scan));
			result = projection.project({
				result: base,
				scan,
				runDigest: digestOf(encoded),
				answers: this.answers.get(review.id) ?? [],
				attestations
			});
		}
		this.pillars.set(review.id, next);
		this.results.set(result.id, result);
		this.resultByReview.set(review.id, result.id);
		return {
			review,
			result
		};
	}
	get(id, scope) {
		return Promise.resolve(this.assemble(this.reviews.get(id), scope));
	}
	forRun(runId, scope) {
		const id = this.byRun.get(runId);
		if (id == null) return Promise.resolve(void 0);
		return this.get(id, scope);
	}
	openReviews(scope) {
		const open = [];
		for (const review of this.reviews.values()) {
			if (this.resultByReview.has(review.id)) continue;
			const assembled = this.assemble(review, scope);
			if (assembled != null) open.push(assembled);
		}
		open.sort((left, right) => left.review.openedAt.getTime() - right.review.openedAt.getTime());
		return Promise.resolve(open);
	}
	current(scope) {
		const mine = [...this.results.values()].filter((one) => inScope(one.definitionId, scope)).sort((left, right) => right.finalisedAt.getTime() - left.finalisedAt.getTime());
		return Promise.resolve(mine[0]);
	}
	result(id, scope) {
		const one = this.results.get(id);
		if (one == null || !inScope(one.definitionId, scope)) return Promise.resolve(void 0);
		return Promise.resolve(one);
	}
	assemble(review, scope) {
		if (review == null || !inScope(review.definitionId, scope)) return void 0;
		const resultId = this.resultByReview.get(review.id);
		return {
			review,
			pillars: this.pillars.get(review.id) ?? [],
			answers: this.answers.get(review.id) ?? [],
			...resultId != null ? { result: this.results.get(resultId) } : {}
		};
	}
};
//#endregion
export { InMemoryReviewStore };
