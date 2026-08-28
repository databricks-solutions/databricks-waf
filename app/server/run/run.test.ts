import { describe, expect, it } from 'vitest';

import { observed, type SignalId, type SignalResult } from '../collect/signal.js';
import type { EstateScope } from '../collect/estate-scope.js';
import {
  ANSWERED,
  HEARTBEAT_SECONDS,
  LEASE_SECONDS,
  TERMINAL,
  answered,
  endedAs,
  joinable,
  refusalMeans,
  resumeFrom,
  sameRequest,
  terminal,
  unheld,
  type Run,
  type RunRequest,
  type RunState,
} from './run.js';

const REQUEST: RunRequest = { scope: { description: 'the whole account' }, lookbackDays: 30 };

function run(over: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    kind: 'assessment',
    requestedAt: new Date('2026-01-01T00:00:00Z'),
    actor: 'ada@example.com',
    trigger: 'scheduled',
    idempotencyKey: 'key-1',
    request: REQUEST,
    state: 'running',
    attempts: 1,
    ...over,
  };
}

// Real signal ids rather than letters, because `resumeFrom` keys on them and a fixture with invented
// ids would pass a version of it that keyed on anything at all.
const A: SignalId = 'rest:workspace:token.list';
const B: SignalId = 'rest:workspace:preview.workspace-conf';

function reading(id: SignalId, value: string): SignalResult {
  return observed(id, value, 1);
}

describe('the lease window', () => {
  it('allows three renewals to be missed before another attempt may take the run', () => {
    // Not arbitrary: the ratio is the claim being made. One missed heartbeat is a pause, four is a
    // process that has stopped, and the gap between those two readings is what stops a slow scan
    // being taken over from underneath itself.
    expect(LEASE_SECONDS / HEARTBEAT_SECONDS).toBe(4);
  });
});

describe('terminal', () => {
  it('names every state a run does not leave, and running is not one of them', () => {
    const every: RunState[] = ['running', 'complete', 'partial', 'cancelled', 'failed'];
    expect(every.filter((state) => terminal(state))).toEqual([...TERMINAL]);
    expect(terminal('running')).toBe(false);
  });
});

describe('answered', () => {
  it('is every ending except failure, which is what makes a failed run retryable', () => {
    const every: RunState[] = ['running', 'complete', 'partial', 'cancelled', 'failed'];
    expect(every.filter((state) => answered(state))).toEqual([...ANSWERED]);
    // Over is not the same as answered, and the gap between them is one state wide on purpose: a
    // failed run is over and said nothing, so there is no answer for a retry to be told to read.
    expect(terminal('failed')).toBe(true);
    expect(answered('failed')).toBe(false);
  });
});

describe('unheld', () => {
  const now = new Date('2026-01-01T12:00:00Z');

  it('is unheld when nothing has claimed it', () => {
    expect(unheld(run(), now)).toBe(true);
  });

  it('is held while the claim is being renewed', () => {
    expect(unheld(run({ lease: { holder: 'one', until: new Date('2026-01-01T12:00:30Z') } }), now)).toBe(false);
  });

  it('is unheld the moment the claim lapses, since the holder cannot be asked whether it is alive', () => {
    expect(unheld(run({ lease: { holder: 'one', until: now } }), now)).toBe(true);
  });
});

