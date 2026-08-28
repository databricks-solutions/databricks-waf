// Following a run, including one this reader did not start.
//
// Two cases these tests exist for were observed live. The first: one click on Run a scan produced
// two POSTs, the second was refused by the scan lock, and the refusal is what the reader saw — an
// error for a run that went on to succeed. The rule is that a refused start is not a failed run.
//
// The second: a run was started and the app said nothing at all, because the only thing that knew
// was the React state of the click. Everything below is about the app knowing what is happening
// from the server rather than from a click, and about the failure modes of watching not throwing
// away a good result.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiErrorMessage,
  deferEffectWork,
  definitionRequest,
  followRun,
  reviewPillarWritePath,
  type DefinitionDraft,
} from './hooks';
import type { Scan, ScanStatus } from './types';

const FAST = { whileRunningMs: 1, whileIdleMs: 1 };

interface Reply {
  readonly status?: number;
  readonly body: unknown;
}

/**
 * Answers `/api/scan/status` and `/api/scans/latest` from two scripted queues.
 *
 * An exhausted queue repeats its last reply rather than returning a default, because a default
 * would be a third behaviour the test never asked for — the first version of this stub answered an
 * empty body once the statuses ran out, which read as "not running" and quietly turned a test about
 * waiting into a test about finishing.
 */
function stubFetch(statuses: readonly Reply[], latest: readonly Reply[] = []) {
  const next = (queue: Reply[]): Reply | undefined => (queue.length > 1 ? queue.shift() : queue[0]);
  const remainingStatuses = [...statuses];
  const remainingLatest = [...latest];
  const calls: string[] = [];

  const respond = (reply: Reply | undefined): Response => {
    const chosen = reply ?? { status: 404, body: { message: 'the stub was not scripted for this call' } };
    return {
      ok: (chosen.status ?? 200) < 400,
      status: chosen.status ?? 200,
      statusText: 'stub',
      json: () => Promise.resolve(chosen.body),
    } as Response;
  };

  vi.stubGlobal('fetch', (path: string) => {
    calls.push(path);
    return Promise.resolve(respond(path.includes('/status') ? next(remainingStatuses) : next(remainingLatest)));
  });

  return calls;
}

/**
 * Follows until `enough` reports it has seen what the test is waiting for, then stops.
 *
 * Polling is a loop with no natural end, so a test that awaited it would never return. This drives
 * it to a condition and tears it down, which also means a test that fails does so by timing out on
 * a condition that never arrived rather than by asserting on a half-filled array.
 */
