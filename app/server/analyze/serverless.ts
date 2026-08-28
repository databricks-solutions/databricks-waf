// The serverless readiness analyzer.
//
// The scored requirement behind this asks one question of the whole estate: what share of
// compute spend is serverless. That is the right thing to score and the wrong thing to act
// on, because "43%" tells nobody which job to move on Monday. This answers the acting
// question instead — per job: can it move, what specifically breaks, and what would it
// cost — and it deliberately does not feed a score. Nothing here can change a finding.
//
// Everything is read from what jobs actually ran on. The Jobs API is where task-level
// compute configuration lives and it is not a scope a Databricks App can hold, so the run
// timeline is the only surface that can answer this at all; the statement headers explain
// what that costs in precision. The consequence worth stating here is that a verdict is
// about a job's compute, not about its code: a notebook that imports a Scala UDF or calls
// `df.cache()` is blocked on serverless and looks identical to one that is not from
// outside. That is why every verdict carries the `outside-metadata` note, and why the
// fourth verdict exists.
//
// The four verdicts, and what separates them:
//
//   ready       Nothing readable stops it. Not a promise — see the note above.
//   rework      Something specific has to change first, and it is named.
//   blocked     Serverless jobs compute cannot run this work as it stands.
//   unknown     The configuration itself could not be read, so there is no verdict.
//
// Order of precedence is blocked, then rework, then unknown, then ready. Unknown sits
// below rework on purpose: a job with an init script and one unreadable cluster has work
// to do either way, and telling the reader "undeterminable" would bury the actionable half
// under the unreadable one. Both appear in its reasons.

import type { SignalId, SignalResult } from '../collect/signal.js';
import {
  rowsOf,
  type JobReadinessRow,
  type JobRow,
  type JobSpendRow,
  type WorkspaceDirectory,
} from '../collect/sql/shapes.js';
import { asJob, linksIn } from '../resolve/locate.js';
import { agreeing } from '../resolve/resolvers/helpers.js';
import { serverlessRules, type CostAssumption, type RuleId, type ServerlessRule } from './serverless-rules.js';
import type { Evidence } from '../advise/rules.js';

export const READINESS = 'sql:serverless.job_readiness' as SignalId;
export const JOB_SPEND = 'sql:serverless.job_spend' as SignalId;
export const JOB_INVENTORY = 'sql:jobs.inventory' as SignalId;
export const WORKSPACES = 'sql:estate.workspaces' as SignalId;

/**
 * What this analysis needs collected.
 *
 * Exported so the scan can add them to its plan. No resolver reads these two signals — the
 * spend-share resolver behind the four requirements reads the estate aggregate instead — so
 * without this they would be filtered out of the plan and the analysis would find nothing.
 */
export const SERVERLESS_ANALYZER_SIGNALS: readonly SignalId[] = [READINESS, JOB_SPEND, JOB_INVENTORY, WORKSPACES];

/**
 * The requirements this analysis stands behind.
 *
 * Named here rather than as a field on the catalogue entries, so the link between a finding
 * and the analysis that elaborates it comes from the analyzer that produces it. A control
 * cannot then claim an analysis that was never built.
 */
export const EXPLAINS: readonly string[] = ['CO-01-06', 'PE-02-01', 'REL-01-06', 'IU-03-02'];

/** The runtime major version below which a job has never run on a Spark serverless offers. */
const OLDEST_SERVERLESS_RUNTIME_MAJOR = 14;

/** The platform's ceiling on a single serverless workload. */
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

/**
 * How many jobs are listed.
 *
 * A cap rather than everything, because the list is a work queue and a queue of four
 * hundred is not one. Sorted by classic spend, so the cut falls on the jobs whose migration
 * is worth least, and the total is always reported beside the cut.
 */
const LISTED = 40;

export type Verdict = 'ready' | 'rework' | 'blocked' | 'unknown';

