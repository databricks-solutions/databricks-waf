// The questions put to a person for the requirements no API can answer.
//
// The count is not written here. It was "82" for long enough to be wrong by more than thirty, because
// every row that turns an attestation into a reading takes one away and nothing was checking the
// sentence. `questions.test.ts` holds the floor against the feature vanishing, which is the only thing
// a number here was ever doing.
//
// These were generated before they were written. The seeding script turned each published
// best-practice title into `"<title>: is this practice in place?"`, which produced eighty
// near-identical questions, most of them unanswerable as asked: "Use certified partner
// tools: is this practice in place?" has no defensible yes or no, so whatever a person
// clicks is noise that then moves the score. A page of eighty of those collects eighty bad
// answers and reports them as assessment.
//
// So each one is authored here, against three rules.
//
// It must be answerable wrongly. A question a well-run organisation and a badly-run one
// answer identically measures nothing. Each asks about a specific artefact or habit —
// whether the thing is written down, whether it is enforced, whether anyone acts on it —
// so that "partially met" is the honest answer for the common middle case rather than a
// hedge.
//
// It must name what the answer rests on. `evidence` is the prompt under the question, and
// it names the artefact: the repository, the runbook, the dashboard, the ticket queue.
// This is what makes the evidence link worth capturing and what makes the answer
// reviewable by someone who was not in the room.
//
// It must expire on a schedule that matches how fast the truth changes. Whether a catalogue
// strategy exists changes yearly; whether egress restrictions still hold changes with every
// network edit. `cadence_days` overrides the severity default, and the numbers here are 365
// for standards and design choices, 180 for operational habits that drift quietly, and 90
// for security posture and recovery procedures where a stale answer is actively misleading.
//
// Applied by scripts/enrich-catalogue.mjs. The catalogue is the product; this file is the
// source. CI fails if an attestation-class control has no entry here, so the generic
// template cannot come back.
//
// # Every question also has to say why it is a question
//
// The three rules above make a question worth answering. They say nothing about whether it should
// have been asked, and that is the more expensive mistake: a question costs a person's attention and
// buys an answer no better than their word, so one asked where the platform already knows is a worse
// failure than one badly worded. It is also the failure that never surfaces on its own. Telemetry
// arrives — a system table ships, a column is added — and the question goes on being asked, because
// nothing in the catalogue ever said what it was standing in for.
//
// So `asked_because` is required on every entry, and it records three things: what a machine would
// have to observe, whether anything records it, and the verdict that follows. The verdicts are
// deliberately uncomfortable. `OWED_A_MEASURE` says the platform records enough and this app does not
// read it yet — the question is a stopgap, the coverage ledger counts it as one, and it is meant to
// read as a debt rather than a design. ADR 0071 records the audit that assigned them and what it
// found: of the sixty-three questions here at the time, the majority had telemetry bearing on them and
// roughly a third could be answered outright. That reading is dated rather than current — the whole
// point of `OWED_A_MEASURE` is that the set it names keeps shrinking.

/** Standards, strategies and design choices: reviewed yearly. */
const YEARLY = 365;
/** Operational habits that decay without anyone deciding to stop: reviewed twice a year. */
const HALF_YEARLY = 180;
/** Security posture and recovery procedures, where a stale answer misleads: quarterly. */
const QUARTERLY = 90;

/**
 * Nothing the platform records bears on the answer. A person is the only source there is.
 *
 * The honest floor. Whether a runbook was rehearsed, whether a team exists, whether a design was
 * chosen rather than inherited — no table holds these, and none will, because they are facts about
 * people and intentions rather than about the estate.
 */
const BEYOND_TELEMETRY = 'beyond-telemetry';
/**
 * Something is recorded, it narrows the answer, and it does not settle it. The question stands.
 *
 * The common and awkward case: the platform shows the outcome and the question is about the practice
 * that produced it, or shows one workload's worth of a claim made about all of them. `signal` names
 * what is recorded so a reader can judge how much the question is really carrying.
 */
