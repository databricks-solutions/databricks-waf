// What happens to a run after it is measured.
//
// The lock and the merge are exercised through the routes. What is held here is the hook the validation
// pass hangs off, because its three properties are all of the "wrong order" kind that a unit test of
// either side cannot see: the run is on the record before the hook sees it, the hook has finished before
// `start` resolves, and a hook that fails does not cost the caller a scan that in fact succeeded.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../catalogue/catalogue.js';
import { workspaceScope } from '../collect/estate-scope.js';
import type { CredentialProvider } from '../collect/credentials.js';
import type { Collector, SignalId, SignalResult } from '../collect/signal.js';
import { unmeasurable } from '../collect/signal.js';
import { buildRegistry } from '../resolve/resolvers/index.js';
import { ScanInProgressError, ScanRunner } from './runner.js';
import type { Scan } from './scan.js';
import { InMemoryScanStore } from './store.js';
import { registerAttestation } from '../attest/register.js';
import { InMemoryAttestationStore } from '../attest/store.js';

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

/** A collector that reaches one endpoint and is refused, which is enough to produce a run. */
const refused: Collector = {
  surface: 'rest',
  name: 'settings',
  signals: [SETTINGS],
  collect: (): Promise<SignalResult[]> =>
    Promise.resolve([unmeasurable(SETTINGS, 'This app cannot be granted the settings scope.')]),
};

async function run(
  onFinished?: (scan: Scan) => Promise<void>,
  store: InMemoryScanStore = new InMemoryScanStore()
): Promise<{ scan: Scan; store: InMemoryScanStore }> {
  const runner = new ScanRunner({
    catalogue,
    registry,
    store,
    measuredPillars: ['security-compliance-and-privacy'],
    ...(onFinished != null ? { onFinished } : {}),
  });

  const scan = await runner.start({
    credentials: asUser,
    scope: workspaceScope('123'),
    collectors: [refused],
  });
  return { scan, store };
}

describe('what runs after a scan', () => {
  it('sees the finished run, already saved', async () => {
    // Already saved rather than about to be: the hook answers validations by reading this run, and a
    // hook that ran first could verify work against a scan nobody can find afterwards.
    const store = new InMemoryScanStore();
    let seen: string | undefined;
    let stored: string | undefined;
    await run(async (scan) => {
      seen = scan.id;
      stored = (await store.latest())?.id;
    }, store);

    expect(seen).toBeDefined();
    expect(stored).toBe(seen);
  });

  it('has finished before the caller is given the scan', async () => {
    // So a caller that awaits a scan knows the claims waiting on it were settled. Without it, a route
    // would answer with a run whose validations resolve some time afterwards, and a page that reloads
    // on the answer would show the old state of the board.
    let done = false;
    await run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      done = true;
    });

    expect(done).toBe(true);
  });

  it('cannot fail the scan', async () => {
    // The findings are real and worth keeping whatever happened afterwards. Rejecting here would tell
    // the caller their scan failed and leave them able to find it in the history.
    const { scan, store } = await run(() => Promise.reject(new Error('the validations could not be read')));

    expect(scan.state).toBe('complete');
    expect((await store.latest())?.id).toBe(scan.id);
  });

  it('is not required, so a build with no validations still scans', async () => {
    const { scan } = await run();

    expect(scan.findings.length).toBeGreaterThan(0);
  });
});

describe('a scan of one assessment', () => {
  it('does not take another assessment\'s answers into its score', async () => {
    const attestations = new InMemoryAttestationStore();
    await registerAttestation({
      store: attestations,
      draft: {
        controlId: 'OE-01-01',
        answer: 'met',
        statement: 'Reviewed quarterly by the platform team, minutes in the runbook.',
        owner: 'platform-team@example.com',
      },
      actor: 'admin@example.com',
      severity: 'medium',
      definitionId: 'def-a',
    });

    const store = new InMemoryScanStore();
    const runner = new ScanRunner({
      catalogue,
      registry,
      store,
      attestations,
      measuredPillars: ['operational-excellence'],
    });

    const scan = await runner.start({
      credentials: asUser,
      scope: workspaceScope('123'),
      collectors: [refused],
      definition: { id: 'def-b', version: 1, fingerprint: 'f' },
    });

    expect(scan.findings.some((finding) => finding.controlId === 'OE-01-01' && finding.attested != null)).toBe(
      false
    );
    expect(scan.score.composition.attested).toBe(0);
  });
});

