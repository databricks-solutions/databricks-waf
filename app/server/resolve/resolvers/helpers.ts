// Shared machinery for resolvers.
//
// Every resolver has the same first three steps — find the signal, give up
// gracefully if it could not be measured, produce evidence that names both what
// was seen and what was expected — and only then does the interesting part differ.
// Written out per resolver, those steps drift: one forgets the unmeasurable path
// and reports a permission error as a failed control, another omits the expectation
// and leaves a finding nobody can act on.

import type { SignalId, SignalResult } from '../../collect/signal.js';
import type { JobRow, PriceCoverage, WorkspaceDirectory } from '../../collect/sql/shapes.js';
import type { EvidenceClass } from '../evidence-class.js';
import type { Evidence, LocatedItem, Outcome, Unmeasured } from '../finding.js';
import { describeItem } from '../finding.js';
import type { EstateObject } from '../locate.js';
import { linksIn } from '../locate.js';
import type { ControlResolver, ControlSpec, Resolution } from '../resolver.js';

export interface Observation {
  readonly signals: ReadonlyMap<SignalId, SignalResult>;
  readonly spec: ControlSpec;
}

/**
 * A resolver over one signal.
 *
 * The unmeasurable case is handled here rather than in each evaluator, because it
 * is the case that matters most for trust: a control the tool could not read must
 * report that it could not be read, naming the reason, and must never be scored as
 * a failure. Penalising an unreadable permission would reward configuring the tool
 * to see less of the estate.
 */
export function fromSignal<T>(
  signal: SignalId,
  controls: readonly string[],
  evaluate: (value: T, context: Observation) => Resolution
): ControlResolver {
  return {
    controls: [...controls],
    requires: [signal],
    resolve(spec, signals) {
      const result = signals.get(signal);
      const unreadable = unmeasurableResolution(signal, result);
      if (unreadable != null) return unreadable;
      return evaluate(result!.value as T, { signals, spec });
    },
  };
}

/** A resolver over several signals, each of which must be readable. */
export function fromSignals(
  required: readonly SignalId[],
  controls: readonly string[],
  evaluate: (context: Observation) => Resolution
): ControlResolver {
  return {
    controls: [...controls],
    requires: [...required],
    resolve(spec, signals) {
      for (const signal of required) {
        const unreadable = unmeasurableResolution(signal, signals.get(signal));
        if (unreadable != null) return unreadable;
      }
      return evaluate({ signals, spec });
    },
  };
}

export function valueOf<T>(context: Observation, signal: SignalId): T {
  return context.signals.get(signal)!.value as T;
}

/**
 * Declares signals a resolver chooses between, rather than needs all of.
 *
 * They are added to `requires` so the scan collects them — the plan is built from what
 * resolvers declare, and an undeclared alternative is never collected, so the fallback
 * would find nothing forever. They are deliberately not put through the readability check
 * `fromSignals` applies: the point of an alternative is that one of them failing is
 * survivable, and only the resolver knows whether what did answer is enough.
 *
 * The obligation that comes with it: a resolver using this owns the case where none of them
 * answered, and must report each source's own reason. Otherwise a permission denial and an
 * empty preview table collapse into the same shrug.
 */
export function sourcedFrom(signals: readonly SignalId[], resolver: ControlResolver): ControlResolver {
  return { ...resolver, requires: [...resolver.requires, ...signals] };
}

/**
 * Declares signals a resolver reads for detail but does not need for its outcome.
 *
 * A wrapper rather than a parameter on `fromSignal` because the two lists mean different
 * things and putting them side by side in one call invites conflating them. Declaring is
 * necessary: the scan plan collects exactly what resolvers ask for, so an enrichment
 * nobody declares is never collected and the soft read finds nothing forever.
 */
export function enrichedBy(signals: readonly SignalId[], resolver: ControlResolver): ControlResolver {
  return { ...resolver, enrichedBy: [...signals], resolve: (spec, collected) => resolver.resolve(spec, collected) };
}

/**
 * A signal's value if it was observed, otherwise undefined.
 *
 * For enrichments only. A required signal must go through `fromSignal`, which reports the
 * collector's own reason for the failure; silently treating a permission denial as absent
 * detail would hide it.
 */
export function observedValue<T>(context: Observation, signal: SignalId): T | undefined {
  const result = context.signals.get(signal);
  return result?.status === 'observed' ? (result.value as T) : undefined;
}

