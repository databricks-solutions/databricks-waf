//#region server/monthly/publication-language.ts
/** A complete clause naming the selected run by recorded time rather than opaque id. */
function selectedRun(month, finishedAt, closed) {
	return closed ? `${month} closed on the run finished ${finishedAt}` : `${month} currently uses the run finished ${finishedAt} in this preview`;
}
/** A noun phrase for a later sentence about that same selected run. */
function selectedRunReference(finishedAt, closed) {
	return closed ? `the closing run finished ${finishedAt}` : `the run finished ${finishedAt} selected by this preview`;
}
/** The honest absence when the month has no run to select. */
function noSelectedRun(month, closed) {
	return closed ? `${month} has no readable closing run, so neither its review nor report can be shown.` : `${month} has no readable run in the month yet, so this preview cannot show a review or report.`;
}
//#endregion
export { noSelectedRun, selectedRun, selectedRunReference };
