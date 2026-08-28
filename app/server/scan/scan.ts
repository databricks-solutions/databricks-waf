// Running a scan.
//
// The orchestration is deliberately thin, because everything difficult has been pushed
// into a layer that can be tested on its own: the scheduler owns load, the collectors
// own evidence, the resolvers own judgement, the scorer owns arithmetic. What is left
// here is the order they happen in and the stamp that says what the result can be
// compared against.
//
// The one real decision in this file is that collection failure is not scan failure. A
// signal that cannot be collected produces controls that say why, and the scan
// completes. The opposite design — abort on first error — would mean a single revoked
// grant on one system table denies the customer the other 30 controls, which is a
// worse answer than a partial one that names its own gaps.

import { randomUUID } from 'node:crypto';
import type { CollectorSpend, SignalId, SignalResult } from '../collect/signal.js';
import type { DatabricksCredentials, ExecutionMode } from '../collect/credentials.js';
import type { EstateScope } from '../collect/estate-scope.js';
import type { Catalogue, CatalogueControl } from '../catalogue/catalogue.js';
import type { Attestation } from '../attest/attestation.js';
import type { Finding } from '../resolve/finding.js';
import { resolveControl, type ResolverRegistry } from '../resolve/resolver.js';
import { pillarsEmptiedByDecision, scoreFindings, type Score } from '../score/score.js';
import { applyDecisions, exposureOf } from '../apply/apply.js';
import type { ApplicabilityDecision } from '../apply/applicability.js';
import { CollectionScheduler, type ScanFootprint } from './scheduler.js';
import { summariseEstate, type EstateSummary } from './estate.js';
import { merged } from '../import/signals.js';
import { PUBLIC_METHODOLOGY, type PublicMethodologyIdentity } from '../methodology/identity.js';
import { exclusionKeys, runIdentity, type RunDefinition, type RunIdentity } from './identity.js';
import { collectSignals, withInputs, type CollectionOptions } from '../collect/collection.js';

/**
 * What started a run.
 *
 * `scheduled` means nobody was watching, which is the only reason the distinction is worth
 * recording: an unattended run has no one to notice that it measured nothing, so the endpoint
 * that serves it refuses rather than reports when a run comes back blind.
 */
export type ScanTrigger = 'interactive' | 'scheduled';

/**
 * What a scan's results can legitimately be compared against.
 *
 * Every field here is a reason two scans are not comparable. A different executing
 * identity sees a different estate; a different catalogue version asks different
 * questions; a different scope covers different workspaces. Recording them together
 * means the trend view can refuse a comparison and say which field differs, instead of
 * drawing a line that implies the estate changed when only the observer did.
 */
export interface ScanStamp {
  /**
   * The customer release this run belongs to. Absent on development runs recorded before public
   * methodology releases existed; absence is never backfilled or inferred from catalogue revision.
   */
  readonly publicMethodology?: PublicMethodologyIdentity;
  readonly catalogueVersion: string;
  readonly catalogueFingerprint: string;
  readonly executionMode: ExecutionMode;
  /** Who the scan ran as. A user and a service principal do not see the same estate. */
  readonly actor: string;
  /**
   * What that identity called itself, for display. Not a reason two scans are incomparable.
   *
   * It sits among the fields that are, and does not join them, which is worth saying plainly: two
   * runs by the same principal either side of a rename are the same observer seeing the same estate,
   * so refusing to compare them over a changed label would manufacture a caveat out of an
   * administrative edit. `actor` is what decides that, and it does not change.
   */
  readonly actorName?: string;
  /**
   * Whether somebody pressed the button or a schedule did.
   *
   * Deliberately not a reason two scans are incomparable, which is why it sits below the fields
   * that are. How a run was started says nothing about what it could see: a schedule and a
   * person invoking the same identity ask the same questions of the same estate and get the same
   * answers. `actor` and `executionMode` above are what decide visibility, and they already
   * refuse the comparison when they differ.
   *
   * Optional because it records something older runs did not record. Absent means a run from
   * before this was written, which is different from a run known to be interactive, and
   * back-filling it with a guess would put a fact in the history that was never measured.
   */
  readonly trigger?: ScanTrigger;
  readonly scope: EstateScope;
  readonly lookbackDays: number;
  /**
   * The workspaces this scan actually assessed, sorted.
   *
   * Not a reason to refuse a comparison, which is why it sits apart from the fields above.
   * If a workspace was added with poor configuration, the score drop is real and the trend
   * should draw it. But the tool cannot tell that case from the one where the identity's
   * grants widened and the estate never changed, so the comparison is annotated rather
   * than either refused or drawn silently.
   */
  readonly assessedWorkspaces?: readonly string[];
  /**
   * The assessment this run answers to, when it was started from one.
   *
   * Absent means nobody asked for a defined assessment — the run was started directly, which is
   * every run before assessment definitions existed and every ad-hoc run since. Absent is therefore
   * a fact rather than a gap, and `definitionBarrier` treats a defined run and a direct one as two
   * different things rather than as a missing field.
   */
  readonly definition?: RunDefinition;
  /**
   * What produced the run: the build, the scoring method, the encoding, the surfaces that answered.
   *
   * Optional because runs recorded before this existed do not carry it, and back-filling it would
   * put a fact in the history that was never measured. `identityBarriers` says what an absent one
   * means for a comparison rather than assuming it means agreement.
   */
  readonly identity?: RunIdentity;
}

