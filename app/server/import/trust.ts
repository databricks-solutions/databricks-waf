// Whether a well-formed envelope may be believed, here, now.
//
// `envelope.ts` establishes what the file says. This decides whether to act on it, which is a
// different question with different inputs: the file is unchanged from what the script wrote, it
// describes this estate rather than somebody else's, it is recent enough to be a statement about the
// present, and it has not been imported before.
//
// Every check returns rather than throws, and they all run. That is a deliberate reversal of the
// layers below, where the first failure ends the parse — there, a malformed document has nothing more
// to say, and here it does. An admin who forwards last quarter's file for the wrong workspace should
// be told both things at once; told one, they fix it, wait for a collection, and are told the other.
//
// The split between refusing and cautioning is the part worth arguing about, so the rule is written
// down: refuse when believing the file would make the app state something false about the estate, and
// caution when the file is believable and something about it is worth putting in front of a person.
// A digest that does not match means the bytes are not what was collected — false. A tier nobody ran
// means half the requirements have no evidence — true, and worth saying. Under that rule a stale file
// is a refusal at 30 days and a caution before it, which is the one place the boundary is a policy
// choice rather than a consequence; see ADR 0040.

import { digestOf as digestOfDocument, sameDigest } from '../records/digest.js';
import type { Envelope } from './envelope.js';

/**
 * How old a collection may be and still describe the present.
 *
 * Thirty days because that is the review cadence the audit asks for, and because the settings this
 * evidence covers are ones an estate changes deliberately rather than continuously. It is a policy
 * choice and not a fact, which is why it is one named constant rather than a number in three places.
 */
export const MAX_AGE_DAYS = 30;

/** When a file stops being current enough to pass without comment. Half the expiry, deliberately. */
export const STALE_AFTER_DAYS = 15;

/**
 * How far ahead of this app's clock a collection may claim to have run.
 *
 * Not zero, because the collecting machine's clock is not this one's and a few minutes of skew is
 * ordinary. Not generous, because a timestamp in the future is what a file uses to never expire.
 */
export const MAX_SKEW_MINUTES = 10;

export type RefusalReason =
  /** The probes are not the bytes the script digested, so something changed after collection. */
  | 'digest-mismatch'
  /** Older than the window. */
  | 'expired'
  /** Dated far enough ahead that its age cannot be believed. */
  | 'future'
  /** These exact probes have been imported already. */
  | 'replayed'
  /** Collected against a workspace this assessment does not cover. */
  | 'wrong-workspace'
  /** Collected against a different account. */
  | 'wrong-account'
  /** Neither tier ran, so there is nothing in it to believe. */
  | 'nothing-collected';

export type CautionReason =
  /** Nothing known to hold the file against, so "this estate" is unverified rather than confirmed. */
  | 'target-unverified'
  /** Same script version, different bytes. */
  | 'script-differs'
  /** One authority tier was not run, so its requirements stay unanswered. */
  | 'tier-not-run'
  /** Inside the window and old enough to say so. */
  | 'stale'
  /** A tier ran without the CLI being able to name who ran it. */
  | 'unattributed'
  /** Probes that were refused or errored, which are unmeasured rather than passing. */
  | 'probes-refused';

export interface Note<Reason> {
  readonly reason: Reason;
  /** What to show a person, in terms they can act on. */
  readonly message: string;
}

/** What the app believes it is assessing, for the envelope to be held against. */
export interface Target {
  /**
   * The account the app is installed in, if it knows.
   *
   * Absent is expected rather than exceptional: no environment variable carries it, so it is known
   * only once a scan has read the workspace directory.
   */
  readonly accountId?: string;
  /**
   * Workspace ids this assessment covers, as strings.
   *
   * Strings because two canonicalisers agree on a sixteen-digit id and both round above 2^53, so a
   * numeric comparison would be exact for today's ids and quietly wrong for a longer one. The
   * envelope carries them as strings and they are compared as strings, end to end.
   */
  readonly workspaceIds?: readonly string[];
}

export interface TrustVerdict {
  /** Whether the app may act on the file. False whenever there is a refusal. */
  readonly trusted: boolean;
  readonly refusals: readonly Note<RefusalReason>[];
  readonly cautions: readonly Note<CautionReason>[];
  /** The digest recomputed here, which is the identity a replay is detected by. */
  readonly digest: string;
  /** Age of the collection in whole hours, so a message can be specific without being false. */
  readonly ageHours: number;
}

export interface TrustInput {
  readonly envelope: Envelope;
  readonly target?: Target;
  /** Probe-set digests already imported. Membership is a replay. */
  readonly imported?: ReadonlySet<string>;
  /** The digest of the script this app publishes, for comparison with the one that collected. */
  readonly publishedScriptDigest?: string;
  readonly now?: Date;
}

/**
 * `sha256:<hex>` over the canonical form, the same way the script computes it over the same value.
 *
 * Re-exported from `records/digest.ts` rather than reimplemented. The app already has one digest
 * function over canonical bytes, and the whole reason this comparison works across two languages is
 * that there is one rule; a second implementation of it here would be a third.
 */
