//#region server/scan/surfaces.ts
const SURFACES = [
	"sql",
	"describe",
	"rest",
	"cloud",
	"ai",
	"plans"
];
/**
* Starting limits, deliberately conservative and expected to move.
*
* These are guesses with reasons, not measurements. The batching spike will
* replace the warehouse figures with real ones, and until it does the asymmetry
* of being wrong governs: too low costs a longer scan, too high costs an
* uninstall. So they err low.
*/
function defaultLimits(warehouse = "shared") {
	return {
		sql: {
			concurrency: warehouse === "dedicated" ? 4 : 2,
			budget: 250,
			clientRetries: false,
			limiterGroup: "warehouse",
			partitioned: false
		},
		describe: {
			concurrency: warehouse === "dedicated" ? 4 : 2,
			budget: 250,
			clientRetries: false,
			limiterGroup: "warehouse",
			partitioned: false
		},
		rest: {
			concurrency: 8,
			budget: 3e3,
			clientRetries: true,
			limiterGroup: "rest",
			partitioned: false
		},
		cloud: {
			concurrency: 4,
			budget: 500,
			clientRetries: true,
			limiterGroup: "cloud",
			partitioned: true
		},
		ai: {
			concurrency: 2,
			budget: 60,
			clientRetries: false,
			limiterGroup: "ai",
			partitioned: false
		},
		plans: {
			concurrency: 2,
			budget: 200,
			clientRetries: false,
			limiterGroup: "plans",
			partitioned: false
		}
	};
}
/**
* Wall-clock ceiling for a whole scan.
*
* A scan that runs for hours is indistinguishable from a scan that has hung, and
* an operator who cannot tell the difference will kill it. Reaching this pauses
* the scan with what it has, which is a result rather than an error.
*/
const DEFAULT_WALL_CLOCK_MS = 2700 * 1e3;
//#endregion
export { DEFAULT_WALL_CLOCK_MS, SURFACES, defaultLimits };
