//#region server/attest/capped-questions.ts
/** Half-yearly, like the delivery practices the inconclusive table asks about. */
const HALF_YEARLY = 180;
/** Quarterly, for what tracks tooling and capacity, which change on the timescale of a project. */
const QUARTERLY = 90;
const AS_CODE = "The scan found asset-bundle deployments, and Databricks records `deployment.kind = BUNDLE` on the jobs they deploy. That shows a deployment pipeline exists for those jobs. It cannot show that the rest is covered: the Terraform provider writes jobs through the same API a person uses and leaves no marker, and the pipelines, clusters and warehouses beside the jobs leave none either. An answer of \"met\" lifts the measured partial to a pass. Any other answer is recorded beside the measurement and leaves it as it is.";
const CAPPED_QUESTIONS = {
	"OE-02-01": {
		question: "Are your jobs, pipelines and compute defined in version-controlled code and deployed by a pipeline, with nothing in production created or edited by hand in the workspace?",
		evidence: "The repository holding the definitions, and the CI job that deploys them. If you use Terraform, name the state backend; if asset bundles, the bundle root. What matters is that a change goes through review before it reaches the workspace.",
		whyAsked: AS_CODE,
		cadenceDays: HALF_YEARLY
	},
	"OE-01-02": {
		question: "Is all production code in enterprise source control, with no production logic that exists only in a workspace notebook?",
		evidence: "The repository holding the notebooks and job definitions that run in production, and how a change to one reaches the workspace. A notebook edited in place and never committed is the case this asks about.",
		whyAsked: AS_CODE,
		cadenceDays: HALF_YEARLY
	},
	"IU-01-05": {
		question: "Are your jobs, pipelines and compute defined in version-controlled code and deployed by a pipeline, rather than created and edited in the workspace UI?",
		evidence: "The repository holding the definitions, and the CI job that deploys them. If you use Terraform, name the state backend; if asset bundles, the bundle root.",
		whyAsked: AS_CODE,
		cadenceDays: HALF_YEARLY
	},
	"OE-01-04": {
		question: "Does every model reach production through one defined process, with evaluation gates, a promotion path and a review step that are enforced rather than followed by habit?",
		evidence: "The runbook or pipeline definition that takes a model from experiment to a served endpoint, and where the evaluation and approval steps are recorded.",
		whyAsked: "The scan found MLOps tooling in use — custom models on managed serving endpoints, or training runs started by jobs. That shows the infrastructure for a standard lifecycle exists. It cannot show that the process is documented, gated and enforced, which no system table records. An answer of \"met\" lifts the measured partial to a pass. Any other answer is recorded beside the measurement and leaves it as it is.",
		cadenceDays: QUARTERLY
	},
	"OE-01-06": {
		question: "Were your catalogs divided along a deliberate boundary — environment, domain or team — that you would choose again today?",
		evidence: "The document or decision that set the catalog layout, and who owns it. If the boundary has drifted from the one chosen, say so in the answer.",
		whyAsked: "The metastore holds more than one catalog, which shows the estate was divided. Whether the boundary is environment, domain or team, and whether it is the one that was intended, is not readable from the metastore. An answer of \"met\" lifts the measured partial to a pass. Any other answer is recorded beside the measurement and leaves it as it is.",
		cadenceDays: HALF_YEARLY
	},
	"IU-04-01": {
		question: "Do the people who build on your published tables trust them as data products, with a consistent meaning for the same business concept across schemas?",
		evidence: "The catalogue of published products, or the tagging convention that marks one, and who certifies a table as a product. A shared glossary is the usual evidence for consistent meaning.",
		whyAsked: "Tables in the metastore carry tags, which is the metadata a consumer uses to tell a product from a working table. Whether the business trusts them, and whether a concept is named the same way in two schemas, is semantic and is not something the metastore records. An answer of \"met\" lifts the measured partial to a pass. Any other answer is recorded beside the measurement and leaves it as it is.",
		cadenceDays: HALF_YEARLY
	},
	"IU-04-02": {
		question: "Does the same business concept mean the same thing, and carry the same name, in every schema that holds it?",
		evidence: "The business glossary or data dictionary, and how a new definition is reconciled with an existing one.",
		whyAsked: "The same reading as IU-04-01, asked as the semantic-consistency requirement: tags are present, and whether they mean the same thing across schemas is not something the metastore records. An answer of \"met\" lifts the measured partial to a pass. Any other answer is recorded beside the measurement and leaves it as it is.",
		cadenceDays: HALF_YEARLY
	},
	"OE-03-01": {
		question: "Does someone watch headroom against your service limits and quotas, and raise them before a limit bites?",
		evidence: "The alert or dashboard that tracks quota usage, and who is notified. Quota headroom is an account console fact, so the answer is usually a runbook or an alert on the account.",
		whyAsked: "No statement in the window waited at a capacity limit, which shows limits are not currently biting. It does not show that anyone would notice them approaching, and headroom is not recorded in the workspace. An answer of \"met\" lifts the measured partial to a pass. Any other answer is recorded beside the measurement and leaves it as it is.",
		cadenceDays: QUARTERLY
	}
};
//#endregion
export { CAPPED_QUESTIONS };
