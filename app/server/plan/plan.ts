// What a run will do, before it does it.
//
// Two questions this answers, both of which the app could previously only answer after the
// fact. An admin deciding whether to install asks what this will execute against their
// warehouse and control plane, and what it needs to be allowed to do. A user looking at a
// pillar scored from 5 of its 24 requirements asks which checks would have to run for the
// other 19, and finds out that most of them are not checks at all.
//
// The plan is derived from the same three things a scan is: the catalogue says which
// requirements belong to the pillar, the resolver registry says which signals answer them,
// and the descriptors say what collecting those signals involves. Nothing here restates a
// fact any of the three already holds, which is what makes the page a description of the
// scan rather than a second account of it that can disagree.

import type { Catalogue, CatalogueControl } from '../catalogue/catalogue.js';
import type { SignalId } from '../collect/signal.js';
import { beyondAnyApp } from '../collect/rest/families.js';
import type { ResolverRegistry } from '../resolve/resolver.js';
import { defaultLimits, type Surface } from '../scan/surfaces.js';
import { SURFACES, signalDescriptors, type Requirement, type SignalDescriptor, type SurfaceDescriptor } from './descriptors.js';

/**
 * How a signal serves a pillar's requirements.
 *
 * Three roles, because they fail differently and the reader's response to each differs. A
 * signal that decides an outcome takes its requirements with it when it cannot be read. One
 * that enriches costs detail only. One that gates decides whether a requirement applies at
 * all, and its absence is the quiet failure — an unread gate means a requirement that should
 * have been excluded gets assessed, which is how a serverless estate acquires cluster-policy
 * failures.
 */
export interface SignalRole {
  /** Requirements whose outcome rests on this signal. */
  readonly answers: readonly string[];
  /** Requirements this makes more specific without deciding them. */
  readonly enriches: readonly string[];
  /** Requirements whose applicability this decides. */
  readonly gates: readonly string[];
}

export interface PlannedSignal extends SignalDescriptor, SignalRole {
  /**
   * True when no requirement reads this signal and it is collected because another signal's
   * collector needs it. Marked rather than hidden: it is real work against the warehouse and
   * a cost the reader is entitled to see attributed.
   */
  readonly input: boolean;
}

/** One surface's share of a run, in the unit that surface is budgeted in. */
export interface SurfaceCost {
  readonly surface: Surface;
  /** Operations whose count is known before the run. */
  readonly fixed: number;
  /** Operations whose count follows the estate, named with their own ceiling. */
  readonly variable: readonly { readonly signal: string; readonly objects: string; readonly ceiling?: number }[];
  /** What the scan is allowed to spend here before it pauses and says so. */
  readonly budget: number;
}

/** Requirements no signal covers, split by what would answer them rather than lumped as unknown. */
export interface UnansweredControls {
  /** Practices the platform does not expose, which a person answers. */
  readonly attestation: number;
  /**
   * Configuration this app could read and no install of it may.
   *
   * Kept apart from `attestation` although both end up as a question for a person, because the
   * two questions are different and so is what should be done about them. An attestation asks
   * someone to describe a practice, and no API will ever answer it. This asks someone to read a
   * screen the app is refused access to — a platform gap with an owner, an ADR arguing for it,
   * and a day when it closes and these become measured.
   *
   * Kept apart from `planned` for the opposite reason: `planned` is a promise, and for these
   * there is nothing to wait for. Reporting 37 unreachable endpoints as planned work is what
   * this count exists to stop.
   */
  readonly unreachable: number;
  /** Checks this app intends to build and has not. */
  readonly planned: number;
  /** Requirements with no check and no plan for one. */
  readonly unimplemented: number;
}

export interface PillarPlan {
  readonly pillarId: string;
  readonly title: string;
  /** Whether a scan measures this pillar today. False means catalogued but not yet collected. */
  readonly measured: boolean;
  readonly totalControls: number;
  /** Requirements a check exists for. With `unanswered` this accounts for all of them. */
  readonly answeredControls: number;
  /**
   * Of those checks, how many need a scope Databricks Apps does not offer.
   *
   * A subset of `answeredControls` rather than a fourth kind of unanswered, because the check
   * is written and correct and would run the moment the platform offered the scope. Reported
   * because the two numbers together are the honest statement — nineteen requirements have a
   * check and eighteen of them cannot run here — and either alone is misleading in a different
   * direction. ADR 0016.
   */
  readonly blockedControls: number;
  readonly unanswered: UnansweredControls;
  readonly signals: readonly PlannedSignal[];
  /** Every requirement the signals above need, deduplicated across them. */
  readonly requires: readonly Requirement[];
  readonly cost: readonly SurfaceCost[];
}

export interface Plan {
  readonly surfaces: readonly SurfaceDescriptor[];
  readonly pillars: readonly PillarPlan[];
}