export {
  comparable,
  stampEnough,
  type Comparability,
  type ComparabilityOptions,
} from '../../shared/api/comparability.js';

export type ScanState = 'complete' | 'partial';

/**
 * Which run measured a pillar, and whether it was this one.
 *
 * Exists because a targeted rerun produces a result whose pillars were measured at
 * different times by possibly different people. Without this, a scan carrying six pillars
 * forward from last Tuesday would present all seven under one timestamp, and the reader
 * would take a week-old pillar for a fresh measurement — which is the single most
 * misleading thing a rerun feature could do.
 */
export interface PillarMeasurement {
  readonly pillarId: string;
  /** The run that measured it. Equal to the containing scan's id when this run did. */
  readonly scanId: string;
  readonly measuredAt: Date;
  readonly actor: string;
  /** True when the pillar came from an earlier run rather than this one. */
  readonly carriedForward: boolean;
}

export interface Scan {
  readonly id: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly state: ScanState;
  readonly stamp: ScanStamp;
  readonly score: Score;
  readonly findings: readonly Finding[];
  readonly signals: readonly SignalResult[];
  /**
   * Which workspaces this scan covered, and which it skipped with the status that
   * excluded them.
   *
   * On the scan rather than derived in the API layer because it is a property of the
   * result: a stored scan whose workspace set has to be recomputed from its signals is a
   * stored scan that can disagree with itself.
   */
  readonly estate: EstateSummary;
  /**
   * The pillars this run was asked to measure. Absent means every pillar the build assesses.
   *
   * Recorded as asked rather than as delivered, so a run that was requested for one pillar
   * and produced seven is legible as a rerun that carried six forward, not as a full scan.
   */
  readonly requestedPillars?: readonly string[];
  /** Where each pillar in this result was measured. One entry per pillar with findings. */
  readonly measurement: readonly PillarMeasurement[];
  /**
   * Why a targeted run's untouched pillars are absent rather than carried forward.
   *
   * Set only when a rerun could not reuse the previous scan — a different catalogue, a
   * different identity, no previous scan at all. Said rather than silently producing a
   * result that looks like the estate lost four pillars overnight.
   */
  readonly notCarried?: string;
  readonly footprint: ScanFootprint;
  /**
   * What the scan itself consumed, as reported by the collectors that know.
   *
   * Separate from `footprint`, which is the scheduler's view — tasks, budgets and
   * limiter state. This is the surface's own accounting: bytes scanned, rows returned,
   * and the statement ids the customer can audit the claim against.
   */
  readonly spend: readonly CollectorSpend[];
  /**
   * Present when the scan stopped short of its plan. Named rather than implied by a
   * count, because "stopped at the query budget" and "cancelled" call for different
   * responses from the reader.
   */
  readonly incompleteReason?: string;
}

/**
 * Everything a scan needs, which is what reading the estate needs plus what scoring it needs.
 *
 * Extending `CollectionOptions` rather than restating its fields, so the shape the collection loop
 * depends on is stated once and a scan cannot drift from what an advisory run passes it.
 */
