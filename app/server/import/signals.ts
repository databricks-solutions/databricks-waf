// The bridge: a reading an administrator imported becomes a signal the resolvers already read.
//
// Everything up to here treated the imported file as a document — parsed it, validated its shape,
// decided whether to trust it, stored it. None of that made it answer a requirement. A resolver does
// not read envelopes; it reads `SignalResult`s out of a map, and it must not be able to tell that one
// of them came in through a file rather than off the control plane. That indistinguishability is the
// point: the alternative is a second set of resolvers for imported evidence, which would be the same
// logic maintained twice and drifting from the moment it was written.
//
// So this module does three things and refuses a fourth.
//
// It revives the shape. The two languages disagree about what a reading looks like:
// `WorkspaceSettings.values` is a `Map` in the app and an object in JSON, a `Date` is a `Date` here
// and epoch milliseconds there. A resolver written against the collected shape would silently read
// `undefined` off the imported one, and report a workspace with every setting correct as a workspace
// with none of them set — a false failure, which is the worst thing this app can produce. So the
// revival is explicit, per signal, and a signal with no reviver is not offered to the resolvers at
// all. Held, listed, and honest about being unusable.
//
// It stamps the authority. The provenance says the reading was made by an administrator's own CLI
// under an identity this app never held, which is what makes `evidenceFrom` class the resulting
// evidence `admin-collected` rather than `observed`. One field, and the score, the composition
// sentence and both exports pick it up without knowing this module exists.
//
// It keeps the ordering. An observation the app made itself is never replaced by an import, because
// `mayDecideOver` says so and because the reverse would let a stale file overwrite a live reading.
//
// What it refuses to do is invent. A probe that was denied does not become an observation of absence;
// it becomes an unmeasurable signal carrying the administrator's own refusal message, which is
// strictly better than the app's "not collected" and strictly less than a measurement. ADR 0041.

import { asDate, asSettingValue } from '../collect/rest/probes.js';
import { COMPLETE, type SignalId, type SignalResult } from '../collect/signal.js';
import type { Provenance } from '../collect/provenance.js';
import { SURFACES, type Surface } from '../scan/surfaces.js';
import type { TokenInventory, TokenRecord, WorkspaceSettings } from '../collect/rest/shapes.js';
import type { ImportedEvidence } from './store.js';
import type { Envelope, ProbeRecord } from './envelope.js';

/**
 * What an import yielded, separated by whether a resolver can use it.
 *
 * The unrevived list is not a failure and not a warning: it is the honest count of readings this app
 * holds and cannot yet read, which is the number that tells a reader how much of the import is doing
 * work. Row 15 collects 32 signals; the app has resolvers for a fraction of them, and pretending
 * otherwise by handing over unrevived values would produce false findings rather than fewer.
 */
export interface ImportedReadings {
  readonly signals: ReadonlyMap<SignalId, SignalResult>;
  /**
   * Names in the file this app has no reviver for, so they were not offered to a resolver.
   *
   * Plain strings rather than `SignalId`s, because the file is untrusted input and one of the things
   * it can carry is a name no surface in this app answers to. Typing them as ids would be the schema
   * asserting something the envelope validation deliberately does not check.
   *
   * Each name once. This is what the surface counts to tell a reader how much of their file this build
   * cannot use, and a name two probes both carry is one signal held back, not two.
   */
  readonly unrevived: readonly string[];
}

/** Turns a JSON value into the shape a collector on this surface would have returned. */
type Reviver = (probe: ProbeRecord) => unknown;

/**
 * The workspace settings, as fifteen controls read them.
 *
 * The distinction this rebuilds is the one the whole settings table exists for. A key the endpoint
 * answered with `null` was never set by this workspace; a key it did not answer at all is a key this
 * workspace's cloud or tier does not have. The script preserves both — a null value for the first, an
 * absent field for the second — and both must survive the crossing, because a resolver that read them
 * as the same thing would report "not configured" for a setting that cannot exist here.
 */
const workspaceSettings: Reviver = (probe): WorkspaceSettings => {
  const answered = asObject(probe.value);
  const values = new Map<string, string | null>();
  const unanswered: string[] = [];

  // The declared fields are the keys the script asked for, which is what makes absence readable:
  // without them, a key missing from the answer and a key never requested look identical.
  for (const key of probe.fields) {
    if (!(key in answered)) {
      unanswered.push(key);
      continue;
    }
    values.set(key, asSettingValue(answered[key]));
  }

  return { values, unanswered };
};

