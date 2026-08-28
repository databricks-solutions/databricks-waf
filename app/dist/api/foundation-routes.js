import { assessmentOf } from "./assessment-query.js";
import { ServingDefinitionError } from "../foundation/serving-asset.js";
import { ServingVersionError, nextDeclaration } from "../foundation/serving-store.js";
import { absences } from "../foundation/readiness.js";
import { readReadiness } from "../foundation/readiness-read.js";
import { dimensionLanguage } from "../foundation/readiness-language.js";
//#region server/api/foundation-routes.ts
const NO_STORE = "This installation is not keeping serving declarations, so there is nowhere to put one. Bind a database and restart, and what somebody declares will survive a deploy.";
const NOT_DURABLE = "Serving declarations are being kept in memory on this installation, so a restart loses them. A readiness reading is a reading of a declaration — bind a database before relying on either.";
const NO_WAREHOUSE = "No SQL warehouse is bound to this installation, so the three statements this reading is made of cannot run. Bind one and open this page again.";
function registerFoundationRoutes(app, options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	/** The current declaration, or that there is none. Never a 404: no declaration is an answer. */
	app.get("/api/foundation/serving", async (request, response) => {
		const store = options.serving;
		if (store == null) {
			response.json({
				declaration: null,
				durable: false,
				durabilityNote: NO_STORE
			});
			return;
		}
		try {
			const current = await store.current(assessmentOf(request));
			response.json({
				declaration: current == null ? null : declared(current),
				durable: store.durable,
				...store.durable ? {} : { durabilityNote: options.servingStorage ?? NOT_DURABLE }
			});
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	});
	/**
	* Declares the next version, or refuses one that is not the next.
	*
	* The version is read here rather than sent, so two people declaring from the same page collide on
	* the store's constraint instead of one silently replacing the other. What comes back on a collision
	* is 409 and the version that is current, which is the only thing the loser can act on.
	*/
	app.post("/api/foundation/serving", async (request, response) => {
		const store = options.serving;
		if (store == null) {
			response.status(503).json({
				error: "serving-unavailable",
				message: NO_STORE
			});
			return;
		}
		let act;
		try {
			const permission = await options.permitted(request, response, "serving.declare");
			const { actor } = permission;
			act = permission.act;
			const scope = assessmentOf(request);
			const previous = await store.current(scope);
			const declaration = nextDeclaration(request.body, previous, actor, now(), scope ?? void 0);
			await store.declare(declaration);
			await act.performed({
				kind: "serving",
				id: String(declaration.version)
			});
			response.status(201).json(declared(declaration));
		} catch (cause) {
			await act?.failed(cause);
			respond(response, cause, options);
		}
	});
	/**
	* Eight readings of the declared population, taken now.
	*
	* 200 in every case a reader can do something about, including the three that are not readings: no
	* declaration, no warehouse, and a statement that did not answer. A page that failed to load says
	* less than one that explains which of those happened.
	*/
	app.get("/api/foundation/readiness", async (request, response) => {
		const store = options.serving;
		try {
			const current = store == null ? void 0 : await store.current(assessmentOf(request));
			const definition = current?.definition ?? null;
			if (options.servingSql == null && definition != null) {
				response.json(unavailable(current, NO_WAREHOUSE, store?.durable === true, options));
				return;
			}
			const reading = await readReadiness(definition, options.servingSql == null ? refusing() : await options.servingSql(request));
			response.json({
				declaration: current == null ? null : declared(current),
				population: reading.outcome.population,
				dimensions: reading.outcome.dimensions.map(dimensionOf),
				absent: reading.outcome.absent,
				unread: reading.unread,
				durable: store?.durable === true,
				...store?.durable === true ? {} : { durabilityNote: options.servingStorage ?? NOT_DURABLE }
			});
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	});
}
/**
* A reading nobody could take, with the dimensions still named.
*
* Named rather than an empty list, because the eight are what the page is: a reader who arrives to a
* page with no dimensions on it learns that something is broken, and a reader who arrives to eight
* unmeasured ones and a sentence learns what to bind.
*/
function unavailable(declaration, because, durable, options) {
	return {
		declaration: declaration == null ? null : declared(declaration),
		population: {
			assets: 0,
			missing: 0,
			truncated: false,
			undeclared: declaration == null
		},
		dimensions: [],
		absent: absences(),
		unread: [],
		unavailable: because,
		durable,
		...durable ? {} : { durabilityNote: options.servingStorage ?? NOT_DURABLE }
	};
}
/** Five statements that cannot run, for the undeclared case where none of them is called. */
function refusing() {
	const no = () => Promise.reject(/* @__PURE__ */ new Error(NO_WAREHOUSE));
	return {
		population: no,
		tags: no,
		facts: no,
		quality: no,
		classes: no
	};
}
/**
* A declaration on the wire, field by field rather than spread.
*
* Written out for `note-routes.ts`'s reason: the domain type and the payload are structurally alike
* today and are allowed to stop being, and a spread would put a new domain field on the wire the day
* somebody adds one. Here that matters more than usual — the fingerprint is over the definition, and a
* payload carrying a field the fingerprint does not cover would be showing a reader something the
* version cannot account for.
*/
function declared(declaration) {
	const { definition } = declaration;
	return {
		...declaration.definitionId != null ? { definitionId: declaration.definitionId } : {},
		version: declaration.version,
		declaredAt: declaration.declaredAt.toISOString(),
		declaredBy: declaration.declaredBy,
		fingerprint: definition.fingerprint,
		named: definition.named.map((name) => ({
			catalog: name.catalog,
			schema: name.schema,
			table: name.table
		})),
		tagged: definition.tagged.map((selector) => ({
			key: selector.key,
			...selector.values != null ? { values: [...selector.values] } : {},
			at: [...selector.at]
		})),
		requiredTagKeys: [...definition.requiredTagKeys],
		requiredMetadata: [...definition.requiredMetadata],
		policy: definition.policy.map((rule) => ({
			classification: rule.classification,
			requires: [...rule.requires]
		}))
	};
}
function dimensionOf(reading) {
	const language = dimensionLanguage(reading.id);
	return {
		id: reading.id,
		version: reading.version,
		area: language.area,
		label: language.label,
		asks: language.asks,
		sources: language.sources,
		standing: reading.standing,
		bands: reading.bands,
		denominator: reading.denominator,
		met: reading.met,
		short: reading.short,
		unmeasured: reading.unmeasured,
		share: reading.share,
		...reading.because != null ? { because: reading.because } : {},
		shortfall: reading.shortfall
	};
}
function respond(response, cause, options) {
	if (cause instanceof ServingDefinitionError) {
		response.status(400).json({
			error: "invalid-declaration",
			message: cause.message
		});
		return;
	}
	if (cause instanceof ServingVersionError) {
		response.status(409).json({
			error: "stale-declaration",
			message: cause.message
		});
		return;
	}
	options.respondToFailure(response, cause);
}
//#endregion
export { registerFoundationRoutes };
