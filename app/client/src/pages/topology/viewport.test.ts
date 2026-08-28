import { describe, expect, it } from 'vitest';
import { READABLE_GRAPH_ZOOM, readableSelectionZoom } from './viewport';

describe('topology viewport', () => {
  it('opens and selects nodes at full readable scale', () => {
    expect(READABLE_GRAPH_ZOOM).toBe(1);
    expect(readableSelectionZoom(0.2)).toBe(1);
    expect(readableSelectionZoom(0.72)).toBe(1);
  });

  it('does not zoom out when a reader already enlarged the canvas', () => {
    expect(readableSelectionZoom(1.4)).toBe(1.4);
  });
});
