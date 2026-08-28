// The normalised finding: one shape for every control outcome, whatever produced it.
//
// Four collectors, 183 scored units and three provenances converge here. If a
// finding from a system-table query looks different from a finding from an
// attestation, then scoring, the UI, the trend view and the export each have to
// know about the difference, and each will handle it slightly differently.

import { narrowerReach } from '../collect/signal.js';
import type { Coverage, Reach } from '../collect/signal.js';
import type { ExecutionMode } from '../collect/credentials.js';
import type { Provenance } from '../collect/provenance.js';
import type { SignalId } from '../collect/signal.js';
import type { Remedy } from './remedy.js';
import type { EvidenceClass } from './evidence-class.js';
import type { EstateObjectKind } from './locate.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'informational';

export type Outcome =
  | 'pass'
  | 'fail'
  /**
   * Evidence shows part of the intent met. Earns partial credit rather than being
   * rounded to a failure, because rounding down means an estate that improved
   * measurably sees no movement, and nothing teaches people to ignore a score
   * faster than that.
   */
  | 'partial'
  /**
   * Could not be determined. Left in the denominator and shown as a gap in
   * knowledge, which is different from a gap in the estate. Never scored as a
   * failure: penalising an unreadable permission would reward configuring the tool
   * to see less.
   */
  | 'unmeasurable'
  /** Does not apply to this estate. Leaves the denominator entirely. */
  | 'not-applicable'
  /**
   * The platform meets the control's intent by design, so it counts as a pass.
   * The case this exists for is a fully serverless estate and cluster policies: the
   * policy is absent, the risk it manages is absent too, and scoring it down would
   * be the single most damaging bug this app could ship.
   */
  | 'satisfied-by-architecture';

export const SCORED: readonly Outcome[] = ['pass', 'fail', 'partial', 'unmeasurable', 'satisfied-by-architecture'];

export function isScored(outcome: Outcome): boolean {
  return outcome !== 'not-applicable';
}

export interface Evidence {
  readonly signal: SignalId;
  /** What was observed, rendered for display. Not the raw payload. */
  readonly observed: string;
  /** What the control expects, in the same terms, so the two can be read together. */
  readonly expected?: string;
  readonly coverage: Coverage;
  readonly collectedAt: Date;
  /**
   * What kind of claim this is: something the app read, something an administrator imported, or
   * somebody's answer. Absent means `observed`, which is what every collector in this build produces.
   *
   * Defaulted rather than required because the alternative is a field on several hundred pieces of
   * evidence across nineteen resolvers, all of which would say the same thing. It stops being a
   * default the moment there is a second producer — H4's import sets it explicitly, and `classOf`
   * treats absence as observed only because nothing in this build can produce anything else. See
   * evidence-class.ts.
   */
  readonly evidenceClass?: EvidenceClass;
  /**
   * Whether the outcome rests on this, or it only locates what the outcome already said.
   *
   * Absent means it does, which is the safe default: a coverage claim that treated
   * load-bearing evidence as decoration would overstate what was measured. The
   * distinction exists because the two combine differently — a complete estate count
   * paired with a sampled breakdown of where the gap sits is a complete measurement with
   * a partial map, and calling the whole finding sampled would understate a control that
   * did in fact look at everything.
   */
  readonly bearing?: 'outcome' | 'detail';
  /**
   * Which surface read this, under whose authority, and from where.
   *
   * Copied off the signal rather than restated, so a reader disputing a number is told what to run
   * to check it and as whom. Optional because a signal collected outside a scan — a fixture in a
   * test — has no authority to report, and inventing one would make the field unusable for the
   * purpose it exists for. See collect/provenance.
   */
  readonly provenance?: Provenance;
  /**
   * The same resources `observed` names, as a list, so a reader can go to one.
   *
   * Both forms exist because they have different readers. `observed` is one sentence, which is
   * what a spreadsheet cell and a plain-text export need. This is the sentence's parts, which is
   * what a page needs to make each name its own link — and a page that rendered the sentence and
   * then repeated the names underneath it as links would be asking the reader to read the same
   * list twice.
   *
   * Absent when nothing here is addressable: an estate-wide count has no list. Present with no
   * `url` on its items when the workspace directory could not be read, because the list is still
   * worth structuring even when nowhere can be linked to.
   */
  readonly at?: Located;
}

/** The resources behind a finding, in the order its prose names them. */
export interface Located {
  /** What these have in common, without its colon. "No health rule", "Without it". */
  readonly lead: string;
  readonly items: readonly LocatedItem[];
  /** How many more there are than are listed. Absent when the list is all of them. */
  readonly more?: number;
}

/**
 * One item as prose: the name, then where it is and why it is here, in one parenthesis.
 *
 * The page renders the parts and reaches these same words, because the two are read side by side —
 * a finding on screen and the spreadsheet exported from it. Two parentheses in a row, "etl
 * (field-eng) (LEGACY_SINGLE_USER)", reads like a stammer, so there is one.
 */
export function describeItem(item: LocatedItem): string {
  const aside = [item.in, item.note].filter((part) => part != null);
  return aside.length === 0 ? item.label : `${item.label} (${aside.join(', ')})`;
}