export function digestOf(value: unknown): string {
  return digestOfDocument(value);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** Age in whole hours, floored, and never negative — a future file's age is reported as its refusal. */
function hoursBetween(then: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 3_600_000));
}

/**
 * Whether the bytes are the bytes that were collected.
 *
 * Recomputed over the probes alone, because that is what the script digests: the envelope's own
 * metadata is outside it on purpose, so re-serialising the file — which any tool between the admin
 * and here may do — cannot invalidate the evidence, while editing a reading does.
 *
 * This is the check that makes the rest of them worth making. Without it, `generated_at` and the
 * identity block are editable, so freshness and targeting are assertions by whoever holds the file.
 */
function checkDigest(envelope: Envelope, refusals: Note<RefusalReason>[]): string {
  const recomputed = digestOf(envelope.probes);
  if (!sameDigest(recomputed, envelope.digest)) {
    refusals.push({
      reason: 'digest-mismatch',
      message:
        'The readings in this file do not match the digest the script recorded over them, so at least one has ' +
        `changed since it was collected. The file says ${envelope.digest} and its readings digest to ${recomputed}. ` +
        'Collect it again rather than editing it — reformatting the file is safe, changing a reading is not.',
    });
  }
  return recomputed;
}

function checkAge(
  envelope: Envelope,
  now: Date,
  refusals: Note<RefusalReason>[],
  cautions: Note<CautionReason>[]
): number {
  const generated = new Date(Date.parse(envelope.generatedAt));
  const skewMs = MAX_SKEW_MINUTES * 60_000;

  if (generated.getTime() > now.getTime() + skewMs) {
    refusals.push({
      reason: 'future',
      message:
        `This file says it was collected at ${envelope.generatedAt}, which is ahead of this workspace's clock by ` +
        `more than ${String(MAX_SKEW_MINUTES)} minutes. Its age cannot be established, and an age that cannot be ` +
        'established cannot expire. Check the clock on the machine that ran the script.',
    });
    return 0;
  }

  const ageHours = hoursBetween(generated, now);
  const ageDays = Math.floor(ageHours / 24);

  if (ageDays >= MAX_AGE_DAYS) {
    refusals.push({
      reason: 'expired',
      message:
        `This file was collected ${String(ageDays)} days ago, and evidence is accepted for ${String(MAX_AGE_DAYS)}. ` +
        'The settings it covers are ones an estate changes deliberately, so an older reading is not evidence of the ' +
        'present. Run the script again.',
    });
  } else if (ageDays >= STALE_AFTER_DAYS) {
    cautions.push({
      reason: 'stale',
      message:
        `Collected ${String(ageDays)} days ago, so it expires in ${String(MAX_AGE_DAYS - ageDays)}. Findings from it ` +
        'describe the estate as it was that day.',
    });
  }

  return ageHours;
}

/**
 * Whether this file is about this estate.
 *
 * Both halves are conditional on the app knowing what to compare against, and an unverified target is
 * a caution rather than a pass. The alternative — refusing until a scan has run — would make the
 * import unusable in the case it is most needed, which is a first assessment where the account-plane
 * requirements have never been answered.
 */
function checkTarget(
  envelope: Envelope,
  target: Target | undefined,
  refusals: Note<RefusalReason>[],
  cautions: Note<CautionReason>[]
): void {
  const workspace = envelope.tiers.workspace.identity;
  const account = envelope.tiers.account.identity;
  const claimed = account?.accountId ?? workspace?.accountId;

  if (target?.accountId != null && claimed != null && claimed !== target.accountId) {
    refusals.push({
      reason: 'wrong-account',
      message:
        `This file was collected against account ${claimed} and this app is assessing ${target.accountId}. ` +
        'Findings from it would describe a different estate.',
    });
  }

  const collectedFrom = workspace?.workspaceId;
  const covered = target?.workspaceIds;
  if (collectedFrom != null && covered != null && covered.length > 0 && !covered.includes(collectedFrom)) {
    refusals.push({
      reason: 'wrong-workspace',
      message:
        `The workspace half of this file was collected against workspace ${collectedFrom}, which is not one of the ` +
        `${String(covered.length)} ${plural(covered.length, 'workspace', 'workspaces')} this assessment covers. ` +
        'Its workspace-level readings describe somewhere else.',
    });
  }

  const nothingToCheck =
    (target?.accountId == null || claimed == null) &&
    (covered == null || covered.length === 0 || collectedFrom == null);
  if (nothingToCheck && refusals.length === 0) {
    cautions.push({
      reason: 'target-unverified',
      message:
        'Nothing here establishes that this file describes the estate under assessment: the app does not yet know ' +
        'which account and workspaces it is measuring, so the identity in the file was read rather than checked. ' +
        'Run an assessment first and the same file will be checked against it.',
    });
  }
}