/**
 * The personal access tokens, as three controls read them.
 *
 * `expiresAt` absent is the finding rather than a gap: the endpoint omits an expiry for a token that
 * never expires, and two of these controls are looking for exactly that. So an absent field must
 * revive as `undefined` and not as a date, which is why every timestamp goes through the same
 * coercion the collector uses.
 */
const tokenInventory: Reviver = (probe): TokenInventory => {
  const answered = asObject(probe.value);
  const listed = Array.isArray(answered.token_infos) ? answered.token_infos : [];

  const tokens: TokenRecord[] = listed.map((entry): TokenRecord => {
    const token = asObject(entry);
    return {
      id: asId(token.token_id),
      createdBy: asText(token.created_by_username),
      comment: asText(token.comment),
      createdAt: asDate(asEpoch(token.creation_time)),
      expiresAt: asDate(asEpoch(token.expiry_time)),
    };
  });

  // The script has no page limit and reads what one call returns, so a truncated listing is not
  // something it can report. Claiming completeness would be the wrong direction — but claiming
  // truncation on every import would attach a caveat to every finding — so the honest reading is
  // that the collection was not truncated, and the coverage the envelope carries says the rest.
  return { tokens, truncated: false };
};

/**
 * The revivers, by signal.
 *
 * Deliberately a small map rather than a generic decoder. A generic one would accept every signal in
 * the file, which reads as progress and is the failure mode described at the top: a resolver handed a
 * plain object where it expected a `Map` finds nothing and reports a compliant workspace as a broken
 * one. Adding a signal here is a deliberate act with a test beside it.
 */
const REVIVERS: ReadonlyMap<SignalId, Reviver> = new Map<SignalId, Reviver>([
  ['rest:workspace:preview.workspace-conf', workspaceSettings],
  ['rest:workspace:token.list', tokenInventory],
]);

/** Which signals in a file this app could use, without needing the file. For the UI's held count. */
export function revivable(signals: readonly SignalId[]): readonly SignalId[] {
  return signals.filter((signal) => REVIVERS.has(signal));
}

/**
 * The readings an import offers a scan.
 *
 * Takes the stored import rather than the envelope because the provenance names who collected it and
 * when it was imported, and a reading that could not say whose authority produced it would be
 * unattributable — which is the one thing an imported number may not be.
 */
export function readingsFrom(imported: ImportedEvidence): ImportedReadings {
  const signals = new Map<SignalId, SignalResult>();
  const unrevived = new Set<string>();

  for (const probe of imported.envelope.probes) {
    for (const name of probe.signals) {
      if (!signalled(name)) {
        unrevived.add(name);
        continue;
      }
      const reviver = REVIVERS.get(name);
      if (reviver == null) {
        unrevived.add(name);
        continue;
      }
      const revived = resultFrom(name, probe, reviver, imported.envelope);
      if (preferred(signals.get(name), revived)) signals.set(name, revived);
    }
  }

  return { signals, unrevived: [...unrevived] };
}

/**
 * Whether a second reading of the same signal should replace the first.
 *
 * Two probes in one file can name the same signal, because a signal is a fact and more than one API
 * can carry it — and the script does not deduplicate, on purpose: what it collected is what it wrote
 * down. So the choice lands here, and it is not "the last one wins". A refusal arriving after a
 * reading would erase the reading and turn a measured requirement into an unmeasured one, which is
 * the wrong direction for a file that demonstrably contains the answer.
 *
 * A reading beats a refusal. Otherwise the first stands, because there is nothing in the file that
 * makes the second of two equally-good readings the better one, and preferring the later would make
 * the result depend on probe order in a file this app did not write.
 */
function preferred(held: SignalResult | undefined, arriving: SignalResult): boolean {
  if (held == null) return true;
  return held.status === 'unmeasurable' && arriving.status !== 'unmeasurable';
}

/**
 * Whether a name in the file is a signal id at all.
 *
 * The envelope validation checks that the signal names are non-empty strings and stops there, on
 * purpose: a file from a newer script naming a signal this build has never heard of is a file to hold,
 * not a file to refuse. So the narrowing happens here, where an unrecognised name has somewhere
 * harmless to go.
 */
