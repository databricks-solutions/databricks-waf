import { UnreadableBodyError, readUploaded } from "../import/read.js";
import { UnsafeJsonError, parseUntrusted } from "../import/parse.js";
import { MalformedEnvelopeError, envelopeFrom } from "../import/envelope.js";
import { REPLAYED, assess } from "../import/trust.js";
import { ReplayedImportError, summaryOf } from "../import/store.js";
//#region server/api/import-routes.ts
const NO_STORE = "This install has nowhere to keep imported evidence, so a file cannot be accepted: it would answer requirements on this page and be gone on the next restart, which is worse than not having answered them. Bind a Lakebase instance to the app and the import becomes available.";
function noteOf(note) {
	return {
		reason: note.reason,
		message: note.message
	};
}
function presentImport(imported) {
	const { summary } = imported;
	return {
		digest: imported.digest,
		generatedAt: summary.generatedAt,
		importedAt: imported.importedAt.toISOString(),
		importedBy: imported.importedBy,
		...summary.collectedBy != null ? { collectedBy: summary.collectedBy } : {},
		workspaceTier: summary.workspaceTier,
		accountTier: summary.accountTier,
		observed: summary.observed,
		refused: summary.refused,
		requirements: summary.requirements,
		scriptVersion: summary.scriptVersion,
		cautions: imported.cautions.map(noteOf)
	};
}
/**
* What the app believes it is assessing, from the last scan.
*
* Absent workspace ids rather than an empty list when no scan has run, because the two mean opposite
* things to `trust.ts`: an empty list is "this assessment covers no workspaces", which would refuse
* every file, and absence is "the app does not know yet", which cautions instead. The distinction is
* the reason this returns a `Target` with optional members rather than arrays with defaults.
*
* A read failure is treated as not knowing rather than propagated. The store being unavailable is not
* a reason to refuse evidence; it is a reason to be unable to confirm the file is about this estate,
* which is exactly what the unverified caution says.
*/
async function targetFrom(store) {
	try {
		const assessed = (await store.latest())?.estate?.assessed ?? [];
		if (assessed.length === 0) return {};
		return { workspaceIds: assessed.map((workspace) => workspace.id) };
	} catch {
		return {};
	}
}
function verdictOf(verdict, imported) {
	return {
		accepted: imported != null,
		refusals: verdict.refusals.map(noteOf),
		cautions: verdict.cautions.map(noteOf),
		...imported != null ? { imported: presentImport(summaryOf(imported)) } : {}
	};
}
function registerImportRoutes(app, options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	app.get("/api/evidence/imports", async (_request, response) => {
		const store = options.imports;
		if (store == null) {
			response.json({
				durable: false,
				imports: [],
				acceptedForDays: 30
			});
			return;
		}
		const held = await store.summaries();
		const payload = {
			durable: store.durable,
			imports: held.map(presentImport),
			acceptedForDays: 30
		};
		response.json(payload);
	});
	app.post("/api/evidence/imports", async (request, response) => {
		const store = options.imports;
		if (store == null) {
			response.status(503).json({
				error: "imports-unavailable",
				message: NO_STORE
			});
			return;
		}
		let actor;
		let act;
		try {
			({actor, act} = await options.permitted(request, response, "evidence.import"));
		} catch (cause) {
			options.respondToFailure(response, cause);
			return;
		}
		let envelope;
		try {
			envelope = envelopeFrom(parseUntrusted(await readUploaded(request)));
		} catch (cause) {
			await act.failed(cause instanceof UnreadableBodyError || cause instanceof UnsafeJsonError || cause instanceof MalformedEnvelopeError ? cause.reason : cause);
			if (cause instanceof UnreadableBodyError) {
				const status = cause.reason === "too-large" ? 413 : cause.reason === "wrong-content-type" ? 415 : 400;
				response.status(status).json({
					error: cause.reason,
					message: cause.message
				});
				return;
			}
			if (cause instanceof UnsafeJsonError) {
				response.status(400).json({
					error: cause.reason,
					message: cause.message
				});
				return;
			}
			if (cause instanceof MalformedEnvelopeError) {
				response.status(400).json({
					error: cause.reason,
					message: cause.message,
					at: cause.at
				});
				return;
			}
			options.respondToFailure(response, cause);
			return;
		}
		const verdict = assess({
			envelope,
			target: await targetFrom(options.store),
			imported: await store.digests(),
			...options.publishedScriptDigest?.() != null ? { publishedScriptDigest: options.publishedScriptDigest() } : {},
			now: now()
		});
		if (!verdict.trusted) {
			await act.failed(verdict.refusals[0]?.reason ?? "untrusted", {
				kind: "evidence",
				id: verdict.digest
			});
			const replayed = verdict.refusals.some((refusal) => refusal.reason === "replayed");
			response.status(replayed ? 409 : 422).json(verdictOf(verdict));
			return;
		}
		const imported = {
			digest: verdict.digest,
			generatedAt: new Date(Date.parse(envelope.generatedAt)),
			importedAt: now(),
			importedBy: actor,
			envelope,
			cautions: verdict.cautions
		};
		try {
			await store.record(imported);
			await act.performed({
				kind: "evidence",
				id: imported.digest
			});
		} catch (cause) {
			await act.failed(cause instanceof ReplayedImportError ? "replayed" : cause, {
				kind: "evidence",
				id: imported.digest
			});
			if (cause instanceof ReplayedImportError) {
				const raced = {
					...verdict,
					trusted: false,
					refusals: [...verdict.refusals, REPLAYED]
				};
				response.status(409).json(verdictOf(raced));
				return;
			}
			options.respondToFailure(response, cause);
			return;
		}
		response.status(201).json(verdictOf(verdict, imported));
	});
}
//#endregion
export { presentImport, registerImportRoutes };