export interface LocatedItem {
  /** The resource's own name, and nothing else, because this is what becomes the link. */
  readonly label: string;
  /**
   * Which workspace it is in, when more than one was assessed and the name alone is ambiguous.
   *
   * Kept out of `label` deliberately. Four warehouses called "Serverless Starter Warehouse" across
   * four workspaces are told apart only by this, and burying it inside the link made the one word
   * that distinguishes them the one word that read as part of a name.
   */
  readonly in?: string;
  /** Why this one is here, when the name does not say. A cluster's access mode, a node type. */
  readonly note?: string;
  /** Absent for a resource with no page of its own, or none this app will guess at. */
  readonly url?: string;
  /**
   * What kind of resource it is. Carried for the reader of the payload, not for the prose.
   *
   * `describeItem` does not use it: a sentence reading "analytics (field-eng, SQL warehouse)"
   * spends its parenthesis on something the link already says. What needs it is the inspector,
   * which folds several of these lists into one and would otherwise treat a cluster and a
   * warehouse of the same name in the same workspace as one resource named twice.
   */
  readonly kind?: EstateObjectKind;
}

export interface Finding {
  readonly controlId: string;
  readonly pillarId: string;
  readonly principleId: string;
  readonly title: string;
  readonly outcome: Outcome;
  readonly severity: Severity;
  /**
   * Narrowest coverage across the evidence behind this finding. A control resolved
   * from one complete signal and one sampled signal is sampled, because the weakest
   * evidence governs what may be claimed.
   */
  readonly coverage: Coverage;
  readonly evidence: readonly Evidence[];
  /**
   * Shown verbatim for `not-applicable` and `satisfied-by-architecture`. A smaller
   * denominator has to read as explained fact rather than score inflation, or the
   * first question about any high score is whether the tool simply skipped the hard
   * parts.
   */
  readonly outcomeReason?: string;
  /**
   * Why an `unmeasurable` outcome is unmeasurable, in the one dimension that decides
   * what to do about it. Absent on every other outcome.
   *
   * All three read identically in a score — unknown is unknown — and lead to entirely
   * different actions. Without the distinction a pillar reporting "13 of 18 unmeasured"
   * invites the reader to conclude the app is broken, when 12 of those are practice
   * statements that no telemetry could ever answer and the app is doing exactly what it
   * should.
   */
  readonly unmeasured?: Unmeasured;
  /**
   * What the reader can do about it, when the gap came from a signal that did not answer.
   *
   * Separate from `unmeasured` because they answer different questions and group differently.
   * `unmeasured` says what kind of gap this is, which is a property of the requirement and the
   * same in every workspace; this says what would close it here, which is a property of this
   * scan and can change between two runs by two people. A coverage summary counts the first; a
   * work queue sorts by the second.
   *
   * Absent when no required signal failed — including on some `unmeasurable` outcomes, where a
   * resolver read perfectly good evidence and found it ambiguous. Inventing a remedy for those
   * would send a reader to grant something when the app is only saying it could not tell.
   *
   * Not to be confused with the catalogue's `remediation`, which is how to fix a requirement the
   * app measured and found unmet. This is how to make one measurable in the first place.
   */
  readonly remedy?: Remedy;
  /**
   * Set when the outcome rests on someone's statement rather than on an observation.
   *
   * Carried on the finding rather than folded into `evidence` because the two are different
   * kinds of claim and the difference has to survive into the score, the export and the
   * trend view. Evidence has coverage — a fraction of an estate examined — and an
   * attestation has none: it is one person's answer about the whole practice. Presenting it
   * as complete coverage would let a self-certified requirement read as the
   * best-established finding in the assessment.
   */
  readonly attested?: AttestedFact;
}

/** The parts of an attestation a reader of the finding needs, without the storage record. */
export interface AttestedFact {
  /**
   * The attestation this fact came from, so a later result can cite it.
   *
   * Optional because scans recorded before this field existed do not carry it, and inventing an id
   * for them would put a citation in a result that names a record the run never held.
   */
  readonly id?: string;
  /**
   * Whether the outcome rests on this answer, or the answer is only recorded beside a
   * measurement that decided it.
   *
   * The same distinction `Evidence.bearing` draws, and needed for the same reason: the score
   * has to be able to report how much of itself is attested rather than observed. Without
   * this, an attestation recorded against a requirement the app went on to measure would
   * count towards that figure and overstate how much of the assessment is self-reported.
   */
  readonly bearing: 'outcome' | 'record';
  readonly by: string;
  readonly at: Date;
  /** What the attester said the answer rests on. */
  readonly statement: string;
  /** Who is accountable for the practice, which may not be who recorded it. */
  readonly owner: string;
  readonly evidenceUrl?: string;
  /** After this the answer stops counting and the requirement returns to unmeasured. */
  readonly reviewBy: Date;
}

