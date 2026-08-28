// What the statement executor has to get right.
//
// This code exists because the intended route through AppKit's analytics plugin is
// broken for programmatic on-behalf-of use, so it is the only thing standing between a
// scan and the warehouse. The cases below are the ones whose failure modes are silent:
// a positional row mapped to the wrong column reads like a real measurement, and a
// throttle mistaken for a permission denial makes the scan give up when it should wait.

import { sql } from '@databricks/appkit';
import { describe, expect, it, vi } from 'vitest';
import { classify, isDegradation, RETRYABLE } from '../../scan/errors.js';
import {
  StatementDeadlineError,
  StatementExecutor,
  StatementFailedError,
  StatementHttpError,
} from './statements.js';

const PARAMS = { lookback_days: sql.int(30), workspace_id: sql.string('123') };

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function succeeded(columns: readonly string[], rows: readonly (readonly (string | null)[])[]) {
  return {
    statement_id: 's-1',
    status: { state: 'SUCCEEDED' },
    manifest: { schema: { columns: columns.map((name) => ({ name })) } },
    result: { data_array: rows },
  };
}

function executor(fetch: typeof globalThis.fetch, pollIntervalMs = 0) {
  return new StatementExecutor({
    host: 'https://example.cloud.databricks.com/',
    warehouseId: 'wh-1',
    token: () => Promise.resolve('t-1'),
    fetch,
    pollIntervalMs,
  });
}

describe('submitting a statement', () => {
  it('sends the parameters with the types the markers carry', async () => {
    const fetch = vi.fn().mockResolvedValue(json(succeeded(['a'], [['1']])));
    await executor(fetch).query('SELECT 1', PARAMS);

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.cloud.databricks.com/api/2.0/sql/statements');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.warehouse_id).toBe('wh-1');
    expect(body.parameters).toEqual([
      { name: 'lookback_days', value: '30', type: 'INT' },
      { name: 'workspace_id', value: '123', type: 'STRING' },
    ]);
    // Anything else caches or streams, and collection wants neither.
    expect(body.disposition).toBe('INLINE');
    expect(body.format).toBe('JSON_ARRAY');
    // Under the 25 MiB inline cap, so an oversized result is trimmed and flagged rather than refused
    // outright. Without this the statement comes back FAILED with no rows at all, which is how a large
    // estate came to get no serverless analysis instead of a smaller one — and a flag is something the
    // sliced path can act on by asking again in pieces.
    expect(body.byte_limit).toBeLessThan(25 * 1024 * 1024);
    expect(body.byte_limit).toBeGreaterThan(0);
  });

  /*
   * Marked as ours, twice, so the workload advisor can leave the tool out of the estate it describes.
   *
   * Both marks are asserted because they cover different failures and neither is redundant. The tag is
   * the platform's mechanism and is what survives a truncated `statement_text`; the comment is what
   * covers a workspace without the tags preview, where the tag is accepted, silently discarded, and
   * recorded in the history table as `{"tags_invalid": null}` — which is how this was found.
   *
   * An array of key/value objects, not a map. A map is accepted by the API with a 200 and lands as
   * invalid, so the shape is only verifiable by reading the column back on a real workspace.
   */
  it('marks the statement as this app’s own, in the text and in the tags', async () => {
    const fetch = vi.fn().mockResolvedValue(json(succeeded(['a'], [['1']])));
    await executor(fetch).query('SELECT 1', {});

    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.statement).toBe('-- databricks-waf: assessment\nSELECT 1');
    expect(body.query_tags).toEqual([{ key: 'databricks_waf', value: 'assessment' }]);
  });

  it('reports a trimmed result as trimmed, rather than as a shorter estate', async () => {
    const fetch = vi.fn().mockResolvedValue(
      json({
        statement_id: 's-1',
        status: { state: 'SUCCEEDED' },
        manifest: { schema: { columns: [{ name: 'a' }] }, truncated: true },
        result: { data_array: [['1']] },
      })
    );

    const result = await executor(fetch).query('SELECT 1', {});

    expect(result.truncated).toBe(true);
    expect(result.data).toEqual([{ a: '1' }]);
  });

  it('leaves truncated absent on a result that was complete', async () => {
    // Absent rather than false so a caller cannot mistake "this response did not say" for "this response
    // said it was complete" — the two are the same here only because `byte_limit` is always sent.
    const fetch = vi.fn().mockResolvedValue(json(succeeded(['a'], [['1']])));

    expect((await executor(fetch).query('SELECT 1', {})).truncated).toBeUndefined();
  });

  it('authenticates with the token the credentials supply, fetched per call', async () => {
    const token = vi.fn().mockResolvedValue('t-2');
    const fetch = vi.fn().mockResolvedValue(json(succeeded([], [])));
    await new StatementExecutor({
      host: 'https://example.cloud.databricks.com',
      warehouseId: 'wh-1',
      token,
      fetch: fetch,
    }).query('SELECT 1', {});

    expect(token).toHaveBeenCalled();
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t-2');
  });
});

