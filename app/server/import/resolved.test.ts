// The proof that the bridge closed: an imported file decides a requirement, and says so honestly.
//
// Every other test in this directory checks one link in the chain. This one checks that the chain
// carries weight, because each link passing separately is exactly the condition under which an
// integration silently does nothing: the file parses, the trust checks pass, the readings revive, the
// map merges — and no resolver ever asks for the signal, so the import changes no number and nobody
// notices.
//
// So this runs a real resolver over a real envelope and asserts on the finding: that it reached an
// outcome, that the outcome is the one the setting implies, and that `classOf` says the finding rests
// on an import rather than on a measurement this app made. That last assertion is the one that keeps
// the score honest. A 78% that is really somebody's uploaded file must not present as a 78% this app
// measured, and this is the test that fails if it ever does.

import { describe, expect, it } from 'vitest';
import { merged, readingsFrom } from './signals.js';
import { envelope, probe } from './envelope-fixture.js';
import { envelopeFrom } from './envelope.js';
import type { ImportedEvidence } from './store.js';
import { REQUESTED_KEYS } from '../collect/rest/settings-keys.js';
import { buildRegistry } from '../resolve/resolvers/index.js';
import { resolveControl, type ControlSpec } from '../resolve/resolver.js';
import { classOf, composition } from '../resolve/evidence-class.js';
import type { SignalId, SignalResult } from '../collect/signal.js';
import { observed, unmeasurable } from '../collect/signal.js';

const SETTINGS: SignalId = 'rest:workspace:preview.workspace-conf';

/** The one requirement `enableIpAccessLists` answers, as the catalogue declares it. */
const SPEC: ControlSpec = {
  id: 'SCP-03-10',
  pillarId: 'security-compliance-and-privacy',
  principleId: 'SCP-03',
  title: 'IP access lists are enforced',
  severity: 'high',
  collector: SETTINGS,
};

const REGISTRY = buildRegistry();

function file(values: Record<string, unknown>): ImportedEvidence {
  const raw = envelope({
    probes: [
      probe({
        signals: [SETTINGS],
        label: 'workspace-conf',
        // Every key the script asks for, so a key missing from `values` revives as unanswered rather
        // than as a key nobody asked about — which is the distinction the resolver acts on.
        fields: REQUESTED_KEYS,
        value: values,
      }),
    ],
  });

  return {
    digest: 'a'.repeat(64),
    generatedAt: new Date('2026-08-01T09:00:00Z'),
    importedAt: new Date('2026-08-02T09:00:00Z'),
    importedBy: 'assessor@example.com',
    envelope: envelopeFrom(raw),
    cautions: [],
  };
}

function resolve(values: Record<string, unknown>, collected: ReadonlyMap<SignalId, SignalResult> = new Map()) {
  const readings = readingsFrom(file(values));
  const signals = merged(collected, readings.signals);
  return resolveControl(SPEC, signals, REGISTRY.get(SPEC.id));
}

describe('a requirement decided by an imported reading', () => {
  it('passes when the administrator’s file shows the setting enforced', () => {
    const finding = resolve({ enableIpAccessLists: 'true' });

    expect(finding.outcome).toBe('pass');
  });

  it('fails when the file shows it off', () => {
    const finding = resolve({ enableIpAccessLists: 'false' });

    expect(finding.outcome).toBe('fail');
  });

  it('fails when the file shows it was never set, because unset is not enforcing', () => {
    // The distinction the projection was rewritten to preserve, arriving at the resolver intact.
    const finding = resolve({ enableIpAccessLists: null });

    expect(finding.outcome).toBe('fail');
    expect(finding.outcomeReason).toContain('never');
  });

  it('rests on admin-collected evidence, not on a measurement this app made', () => {
    const finding = resolve({ enableIpAccessLists: 'true' });

    expect(classOf(finding)).toBe('admin-collected');
    expect(composition([finding])).toEqual({ observed: 0, 'admin-collected': 1, attested: 0 });
  });

  it('names the administrator and their host on the evidence, so the reading can be repeated', () => {
    const finding = resolve({ enableIpAccessLists: 'true' });

    expect(finding.evidence[0]?.provenance?.actor).toBe('admin@example.com');
    expect(finding.evidence[0]?.provenance?.from).toContain('cloud.databricks.com');
  });

  it('is dated when the administrator collected it, which is what makes a stale import visible', () => {
    const finding = resolve({ enableIpAccessLists: 'true' });

    expect(finding.evidence[0]?.collectedAt).toEqual(new Date('2026-08-03T10:41:52Z'));
  });

  it('replaces the refusal this app would otherwise have reported', () => {
    // Without an import this requirement is unmeasurable: no app can hold the settings scope. That is
    // the gap the whole feature exists to close, and this is it closing.
    const refused = new Map([[SETTINGS, unmeasurable(SETTINGS, 'This app cannot be granted the settings scope.')]]);
    const finding = resolve({ enableIpAccessLists: 'true' }, refused);

    expect(finding.outcome).toBe('pass');
  });

  it('does not overrule a reading this app somehow made itself', () => {
    const own = new Map([
      [SETTINGS, observed(SETTINGS, { values: new Map([['enableIpAccessLists', 'false']]), unanswered: [] }, 5)],
    ]);
    const finding = resolve({ enableIpAccessLists: 'true' }, own);

    expect(finding.outcome).toBe('fail');
    expect(classOf(finding)).toBe('observed');
  });
});

