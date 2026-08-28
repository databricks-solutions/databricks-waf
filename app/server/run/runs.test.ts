// The five things a durable run is supposed to survive, exercised end to end against a real
// `ScanRunner` and the fake database. They are A4's acceptance gate, and they are one describe each:
// process-kill, a duplicate trigger, a run cut short without anybody asking, a retry of one that
// broke, and a cancel — including the cancel of a run no process is working on, which is the case the
// record alone does not settle.
//
// Against a real runner rather than a stub of one, because every property here is about the ordering
// between the record and the collection — a checkpoint written before the next unit, a cancel read at
// a unit boundary, a lease released after the outcome is stored — and a stubbed runner is precisely
// the thing that cannot demonstrate ordering it does not have.
//
// The kill is modelled as abandonment rather than by killing a process: the attempt stops renewing and
// a second trigger arrives after its lease has lapsed, which is exactly what a killed process leaves
// behind. What a real kill adds beyond that is covered by the live test and by the acceptance run.

import { describe, expect, it } from 'vitest';

import { loadCatalogue } from '../catalogue/catalogue.js';
import { accountScope } from '../collect/estate-scope.js';
import type { CredentialProvider } from '../collect/credentials.js';
import type { Collector, SignalId, SignalResult } from '../collect/signal.js';
import { unmeasurable } from '../collect/signal.js';
import { buildRegistry } from '../resolve/resolvers/index.js';
import { ScanRunner } from '../scan/runner.js';
import { AdvisoryRunner } from '../advise/runner.js';
import { InMemoryAdvisoryStore } from '../advise/store.js';
import { InMemoryScanStore } from '../scan/store.js';
import { FakePostgres } from '../store/postgres-fake.js';
import { LEASE_SECONDS } from './run.js';
import { PostgresRunStore } from './run-store.js';
import { RunNotJoinable, Runs, requestOf } from './runs.js';

const SETTINGS: SignalId = 'rest:workspace:preview.workspace-conf';
const TOKENS: SignalId = 'rest:workspace:token.list';
const catalogue = loadCatalogue();
const registry = buildRegistry();

const asUser: CredentialProvider = {
  mode: 'on-behalf-of-user',
  databricks: () =>
    Promise.resolve({
      mode: 'on-behalf-of-user',
      actor: 'ada@example.com',
      host: 'https://example.cloud.databricks.com',
      token: () => Promise.resolve('t'),
    }),
  cloud: () => Promise.resolve(null),
};

/** A collector that is refused, which is enough to settle a signal and finish a unit. */
function refusing(name: string, signal: SignalId, watch?: () => void): Collector {
  return {
    surface: 'rest',
    name,
    signals: [signal],
    collect: (): Promise<SignalResult[]> => {
      watch?.();
      return Promise.resolve([unmeasurable(signal, `The ${name} collector is refused here.`)]);
    },
  };
}

/** A collector that waits to be let go, so a test can act while a run is mid-flight. */
function stalling(name: string, signal: SignalId) {
  let release = (): void => undefined;
  let arrived = (): void => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (arrived = resolve));
  return {
    reached,
    release,
    collector: {
      surface: 'rest',
      name,
      signals: [signal],
      collect: async (): Promise<SignalResult[]> => {
        arrived();
        await held;
        return [unmeasurable(signal, 'held')];
      },
    } satisfies Collector,
  };
}

/**
 * A collector of two signals that reports the first and then waits, as the SQL collector does.
 *
 * The shape that makes resumption one signal wide instead of one collector wide: it reports each
 * reading as it settles, and skips a signal an earlier attempt already read. Both halves, because
 * reporting alone makes progress durable and then re-reads all of it.
 */
function progressive(name: string, first: SignalId, second: SignalId, watch: (signal: SignalId) => void) {
  let release = (): void => undefined;
  let arrived = (): void => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (arrived = resolve));
  return {
    reached,
    release,
    collector: {
      surface: 'rest',
      name,
      signals: [first, second],
      collect: async (ids, context): Promise<SignalResult[]> => {
        const results: SignalResult[] = [];
        for (const id of ids) {
          if (context.collected.has(id)) continue;
          watch(id);
          const result = unmeasurable(id, `The ${name} collector is refused here.`);
          results.push(result);
          await context.settled?.(result);
          if (id === first) {
            arrived();
            await held;
          }
        }
        return results;
      },
    } satisfies Collector,
  };
}

