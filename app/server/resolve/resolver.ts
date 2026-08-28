// The resolver seam: signals in, findings out.
//
// A resolver is registered against the control ids it can answer, which is what
// allows one signal to serve several controls. `CO-02-01` and `REL-03-01` are the
// same observation about autoscaling read against two different pillars' intents,
// and both are answered from one query without either pillar knowing about the
// other.
//
// Resolvers are pure. They receive collected signals and return an outcome, and they
// do not call anything. That is what makes the applicability tests possible against
// synthetic estates: a 100%-serverless estate can be constructed as a map of signal
// values, with no workspace involved.

import type { SignalId, SignalResult } from '../collect/signal.js';
import type { Coverage } from '../collect/signal.js';
import type { Attestation, AttestedAnswer } from '../attest/attestation.js';
import { familyOf } from '../collect/rest/families.js';
import {
  narrowest,
  type AttestedFact,
  type Evidence,
  type Finding,
  type Outcome,
  type Severity,
  type Unmeasured,
} from './finding.js';
import { resolveApplicability, type Applicability, type Precondition } from './applicability.js';
import { attestRemedy, remedyFor, type Remedy } from './remedy.js';

/** The catalogue entry a resolver is answering, narrowed to what resolution needs. */
export interface ControlSpec {
  readonly id: string;
  readonly pillarId: string;
  readonly principleId: string;
  readonly title: string;
  readonly severity: Severity;
  /**
   * How the catalogue says this control is evidenced. Carried here so a control with
   * no resolver can say why: "answered by attestation" and "an automated check is
   * planned but not built" are different states, and reporting the second as the
   * first would quietly convert unfinished work into a question for the customer.
   */
  readonly measurability?: 'system-table' | 'rest-api' | 'cloud-api' | 'attestation' | 'derived';
  readonly evaluatorStatus?: 'implemented' | 'planned' | 'unimplemented';
  /**
   * Where the catalogue says the answer lives, as a surface-qualified path.
   *
   * Carried for the same reason `measurability` is, one level finer. "A check is planned" and "no
   * install of this app can be authorised to make this call" are both unbuilt checks and only one
   * of them is going to be built, and the difference is decided by which API family the collector
   * names. See `collect/rest/families.ts`.
   */
  readonly collector?: string;
  readonly thresholds?: Record<string, unknown>;
  readonly preconditions?: readonly Precondition[];
  /**
   * Controls sharing a group are the same requirement seen from two pillars. Scored
   * once, reported in both, so a cross-cutting concern does not count twice against
   * an estate that has one thing wrong.
   */
  readonly aliasGroup?: string;
}

export interface Resolution {
  readonly outcome: Outcome;
  readonly evidence: readonly Evidence[];
  readonly outcomeReason?: string;
  /**
   * For an `unmeasurable` outcome, which kind of gap it is. Ignored on every other outcome.
   *
   * Defaults to `unreadable`, which is right for the common case: a resolver reaches
   * `unmeasurable` because the source it needed did not answer. But it is wrong for the case a
   * resolver read its source successfully and found the answer genuinely absent from the
   * platform — an unset workspace setting whose effective default is not published anywhere, a
   * managed connector that registers nothing. Those are `attestation`: no telemetry settles them,
   * so a reader sent to fix their grants would be chasing something that is not broken.
   *
   * A resolver declares this because only the resolver knows. From here the two are the same
   * shape, and defaulting them both to `unreadable` put a fifth of this app's unmeasured
   * requirements under "sources the scan could not read" while their own prose said the opposite.
   */
  readonly unmeasured?: Unmeasured;
  /**
   * For an `unmeasurable` outcome, what the reader can do about it, where only the resolver knows.
   *
   * The usual source is the platform's refusal, read from its own words — which is the better one
   * where there is a refusal to read. This is for the case there is not: a statement that succeeded
   * and returned an answer the resolver can tell is incomplete. `system.information_schema` filtered
   * by the reader's privileges is that case exactly, and nothing downstream of the signal can see
   * it, because from there a filtered read and a true zero are the same row.
   *
   * A refusal still wins where one exists. It names the scope or the object, and this cannot.
   */
  readonly remedy?: Remedy;
}

/**
 * What resolution needs to know about this install, as opposed to about this requirement.
 *
 * Only used to say what a reader can do about a signal that did not answer, which is a question
 * about the app's declared scopes rather than about the catalogue. Optional throughout: a scan
 * run without it produces the same outcomes and one less sentence, which is what every
 * applicability test wants and what a synthetic estate can supply.
 */
export interface ResolveContext {
  /** Scopes `app.yaml` requests, which separates a stale consent from a permanent refusal. */
  readonly declaredScopes?: readonly string[];
}