describe('reading the result', () => {
  it('keys each row by its column name', async () => {
    const fetch = vi.fn().mockResolvedValue(
      json(
        succeeded(
          ['workspace_id', 'clusters', 'auto_terminates'],
          [
            ['123', '4', 'true'],
            ['123', '0', 'false'],
          ]
        )
      )
    );

    const result = await executor(fetch).query('SELECT 1', {});
    expect(result.data).toEqual([
      { workspace_id: '123', clusters: '4', auto_terminates: 'true' },
      { workspace_id: '123', clusters: '0', auto_terminates: 'false' },
    ]);
  });

  it('leaves a column null rather than shifting values when a row is short', async () => {
    const fetch = vi.fn().mockResolvedValue(json(succeeded(['a', 'b', 'c'], [['1']])));
    const result = await executor(fetch).query('SELECT 1', {});
    expect(result.data).toEqual([{ a: '1', b: null, c: null }]);
  });

  it('carries the declared type of each column, because every value arrives as a string', async () => {
    // The sliced path re-sorts a concatenation itself, and it can only reproduce the warehouse's own
    // order if it knows which columns the warehouse compared as numbers. `job_id` is digits in a
    // STRING and `classic_uses` is a LONG; the values look identical.
    const fetch = vi.fn().mockResolvedValue(
      json({
        statement_id: 's-1',
        status: { state: 'SUCCEEDED' },
        manifest: {
          schema: {
            columns: [
              { name: 'job_id', type_name: 'STRING' },
              { name: 'classic_uses', type_name: 'LONG' },
            ],
          },
        },
        result: { data_array: [['9', '10']] },
      })
    );

    const result = await executor(fetch).query('SELECT 1', {});
    expect(result.columnTypes).toEqual({ job_id: 'STRING', classic_uses: 'LONG' });
  });

  it('omits the types rather than inventing them when the manifest carries none', async () => {
    const fetch = vi.fn().mockResolvedValue(json(succeeded(['a'], [['1']])));
    const result = await executor(fetch).query('SELECT 1', {});

    expect(result.columnTypes).toBeUndefined();
  });

  it('follows the chunk links to the end of the result set', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          statement_id: 's-1',
          status: { state: 'SUCCEEDED' },
          manifest: { schema: { columns: [{ name: 'a' }] } },
          result: { data_array: [['1']], next_chunk_internal_link: '/api/2.0/sql/statements/s-1/result/chunks/1' },
        })
      )
      .mockResolvedValueOnce(json({ result: { data_array: [['2']] } }));

    const result = await executor(fetch).query('SELECT 1', {});
    expect(result.data).toEqual([{ a: '1' }, { a: '2' }]);
  });
});

