import { refine } from "./buckets.js";
import { resort } from "./concat.js";
/**
* The workspaces to execute for, grouped so there are never more groups than `MAX_SLICES`.
*
* Contiguous chunks of near-equal size. Not one workspace per group, for the reason above; not
* interleaved, because nothing here knows which workspaces are large and pretending to balance them
* would be a guess dressed as a distribution. Under the ceiling this is one workspace per group,
* which is what almost every real account gets.
*
* Every group is non-empty and their union is the input in order, which is what keeps the split
* lossless: each group's filter is the statement's own `live_workspace_ids` predicate over a subset,
* and the subsets partition the set.
*/
function sliceGroups(workspaces, max = 12) {
	if (workspaces.length <= max) return workspaces.map((workspace) => [workspace]);
	const size = Math.ceil(workspaces.length / max);
	const groups = [];
	for (let at = 0; at < workspaces.length; at += size) groups.push([...workspaces.slice(at, at + size)]);
	return groups;
}
/**
* A scan-level stop, as opposed to one slice failing.
*
* Cancellation and an exhausted budget are properties of the scan, so the slices after them will not
* run either, and continuing the loop only spends round trips to be refused. They also mean
* something different from a slice that failed: the unsliced path reports both as unmeasured, and a
* sliced statement claiming `sampled` coverage of a cancelled scan would say "497 of 500 did not
* complete… re-running picks up the rest. The scan was cancelled before this check ran", which
* contradicts itself twice in one sentence.
*/
function stoppedTheScan(outcome) {
	return outcome.status === "skipped" && (outcome.reason === "cancelled" || outcome.reason === "budget-exhausted");
}
/**
* The statement's rows, gathered one group at a time.
*
* Sequential rather than parallel. The scheduler bounds concurrency anyway, and the reason it does
* applies with more force here: this turns four statements into up to forty-eight, and issuing those
* together would put the customer's own queries behind all of them.
*/
async function collectSlices(options) {
	const limit = options.limit ?? 36;
	const rows = [];
	const failed = [];
	/** Shortfalls with no scheduler outcome behind them: a truncation nothing could subdivide. */
	const refusals = /* @__PURE__ */ new Set();
	let types;
	let short = 0;
	let spent = 0;
	/**
	* One slice — or one bucket of one — and everything it had to be divided into to come back whole.
	*
	* `owed` is how many executions the groups after this one still need. Checked before subdividing so
	* that one pathological workspace cannot spend the statement's whole allowance and leave the rest of
	* the estate unread: a group that would consume the reserve is refused and reported, which costs its
	* own coverage rather than everyone else's.
	*/
	/** Records why part of the estate is missing, and reports the slice as incomplete. */
	const refuse = (why) => {
		refusals.add(why);
		return {
			status: "read",
			rows: [],
			incomplete: true
		};
	};
	const gather = async (workspaces, bucket, depth, owed) => {
		if (spent + owed >= limit) return refuse(exhausted(limit));
		spent += 1;
		const outcome = await options.run(workspaces, bucket);
		if (outcome.status !== "ok") {
			if (stoppedTheScan(outcome)) return {
				status: "stop",
				outcome
			};
			failed.push(outcome);
			return {
				status: "read",
				rows: [],
				incomplete: true
			};
		}
		if (outcome.value.truncated !== true) return {
			status: "read",
			rows: outcome.value.rows,
			...outcome.value.types && { types: outcome.value.types }
		};
		if (options.bucketOn == null) return refuse(UNDIVIDABLE);
		if (depth >= 2) return refuse(TOO_LARGE);
		const children = refine(bucket);
		if (spent + children.length + owed > limit) return refuse(exhausted(limit));
		const gathered = [];
		let whole = true;
		for (const child of children) {
			const got = await gather(workspaces, child, depth + 1, owed);
			if (got.status === "stop") return got;
			for (const row of got.rows) gathered.push(row);
			types ??= got.types;
			if (got.incomplete === true) whole = false;
		}
		return {
			status: "read",
			rows: gathered,
			...whole ? {} : { incomplete: true }
		};
	};
	for (const [at, group] of options.groups.entries()) {
		const got = await gather(group, void 0, 0, options.groups.length - at - 1);
		if (got.status === "stop") return {
			status: "none",
			outcome: got.outcome
		};
		for (const row of got.rows) rows.push(row);
		types ??= got.types;
		if (got.incomplete === true) short += 1;
	}
	const first = failed[0];
	if (first != null && short === options.groups.length && rows.length === 0) return {
		status: "none",
		outcome: first
	};
	return {
		status: "read",
		rows: resort(rows, options.order, types),
		...short === 0 ? {} : { shortfall: {
			read: options.groups.length - short,
			of: options.groups.length,
			why: [options.describe(failed), ...refusals].filter((why) => why !== "").join(" ")
		} }
	};
}
const UNDIVIDABLE = "One workspace returned more than an inline result can carry, and this statement declares no axis inside a workspace to divide it on, so that workspace is not included.";
const TOO_LARGE = "One workspace returned more than an inline result can carry even divided sixteen ways, so it is not fully included. This is an estate larger than this scan is built for; ask Databricks.";
function exhausted(limit) {
	return `Dividing this statement far enough to return the largest workspaces would have taken more than the ${String(limit)} warehouse executions one check is allowed, so the largest are not included.`;
}
/**
* What a partly-read statement is a statement about, in the words a reader gets verbatim.
*
* Kept next to the loop rather than in the collector's coverage function because the numbers and the
* sentence have to agree, and they are assembled a few lines apart here.
*
* In slices rather than workspaces, because slices are what failed: under the `MAX_SLICES` ceiling
* they are the same number, and above it a group is several workspaces and saying "workspaces" would
* be a count of the wrong thing.
*/
function describeShortfall(shortfall) {
	const missing = shortfall.of - shortfall.read;
	return `this statement is executed once per group of workspaces and ${String(missing)} of ${String(shortfall.of)} groups did not complete, so the counts here cover the ${String(shortfall.read)} that did and are lower than the estate's. Re-running the scan picks up the rest. ${shortfall.why}`;
}
//#endregion
export { collectSlices, describeShortfall, sliceGroups };
