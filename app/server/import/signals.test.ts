// What the bridge has to get right, and what it must refuse to guess.
//
// The failure this file exists to prevent is a false pass or a false failure produced by a shape
// mismatch. A resolver handed a plain object where it expected a `Map` finds nothing in it and reports
// a workspace with every setting correct as a workspace with none set — silently, with a confident
// number beside it. So the revival tests assert against the shape the collector produces, not against
// a shape written down here, and the two are compared field by field.
//
// The second half is precedence. An import must not overwrite something the app read itself, must fill
// what it could not read, and must not turn a refusal into a measurement.

import { describe, expect, it } from 'vitest';
import { merged, readingsFrom, revivable } from './signals.js';
import { envelope, probe } from './envelope-fixture.js';
import { envelopeFrom } from './envelope.js';
import type { ImportedEvidence } from './store.js';
import type { TokenInventory, WorkspaceSettings } from '../collect/rest/shapes.js';
import { observed, unmeasurable, type SignalId, type SignalResult } from '../collect/signal.js';

const SETTINGS: SignalId = 'rest:workspace:preview.workspace-conf';
const TOKENS: SignalId = 'rest:workspace:token.list';

/**
 * A stored import, built from the same raw JSON the wire carries and validated the same way.
 *
 * Through `envelopeFrom` rather than around it, because a fixture that constructed the typed shape
 * directly could hold a value the validation would have refused, and then this file would be testing
 * the bridge against inputs it can never receive.
 */
function imported(overrides: Record<string, unknown> = {}): ImportedEvidence {
  return {
    digest: 'a'.repeat(64),
    generatedAt: new Date('2026-08-01T09:00:00Z'),
    importedAt: new Date('2026-08-02T09:00:00Z'),
    importedBy: 'assessor@example.com',
    envelope: envelopeFrom(envelope(overrides)),
    cautions: [],
  };
}

/** One probe, in a file, revived. The path most tests below take. */
function one(overrides: Record<string, unknown>): SignalResult | undefined {
  const record = probe(overrides);
  const named = (record.signals as readonly string[])[0] as SignalId;
  return readingsFrom(imported({ probes: [record] })).signals.get(named);
}

describe('reviving the workspace settings', () => {
  const asked = ['enableTokensConfig', 'enableIpAccessLists', 'enableGp3'];

  function settings(value: unknown): WorkspaceSettings {
    return one({ signals: [SETTINGS], label: 'workspace-conf', fields: asked, value })?.value as WorkspaceSettings;
  }

  it('carries a value the workspace set', () => {
    expect(settings({ enableTokensConfig: 'false' }).values.get('enableTokensConfig')).toBe('false');
  });

  it('keeps a null as a null, because never-set is not the same fact as set-to-false', () => {
    const revived = settings({ enableTokensConfig: null });

    expect(revived.values.has('enableTokensConfig')).toBe(true);
    expect(revived.values.get('enableTokensConfig')).toBeNull();
  });

  it('reads a key the endpoint never answered as unanswered rather than as null', () => {
    // The distinction the whole settings table exists for. A key this workspace's tier does not have
    // must not resolve as a key it left unconfigured, or the finding names a setting that cannot exist.
    const revived = settings({ enableTokensConfig: 'true' });

    expect(revived.unanswered).toEqual(['enableIpAccessLists', 'enableGp3']);
    expect(revived.values.has('enableIpAccessLists')).toBe(false);
  });

  it('coerces the same way the collector does, so a boolean and its string read alike', () => {
    const revived = settings({ enableTokensConfig: true, enableIpAccessLists: false });

    expect(revived.values.get('enableTokensConfig')).toBe('true');
    expect(revived.values.get('enableIpAccessLists')).toBe('false');
  });

  it('answers with a Map, not an object, because that is what fifteen resolvers call get on', () => {
    expect(settings({ enableGp3: 'true' }).values).toBeInstanceOf(Map);
  });
});

