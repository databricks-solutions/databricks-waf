// The envelope contract, enforced against a document that has already been proved safe to parse.
//
// Three layers, and keeping them apart is the point. `read.ts` establishes that some bytes arrived
// within a limit and decode as UTF-8; `parse.ts` establishes that the text is JSON nobody can use to
// reach an object's prototype; this establishes what the document *says*. A single function doing all
// three would have one error type for "eight megabytes" and "generated_at is a Tuesday", and a caller
// could not tell a hostile upload from a colleague on an old version of the script.
//
// The rule throughout is that a field is either present and the right shape or the file is refused.
// There is no coercion and no defaulting, for a reason specific to this document: everything here is
// load-bearing on a claim the app will make to somebody. A `generated_at` that fell back to now would
// make a two-year-old envelope current. A tier whose `ran` defaulted to false would silently discard
// the half of the evidence only an account admin can collect. A probe whose `status` defaulted to
// observed would turn a refusal into a reading. Every default available here is a lie in the direction
// of accepting the file, which is the direction that costs a customer a wrong finding.
//
// What this does *not* do is judge whether the envelope describes the estate under assessment, or
// whether it is recent, or whether its digest holds. Those are `trust.ts`, because they are questions
// about this install and this moment, and a file can be a perfectly well-formed envelope for somebody
// else's account.

/** The one schema this app reads. A version it does not know is refused rather than guessed at. */
export const SCHEMA = 'waf-admin-evidence/1';

/** Bounds on the collections, so a well-formed file cannot be a denial of service by size alone. */
export const MAX_PROBES = 500;
export const MAX_DEFERRED = 100;
/** Longest a single string field may be. Generous against the longest real one — a 900-char detail. */
export const MAX_STRING = 4_000;

export type MalformedReason =
  /** Not an object, or an array where an object belongs. */
  | 'not-an-envelope'
  /** A schema identifier this version does not read. */
  | 'unknown-schema'
  /** A field is absent, the wrong type, or outside its bounds. */
  | 'bad-field'
  /** Structurally fine and internally contradictory — a probe observed with nothing observed. */
  | 'inconsistent';

export class MalformedEnvelopeError extends Error {
  constructor(
    readonly reason: MalformedReason,
    message: string,
    /** Dotted path to the offending field, so a message can name it rather than describe it. */
    readonly at?: string
  ) {
    super(message);
    this.name = 'MalformedEnvelopeError';
  }
}

/** Whose authority a reading was made under, as the script records it. */
export interface TierIdentity {
  /**
   * The collecting user, when the CLI could name one.
   *
   * Optional because for an account profile it cannot. `auth describe` on one answers "Unable to
   * authenticate: Unable to load OAuth Config" and prints no user, while the account API calls made
   * with that same profile succeed — measured on CLI 1.1.0, and there is no account-plane endpoint
   * that names the caller either: account SCIM has no `Me`. So the account half of an envelope is
   * unattributed, and the import says so rather than inventing an actor or refusing the evidence.
   */
  readonly username?: string;
  readonly host: string;
  readonly accountId?: string;
  readonly workspaceId?: string;
  readonly authType?: string;
  readonly profile?: string;
  /**
   * Which form of `auth describe` answered — `json` or `text`.
   *
   * Kept because the text fallback exists to work around a CLI serialisation bug, and an identity read
   * from a human-readable listing is worth knowing about when one of its fields looks wrong.
   */
  readonly read?: string;
}

/**
 * One authority tier, run or not.
 *
 * A tier nobody ran is not the same as a tier that ran and found nothing, which is why `ran` is
 * required and `reason` is what a skipped tier carries. Collapsing them would report an account
 * admin's absence as an account with nothing in it.
 */
export interface TierRecord {
  readonly ran: boolean;
  readonly identity?: TierIdentity;
  readonly reason?: string;
}

export type ProbeStatus = 'observed' | 'denied' | 'error' | 'skipped';

const STATUSES: readonly ProbeStatus[] = ['observed', 'denied', 'error', 'skipped'];

export type Tier = 'workspace' | 'account';

export interface ProbeRecord {
  /** Signal ids this probe answers, matching the catalogue's `collector` values. */
  readonly signals: readonly string[];
  readonly tier: Tier;
  readonly label: string;
  /** The call as a reader can reproduce it: verb, path and query. */
  readonly endpoint: string;
  readonly controls: readonly string[];
  /** The declared paths. A consumer reads "asked for and not answered" as this minus `value`'s keys. */
  readonly fields: readonly string[];
  readonly shape: 'projected' | 'shallow';
  readonly status: ProbeStatus;
  /** Present only when observed, and required then. */
  readonly value?: unknown;
  /** The refusal or the error, verbatim, when there was one. */
  readonly detail?: string;
  /** True when the listing stopped at a page boundary, so counts are floors. */
  readonly truncated?: boolean;
}

