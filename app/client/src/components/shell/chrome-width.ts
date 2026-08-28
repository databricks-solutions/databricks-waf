// The viewport width at which the chrome column is shown.
//
// Below this, the rail is `display: none` and the header sheet is the only route to the other
// pages. One number, because the CSS query, the menu trigger and the sheet's gate holding two
// different ones is what left 768–899px with no navigation a pointer can reach — 32l, GAP-022.
//
// The stylesheet uses `max-width: ${CHROME_MIN_WIDTH_PX - 1}px`. `check-design-system` holds
// those three sites to this constant.

import { useEffect, useState } from 'react';

export const CHROME_MIN_WIDTH_PX = 900;

export const CHROME_COLUMN_QUERY = `(min-width: ${String(CHROME_MIN_WIDTH_PX)}px)`;

export function chromeColumnVisible(widthPx: number): boolean {
  return widthPx >= CHROME_MIN_WIDTH_PX;
}

/**
 * Whether the header sheet is open.
 *
 * Gated on the chrome column rather than kept in step with an effect: closing in an effect when
 * the viewport crosses 900px would render the open sheet once before closing it. Crossing that
 * width makes this false on the same render the rail appears.
 */
export function navigationSheetOpen(requested: boolean, chromeVisible: boolean): boolean {
  return requested && !chromeVisible;
}

/**
 * Drop a leftover open-request when the rail comes back.
 *
 * `onOpenChange` does not fire when `open` becomes false because the gate closed it, so without
 * this the request stays true, shrinking reopens the sheet, and focus restoration targets a
 * trigger that is `display: none`.
 */
export function navigationSheetRequested(requested: boolean, chromeVisible: boolean): boolean {
  return chromeVisible ? false : requested;
}

/** Whether the rail is on screen at this viewport. False means the header sheet is the nav. */
export function useChromeColumnVisible(): boolean {
  const [visible, setVisible] = useState(readChromeColumnVisible);
  useEffect(() => {
    const media = window.matchMedia(CHROME_COLUMN_QUERY);
    const sync = (): void => setVisible(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  return visible;
}

function readChromeColumnVisible(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(CHROME_COLUMN_QUERY).matches;
}