/** A rule that fired, with the sentence about this estate that made it fire. */
export interface Reason {
  readonly ruleId: string;
  readonly kind: ServerlessRule['kind'];
  /** Absent on advisory records written before authored actions shipped. */
  readonly action?: string;
  readonly headline: string;
  readonly detail: string;
  readonly docUrl: string;
  /** What was measured on this job. The rule says what it means; this says what was seen. */
  readonly observed: string;
  /**
   * The same measurement as numbers, where the thing measured is a number.
   *
   * Added by `44b`, and the reason is that `observed` is the sentence `Two of the clusters this job
   * ran on had GPU workers.` — a later reading cannot be subtracted from a sentence, so an action
   * raised from one of these could carry an opportunity and could never report a realised value.
   *
   * Empty where what fired the rule is not a quantity. A job configured to run continuously is a
   * setting, and the oldest runtime it used is a version rather than a count: both are conditions
   * that hold or do not, and giving them a number with `count` on it would be a unit this file
   * invented. Those reasons stay prose, and say so by carrying nothing here.
   *
   * Optional because an advisory written before `44b` is still in the store and carries none, and a
   * required field would make every one of those records a lie the type checker vouched for.
   */
  readonly evidence?: readonly Evidence[];
}

export interface CostRange {
  readonly low: number;
  readonly high: number;
  readonly currency: string;
  /**
   * The price list's name for the region the rate came from.
   *
   * Shown because the rate is the one number here the reader can check against a published
   * price, and cannot check without knowing which region it was read at.
   */
  readonly region?: string;
}

export interface JobReadiness {
  readonly workspaceId: string;
  readonly jobId: string;
  /** The job's name, or its id when the definition is gone and only its runs remain. */
  readonly name: string;
  readonly verdict: Verdict;
  readonly runs: number;
  readonly classicClusters: number;
  readonly reasons: readonly Reason[];
  /** Up to three cluster names, so the reader can recognise which compute this was. */
  readonly clusters: readonly string[];
  /** Which workspace, when the account has more than one and the name is therefore ambiguous. */
  readonly workspace?: string;
  /** The job's own page, in its own workspace. Absent when the directory could not be read. */
  readonly link?: string;
  readonly lastRun?: Date;
  /** What this job's classic compute cost in the window, in Databricks DBUs alone. */
  readonly cost?: number;
  readonly currency?: string;
  readonly estimate?: CostRange;
  /** Why there is no estimate, when there is spend but no rate to price it with. */
  readonly noEstimate?: string;
  /** Start-up time as a share of this job's measured time, which is what the range spans. */
  readonly startupShare?: number;
}

export interface ServerlessReadiness {
  readonly lookbackDays: number;
  /** Jobs with at least one run in the window, whatever they ran on. */
  readonly jobsRan: number;
  /** Jobs whose every recorded compute was already serverless. */
  readonly alreadyServerless: number;
  /** Jobs that ran only on SQL warehouses, whose serverless question is the warehouse's. */
  readonly onWarehouse: number;
  readonly jobs: readonly JobReadiness[];
  readonly counts: Readonly<Record<Verdict, number>>;
  /** Total classic compute cost of the jobs assessed, for comparison with the estimate. */
  readonly cost?: number;
  readonly currency?: string;
  /** The range across every job with an estimate, and how many of them there were. */
  readonly estimate?: CostRange & { readonly jobs: number };
  readonly assumptions: readonly CostAssumption[];
  /** The always-note: what a configuration-level analysis cannot see. */
  readonly caveat: Reason;
  /** Present when the list is a subset of what was found. */
  readonly truncated?: { readonly listed: number; readonly found: number };
  /**
   * The earlier run this analysis came from, when a targeted rerun did not reproduce it.
   *
   * A rerun of Security alone does not re-read job history, so the alternative to carrying
   * this forward is losing it — and a page that empties when somebody reruns an unrelated
   * pillar reads as an estate that suddenly has no classic jobs. Carried, but stamped: shown
   * with this date rather than the containing scan's, for the same reason a carried-forward
   * pillar names the run that measured it.
   */
  readonly carriedFrom?: { readonly scanId: string; readonly measuredAt: Date };
  /** Present when a signal this needs could not be read, with the reason it gave. */
  readonly unmeasured?: string;
}

export interface AnalyseInput {
  readonly readiness: readonly JobReadinessRow[];
  readonly spend: readonly JobSpendRow[];
  readonly jobs: readonly JobRow[];
  readonly lookbackDays: number;
  /**
   * The account's workspaces, for the link to each job's own page and the workspace name
   * beside it. Omitted means neither, which is what an unreadable directory should cost:
   * prose instead of links, never a missing verdict.
   */
  readonly directory?: WorkspaceDirectory;
}

