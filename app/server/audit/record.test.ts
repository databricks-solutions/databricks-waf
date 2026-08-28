import { describe, expect, it, vi } from 'vitest';
import {
  AuditRecorder,
  closedWhenAnswered,
  postureFrom,
  reasonFor,
  TrailUnwritableError,
  type Answered,
} from './record.js';
import { GENESIS } from './event.js';
import { InMemoryAuditLog, type AuditLog } from '../store/audit-log.js';
import { NotPermittedError } from '../authorize/group.js';

const WHO = { actor: 'priya@example.com', executionMode: 'on-behalf-of-user' } as const;

function recorder(log: AuditLog = new InMemoryAuditLog(), onError?: (operation: string, error: unknown) => void) {
  let minted = 0;
  return new AuditRecorder(log, {
    now: () => new Date('2026-08-04T09:00:00.000Z'),
    newId: () => {
      minted += 1;
      return `event-${String(minted)}`;
    },
    ...(onError != null ? { onError } : {}),
  });
}

describe('recording an act', () => {
  it('writes who did what, and nothing about how it went, when it worked', async () => {
    const log = new InMemoryAuditLog();
    const act = recorder(log).begin('attestation.record', WHO);

    await act.performed({ kind: 'control', id: 'OE-02-04' });

    const [event] = (await log.search()).events;
    expect(event).toMatchObject({
      id: 'event-1',
      actor: 'priya@example.com',
      executionMode: 'on-behalf-of-user',
      action: 'attestation.record',
      outcome: 'performed',
      target: { kind: 'control', id: 'OE-02-04' },
    });
    // No reason on a success. "It worked" needs no explanation and a column of them is noise.
    expect(event).not.toHaveProperty('reason');
  });

  it('stamps the instant the act began rather than the one it ended', async () => {
    const log = new InMemoryAuditLog();
    const act = recorder(log).begin('scan.start', WHO);

    await act.performed();

    expect((await log.search()).events[0]?.at.toISOString()).toBe('2026-08-04T09:00:00.000Z');
  });

  it('carries the correlation so one run reads as one story', async () => {
    const log = new InMemoryAuditLog();
    const made = recorder(log);
    await made.begin('scan.start', WHO, { correlation: 'scan-7' }).performed({ kind: 'scan', id: 'scan-7' });
    await made.begin('export.scan', WHO, { correlation: 'scan-7' }).performed({ kind: 'scan', id: 'scan-7' });
    await made.begin('scan.cancel', WHO).performed();

    expect((await log.search({ correlation: 'scan-7' })).events.map((one) => one.action)).toEqual([
      'export.scan',
      'scan.start',
    ]);
  });

  it('records a failure with the error class and never its message', async () => {
    const log = new InMemoryAuditLog();
    class DefinitionConflict extends Error {}
    const act = recorder(log).begin('definition.revise', WHO);

    // Stands in for what a driver actually puts in a message here — a connection string, with the
    // password in it — which is not written literally because the repository's own secret scanner
    // reads a test fixture the same way it reads a mistake, and it is right to.
    await act.failed(new DefinitionConflict('rejected the write from CONFIDENTIAL@host'), {
      kind: 'definition',
      id: 'def-1',
    });

    const [event] = (await log.search()).events;
    expect(event?.outcome).toBe('failed');
    expect(event?.reason).toBe('DefinitionConflict');
    expect(JSON.stringify(event)).not.toContain('CONFIDENTIAL');
  });

  it('is closed once, so work after the outcome cannot record a second one', async () => {
    const log = new InMemoryAuditLog();
    const act = recorder(log).begin('definition.create', WHO);

    await act.performed({ kind: 'definition', id: 'def-1' });
    // What the route does when the tidying after a successful create throws.
    await act.failed(new Error('discarding the draft failed'));

    const { events } = await log.search();
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('performed');
  });

  it('carries a target named when the act opened into whichever outcome it reaches', async () => {
    const log = new InMemoryAuditLog();
    const act = recorder(log).begin('definition.archive', WHO, { target: { kind: 'definition', id: 'def-9' } });

    // The route knew what it was acting on from the URL, before it knew the id was unknown.
    await act.failed('unknown-definition');

    expect((await log.search()).events[0]).toMatchObject({
      outcome: 'failed',
      reason: 'unknown-definition',
      target: { kind: 'definition', id: 'def-9' },
    });
  });

  it('lets an outcome name a target of its own, over the one the act opened with', async () => {
    const log = new InMemoryAuditLog();
    const act = recorder(log).begin('definition.create', WHO, { target: { kind: 'draft', id: 'draft-1' } });

    await act.performed({ kind: 'definition', id: 'def-1' });

    expect((await log.search()).events[0]?.target).toEqual({ kind: 'definition', id: 'def-1' });
  });

  it('records a refusal with the kind of refusal it was', async () => {
    const log = new InMemoryAuditLog();

    await recorder(log).refused('decision.record', WHO, 'not-a-member', { kind: 'control', id: 'REL-01-01' });

    expect((await log.search()).events[0]).toMatchObject({
      action: 'decision.record',
      outcome: 'refused',
      reason: 'not-a-member',
      target: { kind: 'control', id: 'REL-01-01' },
    });
  });
});

