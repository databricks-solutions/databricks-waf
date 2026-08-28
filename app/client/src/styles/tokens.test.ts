import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The dark theme is declared twice and the two copies must agree.
 *
 * `.dark` covers an explicit choice and `@media (prefers-color-scheme: dark)` covers a reader who
 * follows their system, and there is no way to write one set of values that serves both — a class
 * cannot be a media query. So the file states them twice, the media block wins the cascade by
 * position, and a token corrected in the class block alone changes nothing for most readers.
 *
 * That is not hypothetical. Two contrast failures found by scripts/check-a11y.mjs were fixed in
 * `.dark`, the sweep was re-run, and both were still there: 4.39:1 and 4.44:1 against a 4.5:1
 * requirement, because the media block still held the old values. This test is what that cost.
 */

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'wa-theme.css'), 'utf8');

/**
 * The declarations inside one block, by name.
 *
 * Brace-counted rather than matched with a regex, because the media block contains a rule and a
 * regex that stops at the first `}` reads half of it.
 */
function declarations(css: string, opener: string): Map<string, string> {
  const start = css.indexOf(opener);
  expect(start, `${opener} is not in wa-theme.css`).toBeGreaterThan(-1);

  let depth = 0;
  let end = start;
  for (let at = start; at < css.length; at += 1) {
    if (css[at] === '{') depth += 1;
    if (css[at] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = at;
        break;
      }
    }
  }

  const body = css.slice(start, end);
  const found = new Map<string, string>();
  for (const [, name, value] of body.matchAll(/(--wa-[\w-]+)\s*:\s*([^;]+);/g)) {
    found.set(name, value.trim());
  }
  return found;
}

describe('the dark theme, declared twice', () => {
  const explicit = declarations(css, 'html.dark,');
  const system = declarations(css, '@media (prefers-color-scheme: dark) {');

  it('declares the same tokens in both places', () => {
    expect([...system.keys()].sort()).toEqual([...explicit.keys()].sort());
  });

  it('gives every token the same value in both places', () => {
    const disagreements = [...explicit.entries()]
      .filter(([name, value]) => system.has(name) && system.get(name) !== value)
      .map(([name, value]) => `${name}: ${value} in html.dark, ${String(system.get(name))} under the media query`);

    expect(disagreements).toEqual([]);
  });

  it('is not empty, so a rename cannot make this test pass by finding nothing', () => {
    expect(explicit.size).toBeGreaterThan(40);
  });
});

/**
 * Contrast, computed rather than eyeballed.
 *
 * The browser sweep in scripts/check-a11y.mjs measures what is actually rendered and is the check
 * that matters, but it needs a running app and a scan. These are the pairs that a token edit can
 * break without any page changing, so they are pinned here where a unit test run will catch them.
 */