function unmeasurableResolution(signal: SignalId, result: SignalResult | undefined): Resolution | undefined {
  if (result == null) {
    return {
      outcome: 'unmeasurable',
      evidence: [],
      outcomeReason: `The evidence for this control (${signal}) was not collected in this scan.`,
    };
  }
  if (result.status === 'unmeasurable') {
    return {
      outcome: 'unmeasurable',
      evidence: [],
      outcomeReason: result.unmeasurableReason ?? `The evidence for this control (${signal}) could not be read.`,
    };
  }
  return undefined;
}

export function evidenceFrom(context: Observation, signal: SignalId, observed: string, expected?: string): Evidence {
  const result = context.signals.get(signal)!;
  return {
    signal,
    observed,
    ...(expected != null ? { expected } : {}),
    coverage: result.coverage,
    collectedAt: result.collectedAt,
    // Carried off the signal rather than left on it, because the reader who wants to know where a
    // number came from is reading the finding, and the signal it names is a line in a different
    // page. Absent when the signal carries none, which is every fixture in every test.
    ...(result.provenance != null ? { provenance: result.provenance } : {}),
    ...(classOf(result) != null ? { evidenceClass: classOf(result) } : {}),
  };
}

/**
 * What the reading behind a piece of evidence is, derived rather than declared.
 *
 * Every resolver builds evidence through this function, so deriving the class here means no resolver
 * has to know that imported readings exist — which is the whole design of the bridge in
 * `server/import/signals.ts`. Fifty-odd resolvers each remembering to stamp a field would be fifty
 * places to forget it, and a forgotten one reports somebody's imported file as a measurement this app
 * made.
 *
 * Only `admin-cli` is named. `observed` is left absent rather than written, because `classOf` on the
 * finding already defaults to it and writing it on every one of thousands of evidence rows would grow
 * every stored scan for no new fact. Attestations never come through here at all: they arrive as an
 * `attested` on the finding, not as evidence.
 */
function classOf(result: SignalResult): EvidenceClass | undefined {
  return result.provenance?.authority === 'admin-cli' ? 'admin-collected' : undefined;
}

/**
 * Evidence that locates a gap the outcome already established, rather than deciding it.
 *
 * Kept out of the coverage reduction, so a sampled breakdown attached to a complete
 * measurement does not make the finding claim less than it measured. It carries no
 * `expected`, because there is nothing to compare it against: it is an answer to "where",
 * and the control's expectation was already stated by the evidence that answered "how much".
 */
export function detailFrom(context: Observation, signal: SignalId, observed: string): Evidence {
  return { ...evidenceFrom(context, signal, observed), bearing: 'detail' };
}

/**
 * Names a resource in a way its owner can act on.
 *
 * A finding reading "warehouse `analytics` does not auto-stop" is unactionable across an
 * account holding eleven workspaces, several of which will have an `analytics` anything.
 * So the workspace is appended — but only when more than one was assessed, because
 * qualifying every name in a single-workspace estate is noise that buries the finding.
 *
 * The workspace name comes from the directory signal the scan already collects. That
 * signal is read softly rather than declared as a requirement: a resolver whose evidence
 * is present must still produce a finding when only the labelling is unavailable, so an
 * unreadable directory degrades to printing the id rather than to unmeasurable.
 */
export function nameIn(context: Observation): (resource: Resource) => string {
  const qualifier = qualifierIn(context);
  return (resource) => {
    const where = qualifier(resource);
    return where == null ? resource.name : `${resource.name} (${where})`;
  };
}

/**
 * The workspace to qualify a name with, or nothing when qualifying would only add noise.
 *
 * Separate from `nameIn` because a rendered name and a linked one need different things. A link
 * whose text is "etl (field-eng)" claims the workspace is part of the resource's name; the reader
 * wants to click `etl` and to read where it is. Same words either way, so the two cannot disagree.
 */
export function qualifierIn(context: Observation): (resource: Resource) => string | undefined {
  const value = directoryIn(context);

  if (value == null || value.live.length < 2) return () => undefined;

  const names = new Map(value.workspaces.map((workspace) => [workspace.workspaceId, workspace.name]));
  return (resource) => {
    if (resource.workspaceId == null || resource.workspaceId === '') return undefined;
    return names.get(resource.workspaceId) ?? `workspace ${resource.workspaceId}`;
  };
}