export interface ControlResolver {
  readonly controls: readonly string[];
  readonly requires: readonly SignalId[];
  /**
   * Signals that improve the finding but are not needed to reach an outcome.
   *
   * Collected because they are declared here — the scan plan is built from what
   * resolvers ask for, so an undeclared signal is never collected — but read softly, so
   * one that fails costs detail rather than the control. The per-schema census against
   * the estate census is the case: knowing 103 of 347 tables are undescribed is the
   * finding, and knowing which four schemas hold most of them is what makes it
   * actionable. Requiring the second would turn a readable control into an unmeasured
   * one whenever the more expensive statement did not land.
   */
  readonly enrichedBy?: readonly SignalId[];
  resolve(spec: ControlSpec, signals: ReadonlyMap<SignalId, SignalResult>): Resolution;
}

export class ResolverRegistry {
  private readonly byControl = new Map<string, ControlResolver>();

  register(resolver: ControlResolver): void {
    for (const controlId of resolver.controls) {
      const existing = this.byControl.get(controlId);
      if (existing != null) {
        // Refused rather than last-one-wins. Two resolvers for one control means one
        // of them is dead code, and which one runs would depend on registration
        // order — a difference that would not show up until the two disagreed.
        throw new Error(
          `Control ${controlId} already has a resolver (${existing.constructor.name}); ` +
            'a control may only be answered by one.'
        );
      }
      this.byControl.set(controlId, resolver);
    }
  }

  get(controlId: string): ControlResolver | undefined {
    return this.byControl.get(controlId);
  }

  /** Signals needed to resolve these controls, deduplicated. The scan plan. */
  signalsFor(controlIds: readonly string[]): SignalId[] {
    const needed = new Set<SignalId>();
    for (const id of controlIds) {
      const resolver = this.byControl.get(id);
      for (const signal of resolver?.requires ?? []) needed.add(signal);
      for (const signal of resolver?.enrichedBy ?? []) needed.add(signal);
    }
    return [...needed];
  }
}

/**
 * Resolve one control: applicability first, then evidence.
 *
 * The order is load-bearing rather than tidy. A control that does not apply must not
 * be evaluated at all, because evaluating it produces an observation ("no cluster
 * policies exist") that reads as a failure and would be reported as one by any
 * later step that saw it.
 */
export function resolveControl(
  spec: ControlSpec,
  signals: ReadonlyMap<SignalId, SignalResult>,
  resolver: ControlResolver | undefined,
  attested?: Attestation,
  context: ResolveContext = {}
): Finding {
  const applicability = resolveApplicability(spec.preconditions ?? [], signals);

  if (applicability.kind === 'not-applicable' || applicability.kind === 'satisfied-by-architecture') {
    return {
      ...base(spec),
      outcome: applicability.kind,
      coverage: { mode: 'complete' },
      evidence: [],
      outcomeReason: applicability.reason,
    };
  }

  if (resolver == null) {
    // An answer someone gave settles a requirement no telemetry can reach. Where there is
    // none, the finding says which of the three kinds of unmeasured it is, as before.
    if (attested != null) return findingFromAttestation(spec, attested);

    const unresolved = whyUnresolved(spec);
    return {
      ...base(spec),
      outcome: 'unmeasurable',
      coverage: { mode: 'complete' },
      evidence: [],
      outcomeReason: unresolved.reason,
      unmeasured: unresolved.kind,
      // Both of these end at the same place, and it is worth saying so on the finding rather
      // than leaving a reader to infer it from the category name. `unbuilt` gets nothing,
      // because the honest answer there is that somebody has to write a check and it is not
      // the reader.
      ...(unresolved.kind === 'attestation' || unresolved.kind === 'unreachable' ? { remedy: attestRemedy() } : {}),
    };
  }

  const resolution = resolver.resolve(spec, signals);

  /*
   * An attestation may answer what the app could not read. It may never overturn what it did.
   *
   * The order is the integrity property of the whole feature. If a statement could override a
   * measurement, then any finding the customer disliked could be attested away and the
   * assessment would be worth precisely nothing. So an attestation is consulted only where
   * the resolver reached no verdict, and where the resolver did reach one the attestation is
   * still recorded on the finding — visible, and not counted.
   */
  if (resolution.outcome === 'unmeasurable' && attested != null) {
    return { ...findingFromAttestation(spec, attested), evidence: resolution.evidence };
  }

  const reason = reasonFor(resolution, applicability);

  // The refusal is read before the gap is classified, because it is what classifies it. A
  // resolver that could not decide was usually refused, and only the refusal's own words say
  // whether the reader can do anything about it.
  const refused = remedyFor(resolver.requires, signals, {
    ...(context.declaredScopes != null ? { declaredScopes: context.declaredScopes } : {}),
    ...(spec.collector != null ? { collector: spec.collector } : {}),
  });
  const unmeasured = resolution.outcome === 'unmeasurable' ? kindOfGap(resolution.unmeasured, refused) : undefined;

  return {
    ...base(spec),
    outcome: resolution.outcome,
    coverage: coverageOf(resolution.evidence),
    evidence: resolution.evidence,
    ...(unmeasured != null ? { unmeasured } : {}),
    ...(reason != null ? { outcomeReason: reason } : {}),
    ...(remedyWhenUnmeasured(refused, unmeasured, resolution.remedy) ?? {}),
    // Recorded, not counted: the measurement above decided this requirement.
    ...(attested != null ? { attested: factFromAttestation(attested, 'record') } : {}),
  };
}