/** A database two processes can share, so that "another process" is not a figure of speech here. */
function database(): FakePostgres {
  return new FakePostgres({
    keys: { run_checkpoints: ['run_id', 'signal_id'] },
    unique: { runs: ['idempotency_key'] },
  });
}

/**
 * One process: its own runner, its own in-process lock, its own holder identity.
 *
 * `db` is a parameter because the resume cases need two of these. Modelling a restart with one runner
 * would leave the killed attempt's in-process lock held, and the resumed trigger would be refused by
 * the wrong mechanism — which is the bug this arrangement caught.
 */
function harness(options: { readonly now?: () => Date; readonly holder?: string; readonly db?: FakePostgres } = {}) {
  const db = options.db ?? database();
  const store = new PostgresRunStore(db);
  const scans = new InMemoryScanStore();
  const runner = new ScanRunner({ catalogue, registry, store: scans });
  const advisories = new InMemoryAdvisoryStore();
  const advisor = new AdvisoryRunner({ store: advisories });
  const runs = new Runs({
    store,
    runner,
    advisor,
    // A beat far longer than any test, so nothing here depends on a timer firing. Renewal is tested
    // directly in run-store.test.ts, where it can be asserted rather than waited for.
    heartbeatMs: 60_000,
    ...(options.now != null ? { now: options.now } : {}),
    ...(options.holder != null ? { holder: options.holder } : {}),
  });
  return { runs, store, scans, runner, advisor, advisories, db };
}

function request(collectors: readonly Collector[]) {
  return { credentials: asUser, scope: accountScope(), collectors };
}

describe('triggering a run', () => {
  it('records the run before collecting, so a restart has something to find', async () => {
    const { runs, store } = harness();
    const { run, scan } = await runs.trigger(request([refusing('settings', SETTINGS)]), {
      actor: 'ada@example.com',
      idempotencyKey: 'nightly-2026-01-01',
    });

    // Asserted before the scan is awaited: the point is that the record exists while the run is in
    // flight, not that one appears afterwards.
    const held = await store.get(run.id);
    expect(held?.state).toBe('running');
    expect(held?.lease?.holder).toBeDefined();

    await scan;
  });

  it('names the scan it produced and lets the run go', async () => {
    const { runs, store } = harness();
    const { run, scan } = await runs.trigger(request([refusing('settings', SETTINGS)]), { actor: 'ada@example.com' });
    const finished = await scan;

    const ended = await store.get(run.id);
    expect(ended?.state).toBe('complete');
    expect(ended?.scanId).toBe(finished.id);
    expect(ended?.lease).toBeUndefined();
    expect(ended?.finishedAt).toBeDefined();
  });

  it('keeps what was asked, so a retry can be checked against it', async () => {
    const { runs, store } = harness();
    const { run, scan } = await runs.trigger(
      { ...request([refusing('settings', SETTINGS)]), lookbackDays: 90, trigger: 'scheduled' },
      { actor: 'ada@example.com', idempotencyKey: 'k' }
    );
    await scan;

    const held = await store.get(run.id);
    expect(held?.request.lookbackDays).toBe(90);
    expect(held?.trigger).toBe('scheduled');
  });
});

