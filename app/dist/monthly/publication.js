//#region server/monthly/publication.ts
/** `YYYY-MM`, with the month in `01`–`12`. Anchored, so a longer string carrying a valid prefix fails. */
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
/**
* A `MonthId` from a string, or `undefined` when it is not one.
*
* The only constructor, because a month reaches storage and a filename and a digest's bytes, and a
* value that has not been proven to be `YYYY-MM` is a value that will one day be `2026-8` or
* `August` in one of those places. Returning `undefined` rather than throwing leaves the caller to
* decide whether a bad month is a refusal or a bug — a request supplies one and a stored row does
* not, and those want different handling.
*/
function parseMonth(raw) {
	if (typeof raw !== "string") return void 0;
	return MONTH.test(raw) ? raw : void 0;
}
/** The full month names, indexed 1–12. Fixed here so a label never depends on a machine's locale. */
const MONTH_NAMES = [
	"",
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December"
];
/**
* A month in the words a reader uses for it: `2026-08` becomes `August 2026`.
*
* From the string's own digits rather than a `Date`, because turning `2026-08` into a `Date` to read
* its month back is a round trip through a timezone that can land in July, and the label is baked into
* frozen bytes where being wrong is permanent.
*/
function monthLabel(month) {
	const [year, ordinal] = month.split("-");
	return `${MONTH_NAMES[Number(ordinal)]} ${year}`;
}
/**
* The calendar date a month becomes publishable: the first of the next month, in that month's own
* names rather than a timezone-formatted instant.
*
* A reader waiting on August is told "1 September 2026", which is when August has closed on any
* clock that still calls it August. The instant that date arrives depends on the workspace zone and
* is the closure rule's; this is only the date the preview names beside a disabled publish action.
*/
function monthOpensOn(month) {
	const [yearText, monthText] = month.split("-");
	const year = Number(yearText);
	const ordinal = Number(monthText);
	const nextOrdinal = ordinal === 12 ? 1 : ordinal + 1;
	const nextYear = ordinal === 12 ? year + 1 : year;
	return `1 ${MONTH_NAMES[nextOrdinal]} ${String(nextYear)}`;
}
/**
* The publications of a month that nothing supersedes, in publication order.
*
* Supersession is read from the successor that claims it rather than from adjacency, because on an
* append-only record adjacency is not evidence: a month that holds two publications neither of which
* names the other is a month where nothing was superseded, and calling the earlier one superseded would
* be the read path writing history that did not happen.
*
* More than one means exactly that, and there is nothing here that says which of them replaced which.
* A caller may report the count. It may not pick one.
*/
function unsuperseded(publications) {
	const replaced = new Set(publications.map((publication) => publication.supersedes).filter((id) => id != null));
	return inPublishedOrder(publications).filter((publication) => !replaced.has(publication.id));
}
/**
* The publication that superseded this one, or undefined where nothing did.
*
* By name, for the reason above. The month is passed whole rather than a successor by position.
*/
function supersededBy(publication, publications) {
	return publications.find((candidate) => candidate.supersedes === publication.id);
}
/**
* A month's publications in the order they were published, so standing can be read from position.
*
* Oldest first, which is publication order because `publishedAt` only moves forward within a month.
* Whether a publication is current or superseded is not stored on it — that would be a mutation of an
* append-only record — but derived from where it sits: the last is current, the rest are superseded.
* The reading of that ordinal into a sentence ("publication 2 of 3, superseded on…") is 28c's; this
* only fixes the order the reading depends on.
*/
function inPublishedOrder(publications) {
	return [...publications].sort((left, right) => {
		const byTime = left.publishedAt.getTime() - right.publishedAt.getTime();
		return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
	});
}
//#endregion
export { inPublishedOrder, monthLabel, monthOpensOn, parseMonth, supersededBy, unsuperseded };
