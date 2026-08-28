import { describe, expect, it } from 'vitest';

import { observed, type SignalId, type SignalResult } from '../collect/signal.js';
import { FakePostgres } from '../store/postgres-fake.js';
import { LEASE_SECONDS, resumeFrom, type RunRequest } from './run.js';
import { PostgresRunStore, type Opening } from './run-store.js';

const REQUEST: RunRequest = { scope: { description: 'the whole account' }, lookbackDays: 30 };
const AT = new Date('2026-01-01T00:00:00Z');

function store(): { store: PostgresRunStore; db: FakePostgres } {
  const db = new FakePostgres({
    keys: { run_checkpoints: ['run_id', 'signal_id'] },
    unique: { runs: ['idempotency_key'] },
  });
  return { store: new PostgresRunStore(db), db };
}

function opening(over: Partial<Opening> = {}): Opening {
  return {
    id: 'run-1',
    kind: 'assessment',
    actor: 'ada@example.com',
    trigger: 'scheduled',
    idempotencyKey: 'key-1',
    request: REQUEST,
    requestedAt: AT,
    ...over,
  };
}

// Real signal ids rather than letters, because a checkpoint is keyed on one and a fixture with invented
// ids would pass a store that keyed on anything at all.
const A: SignalId = 'rest:workspace:token.list';
const B: SignalId = 'rest:workspace:preview.workspace-conf';

function reading(id: SignalId, value: string): SignalResult {
  return observed(id, value, 1);
}

describe('opening a run', () => {
  it('keys the run to the assessment its request names, and to nothing when it names none', async () => {
    // Both halves in one test because the pair is the point: a column that can only say "def-1"
    // cannot distinguish a run of an assessment from one started directly, and `42c` filters on the
    // difference. Null here means not stated, never the install's.
    const { store: runs, db } = store();
    await runs.open(opening({ request: { ...REQUEST, definition: { id: 'def-1', version: 2, fingerprint: 'f' } } }));
    await runs.open(opening({ id: 'run-2', idempotencyKey: 'key-2' }));

    const keyed = new Map(db.rows('runs').map((row) => [row.id, row.definition_id]));
    expect(keyed.get('run-1')).toBe('def-1');
    expect(keyed.get('run-2')).toBeNull();
  });

  it('writes the run, unheld from the moment it was asked for', async () => {
    const { store: runs } = store();
    const { run, created } = await runs.open(opening());

    expect(created).toBe(true);
    expect(run.state).toBe('running');
    expect(run.attempts).toBe(0);
    // Nothing holds it, and it is free from now — which is what makes claiming a single comparison.
    expect(run.lease).toBeUndefined();
  });

  it('answers a repeated key with the run it already names, rather than raising', async () => {
    // The duplicate-trigger case, and the reason it is an insert rather than a read: two retries
    // arriving together both read no run, so the constraint has to be what refuses the second.
    const { store: runs } = store();
    const first = await runs.open(opening());
    const second = await runs.open(opening({ id: 'run-2' }));

    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
  });

  it('lets two runs with no key both exist, since a person pressing scan twice means it twice', async () => {
    const { store: runs } = store();
    const first = await runs.open(opening({ id: 'run-1', idempotencyKey: undefined, trigger: 'interactive' }));
    const second = await runs.open(opening({ id: 'run-2', idempotencyKey: undefined, trigger: 'interactive' }));

    expect([first.created, second.created]).toEqual([true, true]);
    expect((await runs.recent(10)).length).toBe(2);
  });

  it('keeps the request, so a resumed attempt measures what was asked', async () => {
    const { store: runs } = store();
    const asked = { ...REQUEST, pillars: ['reliability'], lookbackDays: 90 };
    await runs.open(opening({ request: asked }));

    expect((await runs.get('run-1'))?.request).toEqual(asked);
  });
});

