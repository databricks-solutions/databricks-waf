// Which imported readings a scan may use, through the runner that chooses them.
//
// `imported.test.ts` hands `runScan` a map of readings and proves what a resolver does with one. What
// it cannot see is which readings the runner offered in the first place, and that is where an account
// install goes wrong: files from several workspaces are held side by side, and a scan about one of
// them must not be decided by another's settings. Every case here holds two workspaces' files at once,
// makes the wrong one the newer, and asks which one a finding rests on.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../catalogue/catalogue.js';
import { accountScope, selectedScope, workspaceScope, type EstateScope } from '../collect/estate-scope.js';
import type { CredentialProvider } from '../collect/credentials.js';
import { unmeasurable, type Collector, type SignalId, type SignalResult } from '../collect/signal.js';
import { REQUESTED_KEYS } from '../collect/rest/settings-keys.js';
import { envelopeFrom } from '../import/envelope.js';
import { envelope, identity, probe } from '../import/envelope-fixture.js';
import { InMemoryEvidenceImportStore, type ImportedEvidence } from '../import/store.js';
import { confidenceOf } from '../resolve/confidence.js';
import { buildRegistry } from '../resolve/resolvers/index.js';
import { ScanRunner } from './runner.js';
import { InMemoryScanStore } from './store.js';
import type { Scan } from './scan.js';

const SETTINGS: SignalId = 'rest:workspace:preview.workspace-conf';
const LOG_DELIVERY: SignalId = 'rest:account:accounts.log-delivery';
const WORKSPACE_A = '7000000000000001';
const WORKSPACE_B = '7000000000000002';
const WORKSPACE_C = '7000000000000003';
const WORKSPACE_D = '7000000000000004';
const ACCOUNT_X = '00000000-1111-2222-3333-444444444444';
const ACCOUNT_Y = '99999999-1111-2222-3333-444444444444';
const catalogue = loadCatalogue();
const registry = buildRegistry();

const asUser: CredentialProvider = {
  mode: 'on-behalf-of-user',
  databricks: () =>
    Promise.resolve({
      mode: 'on-behalf-of-user',
      actor: 'assessor@example.com',
      host: 'https://example.cloud.databricks.com',
      token: () => Promise.resolve('t'),
    }),
  cloud: () => Promise.resolve(null),
};

/** Refuses both signals the files answer, which is what every real collector does with them. */
const refused: Collector = {
  surface: 'rest',
  name: 'admin-only',
  signals: [SETTINGS, LOG_DELIVERY],
  collect: (): Promise<SignalResult[]> =>
    Promise.resolve([
      unmeasurable(SETTINGS, 'This app cannot be granted the settings scope.'),
      unmeasurable(LOG_DELIVERY, 'The account plane is not reachable with a workspace token.'),
    ]),
};

function held(
  digest: string,
  collected: string,
  workspaceId: string,
  ipAccessLists: 'true' | 'false',
  withAccount = false,
  accountId = ACCOUNT_X,
  auditLogs: 'ENABLED' | 'DISABLED' = 'ENABLED'
): ImportedEvidence {
  const probes = [
    probe({ signals: [SETTINGS], label: 'workspace-conf', fields: REQUESTED_KEYS, value: { enableIpAccessLists: ipAccessLists } }),
    ...(withAccount
      ? [
          probe({
            signals: [LOG_DELIVERY],
            tier: 'account',
            label: 'account-log-delivery',
            fields: ['log_delivery_configurations[].log_type'],
            value: { log_delivery_configurations: [{ config_id: 'c1', log_type: 'AUDIT_LOGS', status: auditLogs }] },
          }),
        ]
      : []),
  ];
  const accountIdentity = identity({
    workspace_id: null,
    account_id: accountId,
    host: 'https://accounts.cloud.databricks.com',
  });
  const raw = envelope({
    generated_at: collected,
    tiers: {
      workspace: { ran: true, identity: identity({ workspace_id: workspaceId, account_id: accountId }) },
      account: withAccount ? { ran: true, identity: accountIdentity } : { ran: false, reason: 'Not run.' },
    },
    probes,
  });
  return {
    digest,
    generatedAt: new Date(collected),
    importedAt: new Date(collected),
    importedBy: 'assessor@example.com',
    envelope: envelopeFrom({ ...raw, digest: `sha256:${digest.repeat(64).slice(0, 64)}` }),
    cautions: [],
  };
}