describe('a duplicate trigger', () => {
  it('is refused rather than run twice while the first is still being worked on', async () => {
    const { runs } = harness();
    const held = stalling('settings', SETTINGS);
    const first = await runs.trigger(request([held.collector]), { actor: 'ada@example.com', idempotencyKey: 'k' });
    await held.reached;

    await expect(
      runs.trigger(request([refusing('settings', SETTINGS)]), { actor: 'ada@example.com', idempotencyKey: 'k' })
    ).rejects.toThrow(RunNotJoinable);

    held.release();
    await first.scan;
  });

  it('is refused with the answer, rather than re-run, once the first has finished', async () => {
    const { runs } = harness();
    const { scan } = await runs.trigger(request([refusing('settings', SETTINGS)]), {
      actor: 'ada@example.com',
      idempotencyKey: 'k',
    });
    const done = await scan;

    const refused = await runs
      .trigger(request([refusing('settings', SETTINGS)]), { actor: 'ada@example.com', idempotencyKey: 'k' })
      .catch((cause: unknown) => cause);

    expect(refused).toBeInstanceOf(RunNotJoinable);
    expect((refused as RunNotJoinable).refusal).toBe('terminal');
    expect((refused as RunNotJoinable).message).toContain(done.id);
  });

  it('is refused when it comes from somebody else, since the readings would mix identities', async () => {
    const { runs } = harness();
    const held = stalling('settings', SETTINGS);
    const first = await runs.trigger(request([held.collector]), { actor: 'ada@example.com', idempotencyKey: 'k' });
    await held.reached;

    const refused = await runs
      .trigger(request([refusing('settings', SETTINGS)]), { actor: 'grace@example.com', idempotencyKey: 'k' })
      .catch((cause: unknown) => cause);
    expect((refused as RunNotJoinable).refusal).toBe('other-actor');

    held.release();
    await first.scan;
  });

  it('lets two runs with no key both happen, since a person pressing scan twice means it twice', async () => {
    // The in-process lock is what refuses the second here, and it is a different mechanism with a
    // different message. This asserts the key is not doing that job — it has no business doing it.
    const { runs, store } = harness();
    const { scan } = await runs.trigger(request([refusing('settings', SETTINGS)]), { actor: 'ada@example.com' });
    await scan;
    const second = await runs.trigger(request([refusing('settings', SETTINGS)]), { actor: 'ada@example.com' });
    await second.scan;

    expect((await store.recent(10)).length).toBe(2);
  });
});

// The advisory run is the same five steps in the same order — see ADR 0069 — so what is worth holding
// here is only what the two kinds do *differently*. Everything the shared code does is already covered
// above, and asserting it twice would be asserting that a shared function is shared.
describe('an advisory run', () => {
  const ADVISORY_SIGNALS: readonly SignalId[] = [
    'sql:serverless.job_readiness',
    'sql:serverless.job_spend',
    'sql:jobs.inventory',
    'sql:estate.workspaces',
  ];

  /** A collector that answers the advisor's whole signal set, refused, which is enough to end a run. */
  function advisoryCollector(): Collector {
    return {
      surface: 'sql',
      name: 'advisory',
      signals: [...ADVISORY_SIGNALS],
      collect: (ids): Promise<SignalResult[]> =>
        Promise.resolve(ids.map((id) => unmeasurable(id, 'The advisory collector is refused here.'))),
    };
  }

  it('is recorded as its own kind, so a history page can tell the two apart', async () => {
    const { runs, store } = harness();
    const { run, advisory } = await runs.advise(request([advisoryCollector()]), { actor: 'ada@example.com' });
    await advisory;

    expect((await store.get(run.id))?.kind).toBe('advisory');
  });

  it('points at the advisory it produced, and not at a scan', async () => {
    const { runs, store } = harness();
    const { run, advisory } = await runs.advise(request([advisoryCollector()]), { actor: 'ada@example.com' });
    const produced = await advisory;

    const ended = await store.get(run.id);
    expect(ended?.advisoryId).toBe(produced.id);
    // The column named for the other kind of output stays empty. A pointer that held whichever id the
    // run happened to produce is how advice gets exported as an assessment.
    expect(ended?.scanId).toBeUndefined();
    expect(ended?.state).toBe('complete');
    expect(ended?.lease).toBeUndefined();
  });

  it('names the run it belongs to, in both directions', async () => {
    const { runs, advisories } = harness();
    const { run, advisory } = await runs.advise(request([advisoryCollector()]), { actor: 'ada@example.com' });
    const produced = await advisory;

    expect(produced.runId).toBe(run.id);
    expect((await advisories.forRun(run.id))?.id).toBe(produced.id);
  });

  it('cannot continue a run of the other kind, even with the right key and the right person', async () => {
    const { runs } = harness();
    const held = stalling('settings', SETTINGS);
    const first = await runs.trigger(request([held.collector]), { actor: 'ada@example.com', idempotencyKey: 'k' });
    await held.reached;

    const refused = await runs
      .advise(request([advisoryCollector()]), { actor: 'ada@example.com', idempotencyKey: 'k' })
      .catch((cause: unknown) => cause);

    // `other-kind` rather than `other-request`: the two kinds share a key space, and telling a caller
    // its retry asked for something different would be true and useless. What it needs to hear is that
    // the key names the other cycle.
    expect((refused as RunNotJoinable).refusal).toBe('other-kind');
    expect((refused as RunNotJoinable).message).toContain('advisory');

    held.release();
    await first.scan;
  });

  it('does not record a pillar subset, because nothing here scores', async () => {
    const { runs, store } = harness();
    const { run, advisory } = await runs.advise(
      { ...request([advisoryCollector()]), lookbackDays: 90 },
      { actor: 'ada@example.com', trigger: 'scheduled', idempotencyKey: 'weekly-1' }
    );
    await advisory;

    const kept = (await store.get(run.id))?.request;
    expect(kept?.lookbackDays).toBe(90);
    // Absent rather than empty. An empty list compares as a different ask from no list, so a retry
    // carrying one would be refused as asking something else — which is the bug the field-by-field
    // comparison in `sameRequest` was written for.
    expect(kept?.pillars).toBeUndefined();
    expect((await store.get(run.id))?.trigger).toBe('scheduled');
  });

  it('is resumed from its own checkpoints rather than starting again', async () => {
    const db = database();
    const first = harness({ db, holder: 'one' });
    const held = stalling('advisory', ADVISORY_SIGNALS[0]);
    const started = await first.runs.advise(
      {
        ...request([
          held.collector,
          {
            surface: 'sql',
            name: 'rest',
            signals: ADVISORY_SIGNALS.slice(1),
            collect: (ids): Promise<SignalResult[]> =>
              Promise.resolve(ids.map((id) => unmeasurable(id, 'refused'))),
          },
        ]),
      },
      { actor: 'ada@example.com', idempotencyKey: 'weekly-2' }
    );
    await held.reached;
    held.release();
    await started.advisory;

    // A second process, arriving with the same key after the run has ended, is refused with the answer
    // rather than re-reading the estate — the same bargain an assessment retry gets.
    const second = harness({ db, holder: 'two' });
    const refused = await second.runs
      .advise(request([advisoryCollector()]), { actor: 'ada@example.com', idempotencyKey: 'weekly-2' })
      .catch((cause: unknown) => cause);
    expect((refused as RunNotJoinable).refusal).toBe('terminal');
  });

  it('refuses when the build has no advisor, rather than opening a run nothing will collect', async () => {
    const store = new PostgresRunStore(database());
    const runs = new Runs({ store, runner: new ScanRunner({ catalogue, registry, store: new InMemoryScanStore() }) });

    await expect(runs.advise(request([advisoryCollector()]), { actor: 'ada@example.com' })).rejects.toThrow(
      /no workload advisor/
    );
    // And nothing was written. A run opened for an executor that does not exist is a row that stays
    // `running` until its lease lapses, reported by the app as work in progress that nothing is doing.
    expect(await store.recent(10)).toHaveLength(0);
  });
});

