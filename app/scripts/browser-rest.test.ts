/**
 * When a browser sweep is allowed to believe a page.
 *
 * `restVerdict` is the half of `quiesce` a test can hold: the readings are the hard thing to arrange in
 * a browser and the easy thing to write down here. Every case below is a page this repository has
 * actually measured, and the first one is why the function exists — a stable layout with a query still
 * in flight, which the old rule called settled and `92` was then built against.
 */
import { describe, expect, it } from 'vitest';

import { applyNetworkEvent, restVerdict } from './browser.mjs';

type Reading = {
  readonly at: number;
  readonly shape: string;
  readonly working: number;
  readonly sinceAnswer: number;
};

/** Readings 150ms apart, as `quiesce` takes them, with everything quiet unless said otherwise. */
function readings(count: number, each: Partial<Reading> = {}, from = 0): Reading[] {
  return Array.from({ length: count }, (_, index) => ({
    at: from + index * 150,
    shape: '671/671/47/0',
    working: 0,
    sinceAnswer: 4000,
    ...each,
  }));
}

describe('restVerdict', () => {
  it('waits while the shape is still moving', () => {
    const moving = [
      ...readings(1, { shape: 'a' }),
      ...readings(1, { shape: 'b' }, 150),
      ...readings(1, { shape: 'c' }, 300),
    ];
    expect(restVerdict(moving)).toBeNull();
  });

  it('settles once the shape has agreed three times over and nothing is outstanding', () => {
    expect(restVerdict(readings(3))).toEqual({ settled: true, waited: 300, reason: 'at rest' });
  });

  it('keeps waiting on a still page with a request in flight', () => {
    // The overview at 1280x800: the rail holds its shape for a second while `useRunChanges` is in
    // flight, and when it answers the change summary grows 84px and takes the panel beside it down to
    // 50px. 17 of the app's 27 static routes move after the old rule let go, and all 17 looked like this.
    expect(restVerdict(readings(8, { working: 1 }))).toBeNull();
  });

  it('keeps waiting for a beat after the last answer, because a response is followed by a render', () => {
    expect(restVerdict(readings(6, { sinceAnswer: 40 }))).toBeNull();
    expect(restVerdict(readings(6, { sinceAnswer: 200 }))?.settled).toBe(true);
  });

  it('settles a page that has never made a request at all', () => {
    // `sinceAnswer` is infinite before the first response, and a static page must not wait for one.
    expect(restVerdict(readings(3, { sinceAnswer: Number.POSITIVE_INFINITY }))?.settled).toBe(true);
  });

  it('settles a page that is announcing something, because announcing is not working', () => {
    // There is nothing in a reading for `role="status"`, and this is the case that took it out. The role
    // marks a live region rather than work in progress, and this app carries it on an empty state filtered
    // to nothing, on a partial-scan warning and on a save confirmation — all steady. With it in the rule
    // `/serverless`, `/definitions` and `/months` never settled: 25s each, both themes, page finished.
    expect(restVerdict(readings(3))?.settled).toBe(true);
  });

  it('gives up at the ceiling and says which of the two conditions failed', () => {
    const outstanding = restVerdict(readings(200, { working: 4 }));
    expect(outstanding?.settled).toBe(false);
    expect(outstanding?.reason).toBe('4 requests still outstanding');
    // Past the ceiling rather than at it, because the sample that breaches it is the one that reports.
    expect(outstanding?.waited).toBeGreaterThan(25_000);

    const churning = readings(200).map((one, index) => ({ ...one, shape: `shape-${String(index)}` }));
    expect(restVerdict(churning)?.reason).toBe('the layout is still changing');
  });

  it('counts one outstanding request in the singular', () => {
    expect(restVerdict(readings(200, { working: 1 }))?.reason).toBe('1 request still outstanding');
  });

  it('lets /report finish, which is the slowest page here and not a hung one', () => {
    // 183 requests, two per control, 15.4s to drain on the dev server — `98`. A ceiling that cut it off
    // would report the report page as never at rest on every run, which is a check nobody can act on.
    const draining = [...readings(100, { working: 40 }), ...readings(4, {}, 15_000)];
    expect(restVerdict(draining)).toEqual({ settled: true, waited: 15_300, reason: 'at rest' });
  });

  it('starts counting agreement again after a response, however still the page looked before it', () => {
    // A page can hold its shape all the way through a request and change the moment the answer lands —
    // the fitted lists measure themselves two frames after a render, so stillness observed while a
    // response was outstanding says nothing about the page that response produces. Measured: with
    // agreement allowed to span the last answer, check:viewport reported 17 layout failures, then 16,
    // then 6, then none, over the same routes on the same data.
    const late = [...readings(4, { working: 1 }), ...readings(1, {}, 600)];
    expect(restVerdict(late)).toBeNull();

    const settled = [...readings(4, { working: 1 }), ...readings(3, {}, 600)];
    expect(settled.at(-1)?.at).toBe(900);
    expect(restVerdict(settled)).toEqual({ settled: true, waited: 900, reason: 'at rest' });
  });
});

describe('the network boundary between measured pages', () => {
  const request = (requestId: string, frameId: string, type = 'Fetch', url = 'http://localhost/api/example') => ({
    method: 'Network.requestWillBeSent',
    params: { requestId, frameId, type, request: { url } },
  });

  it('drops unfinished work from the previous document when the main frame navigates', () => {
    const state = { outstanding: new Map<string, number>([['old-topology', 1]]), lastAnswered: 800 };

    applyNetworkEvent(state, request('new-document', 'main', 'Document'), { mainFrameId: 'main', now: 900 });

    expect([...state.outstanding.keys()]).toEqual(['new-document']);
    expect(state.lastAnswered).toBe(0);
  });

  it('does not discard main-page work when an iframe loads a document', () => {
    const state = { outstanding: new Map<string, number>([['main-fetch', 1]]), lastAnswered: 0 };

    applyNetworkEvent(state, request('frame-document', 'child', 'Document'), { mainFrameId: 'main', now: 900 });

    expect([...state.outstanding.keys()]).toEqual(['main-fetch', 'frame-document']);
  });

  it('releases both completed and cancelled requests and records when they answered', () => {
    for (const method of ['Network.loadingFinished', 'Network.loadingFailed']) {
      const state = { outstanding: new Map<string, number>([['request', 1]]), lastAnswered: 0 };
      applyNetworkEvent(state, { method, params: { requestId: 'request' } }, { now: 1200 });
      expect(state.outstanding.size).toBe(0);
      expect(state.lastAnswered).toBe(1200);
    }
  });

  it('replaces an unfinished duplicate request with the mounted hook request', () => {
    const state = { outstanding: new Map<string, { url: string }>(), lastAnswered: 0 };
    applyNetworkEvent(state, request('strict-effect', 'main'), { mainFrameId: 'main', now: 900 });
    applyNetworkEvent(state, request('mounted-effect', 'main'), { mainFrameId: 'main', now: 901 });

    expect([...state.outstanding.keys()]).toEqual(['mounted-effect']);
  });
});
