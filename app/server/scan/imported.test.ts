// A whole scan with an imported reading in it.
//
// `import/resolved.test.ts` proves one resolver reads one imported signal. This proves the same thing
// through `runScan`, which is where the wiring can be wrong in a way no unit test sees: the merge
// happening before collection instead of after, the readings never reaching the resolve step, the
// score counting them as observed. The assertion that matters is the composition — a scan whose
// security findings came out of an uploaded file must report them as such, in the number the UI reads.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../catalogue/catalogue.js';
import { buildRegistry } from '../resolve/resolvers/index.js';
import { workspaceScope } from '../collect/estate-scope.js';
import type { Collector, SignalId, SignalResult } from '../collect/signal.js';
import { unmeasurable } from '../collect/signal.js';
import type { CredentialProvider } from '../collect/credentials.js';
import { runScan } from './scan.js';
import { readingsFrom } from '../import/signals.js';
import { envelope, probe } from '../import/envelope-fixture.js';
import { envelopeFrom } from '../import/envelope.js';
import { REQUESTED_KEYS } from '../collect/rest/settings-keys.js';
import { classOf, describeComposition } from '../resolve/evidence-class.js';

const SETTINGS: SignalId = 'rest:workspace:preview.workspace-conf';
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

/** A collector that reaches the settings endpoint and is refused, which is what every real one does. */
const refused: Collector = {
  surface: 'rest',
  name: 'settings',
  signals: [SETTINGS],
  collect: (): Promise<SignalResult[]> =>
    Promise.resolve([unmeasurable(SETTINGS, 'This app cannot be granted the settings scope.')]),
};

function readings(values: Record<string, unknown>): ReadonlyMap<SignalId, SignalResult> {
  const raw = envelope({
    probes: [probe({ signals: [SETTINGS], label: 'workspace-conf', fields: REQUESTED_KEYS, value: values })],
  });

  return readingsFrom({
    digest: 'a'.repeat(64),
    generatedAt: new Date('2026-08-01T09:00:00Z'),
    importedAt: new Date('2026-08-02T09:00:00Z'),
    importedBy: 'assessor@example.com',
    envelope: envelopeFrom(raw),
    cautions: [],
  }).signals;
}

async function scan(values: Record<string, unknown> | undefined) {
  return runScan({
    catalogue,
    registry,
    collectors: [refused],
    credentials: asUser,
    scope: workspaceScope('123'),
    lookbackDays: 30,
    pillars: ['security-compliance-and-privacy'],
    ...(values != null ? { imported: readings(values) } : {}),
  });
}

function finding(scanned: Awaited<ReturnType<typeof scan>>, controlId: string) {
  const found = scanned.findings.find((one) => one.controlId === controlId);
  if (found == null) throw new Error(`No finding for ${controlId}`);
  return found;
}

describe('a scan with imported readings', () => {
  it('reports the requirement as unmeasured when nothing was imported', () => {
    // The baseline the import exists to improve on, asserted so the test below is a comparison rather
    // than an assertion about a number that was always going to be there.
    return scan(undefined).then((scanned) => {
      expect(finding(scanned, 'SCP-03-10').outcome).toBe('unmeasurable');
    });
  });

  it('decides the requirement from the imported file', async () => {
    const scanned = await scan({ enableIpAccessLists: 'true' });

    expect(finding(scanned, 'SCP-03-10').outcome).toBe('pass');
  });

  it('classes the finding as admin-collected, so the score does not claim to have measured it', async () => {
    const scanned = await scan({ enableIpAccessLists: 'true' });

    expect(classOf(finding(scanned, 'SCP-03-10'))).toBe('admin-collected');
    expect(scanned.score.composition['admin-collected']).toBeGreaterThan(0);
  });

  it('says so in a sentence even when the whole score came from the file', async () => {
    // The case with no mixture is the one that most needs saying. A score composed entirely of
    // imported readings, printed with no caveat, is indistinguishable from one this app measured.
    const scanned = await scan({ enableIpAccessLists: 'true' });
    const sentence = describeComposition(scanned.score.composition, scanned.score.scoredControls);

    expect(sentence).toContain('an administrator ran and imported');
  });
});
