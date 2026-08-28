//#region server/monthly/window.ts
/** The wall-clock parts a zone shows at an instant, read by type so the locale cannot change them. */
function partsInZone(instant, timezone) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23"
	}).formatToParts(instant);
	const value = (type) => Number(parts.find((part) => part.type === type)?.value);
	return {
		y: value("year"),
		mo: value("month"),
		d: value("day"),
		h: value("hour"),
		mi: value("minute"),
		s: value("second")
	};
}
/**
* The UTC instant at which a zone's wall clock reads the given local time.
*
* Computed by asking what a zone shows for a guess made as if the wall time were UTC, and correcting
* by the difference — the standard single-pass inversion. Exact at a local midnight, which is the only
* time this is asked for, because midnight on the first of a month is never a daylight-saving instant.
*/
function zonedWallToUtc(y, mo, d, timezone) {
	const guess = Date.UTC(y, mo - 1, d, 0, 0, 0);
	const seen = partsInZone(new Date(guess), timezone);
	const offset = Date.UTC(seen.y, seen.mo - 1, seen.d, seen.h, seen.mi, seen.s) - guess;
	return new Date(guess - offset);
}
/**
* The half-open span `[start, end)` of `month` in `timezone`.
*
* `start` is the first instant of the month in the zone; `end` is the first instant of the next,
* which is the month after December of the same year rolled to January of the next. Half-open so a
* record at the very first instant of the next month belongs to that month alone.
*/
function monthWindow(month, timezone) {
	const [yearText, monthText] = month.split("-");
	const year = Number(yearText);
	const ordinal = Number(monthText);
	return {
		start: zonedWallToUtc(year, ordinal, 1, timezone),
		end: zonedWallToUtc(ordinal === 12 ? year + 1 : year, ordinal === 12 ? 1 : ordinal + 1, 1, timezone)
	};
}
//#endregion
export { monthWindow };
