import { SURFACES } from "./surfaces.js";
//#region server/scan/budget.ts
var Budget = class {
	spentBySurface;
	limits;
	wallClockMs;
	now;
	startedAt;
	firstExhaustion;
	constructor(options) {
		this.limits = { ...options.limits };
		this.wallClockMs = options.wallClockMs ?? 27e5;
		this.now = options.now ?? Date.now;
		this.startedAt = this.now();
		this.spentBySurface = Object.fromEntries(SURFACES.map((s) => [s, 0]));
	}
	/**
	* Reserve `units` against `surface`, returning false if that would exceed either
	* the surface budget or the wall clock.
	*
	* Reserved before the work runs rather than counted after, so that a burst of
	* concurrent tasks cannot collectively overshoot a limit that each of them
	* individually respected.
	*/
	tryTake(surface, units = 1) {
		const elapsedMs = this.elapsedMs();
		if (elapsedMs >= this.wallClockMs) {
			this.recordExhaustion({
				kind: "wall-clock",
				limitMs: this.wallClockMs,
				elapsedMs
			});
			return false;
		}
		const limit = this.limits[surface];
		if (this.spentBySurface[surface] + units > limit) {
			this.recordExhaustion({
				kind: "surface-budget",
				surface,
				limit
			});
			return false;
		}
		this.spentBySurface[surface] += units;
		return true;
	}
	/**
	* Give back units for work that never ran — cancelled before it started, or
	* refused by a limiter. Without this, a cancelled scan would report having spent
	* a budget it did not spend, and the footprint would overstate the load the app
	* put on the workspace. Overstating our own impact is a smaller sin than
	* understating it, but it is still wrong.
	*/
	refund(surface, units = 1) {
		this.spentBySurface[surface] = Math.max(0, this.spentBySurface[surface] - units);
	}
	/** The reason the scan first hit a wall, for reporting on a partial result. */
	exhaustion() {
		if (this.firstExhaustion == null) {
			const elapsedMs = this.elapsedMs();
			if (elapsedMs >= this.wallClockMs) this.recordExhaustion({
				kind: "wall-clock",
				limitMs: this.wallClockMs,
				elapsedMs
			});
		}
		return this.firstExhaustion;
	}
	remaining(surface) {
		return Math.max(0, this.limits[surface] - this.spentBySurface[surface]);
	}
	elapsedMs() {
		return this.now() - this.startedAt;
	}
	spend() {
		return {
			spent: { ...this.spentBySurface },
			limits: { ...this.limits },
			elapsedMs: this.elapsedMs(),
			wallClockMs: this.wallClockMs
		};
	}
	recordExhaustion(reason) {
		this.firstExhaustion ??= reason;
	}
};
//#endregion
export { Budget };