describe('resuming after the process that was running it stopped', () => {
  it('starts from what the killed attempt reached rather than reading it again', async () => {
    let settingsRead = 0;
    let tokensRead = 0;
    const clock = { at: new Date('2026-01-01T00:00:00Z') };
    const db = database();
    const killed = harness({ db, now: () => clock.at, holder: 'process-a' });

    // The first attempt reads one collector and is then abandoned mid-way through the second.
    const held = stalling('tokens', TOKENS);
    const started = await killed.runs.trigger(
      request([refusing('settings', SETTINGS, () => (settingsRead += 1)), held.collector]),
      { actor: 'ada@example.com', idempotencyKey: 'k' }
    );
    await held.reached;

    // The checkpoint for the finished unit is on the record, and the one in flight is not — which is
    // the whole claim about how wide the gap is.
    expect((await killed.store.checkpoints(started.run.id)).length).toBe(1);

    // The process stops renewing. Nothing else can be asserted about it: a killed process does not get
    // to write anything, which is why the lease exists. Its replacement is a second harness over the
    // same database, because a restart is a new runner with an empty in-process lock.
    clock.at = new Date(clock.at.getTime() + (LEASE_SECONDS + 1) * 1000);
    const next = harness({ db, now: () => clock.at, holder: 'process-b' });

    const again = await next.runs.trigger(
      request([
        refusing('settings', SETTINGS, () => (settingsRead += 1)),
        refusing('tokens', TOKENS, () => (tokensRead += 1)),
      ]),
      { actor: 'ada@example.com', idempotencyKey: 'k' }
    );

    expect(again.run.id).toBe(started.run.id);
    expect(again.resumed).toBe(true);
    expect(again.resumedFrom).toBe(1);

    await again.scan;
    // Read once across two attempts, which is the saving. The unit that was in flight is read again,
    // which is the honest cost.
    expect(settingsRead).toBe(1);
    expect(tokensRead).toBe(1);

    held.release();
    await started.scan.catch(() => undefined);
  });

  it('records what became of the attempt it took over, since that attempt cannot', async () => {
    const clock = { at: new Date('2026-01-01T00:00:00Z') };
    const db = database();
    const killed = harness({ db, now: () => clock.at, holder: 'process-a' });
    const held = stalling('settings', SETTINGS);
    const started = await killed.runs.trigger(request([held.collector]), {
      actor: 'ada@example.com',
      idempotencyKey: 'k',
    });
    await held.reached;

    clock.at = new Date(clock.at.getTime() + (LEASE_SECONDS + 1) * 1000);
    const next = harness({ db, now: () => clock.at, holder: 'process-b' });
    const again = await next.runs.trigger(request([refusing('settings', SETTINGS)]), {
      actor: 'ada@example.com',
      idempotencyKey: 'k',
    });
    await again.scan;

    const attempts = await next.store.attempts(started.run.id);
    expect(attempts.map((one) => one.outcome)).toEqual(['abandoned', 'complete']);

    held.release();
    await started.scan.catch(() => undefined);
  });

  it('loses one signal of a collector that was mid-way through, rather than the collector', async () => {
    // What the finer grain buys, measured where it matters rather than asserted where it is written.
    // A collector reading its signals one at a time — the SQL collector reads nineteen statements
    // against the customer's warehouse — used to have all of them written at the end of the unit, so a
    // killed attempt lost every statement it had already paid for. Now the loss is the one in flight.
    const read: SignalId[] = [];
    const clock = { at: new Date('2026-01-01T00:00:00Z') };
    const db = database();
    const killed = harness({ db, now: () => clock.at, holder: 'process-a' });

    const held = progressive('both', SETTINGS, TOKENS, (signal) => read.push(signal));
    const started = await killed.runs.trigger(request([held.collector]), {
      actor: 'ada@example.com',
      idempotencyKey: 'k',
    });
    await held.reached;

    // One signal of the unit is on the record while the unit itself is still running, which is the
    // thing that was not previously possible.
    expect((await killed.store.checkpoints(started.run.id)).length).toBe(1);

    clock.at = new Date(clock.at.getTime() + (LEASE_SECONDS + 1) * 1000);
    const next = harness({ db, now: () => clock.at, holder: 'process-b' });
    const resumed = progressive('both', SETTINGS, TOKENS, (signal) => read.push(signal));
    const again = await next.runs.trigger(request([resumed.collector]), {
      actor: 'ada@example.com',
      idempotencyKey: 'k',
    });
    resumed.release();
    await again.scan;

    expect(again.resumedFrom).toBe(1);
    // The second attempt read the signal that was in flight and not the one already on the record. On
    // the old grain both would appear twice, because the whole unit was the unit.
    expect(read).toEqual([SETTINGS, TOKENS]);

    held.release();
    await started.scan.catch(() => undefined);
  });

  it('writes no more rows for reporting each signal than it did for reporting the collector', async () => {
    // The cost side of the finer grain, and the reason it is worth having at all. The checkpoint table
    // is keyed per signal and always was, so the store's `checkpoint` writes one upsert per reading
    // whether it is handed one reading or nineteen. Reporting as you go therefore does not add a write;
    // it moves the same writes earlier. If a future change makes the write per call rather than per
    // reading — batching them into one statement, say — this test fails, and the ADR's claim that the
    // mechanism is free stops being true at the same moment.
    const { runs, db } = harness();
    const reporting = progressive('both', SETTINGS, TOKENS, () => undefined);
    reporting.release();
    const { scan } = await runs.trigger(request([reporting.collector]), {
      actor: 'ada@example.com',
      idempotencyKey: 'k',
    });
    await scan;

    const inserts = db.statements.filter((sql) => sql.includes('insert into') && sql.includes('run_checkpoints'));
    expect(inserts.length).toBe(2);
  });

  it('drops the checkpoints once the run has an answer, so nothing resumes from a finished run', async () => {
    const { runs, db } = harness();
    const { scan } = await runs.trigger(request([refusing('settings', SETTINGS)]), {
      actor: 'ada@example.com',
      idempotencyKey: 'k',
    });
    await scan;

    expect(db.rows('run_checkpoints')).toEqual([]);
  });
});

