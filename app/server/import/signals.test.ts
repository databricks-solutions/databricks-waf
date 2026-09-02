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
  it("becomes unmeasurable carrying the administrator's own refusal", () => {
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

  it("does not replace the app's refusal with the administrator's", () => {
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
  it("names which of a script's signals this build could use", () => {
    expect(revivable([SETTINGS, TOKENS, 'rest:account:network-policies'])).toEqual([SETTINGS, TOKENS]);
  });

  it('now revives all fourteen newly added held signals', () => {
    const held: readonly string[] = [
      'rest:account:accounts.log-delivery',
      'rest:account:accounts.{account_id}.ip-access-lists',
      'rest:account:accounts.settings.types.disable_legacy_features.names.default',
      'rest:workspace:secrets.scopes.list',
      'rest:workspace:clusters.list',
      'rest:workspace:ip-access-lists',
      'rest:workspace:permissions.authorization.tokens',
      'rest:workspace:settings.types.disable_legacy_dbfs.names.default',
      'rest:workspace:settings.types.sql_results_download.names.default',
      'rest:workspace:settings.types.restrict_workspace_admins.names.default',
      'rest:workspace:settings.types.automatic_cluster_update.names.default',
      'rest:workspace:settings.types.shield_csp_enablement_ws_db.names.default',
      'rest:workspace:settings.types.shield_esm_enablement_ws_db.names.default',
      'rest:account:accounts.settings.types.shield_csp_enablement_ac.names.default',
    ];
    // Every newly added signal must appear in revivable's output.
    const result = new Set(revivable(held as readonly SignalId[]));
    for (const signal of held) {
      expect(result.has(signal as SignalId), `${signal} should be revivable`).toBe(true);
    }
  });
});

// =============================================================================
// New-reviver tests: shape + admin-collected provenance
// =============================================================================
//
// For each newly added signal: (a) assert the revived shape matches what the
// corresponding resolver expects; (b) assert the resolver emits a finding with
// admin-collected provenance (evidenceClass: 'admin-collected').

import { resolveControl } from '../resolve/resolver.js';
import { loadCatalogue } from '../catalogue/catalogue.js';
import type {
  AdminClusterInventory,
  IpAccessListInventory,
  LogDeliveryInventory,
  SecretScopeInventory,
  TokenPermissions,
  TypedSettingValue,
} from '../collect/rest/shapes.js';
import {
  logDelivery,
  accountIpAccessLists,
  accountIpAccessListEnforcement,
  workspaceIpAccessLists,
  disableLegacyFeatures,
  secretScopes,
  clusterDiskEncryption,
  longRunningClusters,
  tokenCreationRestricted,
  disableLegacyDbfs,
  sqlResultsDownload,
  restrictWorkspaceAdmins,
  automaticClusterUpdate,
  complianceSecurityProfileWs,
  enhancedSecurityMonitoringWs,
  complianceSecurityProfileAc,
} from '../resolve/resolvers/security-admin.js';

const catalogue = loadCatalogue();

function spec(controlId: string) {
  const control = catalogue.controls.find((c) => c.id === controlId);
  if (control == null) throw new Error(`${controlId} not found in catalogue`);
  return control;
}

// --------------------------------------------------------------------------- log delivery

describe('reviving log delivery', () => {
  const LOG_DELIVERY: SignalId = 'rest:account:accounts.log-delivery';

  function logDeliveryFrom(value: unknown): LogDeliveryInventory {
    return one({
      signals: [LOG_DELIVERY],
      tier: 'account',
      label: 'account-log-delivery',
      fields: [
        'log_delivery_configurations[].config_id',
        'log_delivery_configurations[].config_name',
        'log_delivery_configurations[].log_type',
        'log_delivery_configurations[].output_format',
        'log_delivery_configurations[].status',
        'log_delivery_configurations[].workspace_ids_filter:count',
      ],
      value,
    })?.value as LogDeliveryInventory;
  }

  it('maps a configured audit log delivery to a typed inventory', () => {
    const revived = logDeliveryFrom({
      log_delivery_configurations: [
        {
          config_id: 'cfg-1',
          config_name: 'Audit to S3',
          log_type: 'AUDIT_LOGS',
          output_format: 'JSON',
          status: 'ENABLED',
          'workspace_ids_filter:count': 0,
        },
      ],
    });

    expect(revived.configs).toHaveLength(1);
    expect(revived.configs[0]?.configId).toBe('cfg-1');
    expect(revived.configs[0]?.configName).toBe('Audit to S3');
    expect(revived.configs[0]?.logType).toBe('AUDIT_LOGS');
    expect(revived.configs[0]?.status).toBe('ENABLED');
    expect(revived.configs[0]?.workspaceFilterCount).toBe(0);
  });

  it('reads workspace_ids_filter:count (colon in key) as a count field', () => {
    const revived = logDeliveryFrom({
      log_delivery_configurations: [{ config_id: 'x', 'workspace_ids_filter:count': 3 }],
    });

    expect(revived.configs[0]?.workspaceFilterCount).toBe(3);
  });

  it('revives an empty configuration list as an observation of zero configs', () => {
    expect(logDeliveryFrom({ log_delivery_configurations: [] }).configs).toHaveLength(0);
  });

  it('survives a missing log_delivery_configurations key', () => {
    expect(logDeliveryFrom({}).configs).toHaveLength(0);
  });

  it('passes when an enabled audit config exists and stamps evidence admin-collected', () => {
    const signal = one({
      signals: [LOG_DELIVERY],
      tier: 'account',
      label: 'account-log-delivery',
      value: {
        log_delivery_configurations: [{ config_id: 'c1', log_type: 'AUDIT_LOGS', status: 'ENABLED' }],
      },
    })!;
    const signals = new Map([[LOG_DELIVERY, signal]]);
    const finding = resolveControl(spec('SCP-04-02'), signals, logDelivery);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });

  it('fails when no configurations exist and stamps evidence admin-collected', () => {
    const signal = one({
      signals: [LOG_DELIVERY],
      tier: 'account',
      label: 'account-log-delivery',
      value: { log_delivery_configurations: [] },
    })!;
    const finding = resolveControl(spec('SCP-04-02'), new Map([[LOG_DELIVERY, signal]]), logDelivery);

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });
});

// --------------------------------------------------------------------------- account IP access lists

describe('reviving account IP access lists', () => {
  const ACCOUNT_IP: SignalId = 'rest:account:accounts.{account_id}.ip-access-lists';

  function accountIpFrom(value: unknown): IpAccessListInventory {
    return one({
      signals: [ACCOUNT_IP],
      tier: 'account',
      label: 'account-ip-access-lists',
      fields: [
        'ip_access_lists[].label',
        'ip_access_lists[].list_type',
        'ip_access_lists[].enabled',
        'ip_access_lists[].ip_addresses:count',
      ],
      value,
    })?.value as IpAccessListInventory;
  }

  it('maps an IP access list to a typed record', () => {
    const revived = accountIpFrom({
      ip_access_lists: [{ label: 'corp-vpn', list_type: 'ALLOW', enabled: true, 'ip_addresses:count': 4 }],
    });

    expect(revived.lists[0]?.label).toBe('corp-vpn');
    expect(revived.lists[0]?.listType).toBe('ALLOW');
    expect(revived.lists[0]?.enabled).toBe(true);
    expect(revived.lists[0]?.ipAddressCount).toBe(4);
  });

  it('reads ip_addresses:count (colon in key) as a number, not undefined', () => {
    const revived = accountIpFrom({ ip_access_lists: [{ 'ip_addresses:count': 7 }] });

    expect(revived.lists[0]?.ipAddressCount).toBe(7);
  });

  it('SCP-03-08 passes with an enabled ALLOW list and stamps evidence admin-collected', () => {
    const signal = one({
      signals: [ACCOUNT_IP],
      tier: 'account',
      label: 'account-ip-access-lists',
      value: { ip_access_lists: [{ list_type: 'ALLOW', enabled: true }] },
    })!;
    const finding = resolveControl(spec('SCP-03-08'), new Map([[ACCOUNT_IP, signal]]), accountIpAccessLists);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });

  it('SCP-03-12 fails when no ALLOW list exists and stamps evidence admin-collected', () => {
    const signal = one({
      signals: [ACCOUNT_IP],
      tier: 'account',
      label: 'account-ip-access-lists',
      value: { ip_access_lists: [] },
    })!;
    const finding = resolveControl(spec('SCP-03-12'), new Map([[ACCOUNT_IP, signal]]), accountIpAccessListEnforcement);

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });
});

// --------------------------------------------------------------------------- workspace IP access lists

describe('reviving workspace IP access lists', () => {
  const WS_IP: SignalId = 'rest:workspace:ip-access-lists';

  it('SCP-03-05 passes with an enabled ALLOW list and stamps evidence admin-collected', () => {
    const signal = one({
      signals: [WS_IP],
      tier: 'workspace',
      label: 'ip-access-lists',
      value: { ip_access_lists: [{ list_type: 'ALLOW', enabled: true, 'ip_addresses:count': 2 }] },
    })!;
    const finding = resolveControl(spec('SCP-03-05'), new Map([[WS_IP, signal]]), workspaceIpAccessLists);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });

  it('uses the same IpAccessListInventory shape as the account lists — shape round-trips identically', () => {
    const result = one({
      signals: [WS_IP],
      tier: 'workspace',
      label: 'ip-access-lists',
      value: { ip_access_lists: [{ label: 'office', list_type: 'ALLOW', enabled: true, 'ip_addresses:count': 1 }] },
    })?.value as IpAccessListInventory;

    expect(result.lists[0]?.label).toBe('office');
    expect(result.lists[0]?.ipAddressCount).toBe(1);
  });
});

// --------------------------------------------------------------------------- disable legacy features (account setting)

describe('reviving disable-legacy-features', () => {
  const DLF: SignalId = 'rest:account:accounts.settings.types.disable_legacy_features.names.default';

  function dlf(value: unknown): TypedSettingValue {
    return one({ signals: [DLF], tier: 'account', label: 'account-setting-disable-legacy-features', shape: 'shallow', value })
      ?.value as TypedSettingValue;
  }

  it('preserves the shallow object verbatim', () => {
    const revived = dlf({ disable_legacy_features: { value: true }, setting_name: 'default' });

    expect(typeof revived.data).toBe('object');
    expect((revived.data as Record<string, unknown>)['setting_name']).toBe('default');
  });

  it('SCP-04-21 passes when value is true and stamps evidence admin-collected', () => {
    const signal = one({
      signals: [DLF],
      tier: 'account',
      label: 'account-setting-disable-legacy-features',
      shape: 'shallow',
      value: { disable_legacy_features: { value: true }, setting_name: 'default' },
    })!;
    const finding = resolveControl(spec('SCP-04-21'), new Map([[DLF, signal]]), disableLegacyFeatures);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });

  it('SCP-04-21 fails when value is false', () => {
    const signal = one({
      signals: [DLF],
      tier: 'account',
      label: 'account-setting-disable-legacy-features',
      shape: 'shallow',
      value: { disable_legacy_features: { value: false }, setting_name: 'default' },
    })!;
    const finding = resolveControl(spec('SCP-04-21'), new Map([[DLF, signal]]), disableLegacyFeatures);

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });
});

// --------------------------------------------------------------------------- secret scopes

describe('reviving secret scopes', () => {
  const SCOPES: SignalId = 'rest:workspace:secrets.scopes.list';

  function scopesFrom(value: unknown): SecretScopeInventory {
    return one({ signals: [SCOPES], tier: 'workspace', label: 'secret-scopes', value })
      ?.value as SecretScopeInventory;
  }

  it('maps scopes to typed records', () => {
    const revived = scopesFrom({ scopes: [{ name: 'control-tower', backend_type: 'DATABRICKS' }] });

    expect(revived.scopes[0]?.name).toBe('control-tower');
    expect(revived.scopes[0]?.backendType).toBe('DATABRICKS');
  });

  it('revives an empty scope list as an observation of zero scopes', () => {
    expect(scopesFrom({ scopes: [] }).scopes).toHaveLength(0);
  });

  it('SCP-02-01 passes when scopes exist and stamps evidence admin-collected', () => {
    const signal = one({
      signals: [SCOPES],
      tier: 'workspace',
      label: 'secret-scopes',
      value: { scopes: [{ name: 'my-scope', backend_type: 'DATABRICKS' }] },
    })!;
    const finding = resolveControl(spec('SCP-02-01'), new Map([[SCOPES, signal]]), secretScopes);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });

  it('SCP-02-01 fails when no scopes exist and stamps evidence admin-collected', () => {
    const signal = one({
      signals: [SCOPES],
      tier: 'workspace',
      label: 'secret-scopes',
      value: { scopes: [] },
    })!;
    const finding = resolveControl(spec('SCP-02-01'), new Map([[SCOPES, signal]]), secretScopes);

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });
});

// --------------------------------------------------------------------------- clusters

describe('reviving clusters (disk encryption and long-running)', () => {
  const CLUSTERS: SignalId = 'rest:workspace:clusters.list';

  function clustersFrom(value: unknown): AdminClusterInventory {
    return one({ signals: [CLUSTERS], tier: 'workspace', label: 'clusters', value })
      ?.value as AdminClusterInventory;
  }

  it('maps cluster fields to typed records', () => {
    const revived = clustersFrom({
      clusters: [
        {
          cluster_id: 'abc-123',
          cluster_name: 'analytics',
          state: 'RUNNING',
          enable_local_disk_encryption: false,
          start_time: 1_754_000_000_000,
          last_restarted_time: 1_754_000_000_000,
          autotermination_minutes: 0,
          'spark_env_vars:keys': ['DB_TOKEN'],
          'init_scripts:count': 0,
        },
      ],
    });

    expect(revived.clusters[0]?.clusterId).toBe('abc-123');
    expect(revived.clusters[0]?.clusterName).toBe('analytics');
    expect(revived.clusters[0]?.enableLocalDiskEncryption).toBe(false);
    expect(revived.clusters[0]?.startTime).toEqual(new Date(1_754_000_000_000));
    expect(revived.clusters[0]?.sparkEnvVarKeys).toEqual(['DB_TOKEN']);
    expect(revived.clusters[0]?.initScriptCount).toBe(0);
  });

  it('converts epoch milliseconds for start_time and last_restarted_time to Dates', () => {
    const revived = clustersFrom({
      clusters: [{ cluster_id: 'x', start_time: 1_700_000_000_000, last_restarted_time: 1_754_000_000_000 }],
    });

    expect(revived.clusters[0]?.startTime).toEqual(new Date(1_700_000_000_000));
    expect(revived.clusters[0]?.lastRestartedTime).toEqual(new Date(1_754_000_000_000));
  });

  it('reads spark_env_vars:keys (colon in key) as a string array', () => {
    const revived = clustersFrom({ clusters: [{ cluster_id: 'x', 'spark_env_vars:keys': ['FOO', 'BAR'] }] });

    expect(revived.clusters[0]?.sparkEnvVarKeys).toEqual(['FOO', 'BAR']);
  });

  it('SCP-02-02 fails when a cluster has encryption disabled and stamps evidence admin-collected', () => {
    const signal = one({
      signals: [CLUSTERS],
      tier: 'workspace',
      label: 'clusters',
      value: { clusters: [{ cluster_id: 'x', enable_local_disk_encryption: false }] },
    })!;
    const finding = resolveControl(spec('SCP-02-02'), new Map([[CLUSTERS, signal]]), clusterDiskEncryption);

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });

  it('SCP-02-02 passes when all clusters have encryption enabled', () => {
    const signal = one({
      signals: [CLUSTERS],
      tier: 'workspace',
      label: 'clusters',
      value: { clusters: [{ cluster_id: 'x', enable_local_disk_encryption: true }] },
    })!;
    const finding = resolveControl(spec('SCP-02-02'), new Map([[CLUSTERS, signal]]), clusterDiskEncryption);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });

  it('SCP-04-03 fails on a long-running cluster and stamps evidence admin-collected', () => {
    // A cluster started more than 30 days ago, with no restart.
    const staleTime = Date.now() - 40 * 86_400_000;
    const signal = one({
      signals: [CLUSTERS],
      tier: 'workspace',
      label: 'clusters',
      value: { clusters: [{ cluster_id: 'old', cluster_name: 'stale', state: 'RUNNING', start_time: staleTime }] },
    })!;
    const finding = resolveControl(spec('SCP-04-03'), new Map([[CLUSTERS, signal]]), longRunningClusters);

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });
});

// --------------------------------------------------------------------------- token permissions

describe('reviving token permissions', () => {
  const TOKEN_PERMS: SignalId = 'rest:workspace:permissions.authorization.tokens';

  function tokenPermsFrom(value: unknown): TokenPermissions {
    return one({ signals: [TOKEN_PERMS], tier: 'workspace', label: 'token-permissions', value })
      ?.value as TokenPermissions;
  }

  it('maps ACL entries to typed records', () => {
    const revived = tokenPermsFrom({
      access_control_list: [
        { group_name: 'admins', all_permissions: [{ permission_level: 'CAN_MANAGE' }] },
      ],
    });

    expect(revived.entries[0]?.groupName).toBe('admins');
    expect(revived.entries[0]?.permissionLevels).toEqual(['CAN_MANAGE']);
  });

  it('SCP-01-06 fails when the users group appears and stamps evidence admin-collected', () => {
    const signal = one({
      signals: [TOKEN_PERMS],
      tier: 'workspace',
      label: 'token-permissions',
      value: {
        access_control_list: [
          { group_name: 'users', all_permissions: [{ permission_level: 'CAN_USE' }] },
        ],
      },
    })!;
    const finding = resolveControl(spec('SCP-01-06'), new Map([[TOKEN_PERMS, signal]]), tokenCreationRestricted);

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });

  it('SCP-01-06 passes when only admins appear in the ACL', () => {
    const signal = one({
      signals: [TOKEN_PERMS],
      tier: 'workspace',
      label: 'token-permissions',
      value: {
        access_control_list: [
          { group_name: 'admins', all_permissions: [{ permission_level: 'CAN_MANAGE' }] },
        ],
      },
    })!;
    const finding = resolveControl(spec('SCP-01-06'), new Map([[TOKEN_PERMS, signal]]), tokenCreationRestricted);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });
});

// --------------------------------------------------------------------------- typed workspace settings

describe('reviving typed workspace settings', () => {
  // One test per signal for shape + admin-collected provenance.

  it('disable_legacy_dbfs (SCP-02-10) passes when value is true', () => {
    const SIGNAL: SignalId = 'rest:workspace:settings.types.disable_legacy_dbfs.names.default';
    const signal = one({
      signals: [SIGNAL],
      tier: 'workspace',
      label: 'setting-disable-legacy-dbfs',
      shape: 'shallow',
      value: { disable_legacy_dbfs: { value: true }, setting_name: 'default' },
    })!;
    const finding = resolveControl(spec('SCP-02-10'), new Map([[SIGNAL, signal]]), disableLegacyDbfs);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });

  it('sql_results_download (SCP-02-11) passes when boolean_val.value is false (downloads disabled)', () => {
    const SIGNAL: SignalId = 'rest:workspace:settings.types.sql_results_download.names.default';
    const signal = one({
      signals: [SIGNAL],
      tier: 'workspace',
      label: 'setting-sql-results-download',
      shape: 'shallow',
      value: { boolean_val: { value: false }, setting_name: 'default' },
    })!;
    const finding = resolveControl(spec('SCP-02-11'), new Map([[SIGNAL, signal]]), sqlResultsDownload);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });

  it('restrict_workspace_admins (SCP-04-19) passes when status is not ALLOW_ALL', () => {
    const SIGNAL: SignalId = 'rest:workspace:settings.types.restrict_workspace_admins.names.default';
    const signal = one({
      signals: [SIGNAL],
      tier: 'workspace',
      label: 'setting-restrict-workspace-admins',
      shape: 'shallow',
      value: { restrict_workspace_admins: { status: 'RESTRICT_TOKENS' }, setting_name: 'default' },
    })!;
    const finding = resolveControl(spec('SCP-04-19'), new Map([[SIGNAL, signal]]), restrictWorkspaceAdmins);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });

  it('restrict_workspace_admins (SCP-04-19) fails when status is ALLOW_ALL', () => {
    const SIGNAL: SignalId = 'rest:workspace:settings.types.restrict_workspace_admins.names.default';
    const signal = one({
      signals: [SIGNAL],
      tier: 'workspace',
      label: 'setting-restrict-workspace-admins',
      shape: 'shallow',
      value: { restrict_workspace_admins: { status: 'ALLOW_ALL' }, setting_name: 'default' },
    })!;
    const finding = resolveControl(spec('SCP-04-19'), new Map([[SIGNAL, signal]]), restrictWorkspaceAdmins);

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });

  it('automatic_cluster_update (SCP-04-20) passes when enabled is true', () => {
    const SIGNAL: SignalId = 'rest:workspace:settings.types.automatic_cluster_update.names.default';
    const signal = one({
      signals: [SIGNAL],
      tier: 'workspace',
      label: 'setting-automatic-cluster-update',
      shape: 'shallow',
      value: { automatic_cluster_update_workspace: { enabled: true }, setting_name: 'default' },
    })!;
    const finding = resolveControl(spec('SCP-04-20'), new Map([[SIGNAL, signal]]), automaticClusterUpdate);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });

  it('shield_csp_enablement_ws_db (SCP-05-13) passes when is_enabled is true', () => {
    const SIGNAL: SignalId = 'rest:workspace:settings.types.shield_csp_enablement_ws_db.names.default';
    const signal = one({
      signals: [SIGNAL],
      tier: 'workspace',
      label: 'setting-compliance-security-profile',
      shape: 'shallow',
      value: { compliance_security_profile_workspace: { is_enabled: true }, setting_name: 'default' },
    })!;
    const finding = resolveControl(spec('SCP-05-13'), new Map([[SIGNAL, signal]]), complianceSecurityProfileWs);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });

  it('shield_esm_enablement_ws_db (SCP-05-14) passes when is_enabled is true', () => {
    const SIGNAL: SignalId = 'rest:workspace:settings.types.shield_esm_enablement_ws_db.names.default';
    const signal = one({
      signals: [SIGNAL],
      tier: 'workspace',
      label: 'setting-enhanced-security-monitoring',
      shape: 'shallow',
      value: { enhanced_security_monitoring_workspace: { is_enabled: true }, setting_name: 'default' },
    })!;
    const finding = resolveControl(spec('SCP-05-14'), new Map([[SIGNAL, signal]]), enhancedSecurityMonitoringWs);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });

  it('shield_csp_enablement_ac (SCP-05-11) passes when is_enforced is true', () => {
    const SIGNAL: SignalId = 'rest:account:accounts.settings.types.shield_csp_enablement_ac.names.default';
    const signal = one({
      signals: [SIGNAL],
      tier: 'account',
      label: 'account-setting-compliance-security-profile',
      shape: 'shallow',
      value: { csp_enablement_account: { is_enforced: true }, setting_name: 'default' },
    })!;
    const finding = resolveControl(spec('SCP-05-11'), new Map([[SIGNAL, signal]]), complianceSecurityProfileAc);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.evidenceClass).toBe('admin-collected');
  });
});