export interface RunScanOptions extends CollectionOptions {
  readonly catalogue: Catalogue;
  readonly registry: ResolverRegistry;
  readonly scope: EstateScope;
  readonly scheduler?: CollectionScheduler;
  /**
   * The pillars to evaluate. Omitted means every pillar in the catalogue.
   *
   * Deliberately not recorded on the result as a request: this is which pillars to evaluate,
   * which a build restriction and a caller's rerun both produce. Only the runner can tell those
   * apart, so only the runner sets `requestedPillars`.
   */
  readonly pillars?: readonly string[];
  /**
   * The answers that still count, by control id, for requirements the platform cannot observe.
   *
   * Passed in rather than read here for the same reason the previous scan is: which answers
   * are current is the store's business, and a scan that fetched its own would be a scan that
   * could not be run against a synthetic estate. Omitted means none, which is what every
   * applicability test wants.
   */
  readonly attestations?: ReadonlyMap<string, Attestation>;
  /**
   * The customer's applicability decisions, by control id, newest first — what to take out of the score.
   *
   * Passed in rather than read here for the reason the attestations and imports are: which decisions are
   * on record is the store's business, and a scan that fetched its own could not be run against a
   * synthetic estate. Applied to the findings before they are scored, so an excluded requirement reads
   * `not-applicable` or `disabled` in the result and leaves the denominator, and the exposure — what was
   * removed and what lapsed — is carried on the score. Omitted means none, which is what every scan test
   * wants and what an install with no applicability store has. See `apply/apply.ts`.
   */
  readonly decisions?: ReadonlyMap<string, readonly ApplicabilityDecision[]>;
  /**
   * Scopes `app.yaml` requests, used only to tell a stale consent from a permanent refusal when
   * a signal is refused for want of one.
   *
   * Passed in rather than read here so a scan against a synthetic estate has no file system to
   * depend on. Omitted means every scope refusal reports as permanent, which is the safe
   * direction: telling somebody to re-authorise for a scope the app never asked for sends them
   * round a loop that cannot terminate.
   */
  readonly declaredScopes?: readonly string[];
  /**
   * The SQL warehouse the statements ran on, recorded so a reading can be reproduced.
   *
   * Passed in rather than read from the environment because it is the app's resource binding, which
   * the scan has no business knowing about, and because a test has no warehouse — absent means the
   * provenance on a SQL reading names no place, which is honest rather than convenient.
   */
  readonly warehouse?: string;
  /**
   * Readings an administrator collected and imported, filling only what this scan could not read.
   *
   * Passed in for the same reason the attestations are: which import is current is the store's
   * business, and a scan that fetched its own could not be run against a synthetic estate. Omitted
   * means none, which is what every test wants and what an install with nothing imported has.
   *
   * Ordering is not this caller's problem either — `merged` refuses to let an import replace an
   * observation, so passing several in any order yields the same map. See import/signals.
   */
  readonly imported?: ReadonlyMap<SignalId, SignalResult>;
  /** What started this run. Omitted means a person did, which is the only path with a person on it. */
  readonly trigger?: ScanTrigger;
  /**
   * The assessment definition this run answers to, if it was started from one.
   *
   * Passed in already resolved to id, version and fingerprint rather than as a definition to look
   * up, for the reason the attestations and imports are: which version is current is the store's
   * business, and a scan that read the store could not be run against a synthetic estate.
   */
  readonly definition?: RunDefinition;
  /**
   * Readings an earlier attempt at this run already collected.
   *
   * Seeded into the collection before it starts, and a collector whose every needed signal is already
   * there is skipped — which is the whole of what resumption buys. Distinct from `imported` and not a
   * special case of it: an imported reading is a statement by an administrator that fills what a scan
   * could not read, and refusing to let it replace an observation is the rule that keeps the two
   * apart. A resumed reading *is* an observation, made minutes ago by an attempt of this same run as
   * this same identity, so it is seeded as one.
   *
   * Passed in rather than read here for the reason the attestations and imports are: which readings a
   * run has reached is the run store's business, and a scan that fetched its own could not be run
   * against a synthetic estate.
   */
  readonly resume?: ReadonlyMap<SignalId, SignalResult>;
  /**
   * Called with readings as they settle, and again at the end of each collection unit with the rest.
   *
   * A unit is one collector, and that used to be the whole of the resumption grain: a killed attempt
   * lost whatever collector was in flight. The argument for stopping there was that finer would mean
   * checkpointing per statement, and the write would cost more than the read it saved. That was wrong
   * about the arithmetic. A checkpoint is one insert; a SQL signal is a statement against a customer's
   * warehouse, and the SQL collector reads eleven of them in sequence. So the choice was ten cheap
   * inserts against ten warehouse statements re-read, and the inserts win by orders of magnitude.
   *
   * A collector opts in by calling `context.settled` per signal — see `CollectorContext`. One that does
   * not is checkpointed once at the end of its unit, exactly as before, so the grain is each
   * collector's own business rather than a rule imposed on all of them.
   *
   * Awaited, so a checkpoint is on the record before the work after it starts. A fire-and-forget write
   * would let a kill land between the collection and its checkpoint, which is the case this exists to
   * cover.
   */
  readonly checkpoint?: (readings: readonly SignalResult[]) => Promise<void>;
  /**
   * Asked between units whether somebody has asked this run to stop.
   *
   * Separate from `signal` rather than folded into it, and the difference is where the request lives.
   * An `AbortSignal` is in this process's memory, so it only reaches a run this process is still
   * listening for; a cancel that has to survive a restart is a row, and reading a row is a promise.
   * Answering true cancels the scheduler, so the scan ends as partial with what it had.
   */
  readonly stopping?: () => Promise<boolean>;
}

