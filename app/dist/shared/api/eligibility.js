//#region shared/api/eligibility.ts
function eligible() {
	return {
		eligible: true,
		state: "eligible"
	};
}
function ineligible(state, code, message, action) {
	return {
		eligible: false,
		state,
		reason: {
			code,
			message,
			action
		}
	};
}
//#endregion
export { eligible, ineligible };
