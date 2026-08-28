import { describe, expect, it } from 'vitest';
import { CHROME_MIN_WIDTH_PX, chromeColumnVisible, navigationSheetOpen, navigationSheetRequested } from './chrome-width';

describe('whether the chrome column is on screen', () => {
  it('is gone in the 768–899px band that had no pointer navigation', () => {
    expect(chromeColumnVisible(767)).toBe(false);
    expect(chromeColumnVisible(768)).toBe(false);
    expect(chromeColumnVisible(899)).toBe(false);
  });

  it('is present at the width the rail is shown, and not one pixel below', () => {
    expect(chromeColumnVisible(CHROME_MIN_WIDTH_PX - 1)).toBe(false);
    expect(chromeColumnVisible(CHROME_MIN_WIDTH_PX)).toBe(true);
    expect(chromeColumnVisible(1280)).toBe(true);
  });
});

describe('the header sheet', () => {
  it('is open only while requested and the rail is gone', () => {
    expect(navigationSheetOpen(true, false)).toBe(true);
    expect(navigationSheetOpen(false, false)).toBe(false);
    expect(navigationSheetOpen(true, true)).toBe(false);
  });

  it('drops a leftover open-request when the rail comes back', () => {
    expect(navigationSheetRequested(true, true)).toBe(false);
    expect(navigationSheetRequested(true, false)).toBe(true);
    expect(navigationSheetRequested(false, true)).toBe(false);
  });
});
