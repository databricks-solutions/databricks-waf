// The band that says a run is happening.
//
// The defect it was written for is a defect of absence, so most of these tests assert that
// something is said at all — in the states where the app previously said nothing: a run this reader
// did not start, a run whose status has not come back yet, and a run that has issued no calls so far.
//
// The other half is what must never appear. No percentage, and no invented total: how many calls a
// run makes is not known until it ends, and a bar that sticks at 90% would teach the reader that
// this app's numbers are decorative. See ADR 0055.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunInFlightView } from './RunInFlight';
import type { Scan, ScanStatus } from '../api/types';

const STARTED_AT = '2026-04-10T12:00:00.000Z';
const NOW = new Date('2026-04-10T12:02:14.000Z').getTime();

const RUNNING: ScanStatus = {
  running: true,
  startedAt: STARTED_AT,
  actor: 'ana@example.com',
  callsMade: 1240,
};

/** Only the fields the band reads. The rest of a scan is not this component's business. */
const PREVIOUS = {
  startedAt: '2026-04-09T02:00:00.000Z',
  finishedAt: '2026-04-09T02:03:30.000Z',
} as Scan;

const render = (props: Partial<Parameters<typeof RunInFlightView>[0]> = {}) =>
  renderToStaticMarkup(<RunInFlightView now={NOW} run={RUNNING} {...props} />);

describe('RunInFlightView', () => {
  it('names who is running it, so a run the reader did not start is not a mystery', () => {
    expect(render()).toContain('ana@example.com is measuring your estate');
  });

  it('distinguishes the scheduled run from a colleague pressing the button', () => {
    const markup = render({ run: { ...RUNNING, trigger: 'scheduled' } });

    // The first question is whether this is something the reader did or something happening to
    // them. An unexpected run against the warehouse mid-morning is a different fact from the
    // nightly one, and both were previously invisible.
    expect(markup).toContain('A scheduled run is measuring your estate');
    expect(markup).not.toContain('ana@example.com');
  });

  it('acknowledges the click before the first poll has answered it', () => {
    const markup = renderToStaticMarkup(<RunInFlightView now={NOW} />);

    // Three seconds of silence after pressing a button is how the reader concludes the button did
    // nothing, so the band renders on the click and fills in the detail when the server answers.
    expect(markup).toContain('Starting a run');
  });

  it('shows a clock, because a number that moves is the difference between working and hung', () => {
    expect(render()).toContain('Running for 2m 14s');
  });

  it('counts the calls it has made', () => {
    expect(render()).toContain('1,240 queries and API calls so far');
  });

  it('says what a run with no calls yet is doing rather than showing it as stuck', () => {
    const markup = render({ run: { ...RUNNING, callsMade: 0 } });

    // A zero beside a spinner reads as a run that has stalled. It has not: it is resolving
    // credentials and planning, which is worth one sentence.
    expect(markup).toContain('Planning the queries it will run');
    expect(markup).not.toContain('0 queries');
  });

  it('offers the previous run as the only honest estimate of how long this will take', () => {
    expect(render({ previous: PREVIOUS })).toContain('The previous run took 3m 30s');
  });

  it('divides its clauses the way the line above it does', () => {
    // Three captions with nothing but whitespace between them read as one sentence that does not
    // parse, which is how it looked on the deployed app.
    expect(render({ previous: PREVIOUS })).toContain(
      'Running for 2m 14s · 1,240 queries and API calls so far · The previous run took 3m 30s'
    );
  });

  it('leaves no stranded separator when there is no previous run to name', () => {
    const markup = render();

    expect(markup).toContain('Running for 2m 14s · 1,240 queries and API calls so far</span>');
  });

  it('says nothing about the previous run on the first run this workspace has had', () => {
    expect(render()).not.toContain('The previous run took');
  });

  it('shows no percentage and no total, since neither is known while the run is going', () => {
    const markup = render({ previous: PREVIOUS });

    expect(markup).not.toContain('%');
    // The count is a count. `of` would be the start of a denominator this app cannot honestly fill.
    expect(markup).not.toMatch(/1,240 (queries and API calls )?of/);
  });

  it('announces the run once, without the clock, so it is not read out every second', () => {
    const markup = render();

    const live = /<div aria-live="polite" class="sr-only">(.*?)<\/div>/.exec(markup);
    expect(live?.[1]).toBe('A run is measuring your estate.');
    expect(live?.[1]).not.toContain('2m 14s');
  });

  it('reads as just started when the browser clock is behind the server that stamped it', () => {
    const markup = render({ now: new Date('2026-04-10T11:59:00.000Z').getTime() });

    // The start is stamped on the server and the elapsed is measured in the browser, so the two are
    // not the same clock. A negative wait would be the app's most visible lie about time.
    expect(markup).toContain('Running for 0ms');
    expect(markup).not.toMatch(/Running for -/);
  });
});
