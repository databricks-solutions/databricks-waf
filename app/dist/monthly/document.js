import { canonicalise } from "../records/canonical.js";
import { csv } from "../export/csv.js";
import { monthLabel } from "./publication.js";
const MONTH_DOCUMENT_KIND = "databricks-waf-month";
/**
* The document for one publication of one month.
*
* Identity is baked in here, because the bytes are the thing that travels and a superseded copy
* forwarded to a board has only itself to say what it is (ADR 0072): month, publication instant and
* publication id are inside the document, so a digest resolves to a moment and not only to a month.
*/
function monthDocument(identity, content) {
	return {
		documentKind: MONTH_DOCUMENT_KIND,
		documentVersion: 1,
		publication: {
			id: identity.id,
			month: identity.month,
			monthLabel: monthLabel(identity.month),
			publishedAt: identity.publishedAt.toISOString(),
			publishedBy: identity.publishedBy,
			...identity.supersedes != null ? { supersedes: identity.supersedes } : {},
			...identity.reason != null ? { reason: identity.reason } : {}
		},
		...content.assessment != null ? { assessment: content.assessment } : {},
		runHealth: content.runHealth,
		findingDeltas: content.findingDeltas,
		movement: content.movement,
		actions: content.actions,
		exceptions: content.exceptions,
		outcomes: content.outcomes,
		...content.review != null ? { review: content.review } : {},
		trend: content.trend
	};
}
/** The JSON bytes of a document, canonical so the same document hashes to the same value every time. */
function monthJson(document) {
	return canonicalise(document);
}
/** The header of the flat CSV, named once so the builder below and any reader agree on the columns. */
const CSV_HEADER = [
	"month",
	"publication_id",
	"published_at",
	"section",
	"item",
	"from_or_value",
	"to",
	"note"
];
/**
* The same publication as a flat CSV, for the reader who works in a spreadsheet.
*
* Long format — one row per datum, every row carrying the month and publication id — for the reason
* the assessment export gives: a spreadsheet has no header block, so a reader who filters to a handful
* of rows has to still be looking at complete statements. The sections are stacked in a fixed order
* with a `section` column telling them apart, so a reader can filter to the deltas or the exceptions
* without the file needing a shape per section. `csv` defuses any cell a spreadsheet would evaluate.
*/
function monthCsv(document) {
	const { id, month, publishedAt } = document.publication;
	const lead = [
		month,
		id,
		publishedAt
	];
	const rows = [[...CSV_HEADER]];
	for (const fact of document.runHealth) rows.push([
		...lead,
		"run health",
		fact.label,
		fact.value,
		"",
		""
	]);
	for (const move of document.movement) rows.push([
		...lead,
		"movement",
		move.label,
		move.from,
		move.to,
		""
	]);
	for (const delta of document.findingDeltas) rows.push([
		...lead,
		"finding delta",
		`${delta.control} ${delta.requirement} (${delta.pillar})`,
		delta.from,
		delta.to,
		delta.note ?? ""
	]);
	for (const action of document.actions) rows.push([
		...lead,
		"actions",
		action.label,
		action.value,
		"",
		""
	]);
	for (const exception of document.exceptions) rows.push([
		...lead,
		"exception",
		`${exception.control} ${exception.requirement}`,
		exception.owner,
		exception.until,
		exception.residual
	]);
	for (const outcome of document.outcomes) rows.push([
		...lead,
		"outcomes",
		outcome.label,
		outcome.value,
		"",
		""
	]);
	for (const fact of document.review ?? []) rows.push([
		...lead,
		"review",
		fact.label,
		fact.value,
		"",
		""
	]);
	for (const point of document.trend) rows.push([
		...lead,
		"trend",
		point.label,
		point.score,
		point.comparability,
		point.note ?? ""
	]);
	return csv(rows);
}
//#endregion
export { MONTH_DOCUMENT_KIND, monthCsv, monthDocument, monthJson };