describe('claiming a run', () => {
  it('gives the lease to one attempt and refuses the second', async () => {
    const { store: runs } = store();
    await runs.open(opening());

    const mine = await runs.claim('run-1', 'process-a', AT);
    const theirs = await runs.claim('run-1', 'process-b', AT);

    expect(mine?.holder).toBe('process-a');
    expect(mine?.number).toBe(1);
    expect(theirs).toBeUndefined();
  });

  it('sets the lease one window ahead, so a heartbeat has three chances to miss', async () => {
    const { store: runs } = store();
    await runs.open(opening());
    await runs.claim('run-1', 'process-a', AT);

    expect((await runs.get('run-1'))?.lease?.until).toEqual(new Date(AT.getTime() + LEASE_SECONDS * 1000));
  });

  it('lets a retry take a run whose holder stopped renewing', async () => {
    const { store: runs } = store();
    await runs.open(opening());
    await runs.claim('run-1', 'killed', AT);

    const later = new Date(AT.getTime() + (LEASE_SECONDS + 1) * 1000);
    const next = await runs.claim('run-1', 'process-b', later);

    expect(next?.holder).toBe('process-b');
    expect(next?.number).toBe(2);
  });

  it('records what became of the attempt it took over from, since that process cannot', async () => {
    const { store: runs } = store();
    await runs.open(opening());
    await runs.claim('run-1', 'killed', AT);
    await runs.claim('run-1', 'process-b', new Date(AT.getTime() + (LEASE_SECONDS + 1) * 1000));

    const attempts = await runs.attempts('run-1');
    expect(attempts.map((one) => one.outcome)).toEqual(['abandoned', undefined]);
    expect(attempts[0]?.endedAt).toBeDefined();
  });

  it('counts the attempt in the database rather than in the caller', async () => {
    // Two processes reading the number and writing it back would both be attempt two, and a review
    // asking "does the scheduled run work" would be told one attempt where there were three.
    const { store: runs } = store();
    await runs.open(opening());
    await runs.claim('run-1', 'a', AT);
    await runs.claim('run-1', 'b', new Date(AT.getTime() + 61_000));
    await runs.claim('run-1', 'c', new Date(AT.getTime() + 122_000));

    expect((await runs.get('run-1'))?.attempts).toBe(3);
  });

  it('refuses to claim a run that already has an answer', async () => {
    const { store: runs } = store();
    await runs.open(opening());
    const attempt = await runs.claim('run-1', 'a', AT);
    await runs.finish(attempt!, { state: 'complete', at: AT, scanId: 'scan-1' });

    expect(await runs.claim('run-1', 'b', new Date(AT.getTime() + 999_000))).toBeUndefined();
  });

  it('takes a failed run back up and puts it back to running, since a failure is not an answer', async () => {
    const { store: runs } = store();
    await runs.open(opening());
    const broke = await runs.claim('run-1', 'a', AT);
    await runs.finish(broke!, { state: 'failed', at: AT, why: 'the store is unreachable' });

    const retry = await runs.claim('run-1', 'b', new Date(AT.getTime() + 999_000));

    expect(retry?.number).toBe(2);
    const run = await runs.get('run-1');
    expect(run?.state).toBe('running');
    // Cleared, because a run that is being worked on again has not finished. Left set, every reader
    // that tells a finished run from a running one by that date would report both at once.
    expect(run?.finishedAt).toBeUndefined();
  });
});

describe('renewing a claim', () => {
  it('extends the lease while the holder is the one asking', async () => {
    const { store: runs } = store();
    await runs.open(opening());
    const attempt = await runs.claim('run-1', 'a', AT);

    const later = new Date(AT.getTime() + 15_000);
    expect(await runs.renew(attempt!, later)).toBe(true);
    expect((await runs.get('run-1'))?.lease?.until).toEqual(new Date(later.getTime() + LEASE_SECONDS * 1000));
  });

  it('refuses a process whose run has been taken, which is its signal to stop', async () => {
    // The stalled-then-woke case. Without the holder in the predicate this renewal would extend a lease
    // it no longer holds, and two attempts would be collecting one assessment.
    const { store: runs } = store();
    await runs.open(opening());
    const stalled = await runs.claim('run-1', 'stalled', AT);
    await runs.claim('run-1', 'took-over', new Date(AT.getTime() + 61_000));

    expect(await runs.renew(stalled!, new Date(AT.getTime() + 70_000))).toBe(false);
  });
});

