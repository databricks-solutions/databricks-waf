import { describe, expect, it, vi } from 'vitest';
import { PlanFetcher, PlanHttpError } from './fetch.js';
import { CollectionScheduler } from '../../../scan/scheduler.js';
import { classify } from '../../../scan/errors.js';

function fetcher(doFetch: typeof globalThis.fetch): PlanFetcher {
  return new PlanFetcher({
    host: 'https://example.cloud.databricks.com/',
    token: () => Promise.resolve('t-1'),
    fetch: doFetch,
  });
}

/** The rejection, typed, so a test reads its status without asserting the union away each time. */
async function thrown(doFetch: typeof globalThis.fetch): Promise<PlanHttpError> {
  try {
    await fetcher(doFetch).plan('x');
  } catch (error) {
    return error as PlanHttpError;
  }
  throw new Error('expected the fetch to reject');
}

function respond(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('PlanFetcher', () => {
  it('asks for the rung the ladder ends at, on the statement it was given', async () => {
    const doFetch = vi.fn().mockResolvedValue(respond({ plans_state: 'EXISTS' }));
    await fetcher(doFetch).plan('01ef-abc');

    const [url, init] = doFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://example.cloud.databricks.com/api/2.0/sql/history/queries/01ef-abc?include_plans=true'
    );
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t-1');
  });

  it('does not double the slash when the host carries a trailing one', async () => {
    const doFetch = vi.fn().mockResolvedValue(respond({ plans_state: 'EXISTS' }));
    await fetcher(doFetch).plan('a');
    expect(doFetch.mock.calls[0]?.[0]).not.toContain('.com//api');
  });

  it('escapes a statement id rather than pasting it into the path', async () => {
    const doFetch = vi.fn().mockResolvedValue(respond({ plans_state: 'EXISTS' }));
    await fetcher(doFetch).plan('a/../b?x=1');
    const url = doFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain('/queries/a%2F..%2Fb%3Fx%3D1?include_plans=true');
  });

  it('returns a 404 rather than throwing, because it is the expected answer', async () => {
    const doFetch = vi.fn().mockResolvedValue(respond('', { status: 404 }));
    const response = await fetcher(doFetch).plan('gone');
    expect(response).toEqual({ status: 404, body: null });
  });

  it('returns a 200 with its parsed body', async () => {
    const body = { plans_state: 'EXISTS', plans: { '0': { nodes: [] } } };
    const doFetch = vi.fn().mockResolvedValue(respond(body));
    const response = await fetcher(doFetch).plan('here');
    expect(response).toEqual({ status: 200, body });
  });

  it('treats a 200 that is not JSON as a body it could not read, not as a throw', async () => {
    // A platform change should degrade to `unknown-state` in the parser, not take a run down.
    const doFetch = vi.fn().mockResolvedValue(respond('<html>maintenance</html>'));
    const response = await fetcher(doFetch).plan('odd');
    expect(response).toEqual({ status: 200, body: null });
  });

  it.each([401, 403, 429, 500, 503])('throws with the status kept for %i', async (status) => {
    const doFetch = vi.fn().mockResolvedValue(respond('{"message":"no"}', { status }));
    await expect(fetcher(doFetch).plan('x')).rejects.toMatchObject({
      name: 'PlanHttpError',
      status,
    });
  });

  it('keeps Retry-After so the scheduler sleeps on the server figure rather than its own', async () => {
    const doFetch = vi
      .fn()
      .mockResolvedValue(respond('{}', { status: 429, headers: { 'Retry-After': '17' } }));
    const error = await thrown(doFetch);

    expect(error.retryAfterSeconds).toBe(17);
    // The reason it is kept at all: `classify` is what reads it, and it has to survive the trip.
    expect(classify(error)).toMatchObject({ kind: 'rate-limited', retryAfterMs: 17_000 });
  });

  it('ignores a Retry-After that is not a number', async () => {
    const doFetch = vi
      .fn()
      .mockResolvedValue(respond('{}', { status: 429, headers: { 'Retry-After': 'soon' } }));
    const error = await thrown(doFetch);
    expect(error.retryAfterSeconds).toBeUndefined();
  });

  it('trims a long error body instead of putting it all in the message', async () => {
    const doFetch = vi.fn().mockResolvedValue(respond('x'.repeat(5000), { status: 500 }));
    const error = await thrown(doFetch);
    expect(error.message.length).toBeLessThan(320);
    expect(error.message).toContain('…');
  });

  it('fetches a fresh token per call, since a scheduled run outlives one', async () => {
    // A fresh Response per call: a body can only be read once, so a shared mock resolves the second
    // call to an already-drained body and fails for a reason that is about the test, not the fetcher.
    const doFetch = vi.fn().mockImplementation(() => Promise.resolve(respond({ plans_state: 'EXISTS' })));
    const tokens = ['first', 'second'];
    const subject = new PlanFetcher({
      host: 'https://h',
      token: () => Promise.resolve(tokens.shift() ?? 'exhausted'),
      fetch: doFetch,
    });
    await subject.plan('a');
    await subject.plan('b');
    const auth = doFetch.mock.calls.map((call) => (call[1] as RequestInit).headers as Record<string, string>);
    expect(auth.map((headers) => headers.Authorization)).toEqual(['Bearer first', 'Bearer second']);
  });
});

describe('the plans surface is the retrying layer', () => {
  // The point of this file's sibling change to `surfaces.ts`, pinned because it is invisible otherwise:
  // every other surface declares `clientRetries: true` on the strength of an SDK underneath it, and
  // there is no SDK under a plan fetch. Were `plans` to declare true, a 429 would fail on first sight
  // and `Retry-After` would be read and never slept on.
  it('retries a throttled plan fetch, where a rest-surface call would not', async () => {
    const scheduler = new CollectionScheduler({
      warehouse: 'shared',
      sleep: () => Promise.resolve(),
      random: () => 1,
    });

    const attempts = { plans: 0, rest: 0 };
    for (const surface of ['plans', 'rest'] as const) {
      await scheduler.run({
        surface,
        label: `${surface}-throttled`,
        run: () => {
          attempts[surface] += 1;
          return Promise.reject(new PlanHttpError(429, 'slow down', 1));
        },
      });
    }

    expect(attempts.plans).toBeGreaterThan(1);
    expect(attempts.rest).toBe(1);
  });

  it('never retries a 403, on either surface', async () => {
    const scheduler = new CollectionScheduler({
      warehouse: 'shared',
      sleep: () => Promise.resolve(),
      random: () => 1,
    });
    let attempts = 0;
    const outcome = await scheduler.run({
      surface: 'plans',
      label: 'denied',
      run: () => {
        attempts += 1;
        return Promise.reject(new PlanHttpError(403, 'nope'));
      },
    });
    expect(attempts).toBe(1);
    expect(outcome.status).toBe('skipped');
  });
});
