// What a reader can do about a requirement this scan could not measure.
//
// The gap this closes is that every unmeasured requirement currently reads the same way. A
// pillar saying "12 of 18 unmeasured" invites one conclusion — the tool is broken — and the
// twelve are usually four different situations with four different owners: a grant the reader
// can issue in a minute, a consent they can refresh in one click, a scope Databricks will
// never give an app, and a system table their account has not switched on. Only one of those
// is anybody's fault and none of them is the same piece of work.
//
// `Unmeasured` on the finding already answers "what kind of gap is this". This answers the
// next question, which is the only one a reader actually has: what do I do. The two are kept
// apart because they group differently — the coverage summary counts kinds, and a work queue
// sorts by remedy — and because one is a fact about the requirement while the other is a fact
// about this scan in this workspace and changes between runs.
//
// Classified from the platform's own refusal text rather than from a status code, for the
// reason `collect/rest/reach.ts` gives at more length: a scope never offered, a scope offered
// and not consented to, and a permission this user lacks are all 403, and only the words
// separate them.

import type { SignalId, SignalResult } from '../collect/signal.js';
import { familyOf } from '../collect/rest/families.js';
import { demandedScope } from '../collect/rest/reach.js';

/**
 * The action that would close the gap, and who can take it.
 *
 * Ordered by whose problem it is, nearest first, because that is the order a reader wants to
 * work through them: what I can fix, what my platform team can fix, what nobody can fix, and
 * what is our bug.
 */
export type RemedyKind =
  /** A grant or a permission the reader or their admin can issue against their own estate. */
  | 'grant'
  /**
   * The app asked for the scope and this token does not carry it, so consent predates the
   * request. One re-authorisation fixes it, and it is worth saying so: this is the only remedy
   * here that the signed-in user can complete alone, in seconds, with no ticket.
   */
  | 're-authorise'
  /**
   * No install of this app can be authorised for it. The requirement goes to a person.
   *
   * Distinct from `grant` because it is the opposite advice, and getting it wrong is expensive
   * in trust: an admin sent to grant something ungrantable comes back having learnt to ignore
   * the next message too.
   */
  | 'attest'
  /** The source exists and holds nothing here — a system schema not enabled, a metastore not attached. */
  | 'enable'
  /** Transient: a timeout, a cancellation, a budget reached. The same run again would answer it. */
  | 'retry'
  /**
   * Unclassified, and therefore ours. A refusal this module cannot read is a gap in this
   * module, not in the customer's estate, and it says so rather than guessing at one of the
   * five above.
   */
  | 'report';

export interface Remedy {
  readonly kind: RemedyKind;
  /** The sentence the reader acts on, in the second person, naming the specific thing. */
  readonly says: string;
  /** The platform's own words, so the claim above can be checked rather than trusted. */
  readonly because?: string;
  /** Which signals' failure produced this, for the reader who wants to see the query. */
  readonly signals: readonly SignalId[];
}

export interface RemedyContext {
  /** Scopes `app.yaml` requests, which separates a stale consent from a permanent refusal. */
  readonly declaredScopes?: readonly string[];
  /**
   * The catalogue's `collector` for this requirement.
   *
   * Read only when the refusal names no scope of its own. The family table is a statement about
   * the endpoint the catalogue names, and the refusal is a statement about the call that was
   * actually made; where they disagree the call wins, because it happened.
   */
  readonly collector?: string;
}

/**
 * What to do about the signals a resolver needed and did not get.
 *
 * Returns nothing when they all succeeded — a resolver can return `unmeasurable` from perfectly
 * good data, which is a different situation with no access remedy at all. Those cases carry
 * their own explanation from the resolver, and inventing a remedy for them would tell a reader
 * to go and grant something when the app is simply saying the evidence was ambiguous.
 *
 * The worst remedy wins when several signals failed differently, where worst means furthest
 * from the reader: a control needing one ungrantable signal and one missing grant is reported as
 * `attest`, because issuing the grant would not make it measurable and finding that out by
 * doing it is a wasted afternoon.
 */
export function remedyFor(
  required: readonly SignalId[],
  signals: ReadonlyMap<SignalId, SignalResult>,
  context: RemedyContext = {}
): Remedy | undefined {
  const failed = required.filter((id) => (signals.get(id)?.status ?? 'unmeasurable') === 'unmeasurable');
  if (failed.length === 0) return undefined;

  const each = failed.map((id) => one(id, signals.get(id)?.unmeasurableReason, context));
  const worst = each.reduce((so_far, candidate) => (rank(candidate.kind) > rank(so_far.kind) ? candidate : so_far));

  return { ...worst, signals: failed };
}

/**
 * The remedy for a requirement no signal refused and no telemetry settles.
 *
 * Says what to do and nothing about why, which is the division of labour with the finding's
 * `outcomeReason`. The first version of this copied the reason into the advice, and the detail pane
 * then showed the same sixty-word paragraph twice about two hundred pixels apart — the pane read as
 * though it were repeating itself, and the one sentence the reader could act on was buried in the
 * duplicate.
 *
 * One sentence, not two, and the same one either way.
 *
 * Short because this is the text on 105 of 184 requirements in a well-permissioned estate — every
 * unmeasured one. The first version ran to forty words explaining what an answer is and does, which
 * is worth knowing once and is furniture the other hundred and four times; a reader who has met it
 * twice stops reading the box.
 *
 * The `unreachable` case had a second sentence, and losing it is the point rather than a saving. It
 * said there was nothing worth raising with Databricks, which was meant to stop an admin hunting for
 * a grant that does not exist — but the reason it sits beneath now names the scope and says outright
 * that Apps is not offered it, so the hunt is already called off. Read together the pair was worse
 * than redundant: the reason describes a capability Databricks does not give apps, and the advice
 * then said there was nothing to raise with Databricks, which a fair reader hears as a contradiction.
 */