describe('cancelling', () => {
  it('is a record the running attempt reads, not a change of state', async () => {
    // A cancel that set the state would race the attempt that is finishing: whichever wrote last would
    // win, so a run could be marked cancelled after it had saved a scan.
    const { store: runs } = store();
    await runs.open(opening());
    await runs.cancel('run-1', new Date(AT.getTime() + 5000));

    const run = await runs.get('run-1');
    expect(run?.state).toBe('running');
    expect(run?.cancelRequestedAt).toEqual(new Date(AT.getTime() + 5000));
    expect(await runs.cancelRequested('run-1')).toBe(true);
  });

  it('keeps the first request, so the time says when the decision was made', async () => {
    const { store: runs } = store();
    await runs.open(opening());
    await runs.cancel('run-1', new Date(AT.getTime() + 5000));
    await runs.cancel('run-1', new Date(AT.getTime() + 9000));

    expect((await runs.get('run-1'))?.cancelRequestedAt).toEqual(new Date(AT.getTime() + 5000));
  });

  it('reads as not asked for on a run nobody stopped', async () => {
    const { store: runs } = store();
    await runs.open(opening());
    expect(await runs.cancelRequested('run-1')).toBe(false);
  });
});

describe('checkpoints', () => {
  it('keeps what a unit read, so a resumed attempt starts from it', async () => {
    const { store: runs } = store();
    await runs.open(opening());
    await runs.checkpoint('run-1', [reading(A, 'one'), reading(B, 'two')], AT);

    expect([...resumeFrom(await runs.checkpoints('run-1')).keys()].sort()).toEqual([A, B].sort());
  });

  it('replaces a signal read twice rather than keeping both', async () => {
    // Appended instead, the table grows by a copy of the estate per attempt, and the sweep eventually
    // has more checkpoint rows than scan rows for the same information.
    const { store: runs, db } = store();
    await runs.open(opening());
    await runs.checkpoint('run-1', [reading(A, 'first')], AT);
    await runs.checkpoint('run-1', [reading(A, 'second')], new Date(AT.getTime() + 1000));

    expect(db.rows('run_checkpoints').length).toBe(1);
    expect(resumeFrom(await runs.checkpoints('run-1')).get(A)?.value).toBe('second');
  });

  it('comes back parsed, so a resumed attempt gets a reading rather than a string', async () => {
    const { store: runs } = store();
    await runs.open(opening());
    await runs.checkpoint('run-1', [reading(A, 'one')], AT);

    const [first] = await runs.checkpoints('run-1');
    expect(first?.readings[0]?.status).toBe('observed');
  });
});