export interface PlanOptions {
  readonly catalogue: Catalogue;
  readonly registry: ResolverRegistry;
  /** Pillars a scan measures today. Absent means all of them. */
  readonly measuredPillars?: readonly string[];
  readonly descriptors?: readonly SignalDescriptor[];
}

export function buildPlan(options: PlanOptions): Plan {
  const descriptors = options.descriptors ?? signalDescriptors();
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const limits = defaultLimits();

  return {
    surfaces: SURFACES,
    pillars: options.catalogue.pillars.map((pillar) => {
      const controls = options.catalogue.controls.filter((control) => control.pillarId === pillar.id);
      const roles = rolesOf(controls, options.registry);
      const signals = plannedSignals(roles, byId);

      return {
        pillarId: pillar.id,
        title: pillar.title,
        measured: options.measuredPillars == null || options.measuredPillars.includes(pillar.id),
        totalControls: controls.length,
        answeredControls: controls.filter((control) => options.registry.get(control.id) != null).length,
        blockedControls: blocked(controls, options.registry, byId),
        unanswered: unanswered(controls, options.registry),
        signals,
        requires: dedupe(signals.flatMap((signal) => signal.requires)),
        cost: costOf(signals, limits),
      };
    }),
  };
}

/**
 * Which signals serve which of a pillar's requirements, and how.
 *
 * Built from the registry and the catalogue's own preconditions rather than from a declared
 * mapping, so a resolver that starts reading a second signal appears here without anyone
 * remembering to say so.
 */
function rolesOf(controls: readonly CatalogueControl[], registry: ResolverRegistry): Map<SignalId, SignalRole> {
  const roles = new Map<SignalId, { answers: string[]; enriches: string[]; gates: string[] }>();
  const role = (signal: SignalId) => {
    const existing = roles.get(signal);
    if (existing != null) return existing;
    const created = { answers: [], enriches: [], gates: [] };
    roles.set(signal, created);
    return created;
  };

  for (const control of controls) {
    const resolver = registry.get(control.id);
    for (const signal of resolver?.requires ?? []) role(signal).answers.push(control.id);
    for (const signal of resolver?.enrichedBy ?? []) role(signal).enriches.push(control.id);
    for (const precondition of control.preconditions ?? []) role(precondition.signal).gates.push(control.id);
  }

  return roles;
}

/**
 * The signals a run of this pillar collects, including the ones nothing asks for directly.
 *
 * The closure is taken over `derivedFrom` until it settles rather than in one pass, for the
 * same reason the scan's own collect loop does: an input can itself have an input, and one
 * pass would satisfy today's two-step chains and silently drop the first three-step one.
 */
function plannedSignals(
  roles: ReadonlyMap<SignalId, SignalRole>,
  byId: ReadonlyMap<SignalId, SignalDescriptor>
): readonly PlannedSignal[] {
  const needed = new Set<SignalId>(roles.keys());
  for (let added = true; added; ) {
    added = false;
    for (const id of [...needed]) {
      for (const input of byId.get(id)?.derivedFrom ?? []) {
        if (!needed.has(input)) {
          needed.add(input);
          added = true;
        }
      }
    }
  }

  const planned: PlannedSignal[] = [];
  for (const id of needed) {
    const descriptor = byId.get(id);
    // A signal a resolver names and no collector produces. It is a fault rather than a
    // condition, and it is left out here because a plan is not the place to report it: the
    // pairing test fails the build on it, and a scan reports the control unmeasured.
    if (descriptor == null) continue;
    const role = roles.get(id) ?? { answers: [], enriches: [], gates: [] };
    planned.push({
      ...descriptor,
      ...role,
      input: role.answers.length === 0 && role.enriches.length === 0 && role.gates.length === 0,
    });
  }

  // Ordered so the page reads in the order the run executes: surface by surface, and inputs
  // before the signals that consume them.
  const order: readonly Surface[] = ['sql', 'describe', 'rest', 'cloud', 'ai', 'plans'];
  return planned.sort(
    (a, b) => order.indexOf(a.surface) - order.indexOf(b.surface) || Number(b.input) - Number(a.input) || a.id.localeCompare(b.id)
  );
}

/**
 * Why a pillar's remaining requirements have no check.
 *
 * Three reasons rather than one count, because they are three different people's work. An
 * attestation is the customer's. A planned check is ours. An unimplemented one is a decision
 * nobody has made yet. Collapsing them into "unmeasured" is what makes a reader assume the
 * whole gap is somebody else's problem.
 */