export async function runScan(options: RunScanOptions): Promise<Scan> {
  const startedAt = new Date();
  const scheduler = options.scheduler ?? new CollectionScheduler();

  // Read once, up front. Taking the identity from the provider rather than from a
  // caller-supplied argument means the stamp cannot disagree with the credentials the
  // scan actually used, which is the whole basis on which two scans are compared.
  const identity = await options.credentials.databricks();

  const controls = options.catalogue.controls.filter(
    (control) => options.pillars == null || options.pillars.includes(control.pillarId)
  );

  const collected = await collect(controls, options, scheduler, identity);
  // Merged after collection rather than seeded before it, so an imported reading can never be what a
  // collector builds on: a collector that read one would be depending on a file, and its output would
  // be neither observed nor admin-collected but a mixture with no honest class. The estate summary
  // below reads the merged map, which is right — an imported workspace listing is still a listing.
  const signals = options.imported == null ? collected : merged(collected, options.imported);
  const resolveContext = options.declaredScopes != null ? { declaredScopes: options.declaredScopes } : {};
  const findings = controls.map((control) =>
    resolveControl(
      toSpec(control),
      signals,
      options.registry.get(control.id),
      options.attestations?.get(control.id),
      resolveContext
    )
  );

  const aliasOf = aliasLookup(options.catalogue);
  const footprint = scheduler.footprint();
  const estate = summariseEstate(signals);
  const id = randomUUID();
  const finishedAt = new Date();

  // The customer's applicability decisions, applied before scoring. An excluded requirement is rewritten
  // where it reads — `not-applicable` or `disabled` — so the stored findings, their counts and the score
  // all describe the same set, and a decision sitting over a reading that has since turned `fail` is set
  // aside rather than applied. The reading judged is this run's own, resolved a moment ago, which is why
  // the lapse is decided on every scan. See `apply/apply.ts`.
  const applied = applyDecisions(findings, (controlId) => options.decisions?.get(controlId) ?? [], finishedAt);
  // A pillar whose last scored requirement was excluded leaves the estate mean without any arithmetic
  // going wrong, and without the page saying a pillar left. Counted here, where both readings of the
  // findings exist, and rendered as a count — never as which pillar.
  const exposure = exposureOf(applied, pillarsEmptiedByDecision(findings, applied.findings, { aliasGroupOf: aliasOf }));

  return {
    id,
    startedAt,
    finishedAt,
    state: footprint.exhaustion == null && !footprint.cancelled ? 'complete' : 'partial',
    stamp: {
      publicMethodology: PUBLIC_METHODOLOGY,
      catalogueVersion: options.catalogue.version.version,
      catalogueFingerprint: options.catalogue.version.fingerprint,
      executionMode: identity.mode,
      actor: identity.actor,
      ...(identity.actorName != null ? { actorName: identity.actorName } : {}),
      trigger: options.trigger ?? 'interactive',
      scope: options.scope,
      lookbackDays: options.lookbackDays,
      // Omitted, not empty, when the directory could not be read. An empty list would
      // compare as "no workspaces assessed" and manufacture a drift caveat out of a
      // measurement the scan never made.
      ...(estate.undeterminedReason == null
        ? { assessedWorkspaces: estate.assessed.map((workspace) => workspace.id).sort() }
        : {}),
      ...(options.definition != null ? { definition: options.definition } : {}),
      // Assembled from the readings rather than from the configuration, so `sources` says what
      // answered rather than what was bound. The exclusions are the requirements this run's decisions
      // took out of the denominator — the excluded ones, not the lapsed ones, since a lapse left its
      // requirement in the score — so a later comparison refuses a trend across a change in the set.
      // See identity.ts.
      identity: runIdentity([...signals.values()], {
        exclusions: exclusionKeys(exposure?.excluded ?? []),
      }),
    },
    score: { ...scoreFindings(applied.findings, { aliasGroupOf: aliasOf }), ...(exposure != null ? { exposure } : {}) },
    findings: applied.findings,
    signals: [...signals.values()],
    estate,
    // Derived from the findings rather than from the requested pillars, so a pillar that
    // was asked for and produced nothing does not claim to have been measured.
    measurement: [...new Set(applied.findings.map((finding) => finding.pillarId))].map((pillarId) => ({
      pillarId,
      scanId: id,
      measuredAt: finishedAt,
      actor: identity.actor,
      carriedForward: false,
    })),
    footprint,
    // Only collectors that measured something report; the rest are absent rather than
    // present with zeroes, so an empty entry never reads as "this cost nothing".
    spend: options.collectors.flatMap((collector) => (collector.spent != null ? [collector.spent()] : [])),
    ...(footprint.cancelled
      ? { incompleteReason: 'The scan was cancelled. Controls that had not been collected are reported as unmeasured.' }
      : footprint.exhaustion != null
        ? { incompleteReason: describeExhaustion(footprint.exhaustion) }
        : {}),
  };
}

