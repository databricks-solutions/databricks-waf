import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Trend, Value } from './ScoreStrip';
import { evidenceGapPath } from './score-path';
import type { SeriesPoint } from './trend';

const permitted = (value: number): SeriesPoint => ({ value, basis: { read: true, verdict: { ok: true } } });
const caveated = (value: number, caveat: string): SeriesPoint => ({
  value,
  basis: { read: true, verdict: { ok: true, caveat } },
});
const refused = (value: number, reason: string): SeriesPoint => ({
  value,
  basis: { read: true, verdict: { ok: false, reason } },
});
const unread = (value: number, why: string): SeriesPoint => ({ value, basis: { read: false, why } });

describe('score strip evidence boundary', () => {
  it('mutes a score whose range says too little was measured, while keeping the warning visible', () => {
    const markup = renderToStaticMarkup(<Value score={98} range={{ low: 6, high: 100 }} />);

    expect(markup).toContain('wa-metric-value text-wa-text-muted');
    expect(markup).toContain('text-wa-warning">Too little measured');
    expect(markup).not.toContain('wa-metric-value text-wa-success');
  });

  it('keeps an evidenced score in its posture colour', () => {
    const markup = renderToStaticMarkup(<Value score={93} range={{ low: 49, high: 96 }} />);

    expect(markup).toContain('wa-metric-value text-wa-success');
    expect(markup).not.toContain('wa-metric-value text-wa-text-muted');
  });

  it('opens the exact unmeasured list, scoped to a pillar when one was selected', () => {
    expect(evidenceGapPath()).toBe('/investigate?outcome=unmeasurable');
    expect(evidenceGapPath('security-compliance-and-privacy')).toBe(
      '/investigate?outcome=unmeasurable&pillar=security-compliance-and-privacy'
    );
  });
});

describe('score strip trend', () => {
  it('draws a refused run as a break with its reason instead of connecting across it', () => {
    const markup = renderToStaticMarkup(
      <Trend
        score={74}
        series={{
          points: [permitted(68), refused(71, 'The selected workspace set changed.'), permitted(74)],
          values: [68, 74],
          delta: 6,
        }}
      />
    );

    expect(markup).toContain('data-comparability="refused"');
    expect(markup).toContain('The selected workspace set changed.');
    expect(markup.match(/<polyline/g)).toBeNull();
  });

  it('marks and explains a permitted caveat', () => {
    const markup = renderToStaticMarkup(
      <Trend
        score={74}
        series={{
          points: [permitted(68), caveated(71, 'The app build changed.'), permitted(74)],
          values: [68, 71, 74],
          delta: 6,
        }}
      />
    );

    expect(markup).toContain('data-comparability="caveat"');
    expect(markup).toContain('The app build changed.');
    expect(markup).toContain('<polyline');
  });

  it('names a refusal when there are too few points for a sparkline', () => {
    const markup = renderToStaticMarkup(
      <Trend
        score={74}
        series={{ points: [refused(71, 'The lookback window changed.'), permitted(74)], values: [74] }}
      />
    );

    expect(markup).toContain('1 run refused');
    expect(markup).toContain('The lookback window changed.');
  });

  it('does not call a run it could not read a refusal', () => {
    const markup = renderToStaticMarkup(
      <Trend score={74} series={{ points: [unread(71, 'This run does not record the basis.'), permitted(74)], values: [74] }} />
    );

    expect(markup).toContain('1 run not compared');
    expect(markup).toContain('This run does not record the basis.');
    expect(markup).not.toContain('refused');
  });

  it('marks a run it could not read apart from one it refused', () => {
    const markup = renderToStaticMarkup(
      <Trend
        score={74}
        series={{
          points: [unread(68, 'No basis on record.'), refused(71, 'The window changed.'), permitted(74)],
          values: [74],
        }}
      />
    );

    expect(markup).toContain('data-comparability="not-read"');
    expect(markup).toContain('data-comparability="refused"');
  });

  /*
   * The floor this component's docstring sets, held against what is drawn rather than against the
   * series: two comparable points either side of nothing are still a two-point slope.
   */
  it('does not connect two comparable points into a line', () => {
    const markup = renderToStaticMarkup(
      <Trend
        score={74}
        series={{ points: [refused(60, 'The window changed.'), permitted(68), permitted(74)], values: [68, 74], delta: 6 }}
      />
    );

    expect(markup.match(/<polyline/g)).toBeNull();
  });

  it('reads out no movement where no two points can be compared, rather than level', () => {
    const markup = renderToStaticMarkup(
      <Trend
        score={73}
        series={{
          points: [refused(40, 'The window changed.'), refused(60, 'The window changed.'), refused(73, 'The window changed.')],
          values: [],
        }}
      />
    );

    expect(markup).toContain('none can be compared with this one, so no movement can be read');
    expect(markup).not.toContain('level');
    // The empty value list went with it: a list introduced and then not given is a sentence with a
    // hole in it, and this label is the whole chart for the reader who gets it.
    expect(markup).not.toContain('oldest to newest');
  });

  it('does not read one comparable point as level either', () => {
    const markup = renderToStaticMarkup(
      <Trend
        score={73}
        series={{
          points: [refused(40, 'The window changed.'), refused(60, 'The window changed.'), permitted(73)],
          values: [73],
        }}
      />
    );

    expect(markup).toContain('one can be compared with this one, so no movement can be read');
    expect(markup).not.toContain('level');
  });

  it('keeps every mark inside the box it draws in', () => {
    const markup = renderToStaticMarkup(
      <Trend
        score={74}
        series={{
          points: [refused(60, 'The window changed.'), permitted(68), refused(74, 'The window changed.')],
          values: [68],
        }}
      />
    );

    const xs = [...markup.matchAll(/x[12]?="(-?[\d.]+)"/g)].map((match) => Number(match[1]));
    expect(xs.length).toBeGreaterThan(0);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(96);
  });
});