describe('a statement the warehouse has not finished', () => {
  it('polls until it succeeds', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ statement_id: 's-1', status: { state: 'PENDING' } }))
      .mockResolvedValueOnce(json({ statement_id: 's-1', status: { state: 'RUNNING' } }))
      .mockResolvedValueOnce(json(succeeded(['a'], [['1']])));

    const result = await executor(fetch).query('SELECT 1', {});
    expect(result.data).toEqual([{ a: '1' }]);
    expect(fetch.mock.calls[1]?.[0]).toBe('https://example.cloud.databricks.com/api/2.0/sql/statements/s-1');
  });

  it('cancels the statement on the warehouse when the scan is abandoned', async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/cancel')) return Promise.resolve(json({}));
      controller.abort();
      return Promise.resolve(json({ statement_id: 's-1', status: { state: 'RUNNING' } }));
    });

    await expect(
      executor(fetch, 50).query('SELECT 1', {}, controller.signal)
    ).rejects.toThrow(/cancelled/i);

    // The point of cancelling: an abandoned scan must not leave work running on a
    // customer's warehouse.
    const cancelled = fetch.mock.calls.some(([url]) => String(url).endsWith('/api/2.0/sql/statements/s-1/cancel'));
    expect(cancelled).toBe(true);
  });

  /*
   * The loop had no bound at all until `74`, and `61a` measured what that cost: 67 minutes of one
   * scan on one statement, with nothing short of cancelling the whole scan able to end it.
   *
   * Both halves are asserted here because they are separable and each is useless alone. A deadline
   * that does not cancel leaves an hour of the customer's compute producing an answer nobody will
   * read; a cancel with no deadline is the path above, which only an operator can reach.
   */
  it('stops waiting at its deadline and cancels what it stopped waiting for', async () => {
    const fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/cancel')) return Promise.resolve(json({}));
      return Promise.resolve(json({ statement_id: 's-1', status: { state: 'RUNNING' } }));
    });

    const failure = await new StatementExecutor({
      host: 'https://example.cloud.databricks.com/',
      warehouseId: 'wh-1',
      token: () => Promise.resolve('t-1'),
      fetch,
      pollIntervalMs: 1,
      deadlineMs: 20,
    })
      .query('SELECT 1', {})
      .catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(StatementDeadlineError);
    expect((failure as StatementDeadlineError).cancelled).toBe(true);
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/api/2.0/sql/statements/s-1/cancel'))).toBe(true);

    // What the scan does about it, which is the whole reason this has a class of its own. Read as a
    // timeout it would halve the warehouse's concurrency and — once `36t` turns the scheduler's
    // retries on for `sql` — spend the deadline a second time on the same statement.
    const classified = classify(failure);
    expect(classified.kind).toBe('deadline');
    expect(RETRYABLE).not.toContain(classified.kind);
    expect(isDegradation(classified.kind)).toBe(false);
  });

  it('says it could not confirm the cancellation when the warehouse refuses it', async () => {
    const fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/cancel')) return Promise.resolve(json({ message: 'nope' }, { status: 500 }));
      return Promise.resolve(json({ statement_id: 's-1', status: { state: 'RUNNING' } }));
    });

    const failure = (await new StatementExecutor({
      host: 'https://example.cloud.databricks.com/',
      warehouseId: 'wh-1',
      token: () => Promise.resolve('t-1'),
      fetch,
      pollIntervalMs: 1,
      deadlineMs: 20,
    })
      .query('SELECT 1', {})
      .catch((cause: unknown) => cause)) as StatementDeadlineError;

    // A sentence a reader acts on: "cancelled it" and "stopped waiting for it" are different facts
    // about their warehouse, and only one of them is true here.
    expect(failure.cancelled).toBe(false);
    expect(failure.message).toContain('could not confirm');
  });
});

describe('when the request fails', () => {
  it('keeps the status and Retry-After so the scheduler can back off', async () => {
    const fetch = vi.fn().mockResolvedValue(
      json({ message: 'Too many requests' }, { status: 429, headers: { 'retry-after': '7' } })
    );

    const failure = await executor(fetch)
      .query('SELECT 1', {})
      .catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(StatementHttpError);
    const http = failure as StatementHttpError;
    expect(http.status).toBe(429);
    expect(http.retryAfterSeconds).toBe(7);

    // The fields exist to be read by the scheduler, so check that it does. A 429 the
    // scheduler classified as fatal would abandon the check instead of waiting.
    expect(classify(failure)).toMatchObject({ kind: 'rate-limited', retryAfterMs: 7000 });
  });

  it('reports a permission denial with the message the workspace gave', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(json({ message: 'User does not have SELECT on system.billing.usage' }, { status: 403 }));

    const failure = await executor(fetch)
      .query('SELECT 1', {})
      .catch((cause: unknown) => cause);

    expect((failure as StatementHttpError).status).toBe(403);
    expect((failure as Error).message).toContain('SELECT on system.billing.usage');
  });

  it('distinguishes a statement that ran and failed from one that was refused', async () => {
    const fetch = vi.fn().mockResolvedValue(
      json({
        statement_id: 's-1',
        status: { state: 'FAILED', error: { message: 'Table or view not found', error_code: 'TABLE_OR_VIEW_NOT_FOUND' } },
      })
    );

    const failure = await executor(fetch)
      .query('SELECT 1', {})
      .catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(StatementFailedError);
    expect((failure as StatementFailedError).errorCode).toBe('TABLE_OR_VIEW_NOT_FOUND');
  });
});