interface Resource {
  readonly name: string;
  readonly workspaceId?: string;
}

/**
 * Detail evidence naming the resources a finding is about, and linking each to its own page.
 *
 * Every resolver that reports a share of the estate wants to say which members of it fall
 * short, and each was writing the same slice-name-and-count by hand with slightly different
 * truncation and punctuation. Doing it once makes the phrasing uniform and gives the links a
 * single place to come from.
 *
 * Returns no evidence for an empty list, so a passing control does not carry an empty
 * "offenders" line, and the caller does not need a conditional around the call.
 *
 * The cap is on both the prose and the links: an estate with 300 unscheduled jobs needs a
 * finding a person can read, and 300 links is a wall, not an action. The count tells them how
 * much is behind the first five.
 */
export function offenders<T extends { readonly name: string; readonly workspaceId?: string }>(
  context: Observation,
  signal: SignalId,
  lead: string,
  rows: readonly T[],
  locate: (row: T) => EstateObject,
  options: OffenderOptions<T> = {}
): readonly Evidence[] {
  if (rows.length === 0) return [];

  const limit = options.limit ?? 5;
  const qualifier = qualifierIn(context);
  const link = linksIn(directoryIn(context));
  const rest = rows.length - Math.min(rows.length, limit);

  const items: readonly LocatedItem[] = rows.slice(0, limit).map((row) => {
    const where = qualifier(row);
    const note = options.note?.(row);
    const object = locate(row);
    const url = link(object);
    return {
      label: row.name,
      ...(where != null ? { in: where } : {}),
      ...(note != null && note !== '' ? { note } : {}),
      ...(url != null ? { url } : {}),
      // Carried rather than rendered. A finding naming a cluster and a warehouse both called
      // `analytics` says which is which by where each link goes; a reader folding those lists
      // together has only the fields to go on. See `LocatedItemPayload.kind`.
      kind: object.kind,
    };
  });

  // The sentence and its parts, from the same list in the same order, so the two cannot disagree.
  const sentence =
    `${lead}: ${items.map(describeItem).join(', ')}` + (rest > 0 ? ` and ${rest.toLocaleString('en-US')} more` : '');

  return [
    {
      ...detailFrom(context, signal, sentence),
      at: { lead, items, ...(rest > 0 ? { more: rest } : {}) },
    },
  ];
}

export interface OffenderOptions<T> {
  /** How many to name before falling back to a count. Five keeps a finding readable. */
  readonly limit?: number;
  /**
   * Why this row is here, when the name alone does not say.
   *
   * Kept out of the link label: a link reading "dev-cluster (LEGACY_SINGLE_USER)" claims the
   * mode is part of the resource's name, and the reader is going to the cluster either way.
   */
  readonly note?: (row: T) => string | undefined;
}

/** The workspace directory, when it was read. Soft, for the same reason `nameIn` reads it softly. */
export function directoryIn(context: Observation): WorkspaceDirectory | undefined {
  const result = context.signals.get(WORKSPACES);
  return result?.status === 'observed' ? (result.value as WorkspaceDirectory) : undefined;
}

const WORKSPACES: SignalId = 'sql:estate.workspaces';

export interface Bands {
  /** At or above this share, the control passes. */
  readonly pass: number;
  /** At or above this share, partial credit. Below it, a failure. */
  readonly partial: number;
}

/**
 * Turn a share into an outcome.
 *
 * Partial exists because rounding a measured improvement down to a failure is how
 * a score stops being believed. An estate that moved auto-termination coverage from
 * 40% to 80% has done real work, and reporting no change teaches people the number
 * is not worth reading.
 */
export function bandOutcome(share: number | undefined, bands: Bands): Outcome {
  if (share == null) return 'unmeasurable';
  if (share >= bands.pass) return 'pass';
  if (share >= bands.partial) return 'partial';
  return 'fail';
}

/** A threshold from the catalogue, so a number can be changed without a code change. */
export function threshold(spec: ControlSpec, name: string, fallback: number): number {
  const value = spec.thresholds?.[name];
  return typeof value === 'number' ? value : fallback;
}

export function bandsOf(spec: ControlSpec, fallback: Bands): Bands {
  return {
    pass: threshold(spec, 'pass_share', fallback.pass),
    partial: threshold(spec, 'partial_share', fallback.partial),
  };
}

export function percent(share: number | undefined): string {
  return share == null ? 'not applicable' : `${Math.round(share * 1000) / 10}%`;
}

