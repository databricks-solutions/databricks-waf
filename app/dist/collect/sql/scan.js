//#region server/collect/sql/scan.ts
/**
* Comments removed, tracking string literals so a `--` inside one is left alone.
*
* Replaced with spaces rather than deleted, so every offset into the result still matches the original.
* A checker that reports "line 132" has to mean line 132 of the file the reader will open. A block
* comment's newlines are kept for the same reason; only the text inside its delimiters is blanked.
*
* Block comments are read before string literals rather than beside them, because this file's own prose
* comments use apostrophes freely — "the estate's own work" opened a `quoted` region that would not close
* until the next `'`, anywhere later in the statement, and every paren and keyword in between vanished
* from what `words` and `scopes` could see. That silently broke arity and grouping-key checks for any
* statement whose block comment happened to contain a possessive, which three of the twenty-two did:
* `workload_query_shapes.sql`, `workload_sql_paths.sql` and `workload_warehouse_pressure.sql`.
*/
function withoutComments(sql) {
	const out = [...sql];
	let quoted = false;
	let blocked = false;
	for (let at = 0; at < out.length; at += 1) {
		const here = out[at];
		if (blocked) {
			if (here === "*" && out[at + 1] === "/") {
				out[at] = " ";
				out[at + 1] = " ";
				at += 1;
				blocked = false;
			} else if (here !== "\n") out[at] = " ";
			continue;
		}
		if (quoted) {
			if (here === "'") quoted = out[at + 1] === "'" ? (at += 1) > 0 : false;
			continue;
		}
		if (here === "/" && out[at + 1] === "*") {
			out[at] = " ";
			out[at + 1] = " ";
			at += 1;
			blocked = true;
			continue;
		}
		if (here === "'") {
			quoted = true;
			continue;
		}
		if (here === "-" && out[at + 1] === "-") while (at < out.length && out[at] !== "\n") {
			out[at] = " ";
			at += 1;
		}
	}
	return out.join("");
}
/**
* Every bare word outside a string literal, upper-cased, with its parenthesis depth.
*
* Depth is yielded rather than filtered because the two callers want opposite things: a top-level
* `SELECT` is the one at depth zero, and an aggregate that matters can be at any depth.
*/
function* words(text, from = 0) {
	let depth = 0;
	let quoted = false;
	for (let at = from; at < text.length; at += 1) {
		const here = text[at];
		if (quoted) {
			if (here === "'") quoted = text[at + 1] === "'" ? (at += 1) > 0 : false;
			continue;
		}
		if (here === "'") {
			quoted = true;
			continue;
		}
		if (here === "(") depth += 1;
		else if (here === ")") depth -= 1;
		else if (/[A-Za-z_]/.test(here)) {
			const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(at))?.[0] ?? "";
			yield {
				at,
				word: word.toUpperCase(),
				depth
			};
			at += word.length - 1;
		}
	}
}
/** Words that end a `GROUP BY` or `PARTITION BY` list, so a clause can be read without a grammar. */
const CLAUSE_END = /* @__PURE__ */ new Set([
	"ORDER",
	"LIMIT",
	"HAVING",
	"QUALIFY",
	"WINDOW",
	"UNION",
	"INTERSECT",
	"EXCEPT",
	"ROWS",
	"RANGE"
]);
/**
* The text of a `BY` list starting at an offset, read to whatever ends it.
*
* Ends at the parenthesis closing the clause's own scope — which for a `PARTITION BY` is the end of the
* `OVER (…)` and for a `GROUP BY` in a CTE is the end of the CTE — or at a keyword that cannot appear
* inside a grouping key, or at the end of the text.
*
* Scanned here rather than over `words`, which measures depth from wherever it was told to start and so
* cannot tell "left the enclosing scope" from "started at depth zero". That mismatch is worth naming: it
* silently returned an empty list for every `PARTITION BY` in the tree, and an empty list looks exactly
* like a partition key that omits the slice column. Every one of the four statements was reported unsafe
* on an axis all four are safe on. A checker's failures have to be trustworthy in both directions.
*/
function byList(text, from) {
	let depth = 0;
	let quoted = false;
	for (let at = from; at < text.length; at += 1) {
		const here = text[at];
		if (quoted) {
			if (here === "'") quoted = text[at + 1] === "'" ? (at += 1) > 0 : false;
			continue;
		}
		if (here === "'") quoted = true;
		else if (here === "(") depth += 1;
		else if (here === ")") {
			if (depth === 0) return text.slice(from, at);
			depth -= 1;
		} else if (depth === 0 && /[A-Za-z_]/.test(here)) {
			const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(at))?.[0] ?? "";
			if (CLAUSE_END.has(word.toUpperCase())) return text.slice(from, at);
			at += word.length - 1;
		}
	}
	return text.slice(from);
}
//#endregion
export { byList, withoutComments, words };