describe('reviving the token inventory', () => {
  function tokens(value: unknown): TokenInventory {
    return one({ signals: [TOKENS], label: 'token-management', value })?.value as TokenInventory;
  }

  it('turns epoch milliseconds into dates', () => {
    const revived = tokens({
      token_infos: [{ token_id: 'abc', creation_time: 1_754_000_000_000, expiry_time: 1_756_000_000_000 }],
    });

    expect(revived.tokens[0]?.createdAt).toEqual(new Date(1_754_000_000_000));
    expect(revived.tokens[0]?.expiresAt).toEqual(new Date(1_756_000_000_000));
  });

  it('reads a large id that JSON round-tripped as a string', () => {
    // The script writes what the control plane sent, and the control plane is inconsistent about
    // whether a 13-digit epoch is a number or a string. Both must revive to the same date.
    const revived = tokens({ token_infos: [{ token_id: 'abc', creation_time: '1754000000000' }] });

    expect(revived.tokens[0]?.createdAt).toEqual(new Date(1_754_000_000_000));
  });

  it('leaves a never-expiring token with no expiry, because that absence is the finding', () => {
    const revived = tokens({ token_infos: [{ token_id: 'abc', creation_time: 1_754_000_000_000 }] });

    expect(revived.tokens[0]?.expiresAt).toBeUndefined();
  });

  it('treats a zero expiry as no expiry, as the collector does', () => {
    const revived = tokens({ token_infos: [{ token_id: 'abc', expiry_time: 0 }] });

    expect(revived.tokens[0]?.expiresAt).toBeUndefined();
  });

  it('reads an empty listing as an observation of no tokens', () => {
    expect(tokens({ token_infos: [] }).tokens).toEqual([]);
  });

  it('survives a listing that carries no token_infos at all', () => {
    expect(tokens({}).tokens).toEqual([]);
  });
});

describe('what it will not offer a resolver', () => {
  it('holds a signal it has no reviver for rather than handing over the raw shape', () => {
    const readings = readingsFrom(imported({ probes: [probe({ signals: ['rest:account:network-policies'] })] }));

    expect(readings.signals.size).toBe(0);
    expect(readings.unrevived).toEqual(['rest:account:network-policies']);
  });

  it('holds a name from a newer script that names no surface this build knows', () => {
    const readings = readingsFrom(imported({ probes: [probe({ signals: ['quantum:entanglement'] })] }));

    expect(readings.unrevived).toEqual(['quantum:entanglement']);
  });

  /*
   * The surface counts this list to tell a reader how much of their file this build cannot use. Two
   * probes naming the same unusable signal is one signal held back, and counting it twice inflates the
   * shortfall the reader is being asked to act on.
   */
  it('names an unusable signal once however many probes carry it', () => {
    const readings = readingsFrom(
      imported({
        probes: [
          probe({ signals: ['rest:account:network-policies'], label: 'one' }),
          probe({ signals: ['rest:account:network-policies'], label: 'two' }),
        ],
      })
    );

    expect(readings.unrevived).toEqual(['rest:account:network-policies']);
  });
});

/*
 * A signal is a fact, and more than one API can carry it, so a file can name the same signal twice. The
 * script does not deduplicate — what it collected is what it wrote down — which puts the choice here.
 * Taking the last would let a refusal erase a reading, turning a requirement the file demonstrably
 * answers into one it does not.
 */
describe('the same signal named twice in one file', () => {
  function bothWays(first: Record<string, unknown>, second: Record<string, unknown>): SignalResult | undefined {
    return readingsFrom(imported({ probes: [probe(first), probe(second)] })).signals.get(TOKENS);
  }

  const READING = { signals: [TOKENS], label: 'token-management', value: { token_infos: [] } };
  const REFUSAL = { signals: [TOKENS], label: 'token-fallback', status: 'denied', detail: 'nope', value: undefined };

  it('keeps the reading when the refusal comes second', () => {
    expect(bothWays(READING, REFUSAL)?.status).toBe('observed');
  });

  it('takes the reading when the refusal came first', () => {
    expect(bothWays(REFUSAL, READING)?.status).toBe('observed');
  });

  it('keeps the first of two readings, rather than depending on probe order', () => {
    const kept = bothWays(READING, { ...READING, label: 'token-management-again' });

    expect(kept?.provenance?.collector).toBe('admin-script:token-management');
  });

  it('stays unmeasurable when both refused', () => {
    expect(bothWays(REFUSAL, { ...REFUSAL, label: 'token-third' })?.status).toBe('unmeasurable');
  });
});

