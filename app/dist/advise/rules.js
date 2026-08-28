import { workloadRules } from "./workload-rules.js";
import { noStats } from "./stats-index.js";
import { failureRate } from "./ranking.js";
import { exchangeBoundaries, joinsIn, operatorsMatching, scansIn, skewIn, sortsIn, widest } from "./plan-metrics.js";
//#region server/advise/rules.ts
/**
* Every finding for one shape, in the order a reader should read them.
*
* Ordered by severity and then by the rule list's own order, which puts failure and the planner ahead of
* the volume rules. That is calibration's ordering rather than either document's: with `REFRESH`
* excluded there is no spill in the entire measured top twelve, and the findings that are actually
* there are failures, compilation share and serial execution.
*/
function findingsFor(row, ruleset = workloadRules(), plan, stats = noStats()) {
	return [...CONDITIONS.flatMap((condition) => {
		const rule = ruleset.rules.get(condition.id);
		if (rule == null) return [];
		const hit = condition.test(row, rule, plan, stats);
		return hit == null ? [] : [{
			rule: condition.id,
			shape: row.shape,
			...hit
		}];
	})].sort((a, b) => RANK[a.severity] - RANK[b.severity] || order(a.rule) - order(b.rule));
}
const RANK = {
	critical: 0,
	high: 1,
	medium: 2,
	info: 3
};
function order(id) {
	return CONDITIONS.findIndex((condition) => condition.id === id);
}
/**
* The conditions, in reading order.
*
* Deliberately not the order either design document lists them in. Both lead with the five volume rules,
* and calibration measured those firing on almost nothing once `REFRESH` is excluded — so leading with
* them here would put the rules that rarely fire above the ones that decide what the page looks like.
*/
const CONDITIONS = [
	{
		id: "FAILURE_RATE",
		test: (row, rule) => {
			const rate = failureRate(row);
			if (row.runsNow < rule.thresholds["min_runs"] || rate < rule.thresholds["failure_rate"]) return void 0;
			return {
				severity: rate >= rule.thresholds["critical_failure_rate"] ? "critical" : rule.severity,
				confidence: "high",
				evidence: [
					{
						label: "Runs that failed or were cancelled",
						value: row.failures,
						unit: "count"
					},
					{
						label: "Runs in the window",
						value: row.runsNow,
						unit: "count"
					},
					{
						label: "Failure rate",
						value: round(rate * 100, 1),
						unit: "percent"
					}
				]
			};
		}
	},
	{
		id: "COMPILATION_DOMINATED",
		test: (row, rule) => {
			const share = row.compilationPercent;
			if (share == null || row.measuredNow < rule.thresholds["min_runs"]) return void 0;
			if (share < rule.thresholds["compilation_percent"]) return void 0;
			return {
				severity: share >= rule.thresholds["critical_compilation_percent"] ? "critical" : rule.severity,
				confidence: "high",
				evidence: [
					{
						label: "Time spent compiling",
						value: share,
						unit: "percent"
					},
					{
						label: "Runs in the window",
						value: row.measuredNow,
						unit: "count"
					},
					{
						label: "Total time",
						value: row.msNow,
						unit: "ms"
					}
				]
			};
		}
	},
	{
		id: "SERIAL_EXECUTION",
		test: (row, rule) => {
			const parallelism = row.parallelism;
			if (parallelism == null || row.msNow < rule.thresholds["min_ms"]) return void 0;
			if (row.measuredNow < rule.thresholds["min_runs"]) return void 0;
			const mean = row.msNow / row.measuredNow;
			if (mean < rule.thresholds["mean_ms"]) return void 0;
			if (parallelism >= rule.thresholds["parallelism"]) return void 0;
			return {
				severity: rule.severity,
				confidence: "moderate",
				evidence: [
					{
						label: "Cores busy on average",
						value: parallelism,
						unit: "ratio"
					},
					{
						label: "Mean time per run",
						value: Math.round(mean),
						unit: "ms"
					},
					{
						label: "Total time",
						value: row.msNow,
						unit: "ms"
					}
				]
			};
		}
	},
	{
		id: "CAPACITY_WAIT",
		test: (row, rule) => {
			if (row.msNow <= 0 || row.queueMs < rule.thresholds["queue_ms"]) return void 0;
			const ratio = row.queueMs / row.msNow;
			if (ratio < rule.thresholds["queue_to_execution"]) return void 0;
			return {
				severity: ratio >= rule.thresholds["critical_queue_to_execution"] ? "high" : rule.severity,
				confidence: "high",
				evidence: [{
					label: "Time queued",
					value: row.queueMs,
					unit: "ms"
				}, {
					label: "Share of elapsed time queued",
					value: round(ratio * 100, 1),
					unit: "percent"
				}]
			};
		}
	},
	{
		id: "DATA_SPILL",
		test: (row, rule) => {
			if (row.spilledBytes < rule.thresholds["spill_bytes"]) return void 0;
			const ratio = row.readBytes > 0 ? row.spilledBytes / row.readBytes : void 0;
			if (ratio != null && ratio < rule.thresholds["spill_ratio"]) return void 0;
			return {
				severity: row.spilledBytes >= rule.thresholds["critical_spill_bytes"] ? "critical" : rule.severity,
				confidence: "high",
				evidence: [
					{
						label: "Spilled to disk",
						value: row.spilledBytes,
						unit: "bytes"
					},
					{
						label: "Read from storage",
						value: row.readBytes,
						unit: "bytes"
					},
					...ratio == null ? [] : [{
						label: "Spilled per byte read",
						value: round(ratio, 2),
						unit: "ratio"
					}]
				]
			};
		}
	},
	{
		id: "HIGH_SHUFFLE",
		test: (row, rule) => {
			if (row.readBytes <= 0 || row.shuffleBytes < rule.thresholds["shuffle_bytes"]) return void 0;
			const ratio = row.shuffleBytes / row.readBytes;
			if (ratio < rule.thresholds["shuffle_ratio"]) return void 0;
			return {
				severity: rule.severity,
				confidence: "moderate",
				evidence: [
					{
						label: "Shuffled between workers",
						value: row.shuffleBytes,
						unit: "bytes"
					},
					{
						label: "Read from storage",
						value: row.readBytes,
						unit: "bytes"
					},
					{
						label: "Shuffled per byte read",
						value: round(ratio, 2),
						unit: "ratio"
					}
				]
			};
		}
	},
	{
		id: "LOW_FILE_PRUNING",
		test: (row, rule) => {
			const pruned = row.prunedPercent;
			if (pruned == null || row.readFiles < rule.thresholds["min_read_files"]) return void 0;
			if (row.readBytes < rule.thresholds["min_read_bytes"]) return void 0;
			if (pruned >= rule.thresholds["pruned_percent"]) return void 0;
			return {
				severity: pruned <= rule.thresholds["critical_pruned_percent"] ? "high" : rule.severity,
				confidence: "moderate",
				evidence: [
					{
						label: "Files skipped",
						value: pruned,
						unit: "percent"
					},
					{
						label: "Files read",
						value: row.readFiles,
						unit: "count"
					},
					{
						label: "Read from storage",
						value: row.readBytes,
						unit: "bytes"
					}
				]
			};
		}
	},
	{
		id: "SMALL_FILES",
		test: (row, rule) => {
			if (row.readFiles < rule.thresholds["min_read_files"] || row.readBytes <= 0) return void 0;
			const mean = row.readBytes / row.readFiles;
			if (mean >= rule.thresholds["mean_file_bytes"]) return void 0;
			return {
				severity: rule.severity,
				confidence: "moderate",
				evidence: [
					{
						label: "Files read",
						value: row.readFiles,
						unit: "count"
					},
					{
						label: "Mean file size",
						value: Math.round(mean),
						unit: "bytes"
					},
					{
						label: "Read from storage",
						value: row.readBytes,
						unit: "bytes"
					}
				]
			};
		}
	},
	{
		/**
		* The one rule that reads the plan, and the only one whose input is a single execution.
		*
		* The tell is a tag, measured: `33ia` ran a Python UDF on labs and the plan carried
		* `UNKNOWN.PhotonScalarUDF`, the only one of the 26 distinct tags across five probes that matches
		* `UDF_TAG`. So on the plans measured this cannot fire on a projection, which was the risk — the design
		* document's phrasing is "a row-wise boundary where native SQL functions may exist", and a tell wide
		* enough to catch every row-wise boundary catches `PHOTON_PROJECT_EXEC` and fires on every query in the
		* estate.
		*
		* The `python` alternative in the pattern is an **assumption**, and the only one here: those five probes
		* ran on a Photon warehouse, so a non-Photon plan's spelling of the same operator is not measured.
		* `BatchEvalPython` and `ArrowEvalPython` are what Spark's own plans are expected to use. It cannot
		* false-positive on anything measured, and if the assumption is simply wrong the rule stays quiet on
		* classic compute rather than firing wrongly.
		*/
		id: "UDF_OR_PYTHON_BOUNDARY",
		test: (row, rule, plan) => {
			if (plan == null) return void 0;
			const udfs = operatorsMatching(plan.extract, UDF_TAG);
			if (udfs.length === 0) return void 0;
			if (row.msNow < rule.thresholds["min_ms"] || row.measuredNow < rule.thresholds["min_runs"]) return void 0;
			const duration = widest(udfs, "duration_ms");
			const rows = widest(udfs, "rows_num");
			return {
				severity: rule.severity,
				confidence: "moderate",
				evidence: [
					{
						label: "UDF steps in the plan",
						value: udfs.length,
						unit: "count"
					},
					...duration == null ? [] : [{
						label: "Longest time recorded on a UDF step",
						value: duration,
						unit: "ms"
					}],
					...rows == null ? [] : [{
						label: "Most rows recorded through a UDF step",
						value: rows,
						unit: "count"
					}],
					{
						label: "Total time",
						value: row.msNow,
						unit: "ms"
					}
				]
			};
		}
	},
	{
		/**
		* Many shuffle boundaries in a shape that costs real time.
		*
		* The count is `33id`'s measured reading rather than a count of exchange-named tags, and that difference
		* decides whether the design document's eight is the right number: Photon renders one boundary as two
		* operators, so tags double every plan and a threshold of eight fires on a plan with five boundaries.
		* `exchangeBoundaries` folds the pair and records why.
		*
		* The duration half is restated rather than ported, and this is the one judgement in the row.
		* Line 978's condition is one execution over a minute; the plan here *is* one execution, but every other
		* number on the row is the window's, and `33id` measured that on labs the shape whose representative ran
		* for 74 seconds has two boundaries while the three plans with eight or more have their longest run at 6,
		* 12 and 36 seconds. So a per-execution minute would report nothing and say nothing about whether the rule
		* works. The floor is the window total instead — the same one `UDF_OR_PYTHON_BOUNDARY` uses, for the same
		* reason, which the ruleset states: a rewrite pays back per run, so a 6-second shape run 51 times is
		* exactly the case where removing a repartition is worth the work.
		*/
		id: "EXCESSIVE_EXCHANGES",
		test: (row, rule, plan) => {
			if (plan == null) return void 0;
			const { boundaries, unrecognisedExchanges } = exchangeBoundaries(plan.extract);
			if (boundaries < rule.thresholds["exchanges"]) return void 0;
			if (row.msNow < rule.thresholds["min_ms"] || row.measuredNow < rule.thresholds["min_runs"]) return void 0;
			return {
				severity: rule.severity,
				confidence: "moderate",
				evidence: [
					{
						label: "Shuffle boundaries in the plan",
						value: boundaries,
						unit: "count"
					},
					{
						label: "Steps in the plan",
						value: plan.extract.operatorCount,
						unit: "count"
					},
					...unrecognisedExchanges === 0 ? [] : [{
						label: "Exchange steps not counted as boundaries",
						value: unrecognisedExchanges,
						unit: "count"
					}],
					{
						label: "Total time",
						value: row.msNow,
						unit: "ms"
					},
					{
						label: "Runs in the window",
						value: row.measuredNow,
						unit: "count"
					}
				]
			};
		}
	},
	{
		/**
		* A sort of many rows with nothing after it that reduces them.
		*
		* The graph half is the whole of what the design document asks for — "expensive sort with no obvious
		* limiting/filtering reduction" — and `33id` measured that on its own it is a census rather than a
		* finding: 14 of 36 plans contain a sort, and not one of the 14 has a limiting operator after it. Part of
		* that is Photon's planning rather than the estate's queries, because an `ORDER BY … LIMIT` becomes a
		* top-k carrying no sort operator at all, so the sorts that remain are the ones the planner could not
		* reduce. Either way the graph condition alone selects every sort there is.
		*
		* So the size decides, and `rows_num` is the only size the response carries here. `33id` measured
		* `peak_memory_bytes` taking exactly two values across all 14 sorts — 28 MiB on twelve, 26 MiB on two —
		* while their rows ran from 2 to 17,010, and the widest sort read the *smaller* of the two values. No byte
		* threshold separates them. Spill was zero on all 14, so that cannot narrow them either.
		*/
		id: "LARGE_SORT",
		test: (row, rule, plan) => {
			if (plan == null) return void 0;
			const sorts = sortsIn(plan.extract);
			if (sorts == null) return void 0;
			const unreduced = sorts.filter((sort) => sort.downstream > 0 && !sort.limitedDownstream);
			const rows = widest(unreduced.map((sort) => sort.operator), "rows_num");
			if (rows == null || rows < rule.thresholds["sort_rows"]) return void 0;
			if (row.msNow < rule.thresholds["min_ms"] || row.measuredNow < rule.thresholds["min_runs"]) return void 0;
			return {
				severity: rule.severity,
				confidence: "low",
				evidence: [
					{
						label: "Most rows recorded through an unreduced sort",
						value: rows,
						unit: "count"
					},
					{
						label: "Sorts with nothing reducing them",
						value: unreduced.length,
						unit: "count"
					},
					{
						label: "Sorts in the plan",
						value: sorts.length,
						unit: "count"
					},
					{
						label: "Total time",
						value: row.msNow,
						unit: "ms"
					}
				]
			};
		}
	},
	{
		/**
		* Adaptive execution reporting that it found skewed partitions.
		*
		* The trigger is a counter rather than a ratio, and `33id` measured why that is the whole of this rule's
		* design. Of the nine skew-named metrics in the vocabulary, `MapStage - Skew num skewed partitions` and
		* `MapStage - Skew skewed data size ratio` are carried by the same 27 of 36 plans and read **zero on all 60
		* operators** of them. The max-to-median partition ratio the design document offers as a screening value is
		* non-zero on 23 of those 27 with a p90 of 4, so a rule wired to it above zero reports skew on most of the
		* estate, and one wired to the document's 10 selects a single plan on a corpus whose ordinary reading is 1
		* to 4. Line 1017's instruction — never tell a customer skew exists from a `SortMergeJoin` alone — is about
		* exactly this distance between a signal and a finding.
		*
		* So the counter fires and the ratio is reported. `skewIn` says what "reported" means and what silence
		* means, and the two are not the same: no operator carrying the counter is a plan the platform said nothing
		* about, which on `33id`'s corpus was mostly a plan with nothing to shuffle.
		*
		* No duration floor, and that is a departure from the two rules above it. Theirs exist because their
		* triggers fire on ordinary work and somebody has to triage the result; this trigger read zero on every
		* operator of every plan in the corpus, so a cost floor could only silence a true positive on a cheap
		* shape. The ruleset carries `skewed_partitions` instead, which is the number to tune if that turns out to
		* be wrong on a larger estate.
		*/
		id: "DATA_SKEW",
		test: (row, rule, plan) => {
			if (plan == null) return void 0;
			const skew = skewIn(plan.extract);
			if (skew == null) return void 0;
			if (skew.worstPartitions < rule.thresholds["skewed_partitions"]) return void 0;
			return {
				severity: rule.severity,
				confidence: "moderate",
				evidence: [
					{
						label: "Most skewed partitions reported on any one step",
						value: skew.worstPartitions,
						unit: "count"
					},
					{
						label: "Steps reporting skewed partitions",
						value: skew.reporting,
						unit: "count"
					},
					{
						label: "Steps where the platform reported a skew count",
						value: skew.carrying,
						unit: "count"
					},
					...skew.worstMaxToMedian == null ? [] : [{
						label: "Widest ratio of largest partition to median, on any one step",
						value: round(skew.worstMaxToMedian, 2),
						unit: "multiple"
					}],
					{
						label: "Total time",
						value: row.msNow,
						unit: "ms"
					}
				]
			};
		}
	},
	{
		/**
		* A join that does not broadcast, one of whose sides is narrow.
		*
		* `33ifb` measured this rule's premise and every part of it came back short, so what is here is narrower
		* than the design document's line and says so in three places.
		*
		* **It reads rows, not bytes.** The condition as specified is a side "small enough to broadcast", which is a
		* byte size. Of the three metrics a plan carries that name a size, `33ifb` measured `Aggressive BHJ
		* Extrapolated Size` and `Aggressive BHJ Decision` as zero on all eleven joins that carried them, and
		* `Hashed relation size` as an *allocation* rather than a size: four distinct values over eleven joins,
		* moving the wrong way against the rows, so a 3,003-row join reports 4,325,376 and a 9-row join reports
		* 8,519,680. No byte threshold separates them. The one size that exists anywhere near a join is the row
		* count on its inputs, present on 26 of 26 of them.
		*
		* **Its threshold is an assumption.** All 13 joins in that corpus already broadcast, so the population this
		* rule is about is empty there: nothing to calibrate against and no false positive to observe. The ruleset
		* states the arithmetic behind the number and marks it.
		*
		* **It declines on a join that already broadcasts.** `EXCESSIVE_EXCHANGES` leaves a broadcast exchange out
		* of its boundary count on the reasoning that a broadcast is what this rule recommends, and a finding here
		* on a join that took the advice would be the same defect from the other end. `joinsIn` reads the tell from
		* the algorithm and from the tag, so an extract whose meta is unreadable is refused rather than read as
		* naming no algorithm.
		*/
		id: "BROADCAST_CANDIDATE",
		test: (row, rule, plan) => {
			if (plan == null) return void 0;
			const joins = joinsIn(plan.extract);
			if (joins == null) return void 0;
			const candidates = joins.filter((join) => !join.broadcast && join.inputs.length >= 2 && join.narrowestInputRows != null && join.narrowestInputRows <= rule.thresholds["build_side_rows"]);
			const narrowest = candidates.reduce((least, join) => least == null || (join.narrowestInputRows ?? 0) < least ? join.narrowestInputRows : least, void 0);
			if (narrowest == null) return void 0;
			if (row.msNow < rule.thresholds["min_ms"] || row.measuredNow < rule.thresholds["min_runs"]) return void 0;
			return {
				severity: rule.severity,
				confidence: "low",
				evidence: [
					{
						label: "Fewest rows on a side of a join that does not broadcast",
						value: narrowest,
						unit: "count"
					},
					{
						label: "Joins that do not broadcast and have a narrow side",
						value: candidates.length,
						unit: "count"
					},
					{
						label: "Joins in the plan",
						value: joins.length,
						unit: "count"
					},
					{
						label: "Total time",
						value: row.msNow,
						unit: "ms"
					}
				]
			};
		}
	},
	{
		/**
		* A table this shape scans that was written after its statistics were last computed.
		*
		* The design document's rule is `MISSING_OR_STALE_STATS` and this answers the second half of its own name.
		* `33iga` measured why, and the reason is not a shortcut:
		*
		* **Missing is not observable.** A table with no ANALYZE record is indistinguishable from a table
		* predictive optimization has not reached. `DESCRIBE EXTENDED`, which the design document names, reports a
		* `Statistics` row on tables nothing has ever analysed — 7 of the 11 that carried one in that measurement
		* — because the row is the Delta log's own size estimate rather than a statistics record. So a rule firing
		* on absence would be reporting the collector's blind spot as the estate's problem, and a *miss* in the
		* index is read as unknown here rather than as a finding.
		*
		* **Its silence therefore has two meanings**, which is unusual among these rules and is why the ruleset's
		* words say so: either nothing this shape scans is stale, or nothing analysed it and there was nothing to
		* compare. The evidence carries both counts so the reader can tell which.
		*
		* **The gap is signed and only a positive one is a finding.** 33 of the 34 analysed tables on labs were
		* last written *before* their statistics were computed, which is predictive optimization working. A rule
		* on the absolute gap would fire on all of them.
		*/
		id: "MISSING_OR_STALE_STATS",
		test: (row, rule, plan, stats) => {
			if (plan == null) return void 0;
			const scanned = scansIn(plan.extract);
			if (scanned == null) return void 0;
			const known = [...new Set(scanned.map((table) => table.toLowerCase()))].flatMap((table) => {
				const reading = stats.for(table);
				return reading == null ? [] : [reading];
			});
			const stale = known.filter((reading) => reading.hoursWrittenAfterAnalyse != null && reading.hoursWrittenAfterAnalyse >= rule.thresholds["stale_hours"]);
			const worstHours = stale.reduce((most, reading) => most == null || (reading.hoursWrittenAfterAnalyse ?? 0) > most ? reading.hoursWrittenAfterAnalyse : most, void 0);
			if (worstHours == null) return void 0;
			if (row.msNow < rule.thresholds["min_ms"] || row.measuredNow < rule.thresholds["min_runs"]) return void 0;
			return {
				severity: rule.severity,
				confidence: "low",
				evidence: [
					{
						label: "Longest a table went from analysed to written",
						value: Math.round(worstHours * 36e5),
						unit: "ms"
					},
					{
						label: "Tables scanned and written since analysed",
						value: stale.length,
						unit: "count"
					},
					{
						label: "Tables scanned that anything analysed",
						value: known.length,
						unit: "count"
					},
					{
						label: "Writes recorded since",
						value: stale.reduce((total, reading) => total + (reading.writeEvents ?? 0), 0),
						unit: "count"
					},
					{
						label: "Total time",
						value: row.msNow,
						unit: "ms"
					}
				]
			};
		}
	},
	{
		id: "CACHE_HIT",
		test: (row, rule) => {
			if (row.runsNow < rule.thresholds["min_runs"]) return void 0;
			const rate = row.cacheHits / row.runsNow;
			if (rate < rule.thresholds["cache_rate"]) return void 0;
			return {
				severity: rule.severity,
				confidence: "high",
				evidence: [
					{
						label: "Runs served from cache",
						value: row.cacheHits,
						unit: "count"
					},
					{
						label: "Runs in the window",
						value: row.runsNow,
						unit: "count"
					},
					{
						label: "Share served from cache",
						value: round(rate * 100, 1),
						unit: "percent"
					}
				]
			};
		}
	}
];
/**
* What a UDF operator's tag looks like.
*
* Deliberately two words rather than a list of exact tags. `UNKNOWN.PhotonScalarUDF` is the measured one, and
* an exact match on it would miss the vectorised and aggregate spellings of the same boundary — which are an
* assumption about naming rather than a measurement, since no probe produced one. A pattern over the whole tag
* would risk a projection.
*
* That it does not match a projection is not left to this comment: `rules.test.ts` reads the tag vocabulary out
* of `33ia`'s committed recording and asserts this pattern matches one of the 26, which fails the day somebody
* widens it. Exported for that test and for nothing else.
*
* It matches more kinds of operator than one sentence can describe, and that bounds what the ruleset's words
* may say: a scalar UDF is row-at-a-time and a vectorised one is not, so the detail describes both rather than
* asserting the first of a tag that may be either.
*/
const UDF_TAG = /udf|python/i;
function round(value, places) {
	const factor = 10 ** places;
	return Math.round(value * factor) / factor;
}
//#endregion
export { UDF_TAG, findingsFor };