describe('the contrast a token edit could break', () => {
  const pairs = [
    // A chip and a badge draw their own colour as text over a wash of that colour.
    { ink: '--wa-success', wash: '--wa-success-soft', on: '#ffffff', need: 4.5 },
    { ink: '--wa-warning', wash: '--wa-warning-soft', on: '#ffffff', need: 4.5 },
    { ink: '--wa-danger', wash: '--wa-danger-soft', on: '#ffffff', need: 4.5 },
  ] as const;

  /*
   * The washes are opaque, and that is the property being tested.
   *
   * They were translucent in the dark theme, which made a badge's contrast a function of whatever it
   * happened to sit on. On a selected row — a blue tint at 16% over the panel — "Not met" measured
   * 3.91:1 against a 4.5:1 requirement while the same badge on the panel beside it measured 4.79:1.
   * A pair of values cannot be pinned when one of them depends on the row's state, so each wash now
   * states the colour it used to composite to over a panel and the plane stops mattering.
   */
  it('gives the dark theme opaque washes, so a badge reads the same on any plane', () => {
    const dark = declarations(css, 'html.dark,');
    const translucent = ['--wa-success-soft', '--wa-warning-soft', '--wa-danger-soft'].filter(
      (name) => colour(dark.get(name) ?? '#ffffff').a !== 1
    );

    expect(translucent).toEqual([]);
  });

  const print = declarations(css, '@media print {');

  for (const theme of ['html.dark,', ':root,'] as const) {
    const tokens = declarations(css, theme);
    const plane = theme === 'html.dark,' ? tokens.get('--wa-surface') : '#ffffff';

    /*
     * The em dash a pillar with no score shows in place of a number is text, and 28px/700 is large
     * text, so it owes 3:1 rather than 4.5:1.
     *
     * Pinned here rather than left to the browser sweep because the sweep only sees it when a run
     * left a pillar unmeasured. Every sweep before this one ran against a full scan, so a token at
     * 1.91:1 sat in the palette through a whole accessibility phase. A unit test does not need a
     * scan to be thin.
     */
    it(`the unmeasured dash reads in ${theme === 'html.dark,' ? 'the dark theme' : 'the light theme'}`, () => {
      const ink = tokens.get('--wa-unmeasured');
      expect(ink, '--wa-unmeasured is undeclared').toBeDefined();

      const measured = contrast(colour(ink ?? ''), colour(plane ?? '#ffffff'));
      expect(measured, `--wa-unmeasured on --wa-surface is ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    });

    for (const pair of pairs) {
      it(`${pair.ink} reads on ${pair.wash} in ${theme === 'html.dark,' ? 'the dark theme' : 'the light theme'}`, () => {
        const ink = tokens.get(pair.ink);
        const wash = tokens.get(pair.wash);
        expect(ink, `${pair.ink} is undeclared`).toBeDefined();
        expect(wash, `${pair.wash} is undeclared`).toBeDefined();

        const measured = contrast(colour(ink ?? ''), composite(colour(wash ?? ''), colour(plane ?? '#ffffff')));
        expect(measured, `${pair.ink} on ${pair.wash} is ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(pair.need);
      });
    }

    it(`text on the action fill reads in ${theme === 'html.dark,' ? 'the dark theme' : 'the light theme'}`, () => {
      const ink = tokens.get('--wa-on-action');
      const fill = tokens.get('--wa-action');
      const measured = contrast(colour(ink ?? ''), colour(fill ?? ''));
      expect(measured, `--wa-on-action on --wa-action is ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    });

    /*
     * And again on paper, which is a third palette rather than a variant of either.
     *
     * `@media print` is a partial override: it restates the fills and leaves everything it does not
     * mention to whichever theme the reader had open. So each of its values has to be read against
     * both, and the pair above is where that went wrong — the print block darkened --wa-action for a
     * monochrome printer and left --wa-on-action to the theme, which in the dark one is #0b141d and
     * measured 2.29:1 on the new fill. A reader printing a report from dark mode got a primary button
     * whose label was very nearly its background, and neither the loop above nor the browser sweep
     * could see it: the first reads the two screen blocks, and the second does not print.
     */
    it(`text on the action fill reads on paper over ${theme === 'html.dark,' ? 'the dark theme' : 'the light theme'}`, () => {
      const ink = print.get('--wa-on-action') ?? tokens.get('--wa-on-action');
      const fill = print.get('--wa-action') ?? tokens.get('--wa-action');
      const measured = contrast(colour(ink ?? ''), colour(fill ?? ''));
      expect(measured, `--wa-on-action on --wa-action prints at ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('the customer hierarchy between adjacent surfaces', () => {
  const light = declarations(css, ':root,');
  const dark = declarations(css, 'html.dark,');

  const ratio = (tokens: Map<string, string>, first: string, second: string): number =>
    contrast(colour(tokens.get(first) ?? ''), colour(tokens.get(second) ?? ''));

  it('keeps the light canvas visibly separate from the primary task surface', () => {
    const measured = ratio(light, '--wa-canvas', '--wa-surface');
    expect(measured, `light canvas/task separation is ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(1.08);
  });

  it('keeps inset evidence distinct from the light task surface', () => {
    const measured = ratio(light, '--wa-surface', '--wa-surface-inset');
    expect(measured, `light task/inset separation is ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(1.12);
  });

  for (const [first, second, label] of [
    ['--wa-canvas', '--wa-surface', 'canvas/task'],
    ['--wa-surface', '--wa-surface-subtle', 'task/section'],
    ['--wa-surface-subtle', '--wa-surface-raised', 'section/elevated'],
  ] as const) {
    it(`keeps the dark ${label} step perceptible`, () => {
      const measured = ratio(dark, first, second);
      expect(measured, `dark ${label} separation is ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(1.12);
    });
  }
});

interface Colour {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** `#rrggbb` or `rgba(r, g, b, a)`, which are the two forms this file uses. */
function colour(value: string): Colour {
  if (value.startsWith('#')) {
    const number = Number.parseInt(value.slice(1), 16);
    return { r: (number >> 16) & 255, g: (number >> 8) & 255, b: number & 255, a: 1 };
  }

  const parts = /rgba?\(([^)]+)\)/.exec(value);
  if (parts == null) throw new Error(`Not a colour this test can read: ${value}`);
  const numbers = parts[1]
    .split(/[,/\s]+/)
    .filter((part) => part !== '')
    .map(Number);
  return { r: numbers[0], g: numbers[1], b: numbers[2], a: numbers[3] ?? 1 };
}

function composite(top: Colour, bottom: Colour): Colour {
  return {
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  };
}

function contrast(one: Colour, two: Colour): number {
  const first = luminance(one);
  const second = luminance(two);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function luminance({ r, g, b }: Colour): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