/**
 * The five reasons a requirement is unknown, which are five different remedies.
 *
 * - `attestation`: no telemetry can answer it. Someone has to say, and record who and when.
 * - `unreachable`: telemetry could answer it and no install of this app may ask. Also ends in an
 *   answer from a person, but it is a platform limit with an owner rather than a property of the
 *   requirement, and it closes the day a scope is granted.
 * - `unbuilt`: the platform exposes the answer and this app does not read it yet. Our gap.
 * - `unreadable`: the app asked and did not get an answer — refused for want of a scope or
 *   a permission, or the source held nothing. Fixable by access or by the platform.
 * - `disabled`: the customer told the app not to score it. Nobody's gap and no fault: the remedy is
 *   to switch the check back on. Not "the app did not ask" — ADR 0059's second amendment makes a
 *   decision lapse when the reading turns `fail`, which it can only do by taking the reading on
 *   every run. Who switched it off and why will be recorded against the decision; row 31b's lever
 *   does not exist yet, so nothing records it today.
 *
 * `unreachable` is separate from `unbuilt` because collapsing them was a live defect: 37
 * requirements the platform will not authorise reported as "a check is planned", which is a
 * roadmap promise nobody can keep. It is separate from `unreadable` because that one is fixable
 * by a grant in the reader's own workspace and this one is not fixable by the reader at all.
 *
 * `disabled` is separate from all four for the same class of reason, and it is here before the
 * lever that produces it. Every other kind says why no answer arrived; this one says an answer is
 * not to be used. Without
 * it a customer-disabled check falls to the `unmeasuredBy` default and is reported as
 * `unreadable` — "the app asked and did not get an answer" in the export, "the source could not
 * be read" in the report appendix — which is a false statement about this app made in the one
 * place a reader cannot check it. Row 31b cannot carry an attributable reason without it.
 */
export type Unmeasured = 'attestation' | 'unreachable' | 'unbuilt' | 'unreadable' | 'disabled';

/**
 * Everything that has to match before two scans may be compared.
 *
 * One stamp rather than four separate caveats. Sampled coverage, a paused scan, the
 * executing identity and the catalogue version each independently make two scans
 * incomparable, and as separate special cases each would have to be remembered at
 * every comparison site. As one value, the trend view has a single question to ask.
 *
 * The identity field is the least obvious and the most necessary: a service
 * principal and an account admin do not see the same estate, so a score that moved
 * between an on-demand scan and a scheduled one may say nothing about the estate at
 * all.
 */
export interface ScanStamp {
  readonly catalogueVersion: string;
  readonly catalogueFingerprint: string;
  readonly executionMode: ExecutionMode;
  readonly actor: string;
  /** Complete, or paused on a budget with part of the estate assessed. */
  readonly completeness: 'complete' | 'partial';
  /** True when any finding in the scan rests on sampled evidence. */
  readonly anySampled: boolean;
}

/** Why two scans cannot be compared, phrased for display. Empty means they can. */
export function comparabilityBarriers(a: ScanStamp, b: ScanStamp): string[] {
  const barriers: string[] = [];

  if (a.catalogueFingerprint !== b.catalogueFingerprint) {
    barriers.push(
      `The set of scored requirements changed between these scans (catalogue ${a.catalogueVersion} and ${b.catalogueVersion}), ` +
        'so a difference in score may reflect the change rather than the estate.'
    );
  }
  if (a.executionMode !== b.executionMode) {
    barriers.push(
      `One scan ran as ${describeMode(a.executionMode)} and the other as ${describeMode(b.executionMode)}. ` +
        'Those identities do not see the same estate, so the two scores are not measuring the same thing.'
    );
  }
  if (a.completeness === 'partial' || b.completeness === 'partial') {
    barriers.push('At least one of these scans stopped early, so it covers less of the estate than the other.');
  }

  return barriers;
}

/**
 * Not "the signed-in user", though that is what this mode is called: the proxy mints an
 * on-behalf-of token for a service principal caller too, so naming a person here would describe
 * some of the runs wrongly. Nor "the app's" on the other side — a scheduled run authenticates as
 * whichever principal the customer created for it. The identity itself is in `actor`.
 */
function describeMode(mode: ExecutionMode): string {
  return mode === 'on-behalf-of-user' ? 'the identity that started it' : 'a service principal';
}

/**
 * The narrowest of several coverages, for a control resolved from more than one signal.
 *
 * Mode and reach narrow independently, so both are reduced. A control answered from an
 * account-wide table and a metastore-scoped one is a statement about the metastore: the
 * narrower input governs, exactly as the sampled fraction does.
 */
export function narrowest(coverages: readonly Coverage[]): Coverage {
  const reach = coverages.reduce<Reach | undefined>((so_far, c) => narrowerReach(so_far, c.reach), undefined);
  const withReach = (coverage: Coverage): Coverage => (reach != null ? { ...coverage, reach } : coverage);

  const sampled = coverages.filter((c) => c.mode === 'sampled');
  if (sampled.length === 0) return withReach({ mode: 'complete' });

  // The smallest examined fraction is the honest claim for the combination.
  return withReach(sampled.reduce((worst, c) => (fraction(c) < fraction(worst) ? c : worst)));
}

function fraction(coverage: Coverage): number {
  if (coverage.examined == null || coverage.population == null || coverage.population === 0) return 1;
  return coverage.examined / coverage.population;
}
