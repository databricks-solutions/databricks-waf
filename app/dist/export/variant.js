//#region server/export/variant.ts
/**
* The four, in the order a reader meets them.
*
* Executive first because it is the one somebody sends upwards, technical second because it is the
* complete file and the default, then the two specialist ones.
*/
const EXPORT_VARIANTS = [
	"executive",
	"technical",
	"improvement",
	"audit"
];
/**
* What a request with no variant gets.
*
* The complete file, so a caller who does not know variants exist is never handed a subset. Every
* export link this app published before variants did resolves to exactly the same document, which is
* what stops a deploy changing what an existing runbook downloads.
*/
const DEFAULT_VARIANT = "technical";
/** Every column any variant can carry, in the order a row is written. */
const EXPORT_COLUMNS = [
	"run",
	"variant",
	"ran_at",
	"ran_as",
	"ran_with",
	"started_by",
	"methodology_version",
	"methodology_state",
	"methodology_manifest",
	"methodology_effective_date",
	"catalogue_revision",
	"review",
	"app_build",
	"scoring_method",
	"pillar",
	"requirement",
	"title",
	"outcome",
	"severity",
	"reason",
	"observed",
	"expected",
	"coverage",
	"evidence",
	"why_unmeasured",
	"next_step",
	"answered_by",
	"answered_at",
	"answer_review_by",
	"accountable",
	"decision_id",
	"decision",
	"decision_standing",
	"decision_reason",
	"decided_by",
	"decided_at",
	"decision_owner",
	"decision_date",
	"applicability",
	"applicability_id",
	"applicability_owner",
	"applicability_reason",
	"read_as",
	"collected_at",
	"documentation",
	"where"
];
/** The columns every variant carries: which run, which document, which requirement, what the verdict was. */
const IDENTITY = [
	"run",
	"variant",
	"ran_at",
	"methodology_version",
	"methodology_state",
	"methodology_manifest",
	"methodology_effective_date",
	"catalogue_revision"
];
const VERDICT = [
	"pillar",
	"requirement",
	"title",
	"outcome",
	"severity"
];
/**
* What each variant is.
*
* The column lists are written out rather than composed from differences, so a review of this file
* answers "what does an auditor get that an engineer does not" by reading two lists instead of
* resolving three spreads.
*/
const VARIANT_SHAPES = {
	executive: {
		says: "For a reader who is deciding what to do about the estate rather than working on it: the verdict on every requirement, how much of the estate was looked at, and whether somebody has already taken a decision about it.",
		omits: "It carries every requirement and not every column: what was read, who read it and the pages that fix it are in the technical export of the same run.",
		columns: [
			...IDENTITY,
			"review",
			...VERDICT,
			"reason",
			"coverage",
			"why_unmeasured",
			"next_step",
			"applicability",
			"applicability_owner",
			"decision",
			"decision_standing",
			"decision_owner"
		],
		detail: "verdict",
		produced: false
	},
	technical: {
		says: "The complete file: every requirement, everything read to judge it, whose permissions it was read with, and what has been decided about it.",
		columns: [...EXPORT_COLUMNS].filter((column) => column !== "app_build" && column !== "scoring_method" && column !== "answer_review_by" && column !== "decision_id" && column !== "applicability_id"),
		detail: "full",
		produced: false
	},
	improvement: {
		says: "For whoever is doing the work: what each requirement needs, the page it is on, and who has taken it on with what date against it.",
		omits: "It carries every requirement and not every column: the provenance of each reading is in the technical export of the same run.",
		columns: [
			...IDENTITY,
			...VERDICT,
			"observed",
			"coverage",
			"why_unmeasured",
			"next_step",
			"documentation",
			"where",
			"applicability",
			"applicability_owner",
			"applicability_reason",
			"decision",
			"decision_standing",
			"decision_reason",
			"decision_owner",
			"decision_date",
			"answered_by",
			"accountable"
		],
		detail: "work",
		produced: false
	},
	audit: {
		says: "For a reader establishing that the assessment can be relied on: everything the technical file carries, plus what produced the run — the build, the scoring method, the encoding and the surfaces that answered — and the identifier of the two kinds of decision this file carries, the disposition on a finding and the applicability decision on the denominator, and the date every human answer stops counting.",
		columns: [...EXPORT_COLUMNS],
		detail: "full",
		produced: true
	}
};
/**
* The variant a request asked for, or nothing when it named something this app does not produce.
*
* Refused rather than defaulted. A caller who asks for `?variant=summary` and is handed the technical
* file has been given a document they will describe to somebody else as a summary, and the mistake
* surfaces in the meeting where the two do not match. `undefined` for an absent parameter is the
* caller not asking, which is the default above.
*/
function variantOf(asked) {
	if (asked == null || asked === "") return DEFAULT_VARIANT;
	return EXPORT_VARIANTS.find((variant) => variant === asked);
}
/**
* Whether this finding's evidence prose belongs in the file.
*
* A `verdict` file carries the reason and not the readings: the reason is this app's sentence about
* the requirement, and the readings are estate detail — table names, workspace names, counts — which
* is both what makes the technical file useful and what makes a board paper unreadable.
*/
function carriesEvidence(detail) {
	return detail !== "verdict";
}
/** Whether the file says who took each reading and from where. The complete file and the audit package. */
function carriesProvenance(detail) {
	return detail === "full";
}
//#endregion
export { DEFAULT_VARIANT, EXPORT_COLUMNS, EXPORT_VARIANTS, VARIANT_SHAPES, carriesEvidence, carriesProvenance, variantOf };