export function money(amount: number, currency = 'USD'): string {
  try {
    return amount.toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 0 });
  } catch {
    return `${amount.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${currency}`;
  }
}

/**
 * One percent of a unit's quantity: small enough that labs' 0.001% sample still scores, large enough
 * that a silent coalesce to $0 cannot hide a real gap.
 */
const MATERIAL_UNPRICED_SHARE = 0.01;

/**
 * Why a definitive monetary figure must not be reported over this window, or null when it may be.
 *
 * `figure` names what the caller was about to report, so each sentence says what is wrong with *that*
 * number rather than offering a general disclaimer: the three barriers spoil a figure in three
 * different ways and one tail cannot describe them all.
 *
 * The gate used to be a single ratio of pooled priced to unpriced quantity, over units that do not
 * add — see `PriceCoverage`. It now reads the least-covered unit, and where a statement returns no
 * per-unit coverage at all it refuses on the presence of unpriced rows rather than inventing a share
 * for them: not knowing how much of a unit is missing is not the same as knowing it is little.
 */
export function priceBarrier(coverage: PriceCoverage, figure: string): string | null {
  const duplicated = coverage.duplicatePriceMatches ?? 0;
  if (duplicated > 0) {
    const { noun, verb } = agreeing(duplicated, 'usage record');
    return `${noun} ${verb} more than one matching list price, so ${figure} would count some usage twice.`;
  }
  if ((coverage.currencies ?? 1) > 1) {
    return (
      `The window's usage is priced in ${String(coverage.currencies)} currencies, so ${figure} would ` +
      'add unlike amounts.'
    );
  }
  if (coverage.unpricedRecords <= 0) return null;
  const { noun, verb } = agreeing(coverage.unpricedRecords, 'usage record');
  const share = coverage.leastPricedShare;
  if (share == null) {
    return `${noun} ${verb} no matching list price, so ${figure} would be computed over an incomplete bill.`;
  }
  if (1 - share < MATERIAL_UNPRICED_SHARE) return null;
  return (
    `${noun} ${verb} no matching list price, and ${priceCoverageClause(coverage)}, so ${figure} would ` +
    'be computed over an incomplete bill.'
  );
}

/**
 * Coverage clause for monetary evidence: how well the price list covered the unit it covered worst.
 *
 * Named per unit because that is the only form in which the number means anything, and stated as the
 * *worst* unit because that is the one a reader would want warned about. The callers used to render a
 * pooled priced share followed by the word "missing" — so an estate with nothing priced read "0% of
 * usage quantity priced (USD) missing", the number with the opposite sense of the one it carries. The
 * clause closes its own sense so a caller cannot reopen it.
 */
export function priceCoverageClause(coverage: PriceCoverage): string {
  const share = coverage.leastPricedShare;
  if (share == null) {
    return coverage.unpricedRecords <= 0
      ? 'every usage record priced'
      : `${agreeing(coverage.unpricedRecords, 'usage record').noun} unpriced`;
  }
  const unit = coverage.leastPricedUnit ?? 'usage';
  const units = coverage.usageUnitCount ?? 1;
  return units > 1
    ? `${percent(share)} of ${unit} quantity priced, the least covered of ${String(units)} usage units`
    : `${percent(share)} of ${unit} quantity priced`;
}