/**
 * Workspace A's file says the setting is on and carries the account half; B's says it is off and is
 * the newer, so a runner that took the newest reading of the signal would answer for A with B's.
 */
async function imports(): Promise<InMemoryEvidenceImportStore> {
  const store = new InMemoryEvidenceImportStore();
  await store.record(held('a', '2026-08-01T09:00:00Z', WORKSPACE_A, 'true', true));
  await store.record(held('b', '2026-08-03T09:00:00Z', WORKSPACE_B, 'false'));
  return store;
}

async function scanned(scope: EstateScope, store?: InMemoryEvidenceImportStore): Promise<Scan> {
  const runner = new ScanRunner({
    catalogue,
    registry,
    store: new InMemoryScanStore(),
    measuredPillars: ['security-compliance-and-privacy'],
    imports: store ?? (await imports()),
  });
  return runner.start({ credentials: asUser, scope, collectors: [refused] });
}

function finding(scan: Scan, controlId: string) {
  const found = scan.findings.find((one) => one.controlId === controlId);
  if (found == null) throw new Error(`No finding for ${controlId}`);
  return found;
}

/** Whether the finding names the workspace, in whichever of its limitations does. */
function names(scan: Scan, controlId: string, workspaceId: string): boolean {
  return confidenceOf(finding(scan, controlId)).limitations.some((one) => one.says.includes(workspaceId));
}

describe('which workspace an imported setting may decide for', () => {
  it('decides a scan of workspace A from A\u2019s file, though B\u2019s is newer', async () => {
    const scan = await scanned(workspaceScope(WORKSPACE_A));

    expect(finding(scan, 'SCP-03-10').outcome).toBe('pass');
    expect(names(scan, 'SCP-03-10', WORKSPACE_A)).toBe(true);
    expect(names(scan, 'SCP-03-10', WORKSPACE_B)).toBe(false);
  });

  it('decides a scan narrowed to workspace B from B\u2019s file', async () => {
    const scan = await scanned(workspaceScope(WORKSPACE_B));

    expect(finding(scan, 'SCP-03-10').outcome).not.toBe('pass');
    expect(finding(scan, 'SCP-03-10').outcome).not.toBe('unmeasurable');
    expect(names(scan, 'SCP-03-10', WORKSPACE_B)).toBe(true);
  });

  it('decides an account scan from the file of the workspace this app is installed in', async () => {
    const atA = await scanned(accountScope(WORKSPACE_A));
    const atB = await scanned(accountScope(WORKSPACE_B));

    expect(finding(atA, 'SCP-03-10').outcome).toBe('pass');
    expect(names(atA, 'SCP-03-10', WORKSPACE_A)).toBe(true);
    expect(finding(atB, 'SCP-03-10').outcome).not.toBe('pass');
    expect(names(atB, 'SCP-03-10', WORKSPACE_B)).toBe(true);
  });

  it('leaves a scan of a workspace nobody imported for unmeasured, rather than borrowing another\u2019s', async () => {
    const scan = await scanned(workspaceScope(WORKSPACE_C));

    expect(finding(scan, 'SCP-03-10').outcome).toBe('unmeasurable');
  });

  it('does not guess a workspace when the scan does not know which one it is installed in', async () => {
    const scan = await scanned(accountScope());

    expect(finding(scan, 'SCP-03-10').outcome).toBe('unmeasurable');
  });

  it('does not decide a selection of workspaces that leaves out the file\u2019s workspace', async () => {
    const scope = selectedScope(accountScope(WORKSPACE_A), [WORKSPACE_B, WORKSPACE_C]);
    const scan = await scanned(scope);

    expect(finding(scan, 'SCP-03-10').outcome).toBe('unmeasurable');
  });

  it('uses the newest file for the workspace when one workspace has been imported twice', async () => {
    const store = await imports();
    await store.record(held('c', '2026-08-05T09:00:00Z', WORKSPACE_A, 'false'));
    const scan = await scanned(workspaceScope(WORKSPACE_A), store);

    expect(finding(scan, 'SCP-03-10').outcome).not.toBe('pass');
  });
});

describe('which account-level readings a scan may use', () => {
  it('applies them to a scan of any workspace, because they describe the account', async () => {
    const scan = await scanned(workspaceScope(WORKSPACE_C));

    expect(finding(scan, 'SCP-04-02').outcome).toBe('pass');
  });

  it('applies them to an account scan without attributing them to a workspace', async () => {
    const scan = await scanned(accountScope(WORKSPACE_B));

    expect(finding(scan, 'SCP-04-02').outcome).toBe('pass');
    expect(names(scan, 'SCP-04-02', WORKSPACE_A)).toBe(false);
    expect(names(scan, 'SCP-04-02', WORKSPACE_B)).toBe(false);
  });
});