describe('cancelling', () => {
  it('is obeyed at the next unit boundary, and what was read is kept', async () => {
    let secondRead = 0;
    const { runs, store, scans } = harness();
    const held = stalling('settings', SETTINGS);
    const { run, scan } = await runs.trigger(
      request([held.collector, refusing('tokens', TOKENS, () => (secondRead += 1))]),
      { actor: 'ada@example.com', idempotencyKey: 'k' }
    );
    await held.reached;

    expect(await runs.cancel(run.id)).toBe('stopping');
    held.release();
    const finished = await scan;

    // The unit in flight completed and was kept; the one after it was never started.
    expect(secondRead).toBe(0);
    expect(finished.state).toBe('partial');
    expect(await scans.latest()).toBeDefined();

    const ended = await store.get(run.id);
    expect(ended?.state).toBe('cancelled');
    expect(ended?.scanId).toBe(finished.id);
    expect(ended?.why).toContain('asked for this run to stop');
  });

  it('ends a run nothing is working on, rather than leaving a flag for an attempt that never comes', async () => {
    // The case an in-memory abort signal cannot cover, and the one the record alone does not settle
    // either: the run was left behind by a process that is gone, so there is no attempt to obey the
    // flag. Recording it and stopping there left the abandoned run — the only kind a supervisor can
    // actually see lying about — `running` for ever unless somebody happened to trigger it again.
    const clock = { at: new Date('2026-01-01T00:00:00Z') };
    const db = database();
    const killed = harness({ db, now: () => clock.at, holder: 'process-a' });
    const held = stalling('settings', SETTINGS);
    const started = await killed.runs.trigger(request([held.collector]), {
      actor: 'ada@example.com',
      idempotencyKey: 'k',
    });
    await held.reached;

    clock.at = new Date(clock.at.getTime() + (LEASE_SECONDS + 1) * 1000);
    const next = harness({ db, now: () => clock.at, holder: 'process-b' });
    expect(await next.runs.cancel(started.run.id)).toBe('stopping');

    const ended = await next.store.get(started.run.id);
    expect(ended?.state).toBe('cancelled');
    expect(ended?.why).toContain('while no process was working on it');
    // And nothing may take it up again, because a cancel is a decision rather than a pause.
    await expect(
      next.runs.trigger(request([refusing('settings', SETTINGS)]), { actor: 'ada@example.com', idempotencyKey: 'k' })
    ).rejects.toBeInstanceOf(RunNotJoinable);

    // The stalled attempt now wakes up and finishes its collection, holding nothing. It saved a scan and
    // it is entitled to say what became of *it*, but not to say what became of the run: the ending
    // recorded stays the cancel, and its own row stays the abandonment the takeover wrote.
    held.release();
    await started.scan.catch(() => undefined);
    const after = await next.store.get(started.run.id);
    expect(after?.state).toBe('cancelled');
    expect(after?.scanId).toBeUndefined();
    expect((await next.store.attempts(started.run.id)).map((one) => one.outcome)).toEqual(['abandoned', 'cancelled']);
  });

  it('refuses a run that already said something about the estate, rather than reporting a stop', async () => {
    // A supervisor cancelling what it thinks is a stuck run needs to hear that it completed, because
    // that changes what it does next — and a cancel date written onto a finished run is a date a later
    // reader has to explain away.
    const { runs, store } = harness();
    const { run, scan } = await runs.trigger(request([refusing('settings', SETTINGS)]), {
      actor: 'ada@example.com',
    });
    await scan;

    expect(await runs.cancel(run.id)).toBe('already-ended');
    const ended = await store.get(run.id);
    expect(ended?.state).toBe('complete');
    expect(ended?.cancelRequestedAt).toBeUndefined();
  });

  it('says so for a run nobody ever asked for', async () => {
    const { runs } = harness();
    expect(await runs.cancel('no-such-run')).toBe('no-such-run');
  });
});

