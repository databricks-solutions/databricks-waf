import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { duration, easing, prefersReducedMotion, REVEAL_RISE_PX, usePrefersReducedMotion } from './motion';

/** A node process has no `window`; a browser that asks for reduced motion answers `matches: true`. */
function stubReducedMotion(reduced: boolean): void {
  vi.stubGlobal('window', {
    matchMedia: (query: string) => ({
      matches: reduced,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('motion tokens', () => {
  it('keeps durations quiet and ordered', () => {
    expect(duration.fast).toBe(140);
    expect(duration.fast).toBeLessThan(duration.base);
    expect(duration.base).toBeLessThan(duration.slow);
    // Nothing reaches the half-second that reads as a show rather than a response.
    expect(duration.slow).toBeLessThanOrEqual(400);
  });

  it('uses real easing curves rather than a bare ease keyword', () => {
    for (const curve of Object.values(easing)) expect(curve).toContain('cubic-bezier');
  });

  it('exposes a positive reveal rise', () => {
    expect(REVEAL_RISE_PX).toBeGreaterThan(0);
  });
});

describe('prefersReducedMotion', () => {
  it('is false off a browser, so the default is motion on', () => {
    expect(prefersReducedMotion()).toBe(false);
  });

  it('is false when the reader has not asked for reduced motion', () => {
    stubReducedMotion(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it('is true when the reader asks for reduced motion', () => {
    stubReducedMotion(true);
    expect(prefersReducedMotion()).toBe(true);
  });
});

describe('usePrefersReducedMotion', () => {
  function Probe() {
    return createElement('i', null, String(usePrefersReducedMotion()));
  }

  it('settles synchronously on the first render, so a server render already knows', () => {
    stubReducedMotion(true);
    expect(renderToStaticMarkup(createElement(Probe))).toContain('true');
  });

  it('defaults to motion on', () => {
    expect(renderToStaticMarkup(createElement(Probe))).toContain('false');
  });
});