/**
 * The analysis, from the three signals it reads.
 *
 * Returns undefined when the readiness signal could not be read at all, because an empty
 * analysis and an unread one are different claims and the caller shows different things for
 * them. A readiness signal that was read and found no jobs returns a result with no jobs:
 * an estate that ran nothing is a measurement.
 */
export function analyseServerless(
  signals: ReadonlyMap<SignalId, SignalResult>,
  lookbackDays: number
): ServerlessReadiness | undefined {
  const readiness = signals.get(READINESS);
  if (readiness == null) return undefined;
  if (readiness.status !== 'observed') {
    return {
      ...empty(lookbackDays),
      unmeasured:
        readiness.unmeasurableReason ??
        'The per-job compute history could not be read, so no job could be assessed for serverless.',
    };
  }

  const spend = signals.get(JOB_SPEND);
  const jobs = signals.get(JOB_INVENTORY);
  const workspaces = signals.get(WORKSPACES);
  const analysis = analyse({
    readiness: readiness.value as JobReadinessRow[],
    spend: spend?.status === 'observed' ? (spend.value as JobSpendRow[]) : [],
    jobs: jobs?.status === 'observed' ? (jobs.value as JobRow[]) : [],
    lookbackDays,
    ...(workspaces?.status === 'observed' ? { directory: workspaces.value as WorkspaceDirectory } : {}),
  });

  // A spend signal that failed leaves every verdict intact and every estimate absent, which
  // is worth saying rather than letting the reader wonder why the costs are missing.
  if (spend != null && spend.status !== 'observed') {
    return {
      ...analysis,
      unmeasured:
        spend.unmeasurableReason ??
        'Per-job billing could not be read, so the verdicts here carry no cost and no estimate.',
    };
  }
  return analysis;
}