function checkTiers(envelope: Envelope, refusals: Note<RefusalReason>[], cautions: Note<CautionReason>[]): void {
  const { workspace, account } = envelope.tiers;

  if (!workspace.ran && !account.ran) {
    refusals.push({
      reason: 'nothing-collected',
      message:
        'Neither authority tier ran, so every probe in this file was skipped and there is nothing in it to import. ' +
        'Run the script with --profile, and with --account-profile as well for the account-level requirements.',
    });
    return;
  }

  for (const [name, tier] of [
    ['workspace', workspace],
    ['account', account],
  ] as const) {
    if (tier.ran && tier.identity?.username == null) {
      // Expected for the account tier and not for the workspace one, so the message says which this
      // is rather than describing the general case. An unattributed reading is still evidence; what
      // it cannot support is a claim about who is accountable for having collected it.
      cautions.push({
        reason: 'unattributed',
        message:
          `The ${name} tier records no collecting user, so these readings cannot be attributed to a person. ` +
          (name === 'account'
            ? 'That is expected: the CLI cannot resolve an identity for an account profile, and the account plane has ' +
              'no endpoint that names the caller. The account id and host are recorded, and who ran it is not.'
            : 'That is not expected for a workspace profile, and it is worth establishing who ran this before ' +
              'relying on it.'),
      });
    }

    if (!tier.ran) {
      const affected = envelope.probes.filter((probe) => probe.tier === name);
      const controls = new Set(affected.flatMap((probe) => probe.controls));
      cautions.push({
        reason: 'tier-not-run',
        message:
          `The ${name} tier was not run, so ${String(controls.size)} ${plural(controls.size, 'requirement', 'requirements')} ` +
          `across ${String(affected.length)} ${plural(affected.length, 'call', 'calls')} stay unanswered. ` +
          (tier.reason ?? `Run the script again with a ${name} profile to answer them.`),
      });
    }
  }
}

function checkScript(envelope: Envelope, published: string | undefined, cautions: Note<CautionReason>[]): void {
  if (published == null || published === envelope.script.digest) return;

  cautions.push({
    reason: 'script-differs',
    message:
      `This file was collected by a copy of ${envelope.script.name} version ${envelope.script.version} whose digest ` +
      `is ${envelope.script.digest}, and the copy this app publishes digests to ${published}. That is expected if the ` +
      'app was updated after the collection. If it was not, the script that ran was not the one published here, and ' +
      'what it read is worth checking before acting on it.',
  });
}

function checkProbes(envelope: Envelope, cautions: Note<CautionReason>[]): void {
  const refused = envelope.probes.filter((probe) => probe.status === 'denied' || probe.status === 'error');
  if (refused.length === 0) return;

  cautions.push({
    reason: 'probes-refused',
    message:
      `${String(refused.length)} ${plural(refused.length, 'call was', 'calls were')} refused or failed, so the ` +
      'requirements behind them are unmeasured rather than passing. Each one records what the API said: ' +
      refused.map((probe) => `${probe.label} (${probe.status})`).join(', ') +
      '.',
  });
}

/**
 * The refusal a replay earns, named so both paths that can detect one say the same thing.
 *
 * There are two, and only one of them runs this check: the digest read below, and the unique index at
 * insert time that catches the pair of uploads which raced past it. The route turning that violation
 * into a response needs the identical refusal, and a second copy of this sentence would be one edit
 * away from the two paths explaining the same event differently.
 */
export const REPLAYED: Note<RefusalReason> = {
  reason: 'replayed',
  message:
    'These exact readings have been imported before. Importing them again would record a second collection where ' +
    'one happened, which is how a stale posture comes to look like a maintained one. Run the script again for a ' +
    'current reading.',
};

function checkReplay(digest: string, imported: ReadonlySet<string> | undefined, refusals: Note<RefusalReason>[]): void {
  if (imported?.has(digest) !== true) return;

  refusals.push(REPLAYED);
}

/**
 * Every reason to refuse this envelope, and everything about it worth saying out loud.
 *
 * Ordered so that the digest check runs first, because every other check reads a field the digest is
 * what makes trustworthy. They still all run — a file can be both edited and expired, and saying so
 * costs nothing — but the order is the order a reader should think in.
 */
export function assess(input: TrustInput): TrustVerdict {
  const { envelope, target, imported, publishedScriptDigest, now = new Date() } = input;
  const refusals: Note<RefusalReason>[] = [];
  const cautions: Note<CautionReason>[] = [];

  const digest = checkDigest(envelope, refusals);
  checkReplay(digest, imported, refusals);
  const ageHours = checkAge(envelope, now, refusals, cautions);
  checkTiers(envelope, refusals, cautions);
  checkTarget(envelope, target, refusals, cautions);
  checkScript(envelope, publishedScriptDigest, cautions);
  checkProbes(envelope, cautions);

  return { trusted: refusals.length === 0, refusals, cautions, digest, ageHours };
}
