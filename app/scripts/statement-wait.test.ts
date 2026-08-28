// What the measurement scripts' shared wait has to get right.
//
// The behaviour under test is the one that cost three hours of a shared estate and was invisible in
// two write-ups before anyone noticed it: a script that stops polling leaves the warehouse working.
// It is asserted here rather than trusted because the failure has no symptom on the client — the
// script exits cleanly, the recording says `unfinished`, and the only place the truth appears is a
// query history nobody reads until the next measurement.

import { describe, expect, it, vi } from 'vitest';
import { abandoned, settled, type Settling } from './statement-wait.mjs';

const RUNNING: Settling = { statement_id: 's-1', status: { state: 'RUNNING' } };
const DONE: Settling = { statement_id: 's-1', status: { state: 'SUCCEEDED' } };

describe('waiting for a statement', () => {
  it('polls until the statement settles and asks the warehouse for nothing more', async () => {
    const call = vi.fn().mockResolvedValueOnce(RUNNING).mockResolvedValueOnce(DONE);

    const response = await settled(RUNNING, { call, polls: 10, pollIntervalMs: 0 });

    expect(response.status?.state).toBe('SUCCEEDED');
    expect(call.mock.calls.map(([path]) => String(path))).toEqual([
      '/api/2.0/sql/statements/s-1',
      '/api/2.0/sql/statements/s-1',
    ]);
  });

  it('cancels the statement when it runs out of polls, and says the warehouse took it', async () => {
    const call = vi.fn().mockImplementation((path: string) => {
      if (path.endsWith('/cancel')) return Promise.resolve({});
      return Promise.resolve(RUNNING);
    });

    const response = await settled(RUNNING, { call, polls: 2, pollIntervalMs: 0 });

    // The statement is handed back still running rather than thrown, because every caller already
    // has a branch for a state that is not SUCCEEDED and two of them read this status as text.
    expect(response.status?.state).toBe('RUNNING');
    expect(response.cancelled).toBe(true);
    expect(call).toHaveBeenCalledWith('/api/2.0/sql/statements/s-1/cancel', { method: 'POST' });
  });

  it('does not claim the statement was stopped when the cancellation was refused', async () => {
    const call = vi.fn().mockImplementation((path: string) => {
      if (path.endsWith('/cancel')) return Promise.reject(new Error('500'));
      return Promise.resolve(RUNNING);
    });

    const response = await settled(RUNNING, { call, polls: 1, pollIntervalMs: 0 });

    expect(response.cancelled).toBe(false);
    expect(abandoned(response, 300)).toContain('could not confirm');
  });

  it('says nothing about a statement that finished', () => {
    expect(abandoned(DONE, 300)).toBeNull();
  });
});