describe('joinable', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const by = { actor: 'ada@example.com', kind: 'assessment' as const, request: REQUEST };

  it('lets a retry carry on a run whose holder stopped renewing', () => {
    const left = run({ lease: { holder: 'gone', until: new Date('2026-01-01T11:59:00Z') } });
    expect(joinable(left, by, now)).toBeUndefined();
  });

  it('refuses a run that already has an answer', () => {
    expect(joinable(run({ state: 'complete', scanId: 'scan-9' }), by, now)).toBe('terminal');
    expect(joinable(run({ state: 'partial', scanId: 'scan-9' }), by, now)).toBe('terminal');
    // Cancelled too, because that is a decision somebody made rather than a run that came up short.
    expect(joinable(run({ state: 'cancelled' }), by, now)).toBe('terminal');
  });

  it('lets a retry take up a run whose attempt broke, since there is no answer to read instead', () => {
    expect(joinable(run({ state: 'failed', why: 'the store is unreachable' }), by, now)).toBeUndefined();
  });

  it('refuses to put a second attempt on a run a live process is working on', () => {
    const held = run({ lease: { holder: 'one', until: new Date('2026-01-01T12:00:30Z') } });
    expect(joinable(held, by, now)).toBe('held');
  });

  it('refuses to continue somebody else\u2019s run, since its readings would mix identities', () => {
    expect(joinable(run(), { ...by, actor: 'grace@example.com' }, now)).toBe('other-actor');
  });

  it('refuses a key that names a run asked a different question', () => {
    const asked = { ...by, request: { ...REQUEST, lookbackDays: 90 } };
    expect(joinable(run(), asked, now)).toBe('other-request');
  });

  it('refuses an advisory trigger the key of an assessment, even when both ask the same question', () => {
    // The same scope and the same window, which is the point: the two kinds share a key space, so the
    // only difference is what the run is for, and reporting that as a different question would send a
    // caller looking for a difference in a request that matches exactly.
    expect(joinable(run(), { ...by, kind: 'advisory' }, now)).toBe('other-kind');
    expect(joinable(run({ kind: 'advisory' }), by, now)).toBe('other-kind');
  });

  it('names the kind each way round, so the sentence is not written from the trigger\u2019s side only', () => {
    const asAdvisory = refusalMeans('other-kind', run({ kind: 'advisory' }));
    expect(asAdvisory).toContain('names an advisory run');
    expect(asAdvisory).toContain('trigger is an assessment one');

    const asAssessment = refusalMeans('other-kind', run());
    expect(asAssessment).toContain('names an assessment run');
    expect(asAssessment).toContain('trigger is an advisory one');
  });

  it('checks the kind before the question, so a caller is told the real reason', () => {
    // An advisory trigger presenting an assessment's key with a different window has two problems,
    // and the kind is the one to report: told the window differs, the caller changes the window and
    // hits the same wall, because the run was never theirs to continue.
    const asked = { ...by, kind: 'advisory' as const, request: { ...REQUEST, lookbackDays: 90 } };
    expect(joinable(run(), asked, now)).toBe('other-kind');
  });

  it('checks who and what before whether, so a caller is told the real reason', () => {
    // A held run asked for by somebody else has two problems and only one is worth reporting: told
    // "wait for it", the caller waits and then hits the same wall, which reads as a flaky system.
    const held = run({ actor: 'grace@example.com', lease: { holder: 'one', until: new Date('2026-01-01T12:00:30Z') } });
    expect(joinable(held, by, now)).toBe('other-actor');
  });
});

describe('sameRequest', () => {
  it('reads a differently ordered pillar list as the same request', () => {
    const one = { ...REQUEST, pillars: ['cost-optimization', 'reliability'] };
    const other = { ...REQUEST, pillars: ['reliability', 'cost-optimization'] };
    expect(sameRequest(one, other)).toBe(true);
  });

  it('reads a different window, scope, pillar set or assessment version as a different request', () => {
    expect(sameRequest(REQUEST, { ...REQUEST, lookbackDays: 90 })).toBe(false);
    const narrowed = { selected: ['1'], description: 'one workspace' };
    expect(sameRequest(REQUEST, { ...REQUEST, scope: narrowed })).toBe(false);
    expect(sameRequest(REQUEST, { ...REQUEST, pillars: ['reliability'] })).toBe(false);
    const at = { ...REQUEST, definition: { id: 'def', version: 1, fingerprint: 'f1' } };
    expect(sameRequest(at, { ...at, definition: { id: 'def', version: 2, fingerprint: 'f2' } })).toBe(false);
  });

  it('reads a scope whose keys arrive in another order as the same scope', () => {
    // What a live run found, and the reason this is compared field by field. The stored side has been
    // through `jsonb`, which keeps an object by its own key order rather than the one it was written
    // in — so the app's own scope and the app's own scope read back were two different requests, and
    // the supervisor's retry after the app was killed mid-scan was refused as somebody else's work.
    const written = { hostWorkspaceId: '123', description: 'the whole account' };
    const readBack = JSON.parse('{"description":"the whole account","hostWorkspaceId":"123"}') as EstateScope;

    expect(JSON.stringify(written)).not.toBe(JSON.stringify(readBack));
    expect(sameRequest({ ...REQUEST, scope: written }, { ...REQUEST, scope: readBack })).toBe(true);
  });

  it('ignores how the scope was described, which is prose about the estate rather than the estate', () => {
    // A release that rewords the sentence shown to a reader must not make every run in flight
    // unresumable, and a refusal whose whole cause is a reworded sentence would be reported to a
    // supervisor as a request measuring something else.
    const reworded = { ...REQUEST.scope, description: 'Assessed across the whole account.' };
    expect(sameRequest(REQUEST, { ...REQUEST, scope: reworded })).toBe(true);
  });

  it('still refuses a scope narrowed to different workspaces, however it is described', () => {
    const six = { ...REQUEST.scope, selected: ['1', '2'] };
    const one = { ...REQUEST.scope, selected: ['1'] };
    expect(sameRequest({ ...REQUEST, scope: six }, { ...REQUEST, scope: one })).toBe(false);
    expect(sameRequest({ ...REQUEST, scope: six }, { ...REQUEST, scope: { ...six, selected: ['2', '1'] } })).toBe(true);
    expect(sameRequest(REQUEST, { ...REQUEST, scope: { ...REQUEST.scope, narrowedTo: '9' } })).toBe(false);
  });

  it('ignores the warehouse, which is where the reading came from rather than what was asked', () => {
    // Two attempts of one run can legitimately go through different warehouses — the second trigger
    // resolves its own. Refusing that would turn a warehouse change into an unresumable run.
    expect(sameRequest(REQUEST, { ...REQUEST, warehouse: 'w-2' })).toBe(true);
  });
});

