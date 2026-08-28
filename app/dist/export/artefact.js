import { fromBytes, hexOf } from "../records/digest.js";
import "./variant.js";
import { assessmentCsv, assessmentDocument, exportName } from "./document.js";
import { planCsv, planDocument, planExportName } from "./plan-document.js";
//#region server/export/artefact.ts
/**
* The digest of the body, sent with the body.
*
* So a client that downloaded the file can check it without a second request, and so a proxy log
* shows what was served. Named after `X-Evidence-Script-Digest`, which does the same job for the
* collection script, rather than RFC 9530's `Repr-Digest` — the value here is the `sha256:…` string
* this app writes everywhere else, and a standard header carrying a non-standard encoding of its
* value would be worse than an obviously local one.
*/
const DIGEST_HEADER = "X-Export-Digest";
const CONTENT_TYPE = {
	csv: "text/csv; charset=utf-8",
	json: "application/json; charset=utf-8"
};
/** Build an assessment's file and digest it. `sealed` below carries the rule both entry points obey. */
function seal(options) {
	const { format } = options;
	const variant = options.variant ?? "technical";
	const text = format === "csv" ? assessmentCsv(options) : JSON.stringify(assessmentDocument(options), null, 2);
	return sealed(exportName(options.scan, format, variant), format, variant, text);
}
/**
* Build an improvement plan's file and digest it.
*
* A second entry point rather than a `kind` on the first, because the two documents are built from
* different records and a function that took either would take a union its body had to narrow — and
* the narrowing is the place a route ends up able to ask for the assessment of a plan.
*
* What the two share is this module's one invariant, which is why they both end up in `sealed`: the
* bytes and the digest over them are produced together, so no route can record a digest of something
* other than what it sent.
*/
function sealPlan(options) {
	const { format } = options;
	const variant = options.variant ?? "delivery";
	const text = format === "csv" ? planCsv(options) : JSON.stringify(planDocument(options), null, 2);
	return sealed(planExportName(options.plan, format, variant), format, variant, text);
}
/**
* The bytes, and the digest over exactly those bytes.
*
* The JSON is pretty-printed with two spaces, and that is part of what is digested. A recipient
* checking a file has to hash the bytes they were sent, so the indentation is as much a part of the
* format as the field names are — reformatting the output is a change of document version, not a
* change of presentation.
*/
function sealed(name, format, variant, text) {
	const bytes = Buffer.from(text, "utf8");
	return {
		name,
		format,
		variant,
		contentType: CONTENT_TYPE[format],
		bytes,
		digest: fromBytes(bytes)
	};
}
/**
* What a recipient runs to check the file, in the words they would use.
*
* Here rather than in the client, because the client is not the only reader of it — the same sentence
* belongs beside a digest wherever one is shown, including in a report a person pastes into an email
* to whoever they sent the file to. Both commands rather than the shorter one: `shasum` is macOS,
* `sha256sum` is most Linux, and telling somebody to run the one they do not have is how a
* verification step gets skipped.
*/
function howToCheck(artefact) {
	return [
		`shasum -a 256 ${artefact.name}`,
		`sha256sum ${artefact.name}`,
		`# expect ${hexOf(artefact.digest)}`
	];
}
//#endregion
export { DIGEST_HEADER, howToCheck, seal, sealPlan };