/** A signal the script chose not to collect, with the reason it can be held to. */
export interface DeferredRecord {
  readonly signal: string;
  readonly reason: string;
}

export interface Envelope {
  readonly schema: typeof SCHEMA;
  /** When the collection ran, as the script wrote it. Held as text because that is what the digest covers. */
  readonly generatedAt: string;
  readonly script: { readonly name: string; readonly version: string; readonly digest: string };
  readonly cli: { readonly version: string };
  readonly tiers: { readonly workspace: TierRecord; readonly account: TierRecord };
  readonly probes: readonly ProbeRecord[];
  readonly deferred: readonly DeferredRecord[];
  /** The script's digest over its own probe set, which `trust.ts` recomputes rather than trusts. */
  readonly digest: string;
}

function fail(reason: MalformedReason, message: string, at?: string): never {
  throw new MalformedEnvelopeError(reason, message, at);
}

function object(value: unknown, at: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    fail('bad-field', `${at} must be an object.`, at);
  }
  return value as Record<string, unknown>;
}

function text(holder: Record<string, unknown>, key: string, at: string): string {
  const value = holder[key];
  if (typeof value !== 'string') fail('bad-field', `${at} must be a string.`, at);
  if (value === '') fail('bad-field', `${at} must not be empty.`, at);
  if (value.length > MAX_STRING) {
    fail('bad-field', `${at} is ${String(value.length)} characters, over the ${String(MAX_STRING)} allowed.`, at);
  }
  return value;
}

function optionalText(holder: Record<string, unknown>, key: string, at: string): string | undefined {
  return key in holder && holder[key] !== null ? text(holder, key, at) : undefined;
}

function flag(holder: Record<string, unknown>, key: string, at: string): boolean {
  const value = holder[key];
  if (typeof value !== 'boolean') fail('bad-field', `${at} must be true or false.`, at);
  return value;
}

function list(holder: Record<string, unknown>, key: string, at: string, limit: number): readonly unknown[] {
  const value = holder[key];
  if (!Array.isArray(value)) fail('bad-field', `${at} must be an array.`, at);
  if (value.length > limit) {
    fail('bad-field', `${at} holds ${String(value.length)} entries, over the ${String(limit)} allowed.`, at);
  }
  return value;
}

/** An array of non-empty strings, which is what every identifier list in here is. */
function names(holder: Record<string, unknown>, key: string, at: string): readonly string[] {
  return list(holder, key, at, MAX_PROBES).map((entry, index) => {
    if (typeof entry !== 'string' || entry === '' || entry.length > MAX_STRING) {
      fail('bad-field', `${at}[${String(index)}] must be a non-empty string.`, `${at}[${String(index)}]`);
    }
    return entry;
  });
}

/**
 * A timestamp the script wrote, refused unless it is the form the script writes.
 *
 * Strict rather than `new Date(value)` because that accepts almost anything and invents a value for
 * much of it: `new Date('30 days ago')` is Invalid Date, but `new Date('2026')` is a real instant, and
 * a freshness window built on it would be measuring from January.
 */
function instant(holder: Record<string, unknown>, key: string, at: string): string {
  const value = text(holder, key, at);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    fail('bad-field', `${at} must be a UTC timestamp of the form 2026-08-03T10:41:52Z.`, at);
  }

  // Round-tripped rather than parsed, because parsing is not validation here: `Date.parse` accepts
  // 2026-02-30 and answers with the 2nd of March. A date that comes back as a different date was not
  // a date, and on a field the expiry window is measured from that matters.
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().replace('.000Z', 'Z') !== value) {
    fail('bad-field', `${at} is not a real instant.`, at);
  }
  return value;
}

/** A `sha256:` digest, refused unless it is one — a truncated digest must not compare equal to itself. */
function digestOf(holder: Record<string, unknown>, key: string, at: string): string {
  const value = text(holder, key, at);
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    fail('bad-field', `${at} must be sha256: followed by 64 lowercase hex characters.`, at);
  }
  return value;
}

function identityFrom(value: unknown, at: string): TierIdentity {
  const held = object(value, at);
  return {
    username: optionalText(held, 'username', `${at}.username`),
    host: text(held, 'host', `${at}.host`),
    accountId: optionalText(held, 'account_id', `${at}.account_id`),
    workspaceId: optionalText(held, 'workspace_id', `${at}.workspace_id`),
    authType: optionalText(held, 'auth_type', `${at}.auth_type`),
    profile: optionalText(held, 'profile', `${at}.profile`),
    read: optionalText(held, 'read', `${at}.read`),
  };
}

