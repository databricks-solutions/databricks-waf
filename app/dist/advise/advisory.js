//#region server/advise/advisory.ts
/**
* Whether a run found anything worth showing.
*
* Asked by the route before it answers, because the honest response to a run that read nothing is not
* an empty page — it is that this run could not see the estate. A scan makes the same distinction
* through its footprint; an advisory run has no score to make it visible, so it is asked directly.
*/
function sighted(advisory) {
	return advisory.readings.some((reading) => reading.status === "observed");
}
//#endregion
export { sighted };