/*
 * The net that closes an act nothing else closed.
 *
 * Worth its own tests rather than being left to the route suites, because the case it exists for is
 * the case nobody wrote a route for: an early return on a path the author did not think about. A
 * route test can only exercise the paths that exist today.
 */
describe('closing an act with the response', () => {
  /** Enough of an Express response to end. `once` is all `closedWhenAnswered` reaches for. */
  function answering(statusCode: number): { readonly response: Answered; end(): void } {
    const listeners: (() => void)[] = [];
    return {
      response: {
        statusCode,
        once: (_event: 'close', listener: () => void) => listeners.push(listener),
      },
      end: () => listeners.forEach((listener) => listener()),
    };
  }

  it('records what the handler forgot, as performed when the route answered', async () => {
    const log = new InMemoryAuditLog();
    const answer = answering(200);
    closedWhenAnswered(recorder(log).begin('scope.preview', WHO), answer.response);

    // The handler returns without closing, which is what a `return` after a `response.json` does.
    answer.end();
    await vi.waitFor(async () => expect((await log.search()).events).toHaveLength(1));

    expect((await log.search()).events[0]).toMatchObject({ action: 'scope.preview', outcome: 'performed' });
  });

  it('records a 4xx the handler returned from as failed, naming the status it could see', async () => {
    const log = new InMemoryAuditLog();
    const answer = answering(409);
    closedWhenAnswered(recorder(log).begin('definition.revise', WHO), answer.response);

    answer.end();
    await vi.waitFor(async () => expect((await log.search()).events).toHaveLength(1));

    // `http-409` rather than a word about what conflicted, which is all the response can know — and
    // the sign that a route should be naming its own reason at that return.
    expect((await log.search()).events[0]).toMatchObject({ outcome: 'failed', reason: 'http-409' });
  });

  it('leaves an act the handler closed alone, so the reason it chose survives', async () => {
    const log = new InMemoryAuditLog();
    const answer = answering(404);
    const act = closedWhenAnswered(recorder(log).begin('definition.archive', WHO), answer.response);

    await act.failed('unknown-definition');
    answer.end();

    const { events } = await log.search();
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe('unknown-definition');
  });
});

describe('when the log cannot be written to', () => {
  const broken: AuditLog = {
    durable: true,
    append: () => Promise.reject(new Error('the database is unreachable')),
    head: () => Promise.reject(new Error('the database is unreachable')),
    floor: () => Promise.resolve(undefined),
    search: () => Promise.reject(new Error('the database is unreachable')),
    verify: () => Promise.reject(new Error('the database is unreachable')),
  };

  it('does not fail the act, because the act already happened', async () => {
    const act = recorder(broken).begin('attestation.record', WHO);

    await expect(act.performed({ kind: 'control', id: 'OE-02-04' })).resolves.toBeUndefined();
  });

  it('counts what it could not record, and says what was lost', async () => {
    const said: string[] = [];
    const made = recorder(broken, (operation) => said.push(operation));

    await made.begin('scan.start', WHO).performed();
    await made.refused('decision.record', WHO, 'not-a-member');

    expect(made.unrecorded).toBe(2);
    // The operation names the act rather than the mechanism, because the reader of this line is
    // trying to find out what is missing from the log.
    expect(said[0]).toBe('record that priya@example.com performed scan.start');
    expect(said[1]).toBe('record that priya@example.com refused decision.record');
  });

  it('starts at nothing lost, so the count means what it says', () => {
    expect(recorder(broken).unrecorded).toBe(0);
  });
});