function unanswered(controls: readonly CatalogueControl[], registry: ResolverRegistry): UnansweredControls {
  let attestation = 0;
  let unreachable = 0;
  let planned = 0;
  let unimplemented = 0;

  for (const control of controls) {
    if (registry.get(control.id) != null) continue;
    if (control.measurability === 'attestation') attestation += 1;
    // Ahead of `planned` on purpose. The catalogue marks a requirement `planned` whenever the guide
    // it came from names an API, whether or not an app can call it, so `planned` on its own
    // overstated what is coming by 37 — every one of them an endpoint no install reaches.
    else if (beyondAnyApp(control.collector)) unreachable += 1;
    else if (control.evaluatorStatus === 'planned') planned += 1;
    else unimplemented += 1;
  }

  return { attestation, unreachable, planned, unimplemented };
}

/**
 * Requirements whose check cannot run under any install, because every signal it reads needs a
 * scope Databricks Apps does not offer.
 *
 * `every` rather than `some`: a check reading two signals, one of them reachable, still produces
 * something. Only a check with no readable route at all is blocked.
 */
function blocked(
  controls: readonly CatalogueControl[],
  registry: ResolverRegistry,
  byId: ReadonlyMap<SignalId, SignalDescriptor>
): number {
  // Deliberately narrower than `beyondAnyInstall`, which also answers yes for a requirement whose
  // check was never written. This number is a subset of `answeredControls` and the checks page
  // subtracts it to get the count that actually runs, so admitting a control with no resolver would
  // make that subtraction produce a number below zero — as it briefly did. The ones with no
  // resolver are counted by `unanswered.unreachable` instead, where they belong.
  return controls.filter((control) => registry.get(control.id) != null && beyondAnyInstall(control, registry, byId))
    .length;
}

/**
 * Whether this requirement's check exists, is written, and cannot be authorised in any install.
 *
 * Exported because two callers need the same answer and they must not disagree. The plan page
 * counts these to tell the reader how many of a pillar's requirements no scan will ever decide;
 * the attestations route offers those same requirements to be answered. If the two computed it
 * differently, the page would promise work the other page did not present — which it did, briefly,
 * and the reader has no way to tell which of the two is lying.
 *
 * Distinct from "unmeasurable for this scope", which is a re-authorisation the reader can perform.
 * This is ADR 0016's case: a scope the platform does not grant to apps at all, so an answer from a
 * person is the only path that exists.
 */
export function beyondAnyInstall(
  control: CatalogueControl,
  registry: ResolverRegistry,
  byId: ReadonlyMap<SignalId, SignalDescriptor>
): boolean {
  const resolver = registry.get(control.id);
  if (resolver != null) {
    return resolver.requires.length > 0 && resolver.requires.every((signal) => ungrantable(byId.get(signal)));
  }

  /*
   * No resolver, so the question is whether one could ever run — answered from the endpoint the
   * catalogue names rather than from a signal that does not exist yet.
   *
   * Without this branch the 37 security requirements whose source is an account-plane endpoint or an
   * ungrantable workspace scope read as "a check is planned", which is a promise. Nobody can keep it:
   * see `collect/rest/families.ts` for the scope each one needs and ADR 0016 for what Apps grants.
   */
  return beyondAnyApp(control.collector);
}

/** Signal descriptors by id, so callers outside this module can use `beyondAnyInstall`. */
export function descriptorsById(
  descriptors: readonly SignalDescriptor[] = signalDescriptors()
): ReadonlyMap<SignalId, SignalDescriptor> {
  return new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
}

/** Whether every scope this signal needs is one Databricks Apps does not offer. */
function ungrantable(descriptor: SignalDescriptor | undefined): boolean {
  if (descriptor == null) return false;
  const scopes = descriptor.requires.filter((requirement) => requirement.kind === 'app-scope');
  return scopes.length > 0 && scopes.every((scope) => scope.grantable === false);
}

function costOf(signals: readonly PlannedSignal[], limits: Record<Surface, { budget: number }>): readonly SurfaceCost[] {
  const surfaces = [...new Set(signals.map((signal) => signal.surface))];
  return surfaces.map((surface) => {
    const mine = signals.filter((signal) => signal.surface === surface);
    return {
      surface,
      fixed: mine.filter((signal) => signal.cost.kind !== 'per-object').length,
      variable: mine
        .filter((signal) => signal.cost.kind === 'per-object')
        .map((signal) => ({
          signal: signal.id,
          objects: signal.cost.objects ?? 'objects in the estate',
          ...(signal.cost.ceiling != null ? { ceiling: signal.cost.ceiling } : {}),
        })),
      budget: limits[surface].budget,
    };
  });
}

/** One requirement per distinct kind-and-text, keeping the first note given for it. */
function dedupe(requirements: readonly Requirement[]): readonly Requirement[] {
  const unique = new Map<string, Requirement>();
  for (const requirement of requirements) {
    const key = `${requirement.kind}:${requirement.what}`;
    if (!unique.has(key)) unique.set(key, requirement);
  }
  return [...unique.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.what.localeCompare(b.what));
}