export function bytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${Math.round(scaled * 10) / 10} ${units[unit]}`;
}

/**
 * A control whose population is empty leaves the denominator.
 *
 * Distinct from `satisfied-by-architecture`, which credits a pass. "You have no
 * classic clusters, so cluster sizing does not apply" and "serverless already
 * autoscales, so you get the credit" are different claims, and collapsing them
 * would either inflate a score by crediting the irrelevant or deflate it by
 * dropping credit that was earned.
 */
export function notApplicable(reason: string): Resolution {
  return { outcome: 'not-applicable', evidence: [], outcomeReason: reason };
}

export function satisfiedByArchitecture(reason: string, evidence: readonly Evidence[] = []): Resolution {
  return { outcome: 'satisfied-by-architecture', evidence, outcomeReason: reason };
}

/**
 * A control whose evidence arrived empty, which is not the same as compliant.
 *
 * A statement matching no rows still returns a row of zeroes, so an unread estate and a
 * clean one look alike by the time a resolver divides one count by another: zero
 * over-partitioned tables out of zero examined is arithmetically a pass. Every resolver
 * that reduces a population to a share has to decide this case explicitly, and the
 * decision is always the same — say nothing was measured, and say so in the score by
 * leaving the control unmeasured rather than crediting it.
 *
 * Separate from `notApplicable`, which is the answer when the population is empty
 * *and that is known to be the estate's real shape*. "You have no tables, so table
 * layout does not apply" is a measurement. "Nothing came back" is not.
 */
export function unmeasured(reason: string, kind?: Unmeasured): Resolution {
  return { outcome: 'unmeasurable', evidence: [], outcomeReason: reason, ...(kind != null ? { unmeasured: kind } : {}) };
}

/**
 * A count of things and the verb that agrees with it, kept in one place.
 *
 * The bug this exists to stop reached a customer four times over: the noun was pluralised from the count
 * and the verb was written as a constant, so a finding read "1 usage record … have no matching list
 * price". #211 fixed it for job triggers by agreeing them together at the site; these are the sites that
 * fix did not reach, and a helper is what stops the next sentence getting it wrong again. The verb often
 * sits a clause away from the noun, which is why both come back rather than one joined string.
 */
export function agreeing(count: number, noun: string, plural = `${noun}s`): { readonly noun: string; readonly verb: string } {
  return {
    noun: `${count.toLocaleString('en-US')} ${count === 1 ? noun : plural}`,
    verb: count === 1 ? 'has' : 'have',
  };
}

/**
 * The instant after which a null trigger field is the job's own, not the system table's.
 *
 * `trigger`, `trigger_type`, `paused`, `timeout_seconds`, `health_rules` and `deployment` are "not
 * populated for rows emitted before early December 2025" per the platform's reference for
 * `system.lakeflow.jobs` (https://docs.databricks.com/aws/en/admin/system-tables/jobs), and the same
 * page says a null `trigger_type` "can occur for older job records or jobs where the trigger type was
 * not configured" — the two states this app has to keep apart.
 *
 * The first day of the following year rather than a day in December, because "early December" is as
 * precise as the reference is and a row emitted mid-rollout would be read the wrong way by any date
 * inside it. Erring later only ever moves a job into the undecidable set, which is reported as unknown;
 * erring earlier would report a rollout date as a fact about the estate.
 */
const TRIGGER_COLUMNS_WRITTEN_FROM = new Date('2026-01-01T00:00:00.000Z');

/**
 * Whether this row's trigger fields were written, so reading them as absent means the job has none.
 *
 * The distinction the `_known` flag was added for, made properly. `scheduledKnown` is
 * `trigger IS NOT NULL`, and a job nobody scheduled has no trigger struct either — so it is false for
 * both a blank pre-rollout row and a genuinely manual job, and a predicate resting on it alone dropped
 * every manually-started job out of OE-02-04's denominator. That is the population the control exists
 * to find, so the automated share tended toward 100% on exactly the estate that should fail it.
 *
 * `changeTime` is what separates them: a row written after the columns existed and still carrying no
 * trigger is a job with no trigger. A row from before is genuinely undecidable, and each caller says so
 * rather than choosing a side.
 */
export function triggerRecorded(job: JobRow): boolean {
  if (job.scheduledKnown || job.continuous === true || (job.triggerType ?? '') !== '') return true;
  return job.changeTime != null && job.changeTime.getTime() >= TRIGGER_COLUMNS_WRITTEN_FROM.getTime();
}

/**
 * Whether this row records more than one trigger, so which mechanisms they are is not in it.
 *
 * `trigger_type` is `MULTIPLE` and `trigger` is null for a job with two or more triggers, by the
 * reference cited above: the set lives in a `triggers` array, which `jobs_inventory.sql` does not
 * project. So the row is post-rollout and fully written — `triggerRecorded` is true for it — and still
 * cannot answer "is this one triggered by file arrival" or "is this one continuous". A question about a
 * particular mechanism has to treat it as unread; a question about whether the platform starts the job
 * at all is answered by the `MULTIPLE` marker itself, since a job with two triggers has one.
 */
export function multipleTriggers(job: JobRow): boolean {
  return job.triggerType === 'MULTIPLE';
}

/** Whether a job's individual trigger mechanisms can be named from this row. */
export function triggerMechanismRecorded(job: JobRow): boolean {
  return triggerRecorded(job) && !multipleTriggers(job);
}