function tierFrom(value: unknown, at: string): TierRecord {
  const held = object(value, at);
  const ran = flag(held, 'ran', `${at}.ran`);
  const identity = 'identity' in held ? identityFrom(held.identity, `${at}.identity`) : undefined;

  // A tier that ran without saying who ran it cannot be held against the estate under assessment,
  // and the whole target check depends on it. Refused here rather than treated as untargeted, so the
  // reason names the field instead of surfacing later as an unexplained mismatch.
  if (ran && identity == null) {
    fail('inconsistent', `${at} says it ran but carries no identity, so nothing can be held against it.`, at);
  }
  if (!ran && identity != null) {
    fail('inconsistent', `${at} says it did not run yet carries an identity.`, at);
  }

  return { ran, identity, reason: optionalText(held, 'reason', `${at}.reason`) };
}

function probeFrom(value: unknown, index: number): ProbeRecord {
  const at = `probes[${String(index)}]`;
  const held = object(value, at);

  const tier = text(held, 'tier', `${at}.tier`);
  if (tier !== 'workspace' && tier !== 'account') {
    fail('bad-field', `${at}.tier must be workspace or account.`, `${at}.tier`);
  }

  const status = text(held, 'status', `${at}.status`);
  if (!STATUSES.includes(status as ProbeStatus)) {
    fail('bad-field', `${at}.status must be one of ${STATUSES.join(', ')}.`, `${at}.status`);
  }

  const shape = text(held, 'shape', `${at}.shape`);
  if (shape !== 'projected' && shape !== 'shallow') {
    fail('bad-field', `${at}.shape must be projected or shallow.`, `${at}.shape`);
  }

  const observed = status === 'observed';
  if (observed && !('value' in held)) {
    // The one internal contradiction worth naming separately: a probe claiming to have observed
    // something, carrying nothing. Accepting it would resolve as an observation of an empty estate.
    fail('inconsistent', `${at} is observed but carries no value.`, at);
  }
  if (!observed && 'value' in held) {
    fail('inconsistent', `${at} is ${status} yet carries a value.`, at);
  }

  return {
    signals: names(held, 'signals', `${at}.signals`),
    tier,
    label: text(held, 'label', `${at}.label`),
    endpoint: text(held, 'endpoint', `${at}.endpoint`),
    controls: names(held, 'controls', `${at}.controls`),
    fields: names(held, 'fields', `${at}.fields`),
    shape,
    status: status as ProbeStatus,
    ...(observed ? { value: held.value } : {}),
    detail: optionalText(held, 'detail', `${at}.detail`),
    ...('truncated' in held ? { truncated: flag(held, 'truncated', `${at}.truncated`) } : {}),
  };
}

function deferredFrom(value: unknown, index: number): DeferredRecord {
  const at = `deferred[${String(index)}]`;
  const held = object(value, at);
  return {
    signal: text(held, 'signal', `${at}.signal`),
    reason: text(held, 'reason', `${at}.reason`),
  };
}

/**
 * An `Envelope`, or a `MalformedEnvelopeError` naming the field that stopped it.
 *
 * Takes the already-parsed value rather than text, so that being safe to parse and being an envelope
 * stay two separate claims with two separate failures.
 */
export function envelopeFrom(value: unknown): Envelope {
  const held = object(value, 'the file');

  const schema = text(held, 'schema', 'schema');
  if (schema !== SCHEMA) {
    // Named as its own reason because it is the one refusal with an obvious remedy — a newer script —
    // and a caller can say so rather than reporting a malformed file.
    fail('unknown-schema', `This app reads ${SCHEMA} and the file says ${schema}.`, 'schema');
  }

  const tiers = object(held.tiers, 'tiers');
  const probes = list(held, 'probes', 'probes', MAX_PROBES).map(probeFrom);
  if (probes.length === 0) fail('inconsistent', 'The file carries no probes, so there is nothing to import.', 'probes');

  return {
    schema: SCHEMA,
    generatedAt: instant(held, 'generated_at', 'generated_at'),
    script: {
      name: text(object(held.script, 'script'), 'name', 'script.name'),
      version: text(object(held.script, 'script'), 'version', 'script.version'),
      digest: digestOf(object(held.script, 'script'), 'digest', 'script.digest'),
    },
    cli: { version: text(object(held.cli, 'cli'), 'version', 'cli.version') },
    tiers: {
      workspace: tierFrom(tiers.workspace, 'tiers.workspace'),
      account: tierFrom(tiers.account, 'tiers.account'),
    },
    probes,
    deferred: list(held, 'deferred', 'deferred', MAX_DEFERRED).map(deferredFrom),
    digest: digestOf(held, 'digest', 'digest'),
  };
}
