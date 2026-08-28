//#region server/api/assessment-query.ts
/**
* The assessment this request is of.
*
* A non-empty `definitionId` query parameter is that definition. Anything else — omitted, empty,
* an array Express would produce from a repeated key — is the unscoped view. Routes pass the
* result to every product read; they do not omit the argument, because omitting it at the store
* is the installation-wide path and a forgotten query parameter must not reopen that path.
*/
function assessmentOf(request) {
	const raw = request.query.definitionId;
	if (typeof raw !== "string") return null;
	const id = raw.trim();
	return id === "" ? null : id;
}
/**
* A product URL that names the assessment the resource belongs to.
*
* Built from the record, not from the request: a digest payload is copied off the page and fetched
* later, and the request that published the href is gone by then. Unscoped records omit the
* parameter, which is the unscoped view.
*/
function scopedHref(path, definitionId) {
	if (definitionId == null || definitionId === "") return path;
	return `${path}${path.includes("?") ? "&" : "?"}definitionId=${encodeURIComponent(definitionId)}`;
}
//#endregion
export { assessmentOf, scopedHref };