function signalled(name: string): name is SignalId {
  const colon = name.indexOf(':');
  return colon > 0 && SURFACES.includes(name.slice(0, colon) as Surface);
}

function resultFrom(id: SignalId, probe: ProbeRecord, reviver: Reviver, envelope: Envelope): SignalResult {
  const provenance = provenanceFor(probe, envelope);

  // Built by hand rather than through `observed()` and `unmeasurable()` because those stamp
  // `collectedAt` with the present moment, and the whole point of this timestamp is that the reading
  // was made at some other one. A finding dated now, from a file collected nine days ago, would make
  // the freshness caveat the import surface prints unfalsifiable.
  const base = { id, coverage: COMPLETE, collectedAt: new Date(envelope.generatedAt), durationMs: 0, provenance };

  if (probe.status !== 'observed') {
    return { ...base, status: 'unmeasurable', unmeasurableReason: refusalOf(probe) };
  }

  return { ...base, status: 'observed', value: reviver(probe) };
}

/**
 * Why the administrator could not read it either, in their words rather than the app's.
 *
 * A denial the admin hit is more informative than the app's own, because it rules out the explanation
 * a reader would otherwise reach for: that the app lacked a scope somebody could grant it. So the
 * message names the tier and keeps the control plane's detail.
 */
function refusalOf(probe: ProbeRecord): string {
  const where = probe.tier === 'account' ? 'the account console' : 'the workspace';
  const said = probe.detail ?? 'no reason given';
  const how = probe.status === 'denied' ? 'refused' : probe.status === 'skipped' ? 'did not attempt' : 'failed';
  return `An administrator's own reading of ${where} ${how} this: ${said}`;
}

/**
 * The authority an imported reading was made under.
 *
 * `admin-cli` and not the app's execution mode, because that is the fact a disputed number turns on:
 * this was read by a person at a terminal, holding permissions the app does not hold and cannot
 * check, and it is the reason the resulting evidence is classed `admin-collected`. The actor is the
 * username the CLI reported, or the tier's own name when the CLI would not say — an account profile
 * has no username to give, which is a caveat the import surface already prints.
 */
function provenanceFor(probe: ProbeRecord, envelope: Envelope): Provenance {
  const identity = envelope.tiers[probe.tier].identity;
  return {
    surface: 'rest',
    collector: `admin-script:${probe.label}`,
    authority: 'admin-cli',
    actor: identity?.username ?? `an unnamed ${probe.tier} administrator`,
    ...(identity?.host != null ? { from: identity.host } : {}),
  };
}

/**
 * The map a scan resolves against, with imported readings filling only what it did not read itself.
 *
 * The rule is `mayDecideOver` expressed over signals rather than findings, and it is one-directional
 * in both halves. An observation the app made stands: a file cannot overwrite a live reading, however
 * recent the file claims to be, because the app can re-run its own reading and cannot re-run the
 * import. But an import does replace an *unmeasurable* — a signal the app tried and was refused is
 * exactly the gap the import exists to fill, and leaving the refusal in place would mean importing
 * evidence changed nothing.
 */
export function merged(
  collected: ReadonlyMap<SignalId, SignalResult>,
  imported: ReadonlyMap<SignalId, SignalResult>
): ReadonlyMap<SignalId, SignalResult> {
  const merged = new Map(collected);

  for (const [id, incoming] of imported) {
    const existing = merged.get(id);
    if (existing == null) {
      merged.set(id, incoming);
      continue;
    }
    // An unmeasurable of either kind stays unmeasurable, so the app's own refusal is not replaced by
    // the admin's. Both are gaps; preferring the imported one would churn the reason without
    // measuring anything.
    if (existing.status === 'unmeasurable' && incoming.status === 'observed') merged.set(id, incoming);
  }

  return merged;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * An identifier from an untrusted file, as a string.
 *
 * Only primitives are converted. The collector can write `String(token.token_id)` because the SDK
 * types say what it is; here the value came out of a file, and stringifying an object would put
 * `[object Object]` into a finding as if it were a token id.
 */
function asId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Epoch milliseconds as the file carries them: a number, or a string when JSON round-tripping made one. */
function asEpoch(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}
