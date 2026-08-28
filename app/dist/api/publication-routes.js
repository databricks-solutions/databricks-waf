import { fromBytes } from "../records/digest.js";
import { assessmentOf } from "./assessment-query.js";
import { eligible, ineligible } from "../shared/api/eligibility.js";
import { finalisationOf } from "../review/finalisation.js";
import { inPublishedOrder, monthLabel, monthOpensOn, parseMonth, supersededBy, unsuperseded } from "../monthly/publication.js";
import { closingScan, monthContent, scoreText } from "../monthly/content.js";
import { currentMonthIn, monthHasClosed } from "../monthly/closed.js";
import { noSelectedRun, selectedRun, selectedRunReference } from "../monthly/publication-language.js";
import { monthCsv, monthDocument, monthJson } from "../monthly/document.js";
import { PublicationRaceError } from "../monthly/store.js";
import { monthWindow } from "../monthly/window.js";
//#region server/api/publication-routes.ts
/**
* How many recent records the assembler reads to window a month.
*
* A month of the operating cadence holds a handful of scans and runs, so a thousand reaches back far
* enough to find both a month's own records and the reading it opened at — the last scan *before* the
* window — without asking a store for its whole history. A window that could not see the prior scan
* would report a month's first movement as no movement, which is a wrong figure rather than a missing
* one, so the bound is generous on the side that keeps the opening reading in view.
*/
const SOURCE_LIMIT = 1e3;
/** The shortest reason a correction may carry. Long enough to be a sentence, short enough not to nag. */
const MIN_REASON = 12;
const NO_PUBLICATIONS = "This install keeps nothing that survives a restart, so a published month — which is a record that has to still be here months later to be worth anything — cannot be kept. Bind a Lakebase instance and the monthly cadence can be published from that point.";
function monthTarget(month) {
	return {
		kind: "month",
		id: month
	};
}
function inWindow(at, start, end) {
	const t = at.getTime();
	return t >= start.getTime() && t < end.getTime();
}
/**
* A published entry's standing: its position from the order, its supersession from the record.
*
* The two come from different places on purpose. Position is a reading of the order and says nothing
* about what replaced what; supersession is a fact one publication states about another, and only the
* publication that states it can supply it.
*/
function publishedOf(publication, index, ordered) {
	const successor = supersededBy(publication, ordered);
	return {
		id: publication.id,
		ordinal: index + 1,
		total: ordered.length,
		current: successor == null,
		publishedAt: publication.publishedAt.toISOString(),
		publishedBy: publication.publishedBy,
		documentVersion: publication.documentVersion,
		digest: publication.digest,
		...publication.supersedes != null ? { supersedes: publication.supersedes } : {},
		...publication.reason != null ? { reason: publication.reason } : {},
		...successor != null ? { supersededAt: successor.publishedAt.toISOString() } : {}
	};
}
/**
* Whether this install has somewhere to keep a publication that will still be there to be read.
*
* A store that is present and says it keeps nothing durable is the same answer as no store at all, and it
* has to be, because the write path's refusal and the read path's `durable` are the same claim: a digest
* handed to a recipient for bytes the next deploy erases is worse than no publish path. The wiring gives
* an in-memory install no store, so this narrows a type more often than it refuses a request — and a
* `durable` copied from the wiring rather than read from the store is a claim nothing keeps true.
*/
function keeps(store) {
	return store != null && store.durable;
}
/**
* Why a month cannot be published yet, naming the zone its dates were read on and where that came from.
*
* The zone is named because the answer depends on it — a month closes on this zone's wall clock, so a
* reader who disagrees needs to see which one was used. Where nothing supplied it, the sentence says so
* rather than calling this app's default the workspace's: an install with no schedule deployed has no
* zone to have configured. What the sentence no longer says is anything about a cadence. It used to read
* "its cadence is still accumulating runs", which claims a schedule exists, claims what it will do, and
* is written twenty lines from the code that defaults the zone because none does.
*/
function notClosed(month, zone) {
	const where = zone.source === "schedule" ? `${zone.id}, the timezone the deployed schedule carries` : `${zone.id}, which is this app's default because no deployed schedule supplied one`;
	return `${monthLabel(month)} has not ended yet in ${where}. A month is publishable only once it has closed, so that what it reports cannot change after it is frozen.`;
}
/**
* Why a month whose closing run nobody has finished reviewing cannot be published yet.
*
* A publication is frozen and travels, and the score in it is the automated half of an assessment
* this product says a person completes. Freezing that half and sending it out as the month's report
* is the gap `GAP-033` names: the recipient cannot tell a reviewed score from an unreviewed one, and
* the record is permanent either way.
*
* The sentence says which run and how far the review got, because "finish the review" with three
* pillars done and four to go is an instruction the reader cannot act on without going to look.
*/
function notReviewed(month, finishedAt, recorded, expected, closed) {
	return `${selectedRun(monthLabel(month), runMoment(finishedAt), closed)}, whose review is not finished — ${String(recorded)} of ${String(expected)} pillars have a record. A published month is frozen, so it is published once somebody has confirmed or skipped every pillar of the run it reports.`;
}
/** Stable customer label for a run; its opaque id remains available as technical provenance. */
function runMoment(finishedAt) {
	return `${new Intl.DateTimeFormat("en-GB", {
		dateStyle: "medium",
		timeStyle: "short",
		timeZone: "UTC"
	}).format(finishedAt)} UTC`;
}
/**
* The score a frozen document records for its own month, or nothing where it records none.
*
* A document's trend carries its own month as the last point, and that point's score is the string the
* month is on record as. Read by month id rather than by position, and every step of the walk is checked:
* these are bytes from storage, written by a version of this app that may predate the field being read,
* so a shape that does not match is "no score on record" and not a failed publish.
*/
function ownPoint(json, month) {
	let document;
	try {
		document = JSON.parse(json);
	} catch {
		return;
	}
	if (typeof document !== "object" || document === null) return void 0;
	const { trend } = document;
	if (!Array.isArray(trend)) return void 0;
	for (const entry of trend) {
		if (typeof entry !== "object" || entry === null) continue;
		const point = entry;
		if (point.month === month && typeof point.score === "string") return point.score;
	}
}
function resultOf(publication) {
	return {
		id: publication.id,
		month: publication.month,
		publishedAt: publication.publishedAt.toISOString(),
		publishedBy: publication.publishedBy,
		documentVersion: publication.documentVersion,
		digest: publication.digest,
		...publication.supersedes != null ? { supersedes: publication.supersedes } : {}
	};
}
function registerPublicationRoutes(app, options) {
	const at = () => (options.now ?? (() => /* @__PURE__ */ new Date()))();
	const mintId = () => (options.newId ?? (() => crypto.randomUUID()))();
	/**
	* Everything the assembler needs for a month, read here so the pure function stays pure.
	*
	* The scans are split into the month's own — whose result landed in the window — and the reading it
	* opened at, which is the last scan *before* the window. Runs, risks and actions are handed whole
	* and windowed by the assembler against their own timestamps, so a source that over-reads is
	* corrected there rather than trusted here.
	*/
	async function assemble(month, window, timezone, scope, closed) {
		const summaries = await options.scans.history(SOURCE_LIMIT, scope);
		const scans = summaries.filter((scan) => inWindow(scan.finishedAt, window.start, window.end));
		const priorScan = summaries.find((scan) => scan.finishedAt.getTime() < window.start.getTime());
		const runs = await options.runs?.recent(SOURCE_LIMIT, scope) ?? [];
		const risks = await options.risks?.all(scope) ?? [];
		const improvements = options.improvements;
		const plans = await improvements?.plans(scope) ?? [];
		const actions = (improvements == null ? [] : await Promise.all(plans.map((plan) => improvements.actions(plan.id, scope)))).flat();
		const series = await priorSeries(month, timezone, summaries, scope);
		const closing = closingScan(summaries, window);
		const standing = await standingFor(closing, month, scope, closed);
		const finalisation = standing.finalisation;
		const unreviewed = closing == null || finalisation == null || finalisation.finalised ? void 0 : notReviewed(month, closing.finishedAt, finalisation.recorded, finalisation.expected, closed);
		const methodologyUnpublishable = closing == null ? void 0 : methodologyRefusal(month, closing, closed);
		const eligibility = !standing.eligibility.eligible ? standing.eligibility : methodologyUnpublishable == null ? eligible() : ineligible("incomplete", "methodology-not-released", methodologyUnpublishable, "Run the released Methodology Version 1 assessment, complete its review, and retry publication.");
		return {
			sources: {
				month,
				window,
				runs,
				scans,
				...priorScan != null ? { priorScan } : {},
				risks,
				actions,
				label: options.label,
				pillarTitle: (id) => options.reviews?.pillarTitle(id),
				...finalisation != null ? { finalisation } : {},
				...series.length > 0 ? { series } : {}
			},
			eligibility,
			...unreviewed != null ? { unreviewed } : {},
			...methodologyUnpublishable != null ? { methodologyUnpublishable } : {},
			...closing != null ? { closing } : {},
			...standing.reviewId != null ? { reviewId: standing.reviewId } : {}
		};
	}
	function methodologyRefusal(month, closing, closed) {
		const methodology = closing.stamp?.publicMethodology;
		if (methodology == null) return `${selectedRun(monthLabel(month), runMoment(closing.finishedAt), closed)}, which records no public methodology release. It is pre-release development evidence and cannot be published as Methodology Version 1.`;
		if (methodology.state !== "released") return `${selectedRun(monthLabel(month), runMoment(closing.finishedAt), closed)}, which records Methodology Version ${String(methodology.publicVersion)} as a release candidate. A customer publication requires a released methodology record.`;
	}
	/**
	* Where a run stands with its review. Every state the server cannot prove is explicitly ineligible:
	* unavailable capability, unknown record, unreadable store and incomplete review are different
	* operator problems, but none is permission to freeze a customer publication.
	*/
	async function standingFor(closing, month, scope, closed) {
		if (closing == null) return { eligibility: ineligible("unknown", "closing-run-unknown", noSelectedRun(monthLabel(month), closed), "Run an assessment in this month, complete its review, and retry publication.") };
		const reviews = options.reviews;
		if (reviews == null) return { eligibility: ineligible("unavailable", "reviews-unavailable", "Reviews are unavailable, so publication eligibility cannot be established.", "Bind the durable review database, restart the app, and retry publication.") };
		try {
			const record = await reviews.store.forRun(closing.id, scope);
			if (record == null) return { eligibility: ineligible("unknown", "review-unknown", `No review record could be found for ${selectedRunReference(runMoment(closing.finishedAt), closed)}.`, "Open and complete the review for this exact run, then retry publication.") };
			const finalisation = finalisationOf(record, reviews.pillars);
			if (finalisation == null || !finalisation.finalised || finalisation.resultId == null) {
				const progress = finalisation == null ? "Its review status is incomplete." : notReviewed(month, closing.finishedAt, finalisation.recorded, finalisation.expected, closed);
				return {
					reviewId: record.review.id,
					...finalisation != null ? { finalisation } : {},
					eligibility: ineligible("incomplete", "review-incomplete", progress, "Confirm or explicitly skip every selected pillar and ensure the report is published, then retry publication.")
				};
			}
			return {
				eligibility: eligible(),
				finalisation,
				reviewId: record.review.id
			};
		} catch {
			return { eligibility: ineligible("unreadable", "review-unreadable", `The review for ${selectedRunReference(runMoment(closing.finishedAt), closed)} could not be read, so publication eligibility is unknown.`, "Restore review-store reads and retry publication; do not publish from the preview.") };
		}
	}
	/**
	* The published months before this one, each resolved to its closing scan — the trend's stored base.
	*
	* The set is the published months (the "stored" part), read from the same store the write path
	* appends to. **A month's score is its own published document's**, not a fresh reading of the scan
	* that closed it: the month is on record as what it published, and scans are kept 730 days against
	* publications' 2555, so re-deriving it drew a month that *was* scored as one that was not once its
	* run aged out. The measurement basis still comes from the closing scan, because the document does
	* not carry a stamp — a month whose run has aged out is a point with a score and no basis, which the
	* assembler draws as one it cannot place, saying which of the two reasons applies.
	*
	* The current month is left out — the assembler takes its point from this run's own closing scan, so a
	* correction does not draw its own month twice.
	*
	* Strictly before, not merely other. Nothing requires months to be published in order — a month can
	* be published late, or a gap filled after the months around it — and a later month in this series is
	* frozen into the earlier month's record, where `monthTrend` appends the current month last and reads
	* the base as the final entry. `<` is chronological on `YYYY-MM`, which is what the sentence above
	* has always claimed and what the comparison now does.
	*/
	async function priorSeries(current, timezone, summaries, scope) {
		const store = options.publications;
		if (store == null) return [];
		const months = [...await store.months(scope)].filter((month) => month < current).sort();
		return Promise.all(months.map(async (month) => {
			const closing = closingScan(summaries, monthWindow(month, timezone));
			const score = await publishedScore(store, month, scope) ?? (closing?.overall != null ? scoreText(closing.overall) : void 0);
			return {
				month,
				...score != null ? { score } : {},
				...closing?.stamp != null ? { stamp: closing.stamp } : {},
				closingScan: closing == null ? "not-in-history" : "read"
			};
		}));
	}
	/**
	* The score a month published for itself, read out of its own frozen document.
	*
	* The standing copy, and the last of them where more than one stands — a month can hold two
	* publications neither of which superseded the other, and the last published is the one the read path
	* calls latest. Absent where the month's document carries no point for itself, which is a month
	* published with no scan closing it, and where the bytes cannot be read as a document at all: this is
	* a string from storage, so it is parsed defensively rather than trusted, and an unreadable one falls
	* back to the live scan rather than failing the publish.
	*/
	async function publishedScore(store, month, scope) {
		const ordered = inPublishedOrder(await store.ofMonth(month, scope));
		const standing = unsuperseded(ordered).at(-1) ?? ordered.at(-1);
		if (standing == null) return void 0;
		return ownPoint(standing.json, month);
	}
	/**
	* Builds the frozen bytes for an identity from freshly-read sources, and stores the record.
	*
	* `ordinal` is the position this publication claims in its month, and the store refuses a second claim
	* on it. Passed in rather than counted here, because the caller is the one that read the month and knows
	* what it is publishing against — a first publication claims 1, a correction claims the next after the
	* copy it supersedes.
	*
	* `sources` is passed in for the same reason: the caller assembled them to decide whether it was
	* allowed to publish at all, and re-reading here would freeze bytes nothing checked.
	*/
	async function freeze(store, identity, ordinal, scope, sources) {
		const document = monthDocument(identity, monthContent(sources));
		const json = monthJson(document);
		const publication = {
			...identity,
			ordinal,
			documentVersion: 1,
			json,
			csv: monthCsv(document),
			digest: fromBytes(Buffer.from(json, "utf8")),
			...scope != null ? { definitionId: scope } : {}
		};
		await store.publish(publication);
		return publication;
	}
	/** The months that have been published, newest first, each with its standing publication. */
	app.get("/api/months", async (request, response) => {
		try {
			const zone = await options.timezone();
			const currentMonth = currentMonthIn(zone.id, at());
			const store = options.publications;
			if (!keeps(store)) {
				const empty = {
					durable: false,
					currentMonth,
					zone: {
						id: zone.id,
						source: zone.source
					},
					months: []
				};
				response.json(empty);
				return;
			}
			const months = await store.months(assessmentOf(request));
			const rows = [];
			for (const month of months) {
				const ordered = inPublishedOrder([...await store.ofMonth(month, assessmentOf(request))]);
				const latest = ordered[ordered.length - 1];
				if (latest == null) continue;
				rows.push({
					month,
					label: monthLabel(month),
					publications: ordered.length,
					standing: unsuperseded(ordered).length,
					latest: {
						id: latest.id,
						publishedAt: latest.publishedAt.toISOString(),
						publishedBy: latest.publishedBy,
						digest: latest.digest
					}
				});
			}
			const payload = {
				durable: store.durable,
				currentMonth,
				zone: {
					id: zone.id,
					source: zone.source
				},
				months: rows
			};
			response.json(payload);
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	});
	/** One month's publications in order, so a reader sees the current one and what it superseded. */
	app.get("/api/months/:month", async (request, response) => {
		const month = parseMonth(request.params.month);
		if (month == null) {
			response.status(400).json({
				error: "bad-month",
				message: "A month is `YYYY-MM`, with the month in 01–12."
			});
			return;
		}
		const store = options.publications;
		if (!keeps(store)) {
			const empty = {
				month,
				label: monthLabel(month),
				durable: false,
				standing: [],
				publications: []
			};
			response.json(empty);
			return;
		}
		try {
			const ordered = inPublishedOrder([...await store.ofMonth(month, assessmentOf(request))]);
			const payload = {
				month,
				label: monthLabel(month),
				durable: store.durable,
				standing: unsuperseded(ordered).map((publication) => publication.id),
				publications: ordered.map((publication, index) => publishedOf(publication, index, ordered))
			};
			response.json(payload);
		} catch (cause) {
			publicationGateFailure(response, 503, ineligible("unreadable", "month-standing-unreadable", `The publication history for ${monthLabel(month)} could not be read.`, "Restore the publication-store connection and reload this month."));
		}
	});
	/**
	* The live reading of a month, assembled the same way a publish is and not stored.
	*
	* Readable whether or not the month has closed and whether or not this install can keep a
	* publication. Publish still refuses both; this is the preview the page shows with the action
	* disabled, not a way around those rules. No digest: nothing has been frozen.
	*/
	app.get("/api/months/:month/preview", async (request, response) => {
		const month = parseMonth(request.params.month);
		if (month == null) {
			response.status(400).json({
				error: "bad-month",
				message: "A month is `YYYY-MM`, with the month in 01–12."
			});
			return;
		}
		try {
			const zone = await options.timezone();
			const closed = monthHasClosed(month, zone.id, at());
			const { sources, eligibility, unreviewed, methodologyUnpublishable, closing, reviewId } = await assemble(month, monthWindow(month, zone.id), zone.id, assessmentOf(request), closed);
			const content = monthContent(sources);
			const preview = {
				month,
				label: monthLabel(month),
				durable: keeps(options.publications),
				closed,
				zone: {
					id: zone.id,
					source: zone.source
				},
				content,
				eligibility,
				...reviewId != null ? { reviewId } : {},
				...closing != null ? { closingRun: {
					id: closing.id,
					finishedAt: closing.finishedAt.toISOString()
				} } : {},
				...!closed ? {
					closedNote: notClosed(month, zone),
					availableFrom: monthOpensOn(month)
				} : {},
				...unreviewed != null ? { unreviewedNote: unreviewed } : {},
				...methodologyUnpublishable != null ? { methodologyNote: methodologyUnpublishable } : {}
			};
			response.json(preview);
		} catch (cause) {
			publicationGateFailure(response, 503, ineligible("unreadable", "month-preview-unreadable", `The inputs for ${monthLabel(month)} could not be read, so publication eligibility cannot be established.`, "Restore the failed store connection and reload this preview before publishing."));
		}
	});
	/**
	* The stored JSON bytes of one publication, verbatim, with their digest.
	*
	* A download rather than a page: the content type is explicit, the disposition is `attachment`, and
	* the `nosniff` header the API mounts covers it, because a published month carries names this app
	* did not choose — control titles, an owner's email — for the same reason the assessment export
	* does. The bytes are returned as stored, never rebuilt, which is the whole of "frozen".
	*/
	app.get("/api/months/:month/publications/:id.json", async (request, response) => {
		const store = options.publications;
		if (!keeps(store)) {
			response.status(404).json({
				error: "not-published",
				message: NO_PUBLICATIONS
			});
			return;
		}
		try {
			const publication = await store.byId(request.params.id, assessmentOf(request));
			if (publication == null || publication.month !== request.params.month) {
				response.status(404).json({
					error: "not-found",
					message: "There is no such publication of that month."
				});
				return;
			}
			response.setHeader("Content-Type", "application/json; charset=utf-8");
			response.setHeader("Content-Disposition", `attachment; filename="${publication.month}-${publication.id}.json"`);
			response.setHeader("X-Export-Digest", publication.digest);
			response.send(publication.json);
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	});
	/** The stored CSV bytes of one publication, verbatim, for a reader who works in a spreadsheet. */
	app.get("/api/months/:month/publications/:id.csv", async (request, response) => {
		const store = options.publications;
		if (!keeps(store)) {
			response.status(404).json({
				error: "not-published",
				message: NO_PUBLICATIONS
			});
			return;
		}
		try {
			const publication = await store.byId(request.params.id, assessmentOf(request));
			if (publication == null || publication.month !== request.params.month) {
				response.status(404).json({
					error: "not-found",
					message: "There is no such publication of that month."
				});
				return;
			}
			response.setHeader("Content-Type", "text/csv; charset=utf-8");
			response.setHeader("Content-Disposition", `attachment; filename="${publication.month}-${publication.id}.csv"`);
			response.setHeader("X-Export-Digest", fromBytes(Buffer.from(publication.csv, "utf8")));
			response.send(publication.csv);
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	});
	/**
	* Publish a month.
	*
	* The first publication of a month: refused if the month has not closed in the workspace timezone,
	* and refused if the month already has a publication — a second first-publication is a correction,
	* which is what `supersede` is for. Reads the live sources, freezes the bytes, and records the act
	* against the month.
	*/
	app.post("/api/months/:month/publish", async (request, response) => {
		let act;
		const month = parseMonth(request.params.month);
		if (month == null) {
			response.status(400).json({
				error: "bad-month",
				message: "A month is `YYYY-MM`, with the month in 01–12."
			});
			return;
		}
		try {
			const who = await options.permitted(request, response, "month.publish", { target: monthTarget(month) });
			act = who.act;
			const store = options.publications;
			if (!keeps(store)) {
				await act.failed("not-durable");
				response.status(409).json({
					error: "not-durable",
					message: NO_PUBLICATIONS
				});
				return;
			}
			const zone = await options.timezone();
			if (!monthHasClosed(month, zone.id, at())) {
				await act.failed("not-closed");
				response.status(409).json({
					error: "not-closed",
					message: notClosed(month, zone)
				});
				return;
			}
			if ((await store.ofMonth(month, assessmentOf(request))).length > 0) {
				await act.failed("already-published");
				response.status(409).json({
					error: "already-published",
					message: `${monthLabel(month)} has already been published. A change to a published month is a correction, which supersedes the existing publication and carries a reason — publish does not overwrite.`
				});
				return;
			}
			const { sources, eligibility } = await assemble(month, monthWindow(month, zone.id), zone.id, assessmentOf(request), true);
			if (!eligibility.eligible) {
				await act.failed(eligibility.reason.code);
				response.status(409).json({
					error: eligibility.reason.code,
					message: eligibility.reason.message,
					eligibility
				});
				return;
			}
			const publication = await freeze(store, {
				id: mintId(),
				month,
				publishedAt: at(),
				publishedBy: who.actor
			}, 1, assessmentOf(request), sources);
			await act.performed(monthTarget(month));
			response.status(201).json(resultOf(publication));
		} catch (cause) {
			await act?.failed(cause instanceof PublicationRaceError ? cause : "publication-unreadable");
			if (raced(response, cause)) return;
			if (act == null) {
				options.respondToFailure(response, cause);
				return;
			}
			publicationGateFailure(response, 503, ineligible("unreadable", "publication-unreadable", `${monthLabel(month)} could not be read or written safely, so no publication was accepted.`, "Restore the failed store connection and retry this exact publication request."));
		}
	});
	/**
	* Publish a correction to a month.
	*
	* Refused if the month has none to supersede, if the named predecessor is not the one that currently
	* stands, or if no reason is given — a correction with no reason is a record nobody can account for
	* later. The superseded copy stays readable at its own digest; this appends a new one that names it.
	*/
	app.post("/api/months/:month/supersede", async (request, response) => {
		let act;
		const month = parseMonth(request.params.month);
		if (month == null) {
			response.status(400).json({
				error: "bad-month",
				message: "A month is `YYYY-MM`, with the month in 01–12."
			});
			return;
		}
		try {
			const who = await options.permitted(request, response, "month.supersede", { target: monthTarget(month) });
			act = who.act;
			const store = options.publications;
			if (!keeps(store)) {
				await act.failed("not-durable");
				response.status(409).json({
					error: "not-durable",
					message: NO_PUBLICATIONS
				});
				return;
			}
			const body = typeof request.body === "object" && request.body != null ? request.body : {};
			const reason = typeof body.reason === "string" ? body.reason.trim() : "";
			if (reason.length < MIN_REASON) {
				await act.failed("no-reason");
				response.status(400).json({
					error: "no-reason",
					message: "A correction has to say why it was published, in at least a sentence. The superseded copy stays readable, and the reason is what lets a reader account for two copies of a month that disagree."
				});
				return;
			}
			const ordered = await store.ofMonth(month, assessmentOf(request));
			const current = ordered[ordered.length - 1];
			if (current == null) {
				await act.failed("nothing-to-supersede");
				response.status(409).json({
					error: "nothing-to-supersede",
					message: `${monthLabel(month)} has not been published, so there is nothing to correct. Publish it first.`
				});
				return;
			}
			if (body.supersedes !== current.id) {
				await act.failed("not-current");
				response.status(409).json({
					error: "not-current",
					message: "The publication being corrected is not the one that currently stands — it was superseded since the page was read. Read the month again and correct the current publication, so a correction is never written against a copy that something else has already replaced.",
					current: current.id
				});
				return;
			}
			const zone = await options.timezone();
			const { sources, eligibility } = await assemble(month, monthWindow(month, zone.id), zone.id, assessmentOf(request), true);
			if (!eligibility.eligible) {
				await act.failed(eligibility.reason.code);
				response.status(409).json({
					error: eligibility.reason.code,
					message: eligibility.reason.message,
					eligibility
				});
				return;
			}
			const publication = await freeze(store, {
				id: mintId(),
				month,
				publishedAt: at(),
				publishedBy: who.actor,
				supersedes: current.id,
				reason
			}, (current.ordinal ?? ordered.length) + 1, assessmentOf(request), sources);
			await act.performed(monthTarget(month));
			response.status(201).json(resultOf(publication));
		} catch (cause) {
			await act?.failed(cause instanceof PublicationRaceError ? cause : "publication-unreadable");
			if (raced(response, cause)) return;
			if (act == null) {
				options.respondToFailure(response, cause);
				return;
			}
			publicationGateFailure(response, 503, ineligible("unreadable", "publication-unreadable", `${monthLabel(month)} could not be read or written safely, so no correction was accepted.`, "Restore the failed store connection, reload the standing publication, and retry the correction."));
		}
	});
}
function publicationGateFailure(response, status, eligibility) {
	response.status(status).json({
		error: eligibility.reason.code,
		message: eligibility.reason.message,
		action: eligibility.reason.action,
		eligibility
	});
}
/**
* Answers the store's refusal of a lost race as a conflict, or leaves the failure to be reported.
*
* 409 rather than 500 because nothing is broken: something else published at this position first, and the
* caller's move is to read the month again. The endpoint's own read-then-check refuses this in every case
* it can see; this is the case it cannot, two callers passing the check at once.
*/
function raced(response, cause) {
	if (!(cause instanceof PublicationRaceError)) return false;
	response.status(409).json({
		error: "publication-raced",
		message: cause.message
	});
	return true;
}
//#endregion
export { registerPublicationRoutes };
