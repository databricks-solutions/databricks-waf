import { stamped } from "../store/assessment-scope.js";
import { assessmentOf } from "./assessment-query.js";
import { InvalidNoteError, MAX_NOTE, NOTE_SUBJECT_KINDS, draftFrom, noted } from "../note/note.js";
//#region server/api/note-routes.ts
const NO_STORE = "This installation is not keeping notes, so there is nowhere to put one. Bind a database and restart, and what people write down will survive a deploy.";
const NOT_DURABLE = "Notes are being kept in memory on this installation, so a restart loses every one of them. A note is an observation somebody made while reading something they will not read again — bind a database before relying on it.";
function registerNoteRoutes(app, options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	const newId = options.newId ?? (() => crypto.randomUUID());
	/**
	* Every thread of one kind, so a page that lists many subjects can ask once.
	*
	* Registered before `/:kind/:id` because `/api/notes/threads/control` would otherwise be a thread
	* about a subject called `control` of kind `threads`. Empty threads are omitted.
	*/
	app.get("/api/notes/threads/:kind", async (request, response) => {
		const store = options.notes;
		const kind = kindFrom(request.params.kind);
		if (kind == null) {
			response.status(404).json({
				error: "unknown-subject",
				message: unknownKind(request.params.kind)
			});
			return;
		}
		if (store == null) {
			response.json({
				kind,
				threads: [],
				durable: false,
				durabilityNote: NO_STORE,
				minNote: 10,
				maxNote: MAX_NOTE
			});
			return;
		}
		try {
			const notes = await store.ofKind(kind, assessmentOf(request));
			const bySubject = /* @__PURE__ */ new Map();
			for (const note of notes) {
				const held = bySubject.get(note.subject.id) ?? [];
				held.push(note);
				bySubject.set(note.subject.id, held);
			}
			const payload = {
				kind,
				threads: [...bySubject.entries()].map(([id, group]) => ({
					subject: {
						kind,
						id
					},
					notes: group.map(present),
					durable: store.durable,
					...store.durable ? {} : { durabilityNote: options.noteStorage ?? NOT_DURABLE },
					minNote: 10,
					maxNote: MAX_NOTE
				})),
				durable: store.durable,
				...store.durable ? {} : { durabilityNote: options.noteStorage ?? NOT_DURABLE },
				minNote: 10,
				maxNote: MAX_NOTE
			};
			response.json(dated(payload));
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	});
	/**
	* How many notes each subject of one kind carries.
	*
	* So a list of pillars can show which have been written about without fetching six threads of prose
	* nobody has opened. Registered before the thread route because `/api/notes/pillar` would otherwise
	* be read as a thread about a subject with no id.
	*/
	app.get("/api/notes/:kind", async (request, response) => {
		const store = options.notes;
		const kind = kindFrom(request.params.kind);
		if (kind == null) {
			response.status(404).json({
				error: "unknown-subject",
				message: unknownKind(request.params.kind)
			});
			return;
		}
		if (store == null) {
			response.json({
				counts: {},
				durable: false,
				durabilityNote: NO_STORE
			});
			return;
		}
		try {
			const payload = {
				counts: await store.counts(kind, assessmentOf(request)),
				durable: store.durable,
				...store.durable ? {} : { durabilityNote: options.noteStorage ?? NOT_DURABLE }
			};
			response.json(payload);
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	});
	/** One thread, oldest first, because a thread is read as a conversation. */
	app.get("/api/notes/:kind/:id", async (request, response) => {
		const store = options.notes;
		const subject = subjectFrom(request);
		if (subject == null) {
			response.status(404).json({
				error: "unknown-subject",
				message: unknownKind(request.params.kind)
			});
			return;
		}
		if (store == null) {
			response.json(emptyThread(subject, NO_STORE));
			return;
		}
		try {
			const payload = {
				subject,
				notes: (await store.for(subject, assessmentOf(request))).map(present),
				durable: store.durable,
				...store.durable ? {} : { durabilityNote: options.noteStorage ?? NOT_DURABLE },
				minNote: 10,
				maxNote: MAX_NOTE
			};
			response.json(dated(payload));
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	});
	/**
	* Writes a note, or a correction of one, which is the same act.
	*
	* A correction names the note it corrects and both stay readable, so there is no route that replaces
	* a note and no audit action that claims one was changed.
	*/
	app.post("/api/notes/:kind/:id", async (request, response) => {
		const store = options.notes;
		const subject = subjectFrom(request);
		if (subject == null) {
			response.status(404).json({
				error: "unknown-subject",
				message: unknownKind(request.params.kind)
			});
			return;
		}
		if (store == null) {
			response.status(503).json({
				error: "notes-unavailable",
				message: NO_STORE
			});
			return;
		}
		let act;
		try {
			const permission = await options.permitted(request, response, "note.write", { target: targetOf(subject) });
			const { actor } = permission;
			act = permission.act;
			const scope = assessmentOf(request);
			if (options.knownSubject != null && !await options.knownSubject(subject, scope)) {
				await refuse(response, act, 404, "unknown-subject", `This installation has no ${subject.kind} called ${subject.id}, so a note about it is a note nothing can place. Check the address you came from.`);
				return;
			}
			const existing = await store.for(subject, scope);
			const note = stamped(noted(draftFrom(request.body, subject, {
				existing,
				...observedFrom(request) != null ? { observedIn: observedFrom(request) } : {}
			}), actor, newId(), now()), scope);
			await store.add(note);
			await act.performed(targetOf(subject));
			response.status(201).json(dated(present(note)));
		} catch (cause) {
			await act?.failed(cause);
			respond(response, cause, options);
		}
	});
}
/**
* The subject a request is about, from the path only.
*
* Undefined for a kind that is not one of the three, rather than a note filed against
* `pilar/data-governance` that nothing will ever read again.
*/
function subjectFrom(request) {
	const kind = kindFrom(request.params.kind);
	const id = one(request.params.id);
	if (kind == null || id === "") return void 0;
	return {
		kind,
		id
	};
}
function kindFrom(raw) {
	return NOTE_SUBJECT_KINDS.find((kind) => kind === raw);
}
/**
* One path segment as a string.
*
* Express types both a path parameter and a query parameter as a string or an array of them, because a
* repeated name is a legal URL. Two ids is not a subject, so anything else is the empty string and the
* route refuses rather than guessing which one was meant.
*/
function one(raw) {
	return typeof raw === "string" ? raw.trim() : "";
}
/**
* The run the writer was reading, from the query string.
*
* A query parameter rather than a body field because it is context about where the writer was rather
* than something they typed, and because the body may still name a different run — somebody writing
* about last month's run from this month's page. `draftFrom` treats this as the default.
*/
function observedFrom(request) {
	const observed = one(request.query.observedIn);
	return observed === "" ? void 0 : observed;
}
/** What the trail records: the thing the note is about. A run's audit kind is `scan`. */
function targetOf(subject) {
	return {
		kind: subject.kind === "run" ? "scan" : subject.kind,
		id: subject.id
	};
}
function unknownKind(raw) {
	return `A note is about a run, a pillar or a requirement, and "${raw ?? ""}" is none of them. The address is /api/notes/{run|pillar|control}/{id}.`;
}
function emptyThread(subject, why) {
	return {
		subject,
		notes: [],
		durable: false,
		durabilityNote: why,
		minNote: 10,
		maxNote: MAX_NOTE
	};
}
/**
* A note on the wire, field by field rather than spread.
*
* Written out for the reason the plan payload is: the two types are structurally identical today and
* are allowed to stop being, and a spread would carry a new domain field onto the wire the day
* somebody adds one.
*/
function present(note) {
	return {
		id: note.id,
		subject: note.subject,
		...note.observedIn != null ? { observedIn: note.observedIn } : {},
		...note.corrects != null ? { corrects: note.corrects } : {},
		body: note.body,
		by: note.by,
		at: note.at
	};
}
/** Dates as ISO strings, in one traversal at the edge. The same helper the improve routes use. */
function dated(payload) {
	if (payload instanceof Date) return payload.toISOString();
	if (Array.isArray(payload)) return payload.map((entry) => dated(entry));
	if (payload != null && typeof payload === "object") return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, dated(value)]));
	return payload;
}
async function refuse(response, act, status, error, message) {
	await act.failed(error);
	response.status(status).json({
		error,
		message
	});
}
function respond(response, cause, options) {
	if (cause instanceof InvalidNoteError) {
		response.status(400).json({
			error: "invalid-note",
			message: cause.message
		});
		return;
	}
	options.respondToFailure(response, cause);
}
//#endregion
export { registerNoteRoutes };