describe('a probe that did not observe', () => {
  it('becomes unmeasurable carrying the administrator’s own refusal', () => {
    const result = one({
      signals: [TOKENS],
      status: 'denied',
      detail: 'PERMISSION_DENIED: token management requires workspace admin',
      value: undefined,
    });

    expect(result?.status).toBe('unmeasurable');
    expect(result?.unmeasurableReason).toContain('workspace');
    expect(result?.unmeasurableReason).toContain('PERMISSION_DENIED');
  });

  it('names the account console when that is the tier that refused', () => {
    const result = one({ signals: [TOKENS], tier: 'account', status: 'denied', detail: 'nope', value: undefined });

    expect(result?.unmeasurableReason).toContain('the account console');
  });

  it('does not become an observation of absence', () => {
    const result = one({ signals: [SETTINGS], status: 'error', detail: 'connection reset', value: undefined });

    expect(result?.value).toBeUndefined();
  });
});

describe('the provenance an imported reading carries', () => {
  it('names the authority the app never held, which is what classes the evidence', () => {
    const result = one({ signals: [TOKENS], label: 'token-management', value: { token_infos: [] } });

    expect(result?.provenance?.authority).toBe('admin-cli');
    expect(result?.provenance?.collector).toBe('admin-script:token-management');
  });

  it('names the collecting administrator, not the uploader', () => {
    const result = one({ signals: [TOKENS], value: { token_infos: [] } });

    expect(result?.provenance?.actor).toBe('admin@example.com');
  });

  it('says the administrator was unnamed when the CLI would not say who they were', () => {
    const result = readingsFrom(
      imported({
        tiers: {
          workspace: { ran: true, identity: { host: 'https://example.cloud.databricks.com' } },
          account: { ran: false, reason: 'no profile given' },
        },
        probes: [probe({ signals: [TOKENS], value: { token_infos: [] } })],
      })
    ).signals.get(TOKENS);

    expect(result?.provenance?.actor).toBe('an unnamed workspace administrator');
  });

  it('is dated when the administrator collected it, not when the scan ran', () => {
    const result = readingsFrom(
      imported({
        generated_at: '2026-07-25T11:30:00Z',
        probes: [probe({ signals: [TOKENS], value: { token_infos: [] } })],
      })
    ).signals.get(TOKENS);

    expect(result?.collectedAt).toEqual(new Date('2026-07-25T11:30:00Z'));
  });
});

describe('precedence between what the app read and what was imported', () => {
  const live = observed(SETTINGS, { values: new Map(), unanswered: [] }, 12);
  const file = one({ signals: [SETTINGS], fields: [], value: {} })!;

  it('fills a signal the scan did not read at all', () => {
    expect(merged(new Map(), new Map([[SETTINGS, file]])).get(SETTINGS)).toBe(file);
  });

  it('fills a signal the scan tried and was refused', () => {
    const refused = new Map([[SETTINGS, unmeasurable(SETTINGS, 'the app holds no settings scope')]]);

    expect(merged(refused, new Map([[SETTINGS, file]])).get(SETTINGS)).toBe(file);
  });

  it('never replaces an observation the app made itself', () => {
    // The one-directional rule. The app can re-run its own reading and cannot re-run the import, so a
    // file — however recent it claims to be — does not get to overwrite a live measurement.
    const own = new Map([[SETTINGS, live]]);

    expect(merged(own, new Map([[SETTINGS, file]])).get(SETTINGS)).toBe(live);
  });

  it('does not replace the app’s refusal with the administrator’s', () => {
    const ours = unmeasurable(SETTINGS, 'the app holds no settings scope');
    const theirs = one({ signals: [SETTINGS], status: 'denied', detail: 'nope', value: undefined })!;

    expect(merged(new Map([[SETTINGS, ours]]), new Map([[SETTINGS, theirs]])).get(SETTINGS)).toBe(ours);
  });

  it('leaves every other signal the scan collected untouched', () => {
    const elsewhere: SignalId = 'sql:maintenance.recency';
    const other = observed(elsewhere, [], 3);
    const result = merged(new Map([[elsewhere, other]]), new Map([[SETTINGS, file]]));

    expect(result.size).toBe(2);
    expect(result.get(elsewhere)).toBe(other);
  });
});

describe('what a caller can know without a file', () => {
  it('names which of a script’s signals this build could use', () => {
    expect(revivable([SETTINGS, TOKENS, 'rest:account:network-policies'])).toEqual([SETTINGS, TOKENS]);
  });
});
