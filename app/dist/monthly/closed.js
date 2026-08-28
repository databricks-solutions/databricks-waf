import { parseMonth } from "./publication.js";
//#region server/monthly/closed.ts
/**
* The month a wall clock in `timezone` reads at the instant `now`.
*
* From `Intl` rather than from `Date` arithmetic, because "what month is it there" is exactly what a
* localised formatter answers and exactly what an offset calculation gets wrong twice a year. The
* parts are read by type rather than by parsing a formatted string, so the locale cannot change the
* answer — `month: '2-digit'` is numeric whatever the locale would otherwise render.
*
* Throws on a timezone `Intl` does not recognise, rather than falling back to UTC: a silent fallback
* would close a month on the wrong clock and publish it, which is the failure this module exists to
* refuse. The caller resolves a real zone or the explicit UTC default before reaching here.
*/
function currentMonthIn(timezone, now) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit"
	}).formatToParts(now);
	const year = parts.find((part) => part.type === "year")?.value;
	const month = parts.find((part) => part.type === "month")?.value;
	const parsed = parseMonth(`${year ?? ""}-${month ?? ""}`);
	if (parsed === void 0) throw new Error(`Could not read the current month in timezone "${timezone}".`);
	return parsed;
}
/**
* Whether `month` has ended in `timezone` as at `now`.
*
* True when the wall clock in that zone has moved into a later month, false while it is still in
* `month` or earlier. The strict comparison is the whole rule: the current month is not yet closed —
* its cadence is still accumulating runs — and a future month has plainly not closed either.
*/
function monthHasClosed(month, timezone, now) {
	return currentMonthIn(timezone, now) > month;
}
//#endregion
export { currentMonthIn, monthHasClosed };