// What a reader who did not press the button can be told while it happens.
//
// The defect this answers was observed against the deployed app: a run was started and nothing in
// the app said so, because the only thing that knew was the state of the click. Everything the app
// can honestly say about a run in flight has to come from here. See ADR 0055.
describe('a run in flight', () => {
  /** Holds the run open so it can be asked about itself, and lets the test end it. */
  function stalling(): { collector: Collector; reached: Promise<void>; finish: () => void } {
    let arrived: () => void;
    let release: () => void;
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));

    return {
      collector: {
        surface: 'rest',
        name: 'settings',
        signals: [SETTINGS],
        collect: async (): Promise<SignalResult[]> => {
          arrived();
          await held;
          return [unmeasurable(SETTINGS, 'This app cannot be granted the settings scope.')];
        },
      },
      reached,
      finish: () => release(),
    };
  }

  async function watching(trigger?: 'interactive' | 'scheduled') {
    const held = stalling();
    const runner = new ScanRunner({
      catalogue,
      registry,
      store: new InMemoryScanStore(),
      measuredPillars: ['security-compliance-and-privacy'],
    });

    const scan = runner.start({
      credentials: asUser,
      scope: workspaceScope('123'),
      collectors: [held.collector],
      ...(trigger != null ? { trigger } : {}),
    });
    await held.reached;
    return { runner, done: async () => (held.finish(), await scan) };
  }

  it('says who started it and when, so a reader can tell whose run this is', async () => {
    const { runner, done } = await watching();

    const running = runner.running();
    expect(running?.actor).toBe('assessor@example.com');
    expect(running?.startedAt).toBeInstanceOf(Date);
    expect(running?.scope.narrowedTo).toBe('123');

    await done();
  });

  it('says what started it, so the nightly run is not mistaken for a colleague', async () => {
    const { runner, done } = await watching('scheduled');

    expect(runner.running()?.trigger).toBe('scheduled');

    await done();
  });

  it('counts the calls that have reached a surface, so the count rises while the run goes', async () => {
    const { runner, done } = await watching();

    // Zero at the point the first collector is still in its first call, and a number afterwards.
    // A count that only moved when the run ended would be a spinner with extra steps.
    expect(runner.running()?.callsMade).toBe(0);
    await done();

    const before = new ScanRunner({ catalogue, registry, store: new InMemoryScanStore() });
    expect(before.running()).toBeUndefined();
  });

  it('counts the calls of the run that is happening, not of the one that finished', async () => {
    const runner = new ScanRunner({
      catalogue,
      registry,
      store: new InMemoryScanStore(),
      measuredPillars: ['security-compliance-and-privacy'],
    });

    await runner.start({ credentials: asUser, scope: workspaceScope('123'), collectors: [refused] });

    // Nothing is in flight, so there is nothing to report. A stale count left behind by the last run
    // would show the app as busy for as long as nobody restarted it.
    expect(runner.running()).toBeUndefined();
  });

  it('refuses a second scan asked for in the same tick as the first', async () => {
    const runner = new ScanRunner({
      catalogue,
      registry,
      store: new InMemoryScanStore(),
      measuredPillars: ['security-compliance-and-privacy'],
    });
    const request = { credentials: asUser, scope: workspaceScope('123'), collectors: [refused] };

    // Neither is awaited before the other is called, which is what two admins pressing scan actually
    // looks like: both requests are in the event loop before either has resolved its credentials. An
    // earlier version took the claim after that await, so both callers passed the check and the estate
    // was read twice — the exact thing this lock exists to prevent, allowed by the lock itself.
    const [first, second] = await Promise.allSettled([runner.start(request), runner.start(request)]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    if (second.status === 'rejected') expect(second.reason).toBeInstanceOf(ScanInProgressError);
  });
});