/**
 * Which kind of gap this is, once the platform's refusal has been read.
 *
 * Four of the five: `disabled` is a decision the customer recorded, not anything a resolver or a
 * refusal can read, so nothing here returns it.
 *
 * A resolver's own classification wins where it made one: it read its source successfully and
 * found the answer absent from the platform, which nothing here can tell.
 *
 * Otherwise the refusal decides, and `attest` means `unreachable`. Those two say the same thing in
 * the two vocabularies — no install of this app can be authorised for this call, so it ends at a
 * person — and defaulting to `unreadable` instead put them under "sources the scan could not read".
 * A live scheduled run made the cost concrete: of 80 requirements it reported as unread, 18 were
 * calls Databricks Apps offers no scope for, so an operator following the advice would have spent
 * an afternoon granting things that could not have helped. It also counted those 18 against the
 * identity in the rule that decides whether an unattended run measured enough to keep.
 *
 * `re-authorise` stays `unreadable` deliberately: the scope exists and consent is stale, which one
 * sign-in fixes. That is the reader's to close, which is what `unreadable` means.
 */
function kindOfGap(declared: Unmeasured | undefined, refused: Remedy | undefined): Unmeasured {
  if (declared != null) return declared;
  return refused?.kind === 'attest' ? 'unreachable' : 'unreadable';
}

/**
 * What the reader can do about a requirement a resolver could not settle.
 *
 * Three sources, in that order. A signal that failed is classified from the platform's own refusal,
 * which is the specific answer: which scope, whose grant, whether consent is stale. Failing that,
 * the resolver's own, for the case it read its source successfully and can tell the answer was
 * incomplete — a privilege-filtered catalogue reads as a row of zeroes, and nothing outside the
 * resolver can distinguish that from an empty estate. Failing both, the resolver's classification
 * decides: `attestation` and `unreachable` end at a person, and saying so is the only useful thing
 * left to say.
 *
 * Nothing for an otherwise unexplained `unreadable`, which would be this app contradicting itself,
 * and nothing for a measured outcome: there is no access remedy for a finding that has an answer.
 */
function remedyWhenUnmeasured(
  refused: Remedy | undefined,
  unmeasured: Unmeasured | undefined,
  declared: Remedy | undefined
): { remedy: Remedy } | undefined {
  if (unmeasured == null) return undefined;
  if (refused != null) return { remedy: refused };
  if (declared != null) return { remedy: declared };
  if (unmeasured === 'attestation' || unmeasured === 'unreachable') return { remedy: attestRemedy() };
  return undefined;
}

/** What each answer means as an outcome, in the vocabulary every other finding uses. */
export const OUTCOME_OF_ANSWER: Readonly<Record<AttestedAnswer, Outcome>> = {
  met: 'pass',
  'partially-met': 'partial',
  'not-met': 'fail',
  'not-applicable': 'not-applicable',
};

export function findingFromAttestation(spec: ControlSpec, attested: Attestation): Finding {
  const outcome = OUTCOME_OF_ANSWER[attested.answer];

  return {
    ...base(spec),
    outcome,
    // Complete because the claim is about the whole practice rather than a sample of it.
    // What makes it a weaker claim than an observation is that it is attested at all, which
    // `attested` says outright, rather than a coverage fraction that would invite a reader
    // to think part of the estate had been examined.
    coverage: { mode: 'complete' },
    evidence: [],
    outcomeReason:
      outcome === 'not-applicable'
        ? `Attested as not applicable by ${attested.attestedBy}: ${attested.statement}`
        : `Answered by attestation rather than measured. ${attested.owner} is accountable for this practice.`,
    attested: factFromAttestation(attested, 'outcome'),
  };
}

export function factFromAttestation(attested: Attestation, bearing: AttestedFact['bearing']): AttestedFact {
  return {
    id: attested.id,
    bearing,
    by: attested.attestedBy,
    at: attested.attestedAt,
    statement: attested.statement,
    owner: attested.owner,
    reviewBy: attested.reviewBy,
    ...(attested.evidenceUrl != null ? { evidenceUrl: attested.evidenceUrl } : {}),
  };
}