const PARTIAL_TELEMETRY = 'partial-telemetry';
/**
 * The platform records enough to answer this and the app does not read it yet.
 *
 * A debt, not a design. Every one of these is a question that should stop being asked, and the ledger
 * publishes the count so that it cannot quietly become permanent.
 */
export const QUESTIONS = {
  // ------------------------------------------------------------------ cost optimisation
  'CO-01-07': {
    question:
      'Is instance type chosen deliberately for each workload class, or does new work inherit whatever the last person used?',
    evidence:
      'The compute policies or job templates that fix instance families, and any note recording why those families were chosen for memory-bound, compute-bound or IO-bound work.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Node types are recorded per cluster and per-node CPU and memory are recorded alongside them, so a family mismatched to the load it carries is visible. Whether the family was chosen for the workload class or inherited is a fact about a decision, and no table holds it.',
      signal: 'system.compute.clusters.worker_node_type with system.compute.node_timeline',
    },
  },
  'CO-01-09': {
    question:
      'Do new workloads get sized against a measured baseline before they go to production, or sized generously and left?',
    evidence:
      'The deployment checklist or review step that requires a sizing figure, and one recent example where the figure changed the configuration that shipped.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'A cluster’s size at creation and its utilisation over the days after are both recorded, so sizing generously and leaving it shows up without anybody being asked. Whether a sizing figure was required at review is a property of a process the platform does not see.',
      signal: 'system.compute.clusters.create_time with system.compute.node_timeline',
    },
  },
  'CO-03-02': {
    question:
      'Are budgets set with alert thresholds that reach a named person, and has an alert actually been acted on?',
    evidence:
      'The budget configuration and the destination alerts go to. A shared mailbox nobody reads is a not-met, however well configured.',
    cadence_days: HALF_YEARLY,
    asked_because: {
      verdict: BEYOND_TELEMETRY,
      why: 'Budgets are account-plane objects. Checked rather than assumed: `system.billing` holds four tables — usage, attributed usage, list prices and account prices — and no budget among them, and `/api/2.1/budget-policies` answers Not Found from a workspace. The part that decides the answer is further out still: whether an alert reached somebody who acted on it is not recorded by anything.',
    },
  },
  'CO-03-03': {
    question:
      'Does someone compare actual spend against what was expected on a regular cadence, and does that comparison have consequences?',
    evidence:
      'The dashboard or report used, the cadence it is reviewed at, and one decision that came out of a review.',
    cadence_days: HALF_YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Reads of the billing tables are recorded like any other query, so whether anybody looks at spend, and how regularly, is measurable. Whether the comparison has consequences is the half the question is really for, and nothing records a decision that followed a dashboard.',
      signal: 'system.query.history filtered to reads of system.billing',
    },
  },
  'CO-03-04': {
    question:
      'When spend on a workload turns out not to be worth it, is there a route by which that workload changes or stops?',
    evidence:
      'A recent example: a job retired, a schedule reduced, a warehouse downsized because of cost. Without one, this is aspiration rather than practice.',
    cadence_days: HALF_YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'A warehouse downsized, a schedule reduced or a job retired are all recorded as changes with timestamps, so the route existing is observable. That cost was the reason is not: the platform records the edit and never the motive.',
      signal: 'system.compute.warehouses change history with system.lakeflow.jobs.paused and delete_time',
    },
  },

  // ----------------------------------------------------------- data and AI governance
  'DG-01-01': {
    question:
      'Is there a written governance process for data and AI assets with named owners, and is it followed for new assets?',
    evidence:
      'The document, plus how a new dataset or model actually gets an owner assigned today. A process document nobody routes work through is partially met at best.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'An owner is recorded on every catalogue asset, so whether new assets get one is measurable and is the part of this that bites. Whether a written process exists and work is routed through it is an organisational fact with no telemetry.',
      signal: 'system.information_schema.tables.table_owner',
    },
  },
  // DG-01-06 was here until it gained a measure: descriptions over the tables lineage says
  // something read, rather than over the estate. It still asks a person when nothing read
  // anything in the window, because that leaves no population to take the share over — see
  // server/attest/inconclusive-questions.ts.
  'DG-02-01': {
    question:
      'Is access to data and AI assets granted in one place, or do some assets still have permissions managed outside Unity Catalog?',
    evidence:
      'Any remaining access path that bypasses the catalogue: direct cloud storage grants, table ACLs on a legacy metastore, per-tool permissions.',
    cadence_days: QUARTERLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Unity Catalog grants are visible. The two common bypasses are not: a legacy metastore is invisible to every census this app runs, and grants made directly in cloud IAM are outside the platform, so no reading here can prove the absence of either.',
      signal: 'system.information_schema.table_privileges, for the grants the catalogue can see',
    },
  },
  'DG-03-01': {
    question:
      'Are data quality expectations written down per dataset — completeness, freshness, accuracy — rather than assumed?',
    evidence:
      'Where the expectations for a specific production dataset are recorded, and who agreed them with the consumer.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'A declared constraint is the machine-readable form of an expectation, and a CHECK constraint is readable — as a `delta.constraints.*` table property, which this app already reads for the tables it samples. Not from the information schema: `check_constraints` carries the right columns and stays empty, verified by declaring one on a labs table and finding it in the properties and in neither constraint view. An expectation agreed with a consumer and written in a document rather than declared on the table is invisible either way, and is what this asks about.',
      signal: 'DESCRIBE DETAIL properties, delta.constraints.* (already read as describe:storage.table_details)',
    },
  },
  // DG-03-02 was here until 37j read the quality monitor. The monitor is reported and not
  // scored — coverage is platform adoption, a Healthy share moves for nobody — so the
  // question stays, narrowed to on-failure behaviour. See
  // server/attest/inconclusive-questions.ts and ADR 0102.

  // ------------------------------------------------- interoperability and usability
  'IU-01-01': {
    question:
      'When a new external system needs to be integrated, is there a pattern to follow — or does each integration get designed from scratch?',
    evidence:
      'The documented patterns and one recent integration that used one. Count reuse, not the existence of a wiki page.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: BEYOND_TELEMETRY,
      why: 'The platform records the integration that exists, never whether it followed an established pattern or was designed from scratch again. Reuse is a fact about how a design was arrived at, and two identical connections can differ entirely on it.',
    },
  },
  'IU-01-03': {
    question:
      'Are the third-party tools in your data path ones with a supported Databricks integration, or do some rely on generic JDBC and goodwill?',
    evidence: 'The BI, ingestion and orchestration tools in use, and which of them are certified partners.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Every statement records the application that sent it, so the tools in the data path are enumerable and the question should arrive with that list already filled in — `sql:workload.sql_paths` reads it. What the enumeration cannot do is the part the requirement turns on. Which of those tools hold a current Databricks certification is a list Databricks maintains and revises, and an app carrying its own copy would answer from a stale one; the first audit of this said the app could hold that list, which was wrong in the direction that matters, because a confidently wrong certification claim is worse than a question.',
      signal: 'system.query.history.client_application',
    },
  },
  'IU-01-04': {
    question:
      'Has anyone deliberately reduced the number of hops and tools a dataset passes through, or has the pipeline only ever accreted?',
    evidence: 'A simplification made in the last year: a stage removed, two jobs merged, a tool retired.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Lineage records how many hops a dataset passes through and how that has moved, so accretion is visible as a trend. Whether a simplification was made deliberately in the last year is a claim about intent that a shorter graph does not establish.',
      signal: 'system.access.table_lineage',
    },
  },
  'IU-02-03': {
    question:
      'Are models and agents built against portable interfaces, or tied to one vendor’s SDK in a way that would be costly to change?',
    evidence: 'The frameworks and serving interfaces in use, and what a move away from one of them would require.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Whether serving points at an external vendor model or at a portable artefact is recorded per served entity, which answers the concrete half. What a move away would cost is a judgement about code the platform does not hold.',
      signal: 'system.serving.served_entities.external_model_config and foundation_model_config',
    },
  },
  'IU-03-01': {
    question:
      'Can a team start a new use case — get compute, a catalogue location and access — without a ticket to a central team?',
    evidence:
      'The actual path a new team takes today and how long it takes. If the answer involves waiting on an admin, say so.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Who creates compute and catalogue objects is audited, so whether teams provision for themselves or a central few do it for everybody is visible. How long a ticket takes, and whether one is needed at all, is not recorded.',
      signal: 'system.access.audit create actions by principal',
    },
  },

  // ------------------------------------------------------------ operational excellence
  'OE-01-01': {
    question:
      'Is there a named team or person accountable for the platform itself, distinct from the teams building on it?',
    evidence: 'Who is on call for the platform, and what they own that the workload teams do not.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: BEYOND_TELEMETRY,
      why: 'Whether a team exists and what it is accountable for is an organisational fact. No table records reporting lines, and a workspace with one attentive engineer looks identical to a workspace with a staffed platform team.',
    },
  },
  'OE-01-03': {
    question:
      'Does production code reach production through a pipeline with review and tests, rather than by being edited in place?',
    evidence: 'The CI/CD system, what it runs before deploying, and whether production write access exists outside it.',
    cadence_days: HALF_YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Deployment provenance shows code arrived by a deploy rather than by hand, which is the observable half. Whether review and tests ran before that deploy happened in a pipeline outside the platform, and nothing here records it.',
      signal: 'system.lakeflow.jobs.deployment',
    },
  },
  'OE-01-05': {
    question:
      'Are development, test and production genuinely isolated, such that a mistake in development cannot reach production data?',
    evidence:
      'The boundary: separate workspaces, separate catalogues, separate credentials. Note any identity that spans two of them.',
    cadence_days: QUARTERLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Grants held by a development identity on production catalogues are recorded, so the catalogue half of isolation is measurable. Isolation at the network and cloud account layer is outside a workspace’s view, and it is where the question’s worst case lives.',
      signal: 'system.information_schema.table_privileges with system.access.audit',
    },
  },
  'OE-02-07': {
    question:
      'Is the artefact promoted between environments the training code, or a model binary built in one environment and copied?',
    evidence:
      'What moves from development to production for one live model, and where the production model was trained.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'A served version that traces to a run recorded in this workspace, versus one that appears without any, separates promoted code from a copied binary in the common case. It does not do so reliably, because a legitimate promotion can carry its run history with it.',
      signal: 'system.mlflow.runs_latest with system.serving.served_entities.entity_version',
    },
  },
  'OE-02-10': {
    question:
      'Do ML pipelines run on the same managed infrastructure as data pipelines, or on separately maintained compute?',
    evidence: 'What ML training and inference run on, and who patches it.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'ML work running as jobs and pipelines on the platform’s own compute is recorded and countable. Work running on separately maintained infrastructure is invisible precisely because it is elsewhere, so an empty result cannot distinguish good practice from a blind spot.',
      signal: 'system.lakeflow.jobs and pipelines with system.compute.clusters',
    },
  },
  'OE-03-02': {
    question:
      'Is there a forward view of capacity and cost — growth, seasonality, new workloads — rather than reacting to invoices?',
    evidence: 'The plan or model, when it was last updated, and what changed as a result.',
    cadence_days: HALF_YEARLY,
    asked_because: {
      verdict: BEYOND_TELEMETRY,
      why: 'A forward view is a plan. Growth and seasonality are measurable in arrears from billing, but whether anybody looked ahead and produced a number is not something the estate records.',
    },
  },

  // ---------------------------------------------------------- performance efficiency
  'PE-03-01': {
    question:
      'Do you know how your largest datasets are read — which columns, which filters, how often — rather than inferring it?',
    evidence:
      'The query history or profiling used to establish access patterns, and one layout decision that followed from it.',
    cadence_days: HALF_YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'How the largest datasets are read is recorded in detail — partitions touched, files pruned, bytes scanned, how often. Whether the team knows any of that is a different claim, and it is the one asked.',
      signal: 'system.query.history.read_partitions, pruned_files and read_bytes',
    },
  },
  'PE-03-02': {
    question:
      'Where work could run in parallel, does it — or do pipelines run stages sequentially because that is how they were written?',
    evidence:
      'One pipeline where parallelism was introduced deliberately, and one where sequence is a known limitation.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'The task graph records where a job runs stages in sequence with no dependency between them, which is the common form of this problem. Parallelism inside a single task is invisible, so a clean graph does not settle the answer.',
      signal: 'system.lakeflow.job_tasks.depends_on_keys',
    },
  },
  'PE-03-03': {
    question:
      'When something is slow, do you profile the whole chain — source, transfer, compute, sink — or tune the Spark job by reflex?',
    evidence:
      'The last performance investigation: where the time actually went, and whether that was where you first looked.',
    cadence_days: HALF_YEARLY,
    asked_because: {
      verdict: BEYOND_TELEMETRY,
      why: 'This asks how people diagnose a problem — whether they look at the whole chain or reach for the Spark job. The platform records the workload and never the method used to look at it.',
    },
  },
  'PE-03-04': {
    question: 'Has anyone tested whether a larger cluster finishes your heavy jobs faster for the same or lower cost?',
    evidence:
      'A comparison run at two sizes, with the runtime and cost of each. Intuition about cluster size is usually wrong in one direction or the other.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Cluster size, node utilisation and run duration together show whether heavy jobs are under-provisioned, which is the substance. Whether a larger size was actually tried and compared on cost is an experiment, and an untried option leaves no trace.',
      signal: 'system.compute.clusters.worker_count with node_timeline and job_task_run_timeline',
    },
  },
  'PE-03-07': {
    question:
      'Is transformation logic written in native Spark operations, or does it fall back to row-at-a-time UDFs and Python loops in hot paths?',
    evidence: 'Any UDF or driver-side loop in a production hot path, and why it is there.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'A UDF registered in Unity Catalog is catalogued with the language it is written in, so Python functions callable from SQL are enumerable — four of them on the labs workspace. That is one of the two shapes this warns about. The other happens inside notebook Python, where a driver-side loop over a collected DataFrame is a property of code the platform neither stores nor parses, and no count of registered functions reaches it.',
      signal: 'system.information_schema.routines.external_language',
    },
  },
  'PE-03-09': {
    question:
      'Is compute matched to workload character — memory-heavy, shuffle-heavy, GPU — rather than one family used for everything?',
    evidence: 'The mapping from workload type to instance family, and any workload known to be on the wrong one.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Whether a workload is memory-bound or CPU-bound is recorded as utilisation, and the hardware it was given is recorded beside it, so a mismatch is visible. Whether the match was intended is not, and one family used for everything can still fit everything by luck.',
      signal: 'system.compute.node_timeline with system.compute.clusters node types',
    },
  },
  'PE-03-14': {
    question:
      'Have the joins in your heaviest queries been examined for strategy and skew, or are they left to the optimiser?',
    evidence: 'One join that was changed after examination — broadcast, reordered, skew handled — and its effect.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Shuffle volume and local spill are recorded per statement and mark joins going badly, which finds the problem. Join strategy and skew live in the query profile, which has no system table, so the diagnosis the question asks for cannot be completed from telemetry.',
      signal: 'system.query.history.shuffle_read_bytes and spilled_local_bytes',
    },
  },
  'PE-04-01': {
    question:
      'Is performance tested against data of production shape and scale, or against a small sample that hides the problems?',
    evidence: 'What the test dataset is, and how its size and skew compare to production.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: BEYOND_TELEMETRY,
      why: 'This compares test data against production data, and the platform records no notion of which estate is which. Volumes are visible; deciding that one catalogue is the test one requires a naming convention the platform neither knows nor enforces.',
    },
  },
  'PE-04-02': {
    question: 'For workloads with a start-of-day deadline, is compute warmed before the work arrives?',
    evidence: 'Which workloads have a latency commitment and what is done about cold start for each.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'The cold start is timed rather than inferred: every statement records how long it waited for compute, and the warehouse event log records the start that made it wait. So a workload whose first run of the day pays a start-up penalty is identifiable. What is not recorded is the deadline — nothing says which workloads have one — so a penalty cannot be told from an acceptable wait, and warm compute cannot be told from compute that happened to still be up.',
      signal: 'system.query.history.waiting_for_compute_duration_ms with system.compute.warehouse_events',
    },
  },
  'PE-04-03': {
    question:
      'Are bottlenecks identified from evidence — query profiles, Spark UI, metrics — rather than from where people expect them?',
    evidence: 'The last bottleneck found, the tool that found it, and whether it was where you expected.',
    cadence_days: HALF_YEARLY,
    asked_because: {
      verdict: BEYOND_TELEMETRY,
      why: 'Asks where a diagnosis started: evidence or expectation. That is a fact about how people work, and the estate looks the same either way.',
    },
  },
  'PE-05-01': {
    question: 'Is monitoring configured when a workload ships, or added later when something goes wrong?',
    evidence:
      'The deployment checklist item covering monitoring, and one recent workload that shipped with it in place.',
    cadence_days: HALF_YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Health rules are recorded on a job with a change time, so monitoring added long after the job shipped is distinguishable from monitoring configured with it. Dashboards and monitoring built outside the platform are not recorded, and are common.',
      signal: 'system.lakeflow.jobs.health_rules',
    },
  },
  'PE-05-02': {
    question:
      'Does anyone watch query performance over time, such that a query getting slower is noticed before a user reports it?',
    evidence: 'The dashboard or alert on query latency, and the last regression it caught.',
    cadence_days: HALF_YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Whether anybody reads query history, and whether alerts exist over it, is recorded. Whether a query getting slower would be noticed before a user complained is a claim about attention that no signal settles.',
      signal: 'system.query.history with system.access.audit for alert use',
    },
  },

  // -------------------------------------------------------------------- reliability
  'REL-01-03': {
    question:
      'When a record arrives malformed, is it captured for inspection — or does it fail the job, or silently vanish?',
    evidence: 'The rescue or quarantine mechanism in your ingestion path, and where bad records end up.',
    cadence_days: HALF_YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Pipeline expectations and what they do on violation are recorded where pipelines are used, which answers it for that estate. Rescue logic hand-written in a notebook is not recorded, and the silent-vanish case the question warns about is exactly the hand-written one. The table-constraint half is read from `delta.constraints.*` properties rather than from the information schema, which does not carry CHECK constraints.',
      signal: 'system.lakeflow.pipelines.settings with DESCRIBE DETAIL properties',
    },
  },
  'REL-01-05': {
    question: 'Is model serving able to survive an instance failure and a traffic spike without manual intervention?',
    evidence:
      'The serving configuration: replicas, scaling bounds, and what happened during the last spike or failure.',
    cadence_days: HALF_YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Managed serving and its scaling configuration are recorded, so the infrastructure half is readable. Whether it survived an instance failure or a traffic spike is a fact about an event that may never have happened.',
      signal: 'system.serving.served_entities with system.serving.endpoint_usage',
    },
  },
  'REL-02-01': {
    question:
      'Is there a deliberate layering — raw, refined, serving — such that a bad transformation can be rerun from retained source data?',
    evidence: 'The layers as they exist, and whether raw data is retained long enough to reprocess from.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Lineage depth records whether data passes through distinct layers before it is served, which is the shape the question describes. Whether the layering is deliberate, and whether raw data is retained long enough to rerun from, are separate claims one graph does not answer.',
      signal: 'system.access.table_lineage with system.information_schema.schemata',
    },
  },
  'REL-02-02': {
    question: 'Is the same fact stored once and derived from, or copied into several tables that can now disagree?',
    evidence: 'Any known duplicate of a core dataset, why it exists, and whether the copies have diverged.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Column-level lineage records where each column came from, so one source column landing in many tables is countable — 43,014 edges on the labs workspace. It narrows rather than settles, because a fan-out is what a well-built mart looks like as much as what a redundant copy looks like, and deciding which needs the meaning of the tables. A copy made by a job that read one table and wrote another without a declared derivation leaves no edge at all, and that is the case that causes the disagreement.',
      signal: 'system.access.column_lineage',
    },
  },
  'REL-02-03': {
    question:
      'When an upstream schema changes, is it detected and handled — or does it break a pipeline or silently drop a column?',
    evidence:
      'The schema handling in place — enforcement, evolution rules, contracts — and the last upstream change and what it cost you.',
    cadence_days: HALF_YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Column additions and drops are audited, so schema movement is visible after it happens. Whether the change was detected and handled, or silently dropped a column that a consumer was reading, is the half that matters and is not recorded.',
      signal: 'system.access.audit schema change operations',
    },
  },
  // REL-02-04 was here until it gained a measure: a Delta CHECK constraint is a `delta.constraints.*`
  // property the per-table describe already reads. It still asks a person when the reading comes back
  // with no constraint, because that does not settle the requirement — see
  // server/attest/inconclusive-questions.ts.
  'REL-02-05': {
    question: 'When a model underperforms, is the data investigated first — or does tuning start with the model?',
    evidence: 'The last model quality problem and where the cause turned out to be.',
    cadence_days: YEARLY,
    asked_because: {
      verdict: BEYOND_TELEMETRY,
      why: 'Asks what an investigation started with — the data or the model. A sequence of human decisions, leaving no mark on the estate either way.',
    },
  },
  'REL-04-01': {
    question: 'Have you tested that a killed streaming query resumes from its checkpoint without loss or duplication?',
    evidence:
      'The test: when it was last run, on which query, and what was verified about the output. Answer not-applicable if you run no streaming workloads.',
    cadence_days: QUARTERLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'A streaming task that failed and resumed is recorded, which is evidence the recovery path ran at least once. Whether it was tested deliberately, and whether the resume lost or duplicated records, is not something the run timeline can tell.',
      signal: 'system.lakeflow.job_task_run_timeline',
    },
  },
  'REL-04-02': {
    question:
      'Have you actually restored a table to an earlier version after a bad write, rather than assuming time travel will work?',
    evidence:
      'The last restore performed or rehearsed, and whether the retention window was long enough to reach the point you needed.',
    cadence_days: QUARTERLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'A restore that happened is audited, so where the answer is yes there is a record of it. A no is indistinguishable from a workspace that has never needed one, which is why the question still has to be asked.',
      signal: 'system.access.audit restore operations',
    },
  },
  'REL-04-03': {
    question:
      'When a job fails part way through, does the framework retry and resume safely — or does someone work out by hand what to rerun?',
    evidence:
      'The retry and idempotency behaviour of your main pipeline, and what the last failure required of a human.',
    cadence_days: HALF_YEARLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Repeat attempts on a failed task are recorded, so retries that happened are visible. The configured retry policy is in no system table, and whether a resume was safe rather than merely successful is a property of the code.',
      signal: 'system.lakeflow.job_task_run_timeline with system.lakeflow.job_tasks.timeout_seconds',
    },
  },
  'REL-04-04': {
    question:
      'Is there a disaster recovery plan with a stated recovery objective, and has it been exercised rather than written?',
    evidence: 'The RTO and RPO you are committed to, the date of the last exercise, and what it found.',
    cadence_days: QUARTERLY,
    asked_because: {
      verdict: BEYOND_TELEMETRY,
      why: 'A plan, a stated recovery objective, and an exercise. None of the three is an estate fact, and a workspace that has rehearsed failover looks exactly like one that intends to.',
    },
  },

  // --------------------------------------------- security, compliance and privacy
  // SCP-01-01 was here until it gained a measure: password logins in the audit log settle a
  // failure. It still asks a person when none appear, because that does not prove local accounts
  // are gone — see server/attest/inconclusive-questions.ts.
  'SCP-01-02': {
    question:
      'Are permissions granted to groups against a least-privilege model, and is access removed when people move on?',
    evidence: 'How access is granted and revoked, when entitlements were last reviewed, and what that review removed.',
    cadence_days: QUARTERLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Whether a grant is held by a group or by a named individual is recorded on every securable, so the least-privilege half is measurable and ought to be measured. Whether access is removed when somebody moves on needs the joiner-mover-leaver process, which is not in the platform.',
      signal: 'system.information_schema.table_privileges, schema_privileges and catalog_privileges',
    },
  },
  'SCP-03-01': {
    question:
      'Was the network design chosen deliberately — customer-managed VPC, private connectivity, egress path — or accepted as the default?',
    evidence: 'The deployment as built, and the decision record or diagram behind it.',
    cadence_days: QUARTERLY,
    asked_because: {
      verdict: BEYOND_TELEMETRY,
      why: 'Network topology is cloud-plane configuration with no workspace-readable source, and the question is about whether a design was chosen rather than accepted — which nothing records even where the topology is visible.',
    },
  },
  'SCP-03-02': {
    question: 'Is workspace access restricted to known networks, and is outbound traffic from compute constrained?',
    evidence:
      'The IP access lists, private connectivity and egress restrictions in force, and any path that bypasses them.',
    cadence_days: QUARTERLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'The first clause is read already. `enableIpAccessLists` is one of the fifteen keys this app asks `workspace-conf` for on every scan, and it settles SCP-03-10 — so the claim that the scope is unavailable was wrong about the setting this very question opens with. What is left is the egress half: serverless egress is logged, but that table is empty on a workspace that constrains nothing and on one that logs nothing, and the cloud-side network design behind it is outside the platform.',
      signal: 'workspace-conf enableIpAccessLists, already read for SCP-03-10, with system.access.outbound_network',
    },
  },
  'SCP-03-13': {
    question:
      'Has anyone verified from inside a cluster that egress is actually blocked, rather than trusting the configuration?',
    evidence: 'The test performed from compute — which destinations were attempted, which were refused — and when.',
    cadence_days: QUARTERLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'The experiment is not recorded — its result exists only if somebody ran it — but the thing the experiment is trying to establish partly is: serverless egress is logged, so a destination compute actually reached is visible. It narrows rather than settles for two reasons. The table is empty on a workspace whose egress is genuinely constrained and on one where the logging is not enabled, and it covers serverless compute rather than the classic cluster the question asks about.',
      signal: 'system.access.outbound_network',
    },
  },
  'SCP-04-06': {
    question: 'Are there DBFS mounts still in use, giving access to cloud storage outside Unity Catalog governance?',
    evidence:
      'The mounts that exist, what they point at, and whether anything still reads through them rather than through a catalogue location.',
    cadence_days: QUARTERLY,
    asked_because: {
      verdict: PARTIAL_TELEMETRY,
      why: 'Mount and unmount are audited, so mounts created within the retained window are visible. A mount made before it and still in use is not, because listing what is mounted now needs a command run on compute.',
      signal: 'system.access.audit mount operations',
    },
  },
};