describe('which account an account-level reading may come from', () => {
  /** Account X's file says audit logs are delivered; the newer file from account Y says they are not. */
  async function twoAccounts(): Promise<InMemoryEvidenceImportStore> {
    const store = await imports();
    await store.record(held('d', '2026-08-04T09:00:00Z', WORKSPACE_D, 'true', true, ACCOUNT_Y, 'DISABLED'));
    return store;
  }

  it('takes the account half from files of the account the workspace\u2019s own file names', async () => {
    const scan = await scanned(workspaceScope(WORKSPACE_A), await twoAccounts());

    // A is in account X, so Y\u2019s newer account half is not offered and X\u2019s stands.
    expect(finding(scan, 'SCP-04-02').outcome).toBe('pass');
  });

  it('takes it from the other account when that is the account the scanned workspace is in', async () => {
    const scan = await scanned(workspaceScope(WORKSPACE_D), await twoAccounts());

    expect(finding(scan, 'SCP-04-02').outcome).not.toBe('pass');
    expect(finding(scan, 'SCP-04-02').outcome).not.toBe('unmeasurable');
  });

  it('follows the newest import when nothing was imported for the scanned workspace', async () => {
    const scan = await scanned(workspaceScope(WORKSPACE_C), await twoAccounts());

    // The newest file names account Y, so X\u2019s enabled configuration is not offered.
    expect(finding(scan, 'SCP-04-02').outcome).not.toBe('pass');
    expect(finding(scan, 'SCP-04-02').outcome).not.toBe('unmeasurable');
  });

  /** A file whose account half says audit logs are delivered, from a script that read no account id. */
  function unnamed(digest: string, collected: string, workspaceId: string): ImportedEvidence {
    return {
      ...held(digest, collected, workspaceId, 'true', true),
      envelope: envelopeFrom({
        ...envelope({
          generated_at: collected,
          tiers: {
            workspace: { ran: true, identity: identity({ workspace_id: workspaceId, account_id: null }) },
            account: {
              ran: true,
              identity: identity({ workspace_id: null, account_id: null, host: 'https://accounts.cloud.databricks.com' }),
            },
          },
          probes: [
            probe({
              signals: [LOG_DELIVERY],
              tier: 'account',
              label: 'account-log-delivery',
              fields: ['log_delivery_configurations[].log_type'],
              value: { log_delivery_configurations: [{ config_id: 'c1', log_type: 'AUDIT_LOGS', status: 'ENABLED' }] },
            }),
          ],
        }),
        digest: `sha256:${digest.repeat(64).slice(0, 64)}`,
      }),
    };
  }

  it('offers every file\u2019s account half when no file names an account', async () => {
    const store = new InMemoryEvidenceImportStore();
    await store.record(unnamed('e', '2026-08-01T09:00:00Z', WORKSPACE_A));

    expect(finding(await scanned(workspaceScope(WORKSPACE_C), store), 'SCP-04-02').outcome).toBe('pass');
  });

  it('keeps a file\u2019s account half that names no account when a later file names one', async () => {
    const store = new InMemoryEvidenceImportStore();
    await store.record(unnamed('e', '2026-08-01T09:00:00Z', WORKSPACE_C));
    // Newer, names account X, and carries no account half of its own.
    await store.record(held('a', '2026-08-02T09:00:00Z', WORKSPACE_A, 'true'));

    expect(finding(await scanned(workspaceScope(WORKSPACE_A), store), 'SCP-04-02').outcome).toBe('pass');
  });

  it('still leaves out the account half of a file that names a different account than the one chosen', async () => {
    const store = new InMemoryEvidenceImportStore();
    await store.record(unnamed('e', '2026-08-01T09:00:00Z', WORKSPACE_C));
    await store.record(held('d', '2026-08-02T09:00:00Z', WORKSPACE_D, 'true', true, ACCOUNT_Y, 'DISABLED'));
    // Account X is chosen by the workspace's own file, and Y's newer account half is not offered.
    await store.record(held('a', '2026-08-03T09:00:00Z', WORKSPACE_A, 'true'));

    const scan = await scanned(workspaceScope(WORKSPACE_A), store);

    expect(finding(scan, 'SCP-04-02').outcome).toBe('pass');
  });
});