describe('endedAs', () => {
  it('separates a scan somebody stopped from one that ran out of budget', () => {
    expect(endedAs({ state: 'partial' }, false)).toBe('partial');
    expect(endedAs({ state: 'partial' }, true)).toBe('cancelled');
  });

  it('calls a cancelled run cancelled even where the collection finished in time', () => {
    // The flag was set and obeyed; the last unit happened to complete. Reporting that as complete
    // would tell an admin their cancel did nothing.
    expect(endedAs({ state: 'complete' }, true)).toBe('cancelled');
  });

  it('is complete only when nothing cut it short', () => {
    expect(endedAs({ state: 'complete' }, false)).toBe('complete');
  });
});

describe('resumeFrom', () => {
  it('starts from what was read, so a resumed attempt does not read it again', () => {
    const readings = resumeFrom([
      { runId: 'run-1', at: new Date('2026-01-01T00:01:00Z'), readings: [reading(A, 'first')] },
      { runId: 'run-1', at: new Date('2026-01-01T00:02:00Z'), readings: [reading(B, 'second')] },
    ]);
    expect([...readings.keys()]).toEqual([A, B]);
  });

  it('takes the later reading of a signal checkpointed twice', () => {
    // Two attempts can both have read one signal — the first was killed after collecting it but
    // before the second joined. The later reading is the one whose provenance matches the attempt
    // that is going to finish the run.
    const readings = resumeFrom([
      { runId: 'run-1', at: new Date('2026-01-01T00:02:00Z'), readings: [reading(A, 'second')] },
      { runId: 'run-1', at: new Date('2026-01-01T00:01:00Z'), readings: [reading(A, 'first')] },
    ]);
    expect(readings.get(A)?.value).toBe('second');
  });

  it('has nothing to start from when nothing was checkpointed', () => {
    expect(resumeFrom([]).size).toBe(0);
  });
});

describe('refusalMeans', () => {
  it('names the scan a finished run produced, so the caller can go and read it', () => {
    expect(refusalMeans('terminal', run({ state: 'complete', scanId: 'scan-9' }))).toContain('scan scan-9');
  });

  it('says nothing about a scan for a run that was stopped before producing one', () => {
    const said = refusalMeans('terminal', run({ state: 'cancelled' }));
    expect(said).toContain('cancelled');
    expect(said).not.toContain('recorded as scan');
  });

  it('names the other actor, since the caller cannot otherwise tell whose run it collided with', () => {
    expect(refusalMeans('other-actor', run({ actor: 'grace@example.com' }))).toContain('grace@example.com');
  });

  it('has a sentence for every refusal', () => {
    for (const refusal of ['terminal', 'held', 'other-actor', 'other-request'] as const) {
      expect(refusalMeans(refusal, run()).length).toBeGreaterThan(40);
    }
  });
});
