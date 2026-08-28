//#region shared/api/internal-delivery-patterns.json
var internal_delivery_patterns_default = [
	"\\b(?:PR|pull request)\\s*#?\\d+\\b",
	"\\b(?:row|phase)\\s+(?:[A-Z]\\d+[a-z]*|\\d+[a-z]*)\\b",
	"\\b(?:[A-Z]\\d+[a-z]*|\\d+[a-z]+)\\s+(?:labs|served|customer|CUJ|journey|pilot)\\b"
];
//#endregion
export { internal_delivery_patterns_default as default };