export function attestRemedy(): Remedy {
  return {
    kind: 'attest',
    signals: [],
    // No mention of "answer", which the heading and the link above and below it both carry. Three
    // sightings of one word inside 108px is what a generated interface reads like.
    says: 'What you record scores in place of a measurement, and lapses on its review date so the claim stays current.',
  };
}

/** Furthest from the reader first, so the reduce above keeps the least actionable one. */
const ORDER: readonly RemedyKind[] = ['retry', 'grant', 're-authorise', 'enable', 'report', 'attest'];

function rank(kind: RemedyKind): number {
  return ORDER.indexOf(kind);
}

function one(signal: SignalId, reason: string | undefined, context: RemedyContext): Remedy {
  const base = { signals: [signal] as readonly SignalId[], ...(reason != null ? { because: reason } : {}) };
  if (reason == null) {
    return {
      ...base,
      kind: 'report',
      says:
        `The ${signal} signal reported no reason for failing, so there is nothing here to act on. ` +
        'That is a defect in this app rather than a finding about your estate.',
    };
  }

  const scope = demandedScope(reason);
  if (scope != null) return fromScope(signal, scope, context, base);

  // Ordered from most specific to least, because the phrases overlap: a refusal naming a
  // missing table also often says "permission", and a cancellation says "not found" on the way
  // out. Whichever pattern is checked first decides, so the narrow ones go first.
  if (/cancell?ed|timed out|timeout|budget|deadline|aborted/i.test(reason)) {
    return {
      ...base,
      kind: 'retry',
      says:
        `The ${signal} signal did not finish in this run. Nothing about your estate is implied — run the ` +
        'scan again, and if it stops here repeatedly the surface budget is the thing to raise.',
    };
  }

  if (/METASTORE_NOT_ASSIGNED|no metastore|not enabled|SCHEMA_NOT_FOUND|TABLE_OR_VIEW_NOT_FOUND|does not exist|UNRESOLVED_/i.test(reason)) {
    return {
      ...base,
      kind: 'enable',
      says:
        `The source behind ${signal} is not present in this workspace. System schemas are enabled per ` +
        'metastore and per schema rather than all at once, so this usually means one has not been enabled ' +
        'yet rather than that anything is misconfigured.',
    };
  }

  if (/PERMISSION_DENIED|permission|forbidden|not authorized|unauthorized|access denied|INSUFFICIENT_PERMISSIONS|\b403\b/i.test(reason)) {
    return {
      ...base,
      kind: 'grant',
      says:
        `The identity this scan ran as was refused ${signal}. This one is inside your own estate: a ` +
        'metastore or table grant to the scanning identity closes it, and the requirement becomes measured ' +
        'on the next run.',
    };
  }

  return {
    ...base,
    kind: 'report',
    says:
      `The ${signal} signal failed for a reason this app does not recognise, so it cannot say what would ` +
      'fix it. The platform\'s words are below; a copy of them is what an issue against this app needs.',
  };
}

/**
 * A refusal that named a scope, which is three different situations wearing one message.
 *
 * The distinction is the reason `declared-scopes.ts` exists: "invalid scope, required scopes:
 * clusters" is permanent when this app never asked for `clusters` and temporary when it did and
 * this user's consent predates the request. Both are the same string from the platform.
 */
function fromScope(
  signal: SignalId,
  scope: string,
  context: RemedyContext,
  base: { signals: readonly SignalId[]; because?: string }
): Remedy {
  const family = familyOf(context.collector);

  // The family table is checked first because it is measured rather than inferred: ADR 0016
  // probed every published scope against the Apps registry, so a name it records as refused is
  // one no install can request however it is deployed. Telling that reader to re-authorise
  // would send them round a loop that cannot terminate.
  if (family != null && !family.grantable) {
    return {
      ...base,
      kind: 'attest',
      says:
        family.plane === 'account'
          ? `${family.label} is account-plane configuration, and this app is installed in a workspace. The ` +
            'token is rejected before authorisation is considered, so no scope and no grant would help. ' +
            'Answer this requirement on the Answers page instead.'
          : `Reading this needs the "${scope}" scope, which Databricks Apps does not offer an app. No ` +
            'install of this app can be granted it, so answer this requirement on the Answers page rather ' +
            'than waiting for a version that measures it.',
    };
  }

  if (context.declaredScopes?.includes(scope) === true) {
    return {
      ...base,
      kind: 're-authorise',
      says:
        `This app asks for the "${scope}" scope and the token it was handed does not carry it, which means ` +
        'your consent predates the request. Consent is per user and widening the requested set does not ' +
        're-prompt anyone who already agreed, so signing in to the app again is what fixes this — for you, ' +
        'in one click, with no ticket.',
    };
  }

  return {
    ...base,
    kind: 'report',
    says:
      `Reading ${signal} was refused for want of the "${scope}" scope, which this app does not declare. ` +
      'That is our omission rather than a limit of the platform or a gap in your estate: the scope belongs ' +
      'in the app manifest.',
  };
}
