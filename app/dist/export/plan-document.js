import { csv } from "./csv.js";
const PLAN_DOCUMENT_KIND = "databricks-waf-improvement-plan";
/**
* The three, in the order a reader meets them.
*
* `delivery` rather than `technical`, which is the assessment's word for its complete file: there is
* nothing technical about a plan, and the person who wants every column is the one running the work.
*/
const PLAN_VARIANTS = [
	"executive",
	"delivery",
	"audit"
];
/** What a request with no variant gets: the complete file, so a caller is never handed a subset unasked. */
const DEFAULT_PLAN_VARIANT = "delivery";
/**
* Every column any variant can carry, in the order a row is written.
*
* The plan's own columns repeat on every row, like the run's do in an assessment export and for the
* same reason: a spreadsheet has no header block, and a reader who has filtered to the four actions
* one owner holds has to still be looking at four complete statements.
*
* `PLAN_IDENTITY` has to stay a genuine prefix of this list, which is why `plan_state` sits third
* rather than after the two it reads best beside. Every variant filters this order and none reorders
* it, so the executive and delivery files of one plan differ only in which columns are present —
* somebody diffing the two sees the real difference rather than a shuffle. `variant.ts` holds the
* assessment export to the same rule and for the same reason.
*/
const PLAN_COLUMNS = [
	"plan",
	"plan_variant",
	"plan_title",
	"plan_state",
	"plan_outcome",
	"plan_owners",
	"baseline_run",
	"assessment",
	"judged_against",
	"judged_at",
	"action",
	"requirements",
	"requirement_titles",
	"action_outcome",
	"definition_of_done",
	"owner",
	"priority",
	"effort",
	"due",
	"state",
	"agreement",
	"agreement_means",
	"unmet",
	"unreadable",
	"depends_on",
	"steps",
	"raised_from",
	"created_by",
	"created_at",
	"history"
];
/**
* What each variant is.
*
* Written out rather than composed from differences, for the reason `variant.ts` gives: a review of
* this file should answer "what does an auditor get that a delivery lead does not" by reading two
* lists rather than resolving three spreads.
*/
const PLAN_VARIANT_SHAPES = {
	executive: {
		says: "For the reader who asked what is being done about the assessment: what the plan is for, who is answerable for it, and for every action the outcome it buys, who owns it, when it is expected and whether the estate agrees it happened.",
		omits: "It carries every action and not every column: the steps, the dependencies between actions, the effort estimate, who raised each action and from which run, and the history of who moved what are in the delivery and audit exports of the same plan.",
		columns: [
			...[
				"plan",
				"plan_variant",
				"plan_title",
				"plan_state"
			],
			"plan_outcome",
			"plan_owners",
			"judged_against",
			"judged_at",
			"action",
			"requirements",
			"requirement_titles",
			"action_outcome",
			"definition_of_done",
			"owner",
			"priority",
			"due",
			"state",
			"agreement",
			"agreement_means",
			"unmet",
			"unreadable"
		],
		history: false
	},
	delivery: {
		says: "The complete file for whoever is running the work: every action, what would have to be true for it to be finished, the steps, what it waits on, and what the last run made of the claim.",
		columns: [...PLAN_COLUMNS].filter((column) => column !== "history"),
		history: false
	},
	audit: {
		says: "For a reader establishing later that the work happened: everything the delivery file carries, plus every state each action has been in, who moved it, when, and why — which is what shows a claim was made before a run agreed with it rather than after.",
		columns: [...PLAN_COLUMNS],
		history: true
	}
};
/**
* The variant a request asked for, or nothing when it named something this app does not produce.
*
* Refused rather than defaulted, exactly as `variantOf` refuses for an assessment: a caller who asks
* for `?variant=summary` and is handed the complete file has been given a document they will describe
* to somebody else as a summary, and the mistake surfaces in the meeting where the two do not match.
*/
function planVariantOf(asked) {
	if (asked == null || asked === "") return DEFAULT_PLAN_VARIANT;
	return PLAN_VARIANTS.find((variant) => variant === asked);
}
/**
* What each agreement means, spelled out.
*
* The same judgement `document.ts` makes about its decision words: `contradicted` is the reason these
* columns are in the file at all, and a spreadsheet cell reading "contradicted" beside an action
* somebody reported finished would need explaining to whoever reads the sheet next.
*/
const AGREEMENT = {
	unclaimed: "nobody has said this is done yet",
	awaiting: "reported done, no run has measured it since",
	agreed: "a run measured every requirement as met after it was reported done",
	contradicted: "reported done, and a later run still finds a requirement unmet",
	unmeasured: "reported done, nothing is failing, and at least one requirement could not be read",
	unjudged: "raised from advisor advice, so no requirement in the framework can agree or disagree with it"
};
/**
* The same column for an action no requirement can answer, and the reason there are two maps.
*
* Every sentence above names a run and a requirement. An action raised from advisor advice has
* neither: it is settled by a later advisory no longer reporting one rule on one resource, which is
* `advice-settle.ts`. Exporting the assessment's wording against it would put "a run measured every
* requirement as met" in a spreadsheet cell beside an action that names no requirement and that no run
* read — the sentence saying more than the field, in the one artefact a reader keeps.
*
* `unclaimed` and `unjudged` are the same under either judge and are still written out: the exhaustive
* record is what makes a new agreement state fail this file rather than silently take the other map's
* word for it.
*/
const ADVISED_AGREEMENT = {
	unclaimed: "nobody has said this is done yet",
	awaiting: "reported done, no advisory has read the estate since",
	agreed: "an advisory after it was reported done read the resource and did not report the rule it came from",
	contradicted: "reported done, and a later advisory still reports the same rule on the same resource",
	unmeasured: "reported done, and the latest advisory could not speak to it — it did not report the resource, formed no analysis, or this build no longer carries the rule",
	unjudged: "raised from advisor advice, so no requirement in the framework can agree or disagree with it"
};
/**
* Which of the two an action's row is written in: the requirements it names, and nothing else.
*
* The same discriminator `progress.ts` computes the agreement with and the client words the pane with.
* An action carrying advice *and* a requirement is the assessment's, so it gets the assessment's
* sentence here too.
*/
function agreementMeans(reading) {
	return reading.action.controlIds.length === 0 ? ADVISED_AGREEMENT[reading.agreement] : AGREEMENT[reading.agreement];
}
/**
* The plan as structured data, for a reader who is going to diff two of them or feed a tracker.
*
* No `generatedAt`, and that absence is the point rather than an omission — it is the field that made
* assessment exports unverifiable until version 2 removed it, and repeating the mistake in a second
* document would be repeating it knowingly. ADR 0050.
*/
function planDocument(options) {
	const { plan, progress } = options;
	const variant = options.variant ?? "delivery";
	const shape = PLAN_VARIANT_SHAPES[variant];
	return {
		document: PLAN_DOCUMENT_KIND,
		documentVersion: 1,
		variant,
		variantMeans: shape.says,
		...shape.omits != null ? { variantOmits: shape.omits } : {},
		plan: {
			id: plan.id,
			title: plan.title,
			outcome: plan.outcome,
			owners: plan.owners,
			state: plan.closed != null ? "closed" : "open",
			revision: plan.revision,
			createdBy: plan.createdBy,
			createdAt: plan.createdAt.toISOString(),
			...plan.raisedFrom != null ? { baselineRun: plan.raisedFrom } : {},
			...plan.assessment != null ? { assessment: plan.assessment } : {},
			...plan.closed != null ? { closed: {
				at: plan.closed.at.toISOString(),
				by: plan.closed.by,
				reason: plan.closed.reason
			} } : {}
		},
		progress: {
			states: progress.states,
			contradicted: progress.contradicted,
			blocked: progress.blocked,
			settled: progress.settled,
			...progress.nextDue != null ? { nextDue: progress.nextDue.toISOString() } : {}
		},
		...options.judgedAgainst != null ? { judgedAgainst: {
			run: options.judgedAgainst.runId,
			at: options.judgedAgainst.at.toISOString()
		} } : {},
		actions: options.actions.map((reading) => actionField(reading, options, shape))
	};
}
function actionField(reading, options, shape) {
	const { action } = reading;
	const carries = (column) => shape.columns.includes(column);
	return {
		id: action.id,
		requirements: action.controlIds.map((id) => {
			const title = options.titleOf(id);
			return title != null ? {
				id,
				title
			} : { id };
		}),
		outcome: action.outcome,
		...carries("definition_of_done") ? { definitionOfDone: action.definitionOfDone } : {},
		owner: action.owner,
		priority: action.priority,
		...carries("effort") ? { effort: action.effort } : {},
		...action.due != null ? { due: action.due.toISOString() } : {},
		state: action.state,
		agreement: reading.agreement,
		agreementMeans: agreementMeans(reading),
		unmet: reading.unmet,
		...carries("unreadable") ? { unreadable: reading.unreadable } : {},
		...carries("depends_on") ? { dependsOn: action.dependsOn } : {},
		...carries("steps") ? { steps: action.steps } : {},
		...carries("raised_from") && action.raisedFrom != null ? { raisedFrom: action.raisedFrom } : {},
		...carries("created_by") ? {
			createdBy: action.createdBy,
			createdAt: action.createdAt.toISOString()
		} : {},
		...shape.history ? { history: action.history.map((entry) => ({
			from: entry.from,
			to: entry.to,
			at: entry.at.toISOString(),
			by: entry.by,
			who: entry.who,
			...entry.reason != null ? { reason: entry.reason } : {}
		})) } : {}
	};
}
/** The plan as a spreadsheet: the columns the variant carries, and one row per action. */
function planCsv(options) {
	return csv(planRows(options));
}
function planRows(options) {
	const variant = options.variant ?? "delivery";
	const { columns } = PLAN_VARIANT_SHAPES[variant];
	const header = columns.map((column) => column);
	const row = (reading) => columns.map((column) => CELL[column]({
		options,
		variant,
		reading
	}));
	if (options.actions.length === 0) return [header, row()];
	return [header, ...options.actions.map((reading) => row(reading))];
}
/**
* Every column, and what it writes. A record rather than a switch, and that is a correctness matter.
*
* `document.ts` keys its cells the same way and the reason is the one that bit here: two switches with
* `default` clauses type-check against a column list they do not cover, so adding a name to
* `PLAN_COLUMNS` compiled, shipped, and wrote a blank column into a document whose entire value is that
* a reader can trust what is in it. A blank column is worse than a missing one — the reader concludes
* the plan has no owner rather than that the file has no answer. Keyed on `PlanColumn`, the typecheck
* refuses the new column until somebody says what it holds.
*/
const CELL = {
	plan: ({ options }) => options.plan.id,
	plan_variant: ({ variant }) => variant,
	plan_title: ({ options }) => options.plan.title,
	plan_state: ({ options }) => options.plan.closed != null ? `closed ${options.plan.closed.at.toISOString().slice(0, 10)}` : options.progress.settled ? "open, every action settled" : "open",
	plan_outcome: ({ options }) => options.plan.outcome,
	plan_owners: ({ options }) => options.plan.owners.join(" "),
	baseline_run: ({ options }) => options.plan.raisedFrom ?? "",
	assessment: ({ options }) => options.plan.assessment != null ? `${options.plan.assessment.definitionId} v${String(options.plan.assessment.version)}` : "",
	judged_against: ({ options }) => options.judgedAgainst?.runId ?? "no run has measured this estate",
	judged_at: ({ options }) => options.judgedAgainst?.at.toISOString() ?? "",
	action: ({ reading }) => reading?.action.id ?? "",
	requirements: ({ reading }) => reading?.action.controlIds.join(" ") ?? "",
	requirement_titles: ({ reading, options }) => reading?.action.controlIds.map((id) => options.titleOf(id) ?? id).join("; ") ?? "",
	action_outcome: ({ reading }) => reading?.action.outcome ?? "",
	definition_of_done: ({ reading }) => reading?.action.definitionOfDone ?? "",
	owner: ({ reading }) => reading?.action.owner ?? "",
	priority: ({ reading }) => reading?.action.priority ?? "",
	effort: ({ reading }) => reading?.action.effort ?? "",
	due: ({ reading }) => reading?.action.due?.toISOString().slice(0, 10) ?? "",
	state: ({ reading }) => reading?.action.state ?? "",
	agreement: ({ reading }) => reading?.agreement ?? "",
	agreement_means: ({ reading }) => reading != null ? agreementMeans(reading) : "",
	unmet: ({ reading }) => reading?.unmet.join(" ") ?? "",
	unreadable: ({ reading }) => reading?.unreadable.join(" ") ?? "",
	depends_on: ({ reading }) => reading?.action.dependsOn.join(" ") ?? "",
	steps: ({ reading }) => reading?.action.steps.join("\n") ?? "",
	raised_from: ({ reading }) => reading?.action.raisedFrom ?? "",
	created_by: ({ reading }) => reading?.action.createdBy ?? "",
	created_at: ({ reading }) => reading?.action.createdAt.toISOString() ?? "",
	history: ({ reading }) => reading?.action.history.map(transitionLine).join("\n") ?? ""
};
/**
* One state change, in a form somebody can read down a column.
*
* `by` is written as a word rather than left implicit, because the one move a run makes is the one a
* reader is checking for: an action marked verified by a person would be the lifecycle's central rule
* broken, and a cell that only named the actor would leave a scan id looking like an unfamiliar
* colleague. An advisory id reads the same way, and names the other thing that can verify.
*/
function transitionLine(entry) {
	const who = AUTHOR[entry.by] == null ? entry.who : `${AUTHOR[entry.by]} ${entry.who}`;
	const reason = entry.reason != null ? ` — ${entry.reason}` : "";
	return `${entry.at.toISOString()} ${entry.from} → ${entry.to} by ${who}${reason}`;
}
/** What to call the id, where the id is a run of something rather than a person. */
const AUTHOR = {
	run: "run",
	advisor: "advisory"
};
/**
* The name it is offered under: the plan and the variant, and deliberately no version.
*
* This is where a plan departs from an assessment, and the reason is worth stating because the obvious
* design is wrong twice.
*
* `exportName` puts the run's day and id in the filename, and can, because a finished run is immutable:
* the name identifies the document. A plan has no equivalent. Its own `revision` does not move when its
* actions do — only closing it raises that number — so a filename carrying it would be a version that
* stayed at `r0` across a fortnight of work, which is worse than no version at all.
*
* The second reason is the one that settles it. `taken` compares a recorded digest against what a file
* of the same name would hash to now, and that is how a sender answers a recipient who says the copy
* they were sent does not match. A name that changed on every download would never recur, so every
* recorded export would read as a file this build can no longer produce, and the comparison — the whole
* point of publishing digests for a document that moves — would never fire.
*
* So two downloads of one plan share a name and may differ in bytes. Which version the published
* digests describe is answered by `revision` on the exports payload, where a reader can see it beside
* the values rather than having to parse a filename.
*/
function planExportName(plan, extension, variant = DEFAULT_PLAN_VARIANT) {
	const which = variant === "delivery" ? "" : `-${variant}`;
	return `improvement-plan-${plan.id.slice(0, 8)}${which}.${extension}`;
}
//#endregion
export { DEFAULT_PLAN_VARIANT, PLAN_COLUMNS, PLAN_DOCUMENT_KIND, PLAN_VARIANTS, PLAN_VARIANT_SHAPES, planCsv, planDocument, planExportName, planVariantOf };