/**
 * Which limit stopped the scan, named so the reader knows what to change.
 *
 * "Partial" on its own invites a support ticket. "Stopped after 40 queries against
 * the warehouse budget" tells someone either to raise the budget or to accept the
 * result, which are the only two useful responses.
 */
function describeExhaustion(exhaustion: NonNullable<ScanFootprint['exhaustion']>): string {
  const tail =
    'Controls it did not reach are reported as unmeasured rather than failed, and the score covers only what ' +
    'was measured.';

  return exhaustion.kind === 'surface-budget'
    ? `The scan stopped after reaching its budget of ${exhaustion.limit} ${exhaustion.surface} operations. ${tail}`
    : `The scan stopped after ${Math.round(exhaustion.elapsedMs / 1000)}s, against a limit of ${Math.round(exhaustion.limitMs / 1000)}s. ${tail}`;
}

/**
 * Collect every signal the plan needs, one collector at a time.
 *
 * Sequential across collectors rather than parallel, because parallelism between them
 * would put two surfaces' worth of work in flight at once and the per-surface limits
 * would no longer bound total load. Within a collector, the scheduler decides.
 */
async function collect(
  controls: readonly CatalogueControl[],
  options: RunScanOptions,
  scheduler: CollectionScheduler,
  identity: DatabricksCredentials
): Promise<Map<SignalId, SignalResult>> {
  return collectSignals(plan(controls, options), options, scheduler, identity);
}

/**
 * Which signals a set of controls needs read.
 *
 * All that is left here of what used to be the collection loop, and the only part of it that is about
 * an assessment: the loop itself moved to `collect/collection.ts` when the advisory run needed it, and
 * an advisory run has no controls to derive a set from. See ADR 0069.
 */
function plan(controls: readonly CatalogueControl[], options: RunScanOptions): Set<SignalId> {
  const needed = new Set(options.registry.signalsFor(controls.map((control) => control.id)));

  // Precondition signals are part of the plan even though no resolver asks for them.
  // Without this an applicability rule silently never fires: its signal is absent, the
  // precondition reads as undetermined, and the control is assessed as applicable —
  // which is exactly how an all-serverless estate ends up with cluster-policy
  // failures. The rule would be present in the catalogue and dead in practice.
  for (const control of controls) {
    for (const precondition of control.preconditions ?? []) needed.add(precondition.signal);
  }

  // The serverless analyzer's signals are deliberately not forced in here any more. They were,
  // for as long as the per-job analysis rode the scan: no resolver reads them, so without a
  // forced entry they were filtered out of the plan and the analysis found nothing, which looked
  // exactly like an estate with no classic jobs. Row 33d moved that analysis onto the advisory
  // run, so an assessment no longer pays for two account-wide statements to produce a page it
  // does not serve. The four requirements they stood behind are scored from the estate-wide
  // spend aggregate and are unaffected.

  // And so are the inputs of any collector that is going to run, for the same reason one
  // step removed: the per-table pass needs a table sample that no control reads, so
  // without this the sample is filtered out and the pass finds nothing to describe.
  return withInputs(needed, options.collectors);
}

function toSpec(control: CatalogueControl) {
  return control;
}

/** Which alias group a control belongs to, so a cross-pillar requirement is scored once. */
export function aliasLookup(catalogue: Catalogue): (controlId: string) => string | undefined {
  const groups = new Map<string, string>();
  for (const [group, controls] of catalogue.aliasGroups) {
    for (const control of controls) groups.set(control.id, group);
  }
  return (controlId) => groups.get(controlId);
}
