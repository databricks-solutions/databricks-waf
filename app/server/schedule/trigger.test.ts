import { describe, expect, it } from 'vitest';
import type { JobRun, Workspace } from './port';
import { JOB_NAME } from './schedule';
import { trigger } from './trigger';

function client(answers: { readonly jobId?: number; readonly active?: readonly JobRun[]; readonly startedAs?: number }) {
  const asked: Record<string, unknown>[] = [];

  const workspace: Workspace = {
    jobs: {
      // eslint-disable-next-line @typescript-eslint/require-await -- an async generator, as the SDK returns.
      list: async function* (request) {
        asked.push({ call: 'list', ...request });
        if (answers.jobId != null) yield { job_id: answers.jobId, settings: { name: JOB_NAME } };
      },
      get: () => Promise.resolve({}),
      // eslint-disable-next-line @typescript-eslint/require-await
      listRuns: async function* (request) {
        asked.push({ call: 'listRuns', ...request });
        yield* answers.active ?? [];
      },
      runNow: (request) => {
        asked.push({ call: 'runNow', ...request });
        return Promise.resolve({ run_id: answers.startedAs ?? 1 });
      },
      // Unused by `trigger`, which starts a run rather than explaining a finished one. Present because
      // the port is the app's whole contract with the Jobs API and a fake of it is checked against all
      // of it — which is how a call one module grows gets noticed by the other's tests.
      getRun: () => Promise.resolve({}),
      getRunOutput: () => Promise.resolve({}),
    },
  };

  return { asked, client: () => Promise.resolve(workspace) };
}

describe('starting the scheduled job by hand', () => {
  it('starts it and reports the run as waiting rather than running', async () => {
    const { client: workspace, asked } = client({ jobId: 471, startedAs: 1024 });
    const result = await trigger({ client: workspace, actor: 'priya@example.com' });

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ run: { runId: '1024', state: 'waiting', trigger: 'hand' } });
    // `run-now` returns as soon as the run is accepted, and serverless takes minutes to start. Saying
    // "running" would have the surface claim the estate is being read when nothing has touched it.
    expect(asked.find((call) => call.call === 'runNow')).toMatchObject({ job_id: 471 });
  });

  it('refuses where the schedule was never deployed, saying it is optional', async () => {
    const { client: workspace, asked } = client({});
    const result = await trigger({ client: workspace, actor: 'priya@example.com' });

    expect(result).toMatchObject({ error: 'no-such-job', status: 409 });
    expect(result.error != null && result.message).toContain('optional half of the bundle');
    // And nothing was started.
    expect(asked.some((call) => call.call === 'runNow')).toBe(false);
  });

  it('refuses a second run while one is going, rather than letting the platform skip it', async () => {
    // The job takes one at a time, and the platform's way of saying so is a run that lands as SKIPPED
    // — which would then sit in the history the app reads to decide whether the cadence is healthy.
    const { client: workspace, asked } = client({
      jobId: 471,
      active: [{ run_id: 999, start_time: Date.parse('2026-08-07T04:18:58Z') }],
    });
    const result = await trigger({ client: workspace, actor: 'priya@example.com' });

    expect(result).toMatchObject({ error: 'already-running', status: 409 });
    expect(asked.some((call) => call.call === 'runNow')).toBe(false);
  });

  it('points at the run in the list rather than naming an id and an instant nobody can match', async () => {
    // Both were in this message and both were measured as wrong for a reader: a bare fifteen-digit id and
    // a raw ISO timestamp with milliseconds, sitting above a list that rendered the same run as a short
    // local time. The list has the run and a link to it.
    const { client: workspace } = client({
      jobId: 471,
      active: [{ run_id: 533795292185972, start_time: Date.parse('2026-08-07T04:43:53.562Z') }],
    });
    const result = await trigger({ client: workspace, actor: 'priya@example.com' });

    expect(result.error != null && result.message).toContain('newest run listed here');
    expect(result.error != null && result.message).not.toContain('533795292185972');
    expect(result.error != null && result.message).not.toContain('2026-08-07T04:43:53');
  });

  it('asks only for active runs, so an old failure does not read as one in flight', async () => {
    const { client: workspace, asked } = client({ jobId: 471 });
    await trigger({ client: workspace, actor: 'priya@example.com' });

    expect(asked.find((call) => call.call === 'listRuns')).toMatchObject({ active_only: true, job_id: 471 });
  });

  it('refuses on the presence of an active run, without needing it to have a start time', async () => {
    const { client: workspace } = client({ jobId: 471, active: [{ run_id: 999 }] });
    const result = await trigger({ client: workspace, actor: 'priya@example.com' });

    expect(result).toMatchObject({ error: 'already-running' });
  });
});