describe('a run that was cut short without anybody asking', () => {
  it('is recorded as partial rather than cancelled, since the two call for different next moves', async () => {
    // What budget exhaustion and a wall-clock stop look like from here: the scan comes back `partial`
    // and no cancel was ever recorded. A reader deciding whether to run it again needs to know which,
    // because "it ran out of warehouse operations" and "somebody stopped it" are not the same problem.
    const { runs, store, runner } = harness();
    const held = stalling('settings', SETTINGS);
    const { run, scan } = await runs.trigger(request([held.collector, refusing('tokens', TOKENS)]), {
      actor: 'ada@example.com',
    });
    await held.reached;

    runner.cancel();
    held.release();
    const finished = await scan;

    expect(finished.state).toBe('partial');
    const ended = await store.get(run.id);
    expect(ended?.state).toBe('partial');
    expect(ended?.scanId).toBe(finished.id);
    // No `why`, because nothing here is a decision somebody made and owes an explanation for.
    expect(ended?.why).toBeUndefined();
    expect(ended?.cancelRequestedAt).toBeUndefined();
  });
});

describe('a run that throws', () => {
  it('is recorded as failed with the reason, rather than left looking like one still going', async () => {
    const { store } = harness();
    const broken: Collector = {
      surface: 'rest',
      name: 'settings',
      signals: [SETTINGS],
      collect: () => Promise.resolve([unmeasurable(SETTINGS, 'no')]),
    };
    // The collection itself cannot fail the scan — a collector that throws is caught and its signals
    // are marked unmeasurable — so the failure is introduced where one really can happen: the store.
    const scans = new InMemoryScanStore();
    scans.save = () => Promise.reject(new Error('the store is unreachable'));
    const runner = new ScanRunner({ catalogue, registry, store: scans });
    const durable = new Runs({ store, runner, heartbeatMs: 60_000 });

    const { run, scan } = await durable.trigger(request([broken]), { actor: 'ada@example.com' });
    await expect(scan).rejects.toThrow('unreachable');

    const ended = await store.get(run.id);
    expect(ended?.state).toBe('failed');
    expect(ended?.why).toContain('unreachable');
    expect(ended?.lease).toBeUndefined();
  });

  it('may be retried under its own key, because a failure is not an answer to read', async () => {
    // The alternative was refusing the retry and telling the caller to invent a new key, which files
    // each attempt at one nightly assessment as a separate assessment of the estate.
    const db = database();
    const scans = new InMemoryScanStore();
    const broken = harness({ db });
    let saves = 0;
    scans.save = () => (saves += 1) === 1 ? Promise.reject(new Error('the store is unreachable')) : Promise.resolve();
    const first = new Runs({ store: broken.store, runner: new ScanRunner({ catalogue, registry, store: scans }) });

    const failed = await first.trigger(request([refusing('settings', SETTINGS)]), {
      actor: 'ada@example.com',
      idempotencyKey: 'nightly',
    });
    await expect(failed.scan).rejects.toThrow('unreachable');
    expect((await broken.store.get(failed.run.id))?.state).toBe('failed');
    // What it read is kept, so the retry does not pay to read the same estate twice.
    expect(await broken.store.checkpoints(failed.run.id)).toHaveLength(1);

    const retried = harness({ db });
    let reread = 0;
    const again = await retried.runs.trigger(request([refusing('settings', SETTINGS, () => (reread += 1))]), {
      actor: 'ada@example.com',
      idempotencyKey: 'nightly',
    });
    await again.scan;

    expect(again.run.id).toBe(failed.run.id);
    expect(again.resumedFrom).toBe(1);
    expect(reread).toBe(0);
    const ended = await retried.store.get(failed.run.id);
    // One run, two attempts, and one outcome — which is what happened.
    expect(ended?.state).toBe('complete');
    expect(ended?.attempts).toBe(2);
    expect(ended?.finishedAt).toBeDefined();
  });
});

describe('what the record keeps of a request', () => {
  it('resolves the window to the number the run will use, not to a local default', () => {
    // A record saying thirty for a run that used ninety makes two triggers of one intention compare as
    // different requests, and the retry is refused as asking something else.
    expect(requestOf({ credentials: asUser, scope: accountScope(), collectors: [] }, 90).lookbackDays).toBe(90);
  });

  it('leaves out what was not asked for, rather than filling it in', () => {
    const asked = requestOf({ credentials: asUser, scope: accountScope(), collectors: [] });
    expect(asked.pillars).toBeUndefined();
    expect(asked.definition).toBeUndefined();
  });
});
