//#region server/note/note.ts
const NOTE_SUBJECT_KINDS = [
	"run",
	"pillar",
	"control"
];
var InvalidNoteError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "InvalidNoteError";
	}
};
/** The longest, so one paste of a stack trace cannot make a thread unreadable. */
const MAX_NOTE = 4e3;
/**
* A request body into a draft, or a sentence saying what to fix.
*
* The subject comes from the route rather than the body, which is why it is a parameter here: a note
* whose body could name its own subject is a note that can be filed against a requirement the caller
* was never looking at, and the audit target would be the one the URL named.
*/
function draftFrom(body, subject, context = {}) {
	if (subject.id.trim() === "") throw new InvalidNoteError(`A note about a ${subject.kind} has to name which ${subject.kind}.`);
	const fields = body != null && typeof body === "object" ? body : {};
	const text = typeof fields.body === "string" ? fields.body.trim() : "";
	if (text.length < 10) throw new InvalidNoteError(`Write at least ${String(10)} characters. A note is read by somebody who was not in the room, and a thread of one-word notes costs them a line each and tells them nothing.`);
	if (text.length > 4e3) throw new InvalidNoteError(`That is ${String(text.length)} characters, and a note may be at most ${String(MAX_NOTE)}. Anything longer is a document, and a document pasted into a thread is a thread nobody reads to the bottom of.`);
	const corrects = typeof fields.corrects === "string" ? fields.corrects.trim() : void 0;
	if (corrects != null && corrects !== "") {
		if (!(context.existing ?? []).some((note) => note.id === corrects)) throw new InvalidNoteError(`No note with id ${corrects} is filed against this ${subject.kind}. A correction names the note it corrects, so that both stay readable and neither is quietly replaced.`);
	}
	const observed = subject.kind === "run" ? void 0 : (typeof fields.observedIn === "string" ? fields.observedIn.trim() : void 0) ?? context.observedIn;
	return {
		subject,
		body: text,
		...observed != null && observed !== "" ? { observedIn: observed } : {},
		...corrects != null && corrects !== "" ? { corrects } : {}
	};
}
/** A draft and who is writing it into the note that gets stored. */
function noted(draft, by, id, at) {
	return {
		id,
		subject: draft.subject,
		body: draft.body,
		by,
		at,
		...spread(draft)
	};
}
function spread(draft) {
	return {
		...draft.observedIn != null ? { observedIn: draft.observedIn } : {},
		...draft.corrects != null ? { corrects: draft.corrects } : {}
	};
}
/**
* A thread, oldest first.
*
* The opposite order from the decision register and the audit trail, and for the opposite reason.
* Those are records somebody scans for the latest state, so the newest row is the one they want. A
* thread is read as a conversation: a correction makes no sense above the note it corrects, and
* reading a discussion backwards is a thing no reader does voluntarily.
*
* Ties broken on the id so the order is total. Two notes written in the same millisecond is a paste
* of two observations, and an unstable sort would show them in a different order on each request.
*/
function threaded(notes) {
	return [...notes].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
}
//#endregion
export { InvalidNoteError, MAX_NOTE, NOTE_SUBJECT_KINDS, draftFrom, noted, threaded };
