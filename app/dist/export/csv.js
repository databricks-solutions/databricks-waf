//#region server/export/csv.ts
/**
* The characters that start a formula in Excel, Sheets, Numbers and LibreOffice.
*
* Tab and carriage return are here because both are stripped during paste, exposing whatever
* followed them to the same evaluation. They are quoted by rule 1 as well, which protects the
* file's structure but not the cell's meaning once it is inside the sheet.
*/
const EVALUATED = /^[=+\-@\t\r]/;
/** Anything a spreadsheet would read as a number, so neutralising cannot turn -3 into text. */
const NUMERIC = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
/**
* One line of a cell, defused if a spreadsheet would evaluate it.
*
* The numeric exemption is not a nicety. Negative numbers are the common legitimate case for a
* leading minus, and prefixing them would turn a column of figures into a column of text that a
* reader cannot sum — which is most of the reason they asked for a spreadsheet. `-1+1+cmd|'/C
* calc'!A0`, the payload this defends against, is not a number and is still caught.
*/
function defuse(line) {
	return EVALUATED.test(line) && !NUMERIC.test(line) ? `'${line}` : line;
}
/**
* One field, quoted if it has to be and defused if it would otherwise be executed.
*
* # Every line, not just the first
*
* The neutralising is anchored to the start of a line, and a cell may contain several: RFC 4180 lets a
* quoted field hold newlines, and the plan export uses that deliberately — an action's steps are one
* cell of several lines, because any separator character would be one a step could contain.
*
* Defusing only the whole cell left every line after the first undefended, and it is reachable: a
* reader who copies a multi-line cell out of a sheet gets one row per line, each line becoming its own
* cell in a formula position. That is the same mechanism this file already reasons about for tab and
* carriage return — characters "stripped during paste, exposing whatever followed them" — so a payload
* as the second step of an action was the first line of a cell in the reader's next paste.
*
* Per line is a no-op for every single-line value, so the assessment export's bytes are unchanged and
* its `documentVersion` does not move. Confirmed rather than assumed: no cell in `document.ts` can
* contain a newline, because it joins its multi-value columns with `'; '`.
*/
function field(value) {
	const defused = value.includes("\n") ? value.split("\n").map(defuse).join("\n") : defuse(value);
	return /[",\r\n]/.test(defused) ? `"${defused.replaceAll("\"", "\"\"")}"` : defused;
}
/**
* A CSV document, with CRLF line endings as the format specifies.
*
* CRLF rather than the LF a Unix reader would prefer, because the consumer here is Excel on a
* laptop rather than a shell pipeline, and Excel is the one that gets it wrong.
*/
function csv(rows) {
	return rows.map((row) => row.map(field).join(",")).join("\r\n");
}
//#endregion
export { csv };