// =============================================================================
// Admin-evidence bridge, registry path.
//
// The test above proves the workspace-settings chain. This proves the same chain
// for the newly registered admin-imported controls: that `REGISTRY.get(id)` now
// returns a resolver for a representative admin signal (SCP-04-02, log delivery),
// and that when an envelope carrying log delivery data is revived and merged, the
// registry resolver produces an admin-collected finding rather than unmeasurable.
//
// This is the test that fails if the resolvers are removed from the registry again.
// =============================================================================

const LOG_DELIVERY: SignalId = 'rest:account:accounts.log-delivery';

function logDeliveryImport(configs: unknown[]): ImportedEvidence {
  const raw = envelope({
    probes: [
      probe({
        signals: [LOG_DELIVERY],
        tier: 'account',
        label: 'account-log-delivery',
        fields: [
          'log_delivery_configurations[].config_id',
          'log_delivery_configurations[].log_type',
          'log_delivery_configurations[].status',
        ],
        value: { log_delivery_configurations: configs },
      }),
    ],
  });
  return {
    digest: 'b'.repeat(64),
    generatedAt: new Date('2026-08-01T09:00:00Z'),
    importedAt: new Date('2026-08-02T09:00:00Z'),
    importedBy: 'assessor@example.com',
    envelope: envelopeFrom(raw),
    cautions: [],
  };
}

describe('an admin-imported control reaching the registry (SCP-04-02, log delivery)', () => {
  it('registry has a resolver for SCP-04-02 now that admin resolvers are registered', () => {
    expect(REGISTRY.get('SCP-04-02')).toBeDefined();
  });

  it('passes via registry when an enabled audit log config is imported', () => {
    const imported = logDeliveryImport([{ config_id: 'c1', log_type: 'AUDIT_LOGS', status: 'ENABLED' }]);
    const readings = readingsFrom(imported);
    const signals = merged(new Map(), readings.signals);
    const spec = { id: 'SCP-04-02', pillarId: 'security-compliance-and-privacy', principleId: 'SCP-04', title: 'Audit log delivery configured', severity: 'high' as const, collector: LOG_DELIVERY };

    const finding = resolveControl(spec, signals, REGISTRY.get('SCP-04-02'));

    expect(finding.outcome).toBe('pass');
    expect(classOf(finding)).toBe('admin-collected');
  });

  it('fails via registry when no log delivery configurations exist', () => {
    const imported = logDeliveryImport([]);
    const readings = readingsFrom(imported);
    const signals = merged(new Map(), readings.signals);
    const spec = { id: 'SCP-04-02', pillarId: 'security-compliance-and-privacy', principleId: 'SCP-04', title: 'Audit log delivery configured', severity: 'high' as const, collector: LOG_DELIVERY };

    const finding = resolveControl(spec, signals, REGISTRY.get('SCP-04-02'));

    expect(finding.outcome).toBe('fail');
    expect(classOf(finding)).toBe('admin-collected');
  });

  it('is unmeasurable before an import, because no live scope can read this signal', () => {
    // Without an import, SCP-04-02 has no signal → unmeasurable. This is the gap the
    // import closes. The resolver is registered, so it handles the empty-signals case.
    const spec = { id: 'SCP-04-02', pillarId: 'security-compliance-and-privacy', principleId: 'SCP-04', title: 'Audit log delivery configured', severity: 'high' as const, collector: LOG_DELIVERY };

    const finding = resolveControl(spec, new Map(), REGISTRY.get('SCP-04-02'));

    expect(finding.outcome).toBe('unmeasurable');
  });
});