export function analyse(input: AnalyseInput): ServerlessReadiness {
  const ruleset = serverlessRules();
  const rule = (id: RuleId): ServerlessRule => {
    const found = ruleset.rules.get(id);
    // Unreachable: the loader refuses a file whose ids do not match RULE_IDS exactly. Thrown
    // rather than defaulted, because a reason with an empty explanation would be worse than
    // a loud failure in the one place that can only happen if that check was removed.
    if (found == null) throw new Error(`The serverless ruleset has no rule ${id}.`);
    return found;
  };

  const named = new Map(input.jobs.map((job) => [key(job.workspaceId, job.jobId), job]));
  const spending = new Map(input.spend.map((row) => [key(row.workspaceId, row.jobId), row]));
  const link = linksIn(input.directory);
  // Named only when there is more than one live workspace. In a single-workspace account the
  // name is on every row and says nothing, which is the same judgement the findings make.
  // Read through `Array.isArray` rather than off the type, for the reason `linksIn` gives: a reading can
  // come from an imported collection an older collector wrote, and this runs after the estate has been
  // read — so a shape that surprises it loses a whole run rather than losing the names on the rows.
  const live = rowsOf(input.directory?.live);
  const known = rowsOf(input.directory?.workspaces);
  const workspaces =
    live.length > 1 ? new Map(known.map((workspace) => [workspace.workspaceId, workspace.name])) : undefined;

  const candidates: JobReadiness[] = [];
  let alreadyServerless = 0;
  let onWarehouse = 0;

  for (const row of input.readiness) {
    // Nothing classic and nothing unclassified: this job is already where the requirement
    // wants it, so it is counted and not listed. Counting it matters — an estate of eighty
    // serverless jobs and two classic ones should read as nearly done, and a list of two
    // jobs with no denominator does not say that.
    if (row.classicUses === 0 && row.unclassifiedUses === 0) {
      if (row.serverlessUses > 0) alreadyServerless += 1;
      else if (row.warehouseUses > 0) onWarehouse += 1;
      continue;
    }

    const found = key(row.workspaceId, row.jobId);
    candidates.push({
      ...assess(row, named.get(found), spending.get(found), rule),
      ...optional('workspace', workspaces?.get(row.workspaceId)),
      ...optional('link', link(asJob(row))),
    });
  }

  // By what the migration is worth, so the reader's attention goes where the money is, with
  // the run count breaking ties: a job with no attributed spend but four hundred runs is
  // still worth more than one that ran once.
  const ordered = [...candidates].sort(
    (a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.runs - a.runs || a.jobId.localeCompare(b.jobId)
  );
  const listed = ordered.slice(0, LISTED);

  const counts: Record<Verdict, number> = { ready: 0, rework: 0, blocked: 0, unknown: 0 };
  for (const job of ordered) counts[job.verdict] += 1;

  const currency = ordered.find((job) => job.currency != null)?.currency;
  const cost = ordered.reduce((total, job) => total + (job.cost ?? 0), 0);

  // Only the jobs that could move. Pricing a hard blocker's migration would be pricing
  // something that cannot happen, and including it would make the total read as available.
  const priced = ordered.filter((job) => job.estimate != null && (job.verdict === 'ready' || job.verdict === 'rework'));
  // Named only when every priced job was read at the same rate. An account spanning two
  // regions has a total that is a sum across two price lists, and naming one of them would
  // say the whole figure came from there.
  const regions = new Set(priced.map((job) => job.estimate?.region));

  return {
    lookbackDays: input.lookbackDays,
    jobsRan: input.readiness.length,
    alreadyServerless,
    onWarehouse,
    jobs: listed,
    counts,
    ...(cost > 0 ? { cost: round(cost) } : {}),
    ...(currency != null ? { currency } : {}),
    ...(priced.length > 0
      ? {
          estimate: {
            low: round(priced.reduce((total, job) => total + (job.estimate?.low ?? 0), 0)),
            high: round(priced.reduce((total, job) => total + (job.estimate?.high ?? 0), 0)),
            currency: priced[0]?.estimate?.currency ?? 'USD',
            jobs: priced.length,
            ...(regions.size === 1 && priced[0]?.estimate?.region != null ? { region: priced[0].estimate.region } : {}),
          },
        }
      : {}),
    assumptions: ruleset.assumptions,
    caveat: reasonOf(rule('outside-metadata'), 'Every verdict on this page is about compute, not code.'),
    ...(ordered.length > listed.length ? { truncated: { listed: listed.length, found: ordered.length } } : {}),
  };
}

/**
 * One job's verdict.
 *
 * Each rule fires from a count rather than from a boolean, so the sentence the reader gets
 * says how many clusters or runs were involved. "Two of this job's clusters run an init
 * script" is actionable in a way that "init scripts: yes" is not.
 */
function assess(
  row: JobReadinessRow,
  job: JobRow | undefined,
  spend: JobSpendRow | undefined,
  rule: (id: RuleId) => ServerlessRule
): JobReadiness {
  const reasons: Reason[] = [];
  // The numbers are the third argument rather than parsed back out of the sentence, which is the only
  // way the two cannot drift: one call site writes both, and a rule that fires on a count it does not
  // pass here carries no evidence rather than a number nobody checked.
  const add = (id: RuleId, observed: string, evidence: readonly Evidence[] = []) =>
    reasons.push(reasonOf(rule(id), observed, evidence));

  /** A count of clusters, which is what most of these rules fire on. */
  const of = (label: string, value: number): readonly Evidence[] => [{ label, value, unit: 'count' }];

  if (row.gpuClusters > 0) {
    add(
      'gpu-cluster',
      `${clusters(row.gpuClusters)} this job ran on had GPU workers.`,
      of('Clusters with GPU workers', row.gpuClusters)
    );
  }
  if (row.longestTaskSeconds > SEVEN_DAYS_SECONDS) {
    add(
      'run-exceeds-seven-days',
      `Its longest task run took ${days(row.longestTaskSeconds)}, past the seven-day serverless ceiling.`,
      // In milliseconds, because that is the unit every other advisor reports a duration in, and a
      // baseline read in seconds here would be compared against a later reading taken in the other.
      [{ label: 'Longest task run', value: row.longestTaskSeconds * 1000, unit: 'ms' }]
    );
  }

  if (row.initScriptClusters > 0) {
    add(
      'init-script',
      `${clusters(row.initScriptClusters)} it ran on had at least one init script.`,
      of('Clusters running an init script', row.initScriptClusters)
    );
  }
  if (row.pooledClusters > 0) {
    add(
      'instance-pool',
      `${clusters(row.pooledClusters)} it ran on drew nodes from an instance pool.`,
      of('Clusters drawing from a pool', row.pooledClusters)
    );
  }
  if (row.cloudIdentityClusters > 0) {
    add(
      'cloud-identity',
      `${clusters(row.cloudIdentityClusters)} it ran on carried an instance profile or service account.`,
      of('Clusters carrying a cloud identity', row.cloudIdentityClusters)
    );
  }
  if (row.legacyAccessModeClusters > 0) {
    add(
      'legacy-access-mode',
      `${clusters(row.legacyAccessModeClusters)} it ran on used no-isolation or a pre-Unity-Catalog access mode.`,
      of('Clusters on a legacy access mode', row.legacyAccessModeClusters)
    );
  }
  if (row.mlRuntimeClusters > 0) {
    add(
      'ml-runtime',
      `${clusters(row.mlRuntimeClusters)} it ran on used an ML runtime.`,
      of('Clusters on an ML runtime', row.mlRuntimeClusters)
    );
  }
  if (row.oldestRuntimeMajor != null && row.oldestRuntimeMajor < OLDEST_SERVERLESS_RUNTIME_MAJOR) {
    const seen = row.runtimes.length > 0 ? ` (${row.runtimes.join(', ')})` : '';
    add(
      'runtime-predates-serverless',
      `Its oldest runtime was version ${String(row.oldestRuntimeMajor)}${seen}, older than any serverless environment.`
    );
  }
  if (job?.continuous === true) {
    add('continuous-trigger', 'The job is configured to run continuously.');
  }

  if (row.unclassifiedUses > 0) {
    add(
      'compute-unclassified',
      `${row.unclassifiedUses} of its ${row.computeUses} recorded compute uses could not be classified.`,
      [
        { label: 'Compute uses not classified', value: row.unclassifiedUses, unit: 'count' },
        { label: 'Compute uses recorded', value: row.computeUses, unit: 'count' },
      ]
    );
  }
  if (row.unreadClusters > 0) {
    add(
      'cluster-unreadable',
      `${clusters(row.unreadClusters)} it used had no configuration on record.`,
      of('Clusters with no configuration on record', row.unreadClusters)
    );
  }
  const unwritten = row.unknownInitScriptClusters + row.unknownAccessModeClusters;
  if (unwritten > 0) {
    add(
      'configuration-unwritten',
      row.unknownInitScriptClusters > 0 && row.unknownAccessModeClusters > 0
        ? `Init scripts and access mode were unrecorded on some of the clusters it used.`
        : row.unknownInitScriptClusters > 0
          ? `Init scripts were unrecorded on ${clusters(row.unknownInitScriptClusters)} it used.`
          : `Access mode was unrecorded on ${clusters(row.unknownAccessModeClusters)} it used.`,
      of('Clusters with unrecorded configuration', unwritten)
    );
  }

  if (row.allPurposeClusters > 0) {
    add(
      'all-purpose-cluster',
      `${clusters(row.allPurposeClusters)} it ran on was interactive compute.`,
      of('Interactive clusters', row.allPurposeClusters)
    );
  }
  if (row.policyClusters > 0) {
    add(
      'policy-governed',
      `${clusters(row.policyClusters)} it ran on was created under a compute policy.`,
      of('Clusters created under a policy', row.policyClusters)
    );
  }

  const money = estimateFor(row, spend);

  return {
    workspaceId: row.workspaceId,
    jobId: row.jobId,
    name: job?.name ?? `Job ${row.jobId}`,
    verdict: verdictOf(reasons),
    runs: row.runs,
    classicClusters: row.classicClusters,
    reasons,
    clusters: row.clusterNames,
    ...(row.lastRun != null ? { lastRun: row.lastRun } : {}),
    ...money,
  };
}

/**
 * Blocked, then rework, then unknown, then ready.
 *
 * The precedence is the whole judgement of this function and the reasoning is in the file
 * header: an unknown is a hole in the evidence, and a hole does not erase the actionable
 * thing found beside it.
 */
function verdictOf(reasons: readonly Reason[]): Verdict {
  if (reasons.some((reason) => reason.kind === 'blocker')) return 'blocked';
  if (reasons.some((reason) => reason.kind === 'rework')) return 'rework';
  if (reasons.some((reason) => reason.kind === 'unknown')) return 'unknown';
  return 'ready';
}

/**
 * What the job costs now and what it might cost on serverless.
 *
 * The range spans one measured quantity: the start-up time classic compute billed and
 * serverless does not. Its width is therefore this job's own idle share rather than a
 * confidence interval, and the assumptions list says so. Where the price list holds no
 * serverless rate for the region, there is no estimate at all and the reason is carried,
 * because a zero here would read as free.
 */
function estimateFor(
  row: JobReadinessRow,
  spend: JobSpendRow | undefined
): Pick<JobReadiness, 'cost' | 'currency' | 'estimate' | 'noEstimate' | 'startupShare'> {
  if (spend == null || spend.classicDbus <= 0) return {};

  const base = {
    cost: spend.classicCost,
    ...(spend.currency != null ? { currency: spend.currency } : {}),
  };

  // A coalesced $0 for an unpriced SKU would read as a free job. Leave the estimate absent.
  if (spend.unpricedRecords > 0) {
    return {
      ...base,
      noEstimate:
        `${agreeing(spend.unpricedRecords, 'usage record').noun} for this job ` +
        `${agreeing(spend.unpricedRecords, 'usage record').verb} no matching list price, so its serverless cost ` +
        'is not estimated rather than computed over an incomplete bill.',
    };
  }

  if (spend.serverlessRate == null) {
    return {
      ...base,
      // Two different absences, and the reader can act on one of them. A workspace with no
      // region established has no serverless usage of any kind for the region to be read
      // from, which one serverless query would fix; a region with no published rate is the
      // price list's answer and there is nothing to do about it.
      noEstimate:
        spend.serverlessRegion == null
          ? 'This workspace has no serverless usage of any kind in the window, so which region’s ' +
            'published rate applies to it could not be established. Serverless SKUs name their region ' +
            'and classic ones do not, so there is nothing here to read it from and the cost is left ' +
            'unestimated rather than guessed at.'
          : `Your price list holds no serverless jobs rate for this job’s tier in ${spend.serverlessRegion}, ` +
            'so its serverless cost is not estimated rather than guessed at.',
    };
  }

  const measured = row.setupSeconds + row.executionSeconds;
  const startupShare = measured > 0 ? row.setupSeconds / measured : 0;
  const high = spend.classicDbus * spend.serverlessRate;

  return {
    ...base,
    estimate: {
      low: round(high * (1 - startupShare)),
      high: round(high),
      currency: spend.currency ?? 'USD',
      ...(spend.serverlessRegion != null ? { region: spend.serverlessRegion } : {}),
    },
    ...(measured > 0 ? { startupShare } : {}),
  };
}

function reasonOf(rule: ServerlessRule, observed: string, evidence: readonly Evidence[] = []): Reason {
  return {
    ruleId: rule.id,
    kind: rule.kind,
    action: rule.action,
    headline: rule.headline,
    detail: rule.detail,
    docUrl: rule.docUrl,
    observed,
    evidence,
  };
}

function empty(lookbackDays: number): ServerlessReadiness {
  const ruleset = serverlessRules();
  const caveat = ruleset.rules.get('outside-metadata');
  if (caveat == null) throw new Error('The serverless ruleset has no rule outside-metadata.');
  return {
    lookbackDays,
    jobsRan: 0,
    alreadyServerless: 0,
    onWarehouse: 0,
    jobs: [],
    counts: { ready: 0, rework: 0, blocked: 0, unknown: 0 },
    assumptions: ruleset.assumptions,
    caveat: reasonOf(caveat, 'Every verdict on this page is about compute, not code.'),
  };
}

function key(workspaceId: string, jobId: string): string {
  return `${workspaceId}/${jobId}`;
}

/** A field only when there is one, so an absent value is absent rather than undefined. */
function optional<K extends string, V>(name: K, value: V | undefined): Partial<Record<K, V>> {
  return value == null ? {} : ({ [name]: value } as Record<K, V>);
}

function clusters(count: number): string {
  return count === 1 ? 'One cluster' : `${count} clusters`;
}

function days(seconds: number): string {
  const value = seconds / 86400;
  return `${value.toFixed(1)} days`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