describe('finishing', () => {
  it('records the outcome, names the scan, and lets the run go', async () => {
    const { store: runs } = store();
    await runs.open(opening());
    const attempt = await runs.claim('run-1', 'a', AT);
    await runs.finish(attempt!, { state: 'complete', at: new Date(AT.getTime() + 60_000), scanId: 'scan-7' });

    const run = await runs.get('run-1');
    expect(run?.state).toBe('complete');
    expect(run?.scanId).toBe('scan-7');
    expect(run?.lease).toBeUndefined();
    expect(run?.finishedAt).toEqual(new Date(AT.getTime() + 60_000));
  });

  it('drops the checkpoints, since the scan now holds those readings', async () => {
    const { store: runs, db } = store();
    await runs.open(opening());
    const attempt = await runs.claim('run-1', 'a', AT);
    await runs.checkpoint('run-1', [reading(A, 'one')], AT);
    await runs.finish(attempt!, { state: 'complete', at: AT, scanId: 'scan-1' });

    expect(db.rows('run_checkpoints')).toEqual([]);
  });

  it('keeps them where there is no scan, since they are then the only record of what was read', async () => {
    const { store: runs, db } = store();
    await runs.open(opening());
    const attempt = await runs.claim('run-1', 'a', AT);
    await runs.checkpoint('run-1', [reading(A, 'one')], AT);
    await runs.finish(attempt!, { state: 'failed', at: AT, why: 'the store is unreachable' });

    // Dropped, the retry pays to read an estate this run has already read.
    expect(db.rows('run_checkpoints').length).toBe(1);
  });

  it('is refused from a process that no longer holds the run', async () => {
    // A stalled attempt that woke up and finished would otherwise overwrite the outcome of the attempt
    // that took over and succeeded.
    const { store: runs } = store();
    await runs.open(opening());
    const stalled = await runs.claim('run-1', 'stalled', AT);
    const took = await runs.claim('run-1', 'took-over', new Date(AT.getTime() + 61_000));
    await runs.finish(took!, { state: 'complete', at: AT, scanId: 'good' });
    expect(await runs.finish(stalled!, { state: 'failed', at: AT, why: 'stale' })).toBe(false);

    const run = await runs.get('run-1');
    expect(run?.state).toBe('complete');
    expect(run?.scanId).toBe('good');
  });

  it('writes nothing at all from that process, not merely no outcome', async () => {
    // The refusal has to cover the checkpoints and the attempt row as well as the run's state. A stale
    // attempt that dropped the checkpoints would take away what the attempt holding the run is resuming
    // from — and it is the one case where dropping them is wrong twice over, since this run has produced
    // no scan to hold those readings instead.
    const { store: runs, db } = store();
    await runs.open(opening());
    const stalled = await runs.claim('run-1', 'stalled', AT);
    await runs.checkpoint('run-1', [reading(A, 'one')], AT);
    const took = await runs.claim('run-1', 'took-over', new Date(AT.getTime() + 61_000));

    expect(await runs.finish(stalled!, { state: 'complete', at: AT, scanId: 'stale-scan' })).toBe(false);

    expect(db.rows('run_checkpoints').length).toBe(1);
    expect((await runs.get('run-1'))?.state).toBe('running');
    // Its own row says what the takeover said about it, which is truer than an ending it wrote after
    // losing the run.
    const attempts = await runs.attempts('run-1');
    expect(attempts.map((one) => one.outcome)).toEqual(['abandoned', undefined]);
    // And the attempt that does hold it can still end it.
    expect(await runs.finish(took!, { state: 'complete', at: AT, scanId: 'good' })).toBe(true);
    expect((await runs.get('run-1'))?.scanId).toBe('good');
  });

  it('keeps why it ended, for the states where that is not obvious', async () => {
    const { store: runs } = store();
    await runs.open(opening());
    const attempt = await runs.claim('run-1', 'a', AT);
    await runs.finish(attempt!, { state: 'failed', at: AT, why: 'the warehouse refused every statement' });

    expect((await runs.get('run-1'))?.why).toContain('warehouse');
  });
});

describe('releasing without ending', () => {
  it('makes the run claimable at once rather than after the lease runs out', async () => {
    // What a clean shutdown does. Waiting out a lease nobody is renewing would delay a retry by a
    // minute for no reason.
    const { store: runs } = store();
    await runs.open(opening());
    const attempt = await runs.claim('run-1', 'a', AT);
    await runs.release(attempt!, new Date(AT.getTime() + 1000));

    const next = await runs.claim('run-1', 'b', new Date(AT.getTime() + 1000));
    expect(next?.holder).toBe('b');
  });

  it('leaves the run running and its checkpoints intact', async () => {
    const { store: runs, db } = store();
    await runs.open(opening());
    const attempt = await runs.claim('run-1', 'a', AT);
    await runs.checkpoint('run-1', [reading(A, 'one')], AT);
    await runs.release(attempt!, AT);

    expect((await runs.get('run-1'))?.state).toBe('running');
    expect(db.rows('run_checkpoints').length).toBe(1);
  });
});

describe('listing', () => {
  it('separates what is still going from what is over', async () => {
    const { store: runs } = store();
    await runs.open(opening({ id: 'done', idempotencyKey: 'k1' }));
    await runs.open(opening({ id: 'going', idempotencyKey: 'k2', requestedAt: new Date(AT.getTime() + 1000) }));
    const attempt = await runs.claim('done', 'a', AT);
    await runs.finish(attempt!, { state: 'complete', at: AT, scanId: 'scan-1' });

    expect((await runs.unfinished()).map((one) => one.id)).toEqual(['going']);
    expect((await runs.recent(10)).map((one) => one.id)).toEqual(['going', 'done']);
  });
});