/**
 * What the finding may claim, from the evidence the outcome rests on.
 *
 * Detail-bearing evidence is excluded because it did not decide anything. A control that
 * counted every table in the metastore and then named the four schemas holding most of the
 * gap has measured the estate completely; letting the sampled breakdown narrow the whole
 * finding would report a complete measurement as a partial one, and under the sampled-pass
 * rule that turns a pass into a weaker claim than it earned.
 *
 * Falls back to all of it when nothing is marked outcome-bearing, so an existing resolver
 * that says nothing about bearing keeps the coverage it had.
 */
function coverageOf(evidence: readonly Evidence[]): Coverage {
  const bearing = evidence.filter((item) => item.bearing !== 'detail');
  return narrowest((bearing.length > 0 ? bearing : evidence).map((item) => item.coverage));
}

/**
 * An unresolved segment precondition is surfaced on the finding rather than hidden.
 *
 * The alternative — resolving normally and saying nothing — would mean a mixed
 * estate silently gets an assessment whose applicability was never actually
 * checked, and nobody looking at the result could tell.
 */
function reasonFor(resolution: Resolution, applicability: Applicability): string | undefined {
  if (resolution.outcomeReason != null) return resolution.outcomeReason;
  if (applicability.kind === 'needs-segments') {
    return `Assessed across the whole estate. ${applicability.reason} Per-segment applicability is not yet implemented, so this may apply to only part of the estate.`;
  }
  if (applicability.kind === 'undetermined') return applicability.detail;
  return undefined;
}

/**
 * Why a control has no resolver, in the terms the catalogue itself uses.
 *
 * A control the app has decided cannot be automated, and a control whose automated
 * check has not been written yet, look identical from here but are not the same
 * thing. Saying "answered by attestation" for the second would present unfinished
 * work to the customer as a question only they can answer.
 */
function whyUnresolved(spec: ControlSpec): { kind: Unmeasured; reason: string } {
  /*
   * Diagnosis only, throughout. What to do about it is the remedy's job, and these two render about
   * two hundred pixels apart on the same pane.
   *
   * Every reason below used to end "Answered by attestation", which is a prescription, so the pane
   * said the same thing twice on all 105 unmeasured requirements — and the second time was in the
   * box the reader was meant to act on, which made that box look like a summary of the paragraph
   * above it. Whatever is said here, the remedy has to be able to say something the reader does not
   * already know.
   */
  if (spec.measurability === 'attestation') {
    return {
      kind: 'attestation',
      reason: 'This practice leaves no trace on the platform, so there is nothing to read that would settle it.',
    };
  }

  /*
   * A call no install can make is not a check somebody forgot to write.
   *
   * Checked before the `planned` case, and that order is the whole point of this branch. The
   * catalogue marks these controls `planned` because the security guide they came from names an
   * endpoint, and for 37 of them the endpoint needs authority Databricks Apps does not offer an app.
   * Reporting those as "planned but not implemented yet" pointed a reader at a roadmap that does not
   * exist, and did it for a fifth of the catalogue.
   */
  const family = familyOf(spec.collector);
  if (family != null && !family.grantable) {
    return {
      kind: 'unreachable',
      reason:
        family.plane === 'account'
          ? `${family.label} is account-plane configuration, and this app is installed in a workspace. A ` +
            'workspace token is rejected by the account endpoints before authorisation is even considered, ' +
            'so no scope and no permission would change it.'
          : `${family.label} needs the "${family.scope}" authorization scope, which Databricks Apps does not ` +
            "offer an app — a platform limit rather than unfinished work. Reading it as the app's own " +
            'identity instead would show you an estate you may not have the right to see, which is why it ' +
            'does not.',
    };
  }

  if (spec.evaluatorStatus === 'planned') {
    return {
      kind: 'unbuilt',
      reason:
        'An automated check for this control is planned but not implemented yet, so it is unmeasured ' +
        'rather than answered. It is left in the denominator: not having built the check is not evidence ' +
        'that the estate is compliant.' +
        (familyOf(spec.collector) != null
          ? ` The app can be authorised to read ${familyOf(spec.collector)?.label.toLowerCase() ?? 'this'}, so ` +
            'this one is genuinely a gap here rather than a limit of the platform.'
          : ''),
    };
  }
  return {
    kind: 'unbuilt',
    reason: 'No automated check is implemented for this control, so it is unmeasured in this scan.',
  };
}

function base(spec: ControlSpec): Omit<Finding, 'outcome' | 'coverage' | 'evidence'> {
  return {
    controlId: spec.id,
    pillarId: spec.pillarId,
    principleId: spec.principleId,
    title: spec.title,
    severity: spec.severity,
  };
}
