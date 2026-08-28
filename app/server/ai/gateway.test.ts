import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TOKEN_BUDGET,
  ENDPOINT_ENV,
  INITIAL_CONCURRENCY,
  RateLimitedError,
  TOKEN_BUDGET_ENV,
  openGateway,
} from './gateway.js';

const instant = () => Promise.resolve();

function gateway(
  invoke: (prompt: string) => Promise<{ text: string; tokens: number }>,
  env: Record<string, string> = { [ENDPOINT_ENV]: 'databricks-gpt' }
) {
  return openGateway({ env, invoke, sleep: instant });
}

describe('the AI gateway', () => {
  it('is off when no endpoint is named, and does not call the model', async () => {
    const invoke = vi.fn();
    const closed = openGateway({ env: {}, invoke, sleep: instant });
    expect(closed.available).toBe(false);
    expect(await closed.complete({ digest: 'p1', prompt: 'hello' })).toEqual({ kind: 'disabled' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('is off when an endpoint is named but no invoke was given, so a miswired install is silent', async () => {
    const closed = openGateway({ env: { [ENDPOINT_ENV]: 'databricks-gpt' }, sleep: instant });
    expect(closed.available).toBe(false);
    expect(await closed.complete({ digest: 'p1', prompt: 'hello' })).toEqual({ kind: 'disabled' });
  });

  it('returns the model text and counts the tokens against the budget', async () => {
    const open = gateway(() => Promise.resolve({ text: 'because the table is empty', tokens: 12 }));
    expect(open.available).toBe(true);
    expect(open.remaining).toBe(DEFAULT_TOKEN_BUDGET);
    const first = await open.complete({ digest: 'p1', prompt: 'why?' });
    expect(first).toEqual({ kind: 'ok', text: 'because the table is empty', tokensUsed: 12 });
    expect(open.remaining).toBe(DEFAULT_TOKEN_BUDGET - 12);
  });

  it('replays a cached explanation without calling the model again', async () => {
    const invoke = vi.fn(() => Promise.resolve({ text: 'cached once', tokens: 8 }));
    const open = gateway(invoke);
    const first = await open.complete({ digest: 'same', prompt: 'first wording' });
    const second = await open.complete({ digest: 'same', prompt: 'different wording, same packet' });
    expect(first.cached).toBeUndefined();
    expect(second).toEqual({ kind: 'ok', text: 'cached once', tokensUsed: 8, cached: true });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(open.remaining).toBe(DEFAULT_TOKEN_BUDGET - 8);
  });

  it('refuses further completions once the budget is spent', async () => {
    const invoke = vi.fn(() => Promise.resolve({ text: 'one', tokens: 10 }));
    const open = gateway(invoke, { [ENDPOINT_ENV]: 'databricks-gpt', [TOKEN_BUDGET_ENV]: '10' });
    expect(await open.complete({ digest: 'a', prompt: 'a' })).toMatchObject({ kind: 'ok' });
    expect(await open.complete({ digest: 'b', prompt: 'b' })).toEqual({ kind: 'budget' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('backs off on 429, halves concurrency, and still returns the answer', async () => {
    let calls = 0;
    const open = gateway(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new RateLimitedError());
      return Promise.resolve({ text: 'after a wait', tokens: 3 });
    });
    expect(open.concurrency).toBe(INITIAL_CONCURRENCY);
    expect(await open.complete({ digest: 'p', prompt: 'q' })).toMatchObject({
      kind: 'ok',
      text: 'after a wait',
    });
    expect(open.concurrency).toBe(1);
    expect(calls).toBe(2);
  });

  it('gives up as rate-limited after three 429s rather than hanging', async () => {
    const open = gateway(() => Promise.reject(new RateLimitedError()));
    expect(await open.complete({ digest: 'p', prompt: 'q' })).toEqual({ kind: 'rate-limited' });
    expect(open.concurrency).toBe(1);
  });

  it('reports a failed invoke as failed, not as a verdict', async () => {
    const open = gateway(() => Promise.reject(new Error('endpoint gone')));
    expect(await open.complete({ digest: 'p', prompt: 'q' })).toEqual({ kind: 'failed' });
  });
});
