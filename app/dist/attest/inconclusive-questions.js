//#region server/attest/inconclusive-questions.ts
/**
* How long an answer about a delivery practice stands.
*
* Longer than the quarterly cadence for settings, because these are answers about how a team
* works rather than about a switch. A team that adopted bundles has not un-adopted them by
* next quarter, and asking again that soon trains the reader to click through.
*/
const HALF_YEARLY = 180;
/**
* For the ones tied to what tooling is in use.
*
* Monitoring stacks and AI surfaces change on the timescale of a project, not a year, so an
* older answer is describing a toolchain that may have moved on.
*/
const QUARTERLY = 90;
const INCONCLUSIVE_QUESTIONS = {
	"OE-02-01": {
		question: "Are your jobs, pipelines and compute defined in version-controlled code and deployed by a pipeline, rather than created and edited in the workspace UI?",
		evidence: "The repository holding the definitions, and the CI job that deploys them. If you use Terraform, name the state backend; if asset bundles, the bundle root. What matters is that a change to a job goes through review before it reaches the workspace.",
		whyAsked: "Databricks records `deployment.kind = BUNDLE` on jobs deployed by an asset bundle, and none of yours carry it. That is not evidence of hand-built jobs: the Terraform provider creates jobs through the same API a person uses and leaves no marker at all, so a fully Terraform-managed estate looks exactly like this one. Nothing the platform records distinguishes them.",
		cadenceDays: HALF_YEARLY
	},
	"OE-01-02": {
		question: "Is all production code in enterprise source control, or does some production logic exist only in a workspace notebook?",
		evidence: "The repository holding the notebooks and job definitions that run in production, and how a change to one reaches the workspace. A notebook edited in place and never committed is the case this asks about.",
		whyAsked: "The same reading as OE-02-01, asked as the source-control requirement: a bundle deploys notebooks and job definitions together from one repository, and no job here carries the marker that would prove it. Terraform-deployed jobs carry none either, so the platform cannot tell a repository-managed estate from one edited in the UI.",
		cadenceDays: HALF_YEARLY
	},
	"REL-02-04": {
		question: "Are constraints and expectations declared on production tables, so a violation is caught by the platform rather than by a consumer?",
		evidence: "The constraints or expectations on one production table, and what happens when one is violated — a CHECK constraint, a NOT NULL, or a pipeline expectation with its action on violation.",
		whyAsked: "Too few of the sampled tables declare a Delta CHECK constraint for this scan to settle the requirement, and that is the one mechanism it can read: constraints are recorded as `delta.constraints.*` properties on the most-read tables. How many declared one is in the finding for this requirement, and it may be none of them. That is not evidence the practice is absent — pipeline expectations live in the pipeline definition and a column NOT NULL lives in its nullability, and this scan reads neither, so a table enforcing its rules that way looks exactly like one enforcing nothing.",
		cadenceDays: HALF_YEARLY
	},
	"SCP-01-01": {
		question: "Are accounts provisioned from your identity provider with SSO, or are there local users and passwords in the account?",
		evidence: "The provisioning path, and any account that can log in without going through the identity provider.",
		whyAsked: "No username-and-password login (`action_name = login`) appeared in the audit window. That is not evidence local accounts are gone — only that none authenticated that way while the window was retained. Events under other action names mentioning login or authentication may have been recorded; the finding names them, and this reading does not say which of them are people signing in, so a local credential among them is not ruled out either. The account-plane configuration that would list local users is unreadable here.",
		cadenceDays: QUARTERLY
	},
	"IU-01-05": {
		question: "Are your jobs, pipelines and compute defined in version-controlled code and deployed by a pipeline, rather than created and edited in the workspace UI?",
		evidence: "The repository holding the definitions, and the CI job that deploys them. If you use Terraform, name the state backend; if asset bundles, the bundle root.",
		whyAsked: "The same reading as OE-02-01, which asks this from the operational side: no job here carries a bundle deployment marker, and Terraform-deployed jobs carry none either, so the two cannot be told apart from the platform’s own record.",
		cadenceDays: HALF_YEARLY
	},
	"IU-01-02": {
		question: "How does data from external systems reach this account — through managed ingestion connectors, Auto Loader, a partner tool, or extracts your team maintains?",
		evidence: "Name the mechanism for each significant source. A managed connector or Auto Loader counts as an optimized connector; a scheduled script that pulls a full table into files and reloads it does not.",
		whyAsked: "This metastore has no Lakehouse Federation connections, which is only one of the ways the requirement is met. Managed ingestion connectors, Auto Loader and certified partner tools all bring data in without registering a connection, and none of them appear in the metastore, so the scan cannot tell a well-connected estate from a badly-connected one.",
		cadenceDays: QUARTERLY
	},
	"OE-04-01": {
		question: "When a production job fails or overruns, what tells someone — and is that someone on call for it?",
		evidence: "Name the alerting path: job notifications to an email or Slack channel, a data quality monitor, or an external system like Datadog or PagerDuty reading the system tables. A dashboard nobody is paged from is monitoring, not alerting.",
		whyAsked: "None of the job definitions here record their health rules. That column is only populated for job rows changed since early December 2025, so this means the definitions predate the column rather than that the jobs are unmonitored — and monitoring built outside Databricks on the audit logs would be invisible here in any case.",
		cadenceDays: QUARTERLY
	},
	"OE-04-02": {
		question: "Which platform monitoring tools are in use — Databricks system tables and dashboards, an external observability stack, or both?",
		evidence: "Name the tools and what each one watches. If an external system consumes the system tables or audit log delivery, say which tables and how often it reads them.",
		whyAsked: "The same reading as OE-04-01: no job definition here records a health rule, and external tooling built on the audit logs leaves no trace in the workspace, so the scan cannot see monitoring that lives outside Databricks.",
		cadenceDays: QUARTERLY
	},
	"PE-05-04": {
		question: "Is job duration tracked over time, so a job that has doubled in runtime is visible before somebody complains?",
		evidence: "What holds the history and what looks at it: a duration health rule on the job, a dashboard over the run timeline, or an external system reading it. A run list somebody scrolls when asked is not tracking.",
		whyAsked: "The same reading as OE-04-01, asked as the job-performance requirement: a `RUN_DURATION_SECONDS` health rule is what makes a slowing job visible, and none of the job definitions here record their health rules. That column is only populated for rows changed since early December 2025, so this means the definitions predate it rather than that nothing is watched.",
		cadenceDays: QUARTERLY
	},
	"CO-01-03": {
		question: "When someone needs to run SQL, is a SQL warehouse the path of least resistance — or is it easier for them to start an all-purpose cluster?",
		evidence: "What a new analyst is given access to and told to use. A cluster policy or an entitlement that steers SQL work to a warehouse counts for more than a documented preference.",
		whyAsked: "No SQL ran in the window that this assessment did not run itself, so there is no path to read. Query history keeps ninety days, so this is a workspace that has not been used for SQL in that time rather than one where the reading failed — but an unused workspace is not evidence either way about where its SQL would run.",
		cadenceDays: HALF_YEARLY
	},
	"PE-03-10": {
		question: "Where the same data is read repeatedly, is caching used deliberately — and has its effect been measured?",
		evidence: "Where caching is relied on, and the before-and-after figure that justified it. Which compute holds the data matters more than the setting: a warehouse that stops between the two reads has nothing to re-read from.",
		whyAsked: "Nothing read a file in the window — every statement was answered from metadata or from memory, or nothing ran at all — so there was nothing for a cache to hold and no hit rate to compute. That is the shape of the workload rather than a failed reading, and it says nothing about the reads this requirement is about.",
		cadenceDays: HALF_YEARLY
	},
	"OE-02-05": {
		question: "Where a job ingests files that land on a schedule, does it react to the file arriving, or does it poll on an interval to check whether one has?",
		evidence: "The trigger on the job, and roughly how often files actually land relative to how often it polls. A file-arrival trigger counts outright; a short polling interval close to the landing cadence is a weaker version of the same thing.",
		whyAsked: "No job whose trigger this app can name is triggered by file arrival — either the ones that record a single trigger run on a periodic or cron schedule, or their definitions record no trigger, or they record more than one and the set is not in the reading. Where a mechanism was named, it records only how a job starts and not what the job does once running, so this cannot tell a job polling for a file that may or may not have landed from one doing something with no file involved at all.",
		cadenceDays: QUARTERLY
	},
	"PE-05-03": {
		question: "For jobs that run continuously rather than on a schedule, is there a rule that alerts when the streaming backlog grows — bytes, records, seconds, or files behind?",
		evidence: "The rule or dashboard that watches backlog specifically, separate from any rule watching whether the job is still running at all.",
		whyAsked: "Either no continuous job here carries a readable health-rules list, or no job records a trigger this app can name, so which of them run continuously is unknown. A definition edited before the system table began recording these columns carries neither, and a definition with more than one trigger keeps the set out of this reading — so either way this means the reading did not answer rather than that backlog goes unwatched.",
		cadenceDays: QUARTERLY
	},
	"REL-01-02": {
		question: "Do all production workloads run on compute with more than one machine, or do some depend on a single node that takes the whole run with it?",
		evidence: "The compute behind each production job or pipeline, and for any single-node one, whether that was a decision somebody made about bounded work or the shape it happened to be left in.",
		whyAsked: "The cluster inventory this measure reads did not answer for this estate — it was not collected, or it was collected and could not be read — so the worker counts and autoscale ranges behind the reading were unavailable. Whether any production cluster runs on one machine is unread rather than settled either way.",
		cadenceDays: QUARTERLY
	},
	"CO-01-08": {
		question: "Has anyone tested whether the workloads on classic compute would run on a smaller cluster — fewer workers, a smaller instance type — without missing their deadline?",
		evidence: "The test or the change: a cluster resized down and the runtime it produced, or the utilisation figure that justified leaving the size as it is.",
		whyAsked: "`system.compute.node_timeline` returned no per-node CPU reading for this estate in the window, or returned readings no cluster had enough of to average, or returned averages with no cluster idling near zero — and a cluster above that threshold is not thereby shown to be right-sized for what it runs. Any of the three leaves whether compute is sized to what it uses unread rather than shown to be correct.",
		cadenceDays: QUARTERLY
	},
	"DG-03-02": {
		question: "When a data quality check fails, does the pipeline stop, quarantine the rows, or only warn?",
		evidence: "The action on violation for one production pipeline — expect_or_fail, expect_or_drop, or expect — and where dropped rows go. A check that logs a warning nobody reads is the case this asks about.",
		whyAsked: "This scan reads the latest quality-monitor verdict per customer table where the schema is enabled, and that reading does not say what a pipeline does when a check fails: an absent schema is a metastore that has not turned the monitor on, a present one reports how many tables it last wrote a verdict for, and neither is the difference between expect, expect_or_drop and expect_or_fail.",
		cadenceDays: HALF_YEARLY
	},
	"DG-01-06": {
		question: "Can someone outside the owning team find a dataset they need and understand what it contains without asking a person?",
		evidence: "Whether descriptions, tags and ownership are populated for the assets consumers actually search, and how discovery is expected to happen — Catalog Explorer, a data catalogue product, or a person who knows where things are.",
		whyAsked: "This measure takes the share of described tables over the ones lineage says something read, and it found no such population: either nothing read a table in the window, or the table census this scan ran came back empty — which can mean an empty metastore or a principal without `BROWSE` on the catalogs, and the finding says which of those two it is. Where the estate is real and idle, lineage is emitted on access, so assets nobody opened record the same nothing as assets nobody could find.",
		cadenceDays: HALF_YEARLY
	},
	"IU-03-04": {
		question: "Which Databricks AI capabilities does your team use to shorten delivery — SQL AI functions, Genie, the assistant, foundation model APIs, or none yet?",
		evidence: "Name the capabilities and roughly who uses them. A team calling `ai_query` from SQL or using Genie for self-service analysis counts, even with no serving endpoint deployed.",
		whyAsked: "There are no model serving or vector search endpoints, which are the only two AI surfaces this app can be authorised to read. SQL AI functions, Genie, the assistant and pay-per-token foundation model calls all leave no endpoint behind, so an estate using those heavily reads the same as one using no AI at all.",
		cadenceDays: QUARTERLY
	}
};
//#endregion
export { INCONCLUSIVE_QUESTIONS };