describe('an install that refuses an act it cannot record', () => {
  const broken: AuditLog = {
    durable: true,
    append: () => Promise.reject(new Error('the database is unreachable')),
    head: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.4:5432')),
    floor: () => Promise.resolve(undefined),
    search: () => Promise.reject(new Error('the database is unreachable')),
    verify: () => Promise.reject(new Error('the database is unreachable')),
  };

  function strict(log: AuditLog, onError?: (operation: string, error: unknown) => void) {
    return new AuditRecorder(log, { posture: 'strict', ...(onError != null ? { onError } : {}) });
  }

  it('refuses before the act, so the act does not happen', async () => {
    await expect(strict(broken).refuseIfUnrecordable()).rejects.toBeInstanceOf(TrailUnwritableError);
  });

  it('names the trail as the reason, because a refusal that reads as permission sends them to the wrong place', async () => {
    const refusal = await strict(broken)
      .refuseIfUnrecordable()
      .catch((cause: unknown) => cause);

    expect(refusal).toBeInstanceOf(TrailUnwritableError);
    expect((refusal as Error).message).toContain('audit trail');
    // Not the driver's words. This message reaches a caller, and the thing that failed reported an
    // address — the same rule `event.ts` states for a row applies to a response about one.
    expect((refusal as Error).message).not.toContain('ECONNREFUSED');
    expect((refusal as Error).message).not.toContain('10.0.0.4');
  });

  it('tells the operator, since the one refusal it would most like to record is the one it cannot', async () => {
    const said: string[] = [];
    await strict(broken, (operation) => said.push(operation))
      .refuseIfUnrecordable()
      .catch(() => undefined);

    expect(said).toEqual(['reach the trail, so the action was refused']);
  });

  it('allows the act when the trail answers', async () => {
    await expect(strict(new InMemoryAuditLog()).refuseIfUnrecordable()).resolves.toBeUndefined();
  });

  it('still counts a record that fails after the trail answered, rather than failing a change already made', async () => {
    // The residual the check cannot close: reachable to read, and the insert fails anyway. By this
    // point the act has happened, so refusing the response would report a change that is in the
    // database as having failed — which is the order the amendment to ADR 0046 rejects.
    const readable: AuditLog = { ...broken, head: () => Promise.resolve({ sequence: 0, digest: GENESIS }) };
    const made = strict(readable);

    await expect(made.refuseIfUnrecordable()).resolves.toBeUndefined();
    await expect(made.begin('attestation.record', WHO).performed()).resolves.toBeUndefined();
    expect(made.unrecorded).toBe(1);
  });

  it('counts a gate refusal it could not write, which the check never had a chance to prevent', async () => {
    // The other way a strict install accrues a count, and the reason the health surface names two.
    // A refusal happens inside the gate *before* `refuseIfUnrecordable` — there is nobody holding an
    // act, and the caller is being turned away rather than allowed to act — so this path reaches a
    // broken trail with no head read in front of it. It must still not throw: the caller is already
    // being refused, and a second failure on top would answer a 403 with a 503.
    const made = strict(broken);

    await expect(made.refused('decision.record', WHO, 'not-a-member')).resolves.toBeUndefined();
    expect(made.unrecorded).toBe(1);
  });

  it('does not ask the trail anything on the posture that would not refuse either way', async () => {
    // Not a micro-optimisation. Every mutation passes through this, so a probe on the default posture
    // would be a round trip per change bought by installs that had not asked for it.
    const asked = vi.fn(() => Promise.resolve({ sequence: 0, digest: GENESIS }));

    await recorder({ ...broken, head: asked }).refuseIfUnrecordable();

    expect(asked).not.toHaveBeenCalled();
  });
});

describe('which posture an install is in', () => {
  it('is record-and-continue unless something says otherwise', () => {
    expect(new AuditRecorder(new InMemoryAuditLog()).posture).toBe('record-and-continue');
    expect(postureFrom({})).toBe('record-and-continue');
  });

  it('is strict on exactly 1', () => {
    expect(postureFrom({ WAF_AUDIT_STRICT: '1' })).toBe('strict');
    expect(postureFrom({ WAF_AUDIT_STRICT: ' 1 ' })).toBe('strict');
  });

  it('reads anything else as off, including the values that look like on', () => {
    // `0` and `false` read as off to a person, so they have to read as off here — a setting that
    // enabled itself on `false` would be a misconfiguration nobody looks for, because the operator
    // believes they have already turned it off. `true` is refused for the same reason in reverse: it
    // would be somebody expressing an intention the app quietly did not act on.
    for (const value of ['0', 'false', 'true', 'yes', 'on', '', '  ']) {
      expect(postureFrom({ WAF_AUDIT_STRICT: value })).toBe('record-and-continue');
    }
  });

  it('is reported by the recorder enforcing it, not by a second reading of the environment', () => {
    expect(new AuditRecorder(new InMemoryAuditLog(), { posture: 'strict' }).posture).toBe('strict');
  });
});

describe('the reason a failure is recorded with', () => {
  it("prefers a refusal kind, which is this app's own vocabulary", () => {
    expect(reasonFor(new NotPermittedError('membership-unknown', 'a paragraph for the person refused'))).toBe(
      'membership-unknown'
    );
  });

  it('falls back to the class name', () => {
    class ScanInProgressError extends Error {}
    expect(reasonFor(new ScanInProgressError())).toBe('ScanInProgressError');
    expect(reasonFor(new Error('anything'))).toBe('Error');
  });

  it('takes a bare word as the reason, which is how a route names its own refusals', () => {
    expect(reasonFor('replayed')).toBe('replayed');
    expect(reasonFor('too-large')).toBe('too-large');
  });

  it('refuses a name that is not one, so a thrown value cannot write prose into a row', () => {
    // A crafted `kind`, which is what a `throw` of a plain object looks like from here. The prose is
    // rejected and what is left is the value's real class, which carries nothing.
    expect(reasonFor({ kind: 'the database says: connect to postgres://host' })).toBe('Object');
    expect(reasonFor({ constructor: { name: 'a sentence with spaces' } })).toBe('unknown');
    expect(reasonFor('a whole sentence, which is not a reason')).toBe('unknown');
    expect(reasonFor(undefined)).toBe('unknown');
    expect(reasonFor(null)).toBe('unknown');
  });
});