async function follow(enough: () => boolean, handlers: Parameters<typeof followRun>[0]): Promise<void> {
  const following = followRun(handlers, FAST);
  try {
    const deadline = Date.now() + 1000;
    while (!enough() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  } finally {
    following.stop();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('effect request ownership', () => {
  it('starts one live request across the StrictMode setup-cleanup-setup lifecycle', () => {
    vi.useFakeTimers();
    const start = vi.fn();

    // React development StrictMode performs this complete first lifecycle before leaving the current
    // task. The first setup never owns a mounted reader and must therefore reach neither fetch nor SQL.
    const cleanUpThrowawaySetup = deferEffectWork(start);
    cleanUpThrowawaySetup();
    const cleanUpMountedSetup = deferEffectWork(start);

    vi.runAllTimers();
    expect(start).toHaveBeenCalledTimes(1);

    cleanUpMountedSetup();
  });
});

describe('review pillar write paths', () => {
  it('adds the assessment scope after the complete pillar route', () => {
    expect(reviewPillarWritePath('review-1', 'cost-optimization', 'skip', 'definition-1')).toBe(
      '/api/reviews/review-1/pillars/cost-optimization/skip?definitionId=definition-1'
    );
    expect(reviewPillarWritePath('review-1', 'cost-optimization', 'answers', 'definition-1')).toBe(
      '/api/reviews/review-1/pillars/cost-optimization/answers?definitionId=definition-1'
    );
  });

  it('keeps the existing unscoped route unchanged', () => {
    expect(reviewPillarWritePath('review-1', 'reliability', 'confirm', null)).toBe(
      '/api/reviews/review-1/pillars/reliability/confirm'
    );
  });
});

describe('server eligibility errors', () => {
  it('renders both the server reason and its operator action', () => {
    expect(
      apiErrorMessage(
        {
          error: 'result-unreadable',
          message: 'legacy sentence must not replace the gate',
          eligibility: {
            eligible: false,
            state: 'unreadable',
            reason: {
              code: 'result-unreadable',
              message: 'The published report could not be read.',
              action: 'Restore the database connection and retry this exact request.',
            },
          },
        },
        'request failed'
      )
    ).toBe('The published report could not be read. Restore the database connection and retry this exact request.');
  });
});

describe('followRun', () => {
  it('reports a run nobody on this page started, which is the case the app was blind to', async () => {
    stubFetch([{ body: { running: true, actor: 'ana@example.com', callsMade: 12 } }]);

    const seen: ScanStatus[] = [];
    await follow(() => seen.length > 0, { onStatus: (status) => seen.push(status), onFinished: () => undefined });

    expect(seen[0]?.running).toBe(true);
    expect(seen[0]?.actor).toBe('ana@example.com');
    expect(seen[0]?.callsMade).toBe(12);
  });

  it('hands over the result when the run it was watching finishes', async () => {
    stubFetch([{ body: { running: true } }, { body: { running: false } }], [{ body: { id: 'scan-1' } }]);

    const finished: Scan[] = [];
    await follow(() => finished.length > 0, { onStatus: () => undefined, onFinished: (scan) => finished.push(scan) });

    expect(finished[0]?.id).toBe('scan-1');
  });

  it('does not report a result when it never saw a run, so an idle page is left alone', async () => {
    const calls = stubFetch([{ body: { running: false } }], [{ body: { id: 'scan-1' } }]);

    const finished: Scan[] = [];
    await follow(() => calls.length > 2, { onStatus: () => undefined, onFinished: (scan) => finished.push(scan) });

    // The transition is what means a new result exists. Fetching one on every idle poll would
    // replace the assessment on screen every few seconds with an identical copy of itself.
    expect(finished).toEqual([]);
    expect(calls.every((path) => path.includes('/status'))).toBe(true);
  });

  it('keeps watching through a failed status call, since that is not a finished run', async () => {
    stubFetch(
      [
        { body: { running: true } },
        { status: 503, body: { message: 'upstream is restarting' } },
        { body: { running: false } },
      ],
      [{ body: { id: 'scan-2' } }]
    );

    const finished: Scan[] = [];
    await follow(() => finished.length > 0, { onStatus: () => undefined, onFinished: (scan) => finished.push(scan) });

    // The failed poll must not read as the run ending: it would have fetched a result that was not
    // there yet and presented the previous assessment as the new one.
    expect(finished[0]?.id).toBe('scan-2');
  });

  it('says the result could not be read rather than reporting a run that produced nothing', async () => {
    stubFetch(
      [{ body: { running: true } }, { body: { running: false } }],
      [{ status: 500, body: { message: 'the store is unreachable' } }]
    );

    const lost: string[] = [];
    await follow(() => lost.length > 0, {
      onStatus: () => undefined,
      onFinished: () => undefined,
      onLost: (message) => lost.push(message),
    });

    expect(lost[0]).toBe('the store is unreachable');
  });

  it('stops asking once it is told to, so a page that has gone does not keep polling', async () => {
    const calls = stubFetch([{ body: { running: true } }]);

    const following = followRun({ onStatus: () => undefined, onFinished: () => undefined }, FAST);
    while (calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    following.stop();

    const atStop = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));

    // One in-flight request may still land after the stop; what must not happen is the loop
    // continuing to schedule itself, which over a long-lived tab is an unbounded leak.
    expect(calls.length).toBeLessThanOrEqual(atStop + 1);
  });

  /*
   * Asking out of turn must not leave a second chain of asking behind it.
   *
   * The rate is the thing under test, not the count: a follower that keeps one chain answers a fixed
   * number of times per interval however often it is interrupted, and one that starts a chain per
   * interruption doubles per occurrence and never recovers. The bug this covers cleared a timer that
   * had already fired, which is a no-op, and then started a second loop.
   */
  it('keeps one chain of asking however often it is asked out of turn', async () => {
    const calls = stubFetch([{ body: { running: true } }]);

    const following = followRun({ onStatus: () => undefined, onFinished: () => undefined }, { whileRunningMs: 20 });
    try {
      // Twenty interruptions, several of which land while a request is in flight.
      for (let interruption = 0; interruption < 20; interruption += 1) {
        following.now();
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const afterInterrupting = calls.length;
      await new Promise((resolve) => setTimeout(resolve, 120));

      // Six intervals of headroom over the five that fit, and far under the hundreds a doubling
      // chain reaches from twenty interruptions.
      expect(calls.length - afterInterrupting).toBeLessThanOrEqual(6);
    } finally {
      following.stop();
    }
  });

  /*
   * A tab nobody is looking at asks nothing, and starts again by itself when somebody is.
   *
   * The first version of this listened for the visibility event and returned early — which stopped
   * the event from asking, and did nothing about the timer that was already set. So a tab left open
   * overnight polled all night: exactly the case the check was written for. Hence a test that hides
   * the tab without touching the follower, and lets the timers run.
   */
  it('asks nothing while nobody is looking at the tab', async () => {
    const calls = stubFetch([{ body: { running: true } }]);
    let hidden = false;
    vi.stubGlobal('document', {
      get hidden() {
        return hidden;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });

    const following = followRun({ onStatus: () => undefined, onFinished: () => undefined }, FAST);
    try {
      while (calls.length < 1) await new Promise((resolve) => setTimeout(resolve, 1));

      hidden = true;
      // Long enough for many intervals at a one-millisecond cadence.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const whenHidden = calls.length;
      await new Promise((resolve) => setTimeout(resolve, 30));

      // At most the one request that was already in flight when the tab went away.
      expect(calls.length).toBeLessThanOrEqual(whenHidden + 1);

      hidden = false;
      await new Promise((resolve) => setTimeout(resolve, 20));

      // And it recovers on its own timer, without the event that a coalescing browser may not send.
      expect(calls.length).toBeGreaterThan(whenHidden + 1);
    } finally {
      following.stop();
    }
  });

  it('asks immediately when told the answer has changed', async () => {
    const calls = stubFetch([{ body: { running: true } }]);

    const following = followRun({ onStatus: () => undefined, onFinished: () => undefined }, { whileRunningMs: 10_000 });
    try {
      while (calls.length < 1) await new Promise((resolve) => setTimeout(resolve, 1));
      const beforeAsking = calls.length;

      following.now();
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Ten seconds is the next scheduled ask, so anything here came from being told.
      expect(calls.length).toBeGreaterThan(beforeAsking);
    } finally {
      following.stop();
    }
  });
});

describe('definitionRequest', () => {
  const draft: DefinitionDraft = {
    measurement: { scope: { kind: 'account' }, lookbackDays: 30 },
    attribution: { name: 'Q3 platform review', owners: ['alice@example.com'] },
    targets: [{ pillar: 'cost-optimization', atLeast: 80, by: '2027-03-31' }],
  };

  /*
   * The bug this exists for, and it was found on a live workspace rather than here.
   *
   * A create used to name the two fields it sends. Targets left the wizard, showed on the
   * confirmation, and were absent from the version that got written — the author made a commitment
   * the app agreed to and then did not record, with nothing refused and nothing logged. Naming what a
   * create omits fails the safe way round: a field added to a definition is sent by default.
   */
  it('sends everything a definition carries when creating one', () => {
    const { path, body } = definitionRequest(undefined, draft);
    expect(path).toBe('/api/definitions');
    expect(body).toEqual({ measurement: draft.measurement, attribution: draft.attribution, targets: draft.targets });
  });

  /*
   * The two that only mean something on a revision. There is no version this was made from and no
   * change to describe, and the create route refuses neither — so sending them would put a note about
   * a change on the first version of an assessment.
   */
  it('drops the two fields that are only about revising, rather than trusting the route to refuse them', () => {
    const { body } = definitionRequest(undefined, { ...draft, fromVersion: 3, note: 'raised the cost target' });
    expect(body).not.toHaveProperty('fromVersion');
    expect(body).not.toHaveProperty('note');
    expect(body).toHaveProperty('targets');
  });

  it('sends the whole draft to the version route when revising, note and all', () => {
    const revision = { ...draft, fromVersion: 3, note: 'raised the cost target' };
    const { path, body } = definitionRequest('d1', revision);
    expect(path).toBe('/api/definitions/d1/versions');
    expect(body).toEqual(revision);
  });

  it('escapes an id that would otherwise change the path', () => {
    expect(definitionRequest('a/b', draft).path).toBe('/api/definitions/a%2Fb/versions');
  });
});
